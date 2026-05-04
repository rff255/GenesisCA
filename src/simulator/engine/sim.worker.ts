/**
 * Web Worker for GenesisCA simulation.
 * Uses Structure of Arrays (SoA) for grid state — one typed array per attribute.
 * Pre-computes neighbor index tables for zero-cost boundary handling.
 */

import { instantiateWasmModule } from '../../modeler/vpl/compiler/wasm/compile';
import { computeMemoryLayout, type MemoryLayout } from '../../modeler/vpl/compiler/wasm/layout';
import type { WebGPULayout } from '../../modeler/vpl/compiler/webgpu/layout';
import type { WebGPUEntryPoints } from '../../modeler/vpl/compiler/webgpu/compile';
import {
  createWebGPURuntime, destroyWebGPURuntime, isWebGPUAvailable, shaderHashOf,
  setupBuffersAndPipelines, uploadAttrs, uploadNeighborIndices,
  uploadModelAttrs, uploadActiveViewer, uploadIndicators, uploadIndicatorsAt, dispatchStep,
  dispatchOutputMapping, presentToCanvas, readbackAttrs, readbackColors,
  readbackBatched, unpackAttrsFromReadback, unpackAttrFromReadback, resetStopFlag, seedRngState,
  setupReductionPipelines, dispatchReductions,
  type WebGPURuntime, type ReadbackRegion,
} from './webgpuRuntime';
import { decodeReductions, gpuHandledIds, gpuHandledAttrIds } from './webgpuReduce';

interface AttrDef {
  id: string;
  type: string;
  isModelAttribute: boolean;
  defaultValue: string;
  /** Cell attributes only: value held by out-of-grid cells when boundary
   *  is "constant". When undefined/empty, boundary sentinel uses defaultValue. */
  boundaryValue?: string;
  tagOptions?: string[];
}

interface NeighborhoodDef {
  id: string;
  coords: Array<[number, number]>;
}

interface InitMsg {
  type: 'init';
  width: number;
  height: number;
  attributes: AttrDef[];
  neighborhoods: NeighborhoodDef[];
  boundaryTreatment: string;
  updateMode: string;
  asyncScheme: string;
  stepCode: string;
  inputColorCodes: Array<{ mappingId: string; code: string }>;
  outputMappingCodes: Array<{ mappingId: string; code: string }>;
  /** Per-stop-event-node message, indexed by (_stopIdx - 1). */
  stopMessages?: string[];
  activeViewer: string;
  indicators?: IndicatorDef[];
  /** Wave 2: optional pre-compiled WASM step bytes (compiled on main thread). */
  wasmStepBytes?: Uint8Array;
  wasmStepError?: string;
  /** Names of every exported function in the WASM module — `step`,
   *  `inputColor_<sanitisedMappingId>`, `outputMapping_<sanitisedMappingId>`. */
  wasmExports?: string[];
  /** Compile-time viewer id -> int mapping (matches the WASM module's setColorViewer constants). */
  viewerIds?: Record<string, number>;
  /** Default useWasm flag (from model properties); user can flip via setUseWasm later. */
  useWasm?: boolean;
  /** Wave 3: WGSL shader source (single module containing step + outputMapping_*). */
  webgpuShaderCode?: string;
  webgpuShaderError?: string;
  /** Sanitised entry-point names so the worker can pick the right pipelines. */
  webgpuEntryPoints?: WebGPUEntryPoints;
  /** Buffer layout (offsets/sizes for attrs / nbrs / colors / etc). */
  webgpuLayout?: WebGPULayout;
  /** Default useWebGPU flag (from model properties); flipped via setUseWebGPU later. */
  useWebGPU?: boolean;
  /** B4B — WebGPU-only: how often (in generations) to read the GPU stop-flag
   *  back to CPU during a step batch. Default 1 (every step). Higher values
   *  amortise the per-step mapAsync stall but a stop event may surface up to
   *  K-1 generations late. */
  webgpuStopCheckInterval?: number;
  /** P7 — optional OffscreenCanvas (transferred from the main thread). When
   *  present and WebGPU is enabled, the worker writes WebGPU output directly
   *  into the canvas via a present compute pipeline, eliminating the
   *  per-frame colors readback + sendColors round-trip. */
  webgpuCanvas?: OffscreenCanvas;
  webgpuCanvasWidth?: number;
  webgpuCanvasHeight?: number;
}

interface StepMsg { type: 'step'; count: number; activeViewer: string; skipColorPass?: boolean }
interface PaintMsg {
  type: 'paint';
  cells: Array<{ row: number; col: number; r: number; g: number; b: number }>;
  mappingId: string;
  activeViewer: string;
}
interface RandomizeMsg { type: 'randomize'; activeViewer: string }
interface ResetMsg { type: 'reset'; activeViewer: string }
interface RecompileMsg { type: 'recompile'; stepCode: string; inputColorCodes: Array<{ mappingId: string; code: string }>; outputMappingCodes: Array<{ mappingId: string; code: string }>; stopMessages?: string[]; updateMode: string; asyncScheme: string; wasmStepBytes?: Uint8Array; wasmStepError?: string; wasmExports?: string[]; viewerIds?: Record<string, number>; webgpuShaderCode?: string; webgpuShaderError?: string; webgpuEntryPoints?: WebGPUEntryPoints; webgpuLayout?: WebGPULayout; webgpuStopCheckInterval?: number }
interface UpdateModelAttrsMsg { type: 'updateModelAttrs'; attrs: Record<string, number> }
interface ImportImageMsg { type: 'importImage'; pixels: Uint8ClampedArray; mappingId: string; activeViewer: string }

interface IndicatorDef {
  id: string;
  kind: string;
  dataType: string;
  defaultValue: string;
  accumulationMode: string;
  tagOptions?: string[];
  linkedAttributeId?: string;
  linkedAggregation?: string;
  binCount?: number;
  watched: boolean;
}

interface UpdateIndicatorsMsg { type: 'updateIndicators'; indicators: IndicatorDef[]; attributes: AttrDef[] }
interface GetStateMsg { type: 'getState' }
interface LoadStateMsg {
  type: 'loadState';
  width: number;
  height: number;
  attributes: Record<string, { type: string; buffer: ArrayBuffer }>;
  modelAttrs: Record<string, number>;
  colors: ArrayBuffer;
  orderArray?: ArrayBuffer;
  activeViewer: string;
}

// --- Region clipboard messages (for Ctrl+C/V/X on the simulator) ---
interface ReadRegionMsg {
  type: 'readRegion';
  row: number; col: number; w: number; h: number;
}
interface WriteRegionMsg {
  type: 'writeRegion';
  row: number; col: number; w: number; h: number;
  attributes: Record<string, { type: string; buffer: ArrayBuffer }>;
  activeViewer: string;
}
interface ClearRegionMsg {
  type: 'clearRegion';
  row: number; col: number; w: number; h: number;
  activeViewer: string;
}
interface SetUseWasmMsg {
  type: 'setUseWasm';
  enabled: boolean;
}
interface SetUseWebGPUMsg {
  type: 'setUseWebGPU';
  enabled: boolean;
}
/** Dev-mode parity helper: trigger a GPU → CPU readback of attrsRead so the
 *  main thread can compare to a JS-target run. Exposed via the existing
 *  `window.__simWorker` console hook. The worker posts back a `webgpuReadback`
 *  message with the current cell-attribute typed arrays. */
interface ReadbackWebGPUMsg { type: 'readbackWebGPU' }
interface ColorPassMsg { type: 'colorPass'; activeViewer: string }

type WorkerMsg = InitMsg | StepMsg | PaintMsg | RandomizeMsg | ResetMsg | RecompileMsg | UpdateModelAttrsMsg | ImportImageMsg | UpdateIndicatorsMsg | GetStateMsg | LoadStateMsg | ReadRegionMsg | WriteRegionMsg | ClearRegionMsg | SetUseWasmMsg | SetUseWebGPUMsg | ReadbackWebGPUMsg | ColorPassMsg;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let width = 0;
let height = 0;
let total = 0;
let cellAttrs: AttrDef[] = [];
let modelAttrsList: AttrDef[] = [];
let indicatorsList: IndicatorDef[] = [];
let neighborhoods: NeighborhoodDef[] = [];
let boundaryTreatment = 'torus';
let updateMode = 'synchronous';
let asyncScheme = 'random-order';
let generation = 0;

// SoA: one typed array per attribute, double-buffered (A = read, B = write)
let attrsA: Record<string, ArrayLike<number> & { [i: number]: number; length: number }> = {};
let attrsB: Record<string, ArrayLike<number> & { [i: number]: number; length: number }> = {};
let readAttrs = attrsA;
let writeAttrs = attrsB;

// Pre-computed neighbor indices: nbrIndices[nbrId][cellIdx * nbrSize + n] = neighbor flat index
let nbrIndices: Record<string, Int32Array> = {};

let colors: Uint8ClampedArray = new Uint8ClampedArray(0);
let orderArray: Int32Array | null = null;

// WASM linear memory backs cell attributes and the color buffer so the future
// WASM step function can address them directly. JS still uses typed-array views
// over the same memory for paint, save/load, the legacy JS step, etc. — the
// views and the WASM module see the exact same bytes.
//
// Memory layout (computed by computeMemoryLayout):
//   [attr0_read][attr1_read]...[attr0_write][attr1_write]...[colors][padding to page]
// Async mode collapses read/write into a single shared region per attribute.
//
// Reinit on grid resize creates a fresh Memory; reinit on recompile reuses it.
let wasmMemory: WebAssembly.Memory | null = null;
let wasmLayout: MemoryLayout | null = null;
/** Compile-time mapping of viewer-mapping id -> integer (built on main thread,
 *  passed in init/recompile). Worker writes the matching int into wasmMemory at
 *  layout.activeViewerOffset whenever the active viewer changes. */
let viewerIdMap: Record<string, number> = {};

/** Sync activeViewer (string) to wasmMemory as an i32 so the WASM step's
 *  setColorViewer comparisons work. Called whenever activeViewer changes. */
function syncActiveViewerToMemory(): void {
  if (!wasmMemory || !wasmLayout) return;
  const view = new Int32Array(wasmMemory.buffer, wasmLayout.activeViewerOffset, 1);
  view[0] = viewerIdMap[activeViewer] ?? -1;
}

/** Sync model-attr values (Record<string, unknown>) to wasmMemory as f64s so
 *  WASM emitters that read getModelAttribute see the current values. */
function syncModelAttrsToMemory(): void {
  if (!wasmMemory || !wasmLayout) return;
  const buf = wasmMemory.buffer;
  for (const [key, off] of Object.entries(wasmLayout.modelAttrOffset)) {
    const v = cachedModelAttrs[key];
    const num = typeof v === 'number' ? v : Number(v) || 0;
    new Float64Array(buf, off, 1)[0] = num;
  }
}
// xorshift32 state shared across all compiled functions. Persists across steps so
// the random stream advances as the user expects. Seeded once with a non-zero value.
const rngState = new Uint32Array(1);
rngState[0] = (Date.now() * 0x9e3779b9) >>> 0 || 0x12345678;
let stepFn: Function | null = null;
let inputColorFns: Array<{ mappingId: string; fn: Function }> = [];
let outputMappingFns: Array<{ mappingId: string; fn: Function }> = [];

// WASM step (Wave 2) — when useWasm is true, runStep() calls this instead of
// the JS stepFn. Default false; flipped via the 'setUseWasm' message. The WASM
// module is rebuilt on every init/recompile because it imports the linear
// memory and assumes the current attribute layout.
let wasmStepFn: ((total: number) => void) | null = null;
// Per-mapping WASM exports. Keys are SANITISED mapping ids (matching the
// `inputColor_<id>` / `outputMapping_<id>` export names the compiler emits).
let wasmInputColorFns: Record<string, (idx: number, r: number, g: number, b: number) => void> = {};
let wasmOutputMappingFns: Record<string, (total: number) => void> = {};
let useWasm = false;

// Wave 3: WebGPU runtime. `useWebGPU` is the user's intent; `webgpuRuntime` is
// the actual handle (null until async init succeeds, or null after a failure).
// `runStep()` only routes to the WebGPU path when both useWebGPU is true AND
// `webgpuRuntime.stepReady` is true — step 1 leaves stepReady false so the
// step still runs on JS/WASM even when the user has WebGPU selected. This
// validates the entire control plane without needing buffer/pipeline machinery.
let useWebGPU = false;
let webgpuRuntime: WebGPURuntime | null = null;
// Monotonic counter — bumped at the start of every startWebGPUInit. The
// async init's `.then` captures the value at submit time and bails if it no
// longer matches (a newer init landed, OR the worker is being torn down).
// Without this, an old in-flight init can race the new one and clobber
// `webgpuRuntime` with a now-orphaned runtime — racy and hard to repro.
let webgpuInitSeq = 0;

function startWebGPUInit(
  shaderCode: string | undefined,
  entryPoints: WebGPUEntryPoints | undefined,
  layout: WebGPULayout | undefined,
  shaderError: string | undefined,
  canvas?: OffscreenCanvas,
): void {
  // Bump the sequence FIRST so any in-flight init's `.then` callback sees a
  // mismatch and bails instead of writing to webgpuRuntime.
  const mySeq = ++webgpuInitSeq;
  if (shaderError) {
    destroyWebGPURuntime(webgpuRuntime);
    webgpuRuntime = null;
    self.postMessage({ type: 'error', message: '[webgpu] compile failed: ' + shaderError });
    return;
  }
  if (!shaderCode || !entryPoints || !layout) {
    destroyWebGPURuntime(webgpuRuntime);
    webgpuRuntime = null;
    return;
  }
  // Pipeline cache: when the new shader is byte-identical to the running one,
  // the layout is identical too (the layout values are baked into the shader
  // source). We can keep the device + buffers + pipelines and skip the
  // expensive async device + shaderModule + pipeline rebuild — saves hundreds
  // of ms on graph-only edits where the user isn't actually changing the rule.
  if (shaderCode && webgpuRuntime?.stepReady && shaderHashOf(shaderCode) === webgpuRuntime.shaderHash) {
    self.postMessage({ type: 'useWebGPUStatus', enabled: useWebGPU, ready: true });
    return;
  }
  // P7 — salvage any direct-render canvas attached to the previous runtime.
  // The OffscreenCanvas is tied to the worker's lifetime (not to a specific
  // device); reusing it after recompile keeps direct render alive instead of
  // falling back to readback-based rendering on every graph edit.
  const salvagedCanvas = canvas ?? webgpuRuntime?.canvas ?? undefined;
  // Tear down any previous runtime — rebuilt against the new shader/layout.
  destroyWebGPURuntime(webgpuRuntime);
  webgpuRuntime = null;
  if (!isWebGPUAvailable()) {
    self.postMessage({ type: 'error', message: '[webgpu] navigator.gpu unavailable in this worker context' });
    return;
  }
  // The promise is intentionally not awaited here — init runs in the background
  // and runStep() falls through to JS/WASM until `webgpuRuntime.stepReady` is
  // true. Step 7 (Save/Load State) introduces the await path.
  void createWebGPURuntime({ shaderCode, entryPoints, layout, canvas: salvagedCanvas })
    .then(async rt => {
      // A newer init started while we were awaiting — the orphaned `rt`
      // belongs to a stale sequence. Destroy it and bail without touching
      // webgpuRuntime, which now holds (or is about to hold) the newer one.
      if (mySeq !== webgpuInitSeq) {
        destroyWebGPURuntime(rt);
        return;
      }
      webgpuRuntime = rt;
      // Build buffers + pipeline, upload initial CPU state, seed per-cell RNG.
      await setupBuffersAndPipelines(rt);
      // Re-check after the second await — same race window.
      if (mySeq !== webgpuInitSeq) {
        destroyWebGPURuntime(rt);
        if (webgpuRuntime === rt) webgpuRuntime = null;
        return;
      }
      uploadAttrs(rt, readAttrs);
      uploadNeighborIndices(rt, nbrIndices);
      uploadModelAttrs(rt, cachedModelAttrs as Record<string, number>);
      uploadActiveViewer(rt, viewerIdMap[activeViewer] ?? -1);
      seedRngState(rt, rngState[0] ?? 0x12345678);
      // O5 — set up GPU-side reduction pipelines for any GPU-eligible
      // watched linked indicators. Skipped indicators (float total, integer
      // /float frequency) keep using the existing CPU readback fallback.
      setupReductionPipelines(rt, linkedDefs);
      // Initial indicator values
      const vals: Record<string, number> = {};
      for (const { idx, id } of standaloneIds) vals[id] = cachedIndicators[idx]!;
      uploadIndicators(rt, vals, isIntEncodedIndicator);
      // Run the active viewer's outputMapping so the colors buffer matches the
      // initial state from the very first frame.
      dispatchOutputMapping(rt, activeViewer);
      if (rt.directRender) {
        // P7 — present the initial frame to the OffscreenCanvas. Skip the
        // colors readback (it's not needed for display) and post a colors-
        // less stepped message so main thread renders srcCanvas.
        presentToCanvas(rt);
        if (mySeq !== webgpuInitSeq) return;
        self.postMessage({ type: 'stepped', generation });
      } else {
        // Pull initial colors back to CPU so the simulator's first paint shows
        // the model's actual visualization (not all-black).
        try { await readbackColors(rt, colors); } catch { /* non-fatal */ }
        if (mySeq !== webgpuInitSeq) return;
        self.postMessage({ type: 'stepped', generation, colors: new Uint8ClampedArray(colors) });
      }
      // eslint-disable-next-line no-console
      console.log(`[webgpu] runtime ready: device + shader + buffers + step pipeline (${rt.entryPoints.outputMappings.length} viewer pipeline(s) lazily built)`);
      self.postMessage({ type: 'useWebGPUStatus', enabled: useWebGPU, ready: rt.stepReady });
    })
    .catch((e: unknown) => {
      // Same staleness check on the failure path — don't clobber the newer
      // runtime's state with a stale error message.
      if (mySeq !== webgpuInitSeq) return;
      webgpuRuntime = null;
      const msg = (e instanceof Error) ? e.message : String(e);
      self.postMessage({ type: 'error', message: '[webgpu] init failed: ' + msg });
      self.postMessage({ type: 'useWebGPUStatus', enabled: useWebGPU, ready: false });
    });
}

/** Mirror of the compiler's sanitiseExportName: drop everything except
 *  [A-Za-z0-9_] so the export name is a valid JS identifier and we can match
 *  it back to the mapping id at lookup time. */
function sanitiseExportName(s: string): string {
  return s.replace(/[^A-Za-z0-9_]/g, '_');
}

// Cached model attributes
let cachedModelAttrs: Record<string, unknown> = {};

// Indicators — typed-array-backed so the per-cell hot path uses _indicators[idx]
// (typed-array index access) instead of _indicators["abc"] (object hash lookup).
// The index space is parallel to model.indicators array order; compiler pre-resolves
// each indicator node's _indicatorIdx via the same mapping.
let cachedIndicators: Float64Array = new Float64Array(0);
let standaloneDefaults: Float64Array = new Float64Array(0);
let standalonePerGenIdx: number[] = [];
// (idx, id) pairs for the standalone indicators only — used to build the outgoing
// id-keyed payload that the UI consumes. Linked indicators come via linkedResults.
let standaloneIds: Array<{ idx: number; id: string }> = [];
let linkedDefs: Array<{
  id: string;
  accumulationMode: string;
  /** Enough info to compute the aggregation directly from the grid buffer.
   *  Used by the WASM-path fallback (computeLinkedIndicatorsFromBuffer) since
   *  the WASM step doesn't emit the post-loop aggregation the JS step does. */
  attrId?: string;
  attrType?: string;
  aggregation?: string;
  binCount?: number;
  tagOptions?: string[];
  watched?: boolean;
}> = [];
let linkedAccumulators: Record<string, number | Record<string, number>> = {};
let linkedResults: Record<string, number | Record<string, number>> = {};

// Stop-event flag — compiled step writes a 1-based index into stopFlag[0] when
// a Stop Event node's flow fires. Worker reads after each step/color/input pass
// and surfaces the matching message from stopMessages. A Uint32Array view over
// the layout.stopFlagOffset so JS and WASM share the same memory cell.
let stopFlag: Uint32Array = new Uint32Array(1);
let stopMessages: string[] = [];
// B4B — WebGPU stop-check interval. Default 1 (every step). >1 trades stop-event
// timing precision for fewer per-step mapAsync stalls. The last step of any
// batch is ALWAYS checked so the user sees the eventual stop within the batch.
let webgpuStopCheckInterval = 1;

// ---------------------------------------------------------------------------
// Typed array creation by attribute type
// ---------------------------------------------------------------------------

function createTypedArray(type: string, size: number): Float64Array | Int32Array | Uint8Array {
  switch (type) {
    case 'bool': return new Uint8Array(size);
    case 'integer': return new Int32Array(size);
    case 'float': return new Float64Array(size);
    case 'tag': return new Int32Array(size);
    default: return new Float64Array(size);
  }
}

/** Construct a typed-array view (matching the attribute's type) over a given
 *  WebAssembly memory buffer at the given byte offset. */
function viewOver(type: string, buf: ArrayBuffer, byteOffset: number, length: number): Float64Array | Int32Array | Uint8Array {
  switch (type) {
    case 'bool': return new Uint8Array(buf, byteOffset, length);
    case 'integer': return new Int32Array(buf, byteOffset, length);
    case 'tag': return new Int32Array(buf, byteOffset, length);
    case 'float': return new Float64Array(buf, byteOffset, length);
    default: return new Float64Array(buf, byteOffset, length);
  }
}

function defaultValue(attr: AttrDef): number {
  switch (attr.type) {
    case 'bool': return attr.defaultValue === 'true' ? 1 : 0;
    case 'integer': return parseInt(attr.defaultValue, 10) || 0;
    case 'float': return parseFloat(attr.defaultValue) || 0;
    case 'tag': return parseInt(attr.defaultValue, 10) || 0;
    default: return 0;
  }
}

/** Parsed value held by out-of-grid cells under constant boundary. Falls back
 *  to defaultValue when boundaryValue is unset or an empty string. */
function boundaryCellValue(attr: AttrDef): number {
  const bv = attr.boundaryValue;
  if (bv === undefined || bv === '') return defaultValue(attr);
  switch (attr.type) {
    case 'bool': return bv === 'true' ? 1 : 0;
    case 'integer': return parseInt(bv, 10) || 0;
    case 'float': return parseFloat(bv) || 0;
    case 'tag': return parseInt(bv, 10) || 0;
    default: return 0;
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function initGrid(): void {
  total = width * height;
  attrsA = {};
  attrsB = {};
  const isAsync = updateMode === 'asynchronous';

  // Allocate WASM linear memory and create typed-array views over EVERY region
  // the WASM step might address: cell attrs, color buffer, neighbor index
  // tables, model attrs, indicators, RNG state, active viewer ID, and async
  // order array. JS-side variables (attrsA/B, nbrIndices, orderArray, etc.)
  // become typed-array views over wasmMemory at the layout offsets — single
  // source of truth shared between JS step and WASM step.
  wasmLayout = computeMemoryLayout(
    cellAttrs, modelAttrsList, neighborhoods, indicatorsList,
    total, isAsync, boundaryTreatment,
  );
  wasmMemory = new WebAssembly.Memory({ initial: wasmLayout.pages });
  const buf = wasmMemory.buffer;

  // Constant boundary needs a sentinel cell at index `total` that neighbour
  // lookups for out-of-bounds positions point to. We always view total+1 cells
  // for constant boundary so the sentinel slot lives in wasmMemory (shared
  // with the WASM step), and total cells for torus.
  const viewLen = boundaryTreatment === 'torus' ? total : (total + 1);
  for (const attr of cellAttrs) {
    const dv = defaultValue(attr);
    const arrA = viewOver(attr.type, buf, wasmLayout.attrReadOffset[attr.id]!, viewLen);
    if (dv !== 0) arrA.fill(dv);
    attrsA[attr.id] = arrA;

    if (isAsync) {
      // Async: single buffer — both read and write point to the same view (same offset)
      attrsB[attr.id] = arrA;
    } else {
      const arrB = viewOver(attr.type, buf, wasmLayout.attrWriteOffset[attr.id]!, viewLen);
      if (dv !== 0) arrB.fill(dv);
      attrsB[attr.id] = arrB;
    }
  }

  readAttrs = attrsA;
  writeAttrs = isAsync ? attrsA : attrsB;
  colors = new Uint8ClampedArray(buf, wasmLayout.colorsOffset, wasmLayout.colorsBytes);
  generation = 0;

  // RNG state lives in memory at layout.rngStateOffset (Uint32Array of length 1).
  // Sync the existing seed into memory so WASM and JS share the same starting state.
  const rngView = new Uint32Array(buf, wasmLayout.rngStateOffset, 1);
  rngView[0] = rngState[0]!;

  // Stop-event flag view — shared between JS step (writes via `_stopFlag[0]=idx`)
  // and WASM step (i32.store at stopFlagOffset). Reset to 0 on init.
  stopFlag = new Uint32Array(buf, wasmLayout.stopFlagOffset, 1);
  stopFlag[0] = 0;

  // Order array — view over memory in BOTH modes (offset is reserved either way).
  // Async mode populates it (sequential then maybe shuffled); sync mode leaves it 0.
  if (isAsync) {
    orderArray = new Int32Array(buf, wasmLayout.orderOffset, total);
    for (let i = 0; i < total; i++) orderArray[i] = i;
    // For cyclic scheme, shuffle once at init and reuse
    if (asyncScheme === 'cyclic') {
      for (let i = total - 1; i > 0; i--) {
        const j = (Math.random() * (i + 1)) | 0;
        const tmp = orderArray[i]!; orderArray[i] = orderArray[j]!; orderArray[j] = tmp;
      }
    }
  } else {
    orderArray = null;
  }
}

function buildNeighborIndices(): void {
  nbrIndices = {};
  if (!wasmMemory || !wasmLayout) return;
  const buf = wasmMemory.buffer;
  for (const nbr of neighborhoods) {
    const nbrSize = nbr.coords.length;
    // Index table is a view over wasmMemory at the layout offset — shared with WASM step.
    const indices = new Int32Array(buf, wasmLayout.nbrIndexOffset[nbr.id]!, total * nbrSize);

    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const cellIdx = row * width + col;
        for (let n = 0; n < nbrSize; n++) {
          const [dr, dc] = nbr.coords[n]!;
          let nRow = row + dr;
          let nCol = col + dc;

          if (nRow < 0 || nRow >= height || nCol < 0 || nCol >= width) {
            if (boundaryTreatment === 'torus') {
              nRow = ((nRow % height) + height) % height;
              nCol = ((nCol % width) + width) % width;
            } else {
              // Constant: point to cell 0 (will be filled with defaults)
              // We use a sentinel approach: index -1 means "use default"
              // But typed arrays can't store -1, so we use total as sentinel
              indices[cellIdx * nbrSize + n] = total; // sentinel
              continue;
            }
          }

          indices[cellIdx * nbrSize + n] = nRow * width + nCol;
        }
      }
    }

    nbrIndices[nbr.id] = indices;
  }

  // Constant boundary: write the boundary cell value (falls back to default
  // when unset) into the sentinel cell at index `total`. The +1 slot was
  // already allocated as part of wasmMemory in initGrid (see viewLen), so we
  // just need to set it; we don't replace the array (which would orphan the
  // WASM module's view).
  if (boundaryTreatment !== 'torus') {
    for (const attr of cellAttrs) {
      const bv = boundaryCellValue(attr);
      attrsA[attr.id]![total] = bv;
      if (attrsB[attr.id] !== attrsA[attr.id]) attrsB[attr.id]![total] = bv;
    }
  }
}


// ---------------------------------------------------------------------------
// Step
// ---------------------------------------------------------------------------

let activeViewer = '';

/** Build args for the loop-wrapped step function (called once per step, not per cell) */
function buildLoopArgs(): unknown[] {
  const args: unknown[] = [total];
  for (const attr of cellAttrs) args.push(readAttrs[attr.id]);
  for (const attr of cellAttrs) args.push(writeAttrs[attr.id]);
  for (const nbr of neighborhoods) {
    args.push(nbrIndices[nbr.id]);
    args.push(nbr.coords.length);
  }
  args.push(cachedModelAttrs, colors, activeViewer, cachedIndicators, linkedResults, rngState, stopFlag);
  if (updateMode === 'asynchronous' && orderArray) args.push(orderArray);
  return args;
}

/** Build args for a per-cell function (InputColor) */
function buildCellArgs(idx: number): unknown[] {
  const args: unknown[] = [idx];
  for (const attr of cellAttrs) args.push(readAttrs[attr.id]);
  for (const attr of cellAttrs) args.push(writeAttrs[attr.id]);
  for (const nbr of neighborhoods) {
    args.push(nbrIndices[nbr.id]);
    args.push(nbr.coords.length);
  }
  args.push(cachedModelAttrs, colors, activeViewer, cachedIndicators, linkedResults, rngState, stopFlag);
  return args;
}

/** Instantiate WASM bytes (compiled on main thread) against the current memory.
 *  Splits the resulting exports into wasmStepFn / wasmInputColorFns / wasmOutputMappingFns. */
function tryInstantiateWasmModule(bytes: Uint8Array | undefined, exportNames: string[] | undefined): void {
  wasmStepFn = null;
  wasmInputColorFns = {};
  wasmOutputMappingFns = {};
  if (!bytes || bytes.length === 0 || !wasmMemory) return;
  const names = exportNames ?? [];
  instantiateWasmModule({ bytes, minMemoryPages: 1, viewerIds: {}, exports: names }, wasmMemory).then(
    inst => {
      const stepExp = inst.exports['step'];
      if (typeof stepExp === 'function') wasmStepFn = stepExp as (t: number) => void;
      for (const [name, fn] of Object.entries(inst.exports)) {
        if (name === 'step') continue;
        if (name.startsWith('inputColor_')) {
          const sanitised = name.slice('inputColor_'.length);
          wasmInputColorFns[sanitised] = fn as (idx: number, r: number, g: number, b: number) => void;
        } else if (name.startsWith('outputMapping_')) {
          const sanitised = name.slice('outputMapping_'.length);
          wasmOutputMappingFns[sanitised] = fn as (t: number) => void;
        }
      }
    },
    err => {
      wasmStepFn = null;
      wasmInputColorFns = {};
      wasmOutputMappingFns = {};
      self.postMessage({ type: 'error', message: '[wasm] instantiate failed: ' + (err?.message || err) });
    },
  );
}

/** True iff GPU buffers are the source of truth (attrs may be stale on CPU).
 *  Flipped on by runStepWebGPU; flipped off by any code path that uploads
 *  CPU → GPU (mutation handlers in step 6) or readback handlers that sync
 *  GPU → CPU (step 7 save state, step 14 linked indicators). */
let gpuOwnsAttrs = false;

function runStep(): void {
  // Wave 3: triple branch — WebGPU > WASM > JS. WebGPU only takes the
  // dispatch when the runtime has finished its async buffer + pipeline setup.
  if (useWebGPU && webgpuRuntime?.stepReady) {
    runStepWebGPU();
    return;
  }
  // If the previous step ran on GPU, attrs on CPU are stale. Pull them back
  // before falling through to a JS/WASM step so we don't run on prev-prev gen.
  // (In practice this only fires when the user toggles target mid-run, which
  // already triggers a full reinit — but the guard is cheap and defensive.)
  if (gpuOwnsAttrs && webgpuRuntime?.stepReady) {
    // Synchronous-style fallback: just clear the flag — actual readback happens
    // in step 7's getState path. The first JS/WASM step after a target switch
    // may operate on stale data; documented limitation.
    gpuOwnsAttrs = false;
  }
  const fn = (useWasm && wasmStepFn) ? wasmStepFn : stepFn!;
  const callWasm = useWasm && wasmStepFn !== null;
  const isSync = updateMode !== 'asynchronous';

  // Clear the stop-event flag before the step runs — otherwise a stop that
  // fired during an internal runStep call (reset/randomize/paint visualisation)
  // would persist and falsely pause the user's next Play.
  if (stopFlag) stopFlag[0] = 0;

  // Reset per-generation standalone indicators to defaults
  if (standalonePerGenIdx.length > 0) {
    for (const i of standalonePerGenIdx) cachedIndicators[i] = standaloneDefaults[i]!;
  }

  // Clear linked results (compiled step function will populate them)
  if (linkedDefs.length > 0) linkedResults = {};

  // Pre-step (WASM, sync mode): WASM uses baked-in attrReadOffset/attrWriteOffset
  // so it must always read from attrsA. JS-mode swap may have left readAttrs
  // pointing at attrsB — sync the latest data back into attrsA before running.
  if (callWasm && isSync && readAttrs !== attrsA) {
    for (const attr of cellAttrs) {
      (attrsA[attr.id] as Uint8Array).set(readAttrs[attr.id] as Uint8Array);
    }
    readAttrs = attrsA;
    writeAttrs = attrsB;
  }

  // Async mode: shuffle/populate order array before each step
  if (updateMode === 'asynchronous' && orderArray) {
    if (asyncScheme === 'random-order') {
      // Fisher-Yates shuffle — every cell updates exactly once in random order
      for (let i = total - 1; i > 0; i--) {
        const j = (Math.random() * (i + 1)) | 0;
        const tmp = orderArray[i]!; orderArray[i] = orderArray[j]!; orderArray[j] = tmp;
      }
    } else if (asyncScheme === 'random-independent') {
      // N=total random picks with replacement
      for (let i = 0; i < total; i++) {
        orderArray[i] = (Math.random() * total) | 0;
      }
    }
    // 'cyclic': orderArray stays as shuffled at init — no per-step work
  }

  // ONE call per step — the loop is inside the compiled function.
  // WASM step has a different signature (just `total`) since attrs/colors
  // live in the imported memory and offsets are baked into the module.
  if (callWasm) {
    (fn as (t: number) => void)(total);
    // WASM step doesn't emit the per-loop linked-indicator aggregation the
    // JS step does. Compute it directly from the shared buffer so frequency /
    // total linked indicators are populated and end conditions / charts work
    // in WASM mode too.
    if (linkedDefs.length > 0) computeLinkedIndicatorsFromBuffer();
  } else {
    fn(...buildLoopArgs());
  }

  // Handle linked indicator accumulation (skip when no linked indicators)
  for (let _li = 0; _li < linkedDefs.length; _li++) {
    const def = linkedDefs[_li]!;
    if (!(def.id in linkedResults)) continue;
    if (def.accumulationMode === 'accumulated') {
      const cur = linkedResults[def.id]!;
      if (typeof cur === 'number') {
        linkedAccumulators[def.id] = ((linkedAccumulators[def.id] as number) || 0) + cur;
        linkedResults[def.id] = linkedAccumulators[def.id] as number;
      } else {
        const prev = (linkedAccumulators[def.id] as Record<string, number>) || {};
        for (const [k, v] of Object.entries(cur)) {
          prev[k] = (prev[k] || 0) + v;
        }
        linkedAccumulators[def.id] = prev;
        linkedResults[def.id] = { ...prev };
      }
    }
  }

  // Post-step buffer management (sync mode only — async uses single buffer)
  if (isSync) {
    if (callWasm) {
      // WASM wrote new gen to attrWriteOffset (= attrsB). Bulk-copy w → r so
      // the next step (whichever mode) sees the new gen at readAttrs = attrsA.
      // We cannot use the JS ref-swap trick because WASM's offsets are baked.
      for (const attr of cellAttrs) {
        (attrsA[attr.id] as Uint8Array).set(attrsB[attr.id] as Uint8Array);
      }
      // Refs stay canonical (readAttrs = attrsA, writeAttrs = attrsB).
    } else {
      // JS step uses positional r/w args so ref swap suffices (no copy).
      const tmp = readAttrs;
      readAttrs = writeAttrs;
      writeAttrs = tmp;
    }
  }
  generation++;
}

/**
 * Wave 3 step path. The compiled WGSL step shader runs on the GPU; attrs stay
 * GPU-resident across many steps (the headline win — no per-step CPU readback).
 *
 * Per-step sequence:
 *   1. Reset standalone-per-generation indicator slots on CPU mirror.
 *   2. Reset stopFlag in control buffer.
 *   3. Reset standalone-per-generation indicator atomic words on GPU.
 *   4. Dispatch the step compute pipeline.
 *
 * runColorPassWebGPU() runs separately (called by the existing color-pass tail
 * in mutation handlers + the step message handler). It dispatches the active
 * viewer's outputMapping pipeline.
 *
 * `finalizeStepWebGPU()` is the async tail: reads back colors / indicators /
 * stopFlag and populates the CPU-side mirrors so sendColors / stop event /
 * indicator UI all see live GPU state.
 */
function runStepWebGPU(): void {
  if (!webgpuRuntime || !webgpuRuntime.stepReady) return;
  if (standalonePerGenIdx.length > 0) {
    for (const i of standalonePerGenIdx) cachedIndicators[i] = standaloneDefaults[i]!;
  }
  if (linkedDefs.length > 0) linkedResults = {};
  // GPU-side: clear stop flag + reset per-gen indicator slots so atomics start
  // from defaults each step. Skip the stopFlag reset when the model has no
  // stopEvent nodes (the flag never moves off zero) — saves a tiny queue
  // submission per step but more importantly avoids an unnecessary buffer
  // touch in the per-step hot path.
  if (stopMessages.length > 0) resetStopFlag(webgpuRuntime);
  if (standalonePerGenIdx.length > 0) {
    // Per-step partial upload: only the per-generation slots need to be
    // re-seeded with their defaults. Accumulated standalone slots and linked
    // slots (which run as atomics on GPU) must NOT be touched mid-run.
    const vals: Record<string, number> = {};
    for (const i of standalonePerGenIdx) {
      const id = webgpuRuntime.layout.indicatorIds[i];
      if (id !== undefined) vals[id] = standaloneDefaults[i]!;
    }
    uploadIndicatorsAt(webgpuRuntime, standalonePerGenIdx, vals, isIntEncodedIndicator);
  }
  dispatchStep(webgpuRuntime);
  gpuOwnsAttrs = true;
  generation++;
}

/** Dispatch the active viewer's outputMapping pipeline (writes to colors).
 *  Returns false when the active mapping has no compiled pipeline (no graph).
 *
 *  P7 direct render: when the canvas was transferred at init time, also
 *  dispatch the present pipeline so the OffscreenCanvas's frame mirrors the
 *  colors buffer. The canvas auto-presents to the visible DOM canvas on the
 *  main thread — no readback or postMessage needed for display. */
function runColorPassWebGPU(): boolean {
  if (!webgpuRuntime || !webgpuRuntime.stepReady) return false;
  const ok = dispatchOutputMapping(webgpuRuntime, activeViewer);
  // When direct render is active, present unconditionally — the colors
  // buffer holds the latest state written either by the just-dispatched
  // output mapping OR by an earlier step shader's SetColorViewer-in-step
  // (the MNCA "Case Colored" / "Decorated Trace" viewer pattern, which has
  // no dedicated output mapping graph).
  if (webgpuRuntime.directRender) presentToCanvas(webgpuRuntime);
  // O5 — refresh the watched-linked-indicator histograms on GPU. Cheap (a
  // handful of u32 atomics per cell) and the result rides the same
  // batched mapAsync as colors/indicators/stopFlag in the next finalize.
  if (webgpuRuntime.reductionPlan) dispatchReductions(webgpuRuntime);
  return ok;
}

/** Refresh the GPU colors buffer after a user interaction (paint, image
 *  import, writeRegion, clearRegion). When the active viewer has a dedicated
 *  Output Mapping pipeline, dispatch it. Otherwise, run one Step — models that
 *  emit colors via SetColorViewer-in-step (e.g. MNCA's "Case Colored") rely on
 *  the step to update colors. Generation advances by 1 in the fallback case,
 *  which is the documented behaviour for these models on user interaction. */
function refreshColorsAfterInputWebGPU(): void {
  if (!webgpuRuntime || !webgpuRuntime.stepReady) return;
  if (runColorPassWebGPU()) return;
  runStepWebGPU();
}

/** Patch the GPU `attrsRead` buffer for a set of cell indices, copying their
 *  current values from the CPU `readAttrs` mirror. Used by mutation handlers
 *  (paint, writeRegion, clearRegion) to update only the touched cells without
 *  clobbering the rest of the GPU state.
 *
 *  Two strategies, picked per attribute:
 *    - Batched: pack [minIdx..maxIdx] into one ArrayBuffer, single writeBuffer.
 *      Picked when the bounding range is at most 4× the touched-cell count
 *      (e.g. one rectangular brush stroke). Pays for some "in-between" cells
 *      but trades 4-byte queue submissions for one large one.
 *    - Per-cell: one writeBuffer per touched cell. Picked when the range is
 *      sparse (e.g. cells at opposite corners) so the batch would be wasteful.
 *
 *  We deliberately skip writing to `attrsWriteBuf` — the next step's per-cell
 *  copy preamble (`attrsWrite[idx] = attrsRead[idx]`) overwrites it before any
 *  read, so the second writeBuffer is dead bandwidth. */
function patchWebGPUCells(idxs: ArrayLike<number>): void {
  const rt = webgpuRuntime;
  if (!rt || !rt.attrsReadBuf || idxs.length === 0) return;
  // Sort + dedupe is not required for correctness (writeBuffer with the latest
  // value wins), but we need min/max for the bounding range. A single linear
  // pass gets us both without sorting allocations.
  let minIdx = idxs[0]!;
  let maxIdx = idxs[0]!;
  for (let i = 1; i < idxs.length; i++) {
    const v = idxs[i]!;
    if (v < minIdx) minIdx = v;
    if (v > maxIdx) maxIdx = v;
  }
  const rangeLen = maxIdx - minIdx + 1;
  const useBatch = rangeLen <= idxs.length * 4;
  for (const attr of cellAttrs) {
    const layoutAttr = rt.layout.attrs.find(a => a.id === attr.id);
    if (!layoutAttr) continue;
    const src = readAttrs[attr.id];
    if (!src) continue;
    if (useBatch) {
      const packed = new ArrayBuffer(rangeLen * 4);
      const view = new DataView(packed);
      for (let i = 0; i < rangeLen; i++) {
        const v = src[minIdx + i]!;
        const off = i * 4;
        if (attr.type === 'bool') view.setUint32(off, v ? 1 : 0, true);
        else if (attr.type === 'integer' || attr.type === 'tag') view.setInt32(off, v | 0, true);
        else if (attr.type === 'float') view.setFloat32(off, v, true);
        else view.setUint32(off, 0, true);
      }
      rt.device.queue.writeBuffer(rt.attrsReadBuf, layoutAttr.byteOffset + minIdx * 4, packed);
    } else {
      for (let k = 0; k < idxs.length; k++) {
        const idx = idxs[k]!;
        const v = src[idx]!;
        const buf = new ArrayBuffer(4);
        const view = new DataView(buf);
        if (attr.type === 'bool') view.setUint32(0, v ? 1 : 0, true);
        else if (attr.type === 'integer' || attr.type === 'tag') view.setInt32(0, v | 0, true);
        else if (attr.type === 'float') view.setFloat32(0, v, true);
        else view.setUint32(0, 0, true);
        rt.device.queue.writeBuffer(rt.attrsReadBuf, layoutAttr.byteOffset + idx * 4, buf);
      }
    }
  }
}

/** Compiler bitcasts standalone integer/tag/bool indicators as i32; everything
 *  else (standalone float, linked f32 placeholders) is bitcast as f32. The
 *  upload path must agree with `getIndicator`'s read encoding. */
function isIntEncodedIndicator(id: string): boolean {
  const ind = indicatorsList.find(i => i.id === id);
  if (!ind || ind.kind !== 'standalone') return false;
  return ind.dataType === 'integer' || ind.dataType === 'tag' || ind.dataType === 'bool';
}

/** Push CPU indicator values (from cachedIndicators) into the GPU atomics
 *  buffer. Called at init, after reset/randomize, and before each step (to
 *  re-seed per-generation indicators). */
function syncIndicatorsCpuToGpu(): void {
  if (!webgpuRuntime || !webgpuRuntime.stepReady) return;
  const vals: Record<string, number> = {};
  for (const { idx, id } of standaloneIds) vals[id] = cachedIndicators[idx]!;
  // Linked indicator atomic slots stay 0 — linked aggregation runs CPU-side
  // post-step from the readback attrs.
  uploadIndicators(webgpuRuntime, vals, isIntEncodedIndicator);
}

/** Pull GPU buffers back to the CPU mirrors that sendColors + stop-event +
 *  indicator UI all read. Called in the message handler after a WebGPU
 *  dispatch sequence has been queued.
 *
 *  - colors → `colors` (Uint8ClampedArray), used by sendColors().
 *  - indicators → `cachedIndicators`, decoded per-indicator type.
 *  - stopFlag → `stopFlag[0]` so the existing stop-event detection works.
 *  - linked indicators → CPU-side via readback of attrsRead, then run the
 *    existing `computeLinkedIndicatorsFromBuffer()`. Watched-only.
 *  - cell attrs → ONLY when a watched linked indicator needs them, OR when
 *    the caller explicitly asks (e.g. getState).
 */
async function finalizeStepWebGPU(opts: { needAttrs?: boolean; needColors?: boolean } = {}): Promise<void> {
  const rt = webgpuRuntime;
  if (!rt || !rt.stepReady) return;
  const fullAttrs = !!opts.needAttrs;
  // O5 — figure out which watched indicators are handled by the GPU
  // reduction plan; their attrs don't need a CPU readback. Empty plan →
  // gpuHandled is empty and the existing CPU path handles everything.
  const gpuPlan = rt.reductionPlan;
  const gpuIds = gpuPlan ? gpuHandledIds(gpuPlan) : new Set<string>();
  const gpuAttrIds = gpuPlan ? gpuHandledAttrIds(gpuPlan, linkedDefs) : new Set<string>();
  // Watched linked indicators need only the source attr's bytes, not the whole
  // attrs region. Build a deduped list of source attr ids — minus the ones
  // O5 covers on GPU.
  const watchedAttrIds = new Set<string>();
  if (!fullAttrs) {
    for (const d of linkedDefs) {
      if (!d.watched || !d.attrId) continue;
      if (gpuIds.has(d.id)) continue; // GPU-reduction handles this one
      if (gpuAttrIds.has(d.attrId)) continue; // attr already in GPU plan
      watchedAttrIds.add(d.attrId);
    }
  }
  // P7 — direct render owns the canvas; we never need to readback colors for
  // display. Save-state / GIF / screenshot paths still call readbackColors
  // explicitly via their own helpers.
  const wantColors = (opts.needColors !== false) && !rt.directRender; // default true
  const wantIndicators = rt.layout.indicatorIds.length > 0;
  const wantStopFlag = stopMessages.length > 0;

  // Pack all readbacks into ONE staging buffer + ONE mapAsync. Pre-batch this
  // saves N-1 GPU↔CPU round trips per finalize compared to the old
  // one-buffer-per-source pattern. Particularly impactful on the per-step
  // stop-event path (was 2 mapAsyncs per step, now 1).
  const regions: ReadbackRegion[] = [];
  let colorsRegion = -1, indicatorsRegion = -1, stopRegion = -1, attrsRegion = -1;
  let reductionsRegion = -1;
  // For selective attrs readback, store the (attrId, region slot) pairs so we
  // can decode each attr's slice back into readAttrs.
  const attrSlots: Array<{ attrId: string; slot: number }> = [];
  if (wantColors && rt.colorsBuf) {
    colorsRegion = regions.length;
    regions.push({ src: rt.colorsBuf, srcOffset: 0, size: rt.layout.colorsBytes });
  }
  if (wantIndicators && rt.indicatorsBuf) {
    indicatorsRegion = regions.length;
    regions.push({ src: rt.indicatorsBuf, srcOffset: 0, size: rt.layout.indicatorsBytes });
  }
  if (wantStopFlag && rt.controlBuf) {
    stopRegion = regions.length;
    regions.push({ src: rt.controlBuf, srcOffset: 0, size: 16 });
  }
  // O5 reductions buffer: tiny (a few u32 per watched-linked indicator).
  // Only included on full finalizes (i.e., not the per-step stop-check
  // intermediates that pass needColors: false) since dispatchReductions runs
  // alongside runColorPassWebGPU at the end of a step batch.
  if (gpuPlan && rt.reductionsBuf && gpuPlan.totalSlots > 0 && opts.needColors !== false) {
    reductionsRegion = regions.length;
    regions.push({ src: rt.reductionsBuf, srcOffset: 0, size: Math.max(16, gpuPlan.totalSlots * 4) });
  }
  if (fullAttrs && rt.attrsReadBuf) {
    // Save / explicit full readback path.
    attrsRegion = regions.length;
    regions.push({ src: rt.attrsReadBuf, srcOffset: 0, size: rt.layout.attrsBytes });
  } else if (watchedAttrIds.size > 0 && rt.attrsReadBuf) {
    // Selective: only watched linked indicators' source attrs. The other
    // attrs stay GPU-resident — gpuOwnsAttrs remains true.
    for (const attrId of watchedAttrIds) {
      const a = rt.layout.attrs.find(x => x.id === attrId);
      if (!a) continue;
      attrSlots.push({ attrId, slot: regions.length });
      regions.push({ src: rt.attrsReadBuf, srcOffset: a.byteOffset, size: a.count * 4 });
    }
  }
  if (regions.length === 0) return;

  const sliced = await readbackBatched(rt, regions);

  if (colorsRegion >= 0) {
    const c = sliced[colorsRegion]!;
    const limit = Math.min(colors.length, c.length);
    for (let i = 0; i < limit; i++) colors[i] = c[i]!;
  }
  if (indicatorsRegion >= 0) {
    const bytes = sliced[indicatorsRegion]!;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const f32buf = new ArrayBuffer(4);
    const f32view = new Float32Array(f32buf);
    const u32view = new Uint32Array(f32buf);
    for (const { idx, id } of standaloneIds) {
      const slot = rt.layout.indicatorIds.indexOf(id);
      if (slot < 0) continue;
      const raw = view.getUint32(slot * 4, true);
      if (isIntEncodedIndicator(id)) {
        cachedIndicators[idx] = raw | 0;
      } else {
        u32view[0] = raw;
        cachedIndicators[idx] = f32view[0]!;
      }
    }
  }
  if (stopRegion >= 0) {
    const bytes = sliced[stopRegion]!;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // controlBuf layout: [activeViewer (i32), stopFlag (atomic u32), pad, pad]
    stopFlag[0] = view.getUint32(rt.layout.controlOffsets.stopFlag, true) >>> 0;
  }
  if (attrsRegion >= 0) {
    unpackAttrsFromReadback(rt.layout, sliced[attrsRegion]!, readAttrs);
    gpuOwnsAttrs = false;
    if (linkedDefs.length > 0) computeLinkedIndicatorsFromBuffer();
  } else if (attrSlots.length > 0) {
    for (const { attrId, slot } of attrSlots) {
      unpackAttrFromReadback(rt.layout, attrId, sliced[slot]!, readAttrs);
    }
    // Only a subset of attrs were pulled — the rest remain GPU-only-fresh.
    // Subsequent paint with `gpuOwnsAttrs && icEntry?.fn` will trigger a full
    // readback (B5 fix), so leaving gpuOwnsAttrs=true is safe.
    computeLinkedIndicatorsFromBuffer();
  }
  // O5 — decode the reductions slice into linkedResults. Done AFTER the CPU
  // computeLinkedIndicatorsFromBuffer above so GPU-handled ids overwrite any
  // partial CPU result for the same id (defensive: gpuAttrIds excludes them
  // already, but cheap to be safe).
  if (reductionsRegion >= 0 && gpuPlan) {
    const bytes = sliced[reductionsRegion]!;
    const view = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    const decoded = decodeReductions(gpuPlan, view);
    for (const id of Object.keys(decoded)) {
      // Apply per-indicator accumulation mode. Per-generation (the default
      // for linked indicators) takes the new value as-is; accumulated keeps
      // a running sum on the CPU side.
      const def = linkedDefs.find(d => d.id === id);
      const v = decoded[id]!;
      if (def && def.accumulationMode === 'accumulated') {
        if (typeof v === 'number') {
          const prev = (linkedAccumulators[id] as number | undefined) ?? 0;
          const next = prev + v;
          linkedAccumulators[id] = next;
          linkedResults[id] = next;
        } else {
          const prev = (linkedAccumulators[id] as Record<string, number> | undefined) ?? {};
          const next: Record<string, number> = { ...prev };
          for (const k of Object.keys(v)) next[k] = (next[k] ?? 0) + (v[k] ?? 0);
          linkedAccumulators[id] = next;
          linkedResults[id] = next;
        }
      } else {
        linkedResults[id] = v;
      }
    }
  }
}


function writeDefaultColors(): void {
  // Fallback coloring: first bool attr determines color
  const firstBool = cellAttrs.find(a => a.type === 'bool');
  if (!firstBool) {
    colors.fill(0);
    for (let i = 3; i < colors.length; i += 4) colors[i] = 255;
    return;
  }
  const arr = readAttrs[firstBool.id]!;
  for (let i = 0; i < total; i++) {
    const px = i * 4;
    if (arr[i]) {
      colors[px] = 76; colors[px + 1] = 201; colors[px + 2] = 240;
    } else {
      colors[px] = 13; colors[px + 1] = 27; colors[px + 2] = 43;
    }
    colors[px + 3] = 255;
  }
}

function randomizeGrid(): void {
  for (const attr of cellAttrs) {
    const arr = readAttrs[attr.id]!;
    for (let i = 0; i < total; i++) {
      if (attr.type === 'bool') arr[i] = Math.random() > 0.7 ? 1 : 0;
      else if (attr.type === 'integer') arr[i] = Math.floor(Math.random() * 10);
      else if (attr.type === 'float') arr[i] = Math.random();
      else if (attr.type === 'tag') arr[i] = Math.floor(Math.random() * Math.max(1, attr.tagOptions?.length ?? 1));
    }
    const wArr = writeAttrs[attr.id]!;
    (wArr as Uint8Array).set(arr as Uint8Array);
  }
  resetIndicators();
  generation = 0;
  // Prefer Output Mapping color pass (no generation advance) over runStep fallback
  const hasColorPassR = outputMappingFns.some(f => f.mappingId === activeViewer);
  if (hasColorPassR) { runColorPass(); } else if (stepFn) { runStep(); } else { writeDefaultColors(); }
}

function resetGrid(): void {
  for (const attr of cellAttrs) {
    const dv = defaultValue(attr);
    const arr = readAttrs[attr.id]!;
    const wArr = writeAttrs[attr.id]!;
    for (let i = 0; i < total; i++) { arr[i] = dv; wArr[i] = dv; }
  }
  resetIndicators();
  generation = 0;
  const hasColorPassRs = outputMappingFns.some(f => f.mappingId === activeViewer);
  if (hasColorPassRs) { runColorPass(); } else if (stepFn) { runStep(); } else { writeDefaultColors(); }
}

function compileFns(
  stepCode: string,
  icCodes: Array<{ mappingId: string; code: string }>,
  omCodes: Array<{ mappingId: string; code: string }> = [],
): void {
  try {
    // eslint-disable-next-line no-eval
    stepFn = stepCode ? (eval(stepCode) as Function) : null;
  } catch { stepFn = null; }
  inputColorFns = [];
  for (const ic of icCodes) {
    try {
      // eslint-disable-next-line no-eval
      inputColorFns.push({ mappingId: ic.mappingId, fn: eval(ic.code) as Function });
    } catch { /* skip */ }
  }
  outputMappingFns = [];
  for (const om of omCodes) {
    try {
      // eslint-disable-next-line no-eval
      outputMappingFns.push({ mappingId: om.mappingId, fn: eval(om.code) as Function });
    } catch { /* skip */ }
  }
}

/** Run the Output Mapping color pass for the active viewer (if available).
 *  WASM mode: uses wasmOutputMappingFns. Sync mode + WASM also requires the
 *  same readAttrs->attrsA pre-step normalisation as runStep does, because the
 *  output mapping reads from the baked-in attrReadOffset. */
function runColorPass(): void {
  const sanitised = sanitiseExportName(activeViewer);
  if (useWasm && wasmOutputMappingFns[sanitised]) {
    if (updateMode !== 'asynchronous' && readAttrs !== attrsA) {
      for (const attr of cellAttrs) {
        (attrsA[attr.id] as Uint8Array).set(readAttrs[attr.id] as Uint8Array);
      }
      readAttrs = attrsA;
      writeAttrs = attrsB;
    }
    wasmOutputMappingFns[sanitised]!(total);
    return;
  }
  const omFn = outputMappingFns.find(f => f.mappingId === activeViewer);
  if (omFn) omFn.fn(...buildLoopArgs());
}

function initIndicators(defs: IndicatorDef[]): void {
  // cachedIndicators is a view over wasmMemory at layout.indicatorOffset[indId].
  // For N>0 indicators, the offsets are consecutive 8-byte slots; we view the
  // whole region as a Float64Array of length N.
  if (wasmMemory && wasmLayout && defs.length > 0) {
    const firstId = wasmLayout.indicatorIds[0]!;
    const baseOffset = wasmLayout.indicatorOffset[firstId]!;
    cachedIndicators = new Float64Array(wasmMemory.buffer, baseOffset, defs.length);
  } else {
    cachedIndicators = new Float64Array(defs.length);
  }
  standaloneDefaults = new Float64Array(defs.length);
  standalonePerGenIdx = [];
  standaloneIds = [];
  linkedDefs = [];
  linkedAccumulators = {};

  for (let i = 0; i < defs.length; i++) {
    const ind = defs[i]!;
    if (ind.kind === 'standalone') {
      const dv = ind.dataType === 'bool'
        ? (ind.defaultValue === 'true' ? 1 : 0)
        : (parseFloat(ind.defaultValue) || 0);
      cachedIndicators[i] = dv;
      standaloneDefaults[i] = dv;
      standaloneIds.push({ idx: i, id: ind.id });
      if (ind.accumulationMode === 'per-generation') {
        standalonePerGenIdx.push(i);
      }
    } else if (ind.kind === 'linked') {
      const linkedAttr = cellAttrs.find(a => a.id === ind.linkedAttributeId)
        || modelAttrsList.find(a => a.id === ind.linkedAttributeId);
      linkedDefs.push({
        id: ind.id,
        accumulationMode: ind.accumulationMode,
        attrId: ind.linkedAttributeId,
        attrType: linkedAttr?.type,
        aggregation: ind.linkedAggregation,
        binCount: ind.binCount,
        tagOptions: linkedAttr?.tagOptions,
        watched: ind.watched,
      });
    }
  }
}

function resetIndicators(): void {
  cachedIndicators.set(standaloneDefaults);
  linkedAccumulators = {};
  linkedResults = {};
}

/** WASM-path fallback. The JS-compiled step function contains injected
 *  post-loop code that computes frequency/total for each watched linked
 *  indicator and writes into `linkedResults`. The WASM step emits no such
 *  code, so we replicate the aggregation here, reading directly from the
 *  shared typed-array buffers. Mirrors `buildLinkedIndicatorCode` in
 *  `compiler/compile.ts` — keep the two in sync when that logic changes. */
function computeLinkedIndicatorsFromBuffer(): void {
  for (const def of linkedDefs) {
    if (!def.watched) continue;
    const arr = readAttrs[def.attrId ?? ''];
    if (!arr || !def.attrType || !def.aggregation) continue;
    if (def.aggregation === 'total') {
      let sum = 0;
      for (let i = 0; i < total; i++) sum += arr[i] ?? 0;
      linkedResults[def.id] = sum;
      continue;
    }
    // frequency
    if (def.attrType === 'bool') {
      let t = 0;
      for (let i = 0; i < total; i++) if (arr[i]) t++;
      linkedResults[def.id] = { 'true': t, 'false': total - t };
    } else if (def.attrType === 'tag') {
      const opts = def.tagOptions || [];
      const freq: Record<string, number> = {};
      for (const name of opts) freq[name] = 0;
      for (let i = 0; i < total; i++) {
        const idx = arr[i] ?? 0;
        const name = opts[idx];
        if (name !== undefined) freq[name] = (freq[name] ?? 0) + 1;
      }
      linkedResults[def.id] = freq;
    } else if (def.attrType === 'integer') {
      const freq: Record<string, number> = {};
      for (let i = 0; i < total; i++) {
        const k = String(arr[i] ?? 0);
        freq[k] = (freq[k] ?? 0) + 1;
      }
      linkedResults[def.id] = freq;
    } else if (def.attrType === 'float') {
      const bins = Math.max(1, def.binCount ?? 10);
      let mn = Infinity, mx = -Infinity;
      for (let i = 0; i < total; i++) {
        const v = arr[i] ?? 0;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      if (!Number.isFinite(mn) || !Number.isFinite(mx) || mn === mx) {
        linkedResults[def.id] = { [`${(mn || 0).toFixed(2)}\u2013${(mn || 0).toFixed(2)}`]: total };
        continue;
      }
      const range = mx - mn;
      const step = range / bins;
      const counts: number[] = new Array(bins).fill(0);
      for (let i = 0; i < total; i++) {
        const v = arr[i] ?? 0;
        let b = Math.floor(((v - mn) / range) * bins);
        if (b >= bins) b = bins - 1;
        if (b < 0) b = 0;
        counts[b]! += 1;
      }
      const freq: Record<string, number> = {};
      for (let b = 0; b < bins; b++) {
        const lo = mn + b * step;
        const hi = b === bins - 1 ? mx : mn + (b + 1) * step;
        freq[`${lo.toFixed(2)}\u2013${hi.toFixed(2)}`] = counts[b]!;
      }
      linkedResults[def.id] = freq;
    }
  }
}

function sendColors(): void {
  // Only build indicators payload when there are entries (avoids overhead when no indicators)
  const hasStandalone = standaloneIds.length > 0;
  const hasLinked = linkedDefs.length > 0;
  let indicators: Record<string, number | Record<string, number>> | undefined;
  if (hasStandalone || hasLinked) {
    indicators = {};
    for (const { idx, id } of standaloneIds) {
      indicators[id] = cachedIndicators[idx]!;
    }
    for (const id of Object.keys(linkedResults)) {
      indicators[id] = linkedResults[id]!;
    }
  }
  // P7 — when WebGPU direct render is active, the OffscreenCanvas already
  // holds the latest frame; skip the colors transfer entirely. Main-thread
  // draw() detects this and only does the zoom/pan composite.
  if (webgpuRuntime?.directRender) {
    self.postMessage({ type: 'stepped', generation, indicators });
    return;
  }
  const copy = new Uint8ClampedArray(colors);
  self.postMessage(
    { type: 'stepped', generation, colors: copy, indicators },
    { transfer: [copy.buffer] },
  );
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

self.onmessage = (e: MessageEvent<WorkerMsg>) => {
  const msg = e.data;

  switch (msg.type) {
    case 'init': {
      width = msg.width;
      height = msg.height;
      cellAttrs = msg.attributes.filter(a => !a.isModelAttribute);
      modelAttrsList = msg.attributes.filter(a => a.isModelAttribute);
      indicatorsList = msg.indicators || [];
      neighborhoods = msg.neighborhoods;
      boundaryTreatment = msg.boundaryTreatment;
      updateMode = msg.updateMode || 'synchronous';
      asyncScheme = msg.asyncScheme || 'random-order';

      // Cache model attributes
      cachedModelAttrs = {};
      for (const attr of msg.attributes) {
        if (!attr.isModelAttribute) continue;
        if (attr.type === 'color') {
          const hex = attr.defaultValue || '#808080';
          cachedModelAttrs[attr.id + '_r'] = parseInt(hex.slice(1, 3), 16) || 0;
          cachedModelAttrs[attr.id + '_g'] = parseInt(hex.slice(3, 5), 16) || 0;
          cachedModelAttrs[attr.id + '_b'] = parseInt(hex.slice(5, 7), 16) || 0;
        } else {
          cachedModelAttrs[attr.id] = defaultValue(attr);
        }
      }

      activeViewer = msg.activeViewer; syncActiveViewerToMemory();
      viewerIdMap = msg.viewerIds || {};
      // initGrid first because it allocates wasmMemory + computes layout that
      // initIndicators / buildNeighborIndices need to create their views over.
      initGrid();
      buildNeighborIndices();
      initIndicators(msg.indicators || []);
      // After memory is allocated, sync model attrs + active viewer ID into it
      // so WASM emitters that read those regions see meaningful values.
      syncModelAttrsToMemory();
      syncActiveViewerToMemory();
      compileFns(msg.stepCode, msg.inputColorCodes, msg.outputMappingCodes || []);
      stopMessages = msg.stopMessages || [];
      webgpuStopCheckInterval = Math.max(1, Math.floor(msg.webgpuStopCheckInterval ?? 1));
      // Mutual exclusion safety net: a saved file or hand-edited JSON could
      // arrive with both flags true. The model-properties UI prevents this for
      // any live edit, but worker-side enforcement keeps legacy inputs sane.
      // WebGPU wins (it's the newer, opt-in target); WASM is silently demoted.
      const wantWebGPU = !!msg.useWebGPU;
      const wantWasm = !wantWebGPU && !!msg.useWasm;
      if (msg.useWebGPU && msg.useWasm) {
        // eslint-disable-next-line no-console
        console.warn('[init] both useWebGPU and useWasm true — preferring WebGPU, ignoring WASM flag');
      }
      useWasm = wantWasm && !!msg.wasmStepBytes && !msg.wasmStepError;
      useWebGPU = wantWebGPU;
      tryInstantiateWasmModule(msg.wasmStepBytes, msg.wasmExports);
      if (msg.wasmStepError && wantWasm) {
        self.postMessage({ type: 'error', message: '[wasm] compile failed, falling back to JS: ' + msg.wasmStepError });
      }
      // Async-init the WebGPU runtime when the user has it selected. Starts the
      // adapter/device handshake; runStep() falls through to JS/WASM until
      // `webgpuRuntime.stepReady` flips true (filled in by step 2+).
      if (wantWebGPU) {
        startWebGPUInit(
          msg.webgpuShaderCode, msg.webgpuEntryPoints, msg.webgpuLayout, msg.webgpuShaderError,
          msg.webgpuCanvas,
        );
      } else {
        destroyWebGPURuntime(webgpuRuntime);
        webgpuRuntime = null;
      }
      writeDefaultColors();
      sendColors();
      break;
    }

    case 'step': {
      const webgpuActive = useWebGPU && webgpuRuntime?.stepReady;
      if (!stepFn && !webgpuActive) {
        self.postMessage({ type: 'error', message: 'No compiled step function.' });
        return;
      }
      activeViewer = msg.activeViewer; syncActiveViewerToMemory();
      if (webgpuActive && webgpuRuntime) uploadActiveViewer(webgpuRuntime, viewerIdMap[activeViewer] ?? -1);

      if (webgpuActive) {
        // Async WebGPU path: dispatch N steps + finalize each (we need stop-flag
        // readback per-step to honour the same first-stop-wins semantics as JS).
        // Most models won't have stop events, but the readback is cheap (single
        // u32 mapAsync).
        (async () => {
          let stoppedByEvent: string | null = null;
          let lastFinalize: Promise<void> = Promise.resolve();
          // B4B: opt-in K-step skipping. With K=1 (default), check every step
          // — exact stop-event timing. With K>1, skip the readback on most
          // steps but ALWAYS check the last step of the batch so the user
          // sees any pending stop within this batch (otherwise the play loop
          // would advance past it).
          const k = Math.max(1, webgpuStopCheckInterval | 0);
          for (let i = 0; i < msg.count; i++) {
            runStepWebGPU();
            const isLast = i === msg.count - 1;
            const shouldCheck = stopMessages.length > 0 && (k === 1 || isLast || (i % k) === (k - 1));
            if (shouldCheck) {
              await finalizeStepWebGPU({ needColors: false });
              const rawStop = stopFlag[0] ?? 0;
              if (rawStop !== 0) {
                const idx = rawStop - 1;
                stoppedByEvent = stopMessages[idx] ?? `Stop event #${idx}`;
                stopFlag[0] = 0;
                break;
              }
            }
            lastFinalize = Promise.resolve();
          }
          await lastFinalize;
          // After all steps, dispatch the active viewer's outputMapping if its
          // pipeline exists. When it doesn't (no Output Mapping graph), the
          // step shader itself may have written to the colors buffer via
          // SetColorViewer-in-step (e.g. MNCA's "Case Colored"). Either way we
          // read the GPU colors buffer back — that's the canonical source.
          if (!msg.skipColorPass) runColorPassWebGPU();
          await finalizeStepWebGPU({ needColors: !msg.skipColorPass });
          sendColors();
          if (stoppedByEvent !== null) {
            self.postMessage({ type: 'stopEvent', message: stoppedByEvent });
          }
        })().catch(e => {
          const m = (e instanceof Error) ? e.message : String(e);
          self.postMessage({ type: 'error', message: '[webgpu] step pipeline failed: ' + m });
        });
        break;
      }

      let stoppedByEvent: string | null = null;
      for (let i = 0; i < msg.count; i++) {
        runStep();
        const rawStop = stopFlag[0] ?? 0;
        if (rawStop !== 0) {
          const idx = rawStop - 1;
          stoppedByEvent = stopMessages[idx] ?? `Stop event #${idx}`;
          stopFlag[0] = 0;
          break;
        }
      }
      if (!msg.skipColorPass) runColorPass();
      sendColors();
      if (stoppedByEvent !== null) {
        self.postMessage({ type: 'stopEvent', message: stoppedByEvent });
      }
      break;
    }

    case 'paint': {
      activeViewer = msg.activeViewer; syncActiveViewerToMemory();
      const icEntry = msg.mappingId
        ? inputColorFns.find(f => f.mappingId === msg.mappingId)
        : inputColorFns[0];
      const wasmIcKey = msg.mappingId ? sanitiseExportName(msg.mappingId) : '';
      const wasmIcFn = (useWasm && wasmIcKey && wasmInputColorFns[wasmIcKey]) || null;
      // Pre-paint normalisation for WASM (sync mode): InputColor compiles the
      // same copy-line preamble as step, but it reads from attrReadOffset.
      const isSync = updateMode !== 'asynchronous';
      if (wasmIcFn && isSync && readAttrs !== attrsA) {
        for (const attr of cellAttrs) {
          (attrsA[attr.id] as Uint8Array).set(readAttrs[attr.id] as Uint8Array);
        }
        readAttrs = attrsA;
        writeAttrs = attrsB;
      }

      const paintApply = (): void => {
        for (const c of msg.cells) {
          if (c.row < 0 || c.row >= height || c.col < 0 || c.col >= width) continue;
          const idx = c.row * width + c.col;

          if (wasmIcFn) {
            // WASM InputColor writes via baked-in attrWriteOffset.
            wasmIcFn(idx, c.r, c.g, c.b);
            if (isSync) {
              // Sync mode: also copy the per-cell write back to read so the next
              // paint / step sees it. (Async shares one buffer so this is a no-op.)
              for (const attr of cellAttrs) {
                readAttrs[attr.id]![idx] = writeAttrs[attr.id]![idx]!;
              }
            }
          } else if (icEntry?.fn) {
            // InputColor writes to writeAttrs (via w_<attr>[idx])
            // We need to also update readAttrs so the next step sees the change
            icEntry.fn(c.r, c.g, c.b, ...buildCellArgs(idx));
            // Copy written values back to read buffer so step() sees them
            for (const attr of cellAttrs) {
              readAttrs[attr.id]![idx] = writeAttrs[attr.id]![idx]!;
            }
          } else {
            // Fallback: set first bool attribute in BOTH buffers
            const firstBool = cellAttrs.find(a => a.type === 'bool');
            if (firstBool) {
              readAttrs[firstBool.id]![idx] = 1;
              writeAttrs[firstBool.id]![idx] = 1;
            }
          }
        }

        // Update display.
        const hasColorPass = outputMappingFns.some(f => f.mappingId === activeViewer);
        const webgpuPaint = useWebGPU && webgpuRuntime?.stepReady;
        if (webgpuPaint && webgpuRuntime) {
          // Patch only the painted cells — the rest of the GPU buffer holds
          // evolved state we mustn't clobber with the stale CPU mirror.
          const idxs: number[] = [];
          for (const c of msg.cells) {
            if (c.row < 0 || c.row >= height || c.col < 0 || c.col >= width) continue;
            idxs.push(c.row * width + c.col);
          }
          patchWebGPUCells(idxs);
          uploadActiveViewer(webgpuRuntime, viewerIdMap[activeViewer] ?? -1);
          // gpuOwnsAttrs stays as-is — we only patched a few cells; the rest of
          // the CPU mirror is still stale w.r.t. the evolved GPU state.
          refreshColorsAfterInputWebGPU();
          finalizeStepWebGPU({ needColors: true }).then(() => sendColors())
            .catch(e => self.postMessage({ type: 'error', message: '[webgpu] paint colorPass failed: ' + ((e instanceof Error) ? e.message : String(e)) }));
          return;
        }
        if (hasColorPass) {
          runColorPass();
        } else if (stepFn) {
          runStep();
        } else {
          writeDefaultColors();
        }
        sendColors();
      };

      // After a play sequence on WebGPU, the live state lives on GPU and the
      // CPU `readAttrs` is stale. JS InputColor functions that read-before-write
      // (toggle-style brushes) would compute against pre-play values. Pull the
      // live state down once before iterating cells. (WASM is mutually exclusive
      // with WebGPU, so wasmIcFn isn't reachable when webgpuRuntime is live.)
      if (useWebGPU && webgpuRuntime?.stepReady && gpuOwnsAttrs && icEntry?.fn) {
        const rt = webgpuRuntime;
        readbackAttrs(rt, readAttrs).then(() => {
          gpuOwnsAttrs = false;
          paintApply();
        }).catch(e => self.postMessage({ type: 'error', message: '[webgpu] paint readback failed: ' + ((e instanceof Error) ? e.message : String(e)) }));
        break;
      }
      paintApply();
      break;
    }

    case 'randomize': {
      activeViewer = msg.activeViewer; syncActiveViewerToMemory();
      randomizeGrid();
      const webgpuRandomize = useWebGPU && webgpuRuntime?.stepReady;
      if (webgpuRandomize && webgpuRuntime) {
        uploadAttrs(webgpuRuntime, readAttrs);
        uploadActiveViewer(webgpuRuntime, viewerIdMap[activeViewer] ?? -1);
        syncIndicatorsCpuToGpu();
        gpuOwnsAttrs = false;
        runColorPassWebGPU();
        finalizeStepWebGPU({ needColors: true }).then(() => sendColors())
          .catch(e => self.postMessage({ type: 'error', message: '[webgpu] randomize colorPass failed: ' + ((e instanceof Error) ? e.message : String(e)) }));
        break;
      }
      sendColors();
      break;
    }

    case 'reset': {
      activeViewer = msg.activeViewer; syncActiveViewerToMemory();
      resetGrid();
      const webgpuReset = useWebGPU && webgpuRuntime?.stepReady;
      if (webgpuReset && webgpuRuntime) {
        uploadAttrs(webgpuRuntime, readAttrs);
        uploadActiveViewer(webgpuRuntime, viewerIdMap[activeViewer] ?? -1);
        syncIndicatorsCpuToGpu();
        gpuOwnsAttrs = false;
        runColorPassWebGPU();
        finalizeStepWebGPU({ needColors: true }).then(() => sendColors())
          .catch(e => self.postMessage({ type: 'error', message: '[webgpu] reset colorPass failed: ' + ((e instanceof Error) ? e.message : String(e)) }));
        break;
      }
      sendColors();
      break;
    }

    case 'recompile': {
      updateMode = msg.updateMode || updateMode;
      asyncScheme = msg.asyncScheme || asyncScheme;
      if ((msg as RecompileMsg).viewerIds) {
        viewerIdMap = (msg as RecompileMsg).viewerIds!;
        syncActiveViewerToMemory();
      }
      compileFns(msg.stepCode, msg.inputColorCodes, (msg as RecompileMsg).outputMappingCodes || []);
      stopMessages = (msg as RecompileMsg).stopMessages || [];
      if ((msg as RecompileMsg).webgpuStopCheckInterval !== undefined) {
        webgpuStopCheckInterval = Math.max(1, Math.floor((msg as RecompileMsg).webgpuStopCheckInterval!));
      }
      tryInstantiateWasmModule((msg as RecompileMsg).wasmStepBytes, (msg as RecompileMsg).wasmExports);
      if ((msg as RecompileMsg).wasmStepError) {
        self.postMessage({ type: 'error', message: '[wasm] recompile failed, falling back to JS: ' + (msg as RecompileMsg).wasmStepError });
      }
      // Wave 3: rebuild WebGPU runtime when the shader source arrives. Only
      // re-init when there's a non-empty shader payload AND the user has
      // useWebGPU on at the time the recompile lands; setUseWebGPU handles
      // the "user just enabled it" case separately.
      const recompile = msg as RecompileMsg;
      if (useWebGPU && recompile.webgpuShaderCode) {
        startWebGPUInit(recompile.webgpuShaderCode, recompile.webgpuEntryPoints, recompile.webgpuLayout, recompile.webgpuShaderError);
      } else if (recompile.webgpuShaderError) {
        self.postMessage({ type: 'error', message: '[webgpu] recompile failed: ' + recompile.webgpuShaderError });
      }
      self.postMessage({ type: 'ready' });
      break;
    }

    case 'setUseWasm': {
      useWasm = !!msg.enabled;
      // If the user just turned WASM on, make sure WebGPU is off (mutual
      // exclusion mirrors the UI radio group).
      if (useWasm && useWebGPU) {
        useWebGPU = false;
        destroyWebGPURuntime(webgpuRuntime);
        webgpuRuntime = null;
      }
      self.postMessage({ type: 'useWasmStatus', enabled: useWasm, ready: wasmStepFn !== null });
      break;
    }

    case 'setUseWebGPU': {
      useWebGPU = !!msg.enabled;
      if (useWebGPU && useWasm) {
        // Mutual exclusion: WebGPU wins.
        useWasm = false;
      }
      self.postMessage({ type: 'useWebGPUStatus', enabled: useWebGPU, ready: webgpuRuntime?.stepReady ?? false });
      break;
    }

    case 'readbackWebGPU': {
      if (!webgpuRuntime?.stepReady) {
        self.postMessage({ type: 'webgpuReadback', ready: false, attrs: {}, reason: 'stepReady false' });
        break;
      }
      // Async — copies attrsRead from GPU into the existing readAttrs typed
      // arrays, then posts a snapshot back. Used by the parity-test harness.
      readbackAttrs(webgpuRuntime, readAttrs).then(() => {
        const snapshot: Record<string, { type: string; data: number[] }> = {};
        for (const a of cellAttrs) {
          const arr = readAttrs[a.id]!;
          // Cap to 100 entries in the message — full grids would blow up
          // postMessage; the harness samples or compares first-N.
          const cap = Math.min(arr.length, 100);
          const out: number[] = new Array(cap);
          for (let i = 0; i < cap; i++) out[i] = arr[i] ?? 0;
          snapshot[a.id] = { type: a.type, data: out };
        }
        self.postMessage({ type: 'webgpuReadback', ready: true, generation, attrs: snapshot });
      }).catch((e: unknown) => {
        const m = (e instanceof Error) ? e.message : String(e);
        self.postMessage({ type: 'webgpuReadback', ready: false, attrs: {}, reason: 'readback error: ' + m });
        self.postMessage({ type: 'error', message: '[webgpu] readback failed: ' + m });
      });
      break;
    }


    case 'updateModelAttrs': {
      for (const [key, val] of Object.entries(msg.attrs as Record<string, number>)) {
        cachedModelAttrs[key] = val;
      }
      syncModelAttrsToMemory();
      // Mirror the change into the GPU uniform buffer so the next step shader
      // sees the updated values (without this, WebGPU silently runs against
      // the stale modelAttrs frozen at init time).
      if (webgpuRuntime?.stepReady) {
        uploadModelAttrs(webgpuRuntime, cachedModelAttrs as Record<string, number>);
      }
      break;
    }

    case 'updateIndicators': {
      initIndicators(msg.indicators);
      // O5 — refresh the GPU reduction plan whenever watched/linked status
      // changes. Cheap (no buffer reallocation when the plan is unchanged at
      // setupReductionPipelines's level — though the function does rebuild
      // on every call; acceptable since this fires only on user edit).
      if (webgpuRuntime?.stepReady) setupReductionPipelines(webgpuRuntime, linkedDefs);
      break;
    }


    case 'importImage': {
      activeViewer = msg.activeViewer; syncActiveViewerToMemory();
      const icEntry = msg.mappingId
        ? inputColorFns.find(f => f.mappingId === msg.mappingId)
        : inputColorFns[0];
      const wasmIcKey = msg.mappingId ? sanitiseExportName(msg.mappingId) : '';
      const wasmIcFn = (useWasm && wasmIcKey && wasmInputColorFns[wasmIcKey]) || null;
      if (!wasmIcFn && !icEntry?.fn) break;
      const isSync = updateMode !== 'asynchronous';
      if (wasmIcFn && isSync && readAttrs !== attrsA) {
        for (const attr of cellAttrs) {
          (attrsA[attr.id] as Uint8Array).set(readAttrs[attr.id] as Uint8Array);
        }
        readAttrs = attrsA;
        writeAttrs = attrsB;
      }
      const pixels = msg.pixels as Uint8ClampedArray;
      for (let idx = 0; idx < total; idx++) {
        const r = pixels[idx * 4]!;
        const g = pixels[idx * 4 + 1]!;
        const b = pixels[idx * 4 + 2]!;
        if (wasmIcFn) {
          wasmIcFn(idx, r, g, b);
          if (isSync) {
            for (const attr of cellAttrs) {
              readAttrs[attr.id]![idx] = writeAttrs[attr.id]![idx]!;
            }
          }
        } else if (icEntry?.fn) {
          icEntry.fn(r, g, b, ...buildCellArgs(idx));
          // Copy write→read so state is visible on next step
          for (const attr of cellAttrs) {
            readAttrs[attr.id]![idx] = writeAttrs[attr.id]![idx]!;
          }
        }
      }
      // Update display.
      const hasColorPassImg = outputMappingFns.some(f => f.mappingId === activeViewer);
      const webgpuImport = useWebGPU && webgpuRuntime?.stepReady;
      if (webgpuImport && webgpuRuntime) {
        uploadAttrs(webgpuRuntime, readAttrs);
        uploadActiveViewer(webgpuRuntime, viewerIdMap[activeViewer] ?? -1);
        gpuOwnsAttrs = false;
        refreshColorsAfterInputWebGPU();
        finalizeStepWebGPU({ needColors: true }).then(() => sendColors())
          .catch(e => self.postMessage({ type: 'error', message: '[webgpu] importImage colorPass failed: ' + ((e instanceof Error) ? e.message : String(e)) }));
        break;
      }
      if (hasColorPassImg) {
        runColorPass();
      } else if (stepFn) {
        runStep();
      } else {
        writeDefaultColors();
      }
      sendColors();
      break;
    }

    case 'colorPass': {
      activeViewer = msg.activeViewer; syncActiveViewerToMemory();
      const webgpuCp = useWebGPU && webgpuRuntime?.stepReady;
      if (webgpuCp && webgpuRuntime) {
        uploadActiveViewer(webgpuRuntime, viewerIdMap[activeViewer] ?? -1);
        runColorPassWebGPU();
        finalizeStepWebGPU({ needColors: true }).then(() => sendColors())
          .catch(e => self.postMessage({ type: 'error', message: '[webgpu] colorPass failed: ' + ((e instanceof Error) ? e.message : String(e)) }));
        break;
      }
      const hasColorPassCp = outputMappingFns.some(f => f.mappingId === activeViewer);
      if (hasColorPassCp) {
        runColorPass();
      } else {
        writeDefaultColors();
      }
      sendColors();
      break;
    }

    case 'getState': {
      const sendNow = () => {
        const attrBuffers: Record<string, { type: string; buffer: ArrayBuffer }> = {};
        const transfers: ArrayBuffer[] = [];
        for (const attr of cellAttrs) {
          const arr = readAttrs[attr.id]!;
          const copy = (arr as Uint8Array).slice();
          attrBuffers[attr.id] = { type: attr.type, buffer: copy.buffer };
          transfers.push(copy.buffer);
        }
        const colorsCopy = colors.slice();
        transfers.push(colorsCopy.buffer);
        const indicatorsSnapshot: Record<string, number> = {};
        for (const { idx, id } of standaloneIds) indicatorsSnapshot[id] = cachedIndicators[idx]!;
        const response: Record<string, unknown> = {
          type: 'state',
          generation, width, height,
          attributes: attrBuffers,
          modelAttrs: { ...cachedModelAttrs },
          indicators: indicatorsSnapshot,
          linkedAccumulators: JSON.parse(JSON.stringify(linkedAccumulators)),
          colors: colorsCopy.buffer,
        };
        if (orderArray) {
          const orderCopy = orderArray.slice();
          response.orderArray = orderCopy.buffer;
          transfers.push(orderCopy.buffer);
        }
        self.postMessage(response, { transfer: transfers });
      };
      if (useWebGPU && webgpuRuntime?.stepReady && (gpuOwnsAttrs || webgpuRuntime.directRender)) {
        // Pull live GPU state down before serialising. With direct render the
        // CPU `colors` mirror is stale (no per-step readback) — pull it too
        // so the saved state contains the actual displayed colors.
        const rt = webgpuRuntime;
        const tasks: Array<Promise<void>> = [];
        if (gpuOwnsAttrs) tasks.push(readbackAttrs(rt, readAttrs));
        if (rt.directRender) tasks.push(readbackColors(rt, colors));
        Promise.all(tasks).then(() => {
          gpuOwnsAttrs = false;
          sendNow();
        }).catch(e => {
          self.postMessage({ type: 'error', message: '[webgpu] getState readback failed: ' + ((e instanceof Error) ? e.message : String(e)) });
          sendNow();
        });
      } else {
        sendNow();
      }
      break;
    }

    case 'loadState': {
      // State files restore the grid configuration, NOT the run history —
      // generation counter and indicator values reset to their init defaults
      // so the user can start fresh from a saved starting position.
      generation = 0;
      resetIndicators();
      linkedAccumulators = {};
      linkedResults = {};
      activeViewer = msg.activeViewer; syncActiveViewerToMemory();

      // Restore cell attribute arrays — COPY INTO the existing views over WASM
      // memory rather than replacing them (replacement would orphan them from
      // the WASM module that addresses memory by offset).
      const isAsyncLoad = updateMode === 'asynchronous';
      for (const attr of cellAttrs) {
        const entry = msg.attributes[attr.id];
        if (!entry) continue;
        const Ctor = createTypedArray(attr.type, 0).constructor as { new (b: ArrayBuffer): Float64Array | Int32Array | Uint8Array };
        const srcView = new Ctor(entry.buffer);
        const dstA = attrsA[attr.id]!;
        const copyLen = Math.min(dstA.length, srcView.length);
        for (let i = 0; i < copyLen; i++) (dstA as Uint8Array)[i] = srcView[i]!;
        if (!isAsyncLoad) {
          const dstB = attrsB[attr.id]!;
          for (let i = 0; i < copyLen; i++) (dstB as Uint8Array)[i] = srcView[i]!;
        }
      }
      readAttrs = attrsA;
      writeAttrs = isAsyncLoad ? attrsA : attrsB;

      // Restore colors
      const loadedColors = new Uint8ClampedArray(msg.colors);
      const colorLen = Math.min(colors.length, loadedColors.length);
      for (let i = 0; i < colorLen; i++) colors[i] = loadedColors[i]!;

      // Restore model attributes (these are parameter values, not run state,
      // so they ARE restored)
      for (const [key, val] of Object.entries(msg.modelAttrs)) {
        cachedModelAttrs[key] = val;
      }

      // Restore order array
      if (msg.orderArray) {
        orderArray = new Int32Array(msg.orderArray);
      }

      // Rebuild neighbor indices for constant boundary sentinel
      buildNeighborIndices();

      // Sync restored state to GPU when WebGPU is active.
      if (useWebGPU && webgpuRuntime?.stepReady) {
        uploadAttrs(webgpuRuntime, readAttrs);
        uploadNeighborIndices(webgpuRuntime, nbrIndices);
        uploadModelAttrs(webgpuRuntime, cachedModelAttrs as Record<string, number>);
        uploadActiveViewer(webgpuRuntime, viewerIdMap[activeViewer] ?? -1);
        syncIndicatorsCpuToGpu();
        gpuOwnsAttrs = false;
      }

      sendColors();
      break;
    }

    case 'readRegion': {
      // Snapshot every cell attribute over the (row, col, w, h) rectangle.
      // Cells outside [0, width) × [0, height) are replaced by the attribute's default value.
      const attrBuffers: Record<string, { type: string; buffer: ArrayBuffer }> = {};
      const transfers: ArrayBuffer[] = [];
      const size = msg.w * msg.h;
      for (const attr of cellAttrs) {
        const out = createTypedArray(attr.type, size);
        const dv = defaultValue(attr);
        if (dv !== 0) out.fill(dv);
        const src = readAttrs[attr.id]!;
        for (let dr = 0; dr < msg.h; dr++) {
          const srcRow = msg.row + dr;
          if (srcRow < 0 || srcRow >= height) continue;
          for (let dc = 0; dc < msg.w; dc++) {
            const srcCol = msg.col + dc;
            if (srcCol < 0 || srcCol >= width) continue;
            out[dr * msg.w + dc] = src[srcRow * width + srcCol]!;
          }
        }
        attrBuffers[attr.id] = { type: attr.type, buffer: out.buffer };
        transfers.push(out.buffer);
      }
      self.postMessage({ type: 'regionData', w: msg.w, h: msg.h, attributes: attrBuffers }, { transfer: transfers });
      break;
    }

    case 'writeRegion': {
      activeViewer = msg.activeViewer; syncActiveViewerToMemory();
      const isAsync = updateMode === 'asynchronous';
      for (const attr of cellAttrs) {
        const entry = msg.attributes[attr.id];
        if (!entry) continue;
        // Rebuild typed view over the transferred buffer
        const Ctor = (createTypedArray(attr.type, 0).constructor as { new(b: ArrayBuffer): Float64Array | Int32Array | Uint8Array });
        const src = new Ctor(entry.buffer);
        const dst = readAttrs[attr.id]!;
        const dstB = writeAttrs[attr.id]!;
        for (let dr = 0; dr < msg.h; dr++) {
          const dstRow = msg.row + dr;
          if (dstRow < 0 || dstRow >= height) continue;
          for (let dc = 0; dc < msg.w; dc++) {
            const dstCol = msg.col + dc;
            if (dstCol < 0 || dstCol >= width) continue;
            const i = dstRow * width + dstCol;
            const v = src[dr * msg.w + dc]!;
            dst[i] = v;
            if (!isAsync) dstB[i] = v;
          }
        }
      }
      // Update display via the Output Mapping if one exists, else leave colors as-is.
      const webgpuWrite = useWebGPU && webgpuRuntime?.stepReady;
      if (webgpuWrite && webgpuRuntime) {
        // Patch only the cells in the write region; leave the rest of the GPU
        // buffer alone so any in-flight evolved state isn't clobbered.
        const idxs: number[] = [];
        for (let dr = 0; dr < msg.h; dr++) {
          const dstRow = msg.row + dr;
          if (dstRow < 0 || dstRow >= height) continue;
          for (let dc = 0; dc < msg.w; dc++) {
            const dstCol = msg.col + dc;
            if (dstCol < 0 || dstCol >= width) continue;
            idxs.push(dstRow * width + dstCol);
          }
        }
        patchWebGPUCells(idxs);
        uploadActiveViewer(webgpuRuntime, viewerIdMap[activeViewer] ?? -1);
        refreshColorsAfterInputWebGPU();
        finalizeStepWebGPU({ needColors: true }).then(() => sendColors())
          .catch(e => self.postMessage({ type: 'error', message: '[webgpu] writeRegion colorPass failed: ' + ((e instanceof Error) ? e.message : String(e)) }));
        break;
      }
      if (outputMappingFns.some(f => f.mappingId === activeViewer)) {
        runColorPass();
      }
      sendColors();
      break;
    }

    case 'clearRegion': {
      activeViewer = msg.activeViewer; syncActiveViewerToMemory();
      const isAsync = updateMode === 'asynchronous';
      for (const attr of cellAttrs) {
        const dv = defaultValue(attr);
        const dst = readAttrs[attr.id]!;
        const dstB = writeAttrs[attr.id]!;
        for (let dr = 0; dr < msg.h; dr++) {
          const dstRow = msg.row + dr;
          if (dstRow < 0 || dstRow >= height) continue;
          for (let dc = 0; dc < msg.w; dc++) {
            const dstCol = msg.col + dc;
            if (dstCol < 0 || dstCol >= width) continue;
            const i = dstRow * width + dstCol;
            dst[i] = dv;
            if (!isAsync) dstB[i] = dv;
          }
        }
      }
      const webgpuClear = useWebGPU && webgpuRuntime?.stepReady;
      if (webgpuClear && webgpuRuntime) {
        // Patch only the cleared region; preserve the rest of the GPU state.
        const idxs: number[] = [];
        for (let dr = 0; dr < msg.h; dr++) {
          const dstRow = msg.row + dr;
          if (dstRow < 0 || dstRow >= height) continue;
          for (let dc = 0; dc < msg.w; dc++) {
            const dstCol = msg.col + dc;
            if (dstCol < 0 || dstCol >= width) continue;
            idxs.push(dstRow * width + dstCol);
          }
        }
        patchWebGPUCells(idxs);
        uploadActiveViewer(webgpuRuntime, viewerIdMap[activeViewer] ?? -1);
        refreshColorsAfterInputWebGPU();
        finalizeStepWebGPU({ needColors: true }).then(() => sendColors())
          .catch(e => self.postMessage({ type: 'error', message: '[webgpu] clearRegion colorPass failed: ' + ((e instanceof Error) ? e.message : String(e)) }));
        break;
      }
      if (outputMappingFns.some(f => f.mappingId === activeViewer)) {
        runColorPass();
      }
      sendColors();
      break;
    }
  }
};

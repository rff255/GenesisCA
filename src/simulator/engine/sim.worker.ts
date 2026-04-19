/**
 * Web Worker for GenesisCA simulation.
 * Uses Structure of Arrays (SoA) for grid state — one typed array per attribute.
 * Pre-computes neighbor index tables for zero-cost boundary handling.
 */

import { instantiateWasmStep } from '../../modeler/vpl/compiler/wasm/compile';
import { computeMemoryLayout, type MemoryLayout } from '../../modeler/vpl/compiler/wasm/layout';

interface AttrDef {
  id: string;
  type: string;
  isModelAttribute: boolean;
  defaultValue: string;
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
  activeViewer: string;
  indicators?: IndicatorDef[];
  /** Wave 2: optional pre-compiled WASM step bytes (compiled on main thread). */
  wasmStepBytes?: Uint8Array;
  wasmStepError?: string;
  /** Compile-time viewer id -> int mapping (matches the WASM module's setColorViewer constants). */
  viewerIds?: Record<string, number>;
  /** Default useWasm flag (from model properties); user can flip via setUseWasm later. */
  useWasm?: boolean;
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
interface RecompileMsg { type: 'recompile'; stepCode: string; inputColorCodes: Array<{ mappingId: string; code: string }>; outputMappingCodes: Array<{ mappingId: string; code: string }>; updateMode: string; asyncScheme: string; wasmStepBytes?: Uint8Array; wasmStepError?: string; viewerIds?: Record<string, number> }
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
  generation: number;
  width: number;
  height: number;
  attributes: Record<string, { type: string; buffer: ArrayBuffer }>;
  modelAttrs: Record<string, number>;
  indicators: Record<string, number>;
  linkedAccumulators: Record<string, number | Record<string, number>>;
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

type WorkerMsg = InitMsg | StepMsg | PaintMsg | RandomizeMsg | ResetMsg | RecompileMsg | UpdateModelAttrsMsg | ImportImageMsg | UpdateIndicatorsMsg | GetStateMsg | LoadStateMsg | ReadRegionMsg | WriteRegionMsg | ClearRegionMsg | SetUseWasmMsg;

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
let useWasm = false;

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
  id: string; accumulationMode: string;
}> = [];
let linkedAccumulators: Record<string, number | Record<string, number>> = {};
let linkedResults: Record<string, number | Record<string, number>> = {};

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

  for (const attr of cellAttrs) {
    const dv = defaultValue(attr);
    const arrA = viewOver(attr.type, buf, wasmLayout.attrReadOffset[attr.id]!, total);
    if (dv !== 0) arrA.fill(dv);
    attrsA[attr.id] = arrA;

    if (isAsync) {
      // Async: single buffer — both read and write point to the same view (same offset)
      attrsB[attr.id] = arrA;
    } else {
      const arrB = viewOver(attr.type, buf, wasmLayout.attrWriteOffset[attr.id]!, total);
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

  // For constant boundary: ensure read attrs have a sentinel cell at index `total`
  // We extend each array by 1 with the default value
  const isAsync = updateMode === 'asynchronous';
  if (boundaryTreatment !== 'torus') {
    for (const attr of cellAttrs) {
      const oldA = attrsA[attr.id]!;
      const newA = createTypedArray(attr.type, total + 1);
      (newA as Uint8Array).set(oldA as Uint8Array);
      newA[total] = defaultValue(attr);
      attrsA[attr.id] = newA;

      if (isAsync) {
        // Async: single buffer — both point to same array
        attrsB[attr.id] = newA;
      } else {
        const oldB = attrsB[attr.id]!;
        const newB = createTypedArray(attr.type, total + 1);
        (newB as Uint8Array).set(oldB as Uint8Array);
        newB[total] = defaultValue(attr);
        attrsB[attr.id] = newB;
      }
    }
    readAttrs = attrsA;
    writeAttrs = isAsync ? attrsA : attrsB;
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
  args.push(cachedModelAttrs, colors, activeViewer, cachedIndicators, linkedResults, rngState);
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
  args.push(cachedModelAttrs, colors, activeViewer, cachedIndicators, linkedResults, rngState);
  return args;
}

/** Instantiate WASM bytes (compiled on main thread) against the current memory.
 *  Stores the resulting step function in wasmStepFn. */
function tryInstantiateWasmStep(bytes: Uint8Array | undefined): void {
  if (!bytes || bytes.length === 0 || !wasmMemory) { wasmStepFn = null; return; }
  instantiateWasmStep({ bytes, minMemoryPages: 1, viewerIds: {} }, wasmMemory).then(
    inst => { wasmStepFn = inst.step; },
    err => {
      wasmStepFn = null;
      self.postMessage({ type: 'error', message: '[wasm] instantiate failed: ' + (err?.message || err) });
    },
  );
}

function runStep(): void {
  // Phase 2B.2: when WASM mode is on AND the WASM step has been built, call
  // it instead of the JS step. The current emitted WASM step is a no-op
  // skeleton so this is only safe with a no-op model — used for end-to-end
  // wiring verification, not correctness.
  const fn = (useWasm && wasmStepFn) ? wasmStepFn : stepFn!;
  const callWasm = useWasm && wasmStepFn !== null;

  // Reset per-generation standalone indicators to defaults
  if (standalonePerGenIdx.length > 0) {
    for (const i of standalonePerGenIdx) cachedIndicators[i] = standaloneDefaults[i]!;
  }

  // Clear linked results (compiled step function will populate them)
  if (linkedDefs.length > 0) linkedResults = {};

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

  // Swap buffers (sync mode only — async uses single buffer)
  if (updateMode !== 'asynchronous') {
    const tmp = readAttrs;
    readAttrs = writeAttrs;
    writeAttrs = tmp;
  }
  generation++;
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

/** Run the Output Mapping color pass for the active viewer (if available) */
function runColorPass(): void {
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
      linkedDefs.push({
        id: ind.id,
        accumulationMode: ind.accumulationMode,
      });
    }
  }
}

function resetIndicators(): void {
  cachedIndicators.set(standaloneDefaults);
  linkedAccumulators = {};
  linkedResults = {};
}

function sendColors(): void {
  const copy = new Uint8ClampedArray(colors);
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
      useWasm = !!msg.useWasm && !!msg.wasmStepBytes && !msg.wasmStepError;
      tryInstantiateWasmStep(msg.wasmStepBytes);
      if (msg.wasmStepError && msg.useWasm) {
        self.postMessage({ type: 'error', message: '[wasm] compile failed, falling back to JS: ' + msg.wasmStepError });
      }
      writeDefaultColors();
      sendColors();
      break;
    }

    case 'step': {
      if (!stepFn) {
        self.postMessage({ type: 'error', message: 'No compiled step function.' });
        return;
      }
      activeViewer = msg.activeViewer; syncActiveViewerToMemory();
      for (let i = 0; i < msg.count; i++) runStep();
      if (!msg.skipColorPass) runColorPass();
      sendColors();
      break;
    }

    case 'paint': {
      activeViewer = msg.activeViewer; syncActiveViewerToMemory();
      const icEntry = msg.mappingId
        ? inputColorFns.find(f => f.mappingId === msg.mappingId)
        : inputColorFns[0];

      for (const c of msg.cells) {
        if (c.row < 0 || c.row >= height || c.col < 0 || c.col >= width) continue;
        const idx = c.row * width + c.col;

        if (icEntry?.fn) {
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

      // Update display: prefer Output Mapping color pass (no generation advance)
      // over legacy runStep fallback
      const hasColorPass = outputMappingFns.some(f => f.mappingId === activeViewer);
      if (hasColorPass) {
        runColorPass();
      } else if (stepFn) {
        runStep();
      } else {
        writeDefaultColors();
      }
      sendColors();
      break;
    }

    case 'randomize': {
      activeViewer = msg.activeViewer; syncActiveViewerToMemory();
      randomizeGrid();
      sendColors();
      break;
    }

    case 'reset': {
      activeViewer = msg.activeViewer; syncActiveViewerToMemory();
      resetGrid();
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
      tryInstantiateWasmStep((msg as RecompileMsg).wasmStepBytes);
      if ((msg as RecompileMsg).wasmStepError) {
        self.postMessage({ type: 'error', message: '[wasm] recompile failed, falling back to JS: ' + (msg as RecompileMsg).wasmStepError });
      }
      self.postMessage({ type: 'ready' });
      break;
    }

    case 'setUseWasm': {
      useWasm = !!msg.enabled;
      self.postMessage({ type: 'useWasmStatus', enabled: useWasm, ready: wasmStepFn !== null });
      break;
    }

    case 'updateModelAttrs': {
      for (const [key, val] of Object.entries(msg.attrs as Record<string, number>)) {
        cachedModelAttrs[key] = val;
      }
      syncModelAttrsToMemory();
      break;
    }

    case 'updateIndicators': {
      initIndicators(msg.indicators);
      break;
    }


    case 'importImage': {
      activeViewer = msg.activeViewer; syncActiveViewerToMemory();
      const icEntry = msg.mappingId
        ? inputColorFns.find(f => f.mappingId === msg.mappingId)
        : inputColorFns[0];
      if (!icEntry?.fn) break;
      const pixels = msg.pixels as Uint8ClampedArray;
      for (let idx = 0; idx < total; idx++) {
        const r = pixels[idx * 4]!;
        const g = pixels[idx * 4 + 1]!;
        const b = pixels[idx * 4 + 2]!;
        icEntry.fn(r, g, b, ...buildCellArgs(idx));
        // Copy write→read so state is visible on next step
        for (const attr of cellAttrs) {
          readAttrs[attr.id]![idx] = writeAttrs[attr.id]![idx]!;
        }
      }
      // Update display: prefer Output Mapping color pass (no generation advance)
      const hasColorPassImg = outputMappingFns.some(f => f.mappingId === activeViewer);
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

    case 'getState': {
      // Build transferable copies of all attribute arrays
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
        generation,
        width,
        height,
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
      break;
    }

    case 'loadState': {
      generation = msg.generation;
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

      // Restore model attributes
      for (const [key, val] of Object.entries(msg.modelAttrs)) {
        cachedModelAttrs[key] = val;
      }

      // Restore standalone indicators (resolve id -> idx via current standaloneIds map;
      // unknown ids in the loaded state are silently skipped, matching pre-typed-array behaviour)
      const idToIdx = new Map(standaloneIds.map(s => [s.id, s.idx] as const));
      for (const [key, val] of Object.entries(msg.indicators)) {
        const idx = idToIdx.get(key);
        if (idx !== undefined) cachedIndicators[idx] = val;
      }
      linkedAccumulators = msg.linkedAccumulators;

      // Restore order array
      if (msg.orderArray) {
        orderArray = new Int32Array(msg.orderArray);
      }

      // Rebuild neighbor indices for constant boundary sentinel
      buildNeighborIndices();

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
      if (outputMappingFns.some(f => f.mappingId === activeViewer)) {
        runColorPass();
      }
      sendColors();
      break;
    }
  }
};

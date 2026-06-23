/**
 * Web Worker for GenesisCA simulation.
 * Uses Structure of Arrays (SoA) for grid state — one typed array per attribute.
 * Pre-computes neighbor index tables for zero-cost boundary handling.
 */

import { instantiateWasmModule } from '../../modeler/vpl/compiler/wasm/compile';
import { buildFacePatternLookup, normalizeLookupTable } from '../../modeler/vpl/compiler/variegation';
import { computeMemoryLayout, type MemoryLayout, type VariegatedLayoutInputs, type LookupTableLayoutInput } from '../../modeler/vpl/compiler/wasm/layout';
import type { WebGPULayout } from '../../modeler/vpl/compiler/webgpu/layout';
import type { WebGPUEntryPoints } from '../../modeler/vpl/compiler/webgpu/compile';
import {
  createWebGPURuntime, destroyWebGPURuntime, isWebGPUAvailable, shaderHashOf,
  setupBuffersAndPipelines, uploadAttrs, uploadNeighborOffsets,
  uploadModelAttrs, uploadActiveViewer, uploadIndicators, uploadIndicatorsAt, dispatchStep,
  dispatchOutputMapping, dispatchColorPassAndPresent, presentToCanvas, readbackAttrs, readbackColors,
  readbackBatched, unpackAttrsFromReadback, unpackAttrFromReadback, resetStopFlag, seedRngState,
  setupReductionPipelines, dispatchReductions, setupDirectRender,
  dispatchInit, uploadOrientation, uploadFacePatternLookup, uploadInteractionTable,
  clearGlyphBuffersWebGPU,
  type WebGPURuntime, type ReadbackRegion,
} from './webgpuRuntime';
import { decodeReductions, gpuHandledIds, gpuHandledAttrIds } from './webgpuReduce';
import { encodeAttrValue } from '../../model/attrValueEncoding';
import { subAttrInfo, parentValueToInt } from '../../modeler/vpl/compiler/subAttribute';
import type { Attribute, CenterBasedConfig } from '../../model/types';
import { cbNum } from '../../model/centerBased';
import {
  createAgentStore, seedAgents, clearAgents, allocAgentSlot, initAgentSlot, freeAgentSlot,
  snapshotAgentsForRender, serializeAgentStore, deserializeAgentStore, buildSpatialHash,
  formBond, breakBond, hasBond, sweepStaleBonds, divideAgent,
  type AgentStore, type AgentSeedSpec, type AgentStatePayload, type AgentAttrSpec, type SpatialHash,
} from './agentEngine';

interface AttrDef {
  id: string;
  type: string;
  isModelAttribute: boolean;
  defaultValue: string;
  /** Cell attributes only: value held by out-of-grid cells when boundary
   *  is "constant". When undefined/empty, boundary sentinel uses defaultValue. */
  boundaryValue?: string;
  tagOptions?: string[];
  /** Sub-attribute schema fields. When `parentAttributeId` is set, this attribute
   *  is "only well-defined" on cells whose parent's value is in `parentValues`.
   *  Used by the async pre-scrub and the indicator aggregation guard. */
  parentAttributeId?: string;
  parentValues?: string[];
  undefinedValue?: string;
}

interface NeighborhoodDef {
  id: string;
  coords: Array<[number, number]>;
  /** 3D Grid CA: present on a 3D neighbourhood — entries are `[dr, dc, dl]`
   *  (row, col, layer offsets). When present it is the source of truth for the
   *  offset-table loop; `coords` stays populated (the 2D projection) so the
   *  stride (`coords.length`) and the 2D fallbacks still resolve. */
  coords3d?: Array<[number, number, number]>;
}

interface FacePatternDef {
  id: string;
  name: string;
  paletteId: string;
  layoutMode: 'edges' | 'edges+corners';
  faces: (string | null)[];
}
interface VariegatedPayload {
  sourceAttributeId: string;
  facePalettes: Array<{ id: string; labels: string[] }>;
  facePatterns: FacePatternDef[];
  /** Map from tagOption name → FacePattern.id. */
  facePatternAssignments: Record<string, string>;
}
interface InteractionTablePayload {
  id: string;
  /** Resolved row / column label lists for THIS table (a face palette →
   *  ['none', ...labels], or a tag attribute → its tagOptions). The flat
   *  storage is `rowLabels.length * colLabels.length` Float64Array, indexed
   *  `(rowIdx * colLabels.length + colIdx)`. Rectangular tables supported. */
  rowLabels: string[];
  colLabels: string[];
  /** Sparse `[rowLabel][colLabel] → number`. Missing entries default to 0. */
  values: Record<string, Record<string, number>>;
}

interface InitMsg {
  type: 'init';
  width: number;
  height: number;
  /** 3D Grid CA: layer count. Absent → 1 (a 2D grid, byte-identical). */
  depth?: number;
  attributes: AttrDef[];
  neighborhoods: NeighborhoodDef[];
  boundaryTreatment: string;
  updateMode: string;
  asyncScheme: string;
  stepCode: string;
  /** Optional per-cell init function source (loop-wrapped). When present, the
   *  reset handler runs it once after default values are applied and before
   *  the first color pass. */
  initCode?: string;
  inputColorCodes: Array<{ mappingId: string; code: string }>;
  outputMappingCodes: Array<{ mappingId: string; code: string }>;
  /** Variegated Cells config. Undefined / absent ⇒ feature disabled, no
   *  orientation buffer / face-pattern lookup allocated. */
  variegated?: VariegatedPayload;
  /** Interaction Table model attributes. Empty array ⇒ no tables. Each table
   *  is flattened to a Float64Array of length `(labelCount + 1)²` and stored
   *  in `cachedInteractionTables[id]`. Live-tuned via updateInteractionTable. */
  interactionTables?: InteractionTablePayload[];
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
  /** True when the model uses setCellGlyph anywhere — drives allocation of
   *  the per-cell glyph overlay regions (codes + colours) in wasmMemory. */
  hasGlyphs?: boolean;
  /** Bond-Graph Agents: when true, the worker allocates the agent engine (the
   *  co-resident agent SoA + bond store) from `centerBased`. The lattice grid
   *  is always allocated too (agents are additive on top — v1 requires a grid). */
  agents?: boolean;
  centerBased?: CenterBasedConfig;
  /** Compiled agent rule-graph functions (Bond-Graph Agents, JS-only v1).
   *  `behaviourFn` runs once per agent each generation; division/bond fns land
   *  in later PRs. Absent → agents are inert (seed + render only). */
  agentBehaviourCode?: string;
  agentInitCode?: string;
  agentDivisionCode?: string;
  agentColorViewer?: string;
  /** PR5 (C-D1): true when the agent graph reads/writes the cell field
   *  (sampleField / fieldGradient / readCellsUnder / affectCellsUnder /
   *  secreteToField). Drives the WebGPU-grid field bridge: only a field model
   *  needs the per-generation attrs CPU↔GPU readback/upload around runAgentStep
   *  (a no-field model's agent loop never touches `readAttrs`). */
  agentUsesField?: boolean;
}

interface StepMsg { type: 'step'; count: number; activeViewer: string; skipColorPass?: boolean }
interface PaintMsg {
  type: 'paint';
  /** `layer` (absent → 0) is the 3D Z coordinate; 2D paints omit it. */
  cells: Array<{ row: number; col: number; layer?: number; r: number; g: number; b: number }>;
  mappingId: string;
  activeViewer: string;
}
/** Manual Brush — runtime-only special Input Mapping. Bypasses any compiled
 *  InputColor function and writes each `sets` entry directly into
 *  `readAttrs[attrId][idx]` for every painted cell. Sub-attributes honour
 *  per-cell skip: a sub-attr write is suppressed on a cell whose effective
 *  parent value (the brush's parent value if the parent is also in `sets`,
 *  otherwise the cell's current `readAttrs[parentId][idx]`) is not in the
 *  schema-declared `parentValues`. */
interface PaintManualMsg {
  type: 'paintManual';
  cells: Array<{ row: number; col: number; layer?: number }>;
  /** Only attributes the user marked "Set". Pre-encoded by the UI using
   *  encodeAttrValue() so the worker doesn't repeat the string→number switch. */
  sets: Array<{ attrId: string; value: number }>;
  activeViewer: string;
}
interface RandomizeMsg { type: 'randomize'; activeViewer: string }
interface ResetMsg { type: 'reset'; activeViewer: string }
interface RecompileMsg { type: 'recompile'; stepCode: string; initCode?: string; inputColorCodes: Array<{ mappingId: string; code: string }>; outputMappingCodes: Array<{ mappingId: string; code: string }>; stopMessages?: string[]; updateMode: string; asyncScheme: string; wasmStepBytes?: Uint8Array; wasmStepError?: string; wasmExports?: string[]; viewerIds?: Record<string, number>; webgpuShaderCode?: string; webgpuShaderError?: string; webgpuEntryPoints?: WebGPUEntryPoints; webgpuLayout?: WebGPULayout; webgpuStopCheckInterval?: number; variegated?: VariegatedPayload; interactionTables?: InteractionTablePayload[]; agentBehaviourCode?: string; agentInitCode?: string; agentDivisionCode?: string; centerBased?: CenterBasedConfig; agentUsesField?: boolean }
interface UpdateLookupTableMsg {
  type: 'updateLookupTable';
  attrId: string;
  rowLabels: string[];
  colLabels: string[];
  values: Record<string, Record<string, number>>;
}
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
  /** Spatial X-axis (linked-only). 'rows'/'columns' turn the indicator into a
   *  live position histogram (chromatogram); absent/'generation' = time-history. */
  xAxis?: string;
  spatialBinMode?: string;
  spatialBinCount?: number;
  spatialBinSize?: number;
  /** bool/tag frequency only: subset of category values to chart (absent = all). */
  trackedValues?: string[];
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
  /** Bond-Graph Agents: the agent SoA + bond store snapshot (PR-B1). */
  agents?: AgentStatePayload;
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
  /** 3D Grid CA: target layer for the 2D stamp (absent → 0). */
  layer?: number;
  attributes: Record<string, { type: string; buffer: ArrayBuffer }>;
  /** Optional shape mask (Uint8 buffer, length w*h, row-major). When present,
   *  only cells with mask !== 0 are written — so a non-rectangular brush
   *  (circle/ring) pastes its shape and leaves the surrounding cells intact.
   *  Absent = full rectangle (the historical behaviour). */
  mask?: ArrayBuffer;
  activeViewer: string;
}
interface ClearRegionMsg {
  type: 'clearRegion';
  row: number; col: number; w: number; h: number;
  /** 3D Grid CA: target layer for the 2D stamp (absent → 0). */
  layer?: number;
  /** Optional shape mask — see WriteRegionMsg. A masked clear (Ctrl+X cut)
   *  removes only the shape's cells, matching the masked copy. */
  mask?: ArrayBuffer;
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
/** Toggle GIF recording: when enabled, the worker readbacks the colors
 *  buffer after each color pass and includes it in the stepped message so
 *  the main thread can capture frames. Restores recording functionality
 *  under WebGPU direct render (where srcCanvas's 2D context is unavailable
 *  on the main thread). Cost (the per-frame readback) is paid only while
 *  recording. */
interface SetRecordingMsg { type: 'setRecording'; enabled: boolean }
/** Late-binding canvas attach: the main thread defers transferControlToOffscreen
 *  until the WebGPU runtime is confirmed ready, so the JS-fallback period during
 *  init can still putImageData onto a regular canvas. Worker switches to direct
 *  render upon receipt. */
interface AttachCanvasMsg { type: 'attachCanvas'; canvas: OffscreenCanvas; width: number; height: number }
/** One-shot colors readback for screenshot. Under WebGPU direct render the
 *  main thread's srcCanvas is a transferred OffscreenCanvas placeholder whose
 *  2D-context APIs (getImageData, toBlob) all fail; instead it asks the worker
 *  for a fresh colors snapshot, builds an offscreen 2D canvas, and toBlob's. */
interface RequestColorsSnapshotMsg { type: 'requestColorsSnapshot'; tag?: string }
/** Inspect-cell subscription. The main thread keeps a (possibly empty) set of
 *  cell indices the user is inspecting via the Shift+LMB popup; the worker
 *  echoes attribute values back via `inspectCellsData` after every step and
 *  immediately on subscription change. Declarative (replaces the prior set). */
interface SetInspectCellsMsg { type: 'setInspectCells'; cellIdxs: number[] }
/** Defensive WebGPU repaint trigger. Main thread sends this on visibility-
 *  return so the canvas refreshes if the OffscreenCanvas was left in an
 *  unpresented state by a soft recompile that ran while the simulator was
 *  hidden (the device-swap inside startWebGPUInit can lose the visible
 *  content despite dispatching a present internally). Idempotent + cheap. */
interface RefreshDisplayMsg { type: 'refreshDisplay' }

// --- Bond-Graph Agents messages ---
/** Lay down N agents (the seed brush / Reset / headless seeding). Positions are
 *  in continuous WORLD coordinates. Overflow past maxAgents is reported back. */
interface SeedAgentsMsg {
  type: 'seedAgents';
  agents: Array<{ x: number; y: number; z?: number; radius?: number; type?: number; lineage?: number }>;
  /** PR3 seed config: per-attribute initial values (pre-encoded via
   *  encodeAttrValue, like paintManual) applied to each newly-seeded agent. */
  sets?: Array<{ attrId: string; value: number }>;
  activeViewer: string;
}
/** On-demand single-agent inspector read (NOT a fattened render snapshot). The
 *  worker replies with an `agentState` message carrying geometry/velocity/type
 *  + per-agent attribute values + the bond list. A non-live id replies null. */
interface GetAgentStateMsg { type: 'getAgentState'; id: number }
/** Move agents to new world positions (the Move brush). Writes x/y AND
 *  xNext/yNext so the next integration doesn't snap back; wraps/clamps to the
 *  world per `torus`. */
interface MoveAgentsMsg { type: 'moveAgents'; moves: Array<{ id: number; x: number; y: number; z?: number }>; torus: boolean; activeViewer: string }
/** Form many bonds at once (the Bond-paint brush). Loops formBond; idempotent
 *  (an existing bond is not duplicated). */
interface FormBondBatchMsg { type: 'formBondBatch'; pairs: Array<[number, number]>; activeViewer: string }
/** Allocate a single agent (free-list first). REJECTS + surfaces on overflow. */
interface CreateAgentMsg {
  type: 'createAgent';
  x: number; y: number; radius?: number; agentType?: number;
  activeViewer: string;
}
/** Kill the agents at the given ids (the kill brush). */
interface KillAgentsMsg { type: 'killAgents'; ids: number[]; activeViewer: string }
/** Write user attributes onto the agents at the given ids (the agent paint
 *  brush). Values pre-encoded via encodeAttrValue (like paintManual). */
interface PaintAgentsMsg {
  type: 'paintAgents';
  ids: number[];
  sets: Array<{ attrId: string; value: number }>;
  activeViewer: string;
}
/** Remove ALL agents (Reset). */
interface ClearAgentsMsg { type: 'clearAgents'; activeViewer: string }
/** AW-MEM (PR6a) DEV-only: force the AgentStore onto a WebAssembly.Memory (views
 *  at baked offsets) even for the `js` target, then re-init agents — the
 *  JS-on-views proof. */
interface SetAgentWasmBackedMsg { type: '__setAgentWasmBacked'; wasmBacked: boolean }
/** Manual glue: bond two agents (the glue brush). */
interface FormBondMsg { type: 'formBond'; a: number; b: number; activeViewer: string }
/** Manual cut: break the bond between two agents (the cut brush). */
interface BreakBondMsg { type: 'breakBond'; a: number; b: number; activeViewer: string }

type WorkerMsg = InitMsg | StepMsg | PaintMsg | PaintManualMsg | RandomizeMsg | ResetMsg | RecompileMsg | UpdateModelAttrsMsg | UpdateLookupTableMsg | ImportImageMsg | UpdateIndicatorsMsg | GetStateMsg | LoadStateMsg | ReadRegionMsg | WriteRegionMsg | ClearRegionMsg | SetUseWasmMsg | SetUseWebGPUMsg | ReadbackWebGPUMsg | ColorPassMsg | SetRecordingMsg | AttachCanvasMsg | RequestColorsSnapshotMsg | SetInspectCellsMsg | RefreshDisplayMsg | SeedAgentsMsg | CreateAgentMsg | KillAgentsMsg | PaintAgentsMsg | ClearAgentsMsg | FormBondMsg | BreakBondMsg | GetAgentStateMsg | MoveAgentsMsg | FormBondBatchMsg | SetAgentWasmBackedMsg;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let width = 0;
let height = 0;
/** 3D Grid CA: layer count along Z. 1 → a 2D grid (total = W*H, byte-identical). */
let depth = 1;
let total = 0;
let cellAttrs: AttrDef[] = [];

/** Flatten a 3D cell coordinate to its SoA index. In 2D (depth===1, layer===0)
 *  this is `row*width+col`, byte-identical to the historical 2D math. */
function cellIndexOf(layer: number, row: number, col: number): number {
  return (layer * height + row) * width + col;
}
/** 3D-aware in-bounds test for a paint/region cell. In 2D, layer 0 always passes. */
function inBounds3d(layer: number, row: number, col: number): boolean {
  return layer >= 0 && layer < depth && row >= 0 && row < height && col >= 0 && col < width;
}
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

// --- Bond-Graph Agents (co-resident agent engine; JS-only v1) ---
let agentStore: AgentStore | null = null;
let agentsEnabled = false;
/** PR5 (C-D1): true when the agent graph touches the cell field. Gates the
 *  WebGPU-grid field bridge (CPU↔GPU attrs readback/upload around runAgentStep).
 *  A no-field model leaves it false → 0 per-step readbacks. */
let agentUsesField = false;
let centerBasedConfig: CenterBasedConfig | null = null;
/** Compiled agent behaviour function (runs once per agent each generation).
 *  Null until the agent compile path ships it (PR-A2.5/A3). */
let agentBehaviourFn: Function | null = null;
let agentInitFn: Function | null = null;
/** The current-step spatial hash, built BEFORE the behaviour fn so Get Nearby
 *  Agents can query it, then reused by the force pass. Null for a tiny world. */
let currentAgentHash: SpatialHash | null = null;
const EMPTY_I32 = new Int32Array(0);
/** Compiled Division Event function (single-agent; runs per daughter after a
 *  division). Null when the agent graph has no divisionEvent root. */
let agentDivisionFn: Function | null = null;
let agentColorViewer = '';

/** AW-MEM (PR6a) — DEV-only override that forces the AgentStore onto a
 *  WebAssembly.Memory (views at baked offsets) even for the `js` target, so the
 *  JS-on-views PROOF can run before any WASM emit (PR6b). Set via the
 *  `__setAgentWasmBacked` DEV message (then re-init). Off in production — the
 *  default JS-default path is plain typed arrays. PR6b sets `wasmBacked` from
 *  `agentTargetOf === 'wasm'` instead of this flag. */
let agentWasmBackedDev = false;

/** Build the agent attribute specs (the non-model cell attributes double as
 *  per-agent attributes via D-IDX) with their resolved default values. */
function buildAgentAttrSpecs(): AgentAttrSpec[] {
  return cellAttrs.map(a => ({ id: a.id, type: a.type, defaultValue: defaultValue(a) }));
}

/** Allocate (or re-allocate) the agent store from the current config + attrs.
 *  Called on init when the model has the Agents topology. Seeds the configured
 *  initial agent count. */
function initAgents(): void {
  if (!agentsEnabled || !centerBasedConfig) { agentStore = null; return; }
  // AW-MEM (PR6a): the DEV proof can force the store onto a WebAssembly.Memory
  // (views at baked offsets) for the `js` target to prove the relocation is
  // behaviour-identical. PR6b sets this from `agentTargetOf === 'wasm'`.
  agentStore = createAgentStore(centerBasedConfig, buildAgentAttrSpecs(), { wasmBacked: agentWasmBackedDev });
  // The agent world IS the grid coordinate frame (1:1, Decision D-FIELD): agent
  // (x,y) are in CELL units so they map onto the grid + the screen with the same
  // transform the cell blit uses. (worldWidth/Height in the config are reserved
  // for a future agents-only model where there's no grid to define the frame.)
  agentStore.worldWidth = width;
  agentStore.worldHeight = height;
  // The agent world depth IS the grid `depth` (1:1, B2) — the SAME local the grid
  // derives (`= dimension==='3d' ? max(1,gridDepth) : 1`). This is the engine's
  // single 3D predicate: `store.worldDepth > 1 ⟺ is3dModel(model)`. Do NOT read
  // the dormant config.worldDepth (S6) — that would reintroduce the desync B2 warns of.
  agentStore.worldDepth = depth;
  const seedCount = Math.max(0, Math.floor(cbNum(centerBasedConfig, 'seedCount')));
  if (seedCount > 0) {
    const r = cbNum(centerBasedConfig, 'defaultRadius');
    const ww = agentStore.worldWidth, wh = agentStore.worldHeight;
    const is3d = agentStore.worldDepth > 1, D = agentStore.worldDepth;
    const specs: AgentSeedSpec[] = [];
    if (centerBasedConfig.seedPattern === 'scatter') {
      // Dispersed: uniformly random across the world (flocking, chemotaxis
      // aggregation — populations that START spread and self-organize). Seeding
      // is a one-time setup, not part of the replayable step, so Math.random is
      // fine here (unlike the deterministic per-step xorshift stream).
      const margin = 2 * r;
      const sx = Math.max(0, ww - 2 * margin), sy = Math.max(0, wh - 2 * margin);
      if (is3d) {
        const sz = Math.max(0, D - 2 * margin);
        for (let i = 0; i < seedCount; i++) {
          specs.push({ x: margin + Math.random() * sx, y: margin + Math.random() * sy, z: margin + Math.random() * sz, radius: r });
        }
      } else {
        for (let i = 0; i < seedCount; i++) {
          specs.push({ x: margin + Math.random() * sx, y: margin + Math.random() * sy, radius: r });
        }
      }
    } else if (is3d) {
      // 3D compact = a sphere-clipped cubic lattice centred on the world (the
      // morphogenesis starting blob, the analog of the 2D centred square). Build
      // a cubic lattice (OVERSIZED to side+1 per F2 so the ball-clip still leaves
      // ≥ seedCount candidates), clip to a ball, sort by distance-to-centre, take
      // the nearest seedCount.
      const spacing = 2.1 * r;
      const side = Math.max(1, Math.ceil(Math.cbrt(seedCount)) + 1); // F2 oversize
      const cx = ww / 2, cy = wh / 2, cz = D / 2;
      const half = (side - 1) / 2;
      const cand: Array<{ x: number; y: number; z: number; d2: number }> = [];
      for (let lz = 0; lz < side; lz++) for (let ly = 0; ly < side; ly++) for (let lx = 0; lx < side; lx++) {
        const px = cx + (lx - half) * spacing;
        const py = cy + (ly - half) * spacing;
        const pz = cz + (lz - half) * spacing;
        const ddx = px - cx, ddy = py - cy, ddz = pz - cz;
        const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
        cand.push({ x: px, y: py, z: pz, d2 });
      }
      cand.sort((u, v) => u.d2 - v.d2);
      for (let i = 0; i < seedCount && i < cand.length; i++) {
        const c = cand[i]!;
        specs.push({ x: c.x, y: c.y, z: c.z, radius: r });
      }
    } else {
      // A compact, centred cluster (spacing just above contact, so the agents
      // settle into a packed blob and auto-bond into a tissue) — the
      // morphogenesis starting point.
      const spacing = 2.1 * r;
      const cols = Math.max(1, Math.ceil(Math.sqrt(seedCount)));
      const blockW = (cols - 1) * spacing;
      const rows = Math.ceil(seedCount / cols);
      const blockH = (rows - 1) * spacing;
      const ox = ww / 2 - blockW / 2, oy = wh / 2 - blockH / 2;
      for (let i = 0; i < seedCount; i++) {
        specs.push({ x: ox + (i % cols) * spacing, y: oy + Math.floor(i / cols) * spacing, radius: r });
      }
    }
    seedAgents(agentStore, specs, r);
  }
  clampAgentDt();
}

/** Refresh per-agent colours after a mutation (seed / paint / kill) without
 *  advancing the simulation. Agent colours are written by the behaviourStep's
 *  Set Cell Looks during a step; between steps a freshly-seeded agent shows its
 *  default-palette colour (set on slot init) until the next step recolours it.
 *  So this is intentionally a no-op (running the behaviour fn here would advance
 *  the rule + force the position double-buffer). */
function runAgentColorPass(): void {
  void agentColorViewer;
}

/** Write per-attribute values onto one agent (read + write buffers). Shared by
 *  the paintAgents handler and the seedAgents `sets` post-init loop. Values are
 *  pre-encoded numerics (encodeAttrValue UI-side, like paintManual). */
function applyAgentSets(store: AgentStore, id: number, sets: Array<{ attrId: string; value: number }>): void {
  if (id < 0 || id >= store.highWater || !store.alive[id]) return;
  for (const s of sets) {
    const r = store.attrRead[s.attrId]; const w = store.attrWrite[s.attrId];
    if (r) r[id] = s.value;
    if (w) w[id] = s.value;
  }
}

/** Run the agent Init Event once per seeded agent on Reset. v1 has no agent
 *  Init Event root (agents init to their attribute defaults on seed), so this
 *  is a no-op placeholder. */
function runAgentInit(): void {
  void agentInitFn;
}

/** Run the Division Event graph per daughter so the user can reassign daughter
 *  attributes (asymmetric inheritance). Daughters already inherited the mother's
 *  attributes VERBATIM in `divideAgent` (daughter A reuses the mother slot, so
 *  its attrs ARE the mother's; daughter B was copied), so a divisionEvent like
 *  "daughter 0: energy = energy·0.7" reads the inherited value and rewrites it.
 *  daughterIndex 0 = A (the reused mother slot), 1 = B (the new slot).
 *
 *  ABI note (z-axis): the divisionEvent's `axisDefaultZ` value-out rides the
 *  `s.divideAxisZ` BUFFER arg (stamped onto both daughters at the division site,
 *  sim.worker.ts ~:1004), NOT a scalar — unlike `axisX`/`axisY`, which ARE passed
 *  as the scalar args below. Keep that asymmetry in mind when editing the ABI. */
function runDivisionEvent(events: Array<{ mother: number; a: number; b: number; axisX: number; axisY: number }>): void {
  if (!agentDivisionFn || !agentStore) return;
  const fn = agentDivisionFn;
  const s = agentStore;
  for (const ev of events) {
    try {
      fn(...buildDivisionArgs(s, ev.a, 0, ev.axisX, ev.axisY));
      fn(...buildDivisionArgs(s, ev.b, 1, ev.axisX, ev.axisY));
    } catch (e) {
      self.postMessage({ type: 'error', message: '[agents] division event failed: ' + ((e as Error)?.message || e) });
      agentDivisionFn = null;
      break;
    }
  }
}

/** Args for the compiled divisionEvent function — a SINGLE-agent function (not
 *  loop-wrapped): the daughter slot `idx`, its `daughterIndex` (0/1), the engine
 *  axis defaults, then the same engine buffers + user attrs the behaviour fn
 *  gets. MIRRORS `buildDivisionParams` in compile.ts.
 *
 *  MIRROR invariant (B1/B2): the trailing 3D block (`s.z, s.vz, s.divideAxisZ,
 *  s.worldDepth` — NO `forceZ`, division is force-read-only) is pushed ONLY when
 *  `s.worldDepth > 1`, exactly when `buildDivisionParams` pushes its 3D params
 *  under `is3dModel(model)`. `is3dModel(model) ⟺ s.worldDepth > 1` — edit BOTH
 *  together or every arg shifts one slot. */
function buildDivisionArgs(s: AgentStore, idx: number, daughterIndex: number, axisX: number, axisY: number): unknown[] {
  const args: unknown[] = [
    idx, daughterIndex, axisX, axisY,
    // MIRRORS buildDivisionParams — engine buffers agent-read nodes need to be
    // division-safe (C-T1): liveness + geometry + velocity + bond store + field.
    s.alive, s.highWater,
    s.x, s.y, s.radius, s.targetRadius, s.age, s.type, s.lineage, s.bondCount, s.density,
    s.vx, s.vy,
    s.bondPartner, s.maxBonds,
  ];
  for (const spec of s.attrSpecs) args.push(s.attrRead[spec.id]);
  for (const spec of s.attrSpecs) args.push(s.attrWrite[spec.id]);
  args.push(cachedModelAttrs, s.colors, activeViewer, cachedIndicators, rngState, stopFlag, GLYPH_NOOP_CODES, GLYPH_NOOP_COLORS);
  // Closed feedback: the CELL field arrays + grid dims (same as buildAgentLoopArgs).
  args.push(width, height, total, boundaryTreatment === 'torus' ? 1 : 0);
  for (const spec of s.attrSpecs) args.push(readAttrs[spec.id]);
  // Trailing 3D block (B1) — pushed ONLY when 3D (NO forceZ; division reads
  // forces, never writes them). MIRRORS buildDivisionParams's `is3d` block.
  if (s.worldDepth > 1) args.push(s.z, s.vz, s.divideAxisZ, s.worldDepth);
  return args;
}

/** Build the args for the compiled behaviourStep function. MIRRORS
 *  `buildAgentLoopParams` in compile.ts EXACTLY (same order). Single-buffer
 *  agent attrs (attrWrite aliases attrRead). Called once per step (the spread
 *  is fine — the function is loop-wrapped, not per-agent).
 *
 *  MIRROR invariant (B1/B2): the trailing 3D block (`s.z, s.vz, s.forceZ,
 *  s.divideAxisZ, s.worldDepth`) is pushed ONLY when `s.worldDepth > 1`, exactly
 *  when `buildAgentLoopParams` pushes its 3D params under `is3dModel(model)`.
 *  `is3dModel(model) ⟺ s.worldDepth > 1` — edit BOTH together. */
function buildAgentLoopArgs(s: AgentStore): unknown[] {
  const hash = currentAgentHash;
  const args: unknown[] = [
    s.alive, s.highWater,
    s.x, s.y, s.radius, s.targetRadius, s.age, s.type, s.lineage, s.bondCount, s.density,
    s.vx, s.vy, s.forceX, s.forceY,
    // spatial hash (null → _hashValid 0, the emit falls back to all-pairs)
    hash ? 1 : 0,
    hash ? hash.binStart : EMPTY_I32, hash ? hash.binAgents : EMPTY_I32,
    hash ? hash.nBinsX : 0, hash ? hash.nBinsY : 0, hash ? hash.binSizeX : 1, hash ? hash.binSizeY : 1,
    s.divideRequest, s.divideAxisX, s.divideAxisY, s.divideAsym, s.killRequest,
    s.bondPartner, s.bondPartnerEpoch, s.bondRestLength, s.bondStiffness, s.bondTypeLabel, s.maxBonds,
    s.bondFormReq, s.bondFormL, s.bondFormK, s.bondBreakReq,
  ];
  for (const spec of s.attrSpecs) args.push(s.attrRead[spec.id]);
  for (const spec of s.attrSpecs) args.push(s.attrWrite[spec.id]);
  args.push(cachedModelAttrs, s.colors, activeViewer, cachedIndicators, rngState, stopFlag, GLYPH_NOOP_CODES, GLYPH_NOOP_COLORS);
  // Closed feedback (Phase D): the cell field arrays (readAttrs[id] = the CELL
  // SoA sized total, distinct from the agent attrRead) + the field grid dims.
  args.push(width, height, total, boundaryTreatment === 'torus' ? 1 : 0);
  for (const spec of s.attrSpecs) args.push(readAttrs[spec.id]);
  // Trailing 3D block (B1) — pushed ONLY when 3D. MIRRORS buildAgentLoopParams's
  // `is3d` block (z, vz, forceZ, divideAxisZ, worldDepth).
  if (s.worldDepth > 1) args.push(s.z, s.vz, s.forceZ, s.divideAxisZ, s.worldDepth);
  return args;
}

/** Re-derive the clamped force-integration timestep from the live config.
 *  Mathias-2020 monotonicity bound: for a linear spring `F = μ(d−s)`,
 *  `Δt*_mono = 1/(2·μ_eff)`, so `Δt ← min(Δt_user, 0.4·Δt*_mono) = 0.2/μ_eff`
 *  with `μ_eff = μ_R + λ_max`. Must be re-evaluated on any force / bond-λ
 *  parameter change (the silent-drift hazard). */
function clampAgentDt(): void {
  if (!agentStore || !centerBasedConfig) return;
  const muR = cbNum(centerBasedConfig, 'repulsionStiffness');
  const lambda = cbNum(centerBasedConfig, 'bondStiffness');
  const muEff = Math.max(1e-6, muR + lambda);
  agentStore.dt = Math.min(cbNum(centerBasedConfig, 'timeStep'), 0.2 / muEff);
}

/** Commit the position double-buffer (x ↔ xNext, y ↔ yNext, and z ↔ zNext in
 *  3D). ROUTED through this ONE helper (S11) so the reference-swap→copy-into
 *  conversion (B10/AW-SWAP) lives in a single function.
 *
 *  AW-SWAP (B10): under a wasmMemory-backed store the SoA arrays are VIEWS at
 *  baked offsets, so a reference swap (`s.x = s.xNext`) would orphan the
 *  WASM-baked `agentX` offset from the JS reference. There we COPY-INTO
 *  (`x.set(xNext)`) so `agentX` stays at a stable offset. The copy is safe
 *  because the next step's force loop fully overwrites the whole live xNext
 *  region (alive AND dead branches both write `xN[i]`) before any read of x.
 *  For the default (plain-array) store the cheap reference swap is kept. */
function swapPositions(s: AgentStore, is3d: boolean): void {
  if (s.wasmBacked) {
    s.x.set(s.xNext); s.y.set(s.yNext);
    if (is3d) s.z.set(s.zNext);
    return;
  }
  const tmpX = s.x; s.x = s.xNext; s.xNext = tmpX;
  const tmpY = s.y; s.y = s.yNext; s.yNext = tmpY;
  if (is3d) { const tmpZ = s.z; s.z = s.zNext; s.zNext = tmpZ; }
}

/** One agent generation: density reductions → compiled behaviour → engine force
 *  integration (soft-sphere repulsion + bond springs, overdamped Euler with a
 *  synchronous position double-buffer) → world-bounds wrap/clamp → age. The
 *  structural phase (division / growth / death) lands in Phase C. v1 uses the
 *  literature-sanctioned all-pairs O(N²) force loop (the JS/Debug-Reference
 *  first build); a uniform spatial hash is the Phase F performance path. */
function runAgentStep(): void {
  const s = agentStore;
  if (!s) return;
  const cfg = centerBasedConfig;
  const muR = cbNum(cfg, 'repulsionStiffness');
  const muA = cbNum(cfg, 'adhesionStiffness');
  const range = cbNum(cfg, 'interactionRange');
  const eta = Math.max(1e-6, cbNum(cfg, 'drag'));
  const torus = boundaryTreatment === 'torus';   // z wraps iff x/y wrap (B7/C1 — ONE flag, all 3 axes)
  const W = s.worldWidth, H = s.worldHeight;
  const halfW = W / 2, halfH = H / 2;
  const is3d = s.worldDepth > 1, D = s.worldDepth, halfD = D / 2;
  const dt = s.dt;
  const growthRate = Math.max(0, cbNum(cfg, 'growthRate'));
  const hw = s.highWater;
  const x = s.x, y = s.y, z = s.z, rad = s.radius, alive = s.alive;
  const maxBonds = s.maxBonds;
  const momentum = Math.max(0, Math.min(0.999, cbNum(cfg, 'momentum')));
  const maxSpeed = Math.max(0, cbNum(cfg, 'maxSpeed'));
  const engineForces = !cfg?.customForcesOnly;

  // Reset the per-step force accumulator (Apply Force adds into it during
  // behaviour) BEFORE behaviour runs. forceZ is a memset of an always-zero-in-2D
  // array — byte-irrelevant for 2D, used by the 3D arm.
  s.forceX.fill(0, 0, hw); s.forceY.fill(0, 0, hw); s.forceZ.fill(0, 0, hw);

  // Build the uniform spatial hash from current positions — O(N) neighbour
  // lookups instead of O(N²). Built BEFORE behaviour so Get Nearby Agents can
  // query it, then reused by the force pass. null for a world too small to tile
  // (≥3 bins/axis); the all-pairs fallback runs there. The interaction range OR
  // a larger Get-Nearby query radius sets the bin edge — sized generously so the
  // 3×3 stencil covers both the soft-sphere cutoff AND typical neighbour queries.
  let maxR = cbNum(cfg, 'defaultRadius');
  for (let i = 0; i < hw; i++) { if (alive[i] && rad[i]! > maxR) maxR = rad[i]!; }
  const binEdge = Math.max(range * 2 * maxR, cbNum(cfg, 'neighbourQueryRadius'));
  const hash = buildSpatialHash(s, Math.max(1e-3, binEdge), W, H, D);
  currentAgentHash = hash;

  // Compiled behaviour (reads positions + the PREVIOUS step's density — a
  // one-step lag, the cost of fusing density into the single neighbour pass;
  // densities change slowly so it's a fine approximation; queries the hash via
  // Get Nearby Agents). Writes attrs / colours / forces / div+kill+bond requests.
  if (agentBehaviourFn) {
    try {
      agentBehaviourFn(...buildAgentLoopArgs(s));
    } catch (e) {
      self.postMessage({ type: 'error', message: '[agents] behaviour run failed: ' + ((e as Error)?.message || e) });
      agentBehaviourFn = null;
    }
  }

  // Single neighbour pass: graph-authored force (forceX/Y[/Z] from Apply Force) +
  // soft-sphere repulsion/adhesion (unless customForcesOnly) + bond springs +
  // density (for next step), integrated into the xNext/yNext[/zNext] double-buffer.
  // Branched on `is3d` ONCE (not per-line): the 2D else-branch is the EXACT
  // current code, verbatim (the grid's literal-verbatim-2D-fast-path lesson — a
  // branchless always-0-dz body would change the 2D arithmetic + stencil count).
  if (is3d) {
    const xN = s.xNext, yN = s.yNext, zN = s.zNext;
    const vxArr = s.vx, vyArr = s.vy, vzArr = s.vz;
    for (let i = 0; i < hw; i++) {
      if (!alive[i]) { xN[i] = x[i]!; yN[i] = y[i]!; zN[i] = z[i]!; continue; }
      const xi = x[i]!, yi = y[i]!, zi = z[i]!, ri = rad[i]!;
      let fx = s.forceX[i]!, fy = s.forceY[i]!, fz = s.forceZ[i]!, dens = 0;

      // --- neighbour pass: 3×3×3 stencil over the z-major hash, torus-wrapped ---
      if (hash) {
        const nBinsX = hash.nBinsX, nBinsY = hash.nBinsY, nBinsZ = hash.nBinsZ;
        const binStart = hash.binStart, binAgents = hash.binAgents;
        let bx = (xi / hash.binSizeX) | 0; if (bx < 0) bx = 0; else if (bx >= nBinsX) bx = nBinsX - 1;
        let by = (yi / hash.binSizeY) | 0; if (by < 0) by = 0; else if (by >= nBinsY) by = nBinsY - 1;
        let bz = (zi / hash.binSizeZ) | 0; if (bz < 0) bz = 0; else if (bz >= nBinsZ) bz = nBinsZ - 1;
        for (let ddz = -1; ddz <= 1; ddz++) {
          for (let ddy = -1; ddy <= 1; ddy++) {
            for (let ddx = -1; ddx <= 1; ddx++) {
              let nbx = bx + ddx, nby = by + ddy, nbz = bz + ddz;
              if (torus) { nbx = ((nbx % nBinsX) + nBinsX) % nBinsX; nby = ((nby % nBinsY) + nBinsY) % nBinsY; nbz = ((nbz % nBinsZ) + nBinsZ) % nBinsZ; }
              else { if (nbx < 0 || nbx >= nBinsX || nby < 0 || nby >= nBinsY || nbz < 0 || nbz >= nBinsZ) continue; }
              const b = (nbz * nBinsY + nby) * nBinsX + nbx;
              const end = binStart[b + 1]!;
              for (let p = binStart[b]!; p < end; p++) {
                const j = binAgents[p]!;
                if (j === i) continue;
                let dx = x[j]! - xi, dy = y[j]! - yi, dz = z[j]! - zi;
                if (torus) {
                  if (dx > halfW) dx -= W; else if (dx < -halfW) dx += W;
                  if (dy > halfH) dy -= H; else if (dy < -halfH) dy += H;
                  if (dz > halfD) dz -= D; else if (dz < -halfD) dz += D;
                }
                const d2 = dx * dx + dy * dy + dz * dz;
                const sij = ri + rad[j]!;
                const rmax = range * sij;
                if (d2 === 0 || d2 >= rmax * rmax) continue;
                dens++;
                if (engineForces) {
                  const d = Math.sqrt(d2);
                  const F = ((d < sij) ? muR : muA) * (d - sij);
                  const k = F / d;
                  fx += k * dx; fy += k * dy; fz += k * dz;
                }
              }
            }
          }
        }
      } else {
        for (let j = 0; j < hw; j++) {
          if (j === i || !alive[j]) continue;
          let dx = x[j]! - xi, dy = y[j]! - yi, dz = z[j]! - zi;
          if (torus) {
            if (dx > halfW) dx -= W; else if (dx < -halfW) dx += W;
            if (dy > halfH) dy -= H; else if (dy < -halfH) dy += H;
            if (dz > halfD) dz -= D; else if (dz < -halfD) dz += D;
          }
          const d2 = dx * dx + dy * dy + dz * dz;
          const sij = ri + rad[j]!;
          const rmax = range * sij;
          if (d2 === 0 || d2 >= rmax * rmax) continue;
          dens++;
          if (engineForces) {
            const d = Math.sqrt(d2);
            const F = ((d < sij) ? muR : muA) * (d - sij);
            const k = F / d;
            fx += k * dx; fy += k * dy; fz += k * dz;
          }
        }
      }
      s.density[i] = dens;

      // --- bond springs λ(l−L)·r̂ over the 3-vector (dangling-bond epoch ABI) ---
      const bc = s.bondCount[i]!;
      if (bc > 0) {
        const base = i * maxBonds;
        for (let bk = 0; bk < bc; bk++) {
          const p = s.bondPartner[base + bk]!;
          if (p < 0 || p >= hw || !alive[p]) continue;
          if (s.bondPartnerEpoch[base + bk] !== s.epoch[p]) continue;
          let dx = x[p]! - xi, dy = y[p]! - yi, dz = z[p]! - zi;
          if (torus) {
            if (dx > halfW) dx -= W; else if (dx < -halfW) dx += W;
            if (dy > halfH) dy -= H; else if (dy < -halfH) dy += H;
            if (dz > halfD) dz -= D; else if (dz < -halfD) dz += D;
          }
          const d2b = dx * dx + dy * dy + dz * dz;
          if (d2b === 0) continue;
          const d = Math.sqrt(d2b);
          const F = s.bondStiffness[base + bk]! * (d - s.bondRestLength[base + bk]!);
          const k = F / d;
          fx += k * dx; fy += k * dy; fz += k * dz;
        }
      }

      // Integrate (3-vector); momentum 0 ⇒ overdamped; optional 3D-speed cap.
      let vxi = momentum * vxArr[i]! + (dt / eta) * fx;
      let vyi = momentum * vyArr[i]! + (dt / eta) * fy;
      let vzi = momentum * vzArr[i]! + (dt / eta) * fz;
      if (maxSpeed > 0) {
        const sp = Math.sqrt(vxi * vxi + vyi * vyi + vzi * vzi);
        if (sp > maxSpeed) { const sc = maxSpeed / sp; vxi *= sc; vyi *= sc; vzi *= sc; }
      }
      vxArr[i] = vxi; vyArr[i] = vyi; vzArr[i] = vzi;
      let nx = xi + vxi, ny = yi + vyi, nz = zi + vzi;
      if (torus) { nx = ((nx % W) + W) % W; ny = ((ny % H) + H) % H; nz = ((nz % D) + D) % D; }
      else { nx = nx < 0 ? 0 : nx > W ? W : nx; ny = ny < 0 ? 0 : ny > H ? H : ny; nz = nz < 0 ? 0 : nz > D ? D : nz; }
      xN[i] = nx; yN[i] = ny; zN[i] = nz;
      s.age[i] = s.age[i]! + 1;
      const tr = s.targetRadius[i]!;
      const cur = s.radius[i]!;
      if (tr !== cur) {
        const dd = tr - cur;
        s.radius[i] = Math.abs(dd) <= growthRate ? tr : cur + Math.sign(dd) * growthRate;
      }
    }
  } else {
    const xN = s.xNext, yN = s.yNext;
    const vxArr = s.vx, vyArr = s.vy;
    for (let i = 0; i < hw; i++) {
      if (!alive[i]) { xN[i] = x[i]!; yN[i] = y[i]!; continue; }
      const xi = x[i]!, yi = y[i]!, ri = rad[i]!;
      // Start from the graph-authored force (Apply Force wrote it this step).
      let fx = s.forceX[i]!, fy = s.forceY[i]!, dens = 0;

      // --- neighbour pass: always counts density; applies soft-sphere force only
      // when engineForces (customForcesOnly skips the built-in repulsion) ---
      if (hash) {
        const nBinsX = hash.nBinsX, nBinsY = hash.nBinsY;
        const binStart = hash.binStart, binAgents = hash.binAgents;
        let bx = (xi / hash.binSizeX) | 0; if (bx < 0) bx = 0; else if (bx >= nBinsX) bx = nBinsX - 1;
        let by = (yi / hash.binSizeY) | 0; if (by < 0) by = 0; else if (by >= nBinsY) by = nBinsY - 1;
        for (let ddy = -1; ddy <= 1; ddy++) {
          for (let ddx = -1; ddx <= 1; ddx++) {
            let nbx = bx + ddx, nby = by + ddy;
            if (torus) { nbx = ((nbx % nBinsX) + nBinsX) % nBinsX; nby = ((nby % nBinsY) + nBinsY) % nBinsY; }
            else { if (nbx < 0 || nbx >= nBinsX || nby < 0 || nby >= nBinsY) continue; }
            const b = nby * nBinsX + nbx;
            const end = binStart[b + 1]!;
            for (let p = binStart[b]!; p < end; p++) {
              const j = binAgents[p]!;
              if (j === i) continue;
              let dx = x[j]! - xi, dy = y[j]! - yi;
              if (torus) { if (dx > halfW) dx -= W; else if (dx < -halfW) dx += W; if (dy > halfH) dy -= H; else if (dy < -halfH) dy += H; }
              const d2 = dx * dx + dy * dy;
              const sij = ri + rad[j]!;
              const rmax = range * sij;
              if (d2 === 0 || d2 >= rmax * rmax) continue;
              dens++;
              if (engineForces) {
                const d = Math.sqrt(d2);
                const F = ((d < sij) ? muR : muA) * (d - sij);
                const k = F / d;
                fx += k * dx; fy += k * dy;
              }
            }
          }
        }
      } else {
        for (let j = 0; j < hw; j++) {
          if (j === i || !alive[j]) continue;
          let dx = x[j]! - xi, dy = y[j]! - yi;
          if (torus) { if (dx > halfW) dx -= W; else if (dx < -halfW) dx += W; if (dy > halfH) dy -= H; else if (dy < -halfH) dy += H; }
          const d2 = dx * dx + dy * dy;
          const sij = ri + rad[j]!;
          const rmax = range * sij;
          if (d2 === 0 || d2 >= rmax * rmax) continue;
          dens++;
          if (engineForces) {
            const d = Math.sqrt(d2);
            const F = ((d < sij) ? muR : muA) * (d - sij);
            const k = F / d;
            fx += k * dx; fy += k * dy;
          }
        }
      }
      s.density[i] = dens;

      // --- bond springs λ(l−L)·r̂ (no-op until bonds exist). The partnerEpoch
      // check is the dangling-bond ABI — a recycled slot's stale bond reads
      // epoch-mismatch and is skipped. ---
      const bc = s.bondCount[i]!;
      if (bc > 0) {
        const base = i * maxBonds;
        for (let bk = 0; bk < bc; bk++) {
          const p = s.bondPartner[base + bk]!;
          if (p < 0 || p >= hw || !alive[p]) continue;
          if (s.bondPartnerEpoch[base + bk] !== s.epoch[p]) continue;
          let dx = x[p]! - xi, dy = y[p]! - yi;
          if (torus) { if (dx > halfW) dx -= W; else if (dx < -halfW) dx += W; if (dy > halfH) dy -= H; else if (dy < -halfH) dy += H; }
          const d2b = dx * dx + dy * dy;
          if (d2b === 0) continue;
          const d = Math.sqrt(d2b);
          const F = s.bondStiffness[base + bk]! * (d - s.bondRestLength[base + bk]!);
          const k = F / d;
          fx += k * dx; fy += k * dy;
        }
      }

      // Integrate: velocity = momentum·velocity + (Δt/η)·force; position += velocity.
      // momentum 0 ⇒ vx = (Δt/η)·fx, the original overdamped step (byte-identical
      // for tissue); momentum > 0 carries inertia (flocking). Optional speed cap.
      let vxi = momentum * vxArr[i]! + (dt / eta) * fx;
      let vyi = momentum * vyArr[i]! + (dt / eta) * fy;
      if (maxSpeed > 0) {
        const sp = Math.sqrt(vxi * vxi + vyi * vyi);
        if (sp > maxSpeed) { const sc = maxSpeed / sp; vxi *= sc; vyi *= sc; }
      }
      vxArr[i] = vxi; vyArr[i] = vyi;
      let nx = xi + vxi;
      let ny = yi + vyi;
      if (torus) { nx = ((nx % W) + W) % W; ny = ((ny % H) + H) % H; }
      else { nx = nx < 0 ? 0 : nx > W ? W : nx; ny = ny < 0 ? 0 : ny > H ? H : ny; }
      xN[i] = nx; yN[i] = ny;
      s.age[i] = s.age[i]! + 1;
      // Growth: ramp radius toward the target set by Set Target Radius.
      const tr = s.targetRadius[i]!;
      const cur = s.radius[i]!;
      if (tr !== cur) {
        const dd = tr - cur;
        s.radius[i] = Math.abs(dd) <= growthRate ? tr : cur + Math.sign(dd) * growthRate;
      }
    }
  }
  // Commit positions (synchronous double-buffer swap; S11 helper — z swapped in 3D).
  swapPositions(s, is3d);

  // Post-step structural phase: bond form/break (Phase B), division + growth +
  // death (Phase C). Mutates the bond/agent topology on the SETTLED state.
  runAgentStructuralPhase();
}

/** Post-step structural phase — the only place the bond / agent topology is
 *  mutated (Decision: mutate on the settled state, never mid-force-loop). Bond
 *  form/break requests (FormBond / BreakBond) → auto-bond by distance (with
 *  hysteresis) → stale-bond sweep → [division + death land in Phase C]. */
function runAgentStructuralPhase(): void {
  const s = agentStore;
  if (!s) return;
  const cfg = centerBasedConfig;
  const torus = boundaryTreatment === 'torus';
  const W = s.worldWidth, H = s.worldHeight, halfW = W / 2, halfH = H / 2;
  const is3d = s.worldDepth > 1, D = s.worldDepth;
  const hw = s.highWater;
  const x = s.x, y = s.y, rad = s.radius, alive = s.alive;
  const lambda = cbNum(cfg, 'bondStiffness');

  // 1. Apply explicit bond requests written by FormBond / BreakBond this step.
  for (let i = 0; i < hw; i++) {
    if (!alive[i]) { s.bondFormReq[i] = 0; s.bondBreakReq[i] = 0; continue; }
    const fr = s.bondFormReq[i]!;
    if (fr > 0) {
      const p = fr - 1;
      if (p >= 0 && p < hw && alive[p]) {
        const L = s.bondFormL[i]! > 0 ? s.bondFormL[i]! : (rad[i]! + rad[p]!);
        const K = s.bondFormK[i]! > 0 ? s.bondFormK[i]! : lambda;
        formBond(s, i, p, L, K);
      }
      s.bondFormReq[i] = 0;
    }
    const br = s.bondBreakReq[i]!;
    if (br > 0) { breakBond(s, i, br - 1); s.bondBreakReq[i] = 0; }
  }

  // 1b. Death — recycle killed agents (breaks all bonds + bumps the epoch).
  for (let i = 0; i < hw; i++) {
    if (alive[i] && s.killRequest[i]) freeAgentSlot(s, i);
  }

  // 1c. Division — split flagged agents along their tension axis. Iterate only
  //     the pre-division population (the daughters land beyond `hw` and aren't
  //     re-divided this step). Overflow rejects the WHOLE division + surfaces a
  //     one-shot notice. The divisionEvent graph (if any) reassigns daughter
  //     attributes; collect (mother, daughterA, daughterB) for it.
  const divideEvents: Array<{ mother: number; a: number; b: number; axisX: number; axisY: number }> = [];
  let divideOverflow = false;
  const outAxis: number[] = [0, 0, 0];
  for (let i = 0; i < hw; i++) {
    if (!alive[i] || !s.divideRequest[i]) continue;
    const axisX = s.divideAxisX[i]!, axisY = s.divideAxisY[i]!;
    // z component of the requested axis (0 in 2D — divideAxisZ is 2D-ZERO).
    const axisZ = is3d ? s.divideAxisZ[i]! : 0;
    const asym = s.divideAsym[i]! || 0.5;
    s.divideRequest[i] = 0;
    const newId = divideAgent(s, i, axisX, axisY, axisZ, asym, lambda, torus, W, H, D, outAxis);
    if (newId < 0) { divideOverflow = true; continue; }
    // Stamp the RESOLVED axis (engine eigensolve or the explicit override) onto
    // both daughters so the divisionEvent's `divideAxisZ` buffer reads it (3D).
    if (is3d) { s.divideAxisZ[i] = outAxis[2]!; s.divideAxisZ[newId] = outAxis[2]!; }
    divideEvents.push({ mother: i, a: i, b: newId, axisX: outAxis[0]!, axisY: outAxis[1]! });
  }
  if (divideOverflow) {
    self.postMessage({ type: 'agentOverflow', message: `Agent or bond capacity reached during division (maxAgents=${s.maxAgents}, maxBonds=${s.maxBonds}). Some divisions were skipped.` });
  }
  if (divideEvents.length > 0) runDivisionEvent(divideEvents);

  // 2. Auto-bond by distance (opt-in, hysteresis): form a bond between any two
  //    unbonded agents within formDistance×contact; break bonds stretched past
  //    breakDistance×contact. Uses the spatial hash → O(N).
  if (cfg?.autoBond) {
    const fMul = cbNum(cfg, 'formDistance');
    const bMul = cbNum(cfg, 'breakDistance');
    // form pass — scan candidate pairs via the hash
    const z = s.z, halfD = D / 2;
    let maxR = cbNum(cfg, 'defaultRadius');
    for (let i = 0; i < hw; i++) { if (alive[i] && rad[i]! > maxR) maxR = rad[i]!; }
    const hash = buildSpatialHash(s, Math.max(1e-3, bMul * 2 * maxR), W, H, D);
    const tryForm = (i: number, j: number) => {
      if (j <= i || !alive[j]) return;
      let dx = x[j]! - x[i]!, dy = y[j]! - y[i]!;
      const contact = rad[i]! + rad[j]!;
      let d: number;
      if (is3d) {
        let dz = z[j]! - z[i]!;
        if (torus) {
          if (dx > halfW) dx -= W; else if (dx < -halfW) dx += W;
          if (dy > halfH) dy -= H; else if (dy < -halfH) dy += H;
          if (dz > halfD) dz -= D; else if (dz < -halfD) dz += D;
        }
        d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      } else {
        if (torus) { if (dx > halfW) dx -= W; else if (dx < -halfW) dx += W; if (dy > halfH) dy -= H; else if (dy < -halfH) dy += H; }
        d = Math.sqrt(dx * dx + dy * dy);
      }
      if (d < fMul * contact) formBond(s, i, j, contact, lambda);
    };
    if (hash) {
      const { nBinsX, nBinsY, nBinsZ, binStart, binAgents, binSizeX, binSizeY, binSizeZ } = hash;
      if (nBinsZ > 1) {
        // 3D form pass — 3×3×3 stencil over the z-major hash, torus-wrapped.
        for (let i = 0; i < hw; i++) {
          if (!alive[i]) continue;
          let bx = (x[i]! / binSizeX) | 0; if (bx < 0) bx = 0; else if (bx >= nBinsX) bx = nBinsX - 1;
          let by = (y[i]! / binSizeY) | 0; if (by < 0) by = 0; else if (by >= nBinsY) by = nBinsY - 1;
          let bz = (z[i]! / binSizeZ) | 0; if (bz < 0) bz = 0; else if (bz >= nBinsZ) bz = nBinsZ - 1;
          for (let ddz = -1; ddz <= 1; ddz++) for (let ddy = -1; ddy <= 1; ddy++) for (let ddx = -1; ddx <= 1; ddx++) {
            let nbx = bx + ddx, nby = by + ddy, nbz = bz + ddz;
            if (torus) { nbx = ((nbx % nBinsX) + nBinsX) % nBinsX; nby = ((nby % nBinsY) + nBinsY) % nBinsY; nbz = ((nbz % nBinsZ) + nBinsZ) % nBinsZ; }
            else { if (nbx < 0 || nbx >= nBinsX || nby < 0 || nby >= nBinsY || nbz < 0 || nbz >= nBinsZ) continue; }
            const b = (nbz * nBinsY + nby) * nBinsX + nbx;
            for (let p = binStart[b]!; p < binStart[b + 1]!; p++) tryForm(i, binAgents[p]!);
          }
        }
      } else {
        for (let i = 0; i < hw; i++) {
          if (!alive[i]) continue;
          let bx = (x[i]! / binSizeX) | 0; if (bx < 0) bx = 0; else if (bx >= nBinsX) bx = nBinsX - 1;
          let by = (y[i]! / binSizeY) | 0; if (by < 0) by = 0; else if (by >= nBinsY) by = nBinsY - 1;
          for (let ddy = -1; ddy <= 1; ddy++) for (let ddx = -1; ddx <= 1; ddx++) {
            let nbx = bx + ddx, nby = by + ddy;
            if (torus) { nbx = ((nbx % nBinsX) + nBinsX) % nBinsX; nby = ((nby % nBinsY) + nBinsY) % nBinsY; }
            else { if (nbx < 0 || nbx >= nBinsX || nby < 0 || nby >= nBinsY) continue; }
            const b = nby * nBinsX + nbx;
            for (let p = binStart[b]!; p < binStart[b + 1]!; p++) tryForm(i, binAgents[p]!);
          }
        }
      }
    } else {
      for (let i = 0; i < hw; i++) { if (!alive[i]) continue; for (let j = i + 1; j < hw; j++) tryForm(i, j); }
    }
    // break pass — drop bonds stretched past breakDistance×contact
    for (let i = 0; i < hw; i++) {
      if (!alive[i]) continue;
      const base = i * s.maxBonds;
      for (let k = s.bondCount[i]! - 1; k >= 0; k--) {
        const p = s.bondPartner[base + k]!;
        if (p <= i || !alive[p]) continue; // handle each pair once (from the lower id)
        let dx = x[p]! - x[i]!, dy = y[p]! - y[i]!;
        const contact = rad[i]! + rad[p]!;
        let dd: number;
        if (is3d) {
          let dz = z[p]! - z[i]!;
          if (torus) {
            if (dx > halfW) dx -= W; else if (dx < -halfW) dx += W;
            if (dy > halfH) dy -= H; else if (dy < -halfH) dy += H;
            if (dz > halfD) dz -= D; else if (dz < -halfD) dz += D;
          }
          dd = Math.sqrt(dx * dx + dy * dy + dz * dz);
        } else {
          if (torus) { if (dx > halfW) dx -= W; else if (dx < -halfW) dx += W; if (dy > halfH) dy -= H; else if (dy < -halfH) dy += H; }
          dd = Math.sqrt(dx * dx + dy * dy);
        }
        if (dd > bMul * contact) breakBond(s, i, p);
      }
    }
  }

  // 3. Stale-bond sweep (defence-in-depth on the dangling-bond ABI).
  sweepStaleBonds(s);
}
// Async-only: per-cell Uint8 view at wasmLayout.skippedOffset. Set by
// `markCellUpdated` (via the compiled step in JS mode, or `i32.store8` in
// WASM mode), tested at the top of each cell iteration, cleared before
// every step.
let skippedArray: Uint8Array | null = null;
// Per-cell glyph overlay buffers. Views over wasmMemory at layout.glyph{Codes,Colors}Offset
// when layout.hasGlyphs is true; null otherwise. glyphCodes holds one Unicode
// codepoint per cell (0 = no glyph); glyphColors holds R | G<<8 | B<<16 per cell.
// Cleared at the top of every colour pass so compiled writes start fresh.
let glyphCodes: Uint32Array | null = null;
let glyphColors: Uint32Array | null = null;
// Empty placeholders passed to compiled JS step/colour-pass functions when
// the model has no setCellGlyph node — keeps the function arity stable
// without paying for a per-cell buffer. The compiled code never reads these
// because no setCellGlyph emit landed in the function body.
const GLYPH_NOOP_CODES: Uint32Array = new Uint32Array(0);
const GLYPH_NOOP_COLORS: Uint32Array = new Uint32Array(0);

// Inspect-cell subscriptions — flat cell indices the main thread is watching
// via the Shift+LMB popup. Worker emits `inspectCellsData` after every step
// (piggy-backed onto sendColors) and immediately when the set is updated.
// Cost when empty: a single empty-array length check per step. Cost when
// non-empty: one read × cellAttrs.length per subscribed cell per step.
let inspectCellIdxs: number[] = [];

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
/** Optional per-cell init function compiled from the Init Event Node.
 *  Null when the graph contains no Init Event Node. Runs once per cell on
 *  Reset (NOT on Randomize, NOT on Load State), after default values are
 *  applied and before the first color pass. */
let initFn: Function | null = null;

/** Per-table Float64Array of length `rowCount * colCount` (row-major). Keyed by
 *  attribute id. Rebuilt on init / recompile / updateLookupTable. */
let cachedInteractionTables: Record<string, Float64Array> = {};
/** The current Lookup Table payloads (id + resolved row/col labels + values),
 *  stashed before initGrid so the layout can size each table region. */
let lookupTablesPayload: InteractionTablePayload[] = [];
/** True when the model has any Lookup Table model attr — gates emission of the
 *  `_lookupTables` arg bundle in buildLoopArgs/buildCellArgs (mirrors the JS
 *  compiler's `variegated || hasLookupTables` param gate). */
let hasLookupTables = false;

/** Variegated Cells state. All null when the feature is disabled for the
 *  current model; populated together in `initVariegation()` on init/recompile.
 *  Phase 6 wires these into the JS-target compiled-fn signature; Phases 8 / 9
 *  add WASM / WebGPU layout slots that mirror the values. */
let variegated: VariegatedPayload | null = null;
// Set by init/recompile BEFORE initGrid runs. Drives layout.hasGlyphs which
// in turn drives glyphCodes/glyphColors view allocation. Defaults to false
// so unmigrated/legacy init messages don't allocate the regions for free.
let hasGlyphs = false;
let orientationReadView: Int32Array | null = null;
let orientationWriteView: Int32Array | null = null;
/** Flat `[speciesIdx * 8 + faceIdx → labelIdx]` (0 = "none"). Built once by
 *  `buildFacePatternLookup` from the variegation source attribute's
 *  facePatternAssignments. */
let facePatternLookup: Int32Array | null = null;

/** Build the facePatternLookup table + populate cached interaction tables
 *  for the current model. Phase 8: orientation arrays and the lookup +
 *  interaction tables are stored as typed-array VIEWS over `wasmMemory` (see
 *  initGrid for the orientation views; this function fills the lookup +
 *  table regions). Per the typed-array-view discipline in CLAUDE.md, future
 *  live updates (e.g. updateInteractionTable) MUST copy into these views,
 *  never reassign the JS reference — WASM reads via baked offsets, not the
 *  JS reference.
 *
 *  Called from the init/recompile handlers AFTER `initGrid()` (which sized
 *  `wasmMemory`/`wasmLayout` with the variegated regions reserved). When
 *  variegation is disabled all state is cleared and no memory is touched. */
function initVariegation(
  payload: VariegatedPayload | undefined,
  interactionTablesPayload: InteractionTablePayload[] | undefined,
): void {
  variegated = payload ?? null;
  cachedInteractionTables = {};
  lookupTablesPayload = interactionTablesPayload ?? [];
  hasLookupTables = lookupTablesPayload.length > 0;

  // facePatternLookup region (variegation only) — view over wasmMemory at the
  // layout offset. initGrid sized it from the source attribute's tagOptions
  // count; rebuild the values and `set()` them into the view so JS-target reads
  // and WASM reads both see the same bytes.
  if (!variegated || !wasmMemory || !wasmLayout || wasmLayout.facePatternLookupBytes <= 0) {
    facePatternLookup = variegated ? new Int32Array(0) : null;
  } else {
    const source = cellAttrs.find(a => a.id === variegated!.sourceAttributeId);
    facePatternLookup = new Int32Array(
      wasmMemory.buffer,
      wasmLayout.facePatternLookupOffset,
      wasmLayout.facePatternLookupBytes / 4,
    );
    facePatternLookup.fill(0);
    if (source && source.tagOptions) {
      const built = buildFacePatternLookup({
        tagOptions: source.tagOptions,
        facePatternAssignments: variegated.facePatternAssignments,
        facePalettes: variegated.facePalettes,
        facePatterns: variegated.facePatterns,
      });
      facePatternLookup.set(built);
    }
  }

  // Lookup tables — one Float64Array view per table at the per-attr offset
  // reserved by computeMemoryLayout. INDEPENDENT of variegation (tag×tag tables
  // need no faces). `set()` the normalised values in; updateLookupTable later
  // writes through the same view (never reassign — WASM reads via baked offset).
  if (wasmMemory && wasmLayout) {
    for (const t of lookupTablesPayload) {
      const slot = wasmLayout.interactionTableOffsets[t.id];
      const normalized = normalizeLookupTable(t.values, t.rowLabels, t.colLabels);
      if (slot !== undefined) {
        const view = new Float64Array(wasmMemory.buffer, slot.offset, slot.rowCount * slot.colCount);
        view.fill(0);
        view.set(normalized);
        cachedInteractionTables[t.id] = view;
      } else {
        // No layout slot (table attr added after init without recompile) — keep
        // a standalone array so JS reads still work; WASM has no offset for it.
        cachedInteractionTables[t.id] = normalized;
      }
    }
  }
}

/** Upload the current variegation data to the WebGPU runtime (orientation,
 *  facePatternLookup, every interaction table). Called from the WebGPU init
 *  path after setupBuffersAndPipelines + from recompile + from
 *  updateInteractionTable so the GPU stays in sync with the JS-side views.
 *  No-op when WebGPU isn't ready or the model doesn't use variegation. */
function syncVariegationToGPU(): void {
  const rt = webgpuRuntime;
  if (!rt || !rt.stepReady) return;
  // Orientation + facePatternLookup are variegation-only; tables are not.
  if (rt.layout.variegatedEnabled) {
    if (orientationReadView) uploadOrientation(rt, orientationReadView);
    if (facePatternLookup && facePatternLookup.length > 0) uploadFacePatternLookup(rt, facePatternLookup);
  }
  for (const [id, view] of Object.entries(cachedInteractionTables)) {
    // The cached view is a Float64Array (over wasmMemory). The GPU stores f32,
    // so the upload helper down-converts via a fresh Float32Array. Negligible
    // copy cost — tables are small ((labels+1)² entries).
    uploadInteractionTable(rt, id, view);
  }
}

// WASM step (Wave 2) — when useWasm is true, runStep() calls this instead of
// the JS stepFn. Default false; flipped via the 'setUseWasm' message. The WASM
// module is rebuilt on every init/recompile because it imports the linear
// memory and assumes the current attribute layout.
let wasmStepFn: ((total: number) => void) | null = null;
// Per-mapping WASM exports. Keys are SANITISED mapping ids (matching the
// `inputColor_<id>` / `outputMapping_<id>` export names the compiler emits).
let wasmInputColorFns: Record<string, (idx: number, r: number, g: number, b: number) => void> = {};
let wasmOutputMappingFns: Record<string, (total: number) => void> = {};
/** Variegated Cells: WASM Init Event entry point. Same signature as `step`
 *  — single `total` param, walks every cell sequentially. Called by `runInit`
 *  on Reset when the model has an Init Event node + WASM target. */
let wasmInitFn: ((total: number) => void) | null = null;
let useWasm = false;

// Wave 3: WebGPU runtime. `useWebGPU` is the user's intent; `webgpuRuntime` is
// the actual handle (null until async init succeeds, or null after a failure).
// `runStep()` only routes to the WebGPU path when both useWebGPU is true AND
// `webgpuRuntime.stepReady` is true — step 1 leaves stepReady false so the
// step still runs on JS/WASM even when the user has WebGPU selected. This
// validates the entire control plane without needing buffer/pipeline machinery.
let useWebGPU = false;
// GIF recording toggle. When true and direct render is active, sendColors
// includes the colors buffer (extra readback per frame) so main thread can
// capture frames. Otherwise direct render skips the colors transfer.
let recording = false;
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
    self.postMessage({ type: 'useWebGPUStatus', enabled: useWebGPU, ready: true, directRender: webgpuRuntime.directRender });
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
      uploadNeighborOffsets(rt);
      uploadModelAttrs(rt, cachedModelAttrs as Record<string, number>);
      uploadActiveViewer(rt, viewerIdMap[activeViewer] ?? -1);
      seedRngState(rt, rngState[0] ?? 0x12345678);
      // Variegated Cells: upload facePatternLookup + interaction tables +
      // initial orientation. setupBuffersAndPipelines already flipped
      // `rt.stepReady = true` so syncVariegationToGPU's gate passes.
      syncVariegationToGPU();
      // O5 — set up GPU-side reduction pipelines for any GPU-eligible
      // watched linked indicators. Skipped indicators (float total, integer
      // /float frequency) keep using the existing CPU readback fallback.
      setupReductionPipelines(rt, linkedDefs);
      // Initial indicator values
      const vals: Record<string, number> = {};
      for (const { idx, id } of standaloneIds) vals[id] = cachedIndicators[idx]!;
      uploadIndicators(rt, vals, isIntEncodedIndicator);
      // Run the active viewer's outputMapping + present (single encoder under
      // direct render — P6) so the canvas shows the initial state from the
      // very first frame. Falls back to the plain dispatch under non-direct.
      if (rt.directRender) {
        dispatchColorPassAndPresent(rt, activeViewer);
        if (mySeq !== webgpuInitSeq) return;
        self.postMessage({ type: 'stepped', generation });
      } else {
        dispatchOutputMapping(rt, activeViewer);
        // Pull initial colors back to CPU so the simulator's first paint shows
        // the model's actual visualization (not all-black).
        try { await readbackColors(rt, colors); } catch { /* non-fatal */ }
        if (mySeq !== webgpuInitSeq) return;
        self.postMessage({ type: 'stepped', generation, colors: new Uint8ClampedArray(colors) });
      }
      // eslint-disable-next-line no-console
      console.log(`[webgpu] runtime ready: device + shader + buffers + step pipeline (${rt.entryPoints.outputMappings.length} viewer pipeline(s) lazily built)`);
      self.postMessage({ type: 'useWebGPUStatus', enabled: useWebGPU, ready: rt.stepReady, directRender: rt.directRender });
    })
    .catch((e: unknown) => {
      // Same staleness check on the failure path — don't clobber the newer
      // runtime's state with a stale error message.
      if (mySeq !== webgpuInitSeq) return;
      webgpuRuntime = null;
      const msg = (e instanceof Error) ? e.message : String(e);
      self.postMessage({ type: 'error', message: '[webgpu] init failed: ' + msg });
      self.postMessage({ type: 'useWebGPUStatus', enabled: useWebGPU, ready: false, directRender: false });
    });
}

/** Mirror of the compiler's sanitiseExportName: drop everything except
 *  [A-Za-z0-9_] so the export name is a valid JS identifier and we can match
 *  it back to the mapping id at lookup time. */
function sanitiseExportName(s: string | undefined | null): string {
  return (s ?? '').replace(/[^A-Za-z0-9_]/g, '_');
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
  /** Sub-attribute marker. When true, GPU-side reductions skip this indicator
   *  (the parent_match guard isn't expressible against the current reduction
   *  shader's binding set) and the CPU readback path handles it. */
  isSubAttribute?: boolean;
  /** Spatial X-axis. 'rows'/'columns' => this indicator is a position histogram
   *  computed by computeSpatialIndicators (CPU, all targets); its result is a
   *  Record<seriesKey, number[]> (array indexed by position bin), NOT a scalar
   *  or per-value map. Absent/'generation' => classic generation-axis linked. */
  xAxis?: string;
  spatialBinMode?: string;
  spatialBinCount?: number;
  spatialBinSize?: number;
  /** Categorical (bool/tag) frequency only: subset of category keys to keep in
   *  the outgoing indicators payload. Absent/empty = all. Applied in sendColors
   *  (post-aggregation), so it covers JS/WASM/WebGPU + generation/spatial. */
  trackedValues?: string[];
}> = [];
let hasSpatialIndicators = false;
let linkedAccumulators: Record<string, number | Record<string, number>> = {};
// Linked + spatial results. Generation-axis linked indicators are number
// (total) or Record<string,number> (frequency); spatial indicators are
// Record<string, number[]> (per-position-bin series). The wider union covers
// all three; the UI branches on the indicator's xAxis.
let linkedResults: Record<string, number | Record<string, number> | Record<string, number[]>> = {};

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
    case 'neighborIndex': return new Int32Array(size);
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
    case 'neighborIndex': return new Int32Array(buf, byteOffset, length);
    case 'float': return new Float64Array(buf, byteOffset, length);
    default: return new Float64Array(buf, byteOffset, length);
  }
}

function defaultValue(attr: AttrDef): number {
  return encodeAttrValue(attr, attr.defaultValue);
}

/** Parsed value held by out-of-grid cells under constant boundary. Falls back
 *  to defaultValue when boundaryValue is unset or an empty string. */
function boundaryCellValue(attr: AttrDef): number {
  const bv = attr.boundaryValue;
  if (bv === undefined || bv === '') return defaultValue(attr);
  return encodeAttrValue(attr, bv);
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function initGrid(): void {
  total = width * height * depth;   // 3D Grid CA: depth===1 → W*H (2D byte-identical)
  attrsA = {};
  attrsB = {};
  const isAsync = updateMode === 'asynchronous';

  // Allocate WASM linear memory and create typed-array views over EVERY region
  // the WASM step might address: cell attrs, color buffer, neighbor index
  // tables, model attrs, indicators, RNG state, active viewer ID, and async
  // order array. JS-side variables (attrsA/B, nbrIndices, orderArray, etc.)
  // become typed-array views over wasmMemory at the layout offsets — single
  // source of truth shared between JS step and WASM step.
  //
  // Variegated Cells: when the feature is enabled (`variegated` was set by the
  // init/recompile handler BEFORE calling initGrid), the layout also reserves
  // orientation read/write regions, the facePatternLookup region, and a
  // contiguous f64 region per interactionTable model attribute. Sized from the
  // source attribute's tagOptions count + the face-label palette length so the
  // regions are stable across live edits to the values themselves.
  let variegatedInputs: VariegatedLayoutInputs | undefined;
  if (variegated) {
    const source = cellAttrs.find(a => a.id === variegated!.sourceAttributeId);
    variegatedInputs = { speciesCount: source?.tagOptions?.length ?? 0 };
  }
  // Lookup tables — sized from each table's resolved row/col label counts
  // (carried in the payload, stashed before initGrid). Independent of variegation.
  const lookupTables: LookupTableLayoutInput[] = lookupTablesPayload.map(t => ({
    id: t.id,
    rowCount: t.rowLabels.length || 1,
    colCount: t.colLabels.length || 1,
  }));
  wasmLayout = computeMemoryLayout(
    cellAttrs, modelAttrsList, neighborhoods, indicatorsList,
    total, isAsync, boundaryTreatment,
    variegatedInputs,
    hasGlyphs,
    lookupTables,
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
  // Glyph buffer views — only when the layout reserved regions (i.e. the
  // model has at least one setCellGlyph node). Otherwise null, all readers
  // skip.
  if (wasmLayout.hasGlyphs) {
    glyphCodes = new Uint32Array(buf, wasmLayout.glyphCodesOffset, wasmLayout.glyphCodesBytes / 4);
    glyphColors = new Uint32Array(buf, wasmLayout.glyphColorsOffset, wasmLayout.glyphColorsBytes / 4);
  } else {
    glyphCodes = null;
    glyphColors = null;
  }
  generation = 0;

  // Variegated Cells — orientation views over wasmMemory. Same sentinel-aware
  // length as cell attrs. Sentinel cell at index `total` stays at 0 per spec
  // §6.3 (orientation boundary value is fixed at 0). In async mode the write
  // view aliases the read view (single shared buffer, mirrors cell-attr
  // async discipline).
  if (wasmLayout.variegatedEnabled) {
    const oLen = wasmLayout.orientationBytes / 4;
    orientationReadView = new Int32Array(buf, wasmLayout.orientationReadOffset, oLen);
    orientationReadView.fill(0);
    if (isAsync) {
      orientationWriteView = orientationReadView;
    } else {
      orientationWriteView = new Int32Array(buf, wasmLayout.orientationWriteOffset, oLen);
      orientationWriteView.fill(0);
    }
  } else {
    orientationReadView = null;
    orientationWriteView = null;
  }

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
    // Mark-Cell-Updated flag (async only). Cleared at the top of every step.
    skippedArray = new Uint8Array(buf, wasmLayout.skippedOffset, total);
  } else {
    orderArray = null;
    skippedArray = null;
  }
}

function buildNeighborIndices(): void {
  nbrIndices = {};
  if (!wasmMemory || !wasmLayout) return;
  const buf = wasmMemory.buffer;
  for (const nbr of neighborhoods) {
    // 3D Grid CA: the offset table gains a `layer` dimension and reads 3-tuple
    // offsets when present. The STRIDE stays `coords.length` (=== coords3d.length
    // for a 3D nbr) so every downstream `nIdx_<nbr>[idx*nSz+k]` consumer is
    // byte-compatible and 3D-for-free. In 2D (depth===1, no coords3d) the inner
    // arithmetic reduces to the historical `row*width+col` form.
    const coords3d = nbr.coords3d;
    const nbrSize = coords3d ? coords3d.length : nbr.coords.length;
    // Index table is a view over wasmMemory at the layout offset — shared with WASM step.
    const indices = new Int32Array(buf, wasmLayout.nbrIndexOffset[nbr.id]!, total * nbrSize);

    for (let layer = 0; layer < depth; layer++) {
      for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
          const cellIdx = (layer * height + row) * width + col;
          for (let n = 0; n < nbrSize; n++) {
            const c = coords3d ? coords3d[n]! : nbr.coords[n]!;
            const dr = c[0], dc = c[1], dl = (c as number[])[2] ?? 0;
            let nLayer = layer + dl;
            let nRow = row + dr;
            let nCol = col + dc;

            if (nLayer < 0 || nLayer >= depth || nRow < 0 || nRow >= height || nCol < 0 || nCol >= width) {
              if (boundaryTreatment === 'torus') {
                nLayer = ((nLayer % depth) + depth) % depth;
                nRow = ((nRow % height) + height) % height;
                nCol = ((nCol % width) + width) % width;
              } else {
                // Constant: typed arrays can't store -1, so `total` is the
                // sentinel (the +1 cell holds the boundary value).
                indices[cellIdx * nbrSize + n] = total; // sentinel
                continue;
              }
            }

            indices[cellIdx * nbrSize + n] = (nLayer * height + nRow) * width + nCol;
          }
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
  // 3D Grid CA: `depth` + `WH` follow W/H ONLY for a 3D grid (depth > 1),
  // matching the compiler's buildLoopParams (gated on is3dModel === dimension
  // 3d && gridDepth > 1, which is exactly depth > 1 here). 2D args byte-identical.
  const args: unknown[] = depth > 1 ? [total, width, height, depth, width * height] : [total, width, height];
  for (const attr of cellAttrs) args.push(readAttrs[attr.id]);
  for (const attr of cellAttrs) args.push(writeAttrs[attr.id]);
  for (const nbr of neighborhoods) {
    args.push(nbrIndices[nbr.id]);
    args.push(nbr.coords3d ? nbr.coords3d.length : nbr.coords.length);
  }
  args.push(cachedModelAttrs, colors, activeViewer, cachedIndicators, linkedResults, rngState, stopFlag);
  // Glyph buffers — always present in the param list to keep arity stable;
  // empty Uint32Arrays when the model has no glyphs (compiled writes never
  // execute in that case because no setCellGlyph node was compiled).
  args.push(glyphCodes ?? GLYPH_NOOP_CODES, glyphColors ?? GLYPH_NOOP_COLORS);
  // Variegated Cells: orientation arrays + face-pattern lookup + interaction
  // tables, in the same order the JS compiler emits its param list.
  if (variegated || hasLookupTables) {
    args.push(orientationReadView, orientationWriteView, facePatternLookup, cachedInteractionTables);
  }
  if (updateMode === 'asynchronous' && orderArray) {
    args.push(orderArray);
    // `_skipped` is the same shape as orderArray (length=total) so the JS step
    // emit's `if (_skipped[idx] !== 0) continue;` works directly. WASM ignores
    // this arg (it reads via `i32.load8_u` at the baked-in offset).
    args.push(skippedArray);
  }
  return args;
}

/** Build args for a per-cell function (InputColor) */
function buildCellArgs(idx: number): unknown[] {
  // 3D Grid CA: D + WH only for a 3D grid (mirrors buildCellParams). 2D byte-identical.
  const args: unknown[] = depth > 1 ? [idx, total, width, height, depth, width * height] : [idx, total, width, height];
  for (const attr of cellAttrs) args.push(readAttrs[attr.id]);
  for (const attr of cellAttrs) args.push(writeAttrs[attr.id]);
  for (const nbr of neighborhoods) {
    args.push(nbrIndices[nbr.id]);
    args.push(nbr.coords3d ? nbr.coords3d.length : nbr.coords.length);
  }
  args.push(cachedModelAttrs, colors, activeViewer, cachedIndicators, linkedResults, rngState, stopFlag);
  // Glyph buffers — always present in the param list to keep arity stable;
  // empty Uint32Arrays when the model has no glyphs (compiled writes never
  // execute in that case because no setCellGlyph node was compiled).
  args.push(glyphCodes ?? GLYPH_NOOP_CODES, glyphColors ?? GLYPH_NOOP_COLORS);
  if (variegated || hasLookupTables) {
    args.push(orientationReadView, orientationWriteView, facePatternLookup, cachedInteractionTables);
  }
  return args;
}

/** Instantiate WASM bytes (compiled on main thread) against the current memory.
 *  Splits the resulting exports into wasmStepFn / wasmInputColorFns / wasmOutputMappingFns. */
function tryInstantiateWasmModule(bytes: Uint8Array | undefined, exportNames: string[] | undefined): void {
  wasmStepFn = null;
  wasmInputColorFns = {};
  wasmOutputMappingFns = {};
  wasmInitFn = null;
  if (!bytes || bytes.length === 0 || !wasmMemory) return;
  const names = exportNames ?? [];
  instantiateWasmModule({ bytes, minMemoryPages: 1, viewerIds: {}, exports: names }, wasmMemory).then(
    inst => {
      const stepExp = inst.exports['step'];
      if (typeof stepExp === 'function') wasmStepFn = stepExp as (t: number) => void;
      const initExp = inst.exports['init'];
      if (typeof initExp === 'function') wasmInitFn = initExp as (t: number) => void;
      for (const [name, fn] of Object.entries(inst.exports)) {
        if (name === 'step' || name === 'init') continue;
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
      wasmInitFn = null;
      self.postMessage({ type: 'error', message: '[wasm] instantiate failed: ' + (err?.message || err) });
    },
  );
}

/** True iff GPU buffers are the source of truth (attrs may be stale on CPU).
 *  Flipped on by runStepWebGPU; flipped off by any code path that uploads
 *  CPU → GPU (mutation handlers in step 6) or readback handlers that sync
 *  GPU → CPU (step 7 save state, step 14 linked indicators). */
let gpuOwnsAttrs = false;

/** Pull GPU → CPU iff the GPU is currently authoritative. Use before any code
 *  path that READS the CPU `readAttrs` mirror for outgoing data (clipboard,
 *  save state, JS-mode color pass, etc) — otherwise the read returns stale
 *  pre-evolution data after Play under WebGPU. The `getState` and `paint`
 *  handlers were the only ones that did this manually; this helper makes the
 *  invariant uniform for all readers. */
async function ensureCpuAttrsFresh(): Promise<void> {
  if (!useWebGPU || !webgpuRuntime?.stepReady || !gpuOwnsAttrs) return;
  await readbackAttrs(webgpuRuntime, readAttrs);
  gpuOwnsAttrs = false;
}

/** Parse an attribute's `defaultValue` string into the numeric storage value.
 *  Mirrors attrValueLiteralJS but evaluates to a JS number. */
function parseAttrValue(attr: AttrDef, valueStr: string | undefined): number {
  const raw = valueStr ?? attr.defaultValue ?? '';
  switch (attr.type) {
    case 'bool': return raw === 'true' || raw === '1' ? 1 : 0;
    case 'integer':
    case 'tag':
    case 'neighborIndex': {
      const n = parseInt(raw, 10);
      return Number.isFinite(n) ? n : 0;
    }
    case 'float': {
      const n = parseFloat(raw);
      return Number.isFinite(n) ? n : 0;
    }
    default: return 0;
  }
}

/** Build a Set<number> of parent values (as integers) for matching. */
function buildParentMatchSet(parent: AttrDef, parentValues: string[]): Set<number> {
  return new Set(parentValues.map(v => {
    if (parent.type === 'bool') return v === 'true' || v === '1' ? 1 : 0;
    if (parent.type === 'tag') {
      const n = parseInt(v, 10);
      return Number.isFinite(n) ? n : 0;
    }
    return 0;
  }));
}

/** Async-mode pre-scrub: for every sub-attribute, set storage to `defaultValue`
 *  at indices where the parent's value is NOT in `parentValues`. Runs once per
 *  step before the cell loop; matches the sync-mode per-cell conditional copy
 *  semantics for non-matching cells. No-op when no sub-attributes exist. */
function applySubAttributeAsyncScrub(): void {
  for (const attr of cellAttrs) {
    const parentId = attr.parentAttributeId;
    if (!parentId) continue;
    const parentValues = attr.parentValues;
    if (!parentValues || parentValues.length === 0) continue;
    const parent = cellAttrs.find(p => p.id === parentId);
    if (!parent) continue;
    const parentArr = readAttrs[parentId];
    const subArr = readAttrs[attr.id];
    if (!parentArr || !subArr) continue;
    const matchSet = buildParentMatchSet(parent, parentValues);
    const defaultV = parseAttrValue(attr, attr.defaultValue);
    for (let i = 0; i < total; i++) {
      const pv = (parentArr as unknown as { [k: number]: number })[i];
      if (!matchSet.has(pv as number)) {
        (subArr as unknown as { [k: number]: number })[i] = defaultV;
      }
    }
  }
}

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

  // Clear glyph buffers — matches runColorPass behaviour. If the model uses
  // setCellGlyph in step (no output mapping) the step-side writes are the
  // only source; if both step and an output mapping write glyphs, the
  // mapping's clear+write happens after this and wins (same semantics as
  // colour writes via SetColorViewer).
  if (glyphCodes) glyphCodes.fill(0);
  if (glyphColors) glyphColors.fill(0);

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

    // Mark-Cell-Updated flag is per-step transient: every cell starts the
    // generation eligible for update. JS step reads `_skipped[idx]` at the
    // top of each iteration; WASM step reads via `i32.load8_u` at the same
    // offset. Either way, clearing the byte view here lets the compiled code
    // see a fresh 0 at the start of every step.
    if (skippedArray) skippedArray.fill(0);

    // Sub-attribute pre-scrub (async mode only): the cell loop uses a single
    // buffer, so the JS/WASM emit can't insert a "w = match ? r : default"
    // copy at the top of each cell. Instead, scrub non-matching cells to
    // defaultValue once per step before the cell loop runs. Sync mode does
    // this inline via the per-cell copy emit (see compile.ts / wasm/compile.ts).
    applySubAttributeAsyncScrub();
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
    // Spatial indicators are always a live per-step snapshot — never
    // accumulated (their value is Record<key, number[]>, which the accumulate
    // branch can't sum). They're also written AFTER this loop (see
    // computeSpatialIndicators below), so they aren't in linkedResults yet; the
    // guard is belt-and-suspenders against future reordering.
    if (def.xAxis === 'rows' || def.xAxis === 'columns' || def.xAxis === 'layers') continue;
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
    // Variegated Cells: orientation views live at fixed offsets in wasmMemory,
    // so a JS-style ref swap can't bring writes into the read view. Same
    // problem on WASM — the read/write offsets are baked. Bulk-copy w → r so
    // the next step (and the output mapping) sees the new orientations.
    if (orientationReadView && orientationWriteView && orientationReadView !== orientationWriteView) {
      orientationReadView.set(orientationWriteView);
    }
  }
  // Spatial indicators (chromatogram): recompute the live per-position histogram
  // from the post-step buffer. readAttrs now holds the just-computed generation
  // on JS (ref-swap above) AND on WASM (w→r bulk copy above) — the same buffer
  // a later getState reads, so the verification parity check holds. Independent
  // of the generation-axis linked path; written here (after accumulation) so it
  // is always a fresh per-step snapshot.
  if (hasSpatialIndicators) computeSpatialIndicators();
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
  // Zero the GPU glyph buffers each step so per-cell setCellGlyph writes
  // can treat codepoint 0 as "no glyph". Matches the CPU runStep behaviour.
  if (webgpuRuntime.layout.hasGlyphs) clearGlyphBuffersWebGPU(webgpuRuntime);
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
  // Glyphs: clear before the colour pass so the OM shader's per-cell writes
  // see codepoint-0 sentinels everywhere. Mirrors the CPU runColorPass path.
  if (webgpuRuntime.layout.hasGlyphs) clearGlyphBuffersWebGPU(webgpuRuntime);
  // P6 — combined color-pass + present in one encoder + submit. Saves a
  // driver round-trip per frame compared to dispatching them separately.
  // When direct render is on but the active viewer has no Output Mapping
  // graph (e.g. MNCA "Case Colored" / "Decorated Trace"), the present pass
  // still runs and pushes whatever the step shader wrote via
  // SetColorViewer-in-step.
  const ok = dispatchColorPassAndPresent(webgpuRuntime, activeViewer);
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
 *  which is the documented behaviour for these models on user interaction.
 *
 *  CRITICAL ordering: for no-OM viewers we MUST dispatch the step BEFORE the
 *  present pass — otherwise the present blits the stale colors that were
 *  there before the mutation, then the step writes new colors that never
 *  reach the canvas. dispatchColorPassAndPresent runs OM (which writes
 *  colors) and present in one encoder, so ordering is correct for OM
 *  viewers; but it dispatches present unconditionally under direct render
 *  even when the OM pipeline doesn't exist, so we have to gate which path
 *  we take based on whether an OM pipeline actually exists.
 */
function refreshColorsAfterInputWebGPU(): void {
  const rt = webgpuRuntime;
  if (!rt || !rt.stepReady) return;
  const omExists = rt.entryPoints.outputMappings.some(o => o.mappingId === activeViewer);
  if (omExists) {
    runColorPassWebGPU();
    return;
  }
  // No OM pipeline → step shader populates colors via SetColorViewer-in-step.
  // Dispatch step FIRST so colorsBuf is fresh, THEN present so the canvas
  // texture picks it up.
  runStepWebGPU();
  presentToCanvas(rt);
}

/** JS / WASM analogue of refreshColorsAfterInputWebGPU. Same intent: after any
 *  CPU-side mutation (paint, paste, clear, randomize, reset, image import),
 *  refresh the CPU `colors` mirror so the next sendColors ships up-to-date
 *  pixels. Prefer the active viewer's Output Mapping (no generation advance);
 *  fall back to one Step (advances gen by 1; required for viewers like MNCA
 *  that emit colors via SetColorViewer-in-step); fall back to the bool-attr
 *  default coloring. ALL JS/WASM mutation handlers should call this — without
 *  it, no-OM viewers display pre-mutation colors after Ctrl+V / Ctrl+X. */
function refreshColorsAfterInputJS(): void {
  if (outputMappingFns.some(f => f.mappingId === activeViewer)) {
    runColorPass();
  } else if (stepFn) {
    runStep();
  } else {
    writeDefaultColors();
  }
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
  // The batched path uploads all cells in [minIdx, maxIdx], pulling the
  // "in-between" (not-touched) cells from CPU readAttrs. That's a no-op
  // when the mirror is current (post-reset / pre-step). After a step under
  // WebGPU, gpuOwnsAttrs=true and the CPU mirror is stale — uploading
  // those in-between cells would overwrite the GPU's live post-step state
  // with stale CPU values. Symptom: pasting a brush-wide rectangle after
  // play produces a brush-tall "wipe" stripe across the entire row, where
  // the cells between paste columns get clobbered. Force per-cell whenever
  // the mirror could be stale; the per-cell cost is negligible for typical
  // brush / paste sizes (a few queue.writeBuffer calls per attr).
  const useBatch = !gpuOwnsAttrs && rangeLen <= idxs.length * 4;
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
  // Inspect-cell popups need fresh CPU attrs for their per-cell readout. Bump
  // needAttrs internally so callers don't have to thread the flag.
  const fullAttrs = !!opts.needAttrs || inspectCellIdxs.length > 0;
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
      const isSpatial = d.xAxis === 'rows' || d.xAxis === 'columns' || d.xAxis === 'layers';
      // Spatial indicators are CPU-only (excluded from buildReductionPlan), so
      // they always need their source attr (and parent, for sub-attrs) on the
      // CPU — even if a sibling generation-axis indicator over the same attr is
      // GPU-reduced (which would otherwise short-circuit via gpuAttrIds below).
      if (isSpatial) {
        watchedAttrIds.add(d.attrId);
        const la = cellAttrs.find(a => a.id === d.attrId);
        if (la?.parentAttributeId) watchedAttrIds.add(la.parentAttributeId);
        continue;
      }
      if (gpuIds.has(d.id)) continue; // GPU-reduction handles this one
      if (gpuAttrIds.has(d.attrId)) continue; // attr already in GPU plan
      watchedAttrIds.add(d.attrId);
    }
  }
  // P7 — direct render owns the canvas; we never need to readback colors for
  // display. EXCEPT during GIF recording or inspect popups: both consume the
  // per-frame colors on the main thread (recording: into ImageData frames;
  // inspect: into the per-cell RGB readout in the popover). The readback is
  // the same cost as before P7, but only paid when at least one of those is
  // active.
  const wantColors = (opts.needColors !== false) && (!rt.directRender || recording || inspectCellIdxs.length > 0);
  // P5 — only read back indicators that the UI/end-conditions actually
  // consume. A model can declare 10 indicators with `watched=false` and they
  // ALL stayed in the readback path before, paying the per-frame mapAsync
  // overhead for no observable effect. Now: standalone indicators always
  // surface (they're scalar, used by end-conditions); linked indicators
  // only when at least one is watched.
  const anyLinkedWatched = linkedDefs.some(d => d.watched);
  const wantIndicators = rt.layout.indicatorIds.length > 0
    && (standaloneIds.length > 0 || anyLinkedWatched);
  const wantStopFlag = stopMessages.length > 0;

  // Pack all readbacks into ONE staging buffer + ONE mapAsync. Pre-batch this
  // saves N-1 GPU↔CPU round trips per finalize compared to the old
  // one-buffer-per-source pattern. Particularly impactful on the per-step
  // stop-event path (was 2 mapAsyncs per step, now 1).
  const regions: ReadbackRegion[] = [];
  let colorsRegion = -1, indicatorsRegion = -1, stopRegion = -1, attrsRegion = -1;
  let reductionsRegion = -1;
  let glyphCodesRegion = -1, glyphColorsRegion = -1;
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
  // Glyph buffers: read back when the model uses setCellGlyph AND this is
  // a full finalize (the main thread needs them to overlay characters on
  // top of cell colours). Cheap relative to colors at typical grids; gated
  // by `hasGlyphs` so models without the feature pay zero.
  if (rt.layout.hasGlyphs && rt.glyphCodesBuf && rt.glyphColorsBuf && opts.needColors !== false) {
    glyphCodesRegion = regions.length;
    regions.push({ src: rt.glyphCodesBuf, srcOffset: 0, size: rt.layout.glyphCodesBytes });
    glyphColorsRegion = regions.length;
    regions.push({ src: rt.glyphColorsBuf, srcOffset: 0, size: rt.layout.glyphColorsBytes });
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
  if (regions.length === 0) {
    // Back-pressure: even when there's nothing to read back, we must keep
    // the worker's dispatch rate from outpacing the GPU's actual execution
    // rate. Otherwise (typical case: unlimited gens + direct render + no
    // watched indicators) the worker queues thousands of step batches; when
    // the user toggles unlimited off, the next color pass has to wait for
    // the entire backlog to drain before the canvas updates. A bare
    // `onSubmittedWorkDone()` is a fence with no data transfer.
    await rt.device.queue.onSubmittedWorkDone();
    return;
  }

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
  if (glyphCodesRegion >= 0 && glyphCodes) {
    const bytes = sliced[glyphCodesRegion]!;
    const src = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    const lim = Math.min(glyphCodes.length, src.length);
    for (let i = 0; i < lim; i++) glyphCodes[i] = src[i]!;
  }
  if (glyphColorsRegion >= 0 && glyphColors) {
    const bytes = sliced[glyphColorsRegion]!;
    const src = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    const lim = Math.min(glyphColors.length, src.length);
    for (let i = 0; i < lim; i++) glyphColors[i] = src[i]!;
  }
  if (attrsRegion >= 0) {
    unpackAttrsFromReadback(rt.layout, sliced[attrsRegion]!, readAttrs);
    gpuOwnsAttrs = false;
    if (linkedDefs.length > 0) computeLinkedIndicatorsFromBuffer();
    if (hasSpatialIndicators) computeSpatialIndicators();
  } else if (attrSlots.length > 0) {
    for (const { attrId, slot } of attrSlots) {
      unpackAttrFromReadback(rt.layout, attrId, sliced[slot]!, readAttrs);
    }
    // Only a subset of attrs were pulled — the rest remain GPU-only-fresh.
    // Subsequent paint with `gpuOwnsAttrs && icEntry?.fn` will trigger a full
    // readback (B5 fix), so leaving gpuOwnsAttrs=true is safe.
    computeLinkedIndicatorsFromBuffer();
    if (hasSpatialIndicators) computeSpatialIndicators();
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
  // 3D Grid CA: the default/fallback coloring is FULLY TRANSPARENT (alpha 0) so
  // the voxel renderer instances ZERO cells — a model with no explicit Output
  // Mapping (or before its first colour pass) doesn't pay to build a full opaque
  // volume on every recompile/init that the simulation would just erase. 2D keeps
  // the visible fallback below (the flat canvas needs something to show).
  if (depth > 1) { colors.fill(0); return; }
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
  // Variegated Cells: randomize orientations too. The buffer is a view over
  // wasmMemory, so writes through the JS view land in the same bytes WASM reads.
  if (orientationReadView) {
    for (let i = 0; i < total; i++) {
      orientationReadView[i] = (Math.random() * 4) | 0;
    }
    if (orientationWriteView && orientationWriteView !== orientationReadView) {
      orientationWriteView.set(orientationReadView);
    }
  }
  resetIndicators();
  generation = 0;
  // Under WebGPU the message handler is solely responsible for the post-mutation
  // visual update — uploadAttrs + runColorPassWebGPU. If we ran runStep() here,
  // it would route to runStepWebGPU which dispatches the GPU step shader against
  // the STALE GPU attrsRead (CPU mutation hasn't been uploaded yet) AND increments
  // generation. Net effect: gen counter shows 1 after a Randomize, and
  // SetColorViewer-in-step viewers (e.g. MNCA "Decorated Trace") display a
  // step OF the pre-randomize state instead of the random state itself.
  if (useWebGPU && webgpuRuntime?.stepReady) return;
  refreshColorsAfterInputJS();
}

function resetGrid(): void {
  for (const attr of cellAttrs) {
    const dv = defaultValue(attr);
    const arr = readAttrs[attr.id]!;
    const wArr = writeAttrs[attr.id]!;
    for (let i = 0; i < total; i++) { arr[i] = dv; wArr[i] = dv; }
  }
  // Variegated Cells: orientation defaults to 0 (spec §6.3). Clear both views
  // so init / step start from a clean state. Both views are over wasmMemory so
  // WASM sees the same zeros.
  if (orientationReadView) {
    orientationReadView.fill(0);
    if (orientationWriteView && orientationWriteView !== orientationReadView) {
      orientationWriteView.fill(0);
    }
  }
  resetIndicators();
  generation = 0;
  // Same reasoning as randomizeGrid — under WebGPU defer the visual update to
  // the message handler. See randomizeGrid comment above.
  if (useWebGPU && webgpuRuntime?.stepReady) return;
  refreshColorsAfterInputJS();
}

function compileFns(
  stepCode: string,
  icCodes: Array<{ mappingId: string; code: string }>,
  omCodes: Array<{ mappingId: string; code: string }> = [],
  initCode: string = '',
): void {
  try {
    // eslint-disable-next-line no-eval
    stepFn = stepCode ? (eval(stepCode) as Function) : null;
  } catch { stepFn = null; }
  try {
    // eslint-disable-next-line no-eval
    initFn = initCode ? (eval(initCode) as Function) : null;
  } catch { initFn = null; }
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

/** Bond-Graph Agents: compile the agent rule-graph functions (JS-only v1). The
 *  behaviour function runs once per LIVE agent each generation over `idx <
 *  highWater`. Absent code → null (agents seed + render but don't behave, the
 *  PR-A2 state). */
function compileAgentFns(behaviourCode?: string, initCode?: string, divisionCode?: string): void {
  try {
    // eslint-disable-next-line no-eval
    agentBehaviourFn = behaviourCode ? (eval(behaviourCode) as Function) : null;
  } catch (e) { agentBehaviourFn = null; self.postMessage({ type: 'error', message: '[agents] behaviour compile failed: ' + ((e as Error)?.message || e) }); }
  try {
    // eslint-disable-next-line no-eval
    agentInitFn = initCode ? (eval(initCode) as Function) : null;
  } catch { agentInitFn = null; }
  try {
    // eslint-disable-next-line no-eval
    agentDivisionFn = divisionCode ? (eval(divisionCode) as Function) : null;
  } catch (e) { agentDivisionFn = null; self.postMessage({ type: 'error', message: '[agents] division compile failed: ' + ((e as Error)?.message || e) }); }

  // DEV ABI-arity assertion (E3, MANDATORY) — the single highest-value safety net
  // for the B1 desync class. A compiled agent fn's `.length` (its declared param
  // count, from buildAgentLoop/DivisionParams) MUST equal the arg count the worker
  // passes (buildAgentLoop/DivisionArgs). A one-sided 3D-block edit shifts every
  // arg one slot WITHOUT a type error — only this arity check catches it. Division
  // takes 4 leading scalars (idx/daughterIndex/axisX/axisY) before the mirrored
  // buffers, so its arg count is built with placeholder scalars.
  if (import.meta.env?.DEV && agentStore) {
    const s = agentStore;
    if (agentBehaviourFn) {
      const want = buildAgentLoopArgs(s).length;
      if (agentBehaviourFn.length !== want) {
        self.postMessage({ type: 'error', message: `[agents] ABI ARITY DESYNC: behaviour fn declares ${agentBehaviourFn.length} params but buildAgentLoopArgs passes ${want} (buildAgentLoopParams↔buildAgentLoopArgs out of lockstep — the B1 hazard).` });
      }
    }
    if (agentDivisionFn) {
      const want = buildDivisionArgs(s, 0, 0, 0, 0).length;
      if (agentDivisionFn.length !== want) {
        self.postMessage({ type: 'error', message: `[agents] ABI ARITY DESYNC: division fn declares ${agentDivisionFn.length} params but buildDivisionArgs passes ${want} (buildDivisionParams↔buildDivisionArgs out of lockstep — the B1 hazard).` });
      }
    }
  }
}

/** Run the per-cell Init function for the entire grid (one cell per
 *  iteration). Sync mode swaps r/w buffers after, so subsequent reads from
 *  readAttrs see the init-time writes. Async mode shares a single buffer so
 *  no swap is needed. No-op when no init function exists. Called from the
 *  reset handler after `resetGrid()` and before sendColors / GPU upload.
 *
 *  Wave-2 (WASM): when `useWasm` and the WASM module exported `init`, call
 *  it instead of the JS function — both write through views over `wasmMemory`,
 *  so the post-run sync-mode swap below sees the right bytes regardless of
 *  which path wrote them. Same sync normalisation as runStep: when readAttrs
 *  != attrsA we copy back to attrsA first so WASM's baked-in offsets read the
 *  freshly-zeroed defaults instead of stale attrsB data.
 *
 *  WebGPU Init isn't supported in this phase — the worker falls back to the
 *  JS init function under WebGPU. The cell attribute buffers are TypedArray
 *  views over wasmMemory so writes still land in the right place; WebGPU
 *  uploads readAttrs after init in the reset handler. */
function runInit(): void {
  const useWebGPUInit = useWebGPU && webgpuRuntime?.stepReady && webgpuRuntime.initPipeline !== null;
  const callWasm = useWasm && wasmInitFn !== null;
  const isSync = updateMode !== 'asynchronous';
  if (!useWebGPUInit && !callWasm && !initFn) return;
  // WebGPU path: dispatch the GPU init pipeline. CPU views aren't touched by
  // the dispatch itself; the post-init bind-group swap makes attrsReadBuf
  // point at what was just written. The Reset handler is responsible for
  // having already uploaded the CPU defaults + orientation BEFORE runInit so
  // the GPU init shader reads the right pre-init state.
  if (useWebGPUInit && webgpuRuntime) {
    dispatchInit(webgpuRuntime);
    // After this dispatchInit, the GPU owns the latest attrs / orientation
    // (in attrsReadBuf post-swap). gpuOwnsAttrs is flipped on by the caller's
    // refreshColorsAfterInputWebGPU path; we don't need to readback here.
    return;
  }
  if (callWasm && isSync && readAttrs !== attrsA) {
    // Normalise to the baked-in WASM read offset before calling so WASM sees
    // the canonical pre-init state. Mirrors the runStep pattern.
    for (const attr of cellAttrs) {
      (attrsA[attr.id] as Uint8Array).set(readAttrs[attr.id] as Uint8Array);
    }
    readAttrs = attrsA;
    writeAttrs = attrsB;
  }
  try {
    if (callWasm) wasmInitFn!(total);
    else initFn!(...buildLoopArgs());
  } catch (e) {
    self.postMessage({ type: 'error', message: '[init] init function failed: ' + ((e instanceof Error) ? e.message : String(e)) });
    return;
  }
  // Sync mode: copy writeAttrs → readAttrs so both buffers match (mirrors the
  // resetGrid invariant) and subsequent reads from readAttrs see init-time
  // writes. The copy (vs a ref swap) keeps the canonical orientation
  // readAttrs=attrsA / writeAttrs=attrsB unchanged, which the WASM step (and
  // WebGPU upload) assume. Async mode: r/w share one buffer, no copy needed.
  if (updateMode !== 'asynchronous') {
    for (const attr of cellAttrs) {
      (readAttrs[attr.id] as Uint8Array).set(writeAttrs[attr.id] as Uint8Array);
    }
    // Variegated Cells: same sync-mode discipline for orientation. The init
    // function's per-cell `w_orientation.set(r_orientation)` preamble produces
    // a write buffer that contains the user's SetOrientation writes; copy it
    // back to the read buffer so subsequent step reads see init-time orientation.
    if (orientationReadView && orientationWriteView && orientationReadView !== orientationWriteView) {
      orientationReadView.set(orientationWriteView);
    }
  }
}

/** Run the Output Mapping color pass for the active viewer (if available).
 *  WASM mode: uses wasmOutputMappingFns. Sync mode + WASM also requires the
 *  same readAttrs->attrsA pre-step normalisation as runStep does, because the
 *  output mapping reads from the baked-in attrReadOffset. */
function runColorPass(): void {
  // Glyph buffers: zero before every colour pass so per-cell setCellGlyph
  // writes see a fresh canvas. "Codepoint 0" is the renderer's "skip this
  // cell" signal. Cheap memset — at 5000² this is ~3–6ms; for typical grids
  // negligible. Only allocated when the model uses setCellGlyph.
  if (glyphCodes) glyphCodes.fill(0);
  if (glyphColors) glyphColors.fill(0);
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
  hasSpatialIndicators = false;
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
        // Sub-attribute indicators stay on the CPU readback path so the
        // existing parent_match guard in computeLinkedIndicatorsFromBuffer
        // applies. Without this flag, buildReductionPlan would put them on
        // the GPU and the reduction shader would aggregate over every cell
        // (including non-matching cells whose storage is scrubbed to
        // defaultValue, double-counting that bucket).
        isSubAttribute: !!linkedAttr?.parentAttributeId,
        xAxis: ind.xAxis,
        spatialBinMode: ind.spatialBinMode,
        spatialBinCount: ind.spatialBinCount,
        spatialBinSize: ind.spatialBinSize,
        trackedValues: ind.trackedValues,
      });
      if (ind.xAxis === 'rows' || ind.xAxis === 'columns' || ind.xAxis === 'layers') hasSpatialIndicators = true;
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
    // Sub-attribute guard: when the linked attribute is a sub-attribute, skip
    // cells whose parent's value isn't in the configured parentValues. Empty
    // parentValues \u2192 matchSet is an empty Set \u2192 ALL cells are skipped (semantics:
    // "the sub-attribute is defined on no cells"). This is the iteration
    // semantics \u2014 non-matching cells don't contribute to any bucket.
    const linkedAttr = cellAttrs.find(a => a.id === def.attrId);
    const isSubAttr = !!linkedAttr?.parentAttributeId;
    const parent = isSubAttr
      ? cellAttrs.find(p => p.id === linkedAttr!.parentAttributeId)
      : null;
    const parentArr = (parent && readAttrs[parent.id]) || null;
    const matchSet = isSubAttr && parent
      ? buildParentMatchSet(parent, linkedAttr!.parentValues ?? [])
      : null;
    const skipUnmatched = parentArr && matchSet ? matchSet : null;
    const pa = parentArr as unknown as { [k: number]: number } | null;

    if (def.aggregation === 'total') {
      let sum = 0;
      for (let i = 0; i < total; i++) {
        if (skipUnmatched && pa && !skipUnmatched.has(pa[i] as number)) continue;
        sum += arr[i] ?? 0;
      }
      linkedResults[def.id] = sum;
      continue;
    }
    // frequency
    if (def.attrType === 'bool') {
      let t = 0;
      let counted = 0;
      for (let i = 0; i < total; i++) {
        if (skipUnmatched && pa && !skipUnmatched.has(pa[i] as number)) continue;
        counted++;
        if (arr[i]) t++;
      }
      linkedResults[def.id] = { 'true': t, 'false': counted - t };
    } else if (def.attrType === 'tag') {
      const opts = def.tagOptions || [];
      const freq: Record<string, number> = {};
      for (const name of opts) freq[name] = 0;
      for (let i = 0; i < total; i++) {
        if (skipUnmatched && pa && !skipUnmatched.has(pa[i] as number)) continue;
        const idx = arr[i] ?? 0;
        const name = opts[idx];
        if (name !== undefined) freq[name] = (freq[name] ?? 0) + 1;
      }
      linkedResults[def.id] = freq;
    } else if (def.attrType === 'integer') {
      const freq: Record<string, number> = {};
      for (let i = 0; i < total; i++) {
        if (skipUnmatched && pa && !skipUnmatched.has(pa[i] as number)) continue;
        const k = String(arr[i] ?? 0);
        freq[k] = (freq[k] ?? 0) + 1;
      }
      linkedResults[def.id] = freq;
    } else if (def.attrType === 'float') {
      const bins = Math.max(1, def.binCount ?? 10);
      let mn = Infinity, mx = -Infinity;
      let counted = 0;
      for (let i = 0; i < total; i++) {
        if (skipUnmatched && pa && !skipUnmatched.has(pa[i] as number)) continue;
        const v = arr[i] ?? 0;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
        counted++;
      }
      if (!Number.isFinite(mn) || !Number.isFinite(mx) || mn === mx) {
        linkedResults[def.id] = { [`${(mn || 0).toFixed(2)}\u2013${(mn || 0).toFixed(2)}`]: counted };
        continue;
      }
      const range = mx - mn;
      const step = range / bins;
      const counts: number[] = new Array(bins).fill(0);
      for (let i = 0; i < total; i++) {
        if (skipUnmatched && pa && !skipUnmatched.has(pa[i] as number)) continue;
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

/** Spatial indicators (chromatogram): for each watched linked indicator whose
 *  xAxis is 'rows' or 'columns', bin every cell by its position along that axis
 *  and aggregate per bin using the SAME per-attribute-type logic as
 *  computeLinkedIndicatorsFromBuffer. The result is `Record<seriesKey, number[]>`
 *  \u2014 each array indexed by position bin (length = bin count), each key a series
 *  (a curve in the chromatogram). Reuses the existing per-type buckets as
 *  series: bool \u2192 true/false; tag \u2192 one per option; integer freq \u2192 one per
 *  distinct value; total \u2192 single 'total'; float freq \u2192 one per value-bin (a
 *  2-D value\u00d7position histogram).
 *
 *  CPU-only, runs on all targets post-step (see the runStep call site and the
 *  finalizeStepWebGPU readback path). Reads `readAttrs`, which holds the
 *  just-computed generation at every call site. Mirror of the linked path \u2014
 *  keep the per-type branches in sync. */
function computeSpatialIndicators(): void {
  for (const def of linkedDefs) {
    if (!def.watched) continue;
    // 3D Grid CA: 'layers' is the Z spatial axis (bins by floor(i/(W*H))).
    if (def.xAxis !== 'rows' && def.xAxis !== 'columns' && def.xAxis !== 'layers') continue;
    const arr = readAttrs[def.attrId ?? ''];
    if (!arr || !def.attrType || !def.aggregation) continue;
    if (width < 1 || height < 1) continue;

    // --- Resolve the position-bin count + a per-cell position\u2192bin mapper. ---
    const axisLen = def.xAxis === 'layers' ? depth : def.xAxis === 'rows' ? height : width;
    const mode = def.spatialBinMode === 'absolute' ? 'absolute' : 'slices';
    let binSize = 1;
    let B: number;
    if (mode === 'absolute') {
      binSize = Math.max(1, Math.floor(def.spatialBinSize ?? 1));
      B = Math.max(1, Math.ceil(axisLen / binSize));
    } else {
      B = Math.max(2, Math.min(axisLen, Math.floor(def.spatialBinCount ?? 50)));
    }
    if (B < 1) continue;
    const xAxis = def.xAxis;  // 'rows' | 'columns' | 'layers'
    const WH = width * height;
    const posBin = (i: number): number => {
      // 3D-correct decode (layer/row/col within the layer); 2D reduces to it.
      const layer = Math.floor(i / WH);
      const rem = i - layer * WH;
      const row = Math.floor(rem / width);
      const col = rem - row * width;
      const pos = xAxis === 'layers' ? layer : xAxis === 'rows' ? row : col;
      let b = mode === 'absolute'
        ? Math.floor(pos / binSize)
        : Math.floor((pos / axisLen) * B);
      if (b >= B) b = B - 1;
      else if (b < 0) b = 0;
      return b;
    };

    // --- Sub-attribute guard (identical to the linked path). ---
    const linkedAttr = cellAttrs.find(a => a.id === def.attrId);
    const isSubAttr = !!linkedAttr?.parentAttributeId;
    const parent = isSubAttr
      ? cellAttrs.find(p => p.id === linkedAttr!.parentAttributeId)
      : null;
    const parentArr = (parent && readAttrs[parent.id]) || null;
    const matchSet = isSubAttr && parent
      ? buildParentMatchSet(parent, linkedAttr!.parentValues ?? [])
      : null;
    const skipUnmatched = parentArr && matchSet ? matchSet : null;
    const pa = parentArr as unknown as { [k: number]: number } | null;
    const newSeries = (): number[] => new Array(B).fill(0) as number[];

    if (def.aggregation === 'total') {
      const series = newSeries();
      for (let i = 0; i < total; i++) {
        if (skipUnmatched && pa && !skipUnmatched.has(pa[i] as number)) continue;
        series[posBin(i)]! += arr[i] ?? 0;
      }
      linkedResults[def.id] = { total: series };
      continue;
    }
    // frequency
    if (def.attrType === 'bool') {
      const t = newSeries();
      const f = newSeries();
      for (let i = 0; i < total; i++) {
        if (skipUnmatched && pa && !skipUnmatched.has(pa[i] as number)) continue;
        const b = posBin(i);
        if (arr[i]) t[b]! += 1; else f[b]! += 1;
      }
      linkedResults[def.id] = { 'true': t, 'false': f };
    } else if (def.attrType === 'tag') {
      const opts = def.tagOptions || [];
      const result: Record<string, number[]> = {};
      for (const name of opts) result[name] = newSeries();
      for (let i = 0; i < total; i++) {
        if (skipUnmatched && pa && !skipUnmatched.has(pa[i] as number)) continue;
        const name = opts[arr[i] ?? 0];
        if (name !== undefined) result[name]![posBin(i)]! += 1;
      }
      linkedResults[def.id] = result;
    } else if (def.attrType === 'integer') {
      const result: Record<string, number[]> = {};
      for (let i = 0; i < total; i++) {
        if (skipUnmatched && pa && !skipUnmatched.has(pa[i] as number)) continue;
        const k = String(arr[i] ?? 0);
        (result[k] ?? (result[k] = newSeries()))[posBin(i)]! += 1;
      }
      linkedResults[def.id] = result;
    } else if (def.attrType === 'float') {
      // 2-D histogram: value-bins (via binCount) become series; each series is
      // an array over position bins. Pre-scan min/max over matching cells.
      const vbins = Math.max(1, def.binCount ?? 10);
      let mn = Infinity, mx = -Infinity;
      for (let i = 0; i < total; i++) {
        if (skipUnmatched && pa && !skipUnmatched.has(pa[i] as number)) continue;
        const v = arr[i] ?? 0;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      if (!Number.isFinite(mn) || !Number.isFinite(mx)) {
        linkedResults[def.id] = {};
        continue;
      }
      if (mn === mx) mx = mn + 1;
      const range = mx - mn;
      const vstep = range / vbins;
      const labels: string[] = [];
      const result: Record<string, number[]> = {};
      for (let vb = 0; vb < vbins; vb++) {
        const lo = mn + vb * vstep;
        const hi = vb === vbins - 1 ? mx : mn + (vb + 1) * vstep;
        const lab = `${lo.toFixed(2)}\u2013${hi.toFixed(2)}`;
        labels.push(lab);
        result[lab] = newSeries();
      }
      for (let i = 0; i < total; i++) {
        if (skipUnmatched && pa && !skipUnmatched.has(pa[i] as number)) continue;
        const v = arr[i] ?? 0;
        let vb = Math.floor(((v - mn) / range) * vbins);
        if (vb >= vbins) vb = vbins - 1;
        else if (vb < 0) vb = 0;
        result[labels[vb]!]![posBin(i)]! += 1;
      }
      linkedResults[def.id] = result;
    }
  }
}

/** Build and post the current attribute values for every cell index the main
 *  thread is inspecting. No-op when the subscription set is empty. Under
 *  WebGPU, callers MUST ensure `readAttrs` is fresh (via ensureCpuAttrsFresh)
 *  before invoking — otherwise the CPU mirror is stale. */
function postInspectCellsData(): void {
  if (inspectCellIdxs.length === 0) return;
  const data: Record<number, Record<string, number>> = {};
  const colorsByCell: Record<number, { r: number; g: number; b: number }> = {};
  const orientationsByCell: Record<number, number> = {};
  for (const idx of inspectCellIdxs) {
    if (idx < 0 || idx >= total) continue;
    const attrs: Record<string, number> = {};
    for (const attr of cellAttrs) {
      const arr = readAttrs[attr.id];
      if (arr) attrs[attr.id] = arr[idx]!;
    }
    data[idx] = attrs;
    // Per-cell RGB so the popover swatch works uniformly under JS / WASM /
    // WebGPU (direct render skips the full colors transfer to the main thread,
    // so the popover can't rely on `colorsRef`). The worker's `colors` typed
    // array is kept fresh because finalizeStepWebGPU's `wantColors` is
    // forced true while any inspect popup is subscribed, and the subscription
    // entry point readback-colors before the first postInspectCellsData fire.
    const base = idx * 4;
    if (colors.length >= base + 3) {
      colorsByCell[idx] = { r: colors[base]!, g: colors[base + 1]!, b: colors[base + 2]! };
    }
    // Variegated cells: include the orientation so the popover can show it as
    // an extra row alongside user attributes. Lets users sanity-check that
    // rotation rules are firing and that face-pattern lookups are using the
    // right slot. Absent (undefined) when variegation isn't enabled — the
    // main-thread receiver checks before adding to its map.
    if (orientationReadView) {
      orientationsByCell[idx] = orientationReadView[idx]!;
    }
  }
  self.postMessage({ type: 'inspectCellsData', data, colors: colorsByCell, orientations: orientationsByCell });
}

function sendColors(): void {
  // Only build indicators payload when there are entries (avoids overhead when no indicators)
  const hasStandalone = standaloneIds.length > 0;
  const hasLinked = linkedDefs.length > 0;
  let indicators: Record<string, number | Record<string, number> | Record<string, number[]>> | undefined;
  if (hasStandalone || hasLinked) {
    indicators = {};
    for (const { idx, id } of standaloneIds) {
      indicators[id] = cachedIndicators[idx]!;
    }
    for (const id of Object.keys(linkedResults)) {
      const result = linkedResults[id]!;
      const def = linkedDefs.find(d => d.id === id);
      if (def && def.aggregation === 'frequency'
          && def.trackedValues && def.trackedValues.length
          && result && typeof result === 'object') {
        // Categorical (bool/tag) frequency: ship only the user-selected categories
        // so a dominant category (e.g. solvent) doesn't flatten the rest on a
        // shared Y-axis. Values are number (generation axis) or number[] (spatial);
        // copy either through. Single filter point ⇒ covers JS / WASM / WebGPU.
        const src = result as Record<string, number | number[]>;
        const filtered: Record<string, number | number[]> = {};
        for (const k of def.trackedValues) { if (k in src) filtered[k] = src[k]!; }
        indicators[id] = filtered as unknown as Record<string, number>;
      } else {
        indicators[id] = result;
      }
    }
  }
  // Build glyph payload when the model uses setCellGlyph AND there are any
  // non-zero entries. Quick-scan via a single-pass length-aware probe (cheap
  // even at 5000²: ~5–10 ms typed-array scan worst case, often early-exits
  // on a small region of zeros). Sent as detached Uint32Array transfers.
  let glyphsPayload: { codes: Uint32Array; colors: Uint32Array } | undefined;
  if (glyphCodes && glyphColors) {
    let any = false;
    for (let i = 0; i < glyphCodes.length; i++) {
      if (glyphCodes[i] !== 0) { any = true; break; }
    }
    if (any) {
      glyphsPayload = {
        codes: new Uint32Array(glyphCodes),
        colors: new Uint32Array(glyphColors),
      };
    }
  }

  // Bond-Graph Agents — attach a render snapshot (copies of the live region)
  // so the entity renderer + nearest-agent picker have current positions every
  // frame. Cheap (maxAgents is small); copies, so the engine keeps its SoA.
  let agentsPayload: ReturnType<typeof snapshotAgentsForRender> | undefined;
  const agentTransfers: ArrayBuffer[] = [];
  if (agentStore && agentStore.highWater > 0) {
    agentsPayload = snapshotAgentsForRender(agentStore);
    agentTransfers.push(
      agentsPayload.x.buffer, agentsPayload.y.buffer, agentsPayload.vx.buffer, agentsPayload.vy.buffer,
      agentsPayload.radius.buffer,
      agentsPayload.alive.buffer, agentsPayload.colors.buffer, agentsPayload.type.buffer,
      agentsPayload.bonds.buffer,
    );
    // z/vz are length-0 placeholders in 2D (the A1 snapshot gate) — transfer them
    // only when 3D populated them, else an empty buffer is harmlessly cheap but
    // we skip it for symmetry with the gate.
    if (agentsPayload.z.length > 0) agentTransfers.push(agentsPayload.z.buffer, agentsPayload.vz.buffer);
  } else if (agentStore) {
    // Empty store — still tell the main thread so it clears any stale agents.
    agentsPayload = { highWater: 0, liveCount: 0, x: new Float64Array(0), y: new Float64Array(0), z: new Float64Array(0), vx: new Float64Array(0), vy: new Float64Array(0), vz: new Float64Array(0), radius: new Float64Array(0), alive: new Uint8Array(0), colors: new Uint8ClampedArray(0), type: new Int32Array(0), bonds: new Int32Array(0) };
  }

  // P7 — when WebGPU direct render is active, the OffscreenCanvas already
  // holds the latest frame; skip the colors transfer entirely. Main-thread
  // draw() detects this and only does the zoom/pan composite. Exception:
  // when GIF recording is on, finalizeStepWebGPU populated the `colors`
  // mirror via readback so the main thread can capture frames.
  if (webgpuRuntime?.directRender && !recording) {
    if (glyphsPayload) {
      self.postMessage(
        { type: 'stepped', generation, indicators, glyphCodes: glyphsPayload.codes, glyphColors: glyphsPayload.colors, agents: agentsPayload },
        { transfer: [glyphsPayload.codes.buffer, glyphsPayload.colors.buffer, ...agentTransfers] },
      );
    } else {
      self.postMessage({ type: 'stepped', generation, indicators, agents: agentsPayload }, { transfer: agentTransfers });
    }
    postInspectCellsData();
    return;
  }
  const copy = new Uint8ClampedArray(colors);
  if (glyphsPayload) {
    self.postMessage(
      { type: 'stepped', generation, colors: copy, indicators, glyphCodes: glyphsPayload.codes, glyphColors: glyphsPayload.colors, agents: agentsPayload },
      { transfer: [copy.buffer, glyphsPayload.codes.buffer, glyphsPayload.colors.buffer, ...agentTransfers] },
    );
  } else {
    self.postMessage(
      { type: 'stepped', generation, colors: copy, indicators, agents: agentsPayload },
      { transfer: [copy.buffer, ...agentTransfers] },
    );
  }
  postInspectCellsData();
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
      depth = msg.depth ?? 1;   // 3D Grid CA: absent → 1 (2D)
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
      // Variegated Cells: stash the payload BEFORE initGrid so the layout
      // reserves orientation / facePatternLookup / interactionTable regions
      // in wasmMemory. initVariegation runs AFTER initGrid to fill the
      // reserved regions with computed values.
      variegated = msg.variegated ?? null;
      // Stash lookup-table payloads BEFORE initGrid so the layout sizes each
      // table region (independent of variegation). initVariegation re-sets this.
      lookupTablesPayload = msg.interactionTables ?? [];
      hasLookupTables = lookupTablesPayload.length > 0;
      hasGlyphs = !!(msg as InitMsg).hasGlyphs;
      // initGrid first because it allocates wasmMemory + computes layout that
      // initIndicators / buildNeighborIndices need to create their views over.
      initGrid();
      buildNeighborIndices();
      initIndicators(msg.indicators || []);
      // After memory is allocated, sync model attrs + active viewer ID into it
      // so WASM emitters that read those regions see meaningful values.
      syncModelAttrsToMemory();
      syncActiveViewerToMemory();
      // Variegated Cells: fill the reserved facePatternLookup region + per-
      // table interaction-table regions. WASM emitters read from baked-in
      // offsets; JS-target step also reads through the same Float64Array /
      // Int32Array views (single source of truth).
      initVariegation(msg.variegated, msg.interactionTables);
      compileFns(msg.stepCode, msg.inputColorCodes, msg.outputMappingCodes || [], msg.initCode || '');
      // Bond-Graph Agents — allocate the co-resident agent engine (additive on
      // top of the always-present grid). The agent behaviour/init functions are
      // compiled by compileAgentFns; absent in PR-A2 (agents seed + render only).
      agentsEnabled = !!msg.agents;
      agentUsesField = !!msg.agentUsesField;
      centerBasedConfig = msg.centerBased ?? null;
      agentColorViewer = msg.agentColorViewer || '';
      initAgents();
      compileAgentFns(msg.agentBehaviourCode, msg.agentInitCode, msg.agentDivisionCode);
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
      // Bond-Graph Agents: an agent model can step even with a trivial (or
      // absent) cell step — the agent engine drives the generation.
      if (!stepFn && !webgpuActive && !agentStore) {
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
            // Bond-Graph Agents on a WebGPU grid (PR5 — independent targets,
            // C-D1). ONE generation = the closed agent↔grid loop, same ordering
            // as the JS/WASM branch (agents step BEFORE the cell step), but with
            // the field RESIDENCY bridge: under WebGPU the cell attrs are
            // GPU-resident after a step (gpuOwnsAttrs), so a field model must
            // pull them down before the agents gather, then push the agents'
            // deposit back up before the GPU cell step consumes it.
            //   field model:  GPU→CPU readback → runAgentStep (gather+deposit on
            //                  readAttrs) → CPU→GPU upload → runStepWebGPU.
            //   no-field model: just runAgentStep (writes only the agent SoA +
            //                  colors) → runStepWebGPU. ZERO readbacks.
            // The JS/WASM per-generation loop is left LITERALLY unchanged — the
            // bridge lives ONLY here (the WebGPU branch is already async, so the
            // `await ensureCpuAttrsFresh()` fits; you cannot await in the sync
            // JS/WASM `for` loop). Two paths, never one.
            // GAP-2 (3D cost): readAttrs is now sized `total = W*H*D`, so for a
            // 3D-agent + WebGPU-grid FIELD model this readback + re-upload moves
            // D× more bytes PER STEP than the 2D case (the whole W*H*D field down
            // then up every generation). Field-heavy 3D-agent models pay a D×
            // per-step residency tax on WebGPU — prefer JS/WASM agents there, or a
            // shallow depth, until a same-device zero-copy field lands (Phase F).
            if (agentStore && webgpuRuntime) {
              if (agentUsesField && gpuOwnsAttrs) {
                await ensureCpuAttrsFresh();        // GPU→CPU; flips gpuOwnsAttrs=false
              }
              runAgentStep();                        // gather reads readAttrs (fresh); deposit writes readAttrs
              if (agentUsesField) {
                uploadAttrs(webgpuRuntime, readAttrs); // CPU→GPU, before the cell step
                gpuOwnsAttrs = false;
              }
            }
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
        // Bond-Graph Agents — one generation = the closed agent↔grid loop:
        //  (gather) agents SampleField the grid as of the previous cell step,
        //  (behave) run behaviourStep + integrate forces + the structural phase,
        //  (deposit) AffectCellsUnder / SecreteToField write the cell READ
        //   buffer — THEN the cell CA steps, incorporating the deposit (its
        //  w.set(r) copy carries it; a diffusion rule spreads it). So the agent
        //  step runs BEFORE the cell step (Decision D-FIELD: the field IS the
        //  lattice CA, only the scatter/gather bridge is new).
        if (agentStore) runAgentStep();
        if (stepFn) runStep();
        const rawStop = stopFlag[0] ?? 0;
        if (rawStop !== 0) {
          const idx = rawStop - 1;
          stoppedByEvent = stopMessages[idx] ?? `Stop event #${idx}`;
          stopFlag[0] = 0;
          break;
        }
      }
      if (stepFn && !msg.skipColorPass) runColorPass();
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
          const lyr = c.layer ?? 0;
          if (!inBounds3d(lyr, c.row, c.col)) continue;
          const idx = cellIndexOf(lyr, c.row, c.col);

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
        const webgpuPaint = useWebGPU && webgpuRuntime?.stepReady;
        if (webgpuPaint && webgpuRuntime) {
          // Patch only the painted cells — the rest of the GPU buffer holds
          // evolved state we mustn't clobber with the stale CPU mirror.
          const idxs: number[] = [];
          for (const c of msg.cells) {
            const lyr = c.layer ?? 0;
            if (!inBounds3d(lyr, c.row, c.col)) continue;
            idxs.push(cellIndexOf(lyr, c.row, c.col));
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
        refreshColorsAfterInputJS();
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

    case 'paintManual': {
      activeViewer = msg.activeViewer; syncActiveViewerToMemory();

      // Pre-compute per-set sub-attribute metadata once (not per cell).
      // subAttrInfo / parentValueToInt are typed against `Attribute`; our
      // AttrDef is a structural subset that carries the same relevant
      // fields (type, parentAttributeId, parentValues, tagOptions), so a
      // shape cast is safe here.
      const setEntries = msg.sets.map(s => {
        const attr = cellAttrs.find(a => a.id === s.attrId);
        if (!attr) return { s, info: null as null | { parentId: string; values: number[] } };
        const info = subAttrInfo(attr as unknown as Attribute, { attributes: cellAttrs as unknown as Attribute[] });
        if (!info) return { s, info: null };
        return {
          s,
          info: {
            parentId: info.parent.id,
            values: info.parentValues.map(v => parentValueToInt(info.parent, v)),
          },
        };
      }).filter(e => cellAttrs.some(a => a.id === e.s.attrId));
      // Brush-parent override: if a parent attribute is itself in `sets`, the
      // brush's value takes precedence over the cell's stored parent value
      // when deciding sub-attribute writability.
      const brushParentOverride = new Map<string, number>();
      for (const s of msg.sets) brushParentOverride.set(s.attrId, s.value);

      const isSync = updateMode !== 'asynchronous';

      const applyManual = (): void => {
        for (const c of msg.cells) {
          const lyr = c.layer ?? 0;
          if (!inBounds3d(lyr, c.row, c.col)) continue;
          const idx = cellIndexOf(lyr, c.row, c.col);
          for (const { s, info } of setEntries) {
            if (info) {
              const pv = brushParentOverride.has(info.parentId)
                ? brushParentOverride.get(info.parentId)!
                : (readAttrs[info.parentId]?.[idx] as number | undefined);
              if (pv === undefined) continue;
              if (!info.values.includes(pv)) continue; // SKIP this cell for this sub-attr
            }
            const buf = readAttrs[s.attrId];
            if (!buf) continue;
            buf[idx] = s.value;
            // In sync mode the step copies r→w at the top of the next step,
            // but a paint that lands between steps must keep both buffers
            // consistent so InputColor / step compiled functions see the new
            // value through w_<id>[idx] reads as well. Async shares one buffer.
            if (isSync) writeAttrs[s.attrId]![idx] = s.value;
          }
        }

        // Display refresh — mirror of `paint` tail.
        const webgpuPaint = useWebGPU && webgpuRuntime?.stepReady;
        if (webgpuPaint && webgpuRuntime) {
          const idxs: number[] = [];
          for (const c of msg.cells) {
            const lyr = c.layer ?? 0;
            if (!inBounds3d(lyr, c.row, c.col)) continue;
            idxs.push(cellIndexOf(lyr, c.row, c.col));
          }
          patchWebGPUCells(idxs);
          uploadActiveViewer(webgpuRuntime, viewerIdMap[activeViewer] ?? -1);
          refreshColorsAfterInputWebGPU();
          finalizeStepWebGPU({ needColors: true }).then(() => sendColors())
            .catch(e => self.postMessage({ type: 'error', message: '[webgpu] paintManual colorPass failed: ' + ((e instanceof Error) ? e.message : String(e)) }));
          return;
        }
        refreshColorsAfterInputJS();
        sendColors();
      };

      // After a Play sequence on WebGPU, the live state lives on GPU and the
      // CPU `readAttrs` is stale. The sub-attribute filter reads parent values
      // from `readAttrs[parentId][idx]`, so pull state down once before
      // iterating cells. Only needed when at least one sub-attr is being set
      // AND the parent isn't being overridden by the brush itself.
      const needsReadback = useWebGPU && webgpuRuntime?.stepReady && gpuOwnsAttrs
        && setEntries.some(e => e.info && !brushParentOverride.has(e.info.parentId));
      if (needsReadback && webgpuRuntime) {
        const rt = webgpuRuntime;
        readbackAttrs(rt, readAttrs).then(() => {
          gpuOwnsAttrs = false;
          applyManual();
        }).catch(e => self.postMessage({ type: 'error', message: '[webgpu] paintManual readback failed: ' + ((e instanceof Error) ? e.message : String(e)) }));
        break;
      }
      applyManual();
      break;
    }

    case 'randomize': {
      activeViewer = msg.activeViewer; syncActiveViewerToMemory();
      randomizeGrid();
      const webgpuRandomize = useWebGPU && webgpuRuntime?.stepReady;
      if (webgpuRandomize && webgpuRuntime) {
        uploadAttrs(webgpuRuntime, readAttrs);
        if (orientationReadView) uploadOrientation(webgpuRuntime, orientationReadView);
        uploadActiveViewer(webgpuRuntime, viewerIdMap[activeViewer] ?? -1);
        syncIndicatorsCpuToGpu();
        gpuOwnsAttrs = false;
        // refreshColorsAfterInputWebGPU dispatches the OM pipeline if the active
        // viewer has one; falls back to a step shader (which writes colors via
        // SetColorViewer-in-step) for viewers like MNCA's "Decorated Trace".
        // Without this fallback, no-OM viewers wouldn't visually update on
        // randomize/reset under WebGPU.
        refreshColorsAfterInputWebGPU();
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
      // Bond-Graph Agents — Reset re-seeds the agent population (clear + re-seed
      // the configured initial count + the agent Init Event, PR-A3). Re-allocates
      // the store from the live config so a config edit (maxAgents/seedCount/…)
      // takes effect on Reset.
      if (agentsEnabled) { initAgents(); runAgentInit(); runAgentColorPass(); }
      // Init Event runs once per cell on Reset only (not on Randomize, not on
      // Load State). When present, it modifies attrs in place AFTER defaults
      // have been applied and BEFORE the color pass / GPU upload.
      const webgpuReset = useWebGPU && webgpuRuntime?.stepReady;
      const useGPUInit = !!(webgpuReset && webgpuRuntime?.initPipeline);
      const hadInit = initFn !== null || (useWasm && wasmInitFn !== null) || useGPUInit;
      // GPU init path: push the CPU defaults to GPU BEFORE dispatching init so
      // the init shader reads from a known-good attrsReadBuf. dispatchInit then
      // writes + swaps; the GPU owns the post-init state.
      if (useGPUInit && webgpuRuntime) {
        uploadAttrs(webgpuRuntime, readAttrs);
        if (orientationReadView) uploadOrientation(webgpuRuntime, orientationReadView);
      }
      runInit();
      if (hadInit) {
        // Init wrote to attrs after resetGrid's color refresh — recompute
        // colors so the user sees the post-init state, not the defaults.
        // WebGPU path skips this and recomputes via runColorPassWebGPU below.
        if (!(useWebGPU && webgpuRuntime?.stepReady)) refreshColorsAfterInputJS();
      }
      if (webgpuReset && webgpuRuntime) {
        // When the JS / WASM init ran (no GPU init pipeline), CPU readAttrs
        // holds the post-init state — push it to GPU. When the GPU init ran,
        // the GPU already owns the post-init attrsReadBuf and uploading again
        // would clobber it.
        if (!useGPUInit) {
          uploadAttrs(webgpuRuntime, readAttrs);
          if (orientationReadView) uploadOrientation(webgpuRuntime, orientationReadView);
        }
        uploadActiveViewer(webgpuRuntime, viewerIdMap[activeViewer] ?? -1);
        syncIndicatorsCpuToGpu();
        gpuOwnsAttrs = useGPUInit;
        refreshColorsAfterInputWebGPU();
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
      compileFns(msg.stepCode, msg.inputColorCodes, (msg as RecompileMsg).outputMappingCodes || [], (msg as RecompileMsg).initCode || '');
      // Bond-Graph Agents: recompile the agent behaviour fn (graph-only edit, no
      // reinit). The store + populations persist (a maxAgents/maxBonds change
      // forces a full reinit instead). Live force/bond params re-clamp Δt.
      {
        const rc = msg as RecompileMsg;
        if (rc.centerBased) centerBasedConfig = rc.centerBased;
        if (rc.agentUsesField !== undefined) agentUsesField = !!rc.agentUsesField;
        compileAgentFns(rc.agentBehaviourCode, rc.agentInitCode, rc.agentDivisionCode);
        clampAgentDt();
      }
      // Variegated Cells: re-fill the facePatternLookup + interaction-table
      // regions in wasmMemory. The regions themselves stay at the same
      // offsets (no reallocation — initGrid sized them at init time from the
      // attribute schema, which a recompile doesn't change). Writes through
      // the existing typed-array views so WASM keeps the same source of truth.
      initVariegation((msg as RecompileMsg).variegated, (msg as RecompileMsg).interactionTables);
      // Push the re-flattened variegation buffers to the GPU as well so a
      // WebGPU recompile picks up the same values (in case interaction tables
      // / facePatternLookup changed). No-op when GPU isn't ready or variegation
      // is off.
      syncVariegationToGPU();
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
      } else if (useWebGPU && recompile.webgpuShaderError) {
        // Only surface WebGPU compile errors when the user has WebGPU selected.
        // Pre-Wave-A-PR1, the sender always speculatively compiled WebGPU and
        // forwarded the error regardless of target — which spammed users with
        // async-only-node errors while running on JS/WASM. Sender now skips
        // the compile when !useWebGPU; this guard is a belt-and-suspenders
        // defence against any stale message that still carries the field.
        self.postMessage({ type: 'error', message: '[webgpu] recompile failed: ' + recompile.webgpuShaderError });
      }
      self.postMessage({ type: 'ready' });
      break;
    }

    case 'setUseWasm': {
      const enableWasm = !!msg.enabled;
      // If the user just turned WASM on, drain GPU state to CPU before tearing
      // down the runtime — otherwise gpuOwnsAttrs CPU mirror is stale and the
      // first JS/WASM step runs against pre-Play data. Then enforce mutual
      // exclusion (WASM on → WebGPU off).
      if (enableWasm && useWebGPU && webgpuRuntime?.stepReady) {
        const rt = webgpuRuntime;
        void (async () => {
          try {
            if (gpuOwnsAttrs) await readbackAttrs(rt, readAttrs);
            gpuOwnsAttrs = false;
          } catch (e) {
            self.postMessage({ type: 'error', message: '[webgpu] setUseWasm drain failed: ' + ((e instanceof Error) ? e.message : String(e)) });
          }
          useWasm = enableWasm;
          useWebGPU = false;
          destroyWebGPURuntime(webgpuRuntime);
          webgpuRuntime = null;
          self.postMessage({ type: 'useWasmStatus', enabled: useWasm, ready: wasmStepFn !== null });
        })();
        break;
      }
      useWasm = enableWasm;
      self.postMessage({ type: 'useWasmStatus', enabled: useWasm, ready: wasmStepFn !== null });
      break;
    }

    case 'setUseWebGPU': {
      const enableWebGPU = !!msg.enabled;
      // Toggling WebGPU OFF: drain GPU → CPU AND mark the runtime's directRender
      // flag false so any subsequent sendColors falls through to the colors-
      // transfer path (otherwise sendColors keeps short-circuiting on the live
      // runtime's stale directRender bit and the canvas freezes silently).
      if (!enableWebGPU && useWebGPU && webgpuRuntime?.stepReady) {
        const rt = webgpuRuntime;
        void (async () => {
          try {
            if (gpuOwnsAttrs) await readbackAttrs(rt, readAttrs);
            gpuOwnsAttrs = false;
          } catch (e) {
            self.postMessage({ type: 'error', message: '[webgpu] setUseWebGPU drain failed: ' + ((e instanceof Error) ? e.message : String(e)) });
          }
          useWebGPU = false;
          if (webgpuRuntime) webgpuRuntime.directRender = false;
          self.postMessage({ type: 'useWebGPUStatus', enabled: useWebGPU, ready: false, directRender: false });
        })();
        break;
      }
      useWebGPU = enableWebGPU;
      if (useWebGPU && useWasm) {
        // Mutual exclusion: WebGPU wins.
        useWasm = false;
      }
      self.postMessage({ type: 'useWebGPUStatus', enabled: useWebGPU, ready: webgpuRuntime?.stepReady ?? false, directRender: webgpuRuntime?.directRender ?? false });
      break;
    }

    case 'setRecording': {
      recording = !!msg.enabled;
      break;
    }

    case 'requestColorsSnapshot': {
      // One-shot colors readback for screenshot under WebGPU direct render.
      // Reads back the current GPU colors buffer and posts the bytes to the
      // main thread. Tag echoed back so the requester can match the response.
      const tag = msg.tag ?? '';
      const rt = webgpuRuntime;
      if (useWebGPU && rt?.stepReady && rt.directRender) {
        void (async () => {
          try {
            await readbackColors(rt, colors);
            const snap = new Uint8ClampedArray(colors);
            self.postMessage(
              { type: 'colorsSnapshot', tag, w: width, h: height, colors: snap },
              { transfer: [snap.buffer] },
            );
          } catch (e) {
            self.postMessage({ type: 'error', message: '[webgpu] colors snapshot failed: ' + ((e instanceof Error) ? e.message : String(e)) });
            self.postMessage({ type: 'colorsSnapshot', tag, w: width, h: height });
          }
        })();
      } else {
        // No WebGPU / no direct render: CPU `colors` mirror is already current
        // (sendColors path keeps it populated). Just ship a copy.
        const snap = new Uint8ClampedArray(colors);
        self.postMessage(
          { type: 'colorsSnapshot', tag, w: width, h: height, colors: snap },
          { transfer: [snap.buffer] },
        );
      }
      break;
    }

    case 'setInspectCells': {
      // Declarative — replace the subscription set. Filter out-of-range
      // indices so a stale popup from before a grid resize doesn't keep
      // emitting garbage. Fire one immediate response so the popup opens
      // populated without waiting for the next step.
      inspectCellIdxs = msg.cellIdxs.filter(i => Number.isInteger(i) && i >= 0 && i < total);
      if (inspectCellIdxs.length > 0) {
        const rt = webgpuRuntime;
        if (useWebGPU && rt?.stepReady) {
          // Under WebGPU direct render, both the CPU attrs mirror and the CPU
          // colors mirror are stale between steps. Readback both before firing
          // the first postInspectCellsData so the popup opens with correct
          // values AND the right swatch RGB.
          void (async () => {
            try {
              await ensureCpuAttrsFresh();
              await readbackColors(rt, colors);
            } catch (e) {
              self.postMessage({ type: 'error', message: '[webgpu] inspect readback failed: ' + ((e instanceof Error) ? e.message : String(e)) });
              return;
            }
            postInspectCellsData();
          })();
        } else {
          postInspectCellsData();
        }
      }
      break;
    }

    case 'refreshDisplay': {
      // Main thread requests a fresh present pass — sent on visibility-return
      // and after a soft recompile completes. Under WebGPU direct render, the
      // OffscreenCanvas can land in an unpresented state after the recompile's
      // device-swap inside startWebGPUInit (unconfigure → configure with new
      // device → dispatch present), and the next compositor frame may show
      // blank until something forces a new dispatch. Re-running the color
      // pass + present here is cheap and idempotent. Posts a fresh `stepped`
      // so the main thread also runs draw() and updates the visible canvas.
      if (useWebGPU && webgpuRuntime?.stepReady) {
        const rt = webgpuRuntime;
        if (rt.directRender) {
          try {
            dispatchColorPassAndPresent(rt, activeViewer);
            self.postMessage({ type: 'stepped', generation });
          } catch (e) {
            self.postMessage({ type: 'error', message: '[webgpu] refreshDisplay failed: ' + ((e instanceof Error) ? e.message : String(e)) });
          }
        } else {
          // Non-direct path: readback colors so the main thread has fresh
          // pixels to drawImage. async IIFE to avoid making onmessage async.
          void (async () => {
            try {
              dispatchOutputMapping(rt, activeViewer);
              await readbackColors(rt, colors);
              self.postMessage({ type: 'stepped', generation, colors: new Uint8ClampedArray(colors) });
            } catch (e) {
              self.postMessage({ type: 'error', message: '[webgpu] refreshDisplay failed: ' + ((e instanceof Error) ? e.message : String(e)) });
            }
          })();
        }
      }
      break;
    }

    case 'attachCanvas': {
      // Main thread deferred the canvas transfer until WebGPU runtime is up.
      // Wire it into the existing runtime via setupDirectRender, then dispatch
      // an immediate color pass + present so the canvas isn't blank when the
      // main thread drawImage's it on the next frame.
      if (!webgpuRuntime || !webgpuRuntime.stepReady) {
        self.postMessage({ type: 'error', message: '[webgpu] attachCanvas before runtime ready' });
        break;
      }
      webgpuRuntime.canvas = msg.canvas;
      try {
        setupDirectRender(webgpuRuntime);
        if (webgpuRuntime.directRender) {
          dispatchColorPassAndPresent(webgpuRuntime, activeViewer);
          self.postMessage({ type: 'stepped', generation });
          self.postMessage({ type: 'useWebGPUStatus', enabled: useWebGPU, ready: true, directRender: true });
        }
      } catch (e) {
        const m = (e instanceof Error) ? e.message : String(e);
        self.postMessage({ type: 'error', message: '[webgpu] attachCanvas failed: ' + m });
      }
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

    case 'updateLookupTable': {
      // Live-tune a single Lookup Table model attribute. The cached Float64Array
      // is a typed-array view over `wasmMemory` at the layout's reserved offset
      // (see initVariegation), so we must COPY into the existing view — never
      // reassign the JS reference — or WASM would lose its source of truth (it
      // reads via baked offsets, not the JS ref).
      const normalized = normalizeLookupTable(msg.values, msg.rowLabels, msg.colLabels);
      const existing = cachedInteractionTables[msg.attrId];
      if (existing && existing.length === normalized.length) {
        existing.set(normalized);
      } else {
        // Fallback path: standalone array (no layout slot, e.g. lookupTable
        // attr added without recompile). JS reads still work; WASM has no
        // offset for it either, so this branch is harmless.
        cachedInteractionTables[msg.attrId] = normalized;
      }
      // WebGPU: upload the new values to varAux so the next step / output
      // mapping reads them. No-op when GPU isn't ready or table isn't in layout.
      const target = cachedInteractionTables[msg.attrId];
      if (target && webgpuRuntime?.stepReady) uploadInteractionTable(webgpuRuntime, msg.attrId, target);
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
      refreshColorsAfterInputJS();
      sendColors();
      break;
    }

    case 'colorPass': {
      activeViewer = msg.activeViewer; syncActiveViewerToMemory();
      const webgpuCp = useWebGPU && webgpuRuntime?.stepReady;
      if (webgpuCp && webgpuRuntime) {
        uploadActiveViewer(webgpuRuntime, viewerIdMap[activeViewer] ?? -1);
        // For no-OM viewers (e.g. MNCA's "Case Colored") refreshColorsAfterInputWebGPU
        // falls back to a step shader dispatch so SetColorViewer-in-step writes land
        // in the colors buffer before the present pass blits — otherwise the canvas
        // freezes on the previous viewer's pixels.
        refreshColorsAfterInputWebGPU();
        finalizeStepWebGPU({ needColors: true }).then(() => sendColors())
          .catch(e => self.postMessage({ type: 'error', message: '[webgpu] colorPass failed: ' + ((e instanceof Error) ? e.message : String(e)) }));
        break;
      }
      // JS fallback: pull GPU → CPU first if a stale runtime is hanging around
      // with gpuOwnsAttrs=true (e.g. WebGPU init succeeded, ran steps, then a
      // recompile error left useWebGPU=true but stepReady=false).
      void (async () => {
        try { await ensureCpuAttrsFresh(); } catch (e) {
          self.postMessage({ type: 'error', message: '[webgpu] colorPass readback failed: ' + ((e instanceof Error) ? e.message : String(e)) });
          return;
        }
        // Mirrors the WebGPU branch: prefer the OM pipeline; fall back to one
        // step for SetColorViewer-in-step viewers; fall back to default colors
        // when no compiled step is available at all.
        refreshColorsAfterInputJS();
        sendColors();
      })();
      break;
    }

    // --- Bond-Graph Agents ---
    case 'seedAgents': {
      activeViewer = msg.activeViewer; syncActiveViewerToMemory();
      if (agentStore) {
        const dr = cbNum(centerBasedConfig, 'defaultRadius');
        const ids = seedAgents(agentStore, msg.agents.map(a => ({ x: a.x, y: a.y, z: a.z, radius: a.radius, type: a.type, lineage: a.lineage })), dr);
        if (ids.length < msg.agents.length) {
          self.postMessage({ type: 'agentOverflow', message: `Agent capacity reached (maxAgents=${agentStore.maxAgents}). ${msg.agents.length - ids.length} agent(s) not created.` });
        }
        // PR3 seed config: write the per-attribute initial values onto each new
        // agent (read + write buffers — single-buffer, so they alias, but mirror
        // the paintAgents shape for clarity / future double-buffering).
        if (msg.sets && msg.sets.length > 0) {
          for (const id of ids) applyAgentSets(agentStore, id, msg.sets);
        }
        runAgentColorPass();
      }
      sendColors();
      break;
    }
    case 'createAgent': {
      activeViewer = msg.activeViewer; syncActiveViewerToMemory();
      if (agentStore) {
        const id = allocAgentSlot(agentStore);
        if (id < 0) {
          self.postMessage({ type: 'agentOverflow', message: `Agent capacity reached (maxAgents=${agentStore.maxAgents}).` });
        } else {
          // z=0 for now — the createAgent msg has no z (the 2D brush/seam); PR5's
          // 3D agent brush adds `msg.z` and threads it here.
          initAgentSlot(agentStore, id, msg.x, msg.y, 0, msg.radius ?? cbNum(centerBasedConfig, 'defaultRadius'), msg.agentType ?? 0, id);
          runAgentColorPass();
        }
      }
      sendColors();
      break;
    }
    case 'killAgents': {
      activeViewer = msg.activeViewer; syncActiveViewerToMemory();
      if (agentStore) {
        for (const id of msg.ids) if (id >= 0 && id < agentStore.highWater) freeAgentSlot(agentStore, id);
        runAgentColorPass();
      }
      sendColors();
      break;
    }
    case 'paintAgents': {
      activeViewer = msg.activeViewer; syncActiveViewerToMemory();
      if (agentStore) {
        for (const id of msg.ids) applyAgentSets(agentStore, id, msg.sets);
        runAgentColorPass();
      }
      sendColors();
      break;
    }
    case 'clearAgents': {
      activeViewer = msg.activeViewer; syncActiveViewerToMemory();
      if (agentStore) clearAgents(agentStore);
      sendColors();
      break;
    }
    case '__setAgentWasmBacked': {
      // AW-MEM (PR6a) DEV proof: toggle the WebAssembly.Memory backing and
      // re-init agents (re-runs init/seed → fresh deterministic state). The
      // caller then steps + getStates to compare bit-for-bit against the
      // plain-array backing. No-op in production (never sent).
      agentWasmBackedDev = !!msg.wasmBacked;
      if (agentsEnabled) { initAgents(); runAgentInit(); runAgentColorPass(); }
      sendColors();
      break;
    }
    case 'formBond': {
      activeViewer = msg.activeViewer; syncActiveViewerToMemory();
      if (agentStore && msg.a >= 0 && msg.b >= 0 && msg.a < agentStore.highWater && msg.b < agentStore.highWater) {
        const L = agentStore.radius[msg.a]! + agentStore.radius[msg.b]!;
        formBond(agentStore, msg.a, msg.b, L, cbNum(centerBasedConfig, 'bondStiffness'));
      }
      sendColors();
      break;
    }
    case 'breakBond': {
      activeViewer = msg.activeViewer; syncActiveViewerToMemory();
      if (agentStore) breakBond(agentStore, msg.a, msg.b);
      sendColors();
      break;
    }
    case 'getAgentState': {
      // On-demand single-agent inspector read. NOT a fattened render snapshot —
      // one tiny round-trip per inspect click (per §3 gotcha #7). A non-live id
      // replies with `live: false`.
      const id = msg.id;
      if (!agentStore || id < 0 || id >= agentStore.highWater || !agentStore.alive[id]) {
        self.postMessage({ type: 'agentState', id, live: false });
        break;
      }
      const s = agentStore;
      const attrs: Record<string, number> = {};
      for (const spec of s.attrSpecs) { const a = s.attrRead[spec.id]; if (a) attrs[spec.id] = a[id]!; }
      // Live bond partner ids (epoch-checked, same discipline as hasBond/render).
      const base = id * s.maxBonds, nb = s.bondCount[id]!;
      const bonds: number[] = [];
      for (let k = 0; k < nb; k++) {
        const p = s.bondPartner[base + k]!;
        if (p >= 0 && s.alive[p] && s.epoch[p] === s.bondPartnerEpoch[base + k]) bonds.push(p);
      }
      self.postMessage({
        type: 'agentState', id, live: true,
        x: s.x[id]!, y: s.y[id]!, z: s.worldDepth > 1 ? s.z[id]! : undefined,
        vx: s.vx[id]!, vy: s.vy[id]!, vz: s.worldDepth > 1 ? s.vz[id]! : undefined,
        radius: s.radius[id]!, agentType: s.type[id]!, lineage: s.lineage[id]!,
        age: s.age[id]!, bondDegree: s.bondCount[id]!, density: s.density[id]!,
        attrs, bonds,
      });
      break;
    }
    case 'moveAgents': {
      // Move brush: write x/y AND xNext/yNext so the next integration doesn't
      // snap the agent back. Wrap/clamp to the world per the model boundary.
      activeViewer = msg.activeViewer; syncActiveViewerToMemory();
      if (agentStore) {
        const s = agentStore, W = s.worldWidth, H = s.worldHeight, D = s.worldDepth;
        const is3d = D > 1;
        for (const m of msg.moves) {
          const id = m.id;
          if (id < 0 || id >= s.highWater || !s.alive[id]) continue;
          let x = m.x, y = m.y;
          if (msg.torus) { x = ((x % W) + W) % W; y = ((y % H) + H) % H; }
          else { x = Math.max(0, Math.min(W, x)); y = Math.max(0, Math.min(H, y)); }
          s.x[id] = x; s.y[id] = y; s.xNext[id] = x; s.yNext[id] = y;
          // 3D move brush carries a z; wrap/clamp it on the depth axis (2D omits z
          // → the always-0 z arm stays untouched, byte-identical to before).
          if (is3d && m.z !== undefined) {
            let z = m.z;
            if (msg.torus) z = ((z % D) + D) % D; else z = Math.max(0, Math.min(D, z));
            s.z[id] = z; s.zNext[id] = z;
          }
        }
        runAgentColorPass();
      }
      sendColors();
      break;
    }
    case 'formBondBatch': {
      // Bond-paint brush: form many bonds at once. formBond is idempotent (it
      // rejects a duplicate via hasBond internally) — re-batching the same pair
      // does not double-bond.
      activeViewer = msg.activeViewer; syncActiveViewerToMemory();
      if (agentStore) {
        const s = agentStore, lambda = cbNum(centerBasedConfig, 'bondStiffness');
        for (const [a, b] of msg.pairs) {
          if (a < 0 || b < 0 || a >= s.highWater || b >= s.highWater || a === b) continue;
          if (!s.alive[a] || !s.alive[b] || hasBond(s, a, b)) continue;
          const L = s.radius[a]! + s.radius[b]!;
          formBond(s, a, b, L, lambda);
        }
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
          generation, width, height, depth,   // 3D Grid CA: echo depth so save doesn't truncate
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
        // Bond-Graph Agents: serialize the holey agent table + ragged bond
        // store + free-list (transferred). PR-B1 hardens the dangling-bond ABI.
        if (agentStore) {
          response.agents = serializeAgentStore(agentStore, transfers);
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

      // Variegated Cells: saved .gcastate files don't carry orientation yet
      // (added when orientation save/load lands as a follow-up). Clear the
      // orientation views so loaded states start with the spec-mandated
      // default (0) instead of stale orientations from the pre-load run.
      if (orientationReadView) {
        orientationReadView.fill(0);
        if (orientationWriteView && orientationWriteView !== orientationReadView) {
          orientationWriteView.fill(0);
        }
      }

      // Restore order array — COPY INTO the existing view rather than
      // replacing the reference. The initial `orderArray` is a typed-array
      // view over `wasmMemory` at `wasmLayout.orderOffset` (see initGrid).
      // Replacing the reference orphans WASM (which reads the order via the
      // baked-in offset, not via the JS reference): the per-step shuffle then
      // writes to the standalone array while WASM keeps reading the original
      // view's stale contents. Under random-order async this freezes cell
      // iteration into the init-time sequential [0,1,2,...] order — the
      // resulting top-left-first bias propagates directly into any rule that
      // writes per-cell during the step, e.g. Plantbox's "set neighbor's
      // Light direction toward this cell" macro emits biased NI values.
      // Pre-d581232 the load failed silently for NI models so this latent
      // bug never manifested; the working load surfaces it.
      if (msg.orderArray && orderArray) {
        const srcOrder = new Int32Array(msg.orderArray);
        const olen = Math.min(orderArray.length, srcOrder.length);
        for (let i = 0; i < olen; i++) orderArray[i] = srcOrder[i]!;
      }

      // Rebuild neighbor indices for constant boundary sentinel
      buildNeighborIndices();

      // Bond-Graph Agents: restore the agent SoA + bond store. Reject LOUDLY on
      // a structural mismatch (the holey/ragged store can't be silently
      // mis-strided) rather than aborting the whole load.
      if (msg.agents && agentStore) {
        try {
          deserializeAgentStore(agentStore, msg.agents);
          runAgentColorPass();
        } catch (e) {
          self.postMessage({ type: 'error', message: '[agents] load failed: ' + ((e as Error)?.message || e) });
        }
      }

      // Sync restored state to GPU when WebGPU is active.
      if (useWebGPU && webgpuRuntime?.stepReady) {
        uploadAttrs(webgpuRuntime, readAttrs);
        if (orientationReadView) uploadOrientation(webgpuRuntime, orientationReadView);
        uploadNeighborOffsets(webgpuRuntime);
        uploadModelAttrs(webgpuRuntime, cachedModelAttrs as Record<string, number>);
        uploadActiveViewer(webgpuRuntime, viewerIdMap[activeViewer] ?? -1);
        syncIndicatorsCpuToGpu();
        gpuOwnsAttrs = false;
        // Refresh the GPU's color buffer + canvas so the user sees the loaded
        // state, not the pre-loadState pixels left over from init's default
        // colors. Without this, direct-render WebGPU keeps showing the old
        // OffscreenCanvas contents (matches the user-reported "grid turns to
        // default state on load" symptom), and the readback path would ship
        // stale GPU colors to main thread. Mirrors randomize / reset / paint.
        refreshColorsAfterInputWebGPU();
        finalizeStepWebGPU({ needColors: true })
          .then(() => sendColors())
          .catch(e => self.postMessage({ type: 'error', message: '[webgpu] loadState colorPass failed: ' + ((e instanceof Error) ? e.message : String(e)) }));
        break;
      }

      sendColors();
      break;
    }

    case 'readRegion': {
      // Snapshot every cell attribute over the (row, col, w, h) rectangle.
      // Cells outside [0, width) × [0, height) are replaced by the attribute's default value.
      // Under WebGPU after Play, `gpuOwnsAttrs` is true and the CPU mirror is
      // stale — pull it back before reading or Ctrl+C / Ctrl+X copy pre-Play
      // values instead of the visible state.
      void (async () => {
        const m = msg;
        try { await ensureCpuAttrsFresh(); } catch (e) {
          self.postMessage({ type: 'error', message: '[webgpu] readRegion readback failed: ' + ((e instanceof Error) ? e.message : String(e)) });
          return;
        }
        const attrBuffers: Record<string, { type: string; buffer: ArrayBuffer }> = {};
        const transfers: ArrayBuffer[] = [];
        const size = m.w * m.h;
        for (const attr of cellAttrs) {
          const out = createTypedArray(attr.type, size);
          const dv = defaultValue(attr);
          if (dv !== 0) out.fill(dv);
          const src = readAttrs[attr.id]!;
          for (let dr = 0; dr < m.h; dr++) {
            const srcRow = m.row + dr;
            if (srcRow < 0 || srcRow >= height) continue;
            for (let dc = 0; dc < m.w; dc++) {
              const srcCol = m.col + dc;
              if (srcCol < 0 || srcCol >= width) continue;
              out[dr * m.w + dc] = src[srcRow * width + srcCol]!;
            }
          }
          attrBuffers[attr.id] = { type: attr.type, buffer: out.buffer };
          transfers.push(out.buffer);
        }
        self.postMessage({ type: 'regionData', w: m.w, h: m.h, attributes: attrBuffers }, { transfer: transfers });
      })();
      break;
    }

    case 'writeRegion': {
      activeViewer = msg.activeViewer; syncActiveViewerToMemory();
      const isAsync = updateMode === 'asynchronous';
      // 3D Grid CA: the 2D stamp lands on layer `msg.layer` (absent → 0).
      const wLayer = msg.layer ?? 0;
      // Optional shape mask: only cells with mask !== 0 are written.
      const wMask = msg.mask ? new Uint8Array(msg.mask) : null;
      if (wLayer >= 0 && wLayer < depth) for (const attr of cellAttrs) {
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
            const local = dr * msg.w + dc;
            if (wMask && wMask[local] === 0) continue;
            const dstCol = msg.col + dc;
            if (dstCol < 0 || dstCol >= width) continue;
            const i = cellIndexOf(wLayer, dstRow, dstCol);
            const v = src[local]!;
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
        if (wLayer >= 0 && wLayer < depth) for (let dr = 0; dr < msg.h; dr++) {
          const dstRow = msg.row + dr;
          if (dstRow < 0 || dstRow >= height) continue;
          for (let dc = 0; dc < msg.w; dc++) {
            if (wMask && wMask[dr * msg.w + dc] === 0) continue;
            const dstCol = msg.col + dc;
            if (dstCol < 0 || dstCol >= width) continue;
            idxs.push(cellIndexOf(wLayer, dstRow, dstCol));
          }
        }
        patchWebGPUCells(idxs);
        uploadActiveViewer(webgpuRuntime, viewerIdMap[activeViewer] ?? -1);
        refreshColorsAfterInputWebGPU();
        finalizeStepWebGPU({ needColors: true }).then(() => sendColors())
          .catch(e => self.postMessage({ type: 'error', message: '[webgpu] writeRegion colorPass failed: ' + ((e instanceof Error) ? e.message : String(e)) }));
        break;
      }
      // JS / WASM fallback — without the runStep fallback for no-OM viewers,
      // pasting on viewers like MNCA "Decorated Trace" leaves the canvas
      // showing pre-paste colors (the colors buffer is only refreshed by the
      // step shader on those viewers).
      refreshColorsAfterInputJS();
      sendColors();
      break;
    }

    case 'clearRegion': {
      activeViewer = msg.activeViewer; syncActiveViewerToMemory();
      const isAsync = updateMode === 'asynchronous';
      const cLayer = msg.layer ?? 0;   // 3D Grid CA: target layer (absent → 0)
      const cMask = msg.mask ? new Uint8Array(msg.mask) : null;
      if (cLayer >= 0 && cLayer < depth) for (const attr of cellAttrs) {
        const dv = defaultValue(attr);
        const dst = readAttrs[attr.id]!;
        const dstB = writeAttrs[attr.id]!;
        for (let dr = 0; dr < msg.h; dr++) {
          const dstRow = msg.row + dr;
          if (dstRow < 0 || dstRow >= height) continue;
          for (let dc = 0; dc < msg.w; dc++) {
            if (cMask && cMask[dr * msg.w + dc] === 0) continue;
            const dstCol = msg.col + dc;
            if (dstCol < 0 || dstCol >= width) continue;
            const i = cellIndexOf(cLayer, dstRow, dstCol);
            dst[i] = dv;
            if (!isAsync) dstB[i] = dv;
          }
        }
      }
      const webgpuClear = useWebGPU && webgpuRuntime?.stepReady;
      if (webgpuClear && webgpuRuntime) {
        // Patch only the cleared region; preserve the rest of the GPU state.
        const idxs: number[] = [];
        if (cLayer >= 0 && cLayer < depth) for (let dr = 0; dr < msg.h; dr++) {
          const dstRow = msg.row + dr;
          if (dstRow < 0 || dstRow >= height) continue;
          for (let dc = 0; dc < msg.w; dc++) {
            if (cMask && cMask[dr * msg.w + dc] === 0) continue;
            const dstCol = msg.col + dc;
            if (dstCol < 0 || dstCol >= width) continue;
            idxs.push(cellIndexOf(cLayer, dstRow, dstCol));
          }
        }
        patchWebGPUCells(idxs);
        uploadActiveViewer(webgpuRuntime, viewerIdMap[activeViewer] ?? -1);
        refreshColorsAfterInputWebGPU();
        finalizeStepWebGPU({ needColors: true }).then(() => sendColors())
          .catch(e => self.postMessage({ type: 'error', message: '[webgpu] clearRegion colorPass failed: ' + ((e instanceof Error) ? e.message : String(e)) }));
        break;
      }
      // JS / WASM fallback — same shape as writeRegion above. No-OM viewers
      // rely on the step shader to repaint colors.
      refreshColorsAfterInputJS();
      sendColors();
      break;
    }
  }
};

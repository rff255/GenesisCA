/**
 * Web Worker for GenesisCA simulation.
 * Uses Structure of Arrays (SoA) for grid state ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â one typed array per attribute.
 * Pre-computes neighbor index tables for zero-cost boundary handling.
 */

import { instantiateWasmModule } from '../../modeler/vpl/compiler/wasm/compile';
import { hexToRgba } from '../../model/colorHex';
import { buildFacePatternLookup, normalizeLookupTablePayload } from '../../modeler/vpl/compiler/variegation';
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
  setupVoxelRender, uploadVoxelView, uploadVoxelViz, presentVoxels, destroyVoxelRender, debugReadVoxelInstances,
  type WebGPURuntime, type ReadbackRegion, type VoxelRenderView,
} from './webgpuRuntime';
import { decodeReductions, gpuHandledIds, gpuHandledAttrIds } from './webgpuReduce';
import { encodeAttrValue } from '../../model/attrValueEncoding';
import { subAttrInfo, parentValueToInt } from '../../modeler/vpl/compiler/subAttribute';
import { buildActiveOffsets, createActiveSet, rebuildActiveSet, applyTransition, compactActiveSet, type ActiveSet } from './activeSet';
import { packNI, packNI3 } from '../../modeler/vpl/compiler/niCodec';
import type { Attribute, CenterBasedConfig, SkipIsolatedEmptyConfig } from '../../model/types';
import { cbNum, usesBondingPhysics, usesSoftCollision, usesPositionalCollision, usesEngineSprings, usesEngineGrowth } from '../../model/centerBased';
import {
  createAgentStore, seedAgents, clearAgents, allocAgentSlot, initAgentSlot, freeAgentSlot, freeStagedSlot,
  snapshotAgentsForRender, advanceAgentSprites, serializeAgentStore, deserializeAgentStore, buildSpatialHash,
  resolvePositionalCollisions,
  formBond, breakBond, hasBond, sweepStaleBonds, divideAgent,
  primeAgentAttrWrite, swapAgentAttrs, computeAgentMaxHashBins, AGENT_HASH_BIN_CAP,
  type AgentStore, type AgentSeedSpec, type AgentStatePayload, type AgentAttrSpec, type SpatialHash,
  type AgentLayoutExtras,
} from './agentEngine';
import { instantiateAgentWasm } from '../../modeler/vpl/compiler/agentWasm/compile';
import { buildAgentAbiArgs, type AgentAbiShape, type AgentAbiRuntime } from '../../modeler/vpl/compiler/agentAbi';
import { computeAgentWebGPULayout, type AgentWebGPULayout } from '../../modeler/vpl/compiler/agentWebgpu/layout';
import {
  createAgentWebGPURuntime, destroyAgentWebGPURuntime, uploadAgentSoA, uploadAgentHash,
  uploadAgentControl, uploadAgentForceControl, dispatchAgentStep, readbackAgentStep, uploadAgentSpawnCursor, resetAgentStopFlag,
  uploadAgentField, readbackAgentField,
  primeAgentFieldFromGrid, foldAgentFieldToGrid,
  uploadAgentAux, uploadAgentIndicators, readbackAgentIndicators, uploadAgentBondStore,
  ensureAgentResident, computeResidentHashParams, uploadAgentHashParams, dispatchResidentBatch, readbackAgentFrame,
  setupAgentDirectRender, uploadAgentRenderView, uploadAgentRenderView3D, presentAgentsOnce, presentAgentsFromStore,
  setupAgentCompositeRender, presentAgentCompositeFromStore, debugReadCompositePixels,
  createAgentRenderOnlyRuntime, presentAgentRenderFromStore, destroyAgentRenderSurface,
  type AgentWebGPURuntime, type AgentRenderSurface, type FieldArray, type AgentRenderView, type AgentRenderView3D, type AgentOMShaderInput,
} from './agentWebgpuRuntime';
// E1 device-leak metric (DEV/verification only — surfaced through the __e1bCounters
// probe so the "one adapter, balanced refcount" claim is reproducible from the
// committed tree; a page-side import() would get a DIFFERENT module instance).
import { sharedGpuRefCount, sharedGpuAdapterRequestCount } from './sharedGpuDevice';

/** A camera/graphics view is either the 2D disc view or the Phase C 3D sphere view
 *  (distinguished by `mode: '3d'`). One setAgentCamera message carries either. */
type AgentRenderViewAny = AgentRenderView | AgentRenderView3D;
/** Route a view to the right uniform uploader by dimension. */
function applyAgentRenderView(rt: AgentRenderSurface, view: AgentRenderViewAny): void {
  if ((view as AgentRenderView3D).mode === '3d') uploadAgentRenderView3D(rt, view as AgentRenderView3D);
  else uploadAgentRenderView(rt, view as AgentRenderView);
}

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
  /** Generic Agent Platform: cell attributes only ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the agent field-access
   *  permission. Drives `fieldSpecs` (which cell attrs are threaded as
   *  `_field_<id>` into the agent loop). Inert on agent attributes. */
  agentAccess?: 'none' | 'read' | 'readWrite';
}

interface NeighborhoodDef {
  id: string;
  coords: Array<[number, number]>;
  /** 3D Grid CA: present on a 3D neighbourhood ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â entries are `[dr, dc, dl]`
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
  /** Map from tagOption name ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ FacePattern.id. */
  facePatternAssignments: Record<string, string>;
}
interface InteractionTablePayload {
  id: string;
  /** Resolved row / column label lists for THIS table (a face palette ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢
   *  ['none', ...labels], or a tag attribute ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ its tagOptions). The flat
   *  storage is `rowLabels.length * colLabels.length` Float64Array, indexed
   *  `(rowIdx * colLabels.length + colIdx)`. Rectangular tables supported. */
  rowLabels: string[];
  colLabels: string[];
  /** Sparse `[rowLabel][colLabel] ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ number`. Missing entries default to 0. */
  values: Record<string, Record<string, number>>;
  /** MULTI-AXIS (N-D) tables: per-axis dims + the dense row-major data
   *  (labels/values ride empty). Present ⇔ multi-axis. Normalized via
   *  `normalizeLookupTablePayload` — the flat storage is `Π dims` f64. */
  dims?: number[];
  data?: number[];
  /** Multi-axis only: per-axis intRange index offsets (for the layout's slot). */
  mins?: number[];
}

interface InitMsg {
  type: 'init';
  width: number;
  height: number;
  /** 3D Grid CA: layer count. Absent ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ 1 (a 2D grid, byte-identical). */
  depth?: number;
  attributes: AttrDef[];
  /** Generic Agent Platform: the AGENT attribute set (agent-only per-agent state,
   *  a separate id-space from `attributes`). Drives the agent SoA (buildAgentAttrSpecs
   *  maps these) + the `r_`/`w_` channel. Absent ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ empty (no agent attrs). */
  agentAttributes?: AttrDef[];
  neighborhoods: NeighborhoodDef[];
  boundaryTreatment: string;
  updateMode: string;
  asyncScheme: string;
  stepCode: string;
  /** Optional per-cell init function source (loop-wrapped). When present, the
   *  reset handler runs it once after default values are applied and before
   *  the first color pass. */
  initCode?: string;
  /** Optional GLOBAL Grid Init Event function source (NOT loop-wrapped). Runs
   *  once on Reset + first load, after the per-cell init, to seed the grid. */
  gridInitCode?: string;
  /** "Skip Isolated Empty Cells" config (docs/PLAN_LARGE_GRID_PERF.md). Absent /
   *  disabled → the worker maintains no active set + the step runs the full loop. */
  skipIsolatedEmpty?: SkipIsolatedEmptyConfig;
  inputColorCodes: Array<{ mappingId: string; code: string }>;
  outputMappingCodes: Array<{ mappingId: string; code: string }>;
  /** Variegated Cells config. Undefined / absent ÃƒÂ¢Ã¢â‚¬Â¡Ã¢â‚¬â„¢ feature disabled, no
   *  orientation buffer / face-pattern lookup allocated. */
  variegated?: VariegatedPayload;
  /** Interaction Table model attributes. Empty array ÃƒÂ¢Ã¢â‚¬Â¡Ã¢â‚¬â„¢ no tables. Each table
   *  is flattened to a Float64Array of length `(labelCount + 1)Ãƒâ€šÃ‚Â²` and stored
   *  in `cachedInteractionTables[id]`. Live-tuned via updateInteractionTable. */
  interactionTables?: InteractionTablePayload[];
  /** Per-stop-event-node message, indexed by (_stopIdx - 1). */
  stopMessages?: string[];
  activeViewer: string;
  indicators?: IndicatorDef[];
  /** Wave 2: optional pre-compiled WASM step bytes (compiled on main thread). */
  wasmStepBytes?: Uint8Array;
  wasmStepError?: string;
  /** Names of every exported function in the WASM module ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â `step`,
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
  /** B4B ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â WebGPU-only: how often (in generations) to read the GPU stop-flag
   *  back to CPU during a step batch. Default 1 (every step). Higher values
   *  amortise the per-step mapAsync stall but a stop event may surface up to
   *  K-1 generations late. */
  webgpuStopCheckInterval?: number;
  /** P7 ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â optional OffscreenCanvas (transferred from the main thread). When
   *  present and WebGPU is enabled, the worker writes WebGPU output directly
   *  into the canvas via a present compute pipeline, eliminating the
   *  per-frame colors readback + sendColors round-trip. */
  webgpuCanvas?: OffscreenCanvas;
  webgpuCanvasWidth?: number;
  webgpuCanvasHeight?: number;
  /** True when the model uses setCellGlyph anywhere ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â drives allocation of
   *  the per-cell glyph overlay regions (codes + colours) in wasmMemory. */
  hasGlyphs?: boolean;
  /** Bond-Graph Agents: when true, the worker allocates the agent engine (the
   *  co-resident agent SoA + bond store) from `centerBased`. The lattice grid
   *  is always allocated too (agents are additive on top ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â v1 requires a grid). */
  agents?: boolean;
  /** CA-grid topology toggle. Absent ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ true. When false (an agents-only model)
   *  the worker skips the cell step + the neighbour-index tables so a large grid
   *  costs nothing (the agent loop is the only simulation). */
  gridCells?: boolean;
  centerBased?: CenterBasedConfig;
  /** Compiled agent rule-graph functions (Bond-Graph Agents, JS-only v1).
   *  `behaviourFn` runs once per agent each generation; division/bond fns land
   *  in later PRs. Absent ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ agents are inert (seed + render only). */
  agentBehaviourCode?: string;
  agentInitCode?: string;
  agentDivisionCode?: string;
  agentColorViewer?: string;
  /** Agent Output Mappings: one per-agent colour-pass fn source per linked agent
   *  mapping. `runAgentColorPass` runs the one matching `agentColorViewer`. */
  agentOutputMappingCodes?: Array<{ mappingId: string; code: string }>;
  /** Agent sprites: true when the model has sprite assets. Gates the per-agent
   *  sprite display buffers (reset before each colour pass + sliced into the
   *  render snapshot) so non-sprite agent models pay no extra per-step transfer. */
  agentHasSprites?: boolean;
  /** PR5 (C-D1): true when the agent graph reads/writes the cell field
   *  (sampleField / fieldGradient / readCellsUnder / affectCellsUnder /
   *  secreteToField). Drives the WebGPU-grid field bridge: only a field model
   *  needs the per-generation attrs CPUÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬ÂGPU readback/upload around runAgentStep
   *  (a no-field model's agent loop never touches `readAttrs`). */
  agentUsesField?: boolean;
  /** P1 (the dead density scan): whether ANY reachable agent node consumes the
   *  per-agent density — `neighbourDensity` reads it, `divideAgent`'s degenerate
   *  axis fallback reads it. When false AND engine physics is off, the force
   *  pass skips its whole neighbour scan (~70% of a custom-force model's
   *  force-pass cost). Absent → true (the historical always-scan). */
  agentUsesDensity?: boolean;
  /** PR7c GPU residency: the agent graph has NO structural / spawn / radius-write
   *  nodes (divideAgent, killAgent, formBond, breakBond, createAgent,
   *  addAgentToWorld, setAgentRadius, setTargetRadius) — one of the eligibility
   *  conditions for running whole batches GPU-resident. Absent → false. */
  agentResidencyClean?: boolean;
  /** PR6b-1: the resolved agent compile target ('js' default). When 'wasm' the
   *  worker backs the AgentStore on a WebAssembly.Memory (views at baked offsets)
   *  and runs the compiled `agentWasmBytes` behaviour loop instead of the JS one.
   *  The clamp lives in `agentTargetOf` (SimulatorView) ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the worker trusts it. */
  agentTarget?: 'js' | 'wasm' | 'webgpu';
  /** PR6b-1: the compiled agent-behaviour WASM module bytes (only when
   *  `agentTarget === 'wasm'`). Instantiated against the agent store's memory +
   *  the host math funcs; absent ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ the JS behaviour fn runs. */
  agentWasmBytes?: Uint8Array;
  /** Ordered non-sentinel setCellLooks mappingIds the WASM behaviour references ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â
   *  the worker passes `indexOf(activeViewer)` as the behaviour's trailing
   *  `activeViewerIdx` arg (JS `_isV_` guard parity). */
  agentWasmViewerGuardIds?: string[];
  /** FULL-COVERAGE WASM agent port: the extra-region sizing the wasmBacked store
   *  reserves (model attrs / indicators / lookup tables / cell fields / array
   *  scratch) ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the SAME extras the compiler built the module's layout from. The
   *  worker copies the external regions in/out around the WASM behaviour call. */
  agentLayoutExtras?: AgentLayoutExtras;
  /** Layout-lockstep signature of the layout the WASM agent module was compiled
   *  against. The worker REFUSES to instantiate when its own store layout
   *  disagrees (→ JS fallback + a loud error) — a mismatch means the hash /
   *  scratch / lookup-table / field regions sit at different offsets in the
   *  store vs the module (silent wrong-offset reads/writes). */
  agentWasmLayoutSig?: { maxHashBins: number; totalBytes: number };
  /** PR7 G3-runtime: the compiled WebGPU agent shaders (only when
   *  `agentTarget === 'webgpu'`). The behaviour shader is the per-agent loop; the
   *  force shader is the standalone integrator. The worker builds a dedicated
   *  agent WebGPU runtime + dispatches both per step. Absent / any failure ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ the
   *  JS behaviour fn + JS force loop run. */
  agentWebgpuBehaviourShader?: string;
  agentWebgpuForceShader?: string;
  /** The GPU agent layout dims (maxAgents + the hash reserve) ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the worker
   *  re-derives the GPU SoA layout from these so the upload offsets match the
   *  compiled shaders. */
  agentWebgpuMaxAgents?: number;
  agentWebgpuMaxHashBins?: number;
  /** The FULL GPU agent layout the shaders compiled against (carries the
   *  universal-node region bases ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â auxF32 / indicators / bondStore / 3D z fields).
   *  The worker binds + uploads against this EXACT layout (no recompute mismatch). */
  agentWebgpuLayout?: AgentWebGPULayout;
  /** A2 — the render-only GPU agent layout for a CPU (JS/WASM) render-eligible
   *  model (maxAgents + the x/y/radius bases). The worker builds a render-only
   *  surface from it (no compute pipelines). Absent on a webgpu target. */
  agentRenderLayout?: AgentWebGPULayout;
  /** True when the behaviour writes the i32 SoA (setAgentType) ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ the runtime binds
   *  agentI32 read_write + reads the type run back. */
  agentWebgpuUsesI32Write?: boolean;
  /** Which universal bindings the shader actually declares (so the runtime binds
   *  matching entries ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â a declared-but-unused global is stripped ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ bind mismatch). */
  agentWebgpuUsage?: { usesBondStore?: boolean; usesIndicators?: boolean; usesAux?: boolean; usesSpawn?: boolean; usesStop?: boolean; usesForceScatter?: boolean };
  /** A1.5 — the per-mapping GPU Agent Output-Mapping colour-pass WGSL modules (the
   *  runtime builds one pipeline each; the active agent viewer selects which runs). */
  agentWebgpuOmShaders?: AgentOMShaderInput[];
}

// reqId: optional Overseer correlation id ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â echoed on the resulting `stepped`
// (and the step case's `stopEvent` posts) so the main-thread OverseerRuntime
// can match its batch acks and never mistake a residual play-pipeline /
// mutation `stepped` for one of its own.
interface StepMsg { type: 'step'; count: number; activeViewer: string; skipColorPass?: boolean; reqId?: number }
interface PaintMsg {
  type: 'paint';
  /** `layer` (absent ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ 0) is the 3D Z coordinate; 2D paints omit it. */
  cells: Array<{ row: number; col: number; layer?: number; r: number; g: number; b: number }>;
  mappingId: string;
  activeViewer: string;
}
/** Manual Brush ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â runtime-only special Input Mapping. Bypasses any compiled
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
   *  encodeAttrValue() so the worker doesn't repeat the stringÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢number switch. */
  sets: Array<{ attrId: string; value: number }>;
  activeViewer: string;
}
interface ResetMsg { type: 'reset'; activeViewer: string; reqId?: number }
interface RecompileMsg { type: 'recompile'; stepCode: string; initCode?: string; gridInitCode?: string; skipIsolatedEmpty?: SkipIsolatedEmptyConfig; inputColorCodes: Array<{ mappingId: string; code: string }>; outputMappingCodes: Array<{ mappingId: string; code: string }>; stopMessages?: string[]; updateMode: string; asyncScheme: string; wasmStepBytes?: Uint8Array; wasmStepError?: string; wasmExports?: string[]; viewerIds?: Record<string, number>; webgpuShaderCode?: string; webgpuShaderError?: string; webgpuEntryPoints?: WebGPUEntryPoints; webgpuLayout?: WebGPULayout; webgpuStopCheckInterval?: number; variegated?: VariegatedPayload; interactionTables?: InteractionTablePayload[]; agentBehaviourCode?: string; agentInitCode?: string; agentDivisionCode?: string; agentColorViewer?: string; agentOutputMappingCodes?: Array<{ mappingId: string; code: string }>; agentHasSprites?: boolean; centerBased?: CenterBasedConfig; agentUsesField?: boolean; agentUsesDensity?: boolean; agentResidencyClean?: boolean; agentTarget?: 'js' | 'wasm' | 'webgpu'; agentWasmBytes?: Uint8Array; agentWasmViewerGuardIds?: string[]; agentLayoutExtras?: AgentLayoutExtras; agentWasmLayoutSig?: { maxHashBins: number; totalBytes: number }; agentWebgpuBehaviourShader?: string; agentWebgpuForceShader?: string; agentWebgpuMaxAgents?: number; agentWebgpuMaxHashBins?: number; agentWebgpuLayout?: AgentWebGPULayout; agentRenderLayout?: AgentWebGPULayout; agentWebgpuUsesI32Write?: boolean; agentWebgpuUsage?: { usesBondStore?: boolean; usesIndicators?: boolean; usesAux?: boolean; usesSpawn?: boolean; usesStop?: boolean; usesForceScatter?: boolean }; agentWebgpuOmShaders?: AgentOMShaderInput[] }
interface UpdateLookupTableMsg {
  type: 'updateLookupTable';
  attrId: string;
  rowLabels: string[];
  colLabels: string[];
  values: Record<string, Record<string, number>>;
  /** MULTI-AXIS (N-D) tables: per-axis dims + the dense row-major data (the
   *  legacy labels/values fields ride empty). Present ⇔ multi-axis. */
  dims?: number[];
  data?: number[];
}
interface UpdateModelAttrsMsg { type: 'updateModelAttrs'; attrs: Record<string, number> }
interface ImportImageMsg { type: 'importImage'; pixels: Uint8ClampedArray; mappingId: string; activeViewer: string;
  /** "Mapping Cells" paste-centered: write only this sub-region (cells outside
   *  are preserved). `pixels` is then sized region.w*region.h (row-major). Absent
   *  ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ the classic full-grid import (pixels sized total). */
  region?: { row: number; col: number; w: number; h: number } }
/** CSV import (grid flavour): write a row-major block of PER-CELL values into ONE
 *  cell attribute. Distinct from `paintManual` (which carries ONE shared value
 *  for every cell) and from `importImage` (which routes colours through a
 *  Colour→Attribute mapping). `values` is length width*height, transferred.
 *  CONVENTION: block row r, column c → grid (row r, col c) of `layer`; cells
 *  outside the grid are ignored, cells the block does not cover are untouched. */
interface ImportGridValuesMsg {
  type: 'importGridValues';
  attrId: string;
  width: number; height: number;
  /** 3D target layer (default 0). A 2D table cannot fill a volume. */
  layer?: number;
  values: Float64Array;
  activeViewer: string;
}

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
/** DEV/test-only: force the shared xorshift32 RNG seed (PR6b-2 bit-parity test). */
interface SetRngSeedMsg { type: 'setRngSeed'; seed: number }
/** E1b DEV probe (verification only; the app never sends it). */
interface E1bCountersMsg { type: '__e1bCounters' }
/** E2 DEV probe: read composited pixels back (occlusion-safe verification). */
interface CompositeReadbackMsg { type: '__compositeReadback'; points: Array<[number, number]> }
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
  /** 3D Grid CA: target layer for the 2D stamp (absent ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ 0). */
  layer?: number;
  attributes: Record<string, { type: string; buffer: ArrayBuffer }>;
  /** Optional shape mask (Uint8 buffer, length w*h, row-major). When present,
   *  only cells with mask !== 0 are written ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â so a non-rectangular brush
   *  (circle/ring) pastes its shape and leaves the surrounding cells intact.
   *  Absent = full rectangle (the historical behaviour). */
  mask?: ArrayBuffer;
  activeViewer: string;
}
interface ClearRegionMsg {
  type: 'clearRegion';
  row: number; col: number; w: number; h: number;
  /** 3D Grid CA: target layer for the 2D stamp (absent ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ 0). */
  layer?: number;
  /** Optional shape mask ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â see WriteRegionMsg. A masked clear (Ctrl+X cut)
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
/** Dev-mode parity helper: trigger a GPU ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ CPU readback of attrsRead so the
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

// --- L1 worker-side voxel render (3D grids on the WebGPU target) ---
/** Late-binding voxel-canvas attach (the 3D sibling of AttachCanvasMsg): the main
 *  thread transfers a display-pixel-sized OffscreenCanvas once the grid WebGPU
 *  runtime is ready. The worker builds the compaction + indirect-draw pipelines,
 *  presents once, and acks with `voxelRenderStatus`. */
interface AttachVoxelCanvasMsg { type: 'attachVoxelCanvas'; canvas: OffscreenCanvas; width: number; height: number }
/** Camera + lighting + clip uniform for the voxel render (orbit/pan/zoom/settings).
 *  Present-only (no step). Computed on the MAIN thread with the same
 *  sceneCameraMatrices / lightWorldDirFor helpers gl3d uses. */
interface SetGridCameraMsg { type: 'setGridCamera'; view: VoxelRenderView }
/** UI-sync toggle for the GRID (the agent `setAgentUiSync` sibling): while ON the
 *  worker reads the colours back each frame and ships them (features that need the
 *  CPU colours mirror: gl3d frame rendering + picking, recording, inspect). While
 *  OFF the voxel render owns the display and nothing crosses the wire. Default ON. */
interface SetGridUiSyncMsg { type: 'setGridUiSync'; on: boolean }
/** Which scene-anchored wireframes the free-mode voxel render draws (mirrors gl3d's
 *  Viz3D axes/grid/bounds toggles). The worker's voxel renderer draws these into
 *  its canvas depth-tested against the cubes; gl3d stops drawing them in free mode. */
interface SetGridVizMsg { type: 'setGridViz'; axes: boolean; grid: boolean; bounds: boolean }
/** Re-present the voxel frame (tab-refocus / soft-recompile analogue of
 *  refreshDisplay). */
interface RefreshGridDisplayMsg { type: 'refreshGridDisplay' }
/** DEV probe (verification only; the app never sends it): present one voxel frame
 *  and read the indirect draw args back, so a test can assert the GPU-computed
 *  instance count against an independently computed visible-cell count. */
interface VoxelReadbackMsg { type: '__voxelReadback'; sample?: number }

// --- Bond-Graph Agents messages ---
/** Lay down N agents (the seed brush / Reset / headless seeding). Positions are
 *  in continuous WORLD coordinates. Overflow past maxAgents is reported back. */
interface SeedAgentsMsg {
  type: 'seedAgents';
  agents: Array<{ x: number; y: number; z?: number; radius?: number; lineage?: number }>;
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
  x: number; y: number; z?: number; radius?: number;   // z: 3D layer (absent ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ 0)
  activeViewer: string;
}
/** Kill the agents at the given ids (the kill brush). */
interface KillAgentsMsg { type: 'killAgents'; ids: number[]; activeViewer: string }
/** Write user attributes onto the agents at the given ids (the agent paint
 *  brush). Values pre-encoded via encodeAttrValue (like paintManual). */
interface PaintAgentsMsg {
  type: 'paintAgents';
  ids: number[];
  sets?: Array<{ attrId: string; value: number }>;
  /** Optional geometry overwrite (the Edit brush): radius / velocity / absolute
   *  position. Position writes x AND xNext (the moveAgents discipline) and
   *  wraps/clamps per `torus`. */
  geom?: { radius?: number; vx?: number; vy?: number; vz?: number; x?: number; y?: number; z?: number };
  torus?: boolean;
  activeViewer: string;
}
/** Remove ALL agents (Reset). */
interface ClearAgentsMsg { type: 'clearAgents'; activeViewer: string }
/** Agent clipboard COPY read: batch-read the given agents' full spec (position,
 *  radius, velocity, all agent-attribute values). Replies `agentsRead`. Joins
 *  the one-shot staleness READERS (like getAgentState) so a free-mode copy is
 *  never stale. */
interface ReadAgentsMsg { type: 'readAgents'; ids: number[] }
/** Agent clipboard PASTE: create one agent per spec (per-agent position /
 *  radius / velocity / attribute sets — unlike seedAgents' shared sets).
 *  Overflow past maxAgents drops the excess + posts agentOverflow. In
 *  AGENT_GPU_DEFER_TYPES (deferred during GPU step batches + invalidates the
 *  resident GPU copy like every mutation). */
interface PasteAgentsMsg {
  type: 'pasteAgents';
  agents: Array<{ x: number; y: number; z?: number; radius?: number; vx?: number; vy?: number; vz?: number; sets?: Array<{ attrId: string; value: number }> }>;
  torus?: boolean;
  activeViewer: string;
}
/** AW-MEM (PR6a) DEV-only: force the AgentStore onto a WebAssembly.Memory (views
 *  at baked offsets) even for the `js` target, then re-init agents ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the
 *  JS-on-views proof. */
interface SetAgentWasmBackedMsg { type: '__setAgentWasmBacked'; wasmBacked: boolean }
/** Manual glue: bond two agents (the glue brush). */
interface FormBondMsg { type: 'formBond'; a: number; b: number; activeViewer: string }
/** Manual cut: break the bond between two agents (the cut brush). */
interface BreakBondMsg { type: 'breakBond'; a: number; b: number; activeViewer: string }
/** Runtime per-layer "simulate" toggles (the simulator Layers panel). Gates the
 *  cell step (`runStep`/`runStepWebGPU`) and/or the agent step (`runAgentStep`) in
 *  the generation loop WITHOUT a recompile, so the user can freeze either layer and
 *  watch the other evolve. Both default true ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ byte-identical to no message. */
interface SetSimLayersMsg { type: 'setSimLayers'; simulateCells: boolean; simulateAgents: boolean }
/** Render-snapshot CONTENTS toggle: ship per-agent velocity (vx/vy[/vz]) in the
 *  agent render snapshot even for a non-sprite model. Set while the simulator's
 *  vision-cone display is on — the cones need a heading, and `vx/vy` are
 *  otherwise gated on sprites (P2 slim). Default OFF → byte-identical payload.
 *  Runtime UI toggle, re-published by initWorkerWithDimensions on a worker
 *  reinit (the setSimLayers discipline). */
interface SetAgentSnapshotVelocityMsg { type: 'setAgentSnapshotVelocity'; on: boolean }
// --- A1 direct agent render ---
/** Late-binding agent-canvas attach (clone of AttachCanvasMsg): the main thread
 *  transfers a display-pixel-sized OffscreenCanvas once the agent WebGPU runtime
 *  is ready. The worker sets up the render pipeline + presents once, then acks
 *  with `agentRenderStatus`. */
interface AttachAgentCanvasMsg { type: 'attachAgentCanvas'; canvas: OffscreenCanvas; width: number; height: number; composite?: boolean }
/** Camera + tiling + graphics options for the agent render (world→screen +
 *  torus copies + outline/glow/bg). Present-only (no step). */
interface SetAgentCameraMsg { type: 'setAgentCamera'; view: AgentRenderViewAny }
/** UI-sync toggle: while ON the worker reads the GPU agent state back each frame
 *  and ships the render snapshot (features that need CPU agent state). While OFF
 *  the resident batch skips the readback (free-running). Default ON. */
interface SetAgentUiSyncMsg { type: 'setAgentUiSync'; on: boolean }
/** Re-present the agent frame (tab-refocus / soft-recompile analogue of
 *  refreshDisplay). */
interface RefreshAgentDisplayMsg { type: 'refreshAgentDisplay' }

type WorkerMsg = InitMsg | StepMsg | PaintMsg | PaintManualMsg | ResetMsg | RecompileMsg | UpdateModelAttrsMsg | UpdateLookupTableMsg | ImportImageMsg | ImportGridValuesMsg | UpdateIndicatorsMsg | GetStateMsg | LoadStateMsg | ReadRegionMsg | WriteRegionMsg | ClearRegionMsg | SetUseWasmMsg | SetUseWebGPUMsg | ReadbackWebGPUMsg | ColorPassMsg | SetRecordingMsg | AttachCanvasMsg | RequestColorsSnapshotMsg | SetInspectCellsMsg | RefreshDisplayMsg | SeedAgentsMsg | CreateAgentMsg | KillAgentsMsg | PaintAgentsMsg | ClearAgentsMsg | ReadAgentsMsg | PasteAgentsMsg | FormBondMsg | BreakBondMsg | GetAgentStateMsg | MoveAgentsMsg | FormBondBatchMsg | SetAgentWasmBackedMsg | SetRngSeedMsg | SetSimLayersMsg | SetAgentSnapshotVelocityMsg | AttachAgentCanvasMsg | SetAgentCameraMsg | SetAgentUiSyncMsg | RefreshAgentDisplayMsg | E1bCountersMsg | CompositeReadbackMsg | AttachVoxelCanvasMsg | SetGridCameraMsg | SetGridUiSyncMsg | SetGridVizMsg | RefreshGridDisplayMsg | VoxelReadbackMsg;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let width = 0;
let height = 0;
/** 3D Grid CA: layer count along Z. 1 ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ a 2D grid (total = W*H, byte-identical). */
let depth = 1;
let total = 0;
let cellAttrs: AttrDef[] = [];
/** Generic Agent Platform: the AGENT attribute set (agent-only per-agent state).
 *  buildAgentAttrSpecs maps these ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ the agent SoA; the agent loop's r_/w_ channel
 *  is keyed by them. A SEPARATE id-space from cellAttrs. */
let agentAttrs: AttrDef[] = [];
/** Generic Agent Platform: the agent-ACCESSIBLE cell attributes (agentAccess !==
 *  'none'). Drives the `_field_<id>` channel of the agent loop (args read from
 *  `readAttrs`, the CELL SoA). Mirrors `cellFieldAttrsOf` in the compiler. */
let fieldSpecs: AttrDef[] = [];

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
// WebGPU grid target only: when true, initGrid did NOT reserve the FULL per-cell
// neighbour table (total * nSz * 4 — the 2.8 GB hog at 300³ that blows the wasm32
// 4 GiB Memory cap at 400³). The GPU computes neighbours inline from the compact
// nbrOffsets buffer, so the CPU table is dead weight UNLESS a CPU-executed
// compiled function (init / gridInit / OM / inputColor) actually indexes it. The
// JS/WASM STEP fallback is the only other CPU reader and is deliberately dropped
// on this target (a grid too large for the GPU table is too large for JS/WASM
// too). Decided in the `init` handler from msg.useWebGPU (intent) + a source scan
// of the compiled CPU functions; drives the layout + the runStep CPU guard.
let nbrTableDropped = false;
// WebGPU grid target only (sync mode): when true, initGrid did NOT reserve a
// SEPARATE per-attr sync WRITE buffer — the write side aliases the read side
// (attrsB[id] === attrsA[id]), the SAME 0-byte-write layout the agents-only +
// async paths already use. On WebGPU the STEP runs on the GPU (its own attrsBufA/B
// ping-pong), so the ~9 B/cell CPU double-buffer is dead weight — the ~1.9 GB at
// 600³ that (after the nbr-table drop) keeps a 600³ 3D grid over the wasm32 4 GiB
// Memory cap. The only OTHER CPU writers (init / gridInit / paint) write FINAL
// values and are correct with write===read. The JS/WASM sync STEP is the one
// reader that needs a separate buffer, and it never runs on this target
// (runStepWebGPU returns first; the runStep guard below enforces it). Decided in
// the `init` handler from msg.useWebGPU (INTENT — the layout is baked before the
// async runtime is known to succeed) + gridCells + !async. BROADER than
// nbrTableDropped (independent of neighbour reads), so it has its own flag and
// the runStep CPU guard checks BOTH.
let attrWriteAliased = false;

let colors: Uint8ClampedArray = new Uint8ClampedArray(0);
let orderArray: Int32Array | null = null;

// --- Bond-Graph Agents (co-resident agent engine; JS-only v1) ---
let agentStore: AgentStore | null = null;
let agentsEnabled = false;
/** CA-grid topology toggle (from the init message; absent ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ true). When false
 *  the worker skips the cell step + neighbour-index build (agents-only model). */
let gridCellsEnabled = true;
// "Skip Isolated Empty Cells" (docs/PLAN_LARGE_GRID_PERF.md, Feature A). The
// active-cell list; only these cells run the (sparse) Generation Step. `activeSet`
// is null when the feature is off / invalid → the step runs the full loop.
let sieConfig: SkipIsolatedEmptyConfig | null = null;
let sieParamsPresent = false;   // = enabled && sync && gridCells (mirrors compile.ts sparseSteppingEnabled)
let sieEmptyAttrId = '';
let activeSet: ActiveSet | null = null;
// Forces the NEXT colour pass to run FULL even from the sparse-safe batch
// tail. Set when (a) compactActiveSet removed emptied cells (their pixels
// would otherwise keep the pre-transition colour) and (b) a model attribute
// or lookup table changed (both are legitimate Output-Mapping inputs, so
// inactive cells' colours may need recomputing). Cleared once a full pass runs.
let sieColorDirtyAll = false;
// --- Sparse incremental linked indicators (the 300^3 fix) -------------------
// The per-gen full-grid indicator scan (computeLinkedIndicatorsFromBuffer) costs
// ~775 ms/gen at 27M cells — it DWARFS the sparse step itself (~5 ms). When the
// sparse invariant holds (inactive cells NEVER change), linked frequency/total
// aggregates can be maintained INCREMENTALLY from the same O(active) diff loop
// that maintains the active set: on each active cell whose value changed,
// freq[old]--, freq[new]++ (or total += new - old). Exact per-generation values
// at O(active) cost — works at any Gens/Frame setting.
// Eligible when EVERY linked def is: a plain cell attr (not model attr, not
// sub-attribute), non-spatial, and 'total' OR 'frequency' over bool/tag/integer
// (float-frequency bins depend on the global min/max — genuinely non-incremental).
// Ineligible → the classic per-gen scan (correct, slow) + batch-end deferral.
let sieIncrementalActive = false;
let sieLinkedBaselineValid = false;
const sieLinkedFreq = new Map<string, Map<number, number>>();   // defId → rawValue → count
const sieLinkedTotal = new Map<string, number>();               // defId → running sum
// Batch-end deferral for the NON-incremental scan: with no 'accumulated' linked
// indicator, per-gen values are never observed (the stepped message + end
// conditions + the Overseer all read once per batch) — so the batch loops defer
// the O(total) scan to the batch tail. `indicatorScanPending` marks a deferral.
let linkedHasAccumulated = false;
let indicatorScanPending = false;

function sieIncrementalEligible(def: { attrId?: string; attrType?: string; aggregation?: string; isSubAttribute?: boolean; xAxis?: string; watched?: boolean }): boolean {
  if (def.xAxis === 'rows' || def.xAxis === 'columns' || def.xAxis === 'layers') return false;
  if (def.isSubAttribute) return false;
  if (!def.attrId || !cellAttrs.some(a => a.id === def.attrId)) return false;  // model attrs → scan
  if (def.aggregation === 'total') return true;
  if (def.aggregation === 'frequency') return def.attrType === 'bool' || def.attrType === 'tag' || def.attrType === 'integer';
  return false;
}

/** (Re)decide whether the incremental path applies — call whenever linkedDefs
 *  OR the active set changes (initIndicators / updateIndicators / setupActiveSet). */
function recomputeSieIncremental(): void {
  sieIncrementalActive = sieParamsPresent && activeSet !== null
    && linkedDefs.length > 0 && linkedDefs.every(sieIncrementalEligible);
  if (!sieIncrementalActive) sieLinkedBaselineValid = false;
}

/** One O(total) recount per def — the incremental baseline. Called after every
 *  active-set rebuild (init / reset / recompile / loadState / paint mutations),
 *  i.e. exactly when grid content changes OUTSIDE the step. */
function recountSieLinkedBaseline(): void {
  sieLinkedFreq.clear();
  sieLinkedTotal.clear();
  if (!sieIncrementalActive) { sieLinkedBaselineValid = false; return; }
  for (const def of linkedDefs) {
    const arr = readAttrs[def.attrId ?? ''] as unknown as { [i: number]: number } | undefined;
    if (!arr) { sieLinkedBaselineValid = false; return; }
    if (def.aggregation === 'total') {
      let sum = 0;
      for (let i = 0; i < total; i++) sum += arr[i] ?? 0;
      sieLinkedTotal.set(def.id, sum);
    } else {
      const m = new Map<number, number>();
      for (let i = 0; i < total; i++) { const v = arr[i] ?? 0; m.set(v, (m.get(v) ?? 0) + 1); }
      sieLinkedFreq.set(def.id, m);
    }
  }
  sieLinkedBaselineValid = true;
}

/** Produce `linkedResults` from the incrementally-maintained aggregates —
 *  byte-identical shape to computeLinkedIndicatorsFromBuffer's for the eligible
 *  def kinds (tag: all options pre-seeded 0, unknown indices dropped; bool:
 *  true/false; integer: present values only; total: the sum). O(#distinct values). */
function emitSieLinkedResults(): void {
  for (const def of linkedDefs) {
    if (!def.watched) continue;
    if (def.aggregation === 'total') {
      linkedResults[def.id] = sieLinkedTotal.get(def.id) ?? 0;
      continue;
    }
    const m = sieLinkedFreq.get(def.id);
    if (!m) continue;
    if (def.attrType === 'bool') {
      const t = m.get(1) ?? 0;
      let counted = 0; for (const c of m.values()) counted += c;
      linkedResults[def.id] = { 'true': t, 'false': counted - t };
    } else if (def.attrType === 'tag') {
      const opts = def.tagOptions || [];
      const freq: Record<string, number> = {};
      for (const name of opts) freq[name] = 0;
      for (const [v, c] of m) { const name = opts[v]; if (name !== undefined && c !== 0) freq[name] = c; }
      linkedResults[def.id] = freq;
    } else {
      const freq: Record<string, number> = {};
      for (const [v, c] of m) { if (c !== 0) freq[String(v)] = c; }
      linkedResults[def.id] = freq;
    }
  }
}
/** Agents-only optimisation: with the CA grid OFF the colours buffer is static
 *  (no cell step / colour pass ever rewrites it), so `sendColors` ships it only
 *  while dirty instead of copying+transferring WÃƒâ€šÃ‚Â·HÃƒâ€šÃ‚Â·DÃƒâ€šÃ‚Â·4 bytes EVERY step (576 MB
 *  per step at 600ÃƒÆ’Ã¢â‚¬â€600ÃƒÆ’Ã¢â‚¬â€400 ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the "resize makes it crawl" cost). Set by anything
 *  that rewrites `colors`; grid-ON models ship every step as before. */
let colorsDirty = true;
/** Runtime per-layer "simulate" toggles (the simulator Layers panel; setSimLayers
 *  message). Default true ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ the generation loop runs both the cell step and the
 *  agent step exactly as before. The user can freeze either layer mid-run. */
let simulateCells = true;
let simulateAgents = true;
/** PR5 (C-D1): true when the agent graph touches the cell field. Gates the
 *  WebGPU-grid field bridge (CPUÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬ÂGPU attrs readback/upload around runAgentStep).
 *  A no-field model leaves it false ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ 0 per-step readbacks. */
let agentUsesField = false;
/** P1: a density consumer exists (neighbourDensity / divideAgent) — absent from
 *  the message → true, the historical always-scan (see InitMsg.agentUsesDensity). */
let agentUsesDensity = true;
/** PR7c: the agent graph is residency-clean (no structural / spawn / radius-write
 *  nodes — see InitMsg.agentResidencyClean). Absent → false (conservative). */
let agentGraphResidencyClean = false;
/** PR7c: the CPU agent store changed since the last GPU upload (mutations /
 *  init / reset / loadState) — the next resident batch re-uploads the SoA;
 *  otherwise the batch runs on the GPU-resident state with ZERO uploads. */
let agentGpuUploadPending = true;
let centerBasedConfig: CenterBasedConfig | null = null;
/** Compiled agent behaviour function (runs once per agent each generation).
 *  Null until the agent compile path ships it (PR-A2.5/A3). */
let agentBehaviourFn: Function | null = null;
let agentInitFn: Function | null = null;
/** Unified spawning ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the STABLE grow-only Create Agent + Add Agent To World host
 *  closures for the BEHAVIOUR graph (mid-step spawning, the same idiom as the Init
 *  Event). They're module-level (not per-step) so the WASM `env.agentCreate` /
 *  `env.agentAddToWorld` imports ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â bound ONCE at instantiate ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â share the EXACT same
 *  logic as the JS behaviour ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ bit-identical. GROW-ONLY: a mid-step Create appends
 *  at highWater (never reuses a free-list hole ahead of the loop cursor), so a
 *  newborn is beyond the fixed loop bound ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ configured this step, behaves next step.
 *  `runAgentStep` clears the per-step created list at the top + leak-sweeps it after. */
const spawnCreatedSet = new Set<number>();
const spawnCreatedList: number[] = [];
const agentBehaviourCreate = (bx: number, by: number, bz: number, br: number): number => {
  const s = agentStore; if (!s) return -1;
  if (s.highWater >= s.maxAgents) return -1;   // overflow ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ -1; downstream Set/Add no-op
  const id = s.highWater++;
  initAgentSlot(s, id, bx, by, bz || 0, br || cbNum(centerBasedConfig!, 'defaultRadius'), id);
  s.alive[id] = 0;                             // STAGE (un-committed until Add To World)
  spawnCreatedSet.add(id); spawnCreatedList.push(id);
  return id;
};
const agentBehaviourAddToWorld = (id: number): void => {
  const s = agentStore; if (!s) return;
  // Only commit ids THIS step's Create Agent staged (an arbitrary wired id must not
  // ghost-commit a dead/uninitialised slot). Idempotent on already-live ids.
  if (spawnCreatedSet.has(id) && !s.alive[id]) { s.alive[id] = 1; s.liveCount++; }
};
/** The current-step spatial hash, built BEFORE the behaviour fn so Get Nearby
 *  Agents can query it, then reused by the force pass. Null for a tiny world. */
let currentAgentHash: SpatialHash | null = null;
/** The per-step spatial-hash bin budget (= the baked reserve for the wasmBacked
 *  store, so the per-step bin count never exceeds it ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ no fits-check fallback).
 *  buildSpatialHash coarsens its bin edge to fit this, so the per-step hash cost
 *  is bounded regardless of the world size. Set in initAgents from the LIVE dims. */
let agentHashReserve = AGENT_HASH_BIN_CAP;
const EMPTY_I32 = new Int32Array(0);
/** Compiled Division Event function (single-agent; runs per daughter after a
 *  division). Null when the agent graph has no divisionEvent root. */
let agentDivisionFn: Function | null = null;
/** Agent Output Mappings: one per-agent colour-pass fn per linked agent mapping.
 *  `runAgentColorPass` runs the one whose mappingId matches `agentColorViewer`. */
let agentOutputMappingFns: Array<{ mappingId: string; fn: Function }> = [];
/** The active AGENT viewer (an agent mapping id). Selects which agent colour pass
 *  paints. Independent of `activeViewer` (the active CELL viewer). */
let agentColorViewer = '';
/** True when the model has sprite assets ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â gates the per-agent sprite display
 *  buffers (reset before each colour pass + sliced into the render snapshot).
 *  Set from the init/recompile `agentHasSprites` flag. */
let hasAgentSprites = false;
/** Ship per-agent velocity in the render snapshot even without sprites — set by
 *  `setAgentSnapshotVelocity` while the simulator's vision-cone display is on
 *  (the cones need a heading). Default false → the payload is byte-identical to
 *  before the vision display existed. */
let agentSnapshotVelocity = false;

/** AW-MEM (PR6a) ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â DEV-only override that forces the AgentStore onto a
 *  WebAssembly.Memory (views at baked offsets) even for the `js` target, so the
 *  JS-on-views PROOF can run before any WASM emit (PR6b). Set via the
 *  `__setAgentWasmBacked` DEV message (then re-init). Off in production ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the
 *  default JS-default path is plain typed arrays. PR6b sets `wasmBacked` from
 *  `agentTargetOf === 'wasm'` instead of this flag. */
let agentWasmBackedDev = false;

/** PR6b-1 ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the resolved agent compile target. 'wasm' backs the AgentStore on a
 *  WebAssembly.Memory + runs the compiled WASM behaviour loop; otherwise the JS
 *  `agentBehaviourFn` runs. SimulatorView resolves this via `agentTargetOf` +
 *  the WASM-support gate, so the worker trusts it. */
let agentTarget: 'js' | 'wasm' | 'webgpu' = 'js';
/** PR6b-1 ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the compiled agent WASM module bytes (pending instantiation against
 *  the agent store's memory). Held so `initAgents` (which (re)allocates the
 *  store + its memory) can instantiate against the FRESH memory. */
let pendingAgentWasmBytes: Uint8Array | null = null;
/** FULL-COVERAGE: the agent layout extras the compiler built the WASM module's
 *  memory layout from (model attrs / indicators / lookup tables / cell fields /
 *  array scratch + the sync-attr write region). The store layout MUST match. */
let pendingAgentLayoutExtras: AgentLayoutExtras | null = null;
/** The layout signature the WASM agent module was compiled against — asserted
 *  against the store layout before instantiation (offset-desync guard). */
let pendingAgentWasmLayoutSig: { maxHashBins: number; totalBytes: number } | null = null;
/** PR6b-2 ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the instantiated WASM `behaviour(...)` export (null on the JS target /
 *  before instantiation / on a failed instantiate ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ JS fallback). Signature:
 *  `(highWater, hashValid, nBinsX, nBinsY, nBinsZ, binSizeX, binSizeY, binSizeZ,
 *  fieldW, fieldH, fieldD, fieldTorus)` ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â mirrors `compileAgentGraphWasm`'s
 *  behaviour params. */
let agentBehaviourWasmFn: ((...args: number[]) => void) | null = null;
/** Viewer-guard table for the WASM behaviour's trailing `activeViewerIdx` arg. */
let agentWasmViewerGuardIds: string[] = [];
/** W1 ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the WASM force-pass export (soft-sphere + bond springs + integration). Set
 *  alongside agentBehaviourWasmFn; null on a behaviour-only module. When present
 *  (and the behaviour ran on WASM with the hash copied in this step), runAgentStep
 *  runs this INSTEAD of the JS force loop ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the boost. */
let agentForcePassWasmFn: ((...args: number[]) => void) | null = null;
/** AW-HASH fits-check: warn once when the per-step hash overflows the WASM reserve
 *  (the step then runs on JS ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â never silently wrong). */
let agentWasmHashOverflowWarned = false;

/** PR7 G3-runtime ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the dedicated agent WebGPU runtime (its own device, separate
 *  from the grid's `webgpuRuntime`). When `agentTarget === 'webgpu'` AND this is
 *  non-null, runAgentStep dispatches the behaviour + force compute shaders on the
 *  GPU instead of the JS loop. Any device/compile failure nulls it ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ JS fallback. */
let agentWebgpuRuntime: AgentWebGPURuntime | null = null;
/** The pending WebGPU agent shaders + layout dims (held so init/recompile can
 *  build the runtime asynchronously against the current store). */
let pendingAgentWebgpuBehaviour: string | null = null;
let pendingAgentWebgpuForce: string | null = null;
let pendingAgentWebgpuMaxAgents = 0;
let pendingAgentWebgpuMaxHashBins = 0;
let pendingAgentWebgpuLayout: AgentWebGPULayout | null = null;
let pendingAgentWebgpuUsesI32Write = false;
let pendingAgentWebgpuUsage: { usesBondStore?: boolean; usesIndicators?: boolean; usesAux?: boolean; usesSpawn?: boolean; usesStop?: boolean; usesForceScatter?: boolean } = {};
/** A1.5 — the per-mapping GPU Agent Output-Mapping colour-pass shaders (held so
 *  buildAgentWebGPUIfNeeded builds one pipeline each on the agent runtime). */
let pendingAgentWebgpuOmShaders: AgentOMShaderInput[] = [];
/** Warn once when the per-step hash overflows the GPU reserve (step runs on JS). */
let agentWebgpuHashOverflowWarned = false;

// --- A1 direct agent render ---
/** True once an agent OffscreenCanvas is attached + the render pipeline is live.
 *  When set, the WORKER renders agents straight from the GPU SoA into the canvas;
 *  the main thread just blits it 1:1. */
let agentRenderActive = false;
/** UI-sync: while ON the resident batch reads the GPU state back each frame and
 *  ships the render snapshot (features that need CPU agent state). While OFF it
 *  free-runs (no readback, no snapshot). Default ON so behaviour is unchanged
 *  until SimulatorView opts in. */
let agentUiSync = true;
/** True when the CPU agent store lags the GPU (a free-mode resident batch skipped
 *  the readback). The message dispatcher's one-shot rule readbacks before serving
 *  any agent-reading/-mutating message. */
let agentStoreStale = false;
/** Set by the resident batch after it appended the present pass to its submit, so
 *  sendColors does NOT double-present (its present reads the CPU store, wrong under
 *  free mode). Cleared by sendColors. */
let agentBatchPresented = false;
/** E2 single-canvas composite: the agent render canvas is WORLD-sized and the
 *  worker composites the WebGPU grid layer (grid `colorsBuf`) + the agent discs
 *  into it in one encoder. When active, the grid's per-gen colors readback is
 *  skipped (sendColors ships no `colors`) and the agent present is the composite
 *  (grid + agents), NOT the agent-only present. Set only for 2D grid+agents with a
 *  WebGPU grid on the shared device; agents-only / two-canvas configs leave it false. */
let agentCompositeActive = false;
/** The last camera/tiling/graphics uniform (re-applied on attach / refocus).
 *  2D disc view OR the Phase C 3D sphere view (routed by applyAgentRenderView). */
let agentRenderView: AgentRenderViewAny | null = null;

/** A2 — the render-ONLY surface for a CPU (JS/WASM) target. On a webgpu target the
 *  render reads the full `agentWebgpuRuntime`; on a CPU target there is no compute
 *  runtime, so this lightweight surface (device + the three render buffers) is
 *  fed by uploading the CPU store each frame. Mutually exclusive with
 *  `agentWebgpuRuntime` (webgpu builds the former, CPU builds this). */
let agentRenderRuntime: AgentRenderSurface | null = null;
/** The GPU agent layout SimulatorView ships for a render-eligible CPU target
 *  (maxAgents + the x/y/radius bases). Null on a webgpu target (uses the full
 *  layout the runtime was built from). Drives the lazy render-only build on attach. */
let pendingAgentRenderLayout: AgentWebGPULayout | null = null;

/** The active render surface — the full webgpu runtime OR the CPU render-only
 *  surface (they never coexist). */
function activeRenderSurface(): AgentRenderSurface | null {
  return agentWebgpuRuntime ?? agentRenderRuntime;
}

/** Present the agent frame from the current CPU store (positions + colours) —
 *  used wherever the CPU store is authoritative (per-gen batch tail, mutations,
 *  every CPU-target step batch). No-op unless render is active. The webgpu runtime
 *  uploads the FULL SoA (its compute step reads it next); the render-only surface
 *  uploads only the render fields (tight). */
function presentAgentsIfActive(): void {
  if (!agentRenderActive || !agentStore) return;
  // NEVER upload a STALE CPU store to the GPU. In free-mode residency the GPU is
  // authoritative and the CPU store is deliberately NOT read back each frame, so
  // the *FromStore present paths below (which uploadAgentSoA before presenting)
  // would OVERWRITE the live diffused GPU state with the stale ≈last-synced frame
  // — reverting the sim (the agent sibling of audit-B1, realised on a present
  // path). When stale, re-present the GPU's CURRENT frame WITHOUT uploading; any
  // caller that needs fresh CPU state must ensureAgentStoreFresh() first (which
  // reads back GPU→CPU and clears the flag). This guard makes every present site
  // safe by construction — the setAgentCamera handler's explicit stale branch is
  // now redundant-but-harmless, and refreshAgentDisplay / attachAgentCanvas can no
  // longer revert via a present.
  if (agentStoreStale) {
    const rt = activeRenderSurface();
    if (rt) presentAgentsOnce(rt, agentStore.highWater);
    return;
  }
  // E2: single-canvas composite — present the WebGPU grid layer + agent discs
  // together at DISPLAY resolution through the camera. Reads the LIVE grid
  // colorsBuf (post color pass) + the SAME camera (scalePx/oxPx/oyPx/torus) the
  // disc pass reads from the RenderView uniform, so both layers align exactly.
  if (agentCompositeActive && webgpuRuntime?.colorsBuf) {
    const rt = activeRenderSurface();
    if (rt) {
      const v = agentRenderView as { showGrid?: boolean; showAgents?: boolean; scalePx?: number; oxPx?: number; oyPx?: number; torus?: boolean } | null;
      const showGrid = v?.showGrid !== false;      // default: both layers shown
      const showAgents = v?.showAgents !== false;
      presentAgentCompositeFromStore(rt, webgpuRuntime.colorsBuf, webgpuRuntime.layout.gridWidth, webgpuRuntime.layout.gridHeight, agentStore, showGrid, showAgents, v?.scalePx ?? 1, v?.oxPx ?? 0, v?.oyPx ?? 0, !!v?.torus);
      return;
    }
  }
  if (agentWebgpuRuntime) presentAgentsFromStore(agentWebgpuRuntime, agentStore);
  else if (agentRenderRuntime) presentAgentRenderFromStore(agentRenderRuntime, agentStore);
}

/** One-shot readback: if the CPU agent store is stale (free-mode residency),
 *  pull the GPU state down so a CPU consumer (mutation / inspect / save) sees
 *  fresh values. Returns true if it read back. */
async function ensureAgentStoreFresh(): Promise<boolean> {
  if (!agentStoreStale || !agentWebgpuRuntime || !agentStore) return false;
  try { await readbackAgentFrame(agentWebgpuRuntime, agentStore); }
  catch { /* runtime torn down mid-await — leave stale flag, caller degrades */ }
  agentStoreStale = false;
  return true;
}
/** A monotonic build token: only the most-recent async runtime build commits (an
 *  earlier in-flight build whose token is stale is discarded, like the WASM
 *  orphan-on-reinit discipline). */
let agentWebgpuBuildToken = 0;

/** Resolve the incoming agent target to one whose required payload actually
 *  arrived. 'wasm' needs the module bytes; 'webgpu' needs both shaders. A target
 *  missing its payload demotes to 'js' (the always-runnable fallback) ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the
 *  worker-side safety net mirroring the grid's useWasm/useWebGPU demotion. */
function resolveAgentTarget(
  t: 'js' | 'wasm' | 'webgpu' | undefined,
  wasmBytes: Uint8Array | undefined,
  webgpuBehaviour: string | undefined,
  webgpuForce: string | undefined,
): 'js' | 'wasm' | 'webgpu' {
  if (t === 'wasm') return wasmBytes ? 'wasm' : 'js';
  if (t === 'webgpu') return (webgpuBehaviour && webgpuForce) ? 'webgpu' : 'js';
  return 'js';
}

/** Build the agent attribute specs (the non-model cell attributes double as
 *  per-agent attributes via D-IDX) with their resolved default values. */
function buildAgentAttrSpecs(): AgentAttrSpec[] {
  // Generic Agent Platform: the agent SoA is keyed by the AGENT attribute set
  // (a separate id-space), NOT the cell attributes. KEYSTONE of the attribute
  // split ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â this drives createAgentStore + computeAgentMemoryLayout + the
  // agent-WASM spec, all of which must derive from the SAME ordered list.
  return agentAttrs.map(a => ({ id: a.id, type: a.type, defaultValue: defaultValue(a) }));
}

/** Allocate (or re-allocate) the agent store from the current config + attrs.
 *  Called on init when the model has the Agents topology. Seeds the configured
 *  initial agent count. */
function initAgents(): void {
  // PR7c: a fresh/re-seeded store must reach the GPU before the next resident batch.
  agentGpuUploadPending = true;
  // A1: re-allocating the store drops the agent runtime below — its render canvas
  // needs re-attach (the main thread re-attaches on agentRuntimeReady).
  agentRenderActive = false; agentStoreStale = false; agentCompositeActive = false;
  // Re-allocating the store invalidates any GPU agent runtime bound to the old
  // store/dims ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â drop it (buildAgentWebGPUIfNeeded rebuilds against the fresh one).
  if (agentWebgpuRuntime) { destroyAgentWebGPURuntime(agentWebgpuRuntime); agentWebgpuRuntime = null; }
  // A2: same for the CPU-target render-only surface — the main thread re-attaches
  // its canvas on the next agentRuntimeReady (posted by buildAgentWebGPUIfNeeded).
  if (agentRenderRuntime) { destroyAgentRenderSurface(agentRenderRuntime); agentRenderRuntime = null; }
  // The per-step hash references the OLD store's scratch arrays ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â never hand it
  // to a colour pass built over the fresh store (stale ids up to the old maxAgents).
  currentAgentHash = null;
  if (!agentsEnabled || !centerBasedConfig) { agentStore = null; agentBehaviourWasmFn = null; agentForcePassWasmFn = null; return; }
  // AW-MEM (PR6a/PR6b-1): back the store on a WebAssembly.Memory (views at baked
  // offsets) when the agent target is 'wasm' (so the WASM behaviour loop reads/
  // writes the SAME bytes the JS engine does) OR when the DEV proof flag forces
  // the JS-on-views path. computeAgentMemoryLayout (shared with the compiler)
  // bakes the offsets; the compiler emitted reads/writes against the same layout.
  const wantWasmBacked = agentTarget === 'wasm' || agentWasmBackedDev;
  // Re-allocating the store creates a FRESH WebAssembly.Memory; any previously
  // instantiated WASM behaviour / force-pass fn pointed at the OLD memory ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ drop
  // it. The caller (init / reset / recompile) re-instantiates via
  // instantiateAgentWasmIfNeeded against the fresh memory.
  agentBehaviourWasmFn = null;
  agentForcePassWasmFn = null;
  // Agent update synchronicity (INDEPENDENT of the grid's `updateMode`): 'sync'
  // double-buffers the agent attribute arrays (read previous / write next, swapped
  // at step end ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â parallel/snapshot semantics, the WebGPU-agent prerequisite),
  // 'async' (default) single-buffers them (immediate writes). Only honoured on the
  // non-wasmBacked JS path (createAgentStore gates `syncAttrs` on `!wasmBacked`).
  const wantSyncAttrs = centerBasedConfig.agentUpdateMode === 'sync';
  // AW-HASH (PR6b-2): reserve room in the agent memory for the per-step spatial
  // hash the WASM behaviour reads. The bound is derived from the ACTUAL grid (=
  // agent world) dims + the force config ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the SAME formula the compiler uses
  // (agentMaxHashBinsForModel), so the worker's store layout matches the compiled
  // module's offsets. Only meaningful under wasmBacked; 0 otherwise.
  // The hash bin budget ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â derived from the LIVE dims (a resize
  // reinits with new dims AND SimulatorView recompiles the agent module from the
  // SAME dims-overridden model — compileAgentModel(dimsModel) — while
  // instantiateAgentWasmIfNeeded asserts the layout lockstep before
  // instantiating), so it equals the WASM-baked reserve. Computed for ALL targets (the JS path also caps its per-step bin
  // count via buildSpatialHash, so a big grid never slows the JS agent loop).
  agentHashReserve = computeAgentMaxHashBins(
    width, height, depth,
    cbNum(centerBasedConfig, 'interactionRange'),
    cbNum(centerBasedConfig, 'defaultRadius'),
    cbNum(centerBasedConfig, 'neighbourQueryRadius'),
  );
  const agentMaxHashBins = wantWasmBacked ? agentHashReserve : 0;
  // FULL-COVERAGE: the layout extras the WASM module compiled against (model attrs
  // / indicators / lookup tables / cell fields / array scratch). MUST match the
  // compiler's `buildAgentLayoutExtras(model)` ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the worker's `fieldTotal` is
  // re-derived here from the LIVE grid dims (= width*height*depth) so a resize is
  // consistent. Only meaningful under wasmBacked.
  const layoutExtras: AgentLayoutExtras | undefined = wantWasmBacked
    ? { ...(pendingAgentLayoutExtras ?? {}), fieldTotal: width * height * depth, syncAttrs: wantSyncAttrs }
    : undefined;
  agentStore = createAgentStore(centerBasedConfig, buildAgentAttrSpecs(), { wasmBacked: wantWasmBacked, syncAttrs: wantSyncAttrs, maxHashBins: agentMaxHashBins, layoutExtras });
  // The agent world IS the grid coordinate frame (1:1, Decision D-FIELD): agent
  // (x,y) are in CELL units so they map onto the grid + the screen with the same
  // transform the cell blit uses. (worldWidth/Height in the config are reserved
  // for a future agents-only model where there's no grid to define the frame.)
  agentStore.worldWidth = width;
  agentStore.worldHeight = height;
  // The agent world depth IS the grid `depth` (1:1, B2) ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the SAME local the grid
  // derives (`= dimension==='3d' ? max(1,gridDepth) : 1`). This is the engine's
  // single 3D predicate: `store.worldDepth > 1 ÃƒÂ¢Ã…Â¸Ã‚Âº is3dModel(model)`. Do NOT read
  // the dormant config.worldDepth (S6) ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â that would reintroduce the desync B2 warns of.
  agentStore.worldDepth = depth;
  const seedCount = Math.max(0, Math.floor(cbNum(centerBasedConfig, 'seedCount')));
  if (seedCount > 0) {
    const r = cbNum(centerBasedConfig, 'defaultRadius');
    const ww = agentStore.worldWidth, wh = agentStore.worldHeight;
    const is3d = agentStore.worldDepth > 1, D = agentStore.worldDepth;
    const specs: AgentSeedSpec[] = [];
    if (centerBasedConfig.seedPattern === 'scatter') {
      // Dispersed: uniformly random across the world (flocking, chemotaxis
      // aggregation ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â populations that START spread and self-organize). Seeding
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
      // ÃƒÂ¢Ã¢â‚¬Â°Ã‚Â¥ seedCount candidates), clip to a ball, sort by distance-to-centre, take
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
      // settle into a packed blob and auto-bond into a tissue) ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the
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

/** PR6b-1 ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â instantiate the compiled agent WASM module against the FRESH agent
 *  store memory (allocated by `initAgents` ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ `createAgentStore({ wasmBacked })`).
 *  Async (WebAssembly.instantiate). On any failure the worker stays on the JS
 *  behaviour fn (the clamp keeps JS safe). Re-runs whenever the store / bytes
 *  change. Posts an error message on a hard failure for visibility. */
function instantiateAgentWasmIfNeeded(): void {
  agentBehaviourWasmFn = null;
  agentForcePassWasmFn = null;
  const store = agentStore;
  if (agentTarget !== 'wasm' || !pendingAgentWasmBytes || !store || !store.wasmBacked || !store.memory) return;
  // Layout-lockstep guard: the module's baked offsets MUST equal the store's.
  // A mismatch (e.g. a dims desync between the compile-time model and the live
  // worker dims) would put the hash / nearby-scratch / lookup-table / field
  // regions at different addresses in the store vs the module — silent
  // wrong-offset reads/writes, NOT a crash. Refuse + run the JS behaviour fn
  // on the same wasmBacked views (proven safe — the agentWasmBackedDev path).
  const sig = pendingAgentWasmLayoutSig;
  if (sig && store.layout && (sig.maxHashBins !== store.layout.maxHashBins || sig.totalBytes !== store.layout.totalBytes)) {
    self.postMessage({ type: 'error', message: `[agents] compiled WASM layout (hash ${sig.maxHashBins}, ${sig.totalBytes} B) does not match the worker store layout (hash ${store.layout.maxHashBins}, ${store.layout.totalBytes} B) — agent loop runs on JS. This is a compile/worker dims desync; please report it.` });
    return;
  }
  const bytes = pendingAgentWasmBytes;
  const mem = store.memory;
  void (async () => {
    try {
      const inst = await instantiateAgentWasm(bytes, mem, agentBehaviourCreate, agentBehaviourAddToWorld);
      // Guard against a re-init that swapped the store out from under us.
      if (agentStore === store && agentTarget === 'wasm') {
        agentBehaviourWasmFn = inst.behaviour;
        agentForcePassWasmFn = inst.forcePass;  // W1 ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â null on a behaviour-only module
      }
    } catch (e) {
      agentBehaviourWasmFn = null;
      agentForcePassWasmFn = null;
      self.postMessage({ type: 'error', message: '[agents] WASM instantiate failed, falling back to JS: ' + ((e as Error)?.message || e) });
    }
  })();
}

/** PR7 G3-runtime ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â (re)build the dedicated agent WebGPU runtime. Async (device
 *  acquisition + pipeline compilation). On any failure the worker stays on the JS
 *  behaviour fn + JS force loop (the clamp keeps JS safe). A monotonic build token
 *  discards a stale in-flight build (the orphan-on-reinit discipline). Called from
 *  init / reset / recompile when the agent target is 'webgpu'. */
function buildAgentWebGPUIfNeeded(): void {
  // BLOCKER (audit B1): a REBUILT runtime has fresh, spec-ZERO-initialised GPU
  // buffers, and the PR7c resident batch uploads the CPU SoA only when this flag
  // is set (runAgentBatchResident's conditional upload). Without the flag the
  // first resident batch after a rebuild would dispatch on an all-zero agent SoA
  // and readbackAgentFrame would write those zeros back into every LIVE CPU slot
  // (x/y/radius/velocity/attributes -> 0, permanently). A rebuild without a store
  // re-init happens on EVERY soft recompile (initAgents, the only other setter,
  // runs there only when the WASM backing changed).
  agentGpuUploadPending = true;
  // Drop any prior runtime first (a re-init may have swapped the store/dims).
  if (agentWebgpuRuntime) { destroyAgentWebGPURuntime(agentWebgpuRuntime); agentWebgpuRuntime = null; }
  // A1: the render pipeline lived on the old runtime — the main thread must
  // re-attach its canvas once the new runtime is ready (agentRuntimeReady below).
  agentRenderActive = false; agentStoreStale = false; agentCompositeActive = false;
  // A2: a re-init/recompile may have swapped the store/dims — drop the CPU
  // render-only surface too (the main thread re-attaches on agentRuntimeReady).
  if (agentRenderRuntime) { destroyAgentRenderSurface(agentRenderRuntime); agentRenderRuntime = null; }
  const store = agentStore;
  if (agentTarget !== 'webgpu' || !pendingAgentWebgpuBehaviour || !pendingAgentWebgpuForce || !store) {
    // A2: for a render-eligible CPU (JS/WASM) target — SimulatorView shipped a
    // render layout — signal ready so the main thread attaches a render-only
    // canvas (the render-only surface is built lazily in attachAgentCanvas).
    // Harmless when the model isn't render-eligible (the attach is main-side
    // gated on agentRenderEligibleRef; a failed device build acks active:false).
    if (agentTarget !== 'webgpu' && agentsEnabled && store && pendingAgentRenderLayout) {
      self.postMessage({ type: 'agentRuntimeReady' });
    }
    return;
  }
  const behaviour = pendingAgentWebgpuBehaviour;
  const force = pendingAgentWebgpuForce;
  // G5 field bridge ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the agent-accessible cell-attr id lists + grid dims. MUST
  // match the order the SHADER was compiled against (cellFieldAttrsOf /
  // cellFieldWriteAttrsOf): fieldSpecs IS cellFieldAttrsOf (same filter order),
  // and the readWrite subset preserves that order = cellFieldWriteAttrsOf.
  const fieldReadAttrs = fieldSpecs.map(s => s.id);
  const fieldWriteAttrs = fieldSpecs.filter(s => s.agentAccess === 'readWrite').map(s => s.id);
  // G4 ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the user AGENT attribute ids (the agent SoA runs Get/Set Attribute target).
  // MUST match the order the SHADER compiled against (agentAttrsOf = store.attrSpecs).
  const agentAttrIds = store.attrSpecs.map(sp => sp.id);
  // Prefer the FULL layout shipped from SimulatorView (it carries the universal-node
  // region bases the shader compiled to ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â auxF32 / indicators / bondStore / 3D z
  // fields). Fall back to a recompute (legacy path) if it's absent.
  const layout = pendingAgentWebgpuLayout ?? computeAgentWebGPULayout(
    pendingAgentWebgpuMaxAgents || store.maxAgents, pendingAgentWebgpuMaxHashBins,
    { readAttrs: fieldReadAttrs, writeAttrs: fieldWriteAttrs, gridWidth: width, gridHeight: height },
    agentAttrIds,
  );
  const i32Write = pendingAgentWebgpuUsesI32Write;
  const usage = pendingAgentWebgpuUsage;
  const omShaders = pendingAgentWebgpuOmShaders;
  const token = ++agentWebgpuBuildToken;
  agentWebgpuHashOverflowWarned = false;
  void (async () => {
    try {
      const rt = await createAgentWebGPURuntime(behaviour, force, layout, i32Write, usage, omShaders);
      // A1.5 — select the OM colour pass matching the active agent viewer.
      rt.activeOmMappingId = agentColorViewer;
      // Guard against a re-init that swapped the store / changed the target /
      // launched a newer build while this one was in flight.
      if (agentStore === store && agentTarget === 'webgpu' && token === agentWebgpuBuildToken) {
        // E1: uncaptured-error + device-loss diagnostics are consolidated at the
        // shared-device singleton (sharedGpuDevice.ts) — one hook set for BOTH the
        // grid + agent runtimes (the device is shared; per-runtime hooks would
        // mislabel grid errors as agent errors and accumulate a lost handler per
        // rebuild on the surviving device). Real dispatch failures stay
        // user-visible via the pushErrorScope('validation') around each dispatch
        // (runAgentStepWebGPUInner / runAgentBatchResident) — the P0 silent-error
        // guard is unchanged.
        agentWebgpuRuntime = rt;
        // A1: signal the main thread the agent WebGPU runtime is up so it can
        // (re)attach its render canvas (the direct-render gate is evaluated
        // main-side; this is just the "runtime ready" trigger, like the grid's
        // useWebGPUStatus). Harmless when the model isn't render-eligible.
        self.postMessage({ type: 'agentRuntimeReady' });
      } else {
        destroyAgentWebGPURuntime(rt);
      }
    } catch (e) {
      agentWebgpuRuntime = null;
      self.postMessage({ type: 'error', message: '[agents] WebGPU runtime build failed, falling back to JS: ' + ((e as Error)?.message || e) });
    }
  })();
}

/** Refresh per-agent colours from the active AGENT output mapping (without
 *  advancing the simulation). When the model has agent mappings, the per-agent
 *  colour pass for `agentColorViewer` reads each agent's linked attribute and
 *  writes its colour ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â so switching the agent viewer, seeding, painting or
 *  killing recolours immediately. When there are no agent mappings this is a
 *  no-op: agents are coloured by the behaviourStep's Set Cell Looks during a
 *  step (running the behaviour fn here would advance the rule). */
function runAgentColorPass(): void {
  const s = agentStore;
  if (!s || agentOutputMappingFns.length === 0) return;
  const om = agentOutputMappingFns.find(f => f.mappingId === agentColorViewer)
    ?? agentOutputMappingFns[0];   // default to the first agent mapping
  if (!om) return;
  try {
    // The colour pass guards setCellLooks with `activeViewer === <mappingId>`, so
    // run it with activeViewer = this mapping's id (NOT the global cell viewer).
    om.fn(...buildAgentLoopArgs(s, om.mappingId));
  } catch (e) {
    // Drop the failing pass (mirrors the behaviour/division fns nulling
    // themselves) ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â runAgentColorPass runs on every sendColors, so a throwing fn
    // would otherwise spam one error post per step of play.
    agentOutputMappingFns = agentOutputMappingFns.filter(f => f !== om);
    self.postMessage({ type: 'error', message: `[agents] colour pass "${om.mappingId}" failed (disabled until recompile): ` + ((e as Error)?.message || e) });
  }
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

/** Build the args for the compiled Agent Init Event function (a once-per-reset
 *  SETUP function ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â NOT loop-wrapped). MIRRORS `buildAgentInitParams` in compile.ts
 *  EXACTLY: the host closures + maxAgents, the writable geometry buffers, the agent
 *  attr buffers, the global/rng/field block, then `_agentSeedBase`. */
/** The ABI shape (primitives) for the shared agent-ABI descriptor ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the worker
 *  analogue of compile.ts's `agentAbiShapeOf(model)`. `s.attrSpecs` mirrors
 *  `agentAttrsOf(model)` and `fieldSpecs` mirrors `cellFieldAttrsOf(model)` in
 *  the SAME order, and `s.worldDepth > 1 ÃƒÂ¢Ã…Â¸Ã‚Âº is3dModel(model)`, so this produces
 *  the identical ordered field list. */
function agentAbiShapeOfStore(s: AgentStore): AgentAbiShape {
  return { is3d: s.worldDepth > 1, agentAttrs: s.attrSpecs, fieldAttrs: fieldSpecs, hasLookupTables };
}

/** The shared runtime values (external caches) every kind resolves from ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â pulled
 *  live from the worker module globals. `hash` + `viewer` (+ the per-kind extras)
 *  are set by the caller. */
function agentAbiBaseRt(): Omit<AgentAbiRuntime, 'hash' | 'viewer'> {
  return {
    emptyI32: EMPTY_I32,
    modelAttrs: cachedModelAttrs,
    indicators: cachedIndicators,
    rngState, stopFlag,
    glyphCodes: GLYPH_NOOP_CODES, glyphColors: GLYPH_NOOP_COLORS,
    lookupTables: cachedInteractionTables,
    width, height, total, torus: boundaryTreatment === 'torus',
    fieldArray: (id: string) => readAttrs[id],
  };
}

function buildAgentInitArgs(
  s: AgentStore,
  agentCreate: (x: number, y: number, z: number, radius: number) => number,
  agentAddToWorld: (id: number) => void,
  seedBase: number,
): unknown[] {
  const rt: AgentAbiRuntime = { ...agentAbiBaseRt(), hash: null, viewer: activeViewer, agentCreate, agentAddToWorld, seedBase };
  return buildAgentAbiArgs('init', agentAbiShapeOfStore(s), s, rt);
}

/** Run the Agent Init Event once on Reset (Generic Agent Platform). It runs on a
 *  FRESH store (initAgents() always precedes it), so no double-spawn. The user
 *  loops + Create Agent / Add Agent To World to seed the initial population on top
 *  of the config `seedCount` baseline. Host closures encapsulate the engine
 *  interaction; Create stages a slot (alive=0), Add commits it; a Create without
 *  an Add is swept back to the free-list (no leak). */
function runAgentInit(): void {
  if (!agentInitFn || !agentStore) return;
  const s = agentStore;
  const seedBase = s.highWater;   // the seedIndexBase value-out
  const created: number[] = [];
  const createdSet = new Set<number>();
  let overflowed = false;
  const agentCreate = (x: number, y: number, z: number, radius: number): number => {
    const id = allocAgentSlot(s);
    if (id < 0) { overflowed = true; return -1; }
    initAgentSlot(s, id, x, y, z || 0, radius || cbNum(centerBasedConfig!, 'defaultRadius'), id);
    s.alive[id] = 0; s.liveCount--;   // STAGE (un-commit the alloc until Add To World)
    created.push(id);
    createdSet.add(id);
    return id;
  };
  const agentAddToWorld = (id: number): void => {
    // Only commit ids this Init Event actually staged via Create Agent. An
    // arbitrary graph-wired id could otherwise mark a never-initialised slot (or
    // a free-listed one) alive ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â a ghost agent + a permanently wrong liveCount,
    // or a slot later double-allocated by allocAgentSlot.
    if (createdSet.has(id) && !s.alive[id]) { s.alive[id] = 1; s.liveCount++; }
  };
  try {
    (agentInitFn as (...a: unknown[]) => void)(...buildAgentInitArgs(s, agentCreate, agentAddToWorld, seedBase));
  } catch (e) {
    self.postMessage({ type: 'error', message: '[agents] init event failed: ' + ((e as Error)?.message || e) });
  }
  // Leak sweep: free any Created-but-not-Added slot (still staged at alive=0).
  for (const id of created) if (!s.alive[id]) freeStagedSlot(s, id);
  // Sync xNext=x for live agents so a Set Agent Position override propagates
  // through the first integration step (initAgentSlot set xNext at Create time).
  // zNext too in 3D ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â without it a z override is undone by the first swap.
  const initIs3d = s.worldDepth > 1;
  for (let i = 0; i < s.highWater; i++) {
    if (s.alive[i]) { s.xNext[i] = s.x[i]!; s.yNext[i] = s.y[i]!; if (initIs3d) s.zNext[i] = s.z[i]!; }
  }
  // Sync agent mode double-buffers the attributes: the Init Event's Set Attribute
  // / Set Agent Attribute wrote the WRITE buffer, but the first behaviour step (and
  // getState / the first colour pass) read the READ buffer. Copy writeÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢read so the
  // init-built state is the readable initial state. (No-op in async: r aliases w.)
  if (s.syncAttrs) {
    for (const spec of s.attrSpecs) {
      const r = s.attrRead[spec.id], w = s.attrWrite[spec.id];
      if (r && w && r !== w) for (let i = 0; i < s.highWater; i++) r[i] = w[i]!;
    }
  }
  if (overflowed) self.postMessage({ type: 'agentOverflow', message: `Agent capacity reached during Init Event (maxAgents=${s.maxAgents}). Some Create Agent calls were skipped.` });
}

/** Run the Division Event graph per daughter so the user can reassign daughter
 *  attributes (asymmetric inheritance). Daughters already inherited the mother's
 *  attributes VERBATIM in `divideAgent` (daughter A reuses the mother slot, so
 *  its attrs ARE the mother's; daughter B was copied), so a divisionEvent like
 *  "daughter 0: energy = energyÃƒâ€šÃ‚Â·0.7" reads the inherited value and rewrites it.
 *  daughterIndex 0 = A (the reused mother slot), 1 = B (the new slot).
 *
 *  ABI note (z-axis): the divisionEvent's `axisDefaultZ` value-out rides the
 *  `s.divideAxisZ` BUFFER arg (stamped onto both daughters at the division site,
 *  sim.worker.ts ~:1004), NOT a scalar ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â unlike `axisX`/`axisY`, which ARE passed
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

/** Args for the compiled divisionEvent function ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â a SINGLE-agent function (not
 *  loop-wrapped): the daughter slot `idx`, its `daughterIndex` (0/1), the engine
 *  axis defaults, then the same engine buffers + user attrs the behaviour fn
 *  gets. MIRRORS `buildDivisionParams` in compile.ts.
 *
 *  MIRROR invariant (B1/B2): the trailing 3D block (`s.z, s.vz, s.divideAxisZ,
 *  s.worldDepth` ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â NO `forceZ`, division is force-read-only) is pushed ONLY when
 *  `s.worldDepth > 1`, exactly when `buildDivisionParams` pushes its 3D params
 *  under `is3dModel(model)`. `is3dModel(model) ÃƒÂ¢Ã…Â¸Ã‚Âº s.worldDepth > 1` ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â edit BOTH
 *  together or every arg shifts one slot. */
function buildDivisionArgs(s: AgentStore, idx: number, daughterIndex: number, axisX: number, axisY: number): unknown[] {
  // The division event's w_ block ALIASES attrRead (immediate writes in the
  // sequential structural phase, which runs AFTER swapAgentAttrs) ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the shared
  // descriptor handles that per-kind (agentAbi.ts). NO forceZ in the 3D block
  // (division reads forces, never writes them) ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â also in the descriptor.
  const rt: AgentAbiRuntime = { ...agentAbiBaseRt(), hash: null, viewer: activeViewer, idx, daughterIndex, axisX, axisY };
  return buildAgentAbiArgs('division', agentAbiShapeOfStore(s), s, rt);
}

/** Build the args for the compiled behaviourStep function. MIRRORS
 *  `buildAgentLoopParams` in compile.ts EXACTLY (same order). Single-buffer
 *  agent attrs (attrWrite aliases attrRead). Called once per step (the spread
 *  is fine ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the function is loop-wrapped, not per-agent).
 *
 *  MIRROR invariant (B1/B2): the trailing 3D block (`s.z, s.vz, s.forceZ,
 *  s.divideAxisZ, s.worldDepth`) is pushed ONLY when `s.worldDepth > 1`, exactly
 *  when `buildAgentLoopParams` pushes its 3D params under `is3dModel(model)`.
 *  `is3dModel(model) ÃƒÂ¢Ã…Â¸Ã‚Âº s.worldDepth > 1` ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â edit BOTH together. */
/** Args for the compiled behaviour fn. `agentCreate`/`agentAddToWorld` are the
 *  unified-spawn host closures (Create Agent + Add Agent To World in the Behaviour
 *  graph, mid-step). They default to safe NO-OPS (create ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ -1, add ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ no-op) for the
 *  colour-pass + arity-assert call sites, which never spawn; `runAgentStep` passes
 *  the real grow-only closures. */
function buildAgentLoopArgs(
  s: AgentStore, viewerOverride?: string,
  agentCreate: (x: number, y: number, z: number, radius: number) => number = () => -1,
  agentAddToWorld: (id: number) => void = () => {},
): unknown[] {
  const rt: AgentAbiRuntime = { ...agentAbiBaseRt(), hash: currentAgentHash, viewer: viewerOverride ?? activeViewer, agentCreate, agentAddToWorld };
  return buildAgentAbiArgs('loop', agentAbiShapeOfStore(s), s, rt);
}

/** Re-derive the clamped force-integration timestep from the live config.
 *  Mathias-2020 monotonicity bound: for a linear spring `F = ÃƒÅ½Ã‚Â¼(dÃƒÂ¢Ã‹â€ Ã¢â‚¬â„¢s)`,
 *  `ÃƒÅ½Ã¢â‚¬Ât*_mono = 1/(2Ãƒâ€šÃ‚Â·ÃƒÅ½Ã‚Â¼_eff)`, so `ÃƒÅ½Ã¢â‚¬Ât ÃƒÂ¢Ã¢â‚¬Â Ã‚Â min(ÃƒÅ½Ã¢â‚¬Ât_user, 0.4Ãƒâ€šÃ‚Â·ÃƒÅ½Ã¢â‚¬Ât*_mono) = 0.2/ÃƒÅ½Ã‚Â¼_eff`
 *  with `ÃƒÅ½Ã‚Â¼_eff = ÃƒÅ½Ã‚Â¼_R + ÃƒÅ½Ã‚Â»_max`. Must be re-evaluated on any force / bond-ÃƒÅ½Ã‚Â»
 *  parameter change (the silent-drift hazard). */
function clampAgentDt(): void {
  if (!agentStore || !centerBasedConfig) return;
  const muR = cbNum(centerBasedConfig, 'repulsionStiffness');
  const lambda = cbNum(centerBasedConfig, 'bondStiffness');
  const muEff = Math.max(1e-6, muR + lambda);
  agentStore.dt = Math.min(cbNum(centerBasedConfig, 'timeStep'), 0.2 / muEff);
}

/** Commit the position double-buffer (x ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬Â xNext, y ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬Â yNext, and z ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬Â zNext in
 *  3D). ROUTED through this ONE helper (S11) so the reference-swapÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢copy-into
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

/** FULL-COVERAGE WASM agent port: copy the EXTERNAL regions (model attributes /
 *  indicators / lookup tables / cell field arrays) INTO the reserved in-memory
 *  regions the WASM behaviour reads at baked offsets. The cell-field arrays
 *  (`readAttrs[id]`, the closed-feedback source) are copied as f64 (the WASM module
 *  loads them f64). No-op when the store carries no such regions. */
function copyAgentExternalRegionsIn(s: AgentStore): void {
  const L = s.layout; if (!L || !s.memory) return;
  const buf = s.memory.buffer;
  // model attributes (one f64 cell per key)
  for (const key of Object.keys(L.modelAttrOffset)) {
    const v = cachedModelAttrs[key];
    new Float64Array(buf, L.modelAttrOffset[key]!, 1)[0] = typeof v === 'number' ? v : 0;
  }
  // indicators
  if (L.indicatorCount > 0) {
    new Float64Array(buf, L.indicatorsOffset, L.indicatorCount).set(cachedIndicators.subarray(0, L.indicatorCount));
  }
  // lookup tables (row-major f64)
  for (const id of Object.keys(L.lookupTableOffset)) {
    const tbl = cachedInteractionTables[id];
    if (!tbl) continue;
    new Float64Array(buf, L.lookupTableOffset[id]!, tbl.length).set(tbl);
  }
  // cell field arrays (readAttrs[id] ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ f64). The agent-accessible cell attrs.
  if (L.fieldTotal > 0) {
    for (const id of Object.keys(L.fieldOffset)) {
      const src = readAttrs[id]; if (!src) continue;
      const dst = new Float64Array(buf, L.fieldOffset[id]!, L.fieldTotal);
      const n = Math.min(L.fieldTotal, src.length);
      for (let i = 0; i < n; i++) dst[i] = src[i]!;
    }
  }
}

/** Copy the WRITABLE external regions back OUT of agent memory after the WASM
 *  behaviour: the cell field deposit (ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ `readAttrs[id]` so the cell CA step picks
 *  it up ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â Decision D-FIELD) + the indicators (ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ `cachedIndicators` for the stepped
 *  message). Only the agent-ACCESSIBLE-readWrite fields are deposited back. */
function copyAgentExternalRegionsOut(s: AgentStore): void {
  const L = s.layout; if (!L || !s.memory) return;
  const buf = s.memory.buffer;
  // indicators back
  if (L.indicatorCount > 0) {
    const src = new Float64Array(buf, L.indicatorsOffset, L.indicatorCount);
    for (let i = 0; i < L.indicatorCount; i++) cachedIndicators[i] = src[i]!;
  }
  // field deposit back (only the readWrite cell attrs ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the deposit targets)
  if (L.fieldTotal > 0) {
    const writeIds = new Set(fieldSpecs.filter(a => a.agentAccess === 'readWrite').map(a => a.id));
    for (const id of Object.keys(L.fieldOffset)) {
      if (!writeIds.has(id)) continue;
      const dst = readAttrs[id]; if (!dst) continue;
      const src = new Float64Array(buf, L.fieldOffset[id]!, L.fieldTotal);
      const n = Math.min(L.fieldTotal, dst.length);
      for (let i = 0; i < n; i++) dst[i] = src[i]!;
    }
  }
}

/** One agent generation: density reductions ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ compiled behaviour ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ engine force
 *  integration (soft-sphere repulsion + bond springs, overdamped Euler with a
 *  synchronous position double-buffer) ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ world-bounds wrap/clamp ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ age, then the
 *  structural phase (division / growth / death). Neighbour gathering is O(N) via a
 *  uniform CSR spatial hash (buildSpatialHash, built once below and reused by the
 *  force pass + Get Nearby Agents); the all-pairs loop is only a fallback for a
 *  world too small to tile (<3 bins/axis). */
function runAgentStep(): void {
  const s = agentStore;
  if (!s) return;
  const cfg = centerBasedConfig;
  // "Use bonding physics" master toggle (req 10): when OFF, the engine applies NO
  // built-in forces ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â no soft-sphere repulsion/adhesion, no bond springs, no growth
  // ramp, no auto-bond ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â so agents move only by graph-authored Apply Force / Set
  // Velocity. Resolved with the customForcesOnly back-compat fallback so legacy
  // files are byte-identical (their bonding-physics models keep all four; their
  // custom-force models never used springs/growth/auto-bond anyway).
  const bonding = usesBondingPhysics(cfg);
  const springs = usesEngineSprings(cfg);   // bond springs ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the Bonds=Physics capability (decoupled from the legacy bundle)
  const muR = cbNum(cfg, 'repulsionStiffness');
  const muA = cbNum(cfg, 'adhesionStiffness');
  const range = cbNum(cfg, 'interactionRange');
  const eta = Math.max(1e-6, cbNum(cfg, 'drag'));
  const torus = boundaryTreatment === 'torus';   // z wraps iff x/y wrap (B7/C1 ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â ONE flag, all 3 axes)
  const W = s.worldWidth, H = s.worldHeight;
  const halfW = W / 2, halfH = H / 2;
  const is3d = s.worldDepth > 1, D = s.worldDepth, halfD = D / 2;
  const dt = s.dt;
  // Growth ramps radiusÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢targetRadius under the Growth capability (decoupled from
  // the legacy bonding bundle ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â so ticking Growth + Set Target Radius actually
  // ramps). A rate of 0 makes the ramp a no-op (`cur + sign*0 === cur` for trÃƒÂ¢Ã¢â‚¬Â°Ã‚Â cur),
  // so this freezes growth without touching the ramp blocks below.
  const growthRate = usesEngineGrowth(cfg) ? Math.max(0, cbNum(cfg, 'growthRate')) : 0;
  const hw = s.highWater;
  const x = s.x, y = s.y, z = s.z, rad = s.radius, alive = s.alive;
  const maxBonds = s.maxBonds;
  const momentum = Math.max(0, Math.min(0.999, cbNum(cfg, 'momentum')));
  const maxSpeed = Math.max(0, cbNum(cfg, 'maxSpeed'));
  const engineForces = bonding;
  // Collision capability (Agent Capability Profiles): the soft-sphere REPULSION
  // (volume exclusion) IS the collision ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â driven by the Collision capability
  // independently of the bonding-physics bundle, so a pure gas (Collision on, "Use
  // bonding physics" off) gets non-penetrating collision without cohesion/springs.
  // `muRep` = repulsion coefficient (Collision on), `muAdh` = adhesion coefficient
  // (bonding physics). `doForce` runs the neighbour force block when EITHER is on.
  // For every shipped sample doCollision === engineForces, so muRep/muAdh reduce to
  // muR/muA and this is byte-identical (verified by the force-pass parity harness).
  const doCollision = usesSoftCollision(cfg);   // SOFT-sphere repulsion force (positional collision runs a separate projection pass below)
  const muRep = doCollision ? muR : 0;
  const muAdh = engineForces ? muA : 0;
  const doForce = doCollision || engineForces;
  // P1 (the dead density scan): the neighbour pass exists for (a) the soft-sphere
  // force and (b) the density count. With engine physics OFF and NO density
  // consumer in the graph (no neighbourDensity; no divideAgent, whose degenerate
  // axis fallback reads density), skip the WHOLE scan — measured ~70% of a
  // custom-force model's force-pass cost. density[] then keeps its last value,
  // which nothing observes (the inspector may show a stale/initial 0).
  const doScan = doForce || agentUsesDensity;

  // Reset the per-step force accumulator (Apply Force adds into it during
  // behaviour) BEFORE behaviour runs. forceZ is a memset of an always-zero-in-2D
  // array ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â byte-irrelevant for 2D, used by the 3D arm.
  s.forceX.fill(0, 0, hw); s.forceY.fill(0, 0, hw); s.forceZ.fill(0, 0, hw);

  // Build the uniform spatial hash from current positions ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â O(N) neighbour
  // lookups instead of O(NÃƒâ€šÃ‚Â²). Built BEFORE behaviour so Get Nearby Agents can
  // query it, then reused by the force pass. null for a world too small to tile
  // (ÃƒÂ¢Ã¢â‚¬Â°Ã‚Â¥3 bins/axis); the all-pairs fallback runs there. The interaction range OR
  // a larger Get-Nearby query radius sets the bin edge ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â sized generously so the
  // 3ÃƒÆ’Ã¢â‚¬â€3 stencil covers both the soft-sphere cutoff AND typical neighbour queries.
  let maxR = cbNum(cfg, 'defaultRadius');
  for (let i = 0; i < hw; i++) { if (alive[i] && rad[i]! > maxR) maxR = rad[i]!; }
  const binEdge = Math.max(range * 2 * maxR, cbNum(cfg, 'neighbourQueryRadius'));
  const hash = buildSpatialHash(s, Math.max(1e-3, binEdge), W, H, D, boundaryTreatment === 'torus', agentHashReserve);
  currentAgentHash = hash;

  // Compiled behaviour (reads positions + the PREVIOUS step's density ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â a
  // one-step lag, the cost of fusing density into the single neighbour pass;
  // densities change slowly so it's a fine approximation; queries the hash via
  // Get Nearby Agents). Writes attrs / colours / forces / div+kill+bond requests.
  // Sync update mode (independent of the grid): prime the write buffer = a clone
  // of the read buffer, so attributes the behaviour doesn't touch carry over and
  // the behaviour reads the PREVIOUS step's attrs while writing the next. No-op in
  // async mode (single buffer) ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â byte-identical to pre-feature.
  primeAgentAttrWrite(s);

  // PR6b-2: dispatch the behaviour loop on the agent target. The WASM loop reads/
  // writes the SAME store memory at the baked offsets (AW-MEM), so the force pass /
  // structural phase BELOW reads the same views. (W1: the force pass itself may now
  // also run on WASM ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â see the forcePass dispatch after swapAgentAttrs; the
  // structural phase + hash build always stay JS.)
  //
  // AW-RNG + AW-HASH: before the WASM call we (1) write the global `rngState[0]`
  // into the in-memory RNG cell (the WASM loop advances it + writes it back ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â JS
  // bit-parity, B13), and (2) COPY the per-step spatial hash (binStart/binAgents)
  // into the reserved in-memory views (S10) when it fits the layout's reserve;
  // the hash DIMENSIONS ride the call args. If the hash overflows the reserve
  // (the fits-check), we fall back to JS for this step (never silently wrong).
  // Unified spawning ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â RESET the per-step created-slot tracking. The grow-only
  // Create Agent + Add Agent To World closures (module-level `agentBehaviourCreate` /
  // `agentBehaviourAddToWorld`) are STABLE (so the WASM `env.agentCreate`/`env.agentAddToWorld`
  // imports, bound once at instantiate, share the SAME logic as the JS behaviour ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢
  // bit-identical). They read `agentStore` + this per-step list.
  spawnCreatedList.length = 0; spawnCreatedSet.clear();
  const runBehaviourJs = () => agentBehaviourFn!(...buildAgentLoopArgs(s, undefined, agentBehaviourCreate, agentBehaviourAddToWorld));

  let ranWasm = false;
  // W1 ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â force-pass eligibility + the hash dims it reuses. The WASM force pass can
  // only run when the WASM behaviour ran this step (so the in-memory hash was
  // copied in + the store is wasmBacked). Captured in the success branch below.
  let forcePassReady = false;
  let fpHashValid = 0, fpNBinsX = 0, fpNBinsY = 0, fpNBinsZ = 0, fpBinSizeX = 1, fpBinSizeY = 1, fpBinSizeZ = 1;
  let fpOriginX = 0, fpOriginY = 0, fpOriginZ = 0;
  if (agentBehaviourWasmFn && s.wasmBacked && s.memory && s.layout) {
    const fits = !hash || (hash.nBinsX * hash.nBinsY * hash.nBinsZ + 1) <= (s.layout.maxHashBins + 1);
    if (!fits) {
      // The hash exceeded the AW-HASH reserve ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â run this step on the JS fn (the
      // WASM module's binStart view can't hold it). Loud once, then per-step quiet.
      if (!agentWasmHashOverflowWarned) {
        agentWasmHashOverflowWarned = true;
        self.postMessage({ type: 'error', message: `[agents] spatial hash (${hash!.nBinsX * hash!.nBinsY * hash!.nBinsZ} bins) exceeds the WASM reserve (${s.layout.maxHashBins}); this step runs on JS.` });
      }
      if (agentBehaviourFn) { try { runBehaviourJs(); ranWasm = true; } catch { agentBehaviourFn = null; } }
    } else {
      try {
        const buf = s.memory.buffer;
        const L = s.layout;
        // (1) seed the RNG cell from the shared stream.
        new Uint32Array(buf, L.rngStateOffset, 1)[0] = rngState[0]!;
        // (2) copy the hash into the reserved views (only the live prefix). The
        // hash DIMS go as args (no per-step memory write for the scalars).
        let hashValid = 0, nBinsX = 0, nBinsY = 0, nBinsZ = 0, binSizeX = 1, binSizeY = 1, binSizeZ = 1;
        let originX = 0, originY = 0, originZ = 0;
        if (hash) {
          hashValid = 1;
          nBinsX = hash.nBinsX; nBinsY = hash.nBinsY; nBinsZ = hash.nBinsZ;
          binSizeX = hash.binSizeX; binSizeY = hash.binSizeY; binSizeZ = hash.binSizeZ;
          originX = hash.originX; originY = hash.originY; originZ = hash.originZ;
          const nBins = nBinsX * nBinsY * nBinsZ;
          const dstStart = new Int32Array(buf, L.hashBinStartOffset, nBins + 1);
          dstStart.set(hash.binStart.subarray(0, nBins + 1));
          // binAgents holds liveCount entries grouped by bin (= binStart[nBins]).
          const used = hash.binStart[nBins]!;
          if (used > 0) new Int32Array(buf, L.hashBinAgentsOffset, used).set(hash.binAgents.subarray(0, used));
        }
        // FULL-COVERAGE: copy the EXTERNAL regions (model attrs / indicators /
        // lookup tables / cell fields) into the reserved in-memory regions the WASM
        // module reads at baked offsets. The cell-field arrays (`readAttrs[id]`) are
        // the closed-feedback source; the WASM behaviour reads + writes them, and we
        // copy the deposit back out AFTER (Decision D-FIELD).
        copyAgentExternalRegionsIn(s);
        agentBehaviourWasmFn(s.highWater, hashValid, nBinsX, nBinsY, nBinsZ, binSizeX, binSizeY, binSizeZ, W, H, D, torus ? 1 : 0, originX, originY, originZ,
          agentWasmViewerGuardIds.indexOf(activeViewer));
        // (3) read the advanced RNG state back so the shared stream stays in lockstep.
        rngState[0] = new Uint32Array(buf, L.rngStateOffset, 1)[0]!;
        // copy the field deposit + indicators back out (the cell CA step incorporates
        // the deposit; the indicators surface in the stepped message).
        copyAgentExternalRegionsOut(s);
        ranWasm = true;
        // W1 ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the in-memory hash is now valid for the SAME step, so the WASM force
        // pass may reuse it. Stash the dims it needs (mirrors the behaviour's).
        forcePassReady = true;
        fpHashValid = hashValid; fpNBinsX = nBinsX; fpNBinsY = nBinsY; fpNBinsZ = nBinsZ;
        fpBinSizeX = binSizeX; fpBinSizeY = binSizeY; fpBinSizeZ = binSizeZ;
        fpOriginX = originX; fpOriginY = originY; fpOriginZ = originZ;
      } catch (e) {
        self.postMessage({ type: 'error', message: '[agents] WASM behaviour run failed, falling back to JS: ' + ((e as Error)?.message || e) });
        agentBehaviourWasmFn = null;
        agentForcePassWasmFn = null;  // W1 ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â drop the force pass too; this step runs fully on JS
        if (agentBehaviourFn) { try { runBehaviourJs(); ranWasm = true; } catch { agentBehaviourFn = null; } }
      }
    }
  }
  if (!ranWasm && agentBehaviourFn) {
    try {
      runBehaviourJs();
    } catch (e) {
      self.postMessage({ type: 'error', message: '[agents] behaviour run failed: ' + ((e as Error)?.message || e) });
      agentBehaviourFn = null;
    }
  }

  // Unified spawning leak-sweep ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â free any Create Agent whose handle was never Added
  // (still staged at alive=0). freeStagedSlot pushes it to the free-list, where the
  // structural phase (division) or the next Reset reclaims it. The common
  // Create ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ configure ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ Add sequence stages nothing, so this is usually a no-op.
  for (const id of spawnCreatedList) if (!s.alive[id]) freeStagedSlot(s, id);

  // Sync update mode: swap the double-buffered attrs in, so the values the
  // behaviour just wrote become the live (read) buffer for the structural phase,
  // the render snapshot, and the next step. No-op in async mode.
  swapAgentAttrs(s);

  // W1 ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â THE FORCE PASS (the boost). When the WASM behaviour ran this step AND a
  // force-pass export exists, run the WASM force integrator INSTEAD of the JS loop
  // below ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â it reads/writes the SAME store memory (xNext/yNext[/zNext], vx/vy[/vz],
  // density, radius) at the baked offsets, reusing the in-memory hash already
  // copied in for the behaviour. f64 throughout ÃƒÂ¢Ã¢â‚¬Â¡Ã¢â‚¬â„¢ JSÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬ÂWASM bit-exact. Mirrored
  // scalar-config ABI (see emitForcePass): the order here MUST match FORCE_PASS_PARAMS.
  let ranForceWasm = false;
  if (forcePassReady && agentForcePassWasmFn) {
    try {
      const dtOverEta = dt / eta;
      agentForcePassWasmFn(
        // `hw` (the PRE-behaviour bound), not the post-spawn `s.highWater`, so a
        // mid-step-Created newborn (grow-allocated beyond `hw`) is NOT force-integrated
        // the step it's born ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â it stays where Create placed it (matches the JS force
        // loop, which also iterates `hw`). Identical for non-spawn (hw === s.highWater).
        hw, fpHashValid, fpNBinsX, fpNBinsY, fpNBinsZ,
        fpBinSizeX, fpBinSizeY, fpBinSizeZ,
        dtOverEta, muR, muA, range, momentum, maxSpeed, growthRate,
        W, H, D, bonding ? 1 : 0, torus ? 1 : 0,
        fpOriginX, fpOriginY, fpOriginZ,
        doCollision ? 1 : 0, springs ? 1 : 0, agentUsesDensity ? 1 : 0,
      );
      ranForceWasm = true;
    } catch (e) {
      self.postMessage({ type: 'error', message: '[agents] WASM force pass failed, falling back to JS: ' + ((e as Error)?.message || e) });
      agentForcePassWasmFn = null;  // drop it; the JS loop below runs this step
    }
  }

  // Single neighbour pass: graph-authored force (forceX/Y[/Z] from Apply Force) +
  // soft-sphere repulsion/adhesion (unless customForcesOnly) + bond springs +
  // density (for next step), integrated into the xNext/yNext[/zNext] double-buffer.
  // Branched on `is3d` ONCE (not per-line): the 2D else-branch is the EXACT
  // current code, verbatim (the grid's literal-verbatim-2D-fast-path lesson ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â a
  // branchless always-0-dz body would change the 2D arithmetic + stencil count).
  // SKIPPED when the WASM force pass ran this step (W1).
  if (ranForceWasm) {
    // nothing ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the WASM force pass already wrote xNext/yNext[/zNext], vx/vy[/vz],
    // density, radius, and age into the store memory. swapPositions commits below.
  } else if (is3d) {
    const xN = s.xNext, yN = s.yNext, zN = s.zNext;
    const vxArr = s.vx, vyArr = s.vy, vzArr = s.vz;
    for (let i = 0; i < hw; i++) {
      if (!alive[i]) { xN[i] = x[i]!; yN[i] = y[i]!; zN[i] = z[i]!; continue; }
      const xi = x[i]!, yi = y[i]!, zi = z[i]!, ri = rad[i]!;
      let fx = s.forceX[i]!, fy = s.forceY[i]!, fz = s.forceZ[i]!, dens = 0;

      // --- neighbour pass: 3ÃƒÆ’Ã¢â‚¬â€3ÃƒÆ’Ã¢â‚¬â€3 stencil over the z-major hash, torus-wrapped ---
      if (doScan && hash) {
        const nBinsX = hash.nBinsX, nBinsY = hash.nBinsY, nBinsZ = hash.nBinsZ;
        const binStart = hash.binStart, binAgents = hash.binAgents;
        let bx = ((xi - hash.originX) / hash.binSizeX) | 0; if (bx < 0) bx = 0; else if (bx >= nBinsX) bx = nBinsX - 1;
        let by = ((yi - hash.originY) / hash.binSizeY) | 0; if (by < 0) by = 0; else if (by >= nBinsY) by = nBinsY - 1;
        let bz = ((zi - hash.originZ) / hash.binSizeZ) | 0; if (bz < 0) bz = 0; else if (bz >= nBinsZ) bz = nBinsZ - 1;
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
                if (doForce) {
                  const d = Math.sqrt(d2);
                  const F = ((d < sij) ? muRep : muAdh) * (d - sij);
                  const k = F / d;
                  fx += k * dx; fy += k * dy; fz += k * dz;
                }
              }
            }
          }
        }
      } else if (doScan) {
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
          if (doForce) {
            const d = Math.sqrt(d2);
            const F = ((d < sij) ? muRep : muAdh) * (d - sij);
            const k = F / d;
            fx += k * dx; fy += k * dy; fz += k * dz;
          }
        }
      }
      if (doScan) s.density[i] = dens;

      // --- bond springs ÃƒÅ½Ã‚Â»(lÃƒÂ¢Ã‹â€ Ã¢â‚¬â„¢L)Ãƒâ€šÃ‚Â·rÃƒÅ’Ã¢â‚¬Å¡ over the 3-vector (dangling-bond epoch ABI) ---
      // Gated on the Bonds=Physics capability: Data bonds are connectivity edges
      // that carry NO force (only Physics bonds are springs).
      const bc = s.bondCount[i]!;
      if (springs && bc > 0) {
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

      // Integrate (3-vector); momentum 0 ÃƒÂ¢Ã¢â‚¬Â¡Ã¢â‚¬â„¢ overdamped; optional 3D-speed cap.
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
      if (doScan && hash) {
        const nBinsX = hash.nBinsX, nBinsY = hash.nBinsY;
        const binStart = hash.binStart, binAgents = hash.binAgents;
        let bx = ((xi - hash.originX) / hash.binSizeX) | 0; if (bx < 0) bx = 0; else if (bx >= nBinsX) bx = nBinsX - 1;
        let by = ((yi - hash.originY) / hash.binSizeY) | 0; if (by < 0) by = 0; else if (by >= nBinsY) by = nBinsY - 1;
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
              if (doForce) {
                const d = Math.sqrt(d2);
                const F = ((d < sij) ? muRep : muAdh) * (d - sij);
                const k = F / d;
                fx += k * dx; fy += k * dy;
              }
            }
          }
        }
      } else if (doScan) {
        for (let j = 0; j < hw; j++) {
          if (j === i || !alive[j]) continue;
          let dx = x[j]! - xi, dy = y[j]! - yi;
          if (torus) { if (dx > halfW) dx -= W; else if (dx < -halfW) dx += W; if (dy > halfH) dy -= H; else if (dy < -halfH) dy += H; }
          const d2 = dx * dx + dy * dy;
          const sij = ri + rad[j]!;
          const rmax = range * sij;
          if (d2 === 0 || d2 >= rmax * rmax) continue;
          dens++;
          if (doForce) {
            const d = Math.sqrt(d2);
            const F = ((d < sij) ? muRep : muAdh) * (d - sij);
            const k = F / d;
            fx += k * dx; fy += k * dy;
          }
        }
      }
      if (doScan) s.density[i] = dens;

      // --- bond springs ÃƒÅ½Ã‚Â»(lÃƒÂ¢Ã‹â€ Ã¢â‚¬â„¢L)Ãƒâ€šÃ‚Â·rÃƒÅ’Ã¢â‚¬Å¡ (no-op until bonds exist). The partnerEpoch
      // check is the dangling-bond ABI ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â a recycled slot's stale bond reads
      // epoch-mismatch and is skipped. Gated on the Bonds=Physics capability
      // (Data bonds are force-free edges). ---
      const bc = s.bondCount[i]!;
      if (springs && bc > 0) {
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

      // Integrate: velocity = momentumÃƒâ€šÃ‚Â·velocity + (ÃƒÅ½Ã¢â‚¬Ât/ÃƒÅ½Ã‚Â·)Ãƒâ€šÃ‚Â·force; position += velocity.
      // momentum 0 ÃƒÂ¢Ã¢â‚¬Â¡Ã¢â‚¬â„¢ vx = (ÃƒÅ½Ã¢â‚¬Ât/ÃƒÅ½Ã‚Â·)Ãƒâ€šÃ‚Â·fx, the original overdamped step (byte-identical
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
  // Commit positions (synchronous double-buffer swap; S11 helper ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â z swapped in 3D).
  swapPositions(s, is3d);

  // HARD positional collision (Collision capability = 'positional'): a rigid,
  // no-overlap position-projection constraint on the just-committed positions ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â
  // the alternative to the soft-sphere FORCE above (which is off for positional).
  // Runs `positionalIterations` Jacobi sweeps; the structural phase below then
  // sees the settled, non-overlapping positions.
  if (usesPositionalCollision(cfg)) {
    const iters = Math.max(1, Math.floor(cbNum(cfg, 'positionalIterations')));
    resolvePositionalCollisions(s, iters, binEdge, agentHashReserve, W, H, D, is3d, torus);
  }

  // Post-step structural phase: bond form/break (Phase B), division + growth +
  // death (Phase C). Mutates the bond/agent topology on the SETTLED state.
  runAgentStructuralPhase();

  // Sprite playback: advance each agent's sprite frame by its per-agent speed
  // (logic-driven animation ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â Set Agent Sprite set the speed; the render floors +
  // wraps the frame). Per simulation step, so the animation only progresses while
  // the sim runs. Gated on the model having sprites.
  if (hasAgentSprites) advanceAgentSprites(s);
}

/** PR7 G3-runtime ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â one agent generation on the WebGPU agent target. The GPU
 *  sibling of `runAgentStep`'s WASM dispatch: the CPU does the prep (reset forces,
 *  build the spatial hash, prime the sync attr buffer), uploads the SoA + hash,
 *  dispatches the behaviour then the force shader, and reads `x/y/vx/vy/radius/
 *  density/age` back into the CPU store ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â then the structural phase runs CPU-side
 *  on the settled state (a no-op for the Boids headline: no bonds / division).
 *  ASYNC (the readback awaits a `mapAsync`); the caller awaits it inside the step
 *  batch loop. Returns whether the GPU path actually ran (false ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ the caller runs
 *  the JS `runAgentStep()` for this step). The force pass + bond springs + the
 *  hash BUILD stay CPU-mirror with the JS path; the gate keeps bonds/division out
 *  of WebGPU-target graphs so the GPU force pass is exact for those models. */
/** Per-indicator-slot int/tag flag (the same order the compiler resolved
 *  `_indicatorIdx` = the index into `indicatorsList`). int/tag standalone
 *  indicators are bitcast<i32>; everything else bitcast<f32>. */
function agentWebgpuIndicatorIsInt(): boolean[] {
  return indicatorsList.map(ind => ind.kind === 'standalone' && (ind.dataType === 'integer' || ind.dataType === 'tag'));
}

/** Mutation messages that must NOT run while a GPU agent step's readback is in
 *  flight: the async awaits yield to onmessage, so a move/seed/paint applied
 *  mid-step would be clobbered when `readbackAgentStep` (agents) or
 *  `readbackAgentField` (cell fields) overwrites the CPU arrays with
 *  pre-mutation GPU values. Deferred + replayed right after the step settles. */
const AGENT_GPU_DEFER_TYPES = new Set<string>([
  'seedAgents', 'createAgent', 'killAgents', 'paintAgents', 'moveAgents', 'pasteAgents',
  'formBond', 'formBondBatch', 'breakBond', 'clearAgents',
  'paint', 'paintManual', 'writeRegion', 'clearRegion', 'importGridValues',
]);
let agentGpuStepInFlight = false;
// NB (audit N4): this deferral and `asyncStepBatchInFlight` below are NOT peers.
// The async-batch guard runs FIRST in the dispatcher and defers EVERY message
// type, so while a step batch is running nothing reaches this one — it only
// covers a GPU agent step started OUTSIDE a batch (a mutation-driven present /
// colour pass). Keep both: they have different scopes, and the async-batch guard
// is the P0 corruption fix, not a superset by design.
let deferredDuringAgentGpuStep: WorkerMsg[] = [];

/** P0 (the "GPU dynamics" bug): the ASYNC step-batch branches (WebGPU grid /
 *  WebGPU agents) yield to onmessage at every await — so a second `step` (or any
 *  state-touching message) arriving MID-BATCH interleaved a CONCURRENT batch
 *  with the running one: uploads of stale CPU state raced fresh GPU results and
 *  the dynamics froze/corrupted with ZERO errors (single steps + strictly
 *  sequential batches were bit-correct; only overlapped batches broke). The
 *  synchronous JS/WASM batch loop can't be interleaved AT ALL — so the async
 *  branches must reproduce exactly that: while a batch is in flight, EVERY
 *  incoming message is deferred and replayed IN ORDER after the batch settles.
 *  A replayed `step` that starts a new async batch re-arms the guard; the rest
 *  of the replay queue then re-defers into the fresh queue (order preserved). */
let asyncStepBatchInFlight = false;
let deferredDuringAsyncBatch: WorkerMsg[] = [];

function endAsyncStepBatch(): void {
  asyncStepBatchInFlight = false;
  if (deferredDuringAsyncBatch.length === 0) return;
  const q = deferredDuringAsyncBatch;
  deferredDuringAsyncBatch = [];
  for (const m of q) self.onmessage!.call(self as never, { data: m } as MessageEvent<WorkerMsg>);
}

function flushDeferredAgentGpuMsgs(): void {
  if (deferredDuringAgentGpuStep.length === 0) return;
  const q = deferredDuringAgentGpuStep;
  deferredDuringAgentGpuStep = [];
  for (const m of q) self.onmessage!.call(self as never, { data: m } as MessageEvent<WorkerMsg>);
}

/** E1b — the per-gen GPU field bridge context: the LIVE grid `attrsRead` buffer
 *  (it ping-pongs per step — re-resolve EVERY gen) + the grid attr byte offsets.
 *  Passed only for a float-field WebGPU-grid + WebGPU-agent model on the shared
 *  device; absent ⇒ runAgentStepWebGPUInner uses the CPU field bridge. */
interface GpuFieldBridge {
  gridAttrsReadBuf: GPUBuffer;
  gridByteOffset: Record<string, number>;
}

// E1b DEV probe (verification only, mirrors E1's sharedGpuAdapterRequestCount) —
// how many generations ran the GPU field bridge vs fell back to the CPU bridge.
// The app never reads these; a test harness requests them via '__e1bCounters'.
let e1bGpuBridgeGenCount = 0;
let e1bCpuBridgeFallbackCount = 0;

async function runAgentStepWebGPU(gpuFieldBridge?: GpuFieldBridge | null): Promise<boolean> {
  agentGpuStepInFlight = true;
  try {
    return await runAgentStepWebGPUInner(gpuFieldBridge);
  } finally {
    agentGpuStepInFlight = false;
    flushDeferredAgentGpuMsgs();
  }
}

/** E1b gate — a field-coupled agent model on a WebGPU grid + WebGPU agents,
 *  sharing the E1 device, whose agent-accessible cell attrs are ALL `float`, runs
 *  the per-gen field round-trip via GPU copyBufferToBuffer instead of the CPU
 *  upload/readback. General properties only: WebGPU grid + WebGPU agent target +
 *  live runtimes + the same GPUDevice + a field bridge present + every fieldSpec
 *  float. Any int/bool/tag field, a non-shared device, or a missing runtime →
 *  false → the CPU bridge (unchanged). */
function agentFieldBridgeGpuEligible(): boolean {
  const rt = agentWebgpuRuntime, grid = webgpuRuntime;
  if (!rt || !rt.ready || agentTarget !== 'webgpu') return false;
  if (!useWebGPU || !grid?.stepReady || !grid.attrsReadBuf) return false;
  if (rt.device !== grid.device) return false;                         // E1 shared device required
  if (rt.layout.fieldReadLen === 0 && rt.layout.fieldWriteLen === 0) return false;  // not a field model
  for (const s of fieldSpecs) { if (s.type !== 'float') return false; }             // float byte-pattern copy only
  return true;
}

/** M4 gate - a field-DECOUPLED agent model whose resolved agent target is WebGPU.
 *  Decoupled = the agent layer and the cell grid share NO state: no field node is
 *  reachable in the agent graph (agentUsesField), no cell attribute grants agent
 *  access (fieldSpecs), and the compiled GPU agent layout therefore reserved no
 *  field regions. Such a generation is an ordinary per-gen GPU agent step with NO
 *  bridge - the same dispatch the JS/WASM-grid branch already uses. Used ONLY by
 *  the WebGPU-grid step branch, which used to run these agents on the CPU
 *  regardless of the user's agent-target choice (E1b's routing covered the
 *  field-COUPLED case only). General properties only; mirrors the decoupling term
 *  in agentResidentEligible + the main thread's render gate. */
function agentDecoupledGpuAgents(): boolean {
  const rt = agentWebgpuRuntime;
  if (!rt || !rt.ready || agentTarget !== 'webgpu') return false;
  if (agentUsesField || fieldSpecs.length > 0) return false;
  return rt.layout.fieldReadLen === 0 && rt.layout.fieldWriteLen === 0;
}

// M4 DEV probe (verification only, mirrors the E1b counters) - how many
// generations of the WebGPU-GRID branch dispatched their agents on the GPU
// decoupled path vs fell back to the CPU agent step. Reported via '__e1bCounters'.
let m4DecoupledGpuGenCount = 0;
let m4DecoupledCpuFallbackCount = 0;

/** Build the per-gen GPU field bridge context. The grid `attrsReadBuf` ping-pongs
 *  per step, so this MUST be rebuilt EVERY gen (never cache it across steps). */
function buildGpuFieldBridge(): GpuFieldBridge | null {
  const grid = webgpuRuntime;
  if (!grid || !grid.attrsReadBuf) return null;
  const gridByteOffset: Record<string, number> = {};
  for (const a of grid.layout.attrs) gridByteOffset[a.id] = a.byteOffset;
  return { gridAttrsReadBuf: grid.attrsReadBuf, gridByteOffset };
}

// ---------------------------------------------------------------------------
// PR7c — GPU residency. When the model qualifies, a WHOLE gens/frame batch runs
// on the GPU in ONE queue submit (per-gen GPU hash build + behaviour + force +
// position commit) with a SINGLE per-frame readback — eliminating the measured
// maxAgents-proportional per-generation upload/readback/pack overhead (~60% of
// the GPU step time at 50k agents). The CPU store is refreshed once per frame
// (readbackAgentFrame), so paint/inspect/save see ≤1-frame-fresh state; any
// mutation sets agentGpuUploadPending and the next batch re-uploads.
// ---------------------------------------------------------------------------

/** Residency eligibility — every condition here exists because the excluded
 *  feature needs per-generation CPU work (structural phase, field bridge, sync
 *  attr swap, positional projection, stop drain, indicator sync) or CPU-visible
 *  per-gen state (spawn reconcile). Anything ineligible falls back to the
 *  per-generation GPU path — never silently wrong. */
function agentResidentEligible(): boolean {
  const s = agentStore, rt = agentWebgpuRuntime, cfg = centerBasedConfig;
  if (!s || !rt || !rt.ready || agentTarget !== 'webgpu' || !cfg) return false;
  return (
    agentGraphResidencyClean
    // D: field-DECOUPLED, not agents-only. The agent layer never touches a cell
    // field, so a grid+agents model is two INDEPENDENT sims sharing a viewport —
    // the agents run resident (one submit) while the grid steps by its own JS/WASM
    // per-gen path (the resident branch interleaves them; see the `step` handler).
    // The predicate is general: no field node reachable (agentUsesField) AND no
    // cell attr grants agent access (fieldSpecs). Replaces the agents-only proxy.
    && !agentUsesField
    && fieldSpecs.length === 0
    && simulateAgents
    && cfg.agentUpdateMode !== 'sync'          // async single-buffer attrs on the GPU
    && !usesPositionalCollision(cfg)           // CPU projection pass is per-gen
    && !usesEngineSprings(cfg) && s.maxBonds === 0   // no bond store / auto-bond scan
    && !(usesEngineGrowth(cfg) && cbNum(cfg, 'growthRate') > 0)  // radius static ⇒ hash edge static
    && !rt.usesSpawn && !rt.usesStop
    && !rt.indicatorsBuf                        // indicator accumulation needs per-gen sync
    && stopMessages.length === 0
  );
}

/** Run `count` generations fully GPU-resident (one submit) + one frame readback.
 *  Returns false on any failure (pipelines unavailable / device error) — the
 *  caller falls back to the per-generation path for this batch. */
async function runAgentBatchResident(count: number, bumpGeneration: boolean = true): Promise<boolean> {
  const s = agentStore, rt = agentWebgpuRuntime, cfg = centerBasedConfig;
  if (!s || !rt || !cfg) return false;
  agentGpuStepInFlight = true;
  try {
    // B1: the ENGINE force pass runs its neighbour scan (bonding || collision ||
    // a density consumer). Only then does the resident hash build scatter the
    // bin-sorted mirror + the resident force pass read neighbours from it. A
    // pure-custom-force model (Boids/PL) skips the scan ⇒ no mirror cost. STATIC
    // per model under residency eligibility (radius/config don't drift mid-batch).
    const needScan = usesBondingPhysics(cfg) || usesSoftCollision(cfg) || agentUsesDensity;
    if (!(await ensureAgentResident(rt, needScan))) return false;
    const hw = s.highWater;
    // Per-batch hash geometry — CPU-computed once (radius is static under the
    // eligibility gate, so maxR can't drift mid-batch).
    let maxR = cbNum(cfg, 'defaultRadius');
    for (let i = 0; i < hw; i++) if (s.alive[i] && s.radius[i]! > maxR) maxR = s.radius[i]!;
    const hp = computeResidentHashParams(
      width, height, depth,
      cbNum(cfg, 'interactionRange'), maxR, cbNum(cfg, 'neighbourQueryRadius'),
      rt.layout.maxHashBins,
    );
    const torus = boundaryTreatment === 'torus';
    // Upload the CPU store ONLY when something mutated it since the last batch.
    // The force accumulators are zeroed first (a JS fallback step may have left
    // them nonzero) — the per-gen zeroing lives in the GPU posCommit pass.
    if (agentGpuUploadPending) {
      s.forceX.fill(0, 0, hw); s.forceY.fill(0, 0, hw); s.forceZ.fill(0, 0, hw);
      uploadAgentSoA(rt, s);
      agentGpuUploadPending = false;
    }
    // Uniforms once per batch (highWater is static — no spawn under eligibility).
    uploadAgentControl(rt, {
      highWater: hw, hashValid: hp.hashValid, nBinsX: hp.nBinsX, nBinsY: hp.nBinsY,
      fieldTorus: torus ? 1 : 0,
      binSizeX: hp.binSizeX, binSizeY: hp.binSizeY,
      fieldW: width, fieldH: height,
      nBinsZ: hp.nBinsZ, binSizeZ: hp.binSizeZ, fieldD: s.worldDepth,
      originX: 0, originY: 0, originZ: 0,
    });
    const eta = Math.max(1e-6, cbNum(cfg, 'drag'));
    uploadAgentForceControl(rt, hw, {
      hashValid: hp.hashValid, nBinsX: hp.nBinsX, nBinsY: hp.nBinsY,
      binSizeX: hp.binSizeX, binSizeY: hp.binSizeY,
      dtOverEta: s.dt / eta,
      muR: cbNum(cfg, 'repulsionStiffness'), muA: cbNum(cfg, 'adhesionStiffness'),
      range: cbNum(cfg, 'interactionRange'),
      momentum: Math.max(0, Math.min(0.999, cbNum(cfg, 'momentum'))),
      maxSpeed: Math.max(0, cbNum(cfg, 'maxSpeed')),
      growthRate: 0,                          // eligibility: growth off
      fieldW: width, fieldH: height,
      bonding: usesBondingPhysics(cfg) ? 1 : 0,
      doCollision: usesSoftCollision(cfg) ? 1 : 0,
      doDensity: agentUsesDensity ? 1 : 0,
      torus: torus ? 1 : 0,
      nBinsZ: hp.nBinsZ, binSizeZ: hp.binSizeZ, fieldD: s.worldDepth,
      originX: 0, originY: 0, originZ: 0,
    });
    if (rt.layout.auxF32Len > 0 && rt.auxF32Buf) {
      const tables: Record<string, ArrayLike<number>> = {};
      for (const id of rt.layout.lookupTableIds) { const t = cachedInteractionTables[id]; if (t) tables[id] = t; }
      uploadAgentAux(rt, cachedModelAttrs as Record<string, number>, tables);
    }
    uploadAgentHashParams(rt, hw, hp, torus);
    // A1.5 — the OM colour pass appended inside dispatchResidentBatch selects this
    // mapping (the active agent viewer; may have switched since the last batch).
    rt.activeOmMappingId = agentColorViewer;
    rt.device.pushErrorScope('validation');
    dispatchResidentBatch(rt, count, hw, hp);
    const dispatchErr = await rt.device.popErrorScope();
    if (dispatchErr) {
      self.postMessage({ type: 'error', message: '[agents][gpu] resident batch validation error: ' + dispatchErr.message });
      agentGpuUploadPending = true;   // GPU state unknown — re-upload next time
      return false;
    }
    // A1 readback policy: when the frame is rendered GPU-side AND no feature
    // needs live CPU state, SKIP the per-frame readback — the render already
    // presented inside dispatchResidentBatch's submit (GPU-authoritative). The
    // one-shot rule in the message dispatcher pulls state down for any consumer.
    if (agentRenderActive && !agentUiSync) {
      agentStoreStale = true;
      agentBatchPresented = true;   // the batch's submit included the present
    } else {
      await readbackAgentFrame(rt, s);
      agentStoreStale = false;
      // The batch still presented internally (render active) — flag it so
      // sendColors doesn't re-present from the (now-fresh) store redundantly.
      agentBatchPresented = agentRenderActive;
    }
    // Sprite frames advance CPU-side (independent of the GPU SoA) — one tick/gen.
    if (hasAgentSprites) for (let k = 0; k < count; k++) advanceAgentSprites(s);
    // D: a decoupled grid+agents batch counts the generation via the grid's cell
    // steps (bumpGeneration=false); an agents-only batch owns the count here.
    if (bumpGeneration) generation += count;
    return true;
  } catch (e) {
    self.postMessage({ type: 'error', message: '[agents] resident batch failed, falling back: ' + ((e as Error)?.message || e) });
    agentGpuUploadPending = true;
    return false;
  } finally {
    agentGpuStepInFlight = false;
    flushDeferredAgentGpuMsgs();
  }
}

async function runAgentStepWebGPUInner(gpuFieldBridge?: GpuFieldBridge | null): Promise<boolean> {
  const s = agentStore;
  const rt = agentWebgpuRuntime;
  if (!s || !rt || !rt.ready) return false;
  const cfg = centerBasedConfig;
  const bonding = usesBondingPhysics(cfg);
  const muR = cbNum(cfg, 'repulsionStiffness');
  const muA = cbNum(cfg, 'adhesionStiffness');
  const doCollision = usesSoftCollision(cfg);   // SOFT-sphere repulsion force (positional collision runs a separate projection pass below)
  const range = cbNum(cfg, 'interactionRange');
  const eta = Math.max(1e-6, cbNum(cfg, 'drag'));
  const torus = boundaryTreatment === 'torus';
  const W = s.worldWidth, H = s.worldHeight;
  const growthRate = usesEngineGrowth(cfg) ? Math.max(0, cbNum(cfg, 'growthRate')) : 0;
  const hw = s.highWater;
  const alive = s.alive, rad = s.radius;
  const momentum = Math.max(0, Math.min(0.999, cbNum(cfg, 'momentum')));
  const maxSpeed = Math.max(0, cbNum(cfg, 'maxSpeed'));
  const dt = s.dt;

  // Reset the per-step force accumulator (Apply Force adds into it on the GPU).
  // forceZ too: a JS fallback step (startup while the runtime builds, hash
  // overflow) leaves the last JS behaviour's z-force in the CPU store, and
  // uploadAgentSoA re-uploads it as the accumulator seed every GPU step ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â a
  // permanent phantom z-force in 3D without this reset.
  s.forceX.fill(0, 0, hw); s.forceY.fill(0, 0, hw); s.forceZ.fill(0, 0, hw);

  // Build the uniform spatial hash CPU-side (same as the JS path) ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the GPU
  // behaviour + force passes query it (2D and 3D; the shaders carry the Z dims).
  let maxR = cbNum(cfg, 'defaultRadius');
  for (let i = 0; i < hw; i++) { if (alive[i] && rad[i]! > maxR) maxR = rad[i]!; }
  const binEdge = Math.max(range * 2 * maxR, cbNum(cfg, 'neighbourQueryRadius'));
  const hash = buildSpatialHash(s, Math.max(1e-3, binEdge), W, H, s.worldDepth, boundaryTreatment === 'torus', agentHashReserve);
  currentAgentHash = hash;

  // Prime the sync attr write buffer (no-op in async agent mode). Keeps the CPU
  // attr-buffer invariant the structural phase / snapshot read.
  primeAgentAttrWrite(s);

  // Upload the hash + the SoA; bail (ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ JS) if the hash overflows the GPU reserve.
  const hashFits = uploadAgentHash(rt, hash);
  const hashValid = hashFits && hash ? 1 : 0;
  if (hash && !hashFits) {
    if (!agentWebgpuHashOverflowWarned) {
      agentWebgpuHashOverflowWarned = true;
      self.postMessage({ type: 'error', message: `[agents] spatial hash (${hash.nBinsX * hash.nBinsY * hash.nBinsZ} bins) exceeds the WebGPU reserve (${rt.layout.maxHashBins}); this step runs on JS.` });
    }
    return false;
  }
  uploadAgentSoA(rt, s);
  // Universal-node uploads (Generic Agent Platform) ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â present only when the layout
  // reserved their region (a no-extra Boids model uploads none).
  if (rt.layout.auxF32Len > 0) {
    const tables: Record<string, ArrayLike<number>> = {};
    for (const id of rt.layout.lookupTableIds) {
      const t = cachedInteractionTables[id];
      if (t) tables[id] = t;
    }
    uploadAgentAux(rt, cachedModelAttrs as Record<string, number>, tables);
  }
  if (rt.layout.indicatorCount > 0) {
    uploadAgentIndicators(rt, cachedIndicators, agentWebgpuIndicatorIsInt());
  }
  if (rt.layout.bondStoreLen > 0) uploadAgentBondStore(rt, s);
  // The agent world IS the grid coordinate frame 1:1, so fieldW/fieldH double as
  // BOTH the world bounds (getNearbyAgents / getAgentOffset torus wrap) AND the
  // field grid dims (the field index = rowÃƒâ€šÃ‚Â·fieldW + col). W===width, H===height.
  uploadAgentControl(rt, {
    highWater: hw, hashValid, nBinsX: hash ? hash.nBinsX : 0, nBinsY: hash ? hash.nBinsY : 0,
    fieldTorus: torus ? 1 : 0,
    binSizeX: hash ? hash.binSizeX : 1, binSizeY: hash ? hash.binSizeY : 1,
    fieldW: W, fieldH: H,
    nBinsZ: hash ? hash.nBinsZ : 1, binSizeZ: hash ? hash.binSizeZ : 1, fieldD: s.worldDepth,
    originX: hash ? hash.originX : 0, originY: hash ? hash.originY : 0, originZ: hash ? hash.originZ : 0,
  });
  uploadAgentForceControl(rt, hw, {
    hashValid, nBinsX: hash ? hash.nBinsX : 0, nBinsY: hash ? hash.nBinsY : 0,
    binSizeX: hash ? hash.binSizeX : 1, binSizeY: hash ? hash.binSizeY : 1,
    dtOverEta: dt / eta, muR, muA, range, momentum, maxSpeed, growthRate,
    fieldW: W, fieldH: H, bonding: bonding ? 1 : 0, doCollision: doCollision ? 1 : 0, doDensity: agentUsesDensity ? 1 : 0, torus: torus ? 1 : 0,
    nBinsZ: hash ? hash.nBinsZ : 1, binSizeZ: hash ? hash.binSizeZ : 1, fieldD: s.worldDepth,
    originX: hash ? hash.originX : 0, originY: hash ? hash.originY : 0, originZ: hash ? hash.originZ : 0,
  });

  // G5 field bridge ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â upload the cell field snapshot + prime the atomic deposit
  // accumulator, run the GPU behaviour (which samples fieldRead + atomic-deposits
  // into fieldDeposit), then read the deposit back into the cell READ buffer
  // (readAttrs[id]) BEFORE the cell CA step incorporates it (Decision D-FIELD).
  // `fieldSpecs` is the agent-readable set; the readWrite subset is deposited.
  const hasFieldBridge = rt.layout.fieldReadLen > 0 || rt.layout.fieldWriteLen > 0;
  if (hasFieldBridge) {
    if (gpuFieldBridge) {
      // E1b — GPU-side prime: copy the grid's attrsRead buffer into fieldRead +
      // fieldDeposit (no CPU round-trip). Float-field WebGPU-grid models only.
      primeAgentFieldFromGrid(rt, gpuFieldBridge.gridAttrsReadBuf, gpuFieldBridge.gridByteOffset, rt.layout.fieldTotal);
    } else {
      const readArrays: Record<string, FieldArray> = {};
      const writeArrays: Record<string, FieldArray> = {};
      for (const spec of fieldSpecs) {
        const arr = readAttrs[spec.id] as unknown as FieldArray | undefined;
        if (!arr) continue;
        readArrays[spec.id] = arr;
        if (spec.agentAccess === 'readWrite') writeArrays[spec.id] = arr;
      }
      uploadAgentField(rt, readArrays, writeArrays);
    }
  }

  // Dispatch behaviour ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ force, then commit. `readbackAgentStep` reads the GPU's
  // post-step user-agent-attribute runs back into `s.attrWrite` (the "next" buffer),
  // so the swap MUST follow it (sync mode: read previous / write next, then swap;
  // no-op in async where attrWrite aliases attrRead). It ALSO reads back the
  // structural-request runs (divide/bond/kill) into the engine's CPU arrays so the
  // structural phase below applies them, and the packed colours into `s.colors`.
  try {
    // Unified spawning: seed the atomic spawn cursor to the pre-step highWater so
    // createAgent bump-allocates newborns beyond the live range (the GPU analogue
    // of the grow-only `_agentCreate`). readbackAgentStep reconciles them below.
    if (rt.usesSpawn) uploadAgentSpawnCursor(rt, hw);
    if (rt.usesStop) resetAgentStopFlag(rt);   // fresh first-match each step
    // Error scope around the dispatch: a validation failure would otherwise be
    // SILENT (dropped work + a readback of unchanged state = frozen dynamics).
    rt.device.pushErrorScope('validation');
    dispatchAgentStep(rt, hw);
    const dispatchErr = await rt.device.popErrorScope();
    if (dispatchErr) {
      self.postMessage({ type: 'error', message: '[agents][gpu] dispatch validation error: ' + dispatchErr.message });
    }
    const rb = await readbackAgentStep(rt, s);   // x/y (from xNext/yNext) + vx/vy/radius/density/age + attrsÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢attrWrite + requests + colours + spawn reconcile + stop
    if (rb.spawnOverflow) self.postMessage({ type: 'agentOverflow', message: `Agent capacity reached during a Behaviour spawn (maxAgents=${s.maxAgents}). Some Create Agent calls were skipped.` });
    // Merge the GPU Stop Event into the shared stopFlag (first-match); drainAgentStop
    // in the batch loop reads stopFlag[0] BEFORE the cell step resets it.
    if (rb.agentStop !== 0 && (stopFlag[0] ?? 0) === 0) stopFlag[0] = rb.agentStop;
    swapAgentAttrs(s);
    if (rt.layout.indicatorCount > 0) {
      // The behaviour shader mutated the indicators atomic buffer (Set/Update
      // Indicator) ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â read them back into cachedIndicators so the sendColors path
      // ships the new values (the agent indicators ride the same buffer the cell
      // step uses; here the GPU owns them for the agent step).
      await readbackAgentIndicators(rt, cachedIndicators, agentWebgpuIndicatorIsInt());
    }
    if (hasFieldBridge && rt.layout.fieldWriteLen > 0 && gpuFieldBridge) {
      // E1b GPU-side fold: copy the deposit accumulator back into the grid's
      // attrsRead buffer (the deposit words ARE the final f32 field). The grid step
      // (runStepWebGPU, run by the batch loop) reads attrsRead, so its copy line
      // carries the deposit into the next gen. readAttrs (CPU) stays stale; getState
      // pulls it via ensureCpuAttrsFresh (gpuOwnsAttrs stays true).
      foldAgentFieldToGrid(rt, gpuFieldBridge.gridAttrsReadBuf, gpuFieldBridge.gridByteOffset, rt.layout.fieldTotal);
    } else if (hasFieldBridge && rt.layout.fieldWriteLen > 0) {
      // CPU field bridge (JS/WASM grid, or a non-float field): the deposit accumulator holds the evolved field ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ copy into readAttrs so
      // the cell step (runStep) reads it (its w.set(r) carries it; diffusion spreads).
      const writeArrays: Record<string, FieldArray & { [i: number]: number }> = {};
      for (const spec of fieldSpecs) {
        if (spec.agentAccess !== 'readWrite') continue;
        const arr = readAttrs[spec.id] as unknown as (FieldArray & { [i: number]: number }) | undefined;
        if (arr) writeArrays[spec.id] = arr;
      }
      await readbackAgentField(rt, writeArrays);
    }
  } catch (e) {
    // A concurrent reinit (initAgents / rebuild / recompile processed during one of
    // the awaited readbacks) may have destroyed THIS runtime's buffers while our
    // mapAsync was still pending ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ "Buffer was destroyed before mapping was
    // resolved". That is EXPECTED during live editing, not a real GPU failure: fall
    // back to JS for this step SILENTLY and leave the (possibly already-rebuilt)
    // runtime alone. We detect it by the runtime reference no longer being current
    // ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â which also fixes a latent bug where the old catch would destroy a FRESH
    // runtime a reinit had just installed. Only a genuine failure of the runtime we
    // actually ran on surfaces an error + tears it down.
    if (agentWebgpuRuntime === rt) {
      self.postMessage({ type: 'error', message: '[agents] WebGPU step failed, falling back to JS: ' + ((e as Error)?.message || e) });
      destroyAgentWebGPURuntime(agentWebgpuRuntime); agentWebgpuRuntime = null;
      agentRenderActive = false; agentStoreStale = false; agentCompositeActive = false;   // A1: runtime gone → render off
    }
    return false;
  }

  // HARD positional collision ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â a CPU post-step constraint on the just-read-back
  // positions, exactly like the structural phase below (both target-independent
  // CPU/JS, run on the settled state after the GPU force pass). No GPU shader +
  // no extra readback: `readbackAgentStep` already committed x/y[/z] to the CPU
  // store, so the projection runs here and the NEXT step's uploadAgentSoA sends
  // the non-overlapping positions back to the GPU. (WebGPU's f32 force pass ÃƒÂ¢Ã¢â‚¬Â¡Ã¢â‚¬â„¢ the
  // read-back positions are f32-precision, so this is statistical parity vs the
  // f64 JS/WASM targets ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the documented WebGPU-agent stance, no worse than the
  // structural phase which is likewise CPU here.)
  if (usesPositionalCollision(cfg)) {
    const iters = Math.max(1, Math.floor(cbNum(cfg, 'positionalIterations')));
    const is3dW = s.worldDepth > 1;
    resolvePositionalCollisions(s, iters, binEdge, agentHashReserve, W, H, s.worldDepth, is3dW, boundaryTreatment === 'torus');
  }

  // The structural phase runs CPU-side on the settled state (G4). It reads the
  // request arrays `readbackAgentStep` just filled from the GPU: division splits
  // flagged agents along their tension axis (the eigensolve stays CPU on every
  // target), bonds form/break, killed agents recycle, and the divisionEvent fn
  // (also CPU/JS) reassigns daughters. A no-op for Boids (no structural requests).
  runAgentStructuralPhase();
  return true;
}

/** Post-step structural phase ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the only place the bond / agent topology is
 *  mutated (Decision: mutate on the settled state, never mid-force-loop). Bond
 *  form/break requests (FormBond / BreakBond) ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ auto-bond by distance (with
 *  hysteresis) ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ stale-bond sweep ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ [division + death land in Phase C]. */
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

  // 1b. Death ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â recycle killed agents (breaks all bonds + bumps the epoch).
  for (let i = 0; i < hw; i++) {
    if (alive[i] && s.killRequest[i]) freeAgentSlot(s, i);
  }

  // 1c. Division ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â split flagged agents along their tension axis. Iterate only
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
    // z component of the requested axis (0 in 2D ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â divideAxisZ is 2D-ZERO).
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
  //    unbonded agents within formDistanceÃƒÆ’Ã¢â‚¬â€contact; break bonds stretched past
  //    breakDistanceÃƒÆ’Ã¢â‚¬â€contact. Uses the spatial hash ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ O(N). Gated on the
  //    Bonds=Physics capability (usesEngineSprings ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â auto-bond forms SPRING bonds,
  //    so it rides the same gate as the springs it creates; consistent with the
  //    closure's `autoBond ÃƒÂ¢Ã¢â‚¬Â¡Ã¢â‚¬â„¢ bonds='physics'`), its own autoBond flag, AND a
  //    non-empty bond store (STEP 3 capability-gate: Bonds=off ÃƒÂ¢Ã¢â‚¬Â¡Ã¢â‚¬â„¢ s.maxBonds=0, so
  //    the scan is skipped entirely rather than scanning + rejecting at the
  //    capacity check ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the same result, no bonds, minus the wasted O(N) work).
  if (s.maxBonds > 0 && usesEngineSprings(cfg) && cfg?.autoBond) {
    const fMul = cbNum(cfg, 'formDistance');
    const bMul = cbNum(cfg, 'breakDistance');
    // form pass ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â scan candidate pairs via the hash
    const z = s.z, halfD = D / 2;
    let maxR = cbNum(cfg, 'defaultRadius');
    for (let i = 0; i < hw; i++) { if (alive[i] && rad[i]! > maxR) maxR = rad[i]!; }
    const hash = buildSpatialHash(s, Math.max(1e-3, bMul * 2 * maxR), W, H, D, boundaryTreatment === 'torus', agentHashReserve);
    // buildSpatialHash reuses the per-store scratch arrays, so this rebuild (at a
    // DIFFERENT bin edge) just corrupted `currentAgentHash`'s contents while its
    // dims still describe the step hash ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â invalidate so a later colour pass
    // (Get Nearby Agents in an agent OM graph) falls back to all-pairs instead
    // of querying a dims/content-mismatched hash.
    currentAgentHash = null;
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
      const { nBinsX, nBinsY, nBinsZ, binStart, binAgents, binSizeX, binSizeY, binSizeZ, originX, originY, originZ } = hash;
      if (nBinsZ > 1) {
        // 3D form pass ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â 3ÃƒÆ’Ã¢â‚¬â€3ÃƒÆ’Ã¢â‚¬â€3 stencil over the z-major hash, torus-wrapped.
        for (let i = 0; i < hw; i++) {
          if (!alive[i]) continue;
          let bx = ((x[i]! - originX) / binSizeX) | 0; if (bx < 0) bx = 0; else if (bx >= nBinsX) bx = nBinsX - 1;
          let by = ((y[i]! - originY) / binSizeY) | 0; if (by < 0) by = 0; else if (by >= nBinsY) by = nBinsY - 1;
          let bz = ((z[i]! - originZ) / binSizeZ) | 0; if (bz < 0) bz = 0; else if (bz >= nBinsZ) bz = nBinsZ - 1;
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
          let bx = ((x[i]! - originX) / binSizeX) | 0; if (bx < 0) bx = 0; else if (bx >= nBinsX) bx = nBinsX - 1;
          let by = ((y[i]! - originY) / binSizeY) | 0; if (by < 0) by = 0; else if (by >= nBinsY) by = nBinsY - 1;
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
    // break pass ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â drop bonds stretched past breakDistanceÃƒÆ’Ã¢â‚¬â€contact
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
// the model has no setCellGlyph node ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â keeps the function arity stable
// without paying for a per-cell buffer. The compiled code never reads these
// because no setCellGlyph emit landed in the function body.
const GLYPH_NOOP_CODES: Uint32Array = new Uint32Array(0);
const GLYPH_NOOP_COLORS: Uint32Array = new Uint32Array(0);

// Inspect-cell subscriptions ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â flat cell indices the main thread is watching
// via the Shift+LMB popup. Worker emits `inspectCellsData` after every step
// (piggy-backed onto sendColors) and immediately when the set is updated.
// Cost when empty: a single empty-array length check per step. Cost when
// non-empty: one read ÃƒÆ’Ã¢â‚¬â€ cellAttrs.length per subscribed cell per step.
let inspectCellIdxs: number[] = [];

// WASM linear memory backs cell attributes and the color buffer so the future
// WASM step function can address them directly. JS still uses typed-array views
// over the same memory for paint, save/load, the legacy JS step, etc. ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the
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
 *  Reset (NOT on Load State), after default values are
 *  applied and before the first color pass. */
let initFn: Function | null = null;
/** Optional GLOBAL Grid Init Event function compiled from the Grid Init Event
 *  node. Null when the graph contains no Grid Init Event. Runs ONCE (not per
 *  cell) on Reset + first load, after defaults + the per-cell Init Event and
 *  before the first colour pass. Executed on every compile target (it writes the
 *  CPU/wasm attribute buffers; the worker then syncs / uploads). See runGridInit. */
let gridInitFn: Function | null = null;

/** Per-table Float64Array of length `rowCount * colCount` (row-major). Keyed by
 *  attribute id. Rebuilt on init / recompile / updateLookupTable. */
let cachedInteractionTables: Record<string, Float64Array> = {};
/** The current Lookup Table payloads (id + resolved row/col labels + values),
 *  stashed before initGrid so the layout can size each table region. */
let lookupTablesPayload: InteractionTablePayload[] = [];
/** True when the model has any Lookup Table model attr ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â gates emission of the
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
/** Flat `[speciesIdx * 8 + faceIdx ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ labelIdx]` (0 = "none"). Built once by
 *  `buildFacePatternLookup` from the variegation source attribute's
 *  facePatternAssignments. */
let facePatternLookup: Int32Array | null = null;

/** Build the facePatternLookup table + populate cached interaction tables
 *  for the current model. Phase 8: orientation arrays and the lookup +
 *  interaction tables are stored as typed-array VIEWS over `wasmMemory` (see
 *  initGrid for the orientation views; this function fills the lookup +
 *  table regions). Per the typed-array-view discipline in CLAUDE.md, future
 *  live updates (e.g. updateInteractionTable) MUST copy into these views,
 *  never reassign the JS reference ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â WASM reads via baked offsets, not the
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

  // facePatternLookup region (variegation only) ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â view over wasmMemory at the
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

  // Lookup tables ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â one Float64Array view per table at the per-attr offset
  // reserved by computeMemoryLayout. INDEPENDENT of variegation (tagÃƒÆ’Ã¢â‚¬â€tag tables
  // need no faces). `set()` the normalised values in; updateLookupTable later
  // writes through the same view (never reassign ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â WASM reads via baked offset).
  if (wasmMemory && wasmLayout) {
    for (const t of lookupTablesPayload) {
      const slot = wasmLayout.interactionTableOffsets[t.id];
      const normalized = normalizeLookupTablePayload(t);
      if (slot !== undefined) {
        // Multi-axis slots reserve Π dims cells; legacy rowCount*colCount.
        const cells = slot.dims && slot.dims.length > 0
          ? slot.dims.reduce((a, b) => a * Math.max(1, b), 1)
          : slot.rowCount * slot.colCount;
        const view = new Float64Array(wasmMemory.buffer, slot.offset, cells);
        view.fill(0);
        // Defensive length clamp — a stale payload whose dims disagree with the
        // layout must not throw (the next recompile re-ships both in lockstep).
        view.set(normalized.length <= cells ? normalized : normalized.subarray(0, cells));
        cachedInteractionTables[t.id] = view;
      } else {
        // No layout slot (table attr added after init without recompile) ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â keep
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
    // copy cost ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â tables are small ((labels+1)Ãƒâ€šÃ‚Â² entries).
    uploadInteractionTable(rt, id, view);
  }
}

// WASM step (Wave 2) ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â when useWasm is true, runStep() calls this instead of
// the JS stepFn. Default false; flipped via the 'setUseWasm' message. The WASM
// module is rebuilt on every init/recompile because it imports the linear
// memory and assumes the current attribute layout.
let wasmStepFn: ((total: number) => void) | null = null;
// Per-mapping WASM exports. Keys are SANITISED mapping ids (matching the
// `inputColor_<id>` / `outputMapping_<id>` export names the compiler emits).
let wasmInputColorFns: Record<string, (idx: number, r: number, g: number, b: number) => void> = {};
let wasmOutputMappingFns: Record<string, (total: number) => void> = {};
/** Variegated Cells: WASM Init Event entry point. Same signature as `step`
 *  ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â single `total` param, walks every cell sequentially. Called by `runInit`
 *  on Reset when the model has an Init Event node + WASM target. */
let wasmInitFn: ((total: number) => void) | null = null;
let useWasm = false;

// Wave 3: WebGPU runtime. `useWebGPU` is the user's intent; `webgpuRuntime` is
// the actual handle (null until async init succeeds, or null after a failure).
// `runStep()` only routes to the WebGPU path when both useWebGPU is true AND
// `webgpuRuntime.stepReady` is true ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â step 1 leaves stepReady false so the
// step still runs on JS/WASM even when the user has WebGPU selected. This
// validates the entire control plane without needing buffer/pipeline machinery.
let useWebGPU = false;
// GIF recording toggle. When true and direct render is active, sendColors
// includes the colors buffer (extra readback per frame) so main thread can
// capture frames. Otherwise direct render skips the colors transfer.
let recording = false;
let webgpuRuntime: WebGPURuntime | null = null;
// Monotonic counter ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â bumped at the start of every startWebGPUInit. The
// async init's `.then` captures the value at submit time and bails if it no
// longer matches (a newer init landed, OR the worker is being torn down).
// Without this, an old in-flight init can race the new one and clobber
// `webgpuRuntime` with a now-orphaned runtime ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â racy and hard to repro.
let webgpuInitSeq = 0;
// Set true in every startWebGPUInit failure branch, cleared when a fresh init
// begins or the runtime is created. Only consulted when `nbrTableDropped` is
// true: it lets the runStep CPU guard distinguish a transient init window (the
// runtime is still coming up — no error, steps no-op until ready) from a genuine
// WebGPU failure (surface a clear one-time error, since a dropped-table model
// genuinely cannot fall back to the JS/WASM step).
let webgpuGridFailed = false;
// One-shot latch so the "dropped-table WebGPU model can't run on CPU" error is
// posted at most once (from runStep on failure, or from a recompile that adds a
// neighbour read to a CPU function while the table is already dropped).
let nbrTableDroppedErrorPosted = false;

/** Does a compiled CPU function's SOURCE actually INDEX a neighbour table
 *  (`nIdx_<nbr>[...]`)? The compiled param declaration is `nIdx_<nbr>,` (a bare
 *  identifier followed by a comma), so `nIdx_<id>` immediately followed by `[`
 *  appears only at a genuine read site — never in the param list. Used by the
 *  `init`/`recompile` handlers to decide whether the WebGPU target can drop the
 *  full CPU neighbour table (kept whenever a CPU init/gridInit/OM/inputColor
 *  function reads neighbours). MUST stay in sync with the emitter's `nIdx_`
 *  naming (compile.ts buildLoopParams / buildCellParams / omParamParts). */
function codeIndexesNeighbourTable(code: string | undefined): boolean {
  return !!code && /nIdx_\w*\[/.test(code);
}

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
  // A fresh attempt clears any prior failure latch (see webgpuGridFailed).
  webgpuGridFailed = false;
  if (shaderError) {
    destroyWebGPURuntime(webgpuRuntime);
    webgpuRuntime = null;
    webgpuGridFailed = true;
    self.postMessage({ type: 'error', message: '[webgpu] compile failed: ' + shaderError });
    return;
  }
  if (!shaderCode || !entryPoints || !layout) {
    destroyWebGPURuntime(webgpuRuntime);
    webgpuRuntime = null;
    webgpuGridFailed = true;
    return;
  }
  // Pipeline cache: when the new shader is byte-identical to the running one,
  // the layout is identical too (the layout values are baked into the shader
  // source). We can keep the device + buffers + pipelines and skip the
  // expensive async device + shaderModule + pipeline rebuild ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â saves hundreds
  // of ms on graph-only edits where the user isn't actually changing the rule.
  if (shaderCode && webgpuRuntime?.stepReady && shaderHashOf(shaderCode) === webgpuRuntime.shaderHash) {
    self.postMessage({ type: 'useWebGPUStatus', enabled: useWebGPU, ready: true, directRender: webgpuRuntime.directRender, voxelRender: webgpuRuntime.voxelRender });
    return;
  }
  // P7 ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â salvage any direct-render canvas attached to the previous runtime.
  // The OffscreenCanvas is tied to the worker's lifetime (not to a specific
  // device); reusing it after recompile keeps direct render alive instead of
  // falling back to readback-based rendering on every graph edit.
  const salvagedCanvas = canvas ?? webgpuRuntime?.canvas ?? undefined;
  // Tear down any previous runtime ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â rebuilt against the new shader/layout.
  destroyWebGPURuntime(webgpuRuntime);
  webgpuRuntime = null;
  if (!isWebGPUAvailable()) {
    webgpuGridFailed = true;
    self.postMessage({ type: 'error', message: '[webgpu] navigator.gpu unavailable in this worker context' });
    return;
  }
  // The promise is intentionally not awaited here ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â init runs in the background
  // and runStep() falls through to JS/WASM until `webgpuRuntime.stepReady` is
  // true. Step 7 (Save/Load State) introduces the await path.
  void createWebGPURuntime({ shaderCode, entryPoints, layout, canvas: salvagedCanvas })
    .then(async rt => {
      // A newer init started while we were awaiting ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the orphaned `rt`
      // belongs to a stale sequence. Destroy it and bail without touching
      // webgpuRuntime, which now holds (or is about to hold) the newer one.
      if (mySeq !== webgpuInitSeq) {
        destroyWebGPURuntime(rt);
        return;
      }
      webgpuRuntime = rt;
      webgpuGridFailed = false;   // runtime created — no longer a failure state
      // Build buffers + pipeline, upload initial CPU state, seed per-cell RNG.
      await setupBuffersAndPipelines(rt);
      // Re-check after the second await ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â same race window.
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
      // O5 ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â set up GPU-side reduction pipelines for any GPU-eligible
      // watched linked indicators. Skipped indicators (float total, integer
      // /float frequency) keep using the existing CPU readback fallback.
      setupReductionPipelines(rt, linkedDefs);
      // Initial indicator values
      const vals: Record<string, number> = {};
      for (const { idx, id } of standaloneIds) vals[id] = cachedIndicators[idx]!;
      uploadIndicators(rt, vals, isIntEncodedIndicator);
      // Run the active viewer's outputMapping + present (single encoder under
      // direct render ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â P6) so the canvas shows the initial state from the
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
      self.postMessage({ type: 'useWebGPUStatus', enabled: useWebGPU, ready: rt.stepReady, directRender: rt.directRender, voxelRender: rt.voxelRender });
    })
    .catch((e: unknown) => {
      // Same staleness check on the failure path ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â don't clobber the newer
      // runtime's state with a stale error message.
      if (mySeq !== webgpuInitSeq) return;
      webgpuRuntime = null;
      webgpuGridFailed = true;
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

// Indicators ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â typed-array-backed so the per-cell hot path uses _indicators[idx]
// (typed-array index access) instead of _indicators["abc"] (object hash lookup).
// The index space is parallel to model.indicators array order; compiler pre-resolves
// each indicator node's _indicatorIdx via the same mapping.
let cachedIndicators: Float64Array = new Float64Array(0);
let standaloneDefaults: Float64Array = new Float64Array(0);
let standalonePerGenIdx: number[] = [];
// (idx, id) pairs for the standalone indicators only ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â used to build the outgoing
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

// Stop-event flag ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â compiled step writes a 1-based index into stopFlag[0] when
// a Stop Event node's flow fires. Worker reads after each step/color/input pass
// and surfaces the matching message from stopMessages. A Uint32Array view over
// the layout.stopFlagOffset so JS and WASM share the same memory cell.
let stopFlag: Uint32Array = new Uint32Array(1);
let stopMessages: string[] = [];

/** Drain the agent Stop Event source(s) after an agent step ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the 1-based stop
 *  index (0 = none). Called in the batch loops BETWEEN the agent step and the
 *  cell step: the agent step always runs first, and runStep()/runStepWebGPU()
 *  reset the shared stopFlag at their top (and finalizeStepWebGPU OVERWRITES it
 *  from the GPU), which would otherwise clobber an agent stop. Sources: the JS +
 *  WebGPU agents write the shared stopFlag[0]; the WASM agent writes its own
 *  memory cell at layout.stopFlagOffset. Clears both so the next step is fresh. */
function drainAgentStop(): number {
  if (stopMessages.length === 0) return 0;
  let v = stopFlag[0] ?? 0;      // JS + WebGPU agent source
  stopFlag[0] = 0;
  const s = agentStore;
  if (s && s.wasmBacked && s.memory && s.layout) {   // WASM agent memory cell
    const cell = new Uint32Array(s.memory.buffer, s.layout.stopFlagOffset, 1);
    if (v === 0) v = cell[0]! >>> 0;
    cell[0] = 0;                 // always clear ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the WASM first-match needs a 0 start
  }
  return v;
}
// B4B ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â WebGPU stop-check interval. Default 1 (every step). >1 trades stop-event
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
  total = width * height * depth;   // 3D Grid CA: depth===1 ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ W*H (2D byte-identical)
  attrsA = {};
  attrsB = {};
  const isAsync = updateMode === 'asynchronous';

  // Allocate WASM linear memory and create typed-array views over EVERY region
  // the WASM step might address: cell attrs, color buffer, neighbor index
  // tables, model attrs, indicators, RNG state, active viewer ID, and async
  // order array. JS-side variables (attrsA/B, nbrIndices, orderArray, etc.)
  // become typed-array views over wasmMemory at the layout offsets ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â single
  // source of truth shared between JS step and WASM step.
  //
  // Variegated Cells: when the feature is enabled (`variegated` was set by the
  // init/recompile handler BEFORE calling initGrid), the layout also reserves
  // orientation read/write regions, the facePatternLookup region, and a
  // contiguous f64 region per interactionTable model attribute. Sized from the
  // source attribute's tagOptions count + the face-label palette length so the
  // regions are stable across live edits to the values themselves.
  let variegatedInputs: VariegatedLayoutInputs | undefined;
  if (variegated && gridCellsEnabled) {
    // Variegation is a cell-grid feature ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â with the grid off its per-cell
    // orientation buffers would be dead weight at agent-world scales.
    const source = cellAttrs.find(a => a.id === variegated!.sourceAttributeId);
    variegatedInputs = { speciesCount: source?.tagOptions?.length ?? 0 };
  }
  // Lookup tables ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â sized from each table's resolved row/col label counts
  // (carried in the payload, stashed before initGrid). Independent of variegation.
  // A MULTI-AXIS (N-D) table ships `dims` (its rowLabels/colLabels are empty),
  // so it must be sized by Π dims — matching computeLayoutFromModel on the
  // SimulatorView side, or the region collapses to 1 cell (truncating the table
  // AND desyncing every offset baked into the WASM module).
  const lookupTables: LookupTableLayoutInput[] = lookupTablesPayload.map(t =>
    t.dims && t.dims.length > 0
      ? { id: t.id, rowCount: t.dims[0] ?? 1, colCount: t.dims[1] ?? 1, dims: t.dims, mins: t.mins }
      : { id: t.id, rowCount: t.rowLabels.length || 1, colCount: t.colLabels.length || 1 },
  );
  // Agents-only (CA Grid off): reserve NO neighbour-index tables ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â nothing
  // queries them (buildNeighborIndices + the cell step are skipped), and at
  // agent-world scales they dominate the layout catastrophically: a 600ÃƒÆ’Ã¢â‚¬â€600ÃƒÆ’Ã¢â‚¬â€400
  // world with a Moore-3D neighbourhood would reserve totalÃƒÆ’Ã¢â‚¬â€26ÃƒÆ’Ã¢â‚¬â€4 ÃƒÂ¢Ã¢â‚¬Â°Ã‹â€  15 GB and
  // blow the wasm32 4 GiB Memory limit ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the "resize never completes" hang.
  // WebGPU grid target (nbrTableDropped, decided in the init handler): the GPU
  // computes neighbours inline from the compact nbrOffsets buffer, so the FULL
  // per-cell table (total * nSz * 4 — the SAME 2.8 GB hog at 300 cubed) is dead
  // weight when no CPU init/gridInit/OM/inputColor function indexes it. Reserve
  // nothing here too; buildNeighborIndices fills only the constant-boundary
  // sentinel. This lifts the WebGPU-target grid ceiling from ~320 cubed to well
  // past 700 cubed on the same 4 GiB backing store.
  const layoutNeighborhoods = (gridCellsEnabled && !nbrTableDropped) ? neighborhoods : [];
  wasmLayout = computeMemoryLayout(
    cellAttrs, modelAttrsList, layoutNeighborhoods, indicatorsList,
    total, isAsync, boundaryTreatment,
    variegatedInputs,
    hasGlyphs,
    lookupTables,
    gridCellsEnabled,   // grid off ÃƒÂ¢Ã¢â‚¬Â¡Ã¢â‚¬â„¢ no colors/glyphs/order/skipped/attr-write regions
    // "Skip Isolated Empty Cells": MUST equal the compile side's
    // sparseSteppingEnabled(model) (enabled + sync + gridCells + no glyphs) or
    // the baked activeListOffset desyncs — layout-lockstep. sieConfig + hasGlyphs
    // are set from the init message BEFORE initGrid runs.
    !!sieConfig?.enabled && !isAsync && gridCellsEnabled && !agentsEnabled && !hasGlyphs,
    // WebGPU grid target (attrWriteAliased, decided in the init handler): the STEP
    // runs on the GPU, so reserve NO separate sync attr WRITE buffer — the write
    // side aliases the read side (the view loop below does the same aliasing).
    // Frees the ~9 B/cell double-buffer that keeps 600³ over the 4 GiB cap.
    attrWriteAliased,
  );
  wasmMemory = new WebAssembly.Memory({ initial: wasmLayout.pages });
  const buf = wasmMemory.buffer;
  colorsDirty = gridCellsEnabled;   // fresh grid ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ ship colours on the next sendColors (never when the grid is off)

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

    // Async OR the WebGPU grid target (attrWriteAliased): single buffer — read
    // and write share one view (the layout reserved no separate write region, so
    // attrWriteOffset[id] === attrReadOffset[id]). On WebGPU the sync STEP — the
    // one reader that needs a distinct write buffer — runs on the GPU; init /
    // gridInit / paint write final values, correct with write===read.
    if (isAsync || attrWriteAliased) {
      // Async: single buffer ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â both read and write point to the same view (same offset)
      attrsB[attr.id] = arrA;
    } else {
      const arrB = viewOver(attr.type, buf, wasmLayout.attrWriteOffset[attr.id]!, viewLen);
      if (dv !== 0) arrB.fill(dv);
      attrsB[attr.id] = arrB;
    }
  }

  readAttrs = attrsA;
  writeAttrs = (isAsync || attrWriteAliased) ? attrsA : attrsB;
  colors = new Uint8ClampedArray(buf, wasmLayout.colorsOffset, wasmLayout.colorsBytes);
  // Glyph buffer views ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â only when the layout reserved regions (i.e. the
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

  // Variegated Cells ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â orientation views over wasmMemory. Same sentinel-aware
  // length as cell attrs. Sentinel cell at index `total` stays at 0 per spec
  // Ãƒâ€šÃ‚Â§6.3 (orientation boundary value is fixed at 0). In async mode the write
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

  // Stop-event flag view ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â shared between JS step (writes via `_stopFlag[0]=idx`)
  // and WASM step (i32.store at stopFlagOffset). Reset to 0 on init.
  stopFlag = new Uint32Array(buf, wasmLayout.stopFlagOffset, 1);
  stopFlag[0] = 0;

  // Order array ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â view over memory in BOTH modes (offset is reserved either way).
  // Async mode populates it (sequential then maybe shuffled); sync mode leaves it 0.
  // Grid off ÃƒÂ¢Ã¢â‚¬Â¡Ã¢â‚¬â„¢ the regions are 0-sized (no async cell loop) ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â a total-length view
  // over them would throw RangeError.
  if (isAsync && gridCellsEnabled) {
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

/** Constant boundary: write each attr's boundary value (falls back to default
 *  when unset) into the sentinel cell at index `total`. The +1 slot was already
 *  allocated in initGrid (see viewLen); set it in place (replacing the array
 *  would orphan the WASM module's view). Neighbour lookups for OOB positions
 *  read it — including WebGPU's inline WGSL, which reads the sentinel from the
 *  uploaded attrs. Shared by every buildNeighborIndices branch (full, compact,
 *  and the WebGPU dropped-table path). No-op for torus. */
function fillBoundarySentinel(): void {
  if (boundaryTreatment === 'torus') return;
  for (const attr of cellAttrs) {
    const bv = boundaryCellValue(attr);
    attrsA[attr.id]![total] = bv;
    if (attrsB[attr.id] !== attrsA[attr.id]) attrsB[attr.id]![total] = bv;
  }
}

function buildNeighborIndices(): void {
  nbrIndices = {};
  if (!wasmMemory || !wasmLayout) return;
  // WebGPU grid target with the FULL CPU table dropped for memory: the GPU
  // computes neighbours inline; no CPU fn indexes the table on this model. There
  // is nothing to build — just fill the constant-boundary sentinel (uploaded to
  // the GPU with the attrs) and return. nbrIndices stays {} so buildLoopArgs
  // pushes the `undefined` table arg, which the (guaranteed-non-indexing) CPU
  // init/gridInit/OM/inputColor functions never read.
  if (nbrTableDropped) { fillBoundarySentinel(); return; }
  const buf = wasmMemory.buffer;
  // "Skip Isolated Empty Cells" (inline-neighbour mode): the layout reserved
  // COMPACT per-neighbourhood tables — `size` PACKED NIs (packNI/packNI3), not
  // `total × size` per-cell indices. Fill them once; the JS emit decodes each
  // slot inline via the NI codec and the WASM emit via pushNiCellIdx — the
  // exact torus-wrap / constant-sentinel math the big loops below bake in.
  // This is what makes 300³ loadable: the big table was total×nSz×4 ≈ 2.8 GB.
  if (wasmLayout.sparseStepping) {
    const is3dGrid = depth > 1;
    for (const nbr of neighborhoods) {
      const coords3d = nbr.coords3d;
      const nbrSize = coords3d ? coords3d.length : nbr.coords.length;
      const packed = new Int32Array(buf, wasmLayout.nbrIndexOffset[nbr.id]!, nbrSize);
      for (let n = 0; n < nbrSize; n++) {
        const c = coords3d ? coords3d[n]! : nbr.coords[n]!;
        const dr = c[0]!, dc = c[1]!, dl = (c as number[])[2] ?? 0;
        packed[n] = is3dGrid ? packNI3(dr, dc, dl) : packNI(dr, dc);
      }
      nbrIndices[nbr.id] = packed;
    }
    fillBoundarySentinel();
    return;
  }
  for (const nbr of neighborhoods) {
    // 3D Grid CA: the offset table gains a `layer` dimension and reads 3-tuple
    // offsets when present. The STRIDE stays `coords.length` (=== coords3d.length
    // for a 3D nbr) so every downstream `nIdx_<nbr>[idx*nSz+k]` consumer is
    // byte-compatible and 3D-for-free. In 2D (depth===1, no coords3d) the inner
    // arithmetic reduces to the historical `row*width+col` form.
    const coords3d = nbr.coords3d;
    const nbrSize = coords3d ? coords3d.length : nbr.coords.length;
    // Index table is a view over wasmMemory at the layout offset ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â shared with WASM step.
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

  fillBoundarySentinel();
}


// ---------------------------------------------------------------------------
// Step
// ---------------------------------------------------------------------------

let activeViewer = '';

/** Build args for the loop-wrapped step function (called once per step, not per cell) */
function buildLoopArgs(useActiveList: boolean = true): unknown[] {
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
  // Glyph buffers ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â always present in the param list to keep arity stable;
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
  // "Skip Isolated Empty Cells": the active-cell list + count. Appended LAST,
  // mirroring compile.ts buildLoopParams (gated on the SAME sieParamsPresent =
  // enabled + sync + gridCells). A null list makes the fn run the full loop —
  // used when the config didn't resolve AND for forced-full colour passes
  // (`useActiveList` false: paint / reset / model-attr / viewer events).
  if (sieParamsPresent) {
    const useList = useActiveList && activeSet !== null;
    args.push(useList ? activeSet!.list : null);
    args.push(useList ? activeSet!.count : 0);
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
  // Glyph buffers ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â always present in the param list to keep arity stable;
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
 *  CPU ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ GPU (mutation handlers in step 6) or readback handlers that sync
 *  GPU ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ CPU (step 7 save state, step 14 linked indicators). */
let gpuOwnsAttrs = false;

/** Pull GPU ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ CPU iff the GPU is currently authoritative. Use before any code
 *  path that READS the CPU `readAttrs` mirror for outgoing data (clipboard,
 *  save state, JS-mode color pass, etc) ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â otherwise the read returns stale
 *  pre-evolution data after Play under WebGPU. The `getState` and `paint`
 *  handlers were the only ones that did this manually; this helper makes the
 *  invariant uniform for all readers. */
async function ensureCpuAttrsFresh(): Promise<void> {
  if (!useWebGPU || !webgpuRuntime?.stepReady || !gpuOwnsAttrs) return;
  await readbackAttrs(webgpuRuntime, readAttrs);
  gpuOwnsAttrs = false;
}

// --- L1 worker-side voxel render (3D grids on the WebGPU target) -------------
/** True once the main thread's OffscreenCanvas is wired into the voxel pipelines.
 *  DERIVED from the runtime rather than mirrored in a module flag ON PURPOSE: the
 *  pipelines die with the runtime (destroyWebGPURuntime → destroyVoxelRender), and
 *  a rebuilt runtime starts with `voxelRender === false`, so every teardown /
 *  rebuild path resets this for free — the "a REBUILT runtime must reset its
 *  flags" trap cannot bite. The main thread re-attaches on the next
 *  `useWebGPUStatus` that reports `voxelRender: false`. */
function voxelRenderOn(): boolean { return !!webgpuRuntime?.voxelRender; }
/** While ON the worker reads the colours back each frame and ships them, so gl3d
 *  can render the frame + resolve its pick FBO (interaction / recording / pause).
 *  While OFF the voxel render owns the display and NOTHING crosses the wire.
 *  Default ON so behaviour is unchanged until SimulatorView opts in. */
let gridUiSync = true;
/** The last camera/lighting/clip uniform (re-applied on attach / refocus). */
let gridRenderView: VoxelRenderView | null = null;
/** The last scene-wireframe viz toggles (mirrors gl3d's Viz3D axes/grid/bounds),
 *  re-applied on attach / refocus so a display re-attach keeps the overlays. */
let gridViz3d: { axes: boolean; grid: boolean; bounds: boolean } = { axes: false, grid: false, bounds: false };
/** DEV probe (reported by `__voxelReadback`): how many frames the worker has
 *  presented into the transferred voxel canvas. The regression this guards is
 *  "the display froze because nothing presented" — see voxelDisplayLive(). */
let voxelPresentCount = 0;

/** True when the GPU owns the display and the CPU `colours` mirror is therefore
 *  intentionally NOT refreshed this frame — 2D direct render (the historical
 *  `rt.directRender` term) OR the 3D voxel render in free mode. One predicate so
 *  `finalizeStepWebGPU`'s readback and `sendColors`' ship decision can't drift.
 *  NB the CPU **attrs** mirror keeps its existing, separate one-shot mechanism
 *  (`gpuOwnsAttrs` / `ensureCpuAttrsFresh`) — L1 adds no second staleness flag. */
function gridDisplayOwnedByGpu(): boolean {
  return !!webgpuRuntime?.directRender || (voxelRenderOn() && !gridUiSync);
}

/** True when the worker-presented voxel canvas IS the live display (free mode).
 *  DELIBERATELY NARROWER than gridDisplayOwnedByGpu(): 2D direct render also owns
 *  the display, but its OffscreenCanvas is a PLACEHOLDER the main thread has to
 *  `drawImage` into the visible canvas, so it can only ever refresh as often as
 *  the main thread draws (and the unlimited-gens fast path deliberately doesn't).
 *  The voxel canvas is a real DOM canvas the BROWSER composites, so a worker-side
 *  present alone changes what the user sees — which is why it, and only it, must
 *  keep refreshing even when the main thread asked to skip the colour pass. */
function voxelDisplayLive(): boolean { return voxelRenderOn() && !gridUiSync; }

/** Re-present the voxel frame from the live GPU colours buffer. Called from every
 *  path that refreshes colours (step-batch tail, mutation tails, colour pass,
 *  camera, attach, refresh). No-op unless the voxel render is wired up. */
function presentVoxelsIfActive(): void {
  const rt = webgpuRuntime;
  if (!rt || !rt.voxelRender) return;
  try { presentVoxels(rt); voxelPresentCount++; }
  catch (e) {
    destroyVoxelRender(rt);   // clears rt.voxelRender → voxelRenderOn() goes false
    self.postMessage({ type: 'error', message: '[webgpu] voxel present failed: ' + ((e instanceof Error) ? e.message : String(e)) });
    self.postMessage({ type: 'voxelRenderStatus', active: false });
  }
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

/** `deferIndicatorScan` — set by the step-batch loops: with no 'accumulated'
 *  linked indicator (and no incremental path), the O(total) indicator scan can
 *  run ONCE at the batch tail instead of per generation (per-gen values are
 *  never observed: the stepped message, end conditions, and the Overseer all
 *  read once per batch). runStep marks `indicatorScanPending`; the batch loop
 *  finalizes after the loop (covers early stop-event breaks too). */
function runStep(deferIndicatorScan: boolean = false): void {
  // Agents-only defence: the batch loops already gate on gridCellsEnabled, but
  // mutation-handler tails (`else if (stepFn) runStep()`) can still reach here ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â
  // an empty cell step over a huge agent world would be a multi-second stall.
  if (!gridCellsEnabled) return;
  colorsDirty = true;   // the step (or its colour writes) may rewrite `colors`
  // Wave 3: triple branch ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â WebGPU > WASM > JS. WebGPU only takes the
  // dispatch when the runtime has finished its async buffer + pipeline setup.
  if (useWebGPU && webgpuRuntime?.stepReady) {
    runStepWebGPU();
    return;
  }
  // WebGPU-target model whose FULL neighbour table AND/OR its separate sync attr
  // WRITE buffer were dropped for memory (nbrTableDropped / attrWriteAliased):
  // the JS/WASM step indexes the neighbour table and read-modify-writes across a
  // distinct write buffer, so it CANNOT run on the CPU. Steps advance on the GPU.
  // While the runtime is still initializing this is a transient no-op (steps
  // resume once it's ready); on a genuine WebGPU failure surface a one-time clear
  // error — a dropped-resource model can't fall back to the CPU step (a grid too
  // large for the GPU is too large for JS/WASM anyway).
  if (nbrTableDropped || attrWriteAliased) {
    if (webgpuGridFailed && !nbrTableDroppedErrorPosted) {
      nbrTableDroppedErrorPosted = true;
      self.postMessage({
        type: 'error',
        message: 'This model runs on WebGPU only: a CPU-side buffer was dropped as a memory optimization for large 3D grids (its per-cell neighbour table and/or its sync attribute write buffer) and the WebGPU runtime failed to start. It cannot fall back to the JS/WASM step. Use a WebGPU-capable browser, or reduce the grid size and switch the compile target to WebAssembly.',
      });
    }
    return;
  }
  // If the previous step ran on GPU, attrs on CPU are stale. Pull them back
  // before falling through to a JS/WASM step so we don't run on prev-prev gen.
  // (In practice this only fires when the user toggles target mid-run, which
  // already triggers a full reinit ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â but the guard is cheap and defensive.)
  if (gpuOwnsAttrs && webgpuRuntime?.stepReady) {
    // Synchronous-style fallback: just clear the flag ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â actual readback happens
    // in step 7's getState path. The first JS/WASM step after a target switch
    // may operate on stale data; documented limitation.
    gpuOwnsAttrs = false;
  }
  const fn = (useWasm && wasmStepFn) ? wasmStepFn : stepFn!;
  const callWasm = useWasm && wasmStepFn !== null;
  const isSync = updateMode !== 'asynchronous';

  // Clear the stop-event flag before the step runs ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â otherwise a stop that
  // fired during an internal runStep call (reset/paint visualisation)
  // would persist and falsely pause the user's next Play.
  if (stopFlag) stopFlag[0] = 0;

  // Clear glyph buffers ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â matches runColorPass behaviour. If the model uses
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
  // pointing at attrsB ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â sync the latest data back into attrsA before running.
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
      // Fisher-Yates shuffle ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â every cell updates exactly once in random order
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
    // 'cyclic': orderArray stays as shuffled at init ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â no per-step work

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

  // ONE call per step ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the loop is inside the compiled function.
  // WASM step has a different signature (just `total`) since attrs/colors
  // live in the imported memory and offsets are baked into the module.
  if (callWasm) {
    // "Skip Isolated Empty Cells": a sparse module's step is (total, activeCount)
    // — activeCount >= 0 iterates the active-list region, -1 runs the full loop
    // (mirrors the JS `if (_activeList)`). The list itself is already in wasm
    // memory (ActiveSet.list is a view over layout.activeListOffset).
    if (sieParamsPresent) {
      (fn as (t: number, c: number) => void)(total, activeSet ? activeSet.count : -1);
    } else {
      (fn as (t: number) => void)(total);
    }
  } else {
    fn(...buildLoopArgs());
  }

  // "Skip Isolated Empty Cells": update the active set from this step's
  // empty<->non-empty transitions BEFORE the buffer swap — readAttrs is the
  // pre-step state, writeAttrs the post-step state (on WASM sync too: the
  // pre-step normalization pinned readAttrs=attrsA and WASM wrote attrsB; the
  // w->r bulk copy below hasn't run yet). Only ACTIVE cells were stepped, so
  // only they can transition; a snapshot of the pre-step count means
  // newly-activated cells (appended) are processed NEXT step.
  if (isSync && activeSet && sieParamsPresent) {
    const as = activeSet;
    const rArr = readAttrs[sieEmptyAttrId] as unknown as { [i: number]: number } | undefined;
    const wArr = writeAttrs[sieEmptyAttrId] as unknown as { [i: number]: number } | undefined;
    if (rArr && wArr) {
      const ev = as.emptyVal, n = as.count, list = as.list;
      // Incremental linked indicators: gather each def's r/w views once, then
      // update the aggregates from the SAME O(active) pass (only active cells
      // can change — the sparse invariant that makes this exact).
      const incr = sieIncrementalActive && sieLinkedBaselineValid;
      const incrDefs: Array<{ r: { [i: number]: number }; w: { [i: number]: number }; m: Map<number, number> | null; totalId: string | null }> = [];
      if (incr) {
        for (const def of linkedDefs) {
          const r = readAttrs[def.attrId ?? ''] as unknown as { [i: number]: number } | undefined;
          const wv = writeAttrs[def.attrId ?? ''] as unknown as { [i: number]: number } | undefined;
          if (!r || !wv) { sieLinkedBaselineValid = false; break; }
          incrDefs.push(def.aggregation === 'total'
            ? { r, w: wv, m: null, totalId: def.id }
            : { r, w: wv, m: sieLinkedFreq.get(def.id) ?? null, totalId: null });
        }
      }
      const doIncr = incr && sieLinkedBaselineValid;
      for (let i = 0; i < n; i++) {
        const idx = list[i]!;
        const wasEmpty = rArr[idx] === ev;
        const isEmptyNow = wArr[idx] === ev;
        if (wasEmpty !== isEmptyNow) applyTransition(as, idx, wasEmpty, isEmptyNow);
        if (doIncr) {
          for (let d = 0; d < incrDefs.length; d++) {
            const e = incrDefs[d]!;
            const o = e.r[idx] ?? 0, nv = e.w[idx] ?? 0;
            if (o !== nv) {
              if (e.m) { e.m.set(o, (e.m.get(o) ?? 0) - 1); e.m.set(nv, (e.m.get(nv) ?? 0) + 1); }
              else if (e.totalId !== null) sieLinkedTotal.set(e.totalId, (sieLinkedTotal.get(e.totalId) ?? 0) + nv - o);
            }
          }
        }
      }
      if (as.staleCount > (as.count >> 2) + 64) {
        // Compaction removes just-emptied cells from the list BEFORE the batch
        // colour pass could repaint them — force that pass to run full once.
        compactActiveSet(as);
        sieColorDirtyAll = true;
      }
    }
  }

  // Post-step buffer management (sync mode only ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â async uses single buffer).
  // Done BEFORE the linked-indicator compute below: on WASM-sync the wÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢r copy
  // must land first so readAttrs holds the JUST-COMPUTED generation (it
  // otherwise held gen N-1, lagging the JS embed which reads the write buffer).
  if (isSync) {
    if (callWasm) {
      // WASM wrote new gen to attrWriteOffset (= attrsB). Bulk-copy w ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ r so
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
    // problem on WASM ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the read/write offsets are baked. Bulk-copy w ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ r so
    // the next step (and the output mapping) sees the new orientations.
    if (orientationReadView && orientationWriteView && orientationReadView !== orientationWriteView) {
      orientationReadView.set(orientationWriteView);
    }
  }

  // WASM step doesn't emit the per-loop linked-indicator aggregation the JS step
  // does (the JS embed reads the write buffer = the new gen). Compute it from the
  // shared buffer AFTER the wÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢r copy above, so readAttrs holds the new generation
  // on both sync (post-copy) and async (single buffer) ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â matching the JS embed.
  // (Was previously computed before the copy ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ read gen N-1 in WASM sync mode.)
  // "Skip Isolated Empty Cells" (sieParamsPresent): the sparse JS step also omits
  // the embedded linked aggregation (it would only see ACTIVE cells) — the full
  // grid scan below aggregates ALL cells, matching the non-sparse embed.
  const sieIncrReady = sieIncrementalActive && sieLinkedBaselineValid;
  // Defer only when the WORKER owns the scan (WASM target / sparse JS): the
  // plain JS target embeds the aggregation in the compiled loop, so deferring
  // there would just add a redundant batch-tail scan on top of the embed.
  const deferScan = deferIndicatorScan && !linkedHasAccumulated && !sieIncrReady
    && (callWasm || sieParamsPresent) && linkedDefs.length > 0;
  if (deferScan) {
    indicatorScanPending = true;   // batch tail runs the scan + spatial once
  } else if ((callWasm || sieParamsPresent) && linkedDefs.length > 0) {
    if (sieIncrReady) emitSieLinkedResults();
    else computeLinkedIndicatorsFromBuffer();
  }

  // Handle linked indicator accumulation (skip when no linked indicators).
  // Runs AFTER the compute above so it accumulates the new generation's values.
  for (let _li = 0; _li < (deferScan ? 0 : linkedDefs.length); _li++) {
    const def = linkedDefs[_li]!;
    // Spatial indicators are always a live per-step snapshot ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â never
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
  // Spatial indicators (chromatogram): recompute the live per-position histogram
  // from the post-step buffer. readAttrs now holds the just-computed generation
  // on JS (ref-swap above) AND on WASM (wÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢r bulk copy above) ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the same buffer
  // a later getState reads, so the verification parity check holds. Independent
  // of the generation-axis linked path; written here (after accumulation) so it
  // is always a fresh per-step snapshot.
  if (hasSpatialIndicators && !deferScan) computeSpatialIndicators();
  generation++;
}

/**
 * Wave 3 step path. The compiled WGSL step shader runs on the GPU; attrs stay
 * GPU-resident across many steps (the headline win ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â no per-step CPU readback).
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
  // stopEvent nodes (the flag never moves off zero) ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â saves a tiny queue
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
 *  main thread ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â no readback or postMessage needed for display. */
function runColorPassWebGPU(opts: { skipReductions?: boolean } = {}): boolean {
  if (!webgpuRuntime || !webgpuRuntime.stepReady) return false;
  // Glyphs: clear before the colour pass so the OM shader's per-cell writes
  // see codepoint-0 sentinels everywhere. Mirrors the CPU runColorPass path.
  if (webgpuRuntime.layout.hasGlyphs) clearGlyphBuffersWebGPU(webgpuRuntime);
  // P6 ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â combined color-pass + present in one encoder + submit. Saves a
  // driver round-trip per frame compared to dispatching them separately.
  // When direct render is on but the active viewer has no Output Mapping
  // graph (e.g. MNCA "Case Colored" / "Decorated Trace"), the present pass
  // still runs and pushes whatever the step shader wrote via
  // SetColorViewer-in-step.
  const ok = dispatchColorPassAndPresent(webgpuRuntime, activeViewer);
  // L1 (3D): the colours buffer just changed — re-run the voxel compaction +
  // indirect draw so the transferred canvas shows the new frame. This is the ONE
  // hook that covers the step-batch tail, mutation tails and the colour-pass
  // message, because every colour refresh routes through here.
  presentVoxelsIfActive();
  // O5 ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â refresh the watched-linked-indicator histograms on GPU. Cheap (a
  // handful of u32 atomics per cell) and the result rides the same
  // batched mapAsync as colors/indicators/stopFlag in the next finalize.
  // `skipReductions` is for the DISPLAY-ONLY refresh the free-mode voxel render
  // forces under skipColorPass: that finalize passes needColors:false, which
  // already gates the reductions READBACK off, so dispatching them would be one
  // more whole pass over the grid whose result nobody reads.
  if (webgpuRuntime.reductionPlan && !opts.skipReductions) dispatchReductions(webgpuRuntime);
  return ok;
}

/** Refresh the GPU colors buffer after a user interaction (paint, image
 *  import, writeRegion, clearRegion). When the active viewer has a dedicated
 *  Output Mapping pipeline, dispatch it. Otherwise, run one Step ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â models that
 *  emit colors via SetColorViewer-in-step (e.g. MNCA's "Case Colored") rely on
 *  the step to update colors. Generation advances by 1 in the fallback case,
 *  which is the documented behaviour for these models on user interaction.
 *
 *  CRITICAL ordering: for no-OM viewers we MUST dispatch the step BEFORE the
 *  present pass ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â otherwise the present blits the stale colors that were
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
  // No OM pipeline ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ step shader populates colors via SetColorViewer-in-step.
  // Dispatch step FIRST so colorsBuf is fresh, THEN present so the canvas
  // texture picks it up.
  runStepWebGPU();
  presentToCanvas(rt);
  presentVoxelsIfActive();   // L1 (3D): the no-OM branch writes colours too.
}

/** JS / WASM analogue of refreshColorsAfterInputWebGPU. Same intent: after any
 *  CPU-side mutation (paint, paste, clear, reset, image import),
 *  refresh the CPU `colors` mirror so the next sendColors ships up-to-date
 *  pixels. Prefer the active viewer's Output Mapping (no generation advance);
 *  fall back to one Step (advances gen by 1; required for viewers like MNCA
 *  that emit colors via SetColorViewer-in-step); fall back to the bool-attr
 *  default coloring. ALL JS/WASM mutation handlers should call this ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â without
 *  it, no-OM viewers display pre-mutation colors after Ctrl+V / Ctrl+X. */
function refreshColorsAfterInputJS(): void {
  // "Skip Isolated Empty Cells": any CPU mutation (paint / paste / clear / image
  // import) may have changed which cells are non-empty, so rebuild the active set
  // from the current grid BEFORE any refresh step. Painting is never gated by the
  // active set (writes go direct); this just re-derives the surface so newly
  // non-empty cells + their range become active next step. No-op when off.
  rebuildActiveSetFromGrid();
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
 *      Picked when the bounding range is at most 4ÃƒÆ’Ã¢â‚¬â€ the touched-cell count
 *      (e.g. one rectangular brush stroke). Pays for some "in-between" cells
 *      but trades 4-byte queue submissions for one large one.
 *    - Per-cell: one writeBuffer per touched cell. Picked when the range is
 *      sparse (e.g. cells at opposite corners) so the batch would be wasteful.
 *
 *  We deliberately skip writing to `attrsWriteBuf` ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the next step's per-cell
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
  // WebGPU, gpuOwnsAttrs=true and the CPU mirror is stale ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â uploading
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
 *  buffer. Called at init, after reset, and before each step (to
 *  re-seed per-generation indicators). */
function syncIndicatorsCpuToGpu(): void {
  if (!webgpuRuntime || !webgpuRuntime.stepReady) return;
  const vals: Record<string, number> = {};
  for (const { idx, id } of standaloneIds) vals[id] = cachedIndicators[idx]!;
  // Linked indicator atomic slots stay 0 ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â linked aggregation runs CPU-side
  // post-step from the readback attrs.
  uploadIndicators(webgpuRuntime, vals, isIntEncodedIndicator);
}

/** Pull GPU buffers back to the CPU mirrors that sendColors + stop-event +
 *  indicator UI all read. Called in the message handler after a WebGPU
 *  dispatch sequence has been queued.
 *
 *  - colors ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ `colors` (Uint8ClampedArray), used by sendColors().
 *  - indicators ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ `cachedIndicators`, decoded per-indicator type.
 *  - stopFlag ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ `stopFlag[0]` so the existing stop-event detection works.
 *  - linked indicators ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ CPU-side via readback of attrsRead, then run the
 *    existing `computeLinkedIndicatorsFromBuffer()`. Watched-only.
 *  - cell attrs ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ ONLY when a watched linked indicator needs them, OR when
 *    the caller explicitly asks (e.g. getState).
 */
async function finalizeStepWebGPU(opts: { needAttrs?: boolean; needColors?: boolean } = {}): Promise<void> {
  const rt = webgpuRuntime;
  if (!rt || !rt.stepReady) return;
  // Inspect-cell popups need fresh CPU attrs for their per-cell readout. Bump
  // needAttrs internally so callers don't have to thread the flag.
  const fullAttrs = !!opts.needAttrs || inspectCellIdxs.length > 0;
  // O5 ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â figure out which watched indicators are handled by the GPU
  // reduction plan; their attrs don't need a CPU readback. Empty plan ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢
  // gpuHandled is empty and the existing CPU path handles everything.
  const gpuPlan = rt.reductionPlan;
  const gpuIds = gpuPlan ? gpuHandledIds(gpuPlan) : new Set<string>();
  const gpuAttrIds = gpuPlan ? gpuHandledAttrIds(gpuPlan, linkedDefs) : new Set<string>();
  // Watched linked indicators need only the source attr's bytes, not the whole
  // attrs region. Build a deduped list of source attr ids ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â minus the ones
  // O5 covers on GPU.
  const watchedAttrIds = new Set<string>();
  if (!fullAttrs) {
    for (const d of linkedDefs) {
      if (!d.watched || !d.attrId) continue;
      const isSpatial = d.xAxis === 'rows' || d.xAxis === 'columns' || d.xAxis === 'layers';
      // Spatial indicators are CPU-only (excluded from buildReductionPlan), so
      // they always need their source attr (and parent, for sub-attrs) on the
      // CPU ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â even if a sibling generation-axis indicator over the same attr is
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
  // P7 ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â direct render owns the canvas; we never need to readback colors for
  // display. EXCEPT during GIF recording or inspect popups: both consume the
  // per-frame colors on the main thread (recording: into ImageData frames;
  // inspect: into the per-cell RGB readout in the popover). The readback is
  // the same cost as before P7, but only paid when at least one of those is
  // active.
  // L1 extends the `!rt.directRender` term to `!gridDisplayOwnedByGpu()`: the 3D
  // voxel render in free mode owns the display exactly like 2D direct render, so
  // the colours never need to reach the CPU. STRUCTURALLY IDENTICAL — the
  // selective watched-attr readback and the reductions path below are untouched.
  const wantColors = (opts.needColors !== false) && (!gridDisplayOwnedByGpu() || recording || inspectCellIdxs.length > 0);
  // P5 ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â only read back indicators that the UI/end-conditions actually
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
  // saves N-1 GPUÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬ÂCPU round trips per finalize compared to the old
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
    // attrs stay GPU-resident ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â gpuOwnsAttrs remains true.
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
    colorsDirty = true;
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
    // Only a subset of attrs were pulled ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the rest remain GPU-only-fresh.
    // Subsequent paint with `gpuOwnsAttrs && icEntry?.fn` will trigger a full
    // readback (B5 fix), so leaving gpuOwnsAttrs=true is safe.
    computeLinkedIndicatorsFromBuffer();
    if (hasSpatialIndicators) computeSpatialIndicators();
  }
  // O5 ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â decode the reductions slice into linkedResults. Done AFTER the CPU
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
  // Agents-only: no colors region exists (0 bytes) and nothing renders the
  // grid ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â skip (also avoids a per-cell loop over a potentially huge total).
  if (!gridCellsEnabled) return;
  colorsDirty = true;
  // 3D Grid CA: the default/fallback coloring is FULLY TRANSPARENT (alpha 0) so
  // the voxel renderer instances ZERO cells ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â a model with no explicit Output
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

function resetGrid(): void {
  for (const attr of cellAttrs) {
    const dv = defaultValue(attr);
    const arr = readAttrs[attr.id]!;
    const wArr = writeAttrs[attr.id]!;
    for (let i = 0; i < total; i++) { arr[i] = dv; wArr[i] = dv; }
  }
  // Variegated Cells: orientation defaults to 0 (spec Ãƒâ€šÃ‚Â§6.3). Clear both views
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
  // Under WebGPU the message handler is solely responsible for the post-mutation
  // visual update (uploadAttrs + runColorPassWebGPU). Refreshing colors here
  // would read the STALE GPU attrsRead ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the CPU mutation hasn't been uploaded
  // yet ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â so defer the visual update to the message handler.
  if (useWebGPU && webgpuRuntime?.stepReady) return;
  refreshColorsAfterInputJS();
}

function compileFns(
  stepCode: string,
  icCodes: Array<{ mappingId: string; code: string }>,
  omCodes: Array<{ mappingId: string; code: string }> = [],
  initCode: string = '',
  gridInitCode: string = '',
): void {
  try {
    // eslint-disable-next-line no-eval
    stepFn = stepCode ? (eval(stepCode) as Function) : null;
  } catch { stepFn = null; }
  try {
    // eslint-disable-next-line no-eval
    initFn = initCode ? (eval(initCode) as Function) : null;
  } catch { initFn = null; }
  try {
    // eslint-disable-next-line no-eval
    gridInitFn = gridInitCode ? (eval(gridInitCode) as Function) : null;
  } catch { gridInitFn = null; }
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
 *  highWater`. Absent code ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ null (agents seed + render but don't behave, the
 *  PR-A2 state). */
function compileAgentFns(behaviourCode?: string, initCode?: string, divisionCode?: string, outputMappingCodes?: Array<{ mappingId: string; code: string }>): void {
  try {
    // eslint-disable-next-line no-eval
    agentBehaviourFn = behaviourCode ? (eval(behaviourCode) as Function) : null;
  } catch (e) { agentBehaviourFn = null; self.postMessage({ type: 'error', message: '[agents] behaviour compile failed: ' + ((e as Error)?.message || e) }); }
  // Agent Output Mappings ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â compile each linked agent mapping's per-agent colour pass.
  agentOutputMappingFns = [];
  for (const om of (outputMappingCodes || [])) {
    try {
      // eslint-disable-next-line no-eval
      agentOutputMappingFns.push({ mappingId: om.mappingId, fn: eval(om.code) as Function });
    } catch (e) { self.postMessage({ type: 'error', message: `[agents] output mapping '${om.mappingId}' compile failed: ` + ((e as Error)?.message || e) }); }
  }
  try {
    // eslint-disable-next-line no-eval
    agentInitFn = initCode ? (eval(initCode) as Function) : null;
  } catch (e) { agentInitFn = null; self.postMessage({ type: 'error', message: '[agents] init compile failed: ' + ((e as Error)?.message || e) }); }
  try {
    // eslint-disable-next-line no-eval
    agentDivisionFn = divisionCode ? (eval(divisionCode) as Function) : null;
  } catch (e) { agentDivisionFn = null; self.postMessage({ type: 'error', message: '[agents] division compile failed: ' + ((e as Error)?.message || e) }); }

  // DEV ABI-arity assertion (E3, MANDATORY) ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the single highest-value safety net
  // for the B1 desync class. A compiled agent fn's `.length` (its declared param
  // count, from buildAgentLoop/DivisionParams) MUST equal the arg count the worker
  // passes (buildAgentLoop/DivisionArgs). A one-sided 3D-block edit shifts every
  // arg one slot WITHOUT a type error ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â only this arity check catches it. Division
  // takes 4 leading scalars (idx/daughterIndex/axisX/axisY) before the mirrored
  // buffers, so its arg count is built with placeholder scalars.
  if (import.meta.env?.DEV && agentStore) {
    const s = agentStore;
    if (agentBehaviourFn) {
      const want = buildAgentLoopArgs(s).length;
      if (agentBehaviourFn.length !== want) {
        self.postMessage({ type: 'error', message: `[agents] ABI ARITY DESYNC: behaviour fn declares ${agentBehaviourFn.length} params but buildAgentLoopArgs passes ${want} (buildAgentLoopParamsÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬ÂbuildAgentLoopArgs out of lockstep ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the B1 hazard).` });
      }
    }
    if (agentDivisionFn) {
      const want = buildDivisionArgs(s, 0, 0, 0, 0).length;
      if (agentDivisionFn.length !== want) {
        self.postMessage({ type: 'error', message: `[agents] ABI ARITY DESYNC: division fn declares ${agentDivisionFn.length} params but buildDivisionArgs passes ${want} (buildDivisionParamsÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬ÂbuildDivisionArgs out of lockstep ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the B1 hazard).` });
      }
    }
    if (agentInitFn) {
      // The Agent Init Event is the third ABI pair (buildAgentInitParams ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬Â
      // buildAgentInitArgs). Dummy closures/seedBase just count the arg array ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â
      // buildAgentInitArgs never calls them while building the list.
      const want = buildAgentInitArgs(s, () => 0, () => {}, 0).length;
      if (agentInitFn.length !== want) {
        self.postMessage({ type: 'error', message: `[agents] ABI ARITY DESYNC: init fn declares ${agentInitFn.length} params but buildAgentInitArgs passes ${want} (buildAgentInitParamsÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬ÂbuildAgentInitArgs out of lockstep ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the B1 hazard).` });
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
 *  it instead of the JS function ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â both write through views over `wasmMemory`,
 *  so the post-run sync-mode swap below sees the right bytes regardless of
 *  which path wrote them. Same sync normalisation as runStep: when readAttrs
 *  != attrsA we copy back to attrsA first so WASM's baked-in offsets read the
 *  freshly-zeroed defaults instead of stale attrsB data.
 *
 *  WebGPU Init isn't supported in this phase ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the worker falls back to the
 *  JS init function under WebGPU. The cell attribute buffers are TypedArray
 *  views over wasmMemory so writes still land in the right place; WebGPU
 *  uploads readAttrs after init in the reset handler. */
function runInit(): void {
  // Grid Init Event models: the GPU init pipeline is BYPASSED — the grid seed
  // is written by the CPU-only runGridInit, so the CPU must be the init
  // authority end-to-end (per-cell init on CPU via the JS initFn, then the
  // grid init on top) and the reset handler uploads the complete CPU state.
  // Taking the GPU shortcut here left the CPU without the per-cell init's
  // writes AND skipped the upload -> the seed silently never reached the GPU
  // (the reported "switch the Accretor to WebGPU and Reset shows no seed").
  const useWebGPUInit = useWebGPU && webgpuRuntime?.stepReady && webgpuRuntime.initPipeline !== null && gridInitFn === null;
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
  // Sync mode: copy writeAttrs ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ readAttrs so both buffers match (mirrors the
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

/** Grid Init Event — the GLOBAL once-per-Reset seeding function (NOT loop-wrapped,
 *  no per-cell `idx`). Runs on Reset + first load, AFTER the per-cell runInit (so a
 *  global seed is the final word), writing arbitrary cells via Set Cell (at
 *  Position). Executes on EVERY compile target: it writes the CPU/wasm attribute
 *  buffers (which are views over wasmMemory under WASM), then the sync-mode buffer
 *  copy below + the caller's WebGPU upload push the seeded state to the target.
 *
 *  Buffer discipline (mirrors runInit): it runs right after resetGrid / initGrid,
 *  so readAttrs === attrsA (the WASM baked read offset) and writeAttrs === attrsB.
 *  Sync mode: seed the write buffer with the current read state (so cells the user
 *  doesn't touch persist), run the fn (it writes specific w_<attr> cells), then
 *  copy write -> read. Async mode shares one buffer (no copies). Returns true when
 *  it ran (so the caller recomputes colours / uploads); false + no-op when there's
 *  no Grid Init fn or no grid. */
function runGridInit(): boolean {
  if (!gridInitFn || !gridCellsEnabled) return false;
  const isSync = updateMode !== 'asynchronous';
  if (isSync) {
    for (const attr of cellAttrs) {
      (writeAttrs[attr.id] as Uint8Array).set(readAttrs[attr.id] as Uint8Array);
    }
  }
  try {
    (gridInitFn as (...a: unknown[]) => void)(...buildLoopArgs());
  } catch (e) {
    self.postMessage({ type: 'error', message: '[gridInit] Grid Init Event failed: ' + ((e instanceof Error) ? e.message : String(e)) });
    return false;
  }
  if (isSync) {
    for (const attr of cellAttrs) {
      (readAttrs[attr.id] as Uint8Array).set(writeAttrs[attr.id] as Uint8Array);
    }
  }
  return true;
}

/** "Skip Isolated Empty Cells": (re)build the active-set STRUCTURE from the model
 *  config + grid dims. Sets sieParamsPresent (mirrors the compiler's
 *  sparseSteppingEnabled: enabled + sync + gridCells) + allocates `activeSet` when
 *  the config resolves. Does NOT populate it — call rebuildActiveSetFromGrid()
 *  after the grid is seeded. Called on init/recompile. */
function setupActiveSet(): void {
  activeSet = null;
  sieEmptyAttrId = '';
  // Mirrors compile.ts sparseSteppingEnabled EXACTLY: enabled + sync + gridCells
  // + NO agents (field-bridge deposits bypass the active set) + NO glyphs
  // (glyph zero-fills assume a full repaint — see sparseStepping.ts).
  sieParamsPresent = !!sieConfig?.enabled && updateMode !== 'asynchronous' && gridCellsEnabled && !agentsEnabled && !hasGlyphs;
  if (!sieParamsPresent || !sieConfig) return;
  const cfg = sieConfig;
  const emptyAttr = cellAttrs.find(a => a.id === cfg.emptyAttributeId);
  if (!emptyAttr) return;   // invalid config → activeSet stays null → step runs full
  const emptyVal = encodeAttrValue(emptyAttr, cfg.emptyValue);
  // Constant boundary with a NON-EMPTY boundary value on the empty-defining
  // attribute: OOB reads resolve to the always-non-empty sentinel cell, so
  // EVERY border-adjacent empty cell can transition — a state the active set
  // (which never models the sentinel) can't cover with ANY range. Fall back to
  // the full loop (activeSet null → the compiled fn's full branch). The common
  // configuration (empty boundary, e.g. the Accretor) is unaffected.
  if (boundaryTreatment !== 'torus') {
    const arr = readAttrs[cfg.emptyAttributeId] as unknown as { [i: number]: number } | undefined;
    if (arr && arr[total] !== emptyVal) return;
  }
  const is3d = depth > 1;
  let built: { offsets: Int32Array; offCount: number } | null = null;
  if (cfg.rangeKind === 'radius') {
    built = buildActiveOffsets({ kind: 'radius', radius: Math.max(1, cfg.radius ?? 1), metric: cfg.radiusMetric ?? 'chebyshev', is3d });
  } else {
    const nbr = neighborhoods.find(n => n.id === cfg.neighborhoodId);
    if (nbr) {
      const coords = (nbr.coords3d && nbr.coords3d.length) ? nbr.coords3d : nbr.coords.map(c => [c[0], c[1], 0]);
      built = buildActiveOffsets({ kind: 'neighborhood', coords });
    }
  }
  if (!built || built.offCount === 0) return;   // invalid range → step runs full
  // Range-size cap: nearCount is Uint16 (max 65535 non-empty cells within range
  // of one cell). A range of > 30000 offsets could overflow it in dense regions
  // (a wrap would silently drop genuinely-active cells at the next compaction),
  // so oversized ranges fall back to the full loop. Sensible ranges (the point
  // of the feature) are tiny — the Accretor's is 27 offsets.
  if (built.offCount > 30000) return;
  sieEmptyAttrId = cfg.emptyAttributeId;
  // Back the active LIST with the wasmMemory region when the layout reserved it
  // (it does whenever the feature resolved at init) — the sparse WASM step reads
  // the list via the baked activeListOffset, and the JS step reads the SAME view
  // through its `_activeList` arg. Zero per-step copies.
  const listView = (wasmMemory && wasmLayout && wasmLayout.activeListBytes >= total * 4)
    ? new Int32Array(wasmMemory.buffer, wasmLayout.activeListOffset, total)
    : undefined;
  activeSet = createActiveSet(
    { width, height, depth, total, is3d, torus: boundaryTreatment === 'torus' },
    built.offsets, built.offCount, emptyVal, listView,
  );
}

/** Populate the active set from the current READ buffer (after init / reset /
 *  gridInit / loadState / a paint mutation). No-op when the feature is off. */
function rebuildActiveSetFromGrid(): void {
  if (!activeSet) return;
  const attr = readAttrs[sieEmptyAttrId];
  if (attr) rebuildActiveSet(activeSet, attr as unknown as { [i: number]: number });
  // The grid content changed outside the step — re-baseline the incremental
  // linked-indicator aggregates from the same source of truth.
  if (sieIncrementalActive) recountSieLinkedBaseline();
}

/** Run the Output Mapping color pass for the active viewer (if available).
 *  WASM mode: uses wasmOutputMappingFns. Sync mode + WASM also requires the
 *  same readAttrs->attrsA pre-step normalisation as runStep does, because the
 *  output mapping reads from the baked-in attrReadOffset. */
function runColorPass(sparseOk: boolean = false): void {
  // Agents-only: no colors region + nothing renders the grid (agent views go
  // through runAgentColorPass instead).
  if (!gridCellsEnabled) return;
  // Glyph buffers: zero before every colour pass so per-cell setCellGlyph
  // writes see a fresh canvas. "Codepoint 0" is the renderer's "skip this
  // cell" signal. Cheap memset ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â at 5000Ãƒâ€šÃ‚Â² this is ~3ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Å“6ms; for typical grids
  // negligible. Only allocated when the model uses setCellGlyph.
  if (glyphCodes) { glyphCodes.fill(0); colorsDirty = true; }
  if (glyphColors) glyphColors.fill(0);
  // "Skip Isolated Empty Cells": recolour only ACTIVE cells when the caller says
  // it's safe (`sparseOk` — the post-step-batch pass, where inactive cells'
  // colour inputs are provably frozen: inactive cells never step). Every OTHER
  // caller (paint / reset / model-attr edit / viewer switch / load) runs FULL so
  // any cell's colour can refresh. Glyph models always run full — the glyph
  // buffers were just zero-filled, so a sparse pass would erase inactive glyphs.
  const omSparse = sparseOk && sieParamsPresent && activeSet !== null && !glyphCodes && !sieColorDirtyAll;
  if (sieParamsPresent && !omSparse) sieColorDirtyAll = false;   // a full pass satisfies the dirty-all request
  const sanitised = sanitiseExportName(activeViewer);
  if (useWasm && wasmOutputMappingFns[sanitised]) {
    if (updateMode !== 'asynchronous' && readAttrs !== attrsA) {
      for (const attr of cellAttrs) {
        (attrsA[attr.id] as Uint8Array).set(readAttrs[attr.id] as Uint8Array);
      }
      readAttrs = attrsA;
      writeAttrs = attrsB;
    }
    colorsDirty = true;
    if (sieParamsPresent) {
      // Sparse module: OM export is (total, activeCount); -1 = full pass.
      (wasmOutputMappingFns[sanitised] as unknown as (t: number, c: number) => void)(total, omSparse ? activeSet!.count : -1);
    } else {
      wasmOutputMappingFns[sanitised]!(total);
    }
    return;
  }
  const omFn = outputMappingFns.find(f => f.mappingId === activeViewer);
  // Dirty only when a mapping fn actually rewrote `colors` ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â an OM-less model
  // (or a mismatched viewer) leaves the buffer untouched, and the agents-only
  // sendColors skip depends on that staying clean.
  if (omFn) { colorsDirty = true; omFn.fn(...buildLoopArgs(omSparse)); }
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
  // Sparse incremental / batch-deferred indicator plumbing (defs changed).
  linkedHasAccumulated = linkedDefs.some(d =>
    d.accumulationMode === 'accumulated'
    && !(d.xAxis === 'rows' || d.xAxis === 'columns' || d.xAxis === 'layers'));
  recomputeSieIncremental();
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
 *  `compiler/compile.ts` ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â keep the two in sync when that logic changes. */
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
      if (!Number.isFinite(mn) || !Number.isFinite(mx)) {
        // No matching / degenerate range (e.g. no cells) \u2014 single bucket.
        linkedResults[def.id] = { [`${(mn || 0).toFixed(2)}\u2013${(mn || 0).toFixed(2)}`]: counted };
        continue;
      }
      // Finite all-equal field: widen the range and bin normally so the histogram
      // shape matches the JS-embedded path (compile.ts) + the spatial branch \u2014
      // the single-bucket collapse here used to diverge from JS for a uniform field.
      if (mn === mx) mx = mn + 1;
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
 *  before invoking ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â otherwise the CPU mirror is stale. */
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
    // right slot. Absent (undefined) when variegation isn't enabled ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the
    // main-thread receiver checks before adding to its map.
    if (orientationReadView) {
      orientationsByCell[idx] = orientationReadView[idx]!;
    }
  }
  self.postMessage({ type: 'inspectCellsData', data, colors: colorsByCell, orientations: orientationsByCell });
}

// Overseer correlation id for the NEXT stepped post ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â set by the step/reset
// handlers from msg.reqId, consumed (and cleared) by sendColors. Module-level
// because the WebGPU/agent step batches call sendColors from an async tail.
let stepAckId: number | undefined;

function sendColors(): void {
  const ackId = stepAckId;
  stepAckId = undefined;
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
        // copy either through. Single filter point ÃƒÂ¢Ã¢â‚¬Â¡Ã¢â‚¬â„¢ covers JS / WASM / WebGPU.
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
  // even at 5000Ãƒâ€šÃ‚Â²: ~5ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Å“10 ms typed-array scan worst case, often early-exits
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

  // Bond-Graph Agents ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â attach a render snapshot (copies of the live region)
  // so the entity renderer + nearest-agent picker have current positions every
  // frame. Cheap (maxAgents is small); copies, so the engine keeps its SoA.
  // "Skip Isolated Empty Cells" observability: the live active-cell count
  // (-1 = the feature is configured on but not engaged — invalid config /
  // excluded combination / the WebGPU target, whose GPU dispatch runs the full
  // grid and never maintains the CPU active set — so the full loop is running).
  // Undefined when off. Without the WebGPU arm this showed a STALE init-time
  // count while the GPU evolved the grid.
  const sieActive = sieParamsPresent
    ? ((activeSet && !(useWebGPU && webgpuRuntime?.stepReady)) ? activeSet.count : -1)
    : undefined;
  let agentsPayload: ReturnType<typeof snapshotAgentsForRender> | undefined;
  // A1 direct render: in FREE mode (render active + UI-sync off) the GPU renders
  // the frame, so ship NO agents payload — just a live-count scalar (stats chip).
  let agentLiveCount: number | undefined;
  const agentRenderFree = agentRenderActive && !agentUiSync;
  const agentTransfers: ArrayBuffer[] = [];
  if (agentStore && agentStore.highWater > 0) {
    // Agent Output Mappings: recolour from the active agent viewer before
    // snapshotting (no-op when the model has no agent mappings ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â agents are then
    // coloured by the behaviour's Set Cell Looks during the step).
    runAgentColorPass();
    // Present the current frame when direct render is active and the resident
    // batch didn't already present it (per-gen path, mutations). Reads the CPU
    // store, so skip when a free-mode batch left it stale (already presented).
    if (agentRenderActive && !agentBatchPresented && !agentStoreStale) presentAgentsIfActive();
    if (agentRenderFree) { agentLiveCount = agentStore.liveCount; agentBatchPresented = false; }
    else {
    agentsPayload = snapshotAgentsForRender(agentStore, hasAgentSprites, agentSnapshotVelocity);
    agentTransfers.push(
      agentsPayload.x.buffer, agentsPayload.y.buffer,
      agentsPayload.radius.buffer,
      agentsPayload.alive.buffer, agentsPayload.colors.buffer,
      agentsPayload.bonds.buffer,
    );
    // vx/vy ship only for sprite models (P2 slim — the orientToVelocity heading
    // is their sole consumer); the length-0 placeholders SHARE one buffer, so
    // transferring them unconditionally would list a duplicate ArrayBuffer.
    if (agentsPayload.vx.length > 0) agentTransfers.push(agentsPayload.vx.buffer, agentsPayload.vy.buffer);
    // z/vz are length-0 placeholders in 2D (the A1 snapshot gate) ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â transfer them
    // only when 3D populated them, else an empty buffer is harmlessly cheap but
    // we skip it for symmetry with the gate.
    if (agentsPayload.z.length > 0) agentTransfers.push(agentsPayload.z.buffer);
    if (agentsPayload.vz.length > 0) agentTransfers.push(agentsPayload.vz.buffer);
    // Sprites: same gate ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â only ship the per-agent buffers when the model has sprites.
    if (agentsPayload.spriteIds.length > 0) agentTransfers.push(agentsPayload.spriteIds.buffer, agentsPayload.spriteFrames.buffer, agentsPayload.spriteRotations.buffer, agentsPayload.spriteScales.buffer);
    }
    agentBatchPresented = false;
  } else if (agentStore) {
    if (agentRenderFree) {
      agentLiveCount = 0;
      if (agentRenderActive && !agentBatchPresented && !agentStoreStale) presentAgentsIfActive();
      agentBatchPresented = false;
    } else {
    // Empty store ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â still tell the main thread so it clears any stale agents.
    agentsPayload = { highWater: 0, liveCount: 0, x: new Float32Array(0), y: new Float32Array(0), z: new Float32Array(0), vx: new Float32Array(0), vy: new Float32Array(0), vz: new Float32Array(0), radius: new Float32Array(0), alive: new Uint8Array(0), colors: new Uint8ClampedArray(0), bonds: new Int32Array(0), spriteIds: new Int32Array(0), spriteFrames: new Float32Array(0), spriteRotations: new Float32Array(0), spriteScales: new Float32Array(0) };
    }
  }

  // P7 ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â when WebGPU direct render is active, the OffscreenCanvas already
  // holds the latest frame; skip the colors transfer entirely. Main-thread
  // draw() detects this and only does the zoom/pan composite. Exception:
  // when GIF recording is on, finalizeStepWebGPU populated the `colors`
  // mirror via readback so the main thread can capture frames.
  // E2 composite: the shared canvas already holds grid+agents (composited above
  // via presentAgentsIfActive) — ship no grid `colors`; the main thread blits the
  // composite. Recording captures the DISPLAY canvas (which holds the composite),
  // so no colors readback is needed even under recording.
  // L1: the 3D voxel render in free mode is the same deal — the worker already
  // presented the frame into the transferred canvas, so ship no `colors` (they
  // were never read back either; see finalizeStepWebGPU's wantColors).
  if ((gridDisplayOwnedByGpu() && !recording) || agentCompositeActive) {
    if (glyphsPayload) {
      self.postMessage(
        { type: 'stepped', generation, indicators, sieActive, reqId: ackId, glyphCodes: glyphsPayload.codes, glyphColors: glyphsPayload.colors, agents: agentsPayload, agentLiveCount },
        { transfer: [glyphsPayload.codes.buffer, glyphsPayload.colors.buffer, ...agentTransfers] },
      );
    } else {
      self.postMessage({ type: 'stepped', generation, indicators, sieActive, reqId: ackId, agents: agentsPayload, agentLiveCount }, { transfer: agentTransfers });
    }
    postInspectCellsData();
    return;
  }
  // Agents-only (CA Grid off): the colours buffer is STATIC after init ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â no cell
  // step / colour pass rewrites it ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â so copy+transfer it only while dirty (the
  // main thread keeps its last colorsRef when `colors` is absent, exactly like
  // the WebGPU direct-render branch above). At agent-world scales this is the
  // difference between a usable sim and copying WÃƒâ€šÃ‚Â·HÃƒâ€šÃ‚Â·DÃƒâ€šÃ‚Â·4 bytes every step.
  if (!gridCellsEnabled && (!colorsDirty || colors.length === 0)) {
    self.postMessage({ type: 'stepped', generation, indicators, sieActive, reqId: ackId, agents: agentsPayload, agentLiveCount }, { transfer: agentTransfers });
    postInspectCellsData();
    return;
  }
  const copy = new Uint8ClampedArray(colors);
  colorsDirty = false;
  if (glyphsPayload) {
    self.postMessage(
      { type: 'stepped', generation, colors: copy, indicators, sieActive, reqId: ackId, glyphCodes: glyphsPayload.codes, glyphColors: glyphsPayload.colors, agents: agentsPayload, agentLiveCount },
      { transfer: [copy.buffer, glyphsPayload.codes.buffer, glyphsPayload.colors.buffer, ...agentTransfers] },
    );
  } else {
    self.postMessage(
      { type: 'stepped', generation, colors: copy, indicators, sieActive, reqId: ackId, agents: agentsPayload, agentLiveCount },
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

  // P0: an ASYNC step batch is running (WebGPU grid / WebGPU agents) — defer
  // EVERYTHING until it settles, reproducing the synchronous batch loop's
  // can't-be-interleaved semantics (see endAsyncStepBatch). Without this, a
  // queued `step` started a CONCURRENT batch mid-await → frozen/corrupted
  // dynamics with zero errors.
  if (asyncStepBatchInFlight) {
    deferredDuringAsyncBatch.push(msg);
    return;
  }

  // A GPU agent step's awaited readback yields to this handler ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â defer mutation
  // messages until the step settles so the readback can't clobber them.
  if (agentGpuStepInFlight && AGENT_GPU_DEFER_TYPES.has(msg.type)) {
    deferredDuringAgentGpuStep.push(msg);
    return;
  }

  // A1 one-shot rule (the ONE place): if the CPU agent store lags the GPU
  // (free-mode residency skipped the per-frame readback) and this message reads
  // or mutates agent state, pull the GPU state DOWN first so no consumer ever
  // sees stale coordinates. Reuses the async-batch deferral discipline: block,
  // readback, then replay the (now-fresh) message. AGENT_GPU_DEFER_TYPES covers
  // every mutation; getAgentState / getState are the on-demand readers.
  // `recompile` joins the readers (audit M3): it REBUILDS the agent GPU runtime,
  // dropping every GPU-side buffer. In free mode the CPU store can be many frames
  // behind, so without the one-shot readback a soft recompile silently REWOUND the
  // simulation to the last synced frame. Pulling the state down here (then item
  // B1's agentGpuUploadPending re-seeds the fresh runtime from it) makes a soft
  // recompile lossless. Reuses the one-and-only one-shot mechanism — no new
  // await/teardown sequencing inside buildAgentWebGPUIfNeeded.
  if (agentStoreStale && agentWebgpuRuntime && agentStore
      && (AGENT_GPU_DEFER_TYPES.has(msg.type) || msg.type === 'getAgentState' || msg.type === 'readAgents' || msg.type === 'getState' || msg.type === 'recompile')) {
    asyncStepBatchInFlight = true;   // no message may interleave the one-shot readback
    deferredDuringAsyncBatch.push(msg);
    // The flag MUST be cleared from a finally (audit H2): a throw here would leave
    // asyncStepBatchInFlight set forever and the guard above would then defer every
    // subsequent message with no replay — a permanent, silent worker dead-lock.
    void (async () => { try { await ensureAgentStoreFresh(); } finally { endAsyncStepBatch(); } })();
    return;
  }

  // PR7c: any state-mutating message invalidates the GPU-resident agent copy —
  // the next resident batch re-uploads the SoA. (Deferred messages replay
  // through this handler, so the flag is set when they actually APPLY.)
  if (AGENT_GPU_DEFER_TYPES.has(msg.type) || msg.type === 'loadState' || msg.type === 'reset' || msg.type === 'setRngSeed' || msg.type === 'importImage') {
    agentGpuUploadPending = true;
  }

  switch (msg.type) {
    case 'init': {
      width = msg.width;
      height = msg.height;
      depth = msg.depth ?? 1;   // 3D Grid CA: absent ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ 1 (2D)
      cellAttrs = msg.attributes.filter(a => !a.isModelAttribute);
      // Generic Agent Platform: the AGENT attribute set (separate id-space) +
      // the agent-accessible cell attrs (the field channel). fieldSpecs mirrors
      // the compiler's cellFieldAttrsOf so the _field_ args stay in ABI lockstep.
      agentAttrs = msg.agentAttributes ?? [];
      fieldSpecs = cellAttrs.filter(a => a.agentAccess === 'read' || a.agentAccess === 'readWrite');
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
          // #rrggbb (alpha absent → 255, i.e. every pre-alpha model is unchanged)
          // or #rrggbbaa. Slot names must match `modelAttrSlotKeys`.
          const c = hexToRgba(attr.defaultValue || '#808080');
          cachedModelAttrs[attr.id + '_r'] = c.r;
          cachedModelAttrs[attr.id + '_g'] = c.g;
          cachedModelAttrs[attr.id + '_b'] = c.b;
          cachedModelAttrs[attr.id + '_a'] = c.a;
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
      gridCellsEnabled = (msg as InitMsg).gridCells !== false;
      // "Skip Isolated Empty Cells": stash the config + the agents flag BEFORE
      // initGrid — the layout reserves the active-list region from them
      // (layout-lockstep with the compile side's sparseSteppingEnabled, which
      // also excludes agent models: field-bridge deposits bypass the active set).
      // agentsEnabled is (re-)assigned identically further down with the rest of
      // the agent payload — this early assignment only feeds the layout flag.
      sieConfig = msg.skipIsolatedEmpty ?? null;
      agentsEnabled = !!msg.agents;
      // WebGPU grid target: decide whether initGrid can DROP the full per-cell
      // neighbour table (nbrTableDropped) — the GPU computes neighbours inline,
      // so the table (total * nSz * 4) is dead weight unless a CPU-executed
      // compiled function indexes it. Decided from msg.useWebGPU (INTENT — the
      // layout is baked here, before the async runtime is known to succeed) +
      // whether any of init / gridInit / OM / inputColor indexes `nIdx_` (the
      // STEP is deliberately EXCLUDED: its JS/WASM fallback is what we drop).
      // Only when the FULL table would be reserved (grid on + SIE off): with SIE
      // on the table is already the tiny compact form — nothing to save.
      // nbrTableDroppedErrorPosted resets per init (fresh worker state).
      {
        const isAsyncInit = updateMode === 'asynchronous';
        const sieOnInit = !!sieConfig?.enabled && !isAsyncInit && gridCellsEnabled && !agentsEnabled && !hasGlyphs;
        const cpuIndexesNbrInit =
          codeIndexesNeighbourTable(msg.initCode)
          || codeIndexesNeighbourTable(msg.gridInitCode)
          || (msg.outputMappingCodes ?? []).some(o => codeIndexesNeighbourTable(o.code))
          || (msg.inputColorCodes ?? []).some(ic => codeIndexesNeighbourTable(ic.code));
        nbrTableDropped = !!msg.useWebGPU && gridCellsEnabled && !sieOnInit && !cpuIndexesNbrInit;
        nbrTableDroppedErrorPosted = false;
        // WebGPU grid target (sync): the STEP runs on the GPU, so drop the CPU
        // sync attr WRITE double-buffer too (attrWriteAliased). Unlike the
        // neighbour table this is INDEPENDENT of what CPU functions read — the
        // only reader that needs a distinct write buffer is the sync STEP, which
        // never runs on WebGPU (runStepWebGPU returns first; the runStep guard
        // enforces it). init / gridInit / paint write final values, correct with
        // write===read. Async already aliases (single buffer), so gate on !async.
        attrWriteAliased = !!msg.useWebGPU && gridCellsEnabled && !isAsyncInit;
      }
      try {
        initGrid();
      } catch (e) {
        // Surface allocation failures LOUDLY (e.g. a grid so large the layout
        // exceeds the wasm32 4 GiB Memory limit ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â dominated by the per-cell
        // neighbour tables totalÃƒÆ’Ã¢â‚¬â€nSzÃƒÆ’Ã¢â‚¬â€4 on big 3D grids). Without this the
        // worker died silently mid-init and a resize appeared to "hang".
        self.postMessage({
          type: 'error',
          message: `Grid allocation failed for ${width}x${height}x${depth} (${(width * height * depth).toLocaleString()} cells): `
            + ((e as Error)?.message || e)
            + '. The simulation memory is one WebAssembly.Memory backing store shared by ALL compile targets (hard cap 4 GiB). '
            + (gridCellsEnabled
              ? 'Per-cell storage scales with W*H*D: cell attributes + colours + engine buffers, and neighbour tables add x neighbourhood-size (the dominant cost on a large 3D grid).'
              : 'With the CA grid off, per-cell storage is the CELL ATTRIBUTES only (agents read/deposit fields through them) - delete unused cell attributes or reduce the world dimensions.'),
        });
        break;
      }
      // Skip the (potentially large) neighbour-index tables when the CA grid is
      // off ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â no cell step queries them in an agents-only model.
      if (gridCellsEnabled) buildNeighborIndices();
      // "Skip Isolated Empty Cells": resolve the active-set structure (populated
      // below, after the grid is seeded by runInit/runGridInit). sieConfig was
      // stashed before initGrid (the layout depends on it).
      setupActiveSet();
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
      compileFns(msg.stepCode, msg.inputColorCodes, msg.outputMappingCodes || [], msg.initCode || '', msg.gridInitCode || '');
      // Bond-Graph Agents ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â allocate the co-resident agent engine (additive on
      // top of the always-present grid). The agent behaviour/init functions are
      // compiled by compileAgentFns; absent in PR-A2 (agents seed + render only).
      agentsEnabled = !!msg.agents;
      agentUsesField = !!msg.agentUsesField;
      agentUsesDensity = msg.agentUsesDensity ?? true;
      agentGraphResidencyClean = !!msg.agentResidencyClean;
      centerBasedConfig = msg.centerBased ?? null;
      agentColorViewer = msg.agentColorViewer || '';
      hasAgentSprites = !!msg.agentHasSprites;
      // PR6b-1 / PR7: resolve the agent target + stash the per-target payload
      // BEFORE initAgents (which reads agentTarget to decide whether to back the
      // store on WebAssembly.Memory). 'wasm' needs bytes; 'webgpu' needs the two
      // shaders ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â a target missing its payload demotes to 'js'.
      agentTarget = resolveAgentTarget(msg.agentTarget, msg.agentWasmBytes, msg.agentWebgpuBehaviourShader, msg.agentWebgpuForceShader);
      pendingAgentWasmBytes = msg.agentWasmBytes ?? null;
      agentWasmViewerGuardIds = msg.agentWasmViewerGuardIds ?? [];
      pendingAgentLayoutExtras = msg.agentLayoutExtras ?? null;
      pendingAgentWasmLayoutSig = msg.agentWasmLayoutSig ?? null;
      pendingAgentWebgpuBehaviour = msg.agentWebgpuBehaviourShader ?? null;
      pendingAgentWebgpuForce = msg.agentWebgpuForceShader ?? null;
      pendingAgentWebgpuMaxAgents = msg.agentWebgpuMaxAgents ?? 0;
      pendingAgentWebgpuMaxHashBins = msg.agentWebgpuMaxHashBins ?? 0;
      pendingAgentWebgpuLayout = msg.agentWebgpuLayout ?? null;
      pendingAgentRenderLayout = msg.agentRenderLayout ?? null;
      pendingAgentWebgpuUsesI32Write = msg.agentWebgpuUsesI32Write ?? false;
      pendingAgentWebgpuUsage = msg.agentWebgpuUsage ?? {};
      pendingAgentWebgpuOmShaders = msg.agentWebgpuOmShaders ?? [];
      initAgents();
      compileAgentFns(msg.agentBehaviourCode, msg.agentInitCode, msg.agentDivisionCode, (msg as InitMsg).agentOutputMappingCodes);
      instantiateAgentWasmIfNeeded();
      buildAgentWebGPUIfNeeded();
      // (The Agent Init Event runs BELOW, after the cell Init Event ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â a
      // Create-Agent rule that reads the field must see the seeded substrate,
      // Decision D-FIELD ordering.)
      stopMessages = msg.stopMessages || [];
      webgpuStopCheckInterval = Math.max(1, Math.floor(msg.webgpuStopCheckInterval ?? 1));
      // Mutual exclusion safety net: a saved file or hand-edited JSON could
      // arrive with both flags true. The model-properties UI prevents this for
      // any live edit, but worker-side enforcement keeps legacy inputs sane.
      // WebGPU wins (it's the newer, opt-in target); WASM is silently demoted.
      // Agents-only (CA Grid off): never instantiate the LATTICE step targets ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â
      // the cell step never runs, and the compiler-side layout (which still
      // includes the model's neighbourhood tables) no longer matches the
      // worker's no-nbr layout, so instantiation would fail with a confusing
      // memory-size error.
      const wantWebGPU = !!msg.useWebGPU && gridCellsEnabled;
      const wantWasm = !wantWebGPU && !!msg.useWasm && gridCellsEnabled;
      if (msg.useWebGPU && msg.useWasm) {
        // eslint-disable-next-line no-console
        console.warn('[init] both useWebGPU and useWasm true ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â preferring WebGPU, ignoring WASM flag');
      }
      useWasm = wantWasm && !!msg.wasmStepBytes && !msg.wasmStepError;
      useWebGPU = wantWebGPU;
      if (gridCellsEnabled) tryInstantiateWasmModule(msg.wasmStepBytes, msg.wasmExports);
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
      // Cell Init Event runs ONCE per cell on first load too (not only on Reset),
      // so a model whose initial state is procedurally generated (e.g. a seeded
      // field, an orientation pattern) shows that state on load instead of a blank
      // default grid. Placed AFTER the compile-target resolution above (useWasm /
      // wasmInitFn / webgpuRuntime) so it dispatches the CORRECT target's init ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â
      // calling it earlier could fire a stale WASM init left over from a previous
      // model. initGrid() already applied the cell defaults, so the Init Event
      // seeds on top of them. An embedded simulationState still wins:
      // pendingSimStateRestore overwrites this after the first stepped message.
      // (WebGPU init is async ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â stepReady is false here ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â so runInit takes the
      // JS/WASM path; the WebGPU-ready handler uploads the seeded CPU attrs.)
      const loadHadInit = initFn !== null || (useWasm && wasmInitFn !== null) || gridInitFn !== null;
      runInit();
      // Grid Init Event — the GLOBAL seeding pass, AFTER the per-cell Init Event
      // (so a global seed is the final word). Writes the CPU/wasm attrs; the
      // colour-refresh + WebGPU-ready upload below carry the seeded state to GPU.
      runGridInit();
      // Generic Agent Platform: run the Agent Init Event ONCE on this fresh store
      // (after the fns are compiled), so graph-authored seeding (Create Agent /
      // Add Agent To World) lays down the initial population on first load too ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â
      // not only on Reset. initAgents() above laid the seedCount baseline first.
      // AFTER runInit() so an agent spawn rule that reads the cell field sees the
      // cell-Init-Event-seeded substrate (D-FIELD ordering).
      if (agentsEnabled) runAgentInit();
      // "Skip Isolated Empty Cells": populate the active set from the seeded grid.
      rebuildActiveSetFromGrid();
      // Recompute colors so the seeded state shows on load instead of the
      // defaults. Run ONLY the Output Mapping colour pass (never a step ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â that
      // would advance the generation on load) when the active viewer has one;
      // otherwise the default-colour fallback. WebGPU defers to its ready handler
      // (which uploads the seeded CPU attrs + dispatches its own colour pass).
      if (loadHadInit && !useWebGPU && outputMappingFns.some(f => f.mappingId === activeViewer)) {
        runColorPass();
      } else {
        writeDefaultColors();
      }
      sendColors();
      break;
    }

    case 'step': {
      stepAckId = msg.reqId;
      const webgpuActive = useWebGPU && webgpuRuntime?.stepReady;
      // Bond-Graph Agents: an agent model can step even with a trivial (or
      // absent) cell step ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the agent engine drives the generation.
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
        asyncStepBatchInFlight = true;   // P0: no message may interleave this batch
        (async () => {
          let stoppedByEvent: string | null = null;
          let lastFinalize: Promise<void> = Promise.resolve();
          // B4B: opt-in K-step skipping. With K=1 (default), check every step
          // ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â exact stop-event timing. With K>1, skip the readback on most
          // steps but ALWAYS check the last step of the batch so the user
          // sees any pending stop within this batch (otherwise the play loop
          // would advance past it).
          const k = Math.max(1, webgpuStopCheckInterval | 0);
          for (let i = 0; i < msg.count; i++) {
            // Bond-Graph Agents on a WebGPU grid (PR5 ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â independent targets,
            // C-D1). ONE generation = the closed agentÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬Âgrid loop, same ordering
            // as the JS/WASM branch (agents step BEFORE the cell step), but with
            // the field RESIDENCY bridge: under WebGPU the cell attrs are
            // GPU-resident after a step (gpuOwnsAttrs), so a field model must
            // pull them down before the agents gather, then push the agents'
            // deposit back up before the GPU cell step consumes it.
            //   field model:  GPUÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢CPU readback ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ runAgentStep (gather+deposit on
            //                  readAttrs) ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ CPUÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢GPU upload ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ runStepWebGPU.
            //   no-field model: just runAgentStep (writes only the agent SoA +
            //                  colors) ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ runStepWebGPU. ZERO readbacks.
            // The JS/WASM per-generation loop is left LITERALLY unchanged ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the
            // bridge lives ONLY here (the WebGPU branch is already async, so the
            // `await ensureCpuAttrsFresh()` fits; you cannot await in the sync
            // JS/WASM `for` loop). Two paths, never one.
            // GAP-2 (3D cost): readAttrs is now sized `total = W*H*D`, so for a
            // 3D-agent + WebGPU-grid FIELD model this readback + re-upload moves
            // DÃƒÆ’Ã¢â‚¬â€ more bytes PER STEP than the 2D case (the whole W*H*D field down
            // then up every generation). Field-heavy 3D-agent models pay a DÃƒÆ’Ã¢â‚¬â€
            // per-step residency tax on WebGPU ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â prefer JS/WASM agents there, or a
            // shallow depth, until a same-device zero-copy field lands (Phase F).
            if (agentStore && simulateAgents && webgpuRuntime && agentFieldBridgeGpuEligible()) {
              // E1b GPU field bridge: the field lives in the grid attrs (GPU). Copy it
              // into the agent field buffers, dispatch the agent gen on the GPU, fold the
              // deposit back into the grid attrs -- all GPU-side (no CPU round-trip).
              // gpuOwnsAttrs stays true; readAttrs (CPU) is left stale (getState pulls it).
              if (!gpuOwnsAttrs) { uploadAttrs(webgpuRuntime, readAttrs); gpuOwnsAttrs = true; }
              const bridge = buildGpuFieldBridge();   // re-resolve the LIVE attrsReadBuf each gen (ping-pong)
              const ranGpuBridge = bridge ? await runAgentStepWebGPU(bridge) : false;
              if (ranGpuBridge) {
                e1bGpuBridgeGenCount++;   // DEV probe
                // runAgentStep advances sprites; the GPU path doesn't, so do it here.
                if (hasAgentSprites && agentStore) advanceAgentSprites(agentStore);
              } else {
                e1bCpuBridgeFallbackCount++;   // DEV probe
                // GPU bailed (hash overflow / device failure) -> CPU field bridge this gen.
                if (agentUsesField && gpuOwnsAttrs) await ensureCpuAttrsFresh();
                runAgentStep();
                if (agentUsesField) { uploadAttrs(webgpuRuntime, readAttrs); gpuOwnsAttrs = false; }
              }
            } else if (agentStore && simulateAgents && agentDecoupledGpuAgents()) {
              // M4: a field-DECOUPLED grid+agents model on a WebGPU grid + a
              // WebGPU agent target used to fall through to the CPU runAgentStep()
              // below, silently ignoring the user's agent-target choice (E1b's
              // routing only covered the field-COUPLED case). Decoupled means the
              // two layers share no state, so the agent generation is just the
              // ordinary per-gen GPU agent step with no bridge - exactly what the
              // JS/WASM-grid branch already dispatches. On any GPU failure the
              // call returns false and JS runs that generation (the same bail-out
              // contract as every other GPU agent dispatch site).
              if (await runAgentStepWebGPU()) {
                m4DecoupledGpuGenCount++;   // DEV probe
                // runAgentStep advances sprites; the GPU path doesn't, so do it here.
                if (hasAgentSprites && agentStore) advanceAgentSprites(agentStore);
              } else {
                m4DecoupledCpuFallbackCount++;   // DEV probe
                runAgentStep();
              }
            } else if (agentStore && simulateAgents && webgpuRuntime) {
              if (agentUsesField && gpuOwnsAttrs) {
                await ensureCpuAttrsFresh();        // GPUÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢CPU; flips gpuOwnsAttrs=false
              }
              runAgentStep();                        // gather reads readAttrs (fresh); deposit writes readAttrs
              if (agentUsesField) {
                uploadAttrs(webgpuRuntime, readAttrs); // CPUÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢GPU, before the cell step
                gpuOwnsAttrs = false;
              }
            }
            // Agent Stop Event ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â CAPTURE before the cell step (runStepWebGPU resets +
            // finalizeStepWebGPU overwrites the shared flag from the GPU control
            // buffer), SURFACE after generation++.
            const agentStopIdx = (agentStore && simulateAgents) ? drainAgentStop() : 0;
            if (simulateCells && gridCellsEnabled) runStepWebGPU();      // Layers panel / agents-only: freeze the cell step
            // agents-only / frozen grid: the agent step IS the generation.
            else if (agentStore && simulateAgents) generation++;
            if (agentStopIdx !== 0) { stoppedByEvent = stopMessages[agentStopIdx - 1] ?? `Stop event #${agentStopIdx - 1}`; stopFlag[0] = 0; break; }
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
          // read the GPU colors buffer back ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â that's the canonical source.
          if (!msg.skipColorPass) runColorPassWebGPU();
          // L1 REGRESSION FIX (the "canvas turns black" report). `skipColorPass`
          // (unlimited gens/frame) is a throughput request aimed at the CPU display
          // pipeline — the main thread also skips its draw. But in FREE mode the
          // transferred voxel canvas IS the display and it renders the GPU colours
          // buffer, so skipping the colour pass left every present rendering the
          // frame the canvas was attached with: the volume froze at generation 0
          // while the simulation ran on (measured: 13 200 generations, 0 presents,
          // instance count pinned at its gen-0 value). A worker-side present is the
          // whole display here, so refresh + present ONCE PER BATCH (never per
          // generation): one colour-pass dispatch + one indirect draw per frame,
          // which is both cheap and strictly better than a frozen display.
          else if (voxelDisplayLive()) runColorPassWebGPU({ skipReductions: true });
          // E2 composite: the grid layer is composited into the shared canvas from
          // the GPU colorsBuf (grid-present pass) — so SKIP the per-gen colors
          // readback (the CPU win). sendColors ships no `colors` + does the composite
          // present (grid + agents). Else the two-canvas / readback path (unchanged).
          await finalizeStepWebGPU({ needColors: !agentCompositeActive && !msg.skipColorPass });
          sendColors();
          if (stoppedByEvent !== null) {
            self.postMessage({ type: 'stopEvent', message: stoppedByEvent, reqId: msg.reqId });
          }
        })().catch(e => {
          const m = (e instanceof Error) ? e.message : String(e);
          self.postMessage({ type: 'error', message: '[webgpu] step pipeline failed: ' + m });
        }).finally(endAsyncStepBatch);
        break;
      }

      // PR7 G3-runtime ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â JS/WASM grid + WebGPU agents (the Boids headline). The
      // agent step is ASYNC on the GPU (the readback awaits a mapAsync), which the
      // synchronous `for` loop below cannot await ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â so route to an async copy of
      // the batch loop here. The cell grid still steps synchronously (runStep,
      // not runStepWebGPU ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the grid target is JS/WASM in this branch). On any GPU
      // failure the agent step returns false and the JS runAgentStep() runs for
      // that step (so this stays correct even mid-batch).
      if (agentStore && agentTarget === 'webgpu' && agentWebgpuRuntime) {
        asyncStepBatchInFlight = true;   // P0: no message may interleave this batch
        (async () => {
          // PR7c: fully GPU-resident batch when the model qualifies — one queue
          // submit for ALL generations + one per-frame readback (no per-gen CPU
          // work). On any failure fall through to the per-generation path below.
          if (agentResidentEligible()) {
            // D: decoupled grid+agents — the agent batch runs resident (one submit)
            // and the grid runs its own JS/WASM per-gen steps. They share no state
            // (no field coupling), so the order is free; run the resident batch
            // FIRST (it advances nothing on failure) so a bailout falls through to
            // the per-gen loop cleanly with no double-stepped grid. Generation
            // counts ONCE per gen: the resident batch skips its own bump and the
            // cell-step loop does it (agents-only ⇒ gridSteps false ⇒ batch counts).
            const gridSteps = gridCellsEnabled && simulateCells && !!stepFn;
            const ok = await runAgentBatchResident(msg.count, !gridSteps);
            if (ok) {
              if (gridSteps) {
                for (let i = 0; i < msg.count; i++) runStep(true);
                // Deferred indicator scan (runStep used deferIndicatorScan): one
                // O(total) scan at the batch tail, identical to per-gen scanning
                // (only the last gen's values are observed).
                if (indicatorScanPending) {
                  if (linkedDefs.length > 0) computeLinkedIndicatorsFromBuffer();
                  if (hasSpatialIndicators) computeSpatialIndicators();
                  indicatorScanPending = false;
                }
                // Sparse-safe grid colour pass (only steps ran since the last pass).
                if (!msg.skipColorPass) runColorPass(true);
              }
              sendColors();
              return;
            }
          }
          let stoppedByEvent: string | null = null;
          for (let i = 0; i < msg.count; i++) {
            if (simulateAgents) {
              const ran = await runAgentStepWebGPU();
              if (!ran) runAgentStep();   // GPU bailed (hash overflow / failure) ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ JS this step
              // runAgentStep advances sprites itself; the GPU path doesn't, so do it here.
              else if (hasAgentSprites && agentStore) advanceAgentSprites(agentStore);
            }
            // Agent Stop Event ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â CAPTURE before the cell step (runStep resets the
            // shared flag), SURFACE after generation++.
            const agentStopIdx = (agentStore && simulateAgents) ? drainAgentStop() : 0;
            if (stepFn && simulateCells && gridCellsEnabled) runStep(true);
            // agents-only / frozen grid: the agent step IS the generation.
            else if (simulateAgents) generation++;
            if (agentStopIdx !== 0) { stoppedByEvent = stopMessages[agentStopIdx - 1] ?? `Stop event #${agentStopIdx - 1}`; stopFlag[0] = 0; break; }
            const rawStop = stopFlag[0] ?? 0;
            if (rawStop !== 0) {
              const idx = rawStop - 1;
              stoppedByEvent = stopMessages[idx] ?? `Stop event #${idx}`;
              stopFlag[0] = 0;
              break;
            }
          }
          // Deferred indicator scan (see runStep's deferIndicatorScan): one O(total)
          // scan at the batch tail instead of per generation — runs on the FINAL
          // post-batch state, identical to what per-gen scanning would have
          // shipped (only the last gen's values are ever observed).
          if (indicatorScanPending) {
            if (linkedDefs.length > 0) computeLinkedIndicatorsFromBuffer();
            if (hasSpatialIndicators) computeSpatialIndicators();
            indicatorScanPending = false;
          }
          // Post-step-batch colour pass: sparse-safe ("Skip Isolated Empty Cells") —
          // only steps ran since the last pass, so inactive cells' colours are
          // provably unchanged. Every other runColorPass call site stays FULL.
          if (stepFn && gridCellsEnabled && !msg.skipColorPass) runColorPass(true);
          sendColors();
          if (stoppedByEvent !== null) self.postMessage({ type: 'stopEvent', message: stoppedByEvent, reqId: msg.reqId });
        })().catch(e => {
          self.postMessage({ type: 'error', message: '[agents] WebGPU step batch failed: ' + ((e as Error)?.message || e) });
        }).finally(endAsyncStepBatch);
        break;
      }

      let stoppedByEvent: string | null = null;
      for (let i = 0; i < msg.count; i++) {
        // Bond-Graph Agents ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â one generation = the closed agentÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬Âgrid loop:
        //  (gather) agents SampleField the grid as of the previous cell step,
        //  (behave) run behaviourStep + integrate forces + the structural phase,
        //  (deposit) AffectCellsUnder / SecreteToField write the cell READ
        //   buffer ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â THEN the cell CA steps, incorporating the deposit (its
        //  w.set(r) copy carries it; a diffusion rule spreads it). So the agent
        //  step runs BEFORE the cell step (Decision D-FIELD: the field IS the
        //  lattice CA, only the scatter/gather bridge is new).
        // Layers panel (req 1): freeze either layer at runtime. Freezing agents
        // also stops their cell-field deposit (it lives inside runAgentStep).
        if (agentStore && simulateAgents) runAgentStep();
        // Agent Stop Event ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â CAPTURE it before the cell step (runStep resets the
        // shared flag at its top, which would clobber it), but SURFACE it after
        // generation++ so the paused generation matches the cell-stop semantics.
        const agentStopIdx = (agentStore && simulateAgents) ? drainAgentStop() : 0;
        if (stepFn && simulateCells && gridCellsEnabled) runStep(true);
        // generation++ lives inside the CELL step ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â when the cell step didn't
        // run (agents-only model, or the Layers panel froze the grid) an agent
        // step still IS a generation, or the counter sits at 0 forever.
        else if (agentStore && simulateAgents) generation++;
        if (agentStopIdx !== 0) { stoppedByEvent = stopMessages[agentStopIdx - 1] ?? `Stop event #${agentStopIdx - 1}`; stopFlag[0] = 0; break; }
        const rawStop = stopFlag[0] ?? 0;
        if (rawStop !== 0) {
          const idx = rawStop - 1;
          stoppedByEvent = stopMessages[idx] ?? `Stop event #${idx}`;
          stopFlag[0] = 0;
          break;
        }
      }
      // Deferred indicator scan (see runStep's deferIndicatorScan): one O(total)
      // scan at the batch tail instead of per generation — runs on the FINAL
      // post-batch state, identical to what per-gen scanning would have shipped.
      if (indicatorScanPending) {
        if (linkedDefs.length > 0) computeLinkedIndicatorsFromBuffer();
        if (hasSpatialIndicators) computeSpatialIndicators();
        indicatorScanPending = false;
      }
      // Post-step-batch colour pass: sparse-safe ("Skip Isolated Empty Cells") —
      // only steps ran since the last pass, so inactive cells' colours are
      // provably unchanged. Every other runColorPass call site stays FULL.
      if (stepFn && gridCellsEnabled && !msg.skipColorPass) runColorPass(true);
      sendColors();
      if (stoppedByEvent !== null) {
        self.postMessage({ type: 'stopEvent', message: stoppedByEvent, reqId: msg.reqId });
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
          // Patch only the painted cells ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the rest of the GPU buffer holds
          // evolved state we mustn't clobber with the stale CPU mirror.
          const idxs: number[] = [];
          for (const c of msg.cells) {
            const lyr = c.layer ?? 0;
            if (!inBounds3d(lyr, c.row, c.col)) continue;
            idxs.push(cellIndexOf(lyr, c.row, c.col));
          }
          patchWebGPUCells(idxs);
          uploadActiveViewer(webgpuRuntime, viewerIdMap[activeViewer] ?? -1);
          // gpuOwnsAttrs stays as-is ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â we only patched a few cells; the rest of
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
            // In sync mode the step copies rÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢w at the top of the next step,
            // but a paint that lands between steps must keep both buffers
            // consistent so InputColor / step compiled functions see the new
            // value through w_<id>[idx] reads as well. Async shares one buffer.
            if (isSync) writeAttrs[s.attrId]![idx] = s.value;
          }
        }

        // Display refresh ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â mirror of `paint` tail.
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

    case 'reset': {
      stepAckId = msg.reqId;
      activeViewer = msg.activeViewer; syncActiveViewerToMemory();
      resetGrid();
      // Bond-Graph Agents ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â Reset re-seeds the agent population (clear + re-seed
      // the configured initial count + the agent Init Event, PR-A3). Re-allocates
      // the store from the live config so a config edit (maxAgents/seedCount/ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦)
      // takes effect on Reset. The agent Init Event itself runs AFTER runInit()
      // below ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â a Create-Agent rule that reads the field must see the cell Init
      // Event's seeded substrate (D-FIELD ordering).
      if (agentsEnabled) { initAgents(); instantiateAgentWasmIfNeeded(); buildAgentWebGPUIfNeeded(); }
      // Init Event runs once per cell on Reset only (not on Load State).
      // When present, it modifies attrs in place AFTER defaults
      // have been applied and BEFORE the color pass / GPU upload.
      const webgpuReset = useWebGPU && webgpuRuntime?.stepReady;
      // Grid Init Event models bypass the GPU init pipeline (see runInit) — the
      // CPU is the init authority, and the !useGPUInit branch below uploads the
      // complete CPU state (per-cell init + the grid-init seed) to the GPU.
      const useGPUInit = !!(webgpuReset && webgpuRuntime?.initPipeline && !gridInitFn);
      const hadInit = initFn !== null || (useWasm && wasmInitFn !== null) || useGPUInit || gridInitFn !== null;
      // GPU init path: push the CPU defaults to GPU BEFORE dispatching init so
      // the init shader reads from a known-good attrsReadBuf. dispatchInit then
      // writes + swaps; the GPU owns the post-init state.
      if (useGPUInit && webgpuRuntime) {
        uploadAttrs(webgpuRuntime, readAttrs);
        if (orientationReadView) uploadOrientation(webgpuRuntime, orientationReadView);
      }
      runInit();
      // Grid Init Event — the GLOBAL seeding pass, AFTER the per-cell Init Event
      // (so a global seed is the final word). Writes CPU readAttrs; on WebGPU a
      // gridInit model always takes the CPU init path (useGPUInit is forced
      // false above), so the block below uploads the complete seeded state.
      runGridInit();
      // Agent Init Event + colour pass ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â after the cell Init Event (D-FIELD).
      if (agentsEnabled) { runAgentInit(); runAgentColorPass(); }
      // "Skip Isolated Empty Cells": rebuild the active set from the re-seeded grid.
      rebuildActiveSetFromGrid();
      if (hadInit) {
        // Init wrote to attrs after resetGrid's color refresh ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â recompute
        // colors so the user sees the post-init state, not the defaults.
        // WebGPU path skips this and recomputes via runColorPassWebGPU below.
        if (!(useWebGPU && webgpuRuntime?.stepReady)) refreshColorsAfterInputJS();
      }
      if (webgpuReset && webgpuRuntime) {
        // When the JS / WASM init ran (no GPU init pipeline), CPU readAttrs
        // holds the post-init state ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â push it to GPU. When the GPU init ran,
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
      compileFns(msg.stepCode, msg.inputColorCodes, (msg as RecompileMsg).outputMappingCodes || [], (msg as RecompileMsg).initCode || '', (msg as RecompileMsg).gridInitCode || '');
      // Dropped-table WebGPU model: a soft recompile keeps the (dropped) layout,
      // so if this graph edit ADDED a neighbour read to a CPU-executed function
      // (init / gridInit / OM / inputColor), that function would index a table
      // that isn't reserved. We can't reallocate here (the grid state must
      // survive a soft recompile) — surface a clear one-time error asking the
      // user to reload, which does a full reinit that rebuilds the table.
      if (nbrTableDropped && !nbrTableDroppedErrorPosted) {
        const rc = msg as RecompileMsg;
        const nowIndexesNbr =
          codeIndexesNeighbourTable(rc.initCode)
          || codeIndexesNeighbourTable(rc.gridInitCode)
          || (rc.outputMappingCodes ?? []).some(o => codeIndexesNeighbourTable(o.code))
          || (msg.inputColorCodes ?? []).some(ic => codeIndexesNeighbourTable(ic.code));
        if (nowIndexesNbr) {
          nbrTableDroppedErrorPosted = true;
          self.postMessage({
            type: 'error',
            message: 'This edit added a neighbour read to the Init / Grid Init / brush of a large WebGPU model whose per-cell neighbour table was dropped for memory. Reload the model to apply it.',
          });
        }
      }
      // "Skip Isolated Empty Cells": re-resolve from the (possibly changed) config
      // + rebuild from the CURRENT grid (a soft recompile keeps the grid state), so
      // the active-set params/args stay consistent with the just-recompiled step.
      sieConfig = (msg as RecompileMsg).skipIsolatedEmpty ?? null;
      setupActiveSet();
      recomputeSieIncremental();
      rebuildActiveSetFromGrid();
      // Bond-Graph Agents: recompile the agent behaviour fn (graph-only edit, no
      // reinit). The store + populations persist (a maxAgents/maxBonds change
      // forces a full reinit instead). Live force/bond params re-clamp ÃƒÅ½Ã¢â‚¬Ât.
      {
        const rc = msg as RecompileMsg;
        if (rc.centerBased) centerBasedConfig = rc.centerBased;
        if (rc.agentUsesField !== undefined) agentUsesField = !!rc.agentUsesField;
        if (rc.agentUsesDensity !== undefined) agentUsesDensity = !!rc.agentUsesDensity;
        if (rc.agentResidencyClean !== undefined) agentGraphResidencyClean = !!rc.agentResidencyClean;
        if (rc.agentColorViewer !== undefined) agentColorViewer = rc.agentColorViewer || '';
        if (rc.agentHasSprites !== undefined) hasAgentSprites = !!rc.agentHasSprites;
        compileAgentFns(rc.agentBehaviourCode, rc.agentInitCode, rc.agentDivisionCode, rc.agentOutputMappingCodes);
        // PR6b-1 / PR7: re-resolve the agent target + stash the per-target payload.
        // If the WASM backing requirement changes (JS/WebGPU ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬Â WASM, since wasm
        // needs the store on a WebAssembly.Memory), re-init the store so its arrays
        // sit on (or off) the memory; otherwise a graph-only edit keeps the
        // population. Then (re-)instantiate the WASM loop or (re-)build the WebGPU
        // runtime against the (possibly fresh) store. (JSÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬ÂWebGPU does NOT change
        // the backing ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the GPU has its own buffers ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â so the population persists.)
        const newTarget = resolveAgentTarget(rc.agentTarget, rc.agentWasmBytes, rc.agentWebgpuBehaviourShader, rc.agentWebgpuForceShader);
        pendingAgentWasmBytes = rc.agentWasmBytes ?? null;
        agentWasmViewerGuardIds = rc.agentWasmViewerGuardIds ?? [];
        pendingAgentLayoutExtras = rc.agentLayoutExtras ?? null;
        pendingAgentWasmLayoutSig = rc.agentWasmLayoutSig ?? null;
        pendingAgentWebgpuBehaviour = rc.agentWebgpuBehaviourShader ?? null;
        pendingAgentWebgpuForce = rc.agentWebgpuForceShader ?? null;
        pendingAgentWebgpuMaxAgents = rc.agentWebgpuMaxAgents ?? 0;
        pendingAgentWebgpuMaxHashBins = rc.agentWebgpuMaxHashBins ?? 0;
        pendingAgentWebgpuLayout = rc.agentWebgpuLayout ?? null;
        pendingAgentRenderLayout = rc.agentRenderLayout ?? null;
        pendingAgentWebgpuUsesI32Write = rc.agentWebgpuUsesI32Write ?? false;
        pendingAgentWebgpuUsage = rc.agentWebgpuUsage ?? {};
        pendingAgentWebgpuOmShaders = rc.agentWebgpuOmShaders ?? [];
        const backingChanged = (newTarget === 'wasm') !== (agentStore?.wasmBacked ?? false) && !agentWasmBackedDev;
        agentTarget = newTarget;
        if (agentsEnabled && backingChanged) { initAgents(); runAgentInit(); runAgentColorPass(); }
        instantiateAgentWasmIfNeeded();
        buildAgentWebGPUIfNeeded();
        clampAgentDt();
      }
      // Variegated Cells: re-fill the facePatternLookup + interaction-table
      // regions in wasmMemory. The regions themselves stay at the same
      // offsets (no reallocation ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â initGrid sized them at init time from the
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
      // Agents-only: skip the lattice WASM instantiate (see the init handler ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â
      // the compiler layout carries nbr tables the worker layout omits).
      if (gridCellsEnabled) tryInstantiateWasmModule((msg as RecompileMsg).wasmStepBytes, (msg as RecompileMsg).wasmExports);
      if ((msg as RecompileMsg).wasmStepError && gridCellsEnabled) {
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
        // forwarded the error regardless of target ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â which spammed users with
        // async-only-node errors while running on JS/WASM. Sender now skips
        // the compile when !useWebGPU; this guard is a belt-and-suspenders
        // defence against any stale message that still carries the field.
        self.postMessage({ type: 'error', message: '[webgpu] recompile failed: ' + recompile.webgpuShaderError });
      }
      self.postMessage({ type: 'ready' });
      break;
    }

    case 'setUseWasm': {
      // Agents-only: the lattice targets stay off (no cell step exists; the
      // lattice WASM module was never instantiated against this layout).
      const enableWasm = !!msg.enabled && gridCellsEnabled;
      // If the user just turned WASM on, drain GPU state to CPU before tearing
      // down the runtime ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â otherwise gpuOwnsAttrs CPU mirror is stale and the
      // first JS/WASM step runs against pre-Play data. Then enforce mutual
      // exclusion (WASM on ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ WebGPU off).
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
      // Agents-only: never bring up the lattice GPU runtime (its buffers would
      // be sized for a grid the model doesn't simulate).
      const enableWebGPU = !!msg.enabled && gridCellsEnabled;
      // Toggling WebGPU OFF: drain GPU ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ CPU AND mark the runtime's directRender
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
      self.postMessage({ type: 'useWebGPUStatus', enabled: useWebGPU, ready: webgpuRuntime?.stepReady ?? false, directRender: webgpuRuntime?.directRender ?? false, voxelRender: webgpuRuntime?.voxelRender ?? false });
      break;
    }

    case 'setRecording': {
      recording = !!msg.enabled;
      break;
    }

    case 'setSimLayers': {
      // Runtime per-layer freeze (Layers panel). Takes effect on the next step
      // batch; both default true so a never-sent message keeps current behaviour.
      simulateCells = !!msg.simulateCells;
      simulateAgents = !!msg.simulateAgents;
      break;
    }

    case 'setAgentSnapshotVelocity': {
      // Vision-cone display needs a per-agent heading; vx/vy are otherwise
      // gated on sprites. Takes effect on the next snapshot.
      agentSnapshotVelocity = !!msg.on;
      break;
    }

    case 'requestColorsSnapshot': {
      // One-shot colors readback for screenshot under WebGPU direct render.
      // Reads back the current GPU colors buffer and posts the bytes to the
      // main thread. Tag echoed back so the requester can match the response.
      const tag = msg.tag ?? '';
      const rt = webgpuRuntime;
      // L1: the voxel render leaves the CPU colours mirror stale exactly like 2D
      // direct render, so it needs the same one-shot readback before snapshotting.
      if (useWebGPU && rt?.stepReady && (rt.directRender || rt.voxelRender)) {
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
      // Declarative ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â replace the subscription set. Filter out-of-range
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
      // Main thread requests a fresh present pass ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â sent on visibility-return
      // and after a soft recompile completes. Under WebGPU direct render, the
      // OffscreenCanvas can land in an unpresented state after the recompile's
      // device-swap inside startWebGPUInit (unconfigure ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ configure with new
      // device ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ dispatch present), and the next compositor frame may show
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

    case 'attachVoxelCanvas': {
      // L1 — the 3D sibling of attachCanvas. The main thread transferred a
      // display-pixel-sized OffscreenCanvas once the grid WebGPU runtime was
      // ready; build the compaction + indirect-draw pipelines on it, apply the
      // last camera, present once, and ack. Any failure acks active:false and the
      // main thread keeps today's colours-readback + gl3d path.
      if (!webgpuRuntime || !webgpuRuntime.stepReady) {
        self.postMessage({ type: 'voxelRenderStatus', active: false, message: 'runtime not ready' });
        break;
      }
      {
        const rt = webgpuRuntime;
        void (async () => {
          try {
            const ok = await setupVoxelRender(rt, msg.canvas);
            // A newer runtime landed while the WGSL validated — the pipelines we
            // just built belong to a runtime nobody uses. Bail; the main thread
            // re-attaches on the newer runtime's useWebGPUStatus.
            if (!ok || webgpuRuntime !== rt) {
              if (webgpuRuntime !== rt) destroyVoxelRender(rt);
              self.postMessage({ type: 'voxelRenderStatus', active: false });
              return;
            }
            if (gridRenderView) uploadVoxelView(rt, gridRenderView);
            uploadVoxelViz(rt, gridViz3d);   // re-apply the scene-wireframe toggles
            presentVoxelsIfActive();
            // ACK the worker's ACTUAL `gridUiSync`. `gridUiSync` is a MODULE flag
            // that SURVIVES a re-attach (a display resize re-attaches on the SAME
            // worker), so the main thread must NOT assume the module default here
            // — assuming ON while the worker is OFF strands its mirror and its
            // `if (!posted)` guard then suppresses every later ON post (pause /
            // inspect / shadows / recording silently stop working, forever).
            self.postMessage({ type: 'voxelRenderStatus', active: true, uiSync: gridUiSync });
          } catch (e) {
            destroyVoxelRender(rt);
            self.postMessage({ type: 'voxelRenderStatus', active: false, message: (e as Error)?.message || String(e) });
          }
        })();
      }
      break;
    }

    case 'setGridCamera': {
      // Camera / lighting / clip uniform (orbit/pan/zoom/settings). Present-only:
      // re-present with the new view (the GPU colours buffer holds the last frame).
      gridRenderView = msg.view;
      if (webgpuRuntime?.voxelRender) {
        uploadVoxelView(webgpuRuntime, msg.view);
        presentVoxelsIfActive();
      }
      break;
    }

    case 'setGridViz': {
      // Which scene wireframes (bounds/grid/axes) the free-mode voxel render draws
      // (mirrors gl3d's Viz3D toggles). Present-only: re-present with the new set.
      gridViz3d = { axes: !!msg.axes, grid: !!msg.grid, bounds: !!msg.bounds };
      if (webgpuRuntime?.voxelRender) {
        uploadVoxelViz(webgpuRuntime, gridViz3d);
        presentVoxelsIfActive();
      }
      break;
    }

    case 'setGridUiSync': {
      // OFF: the voxel render owns the display, nothing crosses the wire.
      // ON: a consumer needs the CPU colours mirror (gl3d frame render + its pick
      // FBO, recording, inspect). Ship ONE colours frame immediately so a PAUSED
      // frame-mode gl3d has pixels straight away — a paused sim posts no step, so
      // without this the flip would show a blank/stale volume until the next Play.
      {
        const wasOff = !gridUiSync;
        gridUiSync = !!msg.on;
        const rt = webgpuRuntime;
        if (gridUiSync && wasOff && useWebGPU && rt?.stepReady && voxelRenderOn()) {
          asyncStepBatchInFlight = true;   // no message may interleave the readback
          // The flag MUST be cleared from a finally (audit H2): a throw with it set
          // would defer every later message with no replay — a silent dead-lock.
          void (async () => {
            try {
              await readbackColors(rt, colors);
              colorsDirty = true;
              sendColors();
            } finally { endAsyncStepBatch(); }
          })();
        }
      }
      break;
    }

    case '__voxelReadback': {
      // L1 DEV probe (verification only). Occlusion-safe proof of the compaction:
      // the instance count the GPU computed, read straight out of the indirect
      // draw args, plus the state a test needs to reproduce it CPU-side.
      void (async () => {
        try {
          const rt = webgpuRuntime;
          if (!rt || !rt.voxelRender) { self.postMessage({ type: '__voxelReadback', active: false }); return; }
          const r = await debugReadVoxelInstances(rt, msg.sample ?? 0);
          self.postMessage({
            type: '__voxelReadback', active: true, uiSync: gridUiSync, presents: voxelPresentCount,
            instanceCount: r?.instanceCount ?? -1, vertexCount: r?.vertexCount ?? -1,
            sample: r?.sample ?? [], total: rt.layout.total,
            gridW: rt.layout.gridWidth, gridH: rt.layout.gridHeight, gridD: rt.layout.gridDepth,
          });
        } catch (e) {
          self.postMessage({ type: '__voxelReadback', active: false, error: (e as Error)?.message || String(e) });
        }
      })();
      break;
    }

    case 'refreshGridDisplay': {
      // Tab-refocus / soft-recompile analogue of refreshDisplay for the voxel
      // canvas — re-present so a stale/unpresented canvas repaints.
      if (webgpuRuntime?.voxelRender) {
        if (gridRenderView) uploadVoxelView(webgpuRuntime, gridRenderView);
        uploadVoxelViz(webgpuRuntime, gridViz3d);
        presentVoxelsIfActive();
      }
      break;
    }

    case 'attachAgentCanvas': {
      // A1: the main thread transferred a display-pixel-sized OffscreenCanvas —
      // set up the agent render pipeline on the agent WebGPU runtime, present
      // once, and ack. Any failure acks active:false (main thread keeps the CPU
      // overlay path). Async setup (validates the WGSL module) via an IIFE.
      const s = agentStore;
      // webgpu target → render straight from the full compute runtime (A1); a CPU
      // (js/wasm) target → build a lightweight render-ONLY surface (A2) from the
      // shipped render layout. Either way present once + ack.
      if (!s || (!agentWebgpuRuntime && !pendingAgentRenderLayout)) {
        self.postMessage({ type: 'agentRenderStatus', active: false });
        break;
      }
      if (agentWebgpuRuntime && !agentWebgpuRuntime.ready) {
        self.postMessage({ type: 'agentRenderStatus', active: false });
        break;
      }
      void (async () => {
        try {
          let rt: AgentRenderSurface | null = agentWebgpuRuntime;
          if (!rt) {
            // A2 — CPU target: the three render buffers on the shared device.
            // Audit H3: REUSE an existing render-only surface when the shipped
            // layout still matches. A re-attach fires on every REAL display-size
            // change (once per frame while a panel splitter is dragged) and never
            // changes the layout, so building a new surface each time orphaned
            // three maxAgents-sized buffers AND a shared-device reference that
            // could never be released (the device became undestroyable). A
            // stale-layout surface is destroyed before the rebuild.
            const want = pendingAgentRenderLayout!;
            const prev = agentRenderRuntime;
            if (prev && prev.layout.maxAgents === want.maxAgents
                && (prev.layout.gridDepth ?? 1) === (want.gridDepth ?? 1)
                && prev.layout.f32Len === want.f32Len) {
              rt = prev;
            } else {
              if (prev) { destroyAgentRenderSurface(prev); agentRenderRuntime = null; }
              rt = await createAgentRenderOnlyRuntime(want);
              if (!rt) { self.postMessage({ type: 'agentRenderStatus', active: false }); return; }
            }
          }
          // E2: `composite` → the canvas is WORLD-sized and carries BOTH the
          // WebGPU grid layer AND the agent discs (one encoder). Requires the grid
          // runtime on the SAME shared device (E1) — assert before enabling.
          const wantComposite = !!msg.composite
            && !!webgpuRuntime && !!webgpuRuntime.colorsBuf
            && rt.device === webgpuRuntime.device;
          const ok = wantComposite
            ? await setupAgentCompositeRender(rt, msg.canvas)
            : await setupAgentDirectRender(rt, msg.canvas);
          if (!ok) {
            // A render-only surface (possibly the REUSED one) is torn down here —
            // clear the module ref too so a later attach can't hand out a destroyed
            // surface (audit H3's reuse path).
            if (rt !== agentWebgpuRuntime) {
              destroyAgentRenderSurface(rt);
              if (agentRenderRuntime === rt) agentRenderRuntime = null;
            }
            self.postMessage({ type: 'agentRenderStatus', active: false });
            return;
          }
          if (rt !== agentWebgpuRuntime) agentRenderRuntime = rt;
          agentRenderActive = true;
          agentCompositeActive = wantComposite;
          // A canvas re-attach (display resize / pane refocus) does NOT rebuild the
          // compute runtime, so if a free-mode resident batch left the CPU store
          // stale the GPU is still authoritative. Force-clearing the stale flag here
          // (the old code) LIED that the CPU was fresh, so the present below then
          // uploaded the stale store and REVERTED the sim (the Particle-Life
          // "brush-remove then it jumps back" bug). Instead read the GPU state down
          // if stale (a no-op on a fresh/rebuilt runtime or a CPU target, where the
          // CPU is genuinely authoritative), so the CPU is truly fresh before the
          // present uploads it — an identity upload, no revert.
          await ensureAgentStoreFresh();
          if (agentRenderView) applyAgentRenderView(rt, agentRenderView);
          presentAgentsIfActive();
          // ACK the worker's ACTUAL `agentUiSync` — same rule as the voxel ack
          // above: the module flag survives a re-attach on the SAME worker, so the
          // main thread mirrors what the worker reports instead of assuming ON.
          self.postMessage({ type: 'agentRenderStatus', active: true, composite: agentCompositeActive, uiSync: agentUiSync });
        } catch (e) {
          agentRenderActive = false;
          self.postMessage({ type: 'agentRenderStatus', active: false, message: (e as Error)?.message || String(e) });
        }
      })();
      break;
    }

    case 'setAgentCamera': {
      // Camera / tiling / graphics uniform (pan/zoom/resize/settings). Present-
      // only: re-present with the new view (the GPU buffers hold the last frame).
      agentRenderView = msg.view;
      {
        const rt = activeRenderSurface();
        if (agentRenderActive && rt) {
          applyAgentRenderView(rt, msg.view);
          // Present now only when idle — a batch in flight is deferred (won't reach
          // here); a per-gen/mutation present covers the running case via sendColors.
          // FromStore (upload fields/colours, then present), NOT a raw present:
          // at load the only prior upload can be the attach-time present made
          // BEFORE seeding/colouring settled, so a raw camera present could show
          // an empty/stale frame. Camera posts are rAF-coalesced + deduped
          // main-side, so the extra upload cost is one-shot.
          if (!agentStoreStale) presentAgentsIfActive();
          else presentAgentsOnce(rt, agentStore ? agentStore.highWater : 0);
        }
      }
      break;
    }

    case 'setAgentUiSync': {
      // While ON the resident batch reads back + ships the snapshot each frame
      // (features need CPU state). Turning it ON when the store is stale pulls
      // state down once so the next snapshot is fresh.
      const wasOff = !agentUiSync;
      agentUiSync = !!msg.on;
      if (agentUiSync && wasOff && agentStore) {
        // OFF→ON: a consumer now needs live CPU agent state. Pull the GPU state
        // down (if a free-mode resident batch left it stale) AND ship ONE snapshot,
        // so a paused frame-mode renderer — the Phase C 3D gl3d full render, which
        // draws/picks agents from the snapshot, not the sphere canvas — has fresh
        // agents immediately (a paused sim ships no step, hence no snapshot without
        // this). Free mode (uiSync off) ships no snapshot, so nothing to undo.
        asyncStepBatchInFlight = true;
        // try/finally is MANDATORY (audit H2): sendColors() does real work that can
        // throw (typed-array slicing at capacity, a postMessage transfer-list
        // DataCloneError, an OM colour-pass edge case). Without the finally the
        // in-flight flag would stay set forever and the dispatcher's guard would
        // defer EVERY subsequent message with no replay — the simulator freezes
        // with no error surfaced.
        void (async () => {
          try { await ensureAgentStoreFresh(); sendColors(); }
          finally { endAsyncStepBatch(); }
        })();
      }
      break;
    }

    case 'refreshAgentDisplay': {
      // Tab-refocus / soft-recompile analogue of refreshDisplay — re-present the
      // agent frame so a stale/unpresented canvas repaints.
      {
        const rt = activeRenderSurface();
        if (agentRenderActive && rt && agentStore) {
          if (agentRenderView) applyAgentRenderView(rt, agentRenderView);
          presentAgentsIfActive();
        }
      }
      break;
    }

    case 'readbackWebGPU': {
      if (!webgpuRuntime?.stepReady) {
        self.postMessage({ type: 'webgpuReadback', ready: false, attrs: {}, reason: 'stepReady false' });
        break;
      }
      // Async ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â copies attrsRead from GPU into the existing readAttrs typed
      // arrays, then posts a snapshot back. Used by the parity-test harness.
      readbackAttrs(webgpuRuntime, readAttrs).then(() => {
        const snapshot: Record<string, { type: string; data: number[] }> = {};
        for (const a of cellAttrs) {
          const arr = readAttrs[a.id]!;
          // Cap to 100 entries in the message ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â full grids would blow up
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
      // "Skip Isolated Empty Cells": model attrs are legitimate Output-Mapping
      // inputs — inactive cells' colours may need recomputing, so the next
      // colour pass must run FULL (matches full-loop behaviour, where the next
      // pass repaints every cell with the new value).
      sieColorDirtyAll = true;
      // Mirror the change into the GPU uniform buffer so the next step shader
      // sees the updated values (without this, WebGPU silently runs against
      // the stale modelAttrs frozen at init time).
      if (webgpuRuntime?.stepReady) {
        uploadModelAttrs(webgpuRuntime, cachedModelAttrs as Record<string, number>);
      }
      break;
    }

    case 'updateLookupTable': {
      // "Skip Isolated Empty Cells": lookup tables are Output-Mapping inputs too
      // — force the next colour pass full (see updateModelAttrs).
      sieColorDirtyAll = true;
      // Live-tune a single Lookup Table model attribute. The cached Float64Array
      // is a typed-array view over `wasmMemory` at the layout's reserved offset
      // (see initVariegation), so we must COPY into the existing view ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â never
      // reassign the JS reference ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â or WASM would lose its source of truth (it
      // reads via baked offsets, not the JS ref).
      const normalized = normalizeLookupTablePayload(msg);
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
      // O5 ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â refresh the GPU reduction plan whenever watched/linked status
      // changes. Cheap (no buffer reallocation when the plan is unchanged at
      // setupReductionPipelines's level ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â though the function does rebuild
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
      // Apply the input-colour mapping to a single cell from pixel slot `pi`.
      const applyImageCell = (idx: number, pi: number) => {
        const r = pixels[pi]!, g = pixels[pi + 1]!, b = pixels[pi + 2]!;
        if (wasmIcFn) {
          wasmIcFn(idx, r, g, b);
          if (isSync) for (const attr of cellAttrs) readAttrs[attr.id]![idx] = writeAttrs[attr.id]![idx]!;
        } else if (icEntry?.fn) {
          icEntry.fn(r, g, b, ...buildCellArgs(idx));
          for (const attr of cellAttrs) readAttrs[attr.id]![idx] = writeAttrs[attr.id]![idx]!;
        }
      };
      const webgpuImport = useWebGPU && webgpuRuntime?.stepReady;
      const runApply = () => {
        const regionIdxs: number[] = [];
        if (msg.region) {
          // Paste-centered: write only the sub-region; cells outside are preserved.
          const { row, col, w: rw, h: rh } = msg.region;
          for (let rr = 0; rr < rh; rr++) {
            const gr = row + rr;
            if (gr < 0 || gr >= height) continue;
            for (let cc = 0; cc < rw; cc++) {
              const gc = col + cc;
              if (gc < 0 || gc >= width) continue;
              const gi = gr * width + gc;
              applyImageCell(gi, (rr * rw + cc) * 4);
              regionIdxs.push(gi);
            }
          }
        } else {
          for (let idx = 0; idx < total; idx++) applyImageCell(idx, idx * 4);
        }
        // Update display.
        if (webgpuImport && webgpuRuntime) {
          if (msg.region) {
            // Patch ONLY the pasted cells so the evolved (GPU-resident) cells outside
            // the region are preserved ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â a full uploadAttrs would clobber them with a
            // stale CPU mirror after a Play (mirrors the paint / writeRegion handlers).
            patchWebGPUCells(regionIdxs);
          } else {
            uploadAttrs(webgpuRuntime, readAttrs);
            gpuOwnsAttrs = false;
          }
          uploadActiveViewer(webgpuRuntime, viewerIdMap[activeViewer] ?? -1);
          refreshColorsAfterInputWebGPU();
          finalizeStepWebGPU({ needColors: true }).then(() => sendColors())
            .catch(e => self.postMessage({ type: 'error', message: '[webgpu] importImage colorPass failed: ' + ((e instanceof Error) ? e.message : String(e)) }));
          return;
        }
        refreshColorsAfterInputJS();
        sendColors();
      };
      // Paste-centered under WebGPU after a Play: the CPU mirror is stale
      // (gpuOwnsAttrs), so a ColourÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢Attribute mapping that READS an existing cell
      // attribute would sample stale state. Read the GPU attrs back to CPU first
      // (mirrors the paint / paintManual handlers), then apply. The full-grid
      // import overwrites every cell so it never needs this.
      if (msg.region && webgpuImport && webgpuRuntime && gpuOwnsAttrs && icEntry?.fn) {
        readbackAttrs(webgpuRuntime, readAttrs).then(() => { gpuOwnsAttrs = false; runApply(); })
          .catch(e => self.postMessage({ type: 'error', message: '[webgpu] importImage readback failed: ' + ((e instanceof Error) ? e.message : String(e)) }));
      } else {
        runApply();
      }
      break;
    }

    case 'importGridValues': {
      // CSV import (grid flavour): a row-major block of PER-CELL values into one
      // cell attribute. Mirrors the paintManual write discipline (sync keeps BOTH
      // buffers consistent so a step / InputColor between mutations reads the new
      // value through w_<id>) + the importImage display tail.
      activeViewer = msg.activeViewer; syncActiveViewerToMemory();
      const dst = readAttrs[msg.attrId];
      if (!dst) break;
      const isSync = updateMode !== 'asynchronous';
      const lyr = Math.max(0, Math.min(depth - 1, Math.round(msg.layer ?? 0)));
      const bw = msg.width | 0, bh = msg.height | 0;
      const vals = msg.values;
      const applyValues = () => {
        const wbuf = isSync ? writeAttrs[msg.attrId] : null;
        for (let r = 0; r < bh; r++) {
          if (r >= height) break;
          for (let c = 0; c < bw; c++) {
            if (c >= width) break;
            const v = vals[r * bw + c]!;
            const idx = cellIndexOf(lyr, r, c);
            dst[idx] = v;
            if (wbuf) wbuf[idx] = v;
          }
        }
        const webgpuGrid = useWebGPU && webgpuRuntime?.stepReady;
        if (webgpuGrid && webgpuRuntime) {
          // The CPU mirror is authoritative for every attribute at this point
          // (a stale one was read back below), so a full upload is safe and
          // simpler than a per-cell patch over a whole block.
          uploadAttrs(webgpuRuntime, readAttrs);
          gpuOwnsAttrs = false;
          uploadActiveViewer(webgpuRuntime, viewerIdMap[activeViewer] ?? -1);
          refreshColorsAfterInputWebGPU();
          finalizeStepWebGPU({ needColors: true }).then(() => sendColors())
            .catch(e => self.postMessage({ type: 'error', message: '[webgpu] importGridValues colorPass failed: ' + ((e instanceof Error) ? e.message : String(e)) }));
          return;
        }
        refreshColorsAfterInputJS();
        sendColors();
      };
      // After a Play under WebGPU the live state lives on the GPU and the CPU
      // mirror is stale — a partial write + uploadAttrs would push that stale
      // mirror (of the OTHER attributes, and of the cells this block does not
      // cover) back onto the GPU. Pull it down once first.
      if (useWebGPU && webgpuRuntime?.stepReady && gpuOwnsAttrs) {
        const rt = webgpuRuntime;
        readbackAttrs(rt, readAttrs).then(() => { gpuOwnsAttrs = false; applyValues(); })
          .catch(e => self.postMessage({ type: 'error', message: '[webgpu] importGridValues readback failed: ' + ((e instanceof Error) ? e.message : String(e)) }));
        break;
      }
      applyValues();
      break;
    }

    case 'colorPass': {
      activeViewer = msg.activeViewer; syncActiveViewerToMemory();
      // Agent Output Mappings: switch the active AGENT viewer too (independent of
      // the cell viewer). sendColors() below recolours agents from it.
      { const aav = (msg as { activeAgentViewer?: string }).activeAgentViewer; if (aav !== undefined) agentColorViewer = aav; }
      // A1.5 — point the GPU OM colour pass at the new viewer so the next resident
      // batch (or a mutation present) recolours from it. The immediate paused
      // present goes through the CPU s.colors path (runAgentColorPass in sendColors).
      if (agentWebgpuRuntime) agentWebgpuRuntime.activeOmMappingId = agentColorViewer;
      const webgpuCp = useWebGPU && webgpuRuntime?.stepReady;
      if (webgpuCp && webgpuRuntime) {
        uploadActiveViewer(webgpuRuntime, viewerIdMap[activeViewer] ?? -1);
        // For no-OM viewers (e.g. MNCA's "Case Colored") refreshColorsAfterInputWebGPU
        // falls back to a step shader dispatch so SetColorViewer-in-step writes land
        // in the colors buffer before the present pass blits ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â otherwise the canvas
        // freezes on the previous viewer's pixels.
        refreshColorsAfterInputWebGPU();
        finalizeStepWebGPU({ needColors: true }).then(() => sendColors())
          .catch(e => self.postMessage({ type: 'error', message: '[webgpu] colorPass failed: ' + ((e instanceof Error) ? e.message : String(e)) }));
        break;
      }
      // JS fallback: pull GPU ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ CPU first if a stale runtime is hanging around
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
        const ids = seedAgents(agentStore, msg.agents.map(a => ({ x: a.x, y: a.y, z: a.z, radius: a.radius, lineage: a.lineage })), dr);
        if (ids.length < msg.agents.length) {
          self.postMessage({ type: 'agentOverflow', message: `Agent capacity reached (maxAgents=${agentStore.maxAgents}). ${msg.agents.length - ids.length} agent(s) not created.` });
        }
        // PR3 seed config: write the per-attribute initial values onto each new
        // agent (read + write buffers ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â single-buffer, so they alias, but mirror
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
          initAgentSlot(agentStore, id, msg.x, msg.y, msg.z ?? 0, msg.radius ?? cbNum(centerBasedConfig, 'defaultRadius'), id);
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
        const s = agentStore, W = s.worldWidth, H = s.worldHeight, D = s.worldDepth, torus = !!msg.torus;
        const g = msg.geom;
        for (const id of msg.ids) {
          if (id < 0 || id >= s.highWater || !s.alive[id]) continue;
          if (msg.sets && msg.sets.length > 0) applyAgentSets(s, id, msg.sets);
          if (g) {
            if (g.radius !== undefined) { s.radius[id] = g.radius; s.targetRadius[id] = g.radius; }
            if (g.vx !== undefined) s.vx[id] = g.vx;
            if (g.vy !== undefined) s.vy[id] = g.vy;
            if (g.vz !== undefined && D > 1) s.vz[id] = g.vz;
            if (g.x !== undefined) { let x = g.x; x = torus ? ((x % W) + W) % W : Math.max(0, Math.min(W, x)); s.x[id] = x; s.xNext[id] = x; }
            if (g.y !== undefined) { let y = g.y; y = torus ? ((y % H) + H) % H : Math.max(0, Math.min(H, y)); s.y[id] = y; s.yNext[id] = y; }
            if (g.z !== undefined && D > 1) { let z = g.z; z = torus ? ((z % D) + D) % D : Math.max(0, Math.min(D, z)); s.z[id] = z; s.zNext[id] = z; }
          }
        }
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
    case 'readAgents': {
      // Agent clipboard COPY: one batched read of the requested agents' spec.
      // Attribute values are the RAW SoA numbers (paste feeds them back through
      // applyAgentSets unchanged). Dead/out-of-range ids are skipped.
      const out: Array<{ x: number; y: number; z?: number; radius: number; vx: number; vy: number; vz?: number; attrs: Record<string, number> }> = [];
      if (agentStore) {
        const s = agentStore, is3d = s.worldDepth > 1;
        for (const id of msg.ids) {
          if (id < 0 || id >= s.highWater || !s.alive[id]) continue;
          const attrs: Record<string, number> = {};
          for (const spec of s.attrSpecs) { const a = s.attrRead[spec.id]; if (a) attrs[spec.id] = a[id]!; }
          out.push({
            x: s.x[id]!, y: s.y[id]!, z: is3d ? s.z[id]! : undefined,
            radius: s.radius[id]!, vx: s.vx[id]!, vy: s.vy[id]!, vz: is3d ? s.vz[id]! : undefined,
            attrs,
          });
        }
      }
      self.postMessage({ type: 'agentsRead', agents: out });
      break;
    }
    case 'pasteAgents': {
      // Agent clipboard PASTE: per-agent specs (position/radius/velocity/attrs).
      // Composes the engine primitives (allocAgentSlot/initAgentSlot/
      // applyAgentSets) — the compiled-fn ABI / SoA layout is untouched.
      activeViewer = msg.activeViewer; syncActiveViewerToMemory();
      if (agentStore) {
        const s = agentStore, W = s.worldWidth, H = s.worldHeight, D = s.worldDepth, torus = !!msg.torus;
        const dr = cbNum(centerBasedConfig, 'defaultRadius');
        let dropped = 0;
        for (const a of msg.agents) {
          const id = allocAgentSlot(s);
          if (id < 0) { dropped++; continue; }
          const x = torus ? ((a.x % W) + W) % W : Math.max(0, Math.min(W, a.x));
          const y = torus ? ((a.y % H) + H) % H : Math.max(0, Math.min(H, a.y));
          let z = a.z ?? 0;
          if (D > 1) z = torus ? ((z % D) + D) % D : Math.max(0, Math.min(D, z));
          initAgentSlot(s, id, x, y, z, a.radius ?? dr, id);
          if (a.vx !== undefined) s.vx[id] = a.vx;
          if (a.vy !== undefined) s.vy[id] = a.vy;
          if (a.vz !== undefined && D > 1) s.vz[id] = a.vz;
          if (a.sets && a.sets.length > 0) applyAgentSets(s, id, a.sets);
        }
        if (dropped > 0) {
          self.postMessage({ type: 'agentOverflow', message: `Agent capacity reached (maxAgents=${s.maxAgents}). ${dropped} agent(s) not pasted.` });
        }
        runAgentColorPass();
      }
      sendColors();
      break;
    }
    case '__setAgentWasmBacked': {
      // AW-MEM (PR6a) DEV proof: toggle the WebAssembly.Memory backing and
      // re-init agents (re-runs init/seed ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ fresh deterministic state). The
      // caller then steps + getStates to compare bit-for-bit against the
      // plain-array backing. No-op in production (never sent).
      agentWasmBackedDev = !!msg.wasmBacked;
      if (agentsEnabled) { initAgents(); instantiateAgentWasmIfNeeded(); buildAgentWebGPUIfNeeded(); runAgentInit(); runAgentColorPass(); }
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
      // On-demand single-agent inspector read. NOT a fattened render snapshot ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â
      // one tiny round-trip per inspect click (per Ãƒâ€šÃ‚Â§3 gotcha #7). A non-live id
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
        radius: s.radius[id]!, lineage: s.lineage[id]!,
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
          // ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ the always-0 z arm stays untouched, byte-identical to before).
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
      // rejects a duplicate via hasBond internally) ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â re-batching the same pair
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

    case 'setRngSeed': {
      // Supported message (the Overseer's "Set Random Seed" / seed policy +
      // the PR6b-2 bit-parity test): force the shared xorshift32 seed so a
      // run is reproducible.
      rngState[0] = ((msg as { seed?: number }).seed ?? 0x12345678) >>> 0 || 0x12345678;
      // The WASM step/init read the RNG from the in-memory cell (a view synced
      // from rngState[0] only at initGrid) — write it too, or seeding is a
      // silent no-op on the WASM target (the bug the Overseer E2E caught:
      // an identical seed policy gave different WASM replicate statistics).
      if (wasmMemory && wasmLayout) {
        new Uint32Array(wasmMemory.buffer, wasmLayout.rngStateOffset, 1)[0] = rngState[0]!;
      }
      // WebGPU: re-derive the per-cell PCG streams from the new global seed
      // (statistical reproducibility — the documented per-target RNG stance).
      if (useWebGPU && webgpuRuntime?.stepReady) {
        seedRngState(webgpuRuntime, rngState[0]!);
      }
      break;
    }

    case '__e1bCounters': {
      // E1b DEV probe (verification only) — report GPU-vs-CPU field-bridge gen
      // counts + whether the model is currently GPU-field-bridge eligible.
      self.postMessage({
        type: '__e1bCounters',
        gpuBridge: e1bGpuBridgeGenCount,
        cpuFallback: e1bCpuBridgeFallbackCount,
        eligible: agentFieldBridgeGpuEligible(),
        useWebGPU, agentTarget,
        sharedDevice: !!(agentWebgpuRuntime && webgpuRuntime && agentWebgpuRuntime.device === webgpuRuntime.device),
        fieldSpecTypes: fieldSpecs.map(s => s.type),
        // E1 leak metric (audit L4) + the H3 re-attach evidence: adapterRequests
        // stays 1 for the worker's lifetime and refCount stays balanced (it must
        // NOT grow with re-attaches now that a matching render-only surface is
        // reused instead of rebuilt).
        gpuRefCount: sharedGpuRefCount(),
        gpuAdapterRequests: sharedGpuAdapterRequestCount(),
        hasRenderOnlySurface: !!agentRenderRuntime,
        // M4 routing probe: on a WebGPU GRID, did a field-DECOUPLED model's agents
        // dispatch on the GPU (m4Gpu) or fall back to the CPU step (m4Cpu)?
        m4Gpu: m4DecoupledGpuGenCount,
        m4Cpu: m4DecoupledCpuFallbackCount,
        m4Eligible: agentDecoupledGpuAgents(),
        agentRuntimeReady: !!agentWebgpuRuntime?.ready,
        residentEligible: agentResidentEligible(),
        agentGpuUploadPending,
      });
      break;
    }

    case '__compositeReadback': {
      // E2 DEV probe (verification only): present the composite + read pixels back
      // at the given DISPLAY-pixel points → proves grid + agents land on ONE texture.
      void (async () => {
        try {
          const rt = activeRenderSurface();
          if (!agentCompositeActive || !rt || !agentStore || !webgpuRuntime?.colorsBuf) {
            self.postMessage({ type: '__compositeReadback', pixels: null, composite: agentCompositeActive });
            return;
          }
          const v = agentRenderView as { showGrid?: boolean; showAgents?: boolean; scalePx?: number; oxPx?: number; oyPx?: number; torus?: boolean } | null;
          const px = await debugReadCompositePixels(rt, webgpuRuntime.colorsBuf, webgpuRuntime.layout.gridWidth, webgpuRuntime.layout.gridHeight, agentStore, v?.showGrid !== false, v?.showAgents !== false, v?.scalePx ?? 1, v?.oxPx ?? 0, v?.oyPx ?? 0, !!v?.torus, msg.points);
          self.postMessage({ type: '__compositeReadback', pixels: px, composite: true });
        } catch (e) {
          self.postMessage({ type: '__compositeReadback', pixels: null, error: (e as Error)?.message || String(e) });
        }
      })();
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
        // CPU `colors` mirror is stale (no per-step readback) ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â pull it too
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
      // State files restore the grid configuration, NOT the run history ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â
      // generation counter and indicator values reset to their init defaults
      // so the user can start fresh from a saved starting position.
      generation = 0;
      resetIndicators();
      linkedAccumulators = {};
      linkedResults = {};
      activeViewer = msg.activeViewer; syncActiveViewerToMemory();

      // Restore cell attribute arrays ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â COPY INTO the existing views over WASM
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
      colorsDirty = true;

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

      // Restore order array ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â COPY INTO the existing view rather than
      // replacing the reference. The initial `orderArray` is a typed-array
      // view over `wasmMemory` at `wasmLayout.orderOffset` (see initGrid).
      // Replacing the reference orphans WASM (which reads the order via the
      // baked-in offset, not via the JS reference): the per-step shuffle then
      // writes to the standalone array while WASM keeps reading the original
      // view's stale contents. Under random-order async this freezes cell
      // iteration into the init-time sequential [0,1,2,...] order ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the
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

      // Rebuild neighbor indices for constant boundary sentinel (skip when the
      // CA grid is off ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â no cell step uses them).
      if (gridCellsEnabled) buildNeighborIndices();
      // "Skip Isolated Empty Cells": rebuild the active set from the restored grid.
      rebuildActiveSetFromGrid();

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
      } else if (agentStore) {
        // The state file carries no agent payload (pre-agents save, or saved from
        // a non-agent model): re-seed the agent layer to its starting
        // configuration instead of silently keeping the pre-load population ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â
        // a loaded state is a starting configuration, and mixing the old run's
        // agents with the restored grid is neither.
        initAgents(); instantiateAgentWasmIfNeeded(); buildAgentWebGPUIfNeeded();
        runAgentInit(); runAgentColorPass();
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
        // stale GPU colors to main thread. Mirrors reset / paint.
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
      // Cells outside [0, width) ÃƒÆ’Ã¢â‚¬â€ [0, height) are replaced by the attribute's default value.
      // Under WebGPU after Play, `gpuOwnsAttrs` is true and the CPU mirror is
      // stale ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â pull it back before reading or Ctrl+C / Ctrl+X copy pre-Play
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
      // 3D Grid CA: the 2D stamp lands on layer `msg.layer` (absent ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ 0).
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
      // JS / WASM fallback ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â without the runStep fallback for no-OM viewers,
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
      const cLayer = msg.layer ?? 0;   // 3D Grid CA: target layer (absent ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ 0)
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
      // JS / WASM fallback ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â same shape as writeRegion above. No-OM viewers
      // rely on the step shader to repaint colors.
      refreshColorsAfterInputJS();
      sendColors();
      break;
    }
  }
};

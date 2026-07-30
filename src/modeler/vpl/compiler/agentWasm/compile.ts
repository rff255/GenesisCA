// ===========================================================================
// The SEPARATE WASM AGENT-LOOP compiler — FULL agent-node coverage.
//
// A self-contained agent-WASM compiler whose per-agent behaviour loop runs
// directly against the wasmBacked AgentStore memory (PR6a — the AgentStore SoA
// laid out on a single WebAssembly.Memory at the offsets `computeAgentMemoryLayout`
// bakes). PR6b-1 proved the architecture on a deterministic drift/spring model;
// PR6b-2 widened it to Boids; the whole-target port took it to FULL coverage.
//
// SCOPE (full coverage — the WHOLE agent-graph catalogue runs on WASM with JS
// BIT-PARITY, the f64 gold standard):
//   field bridge       : sampleField / fieldGradient / readCellsUnder /
//                        affectCellsUnder / secreteToField — 2D bilinear AND
//                        3D trilinear / r-sphere, torus-folded, matching the
//                        JS emitters bit-for-bit
//   agent-array tier   : getNearbyAgents / getBondedAgents / getAgentsAttribute /
//                        filterAgents / joinAgents / pickRandomAgent /
//                        pickNRandomAgents + aggregate / groupOperator /
//                        groupCounting / groupStatement over id arrays
//   structural writes  : divideAgent / formBond / breakBond / killAgent
//                        (request-flag stores; the CPU structural phase mutates)
//   setters            : setVelocity / setAgentAttribute / setAgentsAttribute /
//                        setAgentPosition / setAgentRadius
//   universal nodes    : switch / loop / valueSwitch / indicators (ALL ops —
//                        the agent loop is sequential) / lookup tables /
//                        colour nodes / setCellLooks (plain) / …
//   local variables    : scalar AND array (getVariable / setVariable /
//                        setArrayElement)
// The ONLY clamp to JS is the getNearbyAgents scratch-slot capacity budget
// (> AGENT_NEARBY_SCRATCH_SLOTS simultaneous producers) — a capacity gate, not
// a node ban; `isAgentGraphWasmSupported(model)` is the honest central gate.
// The `divisionEvent` + `agentInit` roots stay JS-on-CPU (target-independent —
// they run over the SAME wasmBacked memory, bit-exact).
//
// HARD CONSTRAINT: this compiler does NOT touch the lattice WASM compiler bytes.
// It REUSES the pure binary ENCODER (../wasm/encoder.ts) + the stateful
// `WasmEmitter` (../wasm/emitter.ts) + the Expression AST emitter
// (../expression/emitWasm.ts) — all byte-stable, importable abstractions — but
// emits its own self-contained module. The front-end (macro-expand →
// reroute-collapse → accessor-CSE) is the same target-independent pipeline the
// JS agent compiler runs.
//
// The module:
//   import "env" "mem"  = the wasmBacked AgentStore memory (reads/writes hit the
//                          SAME bytes the JS engine reads at the baked offsets).
//   import "env" "pow"/"exp"/.../"tanh" = the 7 host math funcs (same funcIdx
//                          convention as the lattice module: POW=0 .. TANH=6).
//   export "behaviour"(highWater, hashValid, nBinsX, nBinsY, nBinsZ : i32,
//                       binSizeX, binSizeY, binSizeZ : f64,
//                       fieldW, fieldH, fieldD : f64, fieldTorus : i32,
//                       originX, originY, originZ : f64,
//                       activeViewerIdx : i32) -> ()
//     _rs = u32[rngStateOffset];                  // AW-RNG: read the shared stream
//     for (idx = 0; idx < highWater; idx++) {
//       if (alive[idx] == 0) continue;
//       <reset Local Variables>
//       <per-agent value DAG + the linear flow chain>
//     }
//     u32[rngStateOffset] = _rs;                  // store back (JS↔WASM bit-parity)
//
// AW-HASH (S10): the per-step spatial hash (binStart/binAgents) is COPIED into the
// agent-memory views by the worker each step (an O(nBins + liveCount) copy); the
// hash DIMENSIONS (valid flag + nBins + binSize per axis) ride the behaviour ARG
// list (so they need no per-step memory write). `getNearbyAgents` queries the
// in-memory hash via the SAME 3×3[×3] stencil + torus wrap the JS emit uses.
// ===========================================================================

import type { GraphNode, GraphEdge, CAModel } from '../../../../model/types';
import { agentAttrsOf } from '../../../../model/attributeScope';
import { modelAttrSlotKeys } from '../../../../model/attributeScope';
import { resolveMaxBonds } from '../../../../model/centerBased';
import {
  I32, F64,
  leb128u,
  funcType, buildModule,
  exportEntry, EXPORT_FUNC,
  importEntry, importMemoryDesc, importFuncDesc,
  OP_I32_ADD, OP_I32_SUB, OP_I32_MUL, OP_I32_REM_S, OP_I32_DIV_S,
  OP_I32_GE_S, OP_I32_GT_S, OP_I32_LT_S, OP_I32_NE, OP_I32_EQ, OP_I32_EQZ,
  OP_I32_AND, OP_I32_OR, OP_I32_XOR, OP_I32_SHL, OP_I32_SHR_U,
  OP_F64_ADD, OP_F64_SUB, OP_F64_MUL, OP_F64_DIV,
  OP_F64_ABS, OP_F64_NEG, OP_F64_SQRT, OP_F64_MIN, OP_F64_MAX, OP_F64_FLOOR, OP_F64_CEIL,
  OP_F64_EQ, OP_F64_NE, OP_F64_LT, OP_F64_GT, OP_F64_LE, OP_F64_GE,
  OP_F64_CONVERT_I32_S, OP_F64_CONVERT_I32_U, OP_I32_TRUNC_F64_S, OP_I32_TRUNC_SAT_F64_S, OP_SELECT,
  opCall,
} from '../wasm/encoder';
import { WasmEmitter, isInline, type ValueRef, type LocalRef } from '../wasm/emitter';
import { POW_FUNC_IDX, EXP_FUNC_IDX, LOG_FUNC_IDX, SIN_FUNC_IDX, COS_FUNC_IDX, TAN_FUNC_IDX, TANH_FUNC_IDX, NUM_IMPORTED_FUNCS } from '../wasm/compile';
import { computeAsyncReadWriteHazards } from '../asyncWriteHazard';
import { computeVolatileHoist } from '../volatileHoist';
import { getNodeDef } from '../../nodes/registry';

/** `env.fmod = (a,b)=>a%b` — the 8th host import, ALWAYS present in the agent
 *  module (appended after pow..tanh at funcIdx 7). Used by the force pass's
 *  bit-exact torus wrap AND the Math node's `%` op. */
const FMOD_FUNC_IDX = NUM_IMPORTED_FUNCS; // = 7
/** Unified spawning host imports (appended after fmod): Create Agent + Add Agent To
 *  World in the behaviour graph. `env.agentCreate(x,y,z,r) -> i32 handle` (grow-only
 *  alloc over the shared memory) + `env.agentAddToWorld(id)`. Same JS closures the
 *  Init Event uses, so JS↔WASM behaviour-Create is bit-identical. */
const AGENT_CREATE_FUNC_IDX = NUM_IMPORTED_FUNCS + 1; // = 8
const AGENT_ADD_FUNC_IDX = NUM_IMPORTED_FUNCS + 2;    // = 9
import { emitWasm } from '../expression/emitWasm';
import { buildVarMap, parseExpression, clampVisibleCount } from '../expression/parser';
import { is3dModel } from '../compile';
import { expandMacros } from '../macroExpand';
import { collapseReroutes } from '../rerouteCollapse';
import { expandMultiAttrs } from '../multiAttrExpand';
import { expandForceToAgents } from '../forceToAgentsExpand';
import { expandComposites } from '../expandComposites';
import { lowerVectorAttrs, expandVectorAttributes } from '../vectorAttr';
import { lowerFacingSource } from '../facingSource';
import { canonicalizeAccessorEdges } from '../accessorCSE';
import { resolveKeyLabels, resolveAxes, isMultiAxisTable } from '../variegation';
import { colorScaleHasAlpha, readColorScaleStops, type ColorScaleStop } from '../../nodes/ColorScaleNode';
import { categoricalHasAlpha, readCategoricalEntries, readCategoricalDefault, type CategoricalEntry } from '../../nodes/CategoricalColorNode';
import { colorConstantHasAlpha } from '../../nodes/GetColorConstantNode';
import { viewCosHalf } from '../../nodes/GetAgentsInViewNode';
import { cellFieldAttrsOf } from '../../../../model/attributeScope';
import {
  computeAgentMemoryLayout, computeAgentMaxHashBins, AGENT_NEARBY_SCRATCH_SLOTS,
  type AgentAttrSpec, type AgentMemoryLayout, type AgentLayoutExtras,
  agentAttrKind,
} from '../../../../simulator/engine/agentEngine';

/** The node types the WASM agent compiler can emit. FULL-COVERAGE: a model whose
 *  agent graph uses ONLY these (after macro-expansion / reroute-collapse / CSE) runs
 *  on the WASM target with JS bit-parity (f64). The reject set is now EMPTY — WASM
 *  is Turing-complete + f64, so no node is un-portable. Keep this the SINGLE source
 *  of truth so the gate + the emitter dispatch never drift.
 *
 *  The only remaining structural gate (not a node ban) is the per-node scratch-slot
 *  budget for agent-array producers (AGENT_NEARBY_SCRATCH_SLOTS) — a graph with too
 *  many simultaneous array producers falls back to JS (never silently corrupted). */
export const AGENT_WASM_SUPPORTED_TYPES: ReadonlySet<string> = new Set<string>([
  // event roots (divisionEvent + agentInit are CPU/JS — see AGENT_WASM_CPU_ROOT_TYPES)
  'behaviourStep',
  // self reads (SoA geometry + engine reductions)
  'getSelfPosition', 'getRadius', 'getAge', 'getBondDegree', 'neighbourDensity', 'getCurvature',
  // world size (the agent world IS the cell grid — fieldW/fieldH/fieldD params)
  'getGridDimensions',
  // neighbour access
  'getSelfHandle',
  'getNearbyAgents', 'getAgentsInView', 'senseHemifield', 'forEachInArray', 'getAgentOffset', 'getVelocity',
  'getAgentPosition', 'getAgentRadius', 'getAgentAttribute',
  // agent-array tier
  'getAgentsAttribute', 'setAgentsAttribute', 'filterAgents', 'joinAgents',
  'pickRandomAgent', 'pickNRandomAgents', 'getBondedAgents',
  'aggregate', 'groupOperator', 'groupCounting', 'groupStatement',
  // bonds
  'forEachBond',
  // local variables (scalar + array)
  'getVariable', 'setVariable', 'setArrayElement',
  // array accessors
  'arrayElement', 'arrayLength',
  // agent attributes (Get/Set/Update Attribute on the agent SoA)
  'getCellAttribute', 'setAttribute', 'updateAttribute', 'setAgentAttribute',
  'setVelocity', 'setAgentPosition', 'setAgentRadius',
  // structural writes (the post-step CPU structural phase reads the requests)
  'divideAgent', 'formBond', 'breakBond', 'killAgent',
  // Stop Event — writes the agent stop cell (worker merges it into the shared flag)
  'stopEvent',
  // unified spawning — Create Agent + Add Agent To World in the behaviour graph
  // (via env.agentCreate / env.agentAddToWorld host imports)
  'createAgent', 'addAgentToWorld',
  // field bridge (the closed agent↔grid morphogen feedback)
  'sampleField', 'fieldGradient', 'readCellsUnder', 'affectCellsUnder', 'secreteToField',
  // colour + tables + model attrs
  'categoricalColor', 'setCellLooks', 'getColorConstant', 'colorScale',
  // NB: interactionTableMap is LATTICE_ONLY_TYPES (nodeValidation) — hidden on the
  // Agents graph, so it can never reach an agent compiler. Not listed here (keeps
  // WASM consistent with WebGPU, which likewise doesn't emit it for agents).
  'getModelAttribute', 'lookupInteraction',
  'proportionMap', 'interpolation', 'valueSwitch',
  // indicators
  'getIndicator', 'setIndicator', 'updateIndicator',
  // writes (SoA / request)
  'applyForce', 'applyForceToAgent', 'setTargetRadius',
  // layout-agnostic value/flow utility (operate on the f64 stack / locals)
  'getConstant', 'arithmeticOperator', 'expression', 'statement', 'logicOperator', 'getRandom',
  // flow
  'conditional', 'sequence', 'switch', 'loop',
]);

/** Node types that may appear in the agent graph but are compiled on JS-on-CPU
 *  (NOT in the WASM behaviour module): the `divisionEvent` + `agentInit` ENTRY
 *  ROOTS and their spawn nodes. The worker runs `agentDivisionFn` / `agentInitFn`
 *  (JS) over the SAME wasmBacked memory the WASM behaviour reads — target-
 *  independent, bit-exact (mirrors how the WebGPU agent target keeps divisionEvent
 *  + agentInit on the CPU). The gate accepts them iff they're outside the
 *  BEHAVIOUR-reachable node set (the divisionEvent/agentInit subtrees). */
export const AGENT_WASM_CPU_ROOT_TYPES: ReadonlySet<string> = new Set<string>([
  'divisionEvent', 'agentInit', 'createAgent', 'addAgentToWorld',
]);

export interface AgentWasmResult {
  /** The compiled module bytes (empty on error / unsupported). */
  bytes: Uint8Array;
  /** Pages the module's imported memory must have (= the agent layout's pages). */
  pages: number;
  /** The agent memory layout this module was compiled against (so the worker can
   *  build the SAME layout — incl. the AW-HASH reserve — for the store). */
  layout: AgentMemoryLayout;
  /** The node types the compiler actually emitted (for diagnostics + the gate). */
  supportedTypes: string[];
  /** Ordered list of the non-sentinel setCellLooks mappingIds the behaviour
   *  references. The worker passes `viewerGuardIds.indexOf(activeViewer)` as the
   *  behaviour's trailing `activeViewerIdx` i32 arg so each guarded write fires
   *  exactly when JS's `_isV_` guard would (bit-parity for multi-viewer models). */
  viewerGuardIds: string[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Adjacency — a small self-contained value/flow graph walk for the supported
// subset.
// ---------------------------------------------------------------------------

interface Adjacency {
  nodeMap: Map<string, GraphNode>;
  /** value input port `${nodeId}:${portId}` → its single (first-wins) source. */
  inputToSource: Map<string, { nodeId: string; portId: string }>;
  /** ALL sources for a value input port (isArray ports accept many connections). */
  inputToSources: Map<string, Array<{ nodeId: string; portId: string }>>;
  /** flow output port `${nodeId}:${portId}` → the ordered target node ids. */
  flowOutputToTargets: Map<string, Array<{ nodeId: string; portId: string }>>;
}

function parseHandle(handleId: string | undefined): { category: 'value' | 'flow'; portId: string } | null {
  if (!handleId) return null;
  const m = handleId.match(/^(?:input|output)_(value|flow)_(.+)$/);
  if (!m) return null;
  return { category: m[1] as 'value' | 'flow', portId: m[2]! };
}

function buildAdjacency(nodes: GraphNode[], edges: GraphEdge[]): Adjacency {
  const nodeMap = new Map<string, GraphNode>();
  for (const n of nodes) nodeMap.set(n.id, n);
  const inputToSource = new Map<string, { nodeId: string; portId: string }>();
  const inputToSources = new Map<string, Array<{ nodeId: string; portId: string }>>();
  const flowOutputToTargets = new Map<string, Array<{ nodeId: string; portId: string }>>();
  for (const e of edges) {
    const src = parseHandle(e.sourceHandle);
    const tgt = parseHandle(e.targetHandle);
    if (!src || !tgt) continue;
    if (tgt.category === 'value') {
      const key = `${e.target}:${tgt.portId}`;
      if (!inputToSource.has(key)) inputToSource.set(key, { nodeId: e.source, portId: src.portId });
      const arr = inputToSources.get(key) ?? [];
      arr.push({ nodeId: e.source, portId: src.portId });
      inputToSources.set(key, arr);
    } else {
      const key = `${e.source}:${src.portId}`;
      const arr = flowOutputToTargets.get(key) ?? [];
      arr.push({ nodeId: e.target, portId: tgt.portId });
      flowOutputToTargets.set(key, arr);
    }
  }
  return { nodeMap, inputToSource, inputToSources, flowOutputToTargets };
}

// ---------------------------------------------------------------------------
// The emitter context. One WasmEmitter holds the whole behaviour body. Every
// value-output port is materialised into a local once + cached by
// `${nodeId}:${portId}`. SoA offsets come from the baked AgentMemoryLayout.
//
// IMPORTANT (volatility): unlike PR6b-1's pre-emit-everything-at-top scheme, the
// value cache here is SCOPED — a value emitted inside a forEachInArray body (it
// reads `element`/`index`, mutated per iteration) must be re-emitted each loop.
// We mirror the JS agent compiler's structure: pre-emit only the LOOP-INVARIANT
// values at the agent-loop top; values that transitively read a forEach
// element/index OR a getVariable (mutated by setVariable) are emitted LAZILY at
// use site inside their enclosing scope. We model this by clearing the relevant
// cache entries on forEach-body entry, and by NOT caching getVariable reads.
// ---------------------------------------------------------------------------

/** A reference to an array materialised in agent-memory scratch. `offsetLocal` is
 *  the i32 byte offset of element 0; `lenLocal` is the element count; `elemBytes`
 *  is 4 (i32 id/value arrays) or 8 (f64 value arrays). The WASM analogue of the JS
 *  `_v<id>_result` / `_v<id>_vals` scratch arrays. */
interface AgentArrayRef {
  offsetLocal: number;
  lenLocal: number;
  elemBytes: number;
  /** true → the elements are f64 (gathered float attr values); else i32. */
  isF64: boolean;
}

interface AgentWasmCtx {
  adj: Adjacency;
  layout: AgentMemoryLayout;
  model: CAModel;
  is3d: boolean;
  em: WasmEmitter;
  /** RNG local (i32) holding the live xorshift32 `_rs`. */
  rsLocal: number;
  /** loop var `idx` (i32, behaviour). */
  idxLocal: number;
  /** Scalar Local-Variable id → its f64 local. Reset to initialValue at loop top. */
  varLocals: Map<string, number>;
  /** Array Local-Variable id → its scratch ArrayRef (one bump-alloc per agent). */
  arrayVarLocals: Map<string, AgentArrayRef>;
  /** Cache: `${nodeId}:${portId}` → its ValueRef. Cleared on scope change. */
  valueCache: Map<string, ValueRef>;
  /** Cache: `${nodeId}:${portId}` → its ArrayRef (array-producer outputs). */
  arrayCache: Map<string, AgentArrayRef>;
  /** Node ids whose cached value MUST NOT persist across a forEach iteration
   *  (they transitively depend on a forEach element/index or a getVariable). */
  volatileNodes: Set<string>;
  /** getNearbyAgents node id → its assigned scratch slot index (0..slots-1). */
  nearbyScratchSlot: Map<string, number>;
  /** Per-agent bump-pointer scratch top (i32 byte offset). Reset to scratchBase at
   *  loop top; advanced past each array alloc. */
  scratchTopLocal: number;
  /** The current forEach iteration locals, innermost last (for nested loops — the
   *  supported set is single-level, but kept general). Each entry exposes the
   *  forEach node id + its element (i32 local) + index (i32 local). */
  forEachStack: Array<{ nodeId: string; elemLocal: number; idxLocal: number }>;
  /** Active Loop nodes (innermost last) — exposes the iteration counter local
   *  for the Loop's `index` output port (mirrors forEachStack). */
  loopStack: Array<{ nodeId: string; idxLocal: number }>;
  /** The current forEachBond iteration locals (partnerId/restLength/currentLength
   *  /index per-iteration), keyed by the forEachBond node id. */
  forEachBondStack: Array<{ nodeId: string; partnerLocal: number; restLocal: number; curLocal: number; idxLocal: number }>;
  // --- behaviour PARAM indices (read directly as locals — see the signature) ---
  highWaterLocal: number; hashValidLocal: number;
  nBinsXLocal: number; nBinsYLocal: number; nBinsZLocal: number;
  binSizeXLocal: number; binSizeYLocal: number; binSizeZLocal: number;
  /** The bbox-anchored hash grid origin (0 on a torus) — a query bins as
   *  floor((pos - origin) / binSize). */
  originXLocal: number; originYLocal: number; originZLocal: number;
  fieldWLocal: number; fieldHLocal: number; fieldDLocal: number; fieldTorusLocal: number;
  /** Field total (W*H*D) as an i32 local (param). Used by field-bridge index math. */
  fieldTotalLocal: number;
  /** The trailing `activeViewerIdx` i32 param — index into `viewerGuardIds` of
   *  the active viewer (-1 = none). setCellLooks' JS `_isV_` guard mirror. */
  activeViewerIdxLocal: number;
  /** Ordered non-sentinel setCellLooks mappingIds (the viewer-guard table). */
  viewerGuardIds: string[];
  /** Async read-after-write hazard cone (pure scalar chains only): NOT top-
   *  hoisted; emitted ONCE immediately before the flow node in hazardEmitBefore
   *  — the SAME LCA position JS's volatileHoist uses, keeping bit-parity. */
  hazardPinned: Set<string>;
  hazardEmitBefore: Map<string, string[]>;
}

// ---------------------------------------------------------------------------
// SoA address helpers — push the byte address of a per-agent region element.
// ---------------------------------------------------------------------------

/** Push `regionOffset + agentLocal*8` (Float64 element address) onto the stack. */
function pushF64ElemAddr(em: WasmEmitter, regionOffset: number, agentI32Local: number): void {
  em.localGet(agentI32Local);
  em.i32Const(8);
  em.op(OP_I32_MUL);
  em.i32Const(regionOffset);
  em.op(OP_I32_ADD);
}

/** Load a per-agent Float64 at `regionOffset + agentLocal*8` onto the stack. */
function pushF64Elem(em: WasmEmitter, regionOffset: number, agentI32Local: number): void {
  pushF64ElemAddr(em, regionOffset, agentI32Local);
  em.f64Load();
}

/** Push a value onto the stack (load from local, or push constant). */
function pushValue(em: WasmEmitter, v: ValueRef): void {
  if (isInline(v)) { if (v.valtype === I32) em.i32Const(v.value | 0); else em.f64Const(v.value); }
  else em.localGet(v.localIdx);
}

/** Push a value as the requested valtype. The f64→i32 path uses SATURATING
 *  truncation (NaN→0, ±Inf→saturate) so a NaN/Inf intermediate (an aggregate.max
 *  over an empty array → -Inf, an expression with sin/sqrt) does NOT TRAP — unlike
 *  the shared `pushValueAs`'s `i32.trunc_f64_s`. For finite in-range values it is
 *  bit-identical to plain truncation (so the verified bit-parity is preserved). */
function pushValueAs(em: WasmEmitter, v: ValueRef, want: typeof I32 | typeof F64): void {
  pushValue(em, v);
  if (v.valtype !== want) {
    if (want === F64) em.op(OP_F64_CONVERT_I32_S);
    else em.op(OP_I32_TRUNC_SAT_F64_S);
  }
}

/** Push the byte address of an i32 element at `regionOffset + agentLocal*4`. */
function pushI32ElemAddr(em: WasmEmitter, regionOffset: number, agentI32Local: number): void {
  em.localGet(agentI32Local); em.i32Const(4); em.op(OP_I32_MUL);
  em.i32Const(regionOffset); em.op(OP_I32_ADD);
}
/** Load a per-agent Int32 at `regionOffset + agentLocal*4` onto the stack. */
function pushI32Elem(em: WasmEmitter, regionOffset: number, agentI32Local: number): void {
  pushI32ElemAddr(em, regionOffset, agentI32Local);
  em.i32Load();
}

// ---------------------------------------------------------------------------
// Multi-output port cache + array scratch (the agent-array tier infra).
// ---------------------------------------------------------------------------

/** Register a named-port output (multi-output nodes). Keyed `${nodeId}:${portId}`. */
function setCachedPort(ctx: AgentWasmCtx, nodeId: string, portId: string, ref: ValueRef): void {
  ctx.valueCache.set(`${nodeId}:${portId}`, ref);
}

/** Bump-allocate an array of `lenLocal` elements (`elemBytes` each) in the per-agent
 *  scratch region. Returns offset/len locals. The scratchTop bump is unrolled into
 *  the emit stream so each agent gets a fresh slab (reset at loop top). */
function allocScratch(ctx: AgentWasmCtx, lenLocal: number, elemBytes: number, isF64: boolean): AgentArrayRef {
  const em = ctx.em;
  const offsetLocal = em.allocLocal(I32);
  // offset = scratchTop;  scratchTop += len * elemBytes (8-align so f64 stays aligned)
  em.localGet(ctx.scratchTopLocal); em.localSet(offsetLocal);
  em.localGet(ctx.scratchTopLocal);
  em.localGet(lenLocal); em.i32Const(elemBytes); em.op(OP_I32_MUL);
  em.op(OP_I32_ADD);
  // round up to 8
  em.i32Const(7); em.op(OP_I32_ADD); em.i32Const(-8); em.op(OP_I32_AND);
  em.localSet(ctx.scratchTopLocal);
  return { offsetLocal, lenLocal, elemBytes, isF64 };
}

/** Push array element `k` (i32 local `kLocal`) of `arr` onto the stack as f64. */
function pushArrayElemF64(em: WasmEmitter, arr: AgentArrayRef, kLocal: number): void {
  em.localGet(arr.offsetLocal);
  em.localGet(kLocal); em.i32Const(arr.elemBytes); em.op(OP_I32_MUL);
  em.op(OP_I32_ADD);
  if (arr.elemBytes === 8) em.f64Load();
  else { em.i32Load(); em.i32ToF64(); }
}
/** Push array element `k` of `arr` onto the stack as i32 (id arrays). */
function pushArrayElemI32(em: WasmEmitter, arr: AgentArrayRef, kLocal: number): void {
  em.localGet(arr.offsetLocal);
  em.localGet(kLocal); em.i32Const(arr.elemBytes); em.op(OP_I32_MUL);
  em.op(OP_I32_ADD);
  if (arr.elemBytes === 8) { em.f64Load(); em.f64ToI32(); }
  else em.i32Load();
}
/** Store element `k` of `arr` (value already on stack as the elem type). */
function storeArrayElemAddr(em: WasmEmitter, arr: AgentArrayRef, kLocal: number): void {
  em.localGet(arr.offsetLocal);
  em.localGet(kLocal); em.i32Const(arr.elemBytes); em.op(OP_I32_MUL);
  em.op(OP_I32_ADD);
}

// ---------------------------------------------------------------------------
// Inline-widget fallback for an unwired value input.
// ---------------------------------------------------------------------------

function getInlineNum(node: GraphNode, portId: string, fallback: number): number {
  const cfg = node.data.config as Record<string, unknown> | undefined;
  const raw = cfg?.[`_port_${portId}`];
  if (typeof raw === 'string') {
    if (raw === 'true') return 1;
    if (raw === 'false') return 0;
    const n = parseFloat(raw);
    if (Number.isFinite(n)) return n;
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  return fallback;
}

/** Parse a raw inline-widget value (string/number) → number, with `true`/`false`
 *  coercion (matching the cell WASM compiler's parseInlineNum). */
function parseInlineNum(raw: unknown, fallback: number): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    if (raw === 'true') return 1;
    if (raw === 'false') return 0;
    const n = parseFloat(raw);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/** Resolve a value input port to a ValueRef (an f64 unless the source is an i32
 *  producer like a forEach element/index). Wired → the source node's cached/
 *  freshly-emitted output; unwired → the inline-widget constant (f64). */
function resolveValueInput(ctx: AgentWasmCtx, node: GraphNode, portId: string, fallback: number): ValueRef {
  const src = ctx.adj.inputToSource.get(`${node.id}:${portId}`);
  if (src) return compileValueNode(ctx, src.nodeId, src.portId);
  return { inline: true, value: getInlineNum(node, portId, fallback), valtype: F64 };
}

/** Push a value input onto the stack as f64. */
function pushValueInputF64(ctx: AgentWasmCtx, node: GraphNode, portId: string, fallback: number): void {
  pushValueAs(ctx.em, resolveValueInput(ctx, node, portId, fallback), F64);
}

// ---------------------------------------------------------------------------
// Agent-attribute (r_/w_) + cell-field (_field_) memory access. Agent attrs are
// stored typed (bool→u8 0/1, int/tag→i32, float→f64) at `attrOffset` (read) +
// `attrWriteOffset` (sync-mode write). A read yields the JS-bit-parity f64 value;
// a write stores the f64 stack value truncated/floored to the kind (matching JS's
// typed-array store semantics).
// ---------------------------------------------------------------------------

function agentAttrKindOf(ctx: AgentWasmCtx, attrId: string): 'uint8' | 'int32' | 'float64' {
  const a = agentAttrsOf(ctx.model).find(x => x.id === attrId);
  return a ? agentAttrKind(a.type) : 'float64';
}

/** Push the f64 value of agent attribute `attrId` at agent `agentLocal` (READ
 *  buffer). Bool→u8, int/tag→i32, float→f64 (matching the JS typed array read). */
function pushAgentAttrReadF64(ctx: AgentWasmCtx, attrId: string, agentLocal: number): void {
  const em = ctx.em;
  const kind = agentAttrKindOf(ctx, attrId);
  const off = ctx.layout.attrOffset[attrId];
  if (off === undefined) { em.f64Const(0); return; }
  if (kind === 'uint8') { em.localGet(agentLocal); em.i32Const(off); em.op(OP_I32_ADD); em.i32Load8U(); em.i32ToF64(); }
  else if (kind === 'int32') { pushI32Elem(em, off, agentLocal); em.i32ToF64(); }
  else pushF64Elem(em, off, agentLocal);
}

/** Store the f64 stack value (already pushed by the caller) into agent attr
 *  `attrId`'s WRITE region at `agentLocal`. The store ADDRESS is pushed first; the
 *  caller pushes the value; this calls the store op. So the call pattern is:
 *    pushAgentAttrWriteAddr(...); <push value f64>; emitAgentAttrStore(...). */
function pushAgentAttrWriteAddr(ctx: AgentWasmCtx, attrId: string, agentLocal: number): void {
  const em = ctx.em;
  const kind = agentAttrKindOf(ctx, attrId);
  const off = (ctx.layout.syncAttrs ? ctx.layout.attrWriteOffset[attrId] : ctx.layout.attrOffset[attrId]) ?? 0;
  if (kind === 'float64') { em.localGet(agentLocal); em.i32Const(8); em.op(OP_I32_MUL); em.i32Const(off); em.op(OP_I32_ADD); }
  else if (kind === 'int32') { em.localGet(agentLocal); em.i32Const(4); em.op(OP_I32_MUL); em.i32Const(off); em.op(OP_I32_ADD); }
  else { em.localGet(agentLocal); em.i32Const(off); em.op(OP_I32_ADD); }
}
/** Emit the store op for agent attr `attrId` (address + f64 value already on the
 *  stack). For int/bool the f64 value is truncated to i32 (JS typed-array store
 *  semantics: `arr[i] = x` truncates toward zero). */
function emitAgentAttrStore(ctx: AgentWasmCtx, attrId: string): void {
  const em = ctx.em;
  const kind = agentAttrKindOf(ctx, attrId);
  if (kind === 'float64') em.f64Store();
  else if (kind === 'int32') { em.f64ToI32(); em.i32Store(); }
  else { em.f64ToI32(); em.i32Store8(); }   // bool: store the low byte (0/1)
}


// ---------------------------------------------------------------------------
// Value emission.
// ---------------------------------------------------------------------------

/** Compile a value-producing node + return the ValueRef for the requested port.
 *  Memoised in `valueCache` (keyed `${nodeId}:${portId}`). The cache is CLEARED at
 *  two boundaries — the top of each agent iteration AND each forEach iteration —
 *  so a value emitted inside a forEach body re-emits per iteration (it may read
 *  the per-iteration element/index) while a value used twice within one scope
 *  (e.g. a getRandom feeding two expressions) emits ONCE (the RNG-advance-once
 *  invariant, matching JS). `getVariable` returns the LIVE variable local, so its
 *  cached ValueRef is always current even after a `setVariable` write. */
function compileValueNode(ctx: AgentWasmCtx, nodeId: string, portId: string): ValueRef {
  const key = `${nodeId}:${portId}`;
  const cached = ctx.valueCache.get(key);
  if (cached !== undefined) return cached;

  const node = ctx.adj.nodeMap.get(nodeId);
  if (!node) throw new Error(`agentWasm: missing node ${nodeId}`);
  const type = node.data.nodeType;
  const em = ctx.em;

  const f64Result = (emitOntoStack: () => void): LocalRef => {
    emitOntoStack();
    const l = em.allocLocal(F64);
    em.localSet(l);
    return { localIdx: l, valtype: F64 };
  };

  let result: ValueRef;
  switch (type) {
    case 'forEachInArray': {
      // element (agent id, i32) / index (i32) of the active iteration — the loop's
      // locals live on the forEachStack (innermost = this node). The cache is
      // cleared each iteration, so caching the live local here is safe.
      const frame = ctx.forEachStack.find(f => f.nodeId === nodeId);
      if (!frame) { result = { inline: true, value: 0, valtype: I32 }; break; }
      if (portId === 'index') result = { localIdx: frame.idxLocal, valtype: I32 };
      else result = { localIdx: frame.elemLocal, valtype: forEachElemIsF64.get(nodeId) ? F64 : I32 };
      break;
    }
    case 'loop': {
      // The Loop node's per-iteration counter (`index` output). Only valid inside
      // the BODY (the live loop is on loopStack); outside → 0, like forEach.
      const frame = ctx.loopStack.find(f => f.nodeId === nodeId);
      result = frame ? { localIdx: frame.idxLocal, valtype: I32 } : { inline: true, value: 0, valtype: I32 };
      break;
    }
    case 'behaviourStep': {
      result = f64Result(() => {
        if (portId === 'myX') pushF64Elem(em, ctx.layout.f64['x']!, ctx.idxLocal);
        else if (portId === 'myY') pushF64Elem(em, ctx.layout.f64['y']!, ctx.idxLocal);
        else if (portId === 'myZ') pushF64Elem(em, ctx.layout.f64['z']!, ctx.idxLocal);
        else if (portId === 'myRadius') pushF64Elem(em, ctx.layout.f64['radius']!, ctx.idxLocal);
        else if (portId === 'myArea') {
          pushF64Elem(em, ctx.layout.f64['radius']!, ctx.idxLocal);
          pushF64Elem(em, ctx.layout.f64['radius']!, ctx.idxLocal);
          em.op(OP_F64_MUL); em.f64Const(Math.PI); em.op(OP_F64_MUL);
        }
        else if (portId === 'myAge') pushF64Elem(em, ctx.layout.f64['age']!, ctx.idxLocal);
        else if (portId === 'myBondDegree') { em.localGet(ctx.idxLocal); em.i32Const(4); em.op(OP_I32_MUL); em.i32Const(ctx.layout.i32['bondCount']!); em.op(OP_I32_ADD); em.i32Load(); em.i32ToF64(); }
        else em.f64Const(0);
      });
      break;
    }
    case 'getSelfPosition': {
      const region = portId === 'y' ? ctx.layout.f64['y']! : portId === 'z' ? ctx.layout.f64['z']! : ctx.layout.f64['x']!;
      result = f64Result(() => pushF64Elem(em, region, ctx.idxLocal));
      break;
    }
    case 'getRadius': {
      result = f64Result(() => pushF64Elem(em, ctx.layout.f64['radius']!, ctx.idxLocal));
      break;
    }
    // Get Grid Dimensions — the agent world IS the cell grid (1:1), and its dims
    // ride the behaviour signature as the fieldW / fieldH / fieldD f64 params
    // (fieldD is 1 in a 2D world). Zero-cost: just re-read the param local.
    // Centre ports = floor(dim / 2) — `dim * 0.5` is exact for integer dims, so
    // the floor matches the JS `Math.floor(dim / 2)` bit-for-bit.
    case 'getGridDimensions': {
      const isCenter = portId === 'centerX' || portId === 'centerY' || portId === 'centerZ';
      const dimLocal = (portId === 'height' || portId === 'centerY') ? ctx.fieldHLocal
        : (portId === 'depth' || portId === 'centerZ') ? ctx.fieldDLocal
        : ctx.fieldWLocal;
      result = f64Result(() => {
        em.localGet(dimLocal);
        if (isCenter) { em.f64Const(0.5); em.op(OP_F64_MUL); em.op(OP_F64_FLOOR); }
      });
      break;
    }
    case 'getAge': {
      result = f64Result(() => pushF64Elem(em, ctx.layout.f64['age']!, ctx.idxLocal));
      break;
    }
    case 'getConstant': {
      result = { inline: true, value: readConstantValue(node), valtype: F64 };
      break;
    }
    case 'arithmeticOperator': {
      result = f64Result(() => emitArithmetic(ctx, node));
      break;
    }
    case 'expression': {
      result = compileExpression(ctx, node);
      break;
    }
    case 'statement': {
      result = f64Result(() => emitCompare(ctx, node));
      break;
    }
    case 'logicOperator': {
      result = f64Result(() => emitLogic(ctx, node));
      break;
    }
    case 'getRandom': {
      result = f64Result(() => emitGetRandom(ctx, node));
      break;
    }
    case 'getVariable': {
      const variableId = (node.data.config?.['variableId'] as string) || '';
      const local = variableId ? ctx.varLocals.get(variableId) : undefined;
      if (local === undefined) result = { inline: true, value: 0, valtype: F64 };
      else result = { localIdx: local, valtype: F64 };
      break;
    }
    case 'getAgentPosition': {
      if ((node.data.config?.['mode'] as string) === 'relative') {
        result = compileAgentRelativePosition(ctx, node, portId);
        break;
      }
      const aLocal = emitAgentIdLocal(ctx, node, 'agentId');
      const region = portId === 'y' ? ctx.layout.f64['y']! : portId === 'z' ? ctx.layout.f64['z']! : ctx.layout.f64['x']!;
      // Range-guarded (mirrors the JS emit): -1 / oob → 0.
      const guard = emitAgentIdGuard(ctx, aLocal);
      result = f64Result(() => pushGuardedF64(ctx, guard, safe => pushF64Elem(em, region, safe)));
      break;
    }
    case 'getAgentRadius': {
      const aLocal = emitAgentIdLocal(ctx, node, 'agentId');
      const guard = emitAgentIdGuard(ctx, aLocal);
      result = f64Result(() => pushGuardedF64(ctx, guard, safe => pushF64Elem(em, ctx.layout.f64['radius']!, safe)));
      break;
    }
    case 'getVelocity': {
      // self when agentId is unwired (JS: `inputs.agentId ? (...|0) : idx`) —
      // self is always valid; a WIRED id is range-guarded like JS.
      const src = ctx.adj.inputToSource.get(`${node.id}:agentId`);
      const region = portId === 'vy' ? ctx.layout.f64['vy']! : portId === 'vz' ? ctx.layout.f64['vz']! : ctx.layout.f64['vx']!;
      if (!src) {
        result = f64Result(() => pushF64Elem(em, region, ctx.idxLocal));
        break;
      }
      const aLocal = emitAgentIdLocal(ctx, node, 'agentId');
      const guard = emitAgentIdGuard(ctx, aLocal);
      result = f64Result(() => pushGuardedF64(ctx, guard, safe => pushF64Elem(em, region, safe)));
      break;
    }
    case 'getAgentOffset': {
      result = compileAgentOffset(ctx, node, portId);
      break;
    }
    case 'senseHemifield': {
      result = emitSenseHemifield(ctx, node, portId);
      break;
    }
    case 'getBondDegree': {
      result = f64Result(() => { pushI32Elem(em, ctx.layout.i32['bondCount']!, ctx.idxLocal); em.i32ToF64(); });
      break;
    }
    case 'getSelfHandle': {
      // The current agent's own id = the loop index.
      result = f64Result(() => { em.localGet(ctx.idxLocal); em.i32ToF64(); });
      break;
    }
    case 'neighbourDensity': {
      result = f64Result(() => pushF64Elem(em, ctx.layout.f64['density']!, ctx.idxLocal));
      break;
    }
    case 'getCurvature': {
      result = f64Result(() => emitCurvature(ctx));
      break;
    }
    case 'getAgentAttribute': {
      const attrId = (node.data.config?.['attributeId'] as string) || '';
      const aLocal = emitAgentIdLocal(ctx, node, 'agentId');
      // Range-guarded (mirrors GetAgentAttributeNode's JS emit): -1 / oob → 0.
      const guard = emitAgentIdGuard(ctx, aLocal);
      result = f64Result(() => pushGuardedF64(ctx, guard, safe => pushAgentAttrReadF64(ctx, attrId, safe)));
      break;
    }
    case 'getCellAttribute': {
      // On the AGENT graph this reads the AGENT SoA at idx (D-IDX). r_<attr>[idx].
      const attrId = (node.data.config?.['attributeId'] as string) || '';
      result = f64Result(() => pushAgentAttrReadF64(ctx, attrId, ctx.idxLocal));
      break;
    }
    case 'getModelAttribute': {
      result = emitGetModelAttribute(ctx, node, portId);
      break;
    }
    case 'getIndicator': {
      const idxN = (node.data.config?.['_indicatorIdx'] as number) ?? -1;
      result = f64Result(() => {
        if (idxN < 0) { em.f64Const(0); return; }
        em.i32Const(ctx.layout.indicatorsOffset + idxN * 8); em.f64Load();
      });
      break;
    }
    case 'forEachBond': {
      const frame = ctx.forEachBondStack.find(f => f.nodeId === nodeId);
      if (!frame) { result = { inline: true, value: 0, valtype: F64 }; break; }
      if (portId === 'partnerId') result = { localIdx: frame.partnerLocal, valtype: I32 };
      else if (portId === 'restLength') result = { localIdx: frame.restLocal, valtype: F64 };
      else if (portId === 'currentLength') result = { localIdx: frame.curLocal, valtype: F64 };
      else result = { localIdx: frame.idxLocal, valtype: I32 };
      break;
    }
    case 'lookupInteraction': {
      result = f64Result(() => emitLookupInteraction(ctx, node));
      break;
    }
    case 'proportionMap': {
      result = f64Result(() => emitProportionMap(ctx, node));
      break;
    }
    case 'interpolation': {
      result = f64Result(() => {
        const mn = resolveValueInput(ctx, node, 'min', 0);
        const t = resolveValueInput(ctx, node, 't', 0.5);
        const mx = resolveValueInput(ctx, node, 'max', 1);
        // min + t*(max-min)
        pushValueAs(em, mn, F64);
        pushValueAs(em, t, F64);
        pushValueAs(em, mx, F64); pushValueAs(em, mn, F64); em.op(OP_F64_SUB);
        em.op(OP_F64_MUL); em.op(OP_F64_ADD);
      });
      break;
    }
    case 'valueSwitch': {
      // scalar mode: cond ? ifValue : elseValue (array mode handled in compileArrayNode).
      result = f64Result(() => {
        pushValueInputF64(ctx, node, 'ifValue', 0);
        pushValueInputF64(ctx, node, 'elseValue', 0);
        const cond = resolveValueInput(ctx, node, 'condition', 0);
        pushValueAs(em, cond, F64); em.f64Const(0); em.op(OP_F64_NE);   // i32 cond
        em.op(OP_SELECT);
      });
      break;
    }
    case 'colorScale': {
      result = emitColorScale(ctx, node, portId);
      break;
    }
    case 'categoricalColor': {
      result = emitCategoricalColor(ctx, node, portId);
      break;
    }
    case 'getColorConstant': {
      result = emitGetColorConstant(ctx, node, portId);
      break;
    }
    case 'arrayLength': {
      const arr = resolveInputArray(ctx, node, 'array');
      result = arr ? { localIdx: arr.lenLocal, valtype: I32 } : { inline: true, value: 0, valtype: I32 };
      break;
    }
    case 'arrayElement': {
      result = emitArrayElement(ctx, node);
      break;
    }
    case 'aggregate':
    case 'groupCounting':
    case 'groupOperator':
    case 'groupStatement': {
      result = emitArrayReduce(ctx, node, portId);
      break;
    }
    case 'pickRandomAgent': {
      result = f64Result(() => emitPickRandomAgent(ctx, node));
      break;
    }
    case 'filterAgents':
    case 'joinAgents': {
      // The multi-output array producers' scalar `count` port, consumed
      // standalone (e.g. "count nearby matching agents → Compare") — the same
      // dispatch shape as the lattice filterNeighbors/joinNeighbors value
      // entries: materialise the array (memoised), then return the cached count.
      // Without this, a count-only consumer hit "unsupported value node" and
      // silently clamped the whole model to JS.
      compileArrayNode(ctx, nodeId, 'result');
      const cached = ctx.valueCache.get(`${nodeId}:count`);
      result = cached ?? { inline: true, value: 0, valtype: I32 };
      break;
    }
    case 'sampleField': {
      const fieldId = (node.data.config?.['attributeId'] as string) || '';
      result = f64Result(() => emitSampleFieldAt(ctx, fieldId,
        () => pushF64Elem(em, ctx.layout.f64['x']!, ctx.idxLocal),
        () => pushF64Elem(em, ctx.layout.f64['y']!, ctx.idxLocal),
        ctx.is3d ? () => pushF64Elem(em, ctx.layout.f64['z']!, ctx.idxLocal) : undefined));
      break;
    }
    case 'fieldGradient': {
      result = emitFieldGradient(ctx, node, portId);
      break;
    }
    case 'readCellsUnder': {
      result = f64Result(() => emitReadCellsUnder(ctx, node));
      break;
    }
    case 'setVelocity': case 'setAgentAttribute': case 'setAgentPosition':
    case 'setAgentRadius': case 'setAgentsAttribute':
      // These are FLOW nodes — should never reach here as a value source.
      throw new Error(`agentWasm: '${type}' is a flow node, not a value source`);
    default:
      throw new Error(`agentWasm: unsupported value node '${type}'`);
  }

  ctx.valueCache.set(key, result);
  return result;
}

/** Resolve the `agentId` input of a neighbour-read node into a fresh i32 local.
 *  Unwired → -1 (the empty sentinel), mirroring the JS readers' `|| '-1'`. */
function emitAgentIdLocal(ctx: AgentWasmCtx, node: GraphNode, portId: string): number {
  const em = ctx.em;
  const ref = resolveValueInput(ctx, node, portId, -1);
  // (id) | 0 — coerce to i32.
  pushValueAs(em, ref, I32);
  const l = em.allocLocal(I32);
  em.localSet(l);
  return l;
}

/** Range-guard an agent id: `ok = id >= 0 && id < highWater`, `safe = ok ? id : 0`.
 *  Mirrors the JS readers' guard (−1 sentinel / oob → 0 result, never an
 *  adjacent-memory read — WASM select evaluates both arms, so loads use `safe`). */
function emitAgentIdGuard(ctx: AgentWasmCtx, idLocal: number): { okLocal: number; safeLocal: number } {
  const em = ctx.em;
  const ok = em.allocLocal(I32);
  em.localGet(idLocal); em.i32Const(0); em.op(OP_I32_GE_S);
  em.localGet(idLocal); em.localGet(ctx.highWaterLocal); em.op(OP_I32_LT_S);
  em.op(OP_I32_AND); em.localSet(ok);
  const safe = em.allocLocal(I32);
  em.localGet(idLocal); em.i32Const(0); em.localGet(ok); em.op(OP_SELECT); em.localSet(safe);
  return { okLocal: ok, safeLocal: safe };
}

/** Push `ok ? <load via emitLoad(safe)> : 0.0` (f64). */
function pushGuardedF64(ctx: AgentWasmCtx, guard: { okLocal: number; safeLocal: number }, emitLoad: (safeLocal: number) => void): void {
  const em = ctx.em;
  emitLoad(guard.safeLocal);
  em.f64Const(0);
  em.localGet(guard.okLocal);
  em.op(OP_SELECT);
}

/** Get Constant — mirrors GetConstantNode's JS resolution for every constType
 *  (bool / float / int+tag / orientation clamp / pre-resolved faceLabel). */
function readConstantValue(node: GraphNode): number {
  const cfg = node.data.config as Record<string, unknown> | undefined;
  const ct = (cfg?.['constType'] as string) ?? 'integer';
  const raw = cfg?.['constValue'];
  const rawStr = typeof raw === 'string' ? raw : typeof raw === 'number' ? String(raw) : '0';
  if (ct === 'bool') return rawStr === 'true' ? 1 : 0;
  if (ct === 'float') { const n = parseFloat(rawStr); return Number.isFinite(n) ? n : 0; }
  if (ct === 'orientation') {
    // out-of-range → 0, matching the JS emit's clamp.
    const n = parseInt(rawStr, 10);
    return Number.isFinite(n) && n >= 0 && n <= 3 ? n : 0;
  }
  if (ct === 'faceLabel') {
    // pre-resolved NAME→index by preResolveVariegatedNodes; unresolved → -1
    // sentinel (JS parity — parsing the label name yielded NaN→0 before).
    const idx = parseInt(String(cfg?.['_resolvedFaceLabelIndex'] ?? -1), 10);
    return Number.isFinite(idx) ? idx : -1;
  }
  const n = parseInt(rawStr, 10); return Number.isFinite(n) ? n : 0;
}

/** Math node — leaves the result on the stack (f64). Mirrors the JS Math node
 *  (incl. the divide-by-zero → 0 guard). */
function emitArithmetic(ctx: AgentWasmCtx, node: GraphNode): void {
  const em = ctx.em;
  const cfg = node.data.config as Record<string, unknown> | undefined;
  const op = (cfg?.['operation'] as string) ?? '+';
  const unary = (call: number) => { pushValueInputF64(ctx, node, 'x', 0); em.emit(opCall(call)); };
  switch (op) {
    case '+': case 'add': pushValueInputF64(ctx, node, 'x', 0); pushValueInputF64(ctx, node, 'y', 0); em.op(OP_F64_ADD); break;
    case '-': pushValueInputF64(ctx, node, 'x', 0); pushValueInputF64(ctx, node, 'y', 0); em.op(OP_F64_SUB); break;
    case '*': pushValueInputF64(ctx, node, 'x', 0); pushValueInputF64(ctx, node, 'y', 0); em.op(OP_F64_MUL); break;
    case '/': emitGuardedDiv(ctx, node); break;
    case 'sqrt': pushValueInputF64(ctx, node, 'x', 0); em.op(OP_F64_SQRT); break;
    case 'abs': pushValueInputF64(ctx, node, 'x', 0); em.op(OP_F64_ABS); break;
    case 'floor': pushValueInputF64(ctx, node, 'x', 0); em.op(OP_F64_FLOOR); break;
    case 'ceil': pushValueInputF64(ctx, node, 'x', 0); em.op(OP_F64_CEIL); break;
    // floor(x + 0.5) — matches JS/WGSL; NOT f64.nearest (banker's rounding).
    case 'round': pushValueInputF64(ctx, node, 'x', 0); em.f64Const(0.5); em.op(OP_F64_ADD); em.op(OP_F64_FLOOR); break;
    case 'max': pushValueInputF64(ctx, node, 'x', 0); pushValueInputF64(ctx, node, 'y', 0); em.op(OP_F64_MAX); break;
    case 'min': pushValueInputF64(ctx, node, 'x', 0); pushValueInputF64(ctx, node, 'y', 0); em.op(OP_F64_MIN); break;
    case 'mean': pushValueInputF64(ctx, node, 'x', 0); pushValueInputF64(ctx, node, 'y', 0); em.op(OP_F64_ADD); em.f64Const(2); em.op(OP_F64_DIV); break;
    case 'pow': pushValueInputF64(ctx, node, 'x', 0); pushValueInputF64(ctx, node, 'y', 0); em.emit(opCall(POW_FUNC_IDX)); break;
    case 'exp': unary(EXP_FUNC_IDX); break;
    case 'log': unary(LOG_FUNC_IDX); break;
    case 'sin': unary(SIN_FUNC_IDX); break;
    case 'cos': unary(COS_FUNC_IDX); break;
    case 'tan': unary(TAN_FUNC_IDX); break;
    case 'tanh': unary(TANH_FUNC_IDX); break;
    case '%': {
      // (y !== 0 ? x % y : 0) — mirrors the JS Math node. WASM has no f64 rem
      // opcode; env.fmod (funcIdx FMOD_FUNC_IDX, already imported for the force
      // pass) IS the JS `%`, bit-exact. Previously fell through to ADD.
      const yL = em.allocLocal(F64), resL = em.allocLocal(F64);
      pushValueInputF64(ctx, node, 'y', 0); em.localSet(yL);
      em.localGet(yL); em.f64Const(0); em.op(OP_F64_NE);
      em.ifThenElse(
        () => { pushValueInputF64(ctx, node, 'x', 0); em.localGet(yL); em.emit(opCall(FMOD_FUNC_IDX)); em.localSet(resL); },
        () => { em.f64Const(0); em.localSet(resL); },
      );
      em.localGet(resL);
      break;
    }
    default: pushValueInputF64(ctx, node, 'x', 0); pushValueInputF64(ctx, node, 'y', 0); em.op(OP_F64_ADD); break;
  }
}

/** `y !== 0 ? x / y : 0` — the JS Math node's divide guard. Leaves the result on
 *  the stack (WasmEmitter's ifThenElse uses an EMPTY block type, so the branches
 *  may not yield a value — store into a result local + reload). */
function emitGuardedDiv(ctx: AgentWasmCtx, node: GraphNode): void {
  const em = ctx.em;
  const yLocal = em.allocLocal(F64);
  const resLocal = em.allocLocal(F64);
  pushValueInputF64(ctx, node, 'y', 0); em.localSet(yLocal);
  em.localGet(yLocal); em.f64Const(0); em.op(OP_F64_NE); // cond = (y != 0)
  em.ifThenElse(
    () => { pushValueInputF64(ctx, node, 'x', 0); em.localGet(yLocal); em.op(OP_F64_DIV); em.localSet(resLocal); },
    () => { em.f64Const(0); em.localSet(resLocal); },
  );
  em.localGet(resLocal);
}

/** Compare node — numerical compare ops, leaving 1.0/0.0 on the stack. */
function emitCompare(ctx: AgentWasmCtx, node: GraphNode): void {
  const em = ctx.em;
  const cfg = node.data.config as Record<string, unknown> | undefined;
  // The Compare (`statement`) node stores its operator under `operation` (see
  // StatementNode.defaultConfig / its JS compile) — NOT `operator`. Reading the
  // wrong key made every non-equality op fall through to `==` on the WASM agent
  // target (silent divergence from the JS agent path).
  const op = (cfg?.['operation'] as string) ?? '==';
  if (op === 'between' || op === 'notBetween') {
    // (x lowOp y) && (x highOp y2), inverted for notBetween — mirrors
    // StatementNode's JS emit. Previously fell through to `==` (silent wrong
    // range checks on the WASM agent target).
    const xL = em.allocLocal(F64);
    pushValueInputF64(ctx, node, 'x', 0); em.localSet(xL);
    em.localGet(xL); pushValueInputF64(ctx, node, 'y', 0);
    em.op(cfg?.['lowOp'] === '>' ? OP_F64_GT : OP_F64_GE);
    em.localGet(xL); pushValueInputF64(ctx, node, 'y2', 0);
    em.op(cfg?.['highOp'] === '<' ? OP_F64_LT : OP_F64_LE);
    em.op(OP_I32_AND);
    if (op === 'notBetween') em.op(OP_I32_EQZ);
    em.op(OP_F64_CONVERT_I32_S);
    return;
  }
  pushValueInputF64(ctx, node, 'x', 0);
  pushValueInputF64(ctx, node, 'y', 0);
  switch (op) {
    case '==': em.op(OP_F64_EQ); break;
    case '!=': em.op(OP_F64_NE); break;
    case '>': em.op(OP_F64_GT); break;
    case '<': em.op(OP_F64_LT); break;
    case '>=': em.op(OP_F64_GE); break;
    case '<=': em.op(OP_F64_LE); break;
    default: em.op(OP_F64_EQ); break;
  }
  em.op(OP_F64_CONVERT_I32_S);
}

/** Logic node — AND/OR/XOR/NOT over boolean (non-zero) f64 inputs → 1.0/0.0. */
function emitLogic(ctx: AgentWasmCtx, node: GraphNode): void {
  const em = ctx.em;
  const cfg = node.data.config as Record<string, unknown> | undefined;
  // LogicOperatorNode stores its op UPPERCASE ('AND'/'OR'/'XOR'/'NOT') — lowercase
  // it so 'OR'/'XOR'/'NOT' don't fall through to AND (the GoL-on-agents all-die bug,
  // the same one the WebGPU agent port hit).
  const op = ((cfg?.['operation'] as string) ?? 'and').toLowerCase();
  const pushBool = (port: string) => { pushValueInputF64(ctx, node, port, 0); em.f64Const(0); em.op(OP_F64_NE); };
  if (op === 'not') { pushBool('a'); em.op(OP_I32_EQZ); }
  else {
    pushBool('a'); pushBool('b');
    if (op === 'or') em.op(OP_I32_OR);
    else if (op === 'xor') em.op(OP_I32_XOR);
    else em.op(OP_I32_AND);
  }
  em.op(OP_F64_CONVERT_I32_S);
}

/** Expression node — parse the formula + emit via the shared AST emitter. Each
 *  port (a..h) resolves to a ValueRef the SAME way the JS emit's `inputVars` map
 *  does. Returns the result f64 local. */
function compileExpression(ctx: AgentWasmCtx, node: GraphNode): ValueRef {
  const cfg = node.data.config as Record<string, unknown>;
  const visibleCount = clampVisibleCount(cfg['visibleCount']);
  const { map, errors } = buildVarMap(cfg as Parameters<typeof buildVarMap>[0], visibleCount);
  if (errors.length > 0) throw new Error(`expression: ${errors[0]}`);
  const res = parseExpression(String(cfg['expression'] ?? ''), map);
  if ('error' in res) throw new Error(`expression: ${res.error}`);
  // Resolve the visible ports the AST may reference (a..h). Like the JS path, an
  // unwired port falls through to its inline-widget constant.
  const inputs: Record<string, ValueRef | undefined> = {};
  const portIds = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  for (let i = 0; i < visibleCount && i < portIds.length; i++) {
    const pid = portIds[i]!;
    inputs[pid] = resolveValueInput(ctx, node, pid, 0);
  }
  return emitWasm(res.ast, ctx.em, inputs);
}

/** Get Random — float / integer / orientation / bool / options. Mirrors the
 *  lattice WASM getRandom xorshift32 + JS GetRandomNode exactly: the SAME
 *  constants (13/17/5) on the in-register `_rs` local (read once at function
 *  top, stored back at the end). Leaves an f64 on the stack. */
function emitGetRandom(ctx: AgentWasmCtx, node: GraphNode): void {
  const em = ctx.em;
  const cfg = node.data.config as Record<string, unknown> | undefined;
  // The Boids node uses `mode` (not `randomType`); accept either key, default float.
  const t = (cfg?.['randomType'] as string) || (cfg?.['mode'] as string) || 'float';
  const minRaw = cfg?.['min']; const maxRaw = cfg?.['max'];
  const minN = typeof minRaw === 'number' ? minRaw : parseFloat(String(minRaw ?? '0')) || 0;
  const maxN = typeof maxRaw === 'number' ? maxRaw : parseFloat(String(maxRaw ?? '1')) || 1;
  const rs = ctx.rsLocal;
  const advance = (): void => {
    // _rs ^= _rs << 13; _rs ^= _rs >>> 17; _rs ^= _rs << 5 (in-register).
    em.localGet(rs); em.localGet(rs); em.i32Const(13); em.op(OP_I32_SHL); em.op(OP_I32_XOR); em.localSet(rs);
    em.localGet(rs); em.localGet(rs); em.i32Const(17); em.op(OP_I32_SHR_U); em.op(OP_I32_XOR); em.localSet(rs);
    em.localGet(rs); em.localGet(rs); em.i32Const(5); em.op(OP_I32_SHL); em.op(OP_I32_XOR); em.localSet(rs);
  };
  if (t === 'options') {
    // One option picked uniformly from the wired Options array; Fallback when
    // empty. Inputs (array + fallback) resolve BEFORE the advance — matching JS,
    // where they're pre-emitted value deps — so any RNG-consuming source draws
    // first. Always-advance (like JS: the advance precedes the length check).
    // Previously this mode silently fell into the FLOAT branch on WASM.
    const arr = resolveInputArray(ctx, node, 'options');
    const fbL = em.allocLocal(F64);
    pushValueAs(em, resolveValueInput(ctx, node, 'fallback', 0), F64); em.localSet(fbL);
    advance();
    const uL = em.allocLocal(F64);
    em.localGet(rs); em.op(OP_F64_CONVERT_I32_U); em.f64Const(4294967296); em.op(OP_F64_DIV); em.localSet(uL);
    const resL = em.allocLocal(F64);
    if (!arr) {
      em.localGet(fbL); em.localSet(resL);
    } else {
      em.localGet(arr.lenLocal); em.i32Const(0); em.op(OP_I32_GT_S);
      em.ifThenElse(
        () => {
          // k = floor(u * len) — u < 1 ⇒ k ≤ len-1, exact like JS Math.floor.
          const kL = em.allocLocal(I32);
          em.localGet(uL);
          em.localGet(arr.lenLocal); em.op(OP_F64_CONVERT_I32_S);
          em.op(OP_F64_MUL); em.op(OP_F64_FLOOR); em.f64ToI32(); em.localSet(kL);
          pushArrayElemF64(em, arr, kL); em.localSet(resL);
        },
        () => { em.localGet(fbL); em.localSet(resL); },
      );
    }
    em.localGet(resL);
    return;
  }
  advance();
  // uniform = (unsigned _rs) / 2^32
  em.localGet(rs); em.op(OP_F64_CONVERT_I32_U); em.f64Const(4294967296); em.op(OP_F64_DIV);
  if (t === 'bool') {
    const probRef = resolveValueInput(ctx, node, 'probability', 0.5);
    pushValueAs(em, probRef, F64);   // stack: [uniform, prob]
    em.op(OP_F64_LT);                // uniform < prob ? 1 : 0  (i32 on stack)
    em.op(OP_F64_CONVERT_I32_S);     // i32 → f64 (ONE conversion — a second
                                     // convert here made the module fail WASM
                                     // type validation → silent JS fallback)
  } else if (t === 'integer') {
    em.f64Const(maxN - minN + 1); em.op(OP_F64_MUL);
    em.op(OP_F64_FLOOR);
    em.f64Const(minN); em.op(OP_F64_ADD);
  } else if (t === 'orientation') {
    em.f64Const(4); em.op(OP_F64_MUL); em.op(OP_F64_FLOOR);
    // & 3 — via i32 round-trip
    em.op(OP_I32_TRUNC_F64_S); em.i32Const(3); em.op(OP_I32_AND); em.i32ToF64();
  } else {
    // float: uniform * (max - min) + min
    em.f64Const(maxN - minN); em.op(OP_F64_MUL); em.f64Const(minN); em.op(OP_F64_ADD);
  }
}

/** Get Agent Offset — torus-shortest (dX, dY[, dZ]) + Distance from self to a
 *  target by id. Mirrors GetAgentOffsetNode's JS emit (the engine torus wrap over
 *  the world bounds). Multi-output: all four ports share one emit pass into four
 *  locals; returns the requested one. */
function compileAgentOffset(ctx: AgentWasmCtx, node: GraphNode, portId: string): ValueRef {
  const em = ctx.em;
  const L = ctx.layout;
  // The four output ports share ONE emit pass into four locals; cache all four so
  // a second port request reuses them (the main valueCache handles invalidation
  // at scope boundaries). If a sibling port is already cached, reuse it.
  const cachedSibling = ctx.valueCache.get(`${node.id}:dx`);
  if (cachedSibling !== undefined) return ctx.valueCache.get(`${node.id}:${portId}`) ?? cachedSibling;
  const aLocal = emitAgentIdLocal(ctx, node, 'agentId');
  // Range-guarded (mirrors the JS emit): -1 / oob → zero vector + zero distance.
  const guard = emitAgentIdGuard(ctx, aLocal);
  const dxL = em.allocLocal(F64), dyL = em.allocLocal(F64), distL = em.allocLocal(F64);
  let dzL = -1;
  // dx = ax[a]-ax[idx]; dy = ay[a]-ay[idx]  (loads use the clamped safe id)
  pushF64Elem(em, L.f64['x']!, guard.safeLocal); pushF64Elem(em, L.f64['x']!, ctx.idxLocal); em.op(OP_F64_SUB); em.localSet(dxL);
  pushF64Elem(em, L.f64['y']!, guard.safeLocal); pushF64Elem(em, L.f64['y']!, ctx.idxLocal); em.op(OP_F64_SUB); em.localSet(dyL);
  if (ctx.is3d) {
    dzL = em.allocLocal(F64);
    pushF64Elem(em, L.f64['z']!, guard.safeLocal); pushF64Elem(em, L.f64['z']!, ctx.idxLocal); em.op(OP_F64_SUB); em.localSet(dzL);
  }
  // if (_fieldBoundaryTorus) fold each axis to the shortest. The world bounds ride
  // the behaviour as the fieldW/fieldH/[fieldD] PARAMS (mirroring JS's _fieldW etc).
  em.localGet(ctx.fieldTorusLocal);
  em.ifThen(() => {
    foldTorus(em, dxL, ctx.fieldWLocal);
    foldTorus(em, dyL, ctx.fieldHLocal);
    if (ctx.is3d && dzL >= 0) foldTorus(em, dzL, ctx.fieldDLocal);
  });
  // distance = hypot
  em.localGet(dxL); em.localGet(dxL); em.op(OP_F64_MUL);
  em.localGet(dyL); em.localGet(dyL); em.op(OP_F64_MUL); em.op(OP_F64_ADD);
  if (ctx.is3d && dzL >= 0) { em.localGet(dzL); em.localGet(dzL); em.op(OP_F64_MUL); em.op(OP_F64_ADD); }
  em.op(OP_F64_SQRT); em.localSet(distL);
  // zero every output when the id was invalid.
  const zeroIfBad = (loc: number) => { em.localGet(loc); em.f64Const(0); em.localGet(guard.okLocal); em.op(OP_SELECT); em.localSet(loc); };
  zeroIfBad(dxL); zeroIfBad(dyL); if (ctx.is3d && dzL >= 0) zeroIfBad(dzL); zeroIfBad(distL);

  const refs: Record<string, ValueRef> = {
    dx: { localIdx: dxL, valtype: F64 },
    dy: { localIdx: dyL, valtype: F64 },
    distance: { localIdx: distL, valtype: F64 },
  };
  if (ctx.is3d && dzL >= 0) refs['dz'] = { localIdx: dzL, valtype: F64 };
  for (const k of Object.keys(refs)) ctx.valueCache.set(`${node.id}:${k}`, refs[k]!);
  return refs[portId] ?? refs['dx']!;
}

/** Get Agent Position (relative mode) — torus-shortest (X, Y[, Z]) displacement
 *  from a REFERENCE agent to the target by id: `target − reference`, folded to the
 *  shortest path. Like compileAgentOffset minus the Distance output, with `ref` in
 *  place of the hardcoded `idx`; the reference defaults to SELF (`idx`) when the
 *  `refId` input is unwired (mirrors GetAgentPositionNode's JS relative emit).
 *  Multi-output: one emit pass into shared locals cached under x/y/z. */
function compileAgentRelativePosition(ctx: AgentWasmCtx, node: GraphNode, portId: string): ValueRef {
  const em = ctx.em;
  const L = ctx.layout;
  const cachedSibling = ctx.valueCache.get(`${node.id}:x`);
  if (cachedSibling !== undefined) return ctx.valueCache.get(`${node.id}:${portId}`) ?? cachedSibling;
  const aLocal = emitAgentIdLocal(ctx, node, 'agentId');
  // self when refId is unwired (JS: `inputs.refId ? (...|0) : idx`).
  const refSrc = ctx.adj.inputToSource.get(`${node.id}:refId`);
  const refLocal = refSrc ? emitAgentIdLocal(ctx, node, 'refId') : ctx.idxLocal;
  // Range-guard BOTH ids (mirrors the JS emit; self is trivially in range).
  const gA = emitAgentIdGuard(ctx, aLocal);
  const gR = emitAgentIdGuard(ctx, refLocal);
  const okBoth = em.allocLocal(I32);
  em.localGet(gA.okLocal); em.localGet(gR.okLocal); em.op(OP_I32_AND); em.localSet(okBoth);
  const oxL = em.allocLocal(F64), oyL = em.allocLocal(F64);
  let ozL = -1;
  pushF64Elem(em, L.f64['x']!, gA.safeLocal); pushF64Elem(em, L.f64['x']!, gR.safeLocal); em.op(OP_F64_SUB); em.localSet(oxL);
  pushF64Elem(em, L.f64['y']!, gA.safeLocal); pushF64Elem(em, L.f64['y']!, gR.safeLocal); em.op(OP_F64_SUB); em.localSet(oyL);
  if (ctx.is3d) {
    ozL = em.allocLocal(F64);
    pushF64Elem(em, L.f64['z']!, gA.safeLocal); pushF64Elem(em, L.f64['z']!, gR.safeLocal); em.op(OP_F64_SUB); em.localSet(ozL);
  }
  em.localGet(ctx.fieldTorusLocal);
  em.ifThen(() => {
    foldTorus(em, oxL, ctx.fieldWLocal);
    foldTorus(em, oyL, ctx.fieldHLocal);
    if (ctx.is3d && ozL >= 0) foldTorus(em, ozL, ctx.fieldDLocal);
  });
  const zeroIfBad = (loc: number) => { em.localGet(loc); em.f64Const(0); em.localGet(okBoth); em.op(OP_SELECT); em.localSet(loc); };
  zeroIfBad(oxL); zeroIfBad(oyL); if (ctx.is3d && ozL >= 0) zeroIfBad(ozL);
  const refs: Record<string, ValueRef> = {
    x: { localIdx: oxL, valtype: F64 },
    y: { localIdx: oyL, valtype: F64 },
  };
  if (ctx.is3d && ozL >= 0) refs['z'] = { localIdx: ozL, valtype: F64 };
  for (const k of Object.keys(refs)) ctx.valueCache.set(`${node.id}:${k}`, refs[k]!);
  return refs[portId] ?? refs['x']!;
}

/** Fold an f64 local `d` to the torus-shortest range given the world span in
 *  `spanLocal`: `if(d > span/2) d -= span; else if(d < -span/2) d += span`. */
function foldTorus(em: WasmEmitter, dLocal: number, spanLocal: number): void {
  // d > span*0.5 ?
  em.localGet(dLocal); em.localGet(spanLocal); em.f64Const(0.5); em.op(OP_F64_MUL); em.op(OP_F64_GT);
  em.ifThenElse(
    () => { em.localGet(dLocal); em.localGet(spanLocal); em.op(OP_F64_SUB); em.localSet(dLocal); },
    () => {
      // d < -span*0.5 ?
      em.localGet(dLocal); em.localGet(spanLocal); em.f64Const(-0.5); em.op(OP_F64_MUL); em.op(OP_F64_LT);
      em.ifThen(() => { em.localGet(dLocal); em.localGet(spanLocal); em.op(OP_F64_ADD); em.localSet(dLocal); });
    },
  );
}

// ===========================================================================
// Universal value emitters (model attrs / lookup / proportion map / colours /
// curvature / array accessors / array reduce). All bit-parity with the JS node
// emitters.
// ===========================================================================

/** Interpolation curve — leaves the curved t (f64) in a fresh local; returns it.
 *  Bit-identical to the lattice WASM `emitInterpolationCurveWasm`. */
function emitInterpCurve(em: WasmEmitter, tRawLoc: number, method: string): number {
  const out = em.allocLocal(F64);
  if (method === 'linear') { em.localGet(tRawLoc); em.localSet(out); return out; }
  const tcl = em.allocLocal(F64);
  em.f64Const(0); em.f64Const(1); em.localGet(tRawLoc); em.op(OP_F64_MIN); em.op(OP_F64_MAX); em.localSet(tcl);
  switch (method) {
    case 'smoothstep':
      em.localGet(tcl); em.localGet(tcl); em.op(OP_F64_MUL);
      em.f64Const(3); em.f64Const(2); em.localGet(tcl); em.op(OP_F64_MUL); em.op(OP_F64_SUB);
      em.op(OP_F64_MUL); em.localSet(out); break;
    case 'easeInQuad':
      em.localGet(tcl); em.localGet(tcl); em.op(OP_F64_MUL); em.localSet(out); break;
    case 'easeOutQuad':
      em.f64Const(1); em.f64Const(1); em.localGet(tcl); em.op(OP_F64_SUB);
      em.f64Const(1); em.localGet(tcl); em.op(OP_F64_SUB); em.op(OP_F64_MUL); em.op(OP_F64_SUB); em.localSet(out); break;
    case 'exponential':
      em.localGet(tcl); em.f64Const(0); em.op(OP_F64_GT);
      em.ifThenElse(
        () => { em.f64Const(2); em.f64Const(10); em.localGet(tcl); em.f64Const(1); em.op(OP_F64_SUB); em.op(OP_F64_MUL); em.emit(opCall(POW_FUNC_IDX)); em.localSet(out); },
        () => { em.f64Const(0); em.localSet(out); },
      ); break;
    case 'logarithmic':
      em.localGet(tcl); em.f64Const(1); em.op(OP_F64_LT);
      em.ifThenElse(
        () => { em.f64Const(1); em.f64Const(2); em.f64Const(-10); em.localGet(tcl); em.op(OP_F64_MUL); em.emit(opCall(POW_FUNC_IDX)); em.op(OP_F64_SUB); em.localSet(out); },
        () => { em.f64Const(1); em.localSet(out); },
      ); break;
    default: em.localGet(tcl); em.localSet(out); break;
  }
  return out;
}

/** Get Model Attribute — multi-output (R/G/B for color attrs, else Value). Reads
 *  the in-memory copy at `modelAttrOffset[key]`. */
function emitGetModelAttribute(ctx: AgentWasmCtx, node: GraphNode, portId: string): ValueRef {
  const em = ctx.em;
  const cfg = node.data.config as Record<string, unknown>;
  const attr = (cfg['attributeId'] as string) || '';
  const readKey = (key: string): LocalRef => {
    const off = ctx.layout.modelAttrOffset[key];
    em.i32Const(0); if (off === undefined) em.f64Const(0); else em.f64Load(off, 3);
    const l = em.allocLocal(F64); em.localSet(l); return { localIdx: l, valtype: F64 };
  };
  if (cfg['isColorAttr']) {
    // A colour model attr ALWAYS occupies four slots (`modelAttrSlotKeys`), so
    // alpha is not gated here the way the palette nodes' is.
    const ports = ['r', 'g', 'b', 'a'];
    const refs = ports.map(ch => readKey(attr + '_' + ch));
    ports.forEach((p, i) => setCachedPort(ctx, node.id, p, refs[i]!));
    const pi = ports.indexOf(portId);
    return refs[pi >= 0 ? pi : 0]!;
  }
  return readKey(attr);
}

/** Table Lookup — `_lookupTables[id][row*colCount+col]` (0 when oob/unset).
 *  MULTI-AXIS tables: per-axis saturating clamp + `Σ idxₖ·strideₖ` (D-NDT-5 —
 *  the clamp guarantees in-bounds, so no flat guard is needed). */
function emitLookupInteraction(ctx: AgentWasmCtx, node: GraphNode): void {
  const em = ctx.em;
  const cfg = node.data.config as Record<string, unknown>;
  const tableId = (cfg['tableId'] as string) || '';
  const off = tableId ? ctx.layout.lookupTableOffset[tableId] : undefined;
  if (off === undefined) { em.f64Const(0); return; }
  const geo = resolveLookupTableDims(ctx.model, tableId);
  if (geo?.dims && geo.dims.length > 0) {
    const dims = geo.dims;
    const mins = geo.mins ?? [];
    const strides = new Array<number>(dims.length).fill(1);
    for (let i = dims.length - 2; i >= 0; i--) strides[i] = strides[i + 1]! * dims[i + 1]!;
    const flat = em.allocLocal(I32);
    em.i32Const(0); em.localSet(flat);
    for (let k = 0; k < dims.length; k++) {
      const min = Math.floor(mins[k] ?? 0) || 0;
      const hi = Math.max(0, dims[k]! - 1);
      const t = em.allocLocal(I32);
      pushValueAs(em, resolveValueInput(ctx, node, `axis_${k}`, 0), I32);
      if (min !== 0) { em.i32Const(min); em.op(OP_I32_SUB); }
      em.localSet(t);
      // t = max(t, 0): select(t, 0, t > 0)
      em.localGet(t); em.i32Const(0);
      em.localGet(t); em.i32Const(0); em.op(OP_I32_GT_S);
      em.op(OP_SELECT); em.localSet(t);
      // t = min(t, hi): select(t, hi, t < hi)
      em.localGet(t); em.i32Const(hi);
      em.localGet(t); em.i32Const(hi); em.op(OP_I32_LT_S);
      em.op(OP_SELECT); em.localSet(t);
      em.localGet(flat);
      em.localGet(t);
      if (strides[k] !== 1) { em.i32Const(strides[k]!); em.op(OP_I32_MUL); }
      em.op(OP_I32_ADD); em.localSet(flat);
    }
    em.localGet(flat); em.i32Const(8); em.op(OP_I32_MUL); em.i32Const(off); em.op(OP_I32_ADD); em.f64Load();
    return;
  }
  const colCount = ctx.layout.lookupTableCols[tableId] || 1;
  const tableCells = lookupTableCells(ctx, tableId);
  const la = em.allocLocal(I32); pushValueAs(em, resolveValueInput(ctx, node, 'labelA', 0), I32); em.localSet(la);
  const lb = em.allocLocal(I32); pushValueAs(em, resolveValueInput(ctx, node, 'labelB', 0), I32); em.localSet(lb);
  const cell = em.allocLocal(I32);
  em.localGet(la); em.i32Const(colCount); em.op(OP_I32_MUL); em.localGet(lb); em.op(OP_I32_ADD); em.localSet(cell);
  // if (cell >= 0 && cell < tableCells) load else 0
  const res = em.allocLocal(F64); em.f64Const(0); em.localSet(res);
  em.localGet(cell); em.i32Const(0); em.op(OP_I32_GE_S);
  em.localGet(cell); em.i32Const(tableCells); em.op(OP_I32_LT_S); em.op(OP_I32_AND);
  em.ifThen(() => {
    em.localGet(cell); em.i32Const(8); em.op(OP_I32_MUL); em.i32Const(off); em.op(OP_I32_ADD); em.f64Load();
    em.localSet(res);
  });
  em.localGet(res);
}

/** The reserved cell count (rows*cols — or Π dims for a multi-axis table) of a
 *  lookup table — for the oob bound check (mirrors JS `|| 0` for an out-of-range
 *  index). Derived by the same `resolveLookupTableDims` the layout extras use. */
function lookupTableCells(ctx: AgentWasmCtx, tableId: string): number {
  const dims = resolveLookupTableDims(ctx.model, tableId);
  if (!dims) return 0;
  return dims.dims ? dims.dims.reduce((a, b) => a * b, 1) : dims.rows * dims.cols;
}

/** A lookupTable model attr's geometry: legacy (rows, cols) from the row/col key
 *  sources, or — for a MULTI-AXIS (N-D) table — the full `dims`/`mins` via
 *  `resolveAxes` (the shared single source of truth; `dims` present ⇔ multi-axis).
 *  Consumed by BOTH the emitter and `buildAgentLayoutExtras`, so the compiled
 *  offsets and the worker store's region sizes derive from ONE resolution
 *  (the layout-lockstep invariant). */
function resolveLookupTableDims(
  model: CAModel,
  tableId: string,
): { rows: number; cols: number; dims?: number[]; mins?: number[] } | null {
  const attr = model.attributes.find(a => a.id === tableId && a.isModelAttribute && a.type === 'lookupTable');
  if (!attr) return null;
  if (isMultiAxisTable(attr)) {
    const r = resolveAxes(attr, model);
    return { rows: r.dims[0] ?? 1, cols: r.dims[1] ?? 1, dims: r.dims, mins: r.mins };
  }
  const a = attr as unknown as { rowKeySource?: unknown; colKeySource?: unknown };
  const rows = resolveKeyLabels(a.rowKeySource as Parameters<typeof resolveKeyLabels>[0], model).length;
  const cols = resolveKeyLabels(a.colKeySource as Parameters<typeof resolveKeyLabels>[0], model).length;
  return { rows, cols };
}

/** Proportion Map — `outMin + curve(t) * (outMax - outMin)` (guarded zero span). */
function emitProportionMap(ctx: AgentWasmCtx, node: GraphNode): void {
  const em = ctx.em;
  const method = (node.data.config['method'] as string) || 'linear';
  const x = em.allocLocal(F64); pushValueInputF64(ctx, node, 'x', 0); em.localSet(x);
  const inMin = em.allocLocal(F64); pushValueInputF64(ctx, node, 'inMin', 0); em.localSet(inMin);
  const inMax = em.allocLocal(F64); pushValueInputF64(ctx, node, 'inMax', 1); em.localSet(inMax);
  const outMin = em.allocLocal(F64); pushValueInputF64(ctx, node, 'outMin', 0); em.localSet(outMin);
  const outMax = em.allocLocal(F64); pushValueInputF64(ctx, node, 'outMax', 1); em.localSet(outMax);
  const span = em.allocLocal(F64); em.localGet(inMax); em.localGet(inMin); em.op(OP_F64_SUB); em.localSet(span);
  const res = em.allocLocal(F64);
  // span !== 0 ? outMin + curve((x-inMin)/span)*(outMax-outMin) : outMin
  em.localGet(span); em.f64Const(0); em.op(OP_F64_NE);
  em.ifThenElse(
    () => {
      const tRaw = em.allocLocal(F64);
      em.localGet(x); em.localGet(inMin); em.op(OP_F64_SUB); em.localGet(span); em.op(OP_F64_DIV); em.localSet(tRaw);
      const cv = emitInterpCurve(em, tRaw, method);
      em.localGet(outMin); em.localGet(cv); em.localGet(outMax); em.localGet(outMin); em.op(OP_F64_SUB); em.op(OP_F64_MUL); em.op(OP_F64_ADD);
      em.localSet(res);
    },
    () => { em.localGet(outMin); em.localSet(res); },
  );
  em.localGet(res);
}

/** Color Scale — multi-output R/G/B. Bit-identical to the lattice WASM emit. */
function emitColorScale(ctx: AgentWasmCtx, node: GraphNode, portId: string): ValueRef {
  const em = ctx.em;
  const cfg = node.data.config as Record<string, string | number | boolean>;
  const method = (cfg['method'] as string) || 'linear';
  const stops = readColorScaleStops(cfg);
  // Channel table — `a` allocated LAST and only when declared, so the opaque path
  // allocates exactly [rLoc, gLoc, bLoc] and the module bytes are unchanged.
  const withA = colorScaleHasAlpha(cfg);
  const chans: Array<{ loc: number; get: (s: ColorScaleStop) => number }> = [
    { loc: em.allocLocal(I32), get: s => s.r },
    { loc: em.allocLocal(I32), get: s => s.g },
    { loc: em.allocLocal(I32), get: s => s.b },
  ];
  if (withA) chans.push({ loc: em.allocLocal(I32), get: s => s.a ?? 255 });
  const writeConst = (s: ColorScaleStop) => {
    for (const c of chans) { em.i32Const(c.get(s) | 0); em.localSet(c.loc); }
  };
  const ZERO: ColorScaleStop = { p: 0, r: 0, g: 0, b: 0, a: 0 };
  if (stops.length === 0) writeConst(ZERO);
  else if (stops.length === 1) writeConst(stops[0]!);
  else {
    const tLoc = em.allocLocal(F64); pushValueInputF64(ctx, node, 't', 0.5); em.localSet(tLoc);
    const writeSeg = (a: ColorScaleStop, b: ColorScaleStop) => {
      const lt = em.allocLocal(F64);
      em.localGet(tLoc); em.f64Const(a.p); em.op(OP_F64_SUB); em.f64Const(b.p - a.p); em.op(OP_F64_DIV); em.localSet(lt);
      const cv = emitInterpCurve(em, lt, method);
      const chan = (ac: number, bc: number, dst: number) => {
        em.f64Const(ac); em.localGet(cv); em.f64Const(bc - ac); em.op(OP_F64_MUL); em.op(OP_F64_ADD);
        em.f64Const(0.5); em.op(OP_F64_ADD); em.op(OP_F64_FLOOR); em.f64ToI32(); em.localSet(dst);
      };
      // Alpha interpolates on the SAME curve as the colour channels — matching JS.
      for (const c of chans) chan(c.get(a), c.get(b), c.loc);
    };
    const first = stops[0]!;
    em.localGet(tLoc); em.f64Const(first.p); em.op(OP_F64_LE);
    em.ifThenElse(
      () => writeConst(first),
      () => {
        const buildChain = (i: number) => {
          if (i >= stops.length - 1) { writeConst(stops[stops.length - 1]!); return; }
          const a = stops[i]!, b = stops[i + 1]!;
          if (b.p === a.p) { buildChain(i + 1); return; }
          em.localGet(tLoc); em.f64Const(b.p); em.op(OP_F64_LT);
          em.ifThenElse(() => writeSeg(a, b), () => buildChain(i + 1));
        };
        buildChain(0);
      },
    );
  }
  const refs = chans.map(c => ({ localIdx: c.loc, valtype: I32 } as LocalRef));
  const ports = withA ? ['r', 'g', 'b', 'a'] : ['r', 'g', 'b'];
    ports.forEach((p, i) => setCachedPort(ctx, node.id, p, refs[i]!));
  const pi = ports.indexOf(portId);
  return refs[pi >= 0 ? pi : 0]!;
}

/** Categorical Color — multi-output R/G/B (N-way integer-compare select). */
function emitCategoricalColor(ctx: AgentWasmCtx, node: GraphNode, portId: string): ValueRef {
  const em = ctx.em;
  const cfg = node.data.config as Record<string, string | number | boolean>;
  const entries = readCategoricalEntries(cfg);
  const d = readCategoricalDefault(cfg);
  // `a` allocated LAST and only when declared — see the colorScale twin.
  const withA = categoricalHasAlpha(cfg);
  const chans: Array<{ loc: number; get: (e: CategoricalEntry) => number }> = [
    { loc: em.allocLocal(I32), get: e => e.r },
    { loc: em.allocLocal(I32), get: e => e.g },
    { loc: em.allocLocal(I32), get: e => e.b },
  ];
  if (withA) chans.push({ loc: em.allocLocal(I32), get: e => e.a ?? 255 });
  const writeConst = (e: CategoricalEntry) => { for (const c of chans) { em.i32Const(c.get(e) | 0); em.localSet(c.loc); } };
  if (entries.length === 0) writeConst(d);
  else {
    const kLoc = em.allocLocal(I32); pushValueAs(em, resolveValueInput(ctx, node, 'index', 0), I32); em.localSet(kLoc);
    const buildChain = (i: number) => {
      if (i >= entries.length) { writeConst(d); return; }
      const e = entries[i]!;
      em.localGet(kLoc); em.i32Const(i); em.op(OP_I32_EQ);
      em.ifThenElse(() => writeConst(e), () => buildChain(i + 1));
    };
    buildChain(0);
  }
  const refs = chans.map(c => ({ localIdx: c.loc, valtype: I32 } as LocalRef));
  const ports = withA ? ['r', 'g', 'b', 'a'] : ['r', 'g', 'b'];
  ports.forEach((p, i) => setCachedPort(ctx, node.id, p, refs[i]!));
  const pi = ports.indexOf(portId);
  return refs[pi >= 0 ? pi : 0]!;
}

/** Color Constant — three inline i32 channels. */
function emitGetColorConstant(ctx: AgentWasmCtx, node: GraphNode, portId: string): ValueRef {
  const cfg = node.data.config as Record<string, unknown>;
  const r = parseInt(String(cfg['r'] ?? '0'), 10) || 0;
  const g = parseInt(String(cfg['g'] ?? '0'), 10) || 0;
  const b = parseInt(String(cfg['b'] ?? '0'), 10) || 0;
  const rRef: ValueRef = { inline: true, value: r, valtype: I32 };
  const gRef: ValueRef = { inline: true, value: g, valtype: I32 };
  const bRef: ValueRef = { inline: true, value: b, valtype: I32 };
  setCachedPort(ctx, node.id, 'r', rRef); setCachedPort(ctx, node.id, 'g', gRef); setCachedPort(ctx, node.id, 'b', bRef);
  // `a` only when declared — see colorScaleHasAlpha for the byte-identity gate.
  let aRef: ValueRef | null = null;
  if (colorConstantHasAlpha(cfg as Record<string, string | number | boolean>)) {
    aRef = { inline: true, value: parseInt(String(cfg['a'] ?? '255'), 10) || 0, valtype: I32 };
    setCachedPort(ctx, node.id, 'a', aRef);
  }
  return portId === 'g' ? gRef : portId === 'b' ? bRef : (portId === 'a' && aRef) ? aRef : rRef;
}

/** Get Curvature — mean unit-vector magnitude to bonded partners (torus-folded). */
function emitCurvature(ctx: AgentWasmCtx): void {
  const em = ctx.em, L = ctx.layout;
  const idx = ctx.idxLocal;
  const bc = em.allocLocal(I32); pushI32Elem(em, L.i32['bondCount']!, idx); em.localSet(bc);
  const res = em.allocLocal(F64); em.f64Const(0); em.localSet(res);
  // if (bc >= 2) { ... }
  em.localGet(bc); em.i32Const(2); em.op(OP_I32_GE_S);
  em.ifThen(() => {
    const base = em.allocLocal(I32); em.localGet(idx); em.i32Const(L.maxBonds); em.op(OP_I32_MUL); em.localSet(base);
    const sx = em.allocLocal(F64), sy = em.allocLocal(F64), sz = em.allocLocal(F64), cnt = em.allocLocal(I32);
    em.f64Const(0); em.localSet(sx); em.f64Const(0); em.localSet(sy); em.f64Const(0); em.localSet(sz); em.i32Const(0); em.localSet(cnt);
    const k = em.allocLocal(I32); em.i32Const(0); em.localSet(k);
    const bpOff = L.bondI32['bondPartner']!;
    const xi = em.allocLocal(F64), yi = em.allocLocal(F64), zi = em.allocLocal(F64);
    pushF64Elem(em, L.f64['x']!, idx); em.localSet(xi);
    pushF64Elem(em, L.f64['y']!, idx); em.localSet(yi);
    if (ctx.is3d) { pushF64Elem(em, L.f64['z']!, idx); em.localSet(zi); }
    em.block(() => {
      em.loop(() => {
        em.localGet(k); em.localGet(bc); em.op(OP_I32_GE_S); em.brIf(1);
        const p = em.allocLocal(I32);
        em.localGet(base); em.localGet(k); em.op(OP_I32_ADD); em.i32Const(4); em.op(OP_I32_MUL); em.i32Const(bpOff); em.op(OP_I32_ADD); em.i32Load(); em.localSet(p);
        // if (p >= 0 && p < highWater && alive[p]) { ... }
        em.localGet(p); em.i32Const(0); em.op(OP_I32_GE_S);
        em.localGet(p); em.localGet(ctx.highWaterLocal); em.op(OP_I32_LT_S); em.op(OP_I32_AND);
        em.ifThen(() => {
          em.localGet(p); em.i32Const(L.u8['alive']!); em.op(OP_I32_ADD); em.i32Load8U();
          em.ifThen(() => {
            const dx = em.allocLocal(F64), dy = em.allocLocal(F64), dz = em.allocLocal(F64);
            pushF64Elem(em, L.f64['x']!, p); em.localGet(xi); em.op(OP_F64_SUB); em.localSet(dx);
            pushF64Elem(em, L.f64['y']!, p); em.localGet(yi); em.op(OP_F64_SUB); em.localSet(dy);
            if (ctx.is3d) { pushF64Elem(em, L.f64['z']!, p); em.localGet(zi); em.op(OP_F64_SUB); em.localSet(dz); }
            em.localGet(ctx.fieldTorusLocal);
            em.ifThen(() => {
              foldTorus(em, dx, ctx.fieldWLocal); foldTorus(em, dy, ctx.fieldHLocal);
              if (ctx.is3d) foldTorus(em, dz, ctx.fieldDLocal);
            });
            const d = em.allocLocal(F64);
            em.localGet(dx); em.localGet(dx); em.op(OP_F64_MUL);
            em.localGet(dy); em.localGet(dy); em.op(OP_F64_MUL); em.op(OP_F64_ADD);
            if (ctx.is3d) { em.localGet(dz); em.localGet(dz); em.op(OP_F64_MUL); em.op(OP_F64_ADD); }
            em.op(OP_F64_SQRT); em.localSet(d);
            // if (d > 1e-9) { sx += dx/d; sy += dy/d; [sz += dz/d;] cnt++ }
            em.localGet(d); em.f64Const(1e-9); em.op(OP_F64_GT);
            em.ifThen(() => {
              em.localGet(sx); em.localGet(dx); em.localGet(d); em.op(OP_F64_DIV); em.op(OP_F64_ADD); em.localSet(sx);
              em.localGet(sy); em.localGet(dy); em.localGet(d); em.op(OP_F64_DIV); em.op(OP_F64_ADD); em.localSet(sy);
              if (ctx.is3d) { em.localGet(sz); em.localGet(dz); em.localGet(d); em.op(OP_F64_DIV); em.op(OP_F64_ADD); em.localSet(sz); }
              em.localGet(cnt); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(cnt);
            });
          });
        });
        em.localGet(k); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(k);
        em.br(0);
      });
    });
    // res = cnt > 0 ? hypot(sx,sy[,sz]) / cnt : 0
    em.localGet(cnt); em.i32Const(0); em.op(OP_I32_GT_S);
    em.ifThen(() => {
      em.localGet(sx); em.localGet(sx); em.op(OP_F64_MUL);
      em.localGet(sy); em.localGet(sy); em.op(OP_F64_MUL); em.op(OP_F64_ADD);
      if (ctx.is3d) { em.localGet(sz); em.localGet(sz); em.op(OP_F64_MUL); em.op(OP_F64_ADD); }
      em.op(OP_F64_SQRT);
      em.localGet(cnt); em.i32ToF64(); em.op(OP_F64_DIV);
      em.localSet(res);
    });
  });
  em.localGet(res);
}

// ===========================================================================
// Array tier — agent-id / value arrays in scratch. The producers fill a scratch
// slab; consumers (aggregate / group reduce / arrayElement) loop over it.
// ===========================================================================

const AGENT_ARRAY_PRODUCERS = new Set<string>([
  'getNearbyAgents', 'getAgentsInView', 'getBondedAgents', 'getAgentsAttribute',
  'filterAgents', 'joinAgents', 'pickNRandomAgents', 'getVariable',
]);

/** Resolve a value input port that carries an ARRAY. Returns the producer's
 *  AgentArrayRef, OR (for multi-source scalars) materialises them into a fresh
 *  scratch f64 array. Returns null if no array source. */
function resolveInputArray(ctx: AgentWasmCtx, node: GraphNode, portId: string): AgentArrayRef | null {
  const sources = ctx.adj.inputToSources.get(`${node.id}:${portId}`) ?? [];
  if (sources.length === 0) {
    // possibly a single source recorded only in inputToSource
    const single = ctx.adj.inputToSource.get(`${node.id}:${portId}`);
    if (!single) return null;
    return compileArrayNode(ctx, single.nodeId, single.portId);
  }
  if (sources.length === 1) {
    const s = sources[0]!;
    const src = ctx.adj.nodeMap.get(s.nodeId);
    if (src && AGENT_ARRAY_PRODUCERS.has(src.data.nodeType)) {
      return compileArrayNode(ctx, s.nodeId, s.portId);
    }
    // a single SCALAR source → a length-1 array (matches JS `[scalar]`).
    return materialiseScalars(ctx, [s]);
  }
  // multiple scalar sources → a scratch f64 array (matches JS `[s0, s1, ...]`).
  return materialiseScalars(ctx, sources);
}

/** Materialise a list of scalar sources into a fresh f64 scratch array. */
function materialiseScalars(ctx: AgentWasmCtx, sources: Array<{ nodeId: string; portId: string }>): AgentArrayRef {
  const em = ctx.em;
  const lenLocal = em.allocLocal(I32); em.i32Const(sources.length); em.localSet(lenLocal);
  const arr = allocScratch(ctx, lenLocal, 8, true);
  sources.forEach((s, i) => {
    const idxL = em.allocLocal(I32); em.i32Const(i); em.localSet(idxL);
    storeArrayElemAddr(em, arr, idxL);
    pushValueAs(em, compileValueNode(ctx, s.nodeId, s.portId), F64);
    em.f64Store();
  });
  return arr;
}

/** Compile an array-producing node + return its ArrayRef (memoised, like values). */
function compileArrayNode(ctx: AgentWasmCtx, nodeId: string, portId: string): AgentArrayRef {
  const key = `${nodeId}:${portId === 'result' || portId === 'value' || portId === 'agents' || portId === 'values' || portId === 'picked' ? 'arr' : portId}`;
  const cached = ctx.arrayCache.get(key);
  if (cached !== undefined) return cached;
  const node = ctx.adj.nodeMap.get(nodeId);
  if (!node) throw new Error(`agentWasm: missing array node ${nodeId}`);
  const type = node.data.nodeType;
  let ref: AgentArrayRef;
  switch (type) {
    case 'getNearbyAgents':
    case 'getAgentsInView': {
      // Get Agents In View reuses the SAME gather + injects a cone test (below);
      // Get Nearby Agents (no cone) is byte-identical to before.
      const { baseLocal, lenLocal } = emitNearbyFill(ctx, node);
      ref = { offsetLocal: baseLocal, lenLocal, elemBytes: 4, isF64: false };
      break;
    }
    case 'getBondedAgents': ref = emitBondedAgents(ctx, node); break;
    case 'getAgentsAttribute': ref = emitAgentsAttribute(ctx, node); break;
    case 'filterAgents': ref = emitFilterAgents(ctx, node); break;
    case 'joinAgents': ref = emitJoinAgents(ctx, node); break;
    case 'pickNRandomAgents': ref = emitPickNRandomAgents(ctx, node); break;
    case 'getVariable': {
      const variableId = (node.data.config?.['variableId'] as string) || '';
      const v = ctx.arrayVarLocals.get(variableId);
      if (!v) { const lenL = ctx.em.allocLocal(I32); ctx.em.i32Const(0); ctx.em.localSet(lenL); ref = allocScratch(ctx, lenL, 8, true); }
      else ref = v;
      break;
    }
    case 'valueSwitch': ref = emitValueSwitchArray(ctx, node); break;
    default:
      throw new Error(`agentWasm: '${type}' is not an array producer`);
  }
  ctx.arrayCache.set(key, ref);
  return ref;
}

/** Get Bonded Agents — this agent's live bonded partner ids. */
function emitBondedAgents(ctx: AgentWasmCtx, _node: GraphNode): AgentArrayRef {
  const em = ctx.em, L = ctx.layout;
  const bc = em.allocLocal(I32); pushI32Elem(em, L.i32['bondCount']!, ctx.idxLocal); em.localSet(bc);
  // worst-case len = bondCount; allocate scratch sized maxBonds (an upper bound)
  const cap = em.allocLocal(I32); em.i32Const(L.maxBonds); em.localSet(cap);
  const arr = allocScratch(ctx, cap, 4, false);
  const lenLocal = em.allocLocal(I32); em.i32Const(0); em.localSet(lenLocal);
  const base = em.allocLocal(I32); em.localGet(ctx.idxLocal); em.i32Const(L.maxBonds); em.op(OP_I32_MUL); em.localSet(base);
  const bpOff = L.bondI32['bondPartner']!;
  const k = em.allocLocal(I32); em.i32Const(0); em.localSet(k);
  em.block(() => {
    em.loop(() => {
      em.localGet(k); em.localGet(bc); em.op(OP_I32_GE_S); em.brIf(1);
      const p = em.allocLocal(I32);
      em.localGet(base); em.localGet(k); em.op(OP_I32_ADD); em.i32Const(4); em.op(OP_I32_MUL); em.i32Const(bpOff); em.op(OP_I32_ADD); em.i32Load(); em.localSet(p);
      // if (p >= 0 && p < highWater && alive[p]) scratch[len++] = p
      em.localGet(p); em.i32Const(0); em.op(OP_I32_GE_S);
      em.localGet(p); em.localGet(ctx.highWaterLocal); em.op(OP_I32_LT_S); em.op(OP_I32_AND);
      em.ifThen(() => {
        em.localGet(p); em.i32Const(L.u8['alive']!); em.op(OP_I32_ADD); em.i32Load8U();
        em.ifThen(() => {
          storeArrayElemAddr(em, arr, lenLocal); em.localGet(p); em.i32Store();
          em.localGet(lenLocal); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(lenLocal);
        });
      });
      em.localGet(k); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(k);
      em.br(0);
    });
  });
  return { offsetLocal: arr.offsetLocal, lenLocal, elemBytes: 4, isF64: false };
}

/** Get Agents Attribute — gather one attr over an id array → an f64 value array.
 *  Skips empty(-1)/dead/oob ids (matches the JS guard). */
function emitAgentsAttribute(ctx: AgentWasmCtx, node: GraphNode): AgentArrayRef {
  const em = ctx.em;
  const attrId = (node.data.config?.['attributeId'] as string) || '';
  const inArr = resolveInputArray(ctx, node, 'agents');
  if (!inArr) { const lenL = em.allocLocal(I32); em.i32Const(0); em.localSet(lenL); return allocScratch(ctx, lenL, 8, true); }
  const out = allocScratch(ctx, inArr.lenLocal, 8, true);
  const outLen = em.allocLocal(I32); em.i32Const(0); em.localSet(outLen);
  const gi = em.allocLocal(I32); em.i32Const(0); em.localSet(gi);
  em.block(() => {
    em.loop(() => {
      em.localGet(gi); em.localGet(inArr.lenLocal); em.op(OP_I32_GE_S); em.brIf(1);
      const a = em.allocLocal(I32); pushArrayElemI32(em, inArr, gi); em.localSet(a);
      // if (a >= 0 && a < highWater && alive[a]) out[outLen++] = r_attr[a]
      em.localGet(a); em.i32Const(0); em.op(OP_I32_GE_S);
      em.localGet(a); em.localGet(ctx.highWaterLocal); em.op(OP_I32_LT_S); em.op(OP_I32_AND);
      em.ifThen(() => {
        em.localGet(a); em.i32Const(ctx.layout.u8['alive']!); em.op(OP_I32_ADD); em.i32Load8U();
        em.ifThen(() => {
          storeArrayElemAddr(em, out, outLen);
          pushAgentAttrReadF64(ctx, attrId, a);
          em.f64Store();
          em.localGet(outLen); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(outLen);
        });
      });
      em.localGet(gi); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(gi);
      em.br(0);
    });
  });
  return { offsetLocal: out.offsetLocal, lenLocal: outLen, elemBytes: 8, isF64: true };
}

/** Filter Agents — keep ids whose attribute satisfies the comparison. Multi-output
 *  (result + count). */
function emitFilterAgents(ctx: AgentWasmCtx, node: GraphNode): AgentArrayRef {
  const em = ctx.em;
  const cfg = node.data.config as Record<string, unknown>;
  const attrId = (cfg['attributeId'] as string) || '';
  const op = (cfg['operation'] as string) || 'equals';
  const inArr = resolveInputArray(ctx, node, 'agents');
  if (!inArr) { const lenL = em.allocLocal(I32); em.i32Const(0); em.localSet(lenL); const e = allocScratch(ctx, lenL, 4, false); setCachedPort(ctx, node.id, 'count', { localIdx: lenL, valtype: I32 }); return e; }
  const out = allocScratch(ctx, inArr.lenLocal, 4, false);
  const outLen = em.allocLocal(I32); em.i32Const(0); em.localSet(outLen);
  const cmp = em.allocLocal(F64); pushValueInputF64(ctx, node, 'compare', 0); em.localSet(cmp);
  const fi = em.allocLocal(I32); em.i32Const(0); em.localSet(fi);
  em.block(() => {
    em.loop(() => {
      em.localGet(fi); em.localGet(inArr.lenLocal); em.op(OP_I32_GE_S); em.brIf(1);
      const a = em.allocLocal(I32); pushArrayElemI32(em, inArr, fi); em.localSet(a);
      em.localGet(a); em.i32Const(0); em.op(OP_I32_GE_S);
      em.localGet(a); em.localGet(ctx.highWaterLocal); em.op(OP_I32_LT_S); em.op(OP_I32_AND);
      em.ifThen(() => {
        em.localGet(a); em.i32Const(ctx.layout.u8['alive']!); em.op(OP_I32_ADD); em.i32Load8U();
        em.ifThen(() => {
          // attr OP cmp ?
          pushAgentAttrReadF64(ctx, attrId, a); em.localGet(cmp); emitCompareOp(em, op);
          em.ifThen(() => {
            storeArrayElemAddr(em, out, outLen); em.localGet(a); em.i32Store();
            em.localGet(outLen); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(outLen);
          });
        });
      });
      em.localGet(fi); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(fi);
      em.br(0);
    });
  });
  setCachedPort(ctx, node.id, 'count', { localIdx: outLen, valtype: I32 });
  return { offsetLocal: out.offsetLocal, lenLocal: outLen, elemBytes: 4, isF64: false };
}

/** Join Agents — union / intersection of two id arrays (dedup, skip -1). */
function emitJoinAgents(ctx: AgentWasmCtx, node: GraphNode): AgentArrayRef {
  const em = ctx.em;
  const op = (node.data.config?.['operation'] as string) || 'union';
  const a = resolveInputArray(ctx, node, 'a');
  const b = resolveInputArray(ctx, node, 'b');
  const aLen = a ? a.lenLocal : (() => { const l = em.allocLocal(I32); em.i32Const(0); em.localSet(l); return l; })();
  const bLen = b ? b.lenLocal : (() => { const l = em.allocLocal(I32); em.i32Const(0); em.localSet(l); return l; })();
  // worst-case capacity = aLen + bLen
  const cap = em.allocLocal(I32); em.localGet(aLen); em.localGet(bLen); em.op(OP_I32_ADD); em.localSet(cap);
  const out = allocScratch(ctx, cap, 4, false);
  const outLen = em.allocLocal(I32); em.i32Const(0); em.localSet(outLen);
  // contains(x): linear scan of out[0..outLen)
  const containsOut = (xLocal: number): void => {
    // pushes i32 1/0
    const found = em.allocLocal(I32); em.i32Const(0); em.localSet(found);
    const c = em.allocLocal(I32); em.i32Const(0); em.localSet(c);
    em.block(() => { em.loop(() => {
      em.localGet(c); em.localGet(outLen); em.op(OP_I32_GE_S); em.brIf(1);
      const e = em.allocLocal(I32); pushArrayElemI32(em, out, c); em.localSet(e);
      em.localGet(e); em.localGet(xLocal); em.op(OP_I32_EQ);
      em.ifThen(() => { em.i32Const(1); em.localSet(found); });
      em.localGet(c); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(c);
      em.br(0);
    }); });
    em.localGet(found);
  };
  const containsArr = (arr: AgentArrayRef, xLocal: number): void => {
    const found = em.allocLocal(I32); em.i32Const(0); em.localSet(found);
    const c = em.allocLocal(I32); em.i32Const(0); em.localSet(c);
    em.block(() => { em.loop(() => {
      em.localGet(c); em.localGet(arr.lenLocal); em.op(OP_I32_GE_S); em.brIf(1);
      const e = em.allocLocal(I32); pushArrayElemI32(em, arr, c); em.localSet(e);
      em.localGet(e); em.localGet(xLocal); em.op(OP_I32_EQ);
      em.ifThen(() => { em.i32Const(1); em.localSet(found); });
      em.localGet(c); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(c);
      em.br(0);
    }); });
    em.localGet(found);
  };
  const pushFrom = (arr: AgentArrayRef | null, requireInOther: AgentArrayRef | null) => {
    if (!arr) return;
    const k = em.allocLocal(I32); em.i32Const(0); em.localSet(k);
    em.block(() => { em.loop(() => {
      em.localGet(k); em.localGet(arr.lenLocal); em.op(OP_I32_GE_S); em.brIf(1);
      const x = em.allocLocal(I32); pushArrayElemI32(em, arr, k); em.localSet(x);
      // if (x !== -1 && !contains(out, x) && (requireInOther ? contains(other,x) : true))
      em.localGet(x); em.i32Const(-1); em.op(OP_I32_NE);
      em.ifThen(() => {
        containsOut(x); em.op(OP_I32_EQZ);
        em.ifThen(() => {
          const doPush = () => { storeArrayElemAddr(em, out, outLen); em.localGet(x); em.i32Store(); em.localGet(outLen); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(outLen); };
          if (requireInOther) { containsArr(requireInOther, x); em.ifThen(doPush); }
          else doPush();
        });
      });
      em.localGet(k); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(k);
      em.br(0);
    }); });
  };
  if (op === 'intersection') {
    // for each x in a, if x in b → push
    pushFrom(a, b);
  } else {
    pushFrom(a, null); pushFrom(b, null);
  }
  setCachedPort(ctx, node.id, 'count', { localIdx: outLen, valtype: I32 });
  return { offsetLocal: out.offsetLocal, lenLocal: outLen, elemBytes: 4, isF64: false };
}

/** Pick N Random Agents — partial Fisher-Yates over the shared `_rs` stream. */
function emitPickNRandomAgents(ctx: AgentWasmCtx, node: GraphNode): AgentArrayRef {
  const em = ctx.em, rs = ctx.rsLocal;
  const inArr = resolveInputArray(ctx, node, 'agents');
  if (!inArr) { const lenL = em.allocLocal(I32); em.i32Const(0); em.localSet(lenL); return allocScratch(ctx, lenL, 4, false); }
  const n = em.allocLocal(I32); pushValueAs(em, resolveValueInput(ctx, node, 'n', 1), I32); em.localSet(n);
  // k = min(max(n,0), len). ifThenElse blocks are empty-type → store into k inside.
  const k = em.allocLocal(I32);
  em.localGet(n); em.i32Const(0); em.op(OP_I32_GT_S); em.ifThenElse(() => { em.localGet(n); em.localSet(k); }, () => { em.i32Const(0); em.localSet(k); });
  em.localGet(k); em.localGet(inArr.lenLocal); em.op(OP_I32_GT_S); em.ifThen(() => { em.localGet(inArr.lenLocal); em.localSet(k); });
  // work = copy of input (i32)
  const work = allocScratch(ctx, inArr.lenLocal, 4, false);
  const ci = em.allocLocal(I32); em.i32Const(0); em.localSet(ci);
  em.block(() => { em.loop(() => {
    em.localGet(ci); em.localGet(inArr.lenLocal); em.op(OP_I32_GE_S); em.brIf(1);
    storeArrayElemAddr(em, work, ci); pushArrayElemI32(em, inArr, ci); em.i32Store();
    em.localGet(ci); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(ci);
    em.br(0);
  }); });
  const out = allocScratch(ctx, k, 4, false);
  const pi = em.allocLocal(I32); em.i32Const(0); em.localSet(pi);
  em.block(() => { em.loop(() => {
    em.localGet(pi); em.localGet(k); em.op(OP_I32_GE_S); em.brIf(1);
    emitRngAdvance(em, rs);
    // j = pi + floor((rs/2^32) * (len - pi))
    const j = em.allocLocal(I32);
    em.localGet(rs); em.op(OP_F64_CONVERT_I32_U); em.f64Const(4294967296); em.op(OP_F64_DIV);
    em.localGet(inArr.lenLocal); em.localGet(pi); em.op(OP_I32_SUB); em.i32ToF64(); em.op(OP_F64_MUL); em.op(OP_F64_FLOOR); em.f64ToI32();
    em.localGet(pi); em.op(OP_I32_ADD); em.localSet(j);
    // swap work[pi] <-> work[j]
    const tmp = em.allocLocal(I32); pushArrayElemI32(em, work, pi); em.localSet(tmp);
    storeArrayElemAddr(em, work, pi); pushArrayElemI32(em, work, j); em.i32Store();
    storeArrayElemAddr(em, work, j); em.localGet(tmp); em.i32Store();
    // out[pi] = work[pi]
    storeArrayElemAddr(em, out, pi); pushArrayElemI32(em, work, pi); em.i32Store();
    em.localGet(pi); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(pi);
    em.br(0);
  }); });
  return { offsetLocal: out.offsetLocal, lenLocal: k, elemBytes: 4, isF64: false };
}

/** valueSwitch array mode — zero-copy OP_SELECT of the two branch arrays. */
function emitValueSwitchArray(ctx: AgentWasmCtx, node: GraphNode): AgentArrayRef {
  const em = ctx.em;
  const ifA = resolveInputArray(ctx, node, 'ifValue');
  const elA = resolveInputArray(ctx, node, 'elseValue');
  if (!ifA || !elA) {
    const lenL = em.allocLocal(I32); em.i32Const(0); em.localSet(lenL);
    return allocScratch(ctx, lenL, 8, true);
  }
  const cond = em.allocLocal(I32);
  pushValueAs(em, resolveValueInput(ctx, node, 'condition', 0), F64); em.f64Const(0); em.op(OP_F64_NE); em.localSet(cond);
  const offL = em.allocLocal(I32), lenL = em.allocLocal(I32);
  em.localGet(ifA.offsetLocal); em.localGet(elA.offsetLocal); em.localGet(cond); em.op(OP_SELECT); em.localSet(offL);
  em.localGet(ifA.lenLocal); em.localGet(elA.lenLocal); em.localGet(cond); em.op(OP_SELECT); em.localSet(lenL);
  return { offsetLocal: offL, lenLocal: lenL, elemBytes: ifA.elemBytes, isF64: ifA.isF64 };
}

/** Advance the shared xorshift32 `_rs` (in-register), JS-bit-parity (13/17/5). */
function emitRngAdvance(em: WasmEmitter, rs: number): void {
  em.localGet(rs); em.localGet(rs); em.i32Const(13); em.op(OP_I32_SHL); em.op(OP_I32_XOR); em.localSet(rs);
  em.localGet(rs); em.localGet(rs); em.i32Const(17); em.op(OP_I32_SHR_U); em.op(OP_I32_XOR); em.localSet(rs);
  em.localGet(rs); em.localGet(rs); em.i32Const(5); em.op(OP_I32_SHL); em.op(OP_I32_XOR); em.localSet(rs);
}

/** Emit an f64 comparison op (a, b already on stack) → i32 1/0. Op names match the
 *  filter / compare nodes. */
function emitCompareOp(em: WasmEmitter, op: string): void {
  switch (op) {
    case 'notEquals': case '!=': em.op(OP_F64_NE); break;
    case 'greater': case '>': em.op(OP_F64_GT); break;
    case 'lesser': case '<': em.op(OP_F64_LT); break;
    case 'greaterEqual': case '>=': em.op(OP_F64_GE); break;
    case 'lesserEqual': case '<=': em.op(OP_F64_LE); break;
    default: em.op(OP_F64_EQ); break;   // equals / ==
  }
}

/** Pick Random Agent — uniform pick from an id array (-1 when empty). The input
 *  array resolves BEFORE the RNG advance: a chained RNG-consuming producer
 *  (e.g. pickNRandomAgents) must draw first, matching JS's value-dep order. */
function emitPickRandomAgent(ctx: AgentWasmCtx, node: GraphNode): void {
  const em = ctx.em, rs = ctx.rsLocal;
  const inArr = resolveInputArray(ctx, node, 'agents');
  emitRngAdvance(em, rs);
  const res = em.allocLocal(F64); em.f64Const(-1); em.localSet(res);
  if (!inArr) { em.localGet(res); return; }
  em.localGet(inArr.lenLocal); em.i32Const(0); em.op(OP_I32_GT_S);
  em.ifThen(() => {
    const pick = em.allocLocal(I32);
    em.localGet(rs); em.op(OP_F64_CONVERT_I32_U); em.f64Const(4294967296); em.op(OP_F64_DIV);
    em.localGet(inArr.lenLocal); em.i32ToF64(); em.op(OP_F64_MUL); em.op(OP_F64_FLOOR); em.f64ToI32(); em.localSet(pick);
    pushArrayElemI32(em, inArr, pick); em.i32ToF64(); em.localSet(res);
  });
  em.localGet(res);
}

/** Get Array Element — `arr[index]` (0/-1 default oob, matching JS). */
function emitArrayElement(ctx: AgentWasmCtx, node: GraphNode): ValueRef {
  const em = ctx.em;
  const arr = resolveInputArray(ctx, node, 'array');
  const idxL = em.allocLocal(I32); pushValueAs(em, resolveValueInput(ctx, node, 'position', 0), I32); em.localSet(idxL);
  const res = em.allocLocal(F64); em.f64Const(0); em.localSet(res);
  if (!arr) return { localIdx: res, valtype: F64 };
  em.localGet(idxL); em.i32Const(0); em.op(OP_I32_GE_S);
  em.localGet(idxL); em.localGet(arr.lenLocal); em.op(OP_I32_LT_S); em.op(OP_I32_AND);
  em.ifThen(() => { pushArrayElemF64(em, arr, idxL); em.localSet(res); });
  return { localIdx: res, valtype: F64 };
}

/** Aggregate / Group Reduce / Group Counting / Group Statement over an array. The
 *  array `values` is resolved via resolveInputArray. Bit-parity with the JS nodes
 *  (op-by-op). groupOperator is multi-output (result + index/position). */
function emitArrayReduce(ctx: AgentWasmCtx, node: GraphNode, portId: string): ValueRef {
  const em = ctx.em;
  const type = node.data.nodeType;
  const cfg = node.data.config as Record<string, unknown>;
  const op = (cfg['operation'] as string) || 'sum';
  const arr = resolveInputArray(ctx, node, type === 'groupStatement' || type === 'groupCounting' ? 'values' : 'values');
  const empty = (): AgentArrayRef => { const lenL = em.allocLocal(I32); em.i32Const(0); em.localSet(lenL); return allocScratch(ctx, lenL, 8, true); };
  const a = arr ?? empty();

  if (type === 'groupOperator') return emitGroupOperator(ctx, node, a, op, portId);
  if (type === 'groupStatement') return { localIdx: emitGroupStatement(ctx, node, a, op), valtype: F64 };
  if (type === 'groupCounting') return { localIdx: emitGroupCounting(ctx, node, a, op), valtype: F64 };
  // aggregate
  return { localIdx: emitAggregate(ctx, a, op), valtype: F64 };
}

/** Aggregate (sum/product/max/min/average/median/and/or) — f64 result. */
function emitAggregate(ctx: AgentWasmCtx, a: AgentArrayRef, op: string): number {
  const em = ctx.em;
  const acc = em.allocLocal(F64);
  const i = em.allocLocal(I32);
  const loopAccum = (init: number, body: () => void) => {
    em.f64Const(init); em.localSet(acc);
    em.i32Const(0); em.localSet(i);
    em.block(() => { em.loop(() => {
      em.localGet(i); em.localGet(a.lenLocal); em.op(OP_I32_GE_S); em.brIf(1);
      body();
      em.localGet(i); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(i);
      em.br(0);
    }); });
  };
  switch (op) {
    case 'product': loopAccum(1, () => { em.localGet(acc); pushArrayElemF64(em, a, i); em.op(OP_F64_MUL); em.localSet(acc); }); break;
    case 'max': loopAccum(-Infinity, () => { em.localGet(acc); pushArrayElemF64(em, a, i); em.op(OP_F64_MAX); em.localSet(acc); }); break;
    case 'min': loopAccum(Infinity, () => { em.localGet(acc); pushArrayElemF64(em, a, i); em.op(OP_F64_MIN); em.localSet(acc); }); break;
    case 'average': {
      loopAccum(0, () => { em.localGet(acc); pushArrayElemF64(em, a, i); em.op(OP_F64_ADD); em.localSet(acc); });
      // acc = len>0 ? acc/len : 0
      em.localGet(a.lenLocal); em.i32Const(0); em.op(OP_I32_GT_S);
      em.ifThenElse(() => { em.localGet(acc); em.localGet(a.lenLocal); em.i32ToF64(); em.op(OP_F64_DIV); em.localSet(acc); }, () => { em.f64Const(0); em.localSet(acc); });
      break;
    }
    case 'and': {
      // acc=1; loop: if (!arr[i]) { acc=0; break }
      em.f64Const(1); em.localSet(acc); em.i32Const(0); em.localSet(i);
      em.block(() => { em.loop(() => {
        em.localGet(i); em.localGet(a.lenLocal); em.op(OP_I32_GE_S); em.brIf(1);
        pushArrayElemF64(em, a, i); em.f64Const(0); em.op(OP_F64_EQ);
        em.ifThen(() => { em.f64Const(0); em.localSet(acc); em.br(2); });
        em.localGet(i); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(i); em.br(0);
      }); });
      break;
    }
    case 'or': {
      em.f64Const(0); em.localSet(acc); em.i32Const(0); em.localSet(i);
      em.block(() => { em.loop(() => {
        em.localGet(i); em.localGet(a.lenLocal); em.op(OP_I32_GE_S); em.brIf(1);
        pushArrayElemF64(em, a, i); em.f64Const(0); em.op(OP_F64_NE);
        em.ifThen(() => { em.f64Const(1); em.localSet(acc); em.br(2); });
        em.localGet(i); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(i); em.br(0);
      }); });
      break;
    }
    case 'median': emitMedian(ctx, a, acc); break;
    default: loopAccum(0, () => { em.localGet(acc); pushArrayElemF64(em, a, i); em.op(OP_F64_ADD); em.localSet(acc); }); break;
  }
  return acc;
}

/** Median — copy to a fresh f64 scratch, insertion-sort, take the middle (the JS
 *  `slice().sort((a,b)=>a-b)` + even/odd average). */
function emitMedian(ctx: AgentWasmCtx, a: AgentArrayRef, accLocal: number): void {
  const em = ctx.em;
  const work = allocScratch(ctx, a.lenLocal, 8, true);
  const ci = em.allocLocal(I32); em.i32Const(0); em.localSet(ci);
  em.block(() => { em.loop(() => {
    em.localGet(ci); em.localGet(a.lenLocal); em.op(OP_I32_GE_S); em.brIf(1);
    storeArrayElemAddr(em, work, ci); pushArrayElemF64(em, a, ci); em.f64Store();
    em.localGet(ci); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(ci); em.br(0);
  }); });
  // insertion sort work[0..len)
  const ii = em.allocLocal(I32), jj = em.allocLocal(I32), key = em.allocLocal(F64), cur = em.allocLocal(F64);
  em.i32Const(1); em.localSet(ii);
  em.block(() => { em.loop(() => {
    em.localGet(ii); em.localGet(a.lenLocal); em.op(OP_I32_GE_S); em.brIf(1);
    pushArrayElemF64(em, work, ii); em.localSet(key);
    em.localGet(ii); em.i32Const(1); em.op(OP_I32_SUB); em.localSet(jj);
    em.block(() => { em.loop(() => {
      // while (jj >= 0 && work[jj] > key)
      em.localGet(jj); em.i32Const(0); em.op(OP_I32_LT_S); em.brIf(1);
      pushArrayElemF64(em, work, jj); em.localSet(cur);
      em.localGet(cur); em.localGet(key); em.op(OP_F64_LE); em.brIf(1);
      // work[jj+1] = work[jj]
      const jp = em.allocLocal(I32); em.localGet(jj); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(jp);
      storeArrayElemAddr(em, work, jp); em.localGet(cur); em.f64Store();
      em.localGet(jj); em.i32Const(1); em.op(OP_I32_SUB); em.localSet(jj);
      em.br(0);
    }); });
    const jp2 = em.allocLocal(I32); em.localGet(jj); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(jp2);
    storeArrayElemAddr(em, work, jp2); em.localGet(key); em.f64Store();
    em.localGet(ii); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(ii); em.br(0);
  }); });
  // acc = len===0 ? 0 : (len%2===0 ? (w[len/2-1]+w[len/2])/2 : w[(len-1)/2])
  em.f64Const(0); em.localSet(accLocal);
  em.localGet(a.lenLocal); em.i32Const(0); em.op(OP_I32_GT_S);
  em.ifThen(() => {
    const half = em.allocLocal(I32); em.localGet(a.lenLocal); em.i32Const(2); em.op(OP_I32_DIV_S); em.localSet(half);
    em.localGet(a.lenLocal); em.i32Const(2); em.op(OP_I32_REM_S); em.i32Const(0); em.op(OP_I32_EQ);
    em.ifThenElse(
      () => {
        const hm1 = em.allocLocal(I32); em.localGet(half); em.i32Const(1); em.op(OP_I32_SUB); em.localSet(hm1);
        pushArrayElemF64(em, work, hm1); pushArrayElemF64(em, work, half); em.op(OP_F64_ADD); em.f64Const(2); em.op(OP_F64_DIV); em.localSet(accLocal);
      },
      () => {
        const mid = em.allocLocal(I32); em.localGet(a.lenLocal); em.i32Const(1); em.op(OP_I32_SUB); em.i32Const(2); em.op(OP_I32_DIV_S); em.localSet(mid);
        pushArrayElemF64(em, work, mid); em.localSet(accLocal);
      },
    );
  });
}

/** Group Reduce — multi-output (result + index). Bit-parity with GroupOperatorNode. */
function emitGroupOperator(ctx: AgentWasmCtx, node: GraphNode, a: AgentArrayRef, op: string, portId: string): ValueRef {
  const em = ctx.em, rs = ctx.rsLocal;
  const resLoc = em.allocLocal(F64), idxLoc = em.allocLocal(I32);
  const finish = (): ValueRef => {
    setCachedPort(ctx, node.id, 'result', { localIdx: resLoc, valtype: F64 });
    setCachedPort(ctx, node.id, 'index', { localIdx: idxLoc, valtype: I32 });
    setCachedPort(ctx, node.id, 'position', { localIdx: idxLoc, valtype: I32 });
    return portId === 'index' || portId === 'position' ? { localIdx: idxLoc, valtype: I32 } : { localIdx: resLoc, valtype: F64 };
  };
  if (op === 'random') {
    emitRngAdvance(em, rs);
    em.i32Const(-1); em.localSet(idxLoc); em.f64Const(0); em.localSet(resLoc);
    em.localGet(a.lenLocal); em.i32Const(0); em.op(OP_I32_GT_S);
    em.ifThen(() => {
      em.localGet(rs); em.op(OP_F64_CONVERT_I32_U); em.f64Const(4294967296); em.op(OP_F64_DIV);
      em.localGet(a.lenLocal); em.i32ToF64(); em.op(OP_F64_MUL); em.op(OP_F64_FLOOR); em.f64ToI32(); em.localSet(idxLoc);
      pushArrayElemF64(em, a, idxLoc); em.localSet(resLoc);
    });
    return finish();
  }
  if (op === 'weightedRandom') {
    emitRngAdvance(em, rs);
    const sum = em.allocLocal(F64); em.f64Const(0); em.localSet(sum);
    const gi = em.allocLocal(I32); em.i32Const(0); em.localSet(gi);
    em.block(() => { em.loop(() => {
      em.localGet(gi); em.localGet(a.lenLocal); em.op(OP_I32_GE_S); em.brIf(1);
      em.localGet(sum); pushArrayElemF64(em, a, gi); em.op(OP_F64_ADD); em.localSet(sum);
      em.localGet(gi); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(gi); em.br(0);
    }); });
    em.i32Const(-1); em.localSet(idxLoc); em.f64Const(0); em.localSet(resLoc);
    em.localGet(sum); em.f64Const(0); em.op(OP_F64_GT);
    em.ifThen(() => {
      const u = em.allocLocal(F64); em.localGet(rs); em.op(OP_F64_CONVERT_I32_U); em.f64Const(4294967296); em.op(OP_F64_DIV); em.localGet(sum); em.op(OP_F64_MUL); em.localSet(u);
      const acc = em.allocLocal(F64); em.f64Const(0); em.localSet(acc);
      const gj = em.allocLocal(I32); em.i32Const(0); em.localSet(gj);
      em.block(() => { em.loop(() => {
        em.localGet(gj); em.localGet(a.lenLocal); em.op(OP_I32_GE_S); em.brIf(1);
        em.localGet(acc); pushArrayElemF64(em, a, gj); em.op(OP_F64_ADD); em.localSet(acc);
        em.localGet(u); em.localGet(acc); em.op(OP_F64_LT);
        em.ifThen(() => { em.localGet(gj); em.localSet(idxLoc); pushArrayElemF64(em, a, gj); em.localSet(resLoc); em.br(2); });
        em.localGet(gj); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(gj); em.br(0);
      }); });
      // fallback: if (idx < 0) idx = len-1; result = arr[len-1]
      em.localGet(idxLoc); em.i32Const(0); em.op(OP_I32_LT_S);
      em.ifThen(() => {
        const lm1 = em.allocLocal(I32); em.localGet(a.lenLocal); em.i32Const(1); em.op(OP_I32_SUB); em.localSet(lm1);
        em.localGet(lm1); em.localSet(idxLoc); pushArrayElemF64(em, a, lm1); em.localSet(resLoc);
      });
    });
    return finish();
  }
  if (op === 'max' || op === 'min') {
    const cmp = op === 'max' ? OP_F64_GT : OP_F64_LT;
    em.i32Const(0); em.localSet(idxLoc);
    const gi = em.allocLocal(I32); em.i32Const(1); em.localSet(gi);
    em.block(() => { em.loop(() => {
      em.localGet(gi); em.localGet(a.lenLocal); em.op(OP_I32_GE_S); em.brIf(1);
      pushArrayElemF64(em, a, gi); pushArrayElemF64(em, a, idxLoc); em.op(cmp);
      em.ifThen(() => { em.localGet(gi); em.localSet(idxLoc); });
      em.localGet(gi); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(gi); em.br(0);
    }); });
    // result = arr[idx] (when empty, idx stays 0 and arr[0] is oob → 0; JS reads undefined
    // → NaN, but the position-ops are hidden/unused on empty; mirror len>0 guard)
    em.f64Const(0); em.localSet(resLoc);
    em.localGet(a.lenLocal); em.i32Const(0); em.op(OP_I32_GT_S);
    em.ifThen(() => { pushArrayElemF64(em, a, idxLoc); em.localSet(resLoc); });
    return finish();
  }
  // sum/mul/mean/and/or — index = -1
  em.i32Const(-1); em.localSet(idxLoc);
  const acc = em.allocLocal(F64);
  const i = em.allocLocal(I32);
  const reduce = (init: number, mulCombine: boolean, addCombine: boolean) => {
    em.f64Const(init); em.localSet(acc); em.i32Const(0); em.localSet(i);
    em.block(() => { em.loop(() => {
      em.localGet(i); em.localGet(a.lenLocal); em.op(OP_I32_GE_S); em.brIf(1);
      em.localGet(acc); pushArrayElemF64(em, a, i); em.op(mulCombine ? OP_F64_MUL : OP_F64_ADD); em.localSet(acc);
      em.localGet(i); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(i); em.br(0);
    }); });
    void addCombine;
  };
  switch (op) {
    case 'mul': reduce(1, true, false); break;
    case 'mean': {
      reduce(0, false, true);
      // acc / (len || 1)
      const denom = em.allocLocal(F64);
      em.localGet(a.lenLocal); em.i32Const(0); em.op(OP_I32_GT_S);
      em.ifThenElse(() => { em.localGet(a.lenLocal); em.i32ToF64(); em.localSet(denom); }, () => { em.f64Const(1); em.localSet(denom); });
      em.localGet(acc); em.localGet(denom); em.op(OP_F64_DIV); em.localSet(acc);
      break;
    }
    case 'and': {
      // every(Boolean) ? 1 : 0
      em.f64Const(1); em.localSet(acc); em.i32Const(0); em.localSet(i);
      em.block(() => { em.loop(() => {
        em.localGet(i); em.localGet(a.lenLocal); em.op(OP_I32_GE_S); em.brIf(1);
        pushArrayElemF64(em, a, i); em.f64Const(0); em.op(OP_F64_EQ);
        em.ifThen(() => { em.f64Const(0); em.localSet(acc); em.br(2); });
        em.localGet(i); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(i); em.br(0);
      }); });
      break;
    }
    case 'or': {
      em.f64Const(0); em.localSet(acc); em.i32Const(0); em.localSet(i);
      em.block(() => { em.loop(() => {
        em.localGet(i); em.localGet(a.lenLocal); em.op(OP_I32_GE_S); em.brIf(1);
        pushArrayElemF64(em, a, i); em.f64Const(0); em.op(OP_F64_NE);
        em.ifThen(() => { em.f64Const(1); em.localSet(acc); em.br(2); });
        em.localGet(i); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(i); em.br(0);
      }); });
      break;
    }
    default: reduce(0, false, true); break;  // sum
  }
  em.localGet(acc); em.localSet(resLoc);
  return finish();
}

/** Group Counting — count elements satisfying the comparison op. */
function emitGroupCounting(ctx: AgentWasmCtx, node: GraphNode, a: AgentArrayRef, op: string): number {
  const em = ctx.em;
  const cfg = node.data.config as Record<string, unknown>;
  const cnt = em.allocLocal(I32); em.i32Const(0); em.localSet(cnt);
  const i = em.allocLocal(I32); em.i32Const(0); em.localSet(i);
  // The operand ports are `compare` / `compareHigh` — the ids GroupCountingNode
  // DECLARES and the JS emitter reads. (They were `value` / `value2` here, which
  // no port carries, so a WIRED comparison silently fell back to 0 on WASM while
  // JS read the real value — a latent cross-target divergence; no shipped model
  // used groupCounting on the AGENT graph, which is why it stayed hidden.)
  const lo = em.allocLocal(F64); pushValueInputF64(ctx, node, 'compare', 0); em.localSet(lo);
  const hi = em.allocLocal(F64);
  const isBetween = op === 'between' || op === 'notBetween';
  if (isBetween) { pushValueInputF64(ctx, node, 'compareHigh', 0); em.localSet(hi); }
  void cfg;
  em.block(() => { em.loop(() => {
    em.localGet(i); em.localGet(a.lenLocal); em.op(OP_I32_GE_S); em.brIf(1);
    const v = em.allocLocal(F64); pushArrayElemF64(em, a, i); em.localSet(v);
    emitCountPredicate(em, v, lo, hi, op);
    em.ifThen(() => { em.localGet(cnt); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(cnt); });
    em.localGet(i); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(i); em.br(0);
  }); });
  const res = em.allocLocal(F64); em.localGet(cnt); em.i32ToF64(); em.localSet(res);
  return res;
}

/** Push i32 1/0 for the count predicate (v vs lo[/hi]). */
function emitCountPredicate(em: WasmEmitter, v: number, lo: number, hi: number, op: string): void {
  switch (op) {
    case 'notEquals': em.localGet(v); em.localGet(lo); em.op(OP_F64_NE); break;
    case 'greater': em.localGet(v); em.localGet(lo); em.op(OP_F64_GT); break;
    case 'lesser': em.localGet(v); em.localGet(lo); em.op(OP_F64_LT); break;
    case 'greaterEqual': em.localGet(v); em.localGet(lo); em.op(OP_F64_GE); break;
    case 'lesserEqual': em.localGet(v); em.localGet(lo); em.op(OP_F64_LE); break;
    case 'between': // lo <= v <= hi
      em.localGet(v); em.localGet(lo); em.op(OP_F64_GE);
      em.localGet(v); em.localGet(hi); em.op(OP_F64_LE); em.op(OP_I32_AND); break;
    case 'notBetween': // v < lo || v > hi
      em.localGet(v); em.localGet(lo); em.op(OP_F64_LT);
      em.localGet(v); em.localGet(hi); em.op(OP_F64_GT); em.op(OP_I32_OR); break;
    default: em.localGet(v); em.localGet(lo); em.op(OP_F64_EQ); break; // equals
  }
}

/** Group Statement — allIs/noneIs/hasA/allGreater/anyGreater/allLesser/anyLesser. */
function emitGroupStatement(ctx: AgentWasmCtx, node: GraphNode, a: AgentArrayRef, op: string): number {
  const em = ctx.em;
  // The operand port is `x` — the id GroupStatementNode DECLARES and the JS
  // emitter reads (it was `value` here; see the emitGroupCounting note).
  const thr = em.allocLocal(F64); pushValueInputF64(ctx, node, 'x', 0); em.localSet(thr);
  const acc = em.allocLocal(I32);
  const i = em.allocLocal(I32);
  // "all" ops start 1 (AND each match); "any"/hasA start 0 (OR each match).
  const isAll = op === 'allIs' || op === 'noneIs' || op === 'allGreater' || op === 'allLesser';
  em.i32Const(isAll ? 1 : 0); em.localSet(acc);
  em.i32Const(0); em.localSet(i);
  const matchPred = (v: number) => {
    switch (op) {
      case 'allIs': em.localGet(v); em.localGet(thr); em.op(OP_F64_EQ); break;
      case 'noneIs': em.localGet(v); em.localGet(thr); em.op(OP_F64_NE); break;
      case 'hasA': em.localGet(v); em.localGet(thr); em.op(OP_F64_EQ); break;
      case 'allGreater': case 'anyGreater': em.localGet(v); em.localGet(thr); em.op(OP_F64_GT); break;
      case 'allLesser': case 'anyLesser': em.localGet(v); em.localGet(thr); em.op(OP_F64_LT); break;
      default: em.localGet(v); em.localGet(thr); em.op(OP_F64_EQ); break;
    }
  };
  em.block(() => { em.loop(() => {
    em.localGet(i); em.localGet(a.lenLocal); em.op(OP_I32_GE_S); em.brIf(1);
    const v = em.allocLocal(F64); pushArrayElemF64(em, a, i); em.localSet(v);
    const m = em.allocLocal(I32); matchPred(v); em.localSet(m);
    if (isAll) { em.localGet(acc); em.localGet(m); em.op(OP_I32_AND); em.localSet(acc); }
    else { em.localGet(acc); em.localGet(m); em.op(OP_I32_OR); em.localSet(acc); }
    em.localGet(i); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(i); em.br(0);
  }); });
  const res = em.allocLocal(F64); em.localGet(acc); em.i32ToF64(); em.localSet(res);
  return res;
}

// ===========================================================================
// Flow emission.
// ===========================================================================

function compileFlowChain(ctx: AgentWasmCtx, nodeId: string, portId: string): void {
  const targets = ctx.adj.flowOutputToTargets.get(`${nodeId}:${portId}`) ?? [];
  for (const t of targets) compileFlowNode(ctx, t.nodeId);
}

/** Every output port of `nodeId` that some consumer actually reads. */
function usedOutPortsOf(ctx: AgentWasmCtx, nodeId: string): string[] {
  const ports = new Set<string>();
  for (const [, src] of ctx.adj.inputToSource) if (src.nodeId === nodeId) ports.add(src.portId);
  for (const [, srcs] of ctx.adj.inputToSources) for (const s of srcs) if (s.nodeId === nodeId) ports.add(s.portId);
  return ports.size > 0 ? [...ports] : ['value'];
}

function compileFlowNode(ctx: AgentWasmCtx, nodeId: string): void {
  // Hazard-pinned values scheduled immediately BEFORE this flow node (the LCA of
  // their uses — the same position JS's volatileHoist emits them). Compiled once
  // + cached; later uses read the cached local (dominates all uses, WASM locals
  // are function-scoped).
  const pinned = ctx.hazardEmitBefore.get(nodeId);
  if (pinned) {
    for (const vid of pinned) {
      if (!ctx.adj.nodeMap.has(vid)) continue;
      for (const p of usedOutPortsOf(ctx, vid)) compileValueNode(ctx, vid, p);
    }
  }
  const node = ctx.adj.nodeMap.get(nodeId);
  if (!node) return;
  const em = ctx.em;
  const type = node.data.nodeType;
  switch (type) {
    case 'applyForce': {
      // Always component mode here — `expandComposites` lowers a vector-input
      // Apply Force to its fx/fy/fz components before the compiler sees it.
      forceAdd(ctx, ctx.layout.f64['forceX']!, () => pushValueInputF64(ctx, node, 'fx', 0));
      forceAdd(ctx, ctx.layout.f64['forceY']!, () => pushValueInputF64(ctx, node, 'fy', 0));
      if (ctx.is3d) forceAdd(ctx, ctx.layout.f64['forceZ']!, () => pushValueInputF64(ctx, node, 'fz', 0));
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'applyForceToAgent': {
      // Commutative cross-agent force scatter: `force[target] += f` (range+alive
      // guarded, LIVE agents only — matches the JS behaviour-root live guard). No
      // atomics needed: the behaviour loop is SEQUENTIAL on WASM (only WebGPU's
      // parallel scatter needs an atomic add). fx/fy/fz evaluated into locals BEFORE
      // the guard (mirrors emitSetAgentsAttribute's `value` hoist), so the guard
      // gates only the stores — bit-identical to the JS `if (guard) { += }`.
      const a = em.allocLocal(I32); pushValueAs(em, resolveValueInput(ctx, node, 'agentId', -1), I32); em.localSet(a);
      const fx = em.allocLocal(F64); pushValueInputF64(ctx, node, 'fx', 0); em.localSet(fx);
      const fy = em.allocLocal(F64); pushValueInputF64(ctx, node, 'fy', 0); em.localSet(fy);
      let fz = -1;
      if (ctx.is3d) { fz = em.allocLocal(F64); pushValueInputF64(ctx, node, 'fz', 0); em.localSet(fz); }
      em.localGet(a); em.i32Const(0); em.op(OP_I32_GE_S);
      em.localGet(a); em.localGet(ctx.highWaterLocal); em.op(OP_I32_LT_S); em.op(OP_I32_AND);
      em.ifThen(() => {
        em.localGet(a); em.i32Const(ctx.layout.u8['alive']!); em.op(OP_I32_ADD); em.i32Load8U();
        em.ifThen(() => {
          forceAddAt(ctx, ctx.layout.f64['forceX']!, a, () => em.localGet(fx));
          forceAddAt(ctx, ctx.layout.f64['forceY']!, a, () => em.localGet(fy));
          if (ctx.is3d) forceAddAt(ctx, ctx.layout.f64['forceZ']!, a, () => em.localGet(fz));
        });
      });
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'setTargetRadius': {
      pushF64ElemAddr(em, ctx.layout.f64['targetRadius']!, ctx.idxLocal);
      pushValueInputF64(ctx, node, 'value', 1);
      em.f64Store();
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'setVariable': {
      const variableId = (node.data.config?.['variableId'] as string) || '';
      const local = variableId ? ctx.varLocals.get(variableId) : undefined;
      if (local !== undefined) { pushValueInputF64(ctx, node, 'value', 0); em.localSet(local); }
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'sequence': {
      // Ports are `first`, `then`, then `then_2`…`then_(1+extraCount)` (see
      // SequenceNode + CaNode's dynamic ports + asyncWriteHazard's walk). The
      // previous `then0`/`then1` (keyed on a nonexistent `sequenceCount`)
      // matched NOTHING — every Sequence in an agent behaviour silently
      // dropped its entire downstream chain on this target.
      const cfg = node.data.config as Record<string, unknown> | undefined;
      const extra = Math.max(0, Number(cfg?.['extraCount']) || 0);
      compileFlowChain(ctx, node.id, 'first');
      compileFlowChain(ctx, node.id, 'then');
      for (let i = 2; i < 2 + extra; i++) compileFlowChain(ctx, node.id, `then_${i}`);
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'conditional': {
      const condRef = resolveValueInput(ctx, node, 'condition', 0);
      pushValueAs(em, condRef, F64); em.f64Const(0); em.op(OP_F64_NE);
      // Volatile values (hazard-pinned reads, getVariable-derived) must re-emit
      // INSIDE each branch: a value cached from branch A would leave branch B
      // reading a local whose set instruction only exists in A's bytecode (a
      // stale previous-iteration value at runtime).
      em.ifThenElse(
        () => { const s = enterCacheScope(ctx); clearVolatileCache(ctx); compileFlowChain(ctx, node.id, 'then'); exitCacheScope(ctx, s); },
        () => { const s = enterCacheScope(ctx); clearVolatileCache(ctx); compileFlowChain(ctx, node.id, 'else'); exitCacheScope(ctx, s); },
      );
      clearVolatileCache(ctx);
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'forEachInArray': {
      emitForEach(ctx, node);
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'forEachBond': {
      emitForEachBond(ctx, node);
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'switch': {
      emitSwitch(ctx, node);
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'loop': {
      emitLoop(ctx, node);
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'setVelocity': {
      pushF64ElemAddr(em, ctx.layout.f64['vx']!, ctx.idxLocal); pushValueInputF64(ctx, node, 'vx', 0); em.f64Store();
      pushF64ElemAddr(em, ctx.layout.f64['vy']!, ctx.idxLocal); pushValueInputF64(ctx, node, 'vy', 0); em.f64Store();
      if (ctx.is3d) { pushF64ElemAddr(em, ctx.layout.f64['vz']!, ctx.idxLocal); pushValueInputF64(ctx, node, 'vz', 0); em.f64Store(); }
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'setAgentAttribute': {
      const attrId = (node.data.config?.['attributeId'] as string) || '';
      emitGuardedAgentWrite(ctx, node, 'agentId', (aLocal) => {
        pushAgentAttrWriteAddr(ctx, attrId, aLocal);
        pushValueInputF64(ctx, node, 'value', 0);
        emitAgentAttrStore(ctx, attrId);
      });
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'setAgentsAttribute': {
      emitSetAgentsAttribute(ctx, node);
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'setAgentPosition': {
      emitGuardedAgentWrite(ctx, node, 'agentId', (aLocal) => {
        pushF64ElemAddr(em, ctx.layout.f64['x']!, aLocal); pushValueInputF64(ctx, node, 'x', 0); em.f64Store();
        pushF64ElemAddr(em, ctx.layout.f64['y']!, aLocal); pushValueInputF64(ctx, node, 'y', 0); em.f64Store();
        if (ctx.is3d) { pushF64ElemAddr(em, ctx.layout.f64['z']!, aLocal); pushValueInputF64(ctx, node, 'z', 0); em.f64Store(); }
      });
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'setAgentRadius': {
      emitGuardedAgentWrite(ctx, node, 'agentId', (aLocal) => {
        const rv = em.allocLocal(F64); pushValueInputF64(ctx, node, 'radius', 1); em.localSet(rv);
        pushF64ElemAddr(em, ctx.layout.f64['radius']!, aLocal); em.localGet(rv); em.f64Store();
        pushF64ElemAddr(em, ctx.layout.f64['targetRadius']!, aLocal); em.localGet(rv); em.f64Store();
      });
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'setAttribute': {
      // On the AGENT graph: write the agent SoA at idx (D-IDX). w_<attr>[idx].
      const attrId = (node.data.config?.['attributeId'] as string) || '';
      pushAgentAttrWriteAddr(ctx, attrId, ctx.idxLocal);
      pushValueInputF64(ctx, node, 'value', 0);
      emitAgentAttrStore(ctx, attrId);
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'updateAttribute': {
      emitUpdateAttribute(ctx, node);
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'setArrayElement': {
      emitSetArrayElement(ctx, node);
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'divideAgent': {
      // _divideRequest[idx]=1; _divideAxisX[idx]=<axisX|NaN>; ...; _divideAsym[idx]=<asym|0.5>
      em.localGet(ctx.idxLocal); em.i32Const(ctx.layout.u8['divideRequest']!); em.op(OP_I32_ADD); em.i32Const(1); em.i32Store8();
      emitAxisWrite(ctx, node, 'axisX', ctx.layout.f64['divideAxisX']!);
      emitAxisWrite(ctx, node, 'axisY', ctx.layout.f64['divideAxisY']!);
      if (ctx.is3d) emitAxisWrite(ctx, node, 'axisZ', ctx.layout.f64['divideAxisZ']!);
      pushF64ElemAddr(em, ctx.layout.f64['divideAsym']!, ctx.idxLocal); pushValueInputF64(ctx, node, 'asymmetry', 0.5); em.f64Store();
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'formBond': {
      // _bondFormReq[idx] = (target|0)+1; _bondFormL[idx]=restLength; _bondFormK[idx]=stiffness
      pushI32ElemAddr(em, ctx.layout.i32['bondFormReq']!, ctx.idxLocal);
      pushValueAs(em, resolveValueInput(ctx, node, 'targetAgent', -1), I32); em.i32Const(1); em.op(OP_I32_ADD); em.i32Store();
      pushF64ElemAddr(em, ctx.layout.f64['bondFormL']!, ctx.idxLocal); pushValueInputF64(ctx, node, 'restLength', 0); em.f64Store();
      pushF64ElemAddr(em, ctx.layout.f64['bondFormK']!, ctx.idxLocal); pushValueInputF64(ctx, node, 'stiffness', 0); em.f64Store();
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'breakBond': {
      pushI32ElemAddr(em, ctx.layout.i32['bondBreakReq']!, ctx.idxLocal);
      pushValueAs(em, resolveValueInput(ctx, node, 'targetAgent', -1), I32); em.i32Const(1); em.op(OP_I32_ADD); em.i32Store();
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'killAgent': {
      em.localGet(ctx.idxLocal); em.i32Const(ctx.layout.u8['killRequest']!); em.op(OP_I32_ADD); em.i32Const(1); em.i32Store8();
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'stopEvent': {
      // Mirrors the cell WASM stopEvent (wasm/compile.ts) + the JS StopEventNode:
      // if the agent stop cell is 0, write the 1-based _stopIdx (first-match-wins).
      // The worker reads this cell back after the step and merges it into the
      // shared stopFlag. _stopIdx is baked by the JS compileAgentGraph (runs first,
      // offset by the cell stop count) — the WASM/WebGPU agent compilers read it.
      const stopIdx = Number(node.data.config._stopIdx ?? 0);
      if (stopIdx) {
        const off = ctx.layout.stopFlagOffset;
        em.i32Const(0); em.i32Load(off, 2);
        em.op(OP_I32_EQZ);
        em.ifThen(() => { em.i32Const(0); em.i32Const(stopIdx); em.i32Store(off, 2); });
      }
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'createAgent': {
      // Unified spawning — handle = env.agentCreate(x, y, z, radius) (a grow-only
      // alloc host closure over the shared memory, staging the slot at alive=0). The
      // handle is an i32 value output consumed by sibling flow nodes (Add / set-by-id).
      pushValueInputF64(ctx, node, 'x', 0);
      pushValueInputF64(ctx, node, 'y', 0);
      if (ctx.is3d) pushValueInputF64(ctx, node, 'z', 0); else em.f64Const(0);
      pushValueInputF64(ctx, node, 'radius', 1);
      em.emit(opCall(AGENT_CREATE_FUNC_IDX));   // (f64,f64,f64,f64) -> i32 handle
      const hLocal = em.allocLocal(I32);
      em.localSet(hLocal);
      setCachedPort(ctx, node.id, 'handle', { localIdx: hLocal, valtype: I32 });
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'addAgentToWorld': {
      // env.agentAddToWorld(handle) — commit the staged agent (alive=1). The host
      // closure only commits ids this step's Create staged (ghost-commit guard).
      pushValueAs(em, resolveValueInput(ctx, node, 'handle', -1), I32);
      em.emit(opCall(AGENT_ADD_FUNC_IDX));
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'setIndicator': {
      const idxN = (node.data.config?.['_indicatorIdx'] as number) ?? -1;
      if (idxN >= 0) { em.i32Const(0); pushValueInputF64(ctx, node, 'value', 0); em.f64Store(ctx.layout.indicatorsOffset + idxN * 8, 3); }
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'updateIndicator': {
      emitUpdateIndicator(ctx, node);
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'setCellLooks': {
      emitSetCellLooks(ctx, node);
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'affectCellsUnder': {
      emitAffectCellsUnder(ctx, node);
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'secreteToField': {
      emitSecreteToField(ctx, node);
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    default:
      throw new Error(`agentWasm: unsupported flow node '${type}'`);
  }
}

/** Resolve `agentId`, guard (range + alive in behaviour; range-only in init), run
 *  `body(aLocal)` inside the guard. */
function emitGuardedAgentWrite(ctx: AgentWasmCtx, node: GraphNode, portId: string, body: (aLocal: number) => void): void {
  const em = ctx.em;
  const a = em.allocLocal(I32); pushValueAs(em, resolveValueInput(ctx, node, portId, -1), I32); em.localSet(a);
  // Unified spawning: RANGE-ONLY guard `a >= 0 && a < maxAgents` (maxAgents baked
  // from the layout), matching the JS behaviour-root relax — so a freshly Created
  // agent (STAGED, alive=0, id >= the loop bound) can be configured on the handle.
  // Writing a dead slot is a harmless no-op (dead slots aren't read/rendered), and
  // Get Nearby Agents only returns live agents so real neighbour writes are unaffected.
  em.localGet(a); em.i32Const(0); em.op(OP_I32_GE_S);
  em.localGet(a); em.i32Const(ctx.layout.maxAgents); em.op(OP_I32_LT_S); em.op(OP_I32_AND);
  em.ifThen(() => body(a));
}

/** Divide-axis write: `_divideAxisX[idx] = <wired ? value : NaN>`. The engine
 *  resolves the tension axis whenever the axis is non-finite OR (0,0), so an
 *  unwired axis matches JS's NaN default. */
function emitAxisWrite(ctx: AgentWasmCtx, node: GraphNode, portId: string, regionOffset: number): void {
  const em = ctx.em;
  pushF64ElemAddr(em, regionOffset, ctx.idxLocal);
  const src = ctx.adj.inputToSource.get(`${node.id}:${portId}`);
  if (src) pushValueAs(em, compileValueNode(ctx, src.nodeId, src.portId), F64);
  else em.f64Const(NaN);
  em.f64Store();
}

/** Set Agents Attribute — write-many over an id array (guarded). */
function emitSetAgentsAttribute(ctx: AgentWasmCtx, node: GraphNode): void {
  const em = ctx.em;
  const attrId = (node.data.config?.['attributeId'] as string) || '';
  const arr = resolveInputArray(ctx, node, 'agents');
  if (!arr) return;
  const v = em.allocLocal(F64); pushValueInputF64(ctx, node, 'value', 0); em.localSet(v);
  const si = em.allocLocal(I32); em.i32Const(0); em.localSet(si);
  em.block(() => { em.loop(() => {
    em.localGet(si); em.localGet(arr.lenLocal); em.op(OP_I32_GE_S); em.brIf(1);
    const a = em.allocLocal(I32); pushArrayElemI32(em, arr, si); em.localSet(a);
    em.localGet(a); em.i32Const(0); em.op(OP_I32_GE_S);
    em.localGet(a); em.localGet(ctx.highWaterLocal); em.op(OP_I32_LT_S); em.op(OP_I32_AND);
    em.ifThen(() => {
      em.localGet(a); em.i32Const(ctx.layout.u8['alive']!); em.op(OP_I32_ADD); em.i32Load8U();
      em.ifThen(() => { pushAgentAttrWriteAddr(ctx, attrId, a); em.localGet(v); emitAgentAttrStore(ctx, attrId); });
    });
    em.localGet(si); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(si); em.br(0);
  }); });
}

/** Set Array Element — `var[index] = value` (bounds-checked). */
function emitSetArrayElement(ctx: AgentWasmCtx, node: GraphNode): void {
  const em = ctx.em;
  const variableId = (node.data.config?.['variableId'] as string) || '';
  const arr = ctx.arrayVarLocals.get(variableId);
  if (!arr) return;
  const i = em.allocLocal(I32); pushValueAs(em, resolveValueInput(ctx, node, 'index', 0), I32); em.localSet(i);
  em.localGet(i); em.i32Const(0); em.op(OP_I32_GE_S);
  em.localGet(i); em.localGet(arr.lenLocal); em.op(OP_I32_LT_S); em.op(OP_I32_AND);
  em.ifThen(() => {
    storeArrayElemAddr(em, arr, i);
    pushValueInputF64(ctx, node, 'value', 0);
    if (arr.elemBytes === 8) em.f64Store(); else { em.f64ToI32(); em.i32Store(); }
  });
}

/** Update Attribute — in-place modify the agent SoA attr (read-modify-write on the
 *  WRITE buffer, matching the lattice UpdateAttribute). */
function emitUpdateAttribute(ctx: AgentWasmCtx, node: GraphNode): void {
  const em = ctx.em;
  const cfg = node.data.config as Record<string, unknown>;
  const attrId = (cfg['attributeId'] as string) || '';
  const op = (cfg['operation'] as string) || 'increment';
  const kind = agentAttrKindOf(ctx, attrId);
  // current value (read from the WRITE buffer = the just-written value, matching JS w_<attr>[idx])
  const readCur = (): void => {
    const off = (ctx.layout.syncAttrs ? ctx.layout.attrWriteOffset[attrId] : ctx.layout.attrOffset[attrId]) ?? 0;
    if (kind === 'uint8') { em.localGet(ctx.idxLocal); em.i32Const(off); em.op(OP_I32_ADD); em.i32Load8U(); em.i32ToF64(); }
    else if (kind === 'int32') { pushI32Elem(em, off, ctx.idxLocal); em.i32ToF64(); }
    else pushF64Elem(em, off, ctx.idxLocal);
  };
  const cur = em.allocLocal(F64); readCur(); em.localSet(cur);
  const next = em.allocLocal(F64);
  const tagLen = Number(cfg['_tagLen']) || 1;
  switch (op) {
    case 'increment': em.localGet(cur); pushValueInputF64(ctx, node, 'value', 1); em.op(OP_F64_ADD); em.localSet(next); break;
    case 'decrement': em.localGet(cur); pushValueInputF64(ctx, node, 'value', 1); em.op(OP_F64_SUB); em.localSet(next); break;
    case 'max': em.localGet(cur); pushValueInputF64(ctx, node, 'value', 0); em.op(OP_F64_MAX); em.localSet(next); break;
    case 'min': em.localGet(cur); pushValueInputF64(ctx, node, 'value', 0); em.op(OP_F64_MIN); em.localSet(next); break;
    case 'toggle': em.localGet(cur); em.f64Const(0); em.op(OP_F64_EQ); em.i32ToF64(); em.localSet(next); break;
    case 'next': // (cur + 1) % tagLen
      em.localGet(cur); em.f64ToI32(); em.i32Const(1); em.op(OP_I32_ADD); em.i32Const(tagLen); em.op(OP_I32_REM_S); em.i32ToF64(); em.localSet(next); break;
    case 'previous': // (cur - 1 + tagLen) % tagLen
      em.localGet(cur); em.f64ToI32(); em.i32Const(1); em.op(OP_I32_SUB); em.i32Const(tagLen); em.op(OP_I32_ADD); em.i32Const(tagLen); em.op(OP_I32_REM_S); em.i32ToF64(); em.localSet(next); break;
    case 'or': em.localGet(cur); em.f64Const(0); em.op(OP_F64_NE); pushValueInputF64(ctx, node, 'value', 0); em.f64Const(0); em.op(OP_F64_NE); em.op(OP_I32_OR); em.i32ToF64(); em.localSet(next); break;
    case 'and': em.localGet(cur); em.f64Const(0); em.op(OP_F64_NE); pushValueInputF64(ctx, node, 'value', 0); em.f64Const(0); em.op(OP_F64_NE); em.op(OP_I32_AND); em.i32ToF64(); em.localSet(next); break;
    default: em.localGet(cur); em.localSet(next); break;
  }
  pushAgentAttrWriteAddr(ctx, attrId, ctx.idxLocal); em.localGet(next); emitAgentAttrStore(ctx, attrId);
}

/** Update Indicator — all ops (the agent loop is sequential, so toggle/next/prev
 *  are well-defined, unlike WebGPU's parallel writers). */
function emitUpdateIndicator(ctx: AgentWasmCtx, node: GraphNode): void {
  const em = ctx.em;
  const cfg = node.data.config as Record<string, unknown>;
  const idxN = (cfg['_indicatorIdx'] as number) ?? -1;
  if (idxN < 0) return;
  const op = (cfg['operation'] as string) || 'increment';
  const off = ctx.layout.indicatorsOffset + idxN * 8;
  const tagLen = Number(cfg['_tagLen']) || 1;
  const cur = em.allocLocal(F64); em.i32Const(0); em.f64Load(off, 3); em.localSet(cur);
  const next = em.allocLocal(F64);
  switch (op) {
    case 'increment': em.localGet(cur); pushValueInputF64(ctx, node, 'value', 1); em.op(OP_F64_ADD); em.localSet(next); break;
    case 'decrement': em.localGet(cur); pushValueInputF64(ctx, node, 'value', 1); em.op(OP_F64_SUB); em.localSet(next); break;
    case 'max': em.localGet(cur); pushValueInputF64(ctx, node, 'value', 0); em.op(OP_F64_MAX); em.localSet(next); break;
    case 'min': em.localGet(cur); pushValueInputF64(ctx, node, 'value', 0); em.op(OP_F64_MIN); em.localSet(next); break;
    case 'toggle': em.localGet(cur); em.f64Const(0); em.op(OP_F64_EQ); em.i32ToF64(); em.localSet(next); break;
    case 'next': em.localGet(cur); em.f64ToI32(); em.i32Const(1); em.op(OP_I32_ADD); em.i32Const(tagLen); em.op(OP_I32_REM_S); em.i32ToF64(); em.localSet(next); break;
    case 'previous': em.localGet(cur); em.f64ToI32(); em.i32Const(1); em.op(OP_I32_SUB); em.i32Const(tagLen); em.op(OP_I32_ADD); em.i32Const(tagLen); em.op(OP_I32_REM_S); em.i32ToF64(); em.localSet(next); break;
    case 'or': em.localGet(cur); em.f64Const(0); em.op(OP_F64_NE); pushValueInputF64(ctx, node, 'value', 0); em.f64Const(0); em.op(OP_F64_NE); em.op(OP_I32_OR); em.i32ToF64(); em.localSet(next); break;
    case 'and': em.localGet(cur); em.f64Const(0); em.op(OP_F64_NE); pushValueInputF64(ctx, node, 'value', 0); em.f64Const(0); em.op(OP_F64_NE); em.op(OP_I32_AND); em.i32ToF64(); em.localSet(next); break;
    default: em.localGet(cur); em.localSet(next); break;
  }
  em.i32Const(0); em.localGet(next); em.f64Store(off, 3);
}

/** For Each Bond — iterate the agent's bond list, exposing partnerId/restLength/
 *  currentLength/index per iteration. Mirrors ForEachBondNode's flow emit (no
 *  epoch re-check — the engine's post-step sweep keeps the list clean). */
function emitForEachBond(ctx: AgentWasmCtx, node: GraphNode): void {
  const em = ctx.em, L = ctx.layout;
  const bc = em.allocLocal(I32); pushI32Elem(em, L.i32['bondCount']!, ctx.idxLocal); em.localSet(bc);
  const feb = em.allocLocal(I32); em.i32Const(0); em.localSet(feb);
  const partnerL = em.allocLocal(I32), restL = em.allocLocal(F64), curL = em.allocLocal(F64), idxL = em.allocLocal(I32);
  ctx.forEachBondStack.push({ nodeId: node.id, partnerLocal: partnerL, restLocal: restL, curLocal: curL, idxLocal: idxL });
  const base = em.allocLocal(I32); em.localGet(ctx.idxLocal); em.i32Const(L.maxBonds); em.op(OP_I32_MUL); em.localSet(base);
  const bpOff = L.bondI32['bondPartner']!, brlOff = L.bondF64['bondRestLength']!;
  const xi = em.allocLocal(F64), yi = em.allocLocal(F64);
  pushF64Elem(em, L.f64['x']!, ctx.idxLocal); em.localSet(xi);
  pushF64Elem(em, L.f64['y']!, ctx.idxLocal); em.localSet(yi);
  const zi = ctx.is3d ? em.allocLocal(F64) : -1;
  if (ctx.is3d) { pushF64Elem(em, L.f64['z']!, ctx.idxLocal); em.localSet(zi); }
  em.block(() => { em.loop(() => {
    em.localGet(feb); em.localGet(bc); em.op(OP_I32_GE_S); em.brIf(1);
    const bb = em.allocLocal(I32); em.localGet(base); em.localGet(feb); em.op(OP_I32_ADD); em.localSet(bb);
    // partnerId = bondPartner[bb]
    em.localGet(bb); em.i32Const(4); em.op(OP_I32_MUL); em.i32Const(bpOff); em.op(OP_I32_ADD); em.i32Load(); em.localSet(partnerL);
    // restLength = bondRestLength[bb]
    em.localGet(bb); em.i32Const(8); em.op(OP_I32_MUL); em.i32Const(brlOff); em.op(OP_I32_ADD); em.f64Load(); em.localSet(restL);
    // currentLength — torus-SHORTEST displacement (matches the JS emit: a
    // seam-straddling bond must not read ≈ W − actual) + the z arm in 3D.
    const dx = em.allocLocal(F64), dy = em.allocLocal(F64);
    const dz = ctx.is3d ? em.allocLocal(F64) : -1;
    pushF64Elem(em, L.f64['x']!, partnerL); em.localGet(xi); em.op(OP_F64_SUB); em.localSet(dx);
    pushF64Elem(em, L.f64['y']!, partnerL); em.localGet(yi); em.op(OP_F64_SUB); em.localSet(dy);
    if (ctx.is3d) { pushF64Elem(em, L.f64['z']!, partnerL); em.localGet(zi); em.op(OP_F64_SUB); em.localSet(dz); }
    em.localGet(ctx.fieldTorusLocal);
    em.ifThen(() => {
      foldTorus(em, dx, ctx.fieldWLocal);
      foldTorus(em, dy, ctx.fieldHLocal);
      if (ctx.is3d && dz >= 0) foldTorus(em, dz, ctx.fieldDLocal);
    });
    em.localGet(dx); em.localGet(dx); em.op(OP_F64_MUL); em.localGet(dy); em.localGet(dy); em.op(OP_F64_MUL); em.op(OP_F64_ADD);
    if (ctx.is3d && dz >= 0) { em.localGet(dz); em.localGet(dz); em.op(OP_F64_MUL); em.op(OP_F64_ADD); }
    em.op(OP_F64_SQRT); em.localSet(curL);
    // index = feb
    em.localGet(feb); em.localSet(idxL);
    const s = enterCacheScope(ctx);
    clearVolatileCache(ctx);
    compileFlowChain(ctx, node.id, 'body');
    exitCacheScope(ctx, s);
    em.localGet(feb); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(feb);
    em.br(0);
  }); });
  ctx.forEachBondStack.pop();
  clearVolatileCache(ctx);
}

/** Switch — conditions / value mode, firstMatchOnly chain or independent ifs.
 *  Mirrors the lattice WASM switch emit. */
function emitSwitch(ctx: AgentWasmCtx, node: GraphNode): void {
  const em = ctx.em;
  const cfg = node.data.config as Record<string, unknown>;
  const mode = (cfg['mode'] as string) || 'conditions';
  const firstMatchOnly = cfg['firstMatchOnly'] !== false;
  const valType = (cfg['valueType'] as string) || 'integer';
  const caseCount = Number(cfg['caseCount']) || 0;
  const hasDefault = ctx.adj.flowOutputToTargets.has(`${node.id}:default`);
  if (caseCount === 0) { compileFlowChain(ctx, node.id, 'default'); return; }
  let valueRef: ValueRef | null = null;
  if (mode === 'value') {
    const src = ctx.adj.inputToSource.get(`${node.id}:value`);
    valueRef = src ? compileValueNode(ctx, src.nodeId, src.portId) : { inline: true, value: parseInlineNum(cfg['_port_value'], 0), valtype: valType === 'float' ? F64 : I32 };
  }
  const caseConds: ValueRef[] = [];
  for (let ci = 0; ci < caseCount; ci++) {
    if (mode === 'conditions') {
      const condSrc = ctx.adj.inputToSource.get(`${node.id}:case_${ci}_cond`);
      if (condSrc) caseConds.push(compileValueNode(ctx, condSrc.nodeId, condSrc.portId));
      else caseConds.push({ inline: true, value: cfg[`_port_case_${ci}_cond`] === 'true' ? 1 : 0, valtype: I32 });
    } else {
      const caseValSrc = ctx.adj.inputToSource.get(`${node.id}:case_${ci}_val`);
      let caseValRef: ValueRef;
      if (caseValSrc) caseValRef = compileValueNode(ctx, caseValSrc.nodeId, caseValSrc.portId);
      else { const raw = cfg[`_port_case_${ci}_val`] ?? cfg[`case_${ci}_value`] ?? 0; const num = parseFloat(String(raw)); caseValRef = { inline: true, value: Number.isFinite(num) ? num : 0, valtype: valType === 'float' ? F64 : I32 }; }
      const resLocal = em.allocLocal(I32);
      const cmpOp = (cfg[`case_${ci}_op`] as string) || '==';
      if (valType === 'tag' || valType === 'integer' || valType === 'neighborIndex') {
        pushValueAs(em, valueRef!, F64); pushValueAs(em, caseValRef, F64); emitCompareOp(em, cmpOp);
      } else {
        pushValueAs(em, valueRef!, F64); pushValueAs(em, caseValRef, F64); emitCompareOp(em, cmpOp);
      }
      em.localSet(resLocal);
      caseConds.push({ localIdx: resLocal, valtype: I32 });
    }
  }
  // Branch-entry volatile clears — same rationale as the conditional emit: a
  // volatile value cached from one case would leave a sibling case reading a
  // local whose set instruction lives only in the first case's bytecode.
  if (firstMatchOnly) {
    const open = (ci: number): void => {
      if (ci >= caseCount) { if (hasDefault) { const s = enterCacheScope(ctx); clearVolatileCache(ctx); compileFlowChain(ctx, node.id, 'default'); exitCacheScope(ctx, s); } return; }
      pushValueAs(em, caseConds[ci]!, I32);
      em.ifThenElse(
        () => { const s = enterCacheScope(ctx); clearVolatileCache(ctx); compileFlowChain(ctx, node.id, `case_${ci}`); exitCacheScope(ctx, s); },
        () => open(ci + 1),
      );
    };
    open(0);
    clearVolatileCache(ctx);
  } else {
    const matched = em.allocLocal(I32); em.i32Const(0); em.localSet(matched);
    for (let ci = 0; ci < caseCount; ci++) {
      pushValueAs(em, caseConds[ci]!, I32);
      em.ifThen(() => { em.i32Const(1); em.localSet(matched); const s = enterCacheScope(ctx); clearVolatileCache(ctx); compileFlowChain(ctx, node.id, `case_${ci}`); exitCacheScope(ctx, s); });
    }
    if (hasDefault) { em.localGet(matched); em.op(OP_I32_EQZ); em.ifThen(() => { const s = enterCacheScope(ctx); clearVolatileCache(ctx); compileFlowChain(ctx, node.id, 'default'); exitCacheScope(ctx, s); }); }
    clearVolatileCache(ctx);
  }
}

/** Loop — run BODY `count` times. The volatile cache clears per iteration (a
 *  hazard-pinned / getVariable-derived value must re-read each pass) and after
 *  the construct. */
function emitLoop(ctx: AgentWasmCtx, node: GraphNode): void {
  const em = ctx.em;
  // Count mode: li = 0..count-1 (exit on li >= bound). Range mode: li runs
  // From..To INCLUSIVE (exit on li > bound; From > To = zero iterations).
  const isRange = node.data.config?.['mode'] === 'range';
  const cnt = em.allocLocal(I32);
  pushValueAs(em, resolveValueInput(ctx, node, isRange ? 'to' : 'count', isRange ? 0 : 1), I32);
  em.localSet(cnt);
  const li = em.allocLocal(I32);
  if (isRange) pushValueAs(em, resolveValueInput(ctx, node, 'from', 0), I32);
  else em.i32Const(0);
  em.localSet(li);
  // Expose the counter for the Loop's `index` output (body-only, like forEach's
  // index) — consumers are volatile (computeVolatile seeds `loop`) so their
  // caches clear per iteration and they re-read the live local.
  ctx.loopStack.push({ nodeId: node.id, idxLocal: li });
  em.block(() => { em.loop(() => {
    em.localGet(li); em.localGet(cnt); em.op(isRange ? OP_I32_GT_S : OP_I32_GE_S); em.brIf(1);
    const s = enterCacheScope(ctx);
    clearVolatileCache(ctx);
    compileFlowChain(ctx, node.id, 'body');
    exitCacheScope(ctx, s);
    em.localGet(li); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(li); em.br(0);
  }); });
  ctx.loopStack.pop();
  clearVolatileCache(ctx);
}

/** Set Cell Looks — agent appearance. Writes the agent colors buffer (s.colors at
 *  colorsOffset, idx*4). Glyph writes are a parity no-op (the agent overlay has no
 *  glyph buffers on ANY target — JS writes the length-0 GLYPH_NOOP arrays). A
 *  non-sentinel mappingId is viewer-GUARDED like JS's `_isV_` hoist: the write
 *  fires only when the trailing `activeViewerIdx` param equals this mapping's
 *  index in the compile-time viewerGuardIds table (`__current__` = unconditional). */
function emitSetCellLooks(ctx: AgentWasmCtx, node: GraphNode): void {
  const em = ctx.em;
  const cfg = node.data.config as Record<string, unknown>;
  const useGlyph = !!cfg['useGlyph'];
  const setBg = cfg['setBackground'] !== false;
  if (!(!useGlyph || setBg)) return; // glyph-only with no background → nothing to write here
  const emitWrites = (): void => {
    const colorByte = em.allocLocal(I32); em.localGet(ctx.idxLocal); em.i32Const(4); em.op(OP_I32_MUL); em.localSet(colorByte);
    const off = ctx.layout.colorsOffset;
    const writeChan = (port: string, def: number, lane: number) => {
      em.localGet(colorByte); em.i32Const(off + lane); em.op(OP_I32_ADD);
      pushValueAs(em, resolveValueInput(ctx, node, port, def), I32);
      em.i32Store8();
    };
    writeChan('r', 0, 0); writeChan('g', 0, 1); writeChan('b', 0, 2); writeChan('a', 255, 3);
  };
  const mid = (cfg['mappingId'] as string) || '';
  const guardIdx = mid && mid !== '__current__' ? ctx.viewerGuardIds.indexOf(mid) : -1;
  if (guardIdx < 0) { emitWrites(); return; }   // sentinel / unset → unconditional
  em.localGet(ctx.activeViewerIdxLocal); em.i32Const(guardIdx); em.op(OP_I32_EQ);
  em.ifThen(emitWrites);
}

// --- field bridge writes (closed agent↔grid feedback) ---

/** Push field cell flat index `(row*_fieldW + col)` for integer row/col locals. */
/** Push the flat field index. 2D = `row·W + col`; 3D = `(layer·H + row)·W + col`
 *  (= layer·W·H + row·W + col — the grid's `(layer*H+row)*W+col`). `layerLocal`
 *  must be supplied for a 3D model; it's ignored in 2D. */
function emitFieldIdx(ctx: AgentWasmCtx, rowLocal: number, colLocal: number, layerLocal = -1): void {
  const em = ctx.em;
  if (ctx.is3d) {
    // (layer*H + row)*W + col
    em.localGet(layerLocal); pushFieldHInt(ctx); em.op(OP_I32_MUL); em.localGet(rowLocal); em.op(OP_I32_ADD);
    pushFieldWInt(ctx); em.op(OP_I32_MUL); em.localGet(colLocal); em.op(OP_I32_ADD);
    return;
  }
  em.localGet(rowLocal); pushFieldWInt(ctx); em.op(OP_I32_MUL); em.localGet(colLocal); em.op(OP_I32_ADD);
}
/** Push `_fieldW` as an i32 (it rides the behaviour as an f64 param). */
function pushFieldWInt(ctx: AgentWasmCtx): void { ctx.em.localGet(ctx.fieldWLocal); ctx.em.f64ToI32(); }
function pushFieldHInt(ctx: AgentWasmCtx): void { ctx.em.localGet(ctx.fieldHLocal); ctx.em.f64ToI32(); }
function pushFieldDInt(ctx: AgentWasmCtx): void { ctx.em.localGet(ctx.fieldDLocal); ctx.em.f64ToI32(); }

/** Affect Cells Under — r-disk (2D) / r-sphere (3D) write (set/add/sub/max/min)
 *  into the field. */
function emitAffectCellsUnder(ctx: AgentWasmCtx, node: GraphNode): void {
  const em = ctx.em;
  const fieldId = (node.data.config?.['attributeId'] as string) || '';
  const fOff = ctx.layout.fieldOffset[fieldId];
  if (fOff === undefined) { compileFieldNoop(ctx); return; }
  const op = (node.data.config?.['op'] as string) || 'add';
  const cx = em.allocLocal(F64); pushF64Elem(em, ctx.layout.f64['x']!, ctx.idxLocal); em.localSet(cx);
  const cy = em.allocLocal(F64); pushF64Elem(em, ctx.layout.f64['y']!, ctx.idxLocal); em.localSet(cy);
  const r = em.allocLocal(F64); pushValueInputF64(ctx, node, 'radius', 1); em.localSet(r);
  const v = em.allocLocal(F64); pushValueInputF64(ctx, node, 'value', 1); em.localSet(v);
  const r2 = em.allocLocal(F64); em.localGet(r); em.localGet(r); em.op(OP_F64_MUL); em.localSet(r2);
  const applyBody = (ciLocal: number) => {
    // apply op: field[ci] = op(field[ci], v)
    em.localGet(ciLocal); em.i32Const(8); em.op(OP_I32_MUL); em.i32Const(fOff); em.op(OP_I32_ADD);  // addr
    switch (op) {
      case 'set': em.localGet(v); break;
      case 'subtract': pushF64Elem(em, fOff, ciLocal); em.localGet(v); em.op(OP_F64_SUB); break;
      case 'max': pushF64Elem(em, fOff, ciLocal); em.localGet(v); em.op(OP_F64_MAX); break;
      case 'min': pushF64Elem(em, fOff, ciLocal); em.localGet(v); em.op(OP_F64_MIN); break;
      default: pushF64Elem(em, fOff, ciLocal); em.localGet(v); em.op(OP_F64_ADD); break; // add
    }
    em.f64Store();
  };
  if (ctx.is3d) {
    const cz = em.allocLocal(F64); pushF64Elem(em, ctx.layout.f64['z']!, ctx.idxLocal); em.localSet(cz);
    emitSphereLoop(ctx, cx, cy, cz, r, r2, applyBody);
  } else {
    emitDiskLoop(ctx, cx, cy, r, r2, applyBody);
  }
}

/** Secrete To Field — 2D 4-cell bilinear / 3D 8-cell trilinear splat
 *  (`+= rate*weight`). The weights sum to 1, so the total deposit is `rate`.
 *  Mirrors SecreteToFieldNode's JS (index `(z*H+y)*W+x` in 3D). */
function emitSecreteToField(ctx: AgentWasmCtx, node: GraphNode): void {
  const em = ctx.em;
  const fieldId = (node.data.config?.['attributeId'] as string) || '';
  const fOff = ctx.layout.fieldOffset[fieldId];
  if (fOff === undefined) { compileFieldNoop(ctx); return; }
  const fx = em.allocLocal(F64); pushF64Elem(em, ctx.layout.f64['x']!, ctx.idxLocal); em.localSet(fx);
  const fy = em.allocLocal(F64); pushF64Elem(em, ctx.layout.f64['y']!, ctx.idxLocal); em.localSet(fy);
  const rate = em.allocLocal(F64); pushValueInputF64(ctx, node, 'rate', 1); em.localSet(rate);
  // x0 = floor(fx); tx = fx - x0; x1 = x0+1; (same y)
  const x0 = em.allocLocal(I32); em.localGet(fx); em.op(OP_F64_FLOOR); em.f64ToI32(); em.localSet(x0);
  const y0 = em.allocLocal(I32); em.localGet(fy); em.op(OP_F64_FLOOR); em.f64ToI32(); em.localSet(y0);
  const tx = em.allocLocal(F64); em.localGet(fx); em.localGet(x0); em.i32ToF64(); em.op(OP_F64_SUB); em.localSet(tx);
  const ty = em.allocLocal(F64); em.localGet(fy); em.localGet(y0); em.i32ToF64(); em.op(OP_F64_SUB); em.localSet(ty);
  const x1 = em.allocLocal(I32); em.localGet(x0); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(x1);
  const y1 = em.allocLocal(I32); em.localGet(y0); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(y1);
  // Wrap/clamp EACH coordinate EXACTLY ONCE (x via _fieldW, y via _fieldH).
  emitFieldWrapCoord(ctx, x0, 'x'); emitFieldWrapCoord(ctx, x1, 'x');
  emitFieldWrapCoord(ctx, y0, 'y'); emitFieldWrapCoord(ctx, y1, 'y');
  // weights: (1-tx)*(1-ty), tx*(1-ty), (1-tx)*ty, tx*ty
  const omtx = em.allocLocal(F64); em.f64Const(1); em.localGet(tx); em.op(OP_F64_SUB); em.localSet(omtx);
  const omty = em.allocLocal(F64); em.f64Const(1); em.localGet(ty); em.op(OP_F64_SUB); em.localSet(omty);

  if (ctx.is3d) {
    // 3D: an 8-cell trilinear splat. z0/z1 + tz/omtz; weight gets a 3rd factor.
    const fz = em.allocLocal(F64); pushF64Elem(em, ctx.layout.f64['z']!, ctx.idxLocal); em.localSet(fz);
    const z0 = em.allocLocal(I32); em.localGet(fz); em.op(OP_F64_FLOOR); em.f64ToI32(); em.localSet(z0);
    const tz = em.allocLocal(F64); em.localGet(fz); em.localGet(z0); em.i32ToF64(); em.op(OP_F64_SUB); em.localSet(tz);
    const z1 = em.allocLocal(I32); em.localGet(z0); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(z1);
    emitFieldWrapCoord(ctx, z0, 'z'); emitFieldWrapCoord(ctx, z1, 'z');
    const omtz = em.allocLocal(F64); em.f64Const(1); em.localGet(tz); em.op(OP_F64_SUB); em.localSet(omtz);
    const splat3 = (lL: number, yL: number, xL: number, wA: number, wB: number, wC: number) => {
      const ci = em.allocLocal(I32); emitFieldIdx(ctx, yL, xL, lL); em.localSet(ci);
      em.localGet(ci); em.i32Const(8); em.op(OP_I32_MUL); em.i32Const(fOff); em.op(OP_I32_ADD);   // addr
      pushF64Elem(em, fOff, ci);
      em.localGet(rate); em.localGet(wA); em.op(OP_F64_MUL); em.localGet(wB); em.op(OP_F64_MUL); em.localGet(wC); em.op(OP_F64_MUL);
      em.op(OP_F64_ADD); em.f64Store();
    };
    splat3(z0, y0, x0, omtx, omty, omtz);
    splat3(z0, y0, x1, tx,   omty, omtz);
    splat3(z0, y1, x0, omtx, ty,   omtz);
    splat3(z0, y1, x1, tx,   ty,   omtz);
    splat3(z1, y0, x0, omtx, omty, tz);
    splat3(z1, y0, x1, tx,   omty, tz);
    splat3(z1, y1, x0, omtx, ty,   tz);
    splat3(z1, y1, x1, tx,   ty,   tz);
    return;
  }

  const splat = (xL: number, yL: number, wA: number, wB: number) => {
    const ci = em.allocLocal(I32); emitFieldIdx(ctx, yL, xL); em.localSet(ci);
    em.localGet(ci); em.i32Const(8); em.op(OP_I32_MUL); em.i32Const(fOff); em.op(OP_I32_ADD);   // addr
    pushF64Elem(em, fOff, ci);
    em.localGet(rate); em.localGet(wA); em.op(OP_F64_MUL); em.localGet(wB); em.op(OP_F64_MUL);
    em.op(OP_F64_ADD); em.f64Store();
  };
  splat(x0, y0, omtx, omty);
  splat(x1, y0, tx, omty);
  splat(x0, y1, omtx, ty);
  splat(x1, y1, tx, ty);
}

/** Wrap or clamp a SINGLE i32 coordinate `cL` against a field axis dimension
 *  (`'x'`→`_fieldW`, `'y'`→`_fieldH`, `'z'`→`_fieldD`) exactly ONCE (torus → wrap;
 *  else → clamp). NB: a previous version wrapped (x,y) pairs, which double-wrapped a
 *  coordinate shared between two corner samples. */
function emitFieldWrapCoord(ctx: AgentWasmCtx, cL: number, axis: 'x' | 'y' | 'z'): void {
  const em = ctx.em;
  const pushDim = axis === 'x' ? () => pushFieldWInt(ctx) : axis === 'y' ? () => pushFieldHInt(ctx) : () => pushFieldDInt(ctx);
  em.localGet(ctx.fieldTorusLocal);
  em.ifThenElse(
    () => { wrapModInt(em, cL, pushDim); },
    () => { clampInt(em, cL, pushDim); },
  );
}

/** `n = ((n % m) + m) % m`. */
function wrapModInt(em: WasmEmitter, nL: number, pushM: () => void): void {
  em.localGet(nL); pushM(); em.op(OP_I32_REM_S); pushM(); em.op(OP_I32_ADD); pushM(); em.op(OP_I32_REM_S); em.localSet(nL);
}
/** `n = n<0?0 : n>=m?m-1 : n`. */
function clampInt(em: WasmEmitter, nL: number, pushM: () => void): void {
  em.localGet(nL); em.i32Const(0); em.op(OP_I32_LT_S);
  em.ifThenElse(
    () => { em.i32Const(0); em.localSet(nL); },
    () => { em.localGet(nL); pushM(); em.op(OP_I32_GE_S); em.ifThen(() => { pushM(); em.i32Const(1); em.op(OP_I32_SUB); em.localSet(nL); }); },
  );
}

function compileFieldNoop(_ctx: AgentWasmCtx): void { /* no field region → no-op */ }

/** Iterate the integer cells in the euclidean disc of radius `r` around (cx,cy),
 *  calling `body(ciLocal)` for each in-disc cell (torus-wrapped/clamped col/row).
 *  Mirrors AffectCellsUnder/ReadCellsUnder's 2D scan. */
function emitDiskLoop(ctx: AgentWasmCtx, cx: number, cy: number, _r: number, r2: number, body: (ciLocal: number) => void): void {
  const em = ctx.em;
  const cmin = em.allocLocal(I32); em.localGet(cx); em.localGet(_r); em.op(OP_F64_SUB); em.op(OP_F64_FLOOR); em.f64ToI32(); em.localSet(cmin);
  const cmax = em.allocLocal(I32); em.localGet(cx); em.localGet(_r); em.op(OP_F64_ADD); em.op(OP_F64_CEIL); em.f64ToI32(); em.localSet(cmax);
  const rmin = em.allocLocal(I32); em.localGet(cy); em.localGet(_r); em.op(OP_F64_SUB); em.op(OP_F64_FLOOR); em.f64ToI32(); em.localSet(rmin);
  const rmax = em.allocLocal(I32); em.localGet(cy); em.localGet(_r); em.op(OP_F64_ADD); em.op(OP_F64_CEIL); em.f64ToI32(); em.localSet(rmax);
  const rr = em.allocLocal(I32); em.localGet(rmin); em.localSet(rr);
  em.block(() => { em.loop(() => {
    em.localGet(rr); em.localGet(rmax); em.op(OP_I32_GT_S); em.brIf(1);
    const cc = em.allocLocal(I32); em.localGet(cmin); em.localSet(cc);
    em.block(() => { em.loop(() => {
      em.localGet(cc); em.localGet(cmax); em.op(OP_I32_GT_S); em.brIf(1);
      // dx = cc - cx; dy = rr - cy; if (dx*dx+dy*dy <= r2) { wrap/clamp; body }
      const dx = em.allocLocal(F64); em.localGet(cc); em.i32ToF64(); em.localGet(cx); em.op(OP_F64_SUB); em.localSet(dx);
      const dy = em.allocLocal(F64); em.localGet(rr); em.i32ToF64(); em.localGet(cy); em.op(OP_F64_SUB); em.localSet(dy);
      em.localGet(dx); em.localGet(dx); em.op(OP_F64_MUL); em.localGet(dy); em.localGet(dy); em.op(OP_F64_MUL); em.op(OP_F64_ADD);
      em.localGet(r2); em.op(OP_F64_LE);
      em.ifThen(() => {
        const col = em.allocLocal(I32); em.localGet(cc); em.localSet(col);
        const row = em.allocLocal(I32); em.localGet(rr); em.localSet(row);
        // torus → wrap; else if out of range, skip (use a skip flag)
        const skip = em.allocLocal(I32); em.i32Const(0); em.localSet(skip);
        em.localGet(ctx.fieldTorusLocal);
        em.ifThenElse(
          () => { wrapModInt(em, col, () => pushFieldWInt(ctx)); wrapModInt(em, row, () => pushFieldHInt(ctx)); },
          () => {
            em.localGet(col); em.i32Const(0); em.op(OP_I32_LT_S); em.localGet(col); pushFieldWInt(ctx); em.op(OP_I32_GE_S); em.op(OP_I32_OR);
            em.localGet(row); em.i32Const(0); em.op(OP_I32_LT_S); em.localGet(row); pushFieldHInt(ctx); em.op(OP_I32_GE_S); em.op(OP_I32_OR);
            em.op(OP_I32_OR); em.ifThen(() => { em.i32Const(1); em.localSet(skip); });
          },
        );
        em.localGet(skip); em.op(OP_I32_EQZ);
        em.ifThen(() => { const ci = em.allocLocal(I32); emitFieldIdx(ctx, row, col); em.localSet(ci); body(ci); });
      });
      em.localGet(cc); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(cc); em.br(0);
    }); });
    em.localGet(rr); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(rr); em.br(0);
  }); });
}

/** Fold a per-axis delta `dL` to the torus-shortest distance against half-dim
 *  `halfL` / full-dim `pushFull` — `if(d>half)d-=full; else if(d<-half)d+=full;`
 *  — but ONLY when `_fieldBoundaryTorus` (else the raw delta). Mirrors the 3D JS
 *  membership fold (so an r-sphere near a seam wraps correctly). */
function emitTorusDeltaFold(ctx: AgentWasmCtx, dL: number, halfL: number, pushFull: () => void): void {
  const em = ctx.em;
  em.localGet(ctx.fieldTorusLocal);
  em.ifThen(() => {
    em.localGet(dL); em.localGet(halfL); em.op(OP_F64_GT);
    em.ifThenElse(
      () => { em.localGet(dL); pushFull(); em.op(OP_F64_SUB); em.localSet(dL); },
      () => {
        // d < -half  →  push d, then (0 - half) [f64.sub is a-b, so 0,half → -half], then LT
        em.localGet(dL); em.f64Const(0); em.localGet(halfL); em.op(OP_F64_SUB); em.op(OP_F64_LT);
        em.ifThen(() => { em.localGet(dL); pushFull(); em.op(OP_F64_ADD); em.localSet(dL); });
      },
    );
  });
}

/** Iterate the integer cells in the euclidean r-SPHERE around (cx,cy,cz) (3D
 *  sibling of emitDiskLoop), calling `body(ciLocal)` per in-sphere cell with the
 *  3D index. The membership delta folds to the torus-SHORTEST distance (matching
 *  ReadCellsUnder/AffectCellsUnder's 3D JS), then col/row/lay are wrapped/skipped. */
function emitSphereLoop(ctx: AgentWasmCtx, cx: number, cy: number, cz: number, _r: number, r2: number, body: (ciLocal: number) => void): void {
  const em = ctx.em;
  const cmin = em.allocLocal(I32); em.localGet(cx); em.localGet(_r); em.op(OP_F64_SUB); em.op(OP_F64_FLOOR); em.f64ToI32(); em.localSet(cmin);
  const cmax = em.allocLocal(I32); em.localGet(cx); em.localGet(_r); em.op(OP_F64_ADD); em.op(OP_F64_CEIL); em.f64ToI32(); em.localSet(cmax);
  const rmin = em.allocLocal(I32); em.localGet(cy); em.localGet(_r); em.op(OP_F64_SUB); em.op(OP_F64_FLOOR); em.f64ToI32(); em.localSet(rmin);
  const rmax = em.allocLocal(I32); em.localGet(cy); em.localGet(_r); em.op(OP_F64_ADD); em.op(OP_F64_CEIL); em.f64ToI32(); em.localSet(rmax);
  const lmin = em.allocLocal(I32); em.localGet(cz); em.localGet(_r); em.op(OP_F64_SUB); em.op(OP_F64_FLOOR); em.f64ToI32(); em.localSet(lmin);
  const lmax = em.allocLocal(I32); em.localGet(cz); em.localGet(_r); em.op(OP_F64_ADD); em.op(OP_F64_CEIL); em.f64ToI32(); em.localSet(lmax);
  // half-dims (f64) for the torus-shortest membership fold
  const hW = em.allocLocal(F64); pushFieldWInt(ctx); em.i32ToF64(); em.f64Const(2); em.op(OP_F64_DIV); em.localSet(hW);
  const hH = em.allocLocal(F64); pushFieldHInt(ctx); em.i32ToF64(); em.f64Const(2); em.op(OP_F64_DIV); em.localSet(hH);
  const hD = em.allocLocal(F64); pushFieldDInt(ctx); em.i32ToF64(); em.f64Const(2); em.op(OP_F64_DIV); em.localSet(hD);
  const ll = em.allocLocal(I32); em.localGet(lmin); em.localSet(ll);
  em.block(() => { em.loop(() => {
    em.localGet(ll); em.localGet(lmax); em.op(OP_I32_GT_S); em.brIf(1);
    const rr = em.allocLocal(I32); em.localGet(rmin); em.localSet(rr);
    em.block(() => { em.loop(() => {
      em.localGet(rr); em.localGet(rmax); em.op(OP_I32_GT_S); em.brIf(1);
      const cc = em.allocLocal(I32); em.localGet(cmin); em.localSet(cc);
      em.block(() => { em.loop(() => {
        em.localGet(cc); em.localGet(cmax); em.op(OP_I32_GT_S); em.brIf(1);
        // dx=cc-cx; dy=rr-cy; dz=ll-cz; (torus-fold each); if dx²+dy²+dz²<=r2 { … }
        const dx = em.allocLocal(F64); em.localGet(cc); em.i32ToF64(); em.localGet(cx); em.op(OP_F64_SUB); em.localSet(dx);
        const dy = em.allocLocal(F64); em.localGet(rr); em.i32ToF64(); em.localGet(cy); em.op(OP_F64_SUB); em.localSet(dy);
        const dz = em.allocLocal(F64); em.localGet(ll); em.i32ToF64(); em.localGet(cz); em.op(OP_F64_SUB); em.localSet(dz);
        emitTorusDeltaFold(ctx, dx, hW, () => { pushFieldWInt(ctx); em.i32ToF64(); });
        emitTorusDeltaFold(ctx, dy, hH, () => { pushFieldHInt(ctx); em.i32ToF64(); });
        emitTorusDeltaFold(ctx, dz, hD, () => { pushFieldDInt(ctx); em.i32ToF64(); });
        em.localGet(dx); em.localGet(dx); em.op(OP_F64_MUL);
        em.localGet(dy); em.localGet(dy); em.op(OP_F64_MUL); em.op(OP_F64_ADD);
        em.localGet(dz); em.localGet(dz); em.op(OP_F64_MUL); em.op(OP_F64_ADD);
        em.localGet(r2); em.op(OP_F64_LE);
        em.ifThen(() => {
          const col = em.allocLocal(I32); em.localGet(cc); em.localSet(col);
          const row = em.allocLocal(I32); em.localGet(rr); em.localSet(row);
          const lay = em.allocLocal(I32); em.localGet(ll); em.localSet(lay);
          const skip = em.allocLocal(I32); em.i32Const(0); em.localSet(skip);
          em.localGet(ctx.fieldTorusLocal);
          em.ifThenElse(
            () => { wrapModInt(em, col, () => pushFieldWInt(ctx)); wrapModInt(em, row, () => pushFieldHInt(ctx)); wrapModInt(em, lay, () => pushFieldDInt(ctx)); },
            () => {
              em.localGet(col); em.i32Const(0); em.op(OP_I32_LT_S); em.localGet(col); pushFieldWInt(ctx); em.op(OP_I32_GE_S); em.op(OP_I32_OR);
              em.localGet(row); em.i32Const(0); em.op(OP_I32_LT_S); em.localGet(row); pushFieldHInt(ctx); em.op(OP_I32_GE_S); em.op(OP_I32_OR);
              em.op(OP_I32_OR);
              em.localGet(lay); em.i32Const(0); em.op(OP_I32_LT_S); em.localGet(lay); pushFieldDInt(ctx); em.op(OP_I32_GE_S); em.op(OP_I32_OR);
              em.op(OP_I32_OR); em.ifThen(() => { em.i32Const(1); em.localSet(skip); });
            },
          );
          em.localGet(skip); em.op(OP_I32_EQZ);
          em.ifThen(() => { const ci = em.allocLocal(I32); emitFieldIdx(ctx, row, col, lay); em.localSet(ci); body(ci); });
        });
        em.localGet(cc); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(cc); em.br(0);
      }); });
      em.localGet(rr); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(rr); em.br(0);
    }); });
    em.localGet(ll); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(ll); em.br(0);
  }); });
}

// --- field bridge reads (sampleField / fieldGradient / readCellsUnder) ---

/** Bilinear (2D) / trilinear (3D) sample of field `fieldId` at the f64 position
 *  pushed by pushPX/pushPY(/pushPZ). Leaves the f64 on the stack. Mirrors
 *  SampleFieldNode's math (index `(z*H+y)*W+x` in 3D). In a 3D model `pushPZ` MUST
 *  be supplied (the field nodes pass the agent z / a z-shifted z). */
function emitSampleFieldAt(ctx: AgentWasmCtx, fieldId: string, pushPX: () => void, pushPY: () => void, pushPZ?: () => void): void {
  const em = ctx.em;
  const fOff = ctx.layout.fieldOffset[fieldId];
  if (fOff === undefined) { em.f64Const(0); return; }
  const fx = em.allocLocal(F64); pushPX(); em.localSet(fx);
  const fy = em.allocLocal(F64); pushPY(); em.localSet(fy);
  const x0 = em.allocLocal(I32); em.localGet(fx); em.op(OP_F64_FLOOR); em.f64ToI32(); em.localSet(x0);
  const y0 = em.allocLocal(I32); em.localGet(fy); em.op(OP_F64_FLOOR); em.f64ToI32(); em.localSet(y0);
  const tx = em.allocLocal(F64); em.localGet(fx); em.localGet(x0); em.i32ToF64(); em.op(OP_F64_SUB); em.localSet(tx);
  const ty = em.allocLocal(F64); em.localGet(fy); em.localGet(y0); em.i32ToF64(); em.op(OP_F64_SUB); em.localSet(ty);
  const x1 = em.allocLocal(I32); em.localGet(x0); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(x1);
  const y1 = em.allocLocal(I32); em.localGet(y0); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(y1);
  // Wrap/clamp EACH coordinate EXACTLY ONCE (x via _fieldW, y via _fieldH).
  emitFieldWrapCoord(ctx, x0, 'x'); emitFieldWrapCoord(ctx, x1, 'x');
  emitFieldWrapCoord(ctx, y0, 'y'); emitFieldWrapCoord(ctx, y1, 'y');
  // f[y0*W+x0]*(1-tx)*(1-ty) + f[y0*W+x1]*tx*(1-ty) + f[y1*W+x0]*(1-tx)*ty + f[y1*W+x1]*tx*ty
  const omtx = em.allocLocal(F64); em.f64Const(1); em.localGet(tx); em.op(OP_F64_SUB); em.localSet(omtx);
  const omty = em.allocLocal(F64); em.f64Const(1); em.localGet(ty); em.op(OP_F64_SUB); em.localSet(omty);

  if (ctx.is3d && pushPZ) {
    // 3D: 8-corner trilinear sample via the SAME NESTED lerp the JS node uses
    // (SampleFieldNode 3D): c00..c11 = lerp_x; c0/c1 = lerp_y; result = lerp_z.
    // (NB: a flat Σ c·wx·wy·wz is mathematically equal but NOT bit-identical to
    // the nested form — JS rounds the nested lerps; matching it keeps bit-parity.)
    const fz = em.allocLocal(F64); pushPZ(); em.localSet(fz);
    const z0 = em.allocLocal(I32); em.localGet(fz); em.op(OP_F64_FLOOR); em.f64ToI32(); em.localSet(z0);
    const tz = em.allocLocal(F64); em.localGet(fz); em.localGet(z0); em.i32ToF64(); em.op(OP_F64_SUB); em.localSet(tz);
    const z1 = em.allocLocal(I32); em.localGet(z0); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(z1);
    emitFieldWrapCoord(ctx, z0, 'z'); emitFieldWrapCoord(ctx, z1, 'z');
    // read corner value f[(lay*H+row)*W+col] into a fresh local
    const corner = (lL: number, yL: number, xL: number): number => {
      const ci = em.allocLocal(I32); emitFieldIdx(ctx, yL, xL, lL); em.localSet(ci);
      const v = em.allocLocal(F64); pushF64Elem(em, fOff, ci); em.localSet(v); return v;
    };
    const c000 = corner(z0, y0, x0), c100 = corner(z0, y0, x1), c010 = corner(z0, y1, x0), c110 = corner(z0, y1, x1);
    const c001 = corner(z1, y0, x0), c101 = corner(z1, y0, x1), c011 = corner(z1, y1, x0), c111 = corner(z1, y1, x1);
    // lerp_x: cXY = cA*(1-tx) + cB*tx
    const lerpX = (cA: number, cB: number): number => {
      const out = em.allocLocal(F64);
      em.localGet(cA); em.localGet(omtx); em.op(OP_F64_MUL);
      em.localGet(cB); em.localGet(tx); em.op(OP_F64_MUL); em.op(OP_F64_ADD); em.localSet(out); return out;
    };
    const c00 = lerpX(c000, c100), c10 = lerpX(c010, c110), c01 = lerpX(c001, c101), c11 = lerpX(c011, c111);
    // lerp_y: cZ = cA*(1-ty) + cB*ty
    const lerpY = (cA: number, cB: number): number => {
      const out = em.allocLocal(F64);
      em.localGet(cA); em.localGet(omty); em.op(OP_F64_MUL);
      em.localGet(cB); em.localGet(ty); em.op(OP_F64_MUL); em.op(OP_F64_ADD); em.localSet(out); return out;
    };
    const c0 = lerpY(c00, c10), c1 = lerpY(c01, c11);
    // lerp_z: result = c0*(1-tz) + c1*tz   (left on the stack)
    em.localGet(c0); em.f64Const(1); em.localGet(tz); em.op(OP_F64_SUB); em.op(OP_F64_MUL);
    em.localGet(c1); em.localGet(tz); em.op(OP_F64_MUL); em.op(OP_F64_ADD);
    return;
  }

  const sample = (xL: number, yL: number, wA: number, wB: number) => {
    const ci = em.allocLocal(I32); emitFieldIdx(ctx, yL, xL); em.localSet(ci);
    pushF64Elem(em, fOff, ci); em.localGet(wA); em.op(OP_F64_MUL); em.localGet(wB); em.op(OP_F64_MUL);
  };
  sample(x0, y0, omtx, omty);
  sample(x1, y0, tx, omty); em.op(OP_F64_ADD);
  sample(x0, y1, omtx, ty); em.op(OP_F64_ADD);
  sample(x1, y1, tx, ty); em.op(OP_F64_ADD);
}

/** Field Gradient — central differences (±0.5) → dx/dy (+dz in 3D). Multi-output. */
function emitFieldGradient(ctx: AgentWasmCtx, node: GraphNode, portId: string): ValueRef {
  const em = ctx.em;
  const fieldId = (node.data.config?.['attributeId'] as string) || '';
  const cx = em.allocLocal(F64); pushF64Elem(em, ctx.layout.f64['x']!, ctx.idxLocal); em.localSet(cx);
  const cy = em.allocLocal(F64); pushF64Elem(em, ctx.layout.f64['y']!, ctx.idxLocal); em.localSet(cy);
  if (ctx.is3d) {
    const cz = em.allocLocal(F64); pushF64Elem(em, ctx.layout.f64['z']!, ctx.idxLocal); em.localSet(cz);
    const sampleAt = (dxv: number, dyv: number, dzv: number): void => {
      emitSampleFieldAt(ctx, fieldId,
        () => { em.localGet(cx); if (dxv !== 0) { em.f64Const(dxv); em.op(OP_F64_ADD); } },
        () => { em.localGet(cy); if (dyv !== 0) { em.f64Const(dyv); em.op(OP_F64_ADD); } },
        () => { em.localGet(cz); if (dzv !== 0) { em.f64Const(dzv); em.op(OP_F64_ADD); } });
    };
    const dxL = em.allocLocal(F64); sampleAt(0.5, 0, 0); sampleAt(-0.5, 0, 0); em.op(OP_F64_SUB); em.localSet(dxL);
    const dyL = em.allocLocal(F64); sampleAt(0, 0.5, 0); sampleAt(0, -0.5, 0); em.op(OP_F64_SUB); em.localSet(dyL);
    const dzL = em.allocLocal(F64); sampleAt(0, 0, 0.5); sampleAt(0, 0, -0.5); em.op(OP_F64_SUB); em.localSet(dzL);
    const dxRef: LocalRef = { localIdx: dxL, valtype: F64 }, dyRef: LocalRef = { localIdx: dyL, valtype: F64 }, dzRef: LocalRef = { localIdx: dzL, valtype: F64 };
    setCachedPort(ctx, node.id, 'dx', dxRef); setCachedPort(ctx, node.id, 'dy', dyRef); setCachedPort(ctx, node.id, 'dz', dzRef);
    return portId === 'dz' ? dzRef : portId === 'dy' ? dyRef : dxRef;
  }
  const sampleAt = (dxv: number, dyv: number): void => {
    emitSampleFieldAt(ctx, fieldId,
      () => { em.localGet(cx); if (dxv !== 0) { em.f64Const(dxv); em.op(OP_F64_ADD); } },
      () => { em.localGet(cy); if (dyv !== 0) { em.f64Const(dyv); em.op(OP_F64_ADD); } });
  };
  const dxL = em.allocLocal(F64); sampleAt(0.5, 0); sampleAt(-0.5, 0); em.op(OP_F64_SUB); em.localSet(dxL);
  const dyL = em.allocLocal(F64); sampleAt(0, 0.5); sampleAt(0, -0.5); em.op(OP_F64_SUB); em.localSet(dyL);
  const dxRef: LocalRef = { localIdx: dxL, valtype: F64 }, dyRef: LocalRef = { localIdx: dyL, valtype: F64 };
  setCachedPort(ctx, node.id, 'dx', dxRef); setCachedPort(ctx, node.id, 'dy', dyRef);
  return portId === 'dy' ? dyRef : dxRef;
}

/** Read Cells Under — r-disk (2D) / r-sphere (3D) aggregate (mean/sum/max/min). */
function emitReadCellsUnder(ctx: AgentWasmCtx, node: GraphNode): void {
  const em = ctx.em;
  const fieldId = (node.data.config?.['attributeId'] as string) || '';
  const fOff = ctx.layout.fieldOffset[fieldId];
  if (fOff === undefined) { em.f64Const(0); return; }
  const reduce = (node.data.config?.['reduce'] as string) || 'mean';
  const cx = em.allocLocal(F64); pushF64Elem(em, ctx.layout.f64['x']!, ctx.idxLocal); em.localSet(cx);
  const cy = em.allocLocal(F64); pushF64Elem(em, ctx.layout.f64['y']!, ctx.idxLocal); em.localSet(cy);
  const r = em.allocLocal(F64); pushValueInputF64(ctx, node, 'radius', 2); em.localSet(r);
  const r2 = em.allocLocal(F64); em.localGet(r); em.localGet(r); em.op(OP_F64_MUL); em.localSet(r2);
  const acc = em.allocLocal(F64); const n = em.allocLocal(I32); em.i32Const(0); em.localSet(n);
  const init = reduce === 'max' ? -Infinity : reduce === 'min' ? Infinity : 0;
  em.f64Const(init); em.localSet(acc);
  const reduceBody = (ciLocal: number) => {
    const val = em.allocLocal(F64); pushF64Elem(em, fOff, ciLocal); em.localSet(val);
    switch (reduce) {
      case 'max': em.localGet(acc); em.localGet(val); em.op(OP_F64_MAX); em.localSet(acc); break;
      case 'min': em.localGet(acc); em.localGet(val); em.op(OP_F64_MIN); em.localSet(acc); break;
      default: em.localGet(acc); em.localGet(val); em.op(OP_F64_ADD); em.localSet(acc); break; // sum/mean
    }
    em.localGet(n); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(n);
  };
  if (ctx.is3d) {
    const cz = em.allocLocal(F64); pushF64Elem(em, ctx.layout.f64['z']!, ctx.idxLocal); em.localSet(cz);
    emitSphereLoop(ctx, cx, cy, cz, r, r2, reduceBody);
  } else {
    emitDiskLoop(ctx, cx, cy, r, r2, reduceBody);
  }
  // finish: mean → n>0?acc/n:0 ; max/min → n>0?acc:0 ; sum → acc. NB:
  // WasmEmitter.ifThenElse uses an EMPTY block type, so the branches may NOT leave
  // a value on the stack — store into a result local + reload.
  const res = em.allocLocal(F64);
  if (reduce === 'mean') {
    em.localGet(n); em.i32Const(0); em.op(OP_I32_GT_S);
    em.ifThenElse(() => { em.localGet(acc); em.localGet(n); em.i32ToF64(); em.op(OP_F64_DIV); em.localSet(res); }, () => { em.f64Const(0); em.localSet(res); });
  } else if (reduce === 'max' || reduce === 'min') {
    em.localGet(n); em.i32Const(0); em.op(OP_I32_GT_S);
    em.ifThenElse(() => { em.localGet(acc); em.localSet(res); }, () => { em.f64Const(0); em.localSet(res); });
  } else {
    em.localGet(acc); em.localSet(res);
  }
  em.localGet(res);
}

/** `_agentForceX[idx] += <pushVal()>`. */
function forceAdd(ctx: AgentWasmCtx, regionOffset: number, pushVal: () => void): void {
  const em = ctx.em;
  pushF64ElemAddr(em, regionOffset, ctx.idxLocal);              // store address
  pushF64Elem(em, regionOffset, ctx.idxLocal);                 // current value
  pushVal();
  em.op(OP_F64_ADD);
  em.f64Store();
}

/** `_agentForce*[aLocal] += <pushVal()>` — the cross-agent (arbitrary target)
 *  sibling of `forceAdd`. Used by applyForceToAgent (target ≠ idx). */
function forceAddAt(ctx: AgentWasmCtx, regionOffset: number, aLocal: number, pushVal: () => void): void {
  const em = ctx.em;
  pushF64ElemAddr(em, regionOffset, aLocal);
  pushF64Elem(em, regionOffset, aLocal);
  pushVal();
  em.op(OP_F64_ADD);
  em.f64Store();
}

// ---------------------------------------------------------------------------
// getNearbyAgents + forEachInArray — the keystone.
//
// getNearbyAgents fills a scratch i32 array (in agent memory at its assigned slot)
// with the matched agent ids + records the count in a `len` i32 local. It's the
// only array producer; its consumer is forEachInArray. We model the "array" not
// as an ArrayRef object that flows through value resolution, but by emitting the
// fill immediately before the forEach loop and exposing (scratchBaseLocal, lenLocal).
// ---------------------------------------------------------------------------

/** Compile getNearbyAgents (the source feeding this forEach's `array`) — fills the
 *  node's scratch slot with matched ids; returns `{ baseLocal, lenLocal }` (i32
 *  byte-address base + element count). Mirrors GetNearbyAgentsNode's JS emit (the
 *  3×3[×3] hash stencil + torus wrap + the all-pairs fallback). */
function emitNearbyFill(ctx: AgentWasmCtx, naNode: GraphNode): { baseLocal: number; lenLocal: number } {
  const em = ctx.em;
  const L = ctx.layout;
  const slot = ctx.nearbyScratchSlot.get(naNode.id)!;
  const baseConst = L.nearbyScratchOffset + slot * L.maxAgents * 4;   // byte offset
  const baseLocal = em.allocLocal(I32); em.i32Const(baseConst); em.localSet(baseLocal);
  const lenLocal = em.allocLocal(I32); em.i32Const(0); em.localSet(lenLocal);
  // query params
  const qr = resolveValueInput(ctx, naNode, 'radius', 5);
  const r2L = em.allocLocal(F64); pushValueAs(em, qr, F64); em.localTee(r2L); em.localGet(r2L); em.op(OP_F64_MUL); em.localSet(r2L);
  const xiL = em.allocLocal(F64); pushF64Elem(em, L.f64['x']!, ctx.idxLocal); em.localSet(xiL);
  const yiL = em.allocLocal(F64); pushF64Elem(em, L.f64['y']!, ctx.idxLocal); em.localSet(yiL);
  const ziL = em.allocLocal(F64); if (ctx.is3d) { pushF64Elem(em, L.f64['z']!, ctx.idxLocal); em.localSet(ziL); } else { em.f64Const(0); em.localSet(ziL); }

  // FOV cone (getAgentsInView only) — the heading (hx,hy[,hz]) + |heading| + √|h|²,
  // computed ONCE per agent (before the neighbour loop). Mirrors the JS emit's
  // preamble EXACTLY (same op order) for bit-parity: cosHalf is the SAME compile-
  // time literal (viewCosHalf, no runtime cos). getNearbyAgents (and the omni
  // fast-path, halfAngle≥180) keep cone=null ⇒ the push below is byte-identical.
  let cone: { cosHalf: number; hxL: number; hyL: number; hzL: number; hm2L: number; hmL: number } | null = null;
  if (naNode.data.nodeType === 'getAgentsInView') {
    const { cosHalf, omni } = viewCosHalf(naNode.data.config as Record<string, unknown>);
    if (!omni) {
      const wired = naNode.data.config.headingSource === 'wired';
      const hxL = em.allocLocal(F64), hyL = em.allocLocal(F64);
      let hzL = -1;
      if (wired) {
        pushValueAs(em, resolveValueInput(ctx, naNode, 'headingX', 0), F64); em.localSet(hxL);
        pushValueAs(em, resolveValueInput(ctx, naNode, 'headingY', 0), F64); em.localSet(hyL);
        if (ctx.is3d) { hzL = em.allocLocal(F64); pushValueAs(em, resolveValueInput(ctx, naNode, 'headingZ', 0), F64); em.localSet(hzL); }
      } else {
        pushF64Elem(em, L.f64['vx']!, ctx.idxLocal); em.localSet(hxL);
        pushF64Elem(em, L.f64['vy']!, ctx.idxLocal); em.localSet(hyL);
        if (ctx.is3d) { hzL = em.allocLocal(F64); pushF64Elem(em, L.f64['vz']!, ctx.idxLocal); em.localSet(hzL); }
      }
      // hm2 = hx*hx + hy*hy [+ hz*hz];  hm = sqrt(hm2)   (JS: __hx*__hx+__hy*__hy…)
      const hm2L = em.allocLocal(F64), hmL = em.allocLocal(F64);
      em.localGet(hxL); em.localGet(hxL); em.op(OP_F64_MUL);
      em.localGet(hyL); em.localGet(hyL); em.op(OP_F64_MUL); em.op(OP_F64_ADD);
      if (ctx.is3d && hzL >= 0) { em.localGet(hzL); em.localGet(hzL); em.op(OP_F64_MUL); em.op(OP_F64_ADD); }
      em.localTee(hm2L); em.op(OP_F64_SQRT); em.localSet(hmL);
      cone = { cosHalf, hxL, hyL, hzL, hm2L, hmL };
    }
  }

  // The candidate test, applied to a candidate agent id local jL. Pushes jL into
  // scratch + bumps len when (j != idx && alive[j] && torus-folded d2 <= r2).
  const aliveOff = L.u8['alive']!;
  const test = (jL: number) => {
    // if (j != idx)
    em.localGet(jL); em.localGet(ctx.idxLocal); em.op(OP_I32_NE);
    em.ifThen(() => {
      // if (alive[j])
      em.localGet(jL); em.i32Const(aliveOff); em.op(OP_I32_ADD); em.i32Load8U();
      em.ifThen(() => {
        const dxL = em.allocLocal(F64), dyL = em.allocLocal(F64);
        pushF64Elem(em, L.f64['x']!, jL); em.localGet(xiL); em.op(OP_F64_SUB); em.localSet(dxL);
        pushF64Elem(em, L.f64['y']!, jL); em.localGet(yiL); em.op(OP_F64_SUB); em.localSet(dyL);
        let dzL = -1;
        if (ctx.is3d) { dzL = em.allocLocal(F64); pushF64Elem(em, L.f64['z']!, jL); em.localGet(ziL); em.op(OP_F64_SUB); em.localSet(dzL); }
        em.localGet(ctx.fieldTorusLocal);
        em.ifThen(() => {
          foldTorus(em, dxL, ctx.fieldWLocal);
          foldTorus(em, dyL, ctx.fieldHLocal);
          if (ctx.is3d && dzL >= 0) foldTorus(em, dzL, ctx.fieldDLocal);
        });
        // d2 = dx*dx + dy*dy [+ dz*dz]
        const d2L = em.allocLocal(F64);
        em.localGet(dxL); em.localGet(dxL); em.op(OP_F64_MUL);
        em.localGet(dyL); em.localGet(dyL); em.op(OP_F64_MUL); em.op(OP_F64_ADD);
        if (ctx.is3d && dzL >= 0) { em.localGet(dzL); em.localGet(dzL); em.op(OP_F64_MUL); em.op(OP_F64_ADD); }
        em.localSet(d2L);
        // scratch[len++] = j
        const doPush = () => {
          em.localGet(baseLocal); em.localGet(lenLocal); em.i32Const(4); em.op(OP_I32_MUL); em.op(OP_I32_ADD);
          em.localGet(jL);
          em.i32Store();
          em.localGet(lenLocal); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(lenLocal);
        };
        // if (d2 <= r2) { <cone gate> push }
        em.localGet(d2L); em.localGet(r2L); em.op(OP_F64_LE);
        em.ifThen(() => {
          if (!cone) { doPush(); return; }
          // Cone (getAgentsInView): if (hm2 == 0) omnidirectional push; else include
          // when dot(h, offset) >= cosHalf·|h|·d  (division-free `cosA ≥ cosHalf`).
          // EXACT JS op order for bit-parity: dot = hx*dx+hy*dy[+hz*dz]; d=√d2;
          // rhs = (cosHalf*hm)*d.
          em.localGet(cone.hm2L); em.f64Const(0); em.op(OP_F64_EQ);
          em.ifThenElse(
            () => doPush(),
            () => {
              const dL = em.allocLocal(F64), dotL = em.allocLocal(F64);
              em.localGet(d2L); em.op(OP_F64_SQRT); em.localSet(dL);
              em.localGet(cone!.hxL); em.localGet(dxL); em.op(OP_F64_MUL);
              em.localGet(cone!.hyL); em.localGet(dyL); em.op(OP_F64_MUL); em.op(OP_F64_ADD);
              if (ctx.is3d && dzL >= 0) { em.localGet(cone!.hzL); em.localGet(dzL); em.op(OP_F64_MUL); em.op(OP_F64_ADD); }
              em.localSet(dotL);
              em.localGet(dotL);
              em.f64Const(cone!.cosHalf); em.localGet(cone!.hmL); em.op(OP_F64_MUL); em.localGet(dL); em.op(OP_F64_MUL);
              em.op(OP_F64_GE);
              em.ifThen(() => doPush());
            },
          );
        });
      });
    });
  };

  // if (_hashValid) { 3x3[x3] bin stencil } else { all-pairs }
  em.localGet(ctx.hashValidLocal);
  em.ifThenElse(
    () => emitHashStencil(ctx, test, xiL, yiL, ziL),
    () => emitAllPairs(ctx, test),
  );
  return { baseLocal, lenLocal };
}

/** Sense Hemifield (the Braitenberg L/R sensor) — one gather pass into TWO i32
 *  counters (no scratch array; not an array producer). Reuses the SAME stencil +
 *  cone gate as emitNearbyFill; each in-view neighbour is split by the sign of the
 *  heading-relative cross product (2D: hx·dy−hy·dx; 3D: the triple product against a
 *  +Z up-reference, swapped to +Y for a near-vertical heading). Mirrors
 *  SenseHemifieldNode's JS emit EXACTLY (op order + the 0.81 up-swap literal) for
 *  bit-parity. Multi-output: leftCount / rightCount cached under the valueCache. */
function emitSenseHemifield(ctx: AgentWasmCtx, node: GraphNode, portId: string): ValueRef {
  const em = ctx.em;
  const L = ctx.layout;
  const cached = ctx.valueCache.get(`${node.id}:leftCount`);
  if (cached !== undefined) return ctx.valueCache.get(`${node.id}:${portId}`) ?? cached;

  const leftL = em.allocLocal(I32); em.i32Const(0); em.localSet(leftL);
  const rightL = em.allocLocal(I32); em.i32Const(0); em.localSet(rightL);
  // query params (mirror emitNearbyFill)
  const qr = resolveValueInput(ctx, node, 'radius', 5);
  const r2L = em.allocLocal(F64); pushValueAs(em, qr, F64); em.localTee(r2L); em.localGet(r2L); em.op(OP_F64_MUL); em.localSet(r2L);
  const xiL = em.allocLocal(F64); pushF64Elem(em, L.f64['x']!, ctx.idxLocal); em.localSet(xiL);
  const yiL = em.allocLocal(F64); pushF64Elem(em, L.f64['y']!, ctx.idxLocal); em.localSet(yiL);
  const ziL = em.allocLocal(F64); if (ctx.is3d) { pushF64Elem(em, L.f64['z']!, ctx.idxLocal); em.localSet(ziL); } else { em.f64Const(0); em.localSet(ziL); }

  // heading (hx,hy[,hz]) + |heading| — ALWAYS needed (the cross uses it), plus cosHalf.
  const { cosHalf, omni } = viewCosHalf(node.data.config as Record<string, unknown>);
  const wired = node.data.config.headingSource === 'wired';
  const hxL = em.allocLocal(F64), hyL = em.allocLocal(F64);
  let hzL = -1;
  if (wired) {
    pushValueAs(em, resolveValueInput(ctx, node, 'headingX', 0), F64); em.localSet(hxL);
    pushValueAs(em, resolveValueInput(ctx, node, 'headingY', 0), F64); em.localSet(hyL);
    if (ctx.is3d) { hzL = em.allocLocal(F64); pushValueAs(em, resolveValueInput(ctx, node, 'headingZ', 0), F64); em.localSet(hzL); }
  } else {
    pushF64Elem(em, L.f64['vx']!, ctx.idxLocal); em.localSet(hxL);
    pushF64Elem(em, L.f64['vy']!, ctx.idxLocal); em.localSet(hyL);
    if (ctx.is3d) { hzL = em.allocLocal(F64); pushF64Elem(em, L.f64['vz']!, ctx.idxLocal); em.localSet(hzL); }
  }
  const hm2L = em.allocLocal(F64), hmL = em.allocLocal(F64);
  em.localGet(hxL); em.localGet(hxL); em.op(OP_F64_MUL);
  em.localGet(hyL); em.localGet(hyL); em.op(OP_F64_MUL); em.op(OP_F64_ADD);
  if (ctx.is3d && hzL >= 0) { em.localGet(hzL); em.localGet(hzL); em.op(OP_F64_MUL); em.op(OP_F64_ADD); }
  em.localTee(hm2L); em.op(OP_F64_SQRT); em.localSet(hmL);
  // upY (3D): hz*hz > 0.81*hm2 (the near-vertical-heading up-swap; JS: __hz*__hz>0.81*__hm2).
  let upYL = -1;
  if (ctx.is3d && hzL >= 0) {
    upYL = em.allocLocal(I32);
    em.localGet(hzL); em.localGet(hzL); em.op(OP_F64_MUL);
    em.f64Const(0.81); em.localGet(hm2L); em.op(OP_F64_MUL);
    em.op(OP_F64_GT); em.localSet(upYL);
  }

  const aliveOff = L.u8['alive']!;
  const test = (jL: number) => {
    em.localGet(jL); em.localGet(ctx.idxLocal); em.op(OP_I32_NE);
    em.ifThen(() => {
      em.localGet(jL); em.i32Const(aliveOff); em.op(OP_I32_ADD); em.i32Load8U();
      em.ifThen(() => {
        const dxL = em.allocLocal(F64), dyL = em.allocLocal(F64);
        pushF64Elem(em, L.f64['x']!, jL); em.localGet(xiL); em.op(OP_F64_SUB); em.localSet(dxL);
        pushF64Elem(em, L.f64['y']!, jL); em.localGet(yiL); em.op(OP_F64_SUB); em.localSet(dyL);
        let dzL = -1;
        if (ctx.is3d) { dzL = em.allocLocal(F64); pushF64Elem(em, L.f64['z']!, jL); em.localGet(ziL); em.op(OP_F64_SUB); em.localSet(dzL); }
        em.localGet(ctx.fieldTorusLocal);
        em.ifThen(() => {
          foldTorus(em, dxL, ctx.fieldWLocal);
          foldTorus(em, dyL, ctx.fieldHLocal);
          if (ctx.is3d && dzL >= 0) foldTorus(em, dzL, ctx.fieldDLocal);
        });
        const d2L = em.allocLocal(F64);
        em.localGet(dxL); em.localGet(dxL); em.op(OP_F64_MUL);
        em.localGet(dyL); em.localGet(dyL); em.op(OP_F64_MUL); em.op(OP_F64_ADD);
        if (ctx.is3d && dzL >= 0) { em.localGet(dzL); em.localGet(dzL); em.op(OP_F64_MUL); em.op(OP_F64_ADD); }
        em.localSet(d2L);
        // tally: cross = 2D (hx*dy - hy*dx) | 3D select(hz*dx - hx*dz, hx*dy - hy*dx, upY);
        // if (cross >= 0) left++ else right++.
        const doTally = () => {
          const crossL = em.allocLocal(F64);
          if (ctx.is3d && dzL >= 0 && upYL >= 0) {
            // OP_SELECT pops [a, b, cond] → a if cond!=0 else b. a = +Y form, b = +Z form.
            em.localGet(hzL); em.localGet(dxL); em.op(OP_F64_MUL);
            em.localGet(hxL); em.localGet(dzL); em.op(OP_F64_MUL); em.op(OP_F64_SUB);   // a = hz*dx - hx*dz
            em.localGet(hxL); em.localGet(dyL); em.op(OP_F64_MUL);
            em.localGet(hyL); em.localGet(dxL); em.op(OP_F64_MUL); em.op(OP_F64_SUB);   // b = hx*dy - hy*dx
            em.localGet(upYL);
            em.op(OP_SELECT);
            em.localSet(crossL);
          } else {
            em.localGet(hxL); em.localGet(dyL); em.op(OP_F64_MUL);
            em.localGet(hyL); em.localGet(dxL); em.op(OP_F64_MUL); em.op(OP_F64_SUB);   // hx*dy - hy*dx
            em.localSet(crossL);
          }
          em.localGet(crossL); em.f64Const(0); em.op(OP_F64_GE);
          em.ifThenElse(
            () => { em.localGet(leftL); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(leftL); },
            () => { em.localGet(rightL); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(rightL); },
          );
        };
        // if (d2 <= r2) { cone gate → doTally }
        em.localGet(d2L); em.localGet(r2L); em.op(OP_F64_LE);
        em.ifThen(() => {
          if (omni) { doTally(); return; }
          em.localGet(hm2L); em.f64Const(0); em.op(OP_F64_EQ);
          em.ifThenElse(
            () => doTally(),
            () => {
              const dL = em.allocLocal(F64), dotL = em.allocLocal(F64);
              em.localGet(d2L); em.op(OP_F64_SQRT); em.localSet(dL);
              em.localGet(hxL); em.localGet(dxL); em.op(OP_F64_MUL);
              em.localGet(hyL); em.localGet(dyL); em.op(OP_F64_MUL); em.op(OP_F64_ADD);
              if (ctx.is3d && dzL >= 0) { em.localGet(hzL); em.localGet(dzL); em.op(OP_F64_MUL); em.op(OP_F64_ADD); }
              em.localSet(dotL);
              em.localGet(dotL);
              em.f64Const(cosHalf); em.localGet(hmL); em.op(OP_F64_MUL); em.localGet(dL); em.op(OP_F64_MUL);
              em.op(OP_F64_GE);
              em.ifThen(() => doTally());
            },
          );
        });
      });
    });
  };

  em.localGet(ctx.hashValidLocal);
  em.ifThenElse(
    () => emitHashStencil(ctx, test, xiL, yiL, ziL),
    () => emitAllPairs(ctx, test),
  );

  const refs: Record<string, ValueRef> = {
    leftCount: { localIdx: leftL, valtype: I32 },
    rightCount: { localIdx: rightL, valtype: I32 },
  };
  for (const k of Object.keys(refs)) ctx.valueCache.set(`${node.id}:${k}`, refs[k]!);
  return refs[portId] ?? refs['leftCount']!;
}

/** The 3×3[×3] hash-bin stencil over the in-memory binStart/binAgents, torus-
 *  wrapped exactly like the JS emit. Calls `test(jLocal)` for each candidate. */
function emitHashStencil(ctx: AgentWasmCtx, test: (jL: number) => void, xiL: number, yiL: number, ziL: number): void {
  const em = ctx.em;
  const L = ctx.layout;
  const binStartOff = L.hashBinStartOffset, binAgentsOff = L.hashBinAgentsOffset;
  // bx = clamp(((xi-originX)/binSizeX)|0, 0, nBinsX-1); same for by[,bz].
  const clampBin = (coordL: number, originL: number, sizeL: number, nBinsL: number): number => {
    const b = em.allocLocal(I32);
    em.localGet(coordL); em.localGet(originL); em.op(OP_F64_SUB); em.localGet(sizeL); em.op(OP_F64_DIV); em.f64ToI32(); em.localSet(b);
    // if (b < 0) b = 0
    em.localGet(b); em.i32Const(0); em.op(OP_I32_LT_S);
    em.ifThenElse(
      () => { em.i32Const(0); em.localSet(b); },
      () => {
        // else if (b >= nBins) b = nBins-1
        em.localGet(b); em.localGet(nBinsL); em.op(OP_I32_GE_S);
        em.ifThen(() => { em.localGet(nBinsL); em.i32Const(1); em.op(OP_I32_SUB); em.localSet(b); });
      },
    );
    return b;
  };
  const bx = clampBin(xiL, ctx.originXLocal, ctx.binSizeXLocal, ctx.nBinsXLocal);
  const by = clampBin(yiL, ctx.originYLocal, ctx.binSizeYLocal, ctx.nBinsYLocal);
  const bz = ctx.is3d ? clampBin(ziL, ctx.originZLocal, ctx.binSizeZLocal, ctx.nBinsZLocal) : -1;

  // wrapped neighbour-bin coordinate: torus → ((nb % n) + n) % n; else range-check.
  // We loop ddz (3D) / ddy / ddx in [-1,1].
  const ezL = em.allocLocal(I32), eyL = em.allocLocal(I32), exL = em.allocLocal(I32);

  const innerBody = () => {
    // nbx = bx + ex; nby = by + ey; nbz = bz + ez (3D)
    const nbx = em.allocLocal(I32), nby = em.allocLocal(I32);
    em.localGet(bx); em.localGet(exL); em.op(OP_I32_ADD); em.localSet(nbx);
    em.localGet(by); em.localGet(eyL); em.op(OP_I32_ADD); em.localSet(nby);
    let nbz = -1;
    if (ctx.is3d) { nbz = em.allocLocal(I32); em.localGet(bz); em.localGet(ezL); em.op(OP_I32_ADD); em.localSet(nbz); }
    // skipFlag (i32): 1 ⇒ this neighbour bin is out of range (non-torus); skip.
    const skipL = em.allocLocal(I32); em.i32Const(0); em.localSet(skipL);
    em.localGet(ctx.fieldTorusLocal);
    em.ifThenElse(
      () => {
        wrapMod(em, nbx, ctx.nBinsXLocal);
        wrapMod(em, nby, ctx.nBinsYLocal);
        if (ctx.is3d && nbz >= 0) wrapMod(em, nbz, ctx.nBinsZLocal);
      },
      () => {
        // if (nbx<0||nbx>=nx||nby<0||nby>=ny[||nbz...]) skip=1
        rangeBad(em, nbx, ctx.nBinsXLocal, skipL);
        rangeBad(em, nby, ctx.nBinsYLocal, skipL);
        if (ctx.is3d && nbz >= 0) rangeBad(em, nbz, ctx.nBinsZLocal, skipL);
      },
    );
    em.localGet(skipL); em.op(OP_I32_EQZ);
    em.ifThen(() => {
      // b = is3d ? (nbz*nBinsY + nby)*nBinsX + nbx : nby*nBinsX + nbx
      const bIdx = em.allocLocal(I32);
      if (ctx.is3d && nbz >= 0) {
        em.localGet(nbz); em.localGet(ctx.nBinsYLocal); em.op(OP_I32_MUL); em.localGet(nby); em.op(OP_I32_ADD);
        em.localGet(ctx.nBinsXLocal); em.op(OP_I32_MUL); em.localGet(nbx); em.op(OP_I32_ADD); em.localSet(bIdx);
      } else {
        em.localGet(nby); em.localGet(ctx.nBinsXLocal); em.op(OP_I32_MUL); em.localGet(nbx); em.op(OP_I32_ADD); em.localSet(bIdx);
      }
      // p = binStart[b]; end = binStart[b+1]; for (; p<end; p++) { j = binAgents[p]; test(j) }
      const pL = em.allocLocal(I32), endL = em.allocLocal(I32);
      // p = binStart[b] : load i32 at binStartOff + b*4
      em.localGet(bIdx); em.i32Const(4); em.op(OP_I32_MUL); em.i32Const(binStartOff); em.op(OP_I32_ADD); em.i32Load(); em.localSet(pL);
      em.localGet(bIdx); em.i32Const(1); em.op(OP_I32_ADD); em.i32Const(4); em.op(OP_I32_MUL); em.i32Const(binStartOff); em.op(OP_I32_ADD); em.i32Load(); em.localSet(endL);
      em.block(() => {
        em.loop(() => {
          em.localGet(pL); em.localGet(endL); em.op(OP_I32_GE_S); em.brIf(1);
          const jL = em.allocLocal(I32);
          em.localGet(pL); em.i32Const(4); em.op(OP_I32_MUL); em.i32Const(binAgentsOff); em.op(OP_I32_ADD); em.i32Load(); em.localSet(jL);
          test(jL);
          em.localGet(pL); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(pL);
          em.br(0);
        });
      });
    });
  };

  // for ez in [-1,1] (3D) { for ey { for ex { innerBody } } }
  const ddLoop = (varL: number, body: () => void) => {
    em.i32Const(-1); em.localSet(varL);
    em.block(() => {
      em.loop(() => {
        em.localGet(varL); em.i32Const(1); em.op(OP_I32_GT_S); em.brIf(1);
        body();
        em.localGet(varL); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(varL);
        em.br(0);
      });
    });
  };
  if (ctx.is3d) {
    ddLoop(ezL, () => ddLoop(eyL, () => ddLoop(exL, innerBody)));
  } else {
    em.i32Const(0); em.localSet(ezL); // ez fixed 0 in 2D (innerBody ignores it)
    ddLoop(eyL, () => ddLoop(exL, innerBody));
  }
}

/** `n = ((n % m) + m) % m` (positive modulo) in place on i32 local n. */
function wrapMod(em: WasmEmitter, nLocal: number, mLocal: number): void {
  em.localGet(nLocal); em.localGet(mLocal); em.op(OP_I32_REM_S);
  em.localGet(mLocal); em.op(OP_I32_ADD);
  em.localGet(mLocal); em.op(OP_I32_REM_S);
  em.localSet(nLocal);
}

/** `if (n < 0 || n >= m) skip = 1`. */
function rangeBad(em: WasmEmitter, nLocal: number, mLocal: number, skipLocal: number): void {
  em.localGet(nLocal); em.i32Const(0); em.op(OP_I32_LT_S);
  em.localGet(nLocal); em.localGet(mLocal); em.op(OP_I32_GE_S);
  em.op(OP_I32_OR);
  em.ifThen(() => { em.i32Const(1); em.localSet(skipLocal); });
}

/** All-pairs fallback: for (all=0; all<highWater; all++) test(all). */
function emitAllPairs(ctx: AgentWasmCtx, test: (jL: number) => void): void {
  const em = ctx.em;
  const allL = em.allocLocal(I32); em.i32Const(0); em.localSet(allL);
  em.block(() => {
    em.loop(() => {
      em.localGet(allL); em.localGet(ctx.highWaterLocal); em.op(OP_I32_GE_S); em.brIf(1);
      test(allL);
      em.localGet(allL); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(allL);
      em.br(0);
    });
  });
}

/** forEachInArray over ANY array producer (id arrays from getNearbyAgents /
 *  getBondedAgents / filter / join / picks, OR value arrays from getAgentsAttribute
 *  / array variables). Resolves the array ONCE (before the loop), then loops
 *  `for (fi=0; fi<len; fi++) { element = arr[fi]; index = fi; <body>; }`.
 *  The body's value cache is cleared each iteration for volatile (element/index-
 *  dependent) nodes. The `element` port carries the array element type (id arrays →
 *  i32, value arrays → f64). */
function emitForEach(ctx: AgentWasmCtx, node: GraphNode): void {
  const em = ctx.em;
  const arr = resolveInputArray(ctx, node, 'array');
  if (!arr) return; // no array wired → body + done skipped (JS parity)
  const fiL = em.allocLocal(I32); em.i32Const(0); em.localSet(fiL);
  // element type follows the array: f64 value arrays use an f64 local, id arrays i32.
  const elemL = em.allocLocal(arr.isF64 ? F64 : I32);
  ctx.forEachStack.push({ nodeId: node.id, elemLocal: elemL, idxLocal: fiL });
  // forEach node's element port is currently registered as i32 in compileValueNode;
  // when the array is f64 we mark the element f64 by recording it on the frame.
  forEachElemIsF64.set(node.id, arr.isF64);
  em.block(() => {
    em.loop(() => {
      em.localGet(fiL); em.localGet(arr.lenLocal); em.op(OP_I32_GE_S); em.brIf(1);
      // element = arr[fi]
      if (arr.isF64) { pushArrayElemF64(em, arr, fiL); em.localSet(elemL); }
      else { pushArrayElemI32(em, arr, fiL); em.localSet(elemL); }
      const s = enterCacheScope(ctx);
      clearVolatileCache(ctx);
      compileFlowChain(ctx, node.id, 'body');
      exitCacheScope(ctx, s);
      em.localGet(fiL); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(fiL);
      em.br(0);
    });
  });
  ctx.forEachStack.pop();
  forEachElemIsF64.delete(node.id);
  clearVolatileCache(ctx);
}

/** Per-forEach: whether its `element` is an f64 value (value array) or i32 id. */
const forEachElemIsF64 = new Map<string, boolean>();

/** Drop cached values + arrays for volatile nodes so they re-emit at the next use. */
function clearVolatileCache(ctx: AgentWasmCtx): void {
  for (const k of [...ctx.valueCache.keys()]) {
    const nid = k.slice(0, k.lastIndexOf(':'));
    if (ctx.volatileNodes.has(nid)) ctx.valueCache.delete(k);
  }
  for (const k of [...ctx.arrayCache.keys()]) {
    const nid = k.slice(0, k.lastIndexOf(':'));
    if (ctx.volatileNodes.has(nid)) ctx.arrayCache.delete(k);
  }
}

// ---------------------------------------------------------------------------
// Block-scope cache discipline (the flow-DIAMOND fix — mirrors agentWebgpu).
//
// `compileFlowChain` has NO visited guard, so a flow DIAMOND (a node reached from
// >1 sibling branch — a conditional `then` AND `else` both flowing into a shared
// downstream node) inlines that shared node's body ONCE PER branch walk. A value
// in the shared body NOT hoisted to function-top by preEmitAgentValues (an impure
// cone — e.g. a getRandom-tainted expression) is emitted to a local + cached during
// the FIRST branch's walk; the SECOND branch's walk then hits the cache and reads
// that local WITHOUT re-emitting the `local.set` (which lives only in the first
// branch's bytecode). WASM locals are function-scoped so it doesn't fail to
// validate (unlike WGSL), but at runtime the second branch reads a STALE local (or
// skips the getRandom draw entirely) — silently wrong AND breaks JS↔WASM parity.
//
// Fix: snapshot the value + array caches on entering a flow block, and on exit drop
// every entry ADDED inside it, so the shared body re-emits (its `local.set`) in each
// sibling branch. Pure cross-branch values pre-exist at snapshot time (hoisted at
// function-top) → survive → byte-identical for models with no diamond. Snapshot is
// taken BEFORE the entry clearVolatileCache, so volatile handling is unchanged.
// ---------------------------------------------------------------------------

interface AgentCacheScope { v: Set<string>; a: Set<string>; }

function enterCacheScope(ctx: AgentWasmCtx): AgentCacheScope {
  return { v: new Set(ctx.valueCache.keys()), a: new Set(ctx.arrayCache.keys()) };
}

function exitCacheScope(ctx: AgentWasmCtx, snap: AgentCacheScope): void {
  for (const k of [...ctx.valueCache.keys()]) if (!snap.v.has(k)) ctx.valueCache.delete(k);
  for (const k of [...ctx.arrayCache.keys()]) if (!snap.a.has(k)) ctx.arrayCache.delete(k);
}

// ---------------------------------------------------------------------------
// Volatility analysis — a node is volatile (don't cache across a forEach
// iteration) iff it transitively reads a forEach element/index OR a getVariable
// (mutated by setVariable). Mirrors the JS compiler's NEVER_INVARIANT + volatile
// rationale for the supported set.
// ---------------------------------------------------------------------------

function computeVolatile(ctx: AgentWasmCtx, extraSeeds?: Set<string>): void {
  const { nodeMap, inputToSource, inputToSources } = ctx.adj;
  // Seeds: forEachInArray / forEachBond (per-iteration element/index/partner),
  // getVariable (mutable Local Variable storage), AND the async read-after-write
  // hazard reads (`extraSeeds`, from the shared computeAsyncReadWriteHazards —
  // attribute / engine-buffer reads that flow-follow a matching write must
  // re-emit at use, mirroring the JS volatile pin). A node is volatile iff it
  // transitively reads one of these — its cached value is dropped at every
  // forEach/loop iteration + branch boundary so it re-emits fresh.
  const volatileSet = new Set<string>(extraSeeds ?? []);
  for (const [, node] of nodeMap) {
    const t = node.data.nodeType;
    if (t === 'forEachInArray' || t === 'forEachBond' || t === 'loop' || t === 'getVariable') volatileSet.add(node.id);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [, node] of nodeMap) {
      if (volatileSet.has(node.id)) continue;
      for (const [key, srcs] of inputToSources) {
        if (!key.startsWith(`${node.id}:`)) continue;
        if (srcs.some(s => volatileSet.has(s.nodeId))) { volatileSet.add(node.id); changed = true; break; }
      }
      if (changed) continue;
      for (const [key, src] of inputToSource) {
        if (!key.startsWith(`${node.id}:`)) continue;
        if (volatileSet.has(src.nodeId)) { volatileSet.add(node.id); changed = true; break; }
      }
    }
  }
  ctx.volatileNodes = volatileSet;
}

/** Value node types that must NOT be hoisted to cell-top (RNG side effect, mutable
 *  storage reads, per-iteration refs, array producers + their reducers). Everything
 *  else (incl. the field reads sampleField/fieldGradient/readCellsUnder, matching
 *  the JS sink-hoist) is hoistable. */
const AGENT_VALUE_NO_HOIST: ReadonlySet<string> = new Set<string>([
  'getRandom', 'getVariable', 'getAgentAttribute', 'getIndicator',
  'forEachInArray', 'forEachBond', 'loop',
  'getNearbyAgents', 'getAgentsInView', 'getAgentsAttribute', 'filterAgents', 'joinAgents',
  'pickNRandomAgents', 'pickRandomAgent', 'getBondedAgents',
  'aggregate', 'groupOperator', 'groupCounting', 'groupStatement',
  'arrayElement', 'arrayLength',
]);

/** Pre-emit the PURE, non-volatile value cone of the behaviour flow tree at the
 *  AGENT-LOOP-TOP (so a value that reads mutable field/attr storage is captured
 *  BEFORE any in-body write mutates it — matching JS's sink-hoist of pure values,
 *  the field-bridge "sample before deposit" semantics). Caches each value in
 *  `valueCache`; the flow chain then reads the cached value. Cycle-guarded. */
function preEmitAgentValues(ctx: AgentWasmCtx, rootId: string): void {
  const { nodeMap, inputToSource, inputToSources, flowOutputToTargets } = ctx.adj;
  const usedOutPorts = new Map<string, Set<string>>();
  const addOut = (nodeId: string, portId: string) => { let s = usedOutPorts.get(nodeId); if (!s) { s = new Set(); usedOutPorts.set(nodeId, s); } s.add(portId); };
  for (const [, src] of inputToSource) addOut(src.nodeId, src.portId);
  for (const [, srcs] of inputToSources) for (const s of srcs) addOut(s.nodeId, s.portId);
  const hoistable = new Map<string, boolean>();
  const inProgress = new Set<string>();
  const isHoistable = (id: string): boolean => {
    const cached = hoistable.get(id); if (cached !== undefined) return cached;
    if (inProgress.has(id)) return false;
    const node = nodeMap.get(id); if (!node) return false;
    if (AGENT_VALUE_NO_HOIST.has(node.data.nodeType)) { hoistable.set(id, false); return false; }
    if (ctx.volatileNodes.has(id)) { hoistable.set(id, false); return false; }
    // Hazard-pinned reads emit at their LCA flow position, never at loop-top.
    if (ctx.hazardPinned.has(id)) { hoistable.set(id, false); return false; }
    inProgress.add(id);
    let ok = true;
    for (const [key, src] of inputToSource) { if (!key.startsWith(`${id}:`)) continue; if (!isHoistable(src.nodeId)) { ok = false; break; } }
    if (ok) for (const [key, srcs] of inputToSources) { if (!key.startsWith(`${id}:`)) continue; for (const s of srcs) if (!isHoistable(s.nodeId)) { ok = false; break; } if (!ok) break; }
    inProgress.delete(id);
    hoistable.set(id, ok); return ok;
  };
  const emitConeVisited = new Set<string>();
  const emitCone = (nodeId: string) => {
    if (emitConeVisited.has(nodeId)) return;
    emitConeVisited.add(nodeId);
    const node = nodeMap.get(nodeId); if (!node) return;
    if (isHoistable(nodeId)) {
      const ports = usedOutPorts.get(nodeId);
      if (ports && ports.size > 0) for (const p of ports) compileValueNode(ctx, nodeId, p);
      else compileValueNode(ctx, nodeId, 'value');
    }
    if (node.data.nodeType === 'forEachInArray' || node.data.nodeType === 'forEachBond') return;
    for (const [key, src] of inputToSource) { if (!key.startsWith(`${nodeId}:`)) continue; emitCone(src.nodeId); }
    for (const [key, srcs] of inputToSources) { if (!key.startsWith(`${nodeId}:`)) continue; for (const s of srcs) emitCone(s.nodeId); }
  };
  const visited = new Set<string>();
  const walk = (nodeId: string) => {
    if (visited.has(nodeId)) return; visited.add(nodeId);
    const node = nodeMap.get(nodeId); if (!node) return;
    for (const [key, src] of inputToSource) { if (!key.startsWith(`${nodeId}:`)) continue; emitCone(src.nodeId); }
    for (const [key, srcs] of inputToSources) { if (!key.startsWith(`${nodeId}:`)) continue; for (const s of srcs) emitCone(s.nodeId); }
    const skipPort = (node.data.nodeType === 'forEachInArray' || node.data.nodeType === 'forEachBond') ? 'body' : null;
    for (const [key, targets] of flowOutputToTargets) {
      if (!key.startsWith(`${nodeId}:`)) continue;
      const port = key.slice(nodeId.length + 1);
      if (skipPort && port === skipPort) continue;
      for (const t of targets) walk(t.nodeId);
    }
  };
  walk(rootId);
}

// ===========================================================================
// W1 — the WASM FORCE PASS (the boost lever).
//
// The agent force integrator — the engine code that, today, runs in JS even on
// the WASM agent target. It is the HOTTEST per-step code (the per-neighbour-pair
// double loop), so porting it to WASM is the cap on the WASM agent speedup.
//
// This emits a SECOND export `forcePass` in the SAME agent module, reading/writing
// the wasmBacked AgentStore at the `computeAgentMemoryLayout` baked offsets — the
// SAME memory the JS engine reads (zero glue; the JS typed arrays are views over
// it). It runs RIGHT AFTER the behaviour (same step), reusing the in-memory hash
// the worker already copied in for `getNearbyAgents` (no extra copy).
//
// It is a faithful byte-for-byte port of `runAgentStep`'s force loop
// (sim.worker.ts) — the 3×3(×3) neighbour stencil (soft-sphere repulsion/adhesion
// + density) → bond springs → velocity integration (momentum, maxSpeed, drag, dt)
// → xNext/yNext[/zNext] → growth ramp. f64 throughout, so JS↔WASM is bit-exact.
//
// The structural phase + the hash build STAY in JS (run once per step, not per
// neighbour-pair). The position double-buffer swap stays in `swapPositions`
// (a copy-into under wasmBacked views, B10).
//
// MIRRORED SCALAR-CONFIG ABI (the worker MIRRORS this in runAgentStep — see
// buildForcePassArgs there; the param↔arg pair is the silent-desync class):
//   (highWater, hashValid, nBinsX, nBinsY, nBinsZ : i32,
//    binSizeX, binSizeY, binSizeZ : f64,
//    dtOverEta, muR, muA, range, momentum, maxSpeed, growthRate : f64,
//    W, H, D : f64, bonding, torus : i32, originX, originY, originZ : f64,
//    doCollision, doSprings : i32)
// `dtOverEta = dt / eta` is passed PRECOMPUTED (one division, bit-identical to JS's
// per-iteration `(dt / eta)` since the operands are step-constant). The engine
// physics is DECOUPLED into per-capability gates (v2 — the Agent Capability
// Profiles): `bonding` (usesBondingPhysics) gates ONLY the ADHESION half of the
// soft-sphere (d>=sij cohesion); `doCollision` (the Collision capability) gates the
// REPULSION half (d<sij volume exclusion); `doSprings` (the Bonds=Physics
// capability) gates the bond springs; growth rides the `growthRate` arg (the worker
// zeroes it when the Growth capability is off). So a pure gas (Collision on,
// bonding/springs off) collides without cohesion/springs. Soft-sphere runs when
// `bonding || doCollision`; muRep=doCollision?muR:0 / muAdh=bonding?muA:0. Legacy
// profileless files fall back to `usesBondingPhysics` for all three ⇒ byte-identical.
// ===========================================================================

/** The force-pass params (the worker mirrors this order exactly). */
const FORCE_PASS_PARAMS: ('i32' | 'f64')[] = [
  'i32', 'i32', 'i32', 'i32', 'i32',     // highWater, hashValid, nBinsX, nBinsY, nBinsZ
  'f64', 'f64', 'f64',                   // binSizeX, binSizeY, binSizeZ
  'f64', 'f64', 'f64', 'f64', 'f64', 'f64', 'f64', // dtOverEta, muR, muA, range, momentum, maxSpeed, growthRate
  'f64', 'f64', 'f64',                   // W, H, D
  'i32', 'i32',                          // bonding, torus
  'f64', 'f64', 'f64',                   // originX, originY, originZ (the bbox-anchored hash grid origin)
  'i32',                                 // doCollision (soft-sphere repulsion — the Collision capability, independent of bonding physics)
  'i32',                                 // doSprings (bond springs — the Bonds=Physics capability, independent of bonding physics)
  'i32',                                 // doDensity (P1: run the neighbour/density scan even with forces off — a density consumer exists)
];

interface ForcePassParamIdx {
  highWater: number; hashValid: number; nBinsX: number; nBinsY: number; nBinsZ: number;
  binSizeX: number; binSizeY: number; binSizeZ: number;
  dtOverEta: number; muR: number; muA: number; range: number;
  momentum: number; maxSpeed: number; growthRate: number;
  W: number; H: number; D: number;
  bonding: number; torus: number;
  originX: number; originY: number; originZ: number;
  doCollision: number;
  doSprings: number;
  doDensity: number;
}

/** Emit the force-pass function body onto `em`. Reads the wasmBacked AgentStore at
 *  `layout` offsets; `is3d` selects the 3-axis branch (2D is the verbatim 2D fast
 *  path — a separate code path, NOT a branchless always-0-dz body, mirroring the
 *  JS loop's `if (is3d)` split so the 2D arithmetic + stencil count are identical).
 *  `fmodFuncIdx` is the host `env.fmod = (a,b)=>a%b` import — used for the torus
 *  position wrap so it is BIT-EXACT to JS's native `%` (WASM has no f64 rem opcode;
 *  reconstructing `a - trunc(a/b)*b` rounds twice and would drift). */
function emitForcePass(em: WasmEmitter, layout: AgentMemoryLayout, is3d: boolean, P: ForcePassParamIdx, fmodFuncIdx: number): void {
  const L = layout;
  const aliveOff = L.u8['alive']!;
  // half-spans: halfW = W / 2 (mirrors JS `W / 2` exactly).
  const halfW = em.allocLocal(F64); em.localGet(P.W); em.f64Const(2); em.op(OP_F64_DIV); em.localSet(halfW);
  const halfH = em.allocLocal(F64); em.localGet(P.H); em.f64Const(2); em.op(OP_F64_DIV); em.localSet(halfH);
  const halfD = em.allocLocal(F64); if (is3d) { em.localGet(P.D); em.f64Const(2); em.op(OP_F64_DIV); em.localSet(halfD); } else { em.f64Const(0); em.localSet(halfD); }

  const i = em.allocLocal(I32);

  // Per-agent scratch locals (reused each iteration).
  const xi = em.allocLocal(F64), yi = em.allocLocal(F64), zi = em.allocLocal(F64), ri = em.allocLocal(F64);
  const fx = em.allocLocal(F64), fy = em.allocLocal(F64), fz = em.allocLocal(F64);
  const dens = em.allocLocal(F64);
  const bx = em.allocLocal(I32), by = em.allocLocal(I32), bz = em.allocLocal(I32);
  const ddx = em.allocLocal(I32), ddy = em.allocLocal(I32), ddz = em.allocLocal(I32);
  const nbx = em.allocLocal(I32), nby = em.allocLocal(I32), nbz = em.allocLocal(I32);
  const bidx = em.allocLocal(I32), pL = em.allocLocal(I32), endL = em.allocLocal(I32), jL = em.allocLocal(I32);
  const dx = em.allocLocal(F64), dy = em.allocLocal(F64), dz = em.allocLocal(F64);
  const d2 = em.allocLocal(F64), sij = em.allocLocal(F64), rmax = em.allocLocal(F64), d = em.allocLocal(F64), Fl = em.allocLocal(F64), kl = em.allocLocal(F64);
  const bc = em.allocLocal(I32), baseB = em.allocLocal(I32), bk = em.allocLocal(I32), pp = em.allocLocal(I32);
  const vxi = em.allocLocal(F64), vyi = em.allocLocal(F64), vzi = em.allocLocal(F64), sp = em.allocLocal(F64), sc = em.allocLocal(F64);
  const nx = em.allocLocal(F64), ny = em.allocLocal(F64), nz = em.allocLocal(F64);
  const tr = em.allocLocal(F64), cur = em.allocLocal(F64), dd = em.allocLocal(F64), stepRad = em.allocLocal(F64);

  const off = {
    x: L.f64['x']!, y: L.f64['y']!, z: L.f64['z']!,
    xN: L.f64['xNext']!, yN: L.f64['yNext']!, zN: L.f64['zNext']!,
    vx: L.f64['vx']!, vy: L.f64['vy']!, vz: L.f64['vz']!,
    fX: L.f64['forceX']!, fY: L.f64['forceY']!, fZ: L.f64['forceZ']!,
    rad: L.f64['radius']!, tgt: L.f64['targetRadius']!, age: L.f64['age']!, dens: L.f64['density']!,
  };

  // --- the torus fold of a delta `dLocal` against span `spanLocal` + its half
  //     `halfLocal`: if (d > halfSpan) d -= span; else if (d < -halfSpan) d += span.
  const foldDelta = (dLocal: number, spanLocal: number, halfLocal: number) => {
    em.localGet(dLocal); em.localGet(halfLocal); em.op(OP_F64_GT);
    em.ifThenElse(
      () => { em.localGet(dLocal); em.localGet(spanLocal); em.op(OP_F64_SUB); em.localSet(dLocal); },
      () => {
        em.localGet(dLocal); em.localGet(halfLocal); em.op(OP_F64_NEG); em.op(OP_F64_LT);
        em.ifThen(() => { em.localGet(dLocal); em.localGet(spanLocal); em.op(OP_F64_ADD); em.localSet(dLocal); });
      },
    );
  };

  // --- the candidate body for neighbour j held in `jL` (soft-sphere + density). It
  //     computes dx/dy[/dz] (torus-folded), d2, the cutoff, density++, and the
  //     graph-`engineForces`-gated soft-sphere force into fx/fy[/fz]. Mirrors the
  //     JS inner block verbatim. `skipSelf` controls whether to skip j===i (hash:
  //     yes; the JS hash path also skips dead j implicitly via the bin membership,
  //     so no alive check here — bins only hold alive agents; the all-pairs path
  //     adds the alive check before calling this). ---
  const candidate = (skipDead: boolean) => {
    // if (j === i) skip (the hash + all-pairs both skip self)
    em.localGet(jL); em.localGet(i); em.op(OP_I32_NE);
    em.ifThen(() => {
      const run = () => {
        // dx = x[j]-xi; dy = y[j]-yi [; dz = z[j]-zi]
        pushF64Elem(em, off.x, jL); em.localGet(xi); em.op(OP_F64_SUB); em.localSet(dx);
        pushF64Elem(em, off.y, jL); em.localGet(yi); em.op(OP_F64_SUB); em.localSet(dy);
        if (is3d) { pushF64Elem(em, off.z, jL); em.localGet(zi); em.op(OP_F64_SUB); em.localSet(dz); }
        em.localGet(P.torus);
        em.ifThen(() => {
          foldDelta(dx, P.W, halfW);
          foldDelta(dy, P.H, halfH);
          if (is3d) foldDelta(dz, P.D, halfD);
        });
        // d2 = dx*dx + dy*dy [+ dz*dz]
        em.localGet(dx); em.localGet(dx); em.op(OP_F64_MUL);
        em.localGet(dy); em.localGet(dy); em.op(OP_F64_MUL); em.op(OP_F64_ADD);
        if (is3d) { em.localGet(dz); em.localGet(dz); em.op(OP_F64_MUL); em.op(OP_F64_ADD); }
        em.localSet(d2);
        // sij = ri + rad[j]; rmax = range * sij
        em.localGet(ri); pushF64Elem(em, off.rad, jL); em.op(OP_F64_ADD); em.localSet(sij);
        em.localGet(P.range); em.localGet(sij); em.op(OP_F64_MUL); em.localSet(rmax);
        // if (d2 === 0 || d2 >= rmax*rmax) continue; — i.e. only proceed when
        //   d2 !== 0 && d2 < rmax*rmax
        em.localGet(d2); em.f64Const(0); em.op(OP_F64_NE);                  // d2 != 0
        em.localGet(d2); em.localGet(rmax); em.localGet(rmax); em.op(OP_F64_MUL); em.op(OP_F64_LT); // d2 < rmax^2
        em.op(OP_I32_AND);
        em.ifThen(() => {
          // dens++
          em.localGet(dens); em.f64Const(1); em.op(OP_F64_ADD); em.localSet(dens);
          // Soft-sphere runs when EITHER bonding physics OR the Collision
          // capability is on: repulsion (d<sij) IS the volume-exclusion collision,
          // so it's gated on doCollision; adhesion (d>=sij) is cohesion, gated on
          // bonding. doForce = bonding || doCollision. Mirrors the JS force pass.
          //   if (doForce) { d = sqrt(d2); F = ((d<sij)?muRep:muAdh)*(d-sij); k=F/d; fx+=k*dx; ... }
          //   muRep = doCollision ? muR : 0 ;  muAdh = bonding ? muA : 0
          em.localGet(P.bonding); em.localGet(P.doCollision); em.op(OP_I32_OR);
          em.ifThen(() => {
            em.localGet(d2); em.op(OP_F64_SQRT); em.localSet(d);
            // F = ((d < sij) ? muRep : muAdh) * (d - sij)
            em.localGet(d); em.localGet(sij); em.op(OP_F64_LT);
            em.ifThenElse(
              // muRep = doCollision ? muR : 0
              () => { em.localGet(P.muR); em.f64Const(0); em.localGet(P.doCollision); em.op(OP_SELECT); em.localSet(Fl); },
              // muAdh = bonding ? muA : 0
              () => { em.localGet(P.muA); em.f64Const(0); em.localGet(P.bonding); em.op(OP_SELECT); em.localSet(Fl); },
            );
            em.localGet(Fl); em.localGet(d); em.localGet(sij); em.op(OP_F64_SUB); em.op(OP_F64_MUL); em.localSet(Fl);
            // k = F / d
            em.localGet(Fl); em.localGet(d); em.op(OP_F64_DIV); em.localSet(kl);
            // fx += k*dx; fy += k*dy [; fz += k*dz]
            em.localGet(fx); em.localGet(kl); em.localGet(dx); em.op(OP_F64_MUL); em.op(OP_F64_ADD); em.localSet(fx);
            em.localGet(fy); em.localGet(kl); em.localGet(dy); em.op(OP_F64_MUL); em.op(OP_F64_ADD); em.localSet(fy);
            if (is3d) { em.localGet(fz); em.localGet(kl); em.localGet(dz); em.op(OP_F64_MUL); em.op(OP_F64_ADD); em.localSet(fz); }
          });
        });
      };
      if (skipDead) {
        // all-pairs path: if (!alive[j]) skip
        em.localGet(jL); em.i32Const(aliveOff); em.op(OP_I32_ADD); em.i32Load8U();
        em.ifThen(run);
      } else {
        run();
      }
    });
  };

  // --- a 1-D wrap/range helper for a neighbour-bin coordinate already in `nbLocal`:
  //     torus → ((nb % n) + n) % n; else range-check sets a `skip` flag.            ---
  const wrapBin = (nbLocal: number, nLocal: number, skipLocal: number) => {
    em.localGet(P.torus);
    em.ifThenElse(
      () => { wrapMod(em, nbLocal, nLocal); },
      () => { rangeBad(em, nbLocal, nLocal, skipLocal); },
    );
  };

  // --- store-address helper: push (regionOffset + i*8) as the f64 store address. ---
  const addr = (regionOffset: number, idxLocal: number) => pushF64ElemAddr(em, regionOffset, idxLocal);

  // ===== the per-agent loop =====
  em.i32Const(0); em.localSet(i);
  em.block(() => {
    em.loop(() => {
      em.localGet(i); em.localGet(P.highWater); em.op(OP_I32_GE_S); em.brIf(1);
      // if (alive[i]) { <body> } else { xN[i]=x[i]; yN[i]=y[i]; [zN[i]=z[i];] }
      em.i32Const(aliveOff); em.localGet(i); em.op(OP_I32_ADD); em.i32Load8U();
      em.ifThenElse(
        () => emitForceBody(),
        () => {
          // dead: copy current position into the next buffer (so swapPositions keeps it)
          addr(off.xN, i); pushF64Elem(em, off.x, i); em.f64Store();
          addr(off.yN, i); pushF64Elem(em, off.y, i); em.f64Store();
          if (is3d) { addr(off.zN, i); pushF64Elem(em, off.z, i); em.f64Store(); }
        },
      );
      em.localGet(i); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(i);
      em.br(0);
    });
  });

  // --- the live-agent force body (factored so the loop stays readable) ---
  function emitForceBody(): void {
    // xi=x[i]; yi=y[i]; [zi=z[i];] ri=rad[i]
    pushF64Elem(em, off.x, i); em.localSet(xi);
    pushF64Elem(em, off.y, i); em.localSet(yi);
    if (is3d) { pushF64Elem(em, off.z, i); em.localSet(zi); }
    pushF64Elem(em, off.rad, i); em.localSet(ri);
    // fx=forceX[i]; fy=forceY[i]; [fz=forceZ[i];] dens=0
    pushF64Elem(em, off.fX, i); em.localSet(fx);
    pushF64Elem(em, off.fY, i); em.localSet(fy);
    if (is3d) { pushF64Elem(em, off.fZ, i); em.localSet(fz); }
    em.f64Const(0); em.localSet(dens);

    // --- neighbour pass: hash stencil when hashValid, else all-pairs. P1 (the
    //     dead density scan): the pass exists to (a) apply the soft-sphere force
    //     and (b) count density — when NEITHER is needed (engine physics off AND
    //     no density consumer) skip the WHOLE scan + the density store (it was
    //     ~70% of a custom-force model's force-pass cost; density then keeps its
    //     last value, which nothing observes). Mirrors the JS/WGSL gates. ---
    em.localGet(P.bonding); em.localGet(P.doCollision); em.op(OP_I32_OR);
    em.localGet(P.doDensity); em.op(OP_I32_OR);
    em.ifThen(() => {
      em.localGet(P.hashValid);
      em.ifThenElse(
        () => emitForceStencil(),
        () => {
          // all-pairs: for (j=0; j<highWater; j++) candidate(skipDead=true)
          em.i32Const(0); em.localSet(jL);
          em.block(() => {
            em.loop(() => {
              em.localGet(jL); em.localGet(P.highWater); em.op(OP_I32_GE_S); em.brIf(1);
              candidate(true);
              em.localGet(jL); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(jL);
              em.br(0);
            });
          });
        },
      );
      // density[i] = dens
      addr(off.dens, i); em.localGet(dens); em.f64Store();
    });

    // --- bond springs (gated on the Bonds=Physics capability && bondCount>0;
    //     Data bonds are force-free edges) ---
    // bc = bondCount[i]
    em.localGet(i); em.i32Const(4); em.op(OP_I32_MUL); em.i32Const(L.i32['bondCount']!); em.op(OP_I32_ADD); em.i32Load(); em.localSet(bc);
    em.localGet(P.doSprings);
    em.localGet(bc); em.i32Const(0); em.op(OP_I32_GT_S);
    em.op(OP_I32_AND);
    em.ifThen(() => emitBondSprings());

    // --- integrate: vxi = momentum*vx[i] + dtOverEta*fx; ... ; maxSpeed cap ---
    em.localGet(P.momentum); pushF64Elem(em, off.vx, i); em.op(OP_F64_MUL); em.localGet(P.dtOverEta); em.localGet(fx); em.op(OP_F64_MUL); em.op(OP_F64_ADD); em.localSet(vxi);
    em.localGet(P.momentum); pushF64Elem(em, off.vy, i); em.op(OP_F64_MUL); em.localGet(P.dtOverEta); em.localGet(fy); em.op(OP_F64_MUL); em.op(OP_F64_ADD); em.localSet(vyi);
    if (is3d) { em.localGet(P.momentum); pushF64Elem(em, off.vz, i); em.op(OP_F64_MUL); em.localGet(P.dtOverEta); em.localGet(fz); em.op(OP_F64_MUL); em.op(OP_F64_ADD); em.localSet(vzi); }
    // if (maxSpeed > 0) { sp = sqrt(v·v); if (sp > maxSpeed) { sc = maxSpeed/sp; v *= sc } }
    em.localGet(P.maxSpeed); em.f64Const(0); em.op(OP_F64_GT);
    em.ifThen(() => {
      em.localGet(vxi); em.localGet(vxi); em.op(OP_F64_MUL);
      em.localGet(vyi); em.localGet(vyi); em.op(OP_F64_MUL); em.op(OP_F64_ADD);
      if (is3d) { em.localGet(vzi); em.localGet(vzi); em.op(OP_F64_MUL); em.op(OP_F64_ADD); }
      em.op(OP_F64_SQRT); em.localSet(sp);
      em.localGet(sp); em.localGet(P.maxSpeed); em.op(OP_F64_GT);
      em.ifThen(() => {
        em.localGet(P.maxSpeed); em.localGet(sp); em.op(OP_F64_DIV); em.localSet(sc);
        em.localGet(vxi); em.localGet(sc); em.op(OP_F64_MUL); em.localSet(vxi);
        em.localGet(vyi); em.localGet(sc); em.op(OP_F64_MUL); em.localSet(vyi);
        if (is3d) { em.localGet(vzi); em.localGet(sc); em.op(OP_F64_MUL); em.localSet(vzi); }
      });
    });
    // vx[i]=vxi; ...
    addr(off.vx, i); em.localGet(vxi); em.f64Store();
    addr(off.vy, i); em.localGet(vyi); em.f64Store();
    if (is3d) { addr(off.vz, i); em.localGet(vzi); em.f64Store(); }

    // nx = xi + vxi; ny = yi + vyi; [nz = zi + vzi;]
    em.localGet(xi); em.localGet(vxi); em.op(OP_F64_ADD); em.localSet(nx);
    em.localGet(yi); em.localGet(vyi); em.op(OP_F64_ADD); em.localSet(ny);
    if (is3d) { em.localGet(zi); em.localGet(vzi); em.op(OP_F64_ADD); em.localSet(nz); }
    // torus wrap or clamp
    em.localGet(P.torus);
    em.ifThenElse(
      () => {
        wrapPos(nx, P.W);
        wrapPos(ny, P.H);
        if (is3d) wrapPos(nz, P.D);
      },
      () => {
        clampPos(nx, P.W);
        clampPos(ny, P.H);
        if (is3d) clampPos(nz, P.D);
      },
    );
    // xN[i]=nx; yN[i]=ny; [zN[i]=nz;]
    addr(off.xN, i); em.localGet(nx); em.f64Store();
    addr(off.yN, i); em.localGet(ny); em.f64Store();
    if (is3d) { addr(off.zN, i); em.localGet(nz); em.f64Store(); }

    // age[i] = age[i] + 1
    addr(off.age, i); pushF64Elem(em, off.age, i); em.f64Const(1); em.op(OP_F64_ADD); em.f64Store();

    // growth: tr=targetRadius[i]; cur=radius[i]; if (tr !== cur) { dd=tr-cur;
    //   radius[i] = abs(dd)<=growthRate ? tr : cur + sign(dd)*growthRate }
    pushF64Elem(em, off.tgt, i); em.localSet(tr);
    pushF64Elem(em, off.rad, i); em.localSet(cur);
    em.localGet(tr); em.localGet(cur); em.op(OP_F64_NE);
    em.ifThen(() => {
      em.localGet(tr); em.localGet(cur); em.op(OP_F64_SUB); em.localSet(dd);
      // stepRad = abs(dd) <= growthRate ? tr : cur + sign(dd)*growthRate
      em.localGet(dd); em.op(OP_F64_ABS); em.localGet(P.growthRate); em.op(OP_F64_LE);
      em.ifThenElse(
        () => { em.localGet(tr); em.localSet(stepRad); },
        () => {
          // sign(dd) — dd != 0 here, so dd>0 ? +growthRate : -growthRate
          em.localGet(dd); em.f64Const(0); em.op(OP_F64_GT);
          em.ifThenElse(
            () => { em.localGet(cur); em.localGet(P.growthRate); em.op(OP_F64_ADD); em.localSet(stepRad); },
            () => { em.localGet(cur); em.localGet(P.growthRate); em.op(OP_F64_SUB); em.localSet(stepRad); },
          );
        },
      );
      addr(off.rad, i); em.localGet(stepRad); em.f64Store();
    });
  }

  // --- the 3×3(×3) hash stencil over the in-memory binStart/binAgents ---
  function emitForceStencil(): void {
    const binStartOff = L.hashBinStartOffset, binAgentsOff = L.hashBinAgentsOffset;
    // bx = clamp(((xi-originX)/binSizeX)|0, 0, nBinsX-1); same by[,bz]
    clampToBin(xi, P.originX, P.binSizeX, P.nBinsX, bx);
    clampToBin(yi, P.originY, P.binSizeY, P.nBinsY, by);
    if (is3d) clampToBin(zi, P.originZ, P.binSizeZ, P.nBinsZ, bz); else { em.i32Const(0); em.localSet(bz); }

    const innerBin = () => {
      // nbx = bx+ddx; nby = by+ddy; [nbz = bz+ddz]
      em.localGet(bx); em.localGet(ddx); em.op(OP_I32_ADD); em.localSet(nbx);
      em.localGet(by); em.localGet(ddy); em.op(OP_I32_ADD); em.localSet(nby);
      if (is3d) { em.localGet(bz); em.localGet(ddz); em.op(OP_I32_ADD); em.localSet(nbz); }
      const skipL = em.allocLocal(I32); em.i32Const(0); em.localSet(skipL);
      wrapBin(nbx, P.nBinsX, skipL);
      wrapBin(nby, P.nBinsY, skipL);
      if (is3d) wrapBin(nbz, P.nBinsZ, skipL);
      em.localGet(skipL); em.op(OP_I32_EQZ);
      em.ifThen(() => {
        // b = is3d ? (nbz*nBinsY + nby)*nBinsX + nbx : nby*nBinsX + nbx
        if (is3d) {
          em.localGet(nbz); em.localGet(P.nBinsY); em.op(OP_I32_MUL); em.localGet(nby); em.op(OP_I32_ADD);
          em.localGet(P.nBinsX); em.op(OP_I32_MUL); em.localGet(nbx); em.op(OP_I32_ADD); em.localSet(bidx);
        } else {
          em.localGet(nby); em.localGet(P.nBinsX); em.op(OP_I32_MUL); em.localGet(nbx); em.op(OP_I32_ADD); em.localSet(bidx);
        }
        // p = binStart[b]; end = binStart[b+1]
        em.localGet(bidx); em.i32Const(4); em.op(OP_I32_MUL); em.i32Const(binStartOff); em.op(OP_I32_ADD); em.i32Load(); em.localSet(pL);
        em.localGet(bidx); em.i32Const(1); em.op(OP_I32_ADD); em.i32Const(4); em.op(OP_I32_MUL); em.i32Const(binStartOff); em.op(OP_I32_ADD); em.i32Load(); em.localSet(endL);
        em.block(() => {
          em.loop(() => {
            em.localGet(pL); em.localGet(endL); em.op(OP_I32_GE_S); em.brIf(1);
            // j = binAgents[p]
            em.localGet(pL); em.i32Const(4); em.op(OP_I32_MUL); em.i32Const(binAgentsOff); em.op(OP_I32_ADD); em.i32Load(); em.localSet(jL);
            candidate(false);
            em.localGet(pL); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(pL);
            em.br(0);
          });
        });
      });
    };

    // for (ddz in [-1,1]) for (ddy) for (ddx) innerBin    (ddz fixed 0 in 2D)
    const ddLoop = (varL: number, body: () => void) => {
      em.i32Const(-1); em.localSet(varL);
      em.block(() => {
        em.loop(() => {
          em.localGet(varL); em.i32Const(1); em.op(OP_I32_GT_S); em.brIf(1);
          body();
          em.localGet(varL); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(varL);
          em.br(0);
        });
      });
    };
    if (is3d) ddLoop(ddz, () => ddLoop(ddy, () => ddLoop(ddx, innerBin)));
    else { em.i32Const(0); em.localSet(ddz); ddLoop(ddy, () => ddLoop(ddx, innerBin)); }
  }

  // bIdx-out: store clamp((coord/size)|0, 0, n-1) into outLocal.
  function clampToBin(coordL: number, originL: number, sizeL: number, nL: number, outLocal: number): void {
    em.localGet(coordL); em.localGet(originL); em.op(OP_F64_SUB); em.localGet(sizeL); em.op(OP_F64_DIV); em.f64ToI32(); em.localSet(outLocal);
    em.localGet(outLocal); em.i32Const(0); em.op(OP_I32_LT_S);
    em.ifThenElse(
      () => { em.i32Const(0); em.localSet(outLocal); },
      () => {
        em.localGet(outLocal); em.localGet(nL); em.op(OP_I32_GE_S);
        em.ifThen(() => { em.localGet(nL); em.i32Const(1); em.op(OP_I32_SUB); em.localSet(outLocal); });
      },
    );
  }

  // --- bond springs over the agent's bond list (mirrors the JS bond block) ---
  function emitBondSprings(): void {
    // base = i * maxBonds
    em.localGet(i); em.i32Const(L.maxBonds); em.op(OP_I32_MUL); em.localSet(baseB);
    const bpOff = L.bondI32['bondPartner']!, bpeOff = L.bondI32['bondPartnerEpoch']!;
    const brlOff = L.bondF64['bondRestLength']!, bstOff = L.bondF64['bondStiffness']!;
    const epochOff = L.i32['epoch']!;
    em.i32Const(0); em.localSet(bk);
    em.block(() => {
      em.loop(() => {
        em.localGet(bk); em.localGet(bc); em.op(OP_I32_GE_S); em.brIf(1);
        // p = bondPartner[base+bk]
        em.localGet(baseB); em.localGet(bk); em.op(OP_I32_ADD); em.i32Const(4); em.op(OP_I32_MUL); em.i32Const(bpOff); em.op(OP_I32_ADD); em.i32Load(); em.localSet(pp);
        // if (p >= 0 && p < highWater && alive[p]) { ... }  (else: just skip → bk++)
        em.localGet(pp); em.i32Const(0); em.op(OP_I32_GE_S);
        em.localGet(pp); em.localGet(P.highWater); em.op(OP_I32_LT_S); em.op(OP_I32_AND);
        em.ifThen(() => {
          em.localGet(pp); em.i32Const(aliveOff); em.op(OP_I32_ADD); em.i32Load8U();
          em.ifThen(() => {
            // if (bondPartnerEpoch[base+bk] === epoch[p]) { ... }
            em.localGet(baseB); em.localGet(bk); em.op(OP_I32_ADD); em.i32Const(4); em.op(OP_I32_MUL); em.i32Const(bpeOff); em.op(OP_I32_ADD); em.i32Load();
            em.localGet(pp); em.i32Const(4); em.op(OP_I32_MUL); em.i32Const(epochOff); em.op(OP_I32_ADD); em.i32Load();
            em.op(OP_I32_EQ); // (need OP_I32_EQ)
            em.ifThen(() => {
              // dx=x[p]-xi; dy=y[p]-yi; [dz=z[p]-zi]
              pushF64Elem(em, off.x, pp); em.localGet(xi); em.op(OP_F64_SUB); em.localSet(dx);
              pushF64Elem(em, off.y, pp); em.localGet(yi); em.op(OP_F64_SUB); em.localSet(dy);
              if (is3d) { pushF64Elem(em, off.z, pp); em.localGet(zi); em.op(OP_F64_SUB); em.localSet(dz); }
              em.localGet(P.torus);
              em.ifThen(() => { foldDelta(dx, P.W, halfW); foldDelta(dy, P.H, halfH); if (is3d) foldDelta(dz, P.D, halfD); });
              // d2b = dx*dx + dy*dy [+ dz*dz]; if (d2b === 0) skip
              em.localGet(dx); em.localGet(dx); em.op(OP_F64_MUL);
              em.localGet(dy); em.localGet(dy); em.op(OP_F64_MUL); em.op(OP_F64_ADD);
              if (is3d) { em.localGet(dz); em.localGet(dz); em.op(OP_F64_MUL); em.op(OP_F64_ADD); }
              em.localSet(d2);
              em.localGet(d2); em.f64Const(0); em.op(OP_F64_NE);
              em.ifThen(() => {
                em.localGet(d2); em.op(OP_F64_SQRT); em.localSet(d);
                // F = bondStiffness[base+bk] * (d - bondRestLength[base+bk])
                em.localGet(baseB); em.localGet(bk); em.op(OP_I32_ADD); em.i32Const(8); em.op(OP_I32_MUL); em.i32Const(bstOff); em.op(OP_I32_ADD); em.f64Load();
                em.localGet(d);
                em.localGet(baseB); em.localGet(bk); em.op(OP_I32_ADD); em.i32Const(8); em.op(OP_I32_MUL); em.i32Const(brlOff); em.op(OP_I32_ADD); em.f64Load();
                em.op(OP_F64_SUB);
                em.op(OP_F64_MUL); em.localSet(Fl);
                // k = F / d; fx += k*dx; ...
                em.localGet(Fl); em.localGet(d); em.op(OP_F64_DIV); em.localSet(kl);
                em.localGet(fx); em.localGet(kl); em.localGet(dx); em.op(OP_F64_MUL); em.op(OP_F64_ADD); em.localSet(fx);
                em.localGet(fy); em.localGet(kl); em.localGet(dy); em.op(OP_F64_MUL); em.op(OP_F64_ADD); em.localSet(fy);
                if (is3d) { em.localGet(fz); em.localGet(kl); em.localGet(dz); em.op(OP_F64_MUL); em.op(OP_F64_ADD); em.localSet(fz); }
              });
            });
          });
        });
        em.localGet(bk); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(bk);
        em.br(0);
      });
    });
  }

  // wrap a position local into [0, span): nx = ((nx % W) + W) % W — JS native `%`
  // (exact fmod), reproduced via the host `env.fmod` import so it is BIT-EXACT.
  //
  // NB: a "skip the wrap when n ∈ [0, span)" fast path is NOT bit-exact — for a
  // non-power-of-2 span, JS's `(n + W)` rounds, so `((n % W) + W) % W` does NOT
  // equal `n` in the low bits even for an in-range n. The unconditional host-fmod
  // is the only path that matches JS exactly (verified: the fast path diverged at
  // ~1e-12). WASM has no f64 rem opcode; an inline musl-style i64 fmod would avoid
  // the host call but needs ~15 new i64 encoder ops — deferred (the wrap is once
  // per agent, not per neighbour pair, so its cost is secondary).
  function wrapPos(nLocal: number, spanLocal: number): void {
    fmod(nLocal, spanLocal);                 // n = n % span
    em.localGet(nLocal); em.localGet(spanLocal); em.op(OP_F64_ADD); em.localSet(nLocal); // n += span
    fmod(nLocal, spanLocal);                 // n = n % span
  }
  // n = n % span  (JS `%` — exact fmod via the host import; WASM has no f64 rem).
  function fmod(nLocal: number, spanLocal: number): void {
    em.localGet(nLocal); em.localGet(spanLocal); em.emit(opCall(fmodFuncIdx));
    em.localSet(nLocal);
  }
  // clamp a position local into [0, span]: n = n<0?0 : n>span?span : n
  function clampPos(nLocal: number, spanLocal: number): void {
    em.localGet(nLocal); em.f64Const(0); em.op(OP_F64_LT);
    em.ifThenElse(
      () => { em.f64Const(0); em.localSet(nLocal); },
      () => {
        em.localGet(nLocal); em.localGet(spanLocal); em.op(OP_F64_GT);
        em.ifThen(() => { em.localGet(spanLocal); em.localSet(nLocal); });
      },
    );
  }
}

// ---------------------------------------------------------------------------
// The gate + the top-level compile.
// ---------------------------------------------------------------------------

function flattenAgentGraph(nodes: GraphNode[], edges: GraphEdge[], model: CAModel):
  { nodes: GraphNode[]; edges: GraphEdge[]; model: CAModel; error?: string } {
  const expanded = expandMacros(nodes, edges, model);
  if (expanded.error) return { nodes, edges, model, error: expanded.error };
  let n = expanded.nodes, e = expanded.edges;
  ({ nodes: n, edges: e } = collapseReroutes(n, e));
  // Apply Force To Agents (array broadcast) → For Each In Array → Apply Force To
  // Agent (both already supported), so the gate + emitter never see the array node.
  ({ nodes: n, edges: e } = expandForceToAgents(n, e, model));
  // Multi-attribute slot expansion — multi-slot Get/Set Attribute nodes become the
  // single-slot primitives the gate + emitter already handle. See multiAttrExpand.ts.
  ({ nodes: n, edges: e } = expandMultiAttrs(n, e, model));
  // FOV `facing` heading source → Get Self Attribute [vector] → Break Vector → wired
  // heading (BEFORE vector lowering). No-op unless a facing FOV node is used.
  ({ nodes: n, edges: e } = lowerFacingSource(n, e, model));
  // Vector stored-attribute lowering — Get/Set Vector nodes → Make/Break Vector over
  // per-component scalar reads/writes + reassign `model` to the component-expanded
  // agent attrs/variables (matching the layout, which expands identically). BEFORE
  // expandComposites so the synthesized Make/Break Vector lower. See vectorAttr.ts.
  ({ nodes: n, edges: e, model } = lowerVectorAttrs(n, e, model));
  // Composite-type lowering — vector / colour nodes become scalar nodes BEFORE
  // the gate + emitter see the graph, so a vector agent model runs on WASM (the
  // lowered arithmeticOperator/getConstant nodes are in the agent allowlist).
  ({ nodes: n, edges: e } = expandComposites(n, e, model));
  e = canonicalizeAccessorEdges(n, e, model);
  return { nodes: n, edges: e, model };
}

/** The set of node ids reachable from the behaviourStep root (its `do` flow chain
 *  + the transitive value cone of every reached node). The gate + the compiler
 *  check ONLY these — the divisionEvent / agentInit roots run on JS-on-CPU. */
function behaviourReachableNodeIds(behaviourNode: GraphNode, adj: Adjacency): Set<string> {
  const reachable = new Set<string>();
  const visitValue = (nodeId: string): void => {
    if (reachable.has(nodeId)) return;
    reachable.add(nodeId);
    // walk all value inputs (static + dynamic) of this node
    for (const [key, sources] of adj.inputToSources) {
      if (!key.startsWith(`${nodeId}:`)) continue;
      for (const s of sources) visitValue(s.nodeId);
    }
  };
  const visitFlow = (nodeId: string): void => {
    if (reachable.has(nodeId)) {
      // a node may be reached as flow AND value; still walk its flow outputs once.
    }
    reachable.add(nodeId);
    // value inputs
    for (const [key, sources] of adj.inputToSources) {
      if (!key.startsWith(`${nodeId}:`)) continue;
      for (const s of sources) visitValue(s.nodeId);
    }
    // flow outputs
    for (const [key, targets] of adj.flowOutputToTargets) {
      if (!key.startsWith(`${nodeId}:`)) continue;
      for (const t of targets) if (!reachable.has(t.nodeId)) visitFlow(t.nodeId);
    }
  };
  reachable.add(behaviourNode.id);
  for (const [key, targets] of adj.flowOutputToTargets) {
    if (!key.startsWith(`${behaviourNode.id}:`)) continue;
    for (const t of targets) visitFlow(t.nodeId);
  }
  return reachable;
}

/** TRUE iff the model has Agents enabled AND every BEHAVIOUR-reachable node is in
 *  the supported set (or a CPU-root type for the divisionEvent/agentInit subtrees,
 *  which never appear in the behaviour-reachable set). FULL coverage: the reject
 *  set is empty — only the per-node array-scratch-slot budget (a structural gate,
 *  not a node ban) can clamp to JS. */
export function isAgentGraphWasmSupported(model: CAModel | undefined | null): boolean {
  if (!model || !model.topologyMode?.agents) return false;
  const nodes = model.agentGraphNodes ?? [];
  const edges = model.agentGraphEdges ?? [];
  const behaviour = nodes.find(n => n.data.nodeType === 'behaviourStep');
  if (!behaviour) return false;
  const flat = flattenAgentGraph(nodes, edges, model);
  if (flat.error) return false;
  const adj = buildAdjacency(flat.nodes, flat.edges);
  const behaviourNode = flat.nodes.find(n => n.data.nodeType === 'behaviourStep');
  if (!behaviourNode) return false;
  const reachable = behaviourReachableNodeIds(behaviourNode, adj);

  // The WASM-agent field bridge (sampleField/fieldGradient/readCellsUnder/
  // affectCellsUnder/secreteToField) is now FULLY 3D: the emitters branch on
  // `ctx.is3d` (trilinear sample/gradient + r-sphere read/affect + 8-cell splat,
  // index `(layer*H+row)*W+col`), matching the JS field nodes. So a 3D-field model
  // runs on WASM — no field-in-3D clamp.

  let nearbyArrayProducers = 0;
  for (const id of reachable) {
    const n = adj.nodeMap.get(id); if (!n) continue;
    const t = n.data.nodeType;
    if (t === 'macroInput' || t === 'macroOutput' || t === 'macro') return false;
    if (!AGENT_WASM_SUPPORTED_TYPES.has(t)) return false;
    if (t === 'getNearbyAgents' || t === 'getAgentsInView') nearbyArrayProducers++;
  }
  // The per-node scratch-slot budget (getNearbyAgents + getAgentsInView share it).
  if (nearbyArrayProducers > AGENT_NEARBY_SCRATCH_SLOTS) return false;
  return true;
}

/** Compile the agent behaviour graph to a self-contained WASM module. Returns
 *  `{ bytes, pages, layout }`. On an unsupported graph it returns an empty result
 *  + an error (the worker keeps the JS path). BEHAVIOUR-ONLY (no division module
 *  yet — PR6b-3). */
export function compileAgentGraphWasm(
  agentNodes: GraphNode[],
  agentEdges: GraphEdge[],
  model: CAModel,
  agentLayout: AgentMemoryLayout,
): AgentWasmResult {
  const empty = (error: string): AgentWasmResult => ({ bytes: new Uint8Array(), pages: agentLayout.pages, layout: agentLayout, supportedTypes: [], viewerGuardIds: [], error });
  if (!model.topologyMode?.agents) return empty('Agents topology not enabled.');

  const flat = flattenAgentGraph(agentNodes, agentEdges, model);
  if (flat.error) return empty(flat.error);
  const nodes = flat.nodes, edges = flat.edges;
  model = flat.model;  // component-expanded (vector agent attrs → scalar floats)

  const behaviourNode = nodes.find(n => n.data.nodeType === 'behaviourStep');
  if (!behaviourNode) return empty('No Behaviour Step node in the agent graph.');

  // Pre-resolve indicator ids → numeric indices over the agent graph (mirrors
  // compileAgentGraph's FIX 2). Without it get/set/update Indicator emit index -1.
  {
    const indicatorIdxMap = new Map((model.indicators || []).map((ind, i) => [ind.id, i] as const));
    for (const n of nodes) {
      const t = n.data.nodeType;
      if (t === 'getIndicator' || t === 'setIndicator' || t === 'updateIndicator') {
        const idx = indicatorIdxMap.get(n.data.config.indicatorId as string);
        n.data.config._indicatorIdx = idx !== undefined ? idx : -1;
      }
    }
  }

  const adj = buildAdjacency(nodes, edges);
  const is3d = is3dModel(model);

  // The behaviour-reachable node set (the behaviourStep.do chain + its value cone).
  // The gate (caller) only checks THESE — the divisionEvent / agentInit roots are
  // compiled separately on JS-on-CPU (target-independent), so a Tissue graph runs
  // on WASM even though its divisionEvent subtree uses CPU-only nodes.
  const reachable = behaviourReachableNodeIds(behaviourNode, adj);

  // Gate (defensive — the caller already checked isAgentGraphWasmSupported).
  const seen = new Set<string>();
  let nearbyCount = 0;
  for (const id of reachable) {
    const n = adj.nodeMap.get(id); if (!n) continue;
    seen.add(n.data.nodeType);
    if (!AGENT_WASM_SUPPORTED_TYPES.has(n.data.nodeType)) return empty(`agentWasm: unsupported node '${n.data.nodeType}' (falls back to JS).`);
    if (n.data.nodeType === 'getNearbyAgents' || n.data.nodeType === 'getAgentsInView') nearbyCount++;
  }
  if (nearbyCount > agentLayout.nearbyScratchSlots) return empty(`agentWasm: too many nearby/FOV gathers (${nearbyCount} > ${agentLayout.nearbyScratchSlots} reserved slots).`);

  // Viewer-guard table: the ordered non-sentinel setCellLooks mappingIds the
  // behaviour references. JS guards each such write with `_isV_` (activeViewer ===
  // mappingId); the WASM behaviour reproduces this via the trailing
  // `activeViewerIdx` i32 param (= the index of the current viewer in THIS list,
  // -1 = none). The `__current__` sentinel stays unconditional on both.
  const viewerGuardIds: string[] = [];
  for (const id of reachable) {
    const n = adj.nodeMap.get(id); if (!n || n.data.nodeType !== 'setCellLooks') continue;
    const mid = (n.data.config?.['mappingId'] as string) || '';
    if (mid && mid !== '__current__' && !viewerGuardIds.includes(mid)) viewerGuardIds.push(mid);
  }

  // Behaviour signature (the worker's call MIRRORS this — see runAgentStep):
  //   (highWater, hashValid, nBinsX, nBinsY, nBinsZ : i32,
  //    binSizeX, binSizeY, binSizeZ : f64,
  //    fieldW, fieldH, fieldD : f64, fieldTorus : i32,
  //    originX, originY, originZ : f64,   — the bbox-anchored hash grid origin
  //    activeViewerIdx : i32)             — index into viewerGuardIds, -1 = none
  const PARAMS: ('i32' | 'f64')[] = ['i32', 'i32', 'i32', 'i32', 'i32', 'f64', 'f64', 'f64', 'f64', 'f64', 'f64', 'i32', 'f64', 'f64', 'f64', 'i32'];
  const em = new WasmEmitter(PARAMS.length);

  // Param indices.
  const P_highWater = 0, P_hashValid = 1, P_nBinsX = 2, P_nBinsY = 3, P_nBinsZ = 4;
  const P_binSizeX = 5, P_binSizeY = 6, P_binSizeZ = 7;
  const P_fieldW = 8, P_fieldH = 9, P_fieldD = 10, P_fieldTorus = 11;
  const P_originX = 12, P_originY = 13, P_originZ = 14;
  const P_activeViewerIdx = 15;

  const ctx: AgentWasmCtx = {
    adj, layout: agentLayout, model, is3d, em,
    rsLocal: -1, idxLocal: -1,
    varLocals: new Map<string, number>(),
    arrayVarLocals: new Map<string, AgentArrayRef>(),
    valueCache: new Map<string, ValueRef>(),
    arrayCache: new Map<string, AgentArrayRef>(),
    volatileNodes: new Set<string>(),
    nearbyScratchSlot: new Map<string, number>(),
    scratchTopLocal: -1,
    forEachStack: [],
    loopStack: [],
    forEachBondStack: [],
    fieldWLocal: P_fieldW, fieldHLocal: P_fieldH, fieldDLocal: P_fieldD, fieldTorusLocal: P_fieldTorus,
    fieldTotalLocal: -1,
    highWaterLocal: P_highWater, hashValidLocal: P_hashValid,
    nBinsXLocal: P_nBinsX, nBinsYLocal: P_nBinsY, nBinsZLocal: P_nBinsZ,
    binSizeXLocal: P_binSizeX, binSizeYLocal: P_binSizeY, binSizeZLocal: P_binSizeZ,
    originXLocal: P_originX, originYLocal: P_originY, originZLocal: P_originZ,
    activeViewerIdxLocal: P_activeViewerIdx,
    viewerGuardIds,
    hazardPinned: new Set<string>(),
    hazardEmitBefore: new Map<string, string[]>(),
  };

  // Assign getNearbyAgents + getAgentsInView scratch slots (reachable only) — both
  // fill a per-node scratch id-array via emitNearbyFill.
  let slot = 0;
  for (const id of reachable) { const n = adj.nodeMap.get(id); const t = n?.data.nodeType; if (t === 'getNearbyAgents' || t === 'getAgentsInView') ctx.nearbyScratchSlot.set(n!.id, slot++); }

  // Volatility analysis (don't cache element/index/getVariable-derived values).
  computeVolatile(ctx);

  // Async read-after-write hazards (SAME shared analyzer + eligibility as the
  // JS compiler): reads that flow-follow a matching write must not TOP-hoist
  // (they'd capture the stale pre-write value). They are emitted ONCE
  // immediately before the flow node that is the LCA of their uses — the SAME
  // position JS's volatileHoist emits them, so bit-parity holds even for
  // multi-use reads with a write between two uses (re-emitting per use here
  // DIVERGED: the Ant Necrophoresis pickup-then-drop shape). Nodes already
  // covered by the volatile re-emit (getVariable/forEach-derived) or the
  // NO_HOIST at-use set (array producers / reducers / RNG) keep their existing
  // mechanisms — the cone below is the pure scalar chains only.
  ctx.hazardPinned = new Set<string>();
  ctx.hazardEmitBefore = new Map<string, string[]>();
  {
    const hazardSeeds = computeAsyncReadWriteHazards({
      nodeMap: adj.nodeMap,
      inputToSource: adj.inputToSource,
      inputToSources: adj.inputToSources,
      flowOutputToTargets: adj.flowOutputToTargets,
      rootNodeId: behaviourNode.id,
      rootFlowPortId: 'do',
      isAsync: model.centerBased?.agentUpdateMode !== 'sync',
    });
    if (hazardSeeds.size > 0) {
      // consumer closure of the seeds
      const consumers = new Map<string, string[]>();
      const addC = (src: string, tgt: string) => { const a = consumers.get(src); if (a) a.push(tgt); else consumers.set(src, [tgt]); };
      for (const [k, src] of adj.inputToSource) { const t = k.split(':')[0]; if (t) addC(src.nodeId, t); }
      for (const [k, srcs] of adj.inputToSources) { const t = k.split(':')[0]; if (t) for (const s of srcs) addC(s.nodeId, t); }
      const cone = new Set<string>();
      const stack = [...hazardSeeds];
      while (stack.length) {
        const id = stack.pop()!;
        if (cone.has(id)) continue;
        cone.add(id);
        for (const c of consumers.get(id) ?? []) stack.push(c);
      }
      for (const id of [...cone]) {
        const n = adj.nodeMap.get(id);
        if (!n) { cone.delete(id); continue; }
        if (ctx.volatileNodes.has(id) || AGENT_VALUE_NO_HOIST.has(n.data.nodeType)) { cone.delete(id); continue; }
        const def = getNodeDef(n.data.nodeType);
        if (!def || def.ports.some(p => p.category === 'flow')) cone.delete(id);
      }
      ctx.hazardPinned = cone;
      ctx.hazardEmitBefore = computeVolatileHoist({
        nodeMap: adj.nodeMap,
        inputToSource: adj.inputToSource,
        inputToSources: adj.inputToSources,
        flowOutputToTargets: adj.flowOutputToTargets,
        rootNodeId: behaviourNode.id,
        rootFlowPortId: 'do',
        volatile: cone,
      }).emitBefore;
    }
  }

  // Patch compileValueNode to resolve forEach element/index ports (they're not
  // in the switch). We do this by overriding the resolver via a closure check.

  try {
    // --- function locals: RNG + idx ---
    const rsLocal = em.allocLocal(I32);
    ctx.rsLocal = rsLocal;
    // _rs = u32[rngStateOffset] || 0x12345678  (read once at function top — AW-RNG;
    // mirrors JS `_rs = _rngState[0] || 0x12345678` exactly so a 0 seed agrees).
    em.i32Const(0); em.i32Load(agentLayout.rngStateOffset, 2); em.localSet(rsLocal);
    em.localGet(rsLocal); em.op(OP_I32_EQZ);
    em.ifThen(() => { em.i32Const(0x12345678); em.localSet(rsLocal); });
    // Local Variables — one f64 local per SCALAR AGENT variable (reset per agent
    // at loop top). The agent graph's variables live on model.agentVariables.
    for (const v of (model.agentVariables ?? [])) {
      if (v.kind !== 'scalar') continue;
      ctx.varLocals.set(v.id, em.allocLocal(F64));
    }
    // Array Local Variables — a fixed scratch slab per variable (offset + len
    // locals); reset to initialValue each agent at loop top. Allocated at the
    // FRONT of the scratch region so the bump-pointer scratch (resolveInputArray)
    // starts above them.
    ctx.scratchTopLocal = em.allocLocal(I32);
    const arrayVars = (model.agentVariables ?? []).filter(v => v.kind === 'array');
    em.i32Const(agentLayout.scratchOffset); em.localSet(ctx.scratchTopLocal);
    for (const v of arrayVars) {
      const len = Math.max(0, Number(v.length) || 0);
      const elemBytes = agentAttrKind(v.dataType) === 'float64' ? 8 : 4;
      const lenLocal = em.allocLocal(I32); em.i32Const(len); em.localSet(lenLocal);
      const ref = allocScratch(ctx, lenLocal, elemBytes, elemBytes === 8);
      ctx.arrayVarLocals.set(v.id, ref);
    }
    // The bump-pointer scratch base = scratchTop AFTER the array vars (reset each
    // agent). Snapshot it as a constant local.
    const scratchBaseLocal = em.allocLocal(I32); em.localGet(ctx.scratchTopLocal); em.localSet(scratchBaseLocal);
    const idxLocal = em.allocLocal(I32);
    ctx.idxLocal = idxLocal;

    // for (idx = 0; idx < highWater; idx++) { if (alive[idx]==0) continue; <body> }
    em.i32Const(0); em.localSet(idxLocal);
    em.block(() => {
      em.loop(() => {
        // if (idx >= highWater) break (label 1 = the block)
        em.localGet(idxLocal); em.localGet(P_highWater); em.op(OP_I32_GE_S); em.brIf(1);
        // if (alive[idx] != 0) { <body> }  — structured (no br out of the if, so
        // the alive==0 case just falls through to idx++).
        em.i32Const(agentLayout.u8['alive']!); em.localGet(idxLocal); em.op(OP_I32_ADD); em.i32Load8U();
        em.ifThen(() => {
          // reset scalar Local Variables to initialValue (agent variable set)
          for (const v of (model.agentVariables ?? [])) {
            if (v.kind !== 'scalar') continue;
            const l = ctx.varLocals.get(v.id)!;
            em.f64Const(variableInitNum(v));
            em.localSet(l);
          }
          // reset the bump-pointer scratch top above the array-var region
          em.localGet(scratchBaseLocal); em.localSet(ctx.scratchTopLocal);
          // refill array Local Variables with their uniform initial value
          for (const v of arrayVars) {
            const ref = ctx.arrayVarLocals.get(v.id)!;
            const init = variableInitNum(v);
            const fi = em.allocLocal(I32); em.i32Const(0); em.localSet(fi);
            em.block(() => { em.loop(() => {
              em.localGet(fi); em.localGet(ref.lenLocal); em.op(OP_I32_GE_S); em.brIf(1);
              storeArrayElemAddr(em, ref, fi);
              if (ref.elemBytes === 8) { em.f64Const(init); em.f64Store(); } else { em.i32Const(init | 0); em.i32Store(); }
              em.localGet(fi); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(fi); em.br(0);
            }); });
          }
          // clear the value/array caches each iteration (locals are recomputed per agent)
          ctx.valueCache.clear();
          ctx.arrayCache.clear();
          // Pre-emit the PURE value cone at agent-loop-top (matches JS's sink-hoist:
          // a field/attr read is captured BEFORE any in-body write mutates it — the
          // field-bridge "sample before deposit" semantics).
          preEmitAgentValues(ctx, behaviourNode.id);
          // run the behaviour flow chain
          compileFlowChain(ctx, behaviourNode.id, 'do');
        });
        // idx++ ; continue loop (label 0)
        em.localGet(idxLocal); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(idxLocal);
        em.br(0);
      });
    });
    // store _rs back to memory (AW-RNG)
    em.i32Const(0); em.localGet(rsLocal); em.i32Store(agentLayout.rngStateOffset, 2);
  } catch (e) {
    return empty(String((e as Error)?.message || e));
  }

  const body = em.buildBody();

  // --- W1: the FORCE PASS function body (a SECOND func in this module) ---
  // The force pass needs an 8th host import `env.fmod = (a,b)=>a%b` (exact JS `%`
  // for the bit-exact torus position wrap — WASM has no f64 rem opcode). It is
  // APPENDED to the import list at funcIdx NUM_IMPORTED_FUNCS (= 7) so the existing
  // pow..tanh func indices (0..6) — which the behaviour body's opCall refers to —
  // are UNCHANGED. The two module-defined funcs then sit at funcIdx 8 (behaviour)
  // and 9 (forcePass).
  // FMOD_FUNC_IDX (module-scope const above) = NUM_IMPORTED_FUNCS = 7.
  // +3 imported funcs after pow..tanh: fmod (7) + agentCreate (8) + agentAddToWorld
  // (9). The two module-defined funcs then sit at funcIdx 10 (behaviour) + 11 (forcePass).
  const NUM_IMPORTED_FUNCS_FORCE = NUM_IMPORTED_FUNCS + 3; // 10 (incl. fmod + agentCreate + agentAddToWorld)
  const fpEm = new WasmEmitter(FORCE_PASS_PARAMS.length);
  const FP: ForcePassParamIdx = {
    highWater: 0, hashValid: 1, nBinsX: 2, nBinsY: 3, nBinsZ: 4,
    binSizeX: 5, binSizeY: 6, binSizeZ: 7,
    dtOverEta: 8, muR: 9, muA: 10, range: 11, momentum: 12, maxSpeed: 13, growthRate: 14,
    W: 15, H: 16, D: 17, bonding: 18, torus: 19,
    originX: 20, originY: 21, originZ: 22,
    doCollision: 23, doSprings: 24, doDensity: 25,
  };
  let forceBody: Uint8Array;
  try {
    emitForcePass(fpEm, agentLayout, is3d, FP, FMOD_FUNC_IDX);
    forceBody = fpEm.buildBody();
  } catch (e) {
    return empty('agentWasm forcePass: ' + String((e as Error)?.message || e));
  }

  // --- assemble the module ---
  const memImport = importEntry('env', 'mem', importMemoryDesc(agentLayout.pages));
  const typeBehaviour = funcType(PARAMS.map(p => (p === 'i32' ? I32 : F64)), []);          // type 0
  const typePow = funcType([F64, F64], [F64]);                                              // type 1 — pow / fmod
  const typeUnary = funcType([F64], [F64]);                                                 // type 2 — exp/log/sin/cos/tan/tanh
  const typeForce = funcType(FORCE_PASS_PARAMS.map(p => (p === 'i32' ? I32 : F64)), []);    // type 3 — forcePass
  const typeCreate = funcType([F64, F64, F64, F64], [I32]);                                 // type 4 — env.agentCreate
  const typeAdd = funcType([I32], []);                                                      // type 5 — env.agentAddToWorld
  const TYPE_BEHAVIOUR = 0, TYPE_POW = 1, TYPE_UNARY = 2, TYPE_FORCE = 3, TYPE_CREATE = 4, TYPE_ADD = 5;
  const powImport = importEntry('env', 'pow', importFuncDesc(TYPE_POW));
  const unaryNames = ['exp', 'log', 'sin', 'cos', 'tan', 'tanh'];
  const unaryImports = unaryNames.map(nm => importEntry('env', nm, importFuncDesc(TYPE_UNARY)));
  const fmodImport = importEntry('env', 'fmod', importFuncDesc(TYPE_POW)); // (f64,f64)->f64
  // Unified spawning host imports — funcIdx AGENT_CREATE_FUNC_IDX (8) / AGENT_ADD_FUNC_IDX (9).
  const agentCreateImport = importEntry('env', 'agentCreate', importFuncDesc(TYPE_CREATE));
  const agentAddImport = importEntry('env', 'agentAddToWorld', importFuncDesc(TYPE_ADD));

  const bytes = buildModule({
    types: [typeBehaviour, typePow, typeUnary, typeForce, typeCreate, typeAdd],
    imports: [memImport, powImport, ...unaryImports, fmodImport, agentCreateImport, agentAddImport],
    funcs: [leb128u(TYPE_BEHAVIOUR), leb128u(TYPE_FORCE)],
    exports: [
      exportEntry('behaviour', EXPORT_FUNC, NUM_IMPORTED_FUNCS_FORCE + 0),
      exportEntry('forcePass', EXPORT_FUNC, NUM_IMPORTED_FUNCS_FORCE + 1),
    ],
    code: [body, forceBody],
  });

  return { bytes, pages: agentLayout.pages, layout: agentLayout, supportedTypes: [...seen], viewerGuardIds };
}

/** Encode a scalar Variable's initialValue → f64. */
function variableInitNum(v: { dataType: string; initialValue?: string }): number {
  const r = v.initialValue ?? '0';
  if (v.dataType === 'bool') return (r === 'true' || r === '1') ? 1 : 0;
  const n = Number(r);
  return Number.isFinite(n) ? n : 0;
}

/** Instantiate the agent WASM module against the agent store's memory + the host
 *  math funcs. Returns the `behaviour(...)` export (the worker calls it with the
 *  per-step hash dimensions) AND the W1 `forcePass(...)` export (the soft-sphere +
 *  bond-spring + integration force loop — null on a legacy/behaviour-only module
 *  that didn't export it). `fmod` is the exact JS `%` the force pass uses for the
 *  bit-exact torus position wrap. */
export async function instantiateAgentWasm(
  bytes: Uint8Array,
  memory: WebAssembly.Memory,
  /** Unified spawning: the grow-only Create Agent + Add Agent To World host closures
   *  (the SAME ones the JS behaviour + the Init Event use, so behaviour-Create is
   *  bit-identical across targets). Default no-ops when the worker doesn't pass them. */
  agentCreate: (x: number, y: number, z: number, radius: number) => number = () => -1,
  agentAddToWorld: (id: number) => void = () => {},
): Promise<{ behaviour: (...args: number[]) => void; forcePass: ((...args: number[]) => void) | null }> {
  const importObj = {
    env: {
      mem: memory,
      pow: Math.pow, exp: Math.exp, log: Math.log,
      sin: Math.sin, cos: Math.cos, tan: Math.tan, tanh: Math.tanh,
      // The force pass's torus position wrap uses JS native `%` (exact fmod).
      fmod: (a: number, b: number): number => a % b,
      // Unified spawning host imports (funcIdx 8 / 9).
      agentCreate, agentAddToWorld,
    },
  };
  const mod = await WebAssembly.instantiate(bytes, importObj);
  return {
    behaviour: mod.instance.exports.behaviour as (...args: number[]) => void,
    forcePass: (mod.instance.exports.forcePass as ((...args: number[]) => void) | undefined) ?? null,
  };
}

/** The per-model max hash-bin reserve, derived from the grid (= agent world)
 *  dimensions + the force config — the worker builds the SAME bound so its
 *  layout matches the compiled module's. */
export function agentMaxHashBinsForModel(model: CAModel): number {
  const cfg = model.centerBased;
  const is3d = is3dModel(model);
  const W = (model.properties.gridWidth as number) || 100;
  const H = (model.properties.gridHeight as number) || 100;
  const D = is3d ? ((model.properties.gridDepth as number) || 1) : 1;
  const range = (cfg?.interactionRange as number) ?? 1.5;
  const dr = (cfg?.defaultRadius as number) ?? 0.5;
  const nq = (cfg?.neighbourQueryRadius as number) ?? 5;
  return computeAgentMaxHashBins(W, H, D, range, dr, nq);
}

/** The model-attribute keys (colour attrs expand to id_r/id_g/id_b/id_a via the
 *  shared `modelAttrSlotKeys`) — the order the worker copies `cachedModelAttrs`
 *  into the in-memory region.
 *
 *  NB the `lookupTable` skip is this site's own long-standing filter (a lookup
 *  table lives in its own region, not the scalar channel) and is intentionally
 *  NOT folded into the shared helper — see attributeScope.ts. */
function modelAttrKeysOf(model: CAModel): string[] {
  const keys: string[] = [];
  for (const a of model.attributes) {
    if (!a.isModelAttribute) continue;
    if (a.type === 'lookupTable') continue;
    keys.push(...modelAttrSlotKeys(a));
  }
  return keys;
}

/** Build the FULL-COVERAGE agent layout extras (model attrs / indicators / lookup
 *  tables / cell fields / array scratch) from the model. The compiler + worker call
 *  the SAME helper so the baked offsets match (the lockstep invariant). */
export function buildAgentLayoutExtras(model: CAModel): AgentLayoutExtras {
  const is3d = is3dModel(model);
  const W = (model.properties.gridWidth as number) || 100;
  const H = (model.properties.gridHeight as number) || 100;
  const D = is3d ? ((model.properties.gridDepth as number) || 1) : 1;
  const fieldIds = cellFieldAttrsOf(model).map(a => a.id);
  const lookupTables: Record<string, { rows: number; cols: number }> = {};
  for (const a of model.attributes) {
    if (a.isModelAttribute && a.type === 'lookupTable') {
      const dims = resolveLookupTableDims(model, a.id);
      if (dims) lookupTables[a.id] = dims;
    }
  }
  const maxAgents = Math.max(1, Math.floor((model.centerBased?.maxAgents as number) ?? 2000));
  // Generous per-agent array-scratch bound: 16 arrays of up to maxAgents f64 each
  // (each array producer / array var reuses the slab per agent; chained producers
  // sum, so 16× covers realistic graphs; the bump pointer never grows unbounded).
  const scratchBytes = maxAgents * 8 * 16;
  return {
    scratchBytes,
    modelAttrKeys: modelAttrKeysOf(model),
    indicatorCount: (model.indicators ?? []).length,
    lookupTables,
    fieldIds,
    fieldTotal: W * H * D,
  };
}

/** Convenience for the DEV harness: derive the agent memory layout from a model's
 *  center-based config + cell-attr specs, then compile. Mirrors how the worker
 *  builds the layout via `createAgentStore({ wasmBacked: true, layoutExtras })`. */
export function compileAgentGraphWasmForModel(model: CAModel): AgentWasmResult {
  const cfg = model.centerBased;
  if (!cfg) return { bytes: new Uint8Array(), pages: 1, layout: computeAgentMemoryLayout(1, 1, []), supportedTypes: [], viewerGuardIds: [], error: 'No centerBased config.' };
  // Generic Agent Platform: the agent SoA + the baked memory offsets are keyed by
  // the AGENT attribute set (agentAttrsOf), the SAME ordered list the worker's
  // buildAgentAttrSpecs uses — they MUST match byte-for-byte or the WASM behaviour
  // reads/writes land on wrong-attribute bytes (the baked-offset lockstep).
  // Expand vector agent attrs into their scalar-float components — the SAME
  // expansion the worker applies to msg.agentAttributes (via SimulatorView) before
  // buildAgentAttrSpecs, so the baked offsets stay in lockstep.
  const specs: AgentAttrSpec[] = expandVectorAttributes(agentAttrsOf(model))
    .map(a => ({ id: a.id, type: a.type, defaultValue: 0 }));
  const maxAgents = Math.max(1, Math.floor((cfg.maxAgents as number) ?? 2000));
  // maxBonds may be 0 (pure-force models) — shared resolver keeps this byte-for-byte
  // in lockstep with the worker's createAgentStore + the WebGPU layout.
  const maxBonds = resolveMaxBonds(cfg);
  const maxHashBins = agentMaxHashBinsForModel(model);
  const extras: AgentLayoutExtras = { ...buildAgentLayoutExtras(model), syncAttrs: model.centerBased?.agentUpdateMode === 'sync' };
  const layout = computeAgentMemoryLayout(maxAgents, maxBonds, specs, maxHashBins, extras);
  return compileAgentGraphWasm(model.agentGraphNodes ?? [], model.agentGraphEdges ?? [], model, layout);
}

/**
 * Graph → WebAssembly compiler (Wave 2 backend).
 *
 * Walks the graph the same way the JS compiler does, but instead of emitting
 * a JS string it emits WASM bytecode via WasmEmitter. Cell attributes,
 * neighbor index tables, indicators, model-attr values, RNG state, active
 * viewer ID, and the color buffer all live in a single WebAssembly.Memory
 * laid out by the worker and accessed via load/store opcodes at compile-time
 * known offsets.
 *
 * One module exports three kinds of functions:
 *   step(total)                                — per-generation flow chain
 *   inputColor_<mappingId>(idx, r, g, b)       — paint event handler
 *   outputMapping_<mappingId>(total)           — color pass for one viewer
 *
 * Per-node emit dispatch is in the VALUE_NODE_EMITTERS / FLOW_NODE_EMITTERS
 * tables. Adding support for a new node type means: add an emit function
 * here, register it. If a graph references an unsupported node, compileGraphWasm
 * returns an error and the worker falls back to the JS step function.
 */

import type { Attribute, CAModel, GraphNode, GraphEdge } from '../../../../model/types';
import { getNodeDef } from '../../nodes/registry';
import { readColorScaleStops, colorScaleHasAlpha, type ColorScaleStop } from '../../nodes/ColorScaleNode';
import { readCategoricalEntries, readCategoricalDefault, categoricalHasAlpha, type CategoricalEntry } from '../../nodes/CategoricalColorNode';
import { colorConstantHasAlpha } from '../../nodes/GetColorConstantNode';
import { CURRENT_VIEWER_SENTINEL } from '../../nodes/SetCellLooksNode';
import {
  ValType, F64, I32, OP_F64_ABS, OP_F64_ADD, OP_F64_CEIL, OP_F64_CONVERT_I32_S, OP_F64_CONVERT_I32_U, OP_F64_DIV,
  OP_F64_EQ, OP_F64_FLOOR, OP_F64_GE, OP_F64_GT, OP_F64_LE, OP_F64_LT,
  OP_F64_MAX, OP_F64_MIN, OP_F64_MUL, OP_F64_NE, OP_F64_SQRT, OP_F64_SUB,
  OP_I32_ADD, OP_I32_AND, OP_I32_DIV_S, OP_I32_EQ, OP_I32_EQZ, OP_I32_GE_S,
  OP_I32_GT_S, OP_I32_LT_S, OP_I32_MUL, OP_I32_OR, OP_I32_REM_S, OP_I32_SHL,
  OP_I32_SHR_S, OP_I32_SHR_U, OP_I32_SUB, OP_I32_XOR, OP_F64_NEG, OP_SELECT,
  buildModule, byte, exportEntry, EXPORT_FUNC, funcType, importEntry,
  importFuncDesc, importMemoryDesc, leb128u,
} from './encoder';
import { INVALID_NI, packNI, packNI3, NI_ARRAY_PRODUCERS } from '../niCodec';
import {
  WasmEmitter, ArrayRef, LocalRef, ValueRef, pushValueAs, isInline,
} from './emitter';
import {
  randomDistribution, randomRefSource, RANDOM_DEG2RAD, RANDOM_TAU, RANDOM_LEN_EPS,
} from '../../nodes/GetRandomNode';
import type { MemoryLayout } from './layout';
import { classifyLoopInvariant } from '../loopInvariant';
import { getInlineValue, parseInlineNum } from '../inlinePort';
import { analyzeSinkScopes, CELL_TOP, type ScopeId, type SinkAnalysisResult } from '../sinkAnalysis';
import { canonicalizeAccessorEdges } from '../accessorCSE';
import { injectLinkedOutputMappings } from '../linkedOutputMappings';
import { collapseReroutes } from '../rerouteCollapse';
import { expandMultiAttrs } from '../multiAttrExpand';
import { expandComposites } from '../expandComposites';
import { lowerVectorAttrs } from '../vectorAttr';
import { expandMacros } from '../macroExpand';
import { computeVolatileHoist } from '../volatileHoist';
import { computeAsyncReadWriteHazards } from '../asyncWriteHazard';
import { makeProducesArray } from '../arrayRelay';
import { subAttrInfo } from '../subAttribute';
import { emitWasm } from '../expression/emitWasm';
import { buildVarMap, parseExpression, clampVisibleCount } from '../expression/parser';

export interface WasmCompileResult {
  bytes: Uint8Array;
  minMemoryPages: number;
  error?: string;
  viewerIds: Record<string, number>;
  /** Names of every exported function in the module. The worker uses this to
   *  pick up step + inputColor_<id> + outputMapping_<id> as separate handles. */
  exports: string[];
}

// ---------------------------------------------------------------------------
// Per-attribute / per-neighborhood lookup helpers (adapt the flat MemoryLayout
// into the small structs the emitters expect).
// ---------------------------------------------------------------------------

interface AttrInfo {
  id: string;
  type: string;
  readOffset: number;
  writeOffset: number;
  itemBytes: number;
}
interface NbrInfo { id: string; offset: number; size: number; }

function getAttr(layout: MemoryLayout, id: string): AttrInfo | null {
  if (!(id in layout.attrType)) return null;
  return {
    id,
    type: layout.attrType[id]!,
    readOffset: layout.attrReadOffset[id]!,
    writeOffset: layout.attrWriteOffset[id]!,
    itemBytes: layout.attrTypeBytes[id]!,
  };
}
function getNbr(layout: MemoryLayout, id: string): NbrInfo | null {
  if (!(id in layout.nbrIndexOffset)) return null;
  return { id, offset: layout.nbrIndexOffset[id]!, size: layout.nbrSize[id]! };
}

/** Map a JS-style comparison operator to a WASM i32 comparison opcode byte. */
function cmpToI32Op(op: string): Uint8Array {
  switch (op) {
    case '!=': case '!==': return OP_I32_NE_OP;
    case '<':  return OP_I32_LT_S;
    case '<=': return OP_I32_LE_S_OP;
    case '>':  return OP_I32_GT_S;
    case '>=': return OP_I32_GE_S;
    default:   return OP_I32_EQ;  // == / ===
  }
}
function cmpToF64Op(op: string): Uint8Array {
  switch (op) {
    case '!=': case '!==': return OP_F64_NE;
    case '<':  return OP_F64_LT;
    case '<=': return OP_F64_LE;
    case '>':  return OP_F64_GT;
    case '>=': return OP_F64_GE;
    default:   return OP_F64_EQ;
  }
}

// Some i32 comparison opcodes we use only via the cmpToI32Op helper.
const OP_I32_NE_OP = byte(0x47);
const OP_I32_LE_S_OP = byte(0x4c);

// WASM has native f64 intrinsics for sqrt/abs/floor/ceil/min/max (round is
// floor(x + 0.5)), but NO opcodes for pow or the transcendentals. We import
// those from the JS host (env.pow, env.exp, …) as func indices 0..N-1; module-
// defined functions therefore start at funcIdx NUM_IMPORTED_FUNCS. Exported so
// the Expression node's WASM emitter (compiler/expression/emitWasm.ts) emits
// `call <idx>` against the same single source of truth.
// IMPORTANT: keep these indices contiguous from 0 and matching the order of the
// import entries appended in buildOneModule's `imports` array, and the env
// object provided in instantiateWasmModule.
export const POW_FUNC_IDX = 0;
export const EXP_FUNC_IDX = 1;
export const LOG_FUNC_IDX = 2;
export const SIN_FUNC_IDX = 3;
export const COS_FUNC_IDX = 4;
export const TAN_FUNC_IDX = 5;
export const TANH_FUNC_IDX = 6;
/** Count of imported host functions (pow + transcendentals). Module-defined
 *  functions occupy funcIdx NUM_IMPORTED_FUNCS .. (NUM_IMPORTED_FUNCS+n-1). */
export const NUM_IMPORTED_FUNCS = 7;

// Module-level type indices (assigned in buildOneModule based on which entry
// points are present). Imported pow lives at type 0; entry-point types start
// at type 1+. We track these as constants only inside buildOneModule.

// ---------------------------------------------------------------------------
// Compile context (orchestrator state)
// ---------------------------------------------------------------------------

interface WasmCompileCtx {
  emitter: WasmEmitter;
  layout: MemoryLayout;
  /** viewerIds: viewer mapping id -> integer (compile-time). */
  viewerIds: Record<string, number>;
  model: CAModel;
  /** Loop counter local: index of the current cell. i32. */
  iLocalIdx: number;
  /** Wave A.6: row/col of the current cell, decoded from idx once per iteration.
   *  Used by NI access emitters (filterNeighbors, get/setNeighborAttributeByIndex,
   *  getNeighborsAttrByIndexes) to compute neighbor cell indices inline from
   *  packed (dr, dc) NI values. -1 when not initialised (non-loop entry point). */
  rowLocalIdx: number;
  colLocalIdx: number;
  /** 3D Grid CA: layer (z) of the current cell, decoded as `idx / (W*H)` once
   *  per iteration. -1 in a 2D model (no `_layer` decode emitted). Read by the
   *  InitEvent `z`/`maxZ` outputs. */
  layerLocalIdx: number;
  /** Memoised value-node compile results for this per-cell pass.
   *  Keyed by nodeId → portId → LocalRef. Default port id is 'value'.
   *  Multi-output value nodes (getColorConstant, colorScale,
   *  getModelAttribute color, inputColor) populate multiple ports. */
  valueLocals: Map<string, Map<string, LocalRef>>;
  /** Memoised array-producing emitter results. Array nodes only have one
   *  array output port in practice (e.g. getNeighborIndexesByTags.indexes,
   *  filterNeighbors.result), so a single key suffices. */
  arrayRefs: Map<string, ArrayRef>;
  /** Cached `i * itemBytes` locals keyed by itemBytes. */
  byteOffsetLocals: Map<number, number>;
  /** Adjacency. */
  nodeMap: Map<string, GraphNode>;
  inputToSource: Map<string, { nodeId: string; portId: string }>;
  inputToSources: Map<string, Array<{ nodeId: string; portId: string }>>;
  flowOutputToTargets: Map<string, Array<{ nodeId: string; portId: string }>>;
  /** Context-aware "does this source node emit an array?" — true for static
   *  array producers AND a valueSwitch whose both branches relay arrays. Used
   *  at every source-disambiguation site (resolveInputArray gate, aggregate /
   *  groupOperator dispatch, setNeighbor*ByIndex index arrays). See
   *  `compiler/arrayRelay.ts`. */
  producesArray: (node: GraphNode) => boolean;
  /** "Skip Isolated Empty Cells" (inline-neighbour mode): the nbr region holds
   *  COMPACT packed per-slot offsets (`size` i32 NIs), not `total × size`
   *  per-cell indices. Every table-read site branches on this: inline mode
   *  loads the slot's packed NI + resolves via pushNiCellIdx (identical
   *  torus/constant semantics). False → the classic table read (byte-identical). */
  inlineNbr: boolean;
  /** Errors encountered (unsupported nodes, etc.) — non-empty means compile failed. */
  errors: string[];
  /** Bump-pointer local for the per-cell scratch region. Reset to
   *  layout.scratchOffset at the top of each cell iteration; advanced by array
   *  producers. None means scratch hasn't been used in this entry point. */
  scratchTopLocal: number;
  /** Param indices forwarded from the entry point function (e.g. inputColor's
   *  r/g/b params). When a value node maps to a param (InputColor's r/g/b
   *  outputs), it's recorded here so consumers see the param value directly
   *  without going through compileValueNode. */
  paramRefs: Map<string, Map<string, LocalRef>>;
  /** Set of value nodes classified as loop-invariant (their result doesn't
   *  depend on the cell index). Their emit code is hoisted to a single emission
   *  before the cell loop, with the resulting LocalRef preserved across cells.
   *  Shared classifier with the JS compiler in `compiler/loopInvariant.ts`. */
  loopInvariant: Set<string>;
  /** Per-step viewer-active i32 locals: mappingId → local idx holding
   *  `activeViewer == viewerIds[mappingId] ? 1 : 0`. Computed ONCE in the
   *  function preamble and reused by every SetColorViewer per cell. Mirrors
   *  the JS compiler's `_isV_<safeId>` constants. */
  viewerLocals: Map<string, number>;
  /** Sink-scope analysis for the current entry's flow tree. Each value node
   *  is assigned an LCA scope (CELL_TOP or `${flowNodeId}:${branchPortId}`).
   *  emitValuesForScope iterates sinkAnalysis.valuesByScope[scope] in topo
   *  order and calls compileValueNode / compileArrayNode at the current
   *  bytecode position — which is implicitly inside the branch when the
   *  caller is inside an emitter.ifThen / ifThenElse / loop callback. */
  sinkAnalysis?: SinkAnalysisResult;
  /** Local Variables — per-cell scratch storage keyed by variable id.
   *  Scalar variables back to a WASM function-local. Array variables back
   *  to a scratch slot whose offset is captured in a function-local at
   *  cell-top (so the offset is stable across the cell's emit, while
   *  the storage itself lives in per-cell scratch and gets reset to
   *  initialValue every cell iteration). Populated by emitVariableStorage
   *  + emitVariableReset; consumed by VALUE_NODE_EMITTERS['getVariable']
   *  / FLOW_NODE_EMITTERS['setVariable'] / ['setArrayElement']. */
  variableLocals: Map<string, VariableSlotWasm>;
  /** Volatile values — transitive value-input consumers of any `getVariable`
   *  node. These read per-cell mutable state and must NOT be hoisted to
   *  scope entry by emitValuesForScope (they'd read the variable's initial
   *  value, missing later mutations). The consumer's input resolution
   *  triggers their compile lazily at the use site instead, where the
   *  bytecode lands after the mutating flow children have run. Mirrors
   *  the JS compiler's volatileValues set. */
  volatileValues: Set<string>;
  /** Volatile value ids to force-emit immediately BEFORE a given flow node
   *  (keyed by flow node id), at its enclosing scope — computed by
   *  `computeVolatileHoist`. Ensures a volatile value used across multiple
   *  sibling branches is emitted once, before the branch divergence, so its
   *  function-local is set on every path. */
  volatileHoist: Map<string, string[]>;
}

/** WASM-side slot for a Local Variable. Scalar: function-local holding the
 *  current value. Array: function-local holding the scratch offset (in
 *  bytes from memory base) of the storage region; per-cell, this offset is
 *  re-assigned by emitVariableReset, but stays constant within one cell's
 *  emit so reads/writes see a consistent base. */
type VariableSlotWasm =
  | { kind: 'scalar'; localIdx: number; valtype: ValType; initLiteral: number }
  | { kind: 'array'; offsetLocal: number; length: number; elemBytes: number; elemValtype: ValType; initLiteral: number };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function attrValType(t: string): ValType {
  return t === 'float' ? F64 : I32;
}

/** Compute the transitive value-input closure starting from every
 *  `getVariable` node. Mirrors the JS compiler's helper of the same name —
 *  membership marks a node as "volatile" so emitValuesForScope skips it
 *  and the consumer-side input resolution triggers a lazy compile at the
 *  use site (where the bytecode lands AFTER any mutating flow children). */
function computeVolatileValueClosureWasm(
  graphNodes: GraphNode[],
  inputToSource: Map<string, { nodeId: string; portId: string }>,
  inputToSources: Map<string, Array<{ nodeId: string; portId: string }>>,
  extraSeeds?: Iterable<string>,
): Set<string> {
  const out = new Set<string>();
  const consumers = new Map<string, Set<string>>();
  const addConsumer = (sourceId: string, targetId: string) => {
    let s = consumers.get(sourceId);
    if (!s) { s = new Set(); consumers.set(sourceId, s); }
    s.add(targetId);
  };
  for (const [targetKey, src] of inputToSource) {
    const targetId = targetKey.split(':')[0];
    if (targetId) addConsumer(src.nodeId, targetId);
  }
  for (const [targetKey, sources] of inputToSources) {
    const targetId = targetKey.split(':')[0];
    if (!targetId) continue;
    for (const s of sources) addConsumer(s.nodeId, targetId);
  }
  const queue: string[] = [];
  for (const n of graphNodes) {
    if (n.data.nodeType === 'getVariable') {
      out.add(n.id);
      queue.push(n.id);
    }
  }
  // Extra seeds (async read-after-write hazard reads) propagate through the same
  // consumer BFS so the whole derived chain becomes volatile.
  if (extraSeeds) for (const id of extraSeeds) {
    if (!out.has(id)) { out.add(id); queue.push(id); }
  }
  while (queue.length > 0) {
    const id = queue.shift()!;
    const cs = consumers.get(id);
    if (!cs) continue;
    for (const c of cs) {
      if (!out.has(c)) {
        out.add(c);
        queue.push(c);
      }
    }
  }
  return out;
}

/** Parse a Variable's initialValue string into a numeric literal. Mirrors
 *  `variableValueLiteralJS` in compiler/variable.ts — bools become 0/1,
 *  numbers parse decimal, tag indices are already stringified ints. */
function variableInitLiteralWasm(v: import('../../../../model/types').Variable): number {
  const r = v.initialValue ?? '0';
  if (v.dataType === 'bool') {
    return (r === 'true' || r === '1') ? 1 : 0;
  }
  const n = Number(r);
  return Number.isFinite(n) ? n : 0;
}

/** Wave A.6: emit code that pushes the cell index reached by applying NI
 *  (packed dr, dc in the local `niLocal`) from the current cell, with
 *  boundary handling baked at compile time.
 *
 *  Stack effect: pushes one i32 (the resulting cell index). For
 *  constant-boundary models, out-of-bounds offsets resolve to `total`
 *  (the sentinel cell). For torus, modular wrapping. The caller is
 *  responsible for guarding the niLocal against `INVALID_NI` if needed. */
function pushNiCellIdx(ctx: WasmCompileCtx, niLocal: number): void {
  const em = ctx.emitter;
  const W = ctx.model.properties.gridWidth;
  const H = ctx.model.properties.gridHeight;
  const boundary = ctx.model.properties.boundaryTreatment;

  // 3D Grid CA: decode the 10-bit (dr, dc, dl) fields and resolve via layer.
  // Mirrors niCodec.niCellExprStmts' 3D branch exactly. layerLocalIdx >= 0 is
  // the 3D predicate (set only for a 3D-volume entry; 2D leaves it -1 and falls
  // through to the byte-identical 2-axis path below).
  if (ctx.layerLocalIdx >= 0) {
    const D = Math.max(1, ctx.model.properties.gridDepth ?? 1);
    const total3d = W * H * D;
    const nl = em.allocLocal(I32);
    const nr = em.allocLocal(I32);
    const nc = em.allocLocal(I32);
    // newLayer = layer + ((ni << 22) >> 22)
    em.localGet(ctx.layerLocalIdx);
    em.localGet(niLocal); em.i32Const(22); em.op(OP_I32_SHL); em.i32Const(22); em.op(OP_I32_SHR_S);
    em.op(OP_I32_ADD); em.localSet(nl);
    // newRow = row + ((ni << 2) >> 22)
    em.localGet(ctx.rowLocalIdx);
    em.localGet(niLocal); em.i32Const(2); em.op(OP_I32_SHL); em.i32Const(22); em.op(OP_I32_SHR_S);
    em.op(OP_I32_ADD); em.localSet(nr);
    // newCol = col + ((ni << 12) >> 22)
    em.localGet(ctx.colLocalIdx);
    em.localGet(niLocal); em.i32Const(12); em.op(OP_I32_SHL); em.i32Const(22); em.op(OP_I32_SHR_S);
    em.op(OP_I32_ADD); em.localSet(nc);
    if (boundary === 'torus') {
      // wrap each axis: ((x % S) + S) % S
      em.localGet(nl); em.i32Const(D); em.op(OP_I32_REM_S); em.i32Const(D); em.op(OP_I32_ADD); em.i32Const(D); em.op(OP_I32_REM_S); em.localSet(nl);
      em.localGet(nr); em.i32Const(H); em.op(OP_I32_REM_S); em.i32Const(H); em.op(OP_I32_ADD); em.i32Const(H); em.op(OP_I32_REM_S); em.localSet(nr);
      em.localGet(nc); em.i32Const(W); em.op(OP_I32_REM_S); em.i32Const(W); em.op(OP_I32_ADD); em.i32Const(W); em.op(OP_I32_REM_S); em.localSet(nc);
      // result = (nl * H + nr) * W + nc
      em.localGet(nl); em.i32Const(H); em.op(OP_I32_MUL); em.localGet(nr); em.op(OP_I32_ADD);
      em.i32Const(W); em.op(OP_I32_MUL); em.localGet(nc); em.op(OP_I32_ADD);
    } else {
      // constant: out-of-bounds (any axis) → total3d (sentinel cell)
      // a = (nl * H + nr) * W + nc
      em.localGet(nl); em.i32Const(H); em.op(OP_I32_MUL); em.localGet(nr); em.op(OP_I32_ADD);
      em.i32Const(W); em.op(OP_I32_MUL); em.localGet(nc); em.op(OP_I32_ADD);
      // b = total3d
      em.i32Const(total3d);
      // cond = 0<=nl<D && 0<=nr<H && 0<=nc<W
      em.localGet(nl); em.i32Const(0); em.op(OP_I32_GE_S);
      em.localGet(nl); em.i32Const(D); em.op(OP_I32_LT_S); em.op(OP_I32_AND);
      em.localGet(nr); em.i32Const(0); em.op(OP_I32_GE_S); em.op(OP_I32_AND);
      em.localGet(nr); em.i32Const(H); em.op(OP_I32_LT_S); em.op(OP_I32_AND);
      em.localGet(nc); em.i32Const(0); em.op(OP_I32_GE_S); em.op(OP_I32_AND);
      em.localGet(nc); em.i32Const(W); em.op(OP_I32_LT_S); em.op(OP_I32_AND);
      em.op(OP_SELECT);
    }
    return;
  }

  const total = W * H;
  const newRow = em.allocLocal(I32);
  const newCol = em.allocLocal(I32);
  // newRow = row + (ni >> 16)
  em.localGet(ctx.rowLocalIdx);
  em.localGet(niLocal);
  em.i32Const(16);
  em.op(OP_I32_SHR_S);
  em.op(OP_I32_ADD);
  em.localSet(newRow);
  // newCol = col + ((ni << 16) >> 16)
  em.localGet(ctx.colLocalIdx);
  em.localGet(niLocal);
  em.i32Const(16);
  em.op(OP_I32_SHL);
  em.i32Const(16);
  em.op(OP_I32_SHR_S);
  em.op(OP_I32_ADD);
  em.localSet(newCol);

  if (boundary === 'torus') {
    // r = ((newRow % H) + H) % H
    em.localGet(newRow);
    em.i32Const(H);
    em.op(OP_I32_REM_S);
    em.i32Const(H);
    em.op(OP_I32_ADD);
    em.i32Const(H);
    em.op(OP_I32_REM_S);
    em.localSet(newRow);
    // c = ((newCol % W) + W) % W
    em.localGet(newCol);
    em.i32Const(W);
    em.op(OP_I32_REM_S);
    em.i32Const(W);
    em.op(OP_I32_ADD);
    em.i32Const(W);
    em.op(OP_I32_REM_S);
    em.localSet(newCol);
    // result = r * W + c
    em.localGet(newRow);
    em.i32Const(W);
    em.op(OP_I32_MUL);
    em.localGet(newCol);
    em.op(OP_I32_ADD);
  } else {
    // Constant boundary: out-of-bounds → total (sentinel).
    // result = inBounds ? (newRow * W + newCol) : total
    // Build via OP_SELECT (pops [a, b, cond] → pushes cond ? a : b).
    // a = newRow * W + newCol  (in-bounds branch)
    em.localGet(newRow);
    em.i32Const(W);
    em.op(OP_I32_MUL);
    em.localGet(newCol);
    em.op(OP_I32_ADD);
    // b = total  (out-of-bounds branch — sentinel cell)
    em.i32Const(total);
    // cond = newRow >= 0 && newRow < H && newCol >= 0 && newCol < W
    em.localGet(newRow);
    em.i32Const(0);
    em.op(OP_I32_GE_S);
    em.localGet(newRow);
    em.i32Const(H);
    em.op(OP_I32_LT_S);
    em.op(OP_I32_AND);
    em.localGet(newCol);
    em.i32Const(0);
    em.op(OP_I32_GE_S);
    em.op(OP_I32_AND);
    em.localGet(newCol);
    em.i32Const(W);
    em.op(OP_I32_LT_S);
    em.op(OP_I32_AND);
    em.op(OP_SELECT);
  }
}

/** "Skip Isolated Empty Cells" (inline-neighbour mode): push the neighbour CELL
 *  index for a slot of neighbourhood `nbr` when the nbr region holds COMPACT
 *  packed per-slot NIs (no per-cell table). `pushSlot` must push the slot index
 *  (i32) onto the stack. Loads the slot's packed NI, then resolves it to a cell
 *  index via pushNiCellIdx — the same torus-wrap / constant-sentinel math the
 *  big table precomputed, so the result equals the old `i32.load` exactly.
 *  Stack effect: pushes one i32 (the neighbour cell index; `total` sentinel for
 *  constant-boundary OOB). ONLY call when ctx.inlineNbr — the table-mode paths
 *  at every site are left verbatim for byte-identity. */
function pushInlineNbrCellIdx(ctx: WasmCompileCtx, nbr: NbrInfo, pushSlot: () => void): void {
  const em = ctx.emitter;
  const tmp = em.allocLocal(I32);
  pushSlot();
  em.i32Const(4);
  em.op(OP_I32_MUL);
  em.i32Load(nbr.offset, 2);   // the slot's PACKED NI
  em.localSet(tmp);
  pushNiCellIdx(ctx, tmp);
}

/** Push `i * itemBytes` onto the stack. The cache local is pre-initialised at
 *  the top of each cell body by `initByteOffsetLocals` (called from emitBody
 *  before any value-sinking emission), so every callsite — including ones
 *  inside conditional branches that don't always execute — sees a value
 *  computed for the CURRENT cell. Without the pre-init, value sinking can
 *  push the first use of an itemBytes into one branch's body, where the
 *  `localTee` only runs when that branch fires; sibling branches reading the
 *  same cached local would then see stale data from a prior cell (or 0 for
 *  the first cell). */
function pushCellByteOffset(ctx: WasmCompileCtx, itemBytes: number): void {
  const cached = ctx.byteOffsetLocals.get(itemBytes);
  if (cached !== undefined) {
    ctx.emitter.localGet(cached);
    return;
  }
  // Fallback: not pre-initialised (defensive — initByteOffsetLocals should
  // have covered every itemBytes the model uses). Allocate + initialise here
  // for callsites that escape the model's normal attr/nbr-index surface.
  const local = ctx.emitter.allocLocal(I32);
  ctx.emitter.localGet(ctx.iLocalIdx);
  if (itemBytes !== 1) {
    ctx.emitter.i32Const(itemBytes);
    ctx.emitter.op(OP_I32_MUL);
  }
  ctx.emitter.localTee(local);
  ctx.byteOffsetLocals.set(itemBytes, local);
}

/** Pre-allocate + initialise the cached `idx * itemBytes` locals for every
 *  distinct itemBytes value the model uses. Called from emitBody right after
 *  the per-cell cache clear; emits the multiplication unconditionally at
 *  cell-top so subsequent uses (even ones sunk into branches) read a value
 *  computed for the current cell. */
function initByteOffsetLocals(ctx: WasmCompileCtx, itemBytesSet: ReadonlySet<number>): void {
  for (const itemBytes of itemBytesSet) {
    const local = ctx.emitter.allocLocal(I32);
    ctx.emitter.localGet(ctx.iLocalIdx);
    if (itemBytes !== 1) {
      ctx.emitter.i32Const(itemBytes);
      ctx.emitter.op(OP_I32_MUL);
    }
    ctx.emitter.localSet(local);
    ctx.byteOffsetLocals.set(itemBytes, local);
  }
}

/** Sub-attribute info resolved against the WASM layout. Used by the read wrap
 *  helpers below to emit the parent-match guard. */
interface WasmSubAttrInfo {
  parent: AttrInfo;
  parentValuesInt: number[];
  undefinedValueStr: string;
}

/** Look up sub-attribute info for an attribute, or null if it's regular. */
function getSubAttrWasm(ctx: WasmCompileCtx, attrId: string): WasmSubAttrInfo | null {
  const attr = ctx.model.attributes.find(a => a.id === attrId);
  const info = subAttrInfo(attr, ctx.model);
  if (!info || !attr) return null;
  const parentLayout = getAttr(ctx.layout, info.parent.id);
  if (!parentLayout) return null;
  const parentValuesInt = info.parentValues.map(v => parentValueToInt(info.parent, v));
  return {
    parent: parentLayout,
    parentValuesInt,
    undefinedValueStr: info.undefinedValue ?? attr.defaultValue ?? '',
  };
}

function parentValueToInt(parent: Attribute, raw: string): number {
  if (parent.type === 'bool') return raw === 'true' || raw === '1' ? 1 : 0;
  if (parent.type === 'tag') {
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** Push an attribute-typed constant onto the stack from a string-encoded value
 *  (matches Attribute.defaultValue's encoding). Bool 'true'/'false' → 1/0,
 *  numeric strings parsed accordingly. */
function emitAttrLiteralWasm(ctx: WasmCompileCtx, attr: AttrInfo, valueStr: string): void {
  switch (attr.type) {
    case 'bool':
      ctx.emitter.i32Const(valueStr === 'true' || valueStr === '1' ? 1 : 0);
      break;
    case 'float': {
      const n = parseFloat(valueStr);
      ctx.emitter.f64Const(Number.isFinite(n) ? n : 0);
      break;
    }
    default: {
      const n = parseInt(valueStr, 10);
      ctx.emitter.i32Const(Number.isFinite(n) ? n : 0);
      break;
    }
  }
}

/** OR-chain helper. Given a local holding the parent's stored value (i32),
 *  push an i32 boolean (1 if the value matches any of `parentValuesInt`, else 0). */
function emitMatchOR(ctx: WasmCompileCtx, valueLocal: number, parentValuesInt: number[]): void {
  if (parentValuesInt.length === 0) {
    ctx.emitter.i32Const(0);
    return;
  }
  ctx.emitter.localGet(valueLocal);
  ctx.emitter.i32Const(parentValuesInt[0]!);
  ctx.emitter.op(OP_I32_EQ);
  for (let i = 1; i < parentValuesInt.length; i++) {
    ctx.emitter.localGet(valueLocal);
    ctx.emitter.i32Const(parentValuesInt[i]!);
    ctx.emitter.op(OP_I32_EQ);
    ctx.emitter.op(OP_I32_OR);
  }
}

/** Push an i32 boolean (1/0) indicating whether the parent's stored value at
 *  the CURRENT cell index matches any value in `parentValuesInt`. */
function emitParentMatchAtCellWasm(
  ctx: WasmCompileCtx,
  parent: AttrInfo,
  parentValuesInt: number[],
  useWriteBuffer: boolean,
): void {
  // Load parent[idx]
  pushCellByteOffset(ctx, parent.itemBytes);
  const offset = useWriteBuffer ? parent.writeOffset : parent.readOffset;
  if (parent.type === 'bool') ctx.emitter.i32Load8U(offset, 0);
  else ctx.emitter.i32Load(offset, 2);
  // Cache, then OR-chain compare
  const local = ctx.emitter.allocLocal(I32);
  ctx.emitter.localSet(local);
  emitMatchOR(ctx, local, parentValuesInt);
}

/** Push an i32 boolean indicating parent-match at an arbitrary cell index
 *  (held in `cellIdxLocal`). Used for neighbor-cell sub-attribute reads. */
function emitParentMatchAtIdxWasm(
  ctx: WasmCompileCtx,
  parent: AttrInfo,
  parentValuesInt: number[],
  cellIdxLocal: number,
  useWriteBuffer: boolean,
): void {
  ctx.emitter.localGet(cellIdxLocal);
  ctx.emitter.i32Const(parent.itemBytes);
  ctx.emitter.op(OP_I32_MUL);
  const offset = useWriteBuffer ? parent.writeOffset : parent.readOffset;
  if (parent.type === 'bool') ctx.emitter.i32Load8U(offset, 0);
  else ctx.emitter.i32Load(offset, 2);
  const local = ctx.emitter.allocLocal(I32);
  ctx.emitter.localSet(local);
  emitMatchOR(ctx, local, parentValuesInt);
}

/** Emit a load from cell attribute `attr.id` at the current cell index, pushes the value.
 *  For sub-attributes the load is wrapped with a parent-check guard returning
 *  the configured `undefinedValue` on mismatch (via WASM `select`). */
function emitCellRead(ctx: WasmCompileCtx, attr: AttrInfo, useWriteBuffer: boolean): void {
  const sub = getSubAttrWasm(ctx, attr.id);
  // Always emit the raw load first (the matched-case value).
  pushCellByteOffset(ctx, attr.itemBytes);
  const offset = useWriteBuffer ? attr.writeOffset : attr.readOffset;
  if (attr.type === 'bool') ctx.emitter.i32Load8U(offset, 0);
  else if (attr.type === 'float') ctx.emitter.f64Load(offset, 3);
  else ctx.emitter.i32Load(offset, 2);
  if (!sub) return;
  // Push the undefined-case literal, then the i32 condition, then select.
  emitAttrLiteralWasm(ctx, attr, sub.undefinedValueStr);
  emitParentMatchAtCellWasm(ctx, sub.parent, sub.parentValuesInt, useWriteBuffer);
  ctx.emitter.op(OP_SELECT);
}

/** Emit a store to cell attribute `attr.id` at the current cell index. */
function emitCellWriteAtIdx(ctx: WasmCompileCtx, attr: AttrInfo, valueRef: ValueRef): void {
  // Stack: [addr, value]
  pushCellByteOffset(ctx, attr.itemBytes);
  pushValueAs(ctx.emitter, valueRef, attrValType(attr.type));
  if (attr.type === 'bool') ctx.emitter.i32Store8(attr.writeOffset, 0);
  else if (attr.type === 'float') ctx.emitter.f64Store(attr.writeOffset, 3);
  else ctx.emitter.i32Store(attr.writeOffset, 2);
}

/** Cache lookup: get the LocalRef for (nodeId, portId), or undefined. */
function getCachedPort(ctx: WasmCompileCtx, nodeId: string, portId: string): LocalRef | undefined {
  // Param refs first (e.g. InputColor's r/g/b outputs that resolve to function params).
  const paramMap = ctx.paramRefs.get(nodeId);
  if (paramMap?.has(portId)) return paramMap.get(portId);
  return ctx.valueLocals.get(nodeId)?.get(portId);
}

/** Cache write: store the LocalRef for (nodeId, portId). */
function setCachedPort(ctx: WasmCompileCtx, nodeId: string, portId: string, ref: LocalRef): void {
  let m = ctx.valueLocals.get(nodeId);
  if (!m) { m = new Map(); ctx.valueLocals.set(nodeId, m); }
  m.set(portId, ref);
}

/** Allocate a fresh ArrayRef in scratch with `lenLocal` elements of `elemBytes`
 *  bytes each. Captures current scratchTop into a new local (the offsetLocal),
 *  then advances scratchTop past the allocated region. The producer is
 *  responsible for actually filling the elements. */
function allocArrayInScratch(
  ctx: WasmCompileCtx,
  lenLocal: number,
  elemValtype: ValType,
  elemBytes: number,
): ArrayRef {
  const offsetLocal = ctx.emitter.allocLocal(I32);
  // offsetLocal := scratchTop
  ctx.emitter.localGet(ctx.scratchTopLocal);
  ctx.emitter.localSet(offsetLocal);
  // scratchTop += len * elemBytes
  ctx.emitter.localGet(ctx.scratchTopLocal);
  ctx.emitter.localGet(lenLocal);
  if (elemBytes !== 1) {
    ctx.emitter.i32Const(elemBytes);
    ctx.emitter.op(OP_I32_MUL);
  }
  ctx.emitter.op(OP_I32_ADD);
  ctx.emitter.localSet(ctx.scratchTopLocal);
  return { kind: 'array', offsetLocal, lenLocal, elemValtype, elemBytes };
}

/** Allocate a fresh ArrayRef with a compile-time-known length. */
function allocArrayInScratchConst(
  ctx: WasmCompileCtx,
  constLen: number,
  elemValtype: ValType,
  elemBytes: number,
): ArrayRef {
  const lenLocal = ctx.emitter.allocLocal(I32);
  ctx.emitter.i32Const(constLen);
  ctx.emitter.localSet(lenLocal);
  return allocArrayInScratch(ctx, lenLocal, elemValtype, elemBytes);
}

/** Emit a load from an ArrayRef element at i32 index on the top of stack.
 *  Stack before: [iElem]; after: [value]. */
function emitArrayLoadElem(em: WasmEmitter, arr: ArrayRef): void {
  // address = offsetLocal + iElem * elemBytes
  if (arr.elemBytes !== 1) {
    em.i32Const(arr.elemBytes);
    em.op(OP_I32_MUL);
  }
  em.localGet(arr.offsetLocal);
  em.op(OP_I32_ADD);
  // load by elem type
  if (arr.elemBytes === 1) em.i32Load8U(0, 0);
  else if (arr.elemValtype === F64) em.f64Load(0, 3);
  else em.i32Load(0, 2);
}

// ---------------------------------------------------------------------------
// Per-node value emitters
// ---------------------------------------------------------------------------

interface NodeEmitContext {
  ctx: WasmCompileCtx;
  node: GraphNode;
  inputs: Record<string, ValueRef | undefined>;
}

/** A scalar emitter populates ctx.valueLocals for one or more output ports
 *  and returns the canonical default-port LocalRef (or null on error). */
type NodeValueEmitter = (c: NodeEmitContext) => LocalRef | null;
type NodeFlowEmitter = (c: NodeEmitContext) => boolean;

/** Allocate a local for the result, store the top of stack into it, return ref. */
function storeResult(em: WasmEmitter, valtype: ValType): LocalRef {
  const local = em.allocLocal(valtype);
  em.localSet(local);
  return { localIdx: local, valtype };
}

/**
 * Emit WASM that computes the interpolation curve f(t) for the given method,
 * reading from `tRawLoc` (an f64 local containing the raw t value) and
 * returning the f64 local that holds the curved result.
 *
 * For non-linear methods, t is clamped to [0, 1] before applying the curve;
 * `linear` keeps unclamped extrapolation to match the prior bit-identical
 * behaviour for saved models. Mirrors `emitInterpolationCurveJS` in
 * `nodes/interpolationMethods.ts` and the WGSL variant.
 */
function emitInterpolationCurveWasm(
  em: WasmEmitter,
  tRawLoc: number,
  method: string,
): number {
  const out = em.allocLocal(F64);
  if (method === 'linear') {
    em.localGet(tRawLoc);
    em.localSet(out);
    return out;
  }
  // Clamp t to [0, 1] using f64.max(0, f64.min(1, t)).
  const tcl = em.allocLocal(F64);
  em.f64Const(0);
  em.f64Const(1);
  em.localGet(tRawLoc);
  em.op(OP_F64_MIN);
  em.op(OP_F64_MAX);
  em.localSet(tcl);
  switch (method) {
    case 'smoothstep': {
      // tcl * tcl * (3 - 2 * tcl)
      em.localGet(tcl);
      em.localGet(tcl);
      em.op(OP_F64_MUL);
      em.f64Const(3);
      em.f64Const(2);
      em.localGet(tcl);
      em.op(OP_F64_MUL);
      em.op(OP_F64_SUB);
      em.op(OP_F64_MUL);
      em.localSet(out);
      break;
    }
    case 'easeInQuad': {
      // tcl * tcl
      em.localGet(tcl);
      em.localGet(tcl);
      em.op(OP_F64_MUL);
      em.localSet(out);
      break;
    }
    case 'easeOutQuad': {
      // 1 - (1-tcl)*(1-tcl)
      em.f64Const(1);
      em.f64Const(1);
      em.localGet(tcl);
      em.op(OP_F64_SUB);
      em.f64Const(1);
      em.localGet(tcl);
      em.op(OP_F64_SUB);
      em.op(OP_F64_MUL);
      em.op(OP_F64_SUB);
      em.localSet(out);
      break;
    }
    case 'exponential': {
      // tcl > 0 ? pow(2, 10*(tcl-1)) : 0
      em.localGet(tcl);
      em.f64Const(0);
      em.op(OP_F64_GT);
      em.ifThenElse(
        () => {
          em.f64Const(2);
          em.f64Const(10);
          em.localGet(tcl);
          em.f64Const(1);
          em.op(OP_F64_SUB);
          em.op(OP_F64_MUL);
          em.emit(byte(0x10), leb128u(POW_FUNC_IDX));
          em.localSet(out);
        },
        () => {
          em.f64Const(0);
          em.localSet(out);
        },
      );
      break;
    }
    case 'logarithmic': {
      // tcl < 1 ? 1 - pow(2, -10*tcl) : 1
      em.localGet(tcl);
      em.f64Const(1);
      em.op(OP_F64_LT);
      em.ifThenElse(
        () => {
          em.f64Const(1);
          em.f64Const(2);
          em.f64Const(-10);
          em.localGet(tcl);
          em.op(OP_F64_MUL);
          em.emit(byte(0x10), leb128u(POW_FUNC_IDX));
          em.op(OP_F64_SUB);
          em.localSet(out);
        },
        () => {
          em.f64Const(1);
          em.localSet(out);
        },
      );
      break;
    }
    default:
      em.localGet(tcl);
      em.localSet(out);
      break;
  }
  return out;
}

const VALUE_NODE_EMITTERS: Record<string, NodeValueEmitter> = {

  getConstant: ({ node, ctx }) => {
    const t = (node.data.config.constType as string) || 'integer';
    const raw = node.data.config.constValue;
    let num: number;
    if (t === 'bool') {
      num = (raw === 'true' || raw === true || raw === 1) ? 1 : 0;
    } else if (t === 'float') {
      num = typeof raw === 'number' ? raw : (parseFloat(String(raw ?? '0')) || 0);
    } else if (t === 'orientation') {
      // Orientation: integer 0..3 (N/E/S/W). Clamp to range as a safety net.
      const n = typeof raw === 'number' ? raw : (parseInt(String(raw ?? '0'), 10) || 0);
      num = Number.isFinite(n) && n >= 0 && n <= 3 ? (n | 0) : 0;
    } else if (t === 'faceLabel') {
      // Face label index pre-resolved into _resolvedFaceLabelIndex by
      // compile.ts::preResolveVariegatedNodes (target-independent). Unresolved
      // (variegation off / unknown label) is -1.
      const idx = parseInt(String(node.data.config._resolvedFaceLabelIndex ?? -1), 10);
      num = Number.isFinite(idx) ? idx : -1;
    } else {
      num = typeof raw === 'number' ? raw : (parseInt(String(raw ?? '0'), 10) || 0);
    }
    if (t === 'float') {
      ctx.emitter.f64Const(num);
      return storeResult(ctx.emitter, F64);
    }
    // bool / integer / tag / orientation / faceLabel — i32
    ctx.emitter.i32Const(num | 0);
    return storeResult(ctx.emitter, I32);
  },

  // Wave A.6: NIs are packed (dr, dc) i32. neighborIndexFromOffset takes dr/dc
  // as input ports and emits the packed value at runtime.
  neighborIndexFromOffset: ({ ctx, inputs }) => {
    const drRef = inputs['dr'] ?? { inline: true, value: 0, valtype: I32 };
    const dcRef = inputs['dc'] ?? { inline: true, value: 0, valtype: I32 };
    const em = ctx.emitter;
    if (ctx.layerLocalIdx >= 0) {
      // 3D: pack three 10-bit fields (dr<<20 | dc<<10 | dl).
      const dlRef = inputs['dl'] ?? { inline: true, value: 0, valtype: I32 };
      pushValueAs(em, drRef, I32); em.i32Const(0x3FF); em.op(OP_I32_AND); em.i32Const(20); em.op(OP_I32_SHL);
      pushValueAs(em, dcRef, I32); em.i32Const(0x3FF); em.op(OP_I32_AND); em.i32Const(10); em.op(OP_I32_SHL); em.op(OP_I32_OR);
      pushValueAs(em, dlRef, I32); em.i32Const(0x3FF); em.op(OP_I32_AND); em.op(OP_I32_OR);
      return storeResult(em, I32);
    }
    // (dr & 0xFFFF) << 16
    pushValueAs(em, drRef, I32);
    em.i32Const(0xFFFF); em.op(OP_I32_AND);
    em.i32Const(16); em.op(OP_I32_SHL);
    // | (dc & 0xFFFF)
    pushValueAs(em, dcRef, I32);
    em.i32Const(0xFFFF); em.op(OP_I32_AND);
    em.op(OP_I32_OR);
    return storeResult(em, I32);
  },
  // neighborIndexFromTag: pre-pass resolves to a packed i32 stored in
  // _resolvedPacked. Emit a constant.
  neighborIndexFromTag: ({ node, ctx }) => {
    const packed = node.data.config._resolvedPacked !== undefined
      ? Number(node.data.config._resolvedPacked) | 0
      : INVALID_NI;
    ctx.emitter.i32Const(packed);
    return storeResult(ctx.emitter, I32);
  },

  // Wave A.6: break a packed NI into its (dr, dc) components — multi-output.
  // Stores both port refs via setCachedPort so downstream nodes see them under
  // the `_v<id>_dr` / `_v<id>_dc` convention. The default 'value' port resolves
  // to dr (parity with other multi-output nodes that return the "primary" out).
  breakDownNeighborIndex: ({ node, ctx, inputs }) => {
    const idxRef = inputs['index'] ?? { inline: true, value: 0, valtype: I32 };
    const em = ctx.emitter;
    const inLocal = em.allocLocal(I32);
    pushValueAs(em, idxRef, I32);
    em.localSet(inLocal);
    const is3d = ctx.layerLocalIdx >= 0;
    const drLocal = em.allocLocal(I32);
    const dcLocal = em.allocLocal(I32);
    if (is3d) {
      // 3D: dr = (ni << 2) >> 22; dc = (ni << 12) >> 22; dl = (ni << 22) >> 22.
      em.localGet(inLocal); em.i32Const(2); em.op(OP_I32_SHL); em.i32Const(22); em.op(OP_I32_SHR_S);
      em.localSet(drLocal);
      em.localGet(inLocal); em.i32Const(12); em.op(OP_I32_SHL); em.i32Const(22); em.op(OP_I32_SHR_S);
      em.localSet(dcLocal);
      const dlLocal = em.allocLocal(I32);
      em.localGet(inLocal); em.i32Const(22); em.op(OP_I32_SHL); em.i32Const(22); em.op(OP_I32_SHR_S);
      em.localSet(dlLocal);
      setCachedPort(ctx, node.id, 'dl', { localIdx: dlLocal, valtype: I32 });
    } else {
      // dr = ni >> 16 (arithmetic right-shift — sign-extends)
      em.localGet(inLocal); em.i32Const(16); em.op(OP_I32_SHR_S);
      em.localSet(drLocal);
      // dc = (ni << 16) >> 16 (shl16 then arithmetic shr16 — sign-extends low 16)
      em.localGet(inLocal); em.i32Const(16); em.op(OP_I32_SHL); em.i32Const(16); em.op(OP_I32_SHR_S);
      em.localSet(dcLocal);
    }
    const drRef: LocalRef = { localIdx: drLocal, valtype: I32 };
    const dcRef: LocalRef = { localIdx: dcLocal, valtype: I32 };
    setCachedPort(ctx, node.id, 'dr', drRef);
    setCachedPort(ctx, node.id, 'dc', dcRef);
    // Default 'value' port also resolves to dr (matches other multi-output emitters).
    return drRef;
  },

  // Wave A.6: flip a NeighborIndex by decoding (dr, dc), conditionally negating,
  // and re-encoding. No neighborhood needed.
  flipNeighborIndex: ({ node, ctx, inputs }) => {
    const mode = (node.data.config.mode as string) || 'horizontal';
    const flipDr = mode === 'vertical' || mode === 'both';
    const flipDc = mode === 'horizontal' || mode === 'both';
    const idxRef = inputs['index'] ?? { inline: true, value: 0, valtype: I32 };
    const em = ctx.emitter;
    const inLocal = em.allocLocal(I32);
    pushValueAs(em, idxRef, I32);
    em.localSet(inLocal);
    if (ctx.layerLocalIdx >= 0) {
      // 3D: decode 10-bit dr/dc/dl, negate dr/dc as configured, dl passes through.
      const drLocal = em.allocLocal(I32);
      em.localGet(inLocal); em.i32Const(2); em.op(OP_I32_SHL); em.i32Const(22); em.op(OP_I32_SHR_S);
      em.localSet(drLocal);
      const dcLocal = em.allocLocal(I32);
      em.localGet(inLocal); em.i32Const(12); em.op(OP_I32_SHL); em.i32Const(22); em.op(OP_I32_SHR_S);
      em.localSet(dcLocal);
      // (flippedDr & 0x3FF) << 20
      if (flipDr) { em.i32Const(0); em.localGet(drLocal); em.op(OP_I32_SUB); } else { em.localGet(drLocal); }
      em.i32Const(0x3FF); em.op(OP_I32_AND); em.i32Const(20); em.op(OP_I32_SHL);
      // | (flippedDc & 0x3FF) << 10
      if (flipDc) { em.i32Const(0); em.localGet(dcLocal); em.op(OP_I32_SUB); } else { em.localGet(dcLocal); }
      em.i32Const(0x3FF); em.op(OP_I32_AND); em.i32Const(10); em.op(OP_I32_SHL); em.op(OP_I32_OR);
      // | (dl & 0x3FF) — dl unchanged: (ni << 22) >> 22, masked
      em.localGet(inLocal); em.i32Const(22); em.op(OP_I32_SHL); em.i32Const(22); em.op(OP_I32_SHR_S);
      em.i32Const(0x3FF); em.op(OP_I32_AND); em.op(OP_I32_OR);
      return storeResult(em, I32);
    }
    // Decode dr/dc into locals
    const drLocal = em.allocLocal(I32);
    em.localGet(inLocal); em.i32Const(16); em.op(OP_I32_SHR_S);
    em.localSet(drLocal);
    const dcLocal = em.allocLocal(I32);
    em.localGet(inLocal); em.i32Const(16); em.op(OP_I32_SHL); em.i32Const(16); em.op(OP_I32_SHR_S);
    em.localSet(dcLocal);
    // Push (flippedDr & 0xFFFF) << 16
    if (flipDr) { em.i32Const(0); em.localGet(drLocal); em.op(OP_I32_SUB); }
    else { em.localGet(drLocal); }
    em.i32Const(0xFFFF); em.op(OP_I32_AND);
    em.i32Const(16); em.op(OP_I32_SHL);
    // | (flippedDc & 0xFFFF)
    if (flipDc) { em.i32Const(0); em.localGet(dcLocal); em.op(OP_I32_SUB); }
    else { em.localGet(dcLocal); }
    em.i32Const(0xFFFF); em.op(OP_I32_AND);
    em.op(OP_I32_OR);
    return storeResult(em, I32);
  },

  // Wave A.5: array length — return inArr.lenLocal as i32.
  arrayLength: ({ node, ctx }) => {
    const inArr = resolveInputArray(ctx, node, 'array');
    if (!inArr) {
      ctx.errors.push(`arrayLength: input "array" must come from an array-producing node`);
      return null;
    }
    ctx.emitter.localGet(inArr.lenLocal);
    return storeResult(ctx.emitter, I32);
  },

  // Wave A.6: bounds-checked indexed access into an array. Out-of-range
  // default depends on element kind:
  //   - NI[] sources → INVALID_NI (the "no neighbor" sentinel)
  //   - value[] / position[] sources → 0 (or 0.0 for f64 elements)
  // Detected via the source nodeType — a WASM int[] from getNeighborsAttribute
  // and an NI[] from filterNeighbors share the same elemValtype, so
  // elemValtype alone can't distinguish them.
  arrayElement: ({ node, ctx, inputs }) => {
    const inArr = resolveInputArray(ctx, node, 'array');
    if (!inArr) {
      ctx.errors.push(`arrayElement: input "array" must come from an array-producing node`);
      return null;
    }
    const posRef = inputs['position'] ?? { inline: true, value: 0, valtype: I32 };
    const em = ctx.emitter;

    const idxLocal = em.allocLocal(I32);
    pushValueAs(em, posRef, I32);
    em.localSet(idxLocal);

    const arraySrc = ctx.inputToSource.get(`${node.id}:array`);
    const srcNode = arraySrc ? ctx.nodeMap.get(arraySrc.nodeId) : undefined;
    const isNiArray = !!(srcNode && NI_ARRAY_PRODUCERS.has(srcNode.data.nodeType));

    const result = em.allocLocal(inArr.elemValtype);
    if (inArr.elemValtype === F64) { em.f64Const(0); }
    else { em.i32Const(isNiArray ? INVALID_NI : 0); }
    em.localSet(result);

    // if (idx >= 0 && idx < len) result = arr[idx]
    em.localGet(idxLocal); em.i32Const(0); em.op(OP_I32_GE_S);
    em.localGet(idxLocal); em.localGet(inArr.lenLocal); em.op(OP_I32_LT_S);
    em.op(OP_I32_AND);
    em.ifThen(() => {
      em.localGet(idxLocal);
      emitArrayLoadElem(em, inArr);
      em.localSet(result);
    });
    em.localGet(result);
    return storeResult(em, inArr.elemValtype);
  },

  // Wave A PR2: pick a random element from a NeighborIndex array. Mirrors
  // GetRandomNode's xorshift32 advance + stores _rs back to memory so
  // subsequent RNG draws stay in lockstep with the JS stream. Returns -1
  // when the input array is empty.
  pickRandomNeighbor: ({ node, ctx }) => {
    const inArr = resolveInputArray(ctx, node, 'indexes');
    if (!inArr) {
      ctx.errors.push(`pickRandomNeighbor: input "indexes" must come from an array-producing node (filterNeighbors / getNeighborIndexesByTags / joinNeighbors)`);
      return null;
    }
    const em = ctx.emitter;
    // Advance _rs (xorshift32) — same constants as GetRandomNode
    const rsLocal = em.allocLocal(I32);
    em.i32Const(0);
    em.i32Load(ctx.layout.rngStateOffset, 2);
    em.localSet(rsLocal);
    // _rs ^= _rs << 13
    em.localGet(rsLocal); em.localGet(rsLocal); em.i32Const(13);
    em.op(byte(0x74)); em.op(byte(0x73)); em.localSet(rsLocal);
    // _rs ^= _rs >>> 17
    em.localGet(rsLocal); em.localGet(rsLocal); em.i32Const(17);
    em.op(byte(0x76)); em.op(byte(0x73)); em.localSet(rsLocal);
    // _rs ^= _rs << 5
    em.localGet(rsLocal); em.localGet(rsLocal); em.i32Const(5);
    em.op(byte(0x74)); em.op(byte(0x73)); em.localSet(rsLocal);
    // Store back to memory
    em.i32Const(0); em.localGet(rsLocal); em.i32Store(ctx.layout.rngStateOffset, 2);

    const result = em.allocLocal(I32);
    em.i32Const(INVALID_NI); em.localSet(result);
    // if (len > 0) result = arr[floor((rs / 2^32) * len)]
    em.localGet(inArr.lenLocal);
    em.i32Const(0);
    em.op(byte(0x4b)); // OP_I32_GT_U
    em.ifThen(() => {
      // floor(rs_u32 / 2^32 * len_s32) -> i32
      em.localGet(rsLocal);
      em.op(OP_F64_CONVERT_I32_U);
      em.f64Const(4294967296);
      em.op(OP_F64_DIV);
      em.localGet(inArr.lenLocal);
      em.i32ToF64();
      em.op(OP_F64_MUL);
      em.f64ToI32();
      // address = arr.offset + idx * 4
      em.i32Const(4); em.op(OP_I32_MUL);
      em.localGet(inArr.offsetLocal); em.op(OP_I32_ADD);
      em.i32Load(0, 2);
      em.localSet(result);
    });
    em.localGet(result);
    return storeResult(em, I32);
  },

  getCellAttribute: ({ node, ctx }) => {
    const attrId = node.data.config.attributeId as string;
    const attr = getAttr(ctx.layout, attrId);
    if (!attr) { ctx.errors.push(`getCellAttribute: unknown attr ${attrId}`); return null; }
    // JS compiler reads from r_attr — i.e. read buffer (current generation).
    emitCellRead(ctx, attr, /* useWriteBuffer */ false);
    return storeResult(ctx.emitter, attrValType(attr.type));
  },

  // Get Cell Position — expose the per-cell row/col/layer locals (decoded in
  // emitBody) as multi-output ports. Zero-cost: cache the EXISTING locals (no
  // copy). layer only exists in 3D (layerLocalIdx >= 0).
  getCellPosition: ({ node, ctx }) => {
    const rowRef: LocalRef = { localIdx: ctx.rowLocalIdx, valtype: I32 };
    setCachedPort(ctx, node.id, 'row', rowRef);
    setCachedPort(ctx, node.id, 'col', { localIdx: ctx.colLocalIdx, valtype: I32 });
    if (ctx.layerLocalIdx >= 0) setCachedPort(ctx, node.id, 'layer', { localIdx: ctx.layerLocalIdx, valtype: I32 });
    return rowRef;  // default 'value' port → row (parity with other multi-output emitters)
  },

  // Get Grid Dimensions — the world size (width / height / depth). Compile-time
  // constants baked from the model the compiler was handed (the SIMULATOR passes a
  // `dimsModel` with the live dimensions after a Resize, so these track the real
  // grid — never the stale saved ones). Depth is 1 in a 2D model. Pure + input-free
  // ⇒ loop-invariant, so this lands in the pre-loop preamble.
  getGridDimensions: ({ node, ctx }) => {
    const p = ctx.model.properties;
    const D = p.dimension === '3d' ? Math.max(1, p.gridDepth ?? 1) : 1;
    const konst = (v: number): LocalRef => {
      const l = ctx.emitter.allocLocal(I32);
      ctx.emitter.i32Const(v);
      ctx.emitter.localSet(l);
      return { localIdx: l, valtype: I32 };
    };
    const wRef = konst(p.gridWidth);
    setCachedPort(ctx, node.id, 'width', wRef);
    setCachedPort(ctx, node.id, 'height', konst(p.gridHeight));
    setCachedPort(ctx, node.id, 'depth', konst(D));
    // Grid centre (⌊size/2⌋ per axis) — baked like the dims; emitted regardless
    // of the `withCenter` UI checkbox so a wire into a centre port never dangles.
    setCachedPort(ctx, node.id, 'centerX', konst(Math.floor(p.gridWidth / 2)));
    setCachedPort(ctx, node.id, 'centerY', konst(Math.floor(p.gridHeight / 2)));
    setCachedPort(ctx, node.id, 'centerZ', konst(Math.floor(D / 2)));
    return wRef;  // default 'value' port → width
  },

  // Get Generation — an i32 read of the memory cell the worker refreshes
  // whenever the generation counter moves (layout.generationOffset, appended at
  // the very END of the layout so every other baked offset is untouched). No
  // signature change on ANY entry point; a model that never places the node
  // emits no load at all, so its module stays byte-identical.
  getGeneration: ({ ctx }) => {
    ctx.emitter.i32Const(0);
    ctx.emitter.i32Load(ctx.layout.generationOffset, 2);
    return storeResult(ctx.emitter, I32);
  },

  getModelAttribute: ({ node, ctx }) => {
    const attrId = node.data.config.attributeId as string;
    const isColor = !!node.data.config.isColorAttr;
    if (isColor) {
      // Four-way emit: load r, g, b, a from modelAttrOffset[id+'_r'/'_g'/'_b'/'_a'].
      // A colour model attr ALWAYS occupies four slots (`modelAttrSlotKeys`), so
      // alpha is not gated here the way the palette nodes' is.
      const offs = ['r', 'g', 'b', 'a'].map(ch => ctx.layout.modelAttrOffset[attrId + '_' + ch]);
      if (offs.some(o => o === undefined)) {
        ctx.errors.push(`getModelAttribute color: unknown ${attrId}`); return null;
      }
      // Emit four i32 locals — model attrs are stored as f64 so we truncate.
      const emitCh = (off: number) => {
        ctx.emitter.i32Const(0);
        ctx.emitter.f64Load(off, 3);
        ctx.emitter.f64ToI32();
        return storeResult(ctx.emitter, I32);
      };
      const refs = offs.map(o => emitCh(o!));
      ['r', 'g', 'b', 'a'].forEach((p, i) => setCachedPort(ctx, node.id, p, refs[i]!));
      // Default 'value' port also resolves to r (matches JS where it's just multi-output).
      return refs[0]!;
    }
    const slotOff = ctx.layout.modelAttrOffset[attrId];
    if (slotOff === undefined) { ctx.errors.push(`getModelAttribute: unknown ${attrId}`); return null; }
    // Model attr region is f64 by convention.
    ctx.emitter.i32Const(0);
    ctx.emitter.f64Load(slotOff, 3);
    return storeResult(ctx.emitter, F64);
  },

  getNeighborsAttribute: ({ node, ctx }) => {
    // Pseudo-value: this node "produces" an array. In WASM we can't return a JS array.
    // Instead we expose it as a virtual reference: { localIdx: 0, valtype: I32 } where
    // the localIdx is a SENTINEL we never load. Downstream nodes that consume it
    // (groupCounting, aggregate) need to know to RE-LOOP over the neighbor table
    // themselves rather than reading a value. We handle this by having those
    // consumer emitters look at the input source node's type and if it's
    // getNeighborsAttribute, re-derive the neighborhood + attribute from its config.
    //
    // To keep the recursive resolver happy, return a placeholder LocalRef with
    // a sentinel localIdx (the consumer never .localGet()s it).
    const nbrId = node.data.config.neighborhoodId as string;
    const attrId = node.data.config.attributeId as string;
    const nbr = getNbr(ctx.layout, nbrId);
    const attr = getAttr(ctx.layout, attrId);
    if (!nbr || !attr) { ctx.errors.push(`getNeighborsAttribute: unknown nbr/attr ${nbrId}/${attrId}`); return null; }
    // Return a phantom — consumer will re-derive.
    return { localIdx: -1, valtype: attrValType(attr.type) };
  },

  // -- Arithmetic (matches ArithmeticOperatorNode: x/y inputs, ops +/-/*/​%/sqrt/pow/abs/max/min/mean) --
  arithmeticOperator: ({ node, ctx, inputs }) => {
    const op = (node.data.config.operation as string) || '+';
    const x = inputs['x'] ?? { inline: true, value: 0, valtype: F64 };
    const y = inputs['y'] ?? { inline: true, value: 0, valtype: F64 };
    // All arithmetic computed in f64 to match JS Number semantics.
    const em = ctx.emitter;
    switch (op) {
      case '+':
        pushValueAs(em, x, F64);
        pushValueAs(em, y, F64);
        em.op(OP_F64_ADD);
        break;
      case '-':
        pushValueAs(em, x, F64);
        pushValueAs(em, y, F64);
        em.op(OP_F64_SUB);
        break;
      case '*':
        pushValueAs(em, x, F64);
        pushValueAs(em, y, F64);
        em.op(OP_F64_MUL);
        break;
      case '/': {
        // y !== 0 ? x / y : 0   — compiled as if/else returning f64
        const yLoc = em.allocLocal(F64);
        pushValueAs(em, y, F64);
        em.localSet(yLoc);
        const resLoc = em.allocLocal(F64);
        em.localGet(yLoc);
        em.f64Const(0);
        em.op(OP_F64_NE);
        em.ifThenElse(
          () => {
            pushValueAs(em, x, F64);
            em.localGet(yLoc);
            em.op(OP_F64_DIV);
            em.localSet(resLoc);
          },
          () => {
            em.f64Const(0);
            em.localSet(resLoc);
          },
        );
        em.localGet(resLoc);
        break;
      }
      case '%': {
        // y !== 0 ? x - trunc(x/y)*y : 0
        const xLoc = em.allocLocal(F64);
        const yLoc = em.allocLocal(F64);
        pushValueAs(em, x, F64);
        em.localSet(xLoc);
        pushValueAs(em, y, F64);
        em.localSet(yLoc);
        const resLoc = em.allocLocal(F64);
        em.localGet(yLoc);
        em.f64Const(0);
        em.op(OP_F64_NE);
        em.ifThenElse(
          () => {
            // x - trunc(x/y) * y  using f64 trunc
            em.localGet(xLoc);
            em.localGet(xLoc);
            em.localGet(yLoc);
            em.op(OP_F64_DIV);
            em.emit(byte(0x9d)); // OP_F64_TRUNC (rounds toward zero)
            em.localGet(yLoc);
            em.op(OP_F64_MUL);
            em.op(OP_F64_SUB);
            em.localSet(resLoc);
          },
          () => {
            em.f64Const(0);
            em.localSet(resLoc);
          },
        );
        em.localGet(resLoc);
        break;
      }
      case 'max':
        pushValueAs(em, x, F64);
        pushValueAs(em, y, F64);
        em.op(OP_F64_MAX);
        break;
      case 'min':
        pushValueAs(em, x, F64);
        pushValueAs(em, y, F64);
        em.op(OP_F64_MIN);
        break;
      case 'mean':
        pushValueAs(em, x, F64);
        pushValueAs(em, y, F64);
        em.op(OP_F64_ADD);
        em.f64Const(2);
        em.op(OP_F64_DIV);
        break;
      case 'sqrt':
        pushValueAs(em, x, F64);
        em.op(OP_F64_SQRT);
        break;
      case 'abs':
        pushValueAs(em, x, F64);
        em.op(OP_F64_ABS);
        break;
      case 'negate':
        // f64.neg — an IEEE sign flip, bit-identical to JS `-x` / WGSL `-x`.
        pushValueAs(em, x, F64);
        em.op(OP_F64_NEG);
        break;
      case 'floor':
        pushValueAs(em, x, F64);
        em.op(OP_F64_FLOOR);
        break;
      case 'ceil':
        pushValueAs(em, x, F64);
        em.op(OP_F64_CEIL);
        break;
      case 'round':
        // floor(x + 0.5) — matches JS/WGSL. NOT native f64.nearest (banker's
        // rounding), which would diverge from the other targets on .5 cases.
        pushValueAs(em, x, F64);
        em.f64Const(0.5);
        em.op(OP_F64_ADD);
        em.op(OP_F64_FLOOR);
        break;
      case 'pow':
        // imported Math.pow at funcIdx 0
        pushValueAs(em, x, F64);
        pushValueAs(em, y, F64);
        em.emit(byte(0x10), leb128u(POW_FUNC_IDX)); // call POW_FUNC_IDX
        break;
      // Unary transcendentals: imported host functions (no native WASM opcode).
      case 'exp':  pushValueAs(em, x, F64); em.emit(byte(0x10), leb128u(EXP_FUNC_IDX));  break;
      case 'log':  pushValueAs(em, x, F64); em.emit(byte(0x10), leb128u(LOG_FUNC_IDX));  break;
      case 'sin':  pushValueAs(em, x, F64); em.emit(byte(0x10), leb128u(SIN_FUNC_IDX));  break;
      case 'cos':  pushValueAs(em, x, F64); em.emit(byte(0x10), leb128u(COS_FUNC_IDX));  break;
      case 'tan':  pushValueAs(em, x, F64); em.emit(byte(0x10), leb128u(TAN_FUNC_IDX));  break;
      case 'tanh': pushValueAs(em, x, F64); em.emit(byte(0x10), leb128u(TANH_FUNC_IDX)); break;
      default:
        ctx.errors.push(`arithmeticOperator: unsupported op ${op}`);
        return null;
    }
    return storeResult(em, F64);
  },

  // -- Expression (ExpressionNode: parse the formula string, emit the AST) --
  expression: ({ node, ctx, inputs }) => {
    const visibleCount = clampVisibleCount(node.data.config.visibleCount);
    const { map, errors } = buildVarMap(node.data.config, visibleCount);
    if (errors.length > 0) { ctx.errors.push(`expression: ${errors[0]}`); return null; }
    const res = parseExpression(String(node.data.config.expression ?? ''), map);
    if ('error' in res) { ctx.errors.push(`expression: ${res.error}`); return null; }
    return emitWasm(res.ast, ctx.emitter, inputs);
  },

  // -- Comparison (StatementNode "Compare": x, y, y2 inputs, ops ==/!=/</>/<=/>=/between/notBetween) --
  statement: ({ node, ctx, inputs }) => {
    const op = (node.data.config.operation as string) || '==';
    const x = inputs['x'] ?? { inline: true, value: 0, valtype: F64 };
    const y = inputs['y'] ?? { inline: true, value: 0, valtype: F64 };
    if (op === 'between' || op === 'notBetween') {
      const y2 = inputs['y2'] ?? { inline: true, value: 0, valtype: F64 };
      const lowOp = (node.data.config.lowOp as string) === '>' ? '>' : '>=';
      const highOp = (node.data.config.highOp as string) === '<' ? '<' : '<=';
      // (x lowOp y) AND (x highOp y2)
      pushValueAs(ctx.emitter, x, F64);
      pushValueAs(ctx.emitter, y, F64);
      ctx.emitter.op(lowOp === '>' ? OP_F64_GT : OP_F64_GE);
      pushValueAs(ctx.emitter, x, F64);
      pushValueAs(ctx.emitter, y2, F64);
      ctx.emitter.op(highOp === '<' ? OP_F64_LT : OP_F64_LE);
      ctx.emitter.op(OP_I32_AND);
      if (op === 'notBetween') {
        ctx.emitter.op(OP_I32_EQZ);
      }
      return storeResult(ctx.emitter, I32);
    }
    pushValueAs(ctx.emitter, x, F64);
    pushValueAs(ctx.emitter, y, F64);
    switch (op) {
      case '==': case '===': ctx.emitter.op(OP_F64_EQ); break;
      case '!=': case '!==': ctx.emitter.op(OP_F64_NE); break;
      case '<':  ctx.emitter.op(OP_F64_LT); break;
      case '<=': ctx.emitter.op(OP_F64_LE); break;
      case '>':  ctx.emitter.op(OP_F64_GT); break;
      case '>=': ctx.emitter.op(OP_F64_GE); break;
      default:
        ctx.errors.push(`statement (compare): unsupported op ${op}`);
        return null;
    }
    return storeResult(ctx.emitter, I32);
  },

  // -- Logic (LogicOperatorNode: AND/OR/XOR/NOT) --
  logicOperator: ({ node, ctx, inputs }) => {
    const op = (node.data.config.operation as string) || 'OR';
    const a = inputs['a'] ?? { inline: true, value: 0, valtype: I32 };
    if (op === 'NOT') {
      pushValueAs(ctx.emitter, a, I32);
      ctx.emitter.op(OP_I32_EQZ); // 0 -> 1, non-0 -> 0
      return storeResult(ctx.emitter, I32);
    }
    const b = inputs['b'] ?? { inline: true, value: 0, valtype: I32 };
    if (op === 'XOR') {
      // Normalise both to 0/1 then XOR. (a != 0) ^ (b != 0)
      pushValueAs(ctx.emitter, a, I32);
      ctx.emitter.i32Const(0);
      ctx.emitter.op(OP_I32_NE_OP);
      pushValueAs(ctx.emitter, b, I32);
      ctx.emitter.i32Const(0);
      ctx.emitter.op(OP_I32_NE_OP);
      ctx.emitter.emit(byte(0x73)); // OP_I32_XOR
      return storeResult(ctx.emitter, I32);
    }
    // Normalise BOTH operands to 0/1 before the bitwise op (mirrors the XOR path
    // above). Without this, a non-0/1 'any' source — which the editor's port
    // rules permit into this bool input — would give a raw bitwise result that
    // disagrees with JS (`a && b`) and WebGPU (`castTo bool`): e.g. a=1,b=4 AND
    // → `1 & 4` = 0 (false) on WASM vs truthy on JS/WebGPU. (a != 0) &/| (b != 0)
    // yields 1/0 and matches the other two targets for all inputs.
    pushValueAs(ctx.emitter, a, I32);
    ctx.emitter.i32Const(0);
    ctx.emitter.op(OP_I32_NE_OP);
    pushValueAs(ctx.emitter, b, I32);
    ctx.emitter.i32Const(0);
    ctx.emitter.op(OP_I32_NE_OP);
    switch (op) {
      case 'AND': ctx.emitter.op(OP_I32_AND); break;
      case 'OR':  ctx.emitter.op(OP_I32_OR); break;
      default:
        ctx.errors.push(`logicOperator: unsupported op ${op}`);
        return null;
    }
    return storeResult(ctx.emitter, I32);
  },

  // -- Aggregate over neighbors --
  // Special path: when input is a getNeighborsAttribute, loop over the neighbor table.
  // When input is a literal "array" (multi-source on isArray port), treat each source
  // as a separate value and combine.
  aggregate: ({ node, ctx, inputs }) => {
    return emitAggregateOrCount(ctx, node, inputs, 'aggregate');
  },

  groupCounting: ({ node, ctx, inputs }) => {
    return emitAggregateOrCount(ctx, node, inputs, 'count');
  },

  // Wave A.7: filterNeighbors is multi-output (result array + scalar count).
  // The array emitter caches both — calling compileArrayNode here triggers
  // the emit (or hits the cache if already run) and the count port appears in
  // ctx.valueLocals. Then return the cached count LocalRef.
  filterNeighbors: ({ node, ctx }) => {
    const arr = compileArrayNode(node.id, ctx);
    if (!arr) return null;
    const cached = getCachedPort(ctx, node.id, 'count');
    if (cached) return cached;
    // Fallback: re-cache directly from the ArrayRef's lenLocal if the array
    // emitter didn't (defensive — current emitter always caches, see line ~2545).
    const ref: LocalRef = { localIdx: arr.lenLocal, valtype: I32 };
    setCachedPort(ctx, node.id, 'count', ref);
    return ref;
  },

  // joinNeighbors mirrors filterNeighbors: array emit fills `result` and caches
  // `count`; this value-emitter entry lets scalar consumers reach the count.
  joinNeighbors: ({ node, ctx }) => {
    const arr = compileArrayNode(node.id, ctx);
    if (!arr) return null;
    const cached = getCachedPort(ctx, node.id, 'count');
    if (cached) return cached;
    const ref: LocalRef = { localIdx: arr.lenLocal, valtype: I32 };
    setCachedPort(ctx, node.id, 'count', ref);
    return ref;
  },

  // -- Random (xorshift32, similar to JS GetRandomNode) --
  getRandom: ({ node, ctx, inputs }) => {
    const cfg = node.data.config as unknown as Record<string, unknown>;
    const t = (node.data.config.randomType as string) || 'float';
    const dist = randomDistribution(cfg, t);
    // Min / Max are PORTS now. Unwired ⇒ an InlineRef carrying the widget value,
    // which keeps the historical COMPILE-TIME fold (`f64Const(max - min)`) and
    // therefore the byte-identical module; a WIRED port takes the runtime path.
    const minRef = inputs['min'] ?? ({ inline: true, value: 0, valtype: F64 } as ValueRef);
    const maxRef = inputs['max'] ?? ({ inline: true, value: 1, valtype: F64 } as ValueRef);
    const minN = isInline(minRef) ? minRef.value : 0;
    const maxN = isInline(maxRef) ? maxRef.value : 1;
    const rangeConst = isInline(minRef) && isInline(maxRef);

    /** Load → advance → store the shared xorshift32 state, leaving the uniform
     *  [0, 1) f64 on the stack. Called ONCE for every mode except the normal
     *  distribution's Box-Muller pair (exactly two calls — never a loop). */
    const drawUniform = (): void => {
      // Load _rs from memory[rngStateOffset] (uint32)
      const rsLocal = ctx.emitter.allocLocal(I32);
      ctx.emitter.i32Const(0);
      ctx.emitter.i32Load(ctx.layout.rngStateOffset, 2);
      ctx.emitter.localSet(rsLocal);

      // Advance: _rs = (_rs ^ (_rs << 13)) >>> 0; etc.
      // Step 1: _rs ^= _rs << 13
      ctx.emitter.localGet(rsLocal);
      ctx.emitter.localGet(rsLocal);
      ctx.emitter.i32Const(13);
      ctx.emitter.emit(byte(0x74)); // OP_I32_SHL
      ctx.emitter.emit(byte(0x73)); // OP_I32_XOR
      ctx.emitter.localSet(rsLocal);
      // Step 2: _rs ^= _rs >>> 17
      ctx.emitter.localGet(rsLocal);
      ctx.emitter.localGet(rsLocal);
      ctx.emitter.i32Const(17);
      ctx.emitter.emit(byte(0x76)); // OP_I32_SHR_U
      ctx.emitter.emit(byte(0x73)); // OP_I32_XOR
      ctx.emitter.localSet(rsLocal);
      // Step 3: _rs ^= _rs << 5
      ctx.emitter.localGet(rsLocal);
      ctx.emitter.localGet(rsLocal);
      ctx.emitter.i32Const(5);
      ctx.emitter.emit(byte(0x74)); // OP_I32_SHL
      ctx.emitter.emit(byte(0x73)); // OP_I32_XOR
      ctx.emitter.localSet(rsLocal);
      // Store back to memory
      ctx.emitter.i32Const(0);
      ctx.emitter.localGet(rsLocal);
      ctx.emitter.i32Store(ctx.layout.rngStateOffset, 2);

      // Compute float value: (_rs >>> 0) / 2^32. Use unsigned f64.convert_i32_u.
      ctx.emitter.localGet(rsLocal);
      ctx.emitter.op(OP_F64_CONVERT_I32_U);
      ctx.emitter.f64Const(4294967296);
      ctx.emitter.op(OP_F64_DIV);
    };
    drawUniform();
    // Now stack has uniform [0, 1) float

    if (t === 'vector') {
      // ONE draw → an angular offset uniform in ±Span°/2, applied as a
      // screen-clockwise ROTATION of the reference unit vector. Rotating (rather
      // than adding to a computed reference ANGLE) is what keeps the wired-
      // direction path free of atan2, which this module does not import.
      const em = ctx.emitter;
      const uL = em.allocLocal(F64); em.localSet(uL);
      const push = (portId: string, dflt: number): void =>
        pushValueAs(em, inputs[portId] ?? ({ inline: true, value: dflt, valtype: F64 } as ValueRef), F64);
      // phi = (u - 0.5) * span * DEG2RAD
      const phiL = em.allocLocal(F64);
      em.localGet(uL); em.f64Const(0.5); em.op(OP_F64_SUB);
      push('span', 360); em.op(OP_F64_MUL);
      em.f64Const(RANDOM_DEG2RAD); em.op(OP_F64_MUL);
      em.localSet(phiL);
      const cL = em.allocLocal(F64);
      em.localGet(phiL); em.emit(byte(0x10), leb128u(COS_FUNC_IDX)); em.localSet(cL);
      const sL = em.allocLocal(F64);
      em.localGet(phiL); em.emit(byte(0x10), leb128u(SIN_FUNC_IDX)); em.localSet(sL);
      // Reference unit vector.
      const fxL = em.allocLocal(F64), fyL = em.allocLocal(F64);
      if (randomRefSource(cfg) === 'vector') {
        const dxL = em.allocLocal(F64), dyL = em.allocLocal(F64);
        push('dirX', 0); em.localSet(dxL);
        push('dirY', -1); em.localSet(dyL);
        const lenL = em.allocLocal(F64);
        em.localGet(dxL); em.localGet(dxL); em.op(OP_F64_MUL);
        em.localGet(dyL); em.localGet(dyL); em.op(OP_F64_MUL); em.op(OP_F64_ADD);
        em.op(OP_F64_SQRT); em.localSet(lenL);
        // inv = 1 / max(len, eps) — the eps guard makes a zero direction give
        // (0, 0) rather than NaN, so the north fallback is a single select.
        const invL = em.allocLocal(F64);
        em.f64Const(1);
        em.localGet(lenL); em.f64Const(RANDOM_LEN_EPS); em.op(OP_F64_MAX);
        em.op(OP_F64_DIV); em.localSet(invL);
        em.localGet(dxL); em.localGet(invL); em.op(OP_F64_MUL); em.localSet(fxL);
        // fy = len > 0 ? dy * inv : -1
        em.localGet(dyL); em.localGet(invL); em.op(OP_F64_MUL);
        em.f64Const(-1);
        em.localGet(lenL); em.f64Const(0); em.op(OP_F64_GT);
        em.op(OP_SELECT); em.localSet(fyL);
      } else {
        const aL = em.allocLocal(F64);
        push('angle', 0); em.f64Const(RANDOM_DEG2RAD); em.op(OP_F64_MUL); em.localSet(aL);
        em.localGet(aL); em.emit(byte(0x10), leb128u(SIN_FUNC_IDX)); em.localSet(fxL);
        em.localGet(aL); em.emit(byte(0x10), leb128u(COS_FUNC_IDX)); em.op(OP_F64_NEG); em.localSet(fyL);
      }
      // x = norm * (fx*c - fy*s);  y = norm * (fx*s + fy*c)
      const xL = em.allocLocal(F64), yL = em.allocLocal(F64);
      push('norm', 1);
      em.localGet(fxL); em.localGet(cL); em.op(OP_F64_MUL);
      em.localGet(fyL); em.localGet(sL); em.op(OP_F64_MUL); em.op(OP_F64_SUB);
      em.op(OP_F64_MUL); em.localSet(xL);
      push('norm', 1);
      em.localGet(fxL); em.localGet(sL); em.op(OP_F64_MUL);
      em.localGet(fyL); em.localGet(cL); em.op(OP_F64_MUL); em.op(OP_F64_ADD);
      em.op(OP_F64_MUL); em.localSet(yL);
      const xRef: LocalRef = { localIdx: xL, valtype: F64 };
      setCachedPort(ctx, node.id, 'x', xRef);
      setCachedPort(ctx, node.id, 'y', { localIdx: yL, valtype: F64 });
      return xRef; // default port → x (parity with the other multi-output emitters)
    }

    if (t === 'float' && dist === 'normal') {
      // Box-Muller — EXACTLY two draws. `1 - u` keeps log's argument in (0, 1].
      const em = ctx.emitter;
      const u1L = em.allocLocal(F64); em.localSet(u1L);
      drawUniform();
      const u2L = em.allocLocal(F64); em.localSet(u2L);
      // z = sqrt(-2 * log(1 - u1)) * cos(TAU * u2)
      em.f64Const(-2);
      em.f64Const(1); em.localGet(u1L); em.op(OP_F64_SUB);
      em.emit(byte(0x10), leb128u(LOG_FUNC_IDX));
      em.op(OP_F64_MUL); em.op(OP_F64_SQRT);
      em.f64Const(RANDOM_TAU); em.localGet(u2L); em.op(OP_F64_MUL);
      em.emit(byte(0x10), leb128u(COS_FUNC_IDX));
      em.op(OP_F64_MUL);
      const zL = em.allocLocal(F64); em.localSet(zL);
      // mean + stddev * z
      pushValueAs(em, inputs['mean'] ?? ({ inline: true, value: 0, valtype: F64 } as ValueRef), F64);
      pushValueAs(em, inputs['stddev'] ?? ({ inline: true, value: 1, valtype: F64 } as ValueRef), F64);
      em.localGet(zL); em.op(OP_F64_MUL); em.op(OP_F64_ADD);
      return storeResult(em, F64);
    }

    if (t === 'float' && dist === 'exponential') {
      // Inverse-CDF, ONE draw: mean * -ln(1 - u). No divide ⇒ no ÷0 guard.
      const em = ctx.emitter;
      const uL = em.allocLocal(F64); em.localSet(uL);
      pushValueAs(em, inputs['mean'] ?? ({ inline: true, value: 0, valtype: F64 } as ValueRef), F64);
      em.f64Const(1); em.localGet(uL); em.op(OP_F64_SUB);
      em.emit(byte(0x10), leb128u(LOG_FUNC_IDX));
      em.op(OP_F64_NEG);
      em.op(OP_F64_MUL);
      return storeResult(em, F64);
    }

    if (t === 'bool') {
      // probability < random ? 0 : 1   (JS does: random < prob ? 1 : 0)
      const prob = inputs['probability'];
      const probRef: ValueRef = prob ?? { inline: true, value: 0.5, valtype: F64 };
      // Stack: [random]
      pushValueAs(ctx.emitter, probRef, F64);
      // Stack: [random, prob]
      ctx.emitter.op(OP_F64_LT); // random < prob ? 1 : 0
      return storeResult(ctx.emitter, I32);
    } else if (t === 'integer') {
      // Math.floor(random * (max - min + 1)) + min
      if (!rangeConst) {
        // A wired bound ⇒ compute the span at runtime, in f64 (mirrors the JS
        // emit exactly, including a fractional Min the const path would trunc).
        const em = ctx.emitter;
        pushValueAs(em, maxRef, F64); pushValueAs(em, minRef, F64); em.op(OP_F64_SUB);
        em.f64Const(1); em.op(OP_F64_ADD);
        em.op(OP_F64_MUL); em.op(OP_F64_FLOOR);
        pushValueAs(em, minRef, F64); em.op(OP_F64_ADD);
        return storeResult(em, F64);
      }
      ctx.emitter.f64Const(maxN - minN + 1);
      ctx.emitter.op(OP_F64_MUL);
      // Truncate via f64 -> i32 (for non-negative values, trunc == floor)
      ctx.emitter.f64ToI32();
      ctx.emitter.i32Const(minN | 0);
      ctx.emitter.op(OP_I32_ADD);
      return storeResult(ctx.emitter, I32);
    } else if (t === 'orientation') {
      // Uniform pick from 0..3 (N/E/S/W). Stack already has uniform f64 from
      // the RNG block above; multiply by 4, truncate, mask to be defensive.
      ctx.emitter.f64Const(4);
      ctx.emitter.op(OP_F64_MUL);
      ctx.emitter.f64ToI32();
      ctx.emitter.i32Const(3);
      ctx.emitter.op(OP_I32_AND);
      return storeResult(ctx.emitter, I32);
    } else if (t === 'options') {
      // Options mode: stack already has [uniform_f64] from above. Three source
      // dispatch paths mirror the JS isArray + inputToSources logic in
      // compile.ts:904-916, with a fallback ValueRef for the empty-array case
      // (the user always sees + can override the fallback in the inline widget,
      // so empty-array is never silent).
      const em = ctx.emitter;
      const OP_DROP = byte(0x1a);
      const fallbackRef: ValueRef = inputs['fallback'] ?? { inline: true, value: 0, valtype: F64 };
      const sources = ctx.inputToSources.get(`${node.id}:options`) ?? [];

      if (sources.length === 0) {
        // No source wired — emit the fallback. RNG already advanced + stored
        // for parity with the other paths.
        em.op(OP_DROP);
        pushValueAs(em, fallbackRef, F64);
        return storeResult(em, F64);
      }

      if (sources.length === 1) {
        const src = sources[0]!;
        const srcNode = ctx.nodeMap.get(src.nodeId);
        if (srcNode && ctx.producesArray(srcNode)) {
          // Single array source: idx = i32(uniform * len); guard len > 0.
          const arr = compileArrayNode(src.nodeId, ctx, src.portId);
          if (!arr) return null;
          // Stack: [uniform_f64]
          em.localGet(arr.lenLocal); em.i32ToF64();
          em.op(OP_F64_MUL);
          em.f64ToI32();
          const idxLocal = em.allocLocal(I32);
          em.localSet(idxLocal);
          const resultLocal = em.allocLocal(arr.elemValtype);
          pushValueAs(em, fallbackRef, arr.elemValtype);
          em.localSet(resultLocal);
          // if (len > 0) result = arr[idx]
          em.localGet(arr.lenLocal);
          em.i32Const(0);
          em.op(byte(0x4b)); // OP_I32_GT_U
          em.ifThen(() => {
            em.localGet(idxLocal);
            emitArrayLoadElem(em, arr);
            em.localSet(resultLocal);
          });
          em.localGet(resultLocal);
          return storeResult(em, arr.elemValtype);
        }
        // Single scalar source: length 1, trivially returns that value. Drop
        // the uniform, emit the scalar. RNG already advanced for parity.
        em.op(OP_DROP);
        const srcRef = compileValueNode(src.nodeId, ctx, src.portId);
        if (!srcRef) {
          ctx.errors.push(`getRandom options: scalar source ${src.nodeId} did not produce a value`);
          return null;
        }
        // Return the cached ref directly — no need to copy into a new local.
        return srcRef;
      }

      // Multi-scalar (≥ 2 sources): materialise scalars, idx = i32(uniform * N),
      // result = sources[idx]. N is statically known so we use a chain of
      // ifThen() blocks (matches emitScalarAggregate's 'random' op pattern at
      // ~line 2755 — kept in lockstep with the single-source-array path).
      const sourceRefs: LocalRef[] = [];
      for (const s of sources) {
        const r = compileValueNode(s.nodeId, ctx, s.portId);
        if (!r) {
          ctx.errors.push(`getRandom options: scalar source ${s.nodeId} did not produce a value`);
          return null;
        }
        sourceRefs.push(r);
      }
      const N = sourceRefs.length;
      // Stack: [uniform_f64]
      em.f64Const(N); em.op(OP_F64_MUL);
      em.f64ToI32();
      const idxLocal = em.allocLocal(I32);
      em.localSet(idxLocal);
      const accValtype: ValType = F64;
      const accLocal = em.allocLocal(accValtype);
      // Initialise to sources[0]; overwrite if idx selects a different source.
      pushValueAs(em, sourceRefs[0]!, accValtype);
      em.localSet(accLocal);
      for (let i = 1; i < N; i++) {
        em.localGet(idxLocal); em.i32Const(i); em.op(OP_I32_EQ);
        em.ifThen(() => {
          pushValueAs(em, sourceRefs[i]!, accValtype);
          em.localSet(accLocal);
        });
      }
      return { localIdx: accLocal, valtype: accValtype };
    } else {
      // random * (max - min) + min
      if (!rangeConst) {
        const em = ctx.emitter;
        pushValueAs(em, maxRef, F64); pushValueAs(em, minRef, F64); em.op(OP_F64_SUB);
        em.op(OP_F64_MUL);
        pushValueAs(em, minRef, F64); em.op(OP_F64_ADD);
        return storeResult(em, F64);
      }
      ctx.emitter.f64Const(maxN - minN);
      ctx.emitter.op(OP_F64_MUL);
      ctx.emitter.f64Const(minN);
      ctx.emitter.op(OP_F64_ADD);
      return storeResult(ctx.emitter, F64);
    }
  },

  // -- Indicator reads --
  getIndicator: ({ node, ctx }) => {
    const idxRaw = node.data.config._indicatorIdx;
    const idx = Number(idxRaw ?? -1);
    const id = ctx.layout.indicatorIds[idx];
    if (!id) { ctx.errors.push(`getIndicator: bad index ${idx}`); return null; }
    const off = ctx.layout.indicatorOffset[id];
    if (off === undefined) { ctx.errors.push(`getIndicator: no offset for ${id}`); return null; }
    ctx.emitter.i32Const(0);
    ctx.emitter.f64Load(off, 3);
    return storeResult(ctx.emitter, F64);
  },

  // -- Local Variable read (scalar path). Array variables go through the
  //    array-emitter path (ARRAY_NODE_EMITTERS['getVariable']) instead;
  //    consumers with isArray inputs dispatch there automatically. */
  getVariable: ({ node, ctx }) => {
    const variableId = node.data.config.variableId as string;
    const slot = ctx.variableLocals.get(variableId);
    if (!slot) {
      ctx.errors.push(`getVariable: unknown variable "${variableId}"`);
      return null;
    }
    if (slot.kind !== 'scalar') {
      // Scalar consumer wired to an array variable — emit a useful error.
      // (Validation catches the inverse — Array consumer with scalar variable.)
      ctx.errors.push(`getVariable: variable "${variableId}" is an array; wire to an isArray input or use ArrayElement to index it`);
      return null;
    }
    return { localIdx: slot.localIdx, valtype: slot.valtype };
  },

  // -- Neighbor by index (Wave A.6: packed NI inline access) --
  // Symmetric with setNeighborAttributeByIndex: guards INVALID_NI sentinel
  // (returned by pickRandomNeighbor on empty array, arrayElement on out-of-
  // range) and yields a zero-valued default. Without the guard, the decoded
  // (dr=-32768, dc=0) would silently read from a wrapped torus cell or the
  // constant-boundary sentinel — both wrong for "no neighbor".
  getNeighborAttributeByIndex: ({ node, ctx, inputs }) => {
    const attrId = node.data.config.attributeId as string;
    const attr = getAttr(ctx.layout, attrId);
    if (!attr) { ctx.errors.push(`getNeighborAttributeByIndex: unknown attr ${attrId}`); return null; }
    // Stash NI in a local so we can decode dr/dc inline.
    const niLocal = ctx.emitter.allocLocal(I32);
    // If the index input is wired to an array producer (e.g. pickRandomNeighbor
    // returns NI from an array, or pickNRandomNeighbors returns NI[]), the
    // outer input loop skipped the value compile. Fetch the array and take
    // element [0] to mirror JS's `Array.isArray ? arr[0] : scalar` semantic.
    // Empty array → INVALID_NI so the guard below kicks in. Detect via the
    // source's OUTPUT PORT, not isArrayProducer(nodeType) — hybrid nodes
    // (groupCounting / groupOperator / groupStatement) are array producers
    // for their indexes/positions output but expose scalar outputs too;
    // routing a scalar output through the load-element-[0] branch would
    // mis-read the indexes array instead of the wired scalar.
    const indexSrc = ctx.inputToSource.get(`${node.id}:index`);
    const srcNode = indexSrc ? ctx.nodeMap.get(indexSrc.nodeId) : undefined;
    const indexSrcDef = srcNode ? getNodeDef(srcNode.data.nodeType) : null;
    const indexSrcPort = indexSrc ? indexSrcDef?.ports.find(p => p.id === indexSrc.portId) : undefined;
    if (indexSrcPort?.isArray) {
      const arrRef = compileArrayNode(indexSrc!.nodeId, ctx, indexSrc!.portId);
      if (!arrRef) return null;
      ctx.emitter.localGet(arrRef.lenLocal);
      ctx.emitter.i32Const(0);
      ctx.emitter.op(OP_I32_GT_S);
      ctx.emitter.ifThenElse(
        () => {
          ctx.emitter.i32Const(0);
          emitArrayLoadElem(ctx.emitter, arrRef);
          if (arrRef.elemValtype === F64) ctx.emitter.f64ToI32();
          ctx.emitter.localSet(niLocal);
        },
        () => {
          ctx.emitter.i32Const(INVALID_NI);
          ctx.emitter.localSet(niLocal);
        },
      );
    } else {
      const indexRef = inputs['index'] ?? { inline: true, value: 0, valtype: I32 };
      pushValueAs(ctx.emitter, indexRef, I32);
      ctx.emitter.localSet(niLocal);
    }
    // result := 0 (default for INVALID_NI path)
    const result = ctx.emitter.allocLocal(attrValType(attr.type));
    if (attr.type === 'float') { ctx.emitter.f64Const(0); }
    else { ctx.emitter.i32Const(0); }
    ctx.emitter.localSet(result);
    // if (NI !== INVALID_NI) { result = read at niCellIdx(NI), wrapped if sub-attr }
    ctx.emitter.localGet(niLocal);
    ctx.emitter.i32Const(INVALID_NI);
    ctx.emitter.op(OP_I32_NE_OP);
    const subN = getSubAttrWasm(ctx, attrId);
    ctx.emitter.ifThen(() => {
      pushNiCellIdx(ctx, niLocal);
      // Stash cell idx so we can use it for both the load and the parent check.
      const cellIdxLocal = ctx.emitter.allocLocal(I32);
      ctx.emitter.localSet(cellIdxLocal);
      // Push the raw value at the neighbor cell.
      ctx.emitter.localGet(cellIdxLocal);
      ctx.emitter.i32Const(attr.itemBytes);
      ctx.emitter.op(OP_I32_MUL);
      if (attr.type === 'bool') ctx.emitter.i32Load8U(attr.readOffset, 0);
      else if (attr.type === 'float') ctx.emitter.f64Load(attr.readOffset, 3);
      else ctx.emitter.i32Load(attr.readOffset, 2);
      if (subN) {
        // [value, undefined, match] → select → wrapped read
        emitAttrLiteralWasm(ctx, attr, subN.undefinedValueStr);
        emitParentMatchAtIdxWasm(ctx, subN.parent, subN.parentValuesInt, cellIdxLocal, false);
        ctx.emitter.op(OP_SELECT);
      }
      ctx.emitter.localSet(result);
    });
    ctx.emitter.localGet(result);
    return storeResult(ctx.emitter, attrValType(attr.type));
  },

  // -- Neighbor by tag (compile-time resolved tag index) --
  getNeighborAttributeByTag: ({ node, ctx }) => {
    const nbrId = node.data.config.neighborhoodId as string;
    const attrId = node.data.config.attributeId as string;
    const nbr = getNbr(ctx.layout, nbrId);
    const attr = getAttr(ctx.layout, attrId);
    if (!nbr || !attr) { ctx.errors.push(`getNeighborAttributeByTag: unknown nbr/attr`); return null; }
    const tagIndex = Number((node.data.config as Record<string, unknown>)._resolvedTagIndex ?? 0);
    // Load neighbor cell idx into a local: nIdx[i*nbrSize + tagIndex] — or, in
    // inline-neighbour mode, resolve slot tagIndex's packed offset inline.
    if (ctx.inlineNbr) {
      pushInlineNbrCellIdx(ctx, nbr, () => ctx.emitter.i32Const(tagIndex));
    } else {
      ctx.emitter.localGet(ctx.iLocalIdx);
      ctx.emitter.i32Const(nbr.size);
      ctx.emitter.op(OP_I32_MUL);
      ctx.emitter.i32Const(tagIndex);
      ctx.emitter.op(OP_I32_ADD);
      ctx.emitter.i32Const(4);
      ctx.emitter.op(OP_I32_MUL);
      ctx.emitter.i32Load(nbr.offset, 2);
    }
    const cellIdxLocal = ctx.emitter.allocLocal(I32);
    ctx.emitter.localSet(cellIdxLocal);
    // Load value at that cell
    ctx.emitter.localGet(cellIdxLocal);
    ctx.emitter.i32Const(attr.itemBytes);
    ctx.emitter.op(OP_I32_MUL);
    if (attr.type === 'bool') ctx.emitter.i32Load8U(attr.readOffset, 0);
    else if (attr.type === 'float') ctx.emitter.f64Load(attr.readOffset, 3);
    else ctx.emitter.i32Load(attr.readOffset, 2);
    // Sub-attribute wrap: select(value, undefinedLit, parent_match_at_neighborCell)
    const subT = getSubAttrWasm(ctx, attrId);
    if (subT) {
      emitAttrLiteralWasm(ctx, attr, subT.undefinedValueStr);
      emitParentMatchAtIdxWasm(ctx, subT.parent, subT.parentValuesInt, cellIdxLocal, false);
      ctx.emitter.op(OP_SELECT);
    }
    return storeResult(ctx.emitter, attrValType(attr.type));
  },

  // -- Variegated Cells: Get Orientation ----------------------------------
  // Reads the current cell's orientation (0..3) from the orientation read
  // buffer. JS-target equivalent: `r_orientation[idx] | 0`.
  getOrientation: ({ ctx }) => {
    if (!ctx.layout.variegatedEnabled) {
      ctx.errors.push('getOrientation: variegated cells disabled');
      return null;
    }
    // addr = idx * 4 + orientationReadOffset
    pushCellByteOffset(ctx, 4);
    ctx.emitter.i32Load(ctx.layout.orientationReadOffset, 2);
    return storeResult(ctx.emitter, I32);
  },

  // -- Variegated Cells: Get Facing Orientation --------------------------
  // Reads the orientation of the neighbour touching this cell in a fixed
  // direction. directionTag pre-resolved by compile.ts into (_resolvedDirIdx,
  // _resolvedDr, _resolvedDc, _boundaryTreatment). When the direction isn't
  // set, returns 0. Mirrors `getFacingLabels`'s neighbour-cell computation.
  getFacingOrientation: ({ node, ctx }) => {
    if (!ctx.layout.variegatedEnabled) {
      ctx.errors.push('getFacingOrientation: variegated cells disabled');
      return null;
    }
    const em = ctx.emitter;
    const dirIdx = Number(node.data.config._resolvedDirIdx);
    const dr = Number(node.data.config._resolvedDr);
    const dc = Number(node.data.config._resolvedDc);
    const boundary = (node.data.config._boundaryTreatment as string) || 'torus';
    if (!Number.isFinite(dirIdx) || dirIdx < 0) {
      const z = em.allocLocal(I32);
      em.i32Const(0); em.localSet(z);
      return { localIdx: z, valtype: I32 };
    }
    const total = ctx.layout.total;
    const W = ctx.model.properties.gridWidth;
    const H = ctx.model.properties.gridHeight;
    const nbrCellLocal = em.allocLocal(I32);
    if (boundary === 'constant') {
      const nRow = em.allocLocal(I32);
      em.localGet(ctx.rowLocalIdx);
      em.i32Const(dr); em.op(OP_I32_ADD);
      em.localSet(nRow);
      const nCol = em.allocLocal(I32);
      em.localGet(ctx.colLocalIdx);
      em.i32Const(dc); em.op(OP_I32_ADD);
      em.localSet(nCol);
      em.i32Const(total); em.localSet(nbrCellLocal);
      em.localGet(nRow); em.i32Const(0); em.op(OP_I32_GE_S);
      em.localGet(nRow); em.i32Const(H); em.op(OP_I32_LT_S);
      em.op(OP_I32_AND);
      em.localGet(nCol); em.i32Const(0); em.op(OP_I32_GE_S);
      em.op(OP_I32_AND);
      em.localGet(nCol); em.i32Const(W); em.op(OP_I32_LT_S);
      em.op(OP_I32_AND);
      em.ifThen(() => {
        em.localGet(nRow); em.i32Const(W); em.op(OP_I32_MUL);
        em.localGet(nCol); em.op(OP_I32_ADD);
        em.localSet(nbrCellLocal);
      });
    } else {
      em.localGet(ctx.rowLocalIdx);
      if (dr !== 0) { em.i32Const(dr); em.op(OP_I32_ADD); }
      em.i32Const(H); em.op(OP_I32_REM_S);
      em.i32Const(H); em.op(OP_I32_ADD);
      em.i32Const(H); em.op(OP_I32_REM_S);
      em.i32Const(W); em.op(OP_I32_MUL);
      em.localGet(ctx.colLocalIdx);
      if (dc !== 0) { em.i32Const(dc); em.op(OP_I32_ADD); }
      em.i32Const(W); em.op(OP_I32_REM_S);
      em.i32Const(W); em.op(OP_I32_ADD);
      em.i32Const(W); em.op(OP_I32_REM_S);
      em.op(OP_I32_ADD);
      em.localSet(nbrCellLocal);
    }
    // result = r_orientation[nbrCell]
    em.localGet(nbrCellLocal);
    em.i32Const(4);
    em.op(OP_I32_MUL);
    em.i32Load(ctx.layout.orientationReadOffset, 2);
    return storeResult(em, I32);
  },

  // -- Variegated Cells: Get Neighbor Orientation By Index ----------------
  // Reads one neighbour's orientation given a packed NeighborIndex. Mirrors
  // `getNeighborAttributeByIndex` — accepts either a scalar NI or an array
  // (takes element [0] in the latter case). Guards INVALID_NI (return 0).
  getNeighborOrientationByIndex: ({ node, ctx, inputs }) => {
    if (!ctx.layout.variegatedEnabled) {
      ctx.errors.push('getNeighborOrientationByIndex: variegated cells disabled');
      return null;
    }
    const em = ctx.emitter;
    const niLocal = em.allocLocal(I32);
    const indexSrc = ctx.inputToSource.get(`${node.id}:index`);
    const srcNode = indexSrc ? ctx.nodeMap.get(indexSrc.nodeId) : undefined;
    const indexSrcDef = srcNode ? getNodeDef(srcNode.data.nodeType) : null;
    const indexSrcPort = indexSrc ? indexSrcDef?.ports.find(p => p.id === indexSrc.portId) : undefined;
    if (indexSrcPort?.isArray) {
      const arrRef = compileArrayNode(indexSrc!.nodeId, ctx, indexSrc!.portId);
      if (!arrRef) return null;
      em.localGet(arrRef.lenLocal);
      em.i32Const(0);
      em.op(OP_I32_GT_S);
      em.ifThenElse(
        () => {
          em.i32Const(0);
          emitArrayLoadElem(em, arrRef);
          if (arrRef.elemValtype === F64) em.f64ToI32();
          em.localSet(niLocal);
        },
        () => {
          em.i32Const(INVALID_NI);
          em.localSet(niLocal);
        },
      );
    } else {
      const indexRef = inputs['index'] ?? { inline: true, value: 0, valtype: I32 };
      pushValueAs(em, indexRef, I32);
      em.localSet(niLocal);
    }
    // result := 0 (default for INVALID_NI path)
    const result = em.allocLocal(I32);
    em.i32Const(0);
    em.localSet(result);
    em.localGet(niLocal);
    em.i32Const(INVALID_NI);
    em.op(OP_I32_NE_OP);
    em.ifThen(() => {
      pushNiCellIdx(ctx, niLocal);
      em.i32Const(4);
      em.op(OP_I32_MUL);
      em.i32Load(ctx.layout.orientationReadOffset, 2);
      em.localSet(result);
    });
    em.localGet(result);
    return storeResult(em, I32);
  },

  // -- Variegated Cells: Get Facing Labels (multi-output) -----------------
  // Resolves the two face labels touching at a neighbor encounter, accounting
  // for both cells' orientations and face patterns. Outputs:
  //   myFaceLabel    — this cell's face touching the neighbor
  //   theirFaceLabel — the neighbor's face touching this cell
  // Both are face-label indices into `['none', ...faceLabels]`.
  //
  // Pre-resolve pass in compile.ts bakes the chosen direction (config.directionTag)
  // into `_resolvedSlotIdx` (neighborhood slot whose tag matches) and
  // `_resolvedDirIdx` (0..7 direction). When either is -1, the node emits
  // zeros for both outputs (none/none) without touching memory.
  //
  // Direction math (slot & dir are i32 constants here, no runtime branch):
  //   myFaceIdx   = (dir + 2 * myOrientation) & 7
  //   theirFaceIdx = ((dir + 4) & 7) + 2 * theirOrientation, & 7
  //   myLabel    = (mySpec < 0) ? 0 : lookup[mySpec * 8 + myFaceIdx]
  //   theirLabel = (nbrCell >= total) ? 0 : lookup[theirSpec * 8 + theirFaceIdx]
  getFacingLabels: ({ node, ctx }) => {
    if (!ctx.layout.variegatedEnabled) {
      ctx.errors.push('getFacingLabels: variegated cells disabled');
      return null;
    }
    const sourceAttrId = (node.data.config._sourceAttrId as string) || '';
    const sourceAttr = sourceAttrId ? getAttr(ctx.layout, sourceAttrId) : null;
    const dirIdx = Number(node.data.config._resolvedDirIdx);
    const dr = Number(node.data.config._resolvedDr);
    const dc = Number(node.data.config._resolvedDc);
    const boundary = (node.data.config._boundaryTreatment as string) || 'torus';
    const em = ctx.emitter;

    // Unresolved direction → both labels are `none` (0). No memory access.
    if (!Number.isFinite(dirIdx) || dirIdx < 0) {
      const myLabelZ = em.allocLocal(I32);
      em.i32Const(0); em.localSet(myLabelZ);
      const theirLabelZ = em.allocLocal(I32);
      em.i32Const(0); em.localSet(theirLabelZ);
      setCachedPort(ctx, node.id, 'myFaceLabel', { localIdx: myLabelZ, valtype: I32 });
      setCachedPort(ctx, node.id, 'theirFaceLabel', { localIdx: theirLabelZ, valtype: I32 });
      return { localIdx: myLabelZ, valtype: I32 };
    }

    const lookupOff = ctx.layout.facePatternLookupOffset;
    const total = ctx.layout.total;
    const W = ctx.model.properties.gridWidth;
    const H = ctx.model.properties.gridHeight;

    // Compute the neighbour cell index directly from (dr, dc) + boundary.
    //   torus:    nci = ((row + dr + H) % H) * W + ((col + dc + W) % W)
    //   constant: nci = (in-bounds) ? (row+dr)*W + (col+dc) : total
    const nbrCellLocal = em.allocLocal(I32);
    if (boundary === 'constant') {
      // nRow = row + dr, nCol = col + dc
      const nRow = em.allocLocal(I32);
      em.localGet(ctx.rowLocalIdx);
      em.i32Const(dr);
      em.op(OP_I32_ADD);
      em.localSet(nRow);
      const nCol = em.allocLocal(I32);
      em.localGet(ctx.colLocalIdx);
      em.i32Const(dc);
      em.op(OP_I32_ADD);
      em.localSet(nCol);
      // Default to sentinel; overwrite when in-bounds.
      em.i32Const(total);
      em.localSet(nbrCellLocal);
      // in-bounds: nRow >= 0 && nRow < H && nCol >= 0 && nCol < W
      em.localGet(nRow); em.i32Const(0); em.op(OP_I32_GE_S);
      em.localGet(nRow); em.i32Const(H); em.op(OP_I32_LT_S);
      em.op(OP_I32_AND);
      em.localGet(nCol); em.i32Const(0); em.op(OP_I32_GE_S);
      em.op(OP_I32_AND);
      em.localGet(nCol); em.i32Const(W); em.op(OP_I32_LT_S);
      em.op(OP_I32_AND);
      em.ifThen(() => {
        em.localGet(nRow);
        em.i32Const(W);
        em.op(OP_I32_MUL);
        em.localGet(nCol);
        em.op(OP_I32_ADD);
        em.localSet(nbrCellLocal);
      });
    } else {
      // torus wrap. JS-style ((x % m + m) % m) for negative-safe wrap.
      // Bake the easy fast-path constants when dr or dc are zero.
      em.localGet(ctx.rowLocalIdx);
      if (dr !== 0) { em.i32Const(dr); em.op(OP_I32_ADD); }
      em.i32Const(H);
      em.op(OP_I32_REM_S);
      em.i32Const(H);
      em.op(OP_I32_ADD);
      em.i32Const(H);
      em.op(OP_I32_REM_S);
      em.i32Const(W);
      em.op(OP_I32_MUL);
      em.localGet(ctx.colLocalIdx);
      if (dc !== 0) { em.i32Const(dc); em.op(OP_I32_ADD); }
      em.i32Const(W);
      em.op(OP_I32_REM_S);
      em.i32Const(W);
      em.op(OP_I32_ADD);
      em.i32Const(W);
      em.op(OP_I32_REM_S);
      em.op(OP_I32_ADD);
      em.localSet(nbrCellLocal);
    }

    // myOriLocal = r_orientation[idx]
    const myOriLocal = em.allocLocal(I32);
    pushCellByteOffset(ctx, 4);
    em.i32Load(ctx.layout.orientationReadOffset, 2);
    em.localSet(myOriLocal);

    // theirOriLocal = r_orientation[nbrCell]
    const theirOriLocal = em.allocLocal(I32);
    em.localGet(nbrCellLocal);
    em.i32Const(4);
    em.op(OP_I32_MUL);
    em.i32Load(ctx.layout.orientationReadOffset, 2);
    em.localSet(theirOriLocal);

    // myFaceIdx = (dirIdx + 2 * myOri) & 7
    const myFaceIdx = em.allocLocal(I32);
    em.i32Const(dirIdx);
    em.localGet(myOriLocal);
    em.i32Const(2);
    em.op(OP_I32_MUL);
    em.op(OP_I32_ADD);
    em.i32Const(7);
    em.op(OP_I32_AND);
    em.localSet(myFaceIdx);

    // theirFaceIdx = ((dirIdx + 4) & 7) + 2 * theirOri, then & 7
    const theirFaceIdx = em.allocLocal(I32);
    em.i32Const((dirIdx + 4) & 7);
    em.localGet(theirOriLocal);
    em.i32Const(2);
    em.op(OP_I32_MUL);
    em.op(OP_I32_ADD);
    em.i32Const(7);
    em.op(OP_I32_AND);
    em.localSet(theirFaceIdx);

    // mySpecLocal = sourceAttr ? r_<sourceAttrId>[idx] : 0
    const mySpec = em.allocLocal(I32);
    if (sourceAttr) {
      pushCellByteOffset(ctx, sourceAttr.itemBytes);
      if (sourceAttr.type === 'bool') em.i32Load8U(sourceAttr.readOffset, 0);
      else em.i32Load(sourceAttr.readOffset, 2);
      em.localSet(mySpec);
    } else {
      em.i32Const(0);
      em.localSet(mySpec);
    }

    // theirSpecLocal = sourceAttr ? r_<sourceAttrId>[nbrCell] : 0
    const theirSpec = em.allocLocal(I32);
    if (sourceAttr) {
      em.localGet(nbrCellLocal);
      em.i32Const(sourceAttr.itemBytes);
      em.op(OP_I32_MUL);
      if (sourceAttr.type === 'bool') em.i32Load8U(sourceAttr.readOffset, 0);
      else em.i32Load(sourceAttr.readOffset, 2);
      em.localSet(theirSpec);
    } else {
      em.i32Const(0);
      em.localSet(theirSpec);
    }

    // myLabel = (mySpec < 0) ? 0 : lookup[mySpec * 8 + myFaceIdx]
    const myLabel = em.allocLocal(I32);
    em.i32Const(0);
    em.localSet(myLabel);
    em.localGet(mySpec);
    em.i32Const(0);
    em.op(OP_I32_GE_S);
    em.ifThen(() => {
      em.localGet(mySpec);
      em.i32Const(8);
      em.op(OP_I32_MUL);
      em.localGet(myFaceIdx);
      em.op(OP_I32_ADD);
      em.i32Const(4);
      em.op(OP_I32_MUL);
      em.i32Load(lookupOff, 2);
      em.localSet(myLabel);
    });

    // theirLabel = (nbrCell >= total) ? 0 : lookup[theirSpec * 8 + theirFaceIdx]
    const theirLabel = em.allocLocal(I32);
    em.i32Const(0);
    em.localSet(theirLabel);
    em.localGet(nbrCellLocal);
    em.i32Const(total);
    em.op(OP_I32_LT_S);
    em.ifThen(() => {
      em.localGet(theirSpec);
      em.i32Const(8);
      em.op(OP_I32_MUL);
      em.localGet(theirFaceIdx);
      em.op(OP_I32_ADD);
      em.i32Const(4);
      em.op(OP_I32_MUL);
      em.i32Load(lookupOff, 2);
      em.localSet(theirLabel);
    });

    setCachedPort(ctx, node.id, 'myFaceLabel', { localIdx: myLabel, valtype: I32 });
    setCachedPort(ctx, node.id, 'theirFaceLabel', { localIdx: theirLabel, valtype: I32 });
    // Canonical default-port return is myFaceLabel.
    return { localIdx: myLabel, valtype: I32 };
  },

  // -- Variegated Cells: Lookup Interaction -------------------------------
  // Indexes an interactionTable model attribute by two face labels. Output
  // is f64 (table values are floats). Returns 0 when the tableId is unknown
  // or variegation is off.
  lookupInteraction: ({ node, ctx, inputs }) => {
    // No variegation guard — a Lookup Table can be keyed purely by tag
    // attributes (no faces). Tableless lookup falls back to constant 0.
    const tableId = (node.data.config.tableId as string) || '';
    const slot = tableId ? ctx.layout.interactionTableOffsets[tableId] : undefined;
    if (slot === undefined) {
      ctx.emitter.f64Const(0);
      return storeResult(ctx.emitter, F64);
    }
    if (slot.dims && slot.dims.length > 0) {
      // MULTI-AXIS (N-D) table: flat = Σ clamp((axisₖ|0) − minₖ, 0, dimₖ−1)·strideₖ
      // (per-axis saturating clamp — D-NDT-5; mirrors the JS + WGSL emits).
      const em = ctx.emitter;
      const dims = slot.dims;
      const mins = slot.mins ?? [];
      const strides = new Array<number>(dims.length).fill(1);
      for (let i = dims.length - 2; i >= 0; i--) strides[i] = strides[i + 1]! * dims[i + 1]!;
      const flat = em.allocLocal(I32);
      em.i32Const(0); em.localSet(flat);
      for (let k = 0; k < dims.length; k++) {
        const min = Math.floor(mins[k] ?? 0) || 0;
        const hi = Math.max(0, dims[k]! - 1);
        const t = em.allocLocal(I32);
        pushValueAs(em, inputs[`axis_${k}`] ?? { inline: true, value: 0, valtype: I32 }, I32);
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
        // flat += t * stride
        em.localGet(flat);
        em.localGet(t);
        if (strides[k] !== 1) { em.i32Const(strides[k]!); em.op(OP_I32_MUL); }
        em.op(OP_I32_ADD); em.localSet(flat);
      }
      em.localGet(flat);
      em.i32Const(8); em.op(OP_I32_MUL);
      em.f64Load(slot.offset, 3);
      return storeResult(em, F64);
    }
    // LEGACY 2-axis — byte-identical to the pre-N-D emit (no clamp).
    const colCount = slot.colCount; // row-major stride
    const labelA = inputs['labelA'] ?? { inline: true, value: 0, valtype: I32 };
    const labelB = inputs['labelB'] ?? { inline: true, value: 0, valtype: I32 };
    // addr = (labelA * colCount + labelB) * 8 + slot.offset
    pushValueAs(ctx.emitter, labelA, I32);
    ctx.emitter.i32Const(colCount);
    ctx.emitter.op(OP_I32_MUL);
    pushValueAs(ctx.emitter, labelB, I32);
    ctx.emitter.op(OP_I32_ADD);
    ctx.emitter.i32Const(8);
    ctx.emitter.op(OP_I32_MUL);
    ctx.emitter.f64Load(slot.offset, 3);
    return storeResult(ctx.emitter, F64);
  },

  // -- Init Event (multi-output: x, y, maxX, maxY) ------------------------
  // Resolves the per-cell coordinates. Like the JS compiler, the entry-point
  // orchestrator pre-emits these locals before the flow body runs; this
  // emitter is here as a safety net so a stray reference outside Init still
  // compiles instead of crashing. Real values come from `initParamRefs` set
  // up by compileEntry when the entry is the init node.
  initEvent: ({ node, ctx }) => {
    // No-op compute: just register all four outputs as zero locals so
    // downstream consumers find something. The Init entry-point overrides
    // these via paramRefs / direct local population before running the flow.
    const W = ctx.model.properties.gridWidth;
    const H = ctx.model.properties.gridHeight;
    // x = idx % W; y = idx / W; maxX = W - 1; maxY = H - 1
    const xLoc = ctx.emitter.allocLocal(I32);
    ctx.emitter.localGet(ctx.colLocalIdx);
    ctx.emitter.localSet(xLoc);
    const yLoc = ctx.emitter.allocLocal(I32);
    ctx.emitter.localGet(ctx.rowLocalIdx);
    ctx.emitter.localSet(yLoc);
    const maxXLoc = ctx.emitter.allocLocal(I32);
    ctx.emitter.i32Const(W - 1);
    ctx.emitter.localSet(maxXLoc);
    const maxYLoc = ctx.emitter.allocLocal(I32);
    ctx.emitter.i32Const(H - 1);
    ctx.emitter.localSet(maxYLoc);
    setCachedPort(ctx, node.id, 'x', { localIdx: xLoc, valtype: I32 });
    setCachedPort(ctx, node.id, 'y', { localIdx: yLoc, valtype: I32 });
    setCachedPort(ctx, node.id, 'maxX', { localIdx: maxXLoc, valtype: I32 });
    setCachedPort(ctx, node.id, 'maxY', { localIdx: maxYLoc, valtype: I32 });
    // 3D Grid CA: z = layer, maxZ = D-1 (only in a 3D model — layerLocalIdx is
    // -1 in 2D, where the z/maxZ ports are hidden so nothing reads them).
    if (ctx.layerLocalIdx >= 0) {
      const D = Math.max(1, ctx.model.properties.gridDepth ?? 1);
      const zLoc = ctx.emitter.allocLocal(I32);
      ctx.emitter.localGet(ctx.layerLocalIdx);
      ctx.emitter.localSet(zLoc);
      const maxZLoc = ctx.emitter.allocLocal(I32);
      ctx.emitter.i32Const(D - 1);
      ctx.emitter.localSet(maxZLoc);
      setCachedPort(ctx, node.id, 'z', { localIdx: zLoc, valtype: I32 });
      setCachedPort(ctx, node.id, 'maxZ', { localIdx: maxZLoc, valtype: I32 });
    }
    return { localIdx: xLoc, valtype: I32 };
  },

  // -- groupOperator (multi-output: result + index). --
  groupOperator: ({ node, ctx, inputs }) => {
    return emitAggregateOrCount(ctx, node, inputs, 'groupOperator');
  },

  // -- proportionMap: remap from [inMin, inMax] to [outMin, outMax] using a
  //    selectable curve.
  //    Let t = (x - inMin) / (inMax - inMin) when inSpan != 0, else 0.
  //    Result = outMin + curve(t) * (outMax - outMin) when inSpan != 0,
  //             else outMin.
  //    All maths in f64 to match JS Number semantics.
  proportionMap: ({ ctx, node, inputs }) => {
    const x      = inputs['x']      ?? { inline: true, value: 0, valtype: F64 };
    const inMin  = inputs['inMin']  ?? { inline: true, value: 0, valtype: F64 };
    const inMax  = inputs['inMax']  ?? { inline: true, value: 1, valtype: F64 };
    const outMin = inputs['outMin'] ?? { inline: true, value: 0, valtype: F64 };
    const outMax = inputs['outMax'] ?? { inline: true, value: 1, valtype: F64 };
    const method = (node.data.config.method as string) || 'linear';
    // Compute (inMax - inMin) into a local (used twice: zero-check + divisor).
    const inSpan = ctx.emitter.allocLocal(F64);
    pushValueAs(ctx.emitter, inMax, F64);
    pushValueAs(ctx.emitter, inMin, F64);
    ctx.emitter.op(OP_F64_SUB);
    ctx.emitter.localSet(inSpan);
    // Result local
    const result = ctx.emitter.allocLocal(F64);
    // if (inSpan != 0) result = outMin + curve(t) * (outMax - outMin)
    // else result = outMin
    ctx.emitter.localGet(inSpan);
    ctx.emitter.f64Const(0);
    ctx.emitter.op(OP_F64_NE);
    ctx.emitter.ifThenElse(
      () => {
        // tRaw = (x - inMin) / inSpan
        const tRaw = ctx.emitter.allocLocal(F64);
        pushValueAs(ctx.emitter, x, F64);
        pushValueAs(ctx.emitter, inMin, F64);
        ctx.emitter.op(OP_F64_SUB);
        ctx.emitter.localGet(inSpan);
        ctx.emitter.op(OP_F64_DIV);
        ctx.emitter.localSet(tRaw);
        const tCurve = emitInterpolationCurveWasm(ctx.emitter, tRaw, method);
        // (outMax - outMin) * tCurve + outMin
        pushValueAs(ctx.emitter, outMax, F64);
        pushValueAs(ctx.emitter, outMin, F64);
        ctx.emitter.op(OP_F64_SUB);
        ctx.emitter.localGet(tCurve);
        ctx.emitter.op(OP_F64_MUL);
        pushValueAs(ctx.emitter, outMin, F64);
        ctx.emitter.op(OP_F64_ADD);
        ctx.emitter.localSet(result);
      },
      () => {
        pushValueAs(ctx.emitter, outMin, F64);
        ctx.emitter.localSet(result);
      },
    );
    return { localIdx: result, valtype: F64 };
  },

  // -- interpolation: min + t * (max - min), all f64 --
  interpolation: ({ ctx, inputs }) => {
    const t   = inputs['t']   ?? { inline: true, value: 0.5, valtype: F64 };
    const mn  = inputs['min'] ?? { inline: true, value: 0,   valtype: F64 };
    const mx  = inputs['max'] ?? { inline: true, value: 1,   valtype: F64 };
    pushValueAs(ctx.emitter, mn, F64);
    pushValueAs(ctx.emitter, t, F64);
    pushValueAs(ctx.emitter, mx, F64);
    pushValueAs(ctx.emitter, mn, F64);
    ctx.emitter.op(OP_F64_SUB);
    ctx.emitter.op(OP_F64_MUL);
    ctx.emitter.op(OP_F64_ADD);
    return storeResult(ctx.emitter, F64);
  },

  // -- valueSwitch: cond ? ifValue : elseValue (f64 result) --
  valueSwitch: ({ node, ctx, inputs }) => {
    // Array-relay instances are routed to ARRAY_NODE_EMITTERS by ctx.producesArray;
    // this scalar path should never see one. Guard documents the invariant.
    if (ctx.producesArray(node)) {
      ctx.errors.push(`valueSwitch: array-relay instance reached the scalar value emitter (internal dispatch error)`);
      return null;
    }
    const cond = inputs['condition'] ?? { inline: true, value: 0, valtype: I32 };
    const ifV  = inputs['ifValue']   ?? { inline: true, value: 1, valtype: F64 };
    const elV  = inputs['elseValue'] ?? { inline: true, value: 0, valtype: F64 };
    pushValueAs(ctx.emitter, ifV, F64);
    pushValueAs(ctx.emitter, elV, F64);
    pushValueAs(ctx.emitter, cond, I32);
    ctx.emitter.op(OP_SELECT);
    return storeResult(ctx.emitter, F64);
  },

  // -- getColorConstant: i32 channels from config (r, g, b [, a]).
  //    `a` is emitted ONLY when the config declares a non-opaque alpha
  //    (colorConstantHasAlpha) — an extra local would change the module bytes of
  //    every existing model, so the opaque path must allocate exactly three. --
  getColorConstant: ({ node, ctx }) => {
    const r = parseInt(String(node.data.config.r ?? '0'), 10) || 0;
    const g = parseInt(String(node.data.config.g ?? '0'), 10) || 0;
    const b = parseInt(String(node.data.config.b ?? '0'), 10) || 0;
    const alloc = (n: number): LocalRef => {
      ctx.emitter.i32Const(n);
      return storeResult(ctx.emitter, I32);
    };
    const rRef = alloc(r);
    const gRef = alloc(g);
    const bRef = alloc(b);
    setCachedPort(ctx, node.id, 'r', rRef);
    setCachedPort(ctx, node.id, 'g', gRef);
    setCachedPort(ctx, node.id, 'b', bRef);
    if (colorConstantHasAlpha(node.data.config)) {
      setCachedPort(ctx, node.id, 'a',
        alloc(parseInt(String(node.data.config.a ?? '255'), 10) || 0));
    }
    return rRef;
  },

  // -- colorScale: maps t to RGB via N color stops + selectable curve.
  //    Sorted-by-position stops; head t<=p[0] clamps to first; tail t>=p[N-1]
  //    clamps to last; each interior segment computes
  //    round(a.c + curve(localT) * (b.c - a.c)) per channel. --
  colorScale: ({ ctx, node, inputs }) => {
    const t = inputs['t'] ?? { inline: true, value: 0.5, valtype: F64 };
    const method = (node.data.config.method as string) || 'linear';
    const stops = readColorScaleStops(node.data.config);

    const withA = colorScaleHasAlpha(node.data.config);

    const em = ctx.emitter;
    const tLoc = em.allocLocal(F64);
    // Channel table — r/g/b always, `a` allocated LAST and only when declared, so
    // the opaque path allocates exactly [tLoc, rLoc, gLoc, bLoc] as before. A
    // stray local would change the module bytes of every existing model.
    const chans: Array<{ loc: number; get: (s: ColorScaleStop) => number }> = [
      { loc: em.allocLocal(I32), get: s => s.r },
      { loc: em.allocLocal(I32), get: s => s.g },
      { loc: em.allocLocal(I32), get: s => s.b },
    ];
    if (withA) chans.push({ loc: em.allocLocal(I32), get: s => s.a ?? 255 });

    pushValueAs(em, t, F64);
    em.localSet(tLoc);

    const writeConst = (s: ColorScaleStop) => {
      for (const c of chans) { em.i32Const(c.get(s) | 0); em.localSet(c.loc); }
    };
    const writeSegment = (a: ColorScaleStop, b: ColorScaleStop) => {
      const localTLoc = em.allocLocal(F64);
      em.localGet(tLoc);
      em.f64Const(a.p);
      em.op(OP_F64_SUB);
      em.f64Const(b.p - a.p);
      em.op(OP_F64_DIV);
      em.localSet(localTLoc);
      const curveLoc = emitInterpolationCurveWasm(em, localTLoc, method);
      const chan = (ac: number, bc: number, dst: number) => {
        em.f64Const(ac);
        em.localGet(curveLoc);
        em.f64Const(bc - ac);
        em.op(OP_F64_MUL);
        em.op(OP_F64_ADD);
        em.f64Const(0.5);
        em.op(OP_F64_ADD);
        em.op(OP_F64_FLOOR);
        em.f64ToI32();
        em.localSet(dst);
      };
      // Alpha interpolates on the SAME curve as the colour channels — matching JS.
      for (const c of chans) chan(c.get(a), c.get(b), c.loc);
    };

    const ZERO: ColorScaleStop = { p: 0, r: 0, g: 0, b: 0, a: 0 };
    if (stops.length === 0) {
      // No stops ⇒ no alpha can be declared ⇒ withA is false ⇒ three channels.
      writeConst(ZERO);
    } else if (stops.length === 1) {
      writeConst(stops[0]!);
    } else {
      const first = stops[0]!;
      em.localGet(tLoc);
      em.f64Const(first.p);
      em.op(OP_F64_LE);
      em.ifThenElse(
        () => writeConst(first),
        () => {
          const buildChain = (i: number) => {
            if (i >= stops.length - 1) {
              writeConst(stops[stops.length - 1]!);
              return;
            }
            const a = stops[i]!;
            const b = stops[i + 1]!;
            if (b.p === a.p) { buildChain(i + 1); return; }
            em.localGet(tLoc);
            em.f64Const(b.p);
            em.op(OP_F64_LT);
            em.ifThenElse(
              () => writeSegment(a, b),
              () => buildChain(i + 1),
            );
          };
          buildChain(0);
        },
      );
    }

    const refs = chans.map(c => ({ localIdx: c.loc, valtype: I32 } as LocalRef));
    (withA ? ['r', 'g', 'b', 'a'] : ['r', 'g', 'b']).forEach((p, i) => {
      setCachedPort(ctx, node.id, p, refs[i]!);
    });
    return refs[0]!;
  },

  // -- categoricalColor: maps an integer index to a flat RGB color from an
  //    N-entry palette (no blending). `if (k===i) {entry i} else ... else default`. --
  categoricalColor: ({ ctx, node, inputs }) => {
    const idx = inputs['index'] ?? { inline: true, value: 0, valtype: I32 };
    const entries = readCategoricalEntries(node.data.config);
    const d = readCategoricalDefault(node.data.config);

    const withA = categoricalHasAlpha(node.data.config);

    const em = ctx.emitter;
    // `a` allocated LAST and only when declared — see the colorScale twin.
    const chans: Array<{ loc: number; get: (e: CategoricalEntry) => number }> = [
      { loc: em.allocLocal(I32), get: e => e.r },
      { loc: em.allocLocal(I32), get: e => e.g },
      { loc: em.allocLocal(I32), get: e => e.b },
    ];
    if (withA) chans.push({ loc: em.allocLocal(I32), get: e => e.a ?? 255 });

    const writeConst = (e: CategoricalEntry) => {
      for (const c of chans) { em.i32Const(c.get(e) | 0); em.localSet(c.loc); }
    };

    if (entries.length === 0) {
      writeConst(d);
    } else {
      const kLoc = em.allocLocal(I32);
      pushValueAs(em, idx, I32);
      em.localSet(kLoc);
      const buildChain = (i: number) => {
        if (i >= entries.length) { writeConst(d); return; }
        const e = entries[i]!;
        em.localGet(kLoc);
        em.i32Const(i);
        em.op(OP_I32_EQ);
        em.ifThenElse(
          () => writeConst(e),
          () => buildChain(i + 1),
        );
      };
      buildChain(0);
    }

    const refs = chans.map(c => ({ localIdx: c.loc, valtype: I32 } as LocalRef));
    (withA ? ['r', 'g', 'b', 'a'] : ['r', 'g', 'b']).forEach((p, i) => {
      setCachedPort(ctx, node.id, p, refs[i]!);
    });
    return refs[0]!;
  },

  // -- groupStatement: tests an assertion across an array. --
  groupStatement: ({ node, ctx, inputs }) => {
    return emitGroupStatement(ctx, node, inputs);
  },
};

/**
 * groupStatement emit. Like groupCounting but the result is a bool and the
 * operations are all/any across the source array.
 *   allIs:        every value === x
 *   noneIs:       every value !== x
 *   hasA:         some  value === x
 *   allGreater:   every value > x
 *   anyGreater:   some  value > x
 *   allLesser:    every value < x
 *   anyLesser:    some  value < x
 *
 * For "all" ops the accumulator starts at 1 and gets ANDed with each match;
 * for "any" ops it starts at 0 and gets ORed.
 */
function emitGroupStatement(
  ctx: WasmCompileCtx,
  node: GraphNode,
  inputs: Record<string, ValueRef | undefined>,
): LocalRef | null {
  const op = (node.data.config.operation as string) || 'allIs';
  const isAll = op === 'allIs' || op === 'noneIs' || op === 'allGreater' || op === 'allLesser';
  const x = inputs['x'] ?? { inline: true, value: 0, valtype: F64 };

  const portKey = `${node.id}:values`;
  const sources = ctx.inputToSources.get(portKey) ?? [];
  if (sources.length === 0) {
    ctx.errors.push(`groupStatement: no sources connected to "values" port`);
    return null;
  }
  const firstSrc = sources[0]!;
  const firstSrcNode = ctx.nodeMap.get(firstSrc.nodeId);
  const isNbrPath = sources.length === 1
    && firstSrcNode?.data.nodeType === 'getNeighborsAttribute';

  // Try ArrayRef path: if the single source is an array-producing node, loop the array.
  let arrayPath: { arr: ArrayRef } | null = null;
  if (sources.length === 1 && !isNbrPath) {
    const srcNode = firstSrcNode;
    if (srcNode && ctx.producesArray(srcNode)) {
      const a = compileArrayNode(firstSrc.nodeId, ctx, firstSrc.portId);
      if (a) arrayPath = { arr: a };
    }
  }

  const cmpOp = (() => {
    switch (op) {
      case 'noneIs':                        return '!=';
      case 'allGreater': case 'anyGreater': return '>';
      case 'allLesser':  case 'anyLesser':  return '<';
      default:                              return '==';
    }
  })();

  const accLocal = ctx.emitter.allocLocal(I32);
  ctx.emitter.i32Const(isAll ? 1 : 0);
  ctx.emitter.localSet(accLocal);

  const emitCmp = (loadValueOp: () => void, elemValtype: ValType) => {
    loadValueOp();
    pushValueAs(ctx.emitter, x, elemValtype);
    if (elemValtype === F64) ctx.emitter.op(cmpToF64Op(cmpOp));
    else ctx.emitter.op(cmpToI32Op(cmpOp));
    // Stack: [match (i32 0/1)]
    if (isAll) {
      ctx.emitter.localGet(accLocal);
      ctx.emitter.op(OP_I32_AND);
    } else {
      ctx.emitter.localGet(accLocal);
      ctx.emitter.op(OP_I32_OR);
    }
    ctx.emitter.localSet(accLocal);
  };

  if (isNbrPath) {
    const srcNode = firstSrcNode!;
    const nbrId = srcNode.data.config.neighborhoodId as string;
    const attrId = srcNode.data.config.attributeId as string;
    const nbr = getNbr(ctx.layout, nbrId);
    const attr = getAttr(ctx.layout, attrId);
    if (!nbr || !attr) {
      ctx.errors.push(`groupStatement: unknown nbr/attr (${nbrId}/${attrId})`);
      return null;
    }
    const elemValtype: ValType = attrValType(attr.type);
    // Sub-attribute iteration semantics: non-matching neighbors are EXCLUDED
    // entirely. "all" ops vacuously hold for the empty match set (acc stays at
    // 1); "any" ops vacuously fail (acc stays at 0). Matches JS `[].every(...)`
    // returning true and `[].some(...)` returning false.
    const sub = getSubAttrWasm(ctx, attrId);
    const nLocal = ctx.emitter.allocLocal(I32);
    ctx.emitter.i32Const(0);
    ctx.emitter.localSet(nLocal);
    ctx.emitter.block(() => {
      ctx.emitter.loop(() => {
        ctx.emitter.localGet(nLocal);
        ctx.emitter.i32Const(nbr.size);
        ctx.emitter.op(OP_I32_GE_S);
        ctx.emitter.brIf(1);
        // Compute neighbor cell idx, stash in local. Inline-neighbour mode
        // resolves slot nLocal's packed offset instead of the per-cell table.
        if (ctx.inlineNbr) {
          pushInlineNbrCellIdx(ctx, nbr, () => ctx.emitter.localGet(nLocal));
        } else {
          ctx.emitter.localGet(ctx.iLocalIdx);
          ctx.emitter.i32Const(nbr.size);
          ctx.emitter.op(OP_I32_MUL);
          ctx.emitter.localGet(nLocal);
          ctx.emitter.op(OP_I32_ADD);
          ctx.emitter.i32Const(4);
          ctx.emitter.op(OP_I32_MUL);
          ctx.emitter.i32Load(nbr.offset, 2);
        }
        const cellIdxLocal = ctx.emitter.allocLocal(I32);
        ctx.emitter.localSet(cellIdxLocal);

        const loadElem = () => {
          ctx.emitter.localGet(cellIdxLocal);
          ctx.emitter.i32Const(attr.itemBytes);
          ctx.emitter.op(OP_I32_MUL);
          if (attr.type === 'bool') ctx.emitter.i32Load8U(attr.readOffset, 0);
          else if (attr.type === 'float') ctx.emitter.f64Load(attr.readOffset, 3);
          else ctx.emitter.i32Load(attr.readOffset, 2);
        };

        if (sub) {
          emitParentMatchAtIdxWasm(ctx, sub.parent, sub.parentValuesInt, cellIdxLocal, false);
          ctx.emitter.ifThen(() => emitCmp(loadElem, elemValtype));
        } else {
          emitCmp(loadElem, elemValtype);
        }
        ctx.emitter.localGet(nLocal);
        ctx.emitter.i32Const(1);
        ctx.emitter.op(OP_I32_ADD);
        ctx.emitter.localSet(nLocal);
        ctx.emitter.br(0);
      });
    });
  } else if (arrayPath) {
    // Generic ArrayRef loop
    const arr = arrayPath.arr;
    const elemValtype = arr.elemValtype;
    const nLocal = ctx.emitter.allocLocal(I32);
    ctx.emitter.i32Const(0);
    ctx.emitter.localSet(nLocal);
    ctx.emitter.block(() => {
      ctx.emitter.loop(() => {
        ctx.emitter.localGet(nLocal);
        ctx.emitter.localGet(arr.lenLocal);
        ctx.emitter.op(OP_I32_GE_S);
        ctx.emitter.brIf(1);
        const loadElem = () => {
          ctx.emitter.localGet(nLocal);
          emitArrayLoadElem(ctx.emitter, arr);
        };
        emitCmp(loadElem, elemValtype);
        ctx.emitter.localGet(nLocal);
        ctx.emitter.i32Const(1);
        ctx.emitter.op(OP_I32_ADD);
        ctx.emitter.localSet(nLocal);
        ctx.emitter.br(0);
      });
    });
  } else {
    // Multi-scalar path
    let elemValtype: ValType = I32;
    const refs: LocalRef[] = [];
    for (const s of sources) {
      const r = compileValueNode(s.nodeId, ctx, s.portId);
      if (!r || r.localIdx < 0) {
        ctx.errors.push(`groupStatement: scalar source ${s.nodeId} not usable`);
        return null;
      }
      if (r.valtype === F64) elemValtype = F64;
      refs.push(r);
    }
    for (const ref of refs) {
      emitCmp(() => pushValueAs(ctx.emitter, ref, elemValtype), elemValtype);
    }
  }

  return { localIdx: accLocal, valtype: I32 };
}

// ---------------------------------------------------------------------------
// Aggregate / GroupCounting / GroupOperator shared implementation
//
// Three input shapes supported:
//   1) Single getNeighborsAttribute → loop over the neighbor index table.
//   2) Single ArrayRef-producing node → loop over the scratch array.
//   3) N scalar sources → each compiles to one value; combine sequentially.
// ---------------------------------------------------------------------------

/** Returns true if the node type produces an ArrayRef rather than a scalar
 *  LocalRef when consumed via compileArrayNode. Used to disambiguate the
 *  source path inside aggregate / groupCounting / groupStatement.
 *  Note: groupCounting is a hybrid — its `count` output is scalar but its
 *  `indexes` output is an array. When the consumer asks for `indexes` via
 *  resolveInputArray, we route to the array emitter. */
function isArrayProducer(nodeType: string): boolean {
  switch (nodeType) {
    case 'getNeighborIndexesByTags':
    case 'getAllNeighborIndexes':
    case 'filterNeighbors':
    case 'joinNeighbors':
    case 'getNeighborsAttrByIndexes':
    case 'groupCounting':
    case 'pickNRandomNeighbors':
    case 'getAllFacingLabels':
    case 'interactionTableMap':
    // getVariable is dual-mode: scalar variables dispatch through the value
    // path, array variables through the array path. Returning true here lets
    // array consumers (Aggregate, GroupOperator, ForEachInArray, etc.) reach
    // ARRAY_NODE_EMITTERS['getVariable']. The emitter throws an error if the
    // referenced variable is actually a scalar.
    case 'getVariable':
      return true;
    default:
      return false;
  }
}

/** Multi-output array node types: a single emit fills multiple ArrayRefs,
 *  one per output port. compileArrayNode disambiguates via portId, and the
 *  emitter manually populates the per-port slots in `ctx.arrayRefs`. */
const MULTI_OUTPUT_ARRAY_TYPES = new Set<string>([
  'getAllFacingLabels',
]);

/** Canonical default port for each multi-output array node — used when the
 *  caller doesn't pass a portId (e.g., legacy value-dispatch). MUST match
 *  the port the emitter returns from `emit()`. */
const MULTI_OUTPUT_ARRAY_DEFAULT_PORT: Record<string, string> = {
  getAllFacingLabels: 'myFaceLabels',
};

function emitAggregateOrCount(
  ctx: WasmCompileCtx,
  node: GraphNode,
  inputs: Record<string, ValueRef | undefined>,
  mode: 'aggregate' | 'count' | 'groupOperator',
): LocalRef | null {
  // Find the sources feeding the input port.
  const portKey = `${node.id}:values`;
  const sources = ctx.inputToSources.get(portKey) ?? [];
  if (sources.length === 0) {
    ctx.errors.push(`${mode}: no sources connected to "values" port`);
    return null;
  }
  const firstSrc = sources[0]!;
  const firstSrcNode = ctx.nodeMap.get(firstSrc.nodeId);
  const isNbrPath = sources.length === 1
    && firstSrcNode?.data.nodeType === 'getNeighborsAttribute';

  // Path 2: single ArrayRef-producing source
  if (sources.length === 1 && !isNbrPath
      && firstSrcNode && ctx.producesArray(firstSrcNode)) {
    // Pass src.portId so multi-output array sources (e.g., getAllFacingLabels'
    // myFaceLabels vs theirFaceLabels) resolve to the correct ArrayRef.
    const arr = compileArrayNode(firstSrc.nodeId, ctx, firstSrc.portId);
    if (!arr) return null;
    return emitArrayAggregate(ctx, node, inputs, arr, mode);
  }

  if (!isNbrPath) {
    return emitScalarAggregate(ctx, node, sources, mode);
  }

  const srcNode = firstSrcNode!;
  const nbrId = srcNode.data.config.neighborhoodId as string;
  const attrId = srcNode.data.config.attributeId as string;
  const nbr = getNbr(ctx.layout, nbrId);
  const attr = getAttr(ctx.layout, attrId);
  if (!nbr || !attr) {
    ctx.errors.push(`${mode}: unknown nbr/attr (${nbrId}/${attrId})`);
    return null;
  }

  // Operation — normalise across aggregate/groupOperator naming differences
  let op: string;
  if (mode === 'count') {
    op = 'count';
  } else {
    op = (node.data.config.operation as string) || 'sum';
    if (op === 'mul') op = 'product';
    if (op === 'mean') op = 'average';
    if (op === 'median') {
      // Median requires materialising into scratch first; route to ArrayRef path.
      // Sub-attributes filter while filling (only matching neighbors land in
      // the prefix), then sort the prefix and median-pick over it.
      return emitMedianViaScratchFromNbr(ctx, nbr, attr, getSubAttrWasm(ctx, attrId));
    }
    if (op === 'random') {
      // groupOperator random pick: choose uniform index in [0, size), fetch.
      // Sub-attribute path: filter matching neighbor values into scratch first,
      // then pick uniformly from the filtered length. RNG advances regardless
      // (matches JS's always-advance `_rs` semantics — drawn even on empty arrays).
      const subRand = getSubAttrWasm(ctx, attrId);
      if (subRand) {
        return emitRandomViaScratchFromSubAttrNbr(ctx, node, nbr, attr, subRand);
      }
      const indexLocal = pickRandomIndex(ctx, nbr.size);
      // Load element at that index from neighborhood (inline-neighbour mode
      // resolves the slot's packed offset instead of the per-cell table).
      if (ctx.inlineNbr) {
        pushInlineNbrCellIdx(ctx, nbr, () => ctx.emitter.localGet(indexLocal));
      } else {
        ctx.emitter.localGet(ctx.iLocalIdx);
        ctx.emitter.i32Const(nbr.size);
        ctx.emitter.op(OP_I32_MUL);
        ctx.emitter.localGet(indexLocal);
        ctx.emitter.op(OP_I32_ADD);
        ctx.emitter.i32Const(4);
        ctx.emitter.op(OP_I32_MUL);
        ctx.emitter.i32Load(nbr.offset, 2);
      }
      ctx.emitter.i32Const(attr.itemBytes);
      ctx.emitter.op(OP_I32_MUL);
      if (attr.type === 'bool') ctx.emitter.i32Load8U(attr.readOffset, 0);
      else if (attr.type === 'float') ctx.emitter.f64Load(attr.readOffset, 3);
      else ctx.emitter.i32Load(attr.readOffset, 2);
      const ref = storeResult(ctx.emitter, attrValType(attr.type));
      setCachedPort(ctx, node.id, 'index', { localIdx: indexLocal, valtype: I32 });
      setCachedPort(ctx, node.id, 'result', ref);
      return ref;
    }
  }

  // Sub-attribute support: iteration semantics exclude non-matching neighbors.
  // When the source attribute is a sub-attribute, we wrap the per-iteration
  // value-load + accumulate in `ifThen(parent_match)`, so non-matching cells
  // contribute nothing. For ops that need a divisor (average) or a position
  // index (groupOperator min/max), we also track `matchCountLocal` so the
  // post-divide and bestIdx semantics match JS (which iterates a variable-
  // length filtered scratch).
  const sub = getSubAttrWasm(ctx, attrId);

  // Determine value type for the loaded element
  const elemValtype = attrValType(attr.type);
  const accValtype = (mode === 'count') ? I32 : (op === 'and' || op === 'or') ? I32 : F64;

  // Allocate accumulator + counter
  const accLocal = ctx.emitter.allocLocal(accValtype);
  const nLocal = ctx.emitter.allocLocal(I32);

  // For groupOperator min/max, also track the current best index.
  const trackIndex = mode === 'groupOperator' && (op === 'min' || op === 'max');
  const bestIdxLocal = trackIndex ? ctx.emitter.allocLocal(I32) : -1;
  if (trackIndex) {
    ctx.emitter.i32Const(0);
    ctx.emitter.localSet(bestIdxLocal);
  }

  // Sub-attr match counter — drives the average divisor and (for groupOperator
  // min/max) the bestIdx position-in-filtered-set semantics.
  const matchCountLocal = sub ? ctx.emitter.allocLocal(I32) : -1;
  if (sub) {
    ctx.emitter.i32Const(0);
    ctx.emitter.localSet(matchCountLocal);
  }

  // Initialize accumulator
  if (mode === 'count') ctx.emitter.i32Const(0);
  else if (op === 'sum' || op === 'average') ctx.emitter.f64Const(0);
  else if (op === 'product') ctx.emitter.f64Const(1);
  else if (op === 'min') ctx.emitter.f64Const(Infinity);
  else if (op === 'max') ctx.emitter.f64Const(-Infinity);
  else if (op === 'and') ctx.emitter.i32Const(1);
  else if (op === 'or') ctx.emitter.i32Const(0);
  else { ctx.errors.push(`aggregate: unsupported op ${op}`); return null; }
  ctx.emitter.localSet(accLocal);

  // For count mode: target value(s) come from `compare` (and `compareHigh` for
  // between/notBetween). Operation: equals/notEquals/greater/lesser/between/notBetween.
  let countCmpOp: string = 'equals';
  let cmpRef: ValueRef | null = null;
  let cmpHighRef: ValueRef | null = null;
  if (mode === 'count') {
    countCmpOp = (node.data.config.operation as string) || 'equals';
    // Default 0 matches the JS GroupCountingNode (inputs['compare'] || '0').
    // Using 1 here was a long-standing parity bug — caused Wireworld and other
    // models with unwired compare ports to count the wrong values.
    cmpRef = inputs['compare'] ?? { inline: true, value: 0, valtype: elemValtype };
    if (countCmpOp === 'between' || countCmpOp === 'notBetween') {
      cmpHighRef = inputs['compareHigh'] ?? { inline: true, value: 0, valtype: elemValtype };
    }
  }

  // Loop: for n = 0; n < nbr.size; n++ { acc += neighbors[i*size + n]; }
  ctx.emitter.i32Const(0);
  ctx.emitter.localSet(nLocal);
  ctx.emitter.block(() => {
    ctx.emitter.loop(() => {
      // if (n >= nbrSize) br 1
      ctx.emitter.localGet(nLocal);
      ctx.emitter.i32Const(nbr.size);
      ctx.emitter.op(OP_I32_GE_S);
      ctx.emitter.brIf(1);

      // Compute neighbor cell index: nIdx[i*nbrSize + n] from memory at nbrOffset
      // Address = nbrOffset + (i*nbrSize + n) * 4. Inline-neighbour mode
      // resolves slot n's packed offset instead (no per-cell table).
      if (ctx.inlineNbr) {
        pushInlineNbrCellIdx(ctx, nbr, () => ctx.emitter.localGet(nLocal));
      } else {
        ctx.emitter.localGet(ctx.iLocalIdx);
        ctx.emitter.i32Const(nbr.size);
        ctx.emitter.op(OP_I32_MUL);
        ctx.emitter.localGet(nLocal);
        ctx.emitter.op(OP_I32_ADD);
        ctx.emitter.i32Const(4);
        ctx.emitter.op(OP_I32_MUL);
        ctx.emitter.i32Load(nbr.offset, 2); // load i32 neighbor idx
      }
      // Stash cell idx — used for both parent_match (sub-attr) and value load.
      const cellIdxLocal = ctx.emitter.allocLocal(I32);
      ctx.emitter.localSet(cellIdxLocal);

      // Inner work (load + accumulate). Called either unconditionally (regular
      // attr) or inside `ifThen(parent_match)` (sub-attribute).
      const innerWork = () => {
        // Increment match counter for sub-attrs (used by post-divide and bestIdx)
        if (matchCountLocal >= 0) {
          ctx.emitter.localGet(matchCountLocal);
          ctx.emitter.i32Const(1);
          ctx.emitter.op(OP_I32_ADD);
          ctx.emitter.localSet(matchCountLocal);
        }
        // Compute byte offset and load value from the neighbor cell
        ctx.emitter.localGet(cellIdxLocal);
        ctx.emitter.i32Const(attr.itemBytes);
        ctx.emitter.op(OP_I32_MUL);
        if (attr.type === 'bool') ctx.emitter.i32Load8U(attr.readOffset, 0);
        else if (attr.type === 'float') ctx.emitter.f64Load(attr.readOffset, 3);
        else ctx.emitter.i32Load(attr.readOffset, 2);

        // Combine into accumulator
        if (mode === 'count') {
          // Stack: [loadedValue]
          // Stash to a fresh local so we can re-push for between's two compares.
          const elemLocal = ctx.emitter.allocLocal(elemValtype);
          ctx.emitter.localSet(elemLocal);
          const lo = (node.data.config.lowOp as string) === '>' ? '>' : '>=';
          const hi = (node.data.config.highOp as string) === '<' ? '<' : '<=';
          const emitCmp = (cmpOp: string, ref: ValueRef) => {
            ctx.emitter.localGet(elemLocal);
            pushValueAs(ctx.emitter, ref, elemValtype);
            if (elemValtype === F64) ctx.emitter.op(cmpToF64Op(cmpOp));
            else ctx.emitter.op(cmpToI32Op(cmpOp));
          };
          switch (countCmpOp) {
            case 'notEquals': emitCmp('!=', cmpRef!); break;
            case 'greater':   emitCmp('>',  cmpRef!); break;
            case 'lesser':    emitCmp('<',  cmpRef!); break;
            case 'between':
              emitCmp(lo, cmpRef!);
              emitCmp(hi, cmpHighRef!);
              ctx.emitter.op(OP_I32_AND);
              break;
            case 'notBetween':
              emitCmp(lo, cmpRef!);
              emitCmp(hi, cmpHighRef!);
              ctx.emitter.op(OP_I32_AND);
              ctx.emitter.op(OP_I32_EQZ);
              break;
            default: emitCmp('==', cmpRef!); break;
          }
          // if (matched) acc++
          ctx.emitter.ifThen(() => {
            ctx.emitter.localGet(accLocal);
            ctx.emitter.i32Const(1);
            ctx.emitter.op(OP_I32_ADD);
            ctx.emitter.localSet(accLocal);
          });
        } else {
          // aggregate: depends on op
          // Promote loaded value to f64 if accumulating in f64
          if (accValtype === F64 && elemValtype === I32) ctx.emitter.i32ToF64();
          if (accValtype === I32 && elemValtype === F64) ctx.emitter.f64ToI32();

          if (trackIndex) {
            // Stash loaded value into a local so we can compare AND maybe assign.
            const elemLocal = ctx.emitter.allocLocal(F64);
            ctx.emitter.localSet(elemLocal);
            // Compare: elem < acc (for min) or elem > acc (for max)
            ctx.emitter.localGet(elemLocal);
            ctx.emitter.localGet(accLocal);
            ctx.emitter.op(op === 'min' ? OP_F64_LT : OP_F64_GT);
            ctx.emitter.ifThen(() => {
              ctx.emitter.localGet(elemLocal);
              ctx.emitter.localSet(accLocal);
              // Use position-in-filtered-set for sub-attrs (matches JS) — that's
              // matchCount - 1 since we just incremented it above. For regular
              // attrs, use the neighborhood iteration index `nLocal`.
              if (matchCountLocal >= 0) {
                ctx.emitter.localGet(matchCountLocal);
                ctx.emitter.i32Const(1);
                ctx.emitter.op(OP_I32_SUB);
                ctx.emitter.localSet(bestIdxLocal);
              } else {
                ctx.emitter.localGet(nLocal);
                ctx.emitter.localSet(bestIdxLocal);
              }
            });
          } else {
            // Now acc combines with elem
            switch (op) {
              case 'sum':
              case 'average':
                ctx.emitter.localGet(accLocal);
                ctx.emitter.op(OP_F64_ADD);
                ctx.emitter.localSet(accLocal);
                break;
              case 'product':
                ctx.emitter.localGet(accLocal);
                ctx.emitter.op(OP_F64_MUL);
                ctx.emitter.localSet(accLocal);
                break;
              case 'min':
                ctx.emitter.localGet(accLocal);
                ctx.emitter.op(OP_F64_MIN);
                ctx.emitter.localSet(accLocal);
                break;
              case 'max':
                ctx.emitter.localGet(accLocal);
                ctx.emitter.op(OP_F64_MAX);
                ctx.emitter.localSet(accLocal);
                break;
              // Normalise the (raw i32) element to 0/1 before the bitwise fold so
              // a non-0/1 array element (e.g. an int/tag attr value) matches the
              // JS truthiness semantics + WebGPU's bool accumulator. acc stays 0/1.
              case 'and':
                ctx.emitter.i32Const(0);
                ctx.emitter.op(OP_I32_NE_OP);
                ctx.emitter.localGet(accLocal);
                ctx.emitter.op(OP_I32_AND);
                ctx.emitter.localSet(accLocal);
                break;
              case 'or':
                ctx.emitter.i32Const(0);
                ctx.emitter.op(OP_I32_NE_OP);
                ctx.emitter.localGet(accLocal);
                ctx.emitter.op(OP_I32_OR);
                ctx.emitter.localSet(accLocal);
                break;
            }
          }
        }
      };

      if (sub) {
        emitParentMatchAtIdxWasm(ctx, sub.parent, sub.parentValuesInt, cellIdxLocal, false);
        ctx.emitter.ifThen(innerWork);
      } else {
        innerWork();
      }

      // n += 1; br 0 (continue loop)
      ctx.emitter.localGet(nLocal);
      ctx.emitter.i32Const(1);
      ctx.emitter.op(OP_I32_ADD);
      ctx.emitter.localSet(nLocal);
      ctx.emitter.br(0);
    });
  });

  // Average post-divide. For sub-attrs, divide by matchCount; for regular
  // attrs, divide by the fixed neighborhood size.
  if (op === 'average') {
    if (matchCountLocal >= 0) {
      // matchCount > 0 ? acc / matchCount : 0
      ctx.emitter.localGet(matchCountLocal);
      ctx.emitter.i32Const(0);
      ctx.emitter.op(OP_I32_GT_S);
      ctx.emitter.ifThenElse(
        () => {
          ctx.emitter.localGet(accLocal);
          ctx.emitter.localGet(matchCountLocal);
          ctx.emitter.i32ToF64();
          ctx.emitter.op(OP_F64_DIV);
          ctx.emitter.localSet(accLocal);
        },
        () => {
          ctx.emitter.f64Const(0);
          ctx.emitter.localSet(accLocal);
        },
      );
    } else {
      ctx.emitter.localGet(accLocal);
      ctx.emitter.f64Const(nbr.size || 1);
      ctx.emitter.op(OP_F64_DIV);
      ctx.emitter.localSet(accLocal);
    }
  }

  // Multi-output nodes need their non-default port refs cached explicitly
  // (the wrapper in compileValueNode only caches 'value' + the SINGLE output
  // port name; both groupCounting and groupOperator have two output ports,
  // so the wrapper's auto-cache for the named port skips). Without these
  // explicit caches, value sinking re-emits the entire aggregate loop on the
  // second access (under a different cache key) and aliases consumers in
  // sibling branches to a local that's only written inside one branch —
  // observed as Game of Life births failing because the count-comparison
  // reads `0` from an unset local.
  if (mode === 'count') {
    setCachedPort(ctx, node.id, 'count', { localIdx: accLocal, valtype: accValtype });
  }
  if (mode === 'groupOperator') {
    setCachedPort(ctx, node.id, 'result', { localIdx: accLocal, valtype: accValtype });
    if (trackIndex) {
      setCachedPort(ctx, node.id, 'index', { localIdx: bestIdxLocal, valtype: I32 });
    }
  }
  return { localIdx: accLocal, valtype: accValtype };
}

/** xorshift32 → integer in [0, n). Returns the i32 local containing the index. */
function pickRandomIndex(ctx: WasmCompileCtx, n: number): number {
  const em = ctx.emitter;
  // Advance _rs (xorshift32)
  const rsLocal = em.allocLocal(I32);
  em.i32Const(0);
  em.i32Load(ctx.layout.rngStateOffset, 2);
  em.localSet(rsLocal);
  em.localGet(rsLocal); em.localGet(rsLocal); em.i32Const(13); em.emit(byte(0x74)); em.emit(byte(0x73)); em.localSet(rsLocal);
  em.localGet(rsLocal); em.localGet(rsLocal); em.i32Const(17); em.emit(byte(0x76)); em.emit(byte(0x73)); em.localSet(rsLocal);
  em.localGet(rsLocal); em.localGet(rsLocal); em.i32Const(5);  em.emit(byte(0x74)); em.emit(byte(0x73)); em.localSet(rsLocal);
  em.i32Const(0); em.localGet(rsLocal); em.i32Store(ctx.layout.rngStateOffset, 2);
  // f64 = unsigned(_rs) / 2^32; idx = (f64 * n) | 0
  em.localGet(rsLocal);
  em.op(OP_F64_CONVERT_I32_U);
  em.f64Const(4294967296);
  em.op(OP_F64_DIV);
  em.f64Const(n);
  em.op(OP_F64_MUL);
  em.f64ToI32();
  const idxLocal = em.allocLocal(I32);
  em.localSet(idxLocal);
  return idxLocal;
}

/** aggregate median via scratch: copy nbr values into scratch, insertion-sort, take middle.
 *  Used when mode=aggregate, op=median, source=getNeighborsAttribute.
 *
 *  Sub-attribute handling: when `sub` is non-null, the fill loop is wrapped
 *  in `ifThen(parent_match)` and the scratch slot index uses a separate
 *  `filledLocal` counter so only matching neighbors land in the prefix.
 *  `lenLocal` is then narrowed to `filledLocal`, so the in-place insertion
 *  sort + median pick operate over the filtered prefix only. The over-
 *  allocated scratch tail past `filledLocal` is harmless (never read).
 *  Empty filtered set returns 0 (matches the JS AggregateNode contract). */
function emitMedianViaScratchFromNbr(
  ctx: WasmCompileCtx,
  nbr: NbrInfo,
  attr: AttrInfo,
  sub: WasmSubAttrInfo | null,
): LocalRef | null {
  const em = ctx.emitter;
  const elemValtype = F64;
  const elemBytes = 8;
  // Materialise into scratch as f64s. Worst-case capacity = nbr.size.
  const lenLocal = em.allocLocal(I32);
  em.i32Const(nbr.size);
  em.localSet(lenLocal);
  const arr = allocArrayInScratch(ctx, lenLocal, elemValtype, elemBytes);

  // Sub-attr: track the "next write" slot. Without sub, slot == kLoc.
  const filledLocal = sub ? em.allocLocal(I32) : -1;
  if (sub) {
    em.i32Const(0);
    em.localSet(filledLocal);
  }

  // Fill: for k=0..n-1: optionally guarded by parent_match.
  const kLoc = em.allocLocal(I32);
  em.i32Const(0); em.localSet(kLoc);
  em.block(() => {
    em.loop(() => {
      em.localGet(kLoc); em.i32Const(nbr.size); em.op(OP_I32_GE_S); em.brIf(1);
      // Resolve neighbor cell idx and stash (used for parent_match + value load).
      // Inline-neighbour mode resolves slot kLoc's packed offset (no per-cell table).
      if (ctx.inlineNbr) {
        pushInlineNbrCellIdx(ctx, nbr, () => em.localGet(kLoc));
      } else {
        em.localGet(ctx.iLocalIdx); em.i32Const(nbr.size); em.op(OP_I32_MUL);
        em.localGet(kLoc); em.op(OP_I32_ADD);
        em.i32Const(4); em.op(OP_I32_MUL);
        em.i32Load(nbr.offset, 2);
      }
      const cellIdxLocal = em.allocLocal(I32);
      em.localSet(cellIdxLocal);

      const writeSlot = () => {
        // address: arr.offsetLocal + slot*8 (slot = filledLocal if sub, else kLoc)
        if (sub) em.localGet(filledLocal);
        else em.localGet(kLoc);
        em.i32Const(8); em.op(OP_I32_MUL);
        em.localGet(arr.offsetLocal); em.op(OP_I32_ADD);
        // value: load attr at cellIdxLocal, promote to f64
        em.localGet(cellIdxLocal);
        em.i32Const(attr.itemBytes); em.op(OP_I32_MUL);
        if (attr.type === 'bool') em.i32Load8U(attr.readOffset, 0);
        else if (attr.type === 'float') em.f64Load(attr.readOffset, 3);
        else em.i32Load(attr.readOffset, 2);
        if (attr.type !== 'float') em.i32ToF64();
        em.f64Store(0, 3);
        if (sub) {
          em.localGet(filledLocal); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(filledLocal);
        }
      };

      if (sub) {
        emitParentMatchAtIdxWasm(ctx, sub.parent, sub.parentValuesInt, cellIdxLocal, false);
        em.ifThen(writeSlot);
      } else {
        writeSlot();
      }

      em.localGet(kLoc); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(kLoc);
      em.br(0);
    });
  });

  // For sub-attrs, narrow lenLocal so the sort + median pick operate on the
  // filtered prefix. arr.lenLocal === lenLocal (same local).
  if (sub) {
    em.localGet(filledLocal);
    em.localSet(lenLocal);
  }

  insertionSortF64(ctx, arr);

  // Median: empty-set → 0 (matches JS AggregateNode contract); even → mean of
  // middle two; odd → middle. (n & 1) == 0 means even.
  const result = em.allocLocal(F64);
  em.localGet(lenLocal);
  em.i32Const(0);
  em.op(OP_I32_EQ);
  em.ifThenElse(
    () => {
      em.f64Const(0);
      em.localSet(result);
    },
    () => {
      em.localGet(lenLocal);
      em.i32Const(1); em.op(OP_I32_AND);
      em.op(OP_I32_EQZ);
      em.ifThenElse(
        () => {
          // (arr[n/2-1] + arr[n/2]) / 2
          em.localGet(lenLocal); em.i32Const(2); em.op(OP_I32_DIV_S);
          em.i32Const(1); em.op(OP_I32_SUB);
          em.i32Const(8); em.op(OP_I32_MUL);
          em.localGet(arr.offsetLocal); em.op(OP_I32_ADD);
          em.f64Load(0, 3);
          em.localGet(lenLocal); em.i32Const(2); em.op(OP_I32_DIV_S);
          em.i32Const(8); em.op(OP_I32_MUL);
          em.localGet(arr.offsetLocal); em.op(OP_I32_ADD);
          em.f64Load(0, 3);
          em.op(OP_F64_ADD);
          em.f64Const(2);
          em.op(OP_F64_DIV);
          em.localSet(result);
        },
        () => {
          // arr[(n-1)/2]
          em.localGet(lenLocal); em.i32Const(1); em.op(OP_I32_SUB);
          em.i32Const(2); em.op(OP_I32_DIV_S);
          em.i32Const(8); em.op(OP_I32_MUL);
          em.localGet(arr.offsetLocal); em.op(OP_I32_ADD);
          em.f64Load(0, 3);
          em.localSet(result);
        },
      );
    },
  );
  return { localIdx: result, valtype: F64 };
}

/** groupOperator.random over a sub-attribute neighborhood source.
 *
 *  Filters matching neighbor values into scratch, then picks uniformly from
 *  the filtered length. RNG advances regardless of filtered length (matches
 *  JS's always-advance `_rs` semantics on empty arrays). Empty filtered set returns
 *  0 — closest typed-array analog to JS `arr[0] === undefined` propagating
 *  to a typed-array write as 0 (int/bool) or NaN-coerced-to-0 elsewhere.
 *  The `index` output port is the position in the FILTERED set (matches JS,
 *  which routes random via getNeighborsAttribute filter-with-push). */
function emitRandomViaScratchFromSubAttrNbr(
  ctx: WasmCompileCtx,
  node: GraphNode,
  nbr: NbrInfo,
  attr: AttrInfo,
  sub: WasmSubAttrInfo,
): LocalRef | null {
  const em = ctx.emitter;
  const elemValtype = attrValType(attr.type);
  const elemBytes = attr.itemBytes;

  // Worst-case capacity = nbr.size. The filtered prefix is populated below.
  const lenLocal = em.allocLocal(I32);
  em.i32Const(nbr.size);
  em.localSet(lenLocal);
  const arr = allocArrayInScratch(ctx, lenLocal, elemValtype, elemBytes);

  const filledLocal = em.allocLocal(I32);
  em.i32Const(0);
  em.localSet(filledLocal);

  // Fill loop with parent_match guard.
  const kLoc = em.allocLocal(I32);
  em.i32Const(0); em.localSet(kLoc);
  em.block(() => {
    em.loop(() => {
      em.localGet(kLoc); em.i32Const(nbr.size); em.op(OP_I32_GE_S); em.brIf(1);

      // Inline-neighbour mode: resolve slot kLoc's packed offset (no per-cell table).
      if (ctx.inlineNbr) {
        pushInlineNbrCellIdx(ctx, nbr, () => em.localGet(kLoc));
      } else {
        em.localGet(ctx.iLocalIdx); em.i32Const(nbr.size); em.op(OP_I32_MUL);
        em.localGet(kLoc); em.op(OP_I32_ADD);
        em.i32Const(4); em.op(OP_I32_MUL);
        em.i32Load(nbr.offset, 2);
      }
      const cellIdxLocal = em.allocLocal(I32);
      em.localSet(cellIdxLocal);

      emitParentMatchAtIdxWasm(ctx, sub.parent, sub.parentValuesInt, cellIdxLocal, false);
      em.ifThen(() => {
        // arr[filledLocal] = value at cellIdxLocal — store typed by attr.
        em.localGet(filledLocal);
        em.i32Const(elemBytes); em.op(OP_I32_MUL);
        em.localGet(arr.offsetLocal); em.op(OP_I32_ADD);
        em.localGet(cellIdxLocal);
        em.i32Const(attr.itemBytes); em.op(OP_I32_MUL);
        if (attr.type === 'bool') em.i32Load8U(attr.readOffset, 0);
        else if (attr.type === 'float') em.f64Load(attr.readOffset, 3);
        else em.i32Load(attr.readOffset, 2);
        if (attr.type === 'bool') em.i32Store8(0, 0);
        else if (attr.type === 'float') em.f64Store(0, 3);
        else em.i32Store(0, 2);
        em.localGet(filledLocal); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(filledLocal);
      });

      em.localGet(kLoc); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(kLoc);
      em.br(0);
    });
  });

  // Advance RNG (unconditional — matches JS behavior on empty arrays).
  const rsLocal = em.allocLocal(I32);
  em.i32Const(0); em.i32Load(ctx.layout.rngStateOffset, 2); em.localSet(rsLocal);
  em.localGet(rsLocal); em.localGet(rsLocal); em.i32Const(13); em.op(OP_I32_SHL); em.op(OP_I32_XOR); em.localSet(rsLocal);
  em.localGet(rsLocal); em.localGet(rsLocal); em.i32Const(17); em.op(OP_I32_SHR_U); em.op(OP_I32_XOR); em.localSet(rsLocal);
  em.localGet(rsLocal); em.localGet(rsLocal); em.i32Const(5);  em.op(OP_I32_SHL); em.op(OP_I32_XOR); em.localSet(rsLocal);
  em.i32Const(0); em.localGet(rsLocal); em.i32Store(ctx.layout.rngStateOffset, 2);

  // Random index in [0, filledLocal). When filledLocal == 0, idx == 0.
  em.localGet(rsLocal);
  em.op(OP_F64_CONVERT_I32_U);
  em.f64Const(4294967296); em.op(OP_F64_DIV);
  em.localGet(filledLocal); em.i32ToF64();
  em.op(OP_F64_MUL);
  em.f64ToI32();
  const idxLocal = em.allocLocal(I32);
  em.localSet(idxLocal);

  // Result: if filled > 0, arr[idx]; else 0 (closest defined analog to JS
  // `arr[0] === undefined` for empty array, which writes as 0 to typed arrays).
  const resultLocal = em.allocLocal(elemValtype);
  em.localGet(filledLocal);
  em.i32Const(0);
  em.op(OP_I32_GT_S);
  em.ifThenElse(
    () => {
      em.localGet(idxLocal);
      em.i32Const(elemBytes); em.op(OP_I32_MUL);
      em.localGet(arr.offsetLocal); em.op(OP_I32_ADD);
      if (attr.type === 'bool') em.i32Load8U(0, 0);
      else if (attr.type === 'float') em.f64Load(0, 3);
      else em.i32Load(0, 2);
      em.localSet(resultLocal);
    },
    () => {
      if (attr.type === 'float') em.f64Const(0);
      else em.i32Const(0);
      em.localSet(resultLocal);
    },
  );

  const ref: LocalRef = { localIdx: resultLocal, valtype: elemValtype };
  setCachedPort(ctx, node.id, 'index', { localIdx: idxLocal, valtype: I32 });
  setCachedPort(ctx, node.id, 'result', ref);
  return ref;
}

/** In-place insertion sort of an f64 ArrayRef. Stable enough for median use. */
function insertionSortF64(ctx: WasmCompileCtx, arr: ArrayRef): void {
  const em = ctx.emitter;
  const i = em.allocLocal(I32);
  const j = em.allocLocal(I32);
  const key = em.allocLocal(F64);
  em.i32Const(1); em.localSet(i);
  em.block(() => {
    em.loop(() => {
      em.localGet(i); em.localGet(arr.lenLocal); em.op(OP_I32_GE_S); em.brIf(1);
      // key = arr[i]
      em.localGet(i); em.i32Const(arr.elemBytes); em.op(OP_I32_MUL);
      em.localGet(arr.offsetLocal); em.op(OP_I32_ADD);
      em.f64Load(0, 3);
      em.localSet(key);
      // j = i - 1
      em.localGet(i); em.i32Const(1); em.op(OP_I32_SUB); em.localSet(j);
      // while (j >= 0 && arr[j] > key) { arr[j+1] = arr[j]; j-- }
      em.block(() => {
        em.loop(() => {
          // condition exit: j < 0
          em.localGet(j); em.i32Const(0); em.op(OP_I32_LT_S); em.brIf(1);
          // arr[j] > key?
          em.localGet(j); em.i32Const(arr.elemBytes); em.op(OP_I32_MUL);
          em.localGet(arr.offsetLocal); em.op(OP_I32_ADD);
          em.f64Load(0, 3);
          em.localGet(key);
          em.op(OP_F64_GT);
          em.op(OP_I32_EQZ);
          em.brIf(1); // exit when arr[j] <= key
          // arr[j+1] = arr[j]
          em.localGet(j); em.i32Const(1); em.op(OP_I32_ADD);
          em.i32Const(arr.elemBytes); em.op(OP_I32_MUL);
          em.localGet(arr.offsetLocal); em.op(OP_I32_ADD);
          em.localGet(j); em.i32Const(arr.elemBytes); em.op(OP_I32_MUL);
          em.localGet(arr.offsetLocal); em.op(OP_I32_ADD);
          em.f64Load(0, 3);
          em.f64Store(0, 3);
          em.localGet(j); em.i32Const(1); em.op(OP_I32_SUB); em.localSet(j);
          em.br(0);
        });
      });
      // arr[j+1] = key
      em.localGet(j); em.i32Const(1); em.op(OP_I32_ADD);
      em.i32Const(arr.elemBytes); em.op(OP_I32_MUL);
      em.localGet(arr.offsetLocal); em.op(OP_I32_ADD);
      em.localGet(key);
      em.f64Store(0, 3);
      em.localGet(i); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(i);
      em.br(0);
    });
  });
}

/**
 * aggregate / count / groupOperator over a generic ArrayRef. Mirrors the nbr-path
 * structure but uses `lenLocal` as the loop bound and `emitArrayLoadElem` to
 * fetch elements.
 */
function emitArrayAggregate(
  ctx: WasmCompileCtx,
  node: GraphNode,
  inputs: Record<string, ValueRef | undefined>,
  arr: ArrayRef,
  mode: 'aggregate' | 'count' | 'groupOperator',
): LocalRef | null {
  const em = ctx.emitter;
  let op: string;
  if (mode === 'count') {
    op = 'count';
  } else {
    op = (node.data.config.operation as string) || 'sum';
    if (op === 'mul') op = 'product';
    if (op === 'mean') op = 'average';
    if (op === 'median') {
      // Materialise sort + take middle (in place if elemValtype == F64).
      // For simplicity, copy into a fresh f64 scratch slice.
      // Slow path but rarely used; correctness > speed.
      const fresh = allocArrayInScratch(ctx, arr.lenLocal, F64, 8);
      const k = em.allocLocal(I32);
      em.i32Const(0); em.localSet(k);
      em.block(() => {
        em.loop(() => {
          em.localGet(k); em.localGet(arr.lenLocal); em.op(OP_I32_GE_S); em.brIf(1);
          // dst addr
          em.localGet(k); em.i32Const(8); em.op(OP_I32_MUL);
          em.localGet(fresh.offsetLocal); em.op(OP_I32_ADD);
          // src value
          em.localGet(k);
          emitArrayLoadElem(em, arr);
          if (arr.elemValtype !== F64) em.i32ToF64();
          em.f64Store(0, 3);
          em.localGet(k); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(k);
          em.br(0);
        });
      });
      insertionSortF64(ctx, fresh);
      const result = em.allocLocal(F64);
      em.localGet(arr.lenLocal); em.i32Const(1); em.op(OP_I32_AND); em.op(OP_I32_EQZ);
      em.ifThenElse(
        () => {
          em.localGet(arr.lenLocal); em.i32Const(2); em.emit(byte(0x6d)); em.i32Const(1); em.op(OP_I32_SUB);
          em.i32Const(8); em.op(OP_I32_MUL);
          em.localGet(fresh.offsetLocal); em.op(OP_I32_ADD);
          em.f64Load(0, 3);
          em.localGet(arr.lenLocal); em.i32Const(2); em.emit(byte(0x6d));
          em.i32Const(8); em.op(OP_I32_MUL);
          em.localGet(fresh.offsetLocal); em.op(OP_I32_ADD);
          em.f64Load(0, 3);
          em.op(OP_F64_ADD);
          em.f64Const(2); em.op(OP_F64_DIV);
          em.localSet(result);
        },
        () => {
          em.localGet(arr.lenLocal); em.i32Const(1); em.op(OP_I32_SUB);
          em.i32Const(2); em.emit(byte(0x6d));
          em.i32Const(8); em.op(OP_I32_MUL);
          em.localGet(fresh.offsetLocal); em.op(OP_I32_ADD);
          em.f64Load(0, 3);
          em.localSet(result);
        },
      );
      return { localIdx: result, valtype: F64 };
    }
    if (op === 'random') {
      // groupOperator random pick: idx = floor(rand * len); elem = arr[idx]
      const em = ctx.emitter;
      // Reuse pickRandomIndex to advance RNG, but we need len-driven range, so
      // do it inline.
      const rsLocal = em.allocLocal(I32);
      em.i32Const(0); em.i32Load(ctx.layout.rngStateOffset, 2); em.localSet(rsLocal);
      em.localGet(rsLocal); em.localGet(rsLocal); em.i32Const(13); em.emit(byte(0x74)); em.emit(byte(0x73)); em.localSet(rsLocal);
      em.localGet(rsLocal); em.localGet(rsLocal); em.i32Const(17); em.emit(byte(0x76)); em.emit(byte(0x73)); em.localSet(rsLocal);
      em.localGet(rsLocal); em.localGet(rsLocal); em.i32Const(5);  em.emit(byte(0x74)); em.emit(byte(0x73)); em.localSet(rsLocal);
      em.i32Const(0); em.localGet(rsLocal); em.i32Store(ctx.layout.rngStateOffset, 2);
      em.localGet(rsLocal);
      em.op(OP_F64_CONVERT_I32_U);
      em.f64Const(4294967296); em.op(OP_F64_DIV);
      em.localGet(arr.lenLocal); em.i32ToF64();
      em.op(OP_F64_MUL);
      em.f64ToI32();
      const idxLocal = em.allocLocal(I32);
      em.localSet(idxLocal);
      // Load element at idxLocal
      em.localGet(idxLocal);
      emitArrayLoadElem(em, arr);
      const ref = storeResult(em, arr.elemValtype);
      setCachedPort(ctx, node.id, 'index', { localIdx: idxLocal, valtype: I32 });
      setCachedPort(ctx, node.id, 'result', ref);
      return ref;
    }
    if (op === 'weightedRandom') {
      // Cumulative-sum sampling over the array. Empty / zero-sum → index = -1,
      // result = 0. RNG always advances.
      // Advance _rs once.
      const rsLocal = em.allocLocal(I32);
      em.i32Const(0); em.i32Load(ctx.layout.rngStateOffset, 2); em.localSet(rsLocal);
      em.localGet(rsLocal); em.localGet(rsLocal); em.i32Const(13); em.emit(byte(0x74)); em.emit(byte(0x73)); em.localSet(rsLocal);
      em.localGet(rsLocal); em.localGet(rsLocal); em.i32Const(17); em.emit(byte(0x76)); em.emit(byte(0x73)); em.localSet(rsLocal);
      em.localGet(rsLocal); em.localGet(rsLocal); em.i32Const(5);  em.emit(byte(0x74)); em.emit(byte(0x73)); em.localSet(rsLocal);
      em.i32Const(0); em.localGet(rsLocal); em.i32Store(ctx.layout.rngStateOffset, 2);

      // sum = sum(arr[i] as f64)
      const sumLocal = em.allocLocal(F64);
      em.f64Const(0); em.localSet(sumLocal);
      const si = em.allocLocal(I32);
      em.i32Const(0); em.localSet(si);
      em.block(() => {
        em.loop(() => {
          em.localGet(si); em.localGet(arr.lenLocal); em.op(OP_I32_GE_S); em.brIf(1);
          em.localGet(sumLocal);
          em.localGet(si); emitArrayLoadElem(em, arr);
          if (arr.elemValtype !== F64) em.op(OP_F64_CONVERT_I32_S);
          em.op(OP_F64_ADD); em.localSet(sumLocal);
          em.localGet(si); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(si);
          em.br(0);
        });
      });

      const idxLocal = em.allocLocal(I32);
      em.i32Const(-1); em.localSet(idxLocal);
      const resLocal = em.allocLocal(F64);
      em.f64Const(0); em.localSet(resLocal);

      em.localGet(sumLocal); em.f64Const(0); em.op(OP_F64_GT);
      em.ifThen(() => {
        const uLocal = em.allocLocal(F64);
        em.localGet(rsLocal);
        em.op(OP_F64_CONVERT_I32_U);
        em.f64Const(4294967296); em.op(OP_F64_DIV);
        em.localGet(sumLocal); em.op(OP_F64_MUL);
        em.localSet(uLocal);
        const accLocal = em.allocLocal(F64);
        em.f64Const(0); em.localSet(accLocal);
        const i = em.allocLocal(I32);
        em.i32Const(0); em.localSet(i);
        em.block(() => {
          em.loop(() => {
            em.localGet(i); em.localGet(arr.lenLocal); em.op(OP_I32_GE_S); em.brIf(1);
            const wHere = em.allocLocal(F64);
            em.localGet(i); emitArrayLoadElem(em, arr);
            if (arr.elemValtype !== F64) em.op(OP_F64_CONVERT_I32_S);
            em.localSet(wHere);
            em.localGet(accLocal); em.localGet(wHere); em.op(OP_F64_ADD); em.localSet(accLocal);
            em.localGet(uLocal); em.localGet(accLocal); em.op(OP_F64_LT);
            em.ifThen(() => {
              em.localGet(i); em.localSet(idxLocal);
              em.localGet(wHere); em.localSet(resLocal);
              em.br(2); // break out of loop+block
            });
            em.localGet(i); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(i);
            em.br(0);
          });
        });
        // FP-drift fallback: pick last
        em.localGet(idxLocal); em.i32Const(0); em.op(OP_I32_LT_S);
        em.ifThen(() => {
          em.localGet(arr.lenLocal); em.i32Const(1); em.op(OP_I32_SUB); em.localSet(idxLocal);
          em.localGet(idxLocal); emitArrayLoadElem(em, arr);
          if (arr.elemValtype !== F64) em.op(OP_F64_CONVERT_I32_S);
          em.localSet(resLocal);
        });
      });

      setCachedPort(ctx, node.id, 'index', { localIdx: idxLocal, valtype: I32 });
      setCachedPort(ctx, node.id, 'result', { localIdx: resLocal, valtype: F64 });
      return { localIdx: resLocal, valtype: F64 };
    }
  }

  const elemValtype = arr.elemValtype;
  const accValtype = (mode === 'count') ? I32 : (op === 'and' || op === 'or') ? I32 : F64;

  const accLocal = em.allocLocal(accValtype);
  const nLocal = em.allocLocal(I32);

  const trackIndex = mode === 'groupOperator' && (op === 'min' || op === 'max');
  const bestIdxLocal = trackIndex ? em.allocLocal(I32) : -1;
  if (trackIndex) { em.i32Const(0); em.localSet(bestIdxLocal); }

  if (mode === 'count') em.i32Const(0);
  else if (op === 'sum' || op === 'average') em.f64Const(0);
  else if (op === 'product') em.f64Const(1);
  else if (op === 'min') em.f64Const(Infinity);
  else if (op === 'max') em.f64Const(-Infinity);
  else if (op === 'and') em.i32Const(1);
  else if (op === 'or') em.i32Const(0);
  else { ctx.errors.push(`arrayAggregate: unsupported op ${op}`); return null; }
  em.localSet(accLocal);

  let countCmpOp = 'equals';
  let cmpRef: ValueRef | null = null;
  let cmpHighRef: ValueRef | null = null;
  if (mode === 'count') {
    countCmpOp = (node.data.config.operation as string) || 'equals';
    // Match JS GroupCountingNode default ('0' when compare is unwired).
    cmpRef = inputs['compare'] ?? { inline: true, value: 0, valtype: elemValtype };
    if (countCmpOp === 'between' || countCmpOp === 'notBetween') {
      cmpHighRef = inputs['compareHigh'] ?? { inline: true, value: 0, valtype: elemValtype };
    }
  }

  em.i32Const(0); em.localSet(nLocal);
  em.block(() => {
    em.loop(() => {
      em.localGet(nLocal); em.localGet(arr.lenLocal); em.op(OP_I32_GE_S); em.brIf(1);
      // Load element via array helper (n on top → value)
      em.localGet(nLocal);
      emitArrayLoadElem(em, arr);

      if (mode === 'count') {
        const elemLocal = em.allocLocal(elemValtype);
        em.localSet(elemLocal);
        const lo = (node.data.config.lowOp as string) === '>' ? '>' : '>=';
        const hi = (node.data.config.highOp as string) === '<' ? '<' : '<=';
        const emitCmp = (cmpOp: string, ref: ValueRef) => {
          em.localGet(elemLocal);
          pushValueAs(em, ref, elemValtype);
          if (elemValtype === F64) em.op(cmpToF64Op(cmpOp));
          else em.op(cmpToI32Op(cmpOp));
        };
        switch (countCmpOp) {
          case 'notEquals': emitCmp('!=', cmpRef!); break;
          case 'greater':   emitCmp('>',  cmpRef!); break;
          case 'lesser':    emitCmp('<',  cmpRef!); break;
          case 'between':
            emitCmp(lo, cmpRef!);
            emitCmp(hi, cmpHighRef!);
            em.op(OP_I32_AND);
            break;
          case 'notBetween':
            emitCmp(lo, cmpRef!);
            emitCmp(hi, cmpHighRef!);
            em.op(OP_I32_AND);
            em.op(OP_I32_EQZ);
            break;
          default: emitCmp('==', cmpRef!); break;
        }
        em.ifThen(() => {
          em.localGet(accLocal); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(accLocal);
        });
      } else {
        if (accValtype === F64 && elemValtype === I32) em.i32ToF64();
        if (accValtype === I32 && elemValtype === F64) em.f64ToI32();
        if (trackIndex) {
          const elemLocal = em.allocLocal(F64);
          em.localSet(elemLocal);
          em.localGet(elemLocal); em.localGet(accLocal);
          em.op(op === 'min' ? OP_F64_LT : OP_F64_GT);
          em.ifThen(() => {
            em.localGet(elemLocal); em.localSet(accLocal);
            em.localGet(nLocal); em.localSet(bestIdxLocal);
          });
        } else {
          switch (op) {
            case 'sum':
            case 'average':
              em.localGet(accLocal); em.op(OP_F64_ADD); em.localSet(accLocal); break;
            case 'product':
              em.localGet(accLocal); em.op(OP_F64_MUL); em.localSet(accLocal); break;
            case 'min':
              em.localGet(accLocal); em.op(OP_F64_MIN); em.localSet(accLocal); break;
            case 'max':
              em.localGet(accLocal); em.op(OP_F64_MAX); em.localSet(accLocal); break;
            // Normalise the raw i32 element to 0/1 before the bitwise fold (see
            // the nbr-path aggregate) so a non-0/1 array element matches JS/WebGPU.
            case 'and':
              em.i32Const(0); em.op(OP_I32_NE_OP);
              em.localGet(accLocal); em.op(OP_I32_AND); em.localSet(accLocal); break;
            case 'or':
              em.i32Const(0); em.op(OP_I32_NE_OP);
              em.localGet(accLocal); em.op(OP_I32_OR); em.localSet(accLocal); break;
          }
        }
      }
      em.localGet(nLocal); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(nLocal);
      em.br(0);
    });
  });

  if (op === 'average') {
    em.localGet(accLocal);
    em.localGet(arr.lenLocal); em.i32ToF64();
    em.f64Const(1); em.op(OP_F64_MAX); // guard /0 with len max(1) — JS does (len || 1)
    em.op(OP_F64_DIV);
    em.localSet(accLocal);
  }

  // Multi-output port caching — see comment in emitAggregateOrCount above.
  if (mode === 'count') {
    setCachedPort(ctx, node.id, 'count', { localIdx: accLocal, valtype: accValtype });
  }
  if (mode === 'groupOperator') {
    setCachedPort(ctx, node.id, 'result', { localIdx: accLocal, valtype: accValtype });
    if (trackIndex) {
      setCachedPort(ctx, node.id, 'index', { localIdx: bestIdxLocal, valtype: I32 });
    }
  }
  return { localIdx: accLocal, valtype: accValtype };
}

/**
 * Multi-source aggregate: each source is a scalar value (or itself an array,
 * but for now we only support scalars here — getNeighborsAttribute as one of
 * many sources isn't yet flattened). Each scalar is computed via
 * compileValueNode and combined into a single accumulator using the operation.
 */
function emitScalarAggregate(
  ctx: WasmCompileCtx,
  node: GraphNode,
  sources: Array<{ nodeId: string; portId: string }>,
  mode: 'aggregate' | 'count' | 'groupOperator',
): LocalRef | null {
  // Resolve each source up-front. compileValueNode caches in valueLocals so
  // re-emitting is a no-op if the value was already hoisted.
  const sourceRefs: LocalRef[] = [];
  for (const s of sources) {
    const r = compileValueNode(s.nodeId, ctx, s.portId);
    if (!r || r.localIdx < 0) {
      ctx.errors.push(`${mode}: scalar source ${s.nodeId} did not produce a usable value`);
      return null;
    }
    sourceRefs.push(r);
  }

  // Determine op
  let op: string;
  if (mode === 'count') {
    op = 'count';
  } else {
    op = (node.data.config.operation as string) || 'sum';
    if (op === 'mul') op = 'product';
    if (op === 'mean') op = 'average';
    if (op === 'random') {
      // Multi-source random pick: choose uniform index in [0, N), select that
      // source's value as the result. Mirrors the single-source path at the top
      // of compileArrayNode (`if (op === 'random') { ... }`) and the JS impl at
      // GroupOperatorNode.compile(), which also draws from the shared `_rs`
      // xorshift32 stream via floor((_rs / 2^32) * N) — JS↔WASM pick the same index.
      const em = ctx.emitter;
      const N = sourceRefs.length;
      if (N === 0) {
        ctx.errors.push('groupOperator: random requires at least one source');
        return null;
      }
      // Advance shared xorshift32 RNG (stays in lockstep with JS / single-source path).
      const rsLocal = em.allocLocal(I32);
      em.i32Const(0); em.i32Load(ctx.layout.rngStateOffset, 2); em.localSet(rsLocal);
      em.localGet(rsLocal); em.localGet(rsLocal); em.i32Const(13); em.emit(byte(0x74)); em.emit(byte(0x73)); em.localSet(rsLocal);
      em.localGet(rsLocal); em.localGet(rsLocal); em.i32Const(17); em.emit(byte(0x76)); em.emit(byte(0x73)); em.localSet(rsLocal);
      em.localGet(rsLocal); em.localGet(rsLocal); em.i32Const(5);  em.emit(byte(0x74)); em.emit(byte(0x73)); em.localSet(rsLocal);
      em.i32Const(0); em.localGet(rsLocal); em.i32Store(ctx.layout.rngStateOffset, 2);
      // idx = floor((rsLocal / 2^32) * N), N known at compile time.
      em.localGet(rsLocal);
      em.op(OP_F64_CONVERT_I32_U);
      em.f64Const(4294967296); em.op(OP_F64_DIV);
      em.f64Const(N); em.op(OP_F64_MUL);
      em.f64ToI32();
      const idxLocal = em.allocLocal(I32);
      em.localSet(idxLocal);
      // Result type is F64 (preserves either int or float source values; downstream
      // consumers coerce as needed — matches JS Number semantics).
      const accValtypeR: ValType = F64;
      const accLocalR = em.allocLocal(accValtypeR);
      // Initialise to sources[0], then overwrite if idx selects a different source.
      // Non-null asserts are safe — we've already checked N > 0 above.
      pushValueAs(em, sourceRefs[0]!, accValtypeR);
      em.localSet(accLocalR);
      for (let i = 1; i < N; i++) {
        em.localGet(idxLocal); em.i32Const(i); em.op(OP_I32_EQ);
        em.ifThen(() => {
          pushValueAs(em, sourceRefs[i]!, accValtypeR);
          em.localSet(accLocalR);
        });
      }
      if (mode === 'groupOperator') {
        setCachedPort(ctx, node.id, 'index', { localIdx: idxLocal, valtype: I32 });
        setCachedPort(ctx, node.id, 'result', { localIdx: accLocalR, valtype: accValtypeR });
      }
      return { localIdx: accLocalR, valtype: accValtypeR };
    }
    if (op === 'weightedRandom') {
      // Multi-source weighted-random pick: treat each scalar source as a weight,
      // sample one source index proportional to its weight. Empty / zero-sum →
      // index = -1, result = 0. RNG always advances (matches JS semantics in
      // GroupOperatorNode.compile()'s weightedRandom branch).
      const em = ctx.emitter;
      const N = sourceRefs.length;
      if (N === 0) {
        ctx.errors.push('groupOperator: weightedRandom requires at least one source');
        return null;
      }
      // Advance shared xorshift32 RNG once.
      const rsLocal = em.allocLocal(I32);
      em.i32Const(0); em.i32Load(ctx.layout.rngStateOffset, 2); em.localSet(rsLocal);
      em.localGet(rsLocal); em.localGet(rsLocal); em.i32Const(13); em.emit(byte(0x74)); em.emit(byte(0x73)); em.localSet(rsLocal);
      em.localGet(rsLocal); em.localGet(rsLocal); em.i32Const(17); em.emit(byte(0x76)); em.emit(byte(0x73)); em.localSet(rsLocal);
      em.localGet(rsLocal); em.localGet(rsLocal); em.i32Const(5);  em.emit(byte(0x74)); em.emit(byte(0x73)); em.localSet(rsLocal);
      em.i32Const(0); em.localGet(rsLocal); em.i32Store(ctx.layout.rngStateOffset, 2);

      // Stash each weight as f64 (loop unrolled — N known at compile time)
      const wLocals: number[] = [];
      for (let i = 0; i < N; i++) {
        const w = em.allocLocal(F64);
        pushValueAs(em, sourceRefs[i]!, F64);
        em.localSet(w);
        wLocals.push(w);
      }
      // sum = sum(weights)
      const sumLocal = em.allocLocal(F64);
      em.f64Const(0); em.localSet(sumLocal);
      for (let i = 0; i < N; i++) {
        em.localGet(sumLocal); em.localGet(wLocals[i]!); em.op(OP_F64_ADD); em.localSet(sumLocal);
      }
      // Default outputs: index = -1, result = 0
      const idxLocal = em.allocLocal(I32);
      em.i32Const(-1); em.localSet(idxLocal);
      const resLocal = em.allocLocal(F64);
      em.f64Const(0); em.localSet(resLocal);

      // if (sum > 0): u = (rs / 2^32) * sum; linear scan
      em.localGet(sumLocal); em.f64Const(0); em.op(OP_F64_GT);
      em.ifThen(() => {
        const uLocal = em.allocLocal(F64);
        em.localGet(rsLocal);
        em.op(OP_F64_CONVERT_I32_U);
        em.f64Const(4294967296); em.op(OP_F64_DIV);
        em.localGet(sumLocal); em.op(OP_F64_MUL);
        em.localSet(uLocal);
        const accLocal = em.allocLocal(F64);
        em.f64Const(0); em.localSet(accLocal);
        // Iterative pick — emit a chain of `if (idx < 0 && u < acc) { ... }` for
        // each source. The outer block lets us short-circuit via br.
        em.block(() => {
          for (let i = 0; i < N; i++) {
            em.localGet(accLocal); em.localGet(wLocals[i]!); em.op(OP_F64_ADD); em.localSet(accLocal);
            em.localGet(uLocal); em.localGet(accLocal); em.op(OP_F64_LT);
            em.ifThen(() => {
              em.i32Const(i); em.localSet(idxLocal);
              em.localGet(wLocals[i]!); em.localSet(resLocal);
              em.br(2); // break out of block + ifThen
            });
          }
          // FP-drift fallback: pick last source
          em.i32Const(N - 1); em.localSet(idxLocal);
          em.localGet(wLocals[N - 1]!); em.localSet(resLocal);
        });
      });

      if (mode === 'groupOperator') {
        setCachedPort(ctx, node.id, 'index', { localIdx: idxLocal, valtype: I32 });
        setCachedPort(ctx, node.id, 'result', { localIdx: resLocal, valtype: F64 });
      }
      return { localIdx: resLocal, valtype: F64 };
    }
  }

  // Promote everything to f64 for arithmetic, i32 for and/or/count
  const anyFloat = sourceRefs.some(r => r.valtype === F64);
  const accValtype: ValType = (mode === 'count' || op === 'and' || op === 'or') ? I32 : (anyFloat ? F64 : F64);
  const accLocal = ctx.emitter.allocLocal(accValtype);

  // Initialise accumulator
  if (mode === 'count') ctx.emitter.i32Const(0);
  else if (op === 'sum' || op === 'average') ctx.emitter.f64Const(0);
  else if (op === 'product') ctx.emitter.f64Const(1);
  else if (op === 'min') ctx.emitter.f64Const(Infinity);
  else if (op === 'max') ctx.emitter.f64Const(-Infinity);
  else if (op === 'and') ctx.emitter.i32Const(1);
  else if (op === 'or') ctx.emitter.i32Const(0);
  else { ctx.errors.push(`scalarAggregate: unsupported op ${op}`); return null; }
  ctx.emitter.localSet(accLocal);

  // For count mode, build the comparison setup once
  let countCmpOp = 'equals';
  let cmpRef: ValueRef | null = null;
  let cmpHighRef: ValueRef | null = null;
  let elemValtype: ValType = anyFloat ? F64 : I32;
  if (mode === 'count') {
    countCmpOp = (node.data.config.operation as string) || 'equals';
    cmpRef = ((): ValueRef => {
      const e = (ctx.inputToSource.get(`${node.id}:compare`));
      if (e) {
        const r = compileValueNode(e.nodeId, ctx, e.portId);
        if (r) { elemValtype = r.valtype; return r; }
      }
      return { inline: true, value: 1, valtype: elemValtype };
    })();
    if (countCmpOp === 'between' || countCmpOp === 'notBetween') {
      const e = ctx.inputToSource.get(`${node.id}:compareHigh`);
      if (e) {
        const r = compileValueNode(e.nodeId, ctx, e.portId);
        if (r) cmpHighRef = r;
      }
      if (!cmpHighRef) cmpHighRef = { inline: true, value: 1, valtype: elemValtype };
    }
  }
  const lo = (node.data.config.lowOp as string) === '>' ? '>' : '>=';
  const hi = (node.data.config.highOp as string) === '<' ? '<' : '<=';

  // Combine each source
  for (const ref of sourceRefs) {
    if (mode === 'count') {
      // Stash this source's value, compare, conditionally bump count
      const elemLocal = ctx.emitter.allocLocal(elemValtype);
      pushValueAs(ctx.emitter, ref, elemValtype);
      ctx.emitter.localSet(elemLocal);
      const emitCmp = (op2: string, ref2: ValueRef) => {
        ctx.emitter.localGet(elemLocal);
        pushValueAs(ctx.emitter, ref2, elemValtype);
        if (elemValtype === F64) ctx.emitter.op(cmpToF64Op(op2));
        else ctx.emitter.op(cmpToI32Op(op2));
      };
      switch (countCmpOp) {
        case 'notEquals': emitCmp('!=', cmpRef!); break;
        case 'greater':   emitCmp('>',  cmpRef!); break;
        case 'lesser':    emitCmp('<',  cmpRef!); break;
        case 'between':
          emitCmp(lo, cmpRef!);
          emitCmp(hi, cmpHighRef!);
          ctx.emitter.op(OP_I32_AND);
          break;
        case 'notBetween':
          emitCmp(lo, cmpRef!);
          emitCmp(hi, cmpHighRef!);
          ctx.emitter.op(OP_I32_AND);
          ctx.emitter.op(OP_I32_EQZ);
          break;
        default: emitCmp('==', cmpRef!); break;
      }
      ctx.emitter.ifThen(() => {
        ctx.emitter.localGet(accLocal);
        ctx.emitter.i32Const(1);
        ctx.emitter.op(OP_I32_ADD);
        ctx.emitter.localSet(accLocal);
      });
    } else {
      // Push the source value (as f64 for numeric ops, i32 for and/or)
      pushValueAs(ctx.emitter, ref, accValtype);
      // Combine with accumulator
      switch (op) {
        case 'sum':
        case 'average':
          ctx.emitter.localGet(accLocal);
          ctx.emitter.op(OP_F64_ADD);
          ctx.emitter.localSet(accLocal);
          break;
        case 'product':
          ctx.emitter.localGet(accLocal);
          ctx.emitter.op(OP_F64_MUL);
          ctx.emitter.localSet(accLocal);
          break;
        case 'min':
          ctx.emitter.localGet(accLocal);
          ctx.emitter.op(OP_F64_MIN);
          ctx.emitter.localSet(accLocal);
          break;
        case 'max':
          ctx.emitter.localGet(accLocal);
          ctx.emitter.op(OP_F64_MAX);
          ctx.emitter.localSet(accLocal);
          break;
        // Normalise the raw i32 source to 0/1 before the bitwise fold (see the
        // nbr-path aggregate) so a non-0/1 scalar source matches JS/WebGPU.
        case 'and':
          ctx.emitter.i32Const(0);
          ctx.emitter.op(OP_I32_NE_OP);
          ctx.emitter.localGet(accLocal);
          ctx.emitter.op(OP_I32_AND);
          ctx.emitter.localSet(accLocal);
          break;
        case 'or':
          ctx.emitter.i32Const(0);
          ctx.emitter.op(OP_I32_NE_OP);
          ctx.emitter.localGet(accLocal);
          ctx.emitter.op(OP_I32_OR);
          ctx.emitter.localSet(accLocal);
          break;
        default:
          ctx.errors.push(`scalarAggregate: unsupported op ${op}`);
          return null;
      }
    }
  }

  // Average: divide by count of sources
  if (op === 'average') {
    ctx.emitter.localGet(accLocal);
    ctx.emitter.f64Const(sourceRefs.length || 1);
    ctx.emitter.op(OP_F64_DIV);
    ctx.emitter.localSet(accLocal);
  }

  // Multi-output port caching — see comment in emitAggregateOrCount above.
  if (mode === 'count') {
    setCachedPort(ctx, node.id, 'count', { localIdx: accLocal, valtype: accValtype });
  }
  if (mode === 'groupOperator') {
    setCachedPort(ctx, node.id, 'result', { localIdx: accLocal, valtype: accValtype });
  }

  return { localIdx: accLocal, valtype: accValtype };
}

// ---------------------------------------------------------------------------
// Array-producing emitters
// ---------------------------------------------------------------------------

type NodeArrayEmitter = (c: NodeEmitContext) => ArrayRef | null;

const ARRAY_NODE_EMITTERS: Record<string, NodeArrayEmitter> = {

  // valueSwitch (array mode): result = cond ? ifArray : elseArray. valueSwitch is
  // a dual-mode relay — scalar consumers reach VALUE_NODE_EMITTERS; ctx.producesArray
  // routes an array-relay instance (both branches are array producers) here. Both
  // branch arrays are already materialised in per-cell scratch (the node's "both
  // inputs always evaluate" contract), so the result is a ZERO-COPY select of the
  // offset/len pair — no element copy. See compiler/arrayRelay.ts.
  valueSwitch: ({ node, ctx, inputs }) => {
    const ifArr = resolveInputArray(ctx, node, 'ifValue');
    const elseArr = resolveInputArray(ctx, node, 'elseValue');
    if (!ifArr || !elseArr) {
      ctx.errors.push(`valueSwitch (array mode): both "If" and "Else" must come from array-producing nodes`);
      return null;
    }
    if (ifArr.elemValtype !== elseArr.elemValtype || ifArr.elemBytes !== elseArr.elemBytes) {
      ctx.errors.push(`valueSwitch (array mode): "If" and "Else" arrays must have the same element type`);
      return null;
    }
    const cond = inputs['condition'] ?? { inline: true, value: 0, valtype: I32 };
    const em = ctx.emitter;
    // OP_SELECT pops [a, b, cond] → pushes cond ? a : b. Push cond twice (once per
    // select); a non-inline cond is just two localGets.
    const offsetLocal = em.allocLocal(I32);
    em.localGet(ifArr.offsetLocal); em.localGet(elseArr.offsetLocal);
    pushValueAs(em, cond, I32); em.op(OP_SELECT);
    em.localSet(offsetLocal);
    const lenLocal = em.allocLocal(I32);
    em.localGet(ifArr.lenLocal); em.localGet(elseArr.lenLocal);
    pushValueAs(em, cond, I32); em.op(OP_SELECT);
    em.localSet(lenLocal);
    return { kind: 'array', offsetLocal, lenLocal, elemValtype: ifArr.elemValtype, elemBytes: ifArr.elemBytes };
  },

  // Compile-time constant: writes the resolved tag indexes into scratch once.
  getNeighborIndexesByTags: ({ node, ctx }) => {
    const indices: number[] = node.data.config._resolvedTagIndexes
      ? JSON.parse(node.data.config._resolvedTagIndexes as string) : [];
    const arr = allocArrayInScratchConst(ctx, indices.length, I32, 4);
    // Fill arr[k] = indices[k] for each k (compile-time-known)
    for (let k = 0; k < indices.length; k++) {
      ctx.emitter.i32Const(k * 4);
      ctx.emitter.localGet(arr.offsetLocal);
      ctx.emitter.op(OP_I32_ADD);
      ctx.emitter.i32Const(indices[k]!);
      ctx.emitter.i32Store(0, 2);
    }
    return arr;
  },

  // Wave A.6: full NI[] of a neighborhood — packed (dr, dc) for every slot.
  getAllNeighborIndexes: ({ node, ctx }) => {
    const nbrId = node.data.config.neighborhoodId as string;
    const nbr = ctx.model.neighborhoods.find(n => n.id === nbrId);
    if (!nbr) { ctx.errors.push(`getAllNeighborIndexes: unknown neighborhood ${nbrId}`); return null; }
    // 3D Grid CA: pack 3-axis offsets from coords3d; 2D packs the verbatim
    // 2-axis codec from coords (byte-identical). layerLocalIdx>=0 is the
    // model-level 3D predicate (mirrors is3dModel).
    const is3d = ctx.layerLocalIdx >= 0;
    const coords3d = nbr.coords3d ?? [];
    const len = is3d ? coords3d.length : nbr.coords.length;
    const arr = allocArrayInScratchConst(ctx, len, I32, 4);
    for (let k = 0; k < len; k++) {
      let packed: number;
      if (is3d) { const c = coords3d[k]!; packed = packNI3(c[0], c[1], c[2]); }
      else { const [dr, dc] = nbr.coords[k]!; packed = packNI(dr, dc); }
      ctx.emitter.i32Const(k * 4);
      ctx.emitter.localGet(arr.offsetLocal);
      ctx.emitter.op(OP_I32_ADD);
      ctx.emitter.i32Const(packed);
      ctx.emitter.i32Store(0, 2);
    }
    return arr;
  },

  // Wave A.5: partial Fisher-Yates over a working copy of the input.
  // Allocates two scratch arrays (work + result) and uses the shared xorshift32
  // RNG so the random sequence stays in lockstep with JS / pickRandomNeighbor.
  pickNRandomNeighbors: ({ node, ctx, inputs }) => {
    const inArr = resolveInputArray(ctx, node, 'indexes');
    if (!inArr) {
      ctx.errors.push(`pickNRandomNeighbors: input "indexes" must come from an array-producing node`);
      return null;
    }
    const nRef = inputs['n'] ?? { inline: true, value: 1, valtype: I32 };
    const em = ctx.emitter;

    // K = clamp(n, 0, L)
    const kLocal = em.allocLocal(I32);
    pushValueAs(em, nRef, I32);
    em.localSet(kLocal);
    em.localGet(kLocal); em.i32Const(0); em.op(OP_I32_LT_S);
    em.ifThen(() => { em.i32Const(0); em.localSet(kLocal); });
    em.localGet(kLocal); em.localGet(inArr.lenLocal); em.op(OP_I32_GT_S);
    em.ifThen(() => { em.localGet(inArr.lenLocal); em.localSet(kLocal); });

    // Allocate work[L] and result[K] in scratch (i32 elements, 4 bytes).
    const work = allocArrayInScratch(ctx, inArr.lenLocal, I32, 4);
    const result = allocArrayInScratch(ctx, kLocal, I32, 4);

    // Copy input -> work
    const ci = em.allocLocal(I32);
    em.i32Const(0); em.localSet(ci);
    em.block(() => {
      em.loop(() => {
        em.localGet(ci); em.localGet(inArr.lenLocal); em.op(OP_I32_GE_S); em.brIf(1);
        // work[ci] = inArr[ci]
        em.localGet(ci); em.i32Const(4); em.op(OP_I32_MUL);
        em.localGet(work.offsetLocal); em.op(OP_I32_ADD);
        em.localGet(ci); emitArrayLoadElem(em, inArr);
        em.i32Store(0, 2);
        em.localGet(ci); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(ci);
        em.br(0);
      });
    });

    // Partial Fisher-Yates: for fi in [0, K): pick j in [fi, L), swap, copy result[fi]
    const fi = em.allocLocal(I32);
    const rsLocal = em.allocLocal(I32);
    const jLocal = em.allocLocal(I32);
    const tmpLocal = em.allocLocal(I32);
    em.i32Const(0); em.localSet(fi);
    em.block(() => {
      em.loop(() => {
        em.localGet(fi); em.localGet(kLocal); em.op(OP_I32_GE_S); em.brIf(1);

        // Advance _rs (xorshift32)
        em.i32Const(0); em.i32Load(ctx.layout.rngStateOffset, 2); em.localSet(rsLocal);
        em.localGet(rsLocal); em.localGet(rsLocal); em.i32Const(13); em.op(byte(0x74)); em.op(byte(0x73)); em.localSet(rsLocal);
        em.localGet(rsLocal); em.localGet(rsLocal); em.i32Const(17); em.op(byte(0x76)); em.op(byte(0x73)); em.localSet(rsLocal);
        em.localGet(rsLocal); em.localGet(rsLocal); em.i32Const(5); em.op(byte(0x74)); em.op(byte(0x73)); em.localSet(rsLocal);
        em.i32Const(0); em.localGet(rsLocal); em.i32Store(ctx.layout.rngStateOffset, 2);

        // j = fi + floor((rs / 2^32) * (L - fi))
        em.localGet(rsLocal); em.op(OP_F64_CONVERT_I32_U); em.f64Const(4294967296); em.op(OP_F64_DIV);
        em.localGet(inArr.lenLocal); em.localGet(fi); em.op(OP_I32_SUB); em.i32ToF64();
        em.op(OP_F64_MUL);
        em.f64ToI32();
        em.localGet(fi); em.op(OP_I32_ADD);
        em.localSet(jLocal);

        // tmp = work[fi]
        em.localGet(fi); em.i32Const(4); em.op(OP_I32_MUL);
        em.localGet(work.offsetLocal); em.op(OP_I32_ADD);
        em.i32Load(0, 2);
        em.localSet(tmpLocal);
        // work[fi] = work[jLocal]
        em.localGet(fi); em.i32Const(4); em.op(OP_I32_MUL);
        em.localGet(work.offsetLocal); em.op(OP_I32_ADD);
        em.localGet(jLocal); em.i32Const(4); em.op(OP_I32_MUL);
        em.localGet(work.offsetLocal); em.op(OP_I32_ADD);
        em.i32Load(0, 2);
        em.i32Store(0, 2);
        // work[jLocal] = tmp
        em.localGet(jLocal); em.i32Const(4); em.op(OP_I32_MUL);
        em.localGet(work.offsetLocal); em.op(OP_I32_ADD);
        em.localGet(tmpLocal);
        em.i32Store(0, 2);
        // result[fi] = work[fi]
        em.localGet(fi); em.i32Const(4); em.op(OP_I32_MUL);
        em.localGet(result.offsetLocal); em.op(OP_I32_ADD);
        em.localGet(fi); em.i32Const(4); em.op(OP_I32_MUL);
        em.localGet(work.offsetLocal); em.op(OP_I32_ADD);
        em.i32Load(0, 2);
        em.i32Store(0, 2);

        em.localGet(fi); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(fi);
        em.br(0);
      });
    });

    return result;
  },

  // Filter: walk input array, keep elements whose nbr-attr passes the comparison.
  // Wave A.5: when the Indexes input is unconnected, iterate every slot of the
  // configured neighborhood (loop bound = nbr.size) and the slot itself is the
  // iteration index — saves the bootstrap node in the common case.
  filterNeighbors: ({ node, ctx, inputs }) => {
    // Wave A.6: NIs are packed (dr, dc); no neighborhood config. Indexes
    // input is required (implicit-all default removed).
    const attrId = node.data.config.attributeId as string;
    const op = (node.data.config.operation as string) || 'equals';
    const attr = getAttr(ctx.layout, attrId);
    if (!attr) { ctx.errors.push(`filterNeighbors: unknown attr ${attrId}`); return null; }

    const inArr = resolveInputArray(ctx, node, 'indexes');
    if (!inArr) {
      ctx.errors.push(`filterNeighbors: requires Indexes input (e.g., from Get All Neighbor Indexes)`);
      return null;
    }
    const compare = inputs['compare'] ?? { inline: true, value: 0, valtype: attrValType(attr.type) };

    // Output: at most inArr.lenLocal entries; allocate worst-case bytes.
    const outOffsetLocal = ctx.emitter.allocLocal(I32);
    ctx.emitter.localGet(ctx.scratchTopLocal);
    ctx.emitter.localSet(outOffsetLocal);
    const outLenLocal = ctx.emitter.allocLocal(I32);
    ctx.emitter.i32Const(0); ctx.emitter.localSet(outLenLocal);
    // Reserve scratch up-front: inArr.lenLocal * 4
    ctx.emitter.localGet(ctx.scratchTopLocal);
    ctx.emitter.localGet(inArr.lenLocal);
    ctx.emitter.i32Const(4); ctx.emitter.op(OP_I32_MUL);
    ctx.emitter.op(OP_I32_ADD);
    ctx.emitter.localSet(ctx.scratchTopLocal);

    // Sub-attribute iteration semantics: when filtering on a sub-attribute, the
    // predicate is implicitly conjuncted with parent_match — non-matching
    // neighbors never reach the user's comparison (match the JS / iteration
    // contract: "the sub-attribute doesn't exist on those cells").
    const subF = getSubAttrWasm(ctx, attrId);
    const k = ctx.emitter.allocLocal(I32);
    ctx.emitter.i32Const(0); ctx.emitter.localSet(k);
    ctx.emitter.block(() => {
      ctx.emitter.loop(() => {
        // _i >= len → exit
        ctx.emitter.localGet(k);
        ctx.emitter.localGet(inArr.lenLocal);
        ctx.emitter.op(OP_I32_GE_S); ctx.emitter.brIf(1);
        // idxElem = indexes[k]  (packed NI)
        const idxElem = ctx.emitter.allocLocal(I32);
        ctx.emitter.localGet(k);
        emitArrayLoadElem(ctx.emitter, inArr);
        if (inArr.elemValtype === F64) ctx.emitter.f64ToI32();
        ctx.emitter.localSet(idxElem);
        // Resolve neighbor cell idx once and stash; used for both parent_match
        // (sub-attr) and the attribute value load.
        pushNiCellIdx(ctx, idxElem);
        const cellIdxLocal = ctx.emitter.allocLocal(I32);
        ctx.emitter.localSet(cellIdxLocal);
        // Load r_attr[cellIdxLocal]
        const loadElem = () => {
          ctx.emitter.localGet(cellIdxLocal);
          ctx.emitter.i32Const(attr.itemBytes); ctx.emitter.op(OP_I32_MUL);
          if (attr.type === 'bool') ctx.emitter.i32Load8U(attr.readOffset, 0);
          else if (attr.type === 'float') ctx.emitter.f64Load(attr.readOffset, 3);
          else ctx.emitter.i32Load(attr.readOffset, 2);
        };
        const elemValtype = attrValType(attr.type);
        loadElem();
        pushValueAs(ctx.emitter, compare, elemValtype);
        const cmp = (() => {
          switch (op) {
            case 'notEquals':    return '!=';
            case 'greater':      return '>';
            case 'lesser':       return '<';
            case 'greaterEqual': return '>=';
            case 'lesserEqual':  return '<=';
            default:             return '==';
          }
        })();
        if (elemValtype === F64) ctx.emitter.op(cmpToF64Op(cmp));
        else ctx.emitter.op(cmpToI32Op(cmp));
        // Sub-attribute: AND with parent_match. Skipped cells short-circuit
        // before the comparison's outcome can include them.
        if (subF) {
          emitParentMatchAtIdxWasm(ctx, subF.parent, subF.parentValuesInt, cellIdxLocal, false);
          ctx.emitter.op(OP_I32_AND);
        }

        ctx.emitter.ifThen(() => {
          // out[outLen++] = idxElem
          ctx.emitter.localGet(outLenLocal);
          ctx.emitter.i32Const(4); ctx.emitter.op(OP_I32_MUL);
          ctx.emitter.localGet(outOffsetLocal); ctx.emitter.op(OP_I32_ADD);
          ctx.emitter.localGet(idxElem);
          ctx.emitter.i32Store(0, 2);
          ctx.emitter.localGet(outLenLocal); ctx.emitter.i32Const(1); ctx.emitter.op(OP_I32_ADD); ctx.emitter.localSet(outLenLocal);
        });

        ctx.emitter.localGet(k); ctx.emitter.i32Const(1); ctx.emitter.op(OP_I32_ADD); ctx.emitter.localSet(k);
        ctx.emitter.br(0);
      });
    });

    // Wave A.7: expose the final length on the `count` value port too. Lets
    // downstream scalar consumers read `_v<id>_count` directly without
    // bouncing through `arrayLength`.
    setCachedPort(ctx, node.id, 'count', { localIdx: outLenLocal, valtype: I32 });

    return { kind: 'array', offsetLocal: outOffsetLocal, lenLocal: outLenLocal, elemValtype: I32, elemBytes: 4 };
  },

  // Join (intersection or union) of two i32 index arrays.
  joinNeighbors: ({ node, ctx }) => {
    const op = (node.data.config.operation as string) || 'intersection';
    const a = resolveInputArray(ctx, node, 'a');
    const b = resolveInputArray(ctx, node, 'b');
    if (!a || !b) { ctx.errors.push(`joinNeighbors: missing a/b array input`); return null; }

    const em = ctx.emitter;
    const outOffsetLocal = em.allocLocal(I32);
    em.localGet(ctx.scratchTopLocal); em.localSet(outOffsetLocal);
    const outLenLocal = em.allocLocal(I32);
    em.i32Const(0); em.localSet(outLenLocal);
    // Worst-case scratch: union = a.len + b.len; intersection = min(a, b).len.
    // Reserve max(a.len, a.len + b.len) = a.len + b.len bytes (common upper bound).
    em.localGet(ctx.scratchTopLocal);
    em.localGet(a.lenLocal); em.localGet(b.lenLocal); em.op(OP_I32_ADD);
    em.i32Const(4); em.op(OP_I32_MUL);
    em.op(OP_I32_ADD);
    em.localSet(ctx.scratchTopLocal);

    const i = em.allocLocal(I32);
    const j = em.allocLocal(I32);

    if (op === 'union') {
      // Copy A as-is, then walk B and append elements not already in out.
      em.i32Const(0); em.localSet(i);
      em.block(() => {
        em.loop(() => {
          em.localGet(i); em.localGet(a.lenLocal); em.op(OP_I32_GE_S); em.brIf(1);
          // out[outLen++] = a[i]
          em.localGet(outLenLocal); em.i32Const(4); em.op(OP_I32_MUL);
          em.localGet(outOffsetLocal); em.op(OP_I32_ADD);
          em.localGet(i); emitArrayLoadElem(em, a);
          if (a.elemValtype === F64) em.f64ToI32();
          em.i32Store(0, 2);
          em.localGet(outLenLocal); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(outLenLocal);
          em.localGet(i); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(i);
          em.br(0);
        });
      });
      em.i32Const(0); em.localSet(j);
      em.block(() => {
        em.loop(() => {
          em.localGet(j); em.localGet(b.lenLocal); em.op(OP_I32_GE_S); em.brIf(1);
          // bElem = b[j]
          const bElem = em.allocLocal(I32);
          em.localGet(j); emitArrayLoadElem(em, b);
          if (b.elemValtype === F64) em.f64ToI32();
          em.localSet(bElem);
          // walk current out[0..outLen) — if found, skip
          const k2 = em.allocLocal(I32);
          const found = em.allocLocal(I32);
          em.i32Const(0); em.localSet(k2);
          em.i32Const(0); em.localSet(found);
          em.block(() => {
            em.loop(() => {
              em.localGet(k2); em.localGet(outLenLocal); em.op(OP_I32_GE_S); em.brIf(1);
              // load out[k2]
              em.localGet(k2); em.i32Const(4); em.op(OP_I32_MUL);
              em.localGet(outOffsetLocal); em.op(OP_I32_ADD);
              em.i32Load(0, 2);
              em.localGet(bElem);
              em.op(OP_I32_EQ);
              em.ifThen(() => { em.i32Const(1); em.localSet(found); });
              em.localGet(k2); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(k2);
              em.br(0);
            });
          });
          em.localGet(found); em.op(OP_I32_EQZ);
          em.ifThen(() => {
            em.localGet(outLenLocal); em.i32Const(4); em.op(OP_I32_MUL);
            em.localGet(outOffsetLocal); em.op(OP_I32_ADD);
            em.localGet(bElem);
            em.i32Store(0, 2);
            em.localGet(outLenLocal); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(outLenLocal);
          });
          em.localGet(j); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(j);
          em.br(0);
        });
      });
    } else {
      // intersection: keep a[i] if it appears in b
      em.i32Const(0); em.localSet(i);
      em.block(() => {
        em.loop(() => {
          em.localGet(i); em.localGet(a.lenLocal); em.op(OP_I32_GE_S); em.brIf(1);
          const aElem = em.allocLocal(I32);
          em.localGet(i); emitArrayLoadElem(em, a);
          if (a.elemValtype === F64) em.f64ToI32();
          em.localSet(aElem);
          const k2 = em.allocLocal(I32);
          const found = em.allocLocal(I32);
          em.i32Const(0); em.localSet(k2);
          em.i32Const(0); em.localSet(found);
          em.block(() => {
            em.loop(() => {
              em.localGet(k2); em.localGet(b.lenLocal); em.op(OP_I32_GE_S); em.brIf(1);
              em.localGet(k2); emitArrayLoadElem(em, b);
              if (b.elemValtype === F64) em.f64ToI32();
              em.localGet(aElem);
              em.op(OP_I32_EQ);
              em.ifThen(() => { em.i32Const(1); em.localSet(found); });
              em.localGet(k2); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(k2);
              em.br(0);
            });
          });
          em.localGet(found);
          em.ifThen(() => {
            em.localGet(outLenLocal); em.i32Const(4); em.op(OP_I32_MUL);
            em.localGet(outOffsetLocal); em.op(OP_I32_ADD);
            em.localGet(aElem);
            em.i32Store(0, 2);
            em.localGet(outLenLocal); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(outLenLocal);
          });
          em.localGet(i); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(i);
          em.br(0);
        });
      });
    }
    // Expose the final length on the `count` value port. Mirrors filterNeighbors —
    // downstream scalar consumers read `_v<id>_count` directly without bouncing
    // through `arrayLength`.
    setCachedPort(ctx, node.id, 'count', { localIdx: outLenLocal, valtype: I32 });
    return { kind: 'array', offsetLocal: outOffsetLocal, lenLocal: outLenLocal, elemValtype: I32, elemBytes: 4 };
  },

  // groupCounting array output: for each element matching the comparison,
  // collect its source index (0..n-1 from the loop) into scratch.
  groupCounting: ({ node, ctx, inputs }) => {
    const portKey = `${node.id}:values`;
    const sources = ctx.inputToSources.get(portKey) ?? [];
    if (sources.length === 0) {
      ctx.errors.push(`groupCounting (array): no sources connected to "values"`);
      return null;
    }
    const firstSrc = sources[0]!;
    const firstSrcNode = ctx.nodeMap.get(firstSrc.nodeId);
    const isNbrPath = sources.length === 1 && firstSrcNode?.data.nodeType === 'getNeighborsAttribute';

    const cmpOp = (node.data.config.operation as string) || 'equals';
    const lo = (node.data.config.lowOp as string) === '>' ? '>' : '>=';
    const hi = (node.data.config.highOp as string) === '<' ? '<' : '<=';

    if (!isNbrPath) {
      // Try ArrayRef source
      const arrSrc = firstSrcNode && ctx.producesArray(firstSrcNode) && sources.length === 1
        ? compileArrayNode(firstSrc.nodeId, ctx, firstSrc.portId) : null;
      if (!arrSrc) {
        ctx.errors.push(`groupCounting (array): only single nbr/array source supported for indexes output`);
        return null;
      }
      // Loop over arrSrc, push matching n into out scratch.
      const em = ctx.emitter;
      const elemValtype = arrSrc.elemValtype;
      const cmpRef = inputs['compare'] ?? { inline: true, value: 0, valtype: elemValtype };
      const cmpHighRef = inputs['compareHigh'] ?? { inline: true, value: 0, valtype: elemValtype };
      // Reserve worst-case scratch up-front
      const outOff = em.allocLocal(I32);
      em.localGet(ctx.scratchTopLocal); em.localSet(outOff);
      const outLen = em.allocLocal(I32);
      em.i32Const(0); em.localSet(outLen);
      em.localGet(ctx.scratchTopLocal);
      em.localGet(arrSrc.lenLocal); em.i32Const(4); em.op(OP_I32_MUL);
      em.op(OP_I32_ADD); em.localSet(ctx.scratchTopLocal);

      const k = em.allocLocal(I32);
      em.i32Const(0); em.localSet(k);
      em.block(() => {
        em.loop(() => {
          em.localGet(k); em.localGet(arrSrc.lenLocal); em.op(OP_I32_GE_S); em.brIf(1);
          // Load arr[k] and stash
          const elemLoc = em.allocLocal(elemValtype);
          em.localGet(k); emitArrayLoadElem(em, arrSrc); em.localSet(elemLoc);
          // Compare
          const emitCmp = (op2: string, ref: ValueRef) => {
            em.localGet(elemLoc);
            pushValueAs(em, ref, elemValtype);
            if (elemValtype === F64) em.op(cmpToF64Op(op2));
            else em.op(cmpToI32Op(op2));
          };
          switch (cmpOp) {
            case 'notEquals': emitCmp('!=', cmpRef); break;
            case 'greater':   emitCmp('>',  cmpRef); break;
            case 'lesser':    emitCmp('<',  cmpRef); break;
            case 'between':
              emitCmp(lo, cmpRef); emitCmp(hi, cmpHighRef); em.op(OP_I32_AND);
              break;
            case 'notBetween':
              emitCmp(lo, cmpRef); emitCmp(hi, cmpHighRef); em.op(OP_I32_AND); em.op(OP_I32_EQZ);
              break;
            default: emitCmp('==', cmpRef); break;
          }
          em.ifThen(() => {
            em.localGet(outLen); em.i32Const(4); em.op(OP_I32_MUL);
            em.localGet(outOff); em.op(OP_I32_ADD);
            em.localGet(k);
            em.i32Store(0, 2);
            em.localGet(outLen); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(outLen);
          });
          em.localGet(k); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(k);
          em.br(0);
        });
      });
      return { kind: 'array', offsetLocal: outOff, lenLocal: outLen, elemValtype: I32, elemBytes: 4 };
    }

    // Nbr-source path
    const srcNode = firstSrcNode!;
    const nbr = getNbr(ctx.layout, srcNode.data.config.neighborhoodId as string);
    const attrId2 = srcNode.data.config.attributeId as string;
    const attr = getAttr(ctx.layout, attrId2);
    if (!nbr || !attr) {
      ctx.errors.push(`groupCounting (array): unknown nbr/attr`);
      return null;
    }
    const elemValtype = attrValType(attr.type);
    const cmpRef = inputs['compare'] ?? { inline: true, value: 0, valtype: elemValtype };
    const cmpHighRef = inputs['compareHigh'] ?? { inline: true, value: 0, valtype: elemValtype };
    const em = ctx.emitter;
    // Sub-attribute iteration: non-matching neighbors are excluded BEFORE the
    // user's comparison reaches them (matches the JS iteration contract).
    const subGC = getSubAttrWasm(ctx, attrId2);

    // Reserve worst-case scratch up-front
    const outOff = em.allocLocal(I32);
    em.localGet(ctx.scratchTopLocal); em.localSet(outOff);
    const outLen = em.allocLocal(I32);
    em.i32Const(0); em.localSet(outLen);
    em.localGet(ctx.scratchTopLocal);
    em.i32Const(nbr.size * 4); em.op(OP_I32_ADD);
    em.localSet(ctx.scratchTopLocal);

    const n = em.allocLocal(I32);
    em.i32Const(0); em.localSet(n);
    em.block(() => {
      em.loop(() => {
        em.localGet(n); em.i32Const(nbr.size); em.op(OP_I32_GE_S); em.brIf(1);
        // Compute neighbor cell idx, stash for parent_match + value load.
        // Inline-neighbour mode resolves slot n's packed offset (no per-cell table).
        if (ctx.inlineNbr) {
          pushInlineNbrCellIdx(ctx, nbr, () => em.localGet(n));
        } else {
          em.localGet(ctx.iLocalIdx); em.i32Const(nbr.size); em.op(OP_I32_MUL);
          em.localGet(n); em.op(OP_I32_ADD);
          em.i32Const(4); em.op(OP_I32_MUL);
          em.i32Load(nbr.offset, 2);
        }
        const cellIdxLocal = em.allocLocal(I32);
        em.localSet(cellIdxLocal);
        // Load value at cellIdx
        em.localGet(cellIdxLocal);
        em.i32Const(attr.itemBytes); em.op(OP_I32_MUL);
        if (attr.type === 'bool') em.i32Load8U(attr.readOffset, 0);
        else if (attr.type === 'float') em.f64Load(attr.readOffset, 3);
        else em.i32Load(attr.readOffset, 2);
        const elemLoc = em.allocLocal(elemValtype);
        em.localSet(elemLoc);
        const emitCmp = (op2: string, ref: ValueRef) => {
          em.localGet(elemLoc);
          pushValueAs(em, ref, elemValtype);
          if (elemValtype === F64) em.op(cmpToF64Op(op2));
          else em.op(cmpToI32Op(op2));
        };
        switch (cmpOp) {
          case 'notEquals': emitCmp('!=', cmpRef); break;
          case 'greater':   emitCmp('>',  cmpRef); break;
          case 'lesser':    emitCmp('<',  cmpRef); break;
          case 'between':
            emitCmp(lo, cmpRef); emitCmp(hi, cmpHighRef); em.op(OP_I32_AND);
            break;
          case 'notBetween':
            emitCmp(lo, cmpRef); emitCmp(hi, cmpHighRef); em.op(OP_I32_AND); em.op(OP_I32_EQZ);
            break;
          default: emitCmp('==', cmpRef); break;
        }
        // Sub-attribute: AND with parent_match so non-matching cells are
        // excluded from the output indexes.
        if (subGC) {
          emitParentMatchAtIdxWasm(ctx, subGC.parent, subGC.parentValuesInt, cellIdxLocal, false);
          em.op(OP_I32_AND);
        }
        em.ifThen(() => {
          em.localGet(outLen); em.i32Const(4); em.op(OP_I32_MUL);
          em.localGet(outOff); em.op(OP_I32_ADD);
          em.localGet(n);
          em.i32Store(0, 2);
          em.localGet(outLen); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(outLen);
        });
        em.localGet(n); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(n);
        em.br(0);
      });
    });
    return { kind: 'array', offsetLocal: outOff, lenLocal: outLen, elemValtype: I32, elemBytes: 4 };
  },

  // Read neighbor attribute values for a list of packed NIs (Wave A.6).
  getNeighborsAttrByIndexes: ({ node, ctx }) => {
    const attrId = node.data.config.attributeId as string;
    const attr = getAttr(ctx.layout, attrId);
    if (!attr) { ctx.errors.push(`getNeighborsAttrByIndexes: unknown attr ${attrId}`); return null; }
    const inArr = resolveInputArray(ctx, node, 'indexes');
    if (!inArr) { ctx.errors.push(`getNeighborsAttrByIndexes: no input on "indexes"`); return null; }

    const elemValtype = attrValType(attr.type);
    const elemBytes = attr.itemBytes;
    // Sub-attribute iteration: non-matching neighbors are EXCLUDED from the
    // output, producing a variable-length array (filter-with-push pattern).
    // For regular attrs the output is fixed-length (same as input).
    const subG = getSubAttrWasm(ctx, attrId);
    // Allocate worst-case capacity (input length).
    const outOff = ctx.emitter.allocLocal(I32);
    ctx.emitter.localGet(ctx.scratchTopLocal); ctx.emitter.localSet(outOff);
    const outLen = ctx.emitter.allocLocal(I32);
    ctx.emitter.i32Const(0); ctx.emitter.localSet(outLen);
    // Reserve worst-case scratch: inArr.lenLocal * elemBytes
    ctx.emitter.localGet(ctx.scratchTopLocal);
    ctx.emitter.localGet(inArr.lenLocal);
    if (elemBytes !== 1) { ctx.emitter.i32Const(elemBytes); ctx.emitter.op(OP_I32_MUL); }
    ctx.emitter.op(OP_I32_ADD);
    ctx.emitter.localSet(ctx.scratchTopLocal);

    const k = ctx.emitter.allocLocal(I32);
    ctx.emitter.i32Const(0); ctx.emitter.localSet(k);
    ctx.emitter.block(() => {
      ctx.emitter.loop(() => {
        ctx.emitter.localGet(k); ctx.emitter.localGet(inArr.lenLocal); ctx.emitter.op(OP_I32_GE_S); ctx.emitter.brIf(1);
        // Load idxIn = inArr[k] (packed NI)
        const idxIn = ctx.emitter.allocLocal(I32);
        ctx.emitter.localGet(k); emitArrayLoadElem(ctx.emitter, inArr);
        if (inArr.elemValtype === F64) ctx.emitter.f64ToI32();
        ctx.emitter.localSet(idxIn);
        // Resolve neighbor cell idx, stash for parent_match + value load.
        pushNiCellIdx(ctx, idxIn);
        const cellIdxLocal = ctx.emitter.allocLocal(I32);
        ctx.emitter.localSet(cellIdxLocal);

        const emitStoreElem = () => {
          // out[outLen] = r_attr[cellIdxLocal]
          ctx.emitter.localGet(outLen);
          if (elemBytes !== 1) { ctx.emitter.i32Const(elemBytes); ctx.emitter.op(OP_I32_MUL); }
          ctx.emitter.localGet(outOff); ctx.emitter.op(OP_I32_ADD);
          // Load value
          ctx.emitter.localGet(cellIdxLocal);
          ctx.emitter.i32Const(attr.itemBytes); ctx.emitter.op(OP_I32_MUL);
          if (attr.type === 'bool') ctx.emitter.i32Load8U(attr.readOffset, 0);
          else if (attr.type === 'float') ctx.emitter.f64Load(attr.readOffset, 3);
          else ctx.emitter.i32Load(attr.readOffset, 2);
          // Store
          if (elemBytes === 1) ctx.emitter.i32Store8(0, 0);
          else if (elemValtype === F64) ctx.emitter.f64Store(0, 3);
          else ctx.emitter.i32Store(0, 2);
          // outLen++
          ctx.emitter.localGet(outLen);
          ctx.emitter.i32Const(1); ctx.emitter.op(OP_I32_ADD);
          ctx.emitter.localSet(outLen);
        };
        if (subG) {
          emitParentMatchAtIdxWasm(ctx, subG.parent, subG.parentValuesInt, cellIdxLocal, false);
          ctx.emitter.ifThen(emitStoreElem);
        } else {
          emitStoreElem();
        }
        ctx.emitter.localGet(k); ctx.emitter.i32Const(1); ctx.emitter.op(OP_I32_ADD); ctx.emitter.localSet(k);
        ctx.emitter.br(0);
      });
    });
    return { kind: 'array', offsetLocal: outOff, lenLocal: outLen, elemValtype, elemBytes };
  },

  // -- Variegated Cells: Interaction Table Map ----------------------------
  // Vectorised LookupInteraction over two parallel face-label arrays. Reads
  // f64 entries from the interaction-table region of memory at byte offset
  // `(labelA * labelCount + labelB) * 8 + tableOff` and stores them into a
  // freshly-allocated scratch array. Output length = min(myFaces.len,
  // theirFaces.len). Unknown tableId returns an empty array (parity with the
  // JS emit).
  // Local Variable read (array path). For scalar variables, dispatch lands
  // on VALUE_NODE_EMITTERS['getVariable'] instead — both registrations
  // ensure that whichever input-port flavour the consumer expects gets the
  // right return type. Builds an ArrayRef pointing at the variable's
  // current per-cell scratch storage. The lenLocal is allocated once and
  // re-used (length is a compile-time constant from the variable definition).
  getVariable: ({ node, ctx }) => {
    const variableId = node.data.config.variableId as string;
    const slot = ctx.variableLocals.get(variableId);
    if (!slot) {
      ctx.errors.push(`getVariable (array): unknown variable "${variableId}"`);
      return null;
    }
    if (slot.kind !== 'array') {
      ctx.errors.push(`getVariable: variable "${variableId}" is a scalar; an array consumer needs an array-typed variable`);
      return null;
    }
    // Materialise length as a function-local so the ArrayRef contract is
    // satisfied (it expects lenLocal to be a localIdx, not a constant).
    const lenLocal = ctx.emitter.allocLocal(I32);
    ctx.emitter.i32Const(slot.length);
    ctx.emitter.localSet(lenLocal);
    return {
      kind: 'array',
      offsetLocal: slot.offsetLocal,
      lenLocal,
      elemValtype: slot.elemValtype,
      elemBytes: slot.elemBytes,
    };
  },

  interactionTableMap: ({ node, ctx }) => {
    // No variegation guard — tag×tag tables need no faces.
    const tableId = (node.data.config.tableId as string) || '';
    const slot = tableId ? ctx.layout.interactionTableOffsets[tableId] : undefined;
    const myArr = resolveInputArray(ctx, node, 'myFaces');
    const theirArr = resolveInputArray(ctx, node, 'theirFaces');
    if (!myArr || !theirArr) {
      ctx.errors.push('interactionTableMap: missing myFaces or theirFaces input');
      return null;
    }
    // Reserve scratch for the output (worst-case = min input length).
    // We allocate worst-case = max input length to keep alloc simple — the
    // unused tail just doesn't get read.
    const outOff = ctx.emitter.allocLocal(I32);
    ctx.emitter.localGet(ctx.scratchTopLocal); ctx.emitter.localSet(outOff);
    const outLen = ctx.emitter.allocLocal(I32);
    ctx.emitter.i32Const(0); ctx.emitter.localSet(outLen);

    // n = min(myArr.len, theirArr.len) via OP_SELECT (pops [a, b, cond] →
    // pushes cond ? a : b). a = my.len, b = their.len, cond = (my < their).
    const n = ctx.emitter.allocLocal(I32);
    ctx.emitter.localGet(myArr.lenLocal);
    ctx.emitter.localGet(theirArr.lenLocal);
    ctx.emitter.localGet(myArr.lenLocal);
    ctx.emitter.localGet(theirArr.lenLocal);
    ctx.emitter.op(OP_I32_LT_S);
    ctx.emitter.op(OP_SELECT);
    ctx.emitter.localSet(n);

    // Reserve scratch: n * 8 (f64 elements)
    ctx.emitter.localGet(ctx.scratchTopLocal);
    ctx.emitter.localGet(n);
    ctx.emitter.i32Const(8);
    ctx.emitter.op(OP_I32_MUL);
    ctx.emitter.op(OP_I32_ADD);
    ctx.emitter.localSet(ctx.scratchTopLocal);

    if (slot === undefined || (slot.dims && slot.dims.length !== 2)) {
      // Tableless — or a multi-axis table with N≠2 axes (the node's shape is
      // two parallel index arrays; nodeValidation badges it): output stays
      // empty (len = 0).
      return { kind: 'array', offsetLocal: outOff, lenLocal: outLen, elemValtype: F64, elemBytes: 8 };
    }
    // Multi-axis N=2 table: clamped indices + intRange offsets (D-NDT-5).
    // Legacy 2-axis: raw indices, byte-identical to the pre-N-D emit.
    const ndDims = slot.dims && slot.dims.length === 2 ? slot.dims : null;
    const ndMins = ndDims ? (slot.mins ?? []) : [];
    const colCount = ndDims ? ndDims[1]! : slot.colCount; // row-major stride

    const k = ctx.emitter.allocLocal(I32);
    ctx.emitter.i32Const(0); ctx.emitter.localSet(k);
    ctx.emitter.block(() => {
      ctx.emitter.loop(() => {
        ctx.emitter.localGet(k); ctx.emitter.localGet(n); ctx.emitter.op(OP_I32_GE_S); ctx.emitter.brIf(1);
        // a = myArr[k] | 0; b = theirArr[k] | 0
        const a = ctx.emitter.allocLocal(I32);
        ctx.emitter.localGet(k); emitArrayLoadElem(ctx.emitter, myArr);
        if (myArr.elemValtype === F64) ctx.emitter.f64ToI32();
        ctx.emitter.localSet(a);
        const b = ctx.emitter.allocLocal(I32);
        ctx.emitter.localGet(k); emitArrayLoadElem(ctx.emitter, theirArr);
        if (theirArr.elemValtype === F64) ctx.emitter.f64ToI32();
        ctx.emitter.localSet(b);
        if (ndDims) {
          // a = clamp(a − min0, 0, d0−1); b = clamp(b − min1, 0, d1−1)
          const em = ctx.emitter;
          const clampLocal = (loc: number, min: number, hi: number) => {
            if (min !== 0) { em.localGet(loc); em.i32Const(min); em.op(OP_I32_SUB); em.localSet(loc); }
            em.localGet(loc); em.i32Const(0);
            em.localGet(loc); em.i32Const(0); em.op(OP_I32_GT_S);
            em.op(OP_SELECT); em.localSet(loc);
            em.localGet(loc); em.i32Const(hi);
            em.localGet(loc); em.i32Const(hi); em.op(OP_I32_LT_S);
            em.op(OP_SELECT); em.localSet(loc);
          };
          clampLocal(a, Math.floor(ndMins[0] ?? 0) || 0, Math.max(0, ndDims[0]! - 1));
          clampLocal(b, Math.floor(ndMins[1] ?? 0) || 0, Math.max(0, ndDims[1]! - 1));
        }

        // out[k] (f64) = f64Load((a * colCount + b) * 8 + slot.offset)
        // Compute the byte offset into the OUTPUT scratch slot first.
        ctx.emitter.localGet(k);
        ctx.emitter.i32Const(8);
        ctx.emitter.op(OP_I32_MUL);
        ctx.emitter.localGet(outOff);
        ctx.emitter.op(OP_I32_ADD);
        // Compute the byte offset into the TABLE.
        ctx.emitter.localGet(a);
        ctx.emitter.i32Const(colCount);
        ctx.emitter.op(OP_I32_MUL);
        ctx.emitter.localGet(b);
        ctx.emitter.op(OP_I32_ADD);
        ctx.emitter.i32Const(8);
        ctx.emitter.op(OP_I32_MUL);
        ctx.emitter.f64Load(slot.offset, 3);
        // Store into the output slot
        ctx.emitter.f64Store(0, 3);

        // outLen++
        ctx.emitter.localGet(outLen);
        ctx.emitter.i32Const(1); ctx.emitter.op(OP_I32_ADD);
        ctx.emitter.localSet(outLen);
        // k++
        ctx.emitter.localGet(k); ctx.emitter.i32Const(1); ctx.emitter.op(OP_I32_ADD); ctx.emitter.localSet(k);
        ctx.emitter.br(0);
      });
    });
    return { kind: 'array', offsetLocal: outOff, lenLocal: outLen, elemValtype: F64, elemBytes: 8 };
  },

  // -- Variegated Cells: Get All Facing Labels (multi-output arrays) -----
  // Produces two parallel ArrayRefs of length 8 (i32 elements, one per
  // direction in N/NE/E/SE/S/SW/W/NW order). Both are cached under
  // `${nodeId}::myFaceLabels` and `${nodeId}::theirFaceLabels` keys so
  // resolveInputArray finds them via the multi-output path. The "default"
  // returned ref is myFaceLabels — callers without an explicit portId get it.
  //
  // The 8-direction loop is unrolled at emit time. Each iteration:
  //   1. Compute neighbour cell index (boundary-aware: torus wrap or
  //      constant sentinel).
  //   2. Read neighbour orientation + species.
  //   3. Compute myFaceIdx + theirFaceIdx from the cell + neighbour
  //      orientation, applying the canonical rotation arithmetic.
  //   4. Look up labels via facePatternLookup; store at index d in both
  //      scratch arrays. Out-of-bounds neighbours store 0 (none).
  getAllFacingLabels: ({ node, ctx }) => {
    if (!ctx.layout.variegatedEnabled) {
      ctx.errors.push('getAllFacingLabels: variegated cells disabled');
      return null;
    }
    const sourceAttrId = (node.data.config._sourceAttrId as string) || '';
    const sourceAttr = sourceAttrId ? getAttr(ctx.layout, sourceAttrId) : null;
    const boundary = (node.data.config._boundaryTreatment as string) || 'torus';
    const cardinalsOnly = !!node.data.config.cardinalsOnly;
    const em = ctx.emitter;
    const lookupOff = ctx.layout.facePatternLookupOffset;
    const total = ctx.layout.total;
    const W = ctx.model.properties.gridWidth;
    const H = ctx.model.properties.gridHeight;

    // Allocate both scratch arrays first (length 4 cardinals or 8 Moore, i32).
    const outLen = cardinalsOnly ? 4 : 8;
    const myArr = allocArrayInScratchConst(ctx, outLen, I32, 4);
    const theirArr = allocArrayInScratchConst(ctx, outLen, I32, 4);

    // Read my species + orientation once (loop-invariant within this emit).
    const mySpec = em.allocLocal(I32);
    if (sourceAttr) {
      pushCellByteOffset(ctx, sourceAttr.itemBytes);
      if (sourceAttr.type === 'bool') em.i32Load8U(sourceAttr.readOffset, 0);
      else em.i32Load(sourceAttr.readOffset, 2);
      em.localSet(mySpec);
    } else {
      em.i32Const(0);
      em.localSet(mySpec);
    }
    const myOri = em.allocLocal(I32);
    pushCellByteOffset(ctx, 4);
    em.i32Load(ctx.layout.orientationReadOffset, 2);
    em.localSet(myOri);

    // 8 directions in canonical N/NE/E/SE/S/SW/W/NW order. In cardinalsOnly
    // mode we iterate only slots 0/2/4/6 (= N/E/S/W) but write them to output
    // indices 0..3. The face-rotation arithmetic still uses the Moore index
    // (d8) because face patterns are 8-slot-keyed.
    const OFFSETS: ReadonlyArray<readonly [number, number]> = [
      [-1, 0], [-1, 1], [0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1],
    ];
    const iterations: ReadonlyArray<readonly [number, number]> = cardinalsOnly
      ? [[0, 0], [2, 1], [4, 2], [6, 3]]
      : [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6], [7, 7]];

    for (const [d, outIdx] of iterations) {
      const [dr, dc] = OFFSETS[d]!;
      const dirP4 = (d + 4) & 7;
      const nbrCell = em.allocLocal(I32);
      // Compute neighbour cell index
      if (boundary === 'constant') {
        const nRow = em.allocLocal(I32);
        em.localGet(ctx.rowLocalIdx);
        em.i32Const(dr);
        em.op(OP_I32_ADD);
        em.localSet(nRow);
        const nCol = em.allocLocal(I32);
        em.localGet(ctx.colLocalIdx);
        em.i32Const(dc);
        em.op(OP_I32_ADD);
        em.localSet(nCol);
        em.i32Const(total);
        em.localSet(nbrCell);
        // in-bounds: nRow >= 0 && nRow < H && nCol >= 0 && nCol < W
        em.localGet(nRow); em.i32Const(0); em.op(OP_I32_GE_S);
        em.localGet(nRow); em.i32Const(H); em.op(OP_I32_LT_S);
        em.op(OP_I32_AND);
        em.localGet(nCol); em.i32Const(0); em.op(OP_I32_GE_S);
        em.op(OP_I32_AND);
        em.localGet(nCol); em.i32Const(W); em.op(OP_I32_LT_S);
        em.op(OP_I32_AND);
        em.ifThen(() => {
          em.localGet(nRow);
          em.i32Const(W);
          em.op(OP_I32_MUL);
          em.localGet(nCol);
          em.op(OP_I32_ADD);
          em.localSet(nbrCell);
        });
      } else {
        // torus: ((row + dr) % H + H) % H * W + ((col + dc) % W + W) % W
        em.localGet(ctx.rowLocalIdx);
        if (dr !== 0) { em.i32Const(dr); em.op(OP_I32_ADD); }
        em.i32Const(H);
        em.op(OP_I32_REM_S);
        em.i32Const(H);
        em.op(OP_I32_ADD);
        em.i32Const(H);
        em.op(OP_I32_REM_S);
        em.i32Const(W);
        em.op(OP_I32_MUL);
        em.localGet(ctx.colLocalIdx);
        if (dc !== 0) { em.i32Const(dc); em.op(OP_I32_ADD); }
        em.i32Const(W);
        em.op(OP_I32_REM_S);
        em.i32Const(W);
        em.op(OP_I32_ADD);
        em.i32Const(W);
        em.op(OP_I32_REM_S);
        em.op(OP_I32_ADD);
        em.localSet(nbrCell);
      }

      // theirSpec = sourceAttr ? r_<sourceAttrId>[nbrCell] : 0
      const theirSpec = em.allocLocal(I32);
      if (sourceAttr) {
        em.localGet(nbrCell);
        em.i32Const(sourceAttr.itemBytes);
        em.op(OP_I32_MUL);
        if (sourceAttr.type === 'bool') em.i32Load8U(sourceAttr.readOffset, 0);
        else em.i32Load(sourceAttr.readOffset, 2);
        em.localSet(theirSpec);
      } else {
        em.i32Const(0);
        em.localSet(theirSpec);
      }
      // theirOri = r_orientation[nbrCell]
      const theirOri = em.allocLocal(I32);
      em.localGet(nbrCell);
      em.i32Const(4);
      em.op(OP_I32_MUL);
      em.i32Load(ctx.layout.orientationReadOffset, 2);
      em.localSet(theirOri);

      // myFaceIdx = (d + 2 * myOri) & 7
      const myFaceIdx = em.allocLocal(I32);
      em.i32Const(d);
      em.localGet(myOri);
      em.i32Const(2);
      em.op(OP_I32_MUL);
      em.op(OP_I32_ADD);
      em.i32Const(7);
      em.op(OP_I32_AND);
      em.localSet(myFaceIdx);
      // theirFaceIdx = ((d + 4) & 7 + 2 * theirOri) & 7
      const theirFaceIdx = em.allocLocal(I32);
      em.i32Const(dirP4);
      em.localGet(theirOri);
      em.i32Const(2);
      em.op(OP_I32_MUL);
      em.op(OP_I32_ADD);
      em.i32Const(7);
      em.op(OP_I32_AND);
      em.localSet(theirFaceIdx);

      // myLabel = (mySpec < 0) ? 0 : lookup[mySpec * 8 + myFaceIdx]
      const myLabel = em.allocLocal(I32);
      em.i32Const(0);
      em.localSet(myLabel);
      em.localGet(mySpec);
      em.i32Const(0);
      em.op(OP_I32_GE_S);
      em.ifThen(() => {
        em.localGet(mySpec);
        em.i32Const(8);
        em.op(OP_I32_MUL);
        em.localGet(myFaceIdx);
        em.op(OP_I32_ADD);
        em.i32Const(4);
        em.op(OP_I32_MUL);
        em.i32Load(lookupOff, 2);
        em.localSet(myLabel);
      });
      // theirLabel = (nbrCell >= total) ? 0 : lookup[theirSpec * 8 + theirFaceIdx]
      const theirLabel = em.allocLocal(I32);
      em.i32Const(0);
      em.localSet(theirLabel);
      em.localGet(nbrCell);
      em.i32Const(total);
      em.op(OP_I32_LT_S);
      em.ifThen(() => {
        em.localGet(theirSpec);
        em.i32Const(8);
        em.op(OP_I32_MUL);
        em.localGet(theirFaceIdx);
        em.op(OP_I32_ADD);
        em.i32Const(4);
        em.op(OP_I32_MUL);
        em.i32Load(lookupOff, 2);
        em.localSet(theirLabel);
      });

      // Store myLabel and theirLabel into their respective scratch arrays at
      // OUTPUT slot offset (= outIdx * 4). outIdx differs from d only in
      // cardinalsOnly mode, where d=2/4/6 collapse to outIdx=1/2/3.
      em.localGet(myArr.offsetLocal);
      em.i32Const(outIdx * 4);
      em.op(OP_I32_ADD);
      em.localGet(myLabel);
      em.i32Store(0, 2);
      em.localGet(theirArr.offsetLocal);
      em.i32Const(outIdx * 4);
      em.op(OP_I32_ADD);
      em.localGet(theirLabel);
      em.i32Store(0, 2);
    }

    // Cache both ports for the multi-output array lookup path.
    ctx.arrayRefs.set(`${node.id}::myFaceLabels`, myArr);
    ctx.arrayRefs.set(`${node.id}::theirFaceLabels`, theirArr);
    // Return myFaceLabels as the canonical default (callers without an
    // explicit port id get this — happens for the hybrid value-dispatch
    // path that uses compileValueNode without knowing about the array).
    return myArr;
  },
};

/**
 * Resolve an input port to an ArrayRef. The input must be wired to an
 * array-producing node. Returns null if not (consumers should report error).
 *
 * For multi-output array sources, the source port id selects which ArrayRef
 * to return (e.g., 'myFaceLabels' vs 'theirFaceLabels' on getAllFacingLabels).
 * Single-output sources ignore the port id (cache is keyed by nodeId only).
 */
function resolveInputArray(
  ctx: WasmCompileCtx,
  node: GraphNode,
  portId: string,
): ArrayRef | null {
  const src = ctx.inputToSource.get(`${node.id}:${portId}`);
  if (!src) return null;
  const srcNode = ctx.nodeMap.get(src.nodeId);
  if (!srcNode) return null;
  if (!ctx.producesArray(srcNode)) return null;
  return compileArrayNode(src.nodeId, ctx, src.portId);
}

/**
 * Compile (or look up cached) the array result of an array-producing node.
 * Returns null on error.
 *
 * For multi-output array nodes (MULTI_OUTPUT_ARRAY_TYPES), the cache is keyed
 * by `${nodeId}::${portId}` and the emitter populates each port's slot
 * directly. For single-output nodes, the cache is keyed by `nodeId` and the
 * emitter's return value is stored automatically.
 */
function compileArrayNode(nodeId: string, ctx: WasmCompileCtx, portId?: string): ArrayRef | null {
  const node = ctx.nodeMap.get(nodeId);
  if (!node) { ctx.errors.push(`unknown array node ${nodeId}`); return null; }
  const isMulti = MULTI_OUTPUT_ARRAY_TYPES.has(node.data.nodeType);

  // Cache lookup. Multi-output nodes key by `${nodeId}::${portId}`. When the
  // caller didn't pass a portId, fall back to the type's canonical default
  // port so successive default-port lookups all hit the same cache entry.
  // Single-output nodes ignore portId entirely.
  const resolvedPort = isMulti
    ? (portId ?? MULTI_OUTPUT_ARRAY_DEFAULT_PORT[node.data.nodeType] ?? '')
    : '';
  const cacheKey = isMulti ? `${nodeId}::${resolvedPort}` : nodeId;
  const cached = ctx.arrayRefs.get(cacheKey);
  if (cached) return cached;

  const emitter = ARRAY_NODE_EMITTERS[node.data.nodeType];
  if (!emitter) {
    ctx.errors.push(`No WASM array emitter for "${node.data.nodeType}"`);
    return null;
  }

  // Resolve scalar inputs first (so they get hoisted). Skip array inputs —
  // those are resolved via resolveInputArray inside the emitter.
  const def = getNodeDef(node.data.nodeType);
  const inputs: Record<string, ValueRef | undefined> = {};
  if (def) {
    for (const port of def.ports) {
      if (port.kind !== 'input' || port.category !== 'value' || port.isArray) continue;
      const src = ctx.inputToSource.get(`${nodeId}:${port.id}`);
      if (src) {
        // A scalar-typed port fed by an array producer (valueSwitch's ifValue /
        // elseValue relaying arrays): skip scalar-resolution — the emitter reads
        // it via resolveInputArray. (Static `isArray` ports are skipped above.)
        const portSrcNode = ctx.nodeMap.get(src.nodeId);
        if (portSrcNode && ctx.producesArray(portSrcNode)) continue;
        const srcRef = compileValueNode(src.nodeId, ctx, src.portId);
        if (srcRef) inputs[port.id] = srcRef;
      } else {
        const inlineVal = getInlineValue(port, node.data.config);
        if (inlineVal !== undefined) {
          const num = parseInlineNum(inlineVal);
          // Use F64 for 'float' AND 'any' ports — `any` is what arithmeticOperator's
          // x/y inputs (and setAttribute's `value`) use, and the user can type a
          // fractional number into the inline widget there. Defaulting to I32 would
          // pass the value through `pushValue`'s `n | 0` truncation, turning e.g.
          // `0.11111` into `0` before it ever reaches the f64 multiplication. The
          // consumer's `pushValueAs(..., wantType)` still converts F64 → I32 with
          // f64ToI32 (truncation toward zero, matching JS Number→Integer coercion)
          // for callsites that genuinely want an integer.
          const isFloat = port.dataType === 'float' || port.dataType === 'any';
          inputs[port.id] = { inline: true, value: num, valtype: isFloat ? F64 : I32 };
        }
      }
    }
  }

  const result = emitter({ ctx, node, inputs });
  if (!result) return null;
  if (isMulti) {
    // Multi-output array emitter is responsible for caching each port's
    // ArrayRef under `${nodeId}::${portId}` before returning. Re-fetch from
    // the cache so the requested portId's ref is returned (the emitter's
    // return value is the canonical/default port, but the caller may want
    // a different one).
    const fresh = ctx.arrayRefs.get(cacheKey);
    if (fresh) return fresh;
    // Fall back if portId wasn't explicit (compileValueNode dispatch for the
    // hybrid path) — return whatever the emitter handed back.
    return result;
  }
  ctx.arrayRefs.set(nodeId, result);
  return result;
}

// ---------------------------------------------------------------------------
// Per-node flow emitters
// ---------------------------------------------------------------------------

const FLOW_NODE_EMITTERS: Record<string, NodeFlowEmitter> = {

  // Write to a scalar Local Variable. Stores the (cast-to-variable-type)
  // input value into the variable's function-local. Array variables use
  // setArrayElement instead — validation rejects the mismatch upstream.
  setVariable: ({ node, ctx, inputs }) => {
    const variableId = node.data.config.variableId as string;
    const slot = ctx.variableLocals.get(variableId);
    if (!slot) { ctx.errors.push(`setVariable: unknown variable "${variableId}"`); return false; }
    if (slot.kind !== 'scalar') {
      ctx.errors.push(`setVariable: variable "${variableId}" is an array; use setArrayElement instead`);
      return false;
    }
    const v = inputs['value'];
    if (!v) { ctx.errors.push('setVariable: missing value input'); return false; }
    pushValueAs(ctx.emitter, v, slot.valtype);
    ctx.emitter.localSet(slot.localIdx);
    return true;
  },

  // Write to an array Local Variable at a runtime-computed index. Bounds-
  // checked at runtime via i32 compare — out-of-range writes silently skip
  // (mirrors the JS emit's `if (index >= 0 && index < arr.length)`).
  setArrayElement: ({ node, ctx, inputs }) => {
    const variableId = node.data.config.variableId as string;
    const slot = ctx.variableLocals.get(variableId);
    if (!slot) { ctx.errors.push(`setArrayElement: unknown variable "${variableId}"`); return false; }
    if (slot.kind !== 'array') {
      ctx.errors.push(`setArrayElement: variable "${variableId}" is a scalar; use setVariable instead`);
      return false;
    }
    const idxRef = inputs['index'];
    const v = inputs['value'];
    if (!idxRef) { ctx.errors.push('setArrayElement: missing index input'); return false; }
    if (!v) { ctx.errors.push('setArrayElement: missing value input'); return false; }
    const em = ctx.emitter;
    // Stash idx as i32 local so we can both bounds-check and reuse for store.
    const idxLocal = em.allocLocal(I32);
    pushValueAs(em, idxRef, I32);
    em.localSet(idxLocal);
    // if (idx >= 0 && idx < length) { ... }
    em.localGet(idxLocal); em.i32Const(0); em.op(OP_I32_GE_S);
    em.localGet(idxLocal); em.i32Const(slot.length); em.op(OP_I32_LT_S);
    em.op(OP_I32_AND);
    em.ifThen(() => {
      // Address = offsetLocal + idx * elemBytes
      em.localGet(slot.offsetLocal);
      em.localGet(idxLocal);
      em.i32Const(slot.elemBytes);
      em.op(OP_I32_MUL);
      em.op(OP_I32_ADD);
      // Value
      pushValueAs(em, v, slot.elemValtype);
      // Store
      if (slot.elemValtype === F64) em.f64Store(0, 3);
      else if (slot.elemBytes === 1) em.i32Store8(0, 0);
      else em.i32Store(0, 2);
    });
    return true;
  },

  setAttribute: ({ node, ctx, inputs }) => {
    const attrId = node.data.config.attributeId as string;
    const attr = getAttr(ctx.layout, attrId);
    if (!attr) { ctx.errors.push(`setAttribute: unknown attr ${attrId}`); return false; }
    const v = inputs['value'];
    if (!v) { ctx.errors.push('setAttribute: missing value input'); return false; }
    emitCellWriteAtIdx(ctx, attr, v);
    return true;
  },

  setCellLooks: ({ node, ctx, inputs }) => {
    const cfg = node.data.config;
    const useGlyph = !!cfg.useGlyph;
    const setBg = cfg.setBackground !== false; // default true
    const viewerId = (cfg.mappingId as string) || '';
    const isCurrentViewer = viewerId === CURRENT_VIEWER_SENTINEL;
    const viewerInt = isCurrentViewer ? undefined : ctx.viewerIds[viewerId];
    if (!isCurrentViewer && viewerInt === undefined) {
      // Viewer not in our compile-time map — skip silently.
      return true;
    }
    const doBg = !useGlyph || setBg;
    const doGlyph = useGlyph && ctx.layout.hasGlyphs;
    if (!doBg && !doGlyph) return true;

    const emitWrites = () => {
      if (doBg) {
        // colors[idx] RGBA — same as the former setColorViewer. R/G/B = cell color.
        const colorByte = ctx.emitter.allocLocal(I32);
        ctx.emitter.localGet(ctx.iLocalIdx);
        ctx.emitter.i32Const(4);
        ctx.emitter.op(OP_I32_MUL);
        ctx.emitter.localTee(colorByte);
        const r = inputs['r'] ?? { inline: true, value: 0, valtype: I32 };
        const g = inputs['g'] ?? { inline: true, value: 0, valtype: I32 };
        const b = inputs['b'] ?? { inline: true, value: 0, valtype: I32 };
        pushValueAs(ctx.emitter, r, I32);
        ctx.emitter.i32Store8(ctx.layout.colorsOffset + 0, 0);
        ctx.emitter.localGet(colorByte);
        pushValueAs(ctx.emitter, g, I32);
        ctx.emitter.i32Store8(ctx.layout.colorsOffset + 1, 0);
        ctx.emitter.localGet(colorByte);
        pushValueAs(ctx.emitter, b, I32);
        ctx.emitter.i32Store8(ctx.layout.colorsOffset + 2, 0);
        ctx.emitter.localGet(colorByte);
        // Cell alpha (default inline 255 → i32Const(255), byte-identical).
        // i32Store8 truncates to the low byte, matching r/g/b's existing
        // out-of-range behaviour (JS clamps via Uint8ClampedArray — same caveat).
        const a = inputs['a'] ?? { inline: true, value: 255, valtype: I32 };
        pushValueAs(ctx.emitter, a, I32);
        ctx.emitter.i32Store8(ctx.layout.colorsOffset + 3, 0);
      }
      if (doGlyph) {
        // glyphCodes[idx] (u32) + packed glyphColors[idx] (R|G<<8|B<<16).
        const glyphByte = ctx.emitter.allocLocal(I32);
        ctx.emitter.localGet(ctx.iLocalIdx);
        ctx.emitter.i32Const(4);
        ctx.emitter.op(OP_I32_MUL);
        ctx.emitter.localTee(glyphByte);
        const cp = inputs['glyph'] ?? { inline: true, value: 0, valtype: I32 };
        pushValueAs(ctx.emitter, cp, I32);
        ctx.emitter.i32Store(ctx.layout.glyphCodesOffset, 2);

        ctx.emitter.localGet(glyphByte);
        const gr = inputs['glyphR'] ?? { inline: true, value: 0, valtype: I32 };
        const gg = inputs['glyphG'] ?? { inline: true, value: 0, valtype: I32 };
        const gb = inputs['glyphB'] ?? { inline: true, value: 0, valtype: I32 };
        pushValueAs(ctx.emitter, gr, I32);
        ctx.emitter.i32Const(0xFF);
        ctx.emitter.op(OP_I32_AND);
        pushValueAs(ctx.emitter, gg, I32);
        ctx.emitter.i32Const(0xFF);
        ctx.emitter.op(OP_I32_AND);
        ctx.emitter.i32Const(8);
        ctx.emitter.op(OP_I32_SHL);
        ctx.emitter.op(OP_I32_OR);
        pushValueAs(ctx.emitter, gb, I32);
        ctx.emitter.i32Const(0xFF);
        ctx.emitter.op(OP_I32_AND);
        ctx.emitter.i32Const(16);
        ctx.emitter.op(OP_I32_SHL);
        ctx.emitter.op(OP_I32_OR);
        ctx.emitter.i32Store(ctx.layout.glyphColorsOffset, 2);
      }
    };

    if (isCurrentViewer) {
      // "Current Simulator Selected": whatever pass is running IS the current
      // viewer — write unconditionally (mirrors the JS emit with no _isV_ guard).
      emitWrites();
      return true;
    }
    // Per-step hoist: viewerLocals[viewerId] holds (activeViewer == viewerInt).
    const cachedLocal = ctx.viewerLocals.get(viewerId);
    if (cachedLocal !== undefined) {
      ctx.emitter.localGet(cachedLocal);
    } else {
      ctx.emitter.i32Const(0);
      ctx.emitter.i32Load(ctx.layout.activeViewerOffset, 2);
      ctx.emitter.i32Const(viewerInt!);
      ctx.emitter.op(OP_I32_EQ);
    }
    ctx.emitter.ifThen(emitWrites);
    return true;
  },

  setIndicator: ({ node, ctx, inputs }) => {
    const idxRaw = node.data.config._indicatorIdx;
    const idx = Number(idxRaw ?? -1);
    const id = ctx.layout.indicatorIds[idx];
    if (!id) { ctx.errors.push(`setIndicator: bad index ${idx}`); return false; }
    const off = ctx.layout.indicatorOffset[id]!;
    const v = inputs['value'] ?? { inline: true, value: 0, valtype: F64 };
    ctx.emitter.i32Const(0);
    pushValueAs(ctx.emitter, v, F64);
    ctx.emitter.f64Store(off, 3);
    return true;
  },

  // Stop Event: if stopFlag[0] === 0, write the compile-time stop index there.
  // First triggered stop event in a step wins; worker reads the flag after the
  // step completes and surfaces the user's message. Mirrors the JS compile in
  // StopEventNode.ts exactly (same first-match semantics, same index).
  stopEvent: ({ node, ctx }) => {
    const stopIdx = Number(node.data.config._stopIdx ?? 0);
    if (!stopIdx) return true; // unresolved — silently skip (matches JS)
    const off = ctx.layout.stopFlagOffset;
    ctx.emitter.i32Const(0);
    ctx.emitter.i32Load(off, 2);
    ctx.emitter.op(OP_I32_EQZ);
    ctx.emitter.ifThen(() => {
      ctx.emitter.i32Const(0);
      ctx.emitter.i32Const(stopIdx);
      ctx.emitter.i32Store(off, 2);
    });
    return true;
  },

  updateIndicator: ({ node, ctx, inputs }) => {
    const idxRaw = node.data.config._indicatorIdx;
    const idx = Number(idxRaw ?? -1);
    const id = ctx.layout.indicatorIds[idx];
    if (!id) { ctx.errors.push(`updateIndicator: bad index ${idx}`); return false; }
    const off = ctx.layout.indicatorOffset[id]!;
    const op = (node.data.config.operation as string) || 'increment';
    const v = inputs['value'];
    const tagLen = Number(node.data.config._tagLen) || 1;
    const em = ctx.emitter;

    // For tag/bool ops we operate via i32; final f64 store at the end.
    if (op === 'next' || op === 'previous') {
      // i32 modulo arithmetic. cur = (i32) f64 indicator value.
      em.i32Const(0); // store addr
      em.i32Const(0); em.f64Load(off, 3); em.f64ToI32();
      if (op === 'next') {
        em.i32Const(1); em.op(OP_I32_ADD);
      } else {
        em.i32Const(1); em.op(OP_I32_SUB);
        em.i32Const(tagLen); em.op(OP_I32_ADD);
      }
      em.i32Const(tagLen);
      em.emit(byte(0x6f)); // OP_I32_REM_S
      em.i32ToF64();
      em.f64Store(off, 3);
      return true;
    }
    if (op === 'or' || op === 'and') {
      if (!v) { ctx.errors.push(`updateIndicator ${op}: missing value`); return false; }
      // result = (cur || v) for or; (cur && v) for and; truncated to bool 0/1
      em.i32Const(0); // store addr
      // cur (as i32 boolean: cur != 0)
      em.i32Const(0); em.f64Load(off, 3); em.f64ToI32();
      em.i32Const(0); em.op(OP_I32_NE_OP);
      // v as i32 boolean
      pushValueAs(em, v, I32);
      em.i32Const(0); em.op(OP_I32_NE_OP);
      em.op(op === 'or' ? OP_I32_OR : OP_I32_AND);
      em.i32ToF64();
      em.f64Store(off, 3);
      return true;
    }

    // Default path: f64 arithmetic
    em.i32Const(0);  // store address
    em.i32Const(0);  // load address
    em.f64Load(off, 3);  // current value
    switch (op) {
      case 'increment':
        if (!v) { ctx.errors.push('updateIndicator increment: missing value'); return false; }
        pushValueAs(em, v, F64);
        em.op(OP_F64_ADD);
        break;
      case 'decrement':
        if (!v) { ctx.errors.push('updateIndicator decrement: missing value'); return false; }
        pushValueAs(em, v, F64);
        em.op(OP_F64_SUB);
        break;
      case 'max':
        if (!v) { ctx.errors.push('updateIndicator max: missing value'); return false; }
        pushValueAs(em, v, F64);
        em.op(OP_F64_MAX);
        break;
      case 'min':
        if (!v) { ctx.errors.push('updateIndicator min: missing value'); return false; }
        pushValueAs(em, v, F64);
        em.op(OP_F64_MIN);
        break;
      case 'toggle':
        // value = (cur ? 0 : 1) for bool — but we operate on f64. Use cur != 0 ? 0 : 1.
        em.f64Const(0);
        em.op(OP_F64_NE);  // i32 result
        em.op(OP_I32_EQZ);
        em.i32ToF64();
        break;
      default:
        ctx.errors.push(`updateIndicator: unsupported op ${op}`);
        return false;
    }
    em.f64Store(off, 3);
    return true;
  },

  updateAttribute: ({ node, ctx, inputs }) => {
    const attrId = node.data.config.attributeId as string;
    const op = (node.data.config.operation as string) || 'increment';
    const attr = getAttr(ctx.layout, attrId);
    if (!attr) { ctx.errors.push(`updateAttribute: unknown attr ${attrId}`); return false; }
    const v = inputs['value'];
    const t = attr.type;
    const isF = t === 'float';
    const tagLen = Number(node.data.config._tagLen) || 1;
    const em = ctx.emitter;

    // Tag operations — int arithmetic with modulo
    if (op === 'next' || op === 'previous') {
      pushCellByteOffset(ctx, attr.itemBytes); // store addr
      pushCellByteOffset(ctx, attr.itemBytes); // load addr
      em.i32Load(attr.writeOffset, 2);
      if (op === 'next') {
        em.i32Const(1); em.op(OP_I32_ADD);
      } else {
        em.i32Const(1); em.op(OP_I32_SUB);
        em.i32Const(tagLen); em.op(OP_I32_ADD);
      }
      em.i32Const(tagLen);
      em.emit(byte(0x6f)); // OP_I32_REM_S
      em.i32Store(attr.writeOffset, 2);
      return true;
    }

    // Bool or/and
    if (op === 'or' || op === 'and') {
      if (!v) { ctx.errors.push(`updateAttribute ${op}: missing value`); return false; }
      pushCellByteOffset(ctx, attr.itemBytes); // store addr
      pushCellByteOffset(ctx, attr.itemBytes); // load addr
      em.i32Load8U(attr.writeOffset, 0);
      // current as 0/1 bool
      em.i32Const(0); em.op(OP_I32_NE_OP);
      pushValueAs(em, v, I32);
      em.i32Const(0); em.op(OP_I32_NE_OP);
      em.op(op === 'or' ? OP_I32_OR : OP_I32_AND);
      em.i32Store8(attr.writeOffset, 0);
      return true;
    }

    // Read current value from WRITE buffer (matches JS read-modify-write semantics)
    pushCellByteOffset(ctx, attr.itemBytes);  // address for store
    pushCellByteOffset(ctx, attr.itemBytes);  // address for load
    if (t === 'bool') em.i32Load8U(attr.writeOffset, 0);
    else if (t === 'float') em.f64Load(attr.writeOffset, 3);
    else em.i32Load(attr.writeOffset, 2);
    // Now stack: [storeAddr, currentValue]

    switch (op) {
      case 'increment':
        if (!v) { ctx.errors.push('updateAttribute increment: missing value'); return false; }
        pushValueAs(em, v, isF ? F64 : I32);
        em.op(isF ? OP_F64_ADD : OP_I32_ADD);
        break;
      case 'decrement':
        if (!v) { ctx.errors.push('updateAttribute decrement: missing value'); return false; }
        pushValueAs(em, v, isF ? F64 : I32);
        em.op(isF ? OP_F64_SUB : OP_I32_SUB);
        break;
      case 'max':
        if (!v) { ctx.errors.push('updateAttribute max: missing value'); return false; }
        if (isF) {
          pushValueAs(em, v, F64);
          em.op(OP_F64_MAX);
        } else {
          // i32 max via select: cur > val ? cur : val
          // Stack currently: [storeAddr, cur]
          const curLoc = em.allocLocal(I32);
          em.localSet(curLoc);
          // Stack now: [storeAddr]
          const valLoc = em.allocLocal(I32);
          pushValueAs(em, v, I32);
          em.localSet(valLoc);
          em.localGet(curLoc); em.localGet(valLoc);
          em.localGet(curLoc); em.localGet(valLoc);
          em.op(OP_I32_GT_S);
          em.op(OP_SELECT);
        }
        break;
      case 'min':
        if (!v) { ctx.errors.push('updateAttribute min: missing value'); return false; }
        if (isF) {
          pushValueAs(em, v, F64);
          em.op(OP_F64_MIN);
        } else {
          const curLoc = em.allocLocal(I32);
          em.localSet(curLoc);
          const valLoc = em.allocLocal(I32);
          pushValueAs(em, v, I32);
          em.localSet(valLoc);
          em.localGet(curLoc); em.localGet(valLoc);
          em.localGet(curLoc); em.localGet(valLoc);
          em.op(OP_I32_LT_S);
          em.op(OP_SELECT);
        }
        break;
      case 'toggle':
        // Bool only: 1 - current
        em.i32Const(1);
        em.emit(byte(0x73)); // OP_I32_XOR
        break;
      default:
        ctx.errors.push(`updateAttribute: unsupported op ${op}`);
        return false;
    }

    if (t === 'bool') em.i32Store8(attr.writeOffset, 0);
    else if (t === 'float') em.f64Store(attr.writeOffset, 3);
    else em.i32Store(attr.writeOffset, 2);
    return true;
  },

  // -- setNeighborAttributeByIndex (async-only, Wave A.6): writes a value to
  //    one or more neighbours via packed NIs. Sentinel guards: niLocal !=
  //    INVALID_NI before the access; nbrCellIdx < total to skip the constant-
  //    boundary sentinel slot.
  setNeighborAttributeByIndex: ({ node, ctx, inputs }) => {
    const attrId = node.data.config.attributeId as string;
    const attr = getAttr(ctx.layout, attrId);
    if (!attr) {
      ctx.errors.push(`setNeighborAttributeByIndex: unknown attr ${attrId}`);
      return false;
    }
    if (!ctx.layout.isAsync) {
      ctx.errors.push(`setNeighborAttributeByIndex: requires asynchronous update mode`);
      return false;
    }
    const valueRef = inputs['value'] ?? { inline: true, value: 0, valtype: F64 };

    // Check if index input is wired to an array-producing node.
    const indexSrc = ctx.inputToSource.get(`${node.id}:index`);
    let indexArr: ArrayRef | null = null;
    if (indexSrc) {
      const srcNode = ctx.nodeMap.get(indexSrc.nodeId);
      if (srcNode && ctx.producesArray(srcNode)) {
        indexArr = compileArrayNode(indexSrc.nodeId, ctx, indexSrc.portId);
      }
    }

    const writeOne = (pushNi: () => void) => {
      const niLocal = ctx.emitter.allocLocal(I32);
      pushNi();
      ctx.emitter.localSet(niLocal);
      // Guard: skip if NI is INVALID_NI sentinel
      ctx.emitter.localGet(niLocal);
      ctx.emitter.i32Const(INVALID_NI);
      ctx.emitter.op(OP_I32_EQ);
      ctx.emitter.op(OP_I32_EQZ);
      ctx.emitter.ifThen(() => {
        const nbrCellLocal = ctx.emitter.allocLocal(I32);
        pushNiCellIdx(ctx, niLocal);
        ctx.emitter.localSet(nbrCellLocal);
        // Guard: skip the boundary-sentinel cell (>= total)
        ctx.emitter.localGet(nbrCellLocal);
        ctx.emitter.localGet(0); // total param
        ctx.emitter.op(OP_I32_LT_S);
        ctx.emitter.ifThen(() => {
          ctx.emitter.localGet(nbrCellLocal);
          if (attr.itemBytes !== 1) {
            ctx.emitter.i32Const(attr.itemBytes);
            ctx.emitter.op(OP_I32_MUL);
          }
          pushValueAs(ctx.emitter, valueRef, attrValType(attr.type));
          if (attr.type === 'bool') ctx.emitter.i32Store8(attr.writeOffset, 0);
          else if (attr.type === 'float') ctx.emitter.f64Store(attr.writeOffset, 3);
          else ctx.emitter.i32Store(attr.writeOffset, 2);
        });
      });
    };

    if (indexArr) {
      // Loop over each element in the index array
      const k = ctx.emitter.allocLocal(I32);
      ctx.emitter.i32Const(0); ctx.emitter.localSet(k);
      ctx.emitter.block(() => {
        ctx.emitter.loop(() => {
          ctx.emitter.localGet(k); ctx.emitter.localGet(indexArr!.lenLocal); ctx.emitter.op(OP_I32_GE_S); ctx.emitter.brIf(1);
          writeOne(() => {
            ctx.emitter.localGet(k);
            emitArrayLoadElem(ctx.emitter, indexArr!);
            if (indexArr!.elemValtype === F64) ctx.emitter.f64ToI32();
          });
          ctx.emitter.localGet(k); ctx.emitter.i32Const(1); ctx.emitter.op(OP_I32_ADD); ctx.emitter.localSet(k);
          ctx.emitter.br(0);
        });
      });
    } else {
      const indexRef = inputs['index'] ?? { inline: true, value: 0, valtype: I32 };
      writeOne(() => pushValueAs(ctx.emitter, indexRef, I32));
    }
    return true;
  },

  // -- markCellUpdated (async-only): writes 1 into `_skipped[cellIdx]` for
  //    one or more neighbours via packed NIs. The async cell loop reads this
  //    flag at the top of each iteration via `i32.load8_u` at the same offset
  //    and `br`s past the body when set. Mirrors setNeighborAttributeByIndex's
  //    scalar+array branching + INVALID_NI / boundary-sentinel guards.
  markCellUpdated: ({ node, ctx, inputs }) => {
    if (!ctx.layout.isAsync) {
      ctx.errors.push(`markCellUpdated: requires asynchronous update mode`);
      return false;
    }

    const indexSrc = ctx.inputToSource.get(`${node.id}:index`);
    let indexArr: ArrayRef | null = null;
    if (indexSrc) {
      const srcNode = ctx.nodeMap.get(indexSrc.nodeId);
      if (srcNode && ctx.producesArray(srcNode)) {
        indexArr = compileArrayNode(indexSrc.nodeId, ctx, indexSrc.portId);
      }
    }

    const writeOne = (pushNi: () => void) => {
      const niLocal = ctx.emitter.allocLocal(I32);
      pushNi();
      ctx.emitter.localSet(niLocal);
      // Guard: skip INVALID_NI
      ctx.emitter.localGet(niLocal);
      ctx.emitter.i32Const(INVALID_NI);
      ctx.emitter.op(OP_I32_EQ);
      ctx.emitter.op(OP_I32_EQZ);
      ctx.emitter.ifThen(() => {
        const nbrCellLocal = ctx.emitter.allocLocal(I32);
        pushNiCellIdx(ctx, niLocal);
        ctx.emitter.localSet(nbrCellLocal);
        // Guard: skip the boundary-sentinel cell (>= total)
        ctx.emitter.localGet(nbrCellLocal);
        ctx.emitter.localGet(0); // total param
        ctx.emitter.op(OP_I32_LT_S);
        ctx.emitter.ifThen(() => {
          // _skipped[nbrCell] = 1  — one byte per cell, no multiply needed.
          ctx.emitter.localGet(nbrCellLocal);
          ctx.emitter.i32Const(1);
          ctx.emitter.i32Store8(ctx.layout.skippedOffset, 0);
        });
      });
    };

    if (indexArr) {
      const k = ctx.emitter.allocLocal(I32);
      ctx.emitter.i32Const(0); ctx.emitter.localSet(k);
      ctx.emitter.block(() => {
        ctx.emitter.loop(() => {
          ctx.emitter.localGet(k); ctx.emitter.localGet(indexArr!.lenLocal); ctx.emitter.op(OP_I32_GE_S); ctx.emitter.brIf(1);
          writeOne(() => {
            ctx.emitter.localGet(k);
            emitArrayLoadElem(ctx.emitter, indexArr!);
            if (indexArr!.elemValtype === F64) ctx.emitter.f64ToI32();
          });
          ctx.emitter.localGet(k); ctx.emitter.i32Const(1); ctx.emitter.op(OP_I32_ADD); ctx.emitter.localSet(k);
          ctx.emitter.br(0);
        });
      });
    } else {
      const indexRef = inputs['index'] ?? { inline: true, value: 0, valtype: I32 };
      writeOne(() => pushValueAs(ctx.emitter, indexRef, I32));
    }
    return true;
  },

  // -- setNeighborhoodAttribute (async-only): writes value to EVERY neighbor.
  setNeighborhoodAttribute: ({ node, ctx, inputs }) => {
    const nbrId = node.data.config.neighborhoodId as string;
    const attrId = node.data.config.attributeId as string;
    const nbr = getNbr(ctx.layout, nbrId);
    const attr = getAttr(ctx.layout, attrId);
    if (!nbr || !attr) {
      ctx.errors.push(`setNeighborhoodAttribute: unknown nbr/attr (${nbrId}/${attrId})`);
      return false;
    }
    if (!ctx.layout.isAsync) {
      ctx.errors.push(`setNeighborhoodAttribute: requires asynchronous update mode`);
      return false;
    }
    const valueRef = inputs['value'] ?? { inline: true, value: 0, valtype: F64 };
    const em = ctx.emitter;
    const n = em.allocLocal(I32);
    em.i32Const(0); em.localSet(n);
    em.block(() => {
      em.loop(() => {
        em.localGet(n); em.i32Const(nbr.size); em.op(OP_I32_GE_S); em.brIf(1);
        // nbrCell = nIdx[i*nbrSize + n]
        const nbrCell = em.allocLocal(I32);
        em.localGet(ctx.iLocalIdx); em.i32Const(nbr.size); em.op(OP_I32_MUL);
        em.localGet(n); em.op(OP_I32_ADD);
        em.i32Const(4); em.op(OP_I32_MUL);
        em.i32Load(nbr.offset, 2);
        em.localSet(nbrCell);
        em.localGet(nbrCell); em.localGet(0); em.op(OP_I32_LT_S);
        em.ifThen(() => {
          em.localGet(nbrCell);
          if (attr.itemBytes !== 1) { em.i32Const(attr.itemBytes); em.op(OP_I32_MUL); }
          pushValueAs(em, valueRef, attrValType(attr.type));
          if (attr.type === 'bool') em.i32Store8(attr.writeOffset, 0);
          else if (attr.type === 'float') em.f64Store(attr.writeOffset, 3);
          else em.i32Store(attr.writeOffset, 2);
        });
        em.localGet(n); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(n);
        em.br(0);
      });
    });
    return true;
  },

  // -- Variegated Cells: Set Orientation ---------------------------------
  // Writes the current cell's orientation to the write buffer, clamped to
  // 0..3 via `& 3`. Mirrors the JS emit `w_orientation[idx] = (value) & 3`.
  setOrientation: ({ ctx, inputs }) => {
    if (!ctx.layout.variegatedEnabled) {
      ctx.errors.push('setOrientation: variegated cells disabled');
      return false;
    }
    const valueRef = inputs['value'] ?? { inline: true, value: 0, valtype: I32 };
    const em = ctx.emitter;
    // addr = idx * 4
    pushCellByteOffset(ctx, 4);
    // value & 3
    pushValueAs(em, valueRef, I32);
    em.i32Const(3);
    em.op(OP_I32_AND);
    em.i32Store(ctx.layout.orientationWriteOffset, 2);
    return true;
  },

  // -- Variegated Cells: Set Facing Orientation (async-only) --------------
  // Writes the orientation of the neighbour touching this cell in a fixed
  // direction. directionTag pre-resolved into (_resolvedDirIdx, _resolvedDr,
  // _resolvedDc, _boundaryTreatment). Async-only — sync mode's post-step
  // bulk copy would overwrite the neighbour write. Boundary-sentinel guard
  // `nbrCell < total` protects the constant-boundary slot.
  setFacingOrientation: ({ node, ctx, inputs }) => {
    if (!ctx.layout.variegatedEnabled) {
      ctx.errors.push('setFacingOrientation: variegated cells disabled');
      return false;
    }
    if (!ctx.layout.isAsync) {
      ctx.errors.push('setFacingOrientation: requires asynchronous update mode');
      return false;
    }
    const em = ctx.emitter;
    const dirIdx = Number(node.data.config._resolvedDirIdx);
    const dr = Number(node.data.config._resolvedDr);
    const dc = Number(node.data.config._resolvedDc);
    const boundary = (node.data.config._boundaryTreatment as string) || 'torus';
    if (!Number.isFinite(dirIdx) || dirIdx < 0) {
      return true; // no-op when direction unset
    }
    const valueRef = inputs['value'] ?? { inline: true, value: 0, valtype: I32 };
    const total = ctx.layout.total;
    const W = ctx.model.properties.gridWidth;
    const H = ctx.model.properties.gridHeight;
    const nbrCellLocal = em.allocLocal(I32);
    if (boundary === 'constant') {
      const nRow = em.allocLocal(I32);
      em.localGet(ctx.rowLocalIdx);
      em.i32Const(dr); em.op(OP_I32_ADD);
      em.localSet(nRow);
      const nCol = em.allocLocal(I32);
      em.localGet(ctx.colLocalIdx);
      em.i32Const(dc); em.op(OP_I32_ADD);
      em.localSet(nCol);
      em.i32Const(total); em.localSet(nbrCellLocal);
      em.localGet(nRow); em.i32Const(0); em.op(OP_I32_GE_S);
      em.localGet(nRow); em.i32Const(H); em.op(OP_I32_LT_S);
      em.op(OP_I32_AND);
      em.localGet(nCol); em.i32Const(0); em.op(OP_I32_GE_S);
      em.op(OP_I32_AND);
      em.localGet(nCol); em.i32Const(W); em.op(OP_I32_LT_S);
      em.op(OP_I32_AND);
      em.ifThen(() => {
        em.localGet(nRow); em.i32Const(W); em.op(OP_I32_MUL);
        em.localGet(nCol); em.op(OP_I32_ADD);
        em.localSet(nbrCellLocal);
      });
    } else {
      em.localGet(ctx.rowLocalIdx);
      if (dr !== 0) { em.i32Const(dr); em.op(OP_I32_ADD); }
      em.i32Const(H); em.op(OP_I32_REM_S);
      em.i32Const(H); em.op(OP_I32_ADD);
      em.i32Const(H); em.op(OP_I32_REM_S);
      em.i32Const(W); em.op(OP_I32_MUL);
      em.localGet(ctx.colLocalIdx);
      if (dc !== 0) { em.i32Const(dc); em.op(OP_I32_ADD); }
      em.i32Const(W); em.op(OP_I32_REM_S);
      em.i32Const(W); em.op(OP_I32_ADD);
      em.i32Const(W); em.op(OP_I32_REM_S);
      em.op(OP_I32_ADD);
      em.localSet(nbrCellLocal);
    }
    em.localGet(nbrCellLocal);
    em.localGet(0); // total param
    em.op(OP_I32_LT_S);
    em.ifThen(() => {
      em.localGet(nbrCellLocal);
      em.i32Const(4);
      em.op(OP_I32_MUL);
      pushValueAs(em, valueRef, I32);
      em.i32Const(3);
      em.op(OP_I32_AND);
      em.i32Store(ctx.layout.orientationWriteOffset, 2);
    });
    return true;
  },

  // -- Variegated Cells: Set Neighbor Orientation By Index (async-only) ---
  // Writes one (or many) neighbour's orientation at a packed NI offset.
  // Mirrors `setNeighborAttributeByIndex` — handles both scalar NI input and
  // an NI[] array (loops over each element). Guards INVALID_NI and the
  // boundary sentinel.
  setNeighborOrientationByIndex: ({ node, ctx, inputs }) => {
    if (!ctx.layout.variegatedEnabled) {
      ctx.errors.push('setNeighborOrientationByIndex: variegated cells disabled');
      return false;
    }
    if (!ctx.layout.isAsync) {
      ctx.errors.push('setNeighborOrientationByIndex: requires asynchronous update mode');
      return false;
    }
    const em = ctx.emitter;
    const valueRef = inputs['value'] ?? { inline: true, value: 0, valtype: I32 };

    const indexSrc = ctx.inputToSource.get(`${node.id}:index`);
    let indexArr: ArrayRef | null = null;
    if (indexSrc) {
      const srcNode = ctx.nodeMap.get(indexSrc.nodeId);
      if (srcNode && ctx.producesArray(srcNode)) {
        indexArr = compileArrayNode(indexSrc.nodeId, ctx, indexSrc.portId);
      }
    }

    const writeOne = (pushNi: () => void) => {
      const niLocal = em.allocLocal(I32);
      pushNi();
      em.localSet(niLocal);
      em.localGet(niLocal);
      em.i32Const(INVALID_NI);
      em.op(OP_I32_EQ);
      em.op(OP_I32_EQZ);
      em.ifThen(() => {
        const nbrCellLocal = em.allocLocal(I32);
        pushNiCellIdx(ctx, niLocal);
        em.localSet(nbrCellLocal);
        em.localGet(nbrCellLocal);
        em.localGet(0); // total param
        em.op(OP_I32_LT_S);
        em.ifThen(() => {
          em.localGet(nbrCellLocal);
          em.i32Const(4);
          em.op(OP_I32_MUL);
          pushValueAs(em, valueRef, I32);
          em.i32Const(3);
          em.op(OP_I32_AND);
          em.i32Store(ctx.layout.orientationWriteOffset, 2);
        });
      });
    };

    if (indexArr) {
      const k = em.allocLocal(I32);
      em.i32Const(0); em.localSet(k);
      em.block(() => {
        em.loop(() => {
          em.localGet(k); em.localGet(indexArr!.lenLocal); em.op(OP_I32_GE_S); em.brIf(1);
          writeOne(() => {
            em.localGet(k);
            emitArrayLoadElem(em, indexArr!);
            if (indexArr!.elemValtype === F64) em.f64ToI32();
          });
          em.localGet(k); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(k);
          em.br(0);
        });
      });
    } else {
      const indexRef = inputs['index'] ?? { inline: true, value: 0, valtype: I32 };
      writeOne(() => pushValueAs(em, indexRef, I32));
    }
    return true;
  },

  // -- Transfer Cell Attributes to Neighbor (async-only) -----------------
  // Copy/move/swap the current values of the configured cell attributes (and
  // optionally orientation) between this cell and the target neighbour. Reads
  // AND writes go through the WRITE buffer at this flow position (post-update
  // semantics; async aliases write===read), so transferred values reflect any
  // earlier mid-step writes. copyTo: w[nbr]=w[self] (+ reset self if
  // 'defaults'); copyFrom: w[self]=w[nbr] (+ reset nbr); swap: temp exchange.
  // All writes share one NI guard (INVALID_NI + boundary sentinel, checked once).
  moveSelfToNeighbor: ({ node, ctx, inputs }) => {
    if (!ctx.layout.isAsync) {
      ctx.errors.push('moveSelfToNeighbor: requires asynchronous update mode');
      return false;
    }
    const em = ctx.emitter;
    const payloadCount = Math.max(1, Number(node.data.config.payloadCount) || 1);
    const operation = (node.data.config.operation as string) || 'copyTo';
    const resetSource = ((node.data.config.nonReceiving as string) || 'defaults') === 'defaults';
    // Orientation only exists in Variegated Cells models. Silently ignore a
    // stale `includeOrientation` on a non-variegated model — the orientation
    // region isn't allocated there, so emitting a transfer would corrupt
    // memory. The modeler still surfaces a validation badge for the mismatch.
    const includeOri = !!node.data.config.includeOrientation && ctx.layout.variegatedEnabled;
    const niRef = inputs['targetNI'] ?? { inline: true, value: 0, valtype: I32 };
    // Resolve target NI + cell index once.
    const niLocal = em.allocLocal(I32);
    pushValueAs(em, niRef, I32);
    em.localSet(niLocal);
    // Guard: skip if NI is INVALID_NI sentinel.
    em.localGet(niLocal);
    em.i32Const(INVALID_NI);
    em.op(OP_I32_EQ);
    em.op(OP_I32_EQZ);
    em.ifThen(() => {
      const nbrCellLocal = em.allocLocal(I32);
      pushNiCellIdx(ctx, niLocal);
      em.localSet(nbrCellLocal);
      // Guard: boundary sentinel (>= total).
      em.localGet(nbrCellLocal);
      em.localGet(0); // total param
      em.op(OP_I32_LT_S);
      em.ifThen(() => {
        const pushNbrOffset = (itemBytes: number) => {
          em.localGet(nbrCellLocal);
          if (itemBytes !== 1) { em.i32Const(itemBytes); em.op(OP_I32_MUL); }
        };
        // Transfer one buffer (cell attr or orientation). Reads + writes both go
        // through the WRITE buffer so values reflect this step's earlier writes
        // (post-update semantics); async mode aliases write===read.
        const emitXfer = (
          itemBytes: number,
          valtype: ValType,
          loadVal: () => void,
          storeVal: () => void,
          defaultVal: number,
        ) => {
          const defRef: ValueRef = { inline: true, value: defaultVal, valtype };
          if (operation === 'copyFrom') {
            // w[self] = w[nbr]
            pushCellByteOffset(ctx, itemBytes);
            pushNbrOffset(itemBytes); loadVal();
            storeVal();
            if (resetSource) { pushNbrOffset(itemBytes); pushValueAs(em, defRef, valtype); storeVal(); }
          } else if (operation === 'swap') {
            const tmp = em.allocLocal(valtype);
            pushCellByteOffset(ctx, itemBytes); loadVal(); em.localSet(tmp);   // tmp = w[self]
            pushCellByteOffset(ctx, itemBytes); pushNbrOffset(itemBytes); loadVal(); storeVal(); // w[self] = w[nbr]
            pushNbrOffset(itemBytes); em.localGet(tmp); storeVal();            // w[nbr] = tmp
          } else {
            // copyTo (default)
            pushNbrOffset(itemBytes);
            pushCellByteOffset(ctx, itemBytes); loadVal();
            storeVal();
            if (resetSource) { pushCellByteOffset(ctx, itemBytes); pushValueAs(em, defRef, valtype); storeVal(); }
          }
        };
        for (let i = 0; i < payloadCount; i++) {
          const attrId = node.data.config[`attr_${i}`] as string;
          if (!attrId) continue;
          const attr = getAttr(ctx.layout, attrId);
          if (!attr) {
            ctx.errors.push(`moveSelfToNeighbor: unknown attr ${attrId} at slot ${i}`);
            continue;
          }
          const defaultNum = parseFloat((node.data.config[`_attr_${i}_default`] as string) ?? '0') || 0;
          const loadVal = () => {
            if (attr.type === 'bool') em.i32Load8U(attr.writeOffset, 0);
            else if (attr.type === 'float') em.f64Load(attr.writeOffset, 3);
            else em.i32Load(attr.writeOffset, 2);
          };
          const storeVal = () => {
            if (attr.type === 'bool') em.i32Store8(attr.writeOffset, 0);
            else if (attr.type === 'float') em.f64Store(attr.writeOffset, 3);
            else em.i32Store(attr.writeOffset, 2);
          };
          emitXfer(attr.itemBytes, attrValType(attr.type), loadVal, storeVal, defaultNum);
        }
        // Orientation as an extra slot (i32, default 0). Same operation/option.
        if (includeOri) {
          const off = ctx.layout.orientationWriteOffset;
          emitXfer(4, I32, () => em.i32Load(off, 2), () => em.i32Store(off, 2), 0);
        }
      });
    });
    return true;
  },
};

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

function compileValueNode(nodeId: string, ctx: WasmCompileCtx, portId: string = 'value'): LocalRef | null {
  const cached = getCachedPort(ctx, nodeId, portId);
  if (cached) return cached;

  const node = ctx.nodeMap.get(nodeId);
  if (!node) { ctx.errors.push(`unknown node id ${nodeId}`); return null; }
  const def = getNodeDef(node.data.nodeType);
  if (!def) { ctx.errors.push(`unknown node def ${node.data.nodeType}`); return null; }

  // Entry-point nodes have no value emitter — their value outputs are param-
  // backed. If the requested port isn't in paramRefs, that's a graph error
  // (the consumer asked for a port that doesn't exist on the entry node).
  if (node.data.nodeType === 'inputColor'
      || node.data.nodeType === 'step'
      || node.data.nodeType === 'outputMapping') {
    ctx.errors.push(`compileValueNode: entry-point node "${node.data.nodeType}" has no value emit for port "${portId}"`);
    return null;
  }

  const emitter = VALUE_NODE_EMITTERS[node.data.nodeType];
  if (!emitter) {
    ctx.errors.push(`No WASM value emitter for "${node.data.nodeType}"`);
    return null;
  }

  // Resolve all value inputs first (recursively compile their source nodes).
  // Array-typed input ports (port.isArray) are deliberately skipped here —
  // their consumers (aggregate / groupCounting / filterNeighbors etc.) fetch
  // sources via ctx.inputToSources and the array-producer dispatch path; if
  // we tried to compileValueNode an array source as a scalar we'd hit the
  // "no value emitter" error for nodes like getNeighborsAttrByIndexes.
  // Same skip-array-producer rule as the regular-flow-node path: a NI-scalar
  // port can be wired to a NI-array source (e.g. pickNRandomNeighbors output);
  // calling compileValueNode on an array producer hits "No value emitter".
  // The value emitter handles array sources itself if it cares.
  const inputs: Record<string, ValueRef | undefined> = {};
  for (const port of def.ports) {
    if (port.kind !== 'input' || port.category !== 'value') continue;
    if (port.isArray) continue;
    const source = ctx.inputToSource.get(`${nodeId}:${port.id}`);
    if (source) {
      // Skip when the source PORT is an array (consumer handles it). Hybrid
      // producers like groupCounting expose both an array `indexes` port and
      // a scalar `count` port — checking isArrayProducer(nodeType) would
      // silently drop scalar count consumers.
      const srcNode = ctx.nodeMap.get(source.nodeId);
      const srcDef = srcNode ? getNodeDef(srcNode.data.nodeType) : null;
      const srcPort = srcDef?.ports.find(p => p.id === source.portId);
      if (srcPort?.isArray) continue;
      const srcRef = compileValueNode(source.nodeId, ctx, source.portId);
      if (!srcRef) return null;
      inputs[port.id] = srcRef;
    } else {
      const inlineVal = getInlineValue(port, node.data.config);
      if (inlineVal !== undefined) {
        const num = parseInlineNum(inlineVal);
        // Same rationale as the input-resolver above the wrapper: `any` ports
        // accept fractional values; storing as I32 here would truncate via
        // `n | 0` in pushValue.
        const isFloat = port.dataType === 'float' || port.dataType === 'any';
        inputs[port.id] = { inline: true, value: num, valtype: isFloat ? F64 : I32 };
      }
    }
  }

  const result = emitter({ ctx, node, inputs });
  if (!result) return null;
  // Always cache the default-port result. Multi-output emitters also cache
  // their non-default ports inside the emitter via setCachedPort().
  if (!getCachedPort(ctx, node.id, 'value')) {
    setCachedPort(ctx, node.id, 'value', result);
  }
  // Some emitters with named output ports (e.g. interpolation 'result') need
  // the same ref under the alias too. For single-output nodes the named port
  // and 'value' refer to the same ref.
  const outputPorts = def.ports.filter(p => p.kind === 'output' && p.category === 'value');
  if (outputPorts.length === 1 && !getCachedPort(ctx, node.id, outputPorts[0]!.id)) {
    setCachedPort(ctx, node.id, outputPorts[0]!.id, result);
  }
  // Final safety: ensure the requested port has a cached entry so that the
  // next call with the same port doesn't re-run the emitter (which would
  // double-emit side effects like RNG advances). Don't overwrite a port that
  // a multi-output emitter already set explicitly.
  if (!getCachedPort(ctx, node.id, portId)) {
    setCachedPort(ctx, node.id, portId, result);
  }
  return getCachedPort(ctx, nodeId, portId) ?? result;
}

/**
 * Emit every value node assigned to `scope` by the sink analyzer, in topo
 * order. The bytecode lands at the current emit position — which is inside
 * the branch when this is called from inside an emitter.ifThen / ifThenElse
 * / loop callback (WASM's structured control flow). Loop-invariant value
 * nodes are skipped here — they're emitted once pre-loop via
 * emitInvariantValueNodes and restored into valueLocals at every cell entry,
 * so compileValueNode for them is a cache hit anyway. */
function emitValuesForScope(ctx: WasmCompileCtx, scope: ScopeId): void {
  if (!ctx.sinkAnalysis) return;
  const ids = ctx.sinkAnalysis.valuesByScope.get(scope);
  if (!ids || ids.length === 0) return;
  for (const nodeId of ids) {
    const node = ctx.nodeMap.get(nodeId);
    if (!node) continue;
    const t = node.data.nodeType;
    if (t === 'inputColor' || t === 'step' || t === 'outputMapping') continue;
    if (t === 'macro' || t === 'macroInput' || t === 'macroOutput') continue;
    const hasArrayEmitter = !!ARRAY_NODE_EMITTERS[t];
    const hasValueEmitter = !!VALUE_NODE_EMITTERS[t];
    // getVariable is registered in BOTH tables — dispatch picks at use time
    // based on the consumer's input port (scalar consumer → value emitter,
    // isArray consumer → array emitter). The pre-emit walk would otherwise
    // call both and the wrong one errors out. Skip both here and let
    // consumers trigger compile lazily via resolveInputArray / inputs.
    if (t === 'getVariable') continue;
    // Volatile values — any node transitively reading getVariable — depend
    // on per-cell mutable state that is updated by setVariable /
    // setArrayElement flow nodes mid-scope. Emitting them at scope entry
    // (which is what emitValuesForScope does) reads the variable's INITIAL
    // value, missing every subsequent mutation. Skip them here; consumer-
    // side input resolution will trigger compileValueNode lazily at the
    // use site, where the bytecode lands AFTER the mutating flow children
    // have run. Matches the JS compiler's volatile-emit mechanism.
    if (ctx.volatileValues.has(nodeId)) continue;
    // valueSwitch is dual-mode (now in BOTH emitter tables). It is a PURE value
    // (unlike getVariable), so emit it at its sink scope here — dominating all
    // uses — just like any other array producer; this avoids the cross-branch
    // hazard when it is read in multiple branches. Route to the single correct
    // emitter so it never hits both below. (A volatile valueSwitch reading
    // getVariable arrays was already skipped by the volatileValues check above.)
    if (t === 'valueSwitch') {
      if (ctx.producesArray(node)) compileArrayNode(nodeId, ctx);
      else compileValueNode(nodeId, ctx);
      continue;
    }
    if (hasValueEmitter) compileValueNode(nodeId, ctx);
    if (hasArrayEmitter) compileArrayNode(nodeId, ctx);
  }
}

// Note: the eager preEmitValueNodes pass was removed in favour of
// emitValuesForScope, which runs at each scope entry in compileFlowChain
// (and once for CELL_TOP at the top of emitBody). Per-scope emission cuts
// the per-cell instruction count on type-dispatch models (Wireworld etc.)
// because each cell only executes the value computations relevant to its
// branch.

function compileFlowChain(sourceNodeId: string, sourcePortId: string, ctx: WasmCompileCtx): boolean {
  const targets = ctx.flowOutputToTargets.get(`${sourceNodeId}:${sourcePortId}`) ?? [];
  for (const target of targets) {
    const node = ctx.nodeMap.get(target.nodeId);
    if (!node) continue;
    const def = getNodeDef(node.data.nodeType);
    if (!def) continue;

    // Volatile values whose LCA flow scope is here: emit them (set their
    // function-locals) BEFORE this flow node, so the assignment runs on every
    // branch path this node opens — not just the first case to reference it.
    // getVariable itself reads variable storage directly (no temp local) and is
    // dual-registered, so skip it; its derived consumers carry it along.
    const hoisted = ctx.volatileHoist.get(target.nodeId);
    if (hoisted) {
      for (const vId of hoisted) {
        const vn = ctx.nodeMap.get(vId);
        if (!vn || vn.data.nodeType === 'getVariable') continue;
        // valueSwitch is dual-registered — route by mode (an array-relay
        // instance reading getVariable arrays must hit the array emitter).
        if (vn.data.nodeType === 'valueSwitch') {
          if (ctx.producesArray(vn)) compileArrayNode(vId, ctx);
          else compileValueNode(vId, ctx);
          continue;
        }
        if (VALUE_NODE_EMITTERS[vn.data.nodeType]) compileValueNode(vId, ctx);
        else if (ARRAY_NODE_EMITTERS[vn.data.nodeType]) compileArrayNode(vId, ctx);
      }
    }

    if (node.data.nodeType === 'conditional') {
      const condSource = ctx.inputToSource.get(`${node.id}:condition`);
      let condRef: ValueRef | null = null;
      if (condSource) {
        condRef = compileValueNode(condSource.nodeId, ctx, condSource.portId);
        if (!condRef) return false;
      } else {
        const condPort = def.ports.find(p => p.id === 'condition');
        const inlineVal = condPort ? getInlineValue(condPort, node.data.config) : undefined;
        condRef = { inline: true, value: parseInlineNum(inlineVal, 0), valtype: I32 };
      }
      pushValueAs(ctx.emitter, condRef, I32);
      const hasElse = ctx.flowOutputToTargets.has(`${node.id}:else`);
      if (hasElse) {
        ctx.emitter.ifThenElse(
          () => {
            emitValuesForScope(ctx, `${node.id}:then`);
            compileFlowChain(node.id, 'then', ctx);
          },
          () => {
            emitValuesForScope(ctx, `${node.id}:else`);
            compileFlowChain(node.id, 'else', ctx);
          },
        );
      } else {
        ctx.emitter.ifThen(() => {
          emitValuesForScope(ctx, `${node.id}:then`);
          compileFlowChain(node.id, 'then', ctx);
        });
      }
    } else if (node.data.nodeType === 'sequence') {
      compileFlowChain(node.id, 'first', ctx);
      compileFlowChain(node.id, 'then', ctx);
      const extra = Number(node.data.config.extraCount) || 0;
      for (let si = 2; si < 2 + extra; si++) {
        compileFlowChain(node.id, `then_${si}`, ctx);
      }
    } else if (node.data.nodeType === 'loop') {
      // Loop: for (let _i = 0; _i < count; _i++) { body } — or, in RANGE mode,
      // for (let _i = from; _i <= to; _i++) (inclusive; from > to = zero runs).
      const isRange = node.data.config.mode === 'range';
      const resolveLoopI32 = (portId: string, dflt: number): ValueRef | null => {
        const src = ctx.inputToSource.get(`${node.id}:${portId}`);
        if (src) return compileValueNode(src.nodeId, ctx, src.portId);
        const port = def.ports.find(p => p.id === portId);
        const inlineVal = port ? getInlineValue(port, node.data.config) : undefined;
        return { inline: true, value: parseInlineNum(inlineVal, dflt), valtype: I32 };
      };
      // Resolve the bound/start refs BEFORE allocating li/lc — a lazily-compiled
      // source allocates its own locals during resolution, and the historical
      // (byte-identity-relevant) order is source locals first, then li/lc.
      const boundRef = resolveLoopI32(isRange ? 'to' : 'count', isRange ? 0 : 1);
      if (!boundRef) return false;
      const fromRef = isRange ? resolveLoopI32('from', 0) : null;
      if (isRange && !fromRef) return false;
      // Loop counter local + bound local. Count mode: li = 0, lc = count, exit
      // on li >= lc. Range mode: li = from, lc = to, exit on li > lc.
      const li = ctx.emitter.allocLocal(I32);
      const lc = ctx.emitter.allocLocal(I32);
      pushValueAs(ctx.emitter, boundRef, I32);
      ctx.emitter.localSet(lc);
      if (isRange) pushValueAs(ctx.emitter, fromRef!, I32);
      else ctx.emitter.i32Const(0);
      ctx.emitter.localSet(li);
      ctx.emitter.block(() => {
        ctx.emitter.loop(() => {
          // count: if (li >= lc) br block — range: if (li > lc) br block
          ctx.emitter.localGet(li);
          ctx.emitter.localGet(lc);
          ctx.emitter.op(isRange ? OP_I32_GT_S : OP_I32_GE_S);
          ctx.emitter.brIf(1);
          // Cache the iteration counter on the `index` output port so body-side
          // consumers resolve it via the standard valueLocals path (mirrors
          // forEachInArray's index). sinkAnalysis pins index-dependents at the
          // loopBody scope, so their emit below sees the cached local.
          setCachedPort(ctx, node.id, 'index', { localIdx: li, valtype: I32 });
          // body
          emitValuesForScope(ctx, `${node.id}:body`);
          compileFlowChain(node.id, 'body', ctx);
          // li++; br loop
          ctx.emitter.localGet(li);
          ctx.emitter.i32Const(1);
          ctx.emitter.op(OP_I32_ADD);
          ctx.emitter.localSet(li);
          ctx.emitter.br(0);
        });
      });
    } else if (node.data.nodeType === 'forEachInArray') {
      // Iterate over a typed-array source, exposing the per-iteration element
      // via the node's `element` output port (cached as a LocalRef in
      // valueLocals so body action-node input resolution finds it).
      //
      // Body value-emit scoping: WASM locals are function-scope (not
      // block-scope), so we don't need to recompute element-dependent value
      // nodes in a separate cache. Each value node's local-set bytecode is
      // emitted inside the loop block once at compile time, runs each
      // iteration with the current element. The pre-emit pass deliberately
      // does NOT recurse into forEachInArray bodies (no `case` in visitFlow's
      // switch) — body value sources emit inline here instead.
      const arrSource = ctx.inputToSource.get(`${node.id}:array`);
      if (!arrSource) continue; // empty body, skip
      const arrRef = resolveInputArray(ctx, node, 'array');
      if (!arrRef) {
        ctx.errors.push(`forEachInArray: input "array" must come from an array-producing node (filterNeighbors / getNeighborIndexesByTags / joinNeighbors / getNeighborsAttrByIndexes / groupCounting.indexes)`);
        return false;
      }
      const fi = ctx.emitter.allocLocal(I32);
      const elemLocal = ctx.emitter.allocLocal(arrRef.elemValtype);
      ctx.emitter.i32Const(0);
      ctx.emitter.localSet(fi);
      ctx.emitter.block(() => {
        ctx.emitter.loop(() => {
          // if (fi >= arr.len) br block
          ctx.emitter.localGet(fi);
          ctx.emitter.localGet(arrRef.lenLocal);
          ctx.emitter.op(OP_I32_GE_S);
          ctx.emitter.brIf(1);
          // element = arr[fi]
          ctx.emitter.localGet(fi);
          emitArrayLoadElem(ctx.emitter, arrRef);
          ctx.emitter.localSet(elemLocal);
          // Cache element on the node's `element` port so body action-node
          // input resolution finds it via the standard valueLocals path.
          setCachedPort(ctx, node.id, 'element', { localIdx: elemLocal, valtype: arrRef.elemValtype });
          // Cache the iteration counter on the `index` port — body-side nodes
          // that index parallel arrays by slot read this instead of `element`.
          setCachedPort(ctx, node.id, 'index', { localIdx: fi, valtype: I32 });
          // Body
          emitValuesForScope(ctx, `${node.id}:body`);
          compileFlowChain(node.id, 'body', ctx);
          // fi++; br loop
          ctx.emitter.localGet(fi);
          ctx.emitter.i32Const(1);
          ctx.emitter.op(OP_I32_ADD);
          ctx.emitter.localSet(fi);
          ctx.emitter.br(0);
        });
      });
    } else if (node.data.nodeType === 'switch') {
      // Switch: build per-case condition expressions, then if-else-if chain
      // (firstMatchOnly=true) or independent ifs (firstMatchOnly=false).
      const mode = (node.data.config.mode as string) || 'conditions';
      const firstMatchOnly = node.data.config.firstMatchOnly !== false;
      const valType = (node.data.config.valueType as string) || 'integer';
      const caseCount = Number(node.data.config.caseCount) || 0;
      const hasDefault = ctx.flowOutputToTargets.has(`${node.id}:default`);

      if (caseCount === 0) {
        compileFlowChain(node.id, 'default', ctx);
        // `continue` skips the shared end-of-loop continuation — run it here.
        if (!compileFlowChain(node.id, 'next', ctx)) return false;
        continue;
      }

      // For 'value' mode, resolve the switch value once
      let valueRef: ValueRef | null = null;
      if (mode === 'value') {
        const valSource = ctx.inputToSource.get(`${node.id}:value`);
        if (valSource) {
          const r = compileValueNode(valSource.nodeId, ctx, valSource.portId);
          if (!r) return false;
          valueRef = r;
        } else {
          const port = def.ports.find(p => p.id === 'value');
          const inlineVal = port ? getInlineValue(port, node.data.config) : undefined;
          valueRef = { inline: true, value: parseInlineNum(inlineVal, 0), valtype: valType === 'float' ? F64 : I32 };
        }
      }

      // Resolve each case condition into a value
      const caseConds: ValueRef[] = [];
      for (let ci = 0; ci < caseCount; ci++) {
        if (mode === 'conditions') {
          // Read bool input on case_{ci}_cond
          const condSrc = ctx.inputToSource.get(`${node.id}:case_${ci}_cond`);
          if (condSrc) {
            const r = compileValueNode(condSrc.nodeId, ctx, condSrc.portId);
            if (!r) return false;
            caseConds.push(r);
          } else {
            const inlineRaw = node.data.config[`_port_case_${ci}_cond`];
            const v = inlineRaw === 'true' ? 1 : 0;
            caseConds.push({ inline: true, value: v, valtype: I32 });
          }
        } else {
          // 'value' mode: compare valueRef against case_{ci}_value (or case_{ci}_val source)
          const caseValSrc = ctx.inputToSource.get(`${node.id}:case_${ci}_val`);
          let caseValRef: ValueRef;
          if (caseValSrc) {
            const r = compileValueNode(caseValSrc.nodeId, ctx, caseValSrc.portId);
            if (!r) return false;
            caseValRef = r;
          } else {
            const raw = node.data.config[`_port_case_${ci}_val`] ?? node.data.config[`case_${ci}_value`] ?? 0;
            const num = parseFloat(String(raw));
            caseValRef = { inline: true, value: Number.isFinite(num) ? num : 0, valtype: valType === 'float' ? F64 : I32 };
          }
          // Allocate a result local for this comparison
          const resLocal = ctx.emitter.allocLocal(I32);
          if (valType === 'tag' || valType === 'integer') {
            pushValueAs(ctx.emitter, valueRef!, I32);
            pushValueAs(ctx.emitter, caseValRef, I32);
            const cmpOp = (node.data.config[`case_${ci}_op`] as string) || '==';
            ctx.emitter.op(cmpToI32Op(cmpOp));
          } else {
            pushValueAs(ctx.emitter, valueRef!, F64);
            pushValueAs(ctx.emitter, caseValRef, F64);
            const cmpOp = (node.data.config[`case_${ci}_op`] as string) || '==';
            ctx.emitter.op(cmpToF64Op(cmpOp));
          }
          ctx.emitter.localSet(resLocal);
          caseConds.push({ localIdx: resLocal, valtype: I32 });
        }
      }

      if (firstMatchOnly) {
        // Build nested if/else-if. Each case opens an `if`, the else of the
        // previous case wraps the next.
        const open = (ci: number): boolean => {
          if (ci >= caseCount) {
            if (hasDefault) {
              emitValuesForScope(ctx, `${node.id}:default`);
              return compileFlowChain(node.id, 'default', ctx);
            }
            return true;
          }
          pushValueAs(ctx.emitter, caseConds[ci]!, I32);
          ctx.emitter.ifThenElse(
            () => {
              emitValuesForScope(ctx, `${node.id}:case_${ci}`);
              compileFlowChain(node.id, `case_${ci}`, ctx);
            },
            () => { open(ci + 1); },
          );
          return true;
        };
        open(0);
      } else {
        // Independent if blocks; if no case matched, run default.
        // Track "any matched" via a flag local.
        const matched = ctx.emitter.allocLocal(I32);
        ctx.emitter.i32Const(0);
        ctx.emitter.localSet(matched);
        for (let ci = 0; ci < caseCount; ci++) {
          pushValueAs(ctx.emitter, caseConds[ci]!, I32);
          ctx.emitter.ifThen(() => {
            ctx.emitter.i32Const(1);
            ctx.emitter.localSet(matched);
            emitValuesForScope(ctx, `${node.id}:case_${ci}`);
            compileFlowChain(node.id, `case_${ci}`, ctx);
          });
        }
        if (hasDefault) {
          ctx.emitter.localGet(matched);
          ctx.emitter.op(OP_I32_EQZ);
          ctx.emitter.ifThen(() => {
            emitValuesForScope(ctx, `${node.id}:default`);
            compileFlowChain(node.id, 'default', ctx);
          });
        }
      }
    } else {
      // Regular flow node: resolve scalar value inputs (skip arrays; flow
      // emitters that consume arrays — setNeighborAttributeByIndex with array
      // index input — fetch the ArrayRef themselves via compileArrayNode).
      //
      // Skip array-producer sources too: e.g. pickNRandomNeighbors output
      // (an NI[]) wired to setNeighborAttributeByIndex.index (a scalar NI
      // port). The connection is type-permitted (NI[] → NI is the implicit
      // "iterate the array" semantic), but trying to compileValueNode an
      // array producer hits the "No value emitter" error. Let the FLOW_NODE_
      // EMITTER fetch the source via compileArrayNode itself.
      const inputs: Record<string, ValueRef | undefined> = {};
      for (const port of def.ports) {
        if (port.kind !== 'input' || port.category !== 'value') continue;
        if (port.isArray) continue;
        const source = ctx.inputToSource.get(`${node.id}:${port.id}`);
        if (source) {
          // Skip when the source PORT is an array (consumer handles it).
          // Mirror the top-level compileValueNode fix — hybrid producers
          // like groupCounting have both array and scalar outputs; checking
          // isArrayProducer(nodeType) would drop scalar count consumers.
          const srcNode = ctx.nodeMap.get(source.nodeId);
          const srcDef = srcNode ? getNodeDef(srcNode.data.nodeType) : null;
          const srcPort = srcDef?.ports.find(p => p.id === source.portId);
          if (srcPort?.isArray) continue;
          const srcRef = compileValueNode(source.nodeId, ctx, source.portId);
          if (!srcRef) return false;
          inputs[port.id] = srcRef;
        } else {
          const inlineVal = getInlineValue(port, node.data.config);
          if (inlineVal !== undefined) {
            const num = parseInlineNum(inlineVal);
            // Same rationale as the value-emitter input resolver: `any` ports
            // (e.g., setAttribute's `value`) accept fractional inline values
            // — storing as I32 would truncate via `n | 0` before the consumer
            // ever sees the fraction.
            const isFloat = port.dataType === 'float' || port.dataType === 'any';
            inputs[port.id] = { inline: true, value: num, valtype: isFloat ? F64 : I32 };
          }
        }
      }
      // Dynamic per-slot value-input ports (not declared in def.ports) —
      // pick them up from the edge map (defensive; covers any such flow node).
      for (const [key, source] of ctx.inputToSource) {
        if (!key.startsWith(`${node.id}:`)) continue;
        const portId = key.slice(node.id.length + 1);
        if (def.ports.some(p => p.kind === 'input' && p.category === 'value' && p.id === portId)) continue;
        const srcNode = ctx.nodeMap.get(source.nodeId);
        const srcDef = srcNode ? getNodeDef(srcNode.data.nodeType) : null;
        const srcPort = srcDef?.ports.find(p => p.id === source.portId);
        if (srcPort?.isArray) continue;
        const srcRef = compileValueNode(source.nodeId, ctx, source.portId);
        if (!srcRef) return false;
        inputs[portId] = srcRef;
      }
      const flowEmitter = FLOW_NODE_EMITTERS[node.data.nodeType];
      if (!flowEmitter) {
        ctx.errors.push(`No WASM flow emitter for "${node.data.nodeType}"`);
        return false;
      }
      const ok = flowEmitter({ ctx, node, inputs });
      if (!ok) return false;
    }

    // Pass-through continuation (`next` — NEXT on action nodes, DONE on
    // control nodes): bytecode emitted here lands right after the node's own
    // emission / after its closed control block, which IS the correct
    // execution position in WASM's structured control flow. No-op when
    // nothing is wired.
    if (!compileFlowChain(node.id, 'next', ctx)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Per-entry-point compile helpers
// ---------------------------------------------------------------------------

interface EntryPointOpts {
  /** Entry node (Step / InputColor / OutputMapping) */
  entry: GraphNode;
  /** Number of i32 params (1 for step/outputMapping = total; 4 for inputColor = idx,r,g,b) */
  numParams: number;
  /** What's in each param slot (param index 0..numParams-1).
   *  For inputColor we need: 0 = idx, 1 = r, 2 = g, 3 = b. */
  iLocalSource: 'param0' | 'param0WithLoop';
  /** True if this entry runs the per-cell loop over `total` (param 0). */
  hasLoop: boolean;
  /** True if copy lines should be emitted at the top of each cell iteration. */
  emitCopyLines: boolean;
  /** True if async mode should use orderArray-driven iteration. Step does;
   *  OutputMapping does NOT (runs sequentially regardless of update mode,
   *  matching JS compiler behaviour). */
  useOrderArrayInAsync: boolean;
  /** For InputColor: maps the entry node's r/g/b output ports to param indices 1, 2, 3. */
  paramOutputs?: Record<string, number>;
  /** "Skip Isolated Empty Cells": emit the sparse loop variant. The entry gains
   *  a 2nd i32 param `activeCount` — `>= 0` iterates the active-list region
   *  (`layout.activeListOffset`), `< 0` (the worker's -1 sentinel) runs the
   *  classic full 0..total loop. Mirrors the JS step's `if (_activeList)`.
   *  Only set on loop entries (step / outputMapping), never init/inputColor. */
  sparse?: boolean;
}

function compileEntry(
  opts: EntryPointOpts,
  layout: MemoryLayout,
  viewerIds: Record<string, number>,
  model: CAModel,
  nodeMap: Map<string, GraphNode>,
  inputToSource: Map<string, { nodeId: string; portId: string }>,
  inputToSources: Map<string, Array<{ nodeId: string; portId: string }>>,
  flowOutputToTargets: Map<string, Array<{ nodeId: string; portId: string }>>,
  loopInvariant: Set<string>,
  sinkAnalysis: SinkAnalysisResult,
): { body: Uint8Array; errors: string[] } {
  const emitter = new WasmEmitter(opts.numParams);

  let outerCounter = -1;
  let iLocal = -1;
  if (opts.hasLoop) {
    outerCounter = emitter.allocLocal(I32);
    iLocal = emitter.allocLocal(I32);
  } else {
    iLocal = 0; // param 0 = idx
  }

  // Scratch-top local. Initial value is set at the top of each cell iteration
  // (or at the function start, for non-loop entries).
  const scratchTopLocal = emitter.allocLocal(I32);

  // Wave A.6: per-cell row / col, decoded from idx once per iteration. Used by
  // NI access emitters (filterNeighbors etc.) to compute neighbor cell indices
  // inline from packed (dr, dc) NIs. W is the grid width — baked as a compile-
  // time constant in the emit.
  const rowLocal = emitter.allocLocal(I32);
  const colLocal = emitter.allocLocal(I32);
  // 3D Grid CA: layer (z) + remainder locals, allocated ONLY for a 3D model so a
  // 2D module's local count (and therefore its bytes) is byte-identical. is3dEntry
  // mirrors the JS `is3dModel` predicate (dimension 3d && gridDepth > 1).
  const is3dEntry = model.properties.dimension === '3d' && (model.properties.gridDepth ?? 1) > 1;
  const layerLocal = is3dEntry ? emitter.allocLocal(I32) : -1;
  const remLocal = is3dEntry ? emitter.allocLocal(I32) : -1;

  // paramRefs: register InputColor's r/g/b outputs as param-backed locals.
  // These are ALWAYS i32 in the param signature.
  const paramRefs = new Map<string, Map<string, LocalRef>>();
  if (opts.paramOutputs) {
    const m = new Map<string, LocalRef>();
    for (const [portId, paramIdx] of Object.entries(opts.paramOutputs)) {
      m.set(portId, { localIdx: paramIdx, valtype: I32 });
    }
    paramRefs.set(opts.entry.id, m);
  }

  // Async read-after-write hazard reads (step / initEvent roots only): seed them
  // into the volatile set so an attribute/orientation read used after a write to
  // the same attribute is pinned at its use site instead of hoisted. Empty for
  // sync mode and for inputColor/outputMapping entries → byte-identical there.
  const wasmHazardEligible = layout.isAsync
    && (opts.entry.data.nodeType === 'step' || opts.entry.data.nodeType === 'initEvent');
  const wasmHazardReads = computeAsyncReadWriteHazards({
    nodeMap, inputToSource, inputToSources, flowOutputToTargets,
    rootNodeId: opts.entry.id, rootFlowPortId: 'do', isAsync: wasmHazardEligible,
  });
  const volatileValuesSet = computeVolatileValueClosureWasm(Array.from(nodeMap.values()), inputToSource, inputToSources, wasmHazardReads);

  const ctx: WasmCompileCtx = {
    emitter,
    layout,
    viewerIds,
    model,
    iLocalIdx: iLocal,
    rowLocalIdx: rowLocal,
    colLocalIdx: colLocal,
    layerLocalIdx: layerLocal,
    valueLocals: new Map(),
    arrayRefs: new Map(),
    byteOffsetLocals: new Map(),
    nodeMap,
    inputToSource,
    inputToSources,
    flowOutputToTargets,
    producesArray: makeProducesArray({ isArrayProducer, inputToSource, nodeMap }),
    // "Skip Isolated Empty Cells": the layout carries the mode — nbr regions
    // hold compact packed offsets, table-read sites branch to pushInlineNbrCellIdx.
    inlineNbr: layout.sparseStepping,
    errors: [],
    scratchTopLocal,
    paramRefs,
    loopInvariant,
    viewerLocals: new Map(),
    sinkAnalysis,
    variableLocals: new Map(),
    volatileValues: volatileValuesSet,
    volatileHoist: computeVolatileHoist({
      nodeMap,
      inputToSource,
      inputToSources,
      flowOutputToTargets,
      rootNodeId: opts.entry.id,
      rootFlowPortId: 'do',
      volatile: volatileValuesSet,
    }).emitBefore,
  };

  // Snapshot of value-local refs that are loop-invariant. Populated after the
  // pre-loop emission pass. Per-cell emitBody clears valueLocals (cell-dependent
  // refs would be stale) then restores these so subsequent compileValueNode
  // calls hit the cache and skip re-emission.
  const invariantSnapshot = new Map<string, Map<string, LocalRef>>();

  const W = model.properties.gridWidth;
  // 3D Grid CA: WH precomputed for the per-cell layer/row/col decode (only used
  // when is3dEntry). 2D models never reference these.
  const WH3d = W * model.properties.gridHeight;
  // Collect every distinct attribute itemBytes value (1=bool, 4=int/tag, 8=float)
  // that appears in the cell-attr layout. Used by `initByteOffsetLocals` to
  // pre-emit `idx * itemBytes` cache locals at cell-top — see the comment on
  // pushCellByteOffset for why this matters under value sinking.
  const cellAttrItemBytes = new Set<number>();
  for (const id of Object.keys(layout.attrType)) {
    const a = getAttr(layout, id);
    if (a) cellAttrItemBytes.add(a.itemBytes);
  }

  // Per-cell scratch base: starts at layout.scratchOffset, BUT loop-invariant
  // value emits (emitInvariantValueNodes, below) bump scratchTop past whatever
  // they allocate. After that pass we snapshot scratchTop into this local so
  // per-cell scratch resets to the post-invariant top instead of clobbering
  // the loop-invariant arrays (e.g. the niArr returned by getAllNeighborIndexes
  // hoisted as loop-invariant — without the snapshot, per-cell scratch starts
  // at scratchOffset and overwrites the invariant data on the very first cell
  // iteration). Allocated upfront so emitBody can reference it via closure;
  // the actual value gets stored after invariant emission completes.
  const perCellScratchBase = emitter.allocLocal(I32);

  // Local Variables — allocate function-locals for each variable in
  // model.variables, register in ctx.variableLocals. Scalar variables get
  // a single function-local for the value. Array variables get a
  // function-local for the storage OFFSET; the storage itself is allocated
  // from per-cell scratch at cell-top by emitVariableReset (the offset
  // local is re-assigned each cell but stays stable within the cell's
  // emit, so reads/writes via that offset address the current cell's slot).
  const emitVariableStorage = () => {
    for (const v of model.variables || []) {
      const valtype: ValType = v.dataType === 'float' ? F64 : I32;
      const elemBytes = v.dataType === 'float' ? 8 : v.dataType === 'bool' ? 1 : 4;
      const initLit = variableInitLiteralWasm(v);
      if (v.kind === 'scalar') {
        const localIdx = emitter.allocLocal(valtype);
        ctx.variableLocals.set(v.id, {
          kind: 'scalar', localIdx, valtype, initLiteral: initLit,
        });
      } else {
        const length = Math.max(1, Number(v.length) | 0) || 1;
        const offsetLocal = emitter.allocLocal(I32);
        ctx.variableLocals.set(v.id, {
          kind: 'array', offsetLocal, length, elemBytes,
          elemValtype: valtype, initLiteral: initLit,
        });
      }
    }
  };

  // Per-cell reset. Scalars: re-assign to initLiteral. Arrays: allocate
  // fresh scratch (advances scratchTopLocal), capture the new offset in
  // the variable's offsetLocal, then write initLiteral to all N slots.
  // Runs at cell-top, right after scratchTopLocal is reset to
  // perCellScratchBase — so each cell starts with a clean variable state.
  const emitVariableReset = () => {
    for (const [, slot] of ctx.variableLocals) {
      if (slot.kind === 'scalar') {
        if (slot.valtype === F64) emitter.f64Const(slot.initLiteral);
        else emitter.i32Const(slot.initLiteral | 0);
        emitter.localSet(slot.localIdx);
      } else {
        // offsetLocal := scratchTop; scratchTop += length * elemBytes
        emitter.localGet(scratchTopLocal);
        emitter.localSet(slot.offsetLocal);
        emitter.localGet(scratchTopLocal);
        emitter.i32Const(slot.length * slot.elemBytes);
        emitter.op(OP_I32_ADD);
        emitter.localSet(scratchTopLocal);
        // Fill: for (i = 0; i < length; i++) mem[offset + i*elemBytes] = init
        // Unrolled for small N (typical chemistry: N=4). For larger arrays
        // we'd want a loop, but a brief unroll keeps the bytecode trivial.
        for (let i = 0; i < slot.length; i++) {
          emitter.localGet(slot.offsetLocal);
          if (i > 0) {
            emitter.i32Const(i * slot.elemBytes);
            emitter.op(OP_I32_ADD);
          }
          if (slot.elemValtype === F64) {
            emitter.f64Const(slot.initLiteral);
            emitter.f64Store(0, 3);
          } else if (slot.elemBytes === 1) {
            emitter.i32Const(slot.initLiteral | 0);
            emitter.i32Store8(0, 0);
          } else {
            emitter.i32Const(slot.initLiteral | 0);
            emitter.i32Store(0, 2);
          }
        }
      }
    }
  };

  const emitBody = () => {
    // Reset per-cell caches and scratch pointer
    ctx.byteOffsetLocals.clear();
    ctx.valueLocals.clear();
    ctx.arrayRefs.clear();
    emitter.localGet(perCellScratchBase);
    emitter.localSet(scratchTopLocal);
    // Pre-initialise the cached `idx * itemBytes` locals for every itemBytes
    // the model uses. Must run BEFORE any value emission so cell-body code
    // that consumes a cached offset always reads a freshly-computed local —
    // even when the consumer landed inside a conditional branch via value
    // sinking and a sibling branch never executed the localTee.
    initByteOffsetLocals(ctx, cellAttrItemBytes);

    // Wave A.6: compute row/col from idx once per cell. Used by NI access
    // emitters to decode packed (dr, dc) NIs into cell indices inline.
    //   2D: row = idx / W; col = idx - row * W;
    // 3D Grid CA: layer = idx / WH; rem = idx - layer*WH; row = rem / W;
    //   col = rem - row*W. Gated on is3dEntry so 2D bytes are byte-identical.
    if (is3dEntry) {
      // layer = idx / WH
      emitter.localGet(iLocal);
      emitter.i32Const(WH3d);
      emitter.op(OP_I32_DIV_S);
      emitter.localSet(layerLocal);
      // rem = idx - layer*WH
      emitter.localGet(iLocal);
      emitter.localGet(layerLocal);
      emitter.i32Const(WH3d);
      emitter.op(OP_I32_MUL);
      emitter.op(OP_I32_SUB);
      emitter.localSet(remLocal);
      // row = rem / W
      emitter.localGet(remLocal);
      emitter.i32Const(W);
      emitter.op(OP_I32_DIV_S);
      emitter.localSet(rowLocal);
      // col = rem - row*W
      emitter.localGet(remLocal);
      emitter.localGet(rowLocal);
      emitter.i32Const(W);
      emitter.op(OP_I32_MUL);
      emitter.op(OP_I32_SUB);
      emitter.localSet(colLocal);
    } else {
      emitter.localGet(iLocal);
      emitter.i32Const(W);
      emitter.op(OP_I32_DIV_S);
      emitter.localSet(rowLocal);
      emitter.localGet(iLocal);
      emitter.localGet(rowLocal);
      emitter.i32Const(W);
      emitter.op(OP_I32_MUL);
      emitter.op(OP_I32_SUB);
      emitter.localSet(colLocal);
    }

    // Re-register paramRefs after the cache clear (they're stable across cells).
    if (opts.paramOutputs) {
      const m = new Map<string, LocalRef>();
      for (const [portId, paramIdx] of Object.entries(opts.paramOutputs)) {
        m.set(portId, { localIdx: paramIdx, valtype: I32 });
      }
      ctx.paramRefs.set(opts.entry.id, m);
    }

    // Restore loop-invariant cache so consumers in this cell iteration hit the
    // pre-loop-emitted locals instead of triggering fresh emission.
    for (const [nodeId, ports] of invariantSnapshot) {
      let m = ctx.valueLocals.get(nodeId);
      if (!m) { m = new Map(); ctx.valueLocals.set(nodeId, m); }
      for (const [pid, ref] of ports) m.set(pid, ref);
    }

    // Per-cell copy (sync mode only). Two flavours:
    //   1. Regular attrs in single-shot entries (InputColor): emit `w = r` here.
    //      Loop entries (Step) use the bulk memory.copy path instead.
    //   2. Sub-attributes (any entry kind): emit conditional copy here. The
    //      bulk-copy path SKIPS sub-attrs, so we do per-cell `w = match ? r : default`
    //      for ALL entries that emitCopyLines.
    if (opts.emitCopyLines && !layout.isAsync) {
      for (const id of Object.keys(layout.attrType)) {
        const a = getAttr(layout, id)!;
        const sub = getSubAttrWasm(ctx, id);
        if (sub) {
          // Sub-attribute conditional copy: w[idx] = parent_match ? r[idx] : defaultValue
          const attr = model.attributes.find(at => at.id === id)!;
          pushCellByteOffset(ctx, a.itemBytes);  // store address
          // Push matched-case value (r_subattr[idx])
          pushCellByteOffset(ctx, a.itemBytes);
          if (a.type === 'bool') emitter.i32Load8U(a.readOffset, 0);
          else if (a.type === 'float') emitter.f64Load(a.readOffset, 3);
          else emitter.i32Load(a.readOffset, 2);
          // Push default literal
          emitAttrLiteralWasm(ctx, a, attr.defaultValue || '');
          // Push parent_match condition (reads from r_ buffer)
          emitParentMatchAtCellWasm(ctx, sub.parent, sub.parentValuesInt, false);
          emitter.op(OP_SELECT);
          // Store result
          if (a.type === 'bool') emitter.i32Store8(a.writeOffset, 0);
          else if (a.type === 'float') emitter.f64Store(a.writeOffset, 3);
          else emitter.i32Store(a.writeOffset, 2);
        } else if (!opts.hasLoop) {
          // Regular attr, single-shot entry: per-cell `w = r` copy
          pushCellByteOffset(ctx, a.itemBytes);  // store address
          pushCellByteOffset(ctx, a.itemBytes);  // load address
          if (a.type === 'bool') {
            emitter.i32Load8U(a.readOffset, 0);
            emitter.i32Store8(a.writeOffset, 0);
          } else if (a.type === 'float') {
            emitter.f64Load(a.readOffset, 3);
            emitter.f64Store(a.writeOffset, 3);
          } else {
            emitter.i32Load(a.readOffset, 2);
            emitter.i32Store(a.writeOffset, 2);
          }
        }
        // Regular attr in loop entry: handled by emitBulkCopyLines (bulk memcpy).
      }
    }

    // Reset Local Variables to their initial values + allocate fresh
    // per-cell scratch for arrays. Must run BEFORE the cell's value/flow
    // emissions so the user-visible "initial state" of each variable is
    // initialValue at the start of every cell.
    emitVariableReset();

    // Emit values whose LCA is CELL_TOP. Deeper-scoped values land at branch
    // entry in compileFlowChain. Loop-invariant values already cached via
    // invariantSnapshot are no-ops here (memoised by valueLocals).
    emitValuesForScope(ctx, CELL_TOP);
    compileFlowChain(opts.entry.id, 'do', ctx);
  };

  // Bulk r→w copy for loop entries in sync mode. Replaces N per-cell load/store
  // pairs with one memory.copy per attr (engine-level memcpy, often SIMD).
  // Cellrules then overwrite specific bytes inside the loop; untouched cells
  // retain the prior generation's value, matching the previous semantics exactly.
  // The constant-boundary sentinel cell (at index `total`) is preserved because
  // we copy `cellsPerAttr` elements including the sentinel slot.
  const cellsPerAttr = layout.sentinelIndex >= 0 ? layout.total + 1 : layout.total;
  const emitBulkCopyLines = () => {
    for (const id of Object.keys(layout.attrType)) {
      // Sub-attributes get per-cell conditional copy in emitBody — the bulk
      // memcpy can't express the parent-check guard, so we skip it here.
      // EXCEPT in sparse mode ("Skip Isolated Empty Cells"): the per-cell copy
      // only runs for ACTIVE cells, so sub-attrs MUST also bulk-copy or an
      // inactive cell's w-buffer holds two-generations-old data after the
      // swap. Active cells' conditional copy overwrites on top (identical
      // result); inactive carry-forward is invisible behind the parent guard.
      // Mirrors the JS compiler's `sparseBulk` gate.
      if (!layout.sparseStepping && getSubAttrWasm(ctx, id)) continue;
      const a = getAttr(layout, id)!;
      // memory.copy stack signature: [dst, src, n]
      emitter.i32Const(a.writeOffset);
      emitter.i32Const(a.readOffset);
      emitter.i32Const(cellsPerAttr * a.itemBytes);
      emitter.memoryCopy();
    }
    // Variegated Cells: orientation has the same sync-mode discipline — bulk
    // memcpy r→w so SetOrientation writes overlay on a fresh copy of the read
    // buffer. Skipped in async mode (r/w share one buffer). Matches the JS
    // compiler's `w_orientation.set(r_orientation)` bulk-copy line.
    if (layout.variegatedEnabled) {
      emitter.i32Const(layout.orientationWriteOffset);
      emitter.i32Const(layout.orientationReadOffset);
      emitter.i32Const(layout.orientationBytes);
      emitter.memoryCopy();
    }
  };

  // Hoist loop-invariant value nodes to a single emission BEFORE the cell
  // loop. Their LocalRefs are snapshotted into invariantSnapshot so per-cell
  // emitBody can re-populate valueLocals after the cache clear. For non-loop
  // entries (InputColor) this is a no-op since `emitBody` runs once anyway.
  const emitInvariantValueNodes = () => {
    const visited = new Set<string>();
    const visitValue = (nodeId: string) => {
      if (visited.has(nodeId)) return;
      visited.add(nodeId);
      const node = ctx.nodeMap.get(nodeId);
      if (!node) return;
      if (loopInvariant.has(nodeId)) {
        const t = node.data.nodeType;
        if (VALUE_NODE_EMITTERS[t]) compileValueNode(nodeId, ctx);
      } else {
        const def = getNodeDef(node.data.nodeType);
        if (!def) return;
        for (const port of def.ports) {
          if (port.kind !== 'input' || port.category !== 'value') continue;
          if (port.isArray) continue;
          const src = ctx.inputToSource.get(`${nodeId}:${port.id}`);
          if (src) visitValue(src.nodeId);
          const srcs = ctx.inputToSources.get(`${nodeId}:${port.id}`);
          if (srcs) for (const s of srcs) visitValue(s.nodeId);
        }
      }
    };
    const visitFlow = (srcId: string, portId: string, seen: Set<string>) => {
      const targets = ctx.flowOutputToTargets.get(`${srcId}:${portId}`) ?? [];
      for (const t of targets) {
        const node = ctx.nodeMap.get(t.nodeId);
        if (!node) continue;
        const def = getNodeDef(node.data.nodeType);
        if (!def) continue;
        for (const port of def.ports) {
          if (port.kind !== 'input' || port.category !== 'value') continue;
          if (port.isArray) continue;
          const src = ctx.inputToSource.get(`${t.nodeId}:${port.id}`);
          if (src) visitValue(src.nodeId);
          const srcs = ctx.inputToSources.get(`${t.nodeId}:${port.id}`);
          if (srcs) for (const s of srcs) visitValue(s.nodeId);
        }
        const flowKey = `${t.nodeId}:`;
        if (seen.has(flowKey)) continue;
        seen.add(flowKey);
        switch (node.data.nodeType) {
          case 'conditional':
            visitFlow(t.nodeId, 'then', seen);
            visitFlow(t.nodeId, 'else', seen);
            break;
          case 'sequence': {
            visitFlow(t.nodeId, 'first', seen);
            visitFlow(t.nodeId, 'then', seen);
            const extra = Number(node.data.config.extraCount) || 0;
            for (let si = 2; si < 2 + extra; si++) {
              visitFlow(t.nodeId, `then_${si}`, seen);
            }
            break;
          }
          case 'loop':
            visitFlow(t.nodeId, 'body', seen);
            break;
          case 'switch': {
            const caseCount = Number(node.data.config.caseCount) || 0;
            for (let ci = 0; ci < caseCount; ci++) {
              visitFlow(t.nodeId, `case_${ci}`, seen);
              const caseValSrc = ctx.inputToSource.get(`${t.nodeId}:case_${ci}_val`);
              if (caseValSrc) visitValue(caseValSrc.nodeId);
              const caseCondSrc = ctx.inputToSource.get(`${t.nodeId}:case_${ci}_cond`);
              if (caseCondSrc) visitValue(caseCondSrc.nodeId);
            }
            visitFlow(t.nodeId, 'default', seen);
            const valSrc = ctx.inputToSource.get(`${t.nodeId}:value`);
            if (valSrc) visitValue(valSrc.nodeId);
            break;
          }
        }
        // Pass-through continuation (`next`): its chain's loop-invariant value
        // inputs hoist exactly like sibling targets'.
        visitFlow(t.nodeId, 'next', seen);
      }
    };
    visitFlow(opts.entry.id, 'do', new Set());

    // Snapshot every invariant entry currently in valueLocals so per-cell
    // emitBody can restore them after its cache clear.
    for (const [nodeId, ports] of ctx.valueLocals) {
      if (!loopInvariant.has(nodeId)) continue;
      const m = new Map<string, LocalRef>();
      for (const [pid, ref] of ports) m.set(pid, ref);
      invariantSnapshot.set(nodeId, m);
    }
  };

  // Per-step hoist of activeViewer comparisons. Each attribute-to-color
  // mapping gets one i32 local holding (activeViewer == viewerInt). SetColorViewer's
  // emitter reads the cached local instead of re-loading + re-comparing per cell.
  // Mirrors the JS compiler's `_isV_<safeId(mappingId)>` constants.
  const emitViewerHoist = () => {
    for (const [mappingId, viewerInt] of Object.entries(viewerIds)) {
      const local = emitter.allocLocal(I32);
      emitter.i32Const(0);
      emitter.i32Load(layout.activeViewerOffset, 2);
      emitter.i32Const(viewerInt);
      emitter.op(OP_I32_EQ);
      emitter.localSet(local);
      ctx.viewerLocals.set(mappingId, local);
    }
  };

  // Allocate Local Variable function-locals upfront, BEFORE any code emits.
  // The locals are referenced in emitBody (per-cell reset) and in
  // VALUE_NODE_EMITTERS['getVariable'] / FLOW_NODE_EMITTERS['setVariable']
  // / ['setArrayElement']. Storage is populated per-cell by emitVariableReset
  // (called inside emitBody).
  emitVariableStorage();

  if (opts.hasLoop) {
    if (opts.emitCopyLines && !layout.isAsync) {
      emitBulkCopyLines();
    }
    emitViewerHoist();
    // Initialise scratchTopLocal so loop-invariant scratch allocations land
    // within the scratch region — WASM locals default to 0, so without this
    // the very first allocArrayInScratch call inside emitInvariantValueNodes
    // would capture offsetLocal = 0 (kind buffer base) and the producer's
    // writes would corrupt cell-attribute storage.
    emitter.i32Const(layout.scratchOffset);
    emitter.localSet(scratchTopLocal);
    emitInvariantValueNodes();
    // Snapshot scratchTop after invariants so per-cell scratch resets to this
    // point each iteration instead of layout.scratchOffset (which would clobber
    // the invariant data). When no invariants were emitted, this is still
    // layout.scratchOffset, so the snapshot is a no-op in that case.
    emitter.localGet(scratchTopLocal);
    emitter.localSet(perCellScratchBase);
    // The per-cell loop, parameterised over its bound + index source so the
    // sparse variant ("Skip Isolated Empty Cells") can reuse it verbatim:
    //   boundParam  — the param index holding the iteration count
    //   fromActiveList — i := activeList[_i] instead of i := _i / orderArray[_i]
    // The non-sparse call (boundParam 0, false) emits BYTE-IDENTICAL code to the
    // historical inline loop.
    const emitCellLoop = (boundParam: number, fromActiveList: boolean) => {
      emitter.i32Const(0);
      emitter.localSet(outerCounter);
      emitter.block(() => {
        emitter.loop(() => {
          // _i >= bound -> exit
          emitter.localGet(outerCounter);
          emitter.localGet(boundParam);
          emitter.op(OP_I32_GE_S);
          emitter.brIf(1);

          // i := _i (sync OR sequential async) or i := orderArray[_i] (async +
          // step) or i := activeList[_i] (sparse)
          if (fromActiveList) {
            emitter.localGet(outerCounter);
            emitter.i32Const(4);
            emitter.op(OP_I32_MUL);
            emitter.i32Load(layout.activeListOffset, 2);
            emitter.localSet(iLocal);
          } else if (layout.isAsync && opts.useOrderArrayInAsync) {
            emitter.localGet(outerCounter);
            emitter.i32Const(4);
            emitter.op(OP_I32_MUL);
            emitter.i32Load(layout.orderOffset, 2);
            emitter.localSet(iLocal);

            // Mark Cell Updated: if `_skipped[i] != 0`, advance the outer counter
            // and continue to the next iteration without running the body. JS
            // mirror is `if (_skipped[idx] !== 0) continue;` at the top of the
            // async loop. `br 1` inside the `ifThen` re-enters the loop (skipping
            // the body + the post-body increment), so increment outerCounter
            // here first.
            emitter.localGet(iLocal);
            emitter.i32Load8U(layout.skippedOffset, 0);
            emitter.ifThen(() => {
              emitter.localGet(outerCounter);
              emitter.i32Const(1);
              emitter.op(OP_I32_ADD);
              emitter.localSet(outerCounter);
              emitter.br(1); // continue loop
            });
          } else {
            emitter.localGet(outerCounter);
            emitter.localSet(iLocal);
          }

          emitBody();

          // _i += 1; continue
          emitter.localGet(outerCounter);
          emitter.i32Const(1);
          emitter.op(OP_I32_ADD);
          emitter.localSet(outerCounter);
          emitter.br(0);
        });
      });
    };
    if (opts.sparse) {
      // "Skip Isolated Empty Cells": select the loop at runtime by the
      // activeCount param (param 1) — `>= 0` iterates the active list, `< 0`
      // (the worker's -1 sentinel: no active set resolved / a forced full
      // colour pass) runs the classic full loop. Mirrors the JS emit's
      // `if (_activeList) … else …`. The body is emitted twice (once per
      // branch) — emitBody is re-entrant (it clears the per-cell caches and
      // allocates fresh locals each call).
      emitter.localGet(1);
      emitter.i32Const(0);
      emitter.op(OP_I32_GE_S);
      emitter.ifThenElse(
        () => emitCellLoop(1, true),
        () => emitCellLoop(0, false),
      );
    } else {
      emitCellLoop(0, false);
    }
  } else {
    // Single-shot (InputColor): idx is param 0 directly. Viewer hoist still
    // emits in case the brush flow contains a SetColorViewer (uncommon but
    // legal). Without it the per-cell SetColorViewer would fall back to the
    // inline load+compare path.
    emitViewerHoist();
    // No invariant emit in single-shot entries; perCellScratchBase still
    // needs initialising so emitBody's `local.get perCellScratchBase` reads
    // a sensible value (scratchOffset) instead of WASM's default 0.
    emitter.i32Const(layout.scratchOffset);
    emitter.localSet(perCellScratchBase);
    emitBody();
  }

  return { body: emitter.buildBody(), errors: ctx.errors };
}

// ---------------------------------------------------------------------------
// Top-level compile entry
// ---------------------------------------------------------------------------

export function compileGraphWasm(
  graphNodes: GraphNode[],
  graphEdges: GraphEdge[],
  model: CAModel,
  layout: MemoryLayout,
  viewerIds: Record<string, number>,
): WasmCompileResult {
  // Sub-attribute iteration is supported on WASM across the whole node
  // catalogue via per-emitter parent_match guards: sum, product, min, max,
  // average, and, or, count, filter, allIs/noneIs/etc., AND median + random.
  // Median materialises into per-cell scratch with a parent-match filter, then
  // sorts the filtered prefix (narrows lenLocal to filledLocal). Random filters
  // values into scratch and picks uniformly from the filtered length (RNG
  // advances regardless, matching JS's always-advance `_rs` semantics; empty filtered
  // set returns 0). For average + min/max, a matchCountLocal drives the
  // post-divide / position-in-filtered-set so results match JS/WASM semantics.

  // Pre-pass: resolve indicator IDs to numeric indices (mirrors the JS
  // compiler — without this, fresh-loaded models that haven't been JS-compiled
  // first will see _indicatorIdx === -1 on every indicator node). Also resolve
  // tag indexes for getNeighborIndexesByTags. Both are no-ops if the JS
  // compiler already filled them in.
  const indicatorIdxMap = new Map((model.indicators || []).map((ind, i) => [ind.id, i] as const));
  // 3D Grid CA: pack offsets with the 3-axis codec from coords3d when the model
  // is 3D; 2D packs the verbatim 2-axis codec (byte-identical). Mirrors the JS
  // pre-pass `packCoord`. Producing PACKED NIs here (not bare slot indices) is
  // required: the array emitter / every NI consumer treats these values as
  // packed offsets — slot indices were a latent bug masked when the JS compiler
  // happened to resolve the config first.
  const wasmNiIs3d = model.properties.dimension === '3d' && (model.properties.gridDepth ?? 1) > 1;
  const packCoordWasm = (nbr: { coords: Array<[number, number]>; coords3d?: Array<[number, number, number]> } | undefined, slot: number): number => {
    if (!nbr || slot < 0) return INVALID_NI;
    if (wasmNiIs3d) { const c = nbr.coords3d?.[slot]; return c ? packNI3(c[0], c[1], c[2]) : INVALID_NI; }
    const c = nbr.coords[slot]; return c ? packNI(c[0], c[1]) : INVALID_NI;
  };
  const tagSlot = (nbr: { tags?: Record<number, string> } | undefined, tagName: string): number => {
    const tagEntry = nbr?.tags ? Object.entries(nbr.tags).find(([, name]) => name === tagName) : undefined;
    return tagEntry !== undefined ? Number(tagEntry[0]) : -1;
  };
  const resolveIndicatorAndTags = (nodes: GraphNode[]) => {
    for (const node of nodes) {
      const t = node.data.nodeType;
      if (t === 'getIndicator' || t === 'setIndicator' || t === 'updateIndicator') {
        if (node.data.config._indicatorIdx === undefined || node.data.config._indicatorIdx === -1) {
          const indId = node.data.config.indicatorId as string;
          const idx = indicatorIdxMap.get(indId);
          node.data.config._indicatorIdx = idx !== undefined ? idx : -1;
        }
      }
      if (t === 'getNeighborIndexesByTags') {
        const nbrId = node.data.config.neighborhoodId as string;
        const nbr = model.neighborhoods.find(n => n.id === nbrId);
        const tagCount = Number(node.data.config.tagCount) || 0;
        const packed: number[] = [];
        for (let i = 0; i < tagCount; i++) {
          packed.push(packCoordWasm(nbr, tagSlot(nbr, node.data.config[`tag_${i}_name`] as string)));
        }
        node.data.config._resolvedTagIndexes = JSON.stringify(packed);
      }
      if (t === 'neighborIndexFromTag') {
        const nbrId = node.data.config.neighborhoodId as string;
        const nbr = model.neighborhoods.find(n => n.id === nbrId);
        node.data.config._resolvedPacked = packCoordWasm(nbr, tagSlot(nbr, node.data.config.tagName as string));
      }
    }
  };
  resolveIndicatorAndTags(graphNodes);
  for (const def of (model.macroDefs || [])) resolveIndicatorAndTags(def.nodes);

  // Pre-pass: inline all macro instances.
  const expanded = expandMacros(graphNodes, graphEdges, model);
  if (expanded.error) {
    return { bytes: new Uint8Array(), minMemoryPages: 1, error: expanded.error, viewerIds, exports: [] };
  }
  graphNodes = expanded.nodes;
  graphEdges = expanded.edges;

  // Reroute collapse — strip editor-only reroute relay nodes, rewiring each
  // consumer to the real source (chains resolved transitively). Runs AFTER
  // expandMacros so in-macro reroutes (now flattened to top-level prefixed
  // nodes) collapse too, and before linked-OM / CSE / adjacency so nothing
  // downstream sees a reroute. See rerouteCollapse.ts.
  ({ nodes: graphNodes, edges: graphEdges } = collapseReroutes(graphNodes, graphEdges));

  // Multi-attribute slot expansion — multi-slot Get/Set Attribute nodes become
  // the single-slot primitives the WASM emitters already compile. BEFORE
  // lowerVectorAttrs so a vector attribute in an extra slot lowers normally.
  // Hot-path no-op. See multiAttrExpand.ts.
  ({ nodes: graphNodes, edges: graphEdges } = expandMultiAttrs(graphNodes, graphEdges, model));

  // Vector stored-attribute lowering — Get/Set Vector nodes → Make/Break Vector
  // over per-component scalar reads/writes + reassign `model` to the
  // component-expanded attrs/variables. The WASM layout (computeLayoutFromModel)
  // expands identically, so offsets match (ABI-mirror). See vectorAttr.ts.
  ({ nodes: graphNodes, edges: graphEdges, model } = lowerVectorAttrs(graphNodes, graphEdges, model));

  // Composite-type lowering — vector / colour nodes become scalar nodes so the
  // WASM emitters compile them natively (no JS-only clamp). See expandComposites.ts.
  ({ nodes: graphNodes, edges: graphEdges } = expandComposites(graphNodes, graphEdges, model));

  // Linked Output Mappings — synthesize the auto color pass for `linked`
  // mappings (ephemeral; rebuilt from the live model each compile). After macro
  // expansion, before CSE + adjacency so the synthetic nodes are flat & deduped.
  ({ nodes: graphNodes, edges: graphEdges } = injectLinkedOutputMappings(graphNodes, graphEdges, model));

  // Accessor CSE — sync-mode only. Runs AFTER macro expansion so that
  // duplicate accessors inside (or across) macro instances also get merged.
  // No-op when no group has more than one member (typical for single-accessor
  // models like Game of Life). See accessorCSE.ts for the full rationale.
  graphEdges = canonicalizeAccessorEdges(graphNodes, graphEdges, model);

  // Build adjacency
  const nodeMap = new Map<string, GraphNode>();
  for (const n of graphNodes) nodeMap.set(n.id, n);
  const inputToSource = new Map<string, { nodeId: string; portId: string }>();
  const inputToSources = new Map<string, Array<{ nodeId: string; portId: string }>>();
  const flowOutputToTargets = new Map<string, Array<{ nodeId: string; portId: string }>>();
  for (const edge of graphEdges) {
    const sm = parseHandle(edge.sourceHandle);
    const tm = parseHandle(edge.targetHandle);
    if (!sm || !tm) continue;
    if (tm.category === 'value') {
      inputToSource.set(`${edge.target}:${tm.portId}`, { nodeId: edge.source, portId: sm.portId });
      const arr = inputToSources.get(`${edge.target}:${tm.portId}`) ?? [];
      arr.push({ nodeId: edge.source, portId: sm.portId });
      inputToSources.set(`${edge.target}:${tm.portId}`, arr);
    }
    if (sm.category === 'flow') {
      const k = `${edge.source}:${sm.portId}`;
      const arr = flowOutputToTargets.get(k) ?? [];
      arr.push({ nodeId: edge.target, portId: tm.portId });
      flowOutputToTargets.set(k, arr);
    }
  }

  // Find entry-point nodes
  const stepNode = graphNodes.find(n => n.data.nodeType === 'step');
  const inputColorNodes = graphNodes.filter(n => n.data.nodeType === 'inputColor');
  const outputMappingNodes = graphNodes.filter(n => n.data.nodeType === 'outputMapping');
  const initNode = graphNodes.find(n => n.data.nodeType === 'initEvent');

  if (!stepNode) {
    return { bytes: new Uint8Array(), minMemoryPages: 1, error: 'no Step node', viewerIds, exports: [] };
  }

  // Loop-invariant classification — shared with the JS compiler so both
  // targets agree on which value nodes can be hoisted out of the cell loop.
  const loopInvariant = classifyLoopInvariant(graphNodes, inputToSource);

  // Build each entry function body
  const exportEntries: Array<{ name: string; typeIdx: number; body: Uint8Array }> = [];
  const allErrors: string[] = [];

  // "Skip Isolated Empty Cells": the loop entries (step + outputMapping) gain a
  // 2nd `activeCount` param + the runtime-selected sparse/full loop. Init +
  // InputColor stay full/per-cell always. OFF → byte-identical modules.
  const sparse = layout.sparseStepping;

  // Step
  const stepSink = analyzeSinkScopes({
    nodes: graphNodes, edges: graphEdges, rootNodeId: stepNode.id, rootFlowPortId: 'do',
  });
  const stepRes = compileEntry(
    {
      entry: stepNode,
      numParams: sparse ? 2 : 1,
      iLocalSource: 'param0WithLoop',
      hasLoop: true,
      emitCopyLines: true,
      useOrderArrayInAsync: true,
      sparse,
    },
    layout, viewerIds, model, nodeMap, inputToSource, inputToSources, flowOutputToTargets, loopInvariant, stepSink,
  );
  allErrors.push(...stepRes.errors);
  exportEntries.push({ name: 'step', typeIdx: sparse ? TYPE_IDX_TOTAL_COUNT : TYPE_IDX_TOTAL, body: stepRes.body });

  // OutputMapping (one per mapping) — always sequential, no copy lines.
  for (const om of outputMappingNodes) {
    const mappingId = (om.data.config.mappingId as string) || '';
    const omSink = analyzeSinkScopes({
      nodes: graphNodes, edges: graphEdges, rootNodeId: om.id, rootFlowPortId: 'do',
    });
    const omRes = compileEntry(
      {
        entry: om,
        numParams: sparse ? 2 : 1,
        iLocalSource: 'param0WithLoop',
        hasLoop: true,
        emitCopyLines: false,
        useOrderArrayInAsync: false,
        sparse,
      },
      layout, viewerIds, model, nodeMap, inputToSource, inputToSources, flowOutputToTargets, loopInvariant, omSink,
    );
    allErrors.push(...omRes.errors);
    exportEntries.push({ name: `outputMapping_${sanitiseExportName(mappingId)}`, typeIdx: sparse ? TYPE_IDX_TOTAL_COUNT : TYPE_IDX_TOTAL, body: omRes.body });
  }

  // Init Event entry-point (optional, one per model). Runs once per cell on
  // Reset after defaults are applied; same loop shape as Step but always
  // sequential (no orderArray) and Init writes ARE bulk-copied for sync mode
  // so SetAttribute / SetOrientation inside init see a fresh w-buffer.
  // Exported as `init`. The worker calls it on Reset (paralleling JS `runInit`).
  if (initNode) {
    const initSink = analyzeSinkScopes({
      nodes: graphNodes, edges: graphEdges, rootNodeId: initNode.id, rootFlowPortId: 'do',
    });
    const initRes = compileEntry(
      {
        entry: initNode,
        numParams: 1,
        iLocalSource: 'param0WithLoop',
        hasLoop: true,
        emitCopyLines: true,
        useOrderArrayInAsync: false,
      },
      layout, viewerIds, model, nodeMap, inputToSource, inputToSources, flowOutputToTargets, loopInvariant, initSink,
    );
    allErrors.push(...initRes.errors);
    exportEntries.push({ name: 'init', typeIdx: TYPE_IDX_TOTAL, body: initRes.body });
  }

  // InputColor (one per mapping) — single cell, no loop. Per-cell preamble
  // still needs copy lines (so subsequent step sees the painted state).
  for (const ic of inputColorNodes) {
    const mappingId = (ic.data.config.mappingId as string) || '';
    const icSink = analyzeSinkScopes({
      nodes: graphNodes, edges: graphEdges, rootNodeId: ic.id, rootFlowPortId: 'do',
    });
    const icRes = compileEntry(
      {
        entry: ic,
        numParams: 4,
        iLocalSource: 'param0',
        hasLoop: false,
        emitCopyLines: true,
        useOrderArrayInAsync: false,
        // Param indexes match the function signature: 0=idx, 1=r, 2=g, 3=b.
        paramOutputs: { r: 1, g: 2, b: 3 },
      },
      layout, viewerIds, model, nodeMap, inputToSource, inputToSources, flowOutputToTargets, loopInvariant, icSink,
    );
    allErrors.push(...icRes.errors);
    exportEntries.push({ name: `inputColor_${sanitiseExportName(mappingId)}`, typeIdx: TYPE_IDX_IDX_RGB, body: icRes.body });
  }

  if (allErrors.length > 0) {
    return {
      bytes: new Uint8Array(),
      minMemoryPages: 1,
      error: allErrors.join('; '),
      viewerIds,
      exports: [],
    };
  }

  // Assemble the module.
  // Type indices:
  //   0: pow type (f64, f64) -> f64   (imported)
  //   1: total entry point: (i32) -> ()         (step / outputMapping)
  //   2: inputColor entry: (i32, i32, i32, i32) -> ()
  //   3: unary math type (f64) -> f64           (imported exp/log/sin/cos/tan/tanh)
  const typePow = funcType([F64, F64], [F64]);
  const typeTotal = funcType([I32], []);
  const typeIdxRgb = funcType([I32, I32, I32, I32], []);
  const typeUnary = funcType([F64], [F64]);
  const TYPE_IDX_UNARY = 3;
  // Sparse entries: (total, activeCount) -> (). Appended ONLY when sparse so a
  // non-sparse module's type section is byte-identical.
  const typeTotalCount = funcType([I32, I32], []);

  // Imports: env.mem (memory) + the host math functions WASM can't synthesise.
  // The func imports MUST appear in funcIdx order (pow, exp, log, sin, cos, tan,
  // tanh) — see POW_FUNC_IDX..TANH_FUNC_IDX — and be mirrored in
  // instantiateWasmModule's env object. (mem is a memory import and does not
  // consume a function index.)
  const memImport = importEntry('env', 'mem', importMemoryDesc(layout.pages));
  const powImport = importEntry('env', 'pow', importFuncDesc(0));
  const unaryImports = [
    importEntry('env', 'exp', importFuncDesc(TYPE_IDX_UNARY)),
    importEntry('env', 'log', importFuncDesc(TYPE_IDX_UNARY)),
    importEntry('env', 'sin', importFuncDesc(TYPE_IDX_UNARY)),
    importEntry('env', 'cos', importFuncDesc(TYPE_IDX_UNARY)),
    importEntry('env', 'tan', importFuncDesc(TYPE_IDX_UNARY)),
    importEntry('env', 'tanh', importFuncDesc(TYPE_IDX_UNARY)),
  ];

  // funcs section: each entry is the type index of the matching code body.
  // Imported funcs come BEFORE module-defined funcs in the function index space
  // (funcIdx 0..NUM_IMPORTED_FUNCS-1 = imported host math; the rest = compiled).
  const funcs = exportEntries.map(e => leb128u(e.typeIdx));
  const exports: Uint8Array[] = exportEntries.map((e, i) => exportEntry(e.name, EXPORT_FUNC, /* funcIdx */ NUM_IMPORTED_FUNCS + i));
  const codes = exportEntries.map(e => e.body);

  const bytes = buildModule({
    types: sparse
      ? [typePow, typeTotal, typeIdxRgb, typeUnary, typeTotalCount]
      : [typePow, typeTotal, typeIdxRgb, typeUnary],
    imports: [memImport, powImport, ...unaryImports],
    funcs,
    exports,
    code: codes,
  });

  return {
    bytes,
    minMemoryPages: layout.pages,
    viewerIds,
    exports: exportEntries.map(e => e.name),
  };
}

// Type indices (relative to the order in the types section above)
const TYPE_IDX_TOTAL = 1;
const TYPE_IDX_IDX_RGB = 2;
/** Sparse loop entries — (total, activeCount) -> (). Present only in sparse modules. */
const TYPE_IDX_TOTAL_COUNT = 4;

/** Sanitise mapping ids into something WASM exports can handle. The export
 *  name is just bytes, but our worker uses these as JS object keys, so we
 *  keep them URL-safe to avoid surprises. */
function sanitiseExportName(s: string): string {
  return s.replace(/[^A-Za-z0-9_]/g, '_');
}

// Macro inlining (`expandMacros`) now lives in the shared `../macroExpand`
// module, used identically by the JS / WASM / WebGPU compilers.

function parseHandle(handleId: string | undefined): { category: 'value' | 'flow'; portId: string } | null {
  if (!handleId) return null;
  // Handle id format from React Flow: "<input|output>_<value|flow>_<portId>"
  const m = handleId.match(/^(?:input|output)_(value|flow)_(.+)$/);
  if (!m) return null;
  return { category: m[1] as 'value' | 'flow', portId: m[2]! };
}

/**
 * Async helper: compile + instantiate against the given memory + Math.pow import.
 * Returns the full set of exported functions keyed by name. Worker picks them
 * apart into wasmStepFn / wasmInputColorFns / wasmOutputMappingFns.
 */
export async function instantiateWasmModule(
  result: WasmCompileResult,
  memory: WebAssembly.Memory,
): Promise<{ exports: Record<string, Function> }> {
  const importObj = {
    env: {
      mem: memory,
      // Host math functions WASM can't synthesise. Order is irrelevant here
      // (matched by name), but every name referenced by a funcIdx in compile
      // (POW_FUNC_IDX..TANH_FUNC_IDX) MUST be present.
      pow: Math.pow,
      exp: Math.exp,
      log: Math.log,
      sin: Math.sin,
      cos: Math.cos,
      tan: Math.tan,
      tanh: Math.tanh,
    },
  };
  const mod = await WebAssembly.instantiate(result.bytes, importObj);
  const exports: Record<string, Function> = {};
  for (const name of result.exports) {
    exports[name] = mod.instance.exports[name] as Function;
  }
  return { exports };
}

/** Legacy shim — used by sim.worker.ts before the multi-export rework lands.
 *  Returns just the `step` function from a freshly instantiated module. */
export async function instantiateWasmStep(
  result: WasmCompileResult,
  memory: WebAssembly.Memory,
): Promise<{ step: (total: number) => void }> {
  const inst = await instantiateWasmModule(result, memory);
  const step = inst.exports.step as ((total: number) => void) | undefined;
  if (!step) throw new Error('module has no step export');
  return { step };
}

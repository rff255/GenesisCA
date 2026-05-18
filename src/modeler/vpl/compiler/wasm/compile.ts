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
import { readColorScaleStops } from '../../nodes/ColorScaleNode';
import {
  ValType, F64, I32, OP_F64_ABS, OP_F64_ADD, OP_F64_CONVERT_I32_U, OP_F64_DIV,
  OP_F64_EQ, OP_F64_FLOOR, OP_F64_GE, OP_F64_GT, OP_F64_LE, OP_F64_LT,
  OP_F64_MAX, OP_F64_MIN, OP_F64_MUL, OP_F64_NE, OP_F64_SQRT, OP_F64_SUB,
  OP_I32_ADD, OP_I32_AND, OP_I32_DIV_S, OP_I32_EQ, OP_I32_EQZ, OP_I32_GE_S,
  OP_I32_GT_S, OP_I32_LT_S, OP_I32_MUL, OP_I32_OR, OP_I32_REM_S, OP_I32_SHL,
  OP_I32_SHR_S, OP_I32_SHR_U, OP_I32_SUB, OP_I32_XOR, OP_SELECT,
  buildModule, byte, exportEntry, EXPORT_FUNC, funcType, importEntry,
  importFuncDesc, importMemoryDesc, leb128u,
} from './encoder';
import { INVALID_NI, packNI, NI_ARRAY_PRODUCERS } from '../niCodec';
import {
  WasmEmitter, ArrayRef, LocalRef, ValueRef, pushValueAs,
} from './emitter';
import type { MemoryLayout } from './layout';
import { classifyLoopInvariant } from '../loopInvariant';
import { getInlineValue, parseInlineNum } from '../inlinePort';
import { analyzeSinkScopes, CELL_TOP, type ScopeId, type SinkAnalysisResult } from '../sinkAnalysis';
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

// Math.pow is the only math function we can't synthesise from native f64
// intrinsics; we import it as func index 0. All other Math.* operations have
// native WASM equivalents (sqrt = OP_F64_SQRT, abs = OP_F64_ABS, floor =
// OP_F64_FLOOR; round is emitted as floor(x + 0.5)).
// Exported so the Expression node's WASM emitter (compiler/expression/emitWasm.ts)
// can emit `call pow` against the same single source of truth.
export const POW_FUNC_IDX = 0;

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
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function attrValType(t: string): ValType {
  return t === 'float' ? F64 : I32;
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
  const total = W * H;
  const boundary = ctx.model.properties.boundaryTreatment;
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
    } else {
      num = typeof raw === 'number' ? raw : (parseInt(String(raw ?? '0'), 10) || 0);
    }
    if (t === 'float') {
      ctx.emitter.f64Const(num);
      return storeResult(ctx.emitter, F64);
    }
    // bool / integer / tag / orientation — i32
    ctx.emitter.i32Const(num | 0);
    return storeResult(ctx.emitter, I32);
  },

  tagConstant: ({ node, ctx }) => {
    const idx = Number(node.data.config.tagIndex) || 0;
    ctx.emitter.i32Const(idx);
    return storeResult(ctx.emitter, I32);
  },

  // Wave A.6: NIs are packed (dr, dc) i32. neighborIndexFromOffset takes dr/dc
  // as input ports and emits the packed value at runtime.
  neighborIndexFromOffset: ({ ctx, inputs }) => {
    const drRef = inputs['dr'] ?? { inline: true, value: 0, valtype: I32 };
    const dcRef = inputs['dc'] ?? { inline: true, value: 0, valtype: I32 };
    const em = ctx.emitter;
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
    // dr = ni >> 16 (arithmetic right-shift — sign-extends)
    const drLocal = em.allocLocal(I32);
    em.localGet(inLocal); em.i32Const(16); em.op(OP_I32_SHR_S);
    em.localSet(drLocal);
    // dc = (ni << 16) >> 16 (shl16 then arithmetic shr16 — sign-extends low 16)
    const dcLocal = em.allocLocal(I32);
    em.localGet(inLocal); em.i32Const(16); em.op(OP_I32_SHL); em.i32Const(16); em.op(OP_I32_SHR_S);
    em.localSet(dcLocal);
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

  getModelAttribute: ({ node, ctx }) => {
    const attrId = node.data.config.attributeId as string;
    const isColor = !!node.data.config.isColorAttr;
    if (isColor) {
      // Three-way emit: load r, g, b from modelAttrOffset[id+'_r'/'_g'/'_b']
      const offR = ctx.layout.modelAttrOffset[attrId + '_r'];
      const offG = ctx.layout.modelAttrOffset[attrId + '_g'];
      const offB = ctx.layout.modelAttrOffset[attrId + '_b'];
      if (offR === undefined || offG === undefined || offB === undefined) {
        ctx.errors.push(`getModelAttribute color: unknown ${attrId}`); return null;
      }
      // Emit three i32 locals — model attrs are stored as f64 so we truncate.
      const emitCh = (off: number) => {
        ctx.emitter.i32Const(0);
        ctx.emitter.f64Load(off, 3);
        ctx.emitter.f64ToI32();
        return storeResult(ctx.emitter, I32);
      };
      const rRef = emitCh(offR);
      const gRef = emitCh(offG);
      const bRef = emitCh(offB);
      setCachedPort(ctx, node.id, 'r', rRef);
      setCachedPort(ctx, node.id, 'g', gRef);
      setCachedPort(ctx, node.id, 'b', bRef);
      // Default 'value' port also resolves to r (matches JS where it's just multi-output).
      return rRef;
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
      case 'pow':
        // imported Math.pow at funcIdx 0
        pushValueAs(em, x, F64);
        pushValueAs(em, y, F64);
        em.emit(byte(0x10), leb128u(POW_FUNC_IDX)); // call POW_FUNC_IDX
        break;
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
    pushValueAs(ctx.emitter, a, I32);
    pushValueAs(ctx.emitter, b, I32);
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

  // -- Random (xorshift32, similar to JS GetRandomNode) --
  getRandom: ({ node, ctx, inputs }) => {
    const t = (node.data.config.randomType as string) || 'float';
    const minRaw = node.data.config.min;
    const maxRaw = node.data.config.max;
    const minN = typeof minRaw === 'number' ? minRaw : parseFloat(String(minRaw ?? '0')) || 0;
    const maxN = typeof maxRaw === 'number' ? maxRaw : parseFloat(String(maxRaw ?? '1')) || 1;

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
    // Now stack has uniform [0, 1) float

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
        if (srcNode && isArrayProducer(srcNode.data.nodeType)) {
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
    // Load neighbor cell idx into a local: nIdx[i*nbrSize + tagIndex]
    ctx.emitter.localGet(ctx.iLocalIdx);
    ctx.emitter.i32Const(nbr.size);
    ctx.emitter.op(OP_I32_MUL);
    ctx.emitter.i32Const(tagIndex);
    ctx.emitter.op(OP_I32_ADD);
    ctx.emitter.i32Const(4);
    ctx.emitter.op(OP_I32_MUL);
    ctx.emitter.i32Load(nbr.offset, 2);
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
    if (!ctx.layout.variegatedEnabled) {
      ctx.errors.push('lookupInteraction: variegated cells disabled');
      return null;
    }
    const tableId = (node.data.config.tableId as string) || '';
    const tableOff = tableId ? ctx.layout.interactionTableOffsets[tableId] : undefined;
    const labelCount = ctx.layout.interactionTableLabelCount;
    if (tableOff === undefined) {
      // Tableless lookup compiles to constant 0 (matches JS fallback).
      ctx.emitter.f64Const(0);
      return storeResult(ctx.emitter, F64);
    }
    const labelA = inputs['labelA'] ?? { inline: true, value: 0, valtype: I32 };
    const labelB = inputs['labelB'] ?? { inline: true, value: 0, valtype: I32 };
    // addr = (labelA * labelCount + labelB) * 8 + tableOff
    pushValueAs(ctx.emitter, labelA, I32);
    ctx.emitter.i32Const(labelCount);
    ctx.emitter.op(OP_I32_MUL);
    pushValueAs(ctx.emitter, labelB, I32);
    ctx.emitter.op(OP_I32_ADD);
    ctx.emitter.i32Const(8);
    ctx.emitter.op(OP_I32_MUL);
    ctx.emitter.f64Load(tableOff, 3);
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
  valueSwitch: ({ ctx, inputs }) => {
    const cond = inputs['condition'] ?? { inline: true, value: 0, valtype: I32 };
    const ifV  = inputs['ifValue']   ?? { inline: true, value: 1, valtype: F64 };
    const elV  = inputs['elseValue'] ?? { inline: true, value: 0, valtype: F64 };
    pushValueAs(ctx.emitter, ifV, F64);
    pushValueAs(ctx.emitter, elV, F64);
    pushValueAs(ctx.emitter, cond, I32);
    ctx.emitter.op(OP_SELECT);
    return storeResult(ctx.emitter, F64);
  },

  // -- getColorConstant: three i32 channels from config (r, g, b) --
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

    const em = ctx.emitter;
    const tLoc = em.allocLocal(F64);
    const rLoc = em.allocLocal(I32);
    const gLoc = em.allocLocal(I32);
    const bLoc = em.allocLocal(I32);

    pushValueAs(em, t, F64);
    em.localSet(tLoc);

    const writeConst = (r: number, g: number, b: number) => {
      em.i32Const(r | 0); em.localSet(rLoc);
      em.i32Const(g | 0); em.localSet(gLoc);
      em.i32Const(b | 0); em.localSet(bLoc);
    };
    const writeSegment = (a: { p: number; r: number; g: number; b: number },
                          b: { p: number; r: number; g: number; b: number }) => {
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
      chan(a.r, b.r, rLoc);
      chan(a.g, b.g, gLoc);
      chan(a.b, b.b, bLoc);
    };

    if (stops.length === 0) {
      writeConst(0, 0, 0);
    } else if (stops.length === 1) {
      writeConst(stops[0]!.r, stops[0]!.g, stops[0]!.b);
    } else {
      const first = stops[0]!;
      em.localGet(tLoc);
      em.f64Const(first.p);
      em.op(OP_F64_LE);
      em.ifThenElse(
        () => writeConst(first.r, first.g, first.b),
        () => {
          const buildChain = (i: number) => {
            if (i >= stops.length - 1) {
              const last = stops[stops.length - 1]!;
              writeConst(last.r, last.g, last.b);
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

    const rRef: LocalRef = { localIdx: rLoc, valtype: I32 };
    const gRef: LocalRef = { localIdx: gLoc, valtype: I32 };
    const bRef: LocalRef = { localIdx: bLoc, valtype: I32 };
    setCachedPort(ctx, node.id, 'r', rRef);
    setCachedPort(ctx, node.id, 'g', gRef);
    setCachedPort(ctx, node.id, 'b', bRef);
    return rRef;
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
    if (srcNode && isArrayProducer(srcNode.data.nodeType)) {
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
        // Compute neighbor cell idx, stash in local.
        ctx.emitter.localGet(ctx.iLocalIdx);
        ctx.emitter.i32Const(nbr.size);
        ctx.emitter.op(OP_I32_MUL);
        ctx.emitter.localGet(nLocal);
        ctx.emitter.op(OP_I32_ADD);
        ctx.emitter.i32Const(4);
        ctx.emitter.op(OP_I32_MUL);
        ctx.emitter.i32Load(nbr.offset, 2);
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
      && firstSrcNode && isArrayProducer(firstSrcNode.data.nodeType)) {
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
      // (matches JS `Math.random()` semantics — called even on empty arrays).
      const subRand = getSubAttrWasm(ctx, attrId);
      if (subRand) {
        return emitRandomViaScratchFromSubAttrNbr(ctx, node, nbr, attr, subRand);
      }
      const indexLocal = pickRandomIndex(ctx, nbr.size);
      // Load element at that index from neighborhood
      ctx.emitter.localGet(ctx.iLocalIdx);
      ctx.emitter.i32Const(nbr.size);
      ctx.emitter.op(OP_I32_MUL);
      ctx.emitter.localGet(indexLocal);
      ctx.emitter.op(OP_I32_ADD);
      ctx.emitter.i32Const(4);
      ctx.emitter.op(OP_I32_MUL);
      ctx.emitter.i32Load(nbr.offset, 2);
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
      // Address = nbrOffset + (i*nbrSize + n) * 4
      ctx.emitter.localGet(ctx.iLocalIdx);
      ctx.emitter.i32Const(nbr.size);
      ctx.emitter.op(OP_I32_MUL);
      ctx.emitter.localGet(nLocal);
      ctx.emitter.op(OP_I32_ADD);
      ctx.emitter.i32Const(4);
      ctx.emitter.op(OP_I32_MUL);
      ctx.emitter.i32Load(nbr.offset, 2); // load i32 neighbor idx
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
              case 'and':
                ctx.emitter.localGet(accLocal);
                ctx.emitter.op(OP_I32_AND);
                ctx.emitter.localSet(accLocal);
                break;
              case 'or':
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
      em.localGet(ctx.iLocalIdx); em.i32Const(nbr.size); em.op(OP_I32_MUL);
      em.localGet(kLoc); em.op(OP_I32_ADD);
      em.i32Const(4); em.op(OP_I32_MUL);
      em.i32Load(nbr.offset, 2);
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
 *  JS `Math.random()` semantics on empty arrays). Empty filtered set returns
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

      em.localGet(ctx.iLocalIdx); em.i32Const(nbr.size); em.op(OP_I32_MUL);
      em.localGet(kLoc); em.op(OP_I32_ADD);
      em.i32Const(4); em.op(OP_I32_MUL);
      em.i32Load(nbr.offset, 2);
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
            case 'and':
              em.localGet(accLocal); em.op(OP_I32_AND); em.localSet(accLocal); break;
            case 'or':
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
      // GroupOperatorNode.compile() (`Math.floor(Math.random() * values.length)`).
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
        case 'and':
          ctx.emitter.localGet(accLocal);
          ctx.emitter.op(OP_I32_AND);
          ctx.emitter.localSet(accLocal);
          break;
        case 'or':
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
    const arr = allocArrayInScratchConst(ctx, nbr.coords.length, I32, 4);
    for (let k = 0; k < nbr.coords.length; k++) {
      const [dr, dc] = nbr.coords[k]!;
      const packed = packNI(dr, dc);
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
      const arrSrc = isArrayProducer(firstSrcNode?.data.nodeType ?? '') && sources.length === 1
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
        em.localGet(ctx.iLocalIdx); em.i32Const(nbr.size); em.op(OP_I32_MUL);
        em.localGet(n); em.op(OP_I32_ADD);
        em.i32Const(4); em.op(OP_I32_MUL);
        em.i32Load(nbr.offset, 2);
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
    const em = ctx.emitter;
    const lookupOff = ctx.layout.facePatternLookupOffset;
    const total = ctx.layout.total;
    const W = ctx.model.properties.gridWidth;
    const H = ctx.model.properties.gridHeight;

    // Allocate both scratch arrays first (length 8, i32, 4 bytes each).
    const myArr = allocArrayInScratchConst(ctx, 8, I32, 4);
    const theirArr = allocArrayInScratchConst(ctx, 8, I32, 4);

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

    // 8 directions in canonical N/NE/E/SE/S/SW/W/NW order.
    const OFFSETS: ReadonlyArray<readonly [number, number]> = [
      [-1, 0], [-1, 1], [0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1],
    ];

    for (let d = 0; d < 8; d++) {
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

      // Store myLabel and theirLabel into their respective scratch arrays
      // at offset d * 4.
      em.localGet(myArr.offsetLocal);
      em.i32Const(d * 4);
      em.op(OP_I32_ADD);
      em.localGet(myLabel);
      em.i32Store(0, 2);
      em.localGet(theirArr.offsetLocal);
      em.i32Const(d * 4);
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
  if (!isArrayProducer(srcNode.data.nodeType)) return null;
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

  setAttribute: ({ node, ctx, inputs }) => {
    const attrId = node.data.config.attributeId as string;
    const attr = getAttr(ctx.layout, attrId);
    if (!attr) { ctx.errors.push(`setAttribute: unknown attr ${attrId}`); return false; }
    const v = inputs['value'];
    if (!v) { ctx.errors.push('setAttribute: missing value input'); return false; }
    emitCellWriteAtIdx(ctx, attr, v);
    return true;
  },

  setCellGlyph: ({ node, ctx, inputs }) => {
    const viewerId = (node.data.config.mappingId as string) || '';
    const viewerInt = ctx.viewerIds[viewerId];
    if (viewerInt === undefined) return true; // unknown viewer — silently skip
    if (!ctx.layout.hasGlyphs) return true;   // defensive: no glyph regions reserved

    // Viewer guard — same hoisted-local pattern as setColorViewer.
    const cachedLocal = ctx.viewerLocals.get(viewerId);
    if (cachedLocal !== undefined) {
      ctx.emitter.localGet(cachedLocal);
    } else {
      ctx.emitter.i32Const(0);
      ctx.emitter.i32Load(ctx.layout.activeViewerOffset, 2);
      ctx.emitter.i32Const(viewerInt);
      ctx.emitter.op(OP_I32_EQ);
    }
    ctx.emitter.ifThen(() => {
      // glyphCodes[idx]: u32 store at glyphCodesOffset + idx*4
      const glyphByte = ctx.emitter.allocLocal(I32);
      ctx.emitter.localGet(ctx.iLocalIdx);
      ctx.emitter.i32Const(4);
      ctx.emitter.op(OP_I32_MUL);
      ctx.emitter.localTee(glyphByte);

      const cp = inputs['glyph'] ?? { inline: true, value: 0, valtype: I32 };
      pushValueAs(ctx.emitter, cp, I32);
      ctx.emitter.i32Store(ctx.layout.glyphCodesOffset, 2);

      // glyphColors[idx]: pack R | G<<8 | B<<16, store as u32.
      ctx.emitter.localGet(glyphByte);
      const r = inputs['r'] ?? { inline: true, value: 0, valtype: I32 };
      const g = inputs['g'] ?? { inline: true, value: 0, valtype: I32 };
      const b = inputs['b'] ?? { inline: true, value: 0, valtype: I32 };
      // R & 0xFF
      pushValueAs(ctx.emitter, r, I32);
      ctx.emitter.i32Const(0xFF);
      ctx.emitter.op(OP_I32_AND);
      // | ((G & 0xFF) << 8)
      pushValueAs(ctx.emitter, g, I32);
      ctx.emitter.i32Const(0xFF);
      ctx.emitter.op(OP_I32_AND);
      ctx.emitter.i32Const(8);
      ctx.emitter.op(OP_I32_SHL);
      ctx.emitter.op(OP_I32_OR);
      // | ((B & 0xFF) << 16)
      pushValueAs(ctx.emitter, b, I32);
      ctx.emitter.i32Const(0xFF);
      ctx.emitter.op(OP_I32_AND);
      ctx.emitter.i32Const(16);
      ctx.emitter.op(OP_I32_SHL);
      ctx.emitter.op(OP_I32_OR);
      ctx.emitter.i32Store(ctx.layout.glyphColorsOffset, 2);
    });
    return true;
  },

  setColorViewer: ({ node, ctx, inputs }) => {
    const viewerId = (node.data.config.mappingId as string) || '';
    const viewerInt = ctx.viewerIds[viewerId];
    if (viewerInt === undefined) {
      // Viewer not in our compile-time map — skip silently (as if "if (active === unknown)" is false)
      return true;
    }
    // Per-step hoist: viewerLocals[viewerId] holds (activeViewer == viewerInt).
    // Falls back to inline load+compare if no cached local exists (e.g. a
    // viewer id not pre-hoisted), so this stays safe under any compile path.
    const cachedLocal = ctx.viewerLocals.get(viewerId);
    if (cachedLocal !== undefined) {
      ctx.emitter.localGet(cachedLocal);
    } else {
      ctx.emitter.i32Const(0);
      ctx.emitter.i32Load(ctx.layout.activeViewerOffset, 2);
      ctx.emitter.i32Const(viewerInt);
      ctx.emitter.op(OP_I32_EQ);
    }
    ctx.emitter.ifThen(() => {
      // Address base for color writes: i*4 + colorsOffset
      const colorByte = ctx.emitter.allocLocal(I32);
      ctx.emitter.localGet(ctx.iLocalIdx);
      ctx.emitter.i32Const(4);
      ctx.emitter.op(OP_I32_MUL);
      ctx.emitter.localTee(colorByte);

      // Channel writes — node has r/g/b inputs
      const r = inputs['r'] ?? { inline: true, value: 0, valtype: I32 };
      const g = inputs['g'] ?? { inline: true, value: 0, valtype: I32 };
      const b = inputs['b'] ?? { inline: true, value: 0, valtype: I32 };

      // r at offset+0
      pushValueAs(ctx.emitter, r, I32);
      ctx.emitter.i32Store8(ctx.layout.colorsOffset + 0, 0);

      ctx.emitter.localGet(colorByte);
      pushValueAs(ctx.emitter, g, I32);
      ctx.emitter.i32Store8(ctx.layout.colorsOffset + 1, 0);

      ctx.emitter.localGet(colorByte);
      pushValueAs(ctx.emitter, b, I32);
      ctx.emitter.i32Store8(ctx.layout.colorsOffset + 2, 0);

      ctx.emitter.localGet(colorByte);
      ctx.emitter.i32Const(255);
      ctx.emitter.i32Store8(ctx.layout.colorsOffset + 3, 0);
    });
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
      if (srcNode && isArrayProducer(srcNode.data.nodeType)) {
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
      if (srcNode && isArrayProducer(srcNode.data.nodeType)) {
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
      // Loop: for (let _i = 0; _i < count; _i++) { body }
      const countSource = ctx.inputToSource.get(`${node.id}:count`);
      let countRef: ValueRef;
      if (countSource) {
        const r = compileValueNode(countSource.nodeId, ctx, countSource.portId);
        if (!r) return false;
        countRef = r;
      } else {
        const port = def.ports.find(p => p.id === 'count');
        const inlineVal = port ? getInlineValue(port, node.data.config) : undefined;
        countRef = { inline: true, value: parseInlineNum(inlineVal, 1), valtype: I32 };
      }
      // Allocate loop counter local + bound local
      const li = ctx.emitter.allocLocal(I32);
      const lc = ctx.emitter.allocLocal(I32);
      pushValueAs(ctx.emitter, countRef, I32);
      ctx.emitter.localSet(lc);
      ctx.emitter.i32Const(0);
      ctx.emitter.localSet(li);
      ctx.emitter.block(() => {
        ctx.emitter.loop(() => {
          // if (li >= lc) br block
          ctx.emitter.localGet(li);
          ctx.emitter.localGet(lc);
          ctx.emitter.op(OP_I32_GE_S);
          ctx.emitter.brIf(1);
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
      const flowEmitter = FLOW_NODE_EMITTERS[node.data.nodeType];
      if (!flowEmitter) {
        ctx.errors.push(`No WASM flow emitter for "${node.data.nodeType}"`);
        return false;
      }
      const ok = flowEmitter({ ctx, node, inputs });
      if (!ok) return false;
    }
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

  const ctx: WasmCompileCtx = {
    emitter,
    layout,
    viewerIds,
    model,
    iLocalIdx: iLocal,
    rowLocalIdx: rowLocal,
    colLocalIdx: colLocal,
    valueLocals: new Map(),
    arrayRefs: new Map(),
    byteOffsetLocals: new Map(),
    nodeMap,
    inputToSource,
    inputToSources,
    flowOutputToTargets,
    errors: [],
    scratchTopLocal,
    paramRefs,
    loopInvariant,
    viewerLocals: new Map(),
    sinkAnalysis,
  };

  // Snapshot of value-local refs that are loop-invariant. Populated after the
  // pre-loop emission pass. Per-cell emitBody clears valueLocals (cell-dependent
  // refs would be stale) then restores these so subsequent compileValueNode
  // calls hit the cache and skip re-emission.
  const invariantSnapshot = new Map<string, Map<string, LocalRef>>();

  const W = model.properties.gridWidth;
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
    //   row = idx / W; col = idx - row * W;
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
      if (getSubAttrWasm(ctx, id)) continue;
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
    emitter.i32Const(0);
    emitter.localSet(outerCounter);
    emitter.block(() => {
      emitter.loop(() => {
        // _i >= total -> exit
        emitter.localGet(outerCounter);
        emitter.localGet(0);
        emitter.op(OP_I32_GE_S);
        emitter.brIf(1);

        // i := _i (sync OR sequential async) or i := orderArray[_i] (async + step)
        if (layout.isAsync && opts.useOrderArrayInAsync) {
          emitter.localGet(outerCounter);
          emitter.i32Const(4);
          emitter.op(OP_I32_MUL);
          emitter.i32Load(layout.orderOffset, 2);
          emitter.localSet(iLocal);
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
  // Sub-attribute iteration is supported on WASM for the common ops (sum,
  // product, min, max, average, and, or, count, filter, allIs/noneIs/etc.) via
  // per-emitter parent_match guards. Two ops still bail out at the per-emitter
  // level: aggregate.median (sorts a scratch copy; the median scratch path
  // doesn't yet filter by parent) and groupOperator.random (picks uniformly
  // over the full neighborhood). Those return a clear error from the emitter
  // and the worker falls back to JS.

  // Pre-pass: resolve indicator IDs to numeric indices (mirrors the JS
  // compiler — without this, fresh-loaded models that haven't been JS-compiled
  // first will see _indicatorIdx === -1 on every indicator node). Also resolve
  // tag indexes for getNeighborIndexesByTags. Both are no-ops if the JS
  // compiler already filled them in.
  const indicatorIdxMap = new Map((model.indicators || []).map((ind, i) => [ind.id, i] as const));
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
      if (t === 'getNeighborIndexesByTags' && !node.data.config._resolvedTagIndexes) {
        const nbrId = node.data.config.neighborhoodId as string;
        const nbr = model.neighborhoods.find(n => n.id === nbrId);
        const tagCount = Number(node.data.config.tagCount) || 0;
        const indices: number[] = [];
        for (let i = 0; i < tagCount; i++) {
          const tagName = node.data.config[`tag_${i}_name`] as string;
          const tagEntry = nbr?.tags
            ? Object.entries(nbr.tags).find(([, name]) => name === tagName)
            : undefined;
          indices.push(tagEntry !== undefined ? Number(tagEntry[0]) : 0);
        }
        node.data.config._resolvedTagIndexes = JSON.stringify(indices);
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

  // Step
  const stepSink = analyzeSinkScopes({
    nodes: graphNodes, edges: graphEdges, rootNodeId: stepNode.id, rootFlowPortId: 'do',
  });
  const stepRes = compileEntry(
    {
      entry: stepNode,
      numParams: 1,
      iLocalSource: 'param0WithLoop',
      hasLoop: true,
      emitCopyLines: true,
      useOrderArrayInAsync: true,
    },
    layout, viewerIds, model, nodeMap, inputToSource, inputToSources, flowOutputToTargets, loopInvariant, stepSink,
  );
  allErrors.push(...stepRes.errors);
  exportEntries.push({ name: 'step', typeIdx: TYPE_IDX_TOTAL, body: stepRes.body });

  // OutputMapping (one per mapping) — always sequential, no copy lines.
  for (const om of outputMappingNodes) {
    const mappingId = (om.data.config.mappingId as string) || '';
    const omSink = analyzeSinkScopes({
      nodes: graphNodes, edges: graphEdges, rootNodeId: om.id, rootFlowPortId: 'do',
    });
    const omRes = compileEntry(
      {
        entry: om,
        numParams: 1,
        iLocalSource: 'param0WithLoop',
        hasLoop: true,
        emitCopyLines: false,
        useOrderArrayInAsync: false,
      },
      layout, viewerIds, model, nodeMap, inputToSource, inputToSources, flowOutputToTargets, loopInvariant, omSink,
    );
    allErrors.push(...omRes.errors);
    exportEntries.push({ name: `outputMapping_${sanitiseExportName(mappingId)}`, typeIdx: TYPE_IDX_TOTAL, body: omRes.body });
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
  const typePow = funcType([F64, F64], [F64]);
  const typeTotal = funcType([I32], []);
  const typeIdxRgb = funcType([I32, I32, I32, I32], []);

  // Imports: env.mem (memory), env.pow (Math.pow)
  const memImport = importEntry('env', 'mem', importMemoryDesc(layout.pages));
  const powImport = importEntry('env', 'pow', importFuncDesc(0));

  // funcs section: each entry is the type index of the matching code body.
  // Imported funcs come BEFORE module-defined funcs in the function index space
  // (so funcIdx 0 = imported pow, funcIdx 1+ = our compiled functions).
  const funcs = exportEntries.map(e => leb128u(e.typeIdx));
  const exports: Uint8Array[] = exportEntries.map((e, i) => exportEntry(e.name, EXPORT_FUNC, /* funcIdx */ 1 + i));
  const codes = exportEntries.map(e => e.body);

  const bytes = buildModule({
    types: [typePow, typeTotal, typeIdxRgb],
    imports: [memImport, powImport],
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

/** Sanitise mapping ids into something WASM exports can handle. The export
 *  name is just bytes, but our worker uses these as JS object keys, so we
 *  keep them URL-safe to avoid surprises. */
function sanitiseExportName(s: string): string {
  return s.replace(/[^A-Za-z0-9_]/g, '_');
}

// ---------------------------------------------------------------------------
// Macro inlining (verbatim from the previous implementation)
// ---------------------------------------------------------------------------

/**
 * Recursively inline all `macro` nodes by expanding each instance's internal
 * subgraph into the outer graph. After expansion the orchestrator never sees
 * `macro` / `macroInput` / `macroOutput` nodes.
 *
 * For each macro instance:
 *  - Internal non-boundary nodes are copied with a prefixed id (`m{instanceId}_*`)
 *    so multiple instances of the same macro don't collide.
 *  - Internal edges touching the boundary nodes are dissolved.
 *
 * Nested macros: re-runs until no `macro` nodes remain (with a depth cap).
 */
function expandMacros(
  graphNodes: GraphNode[],
  graphEdges: GraphEdge[],
  model: CAModel,
  depth = 0,
): { nodes: GraphNode[]; edges: GraphEdge[]; error?: string } {
  if (depth > 20) return { nodes: graphNodes, edges: graphEdges, error: 'macro recursion depth > 20' };
  const macroInstances = graphNodes.filter(n => n.data.nodeType === 'macro');
  if (macroInstances.length === 0) return { nodes: graphNodes, edges: graphEdges };

  const macroDefs = model.macroDefs ?? [];

  // Index outer edges by source/target for fast bridge lookup
  const edgesByTarget = new Map<string, GraphEdge[]>();
  const edgesBySource = new Map<string, GraphEdge[]>();
  for (const e of graphEdges) {
    const t = edgesByTarget.get(e.target); if (t) t.push(e); else edgesByTarget.set(e.target, [e]);
    const s = edgesBySource.get(e.source); if (s) s.push(e); else edgesBySource.set(e.source, [e]);
  }

  const removedNodeIds = new Set(macroInstances.map(m => m.id));
  const newNodes: GraphNode[] = [];
  const newEdges: GraphEdge[] = [];

  // Carry over all non-macro outer nodes
  for (const n of graphNodes) if (!removedNodeIds.has(n.id)) newNodes.push(n);
  // Carry over outer edges that don't touch any macro instance
  for (const e of graphEdges) {
    if (!removedNodeIds.has(e.source) && !removedNodeIds.has(e.target)) newEdges.push(e);
  }

  for (const m of macroInstances) {
    const def = macroDefs.find(d => d.id === m.data.config.macroDefId);
    if (!def) continue;
    const prefix = `m${m.id}_`;

    // Map external sources for each input port (via outer edges arriving at macro instance)
    const extInMap = new Map<string, { source: string; sourceHandle: string }>();
    const extInArr = edgesByTarget.get(m.id) ?? [];
    for (const e of extInArr) extInMap.set(e.targetHandle, { source: e.source, sourceHandle: e.sourceHandle });

    // Outer edges consuming the macro instance's output ports
    const extOutArr = edgesBySource.get(m.id) ?? [];

    // Copy internal non-boundary nodes with prefixed ids
    for (const inner of def.nodes) {
      if (inner.data.nodeType === 'macroInput' || inner.data.nodeType === 'macroOutput') continue;
      newNodes.push({ ...inner, id: prefix + inner.id });
    }

    // Copy internal edges, rewriting endpoints
    for (const e of def.edges) {
      const srcInner = def.nodes.find(n => n.id === e.source);
      const tgtInner = def.nodes.find(n => n.id === e.target);
      const srcIsBoundary = srcInner?.data.nodeType === 'macroInput' || srcInner?.data.nodeType === 'macroOutput';
      const tgtIsBoundary = tgtInner?.data.nodeType === 'macroInput' || tgtInner?.data.nodeType === 'macroOutput';
      if (srcIsBoundary && tgtIsBoundary) continue; // pure boundary-to-boundary — no work

      if (srcInner?.data.nodeType === 'macroInput') {
        const ep = parseHandle(e.sourceHandle);
        const epPortId = ep?.portId ?? e.sourceHandle;
        let ext: { source: string; sourceHandle: string } | undefined;
        for (const [th, src] of extInMap) {
          const parsed = parseHandle(th);
          if (parsed?.portId === epPortId) { ext = src; break; }
        }
        if (!ext) continue;
        newEdges.push({
          ...e,
          id: prefix + e.id,
          source: ext.source,
          sourceHandle: ext.sourceHandle,
          target: prefix + e.target,
        });
        continue;
      }

      if (tgtInner?.data.nodeType === 'macroOutput') {
        const epPortId = parseHandle(e.targetHandle)?.portId ?? e.targetHandle;
        for (const eOut of extOutArr) {
          const epExt = parseHandle(eOut.sourceHandle);
          if (epExt?.portId !== epPortId) continue;
          newEdges.push({
            ...eOut,
            source: prefix + e.source,
            sourceHandle: e.sourceHandle,
          });
        }
        continue;
      }

      // Internal-to-internal: just prefix endpoints
      newEdges.push({
        ...e,
        id: prefix + e.id,
        source: prefix + e.source,
        target: prefix + e.target,
      });
    }
  }

  // Recurse — nested macros will appear as `macro` nodes in newNodes
  return expandMacros(newNodes, newEdges, model, depth + 1);
}

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
      pow: Math.pow,
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

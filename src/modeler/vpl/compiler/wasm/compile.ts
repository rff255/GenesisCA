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

import type { CAModel, GraphNode, GraphEdge } from '../../../../model/types';
import { getNodeDef } from '../../nodes/registry';
import {
  ValType, F64, I32, OP_F64_ABS, OP_F64_ADD, OP_F64_CONVERT_I32_U, OP_F64_DIV,
  OP_F64_EQ, OP_F64_FLOOR, OP_F64_GE, OP_F64_GT, OP_F64_LE, OP_F64_LT,
  OP_F64_MAX, OP_F64_MIN, OP_F64_MUL, OP_F64_NE, OP_F64_SQRT, OP_F64_SUB,
  OP_I32_ADD, OP_I32_AND, OP_I32_EQ, OP_I32_EQZ, OP_I32_GE_S, OP_I32_GT_S,
  OP_I32_LT_S, OP_I32_MUL, OP_I32_OR, OP_I32_SUB, OP_SELECT,
  buildModule, byte, exportEntry, EXPORT_FUNC, funcType, importEntry,
  importFuncDesc, importMemoryDesc, leb128u,
} from './encoder';
import {
  WasmEmitter, ArrayRef, LocalRef, ValueRef, pushValueAs,
} from './emitter';
import type { MemoryLayout } from './layout';
import { classifyLoopInvariant } from '../loopInvariant';
import { getInlineValue, parseInlineNum } from '../inlinePort';

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
const POW_FUNC_IDX = 0;

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
  /** Memoised value-node compile results for this per-cell pass.
   *  Keyed by nodeId → portId → LocalRef. Default port id is 'value'.
   *  Multi-output value nodes (getColorConstant, colorInterpolation,
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
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function attrValType(t: string): ValType {
  return t === 'float' ? F64 : I32;
}

/** Push `i * itemBytes` onto the stack (reads from a cached local; computes + caches if first use). */
function pushCellByteOffset(ctx: WasmCompileCtx, itemBytes: number): void {
  const cached = ctx.byteOffsetLocals.get(itemBytes);
  if (cached !== undefined) {
    ctx.emitter.localGet(cached);
    return;
  }
  // First use: compute i * itemBytes, store in a fresh local, then push it.
  const local = ctx.emitter.allocLocal(I32);
  ctx.emitter.localGet(ctx.iLocalIdx);
  if (itemBytes !== 1) {
    ctx.emitter.i32Const(itemBytes);
    ctx.emitter.op(OP_I32_MUL);
  }
  ctx.emitter.localTee(local);
  ctx.byteOffsetLocals.set(itemBytes, local);
}

/** Emit a load from cell attribute `attr.id` at the current cell index, pushes the value. */
function emitCellRead(ctx: WasmCompileCtx, attr: AttrInfo, useWriteBuffer: boolean): void {
  pushCellByteOffset(ctx, attr.itemBytes);
  const offset = useWriteBuffer ? attr.writeOffset : attr.readOffset;
  if (attr.type === 'bool') ctx.emitter.i32Load8U(offset, 0);
  else if (attr.type === 'float') ctx.emitter.f64Load(offset, 3);
  else ctx.emitter.i32Load(offset, 2);
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

const VALUE_NODE_EMITTERS: Record<string, NodeValueEmitter> = {

  getConstant: ({ node, ctx }) => {
    const t = (node.data.config.constType as string) || 'integer';
    const raw = node.data.config.constValue;
    let num: number;
    if (t === 'bool') {
      num = (raw === 'true' || raw === true || raw === 1) ? 1 : 0;
    } else if (t === 'float') {
      num = typeof raw === 'number' ? raw : (parseFloat(String(raw ?? '0')) || 0);
    } else {
      num = typeof raw === 'number' ? raw : (parseInt(String(raw ?? '0'), 10) || 0);
    }
    if (t === 'float') {
      ctx.emitter.f64Const(num);
      return storeResult(ctx.emitter, F64);
    }
    // bool / integer / tag — i32
    ctx.emitter.i32Const(num | 0);
    return storeResult(ctx.emitter, I32);
  },

  tagConstant: ({ node, ctx }) => {
    const idx = Number(node.data.config.tagIndex) || 0;
    ctx.emitter.i32Const(idx);
    return storeResult(ctx.emitter, I32);
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
            em.emit(byte(0x9b)); // OP_F64_TRUNC
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

  // -- Neighbor by index --
  getNeighborAttributeByIndex: ({ node, ctx, inputs }) => {
    const nbrId = node.data.config.neighborhoodId as string;
    const attrId = node.data.config.attributeId as string;
    const nbr = getNbr(ctx.layout, nbrId);
    const attr = getAttr(ctx.layout, attrId);
    if (!nbr || !attr) { ctx.errors.push(`getNeighborAttributeByIndex: unknown nbr/attr`); return null; }
    const indexRef = inputs['index'] ?? { inline: true, value: 0, valtype: I32 };
    // address into nbr table = nbrOffset + (i*nbrSize + index) * 4
    ctx.emitter.localGet(ctx.iLocalIdx);
    ctx.emitter.i32Const(nbr.size);
    ctx.emitter.op(OP_I32_MUL);
    pushValueAs(ctx.emitter, indexRef, I32);
    ctx.emitter.op(OP_I32_ADD);
    ctx.emitter.i32Const(4);
    ctx.emitter.op(OP_I32_MUL);
    ctx.emitter.i32Load(nbr.offset, 2);  // load neighbor cell idx
    // attr byte offset = nbrCellIdx * itemBytes
    ctx.emitter.i32Const(attr.itemBytes);
    ctx.emitter.op(OP_I32_MUL);
    if (attr.type === 'bool') ctx.emitter.i32Load8U(attr.readOffset, 0);
    else if (attr.type === 'float') ctx.emitter.f64Load(attr.readOffset, 3);
    else ctx.emitter.i32Load(attr.readOffset, 2);
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
    // address = nbrOffset + (i*nbrSize + tagIndex) * 4
    ctx.emitter.localGet(ctx.iLocalIdx);
    ctx.emitter.i32Const(nbr.size);
    ctx.emitter.op(OP_I32_MUL);
    ctx.emitter.i32Const(tagIndex);
    ctx.emitter.op(OP_I32_ADD);
    ctx.emitter.i32Const(4);
    ctx.emitter.op(OP_I32_MUL);
    ctx.emitter.i32Load(nbr.offset, 2);
    ctx.emitter.i32Const(attr.itemBytes);
    ctx.emitter.op(OP_I32_MUL);
    if (attr.type === 'bool') ctx.emitter.i32Load8U(attr.readOffset, 0);
    else if (attr.type === 'float') ctx.emitter.f64Load(attr.readOffset, 3);
    else ctx.emitter.i32Load(attr.readOffset, 2);
    return storeResult(ctx.emitter, attrValType(attr.type));
  },

  // -- groupOperator (multi-output: result + index). --
  groupOperator: ({ node, ctx, inputs }) => {
    return emitAggregateOrCount(ctx, node, inputs, 'groupOperator');
  },

  // -- proportionMap: linear remap from [inMin, inMax] to [outMin, outMax].
  //    Result = ((inMax - inMin) !== 0)
  //      ? outMin + (x - inMin) * (outMax - outMin) / (inMax - inMin)
  //      : outMin
  //    All maths in f64 to match JS Number semantics.
  proportionMap: ({ ctx, inputs }) => {
    const x      = inputs['x']      ?? { inline: true, value: 0, valtype: F64 };
    const inMin  = inputs['inMin']  ?? { inline: true, value: 0, valtype: F64 };
    const inMax  = inputs['inMax']  ?? { inline: true, value: 1, valtype: F64 };
    const outMin = inputs['outMin'] ?? { inline: true, value: 0, valtype: F64 };
    const outMax = inputs['outMax'] ?? { inline: true, value: 1, valtype: F64 };
    // Compute (inMax - inMin) into a local (used twice: zero-check + divisor).
    const inSpan = ctx.emitter.allocLocal(F64);
    pushValueAs(ctx.emitter, inMax, F64);
    pushValueAs(ctx.emitter, inMin, F64);
    ctx.emitter.op(OP_F64_SUB);
    ctx.emitter.localSet(inSpan);
    // Result local
    const result = ctx.emitter.allocLocal(F64);
    // if (inSpan != 0) result = outMin + (x - inMin) * (outMax - outMin) / inSpan
    // else result = outMin
    ctx.emitter.localGet(inSpan);
    ctx.emitter.f64Const(0);
    ctx.emitter.op(OP_F64_NE);
    ctx.emitter.ifThenElse(
      () => {
        // (x - inMin)
        pushValueAs(ctx.emitter, x, F64);
        pushValueAs(ctx.emitter, inMin, F64);
        ctx.emitter.op(OP_F64_SUB);
        // * (outMax - outMin)
        pushValueAs(ctx.emitter, outMax, F64);
        pushValueAs(ctx.emitter, outMin, F64);
        ctx.emitter.op(OP_F64_SUB);
        ctx.emitter.op(OP_F64_MUL);
        // / inSpan
        ctx.emitter.localGet(inSpan);
        ctx.emitter.op(OP_F64_DIV);
        // + outMin
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

  // -- colorInterpolation: Math.round(c1 + t * (c2 - c1)) per channel.
  //    Math.round(x) = floor(x + 0.5) for the values we deal with (positive
  //    color channels in [0, 255]). --
  colorInterpolation: ({ ctx, node, inputs }) => {
    const t  = inputs['t']  ?? { inline: true, value: 0.5, valtype: F64 };
    const r1 = inputs['r1'] ?? { inline: true, value: 0,   valtype: I32 };
    const g1 = inputs['g1'] ?? { inline: true, value: 0,   valtype: I32 };
    const b1 = inputs['b1'] ?? { inline: true, value: 0,   valtype: I32 };
    const r2 = inputs['r2'] ?? { inline: true, value: 255, valtype: I32 };
    const g2 = inputs['g2'] ?? { inline: true, value: 255, valtype: I32 };
    const b2 = inputs['b2'] ?? { inline: true, value: 255, valtype: I32 };
    const tLoc = ctx.emitter.allocLocal(F64);
    pushValueAs(ctx.emitter, t, F64);
    ctx.emitter.localSet(tLoc);
    const emitCh = (c1: ValueRef, c2: ValueRef): LocalRef => {
      // floor(c1 + t * (c2 - c1) + 0.5) → i32
      pushValueAs(ctx.emitter, c1, F64);
      ctx.emitter.localGet(tLoc);
      pushValueAs(ctx.emitter, c2, F64);
      pushValueAs(ctx.emitter, c1, F64);
      ctx.emitter.op(OP_F64_SUB);
      ctx.emitter.op(OP_F64_MUL);
      ctx.emitter.op(OP_F64_ADD);
      ctx.emitter.f64Const(0.5);
      ctx.emitter.op(OP_F64_ADD);
      ctx.emitter.op(OP_F64_FLOOR);
      ctx.emitter.f64ToI32();
      return storeResult(ctx.emitter, I32);
    };
    const rRef = emitCh(r1, r2);
    const gRef = emitCh(g1, g2);
    const bRef = emitCh(b1, b2);
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
      const a = compileArrayNode(firstSrc.nodeId, ctx);
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
    const nLocal = ctx.emitter.allocLocal(I32);
    ctx.emitter.i32Const(0);
    ctx.emitter.localSet(nLocal);
    ctx.emitter.block(() => {
      ctx.emitter.loop(() => {
        ctx.emitter.localGet(nLocal);
        ctx.emitter.i32Const(nbr.size);
        ctx.emitter.op(OP_I32_GE_S);
        ctx.emitter.brIf(1);
        const loadElem = () => {
          ctx.emitter.localGet(ctx.iLocalIdx);
          ctx.emitter.i32Const(nbr.size);
          ctx.emitter.op(OP_I32_MUL);
          ctx.emitter.localGet(nLocal);
          ctx.emitter.op(OP_I32_ADD);
          ctx.emitter.i32Const(4);
          ctx.emitter.op(OP_I32_MUL);
          ctx.emitter.i32Load(nbr.offset, 2);
          ctx.emitter.i32Const(attr.itemBytes);
          ctx.emitter.op(OP_I32_MUL);
          if (attr.type === 'bool') ctx.emitter.i32Load8U(attr.readOffset, 0);
          else if (attr.type === 'float') ctx.emitter.f64Load(attr.readOffset, 3);
          else ctx.emitter.i32Load(attr.readOffset, 2);
        };
        emitCmp(loadElem, elemValtype);
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
    case 'filterNeighbors':
    case 'joinNeighbors':
    case 'getNeighborsAttrByIndexes':
    case 'groupCounting':
      return true;
    default:
      return false;
  }
}

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
    const arr = compileArrayNode(firstSrc.nodeId, ctx);
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
      return emitMedianViaScratchFromNbr(ctx, nbr, attr);
    }
    if (op === 'random') {
      // groupOperator random pick: choose uniform index in [0, size), fetch
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

  // Determine value type for the loaded element
  const elemValtype = attrValType(attr.type);
  const accValtype = (mode === 'count') ? I32 : (op === 'and' || op === 'or') ? I32 : F64;

  // Allocate accumulator + counter
  const accLocal = ctx.emitter.allocLocal(accValtype);
  const nLocal = ctx.emitter.allocLocal(I32);

  // For groupOperator min/max, also track the current best index
  const trackIndex = mode === 'groupOperator' && (op === 'min' || op === 'max');
  const bestIdxLocal = trackIndex ? ctx.emitter.allocLocal(I32) : -1;
  if (trackIndex) {
    ctx.emitter.i32Const(0);
    ctx.emitter.localSet(bestIdxLocal);
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

      // Convert neighbor cell idx -> byte offset into attribute array
      ctx.emitter.i32Const(attr.itemBytes);
      ctx.emitter.op(OP_I32_MUL);
      // Stack: [byte_offset_into_attr]
      // Load from read region
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
            ctx.emitter.localGet(nLocal);
            ctx.emitter.localSet(bestIdxLocal);
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

      // n += 1; br 0 (continue loop)
      ctx.emitter.localGet(nLocal);
      ctx.emitter.i32Const(1);
      ctx.emitter.op(OP_I32_ADD);
      ctx.emitter.localSet(nLocal);
      ctx.emitter.br(0);
    });
  });

  // Average post-divide
  if (op === 'average') {
    ctx.emitter.localGet(accLocal);
    ctx.emitter.f64Const(nbr.size || 1);
    ctx.emitter.op(OP_F64_DIV);
    ctx.emitter.localSet(accLocal);
  }

  if (mode === 'groupOperator' && trackIndex) {
    setCachedPort(ctx, node.id, 'index', { localIdx: bestIdxLocal, valtype: I32 });
    setCachedPort(ctx, node.id, 'result', { localIdx: accLocal, valtype: accValtype });
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
 *  Currently used when mode=aggregate, op=median, source=getNeighborsAttribute. */
function emitMedianViaScratchFromNbr(
  ctx: WasmCompileCtx,
  nbr: NbrInfo,
  attr: AttrInfo,
): LocalRef | null {
  const em = ctx.emitter;
  const elemValtype = F64;
  const elemBytes = 8;
  // Materialise into scratch as f64s
  const lenLocal = em.allocLocal(I32);
  em.i32Const(nbr.size);
  em.localSet(lenLocal);
  const arr = allocArrayInScratch(ctx, lenLocal, elemValtype, elemBytes);
  // Fill: for k=0..n-1: arr[k] = neighbor attr value
  const kLoc = em.allocLocal(I32);
  em.i32Const(0); em.localSet(kLoc);
  em.block(() => {
    em.loop(() => {
      em.localGet(kLoc); em.localGet(lenLocal); em.op(OP_I32_GE_S); em.brIf(1);
      // address: arr.offsetLocal + k*8
      em.localGet(kLoc); em.i32Const(8); em.op(OP_I32_MUL);
      em.localGet(arr.offsetLocal); em.op(OP_I32_ADD);
      // value: load neighbor attr
      em.localGet(ctx.iLocalIdx); em.i32Const(nbr.size); em.op(OP_I32_MUL);
      em.localGet(kLoc); em.op(OP_I32_ADD);
      em.i32Const(4); em.op(OP_I32_MUL);
      em.i32Load(nbr.offset, 2);
      em.i32Const(attr.itemBytes); em.op(OP_I32_MUL);
      if (attr.type === 'bool') em.i32Load8U(attr.readOffset, 0);
      else if (attr.type === 'float') em.f64Load(attr.readOffset, 3);
      else em.i32Load(attr.readOffset, 2);
      if (attr.type !== 'float') em.i32ToF64();
      em.f64Store(0, 3);
      em.localGet(kLoc); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(kLoc);
      em.br(0);
    });
  });
  // Insertion sort in place
  insertionSortF64(ctx, arr);
  // Median: if (n % 2 === 0) (arr[n/2-1] + arr[n/2]) / 2 else arr[(n-1)/2]
  const result = em.allocLocal(F64);
  // Compute parity: (n & 1) == 0
  em.localGet(lenLocal);
  em.i32Const(1); em.op(OP_I32_AND);
  em.op(OP_I32_EQZ);
  em.ifThenElse(
    () => {
      // (arr[n/2-1] + arr[n/2]) / 2
      em.localGet(lenLocal); em.i32Const(2); em.emit(byte(0x6d)); /* OP_I32_DIV_S */
      em.i32Const(1); em.op(OP_I32_SUB);
      em.i32Const(8); em.op(OP_I32_MUL);
      em.localGet(arr.offsetLocal); em.op(OP_I32_ADD);
      em.f64Load(0, 3);
      em.localGet(lenLocal); em.i32Const(2); em.emit(byte(0x6d));
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
      em.i32Const(2); em.emit(byte(0x6d));
      em.i32Const(8); em.op(OP_I32_MUL);
      em.localGet(arr.offsetLocal); em.op(OP_I32_ADD);
      em.f64Load(0, 3);
      em.localSet(result);
    },
  );
  return { localIdx: result, valtype: F64 };
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

  if (mode === 'groupOperator' && trackIndex) {
    setCachedPort(ctx, node.id, 'index', { localIdx: bestIdxLocal, valtype: I32 });
    setCachedPort(ctx, node.id, 'result', { localIdx: accLocal, valtype: accValtype });
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
      ctx.errors.push('groupOperator random pick on multi-source not yet WASM-supported');
      return null;
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

  // Filter: walk input array, keep elements whose nbr-attr passes the comparison.
  filterNeighbors: ({ node, ctx, inputs }) => {
    const nbrId = node.data.config.neighborhoodId as string;
    const attrId = node.data.config.attributeId as string;
    const op = (node.data.config.operation as string) || 'equals';
    const nbr = getNbr(ctx.layout, nbrId);
    const attr = getAttr(ctx.layout, attrId);
    if (!nbr || !attr) { ctx.errors.push(`filterNeighbors: unknown nbr/attr (${nbrId}/${attrId})`); return null; }

    const inArr = resolveInputArray(ctx, node, 'indexes');
    if (!inArr) { ctx.errors.push(`filterNeighbors: no array input on "indexes"`); return null; }
    const compare = inputs['compare'] ?? { inline: true, value: 0, valtype: attrValType(attr.type) };

    // Output: at most inArr.lenLocal entries; allocate the worst-case bytes.
    const outOffsetLocal = ctx.emitter.allocLocal(I32);
    ctx.emitter.localGet(ctx.scratchTopLocal);
    ctx.emitter.localSet(outOffsetLocal);
    // outLen = 0 at start; we count up
    const outLenLocal = ctx.emitter.allocLocal(I32);
    ctx.emitter.i32Const(0); ctx.emitter.localSet(outLenLocal);
    // Reserve scratch up-front (worst case, len * 4 bytes for i32 indices)
    ctx.emitter.localGet(ctx.scratchTopLocal);
    ctx.emitter.localGet(inArr.lenLocal);
    ctx.emitter.i32Const(4); ctx.emitter.op(OP_I32_MUL);
    ctx.emitter.op(OP_I32_ADD);
    ctx.emitter.localSet(ctx.scratchTopLocal);

    const k = ctx.emitter.allocLocal(I32);
    ctx.emitter.i32Const(0); ctx.emitter.localSet(k);
    ctx.emitter.block(() => {
      ctx.emitter.loop(() => {
        ctx.emitter.localGet(k); ctx.emitter.localGet(inArr.lenLocal); ctx.emitter.op(OP_I32_GE_S); ctx.emitter.brIf(1);
        // Load index from input array as i32: indexes[k]
        const idxElem = ctx.emitter.allocLocal(I32);
        ctx.emitter.localGet(k);
        emitArrayLoadElem(ctx.emitter, inArr);
        if (inArr.elemValtype === F64) ctx.emitter.f64ToI32();
        ctx.emitter.localSet(idxElem);
        // Load r_attr[nIdx[idx*nbrSize + idxElem]]
        const loadElem = () => {
          ctx.emitter.localGet(ctx.iLocalIdx);
          ctx.emitter.i32Const(nbr.size);
          ctx.emitter.op(OP_I32_MUL);
          ctx.emitter.localGet(idxElem);
          ctx.emitter.op(OP_I32_ADD);
          ctx.emitter.i32Const(4); ctx.emitter.op(OP_I32_MUL);
          ctx.emitter.i32Load(nbr.offset, 2);
          ctx.emitter.i32Const(attr.itemBytes); ctx.emitter.op(OP_I32_MUL);
          if (attr.type === 'bool') ctx.emitter.i32Load8U(attr.readOffset, 0);
          else if (attr.type === 'float') ctx.emitter.f64Load(attr.readOffset, 3);
          else ctx.emitter.i32Load(attr.readOffset, 2);
        };
        // Compare
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
        ? compileArrayNode(firstSrc.nodeId, ctx) : null;
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
    const attr = getAttr(ctx.layout, srcNode.data.config.attributeId as string);
    if (!nbr || !attr) {
      ctx.errors.push(`groupCounting (array): unknown nbr/attr`);
      return null;
    }
    const elemValtype = attrValType(attr.type);
    const cmpRef = inputs['compare'] ?? { inline: true, value: 0, valtype: elemValtype };
    const cmpHighRef = inputs['compareHigh'] ?? { inline: true, value: 0, valtype: elemValtype };
    const em = ctx.emitter;

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
        // Load nbr value
        em.localGet(ctx.iLocalIdx); em.i32Const(nbr.size); em.op(OP_I32_MUL);
        em.localGet(n); em.op(OP_I32_ADD);
        em.i32Const(4); em.op(OP_I32_MUL);
        em.i32Load(nbr.offset, 2);
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

  // Read neighbor attribute values for a list of nbr-table indices.
  getNeighborsAttrByIndexes: ({ node, ctx }) => {
    const nbrId = node.data.config.neighborhoodId as string;
    const attrId = node.data.config.attributeId as string;
    const nbr = getNbr(ctx.layout, nbrId);
    const attr = getAttr(ctx.layout, attrId);
    if (!nbr || !attr) { ctx.errors.push(`getNeighborsAttrByIndexes: unknown nbr/attr`); return null; }
    const inArr = resolveInputArray(ctx, node, 'indexes');
    if (!inArr) { ctx.errors.push(`getNeighborsAttrByIndexes: no input on "indexes"`); return null; }

    const elemValtype = attrValType(attr.type);
    const elemBytes = attr.itemBytes;
    const outArr = allocArrayInScratch(ctx, inArr.lenLocal, elemValtype, elemBytes);

    const k = ctx.emitter.allocLocal(I32);
    ctx.emitter.i32Const(0); ctx.emitter.localSet(k);
    ctx.emitter.block(() => {
      ctx.emitter.loop(() => {
        ctx.emitter.localGet(k); ctx.emitter.localGet(inArr.lenLocal); ctx.emitter.op(OP_I32_GE_S); ctx.emitter.brIf(1);
        // Load idxIn = inArr[k]
        const idxIn = ctx.emitter.allocLocal(I32);
        ctx.emitter.localGet(k); emitArrayLoadElem(ctx.emitter, inArr);
        if (inArr.elemValtype === F64) ctx.emitter.f64ToI32();
        ctx.emitter.localSet(idxIn);
        // out[k] = r_attr[nIdx[idx*nbrSize + idxIn]]
        // Out address
        ctx.emitter.localGet(k);
        if (elemBytes !== 1) { ctx.emitter.i32Const(elemBytes); ctx.emitter.op(OP_I32_MUL); }
        ctx.emitter.localGet(outArr.offsetLocal); ctx.emitter.op(OP_I32_ADD);
        // Load value
        ctx.emitter.localGet(ctx.iLocalIdx);
        ctx.emitter.i32Const(nbr.size); ctx.emitter.op(OP_I32_MUL);
        ctx.emitter.localGet(idxIn); ctx.emitter.op(OP_I32_ADD);
        ctx.emitter.i32Const(4); ctx.emitter.op(OP_I32_MUL);
        ctx.emitter.i32Load(nbr.offset, 2);
        ctx.emitter.i32Const(attr.itemBytes); ctx.emitter.op(OP_I32_MUL);
        if (attr.type === 'bool') ctx.emitter.i32Load8U(attr.readOffset, 0);
        else if (attr.type === 'float') ctx.emitter.f64Load(attr.readOffset, 3);
        else ctx.emitter.i32Load(attr.readOffset, 2);
        // Store
        if (elemBytes === 1) ctx.emitter.i32Store8(0, 0);
        else if (elemValtype === F64) ctx.emitter.f64Store(0, 3);
        else ctx.emitter.i32Store(0, 2);
        ctx.emitter.localGet(k); ctx.emitter.i32Const(1); ctx.emitter.op(OP_I32_ADD); ctx.emitter.localSet(k);
        ctx.emitter.br(0);
      });
    });
    return outArr;
  },
};

/**
 * Resolve an input port to an ArrayRef. The input must be wired to an
 * array-producing node. Returns null if not (consumers should report error).
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
  return compileArrayNode(src.nodeId, ctx);
}

/**
 * Compile (or look up cached) the array result of an array-producing node.
 * Returns null on error.
 */
function compileArrayNode(nodeId: string, ctx: WasmCompileCtx): ArrayRef | null {
  const cached = ctx.arrayRefs.get(nodeId);
  if (cached) return cached;

  const node = ctx.nodeMap.get(nodeId);
  if (!node) { ctx.errors.push(`unknown array node ${nodeId}`); return null; }

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
          const isFloat = port.dataType === 'float';
          inputs[port.id] = { inline: true, value: num, valtype: isFloat ? F64 : I32 };
        }
      }
    }
  }

  const result = emitter({ ctx, node, inputs });
  if (!result) return null;
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

  // -- setNeighborAttributeByIndex (async-only): writes a value to one or more
  //    neighbours' attribute. Index input may be a scalar (write to one) or an
  //    ArrayRef (write to each). Sentinel guard `nIdx < total` protects the
  //    constant-boundary slot.
  setNeighborAttributeByIndex: ({ node, ctx, inputs }) => {
    const nbrId = node.data.config.neighborhoodId as string;
    const attrId = node.data.config.attributeId as string;
    const nbr = getNbr(ctx.layout, nbrId);
    const attr = getAttr(ctx.layout, attrId);
    if (!nbr || !attr) {
      ctx.errors.push(`setNeighborAttributeByIndex: unknown nbr/attr (${nbrId}/${attrId})`);
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
        indexArr = compileArrayNode(indexSrc.nodeId, ctx);
      }
    }

    const writeOne = (pushNbrIdx: () => void) => {
      const nbrCellLocal = ctx.emitter.allocLocal(I32);
      ctx.emitter.localGet(ctx.iLocalIdx);
      ctx.emitter.i32Const(nbr.size);
      ctx.emitter.op(OP_I32_MUL);
      pushNbrIdx();
      ctx.emitter.op(OP_I32_ADD);
      ctx.emitter.i32Const(4);
      ctx.emitter.op(OP_I32_MUL);
      ctx.emitter.i32Load(nbr.offset, 2);
      ctx.emitter.localSet(nbrCellLocal);
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
  const inputs: Record<string, ValueRef | undefined> = {};
  for (const port of def.ports) {
    if (port.kind !== 'input' || port.category !== 'value') continue;
    if (port.isArray) continue;
    const source = ctx.inputToSource.get(`${nodeId}:${port.id}`);
    if (source) {
      const srcRef = compileValueNode(source.nodeId, ctx, source.portId);
      if (!srcRef) return null;
      inputs[port.id] = srcRef;
    } else {
      const inlineVal = getInlineValue(port, node.data.config);
      if (inlineVal !== undefined) {
        const num = parseInlineNum(inlineVal);
        const isFloat = port.dataType === 'float';
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
 * Walk the flow chain reachable from `entryNode:do` and emit every value node
 * those branches reference. After this pre-pass, the actual flow-chain emission
 * only needs `localGet`s. Mirrors the JS compiler's two-pass strategy.
 */
function preEmitValueNodes(ctx: WasmCompileCtx, entryNode: GraphNode): void {
  const visited = new Set<string>();
  const visitValue = (nodeId: string) => {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    const node = ctx.nodeMap.get(nodeId);
    if (!node) return;
    // Entry-point nodes don't compile to value emitters — their value outputs
    // (e.g. inputColor's r/g/b) come from function params and are picked up
    // via paramRefs at consume time.
    if (node.data.nodeType === 'inputColor'
        || node.data.nodeType === 'step'
        || node.data.nodeType === 'outputMapping') return;
    const t = node.data.nodeType;
    const hasArrayEmitter = !!ARRAY_NODE_EMITTERS[t];
    const hasValueEmitter = !!VALUE_NODE_EMITTERS[t];
    // Hybrid nodes (groupCounting has both `count` scalar and `indexes` array
    // outputs) need both views hoisted so subsequent consumers find cached
    // results regardless of which port they wire.
    if (hasValueEmitter) compileValueNode(nodeId, ctx);
    if (hasArrayEmitter) compileArrayNode(nodeId, ctx);
  };
  const visitFlow = (srcId: string, portId: string, seen: Set<string>) => {
    const targets = ctx.flowOutputToTargets.get(`${srcId}:${portId}`) ?? [];
    for (const t of targets) {
      const node = ctx.nodeMap.get(t.nodeId);
      if (!node) continue;
      const def = getNodeDef(node.data.nodeType);
      if (!def) continue;
      // Visit value inputs of this flow node (single + multi-source)
      for (const port of def.ports) {
        if (port.kind !== 'input' || port.category !== 'value') continue;
        const src = ctx.inputToSource.get(`${t.nodeId}:${port.id}`);
        if (src) visitValue(src.nodeId);
        const srcs = ctx.inputToSources.get(`${t.nodeId}:${port.id}`);
        if (srcs) for (const s of srcs) visitValue(s.nodeId);
      }
      // Recurse into flow children
      const flowKey = `${t.nodeId}:`;
      if (seen.has(flowKey)) continue; // cycle guard
      seen.add(flowKey);
      switch (node.data.nodeType) {
        case 'conditional':
          visitFlow(t.nodeId, 'then', seen);
          visitFlow(t.nodeId, 'else', seen);
          break;
        case 'sequence':
          visitFlow(t.nodeId, 'first', seen);
          visitFlow(t.nodeId, 'then', seen);
          break;
        case 'loop':
          visitFlow(t.nodeId, 'body', seen);
          break;
        case 'switch': {
          const caseCount = Number(node.data.config.caseCount) || 0;
          for (let ci = 0; ci < caseCount; ci++) {
            visitFlow(t.nodeId, `case_${ci}`, seen);
            // Switch in 'value' mode also reads case_*_val ports
            const caseValSrc = ctx.inputToSource.get(`${t.nodeId}:case_${ci}_val`);
            if (caseValSrc) visitValue(caseValSrc.nodeId);
            const caseCondSrc = ctx.inputToSource.get(`${t.nodeId}:case_${ci}_cond`);
            if (caseCondSrc) visitValue(caseCondSrc.nodeId);
          }
          visitFlow(t.nodeId, 'default', seen);
          // Switch in 'value' mode also reads its 'value' input
          const valSrc = ctx.inputToSource.get(`${t.nodeId}:value`);
          if (valSrc) visitValue(valSrc.nodeId);
          break;
        }
      }
    }
  };
  visitFlow(entryNode.id, 'do', new Set());
}

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
          () => { compileFlowChain(node.id, 'then', ctx); },
          () => { compileFlowChain(node.id, 'else', ctx); },
        );
      } else {
        ctx.emitter.ifThen(() => { compileFlowChain(node.id, 'then', ctx); });
      }
    } else if (node.data.nodeType === 'sequence') {
      compileFlowChain(node.id, 'first', ctx);
      compileFlowChain(node.id, 'then', ctx);
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
          compileFlowChain(node.id, 'body', ctx);
          // li++; br loop
          ctx.emitter.localGet(li);
          ctx.emitter.i32Const(1);
          ctx.emitter.op(OP_I32_ADD);
          ctx.emitter.localSet(li);
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
              return compileFlowChain(node.id, 'default', ctx);
            }
            return true;
          }
          pushValueAs(ctx.emitter, caseConds[ci]!, I32);
          ctx.emitter.ifThenElse(
            () => { compileFlowChain(node.id, `case_${ci}`, ctx); },
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
            compileFlowChain(node.id, `case_${ci}`, ctx);
          });
        }
        if (hasDefault) {
          ctx.emitter.localGet(matched);
          ctx.emitter.op(OP_I32_EQZ);
          ctx.emitter.ifThen(() => {
            compileFlowChain(node.id, 'default', ctx);
          });
        }
      }
    } else {
      // Regular flow node: resolve scalar value inputs (skip arrays; flow
      // emitters that consume arrays — setNeighborAttributeByIndex with array
      // index input — fetch the ArrayRef themselves via compileArrayNode).
      const inputs: Record<string, ValueRef | undefined> = {};
      for (const port of def.ports) {
        if (port.kind !== 'input' || port.category !== 'value') continue;
        if (port.isArray) continue;
        const source = ctx.inputToSource.get(`${node.id}:${port.id}`);
        if (source) {
          const srcRef = compileValueNode(source.nodeId, ctx, source.portId);
          if (!srcRef) return false;
          inputs[port.id] = srcRef;
        } else {
          const inlineVal = getInlineValue(port, node.data.config);
          if (inlineVal !== undefined) {
            const num = parseInlineNum(inlineVal);
            const isFloat = port.dataType === 'float';
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
  };

  // Snapshot of value-local refs that are loop-invariant. Populated after the
  // pre-loop emission pass. Per-cell emitBody clears valueLocals (cell-dependent
  // refs would be stale) then restores these so subsequent compileValueNode
  // calls hit the cache and skip re-emission.
  const invariantSnapshot = new Map<string, Map<string, LocalRef>>();

  const emitBody = () => {
    // Reset per-cell caches and scratch pointer
    ctx.byteOffsetLocals.clear();
    ctx.valueLocals.clear();
    ctx.arrayRefs.clear();
    emitter.i32Const(layout.scratchOffset);
    emitter.localSet(scratchTopLocal);

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

    // Per-cell copy (sync mode only). For loop entries (Step), this is hoisted
    // to a single bulk memory.copy before the loop — see emitBulkCopyLines below.
    // For single-shot entries (InputColor), keep the per-cell copy: only one
    // cell is touched per call, so a bulk copy of the whole grid would be wrong.
    if (!opts.hasLoop && opts.emitCopyLines && !layout.isAsync) {
      for (const id of Object.keys(layout.attrType)) {
        const a = getAttr(layout, id)!;
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
    }

    preEmitValueNodes(ctx, opts.entry);
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
      const a = getAttr(layout, id)!;
      // memory.copy stack signature: [dst, src, n]
      emitter.i32Const(a.writeOffset);
      emitter.i32Const(a.readOffset);
      emitter.i32Const(cellsPerAttr * a.itemBytes);
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
          case 'sequence':
            visitFlow(t.nodeId, 'first', seen);
            visitFlow(t.nodeId, 'then', seen);
            break;
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
    emitInvariantValueNodes();
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
  const stepRes = compileEntry(
    {
      entry: stepNode,
      numParams: 1,
      iLocalSource: 'param0WithLoop',
      hasLoop: true,
      emitCopyLines: true,
      useOrderArrayInAsync: true,
    },
    layout, viewerIds, model, nodeMap, inputToSource, inputToSources, flowOutputToTargets, loopInvariant,
  );
  allErrors.push(...stepRes.errors);
  exportEntries.push({ name: 'step', typeIdx: TYPE_IDX_TOTAL, body: stepRes.body });

  // OutputMapping (one per mapping) — always sequential, no copy lines.
  for (const om of outputMappingNodes) {
    const mappingId = (om.data.config.mappingId as string) || '';
    const omRes = compileEntry(
      {
        entry: om,
        numParams: 1,
        iLocalSource: 'param0WithLoop',
        hasLoop: true,
        emitCopyLines: false,
        useOrderArrayInAsync: false,
      },
      layout, viewerIds, model, nodeMap, inputToSource, inputToSources, flowOutputToTargets, loopInvariant,
    );
    allErrors.push(...omRes.errors);
    exportEntries.push({ name: `outputMapping_${sanitiseExportName(mappingId)}`, typeIdx: TYPE_IDX_TOTAL, body: omRes.body });
  }

  // InputColor (one per mapping) — single cell, no loop. Per-cell preamble
  // still needs copy lines (so subsequent step sees the painted state).
  for (const ic of inputColorNodes) {
    const mappingId = (ic.data.config.mappingId as string) || '';
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
      layout, viewerIds, model, nodeMap, inputToSource, inputToSources, flowOutputToTargets, loopInvariant,
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

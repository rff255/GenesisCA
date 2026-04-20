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
 * Per-node emit dispatch is in the VALUE_NODE_EMITTERS / FLOW_NODE_EMITTERS
 * tables. Adding support for a new node type means: add an emit function
 * here, register it. If a graph references an unsupported node, compileGraphWasm
 * returns an error and the worker falls back to the JS step function.
 */

import type { CAModel, GraphNode, GraphEdge } from '../../../../model/types';
import { getNodeDef } from '../../nodes/registry';
import type { PortDef } from '../../types';
import {
  ValType, F64, I32, OP_F64_ADD, OP_F64_DIV, OP_F64_EQ, OP_F64_GE, OP_F64_GT,
  OP_F64_LE, OP_F64_LT, OP_F64_MAX, OP_F64_MIN, OP_F64_MUL, OP_F64_NE, OP_F64_SUB,
  OP_I32_ADD, OP_I32_AND, OP_I32_EQ, OP_I32_EQZ, OP_I32_GE_S,
  OP_I32_MUL, OP_I32_OR, OP_I32_SUB,
  buildModule, byte, exportEntry, EXPORT_FUNC, funcType, importEntry,
  importMemoryDesc, leb128u,
} from './encoder';
import {
  WasmEmitter, LocalRef, ValueRef, pushValueAs,
} from './emitter';
import type { MemoryLayout } from './layout';

export interface WasmCompileResult {
  bytes: Uint8Array;
  minMemoryPages: number;
  error?: string;
  viewerIds: Record<string, number>;
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
    case '<':  return OP_I32_LT_S_OP;
    case '<=': return OP_I32_LE_S_OP;
    case '>':  return OP_I32_GT_S_OP;
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
const OP_I32_LT_S_OP = byte(0x48);
const OP_I32_LE_S_OP = byte(0x4c);
const OP_I32_GT_S_OP = byte(0x4a);

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
  /** Memoised value-node compile results for this per-cell pass. */
  valueLocals: Map<string, LocalRef>;
  /** Cached `i * itemBytes` locals keyed by itemBytes. */
  byteOffsetLocals: Map<number, number>;
  /** Adjacency. */
  nodeMap: Map<string, GraphNode>;
  inputToSource: Map<string, { nodeId: string; portId: string }>;
  inputToSources: Map<string, Array<{ nodeId: string; portId: string }>>;
  flowOutputToTargets: Map<string, Array<{ nodeId: string; portId: string }>>;
  /** Errors encountered (unsupported nodes, etc.) — non-empty means compile failed. */
  errors: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getInlineValue(port: PortDef, config: Record<string, string | number | boolean>): string | undefined {
  if (!port.inlineWidget) return undefined;
  const configKey = `_port_${port.id}`;
  const val = config[configKey];
  if (val === undefined || val === '') return port.defaultValue;
  const s = String(val);
  if (port.inlineWidget === 'bool') return s === 'true' ? '1' : '0';
  return s;
}

/**
 * Parse an inline-widget string into a numeric value. Handles the same coercions
 * the JS compiler gets for free by emitting raw expressions: 'true' / 'false'
 * become 1 / 0 (the SetAttribute number widget can carry these strings if the
 * underlying attribute is bool), numeric strings parse via parseFloat, anything
 * else falls back to 0. Used everywhere an inline port value is materialised
 * into a constant for WASM emission.
 */
function parseInlineNum(raw: string | undefined, fallback: number = 0): number {
  if (raw === undefined) return fallback;
  if (raw === 'true') return 1;
  if (raw === 'false') return 0;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

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
  if (itemBytes === 1) {
    // No multiplication needed
  } else {
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

// ---------------------------------------------------------------------------
// Per-node value emitters
// ---------------------------------------------------------------------------

interface NodeEmitContext {
  ctx: WasmCompileCtx;
  node: GraphNode;
  inputs: Record<string, ValueRef | undefined>;
}

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
      // Color attribute is multi-output via _v{id}_r/_g/_b — handled by flow consumers
      // Here we just return one slot for the requested channel (config decides).
      ctx.errors.push(`getModelAttribute color split not yet supported in WASM (${attrId})`);
      return null;
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
    switch (op) {
      case '+':
        pushValueAs(ctx.emitter, x, F64);
        pushValueAs(ctx.emitter, y, F64);
        ctx.emitter.op(OP_F64_ADD);
        break;
      case '-':
        pushValueAs(ctx.emitter, x, F64);
        pushValueAs(ctx.emitter, y, F64);
        ctx.emitter.op(OP_F64_SUB);
        break;
      case '*':
        pushValueAs(ctx.emitter, x, F64);
        pushValueAs(ctx.emitter, y, F64);
        ctx.emitter.op(OP_F64_MUL);
        break;
      case '/':
      case '%':
        // The JS impl guards: y !== 0 ? x/y : 0. Without f64 host-side helpers
        // we'd need an `if/else` pushing 0 or x/y. WASM has f64.div but not
        // f64.rem; for `%` we'd need an import. Defer for now.
        ctx.errors.push(`arithmeticOperator: ${op} not yet WASM-supported (needs zero-guard / rem helper)`);
        return null;
      case 'max':
        pushValueAs(ctx.emitter, x, F64);
        pushValueAs(ctx.emitter, y, F64);
        ctx.emitter.op(OP_F64_MAX);
        break;
      case 'min':
        pushValueAs(ctx.emitter, x, F64);
        pushValueAs(ctx.emitter, y, F64);
        ctx.emitter.op(OP_F64_MIN);
        break;
      case 'mean':
        pushValueAs(ctx.emitter, x, F64);
        pushValueAs(ctx.emitter, y, F64);
        ctx.emitter.op(OP_F64_ADD);
        ctx.emitter.f64Const(2);
        ctx.emitter.op(OP_F64_DIV);
        break;
      case 'sqrt':
      case 'pow':
      case 'abs':
        // These need imported Math.* helpers; not yet wired.
        ctx.errors.push(`arithmeticOperator: ${op} requires Math import (not yet wired)`);
        return null;
      default:
        ctx.errors.push(`arithmeticOperator: unsupported op ${op}`);
        return null;
    }
    return storeResult(ctx.emitter, F64);
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
    pushValueAs(ctx.emitter, a, I32);
    pushValueAs(ctx.emitter, b, I32);
    switch (op) {
      case 'AND': ctx.emitter.op(OP_I32_AND); break;
      case 'OR':  ctx.emitter.op(OP_I32_OR); break;
      case 'XOR': {
        // a !== 0 XOR b !== 0  →  (a != 0) ^ (b != 0)
        // We had pushed a,b directly; turn into a!=0 and b!=0 via local trick.
        // Simpler: re-emit. For XOR, compute (a!=0) != (b!=0).
        // Since we already pushed a,b, the OP_I32_XOR yields bitwise XOR — not
        // what we want for booleans. Truncate to 0/1 via != 0 then xor.
        ctx.errors.push('logicOperator XOR: not yet supported in WASM (need normalization)');
        return null;
      }
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
    // We skip the >>> 0 since I32 is uint32 in WASM-as-bits and we treat it as such for ops.
    // Step 1: _rs ^= _rs << 13
    ctx.emitter.localGet(rsLocal);
    ctx.emitter.localGet(rsLocal);
    ctx.emitter.i32Const(13);
    ctx.emitter.op(OP_I32_SHL);
    ctx.emitter.op(OP_I32_XOR);
    ctx.emitter.localSet(rsLocal);
    // Step 2: _rs ^= _rs >>> 17
    ctx.emitter.localGet(rsLocal);
    ctx.emitter.localGet(rsLocal);
    ctx.emitter.i32Const(17);
    ctx.emitter.op(OP_I32_SHR_U);
    ctx.emitter.op(OP_I32_XOR);
    ctx.emitter.localSet(rsLocal);
    // Step 3: _rs ^= _rs << 5
    ctx.emitter.localGet(rsLocal);
    ctx.emitter.localGet(rsLocal);
    ctx.emitter.i32Const(5);
    ctx.emitter.op(OP_I32_SHL);
    ctx.emitter.op(OP_I32_XOR);
    ctx.emitter.localSet(rsLocal);
    // Store back to memory
    ctx.emitter.i32Const(0);
    ctx.emitter.localGet(rsLocal);
    ctx.emitter.i32Store(ctx.layout.rngStateOffset, 2);

    // Compute float value: (_rs >>> 0) / 2^32, where >>> 0 is implicit because i32->f64 of i32 values
    // is signed; we need unsigned. Use f64 trick: convert via bitwise & 0xFFFFFFFF then to f64.
    // WASM has F64_CONVERT_I32_U (opcode 0xb8) — we should use that.
    // But our encoder doesn't expose it. Workaround: split into two halves or use the fact that
    // (i32 as f64 + 4294967296) % 4294967296 gives unsigned conversion. Slower.
    // Easier: emit f64.convert_i32_u directly.
    // Add OP_F64_CONVERT_I32_U if missing.
    ctx.emitter.localGet(rsLocal);
    ctx.emitter.emit(byte(0xb8)); // f64.convert_i32_u
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
      // Truncate via f64 -> i32 (floor for positive)
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

  // -- groupOperator (multi-output: result + index). Currently emits the
  //    `result` only; if a downstream node consumes `index` it'll get the
  //    same local — which is wrong, but rare in practice. Defer multi-output
  //    porting until we hit a model that needs it.
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

  // -- groupStatement: tests an assertion across an array (allIs / noneIs /
  //    hasA / allGreater / anyGreater / allLesser / anyLesser). Result is bool.
  //    Like groupCounting it prefers the single-source getNeighborsAttribute
  //    path; multi-source scalar-only is also supported via the same loop
  //    structure but with all-vs-any short-circuit.
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
 * Implementation pattern (matches the existing aggregate pattern):
 *   - For getNeighborsAttribute source: loop over the neighbor index table.
 *   - Otherwise: visit each scalar source via compileValueNode.
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
  } else {
    // Multi-scalar path
    let elemValtype: ValType = I32;
    const refs: LocalRef[] = [];
    for (const s of sources) {
      const r = compileValueNode(s.nodeId, ctx);
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
// Aggregate / GroupCounting shared implementation
// Both consume an "array" — typically from getNeighborsAttribute (a phantom
// LocalRef with localIdx=-1). For now we ONLY support that path; multi-source
// array literals fall back to JS.
// ---------------------------------------------------------------------------

function emitAggregateOrCount(
  ctx: WasmCompileCtx,
  node: GraphNode,
  inputs: Record<string, ValueRef | undefined>,
  mode: 'aggregate' | 'count' | 'groupOperator',
): LocalRef | null {
  // Find the sources feeding the input port. Two shapes are supported:
  //   1) Single getNeighborsAttribute → loop over the neighbor index table.
  //   2) N scalar sources → each compiles to one value; combine sequentially.
  // A getCellAttribute / getModelAttribute / etc. as a single source is the
  // degenerate scalar case (loop iterates once).
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
    if (op === 'random') {
      ctx.errors.push('groupOperator random pick: not yet WASM-supported');
      return null;
    }
  }

  // Determine value type for the loaded element
  const elemValtype = attrValType(attr.type);
  const accValtype = (mode === 'count') ? I32 : (op === 'and' || op === 'or') ? I32 : F64;

  // Allocate accumulator + counter
  const accLocal = ctx.emitter.allocLocal(accValtype);
  const nLocal = ctx.emitter.allocLocal(I32);

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
    cmpRef = inputs['compare'] ?? { inline: true, value: 1, valtype: elemValtype };
    if (countCmpOp === 'between' || countCmpOp === 'notBetween') {
      cmpHighRef = inputs['compareHigh'] ?? { inline: true, value: 1, valtype: elemValtype };
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
        const emitCmp = (op: string, ref: ValueRef) => {
          ctx.emitter.localGet(elemLocal);
          pushValueAs(ctx.emitter, ref, elemValtype);
          if (elemValtype === F64) ctx.emitter.op(cmpToF64Op(op));
          else ctx.emitter.op(cmpToI32Op(op));
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

  return { localIdx: accLocal, valtype: accValtype };
}

/**
 * Multi-source aggregate: each source is a scalar value (or itself an array,
 * but for now we only support scalars here — getNeighborsAttribute as one of
 * many sources isn't yet flattened). Each scalar is computed via
 * compileValueNode and combined into a single accumulator using the operation.
 *
 * Used when an aggregate / groupCounting / groupOperator node has multiple
 * incoming edges on its `values` (isArray) port. The single-source path with
 * a getNeighborsAttribute source keeps using the cell-loop optimisation in
 * the main `emitAggregateOrCount`.
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
    const r = compileValueNode(s.nodeId, ctx);
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
      ctx.errors.push('groupOperator random pick: not yet WASM-supported');
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
        const r = compileValueNode(e.nodeId, ctx);
        if (r) { elemValtype = r.valtype; return r; }
      }
      return { inline: true, value: 1, valtype: elemValtype };
    })();
    if (countCmpOp === 'between' || countCmpOp === 'notBetween') {
      const e = ctx.inputToSource.get(`${node.id}:compareHigh`);
      if (e) {
        const r = compileValueNode(e.nodeId, ctx);
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
    // if (activeViewer == viewerInt) { write rgba }
    ctx.emitter.i32Const(0);
    ctx.emitter.i32Load(ctx.layout.activeViewerOffset, 2);
    ctx.emitter.i32Const(viewerInt);
    ctx.emitter.op(OP_I32_EQ);
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

  updateIndicator: ({ node, ctx, inputs }) => {
    const idxRaw = node.data.config._indicatorIdx;
    const idx = Number(idxRaw ?? -1);
    const id = ctx.layout.indicatorIds[idx];
    if (!id) { ctx.errors.push(`updateIndicator: bad index ${idx}`); return false; }
    const off = ctx.layout.indicatorOffset[id]!;
    const op = (node.data.config.operation as string) || 'increment';
    const v = inputs['value'];
    // Stack pattern: [storeAddr, currentValue, otherValue?] then op then store
    ctx.emitter.i32Const(0);  // store address
    ctx.emitter.i32Const(0);  // load address
    ctx.emitter.f64Load(off, 3);  // current value
    switch (op) {
      case 'increment':
        if (!v) { ctx.errors.push('updateIndicator increment: missing value'); return false; }
        pushValueAs(ctx.emitter, v, F64);
        ctx.emitter.op(OP_F64_ADD);
        break;
      case 'decrement':
        if (!v) { ctx.errors.push('updateIndicator decrement: missing value'); return false; }
        pushValueAs(ctx.emitter, v, F64);
        ctx.emitter.op(OP_F64_SUB);
        break;
      case 'max':
        if (!v) { ctx.errors.push('updateIndicator max: missing value'); return false; }
        pushValueAs(ctx.emitter, v, F64);
        ctx.emitter.op(OP_F64_MAX);
        break;
      case 'min':
        if (!v) { ctx.errors.push('updateIndicator min: missing value'); return false; }
        pushValueAs(ctx.emitter, v, F64);
        ctx.emitter.op(OP_F64_MIN);
        break;
      case 'toggle':
        // value = (cur ? 0 : 1) for bool — but we operate on f64. Use cur != 0 ? 0 : 1.
        ctx.emitter.f64Const(0);
        ctx.emitter.op(OP_F64_NE);  // i32 result
        ctx.emitter.op(OP_I32_EQZ);
        ctx.emitter.i32ToF64();
        break;
      default:
        ctx.errors.push(`updateIndicator: unsupported op ${op}`);
        return false;
    }
    ctx.emitter.f64Store(off, 3);
    return true;
  },

  updateAttribute: ({ node, ctx, inputs }) => {
    const attrId = node.data.config.attributeId as string;
    const op = (node.data.config.operation as string) || 'increment';
    const attr = getAttr(ctx.layout, attrId);
    if (!attr) { ctx.errors.push(`updateAttribute: unknown attr ${attrId}`); return false; }
    const v = inputs['value'];
    // Read current value from WRITE buffer (matches JS read-modify-write semantics)
    pushCellByteOffset(ctx, attr.itemBytes);  // address for store
    pushCellByteOffset(ctx, attr.itemBytes);  // address for load
    if (attr.type === 'bool') ctx.emitter.i32Load8U(attr.writeOffset, 0);
    else if (attr.type === 'float') ctx.emitter.f64Load(attr.writeOffset, 3);
    else ctx.emitter.i32Load(attr.writeOffset, 2);
    // Now stack: [storeAddr, currentValue]

    const t = attr.type;
    const isF = t === 'float';

    switch (op) {
      case 'increment':
        if (!v) { ctx.errors.push('updateAttribute increment: missing value'); return false; }
        pushValueAs(ctx.emitter, v, isF ? F64 : I32);
        ctx.emitter.op(isF ? OP_F64_ADD : OP_I32_ADD);
        break;
      case 'decrement':
        if (!v) { ctx.errors.push('updateAttribute decrement: missing value'); return false; }
        pushValueAs(ctx.emitter, v, isF ? F64 : I32);
        ctx.emitter.op(isF ? OP_F64_SUB : OP_I32_SUB);
        break;
      case 'max':
        if (!v) { ctx.errors.push('updateAttribute max: missing value'); return false; }
        pushValueAs(ctx.emitter, v, isF ? F64 : I32);
        if (isF) ctx.emitter.op(OP_F64_MAX);
        else { ctx.errors.push('updateAttribute max for non-float not yet WASM-supported'); return false; }
        break;
      case 'min':
        if (!v) { ctx.errors.push('updateAttribute min: missing value'); return false; }
        pushValueAs(ctx.emitter, v, isF ? F64 : I32);
        if (isF) ctx.emitter.op(OP_F64_MIN);
        else { ctx.errors.push('updateAttribute min for non-float not yet WASM-supported'); return false; }
        break;
      case 'toggle':
        // Bool only: 1 - current
        ctx.emitter.i32Const(1);
        ctx.emitter.op(OP_I32_XOR);
        break;
      default:
        ctx.errors.push(`updateAttribute: unsupported op ${op}`);
        return false;
    }

    if (attr.type === 'bool') ctx.emitter.i32Store8(attr.writeOffset, 0);
    else if (attr.type === 'float') ctx.emitter.f64Store(attr.writeOffset, 3);
    else ctx.emitter.i32Store(attr.writeOffset, 2);
    return true;
  },

  // -- setNeighborAttributeByIndex (async-only): writes a value to a single
  //    neighbour's attribute. Index input is treated as a SCALAR here (the JS
  //    impl branches on Array.isArray to handle list-input cases, but those
  //    only flow from filterNeighbors / getNeighborIndexesByTags / etc. which
  //    aren't yet WASM-supported anyway). The constant-boundary sentinel
  //    cell at index `total` is protected by the same `nIdx < total` guard
  //    the JS impl uses.
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
      // JS-side compiler accepts this in sync mode but the per-cell copy
      // overwrites the neighbour write at the start of the next cell's
      // iteration, so it never produces useful results — treat as an error.
      ctx.errors.push(`setNeighborAttributeByIndex: requires asynchronous update mode`);
      return false;
    }
    const indexRef = inputs['index'] ?? { inline: true, value: 0, valtype: I32 };
    const valueRef = inputs['value'] ?? { inline: true, value: 0, valtype: F64 };
    // Compute neighbour cell index: nIdx[i*nbrSize + index] from the table.
    const nbrCellLocal = ctx.emitter.allocLocal(I32);
    ctx.emitter.localGet(ctx.iLocalIdx);
    ctx.emitter.i32Const(nbr.size);
    ctx.emitter.op(OP_I32_MUL);
    pushValueAs(ctx.emitter, indexRef, I32);
    ctx.emitter.op(OP_I32_ADD);
    ctx.emitter.i32Const(4);
    ctx.emitter.op(OP_I32_MUL);
    ctx.emitter.i32Load(nbr.offset, 2);
    ctx.emitter.localSet(nbrCellLocal);
    // Guard: only write when nbrCell < total (skip constant-boundary sentinel).
    ctx.emitter.localGet(nbrCellLocal);
    ctx.emitter.localGet(0); // total param
    ctx.emitter.op(OP_I32_LT_S_OP);
    ctx.emitter.ifThen(() => {
      // address = nbrCell * itemBytes
      ctx.emitter.localGet(nbrCellLocal);
      if (attr.itemBytes !== 1) {
        ctx.emitter.i32Const(attr.itemBytes);
        ctx.emitter.op(OP_I32_MUL);
      }
      pushValueAs(ctx.emitter, valueRef, attrValType(attr.type));
      // In async mode read/write share the same offset, but emitting as
      // writeOffset keeps semantic clarity and works either way.
      if (attr.type === 'bool') ctx.emitter.i32Store8(attr.writeOffset, 0);
      else if (attr.type === 'float') ctx.emitter.f64Store(attr.writeOffset, 3);
      else ctx.emitter.i32Store(attr.writeOffset, 2);
    });
    return true;
  },
};

// Add OP_I32_SHL / SHR_U / XOR which encoder.ts has but not as exported byte constants — re-export here
// Actually they're already in encoder.ts. We just need them imported.

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

function compileValueNode(nodeId: string, ctx: WasmCompileCtx): LocalRef | null {
  const cached = ctx.valueLocals.get(nodeId);
  if (cached) return cached;

  const node = ctx.nodeMap.get(nodeId);
  if (!node) { ctx.errors.push(`unknown node id ${nodeId}`); return null; }
  const def = getNodeDef(node.data.nodeType);
  if (!def) { ctx.errors.push(`unknown node def ${node.data.nodeType}`); return null; }

  const emitter = VALUE_NODE_EMITTERS[node.data.nodeType];
  if (!emitter) {
    ctx.errors.push(`No WASM value emitter for "${node.data.nodeType}"`);
    return null;
  }

  // Resolve all value inputs first (recursively compile their source nodes)
  const inputs: Record<string, ValueRef | undefined> = {};
  for (const port of def.ports) {
    if (port.kind !== 'input' || port.category !== 'value') continue;
    const source = ctx.inputToSource.get(`${nodeId}:${port.id}`);
    if (source) {
      const srcRef = compileValueNode(source.nodeId, ctx);
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
  ctx.valueLocals.set(nodeId, result);
  return result;
}

/**
 * Walk the flow chain reachable from `stepNode:do` and emit every value node
 * those branches reference. Value emit calls hit `compileValueNode` which
 * recursively materialises dependencies and caches each result in `valueLocals`.
 * After this pre-pass, the actual flow-chain emission only needs `localGet`s.
 *
 * Why this is required: emitting a value lazily at first reference puts the
 * computation inside whichever branch happened to ask first. The cached local
 * is then a function-level slot, but it's only WRITTEN inside that branch — a
 * sibling branch reading it sees stale data from the previous iteration's
 * unrelated computation. Hoisting all computations to the top of the cell
 * loop makes every cached local well-defined for every branch.
 */
function preEmitValueNodes(ctx: WasmCompileCtx, stepNode: GraphNode): void {
  const visited = new Set<string>();
  const visitValue = (nodeId: string) => {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    compileValueNode(nodeId, ctx);
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
          }
          visitFlow(t.nodeId, 'default', seen);
          break;
        }
      }
    }
  };
  visitFlow(stepNode.id, 'do', new Set());
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
        condRef = compileValueNode(condSource.nodeId, ctx);
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
        const r = compileValueNode(countSource.nodeId, ctx);
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
          const r = compileValueNode(valSource.nodeId, ctx);
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
            const r = compileValueNode(condSrc.nodeId, ctx);
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
            const r = compileValueNode(caseValSrc.nodeId, ctx);
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
      // Regular flow node: resolve value inputs, emit
      const inputs: Record<string, ValueRef | undefined> = {};
      for (const port of def.ports) {
        if (port.kind !== 'input' || port.category !== 'value') continue;
        const source = ctx.inputToSource.get(`${node.id}:${port.id}`);
        if (source) {
          const srcRef = compileValueNode(source.nodeId, ctx);
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
// Top-level compile entry
// ---------------------------------------------------------------------------

export function compileGraphWasm(
  graphNodes: GraphNode[],
  graphEdges: GraphEdge[],
  model: CAModel,
  layout: MemoryLayout,
  viewerIds: Record<string, number>,
): WasmCompileResult {
  // Pre-pass: inline all macro instances. After this the orchestrator never
  // sees a `macro` / `macroInput` / `macroOutput` node.
  const expanded = expandMacros(graphNodes, graphEdges, model);
  if (expanded.error) {
    return { bytes: new Uint8Array(), minMemoryPages: 1, error: expanded.error, viewerIds };
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

  // Find the Step node
  const stepNode = graphNodes.find(n => n.data.nodeType === 'step');
  if (!stepNode) {
    return { bytes: new Uint8Array(), minMemoryPages: 1, error: 'no Step node', viewerIds };
  }

  // Function signature: step(total: i32) -> void
  // Locals: index 0 = total (param), allocated dynamically thereafter
  const emitter = new WasmEmitter(/* numParams */ 1);
  // Allocate the loop counter local (i32 i)
  const iLocal = emitter.allocLocal(I32);

  const ctx: WasmCompileCtx = {
    emitter,
    layout,
    viewerIds,
    model,
    iLocalIdx: iLocal,
    valueLocals: new Map(),
    byteOffsetLocals: new Map(),
    nodeMap,
    inputToSource,
    inputToSources,
    flowOutputToTargets,
    errors: [],
  };

  // Build function body:
  //   i := 0
  //   block: loop:
  //     if (i >= total) br block
  //     <copy lines>          (sync mode)
  //     <flow chain from Step>
  //     i += 1
  //     br loop
  emitter.i32Const(0);
  emitter.localSet(iLocal);
  emitter.block(() => {
    emitter.loop(() => {
      // i >= total -> exit
      emitter.localGet(iLocal);
      emitter.localGet(0);
      emitter.op(OP_I32_GE_S);
      emitter.brIf(1);

      // Reset per-cell cached byte offsets — they're recomputed per iteration
      // (the cached i*itemBytes locals get overwritten on each iteration's first use)
      ctx.byteOffsetLocals.clear();
      ctx.valueLocals.clear();

      // Copy lines (sync mode)
      if (!layout.isAsync) {
        for (const id of Object.keys(layout.attrType)) {
          const a = getAttr(layout, id)!;
          // write[i] = read[i]
          pushCellByteOffset(ctx, a.itemBytes);  // store address
          pushCellByteOffset(ctx, a.itemBytes);  // load address
          if (a.type === 'bool') {
            ctx.emitter.i32Load8U(a.readOffset, 0);
            ctx.emitter.i32Store8(a.writeOffset, 0);
          } else if (a.type === 'float') {
            ctx.emitter.f64Load(a.readOffset, 3);
            ctx.emitter.f64Store(a.writeOffset, 3);
          } else {
            ctx.emitter.i32Load(a.readOffset, 2);
            ctx.emitter.i32Store(a.writeOffset, 2);
          }
        }
      }

      // Two-pass within the cell loop: first hoist all value computations
      // reachable from the flow chain (so each result lives in a function-level
      // local visible to every conditional branch), then emit the flow chain
      // itself. Without this hoist, a value emitted lazily inside one branch
      // (e.g. n6.then) is not recomputed when re-referenced from a sibling
      // branch (n6.else) — the cached local reads stale data from the previous
      // iteration's branch. Mirrors the JS compiler's two-pass strategy.
      preEmitValueNodes(ctx, stepNode);

      // Flow chain from Step's "do" output (matches JS's rootFlowPort = 'do')
      compileFlowChain(stepNode.id, 'do', ctx);

      // i += 1; continue
      emitter.localGet(iLocal);
      emitter.i32Const(1);
      emitter.op(OP_I32_ADD);
      emitter.localSet(iLocal);
      emitter.br(0);
    });
  });

  if (ctx.errors.length > 0) {
    return {
      bytes: new Uint8Array(),
      minMemoryPages: 1,
      error: ctx.errors.join('; '),
      viewerIds,
    };
  }

  const stepBody = emitter.buildBody();
  const memImport = importEntry('env', 'mem', importMemoryDesc(1));
  const bytes = buildModule({
    types: [funcType([I32], [])],
    imports: [memImport],
    funcs: [leb128u(0)],
    exports: [exportEntry('step', EXPORT_FUNC, 0)],
    code: [stepBody],
  });
  return { bytes, minMemoryPages: 1, viewerIds };
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/**
 * Recursively inline all `macro` nodes by expanding each instance's internal
 * subgraph into the outer graph. After expansion the orchestrator never sees
 * `macro` / `macroInput` / `macroOutput` nodes.
 *
 * For each macro instance:
 *  - Internal non-boundary nodes are copied with a prefixed id (`m{instanceId}_*`)
 *    so multiple instances of the same macro don't collide.
 *  - Internal edges touching the boundary nodes are dissolved:
 *      * Edges originating at MacroInput become edges originating at the
 *        EXTERNAL source connected to the macro instance's matching input port.
 *      * Edges arriving at MacroOutput become "anchors" for the macro's
 *        external consumers: each external edge from the macro instance's
 *        output port gets rewritten to source from the corresponding internal
 *        node + port.
 *  - Internal edges that don't touch boundary nodes are copied with prefixed ids.
 *  - Pre-existing edges that touch the macro instance itself are dropped (they
 *    were the bridges and have been replaced).
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

    // (boundary nodes identified inline by data.nodeType in the edge loop below)

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
        // Rewire to external source (e.sourceHandle == macroInput's port == macro's exposed input portId)
        const ep = parseHandle(e.sourceHandle);
        const epPortId = ep?.portId ?? e.sourceHandle;
        // External edges target the macro instance with targetHandle matching this port id
        // (handle format `input_<value|flow>_<portId>` so we look it up by exact targetHandle).
        let ext: { source: string; sourceHandle: string } | undefined;
        for (const [th, src] of extInMap) {
          const parsed = parseHandle(th);
          if (parsed?.portId === epPortId) { ext = src; break; }
        }
        if (!ext) continue; // unconnected — drop this internal edge
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
        // We don't emit this internal edge directly — instead we rewrite the
        // macro instance's external output edges to source from this internal node.
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
  // e.g. "output_flow_do", "input_value_x". Mirrors parseHandleId in vpl/types.ts.
  const m = handleId.match(/^(?:input|output)_(value|flow)_(.+)$/);
  if (!m) return null;
  return { category: m[1] as 'value' | 'flow', portId: m[2]! };
}

/**
 * Async helper: compile + instantiate against the given memory.
 */
export async function instantiateWasmStep(
  result: WasmCompileResult,
  memory: WebAssembly.Memory,
): Promise<{ step: (total: number) => void }> {
  const mod = await WebAssembly.instantiate(result.bytes, { env: { mem: memory } });
  const step = mod.instance.exports.step as (total: number) => void;
  return { step };
}

// Re-export shift/xor opcodes that aren't yet exposed in encoder.ts but are needed by emitters.
const OP_I32_SHL = byte(0x74);
const OP_I32_SHR_U = byte(0x76);
const OP_I32_XOR = byte(0x73);
export { OP_I32_SHL, OP_I32_SHR_U, OP_I32_XOR };

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
  OP_I32_ADD, OP_I32_AND, OP_I32_EQ, OP_I32_EQZ, OP_I32_GE_S, OP_I32_GT_S, OP_I32_LE_S,
  OP_I32_LT_S, OP_I32_MUL, OP_I32_NE, OP_I32_OR, OP_I32_SUB,
  buildModule, byte, exportEntry, EXPORT_FUNC, funcType, importEntry,
  importMemoryDesc, leb128u,
} from './encoder';
import {
  WasmEmitter, LocalRef, ValueRef, isInline, pushValue, pushValueAs,
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
    const raw = node.data.config.value;
    const num = typeof raw === 'number' ? raw : parseFloat(String(raw ?? '0')) || 0;
    if (t === 'float') {
      ctx.emitter.f64Const(num);
      return storeResult(ctx.emitter, F64);
    }
    // bool / integer / tag — i32
    ctx.emitter.i32Const(num | 0);
    return storeResult(ctx.emitter, I32);
  },

  tagConstant: ({ node, ctx }) => {
    const raw = node.data.config.value;
    const num = typeof raw === 'number' ? raw : parseInt(String(raw ?? '0'), 10) || 0;
    ctx.emitter.i32Const(num);
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

  // -- Math (binary) --
  binaryOperator: ({ node, ctx, inputs }) => {
    const op = (node.data.config.operation as string) || '+';
    const a = inputs['a'] ?? inputs['left'];
    const b = inputs['b'] ?? inputs['right'];
    if (!a || !b) { ctx.errors.push(`binaryOperator: missing inputs (${op})`); return null; }
    // Promote both to f64 for general math safety.
    pushValueAs(ctx.emitter, a, F64);
    pushValueAs(ctx.emitter, b, F64);
    switch (op) {
      case '+': ctx.emitter.op(OP_F64_ADD); break;
      case '-': ctx.emitter.op(OP_F64_SUB); break;
      case '*': ctx.emitter.op(OP_F64_MUL); break;
      case '/': ctx.emitter.op(OP_F64_DIV); break;
      case 'min': ctx.emitter.op(OP_F64_MIN); break;
      case 'max': ctx.emitter.op(OP_F64_MAX); break;
      default: ctx.errors.push(`binaryOperator: unsupported op ${op}`); return null;
    }
    return storeResult(ctx.emitter, F64);
  },

  comparison: ({ node, ctx, inputs }) => {
    const op = (node.data.config.operator as string) || '==';
    const a = inputs['a'] ?? inputs['left'];
    const b = inputs['b'] ?? inputs['right'];
    if (!a || !b) { ctx.errors.push(`comparison: missing inputs (${op})`); return null; }
    // If both are i32, use i32 ops (faster and avoids f64 conversion). Otherwise f64.
    const useI32 = (!isInline(a) ? a.valtype === I32 : a.valtype === I32) &&
                   (!isInline(b) ? b.valtype === I32 : b.valtype === I32);
    if (useI32) {
      pushValue(ctx.emitter, a);
      pushValue(ctx.emitter, b);
      switch (op) {
        case '==': case '===': ctx.emitter.op(OP_I32_EQ); break;
        case '!=': case '!==': ctx.emitter.op(OP_I32_NE); break;
        case '<': ctx.emitter.op(OP_I32_LT_S); break;
        case '<=': ctx.emitter.op(OP_I32_LE_S); break;
        case '>': ctx.emitter.op(OP_I32_GT_S); break;
        case '>=': ctx.emitter.op(OP_I32_GE_S); break;
        default: ctx.errors.push(`comparison: unsupported op ${op}`); return null;
      }
    } else {
      pushValueAs(ctx.emitter, a, F64);
      pushValueAs(ctx.emitter, b, F64);
      switch (op) {
        case '==': case '===': ctx.emitter.op(OP_F64_EQ); break;
        case '!=': case '!==': ctx.emitter.op(OP_F64_NE); break;
        case '<': ctx.emitter.op(OP_F64_LT); break;
        case '<=': ctx.emitter.op(OP_F64_LE); break;
        case '>': ctx.emitter.op(OP_F64_GT); break;
        case '>=': ctx.emitter.op(OP_F64_GE); break;
        default: ctx.errors.push(`comparison: unsupported op ${op}`); return null;
      }
    }
    return storeResult(ctx.emitter, I32);
  },

  logical: ({ node, ctx, inputs }) => {
    const op = (node.data.config.operator as string) || 'and';
    const a = inputs['a'] ?? inputs['left'];
    const b = inputs['b'] ?? inputs['right'];
    if (!a || !b) { ctx.errors.push(`logical: missing inputs (${op})`); return null; }
    pushValueAs(ctx.emitter, a, I32);
    pushValueAs(ctx.emitter, b, I32);
    switch (op) {
      case 'and': ctx.emitter.op(OP_I32_AND); break;
      case 'or': ctx.emitter.op(OP_I32_OR); break;
      default: ctx.errors.push(`logical: unsupported op ${op}`); return null;
    }
    return storeResult(ctx.emitter, I32);
  },

  not: ({ ctx, inputs }) => {
    const v = inputs['value'] ?? inputs['a'];
    if (!v) { ctx.errors.push('not: missing input'); return null; }
    pushValueAs(ctx.emitter, v, I32);
    ctx.emitter.op(OP_I32_EQZ); // Wraps non-zero -> 0, zero -> 1
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
};

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
  mode: 'aggregate' | 'count',
): LocalRef | null {
  // Find the source node feeding the input port
  const portKey = `${node.id}:values`;
  const sources = ctx.inputToSources.get(portKey) ?? [];
  if (sources.length !== 1) {
    ctx.errors.push(`${mode}: only single-source supported in WASM (got ${sources.length})`);
    return null;
  }
  const src = sources[0]!;
  const srcNode = ctx.nodeMap.get(src.nodeId);
  if (!srcNode || srcNode.data.nodeType !== 'getNeighborsAttribute') {
    ctx.errors.push(`${mode}: WASM only supports getNeighborsAttribute as source`);
    return null;
  }
  const nbrId = srcNode.data.config.neighborhoodId as string;
  const attrId = srcNode.data.config.attributeId as string;
  const nbr = getNbr(ctx.layout, nbrId);
  const attr = getAttr(ctx.layout, attrId);
  if (!nbr || !attr) {
    ctx.errors.push(`${mode}: unknown nbr/attr (${nbrId}/${attrId})`);
    return null;
  }

  // Operation
  let op: string;
  if (mode === 'aggregate') {
    op = (node.data.config.operation as string) || 'sum';
  } else {
    // groupCounting: count entries where value === target
    op = 'count';
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

  // For count mode: get target value (the node's "value" config or input)
  let targetValue: ValueRef | null = null;
  if (mode === 'count') {
    // groupCounting node has a "value" input (what to count occurrences of)
    targetValue = inputs['value'] ?? null;
    if (!targetValue) {
      // Inline default: usually no inline; default to 1
      targetValue = { inline: true, value: 1, valtype: elemValtype };
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
        // (loadedValue === targetValue) ? acc++ : noop
        // Stack: [loadedValue]
        // Push targetValue, compare
        pushValueAs(ctx.emitter, targetValue!, elemValtype);
        if (elemValtype === F64) ctx.emitter.op(OP_F64_EQ);
        else ctx.emitter.op(OP_I32_EQ);
        // if (eq) acc++
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
        const num = parseFloat(inlineVal);
        const isFloat = port.dataType === 'float';
        inputs[port.id] = { inline: true, value: Number.isFinite(num) ? num : 0, valtype: isFloat ? F64 : I32 };
      }
    }
  }

  const result = emitter({ ctx, node, inputs });
  if (!result) return null;
  ctx.valueLocals.set(nodeId, result);
  return result;
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
        const num = parseFloat(inlineVal ?? '0');
        condRef = { inline: true, value: Number.isFinite(num) ? num : 0, valtype: I32 };
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
    } else if (node.data.nodeType === 'sequence' || node.data.nodeType === 'statement') {
      compileFlowChain(node.id, 'first', ctx);
      compileFlowChain(node.id, 'then', ctx);
      compileFlowChain(node.id, 'second', ctx);
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
            const num = parseFloat(inlineVal);
            const isFloat = port.dataType === 'float';
            inputs[port.id] = { inline: true, value: Number.isFinite(num) ? num : 0, valtype: isFloat ? F64 : I32 };
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

function parseHandle(handleId: string | undefined): { category: 'value' | 'flow'; portId: string } | null {
  if (!handleId) return null;
  // Handle format: "<category>:<portId>" e.g. "value:result", "flow:do"
  const idx = handleId.indexOf(':');
  if (idx < 0) return null;
  const category = handleId.slice(0, idx);
  const portId = handleId.slice(idx + 1);
  if (category !== 'value' && category !== 'flow') return null;
  return { category: category as 'value' | 'flow', portId };
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

/**
 * Graph → WebGPU (WGSL compute shader) compiler. Wave 3 backend.
 *
 * Emits a single WGSL shader module containing:
 *   - `step` compute entry point — runs the per-generation update graph for
 *     every cell in parallel (workgroup_size 64).
 *   - `outputMapping_<sanitisedId>` per Attribute→Color mapping — writes the
 *     colors buffer for one viewer; the worker dispatches the right one based
 *     on the active viewer.
 *
 * InputColor (paint) stays on the JS path — per-click workload too small to
 * amortise GPU dispatch.
 *
 * Per-node emit dispatch lives in VALUE_NODE_EMITTERS / FLOW_NODE_EMITTERS.
 * Adding a new node type means adding an entry here. Unsupported nodes cause
 * the compile to return an `error` and the worker stays on JS.
 *
 * All scalar arithmetic runs in f32 (WGSL has no f64). Documented in CLAUDE.md
 * as a target-specific precision difference vs JS/WASM.
 */

import type { CAModel, GraphEdge, GraphNode } from '../../../../model/types';
import { computeWebGPULayout, type WebGPULayout, type WebGPULayoutAttr, type WebGPULayoutNbr } from './layout';
import {
  emitBindings, emitEntryPoint, emitPerCellCopyPreamble, sanitiseWgslName,
} from './encoder';
import { getNodeDef } from '../../nodes/registry';
import { parseHandleId, type PortDef } from '../../types';
import {
  detectWebGPUIncompatibilities, detectWebGPUModelIncompatibilities,
} from '../../nodes/nodeValidation';

export interface WebGPUEntryPoints {
  step: string;
  outputMappings: Array<{ mappingId: string; entry: string }>;
}

export interface WebGPUCompileResult {
  shaderCode: string;
  entryPoints: WebGPUEntryPoints;
  layout: WebGPULayout;
  /** When set, the WebGPU compile failed (unsupported node, async mode, etc.).
   *  Caller surfaces this and the worker stays on the JS/WASM path. */
  error?: string;
  /** Compile-time index lookup for stop messages. layout.indicators-style flat
   *  array — the worker uses this to map `stopFlag` value → message string. */
  stopMessages: string[];
  viewerIds: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type WgslType = 'f32' | 'i32' | 'bool';

interface ValueRef {
  /** Name of the WGSL local that holds this value, OR an inline literal expr. */
  expr: string;
  type: WgslType;
}

/** A reference to an array materialised in per-thread (function-scope) WGSL
 *  `var` storage. Each producer declares a fixed-size array sized to
 *  `maxArraySize` (= max neighbourhood size in the model) and a length local.
 *  Consumers iterate `0..lenName` and read `name[k]`. Mirrors the WASM
 *  `ArrayRef` but with WGSL var arrays instead of bump-pointer scratch. */
interface ArrayRef {
  kind: 'array';
  /** WGSL var name (the array). */
  name: string;
  /** WGSL var name (the i32 length). */
  lenName: string;
  /** Element WGSL type. */
  elemType: WgslType;
}

interface CompileCtx {
  model: CAModel;
  layout: WebGPULayout;
  viewerIds: Record<string, number>;
  stopMessages: string[];
  /** Maximum private-array size; chosen as the max neighbourhood size in the
   *  model so per-thread `var arr: array<T, maxArraySize>` fits any nbr-derived
   *  array. */
  maxArraySize: number;

  /** All graph nodes (top level + macroDefs flattened) keyed by id. */
  nodeMap: Map<string, GraphNode>;
  /** "<targetNodeId>:<targetPortId>" → first source. */
  inputToSource: Map<string, { nodeId: string; portId: string }>;
  /** "<targetNodeId>:<targetPortId>" → all sources (multi-input ports, e.g. aggregate). */
  inputToSources: Map<string, Array<{ nodeId: string; portId: string }>>;
  /** "<sourceNodeId>:<sourcePortId>" → all targets (flow chain follower). */
  flowOutputToTargets: Map<string, Array<{ nodeId: string; portId: string }>>;

  /** Lines accumulated for the current entry point's body. */
  lines: string[];
  /** Multi-output node cache: nodeId → portId → ValueRef. */
  valueLocals: Map<string, Map<string, ValueRef>>;
  /** Per-node ArrayRef cache. Used by isArrayProducer dispatch. */
  arrayRefs: Map<string, ArrayRef>;
  /** Local counter for fresh variable name allocation. */
  localCounter: number;
  /** Errors accumulated; non-empty means compile failed for this entry. */
  errors: string[];
  /** When emitting an outputMapping shader, this is the mappingId being
   *  emitted. setColorViewer for OTHER mappings becomes a no-op (compile-time
   *  skipped). When emitting the step shader, this is null and setColorViewer
   *  guards on `control.activeViewer == viewerInt`. */
  currentMappingId: string | null;
  /** Toggle: write to attrsWrite (step) vs no writes (outputMapping). Used by
   *  setAttribute to error out when invoked from an outputMapping shader. */
  allowAttrWrites: boolean;
}

// ---------------------------------------------------------------------------
// Helpers — adjacency, port resolution, attribute lookup
// ---------------------------------------------------------------------------

function buildAdjacency(
  graphNodes: GraphNode[], graphEdges: GraphEdge[], model: CAModel,
): {
  nodeMap: Map<string, GraphNode>;
  inputToSource: Map<string, { nodeId: string; portId: string }>;
  inputToSources: Map<string, Array<{ nodeId: string; portId: string }>>;
  flowOutputToTargets: Map<string, Array<{ nodeId: string; portId: string }>>;
} {
  const nodeMap = new Map<string, GraphNode>();
  for (const n of graphNodes) nodeMap.set(n.id, n);
  // Macros — register internal nodes too so detectIncompatibilities can find
  // them. We don't currently inline macros; they're rejected.
  for (const m of model.macroDefs || []) {
    for (const n of m.nodes || []) nodeMap.set(n.id, n);
  }

  const inputToSource = new Map<string, { nodeId: string; portId: string }>();
  const inputToSources = new Map<string, Array<{ nodeId: string; portId: string }>>();
  const flowOutputToTargets = new Map<string, Array<{ nodeId: string; portId: string }>>();

  for (const edge of graphEdges) {
    const sh = parseHandleId(edge.sourceHandle);
    const th = parseHandleId(edge.targetHandle);
    if (!sh || !th) continue;
    if (th.category === 'value') {
      const k = `${edge.target}:${th.portId}`;
      if (!inputToSource.has(k)) inputToSource.set(k, { nodeId: edge.source, portId: sh.portId });
      const arr = inputToSources.get(k) ?? [];
      arr.push({ nodeId: edge.source, portId: sh.portId });
      inputToSources.set(k, arr);
    }
    if (sh.category === 'flow') {
      const k = `${edge.source}:${sh.portId}`;
      const arr = flowOutputToTargets.get(k) ?? [];
      arr.push({ nodeId: edge.target, portId: th.portId });
      flowOutputToTargets.set(k, arr);
    }
  }

  return { nodeMap, inputToSource, inputToSources, flowOutputToTargets };
}

function getAttr(layout: WebGPULayout, id: string): WebGPULayoutAttr | null {
  return layout.attrs.find(a => a.id === id) ?? null;
}
function getNbr(layout: WebGPULayout, id: string): WebGPULayoutNbr | null {
  return layout.nbrs.find(n => n.id === id) ?? null;
}

function attrWgslType(t: string): WgslType {
  if (t === 'float') return 'f32';
  if (t === 'bool') return 'bool';
  return 'i32'; // integer, tag
}

function fresh(ctx: CompileCtx, prefix: string = 'l'): string {
  return `_${prefix}${ctx.localCounter++}`;
}

function emitLet(ctx: CompileCtx, type: WgslType, expr: string, prefix: string = 'l'): ValueRef {
  const name = fresh(ctx, prefix);
  ctx.lines.push(`  let ${name}: ${type} = ${expr};`);
  return { expr: name, type };
}
function emitVar(ctx: CompileCtx, type: WgslType, expr: string, prefix: string = 'v'): { name: string; type: WgslType } {
  const name = fresh(ctx, prefix);
  ctx.lines.push(`  var ${name}: ${type} = ${expr};`);
  return { name, type };
}

/** Coerce a ValueRef to the requested WGSL type. */
function castTo(v: ValueRef, want: WgslType): string {
  if (v.type === want) return v.expr;
  if (want === 'f32') {
    if (v.type === 'i32') return `f32(${v.expr})`;
    if (v.type === 'bool') return `select(0.0, 1.0, ${v.expr})`;
  }
  if (want === 'i32') {
    if (v.type === 'f32') return `i32(${v.expr})`;
    if (v.type === 'bool') return `select(0, 1, ${v.expr})`;
  }
  if (want === 'bool') {
    if (v.type === 'f32') return `(${v.expr} != 0.0)`;
    if (v.type === 'i32') return `(${v.expr} != 0)`;
  }
  return v.expr;
}

/** Read attr value as the appropriate WGSL type. */
function readAttr(attr: WebGPULayoutAttr, idxExpr: string = 'idx', useWriteBuf: boolean = false): ValueRef {
  const buf = useWriteBuf ? 'attrsWrite' : 'attrsRead';
  const slot = attr.wordOffset === 0 ? `${buf}[${idxExpr}]` : `${buf}[${attr.wordOffset}u + ${idxExpr}]`;
  if (attr.type === 'float') return { expr: `bitcast<f32>(${slot})`, type: 'f32' };
  if (attr.type === 'bool') return { expr: `(${slot} != 0u)`, type: 'bool' };
  // integer / tag stored as i32 in u32 slot
  return { expr: `bitcast<i32>(${slot})`, type: 'i32' };
}

/** Encode a typed value back to a u32 word for storage. */
function encodeAttrWord(attrType: string, srcExpr: string, srcType: WgslType): string {
  if (attrType === 'float') {
    if (srcType === 'f32') return `bitcast<u32>(${srcExpr})`;
    if (srcType === 'i32') return `bitcast<u32>(f32(${srcExpr}))`;
    return `bitcast<u32>(select(0.0, 1.0, ${srcExpr}))`;
  }
  if (attrType === 'bool') {
    if (srcType === 'bool') return `select(0u, 1u, ${srcExpr})`;
    if (srcType === 'i32') return `select(0u, 1u, ${srcExpr} != 0)`;
    return `select(0u, 1u, ${srcExpr} != 0.0)`;
  }
  // integer / tag → i32 → u32 (bitcast)
  if (srcType === 'i32') return `bitcast<u32>(${srcExpr})`;
  if (srcType === 'bool') return `select(0u, 1u, ${srcExpr})`;
  return `bitcast<u32>(i32(${srcExpr}))`;
}

function readModelAttr(layout: WebGPULayout, key: string): ValueRef | null {
  const off = layout.modelAttrOffset[key];
  if (off === undefined) return null;
  // modelAttrs is array<vec4<f32>, N>. Index by /16 for vec4, %16/4 for component.
  const vecIdx = Math.floor(off / 16);
  const comp = (off % 16) / 4;
  const compName = ['x', 'y', 'z', 'w'][comp]!;
  return { expr: `modelAttrs[${vecIdx}u].${compName}`, type: 'f32' };
}

// ---------------------------------------------------------------------------
// Inline-port helpers
// ---------------------------------------------------------------------------

function getInlineValue(port: PortDef, config: Record<string, string | number | boolean>): string | undefined {
  if (!port.inlineWidget) return undefined;
  const k = `_port_${port.id}`;
  const val = config[k];
  if (val === undefined || val === '') return port.defaultValue;
  const s = String(val);
  if (port.inlineWidget === 'bool') return s === 'true' ? '1' : '0';
  return s;
}
function parseInlineNum(raw: string | undefined, fallback: number = 0): number {
  if (raw === undefined) return fallback;
  if (raw === 'true') return 1;
  if (raw === 'false') return 0;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}
function inlineValueRef(raw: string | undefined, isFloat: boolean): ValueRef {
  const n = parseInlineNum(raw, 0);
  if (isFloat) {
    return { expr: Number.isInteger(n) ? `${n}.0` : `${n}`, type: 'f32' };
  }
  return { expr: `${n | 0}`, type: 'i32' };
}

// ---------------------------------------------------------------------------
// Multi-output port cache
// ---------------------------------------------------------------------------

function getCachedPort(ctx: CompileCtx, nodeId: string, portId: string): ValueRef | undefined {
  return ctx.valueLocals.get(nodeId)?.get(portId);
}
function setCachedPort(ctx: CompileCtx, nodeId: string, portId: string, ref: ValueRef): void {
  let m = ctx.valueLocals.get(nodeId);
  if (!m) { m = new Map(); ctx.valueLocals.set(nodeId, m); }
  m.set(portId, ref);
}

// ---------------------------------------------------------------------------
// Per-node value emitters
// ---------------------------------------------------------------------------

interface NodeEmitContext {
  ctx: CompileCtx;
  node: GraphNode;
  inputs: Record<string, ValueRef | undefined>;
}

type NodeValueEmitter = (c: NodeEmitContext) => ValueRef | null;
type NodeArrayEmitter = (c: NodeEmitContext) => ArrayRef | null;
type NodeFlowEmitter = (c: NodeEmitContext) => boolean;

/** Produce the WGSL element type for an attribute. */
function attrElemType(t: string): WgslType {
  if (t === 'float') return 'f32';
  if (t === 'bool') return 'i32'; // store bool as 0/1 i32 in arrays for uniform handling
  return 'i32';
}

/** Allocate a fresh per-thread `var arr: array<T, MAX>; var arr_len: i32 = 0;`
 *  inside the current function body. Returns the ArrayRef. */
function allocArray(ctx: CompileCtx, elemType: WgslType, prefix: string = 'arr'): ArrayRef {
  const name = fresh(ctx, prefix);
  const lenName = `${name}_len`;
  ctx.lines.push(`  var ${name}: array<${elemType}, ${ctx.maxArraySize}>;`);
  ctx.lines.push(`  var ${lenName}: i32 = 0;`);
  return { kind: 'array', name, lenName, elemType };
}

/** Expression that loads element `iExpr` from an ArrayRef. */
function arrLoad(arr: ArrayRef, iExpr: string): string {
  return `${arr.name}[${iExpr}]`;
}

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

function compileArrayNode(ctx: CompileCtx, nodeId: string): ArrayRef | null {
  const cached = ctx.arrayRefs.get(nodeId);
  if (cached) return cached;

  const node = ctx.nodeMap.get(nodeId);
  if (!node) { ctx.errors.push(`unknown array node ${nodeId}`); return null; }

  const emitter = ARRAY_NODE_EMITTERS[node.data.nodeType];
  if (!emitter) {
    ctx.errors.push(`No WebGPU array emitter for "${node.data.nodeType}"`);
    return null;
  }

  // Resolve scalar (non-array) inputs first. Array inputs are resolved inside
  // the emitter via resolveInputArray.
  const def = getNodeDef(node.data.nodeType);
  const inputs: Record<string, ValueRef | undefined> = {};
  if (def) {
    for (const port of def.ports) {
      if (port.kind !== 'input' || port.category !== 'value' || port.isArray) continue;
      const src = ctx.inputToSource.get(`${nodeId}:${port.id}`);
      if (src) {
        const r = compileValueNode(ctx, src.nodeId, src.portId);
        if (r) inputs[port.id] = r;
      } else {
        const inlineVal = getInlineValue(port, node.data.config);
        if (inlineVal !== undefined) {
          inputs[port.id] = inlineValueRef(inlineVal, port.dataType === 'float');
        }
      }
    }
  }

  const result = emitter({ ctx, node, inputs });
  if (!result) return null;
  ctx.arrayRefs.set(nodeId, result);
  return result;
}

function resolveInputArray(ctx: CompileCtx, node: GraphNode, portId: string): ArrayRef | null {
  const src = ctx.inputToSource.get(`${node.id}:${portId}`);
  if (!src) return null;
  const srcNode = ctx.nodeMap.get(src.nodeId);
  if (!srcNode) return null;
  if (!isArrayProducer(srcNode.data.nodeType)) return null;
  return compileArrayNode(ctx, src.nodeId);
}

const ARRAY_NODE_EMITTERS: Record<string, NodeArrayEmitter> = {

  // Compile-time constant indices (resolved from tags upstream).
  getNeighborIndexesByTags: ({ node, ctx }) => {
    const indices: number[] = node.data.config._resolvedTagIndexes
      ? JSON.parse(node.data.config._resolvedTagIndexes as string) : [];
    const arr = allocArray(ctx, 'i32', 'arrIdxTags');
    for (let k = 0; k < indices.length; k++) {
      ctx.lines.push(`  ${arr.name}[${k}] = ${indices[k]! | 0};`);
    }
    ctx.lines.push(`  ${arr.lenName} = ${indices.length};`);
    return arr;
  },

  // Filter input array of neighbor indices by comparing the attribute at each
  // referenced neighbor cell against `compare`.
  filterNeighbors: ({ node, ctx, inputs }) => {
    const nbrId = node.data.config.neighborhoodId as string;
    const attrId = node.data.config.attributeId as string;
    const op = (node.data.config.operation as string) || 'equals';
    const nbr = getNbr(ctx.layout, nbrId);
    const attr = getAttr(ctx.layout, attrId);
    if (!nbr || !attr) { ctx.errors.push(`filterNeighbors: unknown nbr/attr (${nbrId}/${attrId})`); return null; }

    const inArr = resolveInputArray(ctx, node, 'indexes');
    if (!inArr) { ctx.errors.push(`filterNeighbors: no array input on "indexes"`); return null; }

    const compare = inputs['compare'] ?? { expr: '0.0', type: 'f32' as WgslType };
    const out = allocArray(ctx, 'i32', 'arrFilter');
    const k = fresh(ctx, 'fk');
    ctx.lines.push(`  for (var ${k}: i32 = 0; ${k} < ${inArr.lenName}; ${k} = ${k} + 1) {`);
    ctx.lines.push(`    let _idxIn_${k}: i32 = ${arrLoad(inArr, k)};`);
    const nbrSlot = nbr.wordOffset === 0
      ? `nbrIndices[i32(idx) * ${nbr.size} + _idxIn_${k}]`
      : `nbrIndices[${nbr.wordOffset}i + i32(idx) * ${nbr.size} + _idxIn_${k}]`;
    ctx.lines.push(`    let _nci_${k}: i32 = ${nbrSlot};`);
    const elem = readAttr(attr, `u32(_nci_${k})`, false);
    ctx.lines.push(`    let _e_${k}: ${elem.type} = ${elem.expr};`);
    const elemF = castTo({ expr: `_e_${k}`, type: elem.type }, 'f32');
    const cmpF = castTo(compare, 'f32');
    let cmp: string;
    switch (op) {
      case 'notEquals':    cmp = '!='; break;
      case 'greater':      cmp = '>'; break;
      case 'lesser':       cmp = '<'; break;
      case 'greaterEqual': cmp = '>='; break;
      case 'lesserEqual':  cmp = '<='; break;
      default:             cmp = '=='; break;
    }
    ctx.lines.push(`    if ((${elemF}) ${cmp} (${cmpF})) {`);
    ctx.lines.push(`      ${out.name}[${out.lenName}] = _idxIn_${k};`);
    ctx.lines.push(`      ${out.lenName} = ${out.lenName} + 1;`);
    ctx.lines.push(`    }`);
    ctx.lines.push(`  }`);
    return out;
  },

  joinNeighbors: ({ node, ctx }) => {
    const op = (node.data.config.operation as string) || 'intersection';
    const a = resolveInputArray(ctx, node, 'a');
    const b = resolveInputArray(ctx, node, 'b');
    if (!a || !b) { ctx.errors.push(`joinNeighbors: missing a/b array input`); return null; }
    const out = allocArray(ctx, 'i32', 'arrJoin');
    const i = fresh(ctx, 'ji');
    if (op === 'union') {
      // Copy A as-is
      ctx.lines.push(`  for (var ${i}: i32 = 0; ${i} < ${a.lenName}; ${i} = ${i} + 1) {`);
      ctx.lines.push(`    ${out.name}[${out.lenName}] = ${arrLoad(a, i)};`);
      ctx.lines.push(`    ${out.lenName} = ${out.lenName} + 1;`);
      ctx.lines.push(`  }`);
      // Walk B, skip duplicates
      const j = fresh(ctx, 'jj');
      const k = fresh(ctx, 'jk');
      ctx.lines.push(`  for (var ${j}: i32 = 0; ${j} < ${b.lenName}; ${j} = ${j} + 1) {`);
      ctx.lines.push(`    let _bElem_${j}: i32 = ${arrLoad(b, j)};`);
      ctx.lines.push(`    var _found_${j}: bool = false;`);
      ctx.lines.push(`    for (var ${k}: i32 = 0; ${k} < ${out.lenName}; ${k} = ${k} + 1) {`);
      ctx.lines.push(`      if (${out.name}[${k}] == _bElem_${j}) { _found_${j} = true; }`);
      ctx.lines.push(`    }`);
      ctx.lines.push(`    if (!_found_${j}) {`);
      ctx.lines.push(`      ${out.name}[${out.lenName}] = _bElem_${j};`);
      ctx.lines.push(`      ${out.lenName} = ${out.lenName} + 1;`);
      ctx.lines.push(`    }`);
      ctx.lines.push(`  }`);
    } else {
      // intersection: keep a[i] if it appears in b
      const k = fresh(ctx, 'jk');
      ctx.lines.push(`  for (var ${i}: i32 = 0; ${i} < ${a.lenName}; ${i} = ${i} + 1) {`);
      ctx.lines.push(`    let _aElem_${i}: i32 = ${arrLoad(a, i)};`);
      ctx.lines.push(`    var _found_${i}: bool = false;`);
      ctx.lines.push(`    for (var ${k}: i32 = 0; ${k} < ${b.lenName}; ${k} = ${k} + 1) {`);
      ctx.lines.push(`      if (${arrLoad(b, k)} == _aElem_${i}) { _found_${i} = true; }`);
      ctx.lines.push(`    }`);
      ctx.lines.push(`    if (_found_${i}) {`);
      ctx.lines.push(`      ${out.name}[${out.lenName}] = _aElem_${i};`);
      ctx.lines.push(`      ${out.lenName} = ${out.lenName} + 1;`);
      ctx.lines.push(`    }`);
      ctx.lines.push(`  }`);
    }
    return out;
  },

  // groupCounting (array output): for each matching value, push the source
  // index into the output array. Source can be getNeighborsAttribute (walks
  // 0..nbrSize) or another array producer.
  groupCounting: ({ node, ctx, inputs }) => {
    const portKey = `${node.id}:values`;
    const sources = ctx.inputToSources.get(portKey) ?? [];
    if (sources.length === 0) { ctx.errors.push(`groupCounting (array): no sources`); return null; }
    const firstSrc = sources[0]!;
    const firstSrcNode = ctx.nodeMap.get(firstSrc.nodeId);
    const isNbrPath = sources.length === 1 && firstSrcNode?.data.nodeType === 'getNeighborsAttribute';

    const cmpOp = (node.data.config.operation as string) || 'equals';
    const lo = (node.data.config.lowOp as string) === '>' ? '>' : '>=';
    const hi = (node.data.config.highOp as string) === '<' ? '<' : '<=';
    const cmpRef = inputs['compare'] ?? { expr: '0.0', type: 'f32' as WgslType };
    const cmpHighRef = inputs['compareHigh'] ?? { expr: '0.0', type: 'f32' as WgslType };

    const out = allocArray(ctx, 'i32', 'arrGC');

    const emitMatch = (loopVar: string, elemFExpr: string) => {
      const cmpF = castTo(cmpRef, 'f32');
      let cond: string;
      switch (cmpOp) {
        case 'notEquals': cond = `(${elemFExpr} != ${cmpF})`; break;
        case 'greater':   cond = `(${elemFExpr} > ${cmpF})`; break;
        case 'lesser':    cond = `(${elemFExpr} < ${cmpF})`; break;
        case 'between': {
          const cmpHF = castTo(cmpHighRef, 'f32');
          cond = `((${elemFExpr} ${lo} ${cmpF}) && (${elemFExpr} ${hi} ${cmpHF}))`; break;
        }
        case 'notBetween': {
          const cmpHF = castTo(cmpHighRef, 'f32');
          cond = `!((${elemFExpr} ${lo} ${cmpF}) && (${elemFExpr} ${hi} ${cmpHF}))`; break;
        }
        default: cond = `(${elemFExpr} == ${cmpF})`; break;
      }
      ctx.lines.push(`    if (${cond}) {`);
      ctx.lines.push(`      ${out.name}[${out.lenName}] = ${loopVar};`);
      ctx.lines.push(`      ${out.lenName} = ${out.lenName} + 1;`);
      ctx.lines.push(`    }`);
    };

    if (isNbrPath) {
      const srcNode = firstSrcNode!;
      const nbr = getNbr(ctx.layout, srcNode.data.config.neighborhoodId as string);
      const attr = getAttr(ctx.layout, srcNode.data.config.attributeId as string);
      if (!nbr || !attr) { ctx.errors.push(`groupCounting (array): unknown nbr/attr`); return null; }
      const n = fresh(ctx, 'gcn');
      ctx.lines.push(`  for (var ${n}: i32 = 0; ${n} < ${nbr.size}; ${n} = ${n} + 1) {`);
      const nbrSlot = nbr.wordOffset === 0
        ? `nbrIndices[i32(idx) * ${nbr.size} + ${n}]`
        : `nbrIndices[${nbr.wordOffset}i + i32(idx) * ${nbr.size} + ${n}]`;
      ctx.lines.push(`    let _nci_${n}: i32 = ${nbrSlot};`);
      const elem = readAttr(attr, `u32(_nci_${n})`, false);
      const elemF = castTo({ expr: elem.expr, type: elem.type }, 'f32');
      emitMatch(n, elemF);
      ctx.lines.push(`  }`);
    } else {
      const arrSrc = isArrayProducer(firstSrcNode?.data.nodeType ?? '') && sources.length === 1
        ? compileArrayNode(ctx, firstSrc.nodeId) : null;
      if (!arrSrc) {
        ctx.errors.push(`groupCounting (array): only single nbr/array source supported`);
        return null;
      }
      const k = fresh(ctx, 'gck');
      ctx.lines.push(`  for (var ${k}: i32 = 0; ${k} < ${arrSrc.lenName}; ${k} = ${k} + 1) {`);
      const elemF = castTo({ expr: arrLoad(arrSrc, k), type: arrSrc.elemType }, 'f32');
      emitMatch(k, elemF);
      ctx.lines.push(`  }`);
    }
    return out;
  },

  // Read attribute values at neighbour positions specified by an indexes array.
  getNeighborsAttrByIndexes: ({ node, ctx }) => {
    const nbrId = node.data.config.neighborhoodId as string;
    const attrId = node.data.config.attributeId as string;
    const nbr = getNbr(ctx.layout, nbrId);
    const attr = getAttr(ctx.layout, attrId);
    if (!nbr || !attr) { ctx.errors.push(`getNeighborsAttrByIndexes: unknown nbr/attr`); return null; }
    const inArr = resolveInputArray(ctx, node, 'indexes');
    if (!inArr) { ctx.errors.push(`getNeighborsAttrByIndexes: no input on "indexes"`); return null; }

    const elemType = attrElemType(attr.type);
    const out = allocArray(ctx, elemType, 'arrNbrAttr');
    const k = fresh(ctx, 'nak');
    ctx.lines.push(`  for (var ${k}: i32 = 0; ${k} < ${inArr.lenName}; ${k} = ${k} + 1) {`);
    ctx.lines.push(`    let _idxIn_${k}: i32 = ${arrLoad(inArr, k)};`);
    const nbrSlot = nbr.wordOffset === 0
      ? `nbrIndices[i32(idx) * ${nbr.size} + _idxIn_${k}]`
      : `nbrIndices[${nbr.wordOffset}i + i32(idx) * ${nbr.size} + _idxIn_${k}]`;
    ctx.lines.push(`    let _nci_${k}: i32 = ${nbrSlot};`);
    const e = readAttr(attr, `u32(_nci_${k})`, false);
    // Coerce to the array's element type. For bool attrs we store as i32 (0/1)
    // for uniform handling; for float we keep f32; for int/tag we keep i32.
    let stored: string;
    if (attr.type === 'bool') stored = `select(0, 1, ${e.expr})`;
    else if (attr.type === 'float') stored = e.expr; // already f32
    else stored = e.expr; // already i32
    ctx.lines.push(`    ${out.name}[${k}] = ${stored};`);
    ctx.lines.push(`  }`);
    ctx.lines.push(`  ${out.lenName} = ${inArr.lenName};`);
    return out;
  },
};

const VALUE_NODE_EMITTERS: Record<string, NodeValueEmitter> = {

  getConstant: ({ node, ctx }) => {
    const t = (node.data.config.constType as string) || 'integer';
    const raw = node.data.config.constValue;
    let num: number;
    if (t === 'bool') {
      num = (raw === 'true' || raw === true || raw === 1) ? 1 : 0;
      return emitLet(ctx, 'bool', num ? 'true' : 'false', 'kb');
    }
    if (t === 'float') {
      num = typeof raw === 'number' ? raw : (parseFloat(String(raw ?? '0')) || 0);
      const lit = Number.isInteger(num) ? `${num}.0` : `${num}`;
      return emitLet(ctx, 'f32', lit, 'kf');
    }
    // integer / tag
    num = typeof raw === 'number' ? raw : (parseInt(String(raw ?? '0'), 10) || 0);
    return emitLet(ctx, 'i32', `${num | 0}`, 'ki');
  },

  tagConstant: ({ node, ctx }) => {
    const idx = Number(node.data.config.tagIndex) || 0;
    return emitLet(ctx, 'i32', `${idx | 0}`, 'tag');
  },

  getCellAttribute: ({ node, ctx }) => {
    const attrId = node.data.config.attributeId as string;
    const attr = getAttr(ctx.layout, attrId);
    if (!attr) { ctx.errors.push(`getCellAttribute: unknown attr ${attrId}`); return null; }
    const r = readAttr(attr, 'idx', false);
    return emitLet(ctx, r.type, r.expr, 'cell');
  },

  getModelAttribute: ({ node, ctx }) => {
    const attrId = node.data.config.attributeId as string;
    const isColor = !!node.data.config.isColorAttr;
    if (isColor) {
      const offR = ctx.layout.modelAttrOffset[attrId + '_r'];
      const offG = ctx.layout.modelAttrOffset[attrId + '_g'];
      const offB = ctx.layout.modelAttrOffset[attrId + '_b'];
      if (offR === undefined || offG === undefined || offB === undefined) {
        ctx.errors.push(`getModelAttribute color: unknown ${attrId}`); return null;
      }
      const fetch = (off: number): ValueRef => {
        const vecIdx = Math.floor(off / 16);
        const compName = ['x', 'y', 'z', 'w'][(off % 16) / 4]!;
        return emitLet(ctx, 'i32', `i32(modelAttrs[${vecIdx}u].${compName})`, 'mac');
      };
      const rRef = fetch(offR);
      const gRef = fetch(offG);
      const bRef = fetch(offB);
      setCachedPort(ctx, node.id, 'r', rRef);
      setCachedPort(ctx, node.id, 'g', gRef);
      setCachedPort(ctx, node.id, 'b', bRef);
      return rRef;
    }
    const ref = readModelAttr(ctx.layout, attrId);
    if (!ref) { ctx.errors.push(`getModelAttribute: unknown ${attrId}`); return null; }
    return emitLet(ctx, ref.type, ref.expr, 'ma');
  },

  // Pseudo-emitter: produces nothing. Aggregate / GroupCounting / GroupOperator
  // / GroupStatement check `nodeMap.get(src.nodeId)?.data.nodeType ===
  // 'getNeighborsAttribute'` and inline a neighbour loop themselves.
  getNeighborsAttribute: ({ node, ctx }) => {
    const nbrId = node.data.config.neighborhoodId as string;
    const attrId = node.data.config.attributeId as string;
    if (!getNbr(ctx.layout, nbrId) || !getAttr(ctx.layout, attrId)) {
      ctx.errors.push(`getNeighborsAttribute: unknown nbr/attr ${nbrId}/${attrId}`); return null;
    }
    // Phantom — never directly consumed as a value.
    return { expr: '0', type: 'i32' };
  },

  arithmeticOperator: ({ node, ctx, inputs }) => {
    const op = (node.data.config.operation as string) || '+';
    const x = castTo(inputs['x'] ?? { expr: '0.0', type: 'f32' }, 'f32');
    const y = castTo(inputs['y'] ?? { expr: '0.0', type: 'f32' }, 'f32');
    let expr: string;
    switch (op) {
      case '+': expr = `(${x} + ${y})`; break;
      case '-': expr = `(${x} - ${y})`; break;
      case '*': expr = `(${x} * ${y})`; break;
      case '/': expr = `select(0.0, (${x} / ${y}), (${y} != 0.0))`; break;
      case '%': expr = `select(0.0, (${x} - trunc((${x}) / (${y})) * (${y})), (${y} != 0.0))`; break;
      case 'max': expr = `max(${x}, ${y})`; break;
      case 'min': expr = `min(${x}, ${y})`; break;
      case 'mean': expr = `((${x} + ${y}) * 0.5)`; break;
      case 'sqrt': expr = `sqrt(${x})`; break;
      case 'abs': expr = `abs(${x})`; break;
      case 'pow': expr = `pow(${x}, ${y})`; break;
      default:
        ctx.errors.push(`arithmeticOperator: unsupported op ${op}`);
        return null;
    }
    return emitLet(ctx, 'f32', expr, 'arith');
  },

  statement: ({ node, ctx, inputs }) => {
    const op = (node.data.config.operation as string) || '==';
    const x = castTo(inputs['x'] ?? { expr: '0.0', type: 'f32' }, 'f32');
    const y = castTo(inputs['y'] ?? { expr: '0.0', type: 'f32' }, 'f32');
    if (op === 'between' || op === 'notBetween') {
      const y2 = castTo(inputs['y2'] ?? { expr: '0.0', type: 'f32' }, 'f32');
      const lo = (node.data.config.lowOp as string) === '>' ? '>' : '>=';
      const hi = (node.data.config.highOp as string) === '<' ? '<' : '<=';
      const inside = `((${x} ${lo} ${y}) && (${x} ${hi} ${y2}))`;
      return emitLet(ctx, 'bool', op === 'notBetween' ? `!(${inside})` : inside, 'bw');
    }
    let cmp: string;
    switch (op) {
      case '==': case '===': cmp = '=='; break;
      case '!=': case '!==': cmp = '!='; break;
      case '<':  cmp = '<'; break;
      case '<=': cmp = '<='; break;
      case '>':  cmp = '>'; break;
      case '>=': cmp = '>='; break;
      default:
        ctx.errors.push(`statement: unsupported op ${op}`); return null;
    }
    return emitLet(ctx, 'bool', `(${x} ${cmp} ${y})`, 'cmp');
  },

  logicOperator: ({ node, ctx, inputs }) => {
    const op = (node.data.config.operation as string) || 'OR';
    const a = castTo(inputs['a'] ?? { expr: 'false', type: 'bool' }, 'bool');
    if (op === 'NOT') return emitLet(ctx, 'bool', `!(${a})`, 'lop');
    const b = castTo(inputs['b'] ?? { expr: 'false', type: 'bool' }, 'bool');
    let expr: string;
    switch (op) {
      case 'AND': expr = `(${a} && ${b})`; break;
      case 'OR':  expr = `(${a} || ${b})`; break;
      case 'XOR': expr = `(${a} != ${b})`; break;
      default:
        ctx.errors.push(`logicOperator: unsupported op ${op}`); return null;
    }
    return emitLet(ctx, 'bool', expr, 'lop');
  },

  aggregate: (c) => emitAggregateOrCount(c, 'aggregate'),
  groupCounting: (c) => emitAggregateOrCount(c, 'count'),
  groupOperator: (c) => emitAggregateOrCount(c, 'groupOperator'),
  groupStatement: (c) => emitGroupStatement(c),

  getRandom: ({ node, ctx, inputs }) => {
    const t = (node.data.config.randomType as string) || 'float';
    const minRaw = node.data.config.min;
    const maxRaw = node.data.config.max;
    const minN = typeof minRaw === 'number' ? minRaw : (parseFloat(String(minRaw ?? '0')) || 0);
    const maxN = typeof maxRaw === 'number' ? maxRaw : (parseFloat(String(maxRaw ?? '1')) || 1);
    const rExpr = `rand_f32(idx)`;
    if (t === 'bool') {
      const prob = inputs['probability'];
      const probExpr = prob ? castTo(prob, 'f32') : '0.5';
      return emitLet(ctx, 'bool', `(${rExpr} < ${probExpr})`, 'rb');
    }
    if (t === 'integer') {
      const span = maxN - minN + 1;
      const lit = `${span}.0`;
      return emitLet(ctx, 'i32', `(i32(${rExpr} * ${lit}) + ${minN | 0})`, 'ri');
    }
    const span = maxN - minN;
    const sl = Number.isInteger(span) ? `${span}.0` : `${span}`;
    const ml = Number.isInteger(minN) ? `${minN}.0` : `${minN}`;
    return emitLet(ctx, 'f32', `((${rExpr} * ${sl}) + ${ml})`, 'rf');
  },

  getIndicator: ({ node, ctx }) => {
    const idxRaw = node.data.config._indicatorIdx;
    const idx = Number(idxRaw ?? -1);
    const id = ctx.layout.indicatorIds[idx];
    if (!id) { ctx.errors.push(`getIndicator: bad index ${idx}`); return null; }
    // Indicators are atomic<u32>, bit-encoded as either f32 (most ops) or i32
    // (for tag/integer add/sub). For reads, the type depends on the indicator
    // definition. We can't always know the read use-case at compile time —
    // expose as f32 (the common case); CAS-based ops work in u32 directly.
    const ind = (ctx.model.indicators || []).find(i => i.id === id);
    const isInt = ind && (ind.kind === 'standalone') &&
      (ind.dataType === 'integer' || ind.dataType === 'tag' || ind.dataType === 'bool');
    if (isInt) {
      return emitLet(ctx, 'i32', `bitcast<i32>(atomicLoad(&indicators[${idx}u]))`, 'ind');
    }
    return emitLet(ctx, 'f32', `bitcast<f32>(atomicLoad(&indicators[${idx}u]))`, 'ind');
  },

  getNeighborAttributeByIndex: ({ node, ctx, inputs }) => {
    const nbrId = node.data.config.neighborhoodId as string;
    const attrId = node.data.config.attributeId as string;
    const nbr = getNbr(ctx.layout, nbrId);
    const attr = getAttr(ctx.layout, attrId);
    if (!nbr || !attr) { ctx.errors.push(`getNeighborAttributeByIndex: unknown nbr/attr`); return null; }
    const indexRef = inputs['index'] ?? { expr: '0', type: 'i32' as WgslType };
    const indexExpr = castTo(indexRef, 'i32');
    // address into nbr table = nbr.wordOffset + i*size + index
    const nbrSlot = nbr.wordOffset === 0
      ? `nbrIndices[i32(idx) * ${nbr.size} + ${indexExpr}]`
      : `nbrIndices[${nbr.wordOffset}i + i32(idx) * ${nbr.size} + ${indexExpr}]`;
    const cellIdx = emitLet(ctx, 'i32', nbrSlot, 'nci');
    // Read attr at cellIdx (cast to u32 for indexing)
    const r = readAttr(attr, `u32(${cellIdx.expr})`, false);
    return emitLet(ctx, r.type, r.expr, 'nbAtr');
  },

  getNeighborAttributeByTag: ({ node, ctx }) => {
    const nbrId = node.data.config.neighborhoodId as string;
    const attrId = node.data.config.attributeId as string;
    const nbr = getNbr(ctx.layout, nbrId);
    const attr = getAttr(ctx.layout, attrId);
    if (!nbr || !attr) { ctx.errors.push(`getNeighborAttributeByTag: unknown nbr/attr`); return null; }
    const tagIdx = Number((node.data.config as Record<string, unknown>)._resolvedTagIndex ?? 0);
    const nbrSlot = nbr.wordOffset === 0
      ? `nbrIndices[i32(idx) * ${nbr.size} + ${tagIdx}]`
      : `nbrIndices[${nbr.wordOffset}i + i32(idx) * ${nbr.size} + ${tagIdx}]`;
    const cellIdx = emitLet(ctx, 'i32', nbrSlot, 'nci');
    const r = readAttr(attr, `u32(${cellIdx.expr})`, false);
    return emitLet(ctx, r.type, r.expr, 'nbAtr');
  },

  proportionMap: ({ ctx, inputs }) => {
    const x = castTo(inputs['x'] ?? { expr: '0.0', type: 'f32' }, 'f32');
    const inMin = castTo(inputs['inMin'] ?? { expr: '0.0', type: 'f32' }, 'f32');
    const inMax = castTo(inputs['inMax'] ?? { expr: '1.0', type: 'f32' }, 'f32');
    const outMin = castTo(inputs['outMin'] ?? { expr: '0.0', type: 'f32' }, 'f32');
    const outMax = castTo(inputs['outMax'] ?? { expr: '1.0', type: 'f32' }, 'f32');
    const span = emitLet(ctx, 'f32', `(${inMax} - ${inMin})`, 'sp');
    const expr = `select((${outMin}), ((${outMin}) + ((${x}) - (${inMin})) * ((${outMax}) - (${outMin})) / ${span.expr}), (${span.expr} != 0.0))`;
    return emitLet(ctx, 'f32', expr, 'pm');
  },

  interpolation: ({ ctx, inputs }) => {
    const t = castTo(inputs['t'] ?? { expr: '0.5', type: 'f32' }, 'f32');
    const mn = castTo(inputs['min'] ?? { expr: '0.0', type: 'f32' }, 'f32');
    const mx = castTo(inputs['max'] ?? { expr: '1.0', type: 'f32' }, 'f32');
    return emitLet(ctx, 'f32', `(${mn} + ${t} * (${mx} - ${mn}))`, 'lerp');
  },

  getColorConstant: ({ node, ctx }) => {
    const r = parseInt(String(node.data.config.r ?? '0'), 10) || 0;
    const g = parseInt(String(node.data.config.g ?? '0'), 10) || 0;
    const b = parseInt(String(node.data.config.b ?? '0'), 10) || 0;
    const rRef = emitLet(ctx, 'i32', `${r | 0}`, 'cr');
    const gRef = emitLet(ctx, 'i32', `${g | 0}`, 'cg');
    const bRef = emitLet(ctx, 'i32', `${b | 0}`, 'cb');
    setCachedPort(ctx, node.id, 'r', rRef);
    setCachedPort(ctx, node.id, 'g', gRef);
    setCachedPort(ctx, node.id, 'b', bRef);
    return rRef;
  },

  colorInterpolation: ({ ctx, node, inputs }) => {
    const t = castTo(inputs['t'] ?? { expr: '0.5', type: 'f32' }, 'f32');
    const tLoc = emitLet(ctx, 'f32', t, 'ct');
    const ch = (c1k: string, c2k: string, def1: number, def2: number, port: 'r' | 'g' | 'b'): ValueRef => {
      const c1 = castTo(inputs[c1k] ?? { expr: `${def1 | 0}`, type: 'i32' }, 'f32');
      const c2 = castTo(inputs[c2k] ?? { expr: `${def2 | 0}`, type: 'i32' }, 'f32');
      const expr = `i32(floor(${c1} + ${tLoc.expr} * (${c2} - ${c1}) + 0.5))`;
      const ref = emitLet(ctx, 'i32', expr, 'ci' + port);
      return ref;
    };
    const rRef = ch('r1', 'r2', 0, 255, 'r');
    const gRef = ch('g1', 'g2', 0, 255, 'g');
    const bRef = ch('b1', 'b2', 0, 255, 'b');
    setCachedPort(ctx, node.id, 'r', rRef);
    setCachedPort(ctx, node.id, 'g', gRef);
    setCachedPort(ctx, node.id, 'b', bRef);
    return rRef;
  },
};

// ---------------------------------------------------------------------------
// Aggregate / GroupCounting / GroupOperator — neighbour-loop or scalar-fold
// ---------------------------------------------------------------------------

function emitAggregateOrCount(
  c: NodeEmitContext, mode: 'aggregate' | 'count' | 'groupOperator',
): ValueRef | null {
  const { ctx, node, inputs } = c;
  const portKey = `${node.id}:values`;
  const sources = ctx.inputToSources.get(portKey) ?? [];
  if (sources.length === 0) {
    ctx.errors.push(`${mode}: no sources connected to "values" port`); return null;
  }
  const firstSrc = sources[0]!;
  const firstSrcNode = ctx.nodeMap.get(firstSrc.nodeId);
  const isNbrPath = sources.length === 1
    && firstSrcNode?.data.nodeType === 'getNeighborsAttribute';

  // Resolve op
  let op: string;
  if (mode === 'count') {
    op = (node.data.config.operation as string) || 'equals';
  } else {
    op = (node.data.config.operation as string) || 'sum';
    if (op === 'mul') op = 'product';
    if (op === 'mean') op = 'average';
  }

  if (mode !== 'count' && (op === 'median' || op === 'random')) {
    ctx.errors.push(`${mode}: WebGPU target does not yet support op "${op}". Use sum/product/min/max/average/and/or, or switch to JS/WASM target.`);
    return null;
  }

  // Determine accumulator type
  const accType: WgslType = (mode === 'count') ? 'i32' : (op === 'and' || op === 'or') ? 'bool' : 'f32';

  // Initial value
  let initExpr: string;
  if (mode === 'count') initExpr = '0';
  else if (op === 'sum' || op === 'average') initExpr = '0.0';
  else if (op === 'product') initExpr = '1.0';
  else if (op === 'min') initExpr = '3.4028235e38'; // max f32
  else if (op === 'max') initExpr = '-3.4028235e38';
  else if (op === 'and') initExpr = 'true';
  else if (op === 'or') initExpr = 'false';
  else { ctx.errors.push(`${mode}: unsupported op ${op}`); return null; }

  const acc = emitVar(ctx, accType, initExpr, 'acc');

  // groupOperator min/max also tracks index
  const trackIndex = mode === 'groupOperator' && (op === 'min' || op === 'max');
  let bestIdx: { name: string; type: WgslType } | null = null;
  if (trackIndex) bestIdx = emitVar(ctx, 'i32', '0', 'bi');

  // For count: comparison setup
  let cmpRef: ValueRef | null = null;
  let cmpHighRef: ValueRef | null = null;
  if (mode === 'count') {
    cmpRef = inputs['compare'] ?? { expr: '0.0', type: 'f32' };
    if (op === 'between' || op === 'notBetween') {
      cmpHighRef = inputs['compareHigh'] ?? { expr: '0.0', type: 'f32' };
    }
  }
  const lo = (node.data.config.lowOp as string) === '>' ? '>' : '>=';
  const hi = (node.data.config.highOp as string) === '<' ? '<' : '<=';

  // Path: single ArrayRef-producing source (e.g. groupCounting.indexes,
  // getNeighborsAttrByIndexes, filterNeighbors).
  const isArrayPath = sources.length === 1 && !isNbrPath
    && firstSrcNode && isArrayProducer(firstSrcNode.data.nodeType);
  let arrRef: ArrayRef | null = null;
  if (isArrayPath) {
    arrRef = compileArrayNode(ctx, firstSrc.nodeId);
    if (!arrRef) return null;
  }

  if (isNbrPath) {
    const srcNode = firstSrcNode!;
    const nbrId = srcNode.data.config.neighborhoodId as string;
    const attrId = srcNode.data.config.attributeId as string;
    const nbr = getNbr(ctx.layout, nbrId);
    const attr = getAttr(ctx.layout, attrId);
    if (!nbr || !attr) {
      ctx.errors.push(`${mode}: unknown nbr/attr (${nbrId}/${attrId})`); return null;
    }
    const nVar = fresh(ctx, 'n');
    ctx.lines.push(`  for (var ${nVar}: i32 = 0; ${nVar} < ${nbr.size}; ${nVar} = ${nVar} + 1) {`);
    const nbrSlot = nbr.wordOffset === 0
      ? `nbrIndices[i32(idx) * ${nbr.size} + ${nVar}]`
      : `nbrIndices[${nbr.wordOffset}i + i32(idx) * ${nbr.size} + ${nVar}]`;
    ctx.lines.push(`    let _nci_${nVar}: i32 = ${nbrSlot};`);
    const elem = readAttr(attr, `u32(_nci_${nVar})`, false);
    ctx.lines.push(`    let _e_${nVar}: ${elem.type} = ${elem.expr};`);
    const elemRef: ValueRef = { expr: `_e_${nVar}`, type: elem.type };
    emitAccumStep(ctx, mode, op, acc, elemRef, accType, cmpRef, cmpHighRef, lo, hi, trackIndex, bestIdx, nVar);
    ctx.lines.push(`  }`);
  } else if (arrRef) {
    const nVar = fresh(ctx, 'an');
    ctx.lines.push(`  for (var ${nVar}: i32 = 0; ${nVar} < ${arrRef.lenName}; ${nVar} = ${nVar} + 1) {`);
    ctx.lines.push(`    let _e_${nVar}: ${arrRef.elemType} = ${arrLoad(arrRef, nVar)};`);
    const elemRef: ValueRef = { expr: `_e_${nVar}`, type: arrRef.elemType };
    emitAccumStep(ctx, mode, op, acc, elemRef, accType, cmpRef, cmpHighRef, lo, hi, trackIndex, bestIdx, nVar);
    ctx.lines.push(`  }`);
  } else {
    // Scalar fold: each source resolved independently
    const refs: ValueRef[] = [];
    for (const s of sources) {
      const r = compileValueNode(ctx, s.nodeId, s.portId);
      if (!r) return null;
      refs.push(r);
    }
    let i = 0;
    for (const ref of refs) {
      emitAccumStep(ctx, mode, op, acc, ref, accType, cmpRef, cmpHighRef, lo, hi, trackIndex, bestIdx, `${i}`);
      i++;
    }
    // Average post-divide for scalar path uses sources.length
    if (op === 'average') {
      ctx.lines.push(`  ${acc.name} = ${acc.name} / ${Math.max(1, refs.length)}.0;`);
    }
  }

  // Average post-divide for nbr path
  if (isNbrPath && op === 'average') {
    const nbrSize = (firstSrcNode && getNbr(ctx.layout, firstSrcNode.data.config.neighborhoodId as string)?.size) || 1;
    ctx.lines.push(`  ${acc.name} = ${acc.name} / ${Math.max(1, nbrSize)}.0;`);
  }
  if (arrRef && op === 'average') {
    ctx.lines.push(`  ${acc.name} = ${acc.name} / max(1.0, f32(${arrRef.lenName}));`);
  }

  const result: ValueRef = { expr: acc.name, type: accType };
  if (mode === 'groupOperator') {
    setCachedPort(ctx, node.id, 'result', result);
    if (bestIdx) {
      setCachedPort(ctx, node.id, 'index', { expr: bestIdx.name, type: 'i32' });
    } else {
      // Initialize a -1 index for non-tracking ops so consumers don't fail.
      const dummy = emitLet(ctx, 'i32', '-1', 'gi');
      setCachedPort(ctx, node.id, 'index', dummy);
    }
  }
  if (mode === 'count') {
    setCachedPort(ctx, node.id, 'count', result);
  }
  return result;
}

function emitAccumStep(
  ctx: CompileCtx,
  mode: 'aggregate' | 'count' | 'groupOperator',
  op: string,
  acc: { name: string; type: WgslType },
  elem: ValueRef,
  accType: WgslType,
  cmpRef: ValueRef | null,
  cmpHighRef: ValueRef | null,
  lo: string,
  hi: string,
  trackIndex: boolean,
  bestIdx: { name: string; type: WgslType } | null,
  iterTag: string,
): void {
  if (mode === 'count') {
    const elemExpr = castTo(elem, 'f32');
    const cmpExpr = cmpRef ? castTo(cmpRef, 'f32') : '0.0';
    let cond: string;
    switch (op) {
      case 'notEquals': cond = `(${elemExpr} != ${cmpExpr})`; break;
      case 'greater':   cond = `(${elemExpr} > ${cmpExpr})`; break;
      case 'lesser':    cond = `(${elemExpr} < ${cmpExpr})`; break;
      case 'between': {
        const cmpH = cmpHighRef ? castTo(cmpHighRef, 'f32') : '0.0';
        cond = `((${elemExpr} ${lo} ${cmpExpr}) && (${elemExpr} ${hi} ${cmpH}))`; break;
      }
      case 'notBetween': {
        const cmpH = cmpHighRef ? castTo(cmpHighRef, 'f32') : '0.0';
        cond = `!((${elemExpr} ${lo} ${cmpExpr}) && (${elemExpr} ${hi} ${cmpH}))`; break;
      }
      default: cond = `(${elemExpr} == ${cmpExpr})`; break;
    }
    ctx.lines.push(`    if (${cond}) { ${acc.name} = ${acc.name} + 1; }`);
    return;
  }

  if (trackIndex && bestIdx) {
    const elemF = castTo(elem, 'f32');
    const cmpOp = op === 'min' ? '<' : '>';
    ctx.lines.push(`    if ((${elemF}) ${cmpOp} ${acc.name}) { ${acc.name} = ${elemF}; ${bestIdx.name} = ${iterTag}; }`);
    return;
  }

  switch (op) {
    case 'sum':
    case 'average':
      ctx.lines.push(`    ${acc.name} = ${acc.name} + ${castTo(elem, 'f32')};`);
      break;
    case 'product':
      ctx.lines.push(`    ${acc.name} = ${acc.name} * ${castTo(elem, 'f32')};`);
      break;
    case 'min':
      ctx.lines.push(`    ${acc.name} = min(${acc.name}, ${castTo(elem, 'f32')});`);
      break;
    case 'max':
      ctx.lines.push(`    ${acc.name} = max(${acc.name}, ${castTo(elem, 'f32')});`);
      break;
    case 'and':
      ctx.lines.push(`    ${acc.name} = ${acc.name} && ${castTo(elem, 'bool')};`);
      break;
    case 'or':
      ctx.lines.push(`    ${acc.name} = ${acc.name} || ${castTo(elem, 'bool')};`);
      break;
  }
  void accType;
}

function emitGroupStatement(c: NodeEmitContext): ValueRef | null {
  const { ctx, node, inputs } = c;
  const op = (node.data.config.operation as string) || 'allIs';
  const isAll = op === 'allIs' || op === 'noneIs' || op === 'allGreater' || op === 'allLesser';
  const x = inputs['x'] ?? { expr: '0.0', type: 'f32' as WgslType };

  const portKey = `${node.id}:values`;
  const sources = ctx.inputToSources.get(portKey) ?? [];
  if (sources.length === 0) {
    ctx.errors.push(`groupStatement: no sources on "values"`); return null;
  }
  const firstSrc = sources[0]!;
  const firstSrcNode = ctx.nodeMap.get(firstSrc.nodeId);
  const isNbrPath = sources.length === 1
    && firstSrcNode?.data.nodeType === 'getNeighborsAttribute';

  const cmpOp: string = (() => {
    switch (op) {
      case 'noneIs':                        return '!=';
      case 'allGreater': case 'anyGreater': return '>';
      case 'allLesser':  case 'anyLesser':  return '<';
      default:                              return '==';
    }
  })();

  const acc = emitVar(ctx, 'bool', isAll ? 'true' : 'false', 'gs');
  const xExpr = castTo(x, 'f32');

  const accumLine = isAll
    ? `${acc.name} = ${acc.name} && (cmp_${acc.name});`
    : `${acc.name} = ${acc.name} || (cmp_${acc.name});`;

  const arrRef = sources.length === 1 && !isNbrPath
    && firstSrcNode && isArrayProducer(firstSrcNode.data.nodeType)
    ? compileArrayNode(ctx, firstSrc.nodeId) : null;

  if (isNbrPath) {
    const srcNode = firstSrcNode!;
    const nbrId = srcNode.data.config.neighborhoodId as string;
    const attrId = srcNode.data.config.attributeId as string;
    const nbr = getNbr(ctx.layout, nbrId);
    const attr = getAttr(ctx.layout, attrId);
    if (!nbr || !attr) {
      ctx.errors.push(`groupStatement: unknown nbr/attr`); return null;
    }
    const nVar = fresh(ctx, 'gn');
    ctx.lines.push(`  for (var ${nVar}: i32 = 0; ${nVar} < ${nbr.size}; ${nVar} = ${nVar} + 1) {`);
    const nbrSlot = nbr.wordOffset === 0
      ? `nbrIndices[i32(idx) * ${nbr.size} + ${nVar}]`
      : `nbrIndices[${nbr.wordOffset}i + i32(idx) * ${nbr.size} + ${nVar}]`;
    ctx.lines.push(`    let _nci_${nVar}: i32 = ${nbrSlot};`);
    const elem = readAttr(attr, `u32(_nci_${nVar})`, false);
    ctx.lines.push(`    let _e_${nVar}: ${elem.type} = ${elem.expr};`);
    const elemF = castTo({ expr: `_e_${nVar}`, type: elem.type }, 'f32');
    ctx.lines.push(`    let cmp_${acc.name}: bool = (${elemF} ${cmpOp} ${xExpr});`);
    ctx.lines.push(`    ${accumLine}`);
    ctx.lines.push(`  }`);
  } else if (arrRef) {
    const nVar = fresh(ctx, 'gan');
    ctx.lines.push(`  for (var ${nVar}: i32 = 0; ${nVar} < ${arrRef.lenName}; ${nVar} = ${nVar} + 1) {`);
    const elemF = castTo({ expr: arrLoad(arrRef, nVar), type: arrRef.elemType }, 'f32');
    ctx.lines.push(`    let cmp_${acc.name}: bool = (${elemF} ${cmpOp} ${xExpr});`);
    ctx.lines.push(`    ${accumLine}`);
    ctx.lines.push(`  }`);
  } else {
    let i = 0;
    for (const s of sources) {
      const r = compileValueNode(ctx, s.nodeId, s.portId);
      if (!r) return null;
      const ef = castTo(r, 'f32');
      ctx.lines.push(`  { let cmp_${acc.name}: bool = (${ef} ${cmpOp} ${xExpr}); ${accumLine} }`);
      void i; i++;
    }
  }
  const result: ValueRef = { expr: acc.name, type: 'bool' };
  setCachedPort(ctx, node.id, 'result', result);
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
    if (!ctx.allowAttrWrites) {
      ctx.errors.push(`setAttribute: cannot write attributes from outputMapping graph`); return false;
    }
    const v = inputs['value'];
    if (!v) { ctx.errors.push('setAttribute: missing value input'); return false; }
    const slot = attr.wordOffset === 0 ? `attrsWrite[idx]` : `attrsWrite[${attr.wordOffset}u + idx]`;
    ctx.lines.push(`  ${slot} = ${encodeAttrWord(attr.type, v.expr, v.type)};`);
    return true;
  },

  setColorViewer: ({ node, ctx, inputs }) => {
    const viewerId = (node.data.config.mappingId as string) || '';
    const viewerInt = ctx.viewerIds[viewerId];
    if (viewerInt === undefined) return true; // Unknown viewer — silently skip.

    const r = inputs['r'] ?? { expr: '0', type: 'i32' as WgslType };
    const g = inputs['g'] ?? { expr: '0', type: 'i32' as WgslType };
    const b = inputs['b'] ?? { expr: '0', type: 'i32' as WgslType };
    const re = `u32(clamp(${castTo(r, 'i32')}, 0, 255))`;
    const ge = `u32(clamp(${castTo(g, 'i32')}, 0, 255))`;
    const be = `u32(clamp(${castTo(b, 'i32')}, 0, 255))`;
    // Pack RGBA into a single u32 (little-endian: R in low byte).
    const packed = `(${re}) | ((${ge}) << 8u) | ((${be}) << 16u) | (255u << 24u)`;

    if (ctx.currentMappingId !== null) {
      // Inside an outputMapping shader: only write if THIS shader handles the
      // mapping. Other mappings' SetColorViewers are skipped at compile time.
      if (ctx.currentMappingId !== viewerId) return true;
      ctx.lines.push(`  colors[idx] = ${packed};`);
      return true;
    }

    // Step shader: guard on activeViewer so the compiled step writes the
    // currently-active mapping's colors (matches JS behaviour).
    ctx.lines.push(`  if (control.activeViewer == ${viewerInt}) {`);
    ctx.lines.push(`    colors[idx] = ${packed};`);
    ctx.lines.push(`  }`);
    return true;
  },

  setIndicator: ({ node, ctx, inputs }) => {
    const idxRaw = node.data.config._indicatorIdx;
    const idx = Number(idxRaw ?? -1);
    const id = ctx.layout.indicatorIds[idx];
    if (!id) { ctx.errors.push(`setIndicator: bad index ${idx}`); return false; }
    const v = inputs['value'] ?? { expr: '0.0', type: 'f32' as WgslType };
    // Last-writer-wins: every cell that hits this branch races to write its
    // value. Encoded as f32 bits in the atomic word.
    const ind = (ctx.model.indicators || []).find(i => i.id === id);
    const isInt = ind && ind.kind === 'standalone' && (ind.dataType === 'integer' || ind.dataType === 'tag' || ind.dataType === 'bool');
    if (isInt) {
      ctx.lines.push(`  atomicStore(&indicators[${idx}u], bitcast<u32>(${castTo(v, 'i32')}));`);
    } else {
      ctx.lines.push(`  atomicStore(&indicators[${idx}u], bitcast<u32>(${castTo(v, 'f32')}));`);
    }
    return true;
  },

  stopEvent: ({ node, ctx }) => {
    const stopIdx = Number(node.data.config._stopIdx ?? 0);
    if (!stopIdx) return true; // unresolved
    // First-cell-wins via CAS: only write the stop index when the flag is 0.
    ctx.lines.push(`  {`);
    ctx.lines.push(`    let _ce = atomicCompareExchangeWeak(&control.stopFlag, 0u, ${stopIdx}u);`);
    ctx.lines.push(`    _ = _ce.exchanged;`);
    ctx.lines.push(`  }`);
    return true;
  },

  updateIndicator: ({ node, ctx, inputs }) => {
    const idxRaw = node.data.config._indicatorIdx;
    const idx = Number(idxRaw ?? -1);
    const id = ctx.layout.indicatorIds[idx];
    if (!id) { ctx.errors.push(`updateIndicator: bad index ${idx}`); return false; }
    const op = (node.data.config.operation as string) || 'increment';
    const v = inputs['value'];
    const ind = (ctx.model.indicators || []).find(i => i.id === id);
    const isInt = ind && ind.kind === 'standalone' && (ind.dataType === 'integer' || ind.dataType === 'tag');
    const isBool = ind && ind.kind === 'standalone' && ind.dataType === 'bool';

    if (op === 'toggle' || op === 'next' || op === 'previous') {
      // Already rejected by detectWebGPUIncompatibilities — defensive guard.
      ctx.errors.push(`updateIndicator: op "${op}" not supported on WebGPU (order-dependent)`);
      return false;
    }

    if (op === 'or' || op === 'and') {
      if (!v) { ctx.errors.push(`updateIndicator ${op}: missing value`); return false; }
      // Bool indicator: stored as 0 or 1 (encoded as u32 0/1).
      const vb = castTo(v, 'bool');
      ctx.lines.push(`  if (${vb}) {`);
      if (op === 'or') ctx.lines.push(`    atomicOr(&indicators[${idx}u], 1u);`);
      else {
        // and: only stays true if all writes were true. Implementation: nothing
        // happens here; a "false" value should write 0. But atomicAnd on bool 1
        // with 0 returns 0. Compose: if value is true, OR 1 (no-op for true);
        // if value is false, AND with 0 (forces to 0).
        ctx.lines.push(`    atomicOr(&indicators[${idx}u], 0u);`); // no-op
      }
      ctx.lines.push(`  } else {`);
      if (op === 'or') ctx.lines.push(`    /* no-op: false doesn't change OR */`);
      else ctx.lines.push(`    atomicAnd(&indicators[${idx}u], 0u);`);
      ctx.lines.push(`  }`);
      return true;
    }

    if (!v) { ctx.errors.push(`updateIndicator ${op}: missing value`); return false; }

    if (isInt && (op === 'increment' || op === 'decrement')) {
      const vi = castTo(v, 'i32');
      const sign = op === 'increment' ? '' : '-';
      ctx.lines.push(`  atomicAdd(&indicators[${idx}u], bitcast<u32>(${sign}(${vi})));`);
      return true;
    }
    if (isInt && (op === 'max' || op === 'min')) {
      const vi = castTo(v, 'i32');
      const fn = op === 'max' ? 'atomicMax' : 'atomicMin';
      ctx.lines.push(`  ${fn}(&indicators[${idx}u], bitcast<u32>(${vi}));`);
      return true;
    }

    // Float (or integer used in float arithmetic): CAS loop. Indicator is a
    // f32 packed in u32 bits.
    const vf = castTo(v, 'f32');
    const fnExpr = (() => {
      switch (op) {
        case 'increment': return `(_old_f + (${vf}))`;
        case 'decrement': return `(_old_f - (${vf}))`;
        case 'max': return `max(_old_f, (${vf}))`;
        case 'min': return `min(_old_f, (${vf}))`;
        default:
          ctx.errors.push(`updateIndicator: unsupported op ${op}`);
          return null;
      }
    })();
    if (fnExpr === null) return false;
    ctx.lines.push(`  loop {`);
    ctx.lines.push(`    let _old_u: u32 = atomicLoad(&indicators[${idx}u]);`);
    ctx.lines.push(`    let _old_f: f32 = bitcast<f32>(_old_u);`);
    ctx.lines.push(`    let _new_f: f32 = ${fnExpr};`);
    ctx.lines.push(`    let _new_u: u32 = bitcast<u32>(_new_f);`);
    ctx.lines.push(`    let _r = atomicCompareExchangeWeak(&indicators[${idx}u], _old_u, _new_u);`);
    ctx.lines.push(`    if (_r.exchanged) { break; }`);
    ctx.lines.push(`  }`);
    void isBool;
    return true;
  },

  updateAttribute: ({ node, ctx, inputs }) => {
    const attrId = node.data.config.attributeId as string;
    const attr = getAttr(ctx.layout, attrId);
    if (!attr) { ctx.errors.push(`updateAttribute: unknown attr ${attrId}`); return false; }
    if (!ctx.allowAttrWrites) {
      ctx.errors.push(`updateAttribute: cannot write attributes from outputMapping graph`); return false;
    }
    const op = (node.data.config.operation as string) || 'increment';
    const v = inputs['value'];
    const tagLen = Number(node.data.config._tagLen) || 1;
    const wt = attrWgslType(attr.type);
    const slot = attr.wordOffset === 0 ? `attrsWrite[idx]` : `attrsWrite[${attr.wordOffset}u + idx]`;

    // Read current value from write buffer (matches JS read-modify-write).
    const cur = readAttr(attr, 'idx', true);
    const curRef = emitLet(ctx, cur.type, cur.expr, 'cur');

    let newExpr: string;
    if (op === 'next' || op === 'previous') {
      // Tag arithmetic with modulo
      const delta = op === 'next' ? '1' : `(${tagLen} - 1)`;
      newExpr = `((${castTo(curRef, 'i32')} + ${delta}) % ${tagLen})`;
      ctx.lines.push(`  ${slot} = ${encodeAttrWord(attr.type, newExpr, 'i32')};`);
      return true;
    }
    if (op === 'or' || op === 'and') {
      if (!v) { ctx.errors.push(`updateAttribute ${op}: missing value`); return false; }
      const cb = castTo(curRef, 'bool');
      const vb = castTo(v, 'bool');
      newExpr = op === 'or' ? `(${cb} || ${vb})` : `(${cb} && ${vb})`;
      ctx.lines.push(`  ${slot} = ${encodeAttrWord(attr.type, newExpr, 'bool')};`);
      return true;
    }
    if (op === 'toggle') {
      const cb = castTo(curRef, 'bool');
      newExpr = `!(${cb})`;
      ctx.lines.push(`  ${slot} = ${encodeAttrWord(attr.type, newExpr, 'bool')};`);
      return true;
    }
    if (!v) { ctx.errors.push(`updateAttribute ${op}: missing value`); return false; }

    const isF = wt === 'f32';
    const cExpr = isF ? castTo(curRef, 'f32') : castTo(curRef, 'i32');
    const vExpr = isF ? castTo(v, 'f32') : castTo(v, 'i32');
    switch (op) {
      case 'increment': newExpr = `(${cExpr} + ${vExpr})`; break;
      case 'decrement': newExpr = `(${cExpr} - ${vExpr})`; break;
      case 'max': newExpr = `max(${cExpr}, ${vExpr})`; break;
      case 'min': newExpr = `min(${cExpr}, ${vExpr})`; break;
      default:
        ctx.errors.push(`updateAttribute: unsupported op ${op}`); return false;
    }
    ctx.lines.push(`  ${slot} = ${encodeAttrWord(attr.type, newExpr, isF ? 'f32' : 'i32')};`);
    return true;
  },

  // Async-only nodes — pre-rejected by detectWebGPUIncompatibilities, but
  // defensive errors here in case the user bypasses validation.
  setNeighborhoodAttribute: ({ ctx }) => {
    ctx.errors.push(`setNeighborhoodAttribute: requires async update mode (incompatible with WebGPU)`);
    return false;
  },
  setNeighborAttributeByIndex: ({ ctx }) => {
    ctx.errors.push(`setNeighborAttributeByIndex: requires async update mode (incompatible with WebGPU)`);
    return false;
  },
};

// ---------------------------------------------------------------------------
// Orchestrator: compileValueNode / compileFlowChain / compileEntry
// ---------------------------------------------------------------------------

function compileValueNode(ctx: CompileCtx, nodeId: string, portId: string = 'value'): ValueRef | null {
  const cached = getCachedPort(ctx, nodeId, portId);
  if (cached) return cached;

  const node = ctx.nodeMap.get(nodeId);
  if (!node) { ctx.errors.push(`unknown node id ${nodeId}`); return null; }
  const def = getNodeDef(node.data.nodeType);
  if (!def) { ctx.errors.push(`unknown node def ${node.data.nodeType}`); return null; }

  if (node.data.nodeType === 'inputColor'
    || node.data.nodeType === 'step'
    || node.data.nodeType === 'outputMapping') {
    ctx.errors.push(`compileValueNode: entry-point node "${node.data.nodeType}" has no value emit for "${portId}"`);
    return null;
  }

  if (node.data.nodeType === 'macro' || node.data.nodeType === 'macroInput' || node.data.nodeType === 'macroOutput') {
    // Macros should have been expanded BEFORE compilation. If we hit one here
    // it's a bug in expandMacros — surface a clear diagnostic.
    ctx.errors.push(`Macro instance "${node.id}" survived expansion; please file a bug.`);
    return null;
  }

  const emitter = VALUE_NODE_EMITTERS[node.data.nodeType];
  if (!emitter) {
    ctx.errors.push(`No WebGPU value emitter for "${node.data.nodeType}"`);
    return null;
  }

  // Resolve scalar value inputs (skip arrays — handled by aggregate/etc dispatch).
  const inputs: Record<string, ValueRef | undefined> = {};
  for (const port of def.ports) {
    if (port.kind !== 'input' || port.category !== 'value') continue;
    if (port.isArray) continue;
    const source = ctx.inputToSource.get(`${nodeId}:${port.id}`);
    if (source) {
      const srcRef = compileValueNode(ctx, source.nodeId, source.portId);
      if (!srcRef) return null;
      inputs[port.id] = srcRef;
    } else {
      const inlineVal = getInlineValue(port, node.data.config);
      if (inlineVal !== undefined) {
        inputs[port.id] = inlineValueRef(inlineVal, port.dataType === 'float');
      }
    }
  }

  const result = emitter({ ctx, node, inputs });
  if (!result) return null;
  if (!getCachedPort(ctx, node.id, 'value')) setCachedPort(ctx, node.id, 'value', result);
  const outputPorts = def.ports.filter(p => p.kind === 'output' && p.category === 'value');
  if (outputPorts.length === 1 && !getCachedPort(ctx, node.id, outputPorts[0]!.id)) {
    setCachedPort(ctx, node.id, outputPorts[0]!.id, result);
  }
  if (!getCachedPort(ctx, node.id, portId)) setCachedPort(ctx, node.id, portId, result);
  return getCachedPort(ctx, nodeId, portId) ?? result;
}

/**
 * Pre-emit pass: walks the entire flow chain reachable from `(sourceNodeId,
 * sourcePortId)` and compiles every value node referenced by any flow-node's
 * input ports. After this, all value `let`/`var` declarations live at the
 * entry-point's top scope, so subsequent `compileFlowChain` references resolve
 * regardless of which control-flow branch they appear in.
 *
 * Without this pass, a value computed inside one `if` branch is NOT visible
 * in the sibling `else` branch (WGSL var/let are block-scoped). Mirrors the
 * WASM compiler's `preEmitValueNodes`.
 *
 * Side effects (RNG advance, aggregate loops) move OUT of conditional branches
 * — same trade-off the JS/WASM compilers make. Documented in CLAUDE.md.
 */
function preEmitValueNodes(ctx: CompileCtx, sourceNodeId: string, sourcePortId: string, visited: Set<string>): void {
  const targets = ctx.flowOutputToTargets.get(`${sourceNodeId}:${sourcePortId}`) ?? [];
  for (const target of targets) {
    const node = ctx.nodeMap.get(target.nodeId);
    if (!node) continue;
    const def = getNodeDef(node.data.nodeType);
    if (!def) continue;

    for (const port of def.ports) {
      if (port.kind !== 'input' || port.category !== 'value') continue;
      const src = ctx.inputToSource.get(`${target.nodeId}:${port.id}`);
      const srcs = ctx.inputToSources.get(`${target.nodeId}:${port.id}`);
      // Array inputs: dispatch the source through compileArrayNode so the
      // private-array decl is emitted at the entry-point top scope (cross-
      // branch references resolve same as scalar values do).
      if (port.isArray) {
        if (src && ctx.nodeMap.get(src.nodeId) && isArrayProducer(ctx.nodeMap.get(src.nodeId)!.data.nodeType)) {
          compileArrayNode(ctx, src.nodeId);
        }
        if (srcs) for (const s of srcs) {
          const sn = ctx.nodeMap.get(s.nodeId);
          if (sn && isArrayProducer(sn.data.nodeType)) compileArrayNode(ctx, s.nodeId);
        }
        continue;
      }
      if (src) compileValueNode(ctx, src.nodeId, src.portId);
      if (srcs) for (const s of srcs) compileValueNode(ctx, s.nodeId, s.portId);
    }

    if (visited.has(target.nodeId)) continue;
    visited.add(target.nodeId);

    switch (node.data.nodeType) {
      case 'conditional':
        preEmitValueNodes(ctx, target.nodeId, 'then', visited);
        preEmitValueNodes(ctx, target.nodeId, 'else', visited);
        break;
      case 'sequence':
        preEmitValueNodes(ctx, target.nodeId, 'first', visited);
        preEmitValueNodes(ctx, target.nodeId, 'then', visited);
        break;
      case 'loop':
        preEmitValueNodes(ctx, target.nodeId, 'body', visited);
        break;
      case 'switch': {
        const caseCount = Number(node.data.config.caseCount) || 0;
        for (let ci = 0; ci < caseCount; ci++) {
          preEmitValueNodes(ctx, target.nodeId, `case_${ci}`, visited);
          const caseValSrc = ctx.inputToSource.get(`${target.nodeId}:case_${ci}_val`);
          if (caseValSrc) compileValueNode(ctx, caseValSrc.nodeId, caseValSrc.portId);
          const caseCondSrc = ctx.inputToSource.get(`${target.nodeId}:case_${ci}_cond`);
          if (caseCondSrc) compileValueNode(ctx, caseCondSrc.nodeId, caseCondSrc.portId);
        }
        preEmitValueNodes(ctx, target.nodeId, 'default', visited);
        const valSrc = ctx.inputToSource.get(`${target.nodeId}:value`);
        if (valSrc) compileValueNode(ctx, valSrc.nodeId, valSrc.portId);
        break;
      }
    }
  }
}

function compileFlowChain(ctx: CompileCtx, sourceNodeId: string, sourcePortId: string): boolean {
  const targets = ctx.flowOutputToTargets.get(`${sourceNodeId}:${sourcePortId}`) ?? [];
  for (const target of targets) {
    const node = ctx.nodeMap.get(target.nodeId);
    if (!node) continue;
    const def = getNodeDef(node.data.nodeType);
    if (!def) continue;

    if (node.data.nodeType === 'conditional') {
      const condSource = ctx.inputToSource.get(`${node.id}:condition`);
      let condRef: ValueRef;
      if (condSource) {
        const r = compileValueNode(ctx, condSource.nodeId, condSource.portId);
        if (!r) return false;
        condRef = r;
      } else {
        const condPort = def.ports.find(p => p.id === 'condition');
        const inlineVal = condPort ? getInlineValue(condPort, node.data.config) : undefined;
        const n = parseInlineNum(inlineVal, 0);
        condRef = { expr: n ? 'true' : 'false', type: 'bool' };
      }
      const cb = castTo(condRef, 'bool');
      const hasElse = ctx.flowOutputToTargets.has(`${node.id}:else`);
      ctx.lines.push(`  if (${cb}) {`);
      if (!compileFlowChain(ctx, node.id, 'then')) return false;
      if (hasElse) {
        ctx.lines.push(`  } else {`);
        if (!compileFlowChain(ctx, node.id, 'else')) return false;
      }
      ctx.lines.push(`  }`);
    } else if (node.data.nodeType === 'sequence') {
      if (!compileFlowChain(ctx, node.id, 'first')) return false;
      if (!compileFlowChain(ctx, node.id, 'then')) return false;
    } else if (node.data.nodeType === 'loop') {
      const countSrc = ctx.inputToSource.get(`${node.id}:count`);
      let countRef: ValueRef;
      if (countSrc) {
        const r = compileValueNode(ctx, countSrc.nodeId, countSrc.portId);
        if (!r) return false;
        countRef = r;
      } else {
        const port = def.ports.find(p => p.id === 'count');
        const inlineVal = port ? getInlineValue(port, node.data.config) : undefined;
        countRef = { expr: `${parseInlineNum(inlineVal, 1) | 0}`, type: 'i32' };
      }
      const cnt = castTo(countRef, 'i32');
      const li = fresh(ctx, 'li');
      ctx.lines.push(`  for (var ${li}: i32 = 0; ${li} < ${cnt}; ${li} = ${li} + 1) {`);
      if (!compileFlowChain(ctx, node.id, 'body')) return false;
      ctx.lines.push(`  }`);
    } else if (node.data.nodeType === 'switch') {
      const mode = (node.data.config.mode as string) || 'conditions';
      const firstMatchOnly = node.data.config.firstMatchOnly !== false;
      const valType = (node.data.config.valueType as string) || 'integer';
      const caseCount = Number(node.data.config.caseCount) || 0;
      const hasDefault = ctx.flowOutputToTargets.has(`${node.id}:default`);
      if (caseCount === 0) {
        if (!compileFlowChain(ctx, node.id, 'default')) return false;
        continue;
      }
      let valueRef: ValueRef | null = null;
      if (mode === 'value') {
        const valSrc = ctx.inputToSource.get(`${node.id}:value`);
        if (valSrc) {
          const r = compileValueNode(ctx, valSrc.nodeId, valSrc.portId);
          if (!r) return false;
          valueRef = r;
        } else {
          const port = def.ports.find(p => p.id === 'value');
          const inlineVal = port ? getInlineValue(port, node.data.config) : undefined;
          const n = parseInlineNum(inlineVal, 0);
          valueRef = valType === 'float' ? { expr: `${n}.0`, type: 'f32' } : { expr: `${n | 0}`, type: 'i32' };
        }
      }
      const caseConds: string[] = [];
      for (let ci = 0; ci < caseCount; ci++) {
        if (mode === 'conditions') {
          const condSrc = ctx.inputToSource.get(`${node.id}:case_${ci}_cond`);
          if (condSrc) {
            const r = compileValueNode(ctx, condSrc.nodeId, condSrc.portId);
            if (!r) return false;
            caseConds.push(castTo(r, 'bool'));
          } else {
            const inlineRaw = node.data.config[`_port_case_${ci}_cond`];
            caseConds.push(inlineRaw === 'true' ? 'true' : 'false');
          }
        } else {
          const caseValSrc = ctx.inputToSource.get(`${node.id}:case_${ci}_val`);
          let caseValRef: ValueRef;
          if (caseValSrc) {
            const r = compileValueNode(ctx, caseValSrc.nodeId, caseValSrc.portId);
            if (!r) return false;
            caseValRef = r;
          } else {
            const raw = node.data.config[`_port_case_${ci}_val`] ?? node.data.config[`case_${ci}_value`] ?? 0;
            const num = parseFloat(String(raw));
            const n = Number.isFinite(num) ? num : 0;
            caseValRef = valType === 'float' ? { expr: `${n}.0`, type: 'f32' } : { expr: `${n | 0}`, type: 'i32' };
          }
          const cmpOp = (node.data.config[`case_${ci}_op`] as string) || '==';
          if (valType === 'float') {
            caseConds.push(`(${castTo(valueRef!, 'f32')} ${cmpOp === '===' ? '==' : cmpOp === '!==' ? '!=' : cmpOp} ${castTo(caseValRef, 'f32')})`);
          } else {
            caseConds.push(`(${castTo(valueRef!, 'i32')} ${cmpOp === '===' ? '==' : cmpOp === '!==' ? '!=' : cmpOp} ${castTo(caseValRef, 'i32')})`);
          }
        }
      }
      if (firstMatchOnly) {
        const open = (ci: number): boolean => {
          if (ci >= caseCount) {
            if (hasDefault) return compileFlowChain(ctx, node.id, 'default');
            return true;
          }
          ctx.lines.push(`  if (${caseConds[ci]}) {`);
          if (!compileFlowChain(ctx, node.id, `case_${ci}`)) return false;
          ctx.lines.push(`  } else {`);
          if (!open(ci + 1)) return false;
          ctx.lines.push(`  }`);
          return true;
        };
        if (!open(0)) return false;
      } else {
        const matched = fresh(ctx, 'sm');
        ctx.lines.push(`  var ${matched}: bool = false;`);
        for (let ci = 0; ci < caseCount; ci++) {
          ctx.lines.push(`  if (${caseConds[ci]}) {`);
          ctx.lines.push(`    ${matched} = true;`);
          if (!compileFlowChain(ctx, node.id, `case_${ci}`)) return false;
          ctx.lines.push(`  }`);
        }
        if (hasDefault) {
          ctx.lines.push(`  if (!${matched}) {`);
          if (!compileFlowChain(ctx, node.id, 'default')) return false;
          ctx.lines.push(`  }`);
        }
      }
    } else {
      const inputs: Record<string, ValueRef | undefined> = {};
      for (const port of def.ports) {
        if (port.kind !== 'input' || port.category !== 'value') continue;
        if (port.isArray) continue;
        const source = ctx.inputToSource.get(`${node.id}:${port.id}`);
        if (source) {
          const srcRef = compileValueNode(ctx, source.nodeId, source.portId);
          if (!srcRef) return false;
          inputs[port.id] = srcRef;
        } else {
          const inlineVal = getInlineValue(port, node.data.config);
          if (inlineVal !== undefined) {
            inputs[port.id] = inlineValueRef(inlineVal, port.dataType === 'float');
          }
        }
      }
      const flowEmitter = FLOW_NODE_EMITTERS[node.data.nodeType];
      if (!flowEmitter) {
        ctx.errors.push(`No WebGPU flow emitter for "${node.data.nodeType}"`);
        return false;
      }
      if (!flowEmitter({ ctx, node, inputs })) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Entry point compile
// ---------------------------------------------------------------------------

interface EntryOpts {
  entry: GraphNode;
  /** Function name in the emitted shader. */
  fnName: string;
  /** True for step (writes attrs); false for outputMapping (no attr writes). */
  emitCopyPreamble: boolean;
  allowAttrWrites: boolean;
  /** Non-null for outputMapping shaders — restricts setColorViewer. */
  currentMappingId: string | null;
}

function compileEntry(opts: EntryOpts, base: Omit<CompileCtx, 'lines' | 'valueLocals' | 'arrayRefs' | 'localCounter' | 'errors' | 'currentMappingId' | 'allowAttrWrites'>): { code: string; errors: string[] } {
  const ctx: CompileCtx = {
    ...base,
    lines: [],
    valueLocals: new Map(),
    arrayRefs: new Map(),
    localCounter: 0,
    errors: [],
    currentMappingId: opts.currentMappingId,
    allowAttrWrites: opts.allowAttrWrites,
  };
  if (opts.emitCopyPreamble) {
    // Bulk per-cell copy first
    const copy = emitPerCellCopyPreamble(ctx.layout);
    if (copy) ctx.lines.push(copy.replace(/\n$/, ''));
  }
  // Pre-emit ALL referenced value nodes at the top scope so subsequent
  // references inside conditional branches resolve correctly.
  preEmitValueNodes(ctx, opts.entry.id, 'do', new Set());
  if (ctx.errors.length > 0) return { code: '', errors: ctx.errors };
  // Compile the flow chain rooted at the entry node's `do` port.
  compileFlowChain(ctx, opts.entry.id, 'do');
  if (ctx.errors.length > 0) return { code: '', errors: ctx.errors };
  const body = ctx.lines.join('\n') + '\n';
  return { code: emitEntryPoint(opts.fnName, ctx.layout.total, body), errors: [] };
}

// ---------------------------------------------------------------------------
// Macro expansion — inline every `macro` instance in `graphNodes` into the
// graph by copying the macroDef's internal nodes (with prefixed ids) and
// rewriting edges to bridge external sources/targets through what would have
// been the macroInput/macroOutput boundary nodes. Mirrors the WASM compiler's
// `expandMacros`.
//
// Recursion guard: macros can contain macros; max depth 20 mirrors WASM.
// ---------------------------------------------------------------------------

function parseHandleSimple(handleId: string | undefined): { category: 'value' | 'flow'; portId: string } | null {
  if (!handleId) return null;
  const m = handleId.match(/^(?:input|output)_(value|flow)_(.+)$/);
  if (!m) return null;
  return { category: m[1] as 'value' | 'flow', portId: m[2]! };
}

function expandMacros(
  graphNodes: GraphNode[], graphEdges: GraphEdge[], model: CAModel, depth = 0,
): { nodes: GraphNode[]; edges: GraphEdge[]; error?: string } {
  if (depth > 20) return { nodes: graphNodes, edges: graphEdges, error: 'macro recursion depth > 20' };
  const macroInstances = graphNodes.filter(n => n.data.nodeType === 'macro');
  if (macroInstances.length === 0) return { nodes: graphNodes, edges: graphEdges };

  const macroDefs = model.macroDefs ?? [];
  const edgesByTarget = new Map<string, GraphEdge[]>();
  const edgesBySource = new Map<string, GraphEdge[]>();
  for (const e of graphEdges) {
    const t = edgesByTarget.get(e.target); if (t) t.push(e); else edgesByTarget.set(e.target, [e]);
    const s = edgesBySource.get(e.source); if (s) s.push(e); else edgesBySource.set(e.source, [e]);
  }

  const removedNodeIds = new Set(macroInstances.map(m => m.id));
  const newNodes: GraphNode[] = [];
  const newEdges: GraphEdge[] = [];

  for (const n of graphNodes) if (!removedNodeIds.has(n.id)) newNodes.push(n);
  for (const e of graphEdges) {
    if (!removedNodeIds.has(e.source) && !removedNodeIds.has(e.target)) newEdges.push(e);
  }

  for (const m of macroInstances) {
    const def = macroDefs.find(d => d.id === m.data.config.macroDefId);
    if (!def) continue;
    const prefix = `m${m.id}_`;

    const extInMap = new Map<string, { source: string; sourceHandle: string }>();
    const extInArr = edgesByTarget.get(m.id) ?? [];
    for (const e of extInArr) extInMap.set(e.targetHandle ?? '', { source: e.source, sourceHandle: e.sourceHandle ?? '' });
    const extOutArr = edgesBySource.get(m.id) ?? [];

    for (const inner of def.nodes) {
      if (inner.data.nodeType === 'macroInput' || inner.data.nodeType === 'macroOutput') continue;
      newNodes.push({ ...inner, id: prefix + inner.id });
    }

    for (const e of def.edges) {
      const srcInner = def.nodes.find(n => n.id === e.source);
      const tgtInner = def.nodes.find(n => n.id === e.target);
      const srcIsBoundary = srcInner?.data.nodeType === 'macroInput' || srcInner?.data.nodeType === 'macroOutput';
      const tgtIsBoundary = tgtInner?.data.nodeType === 'macroInput' || tgtInner?.data.nodeType === 'macroOutput';
      if (srcIsBoundary && tgtIsBoundary) continue;

      if (srcInner?.data.nodeType === 'macroInput') {
        const ep = parseHandleSimple(e.sourceHandle);
        const epPortId = ep?.portId ?? e.sourceHandle ?? '';
        let ext: { source: string; sourceHandle: string } | undefined;
        for (const [th, src] of extInMap) {
          const parsed = parseHandleSimple(th);
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
        const epPortId = parseHandleSimple(e.targetHandle)?.portId ?? e.targetHandle ?? '';
        for (const eOut of extOutArr) {
          const epExt = parseHandleSimple(eOut.sourceHandle);
          if (epExt?.portId !== epPortId) continue;
          newEdges.push({
            ...eOut,
            source: prefix + e.source,
            sourceHandle: e.sourceHandle,
          });
        }
        continue;
      }

      newEdges.push({
        ...e,
        id: prefix + e.id,
        source: prefix + e.source,
        target: prefix + e.target,
      });
    }
  }

  return expandMacros(newNodes, newEdges, model, depth + 1);
}

// ---------------------------------------------------------------------------
// Top-level compile
// ---------------------------------------------------------------------------

export function compileGraphWebGPU(
  graphNodes: GraphNode[],
  graphEdges: GraphEdge[],
  model: CAModel,
): WebGPUCompileResult {
  const layout = computeWebGPULayout(model);

  // Expand macro instances first so the rest of the compile sees a flat graph.
  const expanded = expandMacros(graphNodes, graphEdges, model);
  if (expanded.error) {
    return {
      shaderCode: '', entryPoints: { step: 'step', outputMappings: [] },
      layout, stopMessages: [], viewerIds: {}, error: expanded.error,
    };
  }
  graphNodes = expanded.nodes;
  graphEdges = expanded.edges;

  // Stop messages flat list — index in `_stopIdx` (1-based; 0 means no stop).
  // After expansion the graph is flat, so we only walk graphNodes (no macroDef descent).
  const stopMessages: string[] = [];
  for (const n of graphNodes) {
    if (n.data.nodeType === 'stopEvent') {
      const idx = Number(n.data.config._stopIdx ?? 0);
      const msg = String(n.data.config.message ?? n.data.config.stopMessage ?? '');
      if (idx > 0) {
        while (stopMessages.length < idx) stopMessages.push('');
        stopMessages[idx - 1] = msg;
      }
    }
  }

  // Viewer ids (one per attribute→color mapping).
  const viewerIds: Record<string, number> = {};
  let vi = 0;
  for (const m of (model.mappings || [])) {
    if (m.isAttributeToColor) viewerIds[m.id] = vi++;
  }

  const baseResult: WebGPUCompileResult = {
    shaderCode: '', entryPoints: { step: 'step', outputMappings: [] },
    layout, stopMessages, viewerIds,
  };

  // Compile-time rejections.
  const modelErr = detectWebGPUModelIncompatibilities(model);
  if (modelErr) return { ...baseResult, error: modelErr };
  for (const n of graphNodes) {
    const issues = detectWebGPUIncompatibilities(n.data.nodeType, n.data.config, model);
    if (issues.length > 0) return { ...baseResult, error: `Node "${n.data.nodeType}": ${issues[0]}` };
  }

  const adj = buildAdjacency(graphNodes, graphEdges, model);

  // Max neighbourhood size — used to size per-thread `var arr<T, N>` arrays for
  // array-producing nodes (filterNeighbors, getNeighborsAttrByIndexes, etc).
  // Floor of 1 so the WGSL `array<T, 1>` declaration is always valid.
  let maxArraySize = 1;
  for (const n of layout.nbrs) if (n.size > maxArraySize) maxArraySize = n.size;

  const baseCtx: Omit<CompileCtx, 'lines' | 'valueLocals' | 'arrayRefs' | 'localCounter' | 'errors' | 'currentMappingId' | 'allowAttrWrites'> = {
    model, layout, viewerIds, stopMessages, maxArraySize,
    nodeMap: adj.nodeMap,
    inputToSource: adj.inputToSource,
    inputToSources: adj.inputToSources,
    flowOutputToTargets: adj.flowOutputToTargets,
  };

  // Step entry point — root is the (typically single) Step node.
  const stepNodes = graphNodes.filter(n => n.data.nodeType === 'step');
  if (stepNodes.length === 0) {
    // No step graph — emit a no-op. Mirror copy preamble so attrs propagate.
    const copy = emitPerCellCopyPreamble(layout);
    const stepBody = copy ? copy.replace(/\n$/, '') + '\n' : '\n';
    const stepCode = emitEntryPoint('step', layout.total, stepBody);
    const sections: string[] = [emitBindings(layout), stepCode];
    return { ...baseResult, shaderCode: sections.join('\n'), entryPoints: { step: 'step', outputMappings: [] } };
  }

  const sections: string[] = [emitBindings(layout)];
  // Compile the step entry. Use the first step node — additional ones are ignored
  // (matches JS/WASM behaviour).
  const stepEntry = compileEntry({
    entry: stepNodes[0]!,
    fnName: 'step',
    emitCopyPreamble: true,
    allowAttrWrites: true,
    currentMappingId: null,
  }, baseCtx);
  if (stepEntry.errors.length > 0) {
    return { ...baseResult, error: stepEntry.errors.join('; ') };
  }
  sections.push(stepEntry.code);

  // Per-mapping output shaders. Each compiles the OutputMapping graph rooted at
  // the matching outputMapping node. Mappings without a matching root get a
  // no-op shader (idempotent w.r.t. colors).
  const outputMappings: Array<{ mappingId: string; entry: string }> = [];
  const outputNodes = graphNodes.filter(n => n.data.nodeType === 'outputMapping');
  for (const m of (model.mappings || [])) {
    if (!m.isAttributeToColor) continue;
    const fnName = 'outputMapping_' + sanitiseWgslName(m.id);
    const root = outputNodes.find(o => (o.data.config as Record<string, unknown>).mappingId === m.id);
    if (!root) {
      // No graph — emit empty body; runtime can still bind it.
      sections.push(emitEntryPoint(fnName, layout.total, '\n'));
      outputMappings.push({ mappingId: m.id, entry: fnName });
      continue;
    }
    const omEntry = compileEntry({
      entry: root,
      fnName,
      emitCopyPreamble: false,
      allowAttrWrites: false,
      currentMappingId: m.id,
    }, baseCtx);
    if (omEntry.errors.length > 0) {
      return { ...baseResult, error: `OutputMapping "${m.name}": ${omEntry.errors.join('; ')}` };
    }
    sections.push(omEntry.code);
    outputMappings.push({ mappingId: m.id, entry: fnName });
  }

  return {
    ...baseResult,
    shaderCode: sections.join('\n'),
    entryPoints: { step: 'step', outputMappings },
  };
}

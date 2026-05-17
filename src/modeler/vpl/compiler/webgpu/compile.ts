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

import type { Attribute, CAModel, GraphEdge, GraphNode } from '../../../../model/types';
import { computeWebGPULayout, type WebGPULayout, type WebGPULayoutAttr, type WebGPULayoutNbr } from './layout';
import {
  emitBindings, emitEntryPoint, emitPerCellCopyPreamble, sanitiseWgslName,
} from './encoder';
import { getNodeDef } from '../../nodes/registry';
import { readColorScaleStops } from '../../nodes/ColorScaleNode';
import { parseHandleId } from '../../types';
import {
  detectWebGPUIncompatibilities, detectWebGPUModelIncompatibilities,
} from '../../nodes/nodeValidation';
import { getInlineValue, parseInlineNum } from '../inlinePort';
import { INVALID_NI, packNI, NI_ARRAY_PRODUCERS } from '../niCodec';
import { analyzeSinkScopes, CELL_TOP, type ScopeId, type SinkAnalysisResult } from '../sinkAnalysis';
import { subAttrInfo, subAttributesOf } from '../subAttribute';
import { emitWgsl } from '../expression/emitWgsl';
import { buildVarMap, parseExpression, clampVisibleCount } from '../expression/parser';

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
  viewerIds: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WgslType = 'f32' | 'i32' | 'bool';

/** Exported so the Expression node's WGSL emitter (compiler/expression/emitWgsl.ts)
 *  can type its `inputs` map. */
export interface ValueRef {
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
  /** Compile-time upper bound on the array's length (and hence its WGSL
   *  storage size). Producers tighten this from the global `maxArraySize`
   *  default — e.g. getNeighborIndexesByTags knows it emits exactly
   *  `_resolvedTagIndexes.length` entries. Tighter bounds mean smaller
   *  per-thread `var<function>` arrays and less register pressure on
   *  workgroup-heavy models like MNCA (was 360-cell × 4-byte arrays per
   *  thread; with bounds-tightening, often <50). */
  maxLen: number;
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
  /** sourceNodeId → total outgoing edge count (across all ports). Used to
   *  detect single-consumer patterns for fusion (O6: when an array producer
   *  has exactly one consumer, the consumer can fuse the gather into its own
   *  loop and skip materialising the array). */
  outDegree: Map<string, number>;

  /** Lines accumulated for the current entry point's body. */
  lines: string[];
  /** Multi-output node cache: nodeId → portId → ValueRef. */
  valueLocals: Map<string, Map<string, ValueRef>>;
  /** Per-node ArrayRef cache. Used by isArrayProducer dispatch. */
  arrayRefs: Map<string, ArrayRef>;
  /** Sink-scope analysis for the current entry's flow tree. Tells us, for
   *  every value-producing node, the deepest scope where it can be emitted
   *  such that all uses are dominated. Set in compileEntry. */
  sinkAnalysis?: SinkAnalysisResult;
  /** Per-scope buffers for sunk value emissions. Each value's emit lines land
   *  in branchLines[emitScope[nodeId]] (cellTop → ctx.lines directly) and
   *  flushBranchValues drains them into ctx.lines when the flow walk enters
   *  the matching branch. */
  branchLines: Map<ScopeId, string[]>;
  /** Flat post-macro-expansion graph; needed to feed the sink analyzer. */
  graphNodes: GraphNode[];
  graphEdges: GraphEdge[];
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
  outDegree: Map<string, number>;
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
  const outDegree = new Map<string, number>();

  for (const edge of graphEdges) {
    const sh = parseHandleId(edge.sourceHandle);
    const th = parseHandleId(edge.targetHandle);
    if (!sh || !th) continue;
    outDegree.set(edge.source, (outDegree.get(edge.source) ?? 0) + 1);
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

  return { nodeMap, inputToSource, inputToSources, flowOutputToTargets, outDegree };
}

function getAttr(layout: WebGPULayout, id: string): WebGPULayoutAttr | null {
  return layout.attrs.find(a => a.id === id) ?? null;
}
function getNbr(layout: WebGPULayout, id: string): WebGPULayoutNbr | null {
  return layout.nbrs.find(n => n.id === id) ?? null;
}

/** Emit the WGSL expression that produces the linear cell index of neighbour
 *  `kExpr` of cell `idx` in neighbourhood `nbr`. Replaces the legacy per-cell
 *  `nbrIndices[wordOffset + idx*size + k]` lookup with a call into the shared
 *  `nbrCellIdx` helper (see encoder.ts emitBindings) — the helper does the
 *  (dRow, dCol) lookup + boundary math inline. */
function emitNbrCellIdx(nbr: WebGPULayoutNbr, kExpr: string): string {
  return `nbrCellIdx(idx, ${nbr.wordOffset}u, ${kExpr})`;
}

/** Wave A.6: emit the WGSL expression that produces the cell index reached by
 *  applying packed NI `niExpr` from cell `idx`. Decodes (dr, dc) inline and
 *  applies the model's boundary treatment. */
function emitNiCellIdx(niExpr: string): string {
  return `nbrCellIdxFromNi(idx, ${niExpr})`;
}

function attrWgslType(t: string): WgslType {
  if (t === 'float') return 'f32';
  if (t === 'bool') return 'bool';
  return 'i32'; // integer, tag
}

function fresh(ctx: CompileCtx, prefix: string = 'l'): string {
  return `_${prefix}${ctx.localCounter++}`;
}

/** Run `emit` with ctx.lines redirected into a fresh buffer, then route the
 *  captured lines based on the analyzer's emit scope for `nodeId`:
 *   - CELL_TOP (or no analysis result) → push directly to ctx.lines (current
 *     behaviour).
 *   - deeper scope → append to ctx.branchLines[scope]; flushBranchValues
 *     will drain it when the flow walk enters that branch.
 *
 * Captures only the emitter's OWN push'es. Any recursive `compileValueNode`
 * calls the emitter triggers (e.g., for inputs) have already routed their
 * own emissions before this wrapper saw them, since inputs are resolved
 * upstream of the wrapped emit call. */
function routeEmissionForNode<T>(ctx: CompileCtx, nodeId: string, emit: () => T): T {
  const scope = ctx.sinkAnalysis?.emitScope.get(nodeId) ?? CELL_TOP;
  if (scope === CELL_TOP) return emit();
  const original = ctx.lines;
  const captured: string[] = [];
  ctx.lines = captured;
  let result: T;
  try {
    result = emit();
  } finally {
    ctx.lines = original;
  }
  let arr = ctx.branchLines.get(scope);
  if (!arr) { arr = []; ctx.branchLines.set(scope, arr); }
  for (const line of captured) arr.push(line);
  return result;
}

function flushBranchValues(ctx: CompileCtx, scope: ScopeId): void {
  const arr = ctx.branchLines.get(scope);
  if (!arr || arr.length === 0) return;
  for (const line of arr) ctx.lines.push(line);
  arr.length = 0;
}

function emitLet(ctx: CompileCtx, type: WgslType, expr: string, prefix: string = 'l'): ValueRef {
  const name = fresh(ctx, prefix);
  ctx.lines.push(`  let ${name}: ${type} = ${expr};`);
  return { expr: name, type };
}

/**
 * Build a WGSL expression that computes the interpolation curve f(t) for the
 * given method. Mirrors `emitInterpolationCurveJS` in
 * `nodes/interpolationMethods.ts` and the WASM variant.
 *
 * For non-linear methods, t is clamped to [0, 1] before applying the curve;
 * `linear` keeps unclamped extrapolation to match the JS / WASM behaviour.
 */
function wgslInterpolationCurveExpr(tExpr: string, method: string): string {
  if (method === 'linear') return `(${tExpr})`;
  const tcl = `clamp((${tExpr}), 0.0, 1.0)`;
  switch (method) {
    case 'smoothstep':
      // Use a let to evaluate clamp once. We inline via a function-call to a
      // builtin pattern — wrap the body in a select-free expression.
      return `(${tcl}) * (${tcl}) * (3.0 - 2.0 * (${tcl}))`;
    case 'easeInQuad':
      return `(${tcl}) * (${tcl})`;
    case 'easeOutQuad':
      return `(1.0 - (1.0 - (${tcl})) * (1.0 - (${tcl})))`;
    case 'exponential':
      // tcl > 0 ? pow(2, 10*(tcl-1)) : 0
      return `select(0.0, pow(2.0, 10.0 * ((${tcl}) - 1.0)), (${tcl}) > 0.0)`;
    case 'logarithmic':
      // tcl < 1 ? 1 - pow(2, -10*tcl) : 1
      return `select(1.0, (1.0 - pow(2.0, -10.0 * (${tcl}))), (${tcl}) < 1.0)`;
    default:
      return `(${tcl})`;
  }
}
function emitVar(ctx: CompileCtx, type: WgslType, expr: string, prefix: string = 'v'): { name: string; type: WgslType } {
  const name = fresh(ctx, prefix);
  ctx.lines.push(`  var ${name}: ${type} = ${expr};`);
  return { name, type };
}

/** Coerce a ValueRef to the requested WGSL type.
 *  Exported for the Expression node's WGSL emitter (compiler/expression/emitWgsl.ts). */
export function castTo(v: ValueRef, want: WgslType): string {
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

// ---------------------------------------------------------------------------
// Sub-attribute helpers (WGSL-specific guard / literal emission)
//
// All three guard sites compare the parent's raw u32 slot against literal
// u32 values — bool stored as 0/1, tag stored as bitcast<u32>(int) which
// for non-negative tag indices equals u32(index). Scalar reads (current
// cell, fixed neighbour idx) wrap the raw `readAttr` with `select(undef,
// raw, parent_match)`. Iteration consumer loops use the same `parent_match`
// expression as a `continue` predicate (the cell isn't part of the
// effective neighbourhood from the user's perspective).
// ---------------------------------------------------------------------------

/** WGSL boolean expression: true when the parent attribute at `idxExpr` holds
 *  one of `parentValues`. `parent` must be a Tag or Boolean cell attribute. */
function parentMatchExprWgsl(
  ctx: CompileCtx,
  parent: Attribute,
  parentValues: string[],
  idxExpr: string,
  useWriteBuf: boolean,
): string {
  if (parentValues.length === 0) return 'false';
  const parentLayout = getAttr(ctx.layout, parent.id);
  if (!parentLayout) return 'false';
  const buf = useWriteBuf ? 'attrsWrite' : 'attrsRead';
  const slot = parentLayout.wordOffset === 0
    ? `${buf}[${idxExpr}]`
    : `${buf}[${parentLayout.wordOffset}u + ${idxExpr}]`;
  const literals = parentValues.map(v => {
    if (parent.type === 'bool') return v === 'true' || v === '1' ? '1u' : '0u';
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 ? `${n}u` : `bitcast<u32>(${Number.isFinite(n) ? n : 0})`;
  });
  const uniq = Array.from(new Set(literals));
  if (uniq.length === 1) return `(${slot} == ${uniq[0]})`;
  return `(` + uniq.map(l => `${slot} == ${l}`).join(' || ') + `)`;
}

/** WGSL typed literal matching the attribute's logical type (i32 for tag /
 *  integer / neighborIndex, f32 for float, bool for bool). Mirrors
 *  attrValueLiteralJS in subAttribute.ts. */
function attrValueLiteralWgsl(attr: Attribute, valueStr: string | undefined): ValueRef {
  const raw = valueStr ?? attr.defaultValue ?? '';
  switch (attr.type) {
    case 'bool': {
      const b = raw === 'true' || raw === '1';
      return { expr: b ? 'true' : 'false', type: 'bool' };
    }
    case 'integer':
    case 'tag':
    case 'neighborIndex': {
      const n = parseInt(raw, 10);
      return { expr: Number.isFinite(n) ? `${n}` : '0', type: 'i32' };
    }
    case 'float': {
      const n = parseFloat(raw);
      const s = Number.isFinite(n) ? String(n) : '0';
      return { expr: s.includes('.') || s.includes('e') || s.includes('E') ? s : `${s}.0`, type: 'f32' };
    }
    default:
      return { expr: '0', type: 'i32' };
  }
}

/** Read attr value at idxExpr, wrapped with sub-attribute parent-match guard.
 *  Returns the raw read if attr is not a sub-attribute. */
function readAttrGuarded(
  ctx: CompileCtx,
  attr: WebGPULayoutAttr,
  idxExpr: string = 'idx',
  useWriteBuf: boolean = false,
): ValueRef {
  const raw = readAttr(attr, idxExpr, useWriteBuf);
  const modelAttr = ctx.model.attributes.find(a => a.id === attr.id);
  const sub = subAttrInfo(modelAttr, ctx.model);
  if (!sub) return raw;
  const matchExpr = parentMatchExprWgsl(ctx, sub.parent, sub.parentValues, idxExpr, useWriteBuf);
  const undef = attrValueLiteralWgsl(modelAttr!, sub.undefinedValue);
  // WGSL select(falseValue, trueValue, cond): cond==true returns trueValue.
  return { expr: `select(${undef.expr}, ${raw.expr}, ${matchExpr})`, type: raw.type };
}

/** Returns the WGSL parent-match expression for attr at idxExpr, or null when
 *  attr is not a sub-attribute. Iteration consumer loops use this to inject
 *  `if (!(<match>)) { continue; }` skips on non-matching neighbours. */
function subAttrIterMatchExpr(
  ctx: CompileCtx,
  attrId: string,
  idxExpr: string,
  useWriteBuf: boolean = false,
): string | null {
  const modelAttr = ctx.model.attributes.find(a => a.id === attrId);
  const sub = subAttrInfo(modelAttr, ctx.model);
  if (!sub) return null;
  return parentMatchExprWgsl(ctx, sub.parent, sub.parentValues, idxExpr, useWriteBuf);
}

/** Emit per-cell conditional copy lines for every sub-attribute in the model.
 *  Matches the JS/WASM contract: at the top of each cell iteration in sync
 *  mode, `attrsWrite[subAttr][i] = parent_matches(attrsRead[parent][i])
 *  ? attrsRead[subAttr][i] : defaultValue`. Storage at non-matching cells is
 *  scrubbed back to defaultValue one step after a flip-out, and the user's
 *  rule's writes (which run later in the cell body) overwrite this seed where
 *  needed — so write-order between setAttribute(subAttr) and setAttribute(parent)
 *  is irrelevant. The bulk preamble skips sub-attrs (they're added to the
 *  elidable set at the call site), so the only copy these get is this one. */
function emitSubAttrConditionalCopy(ctx: CompileCtx): string[] {
  const lines: string[] = [];
  for (const subAttr of subAttributesOf(ctx.model)) {
    const layoutAttr = getAttr(ctx.layout, subAttr.id);
    if (!layoutAttr) continue;
    const info = subAttrInfo(subAttr, ctx.model);
    if (!info) continue;
    const slotR = layoutAttr.wordOffset === 0
      ? `attrsRead[idx]`
      : `attrsRead[${layoutAttr.wordOffset}u + idx]`;
    const slotW = layoutAttr.wordOffset === 0
      ? `attrsWrite[idx]`
      : `attrsWrite[${layoutAttr.wordOffset}u + idx]`;
    const matchExpr = parentMatchExprWgsl(ctx, info.parent, info.parentValues, 'idx', false);
    const defaultLit = attrValueLiteralWgsl(subAttr, subAttr.defaultValue);
    const defaultWord = encodeAttrWord(subAttr.type, defaultLit.expr, defaultLit.type);
    lines.push(`  ${slotW} = select(${defaultWord}, ${slotR}, ${matchExpr});`);
  }
  return lines;
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

/** Allocate a fresh per-thread `var arr: array<T, CAP>; var arr_len: i32 = 0;`
 *  inside the current function body. `cap` defaults to `ctx.maxArraySize`
 *  (safe upper bound = max neighbourhood size in the model); producers should
 *  pass a tighter bound when they can prove one (e.g. tag count, source.maxLen).
 *  WGSL requires a compile-time-constant array size — `cap` MUST be a literal
 *  integer at the JS level. Clamped to >= 1 since WGSL doesn't allow size-0
 *  arrays. */
function allocArray(ctx: CompileCtx, elemType: WgslType, prefix: string = 'arr', cap?: number): ArrayRef {
  const name = fresh(ctx, prefix);
  const lenName = `${name}_len`;
  const size = Math.max(1, Math.min(cap ?? ctx.maxArraySize, ctx.maxArraySize * 2));
  ctx.lines.push(`  var ${name}: array<${elemType}, ${size}>;`);
  ctx.lines.push(`  var ${lenName}: i32 = 0;`);
  return { kind: 'array', name, lenName, elemType, maxLen: size };
}

/** Expression that loads element `iExpr` from an ArrayRef. */
function arrLoad(arr: ArrayRef, iExpr: string): string {
  return `${arr.name}[${iExpr}]`;
}

function isArrayProducer(nodeType: string): boolean {
  switch (nodeType) {
    case 'getNeighborIndexesByTags':
    case 'getAllNeighborIndexes':
    case 'filterNeighbors':
    case 'joinNeighbors':
    case 'getNeighborsAttrByIndexes':
    case 'groupCounting':
    case 'pickNRandomNeighbors':
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
          // `any` ports (arithmeticOperator x/y, setAttribute value, etc.) accept
          // fractional inline values; treating them as i32 would truncate the
          // value via `n | 0` inside inlineValueRef before the f32 op ever ran.
          inputs[port.id] = inlineValueRef(inlineVal, port.dataType === 'float' || port.dataType === 'any');
        }
      }
    }
  }

  const result = routeEmissionForNode(ctx, nodeId, () => emitter({ ctx, node, inputs }));
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
  // Wave A.6: emits literal packed NIs (resolved by pre-pass).
  getNeighborIndexesByTags: ({ node, ctx }) => {
    const packed: number[] = node.data.config._resolvedTagIndexes
      ? JSON.parse(node.data.config._resolvedTagIndexes as string) : [];
    const arr = allocArray(ctx, 'i32', 'arrIdxTags', packed.length);
    for (let k = 0; k < packed.length; k++) {
      ctx.lines.push(`  ${arr.name}[${k}] = ${packed[k]! | 0};`);
    }
    ctx.lines.push(`  ${arr.lenName} = ${packed.length};`);
    return arr;
  },

  // Wave A.6: full NI[] of a neighborhood — packed (dr, dc) for every slot.
  getAllNeighborIndexes: ({ node, ctx }) => {
    const nbrId = node.data.config.neighborhoodId as string;
    const nbr = ctx.model.neighborhoods.find(n => n.id === nbrId);
    if (!nbr) { ctx.errors.push(`getAllNeighborIndexes: unknown neighborhood ${nbrId}`); return null; }
    const arr = allocArray(ctx, 'i32', 'arrAllNbr', nbr.coords.length);
    for (let k = 0; k < nbr.coords.length; k++) {
      const [dr, dc] = nbr.coords[k]!;
      const pk = packNI(dr, dc);
      ctx.lines.push(`  ${arr.name}[${k}] = ${pk};`);
    }
    ctx.lines.push(`  ${arr.lenName} = ${nbr.coords.length};`);
    return arr;
  },

  // Wave A.5: partial Fisher-Yates over a working copy of the input. Uses the
  // per-cell PCG stream (rand_f32) — different from JS / WASM xorshift32 but
  // statistically equivalent (already-documented Wave 3 target difference).
  pickNRandomNeighbors: ({ node, ctx, inputs }) => {
    const inArr = resolveInputArray(ctx, node, 'indexes');
    if (!inArr) {
      ctx.errors.push(`pickNRandomNeighbors: input "indexes" must come from an array-producing node`);
      return null;
    }
    const nRef = inputs['n'] ?? { expr: '1', type: 'i32' as WgslType };
    const nExpr = castTo(nRef, 'i32');
    const work = allocArray(ctx, 'i32', 'pnWork', inArr.maxLen);
    const result = allocArray(ctx, 'i32', 'pnRes', inArr.maxLen);
    const k = fresh(ctx, 'pnK');
    const ci = fresh(ctx, 'pnI');
    const fi = fresh(ctx, 'pnFi');
    const j = fresh(ctx, 'pnJ');
    const tmp = fresh(ctx, 'pnT');
    ctx.lines.push(`  var ${k}: i32 = clamp(${nExpr}, 0, ${inArr.lenName});`);
    ctx.lines.push(`  ${work.lenName} = ${inArr.lenName};`);
    // Copy input -> work
    ctx.lines.push(`  for (var ${ci}: i32 = 0; ${ci} < ${inArr.lenName}; ${ci} = ${ci} + 1) {`);
    ctx.lines.push(`    ${work.name}[${ci}] = ${arrLoad(inArr, ci)};`);
    ctx.lines.push(`  }`);
    // Partial Fisher-Yates
    ctx.lines.push(`  ${result.lenName} = ${k};`);
    ctx.lines.push(`  for (var ${fi}: i32 = 0; ${fi} < ${k}; ${fi} = ${fi} + 1) {`);
    ctx.lines.push(`    let ${j}: i32 = ${fi} + i32(rand_f32(idx) * f32(${inArr.lenName} - ${fi}));`);
    ctx.lines.push(`    let ${tmp}: i32 = ${work.name}[${fi}];`);
    ctx.lines.push(`    ${work.name}[${fi}] = ${work.name}[${j}];`);
    ctx.lines.push(`    ${work.name}[${j}] = ${tmp};`);
    ctx.lines.push(`    ${result.name}[${fi}] = ${work.name}[${fi}];`);
    ctx.lines.push(`  }`);
    return result;
  },

  // Wave A.6: filter input NI[] by comparing the attribute at each referenced
  // neighbor cell. NIs are packed (dr, dc); no neighborhood config. Indexes
  // input is required.
  filterNeighbors: ({ node, ctx, inputs }) => {
    const attrId = node.data.config.attributeId as string;
    const op = (node.data.config.operation as string) || 'equals';
    const attr = getAttr(ctx.layout, attrId);
    if (!attr) { ctx.errors.push(`filterNeighbors: unknown attr ${attrId}`); return null; }

    const inArr = resolveInputArray(ctx, node, 'indexes');
    if (!inArr) {
      ctx.errors.push(`filterNeighbors: requires Indexes input (e.g., from Get All Neighbor Indexes)`);
      return null;
    }

    const compare = inputs['compare'] ?? { expr: '0.0', type: 'f32' as WgslType };
    const out = allocArray(ctx, 'i32', 'arrFilter', inArr.maxLen);
    const k = fresh(ctx, 'fk');
    ctx.lines.push(`  for (var ${k}: i32 = 0; ${k} < ${inArr.lenName}; ${k} = ${k} + 1) {`);
    ctx.lines.push(`    let _niIn_${k}: i32 = ${arrLoad(inArr, k)};`);
    ctx.lines.push(`    let _nci_${k}: i32 = ${emitNiCellIdx(`_niIn_${k}`)};`);
    // Sub-attribute iteration semantics: non-matching neighbours never reach
    // the user's predicate (the sub-attribute "doesn't exist" on them).
    const subFilterSkip = subAttrIterMatchExpr(ctx, attrId, `u32(_nci_${k})`, false);
    if (subFilterSkip) {
      ctx.lines.push(`    if (!${subFilterSkip}) { continue; }`);
    }
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
    ctx.lines.push(`      ${out.name}[${out.lenName}] = _niIn_${k};`);
    ctx.lines.push(`      ${out.lenName} = ${out.lenName} + 1;`);
    ctx.lines.push(`    }`);
    ctx.lines.push(`  }`);
    // Wave A.7: expose final length on the `count` scalar value port so
    // downstream consumers can read it without a separate arrayLength node.
    // `out.lenName` is a `var` at the entry-point top scope (allocArray puts
    // both `arr` and `arr_len` there), so it's in scope wherever the count
    // is later referenced.
    setCachedPort(ctx, node.id, 'count', { expr: out.lenName, type: 'i32' });
    return out;
  },

  joinNeighbors: ({ node, ctx }) => {
    const op = (node.data.config.operation as string) || 'intersection';
    const a = resolveInputArray(ctx, node, 'a');
    const b = resolveInputArray(ctx, node, 'b');
    if (!a || !b) { ctx.errors.push(`joinNeighbors: missing a/b array input`); return null; }
    // union ≤ |a| + |b|; intersection ≤ min(|a|, |b|).
    const cap = op === 'union' ? a.maxLen + b.maxLen : Math.min(a.maxLen, b.maxLen);
    const out = allocArray(ctx, 'i32', 'arrJoin', cap);
    const i = fresh(ctx, 'ji');
    if (op === 'union') {
      // Copy A as-is (A.len <= maxArraySize, no overflow possible).
      ctx.lines.push(`  for (var ${i}: i32 = 0; ${i} < ${a.lenName}; ${i} = ${i} + 1) {`);
      ctx.lines.push(`    ${out.name}[${out.lenName}] = ${arrLoad(a, i)};`);
      ctx.lines.push(`    ${out.lenName} = ${out.lenName} + 1;`);
      ctx.lines.push(`  }`);
      // Walk B, skip duplicates. Guard against overflow: union of two full-size
      // arrays could produce up to 2*maxArraySize distinct elements, and WGSL
      // writes past the end of a function-scope array are undefined.
      const j = fresh(ctx, 'jj');
      const k = fresh(ctx, 'jk');
      ctx.lines.push(`  for (var ${j}: i32 = 0; ${j} < ${b.lenName}; ${j} = ${j} + 1) {`);
      ctx.lines.push(`    let _bElem_${j}: i32 = ${arrLoad(b, j)};`);
      ctx.lines.push(`    var _found_${j}: bool = false;`);
      ctx.lines.push(`    for (var ${k}: i32 = 0; ${k} < ${out.lenName}; ${k} = ${k} + 1) {`);
      ctx.lines.push(`      if (${out.name}[${k}] == _bElem_${j}) { _found_${j} = true; }`);
      ctx.lines.push(`    }`);
      ctx.lines.push(`    if (!_found_${j} && ${out.lenName} < ${out.maxLen}) {`);
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

    // groupCounting indexes output: matches a subset of the source. Bound is
    // the source's size — nbr.size for the in-line nbr path, or the array
    // source's own maxLen.
    let gcCap: number | undefined;
    if (isNbrPath) {
      const nbrSrc = getNbr(ctx.layout, firstSrcNode!.data.config.neighborhoodId as string);
      gcCap = nbrSrc?.size;
    } else if (sources.length === 1 && isArrayProducer(firstSrcNode?.data.nodeType ?? '')) {
      const arrSrc = compileArrayNode(ctx, firstSrc.nodeId);
      gcCap = arrSrc?.maxLen;
    }
    const out = allocArray(ctx, 'i32', 'arrGC', gcCap);

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
      ctx.lines.push(`    let _nci_${n}: i32 = ${emitNbrCellIdx(nbr, n)};`);
      // Sub-attribute: non-matching neighbours don't appear in the counted set.
      const subGcSkip = subAttrIterMatchExpr(ctx, srcNode.data.config.attributeId as string, `u32(_nci_${n})`, false);
      if (subGcSkip) {
        ctx.lines.push(`    if (!${subGcSkip}) { continue; }`);
      }
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
  // Wave A.6: read neighbor attribute values for a list of packed NIs.
  getNeighborsAttrByIndexes: ({ node, ctx }) => {
    const attrId = node.data.config.attributeId as string;
    const attr = getAttr(ctx.layout, attrId);
    if (!attr) { ctx.errors.push(`getNeighborsAttrByIndexes: unknown attr ${attrId}`); return null; }
    const inArr = resolveInputArray(ctx, node, 'indexes');
    if (!inArr) { ctx.errors.push(`getNeighborsAttrByIndexes: no input on "indexes"`); return null; }

    const elemType = attrElemType(attr.type);
    const out = allocArray(ctx, elemType, 'arrNbrAttr', inArr.maxLen);
    const k = fresh(ctx, 'nak');
    // Sub-attribute: filter-with-push. Only matching neighbours contribute,
    // so the output length is the match count (tracked via out.lenName).
    // For regular attrs the loop unconditionally writes at slot k and assigns
    // the final length once after the loop.
    const subNbiSkip = subAttrIterMatchExpr(ctx, attrId, `u32(_nci_${k})`, false);
    ctx.lines.push(`  for (var ${k}: i32 = 0; ${k} < ${inArr.lenName}; ${k} = ${k} + 1) {`);
    ctx.lines.push(`    let _niIn_${k}: i32 = ${arrLoad(inArr, k)};`);
    ctx.lines.push(`    let _nci_${k}: i32 = ${emitNiCellIdx(`_niIn_${k}`)};`);
    if (subNbiSkip) {
      ctx.lines.push(`    if (!${subNbiSkip}) { continue; }`);
    }
    const e = readAttr(attr, `u32(_nci_${k})`, false);
    let stored: string;
    if (attr.type === 'bool') stored = `select(0, 1, ${e.expr})`;
    else if (attr.type === 'float') stored = e.expr;
    else stored = e.expr;
    if (subNbiSkip) {
      ctx.lines.push(`    ${out.name}[${out.lenName}] = ${stored};`);
      ctx.lines.push(`    ${out.lenName} = ${out.lenName} + 1;`);
    } else {
      ctx.lines.push(`    ${out.name}[${k}] = ${stored};`);
    }
    ctx.lines.push(`  }`);
    if (!subNbiSkip) {
      ctx.lines.push(`  ${out.lenName} = ${inArr.lenName};`);
    }
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

  // Wave A.6: NIs are packed (dr, dc) i32. neighborIndexFromOffset takes
  // dr/dc as input ports and emits the packed value at runtime.
  neighborIndexFromOffset: ({ ctx, inputs }) => {
    const drRef = inputs['dr'] ?? { expr: '0', type: 'i32' as WgslType };
    const dcRef = inputs['dc'] ?? { expr: '0', type: 'i32' as WgslType };
    const drI = castTo(drRef, 'i32');
    const dcI = castTo(dcRef, 'i32');
    return emitLet(
      ctx,
      'i32',
      `(((${drI}) & 0xFFFF) << 16) | ((${dcI}) & 0xFFFF)`,
      'nio',
    );
  },
  // Wave A.6: emit a packed-NI literal pre-resolved by the compiler pre-pass.
  neighborIndexFromTag: ({ node, ctx }) => {
    const packed = node.data.config._resolvedPacked !== undefined
      ? Number(node.data.config._resolvedPacked) | 0
      : INVALID_NI;
    return emitLet(ctx, 'i32', `${packed}`, 'nit');
  },

  // Wave A.6: break a packed NI into its (dr, dc) components — multi-output.
  // Caches both port refs so downstream nodes can read either independently.
  breakDownNeighborIndex: ({ node, ctx, inputs }) => {
    const idxRef = inputs['index'] ?? { expr: '0', type: 'i32' as WgslType };
    const inExpr = castTo(idxRef, 'i32');
    const inName = fresh(ctx, 'bdnIn');
    ctx.lines.push(`  let ${inName}: i32 = ${inExpr};`);
    const drRef = emitLet(ctx, 'i32', `(${inName}) >> 16`, 'bdnDr');
    const dcRef = emitLet(ctx, 'i32', `((${inName}) << 16) >> 16`, 'bdnDc');
    setCachedPort(ctx, node.id, 'dr', drRef);
    setCachedPort(ctx, node.id, 'dc', dcRef);
    // Default 'value' port also resolves to dr (matches other multi-output emitters).
    return drRef;
  },

  // Wave A.6: flip a NeighborIndex by decoding (dr, dc), conditionally
  // negating, and re-encoding. No neighborhood needed.
  flipNeighborIndex: ({ node, ctx, inputs }) => {
    const mode = (node.data.config.mode as string) || 'horizontal';
    const flipDr = mode === 'vertical' || mode === 'both';
    const flipDc = mode === 'horizontal' || mode === 'both';
    const idxRef = inputs['index'] ?? { expr: '0', type: 'i32' as WgslType };
    const inExpr = castTo(idxRef, 'i32');
    const inName = fresh(ctx, 'flipIn');
    ctx.lines.push(`  let ${inName}: i32 = ${inExpr};`);
    const drExpr = flipDr ? `(-((${inName}) >> 16))` : `((${inName}) >> 16)`;
    const dcExpr = flipDc ? `(-(((${inName}) << 16) >> 16))` : `(((${inName}) << 16) >> 16)`;
    return emitLet(
      ctx,
      'i32',
      `((${drExpr}) & 0xFFFF) << 16 | ((${dcExpr}) & 0xFFFF)`,
      'flipR',
    );
  },

  // Wave A.5: array length.
  arrayLength: ({ node, ctx }) => {
    const inArr = resolveInputArray(ctx, node, 'array');
    if (!inArr) {
      ctx.errors.push(`arrayLength: input "array" must come from an array-producing node`);
      return null;
    }
    return emitLet(ctx, 'i32', inArr.lenName, 'aL');
  },

  // Wave A.6: bounds-checked indexed access. Out-of-range default depends on
  // the source element kind — INVALID_NI for NI[] sources, 0/0.0/false for
  // value[] sources. The source-type detection mirrors the JS / WASM
  // arrayElement emitters so all three targets agree on the fallback.
  arrayElement: ({ node, ctx, inputs }) => {
    const inArr = resolveInputArray(ctx, node, 'array');
    if (!inArr) {
      ctx.errors.push(`arrayElement: input "array" must come from an array-producing node`);
      return null;
    }
    const posRef = inputs['position'] ?? { expr: '0', type: 'i32' as WgslType };
    const posExpr = castTo(posRef, 'i32');
    const idx = fresh(ctx, 'aeI');
    ctx.lines.push(`  let ${idx}: i32 = ${posExpr};`);
    const inb = `(${idx} >= 0 && ${idx} < ${inArr.lenName})`;
    if (inArr.elemType === 'f32') {
      return emitLet(ctx, 'f32', `select(0.0, ${arrLoad(inArr, idx)}, ${inb})`, 'aeV');
    }
    if (inArr.elemType === 'bool') {
      return emitLet(ctx, 'bool', `select(false, ${arrLoad(inArr, idx)}, ${inb})`, 'aeV');
    }
    const arraySrc = ctx.inputToSource.get(`${node.id}:array`);
    const srcNode = arraySrc ? ctx.nodeMap.get(arraySrc.nodeId) : undefined;
    const isNiArray = !!(srcNode && NI_ARRAY_PRODUCERS.has(srcNode.data.nodeType));
    const fallback = isNiArray ? `${INVALID_NI}` : '0';
    return emitLet(ctx, 'i32', `select(${fallback}, ${arrLoad(inArr, idx)}, ${inb})`, 'aeV');
  },

  // Wave A PR2: pick a random element from a NeighborIndex array. Uses the
  // per-cell PCG stream (rand_f32) — different sequence from JS/WASM
  // (xorshift32) but statistically equivalent. Returns -1 on empty input.
  pickRandomNeighbor: ({ node, ctx }) => {
    const inArr = resolveInputArray(ctx, node, 'indexes');
    if (!inArr) {
      ctx.errors.push(`pickRandomNeighbor: input "indexes" must come from an array-producing node (filterNeighbors / getNeighborIndexesByTags / joinNeighbors)`);
      return null;
    }
    const r = fresh(ctx, 'pickR');
    ctx.lines.push(`  let ${r}: f32 = rand_f32(idx);`);
    const idxName = fresh(ctx, 'pickI');
    // Clamp at compile time to maxLen-1 so the index is statically known to be
    // a valid array index when len > 0; runtime select() guards the empty case.
    ctx.lines.push(`  let ${idxName}: i32 = i32(${r} * f32(${inArr.lenName}));`);
    const resultName = fresh(ctx, 'pickV');
    // Wave A.6: empty-array sentinel is INVALID_NI (i32 min) instead of -1.
    ctx.lines.push(`  let ${resultName}: i32 = select(${INVALID_NI}, ${arrLoad(inArr, idxName)}, ${inArr.lenName} > 0);`);
    return { expr: resultName, type: 'i32' };
  },

  getCellAttribute: ({ node, ctx }) => {
    const attrId = node.data.config.attributeId as string;
    const attr = getAttr(ctx.layout, attrId);
    if (!attr) { ctx.errors.push(`getCellAttribute: unknown attr ${attrId}`); return null; }
    // Sub-attribute scalar read: parent_match ? raw : undefinedValue.
    const r = readAttrGuarded(ctx, attr, 'idx', false);
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

  // Expression node: parse the formula string, emit the AST as a WGSL f32 expr.
  expression: ({ node, ctx, inputs }) => {
    const visibleCount = clampVisibleCount(node.data.config.visibleCount);
    const { map, errors } = buildVarMap(node.data.config, visibleCount);
    if (errors.length > 0) { ctx.errors.push(`expression: ${errors[0]}`); return null; }
    const res = parseExpression(String(node.data.config.expression ?? ''), map);
    if ('error' in res) { ctx.errors.push(`expression: ${res.error}`); return null; }
    return emitLet(ctx, 'f32', emitWgsl(res.ast, inputs), 'expr');
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
  groupCounting: (c) => {
    // O1: if the array side of this groupCounting was already materialised
    // (a downstream consumer pulled `indexes`), the count is exactly the
    // array's length. Skip the second per-cell scan entirely — equivalent
    // result, half the loop work.
    const cachedArr = c.ctx.arrayRefs.get(c.node.id);
    if (cachedArr) {
      const ref: ValueRef = { expr: cachedArr.lenName, type: 'i32' };
      setCachedPort(c.ctx, c.node.id, 'count', ref);
      return ref;
    }
    return emitAggregateOrCount(c, 'count');
  },
  groupOperator: (c) => emitAggregateOrCount(c, 'groupOperator'),
  groupStatement: (c) => emitGroupStatement(c),

  // Wave A.7: filterNeighbors is multi-output. The array emitter caches the
  // `count` scalar port as a side effect, so calling compileArrayNode here
  // either hits an existing cache or runs the array emit (which caches both
  // result + count). Then we return the cached scalar count.
  filterNeighbors: (c) => {
    const arr = compileArrayNode(c.ctx, c.node.id);
    if (!arr) return null;
    const cached = getCachedPort(c.ctx, c.node.id, 'count');
    if (cached) return cached;
    // Defensive fallback — current array emitter always caches `count`, but
    // if a future variant forgets, materialise from the array's len directly.
    const ref: ValueRef = { expr: arr.lenName, type: 'i32' };
    setCachedPort(c.ctx, c.node.id, 'count', ref);
    return ref;
  },

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

  // Wave A.6: read one neighbor's attribute at a packed NI offset.
  // Symmetric guards with the JS / WASM emitters:
  //   - If the input is wired to an array producer (e.g. pickNRandomNeighbors,
  //     filterNeighbors), take element [0] or INVALID_NI when empty. Without
  //     this branch, the surrounding compileValueNode would try to look up a
  //     VALUE emitter for the array producer and fail with "No WebGPU value
  //     emitter for ...", forcing a JS fallback even for graphs that JS / WASM
  //     handle natively.
  //   - If the resolved NI is the INVALID_NI sentinel (empty pick / out-of-
  //     range arrayElement), return a zero-valued default rather than reading
  //     from a wrapped torus cell or the constant-boundary sentinel.
  getNeighborAttributeByIndex: ({ node, ctx, inputs }) => {
    const attrId = node.data.config.attributeId as string;
    const attr = getAttr(ctx.layout, attrId);
    if (!attr) { ctx.errors.push(`getNeighborAttributeByIndex: unknown attr ${attrId}`); return null; }
    const indexSrc = ctx.inputToSource.get(`${node.id}:index`);
    const srcNode = indexSrc ? ctx.nodeMap.get(indexSrc.nodeId) : undefined;
    // Take the array-source path only when the source's OUTPUT PORT is an
    // array — checking isArrayProducer(nodeType) would mis-route a scalar
    // output of a hybrid producer (e.g. groupCounting.count) through the
    // load-element-[0] branch.
    const indexSrcDef = srcNode ? getNodeDef(srcNode.data.nodeType) : null;
    const indexSrcPort = indexSrc ? indexSrcDef?.ports.find(p => p.id === indexSrc.portId) : undefined;
    let niLocal: ValueRef;
    if (indexSrcPort?.isArray) {
      const arrRef = compileArrayNode(ctx, indexSrc!.nodeId);
      if (!arrRef) return null;
      // First element of the array, or INVALID_NI when empty (matches JS / WASM).
      // The array's elemType is i32 for NI[] producers; cast defensively.
      const elemExpr = arrRef.elemType === 'i32'
        ? `${arrRef.name}[0]`
        : `i32(${arrRef.name}[0])`;
      niLocal = emitLet(ctx, 'i32', `select(${INVALID_NI}, ${elemExpr}, ${arrRef.lenName} > 0)`, 'ni');
    } else {
      const indexRef = inputs['index'] ?? { expr: '0', type: 'i32' as WgslType };
      niLocal = emitLet(ctx, 'i32', castTo(indexRef, 'i32'), 'ni');
    }
    // Guard INVALID_NI: select between the read at niCellIdx(NI) and a zero
    // default. Both sides of the select are evaluated (no branching at the
    // shader level), but the read still goes through nbrCellIdxFromNi which
    // does its own boundary handling — for INVALID_NI's decoded offsets this
    // either wraps to a real cell (torus) or hits the sentinel slot (constant);
    // in either case we discard the result by selecting the default.
    const cellIdx = emitLet(ctx, 'i32', emitNiCellIdx(niLocal.expr), 'nci');
    // Sub-attribute scalar read at neighbour cell: parent_match ? raw : undefinedValue.
    const r = readAttrGuarded(ctx, attr, `u32(${cellIdx.expr})`, false);
    if (r.type === 'f32') {
      return emitLet(ctx, 'f32', `select(0.0, ${r.expr}, ${niLocal.expr} != ${INVALID_NI})`, 'nbAtr');
    }
    if (r.type === 'bool') {
      return emitLet(ctx, 'bool', `select(false, ${r.expr}, ${niLocal.expr} != ${INVALID_NI})`, 'nbAtr');
    }
    return emitLet(ctx, 'i32', `select(0, ${r.expr}, ${niLocal.expr} != ${INVALID_NI})`, 'nbAtr');
  },

  getNeighborAttributeByTag: ({ node, ctx }) => {
    const nbrId = node.data.config.neighborhoodId as string;
    const attrId = node.data.config.attributeId as string;
    const nbr = getNbr(ctx.layout, nbrId);
    const attr = getAttr(ctx.layout, attrId);
    if (!nbr || !attr) { ctx.errors.push(`getNeighborAttributeByTag: unknown nbr/attr`); return null; }
    const tagIdx = Number((node.data.config as Record<string, unknown>)._resolvedTagIndex ?? 0);
    const cellIdx = emitLet(ctx, 'i32', emitNbrCellIdx(nbr, `${tagIdx | 0}`), 'nci');
    // Sub-attribute scalar read at the tagged neighbour: parent_match ? raw : undefinedValue.
    const r = readAttrGuarded(ctx, attr, `u32(${cellIdx.expr})`, false);
    return emitLet(ctx, r.type, r.expr, 'nbAtr');
  },

  proportionMap: ({ ctx, node, inputs }) => {
    const x = castTo(inputs['x'] ?? { expr: '0.0', type: 'f32' }, 'f32');
    const inMin = castTo(inputs['inMin'] ?? { expr: '0.0', type: 'f32' }, 'f32');
    const inMax = castTo(inputs['inMax'] ?? { expr: '1.0', type: 'f32' }, 'f32');
    const outMin = castTo(inputs['outMin'] ?? { expr: '0.0', type: 'f32' }, 'f32');
    const outMax = castTo(inputs['outMax'] ?? { expr: '1.0', type: 'f32' }, 'f32');
    const method = (node.data.config.method as string) || 'linear';
    const span = emitLet(ctx, 'f32', `(${inMax} - ${inMin})`, 'sp');
    // tRaw = inSpan != 0 ? (x-inMin)/inSpan : 0
    const tRawExpr = `select(0.0, ((${x}) - (${inMin})) / ${span.expr}, (${span.expr} != 0.0))`;
    const tRaw = emitLet(ctx, 'f32', tRawExpr, 'pmt');
    const tCurveExpr = wgslInterpolationCurveExpr(tRaw.expr, method);
    const tCurve = emitLet(ctx, 'f32', tCurveExpr, 'pmc');
    const expr = `select((${outMin}), ((${outMin}) + ${tCurve.expr} * ((${outMax}) - (${outMin}))), (${span.expr} != 0.0))`;
    return emitLet(ctx, 'f32', expr, 'pm');
  },

  interpolation: ({ ctx, inputs }) => {
    const t = castTo(inputs['t'] ?? { expr: '0.5', type: 'f32' }, 'f32');
    const mn = castTo(inputs['min'] ?? { expr: '0.0', type: 'f32' }, 'f32');
    const mx = castTo(inputs['max'] ?? { expr: '1.0', type: 'f32' }, 'f32');
    return emitLet(ctx, 'f32', `(${mn} + ${t} * (${mx} - ${mn}))`, 'lerp');
  },

  valueSwitch: ({ ctx, inputs }) => {
    const cond = castTo(inputs['condition'] ?? { expr: 'false', type: 'bool' }, 'bool');
    const ifV  = castTo(inputs['ifValue']   ?? { expr: '1.0',   type: 'f32' },  'f32');
    const elV  = castTo(inputs['elseValue'] ?? { expr: '0.0',   type: 'f32' },  'f32');
    return emitLet(ctx, 'f32', `select(${elV}, ${ifV}, ${cond})`, 'vsel');
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

  colorScale: ({ ctx, node, inputs }) => {
    const t = castTo(inputs['t'] ?? { expr: '0.5', type: 'f32' }, 'f32');
    const method = (node.data.config.method as string) || 'linear';
    const stops = readColorScaleStops(node.data.config);

    const f32Lit = (n: number) => Number.isInteger(n) ? `${n}.0` : `${n}`;

    // Single-eval of t; then three vars at the same scope that the if-chain
    // below assigns into. routeEmissionForNode captures every push, so all of
    // these lines land in a single block — assignments inside the branches
    // can see the vars declared above.
    const tName = fresh(ctx, 'cst');
    ctx.lines.push(`  let ${tName}: f32 = ${t};`);
    const rName = fresh(ctx, 'csr');
    const gName = fresh(ctx, 'csg');
    const bName = fresh(ctx, 'csb');
    ctx.lines.push(`  var ${rName}: i32;`);
    ctx.lines.push(`  var ${gName}: i32;`);
    ctx.lines.push(`  var ${bName}: i32;`);

    const writeConst = (r: number, g: number, b: number) =>
      `${rName} = ${r | 0}; ${gName} = ${g | 0}; ${bName} = ${b | 0};`;

    if (stops.length === 0) {
      ctx.lines.push(`  ${writeConst(0, 0, 0)}`);
    } else if (stops.length === 1) {
      const s = stops[0]!;
      ctx.lines.push(`  ${writeConst(s.r, s.g, s.b)}`);
    } else {
      const first = stops[0]!;
      const last = stops[stops.length - 1]!;
      ctx.lines.push(`  if (${tName} <= ${f32Lit(first.p)}) { ${writeConst(first.r, first.g, first.b)} }`);
      for (let i = 0; i < stops.length - 1; i++) {
        const a = stops[i]!;
        const b = stops[i + 1]!;
        if (b.p === a.p) continue;
        const localExpr = `((${tName} - ${f32Lit(a.p)}) / ${f32Lit(b.p - a.p)})`;
        const curved = wgslInterpolationCurveExpr(localExpr, method);
        const rExpr = `i32(floor(${f32Lit(a.r)} + (${curved}) * ${f32Lit(b.r - a.r)} + 0.5))`;
        const gExpr = `i32(floor(${f32Lit(a.g)} + (${curved}) * ${f32Lit(b.g - a.g)} + 0.5))`;
        const bExpr = `i32(floor(${f32Lit(a.b)} + (${curved}) * ${f32Lit(b.b - a.b)} + 0.5))`;
        ctx.lines.push(
          `  else if (${tName} < ${f32Lit(b.p)}) { `
          + `${rName} = ${rExpr}; ${gName} = ${gExpr}; ${bName} = ${bExpr}; }`,
        );
      }
      ctx.lines.push(`  else { ${writeConst(last.r, last.g, last.b)} }`);
    }

    const rRef: ValueRef = { expr: rName, type: 'i32' };
    const gRef: ValueRef = { expr: gName, type: 'i32' };
    const bRef: ValueRef = { expr: bName, type: 'i32' };
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
  // O6: fuse aggregate over getNeighborsAttrByIndexes when this is the only
  // consumer and the op is associative. Skips the per-thread var array
  // allocation (heavy register pressure on WGSL) and merges the gather +
  // accumulate into a single loop reading from the source's `indexes` input.
  // Cap at sum/product/min/max/and/or/average + the count comparisons (which
  // already match the array emitter's semantics).
  let fusedNbrAttrPath = false;
  // Sub-attribute sources route through the materialised filter-with-push path
  // (getNeighborsAttrByIndexes does the parent_match skip while filling) and
  // the aggregate then walks the filtered array. Fusion would have to recreate
  // skip + matchCount inline, doubling the maintenance surface for marginal
  // benefit on the type-dispatched models that use sub-attrs.
  const fusedSrcAttrId = (firstSrcNode?.data.config.attributeId as string) || '';
  const fusedSrcIsSubAttr = !!subAttrIterMatchExpr(ctx, fusedSrcAttrId, 'idx', false);
  if (
    isArrayPath
    && firstSrcNode!.data.nodeType === 'getNeighborsAttrByIndexes'
    && (ctx.outDegree.get(firstSrc.nodeId) ?? 0) === 1
    && (mode === 'count' || (op !== 'median' && op !== 'random'))
    && !fusedSrcIsSubAttr
  ) {
    const srcNode = firstSrcNode!;
    const nbrId = srcNode.data.config.neighborhoodId as string;
    const attrId = srcNode.data.config.attributeId as string;
    const nbr = getNbr(ctx.layout, nbrId);
    const attr = getAttr(ctx.layout, attrId);
    const inArr = nbr && attr ? resolveInputArray(ctx, srcNode, 'indexes') : null;
    if (nbr && attr && inArr) {
      fusedNbrAttrPath = true;
      const k = fresh(ctx, 'fk');
      ctx.lines.push(`  for (var ${k}: i32 = 0; ${k} < ${inArr.lenName}; ${k} = ${k} + 1) {`);
      ctx.lines.push(`    let _idxIn_${k}: i32 = ${arrLoad(inArr, k)};`);
      ctx.lines.push(`    let _nci_${k}: i32 = ${emitNbrCellIdx(nbr, `_idxIn_${k}`)};`);
      const elem = readAttr(attr, `u32(_nci_${k})`, false);
      ctx.lines.push(`    let _e_${k}: ${elem.type} = ${elem.expr};`);
      const elemRef: ValueRef = { expr: `_e_${k}`, type: elem.type };
      emitAccumStep(ctx, mode, op, acc, elemRef, cmpRef, cmpHighRef, lo, hi, trackIndex, bestIdx, k);
      ctx.lines.push(`  }`);
      if (op === 'average') {
        ctx.lines.push(`  ${acc.name} = ${acc.name} / max(1.0, f32(${inArr.lenName}));`);
      }
    }
  }
  if (isArrayPath && !fusedNbrAttrPath) {
    arrRef = compileArrayNode(ctx, firstSrc.nodeId);
    if (!arrRef) return null;
  }

  // Sub-attribute on the nbr-path: pre-declare matchCount before the loop, so
  // it survives the loop's block scope. The post-divide / iterTag for min-max
  // both need it. Declared here (in the outer block) so it's in scope below.
  let nbrSubMatch: string | null = null;
  let nbrMatchCount: { name: string; type: WgslType } | null = null;
  if (isNbrPath && !fusedNbrAttrPath) {
    const srcAttrId = (firstSrcNode!.data.config.attributeId as string) || '';
    // Use a placeholder idxExpr just to detect whether attr is a sub-attr; the
    // real idxExpr is built inside the loop body and re-passed below.
    if (subAttrIterMatchExpr(ctx, srcAttrId, 'idx', false)) {
      nbrMatchCount = emitVar(ctx, 'i32', '0', 'mc');
    }
  }

  if (fusedNbrAttrPath) {
    // Loop already emitted above; fall through to the result-wrapping tail.
  } else if (isNbrPath) {
    const srcNode = firstSrcNode!;
    const nbrId = srcNode.data.config.neighborhoodId as string;
    const attrId = srcNode.data.config.attributeId as string;
    const nbr = getNbr(ctx.layout, nbrId);
    const attr = getAttr(ctx.layout, attrId);
    if (!nbr || !attr) {
      ctx.errors.push(`${mode}: unknown nbr/attr (${nbrId}/${attrId})`); return null;
    }
    const nVar = fresh(ctx, 'n');
    nbrSubMatch = subAttrIterMatchExpr(ctx, attrId, `u32(_nci_${nVar})`, false);
    ctx.lines.push(`  for (var ${nVar}: i32 = 0; ${nVar} < ${nbr.size}; ${nVar} = ${nVar} + 1) {`);
    ctx.lines.push(`    let _nci_${nVar}: i32 = ${emitNbrCellIdx(nbr, nVar)};`);
    if (nbrSubMatch) {
      // Skip non-matching neighbours and track filtered count. The position
      // exposed to trackIndex (groupOperator min/max) is the position-in-
      // filtered-set, matching JS/WASM semantics.
      ctx.lines.push(`    if (!${nbrSubMatch}) { continue; }`);
      ctx.lines.push(`    ${nbrMatchCount!.name} = ${nbrMatchCount!.name} + 1;`);
    }
    const elem = readAttr(attr, `u32(_nci_${nVar})`, false);
    ctx.lines.push(`    let _e_${nVar}: ${elem.type} = ${elem.expr};`);
    const elemRef: ValueRef = { expr: `_e_${nVar}`, type: elem.type };
    const iterTag = nbrSubMatch ? `(${nbrMatchCount!.name} - 1)` : nVar;
    emitAccumStep(ctx, mode, op, acc, elemRef, cmpRef, cmpHighRef, lo, hi, trackIndex, bestIdx, iterTag);
    ctx.lines.push(`  }`);
  } else if (arrRef) {
    const nVar = fresh(ctx, 'an');
    ctx.lines.push(`  for (var ${nVar}: i32 = 0; ${nVar} < ${arrRef.lenName}; ${nVar} = ${nVar} + 1) {`);
    ctx.lines.push(`    let _e_${nVar}: ${arrRef.elemType} = ${arrLoad(arrRef, nVar)};`);
    const elemRef: ValueRef = { expr: `_e_${nVar}`, type: arrRef.elemType };
    emitAccumStep(ctx, mode, op, acc, elemRef, cmpRef, cmpHighRef, lo, hi, trackIndex, bestIdx, nVar);
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
      emitAccumStep(ctx, mode, op, acc, ref, cmpRef, cmpHighRef, lo, hi, trackIndex, bestIdx, `${i}`);
      i++;
    }
    // Average post-divide for scalar path uses sources.length
    if (op === 'average') {
      ctx.lines.push(`  ${acc.name} = ${acc.name} / ${Math.max(1, refs.length)}.0;`);
    }
  }

  // Average post-divide for nbr path. For sub-attribute sources, divide by
  // matchCount (filtered) instead of the fixed neighbourhood size.
  if (isNbrPath && op === 'average') {
    if (nbrMatchCount) {
      ctx.lines.push(`  ${acc.name} = ${acc.name} / max(1.0, f32(${nbrMatchCount.name}));`);
    } else {
      const nbrSize = (firstSrcNode && getNbr(ctx.layout, firstSrcNode.data.config.neighborhoodId as string)?.size) || 1;
      ctx.lines.push(`  ${acc.name} = ${acc.name} / ${Math.max(1, nbrSize)}.0;`);
    }
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
    const gsSubMatch = subAttrIterMatchExpr(ctx, attrId, `u32(_nci_${nVar})`, false);
    ctx.lines.push(`  for (var ${nVar}: i32 = 0; ${nVar} < ${nbr.size}; ${nVar} = ${nVar} + 1) {`);
    ctx.lines.push(`    let _nci_${nVar}: i32 = ${emitNbrCellIdx(nbr, nVar)};`);
    if (gsSubMatch) {
      // Sub-attribute: non-matching neighbours don't appear in the tested set.
      ctx.lines.push(`    if (!${gsSubMatch}) { continue; }`);
    }
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
    for (const s of sources) {
      const r = compileValueNode(ctx, s.nodeId, s.portId);
      if (!r) return null;
      const ef = castTo(r, 'f32');
      ctx.lines.push(`  { let cmp_${acc.name}: bool = (${ef} ${cmpOp} ${xExpr}); ${accumLine} }`);
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
    // Sub-attribute reads return undefinedValue when parent doesn't match —
    // the write itself proceeds regardless (rule a). The stored "garbage"
    // at non-matching cells is invisible to subsequent reads (also wrapped).
    const cur = readAttrGuarded(ctx, attr, 'idx', true);
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
  // Also skip when the source's OUTPUT PORT is an array (e.g. pickNRandomNeighbors's
  // value output) wired to a scalar consumer port. The consuming emitter
  // (getNeighborAttributeByIndex etc.) detects this via ctx.inputToSource and
  // routes through compileArrayNode itself.
  //
  // CRITICAL: check the source PORT's isArray, not isArrayProducer(nodeType).
  // Hybrid nodes like `groupCounting` are array producers (their `indexes`
  // output is an array) AND value emitters (their `count` output is a scalar).
  // Using isArrayProducer here silently drops any consumer reading the scalar
  // `count` port — the input falls through to the inline-default branch and
  // the count loop is never emitted (manifests as "Count Matching always
  // returns 0" / "wrong count" downstream).
  const inputs: Record<string, ValueRef | undefined> = {};
  for (const port of def.ports) {
    if (port.kind !== 'input' || port.category !== 'value') continue;
    if (port.isArray) continue;
    const source = ctx.inputToSource.get(`${nodeId}:${port.id}`);
    if (source) {
      const srcNode = ctx.nodeMap.get(source.nodeId);
      const srcDef = srcNode ? getNodeDef(srcNode.data.nodeType) : null;
      const srcPort = srcDef?.ports.find(p => p.id === source.portId);
      if (srcPort?.isArray) continue;
      const srcRef = compileValueNode(ctx, source.nodeId, source.portId);
      if (!srcRef) return null;
      inputs[port.id] = srcRef;
    } else {
      const inlineVal = getInlineValue(port, node.data.config);
      if (inlineVal !== undefined) {
        // `any` ports (arithmeticOperator x/y, proportionMap in/out range, etc.)
        // accept fractional inline values; treating them as i32 would truncate the
        // value via `n | 0` inside inlineValueRef before the f32 op ever ran.
        inputs[port.id] = inlineValueRef(inlineVal, port.dataType === 'float' || port.dataType === 'any');
      }
    }
  }

  const result = routeEmissionForNode(ctx, nodeId, () => emitter({ ctx, node, inputs }));
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
      // Scalar port wired to an array producer (e.g. pickNRandomNeighbors →
      // getNeighborAttributeByIndex.index): pre-emit via compileArrayNode so
      // the private-array decl lives at the entry-point top scope, then let
      // the consuming emitter route through ctx.inputToSource to load
      // element [0]. compileValueNode would fail with "No WebGPU value
      // emitter for ..." for these node types.
      // Hybrid producers (groupCounting / groupOperator / groupStatement)
      // expose BOTH array and scalar outputs — dispatch on the source's
      // OUTPUT PORT, not the node type. Reading a scalar port (e.g.
      // groupCounting.count) goes through compileValueNode normally so the
      // count loop is emitted; reading the array port goes through
      // compileArrayNode.
      const isArraySrcPort = (s: { nodeId: string; portId: string }): boolean => {
        const sn = ctx.nodeMap.get(s.nodeId);
        const sd = sn ? getNodeDef(sn.data.nodeType) : null;
        const sp = sd?.ports.find(p => p.id === s.portId);
        return !!sp?.isArray;
      };
      if (src) {
        if (isArraySrcPort(src)) compileArrayNode(ctx, src.nodeId);
        else compileValueNode(ctx, src.nodeId, src.portId);
      }
      if (srcs) for (const s of srcs) {
        if (isArraySrcPort(s)) compileArrayNode(ctx, s.nodeId);
        else compileValueNode(ctx, s.nodeId, s.portId);
      }
    }

    if (visited.has(target.nodeId)) continue;
    visited.add(target.nodeId);

    switch (node.data.nodeType) {
      case 'conditional':
        preEmitValueNodes(ctx, target.nodeId, 'then', visited);
        preEmitValueNodes(ctx, target.nodeId, 'else', visited);
        break;
      case 'sequence': {
        preEmitValueNodes(ctx, target.nodeId, 'first', visited);
        preEmitValueNodes(ctx, target.nodeId, 'then', visited);
        const extra = Number(node.data.config.extraCount) || 0;
        for (let si = 2; si < 2 + extra; si++) {
          preEmitValueNodes(ctx, target.nodeId, `then_${si}`, visited);
        }
        break;
      }
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
      flushBranchValues(ctx, `${node.id}:then`);
      if (!compileFlowChain(ctx, node.id, 'then')) return false;
      if (hasElse) {
        ctx.lines.push(`  } else {`);
        flushBranchValues(ctx, `${node.id}:else`);
        if (!compileFlowChain(ctx, node.id, 'else')) return false;
      }
      ctx.lines.push(`  }`);
    } else if (node.data.nodeType === 'sequence') {
      if (!compileFlowChain(ctx, node.id, 'first')) return false;
      if (!compileFlowChain(ctx, node.id, 'then')) return false;
      const extra = Number(node.data.config.extraCount) || 0;
      for (let si = 2; si < 2 + extra; si++) {
        if (!compileFlowChain(ctx, node.id, `then_${si}`)) return false;
      }
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
      flushBranchValues(ctx, `${node.id}:body`);
      if (!compileFlowChain(ctx, node.id, 'body')) return false;
      ctx.lines.push(`  }`);
    } else if (node.data.nodeType === 'forEachInArray') {
      // Iterate over a typed-array source. The element is exposed via the node's
      // `element` output port (cached as a ValueRef so body action-node input
      // resolution finds it via the standard valueLocals path). Body value nodes
      // emit inside the WGSL `for` block (lexically scoped) since
      // preEmitValueNodes deliberately does NOT recurse into forEachInArray
      // bodies — element-dependent expressions stay inside the iteration scope
      // where the element variable is in scope.
      const arrSource = ctx.inputToSource.get(`${node.id}:array`);
      if (!arrSource) continue;
      const arrRef = resolveInputArray(ctx, node, 'array');
      if (!arrRef) {
        ctx.errors.push(`forEachInArray: input "array" must come from an array-producing node`);
        return false;
      }
      const fi = fresh(ctx, 'fei');
      const elemName = fresh(ctx, 'feiE');
      ctx.lines.push(`  for (var ${fi}: i32 = 0; ${fi} < ${arrRef.lenName}; ${fi} = ${fi} + 1) {`);
      ctx.lines.push(`    let ${elemName}: ${arrRef.elemType} = ${arrLoad(arrRef, fi)};`);
      setCachedPort(ctx, node.id, 'element', { expr: elemName, type: arrRef.elemType });
      flushBranchValues(ctx, `${node.id}:body`);
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
            if (hasDefault) {
              flushBranchValues(ctx, `${node.id}:default`);
              return compileFlowChain(ctx, node.id, 'default');
            }
            return true;
          }
          ctx.lines.push(`  if (${caseConds[ci]}) {`);
          flushBranchValues(ctx, `${node.id}:case_${ci}`);
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
          flushBranchValues(ctx, `${node.id}:case_${ci}`);
          if (!compileFlowChain(ctx, node.id, `case_${ci}`)) return false;
          ctx.lines.push(`  }`);
        }
        if (hasDefault) {
          ctx.lines.push(`  if (!${matched}) {`);
          flushBranchValues(ctx, `${node.id}:default`);
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
          // Skip when the source's OUTPUT PORT is an array (consuming emitter
          // handles it). Check the source port, not isArrayProducer(nodeType):
          // hybrid nodes like groupCounting expose both an array `indexes`
          // port and a scalar `count` port — skipping the whole node would
          // drop the scalar count silently. Mirrors the same fix in the
          // top-level compileValueNode input loop.
          const srcNode = ctx.nodeMap.get(source.nodeId);
          const srcDef = srcNode ? getNodeDef(srcNode.data.nodeType) : null;
          const srcPort = srcDef?.ports.find(p => p.id === source.portId);
          if (srcPort?.isArray) continue;
          const srcRef = compileValueNode(ctx, source.nodeId, source.portId);
          if (!srcRef) return false;
          inputs[port.id] = srcRef;
        } else {
          const inlineVal = getInlineValue(port, node.data.config);
          if (inlineVal !== undefined) {
            // `any` ports (arithmeticOperator x/y, setAttribute value, etc.) accept
          // fractional inline values; treating them as i32 would truncate the
          // value via `n | 0` inside inlineValueRef before the f32 op ever ran.
          inputs[port.id] = inlineValueRef(inlineVal, port.dataType === 'float' || port.dataType === 'any');
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
// P8 — Per-cell copy preamble dataflow analysis.
//
// Goal: skip the `attrsWrite[idx] = attrsRead[idx]` line for any attr we can
// PROVE is unconditionally written by setAttribute on every flow path. Saves
// step-time bandwidth on rules that fully recompute attrs each generation.
//
// Conservative rules (any failure → keep the copy):
//  - updateAttribute reads from the write buffer in place; without the copy
//    populating the slot, it reads garbage. So if updateAttribute(a) appears
//    ANYWHERE in the graph, attr a is NOT elidable.
//  - conditional with no else branch → no guaranteed contribution.
//  - switch needs caseCount > 0 AND a default branch (so every input value
//    matches some branch) AND firstMatchOnly mode (the only mode where the
//    branch sequence is deterministic).
//  - loop bodies might execute zero times → no guarantee.
// ---------------------------------------------------------------------------

function intersectSets(a: Set<string>, b: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const x of a) if (b.has(x)) out.add(x);
  return out;
}

function analyzeAlwaysWritten(
  ctx: CompileCtx, sourceNodeId: string, sourcePortId: string, depth: number,
): Set<string> {
  const out = new Set<string>();
  if (depth > 64) return out; // recursion guard
  const targets = ctx.flowOutputToTargets.get(`${sourceNodeId}:${sourcePortId}`) ?? [];
  for (const target of targets) {
    const node = ctx.nodeMap.get(target.nodeId);
    if (!node) continue;
    const t = node.data.nodeType;
    if (t === 'sequence') {
      for (const x of analyzeAlwaysWritten(ctx, node.id, 'first', depth + 1)) out.add(x);
      for (const x of analyzeAlwaysWritten(ctx, node.id, 'then', depth + 1)) out.add(x);
      const extra = Number(node.data.config.extraCount) || 0;
      for (let si = 2; si < 2 + extra; si++) {
        for (const x of analyzeAlwaysWritten(ctx, node.id, `then_${si}`, depth + 1)) out.add(x);
      }
    } else if (t === 'conditional') {
      const hasElse = ctx.flowOutputToTargets.has(`${node.id}:else`);
      if (hasElse) {
        const thenSet = analyzeAlwaysWritten(ctx, node.id, 'then', depth + 1);
        const elseSet = analyzeAlwaysWritten(ctx, node.id, 'else', depth + 1);
        for (const x of intersectSets(thenSet, elseSet)) out.add(x);
      }
    } else if (t === 'switch') {
      const caseCount = Number(node.data.config.caseCount) || 0;
      const hasDefault = ctx.flowOutputToTargets.has(`${node.id}:default`);
      const firstMatchOnly = node.data.config.firstMatchOnly !== false;
      if (caseCount === 0 && hasDefault) {
        for (const x of analyzeAlwaysWritten(ctx, node.id, 'default', depth + 1)) out.add(x);
      } else if (firstMatchOnly && caseCount > 0 && hasDefault) {
        let intersect: Set<string> | null = null;
        for (let ci = 0; ci < caseCount; ci++) {
          const s = analyzeAlwaysWritten(ctx, node.id, `case_${ci}`, depth + 1);
          intersect = intersect ? intersectSets(intersect, s) : s;
        }
        const defSet = analyzeAlwaysWritten(ctx, node.id, 'default', depth + 1);
        intersect = intersect ? intersectSets(intersect, defSet) : defSet;
        if (intersect) for (const x of intersect) out.add(x);
      }
      // else: not all branches guaranteed → no contribution
    } else if (t === 'loop') {
      // body may execute zero times — no guarantee
    } else if (t === 'setAttribute') {
      const attrId = node.data.config.attributeId as string;
      if (attrId) out.add(attrId);
    }
    // Other flow nodes (setIndicator, updateIndicator, setColorViewer,
    // stopEvent, setNeighborhoodAttribute*, setNeighborAttributeByIndex*,
    // updateAttribute) don't guarantee a cell-attr slot is initialised by
    // setAttribute.
  }
  return out;
}

function computeElidablePreambleAttrs(ctx: CompileCtx, entryNodeId: string): Set<string> {
  // updateAttribute(a) reads w_attr[idx] before mutating, so it depends on
  // the preamble copy. Any attr touched by an updateAttribute anywhere in the
  // graph must keep its preamble. setAttribute(a) is a pure write — safe.
  const requiresPreamble = new Set<string>();
  for (const node of ctx.nodeMap.values()) {
    if (node.data.nodeType === 'updateAttribute') {
      const aid = node.data.config.attributeId as string;
      if (aid) requiresPreamble.add(aid);
    }
  }
  const alwaysSet = analyzeAlwaysWritten(ctx, entryNodeId, 'do', 0);
  const elidable = new Set<string>();
  for (const a of alwaysSet) {
    if (!requiresPreamble.has(a)) elidable.add(a);
  }
  return elidable;
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

function compileEntry(opts: EntryOpts, base: Omit<CompileCtx, 'lines' | 'valueLocals' | 'arrayRefs' | 'localCounter' | 'errors' | 'currentMappingId' | 'allowAttrWrites' | 'sinkAnalysis' | 'branchLines'>): { code: string; errors: string[] } {
  // Sink analysis: per-value LCA-of-uses scope assignment. Drives
  // routeEmissionForNode (where each value's emit lines land) and the
  // flushBranchValues calls in compileFlowChain. Per-entry — each root has
  // its own flow tree.
  const sinkAnalysis = analyzeSinkScopes({
    nodes: base.graphNodes,
    edges: base.graphEdges,
    rootNodeId: opts.entry.id,
    rootFlowPortId: 'do',
  });
  const ctx: CompileCtx = {
    ...base,
    lines: [],
    valueLocals: new Map(),
    arrayRefs: new Map(),
    localCounter: 0,
    errors: [],
    currentMappingId: opts.currentMappingId,
    allowAttrWrites: opts.allowAttrWrites,
    sinkAnalysis,
    branchLines: new Map(),
  };
  if (opts.emitCopyPreamble) {
    // P8: skip per-cell copy for attrs that every flow path overwrites via
    // setAttribute (and never read via updateAttribute). Dead bandwidth for
    // models where the rule fully recomputes some attrs every step
    // (e.g. Game of Life: alive is always set).
    const skip = computeElidablePreambleAttrs(ctx, opts.entry.id);
    // Sub-attributes use a per-cell conditional copy instead of the bulk
    // pass-through, so they're skipped from the elidable preamble emission
    // and emitted via `emitSubAttrConditionalCopy` immediately after.
    for (const subAttr of subAttributesOf(ctx.model)) skip.add(subAttr.id);
    const copy = emitPerCellCopyPreamble(ctx.layout, skip);
    if (copy) ctx.lines.push(copy.replace(/\n$/, ''));
    for (const line of emitSubAttrConditionalCopy(ctx)) ctx.lines.push(line);
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
  // Sub-attributes are now natively supported on WebGPU:
  //   - Scalar reads (GetCellAttribute / GetNeighborAttributeByIndex / Tag)
  //     wrap with `select(undefinedValue, raw, parent_match)` in `readAttr*`.
  //   - Iteration consumers (FilterNeighbors, GetNeighborsAttrByIndexes,
  //     Aggregate/GroupOperator/GroupCounting/GroupStatement nbr-path) inject
  //     a `continue` skip on non-matching neighbours; for nbr-path aggregate,
  //     matchCount drives the average post-divide and the bestIdx for
  //     groupOperator min/max (position-in-filtered-set, matching JS/WASM).
  //   - Per-cell conditional copy at the top of `step` mirrors the JS/WASM
  //     copy-line semantics (auto-scrub one step after a flip-out).
  // The general WebGPU rejections still apply: median / random on aggregate
  // and groupOperator paths fall back to JS regardless of sub-attr status.

  const layout = computeWebGPULayout(model);

  // Expand macro instances first so the rest of the compile sees a flat graph.
  const expanded = expandMacros(graphNodes, graphEdges, model);
  if (expanded.error) {
    return {
      shaderCode: '', entryPoints: { step: 'step', outputMappings: [] },
      layout, viewerIds: {}, error: expanded.error,
    };
  }
  const nodes = expanded.nodes;
  const edges = expanded.edges;

  // Stop messages flat list — index in `_stopIdx` (1-based; 0 means no stop).
  // After expansion the graph is flat, so we only walk `nodes` (no macroDef
  // descent). The worker uses the JS compiler's stopMessages, but we still
  // need the local copy for the CompileCtx (used by stopEvent emit + diagnostics).
  const stopMessages: string[] = [];
  for (const n of nodes) {
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
    layout, viewerIds,
  };

  // Compile-time rejections.
  const modelErr = detectWebGPUModelIncompatibilities(model);
  if (modelErr) return { ...baseResult, error: modelErr };
  for (const n of nodes) {
    const issues = detectWebGPUIncompatibilities(n.data.nodeType, n.data.config, model);
    if (issues.length > 0) return { ...baseResult, error: `Node "${n.data.nodeType}": ${issues[0]}` };
  }

  const adj = buildAdjacency(nodes, edges, model);

  // Max neighbourhood size — used to size per-thread `var arr<T, N>` arrays for
  // array-producing nodes (filterNeighbors, getNeighborsAttrByIndexes, etc).
  // Floor of 1 so the WGSL `array<T, 1>` declaration is always valid.
  let maxArraySize = 1;
  for (const n of layout.nbrs) if (n.size > maxArraySize) maxArraySize = n.size;

  const baseCtx: Omit<CompileCtx, 'lines' | 'valueLocals' | 'arrayRefs' | 'localCounter' | 'errors' | 'currentMappingId' | 'allowAttrWrites' | 'sinkAnalysis' | 'branchLines'> = {
    model, layout, viewerIds, stopMessages, maxArraySize,
    nodeMap: adj.nodeMap,
    inputToSource: adj.inputToSource,
    inputToSources: adj.inputToSources,
    flowOutputToTargets: adj.flowOutputToTargets,
    outDegree: adj.outDegree,
    graphNodes: nodes,
    graphEdges: edges,
  };

  // Step entry point — root is the (typically single) Step node.
  const stepNodes = nodes.filter(n => n.data.nodeType === 'step');
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

  // Per-mapping output shaders. Mappings without a matching graph are SKIPPED
  // entirely — emitting an empty pipeline that does nothing leaves stale colors
  // in the GPU buffer. Skipping makes `dispatchOutputMapping` return false at
  // runtime, which the worker treats as a fall-through to writeDefaultColors.
  const outputMappings: Array<{ mappingId: string; entry: string }> = [];
  const outputNodes = nodes.filter(n => n.data.nodeType === 'outputMapping');
  for (const m of (model.mappings || [])) {
    if (!m.isAttributeToColor) continue;
    const fnName = 'outputMapping_' + sanitiseWgslName(m.id);
    const root = outputNodes.find(o => (o.data.config as Record<string, unknown>).mappingId === m.id);
    if (!root) continue;
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

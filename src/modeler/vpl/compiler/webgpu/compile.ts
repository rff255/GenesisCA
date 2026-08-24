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
import { readColorScaleStops, colorScaleHasAlpha, type ColorScaleStop } from '../../nodes/ColorScaleNode';
import { readCategoricalEntries, readCategoricalDefault, categoricalHasAlpha, type CategoricalEntry } from '../../nodes/CategoricalColorNode';
import { colorConstantHasAlpha } from '../../nodes/GetColorConstantNode';
import { CURRENT_VIEWER_SENTINEL } from '../../nodes/SetCellLooksNode';
import { parseHandleId } from '../../types';
import {
  detectWebGPUIncompatibilities, detectWebGPUModelIncompatibilities,
} from '../../nodes/nodeValidation';
import { getInlineValue, parseInlineNum } from '../inlinePort';
import {
  randomDistribution, randomRefSource, RANDOM_DEG2RAD, RANDOM_TAU, RANDOM_LEN_EPS,
} from '../../nodes/GetRandomNode';
import { INVALID_NI, packNI, packNI3, NI_ARRAY_PRODUCERS } from '../niCodec';
import { analyzeSinkScopes, CELL_TOP, type ScopeId, type SinkAnalysisResult } from '../sinkAnalysis';
import { canonicalizeAccessorEdges } from '../accessorCSE';
import { injectLinkedOutputMappings } from '../linkedOutputMappings';
import { collapseReroutes } from '../rerouteCollapse';
import { expandMultiAttrs } from '../multiAttrExpand';
import { expandComposites } from '../expandComposites';
import { lowerVectorAttrs } from '../vectorAttr';
import { expandMacros } from '../macroExpand';
import { cellUsesGeneration } from '../generationUse';
import { computeVolatileHoist, computeVolatileValueClosure } from '../volatileHoist';
import { makeProducesArray } from '../arrayRelay';
import { subAttrInfo, subAttributesOf } from '../subAttribute';
import { emitWgsl } from '../expression/emitWgsl';
import { buildVarMap, parseExpression, clampVisibleCount } from '../expression/parser';
import { emitLogicWgsl } from '../expression/emitLogic';
import { buildLogicVarMap, parseLogicExpression } from '../expression/logicParser';

export interface WebGPUEntryPoints {
  step: string;
  outputMappings: Array<{ mappingId: string; entry: string }>;
  /** Optional Init Event entry-point name. Present iff the graph contains
   *  an InitEventNode AND variegated cells (or any other init-only writes)
   *  are needed. The worker dispatches it once per Reset. */
  init?: string;
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
  /** Context-aware "does this source node emit an array?" — true for static
   *  array producers AND a valueSwitch whose both branches relay arrays. Used at
   *  every source-disambiguation site (resolveInputArray gate, aggregate /
   *  groupOperator / groupStatement dispatch, pre-emit walk). Shared with WASM
   *  via `compiler/arrayRelay.ts`. */
  producesArray: (node: GraphNode) => boolean;

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
  /** Volatile value node ids (transitive value-consumers of any `getVariable`).
   *  Their emitScope is forced to CELL_TOP so routeEmissionForNode emits them
   *  at the current flow position; they are skipped during preEmit (via
   *  `suppressVolatile`) and force-emitted by compileFlowChain before the flow
   *  node identified by `volatileHoist`. */
  volatile: Set<string>;
  /** flow node id → volatile value ids to emit immediately before it. */
  volatileHoist: Map<string, string[]>;
  /** True only during the preEmit pass — makes compileValueNode/compileArrayNode
   *  skip volatile nodes so they aren't emitted at function-top (stale reads). */
  suppressVolatile?: boolean;
  /** True only while force-emitting a volatile (+ its transitive value inputs)
   *  before a flow node — routeEmissionForNode then emits at the CURRENT ctx.lines
   *  position regardless of sink scope, so a non-volatile input reachable only
   *  through the volatile (e.g. a getRandom feeding volatile arithmetic) lands
   *  in-scope rather than in an already-flushed branch buffer. */
  forceCurrentScope?: boolean;
  /** Flat post-macro-expansion graph; needed to feed the sink analyzer. */
  graphNodes: GraphNode[];
  graphEdges: GraphEdge[];
  /** Local counter for fresh variable name allocation. */
  localCounter: number;
  /** Errors accumulated; non-empty means compile failed for this entry. */
  errors: string[];
  /** When emitting an outputMapping shader, this is the mappingId being
   *  emitted. setCellLooks for OTHER mappings becomes a no-op (compile-time
   *  skipped). When emitting the step shader, this is null and setCellLooks
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
  // forceCurrentScope: while a volatile (+ its transitive inputs) is force-emitted
  // before a flow node, every emission lands at the current ctx.lines position.
  if (ctx.forceCurrentScope || scope === CELL_TOP) return emit();
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

/** The (stable, per-loop-node) WGSL identifier of a Loop's iteration counter —
 *  minted on first request and cached on the node's `index` port so consumers
 *  compiled BEFORE the loop's flow emit and the `for (var …)` declaration
 *  itself agree on the name. */
function loopIndexRef(ctx: CompileCtx, loopNodeId: string): ValueRef {
  const cached = getCachedPort(ctx, loopNodeId, 'index');
  if (cached) return cached;
  const ref: ValueRef = { expr: fresh(ctx, 'li'), type: 'i32' };
  setCachedPort(ctx, loopNodeId, 'index', ref);
  return ref;
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

/** The largest finite f32, as a WGSL float literal — the identity element for a `min`
 *  fold (and negated, for `max`).
 *
 *  ⚠️ It MUST be written as this exact 17-digit decimal, NOT the rounded `3.4028235e38`.
 *  WGSL parses a float literal to f64 and rejects it if that value exceeds f32::MAX:
 *  `3.4028235e38` is 340282349999999991754788743781432688640, which is LARGER than
 *  f32::MAX (340282346638528859811704183484516925440), so Naga rejects the shader with
 *  "value … cannot be represented as 'f32'" — and the model silently falls back off the
 *  WebGPU target. This spelling is the shortest decimal that round-trips f32::MAX
 *  exactly, so the f64 pre-check passes. Verified on a real device.
 *
 *  Shared by the cell-grid and agent WebGPU compilers so the two cannot drift; guarded
 *  by scripts/verify-wgsl-float-literals.mjs. */
export const WGSL_F32_MAX = '3.4028234663852886e38';

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

/**
 * Fold an f32 ref that is a WHOLE-NUMBER literal (what `inlineValueRef` emits
 * for an unwired `float`/`any` port) into the i32 literal form. Same value; a
 * fractional or non-literal ref is returned untouched, because `n | 0` there
 * would NOT be the same value. Used only where the consumer immediately casts to
 * bool, to keep an unwired port's emitted text stable across a port's declared
 * dataType.
 */
function foldInlineF32ToI32(v: ValueRef): ValueRef {
  if (v.type !== 'f32') return v;
  const n = Number(v.expr);
  if (!Number.isInteger(n)) return v;
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

/** WGSL type for a Variable's storage. bool/integer/tag use i32 (WGSL has
 *  a native bool but reading/writing through it via storage buffers is awkward
 *  — we already use i32 for cell attributes of the same logical types).
 *  float uses f32 (WGSL has no f64; we accept the precision loss vs JS/WASM,
 *  same as the rest of the WebGPU target). */
function variableWgslType(dataType: string): WgslType {
  return dataType === 'float' ? 'f32' : 'i32';
}

/** WGSL literal for a Variable's initialValue. Bools become `0` / `1`
 *  (we store them in i32 slots), floats parse as decimal with `.0` suffix
 *  if integral, integers parse as int. */
function variableInitWgsl(v: import('../../../../model/types').Variable): string {
  const raw = v.initialValue ?? '0';
  if (v.dataType === 'bool') return (raw === 'true' || raw === '1') ? '1' : '0';
  const n = Number(raw);
  if (!Number.isFinite(n)) return '0';
  if (v.dataType === 'float') {
    // WGSL f32 literals need a decimal point or `f` suffix to parse as float.
    return Number.isInteger(n) ? `${n}.0` : `${n}`;
  }
  return `${n | 0}`;
}

/** Sanitised WGSL var name for a Variable id. Mirrors `variableLocalName`
 *  in the JS compile path. */
function variableWgslName(variableId: string): string {
  return '_var_' + variableId.replace(/[^a-zA-Z0-9_]/g, '_');
}

/** Emit `var<function>` declarations + per-cell initialisation at the top
 *  of an entry function. Scalars: `var<function> _var_X: i32 = 0; ... = init;`
 *  Arrays: `var<function> _var_X: array<i32, N>;` followed by an unrolled
 *  init loop (`_var_X[0] = init; _var_X[1] = init; ...`). For small N
 *  (typical chemistry: N=4) the unroll keeps the shader compile fast; for
 *  large N a runtime for-loop would be more compact, but per-thread arrays
 *  rarely exceed N=8 in practice. */
function emitVariableDeclsWgsl(ctx: CompileCtx): void {
  const variables = ctx.model.variables || [];
  if (variables.length === 0) return;
  for (const v of variables) {
    const ty = variableWgslType(v.dataType);
    const name = variableWgslName(v.id);
    const init = variableInitWgsl(v);
    if (v.kind === 'scalar') {
      // Declared + initialised in one line.
      ctx.lines.push(`  var ${name}: ${ty} = ${init};`);
    } else {
      const length = Math.max(1, Number(v.length) | 0) || 1;
      ctx.lines.push(`  var ${name}: array<${ty}, ${length}>;`);
      // Unrolled fill — small N typical, and avoids a runtime loop that
      // would also bloat the shader text marginally.
      for (let i = 0; i < length; i++) {
        ctx.lines.push(`  ${name}[${i}] = ${init};`);
      }
    }
  }
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
    case 'getAllFacingLabels':
    case 'interactionTableMap':
    // getVariable dispatches through this path when reading an array
    // variable; scalar variables go through the value-emitter path. The
    // emitter throws if the variable's kind doesn't match the dispatch.
    case 'getVariable':
      return true;
    default:
      return false;
  }
}

/** Multi-output array node types: a single emit fills multiple ArrayRefs
 *  cached under `${nodeId}::${portId}`. compileArrayNode disambiguates via
 *  the optional portId arg, and the emitter manually populates each port's
 *  slot in `ctx.arrayRefs`. */
const MULTI_OUTPUT_ARRAY_TYPES = new Set<string>([
  'getAllFacingLabels',
]);

/** Canonical default port for each multi-output array node — used when the
 *  caller doesn't pass a portId. MUST match the port the emitter returns. */
const MULTI_OUTPUT_ARRAY_DEFAULT_PORT: Record<string, string> = {
  getAllFacingLabels: 'myFaceLabels',
};

function compileArrayNode(ctx: CompileCtx, nodeId: string, portId?: string): ArrayRef | null {
  // Mirror compileValueNode: skip volatile array values during preEmit.
  if (ctx.suppressVolatile && ctx.volatile.has(nodeId)) return null;
  const node = ctx.nodeMap.get(nodeId);
  if (!node) { ctx.errors.push(`unknown array node ${nodeId}`); return null; }
  const isMulti = MULTI_OUTPUT_ARRAY_TYPES.has(node.data.nodeType);

  const resolvedPort = isMulti
    ? (portId ?? MULTI_OUTPUT_ARRAY_DEFAULT_PORT[node.data.nodeType] ?? '')
    : '';
  const cacheKey = isMulti ? `${nodeId}::${resolvedPort}` : nodeId;
  const cached = ctx.arrayRefs.get(cacheKey);
  if (cached) return cached;

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
        // A scalar-typed port fed by an array producer (valueSwitch's ifValue /
        // elseValue relaying arrays): skip scalar-resolution — the emitter reads
        // it via resolveInputArray. (Static `isArray` ports are skipped above.)
        const portSrcNode = ctx.nodeMap.get(src.nodeId);
        if (portSrcNode && ctx.producesArray(portSrcNode)) continue;
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
  if (isMulti) {
    // Multi-output emitter is responsible for caching each port's ArrayRef
    // under `${nodeId}::${portId}` before returning. Re-fetch the requested
    // port's ref (the emitter's return value is the canonical default port).
    const fresh = ctx.arrayRefs.get(cacheKey);
    if (fresh) return fresh;
    return result;
  }
  ctx.arrayRefs.set(nodeId, result);
  return result;
}

function resolveInputArray(ctx: CompileCtx, node: GraphNode, portId: string): ArrayRef | null {
  const src = ctx.inputToSource.get(`${node.id}:${portId}`);
  if (!src) return null;
  const srcNode = ctx.nodeMap.get(src.nodeId);
  if (!srcNode) return null;
  if (!ctx.producesArray(srcNode)) return null;
  return compileArrayNode(ctx, src.nodeId, src.portId);
}

const ARRAY_NODE_EMITTERS: Record<string, NodeArrayEmitter> = {

  // valueSwitch (array mode): result = cond ? ifArray : elseArray. valueSwitch is
  // a dual-mode relay — scalar consumers reach VALUE_NODE_EMITTERS; ctx.producesArray
  // routes an array-relay instance (both branches are array producers) here. WGSL
  // var<function> arrays can't alias, so COPY the selected branch into a fresh
  // result array (vs WASM's zero-copy offset select). See compiler/arrayRelay.ts.
  valueSwitch: ({ node, ctx, inputs }) => {
    const ifArr = resolveInputArray(ctx, node, 'ifValue');
    const elseArr = resolveInputArray(ctx, node, 'elseValue');
    if (!ifArr || !elseArr) {
      ctx.errors.push(`valueSwitch (array mode): both "If" and "Else" must come from array-producing nodes`);
      return null;
    }
    if (ifArr.elemType !== elseArr.elemType) {
      ctx.errors.push(`valueSwitch (array mode): "If" and "Else" arrays must have the same element type`);
      return null;
    }
    const cond = castTo(inputs['condition'] ?? { expr: 'false', type: 'bool' }, 'bool');
    const out = allocArray(ctx, ifArr.elemType, 'arrVSel', Math.max(ifArr.maxLen, elseArr.maxLen));
    const i = fresh(ctx, 'vsi');
    ctx.lines.push(`  if (${cond}) {`);
    ctx.lines.push(`    for (var ${i}: i32 = 0; ${i} < ${ifArr.lenName}; ${i} = ${i} + 1) { ${out.name}[${i}] = ${arrLoad(ifArr, i)}; }`);
    ctx.lines.push(`    ${out.lenName} = ${ifArr.lenName};`);
    ctx.lines.push(`  } else {`);
    ctx.lines.push(`    for (var ${i}: i32 = 0; ${i} < ${elseArr.lenName}; ${i} = ${i} + 1) { ${out.name}[${i}] = ${arrLoad(elseArr, i)}; }`);
    ctx.lines.push(`    ${out.lenName} = ${elseArr.lenName};`);
    ctx.lines.push(`  }`);
    return out;
  },

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
    // 3D Grid CA: pack 3-axis offsets from coords3d; 2D packs the verbatim
    // 2-axis codec (byte-identical). gridDepth>1 is the layout-level 3D predicate.
    const is3d = ctx.layout.gridDepth > 1;
    const coords3d = nbr.coords3d ?? [];
    const len = is3d ? coords3d.length : nbr.coords.length;
    const arr = allocArray(ctx, 'i32', 'arrAllNbr', len);
    for (let k = 0; k < len; k++) {
      const pk = is3d
        ? packNI3(coords3d[k]![0], coords3d[k]![1], coords3d[k]![2])
        : packNI(nbr.coords[k]![0], nbr.coords[k]![1]);
      ctx.lines.push(`  ${arr.name}[${k}] = ${pk};`);
    }
    ctx.lines.push(`  ${arr.lenName} = ${len};`);
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
    // Expose final length on the `count` scalar value port (mirrors filterNeighbors).
    setCachedPort(ctx, node.id, 'count', { expr: out.lenName, type: 'i32' });
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
    } else if (sources.length === 1 && firstSrcNode && ctx.producesArray(firstSrcNode)) {
      const arrSrc = compileArrayNode(ctx, firstSrc.nodeId, firstSrc.portId);
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
      const arrSrc = firstSrcNode && ctx.producesArray(firstSrcNode) && sources.length === 1
        ? compileArrayNode(ctx, firstSrc.nodeId, firstSrc.portId) : null;
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

  // -- Variegated Cells: Interaction Table Map ----------------------------
  // Vectorised LookupInteraction over two parallel face-label arrays. WGSL
  // Local Variable read (array path). Returns an ArrayRef pointing at the
  // function-scope `var<function>` array declared by emitVariableDeclsWgsl.
  // Scalar variables go through VALUE_NODE_EMITTERS['getVariable']; this
  // path errors out for them.
  getVariable: ({ node, ctx }) => {
    const variableId = node.data.config.variableId as string;
    const v = (ctx.model.variables || []).find(x => x.id === variableId);
    if (!v) {
      ctx.errors.push(`getVariable (array): unknown variable "${variableId}"`);
      return null;
    }
    if (v.kind !== 'array') {
      ctx.errors.push(`getVariable: variable "${variableId}" is a scalar; array consumers need an array-typed variable`);
      return null;
    }
    const length = Math.max(1, Number(v.length) | 0) || 1;
    const elemType = variableWgslType(v.dataType);
    const name = variableWgslName(v.id);
    // The lenName needs to be a WGSL local holding the constant length so
    // consumers that read `arr.lenName` get a valid identifier (not a
    // numeric literal). emitLet declares and returns a fresh name.
    const lenRef = emitLet(ctx, 'i32', `${length}`, 'vlen');
    return {
      kind: 'array',
      name,
      lenName: lenRef.expr,
      elemType,
      maxLen: length,
    };
  },

  // emits a single loop reading f32 entries from varAux at word offset
  // `tableOff + a * labelCount + b`. Output length = min(myFaces, theirFaces).
  // Unknown tableId returns an empty array (parity with JS/WASM).
  interactionTableMap: ({ node, ctx }) => {
    // No variegation guard — tag×tag tables need no faces.
    const tableId = (node.data.config.tableId as string) || '';
    const tableLayout = tableId ? ctx.layout.interactionTableOffsets[tableId] : undefined;
    const myArr = resolveInputArray(ctx, node, 'myFaces');
    const theirArr = resolveInputArray(ctx, node, 'theirFaces');
    if (!myArr || !theirArr) {
      ctx.errors.push('interactionTableMap: missing myFaces or theirFaces input');
      return null;
    }
    const out = allocArray(ctx, 'f32', 'arrITM', Math.min(myArr.maxLen, theirArr.maxLen));
    if (!tableLayout || (tableLayout.dims && tableLayout.dims.length !== 2)) {
      // Tableless — or a multi-axis table with N≠2 axes (the node's shape is
      // two parallel index arrays; nodeValidation badges it): empty output.
      ctx.lines.push(`  ${out.lenName} = 0;`);
      return out;
    }
    const off = tableLayout.wordOffset;
    // Multi-axis N=2: clamped indices + intRange offsets (D-NDT-5).
    // Legacy 2-axis: raw indices, byte-identical to the pre-N-D emit.
    const ndDims = tableLayout.dims && tableLayout.dims.length === 2 ? tableLayout.dims : null;
    const ndMins = ndDims ? (tableLayout.mins ?? []) : [];
    const colCount = ndDims ? ndDims[1]! : tableLayout.colCount; // row-major stride
    const k = fresh(ctx, 'itm');
    const n = fresh(ctx, 'itmN');
    const clampWgsl = (raw: string, axis: number): string => {
      if (!ndDims) return raw;
      const min = Math.floor(ndMins[axis] ?? 0) || 0;
      const hi = Math.max(0, ndDims[axis]! - 1);
      return `clamp(${raw}${min !== 0 ? ` - ${min}` : ''}, 0, ${hi})`;
    };
    ctx.lines.push(`  let ${n}: i32 = min(${myArr.lenName}, ${theirArr.lenName});`);
    ctx.lines.push(`  for (var ${k}: i32 = 0; ${k} < ${n}; ${k} = ${k} + 1) {`);
    ctx.lines.push(`    let _itmA_${k}: i32 = ${clampWgsl(arrLoad(myArr, k), 0)};`);
    ctx.lines.push(`    let _itmB_${k}: i32 = ${clampWgsl(arrLoad(theirArr, k), 1)};`);
    ctx.lines.push(
      `    ${out.name}[${k}] = bitcast<f32>(varAux[u32(${off} + _itmA_${k} * ${colCount} + _itmB_${k})]);`,
    );
    ctx.lines.push(`  }`);
    ctx.lines.push(`  ${out.lenName} = ${n};`);
    return out;
  },

  // -- Variegated Cells: Get All Facing Labels (multi-output arrays) -----
  // Emits two parallel WGSL arrays of length 8 (one per direction in
  // N/NE/E/SE/S/SW/W/NW order). Both ArrayRefs are cached under
  // `${nodeId}::myFaceLabels` and `${nodeId}::theirFaceLabels`; the emitter
  // returns myFaceLabels as the canonical default. The 8-direction loop is
  // unrolled at emit time — branchless straight-line WGSL for the GPU.
  //
  // Boundary treatment is baked at compile time (torus wrap vs sentinel
  // clamp). Out-of-bounds neighbours (constant boundary only) resolve to
  // labelIndex 0 (`none`).
  getAllFacingLabels: ({ node, ctx }) => {
    if (!ctx.layout.variegatedEnabled) {
      ctx.errors.push('getAllFacingLabels: variegated cells disabled');
      return null;
    }
    const sourceAttrId = (node.data.config._sourceAttrId as string) || '';
    const sourceAttr = sourceAttrId ? getAttr(ctx.layout, sourceAttrId) : null;
    const boundary = (node.data.config._boundaryTreatment as string) || 'torus';
    const cardinalsOnly = !!node.data.config.cardinalsOnly;
    const w = ctx.layout.orientationWordOffset;
    const lookupW = ctx.layout.facePatternLookupWordOffset;
    const total = ctx.layout.total;
    const W = ctx.model.properties.gridWidth;
    const H = ctx.model.properties.gridHeight;

    const outLen = cardinalsOnly ? 4 : 8;
    const myArr = allocArray(ctx, 'i32', 'gafl_my', outLen);
    const theirArr = allocArray(ctx, 'i32', 'gafl_their', outLen);
    ctx.lines.push(`  ${myArr.lenName} = ${outLen};`);
    ctx.lines.push(`  ${theirArr.lenName} = ${outLen};`);

    // Read my species + orientation once.
    const mySpec = fresh(ctx, 'gafl_ms');
    const mySpecExpr = sourceAttr
      ? `bitcast<i32>(attrsRead[${sourceAttr.wordOffset}u + idx])`
      : '0';
    ctx.lines.push(`  let ${mySpec}: i32 = ${mySpecExpr};`);
    const myOri = fresh(ctx, 'gafl_mo');
    ctx.lines.push(`  let ${myOri}: i32 = bitcast<i32>(attrsRead[${w}u + idx]);`);

    // Row / col helpers (idx is u32; cast to i32 for signed arithmetic).
    const rowExpr = `i32(idx / ${W}u)`;
    const colExpr = `i32(idx % ${W}u)`;

    const OFFSETS: ReadonlyArray<readonly [number, number]> = [
      [-1, 0], [-1, 1], [0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1],
    ];
    // In cardinalsOnly mode iterate only Moore slots 0/2/4/6 (= N/E/S/W) but
    // write to output indices 0..3. The face-rotation arithmetic still uses
    // the Moore index because face patterns are 8-slot-keyed.
    const iterations: ReadonlyArray<readonly [number, number]> = cardinalsOnly
      ? [[0, 0], [2, 1], [4, 2], [6, 3]]
      : [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6], [7, 7]];

    for (const [d, outIdx] of iterations) {
      const [dr, dc] = OFFSETS[d]!;
      const dirP4 = (d + 4) & 7;
      let nciExpr: string;
      if (boundary === 'constant') {
        // Branched: var with sentinel default, overwrite when in-bounds.
        const nRow = fresh(ctx, 'gafl_nr');
        const nCol = fresh(ctx, 'gafl_nc');
        const nci = fresh(ctx, 'gafl_nci');
        ctx.lines.push(`  let ${nRow}: i32 = ${rowExpr} + ${dr};`);
        ctx.lines.push(`  let ${nCol}: i32 = ${colExpr} + ${dc};`);
        ctx.lines.push(`  var ${nci}: i32 = ${total};`);
        ctx.lines.push(
          `  if (${nRow} >= 0 && ${nRow} < ${H} && ${nCol} >= 0 && ${nCol} < ${W}) {`,
          `    ${nci} = ${nRow} * ${W} + ${nCol};`,
          `  }`,
        );
        nciExpr = nci;
      } else {
        // torus
        const nRowE = dr === 0 ? rowExpr : `((${rowExpr} + ${dr}) % ${H} + ${H}) % ${H}`;
        const nColE = dc === 0 ? colExpr : `((${colExpr} + ${dc}) % ${W} + ${W}) % ${W}`;
        nciExpr = `((${nRowE}) * ${W} + (${nColE}))`;
      }
      const nciLet = fresh(ctx, 'gafl_nc2');
      ctx.lines.push(`  let ${nciLet}: i32 = ${nciExpr};`);

      const theirSpec = fresh(ctx, 'gafl_ts');
      const theirSpecExpr = sourceAttr
        ? `bitcast<i32>(attrsRead[${sourceAttr.wordOffset}u + u32(${nciLet})])`
        : '0';
      ctx.lines.push(`  let ${theirSpec}: i32 = ${theirSpecExpr};`);
      const theirOri = fresh(ctx, 'gafl_to');
      ctx.lines.push(`  let ${theirOri}: i32 = bitcast<i32>(attrsRead[${w}u + u32(${nciLet})]);`);

      const myFaceIdx = fresh(ctx, 'gafl_mf');
      ctx.lines.push(`  let ${myFaceIdx}: i32 = ((${d} + 2 * ${myOri}) & 7);`);
      const theirFaceIdx = fresh(ctx, 'gafl_tf');
      ctx.lines.push(`  let ${theirFaceIdx}: i32 = ((${dirP4} + 2 * ${theirOri}) & 7);`);

      // myLabel & theirLabel via select() for branchless writes.
      const myLabel = fresh(ctx, 'gafl_ml');
      const myLabelExpr =
        `select(0, bitcast<i32>(varAux[u32(${lookupW} + ${mySpec} * 8 + ${myFaceIdx})]), `
        + `(${mySpec} >= 0))`;
      ctx.lines.push(`  let ${myLabel}: i32 = ${myLabelExpr};`);
      const theirLabel = fresh(ctx, 'gafl_tl');
      const theirLabelExpr =
        `select(0, bitcast<i32>(varAux[u32(${lookupW} + ${theirSpec} * 8 + ${theirFaceIdx})]), `
        + `(${nciLet} < ${total}))`;
      ctx.lines.push(`  let ${theirLabel}: i32 = ${theirLabelExpr};`);

      ctx.lines.push(`  ${myArr.name}[${outIdx}] = ${myLabel};`);
      ctx.lines.push(`  ${theirArr.name}[${outIdx}] = ${theirLabel};`);
    }

    ctx.arrayRefs.set(`${node.id}::myFaceLabels`, myArr);
    ctx.arrayRefs.set(`${node.id}::theirFaceLabels`, theirArr);
    return myArr;
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
    if (t === 'orientation') {
      // Orientation: integer 0..3 (N/E/S/W). Clamp to range as a safety net.
      const n = typeof raw === 'number' ? raw : (parseInt(String(raw ?? '0'), 10) || 0);
      num = Number.isFinite(n) && n >= 0 && n <= 3 ? (n | 0) : 0;
      return emitLet(ctx, 'i32', `${num}`, 'ko');
    }
    if (t === 'faceLabel') {
      // Face label index pre-resolved into _resolvedFaceLabelIndex by
      // compile.ts::preResolveVariegatedNodes. Unresolved is -1.
      const idx = parseInt(String(node.data.config._resolvedFaceLabelIndex ?? -1), 10);
      num = Number.isFinite(idx) ? idx : -1;
      return emitLet(ctx, 'i32', `${num | 0}`, 'kfl');
    }
    // integer / tag
    num = typeof raw === 'number' ? raw : (parseInt(String(raw ?? '0'), 10) || 0);
    return emitLet(ctx, 'i32', `${num | 0}`, 'ki');
  },

  // Wave A.6: NIs are packed (dr, dc) i32. neighborIndexFromOffset takes
  // dr/dc as input ports and emits the packed value at runtime.
  neighborIndexFromOffset: ({ ctx, inputs }) => {
    const drRef = inputs['dr'] ?? { expr: '0', type: 'i32' as WgslType };
    const dcRef = inputs['dc'] ?? { expr: '0', type: 'i32' as WgslType };
    const drI = castTo(drRef, 'i32');
    const dcI = castTo(dcRef, 'i32');
    if (ctx.layout.gridDepth > 1) {
      // 3D: pack three 10-bit fields (dr<<20 | dc<<10 | dl).
      const dlRef = inputs['dl'] ?? { expr: '0', type: 'i32' as WgslType };
      const dlI = castTo(dlRef, 'i32');
      return emitLet(
        ctx,
        'i32',
        `(((${drI}) & 0x3FF) << 20) | (((${dcI}) & 0x3FF) << 10) | ((${dlI}) & 0x3FF)`,
        'nio',
      );
    }
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
    if (ctx.layout.gridDepth > 1) {
      // 3D: 10-bit dr/dc/dl. (i32 `>>` is arithmetic — sign-extends.)
      const drRef = emitLet(ctx, 'i32', `((${inName}) << 2) >> 22`, 'bdnDr');
      const dcRef = emitLet(ctx, 'i32', `((${inName}) << 12) >> 22`, 'bdnDc');
      const dlRef = emitLet(ctx, 'i32', `((${inName}) << 22) >> 22`, 'bdnDl');
      setCachedPort(ctx, node.id, 'dr', drRef);
      setCachedPort(ctx, node.id, 'dc', dcRef);
      setCachedPort(ctx, node.id, 'dl', dlRef);
      return drRef;
    }
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
    if (ctx.layout.gridDepth > 1) {
      // 3D: decode 10-bit dr/dc/dl, negate dr/dc as configured, dl passes through.
      const drExpr = flipDr ? `(-(((${inName}) << 2) >> 22))` : `(((${inName}) << 2) >> 22)`;
      const dcExpr = flipDc ? `(-(((${inName}) << 12) >> 22))` : `(((${inName}) << 12) >> 22)`;
      const dlExpr = `(((${inName}) << 22) >> 22)`;
      return emitLet(
        ctx,
        'i32',
        `(((${drExpr}) & 0x3FF) << 20) | (((${dcExpr}) & 0x3FF) << 10) | ((${dlExpr}) & 0x3FF)`,
        'flipR',
      );
    }
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
      // A colour model attr ALWAYS occupies four slots (`modelAttrSlotKeys`), so
      // alpha is not gated here the way the palette nodes' is.
      const offs = ['r', 'g', 'b', 'a'].map(ch => ctx.layout.modelAttrOffset[attrId + '_' + ch]);
      if (offs.some(o => o === undefined)) {
        ctx.errors.push(`getModelAttribute color: unknown ${attrId}`); return null;
      }
      const fetch = (off: number): ValueRef => {
        const vecIdx = Math.floor(off / 16);
        const compName = ['x', 'y', 'z', 'w'][(off % 16) / 4]!;
        return emitLet(ctx, 'i32', `i32(modelAttrs[${vecIdx}u].${compName})`, 'mac');
      };
      const refs = offs.map(o => fetch(o!));
      ['r', 'g', 'b', 'a'].forEach((p, i) => setCachedPort(ctx, node.id, p, refs[i]!));
      return refs[0]!;
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
      case 'negate': expr = `(-(${x}))`; break;
      case 'floor': expr = `floor(${x})`; break;
      case 'ceil': expr = `ceil(${x})`; break;
      // floor(x + 0.5) — NOT WGSL round() (banker's), matching JS/WASM.
      case 'round': expr = `floor((${x}) + 0.5)`; break;
      case 'pow': expr = `pow(${x}, ${y})`; break;
      case 'exp': expr = `exp(${x})`; break;
      case 'log': expr = `log(${x})`; break;
      case 'sin': expr = `sin(${x})`; break;
      case 'cos': expr = `cos(${x})`; break;
      case 'tan': expr = `tan(${x})`; break;
      case 'tanh': expr = `tanh(${x})`; break;
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
    // Neighbor Index compare: integers up to ~2^31 lose precision as f32, so
    // compare the operands as i32 (equality only). Bool/tag values are small
    // enough to stay exact through the f32 path below.
    if ((node.data.config.compareType as string) === 'neighborIndex') {
      const xi = castTo(inputs['x'] ?? { expr: '0', type: 'i32' }, 'i32');
      const yi = castTo(inputs['y'] ?? { expr: '0', type: 'i32' }, 'i32');
      const cmp = (op === '!=' || op === '!==') ? '!=' : '==';
      return emitLet(ctx, 'bool', `(${xi} ${cmp} ${yi})`, 'cmp');
    }
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

  // Logical Expression node: parse the formula, emit the AST as a WGSL bool
  // expr. Each accessor is the equivalent single node's own operand form above:
  // `logicOperator`'s `castTo(…, 'bool')` for a boolean read, `statement`'s
  // `castTo(…, 'f32')` for a comparison operand — so the two agree for any
  // input. The numeric one is only reached by a formula that HAS a comparison.
  logicalExpression: ({ node, ctx, inputs }) => {
    const visibleCount = clampVisibleCount(node.data.config.visibleCount);
    const { map, errors } = buildLogicVarMap(node.data.config, visibleCount);
    if (errors.length > 0) { ctx.errors.push(`logicalExpression: ${errors[0]}`); return null; }
    const res = parseLogicExpression(String(node.data.config.expression ?? ''), map);
    if ('error' in res) { ctx.errors.push(`logicalExpression: ${res.error}`); return null; }
    const expr = emitLogicWgsl(
      res.ast,
      (portId) => {
        // Same rationale as the WASM emitter's bool accessor: an UNWIRED port's
        // inline ref is f32 (these inputs are `any` so the comparison tier can
        // read them as numbers), so fold an integral inline constant back to the
        // i32 form the bool cast consumes — the same value, and it keeps a
        // comparison-free formula's shader text identical to the pre-comparison
        // build. Only for an UNWIRED port: a wired ref carries the SOURCE's type.
        const wired = ctx.inputToSource.has(`${node.id}:${portId}`);
        const ref = inputs[portId] ?? { expr: 'false', type: 'bool' as const };
        return castTo(wired ? ref : foldInlineF32ToI32(ref), 'bool');
      },
      (portId) => castTo(inputs[portId] ?? { expr: '0.0', type: 'f32' }, 'f32'),
    );
    return emitLet(ctx, 'bool', expr, 'lexp');
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

  // joinNeighbors mirrors filterNeighbors: array emit fills `result` and caches
  // `count`; this value-emitter entry lets scalar consumers reach the count.
  joinNeighbors: (c) => {
    const arr = compileArrayNode(c.ctx, c.node.id);
    if (!arr) return null;
    const cached = getCachedPort(c.ctx, c.node.id, 'count');
    if (cached) return cached;
    const ref: ValueRef = { expr: arr.lenName, type: 'i32' };
    setCachedPort(c.ctx, c.node.id, 'count', ref);
    return ref;
  },

  getRandom: ({ node, ctx, inputs }) => {
    const cfg = node.data.config as unknown as Record<string, unknown>;
    const t = (node.data.config.randomType as string) || 'float';
    const dist = randomDistribution(cfg, t);
    // Min / Max are PORTS. `inputs` carries an inline CONSTANT for an unwired
    // port, so wiredness is read off inputToSource — an unwired range keeps the
    // historical compile-time fold (`max - min` baked into the literal) and
    // therefore the byte-identical shader; a wired one goes runtime.
    // WGSL needs a decimal point (or an exponent) for a float literal.
    const wgslFloatLit = (n: number): string => (Number.isInteger(n) ? `${n}.0` : `${n}`);
    const wired = (portId: string): boolean => !!ctx.inputToSource.get(`${node.id}:${portId}`);
    const inlineNum = (portId: string, dflt: number): number => {
      const port = getNodeDef('getRandom')?.ports.find(p => p.id === portId);
      return parseInlineNum(port ? getInlineValue(port, node.data.config) : undefined, dflt);
    };
    const wiredRange = wired('min') || wired('max');
    const minN = inlineNum('min', 0);
    const maxN = inlineNum('max', 1);
    const inF = (portId: string, dflt: number): string => {
      const r = inputs[portId];
      return r && wired(portId) ? castTo(r, 'f32') : wgslFloatLit(inlineNum(portId, dflt));
    };
    const minX = inF('min', 0);
    const maxX = inF('max', 1);
    const rExpr = `rand_f32(idx)`;
    if (t === 'vector') {
      // ONE draw → an angular offset uniform in ±Span°/2, applied as a
      // screen-clockwise ROTATION of the reference unit vector (no atan2 needed
      // for the wired-direction path). Multi-output: cache x AND y.
      const p = fresh(ctx, 'rvec');
      ctx.lines.push(`  let ${p}p: f32 = ((${rExpr}) - 0.5) * (${inF('span', 360)}) * ${wgslFloatLit(RANDOM_DEG2RAD)};`);
      ctx.lines.push(`  let ${p}c: f32 = cos(${p}p);`);
      ctx.lines.push(`  let ${p}s: f32 = sin(${p}p);`);
      if (randomRefSource(cfg) === 'vector') {
        ctx.lines.push(`  let ${p}dx: f32 = ${inF('dirX', 0)};`);
        ctx.lines.push(`  let ${p}dy: f32 = ${inF('dirY', -1)};`);
        ctx.lines.push(`  let ${p}l: f32 = sqrt(${p}dx * ${p}dx + ${p}dy * ${p}dy);`);
        ctx.lines.push(`  let ${p}i: f32 = 1.0 / max(${p}l, ${wgslFloatLit(RANDOM_LEN_EPS)});`);
        ctx.lines.push(`  let ${p}fx: f32 = ${p}dx * ${p}i;`);
        ctx.lines.push(`  let ${p}fy: f32 = select(-1.0, ${p}dy * ${p}i, ${p}l > 0.0);`);
      } else {
        ctx.lines.push(`  let ${p}a: f32 = (${inF('angle', 0)}) * ${wgslFloatLit(RANDOM_DEG2RAD)};`);
        ctx.lines.push(`  let ${p}fx: f32 = sin(${p}a);`);
        ctx.lines.push(`  let ${p}fy: f32 = -cos(${p}a);`);
      }
      const norm = inF('norm', 1);
      ctx.lines.push(`  let ${p}x: f32 = (${norm}) * (${p}fx * ${p}c - ${p}fy * ${p}s);`);
      ctx.lines.push(`  let ${p}y: f32 = (${norm}) * (${p}fx * ${p}s + ${p}fy * ${p}c);`);
      const xRef: ValueRef = { expr: `${p}x`, type: 'f32' };
      setCachedPort(ctx, node.id, 'x', xRef);
      setCachedPort(ctx, node.id, 'y', { expr: `${p}y`, type: 'f32' });
      return xRef;
    }
    if (t === 'color') {
      // THREE draws in the order R, G, B (each `rand_f32` advances the per-cell
      // PCG once). `& 255` narrows the edge case where the f32 uniform rounds to
      // exactly 1.0 — the same guard the orientation path uses.
      const p = fresh(ctx, 'rcol');
      for (const ch of ['r', 'g', 'b']) {
        ctx.lines.push(`  let ${p}${ch}: i32 = i32(${rExpr} * 256.0) & 255;`);
      }
      const rRef: ValueRef = { expr: `${p}r`, type: 'i32' };
      setCachedPort(ctx, node.id, 'r', rRef);
      setCachedPort(ctx, node.id, 'g', { expr: `${p}g`, type: 'i32' });
      setCachedPort(ctx, node.id, 'b', { expr: `${p}b`, type: 'i32' });
      return rRef;
    }
    if (t === 'float' && dist === 'normal') {
      // Box-Muller — EXACTLY two draws (`rand_f32` advances the per-cell PCG
      // once per occurrence). `1 - u` keeps log's argument in (0, 1].
      const p = fresh(ctx, 'rnrm');
      ctx.lines.push(`  let ${p}u: f32 = ${rExpr};`);
      ctx.lines.push(`  let ${p}w: f32 = ${rExpr};`);
      ctx.lines.push(`  let ${p}z: f32 = sqrt(-2.0 * log(1.0 - ${p}u)) * cos(${wgslFloatLit(RANDOM_TAU)} * ${p}w);`);
      return emitLet(ctx, 'f32', `((${inF('mean', 0)}) + (${inF('stddev', 1)}) * ${p}z)`, 'rn');
    }
    if (t === 'float' && dist === 'exponential') {
      // Inverse-CDF, ONE draw: mean * -ln(1 - u). No divide ⇒ no ÷0 guard.
      const p = fresh(ctx, 'rexp');
      ctx.lines.push(`  let ${p}u: f32 = ${rExpr};`);
      return emitLet(ctx, 'f32', `((${inF('mean', 0)}) * -log(1.0 - ${p}u))`, 're');
    }
    if (t === 'bool') {
      const prob = inputs['probability'];
      const probExpr = prob ? castTo(prob, 'f32') : '0.5';
      return emitLet(ctx, 'bool', `(${rExpr} < ${probExpr})`, 'rb');
    }
    if (t === 'integer') {
      if (wiredRange) {
        // A wired bound ⇒ compute the span at runtime, in f32 (mirrors JS
        // `Math.floor(u * (max - min + 1)) + min`).
        return emitLet(ctx, 'f32', `(floor(${rExpr} * ((${maxX}) - (${minX}) + 1.0)) + (${minX}))`, 'ri');
      }
      const span = maxN - minN + 1;
      const lit = `${span}.0`;
      return emitLet(ctx, 'i32', `(i32(${rExpr} * ${lit}) + ${minN | 0})`, 'ri');
    }
    if (t === 'orientation') {
      // Uniform pick from 0..3 (N/E/S/W). No min/max — domain is fixed.
      // & 3 narrows for the edge case where the f32 RNG hits exactly 1.0.
      return emitLet(ctx, 'i32', `(i32(${rExpr} * 4.0) & 3)`, 'ro');
    }
    if (t === 'options') {
      // Options mode: pick uniformly from a wired array source, or from multiple
      // scalar sources (Aggregate-style multi-source isArray pattern). Empty-
      // array case falls back to the Fallback input port — surfaced in the UI
      // so the user can't be surprised by silent zeros.
      const fallback = inputs['fallback'] ?? ({ expr: '0.0', type: 'f32' } as ValueRef);
      const sources = ctx.inputToSources.get(`${node.id}:options`) ?? [];

      if (sources.length === 0) {
        // No source wired — always returns fallback. Bind rand_f32 to a let so
        // its side effect (per-cell PCG advance) is guaranteed even if the
        // result expression is constant-folded by a downstream WGSL compiler.
        // Matches JS / WASM which always emit the RNG advance prefix.
        const rName = fresh(ctx, 'roRng');
        ctx.lines.push(`  let ${rName}: f32 = ${rExpr};`);
        return emitLet(ctx, 'f32', castTo(fallback, 'f32'), 'rof');
      }

      if (sources.length === 1) {
        const src = sources[0]!;
        const srcNode = ctx.nodeMap.get(src.nodeId);
        if (srcNode && ctx.producesArray(srcNode)) {
          // Single array source: pick at random with fallback guard for empty.
          // For len == 0 the idx evaluates to 0; the static `array<T, maxLen>`
          // is zero-initialised, so the `arr[0]` read is well-defined garbage
          // that select() discards in favour of fbCast.
          const arr = compileArrayNode(ctx, src.nodeId, src.portId);
          if (!arr) return null;
          const fbCast = castTo(fallback, arr.elemType);
          const idxName = fresh(ctx, 'roI');
          ctx.lines.push(`  let ${idxName}: i32 = i32(${rExpr} * f32(${arr.lenName}));`);
          return emitLet(ctx, arr.elemType,
            `select(${fbCast}, ${arrLoad(arr, idxName)}, ${arr.lenName} > 0)`, 'rov');
        }
        // Single scalar source: trivially returns that value. Bind rand_f32 to
        // a let for RNG parity (same reasoning as the no-source path above).
        const srcRef = compileValueNode(ctx, src.nodeId, src.portId);
        if (!srcRef) {
          ctx.errors.push(`getRandom options: scalar source ${src.nodeId} did not produce a value`);
          return null;
        }
        const rName = fresh(ctx, 'roRng');
        ctx.lines.push(`  let ${rName}: f32 = ${rExpr};`);
        return emitLet(ctx, srcRef.type, srcRef.expr, 'ros');
      }

      // Multi-scalar (≥ 2 sources): materialise into a fixed-length WGSL var
      // array, then index by `i32(rand * N)`. N is statically known. Element
      // type is f32 (safe default — downstream consumers `castTo` as needed).
      const sourceRefs: ValueRef[] = [];
      for (const s of sources) {
        const r = compileValueNode(ctx, s.nodeId, s.portId);
        if (!r) {
          ctx.errors.push(`getRandom options: scalar source ${s.nodeId} did not produce a value`);
          return null;
        }
        sourceRefs.push(r);
      }
      const N = sourceRefs.length;
      const arrName = fresh(ctx, 'roOpts');
      ctx.lines.push(`  var ${arrName}: array<f32, ${N}>;`);
      for (let i = 0; i < N; i++) {
        ctx.lines.push(`  ${arrName}[${i}] = ${castTo(sourceRefs[i]!, 'f32')};`);
      }
      const idxName = fresh(ctx, 'roI');
      ctx.lines.push(`  let ${idxName}: i32 = i32(${rExpr} * ${N}.0);`);
      return emitLet(ctx, 'f32', `${arrName}[${idxName}]`, 'rom');
    }
    if (wiredRange) {
      return emitLet(ctx, 'f32', `((${rExpr} * ((${maxX}) - (${minX}))) + (${minX}))`, 'rf');
    }
    const span = maxN - minN;
    const sl = Number.isInteger(span) ? `${span}.0` : `${span}`;
    const ml = Number.isInteger(minN) ? `${minN}.0` : `${minN}`;
    return emitLet(ctx, 'f32', `((${rExpr} * ${sl}) + ${ml})`, 'rf');
  },

  // Local Variable read (scalar path). Array variables go through the
  // array-emitter dispatch (ARRAY_NODE_EMITTERS['getVariable']) — both
  // registrations let the dispatcher pick based on the consumer's expected
  // input shape.
  getVariable: ({ node, ctx }) => {
    const variableId = node.data.config.variableId as string;
    const v = (ctx.model.variables || []).find(x => x.id === variableId);
    if (!v) {
      ctx.errors.push(`getVariable: unknown variable "${variableId}"`);
      return null;
    }
    if (v.kind !== 'scalar') {
      ctx.errors.push(`getVariable: variable "${variableId}" is an array; wire to an isArray input or use ArrayElement to index it`);
      return null;
    }
    return { expr: variableWgslName(v.id), type: variableWgslType(v.dataType) };
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
      const arrRef = compileArrayNode(ctx, indexSrc!.nodeId, indexSrc!.portId);
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

  valueSwitch: ({ node, ctx, inputs }) => {
    // Array-relay instances are routed to ARRAY_NODE_EMITTERS by ctx.producesArray;
    // this scalar path should never see one. Guard documents the invariant.
    if (ctx.producesArray(node)) {
      ctx.errors.push(`valueSwitch: array-relay instance reached the scalar value emitter (internal dispatch error)`);
      return null;
    }
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
    // `a` emitted LAST and only when declared — an extra `let` (and the `fresh`
    // name it consumes) would change the shader of every existing model.
    if (colorConstantHasAlpha(node.data.config)) {
      const a = parseInt(String(node.data.config.a ?? '255'), 10) || 0;
      setCachedPort(ctx, node.id, 'a', emitLet(ctx, 'i32', `${a | 0}`, 'ca'));
    }
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
    const withA = colorScaleHasAlpha(node.data.config);

    const tName = fresh(ctx, 'cst');
    ctx.lines.push(`  let ${tName}: f32 = ${t};`);
    // Channel table — `a` minted LAST and only when declared, so the opaque path
    // consumes the same `fresh` names and emits the same lines as before.
    const chans: Array<{ name: string; get: (s: ColorScaleStop) => number }> = [
      { name: fresh(ctx, 'csr'), get: s => s.r },
      { name: fresh(ctx, 'csg'), get: s => s.g },
      { name: fresh(ctx, 'csb'), get: s => s.b },
    ];
    if (withA) chans.push({ name: fresh(ctx, 'csa'), get: s => s.a ?? 255 });
    for (const c of chans) ctx.lines.push(`  var ${c.name}: i32;`);

    const writeConst = (s: ColorScaleStop) =>
      chans.map(c => `${c.name} = ${c.get(s) | 0};`).join(' ');

    const ZERO: ColorScaleStop = { p: 0, r: 0, g: 0, b: 0, a: 0 };
    if (stops.length === 0) {
      ctx.lines.push(`  ${writeConst(ZERO)}`);
    } else if (stops.length === 1) {
      ctx.lines.push(`  ${writeConst(stops[0]!)}`);
    } else {
      const first = stops[0]!;
      const last = stops[stops.length - 1]!;
      ctx.lines.push(`  if (${tName} <= ${f32Lit(first.p)}) { ${writeConst(first)} }`);
      for (let i = 0; i < stops.length - 1; i++) {
        const a = stops[i]!;
        const b = stops[i + 1]!;
        if (b.p === a.p) continue;
        const localExpr = `((${tName} - ${f32Lit(a.p)}) / ${f32Lit(b.p - a.p)})`;
        const curved = wgslInterpolationCurveExpr(localExpr, method);
        // Alpha interpolates on the SAME curve as the colour channels — matching JS/WASM.
        const body = chans
          .map(c => `${c.name} = i32(floor(${f32Lit(c.get(a))} + (${curved}) * ${f32Lit(c.get(b) - c.get(a))} + 0.5)); `)
          .join('');
        ctx.lines.push(`  else if (${tName} < ${f32Lit(b.p)}) { ${body}}`);
      }
      ctx.lines.push(`  else { ${writeConst(last)} }`);
    }

    const refs: ValueRef[] = chans.map(c => ({ expr: c.name, type: 'i32' }));
    (withA ? ['r', 'g', 'b', 'a'] : ['r', 'g', 'b']).forEach((p, i) => {
      setCachedPort(ctx, node.id, p, refs[i]!);
    });
    return refs[0]!;
  },

  // -- categoricalColor: integer index → flat RGB from an N-entry palette
  //    (no blending). `if (k==i) {entry i} else ... else default`. --
  categoricalColor: ({ ctx, node, inputs }) => {
    const idx = castTo(inputs['index'] ?? { expr: '0', type: 'i32' }, 'i32');
    const entries = readCategoricalEntries(node.data.config);
    const d = readCategoricalDefault(node.data.config);

    const withA = categoricalHasAlpha(node.data.config);

    // `a` minted LAST and only when declared — see the colorScale twin.
    const chans: Array<{ name: string; get: (e: CategoricalEntry) => number }> = [
      { name: fresh(ctx, 'ccr'), get: e => e.r },
      { name: fresh(ctx, 'ccg'), get: e => e.g },
      { name: fresh(ctx, 'ccb'), get: e => e.b },
    ];
    if (withA) chans.push({ name: fresh(ctx, 'cca'), get: e => e.a ?? 255 });
    for (const c of chans) ctx.lines.push(`  var ${c.name}: i32;`);

    const writeConst = (e: CategoricalEntry) =>
      chans.map(c => `${c.name} = ${c.get(e) | 0};`).join(' ');

    if (entries.length === 0) {
      ctx.lines.push(`  ${writeConst(d)}`);
    } else {
      const kName = fresh(ctx, 'cck');
      ctx.lines.push(`  let ${kName}: i32 = ${idx};`);
      entries.forEach((e, i) => {
        const head = i === 0 ? `if (${kName} == ${i})` : `else if (${kName} == ${i})`;
        ctx.lines.push(`  ${head} { ${writeConst(e)} }`);
      });
      ctx.lines.push(`  else { ${writeConst(d)} }`);
    }

    const refs: ValueRef[] = chans.map(c => ({ expr: c.name, type: 'i32' }));
    (withA ? ['r', 'g', 'b', 'a'] : ['r', 'g', 'b']).forEach((p, i) => {
      setCachedPort(ctx, node.id, p, refs[i]!);
    });
    return refs[0]!;
  },

  // -- Variegated Cells: Get Orientation ----------------------------------
  // Reads the current cell's orientation from the read buffer. Co-located
  // inside the attrs buffer at orientationWordOffset (see layout.ts).
  getOrientation: ({ ctx }) => {
    if (!ctx.layout.variegatedEnabled) {
      ctx.errors.push('getOrientation: variegated cells disabled');
      return null;
    }
    const w = ctx.layout.orientationWordOffset;
    return emitLet(ctx, 'i32', `bitcast<i32>(attrsRead[${w}u + idx])`, 'gOri');
  },

  // -- Variegated Cells: Get Facing Orientation --------------------------
  // Reads the orientation of the neighbour touching this cell in a fixed
  // direction. directionTag pre-resolved into (_resolvedDirIdx, _resolvedDr,
  // _resolvedDc, _boundaryTreatment). Mirrors `getFacingLabels` neighbour
  // computation; returns 0 when direction is unset.
  getFacingOrientation: ({ node, ctx }) => {
    if (!ctx.layout.variegatedEnabled) {
      ctx.errors.push('getFacingOrientation: variegated cells disabled');
      return null;
    }
    const dirIdx = Number(node.data.config._resolvedDirIdx);
    const dr = Number(node.data.config._resolvedDr);
    const dc = Number(node.data.config._resolvedDc);
    const boundary = (node.data.config._boundaryTreatment as string) || 'torus';
    if (!Number.isFinite(dirIdx) || dirIdx < 0) {
      return emitLet(ctx, 'i32', '0', 'gfOri');
    }
    const total = ctx.layout.total;
    const W = ctx.model.properties.gridWidth;
    const H = ctx.model.properties.gridHeight;
    const rowExpr = `i32(idx / ${W}u)`;
    const colExpr = `i32(idx % ${W}u)`;
    let nbrCellExpr: string;
    if (boundary === 'constant') {
      const nRow = emitLet(ctx, 'i32', `(${rowExpr} + ${dr})`, 'gfo_nr');
      const nCol = emitLet(ctx, 'i32', `(${colExpr} + ${dc})`, 'gfo_nc');
      const nciName = fresh(ctx, 'gfo_nci');
      ctx.lines.push(`  var ${nciName}: i32 = ${total};`);
      ctx.lines.push(
        `  if (${nRow.expr} >= 0 && ${nRow.expr} < ${H} && ${nCol.expr} >= 0 && ${nCol.expr} < ${W}) {`,
        `    ${nciName} = ${nRow.expr} * ${W} + ${nCol.expr};`,
        `  }`,
      );
      nbrCellExpr = nciName;
    } else {
      const nRow = `((${rowExpr} + ${dr}) % ${H} + ${H}) % ${H}`;
      const nCol = `((${colExpr} + ${dc}) % ${W} + ${W}) % ${W}`;
      nbrCellExpr = `((${nRow}) * ${W} + (${nCol}))`;
    }
    const nbrCell = emitLet(ctx, 'i32', nbrCellExpr, 'gfo_nc2');
    const w = ctx.layout.orientationWordOffset;
    return emitLet(ctx, 'i32', `bitcast<i32>(attrsRead[${w}u + u32(${nbrCell.expr})])`, 'gfo');
  },

  // -- Variegated Cells: Get Neighbor Orientation By Index ---------------
  // Reads one neighbour's orientation given a packed NeighborIndex. Mirrors
  // `getNeighborAttributeByIndex` — handles scalar NI or array (take [0]) and
  // guards INVALID_NI (returns 0).
  getNeighborOrientationByIndex: ({ node, ctx, inputs }) => {
    if (!ctx.layout.variegatedEnabled) {
      ctx.errors.push('getNeighborOrientationByIndex: variegated cells disabled');
      return null;
    }
    const indexSrc = ctx.inputToSource.get(`${node.id}:index`);
    const srcNode = indexSrc ? ctx.nodeMap.get(indexSrc.nodeId) : undefined;
    const indexSrcDef = srcNode ? getNodeDef(srcNode.data.nodeType) : null;
    const indexSrcPort = indexSrc ? indexSrcDef?.ports.find(p => p.id === indexSrc.portId) : undefined;
    let niLocal: ValueRef;
    if (indexSrcPort?.isArray) {
      const arrRef = compileArrayNode(ctx, indexSrc!.nodeId, indexSrc!.portId);
      if (!arrRef) return null;
      const elemExpr = arrRef.elemType === 'i32'
        ? `${arrRef.name}[0]`
        : `i32(${arrRef.name}[0])`;
      niLocal = emitLet(ctx, 'i32', `select(${INVALID_NI}, ${elemExpr}, ${arrRef.lenName} > 0)`, 'ni');
    } else {
      const indexRef = inputs['index'] ?? { expr: '0', type: 'i32' as WgslType };
      niLocal = emitLet(ctx, 'i32', castTo(indexRef, 'i32'), 'ni');
    }
    const cellIdx = emitLet(ctx, 'i32', emitNiCellIdx(niLocal.expr), 'nci');
    const w = ctx.layout.orientationWordOffset;
    const rawOri = `bitcast<i32>(attrsRead[${w}u + u32(${cellIdx.expr})])`;
    return emitLet(ctx, 'i32', `select(0, ${rawOri}, ${niLocal.expr} != ${INVALID_NI})`, 'nbOri');
  },

  // -- Variegated Cells: Get Facing Labels (multi-output) -----------------
  // Resolves the two face labels touching at a neighbor encounter, accounting
  // for both cells' orientations and face patterns. Same rotation math as the
  // JS / WASM emit. The pre-resolve in compile.ts (JS) bakes `_directionMap`
  // + `_sourceAttrId` into the node config; we read them at compile time and
  // emit a per-slot if-chain for directionMap lookup (small N keeps it cheap).
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

    // Unresolved direction → both labels are `none` (0). No memory access.
    if (!Number.isFinite(dirIdx) || dirIdx < 0) {
      const myZ = emitLet(ctx, 'i32', '0', 'fl_ml');
      const theirZ = emitLet(ctx, 'i32', '0', 'fl_tl');
      setCachedPort(ctx, node.id, 'myFaceLabel', myZ);
      setCachedPort(ctx, node.id, 'theirFaceLabel', theirZ);
      return myZ;
    }

    const w = ctx.layout.orientationWordOffset;
    const lookupW = ctx.layout.facePatternLookupWordOffset;
    const total = ctx.layout.total;
    const W = ctx.model.properties.gridWidth;
    const H = ctx.model.properties.gridHeight;
    const dirP4 = (dirIdx + 4) & 7;

    // Compute the neighbour cell index from (dr, dc) honouring the model's
    // boundary treatment.
    //   torus:    nci = ((row + dr + H) % H) * W + ((col + dc + W) % W)
    //   constant: nci = (in-bounds) ? (row+dr)*W + (col+dc) : total
    // WGSL has no native negative-safe wrap; use ((x % m + m) % m) form.
    const rowExpr = `i32(idx / ${W}u)`;
    const colExpr = `i32(idx % ${W}u)`;
    let nbrCellExpr: string;
    if (boundary === 'constant') {
      // Branchy: emit a var with the sentinel default, overwrite when in-bounds.
      const nRow = emitLet(ctx, 'i32', `(${rowExpr} + ${dr})`, 'fl_nr');
      const nCol = emitLet(ctx, 'i32', `(${colExpr} + ${dc})`, 'fl_nc');
      const nciName = fresh(ctx, 'fl_nci');
      ctx.lines.push(`  var ${nciName}: i32 = ${total};`);
      ctx.lines.push(
        `  if (${nRow.expr} >= 0 && ${nRow.expr} < ${H} && ${nCol.expr} >= 0 && ${nCol.expr} < ${W}) {`,
        `    ${nciName} = ${nRow.expr} * ${W} + ${nCol.expr};`,
        `  }`,
      );
      nbrCellExpr = nciName;
    } else {
      // torus
      const nRow = `((${rowExpr} + ${dr}) % ${H} + ${H}) % ${H}`;
      const nCol = `((${colExpr} + ${dc}) % ${W} + ${W}) % ${W}`;
      nbrCellExpr = `((${nRow}) * ${W} + (${nCol}))`;
    }
    const nbrCell = emitLet(ctx, 'i32', nbrCellExpr, 'fl_nc2');

    // myOri = orientation[idx]; theirOri = orientation[nbrCell]
    const myOri = emitLet(ctx, 'i32', `bitcast<i32>(attrsRead[${w}u + idx])`, 'fl_mo');
    const theirOri = emitLet(ctx, 'i32', `bitcast<i32>(attrsRead[${w}u + u32(${nbrCell.expr})])`, 'fl_to');

    // myFaceIdx = (dirIdx + 2 * myOri) & 7
    const myFaceIdx = emitLet(ctx, 'i32', `((${dirIdx} + 2 * ${myOri.expr}) & 7)`, 'fl_mf');
    // theirFaceIdx = ((dirIdx + 4) & 7 + 2 * theirOri) & 7
    const theirFaceIdx = emitLet(ctx, 'i32', `((${dirP4} + 2 * ${theirOri.expr}) & 7)`, 'fl_tf');

    // mySpec / theirSpec = source attribute at idx / nbrCell, or 0 if no source.
    const mySpec = sourceAttr
      ? emitLet(ctx, 'i32', `bitcast<i32>(attrsRead[${sourceAttr.wordOffset}u + idx])`, 'fl_ms')
      : emitLet(ctx, 'i32', '0', 'fl_ms');
    const theirSpec = sourceAttr
      ? emitLet(ctx, 'i32', `bitcast<i32>(attrsRead[${sourceAttr.wordOffset}u + u32(${nbrCell.expr})])`, 'fl_ts')
      : emitLet(ctx, 'i32', '0', 'fl_ts');

    // myLabel: (mySpec >= 0) ? varAux[lookupW + mySpec*8 + myFaceIdx] : 0
    const myLabelExpr =
      `select(0, bitcast<i32>(varAux[u32(${lookupW} + ${mySpec.expr} * 8 + ${myFaceIdx.expr})]), `
      + `(${mySpec.expr} >= 0))`;
    const myLabel = emitLet(ctx, 'i32', myLabelExpr, 'fl_ml');

    // theirLabel: (nbrCell < total) ? varAux[lookupW + theirSpec*8 + theirFaceIdx] : 0
    const theirLabelExpr =
      `select(0, bitcast<i32>(varAux[u32(${lookupW} + ${theirSpec.expr} * 8 + ${theirFaceIdx.expr})]), `
      + `(${nbrCell.expr} < ${total}))`;
    const theirLabel = emitLet(ctx, 'i32', theirLabelExpr, 'fl_tl');

    setCachedPort(ctx, node.id, 'myFaceLabel', myLabel);
    setCachedPort(ctx, node.id, 'theirFaceLabel', theirLabel);
    return myLabel;
  },

  // -- Variegated Cells: Lookup Interaction -------------------------------
  // Indexes an interactionTable model attribute by two face labels. Returns
  // the f32 stored at `(labelA * labelCount + labelB)` within the table's
  // region of varAux. Unknown tableId returns 0.
  lookupInteraction: ({ node, ctx, inputs }) => {
    // No variegation guard — tag×tag tables need no faces. Tableless → 0.
    const tableId = (node.data.config.tableId as string) || '';
    const tableLayout = tableId ? ctx.layout.interactionTableOffsets[tableId] : undefined;
    if (!tableLayout) {
      return emitLet(ctx, 'f32', '0.0', 'li');
    }
    const off = tableLayout.wordOffset;
    if (tableLayout.dims && tableLayout.dims.length > 0) {
      // MULTI-AXIS (N-D): flat = Σ clamp((axisₖ) − minₖ, 0, dimₖ−1)·strideₖ
      // (per-axis saturating clamp — D-NDT-5; mirrors the JS + WASM emits).
      const dims = tableLayout.dims;
      const mins = tableLayout.mins ?? [];
      const strides = new Array<number>(dims.length).fill(1);
      for (let i = dims.length - 2; i >= 0; i--) strides[i] = strides[i + 1]! * dims[i + 1]!;
      const terms: string[] = [];
      for (let k = 0; k < dims.length; k++) {
        const src = inputs[`axis_${k}`] ?? { expr: '0', type: 'i32' as WgslType };
        const min = Math.floor(mins[k] ?? 0) || 0;
        const hi = Math.max(0, dims[k]! - 1);
        const raw = min !== 0 ? `(${castTo(src, 'i32')}) - ${min}` : `(${castTo(src, 'i32')})`;
        const idx = `clamp(${raw}, 0, ${hi})`;
        terms.push(strides[k] === 1 ? idx : `${idx} * ${strides[k]}`);
      }
      return emitLet(ctx, 'f32',
        `bitcast<f32>(varAux[u32(${off} + ${terms.join(' + ')})])`, 'li');
    }
    // LEGACY 2-axis — byte-identical to the pre-N-D emit.
    const colCount = tableLayout.colCount; // row-major stride
    const labelA = inputs['labelA'] ?? { expr: '0', type: 'i32' as WgslType };
    const labelB = inputs['labelB'] ?? { expr: '0', type: 'i32' as WgslType };
    const a = castTo(labelA, 'i32');
    const b = castTo(labelB, 'i32');
    // No bounds clamp — out-of-range indices would read adjacent table memory.
    // Practical models stay within [0, rowCount)×[0, colCount). The CPU side
    // clamps via the worker's normalizeLookupTable; the GPU trusts the inputs
    // (mirrors JS / WASM, which also don't clamp).
    return emitLet(ctx, 'f32',
      `bitcast<f32>(varAux[u32(${off} + (${a}) * ${colCount} + (${b}))])`, 'li');
  },

  // -- Init Event (multi-output: x, y, maxX, maxY) ------------------------
  // Per-cell coordinate outputs for the Init Event entry point. Init shares
  // the same shader module + bindings as `step`; the entry-point orchestrator
  // emits one pipeline per entry point, distinguished by name.
  initEvent: ({ node, ctx }) => {
    const W = ctx.layout.gridWidth;
    const H = ctx.layout.gridHeight;
    const D = ctx.layout.gridDepth;
    // 3D Grid CA: when 3D, y is the row WITHIN the layer ((idx % WH)/W) and z is
    // the layer (idx / WH). 2D (D===1) emits the verbatim x = idx%W, y = idx/W.
    if (D > 1) {
      const WH = W * H;
      const x = emitLet(ctx, 'i32', `i32(idx % ${W}u)`, 'init_x');
      const y = emitLet(ctx, 'i32', `i32((idx % ${WH}u) / ${W}u)`, 'init_y');
      const z = emitLet(ctx, 'i32', `i32(idx / ${WH}u)`, 'init_z');
      const maxX = emitLet(ctx, 'i32', `${W - 1}`, 'init_mx');
      const maxY = emitLet(ctx, 'i32', `${H - 1}`, 'init_my');
      const maxZ = emitLet(ctx, 'i32', `${D - 1}`, 'init_mz');
      setCachedPort(ctx, node.id, 'x', x);
      setCachedPort(ctx, node.id, 'y', y);
      setCachedPort(ctx, node.id, 'z', z);
      setCachedPort(ctx, node.id, 'maxX', maxX);
      setCachedPort(ctx, node.id, 'maxY', maxY);
      setCachedPort(ctx, node.id, 'maxZ', maxZ);
      return x;
    }
    // x = idx % W; y = idx / W (as i32); maxX = W-1; maxY = H-1.
    const x = emitLet(ctx, 'i32', `i32(idx % ${W}u)`, 'init_x');
    const y = emitLet(ctx, 'i32', `i32(idx / ${W}u)`, 'init_y');
    const maxX = emitLet(ctx, 'i32', `${W - 1}`, 'init_mx');
    const maxY = emitLet(ctx, 'i32', `${H - 1}`, 'init_my');
    setCachedPort(ctx, node.id, 'x', x);
    setCachedPort(ctx, node.id, 'y', y);
    setCachedPort(ctx, node.id, 'maxX', maxX);
    setCachedPort(ctx, node.id, 'maxY', maxY);
    return x;
  },

  // -- Get Cell Position (multi-output: row, col, layer) -------------------
  // The current cell's grid coordinates, computed from the invocation `idx`
  // (always in scope). 3D: row is WITHIN the layer ((idx%WH)/W), layer = idx/WH.
  getCellPosition: ({ node, ctx }) => {
    const W = ctx.layout.gridWidth, H = ctx.layout.gridHeight, D = ctx.layout.gridDepth;
    const col = emitLet(ctx, 'i32', `i32(idx % ${W}u)`, 'cpCol');
    const row = D > 1
      ? emitLet(ctx, 'i32', `i32((idx % ${W * H}u) / ${W}u)`, 'cpRow')
      : emitLet(ctx, 'i32', `i32(idx / ${W}u)`, 'cpRow');
    setCachedPort(ctx, node.id, 'row', row);
    setCachedPort(ctx, node.id, 'col', col);
    if (D > 1) setCachedPort(ctx, node.id, 'layer', emitLet(ctx, 'i32', `i32(idx / ${W * H}u)`, 'cpLayer'));
    return row;  // default 'value' port → row
  },

  // -- Get Grid Dimensions (multi-output: width, height, depth) ------------
  // The world size, baked from the layout (which is derived from the SAME
  // dimensions the runtime allocates — the simulator's Resize `dimsModel`, so a
  // resized grid recompiles with the right literals). `gridDepth` is 1 in 2D.
  getGridDimensions: ({ node, ctx }) => {
    const w = emitLet(ctx, 'i32', `${ctx.layout.gridWidth}`, 'gdW');
    setCachedPort(ctx, node.id, 'width', w);
    setCachedPort(ctx, node.id, 'height', emitLet(ctx, 'i32', `${ctx.layout.gridHeight}`, 'gdH'));
    setCachedPort(ctx, node.id, 'depth', emitLet(ctx, 'i32', `${ctx.layout.gridDepth}`, 'gdD'));
    // Grid centre (⌊size/2⌋ per axis) — baked like the dims; emitted regardless
    // of the `withCenter` UI checkbox so a wire into a centre port never dangles.
    setCachedPort(ctx, node.id, 'centerX', emitLet(ctx, 'i32', `${Math.floor(ctx.layout.gridWidth / 2)}`, 'gdCX'));
    setCachedPort(ctx, node.id, 'centerY', emitLet(ctx, 'i32', `${Math.floor(ctx.layout.gridHeight / 2)}`, 'gdCY'));
    setCachedPort(ctx, node.id, 'centerZ', emitLet(ctx, 'i32', `${Math.floor(ctx.layout.gridDepth / 2)}`, 'gdCZ'));
    return w;  // default 'value' port → width
  },

  // -- Get Generation ------------------------------------------------------
  // Read from the `control` storage buffer (the worker refreshes byte 8 whenever
  // the counter moves). The cell grid dispatches one submit per generation, so a
  // per-generation host write is enough here — unlike the AGENT resident batch,
  // which encodes N generations into one submit and therefore needs a GPU-side
  // counter (see agentWebgpuRuntime.ts posCommit).
  getGeneration: ({ ctx }) => emitLet(ctx, 'i32', 'i32(control.generation)', 'gen'),
};

// ---------------------------------------------------------------------------
// Aggregate / GroupCounting / GroupOperator — neighbour-loop or scalar-fold
// ---------------------------------------------------------------------------

/** Materialise the `values` input(s) of an aggregate/groupOperator into a
 *  per-thread f32 `var<function>` array — shared by the three ops that need a
 *  random-access / sortable copy (median, uniform random, weightedRandom).
 *  Covers the three source shapes:
 *    1. a single array-producing source (filterNeighbors, getNeighborsAttrByIndexes…)
 *    2. the neighbour-path (one getNeighborsAttribute) — with sub-attribute
 *       parent-match FILTERING (non-matching neighbours are excluded, matching
 *       the JS/WASM iteration semantics so the median/pick operate over the
 *       filtered prefix only)
 *    3. multi-source scalars (each compiled independently)
 *  Returns null (after pushing an error) on a resolution failure. */
function materialiseFoldInput(
  ctx: CompileCtx,
  op: string,
  sources: Array<{ nodeId: string; portId: string }>,
  isNbrPath: boolean,
  firstSrcNode: GraphNode | undefined,
): ArrayRef | null {
  const firstSrc = sources[0]!;
  if (sources.length === 1 && !isNbrPath && firstSrcNode && ctx.producesArray(firstSrcNode)) {
    const ar = compileArrayNode(ctx, firstSrc.nodeId, firstSrc.portId);
    if (!ar) { ctx.errors.push(`${op}: array source ${firstSrc.nodeId} did not materialise`); return null; }
    return ar;
  }
  if (isNbrPath) {
    const srcNode = firstSrcNode!;
    const nbrId = srcNode.data.config.neighborhoodId as string;
    const attrId = srcNode.data.config.attributeId as string;
    const nbr = getNbr(ctx.layout, nbrId);
    const attr = getAttr(ctx.layout, attrId);
    if (!nbr || !attr) { ctx.errors.push(`${op}: unknown nbr/attr (${nbrId}/${attrId})`); return null; }
    const tmp = allocArray(ctx, 'f32', 'fldNbr', nbr.size);
    const k = fresh(ctx, 'fldNk');
    ctx.lines.push(`  for (var ${k}: i32 = 0; ${k} < ${nbr.size}; ${k} = ${k} + 1) {`);
    ctx.lines.push(`    let _nci_${k}: i32 = ${emitNbrCellIdx(nbr, k)};`);
    // Sub-attribute: skip non-matching neighbours so the prefix holds only the
    // values that "exist" on this sub-attr (matchCount = the running length).
    const subMatch = subAttrIterMatchExpr(ctx, attrId, `u32(_nci_${k})`, false);
    if (subMatch) ctx.lines.push(`    if (!${subMatch}) { continue; }`);
    const elem = readAttr(attr, `u32(_nci_${k})`, false);
    ctx.lines.push(`    ${tmp.name}[${tmp.lenName}] = f32(${elem.expr});`);
    ctx.lines.push(`    ${tmp.lenName} = ${tmp.lenName} + 1;`);
    ctx.lines.push(`  }`);
    return tmp;
  }
  // Scalar-fold: materialise each scalar source independently.
  const N = sources.length;
  const tmp = allocArray(ctx, 'f32', 'fldSc', N);
  for (let kk = 0; kk < N; kk++) {
    const src = sources[kk]!;
    const sref = compileValueNode(ctx, src.nodeId, src.portId);
    if (!sref) { ctx.errors.push(`${op}: scalar source ${src.nodeId} did not produce a value`); return null; }
    ctx.lines.push(`  ${tmp.name}[${kk}] = ${castTo(sref, 'f32')};`);
  }
  ctx.lines.push(`  ${tmp.lenName} = ${N};`);
  return tmp;
}

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

  // median (aggregate) + uniform random (groupOperator) + weightedRandom
  // (groupOperator) all need the input values MATERIALISED into a per-thread
  // f32 scratch array first (median sorts it, random/weightedRandom index into
  // it). Share one materialiser so the three ops stay in lockstep — it covers
  // the single-array source, the multi-source scalar fold, and the neighbour-
  // path (with sub-attribute parent-match filtering, matching JS/WASM).
  if (mode !== 'count' && (op === 'median' || op === 'random' || op === 'weightedRandom')) {
    const inArr = materialiseFoldInput(ctx, op, sources, isNbrPath, firstSrcNode);
    if (!inArr) return null;

    if (op === 'median') {
      // Insertion-sort the materialised prefix, then median-pick.
      // Empty → 0; even length → mean of the two middle; odd → middle element.
      // Matches AggregateNode.compile's ascending-sort median semantics exactly.
      const i = fresh(ctx, 'mdI');
      const j = fresh(ctx, 'mdJ');
      const key = fresh(ctx, 'mdKey');
      ctx.lines.push(`  for (var ${i}: i32 = 1; ${i} < ${inArr.lenName}; ${i} = ${i} + 1) {`);
      ctx.lines.push(`    let ${key}: f32 = ${arrLoad(inArr, i)};`);
      ctx.lines.push(`    var ${j}: i32 = ${i} - 1;`);
      ctx.lines.push(`    while (${j} >= 0 && ${arrLoad(inArr, j)} > ${key}) {`);
      ctx.lines.push(`      ${inArr.name}[${j} + 1] = ${arrLoad(inArr, j)};`);
      ctx.lines.push(`      ${j} = ${j} - 1;`);
      ctx.lines.push(`    }`);
      ctx.lines.push(`    ${inArr.name}[${j} + 1] = ${key};`);
      ctx.lines.push(`  }`);
      const medName = fresh(ctx, 'mdRes');
      ctx.lines.push(`  var ${medName}: f32 = 0.0;`);
      ctx.lines.push(`  if (${inArr.lenName} > 0) {`);
      ctx.lines.push(`    if (${inArr.lenName} % 2 == 0) {`);
      ctx.lines.push(`      ${medName} = (${arrLoad(inArr, `${inArr.lenName} / 2 - 1`)} + ${arrLoad(inArr, `${inArr.lenName} / 2`)}) * 0.5;`);
      ctx.lines.push(`    } else {`);
      ctx.lines.push(`      ${medName} = ${arrLoad(inArr, `(${inArr.lenName} - 1) / 2`)};`);
      ctx.lines.push(`    }`);
      ctx.lines.push(`  }`);
      const medRef: ValueRef = { expr: medName, type: 'f32' };
      // aggregate.median is a scalar (no index port); groupOperator.median (a
      // hand-edited config, not UI-reachable) still gets result + a -1 index.
      if (mode === 'groupOperator') {
        setCachedPort(ctx, node.id, 'result', medRef);
        setCachedPort(ctx, node.id, 'index', emitLet(ctx, 'i32', '-1', 'mdGi'));
      }
      return medRef;
    }

    if (op === 'random') {
      // Uniform pick: advance the per-cell PCG once (always — matching the
      // JS/WASM always-advance semantics), then index = floor(u*len). Empty
      // input → index = -1, result = 0. (Cross-target the index DIFFERS — the
      // GPU PCG is keyed per-cell, not the shared xorshift32 stream — same
      // documented statistical-parity stance as getRandom.)
      const rName = fresh(ctx, 'rrR');
      ctx.lines.push(`  let ${rName}: f32 = rand_f32(idx);`);
      const idxName = fresh(ctx, 'rrIdx');
      const resName = fresh(ctx, 'rrRes');
      ctx.lines.push(`  var ${idxName}: i32 = -1;`);
      ctx.lines.push(`  var ${resName}: f32 = 0.0;`);
      ctx.lines.push(`  if (${inArr.lenName} > 0) {`);
      ctx.lines.push(`    ${idxName} = i32(${rName} * f32(${inArr.lenName}));`);
      ctx.lines.push(`    if (${idxName} >= ${inArr.lenName}) { ${idxName} = ${inArr.lenName} - 1; }`);
      ctx.lines.push(`    ${resName} = ${arrLoad(inArr, idxName)};`);
      ctx.lines.push(`  }`);
      const resRef: ValueRef = { expr: resName, type: 'f32' };
      setCachedPort(ctx, node.id, 'index', { expr: idxName, type: 'i32' });
      setCachedPort(ctx, node.id, 'result', resRef);
      return resRef;
    }

    // weightedRandom: cumulative-sum sampling over the materialised weights.
    // Always-advance RNG (one draw per call, matches JS/WASM semantics).
    const rName = fresh(ctx, 'wrR');
    ctx.lines.push(`  let ${rName}: f32 = rand_f32(idx);`);
    // sum = sum(inArr)
    const sumName = fresh(ctx, 'wrSum');
    ctx.lines.push(`  var ${sumName}: f32 = 0.0;`);
    const sumI = fresh(ctx, 'wrSi');
    ctx.lines.push(`  for (var ${sumI}: i32 = 0; ${sumI} < ${inArr.lenName}; ${sumI} = ${sumI} + 1) {`);
    ctx.lines.push(`    ${sumName} = ${sumName} + f32(${arrLoad(inArr, sumI)});`);
    ctx.lines.push(`  }`);
    const idxName = fresh(ctx, 'wrIdx');
    const wtName = fresh(ctx, 'wrWt');
    ctx.lines.push(`  var ${idxName}: i32 = -1;`);
    ctx.lines.push(`  var ${wtName}: f32 = 0.0;`);
    ctx.lines.push(`  if (${sumName} > 0.0) {`);
    const uName = fresh(ctx, 'wrU');
    ctx.lines.push(`    let ${uName}: f32 = ${rName} * ${sumName};`);
    const accName = fresh(ctx, 'wrAcc');
    ctx.lines.push(`    var ${accName}: f32 = 0.0;`);
    const i = fresh(ctx, 'wrI');
    ctx.lines.push(`    for (var ${i}: i32 = 0; ${i} < ${inArr.lenName}; ${i} = ${i} + 1) {`);
    ctx.lines.push(`      let _wrW_${i}: f32 = f32(${arrLoad(inArr, i)});`);
    ctx.lines.push(`      ${accName} = ${accName} + _wrW_${i};`);
    ctx.lines.push(`      if (${uName} < ${accName}) {`);
    ctx.lines.push(`        ${idxName} = ${i};`);
    ctx.lines.push(`        ${wtName} = _wrW_${i};`);
    ctx.lines.push(`        break;`);
    ctx.lines.push(`      }`);
    ctx.lines.push(`    }`);
    ctx.lines.push(`    if (${idxName} < 0) {`);
    ctx.lines.push(`      ${idxName} = ${inArr.lenName} - 1;`);
    ctx.lines.push(`      ${wtName} = f32(${arrLoad(inArr, idxName)});`);
    ctx.lines.push(`    }`);
    ctx.lines.push(`  }`);
    const idxRef: ValueRef = { expr: idxName, type: 'i32' };
    const wtRef: ValueRef = { expr: wtName, type: 'f32' };
    setCachedPort(ctx, node.id, 'index', idxRef);
    setCachedPort(ctx, node.id, 'result', wtRef);
    return wtRef;
  }

  // Determine accumulator type
  const accType: WgslType = (mode === 'count') ? 'i32' : (op === 'and' || op === 'or') ? 'bool' : 'f32';

  // Initial value
  let initExpr: string;
  if (mode === 'count') initExpr = '0';
  else if (op === 'sum' || op === 'average') initExpr = '0.0';
  else if (op === 'product') initExpr = '1.0';
  else if (op === 'min') initExpr = WGSL_F32_MAX;
  else if (op === 'max') initExpr = `-${WGSL_F32_MAX}`;
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
    && firstSrcNode && ctx.producesArray(firstSrcNode);
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
    arrRef = compileArrayNode(ctx, firstSrc.nodeId, firstSrc.portId);
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
    && firstSrcNode && ctx.producesArray(firstSrcNode)
    ? compileArrayNode(ctx, firstSrc.nodeId, firstSrc.portId) : null;

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

  // Write to a scalar Local Variable. Cast the input to the variable's
  // WGSL type and assign. Array variables use setArrayElement; validation
  // rejects the mismatch.
  setVariable: ({ node, ctx, inputs }) => {
    const variableId = node.data.config.variableId as string;
    const v = (ctx.model.variables || []).find(x => x.id === variableId);
    if (!v) { ctx.errors.push(`setVariable: unknown variable "${variableId}"`); return false; }
    if (v.kind !== 'scalar') {
      ctx.errors.push(`setVariable: variable "${variableId}" is an array; use setArrayElement instead`);
      return false;
    }
    const valueRef = inputs['value'];
    if (!valueRef) { ctx.errors.push('setVariable: missing value input'); return false; }
    const ty = variableWgslType(v.dataType);
    ctx.lines.push(`  ${variableWgslName(v.id)} = ${castTo(valueRef, ty)};`);
    return true;
  },

  // Write to an array Local Variable at a runtime-computed index. Bounds-
  // checked at runtime (mirrors JS/WASM emits) — out-of-range writes
  // silently skip.
  setArrayElement: ({ node, ctx, inputs }) => {
    const variableId = node.data.config.variableId as string;
    const v = (ctx.model.variables || []).find(x => x.id === variableId);
    if (!v) { ctx.errors.push(`setArrayElement: unknown variable "${variableId}"`); return false; }
    if (v.kind !== 'array') {
      ctx.errors.push(`setArrayElement: variable "${variableId}" is a scalar; use setVariable instead`);
      return false;
    }
    const idxRef = inputs['index'];
    const valueRef = inputs['value'];
    if (!idxRef) { ctx.errors.push('setArrayElement: missing index input'); return false; }
    if (!valueRef) { ctx.errors.push('setArrayElement: missing value input'); return false; }
    const length = Math.max(1, Number(v.length) | 0) || 1;
    const ty = variableWgslType(v.dataType);
    const name = variableWgslName(v.id);
    const idxExpr = castTo(idxRef, 'i32');
    const valExpr = castTo(valueRef, ty);
    // WGSL `if` block: bounds check, then assign. Stash idx as a let so
    // we only evaluate the input once.
    const iName = fresh(ctx, 'saiI');
    ctx.lines.push(`  let ${iName}: i32 = ${idxExpr};`);
    ctx.lines.push(`  if (${iName} >= 0 && ${iName} < ${length}) { ${name}[${iName}] = ${valExpr}; }`);
    return true;
  },

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

  setCellLooks: ({ node, ctx, inputs }) => {
    const cfg = node.data.config;
    const useGlyph = !!cfg.useGlyph;
    const setBg = cfg.setBackground !== false; // default true
    const viewerId = (cfg.mappingId as string) || '';
    const isCurrentViewer = viewerId === CURRENT_VIEWER_SENTINEL;
    const viewerInt = isCurrentViewer ? undefined : ctx.viewerIds[viewerId];
    if (!isCurrentViewer && viewerInt === undefined) return true; // unknown viewer — skip

    const doBg = !useGlyph || setBg;
    const doGlyph = useGlyph && ctx.layout.hasGlyphs;
    if (!doBg && !doGlyph) return true;

    // Build the per-cell write lines (un-indented; the emit paths below add it).
    const writes: string[] = [];
    if (doBg) {
      const r = inputs['r'] ?? { expr: '0', type: 'i32' as WgslType };
      const g = inputs['g'] ?? { expr: '0', type: 'i32' as WgslType };
      const b = inputs['b'] ?? { expr: '0', type: 'i32' as WgslType };
      const re = `u32(clamp(${castTo(r, 'i32')}, 0, 255))`;
      const ge = `u32(clamp(${castTo(g, 'i32')}, 0, 255))`;
      const be = `u32(clamp(${castTo(b, 'i32')}, 0, 255))`;
      // Cell alpha. Default (unwired / inline 255) emits the verbatim
      // `(255u << 24u)` so an unchanged model's shader stays byte-identical;
      // any other input clamps to 0..255 like r/g/b.
      const a = inputs['a'];
      const ae = (!a || a.expr === '255') ? '255u' : `u32(clamp(${castTo(a, 'i32')}, 0, 255))`;
      writes.push(`colors[idx] = (${re}) | ((${ge}) << 8u) | ((${be}) << 16u) | (${ae} << 24u);`);
    }
    if (doGlyph) {
      const cp = inputs['glyph'] ?? { expr: '0', type: 'i32' as WgslType };
      const gr = inputs['glyphR'] ?? { expr: '0', type: 'i32' as WgslType };
      const gg = inputs['glyphG'] ?? { expr: '0', type: 'i32' as WgslType };
      const gb = inputs['glyphB'] ?? { expr: '0', type: 'i32' as WgslType };
      const cpe = `u32(max(${castTo(cp, 'i32')}, 0))`;
      const re = `u32(clamp(${castTo(gr, 'i32')}, 0, 255))`;
      const ge = `u32(clamp(${castTo(gg, 'i32')}, 0, 255))`;
      const be = `u32(clamp(${castTo(gb, 'i32')}, 0, 255))`;
      writes.push(`glyphCodes[idx] = ${cpe};`);
      writes.push(`glyphColors[idx] = (${re}) | ((${ge}) << 8u) | ((${be}) << 16u);`);
    }

    if (ctx.currentMappingId !== null) {
      // Inside an outputMapping shader: only write if THIS shader handles the
      // mapping (or always for "Current Simulator Selected").
      if (!isCurrentViewer && ctx.currentMappingId !== viewerId) return true;
      for (const w of writes) ctx.lines.push(`  ${w}`);
      return true;
    }
    if (isCurrentViewer) {
      // Step shader, "Current Simulator Selected": no activeViewer guard.
      for (const w of writes) ctx.lines.push(`  ${w}`);
      return true;
    }
    // Step shader: guard on activeViewer.
    ctx.lines.push(`  if (control.activeViewer == ${viewerInt}) {`);
    for (const w of writes) ctx.lines.push(`    ${w}`);
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

  // -- Variegated Cells: Set Orientation ---------------------------------
  // Writes the current cell's orientation to attrsWrite at orientationWordOffset.
  // Clamped to 0..3 via `& 3i`. Encoded as u32 for storage.
  setOrientation: ({ ctx, inputs }) => {
    if (!ctx.layout.variegatedEnabled) {
      ctx.errors.push('setOrientation: variegated cells disabled');
      return false;
    }
    if (!ctx.allowAttrWrites) {
      ctx.errors.push('setOrientation: cannot write attributes from outputMapping graph');
      return false;
    }
    const valueRef = inputs['value'] ?? { expr: '0', type: 'i32' as WgslType };
    const v = castTo(valueRef, 'i32');
    const w = ctx.layout.orientationWordOffset;
    ctx.lines.push(`  attrsWrite[${w}u + idx] = bitcast<u32>((${v}) & 3i);`);
    return true;
  },

  // -- Variegated Cells: Set Facing Orientation — REJECTED on WebGPU -----
  // Async-only node; WebGPU is sync-only (detectWebGPUModelIncompatibilities
  // catches async-mode at the model level). Defensive in case validation is
  // bypassed.
  setFacingOrientation: ({ ctx }) => {
    ctx.errors.push('setFacingOrientation: requires async update mode (incompatible with WebGPU)');
    return false;
  },
  setNeighborOrientationByIndex: ({ ctx }) => {
    ctx.errors.push('setNeighborOrientationByIndex: requires async update mode (incompatible with WebGPU)');
    return false;
  },
};

// ---------------------------------------------------------------------------
// Orchestrator: compileValueNode / compileFlowChain / compileEntry
// ---------------------------------------------------------------------------

function compileValueNode(ctx: CompileCtx, nodeId: string, portId: string = 'value'): ValueRef | null {
  // During preEmit, skip volatile values — emitting them at function-top would
  // read the variable's initial value (before in-flow writes). compileFlowChain
  // force-emits them at their LCA flow scope instead (return is ignored here).
  if (ctx.suppressVolatile && ctx.volatile.has(nodeId)) return null;
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

  if (node.data.nodeType === 'loop' && portId === 'index') {
    // The Loop node's per-iteration counter. Mint the WGSL var name on demand
    // (once per loop node) so consumers compiled during preEmitValueNodes
    // reference the same identifier the loop's `for (var …)` statement later
    // declares. Their `let` lines are routed to the loopBody sink scope by
    // routeEmissionForNode and flushed INSIDE the for block, where the counter
    // is in scope (sinkAnalysis pins index-dependents at loopBody).
    return loopIndexRef(ctx, nodeId);
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

  // Pre-resolve MULTI-SOURCE SCALAR inputs of array ports HERE, at the current
  // (upstream) scope — OUTSIDE the emitter's routeEmissionForNode wrapper below.
  // Some value emitters (getRandom "options", aggregate/groupOperator over
  // multi-scalar sources) resolve their array-port sources internally via
  // compileValueNode. If such a source is a CSE-shared constant whose sink scope
  // is CELL_TOP, compiling it for the FIRST time inside this node's wrapper dumps
  // its `let` into this node's temporary branch buffer (routeEmissionForNode's
  // CELL_TOP fast-path emits into the current ctx.lines), so a sibling branch
  // that also reads it sees an undeclared identifier (the "_ki10" WGSL crash).
  // Warming the cache here honors the "inputs resolved upstream" contract (see
  // routeEmissionForNode's doc comment); the emitter's own resolution then reuses
  // these cached refs (idempotent — no double emission). Skip single array-
  // PRODUCER sources (leave them to the emitter so aggregate/groupOperator fusion
  // is preserved) and getVariable (dual scalar/array; resolved at use site).
  for (const port of def.ports) {
    if (port.kind !== 'input' || port.category !== 'value' || !port.isArray) continue;
    const srcs = ctx.inputToSources.get(`${nodeId}:${port.id}`);
    if (!srcs) continue;
    for (const s of srcs) {
      const sn = ctx.nodeMap.get(s.nodeId);
      if (!sn || sn.data.nodeType === 'getVariable') continue;
      // valueSwitch array relay: its `result` port produces an array even though
      // it isn't statically isArray — leave it to the emitter's resolveInputArray
      // (→ compileArrayNode); scalar-resolving it would hit the value emitter.
      if (sn.data.nodeType === 'valueSwitch' && ctx.producesArray(sn)) continue;
      const sp = getNodeDef(sn.data.nodeType)?.ports.find(p => p.id === s.portId);
      if (sp?.isArray) continue; // array producer → leave to emitter (fusion)
      compileValueNode(ctx, s.nodeId, s.portId);
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
        const arraySrcNode = src ? ctx.nodeMap.get(src.nodeId) : undefined;
        if (src && arraySrcNode && ctx.producesArray(arraySrcNode)) {
          compileArrayNode(ctx, src.nodeId, src.portId);
        }
        if (srcs) for (const s of srcs) {
          const sn = ctx.nodeMap.get(s.nodeId);
          if (sn && ctx.producesArray(sn)) compileArrayNode(ctx, s.nodeId, s.portId);
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
      // getVariable is dual-mode (scalar+array). Skip the pre-emit dispatch
      // for it — the consumer's inputs resolution at use time picks the right
      // path based on the variable's kind, and pre-emitting both paths here
      // would error out for the path that doesn't match.
      const isGetVariable = (s: { nodeId: string }): boolean => {
        return ctx.nodeMap.get(s.nodeId)?.data.nodeType === 'getVariable';
      };
      if (src && !isGetVariable(src)) {
        if (isArraySrcPort(src)) compileArrayNode(ctx, src.nodeId, src.portId);
        else compileValueNode(ctx, src.nodeId, src.portId);
      }
      if (srcs) for (const s of srcs) {
        if (isGetVariable(s)) continue;
        if (isArraySrcPort(s)) compileArrayNode(ctx, s.nodeId, s.portId);
        else compileValueNode(ctx, s.nodeId, s.portId);
      }
    }

    if (visited.has(target.nodeId)) continue;
    visited.add(target.nodeId);

    switch (node.data.nodeType) {
      case 'conditional':
      // `assertActiveViewer` — conditional minus the ELSE (no `else` targets).
      case 'assertActiveViewer':
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
    // Pass-through continuation (`next`): pre-emit its chain's value inputs
    // like sibling targets'. (forEachInArray bodies stay excluded above — a
    // forEach's next chain runs OUTSIDE the loop, so this is safe for it too.)
    preEmitValueNodes(ctx, target.nodeId, 'next', visited);
  }
}

function compileFlowChain(ctx: CompileCtx, sourceNodeId: string, sourcePortId: string): boolean {
  const targets = ctx.flowOutputToTargets.get(`${sourceNodeId}:${sourcePortId}`) ?? [];
  for (const target of targets) {
    const node = ctx.nodeMap.get(target.nodeId);
    if (!node) continue;
    const def = getNodeDef(node.data.nodeType);
    if (!def) continue;

    // Volatile values whose LCA flow scope is here: force-emit them (at the
    // current position, since their emitScope was forced to CELL_TOP) BEFORE
    // this flow node, so they land after preceding sibling writes and dominate
    // every branch this node opens. getVariable reads its var<function> directly
    // (no block-scoped let), so it never needs hoisting — skip it.
    const hoisted = ctx.volatileHoist.get(target.nodeId);
    if (hoisted) {
      const savedForce = ctx.forceCurrentScope;
      ctx.forceCurrentScope = true;
      for (const vId of hoisted) {
        const vn = ctx.nodeMap.get(vId);
        if (!vn || vn.data.nodeType === 'getVariable') continue;
        // valueSwitch is dual-registered — ctx.producesArray routes an array-relay
        // instance (reading getVariable arrays) to the array emitter.
        if (ctx.producesArray(vn)) compileArrayNode(ctx, vId);
        else compileValueNode(ctx, vId);
      }
      ctx.forceCurrentScope = savedForce;
    }

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
    } else if (node.data.nodeType === 'assertActiveViewer') {
      // Guard the IF ACTIVE branch on `control.activeViewer` — the SAME runtime
      // compare Set Cell Looks emits in the Step shader. A mapping that is not a
      // compile-time viewer can never be active, so the branch is DROPPED
      // (mirroring setCellLooks' "unknown viewer — skip"). DONE (`next`) is
      // emitted by the shared tail, unconditionally.
      //
      // NB inside an OUTPUT-MAPPING shader this stays a RUNTIME compare rather
      // than setCellLooks' compile-time `ctx.currentMappingId` resolution: the
      // control binding is present in every entry point, and the runtime form is
      // what keeps the three cell targets structurally identical here.
      const mid = (node.data.config.mappingId as string) || '';
      const viewerInt = mid ? ctx.viewerIds[mid] : undefined;
      if (viewerInt !== undefined && ctx.flowOutputToTargets.has(`${node.id}:then`)) {
        ctx.lines.push(`  if (control.activeViewer == ${viewerInt}) {`);
        flushBranchValues(ctx, `${node.id}:then`);
        if (!compileFlowChain(ctx, node.id, 'then')) return false;
        ctx.lines.push(`  }`);
      }
    } else if (node.data.nodeType === 'sequence') {
      if (!compileFlowChain(ctx, node.id, 'first')) return false;
      if (!compileFlowChain(ctx, node.id, 'then')) return false;
      const extra = Number(node.data.config.extraCount) || 0;
      for (let si = 2; si < 2 + extra; si++) {
        if (!compileFlowChain(ctx, node.id, `then_${si}`)) return false;
      }
    } else if (node.data.nodeType === 'loop') {
      const isRange = node.data.config.mode === 'range';
      const resolveLoopI32 = (portId: string, dflt: number): string | null => {
        const src = ctx.inputToSource.get(`${node.id}:${portId}`);
        if (src) {
          const r = compileValueNode(ctx, src.nodeId, src.portId);
          return r ? castTo(r, 'i32') : null;
        }
        const port = def.ports.find(p => p.id === portId);
        const inlineVal = port ? getInlineValue(port, node.data.config) : undefined;
        return `${parseInlineNum(inlineVal, dflt) | 0}`;
      };
      // Use the SAME identifier consumers of the `index` output already hold
      // (minted on demand during preEmit) — see loopIndexRef.
      const li = loopIndexRef(ctx, node.id).expr;
      if (isRange) {
        // Range mode: From..To inclusive (ascending; From > To runs zero times).
        const from = resolveLoopI32('from', 0);
        const to = resolveLoopI32('to', 0);
        if (from === null || to === null) return false;
        ctx.lines.push(`  for (var ${li}: i32 = ${from}; ${li} <= ${to}; ${li} = ${li} + 1) {`);
      } else {
        const cnt = resolveLoopI32('count', 1);
        if (cnt === null) return false;
        ctx.lines.push(`  for (var ${li}: i32 = 0; ${li} < ${cnt}; ${li} = ${li} + 1) {`);
      }
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
      // Expose the loop counter — body-side nodes that index parallel arrays
      // by slot read this instead of `element`.
      setCachedPort(ctx, node.id, 'index', { expr: fi, type: 'i32' });
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
        // `continue` skips the shared end-of-loop continuation — run it here.
        if (!compileFlowChain(ctx, node.id, 'next')) return false;
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

    // Pass-through continuation (`next` — NEXT on action nodes, DONE on
    // control nodes): lines emitted here land right after the node's own
    // emission / after its closed WGSL block, at the same lexical scope.
    // No-op when nothing is wired.
    if (!compileFlowChain(ctx, node.id, 'next')) return false;
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
    // Other flow nodes (setIndicator, updateIndicator, setCellLooks,
    // stopEvent, setNeighborhoodAttribute*, setNeighborAttributeByIndex*,
    // updateAttribute) don't guarantee a cell-attr slot is initialised by
    // setAttribute.

    // Pass-through continuation (`next`): runs unconditionally whenever this
    // target runs — its subtree's guarantees are as strong as the target's
    // own path (a loop's body gives no guarantee, but its DONE chain does).
    for (const x of analyzeAlwaysWritten(ctx, node.id, 'next', depth + 1)) out.add(x);
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

function compileEntry(opts: EntryOpts, base: Omit<CompileCtx, 'lines' | 'valueLocals' | 'arrayRefs' | 'localCounter' | 'errors' | 'currentMappingId' | 'allowAttrWrites' | 'sinkAnalysis' | 'branchLines' | 'volatile' | 'volatileHoist'>): { code: string; errors: string[] } {
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
  // Volatile values (transitive getVariable consumers): force their emit scope
  // to CELL_TOP so routeEmissionForNode emits them at the CURRENT flow position
  // when triggered — not at function-top (which would read the variable's
  // pre-write value). They are skipped during preEmit (suppressVolatile) and
  // force-emitted by compileFlowChain immediately before the flow node that
  // volatileHoist identifies (the LCA of their uses, after preceding writes).
  const volatile = computeVolatileValueClosure(base.nodeMap, base.inputToSource, base.inputToSources);
  for (const v of volatile) sinkAnalysis.emitScope.set(v, CELL_TOP);
  const volatileHoist = computeVolatileHoist({
    nodeMap: base.nodeMap,
    inputToSource: base.inputToSource,
    inputToSources: base.inputToSources,
    flowOutputToTargets: base.flowOutputToTargets,
    rootNodeId: opts.entry.id,
    rootFlowPortId: 'do',
    volatile,
  }).emitBefore;
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
    volatile,
    volatileHoist,
  };
  // Local Variables — emit `var<function>` declarations + initial-value
  // assignments at the top of the function. Per-thread storage is per-cell
  // by construction (one shader invocation = one cell). Runs in every
  // entry-point shader (step, initEvent, outputMapping — there is NO inputColor
  // shader; painting runs the JS fn on the CPU, then patchWebGPUCells) so
  // user code can read/write variables from any of them.
  emitVariableDeclsWgsl(ctx);

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
  // references inside conditional branches resolve correctly. Volatile values
  // are skipped here (suppressVolatile) — compileFlowChain force-emits them at
  // their LCA flow scope so they land after the variable writes.
  ctx.suppressVolatile = true;
  preEmitValueNodes(ctx, opts.entry.id, 'do', new Set());
  ctx.suppressVolatile = false;
  if (ctx.errors.length > 0) return { code: '', errors: ctx.errors };
  // Compile the flow chain rooted at the entry node's `do` port.
  compileFlowChain(ctx, opts.entry.id, 'do');
  if (ctx.errors.length > 0) return { code: '', errors: ctx.errors };
  const body = ctx.lines.join('\n') + '\n';
  return { code: emitEntryPoint(opts.fnName, ctx.layout.total, body), errors: [] };
}

// Macro expansion (`expandMacros`) now lives in the shared `../macroExpand`
// module, used identically by the JS / WASM / WebGPU compilers.

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

  // L2 — Get Generation: declare `Control.generation` only when the graph reads
  // it, so the shader TEXT (which IS byte-identity-checked) is unchanged for
  // every model that doesn't. Computed from the PRE-expansion model so a
  // getGeneration hiding inside a macro still counts. See generationUse.ts.
  const cellGen = cellUsesGeneration(model);

  // Expand macro instances first so the rest of the compile sees a flat graph.
  const expanded = expandMacros(graphNodes, graphEdges, model);
  if (expanded.error) {
    return {
      shaderCode: '', entryPoints: { step: 'step', outputMappings: [] },
      layout, viewerIds: {}, error: expanded.error,
    };
  }
  // Reroute collapse — strip editor-only reroute relay nodes, rewiring each
  // consumer to the real source (chains resolved transitively). Runs AFTER
  // expandMacros so in-macro reroutes collapse too, and before linked-OM / CSE /
  // adjacency so nothing downstream sees a reroute. See rerouteCollapse.ts.
  const collapsed = collapseReroutes(expanded.nodes, expanded.edges);
  // Multi-attribute slot expansion — multi-slot Get/Set Attribute nodes become the
  // single-slot primitives the WGSL emitters already compile. BEFORE lowerVectorAttrs
  // so a vector attribute in an extra slot lowers normally. See multiAttrExpand.ts.
  const maExpanded = expandMultiAttrs(collapsed.nodes, collapsed.edges, model);
  // Vector stored-attribute lowering — Get/Set Vector nodes → Make/Break Vector over
  // per-component scalar reads/writes + reassign `model` to the component-expanded
  // attrs/variables (computeWebGPULayout above expands identically). BEFORE
  // expandComposites so the synthesized Make/Break Vector lower. See vectorAttr.ts.
  const vlowered = lowerVectorAttrs(maExpanded.nodes, maExpanded.edges, model);
  model = vlowered.model;
  // Composite-type lowering — vector / colour nodes become scalar nodes so the
  // WGSL emitters compile them natively (no JS-only clamp). See expandComposites.ts.
  const lowered = expandComposites(vlowered.nodes, vlowered.edges, model);
  // Linked Output Mappings — synthesize the auto color pass for `linked`
  // mappings (ephemeral; rebuilt from the live model each compile). MUST rebind
  // `nodes` so the output-mapping emission loop below sees the synthetic root —
  // otherwise WebGPU silently shows default colors while JS/WASM render the pass.
  const injected = injectLinkedOutputMappings(lowered.nodes, lowered.edges, model);
  const nodes = injected.nodes;
  // Accessor CSE — sync-mode only. Runs AFTER macro expansion so duplicate
  // accessors inside (or across) macro instances also get merged. No-op when
  // no group has more than one member. See accessorCSE.ts for the full rationale.
  const edges = canonicalizeAccessorEdges(nodes, injected.edges, model);

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

  const baseCtx: Omit<CompileCtx, 'lines' | 'valueLocals' | 'arrayRefs' | 'localCounter' | 'errors' | 'currentMappingId' | 'allowAttrWrites' | 'sinkAnalysis' | 'branchLines' | 'volatile' | 'volatileHoist'> = {
    model, layout, viewerIds, stopMessages, maxArraySize,
    nodeMap: adj.nodeMap,
    inputToSource: adj.inputToSource,
    inputToSources: adj.inputToSources,
    flowOutputToTargets: adj.flowOutputToTargets,
    outDegree: adj.outDegree,
    producesArray: makeProducesArray({
      isArrayProducer,
      inputToSource: adj.inputToSource,
      nodeMap: adj.nodeMap,
    }),
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
    const sections: string[] = [emitBindings(layout, cellGen), stepCode];
    return { ...baseResult, shaderCode: sections.join('\n'), entryPoints: { step: 'step', outputMappings: [] } };
  }

  const sections: string[] = [emitBindings(layout, cellGen)];
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

  // Init Event entry point (optional). Same loop shape as step (per-cell, with
  // the bulk-copy preamble that includes orientation in variegated models), so
  // SetAttribute / SetOrientation inside Init see a fresh w-buffer. Worker
  // dispatches `dispatchInit` once on Reset and then swaps the ping-pong bind
  // group so the next step reads init writes.
  let initEntryName: string | undefined;
  const initNode = nodes.find(n => n.data.nodeType === 'initEvent');
  if (initNode) {
    const initEntry = compileEntry({
      entry: initNode,
      fnName: 'init',
      emitCopyPreamble: true,
      allowAttrWrites: true,
      currentMappingId: null,
    }, baseCtx);
    if (initEntry.errors.length > 0) {
      return { ...baseResult, error: initEntry.errors.join('; ') };
    }
    sections.push(initEntry.code);
    initEntryName = 'init';
  }

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
    entryPoints: { step: 'step', outputMappings, init: initEntryName },
  };
}

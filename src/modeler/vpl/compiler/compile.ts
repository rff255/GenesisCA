import type { GraphNode, GraphEdge, CAModel } from '../../../model/types';
import { agentAttrsOf, bondAttrsOf, cellFieldAttrsOf } from '../../../model/attributeScope';
import { resolveAgentFieldGates } from '../../../model/agentFieldGating';
import { encodeAttrValue } from '../../../model/attrValueEncoding';
import { buildAgentAbiParams, type AgentAbiShape } from './agentAbi';
import { getAllNodeDefs, getNodeDef } from '../nodes/registry';
import { CURRENT_VIEWER_SENTINEL } from '../nodes/SetCellLooksNode';
import { hemifieldArraysUsed } from '../nodes/SenseHemifieldNode';
import { parseHandleId, type CompileContext } from '../types';
import { classifyLoopInvariant } from './loopInvariant';
import { safeId } from './identifierSafe';
import { detectFusableConsumers, type FusionResult } from './fusion';
import { getInlineValue } from './inlinePort';
import { buildBondAttrPorts } from '../bondAttrPorts';
import { INVALID_NI, packNI, packNI3, NI_ARRAY_PRODUCERS } from './niCodec';
import { analyzeSinkScopes, isRngNode, CELL_TOP, type ScopeId } from './sinkAnalysis';
import { canonicalizeAccessorEdges } from './accessorCSE';
import { injectLinkedOutputMappings } from './linkedOutputMappings';
import { injectAgentLinkedOutputMappings } from './agentLinkedOutputMappings';
import { collapseReroutes } from './rerouteCollapse';
import { expandMultiAttrs } from './multiAttrExpand';
import { expandForceToAgents } from './forceToAgentsExpand';
import { expandNeighbourCensus } from './censusExpand';
import { expandPeriodicSteps } from './periodicExpand';
import { cellUsesGeneration, agentUsesGeneration } from './generationUse';
import { expandComposites } from './expandComposites';
import { BOND_REQUEST_NODE_TYPES, bondReqSlotsForModel } from './bondRequestQueue';
import { assignDividePartitionCodes, type DividePartitionSpec } from './dividePartition';
import { lowerVectorAttrs } from './vectorAttr';
import { lowerFacingSource } from './facingSource';
import { computeAsyncReadWriteHazards } from './asyncWriteHazard';
import { sparseSteppingEnabled } from './sparseStepping';
import { expandMacros } from './macroExpand';
import { detectDanglingRefs } from './danglingRefs';
export { sparseSteppingEnabled } from './sparseStepping';
import { computeVolatileHoist } from './volatileHoist';
import {
  isSubAttribute,
  subAttrInfo,
  attrValueLiteralJS,
  parentMatchExprJS,
} from './subAttribute';
import { directionIndex, DIRECTION_TAGS, resolveKeyLabels, resolveAxes, isMultiAxisTable } from './variegation';
import { buildVariableJS } from './variable';

// ---------------------------------------------------------------------------
// Graph adjacency helpers
// ---------------------------------------------------------------------------

function buildAdjacency(graphNodes: GraphNode[], graphEdges: GraphEdge[]) {
  const nodeMap = new Map<string, GraphNode>();
  for (const n of graphNodes) nodeMap.set(n.id, n);

  const inputToSource = new Map<string, { nodeId: string; portId: string }>();
  const inputToSources = new Map<string, Array<{ nodeId: string; portId: string }>>();
  const flowOutputToTargets = new Map<string, Array<{ nodeId: string; portId: string }>>();

  for (const edge of graphEdges) {
    const sourceHandle = parseHandleId(edge.sourceHandle);
    const targetHandle = parseHandleId(edge.targetHandle);
    if (!sourceHandle || !targetHandle) continue;

    if (targetHandle.category === 'value') {
      const key = `${edge.target}:${targetHandle.portId}`;
      inputToSource.set(key, { nodeId: edge.source, portId: sourceHandle.portId });
      // Also collect ALL sources for multi-input ports (e.g., aggregate)
      const arr = inputToSources.get(key) ?? [];
      arr.push({ nodeId: edge.source, portId: sourceHandle.portId });
      inputToSources.set(key, arr);
    }

    if (sourceHandle.category === 'flow') {
      const key = `${edge.source}:${sourceHandle.portId}`;
      const existing = flowOutputToTargets.get(key) ?? [];
      existing.push({ nodeId: edge.target, portId: targetHandle.portId });
      flowOutputToTargets.set(key, existing);
    }
  }

  return { nodeMap, inputToSource, inputToSources, flowOutputToTargets };
}

// ---------------------------------------------------------------------------
// Compile a single root's subgraph (per-cell body)
// ---------------------------------------------------------------------------

const MULTI_OUTPUT_TYPES = new Set(['inputColor', 'initEvent', 'getColorConstant', 'macro', 'colorScale', 'categoricalColor', 'breakDownNeighborIndex', 'getFacingLabels', 'getAllFacingLabels', 'getCellPosition', 'behaviourStep', 'divisionEvent', 'getSelfPosition', 'forEachBond', 'fieldGradient', 'getAgentPosition', 'getAgentOffset', 'getVelocity', 'senseHemifield',
  // Grid Init Event's value-outs (width/height/depth) resolve via `_v<id>_<port>`.
  'gridInit',
  // Get Grid Dimensions (universal — cells AND agents): width/height/depth.
  'getGridDimensions',
  // Generic Agent Platform spawn/init: the Agent Init Event's value-outs
  // (worldWidth/worldHeight/seedIndexBase) + Create Agent's `handle` resolve via
  // the `_v<id>_<port>` convention.
  'agentInit', 'createAgent',
  // Composite-type Break nodes + Vector Op resolve via the `_v<id>_<port>` convention.
  'breakVector', 'breakColor', 'vectorOp']);

/** The four AGENTS-graph event roots. A root in this set compiles into a
 *  per-AGENT function (the agent ABI — `_agentX`, `_fieldW`, …); anything else is
 *  a per-CELL function (`W`/`H`/`D`, `r_<attr>`, …). Drives `CompileContext.agentGraph`
 *  so a UNIVERSAL node (one available on both graphs) can emit against the right ABI. */
const AGENT_ROOT_TYPES = new Set(['behaviourStep', 'divisionEvent', 'agentInit', 'agentOutputMapping']);

/** Check if a node's data uses multi-output variable naming */
function isMultiOutput(data: { nodeType: string; config: Record<string, string | number | boolean> }): boolean {
  if (MULTI_OUTPUT_TYPES.has(data.nodeType)) return true;
  if (data.nodeType === 'getModelAttribute' && data.config.isColorAttr) return true;
  // Get Random is single-output (`value`) in every mode EXCEPT `vector`, whose
  // X / Y components resolve via the `_v<id>_<port>` convention.
  if (data.nodeType === 'getRandom' && data.config.randomType === 'vector') return true;
  if (data.nodeType === 'groupStatement' || data.nodeType === 'groupCounting'
    || data.nodeType === 'groupOperator') return true;
  // filterNeighbors and joinNeighbors expose `result` (kept NI array) and
  // `count` (its length) — varName resolves both via the `_v<id>_<port>`
  // convention.
  if (data.nodeType === 'filterNeighbors') return true;
  if (data.nodeType === 'joinNeighbors') return true;
  // Generic Agent Platform: Filter/Join Agents are multi-output (result + count).
  if (data.nodeType === 'filterAgents') return true;
  if (data.nodeType === 'joinAgents') return true;
  return false;
}

interface RootCompileResult {
  valueLines: string[];
  /** Loop-invariant value lines emitted ABOVE the cell loop (one-time work per
   *  step). Populated when a node is classified loop-invariant — typically
   *  getModelAttribute reads and arithmetic over them. Saves N redundant per-cell
   *  hash lookups per step where N = grid size. */
  preLoopValueLines: string[];
  flowLines: string[];
  /** Nodes that need pre-loop declarations.
   *  nbrId: sized array for neighborhood scratch (GetNeighborsAttribute).
   *  attrId: source attribute id — used to pick a typed-array constructor for the scratch.
   *  initExpr: literal init expression for reusable scratch (e.g., '[]'). */
  scratchNodes: Array<{ scratchVarName: string; nbrId?: string; attrId?: string; initExpr?: string }>;
}

/** Pick a typed-array constructor name for a scratch buffer that mirrors a cell attribute.
 *  Falls back to '' (untyped Array) for unknown/color types so behaviour is preserved. */
function scratchCtorForAttr(attrId: string | undefined, model: CAModel | undefined): string {
  if (!attrId || !model) return '';
  const attr = model.attributes.find(a => a.id === attrId);
  if (!attr) return '';
  // Sub-attribute scratch arrays use plain Array (not typed) so the filter-with-push
  // emit in GetNeighborsAttribute can call `.length = 0` and `.push(...)` —
  // operations not supported on typed arrays. The output is variable-length,
  // excluding neighbors whose parent doesn't match.
  if (isSubAttribute(attr)) return '';
  switch (attr.type) {
    case 'bool': return 'Uint8Array';
    case 'integer': return 'Int32Array';
    case 'tag': return 'Int32Array';
    case 'neighborIndex': return 'Int32Array';
    case 'float': return 'Float64Array';
    default: return '';
  }
}

/**
 * Emit one fused gather+reduce loop for a `getNeighborsAttribute → aggregate`
 * pair detected by the fusion pass. Replaces what would otherwise be two
 * loops (gather into scratch, then reduce scratch) with one — for an N-neighbor
 * aggregate this halves per-cell work and removes the scratch buffer entirely.
 *
 * The result is bound to `_v<aggId>` so any downstream consumer's `varName()`
 * lookup resolves to the same identifier whether or not fusion happened.
 */
function buildFusedAggregateJS(aggId: string, op: string, nbrId: string, attrId: string): string {
  const acc = `_v${aggId}`;
  const i = `_v${aggId}_i`;
  const nb = `_nb${aggId}`;
  const sz = `nSz_${nbrId}`;
  const head = `const ${nb} = idx * ${sz};`;
  const elem = `r_${attrId}[nIdx_${nbrId}[${nb} + ${i}]]`;
  switch (op) {
    case 'product':
      return `${head} let ${acc} = 1; for (let ${i} = 0; ${i} < ${sz}; ${i}++) ${acc} *= ${elem};`;
    case 'max':
      return `${head} let ${acc} = -Infinity; for (let ${i} = 0; ${i} < ${sz}; ${i}++) { const _v_${aggId}_e = ${elem}; if (_v_${aggId}_e > ${acc}) ${acc} = _v_${aggId}_e; }`;
    case 'min':
      return `${head} let ${acc} = Infinity; for (let ${i} = 0; ${i} < ${sz}; ${i}++) { const _v_${aggId}_e = ${elem}; if (_v_${aggId}_e < ${acc}) ${acc} = _v_${aggId}_e; }`;
    case 'average':
      return `${head} let _v${aggId}_s = 0; for (let ${i} = 0; ${i} < ${sz}; ${i}++) _v${aggId}_s += ${elem}; const ${acc} = ${sz} > 0 ? _v${aggId}_s / ${sz} : 0;`;
    case 'and':
      return `${head} let ${acc} = 1; for (let ${i} = 0; ${i} < ${sz}; ${i}++) if (!${elem}) { ${acc} = 0; break; }`;
    case 'or':
      return `${head} let ${acc} = 0; for (let ${i} = 0; ${i} < ${sz}; ${i}++) if (${elem}) { ${acc} = 1; break; }`;
    default: // sum
      return `${head} let ${acc} = 0; for (let ${i} = 0; ${i} < ${sz}; ${i}++) ${acc} += ${elem};`;
  }
}

/**
 * Fused emit for `groupOperator` (Group Reduce). Multi-output node — declares
 * BOTH `_v<id>_result` and `_v<id>_index` to match the varName() contract for
 * multi-output nodes. For sum/mul/mean/and/or: index is meaningless and set to
 * -1 (matching the existing non-fused emit). For max/min: track running index
 * alongside running value. For random: pick uniform index, then look up.
 *
 * Note: `and`/`or` return numeric 1/0 (a truthiness break-loop, matching
 * `Aggregate`'s and/or and the WASM/WebGPU integer convention) — NOT JS booleans,
 * which would mismatch a strict-=== consumer on the WASM target.
 */
function buildFusedGroupOperatorJS(nodeId: string, op: string, nbrId: string, attrId: string): string {
  const sz = `nSz_${nbrId}`;
  const nb = `_nb${nodeId}`;
  const head = `const ${nb} = idx * ${sz};`;
  const elemAt = (idxExpr: string) => `r_${attrId}[nIdx_${nbrId}[${nb} + ${idxExpr}]]`;
  const result = `_v${nodeId}_result`;
  const idx = `_v${nodeId}_index`;
  const i = `_gi${nodeId}`;
  const e = `_v_${nodeId}_e`;
  switch (op) {
    case 'mul':
      return `${head} let ${result} = 1; for (let ${i} = 0; ${i} < ${sz}; ${i}++) ${result} *= ${elemAt(i)}; const ${idx} = -1;`;
    case 'mean':
      return `${head} let _v${nodeId}_s = 0; for (let ${i} = 0; ${i} < ${sz}; ${i}++) _v${nodeId}_s += ${elemAt(i)}; const ${result} = _v${nodeId}_s / (${sz} || 1); const ${idx} = -1;`;
    case 'and':
      return `${head} let ${result} = 1; for (let ${i} = 0; ${i} < ${sz}; ${i}++) if (!${elemAt(i)}) { ${result} = 0; break; } const ${idx} = -1;`;
    case 'or':
      return `${head} let ${result} = 0; for (let ${i} = 0; ${i} < ${sz}; ${i}++) if (${elemAt(i)}) { ${result} = 1; break; } const ${idx} = -1;`;
    case 'max':
      return `${head} let ${idx} = 0; let ${result} = ${elemAt('0')}; for (let ${i} = 1; ${i} < ${sz}; ${i}++) { const ${e} = ${elemAt(i)}; if (${e} > ${result}) { ${result} = ${e}; ${idx} = ${i}; } }`;
    case 'min':
      return `${head} let ${idx} = 0; let ${result} = ${elemAt('0')}; for (let ${i} = 1; ${i} < ${sz}; ${i}++) { const ${e} = ${elemAt(i)}; if (${e} < ${result}) { ${result} = ${e}; ${idx} = ${i}; } }`;
    case 'random': {
      // Uniform pick via the shared _rs xorshift32 stream (NOT Math.random) so JS
      // matches the WASM target and stays reproducible from a given RNG state.
      // Always advances the stream once; same floor((_rs/2^32)*sz) formula WASM
      // uses. index = -1 / result = 0 for an empty neighborhood (sz == 0).
      const advance = '_rs = (_rs ^ (_rs << 13)) >>> 0;'
        + ' _rs = (_rs ^ (_rs >>> 17)) >>> 0;'
        + ' _rs = (_rs ^ (_rs << 5)) >>> 0;';
      return `${head} ${advance} let ${idx} = -1; let ${result} = 0; if (${sz} > 0) { ${idx} = Math.floor((_rs / 4294967296) * ${sz}); ${result} = ${elemAt(idx)}; }`;
    }
    case 'weightedRandom': {
      // Cumulative-sum weighted sampling over the neighborhood values. Uses
      // the shared _rs xorshift32 stream. Empty neighborhood (sz==0) returns
      // index=-1, result=0; sum<=0 same.
      const advance = '_rs = (_rs ^ (_rs << 13)) >>> 0;'
        + ' _rs = (_rs ^ (_rs >>> 17)) >>> 0;'
        + ' _rs = (_rs ^ (_rs << 5)) >>> 0;';
      const sum = `_gs${nodeId}`;
      const u = `_gu${nodeId}`;
      const acc = `_ga${nodeId}`;
      return `${head} ${advance} let ${sum} = 0; for (let ${i} = 0; ${i} < ${sz}; ${i}++) ${sum} += ${elemAt(i)}; let ${idx} = -1; let ${result} = 0; if (${sum} > 0) { const ${u} = (_rs / 4294967296) * ${sum}; let ${acc} = 0; for (let ${i} = 0; ${i} < ${sz}; ${i}++) { ${acc} += ${elemAt(i)}; if (${u} < ${acc}) { ${idx} = ${i}; ${result} = ${elemAt(i)}; break; } } if (${idx} < 0) { ${idx} = ${sz} - 1; ${result} = ${elemAt(idx)}; } }`;
    }
    case 'sum':
    default:
      return `${head} let ${result} = 0; for (let ${i} = 0; ${i} < ${sz}; ${i}++) ${result} += ${elemAt(i)}; const ${idx} = -1;`;
  }
}

/**
 * Fused emit for `groupCounting` (Count Matching) on the count-only path.
 * The detector already refused fusion when the `indexes` output is wired,
 * so we never need to materialise indices here. Declares `_v<id>_count` to
 * match the multi-output varName() contract.
 *
 * The compare condition (equals/notEquals/.../between/notBetween) reuses the
 * same operator-to-JS-string logic as the existing GroupCountingNode emit.
 */
function buildFusedGroupCountingJS(
  nodeId: string,
  op: string,
  nbrId: string,
  attrId: string,
  compareVar: string,
  compareHighVar: string,
  lowOp: string,
  highOp: string,
): string {
  const sz = `nSz_${nbrId}`;
  const nb = `_nb${nodeId}`;
  const head = `const ${nb} = idx * ${sz};`;
  const i = `_gi${nodeId}`;
  const elem = `r_${attrId}[nIdx_${nbrId}[${nb} + ${i}]]`;
  const count = `_v${nodeId}_count`;
  let cond: string;
  switch (op) {
    case 'notEquals': cond = `${elem} !== ${compareVar}`; break;
    case 'greater':   cond = `${elem} > ${compareVar}`; break;
    case 'lesser':    cond = `${elem} < ${compareVar}`; break;
    case 'between': {
      const inside = `(${elem} ${lowOp} ${compareVar} && ${elem} ${highOp} ${compareHighVar})`;
      cond = inside;
      break;
    }
    case 'notBetween': {
      const inside = `(${elem} ${lowOp} ${compareVar} && ${elem} ${highOp} ${compareHighVar})`;
      cond = `!${inside}`;
      break;
    }
    default: cond = `${elem} === ${compareVar}`; break; // equals
  }
  return `${head} let ${count} = 0; for (let ${i} = 0; ${i} < ${sz}; ${i}++) { if (${cond}) ${count}++; }`;
}

/**
 * Fused emit for `groupStatement` (Group Assert) on the result-only path.
 * The detector refused fusion when the `indexes` output is wired. Uses
 * short-circuit loops (every-style with first-failure break, some-style with
 * first-match break) to match the existing `arr.every(...)` / `arr.some(...)`
 * semantics of the non-fused emit.
 */
function buildFusedGroupStatementJS(
  nodeId: string,
  op: string,
  nbrId: string,
  attrId: string,
  xVar: string,
): string {
  const sz = `nSz_${nbrId}`;
  const nb = `_nb${nodeId}`;
  const head = `const ${nb} = idx * ${sz};`;
  const i = `_gi${nodeId}`;
  const elem = `r_${attrId}[nIdx_${nbrId}[${nb} + ${i}]]`;
  const result = `_v${nodeId}_result`;
  // every-style: start true, first failure → false + break
  // some-style: start false, first match → true + break
  switch (op) {
    case 'allIs':
      return `${head} let ${result} = true; for (let ${i} = 0; ${i} < ${sz}; ${i}++) if (${elem} !== ${xVar}) { ${result} = false; break; }`;
    case 'noneIs':
      return `${head} let ${result} = true; for (let ${i} = 0; ${i} < ${sz}; ${i}++) if (${elem} === ${xVar}) { ${result} = false; break; }`;
    case 'hasA':
      return `${head} let ${result} = false; for (let ${i} = 0; ${i} < ${sz}; ${i}++) if (${elem} === ${xVar}) { ${result} = true; break; }`;
    case 'allGreater':
      return `${head} let ${result} = true; for (let ${i} = 0; ${i} < ${sz}; ${i}++) if (!(${elem} > ${xVar})) { ${result} = false; break; }`;
    case 'anyGreater':
      return `${head} let ${result} = false; for (let ${i} = 0; ${i} < ${sz}; ${i}++) if (${elem} > ${xVar}) { ${result} = true; break; }`;
    case 'allLesser':
      return `${head} let ${result} = true; for (let ${i} = 0; ${i} < ${sz}; ${i}++) if (!(${elem} < ${xVar})) { ${result} = false; break; }`;
    case 'anyLesser':
      return `${head} let ${result} = false; for (let ${i} = 0; ${i} < ${sz}; ${i}++) if (${elem} < ${xVar}) { ${result} = true; break; }`;
    default: // fallback to allIs
      return `${head} let ${result} = true; for (let ${i} = 0; ${i} < ${sz}; ${i}++) if (${elem} !== ${xVar}) { ${result} = false; break; }`;
  }
}

/** Compute the transitive value-input closure starting from every `getVariable`
 *  node. Membership marks a value node as "volatile" — its result depends on
 *  per-cell mutable state (Local Variables), so it can't be hoisted to scope
 *  entry via sink analysis. Routed inline at the use site instead. */
function computeVolatileValueClosure(
  graphNodes: GraphNode[],
  inputToSource: Map<string, { nodeId: string; portId: string }>,
  inputToSources: Map<string, Array<{ nodeId: string; portId: string }>>,
  extraSeeds?: Iterable<string>,
): Set<string> {
  const out = new Set<string>();
  // Forward BFS: a value node is volatile iff any of its value-input sources is
  // volatile, OR it IS a getVariable. Building the reverse map (source → consumers)
  // upfront makes the BFS direct.
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

/** Build the scratch declaration line for a single scratchNodes entry. */
function buildScratchDecl(
  s: { scratchVarName: string; nbrId?: string; attrId?: string; initExpr?: string },
  model: CAModel | undefined,
): string {
  if (s.nbrId) {
    const ctor = scratchCtorForAttr(s.attrId, model);
    return ctor
      ? `  const ${s.scratchVarName} = new ${ctor}(nSz_${s.nbrId});`
      : `  const ${s.scratchVarName} = new Array(nSz_${s.nbrId});`;
  }
  return `  const ${s.scratchVarName} = ${s.initExpr ?? '[]'};`;
}

function compileRoot(
  rootNode: GraphNode,
  rootFlowPort: string,
  nodeMap: Map<string, GraphNode>,
  inputToSource: Map<string, { nodeId: string; portId: string }>,
  inputToSources: Map<string, Array<{ nodeId: string; portId: string }>>,
  flowOutputToTargets: Map<string, Array<{ nodeId: string; portId: string }>>,
  loopInvariant: Set<string>,
  fusion: FusionResult,
  graphNodes: GraphNode[],
  graphEdges: GraphEdge[],
  model?: CAModel,
): RootCompileResult {
  // Some internal helpers in this function were written when `model` was unused
  // (named `_model`). Keep both names in scope for those references.
  const _model = model;

  // Sub-attribute-aware CompileContext, threaded through to each node's compile().
  // Nodes call `ctx.readAttrExpr(attrId, idxExpr)` instead of inlining
  // `r_<id>[idx]`, so reads of sub-attributes get wrapped with a parent-check
  // guard returning `undefinedValue` on mismatch. Regular attributes pass through.
  const ctx: CompileContext = {
    readAttrExpr(attrId, idxExpr, opts) {
      const buf: 'r' | 'w' = opts?.fromWriteBuffer ? 'w' : 'r';
      if (!model) return `${buf}_${attrId}[${idxExpr}]`;
      const attr = model.attributes.find(a => a.id === attrId);
      const info = subAttrInfo(attr, model);
      if (!info || !attr) return `${buf}_${attrId}[${idxExpr}]`;
      const undefLit = attrValueLiteralJS(attr, info.undefinedValue);
      const guard = parentMatchExprJS(info.parent, info.parentValues, idxExpr, buf);
      return `((${guard}) ? ${buf}_${attrId}[${idxExpr}] : ${undefLit})`;
    },
    parentMatchesExpr(attrId, idxExpr, opts) {
      const buf: 'r' | 'w' = opts?.fromWriteBuffer ? 'w' : 'r';
      if (!model) return null;
      const attr = model.attributes.find(a => a.id === attrId);
      const info = subAttrInfo(attr, model);
      if (!info) return null;
      return parentMatchExprJS(info.parent, info.parentValues, idxExpr, buf);
    },
    defaultValueLiteral(attrId) {
      if (!model) return '0';
      const attr = model.attributes.find(a => a.id === attrId);
      if (!attr) return '0';
      return attrValueLiteralJS(attr, attr.defaultValue);
    },
    is3d: model ? is3dModel(model) : false,  // 3D Grid CA: NI-codec nodes pick the 3-axis codec
    // "Skip Isolated Empty Cells": nIdx_<nbr> carries the COMPACT packed
    // per-slot offsets — neighbour readers decode inline (see CompileContext).
    inlineNbr: model ? sparseSteppingEnabled(model) : false,
    // Generic Agent Platform: tag the agent root so the by-id setters relax the
    // live-agent guard in the init context (staged agents are alive=0 until Add).
    agentRoot: rootNode.data.nodeType === 'agentInit' ? 'init'
      : rootNode.data.nodeType === 'behaviourStep' ? 'behaviour'
      : rootNode.data.nodeType === 'divisionEvent' ? 'division'
      : undefined,
    // Which GRAPH this root belongs to. Unlike `agentRoot` this also covers the
    // agent OUTPUT MAPPING root, so a universal node can tell "I'm compiling into
    // a per-agent function (agent ABI: `_fieldW`/`_fieldH`/`_fieldTotal`)" from
    // "I'm compiling into a per-cell function (`W`/`H`/`D` params)".
    agentGraph: AGENT_ROOT_TYPES.has(rootNode.data.nodeType),
    // P2 — the model's BOND attributes with their defaults already encoded to the
    // stored NUMBER. `bondAttrsOf` applies the Bonds-off + allowed-type filters, so
    // this list is exactly the `_bondAttr_<id>` ABI block; a node naming anything
    // outside it emits a literal instead of a dangling param reference.
    bondAttrs: model ? bondAttrsOf(model).map(a => ({ id: a.id, type: a.type, defaultValue: encodeAttrValue(a, a.defaultValue) })) : [],
    // P4 — the structural-request QUEUE stride the Form / Break / Rewire Bond
    // emitters bake. ONE source (`bondReqSlotsForModel`), shared with the store's
    // array shapes and the WASM / WebGPU layouts.
    bondReqSlots: model ? bondReqSlotsForModel(model) : 1,
    // C9 / STEP 4 — THE SAFETY CATCH. A gated-OFF group's ABI params are dropped,
    // so a node that would read one must emit the typed default (0) instead of a
    // dangling `_agentAge[idx]`. The gates are usage-widened, so this only ever
    // fires for a node the widening deliberately does not cover (a defensive
    // second line, not the primary mechanism).
    agentGates: model ? resolveAgentFieldGates(model) : undefined,
  };

  const compiled = new Set<string>();
  const valueLines: string[] = [];
  const preLoopValueLines: string[] = [];
  const scratchNodes: Array<{ scratchVarName: string; nbrId?: string; attrId?: string; initExpr?: string }> = [];

  // Sink-scope analysis: tells us, for every value node referenced in this
  // root's flow tree, the deepest scope where it can be emitted such that all
  // uses are dominated. Values whose LCA is CELL_TOP go to valueLines as
  // before; values whose LCA is a deeper scope go to branchValueLines and are
  // flushed by compileFlowChain at branch entry.
  const sinkAnalysis = analyzeSinkScopes({
    nodes: graphNodes,
    edges: graphEdges,
    rootNodeId: rootNode.id,
    rootFlowPortId: rootFlowPort,
  });
  const branchValueLines = new Map<ScopeId, string[]>();

  // "Volatile" values: transitive value-input consumers of any `getVariable`
  // node. These values read mutable per-cell state (Local Variables) that
  // is updated by SetVariable / SetArrayElement flow nodes elsewhere in the
  // same scope. Sink analysis would normally hoist them to the LCA-of-uses
  // scope and flush them at scope entry — but that's BEFORE the mutating
  // flow children run, so the read would see the variable's initial value
  // instead of the post-mutation value. We bypass sinkAnalysis for these
  // and emit them via `volatileHoist` instead: each volatile value is emitted
  // at the LCA flow scope of all its uses, immediately before the first flow
  // node there whose subtree references it — AFTER the mutating flow siblings
  // (so the read sees post-write state) and dominating every branch (so
  // multi-branch uses, e.g. across switch cases, all see one declaration).
  // Single-use volatiles resolve to their one consumer — identical to the old
  // inline behaviour. The `compiled` set still dedups so each chain emits once.
  //
  // Async read-after-write hazards (step / initEvent roots only): attribute /
  // orientation reads whose value is used after a write to the SAME attribute in
  // flow order. In async mode r_/w_ alias one buffer, so such a read must be
  // emitted at its use site (after the write), NOT hoisted by sink analysis.
  // Seed them into the volatile set so the existing machinery pins them. Empty
  // for sync mode and for inputColor/outputMapping roots (no single-buffer step
  // hazard) → byte-identical there.
  const isAsyncRoot = model?.properties.updateMode === 'asynchronous';
  // Bond-Graph Agents: the behaviour loop's own-attr reads alias the write
  // buffer in ASYNC agent mode (the default), and the engine buffers (velocity /
  // position / radius) are live in BOTH modes — so a behaviour read after a
  // matching write must pin at its use site exactly like the lattice async
  // hazard. The division event's w_ block aliases attrRead on every target
  // (division is JS-on-CPU everywhere), so it is ALWAYS eligible. The agent
  // WASM/WebGPU compilers seed the SAME analyzer into their volatile sets under
  // the SAME eligibility, keeping cross-target emission in lockstep.
  const agentAttrsAsync = model?.centerBased?.agentUpdateMode !== 'sync';
  const hazardEligible = (!!isAsyncRoot
    && (rootNode.data.nodeType === 'step' || rootNode.data.nodeType === 'initEvent'))
    || (rootNode.data.nodeType === 'behaviourStep' && agentAttrsAsync)
    || rootNode.data.nodeType === 'divisionEvent';
  const hazardReads = computeAsyncReadWriteHazards({
    nodeMap, inputToSource, inputToSources, flowOutputToTargets,
    rootNodeId: rootNode.id, rootFlowPortId: rootFlowPort, isAsync: hazardEligible,
  });
  // RNG DRAW ORDER — agent behaviour only. Evaluating an RNG node is a SIDE
  // EFFECT (it advances the shared `_rs` stream), so WHERE it is emitted decides
  // where the draw lands in that stream. The agent WASM/WebGPU compilers emit a
  // draw at its flow USE SITE; JS sink analysis would hoist one whose uses all
  // sit at agent-loop top into the pre-flow value block, ordered topologically.
  // A graph with a draw inside a branch and another after it therefore advanced
  // the stream in a DIFFERENT ORDER per target and every downstream decision
  // diverged (each target individually correct — only JS↔WASM bit-parity broke).
  // Seeding the RNG nodes into the volatile set routes them through
  // volatileHoist ("emit at the LCA flow scope, immediately before the consuming
  // flow node") = flow order, matching the other targets by construction.
  // Scoped to `behaviourStep`: it is the ONLY root the WASM/WebGPU agent
  // compilers emit (init / division / agent output mappings are JS-on-CPU on
  // every target, so they cannot diverge), and the CELL grid is already in
  // lockstep because its WASM/WebGPU compilers consume this same sink analysis.
  const rngSeeds: string[] = [];
  if (rootNode.data.nodeType === 'behaviourStep') {
    for (const n of graphNodes) if (isRngNode(n)) rngSeeds.push(n.id);
  }
  const volatileValues = computeVolatileValueClosure(
    graphNodes, inputToSource, inputToSources, [...hazardReads, ...rngSeeds],
  );
  const volatileHoist = computeVolatileHoist({
    nodeMap,
    inputToSource,
    inputToSources,
    flowOutputToTargets,
    rootNodeId: rootNode.id,
    rootFlowPortId: rootFlowPort,
    volatile: volatileValues,
  }).emitBefore;
  // Tracks the current compileFlowChain emit position so volatile values
  // can route inline. Set at the top of compileFlowChain and inside each
  // branch (then/else/body/case_N) recursion.
  let volatileEmitTarget: string[] | null = null;
  let volatileEmitIndent: string = '    ';
  // True only while force-emitting a volatile value (and its transitive value
  // inputs) before a flow node, per volatileHoist. In this window EVERY emission
  // — including a non-volatile input reachable ONLY through the volatile (e.g. a
  // getRandom feeding volatile arithmetic) — must land at the current flow
  // position, NOT its sink branch buffer (already flushed at branch entry) nor
  // cell-top. Without this the input is declared into a dead buffer and is
  // undefined at runtime in the branch that uses it.
  let forceVolatileCurrentScope = false;

  function routeValueEmit(nodeId: string, code: string): void {
    if ((forceVolatileCurrentScope || volatileValues.has(nodeId)) && volatileEmitTarget) {
      // A NON-volatile value dragged in by a force-emit whose own sink scope is
      // CELL_TOP is SHARED — its uses span sibling branches (or sit above them),
      // so pinning it at the current flow position declares it inside ONE branch
      // and every sibling reference is out of scope (`_v… is not defined`). It is
      // pure, so cell-top is always a valid dominating home, and `valueLines` is
      // assembled ABOVE flowLines — safe to push to mid-walk. Branch-scoped
      // inputs (the canonical case: a getRandom reachable only through volatile
      // arithmetic) keep the current position: their sink buffer was already
      // flushed at branch entry, and their single use is right here.
      const ownScope = sinkAnalysis.emitScope.get(nodeId);
      const shared = forceVolatileCurrentScope && !volatileValues.has(nodeId) && ownScope === CELL_TOP;
      if (!shared) {
        // Inline emit at the current flow-walk position. flowLines (or a
        // branch's accumulator) gets the line right where we are.
        volatileEmitTarget.push(volatileEmitIndent + code.trimEnd());
        return;
      }
    }
    let scope = sinkAnalysis.emitScope.get(nodeId) ?? CELL_TOP;
    // Agent field reads are a STEP-START SNAPSHOT on every target (D-FIELD
    // "sample before deposit"; the agent WASM hoist + WebGPU's fieldRead buffer
    // both read pre-deposit). Branch-sinking one on JS would let it see a
    // same-step deposit that flow-precedes the branch — a silent cross-target
    // divergence — so pin them at agent-loop top.
    if (ctx.agentRoot && scope !== CELL_TOP) {
      const t = nodeMap.get(nodeId)?.data.nodeType;
      if (t === 'sampleField' || t === 'fieldGradient' || t === 'readCellsUnder') scope = CELL_TOP;
    }
    if (scope === CELL_TOP) {
      valueLines.push('      ' + code.trimEnd());
      return;
    }
    let arr = branchValueLines.get(scope);
    if (!arr) { arr = []; branchValueLines.set(scope, arr); }
    // Stored unindented — flushBranchValues applies the indent that matches
    // the flow walk's actual position. This handles edge cases where the
    // analyzer's scope-depth count doesn't line up with the emit indent
    // (e.g., a transparent sequence collapsing one nesting level).
    arr.push(code.trimEnd());
  }
  function flushBranchValues(scope: ScopeId, target: string[], indent: string): void {
    const arr = branchValueLines.get(scope);
    if (!arr || arr.length === 0) return;
    for (const line of arr) target.push(indent + line);
    arr.length = 0;
  }

  // forEachInArray body-emit context. When non-null, value nodes whose ID is in
  // `bodyDependents` are emitted to `bodyTarget` (with `bodyIndent`) rather than to
  // the cell-scope `valueLines`, and tracked in `bodyCompiled` (a per-scope dedup set)
  // instead of the global `compiled` set. This keeps element-dependent computations
  // inside the for-loop block where `_v{forEachId}_element` is in scope.
  let bodyTarget: string[] | null = null;
  let bodyIndent: string = '';
  let bodyDependents: Set<string> | null = null;
  let bodyCompiled: Set<string> = new Set();

  /** Forward-BFS from `(forEachNodeId, 'element')` AND `(forEachNodeId, 'index')`
   *  through value-input consumers. Returns the transitive closure of value
   *  nodes whose computation depends on either iteration variable. Without
   *  walking BOTH ports, value nodes that only read the loop counter (e.g.
   *  ArrayElement[index] on parallel arrays) land in cell-top scope and
   *  reference an undeclared loop-counter variable at runtime. */
  function findElementDependents(forEachNodeId: string, seedPorts: string[] = ['element', 'index']): Set<string> {
    const result = new Set<string>();
    const queue: Array<{ nodeId: string; portId: string }> = seedPorts.map(p => ({ nodeId: forEachNodeId, portId: p }));
    while (queue.length > 0) {
      const src = queue.shift()!;
      const enqueueConsumer = (consumerId: string) => {
        if (result.has(consumerId)) return;
        result.add(consumerId);
        const consumerNode = nodeMap.get(consumerId);
        const consumerDef = consumerNode ? getNodeDef(consumerNode.data.nodeType) : null;
        const outPorts = new Set<string>();
        if (consumerDef) {
          for (const port of consumerDef.ports) {
            if (port.kind === 'output' && port.category === 'value') outPorts.add(port.id);
          }
        }
        // Dynamic value-output ports (e.g. MACRO outputs) aren't in def.ports —
        // discover the consumer's actual output ports from the edge map so the
        // BFS can traverse THROUGH a macro to whatever consumes its output.
        // Without this, a value reached only via a macro never lands in the
        // element-dependent set and gets hoisted out of the forEach loop.
        for (const [, source] of inputToSource) {
          if (source.nodeId === consumerId) outPorts.add(source.portId);
        }
        for (const [, sources] of inputToSources) {
          for (const s of sources) if (s.nodeId === consumerId) outPorts.add(s.portId);
        }
        for (const portId of outPorts) queue.push({ nodeId: consumerId, portId });
      };
      for (const [key, source] of inputToSource) {
        if (source.nodeId === src.nodeId && source.portId === src.portId) {
          const cid = key.split(':')[0];
          if (cid) enqueueConsumer(cid);
        }
      }
      for (const [key, sources] of inputToSources) {
        for (const s of sources) {
          if (s.nodeId === src.nodeId && s.portId === src.portId) {
            const cid = key.split(':')[0];
            if (cid) enqueueConsumer(cid);
            break;
          }
        }
      }
    }
    return result;
  }

  function varName(sourceNodeId: string, sourcePortId: string): string {
    const sourceNode = nodeMap.get(sourceNodeId);
    if (sourceNode && isMultiOutput(sourceNode.data)) {
      return `_v${sourceNodeId}_${sourcePortId}`;
    }
    // GetNeighborsAttribute uses _scr_ prefix for its scratch array
    if (sourceNode?.data.nodeType === 'getNeighborsAttribute') {
      return `_scr_${sourceNodeId}`;
    }
    // GetNeighborsAttrByIndexes uses _v{id}_vals scratch array
    if (sourceNode?.data.nodeType === 'getNeighborsAttrByIndexes') {
      return `_v${sourceNodeId}_vals`;
    }
    // Generic Agent Platform: Get Agents Attribute gathers into _v{id}_vals too.
    if (sourceNode?.data.nodeType === 'getAgentsAttribute') {
      return `_v${sourceNodeId}_vals`;
    }
    // InteractionTableMap also outputs to _v{id}_vals
    if (sourceNode?.data.nodeType === 'interactionTableMap') {
      return `_v${sourceNodeId}_vals`;
    }
    // FilterNeighbors and JoinNeighbors are multi-output (result + count) —
    // caught by the isMultiOutput branch above; both ports resolve via
    // `_v<id>_<port>`.
    // ForEachInArray exposes the per-iteration element via the 'element' output port.
    // Inside the body chain, references resolve to _v{id}_element (declared at the top
    // of each iteration in compileFlowChain). Outside the body, references would be
    // unresolved — the type system does not currently catch this, but the body-only
    // scope is enforced by where compileFlowChain places the declaration.
    if (sourceNode?.data.nodeType === 'forEachInArray' && sourcePortId === 'element') {
      return `_v${sourceNodeId}_element`;
    }
    // Same scope rules: the loop counter is declared as `_fei<id>` at the top
    // of each iteration in compileFlowChain. Exposing it lets body-side nodes
    // index into parallel arrays (kindsArr / farKindsArr / etc.) by the
    // current iteration's slot.
    if (sourceNode?.data.nodeType === 'forEachInArray' && sourcePortId === 'index') {
      return `_fei${sourceNodeId}`;
    }
    // Loop's per-iteration counter — declared as `_li<id>` by the for statement
    // in compileFlowChain, in scope only inside the BODY chain (same scope rules
    // as forEachInArray's element/index above).
    if (sourceNode?.data.nodeType === 'loop' && sourcePortId === 'index') {
      return `_li${sourceNodeId}`;
    }
    // pickNRandomNeighbors / pickNRandomAgents write to the _result scratch array
    // (the _work scratch is internal and never read by downstream nodes).
    if (sourceNode?.data.nodeType === 'pickNRandomNeighbors' || sourceNode?.data.nodeType === 'pickNRandomAgents') {
      return `_v${sourceNodeId}_result`;
    }
    return `_v${sourceNodeId}`;
  }

  // Does a given source (node + output port) yield an ARRAY value in JS? True
  // for a static `isArray` output port (filterNeighbors, getAllNeighborIndexes,
  // …), an array-kind getVariable, OR a valueSwitch whose BOTH branches yield
  // arrays (the dual-mode relay — its `result` port is scalar-typed but holds
  // the selected branch array). Used by the isArray-input resolution to decide
  // pass-through vs wrap-in-1-element-array. Memoised + cycle-guarded; mirrors
  // the WASM/WebGPU `ctx.producesArray` (compiler/arrayRelay.ts) — JS stays
  // port-based here because its array-ness is per-port, not per-nodeType.
  const arrayRelayMemo = new Map<string, boolean>();
  function sourceYieldsArray(srcNodeId: string, srcPortId: string): boolean {
    const srcNode = nodeMap.get(srcNodeId);
    if (!srcNode) return false;
    const srcDef = getNodeDef(srcNode.data.nodeType);
    const srcPort = srcDef?.ports.find(p => p.id === srcPortId);
    if (srcPort?.isArray) return true;
    if (srcNode.data.nodeType === 'getVariable') {
      // Look up in BOTH the cell (model.variables) and agent (model.agentVariables)
      // scopes: a getVariable on the AGENT graph references an agentVariable, and
      // variable ids are globally unique so the combined lookup is unambiguous.
      // Without the agentVariables arm an agent Local-Variable ARRAY was treated as
      // a scalar and wrapped as `[_v]`, so Get Array Element / Array Length could
      // not index it (element 0 returned the whole array, element ≥1 returned 0).
      const vid = srcNode.data.config.variableId;
      const v = (_model?.variables || []).find(x => x.id === vid)
        || (_model?.agentVariables || []).find(x => x.id === vid);
      return v?.kind === 'array';
    }
    if (srcNode.data.nodeType === 'valueSwitch') {
      const cached = arrayRelayMemo.get(srcNodeId);
      if (cached !== undefined) return cached;
      arrayRelayMemo.set(srcNodeId, false); // cycle guard
      const ifS = inputToSource.get(`${srcNodeId}:ifValue`);
      const elS = inputToSource.get(`${srcNodeId}:elseValue`);
      const r = !!ifS && !!elS
        && sourceYieldsArray(ifS.nodeId, ifS.portId)
        && sourceYieldsArray(elS.nodeId, elS.portId);
      arrayRelayMemo.set(srcNodeId, r);
      return r;
    }
    return false;
  }

  function compileValueNode(nodeId: string): string {
    const isBodyDep = !!(bodyDependents && bodyDependents.has(nodeId));
    if (isBodyDep) {
      // Body-dependent value: dedup against the per-scope `bodyCompiled` set so the
      // emit appears at most once per body, but DON'T touch the global `compiled` set
      // (the variable is block-scoped to the for-loop body — a cell-scope re-emit
      // would still need its own copy).
      // Also short-circuit when the node has already been emitted via the
      // sinkAnalysis path at forEachBody scope (its branchValueLines flush
      // already produced the const declaration inside the loop) — without
      // this guard the body-dep emit duplicates the line.
      if (bodyCompiled.has(nodeId) || compiled.has(nodeId)) return `_v${nodeId}`;
      bodyCompiled.add(nodeId);
    } else {
      if (compiled.has(nodeId)) return `_v${nodeId}`;
      compiled.add(nodeId);
    }

    const node = nodeMap.get(nodeId);
    if (!node) return 'undefined';
    const def = getNodeDef(node.data.nodeType);
    if (!def) return 'undefined';

    if (node.data.nodeType === 'inputColor') {
      return `_v${nodeId}`;
    }

    // Fused getNeighborsAttribute source: a single downstream aggregate has
    // absorbed both the gather AND the reduce into one inlined loop. Skip
    // scratch declaration and emit nothing here — the aggregate's emitter
    // produces the fused code under its own variable name.
    if (node.data.nodeType === 'getNeighborsAttribute' && fusion.skippedGather.has(nodeId)) {
      return `_v${nodeId}`;
    }

    // Fused neighborhood consumer (aggregate / groupOperator / groupCounting /
    // groupStatement): emit ONE inlined loop that gathers + reduces in a single
    // pass over the neighborhood. Bypasses the normal compile() path (which
    // would consume `_scr_<srcId>` from the now-skipped gather). The fusion
    // detector (fusion.ts) decides which consumer types and ops are eligible
    // and whether the indexes output is wired (refused for groupCounting/
    // groupStatement). Per-type builders match the variable-naming contract
    // varName() expects so downstream consumers find the same identifiers.
    const fused = fusion.fusedConsumers.get(nodeId);
    if (fused) {
      const srcNode = nodeMap.get(fused.sourceId);
      if (srcNode) {
        const nbrId = (srcNode.data.config.neighborhoodId as string) || '_undef';
        const attrId = (srcNode.data.config.attributeId as string) || '_undef';
        // Helper to resolve a non-`values` scalar input (compare, compareHigh,
        // x). Mirrors the resolution path the normal input loop uses below.
        const resolveScalarInput = (portId: string): string | undefined => {
          const source = inputToSource.get(`${nodeId}:${portId}`);
          if (source) {
            compileValueNode(source.nodeId);
            return varName(source.nodeId, source.portId);
          }
          const port = def.ports.find(p => p.id === portId);
          if (!port) return undefined;
          return getInlineValue(port, node.data.config);
        };
        let code: string | undefined;
        if (fused.consumerType === 'aggregate') {
          code = buildFusedAggregateJS(nodeId, fused.op, nbrId, attrId);
        } else if (fused.consumerType === 'groupOperator') {
          code = buildFusedGroupOperatorJS(nodeId, fused.op, nbrId, attrId);
        } else if (fused.consumerType === 'groupCounting') {
          const compareVar = resolveScalarInput('compare') ?? '0';
          const compareHighVar = resolveScalarInput('compareHigh') ?? '0';
          const lowOp = (node.data.config.lowOp as string) === '>' ? '>' : '>=';
          const highOp = (node.data.config.highOp as string) === '<' ? '<' : '<=';
          code = buildFusedGroupCountingJS(nodeId, fused.op, nbrId, attrId, compareVar, compareHighVar, lowOp, highOp);
        } else if (fused.consumerType === 'groupStatement') {
          const xVar = resolveScalarInput('x') ?? '0';
          code = buildFusedGroupStatementJS(nodeId, fused.op, nbrId, attrId, xVar);
        }
        if (code) {
          routeValueEmit(nodeId, code);
          return `_v${nodeId}`;
        }
      }
    }

    // Track GetNeighborsAttribute nodes for scratch declaration
    if (node.data.nodeType === 'getNeighborsAttribute') {
      const nbrId = node.data.config.neighborhoodId as string || '_undef';
      const attrId = node.data.config.attributeId as string || undefined;
      scratchNodes.push({ scratchVarName: `_scr_${nodeId}`, nbrId, attrId });
    }
    // Track aggregation nodes that need reusable scratch arrays (only when indexes output is connected)
    let needsIndexes = false;
    if (node.data.nodeType === 'groupStatement' || node.data.nodeType === 'groupCounting') {
      // Check if any downstream node reads the indexes output
      for (const [, src] of inputToSource) {
        if (src.nodeId === nodeId && src.portId === 'indexes') { needsIndexes = true; break; }
      }
    }
    if (needsIndexes) {
      scratchNodes.push({ scratchVarName: `_v${nodeId}_indexes`, initExpr: '[]' });
    }
    if (node.data.nodeType === 'getNeighborsAttrByIndexes' || node.data.nodeType === 'interactionTableMap'
        || node.data.nodeType === 'getAgentsAttribute') {
      scratchNodes.push({ scratchVarName: `_v${nodeId}_vals`, initExpr: '[]' });
    }
    if (node.data.nodeType === 'filterNeighbors' || node.data.nodeType === 'filterAgents') {
      scratchNodes.push({ scratchVarName: `_v${nodeId}_result`, initExpr: '[]' });
    }
    if (node.data.nodeType === 'joinNeighbors' || node.data.nodeType === 'joinAgents') {
      scratchNodes.push({ scratchVarName: `_v${nodeId}_result`, initExpr: '[]' });
    }
    if (node.data.nodeType === 'pickNRandomNeighbors' || node.data.nodeType === 'pickNRandomAgents') {
      scratchNodes.push({ scratchVarName: `_v${nodeId}_work`, initExpr: '[]' });
      scratchNodes.push({ scratchVarName: `_v${nodeId}_result`, initExpr: '[]' });
    }
    // Variegated: multi-output array node — length 8 (Moore) or 4 (cardinals
    // only). Use typed Int32Array for the cache-friendly access shape that
    // downstream Aggregate / ForEach consumers benefit from.
    if (node.data.nodeType === 'getAllFacingLabels') {
      const len = node.data.config?.cardinalsOnly ? 4 : 8;
      scratchNodes.push({ scratchVarName: `_v${nodeId}_myFaceLabels`, initExpr: `new Int32Array(${len})` });
      scratchNodes.push({ scratchVarName: `_v${nodeId}_theirFaceLabels`, initExpr: `new Int32Array(${len})` });
    }

    const inputVars: Record<string, string> = {};
    for (const port of def.ports) {
      if (port.kind !== 'input' || port.category !== 'value') continue;
      // Multi-input support for isArray ports (e.g., Aggregate node).
      // - sources.length > 1: build a JS array literal of each source's varName.
      // - sources.length === 1: pass the source's varName directly. If the source's
      //   own output port is also `isArray` (e.g. filterNeighbors → aggregate), the
      //   varName resolves to a typed-array / scratch-array name and downstream
      //   array-shape consumers iterate over it correctly. If the source is
      //   scalar (e.g. getCellAttribute → aggregate), wrap in a 1-element array
      //   literal so consumers that do `.length` / `for (i<len)` see length 1
      //   instead of `undefined` — without this wrap, single-scalar aggregate
      //   silently returned the op's identity value (0 for sum, etc.). This
      //   mirrors WASM's emitScalarAggregate behaviour where N=1 already works.
      const sources = inputToSources.get(`${nodeId}:${port.id}`);
      if (port.isArray && sources && sources.length > 1) {
        for (const s of sources) compileValueNode(s.nodeId);
        inputVars[port.id] = `[${sources.map(s => varName(s.nodeId, s.portId)).join(', ')}]`;
      } else {
        const source = inputToSource.get(`${nodeId}:${port.id}`);
        if (source) {
          compileValueNode(source.nodeId);
          const srcName = varName(source.nodeId, source.portId);
          if (port.isArray) {
            // sourceYieldsArray covers: a static isArray output port; an
            // array-kind getVariable (its `_var_<id>` local IS a typed array);
            // and a valueSwitch array relay (its scalar-typed `result` holds the
            // selected branch array). Pass those through; wrap a true scalar
            // source in a 1-element array literal so `.length` / `for (i<len)`
            // see length 1 instead of `undefined`.
            const srcIsArray = sourceYieldsArray(source.nodeId, source.portId);
            inputVars[port.id] = srcIsArray ? srcName : `[${srcName}]`;
          } else {
            inputVars[port.id] = srcName;
          }
        } else {
          const inlineVal = getInlineValue(port, node.data.config);
          if (inlineVal !== undefined) inputVars[port.id] = inlineVal;
        }
      }
    }

    // For aggregation nodes, pass whether indexes output is connected (for optimization)
    let compileConfig = (node.data.nodeType === 'groupStatement' || node.data.nodeType === 'groupCounting')
      ? { ...node.data.config, _indexesConnected: needsIndexes }
      : node.data.config;
    // Sense Hemifield is a CONDITIONAL array producer: it emits an id array only
    // for a side some consumer reads (`hemifieldArraysUsed`, derived from the flat
    // edge list — the SAME predicate the WASM/WebGPU emitters, the WebGPU
    // array-producer budget and the slot assignment use, so the three targets can
    // never disagree). Unconsumed ⇒ nothing emitted ⇒ byte-identical to the
    // pre-arrays code.
    if (node.data.nodeType === 'senseHemifield') {
      const used = hemifieldArraysUsed(nodeId, graphEdges);
      compileConfig = { ...compileConfig, _leftAgentsUsed: used.left, _rightAgentsUsed: used.right };
    }
    const code = def.compile(nodeId, compileConfig, inputVars, model?.properties.boundaryTreatment, ctx);
    if (code) {
      // Loop-invariant nodes (e.g. modelAttrs reads + arithmetic over them)
      // hoist out of the cell loop and emit once per step instead of per cell.
      // Indentation for preLoopValueLines is two spaces because they live at
      // function scope, not inside the four-space cell loop body.
      // Body-dependent nodes (inside a forEachInArray) emit to bodyTarget at
      // bodyIndent so they sit inside the for-loop block where the iteration
      // element variable is in scope.
      if (isBodyDep && bodyTarget) {
        bodyTarget.push(bodyIndent + code.trimEnd());
      } else if (loopInvariant.has(nodeId)) {
        preLoopValueLines.push('  ' + code.trimEnd());
      } else {
        routeValueEmit(nodeId, code);
      }
    }

    return `_v${nodeId}`;
  }

  function collectValueDeps(nodeId: string): void {
    const node = nodeMap.get(nodeId);
    if (!node) return;
    const def = getNodeDef(node.data.nodeType);
    if (!def) return;

    for (const port of def.ports) {
      if (port.kind !== 'input' || port.category !== 'value') continue;
      const source = inputToSource.get(`${nodeId}:${port.id}`);
      if (source && !volatileValues.has(source.nodeId)) compileValueNode(source.nodeId);
    }
    // Switch's case_N_cond and case_N_val value inputs are dynamic — not in
    // def.ports. Iterate edge map directly so their sources get pre-compiled
    // alongside the static value inputs.
    for (const [key, source] of inputToSource) {
      if (!key.startsWith(`${nodeId}:`)) continue;
      const portId = key.slice(nodeId.length + 1);
      // Skip ports we already handled via def.ports.
      if (def.ports.some(p => p.kind === 'input' && p.category === 'value' && p.id === portId)) continue;
      if (volatileValues.has(source.nodeId)) continue;
      compileValueNode(source.nodeId);
    }

    // Iterate ALL flow output edges from this node (including dynamic case_N
    // ports on switch). Using def.ports alone misses dynamic ports, which left
    // values referenced inside switch cases uncompiled-until-flow-walk-time —
    // breaking the sink-flush invariant (flushes happen BEFORE recursion, so
    // any compileValueNode call from inside compileFlowChain's case dispatch
    // would route to a branch whose flush already fired).
    for (const [key, targets] of flowOutputToTargets) {
      if (!key.startsWith(`${nodeId}:`)) continue;
      for (const t of targets) collectValueDeps(t.nodeId);
    }
  }

  collectValueDeps(rootNode.id);

  const flowLines: string[] = [];

  function compileFlowChain(sourceNodeId: string, sourcePortId: string, indent: string): void {
    const targets = flowOutputToTargets.get(`${sourceNodeId}:${sourcePortId}`);
    if (!targets || targets.length === 0) return;

    // Volatile values (transitively reading getVariable) emit inline at the
    // current flow-walk position. Save/restore the closure variables so
    // nested compileFlowChain calls inside Conditionals / ForEachInArray
    // bodies route to the right indent.
    const savedVolatileTarget = volatileEmitTarget;
    const savedVolatileIndent = volatileEmitIndent;
    volatileEmitTarget = flowLines;
    volatileEmitIndent = indent;

    for (const target of targets) {
      const node = nodeMap.get(target.nodeId);
      if (!node) continue;
      const def = getNodeDef(node.data.nodeType);
      if (!def) continue;

      // Volatile values whose LCA flow scope is here: emit them before this
      // flow node so they land after preceding sibling writes and dominate
      // every branch this node opens (fixes multi-branch getVariable reads).
      const hoisted = volatileHoist.get(target.nodeId);
      if (hoisted) {
        const savedForce = forceVolatileCurrentScope;
        forceVolatileCurrentScope = true;
        for (const vId of hoisted) compileValueNode(vId);
        forceVolatileCurrentScope = savedForce;
      }

      if (node.data.nodeType === 'conditional') {
        const condSource = inputToSource.get(`${node.id}:condition`);
        let condVar: string;
        if (condSource) {
          compileValueNode(condSource.nodeId);
          condVar = varName(condSource.nodeId, condSource.portId);
        } else {
          const condPort = def.ports.find(p => p.id === 'condition');
          const inlineVal = condPort ? getInlineValue(condPort, node.data.config) : undefined;
          condVar = inlineVal ?? 'false';
        }
        const hasElse = flowOutputToTargets.has(`${node.id}:else`);
        flowLines.push(`${indent}if (${condVar}) {`);
        flushBranchValues(`${node.id}:then`, flowLines, indent + '  ');
        compileFlowChain(node.id, 'then', indent + '  ');
        if (hasElse) {
          flowLines.push(`${indent}} else {`);
          flushBranchValues(`${node.id}:else`, flowLines, indent + '  ');
          compileFlowChain(node.id, 'else', indent + '  ');
        }
        flowLines.push(`${indent}}`);
      } else if (node.data.nodeType === 'sequence') {
        compileFlowChain(node.id, 'first', indent);
        compileFlowChain(node.id, 'then', indent);
        const extra = Number(node.data.config.extraCount) || 0;
        for (let si = 2; si < 2 + extra; si++) {
          compileFlowChain(node.id, `then_${si}`, indent);
        }
      } else if (node.data.nodeType === 'loop') {
        const resolveLoopInput = (portId: string, dflt: string): string => {
          const source = inputToSource.get(`${node.id}:${portId}`);
          if (source) {
            compileValueNode(source.nodeId);
            return varName(source.nodeId, source.portId);
          }
          const port = def.ports.find(p => p.id === portId);
          const inlineVal = port ? getInlineValue(port, node.data.config) : undefined;
          return inlineVal ?? dflt;
        };
        if (node.data.config.mode === 'range') {
          // Range mode: the counter runs From..To INCLUSIVE (ascending; empty
          // when From > To). `| 0` truncates like the WASM/WebGPU i32 casts so
          // fractional inputs stay in cross-target lockstep. The bound is
          // captured in a second `let` so a volatile To isn't re-read mid-loop.
          const fromVar = resolveLoopInput('from', '0');
          const toVar = resolveLoopInput('to', '0');
          flowLines.push(`${indent}for (let _li${node.id} = (${fromVar}) | 0, _liEnd${node.id} = (${toVar}) | 0; _li${node.id} <= _liEnd${node.id}; _li${node.id}++) {`);
        } else {
          const countVar = resolveLoopInput('count', '0');
          flowLines.push(`${indent}for (let _li${node.id} = 0; _li${node.id} < ${countVar}; _li${node.id}++) {`);
        }
        flushBranchValues(`${node.id}:body`, flowLines, indent + '  ');
        // Body-emit context (mirrors forEachInArray): value nodes depending on
        // the loop's `index` output that are compiled lazily during the body
        // walk must land INSIDE the for block where `_li<id>` is in scope.
        {
          const savedTarget = bodyTarget;
          const savedIndent = bodyIndent;
          const savedDeps = bodyDependents;
          const savedCompiled = bodyCompiled;
          const ownDeps = findElementDependents(node.id, ['index']);
          bodyDependents = new Set([...(savedDeps ?? []), ...ownDeps]);
          bodyTarget = flowLines;
          bodyIndent = indent + '  ';
          bodyCompiled = new Set(savedCompiled);
          compileFlowChain(node.id, 'body', indent + '  ');
          bodyTarget = savedTarget;
          bodyIndent = savedIndent;
          bodyDependents = savedDeps;
          bodyCompiled = savedCompiled;
        }
        flowLines.push(`${indent}}`);
      } else if (node.data.nodeType === 'forEachInArray') {
        const arraySource = inputToSource.get(`${node.id}:array`);
        if (!arraySource) {
          // No array wired; body is unreachable, skip.
          continue;
        }
        compileValueNode(arraySource.nodeId);
        const arrayVar = varName(arraySource.nodeId, arraySource.portId);
        const idxVar = `_fei${node.id}`;
        const elementVar = `_v${node.id}_element`;
        flowLines.push(`${indent}for (let ${idxVar} = 0; ${idxVar} < ${arrayVar}.length; ${idxVar}++) {`);
        flowLines.push(`${indent}  const ${elementVar} = ${arrayVar}[${idxVar}];`);
        flushBranchValues(`${node.id}:body`, flowLines, indent + '  ');
        // Activate body-emit context so element-dependent value nodes consumed
        // inside the body land in flowLines at body indent (inside the loop block,
        // where elementVar is in scope) rather than in cell-scope valueLines.
        // Save/restore supports nested forEachInArray.
        const savedTarget = bodyTarget;
        const savedIndent = bodyIndent;
        const savedDeps = bodyDependents;
        const savedCompiled = bodyCompiled;
        const ownDeps = findElementDependents(node.id);
        // Merge with any outer body's dependents — a value chain can be dependent
        // on multiple nested elements; either-scope dependents emit at the inner-
        // most body that sees them.
        bodyDependents = new Set([...(savedDeps ?? []), ...ownDeps]);
        bodyTarget = flowLines;
        bodyIndent = indent + '  ';
        bodyCompiled = new Set(savedCompiled);
        compileFlowChain(node.id, 'body', indent + '  ');
        bodyTarget = savedTarget;
        bodyIndent = savedIndent;
        bodyDependents = savedDeps;
        bodyCompiled = savedCompiled;
        flowLines.push(`${indent}}`);
      } else if (node.data.nodeType === 'forEachBond') {
        // Bond-Graph Agents: iterate the current agent's ragged bond list. No
        // array input — the bonds come from the engine store via the agent loop
        // params. Per-iteration value-outs: partnerId / restLength / currentLength
        // / index. currentLength uses the torus-SHORTEST displacement (the "any
        // node subtracting two agent positions routes through the offset wrap"
        // invariant — a seam-straddling bond otherwise reads ≈ W − actual and
        // "break over-strained bonds" severs every seam bond) + the z arm in 3D.
        // Length = Math.sqrt(dx*dx + dy*dy [+ dz*dz]) — NOT Math.hypot (correctly-
        // rounded, ULP-different from the WASM f64.sqrt-of-squared-sum; same
        // associativity as agentWasm's forEachBond emit keeps JS↔WASM bit-parity).
        const feb = `_feb${node.id}`;
        const base = `_bb${node.id}`;
        const pid = `_v${node.id}_partnerId`;
        const dbx = `_dbx${node.id}`, dby = `_dby${node.id}`, dbz = `_dbz${node.id}`;
        flowLines.push(`${indent}for (let ${feb} = 0; ${feb} < _agentBondCount[idx]; ${feb}++) {`);
        flowLines.push(`${indent}  const ${base} = idx * maxBonds + ${feb};`);
        flowLines.push(`${indent}  const ${pid} = _bondPartner[${base}];`);
        flowLines.push(`${indent}  const _v${node.id}_restLength = _bondRestLength[${base}];`);
        if (ctx.is3d) {
          flowLines.push(`${indent}  let ${dbx} = _agentX[${pid}] - _agentX[idx], ${dby} = _agentY[${pid}] - _agentY[idx], ${dbz} = _agentZ[${pid}] - _agentZ[idx];`);
          flowLines.push(`${indent}  if (_fieldBoundaryTorus) { const __hW = _fieldW/2, __hH = _fieldH/2, __hD = _fieldD/2;`
            + ` if (${dbx} > __hW) ${dbx} -= _fieldW; else if (${dbx} < -__hW) ${dbx} += _fieldW;`
            + ` if (${dby} > __hH) ${dby} -= _fieldH; else if (${dby} < -__hH) ${dby} += _fieldH;`
            + ` if (${dbz} > __hD) ${dbz} -= _fieldD; else if (${dbz} < -__hD) ${dbz} += _fieldD; }`);
          flowLines.push(`${indent}  const _v${node.id}_currentLength = Math.sqrt(${dbx} * ${dbx} + ${dby} * ${dby} + ${dbz} * ${dbz});`);
        } else {
          flowLines.push(`${indent}  let ${dbx} = _agentX[${pid}] - _agentX[idx], ${dby} = _agentY[${pid}] - _agentY[idx];`);
          flowLines.push(`${indent}  if (_fieldBoundaryTorus) { const __hW = _fieldW/2, __hH = _fieldH/2;`
            + ` if (${dbx} > __hW) ${dbx} -= _fieldW; else if (${dbx} < -__hW) ${dbx} += _fieldW;`
            + ` if (${dby} > __hH) ${dby} -= _fieldH; else if (${dby} < -__hH) ${dby} += _fieldH; }`);
          flowLines.push(`${indent}  const _v${node.id}_currentLength = Math.sqrt(${dbx} * ${dbx} + ${dby} * ${dby});`);
        }
        flowLines.push(`${indent}  const _v${node.id}_index = ${feb};`);
        flushBranchValues(`${node.id}:body`, flowLines, indent + '  ');
        const savedTarget = bodyTarget;
        const savedIndent = bodyIndent;
        const savedDeps = bodyDependents;
        const savedCompiled = bodyCompiled;
        const ownDeps = findElementDependents(node.id, ['partnerId', 'restLength', 'currentLength', 'index']);
        bodyDependents = new Set([...(savedDeps ?? []), ...ownDeps]);
        bodyTarget = flowLines;
        bodyIndent = indent + '  ';
        bodyCompiled = new Set(savedCompiled);
        compileFlowChain(node.id, 'body', indent + '  ');
        bodyTarget = savedTarget;
        bodyIndent = savedIndent;
        bodyDependents = savedDeps;
        bodyCompiled = savedCompiled;
        flowLines.push(`${indent}}`);
      } else if (node.data.nodeType === 'createAgent') {
        // Generic Agent Platform: Create Agent is a flow node with a VALUE output
        // (`handle`) consumed by sibling flow nodes (Add Agent To World, the by-id
        // setters) — like forEachBond's value-outs. Declare it at the flow position
        // so it's in scope downstream: `const _v<id>_handle = _agentCreate(x,y,z,r)`.
        // `_agentCreate` is a host closure (init params); it allocs + stages a slot.
        // z defaults to '0' (the inline default) in 2D, where the Z input is hidden.
        const inP = (pid: string, dflt: string): string => {
          const s = inputToSource.get(`${node.id}:${pid}`);
          if (s) { compileValueNode(s.nodeId); return varName(s.nodeId, s.portId); }
          const port = def.ports.find(p => p.id === pid);
          const inline = port ? getInlineValue(port, node.data.config) : undefined;
          return inline ?? dflt;
        };
        flowLines.push(`${indent}const _v${node.id}_handle = _agentCreate(${inP('x', '0')}, ${inP('y', '0')}, ${inP('z', '0')}, ${inP('radius', '1')});`);
      } else if (node.data.nodeType === 'switch') {
        const switchMode = (node.data.config.mode as string) || 'conditions';
        const firstMatchOnly = node.data.config.firstMatchOnly !== false;
        const valType = (node.data.config.valueType as string) || 'integer';
        const caseCount = Number(node.data.config.caseCount) || 0;
        const hasDefault = flowOutputToTargets.has(`${node.id}:default`);

        if (caseCount === 0) {
          compileFlowChain(node.id, 'default', indent);
        } else {
          // Build condition expressions for each case
          const caseConditions: string[] = [];
          for (let ci = 0; ci < caseCount; ci++) {
            if (switchMode === 'conditions') {
              // Read bool condition input
              const condSource = inputToSource.get(`${node.id}:case_${ci}_cond`);
              if (condSource) {
                compileValueNode(condSource.nodeId);
                caseConditions.push(varName(condSource.nodeId, condSource.portId));
              } else {
                const condVal = (node.data.config[`_port_case_${ci}_cond`] as string);
                caseConditions.push(condVal === 'true' ? '1' : '0');
              }
            } else {
              // "by value" mode — resolve value input and build comparison
              const valSource = inputToSource.get(`${node.id}:value`);
              let valVar: string;
              if (valSource) {
                compileValueNode(valSource.nodeId);
                valVar = varName(valSource.nodeId, valSource.portId);
              } else {
                const valPort = def.ports.find(p => p.id === 'value');
                const inlineVal = valPort ? getInlineValue(valPort, node.data.config) : undefined;
                valVar = inlineVal ?? '0';
              }
              if (valType === 'tag') {
                // Tag: equality against tag index
                const tagIdx = (node.data.config[`case_${ci}_value`] as string) || '0';
                caseConditions.push(`(${valVar} === ${tagIdx})`);
              } else {
                // Int/Float: configurable comparison op
                const op = (node.data.config[`case_${ci}_op`] as string) || '==';
                const jsOp = op === '==' ? '===' : op === '!=' ? '!==' : op;
                const caseValSource = inputToSource.get(`${node.id}:case_${ci}_val`);
                let caseValVar: string;
                if (caseValSource) {
                  compileValueNode(caseValSource.nodeId);
                  caseValVar = varName(caseValSource.nodeId, caseValSource.portId);
                } else {
                  caseValVar = (node.data.config[`_port_case_${ci}_val`] as string)
                    ?? (node.data.config[`case_${ci}_value`] as string) ?? '0';
                }
                caseConditions.push(`(${valVar} ${jsOp} ${caseValVar})`);
              }
            }
          }

          if (firstMatchOnly) {
            // if / else-if chain
            for (let ci = 0; ci < caseCount; ci++) {
              const prefix = ci === 0 ? 'if' : '} else if';
              flowLines.push(`${indent}${prefix} (${caseConditions[ci]}) {`);
              flushBranchValues(`${node.id}:case_${ci}`, flowLines, indent + '  ');
              compileFlowChain(node.id, `case_${ci}`, indent + '  ');
            }
            if (hasDefault) {
              flowLines.push(`${indent}} else {`);
              flushBranchValues(`${node.id}:default`, flowLines, indent + '  ');
              compileFlowChain(node.id, 'default', indent + '  ');
            }
            flowLines.push(`${indent}}`);
          } else {
            // All matches: independent if blocks + default guard
            flowLines.push(`${indent}let _sw${node.id} = false;`);
            for (let ci = 0; ci < caseCount; ci++) {
              flowLines.push(`${indent}if (${caseConditions[ci]}) { _sw${node.id} = true;`);
              flushBranchValues(`${node.id}:case_${ci}`, flowLines, indent + '  ');
              compileFlowChain(node.id, `case_${ci}`, indent + '  ');
              flowLines.push(`${indent}}`);
            }
            if (hasDefault) {
              flowLines.push(`${indent}if (!_sw${node.id}) {`);
              flushBranchValues(`${node.id}:default`, flowLines, indent + '  ');
              compileFlowChain(node.id, 'default', indent + '  ');
              flowLines.push(`${indent}}`);
            }
          }
        }
      } else {
        const inputVars: Record<string, string> = {};
        for (const port of def.ports) {
          if (port.kind !== 'input' || port.category !== 'value') continue;
          const source = inputToSource.get(`${node.id}:${port.id}`);
          if (source) {
            compileValueNode(source.nodeId);
            inputVars[port.id] = varName(source.nodeId, source.portId);
          } else {
            const inlineVal = getInlineValue(port, node.data.config);
            if (inlineVal !== undefined) inputVars[port.id] = inlineVal;
          }
        }
        // Dynamic per-slot value-input ports (not declared in def.ports) —
        // pick them up from the edge map (defensive; covers any such flow node).
        for (const [key, source] of inputToSource) {
          if (!key.startsWith(`${node.id}:`)) continue;
          const portId = key.slice(node.id.length + 1);
          if (def.ports.some(p => p.kind === 'input' && p.category === 'value' && p.id === portId)) continue;
          compileValueNode(source.nodeId);
          inputVars[portId] = varName(source.nodeId, source.portId);
        }
        // Dynamic INLINE-WIDGET ports (P2's Form Bond per-bond-attribute initial
        // values). The static loop above only walks `def.ports`, and the edge loop
        // just above only covers WIRED dynamic ports — so a DYNAMIC port with an
        // inline widget and no wire fell through entirely and the node silently used
        // the attribute default. WASM/WebGPU read `_port_*` straight from config and
        // DID honour it, so this was a JS-only divergence (found by P3's cross-target
        // check: `lbl` read 0 on JS and 5 on WASM/WebGPU from the same model).
        // `buildBondAttrPorts` is the ONE port builder the editor uses, so the
        // compiler cannot drift from what the canvas draws.
        for (const port of buildBondAttrPorts(node.data.nodeType, model).inputs) {
          if (inputVars[port.id] !== undefined) continue;
          const inlineVal = getInlineValue(port, node.data.config);
          if (inlineVal !== undefined) inputVars[port.id] = inlineVal;
        }
        const code = def.compile(node.id, node.data.config, inputVars, model?.properties.boundaryTreatment, ctx);
        if (code) flowLines.push(indent + code.trimEnd());
      }

      // Pass-through continuation (`next` flow output — NEXT on action nodes,
      // DONE on control nodes): targets run immediately after this node (after
      // the whole construct for control nodes), at the same scope/indent,
      // BEFORE the parent port's next sibling target — depth-first like UE.
      // No-op when nothing is wired (every pre-existing model).
      compileFlowChain(node.id, 'next', indent);
    }

    // Restore the outer volatile-emit context (if any).
    volatileEmitTarget = savedVolatileTarget;
    volatileEmitIndent = savedVolatileIndent;
  }

  compileFlowChain(rootNode.id, rootFlowPort, '      ');

  return { valueLines, preLoopValueLines, flowLines, scratchNodes };
}

// ---------------------------------------------------------------------------
// Build parameter lists from model (without idx — loop is inside)
// ---------------------------------------------------------------------------

/** 3D Grid CA: a model runs the 3D engine iff it is dimensioned 3D AND has more
 *  than one layer. A 1-layer 3D model uses the 2D fast path (a 1-layer volume IS
 *  a 2D grid). The worker derives its `depth` from the SAME predicate
 *  (dimension==='3d' ? gridDepth : 1) so the baked/passed `total` can't desync. */
export function is3dModel(model: CAModel): boolean {
  return model.properties.dimension === '3d' && (model.properties.gridDepth ?? 1) > 1;
}

/** Bond-Graph Agents: a model runs the agent engine iff its `topologyMode.agents`
 *  flag is on. The single agent chokepoint — shared by the worker (which derives
 *  whether to allocate the agent SoA + run the agent driver) and the compiler
 *  (which compiles the agent rule graph). Distinct from `topologyMode.gridCells`
 *  (the lattice field); a model may have both. */
export function isAgentModel(model: CAModel): boolean {
  return model.topologyMode?.agents === true;
}

/** Per-cell coordinate-decode preamble. 2D (D===1) emits the verbatim 2-line
 *  form so existing models compile byte-identically; 3D adds the `_layer`/`_rem`
 *  decode (reads the precomputed `WH` param). `_row`/`_col` keep their names —
 *  NI / sub-attr emitters read them. `indent` matches the emit site. */
function decodeCoordLines(is3d: boolean, indent: string): string[] {
  if (is3d) {
    return [
      `${indent}const _layer = (idx / WH) | 0;`,
      `${indent}const _rem = idx - _layer * WH;`,
      `${indent}const _row = (_rem / W) | 0;`,
      `${indent}const _col = _rem - _row * W;`,
    ];
  }
  return [
    `${indent}const _row = (idx / W) | 0;`,
    `${indent}const _col = idx - _row * W;`,
  ];
}

function buildLoopParams(model: CAModel): {
  params: string;
  cellAttrs: Array<{ id: string; type: string }>;
  neighborhoods: Array<{ id: string }>;
} {
  const isAsync = model.properties.updateMode === 'asynchronous';
  const variegated = !!model.variegatedCells?.enabled;
  const hasLookupTables = model.attributes.some(a => a.isModelAttribute && a.type === 'lookupTable');
  const cellAttrs = model.attributes
    .filter(a => !a.isModelAttribute)
    .map(a => ({ id: a.id, type: a.type }));
  const neighborhoods = model.neighborhoods.map(n => ({ id: n.id }));

  // 3D Grid CA: `D` (layer count) + `WH` (W*H, precomputed to avoid a per-cell
  // recompute) follow W/H — but ONLY for a 3D model, so a 2D step's signature
  // (and the worker's buildLoopArgs, gated on the SAME predicate) stays
  // byte-identical to the pre-3D code. The decode below reads them only when 3D.
  const parts: string[] = is3dModel(model) ? ['total', 'W', 'H', 'D', 'WH'] : ['total', 'W', 'H'];
  for (const a of cellAttrs) parts.push(`r_${a.id}`);
  for (const a of cellAttrs) parts.push(`w_${a.id}`);
  for (const n of neighborhoods) { parts.push(`nIdx_${n.id}`); parts.push(`nSz_${n.id}`); }
  parts.push('modelAttrs', 'colors', 'activeViewer', '_indicators', '_linkedResults', '_rngState', '_stopFlag', 'glyphCodes', 'glyphColors');
  // Variegated Cells: r/w orientation arrays + flat facePatternLookup +
  // _lookupTables object. Emitted when variegated OR when the model has any
  // Lookup Table model attr (tag×tag tables need _lookupTables without
  // variegation — orientation/facePatternLookup are then null but unused). The
  // worker's buildLoopArgs (sim.worker.ts) mirrors this exact gate + order.
  // `order` is always last for async mode.
  if (variegated || hasLookupTables) parts.push('r_orientation', 'w_orientation', '_facePatternLookup', '_lookupTables');
  // Async-only: per-cell Uint8Array, set by `markCellUpdated` and tested at
  // the top of every cell iteration. Worker resets it before each step.
  if (isAsync) parts.push('order', '_skipped');
  // "Skip Isolated Empty Cells": the active-cell list + count. Appended LAST so
  // the OFF-path signature is byte-identical; the worker's buildLoopArgs mirrors
  // this. When the list is null (feature off / not built), the step runs the
  // full 0..total loop.
  if (sparseSteppingEnabled(model)) parts.push('_activeList', '_activeCount');
  // L2 — Get Generation. Appended after EVERY other trailing block so the
  // OFF-path signature is byte-identical. The worker's buildLoopArgs pushes the
  // value UNCONDITIONALLY (an extra trailing arg is ignored; a missing param
  // would read `undefined`), so only this side is gated.
  if (cellUsesGeneration(model)) parts.push('_generation');

  return { params: parts.join(', '), cellAttrs, neighborhoods };
}

/** Per-cell params (for InputColor which is called per-cell) */
function buildCellParams(model: CAModel): string {
  const cellAttrs = model.attributes.filter(a => !a.isModelAttribute);
  const neighborhoods = model.neighborhoods;
  const variegated = !!model.variegatedCells?.enabled;
  const hasLookupTables = model.attributes.some(a => a.isModelAttribute && a.type === 'lookupTable');
  // 3D Grid CA: D + WH follow W/H only for a 3D model (mirrors buildLoopParams +
  // the worker's buildCellArgs). 2D signature byte-identical.
  const parts: string[] = is3dModel(model) ? ['idx', 'total', 'W', 'H', 'D', 'WH'] : ['idx', 'total', 'W', 'H'];
  for (const a of cellAttrs) parts.push(`r_${a.id}`);
  for (const a of cellAttrs) parts.push(`w_${a.id}`);
  for (const n of neighborhoods) { parts.push(`nIdx_${n.id}`); parts.push(`nSz_${n.id}`); }
  parts.push('modelAttrs', 'colors', 'activeViewer', '_indicators', '_linkedResults', '_rngState', '_stopFlag', 'glyphCodes', 'glyphColors');
  if (variegated || hasLookupTables) parts.push('r_orientation', 'w_orientation', '_facePatternLookup', '_lookupTables');
  // L2 — Get Generation, appended LAST (see buildLoopParams).
  if (cellUsesGeneration(model)) parts.push('_generation');
  return parts.join(', ');
}

// ---------------------------------------------------------------------------
// Linked indicator code generation (injected into step function)
// ---------------------------------------------------------------------------

function buildLinkedIndicatorCode(model: CAModel): {
  preLoopDecls: string[];
  inLoopLines: string[];
  postLoopLines: string[];
} {
  const postLoopLines: string[] = [];

  const watched = (model.indicators || []).filter(
    i => i.kind === 'linked' && i.watched && i.linkedAttributeId,
  );
  if (watched.length === 0) return { preLoopDecls: [], inLoopLines: [], postLoopLines };

  // All linked indicators are computed as post-loop passes over the final buffer.
  // This is correct for both sync mode (w_ has new values after loop) and async mode
  // (single buffer is fully updated). A separate pass over a typed array is fast
  // (sequential memory scan, perfect cache locality) and avoids the async-mode bug
  // where mid-loop aggregation sees a mix of old and new values.
  //
  // Sub-attribute guard: if `attr` is a sub-attribute, the per-cell loop must skip
  // cells whose parent isn't in parentValues — the iteration semantics treat those
  // cells as if the sub-attribute doesn't exist on them.
  for (const ind of watched) {
    const attr = model.attributes.find(a => a.id === ind.linkedAttributeId);
    if (!attr || attr.isModelAttribute) continue;
    const wVar = `w_${attr.id}`;
    const key = JSON.stringify(ind.id);
    const subInf = subAttrInfo(attr, model);
    const guard = subInf
      ? `(${parentMatchExprJS(subInf.parent, subInf.parentValues, '_i', 'w')})`
      : null;
    // Empty parentValues on a sub-attr → guard is `false`, so all cells skipped.
    // (parentMatchExprJS returns 'false' when parentValues array is empty.)
    const skip = guard ? `if (!${guard}) continue; ` : '';

    if (ind.linkedAggregation === 'total') {
      postLoopLines.push(
        `  { let _s = 0; for (let _i = 0; _i < total; _i++) { ${skip}_s += ${wVar}[_i]; }` +
        ` _linkedResults[${key}] = _s; }`,
      );
    } else if (attr.type === 'bool') {
      postLoopLines.push(
        `  { let _t = 0; let _n = 0; for (let _i = 0; _i < total; _i++) { ${skip}_n++; if (${wVar}[_i]) _t++; }` +
        ` _linkedResults[${key}] = { 'true': _t, 'false': _n - _t }; }`,
      );
    } else if (attr.type === 'tag') {
      const tagLen = attr.tagOptions?.length || 1;
      const tagNames = JSON.stringify(attr.tagOptions || []);
      postLoopLines.push(
        `  { const _c = new Int32Array(${tagLen});` +
        ` for (let _i = 0; _i < total; _i++) { ${skip}_c[${wVar}[_i]]++; }` +
        ` const _tn = ${tagNames}; const _f = {};` +
        ` for (let _ti = 0; _ti < ${tagLen}; _ti++) _f[_tn[_ti]] = _c[_ti];` +
        ` _linkedResults[${key}] = _f; }`,
      );
    } else if (attr.type === 'integer') {
      postLoopLines.push(
        `  { const _f = {};` +
        ` for (let _i = 0; _i < total; _i++) { ${skip}const _k = ${wVar}[_i]; _f[_k] = (_f[_k] || 0) + 1; }` +
        ` _linkedResults[${key}] = _f; }`,
      );
    } else if (attr.type === 'float') {
      const bc = ind.binCount || 10;
      postLoopLines.push(
        `  { let _mn = Infinity, _mx = -Infinity;` +
        ` for (let _i = 0; _i < total; _i++) { ${skip}const _v = ${wVar}[_i]; if (_v < _mn) _mn = _v; if (_v > _mx) _mx = _v; }` +
        ` if (_mn === _mx) _mx = _mn + 1;` +
        ` const _bw = (_mx - _mn) / ${bc}; const _bins = new Int32Array(${bc});` +
        ` for (let _i = 0; _i < total; _i++) { ${skip}let _b = (${wVar}[_i] - _mn) / _bw | 0; if (_b >= ${bc}) _b = ${bc - 1}; _bins[_b]++; }` +
        ` const _f = {};` +
        ` for (let _bi = 0; _bi < ${bc}; _bi++)` +
        ` { const _lo = (_mn + _bi * _bw).toFixed(2); const _hi = (_mn + (_bi + 1) * _bw).toFixed(2);` +
        ` _f[_lo + '\\u2013' + _hi] = _bins[_bi]; }` +
        ` _linkedResults[${key}] = _f; }`,
      );
    }
  }

  return { preLoopDecls: [], inLoopLines: [], postLoopLines };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CompileResult {
  stepCode: string;
  /** Per-cell init function code, emitted when the graph contains an Init
   *  Event Node. Loop-wrapped; called once per cell on simulator Reset only
   *  (not on Load State). Empty string when no Init Event
   *  Node is present. */
  initCode: string;
  /** Grid Init Event function code — the GLOBAL once-per-Reset seeding function
   *  (NOT loop-wrapped; no per-cell `idx`). Emitted when the graph contains a
   *  Grid Init Event node. Runs once in the worker on every compile target (it
   *  writes the CPU/wasm attribute buffers, then the worker syncs / uploads).
   *  Empty string when no Grid Init Event node is present. */
  gridInitCode: string;
  inputColorCodes: Array<{ mappingId: string; code: string }>;
  outputMappingCodes: Array<{ mappingId: string; code: string }>;
  /** Parallel to stop-event-node index. When `_stopFlag[0] === n+1`, the
   *  simulator pauses and shows `stopMessages[n]`. Length = number of Stop
   *  Event nodes in the graph (including those inside macro defs). */
  stopMessages: string[];
  error?: string;
}

export function compileGraph(
  graphNodes: GraphNode[],
  graphEdges: GraphEdge[],
  model?: CAModel,
): CompileResult {
  if (!model) {
    return { stepCode: '', initCode: '', gridInitCode: '', inputColorCodes: [], outputMappingCodes: [], stopMessages: [], error: 'Model required for SoA compilation.' };
  }

  // Expand macro instances up front so everything downstream sees one FLAT
  // graph — identical to the WASM/WebGPU targets. Replaces the JS-only lazy
  // macro-inlining path, so sink analysis, loop-invariance, accessor-CSE and
  // volatile hoisting all apply uniformly to former macro internals (closing
  // the in-macro divergence those analyses previously couldn't see).
  {
    const expanded = expandMacros(graphNodes, graphEdges, model);
    if (expanded.error) {
      return { stepCode: '', initCode: '', gridInitCode: '', inputColorCodes: [], outputMappingCodes: [], stopMessages: [], error: expanded.error };
    }
    graphNodes = expanded.nodes;
    graphEdges = expanded.edges;
  }

  // Dangling model references (a cross-model paste / macro import) — report by
  // NAME instead of emitting code that reads an undeclared identifier and only
  // blows up at run time inside the worker. Checked on the FLAT graph (so an
  // uninstantiated macroDef can never fail a compile) and BEFORE the lowering
  // chain (which rewrites ids). WASM/WebGPU already did this; see danglingRefs.ts.
  {
    const dangling = detectDanglingRefs(graphNodes, model);
    if (dangling) {
      return { stepCode: '', initCode: '', gridInitCode: '', inputColorCodes: [], outputMappingCodes: [], stopMessages: [], error: dangling };
    }
  }

  // Reroute collapse — strip editor-only reroute relay nodes, rewiring each
  // consumer directly to the real source it relays from (chains resolved
  // transitively). Runs AFTER expandMacros so in-macro reroutes (now flattened
  // to top-level prefixed nodes) collapse too, and so no later analysis or
  // emitter ever sees a reroute. `A → R → B` compiles byte-identically to `A → B`.
  ({ nodes: graphNodes, edges: graphEdges } = collapseReroutes(graphNodes, graphEdges));

  // Multi-attribute slot expansion — rewrite each multi-slot Get/Set Attribute
  // (extra `attr_${i}` slots + `value_${i}` ports) into the single-slot
  // primitives every target already emits (gets split per slot; sets become a
  // linear flow splice). BEFORE lowerVectorAttrs so a vector attribute in an
  // extra slot lowers normally. Hot-path no-op. See multiAttrExpand.ts.
  ({ nodes: graphNodes, edges: graphEdges } = expandMultiAttrs(graphNodes, graphEdges, model));

  // Vector stored-attribute lowering — rewrite Get/Set Vector Attribute into
  // Make/Break Vector over per-component scalar-float reads/writes AND expand the
  // model's `vector` attributes into their `<id>_vx/_vy[/_vz]` scalar-float
  // components, so everything below (expandComposites, the SoA params, save/load)
  // sees ONLY scalar floats. Runs AFTER macro/reroute flattening + BEFORE
  // expandComposites (which lowers the synthesized Make/Break Vector). Reassigns
  // `model` to the component-expanded model. Hot-path no-op. See vectorAttr.ts.
  ({ nodes: graphNodes, edges: graphEdges, model } = lowerVectorAttrs(graphNodes, graphEdges, model));

  // Composite-type lowering — rewrite vector / colour Make / Break / Vector-Op
  // (+ Apply Force's vector mode) into plain scalar nodes so every target emits
  // them via the verified scalar emitters (no JS-only clamp). See expandComposites.ts.
  ({ nodes: graphNodes, edges: graphEdges } = expandComposites(graphNodes, graphEdges, model));

  // Linked Output Mappings — synthesize the auto color pass for any mapping
  // marked `linked` (ephemeral; rebuilt from the live model each compile). Done
  // BEFORE the empty-graph check so a model whose only graph is a linked color
  // pass (no Step/user nodes) still compiles, and before CSE + buildAdjacency so
  // the synthetic nodes participate normally. (WASM/WebGPU inject post-expand
  // and have no empty-graph early return, so this keeps the three targets aligned.)
  ({ nodes: graphNodes, edges: graphEdges } = injectLinkedOutputMappings(graphNodes, graphEdges, model));

  if (graphNodes.length === 0) {
    return { stepCode: '', initCode: '', gridInitCode: '', inputColorCodes: [], outputMappingCodes: [], stopMessages: [], error: 'No nodes in graph.' };
  }

  const isAsync = model.properties.updateMode === 'asynchronous';

  // --- Validate node capability requirements ---
  // Each NodeTypeDef may declare `requirements: { async?, variegated? }`.
  // This loop derives the active rejection sets from the registry (replaces the
  // legacy hardcoded `ASYNC_ONLY_TYPES`). getNeighborAttributeByIndex stays
  // read-only and works in both sync and async modes (no `async: true` flag).
  let asyncValidationError: string | undefined;
  let variegatedValidationError: string | undefined;
  const asyncOnlyTypes = new Set<string>();
  const variegatedOnlyTypes = new Set<string>();
  for (const def of getAllNodeDefs()) {
    if (def.requirements?.async) asyncOnlyTypes.add(def.type);
    if (def.requirements?.variegated) variegatedOnlyTypes.add(def.type);
  }
  if (!isAsync && asyncOnlyTypes.size > 0) {
    const offending = graphNodes.find(n => asyncOnlyTypes.has(n.data.nodeType));
    if (offending) {
      const label = getNodeDef(offending.data.nodeType)?.label ?? offending.data.nodeType;
      asyncValidationError = `Node "${label}" requires Asynchronous update mode. Change in Model Properties > Execution.`;
    }
  }
  if (!model.variegatedCells?.enabled && variegatedOnlyTypes.size > 0) {
    const offending = graphNodes.find(n => variegatedOnlyTypes.has(n.data.nodeType));
    if (offending) {
      const label = getNodeDef(offending.data.nodeType)?.label ?? offending.data.nodeType;
      variegatedValidationError = `Node "${label}" requires Variegated Cells enabled. Enable in Model Properties > Execution.`;
    }
  }

  // Accessor CSE — sync-mode only. Deduplicates pure value-producing nodes
  // (GetCellAttribute, GetNeighborsAttribute, arithmetic over them, etc.) that
  // share the same purity key, by rewriting their consumer edges to point at
  // one canonical representative per group. Frees users from sharing accessor
  // nodes manually in multi-equation models (Gray-Scott and similar). See
  // accessorCSE.ts for the full rationale and purity rules.
  graphEdges = canonicalizeAccessorEdges(graphNodes, graphEdges, model);

  const { nodeMap, inputToSource, inputToSources, flowOutputToTargets } = buildAdjacency(graphNodes, graphEdges);

  // Pre-resolve neighborhood tag names to indices for GetNeighborAttributeByTag nodes.
  // 3D Grid CA: pack offsets with the 3-axis codec from coords3d when the model
  // is 3D (2D packs the verbatim 2-axis codec → byte-identical).
  const niIs3d = is3dModel(model);
  const packCoord = (nbr: { coords: Array<[number, number]>; coords3d?: Array<[number, number, number]> } | undefined, slot: number): number => {
    if (!nbr || slot < 0) return INVALID_NI;
    if (niIs3d) {
      const c = nbr.coords3d?.[slot];
      if (c) return packNI3(c[0], c[1], c[2]);
      // A 2D-authored neighbourhood (no coords3d) in a 3D model: fall back to
      // coords with dl=0 — the SAME fallback the worker's buildNeighborIndices
      // uses. Without this, every slot packed INVALID_NI and NI-based rules
      // silently no-op'd while neighbour-attribute rules kept working.
      const c2 = nbr.coords[slot];
      return c2 ? packNI3(c2[0], c2[1], 0) : INVALID_NI;
    }
    const c = nbr.coords[slot]; return c ? packNI(c[0], c[1]) : INVALID_NI;
  };
  for (const node of graphNodes) {
    if (node.data.nodeType === 'getNeighborAttributeByTag') {
      const nbrId = node.data.config.neighborhoodId as string;
      const nbr = model.neighborhoods.find(n => n.id === nbrId);
      const tagName = node.data.config.tagName as string;
      const tagEntry = nbr?.tags
        ? Object.entries(nbr.tags).find(([, name]) => name === tagName)
        : undefined;
      node.data.config._resolvedTagIndex = tagEntry !== undefined ? Number(tagEntry[0]) : 0;
    }
    if (node.data.nodeType === 'getNeighborIndexesByTags') {
      // Wave A.6: resolve each tag to its (dr, dc) and pack into i32. The
      // emit produces a literal i32[] of packed NIs.
      const nbrId = node.data.config.neighborhoodId as string;
      const nbr = model.neighborhoods.find(n => n.id === nbrId);
      const tagCount = Number(node.data.config.tagCount) || 0;
      const packed: number[] = [];
      for (let i = 0; i < tagCount; i++) {
        const tagName = node.data.config[`tag_${i}_name`] as string;
        const tagEntry = nbr?.tags
          ? Object.entries(nbr.tags).find(([, name]) => name === tagName)
          : undefined;
        const slot = tagEntry !== undefined ? Number(tagEntry[0]) : -1;
        packed.push(packCoord(nbr, slot));
      }
      node.data.config._resolvedTagIndexes = JSON.stringify(packed);
    }
    // Wave A.6: NI runtime is now packed (dr, dc) i32. Pre-pass resolves the
    // packed values for compile-time-known constructors. (Wave A's prior
    // slot-index pre-pass is gone; runtime values are packed offsets, not
    // slot indices.)
    if (node.data.nodeType === 'neighborIndexFromTag') {
      const nbrId = node.data.config.neighborhoodId as string;
      const nbr = model.neighborhoods.find(n => n.id === nbrId);
      const tagName = node.data.config.tagName as string;
      const tagEntry = nbr?.tags
        ? Object.entries(nbr.tags).find(([, name]) => name === tagName)
        : undefined;
      const slot = tagEntry !== undefined ? Number(tagEntry[0]) : -1;
      node.data.config._resolvedPacked = packCoord(nbr, slot);
    }
    if (node.data.nodeType === 'getAllNeighborIndexes') {
      // Wave A.6: pre-resolve packed offsets for every slot. 3D packs from
      // coords3d (3-axis); 2D from coords (2-axis, byte-identical).
      const nbrId = node.data.config.neighborhoodId as string;
      const nbr = model.neighborhoods.find(n => n.id === nbrId);
      // 3D: coords3d when present, else the 2D coords (dl=0 fallback — stride
      // invariant keeps the lengths equal when coords3d exists).
      const len = nbr ? (niIs3d ? (nbr.coords3d?.length ?? nbr.coords.length) : nbr.coords.length) : 0;
      const packed: number[] = [];
      for (let i = 0; i < len; i++) packed.push(packCoord(nbr, i));
      node.data.config._resolvedPackedAll = JSON.stringify(packed);
    }
    // Wave A.6: arrayElement out-of-range default depends on whether the
    // array carries NIs (use INVALID_NI sentinel) or attribute values /
    // list-positions (use 0). Resolve at compile time by inspecting the
    // source nodeType. Stored in config for the emitter to pick up. WASM /
    // WebGPU compilers do their own resolution at emit time via ctx.
    if (node.data.nodeType === 'arrayElement') {
      const arraySrc = inputToSource.get(`${node.id}:array`);
      if (arraySrc) {
        const srcNode = nodeMap.get(arraySrc.nodeId);
        node.data.config._elemKind = srcNode && NI_ARRAY_PRODUCERS.has(srcNode.data.nodeType) ? 'ni' : 'value';
      } else {
        // No source connected — default to value (0 fallback). The compiler
        // will emit a `_undef` lookup which is its own diagnostic.
        node.data.config._elemKind = 'value';
      }
    }
  }

  // Pre-resolve indicator IDs to numeric indices so the per-cell hot path can
  // do typed-array index access (_indicators[3]) instead of string-keyed object
  // access (_indicators["abc123"]). Worker mirrors the same id->index mapping
  // from model.indicators array order. -1 signals unresolved (stale config).
  const indicatorIdxMap = new Map((model.indicators || []).map((ind, i) => [ind.id, i] as const));
  function preResolveIndicators(nodes: GraphNode[]): void {
    for (const node of nodes) {
      const t = node.data.nodeType;
      if (t === 'getIndicator' || t === 'setIndicator' || t === 'updateIndicator') {
        const indId = node.data.config.indicatorId as string;
        const idx = indicatorIdxMap.get(indId);
        node.data.config._indicatorIdx = idx !== undefined ? idx : -1;
      }
    }
  }
  preResolveIndicators(graphNodes);

  // Pre-assign stop-event indices. Each StopEventNode gets a stable 1-based
  // index (0 reserved for "no stop requested"); the emitted code writes that
  // index into `_stopFlag[0]`. Worker reads the flag after each step call and
  // uses (idx - 1) to look up the user's message from `stopMessages`.
  // The graph is already flat here (macros expanded), so former macro-internal
  // stop events are top-level nodes — walking `graphNodes` covers them all.
  const stopMessages: string[] = [];
  function preResolveStopEvents(nodes: GraphNode[]): void {
    for (const node of nodes) {
      if (node.data.nodeType === 'stopEvent') {
        stopMessages.push(String(node.data.config.message ?? 'Stop condition reached'));
        node.data.config._stopIdx = stopMessages.length; // 1-based
      }
    }
  }
  preResolveStopEvents(graphNodes);

  // Pre-resolve variegated nodes' compile-time fields:
  //   - getFacingLabels: direction index + (dr, dc) offset resolved from
  //     directionTag alone. The encounter is intrinsic to the grid (one step
  //     in one of 8 fixed directions); no neighborhood needed. Unset / invalid
  //     tag → dirIdx = -1, emit collapses to `none/none`.
  //   - lookupInteraction: labelCount = faceLabels.length + 1 (includes implicit `none`)
  // Skipped when variegation is off — those node types are also filtered out
  // of the palette in that case, so the user can't easily place them.
  const variegationOn = !!model.variegatedCells?.enabled;
  const variegatedSourceAttrId = variegationOn ? (model.variegatedCells?.sourceAttributeId ?? '') : '';
  // Per-table row/col dimensions, resolved from each lookup table's key sources
  // (face palette → ['none', ...labels]; tag attribute → tagOptions). Replaces
  // the old single global labelCount — supports rectangular + multi-palette and
  // tag×tag tables that need no variegation at all.
  // (dr, dc) offsets for each of the 8 face slots, indexed by direction index.
  // Order matches DIRECTION_TAGS exactly: N, NE, E, SE, S, SW, W, NW.
  const DIRECTION_OFFSETS: ReadonlyArray<readonly [number, number]> = [
    [-1, 0], [-1, 1], [0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1],
  ];
  const boundaryTreatment = model!.properties.boundaryTreatment ?? 'torus';
  function preResolveVariegatedNodes(nodes: GraphNode[]): void {
    for (const node of nodes) {
      if (node.data.nodeType === 'getFacingLabels'
        || node.data.nodeType === 'getFacingOrientation'
        || node.data.nodeType === 'setFacingOrientation') {
        const tag = (node.data.config.directionTag as string) || '';
        let dirIdx = -1;
        let dr = 0, dc = 0;
        if (tag && (DIRECTION_TAGS as readonly string[]).includes(tag)) {
          dirIdx = directionIndex(tag);
          const off = DIRECTION_OFFSETS[dirIdx]!;
          dr = off[0];
          dc = off[1];
        }
        node.data.config._resolvedDirIdx = dirIdx;
        node.data.config._resolvedDr = dr;
        node.data.config._resolvedDc = dc;
        node.data.config._boundaryTreatment = boundaryTreatment;
        if (node.data.nodeType === 'getFacingLabels') {
          node.data.config._sourceAttrId = variegatedSourceAttrId;
        }
      }
      if (node.data.nodeType === 'getAllFacingLabels') {
        node.data.config._boundaryTreatment = boundaryTreatment;
        node.data.config._sourceAttrId = variegatedSourceAttrId;
      }
      if (node.data.nodeType === 'lookupInteraction' || node.data.nodeType === 'interactionTableMap') {
        preResolveLookupTableNode(node, model!);
      }
      if (node.data.nodeType === 'getConstant' && node.data.config.constType === 'faceLabel') {
        // Resolve face-label NAME to its compile-time index within the chosen
        // palette. Implicit 'none' is 0; user labels are 1-based into the
        // palette's labels[]. Unresolved cases (variegation off, blank, unknown
        // label, missing palette) emit -1 as a sentinel for the consumer.
        const raw = String(node.data.config.constValue ?? 'none');
        let idx: number;
        if (!variegationOn) {
          idx = -1;
        } else if (raw === 'none') {
          idx = 0;
        } else {
          const palettes = model!.variegatedCells?.facePalettes ?? [];
          const palId = String(node.data.config.facePaletteId ?? '');
          const pal = palettes.find(p => p.id === palId) ?? palettes[0];
          const i = (pal?.labels ?? []).indexOf(raw);
          idx = i >= 0 ? i + 1 : -1;
        }
        node.data.config._resolvedFaceLabelIndex = idx;
      }
    }
  }

  // Bake per-slot attribute defaultValue into MoveSelfToNeighbor configs.
  // The node's compile() emits `w_attr[idx] = ${_attr_${i}_default}` to clear
  // the source cell after pushing; the literal comes from the attribute's
  // schema-declared defaultValue. Tag attrs already encode as the tag-index
  // string ('0', '1', ...); bool / int / float use their defaultValue string
  // directly. Same baking happens for the WASM emit's attr.defaultValue lookup,
  // but the JS path doesn't have model layout — so we inject into config here.
  function preResolveMoveNodes(nodes: GraphNode[]): void {
    for (const node of nodes) {
      if (node.data.nodeType !== 'moveSelfToNeighbor') continue;
      const payloadCount = Math.max(1, Number(node.data.config.payloadCount) || 1);
      for (let i = 0; i < payloadCount; i++) {
        const attrId = node.data.config[`attr_${i}`] as string;
        if (!attrId) continue;
        const attr = model!.attributes.find(a => a.id === attrId && !a.isModelAttribute);
        if (!attr) continue;
        const raw = (attr.defaultValue ?? '0').toString();
        const normalised = raw === 'true' ? '1' : raw === 'false' ? '0' : raw;
        node.data.config[`_attr_${i}_default`] = normalised;
      }
      // Orientation only exists in Variegated Cells models. Bake the resolved
      // decision so the JS emit never references the (unallocated) orientation
      // buffer when a stale `includeOrientation: true` lingers on a model whose
      // variegation was later turned off (or a hand-edited file).
      node.data.config._includeOriResolved =
        !!node.data.config.includeOrientation && !!model!.variegatedCells?.enabled;
    }
  }
  preResolveMoveNodes(graphNodes);
  preResolveVariegatedNodes(graphNodes);

  // Loop-invariance classification: identifies value nodes whose result does
  // not depend on the cell index (modelAttrs reads, getConstant, arithmetic
  // over them). Their emissions hoist out of the cell loop, paying the cost
  // once per step instead of once per cell. Shared with the WASM compiler so
  // both targets agree on which nodes are hoistable.
  const loopInvariant = classifyLoopInvariant(graphNodes, inputToSource);

  // Single-consumer aggregate fusion: when a getNeighborsAttribute feeds
  // exactly one downstream aggregate (sum/product/max/min/average/and/or),
  // collapse the two-loop pattern (gather scratch + reduce) into one inlined
  // loop. Halves work for the MNCA-style hot path (large neighborhoods).
  // Shared with the WASM compiler.
  // Async read-after-write hazard reads on the step root: refuse to fuse a
  // getNeighborsAttribute whose source attribute is written earlier in the same
  // cell. The fused emit reads `r_<attr>` inline (gather skipped), which would
  // bypass the volatile pin — forcing the materialized gather lets it ride the
  // volatile-hoist mechanism instead. JS-only effect: WASM never consults the
  // fusion map (its gather is always a phantom). Empty for sync.
  const stepNodeForFusion = graphNodes.find(n => n.data.nodeType === 'step');
  const fusionHazards = stepNodeForFusion
    ? computeAsyncReadWriteHazards({
        nodeMap, inputToSource, inputToSources, flowOutputToTargets,
        rootNodeId: stepNodeForFusion.id, rootFlowPortId: 'do', isAsync,
      })
    : new Set<string>();
  // "Skip Isolated Empty Cells" (inline-neighbour mode): disable aggregate
  // fusion — the fused builders read the per-cell nIdx table inline, which no
  // longer exists (nIdx carries the compact packed offsets). Unfused, the
  // gather materialises through GetNeighborsAttribute's inline-aware scratch
  // fill and the reducer consumes the scratch array — correct on both modes.
  // Sparse cells are few, so the lost fusion micro-opt is negligible there.
  const fusion = sparseSteppingEnabled(model)
    ? detectFusableConsumers([], [], inputToSources, inputToSource, model, fusionHazards)
    : detectFusableConsumers(graphNodes, graphEdges, inputToSources, inputToSource, model, fusionHazards);

  const { params: loopParams, cellAttrs } = buildLoopParams(model);
  const cellParams = buildCellParams(model);
  // 3D Grid CA: drives the per-cell coordinate decode at every entry point.
  const is3d = is3dModel(model);

  // Per-attribute sub-attribute info (null for regular attrs).
  const subAttrInfoById = new Map<string, ReturnType<typeof subAttrInfo>>();
  for (const a of cellAttrs) {
    const full = model.attributes.find(x => x.id === a.id);
    subAttrInfoById.set(a.id, subAttrInfo(full, model));
  }

  // Sync mode: bulk-copy r→w ONCE before the loop (TypedArray.set dispatches to
  // SIMD memcpy in V8). Replaces N per-cell stores with one engine call per attr.
  // Cell rules then overwrite specific indices inside the loop; untouched cells
  // retain the prior generation's value, matching the previous semantics exactly.
  // Async mode: r_ and w_ are the same buffer so no copy needed.
  //
  // Sub-attributes can't use the bulk .set() — non-matching cells need to be
  // scrubbed to defaultValue, so they get a conditional per-cell copy at the
  // top of the loop body instead (see subAttrSyncCopyLines below).
  // "Skip Isolated Empty Cells": sub-attrs MUST join the bulk copy — the
  // per-cell conditional copy only runs for ACTIVE cells, so without the bulk
  // copy an inactive cell's w-buffer would hold two-generations-old data after
  // the swap. Active cells still get the scrub (their conditional copy runs on
  // top of the bulk copy — identical result); inactive non-matching cells
  // carry storage forward instead of being scrubbed, which is INVISIBLE to
  // every read (the parent-match guard returns undefinedValue) and to linked
  // indicators / iteration (both apply the guard).
  const sparseBulk = sparseSteppingEnabled(model);
  const bulkCopyLines = isAsync
    ? []
    : cellAttrs.filter(a => sparseBulk || !subAttrInfoById.get(a.id)).map(a => `  w_${a.id}.set(r_${a.id});`);
  // Variegated Cells: orientation has the same sync-mode discipline as the
  // cell attrs — bulk-copy r→w before the loop body so SetOrientation writes
  // overlay onto a fresh copy of the read buffer. Async mode shares one
  // buffer (r/w are the same Int32Array view), so the line is skipped.
  if (!isAsync && model.variegatedCells?.enabled) {
    bulkCopyLines.push('  w_orientation.set(r_orientation);');
  }

  // Per-cell conditional copy for sub-attributes, emitted at the top of the
  // sync loop body. `w_subattr[idx] = parent_matches(r_parent[idx]) ? r_subattr[idx] : defaultValue`.
  // Keeps storage at non-matching indices scrubbed to defaultValue between steps.
  // Async mode: handled by a worker-side pre-scrub pass (r_ and w_ share one buffer).
  const subAttrSyncCopyLines = isAsync
    ? []
    : cellAttrs
        .filter(a => subAttrInfoById.get(a.id))
        .map(a => {
          const info = subAttrInfoById.get(a.id)!;
          const full = model.attributes.find(x => x.id === a.id)!;
          const guard = parentMatchExprJS(info!.parent, info!.parentValues, 'idx', 'r');
          const defaultLit = attrValueLiteralJS(full, full.defaultValue);
          return `    w_${a.id}[idx] = (${guard}) ? r_${a.id}[idx] : ${defaultLit};`;
        });

  // Per-step hoist of activeViewer comparisons. SetColorViewer compile() emits
  // `if (_isV_<safeId(mappingId)>) { ... }`; the actual string compare happens
  // ONCE here per mapping id, then per-cell branches do a cheap local read.
  // We hoist for the union of (a) every mapping in the model and (b) every
  // mapping id any setColorViewer node actually references — including inside
  // macro defs — so a stale or non-model mapping id can't crash with an
  // undefined identifier. The unused booleans cost one string compare per
  // step — negligible.
  const viewerIdsToHoist = new Set<string>();
  for (const m of model.mappings || []) viewerIdsToHoist.add(m.id);
  const collectViewerRefs = (nodes: GraphNode[]) => {
    for (const n of nodes) {
      if (n.data.nodeType === 'setCellLooks') {
        const mid = (n.data.config.mappingId as string) || 'default';
        // "Current Simulator Selected" emits no _isV_ guard — nothing to hoist.
        if (mid !== CURRENT_VIEWER_SENTINEL) viewerIdsToHoist.add(mid);
      }
    }
  };
  collectViewerRefs(graphNodes);
  const viewerHoistLines = Array.from(viewerIdsToHoist).map(
    id => `  const _isV_${safeId(id)} = activeViewer === ${JSON.stringify(id)};`,
  );

  // --- Compile Step function (loop-wrapped) ---
  const stepNode = graphNodes.find(n => n.data.nodeType === 'step');
  let stepCode = '';
  if (stepNode) {
    const { valueLines, preLoopValueLines, flowLines, scratchNodes } = compileRoot(
      stepNode, 'do', nodeMap, inputToSource, inputToSources, flowOutputToTargets, loopInvariant, fusion, graphNodes, graphEdges, model,
    );

    // Scratch array declarations (before the loop)
    const scratchDecls = scratchNodes.map(s => buildScratchDecl(s, model));

    // Local Variables: per-cell scratch storage. Array variables get one
    // typed-array buffer allocated outside the loop (reused per cell), reset
    // to initialValue at cell-top. Scalar variables become per-cell `let`s.
    const variableBlocks = buildVariableJS(model.variables || []);

    // Build linked indicator aggregation code (injected into the loop)
    const linked = buildLinkedIndicatorCode(model);

    if (isAsync) {
      // Async mode: iterate cells via shuffled order array
      stepCode = [
        `(function(${loopParams}) {`,
        ...scratchDecls,
        ...variableBlocks.preLoop,
        ...viewerHoistLines,
        ...preLoopValueLines,
        ...linked.preLoopDecls,
        '  let _rs = _rngState[0] || 0x12345678;',
        '  for (let _i = 0; _i < total; _i++) {',
        '    const idx = order[_i];',
        // Mark Cell Updated: skip cells flagged by an earlier iteration's rule.
        // Flag is cleared each step by the worker before the loop runs.
        '    if (_skipped[idx] !== 0) continue;',
        '    const colorIdx = idx * 4;',
        // Wave A.6: per-cell (row, col) decoded from idx — used by NI access
        // helpers (filterNeighbors, get/setNeighborAttributeByIndex, etc.).
        // Two ops per cell, amortised across all NI accesses in the cell body.
        // 3D Grid CA: adds the _layer/_rem decode when the model is 3D.
        ...decodeCoordLines(is3d, '    '),
        ...variableBlocks.inLoopReset,
        ...valueLines,
        '',
        ...flowLines,
        ...linked.inLoopLines,
        '  }',
        '  _rngState[0] = _rs;',
        ...linked.postLoopLines,
        '})',
      ].join('\n');
    } else {
      // Sync mode: sequential iteration. When "Skip Isolated Empty Cells" is on,
      // emit a sparse loop variant selected at runtime by `_activeList`: iterate
      // the active-cell list instead of 0..total. The bulk copy (all cells) +
      // buffer swap are unchanged, so inactive cells carry forward correctly; only
      // the expensive per-cell RULE is skipped for isolated empty cells. Linked
      // indicators are NOT embedded in the sparse build (they must aggregate ALL
      // cells) — the worker runs the full-grid `computeLinkedIndicatorsFromBuffer`
      // instead, exactly like the WASM path.
      const sparse = sparseSteppingEnabled(model);
      const perCellBody = [
        '    const colorIdx = idx * 4;',
        // Wave A.6: per-cell (row, col) decoded from idx — see async branch comment.
        ...decodeCoordLines(is3d, '    '),
        // Sub-attribute conditional copy: scrub non-matching cells to defaultValue,
        // copy from r_ to w_ for matching cells. Replaces the bulk .set() that
        // regular attrs use. User rule writes later overwrite w_ as needed.
        ...subAttrSyncCopyLines,
        ...variableBlocks.inLoopReset,
        ...valueLines,
        '',
        ...flowLines,
        ...(sparse ? [] : linked.inLoopLines),
      ];
      const loopLines = sparse
        ? [
            '  if (_activeList) {',
            '    for (let _si = 0; _si < _activeCount; _si++) {',
            '      const idx = _activeList[_si];',
            ...perCellBody.map(l => '  ' + l),
            '    }',
            '  } else {',
            '    for (let idx = 0; idx < total; idx++) {',
            ...perCellBody.map(l => '  ' + l),
            '    }',
            '  }',
          ]
        : [
            '  for (let idx = 0; idx < total; idx++) {',
            ...perCellBody,
            '  }',
          ];
      stepCode = [
        `(function(${loopParams}) {`,
        ...scratchDecls,
        ...variableBlocks.preLoop,
        ...bulkCopyLines,
        ...viewerHoistLines,
        ...preLoopValueLines,
        ...(sparse ? [] : linked.preLoopDecls),
        '  let _rs = _rngState[0] || 0x12345678;',
        ...loopLines,
        '  _rngState[0] = _rs;',
        ...(sparse ? [] : linked.postLoopLines),
        '})',
      ].join('\n');
    }
  }

  // --- Compile InputColor functions (per-cell, not loop-wrapped) ---
  const inputColorNodes = graphNodes.filter(n => n.data.nodeType === 'inputColor');
  const inputColorCodes: Array<{ mappingId: string; code: string }> = [];

  for (const icNode of inputColorNodes) {
    const mappingId = icNode.data.config.mappingId as string || '';
    const { valueLines, preLoopValueLines, flowLines } = compileRoot(
      icNode, 'do', nodeMap, inputToSource, inputToSources, flowOutputToTargets, loopInvariant, fusion, graphNodes, graphEdges, model,
    );
    // InputColor is called per-cell (for painted cells only), keep per-cell signature.
    // preLoopValueLines (modelAttrs reads etc.) still go in the function preamble —
    // they happen once per call, not per cell, but the same hoisting structure
    // keeps the body free of redundant work.
    // Per-cell copy. Sub-attributes use the conditional form (scrub non-matching cells
     // to defaultValue) — same semantics as the sync step's subAttrSyncCopyLines.
    const icCopyLines = cellAttrs.map(a => {
      const info = subAttrInfoById.get(a.id);
      if (!info) return `  w_${a.id}[idx] = r_${a.id}[idx];`;
      const full = model.attributes.find(x => x.id === a.id)!;
      const guard = parentMatchExprJS(info.parent, info.parentValues, 'idx', 'r');
      const defaultLit = attrValueLiteralJS(full, full.defaultValue);
      return `  w_${a.id}[idx] = (${guard}) ? r_${a.id}[idx] : ${defaultLit};`;
    });
    const code = [
      `(function(_r, _g, _b, ${cellParams}) {`,
      '  const colorIdx = idx * 4;',
      // Wave A.6: per-cell (row, col) decoded from idx for NI access helpers.
      ...decodeCoordLines(is3d, '  '),
      ...icCopyLines,
      `  const _v${icNode.id}_r = _r; const _v${icNode.id}_g = _g; const _v${icNode.id}_b = _b;`,
      '  let _rs = _rngState[0] || 0x12345678;',
      ...viewerHoistLines,
      ...preLoopValueLines,
      '',
      ...valueLines,
      '',
      ...flowLines,
      '  _rngState[0] = _rs;',
      '})',
    ].join('\n');
    inputColorCodes.push({ mappingId, code });
  }

  // --- Compile Output Mapping functions (loop-wrapped, always sequential, no copy lines) ---
  const outputMappingNodes = graphNodes.filter(n => n.data.nodeType === 'outputMapping');
  const outputMappingCodes: Array<{ mappingId: string; code: string }> = [];

  // Output mapping uses sync-style loop params (no order) regardless of updateMode
  const omParamParts: string[] = is3d ? ['total', 'W', 'H', 'D', 'WH'] : ['total', 'W', 'H'];
  for (const a of cellAttrs) omParamParts.push(`r_${a.id}`);
  for (const a of cellAttrs) omParamParts.push(`w_${a.id}`);
  const neighborhoods = model.neighborhoods.map(n => ({ id: n.id }));
  for (const n of neighborhoods) { omParamParts.push(`nIdx_${n.id}`); omParamParts.push(`nSz_${n.id}`); }
  omParamParts.push('modelAttrs', 'colors', 'activeViewer', '_indicators', '_linkedResults', '_rngState', '_stopFlag', 'glyphCodes', 'glyphColors');
  if (model.variegatedCells?.enabled || model.attributes.some(a => a.isModelAttribute && a.type === 'lookupTable')) {
    omParamParts.push('r_orientation', 'w_orientation', '_facePatternLookup', '_lookupTables');
  }
  // "Skip Isolated Empty Cells": the colour pass gets the same sparse loop
  // variant as the step (recolour only ACTIVE cells — inactive cells never step,
  // so their colour inputs are frozen and their last-painted colour stays
  // correct). The worker passes a null list to force a FULL pass on the rare
  // events where an inactive cell's colour COULD change (model-attr edit,
  // viewer switch, paint, reset/load). Appended LAST — OFF byte-identical.
  const omSparse = sparseSteppingEnabled(model);
  if (omSparse) omParamParts.push('_activeList', '_activeCount');
  // L2 — Get Generation, appended LAST (see buildLoopParams).
  if (cellUsesGeneration(model)) omParamParts.push('_generation');
  const omParams = omParamParts.join(', ');

  for (const omNode of outputMappingNodes) {
    const mappingId = omNode.data.config.mappingId as string || '';
    const { valueLines, preLoopValueLines, flowLines, scratchNodes } = compileRoot(
      omNode, 'do', nodeMap, inputToSource, inputToSources, flowOutputToTargets, loopInvariant, fusion, graphNodes, graphEdges, model,
    );
    const scratchDecls = scratchNodes.map(s => buildScratchDecl(s, model));
    const omPerCell = [
      '    const colorIdx = idx * 4;',
      // Wave A.6: per-cell (row, col) decoded from idx for NI access helpers.
      ...decodeCoordLines(is3d, '    '),
      ...valueLines,
      '',
      ...flowLines,
    ];
    const omLoop = omSparse
      ? [
          '  if (_activeList) {',
          '    for (let _si = 0; _si < _activeCount; _si++) {',
          '      const idx = _activeList[_si];',
          ...omPerCell.map(l => '  ' + l),
          '    }',
          '  } else {',
          '    for (let idx = 0; idx < total; idx++) {',
          ...omPerCell.map(l => '  ' + l),
          '    }',
          '  }',
        ]
      : [
          '  for (let idx = 0; idx < total; idx++) {',
          ...omPerCell,
          '  }',
        ];
    const code = [
      `(function(${omParams}) {`,
      ...scratchDecls,
      ...viewerHoistLines,
      ...preLoopValueLines,
      '  let _rs = _rngState[0] || 0x12345678;',
      ...omLoop,
      '  _rngState[0] = _rs;',
      '})',
    ].join('\n');
    outputMappingCodes.push({ mappingId, code });
  }

  // --- Compile Init Event function (one-shot per cell on Reset) ---
  // Init runs ONCE per cell after defaults are applied, before the first
  // color pass. Same per-cell-loop shape as OutputMapping (always sequential,
  // no async ordering). DIFFERS from OutputMapping in that init writes
  // attributes — so it needs the sync-mode bulk copy + sub-attribute scrub
  // lines that step has, and the worker performs a buffer swap after running
  // it in sync mode so subsequent reads see the init-time writes.
  const initNode = graphNodes.find(n => n.data.nodeType === 'initEvent');
  let initCode = '';
  if (initNode) {
    const { valueLines, preLoopValueLines, flowLines, scratchNodes } = compileRoot(
      initNode, 'do', nodeMap, inputToSource, inputToSources, flowOutputToTargets, loopInvariant, fusion, graphNodes, graphEdges, model,
    );
    const scratchDecls = scratchNodes.map(s => buildScratchDecl(s, model));
    // Sync-mode bulk copy. Async mode skips (single buffer) — sub-attribute
    // scrub lines below still apply because parent could be in either buffer.
    const initBulkCopy = isAsync
      ? []
      : cellAttrs.filter(a => !subAttrInfoById.get(a.id)).map(a => `  w_${a.id}.set(r_${a.id});`);
    const initId = initNode.id;
    initCode = [
      `(function(${omParams}) {`,
      ...scratchDecls,
      ...viewerHoistLines,
      ...preLoopValueLines,
      '  let _rs = _rngState[0] || 0x12345678;',
      ...initBulkCopy,
      '  for (let idx = 0; idx < total; idx++) {',
      '    const colorIdx = idx * 4;',
      ...decodeCoordLines(is3d, '    '),
      `    const _v${initId}_x = _col;`,
      `    const _v${initId}_y = _row;`,
      `    const _v${initId}_maxX = W - 1;`,
      `    const _v${initId}_maxY = H - 1;`,
      // 3D Grid CA: expose the layer (z) + maxZ to the InitEvent's z/maxZ ports.
      ...(is3d ? [
        `    const _v${initId}_z = _layer;`,
        `    const _v${initId}_maxZ = D - 1;`,
      ] : []),
      ...subAttrSyncCopyLines,
      ...valueLines,
      '',
      ...flowLines,
      '  }',
      '  _rngState[0] = _rs;',
      '})',
    ].join('\n');
  }

  // --- Grid Init Event (GLOBAL once-per-Reset SETUP function — NOT loop-wrapped,
  //     NO per-cell `idx`). The free-form counterpart to the per-cell Init Event:
  //     the user loops (Loop / For Each) inside DO and writes arbitrary cells with
  //     Set Cell (at Position). Its value-outs expose the grid dims (W/H/D). Runs
  //     as a JS function in the worker on EVERY compile target (see runGridInit) —
  //     the seeding is a one-time pass, so there's no per-target emit. ---
  const gridInitNode = graphNodes.find(n => n.data.nodeType === 'gridInit');
  let gridInitCode = '';
  if (gridInitNode) {
    const { valueLines, preLoopValueLines, flowLines, scratchNodes } = compileRoot(
      gridInitNode, 'do', nodeMap, inputToSource, inputToSources, flowOutputToTargets, loopInvariant, fusion, graphNodes, graphEdges, model,
    );
    const scratchDecls = scratchNodes.map(s => buildScratchDecl(s, model));
    const gId = gridInitNode.id;
    // Local Variables (cell scope) are available as global scratch here (counters
    // / accumulators for "place N seeds", etc.). Not loop-wrapped, so the scalar
    // `let`s + array fills run ONCE.
    const gv = buildVariableJS(model.variables || []);
    gridInitCode = [
      `(function(${omParams}) {`,
      ...scratchDecls,
      ...gv.preLoop,
      ...gv.inLoopReset.map(l => '  ' + l.trimStart()),
      // Grid-dimension value-outs — emitted BEFORE the (loop-invariant)
      // preLoopValueLines so a hoisted `width / 2` sees them defined.
      `  const _v${gId}_width = W;`,
      `  const _v${gId}_height = H;`,
      ...(is3d ? [`  const _v${gId}_depth = D;`] : []),
      '  let _rs = _rngState[0] || 0x12345678;',
      ...preLoopValueLines,
      ...valueLines,
      '',
      ...flowLines,
      '  _rngState[0] = _rs;',
      '})',
    ].join('\n');
  }

  const error = asyncValidationError
    ?? variegatedValidationError
    ?? (!stepNode ? 'No Step node found. Add a Step node as the entry point.' : undefined);

  return { stepCode, initCode, gridInitCode, inputColorCodes, outputMappingCodes, stopMessages, error };
}

// ===========================================================================
// Bond-Graph Agents — the agent rule-graph compiler (JS-reference, v1).
//
// A sibling to compileGraph that compiles `model.agentGraphNodes` rooted at the
// `behaviourStep` node into the per-agent loop. The agent loop variable is
// `idx` (Decision D-IDX), so every attribute-read node lands on the agent SoA
// (`r_<id>[idx]`) with ZERO node change. The loop bound is `highWater` (NOT
// `total`) with a `!_alive[idx]` skip, and there is NO row/col decode + NO
// `colorIdx = idx*4` (agents are entity-rendered; the structural phase + the
// engine own position/radius). Engine geometry/identity is exposed through the
// behaviourStep value-out preamble (`_v<id>_myX = _agentX[idx]`, …) — read by
// the agent read nodes; SetAttribute/GetCellAttribute can only touch the user
// `r_/w_` attribute arrays (the N4 guardrail).
// ===========================================================================

export interface AgentCompileResult {
  /** The per-agent behaviour function source (loop-wrapped). Empty when there's
   *  no behaviourStep root or on error. */
  behaviourCode: string;
  /** Reserved (agent Init Event) — empty in v1. */
  initCode: string;
  /** The single-agent Division Event function (runs per daughter). Empty when
   *  there's no divisionEvent root. */
  divisionCode: string;
  /** Generic Agent Platform (FIX 4): per-stop-event-node messages from the AGENT
   *  graph (indexed by `_stopIdx - 1`). Merged into the worker's `stopMessages`
   *  alongside the cell graph's so an agent Stop Event surfaces its message. */
  stopMessages: string[];
  /** Agent Output Mappings: one per-agent colour-pass function source per linked
   *  agent mapping (loop-wrapped, like behaviourCode). The worker runs the one
   *  whose `mappingId` matches the active AGENT viewer after the agent step + on
   *  mutations. Empty when the model has no agent mappings. */
  outputMappingCodes: Array<{ mappingId: string; code: string }>;
  /** P5 — the DIVISION BOND PARTITION table: one entry per DISTINCT Divide Agent
   *  partition spec, in first-encounter order. Each node's `_divideIdx` (baked
   *  here, read by all three emitters) is `index + 1`, and that 1-based code is
   *  what the compiled code writes into `divideRequest` — so the mode reaches the
   *  engine with NO new store lane, exactly like `stopMessages` / `_stopIdx`.
   *  Empty when the agent graph has no Divide Agent node. */
  dividePartitions: DividePartitionSpec[];
  error?: string;
}

/** The divisionEvent function signature — a SINGLE-agent function (NOT loop-
 *  wrapped): the daughter slot `idx`, its `daughterIndex`/axis defaults, then the
 *  same engine geometry/identity buffers + user attrs the behaviour fn gets
 *  (minus the loop control / request / bond buffers it doesn't need). The
 *  worker's `buildDivisionArgs` MIRRORS this.
 *
 *  MIRROR invariant (B1/B2): the trailing 3D block (`_agentZ, _agentVZ,
 *  _divideAxisZ, _fieldD` — NO `_agentForceZ`, division is force-read-only) is
 *  pushed ONLY when `is3dModel(model)`, and `buildDivisionArgs` pushes the
 *  mirror args ONLY when `s.worldDepth > 1`. These are the SAME condition
 *  (`is3dModel(model) ⟺ s.worldDepth > 1`), so the 2D arg/param lists stay
 *  byte-identical — edit BOTH together or every value shifts one slot. */
export function buildDivisionParams(model: CAModel): string {
  // Derived from the shared layout-agnostic descriptor (agentAbi.ts) — the ONE
  // source the param names, the worker's `buildDivisionArgs`, and the parity
  // harness all consume, so they can never desync in order.
  return buildAgentAbiParams('division', agentAbiShapeOf(model));
}

/** The lightweight ABI shape (primitives) the shared descriptor needs. compile.ts
 *  derives it from the model; the worker + harness from their own state — all
 *  producing the SAME ordered field list. */
export function agentAbiShapeOf(model: CAModel): AgentAbiShape {
  return {
    is3d: is3dModel(model),
    agentAttrs: agentAttrsOf(model),
    fieldAttrs: cellFieldAttrsOf(model),
    hasLookupTables: model.attributes.some(a => a.isModelAttribute && a.type === 'lookupTable'),
    // P2 — bond attributes. `bondAttrsOf` already returns [] when the Bonds
    // capability is off and drops any type outside D1's set, so the worker's
    // `agentAbiShapeOfStore` (which reads the store's `bondAttrSpecs`, built from
    // the SAME resolver) produces the identical ordered list.
    bondAttrs: bondAttrsOf(model),
    // L2 — Get Generation. The ONE field whose PARAM side is gated while the ARG
    // side is not: the worker (and the parity harness) always build the shape
    // with `usesGeneration: true`, so the value is always passed and only the
    // declaration is conditional. An extra trailing JS arg is ignored; a missing
    // one would read `undefined` — so the dangerous direction is structurally
    // impossible (the L1 `forcePassParamsFor` discipline). Gated because an
    // unconditional field would change EVERY agent model's emitted param string
    // and break the milestone's byte-identity gate.
    usesGeneration: agentUsesGeneration(model),
    // C9 / STEP 4 — the optional SoA field groups. The WORKER derives the same
    // answer from the gates SHIPPED on the init message (never recomputed there),
    // so the param list and the arg list cannot disagree.
    gates: resolveAgentFieldGates(model),
  };
}

/** The behaviourStep function signature. The worker's `buildAgentLoopArgs`
 *  MIRRORS this exactly (same order + gating) — the two silently desync
 *  otherwise (the 3D `dimsModel`/`total` bug class), so edit BOTH together.
 *  Engine-owned buffers use `_agent*` names; user attrs ride `r_<id>`/`w_<id>`
 *  (single buffer — the worker passes the same array for both — so own-agent
 *  read-modify-write sees immediate writes).
 *
 *  MIRROR invariant (B1/B2): the trailing 3D block (`_agentZ, _agentVZ,
 *  _agentForceZ, _divideAxisZ, _fieldD`) is pushed ONLY when `is3dModel(model)`,
 *  and `buildAgentLoopArgs` pushes the mirror args ONLY when `s.worldDepth > 1`.
 *  These are the SAME condition (`is3dModel(model) ⟺ s.worldDepth > 1`), so the
 *  2D arg/param lists stay byte-identical — a one-sided edit shifts every value
 *  one slot. */
/** The Agent Init Event function signature — a once-per-reset SETUP function
 *  (NOT loop-wrapped, NO per-agent `idx`). The worker's `buildAgentInitArgs`
 *  MIRRORS this exactly. Leads with the host closures (`_agentCreate` /
 *  `_agentAddToWorld`) + `_agentMaxAgents` (the by-id setters' range guard), then
 *  the writable geometry buffers, the agent attr buffers, the global/rng/field
 *  block, and `_agentSeedBase` (highWater before the Init Event = the
 *  seedIndexBase value-out). A trailing `_agentZ` rides only in 3D (Set Agent
 *  Position's z write) — MIRROR invariant with buildAgentInitArgs (B1/B2). */
export function buildAgentInitParams(model: CAModel): string {
  return buildAgentAbiParams('init', agentAbiShapeOf(model));
}

export function buildAgentLoopParams(model: CAModel): { params: string; agentAttrs: Array<{ id: string; type: string }> } {
  // Derived from the shared layout-agnostic descriptor (agentAbi.ts). The
  // behaviourStep signature — mirrored by the worker's `buildAgentLoopArgs` + the
  // parity harness's `buildArgs`, all iterating the same source so they can't
  // desync in order (the 3D `dimsModel` / `total` desync class the mirrors warned
  // about). `agentAttrs` is returned separately for the caller's r_/w_ typing.
  const agentAttrs = agentAttrsOf(model).map(a => ({ id: a.id, type: a.type }));
  return { params: buildAgentAbiParams('loop', agentAbiShapeOf(model)), agentAttrs };
}

/** Bake a Table Lookup / Table Map node's table GEOMETRY into its config —
 *  multi-axis `_dims`/`_mins` (comma-joined) or the legacy `_rowCount` +
 *  `_colCount` stride. Extracted from the cell compiler's
 *  preResolveVariegatedNodes so `compileAgentGraph` bakes the SAME geometry
 *  (it previously skipped this pre-resolve entirely, leaving `_colCount`
 *  undefined → the JS agent emit fell back to stride 1 and read the WRONG
 *  table cells for any multi-column table — the WASM/WebGPU agent emitters
 *  resolve dims from the layout and were already correct). */
function preResolveLookupTableNode(node: GraphNode, model: CAModel): void {
  const tableId = String(node.data.config.tableId ?? '');
  const tableAttr = model.attributes.find(
    a => a.id === tableId && a.isModelAttribute && a.type === 'lookupTable',
  );
  if (tableAttr && isMultiAxisTable(tableAttr)) {
    // MULTI-AXIS table: bake the full axis geometry (dims + intRange index
    // offsets) as comma-joined strings (NodeConfig holds scalars only).
    // The emit clamps per axis and indexes `Σ idxₖ·strideₖ`.
    const r = resolveAxes(tableAttr, model);
    node.data.config._dims = r.dims.join(',');
    node.data.config._mins = r.mins.join(',');
    // Legacy keys kept coherent for anything that still reads them.
    node.data.config._rowCount = r.dims[0] ?? 1;
    node.data.config._colCount = r.dims[1] ?? 1;
  } else {
    // LEGACY 2-axis table: inject the per-table row count + col stride.
    // The emit indexes the flat table as `row * _colCount + col`, so the
    // column count is the stride. Scrub any stale multi-axis bake (the
    // pre-resolve mutates the live node config, which persists across
    // recompiles — a table converted back to 2-axis must not keep _dims).
    node.data.config._rowCount = tableAttr ? (resolveKeyLabels(tableAttr.rowKeySource, model).length || 1) : 1;
    node.data.config._colCount = tableAttr ? (resolveKeyLabels(tableAttr.colKeySource, model).length || 1) : 1;
    delete node.data.config._dims;
    delete node.data.config._mins;
  }
}

export function compileAgentGraph(
  agentNodes: GraphNode[],
  agentEdges: GraphEdge[],
  model?: CAModel,
  /** FIX 4: the worker shares ONE `_stopFlag` + `stopMessages` array between the
   *  cell and agent graphs. The agent graph's stop indices are offset by the cell
   *  graph's stop-message count so `[...cellStops, ...agentStops]` aligns 1-based. */
  stopIdxBase = 0,
): AgentCompileResult {
  if (!model) return { behaviourCode: '', initCode: '', divisionCode: '', stopMessages: [], outputMappingCodes: [], dividePartitions: [], error: 'Model required.' };

  // Flatten macros, strip reroutes — same front-end pipeline the cell compiler runs.
  {
    const expanded = expandMacros(agentNodes, agentEdges, model);
    if (expanded.error) return { behaviourCode: '', initCode: '', divisionCode: '', stopMessages: [], outputMappingCodes: [], dividePartitions: [], error: expanded.error };
    agentNodes = expanded.nodes;
    agentEdges = expanded.edges;
  }
  // Same dangling-reference gate as the cell compiler — an agent graph pasted
  // from a model with different agent attributes / views must name what is
  // missing, not emit reads of undeclared identifiers.
  {
    const dangling = detectDanglingRefs(agentNodes, model);
    if (dangling) return { behaviourCode: '', initCode: '', divisionCode: '', stopMessages: [], outputMappingCodes: [], dividePartitions: [], error: dangling };
  }
  ({ nodes: agentNodes, edges: agentEdges } = collapseReroutes(agentNodes, agentEdges));
  // Neighbour State Census → the gather + one Count Matching per CONSUMED state
  // port (+ Array Length for `total`), so it reuses the existing emitters on every
  // target (no new emit). See censusExpand.ts.
  ({ nodes: agentNodes, edges: agentEdges } = expandNeighbourCensus(agentNodes, agentEdges, model));
  // Periodic Step roots → Get Generation + Math(%) + Compare + If/Then hung off
  // the single Behaviour Step, sequenced. Zero per-target emit — see
  // periodicExpand.ts. No-op when the graph has no Periodic Step.
  ({ nodes: agentNodes, edges: agentEdges } = expandPeriodicSteps(agentNodes, agentEdges, model));
  // Apply Force To Agents (array broadcast) → For Each In Array → Apply Force To
  // Agent, so it reuses the single node's emitters on every target (no new emit).
  ({ nodes: agentNodes, edges: agentEdges } = expandForceToAgents(agentNodes, agentEdges, model));
  // Multi-attribute slot expansion (agent scope) — see the cell compiler + multiAttrExpand.ts.
  ({ nodes: agentNodes, edges: agentEdges } = expandMultiAttrs(agentNodes, agentEdges, model));
  // FOV `facing` heading source → Get Self Attribute [vector] → Break Vector → wired
  // heading (BEFORE vector lowering, so the synthesized read is lowered). No-op unless
  // a Get Agents In View / Sense Hemifield uses a resolvable facing source.
  ({ nodes: agentNodes, edges: agentEdges } = lowerFacingSource(agentNodes, agentEdges, model));
  // Vector stored-attribute lowering (agent scope) — see the cell compiler + vectorAttr.ts.
  ({ nodes: agentNodes, edges: agentEdges, model } = lowerVectorAttrs(agentNodes, agentEdges, model));
  ({ nodes: agentNodes, edges: agentEdges } = expandComposites(agentNodes, agentEdges, model));
  // Agent Output Mappings: synthesize the LINKED colour passes and sequence them
  // with any user agentOutputMapping roots (the agent analogue of the cell
  // injectLinkedOutputMappings). After this the augmented graph carries one
  // agentOutputMapping root per agent mapping (user-placed or synthesized), which
  // the OM compile loop below turns into per-agent colour-pass fns. Runs BEFORE
  // CSE / adjacency so the synthesized nodes share every downstream analysis.
  ({ nodes: agentNodes, edges: agentEdges } = injectAgentLinkedOutputMappings(agentNodes, agentEdges, model));
  // D-ASYNC-CSE: accessor-CSE is sound only in SYNC agent mode. The DEFAULT agent
  // update mode is 'async' (single-buffered agent attrs — a getCellAttribute /
  // getAgentAttribute read can change after an intervening Set*Attribute write
  // within the same step), so gate CSE off there, mirroring the lattice async gate.
  const agentSync = model.centerBased?.agentUpdateMode === 'sync';
  if (agentSync) agentEdges = canonicalizeAccessorEdges(agentNodes, agentEdges, model);

  // FIX 2 — pre-resolve indicator ids to numeric indices over the AGENT graph
  // (compileGraph does this only for the cell graph). Without it get/set/update
  // Indicator emit `_indicators[-1]`.
  {
    const indicatorIdxMap = new Map((model.indicators || []).map((ind, i) => [ind.id, i] as const));
    for (const node of agentNodes) {
      const t = node.data.nodeType;
      if (t === 'getIndicator' || t === 'setIndicator' || t === 'updateIndicator') {
        const idx = indicatorIdxMap.get(node.data.config.indicatorId as string);
        node.data.config._indicatorIdx = idx !== undefined ? idx : -1;
      }
      // Table Lookup / Table Map geometry bake (the SAME pre-resolve the cell
      // compiler runs) — without it the JS agent emit read `_colCount` as 1 and
      // indexed the wrong table cells (Particle Life's species×species tables).
      if (t === 'lookupInteraction' || t === 'interactionTableMap') {
        preResolveLookupTableNode(node, model);
      }
    }
  }
  // Agent sprites — resolve each Set Agent Sprite node's sprite asset id to a
  // 1-based slot into `model.sprites` (0 = unresolved/deleted → the node emits
  // `spriteIds[idx] = 0`, clearing the agent's sprite back to the plain circle).
  // Mirrors the variegated/tag/indicator pre-resolves. The main-thread
  // renderer maps slot k → model.sprites[k-1].
  {
    const spriteSlot = new Map((model.sprites ?? []).map((s, i) => [s.id, i + 1] as const));
    for (const node of agentNodes) {
      if (node.data.nodeType === 'setAgentSprite') {
        node.data.config._spriteSlot = spriteSlot.get(node.data.config.spriteId as string) ?? 0;
      }
    }
  }
  // FIX 4 — collect agent Stop Event messages + assign 1-based _stopIdx.
  const stopMessages: string[] = [];
  for (const node of agentNodes) {
    if (node.data.nodeType === 'stopEvent') {
      stopMessages.push(String(node.data.config.message ?? 'Stop condition reached'));
      node.data.config._stopIdx = stopIdxBase + stopMessages.length;
    }
  }
  // P5 — the DIVISION BOND PARTITION table. Like `_stopIdx`, the per-node mode is
  // baked onto the config and all three targets write the resulting 1-based code
  // into the EXISTING `divideRequest` cell. UNLIKE `_stopIdx`, the table is
  // MODEL-derived and key-SORTED (see dividePartition.ts), so it does not depend
  // on this compiler running first — the WASM/WebGPU front-ends call the same
  // assignment and get the same numbers whatever order they run in.
  //
  // A model with ONE distinct spec (every shipped model) assigns code 1 — the
  // literal the pre-P5 emitters wrote — so switching a mode cannot move a byte of
  // any target's output. The mode lives entirely in the shipped table.
  const dividePartitions = assignDividePartitionCodes(agentNodes, model);
  // FIX 3 — the Set Cell Looks viewer-comparison hoist (`_isV_<safeId>`). Without
  // it a real (non-__current__) mappingId references an undefined identifier and
  // the eval'd behaviour fn throws (worker dies → generation stuck at 0).
  const viewerIdsToHoist = new Set<string>();
  for (const m of model.mappings || []) viewerIdsToHoist.add(m.id);
  for (const m of model.agentMappings || []) viewerIdsToHoist.add(m.id);
  for (const n of agentNodes) {
    if (n.data.nodeType === 'setCellLooks') {
      const mid = (n.data.config.mappingId as string) || 'default';
      if (mid !== CURRENT_VIEWER_SENTINEL) viewerIdsToHoist.add(mid);
    }
  }
  const viewerHoistLines = Array.from(viewerIdsToHoist).map(
    id => `  const _isV_${safeId(id)} = activeViewer === ${JSON.stringify(id)};`,
  );

  const behaviourNode = agentNodes.find(n => n.data.nodeType === 'behaviourStep');
  if (!behaviourNode) {
    return { behaviourCode: '', initCode: '', divisionCode: '', stopMessages, outputMappingCodes: [], dividePartitions, error: 'No Behaviour Step node in the agent graph.' };
  }

  const { nodeMap, inputToSource, inputToSources, flowOutputToTargets } = buildAdjacency(agentNodes, agentEdges);
  const loopInvariant = classifyLoopInvariant(agentNodes, inputToSource);
  const fusion = detectFusableConsumers(agentNodes, agentEdges, inputToSources, inputToSource, model, new Set<string>());

  // --- Cross-agent OVERWRITE writes are async-only (the agent form of the CA
  // grid's Fundamental #4: sync units write only themselves). In SYNC agent mode
  // the attrs are double-buffered, so a write to ANOTHER agent's slot collides
  // with that agent's OWN self-update — a lost update, order-dependent, and a
  // genuine data race on parallel targets. Forbid it in the per-agent self-update
  // loop (the BEHAVIOUR root), EXCEPT when the target is a freshly-`createAgent`'d
  // handle (spawn configuration: the staged newborn isn't concurrently written).
  // Init + Division roots are sequential (one-time setup / the structural phase),
  // never the parallel self-update loop, so they are NOT gated. Async mode is the
  // intended home for cross-agent writes (use commutative patterns for order).
  // The overwrite/accumulate split matters: Apply Force To Agent is a commutative
  // `+=` and is NOT gated (see applyForceToAgent). The WebGPU agent gate
  // (isAgentGraphWebGPUSupported) separately rejects behaviour-reachable
  // cross-agent overwrite writers with a WIRED non-spawn-handle id — the GPU's
  // parallel threads have no defined write order — so an async cross-agent-
  // overwrite model runs on JS/WASM (sequential ⇒ well-defined order).
  if (model.centerBased?.agentUpdateMode === 'sync') {
    const CROSS_AGENT_OVERWRITE = new Set(['setAgentAttribute', 'setAgentsAttribute', 'setAgentPosition', 'setAgentRadius']);
    // Behaviour-root flow reachability (BFS over flow-output edges). The gated
    // nodes are flow (`output`) nodes, each in exactly one flow chain, so this
    // isolates the behaviour loop from the init/division chains.
    const behaviourReachable = new Set<string>();
    const bfs = [behaviourNode.id];
    while (bfs.length) {
      const id = bfs.pop()!;
      if (behaviourReachable.has(id)) continue;
      behaviourReachable.add(id);
      for (const [key, targets] of flowOutputToTargets) {
        if (!key.startsWith(id + ':')) continue;
        for (const t of targets) if (!behaviourReachable.has(t.nodeId)) bfs.push(t.nodeId);
      }
    }
    for (const id of behaviourReachable) {
      const node = nodeMap.get(id);
      if (!node || !CROSS_AGENT_OVERWRITE.has(node.data.nodeType)) continue;
      // One-hop Create Agent handle exemption (newborn spawn config, not a race).
      const targetPort = node.data.nodeType === 'setAgentsAttribute' ? 'agents' : 'agentId';
      const src = inputToSource.get(`${id}:${targetPort}`);
      if (src && nodeMap.get(src.nodeId)?.data.nodeType === 'createAgent') continue;
      const label = getNodeDef(node.data.nodeType)?.label ?? node.data.nodeType;
      return { behaviourCode: '', initCode: '', divisionCode: '', stopMessages, outputMappingCodes: [], dividePartitions,
        error: `"${label}" writes another agent's state, which races that agent's own update in Synchronous agent mode. Switch to Asynchronous agent mode (Model Properties > Bond-Graph Agents), or target a Create Agent handle (spawn configuration).` };
    }
  }

  const { valueLines, preLoopValueLines, flowLines, scratchNodes } = compileRoot(
    behaviourNode, 'do', nodeMap, inputToSource, inputToSources, flowOutputToTargets,
    loopInvariant, fusion, agentNodes, agentEdges, model,
  );
  const scratchDecls = scratchNodes.map(s => buildScratchDecl(s, model));
  const { params } = buildAgentLoopParams(model);
  const bsId = behaviourNode.id;
  // C9 / STEP 4 — the optional-field gates, so the behaviourStep preamble emits
  // the typed default for a group whose ABI params were dropped.
  const gates = resolveAgentFieldGates(model);
  const is3d = is3dModel(model);  // 3D: un-hide the agent-node z ports + emit the z preamble.
  // Local Variables — per-agent scratch (the agent analogue of the cell-step
  // injection). Array allocations hoist to function scope; scalar lets + array
  // fills reset at the top of every agent iteration. Used heavily by flocking
  // (per-agent neighbour accumulators) + differential-division models. The AGENT
  // variable set (separate id-space from the cell variables).
  const variableBlocks = buildVariableJS(model.agentVariables || []);
  // P4 - the STRUCTURAL REQUEST QUEUE cursor. A per-agent-ITERATION local (the
  // queue index this agent has reached this step), declared ONLY when the graph
  // actually uses Form / Break / Rewire Bond. That usage gate is what keeps a
  // model without a queue verb byte-identical: no declaration, no emit, and
  // bondReqSlotsForModel keeps its request arrays at the pre-P4 single-slot shape.
  const usesBondReqQueue = agentNodes.some(n => BOND_REQUEST_NODE_TYPES.has(n.data.nodeType));
  const bondReqCursorDecl = usesBondReqQueue ? ['    let _brqC = 0;'] : [];

  const behaviourCode = [
    `(function(${params}) {`,
    ...scratchDecls,
    ...viewerHoistLines,   // FIX 3 — Set Cell Looks _isV_ hoist (once per step)
    ...variableBlocks.preLoop,
    ...preLoopValueLines,
    '  let _rs = _rngState[0] || 0x12345678;',
    '  for (let idx = 0; idx < highWater; idx++) {',
    '    if (!_alive[idx]) continue;',
    '    const colorIdx = idx * 4;', // Set Cell Looks colours the agent (s.colors)
    ...bondReqCursorDecl,
    ...variableBlocks.inLoopReset,
    // behaviourStep value-out preamble — the agent's own geometry/identity.
    `    const _v${bsId}_myX = _agentX[idx];`,
    `    const _v${bsId}_myY = _agentY[idx];`,
    // myZ (3D only — S12: the value-out is emitted compile-side, not in the node
    // file whose compile() is () => '', mirroring InitEvent's z/maxZ-in-the-decode).
    ...(is3d ? [`    const _v${bsId}_myZ = _agentZ[idx];`] : []),
    `    const _v${bsId}_myRadius = _agentRadius[idx];`,
    `    const _v${bsId}_myArea = Math.PI * _agentRadius[idx] * _agentRadius[idx];`,
    `    const _v${bsId}_myBondDegree = _agentBondCount[idx];`,
    // C9 SAFETY CATCH: `_agentAge` is dropped when the Lifespan field is gated
    // off (the gate is widened by a WIRED myAge, so this only fires unwired).
    `    const _v${bsId}_myAge = ${gates.age ? '_agentAge[idx]' : '0'};`,
    ...valueLines,
    '',
    ...flowLines,
    '  }',
    '  _rngState[0] = _rs;',
    '})',
  ].join('\n');

  // --- Division Event (single-agent function, runs per daughter) ---
  let divisionCode = '';
  const divNode = agentNodes.find(n => n.data.nodeType === 'divisionEvent');
  if (divNode) {
    const dv = compileRoot(
      divNode, 'do', nodeMap, inputToSource, inputToSources, flowOutputToTargets,
      loopInvariant, fusion, agentNodes, agentEdges, model,
    );
    const divScratch = dv.scratchNodes.map(s => buildScratchDecl(s, model));
    const dId = divNode.id;
    const divVars = buildVariableJS(model.agentVariables || []);
    divisionCode = [
      `(function(${buildDivisionParams(model)}) {`,
      ...divScratch,
      ...viewerHoistLines,   // FIX 3 — Set Cell Looks _isV_ hoist in the division fn too
      ...divVars.preLoop,
      ...divVars.inLoopReset.map(l => l.trimStart()).map(l => '  ' + l),
      '  const colorIdx = idx * 4;', // Set Cell Looks on a daughter (s.colors)
      // value-out preamble — alias the positional params to the node's port vars.
      `  const _v${dId}_daughterIndex = __daughterIndex;`,
      `  const _v${dId}_axisDefaultX = __axisDefaultX;`,
      `  const _v${dId}_axisDefaultY = __axisDefaultY;`,
      // axisDefaultZ (3D only) — NOT a scalar param like X/Y; it rides the
      // `_divideAxisZ` BUFFER, stamped onto both daughters at the division site
      // (worker buildDivisionArgs ABI note ~:547). Read it from the buffer here.
      ...(is3d ? [`  const _v${dId}_axisDefaultZ = _divideAxisZ[idx];`] : []),
      `  const _v${dId}_myArea = Math.PI * _agentRadius[idx] * _agentRadius[idx];`,
      '  let _rs = _rngState[0] || 0x12345678;',
      ...dv.preLoopValueLines,
      ...dv.valueLines,
      '',
      ...dv.flowLines,
      '  _rngState[0] = _rs;',
      '})',
    ].join('\n');
  }

  // --- Agent Init Event (once-per-reset SETUP function — NOT loop-wrapped) ---
  let initCode = '';
  const initNode = agentNodes.find(n => n.data.nodeType === 'agentInit');
  if (initNode) {
    const iv = compileRoot(
      initNode, 'do', nodeMap, inputToSource, inputToSources, flowOutputToTargets,
      loopInvariant, fusion, agentNodes, agentEdges, model,
    );
    const initScratch = iv.scratchNodes.map(s => buildScratchDecl(s, model));
    const iId = initNode.id;
    const initVars = buildVariableJS(model.agentVariables || []);
    initCode = [
      `(function(${buildAgentInitParams(model)}) {`,
      ...initScratch,
      ...viewerHoistLines,            // FIX 3 — Set Cell Looks _isV_ hoist in init too
      ...initVars.preLoop,
      // Local Variable scalar `let`s + array fills — run ONCE (no per-agent loop).
      ...initVars.inLoopReset.map(l => l.trimStart()).map(l => '  ' + l),
      // value-out preamble — world bounds + the seed index base (highWater pre-init).
      `  const _v${iId}_worldWidth = _fieldW;`,
      `  const _v${iId}_worldHeight = _fieldH;`,
      // worldDepth (3D only) — derived from the threaded field dims (_fieldTotal =
      // W*H*D), so no init-ABI change. 2D hides the port, so no emit there.
      ...(is3d ? [`  const _v${iId}_worldDepth = (_fieldW > 0 && _fieldH > 0) ? Math.round(_fieldTotal / (_fieldW * _fieldH)) : 1;`] : []),
      `  const _v${iId}_seedIndexBase = _agentSeedBase;`,
      '  let _rs = _rngState[0] || 0x12345678;',
      ...iv.preLoopValueLines,
      ...iv.valueLines,
      '',
      ...iv.flowLines,
      '  _rngState[0] = _rs;',
      '})',
    ].join('\n');
  }

  // --- Agent Output Mappings — compile EVERY `agentOutputMapping` root in the
  // augmented agent graph (user-placed for a STANDALONE mapping, or synthesized by
  // injectAgentLinkedOutputMappings for a LINKED one) into a per-agent colour-pass
  // fn. Shares the augmented graph's adjacency / loop-invariance / fusion. Each is
  // the SAME per-agent loop the behaviour uses (idx → r_<attr>[idx], colorIdx =
  // idx*4 → colors / spriteIds). The worker runs the one matching the active AGENT
  // viewer (its setCellLooks is guarded by `activeViewer === <mappingId>`). ---
  const outputMappingCodes: Array<{ mappingId: string; code: string }> = [];
  const omErrors: string[] = [];
  {
    const { params: omParams } = buildAgentLoopParams(model);
    for (const omNode of agentNodes.filter(n => n.data.nodeType === 'agentOutputMapping')) {
      const mappingId = (omNode.data.config.mappingId as string) || '';
      try {
        const r = compileRoot(
          omNode, 'do', nodeMap, inputToSource, inputToSources, flowOutputToTargets,
          loopInvariant, fusion, agentNodes, agentEdges, model,
        );
        const omScratch = r.scratchNodes.map(s => buildScratchDecl(s, model));
        const omVars = buildVariableJS(model.agentVariables || []);
        const code = [
          `(function(${omParams}) {`,
          ...omScratch,
          ...viewerHoistLines,
          ...omVars.preLoop,
          ...r.preLoopValueLines,
          '  let _rs = _rngState[0] || 0x12345678;',
          '  for (let idx = 0; idx < highWater; idx++) {',
          '    if (!_alive[idx]) continue;',
          '    const colorIdx = idx * 4;',
          ...bondReqCursorDecl,
          ...omVars.inLoopReset,
          ...r.valueLines,
          '',
          ...r.flowLines,
          '  }',
          '  _rngState[0] = _rs;',
          '})',
        ].join('\n');
        outputMappingCodes.push({ mappingId, code });
      } catch (e) {
        // Surface instead of swallowing: a broken standalone agent OM graph used
        // to silently produce NO colour pass ("my mapping does nothing").
        omErrors.push(`agent output mapping "${mappingId || '(unset)'}": ${(e as Error)?.message || e}`);
      }
    }
  }

  return {
    behaviourCode, initCode, divisionCode, stopMessages, outputMappingCodes, dividePartitions,
    error: omErrors.length > 0 ? omErrors.join('\n') : undefined,
  };
}

/**
 * Compile graph and create executable functions.
 */
export function compileAndBuild(
  graphNodes: GraphNode[],
  graphEdges: GraphEdge[],
  model?: CAModel,
): {
  stepFn: Function | null;
  inputColorFns: Array<{ mappingId: string; fn: Function }>;
  stepCode: string;
  inputColorCodes: Array<{ mappingId: string; code: string }>;
  outputMappingCodes: Array<{ mappingId: string; code: string }>;
  error?: string;
} {
  const result = compileGraph(graphNodes, graphEdges, model);

  let stepFn: Function | null = null;
  if (result.stepCode) {
    try {
      // eslint-disable-next-line no-eval
      stepFn = eval(result.stepCode) as Function;
    } catch (e) {
      return {
        stepFn: null, inputColorFns: [],
        stepCode: result.stepCode, inputColorCodes: result.inputColorCodes,
        outputMappingCodes: result.outputMappingCodes,
        error: `Step compilation error: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  const inputColorFns: Array<{ mappingId: string; fn: Function }> = [];
  for (const ic of result.inputColorCodes) {
    try {
      // eslint-disable-next-line no-eval
      const fn = eval(ic.code) as Function;
      inputColorFns.push({ mappingId: ic.mappingId, fn });
    } catch (e) {
      return {
        stepFn: null, inputColorFns: [],
        stepCode: result.stepCode, inputColorCodes: result.inputColorCodes,
        outputMappingCodes: result.outputMappingCodes,
        error: `InputColor compilation error: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  return {
    stepFn, inputColorFns,
    stepCode: result.stepCode, inputColorCodes: result.inputColorCodes,
    outputMappingCodes: result.outputMappingCodes, error: result.error,
  };
}

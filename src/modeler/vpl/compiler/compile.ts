import type { GraphNode, GraphEdge, CAModel } from '../../../model/types';
import { getAllNodeDefs, getNodeDef } from '../nodes/registry';
import { parseHandleId, type CompileContext } from '../types';
import { classifyLoopInvariant } from './loopInvariant';
import { safeId } from './identifierSafe';
import { detectFusableConsumers, type FusionResult } from './fusion';
import { getInlineValue } from './inlinePort';
import { INVALID_NI, packNI, NI_ARRAY_PRODUCERS } from './niCodec';
import { analyzeSinkScopes, CELL_TOP, type ScopeId } from './sinkAnalysis';
import {
  isSubAttribute,
  subAttrInfo,
  attrValueLiteralJS,
  parentMatchExprJS,
} from './subAttribute';
import { buildDirectionMap } from './variegation';

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

const MULTI_OUTPUT_TYPES = new Set(['inputColor', 'initEvent', 'getColorConstant', 'macro', 'colorScale', 'breakDownNeighborIndex', 'getFacingLabels']);

/** Check if a node's data uses multi-output variable naming */
function isMultiOutput(data: { nodeType: string; config: Record<string, string | number | boolean> }): boolean {
  if (MULTI_OUTPUT_TYPES.has(data.nodeType)) return true;
  if (data.nodeType === 'getModelAttribute' && data.config.isColorAttr) return true;
  if (data.nodeType === 'groupStatement' || data.nodeType === 'groupCounting'
    || data.nodeType === 'groupOperator') return true;
  // filterNeighbors exposes the kept array (`result`) and its length (`count`)
  // — varName resolves both via the `_v<id>_<port>` convention.
  if (data.nodeType === 'filterNeighbors') return true;
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
 * Note: `and`/`or` here return JS booleans (true/false) to match the existing
 * `arr.every(Boolean)` / `arr.some(Boolean)` semantics — this differs from
 * `Aggregate`'s and/or which returns 0/1 numerics.
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
      return `${head} let ${result} = true; for (let ${i} = 0; ${i} < ${sz}; ${i}++) if (!${elemAt(i)}) { ${result} = false; break; } const ${idx} = -1;`;
    case 'or':
      return `${head} let ${result} = false; for (let ${i} = 0; ${i} < ${sz}; ${i}++) if (${elemAt(i)}) { ${result} = true; break; } const ${idx} = -1;`;
    case 'max':
      return `${head} let ${idx} = 0; let ${result} = ${elemAt('0')}; for (let ${i} = 1; ${i} < ${sz}; ${i}++) { const ${e} = ${elemAt(i)}; if (${e} > ${result}) { ${result} = ${e}; ${idx} = ${i}; } }`;
    case 'min':
      return `${head} let ${idx} = 0; let ${result} = ${elemAt('0')}; for (let ${i} = 1; ${i} < ${sz}; ${i}++) { const ${e} = ${elemAt(i)}; if (${e} < ${result}) { ${result} = ${e}; ${idx} = ${i}; } }`;
    case 'random':
      return `${head} const ${idx} = Math.floor(Math.random() * ${sz}); const ${result} = ${elemAt(idx)};`;
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
  function routeValueEmit(nodeId: string, code: string): void {
    const scope = sinkAnalysis.emitScope.get(nodeId) ?? CELL_TOP;
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

  /** Forward-BFS from `(forEachNodeId, 'element')` through value-input consumers.
   *  Returns the transitive closure of value nodes whose computation depends on
   *  the iteration element. */
  function findElementDependents(forEachNodeId: string): Set<string> {
    const result = new Set<string>();
    const queue: Array<{ nodeId: string; portId: string }> = [{ nodeId: forEachNodeId, portId: 'element' }];
    while (queue.length > 0) {
      const src = queue.shift()!;
      const enqueueConsumer = (consumerId: string) => {
        if (result.has(consumerId)) return;
        result.add(consumerId);
        const consumerNode = nodeMap.get(consumerId);
        const consumerDef = consumerNode ? getNodeDef(consumerNode.data.nodeType) : null;
        if (!consumerDef) return;
        for (const port of consumerDef.ports) {
          if (port.kind === 'output' && port.category === 'value') {
            queue.push({ nodeId: consumerId, portId: port.id });
          }
        }
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
    // FilterNeighbors is multi-output (result + count) — caught by the
    // isMultiOutput branch above; both ports resolve via `_v<id>_<port>`.
    // JoinNeighbors intersection uses _v{id}_result scratch array; union uses _v{id} (default)
    if (sourceNode?.data.nodeType === 'joinNeighbors'
      && ((sourceNode.data.config.operation as string) || 'intersection') === 'intersection') {
      return `_v${sourceNodeId}_result`;
    }
    // ForEachInArray exposes the per-iteration element via the 'element' output port.
    // Inside the body chain, references resolve to _v{id}_element (declared at the top
    // of each iteration in compileFlowChain). Outside the body, references would be
    // unresolved — the type system does not currently catch this, but the body-only
    // scope is enforced by where compileFlowChain places the declaration.
    if (sourceNode?.data.nodeType === 'forEachInArray' && sourcePortId === 'element') {
      return `_v${sourceNodeId}_element`;
    }
    // pickNRandomNeighbors writes its output to the _result scratch array (the _work
    // scratch is internal and never read by downstream nodes).
    if (sourceNode?.data.nodeType === 'pickNRandomNeighbors') {
      return `_v${sourceNodeId}_result`;
    }
    return `_v${sourceNodeId}`;
  }

  // Track macro definitions currently being expanded (recursion guard)
  const expandingMacroDefs = new Set<string>();

  /**
   * Inline a macro's value subgraph. Compiles all internal value nodes with
   * scoped variable names, then emits output assignments.
   */
  function inlineMacroValues(macroNodeId: string, macroNode: GraphNode): void {
    if (compiled.has(`__macro_${macroNodeId}`)) return;
    compiled.add(`__macro_${macroNodeId}`);

    const macroDefId = macroNode.data.config.macroDefId as string;
    if (!macroDefId || !_model) return;
    const macroDef = (_model.macroDefs || []).find(m => m.id === macroDefId);
    if (!macroDef) {
      valueLines.push(`      // ERROR: MacroDef "${macroDefId}" not found`);
      return;
    }

    // Recursion guard
    if (expandingMacroDefs.has(macroDefId)) {
      valueLines.push(`      // ERROR: Circular macro reference "${macroDef.name}"`);
      return;
    }
    if (expandingMacroDefs.size >= 20) {
      valueLines.push(`      // ERROR: Macro nesting depth exceeded (max 20)`);
      return;
    }
    expandingMacroDefs.add(macroDefId);

    // Build local adjacency for the macro's internal graph
    const inner = buildAdjacency(macroDef.nodes, macroDef.edges);
    const prefix = `_m${macroNodeId}`;

    // Find boundary nodes
    const macroInputNode = macroDef.nodes.find(
      n => (n.data as Record<string, unknown>).nodeType === 'macroInput',
    );
    const macroOutputNode = macroDef.nodes.find(
      n => (n.data as Record<string, unknown>).nodeType === 'macroOutput',
    );

    // Build alias map: MacroInput output ports → outer variables
    const inputAliases = new Map<string, string>(); // "portId" → outer var name
    if (macroInputNode) {
      for (const ep of macroDef.exposedInputs) {
        // Find what's connected to the MacroNode's corresponding input handle in the outer graph
        const outerSource = inputToSource.get(`${macroNodeId}:${ep.portId}`);
        if (outerSource) {
          compileValueNode(outerSource.nodeId);
          inputAliases.set(ep.portId, varName(outerSource.nodeId, outerSource.portId));
        }
      }
    }

    // Scoped varName for internal nodes
    function innerVarName(srcNodeId: string, srcPortId: string): string {
      // MacroInput ports → resolve to outer aliases
      if (macroInputNode && srcNodeId === macroInputNode.id) {
        return inputAliases.get(srcPortId) || 'undefined';
      }
      const srcNode = inner.nodeMap.get(srcNodeId);
      if (srcNode && isMultiOutput(srcNode.data)) {
        return `${prefix}_v${srcNodeId}_${srcPortId}`;
      }
      if (srcNode?.data.nodeType === 'getNeighborsAttribute') {
        return `${prefix}_scr_${srcNodeId}`;
      }
      return `${prefix}_v${srcNodeId}`;
    }

    // Compile internal value nodes
    const innerCompiled = new Set<string>();

    function compileInnerValueNode(innerNodeId: string): void {
      if (innerCompiled.has(innerNodeId)) return;
      innerCompiled.add(innerNodeId);

      const iNode = inner.nodeMap.get(innerNodeId);
      if (!iNode) return;
      const nt = iNode.data.nodeType;

      // Skip boundary nodes
      if (nt === 'macroInput' || nt === 'macroOutput') return;

      // Recursive macro inlining
      if (nt === 'macro') {
        inlineNestedMacroValues(macroNodeId, innerNodeId, iNode, inner, prefix);
        return;
      }

      const iDef = getNodeDef(nt);
      if (!iDef) return;

      // Track scratch arrays
      if (nt === 'getNeighborsAttribute') {
        const nbrId = iNode.data.config.neighborhoodId as string || '_undef';
        const attrId = iNode.data.config.attributeId as string || undefined;
        scratchNodes.push({ scratchVarName: `${prefix}_scr_${innerNodeId}`, nbrId, attrId });
      }
      if (nt === 'groupStatement' || nt === 'groupCounting') {
        scratchNodes.push({ scratchVarName: `${prefix}_v${innerNodeId}_indexes`, initExpr: '[]' });
      }
      if (nt === 'getNeighborsAttrByIndexes') {
        scratchNodes.push({ scratchVarName: `${prefix}_v${innerNodeId}_vals`, initExpr: '[]' });
      }
      if (nt === 'filterNeighbors') {
        scratchNodes.push({ scratchVarName: `${prefix}_v${innerNodeId}_result`, initExpr: '[]' });
      }
      if (nt === 'joinNeighbors' && (iNode.data.config.operation as string || 'intersection') === 'intersection') {
        scratchNodes.push({ scratchVarName: `${prefix}_v${innerNodeId}_result`, initExpr: '[]' });
      }

      // Resolve inputs
      const iInputVars: Record<string, string> = {};
      for (const port of iDef.ports) {
        if (port.kind !== 'input' || port.category !== 'value') continue;
        const src = inner.inputToSource.get(`${innerNodeId}:${port.id}`);
        if (src) {
          compileInnerValueNode(src.nodeId);
          iInputVars[port.id] = innerVarName(src.nodeId, src.portId);
        } else {
          const iNode2 = inner.nodeMap.get(innerNodeId);
          if (iNode2) {
            const inlineVal = getInlineValue(port, iNode2.data.config);
            if (inlineVal !== undefined) iInputVars[port.id] = inlineVal;
          }
        }
      }

      const code = iDef.compile(innerNodeId, iNode.data.config, iInputVars, _model?.properties.boundaryTreatment, ctx);
      if (code) {
        // Rewrite variable names in emitted code to use scoped prefix
        // Note: multi-output vars use _v{id}_{port} — the trailing _ breaks \b, so we
        // also replace _v{id}_ (with trailing underscore) before the word-boundary version.
        const scopedCode = code.replace(
          new RegExp(`\\b_v${innerNodeId}_`, 'g'),
          `${prefix}_v${innerNodeId}_`,
        ).replace(
          new RegExp(`\\b_v${innerNodeId}\\b`, 'g'),
          `${prefix}_v${innerNodeId}`,
        ).replace(
          new RegExp(`\\b_scr_${innerNodeId}\\b`, 'g'),
          `${prefix}_scr_${innerNodeId}`,
        ).replace(
          new RegExp(`\\b_nb${innerNodeId}\\b`, 'g'),
          `${prefix}_nb${innerNodeId}`,
        );
        valueLines.push('      ' + scopedCode.trimEnd());
      }
    }

    // Compile all value dependencies by tracing from MacroOutput inputs
    if (macroOutputNode) {
      for (const ep of macroDef.exposedOutputs) {
        const src = inner.inputToSource.get(`${macroOutputNode.id}:${ep.portId}`);
        if (src) {
          compileInnerValueNode(src.nodeId);
          // Emit output assignment: _v${macroNodeId}_${portId} = innerVar
          const innerVar = innerVarName(src.nodeId, src.portId);
          valueLines.push(`      const _v${macroNodeId}_${ep.portId} = ${innerVar};`);
        }
      }
    }

    expandingMacroDefs.delete(macroDefId);
  }

  /**
   * Handle nested macros inside a macro subgraph.
   */
  function inlineNestedMacroValues(
    outerMacroNodeId: string,
    innerMacroNodeId: string,
    innerMacroNode: GraphNode,
    parentAdjacency: ReturnType<typeof buildAdjacency>,
    parentPrefix: string,
  ): void {
    const macroDefId = innerMacroNode.data.config.macroDefId as string;
    if (!macroDefId || !_model) return;
    const macroDef = (_model.macroDefs || []).find(m => m.id === macroDefId);
    if (!macroDef) return;

    if (expandingMacroDefs.has(macroDefId) || expandingMacroDefs.size >= 20) {
      valueLines.push(`      // ERROR: Circular/deep macro "${macroDef.name}"`);
      return;
    }
    expandingMacroDefs.add(macroDefId);

    const nestedInner = buildAdjacency(macroDef.nodes, macroDef.edges);
    const nestedPrefix = `${parentPrefix}_m${innerMacroNodeId}`;

    const nestedInputNode = macroDef.nodes.find(
      n => (n.data as Record<string, unknown>).nodeType === 'macroInput',
    );
    const nestedOutputNode = macroDef.nodes.find(
      n => (n.data as Record<string, unknown>).nodeType === 'macroOutput',
    );

    // Resolve input aliases from parent adjacency
    const nestedAliases = new Map<string, string>();
    if (nestedInputNode) {
      for (const ep of macroDef.exposedInputs) {
        const src = parentAdjacency.inputToSource.get(`${innerMacroNodeId}:${ep.portId}`);
        if (src) {
          // The source is in the parent scope — use parent's varName
          const srcNode = parentAdjacency.nodeMap.get(src.nodeId);
          if (srcNode && srcNode.data.nodeType === 'macroInput') {
            // It's the parent's MacroInput — handled by parent's alias chain
            nestedAliases.set(ep.portId, `${parentPrefix}_v${src.nodeId}_${src.portId}`);
          } else if (srcNode && isMultiOutput(srcNode.data)) {
            nestedAliases.set(ep.portId, `${parentPrefix}_v${src.nodeId}_${src.portId}`);
          } else if (srcNode?.data.nodeType === 'getNeighborsAttribute') {
            nestedAliases.set(ep.portId, `${parentPrefix}_scr_${src.nodeId}`);
          } else {
            nestedAliases.set(ep.portId, `${parentPrefix}_v${src.nodeId}`);
          }
        }
      }
    }

    function nestedVarName(srcNodeId: string, srcPortId: string): string {
      if (nestedInputNode && srcNodeId === nestedInputNode.id) {
        return nestedAliases.get(srcPortId) || 'undefined';
      }
      const srcNode = nestedInner.nodeMap.get(srcNodeId);
      if (srcNode && isMultiOutput(srcNode.data)) {
        return `${nestedPrefix}_v${srcNodeId}_${srcPortId}`;
      }
      if (srcNode?.data.nodeType === 'getNeighborsAttribute') {
        return `${nestedPrefix}_scr_${srcNodeId}`;
      }
      return `${nestedPrefix}_v${srcNodeId}`;
    }

    const nestedCompiled = new Set<string>();

    function compileNestedNode(nid: string): void {
      if (nestedCompiled.has(nid)) return;
      nestedCompiled.add(nid);
      const iNode = nestedInner.nodeMap.get(nid);
      if (!iNode) return;
      const nt = iNode.data.nodeType;
      if (nt === 'macroInput' || nt === 'macroOutput') return;
      if (nt === 'macro') {
        inlineNestedMacroValues(outerMacroNodeId, nid, iNode, nestedInner, nestedPrefix);
        return;
      }
      const iDef = getNodeDef(nt);
      if (!iDef) return;
      if (nt === 'getNeighborsAttribute') {
        const nbrId = iNode.data.config.neighborhoodId as string || '_undef';
        const attrId = iNode.data.config.attributeId as string || undefined;
        scratchNodes.push({ scratchVarName: `${nestedPrefix}_scr_${nid}`, nbrId, attrId });
      }
      if (nt === 'groupStatement' || nt === 'groupCounting') {
        scratchNodes.push({ scratchVarName: `${nestedPrefix}_v${nid}_indexes`, initExpr: '[]' });
      }
      if (nt === 'getNeighborsAttrByIndexes') {
        scratchNodes.push({ scratchVarName: `${nestedPrefix}_v${nid}_vals`, initExpr: '[]' });
      }
      if (nt === 'filterNeighbors') {
        scratchNodes.push({ scratchVarName: `${nestedPrefix}_v${nid}_result`, initExpr: '[]' });
      }
      if (nt === 'joinNeighbors' && (iNode.data.config.operation as string || 'intersection') === 'intersection') {
        scratchNodes.push({ scratchVarName: `${nestedPrefix}_v${nid}_result`, initExpr: '[]' });
      }
      const iInputVars: Record<string, string> = {};
      for (const port of iDef.ports) {
        if (port.kind !== 'input' || port.category !== 'value') continue;
        const src = nestedInner.inputToSource.get(`${nid}:${port.id}`);
        if (src) {
          compileNestedNode(src.nodeId);
          iInputVars[port.id] = nestedVarName(src.nodeId, src.portId);
        } else {
          const nNode = nestedInner.nodeMap.get(nid);
          if (nNode) {
            const inlineVal = getInlineValue(port, nNode.data.config);
            if (inlineVal !== undefined) iInputVars[port.id] = inlineVal;
          }
        }
      }
      const code = iDef.compile(nid, iNode.data.config, iInputVars, _model?.properties.boundaryTreatment, ctx);
      if (code) {
        const scopedCode = code
          .replace(new RegExp(`\\b_v${nid}_`, 'g'), `${nestedPrefix}_v${nid}_`)
          .replace(new RegExp(`\\b_v${nid}\\b`, 'g'), `${nestedPrefix}_v${nid}`)
          .replace(new RegExp(`\\b_scr_${nid}\\b`, 'g'), `${nestedPrefix}_scr_${nid}`)
          .replace(new RegExp(`\\b_nb${nid}\\b`, 'g'), `${nestedPrefix}_nb${nid}`);
        valueLines.push('      ' + scopedCode.trimEnd());
      }
    }

    if (nestedOutputNode) {
      for (const ep of macroDef.exposedOutputs) {
        const src = nestedInner.inputToSource.get(`${nestedOutputNode.id}:${ep.portId}`);
        if (src) {
          compileNestedNode(src.nodeId);
          const innerVar = nestedVarName(src.nodeId, src.portId);
          // Use parent prefix for the inner macro node's output variables
          const parentNode = parentAdjacency.nodeMap.get(innerMacroNodeId);
          if (parentNode && isMultiOutput(parentNode.data)) {
            valueLines.push(`      const ${parentPrefix}_v${innerMacroNodeId}_${ep.portId} = ${innerVar};`);
          } else {
            valueLines.push(`      const ${parentPrefix}_v${innerMacroNodeId} = ${innerVar};`);
          }
        }
      }
    }

    expandingMacroDefs.delete(macroDefId);
  }

  function compileValueNode(nodeId: string): string {
    const isBodyDep = !!(bodyDependents && bodyDependents.has(nodeId));
    if (isBodyDep) {
      // Body-dependent value: dedup against the per-scope `bodyCompiled` set so the
      // emit appears at most once per body, but DON'T touch the global `compiled` set
      // (the variable is block-scoped to the for-loop body — a cell-scope re-emit
      // would still need its own copy).
      if (bodyCompiled.has(nodeId)) return `_v${nodeId}`;
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

    // MacroNode — inline the subgraph
    if (node.data.nodeType === 'macro') {
      inlineMacroValues(nodeId, node);
      return `_v${nodeId}`;
    }

    // MacroInput/MacroOutput — never compiled directly at root level
    if (node.data.nodeType === 'macroInput' || node.data.nodeType === 'macroOutput') {
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
    if (node.data.nodeType === 'getNeighborsAttrByIndexes') {
      scratchNodes.push({ scratchVarName: `_v${nodeId}_vals`, initExpr: '[]' });
    }
    if (node.data.nodeType === 'filterNeighbors') {
      scratchNodes.push({ scratchVarName: `_v${nodeId}_result`, initExpr: '[]' });
    }
    if (node.data.nodeType === 'joinNeighbors' && (node.data.config.operation as string || 'intersection') === 'intersection') {
      scratchNodes.push({ scratchVarName: `_v${nodeId}_result`, initExpr: '[]' });
    }
    if (node.data.nodeType === 'pickNRandomNeighbors') {
      scratchNodes.push({ scratchVarName: `_v${nodeId}_work`, initExpr: '[]' });
      scratchNodes.push({ scratchVarName: `_v${nodeId}_result`, initExpr: '[]' });
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
            const srcNode = nodeMap.get(source.nodeId);
            const srcDef = srcNode ? getNodeDef(srcNode.data.nodeType) : null;
            const srcPort = srcDef?.ports.find(p => p.id === source.portId);
            inputVars[port.id] = srcPort?.isArray ? srcName : `[${srcName}]`;
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
    const compileConfig = (node.data.nodeType === 'groupStatement' || node.data.nodeType === 'groupCounting')
      ? { ...node.data.config, _indexesConnected: needsIndexes }
      : node.data.config;
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

    // For macro nodes, resolve value inputs from exposed input ports
    if (node.data.nodeType === 'macro' && _model) {
      const macroDefId = node.data.config.macroDefId as string;
      const macroDef = (_model.macroDefs || []).find(m => m.id === macroDefId);
      if (macroDef) {
        for (const ep of macroDef.exposedInputs) {
          if (ep.category === 'value') {
            const source = inputToSource.get(`${nodeId}:${ep.portId}`);
            if (source) compileValueNode(source.nodeId);
          }
        }
        // Follow flow output edges from the macro to downstream nodes
        for (const ep of macroDef.exposedOutputs) {
          if (ep.category === 'flow') {
            const targets = flowOutputToTargets.get(`${nodeId}:${ep.portId}`);
            if (targets) {
              for (const t of targets) collectValueDeps(t.nodeId);
            }
          }
        }
      }
      return;
    }

    for (const port of def.ports) {
      if (port.kind !== 'input' || port.category !== 'value') continue;
      const source = inputToSource.get(`${nodeId}:${port.id}`);
      if (source) compileValueNode(source.nodeId);
    }
    // Switch's case_N_cond and case_N_val value inputs are dynamic — not in
    // def.ports. Iterate edge map directly so their sources get pre-compiled
    // alongside the static value inputs.
    for (const [key, source] of inputToSource) {
      if (!key.startsWith(`${nodeId}:`)) continue;
      const portId = key.slice(nodeId.length + 1);
      // Skip ports we already handled via def.ports.
      if (def.ports.some(p => p.kind === 'input' && p.category === 'value' && p.id === portId)) continue;
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

  /**
   * Inline a macro's flow chain. Follows the internal flow from MacroInput's
   * flow output port through the internal subgraph.
   */
  function inlineMacroFlow(macroNodeId: string, macroNode: GraphNode, indent: string): void {
    const macroDefId = macroNode.data.config.macroDefId as string;
    if (!macroDefId || !_model) return;
    const macroDefMaybe = (_model.macroDefs || []).find(m => m.id === macroDefId);
    if (!macroDefMaybe) return;
    const md = macroDefMaybe; // local const so TS narrows in closures

    if (expandingMacroDefs.has(macroDefId) || expandingMacroDefs.size >= 20) {
      flowLines.push(`${indent}// ERROR: Circular/deep macro flow "${md.name}"`);
      return;
    }
    expandingMacroDefs.add(macroDefId);

    const inner = buildAdjacency(md.nodes, md.edges);
    const prefix = `_m${macroNodeId}`;

    // Find boundary nodes
    const macroInputNode = md.nodes.find(
      n => (n.data as Record<string, unknown>).nodeType === 'macroInput',
    );

    // Build scoped varName for reading value ports inside the flow chain
    function innerFlowVarName(srcNodeId: string, srcPortId: string): string {
      if (macroInputNode && srcNodeId === macroInputNode.id) {
        // Resolve to outer variable via alias
        const ep = md.exposedInputs.find(p => p.portId === srcPortId);
        if (ep) {
          const outerSrc = inputToSource.get(`${macroNodeId}:${ep.portId}`);
          if (outerSrc) return varName(outerSrc.nodeId, outerSrc.portId);
        }
        return 'undefined';
      }
      const srcNode = inner.nodeMap.get(srcNodeId);
      if (srcNode && isMultiOutput(srcNode.data)) {
        return `${prefix}_v${srcNodeId}_${srcPortId}`;
      }
      if (srcNode?.data.nodeType === 'getNeighborsAttribute') {
        return `${prefix}_scr_${srcNodeId}`;
      }
      return `${prefix}_v${srcNodeId}`;
    }

    // Compile internal flow chain starting from MacroInput's flow output ports
    function compileInnerFlow(srcNodeId: string, srcPortId: string, ind: string): void {
      const targets = inner.flowOutputToTargets.get(`${srcNodeId}:${srcPortId}`);
      if (!targets || targets.length === 0) return;

      for (const t of targets) {
        const iNode = inner.nodeMap.get(t.nodeId);
        if (!iNode) continue;
        const nt = iNode.data.nodeType;

        // If we hit MacroOutput, we've reached the end of the macro's flow
        if (nt === 'macroOutput') continue;

        const iDef = getNodeDef(nt);
        if (!iDef) continue;

        if (nt === 'conditional') {
          const condSrc = inner.inputToSource.get(`${iNode.id}:condition`);
          let condVar: string;
          if (condSrc) {
            condVar = innerFlowVarName(condSrc.nodeId, condSrc.portId);
          } else {
            const condPort = iDef.ports.find(p => p.id === 'condition');
            const inlineVal = condPort ? getInlineValue(condPort, iNode.data.config) : undefined;
            condVar = inlineVal ?? 'false';
          }
          const hasElse = inner.flowOutputToTargets.has(`${iNode.id}:else`);
          flowLines.push(`${ind}if (${condVar}) {`);
          compileInnerFlow(iNode.id, 'then', ind + '  ');
          if (hasElse) {
            flowLines.push(`${ind}} else {`);
            compileInnerFlow(iNode.id, 'else', ind + '  ');
          }
          flowLines.push(`${ind}}`);
        } else if (nt === 'sequence') {
          compileInnerFlow(iNode.id, 'first', ind);
          compileInnerFlow(iNode.id, 'then', ind);
          const extra = Number(iNode.data.config.extraCount) || 0;
          for (let si = 2; si < 2 + extra; si++) {
            compileInnerFlow(iNode.id, `then_${si}`, ind);
          }
        } else if (nt === 'loop') {
          const countSrc = inner.inputToSource.get(`${iNode.id}:count`);
          let countVar: string;
          if (countSrc) {
            countVar = innerFlowVarName(countSrc.nodeId, countSrc.portId);
          } else {
            const countPort = iDef.ports.find(p => p.id === 'count');
            const inlineVal = countPort ? getInlineValue(countPort, iNode.data.config) : undefined;
            countVar = inlineVal ?? '0';
          }
          const loopVar = `${prefix}_li${iNode.id}`;
          flowLines.push(`${ind}for (let ${loopVar} = 0; ${loopVar} < ${countVar}; ${loopVar}++) {`);
          compileInnerFlow(iNode.id, 'body', ind + '  ');
          flowLines.push(`${ind}}`);
        } else if (nt === 'forEachInArray') {
          const arraySrc = inner.inputToSource.get(`${iNode.id}:array`);
          if (!arraySrc) continue;
          const arrayVar = innerFlowVarName(arraySrc.nodeId, arraySrc.portId);
          const idxVar = `${prefix}_fei${iNode.id}`;
          const elementVar = `${prefix}_v${iNode.id}_element`;
          flowLines.push(`${ind}for (let ${idxVar} = 0; ${idxVar} < ${arrayVar}.length; ${idxVar}++) {`);
          flowLines.push(`${ind}  const ${elementVar} = ${arrayVar}[${idxVar}];`);
          compileInnerFlow(iNode.id, 'body', ind + '  ');
          flowLines.push(`${ind}}`);
        } else {
          // Regular action node — compile with scoped inputs
          const iInputVars: Record<string, string> = {};
          for (const port of iDef.ports) {
            if (port.kind !== 'input' || port.category !== 'value') continue;
            const src = inner.inputToSource.get(`${iNode.id}:${port.id}`);
            if (src) {
              iInputVars[port.id] = innerFlowVarName(src.nodeId, src.portId);
            } else {
              const inlineVal = getInlineValue(port, iNode.data.config);
              if (inlineVal !== undefined) iInputVars[port.id] = inlineVal;
            }
          }
          const code = iDef.compile(iNode.id, iNode.data.config, iInputVars, _model?.properties.boundaryTreatment, ctx);
          if (code) {
            // Scope the emitted code
            const scopedCode = code
              .replace(new RegExp(`\\b_v${iNode.id}\\b`, 'g'), `${prefix}_v${iNode.id}`)
              .replace(new RegExp(`\\b_scr_${iNode.id}\\b`, 'g'), `${prefix}_scr_${iNode.id}`)
              .replace(new RegExp(`\\b_nb${iNode.id}\\b`, 'g'), `${prefix}_nb${iNode.id}`);
            flowLines.push(ind + scopedCode.trimEnd());
          }
        }
      }
    }

    // Start flow from MacroInput's flow output ports
    if (macroInputNode) {
      // Find which flow ports on the MacroInput connect into the subgraph
      for (const ep of md.exposedInputs) {
        if (ep.category === 'flow') {
          compileInnerFlow(macroInputNode.id, ep.portId, indent);
        }
      }
    }

    expandingMacroDefs.delete(macroDefId);
  }

  function compileFlowChain(sourceNodeId: string, sourcePortId: string, indent: string): void {
    const targets = flowOutputToTargets.get(`${sourceNodeId}:${sourcePortId}`);
    if (!targets || targets.length === 0) return;

    for (const target of targets) {
      const node = nodeMap.get(target.nodeId);
      if (!node) continue;
      const def = getNodeDef(node.data.nodeType);
      if (!def) continue;

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
        const countSource = inputToSource.get(`${node.id}:count`);
        let countVar: string;
        if (countSource) {
          compileValueNode(countSource.nodeId);
          countVar = varName(countSource.nodeId, countSource.portId);
        } else {
          const countPort = def.ports.find(p => p.id === 'count');
          const inlineVal = countPort ? getInlineValue(countPort, node.data.config) : undefined;
          countVar = inlineVal ?? '0';
        }
        flowLines.push(`${indent}for (let _li${node.id} = 0; _li${node.id} < ${countVar}; _li${node.id}++) {`);
        flushBranchValues(`${node.id}:body`, flowLines, indent + '  ');
        compileFlowChain(node.id, 'body', indent + '  ');
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
      } else if (node.data.nodeType === 'macro') {
        // Inline macro flow chain
        inlineMacroFlow(node.id, node, indent);
        // After the macro's internal flow, continue with any flow outputs from the MacroNode
        // (MacroOutput flow ports map to MacroNode's flow output ports)
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
        const code = def.compile(node.id, node.data.config, inputVars, model?.properties.boundaryTreatment, ctx);
        if (code) flowLines.push(indent + code.trimEnd());
      }
    }
  }

  compileFlowChain(rootNode.id, rootFlowPort, '      ');

  return { valueLines, preLoopValueLines, flowLines, scratchNodes };
}

// ---------------------------------------------------------------------------
// Build parameter lists from model (without idx — loop is inside)
// ---------------------------------------------------------------------------

function buildLoopParams(model: CAModel): {
  params: string;
  cellAttrs: Array<{ id: string; type: string }>;
  neighborhoods: Array<{ id: string }>;
} {
  const isAsync = model.properties.updateMode === 'asynchronous';
  const variegated = !!model.variegatedCells?.enabled;
  const cellAttrs = model.attributes
    .filter(a => !a.isModelAttribute)
    .map(a => ({ id: a.id, type: a.type }));
  const neighborhoods = model.neighborhoods.map(n => ({ id: n.id }));

  const parts: string[] = ['total', 'W', 'H'];
  for (const a of cellAttrs) parts.push(`r_${a.id}`);
  for (const a of cellAttrs) parts.push(`w_${a.id}`);
  for (const n of neighborhoods) { parts.push(`nIdx_${n.id}`); parts.push(`nSz_${n.id}`); }
  parts.push('modelAttrs', 'colors', 'activeViewer', '_indicators', '_linkedResults', '_rngState', '_stopFlag');
  // Variegated Cells: r/w orientation arrays + flat facePatternLookup +
  // _interactionTables object. Always emit these when the feature is on so
  // the worker's buildLoopArgs (in sim.worker.ts) and this signature stay
  // in lockstep. `order` is always last for async mode.
  if (variegated) parts.push('r_orientation', 'w_orientation', '_facePatternLookup', '_interactionTables');
  if (isAsync) parts.push('order');

  return { params: parts.join(', '), cellAttrs, neighborhoods };
}

/** Per-cell params (for InputColor which is called per-cell) */
function buildCellParams(model: CAModel): string {
  const cellAttrs = model.attributes.filter(a => !a.isModelAttribute);
  const neighborhoods = model.neighborhoods;
  const variegated = !!model.variegatedCells?.enabled;
  const parts: string[] = ['idx', 'total', 'W', 'H'];
  for (const a of cellAttrs) parts.push(`r_${a.id}`);
  for (const a of cellAttrs) parts.push(`w_${a.id}`);
  for (const n of neighborhoods) { parts.push(`nIdx_${n.id}`); parts.push(`nSz_${n.id}`); }
  parts.push('modelAttrs', 'colors', 'activeViewer', '_indicators', '_linkedResults', '_rngState', '_stopFlag');
  if (variegated) parts.push('r_orientation', 'w_orientation', '_facePatternLookup', '_interactionTables');
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
   *  (not on Randomize, not on Load State). Empty string when no Init Event
   *  Node is present. */
  initCode: string;
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
  if (graphNodes.length === 0) {
    return { stepCode: '', initCode: '', inputColorCodes: [], outputMappingCodes: [], stopMessages: [], error: 'No nodes in graph.' };
  }

  if (!model) {
    return { stepCode: '', initCode: '', inputColorCodes: [], outputMappingCodes: [], stopMessages: [], error: 'Model required for SoA compilation.' };
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

  const { nodeMap, inputToSource, inputToSources, flowOutputToTargets } = buildAdjacency(graphNodes, graphEdges);

  // Pre-resolve neighborhood tag names to indices for GetNeighborAttributeByTag nodes
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
        const coord = (slot >= 0 && nbr) ? nbr.coords[slot] : undefined;
        packed.push(coord ? packNI(coord[0]!, coord[1]!) : INVALID_NI);
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
      const coord = (slot >= 0 && nbr) ? nbr.coords[slot] : undefined;
      node.data.config._resolvedPacked = coord
        ? packNI(coord[0]!, coord[1]!)
        : INVALID_NI;
    }
    if (node.data.nodeType === 'getAllNeighborIndexes') {
      // Wave A.6: pre-resolve packed (dr, dc) for every slot of the
      // configured neighborhood. Emit becomes a literal array of i32s.
      const nbrId = node.data.config.neighborhoodId as string;
      const nbr = model.neighborhoods.find(n => n.id === nbrId);
      const packed: number[] = nbr
        ? nbr.coords.map(([dr, dc]) => packNI(dr, dc))
        : [];
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
  for (const def of (model.macroDefs || [])) preResolveIndicators(def.nodes);

  // Pre-assign stop-event indices. Each StopEventNode gets a stable 1-based
  // index (0 reserved for "no stop requested"); the emitted code writes that
  // index into `_stopFlag[0]`. Worker reads the flag after each step call and
  // uses (idx - 1) to look up the user's message from `stopMessages`.
  // Scoped across main graph + all macro defs so IDs are globally unique.
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
  for (const def of (model.macroDefs || [])) preResolveStopEvents(def.nodes);

  // Pre-resolve variegated nodes' compile-time fields:
  //   - getFacingLabels: source attr id + baked directionMap from its neighborhood
  //   - lookupInteraction: labelCount = faceLabels.length + 1 (includes implicit `none`)
  // Skipped when variegation is off — those node types are also filtered out
  // of the palette in that case, so the user can't easily place them.
  const variegationOn = !!model.variegatedCells?.enabled;
  const variegatedSourceAttrId = variegationOn ? (model.variegatedCells?.sourceAttributeId ?? '') : '';
  const variegatedLabelCount = variegationOn ? ((model.variegatedCells?.faceLabels.length ?? 0) + 1) : 1;
  const modelForVariegated = model!;
  function preResolveVariegatedNodes(nodes: GraphNode[]): void {
    for (const node of nodes) {
      if (node.data.nodeType === 'getFacingLabels') {
        const nbrId = node.data.config.neighborhoodId as string;
        const nbr = modelForVariegated.neighborhoods.find(n => n.id === nbrId);
        const directionMap = buildDirectionMap(nbr);
        node.data.config._directionMap = JSON.stringify(Array.from(directionMap));
        node.data.config._sourceAttrId = variegatedSourceAttrId;
      }
      if (node.data.nodeType === 'lookupInteraction') {
        node.data.config._labelCount = variegatedLabelCount;
      }
    }
  }
  preResolveVariegatedNodes(graphNodes);
  for (const def of (model.macroDefs || [])) preResolveVariegatedNodes(def.nodes);

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
  const fusion = detectFusableConsumers(graphNodes, graphEdges, inputToSources, inputToSource, model);

  const { params: loopParams, cellAttrs } = buildLoopParams(model);
  const cellParams = buildCellParams(model);

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
  const bulkCopyLines = isAsync
    ? []
    : cellAttrs.filter(a => !subAttrInfoById.get(a.id)).map(a => `  w_${a.id}.set(r_${a.id});`);
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
      if (n.data.nodeType === 'setColorViewer') {
        viewerIdsToHoist.add((n.data.config.mappingId as string) || 'default');
      }
    }
  };
  collectViewerRefs(graphNodes);
  for (const def of model.macroDefs || []) collectViewerRefs(def.nodes);
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

    // Build linked indicator aggregation code (injected into the loop)
    const linked = buildLinkedIndicatorCode(model);

    if (isAsync) {
      // Async mode: iterate cells via shuffled order array
      stepCode = [
        `(function(${loopParams}) {`,
        ...scratchDecls,
        ...viewerHoistLines,
        ...preLoopValueLines,
        ...linked.preLoopDecls,
        '  let _rs = _rngState[0] || 0x12345678;',
        '  for (let _i = 0; _i < total; _i++) {',
        '    const idx = order[_i];',
        '    const colorIdx = idx * 4;',
        // Wave A.6: per-cell (row, col) decoded from idx — used by NI access
        // helpers (filterNeighbors, get/setNeighborAttributeByIndex, etc.).
        // Two ops per cell, amortised across all NI accesses in the cell body.
        '    const _row = (idx / W) | 0;',
        '    const _col = idx - _row * W;',
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
      // Sync mode: sequential iteration
      stepCode = [
        `(function(${loopParams}) {`,
        ...scratchDecls,
        ...bulkCopyLines,
        ...viewerHoistLines,
        ...preLoopValueLines,
        ...linked.preLoopDecls,
        '  let _rs = _rngState[0] || 0x12345678;',
        '  for (let idx = 0; idx < total; idx++) {',
        '    const colorIdx = idx * 4;',
        // Wave A.6: per-cell (row, col) decoded from idx — see async branch comment.
        '    const _row = (idx / W) | 0;',
        '    const _col = idx - _row * W;',
        // Sub-attribute conditional copy: scrub non-matching cells to defaultValue,
        // copy from r_ to w_ for matching cells. Replaces the bulk .set() that
        // regular attrs use. User rule writes later overwrite w_ as needed.
        ...subAttrSyncCopyLines,
        ...valueLines,
        '',
        ...flowLines,
        ...linked.inLoopLines,
        '  }',
        '  _rngState[0] = _rs;',
        ...linked.postLoopLines,
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
      '  const _row = (idx / W) | 0;',
      '  const _col = idx - _row * W;',
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
  const omParamParts: string[] = ['total', 'W', 'H'];
  for (const a of cellAttrs) omParamParts.push(`r_${a.id}`);
  for (const a of cellAttrs) omParamParts.push(`w_${a.id}`);
  const neighborhoods = model.neighborhoods.map(n => ({ id: n.id }));
  for (const n of neighborhoods) { omParamParts.push(`nIdx_${n.id}`); omParamParts.push(`nSz_${n.id}`); }
  omParamParts.push('modelAttrs', 'colors', 'activeViewer', '_indicators', '_linkedResults', '_rngState', '_stopFlag');
  if (model.variegatedCells?.enabled) {
    omParamParts.push('r_orientation', 'w_orientation', '_facePatternLookup', '_interactionTables');
  }
  const omParams = omParamParts.join(', ');

  for (const omNode of outputMappingNodes) {
    const mappingId = omNode.data.config.mappingId as string || '';
    const { valueLines, preLoopValueLines, flowLines, scratchNodes } = compileRoot(
      omNode, 'do', nodeMap, inputToSource, inputToSources, flowOutputToTargets, loopInvariant, fusion, graphNodes, graphEdges, model,
    );
    const scratchDecls = scratchNodes.map(s => buildScratchDecl(s, model));
    const code = [
      `(function(${omParams}) {`,
      ...scratchDecls,
      ...viewerHoistLines,
      ...preLoopValueLines,
      '  let _rs = _rngState[0] || 0x12345678;',
      '  for (let idx = 0; idx < total; idx++) {',
      '    const colorIdx = idx * 4;',
      // Wave A.6: per-cell (row, col) decoded from idx for NI access helpers.
      '    const _row = (idx / W) | 0;',
      '    const _col = idx - _row * W;',
      ...valueLines,
      '',
      ...flowLines,
      '  }',
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
      '    const _row = (idx / W) | 0;',
      '    const _col = idx - _row * W;',
      `    const _v${initId}_x = _col;`,
      `    const _v${initId}_y = _row;`,
      `    const _v${initId}_maxX = W - 1;`,
      `    const _v${initId}_maxY = H - 1;`,
      ...subAttrSyncCopyLines,
      ...valueLines,
      '',
      ...flowLines,
      '  }',
      '  _rngState[0] = _rs;',
      '})',
    ].join('\n');
  }

  const error = asyncValidationError
    ?? variegatedValidationError
    ?? (!stepNode ? 'No Step node found. Add a Step node as the entry point.' : undefined);

  return { stepCode, initCode, inputColorCodes, outputMappingCodes, stopMessages, error };
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

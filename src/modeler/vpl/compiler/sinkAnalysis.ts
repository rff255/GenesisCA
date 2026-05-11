/**
 * Target-independent sink-scope analyzer.
 *
 * Given a (post-macro-expansion) flat graph and a flow root, computes — for
 * every value-producing node referenced anywhere in the flow tree — the
 * deepest scope where it can be emitted such that every use is dominated by
 * the emit point. This is the lowest-common-ancestor of all its use sites in
 * the flow tree, a.k.a. lazy code motion / partial dead code elimination.
 *
 * Algorithm:
 *   1. Walk flow from the root, assigning each branch port (then/else/body/
 *      case_N/default) a ScopeId. Sequence is transparent (no new scope).
 *   2. For every flow/action node F at scope S with a value-input source V,
 *      record S as a direct use of V.
 *   3. Build the value→value-consumer DAG. Propagate uses through it to a
 *      fixpoint (each value's use-set absorbs its value-consumers' use-sets).
 *   4. For each value V, emitScope[V] = LCA(uses(V)) in the scope tree.
 *
 * Consumers can then ask "which values land at scope S?" via valuesByScope,
 * already sorted in dependency order.
 *
 * Note: the input graph must be flat (macros expanded). Macros are not
 * recognised as flow nodes here; expanding them upstream keeps this module
 * target-independent.
 */

import type { GraphNode, GraphEdge } from '../../../model/types';
import { parseHandleId } from '../types';
import { getNodeDef } from '../nodes/registry';

export type ScopeId = string;
export const CELL_TOP: ScopeId = 'cellTop';

export type ScopeKind =
  | { kind: 'cellTop' }
  | { kind: 'then'; flowNodeId: string }
  | { kind: 'else'; flowNodeId: string }
  | { kind: 'loopBody'; flowNodeId: string }
  | { kind: 'forEachBody'; flowNodeId: string }
  | { kind: 'switchCase'; flowNodeId: string; caseIndex: number }
  | { kind: 'switchDefault'; flowNodeId: string };

/** Sequence runs both `first` and `then` outputs at its own scope — no new
 *  child scope. Adding a new transparent flow type? Add it here. */
const TRANSPARENT_FLOW_TYPES = new Set(['sequence']);

export interface SinkAnalysisInput {
  /** Graph nodes — flat, post-macro-expansion. */
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Entry flow node (e.g., the StepNode / InputColorNode / OutputMappingNode). */
  rootNodeId: string;
  /** Which flow output port on the root starts the chain (e.g., 'step'). */
  rootFlowPortId: string;
}

export interface SinkAnalysisResult {
  /** valueNodeId → scope where it should be emitted (LCA of its uses). */
  emitScope: Map<string, ScopeId>;
  /** scope → values emitted there, in dependency order (sources first). */
  valuesByScope: Map<ScopeId, string[]>;
  /** scope tree: parent scope, with CELL_TOP's parent = null. */
  scopeParent: Map<ScopeId, ScopeId | null>;
  /** scope tree: depth (CELL_TOP = 0). */
  scopeDepth: Map<ScopeId, number>;
  /** For each scope, what kind of branch it is. */
  scopeKind: Map<ScopeId, ScopeKind>;
}

interface Adjacency {
  nodeMap: Map<string, GraphNode>;
  inputToSource: Map<string, { nodeId: string; portId: string }>;
  inputToSources: Map<string, Array<{ nodeId: string; portId: string }>>;
  flowOutputToTargets: Map<string, Array<{ nodeId: string; portId: string }>>;
}

function buildAdjacency(nodes: GraphNode[], edges: GraphEdge[]): Adjacency {
  const nodeMap = new Map<string, GraphNode>();
  for (const n of nodes) nodeMap.set(n.id, n);

  const inputToSource = new Map<string, { nodeId: string; portId: string }>();
  const inputToSources = new Map<string, Array<{ nodeId: string; portId: string }>>();
  const flowOutputToTargets = new Map<string, Array<{ nodeId: string; portId: string }>>();

  for (const edge of edges) {
    const sourceHandle = parseHandleId(edge.sourceHandle);
    const targetHandle = parseHandleId(edge.targetHandle);
    if (!sourceHandle || !targetHandle) continue;

    if (targetHandle.category === 'value') {
      const key = `${edge.target}:${targetHandle.portId}`;
      // First source wins for the single-source map (matches existing compiler).
      if (!inputToSource.has(key)) {
        inputToSource.set(key, { nodeId: edge.source, portId: sourceHandle.portId });
      }
      const arr = inputToSources.get(key) ?? [];
      arr.push({ nodeId: edge.source, portId: sourceHandle.portId });
      inputToSources.set(key, arr);
    }

    if (sourceHandle.category === 'flow') {
      const key = `${edge.source}:${sourceHandle.portId}`;
      const arr = flowOutputToTargets.get(key) ?? [];
      arr.push({ nodeId: edge.target, portId: targetHandle.portId });
      flowOutputToTargets.set(key, arr);
    }
  }

  return { nodeMap, inputToSource, inputToSources, flowOutputToTargets };
}

export function analyzeSinkScopes(input: SinkAnalysisInput): SinkAnalysisResult {
  const { nodes, edges, rootNodeId, rootFlowPortId } = input;
  const adj = buildAdjacency(nodes, edges);

  const scopeParent = new Map<ScopeId, ScopeId | null>();
  const scopeDepth = new Map<ScopeId, number>();
  const scopeKind = new Map<ScopeId, ScopeKind>();
  scopeParent.set(CELL_TOP, null);
  scopeDepth.set(CELL_TOP, 0);
  scopeKind.set(CELL_TOP, { kind: 'cellTop' });

  function registerScope(id: ScopeId, parent: ScopeId, kind: ScopeKind): void {
    if (scopeParent.has(id)) return; // already registered
    scopeParent.set(id, parent);
    scopeDepth.set(id, (scopeDepth.get(parent) ?? 0) + 1);
    scopeKind.set(id, kind);
  }

  /** directUses[V] = set of scopes where V is referenced by a flow/action consumer. */
  const directUses = new Map<string, Set<ScopeId>>();
  function recordUse(valueNodeId: string, scope: ScopeId): void {
    let s = directUses.get(valueNodeId);
    if (!s) { s = new Set(); directUses.set(valueNodeId, s); }
    s.add(scope);
  }

  /** Iterate value inputs of `nodeId` and record each source as a direct use at `scope`.
   *  Walks BOTH static ports (`def.ports`) and any dynamic value-input edges
   *  (e.g., switch's `case_N_cond` / `case_N_val` ports — not declared in static
   *  port lists but present in the edge map). */
  function recordValueInputs(nodeId: string, scope: ScopeId): void {
    const node = adj.nodeMap.get(nodeId);
    if (!node) return;
    const def = getNodeDef(node.data.nodeType);
    if (!def) return;
    const seenPortIds = new Set<string>();
    for (const port of def.ports) {
      if (port.kind !== 'input' || port.category !== 'value') continue;
      seenPortIds.add(port.id);
      if (port.isArray) {
        const multi = adj.inputToSources.get(`${nodeId}:${port.id}`);
        if (multi) for (const s of multi) recordUse(s.nodeId, scope);
      } else {
        const single = adj.inputToSource.get(`${nodeId}:${port.id}`);
        if (single) recordUse(single.nodeId, scope);
      }
    }
    // Dynamic value inputs (switch case_N_cond / case_N_val) aren't in
    // def.ports — pick them up from the edge map.
    for (const [key, source] of adj.inputToSource) {
      if (!key.startsWith(`${nodeId}:`)) continue;
      const portId = key.slice(nodeId.length + 1);
      if (seenPortIds.has(portId)) continue;
      recordUse(source.nodeId, scope);
    }
  }

  /** Visited-set for flow walk — guards against re-walking children on revisit. */
  const visitedFlow = new Set<string>();

  /** Per flow node, every parent scope it was reached from. Size > 1 means the
   *  flow node is a "diamond entry" — `compileFlowChain` will emit its body
   *  inline at each parent path. Value declarations placed inside the body
   *  would only appear in one path's emission; references in the other path's
   *  emission would be undeclared. Used by `diamondHoist` below to push such
   *  values up to the LCA of the diamond's containing scopes. */
  const flowNodeContainingScopes = new Map<string, Set<ScopeId>>();

  function walkFlowOutput(srcNodeId: string, srcPortId: string, parentScope: ScopeId): void {
    const targets = adj.flowOutputToTargets.get(`${srcNodeId}:${srcPortId}`);
    if (!targets) return;
    for (const t of targets) walkFlowNode(t.nodeId, parentScope);
  }

  function walkFlowNode(nodeId: string, parentScope: ScopeId): void {
    // Record this parent path. Multiple paths to the same flow node accumulate;
    // a multi-element set marks `nodeId` as a diamond entry.
    let containing = flowNodeContainingScopes.get(nodeId);
    if (!containing) { containing = new Set(); flowNodeContainingScopes.set(nodeId, containing); }
    containing.add(parentScope);

    const node = adj.nodeMap.get(nodeId);
    if (!node) return;
    const type = node.data.nodeType;

    // Every flow/action node's value inputs are used at its own scope. Must run
    // on EVERY visit (not just the first), because a multi-parent flow node's
    // value inputs — e.g., a Conditional's `condition` source wired to a node
    // reached from two switch cases — need use scopes from every path. The
    // LCA(uses) then naturally lands at the diamond's join.
    recordValueInputs(nodeId, parentScope);

    // Skip recursion into children on revisit. The children are the same
    // regardless of which parent path we arrived through; re-walking them
    // would re-record the same scope keys with no new information. Diamond
    // bodies still get correctly hoisted via `diamondHoist` below.
    if (visitedFlow.has(nodeId)) return;
    visitedFlow.add(nodeId);

    if (TRANSPARENT_FLOW_TYPES.has(type)) {
      walkFlowOutput(nodeId, 'first', parentScope);
      walkFlowOutput(nodeId, 'then', parentScope);
      return;
    }

    if (type === 'conditional') {
      const thenS = `${nodeId}:then`;
      registerScope(thenS, parentScope, { kind: 'then', flowNodeId: nodeId });
      walkFlowOutput(nodeId, 'then', thenS);
      const elseS = `${nodeId}:else`;
      registerScope(elseS, parentScope, { kind: 'else', flowNodeId: nodeId });
      walkFlowOutput(nodeId, 'else', elseS);
      return;
    }

    if (type === 'loop') {
      const bodyS = `${nodeId}:body`;
      registerScope(bodyS, parentScope, { kind: 'loopBody', flowNodeId: nodeId });
      walkFlowOutput(nodeId, 'body', bodyS);
      return;
    }

    if (type === 'forEachInArray') {
      const bodyS = `${nodeId}:body`;
      registerScope(bodyS, parentScope, { kind: 'forEachBody', flowNodeId: nodeId });
      walkFlowOutput(nodeId, 'body', bodyS);
      return;
    }

    if (type === 'switch') {
      const caseCount = Number(node.data.config.caseCount) || 0;
      if (caseCount === 0) {
        // Degenerate switch with no cases: default (if any) runs unconditionally
        // at the switch's own scope — no new child scope created. Matches the
        // JS emit which inlines the default at parent indent.
        walkFlowOutput(nodeId, 'default', parentScope);
        return;
      }
      for (let ci = 0; ci < caseCount; ci++) {
        const caseS = `${nodeId}:case_${ci}`;
        registerScope(caseS, parentScope, { kind: 'switchCase', flowNodeId: nodeId, caseIndex: ci });
        walkFlowOutput(nodeId, `case_${ci}`, caseS);
      }
      if (adj.flowOutputToTargets.has(`${nodeId}:default`)) {
        const defS = `${nodeId}:default`;
        registerScope(defS, parentScope, { kind: 'switchDefault', flowNodeId: nodeId });
        walkFlowOutput(nodeId, 'default', defS);
      }
      return;
    }

    // Macros are NOT handled here — caller must expand them first. If we encounter
    // a macro node, treat it as a terminal action (its internal flow is invisible).
    // Action nodes (setAttribute, updateIndicator, setColorViewer, stopEvent, ...)
    // have no flow outputs to recurse into.
  }

  // Walk from the root's flow output port. The root itself (StepNode /
  // InputColorNode / OutputMappingNode) is a flow source — its value outputs
  // are externally provided function params, not computed in the body, so it's
  // not a "use site" for any value node.
  walkFlowOutput(rootNodeId, rootFlowPortId, CELL_TOP);

  // -----------------------------------------------------------------
  // Build value → value-consumer DAG.
  // For each value-input edge whose TARGET is also a value-producing node
  // (i.e., has at least one value-output port), we add producer → consumer.
  // -----------------------------------------------------------------

  function isValueNode(nodeId: string): boolean {
    const node = adj.nodeMap.get(nodeId);
    if (!node) return false;
    const def = getNodeDef(node.data.nodeType);
    if (!def) return false;
    return def.ports.some(p => p.kind === 'output' && p.category === 'value');
  }

  const valueConsumers = new Map<string, Set<string>>(); // producerId → set of value-consumer node ids
  function addConsumer(producer: string, consumer: string): void {
    let s = valueConsumers.get(producer);
    if (!s) { s = new Set(); valueConsumers.set(producer, s); }
    s.add(consumer);
  }

  for (const node of nodes) {
    const def = getNodeDef(node.data.nodeType);
    if (!def) continue;
    // Only nodes that produce a value can be consumers we care about for DAG propagation.
    // BUT non-value-producing consumers (flow/action nodes) ARE already in directUses.
    // For value→value edges, we only need consumers that are themselves value-producing.
    if (!isValueNode(node.id)) continue;
    for (const port of def.ports) {
      if (port.kind !== 'input' || port.category !== 'value') continue;
      const sources = port.isArray
        ? (adj.inputToSources.get(`${node.id}:${port.id}`) ?? [])
        : (() => { const s = adj.inputToSource.get(`${node.id}:${port.id}`); return s ? [s] : []; })();
      for (const s of sources) addConsumer(s.nodeId, node.id);
    }
  }

  // -----------------------------------------------------------------
  // Propagate uses through the value DAG to fixpoint.
  // For each value V, V.allUses = V.directUses ∪ (union of W.allUses for each
  // value-consumer W of V).
  // Worklist algorithm — better than naive fixpoint on large graphs.
  // -----------------------------------------------------------------

  const allUses = new Map<string, Set<ScopeId>>();
  // Seed with direct uses.
  for (const [k, v] of directUses) allUses.set(k, new Set(v));

  // Worklist: start with every value that has direct uses.
  const worklist: string[] = [...allUses.keys()];
  while (worklist.length > 0) {
    const w = worklist.pop()!;
    const wUses = allUses.get(w);
    if (!wUses) continue;
    // For each producer P of w (where P → w in value DAG), propagate w's uses to P.
    // Equivalently: for each value-edge whose consumer is w, walk back to producer P.
    const node = adj.nodeMap.get(w);
    if (!node) continue;
    const def = getNodeDef(node.data.nodeType);
    if (!def) continue;
    for (const port of def.ports) {
      if (port.kind !== 'input' || port.category !== 'value') continue;
      const sources = port.isArray
        ? (adj.inputToSources.get(`${w}:${port.id}`) ?? [])
        : (() => { const s = adj.inputToSource.get(`${w}:${port.id}`); return s ? [s] : []; })();
      for (const s of sources) {
        let pUses = allUses.get(s.nodeId);
        if (!pUses) { pUses = new Set(); allUses.set(s.nodeId, pUses); }
        let added = false;
        for (const scope of wUses) {
          if (!pUses.has(scope)) { pUses.add(scope); added = true; }
        }
        if (added) worklist.push(s.nodeId);
      }
    }
  }

  // -----------------------------------------------------------------
  // Compute element-dependency map for each ForEachInArray node.
  // A value depending on a forEach's `element` output cannot be hoisted out
  // of that forEach's body — `element` is only in scope inside the body.
  // -----------------------------------------------------------------

  const elementDependentsByForEach = new Map<string, Set<string>>();
  function forwardValueConsumers(seedNodeId: string, seedPortId: string): Set<string> {
    const result = new Set<string>();
    const queue: Array<{ nodeId: string; portId: string }> = [{ nodeId: seedNodeId, portId: seedPortId }];
    while (queue.length > 0) {
      const src = queue.shift()!;
      const enqueueConsumer = (cid: string): void => {
        if (result.has(cid)) return;
        result.add(cid);
        const cnode = adj.nodeMap.get(cid);
        if (!cnode) return;
        const cdef = getNodeDef(cnode.data.nodeType);
        if (!cdef) return;
        for (const cport of cdef.ports) {
          if (cport.kind === 'output' && cport.category === 'value') {
            queue.push({ nodeId: cid, portId: cport.id });
          }
        }
      };
      for (const [key, source] of adj.inputToSource) {
        if (source.nodeId === src.nodeId && source.portId === src.portId) {
          const cid = key.split(':')[0];
          if (cid) enqueueConsumer(cid);
        }
      }
      for (const [key, sources] of adj.inputToSources) {
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
  for (const node of nodes) {
    if (node.data.nodeType === 'forEachInArray') {
      elementDependentsByForEach.set(node.id, forwardValueConsumers(node.id, 'element'));
    }
  }

  /** Walk up from `scope` past loop/forEach bodies where `valueId` isn't forced
   *  to live there. For Loop nodes the only iteration variable (`_li`) has no
   *  value output, so nothing can depend on it — always hoist past. For ForEach,
   *  hoist only when the value isn't in the body's elementDependents set. */
  function hoistPastLoops(valueId: string, scope: ScopeId): ScopeId {
    let current = scope;
    while (current !== CELL_TOP) {
      const k = scopeKind.get(current);
      if (!k) break;
      if (k.kind === 'loopBody') {
        current = scopeParent.get(current) ?? CELL_TOP;
      } else if (k.kind === 'forEachBody') {
        const deps = elementDependentsByForEach.get(k.flowNodeId);
        if (deps && deps.has(valueId)) break;
        current = scopeParent.get(current) ?? CELL_TOP;
      } else {
        break;
      }
    }
    return current;
  }

  // -----------------------------------------------------------------
  // Compute LCA per value.
  // -----------------------------------------------------------------

  function lca2(a: ScopeId, b: ScopeId): ScopeId {
    if (a === b) return a;
    let da = scopeDepth.get(a) ?? 0;
    let db = scopeDepth.get(b) ?? 0;
    let aa = a;
    let bb = b;
    while (da > db) {
      const p = scopeParent.get(aa);
      if (!p) break;
      aa = p; da--;
    }
    while (db > da) {
      const p = scopeParent.get(bb);
      if (!p) break;
      bb = p; db--;
    }
    while (aa !== bb) {
      const pa = scopeParent.get(aa);
      const pb = scopeParent.get(bb);
      if (!pa || !pb) return CELL_TOP;
      aa = pa; bb = pb;
    }
    return aa;
  }

  // -----------------------------------------------------------------
  // Diamond-taint analysis: identify scopes inside a multi-parent (DAG)
  // region. Values whose tree-LCA lands in a tainted scope must hoist OUT,
  // because compileFlowChain emits diamond bodies multiple times (once per
  // parent path) and value declarations would only live in one of them.
  //
  // Seed: containing scopes + body scopes of any flow node reached via
  //       multiple parent scopes (i.e., flowNodeContainingScopes[F].size > 1).
  // Closure: a scope is tainted if any of its ancestors (up to cellTop) is
  //          in the seed — descendants of a tainted scope are themselves
  //          reached via multiple parent expansions of the ancestor's
  //          re-emitted body.
  // -----------------------------------------------------------------

  const taintedSeed = new Set<ScopeId>();
  for (const [flowNodeId, containing] of flowNodeContainingScopes) {
    if (containing.size <= 1) continue;
    // Containing scopes — declaring here is only visible on one path.
    for (const s of containing) taintedSeed.add(s);
    // Body scopes — re-emitted by compileFlowChain at each parent path.
    for (const [scopeId, kind] of scopeKind) {
      if (kind.kind === 'cellTop') continue;
      if ((kind as { flowNodeId?: string }).flowNodeId === flowNodeId) {
        taintedSeed.add(scopeId);
      }
    }
  }

  function isTainted(scope: ScopeId): boolean {
    let cursor = scope;
    while (cursor !== CELL_TOP) {
      if (taintedSeed.has(cursor)) return true;
      const parent = scopeParent.get(cursor);
      if (parent === null || parent === undefined) break;
      cursor = parent;
    }
    return false;
  }

  /** Climb out of any diamond-tainted region. Returns the deepest untainted
   *  ancestor scope (or CELL_TOP). A no-op when `taintedSeed` is empty —
   *  guarantees zero regression on tree-shaped flow graphs. */
  function diamondHoist(scope: ScopeId): ScopeId {
    let current = scope;
    let safety = 100;
    while (current !== CELL_TOP && isTainted(current) && safety-- > 0) {
      const parent = scopeParent.get(current);
      if (parent === null || parent === undefined) break;
      current = parent;
    }
    return current;
  }

  const emitScope = new Map<string, ScopeId>();
  for (const [valueId, uses] of allUses) {
    if (uses.size === 0) continue;
    const scopes = [...uses];
    let lca = scopes[0]!;
    for (let i = 1; i < scopes.length; i++) lca = lca2(lca, scopes[i]!);
    // Hoist past loop bodies where this value isn't forced to live (loops have
    // a per-iteration recompute cost, branches don't).
    lca = hoistPastLoops(valueId, lca);
    // Hoist out of diamond-tainted regions (DAG flow patterns). Tree-LCA from
    // single-parent scope walks gives wrong answers inside multi-parent flow
    // node bodies — the body is emitted multiple times by compileFlowChain
    // but the analyzer's compiled-Set dedup declares the value in only one of
    // those emissions. Hoisting to the diamond's join scope makes the value
    // visible from all parent-path emissions.
    lca = diamondHoist(lca);
    emitScope.set(valueId, lca);
  }

  // -----------------------------------------------------------------
  // Build valuesByScope, with values inside each scope ordered by
  // dependency (sources first). Use a single global topo sort over all
  // value nodes that were assigned a scope.
  // -----------------------------------------------------------------

  // Build incoming-edge map for topo sort, restricted to value nodes that have an emit scope.
  const inScope = new Set(emitScope.keys());
  const topoIn = new Map<string, Set<string>>(); // node → producer set (restricted to inScope)
  const topoOut = new Map<string, Set<string>>(); // node → consumer set (restricted to inScope)
  for (const v of inScope) { topoIn.set(v, new Set()); topoOut.set(v, new Set()); }

  for (const v of inScope) {
    const node = adj.nodeMap.get(v);
    if (!node) continue;
    const def = getNodeDef(node.data.nodeType);
    if (!def) continue;
    for (const port of def.ports) {
      if (port.kind !== 'input' || port.category !== 'value') continue;
      const sources = port.isArray
        ? (adj.inputToSources.get(`${v}:${port.id}`) ?? [])
        : (() => { const s = adj.inputToSource.get(`${v}:${port.id}`); return s ? [s] : []; })();
      for (const s of sources) {
        if (!inScope.has(s.nodeId)) continue;
        topoIn.get(v)!.add(s.nodeId);
        topoOut.get(s.nodeId)!.add(v);
      }
    }
  }

  // Kahn's algorithm
  const indeg = new Map<string, number>();
  for (const v of inScope) indeg.set(v, topoIn.get(v)!.size);
  const ready: string[] = [];
  for (const [v, d] of indeg) if (d === 0) ready.push(v);
  const topoOrder: string[] = [];
  while (ready.length > 0) {
    const v = ready.shift()!;
    topoOrder.push(v);
    for (const c of topoOut.get(v)!) {
      const d = (indeg.get(c) ?? 0) - 1;
      indeg.set(c, d);
      if (d === 0) ready.push(c);
    }
  }

  const valuesByScope = new Map<ScopeId, string[]>();
  for (const v of topoOrder) {
    const sc = emitScope.get(v)!;
    let arr = valuesByScope.get(sc);
    if (!arr) { arr = []; valuesByScope.set(sc, arr); }
    arr.push(v);
  }

  return { emitScope, valuesByScope, scopeParent, scopeDepth, scopeKind };
}

/**
 * Target-independent "volatile value" hoisting analyzer.
 *
 * A *volatile* value is any value-producing node that transitively reads a
 * `getVariable` (Local Variables) node. Its result depends on per-cell mutable
 * state written by `setVariable` / `setArrayElement` flow nodes, so — unlike a
 * pure value — it must be emitted AFTER the flow that mutates that state, and
 * must NOT be hoisted to cell-top by ordinary sink analysis.
 *
 * The previous scheme emitted each volatile value INLINE at its first use and
 * deduped globally. That breaks when the same volatile value is consumed in
 * multiple sibling flow branches (e.g. several `switch` cases): the first
 * branch declares it inside its own block, and sibling branches reference an
 * out-of-scope variable.
 *
 * This analyzer fixes that: for each volatile value V it computes the
 * lowest-common-ancestor (LCA) flow scope of all V's uses (WITHOUT hoisting
 * past loops — a volatile read inside a loop body must stay there), then picks
 * the FIRST flow node in that scope whose subtree references V. The compilers
 * force-emit V immediately before that flow node, at the enclosing scope:
 *   - after preceding flow siblings (so the variable's writes already ran), and
 *   - dominating every branch under that flow node (so all uses see it).
 *
 * Single-use volatiles resolve to the one node that uses them — identical to
 * the old inline behaviour, so models like Amphiphile are unchanged.
 *
 * The input graph must be FLAT (macros expanded) — same precondition as
 * sinkAnalysis. All three compile targets run macro expansion first, so a
 * volatile read inside what used to be a macro is handled identically.
 */

import type { GraphNode } from '../../../model/types';
import { getNodeDef } from '../nodes/registry';

type ScopeId = string;
const CELL_TOP: ScopeId = 'cellTop';

/** Sequence runs `first` / `then` / `then_N` at its OWN scope (no new block) —
 *  identical to sinkAnalysis. Keep these two lists in sync. */
const TRANSPARENT_FLOW_TYPES = new Set(['sequence']);

export interface VolatileHoistInput {
  /** Prebuilt adjacency over the flat (post-macro-expansion) graph — each
   *  compile target already has these, so we don't rebuild from edges. */
  nodeMap: Map<string, GraphNode>;
  inputToSource: Map<string, { nodeId: string; portId: string }>;
  inputToSources: Map<string, Array<{ nodeId: string; portId: string }>>;
  flowOutputToTargets: Map<string, Array<{ nodeId: string; portId: string }>>;
  /** Entry flow node (StepNode / InitEventNode — the roots that declare variables). */
  rootNodeId: string;
  /** Flow output port on the root that starts the chain. */
  rootFlowPortId: string;
  /** Volatile value node ids (transitive value-consumers of any `getVariable`). */
  volatile: Set<string>;
}

export interface VolatileHoistResult {
  /** flow node id → volatile value ids to compile (emit) immediately BEFORE
   *  that flow node, at its enclosing scope. */
  emitBefore: Map<string, string[]>;
}

/** Compute the transitive value-input closure starting from every `getVariable`
 *  node — a value node is "volatile" iff it IS a getVariable or transitively
 *  consumes one. Volatile values read per-cell mutable Local-Variable state, so
 *  they can't be hoisted to scope entry by ordinary sink analysis. Shared by
 *  the JS / WASM / WebGPU compilers (each previously had its own copy). */
export function computeVolatileValueClosure(
  nodeMap: Map<string, GraphNode>,
  inputToSource: Map<string, { nodeId: string; portId: string }>,
  inputToSources: Map<string, Array<{ nodeId: string; portId: string }>>,
  extraSeeds?: Iterable<string>,
): Set<string> {
  const out = new Set<string>();
  const consumers = new Map<string, Set<string>>();
  const addConsumer = (sourceId: string, targetId: string): void => {
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
  for (const n of nodeMap.values()) {
    if (n.data.nodeType === 'getVariable') { out.add(n.id); queue.push(n.id); }
  }
  // Extra seeds (e.g. async read-after-write hazard reads from asyncWriteHazard.ts)
  // are treated exactly like getVariable: their transitive value consumers also
  // become volatile, so the whole chain is emitted at the use site after writes.
  if (extraSeeds) for (const id of extraSeeds) {
    if (nodeMap.has(id) && !out.has(id)) { out.add(id); queue.push(id); }
  }
  while (queue.length > 0) {
    const id = queue.shift()!;
    const cs = consumers.get(id);
    if (!cs) continue;
    for (const c of cs) if (!out.has(c)) { out.add(c); queue.push(c); }
  }
  return out;
}

export function computeVolatileHoist(input: VolatileHoistInput): VolatileHoistResult {
  const { nodeMap, inputToSource, inputToSources, flowOutputToTargets, rootNodeId, rootFlowPortId, volatile } = input;
  const emitBefore = new Map<string, string[]>();
  if (volatile.size === 0) return { emitBefore };

  /** Enumerate a flow node's value-input sources (static def ports + dynamic
   *  edge-map ports like switch `case_N_cond` / `case_N_val`). */
  function valueInputSources(nodeId: string): string[] {
    const node = nodeMap.get(nodeId);
    if (!node) return [];
    const def = getNodeDef(node.data.nodeType);
    if (!def) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const port of def.ports) {
      if (port.kind !== 'input' || port.category !== 'value') continue;
      seen.add(port.id);
      if (port.isArray) {
        const m = inputToSources.get(`${nodeId}:${port.id}`);
        if (m) for (const s of m) out.push(s.nodeId);
      } else {
        const s = inputToSource.get(`${nodeId}:${port.id}`);
        if (s) out.push(s.nodeId);
      }
    }
    for (const [key, source] of inputToSource) {
      if (!key.startsWith(`${nodeId}:`)) continue;
      const portId = key.slice(nodeId.length + 1);
      if (seen.has(portId)) continue;
      out.push(source.nodeId);
    }
    return out;
  }

  // --- Flow walk: scope tree + ordered members per scope + use scopes. ---
  const scopeParent = new Map<ScopeId, ScopeId | null>([[CELL_TOP, null]]);
  const scopeDepth = new Map<ScopeId, number>([[CELL_TOP, 0]]);
  const scopeChain = new Map<ScopeId, string[]>();   // scope → ordered member flow node ids
  const directUses = new Map<string, Set<ScopeId>>(); // volatile id → scopes referenced at
  const flowNodeContainingScopes = new Map<string, Set<ScopeId>>();
  const visited = new Set<string>();

  function reg(id: ScopeId, parent: ScopeId): void {
    if (scopeParent.has(id)) return;
    scopeParent.set(id, parent);
    scopeDepth.set(id, (scopeDepth.get(parent) ?? 0) + 1);
  }
  function pushMember(scope: ScopeId, nodeId: string): void {
    let a = scopeChain.get(scope);
    if (!a) { a = []; scopeChain.set(scope, a); }
    a.push(nodeId);
  }
  function recordUses(nodeId: string, scope: ScopeId): void {
    for (const srcId of valueInputSources(nodeId)) {
      if (!volatile.has(srcId)) continue;
      let s = directUses.get(srcId);
      if (!s) { s = new Set(); directUses.set(srcId, s); }
      s.add(scope);
    }
  }

  function walkOutput(srcNodeId: string, srcPortId: string, scope: ScopeId): void {
    const targets = flowOutputToTargets.get(`${srcNodeId}:${srcPortId}`);
    if (!targets) return;
    for (const t of targets) walkNode(t.nodeId, scope);
  }
  function walkNode(nodeId: string, scope: ScopeId): void {
    let cs = flowNodeContainingScopes.get(nodeId);
    if (!cs) { cs = new Set(); flowNodeContainingScopes.set(nodeId, cs); }
    cs.add(scope);

    const node = nodeMap.get(nodeId);
    if (!node) return;
    const type = node.data.nodeType;

    // Value inputs are used at this node's scope — record on EVERY visit so
    // diamond joins get use scopes from every path (mirrors sinkAnalysis).
    recordUses(nodeId, scope);

    if (visited.has(nodeId)) return;
    visited.add(nodeId);

    if (TRANSPARENT_FLOW_TYPES.has(type)) {
      // Sequence emits nothing itself; its branch chains are members of `scope`.
      walkOutput(nodeId, 'first', scope);
      walkOutput(nodeId, 'then', scope);
      const extra = Number(node.data.config.extraCount) || 0;
      for (let si = 2; si < 2 + extra; si++) walkOutput(nodeId, `then_${si}`, scope);
      return;
    }

    // Non-transparent node: a member of its enclosing scope.
    pushMember(scope, nodeId);

    if (type === 'conditional') {
      const t = `${nodeId}:then`; reg(t, scope); walkOutput(nodeId, 'then', t);
      const e = `${nodeId}:else`; reg(e, scope); walkOutput(nodeId, 'else', e);
    } else if (type === 'loop') {
      const b = `${nodeId}:body`; reg(b, scope); walkOutput(nodeId, 'body', b);
    } else if (type === 'forEachInArray' || type === 'forEachBond') {
      // forEachBond (Bond-Graph Agents) opens a body scope like forEachInArray —
      // a getVariable-derived value used inside the bond loop must be pinned to
      // the body, not hoisted above it.
      const b = `${nodeId}:body`; reg(b, scope); walkOutput(nodeId, 'body', b);
    } else if (type === 'switch') {
      const caseCount = Number(node.data.config.caseCount) || 0;
      if (caseCount === 0) {
        walkOutput(nodeId, 'default', scope);
      } else {
        for (let ci = 0; ci < caseCount; ci++) {
          const c = `${nodeId}:case_${ci}`; reg(c, scope); walkOutput(nodeId, `case_${ci}`, c);
        }
        if (flowOutputToTargets.has(`${nodeId}:default`)) {
          const d = `${nodeId}:default`; reg(d, scope); walkOutput(nodeId, 'default', d);
        }
      }
    }
    // Pass-through continuation (`next`): runs after this node / construct at
    // the SAME scope — its targets become later members of `scope`, matching
    // compileFlowChain's emission order (node, its next-chain, then the parent
    // port's next sibling). Action nodes have no other flow outputs.
    walkOutput(nodeId, 'next', scope);
  }
  walkOutput(rootNodeId, rootFlowPortId, CELL_TOP);

  // --- Propagate uses through volatile→volatile value edges to a fixpoint. ---
  // allUses(V) = directUses(V) ∪ ⋃ allUses(W) for each volatile consumer W of V.
  const allUses = new Map<string, Set<ScopeId>>();
  for (const [k, v] of directUses) allUses.set(k, new Set(v));
  const worklist: string[] = [...allUses.keys()];
  while (worklist.length > 0) {
    const w = worklist.pop()!;
    const wUses = allUses.get(w);
    if (!wUses) continue;
    for (const srcId of valueInputSources(w)) {
      if (!volatile.has(srcId)) continue;
      let pUses = allUses.get(srcId);
      if (!pUses) { pUses = new Set(); allUses.set(srcId, pUses); }
      let added = false;
      for (const sc of wUses) if (!pUses.has(sc)) { pUses.add(sc); added = true; }
      if (added) worklist.push(srcId);
    }
  }

  // --- LCA (no loop-hoist), with diamond-region hoisting (mirrors sinkAnalysis). ---
  function lca2(a: ScopeId, b: ScopeId): ScopeId {
    if (a === b) return a;
    let da = scopeDepth.get(a) ?? 0;
    let db = scopeDepth.get(b) ?? 0;
    let aa = a; let bb = b;
    while (da > db) { aa = scopeParent.get(aa) ?? CELL_TOP; da--; }
    while (db > da) { bb = scopeParent.get(bb) ?? CELL_TOP; db--; }
    while (aa !== bb) {
      const pa = scopeParent.get(aa); const pb = scopeParent.get(bb);
      if (pa == null || pb == null) return CELL_TOP;
      aa = pa; bb = pb;
    }
    return aa;
  }

  // A flow node reached from >1 parent scope is a "diamond entry": its body is
  // re-emitted per path, so a value declared inside it is visible on only one
  // path. Taint its containing scopes + its branch scopes; hoist out.
  const taintedSeed = new Set<ScopeId>();
  for (const [fId, cs] of flowNodeContainingScopes) {
    if (cs.size <= 1) continue;
    for (const s of cs) taintedSeed.add(s);
    for (const scopeId of scopeParent.keys()) {
      if (scopeId !== CELL_TOP && scopeId.startsWith(`${fId}:`)) taintedSeed.add(scopeId);
    }
  }
  function isTainted(scope: ScopeId): boolean {
    let c = scope;
    while (c !== CELL_TOP) {
      if (taintedSeed.has(c)) return true;
      const p = scopeParent.get(c);
      if (p == null) break;
      c = p;
    }
    return false;
  }
  function diamondHoist(scope: ScopeId): ScopeId {
    let c = scope; let n = 100;
    while (c !== CELL_TOP && isTainted(c) && n-- > 0) {
      const p = scopeParent.get(c);
      if (p == null) break;
      c = p;
    }
    return c;
  }

  const emitScope = new Map<string, ScopeId>();
  for (const [vId, uses] of allUses) {
    if (!volatile.has(vId) || uses.size === 0) continue;
    const arr = [...uses];
    let lca = arr[0]!;
    for (let i = 1; i < arr.length; i++) lca = lca2(lca, arr[i]!);
    // NOTE: deliberately NO hoistPastLoops — a volatile read inside a loop body
    // must be re-evaluated each iteration after the in-loop write.
    emitScope.set(vId, diamondHoist(lca));
  }

  // --- usedVolatiles(F): volatile values referenced anywhere in F's subtree. ---
  function volatileCone(valueId: string, acc: Set<string>): void {
    if (!volatile.has(valueId) || acc.has(valueId)) return;
    acc.add(valueId);
    for (const srcId of valueInputSources(valueId)) volatileCone(srcId, acc);
  }
  const subtreeCache = new Map<string, Set<string>>();
  /** Volatiles referenced anywhere in `flowNodeId`'s subtree.
   *
   *  `includeNext` distinguishes the node's TWO roles, and getting it wrong
   *  breaks one case or the other:
   *   - `false` (the top-level call, on a member of the LCA scope): the `next`
   *     continuation runs AFTER this node at the SAME scope — walkNode already
   *     pushed those targets as separate scope members — so a volatile used only
   *     in the next-chain belongs to that LATER SIBLING. Without the skip, a
   *     value read after a loop (`forEach.next → consumer`) is attributed to the
   *     loop and emitted BEFORE it, reading the accumulators pre-loop.
   *   - `true` (every recursive call, i.e. anything reached through a BRANCH
   *     port): we are inside a nested block, where the next-chain is just the
   *     rest of that block's statements and IS part of this subtree. Skipping it
   *     there made a conditional fail to claim a volatile used by the 2nd+
   *     statement of its own branch, so ownership fell to a LATER top-level
   *     sibling and the value was emitted after the branch that reads it — the
   *     JS compiler then declared it inline INSIDE the branch and every later
   *     reference was out of scope (`_v… is not defined`). */
  function usedVolatiles(flowNodeId: string, includeNext: boolean): Set<string> {
    const cacheKey = `${includeNext ? 1 : 0}${flowNodeId}`;
    const cached = subtreeCache.get(cacheKey);
    if (cached) return cached;
    const acc = new Set<string>();
    subtreeCache.set(cacheKey, acc); // set early — guards cycles / diamonds
    for (const srcId of valueInputSources(flowNodeId)) volatileCone(srcId, acc);
    for (const [key, targets] of flowOutputToTargets) {
      if (!key.startsWith(`${flowNodeId}:`)) continue;
      const portId = key.slice(flowNodeId.length + 1);
      if (portId === 'next' && !includeNext) continue;
      // Anything below this node lives in a nested block (or the rest of one),
      // so its own next-chain counts.
      for (const t of targets) for (const v of usedVolatiles(t.nodeId, true)) acc.add(v);
    }
    return acc;
  }

  // --- Assign each volatile to the first member of its LCA scope that uses it. ---
  for (const [vId, scope] of emitScope) {
    const chain = scopeChain.get(scope);
    if (!chain) continue;
    for (const fId of chain) {
      if (usedVolatiles(fId, false).has(vId)) {
        let a = emitBefore.get(fId);
        if (!a) { a = []; emitBefore.set(fId, a); }
        a.push(vId);
        break;
      }
    }
  }

  return { emitBefore };
}

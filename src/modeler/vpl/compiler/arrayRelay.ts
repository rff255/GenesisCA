import type { GraphNode } from '../../../model/types';

/** Dependencies for {@link makeProducesArray}. The two backends pass their own
 *  `isArrayProducer` (the lists differ slightly) plus the post-expansion
 *  adjacency they already build. */
export interface ProducesArrayDeps {
  /** The target's type-based array-producer predicate (static producers like
   *  filterNeighbors / joinNeighbors / getVariable). */
  isArrayProducer: (nodeType: string) => boolean;
  /** "<targetNodeId>:<targetPortId>" → first source. */
  inputToSource: Map<string, { nodeId: string; portId: string }>;
  nodeMap: Map<string, GraphNode>;
}

/**
 * Build a context-aware "does this node emit an array?" predicate, shared by
 * the WASM and WebGPU compilers so the two stay in lockstep.
 *
 * Static array producers are answered by the target's `isArrayProducer`.
 * `valueSwitch` is a **dual-mode relay**: `result = cond ? ifValue : elseValue`
 * is an array iff BOTH branches are (recursively) array producers — it just
 * selects one of the two branch arrays, so its output shape equals its input
 * shape, which `nodeType` alone cannot express. A `valueSwitch` with one array
 * branch and one scalar branch (or an unconnected branch = inline scalar)
 * reports `false` here; the array emitter then raises a clear compile error if
 * it is nonetheless asked for an array (shapes must match).
 *
 * Memoised (the result is stable for a given graph) and cycle-guarded — the
 * value graph is a DAG, but a defensive guard keeps a hand-edited
 * self-referential edge from recursing forever.
 *
 * Used to replace the *source-node* `isArrayProducer(...)` checks (the gate in
 * `resolveInputArray` plus the aggregate / groupOperator / groupStatement /
 * setNeighbor*ByIndex disambiguators and the pre-emit walks).
 */
export function makeProducesArray(deps: ProducesArrayDeps): (node: GraphNode) => boolean {
  const { isArrayProducer, inputToSource, nodeMap } = deps;
  const memo = new Map<string, boolean>();
  const inProgress = new Set<string>();

  function branchProducesArray(nodeId: string, portId: string): boolean {
    const src = inputToSource.get(`${nodeId}:${portId}`);
    if (!src) return false; // unconnected branch ⇒ inline scalar ⇒ scalar mode
    const srcNode = nodeMap.get(src.nodeId);
    return !!srcNode && producesArray(srcNode);
  }

  function producesArray(node: GraphNode): boolean {
    if (isArrayProducer(node.data.nodeType)) return true;
    if (node.data.nodeType !== 'valueSwitch') return false;
    const cached = memo.get(node.id);
    if (cached !== undefined) return cached;
    if (inProgress.has(node.id)) return false; // cycle guard
    inProgress.add(node.id);
    const result =
      branchProducesArray(node.id, 'ifValue') && branchProducesArray(node.id, 'elseValue');
    inProgress.delete(node.id);
    memo.set(node.id, result);
    return result;
  }

  return producesArray;
}

/**
 * Loop-invariance classifier for value nodes in the cell-iteration graph.
 *
 * A value node is "loop-invariant" when its result does not depend on the
 * current cell's index — i.e. the same expression at the top of the cell loop
 * would produce the same value for every cell in a single step. The compiler
 * uses this to hoist such emissions out of the per-cell loop and into the
 * function preamble: `modelAttrs["..."]` reads, model-attr arithmetic, and
 * pure constants all become one-time work per step instead of per cell.
 *
 * Both compile targets (JS and WASM) share this classification — having the
 * two compilers read the same file is the structural guarantee that they
 * can never disagree on which nodes can be hoisted.
 *
 * Rules:
 *   - ALWAYS invariant: getConstant, tagConstant, getModelAttribute,
 *     getColorConstant. These have no inputs that vary by cell.
 *   - NEVER invariant: getCellAttribute, getNeighborsAttribute, getRandom,
 *     getNeighborAttributeByTag, getNeighborAttributeByIndex, getIndicator,
 *     getNeighborsAttrByIndexes, filterNeighbors, joinNeighbors,
 *     getNeighborIndexesByTags. Each touches per-cell state in some way.
 *   - COMPOSITE (default): invariant iff every wired value input is invariant.
 *     Unwired inline widgets count as invariant (config-baked numeric/literal).
 *
 * Macro nodes are NOT recursed into — their internals are classified
 * independently if/when we extend hoisting into macro inlining (future work).
 * For the top-level case (the common one — modelAttrs read at root scope),
 * this is enough.
 */

import type { GraphNode } from '../../../model/types';

const ALWAYS_INVARIANT = new Set<string>([
  'getConstant',
  'tagConstant',
  'getModelAttribute',
  'getColorConstant',
]);

const NEVER_INVARIANT = new Set<string>([
  'getCellAttribute',
  'getNeighborsAttribute',
  'getRandom',
  'getNeighborAttributeByTag',
  'getNeighborAttributeByIndex',
  'getIndicator',
  'getNeighborsAttrByIndexes',
  'filterNeighbors',
  'joinNeighbors',
  'getNeighborIndexesByTags',
  // Entry-point / flow types — never invariant; included here for safety so
  // they're never falsely hoisted if a downstream consumer dereferences them.
  'inputColor',
  'step',
  'outputMapping',
  'macroInput',
  'macroOutput',
]);

export function classifyLoopInvariant(
  graphNodes: GraphNode[],
  inputToSource: Map<string, { nodeId: string; portId: string }>,
): Set<string> {
  // Build reverse lookup: nodeId → list of upstream value-source nodeIds.
  // We only need source identities (not port ids) for invariance propagation.
  const upstreams = new Map<string, string[]>();
  for (const [key, src] of inputToSource) {
    const targetNodeId = key.split(':')[0];
    if (!targetNodeId) continue;
    const arr = upstreams.get(targetNodeId);
    if (arr) arr.push(src.nodeId);
    else upstreams.set(targetNodeId, [src.nodeId]);
  }

  const nodeMap = new Map(graphNodes.map(n => [n.id, n] as const));
  const memo = new Map<string, boolean>();

  const visit = (nodeId: string, stack: Set<string>): boolean => {
    const cached = memo.get(nodeId);
    if (cached !== undefined) return cached;
    if (stack.has(nodeId)) return false; // cycle guard (shouldn't happen — graphs are acyclic)

    const node = nodeMap.get(nodeId);
    if (!node) return false;
    const t = node.data.nodeType;

    if (NEVER_INVARIANT.has(t)) { memo.set(nodeId, false); return false; }
    if (ALWAYS_INVARIANT.has(t)) { memo.set(nodeId, true); return true; }

    // Macro nodes: defer to recursion into the macro's internals would require
    // model context. For now, treat as non-invariant — safe default.
    if (t === 'macro') { memo.set(nodeId, false); return false; }

    // Composite: invariant iff every wired input source is invariant.
    stack.add(nodeId);
    const sources = upstreams.get(nodeId) ?? [];
    let result = true;
    for (const srcId of sources) {
      if (!visit(srcId, stack)) { result = false; break; }
    }
    stack.delete(nodeId);

    memo.set(nodeId, result);
    return result;
  };

  const result = new Set<string>();
  for (const node of graphNodes) {
    if (visit(node.id, new Set())) result.add(node.id);
  }
  return result;
}

/**
 * Aggregate-fusion detection: when a `getNeighborsAttribute` node has exactly
 * one consumer and that consumer is a fold-friendly `aggregate`, the two
 * loops (gather neighbors → scratch, then reduce scratch) collapse into one
 * (gather + reduce inline). For an MNCA model with 360-neighbor sums this
 * halves the per-cell work and removes the scratch fill entirely.
 *
 * Both compile targets share this detector — running the same logic from one
 * file is the structural guarantee that JS and WASM agree on which pairs
 * fuse. If they didn't, a fused JS aggregate paired with an unfused WASM
 * counterpart (or vice versa) would diverge at runtime.
 *
 * Detection rules (all must hold):
 *   1. Aggregate's `values` input has exactly ONE source (single edge — not
 *      a multi-source array literal).
 *   2. That source is a `getNeighborsAttribute` node.
 *   3. That `getNeighborsAttribute` has exactly ONE outgoing edge anywhere
 *      in the graph (this aggregate is its sole consumer).
 *   4. Aggregate's operation is fold-friendly: sum / product / max / min /
 *      average / and / or. `median` is excluded — it needs the materialised
 *      array to sort, so the scratch must survive.
 *
 * Macro internals (nodes inside `model.macroDefs[*].nodes`) are NOT fused
 * by this pass — they're inlined during compilation with prefixed names and
 * a separate edge map. Top-level fusion covers the common case (the MNCA
 * model and any model whose hot loop is at root scope).
 */

import type { GraphNode, GraphEdge } from '../../../model/types';

const FUSABLE_OPS = new Set<string>([
  'sum', 'product', 'max', 'min', 'average', 'and', 'or',
]);

export interface FusionResult {
  /** Map: aggregate nodeId → its source getNeighborsAttribute nodeId. */
  fusedAggregates: Map<string, string>;
  /** getNeighborsAttribute nodeIds whose own emit should be skipped — their
   *  gather has been merged into the fused aggregate. */
  skippedGather: Set<string>;
}

export function detectFusableAggregates(
  graphNodes: GraphNode[],
  graphEdges: GraphEdge[],
  inputToSources: Map<string, Array<{ nodeId: string; portId: string }>>,
): FusionResult {
  const nodeMap = new Map(graphNodes.map(n => [n.id, n] as const));

  // Count outgoing edges per source node id (across all ports).
  // A getNeighborsAttribute with multiple consumers can't be fused — its
  // scratch must materialise so the other consumers can read it.
  const outDegree = new Map<string, number>();
  for (const edge of graphEdges) {
    outDegree.set(edge.source, (outDegree.get(edge.source) ?? 0) + 1);
  }

  const fusedAggregates = new Map<string, string>();
  const skippedGather = new Set<string>();

  for (const node of graphNodes) {
    if (node.data.nodeType !== 'aggregate') continue;

    const op = (node.data.config.operation as string) || 'sum';
    if (!FUSABLE_OPS.has(op)) continue;

    // Use inputToSources (plural) so we can detect the multi-source case
    // (e.g. aggregate over [a, b, c] literals) and refuse to fuse those.
    const sources = inputToSources.get(`${node.id}:values`) ?? [];
    if (sources.length !== 1) continue;

    const src = sources[0]!;
    const srcNode = nodeMap.get(src.nodeId);
    if (!srcNode || srcNode.data.nodeType !== 'getNeighborsAttribute') continue;

    if ((outDegree.get(src.nodeId) ?? 0) !== 1) continue;

    fusedAggregates.set(node.id, src.nodeId);
    skippedGather.add(src.nodeId);
  }

  return { fusedAggregates, skippedGather };
}

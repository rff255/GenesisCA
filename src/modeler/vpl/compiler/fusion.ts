/**
 * Aggregate-fusion detection: when a `getNeighborsAttribute` node has exactly
 * one consumer and that consumer is a fold-friendly aggregator, the two-loop
 * pattern (gather → reduce) collapses into one inlined gather+reduce loop.
 * This applies to FOUR consumer node types — they all share the same shape
 * (single value-array input, scalar fold output) and so all benefit equally:
 *
 *   - aggregate          (sum/product/max/min/average/and/or)
 *   - groupOperator      (sum/mul/mean/max/min/and/or/random) — multi-output
 *   - groupCounting      (equals/notEquals/.../between) — count-only path
 *   - groupStatement     (allIs/noneIs/hasA/...) — short-circuit result-only
 *
 * Both compile targets share this detector — running the same logic from one
 * file is the structural guarantee that JS and WASM agree on which pairs
 * fuse. (WASM doesn't currently consult `fusedConsumers` because its source
 * emitter is already a phantom — it never materialised scratch in the first
 * place. The detector still runs once per compile and the JS compiler reads
 * its output; if WASM ever needs the same signal it can consume the same map.)
 *
 * Detection rules (all must hold):
 *   1. Consumer's `values` input has exactly ONE source (no multi-source
 *      array literals).
 *   2. That source is a `getNeighborsAttribute` node.
 *   3. That `getNeighborsAttribute` has exactly ONE outgoing edge anywhere
 *      in the graph (this consumer is its sole reader).
 *   4. Consumer's operation is in its per-type fusable set (see below).
 *   5. For `groupCounting` / `groupStatement`: the `indexes` output port
 *      must NOT be wired anywhere — the indexed paths require a scratch
 *      array, which fusion eliminates.
 *
 * Macro internals (nodes inside `model.macroDefs[*].nodes`) are NOT fused —
 * they're inlined during compilation with prefixed names and a separate edge
 * map. Top-level fusion covers the common case.
 */

import type { GraphNode, GraphEdge } from '../../../model/types';

export type FusableConsumerType = 'aggregate' | 'groupOperator' | 'groupCounting' | 'groupStatement';

const FUSABLE_OPS_BY_TYPE: Record<FusableConsumerType, Set<string>> = {
  aggregate:      new Set(['sum', 'product', 'max', 'min', 'average', 'and', 'or']),
  groupOperator:  new Set(['sum', 'mul', 'mean', 'max', 'min', 'and', 'or', 'random']),
  groupCounting:  new Set(['equals', 'notEquals', 'greater', 'lesser', 'between', 'notBetween']),
  groupStatement: new Set(['allIs', 'noneIs', 'hasA', 'allGreater', 'anyGreater', 'allLesser', 'anyLesser']),
};

export interface FusedInfo {
  /** Source `getNeighborsAttribute` node id. */
  sourceId: string;
  /** Consumer node type — drives the per-builder dispatch in compile.ts. */
  consumerType: FusableConsumerType;
  /** Consumer's `operation` config — the specific fold/op variant. */
  op: string;
}

export interface FusionResult {
  /** Map: consumer nodeId → fusion metadata. */
  fusedConsumers: Map<string, FusedInfo>;
  /** getNeighborsAttribute nodeIds whose own emit should be skipped — their
   *  gather has been merged into the consumer's fused emit. */
  skippedGather: Set<string>;
}

export function detectFusableConsumers(
  graphNodes: GraphNode[],
  graphEdges: GraphEdge[],
  inputToSources: Map<string, Array<{ nodeId: string; portId: string }>>,
  inputToSource: Map<string, { nodeId: string; portId: string }>,
): FusionResult {
  const nodeMap = new Map(graphNodes.map(n => [n.id, n] as const));

  // Count outgoing edges per source node id (across all ports).
  // A getNeighborsAttribute with multiple consumers can't be fused — its
  // scratch must materialise so the other consumers can read it.
  const outDegree = new Map<string, number>();
  for (const edge of graphEdges) {
    outDegree.set(edge.source, (outDegree.get(edge.source) ?? 0) + 1);
  }

  // For groupCounting / groupStatement: scan the inputToSource map once to
  // know which nodes have their `indexes` output wired. (Mirrors the same
  // scan compile.ts uses to populate config._indexesConnected.)
  const indexesWired = new Set<string>();
  for (const [, src] of inputToSource) {
    if (src.portId === 'indexes') indexesWired.add(src.nodeId);
  }

  const fusedConsumers = new Map<string, FusedInfo>();
  const skippedGather = new Set<string>();

  for (const node of graphNodes) {
    const t = node.data.nodeType as FusableConsumerType;
    const fusableOps = FUSABLE_OPS_BY_TYPE[t];
    if (!fusableOps) continue;

    const op = (node.data.config.operation as string) || (
      t === 'aggregate' ? 'sum'
      : t === 'groupOperator' ? 'sum'
      : t === 'groupCounting' ? 'equals'
      : 'allIs'
    );
    if (!fusableOps.has(op)) continue;

    // groupCounting / groupStatement: refuse if indexes output is wired —
    // the indexed paths need a materialised scratch array that fusion drops.
    if ((t === 'groupCounting' || t === 'groupStatement') && indexesWired.has(node.id)) {
      continue;
    }

    // Use inputToSources (plural) so we can detect the multi-source case
    // (e.g. aggregate over [a, b, c] literals) and refuse to fuse those.
    const sources = inputToSources.get(`${node.id}:values`) ?? [];
    if (sources.length !== 1) continue;

    const src = sources[0]!;
    const srcNode = nodeMap.get(src.nodeId);
    if (!srcNode || srcNode.data.nodeType !== 'getNeighborsAttribute') continue;

    if ((outDegree.get(src.nodeId) ?? 0) !== 1) continue;

    fusedConsumers.set(node.id, { sourceId: src.nodeId, consumerType: t, op });
    skippedGather.add(src.nodeId);
  }

  return { fusedConsumers, skippedGather };
}

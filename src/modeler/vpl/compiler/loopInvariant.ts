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
 *   - ALWAYS invariant: getConstant, getModelAttribute, getColorConstant.
 *     These have no inputs that vary by cell.
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
  // RNG side-effect: every invocation must advance the shared _rs stream.
  // Without this, the composite rule classifies `pickRandomNeighbor` (or
  // `pickNRandomNeighbors`) as invariant whenever ALL its inputs happen to
  // be invariant — e.g. wired straight from `getAllNeighborIndexes` (no
  // inputs → vacuously invariant). The hoist then emits the pick ONCE
  // pre-loop and every cell sees the same random pick within a step.
  // WebGPU is unaffected (per-cell PCG via `rand_f32(idx)`); JS/WASM use
  // the shared xorshift32 stream and depend on per-cell emission for
  // correctness.
  'pickRandomNeighbor',
  'pickNRandomNeighbors',
  // Entry-point / flow types — never invariant; included here for safety so
  // they're never falsely hoisted if a downstream consumer dereferences them.
  'inputColor',
  'step',
  'outputMapping',
  'initEvent',
  'macroInput',
  'macroOutput',
  // Variegated Cells reads: GetOrientation / GetFacingOrientation /
  // GetNeighborOrientationByIndex / GetFacingLabels all read `r_orientation[idx]`
  // (or `r_orientation` at a neighbor cell index derived from `idx`), so
  // they're per-cell by construction. LookupInteraction is allowed to be
  // composite: when both label inputs are loop-invariant, the lookup hoists
  // out of the loop.
  'getOrientation',
  'getFacingOrientation',
  'getNeighborOrientationByIndex',
  'getFacingLabels',
  'getAllFacingLabels',
  // Local Variables: per-cell scratch storage mutated by SetVariable /
  // SetArrayElement inside the cell loop. Hoisting GetVariable out would
  // emit the read ONCE at function scope BEFORE the cell loop runs and
  // ANY writes happen — the consumer would see the variable's initial
  // value (or worse, the previous cell's leftover value) instead of the
  // current cell's state. This propagates through every consumer that depends
  // on GetVariable via the composite rule, so the whole post-loop chain
  // (Aggregate / GroupOperator / ArrayElement on the variable's value)
  // also lands inside the loop body.
  'getVariable',
  // ForEachInArray's `element` / `index` outputs vary per loop iteration, so
  // any value reading them must stay INSIDE the loop body. The composite rule
  // would otherwise classify the forEach node as invariant whenever its input
  // array is invariant (e.g. a constant NI array from getAllNeighborIndexes) —
  // and propagate that to every element/index consumer whose OTHER inputs are
  // also invariant, hoisting `breakDownNeighborIndex(element)`, `expr(index)`,
  // etc. to the function preamble where the per-iteration var is still
  // undefined. (Models that route index only into arrayElement/setArrayElement
  // dodged this because those consumers also read a never-invariant variable.)
  'forEachInArray',
  // Get Cell Position reads the per-cell `_row`/`_col`/`_layer` locals (decoded
  // inside the loop). It has NO value inputs, so the composite rule would
  // classify it vacuously invariant and hoist it to the function preamble —
  // BEFORE those locals exist (ReferenceError `_row is not defined`). It is
  // per-cell by construction; never hoist.
  'getCellPosition',
  // Bond-Graph Agents: the agent event roots' value-outs (behaviourStep.myX/…,
  // divisionEvent.daughterIndex/…) are per-AGENT (read `_agentX[idx]` etc. in
  // the loop preamble), and the agent read nodes read per-agent engine buffers
  // (`_agentRadius[idx]`, `_agentBondCount[idx]`, …). Each is per-agent by
  // construction — hoisting a consumer above the agent loop would reference the
  // per-agent locals before they exist. Same reasoning as getCellPosition.
  'behaviourStep',
  'divisionEvent',
  'bondContactEvent',
  'getSelfPosition',
  'getRadius',
  'getBondDegree',
  'neighbourDensity',
  'getCurvature',
  'sampleField',
  'fieldGradient',
  'readCellsUnder',
  // Agent neighbour access — all read per-agent engine buffers / the hash.
  'getNearbyAgents',
  'getAgentPosition',
  'getAgentOffset',
  'getAgentAttribute',
  'getAgentRadius',
  'getVelocity',
  // ForEachBond's per-iteration outputs (partnerId/restLength/currentLength/index)
  // vary per bond — any consumer must stay inside the bond loop (same reasoning
  // as forEachInArray).
  'forEachBond',
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

/**
 * "Does this graph read the generation?" — the ONE predicate every surface that
 * conditionally threads the generation consults, so they cannot disagree.
 *
 * The generation is threaded as an OPTIONAL trailing param / struct field on the
 * surfaces where an unconditional addition would change the emitted output of
 * every existing model (JS param strings, WGSL shader text). Byte-identity is the
 * milestone's primary regression net, so those surfaces gate on this predicate.
 * (The two WASM surfaces need no gate at all: they read a memory cell appended at
 * the END of the layout, which leaves every baked offset — and therefore every
 * module byte — unchanged when the node is unused.)
 *
 * Two rules the implementation keeps:
 *
 *  1. **It is a SUPERSET, deliberately.** It scans the graph's own nodes AND
 *     every `macroDefs` entry, without resolving which macros are actually
 *     instantiated or reachable. An over-eager `true` costs one unread param;
 *     a false negative would emit code referencing an undeclared identifier.
 *     Erring toward `true` is the safe direction.
 *  2. **`periodicStep` counts.** The Agent Periodic Step lowering synthesizes a
 *     `getGeneration`, so a graph holding only Agent Periodic Steps still needs
 *     the generation threaded. The predicate runs BEFORE the lowering, so it must
 *     count the pre-lowering node type.
 *  3. **The GLOBAL periodic roots count** (`gridPeriodic` / `agentPeriodic`).
 *     They are NOT lowered — the worker decides when they fire — but their
 *     `stepIndex` value-out is emitted as `Math.floor(_generation / Period)`, so
 *     the param must be threaded whenever such a root exists.
 *
 * The ARG side (the worker) never consults this: it ALWAYS passes the generation.
 * Extra trailing args to a JS function are ignored, whereas a missing one reads
 * `undefined` — so "params conditional, args unconditional" makes the dangerous
 * direction structurally impossible (the L1 `forcePassParamsFor` discipline).
 */

import type { CAModel, GraphNode } from '../../../model/types';

/** The node types whose presence means the generation must be threaded. */
const GENERATION_NODE_TYPES: ReadonlySet<string> = new Set([
  'getGeneration', 'periodicStep',
  // The global periodic roots emit `stepIndex = ⌊_generation / Period⌋`.
  'gridPeriodic', 'agentPeriodic',
]);

function scan(nodes: ReadonlyArray<GraphNode> | undefined): boolean {
  if (!nodes) return false;
  for (const n of nodes) if (GENERATION_NODE_TYPES.has(n.data?.nodeType)) return true;
  return false;
}

function scanMacros(model: Pick<CAModel, 'macroDefs'>): boolean {
  for (const def of model.macroDefs ?? []) if (scan(def.nodes)) return true;
  return false;
}

/** Does the CELL graph (or any macro it could instantiate) read the generation? */
export function cellUsesGeneration(model: Pick<CAModel, 'graphNodes' | 'macroDefs'>): boolean {
  return scan(model.graphNodes) || scanMacros(model);
}

/** Does the AGENT graph (or any macro it could instantiate) read the generation? */
export function agentUsesGeneration(model: Pick<CAModel, 'agentGraphNodes' | 'macroDefs'>): boolean {
  return scan(model.agentGraphNodes) || scanMacros(model);
}

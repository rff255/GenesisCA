import type { GraphNode } from '../../../model/types';
import { getNodeDef } from '../nodes/registry';

/**
 * Is the source feeding an agent-targeting `agentId` port an ID **ARRAY**?
 *
 * THE ONE DEFINITION the three agent compilers share, so `Set Attribute`'s
 * scalar-vs-array arm cannot be decided differently on JS, WASM and WebGPU.
 * The port itself is scalar-typed (`integer`) and `arrayCapable`, exactly like
 * `setNeighborAttributeByIndex.index` on the lattice: unwired ⇒ self, a scalar
 * source ⇒ one agent, an ARRAY source ⇒ every id in it. The three modes must
 * agree across targets or the same graph would write different agents.
 *
 * Two source shapes count, and they are exactly the two the retired
 * `setAgentsAttribute` accepted on its `agents` port:
 *   1. a statically `isArray` OUTPUT port — every agent-array producer
 *      (Get Nearby / In View / Bonded Agents, Filter / Join Agents, Pick N
 *      Random Agents, Sense Hemifield's two id ports, Get Agents Attribute);
 *   2. an ARRAY-kind Local Variable read (`getVariable`), asked through the
 *      caller's own notion of "this variable is an array" so a compiler can
 *      never disagree with its own array machinery.
 *
 * A `valueSwitch` ARRAY RELAY is deliberately NOT recognised here. Its `result`
 * port is scalar-typed and only the JS compiler resolves the relay recursively;
 * the two agent backends' `AGENT_ARRAY_PRODUCERS` are type-based and do not
 * list it, so recognising it would make WASM materialise a length-1 scratch
 * array (silently wrong) while WebGPU throws. That asymmetry is pre-existing —
 * it applies to EVERY agent array consumer — and this helper does not widen it.
 */
export function isAgentIdArraySource(
  srcNode: GraphNode | undefined,
  srcPortId: string,
  isArrayVariable?: (variableId: string) => boolean,
): boolean {
  if (!srcNode) return false;
  const nodeType = srcNode.data?.nodeType;
  if (!nodeType) return false;
  const port = getNodeDef(nodeType)?.ports.find(p => p.kind === 'output' && p.id === srcPortId);
  if (port?.isArray) return true;
  if (nodeType === 'getVariable' && isArrayVariable) {
    const vid = srcNode.data.config?.['variableId'];
    return typeof vid === 'string' && isArrayVariable(vid);
  }
  return false;
}

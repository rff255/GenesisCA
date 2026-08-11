import type { NodeTypeDef } from '../types';

/** Agent Input Mapping (C→A) — the agent analogue of the lattice `inputColor`
 *  event root, and the mirror image of `agentOutputMapping`.
 *
 *  Roots a SINGLE-AGENT graph that runs when the user PAINTS an agent with the
 *  agent brush's Paint mode: the brush colour arrives on the `r`/`g`/`b` value
 *  outputs and the `DO` chain writes the agent's state (Set Attribute, Set Agent
 *  Radius, Set Velocity, …). One root per entry in `model.agentMappings` whose
 *  `isAttributeToColor` is FALSE (the C→A direction — the same discriminator the
 *  cell mappings use).
 *
 *  EXECUTION POSTURE — JS on CPU on EVERY agent target (JS / WASM / WebGPU), the
 *  same posture as the agent colour pass (`runAgentColorPass`) and the Division
 *  Event: this is an EVENT-tempo function (it runs once per painted agent, on a
 *  user gesture), not step-hot, so there is nothing to gain from a WASM/WebGPU
 *  emit and the all-target rule is satisfied by construction — the one compiled
 *  function serves every target, exactly like the agent OM passes.
 *
 *  `requirements.bondGraph` → only available in an Agents-topology model, on the
 *  Agents sub-tab. NOT a singleton (one per input mapping, like `inputColor`). */
export const AgentInputMappingNode: NodeTypeDef = {
  type: 'agentInputMapping',
  label: 'Agent Input Mapping (C→A)',
  description: 'Entry point for an agent colour-to-attribute mapping. Fires once per agent when the user paints agents with this mapping selected.',
  category: 'event',
  color: '#ffffff',
  requirements: { bondGraph: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'output', category: 'flow' },
    { id: 'r', label: 'R', kind: 'output', category: 'value', dataType: 'integer' },
    { id: 'g', label: 'G', kind: 'output', category: 'value', dataType: 'integer' },
    { id: 'b', label: 'B', kind: 'output', category: 'value', dataType: 'integer' },
  ],
  defaultConfig: { mappingId: '' },
  compile: () => '', // Root node — the agent compiler handles it specially.
};

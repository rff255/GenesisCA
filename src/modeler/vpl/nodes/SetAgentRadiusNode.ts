import type { NodeTypeDef } from '../types';

/** Set Agent Radius — set an agent's radius (and growth target) by id (Generic
 *  Agent Platform). A spawn helper for a staged agent (from Create Agent) before
 *  Add Agent To World; writes both the current radius and the target radius so
 *  the growth ramp doesn't drag it away. JS-only this milestone. */
export const SetAgentRadiusNode: NodeTypeDef = {
  type: 'setAgentRadius',
  label: 'Set Agent Radius',
  agentLabel: 'Set Radius (by ID)',
  description: "Set an agent's radius (and growth target) by id (a Create Agent handle, or a live agent).",
  category: 'output',
  color: '#4527a0',
  requirements: { bondGraph: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'next', label: 'NEXT', kind: 'output', category: 'flow' },
    { id: 'agentId', label: 'Agent', kind: 'input', category: 'value', dataType: 'integer' },
    { id: 'radius', label: 'Radius', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '1' },
  ],
  defaultConfig: {},
  compile: (_nodeId, _config, inputs, _boundary, ctx) => {
    const id = `((${inputs['agentId'] || '-1'}) | 0)`;
    // Unified spawning: a Created agent is staged (alive=0) until Add To World in
    // Init AND Behaviour, so relax the guard to range-only in either root.
    const guard = (ctx?.agentRoot === 'init' || ctx?.agentRoot === 'behaviour')
      ? `__sr >= 0 && __sr < _agentMaxAgents`
      : `__sr >= 0 && __sr < highWater && _alive[__sr]`;
    // C9 SAFETY CATCH: drop the target-radius half when that field is gated off
    // (no param to write); the real radius write is unconditional.
    const tgt = (ctx?.agentGates && !ctx.agentGates.targetRadius) ? '' : ' _agentTargetRadius[__sr] = __rv;';
    return `{ const __sr = ${id}; const __rv = ${inputs['radius'] || '1'}; if (${guard}) { _agentRadius[__sr] = __rv;${tgt} } }\n`;
  },
};

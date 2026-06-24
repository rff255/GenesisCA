import type { NodeTypeDef } from '../types';

/** Set Agent Type — set an agent's integer type by id (Generic Agent Platform).
 *  A spawn helper for a staged agent (from Create Agent) before Add Agent To
 *  World — the type drives the default colour palette + can be read by other
 *  agents (Get Agent Attribute / type-based rules). JS-only this milestone. */
export const SetAgentTypeNode: NodeTypeDef = {
  type: 'setAgentType',
  label: 'Set Agent Type',
  description: "Set an agent's integer type by id (a Create Agent handle, or a live agent).",
  category: 'output',
  color: '#4527a0',
  requirements: { bondGraph: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'next', label: 'NEXT', kind: 'output', category: 'flow' },
    { id: 'agentId', label: 'Agent', kind: 'input', category: 'value', dataType: 'integer' },
    { id: 'type', label: 'Type', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '0' },
  ],
  defaultConfig: {},
  compile: (_nodeId, _config, inputs, _boundary, ctx) => {
    const id = `((${inputs['agentId'] || '-1'}) | 0)`;
    const guard = ctx?.agentRoot === 'init'
      ? `__st >= 0 && __st < _agentMaxAgents`
      : `__st >= 0 && __st < highWater && _alive[__st]`;
    return `{ const __st = ${id}; if (${guard}) _agentType[__st] = ((${inputs['type'] || '0'}) | 0); }\n`;
  },
};

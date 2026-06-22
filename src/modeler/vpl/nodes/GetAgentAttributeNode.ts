import type { NodeTypeDef } from '../types';

/** Get Agent Attribute — read a SPECIFIC agent's attribute by id (Bond-Graph
 *  Agents). The agent analogue of Get Neighbor Attribute By Index: feed a
 *  neighbour id (from Get Nearby Agents / For Each Bond) to read its type,
 *  energy, state, … — differential adhesion, contact inhibition, signalling. */
export const GetAgentAttributeNode: NodeTypeDef = {
  type: 'getAgentAttribute',
  label: 'Get Agent Attribute',
  description: "Read a specific agent's attribute by id (the partner from Get Nearby Agents / For Each Bond).",
  category: 'data',
  color: '#5e35b1',
  requirements: { bondGraph: true },
  ports: [
    { id: 'agentId', label: 'Agent', kind: 'input', category: 'value', dataType: 'integer' },
    { id: 'value', label: 'Value', kind: 'output', category: 'value', dataType: 'any' },
  ],
  defaultConfig: { attributeId: '' },
  compile: (nodeId, config, inputs) => {
    const attr = config.attributeId as string || '_undef';
    const a = `((${inputs['agentId'] || '0'}) | 0)`;
    return `const _v${nodeId} = r_${attr}[${a}];\n`;
  },
};

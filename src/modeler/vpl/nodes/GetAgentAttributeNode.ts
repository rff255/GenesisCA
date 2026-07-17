import type { NodeTypeDef } from '../types';

/** Get Agent Attribute — read a SPECIFIC agent's attribute by id (Bond-Graph
 *  Agents). The agent analogue of Get Neighbor Attribute By Index: feed a
 *  neighbour id (from Get Nearby Agents / For Each Bond) to read its type,
 *  energy, state, … — differential adhesion, contact inhibition, signalling. */
export const GetAgentAttributeNode: NodeTypeDef = {
  type: 'getAgentAttribute',
  label: 'Get Agent Attribute',
  agentLabel: 'Get Attribute (by ID)',
  description: "Read a specific agent's attribute by id (the partner from Get Nearby Agents / For Each Bond). Extra attribute slots (+ Attribute) read several of that agent's attributes through one shared Agent input.",
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
    // -1 = the empty sentinel (Pick Random Agent on an empty set, an unwired
    // input). Range-guarded → 0 instead of `r_attr[-1]` = undefined → NaN
    // silently poisoning downstream math (WASM would read adjacent memory).
    const a = `((${inputs['agentId'] || '-1'}) | 0)`;
    return `const __gaa${nodeId} = ${a}; const _v${nodeId} = (__gaa${nodeId} >= 0 && __gaa${nodeId} < highWater) ? r_${attr}[__gaa${nodeId}] : 0;\n`;
  },
};

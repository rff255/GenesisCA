import type { NodeTypeDef } from '../types';

/** Get Agent Radius — a specific agent's radius by id (Bond-Graph Agents). For
 *  size-aware neighbour interactions (e.g. a separation force scaled by the
 *  partner's size). Feed a neighbour id from Get Nearby Agents / For Each Bond. */
export const GetAgentRadiusNode: NodeTypeDef = {
  type: 'getAgentRadius',
  label: 'Get Agent Radius',
  description: "A specific agent's radius by id.",
  category: 'data',
  color: '#5e35b1',
  requirements: { bondGraph: true },
  ports: [
    { id: 'agentId', label: 'Agent', kind: 'input', category: 'value', dataType: 'integer' },
    { id: 'value', label: 'Radius', kind: 'output', category: 'value', dataType: 'float' },
  ],
  defaultConfig: {},
  // Range-guarded: -1 (the empty sentinel) / out-of-range → 0, not a NaN from
  // `_agentRadius[-1]` (WASM would read adjacent memory).
  compile: (nodeId, _config, inputs) =>
    `const __gar${nodeId} = ((${inputs['agentId'] || '-1'}) | 0); const _v${nodeId} = (__gar${nodeId} >= 0 && __gar${nodeId} < highWater) ? _agentRadius[__gar${nodeId}] : 0;\n`,
};

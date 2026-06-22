import type { NodeTypeDef } from '../types';

/** Get Radius — the agent's current radius (Bond-Graph Agents). Reads the
 *  engine geometry buffer `_agentRadius[idx]`. Useful for size-dependent rules
 *  (divide when grown, area-scaled secretion). The radius is engine-owned (grown
 *  via Set Target Radius); Get Cell Attribute cannot target it (the N4 guardrail). */
export const GetRadiusNode: NodeTypeDef = {
  type: 'getRadius',
  label: 'Get Radius',
  description: "Outputs the agent's current radius.",
  category: 'data',
  color: '#5e35b1',
  requirements: { bondGraph: true },
  ports: [
    { id: 'value', label: 'Radius', kind: 'output', category: 'value', dataType: 'float' },
  ],
  defaultConfig: {},
  compile: (nodeId) => `const _v${nodeId} = _agentRadius[idx];\n`,
};

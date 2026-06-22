import type { NodeTypeDef } from '../types';

/** Get Agent Position — the (X, Y) of a SPECIFIC agent by id (Bond-Graph
 *  Agents). Feed it a neighbour id from Get Nearby Agents / For Each Bond to
 *  read where a neighbour is (relative vectors for cohesion/separation/
 *  alignment, gradient following, …). Multi-output (`_v<id>_<port>`). */
export const GetAgentPositionNode: NodeTypeDef = {
  type: 'getAgentPosition',
  label: 'Get Agent Position',
  description: "Outputs a specific agent's (X, Y) by id — for relative vectors to neighbours.",
  category: 'data',
  color: '#5e35b1',
  requirements: { bondGraph: true },
  ports: [
    { id: 'agentId', label: 'Agent', kind: 'input', category: 'value', dataType: 'integer' },
    { id: 'x', label: 'X', kind: 'output', category: 'value', dataType: 'float' },
    { id: 'y', label: 'Y', kind: 'output', category: 'value', dataType: 'float' },
  ],
  defaultConfig: {},
  compile: (nodeId, _config, inputs) => {
    const a = `((${inputs['agentId'] || '0'}) | 0)`;
    return `const __ga${nodeId}=${a}; const _v${nodeId}_x=_agentX[__ga${nodeId}]; const _v${nodeId}_y=_agentY[__ga${nodeId}];\n`;
  },
};

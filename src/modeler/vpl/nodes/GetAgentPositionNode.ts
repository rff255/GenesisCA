import type { NodeTypeDef } from '../types';
import { is3dModelLike } from '../compiler/niCodec';

/** Get Agent Position — the (X, Y[, Z]) of a SPECIFIC agent by id (Bond-Graph
 *  Agents). Feed it a neighbour id from Get Nearby Agents / For Each Bond to
 *  read where a neighbour is (relative vectors for cohesion/separation/
 *  alignment, gradient following, …). Multi-output (`_v<id>_<port>`). The `Z`
 *  output exists only in a 3D-agent model (hidden in 2D). NOTE: prefer
 *  Get Agent Offset for relative vectors — it folds to the torus-shortest path. */
export const GetAgentPositionNode: NodeTypeDef = {
  type: 'getAgentPosition',
  label: 'Get Agent Position',
  description: "Outputs a specific agent's (X, Y, Z) by id — for relative vectors to neighbours.",
  category: 'data',
  color: '#5e35b1',
  requirements: { bondGraph: true },
  ports: [
    { id: 'agentId', label: 'Agent', kind: 'input', category: 'value', dataType: 'integer' },
    { id: 'x', label: 'X', kind: 'output', category: 'value', dataType: 'float' },
    { id: 'y', label: 'Y', kind: 'output', category: 'value', dataType: 'float' },
    { id: 'z', label: 'Z', kind: 'output', category: 'value', dataType: 'float' },
  ],
  hiddenPorts: (_config, model) => (is3dModelLike(model) ? [] : ['z']),
  defaultConfig: {},
  compile: (nodeId, _config, inputs, _boundary, ctx) => {
    const a = `((${inputs['agentId'] || '0'}) | 0)`;
    const z = ctx?.is3d ? ` const _v${nodeId}_z=_agentZ[__ga${nodeId}];` : '';
    return `const __ga${nodeId}=${a}; const _v${nodeId}_x=_agentX[__ga${nodeId}]; const _v${nodeId}_y=_agentY[__ga${nodeId}];${z}\n`;
  },
};

import type { NodeTypeDef } from '../types';
import { is3dModelLike } from '../compiler/niCodec';

/** Get Velocity — an agent's current velocity (Vx, Vy) (Bond-Graph Agents).
 *  Reads SELF when the Agent input is unwired, or a SPECIFIC agent when fed a
 *  neighbour id (from Get Nearby Agents) — average neighbours' velocities for
 *  boids ALIGNMENT. Meaningful when momentum > 0 (flocking). Multi-output. */
export const GetVelocityNode: NodeTypeDef = {
  type: 'getVelocity',
  label: 'Get Velocity',
  description: "An agent's velocity (Vx, Vy) — self if the Agent input is empty, else a neighbour's (for flocking alignment).",
  category: 'data',
  color: '#5e35b1',
  requirements: { bondGraph: true },
  ports: [
    { id: 'agentId', label: 'Agent', kind: 'input', category: 'value', dataType: 'integer' },
    { id: 'vx', label: 'Vx', kind: 'output', category: 'value', dataType: 'float' },
    { id: 'vy', label: 'Vy', kind: 'output', category: 'value', dataType: 'float' },
    { id: 'vz', label: 'Vz', kind: 'output', category: 'value', dataType: 'float' },
  ],
  // Vz only exists in a 3D-agent model.
  hiddenPorts: (_config, model) => (is3dModelLike(model) ? [] : ['vz']),
  defaultConfig: {},
  compile: (nodeId, _config, inputs, _boundary, ctx) => {
    const a = inputs['agentId'] ? `((${inputs['agentId']}) | 0)` : 'idx';
    return `const __gv${nodeId}=${a}; const _v${nodeId}_vx = _agentVX[__gv${nodeId}]; const _v${nodeId}_vy = _agentVY[__gv${nodeId}];${ctx?.is3d ? ` const _v${nodeId}_vz = _agentVZ[__gv${nodeId}];` : ''}\n`;
  },
};

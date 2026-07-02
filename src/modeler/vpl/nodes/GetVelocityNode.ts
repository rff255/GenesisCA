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
    // Unwired = SELF (always valid). A wired id is range-guarded: -1 (the empty
    // sentinel) / out-of-range → 0-velocity, not NaN from `_agentVX[-1]`.
    if (!inputs['agentId']) {
      return `const __gv${nodeId}=idx; const _v${nodeId}_vx = _agentVX[__gv${nodeId}]; const _v${nodeId}_vy = _agentVY[__gv${nodeId}];${ctx?.is3d ? ` const _v${nodeId}_vz = _agentVZ[__gv${nodeId}];` : ''}\n`;
    }
    const a = `((${inputs['agentId']}) | 0)`;
    const ok = `__gvOk${nodeId}`;
    return `const __gv${nodeId}=${a}; const ${ok} = __gv${nodeId} >= 0 && __gv${nodeId} < highWater;`
      + ` const _v${nodeId}_vx = ${ok} ? _agentVX[__gv${nodeId}] : 0; const _v${nodeId}_vy = ${ok} ? _agentVY[__gv${nodeId}] : 0;`
      + `${ctx?.is3d ? ` const _v${nodeId}_vz = ${ok} ? _agentVZ[__gv${nodeId}] : 0;` : ''}\n`;
  },
};

import type { NodeTypeDef } from '../types';
import { is3dModelLike } from '../compiler/niCodec';

/** Get Self Position — the agent's own continuous position (Bond-Graph Agents).
 *  The agent analogue of Get Cell Position: a controlled own-state read so an
 *  agent can behave by where it floats (spatial gradients, boundary avoidance,
 *  coordinate-aware appearance). Reads the engine geometry buffers `_agentX` /
 *  `_agentY` at the loop index `idx` (Decision D-IDX). Multi-output (resolved
 *  via the `_v<id>_<port>` convention). `z` only in a 3D-agent model (Phase E). */
export const GetSelfPositionNode: NodeTypeDef = {
  type: 'getSelfPosition',
  label: 'Get Self Position',
  description: "Outputs the agent's own continuous position (X, Y) in the world frame.",
  category: 'data',
  color: '#5e35b1',
  requirements: { bondGraph: true },
  ports: [
    { id: 'x', label: 'X', kind: 'output', category: 'value', dataType: 'float' },
    { id: 'y', label: 'Y', kind: 'output', category: 'value', dataType: 'float' },
    { id: 'z', label: 'Z', kind: 'output', category: 'value', dataType: 'float' },
  ],
  // Z only exists in a 3D-agent model (the compiler emits no _agentZ decode in 2D).
  hiddenPorts: (_config, model) => (is3dModelLike(model) ? [] : ['z']),
  defaultConfig: {},
  compile: (nodeId, _config, _inputs, _boundary, ctx) =>
    `const _v${nodeId}_x = _agentX[idx]; const _v${nodeId}_y = _agentY[idx];${ctx?.is3d ? ` const _v${nodeId}_z = _agentZ[idx];` : ''}\n`,
};

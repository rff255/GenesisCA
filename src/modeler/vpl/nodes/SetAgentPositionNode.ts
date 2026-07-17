import type { NodeTypeDef } from '../types';
import { is3dModelLike } from '../compiler/niCodec';

/** Set Agent Position — set an agent's position by id (Generic Agent Platform).
 *  A spawn helper: override the position of a staged agent (from Create Agent)
 *  before Add Agent To World. In the Init Event context the guard is range-only
 *  (a staged agent is alive=0); elsewhere it requires a live agent. JS-only. The
 *  `z` input exists only in a 3D-agent model (hidden in 2D). */
export const SetAgentPositionNode: NodeTypeDef = {
  type: 'setAgentPosition',
  label: 'Set Agent Position',
  agentLabel: 'Set Position (by ID)',
  description: "Set an agent's position by id (a Create Agent handle, or a live agent).",
  category: 'output',
  color: '#4527a0',
  requirements: { bondGraph: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'next', label: 'NEXT', kind: 'output', category: 'flow' },
    { id: 'agentId', label: 'Agent', kind: 'input', category: 'value', dataType: 'integer' },
    { id: 'x', label: 'X', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0' },
    { id: 'y', label: 'Y', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0' },
    { id: 'z', label: 'Z', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0' },
  ],
  hiddenPorts: (_config, model) => (is3dModelLike(model) ? [] : ['z']),
  defaultConfig: {},
  compile: (_nodeId, _config, inputs, _boundary, ctx) => {
    const id = `((${inputs['agentId'] || '-1'}) | 0)`;
    // Unified spawning: a freshly Created agent is STAGED (alive=0) until Add To
    // World, in BOTH the Init Event and the Behaviour graph — so relax the guard to
    // range-only in either root (writing a dead slot is a harmless no-op effect).
    const guard = (ctx?.agentRoot === 'init' || ctx?.agentRoot === 'behaviour')
      ? `__sp >= 0 && __sp < _agentMaxAgents`
      : `__sp >= 0 && __sp < highWater && _alive[__sp]`;
    const zWrite = ctx?.is3d ? ` _agentZ[__sp] = ${inputs['z'] || '0'};` : '';
    return `{ const __sp = ${id}; if (${guard}) { _agentX[__sp] = ${inputs['x'] || '0'}; _agentY[__sp] = ${inputs['y'] || '0'};${zWrite} } }\n`;
  },
};

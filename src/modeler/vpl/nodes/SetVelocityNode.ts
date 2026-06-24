import type { NodeTypeDef } from '../types';

/** Set Velocity — set this agent's velocity directly (Generic Agent Platform).
 *  The momentum companion to Apply Force: it seeds the integration velocity
 *  `_agentVX/VY[idx]` rather than accumulating a force. Integration-safe (NOT a
 *  teleport — positions still come from the engine integrator).
 *
 *  NOTE: only meaningful when the model's Momentum is > 0. Under the default
 *  overdamped mode (momentum 0) the integrator recomputes velocity from the
 *  force each step, so a Set Velocity write is overwritten — use Apply Force
 *  there instead. JS-only this milestone. */
export const SetVelocityNode: NodeTypeDef = {
  type: 'setVelocity',
  label: 'Set Velocity',
  description: "Sets this agent's velocity directly (needs Momentum > 0; the momentum companion to Apply Force).",
  category: 'output',
  color: '#4527a0',
  requirements: { bondGraph: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'next', label: 'NEXT', kind: 'output', category: 'flow' },
    { id: 'vx', label: 'Vx', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0' },
    { id: 'vy', label: 'Vy', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0' },
  ],
  defaultConfig: {},
  compile: (_nodeId, _config, inputs) => {
    return `_agentVX[idx] = ${inputs['vx'] || '0'}; _agentVY[idx] = ${inputs['vy'] || '0'};\n`;
  },
};

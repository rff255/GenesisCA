import type { NodeTypeDef } from '../types';

/** Set Target Radius — set the radius the agent grows toward (Bond-Graph
 *  Agents). The engine ramps the agent's actual radius toward this target each
 *  step (at `growthRate`); a bigger radius means stronger volume-exclusion
 *  pressure on its neighbours, which (Phase C) drives division on reaching the
 *  target. Writes the engine buffer `_agentTargetRadius[idx]`. NOT async-only —
 *  it writes an engine request buffer applied in-engine, no hazard. */
export const SetTargetRadiusNode: NodeTypeDef = {
  type: 'setTargetRadius',
  label: 'Set Target Radius',
  description: 'Set the radius the agent grows toward (the engine ramps the actual radius each step).',
  category: 'output',
  color: '#4527a0',
  requirements: { bondGraph: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'next', label: 'NEXT', kind: 'output', category: 'flow' },
    { id: 'value', label: 'Target', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '1' },
  ],
  defaultConfig: {},
  // C9 SAFETY CATCH: with the Growth field gated off there is no
  // `_agentTargetRadius` param and no ramp to feed, so the write is dropped.
  compile: (_nodeId, _config, inputs, _boundary, ctx) =>
    (ctx?.agentGates && !ctx.agentGates.targetRadius ? '' : `_agentTargetRadius[idx] = ${inputs['value'] || '1'};\n`),
};

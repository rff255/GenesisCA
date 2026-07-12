import type { NodeTypeDef } from '../types';

/** Overseer action — advance the simulation exactly N generations (awaited;
 *  internally batched so Abort stays responsive). This is a FIXED-count run: a
 *  Stop Event / End Condition does NOT halt it (that's what Run Until Stop is
 *  for), so every replicate reaches the same iteration — the fixed developmental
 *  time point an ensemble average needs. */
export const OvRunGenerationsNode: NodeTypeDef = {
  type: 'ovRunGenerations',
  label: 'Run Generations',
  description: 'Advances the simulation exactly N generations (a fixed-count run — a Stop Event does not cut it short; use Run Until Stop for detector-gated running).',
  category: 'output',
  color: '#3949ab',
  requirements: { overseer: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'count', label: 'Count', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '100' },
    { id: 'next', label: 'NEXT', kind: 'output', category: 'flow' },
  ],
  defaultConfig: {},
  compile: () => '', // Action — the overseer compiler emits `await O.run(count)`
};

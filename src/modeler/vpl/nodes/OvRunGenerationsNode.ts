import type { NodeTypeDef } from '../types';

/** Overseer action — advance the simulation N generations (awaited; internally
 *  batched so Abort stays responsive). A Stop Event / End Condition firing
 *  mid-run ends the advance early (journal-logged); use Run Until Stop when
 *  the stop IS the protocol. */
export const OvRunGenerationsNode: NodeTypeDef = {
  type: 'ovRunGenerations',
  label: 'Run Generations',
  description: 'Advances the simulation N generations, then continues the experiment flow. A Stop Event or End Condition ends the advance early.',
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

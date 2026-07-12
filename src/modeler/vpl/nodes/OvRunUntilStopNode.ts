import type { NodeTypeDef } from '../types';

/** Overseer action — run until a Stop Event fires (in the cell OR agent
 *  graph), an End Condition trips, or the safety cap is reached. The result
 *  ports report what happened; they hold the LAST execution's result (assigned
 *  when the action runs, readable anywhere downstream). */
export const OvRunUntilStopNode: NodeTypeDef = {
  type: 'ovRunUntilStop',
  label: 'Run Until Stop',
  description: 'Runs the simulation until a Stop Event fires, an End Condition trips, or Max Gens is reached. Outputs the generation it stopped at and why (0 = cap, 1 = stop event, 2 = end condition).',
  category: 'output',
  color: '#3949ab',
  requirements: { overseer: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'maxGens', label: 'Max Gens', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '100000' },
    { id: 'next', label: 'NEXT', kind: 'output', category: 'flow' },
    { id: 'atGeneration', label: 'At Generation', kind: 'output', category: 'value', dataType: 'integer' },
    { id: 'stoppedBy', label: 'Stopped By', kind: 'output', category: 'value', dataType: 'integer' },
  ],
  defaultConfig: {},
  compile: () => '', // Action — the overseer compiler assigns the result lets
};

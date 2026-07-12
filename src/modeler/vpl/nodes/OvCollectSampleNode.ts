import type { NodeTypeDef } from '../types';

/** Overseer data — append a value to a named sample series (the statistics
 *  store). Series are runtime artifacts: shown live in the Experiments panel,
 *  aggregated by Series Statistic, exported as CSV/JSON — never saved into the
 *  model file. Scope 'experiment' accumulates across the whole experiment;
 *  'run' clears at each Reset Board. */
export const OvCollectSampleNode: NodeTypeDef = {
  type: 'ovCollectSample',
  label: 'Collect Sample',
  description: 'Appends a value to a named sample series — e.g. one measurement per run. Aggregate with Series Statistic; export CSV from the Experiments panel.',
  category: 'output',
  color: '#6a1b9a',
  requirements: { overseer: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'value', label: 'Value', kind: 'input', category: 'value', dataType: 'any', inlineWidget: 'number', defaultValue: '0' },
    { id: 'next', label: 'NEXT', kind: 'output', category: 'flow' },
  ],
  defaultConfig: { series: 'samples', scope: 'experiment' },
  compile: () => '', // Action — the overseer compiler emits `O.sample(series, value)`
};

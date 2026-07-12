import type { NodeTypeDef } from '../types';

/** Overseer data — reset a named sample series (e.g. between sweep groups so
 *  each parameter value aggregates its own replicates). */
export const OvClearSeriesNode: NodeTypeDef = {
  type: 'ovClearSeries',
  label: 'Clear Series',
  description: 'Empties a named sample series — e.g. between parameter-sweep groups so each group aggregates only its own runs.',
  category: 'output',
  color: '#6a1b9a',
  requirements: { overseer: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'next', label: 'NEXT', kind: 'output', category: 'flow' },
  ],
  defaultConfig: { series: 'samples' },
  compile: () => '', // Action — the overseer compiler emits `O.clearSeries(series)`
};

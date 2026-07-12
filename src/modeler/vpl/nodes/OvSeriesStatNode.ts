import type { NodeTypeDef } from '../types';

/** Overseer aggregation — a scalar statistic over the current contents of a
 *  sample series: mean, std (sample, n−1), min, max, median, sum, count, or
 *  ci95 (the 1.96·std/√n half-width). Re-evaluated at every flow step that
 *  consumes it (always over the samples collected so far). */
export const OvSeriesStatNode: NodeTypeDef = {
  type: 'ovSeriesStat',
  label: 'Series Statistic',
  description: 'A statistic over a sample series: mean, std, min, max, median, sum, count, or the 95% CI half-width. The aggregation half of Collect Sample.',
  category: 'aggregation',
  color: '#6a1b9a',
  requirements: { overseer: true },
  ports: [
    { id: 'result', label: 'Result', kind: 'output', category: 'value', dataType: 'float' },
  ],
  defaultConfig: { series: 'samples', op: 'mean' },
  compile: (nodeId, config) => {
    const series = String(config.series ?? 'samples');
    const op = String(config.op ?? 'mean');
    return `const _v${nodeId} = O.stat(${JSON.stringify(series)}, ${JSON.stringify(op)});\n`;
  },
};

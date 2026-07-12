import type { NodeTypeDef } from '../types';

/** Overseer data — capture a SPATIAL indicator's current per-position-bin
 *  curve (one category, e.g. solute S1 of a chromatogram) as ONE run of a
 *  named spatial series. Across a replicate loop this builds run-per-row
 *  curve stacks that the Experiments panel aggregates into a mean ± σ chart
 *  (the replicate-averaged chromatogram of the Kier chromatography papers) —
 *  a far stronger statistical picture of the distribution than any single
 *  run's noisy curve. Series sharing a Chart name overlay on the same axes
 *  (e.g. S1 + S2 on one chromatogram). */
export const OvCollectSpatialNode: NodeTypeDef = {
  type: 'ovCollectSpatial',
  label: 'Collect Spatial Sample',
  description: 'Captures a spatial indicator’s whole per-position curve (one category) as one replicate of a named series — aggregated to a mean ± σ chart in the Experiments panel (e.g. the run-averaged chromatogram).',
  category: 'output',
  color: '#6a1b9a',
  requirements: { overseer: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'next', label: 'NEXT', kind: 'output', category: 'flow' },
  ],
  defaultConfig: { indicatorId: '', category: '', series: 'profile', chart: '' },
  compile: () => '', // Action — the overseer compiler emits `O.sampleSpatial(...)`
};

import type { NodeTypeDef } from '../types';

/** Overseer action — seed the simulation's RNG stream (the shared xorshift32
 *  on JS/WASM; the per-cell PCG global seed on WebGPU). Seed BEFORE Reset
 *  Board so Init Event randomization is governed by the run's seed. Also
 *  re-seeds the Overseer graph's own Get Random stream. Within-target
 *  reproducibility: JS/WASM are bit-reproducible per seed; WebGPU is
 *  statistically equivalent (documented target difference). */
export const OvSetSeedNode: NodeTypeDef = {
  type: 'ovSetSeed',
  label: 'Set Random Seed',
  description: 'Seeds the simulation RNG (and the experiment RNG) so a run is reproducible. Place before Reset Board — e.g. seed = base + loop index for replicate statistics.',
  category: 'output',
  color: '#3949ab',
  requirements: { overseer: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'seed', label: 'Seed', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '12345' },
    { id: 'next', label: 'NEXT', kind: 'output', category: 'flow' },
  ],
  defaultConfig: {},
  compile: () => '', // Action — the overseer compiler emits `await O.setSeed(seed)`
};

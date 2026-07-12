import type { NodeTypeDef } from '../types';

/** Overseer action — apply one of the model's presets (parameter sets /
 *  board snapshots). v1 supports LIVE-applying presets only: a preset whose
 *  grid dimensions or boundary treatment differ from the current simulation
 *  would force a structural worker reinit mid-experiment and is journal-logged
 *  + skipped instead. */
export const OvLoadPresetNode: NodeTypeDef = {
  type: 'ovLoadPreset',
  label: 'Load Preset',
  description: 'Applies a model preset (parameter set / board snapshot) as the protocol step — e.g. start each sweep group from a named configuration. Presets that would resize the grid are skipped (journal-logged).',
  category: 'output',
  color: '#3949ab',
  requirements: { overseer: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'next', label: 'NEXT', kind: 'output', category: 'flow' },
  ],
  defaultConfig: { presetId: '' },
  compile: () => '', // Action — the overseer compiler emits `await O.loadPreset(id)`
};

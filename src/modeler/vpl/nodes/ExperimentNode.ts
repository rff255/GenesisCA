import type { NodeTypeDef } from '../types';

/** Overseer — the experiment entry point. Runs ONCE when the user presses
 *  "Run Experiment" in the simulator's Experiments panel. The DO chain is the
 *  whole experiment protocol (loops over runs, parameter sweeps, statistics).
 *  Singleton (enforced like Step / Init Event). */
export const ExperimentNode: NodeTypeDef = {
  type: 'experiment',
  label: 'Experiment',
  description: 'Entry point of the Overseer graph. Runs once when the user presses Run Experiment in the simulator — the DO chain is the whole experiment protocol.',
  category: 'event',
  color: '#ffffff',
  requirements: { overseer: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'output', category: 'flow' },
  ],
  defaultConfig: {},
  compile: () => '', // Root — the overseer compiler handles it specially
};

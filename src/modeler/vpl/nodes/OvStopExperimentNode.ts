import type { NodeTypeDef } from '../types';

/** Overseer control — ends the experiment program immediately (journal-logged
 *  with the message). The simulation itself is left paused at its current
 *  state; series/journal keep their contents. No NEXT port — nothing runs
 *  after it. */
export const OvStopExperimentNode: NodeTypeDef = {
  type: 'ovStopExperiment',
  label: 'Stop Experiment',
  description: 'Ends the experiment immediately (e.g. from a Conditional when a target is reached). The message is journal-logged; collected series are kept.',
  category: 'output',
  color: '#b71c1c',
  requirements: { overseer: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
  ],
  defaultConfig: { message: 'Experiment stopped' },
  compile: () => '', // Action — the overseer compiler emits `O.stopExperiment(msg); return;`
};

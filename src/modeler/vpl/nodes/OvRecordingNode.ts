import type { NodeTypeDef } from '../types';

/** Overseer capture — start recording the simulation view (GIF or WebM, the
 *  transport-bar recorder). Stop with Stop Recording; the encoded file
 *  downloads and the journal notes both moments. Only meaningful on the
 *  watched (visible) run. */
export const OvStartRecordingNode: NodeTypeDef = {
  type: 'ovStartRecording',
  label: 'Start Recording',
  description: 'Starts recording the simulation view (the transport recorder). Pair with Stop Recording — e.g. record only run 1 of a batch.',
  category: 'output',
  color: '#546e7a',
  requirements: { overseer: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'next', label: 'NEXT', kind: 'output', category: 'flow' },
  ],
  defaultConfig: {},
  compile: () => '', // Action — the overseer compiler emits `await O.startRecording()`
};

/** Overseer capture — stop the running recording and encode/download it. */
export const OvStopRecordingNode: NodeTypeDef = {
  type: 'ovStopRecording',
  label: 'Stop Recording',
  description: 'Stops the running recording; the encoded GIF/WebM downloads (format = the transport bar selection).',
  category: 'output',
  color: '#546e7a',
  requirements: { overseer: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'next', label: 'NEXT', kind: 'output', category: 'flow' },
  ],
  defaultConfig: {},
  compile: () => '', // Action — the overseer compiler emits `await O.stopRecording()`
};

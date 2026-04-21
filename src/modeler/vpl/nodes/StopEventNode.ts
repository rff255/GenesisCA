import type { NodeTypeDef } from '../types';

/** Stop Event — when its flow input fires, the simulator pauses and shows the
 *  configured message. Useful for condition-driven early termination that max
 *  generations or indicator rules can't express. Multiple Stop Events can
 *  coexist; the first one reached during a step wins. */
export const StopEventNode: NodeTypeDef = {
  type: 'stopEvent',
  label: 'Stop Event',
  description: 'Pauses the simulation with a user-defined message when its flow input fires.',
  category: 'flow',
  color: '#e05050',
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
  ],
  defaultConfig: { message: 'Stop condition reached', _stopIdx: -1 },
  compile: (nodeId, config) => {
    // The compiler assigns `_stopIdx` (1-based) at the top of compileGraph;
    // emit code that writes this index into the shared stop flag. First
    // match wins — subsequent stop events in the same step are ignored so
    // the user sees the root-cause reason, not the last-one-written.
    const idx = Number(config._stopIdx ?? 0);
    void nodeId;
    if (!idx) return '';
    return `if (_stopFlag[0] === 0) _stopFlag[0] = ${idx};\n`;
  },
};

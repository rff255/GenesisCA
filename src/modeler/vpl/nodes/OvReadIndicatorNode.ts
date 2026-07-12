import type { NodeTypeDef } from '../types';

/** Overseer measurement — read the latest value of an indicator (the
 *  measurement layer: the Overseer never scans the grid, it reads what
 *  indicators already compute on all three targets). For a linked FREQUENCY
 *  indicator, set Category to the tracked value to read (bool: 'true'/'false';
 *  tag: the option name); scalar indicators leave it blank. Values are valid
 *  after a Reset Board / Run has completed this run. Re-evaluated at every
 *  flow step that consumes it (always fresh). */
export const OvReadIndicatorNode: NodeTypeDef = {
  type: 'ovReadIndicator',
  label: 'Read Indicator',
  description: 'Reads the current value of an indicator (the measurement layer). For frequency indicators, pick the category to read. Always reads the latest simulated value.',
  category: 'data',
  color: '#00838f',
  requirements: { overseer: true },
  ports: [
    { id: 'value', label: 'Value', kind: 'output', category: 'value', dataType: 'float' },
  ],
  defaultConfig: { indicatorId: '', category: '' },
  compile: (nodeId, config) => {
    const id = String(config.indicatorId ?? '');
    const cat = String(config.category ?? '');
    const catArg = cat !== '' ? `, ${JSON.stringify(cat)}` : '';
    return `const _v${nodeId} = O.indicator(${JSON.stringify(id)}${catArg});\n`;
  },
};

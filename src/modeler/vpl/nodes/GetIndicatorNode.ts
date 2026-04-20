import type { NodeTypeDef } from '../types';

export const GetIndicatorNode: NodeTypeDef = {
  type: 'getIndicator',
  label: 'Get Indicator',
  description: 'Reads the current value of a standalone indicator.',
  category: 'data',
  color: '#b71c1c',
  ports: [
    { id: 'value', label: 'Value', kind: 'output', category: 'value', dataType: 'any' },
  ],
  defaultConfig: { indicatorId: '' },
  compile: (nodeId, config) => {
    const idx = Number(config._indicatorIdx ?? -1);
    return `const _v${nodeId} = _indicators[${idx}];\n`;
  },
};

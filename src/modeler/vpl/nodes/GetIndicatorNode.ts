import type { NodeTypeDef } from '../types';

export const GetIndicatorNode: NodeTypeDef = {
  type: 'getIndicator',
  label: 'Get Indicator',
  category: 'data',
  color: '#b71c1c',
  ports: [
    { id: 'value', label: 'Value', kind: 'output', category: 'value', dataType: 'any' },
  ],
  defaultConfig: { indicatorId: '' },
  compile: (nodeId, config) => {
    const indId = config.indicatorId as string || '_undef';
    return `const _v${nodeId} = _indicators[${JSON.stringify(indId)}];\n`;
  },
};

import type { NodeTypeDef } from '../types';

export const SetIndicatorNode: NodeTypeDef = {
  type: 'setIndicator',
  label: 'Set Indicator',
  category: 'output',
  color: '#00695c',
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'value', label: 'Value', kind: 'input', category: 'value', dataType: 'any', inlineWidget: 'number', defaultValue: '0' },
  ],
  defaultConfig: { indicatorId: '' },
  compile: (nodeId, config, inputs) => {
    const indId = config.indicatorId as string || '_undef';
    const value = inputs['value'] || '0';
    void nodeId;
    return `_indicators[${JSON.stringify(indId)}] = ${value};\n`;
  },
};

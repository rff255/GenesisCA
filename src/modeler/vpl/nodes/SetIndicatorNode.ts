import type { NodeTypeDef } from '../types';

export const SetIndicatorNode: NodeTypeDef = {
  type: 'setIndicator',
  label: 'Set Indicator',
  description: 'Assigns a value to a standalone indicator.',
  category: 'output',
  color: '#00695c',
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'value', label: 'Value', kind: 'input', category: 'value', dataType: 'any', inlineWidget: 'number', defaultValue: '0' },
  ],
  defaultConfig: { indicatorId: '' },
  compile: (nodeId, config, inputs) => {
    const idx = Number(config._indicatorIdx ?? -1);
    const value = inputs['value'] || '0';
    void nodeId;
    return `_indicators[${idx}] = ${value};\n`;
  },
};

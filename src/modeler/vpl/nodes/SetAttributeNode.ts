import type { NodeTypeDef } from '../types';

export const SetAttributeNode: NodeTypeDef = {
  type: 'setAttribute',
  label: 'Set Attribute',
  category: 'output',
  color: '#4a148c',
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'value', label: 'Value', kind: 'input', category: 'value', dataType: 'any', inlineWidget: 'number', defaultValue: '0' },
  ],
  defaultConfig: { attributeId: '' },
  compile: (nodeId, config, inputs) => {
    const attr = config.attributeId as string || '_undef';
    const value = inputs['value'] || '0';
    void nodeId;
    return `w_${attr}[idx] = ${value};\n`;
  },
};

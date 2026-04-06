import type { NodeTypeDef } from '../types';

export const SetAttributeNode: NodeTypeDef = {
  type: 'setAttribute',
  label: 'Set Attribute',
  category: 'output',
  color: '#4a148c',
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'value', label: 'Value', kind: 'input', category: 'value', dataType: 'any' },
  ],
  defaultConfig: { attributeId: '' },
  compile: (nodeId, config, inputs) => {
    const attr = config.attributeId as string || 'undefined';
    const value = inputs['value'] || 'undefined';
    void nodeId; // not used — setAttribute doesn't produce an output variable
    return `result[${JSON.stringify(attr)}] = ${value};\n`;
  },
};

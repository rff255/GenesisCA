import type { NodeTypeDef } from '../types';

export const GetCellAttributeNode: NodeTypeDef = {
  type: 'getCellAttribute',
  label: 'Get Cell Attribute',
  description: 'Reads an attribute value from the current cell.',
  category: 'data',
  color: '#b71c1c',
  ports: [
    { id: 'value', label: 'Value', kind: 'output', category: 'value', dataType: 'any' },
  ],
  defaultConfig: { attributeId: '' },
  compile: (nodeId, config) => {
    const attr = config.attributeId as string || '_undef';
    return `const _v${nodeId} = r_${attr}[idx];\n`;
  },
};

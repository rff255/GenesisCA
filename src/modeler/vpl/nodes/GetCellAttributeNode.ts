import type { NodeTypeDef } from '../types';

export const GetCellAttributeNode: NodeTypeDef = {
  type: 'getCellAttribute',
  label: 'Get Cell Attribute',
  category: 'data',
  color: '#b71c1c',
  ports: [
    { id: 'value', label: 'Value', kind: 'output', category: 'value', dataType: 'any' },
  ],
  defaultConfig: { attributeId: '' },
  compile: (nodeId, config) => {
    const attr = config.attributeId as string || 'undefined';
    return `const _v${nodeId} = cell[${JSON.stringify(attr)}];\n`;
  },
};

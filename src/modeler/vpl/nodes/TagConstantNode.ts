import type { NodeTypeDef } from '../types';

export const TagConstantNode: NodeTypeDef = {
  type: 'tagConstant',
  label: 'Tag Constant',
  description: 'Emits a fixed tag value (stored as its index).',
  category: 'data',
  color: '#6a1b9a',
  ports: [
    { id: 'value', label: 'Value', kind: 'output', category: 'value', dataType: 'integer' },
  ],
  defaultConfig: { attributeId: '', tagIndex: 0 },
  compile: (nodeId, config) => {
    const tagIndex = Number(config.tagIndex) || 0;
    return `const _v${nodeId} = ${tagIndex};\n`;
  },
};

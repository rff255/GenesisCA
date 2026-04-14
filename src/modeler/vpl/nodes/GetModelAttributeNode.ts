import type { NodeTypeDef } from '../types';

export const GetModelAttributeNode: NodeTypeDef = {
  type: 'getModelAttribute',
  label: 'Get Model Attribute',
  description: 'Reads a global (model-level) attribute. All cells see the same value.',
  category: 'data',
  color: '#b71c1c',
  ports: [
    { id: 'value', label: 'Value', kind: 'output', category: 'value', dataType: 'any' },
    { id: 'r', label: 'R', kind: 'output', category: 'value', dataType: 'integer' },
    { id: 'g', label: 'G', kind: 'output', category: 'value', dataType: 'integer' },
    { id: 'b', label: 'B', kind: 'output', category: 'value', dataType: 'integer' },
  ],
  defaultConfig: { attributeId: '', isColorAttr: false },
  compile: (nodeId, config) => {
    const attr = config.attributeId as string || 'undefined';
    if (config.isColorAttr) {
      return [
        `const _v${nodeId}_r = modelAttrs[${JSON.stringify(attr + '_r')}];`,
        `const _v${nodeId}_g = modelAttrs[${JSON.stringify(attr + '_g')}];`,
        `const _v${nodeId}_b = modelAttrs[${JSON.stringify(attr + '_b')}];`,
      ].join('\n') + '\n';
    }
    return `const _v${nodeId} = modelAttrs[${JSON.stringify(attr)}];\n`;
  },
};

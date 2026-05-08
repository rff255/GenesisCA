import type { NodeTypeDef } from '../types';

export const ArrayLengthNode: NodeTypeDef = {
  type: 'arrayLength',
  label: 'Array Length',
  description: 'Returns the number of elements in an array.',
  category: 'data',
  color: '#b71c1c',
  ports: [
    { id: 'array', label: 'Array', kind: 'input', category: 'value', dataType: 'any', isArray: true },
    { id: 'length', label: 'Length', kind: 'output', category: 'value', dataType: 'integer' },
  ],
  defaultConfig: {},
  compile: (nodeId, _config, inputs) => {
    const arr = inputs['array'] || '[]';
    return `const _v${nodeId} = ${arr}.length | 0;\n`;
  },
};

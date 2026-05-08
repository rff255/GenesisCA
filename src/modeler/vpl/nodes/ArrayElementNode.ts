import type { NodeTypeDef } from '../types';

export const ArrayElementNode: NodeTypeDef = {
  type: 'arrayElement',
  label: 'Array Element',
  description: 'Returns the element of an array at the given position. Out-of-range yields a safe default (-1 for NeighborIndex, 0 for numeric, false for bool).',
  category: 'data',
  color: '#b71c1c',
  ports: [
    { id: 'array', label: 'Array', kind: 'input', category: 'value', dataType: 'any', isArray: true },
    { id: 'position', label: 'Position', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '0' },
    { id: 'value', label: 'Value', kind: 'output', category: 'value', dataType: 'any' },
  ],
  defaultConfig: {},
  compile: (nodeId, _config, inputs) => {
    const arr = inputs['array'] || '[]';
    const pos = inputs['position'] || '0';
    return [
      `const _aei${nodeId} = (${pos}) | 0;`,
      `const _v${nodeId} = (_aei${nodeId} >= 0 && _aei${nodeId} < ${arr}.length) ? ${arr}[_aei${nodeId}] : -1;`,
    ].join(' ') + '\n';
  },
};

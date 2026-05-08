import type { NodeTypeDef } from '../types';

/** Out-of-range default: the universal sentinel `INVALID_NI = 0x80000000`.
 *  This is i32 min — unlikely to collide with any meaningful numeric or NI
 *  value. Consumers that care can guard with `value !== 0x80000000`. */
export const ArrayElementNode: NodeTypeDef = {
  type: 'arrayElement',
  label: 'Array Element',
  description: 'Returns the element of an array at the given position. Out-of-range yields a safe sentinel (INVALID_NI, 0x80000000).',
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
      `const _v${nodeId} = (_aei${nodeId} >= 0 && _aei${nodeId} < ${arr}.length) ? ${arr}[_aei${nodeId}] : ${0x80000000 | 0};`,
    ].join(' ') + '\n';
  },
};

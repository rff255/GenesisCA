import type { NodeTypeDef } from '../types';
import { INVALID_NI } from '../compiler/niCodec';

/** Out-of-range default depends on the array's element kind, resolved at
 *  compile time by inspecting the source nodeType:
 *    - NI[] sources (filterNeighbors, getAllNeighborIndexes, etc.) →
 *      `INVALID_NI` (the universal "no neighbor" sentinel)
 *    - value[] sources (getNeighborsAttribute, getNeighborsAttrByIndexes) and
 *      position-list sources (groupCounting/Statement.indexes) → `0`
 *  The compiler pre-pass sets `config._elemKind` ('ni' | 'value') so the emit
 *  can pick the right default without changing the compile() signature. */
export const ArrayElementNode: NodeTypeDef = {
  type: 'arrayElement',
  label: 'Array Element',
  description: 'Returns the element of an array at the given position. Out-of-range yields INVALID_NI for NI arrays, 0 for value arrays.',
  category: 'data',
  color: '#b71c1c',
  ports: [
    { id: 'array', label: 'Array', kind: 'input', category: 'value', dataType: 'any', isArray: true },
    { id: 'position', label: 'Position', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '0' },
    { id: 'value', label: 'Value', kind: 'output', category: 'value', dataType: 'any' },
  ],
  defaultConfig: {},
  compile: (nodeId, config, inputs) => {
    const arr = inputs['array'] || '[]';
    const pos = inputs['position'] || '0';
    const fallback = (config._elemKind as string) === 'ni' ? String(INVALID_NI) : '0';
    return [
      `const _aei${nodeId} = (${pos}) | 0;`,
      `const _v${nodeId} = (_aei${nodeId} >= 0 && _aei${nodeId} < ${arr}.length) ? ${arr}[_aei${nodeId}] : ${fallback};`,
    ].join(' ') + '\n';
  },
};

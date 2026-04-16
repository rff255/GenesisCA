import type { NodeTypeDef } from '../types';

export const GetNeighborAttributeByIndexNode: NodeTypeDef = {
  type: 'getNeighborAttributeByIndex',
  label: 'Get Neighbor Attr By Index',
  description: 'Reads one neighbor\u2019s attribute given its index in the neighborhood. If given an array of indices, reads the first one.',
  category: 'data',
  color: '#b71c1c',
  ports: [
    { id: 'index', label: 'Index', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '0' },
    { id: 'value', label: 'Value', kind: 'output', category: 'value', dataType: 'any' },
  ],
  defaultConfig: { neighborhoodId: '', attributeId: '' },
  compile: (nodeId, config, inputs) => {
    const nbrId = config.neighborhoodId as string || '_undef';
    const attr = config.attributeId as string || '_undef';
    const index = inputs['index'] || '0';
    // Accept either a scalar index or an array (taking element 0) — without this guard, an array
    // input (e.g. from getNeighborIndexesByTags) is coerced via "(arr) | 0" which only happens to
    // work for single-element arrays via toString and silently returns 0 for any other length.
    return [
      `const _idx${nodeId} = ${index};`,
      `const _ix${nodeId} = (Array.isArray(_idx${nodeId}) ? (_idx${nodeId}[0] ?? 0) : _idx${nodeId}) | 0;`,
      `const _v${nodeId} = r_${attr}[nIdx_${nbrId}[idx * nSz_${nbrId} + _ix${nodeId}]];`,
    ].join(' ') + '\n';
  },
};

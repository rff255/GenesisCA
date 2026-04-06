import type { NodeTypeDef } from '../types';

export const GetNeighborsAttributeNode: NodeTypeDef = {
  type: 'getNeighborsAttribute',
  label: 'Get Neighbors Attribute',
  category: 'data',
  color: '#b71c1c',
  ports: [
    { id: 'values', label: 'Values', kind: 'output', category: 'value', dataType: 'any', isArray: true },
  ],
  defaultConfig: { neighborhoodId: '', attributeId: '' },
  compile: (nodeId, config) => {
    const nbrId = config.neighborhoodId as string || '_undef';
    const attr = config.attributeId as string || '_undef';
    // Compute base offset into the full neighbor index array, read neighbor values
    return [
      `const _nb${nodeId} = idx * nSz_${nbrId};`,
      `const _v${nodeId} = new Array(nSz_${nbrId}); for (let _n = 0; _n < nSz_${nbrId}; _n++) _v${nodeId}[_n] = r_${attr}[nIdx_${nbrId}[_nb${nodeId} + _n]];`,
    ].join(' ') + '\n';
  },
};

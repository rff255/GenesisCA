import type { NodeTypeDef } from '../types';

export const GetNeighborsAttributeNode: NodeTypeDef = {
  type: 'getNeighborsAttribute',
  label: 'Get Neighbors Attribute',
  description: 'Reads one attribute from every neighbor in a neighborhood, as an array.',
  category: 'data',
  color: '#b71c1c',
  ports: [
    { id: 'values', label: 'Values', kind: 'output', category: 'value', dataType: 'any', isArray: true },
  ],
  defaultConfig: { neighborhoodId: '', attributeId: '' },
  compile: (nodeId, config) => {
    const nbrId = config.neighborhoodId as string || '_undef';
    const attr = config.attributeId as string || '_undef';
    // Fill pre-declared scratch array (declared before the loop by compiler)
    // _scr_<nodeId> is declared in the function preamble
    return [
      `const _nb${nodeId} = idx * nSz_${nbrId};`,
      `for (let _n = 0; _n < nSz_${nbrId}; _n++) _scr_${nodeId}[_n] = r_${attr}[nIdx_${nbrId}[_nb${nodeId} + _n]];`,
    ].join(' ') + '\n';
  },
};

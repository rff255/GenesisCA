import type { NodeTypeDef } from '../types';

export const GetNeighborAttributeByTagNode: NodeTypeDef = {
  type: 'getNeighborAttributeByTag',
  label: 'Get Neighbor Attr By Tag',
  description: 'Reads a neighbor\u2019s attribute by a named tag defined on the neighborhood.',
  category: 'data',
  color: '#b71c1c',
  ports: [
    { id: 'value', label: 'Value', kind: 'output', category: 'value', dataType: 'any' },
  ],
  defaultConfig: { neighborhoodId: '', attributeId: '', tagName: '' },
  compile: (nodeId, config) => {
    const nbrId = config.neighborhoodId as string || '_undef';
    const attr = config.attributeId as string || '_undef';
    // _resolvedTagIndex is set by the compiler pre-pass
    const tagIndex = (config._resolvedTagIndex as number) ?? 0;
    return `const _v${nodeId} = r_${attr}[nIdx_${nbrId}[idx * nSz_${nbrId} + ${tagIndex}]];\n`;
  },
};

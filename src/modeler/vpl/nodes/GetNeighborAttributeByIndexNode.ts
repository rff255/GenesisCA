import type { NodeTypeDef } from '../types';

export const GetNeighborAttributeByIndexNode: NodeTypeDef = {
  type: 'getNeighborAttributeByIndex',
  label: 'Get Neighbor Attr By Index',
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
    return `const _v${nodeId} = r_${attr}[nIdx_${nbrId}[idx * nSz_${nbrId} + ((${index}) | 0)]];\n`;
  },
};

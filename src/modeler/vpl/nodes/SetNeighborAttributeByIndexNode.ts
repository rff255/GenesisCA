import type { NodeTypeDef } from '../types';

export const SetNeighborAttributeByIndexNode: NodeTypeDef = {
  type: 'setNeighborAttributeByIndex',
  label: 'Set Neighbor Attr By Index',
  category: 'output',
  color: '#4a148c',
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'index', label: 'Index', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '0' },
    { id: 'value', label: 'Value', kind: 'input', category: 'value', dataType: 'any', inlineWidget: 'number', defaultValue: '0' },
  ],
  defaultConfig: { neighborhoodId: '', attributeId: '' },
  compile: (nodeId, config, inputs) => {
    const nbrId = config.neighborhoodId as string || '_undef';
    const attr = config.attributeId as string || '_undef';
    const index = inputs['index'] || '0';
    const value = inputs['value'] || '0';
    return [
      `const _ni${nodeId} = nIdx_${nbrId}[idx * nSz_${nbrId} + ((${index}) | 0)];`,
      `if (_ni${nodeId} < total) w_${attr}[_ni${nodeId}] = ${value};`,
    ].join(' ') + '\n';
  },
};

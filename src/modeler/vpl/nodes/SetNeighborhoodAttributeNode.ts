import type { NodeTypeDef } from '../types';

export const SetNeighborhoodAttributeNode: NodeTypeDef = {
  type: 'setNeighborhoodAttribute',
  label: 'Set Neighborhood Attribute',
  description: 'Writes a value to the same attribute of every neighbor in the neighborhood. Async-only.',
  category: 'output',
  color: '#4a148c',
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'value', label: 'Value', kind: 'input', category: 'value', dataType: 'any', inlineWidget: 'number', defaultValue: '0' },
  ],
  defaultConfig: { neighborhoodId: '', attributeId: '' },
  compile: (nodeId, config, inputs) => {
    const nbrId = config.neighborhoodId as string || '_undef';
    const attr = config.attributeId as string || '_undef';
    const value = inputs['value'] || '0';
    return [
      `const _nb${nodeId} = idx * nSz_${nbrId};`,
      `for (let _n${nodeId} = 0; _n${nodeId} < nSz_${nbrId}; _n${nodeId}++) {`,
      `  const _ni${nodeId} = nIdx_${nbrId}[_nb${nodeId} + _n${nodeId}];`,
      `  if (_ni${nodeId} < total) w_${attr}[_ni${nodeId}] = ${value};`,
      `}`,
    ].join(' ') + '\n';
  },
};

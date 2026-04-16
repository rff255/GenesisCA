import type { NodeTypeDef } from '../types';

export const SetNeighborAttributeByIndexNode: NodeTypeDef = {
  type: 'setNeighborAttributeByIndex',
  label: 'Set Neighbor Attr By Index',
  description: 'Writes a value to one neighbor\u2019s attribute at the given index. Accepts an array of indices to write to multiple neighbors. Async-only.',
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
    // Branch on Array.isArray once per cell; V8 specializes both paths.
    // Without this, an array index input (e.g. from getNeighborIndexesByTags or filterNeighbors)
    // is coerced via "((arr) | 0)" which silently picks index 0 for any multi-element or empty
    // array — a footgun. Single-element arrays only worked by accident through toString coercion.
    return [
      `const _idx${nodeId} = ${index};`,
      `if (Array.isArray(_idx${nodeId})) {`,
      `  for (let _ai${nodeId} = 0; _ai${nodeId} < _idx${nodeId}.length; _ai${nodeId}++) {`,
      `    const _ni${nodeId}_a = nIdx_${nbrId}[idx * nSz_${nbrId} + ((_idx${nodeId}[_ai${nodeId}]) | 0)];`,
      `    if (_ni${nodeId}_a < total) w_${attr}[_ni${nodeId}_a] = ${value};`,
      `  }`,
      `} else {`,
      `  const _ni${nodeId} = nIdx_${nbrId}[idx * nSz_${nbrId} + ((_idx${nodeId}) | 0)];`,
      `  if (_ni${nodeId} < total) w_${attr}[_ni${nodeId}] = ${value};`,
      `}`,
    ].join(' ') + '\n';
  },
};

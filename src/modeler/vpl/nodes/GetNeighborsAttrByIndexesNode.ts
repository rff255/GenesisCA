import type { NodeTypeDef } from '../types';

export const GetNeighborsAttrByIndexesNode: NodeTypeDef = {
  type: 'getNeighborsAttrByIndexes',
  label: 'Get Neighbors Attr By Indexes',
  description: 'Reads neighbor attribute values for a provided list of indices.',
  category: 'data',
  color: '#b71c1c',
  ports: [
    { id: 'indexes', label: 'Indexes', kind: 'input', category: 'value', dataType: 'any', isArray: true },
    { id: 'values', label: 'Values', kind: 'output', category: 'value', dataType: 'any', isArray: true },
  ],
  defaultConfig: { neighborhoodId: '', attributeId: '' },
  compile: (nodeId, config, inputs) => {
    const nbrId = config.neighborhoodId as string || '_undef';
    const attr = config.attributeId as string || '_undef';
    const indexes = inputs['indexes'] || '[]';
    const ni = `_ni${nodeId}`;
    const vl = `_v${nodeId}_valsLen`;
    return [
      `_v${nodeId}_vals.length = 0; let ${vl} = 0;`,
      `for (let ${ni} = 0; ${ni} < ${indexes}.length; ${ni}++) {`,
      `  _v${nodeId}_vals[${vl}++] = r_${attr}[nIdx_${nbrId}[idx * nSz_${nbrId} + ((${indexes}[${ni}]) | 0)]];`,
      `}`,
    ].join(' ') + '\n';
  },
};

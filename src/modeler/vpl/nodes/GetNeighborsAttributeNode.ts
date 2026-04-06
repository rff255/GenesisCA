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
    const nbrId = config.neighborhoodId as string || '';
    const attr = config.attributeId as string || 'undefined';
    return `const _v${nodeId} = neighbors[${JSON.stringify(nbrId)}].map(n => n[${JSON.stringify(attr)}]);\n`;
  },
};

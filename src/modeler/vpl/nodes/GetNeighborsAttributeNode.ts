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
    const nbrVar = `neighbors[${JSON.stringify(nbrId)}]`;
    const attrStr = JSON.stringify(attr);
    return `const _v${nodeId} = new Array(${nbrVar}.length); for (let _i = 0; _i < ${nbrVar}.length; _i++) _v${nodeId}[_i] = ${nbrVar}[_i][${attrStr}];\n`;
  },
};

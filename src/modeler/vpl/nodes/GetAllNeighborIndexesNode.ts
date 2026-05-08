import type { NodeTypeDef } from '../types';

export const GetAllNeighborIndexesNode: NodeTypeDef = {
  type: 'getAllNeighborIndexes',
  label: 'Get All Neighbor Indexes',
  description: 'Returns the full NeighborIndex array of a neighborhood — every slot, [0, 1, …, nbrSize-1]. Bootstrap for filterNeighbors / forEachInArray chains without needing tags.',
  category: 'data',
  color: '#b71c1c',
  ports: [
    { id: 'indexes', label: 'Indexes', kind: 'output', category: 'value', dataType: 'neighborIndex', isArray: true },
  ],
  defaultConfig: { neighborhoodId: '' },
  compile: (nodeId, config) => {
    // _resolvedNbrSize is set by the compiler pre-pass (looks up the neighborhood's coord count).
    const size = config._resolvedNbrSize !== undefined ? Number(config._resolvedNbrSize) : 0;
    const indices: number[] = [];
    for (let i = 0; i < size; i++) indices.push(i);
    return `const _v${nodeId} = [${indices.join(', ')}];\n`;
  },
};

import type { NodeTypeDef } from '../types';

/** Wave A.6: emits a literal i32[] of packed (dr, dc) for every slot of the
 *  configured neighborhood. The pre-pass populates `_resolvedPackedAll` as
 *  a JSON array of i32s. */
export const GetAllNeighborIndexesNode: NodeTypeDef = {
  type: 'getAllNeighborIndexes',
  requirements: { lattice2d: true },  // 2-axis packed neighborIndex codec — 2D only
  label: 'Get All Neighbor Indexes',
  description: 'Returns the full NeighborIndex array of a neighborhood — every slot as a packed (dr, dc). Bootstrap for filterNeighbors / forEachInArray chains without needing tags.',
  category: 'data',
  color: '#b71c1c',
  ports: [
    { id: 'indexes', label: 'Indexes', kind: 'output', category: 'value', dataType: 'neighborIndex', isArray: true },
  ],
  defaultConfig: { neighborhoodId: '' },
  compile: (nodeId, config) => {
    const json = config._resolvedPackedAll as string | undefined;
    const packed: number[] = json ? JSON.parse(json) : [];
    return `const _v${nodeId} = [${packed.join(', ')}];\n`;
  },
};

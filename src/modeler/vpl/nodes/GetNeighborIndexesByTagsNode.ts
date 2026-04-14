import type { NodeTypeDef } from '../types';

export const GetNeighborIndexesByTagsNode: NodeTypeDef = {
  type: 'getNeighborIndexesByTags',
  label: 'Get Neighbor Indexes By Tags',
  description: 'Returns the neighborhood indices that match the given tag names.',
  category: 'data',
  color: '#b71c1c',
  ports: [
    { id: 'indexes', label: 'Indexes', kind: 'output', category: 'value', dataType: 'any', isArray: true },
  ],
  defaultConfig: { neighborhoodId: '', tagCount: 0 },
  compile: (nodeId, config) => {
    // _resolvedTagIndexes is set by the compiler pre-pass (JSON array of resolved indices)
    const indices: number[] = config._resolvedTagIndexes ? JSON.parse(config._resolvedTagIndexes as string) : [];
    return `const _v${nodeId} = [${indices.join(', ')}];\n`;
  },
};

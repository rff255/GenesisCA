import type { NodeTypeDef } from '../types';

export const NeighborIndexFromTagNode: NodeTypeDef = {
  type: 'neighborIndexFromTag',
  label: 'Neighbor Index (from Tag)',
  description: 'Builds a NeighborIndex pointing at the slot of the neighborhood tagged with the given name.',
  category: 'data',
  color: '#b71c1c',
  ports: [
    { id: 'value', label: 'Value', kind: 'output', category: 'value', dataType: 'neighborIndex' },
  ],
  defaultConfig: { neighborhoodId: '', tagName: '' },
  compile: (nodeId, config) => {
    // _resolvedSlot is set by the compiler pre-pass (lookup of tag in neighborhood.tags).
    const slot = config._resolvedSlot !== undefined ? Number(config._resolvedSlot) : -1;
    return `const _v${nodeId} = ${slot};\n`;
  },
};

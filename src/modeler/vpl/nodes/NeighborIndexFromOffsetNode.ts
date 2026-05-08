import type { NodeTypeDef } from '../types';

export const NeighborIndexFromOffsetNode: NodeTypeDef = {
  type: 'neighborIndexFromOffset',
  label: 'Neighbor Index (from Offset)',
  description: 'Builds a NeighborIndex pointing at the (dRow, dCol) slot of the chosen neighborhood. Returns -1 if that offset is not in the neighborhood.',
  category: 'data',
  color: '#b71c1c',
  ports: [
    { id: 'value', label: 'Value', kind: 'output', category: 'value', dataType: 'neighborIndex' },
  ],
  defaultConfig: { neighborhoodId: '', dr: 0, dc: 0 },
  compile: (nodeId, config) => {
    // _resolvedSlot is set by the compiler pre-pass (lookup of (dr, dc) in neighborhood.coords).
    const slot = config._resolvedSlot !== undefined ? Number(config._resolvedSlot) : -1;
    return `const _v${nodeId} = ${slot};\n`;
  },
};

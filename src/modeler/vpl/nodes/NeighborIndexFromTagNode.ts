import type { NodeTypeDef } from '../types';

/** Wave A.6: tag → packed (dr, dc) is resolved at compile time using the
 *  configured neighborhood's coords + tags. Emits a literal i32. */
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
    // _resolvedPacked is set by the compiler pre-pass (lookup of tag in
    // neighborhood.tags → coord at that slot → pack(dr, dc)).
    const packed = config._resolvedPacked !== undefined
      ? Number(config._resolvedPacked) | 0
      : 0x80000000 | 0; // INVALID_NI
    return `const _v${nodeId} = ${packed};\n`;
  },
};

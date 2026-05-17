import type { NodeTypeDef } from '../types';

/** Read a neighbor's orientation given a neighborhood reference + slot index
 *  (0..nbrSize-1). Reads from `r_orientation` (the read buffer). Out-of-grid
 *  neighbors return the sentinel value (0). */
export const GetNeighborOrientationNode: NodeTypeDef = {
  type: 'getNeighborOrientation',
  label: 'Get Neighbor Orientation',
  description: "Reads a specific neighbor's orientation. The Index input is a slot position (0..nbrSize-1) in the selected neighborhood.",
  category: 'data',
  color: '#1976d2',
  requirements: { variegated: true },
  ports: [
    { id: 'index', label: 'Index', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '0' },
    { id: 'value', label: 'Orientation', kind: 'output', category: 'value', dataType: 'integer' },
  ],
  defaultConfig: { neighborhoodId: '' },
  compile: (nodeId, config, inputs) => {
    const nbrId = (config.neighborhoodId as string) || '_undef';
    const index = inputs['index'] || '0';
    return [
      `const _ni${nodeId} = nIdx_${nbrId}[idx * nSz_${nbrId} + ((${index}) | 0)] | 0;`,
      `const _v${nodeId} = r_orientation[_ni${nodeId}] | 0;`,
    ].join(' ') + '\n';
  },
};

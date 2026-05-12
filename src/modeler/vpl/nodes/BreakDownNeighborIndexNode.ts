import type { NodeTypeDef } from '../types';

/** Wave A.6: inverse of NeighborIndexFromOffset — unpacks a packed (dr, dc) i32
 *  NI value into its two integer offset components. Useful when computed NIs
 *  (e.g. from pickRandomNeighbor) need to be decomposed for separate per-axis
 *  logic (independent dRow / dCol arithmetic, dispatching on direction, etc.). */
export const BreakDownNeighborIndexNode: NodeTypeDef = {
  type: 'breakDownNeighborIndex',
  label: 'Break Down Neighbor Index',
  description: 'Unpacks a NeighborIndex into its (dRow, dCol) offset components.',
  category: 'data',
  color: '#b71c1c',
  ports: [
    { id: 'index', label: 'Index', kind: 'input', category: 'value', dataType: 'neighborIndex' },
    { id: 'dr', label: 'dr', kind: 'output', category: 'value', dataType: 'integer' },
    { id: 'dc', label: 'dc', kind: 'output', category: 'value', dataType: 'integer' },
  ],
  defaultConfig: {},
  compile: (nodeId, _config, inputs) => {
    const idx = inputs['index'] || '0';
    return [
      `const _bni${nodeId} = (${idx}) | 0;`,
      `const _v${nodeId}_dr = (_bni${nodeId} >> 16);`,
      `const _v${nodeId}_dc = ((_bni${nodeId} << 16) >> 16);`,
    ].join(' ') + '\n';
  },
};

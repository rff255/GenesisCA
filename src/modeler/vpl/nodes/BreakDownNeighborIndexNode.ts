import type { NodeTypeDef } from '../types';
import { niDrExpr, niDcExpr, niDlExpr, is3dModelLike } from '../compiler/niCodec';

/** Inverse of NeighborIndexFromOffset — unpacks a NeighborIndex into its integer
 *  offset components. 2D = (dr, dc); 3D adds dl (the layer offset). Useful when a
 *  computed NI (e.g. from pickRandomNeighbor) needs per-axis logic. */
export const BreakDownNeighborIndexNode: NodeTypeDef = {
  type: 'breakDownNeighborIndex',
  label: 'Break Down Neighbor Index',
  description: 'Unpacks a NeighborIndex into its (dRow, dCol[, dLayer]) offset components. The dl output appears in 3D models.',
  category: 'data',
  color: '#b71c1c',
  ports: [
    { id: 'index', label: 'Index', kind: 'input', category: 'value', dataType: 'neighborIndex' },
    { id: 'dr', label: 'dr', kind: 'output', category: 'value', dataType: 'integer' },
    { id: 'dc', label: 'dc', kind: 'output', category: 'value', dataType: 'integer' },
    { id: 'dl', label: 'dl', kind: 'output', category: 'value', dataType: 'integer' },
  ],
  hiddenPorts: (_config, model) => (is3dModelLike(model) ? [] : ['dl']),
  defaultConfig: {},
  compile: (nodeId, _config, inputs, _boundary, ctx) => {
    const idx = inputs['index'] || '0';
    const v = `_bni${nodeId}`;
    const lines = [
      `const ${v} = (${idx}) | 0;`,
      `const _v${nodeId}_dr = ${niDrExpr(v, ctx?.is3d)};`,
      `const _v${nodeId}_dc = ${niDcExpr(v, ctx?.is3d)};`,
    ];
    if (ctx?.is3d) lines.push(`const _v${nodeId}_dl = ${niDlExpr(v)};`);
    return lines.join(' ') + '\n';
  },
};

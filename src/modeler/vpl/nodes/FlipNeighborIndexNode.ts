import type { NodeTypeDef } from '../types';
import { niDrExpr, niDcExpr, niDlExpr, niPackExpr } from '../compiler/niCodec';

/** NIs are packed offsets. Flipping is pure bit math — decode the offsets,
 *  conditionally negate, re-encode. In 3D the layer offset (dl) passes through
 *  unchanged (the flips are in the XY plane). No neighborhood needed. */
export const FlipNeighborIndexNode: NodeTypeDef = {
  type: 'flipNeighborIndex',
  label: 'Flip Neighbor Index',
  description: 'Mirrors a NeighborIndex horizontally (negates dCol), vertically (negates dRow), or both (180° rotation). In 3D the layer offset is preserved.',
  category: 'data',
  color: '#b71c1c',
  ports: [
    { id: 'index', label: 'Index', kind: 'input', category: 'value', dataType: 'neighborIndex' },
    { id: 'value', label: 'Value', kind: 'output', category: 'value', dataType: 'neighborIndex' },
  ],
  defaultConfig: { mode: 'horizontal' },
  compile: (nodeId, config, inputs, _boundary, ctx) => {
    const idx = inputs['index'] || '0';
    const mode = (config.mode as string) || 'horizontal';
    const flipDr = mode === 'vertical' || mode === 'both';
    const flipDc = mode === 'horizontal' || mode === 'both';
    const v = `_fIn${nodeId}`;
    const is3d = !!ctx?.is3d;
    const drExpr = flipDr ? `(-(${niDrExpr(v, is3d)}))` : niDrExpr(v, is3d);
    const dcExpr = flipDc ? `(-(${niDcExpr(v, is3d)}))` : niDcExpr(v, is3d);
    return [
      `const ${v} = (${idx}) | 0;`,
      `const _v${nodeId} = ${niPackExpr(drExpr, dcExpr, is3d, is3d ? niDlExpr(v) : '0')};`,
    ].join(' ') + '\n';
  },
};

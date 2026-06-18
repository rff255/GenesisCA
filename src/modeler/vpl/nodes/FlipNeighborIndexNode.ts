import type { NodeTypeDef } from '../types';

/** Wave A.6: NIs are packed (dr, dc) i32. Flipping is pure bit math —
 *  decode dr/dc, conditionally negate, re-encode. No neighborhood needed. */
export const FlipNeighborIndexNode: NodeTypeDef = {
  type: 'flipNeighborIndex',
  requirements: { lattice2d: true },  // 2-axis packed neighborIndex codec — 2D only
  label: 'Flip Neighbor Index',
  description: 'Mirrors a NeighborIndex horizontally (negates dCol), vertically (negates dRow), or both (180° rotation).',
  category: 'data',
  color: '#b71c1c',
  ports: [
    { id: 'index', label: 'Index', kind: 'input', category: 'value', dataType: 'neighborIndex' },
    { id: 'value', label: 'Value', kind: 'output', category: 'value', dataType: 'neighborIndex' },
  ],
  defaultConfig: { mode: 'horizontal' },
  compile: (nodeId, config, inputs) => {
    const idx = inputs['index'] || '0';
    const mode = (config.mode as string) || 'horizontal';
    const flipDr = mode === 'vertical' || mode === 'both';
    const flipDc = mode === 'horizontal' || mode === 'both';
    const drExpr = flipDr ? `(-(_fIn${nodeId} >> 16))` : `(_fIn${nodeId} >> 16)`;
    const dcExpr = flipDc ? `(-((_fIn${nodeId} << 16) >> 16))` : `((_fIn${nodeId} << 16) >> 16)`;
    return [
      `const _fIn${nodeId} = (${idx}) | 0;`,
      `const _v${nodeId} = (((((${drExpr}) & 0xFFFF) << 16) | ((${dcExpr}) & 0xFFFF)) | 0);`,
    ].join(' ') + '\n';
  },
};

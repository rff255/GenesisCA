import type { NodeTypeDef } from '../types';

/** Wave A.6: NIs are packed (dr, dc) i32, no neighborhood association.
 *
 *  This node takes dr/dc as input ports (with inline number widgets) and
 *  emits the packed NI value at runtime. Useful both as a constant constructor
 *  (typing dr/dc inline) and as a dynamic constructor (wiring computed
 *  offsets, e.g. from model attributes encoding direction). */
export const NeighborIndexFromOffsetNode: NodeTypeDef = {
  type: 'neighborIndexFromOffset',
  requirements: { lattice2d: true },  // 2-axis packed neighborIndex codec — 2D only
  label: 'Neighbor Index (from Offset)',
  description: 'Builds a NeighborIndex from a (dRow, dCol) offset pair. dr and dc can be wired or set via inline number widgets.',
  category: 'data',
  color: '#b71c1c',
  ports: [
    { id: 'dr', label: 'dr', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '0' },
    { id: 'dc', label: 'dc', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '0' },
    { id: 'value', label: 'Value', kind: 'output', category: 'value', dataType: 'neighborIndex' },
  ],
  defaultConfig: {},
  compile: (nodeId, _config, inputs) => {
    const dr = inputs['dr'] || '0';
    const dc = inputs['dc'] || '0';
    return `const _v${nodeId} = (((((${dr}) & 0xFFFF) << 16) | ((${dc}) & 0xFFFF)) | 0);\n`;
  },
};

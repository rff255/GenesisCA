import type { NodeTypeDef } from '../types';
import { niPackExpr, is3dModelLike } from '../compiler/niCodec';

/** NIs are packed offsets from the centre cell. 2D = (dr, dc); 3D adds dl
 *  (layer offset). dr/dc/dl are input ports (with inline number widgets), so the
 *  node serves both as a constant constructor (typing offsets inline) and a
 *  dynamic one (wiring computed offsets, e.g. from a model attribute). */
export const NeighborIndexFromOffsetNode: NodeTypeDef = {
  type: 'neighborIndexFromOffset',
  label: 'Neighbor Index (from Offset)',
  description: 'Builds a NeighborIndex from a (dRow, dCol[, dLayer]) offset from the centre cell. Offsets can be wired or set via inline number widgets. The dLayer port appears in 3D models.',
  category: 'data',
  color: '#b71c1c',
  ports: [
    { id: 'dr', label: 'dr', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '0' },
    { id: 'dc', label: 'dc', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '0' },
    { id: 'dl', label: 'dl', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '0' },
    { id: 'value', label: 'Value', kind: 'output', category: 'value', dataType: 'neighborIndex' },
  ],
  // The layer offset only exists in 3D models.
  hiddenPorts: (_config, model) => (is3dModelLike(model) ? [] : ['dl']),
  defaultConfig: {},
  compile: (nodeId, _config, inputs, _boundary, ctx) => {
    const dr = inputs['dr'] || '0';
    const dc = inputs['dc'] || '0';
    const dl = inputs['dl'] || '0';
    return `const _v${nodeId} = ${niPackExpr(dr, dc, ctx?.is3d, dl)};\n`;
  },
};

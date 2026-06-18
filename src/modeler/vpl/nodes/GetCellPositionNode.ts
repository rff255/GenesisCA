import type { NodeTypeDef } from '../types';

/** Get Cell Position — outputs the CURRENT cell's grid coordinates: `row`, `col`,
 *  and (3D only) `layer`. A controlled, limited break of the locality rule: a
 *  cell can't read its NEIGHBOURS' positions, only its OWN, so it can behave
 *  differently depending on WHERE it sits in the grid (e.g. a spatial gradient,
 *  region-specific rules, or a coordinate-aware Output Mapping).
 *
 *  Works in every event (Step / Init / Input Mapping / Output Mapping) — the
 *  compiler already decodes the per-cell `_row` / `_col` / `_layer` at the top of
 *  each per-cell loop, so this node just exposes them as value outputs. The
 *  coordinates are 0-based.
 *
 *  Multi-output: each port resolves via the `_v<id>_<portId>` convention
 *  (registered in `MULTI_OUTPUT_TYPES`). `layer` only exists in 3D models (hidden
 *  via `hiddenPorts` in 2D, where the compiler emits no `_layer`). */
export const GetCellPositionNode: NodeTypeDef = {
  type: 'getCellPosition',
  label: 'Get Cell Position',
  description: "Outputs the current cell's grid coordinates (row, col, and layer in 3D), so a cell can behave differently depending on where it is — e.g. spatial gradients or coordinate-aware Output Mappings.",
  category: 'data',
  color: '#1565c0',
  ports: [
    { id: 'row', label: 'Row', kind: 'output', category: 'value', dataType: 'integer' },
    { id: 'col', label: 'Col', kind: 'output', category: 'value', dataType: 'integer' },
    { id: 'layer', label: 'Layer', kind: 'output', category: 'value', dataType: 'integer' },
  ],
  // The layer coordinate only exists in a 3D model (the compiler emits no
  // `_layer` decode in 2D, so a wired port would be undefined).
  hiddenPorts: (_config, model) =>
    (model?.properties?.dimension === '3d' && (model?.properties?.gridDepth ?? 1) > 1)
      ? []
      : ['layer'],
  defaultConfig: {},
  compile: (nodeId, _config, _inputs, _boundary, ctx) => {
    // The per-cell `_row` / `_col` (+ `_layer` in 3D) locals are decoded at the
    // top of every per-cell loop by the compiler — just alias them.
    const lines = [`const _v${nodeId}_row = _row;`, `const _v${nodeId}_col = _col;`];
    if (ctx?.is3d) lines.push(`const _v${nodeId}_layer = _layer;`);
    return lines.join(' ') + '\n';
  },
};

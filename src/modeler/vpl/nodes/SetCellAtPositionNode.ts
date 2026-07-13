import type { NodeTypeDef } from '../types';
import { is3dModelLike } from '../compiler/niCodec';

/** Set Cell (at Position) — write a value to a cell attribute at an ABSOLUTE grid
 *  position. The write primitive of the Grid Init Event: wire X / Y (and Z in 3D)
 *  + a Value, pick the cell attribute, and it writes that cell (bounds-checked —
 *  out-of-range positions are skipped). Coordinates truncate to integers.
 *
 *  Intended for the Grid Init Event (a global, once-only context). It breaks the
 *  CA locality fundamental (writes an ARBITRARY cell, not the current one), so it
 *  does NOT belong in a per-cell Step / Init Event / mapping — there, use Set
 *  Attribute (which writes the current cell).
 *
 *  Emitted on the JS target only: the Grid Init Event runs as a JS function in the
 *  worker on EVERY compile target, so no WASM/WebGPU emit is needed. */
export const SetCellAtPositionNode: NodeTypeDef = {
  type: 'setCellAtPosition',
  label: 'Set Cell (at Position)',
  description: 'Writes a value to a cell attribute at an absolute grid position (X, Y[, Z]). For the Grid Init Event — out-of-range positions are skipped.',
  category: 'output',
  color: '#5e35b1',
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'next', label: 'NEXT', kind: 'output', category: 'flow' },
    { id: 'x', label: 'X', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '0' },
    { id: 'y', label: 'Y', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '0' },
    { id: 'z', label: 'Z', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '0' },
    { id: 'value', label: 'Value', kind: 'input', category: 'value', dataType: 'any', inlineWidget: 'number', defaultValue: '0' },
  ],
  // Z exists only in a 3D grid (hidden in 2D — the index formula drops the layer).
  hiddenPorts: (_config, model) => (is3dModelLike(model) ? [] : ['z']),
  defaultConfig: { attributeId: '' },
  compile: (nodeId, config, inputs, _boundary, ctx) => {
    void nodeId;
    const attr = (config.attributeId as string) || '_undef';
    const x = inputs['x'] || '0';
    const y = inputs['y'] || '0';
    const z = inputs['z'] || '0';
    const value = inputs['value'] || '0';
    const is3d = ctx?.is3d ?? false;
    // Evaluate each coordinate ONCE into an int local — a wired source may be a
    // getRandom-derived expression, so double-evaluation would advance the RNG
    // twice / recompute. Bounds-check against the grid, then write w_<attr>[idx].
    if (is3d) {
      return (
        `{ const _cx = (${x}) | 0, _cy = (${y}) | 0, _cz = (${z}) | 0;\n` +
        `  if (_cx >= 0 && _cx < W && _cy >= 0 && _cy < H && _cz >= 0 && _cz < D)\n` +
        `    w_${attr}[_cz * W * H + _cy * W + _cx] = ${value}; }\n`
      );
    }
    return (
      `{ const _cx = (${x}) | 0, _cy = (${y}) | 0;\n` +
      `  if (_cx >= 0 && _cx < W && _cy >= 0 && _cy < H)\n` +
      `    w_${attr}[_cy * W + _cx] = ${value}; }\n`
    );
  },
};

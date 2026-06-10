import type { NodeTypeDef } from '../types';
import { niCellExprStmts, INVALID_NI } from '../compiler/niCodec';

/** Write a value to one neighbour's orientation at a packed NeighborIndex.
 *  Mirrors `SetNeighborAttributeByIndex` — no neighborhood config, the NI
 *  carries the (dr, dc) offset inline. Accepts an array of NIs to write to
 *  multiple neighbours. Async-only. */
export const SetNeighborOrientationByIndexNode: NodeTypeDef = {
  type: 'setNeighborOrientationByIndex',
  label: 'Set Neighbor Orientation By Index',
  description: "Writes a value to one neighbour's orientation at the given NeighborIndex (packed dr/dc). Accepts an array of indices to write to multiple neighbours. Async-only; wraps the value via &amp; 3.",
  category: 'output',
  color: '#1976d2',
  requirements: { async: true, variegated: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'next', label: 'NEXT', kind: 'output', category: 'flow' },
    { id: 'index', label: 'Index', kind: 'input', category: 'value', dataType: 'neighborIndex' },
    { id: 'value', label: 'Value', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '0' },
  ],
  defaultConfig: {},
  compile: (nodeId, _config, inputs, boundary) => {
    const index = inputs['index'] || '0';
    const value = inputs['value'] || '0';
    const b = boundary || 'torus';
    const arrAccess = niCellExprStmts(`_eli${nodeId}`, b, `${nodeId}_a`);
    const sclAccess = niCellExprStmts(`_idx${nodeId}`, b, `${nodeId}_s`);
    return [
      `const _idx${nodeId} = (${index}) | 0;`,
      `if (Array.isArray(${index})) {`,
      `  for (let _ai${nodeId} = 0; _ai${nodeId} < (${index}).length; _ai${nodeId}++) {`,
      `    const _eli${nodeId} = ((${index})[_ai${nodeId}]) | 0;`,
      `    if (_eli${nodeId} !== ${INVALID_NI}) {`,
      `      ${arrAccess.stmts}`,
      `      if (${arrAccess.cellExpr} < total) w_orientation[${arrAccess.cellExpr}] = (${value}) & 3;`,
      `    }`,
      `  }`,
      `} else if (_idx${nodeId} !== ${INVALID_NI}) {`,
      `  ${sclAccess.stmts}`,
      `  if (${sclAccess.cellExpr} < total) w_orientation[${sclAccess.cellExpr}] = (${value}) & 3;`,
      `}`,
    ].join(' ') + '\n';
  },
};

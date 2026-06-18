import type { NodeTypeDef } from '../types';
import { niCellExprStmts } from '../compiler/niCodec';

/** Wave A.6: writes a value to one neighbor's attribute at a packed NI offset.
 *  Async-only. */
export const SetNeighborAttributeByIndexNode: NodeTypeDef = {
  type: 'setNeighborAttributeByIndex',
  label: 'Set Neighbor Attr By Index',
  description: 'Writes a value to one neighbor’s attribute at the given NeighborIndex (a packed dr/dc offset). Accepts an array of indices to write to multiple neighbors. Async-only.',
  category: 'output',
  color: '#4a148c',
  requirements: { async: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'next', label: 'NEXT', kind: 'output', category: 'flow' },
    { id: 'index', label: 'Index', kind: 'input', category: 'value', dataType: 'neighborIndex' },
    { id: 'value', label: 'Value', kind: 'input', category: 'value', dataType: 'any', inlineWidget: 'number', defaultValue: '0' },
  ],
  defaultConfig: { attributeId: '' },
  compile: (nodeId, config, inputs, boundary, ctx) => {
    const attr = config.attributeId as string || '_undef';
    const index = inputs['index'] || '0';
    const value = inputs['value'] || '0';
    const b = boundary || 'torus';
    const arrAccess = niCellExprStmts(`_eli${nodeId}`, b, `${nodeId}_a`, ctx?.is3d);
    const sclAccess = niCellExprStmts(`_idx${nodeId}`, b, `${nodeId}_s`, ctx?.is3d);
    return [
      `const _idx${nodeId} = (${index}) | 0;`,
      `if (Array.isArray(${index})) {`,
      `  for (let _ai${nodeId} = 0; _ai${nodeId} < (${index}).length; _ai${nodeId}++) {`,
      `    const _eli${nodeId} = ((${index})[_ai${nodeId}]) | 0;`,
      `    if (_eli${nodeId} !== ${0x80000000 | 0}) {`,
      `      ${arrAccess.stmts}`,
      `      if (${arrAccess.cellExpr} < total) w_${attr}[${arrAccess.cellExpr}] = ${value};`,
      `    }`,
      `  }`,
      `} else if (_idx${nodeId} !== ${0x80000000 | 0}) {`,
      `  ${sclAccess.stmts}`,
      `  if (${sclAccess.cellExpr} < total) w_${attr}[${sclAccess.cellExpr}] = ${value};`,
      `}`,
    ].join(' ') + '\n';
  },
};

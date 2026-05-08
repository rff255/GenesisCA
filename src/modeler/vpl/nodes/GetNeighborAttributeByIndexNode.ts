import type { NodeTypeDef } from '../types';
import { niCellExprStmts } from '../compiler/niCodec';

/** Wave A.6: reads one neighbor's attribute given a packed NI. No neighborhood
 *  config — the NI carries the offset inline. If given an array, takes element 0. */
export const GetNeighborAttributeByIndexNode: NodeTypeDef = {
  type: 'getNeighborAttributeByIndex',
  label: 'Get Neighbor Attr By Index',
  description: 'Reads one neighbor’s attribute given a NeighborIndex (a packed dr/dc offset). If given an array of indices, reads the first one.',
  category: 'data',
  color: '#b71c1c',
  ports: [
    { id: 'index', label: 'Index', kind: 'input', category: 'value', dataType: 'neighborIndex' },
    { id: 'value', label: 'Value', kind: 'output', category: 'value', dataType: 'any' },
  ],
  defaultConfig: { attributeId: '' },
  compile: (nodeId, config, inputs, boundary) => {
    const attr = config.attributeId as string || '_undef';
    const index = inputs['index'] || '0';
    const niExpr = `_ni${nodeId}`;
    const { stmts, cellExpr } = niCellExprStmts(niExpr, boundary || 'torus', `${nodeId}`);
    // Accept either a scalar or an array (taking element 0).
    return [
      `const _idx${nodeId} = ${index};`,
      `const ${niExpr} = (Array.isArray(_idx${nodeId}) ? (_idx${nodeId}[0] ?? 0) : _idx${nodeId}) | 0;`,
      stmts,
      `const _v${nodeId} = r_${attr}[${cellExpr}];`,
    ].join(' ') + '\n';
  },
};

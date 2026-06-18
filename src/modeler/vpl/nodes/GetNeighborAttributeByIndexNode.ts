import type { NodeTypeDef } from '../types';
import { niCellExprStmts, INVALID_NI } from '../compiler/niCodec';

/** Wave A.6: reads one neighbor's attribute given a packed NI. No neighborhood
 *  config — the NI carries the offset inline. If given an array, takes element 0.
 *
 *  Guards against `INVALID_NI` (the "no neighbor" sentinel that
 *  `pickRandomNeighbor` returns on empty input and `arrayElement` returns on
 *  out-of-range): if the input is INVALID_NI (or an empty array), the result
 *  is `0` (or `0.0` / `false` for non-integer attrs — JS coerces 0 naturally).
 *  Symmetric with `setNeighborAttributeByIndex` which guards the same way. */
export const GetNeighborAttributeByIndexNode: NodeTypeDef = {
  type: 'getNeighborAttributeByIndex',
  label: 'Get Neighbor Attr By Index',
  description: 'Reads one neighbor’s attribute given a NeighborIndex (a packed dr/dc offset). If given an array of indices, reads the first one. Returns 0 when the index is the INVALID_NI sentinel.',
  category: 'data',
  color: '#b71c1c',
  ports: [
    { id: 'index', label: 'Index', kind: 'input', category: 'value', dataType: 'neighborIndex' },
    { id: 'value', label: 'Value', kind: 'output', category: 'value', dataType: 'any' },
  ],
  defaultConfig: { attributeId: '' },
  compile: (nodeId, config, inputs, boundary, ctx) => {
    const attr = config.attributeId as string || '_undef';
    const index = inputs['index'] || '0';
    const niExpr = `_ni${nodeId}`;
    const { stmts, cellExpr } = niCellExprStmts(niExpr, boundary || 'torus', `${nodeId}`, ctx?.is3d);
    // Accept either a scalar or an array (taking element 0). Empty array →
    // INVALID_NI, which the guard below maps to a 0 fallback. Wrap the access
    // in an IIFE so we can keep `_v${nodeId}` as a const at the call-site
    // scope without leaking the niCellExpr locals (each iteration of an outer
    // for/loop would otherwise re-declare the same names).
    // For sub-attributes, the read uses ctx.readAttrExpr to apply the parent-check
    // guard at the resolved neighbor cell index (the neighbor's parent, not idx's).
    const readExpr = ctx ? ctx.readAttrExpr(attr, cellExpr) : `r_${attr}[${cellExpr}]`;
    return `const _v${nodeId} = (() => {`
      + ` const _idx${nodeId} = ${index};`
      + ` const ${niExpr} = (Array.isArray(_idx${nodeId}) ? (_idx${nodeId}.length > 0 ? (_idx${nodeId}[0] | 0) : ${INVALID_NI}) : (_idx${nodeId} | 0));`
      + ` if (${niExpr} === ${INVALID_NI}) return 0;`
      + ` ${stmts}`
      + ` return ${readExpr};`
      + ` })();\n`;
  },
};

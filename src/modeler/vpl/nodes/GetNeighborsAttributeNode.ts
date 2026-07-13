import type { NodeTypeDef } from '../types';
import { niCellExprStmts } from '../compiler/niCodec';

export const GetNeighborsAttributeNode: NodeTypeDef = {
  type: 'getNeighborsAttribute',
  label: 'Get Neighbors Attribute',
  description: 'Reads one attribute from every neighbor in a neighborhood, as an array.',
  category: 'data',
  color: '#b71c1c',
  ports: [
    { id: 'values', label: 'Values', kind: 'output', category: 'value', dataType: 'any', isArray: true },
  ],
  defaultConfig: { neighborhoodId: '', attributeId: '' },
  compile: (nodeId, config, _inputs, boundary, ctx) => {
    const nbrId = config.neighborhoodId as string || '_undef';
    const attr = config.attributeId as string || '_undef';
    // For sub-attributes, ctx.parentMatchesExpr (queried with local `_ni`)
    // gives the iteration-skip predicate. The scratch fills variable-length
    // via filter-with-push, excluding neighbors whose parent doesn't match.
    // Regular attrs use fixed-index assignment for SIMD-friendly access.
    // _scr_<nodeId> is pre-declared (plain Array for sub-attrs, typed for regular).
    const guard = ctx ? ctx.parentMatchesExpr(attr, '_ni') : null;
    // "Skip Isolated Empty Cells" (inline-neighbour mode): nIdx_<nbr> carries
    // PACKED per-slot offsets (length nSz — the compact table), not per-cell
    // indices. Decode each slot's offset inline via the NI codec (same
    // torus-wrap / constant-sentinel semantics the big table baked in).
    if (ctx?.inlineNbr) {
      const b = boundary === 'torus' ? 'torus' : 'constant';
      const d = niCellExprStmts(`nIdx_${nbrId}[_n]`, b, nodeId, ctx.is3d ?? false);
      if (guard) {
        return [
          `_scr_${nodeId}.length = 0;`,
          `for (let _n = 0; _n < nSz_${nbrId}; _n++) { ${d.stmts} const _ni = ${d.cellExpr}; if (${guard}) _scr_${nodeId}.push(r_${attr}[_ni]); }`,
        ].join(' ') + '\n';
      }
      return `for (let _n = 0; _n < nSz_${nbrId}; _n++) { ${d.stmts} _scr_${nodeId}[_n] = r_${attr}[${d.cellExpr}]; }\n`;
    }
    if (guard) {
      return [
        `const _nb${nodeId} = idx * nSz_${nbrId};`,
        `_scr_${nodeId}.length = 0;`,
        `for (let _n = 0; _n < nSz_${nbrId}; _n++) { const _ni = nIdx_${nbrId}[_nb${nodeId} + _n]; if (${guard}) _scr_${nodeId}.push(r_${attr}[_ni]); }`,
      ].join(' ') + '\n';
    }
    return [
      `const _nb${nodeId} = idx * nSz_${nbrId};`,
      `for (let _n = 0; _n < nSz_${nbrId}; _n++) _scr_${nodeId}[_n] = r_${attr}[nIdx_${nbrId}[_nb${nodeId} + _n]];`,
    ].join(' ') + '\n';
  },
};

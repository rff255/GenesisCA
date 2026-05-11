import type { NodeTypeDef } from '../types';

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
  compile: (nodeId, config, _inputs, _boundary, ctx) => {
    const nbrId = config.neighborhoodId as string || '_undef';
    const attr = config.attributeId as string || '_undef';
    // For sub-attributes, ctx.parentMatchesExpr (queried with local `_ni`)
    // gives the iteration-skip predicate. The scratch fills variable-length
    // via filter-with-push, excluding neighbors whose parent doesn't match.
    // Regular attrs use fixed-index assignment for SIMD-friendly access.
    // _scr_<nodeId> is pre-declared (plain Array for sub-attrs, typed for regular).
    const guard = ctx ? ctx.parentMatchesExpr(attr, '_ni') : null;
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

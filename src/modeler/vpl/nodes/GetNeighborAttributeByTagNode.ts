import type { NodeTypeDef } from '../types';
import { niCellExprStmts } from '../compiler/niCodec';

export const GetNeighborAttributeByTagNode: NodeTypeDef = {
  type: 'getNeighborAttributeByTag',
  label: 'Get Neighbor Attr By Tag',
  description: 'Reads a neighbor\u2019s attribute by a named tag defined on the neighborhood.',
  category: 'data',
  color: '#b71c1c',
  ports: [
    { id: 'value', label: 'Value', kind: 'output', category: 'value', dataType: 'any' },
  ],
  defaultConfig: { neighborhoodId: '', attributeId: '', tagName: '' },
  compile: (nodeId, config, _inputs, boundary, ctx) => {
    const nbrId = config.neighborhoodId as string || '_undef';
    const attr = config.attributeId as string || '_undef';
    // _resolvedTagIndex is set by the compiler pre-pass
    const tagIndex = (config._resolvedTagIndex as number) ?? 0;
    // "Skip Isolated Empty Cells" (inline-neighbour mode): nIdx_<nbr> carries
    // PACKED per-slot offsets \u2014 decode slot `tagIndex`'s offset inline.
    if (ctx?.inlineNbr) {
      const b = boundary === 'torus' ? 'torus' : 'constant';
      const d = niCellExprStmts(`nIdx_${nbrId}[${tagIndex}]`, b, nodeId, ctx.is3d ?? false);
      const readExpr = ctx.readAttrExpr(attr, d.cellExpr);
      return `${d.stmts}\nconst _v${nodeId} = ${readExpr};\n`;
    }
    const cellExpr = `nIdx_${nbrId}[idx * nSz_${nbrId} + ${tagIndex}]`;
    // Sub-attribute reads use ctx.readAttrExpr to apply the parent-check guard
    // at the neighbor's cell index. Regular attrs pass through unchanged.
    const readExpr = ctx ? ctx.readAttrExpr(attr, cellExpr) : `r_${attr}[${cellExpr}]`;
    return `const _v${nodeId} = ${readExpr};\n`;
  },
};

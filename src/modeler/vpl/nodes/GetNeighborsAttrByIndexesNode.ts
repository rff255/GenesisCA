import type { NodeTypeDef } from '../types';
import { niCellExprStmts } from '../compiler/niCodec';

/** Wave A.6: reads neighbor attribute values for a list of packed NIs. No
 *  neighborhood config — each NI carries its own offset. */
export const GetNeighborsAttrByIndexesNode: NodeTypeDef = {
  type: 'getNeighborsAttrByIndexes',
  label: 'Get Neighbors Attr By Indexes',
  description: 'Reads neighbor attribute values for a provided list of NeighborIndexes (each a packed dr/dc offset).',
  category: 'data',
  color: '#b71c1c',
  ports: [
    { id: 'indexes', label: 'Indexes', kind: 'input', category: 'value', dataType: 'neighborIndex', isArray: true },
    { id: 'values', label: 'Values', kind: 'output', category: 'value', dataType: 'any', isArray: true },
  ],
  defaultConfig: { attributeId: '' },
  compile: (nodeId, config, inputs, boundary) => {
    const attr = config.attributeId as string || '_undef';
    const indexes = inputs['indexes'] || '[]';
    const ni = `_ni${nodeId}`;
    const niVar = `_niv${nodeId}`;
    const vl = `_v${nodeId}_valsLen`;
    const { stmts, cellExpr } = niCellExprStmts(niVar, boundary || 'torus', `${nodeId}_e`);
    return [
      `_v${nodeId}_vals.length = 0; let ${vl} = 0;`,
      `for (let ${ni} = 0; ${ni} < ${indexes}.length; ${ni}++) {`,
      `  const ${niVar} = (${indexes}[${ni}]) | 0;`,
      `  ${stmts}`,
      `  _v${nodeId}_vals[${vl}++] = r_${attr}[${cellExpr}];`,
      `}`,
    ].join(' ') + '\n';
  },
};

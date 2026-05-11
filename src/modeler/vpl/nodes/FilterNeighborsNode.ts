import type { NodeTypeDef } from '../types';
import { niCellExprStmts } from '../compiler/niCodec';

/** Wave A.6: filters an NI[] by an attribute comparison at each referenced
 *  cell. The NIs are packed (dr, dc), so no neighborhood config is needed —
 *  the inline access path uses each NI's own offset. The Indexes input is
 *  required (the implicit-all default of Wave A.5 is gone; bootstrap with
 *  getAllNeighborIndexes(N) instead).
 *
 *  Multi-output: `result` is the kept-NI array; `count` is its final length
 *  exposed as a scalar so downstream graphs don't need a separate
 *  `arrayLength` node when they care about "how many neighbors matched". */
export const FilterNeighborsNode: NodeTypeDef = {
  type: 'filterNeighbors',
  label: 'Filter Neighbors',
  description: 'Keeps NeighborIndices whose attribute passes the comparison. Outputs both the filtered NI array and its element count. Requires an Indexes input (e.g., from Get All Neighbor Indexes).',
  category: 'aggregation',
  color: '#e65100',
  ports: [
    { id: 'indexes', label: 'Indexes', kind: 'input', category: 'value', dataType: 'neighborIndex', isArray: true },
    { id: 'compare', label: 'Compare', kind: 'input', category: 'value', dataType: 'any', inlineWidget: 'number', defaultValue: '0' },
    { id: 'result', label: 'Filtered', kind: 'output', category: 'value', dataType: 'neighborIndex', isArray: true },
    { id: 'count', label: 'Count', kind: 'output', category: 'value', dataType: 'integer' },
  ],
  defaultConfig: { attributeId: '', operation: 'equals' },
  compile: (nodeId, config, inputs, boundary) => {
    const attr = config.attributeId as string || '_undef';
    const compare = inputs['compare'] || '0';
    const op = config.operation as string;
    const indexes = inputs['indexes'] || '[]';
    const fi = `_fi${nodeId}`;
    const ni = `_fni${nodeId}`;
    // Use the multi-output naming convention for the counter so consumers of
    // the `count` output port resolve via `_v<id>_count` automatically.
    const cnt = `_v${nodeId}_count`;
    const { stmts, cellExpr } = niCellExprStmts(ni, boundary || 'torus', `${nodeId}_e`);
    const elemExpr = `r_${attr}[${cellExpr}]`;
    let cond: string;
    switch (op) {
      case 'notEquals':    cond = `${elemExpr} !== ${compare}`; break;
      case 'greater':      cond = `${elemExpr} > ${compare}`; break;
      case 'lesser':       cond = `${elemExpr} < ${compare}`; break;
      case 'greaterEqual': cond = `${elemExpr} >= ${compare}`; break;
      case 'lesserEqual':  cond = `${elemExpr} <= ${compare}`; break;
      default:             cond = `${elemExpr} === ${compare}`; break; // equals
    }
    return [
      `_v${nodeId}_result.length = 0; let ${cnt} = 0;`,
      `for (let ${fi} = 0; ${fi} < ${indexes}.length; ${fi}++) {`,
      `  const ${ni} = (${indexes}[${fi}]) | 0;`,
      `  ${stmts}`,
      `  if (${cond}) _v${nodeId}_result[${cnt}++] = ${ni};`,
      `}`,
    ].join(' ') + '\n';
  },
};

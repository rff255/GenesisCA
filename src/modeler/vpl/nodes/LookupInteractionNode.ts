import type { NodeTypeDef } from '../types';

/** Index a Lookup Table model attribute by a row index and a column index.
 *
 *  Inputs: `labelA` (row index) + `labelB` (column index) — integer indices into
 *  the table's row/column key sources (each a face-label palette or a tag
 *  attribute). For face axes the indices typically come from `Get Facing Labels`;
 *  for tag axes from reading a cell's tag attribute. Output: the float at
 *  `tableValues[rowLabel][colLabel]` (0 when unset). Constant-time lookup via
 *  `_lookupTables[tableId][row * colCount + col]` where `colCount` (the column
 *  dimension = stride) is baked at compile time per table. Rectangular tables
 *  (row source ≠ col source) are fully supported. */
export const LookupInteractionNode: NodeTypeDef = {
  type: 'lookupInteraction',
  label: 'Table Lookup',
  description: 'Indexes a Lookup Table model attribute by a row index and a column index. Returns a decimal number.',
  category: 'logic',
  color: '#1976d2',
  ports: [
    { id: 'labelA', label: 'Row', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '0' },
    { id: 'labelB', label: 'Col', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '0' },
    { id: 'value', label: 'Value', kind: 'output', category: 'value', dataType: 'float' },
  ],
  defaultConfig: { tableId: '' },
  compile: (nodeId, config, inputs) => {
    const tableId = (config.tableId as string) || '';
    const labelA = inputs['labelA'] || '0';
    const labelB = inputs['labelB'] || '0';
    // Baked by compile.ts pre-resolve: colCount = the column key source's label
    // count (the row-major stride). When unset, fall back to 1 — the resulting
    // table degenerates and the runtime returns the (0,0) entry which is 0.
    const colCount = Number(config._colCount) || 1;
    if (!tableId) return `const _v${nodeId} = 0;\n`;
    return [
      `const _la${nodeId} = ((${labelA}) | 0);`,
      `const _lb${nodeId} = ((${labelB}) | 0);`,
      `const _tbl${nodeId} = _lookupTables[${JSON.stringify(tableId)}];`,
      `const _v${nodeId} = _tbl${nodeId} ? (_tbl${nodeId}[_la${nodeId} * ${colCount} + _lb${nodeId}] || 0) : 0;`,
    ].join(' ') + '\n';
  },
};

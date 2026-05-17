import type { NodeTypeDef } from '../types';

/** Look up an interaction-table model attribute by two face labels.
 *
 *  Inputs: labelA + labelB (face-label indices into `['none', ...faceLabels]`
 *  — typically wired from `GetFacingLabels` outputs). Output: the float at
 *  `tableValues[labelA][labelB]` (0 when unset). The lookup is constant-time
 *  via `_interactionTables[tableId][labelA * N + labelB]` where N is
 *  `(faceLabels.length + 1)` baked at compile time. */
export const LookupInteractionNode: NodeTypeDef = {
  type: 'lookupInteraction',
  label: 'Lookup Interaction',
  description: 'Indexes an Interaction Table model attribute by two face labels (e.g. from Get Facing Labels). Returns a float.',
  category: 'logic',
  color: '#1976d2',
  requirements: { variegated: true },
  ports: [
    { id: 'labelA', label: 'Label A', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '0' },
    { id: 'labelB', label: 'Label B', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '0' },
    { id: 'value', label: 'Value', kind: 'output', category: 'value', dataType: 'float' },
  ],
  defaultConfig: { tableId: '' },
  compile: (nodeId, config, inputs) => {
    const tableId = (config.tableId as string) || '';
    const labelA = inputs['labelA'] || '0';
    const labelB = inputs['labelB'] || '0';
    // Baked by compile.ts pre-resolve: labelCount = faceLabels.length + 1 (the
    // implicit `none` label at index 0). When unset, fall back to 1 — the
    // resulting table is a degenerate 1x1, and the runtime returns the (0,0)
    // entry which is 0.
    const labelCount = Number(config._labelCount) || 1;
    if (!tableId) return `const _v${nodeId} = 0;\n`;
    return [
      `const _la${nodeId} = ((${labelA}) | 0);`,
      `const _lb${nodeId} = ((${labelB}) | 0);`,
      `const _tbl${nodeId} = _interactionTables[${JSON.stringify(tableId)}];`,
      `const _v${nodeId} = _tbl${nodeId} ? (_tbl${nodeId}[_la${nodeId} * ${labelCount} + _lb${nodeId}] || 0) : 0;`,
    ].join(' ') + '\n';
  },
};

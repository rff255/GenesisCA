import type { NodeTypeDef } from '../types';

export const GroupCountingNode: NodeTypeDef = {
  type: 'groupCounting',
  label: 'Count Matching',
  category: 'aggregation',
  color: '#e65100',
  ports: [
    { id: 'values', label: 'Values', kind: 'input', category: 'value', dataType: 'any', isArray: true },
    { id: 'compare', label: 'Compare To', kind: 'input', category: 'value', dataType: 'any' },
    { id: 'count', label: 'Count', kind: 'output', category: 'value', dataType: 'integer' },
  ],
  defaultConfig: { operation: 'equals' },
  compile: (nodeId, config, inputs) => {
    const valuesVar = inputs['values'] || '[]';
    const compareVar = inputs['compare'] || '0';
    const op = config.operation as string;
    let cond: string;
    switch (op) {
      case 'notEquals': cond = `v !== ${compareVar}`; break;
      case 'greater':   cond = `v > ${compareVar}`; break;
      case 'lesser':    cond = `v < ${compareVar}`; break;
      default:          cond = `v === ${compareVar}`; break;
    }
    return `let _v${nodeId} = 0; for (let _i = 0; _i < ${valuesVar}.length; _i++) { const v = ${valuesVar}[_i]; if (${cond}) _v${nodeId}++; }\n`;
  },
};

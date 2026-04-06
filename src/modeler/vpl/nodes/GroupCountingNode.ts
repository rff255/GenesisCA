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
    return `const _v${nodeId} = ${valuesVar}.filter(v => ${cond}).length;\n`;
  },
};

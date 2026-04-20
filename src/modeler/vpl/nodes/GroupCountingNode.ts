import type { NodeTypeDef } from '../types';

export const GroupCountingNode: NodeTypeDef = {
  type: 'groupCounting',
  label: 'Count Matching',
  description: 'Counts how many values in an array match a comparison against X, or fall within (or outside) an interval.',
  category: 'aggregation',
  color: '#e65100',
  ports: [
    { id: 'values', label: 'Values', kind: 'input', category: 'value', dataType: 'any', isArray: true },
    { id: 'compare', label: 'Compare To', kind: 'input', category: 'value', dataType: 'any' },
    { id: 'compareHigh', label: 'Compare High', kind: 'input', category: 'value', dataType: 'any' },
    { id: 'count', label: 'Count', kind: 'output', category: 'value', dataType: 'integer' },
    { id: 'indexes', label: 'Indexes', kind: 'output', category: 'value', dataType: 'any', isArray: true },
  ],
  defaultConfig: { operation: 'equals', lowOp: '>=', highOp: '<=' },
  compile: (nodeId, config, inputs) => {
    const valuesVar = inputs['values'] || '[]';
    const compareVar = inputs['compare'] || '0';
    const op = config.operation as string;
    const gi = `_gi${nodeId}`;
    const elem = `${valuesVar}[${gi}]`;
    let cond: string;
    switch (op) {
      case 'notEquals': cond = `${elem} !== ${compareVar}`; break;
      case 'greater':   cond = `${elem} > ${compareVar}`; break;
      case 'lesser':    cond = `${elem} < ${compareVar}`; break;
      case 'between':
      case 'notBetween': {
        const compareHighVar = inputs['compareHigh'] || '0';
        const lo = config.lowOp === '>' ? '>' : '>=';
        const hi = config.highOp === '<' ? '<' : '<=';
        const inside = `(${elem} ${lo} ${compareVar} && ${elem} ${hi} ${compareHighVar})`;
        cond = op === 'notBetween' ? `!${inside}` : inside;
        break;
      }
      default:          cond = `${elem} === ${compareVar}`; break;
    }
    const needsIndexes = !!config._indexesConnected;

    if (needsIndexes) {
      // Full loop: collect matching indexes (when indexes output is connected)
      return [
        `_v${nodeId}_indexes.length = 0; let _v${nodeId}_indexesLen = 0;`,
        `for (let ${gi} = 0; ${gi} < ${valuesVar}.length; ${gi}++) { if (${cond}) _v${nodeId}_indexes[_v${nodeId}_indexesLen++] = ${gi}; }`,
        `const _v${nodeId}_count = _v${nodeId}_indexes.length;`,
      ].join(' ') + '\n';
    }

    // Fast path: simple counter (no index tracking needed)
    return [
      `let _v${nodeId}_count = 0;`,
      `for (let ${gi} = 0; ${gi} < ${valuesVar}.length; ${gi}++) { if (${cond}) _v${nodeId}_count++; }`,
    ].join(' ') + '\n';
  },
};

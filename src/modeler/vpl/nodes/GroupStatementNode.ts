import type { NodeTypeDef } from '../types';

export const GroupStatementNode: NodeTypeDef = {
  type: 'groupStatement',
  label: 'Group Assert',
  category: 'aggregation',
  color: '#e65100',
  ports: [
    { id: 'values', label: 'Values', kind: 'input', category: 'value', dataType: 'any', isArray: true },
    { id: 'x', label: 'X', kind: 'input', category: 'value', dataType: 'any', inlineWidget: 'number', defaultValue: '0' },
    { id: 'result', label: 'Result', kind: 'output', category: 'value', dataType: 'bool' },
    { id: 'indexes', label: 'Indexes', kind: 'output', category: 'value', dataType: 'any', isArray: true },
  ],
  defaultConfig: { operation: 'allIs' },
  compile: (nodeId, config, inputs) => {
    const values = inputs['values'] || '[]';
    const x = inputs['x'] || '0';
    const op = config.operation as string;
    const gi = `_gi${nodeId}`;
    const elem = `${values}[${gi}]`;
    let cond: string;
    switch (op) {
      case 'noneIs':                        cond = `${elem} !== ${x}`; break;
      case 'allGreater': case 'anyGreater': cond = `${elem} > ${x}`; break;
      case 'allLesser':  case 'anyLesser':  cond = `${elem} < ${x}`; break;
      default:                              cond = `${elem} === ${x}`; break; // allIs, hasA
    }
    const isAll = op === 'allIs' || op === 'noneIs' || op === 'allGreater' || op === 'allLesser';
    const resultExpr = isAll
      ? `_v${nodeId}_indexes.length === ${values}.length`
      : `_v${nodeId}_indexes.length > 0`;
    return [
      `_v${nodeId}_indexes.length = 0;`,
      `for (let ${gi} = 0; ${gi} < ${values}.length; ${gi}++) { if (${cond}) _v${nodeId}_indexes.push(${gi}); }`,
      `const _v${nodeId}_result = ${resultExpr};`,
    ].join(' ') + '\n';
  },
};

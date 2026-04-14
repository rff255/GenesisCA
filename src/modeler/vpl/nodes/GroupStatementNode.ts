import type { NodeTypeDef } from '../types';

export const GroupStatementNode: NodeTypeDef = {
  type: 'groupStatement',
  label: 'Group Assert',
  description: 'Tests an assertion across an array: all equal, none equal, any greater, all lesser, etc.',
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
    const isAll = op === 'allIs' || op === 'noneIs' || op === 'allGreater' || op === 'allLesser';
    const needsIndexes = !!config._indexesConnected;

    if (needsIndexes) {
      // Full loop: collect matching indexes (when indexes output is connected)
      const gi = `_gi${nodeId}`;
      const elem = `${values}[${gi}]`;
      let cond: string;
      switch (op) {
        case 'noneIs':                        cond = `${elem} !== ${x}`; break;
        case 'allGreater': case 'anyGreater': cond = `${elem} > ${x}`; break;
        case 'allLesser':  case 'anyLesser':  cond = `${elem} < ${x}`; break;
        default:                              cond = `${elem} === ${x}`; break;
      }
      const resultExpr = isAll
        ? `_v${nodeId}_indexes.length === ${values}.length`
        : `_v${nodeId}_indexes.length > 0`;
      return [
        `_v${nodeId}_indexes.length = 0; let _v${nodeId}_indexesLen = 0;`,
        `for (let ${gi} = 0; ${gi} < ${values}.length; ${gi}++) { if (${cond}) _v${nodeId}_indexes[_v${nodeId}_indexesLen++] = ${gi}; }`,
        `const _v${nodeId}_result = ${resultExpr};`,
      ].join(' ') + '\n';
    }

    // Fast path: short-circuit evaluation (no index tracking needed)
    let expr: string;
    switch (op) {
      case 'allIs':      expr = `${values}.every(v => v === ${x})`; break;
      case 'noneIs':     expr = `${values}.every(v => v !== ${x})`; break;
      case 'hasA':       expr = `${values}.some(v => v === ${x})`; break;
      case 'allGreater': expr = `${values}.every(v => v > ${x})`; break;
      case 'anyGreater': expr = `${values}.some(v => v > ${x})`; break;
      case 'allLesser':  expr = `${values}.every(v => v < ${x})`; break;
      case 'anyLesser':  expr = `${values}.some(v => v < ${x})`; break;
      default:           expr = `${values}.every(v => v === ${x})`; break;
    }
    return `const _v${nodeId}_result = ${expr};\n`;
  },
};

import type { NodeTypeDef } from '../types';

export const GroupStatementNode: NodeTypeDef = {
  type: 'groupStatement',
  label: 'Group Assert',
  category: 'aggregation',
  color: '#e65100',
  ports: [
    { id: 'values', label: 'Values', kind: 'input', category: 'value', dataType: 'any', isArray: true },
    { id: 'x', label: 'X', kind: 'input', category: 'value', dataType: 'any' },
    { id: 'result', label: 'Result', kind: 'output', category: 'value', dataType: 'bool' },
  ],
  defaultConfig: { operation: 'allIs' },
  compile: (nodeId, config, inputs) => {
    const values = inputs['values'] || '[]';
    const x = inputs['x'] || '0';
    const op = config.operation as string;
    let expr: string;
    switch (op) {
      case 'noneIs':     expr = `${values}.every(v => v !== ${x})`; break;
      case 'hasA':       expr = `${values}.some(v => v === ${x})`; break;
      case 'allGreater': expr = `${values}.every(v => v > ${x})`; break;
      case 'allLesser':  expr = `${values}.every(v => v < ${x})`; break;
      case 'anyGreater': expr = `${values}.some(v => v > ${x})`; break;
      case 'anyLesser':  expr = `${values}.some(v => v < ${x})`; break;
      default:           expr = `${values}.every(v => v === ${x})`; break; // allIs
    }
    return `const _v${nodeId} = ${expr};\n`;
  },
};

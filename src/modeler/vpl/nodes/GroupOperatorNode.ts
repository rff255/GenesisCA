import type { NodeTypeDef } from '../types';

export const GroupOperatorNode: NodeTypeDef = {
  type: 'groupOperator',
  label: 'Group Reduce',
  category: 'aggregation',
  color: '#e65100',
  ports: [
    { id: 'values', label: 'Values', kind: 'input', category: 'value', dataType: 'any', isArray: true },
    { id: 'result', label: 'Result', kind: 'output', category: 'value', dataType: 'any' },
  ],
  defaultConfig: { operation: 'sum' },
  compile: (nodeId, config, inputs) => {
    const values = inputs['values'] || '[]';
    const op = config.operation as string;
    let expr: string;
    switch (op) {
      case 'mul':     expr = `${values}.reduce((s,v) => s * v, 1)`; break;
      case 'max':     expr = `Math.max(...${values})`; break;
      case 'min':     expr = `Math.min(...${values})`; break;
      case 'mean':    expr = `(${values}.reduce((s,v) => s + v, 0) / (${values}.length || 1))`; break;
      case 'and':     expr = `${values}.every(Boolean)`; break;
      case 'or':      expr = `${values}.some(Boolean)`; break;
      case 'random':  expr = `${values}[Math.floor(Math.random() * ${values}.length)]`; break;
      default:        expr = `${values}.reduce((s,v) => s + v, 0)`; break; // sum
    }
    return `const _v${nodeId} = ${expr};\n`;
  },
};

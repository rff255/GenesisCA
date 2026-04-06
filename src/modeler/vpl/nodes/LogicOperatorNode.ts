import type { NodeTypeDef } from '../types';

export const LogicOperatorNode: NodeTypeDef = {
  type: 'logicOperator',
  label: 'Logic',
  category: 'logic',
  color: '#1a237e',
  ports: [
    { id: 'a', label: 'A', kind: 'input', category: 'value', dataType: 'bool' },
    { id: 'b', label: 'B', kind: 'input', category: 'value', dataType: 'bool' },
    { id: 'result', label: 'Result', kind: 'output', category: 'value', dataType: 'bool' },
  ],
  defaultConfig: { operation: 'OR' },
  compile: (nodeId, config, inputs) => {
    const a = inputs['a'] || 'false';
    const b = inputs['b'] || 'false';
    const op = config.operation as string;
    let expr: string;
    switch (op) {
      case 'AND': expr = `(${a} && ${b})`; break;
      case 'XOR': expr = `(!!(${a}) !== !!(${b}))`; break;
      case 'NOT': expr = `(!(${a}))`; break;
      default:    expr = `(${a} || ${b})`; break;
    }
    return `const _v${nodeId} = ${expr};\n`;
  },
};

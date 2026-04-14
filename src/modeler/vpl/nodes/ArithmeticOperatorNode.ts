import type { NodeTypeDef } from '../types';

export const ArithmeticOperatorNode: NodeTypeDef = {
  type: 'arithmeticOperator',
  label: 'Math',
  description: 'Performs arithmetic: +, -, *, /, %, sqrt, pow, abs, max, min, mean.',
  category: 'logic',
  color: '#b8860b',
  ports: [
    { id: 'x', label: 'X', kind: 'input', category: 'value', dataType: 'any', inlineWidget: 'number', defaultValue: '0' },
    { id: 'y', label: 'Y', kind: 'input', category: 'value', dataType: 'any', inlineWidget: 'number', defaultValue: '0' },
    { id: 'result', label: 'Result', kind: 'output', category: 'value', dataType: 'any' },
  ],
  defaultConfig: { operation: '+' },
  compile: (nodeId, config, inputs) => {
    const x = inputs['x'] || '0';
    const y = inputs['y'] || '0';
    const op = config.operation as string;
    let expr: string;
    switch (op) {
      case '-':    expr = `(${x} - ${y})`; break;
      case '*':    expr = `(${x} * ${y})`; break;
      case '/':    expr = `(${y} !== 0 ? ${x} / ${y} : 0)`; break;
      case '%':    expr = `(${y} !== 0 ? ${x} % ${y} : 0)`; break;
      case 'sqrt': expr = `Math.sqrt(${x})`; break;
      case 'pow':  expr = `Math.pow(${x}, ${y})`; break;
      case 'abs':  expr = `Math.abs(${x})`; break;
      case 'max':  expr = `Math.max(${x}, ${y})`; break;
      case 'min':  expr = `Math.min(${x}, ${y})`; break;
      case 'mean': expr = `((${x} + ${y}) / 2)`; break;
      default:     expr = `(${x} + ${y})`; break;
    }
    return `const _v${nodeId} = ${expr};\n`;
  },
};

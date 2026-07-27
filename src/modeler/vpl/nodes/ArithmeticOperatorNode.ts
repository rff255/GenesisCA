import type { NodeTypeDef } from '../types';

/** Math operations that read only X (the Y input is hidden for them). Shared
 *  with CaNode's collapsed-label formatter so the two never drift. */
export const ARITHMETIC_UNARY_OPS = new Set([
  'sqrt', 'abs', 'floor', 'ceil', 'round', 'exp', 'log', 'sin', 'cos', 'tan', 'tanh',
]);

export const ArithmeticOperatorNode: NodeTypeDef = {
  type: 'arithmeticOperator',
  label: 'Math',
  description: 'Performs arithmetic: +, -, *, /, %, sqrt, pow, abs, floor, ceil, round, max, min, mean, exp, log (natural), sin, cos, tan, tanh.',
  category: 'logic',
  color: '#b8860b',
  ports: [
    { id: 'x', label: 'X', kind: 'input', category: 'value', dataType: 'any', inlineWidget: 'number', defaultValue: '0' },
    { id: 'y', label: 'Y', kind: 'input', category: 'value', dataType: 'any', inlineWidget: 'number', defaultValue: '0' },
    { id: 'result', label: 'Result', kind: 'output', category: 'value', dataType: 'any' },
  ],
  defaultConfig: { operation: '+' },
  // The unary ops read only X — hide the Y input for them.
  hiddenPorts: (config) =>
    ARITHMETIC_UNARY_OPS.has(config.operation as string) ? ['y'] : [],
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
      // round = floor(x + 0.5) on EVERY target (JS/WASM/WGSL) — NOT Math.round /
      // f64.nearest / WGSL round(), whose banker's rounding would break parity.
      // Matches the Expression node's floor/ceil/round convention exactly.
      case 'floor': expr = `Math.floor(${x})`; break;
      case 'ceil':  expr = `Math.ceil(${x})`; break;
      case 'round': expr = `Math.floor((${x}) + 0.5)`; break;
      case 'max':  expr = `Math.max(${x}, ${y})`; break;
      case 'min':  expr = `Math.min(${x}, ${y})`; break;
      case 'mean': expr = `((${x} + ${y}) / 2)`; break;
      case 'exp':  expr = `Math.exp(${x})`; break;
      case 'log':  expr = `Math.log(${x})`; break;
      case 'sin':  expr = `Math.sin(${x})`; break;
      case 'cos':  expr = `Math.cos(${x})`; break;
      case 'tan':  expr = `Math.tan(${x})`; break;
      case 'tanh': expr = `Math.tanh(${x})`; break;
      default:     expr = `(${x} + ${y})`; break;
    }
    return `const _v${nodeId} = ${expr};\n`;
  },
};

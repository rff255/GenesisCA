import type { NodeTypeDef } from '../types';

export const LogicOperatorNode: NodeTypeDef = {
  type: 'logicOperator',
  label: 'Logic',
  description: 'Binary logic: AND, OR, XOR, NOT.',
  category: 'logic',
  color: '#1a237e',
  ports: [
    { id: 'a', label: 'A', kind: 'input', category: 'value', dataType: 'bool', inlineWidget: 'bool', defaultValue: 'false' },
    { id: 'b', label: 'B', kind: 'input', category: 'value', dataType: 'bool', inlineWidget: 'bool', defaultValue: 'false' },
    { id: 'result', label: 'Result', kind: 'output', category: 'value', dataType: 'bool' },
  ],
  defaultConfig: { operation: 'OR' },
  // NOT is unary — hide the second operand.
  hiddenPorts: (config) => (config.operation === 'NOT' ? ['b'] : []),
  compile: (nodeId, config, inputs) => {
    const a = inputs['a'] || 'false';
    const b = inputs['b'] || 'false';
    const op = config.operation as string;
    // A logic operator returns a BOOLEAN, emitted as numeric 1/0 (the project's
    // bool convention for typed-array compatibility — see CLAUDE.md). The `?1:0`
    // wrapper also pins parity with WASM/WebGPU: for 0/1 inputs the result is
    // identical, and for a non-0/1 'any' source (which the editor's port rules
    // permit into this bool input) all three targets now agree on 1/0 instead of
    // JS yielding the raw operand value (e.g. `1 && 4` → 1, not 4).
    let expr: string;
    switch (op) {
      case 'AND': expr = `((${a} && ${b}) ? 1 : 0)`; break;
      case 'XOR': expr = `((!!(${a}) !== !!(${b})) ? 1 : 0)`; break;
      case 'NOT': expr = `((${a}) ? 0 : 1)`; break;
      default:    expr = `((${a} || ${b}) ? 1 : 0)`; break;
    }
    return `const _v${nodeId} = ${expr};\n`;
  },
};

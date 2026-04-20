import type { NodeTypeDef } from '../types';

export const StatementNode: NodeTypeDef = {
  type: 'statement',
  label: 'Compare',
  description: 'Compares two values with ==, !=, >, <, >=, <=, between (range check), or not between.',
  category: 'logic',
  color: '#1a237e',
  ports: [
    { id: 'x', label: 'X', kind: 'input', category: 'value', dataType: 'any', inlineWidget: 'number', defaultValue: '0' },
    { id: 'y', label: 'Y', kind: 'input', category: 'value', dataType: 'any', inlineWidget: 'number', defaultValue: '0' },
    { id: 'y2', label: 'Y₂', kind: 'input', category: 'value', dataType: 'any', inlineWidget: 'number', defaultValue: '0' },
    { id: 'result', label: 'Result', kind: 'output', category: 'value', dataType: 'bool' },
  ],
  defaultConfig: { operation: '==', lowOp: '>=', highOp: '<=' },
  compile: (nodeId, config, inputs) => {
    const x = inputs['x'] || '0';
    const y = inputs['y'] || '0';
    const op = config.operation as string;
    if (op === 'between' || op === 'notBetween') {
      const y2 = inputs['y2'] || '0';
      const lo = config.lowOp === '>' ? '>' : '>=';
      const hi = config.highOp === '<' ? '<' : '<=';
      const inside = `((${x} ${lo} ${y}) && (${x} ${hi} ${y2}))`;
      return `const _v${nodeId} = ${op === 'notBetween' ? `!${inside}` : inside};\n`;
    }
    let jsOp: string;
    switch (op) {
      case '!=': jsOp = '!=='; break;
      case '>':  jsOp = '>'; break;
      case '<':  jsOp = '<'; break;
      case '>=': jsOp = '>='; break;
      case '<=': jsOp = '<='; break;
      default:   jsOp = '==='; break;
    }
    return `const _v${nodeId} = (${x} ${jsOp} ${y});\n`;
  },
};

import type { NodeTypeDef } from '../types';

export const StatementNode: NodeTypeDef = {
  type: 'statement',
  label: 'Compare',
  category: 'logic',
  color: '#1a237e',
  ports: [
    { id: 'x', label: 'X', kind: 'input', category: 'value', dataType: 'any', inlineWidget: 'number', defaultValue: '0' },
    { id: 'y', label: 'Y', kind: 'input', category: 'value', dataType: 'any', inlineWidget: 'number', defaultValue: '0' },
    { id: 'result', label: 'Result', kind: 'output', category: 'value', dataType: 'bool' },
  ],
  defaultConfig: { operation: '==' },
  compile: (nodeId, config, inputs) => {
    const x = inputs['x'] || '0';
    const y = inputs['y'] || '0';
    const op = config.operation as string;
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

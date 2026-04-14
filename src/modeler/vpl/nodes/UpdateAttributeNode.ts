import type { NodeTypeDef } from '../types';

export const UpdateAttributeNode: NodeTypeDef = {
  type: 'updateAttribute',
  label: 'Update Attribute',
  description: 'Modifies a cell attribute in place: increment, decrement, toggle, min/max, next/previous tag.',
  category: 'output',
  color: '#4a148c',
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'value', label: 'Value', kind: 'input', category: 'value', dataType: 'any', inlineWidget: 'number', defaultValue: '1' },
  ],
  defaultConfig: { attributeId: '', operation: 'increment' },
  compile: (nodeId, config, inputs) => {
    const attr = config.attributeId as string || '_undef';
    const value = inputs['value'] || '0';
    const op = config.operation as string;
    void nodeId;
    switch (op) {
      // Bool operations
      case 'toggle': return `w_${attr}[idx] = w_${attr}[idx] ? 0 : 1;\n`;
      case 'or':     return `w_${attr}[idx] = (w_${attr}[idx] || ${value}) ? 1 : 0;\n`;
      case 'and':    return `w_${attr}[idx] = (w_${attr}[idx] && ${value}) ? 1 : 0;\n`;
      // Integer/Float operations
      case 'decrement': return `w_${attr}[idx] -= ${value};\n`;
      case 'max':       return `w_${attr}[idx] = Math.max(w_${attr}[idx], ${value});\n`;
      case 'min':       return `w_${attr}[idx] = Math.min(w_${attr}[idx], ${value});\n`;
      // Tag operations
      case 'next':     return `w_${attr}[idx] = (w_${attr}[idx] + 1) % (${Number(config._tagLen) || 1});\n`;
      case 'previous': return `w_${attr}[idx] = (w_${attr}[idx] - 1 + ${Number(config._tagLen) || 1}) % (${Number(config._tagLen) || 1});\n`;
      // Default: increment (integer/float)
      default: return `w_${attr}[idx] += ${value};\n`;
    }
  },
};

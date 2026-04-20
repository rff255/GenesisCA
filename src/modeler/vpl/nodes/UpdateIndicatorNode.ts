import type { NodeTypeDef } from '../types';

export const UpdateIndicatorNode: NodeTypeDef = {
  type: 'updateIndicator',
  label: 'Update Indicator',
  description: 'Modifies an indicator in place: increment, decrement, toggle, min/max, next/previous tag.',
  category: 'output',
  color: '#00695c',
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'value', label: 'Value', kind: 'input', category: 'value', dataType: 'any', inlineWidget: 'number', defaultValue: '0' },
  ],
  defaultConfig: { indicatorId: '', operation: 'increment' },
  compile: (nodeId, config, inputs) => {
    const idx = Number(config._indicatorIdx ?? -1);
    const value = inputs['value'] || '0';
    const op = config.operation as string;
    const key = String(idx);
    void nodeId;
    switch (op) {
      // Bool operations
      case 'toggle': return `_indicators[${key}] = _indicators[${key}] ? 0 : 1;\n`;
      case 'or':     return `_indicators[${key}] = (_indicators[${key}] || ${value}) ? 1 : 0;\n`;
      case 'and':    return `_indicators[${key}] = (_indicators[${key}] && ${value}) ? 1 : 0;\n`;
      // Integer/Float operations
      case 'decrement': return `_indicators[${key}] -= ${value};\n`;
      case 'max':       return `_indicators[${key}] = Math.max(_indicators[${key}], ${value});\n`;
      case 'min':       return `_indicators[${key}] = Math.min(_indicators[${key}], ${value});\n`;
      // Tag operations
      case 'next':     return `_indicators[${key}] = (_indicators[${key}] + 1) % (${Number(config._tagLen) || 1});\n`;
      case 'previous': return `_indicators[${key}] = (_indicators[${key}] - 1 + ${Number(config._tagLen) || 1}) % (${Number(config._tagLen) || 1});\n`;
      // Default: increment (integer/float)
      default: return `_indicators[${key}] += ${value};\n`;
    }
  },
};

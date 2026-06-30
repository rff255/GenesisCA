import type { NodeTypeDef } from '../types';

export const UpdateAttributeNode: NodeTypeDef = {
  type: 'updateAttribute',
  label: 'Update Attribute',
  agentLabel: 'Update Self Attribute',
  description: 'Modifies a cell attribute in place: increment, decrement, toggle, min/max, next/previous tag.',
  agentDescription: "Modifies one of the current agent's own attributes in place: increment, decrement, toggle, min/max, next/previous tag.",
  category: 'output',
  color: '#4a148c',
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'next', label: 'NEXT', kind: 'output', category: 'flow' },
    { id: 'value', label: 'Value', kind: 'input', category: 'value', dataType: 'any', inlineWidget: 'number', defaultValue: '1' },
  ],
  defaultConfig: { attributeId: '', operation: 'increment' },
  // Unary ops (toggle / next / previous) read no operand — hide the Value input.
  hiddenPorts: (config) => {
    const op = config.operation;
    return (op === 'toggle' || op === 'next' || op === 'previous') ? ['value'] : [];
  },
  compile: (nodeId, config, inputs, _boundary, ctx) => {
    const attr = config.attributeId as string || '_undef';
    const value = inputs['value'] || '0';
    const op = config.operation as string;
    void nodeId;
    // Read uses the write buffer (read-modify-write semantics). For sub-attributes
    // the read is guarded — non-matching cells see undefinedValue. The LHS write
    // always proceeds (rule a); storage at non-matching indices stays invisible.
    const r = ctx ? ctx.readAttrExpr(attr, 'idx', { fromWriteBuffer: true }) : `w_${attr}[idx]`;
    const tagLen = Number(config._tagLen) || 1;
    switch (op) {
      // Bool operations
      case 'toggle': return `w_${attr}[idx] = ${r} ? 0 : 1;\n`;
      case 'or':     return `w_${attr}[idx] = (${r} || ${value}) ? 1 : 0;\n`;
      case 'and':    return `w_${attr}[idx] = (${r} && ${value}) ? 1 : 0;\n`;
      // Integer/Float operations
      case 'decrement': return `w_${attr}[idx] = ${r} - ${value};\n`;
      case 'max':       return `w_${attr}[idx] = Math.max(${r}, ${value});\n`;
      case 'min':       return `w_${attr}[idx] = Math.min(${r}, ${value});\n`;
      // Tag operations
      case 'next':     return `w_${attr}[idx] = (${r} + 1) % (${tagLen});\n`;
      case 'previous': return `w_${attr}[idx] = (${r} - 1 + ${tagLen}) % (${tagLen});\n`;
      // Default: increment (integer/float)
      default: return `w_${attr}[idx] = ${r} + ${value};\n`;
    }
  },
};

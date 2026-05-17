import type { NodeTypeDef } from '../types';

export const ValueSwitchNode: NodeTypeDef = {
  type: 'valueSwitch',
  label: 'Value Switch',
  description: 'Ternary value selector: returns If when Condition is truthy (nonzero), else Else. Both inputs always evaluate — use a flow Conditional for short-circuit.',
  category: 'logic',
  color: '#b8860b',
  ports: [
    { id: 'condition', label: 'Condition', kind: 'input', category: 'value', dataType: 'any', inlineWidget: 'bool',   defaultValue: 'false' },
    { id: 'ifValue',   label: 'If',        kind: 'input', category: 'value', dataType: 'any', inlineWidget: 'number', defaultValue: '1' },
    { id: 'elseValue', label: 'Else',      kind: 'input', category: 'value', dataType: 'any', inlineWidget: 'number', defaultValue: '0' },
    { id: 'result',    label: 'Result',    kind: 'output', category: 'value', dataType: 'any' },
  ],
  defaultConfig: {},
  compile: (nodeId, _config, inputs) => {
    const cond = inputs['condition'] || 'false';
    const ifV  = inputs['ifValue']   || '1';
    const elV  = inputs['elseValue'] || '0';
    return `const _v${nodeId} = (${cond}) ? (${ifV}) : (${elV});\n`;
  },
};

import type { NodeTypeDef } from '../types';

/** Writes a value to a scalar Local Variable. Array variables use
 *  SetArrayElement instead — the kind dropdown on the variable definition
 *  determines which write node applies (validation enforces). */
export const SetVariableNode: NodeTypeDef = {
  type: 'setVariable',
  label: 'Set Variable',
  description: "Assigns a value to a scalar Local Variable (per-cell scratch storage).",
  category: 'output',
  color: '#5e35b1',
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'value', label: 'Value', kind: 'input', category: 'value', dataType: 'any', inlineWidget: 'number', defaultValue: '0' },
  ],
  defaultConfig: { variableId: '' },
  compile: (nodeId, config, inputs) => {
    const variableId = (config.variableId as string) || '';
    const value = inputs['value'] || '0';
    void nodeId;
    if (!variableId) return ''; // validation surfaces the missing config
    const safe = variableId.replace(/[^a-zA-Z0-9_]/g, '_');
    return `_var_${safe} = ${value};\n`;
  },
};

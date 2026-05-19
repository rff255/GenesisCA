import type { NodeTypeDef } from '../types';

/** Writes a value to an array Local Variable at a runtime-computed index.
 *  Use Set Variable for scalar variables — the kind dropdown on the variable
 *  definition determines which write node applies (validation enforces). */
export const SetArrayElementNode: NodeTypeDef = {
  type: 'setArrayElement',
  label: 'Set Array Element',
  description: "Assigns a value at index `i` of an array Local Variable (per-cell scratch storage).",
  category: 'output',
  color: '#5e35b1',
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'index', label: 'Index', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '0' },
    { id: 'value', label: 'Value', kind: 'input', category: 'value', dataType: 'any', inlineWidget: 'number', defaultValue: '0' },
  ],
  defaultConfig: { variableId: '' },
  compile: (nodeId, config, inputs) => {
    const variableId = (config.variableId as string) || '';
    const index = inputs['index'] || '0';
    const value = inputs['value'] || '0';
    void nodeId;
    if (!variableId) return '';
    const safe = variableId.replace(/[^a-zA-Z0-9_]/g, '_');
    // Bounds-check at write time. Out-of-range writes silently skip (matches
    // typed-array behaviour, but explicit for readability).
    return `if (${index} >= 0 && ${index} < _var_${safe}.length) _var_${safe}[${index}] = ${value};\n`;
  },
};

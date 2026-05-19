import type { NodeTypeDef } from '../types';

/** Reads the current value of a Local Variable (per-cell scratch storage).
 *  For scalar variables, returns the current value. For array variables,
 *  returns the underlying typed array (consumers iterate it like any other
 *  array source — Aggregate, GroupReduce, ArrayElement, ForEachInArray). */
export const GetVariableNode: NodeTypeDef = {
  type: 'getVariable',
  label: 'Get Variable',
  description: "Reads a Local Variable's current value (scalar) or its underlying array (array variables).",
  category: 'data',
  color: '#5e35b1',
  ports: [
    { id: 'value', label: 'Value', kind: 'output', category: 'value', dataType: 'any' },
  ],
  defaultConfig: {},
  // The compiler reads `variableId` from config + looks up the variable in
  // model.variables to decide whether the output is a scalar or an array
  // (isArray on the output port is derived dynamically in effectivePorts).
  compile: (nodeId, config, _inputs, _boundary, _ctx) => {
    const variableId = (config.variableId as string) || '';
    if (!variableId) return `const _v${nodeId} = 0;\n`;
    // _var_<safe(id)> is the convention from `variable.ts::variableLocalName`.
    const safe = variableId.replace(/[^a-zA-Z0-9_]/g, '_');
    return `const _v${nodeId} = _var_${safe};\n`;
  },
};

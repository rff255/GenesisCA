import type { NodeTypeDef } from '../types';

export const GetRandomNode: NodeTypeDef = {
  type: 'getRandom',
  label: 'Get Random',
  description: 'Random value: bool (1 with probability P, else 0), integer in [min, max], float in [min, max), orientation (uniform 0..3 = N/E/S/W), or one option uniformly picked from the wired Options array (returns Fallback if array is empty).',
  category: 'data',
  color: '#b71c1c',
  ports: [
    { id: 'probability', label: 'P', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0.5' },
    { id: 'options', label: 'Options', kind: 'input', category: 'value', dataType: 'any', isArray: true },
    { id: 'fallback', label: 'Fallback', kind: 'input', category: 'value', dataType: 'any', inlineWidget: 'number', defaultValue: '0' },
    { id: 'value', label: 'Value', kind: 'output', category: 'value', dataType: 'any' },
  ],
  defaultConfig: { randomType: 'float', min: '0', max: '1' },
  compile: (nodeId, config, inputVars) => {
    const type = config.randomType as string;
    const min = config.min as string || '0';
    const max = config.max as string || '1';
    // Inlined xorshift32 (Marsaglia constants 13/17/5, period 2^32 - 1).
    // _rs is a uint32 declared once per compiled function; the >>> 0 normalises
    // after << overflow so the final divide by 2^32 lands in [0, 1).
    const advance = '_rs = (_rs ^ (_rs << 13)) >>> 0;'
      + ' _rs = (_rs ^ (_rs >>> 17)) >>> 0;'
      + ' _rs = (_rs ^ (_rs << 5)) >>> 0;';
    if (type === 'bool') {
      const prob = inputVars.probability ?? '0.5';
      return `${advance} const _v${nodeId} = (_rs / 4294967296) < ${prob} ? 1 : 0;\n`;
    } else if (type === 'integer') {
      return `${advance} const _v${nodeId} = Math.floor((_rs / 4294967296) * (${max} - ${min} + 1)) + ${min};\n`;
    } else if (type === 'orientation') {
      // Orientation: uniform pick from 0..3 (N/E/S/W). No min/max widgets —
      // the domain is fixed. Matches the integer path's truncation pattern.
      return `${advance} const _v${nodeId} = Math.floor((_rs / 4294967296) * 4) & 3;\n`;
    } else if (type === 'options') {
      // inputVars.options resolves via inputToSources in compile.ts: '[v1,v2,...]'
      // for multi-source, the array varName for a single array source, or
      // '[srcName]' for a single scalar source. Fallback is the value returned
      // when the array is empty (only reachable for variable-length sources
      // like filterNeighbors); always visible in the UI so users explicitly
      // choose their domain sentinel.
      const arrExpr = inputVars.options ?? '[]';
      const fallback = inputVars.fallback ?? '0';
      return `${advance} const _optArr${nodeId} = ${arrExpr}; const _v${nodeId} = _optArr${nodeId}.length === 0 ? (${fallback}) : _optArr${nodeId}[Math.floor((_rs / 4294967296) * _optArr${nodeId}.length)];\n`;
    } else {
      return `${advance} const _v${nodeId} = (_rs / 4294967296) * (${max} - ${min}) + ${min};\n`;
    }
  },
};

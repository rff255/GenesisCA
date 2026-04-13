import type { NodeTypeDef } from '../types';

export const InterpolationNode: NodeTypeDef = {
  type: 'interpolation',
  label: 'Interpolate',
  category: 'logic',
  color: '#b8860b',
  ports: [
    { id: 't', label: 'T (0-1)', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0.5' },
    { id: 'min', label: 'Min', kind: 'input', category: 'value', dataType: 'any', inlineWidget: 'number', defaultValue: '0' },
    { id: 'max', label: 'Max', kind: 'input', category: 'value', dataType: 'any', inlineWidget: 'number', defaultValue: '1' },
    { id: 'result', label: 'Result', kind: 'output', category: 'value', dataType: 'any' },
  ],
  defaultConfig: {},
  compile: (nodeId, _config, inputs) => {
    const t = inputs['t'] || '0.5';
    const min = inputs['min'] || '0';
    const max = inputs['max'] || '1';
    return `const _v${nodeId} = (${min}) + (${t}) * ((${max}) - (${min}));\n`;
  },
};

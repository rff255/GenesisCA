import type { NodeTypeDef } from '../types';

export const ProportionMapNode: NodeTypeDef = {
  type: 'proportionMap',
  label: 'Proportion Map',
  description: 'Linearly maps X from one range to another (inMin\u2013inMax \u2192 outMin\u2013outMax).',
  category: 'logic',
  color: '#b8860b',
  ports: [
    { id: 'x', label: 'X', kind: 'input', category: 'value', dataType: 'any', inlineWidget: 'number', defaultValue: '0' },
    { id: 'inMin', label: 'In Min', kind: 'input', category: 'value', dataType: 'any', inlineWidget: 'number', defaultValue: '0' },
    { id: 'inMax', label: 'In Max', kind: 'input', category: 'value', dataType: 'any', inlineWidget: 'number', defaultValue: '1' },
    { id: 'outMin', label: 'Out Min', kind: 'input', category: 'value', dataType: 'any', inlineWidget: 'number', defaultValue: '0' },
    { id: 'outMax', label: 'Out Max', kind: 'input', category: 'value', dataType: 'any', inlineWidget: 'number', defaultValue: '1' },
    { id: 'result', label: 'Result', kind: 'output', category: 'value', dataType: 'any' },
  ],
  defaultConfig: {},
  compile: (nodeId, _config, inputs) => {
    const x = inputs['x'] || '0';
    const inMin = inputs['inMin'] || '0';
    const inMax = inputs['inMax'] || '1';
    const outMin = inputs['outMin'] || '0';
    const outMax = inputs['outMax'] || '1';
    return `const _v${nodeId} = ((${inMax}) - (${inMin})) !== 0 ? (${outMin}) + ((${x}) - (${inMin})) * ((${outMax}) - (${outMin})) / ((${inMax}) - (${inMin})) : (${outMin});\n`;
  },
};

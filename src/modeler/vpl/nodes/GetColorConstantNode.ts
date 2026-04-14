import type { NodeTypeDef } from '../types';

export const GetColorConstantNode: NodeTypeDef = {
  type: 'getColorConstant',
  label: 'Color Constant',
  description: 'Emits a fixed RGB color as three integer channels.',
  category: 'color',
  color: '#006064',
  ports: [
    { id: 'r', label: 'R', kind: 'output', category: 'value', dataType: 'integer' },
    { id: 'g', label: 'G', kind: 'output', category: 'value', dataType: 'integer' },
    { id: 'b', label: 'B', kind: 'output', category: 'value', dataType: 'integer' },
  ],
  defaultConfig: { r: '128', g: '128', b: '128' },
  compile: (nodeId, config) => {
    const r = parseInt(config.r as string, 10) || 0;
    const g = parseInt(config.g as string, 10) || 0;
    const b = parseInt(config.b as string, 10) || 0;
    // Each channel is a separate output variable
    return `const _v${nodeId}_r = ${r}; const _v${nodeId}_g = ${g}; const _v${nodeId}_b = ${b};\n`;
  },
};

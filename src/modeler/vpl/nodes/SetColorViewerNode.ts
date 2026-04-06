import type { NodeTypeDef } from '../types';

export const SetColorViewerNode: NodeTypeDef = {
  type: 'setColorViewer',
  label: 'Set Color Viewer',
  category: 'color',
  color: '#006064',
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'r', label: 'R', kind: 'input', category: 'value', dataType: 'integer' },
    { id: 'g', label: 'G', kind: 'input', category: 'value', dataType: 'integer' },
    { id: 'b', label: 'B', kind: 'input', category: 'value', dataType: 'integer' },
  ],
  defaultConfig: { mappingId: '' },
  compile: (nodeId, config, inputs) => {
    const mappingId = config.mappingId as string || 'default';
    const r = inputs['r'] || '0';
    const g = inputs['g'] || '0';
    const b = inputs['b'] || '0';
    void nodeId;
    return `viewers[${JSON.stringify(mappingId)}] = { r: Math.round(${r}), g: Math.round(${g}), b: Math.round(${b}) };\n`;
  },
};

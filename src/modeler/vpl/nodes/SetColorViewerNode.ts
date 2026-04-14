import type { NodeTypeDef } from '../types';

export const SetColorViewerNode: NodeTypeDef = {
  type: 'setColorViewer',
  label: 'Set Color Viewer',
  description: 'Writes the current cell\u2019s R, G, B values when the named Output Mapping is active.',
  category: 'color',
  color: '#006064',
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'r', label: 'R', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '0' },
    { id: 'g', label: 'G', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '0' },
    { id: 'b', label: 'B', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '0' },
  ],
  defaultConfig: { mappingId: '' },
  compile: (nodeId, config, inputs) => {
    const mappingId = config.mappingId as string || 'default';
    const r = inputs['r'] || '0';
    const g = inputs['g'] || '0';
    const b = inputs['b'] || '0';
    void nodeId;
    // Only write colors if this viewer is the active one
    return `if (activeViewer === ${JSON.stringify(mappingId)}) { colors[colorIdx] = ${r}; colors[colorIdx+1] = ${g}; colors[colorIdx+2] = ${b}; colors[colorIdx+3] = 255; }\n`;
  },
};

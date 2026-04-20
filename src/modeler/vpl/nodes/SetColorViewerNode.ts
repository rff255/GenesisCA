import type { NodeTypeDef } from '../types';
import { safeId } from '../compiler/identifierSafe';

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
    // The compiler hoists a per-mapping `const _isV_<safeId> = activeViewer === "<id>"`
    // into the function preamble (one boolean per attribute-to-color mapping in the model),
    // so the per-cell branch is a local read instead of a string compare.
    return `if (_isV_${safeId(mappingId)}) { colors[colorIdx] = ${r}; colors[colorIdx+1] = ${g}; colors[colorIdx+2] = ${b}; colors[colorIdx+3] = 255; }\n`;
  },
};

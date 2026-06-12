import type { NodeTypeDef } from '../types';
import { safeId } from '../compiler/identifierSafe';

/** config.mappingId sentinel \u2014 "Current Simulator Selected": write the colors
 *  for WHICHEVER output mapping (viewer) is active in the simulator, instead
 *  of one fixed mapping. Lets one graph serve several viewers that differ
 *  only in other aspects. All three compile targets emit the channel writes
 *  WITHOUT the activeViewer guard for this value (the running pass IS the
 *  current viewer by construction). */
export const CURRENT_VIEWER_SENTINEL = '__current__';

export const SetColorViewerNode: NodeTypeDef = {
  type: 'setColorViewer',
  label: 'Set Color Viewer',
  description: 'Writes the current cell\u2019s R, G, B values when the named Output Mapping is active (or whichever is selected, with "Current Simulator Selected").',
  category: 'color',
  color: '#006064',
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'next', label: 'NEXT', kind: 'output', category: 'flow' },
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
    const writes = `colors[colorIdx] = ${r}; colors[colorIdx+1] = ${g}; colors[colorIdx+2] = ${b}; colors[colorIdx+3] = 255;`;
    // "Current Simulator Selected": no viewer guard — whatever pass is running
    // (step with any active viewer, or any output-mapping pass) gets the write.
    if (mappingId === CURRENT_VIEWER_SENTINEL) return `${writes}\n`;
    // The compiler hoists a per-mapping `const _isV_<safeId> = activeViewer === "<id>"`
    // into the function preamble (one boolean per attribute-to-color mapping in the model),
    // so the per-cell branch is a local read instead of a string compare.
    return `if (_isV_${safeId(mappingId)}) { ${writes} }\n`;
  },
};

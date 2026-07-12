import type { NodeTypeDef } from '../types';

/** Overseer action — write a MODEL attribute at runtime, exactly like moving
 *  the simulator's right-panel slider: the worker + the panel UI update, the
 *  model DEFINITION does not (no dirty flag, no .gcaproj change). The
 *  parameter-sweep primitive. */
export const OvSetModelAttributeNode: NodeTypeDef = {
  type: 'ovSetModelAttribute',
  label: 'Set Model Attribute',
  description: 'Sets a global model attribute for the running simulation (like the simulator sliders — runtime-only, never edits the model definition). The parameter-sweep primitive.',
  category: 'output',
  color: '#3949ab',
  requirements: { overseer: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'value', label: 'Value', kind: 'input', category: 'value', dataType: 'any', inlineWidget: 'number', defaultValue: '0' },
    { id: 'next', label: 'NEXT', kind: 'output', category: 'flow' },
  ],
  defaultConfig: { attributeId: '' },
  compile: () => '', // Action — the overseer compiler emits `await O.setAttr(id, value)`
};

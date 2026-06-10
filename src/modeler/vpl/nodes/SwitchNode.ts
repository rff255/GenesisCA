import type { NodeTypeDef } from '../types';

export const SwitchNode: NodeTypeDef = {
  type: 'switch',
  label: 'Switch',
  description: 'Multi-way branch. Picks an output case based on a compared value or per-case conditions.',
  category: 'flow',
  color: '#1b5e20',
  ports: [
    { id: 'check', label: 'CHECK', kind: 'input', category: 'flow' },
    { id: 'value', label: 'Value', kind: 'input', category: 'value', dataType: 'any', inlineWidget: 'number', defaultValue: '0' },
    // DONE (pass-through continuation) renders FIRST among the outputs so it
    // stays aligned with the CHECK input. CaNode/effectivePorts re-hoist it
    // above the dynamically-generated CASE_N ports (which push after DEFAULT).
    { id: 'next', label: 'DONE', kind: 'output', category: 'flow' },
    { id: 'default', label: 'DEFAULT', kind: 'output', category: 'flow' },
  ],
  defaultConfig: { mode: 'conditions', firstMatchOnly: true, caseCount: 0, valueType: 'integer' },
  compile: () => '', // Compiler handles flow control nodes specially
};

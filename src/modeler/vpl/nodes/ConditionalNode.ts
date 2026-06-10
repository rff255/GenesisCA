import type { NodeTypeDef } from '../types';

export const ConditionalNode: NodeTypeDef = {
  type: 'conditional',
  label: 'If / Then / Else',
  description: 'Branches the flow into THEN or ELSE based on a binary (true/false) condition.',
  category: 'flow',
  color: '#1b5e20',
  ports: [
    { id: 'check', label: 'CHECK', kind: 'input', category: 'flow' },
    { id: 'condition', label: 'IF', kind: 'input', category: 'value', dataType: 'bool', inlineWidget: 'bool', defaultValue: 'false' },
    // DONE (pass-through continuation) renders FIRST among the outputs so it
    // stays aligned with the CHECK input — chained nodes keep a horizontal
    // through-line instead of drifting down. THEN/ELSE branches hang below.
    { id: 'next', label: 'DONE', kind: 'output', category: 'flow' },
    { id: 'then', label: 'THEN', kind: 'output', category: 'flow' },
    { id: 'else', label: 'ELSE', kind: 'output', category: 'flow' },
  ],
  defaultConfig: {},
  compile: () => '',  // Compiler handles control flow nodes specially
};

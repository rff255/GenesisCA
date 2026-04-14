import type { NodeTypeDef } from '../types';

export const SequenceNode: NodeTypeDef = {
  type: 'sequence',
  label: 'Sequence',
  description: 'Runs two flows in order: FIRST, then THEN.',
  category: 'flow',
  color: '#1b5e20',
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'first', label: 'FIRST', kind: 'output', category: 'flow' },
    { id: 'then', label: 'THEN', kind: 'output', category: 'flow' },
  ],
  defaultConfig: {},
  compile: () => '', // Compiler handles flow nodes specially
};

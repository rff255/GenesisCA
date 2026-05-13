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
    // Additional outputs (Then 3, Then 4, …) are appended dynamically by
    // CaNode.tsx based on `extraCount`. They use IDs `then_2`, `then_3`, ….
  ],
  defaultConfig: { extraCount: 0 },
  compile: () => '', // Compiler handles flow nodes specially
};

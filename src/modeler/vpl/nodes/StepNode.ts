import type { NodeTypeDef } from '../types';

export const StepNode: NodeTypeDef = {
  type: 'step',
  label: 'Generation Step',
  description: 'Entry point that runs once per cell each generation. Root of the main update flow.',
  category: 'event',
  color: '#ffffff',
  ports: [
    { id: 'do', label: 'DO', kind: 'output', category: 'flow' },
  ],
  defaultConfig: {},
  compile: () => '',  // Step is the root — compiler handles it specially
};

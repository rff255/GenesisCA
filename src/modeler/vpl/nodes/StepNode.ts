import type { NodeTypeDef } from '../types';

export const StepNode: NodeTypeDef = {
  type: 'step',
  label: 'Generation Step',
  category: 'event',
  color: '#ffffff',
  ports: [
    { id: 'do', label: 'DO', kind: 'output', category: 'flow' },
  ],
  defaultConfig: {},
  compile: () => '',  // Step is the root — compiler handles it specially
};

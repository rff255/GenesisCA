import type { NodeTypeDef } from '../types';

export const StepNode: NodeTypeDef = {
  type: 'step',
  label: 'Step',
  category: 'flow',
  color: '#1b5e20',
  ports: [
    { id: 'do', label: 'DO', kind: 'output', category: 'flow' },
  ],
  defaultConfig: {},
  compile: () => '',  // Step is the root — compiler handles it specially
};

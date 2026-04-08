import type { NodeTypeDef } from '../types';

export const LoopNode: NodeTypeDef = {
  type: 'loop',
  label: 'Loop',
  category: 'flow',
  color: '#1b5e20',
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'count', label: 'Count', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '1' },
    { id: 'body', label: 'BODY', kind: 'output', category: 'flow' },
  ],
  defaultConfig: {},
  compile: () => '', // Compiler handles flow nodes specially
};

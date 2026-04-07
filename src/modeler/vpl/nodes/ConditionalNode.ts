import type { NodeTypeDef } from '../types';

export const ConditionalNode: NodeTypeDef = {
  type: 'conditional',
  label: 'If / Then / Else',
  category: 'flow',
  color: '#1b5e20',
  ports: [
    { id: 'check', label: 'CHECK', kind: 'input', category: 'flow' },
    { id: 'condition', label: 'IF', kind: 'input', category: 'value', dataType: 'bool' },
    { id: 'then', label: 'THEN', kind: 'output', category: 'flow' },
    { id: 'else', label: 'ELSE', kind: 'output', category: 'flow' },
  ],
  defaultConfig: {},
  compile: () => '',  // Compiler handles control flow nodes specially
};

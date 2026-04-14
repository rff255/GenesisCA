import type { NodeTypeDef } from '../types';

export const InputColorNode: NodeTypeDef = {
  type: 'inputColor',
  label: 'Input Mapping (C\u2192A)',
  description: 'Entry point for a color-to-attribute mapping. Fires when the user paints a cell.',
  category: 'event',
  color: '#ffffff',
  ports: [
    { id: 'do', label: 'DO', kind: 'output', category: 'flow' },
    { id: 'r', label: 'R', kind: 'output', category: 'value', dataType: 'integer' },
    { id: 'g', label: 'G', kind: 'output', category: 'value', dataType: 'integer' },
    { id: 'b', label: 'B', kind: 'output', category: 'value', dataType: 'integer' },
  ],
  defaultConfig: { mappingId: '' },
  compile: () => '', // Root node — compiler handles it specially
};

import type { NodeTypeDef } from '../types';

export const OutputMappingNode: NodeTypeDef = {
  type: 'outputMapping',
  label: 'Output Mapping (A\u2192C)',
  description: 'Entry point for an attribute-to-color mapping. Runs after the generation step to paint the viewer.',
  category: 'event',
  color: '#ffffff',
  ports: [
    { id: 'do', label: 'DO', kind: 'output', category: 'flow' },
  ],
  defaultConfig: { mappingId: '' },
  compile: () => '', // Root node — compiler handles it specially
};

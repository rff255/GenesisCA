import type { NodeTypeDef } from '../types';

export const OutputMappingNode: NodeTypeDef = {
  type: 'outputMapping',
  label: 'Output Mapping (A\u2192C)',
  category: 'event',
  color: '#ffffff',
  ports: [
    { id: 'do', label: 'DO', kind: 'output', category: 'flow' },
  ],
  defaultConfig: { mappingId: '' },
  compile: () => '', // Root node — compiler handles it specially
};

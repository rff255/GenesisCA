import type { NodeTypeDef } from '../types';

export const InputColorNode: NodeTypeDef = {
  type: 'inputColor',
  label: 'Input Mapping (C\u2192A)',
  description: 'Entry point for a color-to-attribute mapping. Fires when the user paints a cell.',
  category: 'event',
  color: '#ffffff',
  // Value outputs are DYNAMIC — one per resolved channel of the referenced
  // mapping's declared `parameters` (`buildInputParamPorts` in
  // src/model/inputMappingParams.ts, consumed by BOTH CaNode and
  // effectivePorts). A mapping with no declared parameters resolves to the
  // LEGACY colour parameter, whose channel ports are exactly R/G/B — so every
  // existing model's wires and emitted code are unchanged.
  ports: [
    { id: 'do', label: 'DO', kind: 'output', category: 'flow' },
  ],
  defaultConfig: { mappingId: '' },
  compile: () => '', // Root node — compiler handles it specially
};

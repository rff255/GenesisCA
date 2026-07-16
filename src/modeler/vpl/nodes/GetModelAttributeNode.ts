import type { NodeTypeDef } from '../types';

export const GetModelAttributeNode: NodeTypeDef = {
  type: 'getModelAttribute',
  label: 'Get Model Attribute',
  description: 'Reads a global (model-level) attribute. All cells see the same value. Extra attribute slots (+ Attribute) read several model attributes through per-slot output ports.',
  category: 'data',
  color: '#b71c1c',
  ports: [
    { id: 'value', label: 'Value', kind: 'output', category: 'value', dataType: 'any' },
    { id: 'r', label: 'R', kind: 'output', category: 'value', dataType: 'integer' },
    { id: 'g', label: 'G', kind: 'output', category: 'value', dataType: 'integer' },
    { id: 'b', label: 'B', kind: 'output', category: 'value', dataType: 'integer' },
    { id: 'a', label: 'A', kind: 'output', category: 'value', dataType: 'integer' },
  ],
  defaultConfig: { attributeId: '', isColorAttr: false },
  // Color attributes expose R/G/B/A; everything else exposes the single Value.
  // Unlike the palette nodes (Colour Scale / Categorical Color / Colour Constant),
  // alpha here is NOT gated on being "declared": a colour model attribute always
  // occupies four slots (`modelAttrSlotKeys`), so `_a` always exists and always
  // holds a real value (255 for a `#rrggbb` default).
  hiddenPorts: (config) => config.isColorAttr ? ['value'] : ['r', 'g', 'b', 'a'],
  compile: (nodeId, config) => {
    const attr = config.attributeId as string || 'undefined';
    if (config.isColorAttr) {
      return ['r', 'g', 'b', 'a']
        .map(ch => `const _v${nodeId}_${ch} = modelAttrs[${JSON.stringify(attr + '_' + ch)}];`)
        .join('\n') + '\n';
    }
    return `const _v${nodeId} = modelAttrs[${JSON.stringify(attr)}];\n`;
  },
};

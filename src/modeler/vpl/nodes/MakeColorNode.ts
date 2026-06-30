import type { NodeTypeDef } from '../types';

/** Make Color — bundle R / G / B / A channels into a single `color` value (the
 *  Unreal "Make Color" / Blender "Combine Color" node). Carried as a
 *  `[r, g, b, a]` array (0–255 channels; A defaults to 255 / opaque). Feed the
 *  result to a colour-accepting port (e.g. Set Cell Looks' Colour input) instead
 *  of threading R / G / B separately. JS compile target only. */
export const MakeColorNode: NodeTypeDef = {
  type: 'makeColor',
  label: 'Make Color',
  description: 'Bundle R / G / B / A channels into a single colour value.',
  category: 'color',
  color: '#c2185b',
  ports: [
    { id: 'r', label: 'R', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0' },
    { id: 'g', label: 'G', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0' },
    { id: 'b', label: 'B', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0' },
    { id: 'a', label: 'A', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '255' },
    { id: 'color', label: 'Color', kind: 'output', category: 'value', dataType: 'color' },
  ],
  defaultConfig: {},
  compile: (nodeId, _config, inputs) =>
    `const _v${nodeId} = [${inputs['r'] || '0'}, ${inputs['g'] || '0'}, ${inputs['b'] || '0'}, ${inputs['a'] || '255'}];\n`,
};

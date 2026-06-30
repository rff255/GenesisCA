import type { NodeTypeDef } from '../types';

/** Break Color — split a `color` value back into its R / G / B / A channels (the
 *  Unreal "Break Color" / Blender "Separate Color" node). Multi-output
 *  (`_v<id>_<port>`). JS compile target only. */
export const BreakColorNode: NodeTypeDef = {
  type: 'breakColor',
  label: 'Break Color',
  description: 'Split a colour value back into its R / G / B / A channels.',
  category: 'color',
  color: '#c2185b',
  ports: [
    { id: 'color', label: 'Color', kind: 'input', category: 'value', dataType: 'color' },
    { id: 'r', label: 'R', kind: 'output', category: 'value', dataType: 'float' },
    { id: 'g', label: 'G', kind: 'output', category: 'value', dataType: 'float' },
    { id: 'b', label: 'B', kind: 'output', category: 'value', dataType: 'float' },
    { id: 'a', label: 'A', kind: 'output', category: 'value', dataType: 'float' },
  ],
  defaultConfig: {},
  compile: (nodeId, _config, inputs) => {
    const c = inputs['color'] || '[0,0,0,255]';
    return `const __bc${nodeId} = ${c}; const _v${nodeId}_r = (__bc${nodeId})[0]; const _v${nodeId}_g = (__bc${nodeId})[1]; const _v${nodeId}_b = (__bc${nodeId})[2]; const _v${nodeId}_a = (__bc${nodeId})[3] === undefined ? 255 : (__bc${nodeId})[3];\n`;
  },
};

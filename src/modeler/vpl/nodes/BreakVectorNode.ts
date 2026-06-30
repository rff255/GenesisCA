import type { NodeTypeDef } from '../types';
import { is3dModelLike } from '../compiler/niCodec';

/** Break Vector — split a `vector` value back into its X / Y (/ Z) scalar
 *  components (the Unreal "Break Vector" / Blender "Separate XYZ" node).
 *  Multi-output (`_v<id>_<port>`). The Z output exists only in a 3D model. JS
 *  compile target only. */
export const BreakVectorNode: NodeTypeDef = {
  type: 'breakVector',
  label: 'Break Vector',
  description: 'Split a vector value back into its X / Y / Z scalar components.',
  category: 'data',
  color: '#00838f',
  ports: [
    { id: 'vector', label: 'Vector', kind: 'input', category: 'value', dataType: 'vector' },
    { id: 'x', label: 'X', kind: 'output', category: 'value', dataType: 'float' },
    { id: 'y', label: 'Y', kind: 'output', category: 'value', dataType: 'float' },
    { id: 'z', label: 'Z', kind: 'output', category: 'value', dataType: 'float' },
  ],
  hiddenPorts: (_config, model) => (is3dModelLike(model) ? [] : ['z']),
  defaultConfig: {},
  compile: (nodeId, _config, inputs, _boundary, ctx) => {
    const v = inputs['vector'] || '[0,0,0]';
    const z = ctx?.is3d ? ` const _v${nodeId}_z = (__bv${nodeId})[2];` : '';
    return `const __bv${nodeId} = ${v}; const _v${nodeId}_x = (__bv${nodeId})[0]; const _v${nodeId}_y = (__bv${nodeId})[1];${z}\n`;
  },
};

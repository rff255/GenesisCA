import type { NodeTypeDef } from '../types';
import { is3dModelLike } from '../compiler/niCodec';

/** Make Vector — bundle X / Y (/ Z) scalars into a single `vector` value (the
 *  Unreal "Make Vector" / Blender "Combine XYZ" node). Carried as a `[x, y, z]`
 *  array (z = 0 in a 2D model — the Z input is hidden there). Feed the result to
 *  Vector Op (add / scale / dot / …) or any vector-accepting port, instead of
 *  threading each component separately. JS compile target only. */
export const MakeVectorNode: NodeTypeDef = {
  type: 'makeVector',
  label: 'Make Vector',
  description: 'Bundle X / Y / Z scalars into a single vector value.',
  category: 'data',
  color: '#00838f',
  ports: [
    { id: 'x', label: 'X', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0' },
    { id: 'y', label: 'Y', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0' },
    { id: 'z', label: 'Z', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0' },
    { id: 'vector', label: 'Vector', kind: 'output', category: 'value', dataType: 'vector' },
  ],
  hiddenPorts: (_config, model) => (is3dModelLike(model) ? [] : ['z']),
  defaultConfig: {},
  compile: (nodeId, _config, inputs, _boundary, ctx) => {
    const z = ctx?.is3d ? (inputs['z'] || '0') : '0';
    return `const _v${nodeId} = [${inputs['x'] || '0'}, ${inputs['y'] || '0'}, ${z}];\n`;
  },
};

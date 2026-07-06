import type { NodeTypeDef } from '../types';

/** Init Event — per-cell initialisation entry point.
 *
 *  Runs once per cell on simulator Reset, AFTER default attribute values have
 *  been applied and BEFORE the first color pass. Does NOT run when loading a
 *  saved state (the saved state already encodes post-init values).
 *
 *  Singleton (one per model, like Step). Value outputs are emitted by the
 *  compiler as part of the per-cell loop preamble — `x`/`y` are 0-based cell
 *  coordinates, `maxX`/`maxY` are `W-1`/`H-1`. Use them with SetAttribute /
 *  SetOrientation to build procedural initial state (gradients, random
 *  orientations, ID-encoded debug values, deterministic noise, etc.).
 *
 *  3D Grid CA: `z`/`maxZ` are the layer coordinate (0-based) and `D-1`. They are
 *  only meaningful in 3D models; in 2D the compiler emits no `_z`/`_maxZ`
 *  decode, so wiring them in a 2D model reads as undefined (the port is hidden
 *  via `hiddenPorts` to prevent that). */
export const InitEventNode: NodeTypeDef = {
  type: 'initEvent',
  label: 'Init Event',
  description: 'Entry point that runs once per cell on simulator Reset, after defaults are applied. Outputs the cell coordinates and grid bounds; trigger downstream initialization via DO.',
  category: 'event',
  color: '#ffffff',
  ports: [
    { id: 'do', label: 'DO', kind: 'output', category: 'flow' },
    { id: 'x', label: 'x', kind: 'output', category: 'value', dataType: 'integer' },
    { id: 'y', label: 'y', kind: 'output', category: 'value', dataType: 'integer' },
    { id: 'z', label: 'z', kind: 'output', category: 'value', dataType: 'integer' },
    { id: 'maxX', label: 'maxX', kind: 'output', category: 'value', dataType: 'integer' },
    { id: 'maxY', label: 'maxY', kind: 'output', category: 'value', dataType: 'integer' },
    { id: 'maxZ', label: 'maxZ', kind: 'output', category: 'value', dataType: 'integer' },
  ],
  // 3D Grid CA: the z / maxZ ports only exist in a 3D model. Hidden in 2D
  // (the compiler emits no _z/_maxZ decode there, so a wired port would be
  // undefined). The hook receives the live model via the config-less signature,
  // so dimension is read from the second arg.
  hiddenPorts: (_config, model) =>
    (model?.properties?.dimension === '3d' && (model?.properties?.gridDepth ?? 1) > 1)
      ? []
      : ['z', 'maxZ'],
  defaultConfig: {},
  compile: () => '', // Root node — compiler emits the per-cell preamble for the value outputs.
};

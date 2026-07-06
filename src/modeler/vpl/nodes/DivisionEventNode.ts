import type { NodeTypeDef } from '../types';
import { is3dModelLike } from '../compiler/niCodec';

/** Division Event — the per-daughter assignment entry point (Bond-Graph Agents).
 *  Runs ONCE for each of the two daughters right after a division, so the user
 *  can give the daughters DIFFERENT attribute values (asymmetric inheritance) —
 *  e.g. "daughter 0 keeps 70% of Q, daughter 1 keeps 30%". Both daughters start
 *  with the mother's attributes verbatim, so a Get Cell Attribute inside this
 *  event reads the inherited (mother's) value; Set Attribute overwrites it.
 *
 *  Outputs: `daughterIndex` (0 = the reused mother slot, 1 = the new slot),
 *  `axisDefaultX`/`axisDefaultY` (the engine's chosen division axis), `myArea`
 *  (this daughter's area). Singleton (one per Agents graph, like Behaviour Step). */
export const DivisionEventNode: NodeTypeDef = {
  type: 'divisionEvent',
  label: 'Division Event',
  description: 'Runs once per daughter after a division, to assign daughter attributes (asymmetric inheritance).',
  category: 'event',
  // Event roots are white (the CA-grid standard: Step / Init / Output Mapping).
  color: '#ffffff',
  requirements: { bondGraph: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'output', category: 'flow' },
    { id: 'daughterIndex', label: 'Daughter #', kind: 'output', category: 'value', dataType: 'integer' },
    { id: 'axisDefaultX', label: 'Axis X', kind: 'output', category: 'value', dataType: 'float' },
    { id: 'axisDefaultY', label: 'Axis Y', kind: 'output', category: 'value', dataType: 'float' },
    { id: 'axisDefaultZ', label: 'Axis Z', kind: 'output', category: 'value', dataType: 'float' },
    { id: 'myArea', label: 'Area', kind: 'output', category: 'value', dataType: 'float' },
  ],
  // axisDefaultZ only exists in a 3D-agent model. Unlike axisDefaultX/Y (scalar
  // division-fn params), it is NOT a param — the compiler emits its
  // `_v<id>_axisDefaultZ` preamble by reading the `_divideAxisZ[idx]` buffer
  // (compile.ts ~:2207), gated on `is3d`.
  hiddenPorts: (_config, model) => (is3dModelLike(model) ? [] : ['axisDefaultZ']),
  defaultConfig: {},
  compile: () => '', // Root — the agent compiler emits the single-agent division function.
};

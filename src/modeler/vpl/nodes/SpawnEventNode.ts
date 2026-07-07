import type { NodeTypeDef } from '../types';
import { is3dModelLike } from '../compiler/niCodec';

/** Spawn Event — the per-spawned-agent init entry point (Population·Birth). Runs
 *  ONCE for each agent born via Spawn Agent, right after it is allocated in the
 *  structural phase — the birth analogue of the Division Event (per daughter) and
 *  the Agent Init Event (per init-time agent). Set the child's attributes here as
 *  a function of where it was born (`myX`/`myY`/`myRadius`) or who spawned it
 *  (`parentHandle` + `parentX`/`parentY`).
 *
 *  The child already carries the parent's inherited attributes (unless Spawn
 *  Agent's Inherit was off), so a Get (Self) Attribute reads the inherited value;
 *  Set (Self) Attribute overwrites it. Optional — with no Spawn Event root the
 *  child simply keeps its inherited / default attributes. Singleton (one per
 *  Agents graph, like Behaviour Step / Division Event). */
export const SpawnEventNode: NodeTypeDef = {
  type: 'spawnEvent',
  label: 'Spawn Event',
  description: 'Runs once per newly-spawned agent, to assign the child’s attributes (from where it was born / who spawned it).',
  category: 'event',
  // Event roots are white (the CA-grid standard: Step / Init / Output Mapping).
  color: '#ffffff',
  requirements: { bondGraph: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'output', category: 'flow' },
    { id: 'myX', label: 'My X', kind: 'output', category: 'value', dataType: 'float' },
    { id: 'myY', label: 'My Y', kind: 'output', category: 'value', dataType: 'float' },
    { id: 'myZ', label: 'My Z', kind: 'output', category: 'value', dataType: 'float' },
    { id: 'myRadius', label: 'My Radius', kind: 'output', category: 'value', dataType: 'float' },
    { id: 'parentHandle', label: 'Parent', kind: 'output', category: 'value', dataType: 'integer' },
    { id: 'parentX', label: 'Parent X', kind: 'output', category: 'value', dataType: 'float' },
    { id: 'parentY', label: 'Parent Y', kind: 'output', category: 'value', dataType: 'float' },
    { id: 'parentZ', label: 'Parent Z', kind: 'output', category: 'value', dataType: 'float' },
  ],
  // myZ / parentZ only exist in a 3D-agent model. Like Division Event's
  // axisDefaultZ, they are NOT params — the compiler emits their `_v<id>_*Z`
  // preamble by reading `_agentZ[idx]` / `_agentZ[__parentHandle]`, gated on is3d.
  hiddenPorts: (_config, model) => (is3dModelLike(model) ? [] : ['myZ', 'parentZ']),
  defaultConfig: {},
  compile: () => '', // Root — the agent compiler emits the single-agent spawn function.
};

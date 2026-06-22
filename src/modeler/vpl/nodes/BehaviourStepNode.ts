import type { NodeTypeDef } from '../types';
import { is3dModelLike } from '../compiler/niCodec';

/** Behaviour Step — the agent-world per-agent update entry point (Bond-Graph
 *  Agents). The agent analogue of the lattice `Generation Step`: the compiler
 *  loops `idx < highWater` over the agent SoA (skipping dead slots) and runs the
 *  DO flow chain once per live agent each generation. The agent loop variable is
 *  `idx` (Decision D-IDX) so every attribute-read node (`Get Cell Attribute`,
 *  …) lands on the agent SoA with no node change.
 *
 *  Singleton (one per Agents graph, like Step). Value outputs expose the agent's
 *  own geometry/identity — `myX`/`myY`(/`myZ`)/`myRadius`/`myArea`/`myBondDegree`/
 *  `myAge`/`myType`. (`myZ` is hidden in 2D models via `hiddenPorts`, like the
 *  Init Event's `z`.)
 *
 *  Requirements: `bondGraph` — available only in an Agents-topology model, on
 *  the Agents sub-tab.
 *
 *  NOTE: the value-output ports + the compiler's per-agent loop emit land in
 *  PR-A3. This file ships the bare singleton (just the DO flow output) so the
 *  palette / harness can see the root before the engine exists. */
export const BehaviourStepNode: NodeTypeDef = {
  type: 'behaviourStep',
  label: 'Behaviour Step',
  description: 'Agent entry point that runs once per agent each generation. Root of the Bond-Graph Agents update flow. Outputs the agent’s own geometry/identity.',
  category: 'event',
  color: '#7e57c2',
  requirements: { bondGraph: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'output', category: 'flow' },
    { id: 'myX', label: 'X', kind: 'output', category: 'value', dataType: 'float' },
    { id: 'myY', label: 'Y', kind: 'output', category: 'value', dataType: 'float' },
    { id: 'myZ', label: 'Z', kind: 'output', category: 'value', dataType: 'float' },
    { id: 'myRadius', label: 'Radius', kind: 'output', category: 'value', dataType: 'float' },
    { id: 'myArea', label: 'Area', kind: 'output', category: 'value', dataType: 'float' },
    { id: 'myBondDegree', label: 'Bond Degree', kind: 'output', category: 'value', dataType: 'integer' },
    { id: 'myAge', label: 'Age', kind: 'output', category: 'value', dataType: 'integer' },
    { id: 'myType', label: 'Type', kind: 'output', category: 'value', dataType: 'integer' },
  ],
  // myZ only exists in a 3D-agent model. Hidden in 2D (the compiler emits no
  // _agentZ decode / `_v<id>_myZ` preamble there — that emit is compile-side in
  // compileAgentGraph, since this node's compile is () => '').
  hiddenPorts: (_config, model) => (is3dModelLike(model) ? [] : ['myZ']),
  defaultConfig: {},
  compile: () => '',  // Root — the agent compiler emits the per-agent loop specially.
};

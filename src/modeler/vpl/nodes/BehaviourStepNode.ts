import type { NodeTypeDef } from '../types';
import { is3dModelLike } from '../compiler/niCodec';
import { resolveAgentProfile } from '../../../model/agentCapabilities';

/** Behaviour Step — the agent-world per-agent update entry point (Bond-Graph
 *  Agents). The agent analogue of the lattice `Generation Step`: the compiler
 *  loops `idx < highWater` over the agent SoA (skipping dead slots) and runs the
 *  DO flow chain once per live agent each generation. The agent loop variable is
 *  `idx` (Decision D-IDX) so every attribute-read node (`Get Cell Attribute`,
 *  …) lands on the agent SoA with no node change.
 *
 *  Singleton (one per Agents graph, like Step). Value outputs expose the agent's
 *  own geometry — `myX`/`myY`(/`myZ`)/`myRadius`/`myArea`(/`myVolume`)/
 *  `myBondDegree`/`myAge`. (`myZ` + `myVolume` are hidden in 2D models via
 *  `hiddenPorts`, like the Init Event's `z`.)
 *
 *  `Area` is the agent's EXTENT in the model's own dimension: the DISC area πr²
 *  in 2D, the SPHERE SURFACE area 4πr² in 3D. For the enclosed 3D quantity use
 *  `Volume` = (4/3)πr³.
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
  // Event roots are white (the CA-grid standard: Step / Init / Output Mapping).
  color: '#ffffff',
  requirements: { bondGraph: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'output', category: 'flow' },
    { id: 'myX', label: 'X', kind: 'output', category: 'value', dataType: 'float' },
    { id: 'myY', label: 'Y', kind: 'output', category: 'value', dataType: 'float' },
    { id: 'myZ', label: 'Z', kind: 'output', category: 'value', dataType: 'float' },
    { id: 'myRadius', label: 'Radius', kind: 'output', category: 'value', dataType: 'float' },
    { id: 'myArea', label: 'Area', kind: 'output', category: 'value', dataType: 'float' },
    { id: 'myVolume', label: 'Volume', kind: 'output', category: 'value', dataType: 'float' },
    { id: 'myBondDegree', label: 'Bond Degree', kind: 'output', category: 'value', dataType: 'integer' },
    { id: 'myAge', label: 'Age', kind: 'output', category: 'value', dataType: 'integer' },
  ],
  // Ports gate on the model's dimension AND its Agent Capability Profile:
  //   - myZ exists only in a 3D-agent model (the compiler emits no _agentZ decode
  //     / `_v<id>_myZ` preamble in 2D — that emit is compile-side).
  //   - myRadius/myArea (Body), myBondDegree (Bonds), myAge (Lifespan) are hidden
  //     when their capability is off (UI-only — the compiler still emits the
  //     preamble, so an existing wire keeps working; the badge is informational).
  hiddenPorts: (_config, model) => {
    const hidden: string[] = [];
    // `myVolume` is (4/3)πr³ — a 3D quantity, so it exists only in a 3D world.
    // (`myArea` exists in BOTH dimensions, but MEANS the dimension's own extent:
    // πr² disc in 2D, 4πr² sphere surface in 3D — see the compiler's areaExpr.)
    if (!is3dModelLike(model)) hidden.push('myZ', 'myVolume');
    if (model?.topologyMode?.agents) {
      const p = resolveAgentProfile(model);
      if (!p.body) hidden.push('myRadius', 'myArea', 'myVolume');
      if (p.bonds === 'off') hidden.push('myBondDegree');
      if (!p.lifespan) hidden.push('myAge');
    }
    return hidden;
  },
  defaultConfig: {},
  compile: () => '',  // Root — the agent compiler emits the per-agent loop specially.
};

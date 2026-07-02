import type { NodeTypeDef } from '../types';
import { is3dModelLike } from '../compiler/niCodec';

/** Agent Init Event — a once-per-Reset setup root for the Agents graph (Generic
 *  Agent Platform). Unlike the cell Init Event (which runs per lattice cell),
 *  agents have no fixed lattice, so this runs EXACTLY ONCE: the user wires a Loop
 *  (or For Each In Array) inside the DO chain and spawns the initial population
 *  with Create Agent → (Set Agent Attribute / Position / Radius) → Add
 *  Agent To World. Composes additively with the config `seedCount` (that baseline
 *  is laid first; the Init Event may spawn more — set seedCount=0 for pure
 *  graph-authored seeding). Value-outs expose the world bounds + the seed index
 *  base (highWater before the Init Event ran). JS-only this milestone.
 *
 *  compile() returns '' — the compiler emits the once-only setup function (it is
 *  NOT loop-wrapped and has NO per-agent `idx`). */
export const AgentInitNode: NodeTypeDef = {
  type: 'agentInit',
  label: 'Agent Init Event',
  description: 'Runs once per Reset — loop here + Create Agent / Add Agent To World to seed the initial agent population.',
  category: 'event',
  color: '#ad1457',
  requirements: { bondGraph: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'output', category: 'flow' },
    { id: 'worldWidth', label: 'World Width', kind: 'output', category: 'value', dataType: 'float' },
    { id: 'worldHeight', label: 'World Height', kind: 'output', category: 'value', dataType: 'float' },
    { id: 'worldDepth', label: 'World Depth', kind: 'output', category: 'value', dataType: 'float' },
    { id: 'seedIndexBase', label: 'Seed Index Base', kind: 'output', category: 'value', dataType: 'integer' },
  ],
  // World Depth exists only in a 3D-agent model (hidden in 2D).
  hiddenPorts: (_config, model) => (is3dModelLike(model) ? [] : ['worldDepth']),
  defaultConfig: {},
  compile: () => '',  // compiler emits the once-only setup function
};

import type { NodeTypeDef } from '../types';
import { is3dModelLike } from '../compiler/niCodec';

/** Create Agent — allocate a new agent at a position (Generic Agent Platform).
 *  Phase 1 of the two-phase spawn: returns a `handle` (the new agent's id, or -1
 *  on overflow) so you can set its attributes (Set Agent Attribute / Position /
 *  Radius / your own agent attributes by the handle) BEFORE committing it with
 *  Add Agent To World.
 *
 *  v1 is INIT-ONLY: place it inside the Agent Init Event's DO chain (typically a
 *  Loop). The compiler declares `const _v<id>_handle = _agentCreate(x, y, radius)`
 *  at the Create Agent's flow position (compileFlowChain special-case); the
 *  `_agentCreate` host closure allocs a slot, inits it (STAGED, alive=0), and
 *  returns the id. compile() returns '' (the handle is emitted in compileFlowChain). */
export const CreateAgentNode: NodeTypeDef = {
  type: 'createAgent',
  label: 'Create Agent',
  description: 'Allocate a staged agent (in the Agent Init Event) and return its handle — set its attributes, then Add Agent To World.',
  category: 'output',
  color: '#4527a0',
  requirements: { bondGraph: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'next', label: 'NEXT', kind: 'output', category: 'flow' },
    { id: 'x', label: 'X', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0' },
    { id: 'y', label: 'Y', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0' },
    { id: 'z', label: 'Z', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0' },
    { id: 'radius', label: 'Radius', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '1' },
    { id: 'handle', label: 'Handle', kind: 'output', category: 'value', dataType: 'integer' },
  ],
  // The Z input exists only in a 3D-agent model (hidden in 2D).
  hiddenPorts: (_config, model) => (is3dModelLike(model) ? [] : ['z']),
  defaultConfig: {},
  compile: () => '',  // the handle is declared in compileFlowChain (createAgent special-case)
};

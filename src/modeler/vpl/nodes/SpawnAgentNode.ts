import type { NodeTypeDef } from '../types';
import { is3dModelLike } from '../compiler/niCodec';

/** Spawn Agent — request a NEW agent be born at a position, mid-step
 *  (Population·Birth). The behaviour-graph analogue of the INIT-time Create Agent
 *  + Add Agent To World: place it in the Behaviour Step's DO chain and it emits a
 *  per-agent SPAWN REQUEST (`_spawnRequest[idx]`) — nothing is allocated at emit
 *  time. The post-step CPU STRUCTURAL PHASE reads the request and allocates the
 *  agent (free-list first, else grow, else reject on overflow — like Divide
 *  Agent), so spawning works under the parallel WASM / WebGPU targets too.
 *
 *  One spawn per agent per step (v1) — the request is a single flag. The child
 *  inherits the parent's attributes by default (like a division daughter); set
 *  `inheritAttributes: false` for attribute defaults. A `Spawn Event` root (if
 *  present) runs once per new child to reassign its attributes.
 *
 *  `inheritAttributes` is baked into the request VALUE (1 = inherit, 2 =
 *  defaults) so the structural phase knows the mode per-node without a global
 *  flag — mirrors how Divide Agent carries its axis in the request buffers. */
export const SpawnAgentNode: NodeTypeDef = {
  type: 'spawnAgent',
  label: 'Spawn Agent',
  description: 'Request a new agent be born at a position this step (applied after the step). Inherits the parent’s attributes by default; a Spawn Event can reassign them.',
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
  ],
  // The Z input exists only in a 3D-agent model (hidden in 2D).
  hiddenPorts: (_config, model) => (is3dModelLike(model) ? [] : ['z']),
  defaultConfig: { inheritAttributes: true },
  compile: (_nodeId, config, inputs, _boundary, ctx) => {
    const flag = config.inheritAttributes === false ? '2' : '1';
    const x = inputs['x'] || '0';
    const y = inputs['y'] || '0';
    const radius = inputs['radius'] || '1';
    const z = ctx?.is3d ? ` _spawnZ[idx] = ${inputs['z'] || '0'};` : '';
    return `_spawnRequest[idx] = ${flag}; _spawnX[idx] = ${x}; _spawnY[idx] = ${y};${z} _spawnRadius[idx] = ${radius};\n`;
  },
};

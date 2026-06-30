import type { NodeTypeDef } from '../types';
import { is3dModelLike } from '../compiler/niCodec';

/** Apply Force — add a force vector to this agent this step (Bond-Graph Agents).
 *  This is how the graph AUTHORS the physics: the engine integrates the sum of
 *  all Apply Force contributions (plus its built-in soft-sphere repulsion + bond
 *  springs, when "Use bonding physics" is enabled in Properties). Build flocking
 *  (separation/alignment/cohesion), chemotaxis (force up a Field Gradient),
 *  charged-particle Coulomb forces, self-propulsion, etc. With momentum > 0 the
 *  force changes velocity (inertia); with momentum 0 it directly displaces
 *  (overdamped). NOT async-only. The `Force Z` input exists only in a 3D-agent
 *  model (hidden in 2D). */
export const ApplyForceNode: NodeTypeDef = {
  type: 'applyForce',
  label: 'Apply Force',
  description: 'Add a force vector to the agent (the engine integrates it) — the graph-authored physics: flocking, chemotaxis, propulsion.',
  category: 'output',
  color: '#5e35b1',
  requirements: { bondGraph: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'next', label: 'NEXT', kind: 'output', category: 'flow' },
    // Vector mode (config.vectorInput): feed a single force vector (e.g. straight
    // from Vector Op) instead of the three components. A vector source is a
    // JS-only producer (Make Vector / Vector Op), so wiring it clamps the agent
    // graph to JS — the WASM/WebGPU emitters only ever see component mode.
    { id: 'force', label: 'Force', kind: 'input', category: 'value', dataType: 'vector' },
    { id: 'fx', label: 'Force X', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0' },
    { id: 'fy', label: 'Force Y', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0' },
    { id: 'fz', label: 'Force Z', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0' },
  ],
  hiddenPorts: (config, model) => {
    if (config.vectorInput) return is3dModelLike(model) ? ['fx', 'fy', 'fz'] : ['fx', 'fy', 'fz'];
    return is3dModelLike(model) ? ['force'] : ['force', 'fz'];
  },
  defaultConfig: {},
  compile: (_nodeId, config, inputs, _boundary, ctx) => {
    if (config.vectorInput) {
      const f = inputs['force'] || '[0,0,0]';
      const z = ctx?.is3d ? ` _agentForceZ[idx] += (__f)[2];` : '';
      return `{ const __f = ${f}; _agentForceX[idx] += (__f)[0]; _agentForceY[idx] += (__f)[1];${z} }\n`;
    }
    const z = ctx?.is3d ? ` _agentForceZ[idx] += ${inputs['fz'] || '0'};` : '';
    return `_agentForceX[idx] += ${inputs['fx'] || '0'}; _agentForceY[idx] += ${inputs['fy'] || '0'};${z}\n`;
  },
};

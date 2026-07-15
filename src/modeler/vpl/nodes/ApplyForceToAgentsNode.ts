import type { NodeTypeDef } from '../types';
import { is3dModelLike } from '../compiler/niCodec';

/** Apply Force To Agents — add the SAME force vector to EVERY agent in an id array
 *  (the broadcast sibling of Apply Force To Agent). Feed the `Agents` array from
 *  Get Nearby Agents / Get Bonded Agents / Filter Agents to push a whole sensed
 *  group at once. Like the single node it is a COMMUTATIVE accumulate (`+=`), so
 *  it's race-free in both agent update modes.
 *
 *  Pure editor sugar: a shared pre-compile pass ([forceToAgentsExpand.ts](../compiler/forceToAgentsExpand.ts))
 *  lowers it to `For Each In Array → Apply Force To Agent` BEFORE any target
 *  compiles, so it reuses the single node's JS / WASM / WebGPU emitters entirely
 *  (no new per-target code) and runs on all three targets by construction.
 *  `Force Z` exists only in a 3D-agent model (hidden in 2D). */
export const ApplyForceToAgentsNode: NodeTypeDef = {
  type: 'applyForceToAgents',
  label: 'Apply Force To Agents',
  description: 'Add the same force vector to every agent in an id array (broadcast — commutative, safe in both update modes).',
  category: 'output',
  color: '#5e35b1',
  requirements: { bondGraph: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'next', label: 'NEXT', kind: 'output', category: 'flow' },
    { id: 'agents', label: 'Agents', kind: 'input', category: 'value', dataType: 'integer', isArray: true },
    { id: 'fx', label: 'Force X', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0' },
    { id: 'fy', label: 'Force Y', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0' },
    { id: 'fz', label: 'Force Z', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0' },
  ],
  hiddenPorts: (_config, model) => (is3dModelLike(model) ? [] : ['fz']),
  defaultConfig: {},
  // Editor sugar — `expandForceToAgents` lowers this to For Each In Array → Apply
  // Force To Agent before any compile, so compile() is never reached. Returns ''
  // defensively (a stray un-lowered instance is then a harmless no-op).
  compile: () => '',
};

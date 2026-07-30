import type { NodeTypeDef } from '../types';
import { emitBondRequestJS } from '../compiler/bondRequestEmitJS';

/** Break Bond — request that the bond between this agent and a target agent be
 *  removed (Bond-Graph Agents). Applied in the post-step structural phase
 *  (symmetric — removed from both lists). `targetAgent` is typically ForEachBond's
 *  partner output (break a bond by condition, e.g. when over-strained). NOT
 *  async-only.
 *
 *  P4: requests are QUEUED — an agent may break several bonds in one step (depth:
 *  Model Properties → Bond-Graph Agents → Bond Requests / Agent / Step). */
export const BreakBondNode: NodeTypeDef = {
  type: 'breakBond',
  label: 'Break Bond',
  description: 'Request that the bond between this agent and a target agent be removed (after the step). Requests are queued, so an agent can break several bonds in one step.',
  category: 'output',
  color: '#00838f',
  requirements: { bondGraph: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'next', label: 'NEXT', kind: 'output', category: 'flow' },
    { id: 'targetAgent', label: 'Target', kind: 'input', category: 'value', dataType: 'integer' },
  ],
  defaultConfig: {},
  compile: (_nodeId, _config, inputs, _boundary, ctx) =>
    emitBondRequestJS('break', inputs, ctx),
};

import type { NodeTypeDef } from '../types';

/** Break Bond — request that the bond between this agent and a target agent be
 *  removed (Bond-Graph Agents). Applied in the post-step structural phase
 *  (symmetric — removed from both lists). `targetAgent` is typically ForEachBond's
 *  partner output (break a bond by condition, e.g. when over-strained). NOT
 *  async-only. */
export const BreakBondNode: NodeTypeDef = {
  type: 'breakBond',
  label: 'Break Bond',
  description: 'Request that the bond between this agent and a target agent be removed (after the step). One request per agent per step — a later call this step replaces an earlier one.',
  category: 'output',
  color: '#00838f',
  requirements: { bondGraph: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'next', label: 'NEXT', kind: 'output', category: 'flow' },
    { id: 'targetAgent', label: 'Target', kind: 'input', category: 'value', dataType: 'integer' },
  ],
  defaultConfig: {},
  compile: (_nodeId, _config, inputs) =>
    `_bondBreakReq[idx] = ((${inputs['targetAgent'] || '-1'}) | 0) + 1;\n`,
};

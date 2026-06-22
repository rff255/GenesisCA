import type { NodeTypeDef } from '../types';

/** Kill Agent — request that this agent die (Bond-Graph Agents). Applied in the
 *  post-step structural phase: the slot is recycled to the free-list, ALL its
 *  bonds (both directions) are broken, and its slot epoch is bumped so any stale
 *  bond pointing at the recycled slot is swept (the dangling-bond ABI). Use it
 *  for apoptosis / necrosis (e.g. a hypoxic agent dies). NOT async-only. */
export const KillAgentNode: NodeTypeDef = {
  type: 'killAgent',
  label: 'Kill Agent',
  description: 'Request that this agent die — recycled + all bonds broken (applied after the step).',
  category: 'output',
  color: '#ad1457',
  requirements: { bondGraph: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'next', label: 'NEXT', kind: 'output', category: 'flow' },
  ],
  defaultConfig: {},
  compile: () => `_killRequest[idx] = 1;\n`,
};

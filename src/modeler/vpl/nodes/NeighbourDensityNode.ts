import type { NodeTypeDef } from '../types';

/** Neighbour Density — the number of OTHER agents within the interaction cutoff
 *  of this agent (Bond-Graph Agents). Reads the engine reduction
 *  `_agentDensity[idx]` (recomputed each step). A FIRST-CLASS node: a true
 *  local-density measure, distinct from bond degree (a free-floating agent has
 *  density but no bonds). Drives crowding rules (divide when uncrowded, jam when
 *  packed, differential adhesion). */
export const NeighbourDensityNode: NodeTypeDef = {
  type: 'neighbourDensity',
  label: 'Neighbour Density',
  description: 'Outputs how many other agents are within interaction range (local crowding).',
  category: 'data',
  color: '#5e35b1',
  requirements: { bondGraph: true },
  ports: [
    { id: 'value', label: 'Density', kind: 'output', category: 'value', dataType: 'integer' },
  ],
  defaultConfig: {},
  // C9 SAFETY CATCH: the density field's gate INCLUDES this node, so an off gate
  // means nothing ever computes density — read the typed default.
  compile: (nodeId, _config, _inputs, _boundary, ctx) =>
    `const _v${nodeId} = ${ctx?.agentGates && !ctx.agentGates.density ? '0' : '_agentDensity[idx]'};\n`,
};

import type { NodeTypeDef } from '../types';

/** Overseer measurement — the current generation of the simulation.
 *  Re-evaluated at every flow step that consumes it. */
export const OvGetGenerationNode: NodeTypeDef = {
  type: 'ovGetGeneration',
  label: 'Get Generation',
  description: 'The simulation’s current generation number (0 right after Reset Board).',
  category: 'data',
  color: '#00838f',
  requirements: { overseer: true },
  ports: [
    { id: 'value', label: 'Generation', kind: 'output', category: 'value', dataType: 'integer' },
  ],
  defaultConfig: {},
  compile: (nodeId) => `const _v${nodeId} = O.generation();\n`,
};

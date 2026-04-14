import type { NodeTypeDef } from '../types';

/**
 * MacroOutput — boundary node inside a macro subgraph.
 * Represents the macro's external outputs. Has INPUT ports that receive data
 * from the subgraph (each port mirrors one entry in MacroDef.exposedOutputs).
 *
 * Created automatically when a macro is formed. Cannot be deleted by the user.
 * Ports are dynamic — derived from the MacroDef at render time.
 * The compiler reads MacroOutput input connections to produce the macro's
 * output variable assignments.
 */
export const MacroOutputNode: NodeTypeDef = {
  type: 'macroOutput',
  label: 'Macro Output',
  description: 'Boundary node inside a macro. Collects the sub-graph\u2019s outputs for the macro\u2019s external ports.',
  category: 'flow',
  color: '#00897b',
  ports: [], // Dynamic — derived from MacroDef.exposedOutputs at render time
  defaultConfig: { macroDefId: '' },
  compile: () => '', // Compiler handles MacroOutput specially (output assignment)
};

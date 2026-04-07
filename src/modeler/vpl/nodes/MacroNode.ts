import type { NodeTypeDef } from '../types';

/**
 * MacroNode — a compound node referencing a MacroDef.
 * Ports are dynamically generated at runtime based on the macro definition.
 * The compile() method is a placeholder — the compiler handles MacroNodes specially
 * by inlining the subgraph.
 */
export const MacroNode: NodeTypeDef = {
  type: 'macro',
  label: 'Macro',
  category: 'flow',
  color: '#7b1fa2',
  ports: [], // Dynamic — filled at runtime by CaNode based on macroDefId
  defaultConfig: { macroDefId: '' },
  compile: () => '', // Compiler handles MacroNode by inlining the subgraph
};

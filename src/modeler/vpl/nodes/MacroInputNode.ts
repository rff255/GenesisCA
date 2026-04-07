import type { NodeTypeDef } from '../types';

/**
 * MacroInput — boundary node inside a macro subgraph.
 * Represents the macro's external inputs. Has OUTPUT ports that feed data
 * into the subgraph (each port mirrors one entry in MacroDef.exposedInputs).
 *
 * Created automatically when a macro is formed. Cannot be deleted by the user.
 * Ports are dynamic — derived from the MacroDef at render time.
 * The compiler resolves MacroInput ports to the upstream variables connected
 * to the parent MacroNode's input handles.
 */
export const MacroInputNode: NodeTypeDef = {
  type: 'macroInput',
  label: 'Macro Input',
  category: 'flow',
  color: '#00897b',
  ports: [], // Dynamic — derived from MacroDef.exposedInputs at render time
  defaultConfig: { macroDefId: '' },
  compile: () => '', // Compiler handles MacroInput specially (alias resolution)
};

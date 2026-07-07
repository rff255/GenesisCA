import type { NodeTypeDef } from '../types';

/** Set Vector Variable — write a composite Vector value to a `vector` Local
 *  Variable in one node. The variable analogue of Set Vector Attribute — ideal for
 *  a vector accumulator (read → Vector Op add → write) instead of juggling separate
 *  X / Y[/ Z] float variables.
 *
 *  Has NO `compile()`: `lowerVectorAttrs` ([vectorAttr.ts](../compiler/vectorAttr.ts))
 *  rewrites it into a `breakVector` feeding a linear `setVariable` chain over the
 *  per-component ids (`do → set_vx → set_vy`[`→ set_vz`]`→ next`) before any target
 *  compiles — zero per-target emit. */
export const SetVectorVariableNode: NodeTypeDef = {
  type: 'setVectorVariable',
  label: 'Set Vector Variable',
  description: 'Writes a Vector value (x, y[, z]) to a vector Local Variable.',
  category: 'output',
  color: '#00695c',
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'next', label: 'NEXT', kind: 'output', category: 'flow' },
    { id: 'value', label: 'Vector', kind: 'input', category: 'value', dataType: 'vector' },
  ],
  defaultConfig: { variableId: '' },
  // Never reached — lowered away. Flow no-op fallback.
  compile: () => '',
};

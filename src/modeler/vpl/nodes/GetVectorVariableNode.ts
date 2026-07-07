import type { NodeTypeDef } from '../types';

/** Get Vector Variable — read a `vector` Local Variable as ONE composite Vector
 *  value. The variable analogue of Get Vector Attribute (for per-cell / per-agent
 *  transient scratch, e.g. a summed-force accumulator).
 *
 *  Has NO `compile()`: `lowerVectorAttrs` ([vectorAttr.ts](../compiler/vectorAttr.ts))
 *  rewrites it into a `makeVector` fed by per-component `getVariable` reads
 *  (`<id>_vx/_vy[/_vz]`) before any target compiles — reusing the verified
 *  `expandComposites` scalar path, zero per-target emit. */
export const GetVectorVariableNode: NodeTypeDef = {
  type: 'getVectorVariable',
  label: 'Get Vector Variable',
  description: "Reads a vector Local Variable's current value as one Vector value (x, y[, z]).",
  category: 'data',
  color: '#00897b',
  ports: [
    { id: 'value', label: 'Vector', kind: 'output', category: 'value', dataType: 'vector' },
  ],
  defaultConfig: { variableId: '' },
  // Never reached — lowered away. JS-only zero fallback for safety.
  compile: (nodeId) => `const _v${nodeId} = [0, 0, 0];\n`,
};

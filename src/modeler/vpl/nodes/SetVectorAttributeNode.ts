import type { NodeTypeDef } from '../types';

/** Set Vector Attribute — write a composite Vector value to a `vector` attribute
 *  (of the current cell / agent) in one node. Build the value with Make Vector, or
 *  wire a vector-producing node straight in.
 *
 *  Has NO `compile()`: the shared `lowerVectorAttrs` pre-compile transform
 *  ([vectorAttr.ts](../compiler/vectorAttr.ts)) rewrites it into a `breakVector`
 *  feeding a linear `setAttribute` chain over the per-component ids
 *  (`do → set_vx → set_vy`[`→ set_vz`]`→ next`) BEFORE any target compiles — so it
 *  rides the verified scalar path on JS / WASM / WebGPU (cell AND agent), zero
 *  per-target emit. The component writes are independent, so the linear order is
 *  behaviour-irrelevant; the chain just threads the flow through them all. */
export const SetVectorAttributeNode: NodeTypeDef = {
  type: 'setVectorAttribute',
  label: 'Set Vector Attribute',
  agentLabel: 'Set Self Vector',
  description: 'Writes a Vector value (x, y[, z]) to a vector attribute of the current cell.',
  agentDescription: "Writes a Vector value to one of the current agent's own vector attributes.",
  category: 'output',
  color: '#00695c',
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'next', label: 'NEXT', kind: 'output', category: 'flow' },
    { id: 'value', label: 'Vector', kind: 'input', category: 'value', dataType: 'vector' },
  ],
  defaultConfig: { attributeId: '' },
  // Never reached — `lowerVectorAttrs` removes this node before any compile. A flow
  // no-op fallback (satisfies NodeTypeDef; the DO→NEXT flow simply passes through if
  // the lowering is ever bypassed).
  compile: () => '',
};

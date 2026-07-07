import type { NodeTypeDef } from '../types';

/** Get Vector Attribute — read a `vector` attribute (of the current cell / agent)
 *  as ONE composite Vector value. Split it with Break Vector, or feed it straight
 *  into a vector-input port (e.g. a facing heading).
 *
 *  Has NO `compile()`: the shared `lowerVectorAttrs` pre-compile transform
 *  ([vectorAttr.ts](../compiler/vectorAttr.ts)) rewrites it into a `makeVector` fed
 *  by per-component `getCellAttribute` reads (`<id>_vx/_vy`[/`_vz`]) BEFORE any
 *  target compiles — so it rides the verified `expandComposites` scalar path on
 *  JS / WASM / WebGPU (cell AND agent) with zero per-target emit, exactly like the
 *  Make/Break Vector wire nodes. */
export const GetVectorAttributeNode: NodeTypeDef = {
  type: 'getVectorAttribute',
  label: 'Get Vector Attribute',
  agentLabel: 'Get Self Vector',
  description: 'Reads a vector attribute of the current cell as one Vector value (x, y[, z]).',
  agentDescription: "Reads one of the current agent's own vector attributes as one Vector value.",
  category: 'data',
  color: '#00897b',
  ports: [
    { id: 'value', label: 'Vector', kind: 'output', category: 'value', dataType: 'vector' },
  ],
  defaultConfig: { attributeId: '' },
  // Never reached — `lowerVectorAttrs` removes this node before any compile. This
  // JS-only zero-vector fallback exists only to satisfy NodeTypeDef + to fail
  // visibly (a zero direction) rather than crash if the lowering is ever bypassed.
  compile: (nodeId) => `const _v${nodeId} = [0, 0, 0];\n`,
};

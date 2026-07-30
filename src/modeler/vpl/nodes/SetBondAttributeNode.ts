import type { NodeTypeDef } from '../types';

/** Set Bond Attribute — write a BOND's user attribute (Graph-Rewriting Automata,
 *  P2). Per-EDGE state: the value belongs to the bond between this agent and
 *  `partnerId`.
 *
 *  SYMMETRIC BY CONSTRUCTION (invariant I2): a bond is ONE object stored TWICE, so
 *  the write lands in BOTH slots — this agent's and the partner's. There is no
 *  "my side" of a bond attribute; a directed quantity is expressed by storing an
 *  owner/direction VALUE (e.g. an `ownerId` integer bond attribute compared
 *  against Get Self Handle), not by writing the two sides differently.
 *
 *  No bond with that partner ⇒ a silent no-op (nothing to write to). A bond formed
 *  THIS step does not exist yet — Form Bond raises a request the structural phase
 *  applies after the step, so seed a new bond's values on the Form Bond node
 *  itself; Set Bond Attribute works from the next generation.
 *
 *  ⚠️ **ORDER-UNDEFINED ON WEBGPU WHEN BOTH ENDPOINTS WRITE THE SAME BOND IN ONE
 *  STEP** (P3, measured on real hardware). Because a bond is stored twice, this
 *  node necessarily writes a word in the PARTNER's row — and on the GPU every
 *  agent is a separate thread, so if agent i and agent p both write bond(i,p) in
 *  the same step the two stores race:
 *    · ONE writer per bond (the `ownerId` idiom — e.g. only write when
 *      `partnerId > Get Self Handle`) ⇒ exact on every target;
 *    · a SYMMETRIC rule (both endpoints computing the SAME value — the canonical
 *      SDCA link rule `λ' = ψ(λ, σᵢ, σⱼ)`) ⇒ benign, both threads write the same
 *      words, exact on every target;
 *    · an ASYMMETRIC rule (the endpoints computing DIFFERENT values) ⇒ which write
 *      lands is undefined, and the two slots can even end up disagreeing (a torn
 *      I2). The sequential CPU targets resolve it as "the higher-id endpoint wins".
 *  This is the case P2's decision D2 already rules out: a genuinely asymmetric
 *  bond attribute contradicts the symmetry invariant on EVERY target. */
export const SetBondAttributeNode: NodeTypeDef = {
  type: 'setBondAttribute',
  label: 'Set Bond Attribute',
  description: "Write a bond's attribute by partner id. Writes BOTH endpoints (bonds are symmetric). No such bond ⇒ no-op. On WebGPU, if BOTH endpoints write the same bond in one step the winner is order-undefined — write from one side, or keep the rule symmetric.",
  category: 'output',
  color: '#4527a0',
  requirements: { bondGraph: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'next', label: 'NEXT', kind: 'output', category: 'flow' },
    { id: 'partnerId', label: 'Partner', kind: 'input', category: 'value', dataType: 'integer' },
    { id: 'value', label: 'Value', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0' },
  ],
  defaultConfig: { attributeId: '' },
  compile: (_nodeId, config, inputs, _boundary, ctx) => {
    const attr = String(config.attributeId ?? '');
    const spec = ctx?.bondAttrs?.find(a => a.id === attr);
    if (!spec) return '';   // unresolved attribute → no-op (never a dangling param)
    const t = `((${inputs['partnerId'] ?? '-1'}) | 0)`;
    const v = inputs['value'] ?? '0';
    const arr = `_bondAttr_${attr}`;
    // Both sides, same value. The partner-side scan is range+alive guarded (the
    // by-id-writer discipline); the own-side scan needs no guard (idx is live).
    return `{ const __t = ${t}, __v = ${v};\n`
      + `  { const __b = idx * maxBonds, __n = _agentBondCount[idx];`
      + ` for (let __k = 0; __k < __n; __k++) if (_bondPartner[__b + __k] === __t) { ${arr}[__b + __k] = __v; break; } }\n`
      + `  if (__t >= 0 && __t < highWater && _alive[__t]) { const __b2 = __t * maxBonds, __n2 = _agentBondCount[__t];`
      + ` for (let __k = 0; __k < __n2; __k++) if (_bondPartner[__b2 + __k] === idx) { ${arr}[__b2 + __k] = __v; break; } }\n`
      + `}\n`;
  },
};

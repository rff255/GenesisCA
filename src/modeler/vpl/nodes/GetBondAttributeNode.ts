import type { NodeTypeDef } from '../types';

/** Get Bond Attribute — read a BOND's user attribute (Graph-Rewriting Automata,
 *  P2). A bond attribute is per-EDGE state: the value belongs to the bond between
 *  this agent and `partnerId`, not to either endpoint.
 *
 *  Feed `Partner` from For Each Bond's Partner output (or Get Bonded Agents →
 *  For Each In Array). The node scans this agent's bond list for that partner and
 *  reads the matching slot; with NO such bond it yields the attribute's DEFAULT
 *  (never `undefined` → NaN). Bonds are symmetric, so reading from either endpoint
 *  gives the same value (invariant I2).
 *
 *  Membership is a straight partner-id scan of the live `bondCount` entries — the
 *  SAME rule For Each Bond and `hasBond` use (no epoch re-check: the engine's
 *  post-step stale sweep keeps the list clean). */
export const GetBondAttributeNode: NodeTypeDef = {
  type: 'getBondAttribute',
  label: 'Get Bond Attribute',
  description: "Read a bond's attribute by partner id (per-EDGE state). No bond with that partner ⇒ the attribute's default.",
  category: 'data',
  color: '#5e35b1',
  requirements: { bondGraph: true },
  ports: [
    { id: 'partnerId', label: 'Partner', kind: 'input', category: 'value', dataType: 'integer' },
    { id: 'value', label: 'Value', kind: 'output', category: 'value', dataType: 'any' },
  ],
  defaultConfig: { attributeId: '' },
  compile: (nodeId, config, inputs, _boundary, ctx) => {
    const attr = String(config.attributeId ?? '');
    const spec = ctx?.bondAttrs?.find(a => a.id === attr);
    // Defensive: an attribute the model no longer declares (a hand-edited file, or
    // a Bonds-capability-off model whose ABI carries no `_bondAttr_` block) reads
    // its literal default rather than referencing an undefined parameter.
    if (!spec) return `const _v${nodeId} = 0;\n`;
    const t = `((${inputs['partnerId'] ?? '-1'}) | 0)`;
    const slot = `_gba${nodeId}`;
    return `let ${slot} = -1; { const __t = ${t}, __b = idx * maxBonds, __n = _agentBondCount[idx];`
      + ` for (let __k = 0; __k < __n; __k++) if (_bondPartner[__b + __k] === __t) { ${slot} = __b + __k; break; } }\n`
      + `const _v${nodeId} = ${slot} >= 0 ? _bondAttr_${attr}[${slot}] : ${spec.defaultValue};\n`;
  },
};

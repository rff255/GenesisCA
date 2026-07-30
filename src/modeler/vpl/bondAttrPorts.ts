// Graph-Rewriting Automata (P2) — Form Bond's per-BOND-ATTRIBUTE initial-value
// input ports.
//
// The port SET is derived from `model.bondAttributes` (not from a user-chosen
// slot count), so it can never name a deleted attribute and needs no `+ slot` UI.
//
// THE DUAL-CONSUMPTION RULE (the `buildExtraSlotPorts` / `buildCensusPorts`
// precedent): this is the ONE builder, consumed by BOTH `CaNode.tsx` (what the
// canvas renders) AND `effectivePorts.ts` (what drag-and-drop / the connection-drop
// menu offer). If those two ever derived the ports independently they would drift,
// and the menu would offer a port the canvas does not draw.

import type { PortDef } from './types';
import type { Attribute, CAModel } from '../../model/types';
import { bondAttrsOf } from '../../model/attributeScope';

/** The node types that expose one input port per bond attribute — every verb that
 *  FORMS a bond, so the new edge's attribute values are authorable at the point it
 *  is created (P4: Rewire Bond forms one too). */
const BOND_ATTR_PORT_TYPES = new Set(['formBond', 'rewireBond', 'formBondBetween']);

/** The port id for a bond attribute's Form Bond initial value. Its inline widget
 *  value therefore lives at config `_port_bondAttr_<id>` (the ModelContext
 *  cascades key off exactly that). */
export const bondAttrPortId = (attrId: string): string => `bondAttr_${attrId}`;

/** The bond attributes a node's dynamic ports are built from — empty for every
 *  node type that has none, for a non-agent model, and when the Bonds capability
 *  is off (`bondAttrsOf` applies that filter). */
export function bondAttrPortSource(nodeType: string, model?: CAModel | null): Attribute[] {
  if (!model || !BOND_ATTR_PORT_TYPES.has(nodeType)) return [];
  return bondAttrsOf(model);
}

/** Form Bond's per-bond-attribute initial-value input ports, labelled with the
 *  attribute NAME and carrying a type-adaptive inline widget (bool → True/False,
 *  tag → the option names, integer/float → a number field). Empty ⇒ Form Bond
 *  keeps its historical port set exactly. */
export function buildBondAttrPorts(
  nodeType: string,
  model?: CAModel | null,
): { inputs: PortDef[]; outputs: PortDef[] } {
  const inputs: PortDef[] = [];
  for (const a of bondAttrPortSource(nodeType, model)) {
    const widget = a.type === 'bool' ? 'bool' as const
      : a.type === 'tag' ? 'tag' as const
      : 'number' as const;
    inputs.push({
      id: bondAttrPortId(a.id),
      label: a.name,
      kind: 'input',
      category: 'value',
      dataType: 'any',
      inlineWidget: widget,
      defaultValue: a.defaultValue ?? '0',
    });
  }
  return { inputs, outputs: [] };
}

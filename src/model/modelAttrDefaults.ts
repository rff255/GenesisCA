/** The runtime `modelAttrs` map built from each model attribute's DECLARED
 *  default — the exact shape the worker receives and the compiled code indexes
 *  (`modelAttrs[<key>]`), including the colour split into `_r/_g/_b/_a` slots.
 *
 *  ONE definition, shared by:
 *    - SimulatorView (worker init + the "Reset to Default" button)
 *    - showCode.ts   (the port-ready document's fallback when no live values
 *                     were captured)
 *  so the documented values can never be a different derivation from the ones
 *  the engine actually runs with. */

import type { Attribute } from './types';
import { hexToRgba } from './colorHex';
import { modelAttrSlotKeys } from './attributeScope';

/** The packed "no neighbour" sentinel — meaningless on a model attribute, so it
 *  normalizes to 0 (see NeighborIndexDefaultEditor). */
const INVALID_NI = 0x80000000 | 0;

export function computeDefaultModelAttrs(attributes: Attribute[]): Record<string, number> {
  const mAttrs: Record<string, number> = {};
  for (const a of attributes) {
    if (!a.isModelAttribute) continue;
    switch (a.type) {
      case 'bool': mAttrs[a.id] = a.defaultValue === 'true' ? 1 : 0; break;
      case 'integer': mAttrs[a.id] = parseInt(a.defaultValue, 10) || 0; break;
      case 'float': mAttrs[a.id] = parseFloat(a.defaultValue) || 0; break;
      case 'neighborIndex': {
        // Stored value is the packed (dr, dc) i32.
        const n = parseInt(a.defaultValue, 10);
        mAttrs[a.id] = (Number.isFinite(n) && n !== INVALID_NI) ? (n | 0) : 0;
        break;
      }
      case 'color': {
        // #rrggbb (alpha absent → 255) or #rrggbbaa. Slot names come from
        // `modelAttrSlotKeys` — the layout-lockstep invariant.
        const c = hexToRgba(a.defaultValue || '#808080');
        const [kr, kg, kb, ka] = modelAttrSlotKeys(a);
        mAttrs[kr!] = c.r; mAttrs[kg!] = c.g; mAttrs[kb!] = c.b; mAttrs[ka!] = c.a;
        break;
      }
      case 'lookupTable':
        // Lives in the separate `interactionTables` payload, not in this scalar
        // record — don't allocate a slot.
        break;
      default: mAttrs[a.id] = 0;
    }
  }
  return mAttrs;
}

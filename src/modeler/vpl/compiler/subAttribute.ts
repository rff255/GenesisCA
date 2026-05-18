/** Sub-attribute helpers shared across compile targets.
 *
 *  A sub-attribute is a cell attribute marked as "only well-defined" when a
 *  parent (Tag or Boolean) cell attribute holds one of the configured parent
 *  values. The schema fields (parentAttributeId, parentValues, undefinedValue)
 *  live on Attribute; this module groups the logic for inspecting them.
 *
 *  Two kinds of guard emission are needed by compilers:
 *    - Scalar reads (GetCellAttribute, GetNeighborAttributeByIndex, etc.) wrap
 *      the read with `parent_matches ? raw_read : undefinedValue`.
 *    - Iteration contexts (GetNeighborsAttribute scratch fill, FilterNeighbors
 *      predicate, indicator aggregation, copy lines) skip / scrub non-matching
 *      cells via the parent-match expression as a guard.
 *
 *  This file provides JS-string helpers. WASM / WebGPU emitters use their own
 *  target-specific helpers but share `subAttributesOf` and `isSubAttribute`. */

import type { Attribute, CAModel } from '../../../model/types';

/** True iff this attribute is a sub-attribute (has a configured parent). */
export function isSubAttribute(attr: Attribute | undefined): attr is Attribute & { parentAttributeId: string } {
  return !!attr && typeof attr.parentAttributeId === 'string' && attr.parentAttributeId.length > 0;
}

/** Lookup the resolved parent attribute and value set for a sub-attribute.
 *  Returns null when `attr` is not a sub-attribute, or when the parent has
 *  been deleted, or when no parent values are configured. */
export function subAttrInfo(
  attr: Attribute | undefined,
  model: { attributes: Attribute[] } | CAModel,
): { parent: Attribute; parentValues: string[]; undefinedValue: string | undefined } | null {
  if (!isSubAttribute(attr)) return null;
  const parent = model.attributes.find(a => a.id === attr.parentAttributeId);
  if (!parent) return null;
  const parentValues = attr.parentValues ?? [];
  if (parentValues.length === 0) return null;
  return { parent, parentValues, undefinedValue: attr.undefinedValue };
}

/** All sub-attributes in the model, in declaration order. */
export function subAttributesOf(model: { attributes: Attribute[] } | CAModel): Attribute[] {
  return model.attributes.filter(a => !a.isModelAttribute && isSubAttribute(a));
}

/** Convert a stored string value (matching Attribute.defaultValue's encoding)
 *  to a JS literal. Falls back to a type-appropriate zero when missing or
 *  malformed. Mirrors how SetAttribute/getInlineValue treat inline numeric
 *  ports — bool 'true'/'false' → '1'/'0', tag indices → integer literal,
 *  float/integer → numeric string. */
export function attrValueLiteralJS(attr: Attribute, valueStr: string | undefined): string {
  const raw = valueStr ?? attr.defaultValue ?? '';
  switch (attr.type) {
    case 'bool':
      return raw === 'true' || raw === '1' ? '1' : '0';
    case 'integer':
    case 'tag':
    case 'neighborIndex': {
      const n = parseInt(raw, 10);
      return Number.isFinite(n) ? String(n) : '0';
    }
    case 'float': {
      const n = parseFloat(raw);
      return Number.isFinite(n) ? String(n) : '0';
    }
    case 'color':
      // Color is model-only; cell sub-attributes can't be color. Defensive fallback.
      return '0';
    default:
      return '0';
  }
}

/** Convert a parentValues entry (string) to the integer that the parent's
 *  typed-array storage holds. Tag parent: index as integer. Bool parent: 0/1.
 *  Exported so non-compile-target consumers (e.g. the simulator's Manual Brush
 *  worker handler) share the canonical encoding rule. */
export function parentValueToInt(parent: Attribute, raw: string): number {
  if (parent.type === 'bool') return raw === 'true' || raw === '1' ? 1 : 0;
  if (parent.type === 'tag') {
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** JS expression that evaluates true when the parent's stored value at
 *  `idxExpr` is in `parentValues`. Uses the read or write buffer per `buf`. */
export function parentMatchExprJS(
  parent: Attribute,
  parentValues: string[],
  idxExpr: string,
  buf: 'r' | 'w' = 'r',
): string {
  if (parentValues.length === 0) return 'false';
  const literals = parentValues.map(v => parentValueToInt(parent, v));
  const access = `${buf}_${parent.id}[${idxExpr}]`;
  if (literals.length === 1) return `${access} === ${literals[0]}`;
  // Compact: dedupe and emit an OR chain. Typical models have 1–4 values.
  const uniq = Array.from(new Set(literals));
  return uniq.map(l => `${access} === ${l}`).join(' || ');
}

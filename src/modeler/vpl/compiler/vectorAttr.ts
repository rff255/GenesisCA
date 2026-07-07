/**
 * Vector stored-attribute lowering — target-independent pre-compile / pre-init
 * transform (the composite-STORAGE analogue of `expandComposites`, which lowers a
 * composite WIRE).
 *
 * A `vector` attribute is a per-cell / per-agent 2D–3D direction. It is NEVER
 * stored as one array — `expandVectorAttributes` replaces each vector attribute
 * with its `dims` scalar `float` component attributes (`<id>_vx`/`_vy`/`_vz`),
 * mirroring how `color` splits into `_r/_g/_b`. Applied to the attribute list at
 * every compiler + the worker-init boundary, so every downstream layer (all 5
 * compilers, the worker SoA, save/load) sees ONLY scalar floats — already verified
 * on every target, 2D+3D. The vector attribute itself exists only in
 * `model.attributes`/`agentAttributes` (authoring) + this transform.
 *
 * `Get/Set Vector Attribute` carry the composite on ONE `vector` wire and are
 * lowered (in a sibling node transform) to Make/Break Vector over
 * getCellAttribute/setAttribute on these component ids — reusing the verified
 * `expandComposites` path, so there is ZERO new per-target emit.
 *
 * NB the suffix `_vx/_vy/_vz` mirrors `color`'s `_r/_g/_b` convention; a user
 * attribute id that already ends in one of those AND collides with a real vector
 * component id is rejected by validation (see nodeValidation) — the same
 * theoretical collision `color` carries.
 */

import type { Attribute, AttributeType, CAModel } from '../../../model/types';
import { is3dModelLike } from './niCodec';

const VECTOR_SUFFIXES = ['_vx', '_vy', '_vz'] as const;
const VECTOR_LABELS = ['X', 'Y', 'Z'] as const;

export function isVectorAttr(attr: { type: AttributeType } | undefined | null): boolean {
  return !!attr && attr.type === 'vector';
}

/** Vector dimensionality = the model's spatial dimension (2D → x,y; 3D → x,y,z),
 *  matching how the vector WIRE nodes hide the Z port in 2D. No explicit schema
 *  field — derived from the model, like every other 2D/3D distinction. */
export function vectorDimsForModel(model: CAModel | undefined | null): 2 | 3 {
  return is3dModelLike(model ?? undefined) ? 3 : 2;
}

/** The synthesized per-component scalar-float attribute ids for a vector attr —
 *  the ONE place that builds `<id>_vx/_vy/_vz`. Every expansion routes through it. */
export function vectorComponentIds(attrId: string, dims: number): string[] {
  return VECTOR_SUFFIXES.slice(0, Math.max(2, Math.min(3, dims))).map(sfx => attrId + sfx);
}

/** Per-component display labels (X / Y / Z), for the editor + inspector. */
export function vectorComponentLabels(dims: number): string[] {
  return VECTOR_LABELS.slice(0, Math.max(2, Math.min(3, dims))) as unknown as string[];
}

/** Parse a vector default string ("x,y" / "x,y,z") into `dims` numbers (missing /
 *  non-finite entries → 0). Comma-separated, whitespace-tolerant. */
export function parseVectorDefault(value: string | undefined, dims: number): number[] {
  const parts = String(value ?? '').split(',');
  const out: number[] = [];
  for (let i = 0; i < dims; i++) {
    const v = parseFloat((parts[i] ?? '').trim());
    out.push(Number.isFinite(v) ? v : 0);
  }
  return out;
}

/** Join `dims` component numbers back into the "x,y[,z]" default-string encoding. */
export function encodeVectorDefault(comps: number[], dims: number): string {
  return Array.from({ length: dims }, (_, i) => String(comps[i] ?? 0)).join(',');
}

/** Lower each `vector` attribute in `attrs` into its `dims` scalar-FLOAT component
 *  attributes (`<id>_vx/_vy/_vz`), preserving list order + the fields the storage /
 *  compiler layers read: `isModelAttribute`, `agentAccess` (a vector cell FIELD's
 *  components inherit the field access), and a per-component `boundaryValue` split.
 *  Non-vector attributes pass through untouched. Returns the SAME array (identity)
 *  when there are no vector attributes — the hot-path no-op. */
export function expandVectorAttributes(attrs: Attribute[], dims: number): Attribute[] {
  if (!attrs.some(a => a.type === 'vector')) return attrs;
  const out: Attribute[] = [];
  for (const a of attrs) {
    if (a.type !== 'vector') { out.push(a); continue; }
    const ids = vectorComponentIds(a.id, dims);
    const labels = vectorComponentLabels(dims);
    const defaults = parseVectorDefault(a.defaultValue, dims);
    const bounds = a.boundaryValue !== undefined && a.boundaryValue !== '' ? parseVectorDefault(a.boundaryValue, dims) : null;
    for (let i = 0; i < dims; i++) {
      const comp: Attribute = {
        id: ids[i]!,
        name: `${a.name} ${labels[i]}`,
        type: 'float',
        description: a.description,
        isModelAttribute: a.isModelAttribute,
        defaultValue: String(defaults[i]),
      };
      if (bounds) comp.boundaryValue = String(bounds[i]);
      if (a.agentAccess) comp.agentAccess = a.agentAccess;
      out.push(comp);
    }
  }
  return out;
}

/** Does this attribute list contain any vector attribute? (Cheap gate for callers
 *  deciding whether to run the expansion / node lowering.) */
export function hasVectorAttrs(attrs: readonly Attribute[]): boolean {
  return attrs.some(a => a.type === 'vector');
}

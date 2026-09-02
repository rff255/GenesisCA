/**
 * User-facing display names for attribute / variable / indicator data types.
 *
 * The INTERNAL type ids ('bool', 'float', …) are schema values — they appear
 * in .gcaproj files, node configs, and typed-array dispatch and must never
 * change. The UI, however, should not expose programmer jargon: 'bool' reads
 * as "Binary" and 'float' as "Decimal" everywhere the user sees a type name.
 * Route every type-name render through this helper instead of printing the
 * raw id.
 */

const TYPE_DISPLAY_NAMES: Record<string, string> = {
  bool: 'Binary',
  integer: 'Integer',
  float: 'Decimal',
  tag: 'Tag',
  color: 'Color',
  neighborIndex: 'NeighborIndex',
  lookupTable: 'Lookup Table',
  vector: 'Vector',
};

/** Display name for a data-type id; unknown ids pass through unchanged. */
export function typeDisplayName(t: string): string {
  return TYPE_DISPLAY_NAMES[t] ?? t;
}

/**
 * The type name for a LIST-ROW badge, which (unlike a dropdown option) is the
 * only place a user sees an element's type at a glance. Identical to
 * `typeDisplayName` for every scalar type; a `vector` additionally carries its
 * dimensionality — `Vector (2D)` / `Vector (3D)` — because 2D and 3D vectors are
 * genuinely different shapes and the Data Type dropdown already names them that
 * way. Shared by the Attributes and Local Variables lists so the two agree.
 */
export function typeBadgeLabel(t: string, vectorDims?: number): string {
  if (t === 'vector') return `Vector (${vectorDims === 3 ? '3D' : '2D'})`;
  return typeDisplayName(t);
}

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

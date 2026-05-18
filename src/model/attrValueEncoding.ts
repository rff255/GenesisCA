/** Shared attribute value encoding — converts a stored string value (matching
 *  Attribute.defaultValue's encoding) into the numeric value stored in the
 *  typed-array buffer for that attribute.
 *
 *  Used by:
 *    - sim.worker.ts `defaultValue()` and `boundaryCellValue()` for grid init
 *    - SimulatorView Manual Brush (right-panel value widgets) when posting
 *      `paintManual` messages to the worker
 *
 *  Encoding rules (must match `Attribute.defaultValue` everywhere):
 *    - bool:           'true' | '1' → 1; everything else → 0
 *    - integer/tag/
 *      neighborIndex:  decimal integer string → parsed int (fallback 0)
 *    - float:          decimal/exponential string → parsed float (fallback 0)
 *    - color/other:    not stored as a single number per cell — returns 0
 *
 *  Structural input type keeps this usable from both the worker's local
 *  AttrDef and the model-side Attribute. */

export interface AttrEncodingShape {
  type: string;
  defaultValue?: string;
}

/** Encode a string value for an attribute into its typed-array numeric form.
 *  When `raw` is undefined or empty, falls back to `attr.defaultValue`.
 *  Returns 0 for malformed/missing values to mirror the original
 *  `parseInt(...) || 0` behaviour in sim.worker.ts. */
export function encodeAttrValue(attr: AttrEncodingShape, raw?: string): number {
  const v = raw ?? attr.defaultValue ?? '';
  switch (attr.type) {
    case 'bool':
      return v === 'true' || v === '1' ? 1 : 0;
    case 'integer':
    case 'tag':
    case 'neighborIndex': {
      const n = parseInt(v, 10);
      return Number.isFinite(n) ? n : 0;
    }
    case 'float': {
      const n = parseFloat(v);
      return Number.isFinite(n) ? n : 0;
    }
    default:
      return 0;
  }
}

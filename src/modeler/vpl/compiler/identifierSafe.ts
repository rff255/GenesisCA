/**
 * Mapping-id → identifier-safe suffix. Used to derive variable names like
 * `_isV_<safeId(mappingId)>` in the JS compiler and matching i32 local names
 * in the WASM compiler. Both targets must derive the same suffix for the
 * same input — otherwise the SetColorViewer emitter would reference a
 * declaration that the wrong target produced.
 *
 * Replaces every non-alphanumeric character with `_`. Empty input collapses
 * to `_` so we never produce `_isV_` (no suffix), which could clash with
 * other internals.
 */
export function safeId(raw: string): string {
  if (!raw) return '_';
  return raw.replace(/[^a-zA-Z0-9]/g, '_');
}

/**
 * Detect whether a model draws glyphs anywhere — i.e. has a `setCellLooks`
 * node with `useGlyph` enabled, in the main graph or inside any macro
 * definition. Drives layout-time allocation of the per-cell glyph buffers
 * (codes + colours) across all three compile targets.
 *
 * A plain-color `setCellLooks` (useGlyph off) does NOT trigger allocation, so
 * the (overwhelmingly common) flat-color models keep the glyph memory cost at
 * zero — the JS / WASM / WebGPU layouts skip the regions entirely.
 */

import type { CAModel } from '../../../model/types';
import type { GraphNode } from '../../../model/types';

function usesGlyph(n: GraphNode): boolean {
  return n.data?.nodeType === 'setCellLooks' && !!(n.data.config as Record<string, unknown>)?.useGlyph;
}

export function hasGlyphsInModel(model: CAModel): boolean {
  for (const n of model.graphNodes) {
    if (usesGlyph(n)) return true;
  }
  for (const def of model.macroDefs || []) {
    for (const n of def.nodes) {
      if (usesGlyph(n)) return true;
    }
  }
  return false;
}

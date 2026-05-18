/**
 * Detect whether a model uses `setCellGlyph` anywhere — in the main graph or
 * inside any macro definition. Drives layout-time allocation of the per-cell
 * glyph buffers (codes + colours) across all three compile targets.
 *
 * When `false`, the JS / WASM / WebGPU layouts skip the regions entirely,
 * keeping the memory cost at zero for the (overwhelmingly common) models
 * that never use the feature.
 */

import type { CAModel } from '../../../model/types';

export function hasGlyphsInModel(model: CAModel): boolean {
  for (const n of model.graphNodes) {
    if (n.data?.nodeType === 'setCellGlyph') return true;
  }
  for (const def of model.macroDefs || []) {
    for (const n of def.nodes) {
      if (n.data?.nodeType === 'setCellGlyph') return true;
    }
  }
  return false;
}

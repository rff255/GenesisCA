import type { CAModel } from '../../../model/types';
import { hasGlyphsInModel } from './glyphsUsage';

/** "Skip Isolated Empty Cells" (docs/PLAN_LARGE_GRID_PERF.md) is active for a
 *  compile when it's enabled + synchronous + the model uses the CA grid + has
 *  NO glyphs. Sync-only (async's single-buffer + shuffled order is incompatible
 *  with a list-iteration active set). Glyph models are excluded: the per-pass
 *  glyph zero-fill assumes a FULL repaint each step/pass, so a sparse loop
 *  would erase inactive cells' glyphs — full-loop behaviour is kept for them
 *  (correct, just not accelerated). The SINGLE predicate consumed by the JS
 *  compiler (sparse loop emit + params), the WASM compiler (sparse loop +
 *  numParams), the WASM layout (active-list region + compact packed-offset
 *  neighbour tables), and mirrored by the worker's `sieParamsPresent` — one
 *  source of truth so the baked layout/ABI can never desync. Lives in its own
 *  tiny module (not compile.ts) so wasm/layout.ts can import it without a cycle. */
export function sparseSteppingEnabled(model: CAModel): boolean {
  const sie = model.properties.skipIsolatedEmpty;
  return !!sie?.enabled
    && model.properties.updateMode !== 'asynchronous'
    && model.topologyMode?.gridCells !== false
    // Agents write cell attributes directly (the field bridge deposits into the
    // read buffer every generation) OUTSIDE the step, so the active set can't
    // see those transitions — a deposit into an isolated cell would never
    // activate it. Agent models keep the full loop (correct, not accelerated).
    && model.topologyMode?.agents !== true
    && !hasGlyphsInModel(model);
}

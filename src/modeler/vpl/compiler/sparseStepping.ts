import type { CAModel } from '../../../model/types';

/** "Skip Isolated Empty Cells" (docs/PLAN_LARGE_GRID_PERF.md) is active for a
 *  compile when it's enabled + synchronous + the model uses the CA grid.
 *  Sync-only (async's single-buffer + shuffled order is incompatible with a
 *  list-iteration active set). The SINGLE predicate consumed by the JS compiler
 *  (sparse loop emit + params), the WASM compiler (sparse loop + numParams), the
 *  WASM layout (active-list region + compact packed-offset neighbour tables),
 *  and mirrored by the worker's `sieParamsPresent` — one source of truth so the
 *  baked layout/ABI can never desync. Lives in its own tiny module (not
 *  compile.ts) so wasm/layout.ts can import it without a cycle. */
export function sparseSteppingEnabled(model: CAModel): boolean {
  const sie = model.properties.skipIsolatedEmpty;
  return !!sie?.enabled
    && model.properties.updateMode !== 'asynchronous'
    && model.topologyMode?.gridCells !== false;
}

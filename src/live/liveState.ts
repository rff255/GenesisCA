/** LIVE MODE — transient runtime flags shared across the two panes' React trees.
 *
 *  Sibling of [liveUiState.ts](./liveUiState.ts): that module owns the PERSISTED
 *  layout, this one the per-session flags nobody wants written to disk. Same
 *  shape as `graphState.ts`'s `activeGraphKind` (private `let`, getter,
 *  `subscribe` returning an unsubscribe, equality-guarded setter that notifies)
 *  so `memo`'d consumers can read it through `useSyncExternalStore`.
 *
 *  Phase 2 publishes exactly one flag. Phase 4 adds `liveFocus`
 *  (`'graph' | 'viewport'` — the keyboard owner) and `liveGraphDragging` (the
 *  skip-blit guard) here.
 */

/** True while a capture RECORDING is in progress.
 *
 *  A `'view'`-scope recording LOCKS the output frame dimensions on its first
 *  captured frame (`recordCropRef` / `recordDimsRef` in `SimulatorView`), and the
 *  dimension guard then DROPS every frame that does not match. Re-sizing the
 *  viewport pane mid-recording therefore changes the source box while the frame
 *  size is pinned — so the Live layout controls (splitter, dock, swap, collapse)
 *  are disabled in place with the reason while this is true, the same
 *  disposition the existing "capture settings while recording" rule uses.
 *
 *  Published by `SimulatorView` (which owns `recording`); consumed by
 *  `LiveSplitter` and `LiveViewportBar`, which live outside its React tree or
 *  are rendered before the flag is known.
 */
let liveLayoutLockedGlobal = false;
const layoutLockListeners = new Set<() => void>();

export function getLiveLayoutLocked(): boolean {
  return liveLayoutLockedGlobal;
}

export function subscribeLiveLayoutLocked(fn: () => void): () => void {
  layoutLockListeners.add(fn);
  return () => { layoutLockListeners.delete(fn); };
}

export function setLiveLayoutLocked(val: boolean): void {
  if (liveLayoutLockedGlobal === val) return;
  liveLayoutLockedGlobal = val;
  layoutLockListeners.forEach(fn => fn());
}

/** The reason shown on every layout control while the lock is on. */
export const LIVE_LAYOUT_LOCK_REASON =
  'Recording — the frame size is locked for the run. Stop the recording to change the layout.';

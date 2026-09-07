/** LIVE MODE — transient runtime flags shared across the two panes' React trees.
 *
 *  Sibling of [liveUiState.ts](./liveUiState.ts): that module owns the PERSISTED
 *  layout, this one the per-session flags nobody wants written to disk. Same
 *  shape as `graphState.ts`'s `activeGraphKind` (private `let`, getter,
 *  `subscribe` returning an unsubscribe, equality-guarded setter that notifies)
 *  so `memo`'d consumers can read it through `useSyncExternalStore`.
 *
 *  Phase 2 published one flag; Phase 3 added `liveShown`. Phase 4 adds
 *  `liveFocus` (`'graph' | 'viewport'` — the keyboard owner) and
 *  `liveGraphDragging` (the skip-blit guard) here.
 */

/** True while the Live workspace is the active mode.
 *
 *  `SimulatorView` gets this as its `live` PROP (one source of truth for the
 *  view that owns the pipeline), but the GRAPH side needs it too and sits in a
 *  different React tree: `GraphEditor` stretches its write-back debounce while a
 *  pointer is held on the canvas, and ONLY in Live — the Modeler tab's feel must
 *  be unchanged. Threading a prop from `App` through `ModelerView` →
 *  `GraphEditorInner` → `GraphEditor` for a flag read inside a native
 *  `pointerdown` listener buys nothing over the project's established cross-tree
 *  seam, so this is it. Published by `App` (the one place that knows the mode).
 */
let liveShownGlobal = false;
const shownListeners = new Set<() => void>();

export function getLiveShown(): boolean {
  return liveShownGlobal;
}

export function subscribeLiveShown(fn: () => void): () => void {
  shownListeners.add(fn);
  return () => { shownListeners.delete(fn); };
}

export function setLiveShown(val: boolean): void {
  if (liveShownGlobal === val) return;
  liveShownGlobal = val;
  shownListeners.forEach(fn => fn());
}

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

/** LIVE (Phase 3) — what the transport chip says about the RUNNING rule.
 *
 *  - `ok`      the worker is running exactly this model's rule.
 *  - `stale`   the graph does not compile, so the PREVIOUS rule is still
 *              running: the `recompile` post is withheld on the main thread
 *              (the worker nulls its `stepFn` on any compile it is handed, so
 *              "keep the last good rule" means never sending the message).
 *  - `pending` apply policy is "On demand" and edits are waiting for Ctrl+Enter.
 *  - `rebuild` a STRUCTURAL edit is deferred — applying it re-seeds the board.
 *
 *  Declared here rather than in `SimulatorView` because `LiveViewportBar`
 *  renders it and importing a type out of an 18 kloc component is worse.
 */
export type LiveRuleStatus = 'ok' | 'stale' | 'pending' | 'rebuild';

/** The reason shown on every layout control while the lock is on. */
export const LIVE_LAYOUT_LOCK_REASON =
  'Recording — the frame size is locked for the run. Stop the recording to change the layout.';

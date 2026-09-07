/** LIVE MODE — transient runtime flags shared across the two panes' React trees.
 *
 *  Sibling of [liveUiState.ts](./liveUiState.ts): that module owns the PERSISTED
 *  layout, this one the per-session flags nobody wants written to disk. Same
 *  shape as `graphState.ts`'s `activeGraphKind` (private `let`, getter,
 *  `subscribe` returning an unsubscribe, equality-guarded setter that notifies)
 *  so `memo`'d consumers can read it through `useSyncExternalStore`.
 *
 *  Phase 2 published one flag; Phase 3 added `liveShown`; Phase 4 added
 *  `liveFocus` (the keyboard owner), `liveGraphDragging` (the skip-blit guard)
 *  and `overseerRunning` (the nav-button gate).
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

/** LIVE (Phase 4) — which pane owns the keyboard. */
export type LiveFocus = 'graph' | 'viewport';

/** The focused pane in Live: the surface a keystroke acts on.
 *
 *  ⚠ This is NOT DOM focus. Both panes are full working surfaces whose real
 *  focus is usually on the `<body>` (a canvas click focuses nothing), so DOM
 *  focus cannot say which one the user means. `App` sets this from a
 *  `pointerdown` OR a `pointerenter` on each pane wrapper — hovering is enough
 *  to type, which is what makes "point at the graph, hit Space" work without a
 *  click that would also deselect / paint something.
 *
 *  Consumers: `SimulatorView`'s main keyboard handler (`Space`, the 3D view
 *  digits and `Ctrl+C/V/X` act only with `viewport` focus), `ModelerView`
 *  (`Space` = quick-add stands down with `viewport` focus) and `GraphEditor`
 *  (its `Ctrl+C/V/X` stands down with `viewport` focus — those two were bound
 *  TWICE, in the same phase on the same target, before Phase 4).
 *
 *  Defaults to `graph`: entering Live is an act of wanting to edit the rule,
 *  and the first hover settles it anyway. Session-transient by design — nothing
 *  about a focus ring belongs in localStorage.
 */
let liveFocusGlobal: LiveFocus = 'graph';
const focusListeners = new Set<() => void>();

export function getLiveFocus(): LiveFocus {
  return liveFocusGlobal;
}

export function subscribeLiveFocus(fn: () => void): () => void {
  focusListeners.add(fn);
  return () => { focusListeners.delete(fn); };
}

export function setLiveFocus(val: LiveFocus): void {
  if (liveFocusGlobal === val) return;
  liveFocusGlobal = val;
  focusListeners.forEach(fn => fn());
}

/** True while a node DRAG is in progress in the graph pane.
 *
 *  The skip-BLIT guard: while the user drags a node, `SimulatorView` stops
 *  compositing the board but the worker keeps stepping at full cadence — the
 *  drag stays smooth, the simulation does not lose a single generation, and the
 *  falling edge draws once immediately so the board is never left stale.
 *
 *  ⚠ It is the BLIT that is skipped, never `sendNextStep()` and never the
 *  recording capture. Published by `GraphEditor` from React Flow's own
 *  `dragging` position-change flag; read by `SimulatorView` (which gates it on
 *  `live` — outside Live nothing consults it).
 */
let liveGraphDraggingGlobal = false;
const dragListeners = new Set<() => void>();

export function getLiveGraphDragging(): boolean {
  return liveGraphDraggingGlobal;
}

export function subscribeLiveGraphDragging(fn: () => void): () => void {
  dragListeners.add(fn);
  return () => { dragListeners.delete(fn); };
}

export function setLiveGraphDragging(val: boolean): void {
  if (liveGraphDraggingGlobal === val) return;
  liveGraphDraggingGlobal = val;
  dragListeners.forEach(fn => fn());
}

// DEV hook (the project's `window.__*` convention). A React Flow node drag
// CANNOT be driven by synthetic pointer events — `setPointerCapture` throws for
// a pointerId the browser never issued, which aborts the handler — so the
// skip-blit guard is otherwise unverifiable from a driven browser. This drives
// the exact flag the real gesture publishes.
if (import.meta.env.DEV) {
  (globalThis as unknown as { __setLiveGraphDragging?: (v: boolean) => void })
    .__setLiveGraphDragging = setLiveGraphDragging;
}

/** True while an Overseer EXPERIMENT is running.
 *
 *  Live and the Overseer are genuinely exclusive: `SimulatorView`'s model effect
 *  aborts a running experiment on ANY model change, and in Live the model
 *  changes as the user types — a sweep under a rule that changes mid-run
 *  measures nothing, and the abort would read as a crash. So the Live nav button
 *  is GREYED WITH THE REASON while this is true (grey, not hide: Abort is
 *  visible in the Experiments panel, so the user can reach the working state),
 *  and inside Live the Experiments tab strip is HIDDEN (from there the working
 *  state is unreachable without leaving Live).
 *
 *  ⚠ MIRROR INVARIANT: `SimulatorView` assigns this in the SAME statement block
 *  as its `setOverseerRunning` React state, so the two can never disagree.
 *  Published by `SimulatorView`, consumed by `App` (another React tree).
 */
let overseerRunningGlobal = false;
const overseerListeners = new Set<() => void>();

export function getOverseerRunning(): boolean {
  return overseerRunningGlobal;
}

export function subscribeOverseerRunning(fn: () => void): () => void {
  overseerListeners.add(fn);
  return () => { overseerListeners.delete(fn); };
}

export function setOverseerRunning(val: boolean): void {
  if (overseerRunningGlobal === val) return;
  overseerRunningGlobal = val;
  overseerListeners.forEach(fn => fn());
}

/** LIVE — the SHARED intent behind the canvas-fullscreen toggle (`F`).
 *
 *  Outside Live each view toggles its own panels and the event carries no
 *  detail. In Live one press must act on BOTH panel sets — and "toggle each
 *  independently" is not that: the Live panel policy already enters with the
 *  modeler's panels closed and the simulator's bars open, so independent
 *  toggles are permanently out of phase (one press would OPEN the graph's
 *  panels while CLOSING the simulator's bars). So in Live the initiator flips
 *  this one flag and ships the resulting intent in the event's `detail`; both
 *  consumers obey it, which makes press 1 = collapse everything open and
 *  press 2 = restore exactly what each view had.
 *
 *  Reset on Live exit, so the next entry starts from "nothing collapsed by F".
 */
let liveFullscreenCollapsed = false;

export function nextLiveFullscreenIntent(): boolean {
  liveFullscreenCollapsed = !liveFullscreenCollapsed;
  return liveFullscreenCollapsed;
}

export function resetLiveFullscreenIntent(): void {
  liveFullscreenCollapsed = false;
}

/** Ask both canvases to collapse / restore their chrome.
 *
 *  `live` → the shared intent above rides along in `detail.collapse`; otherwise
 *  the event is bare and each listener keeps its own toggle semantics. Every
 *  caller (the `F` key, the graph's ⛶ button, the viewport's ⛶ button) goes
 *  through here so the key and the buttons can never mean different things.
 */
export function dispatchCanvasFullscreen(live: boolean): void {
  window.dispatchEvent(new CustomEvent('genesis-toggle-canvas-fullscreen',
    live ? { detail: { collapse: nextLiveFullscreenIntent() } } : undefined));
}

/** The reason the Live nav button is greyed while an experiment runs. */
export const LIVE_OVERSEER_BUSY_REASON =
  'An Overseer experiment is running — abort it (Experiments panel) or wait for it to finish. '
  + 'Every graph edit aborts a running experiment, so Live cannot share the run.';

/** LIVE MODE — the persisted LAYOUT snapshot (dock / swap / split / collapse).
 *
 *  Live is the third top-level mode: the rule graph and the running simulation
 *  side by side in two opaque panes divided by a draggable splitter. This module
 *  owns *where the panes sit*, and nothing else.
 *
 *  WHY A MODULE GLOBAL (and not React state in `App`, or `genesisca_sim_settings`):
 *  - the Live splitter and the Live viewport bar live in DIFFERENT React trees —
 *    the bar renders inside `SimulatorView` (so it can carry `data-sim-overlay`
 *    and read the sim's own state), the splitter is a sibling in `<main>`. A
 *    module global + pub/sub is this project's established cross-tree seam
 *    (`graphState.ts`'s `activeGraphKind` / the canvas view settings), and it
 *    works with `memo`'d consumers through `useSyncExternalStore`.
 *  - `genesisca_sim_settings` is owned by `SimulatorView`'s single 300 ms persist
 *    effect, whose documented declaration-order trap requires every persisted
 *    state to be declared above it. Live layout is App-level state; putting it
 *    there would mean threading it down and back up for no benefit.
 *
 *  WHY A FRACTION AND NOT PIXELS: a 0–1 fraction survives a window resize and a
 *  dock flip untouched; pixels would need re-clamping on every one of them.
 *
 *  ⚠ The simulator's side-panel widths do NOT persist (both `PanelShell` and
 *  `SimulatorView`'s own handles mutate inline `style.width` on an element that
 *  is unmounted on close), so there was no existing store to reuse — hence this
 *  one, under its own key.
 */

const LIVE_LAYOUT_KEY = 'genesisca_live_layout';

/** Which edge the simulation viewport occupies. */
export type LiveDock = 'right' | 'bottom';
/** How a graph edit reaches the running worker. Phase 3 consumes this; Phase 2
 *  only stores it (an *enabled* switch that did nothing would be exactly the
 *  inert control the UI doctrine forbids, so no control is rendered yet). */
export type LiveApplyPolicy = 'auto' | 'ondemand';

export interface LiveLayout {
  dock: LiveDock;
  /** Put the viewport on the leading edge instead (row-reverse / column-reverse). */
  swapped: boolean;
  /** Fraction of the content box given to the GRAPH pane, 0–1. */
  split: number;
  /** The viewport pane is hidden entirely (the graph fills the workspace). */
  viewportCollapsed: boolean;
  applyPolicy: LiveApplyPolicy;
}

/** Neither pane may be dragged to nothing — Collapse is the explicit action for
 *  that, and a 0-width simulator pane makes `canvas.width = 0`, which turns the
 *  next `drawImage` into the documented `InvalidStateError` React unmount. */
export const LIVE_SPLIT_MIN = 0.15;
export const LIVE_SPLIT_MAX = 0.85;

export const DEFAULT_LIVE_LAYOUT: LiveLayout = {
  dock: 'right',
  swapped: false,
  split: 0.5,
  viewportCollapsed: false,
  applyPolicy: 'auto',
};

export function clampLiveSplit(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_LIVE_LAYOUT.split;
  return Math.max(LIVE_SPLIT_MIN, Math.min(LIVE_SPLIT_MAX, n));
}

function loadLiveLayout(): LiveLayout {
  try {
    const raw = localStorage.getItem(LIVE_LAYOUT_KEY);
    if (!raw) return { ...DEFAULT_LIVE_LAYOUT };
    const p = JSON.parse(raw) as Partial<LiveLayout>;
    if (!p || typeof p !== 'object') return { ...DEFAULT_LIVE_LAYOUT };
    return {
      dock: p.dock === 'bottom' ? 'bottom' : 'right',
      swapped: p.swapped === true,
      split: clampLiveSplit(typeof p.split === 'number' ? p.split : DEFAULT_LIVE_LAYOUT.split),
      viewportCollapsed: p.viewportCollapsed === true,
      applyPolicy: p.applyPolicy === 'ondemand' ? 'ondemand' : 'auto',
    };
  } catch {
    // localStorage unavailable (private mode / quota) — fall back to defaults.
    return { ...DEFAULT_LIVE_LAYOUT };
  }
}

let liveLayout: LiveLayout = loadLiveLayout();
const listeners = new Set<() => void>();

/** `useSyncExternalStore` needs a STABLE reference from the getter, so the
 *  setter only replaces the object when a field really changed. */
export function getLiveLayout(): LiveLayout {
  return liveLayout;
}

export function subscribeLiveLayout(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function persist(): void {
  try {
    localStorage.setItem(LIVE_LAYOUT_KEY, JSON.stringify(liveLayout));
  } catch {
    // Settings just won't persist.
  }
}

/** Merge a patch into the layout. A no-op patch keeps the same object identity
 *  (so memoised consumers do not re-render) and writes nothing. */
export function setLiveLayout(patch: Partial<LiveLayout>): void {
  const next: LiveLayout = { ...liveLayout, ...patch };
  if (patch.split !== undefined) next.split = clampLiveSplit(next.split);
  const same = (Object.keys(next) as Array<keyof LiveLayout>).every(k => next[k] === liveLayout[k]);
  if (same) return;
  liveLayout = next;
  persist();
  listeners.forEach(fn => fn());
}

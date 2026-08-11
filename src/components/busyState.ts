/**
 * Busy / progress store — the ONE place a long-running operation announces
 * itself, so the user always knows what the app is doing and that it has not
 * frozen.
 *
 * ── Why a module-level store rather than React state ────────────────────────
 * The operations that need this span BOTH levels of the app: a model load
 * starts in `App`, a grid resize / recompile / recording encode lives inside
 * `SimulatorView`, and some of them are kicked off from plain modules with no
 * component in scope. A module global with a pub/sub — the pattern
 * `graphState.ts` already uses for `showPortLabelsGlobal` — lets any of them
 * call `beginBusy()` without prop drilling, while ONE `<BusyOverlay/>` mounted
 * in `App` renders the result.
 *
 * ── THE HONESTY RULE (the whole point, and the easy thing to get wrong) ─────
 * A progress UI is worthless unless it actually PAINTS. Several of the covered
 * operations used to run as one uninterrupted synchronous block on the main
 * thread (the GIF encode loop was the worst: hundreds of ms to several seconds
 * with no yield), during which React never re-renders and the browser never
 * paints — so a naive spinner would sit frozen at 0 % for exactly the stretch
 * it exists to explain. Two consequences, both load-bearing:
 *
 *   1. An operation covered here must either be genuinely asynchronous (the
 *      work is in the worker, or it awaits) or be made to YIELD between chunks
 *      (see `yieldToPaint` below). Wrapping a still-synchronous block in
 *      `beginBusy`/`end` buys NOTHING — do not do it and call it done.
 *   2. The show-DELAY below means an operation that finishes promptly never
 *      flashes a bar. That is also why a synchronous block would show nothing:
 *      the timer cannot fire while the main thread is blocked. Silence is the
 *      correct outcome there, but it is silence for the wrong reason — fix the
 *      yielding, don't shorten the delay.
 *
 * ── Overlap policy ─────────────────────────────────────────────────────────
 * Operations may nest or overlap (a model load's file read, then the worker
 * reinit it triggers). Entries are kept as a STACK and the MOST RECENTLY begun
 * visible one is displayed — the innermost, most specific thing happening. No
 * queueing, no merging: `end()` is idempotent and order-independent, so a
 * handle can be ended twice or out of order without stranding the overlay.
 */

/** How long an operation must run before its bar appears. Anything quicker
 *  never flashes. Applied uniformly to every call site. */
export const BUSY_SHOW_DELAY_MS = 150;

/** What the overlay renders. `fraction === null` ⇒ indeterminate. */
export interface BusySnapshot {
  id: number;
  label: string;
  fraction: number | null;
  detail: string | null;
}

export interface BusyHandle {
  /** Report progress. `undefined` (or omitted) switches back to indeterminate. */
  progress(fraction?: number, detail?: string): void;
  /** Retitle mid-flight (e.g. "Encoding GIF…" → "Saving…"). */
  setLabel(label: string): void;
  /** Finish. Idempotent — safe to call from a `finally` and again elsewhere. */
  end(): void;
}

interface Entry {
  id: number;
  label: string;
  fraction: number | null;
  detail: string | null;
  /** False until the show-delay elapses; an entry that ends first never paints. */
  visible: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

let seq = 0;
const entries: Entry[] = [];
const listeners = new Set<() => void>();

// `useSyncExternalStore` demands a STABLE reference from getSnapshot — returning
// a freshly built object every call is an infinite render loop. So the view is
// cached here and only rebuilt when a field actually changed.
let cached: BusySnapshot | null = null;

function rebuild(): boolean {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (!e.visible) continue;
    if (cached !== null
      && cached.id === e.id && cached.label === e.label
      && cached.fraction === e.fraction && cached.detail === e.detail) return false;
    cached = { id: e.id, label: e.label, fraction: e.fraction, detail: e.detail };
    return true;
  }
  if (cached === null) return false;
  cached = null;
  return true;
}

function notify(): void {
  if (!rebuild()) return;
  for (const l of listeners) l();
}

export function subscribeBusy(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function getBusySnapshot(): BusySnapshot | null {
  return cached;
}

/**
 * Announce a long operation.
 *
 * @param label     What is happening, in the user's words ("Encoding GIF…").
 * @param opts.determinate  Start with a 0 % bar rather than an indeterminate
 *                          one, for work whose total is known up front.
 */
export function beginBusy(label: string, opts: { determinate?: boolean } = {}): BusyHandle {
  const entry: Entry = {
    id: ++seq,
    label,
    fraction: opts.determinate ? 0 : null,
    detail: null,
    visible: false,
    timer: null,
  };
  entries.push(entry);
  entry.timer = setTimeout(() => {
    entry.timer = null;
    entry.visible = true;
    notify();
  }, BUSY_SHOW_DELAY_MS);

  let ended = false;
  return {
    progress(fraction?: number, detail?: string) {
      if (ended) return;
      entry.fraction = fraction === undefined || !Number.isFinite(fraction)
        ? null
        : Math.max(0, Math.min(1, fraction));
      if (detail !== undefined) entry.detail = detail;
      if (entry.visible) notify();
    },
    setLabel(next: string) {
      if (ended) return;
      entry.label = next;
      if (entry.visible) notify();
    },
    end() {
      if (ended) return;
      ended = true;
      if (entry.timer !== null) { clearTimeout(entry.timer); entry.timer = null; }
      const i = entries.indexOf(entry);
      if (i >= 0) entries.splice(i, 1);
      notify();
    },
  };
}

/**
 * Hand the main thread back to the browser so it can run the rendering steps —
 * i.e. so the bar this module drives actually MOVES.
 *
 * A `MessageChannel` round-trip, NOT `requestAnimationFrame`: rAF is part of the
 * rendering steps and is therefore suspended in a hidden or occluded tab, which
 * would leave a long encode stalled forever the moment the user switched away
 * (and makes the operation unverifiable in an occluded automation pane). A
 * macrotask always runs, and the browser is free to paint between macrotasks —
 * which is exactly the guarantee we need. Same reasoning as the worker's
 * `yieldToEventLoop`.
 */
export function yieldToPaint(): Promise<void> {
  return new Promise<void>(resolve => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => { ch.port1.close(); resolve(); };
    ch.port2.postMessage(0);
  });
}

/** The `simTransportApi` seam — how code OUTSIDE `SimulatorView` asks the
 *  simulator to advance ONE generation, to play / pause, and to stop tracing.
 *
 *  Born with RULE TRACE (P3). The `]` key ("step node") walks the cursor over the
 *  recorded flow events, and past the LAST one it means "there is nothing more in
 *  this trace — show me the next generation", i.e. exactly what the transport's
 *  ⏭ button does. That key is bound ONCE, in `App` (the `Ctrl+C/V/X` was-bound-
 *  twice lesson), and `App` cannot reach `handleStep` — it is a closure inside an
 *  18 kloc component.
 *
 *  So `SimulatorView` registers this on mount and nulls it on unmount, the
 *  `simLayoutApi` / `quickAddApi` pattern. Every entry is deliberately the SAME
 *  function the transport bar's own button calls: a second "post a step"
 *  implementation would be free to drift from the Overseer guard, the
 *  `pendingStep` latch and the active-viewer argument the real one carries, and
 *  a second "stop tracing" would be free to drift from the ref/state/store/worker
 *  quartet `stopTracing` keeps in step.
 *
 *  ⚠ P5 WIDENED IT, and `playing` is the one field that is not a function.
 *  The Trace panel's Resume/Pause is ONE button whose glyph is the simulator's
 *  `playing` state, and the panel lives in another React tree — so the flag is
 *  published here on its own tiny channel, the `graphState.ts` shape (private
 *  `let`, getter, `subscribe`, an equality-guarded setter that notifies). It is
 *  a MIRROR: `SimulatorView` owns the state and publishes in the same statement
 *  block as its own `setPlaying`, the `overseerRunning` discipline. Nothing here
 *  ever decides whether the simulation is running.
 */

export interface SimTransportApi {
  /** One generation — the transport's ⏭ Step, verbatim (it also pauses a
   *  running simulation, which is what the button does too). */
  stepGeneration: () => void;
  /** The transport's play/pause toggle, split in two so a caller that knows
   *  which state it wants does not have to read `playing` and invert it. */
  play: () => void;
  pause: () => void;
  /** Stop the whole trace session — the Live bar chip's ✕, verbatim. */
  stopTrace: () => void;
}

export let simTransportApi: SimTransportApi | null = null;

export function setSimTransportApi(api: SimTransportApi | null): void {
  simTransportApi = api;
}

// ---------------------------------------------------------------------------
// `playing` — the published mirror (see the header)
// ---------------------------------------------------------------------------

let playing = false;
const playingListeners = new Set<() => void>();

export function getSimPlaying(): boolean { return playing; }

export function subscribeSimPlaying(fn: () => void): () => void {
  playingListeners.add(fn);
  return () => { playingListeners.delete(fn); };
}

/** Published by `SimulatorView` beside its own `setPlaying`. Equality-guarded so
 *  the effect that mirrors it can run on every render without waking anybody. */
export function setSimPlaying(next: boolean): void {
  if (playing === next) return;
  playing = next;
  playingListeners.forEach(fn => fn());
}

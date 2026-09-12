/** The `simTransportApi` seam — how code OUTSIDE `SimulatorView` asks the
 *  simulator to advance ONE generation.
 *
 *  Born with RULE TRACE (P3). The `]` key ("step node") walks the cursor over the
 *  recorded flow events, and past the LAST one it means "there is nothing more in
 *  this trace — show me the next generation", i.e. exactly what the transport's
 *  ⏭ button does. That key is bound ONCE, in `App` (the `Ctrl+C/V/X` was-bound-
 *  twice lesson), and `App` cannot reach `handleStep` — it is a closure inside an
 *  18 kloc component.
 *
 *  So `SimulatorView` registers this on mount and nulls it on unmount, the
 *  `simLayoutApi` / `quickAddApi` pattern. It is deliberately the SAME function
 *  the ⏭ button calls: a second "post a step" implementation would be free to
 *  drift from the Overseer guard, the `pendingStep` latch and the active-viewer
 *  argument the real one carries.
 */

export interface SimTransportApi {
  /** One generation — the transport's ⏭ Step, verbatim (it also pauses a
   *  running simulation, which is what the button does too). */
  stepGeneration: () => void;
}

export let simTransportApi: SimTransportApi | null = null;

export function setSimTransportApi(api: SimTransportApi | null): void {
  simTransportApi = api;
}

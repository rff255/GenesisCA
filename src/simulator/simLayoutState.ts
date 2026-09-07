/** The `simLayoutApi` seam — how code OUTSIDE `SimulatorView` asks the simulator
 *  to re-size its canvases.
 *
 *  `draw()` is the ONE place that re-sizes every backing store (the 2D canvas +
 *  the two cursor overlays, gl3d's `resize`) **and** performs the direct-render
 *  `OffscreenCanvas` re-attach. Three triggers funnel into it today: the panel /
 *  bar layout effect (direct, before paint), the two side-panel splitter
 *  `onMove` handlers (`scheduleLayoutDraw`), and a `ResizeObserver` catch-all.
 *
 *  ⚠ The LIVE splitter is a sibling of `SimulatorView` in `<main>`, so it can
 *  reach none of them. Relying on the `ResizeObserver` alone is exactly what the
 *  panel-resize fix's own note warns against — RO delivery is part of the
 *  browser's rendering steps, and an occluded pane delivers neither
 *  `requestAnimationFrame` nor `ResizeObserver`, so the stale-bitmap stretch
 *  comes straight back. Worse, without `scheduleLayoutDraw`'s 140 ms
 *  `layoutResizeUntilRef` window the drag would drive one `OffscreenCanvas`
 *  re-attach + worker pipeline rebuild PER FRAME (measured: 26 `attachAgentCanvas`
 *  messages over a 30-move drag, versus 2 with the deferral).
 *
 *  So `SimulatorView` registers this API on mount and nulls it on unmount — the
 *  `quickAddApi` pattern from `graphState.ts` (registered in `GraphEditor`,
 *  consumed from `ModelerView`).
 */

export interface SimLayoutApi {
  /** CONTINUOUS change (a splitter drag): rAF-coalesced redraw + open the
   *  re-attach deferral window so the drag costs ~2 attaches, not one per frame. */
  scheduleLayoutDraw: () => void;
  /** DISCRETE change (dock / swap / collapse / drag release): clear the
   *  deferral and redraw immediately — the size is final, so nothing should wait
   *  out the settle window. Mirrors the panel/bar layout `useLayoutEffect`. */
  drawNow: () => void;
}

export let simLayoutApi: SimLayoutApi | null = null;

export function setSimLayoutApi(api: SimLayoutApi | null): void {
  simLayoutApi = api;
}

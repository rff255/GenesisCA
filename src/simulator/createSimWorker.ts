// Sim-worker factory — the MAIN-APP variant.
//
// Vite turns `new Worker(new URL('./x.ts', import.meta.url), {type:'module'})`
// into a separately-emitted, hashed worker chunk (assets/sim.worker-<hash>.js).
// That's the right thing for the full IDE (the worker is loaded on demand and
// cached by the SW).
//
// The PRESENTATION / standalone-.html build swaps this module for
// `createSimWorker.inline.ts` (via a Vite resolve.alias in the viewer build),
// which imports the worker with `?worker&inline` so it base64-embeds into the
// single self-contained HTML file. See vite.config.ts (VIEWER branch) and
// docs/IMPACT_MAP_PRESENTATION_EXPORT.md.
export function createSimWorker(): Worker {
  return new Worker(new URL('./engine/sim.worker.ts', import.meta.url), {
    type: 'module',
  });
}

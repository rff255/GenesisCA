// Sim-worker factory — the PRESENTATION / standalone-.html variant.
//
// `?worker&inline` makes Vite bundle the worker's ENTIRE import graph and
// base64-embed it as a Blob-URL worker, so no separate chunk is emitted and the
// whole simulator fits in ONE self-contained HTML file (openable from file://).
// The viewer build aliases `./createSimWorker` to this module (vite.config.ts).
//
// Vite emits an inline worker as a *classic* Blob worker, so it runs under
// file:// across browsers without the module-blob caveats.
import SimWorker from './engine/sim.worker?worker&inline';

export function createSimWorker(): Worker {
  return new SimWorker();
}

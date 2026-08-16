/**
 * The ONE place `geotiff` (the only runtime dependency GenesisCA's I/O layer
 * carries) enters the module graph — and therefore the ONE seam the viewer build
 * swaps out.
 *
 * WHY IT IS ITS OWN MODULE
 * ------------------------
 * The presentation export ships a SINGLE self-contained `.html`, built by
 * `vite build --mode viewer` with `vite-plugin-singlefile` — which sets
 * `inlineDynamicImports: true`. So in that build a lazy `import('geotiff')` is
 * NOT a separate chunk: it is folded into the one HTML file, and every exported
 * presentation would grow by the whole library (geotiff + pako + lerc + zstddec
 * + float16 + …). Isolating the import here lets the viewer build alias this
 * module to `geotiffLoader.viewer.ts` (the `createSimWorker` precedent), so the
 * library never reaches the viewer's graph at all.
 *
 * In the MAIN app the dynamic `import()` keeps it in its own lazy chunk, fetched
 * the first time a user actually opens a GeoTIFF.
 *
 * `GEOTIFF_SUPPORTED` is what the UI gates on, so the viewer shows no control it
 * cannot honour (the standing "an enabled control must do something" rule).
 */

/** True in the main app; false in the standalone presentation viewer. */
export const GEOTIFF_SUPPORTED = true;

/** Lazily pull in geotiff.js. Returns the module namespace. */
export async function loadGeoTiffLib() {
  return import('geotiff');
}

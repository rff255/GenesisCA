/**
 * VIEWER build stand-in for `geotiffLoader.ts` (swapped in by the
 * `mode === 'viewer'` `resolve.alias` in vite.config.ts, exactly like
 * `createSimWorker.inline.ts`).
 *
 * The presentation viewer is a single self-contained `.html` whose bundler
 * INLINES dynamic imports, so a real `import('geotiff')` here would add the
 * whole library to every exported presentation. A viewer presents ONE finished
 * model; importing a raster into it is not part of that job — so the dependency
 * is dropped and `GEOTIFF_SUPPORTED` hides the affordance rather than leaving a
 * control that would fail when clicked.
 */

export const GEOTIFF_SUPPORTED = false;

export async function loadGeoTiffLib(): Promise<never> {
  throw new Error('GeoTIFF import is not available in the standalone viewer.');
}

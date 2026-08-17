/**
 * Raster resampling — the pure kernels shared by every grid importer.
 *
 * WHY ITS OWN MODULE: both `geotiffImport.ts` (band → grid) and `csvImport.ts`
 * (the Esri ASCII grid path) resample onto the model's grid, and they must do it
 * IDENTICALLY — a `.asc` and a GeoTIFF covering the same ground have to pick the
 * same cells. `geotiffImport` already imports types FROM `csvImport`, so putting
 * the kernels in either one would make the pair circular at runtime; a leaf
 * module both depend on keeps one implementation with no cycle.
 *
 * Dependency-free and DOM-free, so `scripts/test-geotiff-import.mjs` and
 * `scripts/test-asc-import.mjs` both assert VALUES on it without a browser.
 */

/** How a raster is resampled when its dimensions differ from the grid's. */
export type RasterResampleMethod = 'nearest' | 'average';

/** Resample a row-major raster to `dstW × dstH` by NEAREST NEIGHBOUR.
 *
 *  The DEFAULT, and the ONLY method allowed for a CATEGORICAL target: a
 *  landcover / fuel-model / district raster carries class CODES, and averaging
 *  them invents classes that do not exist (`gdalwarp -r near`, for the same
 *  reason). Callers enforce that; see `supportsAverageResample`.
 *
 *  Centre sampling: destination cell `d` maps to source index
 *  `floor((d + 0.5) · src/dst)`, clamped — so identical dimensions are the
 *  IDENTITY (asserted by the test suite), a 2× downsample takes every other
 *  pixel starting at the first, and an upsample repeats.
 *
 *  NB this is deliberately NOT geotiff.js's own `resampleMethod: 'nearest'`,
 *  which is TOP-LEFT anchored (`round(rel · x)`). Centre sampling matches
 *  GenesisCA's own cell-centre conventions everywhere else (the GeoJSON
 *  rasteriser samples cell CENTRES too), so one convention covers every
 *  importer. */
export function resampleNearest(
  src: ArrayLike<number>, srcW: number, srcH: number, dstW: number, dstH: number,
): Float64Array {
  const out = new Float64Array(Math.max(0, dstW * dstH));
  if (dstW < 1 || dstH < 1 || srcW < 1 || srcH < 1) return out;
  // Identity fast path — and it is EXACT, not merely fast: no index arithmetic
  // runs at all, so a same-size import can never be off by a pixel.
  if (srcW === dstW && srcH === dstH) {
    const n = Math.min(out.length, src.length);
    for (let i = 0; i < n; i++) out[i] = src[i] as number;
    return out;
  }
  const sx = new Int32Array(dstW);
  for (let c = 0; c < dstW; c++) {
    sx[c] = Math.min(srcW - 1, Math.max(0, Math.floor(((c + 0.5) * srcW) / dstW)));
  }
  for (let r = 0; r < dstH; r++) {
    const srcRow = Math.min(srcH - 1, Math.max(0, Math.floor(((r + 0.5) * srcH) / dstH))) * srcW;
    const dstRow = r * dstW;
    for (let c = 0; c < dstW; c++) out[dstRow + c] = src[srcRow + sx[c]!] as number;
  }
  return out;
}

/** Resample a row-major raster by BOX-FILTER AVERAGE — what a GIS does with
 *  `gdalwarp -r average` when it downsamples CONTINUOUS data (elevation,
 *  population density, a burn probability). Nearest throws away all but one
 *  sample per destination cell, which on a 10× downsample of a noisy DEM is a
 *  visibly different (and less faithful) surface.
 *
 *  Destination cell `d` covers the source range `[d·src/dst, (d+1)·src/dst)`;
 *  the output is the MEAN of the finite, non-NODATA samples in that 2D box. The
 *  range is widened to at least one sample (`hi = max(hi, lo+1)`), so an
 *  UPSAMPLE — where the box would otherwise be empty — degrades to nearest
 *  rather than producing NaN.
 *
 *  NODATA-AWARE, and that is the whole reason it takes the sentinel: a mean that
 *  quietly folded `-9999` in would smear the study-area boundary across every
 *  edge cell. Matching samples are EXCLUDED; a box holding nothing BUT NODATA
 *  outputs the sentinel again, so the caller's existing NODATA handling still
 *  sees it and defaults the cell. With no sentinel, an all-non-finite box yields
 *  NaN, which every decoder already reports as a miss. */
export function resampleAverage(
  src: ArrayLike<number>, srcW: number, srcH: number, dstW: number, dstH: number,
  noData?: number | null,
): Float64Array {
  const out = new Float64Array(Math.max(0, dstW * dstH));
  if (dstW < 1 || dstH < 1 || srcW < 1 || srcH < 1) return out;
  if (srcW === dstW && srcH === dstH) {
    const n = Math.min(out.length, src.length);
    for (let i = 0; i < n; i++) out[i] = src[i] as number;
    return out;
  }
  const hasNoData = noData !== undefined && noData !== null && Number.isFinite(noData);
  // The column boxes are the same for every row — compute them once.
  const cLo = new Int32Array(dstW), cHi = new Int32Array(dstW);
  for (let c = 0; c < dstW; c++) {
    const lo = Math.min(srcW - 1, Math.max(0, Math.floor((c * srcW) / dstW)));
    cLo[c] = lo;
    cHi[c] = Math.min(srcW, Math.max(lo + 1, Math.ceil(((c + 1) * srcW) / dstW)));
  }
  for (let r = 0; r < dstH; r++) {
    const rLo = Math.min(srcH - 1, Math.max(0, Math.floor((r * srcH) / dstH)));
    const rHi = Math.min(srcH, Math.max(rLo + 1, Math.ceil(((r + 1) * srcH) / dstH)));
    const dstRow = r * dstW;
    for (let c = 0; c < dstW; c++) {
      const lo = cLo[c]!, hi = cHi[c]!;
      let sum = 0, n = 0;
      for (let sr = rLo; sr < rHi; sr++) {
        const base = sr * srcW;
        for (let sc = lo; sc < hi; sc++) {
          const v = src[base + sc] as number;
          if (!Number.isFinite(v)) continue;
          if (hasNoData && v === noData) continue;
          sum += v; n++;
        }
      }
      out[dstRow + c] = n > 0 ? sum / n : (hasNoData ? (noData as number) : NaN);
    }
  }
  return out;
}

/** Dispatch on the method. `average` is never chosen for a categorical target —
 *  the callers gate on `supportsAverageResample` and enforce it structurally. */
export function resampleRaster(
  src: ArrayLike<number>, srcW: number, srcH: number, dstW: number, dstH: number,
  method: RasterResampleMethod, noData?: number | null,
): Float64Array {
  return method === 'average'
    ? resampleAverage(src, srcW, srcH, dstW, dstH, noData)
    : resampleNearest(src, srcW, srcH, dstW, dstH);
}

/**
 * Image → grid sampling for the "Mapping Cells" dialog.
 *
 * Pure functions that turn a source image (as ImageData) into a grid of output
 * cells, honouring: a bounding region, a square sampling-cell size, an optional
 * grid alignment anchor (the "cell reference" square — phases the lattice so a
 * cell boundary passes through a chosen source point), average-vs-centre
 * sampling, invert, and binarize-with-threshold. The result is an RGBA buffer
 * with one pixel per output cell — the same shape the worker's `importImage`
 * handler consumes (it applies the model's Colour→Attribute mapping per cell),
 * plus a boolean mask (binarize-true cells) for the manual input-mapping path.
 */

import { pixelLuminance } from '../model/inputMappingParams';

export interface ImageSampleOptions {
  /** Bounding region in SOURCE pixels (the area to map). */
  region: { x: number; y: number; w: number; h: number };
  /** Size (px) of one square sampling cell; min 1. */
  cellSize: number;
  /** Grid alignment anchor in SOURCE px (the "cell reference" square's top-left).
   *  The output lattice is phased so a cell boundary falls on this point; cells
   *  then tile across the region from the first boundary inside it. Absent →
   *  the region origin (backward-compatible: the grid tiles from region.x/y). */
  cellOriginX?: number;
  cellOriginY?: number;
  /** Average all pixels inside a cell (else sample the cell centre). */
  average: boolean;
  /** Invert colours (255 − channel). Applied before binarize. */
  invert: boolean;
  /** Binarize to black/white by luminance threshold. */
  binarize: boolean;
  /** Luminance threshold 0–255 (binarize). Pixels brighter → white(=true). */
  threshold: number;
}

export interface GridifyResult {
  cols: number;
  rows: number;
  /** RGBA, one pixel per output cell, row-major (length cols*rows*4). */
  pixels: Uint8ClampedArray;
  /** Binarize-true flag per output cell (row-major, length cols*rows). Reflects
   *  `luminance(after invert) > threshold` regardless of the `binarize` flag, so
   *  the manual path can use it even when the colour output isn't binarized. */
  mask: Uint8Array;
}

/** THE ONE luminance formula, shared with the image-import `lum` channel source
 *  (`inputMappingParams.pixelLuminance`) — binarize collapses a pixel by THIS
 *  measure, so a `lum` source over a binarized image must read back the 0/255
 *  that decision produced. Delegated rather than duplicated. */
const lum = pixelLuminance;

/** Clamp an integer into [lo, hi]. */
function clampi(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Effective output grid for a region + cell size + optional alignment anchor:
 * the source-pixel origin of cell (0,0) (phased to the anchor lattice) and the
 * whole-cell dimensions that fit inside the region. Leading/trailing partial
 * cells (before the first anchored boundary / past the last full cell) are
 * dropped, matching the classic "trailing partial cell is dropped" behaviour.
 */
export function gridLayout(
  region: { x: number; y: number; w: number; h: number },
  cellSize: number,
  cellOriginX?: number,
  cellOriginY?: number,
): { gx: number; gy: number; cols: number; rows: number } {
  const cs = Math.max(1, Math.floor(cellSize));
  const ax = cellOriginX ?? region.x;
  const ay = cellOriginY ?? region.y;
  // First lattice boundary (ax + k*cs) at or right of the region's left/top edge.
  const gx = ax + Math.ceil((region.x - ax) / cs) * cs;
  const gy = ay + Math.ceil((region.y - ay) / cs) * cs;
  const cols = Math.max(0, Math.floor((region.x + region.w - gx) / cs));
  const rows = Math.max(0, Math.floor((region.y + region.h - gy) / cs));
  return { gx, gy, cols, rows };
}

/** Compute the output grid dimensions for a region + cell size (+ anchor). */
export function gridDims(
  region: { x: number; y: number; w: number; h: number },
  cellSize: number,
  cellOriginX?: number,
  cellOriginY?: number,
): { cols: number; rows: number } {
  const { cols, rows } = gridLayout(region, cellSize, cellOriginX, cellOriginY);
  return { cols, rows };
}

/** Sample a source image into an output grid per the options. */
export function gridifyImage(src: ImageData, opts: ImageSampleOptions): GridifyResult {
  const cs = Math.max(1, Math.floor(opts.cellSize));
  const { gx, gy, cols, rows } = gridLayout(opts.region, cs, opts.cellOriginX, opts.cellOriginY);
  const rx = Math.floor(gx), ry = Math.floor(gy);
  const pixels = new Uint8ClampedArray(cols * rows * 4);
  const mask = new Uint8Array(cols * rows);
  const sw = src.width, sh = src.height, sd = src.data;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let R: number, G: number, B: number, A: number;
      if (opts.average) {
        let sr = 0, sg = 0, sb = 0, sa = 0, n = 0;
        for (let dy = 0; dy < cs; dy++) {
          const sy = clampi(ry + r * cs + dy, 0, sh - 1);
          for (let dx = 0; dx < cs; dx++) {
            const sx = clampi(rx + c * cs + dx, 0, sw - 1);
            const p = (sy * sw + sx) * 4;
            sr += sd[p]!; sg += sd[p + 1]!; sb += sd[p + 2]!; sa += sd[p + 3]!; n++;
          }
        }
        R = sr / n; G = sg / n; B = sb / n; A = sa / n;
      } else {
        const sx = clampi(rx + c * cs + (cs >> 1), 0, sw - 1);
        const sy = clampi(ry + r * cs + (cs >> 1), 0, sh - 1);
        const p = (sy * sw + sx) * 4;
        R = sd[p]!; G = sd[p + 1]!; B = sd[p + 2]!; A = sd[p + 3]!;
      }
      if (opts.invert) { R = 255 - R; G = 255 - G; B = 255 - B; }
      const bright = lum(R, G, B) > opts.threshold;
      const oi = r * cols + c;
      mask[oi] = bright ? 1 : 0;
      let oR = R, oG = G, oB = B;
      if (opts.binarize) { const v = bright ? 255 : 0; oR = oG = oB = v; }
      const o = oi * 4;
      pixels[o] = oR; pixels[o + 1] = oG; pixels[o + 2] = oB; pixels[o + 3] = A;
    }
  }
  return { cols, rows, pixels, mask };
}

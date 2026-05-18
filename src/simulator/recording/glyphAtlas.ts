/**
 * Glyph atlas — per-tile cache used by the simulator's per-cell glyph
 * overlay. The overlay path iterates only VISIBLE cells (bounded by viewport
 * ÷ cell-pixel-size, not by grid size) and `drawImage`s a pre-rasterised
 * tile per non-zero cell. `drawImage` from a small cached canvas is ~5–10×
 * faster than `fillText` per call in Chromium, which keeps the overlay at
 * 60fps even for dense glyph models on 5000² grids.
 *
 * Cache key: `${codepoint}|${r}|${g}|${b}|${tileSize}`. Tiles are tinted at
 * rasterise time so we never have to recolour on the hot path. Cache size
 * is bounded by the number of UNIQUE (codepoint, colour, size) combos the
 * model uses — typically 4–20 for direction-arrow / shape models. A soft
 * cap drops oldest tiles when the map exceeds {@link MAX_TILES} entries.
 *
 * `tileSize` is the rounded integer pixel size of a cell at the current
 * zoom level — callers round `scale` to the nearest integer before lookup
 * so wheel-drag zoom doesn't thrash the cache between sub-pixel scales.
 */

type TileKey = string;

const MAX_TILES = 512;
const tileCache = new Map<TileKey, HTMLCanvasElement>();

export function getGlyphTile(
  cp: number,
  r: number,
  g: number,
  b: number,
  tileSize: number,
): HTMLCanvasElement {
  const size = Math.max(2, Math.round(tileSize));
  const key = `${cp}|${r}|${g}|${b}|${size}`;
  const cached = tileCache.get(key);
  if (cached) {
    // Touch — re-insert so this entry isn't the oldest if we hit MAX_TILES.
    tileCache.delete(key);
    tileCache.set(key, cached);
    return cached;
  }

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const fontPx = Math.max(6, Math.floor(size * 0.9));
    ctx.font = `${fontPx}px sans-serif`;
    ctx.fillStyle = `rgb(${r & 0xff},${g & 0xff},${b & 0xff})`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    try {
      ctx.fillText(String.fromCodePoint(cp), size / 2, size / 2);
    } catch {
      // Invalid codepoint (e.g. unpaired surrogate). Draw nothing — the
      // cached blank tile prevents repeat-fillText cost.
    }
  }

  if (tileCache.size >= MAX_TILES) {
    const oldest = tileCache.keys().next().value;
    if (oldest !== undefined) tileCache.delete(oldest);
  }
  tileCache.set(key, canvas);
  return canvas;
}

/** Drop all cached tiles. Call when the page is offloading the simulator or
 *  when we know the cache contents are now wasted (e.g., font fallback
 *  changed). Cache rebuilds on next render. */
export function clearGlyphAtlas(): void {
  tileCache.clear();
}

/** Inspectable for tests / debugging. */
export function glyphAtlasSize(): number {
  return tileCache.size;
}

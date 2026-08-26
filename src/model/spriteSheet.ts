/**
 * Sprite-sheet GRIDDING — the pure geometry + frame-selection rules.
 *
 * A sprite sheet is ONE image holding a `cols × rows` grid of cells (with
 * optional margins/gaps). Two things are derived from that grid, and they are
 * deliberately SEPARATE:
 *
 *  1. THE CELLS — every grid cell's source rect, row-major (left-to-right then
 *     top-to-bottom). Purely geometric; independent of what the animation uses.
 *  2. THE FRAMES — an ORDERED list of cell indices that ARE the animation, in
 *     that order. Real sheets routinely hold several unrelated things (a walk
 *     cycle, an idle pose, a door, a UI icon), so "the frames" is a SELECTION
 *     over the cells, not "the first N of them".
 *
 * `SpriteSheetSpec.frames` is that ordered selection. It is optional and
 * **ABSENT ⇒ the historical behaviour byte-for-byte** (the first `count` cells
 * row-major, or every cell when `count` is absent) — so every sheet authored
 * before the selection existed slices exactly as it always did.
 *
 * DUPLICATES ARE ALLOWED, on purpose: `[0,1,2,1]` is a ping-pong cycle, which is
 * the cheapest way to author a back-and-forth animation and costs nothing here
 * (a frame is just a bitmap; the same cell decoded twice is two entries).
 *
 * OUT-OF-RANGE indices (the grid was shrunk after the selection was made) are
 * DROPPED rather than clamped — a clamp would silently animate the wrong cell.
 * If pruning empties the list the row-major default is used, so a sheet can
 * never become frameless.
 *
 * `frames` SUPERSEDES `count` when present (an explicit list already says how
 * many frames there are); the editor clears `count` when it writes a list.
 *
 * THE CELL SIZE is likewise optional: `cellW`/`cellH` ABSENT ⇒ DERIVED from the
 * image extent (the historical arithmetic, byte-for-byte), present ⇒ used as-is.
 * Explicit sizes exist because the derived one is locked to the FULL image, so a
 * sheet with trailing dead space could not be gridded by cols/rows alone — and
 * because the dialog's first-cell gizmo scales smoothly, which integer cell COUNTS
 * cannot express. `sheetWithCellSize` folds a size equal to the derived one back
 * to absent, mirroring `sheetWithFrames`.
 *
 * This module is dependency-free and DOM-free so both the decoder
 * (`spriteRegistry.ts`, browser) and the harness (Node) run the same code.
 */

import type { SpriteSheetSpec } from './types';

/** A source rectangle inside the sheet image. */
export interface SheetRect { x: number; y: number; w: number; h: number }

/** The resolved grid: cell counts + the derived cell size in image pixels. */
export interface SheetGrid { cols: number; rows: number; cellW: number; cellH: number; marginX: number; marginY: number; spacingX: number; spacingY: number }

/** The DERIVED cell size — image minus margins and inter-cell gaps, divided by the
 *  cell count. Exactly the historical `sliceSheet` arithmetic, and what a sheet
 *  with no explicit `cellW`/`cellH` still resolves to. */
export function derivedCellSize(sheet: SpriteSheetSpec, imgW: number, imgH: number): { cellW: number; cellH: number } {
  const cols = Math.max(1, Math.floor(sheet.cols || 1));
  const rows = Math.max(1, Math.floor(sheet.rows || 1));
  const marginX = sheet.marginX || 0, marginY = sheet.marginY || 0;
  const spacingX = sheet.spacingX || 0, spacingY = sheet.spacingY || 0;
  return {
    cellW: Math.max(1, Math.floor((imgW - marginX - (cols - 1) * spacingX) / cols)),
    cellH: Math.max(1, Math.floor((imgH - marginY - (rows - 1) * spacingY) / rows)),
  };
}

/** Resolve the grid geometry for a sheet over an image of the given size.
 *
 *  The cell size is EXPLICIT when the spec carries one (the first-cell gizmo wrote
 *  it), else DERIVED — and ABSENT is the historical path byte-for-byte, so every
 *  sheet authored before the gizmo slices exactly as it always did. An explicit
 *  size is sanitised the same way (`max(1, floor(·))`), so a hand-edited 0 / NaN
 *  can never produce a zero-area cell. */
export function sheetGrid(sheet: SpriteSheetSpec, imgW: number, imgH: number): SheetGrid {
  const cols = Math.max(1, Math.floor(sheet.cols || 1));
  const rows = Math.max(1, Math.floor(sheet.rows || 1));
  const marginX = sheet.marginX || 0, marginY = sheet.marginY || 0;
  const spacingX = sheet.spacingX || 0, spacingY = sheet.spacingY || 0;
  const derived = derivedCellSize(sheet, imgW, imgH);
  const cellW = Number.isFinite(sheet.cellW as number) && (sheet.cellW as number) > 0
    ? Math.max(1, Math.floor(sheet.cellW as number)) : derived.cellW;
  const cellH = Number.isFinite(sheet.cellH as number) && (sheet.cellH as number) > 0
    ? Math.max(1, Math.floor(sheet.cellH as number)) : derived.cellH;
  return { cols, rows, cellW, cellH, marginX, marginY, spacingX, spacingY };
}

/** How many CELLS the grid has (`cols * rows`) — the index space `frames` lives in. */
export function sheetCellCount(sheet: SpriteSheetSpec): number {
  return Math.max(1, Math.floor(sheet.cols || 1)) * Math.max(1, Math.floor(sheet.rows || 1));
}

/** The source rect of one grid cell by row-major index (no range check — callers
 *  pass an index from `sheetCellCount`'s range). */
export function sheetCellRect(g: SheetGrid, index: number): SheetRect {
  const r = Math.floor(index / g.cols), c = index % g.cols;
  return {
    x: g.marginX + c * (g.cellW + g.spacingX),
    y: g.marginY + r * (g.cellH + g.spacingY),
    w: g.cellW,
    h: g.cellH,
  };
}

/** Every grid cell's source rect, row-major. */
export function sheetCellRects(sheet: SpriteSheetSpec, imgW: number, imgH: number): SheetRect[] {
  const g = sheetGrid(sheet, imgW, imgH);
  const out: SheetRect[] = [];
  for (let n = 0; n < g.cols * g.rows; n++) out.push(sheetCellRect(g, n));
  return out;
}

/** Drop out-of-range indices (and non-integers) from a selection, preserving
 *  order AND duplicates. */
export function pruneSheetFrames(frames: readonly number[], cellCount: number): number[] {
  const out: number[] = [];
  for (const f of frames) {
    const n = Math.floor(f);
    if (Number.isFinite(n) && n >= 0 && n < cellCount) out.push(n);
  }
  return out;
}

/** The row-major default selection: the first `count` cells (or every cell when
 *  `count` is absent / non-positive). This IS the pre-selection behaviour. */
export function rowMajorFrames(sheet: SpriteSheetSpec): number[] {
  const cells = sheetCellCount(sheet);
  const total = Math.min(cells, sheet.count && sheet.count > 0 ? Math.floor(sheet.count) : cells);
  const out: number[] = [];
  for (let n = 0; n < total; n++) out.push(n);
  return out;
}

/** THE frame list: the explicit ordered selection when present (pruned), else the
 *  row-major default. A selection that prunes to nothing falls back to the
 *  default so a sheet is never frameless. */
export function sheetFrameIndices(sheet: SpriteSheetSpec): number[] {
  if (sheet.frames && sheet.frames.length > 0) {
    const pruned = pruneSheetFrames(sheet.frames, sheetCellCount(sheet));
    if (pruned.length > 0) return pruned;
  }
  return rowMajorFrames(sheet);
}

/** The source rects of the animation frames, in order — what the decoder slices. */
export function sheetFrameRects(sheet: SpriteSheetSpec, imgW: number, imgH: number): SheetRect[] {
  const g = sheetGrid(sheet, imgW, imgH);
  return sheetFrameIndices(sheet).map(i => sheetCellRect(g, i));
}

/** Fold a selection back into the SMALLEST spec that expresses it, so a sheet
 *  whose selection happens to be a row-major prefix keeps the legacy
 *  `count`-shaped record instead of gaining a redundant index list.
 *
 *  - every cell in order          ⇒ `{ frames: undefined, count: undefined }`
 *  - a row-major prefix `0..k-1`  ⇒ `{ frames: undefined, count: k }`
 *  - anything else                ⇒ `{ frames: sel,       count: undefined }`
 */
/** Fold an explicit cell size back into the SMALLEST spec that expresses it — the
 *  `sheetWithFrames` rule, applied to the geometry: a size that EQUALS the derived
 *  one is not stored, so a gizmo drag that lands back on the derived geometry
 *  keeps the legacy record shape (and every consumer stays on the derived path).
 *
 *  Pass `null` for either axis to mean "derived" explicitly (the reset affordance). */
export function sheetWithCellSize(
  sheet: SpriteSheetSpec, cellW: number | null, cellH: number | null, imgW: number, imgH: number,
): SpriteSheetSpec {
  const next: SpriteSheetSpec = { ...sheet };
  delete next.cellW; delete next.cellH;
  const derived = derivedCellSize(next, imgW, imgH);
  const w = cellW === null || !Number.isFinite(cellW) ? null : Math.max(1, Math.floor(cellW));
  const h = cellH === null || !Number.isFinite(cellH) ? null : Math.max(1, Math.floor(cellH));
  if (w !== null && w !== derived.cellW) next.cellW = w;
  if (h !== null && h !== derived.cellH) next.cellH = h;
  return next;
}

export function sheetWithFrames(sheet: SpriteSheetSpec, sel: readonly number[]): SpriteSheetSpec {
  const cells = sheetCellCount(sheet);
  const pruned = pruneSheetFrames(sel, cells);
  const isPrefix = pruned.length > 0 && pruned.every((v, i) => v === i);
  const next: SpriteSheetSpec = { ...sheet };
  if (isPrefix && pruned.length === cells) { delete next.frames; delete next.count; }
  else if (isPrefix) { delete next.frames; next.count = pruned.length; }
  else { next.frames = [...pruned]; delete next.count; }
  return next;
}

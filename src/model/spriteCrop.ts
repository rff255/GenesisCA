/**
 * Sprite CROP — the pure rectangle rules.
 *
 * A sprite SHEET is cropped by its grid (`spriteSheet.ts`); a plain image, an
 * animated GIF/WebP or a frame SEQUENCE had no cropping at all and rendered
 * exactly as imported — padding and all, which sets the drawn size just as much
 * as the art does. `SpriteAsset.crop` is one rectangle in SOURCE pixels applied to
 * EVERY frame at decode time (after the frames are extracted, before the chroma
 * key — the same seam the chroma key sits in).
 *
 * THE RULES, and each exists because it is the honest answer:
 *
 *  - ABSENT ⇒ no crop, byte-for-byte the historical decode. There is no "identity
 *    rect" state: `spriteWithCrop` FOLDS a rect equal to the whole image back to
 *    absent, mirroring `sheetWithCellSize`, so a drag that lands on the full image
 *    keeps the legacy record shape.
 *
 *  - CLAMPED PER FRAME. A frame SEQUENCE is N independent files and they may
 *    differ in size, so one stored rect has to be reconciled with each frame
 *    rather than with "the" image. `createImageBitmap` would happily crop out of
 *    bounds and pad with transparency; clamping is the predictable answer.
 *
 *  - A DEGENERATE or FULLY-OUTSIDE rect degrades to the WHOLE frame, never to a
 *    zero-area bitmap: a frame that cannot be produced would take the sprite off
 *    screen entirely, which is a far worse outcome than ignoring a rect that says
 *    nothing about this frame.
 *
 * Dependency-free and DOM-free (the `spriteSheet.ts` pattern) so the decoder
 * (browser), the dialog, the panel previews and the Node harness all run the same
 * code.
 */

import type { SpriteCropRect } from './types';

/** A resolved crop in the source-pixel space of ONE frame — always non-empty and
 *  fully inside that frame. */
export interface ResolvedCrop { x: number; y: number; w: number; h: number }

/** The crop to apply to a frame of `imgW × imgH`, or **null** meaning "use the
 *  whole frame" (absent / degenerate / fully outside / already the full frame).
 *
 *  Returning null for the full-frame case is deliberate: every caller then takes
 *  its own historical no-crop path (no bitmap copy, no canvas), so a crop that
 *  happens to select everything costs nothing. */
export function resolveSpriteCrop(
  crop: SpriteCropRect | undefined | null, imgW: number, imgH: number,
): ResolvedCrop | null {
  if (!crop) return null;
  const w0 = Math.max(1, Math.floor(imgW)), h0 = Math.max(1, Math.floor(imgH));
  const x = Math.floor(crop.x), y = Math.floor(crop.y);
  const cw = Math.floor(crop.width), ch = Math.floor(crop.height);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(cw) || !Number.isFinite(ch)) return null;
  if (cw <= 0 || ch <= 0) return null;
  // Fully outside this frame — the rect says nothing about it.
  if (x >= w0 || y >= h0 || x + cw <= 0 || y + ch <= 0) return null;
  const x0 = Math.max(0, x), y0 = Math.max(0, y);
  const x1 = Math.min(w0, x + cw), y1 = Math.min(h0, y + ch);
  if (x1 <= x0 || y1 <= y0) return null;
  // Selecting the whole frame IS no crop — same result, cheaper path.
  if (x0 === 0 && y0 === 0 && x1 === w0 && y1 === h0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Clamp a rect into `imgW × imgH` for EDITING (the dialog's fields + gizmo), where
 *  an always-valid, always-visible rect is what the user is dragging. Unlike
 *  `resolveSpriteCrop` this never returns null — a degenerate input collapses to a
 *  1 px rect inside the image rather than vanishing mid-drag. */
export function clampSpriteCrop(crop: SpriteCropRect, imgW: number, imgH: number): SpriteCropRect {
  const w0 = Math.max(1, Math.floor(imgW)), h0 = Math.max(1, Math.floor(imgH));
  const x = Math.max(0, Math.min(w0 - 1, Math.floor(crop.x) || 0));
  const y = Math.max(0, Math.min(h0 - 1, Math.floor(crop.y) || 0));
  const width = Math.max(1, Math.min(w0 - x, Math.floor(crop.width) || 1));
  const height = Math.max(1, Math.min(h0 - y, Math.floor(crop.height) || 1));
  return { x, y, width, height };
}

/** The whole image as a rect — the dialog's "Full image" reset target. */
export function fullSpriteCrop(imgW: number, imgH: number): SpriteCropRect {
  return { x: 0, y: 0, width: Math.max(1, Math.floor(imgW)), height: Math.max(1, Math.floor(imgH)) };
}

/** Does this rect select the WHOLE image? (The fold's test.) */
export function spriteCropIsFull(crop: SpriteCropRect | undefined | null, imgW: number, imgH: number): boolean {
  if (!crop) return true;
  return resolveSpriteCrop(crop, imgW, imgH) === null;
}

/** Fold a crop into the SMALLEST record that expresses it — the `sheetWithCellSize`
 *  rule applied to the rectangle: a rect that selects the whole image (or is
 *  degenerate) is NOT stored, so a drag that lands back on the full image leaves the
 *  asset exactly as it was and every consumer stays on the no-crop path.
 *
 *  Pass `null` to clear explicitly. Returns a NEW asset-shaped patch object rather
 *  than mutating, so the caller hands it straight to `updateSprite`. */
export function spriteCropPatch(
  crop: SpriteCropRect | null, imgW: number, imgH: number,
): { crop: SpriteCropRect | undefined } {
  if (!crop) return { crop: undefined };
  const c = clampSpriteCrop(crop, imgW, imgH);
  return { crop: spriteCropIsFull(c, imgW, imgH) ? undefined : c };
}

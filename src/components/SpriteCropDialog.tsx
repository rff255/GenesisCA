/**
 * SPRITE CROP dialog — trim a plain image / animated GIF / frame SEQUENCE to the
 * part of the source that is actually the art.
 *
 * WHY IT EXISTS: a sprite SHEET is cropped by its grid, but every other source
 * rendered exactly as imported — padding and all. Padding is not free: the sprite's
 * drawn size is its LONGEST side, so a centred 40 px figure in a 256 px canvas
 * draws at a sixth of the size the user asked for, and no scale setting fixes the
 * empty margin around it.
 *
 * It is a SEPARATE dialog from SpriteSheetDialog rather than a mode of it: that one
 * is entirely grid machinery (cols/rows/margins/gaps, the ordered cell strip, the
 * first-cell gizmo), none of which a plain image has. What IS shared is the
 * discipline, and it is copied deliberately:
 *
 *   - a FIXED-size letterboxed viewport. Sizing it to the image reflows the card as
 *     the content below grows — the drag "feedback loop" that makes a gizmo unusable.
 *   - `tryCapture` on a real DRAG only. Capturing on every press is what makes a
 *     canvas undrivable from a synthetic pointer event, and a synthetic pointerId
 *     the browser never issued throws outright.
 *   - hit priority handle → inside → outside, so the corner stays grabbable when the
 *     box is small and a press in the middle can never start a new box.
 *
 * The rect itself is `model/spriteCrop.ts` — the same module the DECODER clamps
 * with, so what is drawn here and what ends up on screen cannot disagree.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SpriteCropRect } from '../model/types';
import { NumberField } from '../modeler/vpl/widgets/InlineWidgets';
import { clampSpriteCrop, fullSpriteCrop } from '../model/spriteCrop';

/** Source viewport (fixed px) — see the layout rule above. */
const VIEWPORT_W = 460;
const VIEWPORT_H = 340;
/** Hit radius (canvas px) for the resize handle — SCREEN space, so it stays
 *  grabbable at any zoom. */
const HANDLE_HIT = 11;
/** How far a press must travel before it is a drag rather than a click. */
const DRAG_PX = 3;

interface View { scale: number; ox: number; oy: number }

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export interface SpriteCropDialogProps {
  /** Every frame of the asset, as `data:` URLs — `frames` for a sequence, else the
   *  single `dataUrl`. The box is ONE rect for all of them (they are the same
   *  artwork); the frame stepper only decides which one it is judged against. */
  frameUrls: string[];
  /** The starting rect, or null for "no crop yet" (opens on the whole image). */
  initial: SpriteCropRect | null;
  title?: string;
  /** Applies the rect. `null` = clear the crop. The caller folds a full-image rect
   *  back to absent (`spriteCropPatch`). */
  onApply: (crop: SpriteCropRect | null) => void;
  onCancel: () => void;
}

export function SpriteCropDialog({ frameUrls, initial, title = 'Crop sprite', onApply, onCancel }: SpriteCropDialogProps) {
  const [frameIdx, setFrameIdx] = useState(0);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [imgError, setImgError] = useState(false);

  const url = frameUrls[Math.min(frameIdx, Math.max(0, frameUrls.length - 1))] ?? '';
  useEffect(() => {
    let cancelled = false;
    setImgError(false);
    const im = new Image();
    im.onload = () => { if (!cancelled) setImg(im); };
    im.onerror = () => { if (!cancelled) { setImg(null); setImgError(true); } };
    im.src = url;
    return () => { cancelled = true; };
  }, [url]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel]);

  const iw = img?.naturalWidth ?? 1, ih = img?.naturalHeight ?? 1;

  /** The live rect. Seeded from `initial` (or the whole image) and RE-seeded when
   *  the first frame lands, because until then the extent is the 1×1 placeholder
   *  and a "whole image" default would be a 1 px box. */
  const [crop, setCrop] = useState<SpriteCropRect>(() => initial ?? { x: 0, y: 0, width: 1, height: 1 });
  const seeded = useRef(false);
  useEffect(() => {
    if (!img || seeded.current) return;
    seeded.current = true;
    setCrop(initial ? clampSpriteCrop(initial, iw, ih) : fullSpriteCrop(iw, ih));
  }, [img, initial, iw, ih]);

  // ---- View (fit + pan/zoom) ----
  const fitView = useCallback((): View => {
    const s = Math.min(VIEWPORT_W / iw, VIEWPORT_H / ih);
    return { scale: s, ox: (VIEWPORT_W - iw * s) / 2, oy: (VIEWPORT_H - ih * s) / 2 };
  }, [iw, ih]);
  const [view, setView] = useState<View>({ scale: 1, ox: 0, oy: 0 });
  useEffect(() => { if (img) setView(fitView()); }, [img, fitView]);
  const fitScale = Math.min(VIEWPORT_W / iw, VIEWPORT_H / ih);
  const zoomAt = useCallback((factor: number, cx: number, cy: number) => {
    setView(v => {
      const ns = clamp(v.scale * factor, fitScale * 0.25, fitScale * 40);
      const sx = (cx - v.ox) / v.scale, sy = (cy - v.oy) / v.scale;
      return { scale: ns, ox: cx - sx * ns, oy: cy - sy * ns };
    });
  }, [fitScale]);

  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Draw: image → dim it all → re-draw the CROPPED region bright → the box + handle.
  // (The image dialog's own "dim outside, redraw inside" rule — it reads at a glance
  // and needs no second colour.)
  useEffect(() => {
    const cv = canvasRef.current; if (!cv || !img) return;
    const ctx = cv.getContext('2d'); if (!ctx) return;
    const { scale, ox, oy } = view;
    ctx.clearRect(0, 0, VIEWPORT_W, VIEWPORT_H);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, ox, oy, iw * scale, ih * scale);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, VIEWPORT_W, VIEWPORT_H);
    const sx = crop.x * scale + ox, sy = crop.y * scale + oy;
    const sw = crop.width * scale, sh = crop.height * scale;
    ctx.drawImage(img, crop.x, crop.y, crop.width, crop.height, sx, sy, sw, sh);
    ctx.strokeStyle = '#f0a020'; ctx.lineWidth = 2;
    ctx.strokeRect(sx, sy, sw, sh);
    ctx.fillStyle = '#f0a020';
    ctx.fillRect(sx + sw - 5, sy + sh - 5, 10, 10);
    if (sw < 16 || sh < 16) {   // too small to grab by its edges — mark the centre
      const mx = sx + sw / 2, my = sy + sh / 2;
      ctx.beginPath();
      ctx.moveTo(mx - 7, my); ctx.lineTo(mx + 7, my);
      ctx.moveTo(mx, my - 7); ctx.lineTo(mx, my + 7);
      ctx.lineWidth = 1.5; ctx.stroke();
    }
  }, [img, iw, ih, view, crop]);

  // Wheel zoom (native + non-passive so the page does not scroll).
  useEffect(() => {
    const cv = canvasRef.current; if (!cv) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = cv.getBoundingClientRect();
      zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - rect.left, e.clientY - rect.top);
    };
    cv.addEventListener('wheel', onWheel, { passive: false });
    return () => cv.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  type Drag =
    | { kind: 'pan'; lastX: number; lastY: number }
    | { kind: 'move'; sx: number; sy: number; ox: number; oy: number }
    | { kind: 'size'; ax: number; ay: number }
    /** Drawing a NEW box from the press point. Provisional until it travels, so a
     *  stray click outside the box does not collapse it to 1×1. */
    | { kind: 'draw'; ax: number; ay: number; sx: number; sy: number; moved: boolean };

  const dragRef = useRef<Drag | null>(null);

  const tryCapture = (el: HTMLCanvasElement, id: number) => {
    try { el.setPointerCapture(id); } catch { /* synthetic pointer — nothing to capture */ }
  };

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!img) return;
    if (e.button === 1 || e.button === 2) {
      tryCapture(e.currentTarget, e.pointerId);
      dragRef.current = { kind: 'pan', lastX: e.clientX, lastY: e.clientY };
      return;
    }
    if (e.button !== 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const cvx = e.clientX - rect.left, cvy = e.clientY - rect.top;      // canvas px
    const px = (cvx - view.ox) / view.scale, py = (cvy - view.oy) / view.scale;  // source px
    // Hit priority: HANDLE → INSIDE (move) → OUTSIDE (draw a new box). The handle is
    // tested in SCREEN space so its grab radius is constant at any zoom.
    const hx = (crop.x + crop.width) * view.scale + view.ox;
    const hy = (crop.y + crop.height) * view.scale + view.oy;
    if (Math.abs(cvx - hx) < HANDLE_HIT && Math.abs(cvy - hy) < HANDLE_HIT) {
      tryCapture(e.currentTarget, e.pointerId);
      dragRef.current = { kind: 'size', ax: crop.x, ay: crop.y };
      return;
    }
    if (px >= crop.x && px < crop.x + crop.width && py >= crop.y && py < crop.y + crop.height) {
      tryCapture(e.currentTarget, e.pointerId);
      dragRef.current = { kind: 'move', sx: cvx, sy: cvy, ox: crop.x, oy: crop.y };
      return;
    }
    tryCapture(e.currentTarget, e.pointerId);
    dragRef.current = { kind: 'draw', ax: px, ay: py, sx: cvx, sy: cvy, moved: false };
  };

  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = dragRef.current; if (!d || !img) return;
    if (d.kind === 'pan') {
      const dx = e.clientX - d.lastX, dy = e.clientY - d.lastY;
      d.lastX = e.clientX; d.lastY = e.clientY;
      setView(v => ({ ...v, ox: v.ox + dx, oy: v.oy + dy }));
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const cvx = e.clientX - rect.left, cvy = e.clientY - rect.top;
    const px = (cvx - view.ox) / view.scale, py = (cvy - view.oy) / view.scale;
    if (d.kind === 'move') {
      // Against the drag's OWN start values, never the live ones, so dragging back
      // and forth lands exactly where it started instead of accumulating rounding.
      setCrop(c => clampSpriteCrop({
        ...c,
        x: Math.round(d.ox + (cvx - d.sx) / view.scale),
        y: Math.round(d.oy + (cvy - d.sy) / view.scale),
      }, iw, ih));
      return;
    }
    if (d.kind === 'size') {
      setCrop(c => clampSpriteCrop({ ...c, width: Math.round(px - d.ax), height: Math.round(py - d.ay) }, iw, ih));
      return;
    }
    if (!d.moved && Math.abs(cvx - d.sx) < DRAG_PX && Math.abs(cvy - d.sy) < DRAG_PX) return;
    d.moved = true;
    const x0 = Math.round(Math.min(d.ax, px)), y0 = Math.round(Math.min(d.ay, py));
    setCrop(clampSpriteCrop({
      x: x0, y: y0,
      width: Math.round(Math.abs(px - d.ax)), height: Math.round(Math.abs(py - d.ay)),
    }, iw, ih));
  };

  const onUp = () => { dragRef.current = null; };

  const isFull = crop.x === 0 && crop.y === 0 && crop.width === iw && crop.height === ih;
  const frameCount = Math.max(1, frameUrls.length);

  const overlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 9000, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', overflow: 'auto', padding: '4vh 12px' };
  const card: React.CSSProperties = { background: 'var(--color-bg-panel, #14161c)', border: '1px solid var(--color-border, #2a3a50)', borderRadius: 8, padding: 16, width: 'min(800px, 96vw)', maxHeight: '92vh', overflow: 'auto', color: 'var(--color-text, #cdd6e0)', boxShadow: '0 8px 40px rgba(0,0,0,0.6)' };
  const btn: React.CSSProperties = { padding: '2px 8px', fontSize: 12, cursor: 'pointer', background: 'var(--color-widget-bg, #1c2028)', color: 'inherit', border: '1px solid var(--color-border, #2a3a50)', borderRadius: 4 };
  const num: React.CSSProperties = { width: 62, background: 'var(--color-widget-bg, #1c2028)', color: 'inherit', border: '1px solid var(--color-border, #2a3a50)', borderRadius: 3, fontSize: 12 };
  const fieldLbl: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#8090a0' };
  const hint: React.CSSProperties = { fontSize: 11, color: '#8090a0' };

  return (
    <div style={overlay} onClick={onCancel} data-sprite-crop-dialog>
      <div style={card} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>{title}</h3>
          <button onClick={onCancel} style={{ background: 'none', border: 'none', color: 'inherit', fontSize: 18, cursor: 'pointer' }} title="Cancel">&times;</button>
        </div>

        {imgError && <div style={{ color: '#e05050', fontSize: 12, marginBottom: 8 }}>Could not load the sprite image.</div>}

        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ flex: '0 0 auto' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <span style={{ ...hint, flex: 1 }}>Image ({iw}×{ih})</span>
              <button style={btn} title="Zoom out" onClick={() => zoomAt(1 / 1.25, VIEWPORT_W / 2, VIEWPORT_H / 2)}>−</button>
              <span style={{ ...hint, minWidth: 40, textAlign: 'center' }}>{Math.round((view.scale / fitScale) * 100)}%</span>
              <button style={btn} title="Zoom in" onClick={() => zoomAt(1.25, VIEWPORT_W / 2, VIEWPORT_H / 2)}>+</button>
              <button style={btn} title="Fit the whole image" onClick={() => setView(fitView())}>Fit</button>
            </div>
            <canvas
              ref={canvasRef} width={VIEWPORT_W} height={VIEWPORT_H}
              style={{ width: VIEWPORT_W, height: VIEWPORT_H, border: '1px solid #2a3a50', touchAction: 'none', cursor: 'crosshair', imageRendering: 'pixelated', background: '#0a0b0e', display: 'block' }}
              onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
              onContextMenu={e => e.preventDefault()}
              title="Drag inside the box to move it, its corner to resize, outside to draw a new one. Drag with the middle/right button to pan, wheel to zoom."
            />
            <div style={{ ...hint, marginTop: 4 }}>
              <span style={{ color: '#f0a020' }}>▭ Crop</span> — drag it to move, its corner to resize, or drag outside to draw a new one.
            </div>
          </div>

          <div style={{ flex: '1 1 230px', minWidth: 220 }}>
            <div style={{ fontSize: 12, color: '#cdd6e0', marginBottom: 6 }}>Crop rectangle (source px)</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <label style={fieldLbl} title="Left edge, in source pixels">
                x
                <NumberField style={num} integer min={0} value={crop.x}
                  onNumber={n => setCrop(c => clampSpriteCrop({ ...c, x: Math.round(n) }, iw, ih))} />
              </label>
              <label style={fieldLbl} title="Top edge, in source pixels">
                y
                <NumberField style={num} integer min={0} value={crop.y}
                  onNumber={n => setCrop(c => clampSpriteCrop({ ...c, y: Math.round(n) }, iw, ih))} />
              </label>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 }}>
              <label style={fieldLbl} title="Width in source pixels">
                w
                <NumberField style={num} integer min={1} value={crop.width}
                  onNumber={n => setCrop(c => clampSpriteCrop({ ...c, width: Math.round(n) }, iw, ih))} />
              </label>
              <label style={fieldLbl} title="Height in source pixels">
                h
                <NumberField style={num} integer min={1} value={crop.height}
                  onNumber={n => setCrop(c => clampSpriteCrop({ ...c, height: Math.round(n) }, iw, ih))} />
              </label>
            </div>
            <div style={{ marginTop: 8 }}>
              <button style={{ ...btn, opacity: isFull ? 0.5 : 1 }} disabled={isFull}
                onClick={() => setCrop(fullSpriteCrop(iw, ih))}
                title="Select the whole image (applying that clears the crop)">Full image</button>
            </div>

            {frameCount > 1 && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 12, color: '#cdd6e0', marginBottom: 4 }}>Frame</div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <button style={btn} disabled={frameIdx === 0} onClick={() => setFrameIdx(i => Math.max(0, i - 1))} title="Previous frame">◂</button>
                  <span style={hint}>{frameIdx + 1} / {frameCount}</span>
                  <button style={btn} disabled={frameIdx >= frameCount - 1} onClick={() => setFrameIdx(i => Math.min(frameCount - 1, i + 1))} title="Next frame">▸</button>
                </div>
                <div style={{ ...hint, marginTop: 4 }}>
                  Judge the box against any frame — the SAME rectangle applies to all of them
                  (clamped per frame if their sizes differ).
                </div>
              </div>
            )}

            <div style={{ ...hint, marginTop: 12 }}>
              The crop is applied when the sprite is decoded, before the background-colour
              removal — so every render path (2D, 3D and the GPU billboards) shows the same
              trimmed art.
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 14 }}>
          <button onClick={() => onApply(null)} style={{ ...btn, padding: '6px 12px' }}
            title="Remove the crop — use the whole image">Clear crop</button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onCancel} style={{ padding: '6px 14px', cursor: 'pointer' }}>Cancel</button>
            <button
              onClick={() => onApply(crop)}
              disabled={!img}
              style={{ padding: '6px 14px', cursor: img ? 'pointer' : 'not-allowed', background: img ? 'var(--color-accent, #4cc9f0)' : '#333', color: img ? '#08121a' : '#888', border: 'none', borderRadius: 4, fontWeight: 600 }}
            >
              Apply
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

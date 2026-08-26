/**
 * SPRITE SHEET dialog — define the sheet's grid AND pick which cells, in which
 * order, are the animation.
 *
 * WHY IT EXISTS: real sprite sheets almost never hold exactly one animation —
 * a walk cycle sits next to an idle pose, a death frame, a door, a UI icon. With
 * only "cols × rows × count" the frames were forced to be a row-major PREFIX of
 * the sheet, so isolating one cycle meant fighting the Set Agent Sprite node's
 * frame/speed inputs to skip the cells you did not want. Selecting the frames
 * here — in order — makes the sprite behave exactly like an imported frame
 * SEQUENCE, so speed becomes trivial again.
 *
 * The geometry and the selection rules both come from `model/spriteSheet.ts`,
 * the same module the decoder slices with, so the grid drawn here and the frames
 * that end up on screen cannot disagree.
 *
 * LAYOUT RULE (inherited from the Map Image to Cells dialog): the viewport is a
 * FIXED size and the card is a fixed width, top-anchored. Sizing either to the
 * image would reflow the card as the content below it grows — that reflow is the
 * drag "feedback loop" that makes a click-to-select gizmo unusable.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SpriteSheetSpec } from '../model/types';
import { NumberField } from '../modeler/vpl/widgets/InlineWidgets';
import {
  derivedCellSize, pruneSheetFrames, sheetCellRect, sheetFrameIndices, sheetGrid,
  sheetWithCellSize, sheetWithFrames,
  type SheetGrid, type SheetRect,
} from '../model/spriteSheet';

/** Source viewport (fixed px) — see the layout rule above. */
const VIEWPORT_W = 460;
const VIEWPORT_H = 400;
/** Hit radius (canvas px) for the first-cell resize handle — screen space, so it
 *  stays grabbable at any zoom. */
const HANDLE_HIT = 11;
/** How far a press on the first cell must travel before it becomes a MOVE rather
 *  than the click that toggles that cell into the animation. */
const GIZMO_DRAG_PX = 3;
/** Strip thumbnail edge (px). */
const THUMB = 40;
/** Cap the rendered strip so a 30×30 sheet selected whole cannot mount 900 canvases. */
const STRIP_MAX = 96;
/** Preview cadence (ms per frame) — a plain readable rate; the ACTUAL speed is
 *  per-agent and logic-driven (the Set Agent Sprite node), so this is a legibility
 *  aid, never a setting. */
const PREVIEW_MS = 140;
const PREVIEW_BOX = 108;

interface View { scale: number; ox: number; oy: number }

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export interface SpriteSheetDialogProps {
  /** The sheet image (a `data:` URL). */
  dataUrl: string;
  /** Starting grid + selection. */
  initial: SpriteSheetSpec;
  /** Dialog title — "Sprite sheet" for an edit, "Import sprite sheet" for a new one. */
  title?: string;
  confirmLabel?: string;
  onApply: (sheet: SpriteSheetSpec) => void;
  onCancel: () => void;
}

export function SpriteSheetDialog({ dataUrl, initial, title = 'Sprite sheet', confirmLabel = 'Apply', onApply, onCancel }: SpriteSheetDialogProps) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [imgError, setImgError] = useState(false);

  // Grid params (live) + the ordered selection, materialised from `initial` so a
  // legacy count-only sheet starts with exactly the frames it had.
  const [cols, setCols] = useState(() => Math.max(1, Math.floor(initial.cols || 1)));
  const [rows, setRows] = useState(() => Math.max(1, Math.floor(initial.rows || 1)));
  const [marginX, setMarginX] = useState(() => Math.max(0, Math.floor(initial.marginX || 0)));
  const [marginY, setMarginY] = useState(() => Math.max(0, Math.floor(initial.marginY || 0)));
  const [spacingX, setSpacingX] = useState(() => Math.max(0, Math.floor(initial.spacingX || 0)));
  const [spacingY, setSpacingY] = useState(() => Math.max(0, Math.floor(initial.spacingY || 0)));
  /** EXPLICIT cell size, or `null` = DERIVED from the image (the historical path).
   *  Kept as a nullable rather than always-a-number so "derived" survives a cols/rows
   *  edit — an explicit size that merely happened to equal the derived one would
   *  otherwise freeze the grid the first time the user touched anything. */
  const [cellW, setCellW] = useState<number | null>(
    () => (Number.isFinite(initial.cellW as number) && (initial.cellW as number) > 0 ? Math.max(1, Math.floor(initial.cellW as number)) : null));
  const [cellH, setCellH] = useState<number | null>(
    () => (Number.isFinite(initial.cellH as number) && (initial.cellH as number) > 0 ? Math.max(1, Math.floor(initial.cellH as number)) : null));
  const [sel, setSel] = useState<number[]>(() => sheetFrameIndices(initial));
  /** How many indices the last grid change dropped (shown once, cleared on edit). */
  const [prunedCount, setPrunedCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const im = new Image();
    im.onload = () => { if (!cancelled) setImg(im); };
    im.onerror = () => { if (!cancelled) setImgError(true); };
    im.src = dataUrl;
    return () => { cancelled = true; };
  }, [dataUrl]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel]);

  const iw = img?.naturalWidth ?? 1, ih = img?.naturalHeight ?? 1;
  const cellCount = cols * rows;

  // The spec the viewport + strip + preview all derive from.
  const spec = useMemo<SpriteSheetSpec>(
    () => ({
      cols, rows, marginX, marginY, spacingX, spacingY,
      ...(cellW !== null ? { cellW } : {}), ...(cellH !== null ? { cellH } : {}),
    }),
    [cols, rows, marginX, marginY, spacingX, spacingY, cellW, cellH],
  );
  const grid: SheetGrid = useMemo(() => sheetGrid(spec, iw, ih), [spec, iw, ih]);
  /** What the size WOULD be with no explicit override — the reset target, and what
   *  the fold compares against. */
  const derived = useMemo(() => derivedCellSize(spec, iw, ih), [spec, iw, ih]);
  const sizeIsExplicit = cellW !== null || cellH !== null;

  /** A grid change can strand indices past the new cell count — DROP them (a clamp
   *  would silently animate the wrong cell) and say how many went.
   *
   *  This is an EFFECT on the LIVE cell count, deliberately, not something the
   *  cols/rows handlers do: those receive the widget's own idea of the new value
   *  and would have to be handed a count computed from the CURRENT render, which
   *  is stale the moment two changes land before a re-render (a held stepper).
   *  Reacting to the resolved count is correct for every path — stepper, typed
   *  value, anything added later — and the `prevCells` guard keeps it a no-op when
   *  only the SELECTION changed. */
  const prevCellsRef = useRef(cols * rows);
  useEffect(() => {
    if (prevCellsRef.current === cellCount) return;
    prevCellsRef.current = cellCount;
    const pruned = pruneSheetFrames(sel, cellCount);
    if (pruned.length !== sel.length) { setSel(pruned); setPrunedCount(sel.length - pruned.length); }
  }, [cellCount, sel]);

  // ---- View (fit + pan/zoom), recomputed when the image lands ----
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

  /** Ordinals per cell — "1,4" when a cell is used twice (a ping-pong loop). */
  const ordinalsByCell = useMemo(() => {
    const m = new Map<number, number[]>();
    sel.forEach((c, i) => { const a = m.get(c); if (a) a.push(i + 1); else m.set(c, [i + 1]); });
    return m;
  }, [sel]);

  // Draw: image → dim the unselected cells → grid lines → selection + ordinals.
  useEffect(() => {
    const cv = canvasRef.current; if (!cv || !img) return;
    const ctx = cv.getContext('2d'); if (!ctx) return;
    const { scale, ox, oy } = view;
    ctx.clearRect(0, 0, VIEWPORT_W, VIEWPORT_H);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, ox, oy, iw * scale, ih * scale);
    // Dim the WHOLE image, then re-draw the selected cells bright — so "what is in
    // the animation" reads at a glance, the way the image dialog marks its region.
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, VIEWPORT_W, VIEWPORT_H);
    const toScreen = (r: SheetRect) => ({ x: r.x * scale + ox, y: r.y * scale + oy, w: r.w * scale, h: r.h * scale });
    for (const cell of ordinalsByCell.keys()) {
      if (cell >= cellCount) continue;
      const r = sheetCellRect(grid, cell), s = toScreen(r);
      ctx.drawImage(img, r.x, r.y, r.w, r.h, s.x, s.y, s.w, s.h);
    }
    // Grid lines (skip when a cell would be sub-pixel — a solid wash helps nobody).
    if (grid.cellW * scale >= 3 && grid.cellH * scale >= 3 && cellCount <= 20000) {
      ctx.strokeStyle = 'rgba(76,201,240,0.45)'; ctx.lineWidth = 1;
      for (let n = 0; n < cellCount; n++) {
        const s = toScreen(sheetCellRect(grid, n));
        ctx.strokeRect(Math.round(s.x) + 0.5, Math.round(s.y) + 0.5, Math.round(s.w) - 1, Math.round(s.h) - 1);
      }
    }
    // Selected cells: accent outline + the ordinal badge(s).
    ctx.lineWidth = 2;
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    for (const [cell, ords] of ordinalsByCell) {
      if (cell >= cellCount) continue;
      const s = toScreen(sheetCellRect(grid, cell));
      ctx.strokeStyle = '#f0a020';
      ctx.strokeRect(s.x + 1, s.y + 1, s.w - 2, s.h - 2);
      const label = ords.join(',');
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(240,160,32,0.92)';
      ctx.fillRect(s.x + 1, s.y + 1, tw + 8, 15);
      ctx.fillStyle = '#14161c';
      ctx.fillText(label, s.x + 5, s.y + 3);
    }
    // THE FIRST-CELL GIZMO — drag its body to move the grid origin (the margins),
    // drag its corner to scale the cell. Drawn LAST so it is never buried under a
    // selection outline, and with a centre cross when the cell is too small to grab
    // by its edges (the image dialog's own rule).
    const g0 = toScreen(sheetCellRect(grid, 0));
    ctx.strokeStyle = '#f0a020'; ctx.lineWidth = 2;
    ctx.strokeRect(g0.x, g0.y, g0.w, g0.h);
    ctx.fillStyle = '#f0a020';
    ctx.fillRect(g0.x + g0.w - 5, g0.y + g0.h - 5, 10, 10);
    if (g0.w < 16 || g0.h < 16) {
      const mx = g0.x + g0.w / 2, my = g0.y + g0.h / 2;
      ctx.beginPath();
      ctx.moveTo(mx - 7, my); ctx.lineTo(mx + 7, my);
      ctx.moveTo(mx, my - 7); ctx.lineTo(mx, my + 7);
      ctx.lineWidth = 1.5; ctx.stroke();
    }
  }, [img, iw, ih, view, grid, cellCount, ordinalsByCell]);

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

  /** Which grid cell a source point is in — or null when it lands in a margin/gap
   *  (the gaps are NOT part of any cell, so a click there must not select one). */
  const cellAt = useCallback((sx: number, sy: number): number | null => {
    const stepX = grid.cellW + grid.spacingX, stepY = grid.cellH + grid.spacingY;
    const c = Math.floor((sx - grid.marginX) / stepX), r = Math.floor((sy - grid.marginY) / stepY);
    if (c < 0 || r < 0 || c >= grid.cols || r >= grid.rows) return null;
    const rect = sheetCellRect(grid, r * grid.cols + c);
    if (sx < rect.x || sx >= rect.x + rect.w || sy < rect.y || sy >= rect.y + rect.h) return null; // in the gap
    return r * grid.cols + c;
  }, [grid]);

  /** Click TOGGLES a cell: absent ⇒ appended to the end of the sequence, present ⇒
   *  every occurrence removed (the rest renumber). Deliberate repeats are added
   *  from the strip's ⧉, so an accidental double-click can never silently create
   *  a duplicate frame. */
  const toggleCell = useCallback((cell: number) => {
    setPrunedCount(0);
    setSel(prev => (prev.includes(cell) ? prev.filter(c => c !== cell) : [...prev, cell]));
  }, []);

  type Drag =
    | { kind: 'pan'; lastX: number; lastY: number }
    /** A press on the first cell's BODY. Provisional: it becomes a grid-origin move
     *  only past `GIZMO_DRAG_PX`; released under that it toggles cell 0. */
    | { kind: 'origin'; sx: number; sy: number; mx: number; my: number; moved: boolean }
    | { kind: 'size'; mx: number; my: number };

  const dragRef = useRef<Drag | null>(null);

  /** Capture only for a real DRAG, and never let it throw: capturing on every press
   *  is what makes this canvas undrivable from a synthetic pointer event, and a
   *  synthetic pointerId the browser never issued throws outright. A drag genuinely
   *  wants capture (the pointer leaves the canvas); a plain click does not. */
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
    const cvx = e.clientX - rect.left, cvy = e.clientY - rect.top;    // canvas px
    const p = { x: (cvx - view.ox) / view.scale, y: (cvy - view.oy) / view.scale }; // source px
    // Hit priority: first-cell HANDLE → first-cell BODY → the existing cell toggle.
    // The handle is tested in SCREEN space so its grab radius is constant at any zoom.
    const c0 = sheetCellRect(grid, 0);
    const hx = (c0.x + c0.w) * view.scale + view.ox, hy = (c0.y + c0.h) * view.scale + view.oy;
    if (Math.abs(cvx - hx) < HANDLE_HIT && Math.abs(cvy - hy) < HANDLE_HIT) {
      tryCapture(e.currentTarget, e.pointerId);
      dragRef.current = { kind: 'size', mx: c0.x, my: c0.y };
      return;
    }
    if (p.x >= c0.x && p.x < c0.x + c0.w && p.y >= c0.y && p.y < c0.y + c0.h) {
      tryCapture(e.currentTarget, e.pointerId);
      dragRef.current = { kind: 'origin', sx: cvx, sy: cvy, mx: marginX, my: marginY, moved: false };
      return;
    }
    const cell = cellAt(p.x, p.y);
    if (cell !== null) toggleCell(cell);
  };

  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = dragRef.current; if (!d) return;
    if (d.kind === 'pan') {
      const dx = e.clientX - d.lastX, dy = e.clientY - d.lastY;
      d.lastX = e.clientX; d.lastY = e.clientY;
      setView(v => ({ ...v, ox: v.ox + dx, oy: v.oy + dy }));
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const cvx = e.clientX - rect.left, cvy = e.clientY - rect.top;
    if (d.kind === 'origin') {
      if (!d.moved && Math.abs(cvx - d.sx) < GIZMO_DRAG_PX && Math.abs(cvy - d.sy) < GIZMO_DRAG_PX) return;
      d.moved = true;
      setPrunedCount(0);
      // Against the drag's OWN start values (never the live ones), so dragging back
      // and forth lands exactly where it started instead of accumulating rounding.
      setMarginX(clamp(Math.round(d.mx + (cvx - d.sx) / view.scale), 0, Math.max(0, iw - 1)));
      setMarginY(clamp(Math.round(d.my + (cvy - d.sy) / view.scale), 0, Math.max(0, ih - 1)));
      return;
    }
    // Resize: the handle IS the cell's bottom-right corner, so the size is just the
    // cursor's offset from the (fixed) origin. Per-axis — sprite cells are rectangular.
    const px = (cvx - view.ox) / view.scale, py = (cvy - view.oy) / view.scale;
    setPrunedCount(0);
    setCellW(clamp(Math.round(px - d.mx), 1, Math.max(1, iw)));
    setCellH(clamp(Math.round(py - d.my), 1, Math.max(1, ih)));
  };

  const onUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    // A press on the first cell that never travelled is a CLICK — toggle cell 0, so
    // the gizmo does not make it the one cell that can never enter the animation.
    if (d && d.kind === 'origin' && !d.moved) toggleCell(0);
  };

  // ---- Selection edits ----
  const allCells = useMemo(() => Array.from({ length: cellCount }, (_, i) => i), [cellCount]);
  const isAll = sel.length === cellCount && sel.every((v, i) => v === i);
  const removeAt = (i: number) => { setPrunedCount(0); setSel(prev => prev.filter((_, k) => k !== i)); };
  const duplicateAt = (i: number) => { setPrunedCount(0); setSel(prev => [...prev.slice(0, i + 1), prev[i]!, ...prev.slice(i + 1)]); };
  const moveAt = (i: number, delta: number) => {
    const j = i + delta;
    setSel(prev => (j < 0 || j >= prev.length ? prev : prev.map((v, k) => (k === i ? prev[j]! : k === j ? prev[i]! : v))));
  };
  /** 0,1,2 → 0,1,2,1 — the classic back-and-forth cycle, which a plain reverse
   *  cannot express (it would repeat the two end frames). */
  const pingPong = () => setSel(prev => [...prev, ...prev.slice(1, -1).reverse()]);

  // ---- Preview (cycles the selection at a fixed legible rate) ----
  const previewRef = useRef<HTMLCanvasElement>(null);
  const [previewIdx, setPreviewIdx] = useState(0);
  useEffect(() => {
    if (sel.length <= 1) { setPreviewIdx(0); return; }
    const t = window.setInterval(() => setPreviewIdx(i => (i + 1) % sel.length), PREVIEW_MS);
    return () => window.clearInterval(t);
  }, [sel.length]);
  useEffect(() => {
    const cv = previewRef.current; if (!cv || !img) return;
    const ctx = cv.getContext('2d'); if (!ctx) return;
    ctx.clearRect(0, 0, cv.width, cv.height);
    const cell = sel[previewIdx % Math.max(1, sel.length)];
    if (cell === undefined || cell >= cellCount) return;
    const r = sheetCellRect(grid, cell);
    const s = Math.min(cv.width / r.w, cv.height / r.h);
    const dw = r.w * s, dh = r.h * s;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, r.x, r.y, r.w, r.h, (cv.width - dw) / 2, (cv.height - dh) / 2, dw, dh);
  }, [img, grid, sel, previewIdx, cellCount]);

  // ---- Styles (module-free, matching the image dialog's chrome) ----
  const overlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 9000, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', overflow: 'auto', padding: '4vh 12px' };
  const card: React.CSSProperties = { background: 'var(--color-bg-panel, #14161c)', border: '1px solid var(--color-border, #2a3a50)', borderRadius: 8, padding: 16, width: 'min(880px, 96vw)', maxHeight: '92vh', overflow: 'auto', color: 'var(--color-text, #cdd6e0)', boxShadow: '0 8px 40px rgba(0,0,0,0.6)' };
  const btn: React.CSSProperties = { padding: '2px 8px', fontSize: 12, cursor: 'pointer', background: 'var(--color-widget-bg, #1c2028)', color: 'inherit', border: '1px solid var(--color-border, #2a3a50)', borderRadius: 4 };
  const num: React.CSSProperties = { width: 54, background: 'var(--color-widget-bg, #1c2028)', color: 'inherit', border: '1px solid var(--color-border, #2a3a50)', borderRadius: 3, fontSize: 12 };
  const fieldLbl: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#8090a0' };
  const hint: React.CSSProperties = { fontSize: 11, color: '#8090a0' };

  const applyDisabled = !img || sel.length === 0;

  return (
    <div style={overlay} onClick={onCancel} data-sprite-sheet-dialog>
      <div style={card} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>{title}</h3>
          <button onClick={onCancel} style={{ background: 'none', border: 'none', color: 'inherit', fontSize: 18, cursor: 'pointer' }} title="Cancel">&times;</button>
        </div>

        {imgError && <div style={{ color: '#e05050', fontSize: 12, marginBottom: 8 }}>Could not load the sheet image.</div>}

        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          {/* Left: the sheet with its grid + the selection. */}
          <div style={{ flex: '0 0 auto' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <span style={{ ...hint, flex: 1 }}>Sheet ({iw}×{ih}) · cell {grid.cellW}×{grid.cellH}</span>
              <button style={btn} title="Zoom out" onClick={() => zoomAt(1 / 1.25, VIEWPORT_W / 2, VIEWPORT_H / 2)}>−</button>
              <span style={{ ...hint, minWidth: 40, textAlign: 'center' }}>{Math.round((view.scale / fitScale) * 100)}%</span>
              <button style={btn} title="Zoom in" onClick={() => zoomAt(1.25, VIEWPORT_W / 2, VIEWPORT_H / 2)}>+</button>
              <button style={btn} title="Fit the whole sheet" onClick={() => setView(fitView())}>Fit</button>
            </div>
            <canvas
              ref={canvasRef} width={VIEWPORT_W} height={VIEWPORT_H}
              style={{ width: VIEWPORT_W, height: VIEWPORT_H, border: '1px solid #2a3a50', touchAction: 'none', cursor: 'pointer', imageRendering: 'pixelated', background: '#0a0b0e', display: 'block' }}
              onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
              onContextMenu={e => e.preventDefault()}
              title="Click a cell to add it to the animation (click again to remove it). Drag the orange first cell to move the grid, its corner to resize the cells. Drag with the middle/right button to pan, wheel to zoom."
            />
            <div style={{ ...hint, marginTop: 4 }}>
              Click a cell to add it as the next frame; click a selected cell to remove it. The number on a
              cell is its position in the animation.<br />
              <span style={{ color: '#f0a020' }}>▭ First cell</span> — drag it to align the grid (sets the margin), drag its corner to resize the cells.
            </div>
          </div>

          {/* Right: grid params + preview. */}
          <div style={{ flex: '1 1 260px', minWidth: 240 }}>
            <div style={{ fontSize: 12, color: '#cdd6e0', marginBottom: 6 }}>Grid</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <label style={fieldLbl} title="Columns of cells in the sheet">
                cols
                <NumberField style={num} integer min={1} value={cols}
                  onNumber={n => setCols(Math.max(1, Math.round(n)))} />
              </label>
              <label style={fieldLbl} title="Rows of cells in the sheet">
                rows
                <NumberField style={num} integer min={1} value={rows}
                  onNumber={n => setRows(Math.max(1, Math.round(n)))} />
              </label>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 }} title="Pixel offset from the image's top-left to the first cell">
              <span style={hint}>margin</span>
              <NumberField style={num} integer min={0} value={marginX} onNumber={n => { setPrunedCount(0); setMarginX(Math.max(0, Math.round(n))); }} title="Margin X" />
              <NumberField style={num} integer min={0} value={marginY} onNumber={n => { setPrunedCount(0); setMarginY(Math.max(0, Math.round(n))); }} title="Margin Y" />
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 }}
              title="Cell size in image pixels. Empty of an override this is DERIVED from the image, the margins and the gaps — set it (or drag the orange cell's corner) when the sheet has dead space on the right/bottom.">
              <span style={hint}>cell</span>
              <NumberField style={num} integer min={1} value={grid.cellW}
                onNumber={n => { setPrunedCount(0); setCellW(clamp(Math.round(n), 1, Math.max(1, iw))); }} title="Cell width" />
              <NumberField style={num} integer min={1} value={grid.cellH}
                onNumber={n => { setPrunedCount(0); setCellH(clamp(Math.round(n), 1, Math.max(1, ih))); }} title="Cell height" />
              <button style={{ ...btn, visibility: sizeIsExplicit ? 'visible' : 'hidden' }}
                onClick={() => { setPrunedCount(0); setCellW(null); setCellH(null); }}
                title={`Back to the derived size (${derived.cellW}×${derived.cellH})`}>↺</button>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 }} title="Pixel gap between adjacent cells">
              <span style={hint}>gap</span>
              <NumberField style={num} integer min={0} value={spacingX} onNumber={n => { setPrunedCount(0); setSpacingX(Math.max(0, Math.round(n))); }} title="Spacing X" />
              <NumberField style={num} integer min={0} value={spacingY} onNumber={n => { setPrunedCount(0); setSpacingY(Math.max(0, Math.round(n))); }} title="Spacing Y" />
            </div>
            {prunedCount > 0 && (
              <div style={{ color: '#e0a050', fontSize: 11, marginTop: 6 }}>
                The smaller grid dropped {prunedCount} selected frame{prunedCount === 1 ? '' : 's'}.
              </div>
            )}

            <div style={{ fontSize: 12, color: '#cdd6e0', margin: '12px 0 6px' }}>Preview</div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <canvas ref={previewRef} width={PREVIEW_BOX} height={PREVIEW_BOX}
                style={{ width: PREVIEW_BOX, height: PREVIEW_BOX, border: '1px solid #2a3a50', imageRendering: 'pixelated', background: 'repeating-conic-gradient(#1a1c22 0% 25%, #24262e 0% 50%) 50% / 12px 12px', display: 'block' }} />
              <div style={hint}>
                {sel.length === 0
                  ? 'No frames selected.'
                  : <>frame {(previewIdx % sel.length) + 1} / {sel.length}<br />(cell {sel[previewIdx % sel.length]})</>}
              </div>
            </div>
          </div>
        </div>

        {/* The ordered frame strip — the sequence, and where individual frames are
            removed / repeated / nudged. */}
        <div style={{ marginTop: 12, borderTop: '1px solid #2a3a50', paddingTop: 10 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
            <span style={{ fontSize: 12, color: '#cdd6e0' }}>Frames ({sel.length} of {cellCount} cells)</span>
            <button style={btn} disabled={isAll} title="Use every cell, row-major"
              onClick={() => { setPrunedCount(0); setSel(allCells); }}>Select all</button>
            <button style={btn} disabled={sel.length < 2} title="Play the sequence backwards"
              onClick={() => { setPrunedCount(0); setSel(prev => [...prev].reverse()); }}>Reverse</button>
            <button style={btn} disabled={sel.length < 3} title="Append the sequence back to its start (0,1,2 → 0,1,2,1)"
              onClick={() => { setPrunedCount(0); pingPong(); }}>Ping-pong</button>
            <button style={btn} disabled={sel.length === 0} title="Remove every frame"
              onClick={() => { setPrunedCount(0); setSel([]); }}>Clear</button>
          </div>
          {sel.length === 0 ? (
            <div style={{ ...hint, fontStyle: 'italic' }}>Click cells in the sheet to build the animation.</div>
          ) : (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {sel.slice(0, STRIP_MAX).map((cell, i) => (
                <StripEntry
                  key={`${i}:${cell}`} img={img} grid={grid} cell={cell} ordinal={i + 1}
                  onRemove={() => removeAt(i)} onDuplicate={() => duplicateAt(i)}
                  onLeft={i > 0 ? () => moveAt(i, -1) : undefined}
                  onRight={i < sel.length - 1 ? () => moveAt(i, 1) : undefined}
                />
              ))}
              {sel.length > STRIP_MAX && <span style={{ ...hint, alignSelf: 'center' }}>+{sel.length - STRIP_MAX} more</span>}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <button onClick={onCancel} style={{ padding: '6px 14px', cursor: 'pointer' }}>Cancel</button>
          <button
            // Both folds, so a spec only ever carries what it genuinely needs: a
            // row-major selection keeps the legacy `count` shape, and a cell size
            // that equals the derived one is not stored at all.
            onClick={() => onApply(sheetWithCellSize(sheetWithFrames({ ...spec }, sel), cellW, cellH, iw, ih))}
            disabled={applyDisabled}
            style={{ padding: '6px 14px', cursor: applyDisabled ? 'not-allowed' : 'pointer', background: applyDisabled ? '#333' : 'var(--color-accent, #4cc9f0)', color: applyDisabled ? '#888' : '#08121a', border: 'none', borderRadius: 4, fontWeight: 600 }}
            title={applyDisabled ? 'Select at least one frame.' : undefined}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** One frame of the ordered strip: its thumbnail + position, with the per-frame
 *  edits (remove / repeat / nudge) that clicking cells cannot express. */
function StripEntry({ img, grid, cell, ordinal, onRemove, onDuplicate, onLeft, onRight }: {
  img: HTMLImageElement | null;
  grid: SheetGrid;
  cell: number;
  ordinal: number;
  onRemove: () => void;
  onDuplicate: () => void;
  onLeft?: () => void;
  onRight?: () => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current; if (!cv || !img) return;
    const ctx = cv.getContext('2d'); if (!ctx) return;
    ctx.clearRect(0, 0, THUMB, THUMB);
    const r = sheetCellRect(grid, cell);
    const s = Math.min(THUMB / r.w, THUMB / r.h);
    const dw = r.w * s, dh = r.h * s;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, r.x, r.y, r.w, r.h, (THUMB - dw) / 2, (THUMB - dh) / 2, dw, dh);
  }, [img, grid, cell]);
  const mini: React.CSSProperties = { padding: '0 3px', fontSize: 10, lineHeight: '13px', cursor: 'pointer', background: 'var(--color-widget-bg, #1c2028)', color: 'inherit', border: '1px solid var(--color-border, #2a3a50)', borderRadius: 3 };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }} title={`Frame ${ordinal} — cell ${cell}`}>
      <div style={{ position: 'relative' }}>
        <canvas ref={ref} width={THUMB} height={THUMB}
          style={{ width: THUMB, height: THUMB, border: '1px solid #2a3a50', imageRendering: 'pixelated', background: '#0a0b0e', display: 'block' }} />
        <span style={{ position: 'absolute', top: 0, left: 0, background: 'rgba(240,160,32,0.92)', color: '#14161c', fontSize: 9, fontWeight: 700, padding: '0 3px', borderRadius: '0 0 3px 0' }}>{ordinal}</span>
      </div>
      <div style={{ display: 'flex', gap: 2 }}>
        <button style={{ ...mini, visibility: onLeft ? 'visible' : 'hidden' }} onClick={onLeft} title="Move earlier">◂</button>
        <button style={mini} onClick={onDuplicate} title="Repeat this frame (hold it longer / build a cycle)">⧉</button>
        <button style={mini} onClick={onRemove} title="Remove this frame">×</button>
        <button style={{ ...mini, visibility: onRight ? 'visible' : 'hidden' }} onClick={onRight} title="Move later">▸</button>
      </div>
    </div>
  );
}

import { useMemo, useRef, useState, useEffect, useCallback } from 'react';
import type { Attribute, Mapping, Neighborhood } from '../model/types';
import { NumberField } from '../modeler/vpl/widgets/InlineWidgets';
import { ManualBrushPanel } from './ManualBrushPanel';
import type { ManualBrushModelState } from './SimulatorView';
import { gridifyImage, gridLayout, type ImageSampleOptions } from './imageMapping';

export interface ImageMappingConfig {
  region: { x: number; y: number; w: number; h: number };
  cellSize: number;
  cellOriginX: number;
  cellOriginY: number;
  average: boolean;
  invert: boolean;
  binarize: boolean;
  threshold: number;
  mode: 'resize' | 'center';
  mappingId: string;
  useManual: boolean;
  manualState: ManualBrushModelState;
  /** The sampled grid (computed at Apply). */
  cols: number;
  rows: number;
  pixels: Uint8ClampedArray;
  mask: Uint8Array;
}

/** Left source viewport (fixed square, px). Fixed so the card never reflows as
 *  the region/preview changes — that reflow was the drag "feedback loop". */
const VIEWPORT = 460;
/** Right preview box (fixed square, px). */
const PREVIEW_BOX = 280;
const HANDLE_HIT = 11; // px hit radius for the corner resize handles

interface View { scale: number; ox: number; oy: number }

type Drag =
  | { kind: 'move' | 'resize' | 'new'; sx: number; sy: number; orig: { x: number; y: number; w: number; h: number } }
  | { kind: 'cellMove'; sx: number; sy: number; oCell: { x: number; y: number } }
  | { kind: 'cellResize'; oCell: { x: number; y: number } }
  | { kind: 'pan'; lastX: number; lastY: number };

/** The "Mapping Cells" dialog — segment a source image into grid cells and map
 *  them onto the simulation via a Colour→Attribute mapping (or the manual brush).
 *  Left pane = a pannable/zoomable source viewport with the included-area box
 *  (blue) + a cell-alignment reference square (orange); right pane = the
 *  resulting gridified preview. */
export function ImageMappingDialog({
  img, cellAttributes, neighborhoods, colorToAttrMappings, is3d, gridWidth, gridHeight, initialUseManual, onApply, onCancel,
}: {
  img: HTMLImageElement;
  cellAttributes: Attribute[];
  neighborhoods: Neighborhood[];
  colorToAttrMappings: Mapping[];
  is3d: boolean;
  gridWidth: number;
  gridHeight: number;
  /** Pre-select the manual input-mapping path (opened from the Manual brush tab). */
  initialUseManual?: boolean;
  onApply: (cfg: ImageMappingConfig) => void;
  onCancel: () => void;
}) {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;

  // Sampling ImageData built once from the source image.
  const srcData = useMemo(() => {
    const cv = document.createElement('canvas');
    cv.width = iw; cv.height = ih;
    const ctx = cv.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, iw, ih);
  }, [img, iw, ih]);

  const [region, setRegion] = useState({ x: 0, y: 0, w: iw, h: ih });
  // Default cell size: aim for ~64 cells on the long axis (user can set 1 for 1:1).
  const [cellSize, setCellSize] = useState(() => Math.max(1, Math.round(Math.max(iw, ih) / 64)));
  // Grid alignment anchor (the "cell reference" square top-left). Defaults to the
  // region origin — i.e. the grid tiles from the top-left, as before.
  const [cellOrigin, setCellOrigin] = useState({ x: 0, y: 0 });
  const [average, setAverage] = useState(false);
  const [invert, setInvert] = useState(false);
  const [binarize, setBinarize] = useState(false);
  const [threshold, setThreshold] = useState(128);
  const [mode, setMode] = useState<'resize' | 'center'>('resize');
  const [useManual, setUseManual] = useState(initialUseManual || colorToAttrMappings.length === 0);
  const [mappingId, setMappingId] = useState(colorToAttrMappings[0]?.id ?? '');
  const [manualState, setManualState] = useState<ManualBrushModelState>(() => {
    const s: ManualBrushModelState = {};
    for (const a of cellAttributes) s[a.id] = { enabled: true, value: a.defaultValue ?? '' };
    return s;
  });

  const opts: ImageSampleOptions = {
    region, cellSize, cellOriginX: cellOrigin.x, cellOriginY: cellOrigin.y,
    average, invert, binarize: binarize || useManual, threshold,
  };
  const { gx, gy, cols, rows } = gridLayout(region, cellSize, cellOrigin.x, cellOrigin.y);

  // Zoom/pan affine for the left viewport: canvasX = srcX * scale + ox.
  const fitScale = Math.min(VIEWPORT / iw, VIEWPORT / ih);
  const minScale = fitScale * 0.5;
  const maxScale = Math.max(fitScale * 8, 40);
  const fitView = useCallback((): View => ({ scale: fitScale, ox: (VIEWPORT - iw * fitScale) / 2, oy: (VIEWPORT - ih * fitScale) / 2 }), [fitScale, iw, ih]);
  const [view, setView] = useState<View>(fitView);
  useEffect(() => { setView(fitView()); }, [fitView]); // reset on new image

  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const zoomAt = (factor: number, cx: number, cy: number) => setView(v => {
    const ns = clamp(v.scale * factor, minScale, maxScale);
    const sx = (cx - v.ox) / v.scale, sy = (cy - v.oy) / v.scale;
    return { scale: ns, ox: cx - sx * ns, oy: cy - sy * ns };
  });

  const leftCanvasRef = useRef<HTMLCanvasElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);

  // Draw the source image (zoomed/panned) + dim-outside-region + cell grid + boxes.
  useEffect(() => {
    const cv = leftCanvasRef.current; if (!cv) return;
    const ctx = cv.getContext('2d')!;
    const { scale, ox, oy } = view;
    ctx.clearRect(0, 0, VIEWPORT, VIEWPORT);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, ox, oy, iw * scale, ih * scale);
    // Dim everything, then re-draw the included region at full brightness.
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(0, 0, VIEWPORT, VIEWPORT);
    const rxs = region.x * scale + ox, rys = region.y * scale + oy, rws = region.w * scale, rhs = region.h * scale;
    ctx.drawImage(img, region.x, region.y, region.w, region.h, rxs, rys, rws, rhs);
    // Cell grid lines (from the anchored grid origin; skip when too dense).
    const cellDisp = cellSize * scale;
    if (cellDisp >= 3 && cols * rows <= 20000 && cols > 0 && rows > 0) {
      const gxs = gx * scale + ox, gys = gy * scale + oy;
      ctx.strokeStyle = 'rgba(76,201,240,0.35)'; ctx.lineWidth = 0.5;
      ctx.beginPath();
      for (let c = 0; c <= cols; c++) { const x = gxs + c * cellDisp; ctx.moveTo(x, gys); ctx.lineTo(x, gys + rows * cellDisp); }
      for (let r = 0; r <= rows; r++) { const y = gys + r * cellDisp; ctx.moveTo(gxs, y); ctx.lineTo(gxs + cols * cellDisp, y); }
      ctx.stroke();
    }
    // Region box (blue) + resize handle.
    ctx.strokeStyle = '#4cc9f0'; ctx.lineWidth = 1.5;
    ctx.strokeRect(rxs, rys, rws, rhs);
    ctx.fillStyle = '#4cc9f0';
    ctx.fillRect(rxs + rws - 5, rys + rhs - 5, 9, 9);
    // Cell reference square (orange) + resize handle + centre cross (findable when tiny).
    const ccx = cellOrigin.x * scale + ox, ccy = cellOrigin.y * scale + oy, ccs = cellSize * scale;
    ctx.strokeStyle = '#f0a020'; ctx.lineWidth = 1.5;
    ctx.strokeRect(ccx, ccy, ccs, ccs);
    ctx.fillStyle = '#f0a020';
    ctx.fillRect(ccx + ccs - 5, ccy + ccs - 5, 9, 9);
    if (ccs < 14) {
      ctx.beginPath();
      const mx = ccx + ccs / 2, my = ccy + ccs / 2;
      ctx.moveTo(mx - 7, my); ctx.lineTo(mx + 7, my); ctx.moveTo(mx, my - 7); ctx.lineTo(mx, my + 7); ctx.stroke();
    }
  }, [img, iw, ih, view, region, cellSize, cellOrigin, gx, gy, cols, rows]);

  // Draw the gridified preview.
  useEffect(() => {
    const cv = previewCanvasRef.current; if (!cv) return;
    const g = gridifyImage(srcData, opts);
    const scale = cols > 0 && rows > 0 ? Math.max(1, Math.floor(Math.min(PREVIEW_BOX / cols, PREVIEW_BOX / rows))) : 1;
    const pw = Math.max(1, cols * scale), ph = Math.max(1, rows * scale);
    cv.width = pw; cv.height = ph;
    const ctx = cv.getContext('2d')!;
    ctx.clearRect(0, 0, pw, ph);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const o = (r * cols + c) * 4;
        ctx.fillStyle = `rgba(${g.pixels[o]},${g.pixels[o + 1]},${g.pixels[o + 2]},${(g.pixels[o + 3] ?? 255) / 255})`;
        ctx.fillRect(c * scale, r * scale, scale, scale);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcData, region, cellSize, cellOrigin, average, invert, binarize, useManual, threshold, cols, rows]);

  // Wheel-to-zoom (native, non-passive so we can preventDefault the page scroll).
  useEffect(() => {
    const cv = leftCanvasRef.current; if (!cv) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = cv.getBoundingClientRect();
      zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - rect.left, e.clientY - rect.top);
    };
    cv.addEventListener('wheel', onWheel, { passive: false });
    return () => cv.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minScale, maxScale]);

  // Pointer interaction: pan (MMB/RMB) / gizmos + region (LMB) on the left canvas.
  const dragRef = useRef<Drag | null>(null);
  const toSrc = (clientX: number, clientY: number, el: HTMLCanvasElement) => {
    const rect = el.getBoundingClientRect();
    return { x: (clientX - rect.left - view.ox) / view.scale, y: (clientY - rect.top - view.oy) / view.scale };
  };
  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const el = e.currentTarget; el.setPointerCapture(e.pointerId);
    if (e.button === 1 || e.button === 2) { // middle / right → pan
      dragRef.current = { kind: 'pan', lastX: e.clientX, lastY: e.clientY };
      return;
    }
    if (e.button !== 0) return;
    const rect = el.getBoundingClientRect();
    const cvx = e.clientX - rect.left, cvy = e.clientY - rect.top; // cursor in canvas px
    const { scale, ox, oy } = view;
    const p = { x: (cvx - ox) / scale, y: (cvy - oy) / scale };
    // Gizmo corners in canvas px (hit-test in screen space for a consistent radius).
    const cellHX = (cellOrigin.x + cellSize) * scale + ox, cellHY = (cellOrigin.y + cellSize) * scale + oy;
    const cellInside = p.x >= cellOrigin.x && p.x <= cellOrigin.x + cellSize && p.y >= cellOrigin.y && p.y <= cellOrigin.y + cellSize;
    const regHX = (region.x + region.w) * scale + ox, regHY = (region.y + region.h) * scale + oy;
    const regInside = p.x >= region.x && p.x <= region.x + region.w && p.y >= region.y && p.y <= region.y + region.h;
    // Priority: cell handle → cell body → region handle → region body → draw-new.
    if (Math.abs(cvx - cellHX) < HANDLE_HIT && Math.abs(cvy - cellHY) < HANDLE_HIT) {
      dragRef.current = { kind: 'cellResize', oCell: { ...cellOrigin } };
    } else if (cellInside) {
      dragRef.current = { kind: 'cellMove', sx: p.x, sy: p.y, oCell: { ...cellOrigin } };
    } else if (Math.abs(cvx - regHX) < HANDLE_HIT && Math.abs(cvy - regHY) < HANDLE_HIT) {
      dragRef.current = { kind: 'resize', sx: p.x, sy: p.y, orig: region };
    } else if (regInside) {
      dragRef.current = { kind: 'move', sx: p.x, sy: p.y, orig: region };
    } else {
      dragRef.current = { kind: 'new', sx: p.x, sy: p.y, orig: region };
      setRegion({ x: Math.round(p.x), y: Math.round(p.y), w: 1, h: 1 });
    }
  };
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = dragRef.current; if (!d) return;
    if (d.kind === 'pan') {
      const dx = e.clientX - d.lastX, dy = e.clientY - d.lastY;
      d.lastX = e.clientX; d.lastY = e.clientY;
      setView(v => ({ ...v, ox: v.ox + dx, oy: v.oy + dy }));
      return;
    }
    const p = toSrc(e.clientX, e.clientY, e.currentTarget);
    const px = Math.round(p.x), py = Math.round(p.y);
    if (d.kind === 'cellMove') {
      setCellOrigin({ x: clamp(d.oCell.x + (px - Math.round(d.sx)), 0, iw - 1), y: clamp(d.oCell.y + (py - Math.round(d.sy)), 0, ih - 1) });
    } else if (d.kind === 'cellResize') {
      const s = Math.max(1, Math.round(Math.max(px - d.oCell.x, py - d.oCell.y)));
      setCellSize(clamp(s, 1, Math.min(iw, ih)));
    } else if (d.kind === 'move') {
      const nx = clamp(d.orig.x + (px - Math.round(d.sx)), 0, iw - d.orig.w);
      const ny = clamp(d.orig.y + (py - Math.round(d.sy)), 0, ih - d.orig.h);
      setRegion({ ...d.orig, x: nx, y: ny });
    } else if (d.kind === 'resize') {
      const nw = clamp(d.orig.w + (px - Math.round(d.sx)), 1, iw - d.orig.x);
      const nh = clamp(d.orig.h + (py - Math.round(d.sy)), 1, ih - d.orig.y);
      setRegion({ ...d.orig, w: nw, h: nh });
    } else {
      // Draw-new: clamp origin into the image and extent to the remaining size.
      const x0 = clamp(Math.min(Math.round(d.sx), px), 0, iw - 1), y0 = clamp(Math.min(Math.round(d.sy), py), 0, ih - 1);
      const w = Math.max(1, Math.min(Math.abs(px - Math.round(d.sx)), iw - x0));
      const h = Math.max(1, Math.min(Math.abs(py - Math.round(d.sy)), ih - y0));
      setRegion({ x: x0, y: y0, w, h });
    }
  };
  const onUp = () => { dragRef.current = null; };

  const setRegionField = (k: 'x' | 'y' | 'w' | 'h', v: number) => {
    const n = Math.max(k === 'w' || k === 'h' ? 1 : 0, Math.round(v));
    setRegion(r => {
      const nr = { ...r, [k]: n };
      nr.x = Math.min(nr.x, iw - 1); nr.y = Math.min(nr.y, ih - 1);
      nr.w = Math.min(nr.w, iw - nr.x); nr.h = Math.min(nr.h, ih - nr.y);
      return nr;
    });
  };

  // Overlay is top-anchored (not vertically centred) and the card is fixed-width,
  // so the left canvas's screen rect never shifts as content below grows — this
  // is what breaks the drag feedback loop.
  const overlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 9000, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', overflow: 'auto', padding: '4vh 12px' };
  const card: React.CSSProperties = { background: 'var(--color-bg-panel, #14161c)', border: '1px solid var(--color-border, #2a3a50)', borderRadius: 8, padding: 16, width: 'min(1000px, 96vw)', maxHeight: '92vh', overflow: 'auto', color: 'var(--color-text, #cdd6e0)', boxShadow: '0 8px 40px rgba(0,0,0,0.6)' };
  const label: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' };
  const zoomBtn: React.CSSProperties = { padding: '2px 8px', fontSize: 12, cursor: 'pointer', background: 'var(--color-widget-bg, #1c2028)', color: 'inherit', border: '1px solid var(--color-border, #2a3a50)', borderRadius: 4 };
  const chipRow: React.CSSProperties = { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginTop: 10, fontSize: 12 };

  const applyDisabled = cols < 1 || rows < 1 || (!useManual && !mappingId) || (mode === 'center' && (cols > gridWidth || rows > gridHeight));

  const handleApply = () => {
    const g = gridifyImage(srcData, opts);
    onApply({ region, cellSize, cellOriginX: cellOrigin.x, cellOriginY: cellOrigin.y, average, invert, binarize, threshold, mode, mappingId, useManual, manualState, cols: g.cols, rows: g.rows, pixels: g.pixels, mask: g.mask });
  };

  return (
    <div style={overlay} onClick={onCancel}>
      <div style={card} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>Map Image to Cells</h3>
          <button onClick={onCancel} style={{ background: 'none', border: 'none', color: 'inherit', fontSize: 18, cursor: 'pointer' }} title="Cancel">&times;</button>
        </div>

        {is3d && (
          <div style={{ color: '#e0a050', fontSize: 12, marginBottom: 8 }}>
            Note: image mapping targets a 2D grid; in a 3D model it maps onto layer 0.
          </div>
        )}

        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
          {/* Left: pannable/zoomable source viewport. */}
          <div style={{ flex: '0 0 auto' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <span style={{ fontSize: 11, color: '#8090a0', flex: 1 }}>Source ({iw}×{ih})</span>
              <button style={zoomBtn} title="Zoom out" onClick={() => zoomAt(1 / 1.25, VIEWPORT / 2, VIEWPORT / 2)}>−</button>
              <span style={{ fontSize: 11, color: '#8090a0', minWidth: 40, textAlign: 'center' }}>{Math.round((view.scale / fitScale) * 100)}%</span>
              <button style={zoomBtn} title="Zoom in" onClick={() => zoomAt(1.25, VIEWPORT / 2, VIEWPORT / 2)}>+</button>
              <button style={zoomBtn} title="Fit whole image" onClick={() => setView(fitView())}>Fit</button>
            </div>
            <canvas ref={leftCanvasRef} width={VIEWPORT} height={VIEWPORT}
              style={{ width: VIEWPORT, height: VIEWPORT, border: '1px solid #2a3a50', touchAction: 'none', cursor: 'crosshair', imageRendering: 'pixelated', background: '#0a0b0e', display: 'block' }}
              onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
              onContextMenu={e => e.preventDefault()} />
            <div style={{ fontSize: 10.5, color: '#8090a0', marginTop: 4, lineHeight: 1.5 }}>
              <span style={{ color: '#4cc9f0' }}>▭ Included area</span> — drag to move, corner to resize, empty to redraw.<br />
              <span style={{ color: '#f0a020' }}>▭ Cell reference</span> — sets cell size + grid alignment (drag it, corner resizes).<br />
              Wheel = zoom · middle/right-drag = pan.
            </div>
          </div>

          {/* Right: preview + all controls. */}
          <div style={{ flex: '1 1 auto', minWidth: 0 }}>
            <div style={{ fontSize: 11, color: '#8090a0', marginBottom: 4 }}>Result grid ({cols}×{rows})</div>
            <div style={{ width: PREVIEW_BOX, height: PREVIEW_BOX, border: '1px solid #2a3a50', background: '#0a0b0e', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
              <canvas ref={previewCanvasRef} style={{ imageRendering: 'pixelated', maxWidth: PREVIEW_BOX, maxHeight: PREVIEW_BOX }} />
            </div>

            {/* Region + cell numeric controls. */}
            <div style={chipRow}>
              <span style={{ color: '#4cc9f0' }}>Area</span>
              {(['x', 'y', 'w', 'h'] as const).map(k => (
                <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                  {k}<NumberField integer min={k === 'w' || k === 'h' ? 1 : 0} style={{ width: 54 }} value={region[k]} onNumber={v => setRegionField(k, v)} />
                </label>
              ))}
            </div>
            <div style={chipRow}>
              <span style={{ color: '#f0a020' }}>Cell</span>
              <label style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                size<NumberField integer min={1} style={{ width: 54 }} value={cellSize} onNumber={v => setCellSize(Math.max(1, Math.round(v)))} />
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                x<NumberField integer min={0} style={{ width: 54 }} value={cellOrigin.x} onNumber={v => setCellOrigin(o => ({ ...o, x: clamp(Math.round(v), 0, iw - 1) }))} />
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                y<NumberField integer min={0} style={{ width: 54 }} value={cellOrigin.y} onNumber={v => setCellOrigin(o => ({ ...o, y: clamp(Math.round(v), 0, ih - 1) }))} />
              </label>
              <button style={zoomBtn} title="Align the cell reference to the area's top-left corner" onClick={() => setCellOrigin({ x: region.x, y: region.y })}>Align to area</button>
            </div>

            {/* Options. */}
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 10 }}>
              <label style={label}><input type="checkbox" checked={average} onChange={e => setAverage(e.target.checked)} /> Average pixels inside cell</label>
              <label style={label}><input type="checkbox" checked={invert} onChange={e => setInvert(e.target.checked)} /> Invert image</label>
              <label style={label}><input type="checkbox" checked={binarize} onChange={e => setBinarize(e.target.checked)} /> Binarize image</label>
            </div>
            {(binarize || useManual) && (
              <label style={{ ...label, gap: 8, marginTop: 8 }}>
                Threshold {threshold}
                <input type="range" min={0} max={255} value={threshold} onChange={e => setThreshold(Number(e.target.value))} />
              </label>
            )}

            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 10, alignItems: 'center' }}>
              <span style={{ fontSize: 12, color: '#8090a0' }}>Fit:</span>
              <label style={label}><input type="radio" checked={mode === 'resize'} onChange={() => setMode('resize')} /> Resize simulation grid</label>
              <label style={label}><input type="radio" checked={mode === 'center'} onChange={() => setMode('center')} /> Paste centered</label>
              {mode === 'center' && (cols > gridWidth || rows > gridHeight) && (
                <span style={{ color: '#e05050', fontSize: 11 }}>Grid ({cols}×{rows}) exceeds simulation ({gridWidth}×{gridHeight}).</span>
              )}
            </div>

            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 10, alignItems: 'center' }}>
              <label style={label}>
                <input type="checkbox" checked={useManual} onChange={e => setUseManual(e.target.checked)} /> Use manual input mapping
              </label>
              {!useManual && (
                <label style={{ ...label, gap: 6 }}>
                  Input mapping
                  <select value={mappingId} onChange={e => setMappingId(e.target.value)} style={{ fontSize: 12 }}>
                    {colorToAttrMappings.length === 0 && <option value="">(no C→A mappings)</option>}
                    {colorToAttrMappings.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                </label>
              )}
            </div>
          </div>
        </div>

        {useManual && (
          <div style={{ marginTop: 8, borderTop: '1px solid #2a3a50', paddingTop: 8 }}>
            <div style={{ fontSize: 11, color: '#8090a0', marginBottom: 4 }}>
              Binarize-true cells are painted with these attribute values (like clicking the manual brush on each):
            </div>
            <ManualBrushPanel cellAttributes={cellAttributes} neighborhoods={neighborhoods} state={manualState} onChange={setManualState} is3d={is3d} />
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <button onClick={onCancel} style={{ padding: '6px 14px', cursor: 'pointer' }}>Cancel</button>
          <button onClick={handleApply} disabled={applyDisabled}
            style={{ padding: '6px 14px', cursor: applyDisabled ? 'not-allowed' : 'pointer', background: applyDisabled ? '#333' : 'var(--color-accent, #4cc9f0)', color: applyDisabled ? '#888' : '#08121a', border: 'none', borderRadius: 4, fontWeight: 600 }}>
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}

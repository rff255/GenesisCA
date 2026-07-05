import { useMemo, useRef, useState, useEffect } from 'react';
import type { Attribute, Mapping, Neighborhood } from '../model/types';
import { NumberField } from '../modeler/vpl/widgets/InlineWidgets';
import { ManualBrushPanel } from './ManualBrushPanel';
import type { ManualBrushModelState } from './SimulatorView';
import { gridifyImage, gridDims, type ImageSampleOptions } from './imageMapping';

export interface ImageMappingConfig {
  region: { x: number; y: number; w: number; h: number };
  cellSize: number;
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

const DISPLAY_MAX = 340;
const PREVIEW_MAX = 340;

/** The "Mapping Cells" dialog — segment a source image into grid cells and map
 *  them onto the simulation via a Colour→Attribute mapping (or the manual brush).
 *  Left pane = the source image with a draggable/resizable region box + a cell
 *  grid overlay; right pane = the resulting gridified preview. */
export function ImageMappingDialog({
  img, cellAttributes, neighborhoods, colorToAttrMappings, is3d, gridWidth, gridHeight, onApply, onCancel,
}: {
  img: HTMLImageElement;
  cellAttributes: Attribute[];
  neighborhoods: Neighborhood[];
  colorToAttrMappings: Mapping[];
  is3d: boolean;
  gridWidth: number;
  gridHeight: number;
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
  const [average, setAverage] = useState(false);
  const [invert, setInvert] = useState(false);
  const [binarize, setBinarize] = useState(false);
  const [threshold, setThreshold] = useState(128);
  const [mode, setMode] = useState<'resize' | 'center'>('resize');
  const [useManual, setUseManual] = useState(false);
  const [mappingId, setMappingId] = useState(colorToAttrMappings[0]?.id ?? '');
  const [manualState, setManualState] = useState<ManualBrushModelState>(() => {
    const s: ManualBrushModelState = {};
    for (const a of cellAttributes) s[a.id] = { enabled: true, value: a.defaultValue ?? '' };
    return s;
  });

  const opts: ImageSampleOptions = { region, cellSize, average, invert, binarize: binarize || useManual, threshold };
  const { cols, rows } = gridDims(region, cellSize);

  // Left display geometry.
  const dispScale = Math.min(DISPLAY_MAX / iw, DISPLAY_MAX / ih, 1) || 1;
  const dispW = Math.round(iw * dispScale), dispH = Math.round(ih * dispScale);

  const leftCanvasRef = useRef<HTMLCanvasElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);

  // Draw the source image + region box + cell grid overlay.
  useEffect(() => {
    const cv = leftCanvasRef.current; if (!cv) return;
    cv.width = dispW; cv.height = dispH;
    const ctx = cv.getContext('2d')!;
    ctx.clearRect(0, 0, dispW, dispH);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, dispW, dispH);
    // Dim outside the region.
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    const rxs = region.x * dispScale, rys = region.y * dispScale, rws = region.w * dispScale, rhs = region.h * dispScale;
    ctx.fillRect(0, 0, dispW, rys);
    ctx.fillRect(0, rys + rhs, dispW, dispH - (rys + rhs));
    ctx.fillRect(0, rys, rxs, rhs);
    ctx.fillRect(rxs + rws, rys, dispW - (rxs + rws), rhs);
    // Cell grid lines (skip when too dense to draw).
    const cellDisp = cellSize * dispScale;
    if (cellDisp >= 3 && cols * rows <= 20000) {
      ctx.strokeStyle = 'rgba(76,201,240,0.35)'; ctx.lineWidth = 0.5;
      ctx.beginPath();
      for (let c = 0; c <= cols; c++) { const x = rxs + c * cellDisp; ctx.moveTo(x, rys); ctx.lineTo(x, rys + rows * cellDisp); }
      for (let r = 0; r <= rows; r++) { const y = rys + r * cellDisp; ctx.moveTo(rxs, y); ctx.lineTo(rxs + cols * cellDisp, y); }
      ctx.stroke();
    }
    // Region box + resize handle.
    ctx.strokeStyle = '#4cc9f0'; ctx.lineWidth = 1.5;
    ctx.strokeRect(rxs, rys, rws, rhs);
    ctx.fillStyle = '#4cc9f0';
    ctx.fillRect(rxs + rws - 6, rys + rhs - 6, 8, 8);
  }, [img, dispW, dispH, dispScale, region, cellSize, cols, rows]);

  // Draw the gridified preview.
  useEffect(() => {
    const cv = previewCanvasRef.current; if (!cv) return;
    const g = gridifyImage(srcData, opts);
    const scale = cols > 0 && rows > 0 ? Math.max(1, Math.floor(Math.min(PREVIEW_MAX / cols, PREVIEW_MAX / rows))) : 1;
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
  }, [srcData, region, cellSize, average, invert, binarize, useManual, threshold, cols, rows]);

  // Region drag (move / resize / draw-new) on the left canvas.
  const dragRef = useRef<{ kind: 'move' | 'resize' | 'new'; sx: number; sy: number; orig: typeof region } | null>(null);
  const toSrc = (clientX: number, clientY: number, el: HTMLCanvasElement) => {
    const rect = el.getBoundingClientRect();
    return {
      x: Math.round((clientX - rect.left) / dispScale),
      y: Math.round((clientY - rect.top) / dispScale),
    };
  };
  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const el = e.currentTarget; el.setPointerCapture(e.pointerId);
    const p = toSrc(e.clientX, e.clientY, el);
    const handleX = region.x + region.w, handleY = region.y + region.h;
    const nearHandle = Math.abs(p.x - handleX) * dispScale < 10 && Math.abs(p.y - handleY) * dispScale < 10;
    const inside = p.x >= region.x && p.x <= region.x + region.w && p.y >= region.y && p.y <= region.y + region.h;
    if (nearHandle) dragRef.current = { kind: 'resize', sx: p.x, sy: p.y, orig: region };
    else if (inside) dragRef.current = { kind: 'move', sx: p.x, sy: p.y, orig: region };
    else { dragRef.current = { kind: 'new', sx: p.x, sy: p.y, orig: region }; setRegion({ x: p.x, y: p.y, w: 1, h: 1 }); }
  };
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = dragRef.current; if (!d) return;
    const p = toSrc(e.clientX, e.clientY, e.currentTarget);
    const clamp = (v: number, hi: number) => Math.max(0, Math.min(hi, v));
    if (d.kind === 'move') {
      const nx = clamp(d.orig.x + (p.x - d.sx), iw - d.orig.w);
      const ny = clamp(d.orig.y + (p.y - d.sy), ih - d.orig.h);
      setRegion({ ...d.orig, x: nx, y: ny });
    } else if (d.kind === 'resize') {
      const nw = clamp(d.orig.w + (p.x - d.sx), iw - d.orig.x);
      const nh = clamp(d.orig.h + (p.y - d.sy), ih - d.orig.y);
      setRegion({ ...d.orig, w: Math.max(1, nw), h: Math.max(1, nh) });
    } else {
      // Draw-new: clamp the ORIGIN into the image and the EXTENT to the remaining
      // width/height so a drag released off-canvas can't run the region past the
      // image edge (which would smear the last column/row in gridifyImage).
      const x0 = clamp(Math.min(d.sx, p.x), iw - 1), y0 = clamp(Math.min(d.sy, p.y), ih - 1);
      const w = Math.max(1, Math.min(Math.abs(p.x - d.sx), iw - x0));
      const h = Math.max(1, Math.min(Math.abs(p.y - d.sy), ih - y0));
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

  const overlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 9000, display: 'flex', alignItems: 'center', justifyContent: 'center' };
  const card: React.CSSProperties = { background: 'var(--color-bg-panel, #14161c)', border: '1px solid var(--color-border, #2a3a50)', borderRadius: 8, padding: 16, maxWidth: 820, maxHeight: '92vh', overflow: 'auto', color: 'var(--color-text, #cdd6e0)', boxShadow: '0 8px 40px rgba(0,0,0,0.6)' };
  const label: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' };

  const applyDisabled = cols < 1 || rows < 1 || (!useManual && !mappingId) || (mode === 'center' && (cols > gridWidth || rows > gridHeight));

  const handleApply = () => {
    const g = gridifyImage(srcData, opts);
    onApply({ region, cellSize, average, invert, binarize, threshold, mode, mappingId, useManual, manualState, cols: g.cols, rows: g.rows, pixels: g.pixels, mask: g.mask });
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

        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 11, color: '#8090a0', marginBottom: 4 }}>Source ({iw}×{ih}) — drag to set region, corner to resize</div>
            <canvas ref={leftCanvasRef} width={dispW} height={dispH}
              style={{ border: '1px solid #2a3a50', touchAction: 'none', cursor: 'crosshair', imageRendering: 'pixelated' }}
              onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} />
          </div>
          <div>
            <div style={{ fontSize: 11, color: '#8090a0', marginBottom: 4 }}>Result grid ({cols}×{rows})</div>
            <canvas ref={previewCanvasRef} style={{ border: '1px solid #2a3a50', background: '#0a0b0e', imageRendering: 'pixelated', maxWidth: PREVIEW_MAX, maxHeight: PREVIEW_MAX }} />
          </div>
        </div>

        {/* Region + cell numeric controls. */}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginTop: 10, fontSize: 12 }}>
          <span style={{ color: '#8090a0' }}>Region</span>
          {(['x', 'y', 'w', 'h'] as const).map(k => (
            <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
              {k}<NumberField integer min={k === 'w' || k === 'h' ? 1 : 0} style={{ width: 56 }} value={region[k]} onNumber={v => setRegionField(k, v)} />
            </label>
          ))}
          <label style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            cell&nbsp;px<NumberField integer min={1} style={{ width: 56 }} value={cellSize} onNumber={v => setCellSize(Math.max(1, Math.round(v)))} />
          </label>
        </div>

        {/* Options. */}
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 10 }}>
          <label style={label}><input type="checkbox" checked={average} onChange={e => setAverage(e.target.checked)} /> Average pixels inside cell</label>
          <label style={label}><input type="checkbox" checked={invert} onChange={e => setInvert(e.target.checked)} /> Invert image</label>
          <label style={label}><input type="checkbox" checked={binarize} onChange={e => setBinarize(e.target.checked)} /> Binarize image</label>
          {(binarize || useManual) && (
            <label style={{ ...label, gap: 8 }}>
              Threshold {threshold}
              <input type="range" min={0} max={255} value={threshold} onChange={e => setThreshold(Number(e.target.value))} />
            </label>
          )}
        </div>

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

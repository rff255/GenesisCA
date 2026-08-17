import { useEffect, useMemo, useRef, useState } from 'react';
import type { Attribute, GeoReference } from '../model/types';
import { NumberField } from '../modeler/vpl/widgets/InlineWidgets';
import { gridTargetOptions } from './csvImport';
import type { RasterResampleMethod } from './rasterResample';
import {
  openGeoTiff, buildBandValues, distinctValues, autoSeedValueMap,
  scaleGeorefForResample, shiftGeorefForWindow,
  clampWindow, defaultWindow, windowCapError, supportsAverageResample,
  GEOTIFF_MAX_DISTINCT,
  type GeoTiffFile, type GeoTiffValueMap, type GeoTiffValueInfo,
  type GeoTiffWindow, type GeoTiffPreview,
} from './geotiffImport';

/** What the dialog hands back on Import — structurally the GRID variant of
 *  `CsvImportResult` (minus its `target` tag), so `SimulatorView.applyGridImport`
 *  serves BOTH importers and there is exactly one path to `importGridValues`. */
export interface GeoTiffImportResult {
  width: number;
  height: number;
  layer: number;
  resize: boolean;
  layers: Array<{ attrId: string; values: Float64Array }>;
  georef?: GeoReference;
}

/** Above this many destination cells the resize option carries a warning — a
 *  4 Mcell board is already a heavy model, and a raster's own size is a poor
 *  reason to pick one. */
const BIG_GRID_CELLS = 4_000_000;
/** The crop viewport. FIXED, deliberately: sizing it to the raster's aspect
 *  would reflow the card the moment a drag changed anything, which is the
 *  documented "drag feedback loop" the image dialog already learned. */
const CROP_W = 380;
const CROP_H = 280;
/** Screen-px hit radius for the crop box's corner handle. */
const HANDLE_HIT = 11;
/** Longest edge of the decoded preview. */
const PREVIEW_MAX = 512;
/** A crop drag emits a window per pointer-move; decompressing a band on each one
 *  would be unusable, so the band read waits for the gesture to settle. */
const READ_DEBOUNCE_MS = 260;

type Drag =
  | { kind: 'move'; sx: number; sy: number; orig: GeoTiffWindow }
  | { kind: 'resize'; orig: GeoTiffWindow }
  | { kind: 'new'; sx: number; sy: number };

const EMPTY_BANDS: Record<number, Float64Array> = {};

/** "Import GeoTIFF" — the raster sibling of the CSV / Esri-ASCII dialog.
 *
 *  A GeoTIFF is always a BOARD (never an agent list), so there is no Target
 *  switch. The flow is: CROP (drag a window on the preview, or type it), pick a
 *  cell attribute per band, choose whether the grid resizes to the crop or the
 *  crop resamples onto the grid, and Apply.
 *
 *  THE CROP IS WHAT MAKES A BIG SOURCE USABLE: `openGeoTiff` reads metadata
 *  only, and every band read is bounded by the window — so a country-scale
 *  download opens here rather than in QGIS, and the import caps apply to the
 *  piece you asked for instead of to the file.
 *
 *  All parsing / resampling / decoding lives in the pure `geotiffImport.ts` +
 *  `rasterResample.ts`; this file is the setup + preview + reporting surface. */
export function GeoTiffImportDialog({
  buffer, fileName, cellAttributes, is3d, world, modelGeoref, onApply, onCancel,
}: {
  buffer: ArrayBuffer;
  fileName: string;
  cellAttributes: Attribute[];
  is3d: boolean;
  world: { w: number; h: number; d: number };
  modelGeoref?: GeoReference;
  onApply: (r: GeoTiffImportResult) => void;
  onCancel: () => void;
}) {
  // --- open the file --------------------------------------------------------
  const [file, setFile] = useState<GeoTiffFile | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setFile(null); setOpenError(null);
    void (async () => {
      try {
        const f = await openGeoTiff(buffer);
        if (alive) setFile(f);
      } catch (err) {
        if (alive) setOpenError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { alive = false; };
  }, [buffer]);

  // --- the crop window ------------------------------------------------------
  // Opens on the whole image, or — when the source is bigger than one import can
  // read — on a centred, cap-sized box the user then drags. Never on an error.
  const [win, setWin] = useState<GeoTiffWindow>({ x: 0, y: 0, width: 1, height: 1 });
  useEffect(() => {
    if (file) setWin(defaultWindow(file.width, file.height));
  }, [file]);
  const setWinClamped = (w: GeoTiffWindow) => { if (file) setWin(clampWindow(w, file.width, file.height)); };
  const setWinField = (k: keyof GeoTiffWindow, v: number) => setWinClamped({ ...win, [k]: v });
  const winSig = `${win.x},${win.y},${win.width},${win.height}`;
  const capError = file ? windowCapError(win) : null;
  const cropped = !!file && (win.x !== 0 || win.y !== 0 || win.width !== file.width || win.height !== file.height);

  // --- band → cell attribute ------------------------------------------------
  const gridOpts = useMemo(() => gridTargetOptions(cellAttributes), [cellAttributes]);
  // Band 0 takes the first cell attribute, the rest start ignored: a
  // single-band raster (the overwhelmingly common case) is then one click from
  // Apply, while a multi-band file never silently scatters itself across
  // attributes the user did not choose.
  const [targets, setTargets] = useState<string[]>([]);
  useEffect(() => {
    if (!file) { setTargets([]); return; }
    setTargets(file.bands.map((_, i) => (i === 0 ? (gridOpts[0]?.id ?? 'ignore') : 'ignore')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);
  const attrFor = (id: string) => gridOpts.find(o => o.id === id);

  const [fit, setFit] = useState<'resize' | 'keep'>('resize');
  const [layer, setLayer] = useState(0);

  const dstW = file ? (fit === 'resize' ? win.width : world.w) : 0;
  const dstH = file ? (fit === 'resize' ? win.height : world.h) : 0;
  const resampling = !!file && (dstW !== win.width || dstH !== win.height);

  // Per-band resample method. Only ever consulted while actually resampling, and
  // only offered for a numeric target — `buildBandValues` refuses `average` for a
  // categorical one regardless, so a class code can never be averaged.
  const [methods, setMethods] = useState<Record<number, RasterResampleMethod>>({});
  const methodFor = (band: number): RasterResampleMethod => methods[band] ?? 'nearest';

  // --- band data + categorical value maps -----------------------------------
  // A band is read only when it is TARGETED (reading is decompression), only over
  // the CURRENT window, and only after the crop gesture settles. The cache is
  // keyed by the window, so moving the box drops the previous read rather than
  // retaining a Float64Array per window the user dragged through.
  const [bands, setBands] = useState<{ sig: string; data: Record<number, Float64Array> }>({ sig: '', data: {} });
  const bandData = bands.sig === winSig ? bands.data : EMPTY_BANDS;
  const [bandError, setBandError] = useState<string | null>(null);
  const [valueMaps, setValueMaps] = useState<Record<number, GeoTiffValueMap>>({});
  const [distincts, setDistincts] = useState<Record<number, { values: GeoTiffValueInfo[]; truncated: boolean }>>({});
  const [reading, setReading] = useState(0);

  const targetSig = targets.join('|');
  useEffect(() => {
    if (!file || capError) return;
    let alive = true;
    const have = bands.sig === winSig ? bands.data : EMPTY_BANDS;
    const wanted = targets.map((t, i) => (t === 'ignore' ? -1 : i)).filter(i => i >= 0 && have[i] === undefined);
    if (wanted.length === 0) return;
    const timer = setTimeout(() => {
      setReading(n => n + wanted.length);
      void (async () => {
        for (const i of wanted) {
          try {
            const data = await file.readBand(i, win);
            if (!alive) return;
            setBandError(null);
            // Re-key on the CURRENT signature: a window that changed while this
            // read was in flight must not adopt the stale block.
            setBands(prev => ({ sig: winSig, data: prev.sig === winSig ? { ...prev.data, [i]: data } : { [i]: data } }));
          } catch (err) {
            if (alive) setBandError(err instanceof Error ? err.message : String(err));
          } finally {
            if (alive) setReading(n => n - 1);
          }
        }
      })();
    }, READ_DEBOUNCE_MS);
    return () => { alive = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetSig, winSig, file, capError]);

  // Seed the value map whenever a categorical band's DATA or its target
  // ATTRIBUTE changes (a different tag list — or a different crop — implies
  // different seeds); user edits survive until then. Not persisted: a code table
  // only means anything for the file it came from.
  const seedSig = targets.map((t, i) => `${i}:${t}:${bandData[i] ? 1 : 0}`).join('|') + '|' + winSig;
  useEffect(() => {
    if (!file) return;
    const nextD: Record<number, { values: GeoTiffValueInfo[]; truncated: boolean }> = {};
    const nextM: Record<number, GeoTiffValueMap> = {};
    targets.forEach((t, i) => {
      const opt = attrFor(t);
      const data = bandData[i];
      if (!opt || !data) return;
      if (opt.attr.type !== 'tag' && opt.attr.type !== 'bool') return;
      const raw = distinctValues(data, GEOTIFF_MAX_DISTINCT);
      // The NODATA sentinel is tested BEFORE the value map in `buildBandValues`,
      // so a row for it could never do anything — offering one would be exactly
      // the enabled-but-inert control the UI rules forbid. It is reported in the
      // note under the table instead.
      const d = file.noData === null
        ? raw
        : { values: raw.values.filter(v => v.value !== file.noData), truncated: raw.truncated };
      nextD[i] = d;
      if (!d.truncated) nextM[i] = autoSeedValueMap(d.values, opt.attr);
    });
    setDistincts(nextD);
    setValueMaps(nextM);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedSig, file]);

  const setMapValue = (band: number, key: string, v: string) =>
    setValueMaps(m => ({ ...m, [band]: { ...(m[band] ?? {}), [key]: v } }));

  // --- whole-image preview (the surface the crop box sits on) ---------------
  // Decoded from an OVERVIEW when the file carries one, so a huge source still
  // gets a thumbnail; null when it carries none and is too big to decode whole —
  // the crop is then set numerically and the note says so.
  const previewBand = Math.max(0, targets.findIndex(t => t !== 'ignore'));
  const [preview, setPreview] = useState<GeoTiffPreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  useEffect(() => {
    if (!file || !file.previewAvailable) { setPreview(null); return; }
    let alive = true;
    setPreviewBusy(true);
    void (async () => {
      try {
        const p = await file.readPreview(previewBand, PREVIEW_MAX);
        if (alive) setPreview(p);
      } catch { if (alive) setPreview(null); } finally { if (alive) setPreviewBusy(false); }
    })();
    return () => { alive = false; };
  }, [file, previewBand]);

  // The preview, grayscale-normalised, on its own offscreen canvas — so the
  // viewport draw below is one scaled `drawImage` per frame of a crop drag.
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [previewVersion, setPreviewVersion] = useState(0);
  useEffect(() => {
    if (!preview || !file) { previewCanvasRef.current = null; return; }
    const cv = document.createElement('canvas');
    cv.width = preview.width; cv.height = preview.height;
    const ctx = cv.getContext('2d');
    if (!ctx) { previewCanvasRef.current = null; return; }
    let lo = Infinity, hi = -Infinity;
    const skip = (v: number) => !Number.isFinite(v) || (file.noData !== null && v === file.noData);
    for (let i = 0; i < preview.data.length; i++) {
      const v = preview.data[i]!;
      if (skip(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const span = hi > lo ? hi - lo : 1;
    const img = ctx.createImageData(preview.width, preview.height);
    for (let i = 0; i < preview.data.length; i++) {
      const v = preview.data[i]!;
      const o = i * 4;
      if (skip(v)) {
        // NODATA reads as transparent, so "outside the study area" is visible.
        img.data[o] = 0; img.data[o + 1] = 0; img.data[o + 2] = 0; img.data[o + 3] = 0;
        continue;
      }
      const g = Math.max(0, Math.min(255, Math.round(((v - lo) / span) * 255)));
      img.data[o] = g; img.data[o + 1] = g; img.data[o + 2] = g; img.data[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    previewCanvasRef.current = cv;
    setPreviewVersion(n => n + 1);
  }, [preview, file]);

  // Source pixels ⇄ viewport pixels. Fit-scale, letterboxed, FIXED viewport.
  const fitScale = file ? Math.min(CROP_W / file.width, CROP_H / file.height) : 1;
  const dispW = file ? file.width * fitScale : 0;
  const dispH = file ? file.height * fitScale : 0;
  const offX = (CROP_W - dispW) / 2;
  const offY = (CROP_H - dispH) / 2;
  const toView = (sx: number, sy: number) => ({ x: offX + sx * fitScale, y: offY + sy * fitScale });
  const toSource = (vx: number, vy: number) => ({ x: (vx - offX) / fitScale, y: (vy - offY) / fitScale });

  const cropCanvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = cropCanvasRef.current;
    if (!cv || !file) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, CROP_W, CROP_H);
    ctx.fillStyle = '#0a0b0e';
    ctx.fillRect(0, 0, CROP_W, CROP_H);
    const pc = previewCanvasRef.current;
    if (pc) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(pc, 0, 0, pc.width, pc.height, offX, offY, dispW, dispH);
      // Dim the whole raster, then re-draw the crop at full brightness — the
      // included area reads as the bright one, exactly like the image dialog.
      ctx.fillStyle = 'rgba(0,0,0,0.58)';
      ctx.fillRect(offX, offY, dispW, dispH);
      const px = pc.width / file.width, py = pc.height / file.height;
      const a = toView(win.x, win.y);
      ctx.drawImage(pc,
        win.x * px, win.y * py, Math.max(1, win.width * px), Math.max(1, win.height * py),
        a.x, a.y, Math.max(1, win.width * fitScale), Math.max(1, win.height * fitScale));
    } else {
      // No decodable thumbnail — show the raster's OUTLINE so the crop box still
      // has a frame of reference, and say why.
      ctx.strokeStyle = '#2a3a50';
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(offX + 0.5, offY + 0.5, dispW - 1, dispH - 1);
      ctx.setLineDash([]);
      ctx.fillStyle = '#556';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(previewBusy ? 'decoding preview…' : 'no preview — set the crop below', CROP_W / 2, CROP_H / 2);
      ctx.textAlign = 'left';
    }
    // The crop rectangle + its corner handle.
    const a = toView(win.x, win.y);
    const b = toView(win.x + win.width, win.y + win.height);
    ctx.strokeStyle = '#4cc9f0';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(a.x + 0.5, a.y + 0.5, Math.max(1, b.x - a.x - 1), Math.max(1, b.y - a.y - 1));
    ctx.fillStyle = '#4cc9f0';
    ctx.fillRect(b.x - 4, b.y - 4, 8, 8);
  }, [file, win, previewVersion, previewBusy, fitScale, dispW, dispH, offX, offY]);

  // Pointer: corner handle → inside (move) → outside (draw a new box).
  const dragRef = useRef<Drag | null>(null);
  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!file || e.button !== 0) return;
    const r = e.currentTarget.getBoundingClientRect();
    const vx = e.clientX - r.left, vy = e.clientY - r.top;
    const p = toSource(vx, vy);
    const h = toView(win.x + win.width, win.y + win.height);
    const inside = p.x >= win.x && p.x <= win.x + win.width && p.y >= win.y && p.y <= win.y + win.height;
    if (Math.abs(vx - h.x) < HANDLE_HIT && Math.abs(vy - h.y) < HANDLE_HIT) {
      dragRef.current = { kind: 'resize', orig: win };
    } else if (inside) {
      dragRef.current = { kind: 'move', sx: p.x, sy: p.y, orig: win };
    } else {
      dragRef.current = { kind: 'new', sx: p.x, sy: p.y };
      setWinClamped({ x: p.x, y: p.y, width: 1, height: 1 });
    }
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = dragRef.current;
    if (!d || !file) return;
    const r = e.currentTarget.getBoundingClientRect();
    const p = toSource(e.clientX - r.left, e.clientY - r.top);
    if (d.kind === 'move') {
      setWinClamped({ ...d.orig, x: d.orig.x + (p.x - d.sx), y: d.orig.y + (p.y - d.sy) });
    } else if (d.kind === 'resize') {
      setWinClamped({ ...d.orig, width: p.x - d.orig.x, height: p.y - d.orig.y });
    } else {
      setWinClamped({
        x: Math.min(d.sx, p.x), y: Math.min(d.sy, p.y),
        width: Math.abs(p.x - d.sx), height: Math.abs(p.y - d.sy),
      });
    }
  };
  const onUp = () => { dragRef.current = null; };

  // --- reporting ------------------------------------------------------------
  const activeTargets = targets.map((t, i) => ({ band: i, id: t })).filter(t => t.id !== 'ignore');
  const dupTargets = activeTargets.length !== new Set(activeTargets.map(t => t.id)).size;
  const crsMismatch = !!(modelGeoref?.crs && file?.georef?.crs && modelGeoref.crs !== file.georef.crs);

  // Crop THEN resample: the window fixes the extent (same cell size, shifted
  // corner), and only then does a resample change the cell size.
  const outGeoref = useMemo(() => {
    if (!file?.georef) return undefined;
    const shifted = shiftGeorefForWindow(file.georef, win, file.height);
    return resampling
      ? scaleGeorefForResample(shifted, win.width, win.height, dstW, dstH).georef
      : shifted;
  }, [file, winSig, resampling, dstW, dstH]); // eslint-disable-line react-hooks/exhaustive-deps
  const aspect = file?.georef && resampling
    ? scaleGeorefForResample(file.georef, win.width, win.height, dstW, dstH).aspectWarning
    : undefined;

  const summary = (() => {
    if (!file) return '';
    const parts = [`${file.width} × ${file.height} · ${file.bandCount} band${file.bandCount === 1 ? '' : 's'}`];
    if (cropped) parts.push(`crop ${win.width} × ${win.height} at (${win.x}, ${win.y})`);
    if (file.noData !== null) parts.push(`NODATA ${file.noData}`);
    parts.push(outGeoref
      ? `cell size ${outGeoref.cellSize} · origin (${outGeoref.xllcorner}, ${outGeoref.yllcorner})${outGeoref.crs ? ` · ${outGeoref.crs}` : ' · no CRS'}`
      : 'no georeference');
    if (resampling) parts.push(`resampled to ${dstW} × ${dstH}`);
    return parts.join(' · ');
  })();

  const [applying, setApplying] = useState(false);
  const applyDisabled = !file || activeTargets.length === 0 || dupTargets
    || reading > 0 || applying || dstW < 1 || dstH < 1 || !!capError;

  const handleApply = () => {
    if (!file || applying) return;
    setApplying(true);
    void (async () => {
      try {
        const layers: Array<{ attrId: string; values: Float64Array }> = [];
        for (const { band, id } of activeTargets) {
          const opt = attrFor(id);
          if (!opt) continue;
          const data = bandData[band] ?? await file.readBand(band, win);
          const built = buildBandValues(data, win.width, win.height, dstW, dstH, opt.attr, {
            noData: file.noData,
            valueMap: valueMaps[band],
            resample: methodFor(band),
          });
          layers.push({ attrId: id, values: built.values });
        }
        if (layers.length === 0) { setApplying(false); return; }
        onApply({
          width: dstW, height: dstH,
          layer: is3d ? Math.max(0, Math.min(world.d - 1, Math.round(layer))) : 0,
          resize: fit === 'resize', layers, georef: outGeoref,
        });
      } catch (err) {
        setBandError(err instanceof Error ? err.message : String(err));
        setApplying(false);
      }
    })();
  };

  // --- styles (mirrors CsvImportDialog) -------------------------------------
  const overlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 9000, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', overflow: 'auto', padding: '4vh 12px' };
  const card: React.CSSProperties = { background: 'var(--color-bg-panel, #14161c)', border: '1px solid var(--color-border, #2a3a50)', borderRadius: 8, padding: 16, width: 'min(1040px, 96vw)', maxHeight: '92vh', overflow: 'auto', color: 'var(--color-text, #cdd6e0)', boxShadow: '0 8px 40px rgba(0,0,0,0.6)' };
  const label: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' };
  const note: React.CSSProperties = { fontSize: 10.5, color: '#8090a0', lineHeight: 1.5 };
  const warn: React.CSSProperties = { fontSize: 11, color: '#e0b060' };
  const miniBtn: React.CSSProperties = { fontSize: 10.5, padding: '2px 7px', cursor: 'pointer', background: '#1a2230', color: '#cdd6e0', border: '1px solid #2a3a50', borderRadius: 3 };

  return (
    <div style={overlay} onClick={onCancel}>
      <div style={card} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>Import GeoTIFF <span style={{ color: '#8090a0', fontWeight: 400, fontSize: 12 }}>— {fileName}</span></h3>
          <button onClick={onCancel} style={{ background: 'none', border: 'none', color: 'inherit', fontSize: 18, cursor: 'pointer' }} title="Cancel">&times;</button>
        </div>

        {openError && <div style={{ color: '#e05050', fontSize: 12, padding: '8px 0' }}>{openError}</div>}
        {!file && !openError && <div style={{ fontSize: 12, color: '#8090a0', padding: '8px 0' }}>Reading the GeoTIFF{'…'}</div>}

        {file && (
          <>
            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              {/* LEFT — crop viewport + summary. */}
              <div style={{ flex: '0 0 auto' }}>
                <div style={{ fontSize: 11, color: '#8090a0', marginBottom: 4 }}>
                  Crop{previewBand >= 0 && preview ? ` — band ${previewBand + 1}, grayscale` : ''}
                </div>
                <canvas
                  ref={cropCanvasRef} width={CROP_W} height={CROP_H}
                  style={{ width: CROP_W, height: CROP_H, border: '1px solid #2a3a50', background: '#0a0b0e', display: 'block', touchAction: 'none', cursor: 'crosshair', imageRendering: 'pixelated' }}
                  onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
                />
                <div style={{ ...note, marginTop: 4 }}>
                  <span style={{ color: '#4cc9f0' }}>▭ Imported area</span> — drag to move, corner to resize, outside to redraw.
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
                  {(['x', 'y', 'width', 'height'] as const).map(k => (
                    <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 10.5, color: '#8090a0' }}>
                      {k === 'width' ? 'w' : k === 'height' ? 'h' : k}
                      <NumberField integer min={k === 'width' || k === 'height' ? 1 : 0}
                        style={{ width: 62 }} value={win[k]} onNumber={v => setWinField(k, v)} />
                    </label>
                  ))}
                  <button style={miniBtn} title="Import the whole raster"
                    onClick={() => setWinClamped({ x: 0, y: 0, width: file.width, height: file.height })}>Whole image</button>
                </div>
                {capError && <div style={{ color: '#e05050', fontSize: 11, marginTop: 5 }}>{capError}</div>}

                <div style={{ marginTop: 8, padding: '6px 10px', borderRadius: 4, fontSize: 11.5, border: '1px solid #3a4a2a', background: '#161a12', color: '#9ccc65' }}>
                  {summary}
                </div>
                {!file.previewAvailable && (
                  <div style={{ ...note, marginTop: 4 }}>
                    This file is too large to decode whole and carries no overview, so there is no thumbnail —
                    set the crop with the numbers above (or open it once in QGIS to see where things are).
                  </div>
                )}
                {file.warnings.map((w, i) => <div key={i} style={{ ...warn, marginTop: 4 }}>{w}</div>)}
                {aspect && <div style={{ ...warn, marginTop: 4 }}>{aspect}</div>}
                {crsMismatch && (
                  <div style={{ ...warn, marginTop: 4 }}>
                    The model is georeferenced in <b>{modelGeoref!.crs}</b> and this file is in <b>{file.georef!.crs}</b>.
                    GenesisCA does not reproject — align the layers in QGIS first, or the two will not overlap.
                  </div>
                )}
                {bandError && <div style={{ color: '#e05050', fontSize: 11, marginTop: 4 }}>{bandError}</div>}
              </div>

              {/* RIGHT — options. */}
              <div style={{ flex: '1 1 330px', minWidth: 300, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 11, color: '#8090a0' }}>Bands → cell attributes</div>
                {gridOpts.length === 0 && <div style={warn}>This model has no per-cell attribute to import into.</div>}
                {file.bands.map(b => {
                  const opt = attrFor(targets[b.index] ?? 'ignore');
                  // The method control is HIDDEN unless it can do something: a
                  // resample has to be happening AND the target has to be numeric.
                  const showMethod = resampling && !!opt && supportsAverageResample(opt.attr);
                  return (
                    <div key={b.index} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 5px', borderRadius: 4, border: '1px solid #2a3a50', background: '#12161d' }}>
                      <span style={{ fontSize: 11, color: '#cdd6e0', minWidth: 48 }}>Band {b.index + 1}</span>
                      <span style={{ fontSize: 9.5, color: '#667', minWidth: 46 }}>{b.typeLabel}</span>
                      <select
                        value={targets[b.index] ?? 'ignore'}
                        onChange={e => setTargets(t => { const n = [...t]; while (n.length <= b.index) n.push('ignore'); n[b.index] = e.target.value; return n; })}
                        style={{ fontSize: 11, flex: 1, minWidth: 0 }}
                      >
                        <option value="ignore">(ignore)</option>
                        {gridOpts.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
                      </select>
                      {showMethod && (
                        <select
                          value={methodFor(b.index)}
                          onChange={e => setMethods(m => ({ ...m, [b.index]: e.target.value as RasterResampleMethod }))}
                          title="How this band is resampled onto the grid"
                          style={{ fontSize: 10.5, flex: '0 0 auto' }}
                        >
                          <option value="nearest">Nearest</option>
                          <option value="average">Average</option>
                        </select>
                      )}
                    </div>
                  );
                })}
                {dupTargets && <div style={{ color: '#e05050', fontSize: 11 }}>Two bands target the same attribute — the later one would overwrite the earlier.</div>}

                <hr style={{ border: 'none', borderTop: '1px solid #2a3a50', margin: '2px 0' }} />
                <label style={label}>
                  <input type="radio" checked={fit === 'resize'} onChange={() => setFit('resize')} />
                  Resize the grid to the crop ({win.width}×{win.height})
                </label>
                {fit === 'resize' && win.width * win.height > BIG_GRID_CELLS && (
                  <div style={warn}>
                    That is {(win.width * win.height).toLocaleString()} cells — a heavy model. Crop smaller, or resample onto the current grid.
                  </div>
                )}
                <label style={label}>
                  <input type="radio" checked={fit === 'keep'} onChange={() => setFit('keep')} />
                  Resample onto the grid ({world.w}×{world.h})
                </label>
                {is3d && (
                  <label style={{ ...label, gap: 6 }}>
                    Layer
                    <NumberField value={layer} onNumber={setLayer} min={0} max={Math.max(0, world.d - 1)} integer
                      style={{ width: 64, fontSize: 12 }} />
                    <span style={{ fontSize: 10.5, color: '#8090a0' }}>of {world.d}</span>
                  </label>
                )}
                <div style={note}>
                  <b>Nearest</b> never averages a class code into one that does not exist, so it is the only
                  method offered for a Binary or Tag target. <b>Average</b> box-filters a continuous band
                  (elevation, population) the way <code>gdalwarp -r average</code> would.
                  {file.noData !== null && ' NODATA cells are excluded from the mean and take the attribute default.'}
                  {is3d && ' A 2D raster cannot fill a volume, so it writes ONE layer.'}
                </div>
                {reading > 0 && <div style={{ fontSize: 11, color: '#8090a0' }}>Reading band data{'…'}</div>}
              </div>
            </div>

            {/* Categorical value maps — full width below the two columns, like
                the CSV dialog's character map. One block per tag / bool band. */}
            {activeTargets.map(({ band, id }) => {
              const opt = attrFor(id);
              const d = distincts[band];
              if (!opt || !d) return null;
              const tagOpts = opt.attr.tagOptions ?? [];
              const map = valueMaps[band] ?? {};
              return (
                <div key={band} style={{ marginTop: 10, borderTop: '1px solid #2a3a50', paddingTop: 8 }}>
                  <div style={{ fontSize: 11.5, color: '#cdd6e0', marginBottom: 2 }}>
                    Band {band + 1} value → <b>{opt.label}</b>
                    <span style={{ color: '#8090a0' }}> ({d.values.length} distinct value{d.values.length === 1 ? '' : 's'} in the crop)</span>
                  </div>
                  {d.truncated ? (
                    <div style={warn}>
                      More than {GEOTIFF_MAX_DISTINCT} distinct values — this band does not look categorical, so no mapping table is offered.
                      Values are read as {opt.attr.type === 'tag' ? 'option indices' : 'nonzero = true'} instead.
                    </div>
                  ) : (
                    <>
                      <div style={{ ...note, marginBottom: 6 }}>
                        The raster&apos;s own codes (a Cell2Fire fuel model, an NLCD class) map to this attribute&apos;s values.
                        Codes that already ARE valid values are seeded; unmapped codes take the attribute default and are counted.
                        {file.noData !== null && ` The NODATA sentinel (${file.noData}) is not listed — it always takes the default.`}
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 190, overflow: 'auto' }}>
                        {d.values.map(({ value, count }) => {
                          const key = String(value);
                          const mapped = map[key];
                          const isMapped = mapped !== undefined && mapped !== '';
                          return (
                            <div key={key} style={{
                              display: 'flex', alignItems: 'center', gap: 5, padding: '3px 6px', borderRadius: 4,
                              border: '1px solid ' + (isMapped ? 'var(--color-accent, #e8a13a)' : '#2a3a50'),
                              background: isMapped ? 'rgba(232,161,58,0.07)' : '#12161d',
                            }}>
                              <code style={{ fontSize: 12, minWidth: 18, textAlign: 'center', color: '#cdd6e0' }}>{key}</code>
                              <span style={{ fontSize: 9.5, color: '#667', minWidth: 30 }}>×{count}</span>
                              <select value={isMapped ? mapped : ''} onChange={e => setMapValue(band, key, e.target.value)} style={{ fontSize: 11, maxWidth: 130 }}>
                                <option value="">(default)</option>
                                {opt.attr.type === 'bool'
                                  ? <><option value="false">False</option><option value="true">True</option></>
                                  : tagOpts.map((t, ti) => <option key={ti} value={String(ti)}>{t}</option>)}
                              </select>
                            </div>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <button onClick={onCancel} style={{ padding: '6px 14px', cursor: 'pointer' }}>Cancel</button>
          <button onClick={handleApply} disabled={applyDisabled}
            style={{ padding: '6px 14px', cursor: applyDisabled ? 'not-allowed' : 'pointer', background: applyDisabled ? '#333' : 'var(--color-accent, #4cc9f0)', color: applyDisabled ? '#888' : '#08121a', border: 'none', borderRadius: 4, fontWeight: 600 }}>
            {applying ? 'Importing…' : 'Import'}
          </button>
        </div>
      </div>
    </div>
  );
}

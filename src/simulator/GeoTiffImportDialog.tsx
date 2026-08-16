import { useEffect, useMemo, useRef, useState } from 'react';
import type { Attribute, GeoReference } from '../model/types';
import { NumberField } from '../modeler/vpl/widgets/InlineWidgets';
import { gridTargetOptions } from './csvImport';
import {
  openGeoTiff, buildBandValues, distinctValues, autoSeedValueMap,
  scaleGeorefForResample, resampleNearest,
  GEOTIFF_MAX_DISTINCT,
  type GeoTiffFile, type GeoTiffValueMap, type GeoTiffValueInfo,
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
/** Longest edge of the preview canvas. */
const PREVIEW_MAX = 240;

/** "Import GeoTIFF" — the raster sibling of the CSV / Esri-ASCII dialog.
 *
 *  A GeoTIFF is always a BOARD (never an agent list), so there is no Target
 *  switch: pick a cell attribute per band, choose whether the grid resizes to
 *  the raster or the raster resamples onto the grid, and Apply. Bands are read
 *  lazily (a band is only decompressed when something needs it) and cached by
 *  `openGeoTiff`.
 *
 *  All parsing / resampling / decoding lives in the pure `geotiffImport.ts`;
 *  this file is the setup + preview + reporting surface. */
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

  const dstW = file ? (fit === 'resize' ? file.width : world.w) : 0;
  const dstH = file ? (fit === 'resize' ? file.height : world.h) : 0;

  // --- band data + categorical value maps -----------------------------------
  // A band is read only when it is TARGETED (reading is decompression), and the
  // value map is only built for a tag / bool target — a continuous band has ~one
  // distinct value per cell and no useful mapping table.
  const [bandData, setBandData] = useState<Record<number, Float64Array>>({});
  const [bandError, setBandError] = useState<string | null>(null);
  const [valueMaps, setValueMaps] = useState<Record<number, GeoTiffValueMap>>({});
  const [distincts, setDistincts] = useState<Record<number, { values: GeoTiffValueInfo[]; truncated: boolean }>>({});
  const [reading, setReading] = useState(0);

  const targetSig = targets.join('|');
  useEffect(() => {
    if (!file) return;
    let alive = true;
    const wanted = targets.map((t, i) => (t === 'ignore' ? -1 : i)).filter(i => i >= 0 && bandData[i] === undefined);
    if (wanted.length === 0) return;
    setReading(n => n + wanted.length);
    void (async () => {
      for (const i of wanted) {
        try {
          const data = await file.readBand(i);
          if (!alive) return;
          setBandData(prev => ({ ...prev, [i]: data }));
        } catch (err) {
          if (alive) setBandError(err instanceof Error ? err.message : String(err));
        } finally {
          if (alive) setReading(n => n - 1);
        }
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetSig, file]);

  // Seed the value map whenever a categorical band's DATA or its target
  // ATTRIBUTE changes (a different tag list implies different seeds); user edits
  // survive until then. Not persisted — a code table only means anything for the
  // file it came from.
  const seedSig = targets.map((t, i) => `${i}:${t}:${bandData[i] ? 1 : 0}`).join('|');
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

  // --- preview --------------------------------------------------------------
  // The first loaded targeted band, grayscale-normalised. Cheap: the band is
  // already in memory and the downsample is the SAME pure resampler the import
  // uses, so what you see is what lands (modulo the value map).
  const previewBand = targets.findIndex((t, i) => t !== 'ignore' && bandData[i] !== undefined);
  const previewRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = previewRef.current;
    const data = previewBand >= 0 ? bandData[previewBand] : undefined;
    if (!cv || !file || !data) return;
    const scale = Math.min(1, PREVIEW_MAX / Math.max(file.width, file.height));
    const pw = Math.max(1, Math.round(file.width * scale));
    const ph = Math.max(1, Math.round(file.height * scale));
    cv.width = pw; cv.height = ph;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const small = resampleNearest(data, file.width, file.height, pw, ph);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < small.length; i++) {
      const v = small[i]!;
      if (!Number.isFinite(v) || (file.noData !== null && v === file.noData)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const span = hi > lo ? hi - lo : 1;
    const img = ctx.createImageData(pw, ph);
    for (let i = 0; i < small.length; i++) {
      const v = small[i]!;
      const o = i * 4;
      if (!Number.isFinite(v) || (file.noData !== null && v === file.noData)) {
        // NODATA reads as transparent, so "outside the study area" is visible.
        img.data[o] = 0; img.data[o + 1] = 0; img.data[o + 2] = 0; img.data[o + 3] = 0;
        continue;
      }
      const g = Math.max(0, Math.min(255, Math.round(((v - lo) / span) * 255)));
      img.data[o] = g; img.data[o + 1] = g; img.data[o + 2] = g; img.data[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }, [previewBand, bandData, file]);

  // --- reporting ------------------------------------------------------------
  const activeTargets = targets.map((t, i) => ({ band: i, id: t })).filter(t => t.id !== 'ignore');
  const dupTargets = activeTargets.length !== new Set(activeTargets.map(t => t.id)).size;
  const crsMismatch = !!(modelGeoref?.crs && file?.georef?.crs && modelGeoref.crs !== file.georef.crs);
  const resampling = !!file && (dstW !== file.width || dstH !== file.height);
  const aspect = file && file.georef && resampling
    ? scaleGeorefForResample(file.georef, file.width, file.height, dstW, dstH).aspectWarning
    : undefined;

  const summary = (() => {
    if (!file) return '';
    const parts = [`${file.width} × ${file.height} · ${file.bandCount} band${file.bandCount === 1 ? '' : 's'}`];
    if (file.noData !== null) parts.push(`NODATA ${file.noData}`);
    parts.push(file.georef
      ? `cell size ${file.georef.cellSize} · origin (${file.georef.xllcorner}, ${file.georef.yllcorner})${file.georef.crs ? ` · ${file.georef.crs}` : ' · no CRS'}`
      : 'no georeference');
    if (resampling) parts.push(`resampled to ${dstW} × ${dstH} (nearest)`);
    return parts.join(' · ');
  })();

  const [applying, setApplying] = useState(false);
  const applyDisabled = !file || activeTargets.length === 0 || dupTargets
    || reading > 0 || applying || dstW < 1 || dstH < 1;

  const handleApply = () => {
    if (!file || applying) return;
    setApplying(true);
    void (async () => {
      try {
        const layers: Array<{ attrId: string; values: Float64Array }> = [];
        for (const { band, id } of activeTargets) {
          const opt = attrFor(id);
          if (!opt) continue;
          const data = bandData[band] ?? await file.readBand(band);
          const built = buildBandValues(data, file.width, file.height, dstW, dstH, opt.attr, {
            noData: file.noData,
            valueMap: valueMaps[band],
          });
          layers.push({ attrId: id, values: built.values });
        }
        if (layers.length === 0) { setApplying(false); return; }
        // The extent is unchanged by a resample, so only the CELL SIZE scales —
        // see `scaleGeorefForResample`.
        const georef = file.georef
          ? (resampling
              ? scaleGeorefForResample(file.georef, file.width, file.height, dstW, dstH).georef
              : file.georef)
          : undefined;
        onApply({
          width: dstW, height: dstH,
          layer: is3d ? Math.max(0, Math.min(world.d - 1, Math.round(layer))) : 0,
          resize: fit === 'resize', layers, georef,
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
              {/* LEFT — preview + summary. */}
              <div style={{ flex: '1 1 380px', minWidth: 0 }}>
                <div style={{ fontSize: 11, color: '#8090a0', marginBottom: 4 }}>
                  Preview{previewBand >= 0 ? ` — band ${previewBand + 1}, grayscale` : ' — pick a band below'}
                </div>
                <div style={{ border: '1px solid #2a3a50', background: '#0a0b0e', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 120, padding: 6 }}>
                  {previewBand >= 0
                    ? <canvas ref={previewRef} style={{ imageRendering: 'pixelated', maxWidth: '100%' }} />
                    : <span style={{ fontSize: 11, color: '#556' }}>no band selected</span>}
                </div>

                <div style={{ marginTop: 8, padding: '6px 10px', borderRadius: 4, fontSize: 11.5, border: '1px solid #3a4a2a', background: '#161a12', color: '#9ccc65' }}>
                  {summary}
                </div>
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
              <div style={{ flex: '0 0 330px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 11, color: '#8090a0' }}>Bands → cell attributes</div>
                {gridOpts.length === 0 && <div style={warn}>This model has no per-cell attribute to import into.</div>}
                {file.bands.map(b => (
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
                  </div>
                ))}
                {dupTargets && <div style={{ color: '#e05050', fontSize: 11 }}>Two bands target the same attribute — the later one would overwrite the earlier.</div>}

                <hr style={{ border: 'none', borderTop: '1px solid #2a3a50', margin: '2px 0' }} />
                <label style={label}>
                  <input type="radio" checked={fit === 'resize'} onChange={() => setFit('resize')} />
                  Resize the grid to the raster ({file.width}×{file.height})
                </label>
                {fit === 'resize' && file.width * file.height > BIG_GRID_CELLS && (
                  <div style={warn}>
                    That is {(file.width * file.height).toLocaleString()} cells — a heavy model. Consider resampling the raster down in QGIS, or keep the current grid.
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
                  Resampling is <b>nearest neighbour</b> — a class code is never averaged into one that does not exist.
                  {file.noData !== null && ' NODATA cells take the attribute default.'}
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
                    <span style={{ color: '#8090a0' }}> ({d.values.length} distinct value{d.values.length === 1 ? '' : 's'})</span>
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

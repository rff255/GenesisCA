import { useEffect, useMemo, useRef, useState } from 'react';
import type { Attribute, GeoReference } from '../model/types';
import { encodeAttrValue } from '../model/attrValueEncoding';
import { InlineNumberInput, NumberField } from '../modeler/vpl/widgets/InlineWidgets';
import { gridTargetOptions, type CsvAgentSpec, type CsvAttrShape } from './csvImport';
import {
  parseGeoJson, makeCellTransform, rasterizeFeatures, collectRasterGroups,
  buildGeoJsonAgents, autoMapGeoJsonProperties, geoJsonAgentTargetOptions,
  GEOJSON_MAX_LINE_WIDTH,
  type GeoCoordMode, type GeoJsonGeomKind, type GeoJsonValueSource,
} from './geojsonImport';

/** What the dialog hands back on Import.
 *
 *  The GRID flavour deliberately carries CELL-INDEX groups rather than a
 *  full-grid value block: a vector burn writes only the cells it COVERS (unlike
 *  a raster, which replaces the whole board), and `paintManual` — "write value V
 *  of attribute A into this cell list" — is the seam that expresses exactly that
 *  on every compile target. `width` decodes an index back to (row, col). */
export type GeoJsonImportResult =
  | { target: 'agents'; agents: CsvAgentSpec[]; replace: boolean }
  | {
      target: 'grid'; attrId: string; layer: number; width: number; cellCount: number;
      groups: Array<{ value: number; cells: Int32Array }>;
    };

/** Longest edge of the coverage preview. */
const PREVIEW_MAX = 240;
/** Above this many covered cells the summary warns — the write goes out in
 *  `paintManual` batches and a whole-grid burn is a lot of messages. */
const BIG_BURN_CELLS = 1_000_000;

/** Distinct hues for the coverage preview (one per value group). */
const GROUP_HUES = [200, 40, 130, 320, 20, 265, 90, 355];

/** "Import GeoJSON" — the VECTOR sibling of the CSV / `.asc` / GeoTIFF dialogs.
 *
 *  Two consumers behind one Target switch:
 *    - Grid:   polygons / lines / points burn a value into ONE cell attribute
 *              (only the covered cells; everything else is untouched).
 *    - Agents: each POINT becomes an agent, its properties auto-mapped to agent
 *              attributes by name.
 *
 *  All geometry / decoding lives in the pure `geojsonImport.ts`; this file is the
 *  setup + preview + reporting surface. */
export function GeoJsonImportDialog({
  text, fileName, cellAttributes, agentAttributes, hasGrid, hasAgents, is3d,
  world, maxAgents, torus, modelGeoref, onApply, onCancel,
}: {
  text: string;
  fileName: string;
  cellAttributes: Attribute[];
  agentAttributes: Attribute[];
  hasGrid: boolean;
  hasAgents: boolean;
  is3d: boolean;
  world: { w: number; h: number; d: number };
  maxAgents: number;
  torus: boolean;
  modelGeoref?: GeoReference;
  onApply: (r: GeoJsonImportResult) => void;
  onCancel: () => void;
}) {
  const parsed = useMemo(() => parseGeoJson(text), [text]);

  // --- coordinate mode ------------------------------------------------------
  // World (via the model's georeference) whenever there IS one — that is what a
  // file exported from a GIS carries. Without a georeference the only meaningful
  // reading is "the coordinates ARE grid cells", so that becomes the only option.
  const hasGeoref = !!modelGeoref && modelGeoref.cellSize > 0;
  const [coordMode, setCoordMode] = useState<GeoCoordMode>(hasGeoref ? 'world' : 'cells');
  const effCoordMode: GeoCoordMode = hasGeoref ? coordMode : 'cells';

  // --- target ---------------------------------------------------------------
  const gridOpts = useMemo(() => gridTargetOptions(cellAttributes), [cellAttributes]);
  const pointsOnly = !!parsed && parsed.counts.point > 0 && parsed.counts.line === 0 && parsed.counts.polygon === 0;
  const gridAvailable = hasGrid && gridOpts.length > 0;
  const agentsAvailable = hasAgents && !!parsed && parsed.counts.point > 0;
  const [target, setTarget] = useState<'agents' | 'grid'>(() =>
    (agentsAvailable && (pointsOnly || !gridAvailable)) ? 'agents' : 'grid');
  const effTarget: 'agents' | 'grid' = gridAvailable ? (agentsAvailable ? target : 'grid') : 'agents';
  const showTargetSwitch = gridAvailable && agentsAvailable;

  const transform = useMemo(
    () => makeCellTransform(modelGeoref, world.h, effCoordMode),
    [modelGeoref, world.h, effCoordMode],
  );

  // --- grid mode ------------------------------------------------------------
  const [gridAttrId, setGridAttrId] = useState(() => gridOpts[0]?.id ?? '');
  useEffect(() => {
    if (!gridOpts.some(o => o.id === gridAttrId)) setGridAttrId(gridOpts[0]?.id ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridOpts]);
  const gridAttr = gridOpts.find(o => o.id === gridAttrId);

  const [layer, setLayer] = useState(0);
  const [lineWidth, setLineWidth] = useState(1);
  const [kinds, setKinds] = useState<Record<GeoJsonGeomKind, boolean>>({ point: true, line: true, polygon: true });
  const [valueMode, setValueMode] = useState<'fixed' | 'property'>('fixed');
  const [fixedValue, setFixedValue] = useState('');
  const [valueKey, setValueKey] = useState('');

  // Seed the burn value from the attribute's TYPE whenever the attribute changes:
  // something visibly different from the default (which is what an unburned cell
  // already holds), so a first-time import shows a result rather than a no-op.
  useEffect(() => {
    if (!gridAttr) { setFixedValue(''); return; }
    const t = gridAttr.attr.type;
    const tags = gridAttr.attr.tagOptions ?? [];
    setFixedValue(t === 'bool' ? 'true' : t === 'tag' ? String(tags.length > 1 ? 1 : 0) : '1');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridAttrId]);
  useEffect(() => {
    const keys = parsed?.propertyKeys ?? [];
    if (!keys.includes(valueKey)) setValueKey(keys[0] ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsed]);

  const valueSource: GeoJsonValueSource = valueMode === 'property' && valueKey
    ? { kind: 'property', key: valueKey }
    : { kind: 'fixed', value: gridAttr ? encodeAttrValue(gridAttr.attr, fixedValue === '' ? undefined : fixedValue) : 0 };

  const raster = useMemo(() => {
    if (effTarget !== 'grid' || !parsed || !gridAttr) return null;
    return rasterizeFeatures(parsed.items, transform, world.w, world.h, {
      kinds, lineWidth, value: valueSource, attr: gridAttr.attr,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effTarget, parsed, gridAttr, transform, world.w, world.h, kinds, lineWidth, valueMode, valueKey, fixedValue]);

  // --- agents mode ----------------------------------------------------------
  const agentAttrShapes = agentAttributes as unknown as CsvAttrShape[];
  const propertyKeys = parsed?.propertyKeys ?? [];
  const agentTargetOpts = useMemo(() => geoJsonAgentTargetOptions(agentAttrShapes, is3d), [agentAttributes, is3d]);
  const [propTargets, setPropTargets] = useState<string[]>([]);
  const propSig = propertyKeys.join('|');
  useEffect(() => {
    setPropTargets(autoMapGeoJsonProperties(propertyKeys, agentAttrShapes, is3d));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propSig, is3d, agentAttributes]);
  const [replace, setReplace] = useState(true);

  const agentBuild = useMemo(() => {
    if (effTarget !== 'agents' || !parsed) return null;
    return buildGeoJsonAgents(parsed.items, transform, propertyKeys, propTargets, agentAttrShapes, world, is3d);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effTarget, parsed, transform, propSig, propTargets, agentAttributes, world.w, world.h, world.d, is3d]);

  // --- coverage preview -----------------------------------------------------
  // What WILL be burned, sampled nearest onto a small canvas — so a wrong
  // coordinate mode (or a file that misses the grid entirely) is visible BEFORE
  // Import, not after. Sampling is O(preview pixels), never O(grid).
  const previewRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = previewRef.current;
    if (!cv || !raster || world.w < 1 || world.h < 1) return;
    const scale = Math.min(1, PREVIEW_MAX / Math.max(world.w, world.h));
    const pw = Math.max(1, Math.round(world.w * scale));
    const ph = Math.max(1, Math.round(world.h * scale));
    cv.width = pw; cv.height = ph;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(pw, ph);
    for (let r = 0; r < ph; r++) {
      const sr = Math.min(world.h - 1, Math.floor(((r + 0.5) * world.h) / ph));
      for (let c = 0; c < pw; c++) {
        const sc = Math.min(world.w - 1, Math.floor(((c + 0.5) * world.w) / pw));
        const g = raster.groupOf[sr * world.w + sc]!;
        const o = (r * pw + c) * 4;
        if (g < 0) { img.data[o + 3] = 0; continue; }
        // A distinct hue per value group, converted from HSL by hand (no DOM).
        const h = GROUP_HUES[g % GROUP_HUES.length]! / 60;
        const x = 1 - Math.abs((h % 2) - 1);
        const [rr, gg, bb] = h < 1 ? [1, x, 0] : h < 2 ? [x, 1, 0] : h < 3 ? [0, 1, x]
          : h < 4 ? [0, x, 1] : h < 5 ? [x, 0, 1] : [1, 0, x];
        img.data[o] = Math.round(60 + rr * 195);
        img.data[o + 1] = Math.round(60 + gg * 195);
        img.data[o + 2] = Math.round(60 + bb * 195);
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [raster, world.w, world.h]);

  // --- reporting ------------------------------------------------------------
  const fileSummary = (() => {
    if (!parsed) return '';
    const c = parsed.counts;
    const parts: string[] = [];
    const geo: string[] = [];
    if (c.polygon) geo.push(`${c.polygon} polygon${c.polygon === 1 ? '' : 's'}`);
    if (c.line) geo.push(`${c.line} line${c.line === 1 ? '' : 's'}`);
    if (c.point) geo.push(`${c.point} point${c.point === 1 ? '' : 's'}`);
    parts.push(geo.length ? geo.join(' · ') : 'no usable geometry');
    if (parsed.skipped) parts.push(`${parsed.skipped} skipped`);
    if (parsed.bbox) {
      const d = effCoordMode === 'world' && transform.cellSize < 1 ? 6 : 2;
      parts.push(`extent (${parsed.bbox.minX.toFixed(d)}, ${parsed.bbox.minY.toFixed(d)}) → (${parsed.bbox.maxX.toFixed(d)}, ${parsed.bbox.maxY.toFixed(d)})`);
    }
    parts.push(effCoordMode === 'world'
      ? `world coords · origin (${modelGeoref!.xllcorner}, ${modelGeoref!.yllcorner}) · cell size ${modelGeoref!.cellSize}`
      : 'read as grid cells (x → column, y → row)');
    return parts.join(' · ');
  })();

  const summary = (() => {
    if (!parsed) return '';
    if (effTarget === 'agents') {
      const b = agentBuild; if (!b) return '';
      const parts = [`${b.agents.length} agent${b.agents.length === 1 ? '' : 's'} from ${parsed.counts.point} point${parsed.counts.point === 1 ? '' : 's'}`];
      if (b.skippedNonPoint) parts.push(`${b.skippedNonPoint} non-point feature${b.skippedNonPoint === 1 ? '' : 's'} ignored`);
      if (b.skippedBadPosition) parts.push(`${b.skippedBadPosition} skipped (bad position)`);
      if (b.badValues) parts.push(`${b.badValues} propert${b.badValues === 1 ? 'y' : 'ies'} defaulted`);
      if (b.outOfBounds) parts.push(`${b.outOfBounds} out of bounds (${torus ? 'wrapped' : 'clamped'})`);
      if (replace && b.agents.length > maxAgents) parts.push(`${b.agents.length - maxAgents} beyond maxAgents (${maxAgents}) will not fit`);
      return parts.join(' · ');
    }
    const g = raster; if (!g) return '';
    const parts = [`${g.cellCount.toLocaleString()} cell${g.cellCount === 1 ? '' : 's'} covered of ${(world.w * world.h).toLocaleString()}`];
    parts.push(`${g.featuresUsed} feature${g.featuresUsed === 1 ? '' : 's'} burned`);
    if (g.groupValues.length > 1) parts.push(`${g.groupValues.length} distinct values`);
    if (g.featuresFiltered) parts.push(`${g.featuresFiltered} filtered out by geometry type`);
    if (g.featuresOutside) parts.push(`${g.featuresOutside} covered no cell (outside the grid, or smaller than a cell)`);
    if (g.badValues) parts.push(`${g.badValues} propert${g.badValues === 1 ? 'y' : 'ies'} defaulted`);
    if (g.cellCount > BIG_BURN_CELLS) parts.push('a large burn — it may take a moment');
    return parts.join(' · ');
  })();

  const issues = (effTarget === 'agents' ? agentBuild?.issues : raster?.issues) ?? [];
  const clean = issues.length === 0
    && (effTarget === 'agents'
      ? (agentBuild?.skippedBadPosition ?? 0) === 0
      : (raster?.featuresOutside ?? 0) === 0 && (raster?.cellCount ?? 0) > 0);

  const applyDisabled = !parsed
    || (effTarget === 'agents'
      ? !agentBuild || agentBuild.agents.length === 0
      : !raster || !gridAttr || raster.cellCount === 0);

  const handleApply = () => {
    if (!parsed) return;
    if (effTarget === 'agents') {
      if (!agentBuild || agentBuild.agents.length === 0) return;
      onApply({ target: 'agents', agents: agentBuild.agents, replace });
      return;
    }
    if (!raster || !gridAttr) return;
    onApply({
      target: 'grid', attrId: gridAttr.id,
      layer: is3d ? Math.max(0, Math.min(world.d - 1, Math.round(layer))) : 0,
      width: world.w, cellCount: raster.cellCount,
      groups: collectRasterGroups(raster),
    });
  };

  // --- styles (mirrors CsvImportDialog / GeoTiffImportDialog) ----------------
  const overlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 9000, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', overflow: 'auto', padding: '4vh 12px' };
  const card: React.CSSProperties = { background: 'var(--color-bg-panel, #14161c)', border: '1px solid var(--color-border, #2a3a50)', borderRadius: 8, padding: 16, width: 'min(1040px, 96vw)', maxHeight: '92vh', overflow: 'auto', color: 'var(--color-text, #cdd6e0)', boxShadow: '0 8px 40px rgba(0,0,0,0.6)' };
  const label: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' };
  const note: React.CSSProperties = { fontSize: 10.5, color: '#8090a0', lineHeight: 1.5 };
  const warn: React.CSSProperties = { fontSize: 11, color: '#e0b060' };
  const btn: React.CSSProperties = { padding: '2px 10px', fontSize: 12, cursor: 'pointer', background: 'var(--color-widget-bg, #1c2028)', color: 'inherit', border: '1px solid var(--color-border, #2a3a50)', borderRadius: 4 };
  // Overrides `border` WHOLESALE rather than `borderColor`: swapping a shorthand
  // for a longhand across a re-render makes React warn about mixing the two.
  const btnOn: React.CSSProperties = { ...btn, background: 'var(--color-accent-soft, #3a2c14)', border: '1px solid var(--color-accent, #e8a13a)', color: 'var(--color-accent, #e8a13a)', fontWeight: 600 };

  const kindRow = (kind: GeoJsonGeomKind, n: number, text: string) => (n > 0 ? (
    <label key={kind} style={label}>
      <input type="checkbox" checked={kinds[kind]} onChange={e => setKinds(k => ({ ...k, [kind]: e.target.checked }))} />
      {text} <span style={{ color: '#667', fontSize: 10.5 }}>({n})</span>
    </label>
  ) : null);

  return (
    <div style={overlay} onClick={onCancel}>
      <div style={card} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>Import GeoJSON <span style={{ color: '#8090a0', fontWeight: 400, fontSize: 12 }}>— {fileName}</span></h3>
          <button onClick={onCancel} style={{ background: 'none', border: 'none', color: 'inherit', fontSize: 18, cursor: 'pointer' }} title="Cancel">&times;</button>
        </div>

        {!parsed && (
          <div style={{ color: '#e05050', fontSize: 12, padding: '8px 0' }}>
            This file is not GeoJSON — expected a FeatureCollection, a Feature or a bare geometry.
            (A GeoJSON saved as <code>.json</code> works from this menu item; a <code>.json</code> DROPPED on the
            window is read as a GenesisCA project instead.)
          </div>
        )}

        {parsed && (
          <>
            {showTargetSwitch && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
                <span style={{ fontSize: 12, color: '#8090a0' }}>Target</span>
                <button style={effTarget === 'grid' ? btnOn : btn} onClick={() => setTarget('grid')}>Rasterise onto an attribute</button>
                <button style={effTarget === 'agents' ? btnOn : btn} onClick={() => setTarget('agents')}>Create agents from points</button>
              </div>
            )}

            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              {/* LEFT — coverage preview + summary. */}
              <div style={{ flex: '1 1 380px', minWidth: 0 }}>
                <div style={{ fontSize: 11, color: '#8090a0', marginBottom: 4 }}>
                  {effTarget === 'grid'
                    ? `Coverage on the ${world.w}×${world.h} grid — colour per value`
                    : 'Points become agents at their projected positions'}
                </div>
                {effTarget === 'grid' ? (
                  <div style={{ border: '1px solid #2a3a50', background: '#0a0b0e', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 120, padding: 6 }}>
                    <canvas ref={previewRef} style={{ imageRendering: 'pixelated', maxWidth: '100%' }} />
                  </div>
                ) : (
                  <div style={{ border: '1px solid #2a3a50', background: '#0a0b0e', padding: '8px 10px', fontSize: 11, color: '#8090a0', lineHeight: 1.6 }}>
                    Position comes from the point <b>geometry</b>; every other value comes from the
                    feature&apos;s <b>properties</b> (mapped on the right). Altitude — a 3rd coordinate —
                    is ignored: it is a height in world units, not a grid layer.
                  </div>
                )}

                <div style={{ marginTop: 8, padding: '6px 10px', borderRadius: 4, fontSize: 11.5, border: '1px solid #3a4a2a', background: '#161a12', color: '#9ccc65' }}>
                  {fileSummary}
                </div>
                {parsed.crs && (
                  <div style={{ ...warn, marginTop: 4 }}>
                    The file declares <b>{parsed.crs}</b>. GenesisCA does not reproject — the coordinates must
                    already be in the model&apos;s CRS{modelGeoref?.crs ? ` (${modelGeoref.crs})` : ''}; align them in QGIS first.
                  </div>
                )}
                {!hasGeoref && (
                  <div style={{ ...warn, marginTop: 4 }}>
                    This model has no georeference, so the coordinates are read as grid cells. Import an
                    <code> .asc</code> / GeoTIFF, or set the origin + cell size in Properties → Structure, to place
                    world coordinates.
                  </div>
                )}

                <div style={{ marginTop: 8, padding: '6px 10px', borderRadius: 4, fontSize: 11.5, border: '1px solid ' + (clean ? '#3a4a2a' : '#5a4a20'), background: clean ? '#161a12' : '#1c1810', color: clean ? '#9ccc65' : '#e0b060' }}>
                  {summary}
                  {issues.length > 0 && (
                    <ul style={{ margin: '4px 0 0', paddingLeft: 16, color: '#c09050' }}>
                      {issues.slice(0, 5).map((it, i) => (
                        <li key={i} style={{ fontSize: 10.5 }}>feature {it.row}, {it.column}: &quot;{it.raw}&quot; → default ({it.reason})</li>
                      ))}
                      {issues.length > 5 && <li style={{ fontSize: 10.5 }}>… and {issues.length - 5} more</li>}
                    </ul>
                  )}
                </div>
              </div>

              {/* RIGHT — options. */}
              <div style={{ flex: '0 0 330px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label style={{ ...label, gap: 6 }}>
                  Coordinates
                  <select value={effCoordMode} onChange={e => setCoordMode(e.target.value as GeoCoordMode)}
                    disabled={!hasGeoref} style={{ fontSize: 12, flex: 1, minWidth: 0 }}>
                    <option value="world" disabled={!hasGeoref}>
                      {hasGeoref ? 'World (the model’s georeference)' : 'World — no georeference on this model'}
                    </option>
                    <option value="cells">Grid cells (x → column, y → row)</option>
                  </select>
                </label>

                {effTarget === 'grid' ? (
                  <>
                    <label style={{ ...label, gap: 6 }}>
                      Cell attribute
                      <select value={gridAttrId} onChange={e => setGridAttrId(e.target.value)} style={{ fontSize: 12, flex: 1, minWidth: 0 }}>
                        {gridOpts.length === 0 && <option value="">(no cell attributes)</option>}
                        {gridOpts.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
                      </select>
                    </label>

                    <div style={{ fontSize: 11, color: '#8090a0' }}>Value</div>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <button style={valueMode === 'fixed' ? btnOn : btn} onClick={() => setValueMode('fixed')}>Fixed</button>
                      <button style={valueMode === 'property' ? btnOn : btn}
                        onClick={() => setValueMode('property')} disabled={propertyKeys.length === 0}
                        title={propertyKeys.length === 0 ? 'No feature carries properties' : 'Each feature paints its own property value'}>
                        From property
                      </button>
                    </div>
                    {valueMode === 'fixed' ? (
                      <label style={{ ...label, gap: 6 }}>
                        Burn
                        {gridAttr?.attr.type === 'bool' ? (
                          <select value={fixedValue} onChange={e => setFixedValue(e.target.value)} style={{ fontSize: 12 }}>
                            <option value="false">False</option><option value="true">True</option>
                          </select>
                        ) : gridAttr?.attr.type === 'tag' ? (
                          <select value={fixedValue} onChange={e => setFixedValue(e.target.value)} style={{ fontSize: 12, flex: 1, minWidth: 0 }}>
                            {(gridAttr.attr.tagOptions ?? []).map((t, i) => <option key={i} value={String(i)}>{t}</option>)}
                          </select>
                        ) : (
                          <InlineNumberInput value={fixedValue} onChange={setFixedValue} step="any" style={{ width: 84, fontSize: 12 }} />
                        )}
                      </label>
                    ) : (
                      <label style={{ ...label, gap: 6 }}>
                        Property
                        <select value={valueKey} onChange={e => setValueKey(e.target.value)} style={{ fontSize: 12, flex: 1, minWidth: 0 }}>
                          {propertyKeys.map(k => <option key={k} value={k}>{k}</option>)}
                        </select>
                      </label>
                    )}

                    <hr style={{ border: 'none', borderTop: '1px solid #2a3a50', margin: '2px 0' }} />
                    <div style={{ fontSize: 11, color: '#8090a0' }}>Burn which geometry</div>
                    {kindRow('polygon', parsed.counts.polygon, 'Polygons (fill)')}
                    {kindRow('line', parsed.counts.line, 'Lines (stroke)')}
                    {kindRow('point', parsed.counts.point, 'Points (one cell)')}
                    {parsed.counts.line > 0 && kinds.line && (
                      <label style={{ ...label, gap: 6 }}>
                        Line width
                        <NumberField value={lineWidth} onNumber={setLineWidth} min={1} max={GEOJSON_MAX_LINE_WIDTH} integer
                          style={{ width: 64, fontSize: 12 }} />
                        <span style={{ fontSize: 10.5, color: '#8090a0' }}>cells</span>
                      </label>
                    )}
                    {is3d && (
                      <label style={{ ...label, gap: 6 }}>
                        Layer
                        <NumberField value={layer} onNumber={setLayer} min={0} max={Math.max(0, world.d - 1)} integer
                          style={{ width: 64, fontSize: 12 }} />
                        <span style={{ fontSize: 10.5, color: '#8090a0' }}>of {world.d}</span>
                      </label>
                    )}
                    <div style={note}>
                      Only the <b>covered</b> cells are written — everything else keeps its value (unlike a raster
                      import, which replaces the whole board). A cell is inside a polygon when its <b>centre</b> is;
                      a width-1 line takes every cell it passes through. Overlapping features: the LAST one wins.
                      {is3d && ' A flat vector layer cannot fill a volume, so it writes ONE layer.'}
                    </div>
                  </>
                ) : (
                  <>
                    <label style={label}>
                      <input type="radio" checked={replace} onChange={() => setReplace(true)} /> Replace population (kill all first)
                    </label>
                    <label style={label}>
                      <input type="radio" checked={!replace} onChange={() => setReplace(false)} /> Append to the current population
                    </label>
                    <div style={{ fontSize: 11, color: '#8090a0' }}>
                      Out of bounds: {torus ? 'wrap (torus)' : 'clamp'} · capacity {agentBuild?.agents.length ?? 0} / {maxAgents}
                    </div>
                    <hr style={{ border: 'none', borderTop: '1px solid #2a3a50', margin: '2px 0' }} />
                    <div style={{ fontSize: 11, color: '#8090a0' }}>
                      Properties → agent values ({propertyKeys.length})
                    </div>
                    {propertyKeys.length === 0 && <div style={note}>No feature carries properties — the agents get their defaults.</div>}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 260, overflow: 'auto' }}>
                      {propertyKeys.map((k, i) => (
                        <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 5px', borderRadius: 4, border: '1px solid #2a3a50', background: '#12161d' }}>
                          <span title={k} style={{ fontSize: 11, color: '#cdd6e0', flex: '0 0 110px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{k}</span>
                          <select
                            value={propTargets[i] ?? 'ignore'}
                            onChange={e => setPropTargets(t => { const n = [...t]; while (n.length <= i) n.push('ignore'); n[i] = e.target.value; return n; })}
                            style={{ fontSize: 11, flex: 1, minWidth: 0, color: (propTargets[i] ?? 'ignore') === 'ignore' ? '#667' : 'var(--color-accent, #e8a13a)' }}
                          >
                            {agentTargetOpts.map(o => <option key={o.key} value={o.key} style={{ color: '#cdd6e0' }}>{o.label}</option>)}
                          </select>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>
          </>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <button onClick={onCancel} style={{ padding: '6px 14px', cursor: 'pointer' }}>Cancel</button>
          <button onClick={handleApply} disabled={applyDisabled}
            style={{ padding: '6px 14px', cursor: applyDisabled ? 'not-allowed' : 'pointer', background: applyDisabled ? '#333' : 'var(--color-accent, #4cc9f0)', color: applyDisabled ? '#888' : '#08121a', border: 'none', borderRadius: 4, fontWeight: 600 }}>
            Import
          </button>
        </div>
      </div>
    </div>
  );
}

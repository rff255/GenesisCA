import { useEffect, useMemo, useRef, useState } from 'react';
import type { Attribute, GeoReference } from '../model/types';
import { InlineNumberInput } from '../modeler/vpl/widgets/InlineWidgets';
import {
  parseCsvTable, detectDelimiter, detectHeader, parseCsvRows,
  autoMapAgentColumns, agentTargetOptions, buildAgentSpecs,
  buildGridValues, gridTargetOptions,
  distinctChars, autoSeedCharMap, charLabel, CSV_NO_DELIMITER,
  parseAscGrid, isAscGridText, resampleCsvTable, csvTableToNumbers,
  type AscGrid, type CsvAgentSpec, type CsvAttrShape, type CsvCharMap, type CsvGridBuild,
} from './csvImport';
import { buildBandValues, supportsAverageResample, scaleGeorefForResample } from './geotiffImport';
import type { RasterResampleMethod } from './rasterResample';

/** What the dialog hands back on Import. Exactly one of `agents` / `grid` is set
 *  (the Target switch decides).
 *
 *  The grid flavour carries a LIST of layers: a CSV / char board is always one,
 *  and an Esri ASCII grid session can be several co-registered `.asc` files (the
 *  FARSITE/Cell2Fire layer stack), each into its own cell attribute. `georef` is
 *  set only by the `.asc` path, from the file's own header. */
export type CsvImportResult =
  | { target: 'agents'; agents: CsvAgentSpec[]; replace: boolean }
  | {
      target: 'grid'; width: number; height: number; layer: number; resize: boolean;
      layers: Array<{ attrId: string; values: Float64Array }>;
      georef?: GeoReference;
    };

const PREVIEW_ROWS = 8;
/** Guard the preview table's width — a wide CSV would otherwise blow the card. */
const PREVIEW_COLS = 40;

/** "Import CSV" — the tabular sibling of the Map Image to Cells dialog.
 *
 *  Two modes behind one Target switch:
 *    - Agents: a row is an agent; per-column targets (position / velocity /
 *      radius / agent attribute / vector component) with name auto-mapping.
 *    - Grid:   the CSV IS the board (a line is a grid ROW, a field a COLUMN) and
 *      every value goes into ONE chosen cell attribute.
 *
 *  All parsing / decoding lives in the pure `csvImport.ts` module; this file is
 *  only the setup + preview + reporting surface. */
export function CsvImportDialog({
  text, fileName, cellAttributes, agentAttributes, hasGrid, hasAgents, is3d,
  world, maxAgents, torus, onApply, onCancel,
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
  onApply: (r: CsvImportResult) => void;
  onCancel: () => void;
}) {
  // --- Esri ASCII grid (`.asc`) ---------------------------------------------
  // A `.asc` is a georeferenced RASTER, so it decides the dialog's whole shape:
  // the Grid flavour is forced (an agent row/column mapping is meaningless for a
  // raster), and the delimiter + header controls are hidden (the format defines
  // both). Several co-registered `.asc` files can be imported in one session,
  // each into its own cell attribute — the FARSITE/Cell2Fire layer stack.
  const primaryAsc = useMemo(() => (isAscGridText(text) ? parseAscGrid(text) : null), [text]);
  const isAsc = primaryAsc !== null;

  // --- parse options (auto with an explicit override) -----------------------
  const autoDelim = useMemo(() => (isAsc ? ',' : detectDelimiter(text)), [text, isAsc]);
  const autoHeader = useMemo(() => (isAsc ? false : detectHeader(parseCsvRows(text, autoDelim))), [text, autoDelim, isAsc]);
  const [delimChoice, setDelimChoice] = useState<'auto' | ',' | ';' | '\t' | 'none'>('auto');
  const [headerChoice, setHeaderChoice] = useState<'auto' | 'yes' | 'no'>('auto');

  // --- target layer ---------------------------------------------------------
  // Both layers present → default from the header heuristic: a header names
  // FIELDS (the agent shape); a bare block of values is a BOARD.
  const [target, setTarget] = useState<'agents' | 'grid'>(() => {
    if (!hasAgents) return 'grid';
    if (!hasGrid) return 'agents';
    return autoHeader ? 'agents' : 'grid';
  });
  const showTargetSwitch = hasGrid && hasAgents && !isAsc;
  const effTarget: 'agents' | 'grid' = isAsc ? 'grid' : hasAgents ? (hasGrid ? target : 'agents') : 'grid';

  // "No delimiter" (1 char = 1 cell) is GRID-ONLY: one character per column is
  // meaningless for the agent x/y/attribute columns, which need multi-digit
  // numbers and tag names. The option renders disabled-with-a-reason in Agents
  // mode, and a stale `none` selection COERCES back to auto so switching Target
  // can never silently apply a nonsensical parse.
  const noneAllowed = effTarget === 'grid';
  const effDelimChoice = delimChoice === 'none' && !noneAllowed ? 'auto' : delimChoice;
  // `.asc` defines its own (whitespace) delimiter, so the char-per-cell mode can
  // never apply there — including via a stale selection made before the file was
  // swapped.
  const isCharMode = !isAsc && effDelimChoice === 'none';
  const delimiter = effDelimChoice === 'auto' ? autoDelim : effDelimChoice === 'none' ? CSV_NO_DELIMITER : effDelimChoice;

  // The header default is TARGET-DEPENDENT. In Grid mode the CSV *is* the board,
  // so every line is a row: defaulting to "header" there would silently DROP the
  // board's first row (the heuristic fires on an all-text tag grid as soon as any
  // later cell is numeric — e.g. a tag written as its index). Treating a grid as
  // all-data instead fails LOUDLY when the file really does carry column names
  // (every cell of row 1 reports as defaulted in the summary), which is the right
  // trade for a data-import feature. Agents keep the heuristic — there a header is
  // the norm and it names the columns the mapping needs. Overridable either way.
  // In char mode a header row cannot exist (every character is a cell), so the
  // heuristic AND the override are both bypassed — parseCsvTable forces it off.
  const autoHeaderForTarget = effTarget === 'grid' ? false : autoHeader;
  const hasHeader = isCharMode ? false : (headerChoice === 'auto' ? autoHeaderForTarget : headerChoice === 'yes');

  const table = useMemo(
    () => (primaryAsc ? primaryAsc.table : parseCsvTable(text, { delimiter, hasHeader })),
    [text, delimiter, hasHeader, primaryAsc],
  );

  // --- agents mode ----------------------------------------------------------
  const agentAttrShapes = agentAttributes as unknown as CsvAttrShape[];
  const targetOpts = useMemo(() => agentTargetOptions(agentAttrShapes, is3d), [agentAttributes, is3d]);
  // Re-derive the auto map whenever the parsed SHAPE changes (delimiter / header
  // flip / a new file); user overrides live in `columnTargets` until then.
  const shapeSig = `${table.width}|${table.header?.join('') ?? ''}`;
  const [columnTargets, setColumnTargets] = useState<string[]>(() => autoMapAgentColumns(table.header, agentAttrShapes, is3d, table.width));
  useEffect(() => {
    setColumnTargets(autoMapAgentColumns(table.header, agentAttrShapes, is3d, table.width));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shapeSig, is3d]);

  const [replace, setReplace] = useState(true);

  const agentBuild = useMemo(
    () => (effTarget === 'agents' ? buildAgentSpecs(table, columnTargets, agentAttrShapes, world, is3d) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [effTarget, table, columnTargets, agentAttributes, world.w, world.h, world.d, is3d],
  );

  // --- grid mode ------------------------------------------------------------
  const gridOpts = useMemo(() => gridTargetOptions(cellAttributes), [cellAttributes]);
  const [gridAttrId, setGridAttrId] = useState(() => gridOpts[0]?.id ?? '');
  useEffect(() => {
    if (!gridOpts.some(o => o.id === gridAttrId)) setGridAttrId(gridOpts[0]?.id ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridOpts]);
  // `resample` is `.asc`-only: a georeferenced raster has a cell SIZE, so
  // resampling it onto the model's grid is a meaningful (and georef-correct)
  // operation. A plain CSV board has no such scale, so it keeps resize / keep.
  const [fit, setFit] = useState<'resize' | 'keep' | 'resample'>('resize');
  const [ascMethod, setAscMethod] = useState<RasterResampleMethod>('nearest');
  const [layer, setLayer] = useState(0);
  const gridAttr = gridOpts.find(o => o.id === gridAttrId);

  // --- char mode: the char → value map --------------------------------------
  // The map is the core of "no delimiter": ANY character can stand for ANY value
  // (so `a → 10` works on an integer attribute); digits are only the auto-seed.
  // Session-scoped and re-seeded whenever the parsed CHARACTER SET or the target
  // ATTRIBUTE changes (a different type / tag list implies different seeds); user
  // edits survive until then. Deliberately NOT persisted — a char map only means
  // anything for the file it came from.
  const chars = useMemo(() => (isCharMode ? distinctChars(table) : []), [isCharMode, table]);
  const [charMap, setCharMap] = useState<CsvCharMap>({});
  const charSeedSig = isCharMode ? `${gridAttrId}|${chars.map(c => c.char).join('')}` : '';
  useEffect(() => {
    if (!isCharMode || !gridAttr) { setCharMap({}); return; }
    setCharMap(autoSeedCharMap(chars, gridAttr.attr));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [charSeedSig, isCharMode]);
  const setCharValue = (ch: string, v: string) => setCharMap(m => ({ ...m, [ch]: v }));

  // --- `.asc` layer stack ----------------------------------------------------
  // One entry per co-registered file. The PRIMARY (the file the dialog was
  // opened with) is entry 0 and cannot be removed; "+ Add layer" appends more.
  // All layers must agree on ncols/nrows — the co-registration contract every
  // surveyed tool enforces — checked loudly below and blocking Apply.
  interface AscLayer { key: number; name: string; asc: AscGrid; attrId: string }
  const [ascExtra, setAscExtra] = useState<AscLayer[]>([]);
  const ascKeySeq = useRef(1);
  const ascInputRef = useRef<HTMLInputElement>(null);
  const [ascError, setAscError] = useState<string | null>(null);
  // A new file re-opens the dialog with fresh text (the component is not
  // remounted), so the stack must reset with it.
  useEffect(() => { setAscExtra([]); setAscError(null); }, [text]);
  const addAscFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    void (async () => {
      const added: AscLayer[] = [];
      const bad: string[] = [];
      for (const f of Array.from(files)) {
        try {
          const t = await f.text();
          const g = parseAscGrid(t);
          if (!g) { bad.push(`${f.name} (not an Esri ASCII grid)`); continue; }
          added.push({ key: ascKeySeq.current++, name: f.name, asc: g, attrId: gridOpts[0]?.id ?? '' });
        } catch (err) {
          bad.push(`${f.name} (${err instanceof Error ? err.message : String(err)})`);
        }
      }
      if (added.length > 0) setAscExtra(prev => [...prev, ...added]);
      setAscError(bad.length > 0 ? `Could not read: ${bad.join(', ')}` : null);
    })();
  };
  const setAscLayerAttr = (key: number, attrId: string) =>
    setAscExtra(prev => prev.map(l => (l.key === key ? { ...l, attrId } : l)));

  /** Every layer to import, primary first (the primary's attribute is the shared
   *  "Cell attribute" select, so a single-file import reads exactly like a CSV). */
  const ascLayers: AscLayer[] = useMemo(
    () => (primaryAsc ? [{ key: 0, name: fileName, asc: primaryAsc, attrId: gridAttrId }, ...ascExtra] : []),
    [primaryAsc, fileName, gridAttrId, ascExtra],
  );
  const ascMismatched = ascLayers.filter(l => l.asc.ncols !== (primaryAsc?.ncols ?? 0) || l.asc.nrows !== (primaryAsc?.nrows ?? 0));

  /** Build ONE `.asc` layer, honouring the resample fit.
   *
   *  NEAREST resamples the parsed TABLE — cell text and all — so every existing
   *  behaviour of `buildGridValues` survives (a tag matched by NAME, the per-cell
   *  issue reporting, ragged padding). AVERAGE has to go through numbers (a mean
   *  over text is undefined), so it reads the body as raw values and hands them
   *  to the SAME `buildBandValues` the GeoTIFF importer uses — one box filter,
   *  one NODATA rule, for both formats. It is refused for a categorical target
   *  there regardless of what is asked for. */
  const buildAscLayer = (asc: AscGrid, attr: CsvAttrShape): CsvGridBuild => {
    if (fit !== 'resample') return buildGridValues(asc.table, attr, undefined, asc.nodataValue);
    if (ascMethod === 'average' && supportsAverageResample(attr)) {
      const num = csvTableToNumbers(asc.table);
      const b = buildBandValues(num.data, num.width, num.height, world.w, world.h, attr, {
        noData: asc.nodataValue, resample: 'average',
      });
      return { values: b.values, width: b.width, height: b.height, badValues: b.badValues, paddedCells: 0, nodataCells: b.nodataCells, issues: b.issues };
    }
    return buildGridValues(resampleCsvTable(asc.table, world.w, world.h), attr, undefined, asc.nodataValue);
  };

  const gridBuild = useMemo(
    () => {
      if (effTarget !== 'grid' || !gridAttr) return null;
      if (primaryAsc) return buildAscLayer(primaryAsc, gridAttr.attr);
      return buildGridValues(table, gridAttr.attr, isCharMode ? charMap : undefined, undefined);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [effTarget, table, gridAttr, isCharMode, charMap, primaryAsc, fit, ascMethod, world.w, world.h],
  );
  const dimsMatch = !!gridBuild && gridBuild.width === world.w && gridBuild.height === world.h;
  /** Any `.asc` layer whose target could legitimately be averaged — the method
   *  control is hidden entirely when none can (categorical layers only). */
  const ascAvgPossible = ascLayers.some(l => {
    const a = gridOpts.find(o => o.id === l.attrId)?.attr;
    return !!a && supportsAverageResample(a);
  });

  // --- reporting ------------------------------------------------------------
  const summary = (() => {
    if (effTarget === 'agents') {
      const b = agentBuild; if (!b) return '';
      const parts = [`${b.agents.length} agent${b.agents.length === 1 ? '' : 's'} from ${table.rows.length} row${table.rows.length === 1 ? '' : 's'}`];
      if (b.skippedRows) parts.push(`${b.skippedRows} row${b.skippedRows === 1 ? '' : 's'} skipped (no position)`);
      if (b.badValues) parts.push(`${b.badValues} unparseable value${b.badValues === 1 ? '' : 's'} defaulted`);
      if (b.outOfBounds) parts.push(`${b.outOfBounds} out of bounds (${torus ? 'wrapped' : 'clamped'})`);
      const over = Math.max(0, b.agents.length - maxAgents + (replace ? 0 : 0));
      if (over > 0 && replace) parts.push(`${over} beyond maxAgents (${maxAgents}) will not fit`);
      return parts.join(' · ');
    }
    const g = gridBuild; if (!g) return '';
    const parts = [`${g.width} wide × ${g.height} tall`];
    if (primaryAsc) {
      if (ascLayers.length > 1) parts.push(`${ascLayers.length} layers`);
      if (fit === 'resample' && (primaryAsc.ncols !== world.w || primaryAsc.nrows !== world.h)) {
        parts.push(`resampled from ${primaryAsc.ncols}×${primaryAsc.nrows} (${ascMethod})`);
      }
      const outCell = fit === 'resample' && world.w > 0
        ? (primaryAsc.cellSize * primaryAsc.ncols) / world.w
        : primaryAsc.cellSize;
      parts.push(`cell size ${outCell} · origin (${primaryAsc.xllcorner}, ${primaryAsc.yllcorner})${primaryAsc.centerOrigin ? ' — converted from a centre origin' : ''}`);
      if (g.nodataCells) parts.push(`${g.nodataCells} NODATA cell${g.nodataCells === 1 ? '' : 's'} (${primaryAsc.nodataValue}) → default`);
      const declared = primaryAsc.ncols * primaryAsc.nrows;
      if (primaryAsc.tokenCount !== declared) parts.push(`header declares ${declared} values, the body holds ${primaryAsc.tokenCount}`);
    }
    if (isCharMode) {
      const un = g.unmappedChars ?? [];
      if (g.badValues) parts.push(`${g.badValues} cell${g.badValues === 1 ? '' : 's'} with an unmapped character (${un.map(charLabel).join(' ')}) → default`);
    } else if (g.badValues) parts.push(`${g.badValues} unparseable value${g.badValues === 1 ? '' : 's'} defaulted`);
    if (g.paddedCells) parts.push(`${g.paddedCells} short cell${g.paddedCells === 1 ? '' : 's'} padded with the default`);
    if (fit === 'keep' && !dimsMatch) parts.push(`does NOT match the grid (${world.w}×${world.h})`);
    return parts.join(' · ');
  })();
  const issues = (effTarget === 'agents' ? agentBuild?.issues : gridBuild?.issues) ?? [];
  const clean = issues.length === 0 && (effTarget === 'agents' ? (agentBuild?.skippedRows ?? 0) === 0 : (gridBuild?.paddedCells ?? 0) === 0);

  const applyDisabled = effTarget === 'agents'
    ? !agentBuild || agentBuild.agents.length === 0
    : !gridBuild || !gridAttr || gridBuild.width < 1 || gridBuild.height < 1
      || (fit === 'keep' && !dimsMatch)
      || ascMismatched.length > 0
      || (!!primaryAsc && ascLayers.some(l => !l.attrId));

  const handleApply = () => {
    if (effTarget === 'agents') {
      if (!agentBuild) return;
      onApply({ target: 'agents', agents: agentBuild.agents, replace });
    } else {
      if (!gridBuild || !gridAttr) return;
      // One layer for a CSV / char board; one per co-registered `.asc` file
      // otherwise (the primary reuses the build the preview already made).
      const layers = primaryAsc
        ? ascLayers.map(l => ({
            attrId: l.attrId,
            values: l.key === 0
              ? gridBuild.values
              : buildAscLayer(l.asc, gridOpts.find(o => o.id === l.attrId)?.attr ?? gridAttr.attr).values,
          }))
        : [{ attrId: gridAttr.id, values: gridBuild.values }];
      // A resample covers the SAME ground with a different number of cells, so
      // the corner stays put and only the cell size scales.
      const ascGeoref = primaryAsc
        ? { xllcorner: primaryAsc.xllcorner, yllcorner: primaryAsc.yllcorner, cellSize: primaryAsc.cellSize }
        : undefined;
      onApply({
        target: 'grid', width: gridBuild.width, height: gridBuild.height,
        layer: is3d ? Math.max(0, Math.min(world.d - 1, Math.round(layer))) : 0,
        layers, resize: fit === 'resize',
        georef: ascGeoref && fit === 'resample'
          ? scaleGeorefForResample(ascGeoref, primaryAsc!.ncols, primaryAsc!.nrows, world.w, world.h).georef
          : ascGeoref,
      });
    }
  };

  // --- styles (mirrors ImageMappingDialog) ----------------------------------
  const overlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 9000, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', overflow: 'auto', padding: '4vh 12px' };
  const card: React.CSSProperties = { background: 'var(--color-bg-panel, #14161c)', border: '1px solid var(--color-border, #2a3a50)', borderRadius: 8, padding: 16, width: 'min(1040px, 96vw)', maxHeight: '92vh', overflow: 'auto', color: 'var(--color-text, #cdd6e0)', boxShadow: '0 8px 40px rgba(0,0,0,0.6)' };
  const label: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' };
  const btn: React.CSSProperties = { padding: '2px 10px', fontSize: 12, cursor: 'pointer', background: 'var(--color-widget-bg, #1c2028)', color: 'inherit', border: '1px solid var(--color-border, #2a3a50)', borderRadius: 4 };
  const btnOn: React.CSSProperties = { ...btn, background: 'var(--color-accent-soft, #3a2c14)', borderColor: 'var(--color-accent, #e8a13a)', color: 'var(--color-accent, #e8a13a)', fontWeight: 600 };
  const th: React.CSSProperties = { border: '1px solid #22303f', padding: '2px 6px', fontSize: 10.5, color: '#8090a0', whiteSpace: 'nowrap', textAlign: 'left' };
  const td: React.CSSProperties = { border: '1px solid #1c2632', padding: '2px 6px', fontSize: 11, fontFamily: 'ui-monospace, Consolas, monospace', whiteSpace: 'nowrap' };

  const previewCols = Math.min(table.width, PREVIEW_COLS);
  const previewRows = table.rows.slice(0, PREVIEW_ROWS);

  return (
    <div style={overlay} onClick={onCancel}>
      <div style={card} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>{isAsc ? 'Import Esri ASCII grid' : 'Import CSV'} <span style={{ color: '#8090a0', fontWeight: 400, fontSize: 12 }}>— {fileName}</span></h3>
          <button onClick={onCancel} style={{ background: 'none', border: 'none', color: 'inherit', fontSize: 18, cursor: 'pointer' }} title="Cancel">&times;</button>
        </div>

        {/* Target switch (only when the model has BOTH layers). */}
        {showTargetSwitch && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
            <span style={{ fontSize: 12, color: '#8090a0' }}>Target</span>
            <button style={effTarget === 'agents' ? btnOn : btn} onClick={() => setTarget('agents')}>Agents</button>
            <button style={effTarget === 'grid' ? btnOn : btn} onClick={() => setTarget('grid')}>Grid</button>
            <span style={{ fontSize: 11, color: '#8090a0' }}>
              {autoHeader ? 'header detected → defaulted to Agents' : 'no header → defaulted to Grid'}
            </span>
          </div>
        )}

        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          {/* LEFT — preview table + summary. */}
          <div style={{ flex: '1 1 520px', minWidth: 0 }}>
            <div style={{ fontSize: 11, color: '#8090a0', marginBottom: 4 }}>
              Preview — {previewRows.length} of {table.rows.length} row{table.rows.length === 1 ? '' : 's'}
              {primaryAsc ? (
                <>{' · '}ncols {primaryAsc.ncols} · nrows {primaryAsc.nrows} · cellsize {primaryAsc.cellSize}
                  {primaryAsc.nodataValue !== null && ` · NODATA ${primaryAsc.nodataValue}`}</>
              ) : (
                <>{' · '}{isCharMode ? 'no delimiter (1 char = 1 cell)' : `delimiter ${delimiter === '\t' ? '"tab"' : `"${delimiter}"`}`}
                  {' · '}{table.header ? 'header row' : 'no header'}</>
              )}
              {table.width > PREVIEW_COLS && ` · first ${PREVIEW_COLS} of ${table.width} columns`}
            </div>
            <div style={{ border: '1px solid #2a3a50', background: '#0a0b0e', overflow: 'auto', maxHeight: 300 }}>
              <table style={{ borderCollapse: 'collapse' }}>
                <thead>
                  {effTarget === 'agents' && (
                    <tr>
                      {Array.from({ length: previewCols }, (_, c) => (
                        <th key={c} style={{ ...th, padding: 2 }}>
                          <select
                            value={columnTargets[c] ?? 'ignore'}
                            onChange={e => setColumnTargets(t => { const n = [...t]; while (n.length < previewCols) n.push('ignore'); n[c] = e.target.value; return n; })}
                            style={{ fontSize: 10.5, maxWidth: 120, background: 'var(--color-widget-bg, #1c2028)', color: (columnTargets[c] ?? 'ignore') === 'ignore' ? '#667' : 'var(--color-accent, #e8a13a)', border: '1px solid #2a3a50', borderRadius: 3 }}
                          >
                            {targetOpts.map(o => <option key={o.key} value={o.key} style={{ background: '#1c2028', color: '#cdd6e0' }}>{o.label}</option>)}
                          </select>
                        </th>
                      ))}
                    </tr>
                  )}
                  <tr>
                    {Array.from({ length: previewCols }, (_, c) => (
                      <th key={c} style={th}>{table.header?.[c] ?? `col ${c + 1}`}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {previewRows.map((row, r) => (
                    <tr key={r}>
                      {Array.from({ length: previewCols }, (_, c) => (
                        <td key={c} style={td}>{row[c] ?? <span style={{ color: '#556' }}>—</span>}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Summary — never fail silently. */}
            <div style={{ marginTop: 8, padding: '6px 10px', borderRadius: 4, fontSize: 11.5, border: '1px solid ' + (clean ? '#3a4a2a' : '#5a4a20'), background: clean ? '#161a12' : '#1c1810', color: clean ? '#9ccc65' : '#e0b060' }}>
              {summary}
              {issues.length > 0 && (
                <ul style={{ margin: '4px 0 0', paddingLeft: 16, color: '#c09050' }}>
                  {issues.slice(0, 5).map((it, i) => (
                    <li key={i} style={{ fontSize: 10.5 }}>row {it.row}, {it.column}: &quot;{it.raw}&quot; → default ({it.reason})</li>
                  ))}
                  {issues.length > 5 && <li style={{ fontSize: 10.5 }}>… and {issues.length - 5} more</li>}
                </ul>
              )}
            </div>
          </div>

          {/* RIGHT — options. */}
          <div style={{ flex: '0 0 300px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 11, color: '#8090a0' }}>Options</div>

            {effTarget === 'agents' ? (
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
              </>
            ) : (
              <>
                <label style={{ ...label, gap: 6 }}>
                  Cell attribute
                  <select value={gridAttrId} onChange={e => setGridAttrId(e.target.value)} style={{ fontSize: 12, flex: 1, minWidth: 0 }}>
                    {gridOpts.length === 0 && <option value="">(no cell attributes)</option>}
                    {gridOpts.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
                  </select>
                </label>
                <label style={label}><input type="radio" checked={fit === 'resize'} onChange={() => setFit('resize')} /> Resize the grid to the {isAsc ? 'raster' : 'CSV'}</label>
                <label style={label}>
                  <input type="radio" checked={fit === 'keep'} onChange={() => setFit('keep')} /> Keep the grid ({world.w}×{world.h})
                </label>
                {fit === 'keep' && !dimsMatch && (
                  <div style={{ color: '#e05050', fontSize: 11 }}>
                    The {isAsc ? 'raster' : 'CSV'} is {gridBuild?.width}×{gridBuild?.height} — it must match the grid exactly to keep it.
                  </div>
                )}
                {isAsc && (
                  <label style={label}>
                    <input type="radio" checked={fit === 'resample'} onChange={() => setFit('resample')} /> Resample onto the grid ({world.w}×{world.h})
                  </label>
                )}
                {isAsc && fit === 'resample' && ascAvgPossible && (
                  <label style={{ ...label, gap: 6 }}>
                    Method
                    <select value={ascMethod} onChange={e => setAscMethod(e.target.value as RasterResampleMethod)} style={{ fontSize: 11 }}>
                      <option value="nearest">Nearest</option>
                      <option value="average">Average</option>
                    </select>
                    <span style={{ fontSize: 10, color: '#8090a0' }}>
                      Average box-filters a continuous layer; a Binary / Tag layer always uses nearest.
                    </span>
                  </label>
                )}
                {is3d && (
                  <label style={{ ...label, gap: 6 }}>
                    Layer
                    <input type="number" min={0} max={Math.max(0, world.d - 1)} value={layer}
                      onChange={e => setLayer(Math.max(0, Math.min(world.d - 1, Math.round(Number(e.target.value) || 0))))}
                      style={{ width: 64, fontSize: 12 }} />
                    <span style={{ fontSize: 10.5, color: '#8090a0' }}>of {world.d}</span>
                  </label>
                )}
                <div style={{ fontSize: 10.5, color: '#8090a0', lineHeight: 1.5 }}>
                  A CSV <b>line</b> is a grid <b>row</b> (height); a <b>field</b> is a grid <b>column</b> (width).
                  {is3d && ' A 2D table cannot fill a volume, so it writes ONE layer.'}
                </div>
              </>
            )}

            {/* An Esri ASCII grid defines its own delimiter (whitespace) and has
                no header row, so those two controls are HIDDEN rather than shown
                inert. What it gains instead is the layer stack. */}
            {isAsc ? (
              <>
                <hr style={{ border: 'none', borderTop: '1px solid #2a3a50', margin: '2px 0' }} />
                <div style={{ fontSize: 11, color: '#8090a0' }}>
                  Layers ({ascLayers.length}) — co-registered <code>.asc</code> files, one per cell attribute
                </div>
                {ascExtra.map(l => {
                  const bad = l.asc.ncols !== primaryAsc!.ncols || l.asc.nrows !== primaryAsc!.nrows;
                  return (
                    <div key={l.key} style={{
                      display: 'flex', alignItems: 'center', gap: 5, padding: '3px 5px', borderRadius: 4,
                      border: '1px solid ' + (bad ? '#7a3030' : '#2a3a50'), background: bad ? '#1e1212' : '#12161d',
                    }}>
                      <span title={l.name} style={{ fontSize: 10.5, color: '#8090a0', maxWidth: 90, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.name}</span>
                      <span style={{ fontSize: 9.5, color: bad ? '#e07070' : '#667' }}>{l.asc.ncols}×{l.asc.nrows}</span>
                      <select value={l.attrId} onChange={e => setAscLayerAttr(l.key, e.target.value)} style={{ fontSize: 11, flex: 1, minWidth: 0 }}>
                        {gridOpts.length === 0 && <option value="">(no cell attributes)</option>}
                        {gridOpts.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
                      </select>
                      <button onClick={() => setAscExtra(prev => prev.filter(x => x.key !== l.key))} title="Remove this layer"
                        style={{ background: 'none', border: 'none', color: '#8090a0', cursor: 'pointer', fontSize: 12, padding: 0 }}>&times;</button>
                    </div>
                  );
                })}
                <div>
                  <button style={btn} onClick={() => ascInputRef.current?.click()}>+ Add layer{'…'}</button>
                  <input ref={ascInputRef} type="file" accept=".asc,.txt" multiple style={{ display: 'none' }}
                    onChange={e => { addAscFiles(e.target.files); e.target.value = ''; }} />
                </div>
                {ascMismatched.length > 0 && (
                  <div style={{ color: '#e05050', fontSize: 11 }}>
                    Every layer must be on the SAME grid as {fileName} ({primaryAsc!.ncols}×{primaryAsc!.nrows}) — align them in your GIS first.
                  </div>
                )}
                {ascError && <div style={{ color: '#e05050', fontSize: 11 }}>{ascError}</div>}
                <div style={{ fontSize: 10.5, color: '#8090a0', lineHeight: 1.5 }}>
                  The header&apos;s origin + cell size are stored on the model, so an
                  <b> Export .asc</b> writes the board back georeferenced.
                  {primaryAsc!.nodataValue !== null && ' NODATA cells take the attribute default.'}
                </div>
              </>
            ) : (<>
            <hr style={{ border: 'none', borderTop: '1px solid #2a3a50', margin: '2px 0' }} />
            <label style={{ ...label, gap: 6 }}>
              Delimiter
              <select value={effDelimChoice} onChange={e => setDelimChoice(e.target.value as typeof delimChoice)} style={{ fontSize: 12 }}>
                <option value="auto">auto ({autoDelim === '\t' ? 'tab' : autoDelim})</option>
                <option value=",">comma</option>
                <option value=";">semicolon</option>
                <option value={'\t'}>tab</option>
                <option value="none" disabled={!noneAllowed}>
                  {noneAllowed ? 'no delimiter — 1 char = 1 cell' : 'no delimiter (Grid target only)'}
                </option>
              </select>
            </label>
            <label style={{ ...label, gap: 6, opacity: isCharMode ? 0.45 : 1 }}>
              Header row
              <select value={isCharMode ? 'no' : headerChoice} disabled={isCharMode}
                onChange={e => setHeaderChoice(e.target.value as typeof headerChoice)} style={{ fontSize: 12 }}>
                <option value="auto">auto ({autoHeaderForTarget ? 'yes' : 'no'})</option>
                <option value="yes">first row is a header</option>
                <option value="no">no header</option>
              </select>
            </label>
            {isCharMode && (
              <div style={{ fontSize: 10.5, color: '#8090a0' }}>
                A header cannot exist when every character is a cell.
              </div>
            )}
            </>)}
          </div>
        </div>

        {/* Char → value map (the "no delimiter" core). Full width below the two
            columns, like the image dialog's manual-brush block. */}
        {isCharMode && gridAttr && (
          <div style={{ marginTop: 10, borderTop: '1px solid #2a3a50', paddingTop: 8 }}>
            <div style={{ fontSize: 11.5, color: '#cdd6e0', marginBottom: 2 }}>
              Character → <b>{gridAttr.label}</b> value
              <span style={{ color: '#8090a0' }}> ({chars.length} distinct character{chars.length === 1 ? '' : 's'})</span>
            </div>
            <div style={{ fontSize: 10.5, color: '#8090a0', marginBottom: 6, lineHeight: 1.5 }}>
              Any character can stand for <em>any</em> value — the value is <strong>not</strong> limited
              to what fits in one character, so a letter can carry a multi-digit or negative number
              (e.g. <code>a</code> → <code>10</code>). Digits{gridAttr.attr.type === 'tag' ? ', unambiguous option initials' : ''}
              {gridAttr.attr.type === 'bool' ? ' and the usual CA conventions (. 0 → false, # O X * → true)' : ''} are
              only an auto-seed — edit anything. Unmapped characters (including <b>space</b>) take the
              attribute default and are counted above.
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 190, overflow: 'auto' }}>
              {chars.map(({ char, count }) => {
                const mapped = charMap[char];
                const isMapped = mapped !== undefined && mapped !== '';
                const type = gridAttr.attr.type;
                const tagOpts = gridAttr.attr.tagOptions ?? [];
                return (
                  <div key={char} style={{
                    display: 'flex', alignItems: 'center', gap: 5, padding: '3px 6px', borderRadius: 4,
                    border: '1px solid ' + (isMapped ? 'var(--color-accent, #e8a13a)' : '#2a3a50'),
                    background: isMapped ? 'rgba(232,161,58,0.07)' : '#12161d',
                  }}>
                    <code style={{ fontSize: 12, minWidth: 16, textAlign: 'center', color: '#cdd6e0' }}>{charLabel(char)}</code>
                    <span style={{ fontSize: 9.5, color: '#667', minWidth: 26 }}>×{count}</span>
                    {type === 'bool' ? (
                      <select value={isMapped ? mapped : ''} onChange={e => setCharValue(char, e.target.value)} style={{ fontSize: 11 }}>
                        <option value="">(default)</option>
                        <option value="false">False</option>
                        <option value="true">True</option>
                      </select>
                    ) : type === 'tag' ? (
                      <select value={isMapped ? mapped : ''} onChange={e => setCharValue(char, e.target.value)} style={{ fontSize: 11, maxWidth: 120 }}>
                        <option value="">(default)</option>
                        {tagOpts.map((t, ti) => <option key={ti} value={String(ti)}>{t}</option>)}
                      </select>
                    ) : (
                      <>
                        <InlineNumberInput
                          value={isMapped ? mapped : ''}
                          onChange={v => setCharValue(char, v)}
                          placeholder="default"
                          step="any"
                          style={{ width: 62, fontSize: 11 }}
                        />
                        {isMapped && (
                          <button onClick={() => setCharValue(char, '')} title="Unmap (use the attribute default)"
                            style={{ background: 'none', border: 'none', color: '#8090a0', cursor: 'pointer', fontSize: 11, padding: 0 }}>&times;</button>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
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

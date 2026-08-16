import { useEffect, useMemo, useState } from 'react';
import type { Attribute, GeoReference } from '../model/types';
import { NumberField } from '../modeler/vpl/widgets/InlineWidgets';
import {
  agentExportColumns, buildAgentCsv, buildAscGrid, buildGridCsv, gridTargetOptions,
  ASC_NODATA_DEFAULT,
  type CsvAgentRow, type CsvAttrShape,
} from './csvImport';

/** What the dialog hands back on Export. */
export interface CsvExportResult { text: string; filename: string }

/** How many lines the preview renders (the full text is built only on Export —
 *  a 5000² grid layer is 25M cells and must not be serialised for a preview). */
const PREVIEW_LINES = 10;

/** "Export CSV" — the mirror of the Import CSV dialog.
 *
 *  Two flavours behind the SAME Target switch the import uses:
 *    - Agents: one row per live agent; columns are position / velocity / radius
 *      + every agent attribute, headed so the import's auto-map re-binds them
 *      with no user action.
 *    - Grid:   ONE chosen cell attribute as a delimited table — a line is a grid
 *      ROW, a field a grid COLUMN (the import's documented convention), and no
 *      header row (the Grid import defaults to no-header).
 *
 *  Every value comes from a FRESH `getState` the caller already awaited, so the
 *  dialog is a pure view over decoded numbers: all serialisation lives in the
 *  pure `csvImport.ts` builders the round-trip tests exercise. */
export function CsvExportDialog({
  modelName, generation, cellAttributes, agentAttributes, hasGrid, hasAgents, is3d,
  agents, grid, georef, onExport, onCancel,
}: {
  modelName: string;
  generation: number;
  cellAttributes: Attribute[];
  agentAttributes: Attribute[];
  hasGrid: boolean;
  hasAgents: boolean;
  is3d: boolean;
  /** Live agents, already decoded (null when the model has no agent layer). */
  agents: CsvAgentRow[] | null;
  /** The cell grid, already decoded (null when the model has no grid layer).
   *  `values` returns the row-major block of ONE attribute on ONE layer. */
  grid: { width: number; height: number; depth: number; values: (attrId: string, layer: number) => Float64Array | null } | null;
  /** The model's stored georeference (written by an `.asc` import). Absent ⇒ the
   *  `.asc` export writes the neutral origin 0,0 / cell size 1. */
  georef?: GeoReference;
  onExport: (r: CsvExportResult) => void;
  onCancel: () => void;
}) {
  // --- target layer ---------------------------------------------------------
  // Only offered when the model HAS both layers; otherwise the one it has is
  // forced (never a visible-but-inert switch).
  const [target, setTarget] = useState<'agents' | 'grid'>(hasAgents ? 'agents' : 'grid');
  const showTargetSwitch = hasGrid && hasAgents;
  const effTarget: 'agents' | 'grid' = hasAgents ? (hasGrid ? target : 'agents') : 'grid';

  const [delimiter, setDelimiter] = useState<',' | ';' | '\t'>(',');
  // Grid only: CSV (a delimited table) vs the Esri ASCII grid every GIS reads.
  // `.asc` defines its own delimiter (whitespace), so the Delimiter row is
  // HIDDEN there rather than shown inert.
  const [format, setFormat] = useState<'csv' | 'asc'>('csv');
  const isAsc = effTarget === 'grid' && format === 'asc';

  // --- grid options ---------------------------------------------------------
  const gridOpts = useMemo(() => gridTargetOptions(cellAttributes), [cellAttributes]);
  const [gridAttrId, setGridAttrId] = useState(() => gridOpts[0]?.id ?? '');
  useEffect(() => {
    if (!gridOpts.some(o => o.id === gridAttrId)) setGridAttrId(gridOpts[0]?.id ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridOpts]);
  const [layer, setLayer] = useState(0);
  const gridAttr = gridOpts.find(o => o.id === gridAttrId);
  const depth = grid?.depth ?? 1;

  const agentAttrShapes = agentAttributes as unknown as CsvAttrShape[];
  const agentCols = useMemo(() => agentExportColumns(agentAttrShapes, is3d), [agentAttributes, is3d]);

  // The value block for the current (attribute, layer) choice. Memoised because
  // the preview + the export + the summary all read it.
  const gridValues = useMemo(
    () => (effTarget === 'grid' && grid && gridAttr ? grid.values(gridAttr.id, Math.max(0, Math.min(depth - 1, layer))) : null),
    [effTarget, grid, gridAttr, layer, depth],
  );

  const buildText = (maxRows?: number): string => {
    if (effTarget === 'agents') {
      return buildAgentCsv(agents ?? [], agentAttrShapes, is3d, { delimiter, maxRows });
    }
    if (!grid || !gridAttr || !gridValues) return '';
    if (isAsc) return buildAscGrid(gridValues, grid.width, grid.height, georef, { maxRows });
    return buildGridCsv(gridValues, grid.width, grid.height, gridAttr.attr, { delimiter, maxRows });
  };

  const preview = useMemo(
    () => buildText(PREVIEW_LINES),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [effTarget, delimiter, agents, gridValues, gridAttr, is3d, agentAttributes, isAsc, georef],
  );

  const totalLines = effTarget === 'agents'
    ? (agents?.length ?? 0) + 1
    : (grid?.height ?? 0) + (isAsc ? 6 : 0);
  const summary = effTarget === 'agents'
    ? `${agents?.length ?? 0} agent${(agents?.length ?? 0) === 1 ? '' : 's'} × ${agentCols.length} column${agentCols.length === 1 ? '' : 's'} (header row + one row per live agent)`
    : grid
      ? `${grid.width} wide × ${grid.height} tall${is3d ? ` · layer ${Math.max(0, Math.min(depth - 1, layer))} of ${depth}` : ''} · ${
          isAsc
            ? `Esri header · cell size ${georef?.cellSize ?? 1} · origin (${georef?.xllcorner ?? 0}, ${georef?.yllcorner ?? 0})${georef ? '' : ' — no georeference stored, writing the neutral default'}`
            : 'no header row'}`
      : '';

  const exportDisabled = effTarget === 'agents'
    ? !agents || agents.length === 0
    : !grid || !gridAttr || !gridValues || grid.width < 1 || grid.height < 1;

  const baseName = (modelName || 'genesis').toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '') || 'genesis';
  const ext = isAsc ? 'asc' : delimiter === '\t' ? 'tsv' : 'csv';
  const filename = effTarget === 'agents'
    ? `${baseName}_agents_gen${generation}.${ext}`
    : `${baseName}_${(gridAttr?.label ?? 'grid').toLowerCase().replace(/[^a-z0-9]+/g, '_')}${is3d ? `_layer${Math.max(0, Math.min(depth - 1, layer))}` : ''}_gen${generation}.${ext}`;

  const handleExport = () => {
    if (exportDisabled) return;
    onExport({ text: buildText(), filename });
  };

  // --- styles (mirrors CsvImportDialog) -------------------------------------
  const overlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 9000, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', overflow: 'auto', padding: '4vh 12px' };
  const card: React.CSSProperties = { background: 'var(--color-bg-panel, #14161c)', border: '1px solid var(--color-border, #2a3a50)', borderRadius: 8, padding: 16, width: 'min(860px, 96vw)', maxHeight: '92vh', overflow: 'auto', color: 'var(--color-text, #cdd6e0)', boxShadow: '0 8px 40px rgba(0,0,0,0.6)' };
  const label: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' };
  // Long-hand border props on purpose: the ON state only changes the COLOUR, and
  // React warns (loudly, in the console) when a re-render swaps between the
  // `border` shorthand and a `borderColor` long-hand for the same element.
  const btn: React.CSSProperties = { padding: '2px 10px', fontSize: 12, cursor: 'pointer', background: 'var(--color-widget-bg, #1c2028)', color: 'inherit', borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--color-border, #2a3a50)', borderRadius: 4 };
  const btnOn: React.CSSProperties = { ...btn, background: 'var(--color-accent-soft, #3a2c14)', borderColor: 'var(--color-accent, #e8a13a)', color: 'var(--color-accent, #e8a13a)', fontWeight: 600 };
  // The dark `<option>` workaround — a styled select leaves the native popup
  // unreadable (light text on the OS's white menu) without it.
  const opt: React.CSSProperties = { background: '#1c2028', color: '#cdd6e0' };

  return (
    <div style={overlay} onClick={onCancel}>
      <div style={card} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>{isAsc ? 'Export Esri ASCII grid' : 'Export CSV'} <span style={{ color: '#8090a0', fontWeight: 400, fontSize: 12 }}>— {filename}</span></h3>
          <button onClick={onCancel} style={{ background: 'none', border: 'none', color: 'inherit', fontSize: 18, cursor: 'pointer' }} title="Cancel">&times;</button>
        </div>

        {showTargetSwitch && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
            <span style={{ fontSize: 12, color: '#8090a0' }}>Target</span>
            <button style={effTarget === 'agents' ? btnOn : btn} onClick={() => setTarget('agents')}>Agents</button>
            <button style={effTarget === 'grid' ? btnOn : btn} onClick={() => setTarget('grid')}>Grid</button>
          </div>
        )}

        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          {/* LEFT — preview. */}
          <div style={{ flex: '1 1 460px', minWidth: 0 }}>
            <div style={{ fontSize: 11, color: '#8090a0', marginBottom: 4 }}>
              Preview — first {Math.min(PREVIEW_LINES, totalLines)} of {totalLines} line{totalLines === 1 ? '' : 's'}
            </div>
            <pre style={{
              border: '1px solid #2a3a50', background: '#0a0b0e', margin: 0, padding: 8, maxHeight: 260,
              overflow: 'auto', fontSize: 11, fontFamily: 'ui-monospace, Consolas, monospace', whiteSpace: 'pre',
            }}>{preview || '(nothing to export)'}</pre>
            <div style={{ marginTop: 8, padding: '6px 10px', borderRadius: 4, fontSize: 11.5, border: '1px solid #3a4a2a', background: '#161a12', color: '#9ccc65' }}>
              {summary}
            </div>
          </div>

          {/* RIGHT — options. */}
          <div style={{ flex: '0 0 280px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 11, color: '#8090a0' }}>Options</div>

            {effTarget === 'grid' && (
              <>
                <label style={{ ...label, gap: 6 }}>
                  Format
                  <select value={format} onChange={e => setFormat(e.target.value as typeof format)} style={{ fontSize: 12, flex: 1, minWidth: 0 }}>
                    <option value="csv" style={opt}>CSV table</option>
                    <option value="asc" style={opt}>Esri ASCII grid (.asc)</option>
                  </select>
                </label>
                <label style={{ ...label, gap: 6 }}>
                  Cell attribute
                  <select value={gridAttrId} onChange={e => setGridAttrId(e.target.value)} style={{ fontSize: 12, flex: 1, minWidth: 0 }}>
                    {gridOpts.length === 0 && <option value="" style={opt}>(no cell attributes)</option>}
                    {gridOpts.map(o => <option key={o.id} value={o.id} style={opt}>{o.label}</option>)}
                  </select>
                </label>
                {is3d && (
                  <label style={{ ...label, gap: 6 }}>
                    Layer
                    <NumberField value={layer} min={0} max={Math.max(0, depth - 1)} integer
                      onNumber={n => setLayer(Math.max(0, Math.min(depth - 1, Math.round(n))))}
                      style={{ width: 72, fontSize: 12 }} />
                    <span style={{ fontSize: 10.5, color: '#8090a0' }}>of {depth}</span>
                  </label>
                )}
                <div style={{ fontSize: 10.5, color: '#8090a0', lineHeight: 1.5 }}>
                  A CSV <b>line</b> is a grid <b>row</b> (height); a <b>field</b> is a grid <b>column</b> (width).
                  {is3d && ' A 2D table cannot hold a volume, so ONE layer is written.'}
                </div>
              </>
            )}
            {effTarget === 'agents' && (
              <div style={{ fontSize: 10.5, color: '#8090a0', lineHeight: 1.5 }}>
                Columns: {agentCols.map(c => c.header).join(', ')}
              </div>
            )}

            <hr style={{ border: 'none', borderTop: '1px solid #2a3a50', margin: '2px 0' }} />
            {/* An Esri ASCII grid defines its own delimiter (whitespace), so the
                row is hidden rather than shown inert. */}
            {!isAsc && (
              <label style={{ ...label, gap: 6 }}>
                Delimiter
                <select value={delimiter} onChange={e => setDelimiter(e.target.value as typeof delimiter)} style={{ fontSize: 12 }}>
                  <option value="," style={opt}>comma</option>
                  <option value=";" style={opt}>semicolon</option>
                  <option value={'\t'} style={opt}>tab</option>
                </select>
              </label>
            )}
            <div style={{ fontSize: 10.5, color: '#8090a0', lineHeight: 1.5 }}>
              {isAsc ? (
                <>Six header lines then whitespace-separated rows — the raster every
                  GIS reads. Values are plain NUMBERS (a tag writes its option
                  INDEX, binary 0/1), non-finite ones the NODATA sentinel {ASC_NODATA_DEFAULT}.</>
              ) : (
                <>Values are written so <b>Import CSV</b> reads them straight back: tag
                  values as their option name, binary as true/false, numbers at full
                  precision.</>
              )}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <button onClick={onCancel} style={{ padding: '6px 14px', cursor: 'pointer' }}>Cancel</button>
          <button onClick={handleExport} disabled={exportDisabled}
            style={{ padding: '6px 14px', cursor: exportDisabled ? 'not-allowed' : 'pointer', background: exportDisabled ? '#333' : 'var(--color-accent, #4cc9f0)', color: exportDisabled ? '#888' : '#08121a', border: 'none', borderRadius: 4, fontWeight: 600 }}>
            Export
          </button>
        </div>
      </div>
    </div>
  );
}

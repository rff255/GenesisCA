import { useEffect, useMemo, useState } from 'react';
import type { Attribute } from '../model/types';
import {
  parseCsvTable, detectDelimiter, detectHeader, parseCsvRows,
  autoMapAgentColumns, agentTargetOptions, buildAgentSpecs,
  buildGridValues, gridTargetOptions,
  type CsvAgentSpec, type CsvAttrShape,
} from './csvImport';

/** What the dialog hands back on Import. Exactly one of `agents` / `grid` is set
 *  (the Target switch decides). */
export type CsvImportResult =
  | { target: 'agents'; agents: CsvAgentSpec[]; replace: boolean }
  | { target: 'grid'; attrId: string; width: number; height: number; layer: number; values: Float64Array; resize: boolean };

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
  // --- parse options (auto with an explicit override) -----------------------
  const autoDelim = useMemo(() => detectDelimiter(text), [text]);
  const autoHeader = useMemo(() => detectHeader(parseCsvRows(text, autoDelim)), [text, autoDelim]);
  const [delimChoice, setDelimChoice] = useState<'auto' | ',' | ';' | '\t'>('auto');
  const [headerChoice, setHeaderChoice] = useState<'auto' | 'yes' | 'no'>('auto');
  const delimiter = delimChoice === 'auto' ? autoDelim : delimChoice;

  // --- target layer ---------------------------------------------------------
  // Both layers present → default from the header heuristic: a header names
  // FIELDS (the agent shape); a bare block of values is a BOARD.
  const [target, setTarget] = useState<'agents' | 'grid'>(() => {
    if (!hasAgents) return 'grid';
    if (!hasGrid) return 'agents';
    return autoHeader ? 'agents' : 'grid';
  });
  const showTargetSwitch = hasGrid && hasAgents;
  const effTarget: 'agents' | 'grid' = hasAgents ? (hasGrid ? target : 'agents') : 'grid';

  // The header default is TARGET-DEPENDENT. In Grid mode the CSV *is* the board,
  // so every line is a row: defaulting to "header" there would silently DROP the
  // board's first row (the heuristic fires on an all-text tag grid as soon as any
  // later cell is numeric — e.g. a tag written as its index). Treating a grid as
  // all-data instead fails LOUDLY when the file really does carry column names
  // (every cell of row 1 reports as defaulted in the summary), which is the right
  // trade for a data-import feature. Agents keep the heuristic — there a header is
  // the norm and it names the columns the mapping needs. Overridable either way.
  const autoHeaderForTarget = effTarget === 'grid' ? false : autoHeader;
  const hasHeader = headerChoice === 'auto' ? autoHeaderForTarget : headerChoice === 'yes';

  const table = useMemo(() => parseCsvTable(text, { delimiter, hasHeader }), [text, delimiter, hasHeader]);

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
  const [fit, setFit] = useState<'resize' | 'keep'>('resize');
  const [layer, setLayer] = useState(0);
  const gridAttr = gridOpts.find(o => o.id === gridAttrId);
  const gridBuild = useMemo(
    () => (effTarget === 'grid' && gridAttr ? buildGridValues(table, gridAttr.attr) : null),
    [effTarget, table, gridAttr],
  );
  const dimsMatch = !!gridBuild && gridBuild.width === world.w && gridBuild.height === world.h;

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
    if (g.badValues) parts.push(`${g.badValues} unparseable value${g.badValues === 1 ? '' : 's'} defaulted`);
    if (g.paddedCells) parts.push(`${g.paddedCells} short cell${g.paddedCells === 1 ? '' : 's'} padded with the default`);
    if (fit === 'keep' && !dimsMatch) parts.push(`does NOT match the grid (${world.w}×${world.h})`);
    return parts.join(' · ');
  })();
  const issues = (effTarget === 'agents' ? agentBuild?.issues : gridBuild?.issues) ?? [];
  const clean = issues.length === 0 && (effTarget === 'agents' ? (agentBuild?.skippedRows ?? 0) === 0 : (gridBuild?.paddedCells ?? 0) === 0);

  const applyDisabled = effTarget === 'agents'
    ? !agentBuild || agentBuild.agents.length === 0
    : !gridBuild || !gridAttr || gridBuild.width < 1 || gridBuild.height < 1 || (fit === 'keep' && !dimsMatch);

  const handleApply = () => {
    if (effTarget === 'agents') {
      if (!agentBuild) return;
      onApply({ target: 'agents', agents: agentBuild.agents, replace });
    } else {
      if (!gridBuild || !gridAttr) return;
      onApply({
        target: 'grid', attrId: gridAttr.id, width: gridBuild.width, height: gridBuild.height,
        layer: is3d ? Math.max(0, Math.min(world.d - 1, Math.round(layer))) : 0,
        values: gridBuild.values, resize: fit === 'resize',
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
          <h3 style={{ margin: 0, fontSize: 15 }}>Import CSV <span style={{ color: '#8090a0', fontWeight: 400, fontSize: 12 }}>— {fileName}</span></h3>
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
              {' · '}delimiter {delimiter === '\t' ? '"tab"' : `"${delimiter}"`}
              {' · '}{table.header ? 'header row' : 'no header'}
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
                <label style={label}><input type="radio" checked={fit === 'resize'} onChange={() => setFit('resize')} /> Resize the grid to the CSV</label>
                <label style={label}>
                  <input type="radio" checked={fit === 'keep'} onChange={() => setFit('keep')} /> Keep the grid ({world.w}×{world.h})
                </label>
                {fit === 'keep' && !dimsMatch && (
                  <div style={{ color: '#e05050', fontSize: 11 }}>
                    The CSV is {gridBuild?.width}×{gridBuild?.height} — it must match the grid exactly to keep it.
                  </div>
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

            <hr style={{ border: 'none', borderTop: '1px solid #2a3a50', margin: '2px 0' }} />
            <label style={{ ...label, gap: 6 }}>
              Delimiter
              <select value={delimChoice} onChange={e => setDelimChoice(e.target.value as typeof delimChoice)} style={{ fontSize: 12 }}>
                <option value="auto">auto ({autoDelim === '\t' ? 'tab' : autoDelim})</option>
                <option value=",">comma</option>
                <option value=";">semicolon</option>
                <option value={'\t'}>tab</option>
              </select>
            </label>
            <label style={{ ...label, gap: 6 }}>
              Header row
              <select value={headerChoice} onChange={e => setHeaderChoice(e.target.value as typeof headerChoice)} style={{ fontSize: 12 }}>
                <option value="auto">auto ({autoHeaderForTarget ? 'yes' : 'no'})</option>
                <option value="yes">first row is a header</option>
                <option value="no">no header</option>
              </select>
            </label>
          </div>
        </div>

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

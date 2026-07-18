import { useEffect, useMemo, useState } from 'react';
import type { Attribute } from '../../model/types';
import type { ResolvedLookupAxes } from '../vpl/compiler/variegation';
import { randomFillTableData } from '../vpl/compiler/variegation';
import { NumberField, InlineTagSelect } from '../vpl/widgets/InlineWidgets';
import styles from './PanelContent.module.css';

/** Compact matrix editor for a `lookupTable` model attribute. Used in BOTH the
 *  Attributes panel (design-time editing) and the Simulator's right-side
 *  model-attribute panel (runtime live-tuning).
 *
 *  LEGACY 2-axis storage: `Attribute.tableValues: Record<rowLabel,
 *  Record<colLabel, number>>`. Rows come from the row key source, columns from
 *  the col key source. Rectangular tables (rows ≠ cols) are supported. Missing
 *  entries default to 0. Symmetric mode (`Attribute.symmetric`, default true)
 *  is only meaningful when the row and column label sets are identical.
 *
 *  MULTI-AXIS (N-D) tables (`axesResolved` prop present): dense row-major
 *  `Attribute.tableData` over the axes in declared order. The LAST TWO axes
 *  span the visible 2D grid (deterministic vs. the row-major storage — the
 *  innermost axis is the contiguous one); the outer axes get slice steppers.
 *  Symmetric mode doesn't apply.
 *
 *  Both modes share the RANDOMIZE block — the seeded fill (one shared
 *  implementation, `randomFillTableData`) that makes rule-table CA families
 *  (Accretor) authorable: same seed + density + shape ⇒ the identical table on
 *  any machine. The roll writes the DATA into the model (plus `tableRoll`
 *  metadata seeding these fields), so a saved .gcaproj reproduces exactly.
 */
export function LookupTableEditor({
  attribute,
  rowLabels,
  colLabels,
  onChange,
  compact = false,
  valueTagOptions: resolvedValueTagOptions,
  axesResolved,
}: {
  attribute: Attribute;
  rowLabels: string[];
  colLabels: string[];
  onChange: (changes: Partial<Attribute>) => void;
  /** Smaller cells / inputs for the Simulator right-panel. */
  compact?: boolean;
  /** Resolved tag value labels (manual `valueTagOptions` OR the referenced tag
   *  attribute's options) — the caller resolves via `resolveValueTagOptions`. */
  valueTagOptions?: string[];
  /** MULTI-AXIS mode: the table's resolved axis geometry (the caller resolves
   *  via `resolveAxes`). Absent ⇒ the legacy 2-axis editor. */
  axesResolved?: ResolvedLookupAxes;
}) {
  const multi = !!axesResolved && axesResolved.isMultiAxis;

  // Square iff the two label sets are identical (order included). Legacy only.
  const sameAxes = useMemo(
    () => rowLabels.length === colLabels.length && rowLabels.every((l, i) => l === colLabels[i]),
    [rowLabels, colLabels],
  );
  const symmetric = !multi && sameAxes && attribute.symmetric !== false; // default true, only when square
  const values = attribute.tableValues || {};

  // A `single` axis is a one-element, label-less axis. Its stored key stays the
  // stable sentinel ('value') so renaming the attribute never strands the cell
  // values — but for DISPLAY we show the lookup table's own name as the header
  // (more meaningful than a generic "value").
  const rowSingle = attribute.rowKeySource?.kind === 'single';
  const colSingle = attribute.colKeySource?.kind === 'single';
  const dispRow = (label: string) => (rowSingle ? attribute.name : label);
  const dispCol = (label: string) => (colSingle ? attribute.name : label);

  // ---- MULTI-AXIS slice state -------------------------------------------
  // The last two axes span the grid; the outer N-2 axes are sliced. Slice
  // indices reset when the axis geometry changes (dims signature).
  const dimsSig = axesResolved ? axesResolved.dims.join(',') : '';
  const [outerIdx, setOuterIdx] = useState<number[]>([]);
  useEffect(() => {
    if (!axesResolved) return;
    setOuterIdx(new Array(Math.max(0, axesResolved.axes.length - 2)).fill(0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dimsSig]);

  const nAxes = axesResolved?.axes.length ?? 0;
  const outerCount = Math.max(0, nAxes - 2);
  const gridRowAxis = multi ? (nAxes >= 2 ? axesResolved!.axes[nAxes - 2]! : null) : null;
  const gridColAxis = multi ? axesResolved!.axes[nAxes - 1]! : null;
  const mRowLabels = multi ? (gridRowAxis ? gridRowAxis.labels : ['—']) : rowLabels;
  const mColLabels = multi ? gridColAxis!.labels : colLabels;

  const flatIndex = (ri: number, ci: number): number => {
    const r = axesResolved!;
    let flat = 0;
    for (let k = 0; k < outerCount; k++) flat += Math.min(outerIdx[k] ?? 0, r.dims[k]! - 1) * r.strides[k]!;
    if (nAxes >= 2) flat += ri * r.strides[nAxes - 2]!;
    flat += ci * r.strides[nAxes - 1]!;
    return flat;
  };

  const get = (row: string, col: string, ri: number, ci: number): number => {
    if (multi) {
      const v = attribute.tableData?.[flatIndex(ri, ci)];
      return typeof v === 'number' && Number.isFinite(v) ? v : 0;
    }
    const r = values[row];
    if (r && typeof r[col] === 'number') return r[col]!;
    if (symmetric) {
      const c = values[col];
      if (c && typeof c[row] === 'number') return c[row]!;
    }
    return 0;
  };

  const set = (row: string, col: string, ri: number, ci: number, raw: string) => {
    const n = Number(raw);
    const v = Number.isFinite(n) ? n : 0;
    if (multi) {
      const total = axesResolved!.total;
      const next = new Array<number>(total).fill(0);
      const src = attribute.tableData ?? [];
      for (let i = 0; i < Math.min(total, src.length); i++) {
        const sv = src[i];
        if (typeof sv === 'number' && Number.isFinite(sv)) next[i] = sv;
      }
      next[flatIndex(ri, ci)] = v;
      onChange({ tableData: next });
      return;
    }
    const next = { ...values };
    next[row] = { ...(next[row] || {}), [col]: v };
    if (symmetric && row !== col) {
      next[col] = { ...(next[col] || {}), [row]: v };
    }
    onChange({ tableValues: next });
  };

  const cellSize = compact ? 56 : 72;
  const inputHeight = compact ? 18 : 22;
  // Value type of the table cells (Decimal by default). All supported types
  // (bool/integer/float/tag) store one number, so only the editor widget differs.
  const valueType = attribute.valueType ?? 'float';
  const valueTagOptions = resolvedValueTagOptions ?? attribute.valueTagOptions ?? [];

  // ---- Randomize (seeded fill) ------------------------------------------
  const [rollSeed, setRollSeed] = useState<number>(attribute.tableRoll?.seed ?? 1);
  const [rollDensity, setRollDensity] = useState<number>(attribute.tableRoll?.density ?? 0.2);
  const [rollMaxInt, setRollMaxInt] = useState<number>(attribute.tableRoll?.max ?? 1); // integer tables: values drawn from 1..max
  // Re-seed the Randomize fields from the SAVED roll whenever it changes — a
  // model load, an attribute switch, or an external Apply. Without this the
  // useState initializers only fire at first mount, so a persistent editor
  // instance (notably the Simulator right-panel one, which survives model
  // loads) kept showing the mount-time defaults (Max reset to 1) instead of
  // the attribute's stored values. Keyed on the saved fields, NOT local edits,
  // so typing into a field without Applying is never clobbered (typing doesn't
  // touch attribute.tableRoll; an Apply writes back the just-typed values, so
  // this re-seeds to the same numbers — a harmless no-op).
  const savedSeed = attribute.tableRoll?.seed;
  const savedDensity = attribute.tableRoll?.density;
  const savedMax = attribute.tableRoll?.max;
  useEffect(() => {
    if (savedSeed !== undefined) setRollSeed(savedSeed);
    if (savedDensity !== undefined) setRollDensity(savedDensity);
    if (savedMax !== undefined) setRollMaxInt(savedMax);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attribute.id, savedSeed, savedDensity, savedMax]);
  const totalEntries = multi
    ? axesResolved!.total
    : rowLabels.length * colLabels.length;
  const doRandomize = () => {
    const valueCount = valueType === 'tag'
      ? Math.max(1, valueTagOptions.length - 1)
      : valueType === 'integer' ? Math.max(1, Math.floor(rollMaxInt)) : 1;
    const flat = randomFillTableData(totalEntries, rollSeed, rollDensity, { valueType, valueCount });
    // `max` is only meaningful for integer-valued tables — store it there so the
    // 1..max range round-trips with the attribute (.gcaproj) like seed/density.
    const roll = valueType === 'integer'
      ? { seed: rollSeed, density: rollDensity, max: valueCount }
      : { seed: rollSeed, density: rollDensity };
    if (multi) {
      onChange({ tableData: flat, tableRoll: roll });
      return;
    }
    // Legacy: convert the flat row-major fill into the sparse nested map
    // (zeros omitted — missing keys read as 0 everywhere).
    const cols = colLabels.length;
    const tv: Record<string, Record<string, number>> = {};
    rowLabels.forEach((rl, i) => {
      const row: Record<string, number> = {};
      colLabels.forEach((cl, j) => {
        const v = flat[i * cols + j]!;
        if (v !== 0) row[cl] = v;
      });
      tv[rl] = row;
    });
    onChange({ tableValues: tv, tableRoll: roll });
  };

  // Per-cell value editor, dispatched by the table's value type. The stored
  // value stays a number (bool → 0/1, tag → index) so the compiler/worker path
  // is unchanged.
  const renderCell = (row: string, col: string, ri: number, ci: number) => {
    const v = get(row, col, ri, ci);
    const cellStyle = { width: cellSize - 6, height: inputHeight, padding: '0 4px', fontSize: compact ? '0.62rem' : '0.66rem' } as const;
    if (valueType === 'bool') {
      // A checkbox is more convenient than a true/false dropdown for on/off tables.
      return (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: inputHeight }}>
          <input type="checkbox" checked={v === 1}
            onChange={e => set(row, col, ri, ci, e.target.checked ? '1' : '0')}
            title={v === 1 ? 'true' : 'false'} />
        </div>
      );
    }
    if (valueType === 'tag') {
      return (
        <InlineTagSelect className={styles.selectInput} style={cellStyle}
          options={valueTagOptions} value={String(v)}
          onChange={idx => set(row, col, ri, ci, idx)} />
      );
    }
    return (
      <NumberField className={styles.numberInput} value={v} integer={valueType === 'integer'}
        onNumber={n => set(row, col, ri, ci, String(n))} style={cellStyle} />
    );
  };

  const randomizeBlock = totalEntries > 0 && (
    <div style={{
      display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6,
      margin: '6px 0', padding: '5px 6px', border: '1px solid var(--color-border, #2a3548)',
      borderRadius: 5, fontSize: '0.66rem',
    }}>
      <span style={{ color: '#7a8a9a' }}>Randomize</span>
      <label style={{ color: '#7a8a9a' }}>Seed</label>
      <NumberField className={styles.numberInput} value={rollSeed} integer
        onNumber={n => setRollSeed(Math.floor(n))} style={{ width: 84, height: inputHeight }} noSpinner />
      <button className={styles.addButton} style={{ padding: '1px 6px' }} title="Roll a new random seed"
        onClick={() => setRollSeed(Math.floor(Math.random() * 0x7fffffff) || 1)}>🎲</button>
      <label style={{ color: '#7a8a9a' }}>Density</label>
      <NumberField className={styles.numberInput} value={rollDensity} min={0} max={1} step={0.05}
        onNumber={n => setRollDensity(Math.min(1, Math.max(0, n)))} style={{ width: 56, height: inputHeight }} noSpinner />
      {valueType === 'integer' && (<>
        <label style={{ color: '#7a8a9a' }} title="Non-zero entries are drawn uniformly from 1..max">Max</label>
        <NumberField className={styles.numberInput} value={rollMaxInt} integer min={1}
          onNumber={n => setRollMaxInt(Math.max(1, Math.floor(n)))} style={{ width: 48, height: inputHeight }} noSpinner />
      </>)}
      <button className={styles.addButton} style={{ padding: '1px 8px' }}
        title={`Seeded random fill of all ${totalEntries.toLocaleString()} entries — P(entry ≠ 0) = density; same seed + density ⇒ the identical table (deterministic). Overwrites the current values.`}
        onClick={doRandomize}>Apply</button>
    </div>
  );

  // ---- Empty-axis guards --------------------------------------------------
  if (multi && (nAxes === 0 || mColLabels.length === 0)) {
    return (
      <div style={{ padding: '6px 0', color: '#888', fontSize: '0.68rem' }}>
        Add at least one axis (with a resolvable key source) to populate the table.
      </div>
    );
  }
  if (!multi && (rowLabels.length === 0 || colLabels.length === 0)) {
    return (
      <div style={{ padding: '6px 0', color: '#888', fontSize: '0.68rem' }}>
        Choose a row and column key source (custom labels, a face palette, a tag attribute, an integer range, or a single-value map) to populate the table.
      </div>
    );
  }

  return (
    <div>
      {!multi && sameAxes && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.7rem', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={symmetric}
              onChange={e => onChange({ symmetric: e.target.checked })}
            />
            Symmetric (table[A][B] = table[B][A])
          </label>
        </div>
      )}
      {multi && outerCount > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 6, fontSize: '0.66rem' }}>
          {axesResolved!.axes.slice(0, outerCount).map((ax, k) => {
            const cur = Math.min(outerIdx[k] ?? 0, ax.dim - 1);
            const setK = (v: number) => setOuterIdx(prev => prev.map((x, i) => (i === k ? Math.min(Math.max(v, 0), ax.dim - 1) : x)));
            return (
              <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                <span style={{ color: '#7a8a9a' }}>{ax.name}</span>
                <button className={styles.addButton} style={{ padding: '0 5px' }} disabled={cur <= 0}
                  onClick={() => setK(cur - 1)} title="Previous slice">◂</button>
                <select className={styles.selectInput} style={{ height: inputHeight, fontSize: '0.64rem' }}
                  value={cur} onChange={e => setK(Number(e.target.value))}>
                  {ax.labels.map((l, i) => <option key={i} value={i}>{l}</option>)}
                </select>
                <button className={styles.addButton} style={{ padding: '0 5px' }} disabled={cur >= ax.dim - 1}
                  onClick={() => setK(cur + 1)} title="Next slice">▸</button>
              </div>
            );
          })}
          <span style={{ color: '#556', fontSize: '0.62rem' }}>
            grid: {gridRowAxis ? `${gridRowAxis.name} × ` : ''}{gridColAxis!.name}
          </span>
        </div>
      )}
      {randomizeBlock}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', fontSize: compact ? '0.6rem' : '0.66rem' }}>
          <thead>
            <tr>
              <th style={{ width: cellSize / 2 }} />
              {mColLabels.map(col => (
                <th key={col} style={{ width: cellSize, padding: '2px 0', textAlign: 'center', color: '#6080a0', fontWeight: 600 }}>
                  {multi ? col : dispCol(col)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {mRowLabels.map((row, ri) => (
              <tr key={row}>
                <th style={{ padding: '2px 6px', textAlign: 'right', color: '#6080a0', fontWeight: 600 }}>{multi ? row : dispRow(row)}</th>
                {mColLabels.map((col, ci) => {
                  const isHidden = symmetric && ri > ci;
                  if (isHidden) {
                    return (
                      <td key={col} style={{ background: '#0d1420', textAlign: 'center', color: '#445', padding: 2 }} title={`Mirrored from ${col} × ${row}`}>
                        &middot;
                      </td>
                    );
                  }
                  return (
                    <td key={col} style={{ padding: 1 }}>
                      {renderCell(row, col, ri, ci)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

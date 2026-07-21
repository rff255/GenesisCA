import { useEffect, useMemo, useRef, useState } from 'react';
import type { Attribute } from '../../model/types';
import type { ResolvedLookupAxes } from '../vpl/compiler/variegation';
import { randomFillTableData } from '../vpl/compiler/variegation';
import { MATRIX_GENERATORS, generateMatrix, mutateMatrix } from '../../model/matrixGenerators';
import { NumberField, InlineTagSelect } from '../vpl/widgets/InlineWidgets';
import styles from './PanelContent.module.css';

/** Compact matrix editor for a `lookupTable` model attribute. Used in BOTH the
 *  Attributes panel (design-time editing) and the Simulator's LEFT-panel
 *  Model Attributes section (runtime live-tuning).
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

  // ---- Matrix-play view (float tables) ------------------------------------
  // The Particle Life-style play surface: diverging-color cells (red = repel /
  // cyan = attract over dark neutral, |value| = saturation), horizontal
  // DRAG-on-cell adjust, click select + Ctrl multi-select, a shared slider for
  // the selection (or ALL cells), named generators + quick actions. Float
  // tables default to it; the '# Values' toggle restores the NumberField grid.
  const isFloat = valueType === 'float';
  const [view, setView] = useState<'matrix' | 'values'>(isFloat ? 'matrix' : 'values');
  useEffect(() => { setView(isFloat ? 'matrix' : 'values'); }, [attribute.id, isFloat]);
  const matrixMode = isFloat && view === 'matrix';
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set<string>());
  useEffect(() => { setSelected(new Set<string>()); /* selection is grid-local */ }, [attribute.id, dimsSig]);
  const cellKeyOf = (ri: number, ci: number) => `${ri},${ci}`;
  const dragRef = useRef<{ startX: number; startVals: Map<string, number>; moved: boolean } | null>(null);
  // "All cells" slider position when nothing is selected (their All Types).
  const [allSliderVal, setAllSliderVal] = useState(0);

  // Color scale + slider bounds: the declared roll range when present, else the
  // live data extent (min 1e-6 so an all-zero table still renders).
  const rangeLoDecl = attribute.tableRoll?.rangeMin;
  const rangeHiDecl = attribute.tableRoll?.rangeMax;
  const scaleMax = useMemo(() => {
    let m = 1e-6;
    if (rangeLoDecl !== undefined) m = Math.max(m, Math.abs(rangeLoDecl));
    if (rangeHiDecl !== undefined) m = Math.max(m, Math.abs(rangeHiDecl));
    for (let ri = 0; ri < mRowLabels.length; ri++) {
      for (let ci = 0; ci < mColLabels.length; ci++) {
        const v = Math.abs(get(mRowLabels[ri]!, mColLabels[ci]!, ri, ci));
        if (Number.isFinite(v) && v > m) m = v;
      }
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attribute.tableValues, attribute.tableData, rangeLoDecl, rangeHiDecl, mRowLabels, mColLabels, outerIdx]);
  const sliderLo = rangeLoDecl !== undefined && rangeHiDecl !== undefined ? Math.min(rangeLoDecl, rangeHiDecl) : -scaleMax;
  const sliderHi = rangeLoDecl !== undefined && rangeHiDecl !== undefined ? Math.max(rangeLoDecl, rangeHiDecl) : scaleMax;
  const clampSlider = (v: number) => Math.min(sliderHi, Math.max(sliderLo, v));

  // Their exact diverging scheme (RulesMatrix.vue): dark neutral → cyan
  // (attraction) / red (repulsion), |value|/scale = saturation.
  const divergingColor = (v: number) => {
    const t = Math.min(1, Math.abs(v) / scaleMax);
    const n = [9, 13, 22], c = v > 0 ? [6, 182, 212] : v < 0 ? [214, 40, 57] : n;
    const r = Math.round(n[0]! + (c[0]! - n[0]!) * t);
    const g = Math.round(n[1]! + (c[1]! - n[1]!) * t);
    const b = Math.round(n[2]! + (c[2]! - n[2]!) * t);
    return `rgb(${r}, ${g}, ${b})`;
  };

  /** Batch write — ONE onChange for any number of cells (a drag frame, the
   *  slider, a generator fill). Mirrors `set`'s symmetric write-both rule. */
  const applyEntries = (entries: ReadonlyArray<{ ri: number; ci: number; v: number }>) => {
    if (!entries.length) return;
    if (multi) {
      const totalM = axesResolved!.total;
      const next = new Array<number>(totalM).fill(0);
      const src = attribute.tableData ?? [];
      for (let i = 0; i < Math.min(totalM, src.length); i++) {
        const sv = src[i];
        if (typeof sv === 'number' && Number.isFinite(sv)) next[i] = sv;
      }
      for (const e of entries) next[flatIndex(e.ri, e.ci)] = e.v;
      onChange({ tableData: next });
      return;
    }
    const next: Record<string, Record<string, number>> = {};
    for (const [rk, row] of Object.entries(values)) next[rk] = { ...row };
    for (const e of entries) {
      const row = mRowLabels[e.ri]!, col = mColLabels[e.ci]!;
      (next[row] ??= {})[col] = e.v;
      if (symmetric && row !== col) (next[col] ??= {})[row] = e.v;
    }
    onChange({ tableValues: next });
  };
  const allEntries = (f: (ri: number, ci: number, v: number) => number) => {
    const out: Array<{ ri: number; ci: number; v: number }> = [];
    for (let ri = 0; ri < mRowLabels.length; ri++) {
      for (let ci = 0; ci < mColLabels.length; ci++) {
        out.push({ ri, ci, v: f(ri, ci, get(mRowLabels[ri]!, mColLabels[ci]!, ri, ci)) });
      }
    }
    return out;
  };

  const selectionEntries = (): Array<{ ri: number; ci: number }> =>
    [...selected].map(k => { const [r, c] = k.split(',').map(Number); return { ri: r!, ci: c! }; });

  const onCellPointerDown = (e: React.PointerEvent, ri: number, ci: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    // Drag adjusts the SELECTION when the pressed cell is part of it, else just
    // the pressed cell (matching their RulesMatrix behaviour).
    const inSel = selected.has(cellKeyOf(ri, ci));
    const keys = inSel && selected.size > 0 ? [...selected] : [cellKeyOf(ri, ci)];
    const startVals = new Map<string, number>();
    for (const k of keys) {
      const [r, c] = k.split(',').map(Number);
      startVals.set(k, get(mRowLabels[r!]!, mColLabels[c!]!, r!, c!));
    }
    dragRef.current = { startX: e.clientX, startVals, moved: false };
  };
  const onCellPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    if (!d.moved && Math.abs(dx) < 3) return;
    d.moved = true;
    const step = (sliderHi - sliderLo) / 150; // full range ≈ a 150px drag
    const entries: Array<{ ri: number; ci: number; v: number }> = [];
    for (const [k, v0] of d.startVals) {
      const [r, c] = k.split(',').map(Number);
      entries.push({ ri: r!, ci: c!, v: clampSlider(v0 + dx * step) });
    }
    applyEntries(entries);
  };
  const onCellPointerUp = (e: React.PointerEvent, ri: number, ci: number) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d || d.moved) return;
    // Plain click = single-select (click again to clear); Ctrl+click toggles
    // membership in a multi-selection.
    const k = cellKeyOf(ri, ci);
    setSelected(prev => {
      const next = new Set(prev);
      if (e.ctrlKey || e.metaKey) { if (next.has(k)) next.delete(k); else next.add(k); return next; }
      if (next.has(k) && next.size === 1) return new Set<string>();
      return new Set([k]);
    });
  };

  // ---- Randomize (seeded fill) ------------------------------------------
  const [rollSeed, setRollSeed] = useState<number>(attribute.tableRoll?.seed ?? 1);
  const [rollDensity, setRollDensity] = useState<number>(attribute.tableRoll?.density ?? 0.2);
  const [rollMaxInt, setRollMaxInt] = useState<number>(attribute.tableRoll?.max ?? 1); // integer tables: values drawn from 1..max
  // Float tables: rolled entries drawn uniform in [rangeMin, rangeMax) — the
  // defaults reproduce the historical (0,1) draw. Signed ranges (−1..1) are the
  // Particle Life-style attraction/repulsion matrices.
  const [rollRangeMin, setRollRangeMin] = useState<number>(attribute.tableRoll?.rangeMin ?? 0);
  const [rollRangeMax, setRollRangeMax] = useState<number>(attribute.tableRoll?.rangeMax ?? 1);
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
  const savedRangeMin = attribute.tableRoll?.rangeMin;
  const savedRangeMax = attribute.tableRoll?.rangeMax;
  useEffect(() => {
    if (savedSeed !== undefined) setRollSeed(savedSeed);
    if (savedDensity !== undefined) setRollDensity(savedDensity);
    if (savedMax !== undefined) setRollMaxInt(savedMax);
    if (savedRangeMin !== undefined) setRollRangeMin(savedRangeMin);
    if (savedRangeMax !== undefined) setRollRangeMax(savedRangeMax);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attribute.id, savedSeed, savedDensity, savedMax, savedRangeMin, savedRangeMax]);
  const totalEntries = multi
    ? axesResolved!.total
    : rowLabels.length * colLabels.length;
  const doRandomize = () => {
    const valueCount = valueType === 'tag'
      ? Math.max(1, valueTagOptions.length - 1)
      : valueType === 'integer' ? Math.max(1, Math.floor(rollMaxInt)) : 1;
    const isFloat = valueType === 'float';
    const flat = randomFillTableData(totalEntries, rollSeed, rollDensity, isFloat
      ? { valueType, valueCount, rangeMin: rollRangeMin, rangeMax: rollRangeMax }
      : { valueType, valueCount });
    // `max` is only meaningful for integer-valued tables, `rangeMin`/`rangeMax`
    // for float ones — store the applicable fields so the roll round-trips with
    // the attribute (.gcaproj) like seed/density.
    const roll = valueType === 'integer'
      ? { seed: rollSeed, density: rollDensity, max: valueCount }
      : isFloat
        ? { seed: rollSeed, density: rollDensity, rangeMin: rollRangeMin, rangeMax: rollRangeMax }
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

  // ---- View toggle + generator quick-actions (float tables) ----------------
  const viewToggle = isFloat && (
    <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
      <button className={styles.addButton} style={{ padding: '1px 8px', opacity: matrixMode ? 1 : 0.55 }}
        title="Matrix view: colored cells (red = repel, cyan = attract). Drag a cell horizontally to adjust; click selects; Ctrl+click multi-selects; the slider edits the selection (or all cells)."
        onClick={() => setView('matrix')}>▦ Matrix</button>
      <button className={styles.addButton} style={{ padding: '1px 8px', opacity: matrixMode ? 0.55 : 1 }}
        title="Values view: one number field per cell." onClick={() => setView('values')}># Values</button>
    </div>
  );
  const [genChoice, setGenChoice] = useState('uniform');
  const squareGrid = mRowLabels.length === mColLabels.length && mRowLabels.length > 0;
  const genLo = rangeLoDecl ?? -1, genHi = rangeHiDecl ?? 1;
  const quickActions = matrixMode && squareGrid && !multi && (
    <div style={{
      display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6,
      margin: '6px 0', padding: '5px 6px', border: '1px solid var(--color-border, #2a3548)',
      borderRadius: 5, fontSize: '0.66rem',
    }}>
      <span style={{ color: '#7a8a9a' }}>Fill pattern</span>
      <select className={styles.selectInput} style={{ height: inputHeight, fontSize: '0.64rem', maxWidth: 130 }}
        value={genChoice} onChange={e => setGenChoice(e.target.value)}>
        {MATRIX_GENERATORS.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
      </select>
      <button className={styles.addButton} style={{ padding: '1px 8px' }}
        title="Fill the whole matrix with the chosen pattern (random patterns use the Randomize seed + Min/Max range; deterministic patterns are fixed)."
        onClick={() => {
          const n = mRowLabels.length;
          const flatM = generateMatrix(genChoice, n, rollSeed, genLo, genHi);
          if (flatM) applyEntries(allEntries((ri, ci) => flatM[ri * n + ci]!));
        }}>Fill</button>
      <span style={{ color: '#3a4658' }}>|</span>
      <button className={styles.addButton} style={{ padding: '1px 6px' }} title="Set every cell to 0"
        onClick={() => applyEntries(allEntries(() => 0))}>Zero</button>
      <button className={styles.addButton} style={{ padding: '1px 6px' }} title="table[A][B] ← table[B][A] ← their average"
        onClick={() => applyEntries(allEntries((ri, ci, v) => (v + get(mRowLabels[ci]!, mColLabels[ri]!, ci, ri)) / 2))}>Symmetrize</button>
      <button className={styles.addButton} style={{ padding: '1px 6px' }} title="Swap table[A][B] with table[B][A]"
        onClick={() => applyEntries(allEntries((ri, ci) => get(mRowLabels[ci]!, mColLabels[ri]!, ci, ri)))}>Transpose</button>
      <button className={styles.addButton} style={{ padding: '1px 6px' }} title="Negate every cell (attract ↔ repel)"
        onClick={() => applyEntries(allEntries((_ri, _ci, v) => -v))}>Negate</button>
      <button className={styles.addButton} style={{ padding: '1px 6px' }}
        title="Add ±10%-of-range random noise to every cell (perturb-and-watch exploration)"
        onClick={() => {
          const n = mRowLabels.length;
          const cur: number[] = [];
          for (let ri = 0; ri < n; ri++) for (let ci = 0; ci < mColLabels.length; ci++) cur.push(get(mRowLabels[ri]!, mColLabels[ci]!, ri, ci));
          const amp = (sliderHi - sliderLo) * 0.1;
          const mut = mutateMatrix(cur, Math.floor(Math.random() * 0x7fffffff), amp, sliderLo, sliderHi);
          applyEntries(allEntries((ri, ci) => mut[ri * mColLabels.length + ci]!));
        }}>Mutate</button>
    </div>
  );

  // The selection slider (matrix mode): edits the selected cell(s), or ALL
  // cells when nothing is selected — their "All Types" behaviour.
  const selArr = selectionEntries();
  const sliderValue = selArr.length > 0
    ? get(mRowLabels[selArr[selArr.length - 1]!.ri]!, mColLabels[selArr[selArr.length - 1]!.ci]!, selArr[selArr.length - 1]!.ri, selArr[selArr.length - 1]!.ci)
    : allSliderVal;
  const sliderRow = matrixMode && (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, fontSize: '0.66rem' }}>
      <span style={{ color: '#7a8a9a', minWidth: 64, textAlign: 'right' }}>
        {selArr.length === 0 ? 'All cells' : selArr.length === 1 ? `${dispRow(mRowLabels[selArr[0]!.ri]!)} → ${dispCol(mColLabels[selArr[0]!.ci]!)}` : `${selArr.length} selected`}
      </span>
      <input type="range" min={sliderLo} max={sliderHi} step={(sliderHi - sliderLo) / 200 || 0.01}
        value={sliderValue} style={{ flex: 1, minWidth: 80 }}
        onChange={e => {
          const v = clampSlider(Number(e.target.value));
          if (selArr.length > 0) applyEntries(selArr.map(s => ({ ...s, v })));
          else { setAllSliderVal(v); applyEntries(allEntries(() => v)); }
        }} />
      <NumberField className={styles.numberInput} value={+sliderValue.toFixed(4)} step={0.01}
        onNumber={n => {
          const v = clampSlider(n);
          if (selArr.length > 0) applyEntries(selArr.map(s => ({ ...s, v })));
          else { setAllSliderVal(v); applyEntries(allEntries(() => v)); }
        }} style={{ width: 64, height: inputHeight }} noSpinner />
      {selArr.length > 0 && (
        <button className={styles.addButton} style={{ padding: '1px 6px' }} title="Clear the selection"
          onClick={() => setSelected(new Set<string>())}>✕</button>
      )}
    </div>
  );

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
      {valueType === 'float' && (<>
        <label style={{ color: '#7a8a9a' }} title="Rolled entries are drawn uniformly from [Min, Max). Signed ranges (e.g. −1..1) make attraction/repulsion matrices.">Min</label>
        <NumberField className={styles.numberInput} value={rollRangeMin} step={0.1}
          onNumber={n => setRollRangeMin(n)} style={{ width: 52, height: inputHeight }} noSpinner />
        <label style={{ color: '#7a8a9a' }} title="Rolled entries are drawn uniformly from [Min, Max).">Max</label>
        <NumberField className={styles.numberInput} value={rollRangeMax} step={0.1}
          onNumber={n => setRollRangeMax(n)} style={{ width: 52, height: inputHeight }} noSpinner />
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
      {viewToggle}
      {randomizeBlock}
      {quickActions}
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
                  if (matrixMode) {
                    // Matrix-play cell: diverging color + drag/select. Symmetric
                    // tables show (and edit) the mirrored cells too — the write
                    // goes through the same mirror rule as the Values view.
                    const v = get(row, col, ri, ci);
                    const sel = selected.has(cellKeyOf(ri, ci));
                    const px = compact ? 22 : 30;
                    return (
                      <td key={col} style={{ padding: 1 }}>
                        <div
                          title={`${multi ? row : dispRow(row)} → ${multi ? col : dispCol(col)}: ${v.toFixed(3)}`}
                          onPointerDown={e => onCellPointerDown(e, ri, ci)}
                          onPointerMove={onCellPointerMove}
                          onPointerUp={e => onCellPointerUp(e, ri, ci)}
                          style={{
                            width: px, height: px, background: divergingColor(v),
                            cursor: 'ew-resize', borderRadius: 2, touchAction: 'none',
                            boxShadow: sel ? 'inset 0 0 0 2px #cfd6df' : undefined,
                          }}
                        />
                      </td>
                    );
                  }
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
      {sliderRow}
    </div>
  );
}

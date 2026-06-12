import { useMemo } from 'react';
import type { Attribute } from '../../model/types';
import { NumberField } from '../vpl/widgets/InlineWidgets';
import styles from './PanelContent.module.css';

/** Compact matrix editor for a `lookupTable` model attribute. Used in BOTH the
 *  Attributes panel (design-time editing) and the Simulator's right-side
 *  model-attribute panel (runtime live-tuning).
 *
 *  Storage: `Attribute.tableValues: Record<rowLabel, Record<colLabel, number>>`.
 *  Rows come from the row key source, columns from the col key source — each a
 *  face-label palette (`['none', ...labels]`) or a tag attribute (its
 *  `tagOptions`). Rectangular tables (rows ≠ cols) are supported. Missing
 *  entries default to 0.
 *
 *  Symmetric mode (`Attribute.symmetric`, default true) is only meaningful when
 *  the row and column label sets are identical (square): it hides the lower
 *  triangle and mirrors edits to `table[A][B] = table[B][A]`. For rectangular
 *  tables the toggle is hidden and every cell is independent.
 */
export function LookupTableEditor({
  attribute,
  rowLabels,
  colLabels,
  onChange,
  compact = false,
}: {
  attribute: Attribute;
  rowLabels: string[];
  colLabels: string[];
  onChange: (changes: Partial<Attribute>) => void;
  /** Smaller cells / inputs for the Simulator right-panel. */
  compact?: boolean;
}) {
  // Square iff the two label sets are identical (order included).
  const sameAxes = useMemo(
    () => rowLabels.length === colLabels.length && rowLabels.every((l, i) => l === colLabels[i]),
    [rowLabels, colLabels],
  );
  const symmetric = sameAxes && attribute.symmetric !== false; // default true, only when square
  const values = attribute.tableValues || {};

  // A `single` axis is a one-element, label-less axis. Its stored key stays the
  // stable sentinel ('value') so renaming the attribute never strands the cell
  // values — but for DISPLAY we show the lookup table's own name as the header
  // (more meaningful than a generic "value").
  const rowSingle = attribute.rowKeySource?.kind === 'single';
  const colSingle = attribute.colKeySource?.kind === 'single';
  const dispRow = (label: string) => (rowSingle ? attribute.name : label);
  const dispCol = (label: string) => (colSingle ? attribute.name : label);

  const get = (row: string, col: string): number => {
    const r = values[row];
    if (r && typeof r[col] === 'number') return r[col]!;
    if (symmetric) {
      const c = values[col];
      if (c && typeof c[row] === 'number') return c[row]!;
    }
    return 0;
  };

  const set = (row: string, col: string, raw: string) => {
    const n = Number(raw);
    const v = Number.isFinite(n) ? n : 0;
    const next = { ...values };
    next[row] = { ...(next[row] || {}), [col]: v };
    if (symmetric && row !== col) {
      next[col] = { ...(next[col] || {}), [row]: v };
    }
    onChange({ tableValues: next });
  };

  const cellSize = compact ? 56 : 72;
  const inputHeight = compact ? 18 : 22;

  if (rowLabels.length === 0 || colLabels.length === 0) {
    return (
      <div style={{ padding: '6px 0', color: '#888', fontSize: '0.68rem' }}>
        Choose a row and column key source (a face palette or a tag attribute) to populate the table.
      </div>
    );
  }

  return (
    <div>
      {sameAxes && (
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
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', fontSize: compact ? '0.6rem' : '0.66rem' }}>
          <thead>
            <tr>
              <th style={{ width: cellSize / 2 }} />
              {colLabels.map(col => (
                <th key={col} style={{ width: cellSize, padding: '2px 0', textAlign: 'center', color: '#6080a0', fontWeight: 600 }}>
                  {dispCol(col)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rowLabels.map((row, ri) => (
              <tr key={row}>
                <th style={{ padding: '2px 6px', textAlign: 'right', color: '#6080a0', fontWeight: 600 }}>{dispRow(row)}</th>
                {colLabels.map((col, ci) => {
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
                      <NumberField
                        className={styles.numberInput}
                        value={get(row, col)}
                        onNumber={n => set(row, col, String(n))}
                        style={{ width: cellSize - 6, height: inputHeight, padding: '0 4px', fontSize: compact ? '0.62rem' : '0.66rem' }}
                      />
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

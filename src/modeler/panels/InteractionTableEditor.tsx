import { useMemo } from 'react';
import type { Attribute } from '../../model/types';
import styles from './PanelContent.module.css';

/** Compact matrix editor for an `interactionTable` model attribute. Used in
 *  BOTH the Attributes panel (design-time editing) and the Simulator's
 *  right-side model-attribute panel (runtime live-tuning).
 *
 *  Storage: `Attribute.tableValues: Record<rowLabel, Record<colLabel, number>>`.
 *  Rows / columns are `['none', ...faceLabels]`. Missing entries default to 0.
 *
 *  Symmetric mode (`Attribute.symmetric`, default true) hides the lower
 *  triangle and mirrors edits to `table[A][B] = table[B][A]` so the user
 *  can't get out-of-sync. Storage still holds a full square — the runtime
 *  reads either index unconditionally.
 */
export function InteractionTableEditor({
  attribute,
  faceLabels,
  onChange,
  compact = false,
}: {
  attribute: Attribute;
  faceLabels: string[];
  onChange: (changes: Partial<Attribute>) => void;
  /** Smaller cells / inputs for the Simulator right-panel. */
  compact?: boolean;
}) {
  const labels = useMemo(() => ['none', ...faceLabels], [faceLabels]);
  const symmetric = attribute.symmetric !== false; // default true
  const values = attribute.tableValues || {};

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
    // Immutable deep update: tableValues -> rowMap -> col=v
    const next = { ...values };
    next[row] = { ...(next[row] || {}), [col]: v };
    if (symmetric && row !== col) {
      next[col] = { ...(next[col] || {}), [row]: v };
    }
    onChange({ tableValues: next });
  };

  const cellSize = compact ? 56 : 72;
  const inputHeight = compact ? 18 : 22;

  if (labels.length <= 1) {
    return (
      <div style={{ padding: '6px 0', color: '#888', fontSize: '0.68rem' }}>
        Add face labels in the Variegated Cells panel to populate the table.
      </div>
    );
  }

  return (
    <div>
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
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', fontSize: compact ? '0.6rem' : '0.66rem' }}>
          <thead>
            <tr>
              <th style={{ width: cellSize / 2 }} />
              {labels.map(col => (
                <th key={col} style={{ width: cellSize, padding: '2px 0', textAlign: 'center', color: '#6080a0', fontWeight: 600 }}>
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {labels.map((row, ri) => (
              <tr key={row}>
                <th style={{ padding: '2px 6px', textAlign: 'right', color: '#6080a0', fontWeight: 600 }}>{row}</th>
                {labels.map((col, ci) => {
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
                      <input
                        className={styles.numberInput}
                        type="number"
                        step="any"
                        value={get(row, col)}
                        onChange={e => set(row, col, e.target.value)}
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

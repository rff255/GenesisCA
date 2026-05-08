import type { Attribute, Neighborhood } from '../../model/types';
import { packNI, unpackNI } from '../vpl/compiler/niCodec';
import styles from './PanelContent.module.css';

interface Props {
  attribute: Attribute;
  neighborhoods: Neighborhood[];
  onChange: (cfg: Partial<Attribute>) => void;
}

/** Wave A.6 default-value editor for a NeighborIndex attribute.
 *
 *  Stored value is now packed `(dr, dc)` i32 — the same NI runtime
 *  representation used in the compiled step / outputMapping functions.
 *
 *  Two-piece UI:
 *    1. A dropdown to pick the *hint neighborhood* — a viewport reference for
 *       the editor only. Stored in `attribute.neighborhoodHintId`. When set,
 *       only the slots present in that neighborhood are highlighted; clicking
 *       any cell in the grid (whether or not it's in the hint) sets a packed
 *       (dr, dc) NI as the default value.
 *    2. When no hint is set, falls back to a row of two number inputs (dr +
 *       dc) so the user can still pick any offset. */
export function NeighborIndexDefaultEditor({ attribute, neighborhoods, onChange }: Props) {
  const hintId = attribute.neighborhoodHintId ?? '';
  const hint = neighborhoods.find(n => n.id === hintId) ?? null;
  const currentPacked = parseInt(attribute.defaultValue, 10) || 0;
  const { dr: curDr, dc: curDc } = unpackNI(currentPacked);

  // Compute the grid bounds so it fits the hint's offsets (with a sensible minimum).
  let minDr = -1, maxDr = 1, minDc = -1, maxDc = 1;
  if (hint) {
    for (const [dr, dc] of hint.coords) {
      if (dr < minDr) minDr = dr;
      if (dr > maxDr) maxDr = dr;
      if (dc < minDc) minDc = dc;
      if (dc > maxDc) maxDc = dc;
    }
  }
  // Always include the current value's coordinate in the grid bounds, so the
  // user can see what's currently selected even if it's outside the hint.
  if (curDr < minDr) minDr = curDr;
  if (curDr > maxDr) maxDr = curDr;
  if (curDc < minDc) minDc = curDc;
  if (curDc > maxDc) maxDc = curDc;
  const rows = maxDr - minDr + 1;
  const cols = maxDc - minDc + 1;

  // Map (dr, dc) → in-hint flag, used to colour the grid cells that are
  // members of the hint neighborhood vs. the ones that are merely available
  // as offsets the user can pick.
  const inHint = new Set<string>();
  if (hint) {
    for (const [dr, dc] of hint.coords) inHint.add(`${dr},${dc}`);
  }

  const cellSize = 22;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <select
        className={styles.selectInput}
        value={hintId}
        onChange={e => onChange({ neighborhoodHintId: e.target.value || undefined })}
      >
        <option value="">(no hint neighborhood)</option>
        {neighborhoods.map(n => (
          <option key={n.id} value={n.id}>{n.name}</option>
        ))}
      </select>

      {hint ? (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${cols}, ${cellSize}px)`,
            gridTemplateRows: `repeat(${rows}, ${cellSize}px)`,
            gap: 2,
            justifyContent: 'center',
            padding: 4,
          }}
        >
          {Array.from({ length: rows * cols }, (_, i) => {
            const r = Math.floor(i / cols);
            const c = i % cols;
            const dr = r + minDr;
            const dc = c + minDc;
            const isCenter = dr === 0 && dc === 0;
            const isInNbr = inHint.has(`${dr},${dc}`);
            const isSelected = dr === curDr && dc === curDc;
            const bg = isCenter
              ? '#37474f'
              : isSelected
                ? '#ffb300'
                : isInNbr
                  ? '#1e3a52'
                  : 'transparent';
            const border = isInNbr || isCenter ? '1px solid #4cc9f0' : '1px solid #2a3a4a';
            return (
              <div
                key={i}
                onClick={() => onChange({ defaultValue: String(packNI(dr, dc)) })}
                title={isCenter ? '(self)' : `(${dr}, ${dc})${isInNbr ? '' : ' — not in hint'}`}
                style={{
                  background: bg,
                  border,
                  cursor: 'pointer',
                  fontSize: 9,
                  color: isSelected ? '#1e2a3a' : '#7a8a9a',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontWeight: isSelected ? 600 : 400,
                  userSelect: 'none',
                }}
              >
                {isCenter ? '•' : `${dr},${dc}`}
              </div>
            );
          })}
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: 'var(--color-text-secondary)', minWidth: 18 }}>dr</span>
          <input
            className={styles.numberInput}
            type="number"
            step={1}
            value={curDr}
            onChange={e => {
              const dr = Math.round(Number(e.target.value) || 0);
              onChange({ defaultValue: String(packNI(dr, curDc)) });
            }}
          />
          <span style={{ fontSize: 11, color: 'var(--color-text-secondary)', minWidth: 18 }}>dc</span>
          <input
            className={styles.numberInput}
            type="number"
            step={1}
            value={curDc}
            onChange={e => {
              const dc = Math.round(Number(e.target.value) || 0);
              onChange({ defaultValue: String(packNI(curDr, dc)) });
            }}
          />
        </div>
      )}

      <div style={{ fontSize: 11, color: '#7a8a9a' }}>
        Stored value: packed <code>{currentPacked}</code> = (dr {curDr}, dc {curDc})
      </div>
    </div>
  );
}

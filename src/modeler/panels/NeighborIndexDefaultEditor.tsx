import type { Attribute, Neighborhood } from '../../model/types';
import styles from './PanelContent.module.css';

interface Props {
  attribute: Attribute;
  neighborhoods: Neighborhood[];
  onChange: (cfg: Partial<Attribute>) => void;
}

/** Default-value editor for a NeighborIndex attribute.
 *
 *  Two-piece UI:
 *    1. A dropdown to pick the *hint neighborhood* — a viewport reference for
 *       the editor only. Stored in `attribute.neighborhoodHintId`. Not used at
 *       runtime; the runtime value is just a coord-idx (integer) interpreted
 *       relative to the consuming node's neighborhood.
 *    2. A clickable cell grid showing the hint neighborhood's slots. Clicking
 *       any slot sets `defaultValue` to that slot index. The central cell is
 *       always shown (visualises the cell we are reading FROM); offsets are
 *       laid out around it. When no hint is set, falls back to a plain
 *       number input. */
export function NeighborIndexDefaultEditor({ attribute, neighborhoods, onChange }: Props) {
  const hintId = attribute.neighborhoodHintId ?? '';
  const hint = neighborhoods.find(n => n.id === hintId) ?? null;
  const currentSlot = parseInt(attribute.defaultValue, 10) || 0;

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
  const rows = maxDr - minDr + 1;
  const cols = maxDc - minDc + 1;

  // Map slot index -> (dr, dc) — used to find the slot at a clicked grid cell.
  const slotByOffset = new Map<string, number>();
  if (hint) {
    hint.coords.forEach(([dr, dc], idx) => {
      slotByOffset.set(`${dr},${dc}`, idx);
    });
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
            const slot = slotByOffset.get(`${dr},${dc}`);
            const isInNbr = slot !== undefined;
            const isSelected = isInNbr && slot === currentSlot;
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
                onClick={() => {
                  if (isInNbr) onChange({ defaultValue: String(slot) });
                }}
                title={isCenter ? '(self)' : isInNbr ? `slot ${slot}: (${dr}, ${dc})` : `(${dr}, ${dc}) — not in neighborhood`}
                style={{
                  background: bg,
                  border,
                  cursor: isInNbr ? 'pointer' : 'default',
                  fontSize: 9,
                  color: isSelected ? '#1e2a3a' : '#7a8a9a',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontWeight: isSelected ? 600 : 400,
                  userSelect: 'none',
                }}
              >
                {isCenter ? '•' : isInNbr ? String(slot) : ''}
              </div>
            );
          })}
        </div>
      ) : (
        <input
          className={styles.numberInput}
          type="number"
          step={1}
          min={0}
          value={attribute.defaultValue}
          onChange={e => onChange({ defaultValue: String(Math.max(0, Math.round(Number(e.target.value) || 0))) })}
        />
      )}

      <div style={{ fontSize: 11, color: '#7a8a9a' }}>
        Stored value: slot index <code>{currentSlot}</code>
        {hint && hint.coords[currentSlot] && (
          <> = (dRow {hint.coords[currentSlot]![0]}, dCol {hint.coords[currentSlot]![1]})</>
        )}
      </div>
    </div>
  );
}

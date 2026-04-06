import { useState, useCallback } from 'react';
import styles from './PanelContent.module.css';

interface MockNeighborhood {
  id: string;
  name: string;
  margin: number;
  active: Set<string>;
}

function coordKey(row: number, col: number): string {
  return `${row},${col}`;
}

function createMooreNeighborhood(): MockNeighborhood {
  const active = new Set<string>();
  for (let r = -1; r <= 1; r++) {
    for (let c = -1; c <= 1; c++) {
      if (r !== 0 || c !== 0) active.add(coordKey(r, c));
    }
  }
  return { id: 'moore', name: 'Moore', margin: 2, active };
}

export function NeighborhoodsPanelContent() {
  const [neighborhoods] = useState<MockNeighborhood[]>(() => [createMooreNeighborhood()]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [gridState, setGridState] = useState<Set<string>>(() => new Set(neighborhoods[0]!.active));
  const [margin, setMargin] = useState(2);

  const selected = neighborhoods[selectedIdx];
  const gridSize = 2 * margin + 1;

  const handleCellClick = useCallback((row: number, col: number) => {
    if (row === 0 && col === 0) return; // center cell not toggleable
    const key = coordKey(row, col);
    setGridState(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const activeCount = gridState.size;

  return (
    <>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Neighborhoods</div>
        <div className={styles.list}>
          {neighborhoods.map((n, i) => (
            <div
              key={n.id}
              className={`${styles.listItem} ${selectedIdx === i ? styles.listItemSelected : ''}`}
              onClick={() => setSelectedIdx(i)}
            >
              <span className={styles.listItemName}>{n.name}</span>
              <span className={styles.listItemBadge}>{activeCount} neighbors</span>
            </div>
          ))}
        </div>
        <div className={styles.buttonRow}>
          <button className={styles.addButton}>+ Add Neighborhood</button>
          <button className={styles.deleteButton}>Delete</button>
        </div>
      </div>

      {selected && (
        <div className={styles.detailEditor}>
          <div className={styles.fieldGroup}>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Name</label>
              <input className={styles.textInput} defaultValue={selected.name} />
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Description</label>
              <textarea className={styles.textArea} rows={2} defaultValue="All 8 surrounding cells" />
            </div>
          </div>

          <div className={styles.gridContainer}>
            <div className={styles.gridControls}>
              <label className={styles.fieldLabel}>Margin</label>
              <input
                className={styles.numberInput}
                type="number"
                value={margin}
                min={1}
                max={6}
                onChange={e => setMargin(Math.max(1, Math.min(6, Number(e.target.value))))}
              />
              <span style={{ fontSize: '0.7rem', color: '#6080a0' }}>
                ({gridSize} x {gridSize} grid)
              </span>
            </div>

            <div
              className={styles.grid}
              style={{ gridTemplateColumns: `repeat(${gridSize}, 1fr)` }}
            >
              {Array.from({ length: gridSize }, (_, rowIdx) => {
                const row = rowIdx - margin;
                return Array.from({ length: gridSize }, (_, colIdx) => {
                  const col = colIdx - margin;
                  const isCenter = row === 0 && col === 0;
                  const isActive = gridState.has(coordKey(row, col));

                  let cellClass = styles.gridCell + ' ';
                  if (isCenter) {
                    cellClass += styles.gridCellCenter;
                  } else if (isActive) {
                    cellClass += styles.gridCellActive;
                  } else {
                    cellClass += styles.gridCellEmpty;
                  }

                  return (
                    <button
                      key={coordKey(row, col)}
                      className={cellClass}
                      onClick={() => handleCellClick(row, col)}
                      title={isCenter ? 'Center cell' : `(${row}, ${col})`}
                    />
                  );
                });
              })}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

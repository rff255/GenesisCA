import { useState, useCallback, useMemo } from 'react';
import { useModel } from '../../model/ModelContext';
import styles from './PanelContent.module.css';

function coordKey(row: number, col: number): string {
  return `${row},${col}`;
}

export function NeighborhoodsPanelContent() {
  const { model, addNeighborhood, removeNeighborhood, updateNeighborhood } =
    useModel();
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [margin, setMargin] = useState(2);

  const neighborhoods = model.neighborhoods;
  const selected = neighborhoods[selectedIdx];
  const gridSize = 2 * margin + 1;

  const activeCoords = useMemo(() => {
    if (!selected) return new Set<string>();
    return new Set(selected.coords.map(([r, c]) => coordKey(r, c)));
  }, [selected]);

  const handleCellClick = useCallback(
    (row: number, col: number) => {
      if (!selected) return;
      if (row === 0 && col === 0) return;
      const key = coordKey(row, col);
      let newCoords: Array<[number, number]>;
      if (activeCoords.has(key)) {
        newCoords = selected.coords.filter(
          ([r, c]) => !(r === row && c === col),
        );
      } else {
        newCoords = [...selected.coords, [row, col]];
      }
      updateNeighborhood(selected.id, { coords: newCoords });
    },
    [selected, activeCoords, updateNeighborhood],
  );

  const handleDelete = () => {
    if (selected) {
      removeNeighborhood(selected.id);
      setSelectedIdx(prev => Math.max(0, prev - 1));
    }
  };

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
              <span className={styles.listItemBadge}>
                {n.coords.length} neighbors
              </span>
            </div>
          ))}
        </div>
        <div className={styles.buttonRow}>
          <button className={styles.addButton} onClick={() => addNeighborhood()}>
            + Add Neighborhood
          </button>
          <button className={styles.deleteButton} onClick={handleDelete}>
            Delete
          </button>
        </div>
      </div>

      {selected && (
        <div className={styles.detailEditor}>
          <div className={styles.fieldGroup}>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Name</label>
              <input
                className={styles.textInput}
                value={selected.name}
                onChange={e =>
                  updateNeighborhood(selected.id, { name: e.target.value })
                }
              />
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Description</label>
              <textarea
                className={styles.textArea}
                rows={2}
                value={selected.description}
                onChange={e =>
                  updateNeighborhood(selected.id, {
                    description: e.target.value,
                  })
                }
              />
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
                max={20}
                onChange={e =>
                  setMargin(
                    Math.max(1, Math.min(20, Number(e.target.value))),
                  )
                }
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
                  const isActive = activeCoords.has(coordKey(row, col));

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
                      title={
                        isCenter ? 'Center cell' : `(${row}, ${col})`
                      }
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

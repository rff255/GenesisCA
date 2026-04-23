import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useModel } from '../../model/ModelContext';
import { useListReorder } from './useListReorder';
import styles from './PanelContent.module.css';

function coordKey(row: number, col: number): string {
  return `${row},${col}`;
}

export function NeighborhoodsPanelContent() {
  const { model, addNeighborhood, duplicateNeighborhood, removeNeighborhood, updateNeighborhood, reorderNeighborhoods } =
    useModel();
  const [selectedIdx, setSelectedIdx] = useState(0);

  const neighborhoods = model.neighborhoods;

  // Auto-select newly added neighborhood
  const prevCount = useRef(neighborhoods.length);
  useEffect(() => {
    if (neighborhoods.length > prevCount.current) {
      setSelectedIdx(neighborhoods.length - 1);
      setTimeout(() => {
        document.getElementById(`nbr-${neighborhoods.length - 1}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 50);
    }
    prevCount.current = neighborhoods.length;
  }, [neighborhoods]);
  const selected = neighborhoods[selectedIdx];
  const reorder = useListReorder(neighborhoods, newOrder => {
    // Keep selection on the same neighborhood after reorder
    const selectedId = selected?.id;
    reorderNeighborhoods(newOrder);
    if (selectedId) {
      const newIdx = newOrder.indexOf(selectedId);
      if (newIdx >= 0) setSelectedIdx(newIdx);
    }
  });
  const margin = selected?.margin ?? 2;
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

  const handleDuplicate = () => {
    if (selected) {
      duplicateNeighborhood(selected.id);
      setSelectedIdx(neighborhoods.length); // select the new copy
    }
  };

  return (
    <>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Neighborhoods</div>
        <div className={styles.list} data-reorder-list>
          {neighborhoods.map((n, i) => {
            const isDragging = reorder.dragState?.id === n.id;
            const srcIdx = reorder.dragState ? neighborhoods.findIndex(x => x.id === reorder.dragState!.id) : -1;
            const showBefore = reorder.dragState?.overIdx === i && srcIdx !== i && srcIdx !== i - 1;
            const showAfter = reorder.dragState?.overIdx === neighborhoods.length && i === neighborhoods.length - 1 && srcIdx !== i;
            return (
              <div
                key={n.id}
                id={`nbr-${i}`}
                data-reorder-row
                className={`${styles.listItem} ${selectedIdx === i ? styles.listItemSelected : ''} ${isDragging ? styles.draggingRow : ''} ${showBefore ? styles.dropIndicatorBefore : ''} ${showAfter ? styles.dropIndicatorAfter : ''}`}
                onClick={() => setSelectedIdx(i)}
              >
                <span className={styles.listItemName}>{n.name}</span>
                <span className={styles.listItemBadge}>
                  {n.coords.length} neighbors
                </span>
                <button
                  className={styles.dragHandle}
                  title="Drag to reorder"
                  onPointerDown={reorder.startDrag(n.id)}
                  onClick={e => e.stopPropagation()}
                >⋮⋮</button>
              </div>
            );
          })}
        </div>
        <div className={styles.buttonRow}>
          <button className={styles.addButton} onClick={() => addNeighborhood()}>
            + Add Neighborhood
          </button>
          <button className={styles.addButton} onClick={handleDuplicate} disabled={!selected}>
            Duplicate
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
                max={50}
                onChange={e =>
                  updateNeighborhood(selected.id, {
                    margin: Math.max(1, Math.min(50, Number(e.target.value))),
                  })
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
                  // Find tag for this cell (if any)
                  const coordIdx = selected.coords.findIndex(([r, c]) => r === row && c === col);
                  const tagName = coordIdx >= 0 ? selected.tags?.[coordIdx] : undefined;

                  let cellClass = styles.gridCell + ' ';
                  if (isCenter) {
                    cellClass += styles.gridCellCenter;
                  } else if (isActive) {
                    cellClass += tagName ? styles.gridCellTagged : styles.gridCellActive;
                  } else {
                    cellClass += styles.gridCellEmpty;
                  }

                  return (
                    <button
                      key={coordKey(row, col)}
                      className={cellClass}
                      onClick={() => handleCellClick(row, col)}
                      onContextMenu={e => {
                        e.preventDefault();
                        if (!isActive || isCenter || coordIdx < 0) return;
                        // Right-click on active cell → add a tag for it
                        if (!tagName) {
                          const newTags = { ...(selected.tags || {}) };
                          newTags[coordIdx] = `${row},${col}`;
                          updateNeighborhood(selected.id, { tags: newTags });
                        }
                      }}
                      title={
                        isCenter ? 'Center cell'
                        : tagName ? `[${row},${col}] tag: "${tagName}" (right-click to add tag)`
                        : isActive ? `(${row}, ${col}) — right-click to tag`
                        : `(${row}, ${col})`
                      }
                      style={tagName ? { position: 'relative', overflow: 'hidden' } : undefined}
                    >
                      {tagName && (
                        <span style={{
                          position: 'absolute', inset: 0,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: '0.45rem', fontWeight: 600, color: '#0d1117',
                          lineHeight: 1, textOverflow: 'ellipsis', overflow: 'hidden',
                          pointerEvents: 'none',
                        }}>
                          {tagName}
                        </span>
                      )}
                    </button>
                  );
                });
              })}
            </div>
          </div>

          {/* Cell Tags */}
          <div className={styles.fieldGroup} style={{ marginTop: 8 }}>
            <div className={styles.fieldLabel}>Cell Tags</div>
            <span style={{ color: '#888', fontSize: '0.66rem', lineHeight: 1.3, display: 'block', marginBottom: 4 }}>
              Right-click an active neighbor cell in the grid above to give it a named tag. Tagged cells can be referenced by name in the graph editor.
            </span>
              {Object.entries(selected.tags || {}).map(([idxStr, tagVal]) => {
                const idx = Number(idxStr);
                const coord = selected.coords[idx];
                if (!coord) return null;
                return (
                  <div key={idxStr} style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 2 }}>
                    <span style={{ fontSize: '0.65rem', color: '#6080a0', width: 36, flexShrink: 0 }}>
                      [{coord[0]},{coord[1]}]
                    </span>
                    <input
                      className={styles.textInput}
                      style={{ flex: 1 }}
                      value={tagVal}
                      onChange={e => {
                        const newTags = { ...(selected.tags || {}) };
                        newTags[idx] = e.target.value;
                        updateNeighborhood(selected.id, { tags: newTags });
                      }}
                    />
                    <button
                      className={styles.deleteButton}
                      style={{ padding: '2px 6px', fontSize: '0.7rem' }}
                      onClick={() => {
                        const newTags = { ...(selected.tags || {}) };
                        delete newTags[idx];
                        updateNeighborhood(selected.id, { tags: newTags });
                      }}
                      title="Remove tag"
                    >
                      &times;
                    </button>
                  </div>
                );
              })}
          </div>
        </div>
      )}
    </>
  );
}

import { useCallback, useMemo, useEffect, useRef, useState } from 'react';
import { useModel } from '../../model/ModelContext';
import type { Neighborhood } from '../../model/types';
import { useDetailSelection, type PanelContentProps } from '../ModelerDetailContext';
import { useListReorder } from './useListReorder';
import { MODEL_ELEMENT_DRAG_MIME } from '../vpl/modelElementDrag';
import type { ModelElementDragPayload } from '../vpl/modelElementDrag';
import { setCurrentModelElementDrag } from '../vpl/graphState';
import styles from './PanelContent.module.css';

function handleNeighborhoodDragStart(neighborhoodId: string) {
  return (e: React.DragEvent) => {
    const payload: ModelElementDragPayload = { kind: 'neighborhood', neighborhoodId };
    e.dataTransfer.setData(MODEL_ELEMENT_DRAG_MIME, JSON.stringify(payload));
    e.dataTransfer.effectAllowed = 'copy';
    setCurrentModelElementDrag(payload);
  };
}

function handleNeighborhoodDragEnd() {
  setCurrentModelElementDrag(null);
}

function coordKey(row: number, col: number): string {
  return `${row},${col}`;
}

// ---------------------------------------------------------------------------
// Shape tools (Point / Circle / Ring / Line) — multi-click drawing aids for
// big neighborhoods (MNCA-style radii and rings). Pure helpers below compute
// the affected cell set; `toggleCellsChanges` applies one batch toggle.
// ---------------------------------------------------------------------------

type ShapeTool = 'point' | 'circle' | 'ring' | 'line';

/** Clicks each tool needs before it applies. */
const SHAPE_CLICKS: Record<ShapeTool, number> = { point: 1, circle: 2, ring: 3, line: 2 };

const cellDist = (a: [number, number], b: [number, number]) =>
  Math.hypot(a[0] - b[0], a[1] - b[1]);

/** All grid cells within euclidean distance [rIn, rOut] of `center` (rIn=0 →
 *  a filled disc). Clipped to the visible margin box. */
function annulusCells(
  center: [number, number],
  rIn: number,
  rOut: number,
  margin: number,
): Array<[number, number]> {
  const lo = Math.min(rIn, rOut) - 1e-9;
  const hi = Math.max(rIn, rOut) + 1e-9;
  const out: Array<[number, number]> = [];
  for (let row = -margin; row <= margin; row++) {
    for (let col = -margin; col <= margin; col++) {
      const d = Math.hypot(row - center[0], col - center[1]);
      if (d >= lo && d <= hi) out.push([row, col]);
    }
  }
  return out;
}

/** Integer Bresenham line between two cells, endpoints included. */
function lineCells(a: [number, number], b: [number, number]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let r0 = a[0];
  let c0 = a[1];
  const r1 = b[0];
  const c1 = b[1];
  const dC = Math.abs(c1 - c0);
  const dR = Math.abs(r1 - r0);
  const sC = c0 < c1 ? 1 : -1;
  const sR = r0 < r1 ? 1 : -1;
  let err = dC - dR;
  for (;;) {
    out.push([r0, c0]);
    if (r0 === r1 && c0 === c1) break;
    const e2 = 2 * err;
    if (e2 > -dR) { err -= dR; c0 += sC; }
    if (e2 < dC) { err += dC; r0 += sR; }
  }
  return out;
}

/** Cells a tool would affect given its staged points (last one may be the
 *  hovered cell for live preview). Returns null when not enough points. */
function shapeCells(
  tool: ShapeTool,
  pts: Array<[number, number]>,
  margin: number,
): Array<[number, number]> | null {
  if (tool === 'circle' && pts.length >= 2) {
    return annulusCells(pts[0]!, 0, cellDist(pts[0]!, pts[1]!), margin);
  }
  if (tool === 'line' && pts.length >= 2) {
    return lineCells(pts[0]!, pts[1]!);
  }
  if (tool === 'ring') {
    // With only the inner radius picked so far, preview the circle outline at
    // that distance (a zero-width annulus) so the radius is visible.
    if (pts.length === 2) return annulusCells(pts[0]!, cellDist(pts[0]!, pts[1]!), cellDist(pts[0]!, pts[1]!), margin);
    if (pts.length >= 3) return annulusCells(pts[0]!, cellDist(pts[0]!, pts[1]!), cellDist(pts[0]!, pts[2]!), margin);
  }
  return null;
}

/** Batch-toggle `cells` on a neighborhood: active coords are removed,
 *  inactive ones added, and a covered center cell flips includeCentralCell.
 *  Tag keys are coord-array INDICES, so removals must remap surviving tags —
 *  this helper is the single place that does it (the one-cell Point click
 *  routes through here too). */
function toggleCellsChanges(
  nbh: Neighborhood,
  cells: Array<[number, number]>,
): Partial<Neighborhood> {
  const seen = new Set<string>();
  const removeKeys = new Set<string>();
  const toAdd: Array<[number, number]> = [];
  const activeKeys = new Set(nbh.coords.map(([r, c]) => coordKey(r, c)));
  let centerTouched = false;
  for (const cell of cells) {
    const key = coordKey(cell[0], cell[1]);
    if (seen.has(key)) continue;
    seen.add(key);
    if (cell[0] === 0 && cell[1] === 0) {
      centerTouched = true;
      continue;
    }
    if (activeKeys.has(key)) removeKeys.add(key);
    else toAdd.push(cell);
  }
  const newCoords: Array<[number, number]> = [];
  const newTags: Record<number, string> = {};
  nbh.coords.forEach((coord, oldIdx) => {
    if (removeKeys.has(coordKey(coord[0], coord[1]))) return;
    const tag = nbh.tags?.[oldIdx];
    if (tag !== undefined) newTags[newCoords.length] = tag;
    newCoords.push(coord);
  });
  newCoords.push(...toAdd);
  const changes: Partial<Neighborhood> = { coords: newCoords };
  if (nbh.tags) changes.tags = newTags;
  if (centerTouched) changes.includeCentralCell = !nbh.includeCentralCell;
  return changes;
}

/** Per-tool, per-stage instruction line shown next to the tool buttons. */
function shapeHint(tool: ShapeTool, stagedCount: number): string {
  if (tool === 'point') return 'Click cells to toggle them one by one.';
  const steps: Record<Exclude<ShapeTool, 'point'>, string[]> = {
    circle: ['Click the circle’s center cell.', 'Click a cell at the circle’s edge.'],
    ring: ['Click the ring’s center cell.', 'Click a cell at the inner radius.', 'Click a cell at the outer radius.'],
    line: ['Click the line’s first endpoint.', 'Click the line’s second endpoint.'],
  };
  const msg = steps[tool][Math.min(stagedCount, steps[tool].length - 1)]!;
  return stagedCount > 0 ? `${msg} Right-click cancels.` : msg;
}

export function NeighborhoodsPanelContent({ mode = 'list' }: PanelContentProps = {}) {
  const { model, addNeighborhood, duplicateNeighborhood, removeNeighborhood, updateNeighborhood, reorderNeighborhoods } =
    useModel();
  const [selectedId, setSelectedId] = useDetailSelection('neighborhoods');

  const neighborhoods = model.neighborhoods;

  // Auto-select newly added neighborhood
  const prevCount = useRef(neighborhoods.length);
  useEffect(() => {
    if (neighborhoods.length > prevCount.current) {
      const last = neighborhoods[neighborhoods.length - 1];
      if (last) setSelectedId(last.id);
      setTimeout(() => {
        document.getElementById(`nbr-${neighborhoods.length - 1}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 50);
    }
    prevCount.current = neighborhoods.length;
  }, [neighborhoods]);
  const selected = neighborhoods.find(n => n.id === selectedId);
  // Selection is tracked by id, so it survives a reorder with no extra bookkeeping.
  const reorder = useListReorder(neighborhoods, newOrder => {
    reorderNeighborhoods(newOrder);
  });
  const margin = selected?.margin ?? 2;
  const gridSize = 2 * margin + 1;

  const activeCoords = useMemo(() => {
    if (!selected) return new Set<string>();
    return new Set(selected.coords.map(([r, c]) => coordKey(r, c)));
  }, [selected]);

  // Shape tools: drawing mode + the clicks staged so far + the hovered cell
  // (live preview of the would-be shape). Staging resets on tool or
  // neighborhood switch.
  const [tool, setTool] = useState<ShapeTool>('point');
  const [staged, setStaged] = useState<Array<[number, number]>>([]);
  const [hoverCell, setHoverCell] = useState<[number, number] | null>(null);
  useEffect(() => { setStaged([]); }, [tool, selectedId]);

  const stagedKeys = useMemo(
    () => new Set(staged.map(([r, c]) => coordKey(r, c))),
    [staged],
  );

  // Cells the in-progress shape would affect if the hovered cell were the
  // next click — drawn as a dashed outline so the result is predictable.
  const previewKeys = useMemo(() => {
    if (tool === 'point' || !hoverCell) return new Set<string>();
    const cells = shapeCells(tool, [...staged, hoverCell], margin);
    return new Set((cells ?? []).map(([r, c]) => coordKey(r, c)));
  }, [tool, staged, hoverCell, margin]);

  const handleCellClick = useCallback(
    (row: number, col: number) => {
      if (!selected) return;
      if (tool === 'point') {
        // Single-cell toggle (center cell flips includeCentralCell).
        updateNeighborhood(selected.id, toggleCellsChanges(selected, [[row, col]]));
        return;
      }
      const next: Array<[number, number]> = [...staged, [row, col]];
      if (next.length < SHAPE_CLICKS[tool]) {
        setStaged(next);
        return;
      }
      const cells = shapeCells(tool, next, margin);
      if (cells && cells.length > 0) {
        updateNeighborhood(selected.id, toggleCellsChanges(selected, cells));
      }
      setStaged([]);
    },
    [selected, tool, staged, margin, updateNeighborhood],
  );

  const handleDelete = () => {
    if (selected) {
      removeNeighborhood(selected.id);
      setSelectedId(null);
    }
  };

  const handleDuplicate = () => {
    if (selected) {
      duplicateNeighborhood(selected.id);
      // The auto-select effect selects the new copy when the list grows.
    }
  };

  return (
    <>
      {mode !== 'detail' && (<>
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
                className={`${styles.listItem} ${selectedId === n.id ? styles.listItemSelected : ''} ${isDragging ? styles.draggingRow : ''} ${showBefore ? styles.dropIndicatorBefore : ''} ${showAfter ? styles.dropIndicatorAfter : ''}`}
                onClick={() => setSelectedId(n.id)}
                draggable
                onDragStart={handleNeighborhoodDragStart(n.id)}
                onDragEnd={handleNeighborhoodDragEnd}
                title={`Drag to canvas to add a node that uses '${n.name}'`}
              >
                <span className={styles.listItemName}>{n.name}</span>
                <span className={styles.listItemBadge}>
                  {n.coords.length + (n.includeCentralCell ? 1 : 0)} neighbors
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

      </>)}

      {mode === 'detail' && selected && (
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

            <div className={styles.shapeToolRow} role="group" aria-label="Drawing tool">
              {(['point', 'circle', 'ring', 'line'] as ShapeTool[]).map(t => (
                <button
                  key={t}
                  className={`${styles.shapeToolButton} ${tool === t ? styles.shapeToolButtonActive : ''}`}
                  onClick={() => setTool(t)}
                  title={{
                    point: 'Point — toggle individual cells',
                    circle: 'Circle — click the center, then a cell at the edge, to toggle a filled disc',
                    ring: 'Ring — click the center, a cell at the inner radius, then one at the outer radius',
                    line: 'Line — click two endpoints to toggle every cell along the path',
                  }[t]}
                >
                  {{ point: '·', circle: '●', ring: '◌', line: '╱' }[t]} {t[0]!.toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>
            <div className={styles.shapeToolHint}>{shapeHint(tool, staged.length)}</div>

            <div
              className={styles.grid}
              style={{ gridTemplateColumns: `repeat(${gridSize}, 1fr)` }}
              onMouseLeave={() => setHoverCell(null)}
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
                    cellClass += selected.includeCentralCell
                      ? styles.gridCellCenterIncluded
                      : styles.gridCellCenter;
                  } else if (isActive) {
                    cellClass += tagName ? styles.gridCellTagged : styles.gridCellActive;
                  } else {
                    cellClass += styles.gridCellEmpty;
                  }
                  const key = coordKey(row, col);
                  if (stagedKeys.has(key)) cellClass += ' ' + styles.gridCellStaged;
                  else if (previewKeys.has(key)) cellClass += ' ' + styles.gridCellPreview;

                  return (
                    <button
                      key={key}
                      className={cellClass}
                      onClick={() => handleCellClick(row, col)}
                      onMouseEnter={() => setHoverCell([row, col])}
                      onContextMenu={e => {
                        e.preventDefault();
                        // Right-click cancels an in-progress shape first.
                        if (staged.length > 0) {
                          setStaged([]);
                          return;
                        }
                        if (!isActive || isCenter || coordIdx < 0) return;
                        // Right-click on active cell → add a tag for it
                        if (!tagName) {
                          const newTags = { ...(selected.tags || {}) };
                          newTags[coordIdx] = `${row},${col}`;
                          updateNeighborhood(selected.id, { tags: newTags });
                        }
                      }}
                      title={
                        isCenter
                          ? (selected.includeCentralCell
                              ? 'Center cell — included in neighborhood (click to exclude)'
                              : 'Center cell — click to include in neighborhood')
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

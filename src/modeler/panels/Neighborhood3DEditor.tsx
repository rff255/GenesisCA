// 3D Grid CA — neighbourhood detail editor (parametric + slice-stack).
//
// Rendered by NeighborhoodsPanelContent in the detail panel when the model is
// 3D. Two modes:
//   • Parametric (primary): pick a named shape + radius/metric/axis → generate
//     coords3d via the pure `generateCoords3d`. The industry-norm path.
//   • Slice (hand-tuning): step through Z layers and toggle (dr,dc) cells at the
//     current layer; right-click to tag; the three axis-plane mirrors (H/V/L).
//
// coords3d is the runtime source of truth; `coords` is kept as a same-LENGTH 2D
// projection (stride invariant), and `tags` is remapped on every edit. Editing
// in slice mode clears `shape` (the coords no longer match a parametric spec).

import { useState } from 'react';
import type { Neighborhood, NeighborhoodShapeSpec } from '../../model/types';
import { generateCoords3d, coords2dProjection, describeShape, type Coord3 } from './neighborhood3d';
import { NumberField } from '../vpl/widgets/InlineWidgets';
import styles from './PanelContent.module.css';

const k3 = (dr: number, dc: number, dl: number) => `${dr},${dc},${dl}`;

type ShapeKind = NeighborhoodShapeSpec['kind'];
const SHAPE_KINDS: { value: ShapeKind; label: string }[] = [
  { value: 'moore', label: 'Moore (box, L∞)' },
  { value: 'vonNeumann', label: 'von Neumann (diamond, L1)' },
  { value: 'ball', label: 'Ball (sphere, L2)' },
  { value: 'rangeN', label: 'Range-N (box radius N)' },
  { value: 'shell', label: 'Shell (hollow sphere)' },
  { value: 'ring', label: 'Ring (annulus on a plane)' },
  { value: 'disk', label: 'Disk (filled disc on a plane)' },
];

/** Apply add/remove of 3D cells to a neighbourhood, keeping coords/coords3d/tags
 *  in lockstep. Returns the patch for updateNeighborhood. Clears `shape` (the
 *  result is hand-edited). */
function applySlice3d(
  nbh: Neighborhood,
  cells: Coord3[],
  mode: 'add' | 'remove',
): Partial<Neighborhood> {
  const cur: Coord3[] = (nbh.coords3d ?? []).map(c => [c[0], c[1], c[2]] as Coord3);
  const present = new Map(cur.map((c, i) => [k3(c[0], c[1], c[2]), i]));
  const tags = nbh.tags ?? {};
  if (mode === 'add') {
    const next = cur.slice();
    for (const [dr, dc, dl] of cells) {
      if (dr === 0 && dc === 0 && dl === 0) continue; // central cell is a flag, not a coord
      if (!present.has(k3(dr, dc, dl))) { present.set(k3(dr, dc, dl), next.length); next.push([dr, dc, dl]); }
    }
    return { coords3d: next, coords: coords2dProjection(next), shape: undefined };
  }
  // remove: drop cells, remap surviving tags by old→new index
  const drop = new Set(cells.map(([dr, dc, dl]) => k3(dr, dc, dl)));
  const next: Coord3[] = [];
  const newTags: Record<number, string> = {};
  cur.forEach((c, oldIdx) => {
    if (drop.has(k3(c[0], c[1], c[2]))) return;
    const newIdx = next.length;
    next.push(c);
    if (tags[oldIdx]) newTags[newIdx] = tags[oldIdx]!;
  });
  return { coords3d: next, coords: coords2dProjection(next), tags: newTags, shape: undefined };
}

/** Expand a single (dr,dc,dl) edit over the enabled axis-plane mirrors. */
function expandMirrors(dr: number, dc: number, dl: number, m: { h: boolean; v: boolean; l: boolean }): Coord3[] {
  const set = new Map<string, Coord3>();
  const drs = m.v ? [dr, -dr] : [dr];
  const dcs = m.h ? [dc, -dc] : [dc];
  const dls = m.l ? [dl, -dl] : [dl];
  for (const a of drs) for (const b of dcs) for (const c of dls) set.set(k3(a, b, c), [a, b, c]);
  return [...set.values()];
}

export function Neighborhood3DEditor({
  selected,
  updateNeighborhood,
}: {
  selected: Neighborhood;
  updateNeighborhood: (id: string, changes: Partial<Neighborhood>) => void;
}) {
  const [editorMode, setEditorMode] = useState<'parametric' | 'slice'>(
    selected.shape ? 'parametric' : (selected.coords3d?.length ? 'slice' : 'parametric'),
  );
  const margin = selected.margin ?? 2;
  const gridSize = margin * 2 + 1;

  // Parametric form state, seeded from the stored shape (or a Moore r=1 default).
  const initial: NeighborhoodShapeSpec = selected.shape ?? { kind: 'moore', radius: 1 };
  const [kind, setKind] = useState<ShapeKind>(initial.kind);
  const [radius, setRadius] = useState<number>('radius' in initial ? initial.radius : 1);
  const [metric, setMetric] = useState<'chebyshev' | 'manhattan' | 'euclidean'>(
    'metric' in initial && initial.metric ? initial.metric : 'chebyshev',
  );
  const [axis, setAxis] = useState<'x' | 'y' | 'z'>('axis' in initial ? initial.axis : 'z');
  const [width, setWidth] = useState<number>('width' in initial && initial.width ? initial.width : 1);
  const [rIn, setRIn] = useState<number>(initial.kind === 'shell' ? initial.rIn : 1);
  const [rOut, setROut] = useState<number>(initial.kind === 'shell' ? initial.rOut : 2);

  const buildSpec = (): NeighborhoodShapeSpec => {
    if (kind === 'ring' || kind === 'disk') return { kind, axis, radius, ...(kind === 'ring' ? { width } : {}) };
    if (kind === 'shell') return { kind, rIn, rOut };
    return { kind, radius, ...(kind === 'moore' || kind === 'vonNeumann' || kind === 'ball' ? {} : { metric }) };
  };

  const applyParametric = (spec: NeighborhoodShapeSpec) => {
    const coords3d = generateCoords3d(spec);
    // Parametric regen reindexes everything → clear tags.
    updateNeighborhood(selected.id, { shape: spec, coords3d, coords: coords2dProjection(coords3d), tags: {} });
  };

  // Slice editor state.
  const [sliceLayer, setSliceLayer] = useState(0);
  const [paintMode, setPaintMode] = useState<'mark' | 'unmark'>('mark');
  const [mirrors, setMirrors] = useState({ h: false, v: false, l: false });

  const coords3d = selected.coords3d ?? [];
  const indexOf = (dr: number, dc: number, dl: number) =>
    coords3d.findIndex(c => c[0] === dr && c[1] === dc && c[2] === dl);

  const onCellClick = (dr: number, dc: number, dl: number) => {
    if (dr === 0 && dc === 0 && dl === 0) {
      updateNeighborhood(selected.id, { includeCentralCell: !selected.includeCentralCell });
      return;
    }
    const cells = expandMirrors(dr, dc, dl, mirrors);
    updateNeighborhood(selected.id, applySlice3d(selected, cells, paintMode === 'mark' ? 'add' : 'remove'));
  };

  const layersWithCells = new Set(coords3d.map(c => c[2]));

  return (
    <div className={styles.gridContainer}>
      {/* Editor-mode toggle */}
      <div className={styles.shapeToolRow} role="group" aria-label="3D editor mode">
        <button
          className={`${styles.shapeToolButton} ${editorMode === 'parametric' ? styles.shapeToolButtonActive : ''}`}
          onClick={() => setEditorMode('parametric')}
          title="Parametric — generate a named 3D shape (Moore / von Neumann / Ball / …)"
        >Parametric</button>
        <button
          className={`${styles.shapeToolButton} ${editorMode === 'slice' ? styles.shapeToolButtonActive : ''}`}
          onClick={() => setEditorMode('slice')}
          title="Slice editor — hand-tune (dr,dc) cells one Z-layer at a time; right-click to tag"
        >Slice editor</button>
        <span className={styles.shapeToolDivider} />
        <span style={{ fontSize: '0.7rem', color: '#6080a0' }}>
          {coords3d.length} cell{coords3d.length === 1 ? '' : 's'}
          {selected.shape ? ` · ${describeShape(selected.shape)}` : ' · custom'}
        </span>
      </div>

      {editorMode === 'parametric' && (
        <div className={styles.fieldGroup}>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Shape</label>
            <select className={styles.selectInput} value={kind} onChange={e => setKind(e.target.value as ShapeKind)}>
              {SHAPE_KINDS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </div>

          {(kind === 'moore' || kind === 'vonNeumann' || kind === 'ball' || kind === 'rangeN') && (
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Radius</label>
              <NumberField className={styles.numberInput} value={radius} min={0} max={margin} integer onNumber={setRadius} />
            </div>
          )}
          {kind === 'rangeN' && (
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Metric</label>
              <select className={styles.selectInput} value={metric} onChange={e => setMetric(e.target.value as typeof metric)}>
                <option value="chebyshev">Chebyshev (L∞ — box / Moore)</option>
                <option value="manhattan">Manhattan (L1 — diamond / von Neumann)</option>
                <option value="euclidean">Euclidean (L2 — sphere / ball)</option>
              </select>
            </div>
          )}
          {kind === 'shell' && (
            <div className={styles.field} style={{ display: 'flex', gap: 10 }}>
              <div><label className={styles.fieldLabel}>Inner r</label>
                <NumberField className={styles.numberInput} value={rIn} min={0} max={margin} integer onNumber={setRIn} /></div>
              <div><label className={styles.fieldLabel}>Outer r</label>
                <NumberField className={styles.numberInput} value={rOut} min={0} max={margin} integer onNumber={setROut} /></div>
            </div>
          )}
          {(kind === 'ring' || kind === 'disk') && (
            <>
              <div className={styles.field}>
                <label className={styles.fieldLabel}>Plane (perpendicular axis)</label>
                <select className={styles.selectInput} value={axis} onChange={e => setAxis(e.target.value as 'x' | 'y' | 'z')}>
                  <option value="z">Z (rows × cols)</option>
                  <option value="y">Y (cols × layers)</option>
                  <option value="x">X (rows × layers)</option>
                </select>
              </div>
              <div className={styles.field}>
                <label className={styles.fieldLabel}>Radius</label>
                <NumberField className={styles.numberInput} value={radius} min={0} max={margin} integer onNumber={setRadius} />
              </div>
              {kind === 'ring' && (
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Width</label>
                  <NumberField className={styles.numberInput} value={width} min={1} max={margin} integer onNumber={setWidth} />
                </div>
              )}
            </>
          )}

          <button
            className={styles.shapeToolButton}
            style={{ marginTop: 6 }}
            onClick={() => applyParametric(buildSpec())}
            title="Generate coords3d from the chosen shape (replaces the current cells)"
          >Generate shape</button>
          <div className={styles.shapeToolHint}>
            Generates the relative 3D offsets for the chosen shape. Larger shapes need a bigger Margin.
          </div>
        </div>
      )}

      {editorMode === 'slice' && (
        <>
          <div className={styles.gridControls}>
            <label className={styles.fieldLabel}>Margin</label>
            <NumberField className={styles.numberInput} value={margin} min={1} max={20} integer
              onNumber={n => updateNeighborhood(selected.id, { margin: n })} />
            <span style={{ fontSize: '0.7rem', color: '#6080a0' }}>({gridSize}×{gridSize} per slice)</span>
          </div>

          <div className={styles.gridControls}>
            <label className={styles.fieldLabel}>Z layer (dl)</label>
            <button className={styles.shapeToolButton} disabled={sliceLayer <= -margin} onClick={() => setSliceLayer(l => Math.max(-margin, l - 1))}>−</button>
            <span style={{ minWidth: 28, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>
              {sliceLayer > 0 ? `+${sliceLayer}` : sliceLayer}{layersWithCells.has(sliceLayer) ? ' •' : ''}
            </span>
            <button className={styles.shapeToolButton} disabled={sliceLayer >= margin} onClick={() => setSliceLayer(l => Math.min(margin, l + 1))}>+</button>
          </div>

          <div className={styles.shapeToolRow} role="group" aria-label="Slice paint mode + mirrors">
            {(['mark', 'unmark'] as const).map(m => (
              <button key={m} className={`${styles.shapeToolButton} ${paintMode === m ? styles.shapeToolButtonActive : ''}`}
                onClick={() => setPaintMode(m)}>{m[0]!.toUpperCase() + m.slice(1)}</button>
            ))}
            <span className={styles.shapeToolDivider} />
            <button className={`${styles.shapeToolButton} ${mirrors.h ? styles.shapeToolButtonActive : ''}`}
              onClick={() => setMirrors(s => ({ ...s, h: !s.h }))} title="Mirror left ↔ right (dc → −dc)">↔ H</button>
            <button className={`${styles.shapeToolButton} ${mirrors.v ? styles.shapeToolButtonActive : ''}`}
              onClick={() => setMirrors(s => ({ ...s, v: !s.v }))} title="Mirror top ↔ bottom (dr → −dr)">↕ V</button>
            <button className={`${styles.shapeToolButton} ${mirrors.l ? styles.shapeToolButtonActive : ''}`}
              onClick={() => setMirrors(s => ({ ...s, l: !s.l }))} title="Mirror across layers (dl → −dl)">⇕ L</button>
          </div>
          <div className={styles.shapeToolHint}>
            Editing layer {sliceLayer > 0 ? `+${sliceLayer}` : sliceLayer}. Click a cell to {paintMode}; right-click an active cell to tag it. The centre dot (only on layer 0) toggles the central cell.
          </div>

          <div className={styles.grid} style={{ gridTemplateColumns: `repeat(${gridSize}, 1fr)` }}>
            {Array.from({ length: gridSize }, (_, rowIdx) => {
              const dr = rowIdx - margin;
              return Array.from({ length: gridSize }, (_, colIdx) => {
                const dc = colIdx - margin;
                const dl = sliceLayer;
                const isCenter = dr === 0 && dc === 0 && dl === 0;
                const idx = indexOf(dr, dc, dl);
                const isActive = idx >= 0;
                const tagName = idx >= 0 ? selected.tags?.[idx] : undefined;
                let cls = styles.gridCell + ' ';
                if (isCenter) cls += selected.includeCentralCell ? styles.gridCellCenterIncluded : styles.gridCellCenter;
                else if (isActive) cls += tagName ? styles.gridCellTagged : styles.gridCellActive;
                else cls += styles.gridCellEmpty;
                return (
                  <button
                    key={`${dr},${dc}`}
                    className={cls}
                    onClick={() => onCellClick(dr, dc, dl)}
                    onContextMenu={e => {
                      e.preventDefault();
                      if (!isActive || isCenter || idx < 0) return;
                      if (!tagName) {
                        const newTags = { ...(selected.tags || {}) };
                        newTags[idx] = `${dr},${dc},${dl}`;
                        updateNeighborhood(selected.id, { tags: newTags });
                      }
                    }}
                    title={isCenter
                      ? (selected.includeCentralCell ? 'Centre — included (click to exclude)' : 'Centre — click to include')
                      : tagName ? `[${dr},${dc},${dl}] tag: "${tagName}"`
                      : isActive ? `[${dr},${dc},${dl}] (right-click to tag)` : `[${dr},${dc},${dl}]`}
                  >
                    {tagName ? '🏷' : ''}
                  </button>
                );
              });
            })}
          </div>
        </>
      )}
    </div>
  );
}

// 2D Grid CA — parametric neighbourhood generator.
//
// The 2D counterpart of the 3D editor's Parametric block
// ([Neighborhood3DEditor.tsx](./Neighborhood3DEditor.tsx)), rendered by
// NeighborhoodsPanelContent ABOVE the hand-editing grid in a 2D model: pick a
// named shape + radius (+ metric / width) → materialize `coords` via the pure
// `generateCoords2d`. The grid editor below stays the hand-tuning path, exactly
// as the 3D slice editor does.
//
// Two rules mirrored from 3D:
//   • a regen reindexes everything, so `tags` (keyed by coord INDEX) are cleared;
//   • `includeCentralCell` is a separate flag and is left untouched.
// A hand edit in the grid clears `shape` (applyCellsChanges), so the stored spec
// can never disagree with the coords it claims to describe.

import { useState } from 'react';
import type { Neighborhood, NeighborhoodShapeSpec } from '../../model/types';
import {
  generateCoords2d, maxAbsOffset2d, describeShape2d,
  SHAPE_KINDS_2D, type Shape2DKind,
} from './neighborhood2d';
import { NumberField } from '../vpl/widgets/InlineWidgets';
import styles from './PanelContent.module.css';

/** Upper bound for radius/width, matching the grid editor's Margin max — the
 *  generator auto-grows the margin so every generated cell stays visible. */
const MAX_RADIUS = 50;

export function Neighborhood2DParametric({
  selected,
  updateNeighborhood,
}: {
  selected: Neighborhood;
  updateNeighborhood: (id: string, changes: Partial<Neighborhood>) => void;
}) {
  const stored = selected.shape;
  const initial: NeighborhoodShapeSpec = stored ?? { kind: 'moore', radius: 1 };
  const initialKind: Shape2DKind =
    initial.kind === 'shell' ? 'ring' : initial.kind === 'disk' ? 'ball' : initial.kind;

  const [kind, setKind] = useState<Shape2DKind>(initialKind);
  const [radius, setRadius] = useState<number>('radius' in initial ? initial.radius : 1);
  const [metric, setMetric] = useState<'chebyshev' | 'manhattan' | 'euclidean'>(
    'metric' in initial && initial.metric ? initial.metric : 'chebyshev',
  );
  const [width, setWidth] = useState<number>('width' in initial && initial.width ? initial.width : 1);

  const buildSpec = (): NeighborhoodShapeSpec => {
    if (kind === 'ring') return { kind, axis: 'z', radius, width };
    if (kind === 'rangeN') return { kind, radius, metric };
    return { kind, radius };
  };

  const spec = buildSpec();
  const preview = generateCoords2d(spec);

  const applyParametric = () => {
    const coords = generateCoords2d(spec);
    // Regen reindexes every coord → tags (index-keyed) must go. Grow the margin
    // when the shape reaches past the current grid so nothing is generated
    // invisibly; never shrink it (the user's framing choice).
    const needed = maxAbsOffset2d(coords);
    const margin = selected.margin ?? 2;
    const changes: Partial<Neighborhood> = { shape: spec, coords, tags: {} };
    if (needed > margin) changes.margin = Math.min(MAX_RADIUS, needed);
    updateNeighborhood(selected.id, changes);
  };

  return (
    <div className={styles.fieldGroup} style={{ marginBottom: 8 }}>
      <div className={styles.fieldLabel}>Parametric shape</div>
      <span style={{ color: '#888', fontSize: '0.66rem', lineHeight: 1.3, display: 'block', marginBottom: 4 }}>
        Generate a named neighbourhood in one click. The grid below stays available for
        hand-tuning (editing it clears the stored shape).
      </span>

      <div className={styles.field}>
        <label className={styles.fieldLabel}>Shape</label>
        <select
          className={styles.selectInput}
          value={kind}
          onChange={e => setKind(e.target.value as Shape2DKind)}
        >
          {SHAPE_KINDS_2D.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
      </div>

      <div className={styles.field}>
        <label className={styles.fieldLabel}>Radius</label>
        <NumberField
          className={styles.numberInput}
          value={radius}
          min={0}
          max={MAX_RADIUS}
          integer
          onNumber={setRadius}
        />
      </div>

      {kind === 'rangeN' && (
        <div className={styles.field}>
          <label className={styles.fieldLabel}>Metric</label>
          <select
            className={styles.selectInput}
            value={metric}
            onChange={e => setMetric(e.target.value as typeof metric)}
          >
            <option value="chebyshev">Chebyshev (L&infin; &mdash; box / Moore)</option>
            <option value="manhattan">Manhattan (L1 &mdash; diamond / von Neumann)</option>
            <option value="euclidean">Euclidean (L2 &mdash; disc)</option>
          </select>
        </div>
      )}

      {kind === 'ring' && (
        <div className={styles.field}>
          <label className={styles.fieldLabel}>Width</label>
          <NumberField
            className={styles.numberInput}
            value={width}
            min={1}
            max={MAX_RADIUS}
            integer
            onNumber={setWidth}
          />
        </div>
      )}

      <button
        className={styles.shapeToolButton}
        style={{ marginTop: 6 }}
        onClick={applyParametric}
        title="Generate the relative offsets for the chosen shape (replaces the current cells and clears tags)"
      >
        Generate shape
      </button>
      <div className={styles.shapeToolHint}>
        {preview.length} cell{preview.length === 1 ? '' : 's'} &middot; replaces the current cells and
        clears tags. The centre cell is unaffected (use the grid to toggle it).
        {selected.shape ? ` Current: ${describeShape2d(selected.shape)}.` : ' Current: custom.'}
      </div>
    </div>
  );
}

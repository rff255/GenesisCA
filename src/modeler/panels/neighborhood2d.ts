// 2D Grid CA — parametric neighbourhood materialization.
//
// The 2D sibling of [neighborhood3d.ts](./neighborhood3d.ts), and deliberately
// NOT a second implementation of the shape math: a 2D shape is EXACTLY the
// `dl === 0` slice of the same 3D shape. Every metric reduces to its 2D form at
// dl = 0 (chebyshev max(|dr|,|dc|,0) = max(|dr|,|dc|), manhattan |dr|+|dc|+0,
// euclidean sqrt(dr²+dc²+0)), and the planar ring/disk kinds already live on the
// axis-'z' plane = the rows×cols grid. So `generateCoords2d` filters + projects
// `generateCoords3d`: ONE predicate set, ONE deterministic scan order (the 3D
// layer→row→col scan restricted to layer 0 IS a row→col scan), no drift between
// the two editors, and the disk/ball half-cell rounding (`d <= r + 0.5`) is the
// same convention in both dimensions.
//
// Pure (no React, no I/O) so it can be unit-tested in isolation.

import type { NeighborhoodShapeSpec } from '../../model/types';
import { generateCoords3d } from './neighborhood3d';

export type Coord2 = [number, number];

/** The shape kinds the 2D parametric panel offers. `shell` is omitted (its 2D
 *  slice is an annulus, which `ring` already expresses with the friendlier
 *  radius+width parameterisation); `disk` is omitted because at dl = 0 it is
 *  identical to `ball` (which needs no axis field). */
export type Shape2DKind = 'moore' | 'vonNeumann' | 'ball' | 'rangeN' | 'ring';

export const SHAPE_KINDS_2D: { value: Shape2DKind; label: string }[] = [
  { value: 'moore', label: 'Moore (box, L∞)' },
  { value: 'vonNeumann', label: 'von Neumann (diamond, L1)' },
  { value: 'ball', label: 'Disk (filled disc, L2)' },
  { value: 'rangeN', label: 'Range-N (radius + metric)' },
  { value: 'ring', label: 'Ring (annulus)' },
];

/** Materialize a parametric shape spec into the list of relative 2D offsets
 *  (excluding the origin [0,0] — central-cell inclusion is a separate flag).
 *  The order is a deterministic row→col scan so saves are stable across
 *  re-materialize.
 *
 *  A planar `ring`/`disk` spec is normalized to the axis-'z' plane first: in 2D
 *  the grid IS that plane, so any other axis would slice the shape down to a
 *  degenerate line. */
export function generateCoords2d(spec: NeighborhoodShapeSpec): Coord2[] {
  const flat: NeighborhoodShapeSpec =
    spec.kind === 'ring' || spec.kind === 'disk' ? { ...spec, axis: 'z' } : spec;
  return generateCoords3d(flat)
    .filter(c => c[2] === 0)
    .map(c => [c[0], c[1]] as Coord2);
}

/** Largest absolute offset in a coord list — the margin the grid editor needs
 *  for every generated cell to be visible. 0 for an empty list. */
export function maxAbsOffset2d(coords: ReadonlyArray<Coord2>): number {
  let m = 0;
  for (const [dr, dc] of coords) m = Math.max(m, Math.abs(dr), Math.abs(dc));
  return m;
}

/** Human label for a 2D shape spec (panel summary / save metadata). Omits the
 *  ring's axis, which is always the grid plane in 2D. */
export function describeShape2d(spec: NeighborhoodShapeSpec): string {
  if (spec.kind === 'ring' || spec.kind === 'disk')
    return `${spec.kind} (r=${spec.radius}${spec.kind === 'ring' ? `, w=${spec.width ?? 1}` : ''})`;
  if (spec.kind === 'shell') return `shell (${spec.rIn}-${spec.rOut})`;
  const metric = 'metric' in spec ? spec.metric : undefined;
  return `${spec.kind} (r=${spec.radius}${metric ? `, ${metric}` : ''})`;
}

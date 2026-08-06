// 3D Grid CA — parametric neighbourhood materialization.
//
// Pure (no React, no I/O) so it can be unit-tested in isolation and shared by
// the parametric panel + any cascade. `generateCoords3d(spec)` enumerates the
// `[dr, dc, dl]` offsets for a named 3D shape; `coords2dProjection` derives the
// same-LENGTH 2D fallback the WASM/WebGPU 2D layouts still read (the stride
// invariant: coords.length === coords3d.length).
//
// The parametric shapes mirror the industry norm (Golly / CompuCell3D /
// Morpheus / 3D Larger-than-Life): named shape + radius, with a metric selector
// so one dropdown reproduces Moore (L∞), von Neumann (L1), and sphere (L2).

import type { NeighborhoodShapeSpec } from '../../model/types';

export type Coord3 = [number, number, number];

/** Chebyshev (L∞) distance from the origin. */
function dInf(dr: number, dc: number, dl: number): number {
  return Math.max(Math.abs(dr), Math.abs(dc), Math.abs(dl));
}
/** Manhattan (L1) distance from the origin. */
function dMan(dr: number, dc: number, dl: number): number {
  return Math.abs(dr) + Math.abs(dc) + Math.abs(dl);
}
/** Euclidean (L2) distance from the origin. */
function dEuc(dr: number, dc: number, dl: number): number {
  return Math.sqrt(dr * dr + dc * dc + dl * dl);
}

/** Materialize a parametric shape spec into the list of relative 3D offsets
 *  (excluding the origin [0,0,0] — central-cell inclusion is a separate flag,
 *  applied at the sim boundary by withEffectiveNeighborhoods). The order is a
 *  deterministic layer→row→col scan so saves are stable across re-materialize. */
export function generateCoords3d(spec: NeighborhoodShapeSpec): Coord3[] {
  const out: Coord3[] = [];
  if (spec.kind === 'ring' || spec.kind === 'disk') {
    // A planar shape on the axis-perpendicular plane: ring = annulus at radius
    // (± width/2), disk = filled disc. Lives at dl/dr/dc = 0 on the chosen axis.
    const r = Math.max(0, Math.floor(spec.radius));
    const w = Math.max(1, Math.floor(spec.width ?? 1));
    const half = w / 2;
    // Scan the box that can actually CONTAIN the shape, not just ±radius: a ring
    // reaches out to r + half, so a width ≥ 2 annulus was previously truncated at
    // the ±r box (e.g. r=3 w=2 silently dropped (±4,0) and (0,±4)). A disk keeps
    // ±r — its own `dist <= r + 0.5` predicate can never admit a cell at r + 1.
    const scan = spec.kind === 'ring' ? Math.ceil(r + half) : r;
    for (let a = -scan; a <= scan; a++) {
      for (let b = -scan; b <= scan; b++) {
        const dist = Math.sqrt(a * a + b * b);
        const keep = spec.kind === 'disk' ? dist <= r + 0.5 : Math.abs(dist - r) <= half;
        if (!keep) continue;
        // Map the 2 planar axes to (dr, dc, dl) depending on the perpendicular axis.
        let c: Coord3;
        if (spec.axis === 'z') c = [a, b, 0];        // plane = rows×cols
        else if (spec.axis === 'y') c = [0, a, b];   // plane = cols×layers
        else c = [a, 0, b];                          // axis 'x' → plane = rows×layers
        if (c[0] === 0 && c[1] === 0 && c[2] === 0) continue;
        out.push(c);
      }
    }
    return out;
  }

  if (spec.kind === 'shell') {
    const rIn = Math.max(0, Math.floor(spec.rIn));
    const rOut = Math.max(rIn, Math.floor(spec.rOut));
    for (let dl = -rOut; dl <= rOut; dl++)
      for (let dr = -rOut; dr <= rOut; dr++)
        for (let dc = -rOut; dc <= rOut; dc++) {
          if (dr === 0 && dc === 0 && dl === 0) continue;
          const d = dEuc(dr, dc, dl);
          if (d >= rIn - 0.5 && d <= rOut + 0.5) out.push([dr, dc, dl]);
        }
    return out;
  }

  // moore / vonNeumann / ball / rangeN — radius + metric.
  const radius = Math.max(0, Math.floor(spec.radius));
  // Default metric per named shape: moore=chebyshev, vonNeumann=manhattan,
  // ball=euclidean, rangeN=chebyshev (an N-range box, Larger-than-Life style).
  const explicitMetric = 'metric' in spec ? spec.metric : undefined;
  const metric = explicitMetric
    ?? (spec.kind === 'vonNeumann' ? 'manhattan'
      : spec.kind === 'ball' ? 'euclidean'
      : 'chebyshev');
  const within = (dr: number, dc: number, dl: number): boolean => {
    if (metric === 'manhattan') return dMan(dr, dc, dl) <= radius;
    if (metric === 'euclidean') return dEuc(dr, dc, dl) <= radius + 0.5;
    return dInf(dr, dc, dl) <= radius; // chebyshev
  };
  for (let dl = -radius; dl <= radius; dl++)
    for (let dr = -radius; dr <= radius; dr++)
      for (let dc = -radius; dc <= radius; dc++) {
        if (dr === 0 && dc === 0 && dl === 0) continue;
        if (within(dr, dc, dl)) out.push([dr, dc, dl]);
      }
  return out;
}

/** Same-length 2D projection of a 3D coord list (drops the layer axis). Used to
 *  keep `Neighborhood.coords` populated as the WASM/WebGPU 2D-layout fallback —
 *  the stride invariant requires coords.length === coords3d.length. */
export function coords2dProjection(coords3d: Coord3[]): Array<[number, number]> {
  return coords3d.map(([dr, dc]) => [dr, dc] as [number, number]);
}

/** Human label for a shape spec (for the panel summary / save metadata). */
export function describeShape(spec: NeighborhoodShapeSpec): string {
  if (spec.kind === 'ring' || spec.kind === 'disk')
    return `${spec.kind} (axis ${spec.axis}, r=${spec.radius}${spec.kind === 'ring' ? `, w=${spec.width ?? 1}` : ''})`;
  if (spec.kind === 'shell') return `shell (${spec.rIn}-${spec.rOut})`;
  const metric = 'metric' in spec ? spec.metric : undefined;
  return `${spec.kind} (r=${spec.radius}${metric ? `, ${metric}` : ''})`;
}

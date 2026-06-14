/** Ctrl-drag alignment snapping (PowerPoint-style guide lines).
 *
 *  Pure, target-independent geometry: given the union bounding box of the
 *  node(s) being dragged and the boxes of the static (non-moving) nodes,
 *  find the closest edge/center alignment within a flow-unit threshold and
 *  return the snap delta plus the guide lines to draw. Kept separate from
 *  GraphEditor so it's unit-testable in isolation and re-usable.
 *
 *  Each node contributes three candidate lines per axis: left / centerX /
 *  right (vertical guides) and top / centerY / bottom (horizontal guides).
 *  The moving box snaps so its closest line coincides with a static node's
 *  line; X and Y are resolved independently (a node can snap on one axis only).
 */

/** Active alignment guides, in FLOW coordinates. `vx` = a vertical guide line
 *  at x, spanning [y0,y1]; `hy` = a horizontal guide at y, spanning [x0,x1]. */
export type AlignGuides = {
  vx?: { x: number; y0: number; y1: number };
  hy?: { y: number; x0: number; x1: number };
};

export interface AlignBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface AlignTarget {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** How far past the matched extent the guide line is drawn (flow units). */
const GUIDE_PAD = 6;

/** Compute the alignment snap delta + guide lines for a drag.
 *  @param moving  union bbox of the moving node(s) at their PROPOSED positions
 *  @param targets boxes of the non-moving nodes to align against
 *  @param thresholdFlow snap distance in flow units (caller converts screen px → flow via zoom)
 */
export function computeAlignmentSnap(
  moving: AlignBox,
  targets: readonly AlignTarget[],
  thresholdFlow: number,
): { dx: number; dy: number; guides: AlignGuides | null } {
  const vLines = [moving.minX, (moving.minX + moving.maxX) / 2, moving.maxX]; // left / centerX / right
  const hLines = [moving.minY, (moving.minY + moving.maxY) / 2, moving.maxY]; // top / centerY / bottom
  // best.{delta} moves the moving box so its matched line coincides with the
  // target line `guide`; {a,b} is the matched target's perpendicular extent
  // (for drawing the guide span).
  let bX: { delta: number; guide: number; a: number; b: number; dist: number } | null = null;
  let bY: { delta: number; guide: number; a: number; b: number; dist: number } | null = null;
  for (const t of targets) {
    const x0 = t.x, x1 = t.x + t.w, y0 = t.y, y1 = t.y + t.h;
    const tV = [x0, (x0 + x1) / 2, x1];
    const tH = [y0, (y0 + y1) / 2, y1];
    for (const vl of vLines) {
      for (const tv of tV) {
        const d = Math.abs(vl - tv);
        if (d <= thresholdFlow && (!bX || d < bX.dist)) bX = { delta: tv - vl, guide: tv, a: y0, b: y1, dist: d };
      }
    }
    for (const hl of hLines) {
      for (const th of tH) {
        const d = Math.abs(hl - th);
        if (d <= thresholdFlow && (!bY || d < bY.dist)) bY = { delta: th - hl, guide: th, a: x0, b: x1, dist: d };
      }
    }
  }
  const dx = bX ? bX.delta : 0;
  const dy = bY ? bY.delta : 0;
  const sMinX = moving.minX + dx, sMaxX = moving.maxX + dx;
  const sMinY = moving.minY + dy, sMaxY = moving.maxY + dy;
  const guides: AlignGuides = {
    vx: bX ? { x: bX.guide, y0: Math.min(sMinY, bX.a) - GUIDE_PAD, y1: Math.max(sMaxY, bX.b) + GUIDE_PAD } : undefined,
    hy: bY ? { y: bY.guide, x0: Math.min(sMinX, bY.a) - GUIDE_PAD, x1: Math.max(sMaxX, bY.b) + GUIDE_PAD } : undefined,
  };
  return { dx, dy, guides: guides.vx || guides.hy ? guides : null };
}

/** Structural equality (with sub-pixel tolerance) — lets the per-tick caller
 *  skip redundant React state updates while the snap target is unchanged. */
export function sameGuides(a: AlignGuides | null, b: AlignGuides | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const eqV = (p?: AlignGuides['vx'], q?: AlignGuides['vx']) =>
    (!p && !q) || (!!p && !!q && Math.abs(p.x - q.x) < 0.5 && Math.abs(p.y0 - q.y0) < 0.5 && Math.abs(p.y1 - q.y1) < 0.5);
  const eqH = (p?: AlignGuides['hy'], q?: AlignGuides['hy']) =>
    (!p && !q) || (!!p && !!q && Math.abs(p.y - q.y) < 0.5 && Math.abs(p.x0 - q.x0) < 0.5 && Math.abs(p.x1 - q.x1) < 0.5);
  return eqV(a.vx, b.vx) && eqH(a.hy, b.hy);
}

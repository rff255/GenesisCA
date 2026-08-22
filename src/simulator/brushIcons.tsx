/**
 * BRUSH ICONS — ONE glyph vocabulary, TWO consumers.
 *
 * Every brush glyph is defined EXACTLY ONCE, as SVG path `d` data on a 24x24
 * viewBox, and is rendered two ways:
 *   • the PANEL buttons — inline `<svg stroke="currentColor">` (the app's
 *     existing icon vocabulary: 24x24 viewBox, strokeWidth 2, round caps and
 *     joins, `fill="none"`, so the active / inactive / per-theme colours apply
 *     for free — see `modeIcon` in App.tsx and the ActivityBar icons);
 *   • the CURSOR overlay — `new Path2D(d)` stroked onto the `cursorHl` canvas
 *     next to the brush footprint (see `drawCursorLayer` in SimulatorView).
 *
 * Defining the path data once is what stops the button and the cursor drifting
 * into two different pictures of the same brush. A new brush mode adds ONE
 * entry here and both surfaces pick it up.
 *
 * The set is deliberately STROKE-ONLY (no fills): a stroked glyph reads at
 * 13-16 px, scales without hinting, and lets the canvas draw with a single
 * `ctx.stroke(path)` per sub-path.
 */
import type { CSSProperties } from 'react';

/** Every glyph this module can draw. The agent-brush ids match `AGENT_BRUSH_MODES`
 *  exactly, so a mode can index straight into the table; the `shape-*` ids are the
 *  brush FOOTPRINT shapes shared by the cell brush and the agent brush. */
export type BrushIconName =
  | 'add' | 'remove' | 'move' | 'edit' | 'paint' | 'push' | 'pull' | 'glue' | 'cut'
  | 'shape-rect' | 'shape-circle' | 'shape-ring' | 'shape-line';

/** A circle as path data — `<circle>` has no `d`, and Path2D needs one. */
function circle(cx: number, cy: number, r: number): string {
  return `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${r * 2} 0a${r} ${r} 0 1 0 ${-r * 2} 0`;
}

/** The glyphs. One entry per icon; each is a list of sub-paths so a glyph can be
 *  several strokes without needing a group element. */
export const BRUSH_ICON_PATHS: Record<BrushIconName, readonly string[]> = {
  // Add — a plus. Its counterpart Remove is a single horizontal stroke, so the
  // two differ by a whole stroke (a very distinct silhouette at 13 px), not by
  // a rotation the way + and x would.
  add: ['M12 5v14', 'M5 12h14'],
  remove: ['M5 12h14'],
  // Move — the classic four-way arrows: a CONTINUOUS cross through the centre,
  // which is what tells it apart from Push / Pull (both of which leave the
  // centre empty).
  move: [
    'M12 3v18', 'M3 12h18',
    'M9.5 5.5 12 3l2.5 2.5', 'M9.5 18.5 12 21l2.5-2.5',
    'M5.5 9.5 3 12l2.5 2.5', 'M18.5 9.5 21 12l-2.5 2.5',
  ],
  // Edit — a pencil.
  edit: ['M4 20l1-4 11-11 3 3-11 11-4 1z', 'M13 8l3 3'],
  // Paint (a user-defined Agent Input Mapping brush) — a paint droplet.
  paint: ['M12 3.5s6 6.5 6 10a6 6 0 0 1-12 0c0-3.5 6-10 6-10z'],
  // Push / Pull — four DIAGONAL arrows leaving / entering the centre (the
  // expand / collapse pair). Diagonals on purpose: an axis-aligned four-arrow
  // figure is Move's cross with a gap in it, which at 14 px is not a difference
  // anyone can see. Pull is the same figure with every arrow reversed, so the
  // two read as one mechanism in two directions.
  push: [
    'M14.5 9.5 19 5M19 5h-4M19 5v4',
    'M9.5 9.5 5 5M5 5h4M5 5v4',
    'M14.5 14.5 19 19M19 19h-4M19 19v-4',
    'M9.5 14.5 5 19M5 19h4M5 19v-4',
  ],
  pull: [
    'M19 5l-4.5 4.5M14.5 9.5h4M14.5 9.5v-4',
    'M5 5l4.5 4.5M9.5 9.5h-4M9.5 9.5v-4',
    'M19 19l-4.5-4.5M14.5 14.5h4M14.5 14.5v4',
    'M5 19l4.5-4.5M9.5 14.5h-4M9.5 14.5v4',
  ],
  // Glue — two agents joined by a bond.
  glue: [circle(6.5, 12, 3), circle(17.5, 12, 3), 'M9.5 12h5'],
  // Cut — scissors.
  cut: [
    circle(6, 6.5, 2.6), circle(6, 17.5, 2.6),
    'M20 4 8.2 15.6', 'M14.5 14.4 20 20', 'M8.2 8.4 12 12',
  ],
  // Footprint shapes.
  'shape-rect': ['M5 6.5h14v11H5z'],
  'shape-circle': [circle(12, 12, 7)],
  // Ring = two concentric circles (an annulus), unmistakable next to the single
  // circle of the filled-disc brush.
  'shape-ring': [circle(12, 12, 8), circle(12, 12, 3.5)],
  // Line = the segment plus its two click points ("click 2 points").
  'shape-line': ['M6.5 17.5 17.5 6.5', circle(6.5, 17.5, 1.4), circle(17.5, 6.5, 1.4)],
};

/** Cursor-overlay glyph colour per icon. These mirror the colours the area /
 *  hover highlights already use for the same modes (remove red, edit purple,
 *  push orange, pull cyan, paint amber), so the icon reinforces the highlight
 *  rather than introducing a second colour language. Every one is a light hue
 *  on the dark backing chip, so contrast never depends on the palette behind. */
const BRUSH_ICON_COLOR: Record<BrushIconName, string> = {
  add: '#7fd8f5',
  remove: '#f88585',
  move: '#7fd8f5',
  edit: '#c3a4ff',
  paint: '#f0bd70',
  push: '#ffbe7a',
  pull: '#7ad8e6',
  glue: '#f0bd70',
  cut: '#f88585',
  'shape-rect': '#e8e9f0',
  'shape-circle': '#e8e9f0',
  'shape-ring': '#e8e9f0',
  'shape-line': '#e8e9f0',
};

/** Lazily-built Path2D cache. Built on FIRST DRAW rather than at module load so
 *  importing this module never touches a browser global (Path2D), and so the
 *  per-frame cursor redraw only ever looks the glyph up. */
let pathCache: Map<BrushIconName, Path2D[]> | null = null;
function iconPath2Ds(name: BrushIconName): Path2D[] {
  if (!pathCache) pathCache = new Map();
  let paths = pathCache.get(name);
  if (!paths) {
    paths = BRUSH_ICON_PATHS[name].map(d => new Path2D(d));
    pathCache.set(name, paths);
  }
  return paths;
}

/** Rounded rect via arcTo — `ctx.roundRect` is recent enough that a fallback is
 *  cheaper than a feature test. */
function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Padding between the glyph box and the edge of its backing chip. */
export const BRUSH_ICON_CHIP_PAD = 3;

/**
 * Draw a brush icon on a CURSOR OVERLAY context, with `(x, y)` the top-left of
 * the glyph box and `size` its edge length in CSS px.
 *
 * Drawn on the COLOURED (`cursorHl`) layer, never the difference-composited
 * silhouette layer: a recognizable glyph needs stable contrast, which the
 * negative-cursor trick cannot give (it inverts whatever is behind it). The dark
 * rounded chip behind the glyph is what makes it read on any palette — over a
 * bright cell, a dark void, or an agent body alike.
 */
export function drawBrushIcon(
  ctx: CanvasRenderingContext2D,
  name: BrushIconName,
  x: number,
  y: number,
  size = 16,
): void {
  const paths = iconPath2Ds(name);
  const pad = BRUSH_ICON_CHIP_PAD;
  ctx.save();
  roundRectPath(ctx, x - pad, y - pad, size + pad * 2, size + pad * 2, 4);
  ctx.fillStyle = 'rgba(10, 11, 14, 0.74)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.20)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.translate(x, y);
  ctx.scale(size / 24, size / 24);
  ctx.strokeStyle = BRUSH_ICON_COLOR[name];
  // In 24-unit path space; at the default 16 px box this lands on ~1.6 screen px,
  // matching the 1.5 px the brush silhouettes are stroked with.
  ctx.lineWidth = 2.4;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const p of paths) ctx.stroke(p);
  ctx.restore();
}

/** The panel-button form of the same glyph. `currentColor` + the shared
 *  24x24 / strokeWidth-2 / round-cap vocabulary, so the button's own
 *  active / hover / theme colours drive it with no per-icon styling. */
export function BrushIcon({ name, size = 13, style }: {
  name: BrushIconName;
  size?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      style={{ display: 'block', flex: '0 0 auto', ...style }}
    >
      {BRUSH_ICON_PATHS[name].map((d, i) => <path key={i} d={d} />)}
    </svg>
  );
}

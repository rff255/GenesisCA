/**
 * GeoJSON vector import — the VECTOR sibling of the `.asc` / GeoTIFF raster
 * importers (Tier 4 of docs/INVESTIGATION_GEOSPATIAL_IO.md, the NetLogo/GAMA
 * parity piece).
 *
 * Two consumers, exactly as the investigation frames them:
 *   - RASTERISE onto a cell attribute: polygons (lakes, exclusion zones,
 *     districts) fill by point-in-polygon over CELL CENTRES, lines (rivers,
 *     roads) walk a supercover with a width, points mark their own cell.
 *   - POINTS → AGENTS: each point feature becomes one agent at the projected
 *     position, its `properties` auto-mapped to agent attributes BY NAME through
 *     the CSV importer's own column logic.
 *
 * NO NEW DEPENDENCY — GeoJSON is JSON, and every geometry primitive below is
 * plain arithmetic. NO REPROJECTION, by the same doctrine the `.asc` and GeoTIFF
 * paths state: the file's coordinates must already be in the model's CRS
 * (align upstream, in QGIS).
 *
 * DOM-free + side-effect-free on purpose: `scripts/test-geojson-import.mjs`
 * imports it directly and asserts VALUES — the cell a polygon covers must be
 * exactly the cell the transform says, or be reported.
 */

import type { GeoReference } from '../model/types';
import { encodeAttrValue } from '../model/attrValueEncoding';
import {
  decodeCsvValue, parseTargetKey, autoMapAgentColumns, agentTargetOptions,
  type CsvAttrShape, type CsvIssue, type CsvAgentSpec,
} from './csvImport';
import { decodeNumericValue } from './geotiffImport';
import { vectorComponentIds, vectorDimsOf } from '../modeler/vpl/compiler/vectorAttr';

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

/** Widest line stamp offered, in CELLS. */
export const GEOJSON_MAX_LINE_WIDTH = 64;
/** Cells per `paintManual` message. A whole-grid burn is millions of cells and
 *  the message carries `{row, col}` OBJECTS, so it goes out in batches rather
 *  than materialising them all at once. */
export const GEOJSON_PAINT_CHUNK = 20_000;
/** GeometryCollection nesting depth before we stop descending (a malformed or
 *  hostile file must not recurse forever). */
export const GEOJSON_MAX_DEPTH = 8;
/** Issues listed before the dialog switches to "… and N more". */
const MAX_ISSUES = 12;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export type GeoJsonGeomKind = 'point' | 'line' | 'polygon';

/** One usable geometry, flattened: every Multi* is already split into singles
 *  and a GeometryCollection is already descended. Coordinates are WORLD units
 *  (whatever the file's CRS is — we never reproject); the 3rd array element
 *  (altitude) is deliberately ignored: it is a HEIGHT, not a grid layer. */
export type GeoJsonShape =
  | { kind: 'point'; xy: readonly [number, number] }
  | { kind: 'line'; path: Array<readonly [number, number]> }
  /** Ring 0 is the outer boundary, the rest are HOLES (even-odd fill subtracts
   *  them automatically — see `polygonCells`). */
  | { kind: 'polygon'; rings: Array<Array<readonly [number, number]>> };

export interface GeoJsonItem {
  shape: GeoJsonShape;
  /** The owning Feature's `properties` (a bare geometry gets `{}`). A Multi*
   *  geometry's parts SHARE the feature's properties, which is what makes a
   *  multipart district behave as one district. */
  properties: Record<string, unknown>;
  /** 1-based index of the FEATURE this came from (for issue reporting). */
  feature: number;
}

export interface GeoJsonParse {
  items: GeoJsonItem[];
  counts: { point: number; line: number; polygon: number };
  /** World-coordinate extent of everything usable, or null when there is none. */
  bbox: { minX: number; minY: number; maxX: number; maxY: number } | null;
  /** Union of the property keys, in first-seen order. */
  propertyKeys: string[];
  /** Geometries that carried no usable coordinates (a null geometry, an empty
   *  ring, a 1-point LineString, a non-numeric coordinate…). */
  skipped: number;
  /** A legacy top-level `crs` member's name, when present. GeoJSON (RFC 7946)
   *  dropped the member and mandates WGS 84, but files in the wild still carry
   *  it — informational only, never acted on. */
  crs: string | null;
}

const GEOJSON_TYPES = new Set([
  'FeatureCollection', 'Feature', 'GeometryCollection',
  'Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon',
]);

/** Cheap structural sniff — used to tell a `.json` GeoJSON from a `.gcaproj`
 *  without re-parsing. */
export function isGeoJsonObject(o: unknown): boolean {
  if (!o || typeof o !== 'object') return false;
  const t = (o as { type?: unknown }).type;
  return typeof t === 'string' && GEOJSON_TYPES.has(t);
}

function readXY(c: unknown): [number, number] | null {
  if (!Array.isArray(c)) return null;
  const x = Number(c[0]);
  const y = Number(c[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return [x, y];
}

function readPath(cs: unknown, min: number): Array<[number, number]> | null {
  if (!Array.isArray(cs)) return null;
  const out: Array<[number, number]> = [];
  for (const c of cs) {
    const p = readXY(c);
    if (p) out.push(p);
  }
  return out.length >= min ? out : null;
}

/** Parse GeoJSON text. Returns null when it is not JSON at all, or not a GeoJSON
 *  object — never throws (the dialog reports the failure). */
export function parseGeoJson(text: string): GeoJsonParse | null {
  let root: unknown;
  try {
    root = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return null;
  }
  return geoJsonFromObject(root);
}

/** The parsed-object half of `parseGeoJson` (so a caller that already has the
 *  JSON — the `.json` sniff — does not parse twice). */
export function geoJsonFromObject(root: unknown): GeoJsonParse | null {
  if (!isGeoJsonObject(root)) return null;
  const out: GeoJsonParse = {
    items: [], counts: { point: 0, line: 0, polygon: 0 },
    bbox: null, propertyKeys: [], skipped: 0, crs: null,
  };
  const keySeen = new Set<string>();
  let featureNo = 0;

  const grow = (x: number, y: number) => {
    if (!out.bbox) { out.bbox = { minX: x, minY: y, maxX: x, maxY: y }; return; }
    const b = out.bbox;
    if (x < b.minX) b.minX = x;
    if (x > b.maxX) b.maxX = x;
    if (y < b.minY) b.minY = y;
    if (y > b.maxY) b.maxY = y;
  };
  const push = (shape: GeoJsonShape, properties: Record<string, unknown>) => {
    out.items.push({ shape, properties, feature: featureNo });
    if (shape.kind === 'point') { out.counts.point++; grow(shape.xy[0], shape.xy[1]); }
    else if (shape.kind === 'line') { out.counts.line++; for (const p of shape.path) grow(p[0], p[1]); }
    else { out.counts.polygon++; for (const r of shape.rings) for (const p of r) grow(p[0], p[1]); }
  };

  const geometry = (g: unknown, props: Record<string, unknown>, depth: number): void => {
    if (!g || typeof g !== 'object') { out.skipped++; return; }
    const type = (g as { type?: unknown }).type;
    const coords = (g as { coordinates?: unknown }).coordinates;
    switch (type) {
      case 'Point': {
        const p = readXY(coords);
        if (p) push({ kind: 'point', xy: p }, props); else out.skipped++;
        return;
      }
      case 'MultiPoint': {
        if (!Array.isArray(coords)) { out.skipped++; return; }
        for (const c of coords) {
          const p = readXY(c);
          if (p) push({ kind: 'point', xy: p }, props); else out.skipped++;
        }
        return;
      }
      case 'LineString': {
        const path = readPath(coords, 2);
        if (path) push({ kind: 'line', path }, props); else out.skipped++;
        return;
      }
      case 'MultiLineString': {
        if (!Array.isArray(coords)) { out.skipped++; return; }
        for (const c of coords) {
          const path = readPath(c, 2);
          if (path) push({ kind: 'line', path }, props); else out.skipped++;
        }
        return;
      }
      case 'Polygon': {
        const rings = readRings(coords);
        if (rings) push({ kind: 'polygon', rings }, props); else out.skipped++;
        return;
      }
      case 'MultiPolygon': {
        if (!Array.isArray(coords)) { out.skipped++; return; }
        for (const c of coords) {
          const rings = readRings(c);
          if (rings) push({ kind: 'polygon', rings }, props); else out.skipped++;
        }
        return;
      }
      case 'GeometryCollection': {
        const gs = (g as { geometries?: unknown }).geometries;
        if (depth >= GEOJSON_MAX_DEPTH || !Array.isArray(gs)) { out.skipped++; return; }
        for (const sub of gs) geometry(sub, props, depth + 1);
        return;
      }
      default:
        out.skipped++;
    }
  };

  const feature = (f: unknown): void => {
    if (!f || typeof f !== 'object') { out.skipped++; return; }
    featureNo++;
    const rawProps = (f as { properties?: unknown }).properties;
    const props = rawProps && typeof rawProps === 'object' && !Array.isArray(rawProps)
      ? rawProps as Record<string, unknown>
      : {};
    for (const k of Object.keys(props)) {
      if (!keySeen.has(k)) { keySeen.add(k); out.propertyKeys.push(k); }
    }
    geometry((f as { geometry?: unknown }).geometry, props, 0);
  };

  const type = (root as { type: string }).type;
  // A legacy named CRS (`{"crs":{"properties":{"name":"EPSG:3857"}}}`).
  const crsName = (root as { crs?: { properties?: { name?: unknown } } }).crs?.properties?.name;
  if (typeof crsName === 'string' && crsName !== '') out.crs = crsName;

  if (type === 'FeatureCollection') {
    const fs = (root as { features?: unknown }).features;
    if (!Array.isArray(fs)) return out;
    for (const f of fs) feature(f);
  } else if (type === 'Feature') {
    feature(root);
  } else {
    featureNo++;
    geometry(root, {}, 0);
  }
  return out;
}

function readRings(cs: unknown): Array<Array<[number, number]>> | null {
  if (!Array.isArray(cs)) return null;
  const rings: Array<Array<[number, number]>> = [];
  for (const r of cs) {
    const ring = readPath(r, 3);
    if (ring) rings.push(ring);
  }
  return rings.length > 0 ? rings : null;
}

// ---------------------------------------------------------------------------
// The coordinate transform — the foundation everything below rests on
// ---------------------------------------------------------------------------

export type GeoCoordMode = 'world' | 'cells';

export interface GeoCellTransform {
  mode: GeoCoordMode;
  xll: number;
  yll: number;
  cellSize: number;
  /** Destination grid HEIGHT — the row flip needs it. */
  height: number;
}

/** Build the transform. `mode: 'cells'` (or a model with no usable georeference)
 *  is the IDENTITY: the file's coordinates are read as grid cells, x → column,
 *  y → row, with NO flip — so a hand-written test file needs no georeference. */
export function makeCellTransform(
  georef: GeoReference | null | undefined, height: number, mode: GeoCoordMode,
): GeoCellTransform {
  if (mode === 'cells' || !georef || !(georef.cellSize > 0)) {
    return { mode: 'cells', xll: 0, yll: 0, cellSize: 1, height };
  }
  return { mode: 'world', xll: georef.xllcorner, yll: georef.yllcorner, cellSize: georef.cellSize, height };
}

/** World → CONTINUOUS cell space, where cell (col, row) occupies the unit square
 *  `[col, col+1) × [row, row+1)`.
 *
 *  THE ROW FLIP IS THE WHOLE POINT: the Esri georeference states the LOWER-LEFT
 *  corner with Y growing UP, while grid row 0 is the TOP row — so
 *      `cx = (wx − xllcorner) / cellSize`
 *      `cy = height − (wy − yllcorner) / cellSize`.
 *
 *  This is the exact inverse of the simulator's world-coordinate hover readout
 *  (`worldLabelOfCell`), which reports a cell's CENTRE as
 *  `wx = xll + (col+0.5)·cs`, `wy = yll + (nrows−1−row+0.5)·cs`: feed that back
 *  through here and you get `(col+0.5, row+0.5)`, whose floor is `(col, row)`.
 *
 *  Cell space IS the agent frame too — the agent world is the grid frame 1:1
 *  (Decision D-FIELD; the field bridge indexes `floor(y)*W + floor(x)`), which is
 *  why `worldToAgent` is this function unrounded. */
export function toCellSpace(t: GeoCellTransform, wx: number, wy: number): [number, number] {
  if (t.mode === 'cells') return [wx, wy];
  return [(wx - t.xll) / t.cellSize, t.height - (wy - t.yll) / t.cellSize];
}

/** The integer cell a world point falls in (may lie outside the grid). */
export function worldToCell(t: GeoCellTransform, wx: number, wy: number): { col: number; row: number } {
  const [cx, cy] = toCellSpace(t, wx, wy);
  return { col: Math.floor(cx), row: Math.floor(cy) };
}

/** The continuous AGENT position a world point maps to. */
export function worldToAgent(t: GeoCellTransform, wx: number, wy: number): { ax: number; ay: number } {
  const [ax, ay] = toCellSpace(t, wx, wy);
  return { ax, ay };
}

// ---------------------------------------------------------------------------
// Rasterisation primitives (PURE, cell space in — marked cells out)
// ---------------------------------------------------------------------------

export type CellMark = (col: number, row: number) => void;

/** Fill a polygon by the EVEN-ODD rule over CELL CENTRES.
 *
 *  Rings arrive in CELL SPACE, ring 0 outer and the rest holes; every ring's
 *  edges go into ONE crossing list, so even-odd subtracts the holes with no
 *  special case (the standard scanline fill, and what every GIS rasteriser does).
 *
 *  A cell is inside iff its CENTRE `(col+0.5, row+0.5)` is inside — the same
 *  centre-sampling rule the GeoTIFF resampler uses, so a polygon and a raster
 *  covering the same ground select the same cells.
 *
 *  Cost is O(rows-in-bbox × edges), never O(grid). */
export function polygonCells(
  rings: Array<Array<readonly [number, number]>>, W: number, H: number, mark: CellMark,
): void {
  const x0: number[] = [], y0: number[] = [], x1: number[] = [], y1: number[] = [];
  let minY = Infinity, maxY = -Infinity;
  for (const ring of rings) {
    const n = ring.length;
    if (n < 3) continue;
    for (let i = 0; i < n; i++) {
      const a = ring[i]!, b = ring[(i + 1) % n]!;
      if (a[1] < minY) minY = a[1];
      if (a[1] > maxY) maxY = a[1];
      // A horizontal edge can never CROSS a scanline, and counting it would
      // double-count the vertex it shares with its neighbours.
      if (a[1] === b[1]) continue;
      x0.push(a[0]); y0.push(a[1]); x1.push(b[0]); y1.push(b[1]);
    }
  }
  if (x0.length === 0 || !Number.isFinite(minY) || !Number.isFinite(maxY)) return;
  const rLo = Math.max(0, Math.floor(minY - 0.5));
  const rHi = Math.min(H - 1, Math.ceil(maxY));
  const xs: number[] = [];
  for (let r = rLo; r <= rHi; r++) {
    const y = r + 0.5;
    xs.length = 0;
    for (let e = 0; e < x0.length; e++) {
      const ay = y0[e]!, by = y1[e]!;
      // Half-open in y (`<=` on exactly one end) — the standard rule that makes
      // a shared vertex count once rather than twice.
      if ((ay <= y) === (by <= y)) continue;
      xs.push(x0[e]! + ((y - ay) / (by - ay)) * (x1[e]! - x0[e]!));
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      // Half-open span [xa, xb): a centre exactly ON the left edge is IN, one
      // exactly on the right edge is OUT — so two polygons sharing a border
      // never both claim the same cell.
      const xa = xs[i]!, xb = xs[i + 1]!;
      let cA = Math.ceil(xa - 0.5);
      let cB = Math.ceil(xb - 0.5) - 1;
      if (cA < 0) cA = 0;
      if (cB > W - 1) cB = W - 1;
      for (let c = cA; c <= cB; c++) mark(c, r);
    }
  }
}

/** Every cell a segment PASSES THROUGH (a supercover walk — Amanatides & Woo in
 *  2D). Cells outside the grid are skipped but the walk continues, so a segment
 *  entering from off-grid still draws its in-grid part. */
export function segmentCells(
  ax: number, ay: number, bx: number, by: number, W: number, H: number, mark: CellMark,
): void {
  const put = (c: number, r: number) => { if (c >= 0 && c < W && r >= 0 && r < H) mark(c, r); };
  let cx = Math.floor(ax), cy = Math.floor(ay);
  const ex = Math.floor(bx), ey = Math.floor(by);
  put(cx, cy);
  if (cx === ex && cy === ey) return;
  const dx = bx - ax, dy = by - ay;
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const tDeltaX = stepX !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDeltaY = stepY !== 0 ? Math.abs(1 / dy) : Infinity;
  let tMaxX = stepX > 0 ? (cx + 1 - ax) / dx : stepX < 0 ? (cx - ax) / dx : Infinity;
  let tMaxY = stepY > 0 ? (cy + 1 - ay) / dy : stepY < 0 ? (cy - ay) / dy : Infinity;
  // A Manhattan bound on the number of cell boundaries the segment can cross —
  // a hard stop, so a degenerate/NaN slope can never spin.
  const maxSteps = Math.abs(ex - cx) + Math.abs(ey - cy) + 2;
  for (let i = 0; i < maxSteps && (cx !== ex || cy !== ey); i++) {
    if (tMaxX < tMaxY) { cx += stepX; tMaxX += tDeltaX; }
    else { cy += stepY; tMaxY += tDeltaY; }
    put(cx, cy);
  }
}

/** Squared distance from a point to a segment. */
function distToSeg2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const qx = ax + t * dx - px, qy = ay + t * dy - py;
  return qx * qx + qy * qy;
}

/** A polyline stamped `width` CELLS wide.
 *
 *  SEMANTICS: width 1 is exactly "the cells the segment passes through" (the
 *  supercover — the natural "burn a river" answer, and NOT the same as
 *  centre-within-0.5, which a diagonal would miss). A wider line additionally
 *  takes every cell whose CENTRE lies within `(width−1)/2` of the segment, so the
 *  stamp grows symmetrically and monotonically from that base — a CAPSULE with
 *  ROUND caps, the same shape the 2D brush's Line tool paints, so a wide line
 *  reaches `(width−1)/2` cells past each endpoint. */
export function lineCells(
  path: ReadonlyArray<readonly [number, number]>, width: number, W: number, H: number, mark: CellMark,
): void {
  const rad = Math.max(0, (Math.min(Math.max(1, width), GEOJSON_MAX_LINE_WIDTH) - 1) / 2);
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i]!, b = path[i + 1]!;
    segmentCells(a[0], a[1], b[0], b[1], W, H, mark);
    if (rad <= 0) continue;
    const cLo = Math.max(0, Math.floor(Math.min(a[0], b[0]) - rad - 0.5));
    const cHi = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0]) + rad));
    const rLo = Math.max(0, Math.floor(Math.min(a[1], b[1]) - rad - 0.5));
    const rHi = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1]) + rad));
    const r2 = rad * rad;
    for (let r = rLo; r <= rHi; r++) {
      for (let c = cLo; c <= cHi; c++) {
        if (distToSeg2(c + 0.5, r + 0.5, a[0], a[1], b[0], b[1]) <= r2) mark(c, r);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Property → value decoding
// ---------------------------------------------------------------------------

/** Decode ONE GeoJSON property value into the number the worker stores.
 *
 *  A property is `string | number | boolean | null` (JSON), so this composes the
 *  two decoders that already exist rather than inventing a third:
 *    number  → `decodeNumericValue` (a tag takes the INDEX, a bool is NONZERO —
 *              the raster convention, so a raster code and a vector code behave
 *              the same)
 *    boolean → the CSV word decode
 *    string  → the CSV decode (so a tag matches by NAME, case-insensitively)
 *    else    → the attribute default, counted (an object/array property is not a
 *              per-cell scalar). */
export function decodeGeoJsonProperty(attr: CsvAttrShape, v: unknown): { value: number; ok: boolean } {
  if (v === null || v === undefined) return { value: encodeAttrValue(attr, undefined), ok: false };
  if (typeof v === 'number') return decodeNumericValue(attr, v);
  if (typeof v === 'boolean') return decodeCsvValue(attr, v ? 'true' : 'false');
  if (typeof v === 'string') return decodeCsvValue(attr, v);
  return { value: encodeAttrValue(attr, undefined), ok: false };
}

/** Does the feature CARRY this property at all?
 *
 *  A GeoJSON property set is SPARSE — features in one collection routinely carry
 *  different keys — so "the key is absent" is NO DATA (take the attribute default,
 *  silently), while "the key is there but empty / wrong / null" is BAD DATA
 *  (default + counted + listed). Both builders apply exactly this rule; counting
 *  absence would flood the report on any real file. */
export function hasProperty(props: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(props, key);
}

/** Printable form of a property value for an issue row. */
export function propertyLabel(v: unknown): string {
  if (v === null || v === undefined) return '(none)';
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch { return '(object)'; } }
  return String(v);
}

// ---------------------------------------------------------------------------
// Rasterising a whole feature list onto the grid
// ---------------------------------------------------------------------------

/** Where each covered cell's value comes from. `property` is the NetLogo
 *  `gis:apply-coverage` shape: the feature's own attribute decides the cell's
 *  value, so a landcover file paints its classes in one pass. */
export type GeoJsonValueSource =
  | { kind: 'fixed'; value: number }
  | { kind: 'property'; key: string };

export interface GeoJsonRasterOptions {
  /** Which geometry kinds to burn (a file usually mixes them). */
  kinds: { point: boolean; line: boolean; polygon: boolean };
  /** Line stamp width in CELLS (≥ 1). */
  lineWidth: number;
  value: GeoJsonValueSource;
  attr: CsvAttrShape;
}

export interface GeoJsonRasterResult {
  width: number;
  height: number;
  /** Per cell: an index into `groupValues`, or −1 for "not covered". 4 bytes a
   *  cell — the whole point of the indirection is that a burn over a large grid
   *  costs the grid, not the feature list. LAST feature wins on overlap. */
  groupOf: Int32Array;
  /** The distinct values written, in first-use order (≤ the feature count). */
  groupValues: number[];
  /** How many cells are covered. */
  cellCount: number;
  featuresUsed: number;
  /** Features whose KIND was switched off. */
  featuresFiltered: number;
  /** Features that covered no in-grid cell (entirely outside, or too small to
   *  contain a cell centre). */
  featuresOutside: number;
  /** Property values that were PRESENT but could not be decoded (→ default). */
  badValues: number;
  /** Features that simply do not carry the chosen property. A GeoJSON property
   *  set is SPARSE — an absent key is "no data", not bad data, so it takes the
   *  attribute default SILENTLY and is only counted here (counting it as a bad
   *  value would flood the report on any real, heterogeneous file). */
  featuresMissingValue: number;
  issues: CsvIssue[];
}

/** Burn a feature list onto the grid. Coordinates go through `transform`, so the
 *  caller never converts anything itself. */
export function rasterizeFeatures(
  items: readonly GeoJsonItem[],
  transform: GeoCellTransform,
  W: number, H: number,
  opts: GeoJsonRasterOptions,
): GeoJsonRasterResult {
  const groupOf = new Int32Array(Math.max(0, W * H)).fill(-1);
  const out: GeoJsonRasterResult = {
    width: W, height: H, groupOf, groupValues: [],
    cellCount: 0, featuresUsed: 0, featuresFiltered: 0, featuresOutside: 0,
    badValues: 0, featuresMissingValue: 0, issues: [],
  };
  if (W < 1 || H < 1) return out;
  const groupIndex = new Map<number, number>();
  const groupFor = (value: number): number => {
    const hit = groupIndex.get(value);
    if (hit !== undefined) return hit;
    const gi = out.groupValues.length;
    out.groupValues.push(value);
    groupIndex.set(value, gi);
    return gi;
  };

  let gi = -1;
  let marked = 0;
  const mark: CellMark = (c, r) => {
    if (c < 0 || c >= W || r < 0 || r >= H) return;
    const o = r * W + c;
    if (groupOf[o] === -1) out.cellCount++;
    groupOf[o] = gi;
    marked++;
  };

  const cellSpaceRing = (ring: ReadonlyArray<readonly [number, number]>): Array<[number, number]> =>
    ring.map(p => toCellSpace(transform, p[0], p[1]));

  for (const item of items) {
    if (!opts.kinds[item.shape.kind]) { out.featuresFiltered++; continue; }
    // Resolve the value FIRST — a feature whose value cannot be decoded still
    // burns (with the attribute default), and the miss is counted, never silent.
    let value: number;
    if (opts.value.kind === 'fixed') {
      value = opts.value.value;
    } else if (!hasProperty(item.properties, opts.value.key)) {
      value = encodeAttrValue(opts.attr, undefined);
      out.featuresMissingValue++;
    } else {
      const raw = item.properties[opts.value.key];
      const d = decodeGeoJsonProperty(opts.attr, raw);
      value = d.value;
      if (!d.ok) {
        out.badValues++;
        if (out.issues.length < MAX_ISSUES) {
          out.issues.push({
            row: item.feature, column: opts.value.key, raw: propertyLabel(raw),
            reason: `not a valid ${opts.attr.type} value`,
          });
        }
      }
    }
    gi = groupFor(value);
    marked = 0;
    switch (item.shape.kind) {
      case 'point': {
        const [cx, cy] = toCellSpace(transform, item.shape.xy[0], item.shape.xy[1]);
        mark(Math.floor(cx), Math.floor(cy));
        break;
      }
      case 'line':
        lineCells(cellSpaceRing(item.shape.path), opts.lineWidth, W, H, mark);
        break;
      case 'polygon':
        polygonCells(item.shape.rings.map(cellSpaceRing), W, H, mark);
        break;
    }
    out.featuresUsed++;
    if (marked === 0) out.featuresOutside++;
  }
  return out;
}

/** Split a raster result into one cell-index list per distinct value — the shape
 *  the caller turns into `paintManual` batches (which carry ONE shared value).
 *  Indices, not `{row,col}` objects: 4 bytes a cell, so a full-grid burn stays
 *  cheap until the very last moment. */
export function collectRasterGroups(
  res: GeoJsonRasterResult,
): Array<{ value: number; cells: Int32Array }> {
  const n = res.groupValues.length;
  if (n === 0) return [];
  const counts = new Int32Array(n);
  for (let i = 0; i < res.groupOf.length; i++) {
    const g = res.groupOf[i]!;
    if (g >= 0) counts[g]!++;
  }
  const out = res.groupValues.map((value, g) => ({ value, cells: new Int32Array(counts[g]!) }));
  const fill = new Int32Array(n);
  for (let i = 0; i < res.groupOf.length; i++) {
    const g = res.groupOf[i]!;
    if (g < 0) continue;
    const k = fill[g]!;
    out[g]!.cells[k] = i;
    fill[g] = k + 1;
  }
  return out.filter(g => g.cells.length > 0);
}

// ---------------------------------------------------------------------------
// Points → agents
// ---------------------------------------------------------------------------

/** The agent targets a GeoJSON property can take — everything the CSV importer
 *  offers EXCEPT `x` and `y`, which come from the point GEOMETRY and are never
 *  overridable from a property (that is the whole reason the file is spatial). */
export function geoJsonAgentTargetOptions(
  attrs: CsvAttrShape[], is3d: boolean,
): Array<{ key: string; label: string }> {
  return agentTargetOptions(attrs, is3d).filter(o => o.key !== 'geom:x' && o.key !== 'geom:y');
}

/** Auto-map property keys onto agent targets — the CSV importer's own header
 *  logic (geometry aliases, then an exact attribute-name match, then
 *  `<vectorName><x|y|z>`), with `x` / `y` stripped for the reason above. */
export function autoMapGeoJsonProperties(
  keys: string[], attrs: CsvAttrShape[], is3d: boolean,
): string[] {
  return autoMapAgentColumns(keys, attrs, is3d, keys.length)
    .map(k => (k === 'geom:x' || k === 'geom:y' ? 'ignore' : k));
}

export interface GeoJsonAgentBuild {
  agents: CsvAgentSpec[];
  /** Non-point features (they cannot become an agent). */
  skippedNonPoint: number;
  /** Points whose transformed position was not finite. */
  skippedBadPosition: number;
  badValues: number;
  /** Agents outside the world (the worker wraps or clamps them). */
  outOfBounds: number;
  issues: CsvIssue[];
}

/** Build the per-agent `pasteAgents` specs from point features.
 *
 *  Position comes from the geometry through `transform`; every other target is a
 *  PROPERTY, decoded per the attribute's type. `world` only drives the
 *  out-of-bounds COUNT — the worker owns the actual wrap/clamp. */
export function buildGeoJsonAgents(
  items: readonly GeoJsonItem[],
  transform: GeoCellTransform,
  propertyKeys: string[],
  targetKeys: string[],
  attrs: CsvAttrShape[],
  world: { w: number; h: number; d: number },
  is3d: boolean,
): GeoJsonAgentBuild {
  const attrById = new Map(attrs.map(a => [a.id, a]));
  const targets = propertyKeys.map((_, i) => parseTargetKey(targetKeys[i] ?? 'ignore'));
  const out: GeoJsonAgentBuild = {
    agents: [], skippedNonPoint: 0, skippedBadPosition: 0, badValues: 0, outOfBounds: 0, issues: [],
  };
  const note = (feature: number, key: string, raw: unknown, reason: string) => {
    out.badValues++;
    if (out.issues.length < MAX_ISSUES) out.issues.push({ row: feature, column: key, raw: propertyLabel(raw), reason });
  };

  for (const item of items) {
    if (item.shape.kind !== 'point') { out.skippedNonPoint++; continue; }
    const { ax, ay } = worldToAgent(transform, item.shape.xy[0], item.shape.xy[1]);
    if (!Number.isFinite(ax) || !Number.isFinite(ay)) { out.skippedBadPosition++; continue; }

    let z: number | null = null, radius: number | null = null;
    let vx: number | null = null, vy: number | null = null, vz: number | null = null;
    const sets: Array<{ attrId: string; value: number }> = [];
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i]!;
      if (t.kind === 'ignore') continue;
      const key = propertyKeys[i]!;
      // Absent ⇒ this feature does not carry the key ⇒ leave the target alone
      // (the agent keeps its default) and say nothing — see `hasProperty`.
      if (!hasProperty(item.properties, key)) continue;
      const raw = item.properties[key];
      if (t.kind === 'geom') {
        const n = typeof raw === 'number' ? raw : Number(typeof raw === 'string' ? raw.trim() : NaN);
        if (!Number.isFinite(n)) { note(item.feature, key, raw, 'not a number'); continue; }
        switch (t.field) {
          case 'z': z = n; break;
          case 'vx': vx = n; break; case 'vy': vy = n; break; case 'vz': vz = n; break;
          case 'radius': radius = n; break;
          default: break;   // x / y are never property-driven (see the options above)
        }
      } else if (t.kind === 'vec') {
        const attr = attrById.get(t.attrId);
        if (!attr) continue;
        const id = vectorComponentIds(attr.id, vectorDimsOf(attr))[t.comp];
        if (!id) continue;
        const n = typeof raw === 'number' ? raw : Number(typeof raw === 'string' ? raw.trim() : NaN);
        if (!Number.isFinite(n)) { note(item.feature, key, raw, 'not a number'); sets.push({ attrId: id, value: 0 }); continue; }
        sets.push({ attrId: id, value: n });
      } else {
        const attr = attrById.get(t.attrId);
        if (!attr) continue;
        const d = decodeGeoJsonProperty(attr, raw);
        if (!d.ok) note(item.feature, key, raw, `not a valid ${attr.type} value`);
        sets.push({ attrId: attr.id, value: d.value });
      }
    }

    const spec: CsvAgentSpec = { x: ax, y: ay, sets };
    if (is3d) spec.z = z ?? 0;
    if (radius !== null) spec.radius = radius;
    if (vx !== null) spec.vx = vx;
    if (vy !== null) spec.vy = vy;
    if (is3d && vz !== null) spec.vz = vz;
    const oob = ax < 0 || ax >= world.w || ay < 0 || ay >= world.h
      || (is3d && ((spec.z ?? 0) < 0 || (spec.z ?? 0) >= world.d));
    if (oob) out.outOfBounds++;
    out.agents.push(spec);
  }
  return out;
}

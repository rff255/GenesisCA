// GeoJSON vector import verification.
//
// Same discipline as scripts/test-asc-import.mjs / test-geotiff-import.mjs: this
// asserts VALUES, not "it parsed". A vector import is a scientific artefact —
// the cell a polygon covers must be exactly the cell the georeference says, or
// the feature must be reported as covering none.
//
// Covers: every GeoJSON shape (FeatureCollection / Feature / bare geometry /
// Multi* / GeometryCollection) and every malformed input; the coordinate
// transform EXACTLY (incl. the Esri row flip and the inverse-of-the-hover-readout
// property); polygon fill hand-verified (square, concave, WITH A HOLE, straddling
// the grid boundary, shared edges); the line walk (axis-aligned, diagonal,
// width > 1, entering from off-grid); points → cells; the value sources (fixed
// and per-feature property, incl. a tag matched BY NAME); overlap order; and the
// agent build (property auto-map, geometry aliases, vector components,
// out-of-bounds counting).
//
// Run from the repo root:  node scripts/test-geojson-import.mjs
import { build } from 'esbuild';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = `export * from '../src/simulator/geojsonImport.ts';\n`;
const dir = mkdtempSync(join(tmpdir(), 'gca-geojson-'));
const entryPath = join(ROOT, 'scripts', '__geojson_entry.ts');
writeFileSync(entryPath, ENTRY);
const outPath = join(dir, 'bundle.mjs');
await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: ROOT });
const M = await import(pathToFileURL(outPath).href);

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ok  ${name}`);
  else { console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); failures++; }
};
const eq = (name, actual, expected) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);

const intAttr = { id: 'v', type: 'integer', defaultValue: '0' };
const floatAttr = { id: 'f', type: 'float', defaultValue: '0' };
const boolAttr = { id: 'b', type: 'bool', defaultValue: 'false' };
const tagAttr = { id: 't', type: 'tag', defaultValue: '0', tagOptions: ['empty', 'water', 'forest'] };

/** Collect the DISTINCT cells a mark-emitting primitive produces, as "col,row"
 *  strings. Deduped: a primitive may legitimately mark a cell twice (a polyline's
 *  shared corner, a thick line's supercover ∪ disc) and `rasterizeFeatures`
 *  dedupes through `groupOf`, so the SET is the contract. */
const collect = (fn) => {
  const out = new Set();
  fn((c, r) => out.add(`${c},${r}`));
  return [...out].sort();
};
/** The covered cells of a raster result, as "col,row" strings, sorted. */
const covered = (res) => {
  const out = [];
  for (let i = 0; i < res.groupOf.length; i++) {
    if (res.groupOf[i] >= 0) out.push(`${i % res.width},${Math.floor(i / res.width)}`);
  }
  return out.sort();
};
/** Value of one cell, or undefined when uncovered. */
const cellValue = (res, col, row) => {
  const g = res.groupOf[row * res.width + col];
  return g < 0 ? undefined : res.groupValues[g];
};

const fc = (...features) => JSON.stringify({ type: 'FeatureCollection', features });
const feat = (geometry, properties = {}) => ({ type: 'Feature', geometry, properties });
const poly = (...rings) => ({ type: 'Polygon', coordinates: rings });
const identity = (H) => M.makeCellTransform(null, H, 'cells');

// ---------------------------------------------------------------------------
console.log('\n[1] parsing');
// ---------------------------------------------------------------------------
{
  const p = M.parseGeoJson(fc(
    feat({ type: 'Point', coordinates: [1, 2] }, { name: 'a' }),
    feat({ type: 'LineString', coordinates: [[0, 0], [3, 3]] }, { name: 'b', kind: 'road' }),
    feat(poly([[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]), { kind: 'lake' }),
  ));
  check('FeatureCollection parses', !!p);
  eq('counts', p.counts, { point: 1, line: 1, polygon: 1 });
  eq('property keys, first-seen order', p.propertyKeys, ['name', 'kind']);
  eq('bbox spans every used coordinate', p.bbox, { minX: 0, minY: 0, maxX: 3, maxY: 3 });
  eq('feature indices are 1-based', p.items.map(i => i.feature), [1, 2, 3]);
  eq('properties ride each item', p.items[2].properties, { kind: 'lake' });
}
{
  const p = M.parseGeoJson(JSON.stringify(feat({ type: 'Point', coordinates: [5, 6] }, { a: 1 })));
  eq('a bare Feature parses', p.counts, { point: 1, line: 0, polygon: 0 });
  eq('  … keeps its properties', p.items[0].properties, { a: 1 });
}
{
  const p = M.parseGeoJson(JSON.stringify({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }));
  eq('a bare geometry parses', p.counts, { point: 0, line: 0, polygon: 1 });
  eq('  … gets empty properties', p.items[0].properties, {});
}
{
  const p = M.parseGeoJson(fc(
    feat({ type: 'MultiPoint', coordinates: [[0, 0], [1, 1], [2, 2]] }, { id: 7 }),
    feat({ type: 'MultiLineString', coordinates: [[[0, 0], [1, 0]], [[0, 1], [1, 1]]] }),
    feat({ type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]], [[[5, 5], [6, 5], [6, 6], [5, 5]]]] }),
  ));
  eq('Multi* geometries flatten', p.counts, { point: 3, line: 2, polygon: 2 });
  check('Multi* parts SHARE the feature properties', p.items.slice(0, 3).every(i => i.properties.id === 7));
  check('Multi* parts share the feature INDEX', p.items.slice(0, 3).every(i => i.feature === 1));
}
{
  const p = M.parseGeoJson(JSON.stringify(feat({
    type: 'GeometryCollection',
    geometries: [{ type: 'Point', coordinates: [1, 1] }, { type: 'LineString', coordinates: [[0, 0], [2, 2]] }],
  }, { g: 'c' })));
  eq('GeometryCollection descends', p.counts, { point: 1, line: 1, polygon: 0 });
  check('  … parts inherit the properties', p.items.every(i => i.properties.g === 'c'));
}
{
  const p = M.parseGeoJson(fc(
    feat(null),
    feat({ type: 'Point', coordinates: ['x', 2] }),
    feat({ type: 'LineString', coordinates: [[0, 0]] }),                       // 1-point line
    feat(poly([[0, 0], [1, 1]])),                                              // 2-point ring
    feat({ type: 'Nonsense', coordinates: [0, 0] }),
    feat({ type: 'Point', coordinates: [1, 2] }),
  ));
  eq('malformed geometries are SKIPPED, not fatal', [p.counts.point, p.skipped], [1, 5]);
}
check('a BOM is tolerated', M.parseGeoJson('﻿' + fc(feat({ type: 'Point', coordinates: [1, 1] }))).counts.point === 1);
check('non-JSON returns null', M.parseGeoJson('not json at all {') === null);
check('a .gcaproj-shaped JSON returns null', M.parseGeoJson('{"schemaVersion":1,"properties":{}}') === null);
check('an empty FeatureCollection parses to nothing', M.parseGeoJson('{"type":"FeatureCollection","features":[]}').items.length === 0);
check('isGeoJsonObject accepts a FeatureCollection', M.isGeoJsonObject({ type: 'FeatureCollection', features: [] }) === true);
check('isGeoJsonObject rejects a project file', M.isGeoJsonObject({ schemaVersion: 1 }) === false);
{
  const p = M.parseGeoJson(JSON.stringify({
    type: 'FeatureCollection', crs: { type: 'name', properties: { name: 'EPSG:3857' } },
    features: [feat({ type: 'Point', coordinates: [0, 0] })],
  }));
  eq('a legacy named CRS is surfaced', p.crs, 'EPSG:3857');
}
{
  // A GeometryCollection nested past the depth guard must terminate, not recurse.
  let g = { type: 'Point', coordinates: [1, 1] };
  for (let i = 0; i < 20; i++) g = { type: 'GeometryCollection', geometries: [g] };
  const p = M.parseGeoJson(JSON.stringify(feat(g)));
  check('deep GeometryCollection nesting terminates', p !== null && p.counts.point === 0 && p.skipped > 0);
}

// ---------------------------------------------------------------------------
console.log('\n[2] the coordinate transform');
// ---------------------------------------------------------------------------
{
  // A 10-column × 8-row grid at 30 m cells with its lower-left corner at
  // (500000, 4600000): cell (0,0) is the NORTH-WEST corner, so its centre is
  // (500015, 4600000 + 7·30 + 15) = (500015, 4600225).
  const georef = { xllcorner: 500000, yllcorner: 4600000, cellSize: 30 };
  const t = M.makeCellTransform(georef, 8, 'world');
  eq('NW corner cell', M.worldToCell(t, 500015, 4600225), { col: 0, row: 0 });
  eq('SW corner cell (Y min → LAST row)', M.worldToCell(t, 500015, 4600015), { col: 0, row: 7 });
  eq('SE corner cell', M.worldToCell(t, 500285, 4600015), { col: 9, row: 7 });
  eq('NE corner cell', M.worldToCell(t, 500285, 4600225), { col: 9, row: 0 });
  eq('a middle cell', M.worldToCell(t, 500000 + 4 * 30 + 15, 4600000 + 3 * 30 + 15), { col: 4, row: 4 });
  eq('exactly on the lower-left corner', M.worldToCell(t, 500000, 4600000), { col: 0, row: 8 });
  eq('west of the grid', M.worldToCell(t, 499990, 4600100), { col: -1, row: 4 });

  // THE PROPERTY: this must be the exact inverse of the simulator's world
  // readout, `wx = xll + (col+0.5)·cs`, `wy = yll + (nrows−1−row+0.5)·cs`.
  let bad = 0;
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 10; col++) {
      const wx = georef.xllcorner + (col + 0.5) * georef.cellSize;
      const wy = georef.yllcorner + (8 - 1 - row + 0.5) * georef.cellSize;
      const back = M.worldToCell(t, wx, wy);
      if (back.col !== col || back.row !== row) bad++;
      const a = M.worldToAgent(t, wx, wy);
      if (Math.abs(a.ax - (col + 0.5)) > 1e-9 || Math.abs(a.ay - (row + 0.5)) > 1e-9) bad++;
    }
  }
  check('the hover readout round-trips through the transform on all 80 cells', bad === 0, `${bad} mismatches`);

  const a = M.worldToAgent(t, 500000, 4600240);
  eq('an agent at the NW corner of the world is (0, 0)', [a.ax, a.ay], [0, 0]);
  const a2 = M.worldToAgent(t, 500150, 4600120);
  eq('agent coords are continuous cell coords', [a2.ax, a2.ay], [5, 4]);
}
{
  const t = M.makeCellTransform(null, 8, 'world');
  check('no georef falls back to the cells mode', t.mode === 'cells');
  eq('cells mode is the identity (NO flip)', M.worldToCell(t, 3.7, 1.2), { col: 3, row: 1 });
  eq('cells mode agent coords are the raw numbers', M.worldToAgent(t, 3.5, 1.5), { ax: 3.5, ay: 1.5 });
  const t2 = M.makeCellTransform({ xllcorner: 100, yllcorner: 200, cellSize: 10 }, 8, 'cells');
  eq('an explicit cells mode ignores the georef', M.worldToCell(t2, 2, 3), { col: 2, row: 3 });
  const t3 = M.makeCellTransform({ xllcorner: 0, yllcorner: 0, cellSize: 0 }, 8, 'world');
  check('a zero cell size falls back too', t3.mode === 'cells');
}

// ---------------------------------------------------------------------------
console.log('\n[3] polygon fill (cell CENTRES, even-odd)');
// ---------------------------------------------------------------------------
{
  // A 3×2 axis-aligned box from (1,1) to (4,3) on a 6×6 grid: the centres inside
  // are cols 1..3, rows 1..2 — hand-counted.
  const cells = collect(m => M.polygonCells([[[1, 1], [4, 1], [4, 3], [1, 3], [1, 1]]], 6, 6, m));
  eq('axis-aligned box', cells, ['1,1', '1,2', '2,1', '2,2', '3,1', '3,2'].sort());
}
{
  // Half-open span: a box on EXACT cell boundaries shares its right edge with
  // the next box, and the two must not both claim the boundary column.
  const left = collect(m => M.polygonCells([[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]], 4, 4, m));
  const right = collect(m => M.polygonCells([[[2, 0], [4, 0], [4, 2], [2, 2], [2, 0]]], 4, 4, m));
  eq('left box', left, ['0,0', '0,1', '1,0', '1,1'].sort());
  eq('right box', right, ['2,0', '2,1', '3,0', '3,1'].sort());
  check('adjacent boxes never claim the same cell', left.every(c => !right.includes(c)));
}
{
  // An L (concave): the scanline must not fill across the notch.
  //   (0,0) (4,0) (4,1) (1,1) (1,4) (0,4)
  const cells = collect(m => M.polygonCells([[[0, 0], [4, 0], [4, 1], [1, 1], [1, 4], [0, 4], [0, 0]]], 6, 6, m));
  eq('concave L', cells, ['0,0', '1,0', '2,0', '3,0', '0,1', '0,2', '0,3'].sort());
}
{
  // A 6×6 outer ring with a 2×2 hole: even-odd must subtract the interior ring.
  const rings = [
    [[0, 0], [6, 0], [6, 6], [0, 6], [0, 0]],
    [[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]],
  ];
  const cells = collect(m => M.polygonCells(rings, 6, 6, m));
  check('polygon WITH A HOLE covers 32 of 36 cells', cells.length === 32, `got ${cells.length}`);
  check('the hole cells are excluded', !cells.includes('2,2') && !cells.includes('3,2') && !cells.includes('2,3') && !cells.includes('3,3'));
  check('a cell just outside the hole is included', cells.includes('1,2') && cells.includes('4,3'));
  // The hole's winding direction must not matter (even-odd, not nonzero).
  const rev = collect(m => M.polygonCells([rings[0], [...rings[1]].reverse()], 6, 6, m));
  eq('hole winding direction is irrelevant (even-odd)', rev, cells);
}
{
  // Straddling the grid boundary: only the in-grid part is marked.
  const cells = collect(m => M.polygonCells([[[-3, -3], [2, -3], [2, 2], [-3, 2], [-3, -3]]], 5, 5, m));
  eq('a polygon straddling (0,0) is clipped', cells, ['0,0', '0,1', '1,0', '1,1'].sort());
  const none = collect(m => M.polygonCells([[[10, 10], [12, 10], [12, 12], [10, 12], [10, 10]]], 5, 5, m));
  eq('a polygon entirely outside marks nothing', none, []);
}
{
  // Sub-cell polygon: it contains NO cell centre, so it covers nothing — and the
  // caller reports that (featuresOutside), rather than silently rounding it up.
  const none = collect(m => M.polygonCells([[[1.6, 1.6], [1.9, 1.6], [1.9, 1.9], [1.6, 1.9], [1.6, 1.6]]], 5, 5, m));
  eq('a polygon smaller than a cell covers nothing', none, []);
  const one = collect(m => M.polygonCells([[[1.4, 1.4], [1.6, 1.4], [1.6, 1.6], [1.4, 1.6], [1.4, 1.4]]], 5, 5, m));
  eq('a tiny polygon AROUND a centre covers that cell', one, ['1,1']);
}
{
  // An unclosed ring (GeoJSON requires closing, but files in the wild skip it):
  // the fill closes it implicitly, so it must match the closed form.
  const closed = collect(m => M.polygonCells([[[1, 1], [4, 1], [4, 3], [1, 3], [1, 1]]], 6, 6, m));
  const open = collect(m => M.polygonCells([[[1, 1], [4, 1], [4, 3], [1, 3]]], 6, 6, m));
  eq('an unclosed ring fills like a closed one', open, closed);
}
{
  // A diamond (no axis-aligned edges), radius 2.2 about (2.5, 2.5) so no vertex
  // sits on a cell centre — hand-checked as the centres with |dx| + |dy| < 2.2.
  const cells = collect(m => M.polygonCells([[[2.5, 0.3], [4.7, 2.5], [2.5, 4.7], [0.3, 2.5], [2.5, 0.3]]], 5, 5, m));
  eq('diamond', cells, ['2,0', '1,1', '2,1', '3,1', '0,2', '1,2', '2,2', '3,2', '4,2', '1,3', '2,3', '3,3', '2,4'].sort());
  // …and the SAME diamond with its vertices exactly ON cell centres shows the
  // half-open rule at work: the left/top edge cell is in, the right/bottom is out.
  const tie = collect(m => M.polygonCells([[[2.5, 0.5], [4.5, 2.5], [2.5, 4.5], [0.5, 2.5], [2.5, 0.5]]], 5, 5, m));
  check('half-open spans keep the LEFT edge cell and drop the RIGHT one',
    tie.includes('0,2') && !tie.includes('4,2'));
}

// ---------------------------------------------------------------------------
console.log('\n[4] line walk');
// ---------------------------------------------------------------------------
{
  eq('horizontal segment', collect(m => M.lineCells([[0.5, 2.5], [4.5, 2.5]], 1, 6, 6, m)),
    ['0,2', '1,2', '2,2', '3,2', '4,2'].sort());
  eq('vertical segment', collect(m => M.lineCells([[2.5, 0.5], [2.5, 3.5]], 1, 6, 6, m)),
    ['2,0', '2,1', '2,2', '2,3'].sort());
  // A supercover diagonal takes EVERY cell it passes through, not just the 4 on
  // the Bresenham line — that is the "cells the segment passes through" contract.
  const diag = collect(m => M.lineCells([[0.5, 0.5], [3.5, 3.5]], 1, 6, 6, m));
  check('diagonal includes both diagonal cells and their shared edges', diag.length >= 4 && diag.includes('0,0') && diag.includes('3,3'));
  check('every diagonal cell is on or adjacent to the line', diag.every(c => {
    const [x, y] = c.split(',').map(Number);
    return Math.abs(x - y) <= 1;
  }));
  eq('a zero-length segment marks its own cell', collect(m => M.lineCells([[2.2, 3.7], [2.2, 3.7]], 1, 6, 6, m)), ['2,3']);
  eq('a polyline walks every leg', collect(m => M.lineCells([[0.5, 0.5], [2.5, 0.5], [2.5, 2.5]], 1, 6, 6, m)),
    ['0,0', '1,0', '2,0', '2,1', '2,2'].sort());
}
{
  // Entering from off-grid: the traversal continues past out-of-range cells.
  eq('a segment entering from outside still draws its in-grid part',
    collect(m => M.lineCells([[-3.5, 1.5], [2.5, 1.5]], 1, 5, 5, m)), ['0,1', '1,1', '2,1'].sort());
  eq('a segment entirely outside marks nothing',
    collect(m => M.lineCells([[-5, -5], [-2, -2]], 1, 5, 5, m)), []);
}
{
  // Width: 1 is the supercover; wider adds every centre within (w−1)/2.
  const w1 = collect(m => M.lineCells([[1.5, 2.5], [4.5, 2.5]], 1, 8, 6, m));
  const w3 = collect(m => M.lineCells([[1.5, 2.5], [4.5, 2.5]], 3, 8, 6, m));
  check('width 3 is a superset of width 1', w1.every(c => w3.includes(c)));
  // A capsule with ROUND caps (the 2D brush's Line tool convention): 3 rows over
  // the span, plus the two cells exactly radius 1 beyond each end.
  eq('width 3 is a 3-row capsule with round caps', w3,
    [...[1, 2, 3].flatMap(r => [1, 2, 3, 4].map(c => `${c},${r}`)), '0,2', '5,2'].sort());
  const w5 = collect(m => M.lineCells([[2.5, 2.5], [2.5, 2.5]], 5, 7, 7, m));
  check('width 5 around a point is a disc of radius 2', w5.length === 13, `got ${w5.length}`);
  check('  … includes the axis extremes', w5.includes('0,2') && w5.includes('4,2') && w5.includes('2,0') && w5.includes('2,4'));
  check('  … excludes the far corners', !w5.includes('0,0') && !w5.includes('4,4'));
}

// ---------------------------------------------------------------------------
console.log('\n[5] rasterizeFeatures — values, kinds, order');
// ---------------------------------------------------------------------------
const allKinds = { point: true, line: true, polygon: true };
{
  const p = M.parseGeoJson(fc(
    feat(poly([[0, 0], [3, 0], [3, 2], [0, 2], [0, 0]]), { cls: 'water' }),
    feat({ type: 'LineString', coordinates: [[0.5, 3.5], [4.5, 3.5]] }, { cls: 'forest' }),
    feat({ type: 'Point', coordinates: [4.5, 4.5] }, { cls: 'water' }),
  ));
  const t = identity(6);
  const fixed = M.rasterizeFeatures(p.items, t, 6, 6, {
    kinds: allKinds, lineWidth: 1, value: { kind: 'fixed', value: 7 }, attr: intAttr,
  });
  eq('fixed value: covered cells', covered(fixed),
    ['0,0', '1,0', '2,0', '0,1', '1,1', '2,1', '0,3', '1,3', '2,3', '3,3', '4,3', '4,4'].sort());
  eq('fixed value: one group', fixed.groupValues, [7]);
  eq('fixed value: cell count', fixed.cellCount, 12);
  eq('fixed value: all features burned', [fixed.featuresUsed, fixed.featuresOutside, fixed.featuresFiltered], [3, 0, 0]);
  check('fixed value: every covered cell holds it', covered(fixed).every(c => {
    const [x, y] = c.split(',').map(Number);
    return cellValue(fixed, x, y) === 7;
  }));

  // Per-feature property → a TAG attribute, matched BY NAME.
  const byProp = M.rasterizeFeatures(p.items, t, 6, 6, {
    kinds: allKinds, lineWidth: 1, value: { kind: 'property', key: 'cls' }, attr: tagAttr,
  });
  eq('property value: the tag indices, in first-use order', byProp.groupValues, [1, 2]);
  eq('  … nothing missing', byProp.featuresMissingValue, 0);
  eq('  … polygon cell → water(1)', cellValue(byProp, 1, 1), 1);
  eq('  … line cell → forest(2)', cellValue(byProp, 2, 3), 2);
  eq('  … point cell → water(1)', cellValue(byProp, 4, 4), 1);
  eq('  … nothing defaulted', byProp.badValues, 0);

  // Kind filtering.
  const polysOnly = M.rasterizeFeatures(p.items, t, 6, 6, {
    kinds: { point: false, line: false, polygon: true }, lineWidth: 1,
    value: { kind: 'fixed', value: 1 }, attr: intAttr,
  });
  eq('kind filter: only the polygon burns', covered(polysOnly), ['0,0', '1,0', '2,0', '0,1', '1,1', '2,1'].sort());
  eq('kind filter: the rest are counted', polysOnly.featuresFiltered, 2);
}
{
  // Overlap: the LAST feature wins, and the cell is counted ONCE.
  const p = M.parseGeoJson(fc(
    feat(poly([[0, 0], [3, 0], [3, 3], [0, 3], [0, 0]]), { v: 1 }),
    feat(poly([[1, 1], [3, 1], [3, 3], [1, 3], [1, 1]]), { v: 2 }),
  ));
  const res = M.rasterizeFeatures(p.items, identity(4), 4, 4, {
    kinds: allKinds, lineWidth: 1, value: { kind: 'property', key: 'v' }, attr: intAttr,
  });
  eq('overlap: the later feature wins', cellValue(res, 2, 2), 2);
  eq('overlap: the untouched part keeps the first value', cellValue(res, 0, 0), 1);
  eq('overlap: each cell counted once', res.cellCount, 9);
  const groups = M.collectRasterGroups(res);
  eq('collectRasterGroups: two groups', groups.map(g => g.value), [1, 2]);
  eq('collectRasterGroups: sizes sum to the cell count', groups.reduce((n, g) => n + g.cells.length, 0), 9);
  eq('collectRasterGroups: the 2×2 overlap belongs to value 2', [...groups[1].cells].sort((a, b) => a - b),
    [1 * 4 + 1, 1 * 4 + 2, 2 * 4 + 1, 2 * 4 + 2]);
}
{
  // A feature that covers nothing is REPORTED, never silent.
  const p = M.parseGeoJson(fc(
    feat({ type: 'Point', coordinates: [99, 99] }),
    feat({ type: 'Point', coordinates: [1.5, 1.5] }),
  ));
  const res = M.rasterizeFeatures(p.items, identity(4), 4, 4, {
    kinds: allKinds, lineWidth: 1, value: { kind: 'fixed', value: 3 }, attr: intAttr,
  });
  eq('a feature outside the grid is counted', [res.featuresUsed, res.featuresOutside, res.cellCount], [2, 1, 1]);
}
{
  // Missing / unparseable property values fall back to the DEFAULT and are counted.
  const p = M.parseGeoJson(fc(
    feat({ type: 'Point', coordinates: [0.5, 0.5] }, { cls: 'water' }),
    feat({ type: 'Point', coordinates: [1.5, 0.5] }, { cls: 'nonsense' }),
    feat({ type: 'Point', coordinates: [2.5, 0.5] }, {}),
  ));
  const res = M.rasterizeFeatures(p.items, identity(4), 4, 4, {
    kinds: allKinds, lineWidth: 1, value: { kind: 'property', key: 'cls' }, attr: tagAttr,
  });
  eq('a bad property value defaults', cellValue(res, 1, 0), 0);
  eq('a missing property defaults', cellValue(res, 2, 0), 0);
  eq('a good one is decoded', cellValue(res, 0, 0), 1);
  eq('only the PRESENT-but-bad value counts as bad', res.badValues, 1);
  eq('the ABSENT one is counted separately', res.featuresMissingValue, 1);
  eq('the issue names the feature and the key', [res.issues[0].row, res.issues[0].column, res.issues[0].raw], [2, 'cls', 'nonsense']);
  eq('… and only that one is listed', res.issues.length, 1);
}
{
  // Property decode per type — the numeric/boolean/string arms.
  eq('number → integer rounds', M.decodeGeoJsonProperty(intAttr, 2.7), { value: 3, ok: true });
  eq('number → float is exact', M.decodeGeoJsonProperty(floatAttr, 0.1), { value: 0.1, ok: true });
  eq('number → bool is NONZERO (the raster convention)', M.decodeGeoJsonProperty(boolAttr, 5), { value: 1, ok: true });
  eq('number → tag is the INDEX', M.decodeGeoJsonProperty(tagAttr, 2), { value: 2, ok: true });
  eq('number → tag out of range defaults', M.decodeGeoJsonProperty(tagAttr, 9), { value: 0, ok: false });
  eq('string → tag matches by NAME, case-insensitively', M.decodeGeoJsonProperty(tagAttr, 'FOREST'), { value: 2, ok: true });
  eq('boolean true', M.decodeGeoJsonProperty(boolAttr, true), { value: 1, ok: true });
  eq('boolean false', M.decodeGeoJsonProperty(boolAttr, false), { value: 0, ok: true });
  eq('null defaults', M.decodeGeoJsonProperty(intAttr, null), { value: 0, ok: false });
  eq('an object defaults', M.decodeGeoJsonProperty(intAttr, { a: 1 }), { value: 0, ok: false });
  eq('a numeric STRING still parses', M.decodeGeoJsonProperty(floatAttr, ' 4.25 '), { value: 4.25, ok: true });
}
{
  // The world transform end to end: a polygon given in world coordinates must
  // land on exactly the cells its extent covers, WITH the row flip.
  const georef = { xllcorner: 1000, yllcorner: 2000, cellSize: 10 };
  const t = M.makeCellTransform(georef, 5, 'world');
  // World box x 1010..1040, y 2020..2040 → cols 1..3, and rows: y 2020 is
  // 2 cells up from the bottom of a 5-row grid → rows 1..2.
  const p = M.parseGeoJson(JSON.stringify(poly([[1010, 2020], [1040, 2020], [1040, 2040], [1010, 2040], [1010, 2020]])));
  const res = M.rasterizeFeatures(p.items, t, 5, 5, {
    kinds: allKinds, lineWidth: 1, value: { kind: 'fixed', value: 1 }, attr: intAttr,
  });
  eq('a world-coordinate polygon lands on the flipped rows', covered(res),
    ['1,1', '2,1', '3,1', '1,2', '2,2', '3,2'].sort());
}

// ---------------------------------------------------------------------------
console.log('\n[6] points → agents');
// ---------------------------------------------------------------------------
const agentAttrs = [
  { id: 'energy', name: 'Energy', type: 'float', defaultValue: '0' },
  { id: 'species', name: 'Species', type: 'tag', defaultValue: '0', tagOptions: ['red', 'green', 'blue'] },
  { id: 'alive', name: 'Alive', type: 'bool', defaultValue: 'false' },
  { id: 'facing', name: 'Facing', type: 'vector', vectorDims: 2, defaultValue: '0' },
];
{
  const keys = ['Energy', 'Species', 'Alive', 'radius', 'Facing.x', 'Facing.y', 'x', 'unrelated'];
  const map = M.autoMapGeoJsonProperties(keys, agentAttrs, false);
  eq('auto-map: attribute names, geometry aliases and vector components',
    map, ['attr:energy', 'attr:species', 'attr:alive', 'geom:radius', 'vec:facing:0', 'vec:facing:1', 'ignore', 'ignore']);
  const opts = M.geoJsonAgentTargetOptions(agentAttrs, false).map(o => o.key);
  check('x / y are NOT offered (they come from the geometry)', !opts.includes('geom:x') && !opts.includes('geom:y'));
  check('the other geometry targets ARE offered', opts.includes('geom:vx') && opts.includes('geom:radius'));
  check('3D adds z / vz', M.geoJsonAgentTargetOptions(agentAttrs, true).map(o => o.key).includes('geom:z'));
}
{
  const georef = { xllcorner: 0, yllcorner: 0, cellSize: 10 };
  const t = M.makeCellTransform(georef, 10, 'world');   // 10 rows, 10 m cells
  const p = M.parseGeoJson(fc(
    feat({ type: 'Point', coordinates: [25, 95] }, { Energy: 3.5, Species: 'blue', Alive: true, radius: 1.5, 'Facing.x': 1, 'Facing.y': -1 }),
    feat({ type: 'Point', coordinates: [5, 5] }, { Energy: 'oops', Species: 7 }),
    feat({ type: 'LineString', coordinates: [[0, 0], [1, 1]] }),
    feat({ type: 'Point', coordinates: [-50, 50] }, {}),
  ));
  const keys = p.propertyKeys;
  const targets = M.autoMapGeoJsonProperties(keys, agentAttrs, false);
  const b = M.buildGeoJsonAgents(p.items, t, keys, targets, agentAttrs, { w: 10, h: 10, d: 1 }, false);
  eq('3 points became 3 agents', b.agents.length, 3);
  eq('the line was skipped as a non-point', b.skippedNonPoint, 1);
  // (25, 95) with a 10 m cell over 10 rows → ax 2.5, ay = 10 − 9.5 = 0.5.
  eq('position comes from the GEOMETRY, flipped', [b.agents[0].x, b.agents[0].y], [2.5, 0.5]);
  eq('radius from a property', b.agents[0].radius, 1.5);
  const sets0 = Object.fromEntries(b.agents[0].sets.map(s => [s.attrId, s.value]));
  eq('float property', sets0.energy, 3.5);
  eq('tag property by NAME', sets0.species, 2);
  eq('boolean property', sets0.alive, 1);
  eq('vector components land on the component ids', [sets0.facing_vx, sets0.facing_vy], [1, -1]);
  const sets1 = Object.fromEntries(b.agents[1].sets.map(s => [s.attrId, s.value]));
  eq('an unparseable property defaults', sets1.energy, 0);
  eq('an out-of-range tag index defaults', sets1.species, 0);
  eq('only PRESENT-but-bad values are counted', b.badValues, 2);
  check('a feature that lacks a key writes nothing for it', b.agents[1].sets.length === 2);
  check('a feature with NO properties at all writes nothing', b.agents[2].sets.length === 0);
  eq('the out-of-world point is counted', b.outOfBounds, 1);
  check('… but still produced an agent (the worker wraps/clamps)', b.agents.length === 3);
}
{
  // A property NAMED "x" must NOT override the geometry.
  const t = identity(10);
  const p = M.parseGeoJson(fc(feat({ type: 'Point', coordinates: [3.5, 4.5] }, { x: 999, y: 999 })));
  const keys = p.propertyKeys;
  const targets = M.autoMapGeoJsonProperties(keys, agentAttrs, false);
  eq('an "x" property auto-maps to ignore', targets, ['ignore', 'ignore']);
  const b = M.buildGeoJsonAgents(p.items, t, keys, targets, agentAttrs, { w: 10, h: 10, d: 1 }, false);
  eq('the geometry still decides the position', [b.agents[0].x, b.agents[0].y], [3.5, 4.5]);
}
{
  // 3D: z comes from a mapped PROPERTY (the 3rd coordinate is altitude, ignored).
  const t = identity(10);
  const p = M.parseGeoJson(fc(feat({ type: 'Point', coordinates: [1.5, 2.5, 777] }, { layer: 4 })));
  const b = M.buildGeoJsonAgents(p.items, t, ['layer'], ['geom:z'], agentAttrs, { w: 10, h: 10, d: 8 }, true);
  eq('3D: z from the property, altitude ignored', [b.agents[0].x, b.agents[0].y, b.agents[0].z], [1.5, 2.5, 4]);
  const b2 = M.buildGeoJsonAgents(p.items, t, ['layer'], ['ignore'], agentAttrs, { w: 10, h: 10, d: 8 }, true);
  eq('3D: an unmapped z defaults to 0', b2.agents[0].z, 0);
  const b3 = M.buildGeoJsonAgents(p.items, t, ['layer'], ['geom:z'], agentAttrs, { w: 10, h: 10, d: 3 }, true);
  eq('3D: a z past the depth is out of bounds', b3.outOfBounds, 1);
}
{
  const b = M.buildGeoJsonAgents([], identity(4), [], [], agentAttrs, { w: 4, h: 4, d: 1 }, false);
  eq('an empty feature list builds nothing', [b.agents.length, b.badValues], [0, 0]);
}

// ---------------------------------------------------------------------------
console.log('\n[7] batching contract');
// ---------------------------------------------------------------------------
{
  check('the paint chunk is a positive integer', Number.isInteger(M.GEOJSON_PAINT_CHUNK) && M.GEOJSON_PAINT_CHUNK > 0);
  // A full-grid burn: every cell covered, one group, and the index→(row,col)
  // decode the caller performs must reproduce the grid exactly.
  const p = M.parseGeoJson(JSON.stringify(poly([[0, 0], [8, 0], [8, 5], [0, 5], [0, 0]])));
  const res = M.rasterizeFeatures(p.items, identity(5), 8, 5, {
    kinds: allKinds, lineWidth: 1, value: { kind: 'fixed', value: 4 }, attr: intAttr,
  });
  eq('a grid-covering polygon covers every cell', res.cellCount, 40);
  const groups = M.collectRasterGroups(res);
  eq('one group of 40', [groups.length, groups[0].cells.length], [1, 40]);
  const seen = new Set();
  for (const idx of groups[0].cells) seen.add(`${idx % 8},${Math.floor(idx / 8)}`);
  eq('the index decode reproduces every cell exactly', seen.size, 40);
  check('  … and the corners are right', seen.has('0,0') && seen.has('7,4'));
  eq('an empty result yields no groups', M.collectRasterGroups(M.rasterizeFeatures([], identity(4), 4, 4, {
    kinds: allKinds, lineWidth: 1, value: { kind: 'fixed', value: 1 }, attr: intAttr,
  })).length, 0);
}

// ---------------------------------------------------------------------------
rmSync(entryPath, { force: true });
rmSync(dir, { recursive: true, force: true });
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);

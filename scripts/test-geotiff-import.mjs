// GeoTIFF import verification.
//
// Same discipline as scripts/test-asc-import.mjs: this asserts VALUES, not "it
// parsed". A georeferenced raster is a scientific artefact — the number in the
// file must be the number in the store (or be reported as defaulted), and the
// georeference must survive the TOP-LEFT → LOWER-LEFT convention change intact.
//
// The fixtures are REAL GeoTIFFs, written here with geotiff.js's own
// `writeArrayBuffer` and read back through the shipped `openGeoTiff` — so the
// tag parsing, the band read and the georef conversion are all exercised end to
// end, in Node, with no browser.
//
// Run from the repo root:  node scripts/test-geotiff-import.mjs
import { build } from 'esbuild';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = `export * from '../src/simulator/geotiffImport.ts';\n`;
const dir = mkdtempSync(join(tmpdir(), 'gca-gtiff-'));
const entryPath = join(ROOT, 'scripts', '__geotiff_entry.ts');
writeFileSync(entryPath, ENTRY);
const outPath = join(dir, 'bundle.mjs');
await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: ROOT });
const M = await import(pathToFileURL(outPath).href);
const { writeArrayBuffer } = await import('geotiff');

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ok  ${name}`);
  else { console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); failures++; }
};
const eq = (name, actual, expected) => check(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
const near = (name, a, b, tol = 1e-9) => check(name, Math.abs(a - b) <= tol, `got ${a} want ${b}`);

const intAttr = { id: 'v', type: 'integer', defaultValue: '0' };
const floatAttr = { id: 'f', type: 'float', defaultValue: '0' };
const boolAttr = { id: 'b', type: 'bool', defaultValue: 'false' };
const tagAttr = { id: 't', type: 'tag', defaultValue: '0', tagOptions: ['empty', 'wire', 'head'] };

/** Write a single-band GeoTIFF with a known georeference. `values` is row-major. */
function makeTiff(values, width, height, opts = {}) {
  const meta = {
    width, height,
    // 30 m cells; the GeoTIFF tiepoint states the TOP-LEFT corner.
    ModelPixelScale: [opts.scaleX ?? 30, opts.scaleY ?? 30, 0],
    ModelTiepoint: [0, 0, 0, opts.originX ?? 500000, opts.originY ?? 4600000, 0],
    ProjectedCSTypeGeoKey: opts.epsg ?? 32611,
    GTModelTypeGeoKey: 1,
    BitsPerSample: [32],
    SampleFormat: [3],
    ...(opts.noData !== undefined ? { GDAL_NODATA: String(opts.noData) } : {}),
  };
  return writeArrayBuffer(Float32Array.from(values), meta);
}

// ---------------------------------------------------------------------------
console.log('\n[1] resampleNearest (pure)');
// ---------------------------------------------------------------------------
{
  // 4x4 counting up, so every sampled index is identifiable.
  const src = Array.from({ length: 16 }, (_, i) => i);
  // Identity — the documented EXACT fast path.
  eq('identity 4x4 → 4x4', Array.from(M.resampleNearest(src, 4, 4, 4, 4)), src);
  // 2x downsample: centre sampling picks source index floor((d+0.5)*4/2) = 2d+1
  // → columns 1,3 and rows 1,3 → values [5,7,13,15].
  eq('4x4 → 2x2 (centre sampling)', Array.from(M.resampleNearest(src, 4, 4, 2, 2)), [5, 7, 13, 15]);
  // 2x upsample of a 2x2: every source cell repeats in a 2x2 block.
  eq('2x2 → 4x4 (upsample repeats)', Array.from(M.resampleNearest([1, 2, 3, 4], 2, 2, 4, 4)),
    [1, 1, 2, 2, 1, 1, 2, 2, 3, 3, 4, 4, 3, 3, 4, 4]);
  // Non-square change: 4x2 → 2x4.
  eq('4x2 → 2x4', Array.from(M.resampleNearest([0, 1, 2, 3, 4, 5, 6, 7], 4, 2, 2, 4)),
    [1, 3, 1, 3, 5, 7, 5, 7]);
  // 3 → 2 (a ratio that is not a whole number): floor((0.5)*3/2)=0, floor((1.5)*3/2)=2.
  eq('3x1 → 2x1', Array.from(M.resampleNearest([10, 20, 30], 3, 1, 2, 1)), [10, 30]);
  eq('degenerate destination is empty', Array.from(M.resampleNearest(src, 4, 4, 0, 4)), []);
  check('result is Float64Array', M.resampleNearest(src, 4, 4, 2, 2) instanceof Float64Array);
}

// ---------------------------------------------------------------------------
console.log('\n[2] decodeNumericValue (pure)');
// ---------------------------------------------------------------------------
{
  eq('integer rounds', [M.decodeNumericValue(intAttr, 2.7), M.decodeNumericValue(intAttr, -1.4)],
    [{ value: 3, ok: true }, { value: -1, ok: true }]);
  eq('float passes through', M.decodeNumericValue(floatAttr, 0.125), { value: 0.125, ok: true });
  eq('bool: 0 is false', M.decodeNumericValue(boolAttr, 0), { value: 0, ok: true });
  eq('bool: nonzero is true', M.decodeNumericValue(boolAttr, 7), { value: 1, ok: true });
  eq('bool: a negative is true', M.decodeNumericValue(boolAttr, -3), { value: 1, ok: true });
  eq('tag in range', M.decodeNumericValue(tagAttr, 2), { value: 2, ok: true });
  eq('tag out of range → default, not ok', M.decodeNumericValue(tagAttr, 5), { value: 0, ok: false });
  eq('tag rounds', M.decodeNumericValue(tagAttr, 1.4), { value: 1, ok: true });
  eq('NaN → default, not ok', M.decodeNumericValue(floatAttr, NaN), { value: 0, ok: false });
  eq('Infinity → default, not ok', M.decodeNumericValue(intAttr, Infinity), { value: 0, ok: false });
  eq('a colour attribute is not a per-cell scalar', M.decodeNumericValue({ id: 'c', type: 'color' }, 1).ok, false);
}

// ---------------------------------------------------------------------------
console.log('\n[3] georefFromGeoTiff (pure) — the TOP-LEFT → LOWER-LEFT flip');
// ---------------------------------------------------------------------------
{
  // 10 rows of 30 m from a top edge at y=4600000 → the bottom edge is 300 lower.
  const g = M.georefFromGeoTiff({ origin: [500000, 4600000], resolution: [30, -30], width: 8, height: 10 });
  eq('origin + cell size', [g.georef.xllcorner, g.georef.yllcorner, g.georef.cellSize], [500000, 4599700, 30]);
  check('a square-pixel file raises no warning', g.nonSquareWarning === undefined);

  // A POSITIVE yres means the origin is already the BOTTOM — no subtraction.
  const up = M.georefFromGeoTiff({ origin: [0, 100], resolution: [10, 10], width: 4, height: 4 });
  eq('positive yres keeps the origin', [up.georef.xllcorner, up.georef.yllcorner], [0, 100]);

  const ns = M.georefFromGeoTiff({ origin: [0, 0], resolution: [30, -20], width: 2, height: 2 });
  check('non-square pixels warn', typeof ns.nonSquareWarning === 'string' && ns.nonSquareWarning.includes('30'));
  eq('non-square uses |xres| as the cell size', ns.georef.cellSize, 30);

  check('no resolution → no georef', M.georefFromGeoTiff({ origin: [0, 0], resolution: null, width: 2, height: 2 }).georef === null);
  check('zero resolution → no georef', M.georefFromGeoTiff({ origin: [0, 0], resolution: [0, 0], width: 2, height: 2 }).georef === null);
  eq('crs rides along', M.georefFromGeoTiff({ origin: [0, 100], resolution: [1, -1], width: 1, height: 1, crs: 'EPSG:3857' }).georef.crs, 'EPSG:3857');
}

// ---------------------------------------------------------------------------
console.log('\n[4] crsFromGeoKeys + scaleGeorefForResample (pure)');
// ---------------------------------------------------------------------------
{
  eq('projected wins', M.crsFromGeoKeys({ ProjectedCSTypeGeoKey: 32611, GeographicTypeGeoKey: 4326 }), 'EPSG:32611');
  eq('geographic when there is no projected key', M.crsFromGeoKeys({ GeographicTypeGeoKey: 4326 }), 'EPSG:4326');
  eq('an array value is unwrapped', M.crsFromGeoKeys({ ProjectedCSTypeGeoKey: [32633] }), 'EPSG:32633');
  eq('32767 (user-defined) names nothing', M.crsFromGeoKeys({ ProjectedCSTypeGeoKey: 32767 }), null);
  eq('no keys → null', M.crsFromGeoKeys(null), null);

  const base = { xllcorner: 100, yllcorner: 200, cellSize: 30 };
  const same = M.scaleGeorefForResample(base, 8, 8, 8, 8);
  eq('same dims → unchanged', same.georef, base);
  // 8 cells of 30 m = 240 m of ground; on 4 cells that is 60 m each.
  const half = M.scaleGeorefForResample(base, 8, 8, 4, 4);
  eq('halving the grid doubles the cell size', [half.georef.cellSize, half.georef.xllcorner, half.georef.yllcorner], [60, 100, 200]);
  check('a matched aspect raises no warning', half.aspectWarning === undefined);
  const skew = M.scaleGeorefForResample(base, 8, 8, 4, 8);
  check('a changed aspect warns', typeof skew.aspectWarning === 'string');
  near('the extent is preserved on X', half.georef.cellSize * 4, base.cellSize * 8);
}

// ---------------------------------------------------------------------------
console.log('\n[5] distinctValues + autoSeedValueMap (pure)');
// ---------------------------------------------------------------------------
{
  const d = M.distinctValues([1, 1, 1, 2, 2, 0, NaN]);
  eq('counts, most frequent first', d.values, [{ value: 1, count: 3 }, { value: 2, count: 2 }, { value: 0, count: 1 }]);
  check('non-finite samples are skipped', d.truncated === false);
  const many = M.distinctValues(Array.from({ length: 200 }, (_, i) => i), 8);
  check('past the cap it reports truncated', many.truncated === true && many.values.length === 8);

  eq('tag: in-range codes seed to themselves', M.autoSeedValueMap([0, 1, 2], tagAttr), { 0: '0', 1: '1', 2: '2' });
  eq('tag: an out-of-range code is left unmapped', M.autoSeedValueMap([0, 9], tagAttr), { 0: '0' });
  eq('tag: a fractional code is left unmapped', M.autoSeedValueMap([1.5], tagAttr), {});
  eq('bool: 0 false, anything else true', M.autoSeedValueMap([0, 5], boolAttr), { 0: 'false', 5: 'true' });
  eq('numeric: identity', M.autoSeedValueMap([3, -2], intAttr), { 3: '3', '-2': '-2' });
}

// ---------------------------------------------------------------------------
console.log('\n[6] buildBandValues (pure) — resample, NODATA, value map');
// ---------------------------------------------------------------------------
{
  const band = [1, 2, 3, 4];
  eq('identity build', Array.from(M.buildBandValues(band, 2, 2, 2, 2, intAttr).values), [1, 2, 3, 4]);

  const nd = M.buildBandValues([1, -9999, 3, 4], 2, 2, 2, 2, intAttr, { noData: -9999 });
  eq('NODATA takes the default', Array.from(nd.values), [1, 0, 3, 4]);
  eq('…and is counted separately', [nd.nodataCells, nd.badValues], [1, 0]);

  // A tag band carrying an out-of-range code, with no value map.
  const t = M.buildBandValues([0, 1, 2, 7], 2, 2, 2, 2, tagAttr);
  eq('tag codes decode by index', Array.from(t.values), [0, 1, 2, 0]);
  eq('the out-of-range code is reported', t.badValues, 1);

  // The Cell2Fire code→class table: the raster's own codes, remapped.
  const vm = M.buildBandValues([101, 102, 101, 999], 2, 2, 2, 2, tagAttr, { valueMap: { 101: '1', 102: '2' } });
  eq('mapped codes land on their options', Array.from(vm.values), [1, 2, 1, 0]);
  eq('an unmapped code is reported ONCE, per value', [vm.badValues, vm.unmappedValues], [1, [999]]);

  // Resample + NODATA together: the sampling happens on the RAW values, so the
  // NODATA sentinel survives the resize and is still recognised.
  const rs = M.buildBandValues([1, -9999, -9999, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
    4, 4, 2, 2, intAttr, { noData: -9999 });
  eq('resampled values', Array.from(rs.values), [6, 8, 14, 16]);
  eq('this sample misses the NODATA cells', rs.nodataCells, 0);
  const rs2 = M.buildBandValues([1, 2, 3, 4, 5, -9999, 7, -9999, 9, 10, 11, 12, 13, 14, 15, 16],
    4, 4, 2, 2, intAttr, { noData: -9999 });
  eq('a sampled NODATA cell still defaults', Array.from(rs2.values), [0, 0, 14, 16]);
  eq('…and is counted', rs2.nodataCells, 2);

  const b = M.buildBandValues([0, 3, 0, -2], 2, 2, 2, 2, boolAttr);
  eq('bool: nonzero is true', Array.from(b.values), [0, 1, 0, 1]);
}

// ---------------------------------------------------------------------------
console.log('\n[7] openGeoTiff on a REAL file (written by geotiff.js)');
// ---------------------------------------------------------------------------
{
  // 4 wide x 3 tall, values 0..11 row-major, one NODATA cell.
  const values = [0, 1, 2, 3, 4, -9999, 6, 7, 8, 9, 10, 11];
  const buf = makeTiff(values, 4, 3, { noData: -9999, originX: 500000, originY: 4600000, scaleX: 30, scaleY: 30 });
  const f = await M.openGeoTiff(buf);
  eq('dimensions', [f.width, f.height], [4, 3]);
  eq('band count', f.bandCount, 1);
  eq('band type label', f.bands[0].typeLabel, 'Float32');
  eq('GDAL_NODATA is read', f.noData, -9999);
  eq('CRS from the geo keys', f.georef.crs, 'EPSG:32611');
  // 3 rows of 30 m below a top edge at 4600000.
  eq('georef (lower-left corner + cell size)',
    [f.georef.xllcorner, f.georef.yllcorner, f.georef.cellSize], [500000, 4599910, 30]);

  const band = await f.readBand(0);
  eq('band values are EXACT, row-major', Array.from(band), values);
  check('a re-read is served from the cache', (await f.readBand(0)) === band);

  // End to end into the store's numeric form.
  const built = M.buildBandValues(band, f.width, f.height, f.width, f.height, intAttr, { noData: f.noData });
  eq('imported values', Array.from(built.values), [0, 1, 2, 3, 4, 0, 6, 7, 8, 9, 10, 11]);
  eq('the NODATA cell is counted, not "bad"', [built.nodataCells, built.badValues], [1, 0]);
}

// ---------------------------------------------------------------------------
console.log('\n[8] openGeoTiff — integer band, a geographic CRS, no NODATA');
// ---------------------------------------------------------------------------
{
  const values = [1, 0, 2, 1, 1, 2];
  // NB geotiff.js's WRITER only encodes Float64/Float32/Uint32/Uint16/Uint8 —
  // an Int16Array silently writes garbage, so the integer fixture is unsigned.
  const buf = writeArrayBuffer(Uint16Array.from(values), {
    width: 3, height: 2,
    // 0.5° cells from (-10, 50) — the degrees case the georef precision rule cares about.
    ModelPixelScale: [0.5, 0.5, 0],
    ModelTiepoint: [0, 0, 0, -10, 50, 0],
    GeographicTypeGeoKey: 4326,
    GTModelTypeGeoKey: 2,
    BitsPerSample: [16],
    SampleFormat: [1],
  });
  const f = await M.openGeoTiff(buf);
  eq('dimensions', [f.width, f.height], [3, 2]);
  eq('band type label', f.bands[0].typeLabel, 'UInt16');
  check('no NODATA tag → null', f.noData === null);
  eq('geographic CRS', f.georef.crs, 'EPSG:4326');
  eq('degree-scale georef', [f.georef.xllcorner, f.georef.yllcorner, f.georef.cellSize], [-10, 49, 0.5]);
  const band = await f.readBand(0);
  eq('int band values are exact', Array.from(band), values);
  // A tag attribute reads the codes as option indices with no mapping at all.
  eq('tag decode', Array.from(M.buildBandValues(band, 3, 2, 3, 2, tagAttr).values), values);
}

// ---------------------------------------------------------------------------
console.log('\n[9] openGeoTiff — multi-band');
// ---------------------------------------------------------------------------
{
  // CHUNKY (interleaved) samples — pixel-major, band-minor — as a FLAT typed
  // array. NB geotiff.js's writer mis-sizes the strip for a plain nested
  // `[h][w][band]` array (it assumes 8 bytes per element for a non-typed array),
  // so the fixture uses the typed form the reader then de-interleaves correctly.
  const flat = Uint8Array.from([10, 100, 11, 101, 12, 102, 13, 103]);
  let f = null;
  try {
    const buf = writeArrayBuffer(flat, {
      width: 2, height: 2,
      ModelPixelScale: [1, 1, 0],
      ModelTiepoint: [0, 0, 0, 0, 2, 0],
      ProjectedCSTypeGeoKey: 32611,
      GTModelTypeGeoKey: 1,
      BitsPerSample: [8, 8],
      SampleFormat: [1, 1],
      SamplesPerPixel: [2],
      PhotometricInterpretation: 1,
    });
    f = await M.openGeoTiff(buf);
  } catch (err) {
    check('multi-band fixture written', false, String(err));
  }
  if (f) {
    eq('two bands are reported', f.bandCount, 2);
    eq('two bands are offered', f.bands.length, 2);
    eq('band 1 values', Array.from(await f.readBand(0)), [10, 11, 12, 13]);
    eq('band 2 values', Array.from(await f.readBand(1)), [100, 101, 102, 103]);
    // The two bands land in DIFFERENT attributes, each exact — the whole point
    // of the multi-band mapping UI.
    eq('band 1 → integer attribute', Array.from(M.buildBandValues(await f.readBand(0), 2, 2, 2, 2, intAttr).values), [10, 11, 12, 13]);
    eq('band 2 → float attribute', Array.from(M.buildBandValues(await f.readBand(1), 2, 2, 2, 2, floatAttr).values), [100, 101, 102, 103]);
  }
}

// ---------------------------------------------------------------------------
console.log('\n[10] openGeoTiff — the caps and the failure modes');
// ---------------------------------------------------------------------------
{
  let msg = '';
  try { await M.openGeoTiff(new ArrayBuffer(64)); } catch (err) { msg = String(err); }
  check('a non-GeoTIFF throws', msg.length > 0, msg);

  check('GEOTIFF_MAX_DIM is stated', M.GEOTIFF_MAX_DIM === 8192);
  check('GEOTIFF_MAX_PIXELS is stated', M.GEOTIFF_MAX_PIXELS === 16777216);
  check('GEOTIFF_MAX_BANDS is stated', M.GEOTIFF_MAX_BANDS === 16);
  check('GEOTIFF_SUPPORTED is true in the app build', M.GEOTIFF_SUPPORTED === true);
}

// ---------------------------------------------------------------------------
console.log('\n[11] the full path: file → resample onto a smaller grid');
// ---------------------------------------------------------------------------
{
  // 4x4 of known values on 30 m cells, imported onto a 2x2 model grid.
  const values = Array.from({ length: 16 }, (_, i) => i);
  const buf = makeTiff(values, 4, 4, { originX: 1000, originY: 2000, scaleX: 30, scaleY: 30 });
  const f = await M.openGeoTiff(buf);
  eq('source georef', [f.georef.xllcorner, f.georef.yllcorner, f.georef.cellSize], [1000, 1880, 30]);
  const band = await f.readBand(0);
  const built = M.buildBandValues(band, f.width, f.height, 2, 2, intAttr, { noData: f.noData });
  eq('resampled onto the grid', Array.from(built.values), [5, 7, 13, 15]);
  const scaled = M.scaleGeorefForResample(f.georef, f.width, f.height, 2, 2);
  eq('the cell size follows the resample', scaled.georef.cellSize, 60);
  near('the ground extent is unchanged', scaled.georef.cellSize * 2, f.georef.cellSize * 4);
  eq('the lower-left corner is unchanged', [scaled.georef.xllcorner, scaled.georef.yllcorner], [1000, 1880]);
  eq('the CRS survives the resample', scaled.georef.crs, 'EPSG:32611');
}

rmSync(entryPath, { force: true });
rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\nAll GeoTIFF checks passed.' : `\n${failures} CHECK(S) FAILED.`);
process.exit(failures === 0 ? 0 : 1);

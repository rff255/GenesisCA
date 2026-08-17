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

// ---------------------------------------------------------------------------
console.log('\n[12] the crop window (pure)');
// ---------------------------------------------------------------------------
{
  eq('clampWindow keeps an in-range window', M.clampWindow({ x: 2, y: 3, width: 4, height: 5 }, 20, 20), { x: 2, y: 3, width: 4, height: 5 });
  eq('clampWindow trims an overhang', M.clampWindow({ x: 18, y: 18, width: 10, height: 10 }, 20, 20), { x: 18, y: 18, width: 2, height: 2 });
  eq('clampWindow floors a negative origin', M.clampWindow({ x: -5, y: -5, width: 4, height: 4 }, 20, 20), { x: 0, y: 0, width: 4, height: 4 });
  eq('clampWindow keeps at least one pixel', M.clampWindow({ x: 5, y: 5, width: 0, height: -3 }, 20, 20), { x: 5, y: 5, width: 1, height: 1 });
  eq('clampWindow rounds fractional drag coordinates', M.clampWindow({ x: 2.4, y: 3.6, width: 4.5, height: 4.2 }, 20, 20), { x: 2, y: 4, width: 5, height: 4 });

  // A source that FITS opens on the whole image — the historical behaviour.
  eq('defaultWindow on a small raster is the whole image', M.defaultWindow(300, 200), { x: 0, y: 0, width: 300, height: 200 });
  // …and one that does NOT opens on a centred, cap-shaped box rather than an error.
  const big = M.defaultWindow(40000, 30000);
  check('defaultWindow caps a huge raster', big.width <= M.GEOTIFF_MAX_DIM && big.height <= M.GEOTIFF_MAX_DIM
    && big.width * big.height <= M.GEOTIFF_MAX_PIXELS, JSON.stringify(big));
  check('defaultWindow is centred', Math.abs(big.x - (40000 - big.width) / 2) <= 1 && Math.abs(big.y - (30000 - big.height) / 2) <= 1, JSON.stringify(big));
  // The per-axis cap is an axis-INDEPENDENT clamp, so it cannot preserve the
  // aspect; when only the PIXEL cap binds, the uniform shrink does.
  const pixelOnly = M.defaultWindow(8000, 6000);
  near('defaultWindow keeps the aspect when only the pixel cap binds', pixelOnly.width / pixelOnly.height, 8000 / 6000, 0.01);
  check('…and lands under the pixel cap', pixelOnly.width * pixelOnly.height <= M.GEOTIFF_MAX_PIXELS, `${pixelOnly.width}x${pixelOnly.height}`);
  // A very WIDE source: the per-axis cap bites, the pixel cap does not.
  const wide = M.defaultWindow(90000, 200);
  eq('defaultWindow clamps a very wide raster per axis, keeping every row', [wide.width, wide.height], [M.GEOTIFF_MAX_DIM, 200]);

  check('windowCapError passes a legal window', M.windowCapError({ x: 0, y: 0, width: 4096, height: 4096 }) === null);
  check('windowCapError refuses an over-wide window', typeof M.windowCapError({ x: 0, y: 0, width: 9000, height: 4 }) === 'string');
  check('windowCapError refuses an over-large window', typeof M.windowCapError({ x: 0, y: 0, width: 8000, height: 8000 }) === 'string');
}

// ---------------------------------------------------------------------------
console.log('\n[13] windowed reads — the enabler');
// ---------------------------------------------------------------------------
{
  // v = row*1000 + col, so every sample names its own position.
  const W = 40, H = 24;
  const vals = Array.from({ length: W * H }, (_, i) => Math.floor(i / W) * 1000 + (i % W));
  const buf = makeTiff(vals, W, H, { originX: 500000, originY: 4600000, scaleX: 30, scaleY: 30 });
  const f = await M.openGeoTiff(buf);
  eq('the source dims are reported', [f.width, f.height], [W, H]);

  const whole = await f.readBand(0);
  eq('an unwindowed read is still the whole band', whole.length, W * H);

  const win = { x: 5, y: 3, width: 7, height: 6 };
  const cropData = await f.readBand(0, win);
  eq('the windowed read has the window\'s length', cropData.length, win.width * win.height);
  let bad = 0;
  for (let r = 0; r < win.height; r++) {
    for (let c = 0; c < win.width; c++) {
      if (cropData[r * win.width + c] !== whole[(win.y + r) * W + (win.x + c)]) bad++;
    }
  }
  check('the windowed read IS the matching slice of the full read', bad === 0, `${bad} mismatches`);

  // The same window twice must come from the cache, not a second decode.
  check('a re-read of the same window is cached', (await f.readBand(0, win)) === cropData);
  // A different window must NOT be served the previous one.
  const other = await f.readBand(0, { x: 0, y: 0, width: 3, height: 2 });
  eq('a different window reads different data', Array.from(other), [0, 1, 2, 1000, 1001, 1002]);

  // NB an over-cap window is UNREACHABLE on a small raster — `clampWindow` trims
  // it into the source first. The cap only bites on a genuinely huge source; see
  // section [14].
  const clampedHuge = await f.readBand(0, { x: 0, y: 0, width: 9000, height: 9000 });
  eq('an oversized window is clamped into the raster, not refused', clampedHuge.length, W * H);

  // The preview is a whole-image thumbnail, decimated.
  const prev = await f.readPreview(0, 16);
  check('previewAvailable on a small raster', f.previewAvailable === true);
  check('readPreview honours maxEdge', !!prev && Math.max(prev.width, prev.height) <= 16, JSON.stringify(prev && [prev.width, prev.height]));
  check('readPreview keeps the aspect', !!prev && Math.abs(prev.width / prev.height - W / H) < 0.15, JSON.stringify(prev && [prev.width, prev.height]));
  check('readPreview returns one sample per preview pixel', !!prev && prev.data.length === prev.width * prev.height);
}

// ---------------------------------------------------------------------------
console.log('\n[14] a source LARGER than one import can read still opens');
// ---------------------------------------------------------------------------
{
  // 9000 wide — past GEOTIFF_MAX_DIM, which used to be an outright rejection.
  // Small in bytes (Uint8, 200 rows) so the fixture stays cheap.
  const W = 9000, H = 200;
  const flat = new Uint8Array(W * H);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) flat[r * W + c] = (r + c) % 251;
  const buf = writeArrayBuffer(flat, {
    width: W, height: H,
    ModelPixelScale: [10, 10, 0], ModelTiepoint: [0, 0, 0, 0, 2000, 0],
    ProjectedCSTypeGeoKey: 32611, GTModelTypeGeoKey: 1,
    BitsPerSample: [8], SampleFormat: [1],
  });
  const f = await M.openGeoTiff(buf);
  eq('a 9000-wide raster OPENS', [f.width, f.height], [W, H]);
  const dw = M.defaultWindow(W, H);
  check('the default crop is capped below the source width', dw.width === M.GEOTIFF_MAX_DIM && dw.width < W, JSON.stringify(dw));
  // …and asking for the FULL width is refused by the read rather than silently
  // truncated, because 9000 > GEOTIFF_MAX_DIM.
  let capMsg = '';
  try { await f.readBand(0, { x: 0, y: 0, width: W, height: H }); } catch (err) { capMsg = String(err); }
  check('an over-cap window read throws a named error', /crop/i.test(capMsg), capMsg);
  const win = { x: 8800, y: 50, width: 100, height: 20 };
  const data = await f.readBand(0, win);
  eq('a window near the far edge reads the right values',
    [data[0], data[1], data[100], data[data.length - 1]],
    [(50 + 8800) % 251, (50 + 8801) % 251, (51 + 8800) % 251, (69 + 8899) % 251]);
}

// ---------------------------------------------------------------------------
console.log('\n[15] shiftGeorefForWindow — the crop\'s own georeference');
// ---------------------------------------------------------------------------
{
  // A 40x24 raster at 30 m whose LOWER-LEFT corner is (500000, 4600000).
  const g = { xllcorner: 500000, yllcorner: 4600000, cellSize: 30, crs: 'EPSG:32611' };
  const srcH = 24;
  // The whole image is the identity.
  eq('the whole-image window is the identity',
    M.shiftGeorefForWindow(g, { x: 0, y: 0, width: 40, height: srcH }, srcH),
    g);
  // THE TOP rows: y = 0 keeps the top edge, so yll rises by the rows left below.
  //   yll' = 4600000 + (24 - 0 - 6)*30 = 4600000 + 540
  eq('a window on the TOP rows',
    M.shiftGeorefForWindow(g, { x: 0, y: 0, width: 40, height: 6 }, srcH),
    { xllcorner: 500000, yllcorner: 4600540, cellSize: 30, crs: 'EPSG:32611' });
  // THE BOTTOM rows: y = srcH - h leaves yll exactly where it was.
  eq('a window on the BOTTOM rows',
    M.shiftGeorefForWindow(g, { x: 0, y: srcH - 6, width: 40, height: 6 }, srcH),
    { xllcorner: 500000, yllcorner: 4600000, cellSize: 30, crs: 'EPSG:32611' });
  // An interior window, both axes:
  //   xll' = 500000 + 5*30 = 500150
  //   yll' = 4600000 + (24 - 3 - 6)*30 = 4600000 + 450
  eq('an interior window shifts both axes',
    M.shiftGeorefForWindow(g, { x: 5, y: 3, width: 7, height: 6 }, srcH),
    { xllcorner: 500150, yllcorner: 4600450, cellSize: 30, crs: 'EPSG:32611' });
  check('a crop never changes the cell size',
    M.shiftGeorefForWindow(g, { x: 5, y: 3, width: 7, height: 6 }, srcH).cellSize === 30);
}

// ---------------------------------------------------------------------------
console.log('\n[16] resampleAverage — hand-computed');
// ---------------------------------------------------------------------------
{
  // 4x4 counting up; a 2x2 average is the mean of each 2x2 quadrant.
  const src = Array.from({ length: 16 }, (_, i) => i);
  eq('a 4x4 → 2x2 box average', Array.from(M.resampleAverage(src, 4, 4, 2, 2)), [2.5, 4.5, 10.5, 12.5]);
  eq('identical dimensions are the identity', Array.from(M.resampleAverage(src, 4, 4, 4, 4)), src);
  // 4x1 → 2x1 : means of [0,1] and [2,3].
  eq('a 1-D average', Array.from(M.resampleAverage([0, 1, 2, 3], 4, 1, 2, 1)), [0.5, 2.5]);
  // Upsampling has an empty box — it must degrade to a sample, never NaN.
  eq('an upsample degrades to nearest, never NaN', Array.from(M.resampleAverage([1, 2], 2, 1, 4, 1)), [1, 1, 2, 2]);
  // NODATA is EXCLUDED from the mean…
  // Rows 0-1 are identical, so each top quadrant's mean is obvious by eye:
  //   TL {1,3,1,3} = 2   TR {X,5,X,5} = 5 with the sentinel excluded
  //   (folding -9999 in would give -4997.5, not 5).
  eq('NODATA is excluded from the mean',
    Array.from(M.resampleAverage([1, 3, -9999, 5, 1, 3, -9999, 5, 0, 0, 0, 0, 0, 0, 0, 0], 4, 4, 2, 2, -9999)),
    [2, 5, 0, 0]);
  // …and a box holding NOTHING but NODATA outputs the sentinel again, so the
  // caller's own NODATA handling still sees it.
  eq('an all-NODATA box stays NODATA',
    Array.from(M.resampleAverage([-9999, -9999, 4, 4, -9999, -9999, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4], 4, 4, 2, 2, -9999)),
    [-9999, 4, 4, 4]);
  // With no sentinel, an all-non-finite box is NaN — which every decode reports.
  check('an all-NaN box with no sentinel is NaN',
    Number.isNaN(M.resampleAverage([NaN, NaN, NaN, NaN], 2, 2, 1, 1)[0]));
  check('supportsAverageResample: numeric yes', M.supportsAverageResample(intAttr) && M.supportsAverageResample(floatAttr));
  check('supportsAverageResample: categorical no', !M.supportsAverageResample(tagAttr) && !M.supportsAverageResample(boolAttr));
}

// ---------------------------------------------------------------------------
console.log('\n[17] buildBandValues honours (and refuses) the method');
// ---------------------------------------------------------------------------
{
  const src = Array.from({ length: 16 }, (_, i) => i);
  // float target: the exact quadrant means survive.
  eq('average reaches a float target', Array.from(M.buildBandValues(src, 4, 4, 2, 2, floatAttr, { resample: 'average' }).values), [2.5, 4.5, 10.5, 12.5]);
  // integer target: averaged THEN rounded (resample → decode, as documented).
  eq('average then round on an integer target', Array.from(M.buildBandValues(src, 4, 4, 2, 2, intAttr, { resample: 'average' }).values), [3, 5, 11, 13]);
  eq('nearest stays the default', Array.from(M.buildBandValues(src, 4, 4, 2, 2, intAttr).values), [5, 7, 13, 15]);
  // A CATEGORICAL target is refused STRUCTURALLY — asking for average yields the
  // nearest result, so a class code can never be averaged into one that does not
  // exist. (Codes 0..2 are valid tag indices; 3.. are not, hence the defaults.)
  // EVERY fixture below is a DISCRIMINATOR: nearest and average give DIFFERENT
  // answers, so "ignores average" cannot pass by coincidence. Nearest samples
  // (row 1, col 1) of each 2x2 quadrant — see the centre-sampling rule.
  //   TL = {2,2,2,0}: nearest → 0, average → 1.5 → rounds to tag 2.
  const tagSrc = [2, 2, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  eq('a tag target ignores average', Array.from(M.buildBandValues(tagSrc, 4, 4, 2, 2, tagAttr, { resample: 'average' }).values), [0, 0, 0, 0]);
  check('…and the fixture really does discriminate',
    M.resampleAverage(tagSrc, 4, 4, 2, 2)[0] === 1.5 && M.resampleNearest(tagSrc, 4, 4, 2, 2)[0] === 0);
  //   TL = {1,0,0,0}: nearest → 0 (false), average → 0.25 → nonzero → true.
  const boolSrc = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  eq('a bool target ignores average', Array.from(M.buildBandValues(boolSrc, 4, 4, 2, 2, boolAttr, { resample: 'average' }).values), [0, 0, 0, 0]);
  check('…and the fixture really does discriminate', M.resampleAverage(boolSrc, 4, 4, 2, 2)[0] === 0.25);
  // A value MAP is a code table, so it is refused too.
  //   TR = {4,4,0,4}: nearest → 4 → mapped to tag 2; average → 3 → UNMAPPED.
  const mapSrc = [0, 0, 4, 4, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0];
  const mapped = M.buildBandValues(mapSrc, 4, 4, 2, 2, tagAttr, { resample: 'average', valueMap: { 0: '0', 4: '2' } });
  eq('a value map forces nearest', Array.from(mapped.values), [0, 2, 0, 0]);
  eq('…so nothing is reported unmapped', mapped.unmappedValues, []);
  // NODATA still excluded under average (the [16] fixture, through the decode).
  const nd = M.buildBandValues([1, 3, -9999, 5, 1, 3, -9999, 5, 0, 0, 0, 0, 0, 0, 0, 0], 4, 4, 2, 2, floatAttr,
    { resample: 'average', noData: -9999 });
  eq('average + NODATA', Array.from(nd.values), [2, 5, 0, 0]);
  eq('the NODATA count is still reported', nd.nodataCells, 0);
}

// ---------------------------------------------------------------------------
console.log('\n[18] crop THEN resample — the composed georeference');
// ---------------------------------------------------------------------------
{
  // 8x8 at 10 m, lower-left (1000, 5000). Crop the interior 4x4 at (2,2), then
  // resample that onto a 2x2 grid.
  const values = Array.from({ length: 64 }, (_, i) => i);
  const buf = makeTiff(values, 8, 8, { originX: 1000, originY: 5080, scaleX: 10, scaleY: 10 });
  const f = await M.openGeoTiff(buf);
  eq('the source georef', [f.georef.xllcorner, f.georef.yllcorner, f.georef.cellSize], [1000, 5000, 10]);

  const win = { x: 2, y: 2, width: 4, height: 4 };
  const data = await f.readBand(0, win);
  // Rows 2..5, cols 2..5 of an 8-wide counter.
  eq('the crop holds the right samples', Array.from(data.slice(0, 4)), [18, 19, 20, 21]);

  // Crop georef: xll = 1000 + 2*10 = 1020; yll = 5000 + (8-2-4)*10 = 5020.
  const cropG = M.shiftGeorefForWindow(f.georef, win, f.height);
  eq('the crop georef', [cropG.xllcorner, cropG.yllcorner, cropG.cellSize], [1020, 5020, 10]);
  // Then the resample: same extent, half the cells → double the cell size.
  const outG = M.scaleGeorefForResample(cropG, win.width, win.height, 2, 2).georef;
  eq('the composed georef', [outG.xllcorner, outG.yllcorner, outG.cellSize], [1020, 5020, 20]);
  near('the composed extent still covers the crop', outG.cellSize * 2, cropG.cellSize * win.width);

  // And the values: nearest over the cropped block.
  const built = M.buildBandValues(data, win.width, win.height, 2, 2, intAttr);
  eq('crop + resample values', Array.from(built.values), [27, 29, 43, 45]);
  // The same crop at native resolution is the identity.
  const native = M.buildBandValues(data, win.width, win.height, win.width, win.height, intAttr);
  eq('crop at native resolution is exact', Array.from(native.values), Array.from(data));
}

rmSync(entryPath, { force: true });
rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\nAll GeoTIFF checks passed.' : `\n${failures} CHECK(S) FAILED.`);
process.exit(failures === 0 ? 0 : 1);

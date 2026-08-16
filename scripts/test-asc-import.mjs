// Esri ASCII grid (.asc) import / export verification.
//
// Same discipline as scripts/test-csv-import.mjs: this asserts VALUES, not "it
// parsed". A georeferenced raster is a scientific artefact — the number in the
// file must be the number in the store (or be reported as defaulted), and the
// header must come back out in the same place it went in.
//
// Covers: header variants (corner vs centre origin, case, missing NODATA),
// body tokenisation (multi-space alignment, CRLF, BOM, a wrapped body), the
// declared-dims contract (short / long streams), NODATA → the attribute default
// counted separately, and the full export → parse → build ROUND TRIP for every
// per-cell attribute type.
//
// Run from the repo root:  node scripts/test-asc-import.mjs
import { build } from 'esbuild';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = `export * from '../src/simulator/csvImport.ts';\n`;
const dir = mkdtempSync(join(tmpdir(), 'gca-asc-'));
const entryPath = join(ROOT, 'scripts', '__asc_entry.ts');
writeFileSync(entryPath, ENTRY);
const outPath = join(dir, 'bundle.mjs');
await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: ROOT });
const M = await import(pathToFileURL(outPath).href);

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ok  ${name}`);
  else { console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); failures++; }
};
const eq = (name, actual, expected) => check(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);

const intAttr = { id: 'v', type: 'integer', defaultValue: '0' };
const floatAttr = { id: 'f', type: 'float', defaultValue: '0' };
const boolAttr = { id: 'b', type: 'bool', defaultValue: 'false' };
const tagAttr = { id: 't', type: 'tag', defaultValue: '0', tagOptions: ['empty', 'wire', 'head'] };

// ---------------------------------------------------------------------------
console.log('\n[1] detection');
// ---------------------------------------------------------------------------
check('a real .asc is detected', M.isAscGridText('ncols 2\nnrows 2\n1 2\n3 4') === true);
check('case-insensitive', M.isAscGridText('NCOLS 2\nNROWS 2\n1 2\n3 4') === true);
check('leading blank lines skipped', M.isAscGridText('\n\n  ncols 2\nnrows 1\n1 2') === true);
check('BOM tolerated', M.isAscGridText('﻿ncols 2\nnrows 1\n1 2') === true);
check('a CSV is NOT an .asc', M.isAscGridText('x,y\n1,2') === false);
check('an ASCII board is NOT an .asc', M.isAscGridText('.O.\n..O\nOOO') === false);
check('empty text is NOT an .asc', M.isAscGridText('') === false);
check('parseAscGrid returns null for a CSV', M.parseAscGrid('x,y\n1,2') === null);
check('parseAscGrid returns null without ncols/nrows', M.parseAscGrid('ncols 3\n1 2 3') === null);

// ---------------------------------------------------------------------------
console.log('\n[2] header parsing');
// ---------------------------------------------------------------------------
{
  const g = M.parseAscGrid([
    'ncols 3', 'nrows 2', 'xllcorner 100.5', 'yllcorner -200.25', 'cellsize 30', 'NODATA_value -9999',
    '1 2 3', '4 5 6',
  ].join('\n'));
  check('ncols/nrows', g.ncols === 3 && g.nrows === 2, `${g.ncols}x${g.nrows}`);
  check('origin', g.xllcorner === 100.5 && g.yllcorner === -200.25, `${g.xllcorner},${g.yllcorner}`);
  check('cellsize', g.cellSize === 30, String(g.cellSize));
  check('NODATA', g.nodataValue === -9999, String(g.nodataValue));
  check('corner origin is not flagged as centre', g.centerOrigin === false);
  eq('body rows', g.table.rows, [['1', '2', '3'], ['4', '5', '6']]);
  check('table width = ncols', g.table.width === 3);
  check('token count', g.tokenCount === 6, String(g.tokenCount));
}
{
  // The `xllcenter` variant: corner = centre - cellSize/2, PER AXIS.
  const g = M.parseAscGrid('ncols 2\nnrows 1\nxllcenter 15\nyllcenter 25\ncellsize 10\n1 2');
  check('xllcenter → corner', g.xllcorner === 10, String(g.xllcorner));
  check('yllcenter → corner', g.yllcorner === 20, String(g.yllcorner));
  check('centre origin flagged', g.centerOrigin === true);
}
{
  const g = M.parseAscGrid('NCOLS 2\nNROWS 1\nXLLCORNER 5\nYLLCORNER 6\nCELLSIZE 2\nNODATA_VALUE -1\n7 8');
  check('header keys are case-insensitive', g.ncols === 2 && g.xllcorner === 5 && g.cellSize === 2 && g.nodataValue === -1);
}
{
  const g = M.parseAscGrid('ncols 2\nnrows 1\n9 8');
  check('missing NODATA line → null', g.nodataValue === null);
  check('missing origin → 0,0', g.xllcorner === 0 && g.yllcorner === 0);
  check('missing cellsize → 1', g.cellSize === 1);
  eq('body still read', g.table.rows, [['9', '8']]);
}
{
  const g = M.parseAscGrid('ncols   2\n  nrows 1\nxllcorner\t3\ncellsize 1\n1 2');
  check('extra whitespace / tabs in the header', g.ncols === 2 && g.nrows === 1 && g.xllcorner === 3);
}

// ---------------------------------------------------------------------------
console.log('\n[3] body tokenisation');
// ---------------------------------------------------------------------------
{
  // Space-ALIGNED bodies are the norm from ArcGIS — runs of spaces must not
  // become empty fields (which is exactly what RFC-4180 machinery would do).
  const g = M.parseAscGrid('ncols 3\nnrows 2\ncellsize 1\n   1    2   3\n  10   20  30');
  eq('multi-space alignment', g.table.rows, [['1', '2', '3'], ['10', '20', '30']]);
}
{
  const g = M.parseAscGrid('ncols 2\r\nnrows 2\r\ncellsize 1\r\n1 2\r\n3 4\r\n');
  eq('CRLF', g.table.rows, [['1', '2'], ['3', '4']]);
}
{
  const g = M.parseAscGrid('﻿ncols 2\nnrows 1\ncellsize 1\n1 2');
  eq('BOM stripped', g.table.rows, [['1', '2']]);
}
{
  // The spec is a flat ROW-MAJOR value stream — a body wrapped at some other
  // width must still chunk into ncols-wide rows.
  const g = M.parseAscGrid('ncols 3\nnrows 2\ncellsize 1\n1 2\n3 4 5\n6');
  eq('wrapped body re-chunks by ncols', g.table.rows, [['1', '2', '3'], ['4', '5', '6']]);
}
{
  const g = M.parseAscGrid('ncols 3\nnrows 3\ncellsize 1\n1 2 3\n4 5');
  check('short stream keeps only the rows it has', g.table.rows.length === 2, String(g.table.rows.length));
  check('short last row is ragged', g.table.ragged === 1, String(g.table.ragged));
  check('token count reported', g.tokenCount === 5, String(g.tokenCount));
  check('nrows still the DECLARED value', g.nrows === 3);
  // The dialog compares tokenCount against ncols*nrows and reports the gap.
  check('declared vs actual is detectable', g.ncols * g.nrows !== g.tokenCount);
}
{
  const g = M.parseAscGrid('ncols 2\nnrows 2\ncellsize 1\n1 2 3 4 5 6');
  eq('long stream is truncated to nrows', g.table.rows, [['1', '2'], ['3', '4']]);
}
{
  const g = M.parseAscGrid('ncols 2\nnrows 1\ncellsize 1\n\n\n  1   2  \n\n');
  eq('blank lines around the body are ignored', g.table.rows, [['1', '2']]);
}

// ---------------------------------------------------------------------------
console.log('\n[4] NODATA → the attribute default, counted separately');
// ---------------------------------------------------------------------------
{
  const g = M.parseAscGrid('ncols 3\nnrows 2\ncellsize 1\nNODATA_value -9999\n1 -9999 3\n-9999 5 6');
  const b = M.buildGridValues(g.table, { id: 'v', type: 'integer', defaultValue: '7' }, undefined, g.nodataValue);
  eq('NODATA cells take the DEFAULT', Array.from(b.values), [1, 7, 3, 7, 5, 6]);
  check('nodataCells counted', b.nodataCells === 2, String(b.nodataCells));
  check('NODATA is NOT an unparseable value', b.badValues === 0, String(b.badValues));
}
{
  // A float NODATA compares NUMERICALLY, so a differently-spelled sentinel of
  // the same value still matches.
  const g = M.parseAscGrid('ncols 3\nnrows 1\ncellsize 1\nNODATA_value -9999\n-9999.0 2.5 -9.999e3');
  const b = M.buildGridValues(g.table, floatAttr, undefined, g.nodataValue);
  eq('numeric NODATA compare', Array.from(b.values), [0, 2.5, 0]);
  check('all three spellings counted', b.nodataCells === 2, String(b.nodataCells));
}
{
  // No NODATA line ⇒ the historical path, byte for byte.
  const g = M.parseAscGrid('ncols 2\nnrows 1\ncellsize 1\n1 x');
  const b = M.buildGridValues(g.table, intAttr, undefined, g.nodataValue);
  eq('no NODATA: unparseable still defaults', Array.from(b.values), [1, 0]);
  check('badValues counted as before', b.badValues === 1);
  check('nodataCells field absent when the file declares none', b.nodataCells === undefined);
}
{
  // Regression: the CSV path with no nodata argument is untouched.
  const t = M.parseCsvTable('0,0,1\n1,x,0');
  const b = M.buildGridValues(t, { id: 'n', type: 'integer', defaultValue: '9' });
  eq('CSV grid values unchanged', Array.from(b.values), [0, 0, 1, 1, 9, 0]);
  check('no nodataCells on the CSV path', b.nodataCells === undefined);
}
{
  // Padding still counted independently of NODATA.
  const g = M.parseAscGrid('ncols 3\nnrows 2\ncellsize 1\nNODATA_value -1\n1 -1 3\n4');
  const b = M.buildGridValues(g.table, { id: 'v', type: 'integer', defaultValue: '5' }, undefined, g.nodataValue);
  eq('short row padded, NODATA defaulted', Array.from(b.values), [1, 5, 3, 4, 5, 5]);
  check('padded cells counted', b.paddedCells === 2, String(b.paddedCells));
  check('nodata counted', b.nodataCells === 1, String(b.nodataCells));
}

// ---------------------------------------------------------------------------
console.log('\n[5] export — header + body');
// ---------------------------------------------------------------------------
{
  const txt = M.buildAscGrid([1, 2, 3, 4, 5, 6], 3, 2, { xllcorner: 500, yllcorner: -12.5, cellSize: 30 });
  const lines = txt.split('\n');
  eq('the six header lines', lines.slice(0, 6), [
    'ncols 3', 'nrows 2', 'xllcorner 500', 'yllcorner -12.5', 'cellsize 30', `NODATA_value ${M.ASC_NODATA_DEFAULT}`,
  ]);
  eq('body rows', lines.slice(6), ['1 2 3', '4 5 6']);
}
{
  const txt = M.buildAscGrid([1, 2], 2, 1, null);
  const lines = txt.split('\n');
  eq('no georeference → the neutral default', lines.slice(2, 5), ['xllcorner 0', 'yllcorner 0', 'cellsize 1']);
}
{
  const txt = M.buildAscGrid([1, NaN, Infinity, 4], 2, 2, null);
  eq('non-finite → the NODATA sentinel', txt.split('\n').slice(6), ['1 -9999', '-9999 4']);
}
{
  const txt = M.buildAscGrid([1, 2, 3, 4, 5, 6], 2, 3, null, { maxRows: 2 });
  check('maxRows truncates the BODY, keeping the header', txt.split('\n').length === 8, String(txt.split('\n').length));
  check('the header still declares the FULL height', txt.split('\n')[1] === 'nrows 3');
}
{
  const txt = M.buildAscGrid([1.5, -0.25], 2, 1, null, { nodataValue: -1 });
  eq('a custom NODATA sentinel', txt.split('\n').slice(5), ['NODATA_value -1', '1.5 -0.25']);
}

// ---------------------------------------------------------------------------
console.log('\n[6] ROUND TRIP — export → parse → build, values identical');
// ---------------------------------------------------------------------------
const roundTrip = (name, values, width, height, attr, georef) => {
  const txt = M.buildAscGrid(values, width, height, georef ?? null);
  const g = M.parseAscGrid(txt);
  check(`${name}: re-parses`, g !== null);
  if (!g) return;
  check(`${name}: dims survive`, g.ncols === width && g.nrows === height, `${g.ncols}x${g.nrows}`);
  if (georef) {
    check(`${name}: georef survives`,
      g.xllcorner === georef.xllcorner && g.yllcorner === georef.yllcorner && g.cellSize === georef.cellSize,
      `${g.xllcorner},${g.yllcorner},${g.cellSize}`);
  }
  const b = M.buildGridValues(g.table, attr, undefined, g.nodataValue);
  eq(`${name}: values identical`, Array.from(b.values), Array.from(values));
  check(`${name}: nothing defaulted`, b.badValues === 0 && (b.nodataCells ?? 0) === 0 && b.paddedCells === 0,
    `bad=${b.badValues} nodata=${b.nodataCells} pad=${b.paddedCells}`);
};
roundTrip('integer', [0, 1, 2, 3, 42, -7], 3, 2, intAttr, { xllcorner: 1000, yllcorner: 2000, cellSize: 30 });
roundTrip('float (exact f64)', [0.1, 1 / 3, -2.5e-8, 1e20], 2, 2, floatAttr, { xllcorner: -0.5, yllcorner: 0.25, cellSize: 0.5 });
roundTrip('bool → 0/1', [1, 0, 0, 1, 1, 0], 3, 2, boolAttr);
roundTrip('tag → its INDEX', [0, 1, 2, 1, 0, 2], 3, 2, tagAttr);
{
  // A non-finite cell round-trips as the NODATA sentinel → the attribute default.
  const txt = M.buildAscGrid([1, NaN, 3, 4], 2, 2, null);
  const g = M.parseAscGrid(txt);
  const b = M.buildGridValues(g.table, { id: 'v', type: 'integer', defaultValue: '0' }, undefined, g.nodataValue);
  eq('non-finite → NODATA → default', Array.from(b.values), [1, 0, 3, 4]);
  check('and is reported as NODATA, not as a bad value', b.nodataCells === 1 && b.badValues === 0);
}
{
  // A tag whose INDEX collides with nothing: the NAME form is NOT written (the
  // format is numeric), which is what keeps the round trip exact.
  const txt = M.buildAscGrid([2, 1], 2, 1, null);
  check('tag exports as a number, never a name', txt.split('\n')[6] === '2 1', JSON.stringify(txt.split('\n')[6]));
}
{
  // Centre-origin files round-trip as CORNER (the app stores corners).
  const g = M.parseAscGrid('ncols 1\nnrows 1\nxllcenter 15\nyllcenter 25\ncellsize 10\n1');
  const txt = M.buildAscGrid([1], 1, 1, { xllcorner: g.xllcorner, yllcorner: g.yllcorner, cellSize: g.cellSize });
  const g2 = M.parseAscGrid(txt);
  check('centre → corner → corner is stable', g2.xllcorner === 10 && g2.yllcorner === 20 && g2.centerOrigin === false);
}

// ---------------------------------------------------------------------------
console.log('\n[7] the multi-layer co-registration contract');
// ---------------------------------------------------------------------------
{
  const a = M.parseAscGrid('ncols 2\nnrows 2\ncellsize 30\nxllcorner 10\nyllcorner 20\n1 2\n3 4');
  const b = M.parseAscGrid('ncols 2\nnrows 2\ncellsize 30\nxllcorner 10\nyllcorner 20\n5 6\n7 8');
  const c = M.parseAscGrid('ncols 3\nnrows 2\ncellsize 30\n1 2 3\n4 5 6');
  check('aligned layers agree on ncols/nrows', a.ncols === b.ncols && a.nrows === b.nrows);
  check('a mis-sized layer is detectable', c.ncols !== a.ncols);
  const ba = M.buildGridValues(a.table, intAttr, undefined, a.nodataValue);
  const bb = M.buildGridValues(b.table, intAttr, undefined, b.nodataValue);
  eq('layer A values', Array.from(ba.values), [1, 2, 3, 4]);
  eq('layer B values', Array.from(bb.values), [5, 6, 7, 8]);
  check('both blocks are the same shape', ba.width === bb.width && ba.height === bb.height);
}

rmSync(entryPath, { force: true });
rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\nAll .asc checks passed.' : `\n${failures} CHECK(S) FAILED.`);
process.exit(failures === 0 ? 0 : 1);

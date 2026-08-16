// CSV export — serialization + the ROUND TRIP through the import machinery.
//
// The acceptance criterion of the feature is not "it wrote a file" but "what it
// wrote comes BACK": an exported agents CSV must re-import through the SAME
// `parseCsvTable` → `autoMapAgentColumns` → `buildAgentSpecs` path the dialog
// uses, with the columns auto-mapped and every value exact; an exported grid CSV
// must re-import through `buildGridValues` cell for cell. So most of this file
// is export→import→compare, not string matching.
//
// Run from the repo root:  node scripts/test-csv-export.mjs
import { build } from 'esbuild';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = `export * from '../src/simulator/csvImport.ts';\n`;
const dir = mkdtempSync(join(tmpdir(), 'gca-csvx-'));
const entryPath = join(ROOT, 'scripts', '__csvx_entry.ts');
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

// ---------------------------------------------------------------------------
console.log('\n[1] csvEscape');
// ---------------------------------------------------------------------------
eq('plain field untouched', M.csvEscape('abc'), 'abc');
eq('empty field untouched', M.csvEscape(''), '');
eq('comma quoted', M.csvEscape('a,b'), '"a,b"');
eq('quote doubled + wrapped', M.csvEscape('say "hi"'), '"say ""hi"""');
eq('newline quoted', M.csvEscape('a\nb'), '"a\nb"');
eq('CR quoted', M.csvEscape('a\rb'), '"a\rb"');
eq('leading space quoted (the parser TRIMS unquoted fields)', M.csvEscape(' a'), '" a"');
eq('trailing space quoted', M.csvEscape('a '), '"a "');
eq('a comma is fine under a semicolon delimiter', M.csvEscape('a,b', ';'), 'a,b');
eq('a semicolon IS escaped under a semicolon delimiter', M.csvEscape('a;b', ';'), '"a;b"');
eq('a tab is escaped under a tab delimiter', M.csvEscape('a\tb', '\t'), '"a\tb"');
// Every escape must survive the parser it was written for.
for (const [raw, delim] of [['a,b', ','], ['say "hi"', ','], ['a\nb', ','], [' a ', ','], ['x;y', ';'], ['p\tq', '\t']]) {
  const back = M.parseCsvRows(M.csvRow([raw, 'tail'], delim), delim);
  check(`escape round-trips ${JSON.stringify(raw)} (delim ${JSON.stringify(delim)})`, back.length === 1 && back[0][0] === raw && back[0][1] === 'tail',
    `got ${JSON.stringify(back)}`);
}

// ---------------------------------------------------------------------------
console.log('\n[2] formatCsvValue per attribute type');
// ---------------------------------------------------------------------------
const intAttr = { id: 'n', name: 'Count', type: 'integer', defaultValue: '0' };
const floatAttr = { id: 'f', name: 'Energy', type: 'float', defaultValue: '0' };
const boolAttr = { id: 'b', name: 'Alive', type: 'bool', defaultValue: 'false' };
const tagAttr = { id: 't', name: 'Species', type: 'tag', defaultValue: '0', tagOptions: ['red', 'green', 'blue'] };

eq('integer', M.formatCsvValue(intAttr, 42), '42');
eq('negative integer', M.formatCsvValue(intAttr, -7), '-7');
eq('float keeps full precision', M.formatCsvValue(floatAttr, 0.1 + 0.2), '0.30000000000000004');
eq('bool true', M.formatCsvValue(boolAttr, 1), 'true');
eq('bool false', M.formatCsvValue(boolAttr, 0), 'false');
eq('tag → option NAME', M.formatCsvValue(tagAttr, 2), 'blue');
eq('tag out of range → the raw index (nothing is lost)', M.formatCsvValue(tagAttr, 7), '7');
eq('non-finite → blank', M.formatCsvValue(floatAttr, NaN), '');
eq('Infinity → blank', M.formatCsvValue(floatAttr, Infinity), '');
eq('formatCsvNumber exact', M.formatCsvNumber(1 / 3), '0.3333333333333333');
eq('formatCsvNumber non-finite → blank', M.formatCsvNumber(NaN), '');

// Every formatted value must DECODE back to the same stored number.
for (const [attr, v] of [[intAttr, -13], [floatAttr, 1 / 3], [floatAttr, -1e-9], [floatAttr, 12345678.90123], [boolAttr, 1], [boolAttr, 0], [tagAttr, 0], [tagAttr, 2]]) {
  const d = M.decodeCsvValue(attr, M.formatCsvValue(attr, v));
  check(`format→decode is identity for ${attr.type} ${v}`, d.ok && d.value === v, `got ${JSON.stringify(d)}`);
}

// ---------------------------------------------------------------------------
console.log('\n[3] agent export columns are the auto-map\'s own vocabulary');
// ---------------------------------------------------------------------------
const vecAttr = { id: 'vecid', name: 'Facing', type: 'vector', vectorDims: 2 };
const vec3Attr = { id: 'vec3', name: 'Heading', type: 'vector', vectorDims: 3 };
const attrs2d = [tagAttr, floatAttr, boolAttr, vecAttr];

const cols2d = M.agentExportColumns(attrs2d, false);
eq('2D headers', cols2d.map(c => c.header), ['x', 'y', 'vx', 'vy', 'radius', 'Species', 'Energy', 'Alive', 'Facing.x', 'Facing.y']);
const cols3d = M.agentExportColumns([vec3Attr], true);
eq('3D headers (z / vz appear, vector gets 3 components)', cols3d.map(c => c.header), ['x', 'y', 'z', 'vx', 'vy', 'vz', 'radius', 'Heading.x', 'Heading.y', 'Heading.z']);
eq('vector columns carry the COMPONENT store ids', cols2d.filter(c => c.storeId && c.storeId.startsWith('vecid')).map(c => c.storeId), M.vectorComponentIds ? M.vectorComponentIds('vecid', 2) : ['vecid_vx', 'vecid_vy']);
check('color / lookupTable attributes are not exported',
  M.agentExportColumns([{ id: 'c', name: 'Tint', type: 'color' }, { id: 'lt', name: 'Table', type: 'lookupTable' }], false).every(c => !!c.geom));

// The headers must auto-map back to exactly the targets they came from.
{
  const header = cols2d.map(c => c.header);
  const mapped = M.autoMapAgentColumns(header, attrs2d, false, header.length);
  eq('every exported column auto-maps back', mapped, [
    'geom:x', 'geom:y', 'geom:vx', 'geom:vy', 'geom:radius',
    'attr:t', 'attr:f', 'attr:b', 'vec:vecid:0', 'vec:vecid:1',
  ]);
}
{
  const header = cols3d.map(c => c.header);
  const mapped = M.autoMapAgentColumns(header, [vec3Attr], true, header.length);
  eq('3D columns auto-map back', mapped, [
    'geom:x', 'geom:y', 'geom:z', 'geom:vx', 'geom:vy', 'geom:vz', 'geom:radius',
    'vec:vec3:0', 'vec:vec3:1', 'vec:vec3:2',
  ]);
}

// ---------------------------------------------------------------------------
console.log('\n[4] agents: export → import ROUND TRIP');
// ---------------------------------------------------------------------------
const roundTripAgents = (rows, attrs, is3d, delimiter = ',') => {
  const text = M.buildAgentCsv(rows, attrs, is3d, { delimiter });
  const table = M.parseCsvTable(text, { delimiter, hasHeader: true });
  const targets = M.autoMapAgentColumns(table.header, attrs, is3d, table.width);
  return { text, table, targets, build: M.buildAgentSpecs(table, targets, attrs, { w: 1e9, h: 1e9, d: 1e9 }, is3d) };
};

{
  const rows = [
    { x: 12.5, y: 40, z: undefined, vx: -0.25, vy: 1 / 3, radius: 1.5, attrs: { t: 2, f: 0.1 + 0.2, b: 1, vecid_vx: 1, vecid_vy: -1 } },
    { x: 0, y: 0, vx: 0, vy: 0, radius: 2, attrs: { t: 0, f: -1e-9, b: 0, vecid_vx: 0, vecid_vy: 0 } },
    { x: -3.75, y: 119.125, vx: 1e7, vy: -12345678.90123, radius: 0.5, attrs: { t: 1, f: 12345.6789, b: 1, vecid_vx: 0.5, vecid_vy: 0.25 } },
  ];
  const { text, table, build } = roundTripAgents(rows, attrs2d, false);
  check('no rows skipped', build.skippedRows === 0, `skipped=${build.skippedRows}`);
  check('no values defaulted', build.badValues === 0, `bad=${build.badValues} issues=${JSON.stringify(build.issues)}`);
  check('one spec per row', build.agents.length === rows.length);
  check('header row present', table.header && table.header[0] === 'x');
  let bad = 0;
  build.agents.forEach((a, i) => {
    const src = rows[i];
    if (a.x !== src.x || a.y !== src.y || a.vx !== src.vx || a.vy !== src.vy || a.radius !== src.radius) bad++;
    const sets = Object.fromEntries(a.sets.map(s => [s.attrId, s.value]));
    for (const [k, v] of Object.entries(src.attrs)) if (sets[k] !== v) bad++;
    if (a.z !== undefined) bad++; // 2D must not invent a z
  });
  check('every agent value survives the round trip EXACTLY (incl. f64 precision)', bad === 0, `${bad} mismatch(es)`);
  check('the exported text is what a spreadsheet would show', text.split('\n')[1].startsWith('12.5,40,-0.25,0.3333333333333333,1.5,blue,'), text.split('\n')[1]);
}

{
  // 3D: z / vz travel, and a 3-component vector.
  const attrs3d = [vec3Attr, intAttr];
  const rows = [
    { x: 1.5, y: 2.5, z: 3.5, vx: 0.1, vy: 0.2, vz: 0.3, radius: 1, attrs: { vec3_vx: 1, vec3_vy: 2, vec3_vz: 3, n: -4 } },
    { x: 9, y: 8, z: 7, vx: 0, vy: 0, vz: -1, radius: 2.25, attrs: { vec3_vx: 0, vec3_vy: 0, vec3_vz: 0, n: 0 } },
  ];
  const { build } = roundTripAgents(rows, attrs3d, true);
  check('3D: nothing skipped / defaulted', build.skippedRows === 0 && build.badValues === 0);
  let bad = 0;
  build.agents.forEach((a, i) => {
    const src = rows[i];
    if (a.x !== src.x || a.y !== src.y || a.z !== src.z || a.vx !== src.vx || a.vy !== src.vy || a.vz !== src.vz || a.radius !== src.radius) bad++;
    const sets = Object.fromEntries(a.sets.map(s => [s.attrId, s.value]));
    for (const [k, v] of Object.entries(src.attrs)) if (sets[k] !== v) bad++;
  });
  check('3D round trip exact (z + vz + 3-component vector)', bad === 0, `${bad} mismatch(es)`);
}

{
  // Hostile names: a tag option and an attribute name carrying the delimiter,
  // a quote and leading whitespace. The quoting is what saves the round trip.
  const nastyTag = { id: 'nt', name: 'Kind, "odd"', type: 'tag', defaultValue: '0', tagOptions: ['a,b', 'say "hi"', ' pad '] };
  const rows = [
    { x: 1, y: 2, vx: 0, vy: 0, radius: 1, attrs: { nt: 0 } },
    { x: 3, y: 4, vx: 0, vy: 0, radius: 1, attrs: { nt: 1 } },
    { x: 5, y: 6, vx: 0, vy: 0, radius: 1, attrs: { nt: 2 } },
  ];
  const { text, table, targets, build } = roundTripAgents(rows, [nastyTag], false);
  check('a comma in the header does not split a column', table.width === 6, `width=${table.width}`);
  check('the hostile attribute column still auto-maps', targets[5] === 'attr:nt', `targets=${JSON.stringify(targets)}`);
  const got = build.agents.map(a => a.sets.find(s => s.attrId === 'nt').value);
  eq('hostile tag names round-trip to the same indices', got, [0, 1, 2]);
  check('no defaults', build.badValues === 0, text);
}

{
  // Non-finite geometry: a blank x is a row the import SKIPS — the honest
  // outcome for a broken agent, and the reason blank beats "NaN".
  const rows = [{ x: NaN, y: 1, vx: 0, vy: 0, radius: 1, attrs: {} }, { x: 2, y: 3, vx: 0, vy: 0, radius: 1, attrs: {} }];
  const { build } = roundTripAgents(rows, [], false);
  check('a non-finite position exports blank and re-imports as a skipped row', build.skippedRows === 1 && build.agents.length === 1 && build.agents[0].x === 2);
}

{
  // Non-comma delimiters round-trip too (the export writes .tsv the same way).
  const rows = [{ x: 1.5, y: 2.5, vx: 0, vy: 0, radius: 1, attrs: { t: 1 } }];
  for (const d of [';', '\t']) {
    const { build } = roundTripAgents(rows, [tagAttr], false, d);
    const v = build.agents[0]?.sets.find(s => s.attrId === 't')?.value;
    check(`delimiter ${JSON.stringify(d)} round-trips`, build.agents.length === 1 && build.agents[0].x === 1.5 && v === 1);
  }
}

{
  // maxRows is preview-only truncation — the header always stays.
  const rows = Array.from({ length: 50 }, (_, i) => ({ x: i, y: 0, vx: 0, vy: 0, radius: 1, attrs: {} }));
  const preview = M.buildAgentCsv(rows, [], false, { maxRows: 3 });
  check('preview keeps the header + N rows', preview.split('\n').length === 4, preview);
  check('full build writes every row', M.buildAgentCsv(rows, [], false).split('\n').length === 51);
  eq('empty population still writes the header', M.buildAgentCsv([], attrs2d, false), M.csvRow(cols2d.map(c => c.header)));
}

// ---------------------------------------------------------------------------
console.log('\n[5] grid: export → import ROUND TRIP');
// ---------------------------------------------------------------------------
const roundTripGrid = (values, w, h, attr, delimiter = ',') => {
  const text = M.buildGridCsv(values, w, h, attr, { delimiter });
  // The GRID import defaults to no-header — the export must therefore write none.
  const table = M.parseCsvTable(text, { delimiter, hasHeader: false });
  return { text, table, build: M.buildGridValues(table, attr) };
};

{
  // tag board (names), 5 wide x 3 tall — the LINE=row / FIELD=column convention.
  const values = [0, 1, 2, 1, 0, 2, 2, 0, 1, 1, 0, 0, 2, 1, 2];
  const { text, table, build } = roundTripGrid(values, 5, 3, tagAttr);
  eq('first line is the first ROW, as names', text.split('\n')[0], 'red,green,blue,green,red');
  check('dims survive (5 wide x 3 tall)', build.width === 5 && build.height === 3, `${build.width}x${build.height}`);
  check('no header row written', table.header === null);
  eq('tag board round-trips exactly', Array.from(build.values), values);
  check('nothing defaulted', build.badValues === 0 && build.paddedCells === 0);
}
{
  const values = [0, 1, 1, 0, 1, 0];
  const { text, build } = roundTripGrid(values, 3, 2, boolAttr);
  eq('bool board as true/false', text, 'false,true,true\nfalse,true,false');
  eq('bool board round-trips', Array.from(build.values), values);
}
{
  const values = [0.1 + 0.2, -1 / 3, 1e-12, 12345678.90123];
  const { build } = roundTripGrid(values, 2, 2, floatAttr);
  eq('float board round-trips at full precision', Array.from(build.values), values);
}
{
  const values = [-5, 0, 7, 1000000];
  const { build } = roundTripGrid(values, 4, 1, intAttr);
  eq('integer board round-trips (incl. negatives)', Array.from(build.values), values);
}
{
  // A tag option carrying the delimiter must not split a cell.
  const nasty = { id: 'q', name: 'Q', type: 'tag', defaultValue: '0', tagOptions: ['a,b', 'c'] };
  const { build } = roundTripGrid([0, 1, 1, 0], 2, 2, nasty);
  check('a comma inside a tag name keeps the grid 2 wide', build.width === 2, `width=${build.width}`);
  eq('hostile tag board round-trips', Array.from(build.values), [0, 1, 1, 0]);
}
{
  // Semicolon + tab boards.
  for (const d of [';', '\t']) {
    const { build } = roundTripGrid([0, 2, 1, 1], 2, 2, tagAttr, d);
    eq(`grid round-trips with delimiter ${JSON.stringify(d)}`, Array.from(build.values), [0, 2, 1, 1]);
  }
}
{
  const values = Array.from({ length: 30 }, (_, i) => i);
  check('grid preview truncates to maxRows', M.buildGridCsv(values, 3, 10, intAttr, { maxRows: 4 }).split('\n').length === 4);
  check('grid full build writes every row', M.buildGridCsv(values, 3, 10, intAttr).split('\n').length === 10);
}
{
  // A Float64Array (what the exporter actually hands it) works as-is.
  const buf = Float64Array.from([1, 0, 0, 1]);
  const { build } = roundTripGrid(buf, 2, 2, boolAttr);
  eq('Float64Array input round-trips', Array.from(build.values), [1, 0, 0, 1]);
}

rmSync(entryPath, { force: true });
rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\nAll CSV export checks passed.' : `\n${failures} CHECK(S) FAILED.`);
process.exit(failures === 0 ? 0 : 1);

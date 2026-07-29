// CSV import — parser / decoder / column-mapping verification.
//
// The whole point of the feature is that the value in the FILE is the value in
// the STORE (or is reported as defaulted), so this asserts VALUES, not "it
// parsed". Covers the RFC-4180 corners, delimiter + header auto-detection, the
// per-attribute-type decode table (incl. negative cases), the agent column
// auto-map, agent spec building (skips / defaults / out-of-bounds), and the grid
// row/column convention.
//
// Run from the repo root:  node scripts/test-csv-import.mjs
import { build } from 'esbuild';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = `export * from '../src/simulator/csvImport.ts';\n`;
const dir = mkdtempSync(join(tmpdir(), 'gca-csv-'));
const entryPath = join(ROOT, 'scripts', '__csv_entry.ts');
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
console.log('\n[1] RFC-4180 parsing');
// ---------------------------------------------------------------------------
eq('plain rows', M.parseCsvRows('a,b\n1,2', ','), [['a', 'b'], ['1', '2']]);
eq('CRLF', M.parseCsvRows('a,b\r\n1,2\r\n', ','), [['a', 'b'], ['1', '2']]);
eq('trailing newline gives no phantom row', M.parseCsvRows('1,2\n', ','), [['1', '2']]);
eq('quoted field with a comma', M.parseCsvRows('"a,b",c', ','), [['a,b', 'c']]);
eq('escaped quotes inside quotes', M.parseCsvRows('"say ""hi""",2', ','), [['say "hi"', '2']]);
eq('newline inside a quoted field', M.parseCsvRows('"line1\nline2",x', ','), [['line1\nline2', 'x']]);
eq('unquoted fields are trimmed', M.parseCsvRows('a ,  b\n 1 , 2', ','), [['a', 'b'], ['1', '2']]);
eq('quoted whitespace is preserved', M.parseCsvRows('"  a  ",b', ','), [['  a  ', 'b']]);
eq('BOM stripped', M.parseCsvRows('﻿a,b', ','), [['a', 'b']]);
eq('empty fields kept', M.parseCsvRows('a,,c', ','), [['a', '', 'c']]);
eq('blank lines dropped', M.parseCsvRows('a,b\n\n1,2', ','), [['a', 'b'], ['1', '2']]);
eq('semicolon delimiter', M.parseCsvRows('a;b;c', ';'), [['a', 'b', 'c']]);
eq('ragged rows kept ragged', M.parseCsvRows('1,2,3\n4,5', ','), [['1', '2', '3'], ['4', '5']]);

// ---------------------------------------------------------------------------
console.log('\n[2] delimiter + header detection');
// ---------------------------------------------------------------------------
check('detect comma', M.detectDelimiter('x,y\n1,2\n3,4') === ',');
check('detect semicolon', M.detectDelimiter('x;y\n1;2\n3;4') === ';');
check('detect tab', M.detectDelimiter('x\ty\n1\t2\n3\t4') === '\t');
check('decimal commas do not fool it (semicolon file)', M.detectDelimiter('x;y\n1,5;2,5\n3,5;4,5') === ';');

check('header: names over numbers', M.detectHeader([['x', 'y'], ['1', '2']]) === true);
check('header: numeric first row is data', M.detectHeader([['1', '2'], ['3', '4']]) === false);
check('header: all-tag-name grid is NOT a header', M.detectHeader([['red', 'blue'], ['blue', 'red']]) === false);
check('header: single row is never a header', M.detectHeader([['x', 'y']]) === false);
check('header: mixed first row is data', M.detectHeader([['x', '1'], ['2', '3']]) === false);

{
  const t = M.parseCsvTable('x,y,r\n1,2,3\n4,5,6\n');
  check('table: header split', JSON.stringify(t.header) === '["x","y","r"]' && t.rows.length === 2 && t.width === 3 && t.ragged === 0);
  const t2 = M.parseCsvTable('1,2\n3,4');
  check('table: headerless', t2.header === null && t2.rows.length === 2);
  const t3 = M.parseCsvTable('x,y\n1,2', { hasHeader: false });
  check('table: hasHeader override off', t3.header === null && t3.rows.length === 2);
  const t4 = M.parseCsvTable('1,2,3\n4,5');
  check('table: ragged counted', t4.width === 3 && t4.ragged === 1);
}

// ---------------------------------------------------------------------------
console.log('\n[3] per-type value decoding');
// ---------------------------------------------------------------------------
const intAttr = { id: 'i', type: 'integer', defaultValue: '7' };
const floatAttr = { id: 'f', type: 'float', defaultValue: '0.5' };
const boolAttr = { id: 'b', type: 'bool', defaultValue: 'false' };
const tagAttr = { id: 't', type: 'tag', defaultValue: '1', tagOptions: ['red', 'green', 'blue'] };

const dec = (a, s) => M.decodeCsvValue(a, s);
eq('integer 42', dec(intAttr, '42'), { value: 42, ok: true });
eq('integer rounds 2.7', dec(intAttr, '2.7'), { value: 3, ok: true });
eq('integer rounds -2.5 (floor+.5 not needed here: Math.round)', dec(intAttr, '-2.5'), { value: -2, ok: true });
eq('integer bad → default 7', dec(intAttr, 'abc'), { value: 7, ok: false });
eq('integer empty → default 7', dec(intAttr, ''), { value: 7, ok: false });
eq('float 1.25', dec(floatAttr, '1.25'), { value: 1.25, ok: true });
eq('float exponential', dec(floatAttr, '2e-3'), { value: 0.002, ok: true });
eq('float bad → default .5', dec(floatAttr, 'x'), { value: 0.5, ok: false });
eq('bool 1', dec(boolAttr, '1'), { value: 1, ok: true });
eq('bool TRUE', dec(boolAttr, 'TRUE'), { value: 1, ok: true });
eq('bool yes', dec(boolAttr, 'yes'), { value: 1, ok: true });
eq('bool false', dec(boolAttr, 'false'), { value: 0, ok: true });
eq('bool 0', dec(boolAttr, '0'), { value: 0, ok: true });
eq('bool bad → default 0', dec(boolAttr, 'maybe'), { value: 0, ok: false });
eq('tag by name', dec(tagAttr, 'blue'), { value: 2, ok: true });
eq('tag by NAME case-insensitive', dec(tagAttr, 'GREEN'), { value: 1, ok: true });
eq('tag by index', dec(tagAttr, '0'), { value: 0, ok: true });
eq('tag index out of range → default 1', dec(tagAttr, '9'), { value: 1, ok: false });
eq('tag typo → default 1', dec(tagAttr, 'gren'), { value: 1, ok: false });
// A bool default of 'true' must fall back to 1, not 0.
eq('bool default true', dec({ id: 'b2', type: 'bool', defaultValue: 'true' }, '??'), { value: 1, ok: false });

// ---------------------------------------------------------------------------
console.log('\n[4] agent column auto-mapping');
// ---------------------------------------------------------------------------
const agentAttrs = [
  { id: 'a_species', name: 'species', type: 'tag', tagOptions: ['red', 'green', 'blue'], defaultValue: '0' },
  { id: 'a_energy', name: 'energy', type: 'float', defaultValue: '0' },
  { id: 'a_alive', name: 'alive', type: 'bool', defaultValue: 'false' },
  { id: 'a_facing', name: 'facing', type: 'vector', vectorDims: 2 },
];
eq('auto-map by header (2D)',
  M.autoMapAgentColumns(['x', 'y', 'radius', 'species', 'facing.x', 'facing.y', 'junk'], agentAttrs, false, 7),
  ['geom:x', 'geom:y', 'geom:radius', 'attr:a_species', 'vec:a_facing:0', 'vec:a_facing:1', 'ignore']);
eq('auto-map aliases + case', M.autoMapAgentColumns(['Pos X', 'pos_y', 'Vel X', 'ENERGY'], agentAttrs, false, 4),
  ['geom:x', 'geom:y', 'geom:vx', 'attr:a_energy']);
eq('auto-map: z ignored in 2D', M.autoMapAgentColumns(['x', 'y', 'z'], agentAttrs, false, 3), ['geom:x', 'geom:y', 'ignore']);
eq('auto-map: z used in 3D', M.autoMapAgentColumns(['x', 'y', 'z'], agentAttrs, true, 3), ['geom:x', 'geom:y', 'geom:z']);
eq('auto-map: duplicate header maps once', M.autoMapAgentColumns(['x', 'x'], agentAttrs, false, 2), ['geom:x', 'ignore']);
eq('auto-map headerless → first two are x,y', M.autoMapAgentColumns(null, agentAttrs, false, 4), ['geom:x', 'geom:y', 'ignore', 'ignore']);
{
  const opts = M.agentTargetOptions(agentAttrs, false).map(o => o.key);
  check('target options: no z in 2D', !opts.includes('geom:z') && !opts.includes('geom:vz'));
  check('target options: vector components offered', opts.includes('vec:a_facing:0') && opts.includes('vec:a_facing:1'));
  check('target options: 3D adds z', M.agentTargetOptions(agentAttrs, true).map(o => o.key).includes('geom:z'));
  eq('target key round-trip', M.parseTargetKey(M.targetKey({ kind: 'vec', attrId: 'a_facing', comp: 1 })), { kind: 'vec', attrId: 'a_facing', comp: 1 });
}

// ---------------------------------------------------------------------------
console.log('\n[5] agent spec building');
// ---------------------------------------------------------------------------
{
  const text = [
    'x,y,radius,species,alive,facing.x,facing.y',
    '12.5,40,1.5,red,true,1,0',
    '80,11.25,2,blue,0,0,-1',
    '3,3,1,gren,1,0,1',      // bad tag → default (0)
    'nope,5,1,red,1,0,1',    // bad x → row skipped
    '999,-4,1,red,1,0,1',    // out of bounds
  ].join('\n');
  const t = M.parseCsvTable(text);
  const keys = M.autoMapAgentColumns(t.header, agentAttrs, false, t.width);
  const b = M.buildAgentSpecs(t, keys, agentAttrs, { w: 100, h: 100, d: 1 }, false);

  check('4 agents built (1 row skipped)', b.agents.length === 4 && b.skippedRows === 1, `agents=${b.agents.length} skipped=${b.skippedRows}`);
  check('1 bad value counted', b.badValues === 1, `badValues=${b.badValues}`);
  check('bad-value issue reported', b.issues.length === 1 && b.issues[0].column === 'species' && b.issues[0].raw === 'gren');
  check('1 out-of-bounds row counted', b.outOfBounds === 1, `oob=${b.outOfBounds}`);

  const a0 = b.agents[0];
  eq('agent0 position/radius', [a0.x, a0.y, a0.radius], [12.5, 40, 1.5]);
  check('agent0 has no z in 2D', a0.z === undefined);
  const s0 = Object.fromEntries(a0.sets.map(s => [s.attrId, s.value]));
  eq('agent0 sets (tag red=0, alive true=1, facing 1,0)', s0, { a_species: 0, a_alive: 1, a_facing_vx: 1, a_facing_vy: 0 });
  const s1 = Object.fromEntries(b.agents[1].sets.map(s => [s.attrId, s.value]));
  eq('agent1 sets (tag blue=2, alive 0, facing 0,-1)', s1, { a_species: 2, a_alive: 0, a_facing_vx: 0, a_facing_vy: -1 });
  const s2 = Object.fromEntries(b.agents[2].sets.map(s => [s.attrId, s.value]));
  check('agent2 bad tag fell back to the default (0)', s2.a_species === 0);
}
{
  // 3D: z + vz honoured; a missing z defaults to 0.
  const text = 'x,y,z,vx,vy,vz\n1,2,3,0.1,0.2,0.3\n4,5,,0,0,0';
  const t = M.parseCsvTable(text);
  const keys = M.autoMapAgentColumns(t.header, agentAttrs, true, t.width);
  const b = M.buildAgentSpecs(t, keys, agentAttrs, { w: 10, h: 10, d: 10 }, true);
  eq('3D agent0', [b.agents[0].x, b.agents[0].y, b.agents[0].z, b.agents[0].vx, b.agents[0].vy, b.agents[0].vz], [1, 2, 3, 0.1, 0.2, 0.3]);
  check('3D agent1 missing z → 0', b.agents[1].z === 0);
  check('3D missing z counted as a bad value', b.badValues === 1, `badValues=${b.badValues}`);
}
{
  // Explicit manual override: map column 3 to energy instead of ignoring.
  const t = M.parseCsvTable('1,2,9.5\n3,4,0.25', { hasHeader: false });
  const b = M.buildAgentSpecs(t, ['geom:x', 'geom:y', 'attr:a_energy'], agentAttrs, { w: 10, h: 10, d: 1 }, false);
  eq('manual mapping applies', b.agents.map(a => a.sets[0].value), [9.5, 0.25]);
}

// ---------------------------------------------------------------------------
console.log('\n[6] grid value building (rows = height, fields = width)');
// ---------------------------------------------------------------------------
{
  const t = M.parseCsvTable('0,0,1,1,0,0\n0,1,1,0,1,0\n1,1,0,0,1,1\n0,0,1,1,0,0');
  const g = M.buildGridValues(t, { id: 'alive', type: 'bool', defaultValue: 'false' });
  check('grid dims: 6 wide x 4 tall', g.width === 6 && g.height === 4, `${g.width}x${g.height}`);
  eq('row 0 verbatim', Array.from(g.values.slice(0, 6)), [0, 0, 1, 1, 0, 0]);
  eq('row 2 verbatim', Array.from(g.values.slice(12, 18)), [1, 1, 0, 0, 1, 1]);
  check('no bad values', g.badValues === 0 && g.paddedCells === 0);
}
{
  // A tag grid by NAME — the case the header heuristic must NOT eat.
  const text = 'red,blue\nblue,green';
  const t = M.parseCsvTable(text);
  check('tag-name grid: no header eaten', t.header === null && t.rows.length === 2);
  const g = M.buildGridValues(t, tagAttr);
  eq('tag grid values', Array.from(g.values), [0, 2, 2, 1]);
}
{
  // Ragged + unparseable.
  const t = M.parseCsvTable('1,2,3\n4,x');
  const g = M.buildGridValues(t, { id: 'n', type: 'integer', defaultValue: '9' });
  eq('ragged padded with the default', Array.from(g.values), [1, 2, 3, 4, 9, 9]);
  check('1 bad value + 1 padded cell', g.badValues === 1 && g.paddedCells === 1, `bad=${g.badValues} pad=${g.paddedCells}`);
  check('issue names the cell', g.issues[0].row === 2 && g.issues[0].raw === 'x');
}
{
  // Float grid with decimal values through a semicolon file.
  const t = M.parseCsvTable('0.5;1.5\n-2.25;3');
  const g = M.buildGridValues(t, floatAttr);
  check('semicolon float grid', g.width === 2 && g.height === 2);
  eq('float values', Array.from(g.values), [0.5, 1.5, -2.25, 3]);
}
{
  // Grid target options: model attributes excluded, vectors per component.
  const cellAttrs = [
    { id: 'c_alive', name: 'alive', type: 'bool' },
    { id: 'c_speed', name: 'speed', type: 'model', isModelAttribute: true },
    { id: 'c_flow', name: 'flow', type: 'vector', vectorDims: 2 },
    { id: 'c_tbl', name: 'table', type: 'lookupTable' },
  ];
  const opts = M.gridTargetOptions(cellAttrs);
  eq('grid targets', opts.map(o => o.id), ['c_alive', 'c_flow_vx', 'c_flow_vy']);
}

rmSync(entryPath, { force: true });
rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\nAll CSV import checks passed.' : `\n${failures} CHECK(S) FAILED.`);
process.exit(failures === 0 ? 0 : 1);

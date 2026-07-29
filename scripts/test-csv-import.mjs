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

// ---------------------------------------------------------------------------
console.log('\n[7] no-delimiter mode: every CHARACTER is a cell');
// ---------------------------------------------------------------------------
const NONE = M.CSV_NO_DELIMITER;
check('CSV_NO_DELIMITER is the sentinel "none"', NONE === 'none');
check('detectDelimiter NEVER returns none', !M.CSV_DELIMITERS.includes(NONE) && M.detectDelimiter('.O.\n.O.') !== NONE);

eq('chars split per character', M.parseCharRows('.O.\nOO.'), [['.', 'O', '.'], ['O', 'O', '.']]);
eq('CRLF handled', M.parseCharRows('.O\r\nO.\r\n'), [['.', 'O'], ['O', '.']]);
eq('trailing newline gives no phantom row', M.parseCharRows('.O\n'), [['.', 'O']]);
eq('leading/trailing blank lines dropped', M.parseCharRows('\n\n.O\n\n'), [['.', 'O']]);
eq('INTERIOR blank line kept as a zero-length row (geometry preserved)', M.parseCharRows('.O\n\nO.'), [['.', 'O'], [], ['O', '.']]);
eq('a line of SPACES is a row of space cells (no trimming)', M.parseCharRows('   \n.O.'), [[' ', ' ', ' '], ['.', 'O', '.']]);
eq('a quote is an ordinary cell (RFC-4180 bypassed)', M.parseCharRows('"a"\n.b.'), [['"', 'a', '"'], ['.', 'b', '.']]);
eq('a comma and a semicolon are ordinary cells', M.parseCharRows(',;\n.O'), [[',', ';'], ['.', 'O']]);
eq('BOM stripped', M.parseCharRows('﻿.O'), [['.', 'O']]);
eq('ragged lines stay ragged', M.parseCharRows('.OO\n.O'), [['.', 'O', 'O'], ['.', 'O']]);
eq('astral char counts as ONE cell', M.parseCharRows('a\u{1F600}b'), [['a', '\u{1F600}', 'b']]);

{
  const t = M.parseCsvTable('.O.\nOO.\n.O', { delimiter: NONE });
  check('table: 3 wide x 3 tall, header FORCED null', t.width === 3 && t.rows.length === 3 && t.header === null, `${t.width}x${t.rows.length} header=${JSON.stringify(t.header)}`);
  check('table: ragged counted', t.ragged === 1);
  // The header heuristic must NOT run even when asked for a header.
  const t2 = M.parseCsvTable('abc\n1b2', { delimiter: NONE, hasHeader: true });
  check('header stays OFF even with hasHeader:true', t2.header === null && t2.rows.length === 2);
  // The same text through the DELIMITED path WOULD have detected a header.
  check('control: the delimited path would have seen a header', M.parseCsvTable('a,b,c\n1,b,2').header !== null);
}
{
  const t = M.parseCsvTable('..OO\n.O.O\nOO..', { delimiter: NONE });
  eq('distinctChars: counts, most frequent first', M.distinctChars(t).map(c => [c.char, c.count]), [['.', 6], ['O', 6]]);
  const t2 = M.parseCsvTable('...\n..X', { delimiter: NONE });
  eq('distinctChars ordering by count', M.distinctChars(t2).map(c => c.char), ['.', 'X']);
  check('charLabel names invisibles', M.charLabel(' ').includes('space') && M.charLabel('\t').includes('tab') && M.charLabel('O') === 'O');
}

console.log('\n[7a] auto-seed');
{
  // integer: digits only.
  const seedInt = M.autoSeedCharMap(['0', '3', '9', 'a', ' ', '.'], intAttr);
  eq('integer seeds digits, nothing else', seedInt, { '0': '0', '3': '3', '9': '9' });
  // float: same.
  eq('float seeds digits', M.autoSeedCharMap(['2', 'x'], floatAttr), { '2': '2' });
  // bool: the CA-ASCII conventions.
  const seedBool = M.autoSeedCharMap(['.', 'O', '#', '0', '1', 'b', 'o', 'X', '*', ' ', 'Q'], boolAttr);
  eq('bool seeds', seedBool, { '.': 'false', 'O': 'true', '#': 'true', '0': 'false', '1': 'true', 'b': 'false', 'o': 'true', 'X': 'true', '*': 'true' });
  check('bool: space + unknown stay unmapped', seedBool[' '] === undefined && seedBool['Q'] === undefined);
  // tag: unambiguous first letters + in-range digits.
  const ww = { id: 'ty', type: 'tag', defaultValue: '0', tagOptions: ['Empty', 'Wire', 'Head', 'tail'] };
  const seedTag = M.autoSeedCharMap(['.', 'H', 't', '#', '1', '9', ' '], ww);
  eq('tag seeds unambiguous initials + in-range digits', seedTag, { 'H': '2', 't': '3', '1': '1' });
  check('tag: out-of-range digit unmapped', seedTag['9'] === undefined);
  check('tag: # and . unmapped (no initial match)', seedTag['#'] === undefined && seedTag['.'] === undefined);
  // AMBIGUOUS initials seed NEITHER.
  const amb = { id: 'a', type: 'tag', defaultValue: '0', tagOptions: ['Sand', 'Stone', 'Water'] };
  const seedAmb = M.autoSeedCharMap(['S', 's', 'W'], amb);
  eq('ambiguous initial S seeds nothing; W is unique', seedAmb, { 'W': '2' });
  // Case-insensitive initial match.
  eq('initial match is case-insensitive', M.autoSeedCharMap(['e', 'w'], ww), { 'e': '0', 'w': '1' });
}

console.log('\n[7b] char-map application (buildGridValues)');
{
  // (a) Wireworld-style tag board with the auto-seed + one hand-remap.
  const ww = { id: 'ty', type: 'tag', defaultValue: '0', tagOptions: ['Empty', 'Wire', 'Head', 'tail'] };
  const t = M.parseCsvTable('.###.\n.Ht..\n.....', { delimiter: NONE });
  const seed = M.autoSeedCharMap(M.distinctChars(t), ww);
  const g0 = M.buildGridValues(t, ww, seed);
  check('unmapped . and # counted per CHARACTER', g0.unmappedChars.length === 2 && g0.unmappedChars.includes('.') && g0.unmappedChars.includes('#'), JSON.stringify(g0.unmappedChars));
  check('unmapped cells took the default and were counted', g0.badValues === 13, `badValues=${g0.badValues}`);
  // Hand-map: . -> Empty(0), # -> Wire(1).
  const map = { ...seed, '.': '0', '#': '1' };
  const g = M.buildGridValues(t, ww, map);
  check('5 wide x 3 tall', g.width === 5 && g.height === 3);
  eq('tag board values', Array.from(g.values), [0, 1, 1, 1, 0, 0, 2, 3, 0, 0, 0, 0, 0, 0, 0]);
  check('nothing unmapped now', g.badValues === 0 && g.unmappedChars.length === 0);

  // (b) digit board into an integer attribute + a char mapped to a MULTI-DIGIT value.
  const t2 = M.parseCsvTable('012\n3a9', { delimiter: NONE });
  const m2 = { ...M.autoSeedCharMap(M.distinctChars(t2), intAttr), 'a': '10' };
  const g2 = M.buildGridValues(t2, intAttr, m2);
  eq('a -> 10 (a char can carry ANY value)', Array.from(g2.values), [0, 1, 2, 3, 10, 9]);
  // negative + decimal targets too (the value is not limited to one char)
  const g2b = M.buildGridValues(t2, intAttr, { ...m2, 'a': '-7' });
  check('a -> -7', g2b.values[4] === -7);
  const g2c = M.buildGridValues(t2, floatAttr, { ...m2, 'a': '2.5' });
  check('float a -> 2.5', g2c.values[4] === 2.5);

  // (c) a .O Life pattern into a bool attribute (pure auto-seed).
  const t3 = M.parseCsvTable('.O.\n.OO\nO..', { delimiter: NONE });
  const g3 = M.buildGridValues(t3, boolAttr, M.autoSeedCharMap(M.distinctChars(t3), boolAttr));
  eq('Life bool board', Array.from(g3.values), [0, 1, 0, 0, 1, 1, 1, 0, 0]);
  check('Life board fully mapped', g3.badValues === 0);

  // (d) ragged + a space cell + an interior blank line.
  const t4 = M.parseCsvTable('.OO\n.O\n\nO', { delimiter: NONE });
  const g4 = M.buildGridValues(t4, boolAttr, M.autoSeedCharMap(M.distinctChars(t4), boolAttr));
  check('ragged: 3 wide x 4 tall', g4.width === 3 && g4.height === 4, `${g4.width}x${g4.height}`);
  eq('short rows + the blank row padded with the default', Array.from(g4.values), [0, 1, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0]);
  check('padded cells counted', g4.paddedCells === 6, `padded=${g4.paddedCells}`);
  const t5 = M.parseCsvTable('.O.\n. .', { delimiter: NONE });
  const g5 = M.buildGridValues(t5, boolAttr, M.autoSeedCharMap(M.distinctChars(t5), boolAttr));
  check('a SPACE cell is unmapped → default, counted', g5.badValues === 1 && g5.unmappedChars.length === 1 && g5.unmappedChars[0] === ' ');
  const g5b = M.buildGridValues(t5, boolAttr, { ...M.autoSeedCharMap(M.distinctChars(t5), boolAttr), ' ': 'true' });
  check('a SPACE can be mapped explicitly', g5b.badValues === 0 && g5b.values[4] === 1);

  // An empty-string mapping means UNMAPPED (the widget's cleared state).
  const g6 = M.buildGridValues(t3, boolAttr, { 'O': '', '.': 'false' });
  // t3 holds four 'O' cells, so all four fall back to the default.
  check('empty mapping = unmapped', g6.badValues === 4 && g6.unmappedChars[0] === 'O', `badValues=${g6.badValues} chars=${JSON.stringify(g6.unmappedChars)}`);
}

console.log('\n[7c] the DELIMITED path is unaffected');
{
  // Same helper, no charMap → the historical decode, byte for byte.
  const t = M.parseCsvTable('0,0,1\n1,x,0');
  const g = M.buildGridValues(t, { id: 'n', type: 'integer', defaultValue: '9' });
  eq('delimited grid values unchanged', Array.from(g.values), [0, 0, 1, 1, 9, 0]);
  check('delimited build carries no unmappedChars field', g.unmappedChars === undefined);
  check('delimited badValues still counted', g.badValues === 1);
}

rmSync(entryPath, { force: true });
rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\nAll CSV import checks passed.' : `\n${failures} CHECK(S) FAILED.`);
process.exit(failures === 0 ? 0 : 1);

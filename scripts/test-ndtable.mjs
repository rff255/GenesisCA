// N-D Lookup Table functional verification (PR1).
//
//  1. Unit tests: randomFillTableData determinism, remapTableDataAxis /
//     remapTableDataForAxesChange, normalizeLookupTablePayload.
//  2. A synthetic 3-axis coded-index model (dims 3×13×9, one intRange axis
//     with min=2) compiled + RUN on the JS target in Node — per-cell values
//     compared against an independent clamp+stride computation (includes
//     out-of-range inputs to prove the saturating clamp).
//  3. The SAME model compiled to WASM, instantiated against a real
//     WebAssembly.Memory, run, and compared BIT-EXACTLY against JS.
//  4. The WebGPU shader emit — compiles without error + carries the clamped
//     multi-stride index math.
//
// Run from the repo root:  node scripts/test-ndtable.mjs
import { build } from 'esbuild';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = `
export { compileGraph } from '../src/modeler/vpl/compiler/compile.ts';
export { compileGraphWasm } from '../src/modeler/vpl/compiler/wasm/compile.ts';
export { computeLayoutFromModel, buildViewerIds } from '../src/modeler/vpl/compiler/wasm/layout.ts';
export { compileGraphWebGPU } from '../src/modeler/vpl/compiler/webgpu/compile.ts';
export { migrateForHarness } from '../src/dev/compileHarness.ts';
export {
  resolveAxes, isMultiAxisTable, normalizeLookupTablePayload,
  randomFillTableData, remapTableDataAxis, remapTableDataForAxesChange,
  buildLookupTablePayload,
} from '../src/modeler/vpl/compiler/variegation.ts';
`;
const dir = mkdtempSync(join(tmpdir(), 'gca-ndtable-'));
const entryPath = join(ROOT, 'scripts', '__ndtable_entry.ts');
writeFileSync(entryPath, ENTRY);
const outPath = join(dir, 'bundle.mjs');
await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: process.cwd() });
const M = await import(pathToFileURL(outPath).href);

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ok  ${name}`);
  else { console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); failures++; }
};

// ---------------------------------------------------------------------------
// 1. Helper unit tests
// ---------------------------------------------------------------------------
console.log('== helpers ==');
{
  const a = M.randomFillTableData(2457, 1834277, 0.2, { valueType: 'tag', valueCount: 2 });
  const b = M.randomFillTableData(2457, 1834277, 0.2, { valueType: 'tag', valueCount: 2 });
  check('randomFill deterministic (same seed ⇒ identical)', JSON.stringify(a) === JSON.stringify(b));
  const c = M.randomFillTableData(2457, 999, 0.2, { valueType: 'tag', valueCount: 2 });
  check('randomFill seed-sensitive', JSON.stringify(a) !== JSON.stringify(c));
  const nz = a.filter(v => v !== 0).length / a.length;
  check('randomFill density ≈ 0.2', Math.abs(nz - 0.2) < 0.03, `got ${nz.toFixed(3)}`);
  check('randomFill values in 1..2', a.every(v => v === 0 || v === 1 || v === 2));
}
{
  // remapTableDataAxis: 2×3 table, reorder axis 1 as [2,0] (drop old col 1)
  const data = [0, 1, 2, 10, 11, 12]; // dims [2,3]
  const out = M.remapTableDataAxis(data, [2, 3], 1, [2, 0]);
  check('remapTableDataAxis gather', JSON.stringify(out) === JSON.stringify([2, 0, 12, 10]));
  const grown = M.remapTableDataAxis(data, [2, 3], 0, [0, 1, -1]);
  check('remapTableDataAxis grow+zero', JSON.stringify(grown) === JSON.stringify([0, 1, 2, 10, 11, 12, 0, 0, 0]));
}
{
  // remapTableDataForAxesChange: intRange 0..2 grows to 0..4 (labels match by name)
  const model = { attributes: [], variegatedCells: undefined };
  const mk = (min, max) => ({ axes: [{ name: 'X', source: { kind: 'intRange', min, max } }] });
  const rOld = M.resolveAxes(mk(0, 2), model);
  const rNew = M.resolveAxes(mk(0, 4), model);
  const out = M.remapTableDataForAxesChange([5, 6, 7], rOld, rNew, mk(0, 2).axes, mk(0, 4).axes);
  check('axesChange intRange grow', JSON.stringify(out) === JSON.stringify([5, 6, 7, 0, 0]));
  // min shift 0..2 → 1..3: value labels "1","2" survive, "3" is new
  const rShift = M.resolveAxes(mk(1, 3), model);
  const out2 = M.remapTableDataForAxesChange([5, 6, 7], rOld, rShift, mk(0, 2).axes, mk(1, 3).axes);
  check('axesChange intRange shift', JSON.stringify(out2) === JSON.stringify([6, 7, 0]));
  // append an axis: old data at index 0 of the new trailing axis
  const two = { axes: [{ name: 'X', source: { kind: 'intRange', min: 0, max: 2 } }, { name: 'Y', source: { kind: 'intRange', min: 0, max: 1 } }] };
  const rTwo = M.resolveAxes(two, model);
  const out3 = M.remapTableDataForAxesChange([5, 6, 7], rOld, rTwo, mk(0, 2).axes, two.axes);
  check('axesChange append axis', JSON.stringify(out3) === JSON.stringify([5, 0, 6, 0, 7, 0]));
  // remove-last: keep slice at index 0
  const out4 = M.remapTableDataForAxesChange([5, 0, 6, 0, 7, 0], rTwo, rOld, two.axes, mk(0, 2).axes);
  check('axesChange remove-last axis', JSON.stringify(out4) === JSON.stringify([5, 6, 7]));
}
{
  const nd = M.normalizeLookupTablePayload({ dims: [2, 3], data: [1, 2, 3, 4] });
  check('normalize payload dims-mode (zero-fill tail)', nd.length === 6 && nd[3] === 4 && nd[4] === 0 && nd[5] === 0);
}

// ---------------------------------------------------------------------------
// 2+3. The synthetic 3-axis coded-index model on JS + WASM
// ---------------------------------------------------------------------------
console.log('== synthetic 3-axis model (JS + WASM runtime) ==');
const used = new Set();
const nid = (p) => { let id; do { id = p + Math.random().toString(36).slice(2, 8); } while (used.has(id)); used.add(id); return id; };
const graphNodes = [], graphEdges = [];
const node = (nodeType, config) => { const n = { id: nid('n'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType, config } }; graphNodes.push(n); return n; };
const edge = (s, sp, t, tp, cat) => graphEdges.push({ id: nid('e'), source: s.id, target: t.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
const vEdge = (s, sp, t, tp) => edge(s, sp, t, tp, 'value');
const fEdge = (s, sp, t, tp) => edge(s, sp, t, tp, 'flow');

// dims: A 0..2 (3) × B 0..12 (13) × C 2..10 (9, min offset 2) = 351 entries
const D0 = 3, D1 = 13, D2 = 9, MIN2 = 2;
const tableData = new Array(D0 * D1 * D2);
for (let i0 = 0; i0 < D0; i0++) for (let i1 = 0; i1 < D1; i1++) for (let i2 = 0; i2 < D2; i2++) {
  tableData[(i0 * D1 + i1) * D2 + i2] = i0 * 10000 + i1 * 100 + i2;
}

const step = node('step', {});
const gA = node('getCellAttribute', { attributeId: 'a0' });
const gB = node('getCellAttribute', { attributeId: 'a1' });
const gC = node('getCellAttribute', { attributeId: 'a2' });
const lk = node('lookupInteraction', { tableId: 'T' });
vEdge(gA, 'value', lk, 'axis_0');
vEdge(gB, 'value', lk, 'axis_1');
vEdge(gC, 'value', lk, 'axis_2');
const wOut = node('setAttribute', { attributeId: 'out' });
fEdge(step, 'do', wOut, 'do');
vEdge(lk, 'value', wOut, 'value');

const W = 8, H = 8, TOTAL = W * H;
const model = M.migrateForHarness({
  schemaVersion: 2,
  properties: {
    name: 'NDTable Test', description: '', topology: '2d-grid',
    boundaryTreatment: 'torus', updateMode: 'synchronous',
    gridWidth: W, gridHeight: H, dimension: '2d', gridDepth: 1,
    useWasm: false,
  },
  attributes: [
    { id: 'a0', name: 'a0', type: 'integer', description: '', isModelAttribute: false, defaultValue: '0' },
    { id: 'a1', name: 'a1', type: 'integer', description: '', isModelAttribute: false, defaultValue: '0' },
    { id: 'a2', name: 'a2', type: 'integer', description: '', isModelAttribute: false, defaultValue: '0' },
    { id: 'out', name: 'out', type: 'float', description: '', isModelAttribute: false, defaultValue: '0' },
    {
      id: 'T', name: 'T', type: 'lookupTable', description: '', isModelAttribute: true, defaultValue: '0',
      axes: [
        { name: 'A', source: { kind: 'intRange', min: 0, max: 2 } },
        { name: 'B', source: { kind: 'intRange', min: 0, max: 12 } },
        { name: 'C', source: { kind: 'intRange', min: MIN2, max: 10 } },
      ],
      valueType: 'float',
      tableData,
    },
  ],
  neighborhoods: [],
  mappings: [],
  indicators: [],
  graphNodes, graphEdges, macroDefs: [],
  topologyMode: { gridCells: true, agents: false },
});

// Test inputs — deliberately include OUT-OF-RANGE values to prove the clamp.
const inA = new Int32Array(TOTAL), inB = new Int32Array(TOTAL), inC = new Int32Array(TOTAL);
for (let i = 0; i < TOTAL; i++) {
  inA[i] = (i % 7) - 2;            // -2..4  vs [0..2]
  inB[i] = ((i * 3) % 17) - 2;     // -2..14 vs [0..12]
  inC[i] = i % 14;                 // 0..13  vs [2..10] (min offset 2)
}
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const expected = new Float64Array(TOTAL);
for (let i = 0; i < TOTAL; i++) {
  const i0 = clamp(inA[i], 0, D0 - 1);
  const i1 = clamp(inB[i], 0, D1 - 1);
  const i2 = clamp(inC[i] - MIN2, 0, D2 - 1);
  expected[i] = tableData[(i0 * D1 + i1) * D2 + i2];
}

// --- JS target ---
const js = M.compileGraph(model.graphNodes, model.graphEdges, model);
check('JS compiles', !js.error, js.error ?? '');
let jsOut = null;
if (!js.error) {
  const m = /\(\s*function\s*\(([^)]*)\)/.exec(js.stepCode);
  check('JS stepCode has param list', !!m);
  const params = m[1].split(',').map(s => s.trim()).filter(Boolean);
  const bufs = {
    total: TOTAL,
    r_a0: inA, w_a0: new Int32Array(inA), r_a1: inB, w_a1: new Int32Array(inB),
    r_a2: inC, w_a2: new Int32Array(inC),
    r_out: new Float64Array(TOTAL), w_out: new Float64Array(TOTAL),
    modelAttrs: {}, colors: new Uint8ClampedArray(TOTAL * 4), activeViewer: '',
    _indicators: {},
    r_orientation: new Int32Array(TOTAL), w_orientation: new Int32Array(TOTAL),
    _facePatternLookup: new Int32Array(0),
    _lookupTables: { T: Float64Array.from(tableData) },
    _rngState: new Uint32Array([0x12345678]),
    _stopFlag: new Uint32Array(1),
    W, H, D: 1, WH: W * H,
    _linkedResults: {},
    glyphCodes: new Uint32Array(0), glyphColors: new Uint32Array(0),
    order: null, _skipped: new Uint8Array(0),
  };
  const missing = params.filter(p => !(p in bufs));
  check('JS params all resolvable', missing.length === 0, `unknown: ${missing.join(', ')}`);
  if (missing.length === 0) {
    const fn = (0, eval)(js.stepCode);
    fn(...params.map(p => bufs[p]));
    let bad = 0;
    for (let i = 0; i < TOTAL; i++) if (bufs.w_out[i] !== expected[i]) bad++;
    check('JS runtime coded-index + clamp (0 mismatches)', bad === 0, `${bad}/${TOTAL} mismatches`);
    jsOut = Float64Array.from(bufs.w_out);
  }
}

// --- WASM target ---
const layout = M.computeLayoutFromModel(model);
const wa = M.compileGraphWasm(model.graphNodes, model.graphEdges, model, layout, M.buildViewerIds(model));
check('WASM compiles', !wa.error, wa.error ?? '');
if (!wa.error) {
  check('WASM validates', WebAssembly.validate(wa.bytes.buffer.slice(wa.bytes.byteOffset, wa.bytes.byteOffset + wa.bytes.byteLength)));
  const mem = new WebAssembly.Memory({ initial: layout.pages });
  const env = { mem, pow: Math.pow, exp: Math.exp, log: Math.log, sin: Math.sin, cos: Math.cos, tan: Math.tan, tanh: Math.tanh, fmod: (a, b) => a % b };
  const { instance } = await WebAssembly.instantiate(wa.bytes, { env });
  // Fill inputs at the layout's baked offsets.
  new Int32Array(mem.buffer, layout.attrReadOffset['a0'], TOTAL).set(inA);
  new Int32Array(mem.buffer, layout.attrReadOffset['a1'], TOTAL).set(inB);
  new Int32Array(mem.buffer, layout.attrReadOffset['a2'], TOTAL).set(inC);
  const slot = layout.interactionTableOffsets['T'];
  check('WASM layout table slot has dims', !!slot && Array.isArray(slot.dims) && slot.dims.join(',') === `${D0},${D1},${D2}`);
  new Float64Array(mem.buffer, slot.offset, D0 * D1 * D2).set(tableData);
  instance.exports.step(TOTAL);
  const wOutArr = new Float64Array(mem.buffer, layout.attrWriteOffset['out'], TOTAL);
  let bad = 0;
  for (let i = 0; i < TOTAL; i++) if (wOutArr[i] !== expected[i]) bad++;
  check('WASM runtime coded-index + clamp (0 mismatches)', bad === 0, `${bad}/${TOTAL}`);
  if (jsOut) {
    let diff = 0;
    for (let i = 0; i < TOTAL; i++) if (wOutArr[i] !== jsOut[i]) diff++;
    check('JS ↔ WASM bit-identical', diff === 0, `${diff}/${TOTAL}`);
  }
}

// --- WebGPU target (emit-level: string + error check; device run in-browser) ---
const wg = M.compileGraphWebGPU(model.graphNodes, model.graphEdges, model);
check('WebGPU compiles', !wg.error, wg.error ?? '');
if (!wg.error) {
  const s = wg.shaderCode;
  check('WGSL has per-axis clamp', s.includes(', 0, 2)') && s.includes(', 0, 12)') && s.includes('- 2, 0, 8)'), 'clamp terms missing');
  check('WGSL has stride terms', s.includes(`* ${D1 * D2}`) && s.includes(`* ${D2}`), 'stride terms missing');
}

console.log(failures === 0 ? '\nALL ND-TABLE TESTS PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

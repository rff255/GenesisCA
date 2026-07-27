// Math node floor / ceil / round — functional verification.
//
// The three ops were added to `arithmeticOperator` on all five emit surfaces
// (JS / WASM / WebGPU cell + agent WASM / agent WebGPU). The parity rule:
// `round` = floor(x + 0.5) on EVERY target (never Math.round / f64.nearest /
// WGSL round(), whose banker's rounding diverges on .5 cases) — the same
// convention the Expression node's round() already uses.
//
// What this checks (values, not just "it compiled"):
//   1. A step that applies floor/ceil/round to a seeded input attribute RUNS on
//      JS and on a REAL instantiated WASM module in Node; outputs match the
//      hand-computed expectations (incl. round(2.5)=3, round(-2.5)=-2).
//   2. JS ↔ WASM bit-identical.
//   3. The WGSL emit uses floor()/ceil() and the floor(x+0.5) round form.
//
// Run from the repo root:  node scripts/test-math-int-ops.mjs
import { build } from 'esbuild';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
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
`;
const dir = mkdtempSync(join(tmpdir(), 'gca-mathops-'));
const entryPath = join(ROOT, 'scripts', '__mathops_entry.ts');
writeFileSync(entryPath, ENTRY);
const outPath = join(dir, 'bundle.mjs');
await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: process.cwd() });
const M = await import(pathToFileURL(outPath).href);

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ok  ${name}`);
  else { console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); failures++; }
};

const mkGraph = () => {
  const used = new Set();
  const nid = (p) => { let id; do { id = p + Math.random().toString(36).slice(2, 8); } while (used.has(id)); used.add(id); return id; };
  const nodes = [], edges = [];
  const n = (t, c = {}) => { const x = { id: nid('n'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; nodes.push(x); return x; };
  const e = (s, sp, t, tp, cat) => edges.push({ id: nid('e'), source: s.id, target: t.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
  return { nodes, edges, n, v: (s, sp, t, tp) => e(s, sp, t, tp, 'value'), f: (s, sp, t, tp) => e(s, sp, t, tp, 'flow') };
};
const cellAttr = (id) => ({ id, name: id, type: 'float', description: '', isModelAttribute: false, defaultValue: '0' });

// One input value per cell; each op writes its own output attribute.
const INPUTS = [2.5, -2.5, 2.4, -2.4, 3.7, -0.5];
const OPS = ['floor', 'ceil', 'round'];
const EXPECT = {
  floor: [2, -3, 2, -3, 3, -1],
  ceil: [3, -2, 3, -2, 4, -0],
  round: [3, -2, 2, -2, 4, 0], // floor(x + 0.5): round(2.5)=3, round(-2.5)=-2
};
const W = INPUTS.length, H = 1, TOTAL = W * H;

const g = mkGraph();
const step = g.n('step');
const get = g.n('getCellAttribute', { attributeId: 'xin' });
let prev = step, prevPort = 'do';
for (const op of OPS) {
  const math = g.n('arithmeticOperator', { operation: op });
  g.v(get, 'value', math, 'x');
  const set = g.n('setAttribute', { attributeId: `o_${op}` });
  g.v(math, 'result', set, 'value');
  g.f(prev, prevPort, set, 'do');
  prev = set; prevPort = 'next';
}

const model = M.migrateForHarness({
  schemaVersion: 2,
  properties: {
    name: 'MathIntOps', description: '', topology: '2d-grid',
    boundaryTreatment: 'torus', updateMode: 'synchronous',
    gridWidth: W, gridHeight: H, dimension: '2d', gridDepth: 1, useWasm: false,
  },
  attributes: ['xin', ...OPS.map(o => `o_${o}`)].map(cellAttr),
  neighborhoods: [], mappings: [], indicators: [],
  graphNodes: g.nodes, graphEdges: g.edges, macroDefs: [],
  topologyMode: { gridCells: true, agents: false },
});
const attrIds = ['xin', ...OPS.map(o => `o_${o}`)];

// --- JS ---
console.log('== JS ==');
const js = M.compileGraph(model.graphNodes, model.graphEdges, model);
check('JS compiles', !js.error, js.error ?? '');
let jsOut = null;
if (!js.error) {
  const params = /\(\s*function\s*\(([^)]*)\)/.exec(js.stepCode)[1].split(',').map(s => s.trim()).filter(Boolean);
  const bufs = {
    total: TOTAL, W, H, D: 1, WH: TOTAL,
    modelAttrs: {}, colors: new Uint8ClampedArray(TOTAL * 4), activeViewer: '',
    _indicators: {}, _linkedResults: {}, _rngState: new Uint32Array([0x12345678]),
    _stopFlag: new Uint32Array(1), glyphCodes: new Uint32Array(0), glyphColors: new Uint32Array(0),
    order: null, _skipped: new Uint8Array(0),
  };
  for (const id of attrIds) { bufs[`r_${id}`] = new Float64Array(TOTAL); bufs[`w_${id}`] = new Float64Array(TOTAL); }
  bufs.r_xin.set(INPUTS);
  const missing = params.filter(p => !(p in bufs));
  check('JS step params all resolvable', missing.length === 0, `unknown: ${missing.join(', ')}`);
  if (!missing.length) {
    (0, eval)(js.stepCode)(...params.map(p => bufs[p]));
    for (const op of OPS) {
      const got = Array.from(bufs[`w_o_${op}`]);
      check(`JS ${op}(${INPUTS.join(',')}) === [${EXPECT[op].join(',')}]`,
        got.every((v, i) => Object.is(v, EXPECT[op][i]) || v === EXPECT[op][i]), `got [${got.join(',')}]`);
    }
    jsOut = OPS.map(op => Float64Array.from(bufs[`w_o_${op}`]));
  }
}

// --- WASM (real module) ---
console.log('== WASM ==');
const layout = M.computeLayoutFromModel(model);
const wa = M.compileGraphWasm(model.graphNodes, model.graphEdges, model, layout, M.buildViewerIds(model));
check('WASM compiles', !wa.error, wa.error ?? '');
if (!wa.error) {
  const mem = new WebAssembly.Memory({ initial: layout.pages });
  const env = { mem, pow: Math.pow, exp: Math.exp, log: Math.log, sin: Math.sin, cos: Math.cos, tan: Math.tan, tanh: Math.tanh, fmod: (a, b) => a % b };
  const { instance } = await WebAssembly.instantiate(wa.bytes, { env });
  new Float64Array(mem.buffer, layout.attrReadOffset['xin'], TOTAL).set(INPUTS);
  instance.exports.step(TOTAL);
  let diff = 0;
  OPS.forEach((op, k) => {
    const a = new Float64Array(mem.buffer, layout.attrWriteOffset[`o_${op}`], TOTAL);
    check(`WASM ${op} === [${EXPECT[op].join(',')}]`,
      Array.from(a).every((v, i) => v === EXPECT[op][i]), `got [${Array.from(a).join(',')}]`);
    if (jsOut) for (let i = 0; i < TOTAL; i++) if (a[i] !== jsOut[k][i]) diff++;
  });
  if (jsOut) check('JS ↔ WASM bit-identical', diff === 0, `${diff} mismatches`);
}

// --- WebGPU (emit-level) ---
console.log('== WebGPU ==');
const wg = M.compileGraphWebGPU(model.graphNodes, model.graphEdges, model);
check('WebGPU compiles', !wg.error, wg.error ?? '');
if (!wg.error) {
  const s = wg.shaderCode;
  check('WGSL uses floor()', /floor\(/.test(s));
  check('WGSL uses ceil()', /ceil\(/.test(s));
  check('WGSL round is floor(x + 0.5), not round()', /floor\(\(.*\) \+ 0\.5\)/.test(s) && !/[^_a-zA-Z]round\(/.test(s));
}

rmSync(entryPath, { force: true });
rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);

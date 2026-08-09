// Math node unary ops — floor / ceil / round / negate — functional verification.
//
// The ops were added to `arithmeticOperator` on all five emit surfaces
// (JS / WASM / WebGPU cell + agent WASM / agent WebGPU). Two parity rules:
//   * `round` = floor(x + 0.5) on EVERY target (never Math.round / f64.nearest /
//     WGSL round(), whose banker's rounding diverges on .5 cases) — the same
//     convention the Expression node's round() already uses.
//   * `negate` = an IEEE sign flip: JS `-x` / WASM f64.neg / WGSL `-x` agree
//     bit-for-bit incl. -0 and NaN, and need no host import on any target.
//
// What this checks (values, not just "it compiled"):
//   1. A step that applies floor/ceil/round/negate to a seeded input attribute
//      RUNS on JS and on a REAL instantiated WASM module in Node; outputs match
//      the hand-computed expectations (incl. round(2.5)=3, round(-2.5)=-2).
//   2. JS ↔ WASM bit-identical.
//   3. negate's edge cases STRICTLY (Object.is): negate(0) is -0 (not 0) and
//      negate(NaN) is NaN — on both JS and WASM. The general comparator is
//      lenient about -0 (=== treats it as 0), so these need their own checks.
//   4. The WGSL emit uses floor()/ceil(), the floor(x+0.5) round form, and the
//      parenthesised unary minus.
//   5. negate emits + compiles on BOTH agent surfaces (agent WASM bytes, agent
//      WebGPU shader) — the node is universal, so all-target delivery includes
//      the agent loop.
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
export { migrateForHarness, compileAll } from '../src/dev/compileHarness.ts';
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
// The trailing 0 and NaN cells exist for negate's edge cases (-0 / NaN).
const INPUTS = [2.5, -2.5, 2.4, -2.4, 3.7, -0.5, 0, NaN];
const OPS = ['floor', 'ceil', 'round', 'negate'];
const EXPECT = {
  floor: [2, -3, 2, -3, 3, -1, 0, NaN],
  ceil: [3, -2, 3, -2, 4, -0, 0, NaN],
  round: [3, -2, 2, -2, 4, 0, 0, NaN], // floor(x + 0.5): round(2.5)=3, round(-2.5)=-2
  negate: [-2.5, 2.5, -2.4, 2.4, -3.7, 0.5, -0, NaN],
};
// NaN-aware, and lenient about -0 (=== treats it as 0) — negate's -0 is proven
// separately with a strict Object.is check below.
const eq = (a, b) => Object.is(a, b) || a === b;
const ZERO_CELL = INPUTS.indexOf(0), NAN_CELL = INPUTS.length - 1;
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
        got.every((v, i) => eq(v, EXPECT[op][i])), `got [${got.join(',')}]`);
    }
    // negate's edge cases, STRICTLY (the general comparator lets -0 pass as 0).
    const jsNeg = bufs.w_o_negate;
    check('JS negate(0) is -0 (Object.is)', Object.is(jsNeg[ZERO_CELL], -0), `got ${jsNeg[ZERO_CELL]}`);
    check('JS negate(NaN) is NaN', Number.isNaN(jsNeg[NAN_CELL]), `got ${jsNeg[NAN_CELL]}`);
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
      Array.from(a).every((v, i) => eq(v, EXPECT[op][i])), `got [${Array.from(a).join(',')}]`);
    // Object.is (not !==) so a -0 that should be 0 counts as a real mismatch.
    if (jsOut) for (let i = 0; i < TOTAL; i++) if (!Object.is(a[i], jsOut[k][i])) diff++;
  });
  const waNeg = new Float64Array(mem.buffer, layout.attrWriteOffset['o_negate'], TOTAL);
  check('WASM negate(0) is -0 (Object.is)', Object.is(waNeg[ZERO_CELL], -0), `got ${waNeg[ZERO_CELL]}`);
  check('WASM negate(NaN) is NaN', Number.isNaN(waNeg[NAN_CELL]), `got ${waNeg[NAN_CELL]}`);
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
  check('WGSL negate is a parenthesised unary minus', /\(-\(.+\)\)/.test(s));
}

// --- Agents: negate emits on BOTH agent surfaces (universal node) ---
// The Math node is available on the Agents graph too, so all-target delivery
// includes the agent WASM module and the agent WebGPU behaviour shader.
console.log('== Agents (negate) ==');
{
  const used = new Set();
  const nid = (p) => { let id; do { id = p + Math.random().toString(36).slice(2, 8); } while (used.has(id)); used.add(id); return id; };
  const aN = [], aEd = [];
  const an = (t, c) => { const n = { id: nid('a'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; aN.push(n); return n; };
  const aE = (s, sp, tt, tp, cat) => aEd.push({ id: nid('e'), source: s.id, target: tt.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
  const bs = an('behaviourStep', {});
  const get = an('getCellAttribute', { attributeId: 'v' });
  const neg = an('arithmeticOperator', { operation: 'negate' });
  const set = an('setAttribute', { attributeId: 'v' });
  aE(bs, 'do', set, 'do', 'flow');
  aE(get, 'value', neg, 'x', 'value');
  aE(neg, 'result', set, 'value', 'value');

  const agentModel = M.migrateForHarness({
    schemaVersion: 1,
    properties: { name: 'MathNegateAgents', dimension: '2d', gridWidth: 24, gridHeight: 24, gridDepth: 1, topology: '2d-grid', boundaryTreatment: 'torus', useWasm: false, useWebGPU: false },
    topologyMode: { gridCells: false, agents: true },
    centerBased: { enabled: true, maxAgents: 100, maxBonds: 0, worldWidth: 24, worldHeight: 24, seedCount: 20, seedPattern: 'scatter', defaultRadius: 0.5, growthRate: 0, repulsionStiffness: 2, adhesionStiffness: 0, interactionRange: 1.5, drag: 1, timeStep: 0.1, momentum: 0, maxSpeed: 0, neighbourQueryRadius: 8, useBondingPhysics: false, autoBond: false, agentTarget: 'wasm', agentUpdateMode: 'async',
      agentCapabilities: { motion: 'force', body: true, collision: 'off', bonds: 'off', autoBond: false, growth: false, division: false, lifespan: false, populationBirth: false, populationDeath: false, sensing: false, orientation: false, fieldCoupling: false, appearance: true } },
    attributes: [], modelAttributes: [], neighborhoods: [],
    agentAttributes: [{ id: 'v', name: 'V', type: 'float', description: '', isModelAttribute: false, defaultValue: '1.5' }],
    variables: [], agentVariables: [], indicators: [], mappings: [],
    graphNodes: [], graphEdges: [], agentGraphNodes: aN, agentGraphEdges: aEd, macroDefs: [],
  });

  const all = M.compileAll(agentModel);
  check('agent JS compiles', !all.agent.error, all.agent.error ?? '');
  check('agent JS emits the unary minus', /-\(/.test(all.agent.behaviourCode), all.agent.behaviourCode.slice(0, 200));
  check('agent WASM gate accepts negate', all.agent.wasm.supported, all.agent.wasm.error ?? 'gate rejected');
  check('agent WASM module built', !all.agent.wasm.error && all.agent.wasm.bytesLen > 0, all.agent.wasm.error ?? `${all.agent.wasm.bytesLen} bytes`);
  check('agent WebGPU gate accepts negate', all.agent.webgpu.supported, all.agent.webgpu.error ?? 'gate rejected');
  check('agent WGSL emits the parenthesised unary minus',
    !all.agent.webgpu.error && /\(-\(.+\)\)/.test(all.agent.webgpu.shaderCode), all.agent.webgpu.error ?? '');
}

rmSync(entryPath, { force: true });
rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);

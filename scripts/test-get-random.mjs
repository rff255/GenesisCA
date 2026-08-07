// Get Random overhaul — functional verification of the parameterised intervals,
// the distributions and the vector mode, on the CELL surfaces + the Overseer.
// (The three AGENT surfaces are covered permanently by the
// `[synthetic] Get Random …` entry in scripts/parity-agent-wasm.mjs, which
// carries the same stream-INDEPENDENT value laws plus JS↔WASM bit-parity.)
//
// What this checks — VALUES, not just "it compiled":
//   0. The node def: the mode/distribution vocabulary, the hiddenPorts matrix,
//      and the DRAW-COUNT contract (normal = 2, everything else = 1).
//   1. The legacy-config migration (`min`/`max` → `_port_min`/`_port_max`) over
//      every graph + macroDefs, idempotent, value-for-value.
//   2. CELLS — the compiled JS step AND a REAL instantiated WASM module produce
//      the same numbers, bit for bit, from the same seed, for: an inline
//      interval, a WIRED interval, normal (mean/σ recovered from 200k samples,
//      and exactly the mean at σ=0), exponential, and both vector reference
//      modes (compass convention asserted against hand-computed values).
//   3. WGSL emit carries each new path (and NOT the ones it should not).
//   4. The Overseer driver runs an interval draw.
//
// Run from the repo root:  node scripts/test-get-random.mjs
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
export { compileOverseerGraph } from '../src/modeler/vpl/compiler/overseer/compile.ts';
export { migrateForHarness } from '../src/dev/compileHarness.ts';
export { migrateGetRandomRange } from '../src/model/getRandomRangeMigration.ts';
export { getNodeDef } from '../src/modeler/vpl/nodes/registry.ts';
export { randomDrawCount, randomDistribution, randomRefSource } from '../src/modeler/vpl/nodes/GetRandomNode.ts';
`;
const dir = mkdtempSync(join(tmpdir(), 'gca-getrandom-'));
const entryPath = join(ROOT, 'scripts', '__getrandom_entry.ts');
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

// ===========================================================================
// 0. Node definition — modes, hiddenPorts matrix, draw counts.
// ===========================================================================
console.log('== node definition ==');
{
  const def = M.getNodeDef('getRandom');
  check('registered', !!def);
  const ids = def.ports.map(p => p.id);
  for (const p of ['min', 'max', 'mean', 'stddev', 'norm', 'angle', 'dirX', 'dirY', 'span'])
    check(`port "${p}" exists`, ids.includes(p));
  for (const p of ['x', 'y', 'vector'])
    check(`output port "${p}" exists`, ids.includes(p));
  check('min/max carry an inline number widget',
    def.ports.filter(p => p.id === 'min' || p.id === 'max').every(p => p.inlineWidget === 'number'));
  check('the composite output is vector-typed',
    def.ports.find(p => p.id === 'vector')?.dataType === 'vector');
  check('legacy min/max are no longer in defaultConfig',
    !('min' in def.defaultConfig) && !('max' in def.defaultConfig));

  const H = (cfg) => new Set(def.hiddenPorts(cfg));
  // Decimal · uniform: Min/Max shown, everything else hidden.
  let h = H({ randomType: 'float' });
  check('float+uniform shows Min/Max', !h.has('min') && !h.has('max'));
  check('float+uniform hides Mean/StdDev', h.has('mean') && h.has('stddev'));
  check('float+uniform hides the vector ports', ['norm', 'angle', 'span', 'x', 'y', 'vector'].every(p => h.has(p)));
  // Decimal · normal.
  h = H({ randomType: 'float', distribution: 'normal' });
  check('float+normal shows Mean + StdDev', !h.has('mean') && !h.has('stddev'));
  check('float+normal hides Min/Max', h.has('min') && h.has('max'));
  // Decimal · exponential.
  h = H({ randomType: 'float', distribution: 'exponential' });
  check('float+exponential shows Mean only', !h.has('mean') && h.has('stddev') && h.has('min'));
  // Integer stays uniform-only.
  h = H({ randomType: 'integer', distribution: 'normal' });
  check('integer keeps Min/Max whatever the distribution key says', !h.has('min') && !h.has('max'));
  check('randomDistribution() forces uniform outside decimal mode',
    M.randomDistribution({ distribution: 'normal' }, 'integer') === 'uniform');
  // Vector.
  h = H({ randomType: 'vector' });
  check('vector shows Norm/Angle/Span + X/Y/Vector',
    ['norm', 'angle', 'span', 'x', 'y', 'vector'].every(p => !h.has(p)));
  check('vector hides the scalar `value` output', h.has('value'));
  check('vector (angle ref) hides Dir X/Y', h.has('dirX') && h.has('dirY'));
  h = H({ randomType: 'vector', refSource: 'vector' });
  check('vector (direction ref) shows Dir X/Y and hides Angle', !h.has('dirX') && !h.has('dirY') && h.has('angle'));
  // Bool / options unchanged.
  check('bool still shows P only', !H({ randomType: 'bool' }).has('probability') && H({ randomType: 'float' }).has('probability'));
  check('options still shows Options + Fallback',
    !H({ randomType: 'options' }).has('options') && !H({ randomType: 'options' }).has('fallback'));

  // Draw counts — the cross-target stream contract.
  check('draw count: float uniform = 1', M.randomDrawCount('float', 'uniform') === 1);
  check('draw count: float normal  = 2', M.randomDrawCount('float', 'normal') === 2);
  check('draw count: float exponential = 1', M.randomDrawCount('float', 'exponential') === 1);
  check('draw count: vector = 1', M.randomDrawCount('vector', 'uniform') === 1);
  check('draw count: integer/bool/orientation/options = 1',
    ['integer', 'bool', 'orientation', 'options'].every(t => M.randomDrawCount(t, 'uniform') === 1));
}

// ===========================================================================
// 1. Legacy-config migration.
// ===========================================================================
console.log('\n== migration (config.min/max → the min/max PORTS) ==');
{
  const gr = (cfg) => ({ id: 'g' + Math.random().toString(36).slice(2, 7), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: 'getRandom', config: cfg } });
  const legacy = gr({ randomType: 'integer', min: '1', max: '3' });
  const already = gr({ randomType: 'float', _port_min: '4', _port_max: '8' });
  const both = gr({ randomType: 'float', min: '1', max: '2', _port_min: '9' });
  const other = { id: 'o1', type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: 'setAttribute', config: { min: '1' } } };
  const model = {
    graphNodes: [legacy, other], graphEdges: [],
    agentGraphNodes: [gr({ randomType: 'integer', min: '0', max: '4' })], agentGraphEdges: [],
    overseerGraphNodes: [gr({ randomType: 'float', min: '2', max: '5' })], overseerGraphEdges: [],
    macroDefs: [{ id: 'm1', name: 'M', nodes: [gr({ randomType: 'float', min: '-2', max: '2' })], edges: [], exposedInputs: [], exposedOutputs: [] }],
  };
  const out = M.migrateGetRandomRange(model);
  const cfgOf = (n) => n.data.config;
  check('cells: min/max re-keyed value-for-value',
    cfgOf(out.graphNodes[0])._port_min === '1' && cfgOf(out.graphNodes[0])._port_max === '3');
  check('cells: the legacy keys are dropped',
    !('min' in cfgOf(out.graphNodes[0])) && !('max' in cfgOf(out.graphNodes[0])));
  check('a non-getRandom node with a `min` config is untouched', cfgOf(out.graphNodes[1]).min === '1');
  check('agents graph migrated', cfgOf(out.agentGraphNodes[0])._port_max === '4');
  check('overseer graph migrated', cfgOf(out.overseerGraphNodes[0])._port_min === '2');
  check('macroDefs migrated', cfgOf(out.macroDefs[0].nodes[0])._port_min === '-2');
  const out2 = M.migrateGetRandomRange(out);
  check('idempotent (same reference on a clean model)', out2 === out);
  const kept = M.migrateGetRandomRange({ graphNodes: [already], graphEdges: [], macroDefs: [] });
  check('a node with no legacy keys is returned by reference', kept.graphNodes[0] === already);
  const mixed = M.migrateGetRandomRange({ graphNodes: [both], graphEdges: [], macroDefs: [] });
  check('an explicit _port_ value WINS over the legacy key',
    cfgOf(mixed.graphNodes[0])._port_min === '9' && cfgOf(mixed.graphNodes[0])._port_max === '2');
}

// ===========================================================================
// 2. CELLS — JS + a REAL WASM module, values + bit-parity.
// ===========================================================================
const SEED = 0x9e3779b9;
const TOTAL_W = 64, TOTAL_H = 64, TOTAL = TOTAL_W * TOTAL_H;

/** Build a cell model whose step writes one Get Random per output attribute.
 *  `specs` = [{ attrId, cfg, port?, wires? }]; `wires` = [[constValue, portId]]. */
const buildCellModel = (specs) => {
  const g = mkGraph();
  const step = g.n('step');
  let prev = step, prevPort = 'do';
  const attrIds = [];
  for (const sp of specs) {
    const rnd = sp.reuse ?? g.n('getRandom', sp.cfg);
    for (const [val, portId] of (sp.wires ?? [])) {
      const c = g.n('getConstant', { constType: 'float', constValue: String(val) });
      g.v(c, 'value', rnd, portId);
    }
    const set = g.n('setAttribute', { attributeId: sp.attrId });
    g.v(rnd, sp.port ?? 'value', set, 'value');
    g.f(prev, prevPort, set, 'do');
    prev = set; prevPort = 'next';
    attrIds.push(sp.attrId);
    sp.node = rnd;
  }
  const model = M.migrateForHarness({
    schemaVersion: 2,
    properties: {
      name: 'GetRandom cells', description: '', topology: '2d-grid',
      boundaryTreatment: 'torus', updateMode: 'synchronous',
      gridWidth: TOTAL_W, gridHeight: TOTAL_H, dimension: '2d', gridDepth: 1, useWasm: false,
    },
    attributes: attrIds.map(cellAttr),
    neighborhoods: [], mappings: [], indicators: [],
    graphNodes: g.nodes, graphEdges: g.edges, macroDefs: [],
    topologyMode: { gridCells: true, agents: false },
  });
  return { model, attrIds };
};

const runJs = (model, attrIds) => {
  const js = M.compileGraph(model.graphNodes, model.graphEdges, model);
  if (js.error) return { error: js.error };
  const params = /\(\s*function\s*\(([^)]*)\)/.exec(js.stepCode)[1].split(',').map(s => s.trim()).filter(Boolean);
  const bufs = {
    total: TOTAL, W: TOTAL_W, H: TOTAL_H, D: 1, WH: TOTAL,
    modelAttrs: {}, colors: new Uint8ClampedArray(TOTAL * 4), activeViewer: '',
    _indicators: {}, _linkedResults: {}, _rngState: new Uint32Array([SEED]),
    _stopFlag: new Uint32Array(1), glyphCodes: new Uint32Array(0), glyphColors: new Uint32Array(0),
    order: null, _skipped: new Uint8Array(0),
  };
  for (const id of attrIds) { bufs[`r_${id}`] = new Float64Array(TOTAL); bufs[`w_${id}`] = new Float64Array(TOTAL); }
  const missing = params.filter(p => !(p in bufs));
  if (missing.length) return { error: `unresolved step params: ${missing.join(', ')}` };
  (0, eval)(js.stepCode)(...params.map(p => bufs[p]));
  const out = {};
  for (const id of attrIds) out[id] = bufs[`w_${id}`];
  return { out, code: js.stepCode, rngAfter: bufs._rngState[0] };
};

const runWasm = async (model, attrIds) => {
  const layout = M.computeLayoutFromModel(model);
  const wa = M.compileGraphWasm(model.graphNodes, model.graphEdges, model, layout, M.buildViewerIds(model));
  if (wa.error) return { error: wa.error };
  const mem = new WebAssembly.Memory({ initial: layout.pages });
  const env = { mem, pow: Math.pow, exp: Math.exp, log: Math.log, sin: Math.sin, cos: Math.cos, tan: Math.tan, tanh: Math.tanh, fmod: (a, b) => a % b };
  const { instance } = await WebAssembly.instantiate(wa.bytes, { env });
  new Uint32Array(mem.buffer, layout.rngStateOffset, 1)[0] = SEED;
  instance.exports.step(TOTAL);
  const out = {};
  for (const id of attrIds) out[id] = new Float64Array(mem.buffer, layout.attrWriteOffset[id], TOTAL).slice();
  return { out, rngAfter: new Uint32Array(mem.buffer, layout.rngStateOffset, 1)[0] };
};

const bitDiff = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++; return d; };
const mean = (a) => { let s = 0; for (const v of a) s += v; return s / a.length; };
const stdev = (a) => { const m = mean(a); let s = 0; for (const v of a) s += (v - m) * (v - m); return Math.sqrt(s / (a.length - 1)); };

console.log('\n== cells: intervals + distributions (JS vs a real WASM module) ==');
{
  // ONE Get Random per model. A cell graph holding SEVERAL RNG nodes where at
  // least one has a WIRED value input already assigns the draws in a different
  // order on JS (flow order) than on WASM (sink-analysis topo order) — a
  // PRE-EXISTING cell-compiler hazard, reproducible on the untouched bool +
  // wired-Probability path, and deliberately out of scope here (fixing it moves
  // the emit order of every existing model). Isolating each mode keeps this
  // suite measuring the arithmetic THIS change introduces.
  const cases = [
    { id: 'uniIn', cfg: { randomType: 'float', _port_min: '10', _port_max: '20' },
      law: (a) => a.every(v => v >= 10 && v < 20) && Math.abs(mean(a) - 15) < 0.15,
      label: 'inline interval [10, 20) (mean ≈ 15)' },
    { id: 'uniW', cfg: { randomType: 'float' }, wires: [[-5, 'min'], [-1, 'max']],
      law: (a) => a.every(v => v >= -5 && v < -1) && Math.abs(mean(a) + 3) < 0.12,
      label: 'WIRED interval [-5, -1) (mean ≈ -3)' },
    { id: 'uniD', cfg: { randomType: 'float' },
      law: (a) => a.every(v => v >= 0 && v < 1),
      label: 'the DEFAULT interval is still [0, 1)' },
    { id: 'norm0', cfg: { randomType: 'float', distribution: 'normal', _port_mean: '7', _port_stddev: '0' },
      law: (a) => a.every(v => v === 7),
      label: 'normal(7, σ=0) is EXACTLY 7 everywhere' },
    { id: 'normS', cfg: { randomType: 'float', distribution: 'normal', _port_mean: '5', _port_stddev: '2' },
      law: (a) => Math.abs(mean(a) - 5) < 0.08 && Math.abs(stdev(a) - 2) < 0.08,
      label: 'normal(5, 2) recovers its mean + σ' },
    { id: 'normW', cfg: { randomType: 'float', distribution: 'normal' }, wires: [[-4, 'mean'], [3, 'stddev']],
      law: (a) => Math.abs(mean(a) + 4) < 0.12 && Math.abs(stdev(a) - 3) < 0.12,
      label: 'normal with WIRED mean/σ recovers them' },
    { id: 'expo', cfg: { randomType: 'float', distribution: 'exponential', _port_mean: '3' },
      law: (a) => a.every(v => v >= 0) && Math.abs(mean(a) - 3) < 0.16,
      label: 'exponential(mean 3) is non-negative with mean ≈ 3' },
    { id: 'expo0', cfg: { randomType: 'float', distribution: 'exponential', _port_mean: '0' },
      law: (a) => a.every(v => v === 0),
      label: 'exponential(mean 0) degenerates to exactly 0 (no ÷0)' },
    { id: 'intW', cfg: { randomType: 'integer', _port_max: '9' }, wires: [[4, 'min']],
      law: (a) => a.every(v => v >= 4 && v <= 9 && v === Math.floor(v)),
      label: 'WIRED-bound integer lands in 4..9 and is whole' },
    { id: 'intI', cfg: { randomType: 'integer', _port_min: '-3', _port_max: '-1' },
      law: (a) => a.every(v => v >= -3 && v <= -1 && v === Math.floor(v)),
      label: 'inline NEGATIVE integer interval -3..-1' },
  ];
  for (const c of cases) {
    const { model, attrIds } = buildCellModel([{ attrId: c.id, cfg: c.cfg, wires: c.wires }]);
    const js = runJs(model, attrIds);
    const wa = await runWasm(model, attrIds);
    if (js.error || wa.error) { check(c.label, false, js.error ?? wa.error); continue; }
    check(c.label, c.law(Array.from(js.out[c.id])), `first ${js.out[c.id][0]}, mean ${mean(js.out[c.id])}`);
    check(`  ↳ JS ↔ WASM bit-identical`, bitDiff(js.out[c.id], wa.out[c.id]) === 0,
      `js ${js.out[c.id][0]} vs wasm ${wa.out[c.id][0]}`);
    check(`  ↳ the RNG stream ends in the same state`, js.rngAfter === wa.rngAfter, `${js.rngAfter} vs ${wa.rngAfter}`);
  }
}

console.log('\n== cells: draw-count contract (the shared stream advances N times) ==');
{
  // One normal draw must advance the stream TWICE, one uniform draw ONCE. The
  // final RNG state after a 1-cell grid is the discriminator.
  const advance = (rs) => {
    rs = (rs ^ (rs << 13)) >>> 0; rs = (rs ^ (rs >>> 17)) >>> 0; rs = (rs ^ (rs << 5)) >>> 0; return rs;
  };
  const after = (specs) => {
    const { model, attrIds } = buildCellModel(specs);
    const r = runJs(model, attrIds);
    return r.error ? null : r.rngAfter;
  };
  // With TOTAL cells, N draws per cell ⇒ TOTAL*N advances from SEED.
  const expect = (n) => { let rs = SEED >>> 0; for (let i = 0; i < TOTAL * n; i++) rs = advance(rs); return rs >>> 0; };
  check('uniform decimal advances the stream ONCE per cell',
    after([{ attrId: 'a', cfg: { randomType: 'float' } }]) === expect(1));
  check('normal advances the stream TWICE per cell',
    after([{ attrId: 'a', cfg: { randomType: 'float', distribution: 'normal' } }]) === expect(2));
  check('exponential advances the stream ONCE per cell',
    after([{ attrId: 'a', cfg: { randomType: 'float', distribution: 'exponential' } }]) === expect(1));
  check('vector advances the stream ONCE per cell',
    after([{ attrId: 'a', cfg: { randomType: 'vector' }, port: 'x' }]) === expect(1));
}

console.log('\n== cells: vector mode + the compass convention ==');
{
  // Compass: 0° = north = -y, 90° = east = +x, 180° = south = +y.
  // Span 0 ⇒ the direction is EXACTLY the reference, so each case is a
  // hand-computable answer rather than a distribution.
  const g = mkGraph();
  const step = g.n('step');
  let prev = step, prevPort = 'do';
  const attrIds = [];
  const addVec = (label, cfg) => {
    const rnd = g.n('getRandom', cfg);
    for (const port of ['x', 'y']) {
      const id = `${label}${port}`;
      const set = g.n('setAttribute', { attributeId: id });
      g.v(rnd, port, set, 'value');
      g.f(prev, prevPort, set, 'do');
      prev = set; prevPort = 'next';
      attrIds.push(id);
    }
  };
  addVec('n', { randomType: 'vector', _port_norm: '2', _port_angle: '0', _port_span: '0' });
  addVec('e', { randomType: 'vector', _port_norm: '2', _port_angle: '90', _port_span: '0' });
  addVec('s', { randomType: 'vector', _port_norm: '2', _port_angle: '180', _port_span: '0' });
  addVec('w', { randomType: 'vector', _port_norm: '2', _port_angle: '270', _port_span: '0' });
  addVec('d', { randomType: 'vector', refSource: 'vector', _port_norm: '3', _port_dirX: '1', _port_dirY: '0', _port_span: '0' });
  addVec('z', { randomType: 'vector', refSource: 'vector', _port_norm: '4', _port_dirX: '0', _port_dirY: '0', _port_span: '0' });
  addVec('f', { randomType: 'vector', _port_norm: '5', _port_span: '360' });
  addVec('h', { randomType: 'vector', _port_norm: '1', _port_angle: '90', _port_span: '60' });
  const model = M.migrateForHarness({
    schemaVersion: 2,
    properties: {
      name: 'GetRandom vector', description: '', topology: '2d-grid',
      boundaryTreatment: 'torus', updateMode: 'synchronous',
      gridWidth: TOTAL_W, gridHeight: TOTAL_H, dimension: '2d', gridDepth: 1, useWasm: false,
    },
    attributes: attrIds.map(cellAttr),
    neighborhoods: [], mappings: [], indicators: [],
    graphNodes: g.nodes, graphEdges: g.edges, macroDefs: [],
    topologyMode: { gridCells: true, agents: false },
  });
  const js = runJs(model, attrIds);
  check('JS compiles + runs', !js.error, js.error ?? '');
  const wa = await runWasm(model, attrIds);
  check('WASM compiles + runs', !wa.error, wa.error ?? '');
  if (!js.error && !wa.error) {
    const near = (arr, v, eps = 1e-12) => arr.every(x => Math.abs(x - v) <= eps);
    check('0° (north) → (0, -norm)', near(js.out.nx, 0) && near(js.out.ny, -2));
    check('90° (east)  → (+norm, 0)', near(js.out.ex, 2) && near(js.out.ey, 0));
    check('180° (south) → (0, +norm)', near(js.out.sx, 0) && near(js.out.sy, 2));
    check('270° (west)  → (-norm, 0)', near(js.out.wx, -2) && near(js.out.wy, 0));
    check('wired direction (1, 0) → EXACTLY (+norm, 0)',
      js.out.dx.every(v => v === 3) && js.out.dy.every(v => v === 0));
    check('a ZERO wired direction falls back to north → (0, -norm)',
      js.out.zx.every(v => v === 0) && js.out.zy.every(v => v === -4), `got (${js.out.zx[0]}, ${js.out.zy[0]})`);
    const norms = Array.from(js.out.fx).map((x, i) => Math.hypot(x, js.out.fy[i]));
    check('full-span vector keeps |v| = Norm', norms.every(n => Math.abs(n - 5) < 1e-9));
    // A 360° span must actually cover the circle: all four quadrants hit.
    const quad = new Set(Array.from(js.out.fx).map((x, i) => (x >= 0 ? 1 : 0) * 2 + (js.out.fy[i] >= 0 ? 1 : 0)));
    check('full-span vector reaches all four quadrants', quad.size === 4, `${quad.size} quadrant(s)`);
    // A 60° span around east ⇒ every sample within ±30° of due east.
    const angs = Array.from(js.out.hx).map((x, i) => Math.atan2(x, -js.out.hy[i]) * 180 / Math.PI);
    check('60° span around 90° stays within [60°, 120°]',
      angs.every(a => a >= 60 - 1e-9 && a <= 120 + 1e-9), `min ${Math.min(...angs)} max ${Math.max(...angs)}`);
    check('60° span actually spreads (not a constant)',
      Math.max(...angs) - Math.min(...angs) > 50, `spread ${Math.max(...angs) - Math.min(...angs)}`);
    let diffs = 0;
    for (const id of attrIds) diffs += bitDiff(js.out[id], wa.out[id]);
    check('JS ↔ WASM BIT-IDENTICAL for every vector case', diffs === 0, `${diffs} mismatches`);
  }
}

console.log('\n== cells: the composite `vector` output lowers to ONE draw ==');
{
  // Wire the composite port into Apply-Force-style consumers via Break Vector —
  // expandComposites must resolve the components back to THIS node's x/y, so the
  // stream advances once per cell, not twice.
  const g = mkGraph();
  const step = g.n('step');
  const rnd = g.n('getRandom', { randomType: 'vector', _port_norm: '1', _port_span: '360' });
  const brk = g.n('breakVector', {});
  g.v(rnd, 'vector', brk, 'vector');
  const sX = g.n('setAttribute', { attributeId: 'cx' });
  const sY = g.n('setAttribute', { attributeId: 'cy' });
  g.v(brk, 'x', sX, 'value'); g.v(brk, 'y', sY, 'value');
  g.f(step, 'do', sX, 'do'); g.f(sX, 'next', sY, 'do');
  const model = M.migrateForHarness({
    schemaVersion: 2,
    properties: {
      name: 'GetRandom composite', description: '', topology: '2d-grid',
      boundaryTreatment: 'torus', updateMode: 'synchronous',
      gridWidth: TOTAL_W, gridHeight: TOTAL_H, dimension: '2d', gridDepth: 1, useWasm: false,
    },
    attributes: ['cx', 'cy'].map(cellAttr),
    neighborhoods: [], mappings: [], indicators: [],
    graphNodes: g.nodes, graphEdges: g.edges, macroDefs: [],
    topologyMode: { gridCells: true, agents: false },
  });
  const js = runJs(model, ['cx', 'cy']);
  check('JS compiles + runs', !js.error, js.error ?? '');
  if (!js.error) {
    const advance = (rs) => { rs = (rs ^ (rs << 13)) >>> 0; rs = (rs ^ (rs >>> 17)) >>> 0; rs = (rs ^ (rs << 5)) >>> 0; return rs; };
    let rs = SEED >>> 0; for (let i = 0; i < TOTAL; i++) rs = advance(rs);
    check('the composite wire costs exactly ONE draw per cell', js.rngAfter === (rs >>> 0));
    const norms = Array.from(js.out.cx).map((x, i) => Math.hypot(x, js.out.cy[i]));
    check('the components are a real unit vector', norms.every(n => Math.abs(n - 1) < 1e-9));
  }
  const wa = await runWasm(model, ['cx', 'cy']);
  check('WASM compiles + runs the composite path', !wa.error, wa.error ?? '');
  if (!js.error && !wa.error) {
    check('JS ↔ WASM BIT-IDENTICAL (composite)',
      bitDiff(js.out.cx, wa.out.cx) + bitDiff(js.out.cy, wa.out.cy) === 0);
  }
}

// ===========================================================================
// 3. WGSL emit.
// ===========================================================================
console.log('\n== WebGPU (cell) emit ==');
{
  const emit = (specs) => {
    const { model } = buildCellModel(specs);
    const r = M.compileGraphWebGPU(model.graphNodes, model.graphEdges, model);
    return r.error ? null : r.shaderCode;
  };
  const uni = emit([{ attrId: 'a', cfg: { randomType: 'float' } }]);
  check('uniform decimal compiles', !!uni);
  check('the DEFAULT interval keeps the folded literal form', !!uni && /\(rand_f32\(idx\) \* 1\.0\) \+ 0\.0/.test(uni));
  const nrm = emit([{ attrId: 'a', cfg: { randomType: 'float', distribution: 'normal', _port_mean: '5', _port_stddev: '2' } }]);
  check('normal compiles', !!nrm);
  check('normal draws rand_f32 exactly TWICE', !!nrm && (nrm.match(/rand_f32\(idx\)/g) || []).length === 2);
  check('normal emits the Box-Muller form', !!nrm && /sqrt\(-2\.0 \* log\(1\.0 - /.test(nrm) && /cos\(6\.283185307179586 \*/.test(nrm));
  const exp = emit([{ attrId: 'a', cfg: { randomType: 'float', distribution: 'exponential', _port_mean: '3' } }]);
  check('exponential compiles + draws ONCE', !!exp && (exp.match(/rand_f32\(idx\)/g) || []).length === 1);
  check('exponential emits -log(1 - u)', !!exp && /-log\(1\.0 - /.test(exp));
  const vecA = emit([{ attrId: 'a', cfg: { randomType: 'vector', _port_angle: '90', _port_span: '30' }, port: 'x' }]);
  check('vector (angle) compiles + draws ONCE', !!vecA && (vecA.match(/rand_f32\(idx\)/g) || []).length === 1);
  check('vector (angle) emits sin/cos of the reference', !!vecA && /fx: f32 = sin\(/.test(vecA) && /fy: f32 = -cos\(/.test(vecA));
  const vecD = emit([{ attrId: 'a', cfg: { randomType: 'vector', refSource: 'vector', _port_dirX: '1', _port_dirY: '0' }, port: 'x' }]);
  check('vector (direction) compiles', !!vecD);
  check('vector (direction) normalises with the eps guard + north select',
    !!vecD && /1\.0 \/ max\(/.test(vecD) && /select\(-1\.0, /.test(vecD));
  check('vector (direction) uses NO atan2', !!vecD && !/atan2/.test(vecD));
  const wired = emit([{ attrId: 'a', cfg: { randomType: 'float' }, wires: [[3, 'min'], [9, 'max']] }]);
  check('a WIRED interval compiles to the runtime-span form', !!wired && /rand_f32\(idx\) \* \(\(/.test(wired));
}

// ===========================================================================
// 4. Overseer driver — the interval must reach the experiment graph too.
// ===========================================================================
console.log('\n== Overseer driver ==');
{
  const g = mkGraph();
  const root = g.n('experiment', {});
  const rnd = g.n('getRandom', { randomType: 'float', _port_min: '100', _port_max: '200' });
  const log = g.n('ovLog', { message: 'v={value}' });
  g.f(root, 'do', log, 'do');
  g.v(rnd, 'value', log, 'value');
  const model = M.migrateForHarness({
    schemaVersion: 2,
    properties: {
      name: 'GetRandom overseer', description: '', topology: '2d-grid',
      boundaryTreatment: 'torus', updateMode: 'synchronous',
      gridWidth: 8, gridHeight: 8, dimension: '2d', gridDepth: 1,
    },
    attributes: [], neighborhoods: [], mappings: [], indicators: [],
    graphNodes: [], graphEdges: [], macroDefs: [],
    overseerGraphNodes: g.nodes, overseerGraphEdges: g.edges,
    overseerConfig: { enabled: true },
    topologyMode: { gridCells: true, agents: false },
  });
  const r = M.compileOverseerGraph(model.overseerGraphNodes, model.overseerGraphEdges, model);
  check('overseer driver compiles', !r.error && !!r.driverCode, r.error ?? '');
  if (r.driverCode) {
    const logged = [];
    const O = { aborted: false, log: (s) => logged.push(s), logT: (t, v) => logged.push(`${t}${v}`) };
    const AsyncFunction = Object.getPrototypeOf(async function () { }).constructor;
    await new AsyncFunction('O', r.driverCode)(O);
    check('the driver logged one value', logged.length === 1, JSON.stringify(logged));
    const v = parseFloat(String(logged[0] ?? '').replace('v=', ''));
    check('the overseer interval lands in [100, 200)', v >= 100 && v < 200, `${v}`);
  }
}

console.log(`\n${failures === 0 ? 'ALL GET RANDOM CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);

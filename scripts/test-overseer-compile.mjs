// DEV check — compiles synthetic Overseer graphs and RUNS the emitted async
// driver against a mock O API, asserting end-to-end semantics (loops, value
// re-evaluation, action results, sweeps, conditionals) without a browser.
// Run from the repo root:  node scripts/test-overseer-compile.mjs
import { build } from 'esbuild';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = `
export { compileOverseerGraph } from '../src/modeler/vpl/compiler/overseer/compile.ts';
`;
const dir = mkdtempSync(join(tmpdir(), 'gca-ov-'));
const entryPath = join(ROOT, 'scripts', '__ov_entry.ts');
writeFileSync(entryPath, ENTRY);
const outPath = join(dir, 'bundle.mjs');
await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: process.cwd() });
const { compileOverseerGraph } = await import(pathToFileURL(outPath).href);

// ---------------------------------------------------------------- scaffolding
let nid = 0;
const node = (nodeType, config = {}) => ({
  id: `n${++nid}`,
  type: 'caNode',
  position: { x: nid * 100, y: 0 },
  data: { nodeType, config },
});
const fEdge = (src, srcPort, tgt, tgtPort = 'do') => ({
  id: `e${src.id}_${srcPort}_${tgt.id}`,
  source: src.id, target: tgt.id,
  sourceHandle: `output_flow_${srcPort}`, targetHandle: `input_flow_${tgtPort}`,
});
const vEdge = (src, srcPort, tgt, tgtPort) => ({
  id: `v${src.id}_${srcPort}_${tgt.id}_${tgtPort}`,
  source: src.id, target: tgt.id,
  sourceHandle: `output_value_${srcPort}`, targetHandle: `input_value_${tgtPort}`,
});
const MODEL = {
  schemaVersion: 1,
  properties: { name: 'ov-test', boundaryTreatment: 'torus', gridWidth: 8, gridHeight: 8, updateMode: 'synchronous' },
  attributes: [
    { id: 'gravity', name: 'gravity', type: 'float', isModelAttribute: true, defaultValue: '2' },
  ],
  neighborhoods: [], mappings: [], indicators: [
    { id: 'ind1', name: 'alive', kind: 'standalone', dataType: 'integer', defaultValue: '0', accumulationMode: 'per-generation', watched: true },
  ],
  graphNodes: [], graphEdges: [], macroDefs: [],
  overseerConfig: { enabled: true },
};

class MockO {
  constructor() {
    this.gen = 0; this.resets = 0; this.runs = []; this.seeds = [];
    this.attrs = { gravity: 2 };
    this.modelAttrs = { gravity: 2 };
    this.seriesStore = new Map();
    this.logs = []; this.stops = [];
    this.initialSeed = 999;
    this.aborted = false;
  }
  async reset() { this.resets++; this.gen = 0; }
  async run(n) { this.runs.push(n); this.gen += n; }
  async runUntilStop(cap) {
    const at = Math.min(cap, 40 + (this.attrs.gravity | 0));
    this.gen = at;
    return { atGeneration: at, stoppedBy: at < cap ? 1 : 0 };
  }
  async setSeed(s) { this.seeds.push(s); }
  async setAttr(id, v) { this.attrs[id] = v; this.modelAttrs[id] = v; }
  async loadPreset() { /* noop */ }
  indicator(id, cat) { return id === 'ind1' ? 100 + this.gen : (cat ? 7 : 0); }
  generation() { return this.gen; }
  sample(name, v, scope) {
    const s = this.seriesStore.get(name) ?? { scope, values: [] };
    s.values.push(v); this.seriesStore.set(name, s);
  }
  stat(name, op) {
    const vals = this.seriesStore.get(name)?.values ?? [];
    if (op === 'count') return vals.length;
    if (!vals.length) return 0;
    if (op === 'mean') return vals.reduce((a, b) => a + b, 0) / vals.length;
    if (op === 'sum') return vals.reduce((a, b) => a + b, 0);
    if (op === 'max') return Math.max(...vals);
    return 0;
  }
  clearSeries(name) { this.seriesStore.get(name)?.values.splice(0); }
  log(t) { this.logs.push(t); }
  logT(tpl, v) {
    this.logs.push(tpl.split('{value}').join(v === undefined ? '' : String(Math.round(v * 1e6) / 1e6)).split('{gen}').join(String(this.gen)));
  }
  stopExperiment(m) { this.stops.push(m); }
  async screenshot() {} async startRecording() {} async stopRecording() {}
  linspace(a, b, n) { return n === 1 ? [a] : Array.from({ length: n }, (_, i) => a + i * (b - a) / (n - 1)); }
  trace() {}
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
let failures = 0;
const assert = (cond, label) => {
  if (cond) console.log('  PASS  ' + label);
  else { failures++; console.log('  FAIL  ' + label); }
};

// -------------------------------------------------- Test 1: the statistics loop
{
  nid = 0;
  const root = node('experiment');
  const loop = node('loop', { _port_count: '3' });
  const reset = node('ovResetBoard');
  const runG = node('ovRunGenerations', { _port_count: '10' });
  const read = node('ovReadIndicator', { indicatorId: 'ind1' });
  const coll = node('ovCollectSample', { series: 'alive', scope: 'experiment' });
  const stat = node('ovSeriesStat', { series: 'alive', op: 'mean' });
  const log = node('ovLog', { text: 'mean = {value} (gen {gen})' });
  const nodes = [root, loop, reset, runG, read, coll, stat, log];
  const edges = [
    fEdge(root, 'do', loop),
    fEdge(loop, 'body', reset),
    fEdge(reset, 'next', runG),
    fEdge(runG, 'next', coll),
    vEdge(read, 'value', coll, 'value'),
    fEdge(loop, 'next', log),
    vEdge(stat, 'result', log, 'value'),
  ];
  const r = compileOverseerGraph(nodes, edges, MODEL);
  assert(!r.error, 'T1 compiles without error' + (r.error ? ` (${r.error})` : ''));
  assert(!!r.driverCode, 'T1 produced driver code');
  const O = new MockO();
  await new AsyncFunction('O', r.driverCode)(O);
  assert(O.resets === 3, `T1 3 resets (got ${O.resets})`);
  assert(O.runs.length === 3 && O.runs.every(n => n === 10), `T1 3 runs of 10 (got ${JSON.stringify(O.runs)})`);
  const alive = O.seriesStore.get('alive')?.values ?? [];
  assert(alive.length === 3 && alive.every(v => v === 110), `T1 samples = [110,110,110] (got ${JSON.stringify(alive)}) — Read Indicator re-evaluated post-run`);
  assert(O.logs.length === 1 && O.logs[0] === 'mean = 110 (gen 10)', `T1 log line (got ${JSON.stringify(O.logs)})`);
}

// ------------------------------- Test 2: sweep × until-stop with action results
{
  nid = 0;
  const root = node('experiment');
  const sweep = node('ovSweepValues', { mode: 'list', list: '1, 2, 5' });
  const each = node('forEachInArray');
  const setA = node('ovSetModelAttribute', { attributeId: 'gravity' });
  const reset = node('ovResetBoard');
  const until = node('ovRunUntilStop', { _port_maxGens: '50' });
  const coll = node('ovCollectSample', { series: 'elution', scope: 'experiment' });
  const log = node('ovLog', { text: 'n = {value}' });
  const cnt = node('ovSeriesStat', { series: 'elution', op: 'count' });
  const nodes = [root, sweep, each, setA, reset, until, coll, log, cnt];
  const edges = [
    fEdge(root, 'do', each),
    vEdge(sweep, 'values', each, 'array'),
    fEdge(each, 'body', setA),
    vEdge(each, 'element', setA, 'value'),
    fEdge(setA, 'next', reset),
    fEdge(reset, 'next', until),
    fEdge(until, 'next', coll),
    vEdge(until, 'atGeneration', coll, 'value'),
    fEdge(each, 'next', log),
    vEdge(cnt, 'result', log, 'value'),
  ];
  const r = compileOverseerGraph(nodes, edges, MODEL);
  assert(!r.error, 'T2 compiles without error' + (r.error ? ` (${r.error})` : ''));
  const O = new MockO();
  await new AsyncFunction('O', r.driverCode)(O);
  const el = O.seriesStore.get('elution')?.values ?? [];
  assert(JSON.stringify(el) === JSON.stringify([41, 42, 45]), `T2 elution gens track the swept attr (got ${JSON.stringify(el)})`);
  assert(O.attrs.gravity === 5, `T2 last swept value applied (got ${O.attrs.gravity})`);
  assert(O.logs[0] === 'n = 3', `T2 count log (got ${JSON.stringify(O.logs)})`);
}

// ------------------------- Test 3: conditional + stop experiment + universal math
{
  nid = 0;
  const root = node('experiment');
  const reset = node('ovResetBoard');
  const runG = node('ovRunGenerations', { _port_count: '20' });
  const read = node('ovReadIndicator', { indicatorId: 'ind1' });
  const cmp = node('statement', { operation: '>', compareType: 'numerical', _port_y: '110' });
  const cond = node('conditional');
  const stop = node('ovStopExperiment', { message: 'target reached' });
  const log = node('ovLog', { text: 'below target' });
  const after = node('ovLog', { text: 'should never run' });
  const nodes = [root, reset, runG, read, cmp, cond, stop, log, after];
  const edges = [
    fEdge(root, 'do', reset),
    fEdge(reset, 'next', runG),
    fEdge(runG, 'next', cond, 'check'),
    vEdge(read, 'value', cmp, 'x'),
    vEdge(cmp, 'result', cond, 'condition'),
    fEdge(cond, 'then', stop),
    fEdge(cond, 'else', log),
    fEdge(stop, 'do', after), // no output port on stop — dead edge, must be ignored
  ];
  // gen after 20 steps = 20 → indicator 120 > 110 → THEN → stop
  const r = compileOverseerGraph(nodes, edges, MODEL);
  assert(!r.error, 'T3 compiles without error' + (r.error ? ` (${r.error})` : ''));
  const O = new MockO();
  await new AsyncFunction('O', r.driverCode)(O);
  assert(O.stops.length === 1 && O.stops[0] === 'target reached', `T3 stopExperiment fired (got ${JSON.stringify(O.stops)})`);
  assert(!O.logs.includes('below target') && !O.logs.includes('should never run'), `T3 else/after branches skipped (got ${JSON.stringify(O.logs)})`);
}

// ------------------------------ Test 4: guards — no root / disallowed node type
{
  nid = 0;
  const r0 = compileOverseerGraph([], [], MODEL);
  assert(r0.driverCode === null && r0.error === null, 'T4 empty graph → null driver, no error');
  const root = node('experiment');
  const bad = node('setCellLooks', {});
  const r1 = compileOverseerGraph([root, bad], [fEdge(root, 'do', bad)], MODEL);
  assert(!!r1.error, `T4 per-cell node in the chain is rejected (${r1.error ?? 'no error!'})`);
}

// ------------------------------- Test 5: getRandom determinism via initial seed
{
  nid = 0;
  const root = node('experiment');
  const rand = node('getRandom', { randomType: 'integer', min: '0', max: '1000000' });
  const coll = node('ovCollectSample', { series: 'r', scope: 'experiment' });
  const coll2 = node('ovCollectSample', { series: 'r', scope: 'experiment' });
  const nodes = [root, rand, coll, coll2];
  const edges = [
    fEdge(root, 'do', coll),
    vEdge(rand, 'value', coll, 'value'),
    fEdge(coll, 'next', coll2),
    vEdge(rand, 'value', coll2, 'value'),
  ];
  const r = compileOverseerGraph(nodes, edges, MODEL);
  assert(!r.error, 'T5 compiles without error' + (r.error ? ` (${r.error})` : ''));
  const O1 = new MockO(); await new AsyncFunction('O', r.driverCode)(O1);
  const O2 = new MockO(); await new AsyncFunction('O', r.driverCode)(O2);
  const a = O1.seriesStore.get('r')?.values ?? [];
  const b = O2.seriesStore.get('r')?.values ?? [];
  assert(a.length === 2 && JSON.stringify(a) === JSON.stringify(b), `T5 same seed → same draws (${JSON.stringify(a)} vs ${JSON.stringify(b)})`);
  assert(a[0] !== a[1], `T5 two consuming statements → two draws (got ${JSON.stringify(a)})`);
}

console.log(failures === 0 ? '\nALL OVERSEER COMPILE TESTS PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

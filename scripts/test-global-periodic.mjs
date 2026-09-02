// GLOBAL PERIODIC EVENTS — Grid Periodic Event (cells) + Population Periodic
// Event (agents). The once-per-firing-generation counterpart to the PER-AGENT
// `Agent Periodic Step`.
//
// What this checks — VALUES, through the SHIPPED code, not "it compiled":
//
//   A. Editor surface + the rename. `periodicStep` KEEPS its type id but reads
//      "Agent Periodic Step"; the two global roots are registered, are NOT
//      singletons, and are graph-scoped (grid on Cells only, population on
//      Agents only). Depth ports appear only in 3D.
//
//   B. CADENCE — the firing set. `generation % period === phase`, with the
//      SHARED `periodicParams` clamp (period >= 1, phase folded into range) so
//      a hand-edited 0/negative period can never divide by zero or never fire.
//
//   C. CELLS, run for real. The compiled Grid Periodic fn is executed with the
//      worker's EXACT buffer discipline (sync: w.set(r) -> run -> r.set(w)) over
//      views into a REAL instantiated WASM module's memory — then the WASM
//      `step` runs and must SEE the write. That is the integration claim the
//      whole JS-on-CPU-root architecture rests on: one JS function, every
//      compile target, because both sides address the same bytes.
//      Also: the value-outs (width/height/depth/stepIndex) carry real numbers.
//
//   D. AGENTS, run for real. The compiled Population Periodic fn is called
//      through the SHARED `buildAgentAbiArgs('init', ...)` with a replica of the
//      worker's GROW-ONLY spawn closures, against a REAL `createAgentStore`.
//      Spawns land at exact positions, are bounded by maxAgents (a Create past
//      the ceiling returns -1 and NOTHING wraps), and a Created-but-not-Added
//      slot is leak-swept.
//
//   E. The ABI-REUSE claim: the periodic fn's parameter list is EXACTLY the
//      Agent Init Event's (`buildAgentInitParams`) — that is what makes the
//      root free of any new ABI kind, arg builder or descriptor arm.
//
//   F. RESIDENCY — the correctness term. A model carrying either root MUST
//      block the GPU-resident batch, or the resident batch (one submit for N
//      generations, no CPU touch point) silently skips every firing.
//
//   G. The hot-path no-op: a graph with neither root emits NO periodic code, so
//      every existing model is byte-identical by construction.
//
// Run from the repo root:  node scripts/test-global-periodic.mjs
import { build } from 'esbuild';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = `
export { compileGraph, compileAgentGraph, buildAgentInitParams, agentAbiShapeOf } from '../src/modeler/vpl/compiler/compile.ts';
export { compileGraphWasm } from '../src/modeler/vpl/compiler/wasm/compile.ts';
export { computeLayoutFromModel, buildViewerIds } from '../src/modeler/vpl/compiler/wasm/layout.ts';
export { periodicParams } from '../src/modeler/vpl/compiler/periodicExpand.ts';
export { buildAgentAbiArgs, buildAgentAbiParams } from '../src/modeler/vpl/compiler/agentAbi.ts';
export { createAgentStore, initAgentSlot, freeStagedSlot } from '../src/simulator/engine/agentEngine.ts';
export { residencyModelBlockers } from '../src/model/agentResidency.ts';
export { resolveAgentFieldGates } from '../src/model/agentFieldGating.ts';
export { agentAttrsOf, bondAttrsOf, cellFieldAttrsOf } from '../src/model/attributeScope.ts';
export { migrateForHarness } from '../src/dev/compileHarness.ts';
export { isNodeAvailable } from '../src/modeler/vpl/nodes/nodeValidation.ts';
export { setActiveGraphKind } from '../src/modeler/vpl/graphState.ts';
export { getNodeDef, ALL_NODES } from '../src/modeler/vpl/nodes/registry.ts';
`;
const dir = mkdtempSync(join(tmpdir(), 'gca-gperiodic-'));
const entryPath = join(ROOT, 'scripts', '__gperiodic_entry.ts');
writeFileSync(entryPath, ENTRY);
const outPath = join(dir, 'bundle.mjs');
await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: process.cwd() });
const M = await import(pathToFileURL(outPath).href);

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ok  ${name}`);
  else { console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); failures++; }
};
const section = (t) => console.log(`\n== ${t} ==`);

// --- tiny graph builders (the conventions the other scripts use) ------------
const mkGraph = () => {
  const used = new Set();
  const nid = (p) => { let id; do { id = p + Math.random().toString(36).slice(2, 8); } while (used.has(id)); used.add(id); return id; };
  const nodes = [], edges = [];
  const n = (t, c = {}) => { const x = { id: nid('n'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; nodes.push(x); return x; };
  const e = (s, sp, t, tp, cat) => edges.push({ id: nid('e'), source: s.id, target: t.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
  return { nodes, edges, n, v: (s, sp, t, tp) => e(s, sp, t, tp, 'value'), f: (s, sp, t, tp) => e(s, sp, t, tp, 'flow') };
};
const cellAttr = (id) => ({ id, name: id, type: 'float', description: '', isModelAttribute: false, defaultValue: '0' });
const agentAttr = (id) => ({ id, name: id, type: 'float', description: '', defaultValue: '0' });

const cellModel = (g, extra = {}) => M.migrateForHarness({
  schemaVersion: 2,
  properties: {
    name: 'GP', description: '', topology: '2d-grid', boundaryTreatment: 'torus',
    updateMode: 'synchronous', gridWidth: 8, gridHeight: 6, dimension: '2d', gridDepth: 1,
    useWasm: false, ...(extra.properties ?? {}),
  },
  attributes: [cellAttr('og')], neighborhoods: [], mappings: [], indicators: [],
  graphNodes: g.nodes, graphEdges: g.edges, macroDefs: [],
  topologyMode: { gridCells: true, agents: false },
  ...extra,
});

// ===========================================================================
section('A. Editor surface + the rename');
// ===========================================================================
{
  const ps = M.getNodeDef('periodicStep');
  const gp = M.getNodeDef('gridPeriodic');
  const ap = M.getNodeDef('agentPeriodic');
  check('periodicStep KEEPS its type id', !!ps && ps.type === 'periodicStep');
  check('periodicStep label is "Agent Periodic Step"', ps?.label === 'Agent Periodic Step', ps?.label);
  check('periodicStep description leads with PER AGENT', /runs\s+PER\s+AGENT/i.test(ps?.description ?? ''), ps?.description?.slice(0, 60));
  check('gridPeriodic registered', !!gp);
  check('agentPeriodic registered', !!ap);
  check('gridPeriodic label', gp?.label === 'Grid Periodic Event', gp?.label);
  check('agentPeriodic label', ap?.label === 'Population Periodic Event', ap?.label);
  // A GLOBAL root must say so, or it is the very confusion this feature fixes.
  check('gridPeriodic description says GLOBALLY', /GLOBALLY/.test(gp?.description ?? ''));
  check('agentPeriodic description says GLOBALLY', /GLOBALLY/.test(ap?.description ?? ''));
  check('both are event roots (white)', gp?.category === 'event' && ap?.category === 'event' && gp?.color === '#ffffff' && ap?.color === '#ffffff');

  // NOT singletons — several cadences per graph is the point (as for periodicStep).
  // The set is a GraphEditor-local const (importing it would drag React Flow into
  // this bundle), so pin it in SOURCE — which also catches a careless addition.
  const geSrc = readFileSync(join(ROOT, 'src/modeler/vpl/GraphEditor.tsx'), 'utf8');
  const singletons = /const SINGLETON_NODE_TYPES = new Set\(\[([^\]]*)\]\)/.exec(geSrc)?.[1] ?? '';
  check('the singleton set was found in GraphEditor', singletons.length > 0);
  check('gridPeriodic is NOT a singleton', !singletons.includes("'gridPeriodic'"), singletons);
  check('agentPeriodic is NOT a singleton', !singletons.includes("'agentPeriodic'"), singletons);
  check('periodicStep is still NOT a singleton', !singletons.includes("'periodicStep'"), singletons);

  // Graph scoping. gridPeriodic is LATTICE-only; agentPeriodic is agent-only.
  const agentsModel = M.migrateForHarness({
    schemaVersion: 2,
    properties: { name: 'A', description: '', topology: '2d-grid', boundaryTreatment: 'torus', updateMode: 'synchronous', gridWidth: 8, gridHeight: 8, dimension: '2d', gridDepth: 1, useWasm: false },
    attributes: [], neighborhoods: [], mappings: [], indicators: [],
    graphNodes: [], graphEdges: [], macroDefs: [],
    agentGraphNodes: [], agentGraphEdges: [], agentAttributes: [],
    topologyMode: { gridCells: true, agents: true },
    centerBased: { maxAgents: 64, seedCount: 4 },
  });
  M.setActiveGraphKind('cells');
  check('gridPeriodic available on the CELLS graph', M.isNodeAvailable(gp, agentsModel));
  check('agentPeriodic NOT available on the CELLS graph', !M.isNodeAvailable(ap, agentsModel));
  M.setActiveGraphKind('agents');
  check('agentPeriodic available on the AGENTS graph', M.isNodeAvailable(ap, agentsModel));
  check('gridPeriodic NOT available on the AGENTS graph', !M.isNodeAvailable(gp, agentsModel));
  M.setActiveGraphKind('cells');

  // Depth ports exist only where a depth exists.
  const m2d = { properties: { dimension: '2d', gridDepth: 1 } };
  const m3d = { properties: { dimension: '3d', gridDepth: 12 } };
  check('gridPeriodic hides `depth` in 2D', (gp.hiddenPorts?.({}, m2d) ?? []).includes('depth'));
  check('gridPeriodic shows `depth` in 3D', !(gp.hiddenPorts?.({}, m3d) ?? []).includes('depth'));
  check('agentPeriodic hides `worldDepth` in 2D', (ap.hiddenPorts?.({}, m2d) ?? []).includes('worldDepth'));
  check('agentPeriodic shows `worldDepth` in 3D', !(ap.hiddenPorts?.({}, m3d) ?? []).includes('worldDepth'));
}

// ===========================================================================
section('B. Cadence — the firing set, and the shared clamp');
// ===========================================================================
{
  // The two roots MUST resolve their cadence through the SAME helper the
  // per-agent Periodic Step uses, or a hand-edited period 0 divides by zero.
  const p0 = M.periodicParams({ period: 0, phase: 0 });
  check('period 0 clamps to >= 1', p0.period >= 1, JSON.stringify(p0));
  const pn = M.periodicParams({ period: -5, phase: 3 });
  check('negative period clamps to >= 1', pn.period >= 1, JSON.stringify(pn));
  const pf = M.periodicParams({ period: 4, phase: 9 });
  check('phase folds into [0, period)', pf.phase >= 0 && pf.phase < pf.period, JSON.stringify(pf));
  const pneg = M.periodicParams({ period: 4, phase: -1 });
  check('negative phase folds into range', pneg.phase >= 0 && pneg.phase < pneg.period, JSON.stringify(pneg));
  const p1 = M.periodicParams({ period: 1, phase: 0 });
  check('period 1 fires every generation', p1.period === 1 && p1.phase === 0);
}

// A compiled Grid Periodic Event carries its RESOLVED cadence out of the
// compiler, so the worker never re-derives it (one definition, two consumers).
{
  const g = mkGraph();
  g.n('step');                                   // the model still needs a Step root
  const gp = g.n('gridPeriodic', { period: 0, phase: 7 });   // deliberately hostile
  const k = g.n('getConstant', { constType: 'number', constValue: '1' });
  const zero = g.n('getConstant', { constType: 'number', constValue: '0' });
  const set = g.n('setCellAtPosition', { attributeId: 'og' });
  g.f(gp, 'do', set, 'do');
  g.v(zero, 'value', set, 'x'); g.v(zero, 'value', set, 'y'); g.v(k, 'value', set, 'value');
  const model = cellModel(g);
  const r = M.compileGraph(model.graphNodes, model.graphEdges, model);
  check('hostile cadence compiles', !r.error, r.error ?? '');
  check('one gridPeriodic -> one compiled event', r.gridPeriodicCodes.length === 1, `${r.gridPeriodicCodes.length}`);
  const c = r.gridPeriodicCodes[0];
  const want = M.periodicParams({ period: 0, phase: 7 });
  check('the compiled cadence is the CLAMPED one', c.period === want.period && c.phase === want.phase,
    `got ${c.period}/${c.phase}, want ${want.period}/${want.phase}`);
}

// ===========================================================================
section('C. CELLS — the compiled fn RUNS, and the WASM step SEES the write');
// ===========================================================================
{
  const W = 8, H = 6, TOTAL = W * H;
  const PERIOD = 3, PHASE = 1;

  // The event writes `100 + stepIndex` into cell (2,1) = index 1*W + 2.
  // The cell STEP then adds 1 to every cell — so a step that runs AFTER the
  // event must observe the written value (the shared-bytes claim).
  const g = mkGraph();
  const step = g.n('step');
  const getA = g.n('getCellAttribute', { attributeId: 'og' });
  const one = g.n('getConstant', { constType: 'number', constValue: '1' });
  const add = g.n('arithmeticOperator', { operation: '+' });
  const setStep = g.n('setAttribute', { attributeId: 'og' });
  g.f(step, 'do', setStep, 'do');
  g.v(getA, 'value', add, 'x'); g.v(one, 'value', add, 'y'); g.v(add, 'value', setStep, 'value');

  const gp = g.n('gridPeriodic', { period: PERIOD, phase: PHASE });
  const cx = g.n('getConstant', { constType: 'number', constValue: '2' });
  const cy = g.n('getConstant', { constType: 'number', constValue: '1' });
  const base = g.n('getConstant', { constType: 'number', constValue: '100' });
  const sum = g.n('arithmeticOperator', { operation: '+' });
  const setCell = g.n('setCellAtPosition', { attributeId: 'og' });
  g.f(gp, 'do', setCell, 'do');
  g.v(cx, 'value', setCell, 'x'); g.v(cy, 'value', setCell, 'y');
  g.v(base, 'value', sum, 'x'); g.v(gp, 'stepIndex', sum, 'y');
  g.v(sum, 'value', setCell, 'value');

  const model = cellModel(g, { properties: { gridWidth: W, gridHeight: H } });
  const r = M.compileGraph(model.graphNodes, model.graphEdges, model);
  check('cells model compiles', !r.error, r.error ?? '');
  check('exactly one grid periodic code', r.gridPeriodicCodes.length === 1);

  const pc = r.gridPeriodicCodes[0];
  check('cadence carried out of the compiler', pc.period === PERIOD && pc.phase === PHASE);

  // --- run the periodic fn against REAL WASM-module memory -----------------
  const layout = M.computeLayoutFromModel(model);
  const wa = M.compileGraphWasm(model.graphNodes, model.graphEdges, model, layout, M.buildViewerIds(model));
  check('WASM step compiles', !wa.error, wa.error ?? '');

  if (!r.error && !wa.error) {
    const mem = new WebAssembly.Memory({ initial: layout.pages });
    const env = { mem, pow: Math.pow, exp: Math.exp, log: Math.log, sin: Math.sin, cos: Math.cos, tan: Math.tan, tanh: Math.tanh, fmod: (a, b) => a % b };
    const { instance } = await WebAssembly.instantiate(wa.bytes, { env });
    // The worker's own views: readAttrs / writeAttrs are Float64Array windows
    // into the SAME WebAssembly.Memory the compiled step addresses.
    const rOg = new Float64Array(mem.buffer, layout.attrReadOffset['og'], TOTAL);
    const wOg = new Float64Array(mem.buffer, layout.attrWriteOffset['og'], TOTAL);
    const genCell = new Int32Array(mem.buffer, layout.generationOffset, 1);

    const fn = (0, eval)(pc.code);
    const params = /\(\s*function\s*\(([^)]*)\)/.exec(pc.code)[1].split(',').map(s => s.trim()).filter(Boolean);
    const bufs = {
      total: TOTAL, W, H, D: 1, WH: W * H,
      modelAttrs: {}, colors: new Uint8ClampedArray(TOTAL * 4), activeViewer: '',
      _indicators: {}, _linkedResults: {}, _rngState: new Uint32Array([0x12345678]),
      _stopFlag: new Uint32Array(1), glyphCodes: new Uint32Array(0), glyphColors: new Uint32Array(0),
      order: null, _skipped: new Uint8Array(0),
      r_og: rOg, w_og: wOg, _generation: 0,
    };
    const missing = params.filter(p => !(p in bufs));
    check('grid periodic params all resolvable', missing.length === 0, `unknown: ${missing.join(', ')}`);

    const TARGET = 1 * W + 2;
    const runPeriodic = (gen) => {
      // The worker's EXACT sync buffer discipline (runGridPeriodicEvents).
      wOg.set(rOg);
      bufs._generation = gen;
      fn(...params.map(p => bufs[p]));
      rOg.set(wOg);
    };

    if (!missing.length) {
      // 1. FIRING SET — exactly generations where gen % PERIOD === PHASE.
      const fired = [];
      for (let gen = 0; gen < 12; gen++) {
        rOg.fill(0);
        const due = gen % PERIOD === PHASE;
        if (due) { runPeriodic(gen); fired.push(gen); }
        const wrote = rOg[TARGET] !== 0;
        if (due !== wrote) { check(`gen ${gen}: fired === due`, false, `due=${due} wrote=${wrote}`); break; }
      }
      check('fires on exactly gen % 3 === 1', JSON.stringify(fired) === JSON.stringify([1, 4, 7, 10]), JSON.stringify(fired));

      // 2. VALUE — `100 + stepIndex`, stepIndex = floor(gen / period).
      let valuesOk = true, detail = '';
      for (const gen of [1, 4, 7, 10]) {
        rOg.fill(0);
        runPeriodic(gen);
        const want = 100 + Math.floor(gen / PERIOD);
        if (rOg[TARGET] !== want) { valuesOk = false; detail = `gen ${gen}: got ${rOg[TARGET]} want ${want}`; break; }
      }
      check('stepIndex value-out is floor(generation / period)', valuesOk, detail);

      // 3. ONE CELL — a global event writes what it addresses, nothing else.
      rOg.fill(0);
      runPeriodic(4);
      let others = 0;
      for (let i = 0; i < TOTAL; i++) if (i !== TARGET && rOg[i] !== 0) others++;
      check('writes ONLY the addressed cell (0 collateral)', others === 0, `${others} other cells changed`);

      // 4. THE INTEGRATION CLAIM — the WASM step SEES the periodic's write.
      //    This is the whole JS-on-CPU-root architecture in one assertion.
      rOg.fill(0);
      genCell[0] = 4;
      runPeriodic(4);
      const beforeStep = rOg[TARGET];
      instance.exports.step(TOTAL);
      const afterStep = wOg[TARGET];
      check('the REAL WASM step reads the periodic write', beforeStep === 101 && afterStep === 102,
        `periodic wrote ${beforeStep}, WASM step produced ${afterStep}`);
      // …and every untouched cell went 0 -> 1, so the step really ran over all of them.
      let stepped = 0;
      for (let i = 0; i < TOTAL; i++) if (i !== TARGET && wOg[i] === 1) stepped++;
      check('the WASM step ran over the whole grid', stepped === TOTAL - 1, `${stepped}/${TOTAL - 1}`);
    }
  }
}

// The grid value-outs must carry the LIVE dims (a grid-size-independent rule).
{
  const W = 11, H = 7;
  const g = mkGraph();
  g.n('step');
  const gp = g.n('gridPeriodic', { period: 1, phase: 0 });
  const zero = g.n('getConstant', { constType: 'number', constValue: '0' });
  const setW = g.n('setCellAtPosition', { attributeId: 'og' });
  g.f(gp, 'do', setW, 'do');
  g.v(zero, 'value', setW, 'x'); g.v(zero, 'value', setW, 'y'); g.v(gp, 'width', setW, 'value');
  const setH = g.n('setCellAtPosition', { attributeId: 'og' });
  g.f(setW, 'next', setH, 'do');
  const one = g.n('getConstant', { constType: 'number', constValue: '1' });
  g.v(one, 'value', setH, 'x'); g.v(zero, 'value', setH, 'y'); g.v(gp, 'height', setH, 'value');
  const model = cellModel(g, { properties: { gridWidth: W, gridHeight: H } });
  const r = M.compileGraph(model.graphNodes, model.graphEdges, model);
  check('dims model compiles', !r.error, r.error ?? '');
  if (!r.error) {
    const pc = r.gridPeriodicCodes[0];
    const params = /\(\s*function\s*\(([^)]*)\)/.exec(pc.code)[1].split(',').map(s => s.trim()).filter(Boolean);
    const TOTAL = W * H;
    const rOg = new Float64Array(TOTAL), wOg = new Float64Array(TOTAL);
    const bufs = {
      total: TOTAL, W, H, D: 1, WH: W * H, modelAttrs: {}, colors: new Uint8ClampedArray(TOTAL * 4),
      activeViewer: '', _indicators: {}, _linkedResults: {}, _rngState: new Uint32Array([1]),
      _stopFlag: new Uint32Array(1), glyphCodes: new Uint32Array(0), glyphColors: new Uint32Array(0),
      order: null, _skipped: new Uint8Array(0), r_og: rOg, w_og: wOg, _generation: 0,
    };
    wOg.set(rOg);
    (0, eval)(pc.code)(...params.map(p => bufs[p]));
    rOg.set(wOg);
    check('width value-out is the LIVE grid width', rOg[0] === W, `${rOg[0]} vs ${W}`);
    check('height value-out is the LIVE grid height', rOg[1] === H, `${rOg[1]} vs ${H}`);
  }
}

// Several roots per graph, each with its own cadence (the point of not being a
// singleton) — and one that fires on the same generation as another.
{
  const g = mkGraph();
  g.n('step');
  const zero = g.n('getConstant', { constType: 'number', constValue: '0' });
  const k = g.n('getConstant', { constType: 'number', constValue: '5' });
  for (const [p, ph] of [[2, 0], [3, 1], [1, 0]]) {
    const gp = g.n('gridPeriodic', { period: p, phase: ph });
    const set = g.n('setCellAtPosition', { attributeId: 'og' });
    g.f(gp, 'do', set, 'do');
    g.v(zero, 'value', set, 'x'); g.v(zero, 'value', set, 'y'); g.v(k, 'value', set, 'value');
  }
  const model = cellModel(g);
  const r = M.compileGraph(model.graphNodes, model.graphEdges, model);
  check('three grid periodic roots compile', !r.error, r.error ?? '');
  check('three roots -> three compiled events', r.gridPeriodicCodes.length === 3, `${r.gridPeriodicCodes.length}`);
  const cadences = r.gridPeriodicCodes.map(c => `${c.period}/${c.phase}`).sort();
  check('each carries its own cadence', JSON.stringify(cadences) === JSON.stringify(['1/0', '2/0', '3/1']), JSON.stringify(cadences));
}

// ===========================================================================
section('D/E. AGENTS — spawning for real, on the Agent Init Event ABI');
// ===========================================================================
const agentModelWith = (nodes, edges, cb = {}) => M.migrateForHarness({
  schemaVersion: 2,
  properties: {
    name: 'AP', description: '', topology: '2d-grid', boundaryTreatment: 'torus',
    updateMode: 'synchronous', gridWidth: 40, gridHeight: 40, dimension: '2d', gridDepth: 1, useWasm: false,
  },
  attributes: [], neighborhoods: [], mappings: [], indicators: [],
  graphNodes: [], graphEdges: [], macroDefs: [],
  agentGraphNodes: nodes, agentGraphEdges: edges,
  agentAttributes: [agentAttr('mark')],
  topologyMode: { gridCells: false, agents: true },
  centerBased: {
    maxAgents: 32, seedCount: 0, seedPattern: 'none', worldWidth: 40, worldHeight: 40,
    defaultRadius: 1, maxBonds: 0, agentUpdateMode: 'async',
    agentCapabilities: { motion: 'force', body: true, collision: 'off', bonds: 'off', autoBond: false, growth: false, division: false, lifespan: false, populationBirth: true, populationDeath: false, sensing: false, orientation: false, fieldCoupling: false, appearance: true, charge: 'off' },
    ...cb,
  },
});

// A model whose Population Periodic Event spawns SPAWN_N agents at
// (10 + i, 20), marking each with its seed index.
const SPAWN_N = 3;
const buildSpawnModel = (period, phase, count = SPAWN_N) => {
  const g = mkGraph();
  g.n('behaviourStep');            // the agent graph still needs its Behaviour Step
  const ap = g.n('agentPeriodic', { period, phase });
  const loop = g.n('loop', { mode: 'count' });
  const cnt = g.n('getConstant', { constType: 'number', constValue: String(count) });
  g.v(cnt, 'value', loop, 'count');
  g.f(ap, 'do', loop, 'do');
  const bx = g.n('getConstant', { constType: 'number', constValue: '10' });
  const px = g.n('arithmeticOperator', { operation: '+' });
  g.v(bx, 'value', px, 'x'); g.v(loop, 'index', px, 'y');
  const py = g.n('getConstant', { constType: 'number', constValue: '20' });
  const create = g.n('createAgent');
  g.f(loop, 'body', create, 'do');
  g.v(px, 'value', create, 'x'); g.v(py, 'value', create, 'y');
  const setMark = g.n('setAttribute', { attributeId: 'mark' });
  g.f(create, 'next', setMark, 'do');
  g.v(create, 'handle', setMark, 'agentId');
  g.v(loop, 'index', setMark, 'value');
  const addW = g.n('addAgentToWorld');
  g.f(setMark, 'next', addW, 'do');
  g.v(create, 'handle', addW, 'handle');
  return { g, model: agentModelWith(g.nodes, g.edges) };
};

/** The worker's GROW-ONLY spawn closures, replicated exactly (agentBehaviourCreate
 *  / agentBehaviourAddToWorld): a Create appends at highWater and NEVER reuses a
 *  free-list hole, and an Add only commits ids THIS firing staged. */
const makeSpawnClosures = (s, defaultRadius) => {
  const createdSet = new Set(), createdList = [];
  const create = (bx, by, bz, br) => {
    if (s.highWater >= s.maxAgents) return -1;
    const id = s.highWater++;
    M.initAgentSlot(s, id, bx, by, bz || 0, br || defaultRadius, id);
    s.alive[id] = 0;
    createdSet.add(id); createdList.push(id);
    return id;
  };
  const add = (id) => { if (createdSet.has(id) && !s.alive[id]) { s.alive[id] = 1; s.liveCount++; } };
  const sweep = () => {
    for (const id of createdList) if (!s.alive[id]) M.freeStagedSlot(s, id);
    createdList.length = 0; createdSet.clear();
  };
  return { create, add, sweep, createdList };
};

const storeFor = (model) => {
  const cb = model.centerBased ?? {};
  const attrSpecs = M.agentAttrsOf(model).map(a => ({ id: a.id, type: a.type, defaultValue: 0 }));
  const bondSpecs = M.bondAttrsOf(model).map(a => ({ id: a.id, type: a.type, defaultValue: 0 }));
  const s = M.createAgentStore(cb, attrSpecs, {
    wasmBacked: false,
    syncAttrs: cb.agentUpdateMode === 'sync',
    bondAttrSpecs: bondSpecs,
    fieldGates: M.resolveAgentFieldGates(model),
  });
  s.worldDepth = 1;
  return s;
};

const abiRuntime = (model, s) => ({
  emptyI32: new Int32Array(0), emptyF64: new Float64Array(0),
  modelAttrs: {}, indicators: {}, stopFlag: new Uint32Array(1),
  rngState: new Uint32Array([0x12345678]),
  glyphCodes: new Uint32Array(0), glyphColors: new Uint32Array(0), lookupTables: {},
  width: 40, height: 40, total: 1600, torus: true, fieldArray: () => new Float64Array(0),
  hash: null, activeViewerIdx: -1,
});

{
  const PERIOD = 5, PHASE = 2;
  const { model } = buildSpawnModel(PERIOD, PHASE);
  const ar = M.compileAgentGraph(model.agentGraphNodes, model.agentGraphEdges, model);
  check('agent model compiles', !ar.error, ar.error ?? '');
  check('one agentPeriodic -> one compiled event', (ar.periodicCodes ?? []).length === 1, `${(ar.periodicCodes ?? []).length}`);

  if (!ar.error && ar.periodicCodes?.length) {
    const pc = ar.periodicCodes[0];
    check('agent cadence carried out of the compiler', pc.period === PERIOD && pc.phase === PHASE);

    // ---- E. THE ABI-REUSE CLAIM ------------------------------------------
    const declared = /\(\s*function\s*\(([^)]*)\)/.exec(pc.code)[1];
    const wantParams = M.buildAgentInitParams(model);
    check('the periodic fn declares EXACTLY the Agent Init Event ABI',
      declared.trim() === wantParams.trim(),
      `got "${declared.slice(0, 70)}…"`);

    // ---- D. RUN IT ---------------------------------------------------------
    const s = storeFor(model);
    const shape = M.agentAbiShapeOf(model);
    const { create, add, sweep } = makeSpawnClosures(s, 1);
    const rt = abiRuntime(model, s);
    const fn = (0, eval)(pc.code);

    const fire = (gen) => {
      const seedBase = s.highWater;
      fn(...M.buildAgentAbiArgs('init', shape, s, {
        ...rt, agentCreate: create, agentAddToWorld: add, seedBase, generation: gen,
      }));
      sweep();
    };

    // 1. The firing set drives the population.
    let live0 = s.liveCount;
    check('store starts empty', live0 === 0, `${live0}`);
    const growth = [];
    for (let gen = 0; gen < 12; gen++) {
      const before = s.liveCount;
      if (gen % PERIOD === PHASE) fire(gen);
      if (s.liveCount !== before) growth.push(gen);
    }
    check('spawns on exactly gen % 5 === 2', JSON.stringify(growth) === JSON.stringify([2, 7]), JSON.stringify(growth));
    check('each firing spawned exactly SPAWN_N', s.liveCount === 2 * SPAWN_N, `${s.liveCount}`);

    // 2. EXACT positions + the per-agent attribute write through the handle.
    let posOk = true, posDetail = '';
    for (let k = 0; k < 2 * SPAWN_N; k++) {
      const i = k % SPAWN_N;
      if (s.x[k] !== 10 + i || s.y[k] !== 20) { posOk = false; posDetail = `agent ${k}: (${s.x[k]}, ${s.y[k]})`; break; }
    }
    check('spawned at EXACT positions (10 + loopIndex, 20)', posOk, posDetail);
    const markArr = s.attrRead['mark'];
    let markOk = true;
    for (let k = 0; k < 2 * SPAWN_N; k++) if (markArr[k] !== k % SPAWN_N) { markOk = false; break; }
    check('set-by-handle wrote each newborn its own attribute', markOk, Array.from(markArr.slice(0, 6)).join(','));

    // 3. Every spawned slot is genuinely LIVE (Add To World committed it).
    let allAlive = true;
    for (let k = 0; k < 2 * SPAWN_N; k++) if (!s.alive[k]) allAlive = false;
    check('every spawned slot is alive', allAlive);
  }
}

// Bounded by maxAgents — a Create past the ceiling returns -1 and NOTHING wraps.
{
  const { model } = buildSpawnModel(1, 0, 100);   // 100 per firing vs maxAgents 32
  const ar = M.compileAgentGraph(model.agentGraphNodes, model.agentGraphEdges, model);
  check('overflow model compiles', !ar.error, ar.error ?? '');
  if (!ar.error && ar.periodicCodes?.length) {
    const s = storeFor(model);
    const shape = M.agentAbiShapeOf(model);
    const { create, add, sweep } = makeSpawnClosures(s, 1);
    const rt = abiRuntime(model, s);
    const fn = (0, eval)(ar.periodicCodes[0].code);
    fn(...M.buildAgentAbiArgs('init', shape, s, { ...rt, agentCreate: create, agentAddToWorld: add, seedBase: 0, generation: 0 }));
    sweep();
    check('population capped at maxAgents', s.liveCount === s.maxAgents, `${s.liveCount} / ${s.maxAgents}`);
    check('highWater never exceeds maxAgents', s.highWater <= s.maxAgents, `${s.highWater}`);
    // Nothing wrapped: agent 0 keeps the FIRST create's position, not a later one.
    check('no wrap — slot 0 holds the first Create', s.x[0] === 10 && s.y[0] === 20, `(${s.x[0]}, ${s.y[0]})`);
  }
}

// The LEAK SWEEP: Create WITHOUT Add leaves a staged slot; the sweep frees it.
{
  const g = mkGraph();
  g.n('behaviourStep');
  const ap = g.n('agentPeriodic', { period: 1, phase: 0 });
  const bx = g.n('getConstant', { constType: 'number', constValue: '5' });
  const by = g.n('getConstant', { constType: 'number', constValue: '6' });
  const create = g.n('createAgent');
  g.f(ap, 'do', create, 'do');
  g.v(bx, 'value', create, 'x'); g.v(by, 'value', create, 'y');
  // NO Add Agent To World — deliberately.
  const model = agentModelWith(g.nodes, g.edges);
  const ar = M.compileAgentGraph(model.agentGraphNodes, model.agentGraphEdges, model);
  check('leak model compiles', !ar.error, ar.error ?? '');
  if (!ar.error && ar.periodicCodes?.length) {
    const s = storeFor(model);
    const shape = M.agentAbiShapeOf(model);
    const { create: cf, add, sweep, createdList } = makeSpawnClosures(s, 1);
    const rt = abiRuntime(model, s);
    const fn = (0, eval)(ar.periodicCodes[0].code);
    fn(...M.buildAgentAbiArgs('init', shape, s, { ...rt, agentCreate: cf, agentAddToWorld: add, seedBase: 0, generation: 0 }));
    check('a Create staged a slot (alive=0)', createdList.length === 1 && s.alive[createdList[0]] === 0);
    sweep();
    check('the leak sweep left NO live agent', s.liveCount === 0, `${s.liveCount}`);
  }
}

// Several population roots per graph, each with its own cadence.
{
  const g = mkGraph();
  g.n('behaviourStep');
  for (const [p, ph] of [[4, 0], [4, 2], [1, 0]]) {
    const ap = g.n('agentPeriodic', { period: p, phase: ph });
    const k = g.n('getConstant', { constType: 'number', constValue: '1' });
    const c = g.n('createAgent');
    g.f(ap, 'do', c, 'do');
    g.v(k, 'value', c, 'x'); g.v(k, 'value', c, 'y');
    const a = g.n('addAgentToWorld');
    g.f(c, 'next', a, 'do'); g.v(c, 'handle', a, 'handle');
  }
  const model = agentModelWith(g.nodes, g.edges);
  const ar = M.compileAgentGraph(model.agentGraphNodes, model.agentGraphEdges, model);
  check('three population roots compile', !ar.error, ar.error ?? '');
  check('three roots -> three compiled events', (ar.periodicCodes ?? []).length === 3, `${(ar.periodicCodes ?? []).length}`);
  const cad = (ar.periodicCodes ?? []).map(c => `${c.period}/${c.phase}`).sort();
  check('each population root carries its own cadence', JSON.stringify(cad) === JSON.stringify(['1/0', '4/0', '4/2']), JSON.stringify(cad));
}

// ===========================================================================
section('F. RESIDENCY — the correctness term');
// ===========================================================================
{
  // A resident batch encodes N generations into ONE submit with NO CPU touch
  // point between them. A periodic event IS a per-generation CPU touch point,
  // so a model carrying either root must BLOCK residency — otherwise the
  // resident batch silently skips every firing.
  const clean = {
    maxBonds: 0, usesSpawn: false, usesStop: false, usesIndicators: false,
    usesField: false, usesSprites: false, usesStructural: false, usesRadiusWrite: false,
    usesPeriodicEvents: false,
  };
  const cfg = { agentUpdateMode: 'async', agentCapabilities: { motion: 'force', collision: 'off', bonds: 'off', growth: false, autoBond: false } };
  const before = M.residencyModelBlockers(cfg, clean);
  check('a clean model has no periodicEvents blocker', !before.some(b => b.key === 'periodicEvents'),
    before.map(b => b.key).join(','));
  const after = M.residencyModelBlockers(cfg, { ...clean, usesPeriodicEvents: true });
  check('usesPeriodicEvents BLOCKS residency', after.some(b => b.key === 'periodicEvents'),
    after.map(b => b.key).join(','));
  const blocker = after.find(b => b.key === 'periodicEvents');
  check('the blocker explains itself', !!blocker?.text && blocker.text.length > 20, blocker?.text);
}

// ===========================================================================
section('G. The hot-path no-op — no root, no code');
// ===========================================================================
{
  const g = mkGraph();
  const step = g.n('step');
  const k = g.n('getConstant', { constType: 'number', constValue: '3' });
  const set = g.n('setAttribute', { attributeId: 'og' });
  g.f(step, 'do', set, 'do'); g.v(k, 'value', set, 'value');
  const model = cellModel(g);
  const r = M.compileGraph(model.graphNodes, model.graphEdges, model);
  check('a periodic-free cells graph emits NO grid periodic code',
    Array.isArray(r.gridPeriodicCodes) && r.gridPeriodicCodes.length === 0);

  const ag = mkGraph();
  ag.n('behaviourStep');
  const amodel = agentModelWith(ag.nodes, ag.edges);
  const ar = M.compileAgentGraph(amodel.agentGraphNodes, amodel.agentGraphEdges, amodel);
  check('a periodic-free agent graph emits NO population periodic code',
    Array.isArray(ar.periodicCodes) && ar.periodicCodes.length === 0);
}

// ===========================================================================
rmSync(entryPath, { force: true });
rmSync(dir, { recursive: true, force: true });
console.log(failures === 0
  ? '\nGLOBAL PERIODIC EVENTS ✓  (all checks passed)'
  : `\n${failures} CHECK(S) FAILED ✗`);
process.exit(failures === 0 ? 0 : 1);

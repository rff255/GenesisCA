// L2 — RULE CADENCE: `Get Generation` (universal) + `Periodic Step` (agents).
//
// What this checks — VALUES and STRUCTURE, not "it compiled":
//   1. Editor surface: Get Generation is UNIVERSAL (cells + agents, not Overseer);
//      Periodic Step is agent-only and is NOT a singleton.
//   2. CELLS — the JS step and the REAL WASM module RUN in Node with a supplied
//      generation; every cell must hold exactly it. 2D and 3D. JS↔WASM bit-compared.
//      Plus the WGSL emit (the `Control.generation` field is declared only when read).
//   3. BYTE-IDENTITY of the mechanism: a model WITHOUT the node must not gain the
//      `_generation` param, the `Control.generation` field, or any WASM load — and
//      the layout offsets above the generation cell must not move.
//   4. The LOWERING: multiplicity, the single synthesized behaviourStep, the
//      sequence order (the unconditional chain first), `Step Index` only when
//      consumed, the hot-path no-op, and period/phase clamping.
//   5. CADENCE by value on the AGENT JS behaviour loop: period 10 phase 0 fires on
//      exactly 0, 10, 20 …; two gates at period 2 phases 0/1 alternate; three gates
//      at different periods coexist. (JS↔WASM parity for the same shapes is the
//      permanent `[synthetic] Rule cadence` entry in parity-agent-wasm.mjs; the
//      real-GPU run is the in-browser residency test.)
//   6. INIT / DIVISION semantics: both read the generation through their own ABI.
//   7. The AGENT WebGPU emit: the genCounter binding + the per-generation posCommit
//      bump (THE residency fix — a uniform would be frozen across a batch).
//
// Run from the repo root:  node scripts/test-rule-cadence.mjs
import { build } from 'esbuild';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = `
export { compileGraph, compileAgentGraph } from '../src/modeler/vpl/compiler/compile.ts';
export { compileGraphWasm } from '../src/modeler/vpl/compiler/wasm/compile.ts';
export { computeLayoutFromModel, buildViewerIds } from '../src/modeler/vpl/compiler/wasm/layout.ts';
export { compileGraphWebGPU } from '../src/modeler/vpl/compiler/webgpu/compile.ts';
export { compileAgentGraphWasmForModel, isAgentGraphWasmSupported } from '../src/modeler/vpl/compiler/agentWasm/compile.ts';
export { compileAgentGraphWebGPUForModel, isAgentGraphWebGPUSupported } from '../src/modeler/vpl/compiler/agentWebgpu/compile.ts';
export { expandPeriodicSteps, periodicParams } from '../src/modeler/vpl/compiler/periodicExpand.ts';
export { cellUsesGeneration, agentUsesGeneration } from '../src/modeler/vpl/compiler/generationUse.ts';
export { migrateForHarness } from '../src/dev/compileHarness.ts';
export { isNodeAvailable } from '../src/modeler/vpl/nodes/nodeValidation.ts';
export { setActiveGraphKind } from '../src/modeler/vpl/graphState.ts';
export { getNodeDef } from '../src/modeler/vpl/nodes/registry.ts';
export { deriveAgentAbi } from '../src/modeler/vpl/compiler/agentAbi.ts';
`;
const dir = mkdtempSync(join(tmpdir(), 'gca-cadence-'));
const entryPath = join(ROOT, 'scripts', '__cadence_entry.ts');
writeFileSync(entryPath, ENTRY);
const outPath = join(dir, 'bundle.mjs');
await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: process.cwd() });
const M = await import(pathToFileURL(outPath).href);

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ok  ${name}`);
  else { console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); failures++; }
};

// --- tiny graph builders (same conventions as the other scripts) -------------
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

// ===========================================================================
// 1. Editor surface
// ===========================================================================
console.log('== editor surface ==');
{
  const gg = M.getNodeDef('getGeneration');
  const ps = M.getNodeDef('periodicStep');
  check('Get Generation registered', !!gg);
  check('Periodic Step registered', !!ps);
  check('Get Generation has NO capability requirements (universal)', !!gg && !gg.requirements);
  check('Periodic Step requires the Agents topology', ps?.requirements?.bondGraph === true);
  const model = { properties: { dimension: '2d', gridDepth: 1, updateMode: 'synchronous' }, topologyMode: { gridCells: true, agents: true } };
  M.setActiveGraphKind('cells');
  check('Get Generation available on the Cells graph', M.isNodeAvailable(gg, model));
  check('Periodic Step hidden on the Cells graph', !M.isNodeAvailable(ps, model));
  M.setActiveGraphKind('agents');
  check('Get Generation available on the Agents graph', M.isNodeAvailable(gg, model));
  check('Periodic Step available on the Agents graph', M.isNodeAvailable(ps, model));
  M.setActiveGraphKind('overseer');
  check('Get Generation hidden on the Overseer graph (it has ovGetGeneration)', !M.isNodeAvailable(gg, model));
  M.setActiveGraphKind('cells');

  // Periodic Step must NOT be a singleton — N per graph is the whole point.
  const src = readFileSync(join(ROOT, 'src/modeler/vpl/GraphEditor.tsx'), 'utf8');
  const line = /const SINGLETON_NODE_TYPES = new Set\(\[[^\]]*\]\)/.exec(src)?.[0] ?? '';
  check('behaviourStep IS a singleton (unchanged)', line.includes("'behaviourStep'"));
  check('periodicStep is NOT a singleton', !line.includes("'periodicStep'"));
}

// ===========================================================================
// 2. CELLS — JS + real WASM runtime + the WGSL emit. 2D and 3D.
// ===========================================================================
const cellCase = async (label, W, H, D, GEN) => {
  console.log(`\n== cells ${label} (${W}x${H}x${D}), generation ${GEN} ==`);
  const is3d = D > 1;
  const g = mkGraph();
  const step = g.n('step');
  const gg = g.n('getGeneration');
  const set = g.n('setAttribute', { attributeId: 'og' });
  g.f(step, 'do', set, 'do');
  g.v(gg, 'value', set, 'value');
  const model = M.migrateForHarness({
    schemaVersion: 2,
    properties: {
      name: `Cadence ${label}`, description: '', topology: '2d-grid',
      boundaryTreatment: 'torus', updateMode: 'synchronous',
      gridWidth: W, gridHeight: H, dimension: is3d ? '3d' : '2d', gridDepth: D, useWasm: false,
    },
    attributes: [cellAttr('og')],
    neighborhoods: [], mappings: [], indicators: [],
    graphNodes: g.nodes, graphEdges: g.edges, macroDefs: [],
    topologyMode: { gridCells: true, agents: false },
  });
  const TOTAL = W * H * D;

  // --- JS ---
  const js = M.compileGraph(model.graphNodes, model.graphEdges, model);
  check('JS compiles', !js.error, js.error ?? '');
  let jsOut = null;
  if (!js.error) {
    const params = /\(\s*function\s*\(([^)]*)\)/.exec(js.stepCode)[1].split(',').map(s => s.trim()).filter(Boolean);
    check('`_generation` is the LAST step param', params[params.length - 1] === '_generation', params.slice(-3).join(', '));
    const bufs = {
      total: TOTAL, W, H, D, WH: W * H,
      modelAttrs: {}, colors: new Uint8ClampedArray(TOTAL * 4), activeViewer: '',
      _indicators: {}, _linkedResults: {}, _rngState: new Uint32Array([0x12345678]),
      _stopFlag: new Uint32Array(1), glyphCodes: new Uint32Array(0), glyphColors: new Uint32Array(0),
      order: null, _skipped: new Uint8Array(0),
      r_og: new Float64Array(TOTAL), w_og: new Float64Array(TOTAL),
      _generation: GEN,
    };
    const missing = params.filter(p => !(p in bufs));
    check('JS step params all resolvable', missing.length === 0, `unknown: ${missing.join(', ')}`);
    if (!missing.length) {
      (0, eval)(js.stepCode)(...params.map(p => bufs[p]));
      let allEq = true; for (let i = 0; i < TOTAL; i++) if (bufs.w_og[i] !== GEN) { allEq = false; break; }
      check(`JS runtime generation === ${GEN} on every cell`, allEq, `got ${bufs.w_og[0]}`);
      jsOut = Float64Array.from(bufs.w_og);
    }
  }

  // --- WASM (real module, instantiated + run) ---
  const layout = M.computeLayoutFromModel(model);
  const wa = M.compileGraphWasm(model.graphNodes, model.graphEdges, model, layout, M.buildViewerIds(model));
  check('WASM compiles', !wa.error, wa.error ?? '');
  if (!wa.error) {
    const mem = new WebAssembly.Memory({ initial: layout.pages });
    // Seed the generation cell exactly as the worker's `generationCellView` does.
    new Int32Array(mem.buffer, layout.generationOffset, 1)[0] = GEN;
    const env = { mem, pow: Math.pow, exp: Math.exp, log: Math.log, sin: Math.sin, cos: Math.cos, tan: Math.tan, tanh: Math.tanh, fmod: (a, b) => a % b };
    const { instance } = await WebAssembly.instantiate(wa.bytes, { env });
    instance.exports.step(TOTAL);
    const out = new Float64Array(mem.buffer, layout.attrWriteOffset['og'], TOTAL);
    let allEq = true; for (let i = 0; i < TOTAL; i++) if (out[i] !== GEN) { allEq = false; break; }
    check(`WASM runtime generation === ${GEN} on every cell`, allEq, `got ${out[0]}`);
    if (jsOut) {
      let diff = 0; for (let i = 0; i < TOTAL; i++) if (out[i] !== jsOut[i]) diff++;
      check('JS ↔ WASM bit-identical', diff === 0, `${diff} mismatches`);
    }
  }

  // --- WebGPU (emit-level; the real device run is the in-browser check) ---
  const wg = M.compileGraphWebGPU(model.graphNodes, model.graphEdges, model);
  check('WebGPU compiles', !wg.error, wg.error ?? '');
  if (!wg.error) {
    check('WGSL declares Control.generation', /generation\s*:\s*u32,/.test(wg.shaderCode));
    check('WGSL reads i32(control.generation)', wg.shaderCode.includes('i32(control.generation)'));
  }
};
await cellCase('2D', 7, 5, 1, 42);
await cellCase('3D', 6, 4, 3, 7);

// ===========================================================================
// 3. BYTE-IDENTITY of the mechanism — a model that never reads the generation.
// ===========================================================================
console.log('\n== the OFF path (no Get Generation anywhere) ==');
{
  const g = mkGraph();
  const step = g.n('step');
  const k = g.n('getConstant', { constType: 'number', constValue: '3' });
  const set = g.n('setAttribute', { attributeId: 'og' });
  g.f(step, 'do', set, 'do'); g.v(k, 'value', set, 'value');
  const model = M.migrateForHarness({
    schemaVersion: 2,
    properties: { name: 'Off', description: '', topology: '2d-grid', boundaryTreatment: 'torus', updateMode: 'synchronous', gridWidth: 5, gridHeight: 5, dimension: '2d', gridDepth: 1, useWasm: false },
    attributes: [cellAttr('og')], neighborhoods: [], mappings: [], indicators: [],
    graphNodes: g.nodes, graphEdges: g.edges, macroDefs: [],
    topologyMode: { gridCells: true, agents: false },
  });
  check('cellUsesGeneration === false', M.cellUsesGeneration(model) === false);
  const js = M.compileGraph(model.graphNodes, model.graphEdges, model);
  check('JS step has NO `_generation` param', !/\b_generation\b/.test(js.stepCode));
  const wg = M.compileGraphWebGPU(model.graphNodes, model.graphEdges, model);
  check('WGSL has NO Control.generation field', !/generation\s*:\s*u32,/.test(wg.shaderCode));
  // The WASM surface needs no gate at all: the cell is appended LAST, so every
  // offset above it — and therefore every emitted load/store — is unchanged.
  const layout = M.computeLayoutFromModel(model);
  check('generationOffset is the LAST region (totalBytes === offset + 8)',
    layout.totalBytes === layout.generationOffset + 8, `${layout.totalBytes} vs ${layout.generationOffset + 8}`);
  check('generationOffset is above every other region',
    [layout.scratchOffset, layout.stopFlagOffset, layout.rngStateOffset, layout.colorsOffset, layout.activeListOffset]
      .every(o => o <= layout.generationOffset));
  // (The cross-model proof that nothing moved is check-compile-identity.mjs.)
}

// ===========================================================================
// 4. The LOWERING — structure, multiplicity, ordering, clamping.
// ===========================================================================
console.log('\n== the Periodic Step lowering ==');
{
  check('periodicParams clamps period to >= 1', M.periodicParams({ period: '0', phase: '0' }).period === 1);
  check('periodicParams floors a fractional period', M.periodicParams({ period: '4.7', phase: '0' }).period === 4);
  check('periodicParams folds phase into [0, period)', M.periodicParams({ period: '3', phase: '7' }).phase === 1);
  check('periodicParams folds a NEGATIVE phase', M.periodicParams({ period: '3', phase: '-1' }).phase === 2);
  check('periodicParams defaults a garbage period to 1', M.periodicParams({}).period === 1);

  const model = { properties: {}, topologyMode: { agents: true } };

  // Hot-path no-op: no Periodic Step ⇒ the SAME array references back.
  {
    const g = mkGraph(); const bs = g.n('behaviourStep'); const s = g.n('setAttribute', { attributeId: 'a' });
    g.f(bs, 'do', s, 'do');
    const out = M.expandPeriodicSteps(g.nodes, g.edges, model);
    check('no Periodic Step ⇒ the same arrays (hot-path no-op)', out.nodes === g.nodes && out.edges === g.edges);
  }

  // ONE Periodic Step, no Behaviour Step: a behaviourStep is synthesized, and the
  // single branch wires directly (no Sequence needed).
  {
    const g = mkGraph(); const ps = g.n('periodicStep', { period: '10', phase: '0' });
    const s = g.n('setAttribute', { attributeId: 'a' }); g.f(ps, 'do', s, 'do');
    const out = M.expandPeriodicSteps(g.nodes, g.edges, model);
    const types = out.nodes.map(n => n.data.nodeType);
    check('a behaviourStep is synthesized', types.filter(t => t === 'behaviourStep').length === 1);
    check('the periodicStep is gone', !types.includes('periodicStep'));
    check('the gate chain is synthesized', types.includes('getGeneration') && types.includes('arithmeticOperator') && types.includes('statement') && types.includes('conditional'));
    check('no Sequence for a single branch', !types.includes('sequence'));
    const ifNode = out.nodes.find(n => n.data.nodeType === 'conditional');
    check('the chain hangs off the gate THEN', out.edges.some(e => e.source === ifNode.id && e.sourceHandle === 'output_flow_then' && e.target === s.id));
  }

  // An EXISTING Behaviour Step is REUSED (still exactly one) and its unconditional
  // chain runs FIRST, ahead of the periodic gates.
  {
    const g = mkGraph();
    const bs = g.n('behaviourStep');
    const always = g.n('setAttribute', { attributeId: 'a' }); g.f(bs, 'do', always, 'do');
    const ps = g.n('periodicStep', { period: '4', phase: '1' });
    const gated = g.n('setAttribute', { attributeId: 'b' }); g.f(ps, 'do', gated, 'do');
    const out = M.expandPeriodicSteps(g.nodes, g.edges, model);
    const roots = out.nodes.filter(n => n.data.nodeType === 'behaviourStep');
    check('the existing behaviourStep is reused (still exactly one)', roots.length === 1 && roots[0].id === bs.id);
    const seq = out.nodes.find(n => n.data.nodeType === 'sequence');
    check('a Sequence orders the two branches', !!seq);
    check('Sequence extraCount === 0 for two branches', seq?.data.config.extraCount === 0);
    check('the root drives the Sequence', out.edges.some(e => e.source === bs.id && e.sourceHandle === 'output_flow_do' && e.target === seq.id));
    check('FIRST = the unconditional chain', out.edges.some(e => e.source === seq.id && e.sourceHandle === 'output_flow_first' && e.target === always.id));
    const ifNode = out.nodes.find(n => n.data.nodeType === 'conditional');
    check('THEN = the periodic gate', out.edges.some(e => e.source === seq.id && e.sourceHandle === 'output_flow_then' && e.target === ifNode.id));
    check('the original root→chain edge is not duplicated',
      out.edges.filter(e => e.source === bs.id && e.sourceHandle === 'output_flow_do').length === 1);
  }

  // THREE Periodic Steps + an unconditional chain: 4 branches ⇒ first/then/then_2/then_3.
  {
    const g = mkGraph();
    const bs = g.n('behaviourStep');
    const always = g.n('setAttribute', { attributeId: 'a' }); g.f(bs, 'do', always, 'do');
    const heads = [];
    for (const p of ['2', '5', '50']) {
      const ps = g.n('periodicStep', { period: p, phase: '0' });
      const w = g.n('setAttribute', { attributeId: 'b' }); g.f(ps, 'do', w, 'do'); heads.push(w);
    }
    const out = M.expandPeriodicSteps(g.nodes, g.edges, model);
    check('still exactly ONE behaviourStep with 3 Periodic Steps', out.nodes.filter(n => n.data.nodeType === 'behaviourStep').length === 1);
    const seq = out.nodes.find(n => n.data.nodeType === 'sequence');
    check('Sequence extraCount === 2 for four branches', seq?.data.config.extraCount === 2);
    const ports = out.edges.filter(e => e.source === seq.id).map(e => e.sourceHandle).sort();
    check('Sequence uses first/then/then_2/then_3',
      ports.join(',') === ['output_flow_first', 'output_flow_then', 'output_flow_then_2', 'output_flow_then_3'].sort().join(','), ports.join(','));
    check('one gate per Periodic Step', out.nodes.filter(n => n.data.nodeType === 'conditional').length === 3);
    check('ONE shared Get Generation for all gates', out.nodes.filter(n => n.data.nodeType === 'getGeneration').length === 1);
    // Each gate's modulo carries its OWN period.
    const periods = out.nodes.filter(n => n.data.nodeType === 'arithmeticOperator' && n.data.config.operation === '%')
      .map(n => n.data.config._port_y).sort();
    check('the three periods reach their gates', periods.join(',') === ['2', '5', '50'].sort().join(','), periods.join(','));
  }

  // Step Index is synthesized ONLY when consumed.
  {
    const mk = (consume) => {
      const g = mkGraph(); const ps = g.n('periodicStep', { period: '7', phase: '2' });
      const w = g.n('setAttribute', { attributeId: 'a' }); g.f(ps, 'do', w, 'do');
      if (consume) { const w2 = g.n('setAttribute', { attributeId: 'b' }); g.f(w, 'next', w2, 'do'); g.v(ps, 'stepIndex', w2, 'value'); }
      return M.expandPeriodicSteps(g.nodes, g.edges, model);
    };
    const off = mk(false), on = mk(true);
    const divs = (o) => o.nodes.filter(n => n.data.nodeType === 'arithmeticOperator' && (n.data.config.operation === '/' || n.data.config.operation === 'floor')).length;
    check('Step Index unconsumed ⇒ NO divide/floor chain', divs(off) === 0);
    check('Step Index consumed ⇒ the divide + floor chain appears', divs(on) === 2);
  }
}

// ===========================================================================
// 5. CADENCE by value — the agent JS behaviour loop over real generations.
// ===========================================================================
// Build the ABI arg list generically from the emitted param names so the test
// tracks the real ABI (a new field gets a sane default rather than breaking).
const agentArgs = (params, { N, W, H, D, generation, store }) => params.map((p) => {
  switch (p) {
    case 'highWater': return N;
    case '_alive': return store.alive;
    case 'maxBonds': return 0;
    case 'modelAttrs': case '_indicators': case '_lookupTables': return {};
    case 'colors': return new Uint8ClampedArray(N * 4);
    case 'activeViewer': return '';
    case '_rngState': return new Uint32Array([0x12345678]);
    case '_stopFlag': return new Uint32Array(1);
    case 'glyphCodes': case 'glyphColors': return new Uint32Array(0);
    case '_fieldW': return W;
    case '_fieldH': return H;
    case '_fieldD': return D;
    case '_fieldTotal': return W * H * D;
    case '_fieldBoundaryTorus': return 1;
    case '_agentCreate': return () => -1;
    case '_agentAddToWorld': return () => {};
    case '_agentMaxAgents': return N;
    case '_agentSeedBase': return 0;
    case '_generation': return generation;
    case 'idx': return 0;
    case '__daughterIndex': return 0;
    case '__axisDefaultX': return 1;
    case '__axisDefaultY': return 0;
    case '_hashValid': return 0;
    case '_hashBinStart': case '_hashBinAgents': return new Int32Array(0);
    default:
      if (p.startsWith('r_') || p.startsWith('w_')) return store.attrs[p.slice(2)];
      if (p.startsWith('_field_')) return new Float64Array(W * H * D);
      if (p.startsWith('_bondAttr_') || p.startsWith('_bondFormAttr_')) return new Float64Array(N);
      if (p.startsWith('_hash') || p.startsWith('maxBonds')) return 0;
      if (p.startsWith('_bond')) return new Int32Array(N);
      if (p.startsWith('_divide') || p.startsWith('_kill')) return new Float64Array(N);
      if (p.startsWith('sprite')) return new Float64Array(N);
      if (p.startsWith('_agent')) return new Float64Array(N);
      return 0;
  }
});

const agentModel = (gNodes, gEdges, attrIds) => M.migrateForHarness({
  schemaVersion: 2,
  properties: { name: 'Cadence agents', description: '', topology: '2d-grid', boundaryTreatment: 'torus', updateMode: 'synchronous', gridWidth: 24, gridHeight: 24, dimension: '2d', gridDepth: 1, useWasm: false },
  attributes: [], neighborhoods: [], mappings: [], indicators: [],
  agentAttributes: attrIds.map(agentAttr),
  graphNodes: [], graphEdges: [], agentGraphNodes: gNodes, agentGraphEdges: gEdges, macroDefs: [],
  topologyMode: { gridCells: false, agents: true },
  centerBased: {
    enabled: true, maxAgents: 64, maxBonds: 0, worldWidth: 24, worldHeight: 24, seedCount: 0,
    defaultRadius: 0.5, growthRate: 0, repulsionStiffness: 0, adhesionStiffness: 0, interactionRange: 1.5,
    drag: 1, timeStep: 0.1, momentum: 0, maxSpeed: 0, neighbourQueryRadius: 8,
    useBondingPhysics: false, autoBond: false, agentTarget: 'js', agentUpdateMode: 'async',
  },
});

/** Run a compiled agent behaviour over generations 0..GENS-1 and report, per
 *  attribute, the set of generations on which it changed (i.e. the gate fired). */
const runCadence = (model, attrIds, GENS) => {
  const r = M.compileAgentGraph(model.agentGraphNodes, model.agentGraphEdges, model, 0);
  if (r.error) return { error: r.error };
  const params = /\(\s*function\s*\(([^)]*)\)/.exec(r.behaviourCode)[1].split(',').map(s => s.trim()).filter(Boolean);
  const N = 4;
  const store = { alive: new Uint8Array(N).fill(1), attrs: {} };
  for (const id of attrIds) store.attrs[id] = new Float64Array(N).fill(-999);
  const fn = (0, eval)(r.behaviourCode);
  const fired = {}; for (const id of attrIds) fired[id] = [];
  for (let gen = 0; gen < GENS; gen++) {
    const before = {}; for (const id of attrIds) before[id] = store.attrs[id][0];
    fn(...agentArgs(params, { N, W: 24, H: 24, D: 1, generation: gen, store }));
    for (const id of attrIds) if (store.attrs[id][0] !== before[id]) fired[id].push(gen);
  }
  return { fired, code: r.behaviourCode };
};

console.log('\n== cadence by value (agent JS behaviour loop) ==');
{
  // period 10, phase 0 → exactly 0, 10, 20, 30 …
  const g = mkGraph();
  const ps = g.n('periodicStep', { period: '10', phase: '0' });
  const gg = g.n('getGeneration');
  const w = g.n('setAttribute', { attributeId: 'a' });
  g.f(ps, 'do', w, 'do'); g.v(gg, 'value', w, 'value');
  const res = runCadence(agentModel(g.nodes, g.edges, ['a']), ['a'], 35);
  check('compiles', !res.error, res.error ?? '');
  if (!res.error) check('period 10 phase 0 fires on exactly 0, 10, 20, 30', res.fired.a.join(',') === '0,10,20,30', res.fired.a.join(','));
}
{
  // Two phases at period 2 — the classic alternation.
  const g = mkGraph();
  const gg = g.n('getGeneration');
  for (const [ph, id] of [['0', 'even'], ['1', 'odd']]) {
    const ps = g.n('periodicStep', { period: '2', phase: ph });
    const w = g.n('setAttribute', { attributeId: id });
    g.f(ps, 'do', w, 'do'); g.v(gg, 'value', w, 'value');
  }
  const res = runCadence(agentModel(g.nodes, g.edges, ['even', 'odd']), ['even', 'odd'], 8);
  check('two phases compile', !res.error, res.error ?? '');
  if (!res.error) {
    check('period 2 phase 0 fires on 0,2,4,6', res.fired.even.join(',') === '0,2,4,6', res.fired.even.join(','));
    check('period 2 phase 1 fires on 1,3,5,7', res.fired.odd.join(',') === '1,3,5,7', res.fired.odd.join(','));
    check('the two phases never coincide', res.fired.even.every(x => !res.fired.odd.includes(x)));
  }
}
{
  // Multiplicity: 3 gates + an unconditional Behaviour Step chain, all together.
  const g = mkGraph();
  const gg = g.n('getGeneration');
  const bs = g.n('behaviourStep');
  const wAll = g.n('setAttribute', { attributeId: 'always' });
  g.f(bs, 'do', wAll, 'do'); g.v(gg, 'value', wAll, 'value');
  for (const [p, id] of [['2', 'p2'], ['3', 'p3'], ['5', 'p5']]) {
    const ps = g.n('periodicStep', { period: p, phase: '0' });
    const w = g.n('setAttribute', { attributeId: id });
    g.f(ps, 'do', w, 'do'); g.v(gg, 'value', w, 'value');
  }
  const ids = ['always', 'p2', 'p3', 'p5'];
  const res = runCadence(agentModel(g.nodes, g.edges, ids), ids, 12);
  check('multiplicity compiles', !res.error, res.error ?? '');
  if (!res.error) {
    check('the unconditional chain still runs EVERY generation', res.fired.always.join(',') === '0,1,2,3,4,5,6,7,8,9,10,11', res.fired.always.join(','));
    check('period 2 fires on 0,2,4,6,8,10', res.fired.p2.join(',') === '0,2,4,6,8,10', res.fired.p2.join(','));
    check('period 3 fires on 0,3,6,9', res.fired.p3.join(',') === '0,3,6,9', res.fired.p3.join(','));
    check('period 5 fires on 0,5,10', res.fired.p5.join(',') === '0,5,10', res.fired.p5.join(','));
  }
}
{
  // Step Index = floor(generation / period).
  const g = mkGraph();
  const ps = g.n('periodicStep', { period: '4', phase: '0' });
  const w = g.n('setAttribute', { attributeId: 'si' });
  g.f(ps, 'do', w, 'do'); g.v(ps, 'stepIndex', w, 'value');
  const model = agentModel(g.nodes, g.edges, ['si']);
  const r = M.compileAgentGraph(model.agentGraphNodes, model.agentGraphEdges, model, 0);
  check('Step Index compiles', !r.error, r.error ?? '');
  if (!r.error) {
    const params = /\(\s*function\s*\(([^)]*)\)/.exec(r.behaviourCode)[1].split(',').map(s => s.trim()).filter(Boolean);
    const store = { alive: new Uint8Array(2).fill(1), attrs: { si: new Float64Array(2) } };
    const fn = (0, eval)(r.behaviourCode);
    const seen = [];
    for (const gen of [0, 4, 8, 12]) { fn(...agentArgs(params, { N: 2, W: 24, H: 24, D: 1, generation: gen, store })); seen.push(store.attrs.si[0]); }
    check('Step Index === floor(gen / 4) on firing generations', seen.join(',') === '0,1,2,3', seen.join(','));
  }
}

// ===========================================================================
// 6. INIT / DIVISION semantics — both read the generation through their own ABI.
// ===========================================================================
console.log('\n== init / division semantics ==');
{
  const g = mkGraph();
  // Agent Init Event: Create → set the generation on it → Add.
  const init = g.n('agentInit');
  const create = g.n('createAgent', { _port_x: '1', _port_y: '1', _port_radius: '0.5' });
  const gg = g.n('getGeneration');
  const setA = g.n('setAgentAttribute', { attributeId: 'g0' });
  const add = g.n('addAgentToWorld');
  g.f(init, 'do', create, 'do'); g.f(create, 'next', setA, 'do'); g.f(setA, 'next', add, 'do');
  g.v(create, 'handle', setA, 'agentId'); g.v(gg, 'value', setA, 'value');
  g.v(create, 'handle', add, 'handle');
  // Division Event: stamp the generation on each daughter.
  const de = g.n('divisionEvent');
  const gg2 = g.n('getGeneration');
  const setD = g.n('setAttribute', { attributeId: 'gd' });
  g.f(de, 'do', setD, 'do'); g.v(gg2, 'value', setD, 'value');
  // A Behaviour Step so the model has a root the compilers expect.
  const bs = g.n('behaviourStep');
  const noop = g.n('setAttribute', { attributeId: 'g0' });
  g.f(bs, 'do', noop, 'do');

  const model = agentModel(g.nodes, g.edges, ['g0', 'gd']);
  const r = M.compileAgentGraph(model.agentGraphNodes, model.agentGraphEdges, model, 0);
  check('init + division compile with Get Generation', !r.error, r.error ?? '');
  if (!r.error) {
    check('the INIT signature carries `_generation`', /\(\s*function\s*\(([^)]*)\)/.exec(r.initCode)[1].includes('_generation'));
    check('the DIVISION signature carries `_generation`', /\(\s*function\s*\(([^)]*)\)/.exec(r.divisionCode)[1].includes('_generation'));

    // RUN the division event with a supplied generation — it must stamp exactly it.
    const dParams = /\(\s*function\s*\(([^)]*)\)/.exec(r.divisionCode)[1].split(',').map(s => s.trim()).filter(Boolean);
    const store = { alive: new Uint8Array(4).fill(1), attrs: { g0: new Float64Array(4), gd: new Float64Array(4) } };
    const dFn = (0, eval)(r.divisionCode);
    dFn(...agentArgs(dParams, { N: 4, W: 24, H: 24, D: 1, generation: 17, store }));
    check('a Division Event reads the generation it happened in (17)', store.attrs.gd[0] === 17, `got ${store.attrs.gd[0]}`);

    // RUN the init event: the worker resets the counter to 0 BEFORE running it, so
    // the pinned answer is 0. Feed 0 and assert the created agent got it.
    const iParams = /\(\s*function\s*\(([^)]*)\)/.exec(r.initCode)[1].split(',').map(s => s.trim()).filter(Boolean);
    let created = -1;
    const store2 = { alive: new Uint8Array(4), attrs: { g0: new Float64Array(4).fill(-1), gd: new Float64Array(4) } };
    const args = agentArgs(iParams, { N: 4, W: 24, H: 24, D: 1, generation: 0, store: store2 });
    args[iParams.indexOf('_agentCreate')] = () => { created = 0; return 0; };
    args[iParams.indexOf('_agentAddToWorld')] = (id) => { store2.alive[id] = 1; };
    (0, eval)(r.initCode)(...args);
    check('the Agent Init Event reads 0 (the counter is reset before it runs)', created === 0 && store2.attrs.g0[0] === 0, `got ${store2.attrs.g0[0]}`);
  }
}

// ===========================================================================
// 7. AGENT WASM + WebGPU emit — the gate + THE residency mechanism.
// ===========================================================================
console.log('\n== agent WASM + WebGPU emit ==');
{
  const g = mkGraph();
  const ps = g.n('periodicStep', { period: '10', phase: '0' });
  const gg = g.n('getGeneration');
  const w = g.n('setAttribute', { attributeId: 'a' });
  g.f(ps, 'do', w, 'do'); g.v(gg, 'value', w, 'value');
  const model = agentModel(g.nodes, g.edges, ['a']);

  check('the WASM agent gate ACCEPTS the cadence graph', M.isAgentGraphWasmSupported(model) === true);
  const wa = M.compileAgentGraphWasmForModel(model);
  check('the agent WASM module compiles', !wa.error && wa.bytes.length > 0, wa.error ?? '');
  check('the agent layout appends generationOffset LAST',
    !!wa.layout && wa.layout.totalBytes >= wa.layout.generationOffset + 8 &&
    [wa.layout.stopFlagOffset, wa.layout.rngStateOffset, wa.layout.scratchOffset].every(o => o <= wa.layout.generationOffset));

  check('the WebGPU agent gate ACCEPTS the cadence graph', M.isAgentGraphWebGPUSupported(model) === true);
  const wg = M.compileAgentGraphWebGPUForModel(model);
  check('the agent WGSL compiles', !wg.error, wg.error ?? '');
  if (!wg.error) {
    check('usesGeneration is reported to the runtime', wg.usesGeneration === true);
    check('WGSL declares the genCounter STORAGE binding (15)', /@binding\(15\)[^\n]*genCounter/.test(wg.shaderCode));
    check('WGSL reads f32(genCounter[0])', wg.shaderCode.includes('f32(genCounter[0])'));
    check('the generation is NOT taken from the Control uniform (it would freeze across a resident batch)',
      !/control\.generation/.test(wg.shaderCode));
  }

  // A graph that does NOT read the generation must declare no binding at all.
  {
    const g2 = mkGraph(); const bs = g2.n('behaviourStep'); const w2 = g2.n('setAttribute', { attributeId: 'a', _port_value: '1' });
    g2.f(bs, 'do', w2, 'do');
    const m2 = agentModel(g2.nodes, g2.edges, ['a']);
    const wg2 = M.compileAgentGraphWebGPUForModel(m2);
    check('no Get Generation ⇒ no genCounter binding', !wg2.error && !/genCounter/.test(wg2.shaderCode) && wg2.usesGeneration !== true);
    check('agentUsesGeneration === false for that graph', M.agentUsesGeneration(m2) === false);
  }

  // THE residency mechanism, at source level: the per-generation posCommit pass
  // owns the counter. (The behavioural proof is the in-browser residency test.)
  const rt = readFileSync(join(ROOT, 'src/simulator/engine/agentWebgpuRuntime.ts'), 'utf8');
  const posCommit = rt.slice(rt.indexOf('function emitPosCommitWGSL'), rt.indexOf('function emitPosCommitWGSL') + 2200);
  check('posCommit binds genCounter', /@binding\(2\)[^\n]*genCounter/.test(posCommit));
  check('posCommit bumps the counter from ONE invocation', /if \(i == 0u\) \{ genCounter\[0\] = genCounter\[0\] \+ 1u; \}/.test(posCommit));
  check('the bump runs BEFORE the highWater guard (an empty population still ticks)',
    posCommit.indexOf('genCounter[0] = genCounter[0] + 1u') < posCommit.indexOf('if (i >= hp.highWater)'));
  check('the resident batch seeds the counter once per batch',
    /uploadAgentGeneration\(rt, generation\);\s*\r?\n\s*rt\.device\.pushErrorScope/.test(readFileSync(join(ROOT, 'src/simulator/engine/sim.worker.ts'), 'utf8')));
}

// ===========================================================================
// 8. The ABI arity CONTRACT — params (compiler) ⊆ args (worker + harness).
// ===========================================================================
// The generation is the ONE ABI field whose PARAM side is gated while its ARG
// side is not. That is safe in exactly one direction: an extra trailing JS arg is
// ignored, a missing param reads `undefined`. Pin it here so a future edit that
// flips the asymmetry — gating the ARG side, or inserting the field mid-list —
// is caught, rather than shifting every later value by one slot.
console.log('\n== ABI arity contract ==');
{
  const base = { is3d: false, agentAttrs: [{ id: 'a' }], fieldAttrs: [], hasLookupTables: false, bondAttrs: [] };
  for (const kind of ['loop', 'division', 'init']) {
    const off = M.deriveAgentAbi(kind, { ...base, usesGeneration: false }).map(x => x.name);
    const on = M.deriveAgentAbi(kind, { ...base, usesGeneration: true }).map(x => x.name);
    check(`${kind}: OFF is a strict PREFIX of ON (append-only)`, on.slice(0, off.length).join(',') === off.join(','));
    check(`${kind}: ON adds exactly one trailing _generation`, on.length === off.length + 1 && on[on.length - 1] === '_generation');
    check(`${kind}: OFF declares no _generation`, !off.includes('_generation'));
    const on3d = M.deriveAgentAbi(kind, { ...base, is3d: true, usesGeneration: true }).map(x => x.name);
    check(`${kind} 3D: _generation stays LAST, after the 3D block`, on3d[on3d.length - 1] === '_generation');
  }
  // The worker's DEV arity assertion (the B1 desync net) had to learn about this
  // asymmetry, or it fires on EVERY agent model that doesn't read the generation
  // (caught by a real in-browser smoke run on the shipped Cubic GRA). It must
  // tolerate EXACTLY one slot, and only in the safe direction.
  const wsrc = readFileSync(join(ROOT, 'src/simulator/engine/sim.worker.ts'), 'utf8');
  check('the worker arity assertion tolerates exactly one trailing slot',
    /const arityOk = \(declared: number, want: number\) => declared === want \|\| declared === want - 1;/.test(wsrc));
  check('all three ABI pairs go through arityOk',
    (wsrc.match(/!arityOk\(/g) ?? []).length === 3, `${(wsrc.match(/!arityOk\(/g) ?? []).length} sites`);
  check('the DANGEROUS direction (params > args) is still an error',
    !/declared === want \+ 1/.test(wsrc));
}

console.log(failures === 0 ? '\nALL RULE-CADENCE CHECKS PASSED ✓' : `\n${failures} CHECK(S) FAILED ✗`);
rmSync(entryPath, { force: true });
rmSync(dir, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);

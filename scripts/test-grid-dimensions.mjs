// Get Grid Dimensions — functional verification across all six compile surfaces.
//
// The node exposes the world size (Width / Height / Depth) on BOTH graphs:
//   cells  → the JS step's `W`/`H`/`D` params; WASM/WebGPU bake the literals.
//   agents → the agent ABI's `_fieldW`/`_fieldH`/`_fieldTotal` (JS), the
//            fieldW/fieldH/fieldD f64 params (WASM), `control.fieldW/H/D` (WebGPU).
//
// What this checks (values, not just "it compiled"):
//   1. CELLS 2D + 3D — compile on JS / WASM / WebGPU; RUN the JS step and the REAL
//      WASM module in Node; every cell must hold exactly W, H, D. JS↔WASM bit-compared.
//   2. WGSL emit carries the baked literals.
//   3. AGENTS 2D + 3D — RUN the compiled JS behaviour loop; every agent must hold
//      exactly W, H, D. The WASM + WebGPU agent GATES must accept the node, and both
//      shaders/modules must compile.
//   4. The AGENT INIT EVENT — the trap: `_fieldD` is NOT in the Init Event's ABI, so a
//      naive emit would ReferenceError there. The init fn is RUN with its real ABI
//      param list and must produce the right depth from `_fieldTotal`.
//
// Run from the repo root:  node scripts/test-grid-dimensions.mjs
import { build } from 'esbuild';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
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
export { migrateForHarness } from '../src/dev/compileHarness.ts';
export { isNodeAvailable } from '../src/modeler/vpl/nodes/nodeValidation.ts';
export { setActiveGraphKind } from '../src/modeler/vpl/graphState.ts';
export { getNodeDef } from '../src/modeler/vpl/nodes/registry.ts';
`;
const dir = mkdtempSync(join(tmpdir(), 'gca-griddims-'));
const entryPath = join(ROOT, 'scripts', '__griddims_entry.ts');
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

// A dims-writing chain: <root> → Set(ow) → Set(oh) → Set(od), fed by one
// Get Grid Dimensions. Separate Set nodes (not multi-slot) so this exercises the
// plain single-slot path; the parity harness covers the multi-slot one.
const wireDims = (g, root, rootFlowPort, ids) => {
  const gd = g.n('getGridDimensions');
  const sw = g.n('setAttribute', { attributeId: ids[0] });
  const sh = g.n('setAttribute', { attributeId: ids[1] });
  const sd = g.n('setAttribute', { attributeId: ids[2] });
  g.f(root, rootFlowPort, sw, 'do'); g.f(sw, 'next', sh, 'do'); g.f(sh, 'next', sd, 'do');
  g.v(gd, 'width', sw, 'value'); g.v(gd, 'height', sh, 'value'); g.v(gd, 'depth', sd, 'value');
  return gd;
};

const cellAttr = (id) => ({ id, name: id, type: 'float', description: '', isModelAttribute: false, defaultValue: '0' });

// ===========================================================================
// 0. Editor availability — the node must be UNIVERSAL (cells AND agents).
// ===========================================================================
console.log('== availability ==');
{
  const def = M.getNodeDef('getGridDimensions');
  check('registered in the node registry', !!def);
  check('no capability requirements (universal)', !def.requirements);
  const model2d = { properties: { dimension: '2d', gridDepth: 1, updateMode: 'synchronous' }, topologyMode: { gridCells: true, agents: true } };
  const model3d = { properties: { dimension: '3d', gridDepth: 8, updateMode: 'synchronous' }, topologyMode: { gridCells: true, agents: true } };
  M.setActiveGraphKind('cells');
  check('available on the Cells graph', M.isNodeAvailable(def, model2d));
  M.setActiveGraphKind('agents');
  check('available on the Agents graph', M.isNodeAvailable(def, model2d));
  M.setActiveGraphKind('overseer');
  check('hidden on the Overseer graph (no W/H/D in the driver)', !M.isNodeAvailable(def, model2d));
  M.setActiveGraphKind('cells');
  check('Depth port hidden in 2D', def.hiddenPorts({}, model2d).includes('depth'));
  check('Depth port shown in 3D', !def.hiddenPorts({}, model3d).includes('depth'));
}

// ===========================================================================
// 1-2. CELLS — JS + WASM runtime, WebGPU emit. 2D and 3D.
// ===========================================================================
const cellCase = async (label, W, H, D) => {
  console.log(`\n== cells ${label} (${W}x${H}x${D}) ==`);
  const is3d = D > 1;
  const g = mkGraph();
  const step = g.n('step');
  wireDims(g, step, 'do', ['ow', 'oh', 'od']);
  const model = M.migrateForHarness({
    schemaVersion: 2,
    properties: {
      name: `GridDims ${label}`, description: '', topology: '2d-grid',
      boundaryTreatment: 'torus', updateMode: 'synchronous',
      gridWidth: W, gridHeight: H, dimension: is3d ? '3d' : '2d', gridDepth: D,
      useWasm: false,
    },
    attributes: [cellAttr('ow'), cellAttr('oh'), cellAttr('od')],
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
    const bufs = {
      total: TOTAL, W, H, D, WH: W * H,
      r_ow: new Float64Array(TOTAL), w_ow: new Float64Array(TOTAL),
      r_oh: new Float64Array(TOTAL), w_oh: new Float64Array(TOTAL),
      r_od: new Float64Array(TOTAL), w_od: new Float64Array(TOTAL),
      modelAttrs: {}, colors: new Uint8ClampedArray(TOTAL * 4), activeViewer: '',
      _indicators: {}, _linkedResults: {}, _rngState: new Uint32Array([0x12345678]),
      _stopFlag: new Uint32Array(1), glyphCodes: new Uint32Array(0), glyphColors: new Uint32Array(0),
      order: null, _skipped: new Uint8Array(0),
    };
    const missing = params.filter(p => !(p in bufs));
    check('JS step params all resolvable', missing.length === 0, `unknown: ${missing.join(', ')}`);
    if (!missing.length) {
      (0, eval)(js.stepCode)(...params.map(p => bufs[p]));
      const allEq = (a, v) => { for (let i = 0; i < TOTAL; i++) if (a[i] !== v) return false; return true; };
      check(`JS runtime width === ${W}`, allEq(bufs.w_ow, W), `got ${bufs.w_ow[0]}`);
      check(`JS runtime height === ${H}`, allEq(bufs.w_oh, H), `got ${bufs.w_oh[0]}`);
      check(`JS runtime depth === ${D}`, allEq(bufs.w_od, D), `got ${bufs.w_od[0]}`);
      jsOut = [Float64Array.from(bufs.w_ow), Float64Array.from(bufs.w_oh), Float64Array.from(bufs.w_od)];
    }
  }

  // --- WASM (real module, instantiated + run) ---
  const layout = M.computeLayoutFromModel(model);
  const wa = M.compileGraphWasm(model.graphNodes, model.graphEdges, model, layout, M.buildViewerIds(model));
  check('WASM compiles', !wa.error, wa.error ?? '');
  if (!wa.error) {
    check('WASM total === W*H*D', layout.total === TOTAL, `${layout.total} vs ${TOTAL}`);
    const mem = new WebAssembly.Memory({ initial: layout.pages });
    const env = { mem, pow: Math.pow, exp: Math.exp, log: Math.log, sin: Math.sin, cos: Math.cos, tan: Math.tan, tanh: Math.tanh, fmod: (a, b) => a % b };
    const { instance } = await WebAssembly.instantiate(wa.bytes, { env });
    instance.exports.step(TOTAL);
    const rd = (id) => new Float64Array(mem.buffer, layout.attrWriteOffset[id], TOTAL);
    const allEq = (a, v) => { for (let i = 0; i < TOTAL; i++) if (a[i] !== v) return false; return true; };
    check(`WASM runtime width === ${W}`, allEq(rd('ow'), W), `got ${rd('ow')[0]}`);
    check(`WASM runtime height === ${H}`, allEq(rd('oh'), H), `got ${rd('oh')[0]}`);
    check(`WASM runtime depth === ${D}`, allEq(rd('od'), D), `got ${rd('od')[0]}`);
    if (jsOut) {
      let diff = 0;
      for (const [k, id] of [[0, 'ow'], [1, 'oh'], [2, 'od']]) { const a = rd(id); for (let i = 0; i < TOTAL; i++) if (a[i] !== jsOut[k][i]) diff++; }
      check('JS ↔ WASM bit-identical', diff === 0, `${diff} mismatches`);
    }
  }

  // --- WebGPU (emit-level: real device run is verified in-browser) ---
  const wg = M.compileGraphWebGPU(model.graphNodes, model.graphEdges, model);
  check('WebGPU compiles', !wg.error, wg.error ?? '');
  if (!wg.error) {
    const s = wg.shaderCode;
    check('WGSL bakes the width/height/depth literals',
      new RegExp(`let _gdW\\d+: i32 = ${W};`).test(s) && new RegExp(`let _gdH\\d+: i32 = ${H};`).test(s) && new RegExp(`let _gdD\\d+: i32 = ${D};`).test(s),
      'literal lets missing');
  }
};

await cellCase('2D', 7, 5, 1);
await cellCase('3D', 6, 4, 3);

// ===========================================================================
// 3-4. AGENTS — the behaviour loop AND the Init Event (the `_fieldD` trap).
// ===========================================================================
// Build the ABI arg list generically from the emitted param names, so the test
// tracks the real ABI (a new field just gets a sane default rather than breaking).
const agentArgs = (params, { N, W, H, D, spec }) => params.map((p) => {
  switch (p) {
    case 'highWater': return N;
    case '_alive': return new Uint8Array(N).fill(1);
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
    case '_hashValid': return 0;
    case '_hashBinStart': case '_hashBinAgents': return new Int32Array(1);
    case 'idx': case '__daughterIndex': case '__axisDefaultX': case '__axisDefaultY': return 0;
    default:
      if (p.startsWith('_hash')) return 1;              // nBins* / binSize* / origin* scalars
      if (spec.has(p)) return spec.get(p);              // the attr buffers we assert on
      if (p.startsWith('r_') || p.startsWith('w_') || p.startsWith('_field_')) return new Float64Array(N);
      if (p.startsWith('_agent') || p.startsWith('_bond') || p.startsWith('_divide') || p.startsWith('_kill') || p.startsWith('sprite')) return new Float64Array(N);
      throw new Error(`agent ABI param not modelled by the test: ${p}`);
  }
});

const agentCase = (label, W, H, D) => {
  console.log(`\n== agents ${label} (world ${W}x${H}x${D}) ==`);
  const is3d = D > 1;
  const N = 8;

  // Behaviour graph: dims → three agent attrs. PLUS an Agent Init Event that spawns
  // agents AT the world dimensions (Create Agent x=Width, y=Height[, z=Depth] → Add
  // Agent To World) — the init root's ABI has NO `_fieldD`, so this is exactly the
  // path a naive `_fieldD` emit would blow up on. (Per-agent writers like Set
  // Attribute can't run in the once-only init — that's the documented footgun — so
  // the init test uses the real spawn idiom.)
  const g = mkGraph();
  const bs = g.n('behaviourStep');
  wireDims(g, bs, 'do', ['bw', 'bh', 'bd']);
  const ai = g.n('agentInit');
  const loop = g.n('loop', { _port_count: String(N) });
  g.f(ai, 'do', loop, 'do');
  const igd = g.n('getGridDimensions');
  const ca = g.n('createAgent', { _port_radius: '1' });
  const add = g.n('addAgentToWorld');
  g.f(loop, 'body', ca, 'do'); g.f(ca, 'next', add, 'do');
  g.v(ca, 'handle', add, 'handle');
  g.v(igd, 'width', ca, 'x');
  g.v(igd, 'height', ca, 'y');
  if (is3d) g.v(igd, 'depth', ca, 'z');

  const aAttr = (id) => ({ id, name: id, type: 'float', description: '', isModelAttribute: false, defaultValue: '0' });
  const model = M.migrateForHarness({
    schemaVersion: 2,
    properties: {
      name: `GridDims agents ${label}`, description: '', topology: '2d-grid',
      boundaryTreatment: 'torus', updateMode: 'synchronous',
      gridWidth: W, gridHeight: H, dimension: is3d ? '3d' : '2d', gridDepth: D,
      useWasm: false, useWebGPU: false,
    },
    topologyMode: { gridCells: false, agents: true },
    centerBased: { enabled: true, maxAgents: N, maxBonds: 0, worldWidth: W, worldHeight: H, worldDepth: D, seedCount: N, seedPattern: 'scatter', defaultRadius: 0.5, growthRate: 0, repulsionStiffness: 2, adhesionStiffness: 0, interactionRange: 1.5, drag: 1, timeStep: 0.1, momentum: 0, maxSpeed: 0, neighbourQueryRadius: 4, useBondingPhysics: false, autoBond: false, agentTarget: 'wasm', agentUpdateMode: 'async' },
    attributes: [], neighborhoods: [], mappings: [], indicators: [],
    agentAttributes: ['bw', 'bh', 'bd', 'iw', 'ih', 'id'].map(aAttr),
    variables: [], agentVariables: [],
    graphNodes: [], graphEdges: [],
    agentGraphNodes: g.nodes, agentGraphEdges: g.edges, macroDefs: [],
  });

  const ag = M.compileAgentGraph(model.agentGraphNodes, model.agentGraphEdges, model);
  check('agent graph compiles (behaviour + init)', !ag.error, ag.error ?? '');
  if (ag.error) return;

  // --- run the JS BEHAVIOUR loop ---
  {
    const spec = new Map();
    for (const id of ['bw', 'bh', 'bd', 'iw', 'ih', 'id']) { spec.set(`r_${id}`, new Float64Array(N)); spec.set(`w_${id}`, new Float64Array(N)); }
    const params = /\(\s*function\s*\(([^)]*)\)/.exec(ag.behaviourCode)[1].split(',').map(s => s.trim()).filter(Boolean);
    (0, eval)(ag.behaviourCode)(...agentArgs(params, { N, W, H, D, spec }));
    const allEq = (a, v) => { for (let i = 0; i < N; i++) if (a[i] !== v) return false; return true; };
    check(`JS behaviour width === ${W}`, allEq(spec.get('w_bw'), W), `got ${spec.get('w_bw')[0]}`);
    check(`JS behaviour height === ${H}`, allEq(spec.get('w_bh'), H), `got ${spec.get('w_bh')[0]}`);
    check(`JS behaviour depth === ${D}`, allEq(spec.get('w_bd'), D), `got ${spec.get('w_bd')[0]}`);
  }

  // --- run the JS AGENT INIT EVENT (no `_fieldD` in its ABI — the trap) ---
  {
    check('init code emitted', !!ag.initCode);
    const spec = new Map();
    for (const id of ['bw', 'bh', 'bd']) { spec.set(`r_${id}`, new Float64Array(N)); spec.set(`w_${id}`, new Float64Array(N)); }
    const params = /\(\s*function\s*\(([^)]*)\)/.exec(ag.initCode)[1].split(',').map(s => s.trim()).filter(Boolean);
    check('init ABI has NO _fieldD (the trap this guards)', !params.includes('_fieldD'));
    // `_agentCreate(x, y, z, radius)` — record every spawn so we can assert the
    // dims actually reached it. A `_fieldD` reference in the emit would throw here.
    const created = [];
    const args = agentArgs(params, { N, W, H, D, spec });
    args[params.indexOf('_agentCreate')] = (...a) => { created.push(a); return created.length - 1; };
    let threw = null;
    try { (0, eval)(ag.initCode)(...args); } catch (e) { threw = String((e && e.message) || e); }
    check('init event runs (no `_fieldD is not defined`)', threw === null, threw ?? '');
    check(`init spawned ${N} agents`, created.length === N, `got ${created.length}`);
    if (created.length) {
      check(`init Create Agent x === width (${W})`, created.every(c => c[0] === W), `got ${created[0][0]}`);
      check(`init Create Agent y === height (${H})`, created.every(c => c[1] === H), `got ${created[0][1]}`);
      if (is3d) check(`init Create Agent z === depth (${D})`, created.every(c => c[2] === D), `got ${created[0][2]}`);
    }
  }

  // --- agent WASM: gate + compile ---
  {
    const supported = M.isAgentGraphWasmSupported(model);
    check('agent WASM gate accepts the node', supported === true);
    if (supported) {
      const r = M.compileAgentGraphWasmForModel(model);
      check('agent WASM module compiles', !r.error && r.bytes?.length > 0, r.error ?? '');
      check('agent WASM module validates', WebAssembly.validate(r.bytes.buffer.slice(r.bytes.byteOffset, r.bytes.byteOffset + r.bytes.byteLength)));
    }
  }

  // --- agent WebGPU: gate + shader emit ---
  {
    const supported = M.isAgentGraphWebGPUSupported(model);
    check('agent WebGPU gate accepts the node', supported === true);
    if (supported) {
      const r = M.compileAgentGraphWebGPUForModel(model);
      check('agent WebGPU shader compiles', !r.error && !!r.shaderCode, r.error ?? '');
      const s = r.shaderCode || '';
      check('WGSL reads control.fieldW / fieldH' + (is3d ? ' / fieldD' : ''),
        /let _gdim\d+: f32 = control\.fieldW;/.test(s) && /let _gdim\d+: f32 = control\.fieldH;/.test(s)
        && (!is3d || /let _gdim\d+: f32 = control\.fieldD;/.test(s)),
        'control.field* reads missing');
    }
  }
};

agentCase('2D', 24, 18, 1);
agentCase('3D', 21, 13, 7);

console.log(failures === 0 ? '\nALL GRID-DIMENSION TESTS PASSED' : `\n${failures} FAILURE(S)`);
rmSync(entryPath, { force: true });
rmSync(dir, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);

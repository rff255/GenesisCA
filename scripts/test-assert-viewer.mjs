// Assert Active Output Mapping — functional verification on ALL THREE cell
// targets (JS, a REAL instantiated WASM module, and the emitted WGSL).
//
// The node guards a branch on "is this Attribute→Color mapping the viewer the
// simulator is currently showing", so viz-only work costs nothing when its
// viewer is off screen. What this checks — VALUES and STRUCTURE, not just
// "it compiled":
//   0. The node def + the editor gating (lattice-only, the A→C-only validation).
//   1. CELLS — with viewer A active the guarded write HAPPENS and with viewer B
//      active it does NOT, on the compiled JS step AND on a real WASM module,
//      while the DONE (`next`) chain runs in BOTH cases.
//   2. The SINK property — a value consumed ONLY inside the guard is emitted
//      INSIDE the branch (that is the entire point of the node; a transparent
//      `next`-style guard would leave the work above it).
//   3. WGSL emit carries the `control.activeViewer` compare.
//   4. Degenerate configs (unset / C→A / no branch wired) drop the branch on
//      every target rather than emitting a dangling reference.
//
// Run from the repo root:  node scripts/test-assert-viewer.mjs
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
export { getNodeDef } from '../src/modeler/vpl/nodes/registry.ts';
export { isNodeAvailable, detectMissingConfig, LATTICE_ONLY_TYPES } from '../src/modeler/vpl/nodes/nodeValidation.ts';
export { setActiveGraphKind } from '../src/modeler/vpl/graphState.ts';
`;
const dir = mkdtempSync(join(tmpdir(), 'gca-assertviewer-'));
const entryPath = join(ROOT, 'scripts', '__assertviewer_entry.ts');
writeFileSync(entryPath, ENTRY);
const outPath = join(dir, 'bundle.mjs');
await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: process.cwd() });
const M = await import(pathToFileURL(outPath).href);
rmSync(entryPath, { force: true });

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
const cellAttr = (id, dflt = '0') => ({ id, name: id, type: 'float', description: '', isModelAttribute: false, defaultValue: dflt });
const a2c = (id) => ({ id, name: id, isAttributeToColor: true, description: '', redDescription: '', greenDescription: '', blueDescription: '' });
const c2a = (id) => ({ id, name: id, isAttributeToColor: false, description: '', redDescription: '', greenDescription: '', blueDescription: '' });

const W = 16, H = 16, TOTAL = W * H;
const SEED_VALUE = 3;

/** Step: assert(mappingId) → [IF ACTIVE: guarded = seed * 2] ; [DONE: always = 1].
 *  `seed` is a per-cell READ, so the doubling value is NOT loop-invariant and
 *  must be SUNK into the branch rather than hoisted to the function preamble —
 *  which is what check (2) measures. */
const buildModel = (mappingId, opts = {}) => {
  const g = mkGraph();
  const step = g.n('step');
  const assertNode = g.n('assertActiveViewer', mappingId === undefined ? {} : { mappingId });
  g.f(step, 'do', assertNode, 'do');

  let guardedValue = null;
  if (!opts.noBranch) {
    const read = g.n('getCellAttribute', { attributeId: 'seed' });
    const dbl = g.n('arithmeticOperator', { operation: '*', _port_y: '2' });
    g.v(read, 'value', dbl, 'x');
    const setG = g.n('setAttribute', { attributeId: 'guarded' });
    g.v(dbl, 'result', setG, 'value');
    g.f(assertNode, 'then', setG, 'do');
    guardedValue = dbl;
  }
  const setA = g.n('setAttribute', { attributeId: 'always', _port_value: '1' });
  g.f(assertNode, 'next', setA, 'do');

  const model = M.migrateForHarness({
    schemaVersion: 2,
    properties: {
      name: 'AssertActiveViewer', description: '', topology: '2d-grid',
      boundaryTreatment: 'torus', updateMode: 'synchronous',
      gridWidth: W, gridHeight: H, dimension: '2d', gridDepth: 1, useWasm: false,
    },
    attributes: [cellAttr('seed', String(SEED_VALUE)), cellAttr('guarded'), cellAttr('always')],
    neighborhoods: [],
    mappings: [a2c('viewA'), a2c('viewB'), c2a('brush')],
    indicators: [],
    graphNodes: g.nodes, graphEdges: g.edges, macroDefs: [],
    topologyMode: { gridCells: true, agents: false },
  });
  return { model, guardedValue, assertNode };
};

const ATTRS = ['seed', 'guarded', 'always'];

const runJs = (model, activeViewer) => {
  const js = M.compileGraph(model.graphNodes, model.graphEdges, model);
  if (js.error) return { error: js.error };
  const params = /\(\s*function\s*\(([^)]*)\)/.exec(js.stepCode)[1].split(',').map(s => s.trim()).filter(Boolean);
  const bufs = {
    total: TOTAL, W, H, D: 1, WH: TOTAL,
    modelAttrs: {}, colors: new Uint8ClampedArray(TOTAL * 4), activeViewer,
    _indicators: {}, _linkedResults: {}, _rngState: new Uint32Array([1]),
    _stopFlag: new Uint32Array(1), glyphCodes: new Uint32Array(0), glyphColors: new Uint32Array(0),
    order: null, _skipped: new Uint8Array(0),
  };
  for (const id of ATTRS) {
    bufs[`r_${id}`] = new Float64Array(TOTAL).fill(id === 'seed' ? SEED_VALUE : 0);
    bufs[`w_${id}`] = new Float64Array(TOTAL);
  }
  const missing = params.filter(p => !(p in bufs));
  if (missing.length) return { error: `unresolved step params: ${missing.join(', ')}` };
  (0, eval)(js.stepCode)(...params.map(p => bufs[p]));
  const out = {};
  for (const id of ATTRS) out[id] = bufs[`w_${id}`];
  return { out, code: js.stepCode };
};

const runWasm = async (model, activeViewer) => {
  const layout = M.computeLayoutFromModel(model);
  const viewerIds = M.buildViewerIds(model);
  const wa = M.compileGraphWasm(model.graphNodes, model.graphEdges, model, layout, viewerIds);
  if (wa.error) return { error: wa.error };
  const mem = new WebAssembly.Memory({ initial: layout.pages });
  const env = { mem, pow: Math.pow, exp: Math.exp, log: Math.log, sin: Math.sin, cos: Math.cos, tan: Math.tan, tanh: Math.tanh, fmod: (a, b) => a % b };
  const { instance } = await WebAssembly.instantiate(wa.bytes, { env });
  // Seed the READ buffers + the activeViewer word exactly as the worker does.
  new Float64Array(mem.buffer, layout.attrReadOffset['seed'], TOTAL).fill(SEED_VALUE);
  const vi = viewerIds[activeViewer];
  new Int32Array(mem.buffer, layout.activeViewerOffset, 1)[0] = vi === undefined ? -1 : vi;
  instance.exports.step(TOTAL);
  const out = {};
  for (const id of ATTRS) out[id] = new Float64Array(mem.buffer, layout.attrWriteOffset[id], TOTAL).slice();
  return { out, viewerIds };
};

const all = (arr, v) => Array.from(arr).every(x => x === v);

// ===========================================================================
// 0. Node definition + editor gating.
// ===========================================================================
console.log('== node definition + gating ==');
{
  const def = M.getNodeDef('assertActiveViewer');
  check('registered', !!def);
  const ids = def.ports.map(p => p.id);
  check('has a flow input `do`', ids.includes('do')
    && def.ports.find(p => p.id === 'do').kind === 'input');
  check('has the GUARDED branch output `then`', ids.includes('then')
    && def.ports.find(p => p.id === 'then').kind === 'output'
    && def.ports.find(p => p.id === 'then').category === 'flow');
  check('has the UNGUARDED pass-through `next`', ids.includes('next')
    && def.ports.find(p => p.id === 'next').kind === 'output');
  check('DONE renders before the branch (aligned with the flow input)',
    ids.indexOf('next') < ids.indexOf('then'));
  check('there is NO `else` port (this is conditional MINUS the else)', !ids.includes('else'));
  check('it is a flow node', def.category === 'flow');
  check('its compile() emits nothing (the compilers own the branch)', def.compile() === '');

  check('listed in LATTICE_ONLY_TYPES', M.LATTICE_ONLY_TYPES.has('assertActiveViewer'));
  const { model } = buildModel('viewA');
  M.setActiveGraphKind('cells');
  check('available on the CELLS graph', M.isNodeAvailable(def, model));
  M.setActiveGraphKind('agents');
  const agentModel = { ...model, topologyMode: { gridCells: true, agents: true } };
  check('HIDDEN on the AGENTS graph (no activeViewer in the agent WebGPU shader)',
    !M.isNodeAvailable(def, agentModel));
  M.setActiveGraphKind('overseer');
  check('HIDDEN on the OVERSEER graph', !M.isNodeAvailable(def, agentModel));
  M.setActiveGraphKind('cells');

  const issues = (cfg) => M.detectMissingConfig('assertActiveViewer', cfg, model, new Set());
  check('an UNSET mapping is badged', issues({}).length > 0);
  check('a C→A (brush) mapping is badged', issues({ mappingId: 'brush' }).length > 0);
  check('an unknown mapping is badged', issues({ mappingId: 'nope' }).length > 0);
  check('an A→C mapping is clean', issues({ mappingId: 'viewA' }).length === 0);
}

// ===========================================================================
// 1. CELLS — the guard actually gates the write (JS + a real WASM module).
// ===========================================================================
console.log('\n== cells: the guard gates the branch (JS vs a real WASM module) ==');
{
  const { model } = buildModel('viewA');
  for (const [viewer, expectGuarded] of [['viewA', SEED_VALUE * 2], ['viewB', 0]]) {
    const js = runJs(model, viewer);
    check(`JS runs with activeViewer=${viewer}`, !js.error, js.error ?? '');
    const wa = await runWasm(model, viewer);
    check(`WASM runs with activeViewer=${viewer}`, !wa.error, wa.error ?? '');
    if (js.error || wa.error) continue;
    const verb = expectGuarded ? 'HAPPENS' : 'is SKIPPED';
    check(`  ↳ JS: the guarded write ${verb} (guarded = ${expectGuarded})`,
      all(js.out.guarded, expectGuarded), `first ${js.out.guarded[0]}`);
    check(`  ↳ WASM: the guarded write ${verb} (guarded = ${expectGuarded})`,
      all(wa.out.guarded, expectGuarded), `first ${wa.out.guarded[0]}`);
    check(`  ↳ JS: the DONE chain runs REGARDLESS (always = 1)`, all(js.out.always, 1));
    check(`  ↳ WASM: the DONE chain runs REGARDLESS (always = 1)`, all(wa.out.always, 1));
  }
  // A viewer the model doesn't have (nothing selected) must behave like "not this one".
  const jsNone = runJs(model, '');
  check('activeViewer = "" (nothing selected) skips the branch', !jsNone.error && all(jsNone.out.guarded, 0));
  const waNone = await runWasm(model, '');
  check('  ↳ WASM agrees', !waNone.error && all(waNone.out.guarded, 0));
}

// ===========================================================================
// 2. The SINK property — the whole reason the branch is a real scope.
// ===========================================================================
console.log('\n== the guarded value is emitted INSIDE the branch ==');
{
  const { model, guardedValue } = buildModel('viewA');
  const js = runJs(model, 'viewA');
  check('JS compiles', !js.error, js.error ?? '');
  if (!js.error) {
    const guardAt = js.code.indexOf('if (_isV_');
    const valueAt = js.code.indexOf(`_v${guardedValue.id} =`);
    check('the emit carries the `_isV_` guard', guardAt >= 0);
    check('the guarded-only value is declared AFTER the guard opens (sunk into the branch)',
      guardAt >= 0 && valueAt > guardAt,
      `guard@${guardAt} value@${valueAt}`);
    // Sanity: the unconditional write is NOT inside the branch.
    const closeAt = js.code.indexOf('}', valueAt);
    check('the DONE write lands after the branch closes',
      js.code.indexOf('w_always[idx]') > closeAt);
  }
}

// ===========================================================================
// 3. WGSL emit.
// ===========================================================================
console.log('\n== WebGPU (cell) emit ==');
{
  const { model } = buildModel('viewA');
  const r = M.compileGraphWebGPU(model.graphNodes, model.graphEdges, model);
  check('compiles', !r.error, r.error ?? '');
  const viewerIds = M.buildViewerIds(model);
  check('emits the control.activeViewer compare for the chosen viewer',
    !r.error && r.shaderCode.includes(`if (control.activeViewer == ${viewerIds['viewA']})`));
  check('it guards the branch, not the whole step',
    !r.error && r.shaderCode.includes('attrsWrite') );
  // viewB is a DIFFERENT integer — a hard-coded 0 would pass the check above.
  const { model: mB } = buildModel('viewB');
  const rB = M.compileGraphWebGPU(mB.graphNodes, mB.graphEdges, mB);
  check('a different mapping emits a DIFFERENT viewer integer',
    !rB.error && rB.shaderCode.includes(`if (control.activeViewer == ${viewerIds['viewB']})`)
    && viewerIds['viewA'] !== viewerIds['viewB']);
}

// ===========================================================================
// 4. Degenerate configs — drop the branch, never dangle.
// ===========================================================================
console.log('\n== degenerate configs drop the branch on every target ==');
{
  // An UNKNOWN id is a different case from an unset / wrong-direction one: it is
  // caught UPSTREAM by the shared pre-compile dangling-reference gate, which
  // returns a NAMED error instead of silently dropping the branch (the node
  // needed no code for this — `mappingId` is already in that gate's key space).
  {
    const { model } = buildModel('ghost');
    const js = runJs(model, 'viewA');
    check('an unknown mapping is a NAMED compile error, not a silent drop',
      !!js.error && js.error.includes('missing mapping') && js.error.includes('ghost'),
      js.error ?? 'compiled with no error');
  }
  for (const [label, mid] of [['an UNSET mapping', undefined], ['a C→A mapping', 'brush']]) {
    const { model } = buildModel(mid);
    const js = runJs(model, 'viewA');
    check(`${label}: JS compiles + runs`, !js.error, js.error ?? '');
    if (!js.error) {
      check(`  ↳ the branch is dropped (guarded stays 0)`, all(js.out.guarded, 0));
      check(`  ↳ DONE still runs (always = 1)`, all(js.out.always, 1));
      // No guard is EMITTED at all (the `_isV_` hoist block itself always
      // declares one const per model mapping — that is pre-existing and inert).
      check(`  ↳ no guard BLOCK is emitted`, !js.code.includes('if (_isV_'));
    }
    const wa = await runWasm(model, 'viewA');
    check(`${label}: WASM compiles + runs with the branch dropped`,
      !wa.error && all(wa.out.guarded, 0) && all(wa.out.always, 1), wa.error ?? '');
    const wg = M.compileGraphWebGPU(model.graphNodes, model.graphEdges, model);
    check(`${label}: WGSL compiles with no viewer guard`,
      !wg.error && !wg.shaderCode.includes('control.activeViewer =='), wg.error ?? '');
  }
  // The node with NOTHING wired to IF ACTIVE is a plain pass-through.
  const { model } = buildModel('viewA', { noBranch: true });
  const js = runJs(model, 'viewA');
  check('no branch wired: compiles, DONE still runs', !js.error && all(js.out.always, 1), js.error ?? '');
  check('  ↳ and emits no empty guard block', !js.error && !js.code.includes('if (_isV_'));
}

console.log(`\n${failures === 0 ? 'ALL ASSERT-ACTIVE-VIEWER CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);

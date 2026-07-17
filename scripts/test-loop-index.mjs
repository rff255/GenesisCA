// Loop node `index` output — functional verification (grid targets).
//
//  A synthetic model runs Loop(5) per cell; the body:
//    1. increments `acc` by expression(index*2+1)      — Σ over 0..4 = 25/step
//    2. inside Conditional(Compare(index >= 3)):
//       increments `acc2` by the raw index             — Σ = 3+4 = 7/step
//  This exercises the three consumer shapes the scoping machinery must pin
//  INSIDE the loop: a value chain (expression), a Compare inside a nested
//  branch, and a direct flow-node input. A hoisted (buggy) index would give
//  acc = 5 (5×1) or a ReferenceError.
//
//  Verified: JS runtime values, WASM runtime values (real instantiation),
//  JS ↔ WASM bit-identity, and the WGSL emit (loop counter used inside the
//  for block, no compile errors). The AGENT surfaces are covered by
//  scripts/parity-agent-wasm.mjs ("[synthetic] Loop index output").
//
// Run from the repo root:  node scripts/test-loop-index.mjs
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
export { compileOverseerGraph } from '../src/modeler/vpl/compiler/overseer/compile.ts';
export { isAgentGraphWebGPUSupported, compileAgentGraphWebGPUForModel } from '../src/modeler/vpl/compiler/agentWebgpu/compile.ts';
`;
const dir = mkdtempSync(join(tmpdir(), 'gca-loopidx-'));
const entryPath = join(ROOT, 'scripts', '__loopidx_entry.ts');
writeFileSync(entryPath, ENTRY);
const outPath = join(dir, 'bundle.mjs');
await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: process.cwd() });
const M = await import(pathToFileURL(outPath).href);
rmSync(entryPath);

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ok  ${name}`);
  else { console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); failures++; }
};

const used = new Set();
const nid = (p) => { let id; do { id = p + Math.random().toString(36).slice(2, 8); } while (used.has(id)); used.add(id); return id; };
const graphNodes = [], graphEdges = [];
const node = (nodeType, config) => { const n = { id: nid('n'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType, config } }; graphNodes.push(n); return n; };
const edge = (s, sp, t, tp, cat) => graphEdges.push({ id: nid('e'), source: s.id, target: t.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
const vEdge = (s, sp, t, tp) => edge(s, sp, t, tp, 'value');
const fEdge = (s, sp, t, tp) => edge(s, sp, t, tp, 'flow');

const step = node('step', {});
const lp = node('loop', { _port_count: '5' });
fEdge(step, 'do', lp, 'do');
const ex = node('expression', { expression: 'a*2+1', visibleCount: 1 });
vEdge(lp, 'index', ex, 'a');
const upd1 = node('updateAttribute', { attributeId: 'acc', operation: 'increment' });
vEdge(ex, 'result', upd1, 'value');
fEdge(lp, 'body', upd1, 'do');
const cmp = node('statement', { operation: '>=', compareType: 'numerical', _port_y: '3' });
vEdge(lp, 'index', cmp, 'x');
const cond = node('conditional', {});
vEdge(cmp, 'result', cond, 'condition');
fEdge(upd1, 'next', cond, 'do');
const upd2 = node('updateAttribute', { attributeId: 'acc2', operation: 'increment' });
vEdge(lp, 'index', upd2, 'value');
fEdge(cond, 'then', upd2, 'do');

const W = 8, H = 8, TOTAL = W * H;
const model = M.migrateForHarness({
  schemaVersion: 2,
  properties: {
    name: 'Loop Index Test', description: '', topology: '2d-grid',
    boundaryTreatment: 'torus', updateMode: 'synchronous',
    gridWidth: W, gridHeight: H, dimension: '2d', gridDepth: 1,
    useWasm: false,
  },
  attributes: [
    { id: 'acc', name: 'acc', type: 'float', description: '', isModelAttribute: false, defaultValue: '0' },
    { id: 'acc2', name: 'acc2', type: 'float', description: '', isModelAttribute: false, defaultValue: '0' },
  ],
  neighborhoods: [],
  mappings: [],
  indicators: [],
  graphNodes, graphEdges, macroDefs: [],
  topologyMode: { gridCells: true, agents: false },
});

const EXPECTED_ACC = 25;   // Σ (2i+1), i = 0..4
const EXPECTED_ACC2 = 7;   // 3 + 4

// --- JS target ---
console.log('== JS target ==');
const js = M.compileGraph(model.graphNodes, model.graphEdges, model);
check('JS compiles', !js.error, js.error ?? '');
let jsAcc = null, jsAcc2 = null;
if (!js.error) {
  const m = /\(\s*function\s*\(([^)]*)\)/.exec(js.stepCode);
  const params = m[1].split(',').map(s => s.trim()).filter(Boolean);
  const bufs = {
    total: TOTAL,
    r_acc: new Float64Array(TOTAL), w_acc: new Float64Array(TOTAL),
    r_acc2: new Float64Array(TOTAL), w_acc2: new Float64Array(TOTAL),
    modelAttrs: {}, colors: new Uint8ClampedArray(TOTAL * 4), activeViewer: '',
    _indicators: {},
    r_orientation: new Int32Array(TOTAL), w_orientation: new Int32Array(TOTAL),
    _facePatternLookup: new Int32Array(0),
    _lookupTables: {},
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
    let badA = 0, badB = 0;
    for (let i = 0; i < TOTAL; i++) {
      if (bufs.w_acc[i] !== EXPECTED_ACC) badA++;
      if (bufs.w_acc2[i] !== EXPECTED_ACC2) badB++;
    }
    check(`JS acc == ${EXPECTED_ACC} everywhere (value-chain consumer)`, badA === 0, `${badA}/${TOTAL} (got ${bufs.w_acc[0]})`);
    check(`JS acc2 == ${EXPECTED_ACC2} everywhere (branch + direct consumers)`, badB === 0, `${badB}/${TOTAL} (got ${bufs.w_acc2[0]})`);
    jsAcc = Float64Array.from(bufs.w_acc); jsAcc2 = Float64Array.from(bufs.w_acc2);
  }
}

// --- WASM target ---
console.log('== WASM target ==');
const layout = M.computeLayoutFromModel(model);
const wa = M.compileGraphWasm(model.graphNodes, model.graphEdges, model, layout, M.buildViewerIds(model));
check('WASM compiles', !wa.error, wa.error ?? '');
if (!wa.error) {
  check('WASM validates', WebAssembly.validate(wa.bytes.buffer.slice(wa.bytes.byteOffset, wa.bytes.byteOffset + wa.bytes.byteLength)));
  const mem = new WebAssembly.Memory({ initial: layout.pages });
  const env = { mem, pow: Math.pow, exp: Math.exp, log: Math.log, sin: Math.sin, cos: Math.cos, tan: Math.tan, tanh: Math.tanh, fmod: (a, b) => a % b };
  const { instance } = await WebAssembly.instantiate(wa.bytes, { env });
  instance.exports.step(TOTAL);
  const wAcc = new Float64Array(mem.buffer, layout.attrWriteOffset['acc'], TOTAL);
  const wAcc2 = new Float64Array(mem.buffer, layout.attrWriteOffset['acc2'], TOTAL);
  let badA = 0, badB = 0;
  for (let i = 0; i < TOTAL; i++) {
    if (wAcc[i] !== EXPECTED_ACC) badA++;
    if (wAcc2[i] !== EXPECTED_ACC2) badB++;
  }
  check(`WASM acc == ${EXPECTED_ACC} everywhere`, badA === 0, `${badA}/${TOTAL} (got ${wAcc[0]})`);
  check(`WASM acc2 == ${EXPECTED_ACC2} everywhere`, badB === 0, `${badB}/${TOTAL} (got ${wAcc2[0]})`);
  if (jsAcc) {
    let diff = 0;
    for (let i = 0; i < TOTAL; i++) if (wAcc[i] !== jsAcc[i] || wAcc2[i] !== jsAcc2[i]) diff++;
    check('JS ↔ WASM bit-identical', diff === 0, `${diff}/${TOTAL}`);
  }
}

// --- WebGPU target (emit-level: string + error check; device run in-browser) ---
console.log('== WebGPU target (emit) ==');
const wg = M.compileGraphWebGPU(model.graphNodes, model.graphEdges, model);
check('WebGPU compiles', !wg.error, wg.error ?? '');
if (!wg.error) {
  const s = wg.shaderCode;
  const forAt = s.search(/for \(var _li\d+: i32 = 0;/);
  check('WGSL has the loop counter for-statement', forAt >= 0);
  if (forAt >= 0) {
    const liName = /for \(var (_li\d+): i32/.exec(s.slice(forAt))[1];
    // The consumer chain must reference the counter INSIDE the for block —
    // i.e. after the for line (declarations before it would be out of scope).
    const body = s.slice(forAt);
    const closeAt = body.indexOf('\n  }');
    const inside = body.slice(0, closeAt);
    check('WGSL index consumers reference the counter inside the loop',
      inside.split(liName).length > 2, `counter "${liName}" not used in body`);
    check('WGSL: no counter reference BEFORE the loop', !s.slice(0, forAt).includes(`(${liName})`) && !s.slice(0, forAt).includes(` ${liName};`));
  }
}

// --- Overseer driver (emit-level) ---
console.log('== Overseer driver (emit) ==');
{
  const oN = [], oEd = [];
  const on = (t, c) => { const n = { id: nid('o'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; oN.push(n); return n; };
  const oE = (s, sp, t, tp, cat) => oEd.push({ id: nid('e'), source: s.id, target: t.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
  const root = on('experiment', {});
  const olp = on('loop', { _port_count: '3' });
  oE(root, 'do', olp, 'do', 'flow');
  const olog = on('ovLog', { message: 'iteration {value}' });
  oE(olp, 'index', olog, 'value', 'value');
  oE(olp, 'body', olog, 'do', 'flow');
  const res = M.compileOverseerGraph(oN, oEd, model);
  check('overseer compiles', !res.error && !!res.driverCode, res.error ?? 'no driver');
  if (res.driverCode) {
    check('overseer driver references the loop var in the body',
      res.driverCode.includes(`_l${olp.id}`) && res.driverCode.includes('O.log'));
    // Run the driver against a mock O to prove the emitted JS is executable and
    // the index value reaches the log.
    const logged = [];
    const O = {
      aborted: false,
      log: (msg) => logged.push(msg),
      logT: (tpl, v) => logged.push(v),
    };
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    await new AsyncFunction('O', res.driverCode)(O);
    check('overseer runtime logs 0,1,2', JSON.stringify(logged.map(s => String(s))).includes('0') && logged.length === 3, JSON.stringify(logged));
  }
}

// --- RANGE mode (From..To inclusive) on JS + WASM + WGSL -------------------
// Three chained loops: 3..7 → acc += index (Σ 25); 5..2 (EMPTY: from > to) →
// acc2 += 1 (0 contribution); -2..2 → acc2 += index*2+1 (Σ 5). Expected after
// one step: acc = 25, acc2 = 5.
console.log('== range mode (JS + WASM runtime, WGSL emit) ==');
{
  const rN = [], rEd = [];
  const rn = (t, c) => { const n = { id: nid('r'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; rN.push(n); return n; };
  const rE = (s, sp, t, tp, cat) => rEd.push({ id: nid('e'), source: s.id, target: t.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
  const rstep = rn('step', {});
  const la = rn('loop', { mode: 'range', _port_from: '3', _port_to: '7' });
  rE(rstep, 'do', la, 'do', 'flow');
  const ua = rn('updateAttribute', { attributeId: 'acc', operation: 'increment' });
  rE(la, 'index', ua, 'value', 'value');
  rE(la, 'body', ua, 'do', 'flow');
  const lb = rn('loop', { mode: 'range', _port_from: '5', _port_to: '2' });  // EMPTY
  rE(la, 'next', lb, 'do', 'flow');
  const ub = rn('updateAttribute', { attributeId: 'acc2', operation: 'increment', _port_value: '1' });
  rE(lb, 'body', ub, 'do', 'flow');
  const lc = rn('loop', { mode: 'range', _port_from: '-2', _port_to: '2' });
  rE(lb, 'next', lc, 'do', 'flow');
  const exc = rn('expression', { expression: 'a*2+1', visibleCount: 1 });
  rE(lc, 'index', exc, 'a', 'value');
  const uc = rn('updateAttribute', { attributeId: 'acc2', operation: 'increment' });
  rE(exc, 'result', uc, 'value', 'value');
  rE(lc, 'body', uc, 'do', 'flow');

  const rModel = M.migrateForHarness({
    schemaVersion: 2,
    properties: {
      name: 'Loop Range Test', description: '', topology: '2d-grid',
      boundaryTreatment: 'torus', updateMode: 'synchronous',
      gridWidth: W, gridHeight: H, dimension: '2d', gridDepth: 1,
      useWasm: false,
    },
    attributes: [
      { id: 'acc', name: 'acc', type: 'float', description: '', isModelAttribute: false, defaultValue: '0' },
      { id: 'acc2', name: 'acc2', type: 'float', description: '', isModelAttribute: false, defaultValue: '0' },
    ],
    neighborhoods: [], mappings: [], indicators: [],
    graphNodes: rN, graphEdges: rEd, macroDefs: [],
    topologyMode: { gridCells: true, agents: false },
  });
  const EXP_A = 25, EXP_B = 5;

  const rjs = M.compileGraph(rModel.graphNodes, rModel.graphEdges, rModel);
  check('range: JS compiles', !rjs.error, rjs.error ?? '');
  let jsA = null, jsB = null;
  if (!rjs.error) {
    const m = /\(\s*function\s*\(([^)]*)\)/.exec(rjs.stepCode);
    const params = m[1].split(',').map(s => s.trim()).filter(Boolean);
    const bufs = {
      total: TOTAL,
      r_acc: new Float64Array(TOTAL), w_acc: new Float64Array(TOTAL),
      r_acc2: new Float64Array(TOTAL), w_acc2: new Float64Array(TOTAL),
      modelAttrs: {}, colors: new Uint8ClampedArray(TOTAL * 4), activeViewer: '',
      _indicators: {},
      r_orientation: new Int32Array(TOTAL), w_orientation: new Int32Array(TOTAL),
      _facePatternLookup: new Int32Array(0), _lookupTables: {},
      _rngState: new Uint32Array([0x12345678]), _stopFlag: new Uint32Array(1),
      W, H, D: 1, WH: W * H, _linkedResults: {},
      glyphCodes: new Uint32Array(0), glyphColors: new Uint32Array(0),
      order: null, _skipped: new Uint8Array(0),
    };
    const missing = params.filter(p => !(p in bufs));
    check('range: JS params resolvable', missing.length === 0, missing.join(','));
    if (missing.length === 0) {
      (0, eval)(rjs.stepCode)(...params.map(p => bufs[p]));
      let badA = 0, badB = 0;
      for (let i = 0; i < TOTAL; i++) {
        if (bufs.w_acc[i] !== EXP_A) badA++;
        if (bufs.w_acc2[i] !== EXP_B) badB++;
      }
      check(`range: JS acc == ${EXP_A} (3..7 inclusive)`, badA === 0, `got ${bufs.w_acc[0]}`);
      check(`range: JS acc2 == ${EXP_B} (empty 5..2 skipped + -2..2 sum)`, badB === 0, `got ${bufs.w_acc2[0]}`);
      jsA = Float64Array.from(bufs.w_acc); jsB = Float64Array.from(bufs.w_acc2);
    }
  }

  const rLayout = M.computeLayoutFromModel(rModel);
  const rwa = M.compileGraphWasm(rModel.graphNodes, rModel.graphEdges, rModel, rLayout, M.buildViewerIds(rModel));
  check('range: WASM compiles', !rwa.error, rwa.error ?? '');
  if (!rwa.error) {
    const mem = new WebAssembly.Memory({ initial: rLayout.pages });
    const env = { mem, pow: Math.pow, exp: Math.exp, log: Math.log, sin: Math.sin, cos: Math.cos, tan: Math.tan, tanh: Math.tanh, fmod: (a, b) => a % b };
    const { instance } = await WebAssembly.instantiate(rwa.bytes, { env });
    instance.exports.step(TOTAL);
    const wA = new Float64Array(mem.buffer, rLayout.attrWriteOffset['acc'], TOTAL);
    const wB = new Float64Array(mem.buffer, rLayout.attrWriteOffset['acc2'], TOTAL);
    let badA = 0, badB = 0, diff = 0;
    for (let i = 0; i < TOTAL; i++) {
      if (wA[i] !== EXP_A) badA++;
      if (wB[i] !== EXP_B) badB++;
      if (jsA && (wA[i] !== jsA[i] || wB[i] !== jsB[i])) diff++;
    }
    check(`range: WASM acc == ${EXP_A}`, badA === 0, `got ${wA[0]}`);
    check(`range: WASM acc2 == ${EXP_B}`, badB === 0, `got ${wB[0]}`);
    check('range: JS ↔ WASM bit-identical', diff === 0, `${diff}/${TOTAL}`);
  }

  const rwg = M.compileGraphWebGPU(rModel.graphNodes, rModel.graphEdges, rModel);
  check('range: WebGPU compiles', !rwg.error, rwg.error ?? '');
  if (!rwg.error) {
    const s = rwg.shaderCode;
    check('range: WGSL has inclusive from..to loops', /for \(var _li\d+: i32 = 3; _li\d+ <= 7;/.test(s) && /= -2; _li\d+ <= 2;/.test(s), 'from/to loop headers missing');
  }

  // Overseer range: loop 2..4 → logs 2, 3, 4.
  const oN = [], oEd = [];
  const on = (t, c) => { const n = { id: nid('o'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; oN.push(n); return n; };
  const oE = (s, sp, t, tp, cat) => oEd.push({ id: nid('e'), source: s.id, target: t.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
  const root = on('experiment', {});
  const olp = on('loop', { mode: 'range', _port_from: '2', _port_to: '4' });
  oE(root, 'do', olp, 'do', 'flow');
  const olog = on('ovLog', { message: 'i={value}' });
  oE(olp, 'index', olog, 'value', 'value');
  oE(olp, 'body', olog, 'do', 'flow');
  const ores = M.compileOverseerGraph(oN, oEd, rModel);
  check('range: overseer compiles', !ores.error && !!ores.driverCode, ores.error ?? '');
  if (ores.driverCode) {
    const logged = [];
    const O = { aborted: false, log: (m2) => logged.push(m2), logT: (t2, v) => logged.push(v) };
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    await new AsyncFunction('O', ores.driverCode)(O);
    check('range: overseer logs 2,3,4', logged.length === 3 && Number(logged[0]) === 2 && Number(logged[2]) === 4, JSON.stringify(logged));
  }
}

// --- Agent WebGPU (emit-level; JS↔WASM agent runtime parity lives in
// scripts/parity-agent-wasm.mjs "[synthetic] Loop index output") ---
console.log('== Agent WebGPU (emit) ==');
{
  const aN = [], aEd = [];
  const an = (t, c) => { const n = { id: nid('a'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; aN.push(n); return n; };
  const aE = (s, sp, tt, tp, cat) => aEd.push({ id: nid('e'), source: s.id, target: tt.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
  const bs = an('behaviourStep', {});
  const alp = an('loop', { _port_count: '4' });
  aE(bs, 'do', alp, 'do', 'flow');
  const aupd = an('updateAttribute', { attributeId: 'acc', operation: 'increment' });
  aE(alp, 'index', aupd, 'value', 'value');
  aE(alp, 'body', aupd, 'do', 'flow');
  // Range-mode loop on the agent shader too (2..5 → acc += index).
  const alp2 = an('loop', { mode: 'range', _port_from: '2', _port_to: '5' });
  aE(alp, 'next', alp2, 'do', 'flow');
  const aupd2 = an('updateAttribute', { attributeId: 'acc', operation: 'increment' });
  aE(alp2, 'index', aupd2, 'value', 'value');
  aE(alp2, 'body', aupd2, 'do', 'flow');
  const agentModel = M.migrateForHarness({
    schemaVersion: 1,
    properties: { name: 'Agent Loop Index', dimension: '2d', gridWidth: 24, gridHeight: 24, gridDepth: 1, topology: '2d-grid', boundaryTreatment: 'torus', useWasm: false, useWebGPU: false },
    topologyMode: { gridCells: false, agents: true },
    centerBased: { enabled: true, maxAgents: 64, maxBonds: 0, worldWidth: 24, worldHeight: 24, seedCount: 16, seedPattern: 'scatter', defaultRadius: 0.5, growthRate: 0, repulsionStiffness: 2, adhesionStiffness: 0, interactionRange: 1.5, drag: 1, timeStep: 0.1, momentum: 0, maxSpeed: 0, neighbourQueryRadius: 8, useBondingPhysics: false, autoBond: false, agentTarget: 'webgpu', agentUpdateMode: 'sync' },
    attributes: [], modelAttributes: [], neighborhoods: [],
    agentAttributes: [{ id: 'acc', name: 'Acc', type: 'float', defaultValue: '0' }],
    variables: [], agentVariables: [], indicators: [], mappings: [],
    graphNodes: [], graphEdges: [], agentGraphNodes: aN, agentGraphEdges: aEd, macroDefs: [],
  });
  check('agent WebGPU gate accepts the loop-index graph', M.isAgentGraphWebGPUSupported(agentModel));
  const r = M.compileAgentGraphWebGPUForModel(agentModel);
  check('agent WebGPU behaviour shader compiles', !r.error && !!r.shaderCode, r.error ?? '');
  if (r.shaderCode) {
    const sh = r.shaderCode;
    const forAt = sh.search(/for \(var _lpI\d+: i32 = 0;/);
    check('agent WGSL has the loop counter', forAt >= 0);
    if (forAt >= 0) {
      const liName = /for \(var (_lpI\d+): i32/.exec(sh.slice(forAt))[1];
      check('agent WGSL body uses the counter', sh.slice(forAt).split(liName).length > 2);
    }
    check('agent WGSL has the range-mode loop (2..5 inclusive)', /for \(var _lpI\d+: i32 = i32\(2(\.0)?\); _lpI\d+ <= i32\(5(\.0)?\);/.test(sh));
  }
}

console.log(failures === 0 ? '\nALL LOOP-INDEX TESTS PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

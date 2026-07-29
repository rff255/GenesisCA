// Vector Op — Rotate (2D) + Rotate Around Axis (3D): functional verification.
//
// Both ops are EDITOR SUGAR: `expandComposites` lowers them to scalar
// arithmeticOperator / getConstant nodes BEFORE any per-target compile, so they
// run on JS / WASM / WebGPU with zero per-target emit. This asserts VALUES (not
// "it compiled") against independently computed expectations:
//
//   rotate2d      (1,0)   by 90deg   -> (0,1)                    [+ = +X toward +Y]
//   rotate2d      (3,4)   by 30deg   -> (3c-4s, 3s+4c)
//   rotate2d      z passthrough in a 3D model
//   rotateAxis    (1,0,0) about (0,0,1) by 90deg -> (0,1,0)
//   rotateAxis    v=(1,2,3), k=(1,1,0) [UNnormalised], 40deg -> Rodrigues
//   rotateAxis    zero axis -> v*cos(theta)   (documented degenerate)
//
// on JS AND on a REAL instantiated WASM module in Node, bit-identical between
// them; plus the WGSL emit is checked for the expected sin/cos structure.
//
// Run from the repo root:  node scripts/test-vector-rotate.mjs
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
const dir = mkdtempSync(join(tmpdir(), 'gca-vecrot-'));
const entryPath = join(ROOT, 'scripts', '__vecrot_entry.ts');
writeFileSync(entryPath, ENTRY);
const outPath = join(dir, 'bundle.mjs');
await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: process.cwd() });
const M = await import(pathToFileURL(outPath).href);

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ok  ${name}`);
  else { console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); failures++; }
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

const mkGraph = () => {
  const used = new Set();
  const nid = (p) => { let id; do { id = p + Math.random().toString(36).slice(2, 8); } while (used.has(id)); used.add(id); return id; };
  const nodes = [], edges = [];
  const n = (t, c = {}) => { const x = { id: nid('n'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; nodes.push(x); return x; };
  const e = (s, sp, t, tp, cat) => edges.push({ id: nid('e'), source: s.id, target: t.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
  return { nodes, edges, n, v: (s, sp, t, tp) => e(s, sp, t, tp, 'value'), f: (s, sp, t, tp) => e(s, sp, t, tp, 'flow') };
};
const cellAttr = (id) => ({ id, name: id, type: 'float', description: '', isModelAttribute: false, defaultValue: '0' });

// ── Independent expectations (computed here from first principles) ──────────
const D2R = Math.PI / 180;
function rot2d([x, y, z], deg) {
  const r = deg * D2R, c = Math.cos(r), s = Math.sin(r);
  return [x * c - y * s, x * s + y * c, z];
}
function rodrigues([x, y, z], axis, deg) {
  const len = Math.hypot(axis[0], axis[1], axis[2]);
  const k = len === 0 ? [0, 0, 0] : axis.map(v => v / len);
  const r = deg * D2R, c = Math.cos(r), s = Math.sin(r);
  const cross = [k[1] * z - k[2] * y, k[2] * x - k[0] * z, k[0] * y - k[1] * x];
  const dot = k[0] * x + k[1] * y + k[2] * z;
  const v = [x, y, z];
  return [0, 1, 2].map(i => v[i] * c + cross[i] * s + k[i] * dot * (1 - c));
}

// Sanity-check the reference implementations themselves before trusting them.
{
  const a = rot2d([1, 0, 0], 90);
  check('ref rot2d (1,0) by 90 = (0,1)', near(a[0], 0) && near(a[1], 1));
  const b = rodrigues([1, 0, 0], [0, 0, 1], 90);
  check('ref rodrigues (1,0,0) about Z by 90 = (0,1,0)', near(b[0], 0) && near(b[1], 1) && near(b[2], 0));
  // Rodrigues invariants on the non-axis-aligned case: length preserved, and the
  // component along the axis is preserved.
  const v = [1, 2, 3], ax = [1, 1, 0], out = rodrigues(v, ax, 40);
  const kn = [1 / Math.SQRT2, 1 / Math.SQRT2, 0];
  check('ref rodrigues preserves |v|', near(Math.hypot(...out), Math.hypot(...v), 1e-12));
  check('ref rodrigues preserves the axial component',
    near(out[0] * kn[0] + out[1] * kn[1] + out[2] * kn[2], v[0] * kn[0] + v[1] * kn[1] + v[2] * kn[2], 1e-12));
}

// ── Cases: one per cell. Each cell holds vx/vy/vz + kx/ky/kz + angle; the graph
//    applies ONE op (per model) and writes ox/oy/oz. ────────────────────────
const ROT2D_CASES = [
  { v: [1, 0, 0], deg: 90 },
  { v: [3, 4, 0], deg: 30 },
  { v: [0, 1, 0], deg: -45 },
  { v: [2, -5, 0], deg: 137.5 },
  { v: [1, 1, 0], deg: 0 },
  { v: [-3, 2, 0], deg: 360 },
];
const ROT3D_CASES = [
  { v: [1, 0, 0], k: [0, 0, 1], deg: 90 },
  { v: [1, 2, 3], k: [1, 1, 0], deg: 40 },   // UNnormalised axis
  { v: [0, 0, 1], k: [1, 0, 0], deg: 90 },
  { v: [1, 2, 3], k: [0, 0, 0], deg: 60 },   // degenerate: -> v*cos(60)
  { v: [-2, 5, 1], k: [2, -1, 3], deg: 200 },
  { v: [1, 1, 1], k: [1, 1, 1], deg: 123 },  // v parallel to axis -> unchanged
];

function buildModel({ op, cases, is3d, zPass }) {
  const W = cases.length, H = 1;
  const g = mkGraph();
  const step = g.n('step');
  const attrs = ['vx', 'vy', 'vz', 'kx', 'ky', 'kz', 'ang', 'ox', 'oy', 'oz'];
  const get = (id) => { const x = g.n('getCellAttribute', { attributeId: id }); return x; };
  const mv = g.n('makeVector', {});
  g.v(get('vx'), 'value', mv, 'x');
  g.v(get('vy'), 'value', mv, 'y');
  if (is3d) g.v(get('vz'), 'value', mv, 'z');
  const vop = g.n('vectorOp', { op });
  g.v(mv, 'vector', vop, 'a');
  g.v(get('ang'), 'value', vop, 'angle');
  if (op === 'rotateAxis') {
    const mk = g.n('makeVector', {});
    g.v(get('kx'), 'value', mk, 'x');
    g.v(get('ky'), 'value', mk, 'y');
    g.v(get('kz'), 'value', mk, 'z');
    g.v(mk, 'vector', vop, 'axis');
  }
  const bv = g.n('breakVector', {});
  g.v(vop, 'result', bv, 'vector');
  const setX = g.n('setAttribute', { attributeId: 'ox' });
  const setY = g.n('setAttribute', { attributeId: 'oy' });
  g.v(bv, 'x', setX, 'value');
  g.v(bv, 'y', setY, 'value');
  g.f(step, 'do', setX, 'do');
  g.f(setX, 'next', setY, 'do');
  let last = setY;
  if (is3d || zPass) {
    const setZ = g.n('setAttribute', { attributeId: 'oz' });
    g.v(bv, 'z', setZ, 'value');
    g.f(setY, 'next', setZ, 'do');
    last = setZ;
  }
  void last;
  const model = M.migrateForHarness({
    schemaVersion: 2,
    properties: {
      name: `VecRot_${op}`, description: '', topology: '2d-grid',
      boundaryTreatment: 'torus', updateMode: 'synchronous',
      gridWidth: W, gridHeight: H,
      dimension: is3d ? '3d' : '2d', gridDepth: is3d ? 2 : 1,
      useWasm: false,
    },
    attributes: attrs.map(cellAttr),
    neighborhoods: [], mappings: [], indicators: [],
    graphNodes: g.nodes, graphEdges: g.edges, macroDefs: [],
    topologyMode: { gridCells: true, agents: false },
  });
  return { model, attrs, W, H, TOTAL: W * H * (is3d ? 2 : 1), planeCells: W * H };
}

/** Run a compiled JS step over freshly-seeded buffers; returns { ox, oy, oz }. */
function runJS(stepCode, attrs, TOTAL, seed) {
  const params = /\(\s*function\s*\(([^)]*)\)/.exec(stepCode)[1].split(',').map(s => s.trim()).filter(Boolean);
  const bufs = {
    total: TOTAL, W: seed.W, H: seed.H, D: seed.D, WH: seed.W * seed.H,
    modelAttrs: {}, colors: new Uint8ClampedArray(TOTAL * 4), activeViewer: '',
    _indicators: {}, _linkedResults: {}, _rngState: new Uint32Array([0x12345678]),
    _stopFlag: new Uint32Array(1), glyphCodes: new Uint32Array(0), glyphColors: new Uint32Array(0),
    order: null, _skipped: new Uint8Array(0), _activeList: null, _activeCount: 0,
  };
  for (const id of attrs) { bufs[`r_${id}`] = new Float64Array(TOTAL); bufs[`w_${id}`] = new Float64Array(TOTAL); }
  for (const [id, vals] of Object.entries(seed.data)) bufs[`r_${id}`].set(vals);
  const missing = params.filter(p => !(p in bufs));
  if (missing.length) throw new Error(`unresolved step params: ${missing.join(', ')}`);
  (0, eval)(stepCode)(...params.map(p => bufs[p]));
  return bufs;
}

async function runCase({ title, op, cases, is3d }) {
  console.log(`\n== ${title} ==`);
  const { model, attrs, W, H, TOTAL, planeCells } = buildModel({ op, cases, is3d, zPass: false });
  const D = is3d ? 2 : 1;

  // Seed: one case per cell of layer 0 (layer 1 stays zero and is ignored).
  const data = {};
  for (const a of attrs) data[a] = new Float64Array(TOTAL);
  cases.forEach((c, i) => {
    data.vx[i] = c.v[0]; data.vy[i] = c.v[1]; data.vz[i] = c.v[2];
    if (c.k) { data.kx[i] = c.k[0]; data.ky[i] = c.k[1]; data.kz[i] = c.k[2]; }
    data.ang[i] = c.deg;
  });
  const expect = cases.map(c => (op === 'rotate2d' ? rot2d(c.v, c.deg) : rodrigues(c.v, c.k, c.deg)));

  // --- JS ---
  const js = M.compileGraph(model.graphNodes, model.graphEdges, model);
  check('JS compiles', !js.error, js.error ?? '');
  let jsOut = null;
  if (!js.error) {
    const bufs = runJS(js.stepCode, attrs, TOTAL, { W, H, D, data });
    jsOut = ['ox', 'oy', 'oz'].map(k => Float64Array.from(bufs[`w_${k}`]));
    cases.forEach((c, i) => {
      const got = [jsOut[0][i], jsOut[1][i], is3d ? jsOut[2][i] : 0];
      const exp = expect[i];
      const dims = is3d ? 3 : 2;
      const ok = [...Array(dims).keys()].every(d => near(got[d], exp[d], 1e-9));
      check(`JS  ${JSON.stringify(c.v)}${c.k ? ' about ' + JSON.stringify(c.k) : ''} by ${c.deg}deg -> [${exp.slice(0, dims).map(v => v.toFixed(6)).join(', ')}]`,
        ok, `got [${got.slice(0, dims).map(v => v.toFixed(6)).join(', ')}]`);

      // INDEPENDENT geometric invariants on the COMPILED output. The expectation
      // above shares a formula with the lowering, so it is a mirror test; these
      // are derived from what a rotation IS, not from how it is computed.
      if (op === 'rotate2d') {
        const inLen = Math.hypot(c.v[0], c.v[1]), outLen = Math.hypot(got[0], got[1]);
        check(`  invariant: |v| preserved (${inLen.toFixed(6)})`, near(inLen, outLen, 1e-9), `got ${outLen.toFixed(9)}`);
        if (inLen > 1e-9) {
          // Signed turn from in to out, normalised to (-180, 180]; must equal the
          // requested angle reduced the same way. This is what pins the SIGN
          // convention (+ = from +X toward +Y).
          const turn = Math.atan2(got[1], got[0]) - Math.atan2(c.v[1], c.v[0]);
          const norm = (r) => { let x = r; while (x <= -Math.PI) x += 2 * Math.PI; while (x > Math.PI) x -= 2 * Math.PI; return x; };
          check(`  invariant: signed turn === ${c.deg}deg`, near(norm(turn), norm(c.deg * D2R), 1e-9),
            `got ${(norm(turn) / D2R).toFixed(6)}deg`);
        }
      } else {
        const kl = Math.hypot(c.k[0], c.k[1], c.k[2]);
        if (kl > 1e-9) {
          const kn = c.k.map(v => v / kl);
          const inLen = Math.hypot(...c.v), outLen = Math.hypot(...got);
          check(`  invariant: |v| preserved (${inLen.toFixed(6)})`, near(inLen, outLen, 1e-9), `got ${outLen.toFixed(9)}`);
          const dIn = kn[0] * c.v[0] + kn[1] * c.v[1] + kn[2] * c.v[2];
          const dOut = kn[0] * got[0] + kn[1] * got[1] + kn[2] * got[2];
          check(`  invariant: axial component preserved (${dIn.toFixed(6)})`, near(dIn, dOut, 1e-9), `got ${dOut.toFixed(9)}`);
          // Angle between the perpendicular parts must equal the requested angle.
          const perp = (v) => [0, 1, 2].map(d => v[d] - kn[d] * (kn[0] * v[0] + kn[1] * v[1] + kn[2] * v[2]));
          const p0 = perp(c.v), p1 = perp(got);
          const n0 = Math.hypot(...p0), n1 = Math.hypot(...p1);
          if (n0 > 1e-9 && n1 > 1e-9) {
            const cosT = (p0[0] * p1[0] + p0[1] * p1[1] + p0[2] * p1[2]) / (n0 * n1);
            const want = Math.abs(Math.cos(c.deg * D2R));
            check(`  invariant: |cos(angle between perpendicular parts)| === |cos(${c.deg}deg)|`,
              near(Math.abs(cosT), want, 1e-9), `got ${Math.abs(cosT).toFixed(9)} want ${want.toFixed(9)}`);
          }
        } else {
          // Degenerate zero axis — documented: k̂ = 0 (÷0→0) so v' = v·cos(theta).
          const want = c.v.map(v => v * Math.cos(c.deg * D2R));
          check(`  invariant: zero axis -> v*cos(${c.deg}deg)`,
            [0, 1, 2].every(d => near(got[d], want[d], 1e-9)), `got [${got.map(v => v.toFixed(6)).join(', ')}]`);
        }
      }
    });
  }
  void planeCells;

  // --- WASM (real module) ---
  const layout = M.computeLayoutFromModel(model);
  const wa = M.compileGraphWasm(model.graphNodes, model.graphEdges, model, layout, M.buildViewerIds(model));
  check('WASM compiles', !wa.error, wa.error ?? '');
  if (!wa.error && jsOut) {
    const mem = new WebAssembly.Memory({ initial: layout.pages });
    const env = { mem, pow: Math.pow, exp: Math.exp, log: Math.log, sin: Math.sin, cos: Math.cos, tan: Math.tan, tanh: Math.tanh, fmod: (a, b) => a % b };
    const { instance } = await WebAssembly.instantiate(wa.bytes, { env });
    for (const [id, vals] of Object.entries(data)) new Float64Array(mem.buffer, layout.attrReadOffset[id], TOTAL).set(vals);
    instance.exports.step(TOTAL, -1);
    const out = ['ox', 'oy', 'oz'].map(k => new Float64Array(mem.buffer, layout.attrWriteOffset[k], TOTAL));
    let bad = 0, diff = 0;
    const dims = is3d ? 3 : 2;
    cases.forEach((c, i) => {
      for (let d = 0; d < dims; d++) {
        if (!near(out[d][i], expect[i][d], 1e-9)) bad++;
        if (out[d][i] !== jsOut[d][i]) diff++;
      }
    });
    check('WASM values match the independent expectations', bad === 0, `${bad} off`);
    check('JS <-> WASM bit-identical', diff === 0, `${diff} mismatches`);
  }

  // --- WebGPU (emit level) ---
  const wg = M.compileGraphWebGPU(model.graphNodes, model.graphEdges, model);
  check('WebGPU compiles', !wg.error, wg.error ?? '');
  if (!wg.error) {
    const s = wg.shaderCode;
    check('WGSL emits sin() and cos()', /\bsin\(/.test(s) && /\bcos\(/.test(s));
    check('WGSL carries the deg->rad factor', s.includes('0.017453292519943295'));
    if (op === 'rotateAxis') check('WGSL carries a guarded divide (axis normalise)', /select\(/.test(s) || /!= 0/.test(s) || /== 0/.test(s));
  }
  return { model, js };
}

await runCase({ title: 'Rotate 2D (2D model)', op: 'rotate2d', cases: ROT2D_CASES, is3d: false });
await runCase({ title: 'Rotate Around Axis (3D model)', op: 'rotateAxis', cases: ROT3D_CASES, is3d: true });

// ── Z pass-through: rotate2d in a 3D model must leave Z untouched ───────────
console.log('\n== Rotate 2D in a 3D model — Z pass-through ==');
{
  const cases = [
    { v: [1, 0, 7], deg: 90 },
    { v: [3, 4, -2.5], deg: 30 },
    { v: [0, 2, 0], deg: 180 },
  ];
  const { model, attrs, W, H, TOTAL } = buildModel({ op: 'rotate2d', cases, is3d: true, zPass: true });
  const data = {};
  for (const a of attrs) data[a] = new Float64Array(TOTAL);
  cases.forEach((c, i) => { data.vx[i] = c.v[0]; data.vy[i] = c.v[1]; data.vz[i] = c.v[2]; data.ang[i] = c.deg; });
  const js = M.compileGraph(model.graphNodes, model.graphEdges, model);
  check('JS compiles', !js.error, js.error ?? '');
  if (!js.error) {
    const bufs = runJS(js.stepCode, attrs, TOTAL, { W, H, D: 2, data });
    cases.forEach((c, i) => {
      const exp = rot2d(c.v, c.deg);
      check(`Z passes through: in ${c.v[2]} -> out ${c.v[2]}`, near(bufs.w_oz[i], c.v[2], 1e-12), `got ${bufs.w_oz[i]}`);
      check(`XY still rotates by ${c.deg}deg`, near(bufs.w_ox[i], exp[0], 1e-9) && near(bufs.w_oy[i], exp[1], 1e-9),
        `got (${bufs.w_ox[i]}, ${bufs.w_oy[i]})`);
    });
  }
}

// ── AGENT graph: the same ops must compile on the agent front-ends too ──────
console.log('\n== Agent graph (WASM + WebGPU gates) ==');
{
  const AGENT_ENTRY = `
export { compileAgentGraph } from '../src/modeler/vpl/compiler/compile.ts';
export { isAgentGraphWasmSupported, compileAgentGraphWasmForModel } from '../src/modeler/vpl/compiler/agentWasm/compile.ts';
export { isAgentGraphWebGPUSupported, compileAgentGraphWebGPUForModel } from '../src/modeler/vpl/compiler/agentWebgpu/compile.ts';
export { migrateForHarness } from '../src/dev/compileHarness.ts';
`;
  const aEntryPath = join(ROOT, 'scripts', '__vecrot_agent_entry.ts');
  writeFileSync(aEntryPath, AGENT_ENTRY);
  const aOut = join(dir, 'agent.mjs');
  await build({ entryPoints: [aEntryPath], bundle: true, format: 'esm', platform: 'node', outfile: aOut, logLevel: 'error', absWorkingDir: process.cwd() });
  const A = await import(pathToFileURL(aOut).href);
  rmSync(aEntryPath, { force: true });

  for (const op of ['rotate2d', 'rotateAxis']) {
    const g = mkGraph();
    const bs = g.n('behaviourStep', {});
    const mv = g.n('makeVector', {});
    g.v(bs, 'myX', mv, 'x');
    g.v(bs, 'myY', mv, 'y');
    g.v(bs, 'myZ', mv, 'z');
    const vop = g.n('vectorOp', { op, _port_angle: '35' });
    g.v(mv, 'vector', vop, 'a');
    if (op === 'rotateAxis') {
      const mk = g.n('makeVector', {});
      g.v(bs, 'myRadius', mk, 'z');
      g.v(mk, 'vector', vop, 'axis');
    }
    const bv = g.n('breakVector', {});
    g.v(vop, 'result', bv, 'vector');
    const af = g.n('applyForce', {});
    g.v(bv, 'x', af, 'fx');
    g.v(bv, 'y', af, 'fy');
    g.v(bv, 'z', af, 'fz');
    g.f(bs, 'do', af, 'do');
    const model = A.migrateForHarness({
      schemaVersion: 1,
      properties: { name: `AgentRot_${op}`, dimension: '3d', gridWidth: 32, gridHeight: 32, gridDepth: 16, topology: '2d-grid', boundaryTreatment: 'torus', useWasm: false, useWebGPU: false },
      topologyMode: { gridCells: false, agents: true },
      centerBased: { enabled: true, maxAgents: 64, maxBonds: 0, worldWidth: 32, worldHeight: 32, worldDepth: 16, seedCount: 16, seedPattern: 'scatter', defaultRadius: 0.5, growthRate: 0, repulsionStiffness: 0, adhesionStiffness: 0, interactionRange: 1.5, drag: 1, timeStep: 0.1, momentum: 0.5, maxSpeed: 0, neighbourQueryRadius: 8, useBondingPhysics: false, autoBond: false, agentTarget: 'wasm', agentUpdateMode: 'async' },
      attributes: [], modelAttributes: [], neighborhoods: [],
      agentAttributes: [], variables: [], agentVariables: [], indicators: [], mappings: [],
      graphNodes: [], graphEdges: [], agentGraphNodes: g.nodes, agentGraphEdges: g.edges, macroDefs: [],
    });
    const jsA = A.compileAgentGraph(model.agentGraphNodes, model.agentGraphEdges, model);
    check(`agent JS compiles (${op})`, !jsA.error, jsA.error ?? '');
    check(`agent WASM gate accepts (${op})`, A.isAgentGraphWasmSupported(model) === true);
    const wa = A.compileAgentGraphWasmForModel(model);
    check(`agent WASM module builds (${op})`, !!wa && !wa.error && wa.bytes?.length > 0, wa?.error ?? '');
    check(`agent WebGPU gate accepts (${op})`, A.isAgentGraphWebGPUSupported(model) === true);
    const wg = A.compileAgentGraphWebGPUForModel(model);
    const src = wg?.shaderCode ?? '';
    check(`agent WGSL builds + has sin/cos (${op})`, !!wg && !wg.error && /\bsin\(/.test(src) && /\bcos\(/.test(src), wg?.error ?? '');
  }
}

rmSync(entryPath, { force: true });
rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);

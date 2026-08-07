// LOGIC check for Sense Hemifield (the L/R Braitenberg reduction). Parity proves
// JS≡WASM; this proves the JS emit is CORRECT — it runs the REAL compiled JS agent
// behaviour over hand-placed agents and checks the (Left, Right) counts against BOTH
// a hand-verified expectation AND an independent plain-JS re-implementation of the
// documented split. Covers 2D omni, 2D cone-gated, and the 3D up-reference swap.
//
// It also checks the two id ARRAYS (Left Agents / Right Agents) by MEMBERSHIP, not
// merely by size: each side's For Each sums `2^id` into a BITMASK, which for a
// hand-placed population identifies the exact set. The arrays must partition
// EXACTLY the set the counts count (`length === count`, masks disjoint, their union
// = every in-view neighbour), and an unwired array port must emit nothing at all.
//
//   Run from the repo root:  node scripts/test-hemifield-logic.mjs
import { build } from 'esbuild';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = `
export { createAgentStore, computeAgentMaxHashBins, buildSpatialHash, seedAgents } from '../src/simulator/engine/agentEngine.ts';
export { compileAgentGraph } from '../src/modeler/vpl/compiler/compile.ts';
export { buildAgentAbiArgs } from '../src/modeler/vpl/compiler/agentAbi.ts';
export { migrateForHarness } from '../src/dev/compileHarness.ts';
export { agentAttrsOf, cellFieldAttrsOf } from '../src/model/attributeScope.ts';
export { resolveAgentFieldGates } from '../src/model/agentFieldGating.ts';
`;
const dir = mkdtempSync(join(tmpdir(), 'gca-hemi-'));
const entryPath = join(ROOT, 'scripts', '__hemi_entry.ts');
writeFileSync(entryPath, ENTRY);
const outPath = join(dir, 'bundle.mjs');
await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: process.cwd() });
const m = await import(pathToFileURL(outPath).href);
const { createAgentStore, computeAgentMaxHashBins, buildSpatialHash, seedAgents, compileAgentGraph, buildAgentAbiArgs, migrateForHarness, agentAttrsOf, cellFieldAttrsOf, resolveAgentFieldGates } = m;
rmSync(entryPath, { force: true });

const W = 24, H = 24;
function makeModel({ is3d, D, halfAngle, hx, hy, hz, arrays }) {
  const nid = (p) => p + Math.random().toString(36).slice(2, 8);
  const aN = [], aEd = [];
  const an = (t, c) => { const n = { id: nid('a'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; aN.push(n); return n; };
  const aE = (s, sp, tt, tp, cat) => aEd.push({ id: nid('e'), source: s.id, target: tt.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
  const bs = an('behaviourStep', {});
  const cfg = { halfAngle: String(halfAngle), headingSource: 'wired', _port_radius: '6', _port_headingX: String(hx), _port_headingY: String(hy) };
  if (is3d) cfg._port_headingZ = String(hz ?? 0);
  const sh = an('senseHemifield', cfg);
  const setL = an('setAttribute', { attributeId: 'countL' });
  const setR = an('setAttribute', { attributeId: 'countR' });
  aE(bs, 'do', setL, 'do', 'flow'); aE(setL, 'next', setR, 'do', 'flow');
  aE(sh, 'leftCount', setL, 'value', 'value'); aE(sh, 'rightCount', setR, 'value', 'value');
  let last = setR;
  if (arrays) {
    // Per side: For Each over the id array, acc += 2^id  → a MEMBERSHIP bitmask.
    for (const [side, port, maskAttr, lenAttr, accVar] of [
      ['L', 'leftAgents', 'maskL', 'lenL', 'accL'],
      ['R', 'rightAgents', 'maskR', 'lenR', 'accR'],
    ]) {
      const zero = an('setVariable', { variableId: accVar, _port_value: '0' });
      const fe = an('forEachInArray', {});
      aE(sh, port, fe, 'array', 'value');
      const gv = an('getVariable', { variableId: accVar });
      const ex = an('expression', { expression: 'a + pow(2, b)', visibleCount: 2 });
      aE(gv, 'value', ex, 'a', 'value');
      aE(fe, 'element', ex, 'b', 'value');
      const add = an('setVariable', { variableId: accVar });
      aE(ex, 'result', add, 'value', 'value');
      aE(fe, 'body', add, 'do', 'flow');
      const gv2 = an('getVariable', { variableId: accVar });
      const setMask = an('setAttribute', { attributeId: maskAttr });
      aE(gv2, 'value', setMask, 'value', 'value');
      const al = an('arrayLength', {});
      aE(sh, port, al, 'array', 'value');
      const setLen = an('setAttribute', { attributeId: lenAttr });
      aE(al, 'length', setLen, 'value', 'value');
      aE(last, 'next', zero, 'do', 'flow');
      aE(zero, 'next', fe, 'do', 'flow');
      aE(fe, 'next', setMask, 'do', 'flow');
      aE(setMask, 'next', setLen, 'do', 'flow');
      last = setLen;
      void side;
    }
  }
  return {
    schemaVersion: 1,
    properties: { name: 'Hemi', dimension: is3d ? '3d' : '2d', gridWidth: W, gridHeight: H, gridDepth: is3d ? D : 1, topology: is3d ? '3d-grid' : '2d-grid', boundaryTreatment: 'torus', useWasm: false, useWebGPU: false },
    topologyMode: { gridCells: false, agents: true },
    centerBased: { enabled: true, maxAgents: 100, maxBonds: 0, worldWidth: W, worldHeight: H, worldDepth: is3d ? D : 1, seedCount: 0, defaultRadius: 0.5, growthRate: 0, timeStep: 0.1, momentum: 0, maxSpeed: 0, neighbourQueryRadius: 12, interactionRange: 1.5, useBondingPhysics: false, autoBond: false, agentTarget: 'js', agentUpdateMode: 'async',
      agentCapabilities: { motion: 'force', body: true, collision: 'off', bonds: 'off', autoBond: false, growth: false, division: false, lifespan: false, populationBirth: false, populationDeath: false, sensing: true, orientation: false, fieldCoupling: false, appearance: true } },
    attributes: [], modelAttributes: [], neighborhoods: [],
    agentAttributes: [
      { id: 'countL', name: 'CountL', type: 'integer', defaultValue: '0' },
      { id: 'countR', name: 'CountR', type: 'integer', defaultValue: '0' },
      { id: 'maskL', name: 'MaskL', type: 'float', defaultValue: '0' },
      { id: 'maskR', name: 'MaskR', type: 'float', defaultValue: '0' },
      { id: 'lenL', name: 'LenL', type: 'integer', defaultValue: '0' },
      { id: 'lenR', name: 'LenR', type: 'integer', defaultValue: '0' },
    ],
    variables: [],
    agentVariables: [
      { id: 'accL', name: 'AccL', kind: 'scalar', dataType: 'float', initialValue: '0' },
      { id: 'accR', name: 'AccR', kind: 'scalar', dataType: 'float', initialValue: '0' },
    ],
    indicators: [], mappings: [],
    graphNodes: [], graphEdges: [], agentGraphNodes: aN, agentGraphEdges: aEd, macroDefs: [],
  };
}

function foldT(d, span) { const h = span / 2; if (d > h) return d - span; if (d < -h) return d + span; return d; }

// Independent plain-JS re-implementation of the documented split (agent 0 = centre).
function expectLR({ is3d, D, halfAngle, hx, hy, hz, pts }) {
  const cosHalf = Math.cos((Math.min(180, Math.max(0, halfAngle)) * Math.PI) / 180);
  const omni = halfAngle >= 180;
  const hm2 = hx * hx + hy * hy + (is3d ? hz * hz : 0);
  const hm = Math.sqrt(hm2);
  const upY = is3d ? hz * hz > 0.81 * hm2 : false;
  const [cx, cy, cz] = pts[0];
  let left = 0, right = 0, maskL = 0, maskR = 0;
  const r2 = 36;
  for (let j = 1; j < pts.length; j++) {
    let dx = foldT(pts[j][0] - cx, W), dy = foldT(pts[j][1] - cy, H);
    let dz = is3d ? foldT(pts[j][2] - cz, D) : 0;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > r2) continue;
    let inView;
    if (omni || hm2 === 0) inView = true;
    else { const dot = hx * dx + hy * dy + (is3d ? hz * dz : 0); inView = dot >= cosHalf * hm * Math.sqrt(d2); }
    if (!inView) continue;
    const cross = is3d ? (upY ? (hz * dx - hx * dz) : (hx * dy - hy * dx)) : (hx * dy - hy * dx);
    if (cross >= 0) { left++; maskL += 2 ** j; } else { right++; maskR += 2 ** j; }
  }
  return { left, right, maskL, maskR };
}

function buildArgs(s, hash) {
  // The ABI shape MUST carry every optional block the compiler's param list is
  // built from (C9's gates, the bond attrs, the generation slot) — a missing one
  // shifts every later arg and the behaviour reads garbage (the documented
  // AgentAbiShape mirror rule). `usesGeneration: true` always, like the worker.
  const shape = {
    is3d: s.worldDepth > 1, agentAttrs: s.attrSpecs, fieldAttrs: [], hasLookupTables: false,
    bondAttrs: s.bondAttrSpecs, usesGeneration: true, gates: s.fieldGates,
  };
  const rt = {
    hash, emptyI32: new Int32Array(0), modelAttrs: {}, viewer: '', indicators: new Float64Array(0),
    rngState: new Uint32Array(1), stopFlag: new Uint32Array(1), glyphCodes: new Uint32Array(1), glyphColors: new Uint32Array(1),
    lookupTables: {}, width: W, height: H, total: W * H * (s.worldDepth || 1), torus: true, fieldArray: () => new Float64Array(0),
  };
  return buildAgentAbiArgs('loop', shape, s, rt);
}

let pass = 0, fail = 0;
function runCase(name, spec, expectHand) {
  const model = migrateForHarness(makeModel(spec));
  const jsR = compileAgentGraph(model.agentGraphNodes, model.agentGraphEdges, model, 0);
  if (jsR.error || !jsR.behaviourCode) { console.log(`FAIL ${name}: JS compile ${jsR.error}`); fail++; return; }
  // eslint-disable-next-line no-eval
  const jsFn = eval(jsR.behaviourCode);
  const cfg = model.centerBased;
  const specs = agentAttrsOf(model).map(a => ({ id: a.id, type: a.type, defaultValue: 0 }));
  // C9: the store MUST carry the model's field gates, or its ABI shape declares
  // groups the compiler's param list omits and every later arg shifts.
  const s = createAgentStore(cfg, specs, { wasmBacked: false, syncAttrs: false, fieldGates: resolveAgentFieldGates(model) });
  s.worldWidth = W; s.worldHeight = H; s.worldDepth = spec.is3d ? spec.D : 1;
  const seedSpecs = spec.pts.map(([x, y, z]) => (spec.is3d ? { x, y, z, radius: 0.5 } : { x, y, radius: 0.5 }));
  seedAgents(s, seedSpecs, 0.5);
  s.forceX.fill(0); s.forceY.fill(0); s.forceZ.fill(0);
  const D = spec.is3d ? spec.D : 1;
  const binEdge = 12;
  const hash = buildSpatialHash(s, binEdge, W, H, D, true, computeAgentMaxHashBins(W, H, D, 1.5, 0.5, 12));
  jsFn(...buildArgs(s, hash));
  const gotL = s.attrRead['countL'][0], gotR = s.attrRead['countR'][0];   // centre = agent 0
  const exp = expectLR(spec);
  const okReimpl = gotL === exp.left && gotR === exp.right;
  const okHand = !expectHand || (gotL === expectHand.left && gotR === expectHand.right);
  let arrMsg = '', okArr = true;
  if (spec.arrays) {
    const mL = s.attrRead['maskL'][0], mR = s.attrRead['maskR'][0];
    const lL = s.attrRead['lenL'][0], lR = s.attrRead['lenR'][0];
    // MEMBERSHIP (the exact id sets), then length===count, then disjointness.
    okArr = mL === exp.maskL && mR === exp.maskR && lL === gotL && lR === gotR && (mL & mR) === 0;
    arrMsg = ` maskL=${mL}/${exp.maskL} maskR=${mR}/${exp.maskR} len=${lL},${lR}`;
  }
  if (okReimpl && okHand && okArr) { console.log(`PASS ${name}: L=${gotL} R=${gotR}${arrMsg}`); pass++; }
  else { console.log(`FAIL ${name}: got L=${gotL} R=${gotR}${arrMsg}; reimpl L=${exp.left} R=${exp.right}${expectHand ? `; hand L=${expectHand.left} R=${expectHand.right}` : ''}`); fail++; }
}

/** The emitted JS for a counts-only node must contain NO array machinery at all
 *  (the "an unconsumed port costs nothing" rule — what keeps every shipped model
 *  byte-identical). */
function runEmitCase(name, spec, wantArrays) {
  const model = migrateForHarness(makeModel(spec));
  const r = compileAgentGraph(model.agentGraphNodes, model.agentGraphEdges, model, 0);
  if (r.error || !r.behaviourCode) { console.log(`FAIL ${name}: compile ${r.error}`); fail++; return; }
  const hasL = /_leftAgents=\[\]/.test(r.behaviourCode);
  const hasR = /_rightAgents=\[\]/.test(r.behaviourCode);
  const hasPush = /_(left|right)Agents\.push\(/.test(r.behaviourCode);
  const ok = wantArrays ? (hasL && hasR && hasPush) : (!hasL && !hasR && !hasPush);
  if (ok) { console.log(`PASS ${name}`); pass++; }
  else { console.log(`FAIL ${name}: arrays L=${hasL} R=${hasR} push=${hasPush}, wanted ${wantArrays}`); fail++; }
}

// centre agent at (12,12); heading +x (1,0). cross = hx·dy − hy·dx = dy (y-down frame).
//   below (+y) ⇒ cross>0 ⇒ LEFT ; above (−y) ⇒ RIGHT ; ahead/behind (dy=0) ⇒ LEFT.
runCase('2D omni, heading +x', { is3d: false, halfAngle: 180, hx: 1, hy: 0,
  pts: [[12, 12], [12, 15], [15, 12], [12, 9], [9, 12]] }, { left: 3, right: 1 });
// same, but a 60° cone: only the forward (+x) half is in view. ahead (15,12) dot>0 IN;
// above/below (dot=0, cosHalf=0.5, needs dot≥0.5·hm·d>0) OUT; behind (dot<0) OUT.
runCase('2D cone 60, heading +x', { is3d: false, halfAngle: 60, hx: 1, hy: 0,
  pts: [[12, 12], [12, 15], [15, 12], [12, 9], [9, 12]] }, { left: 1, right: 0 });
// heading +y (0,1): cross = hx·dy − hy·dx = −dx. right(+x) ⇒ cross<0 ⇒ RIGHT; left(−x) ⇒ LEFT.
runCase('2D omni, heading +y', { is3d: false, halfAngle: 180, hx: 0, hy: 1,
  pts: [[12, 12], [15, 12], [9, 12], [12, 15], [12, 9]] }, { left: 3, right: 1 });
// 3D, near-VERTICAL heading (0,0,1) ⇒ up-swap to +Y ⇒ cross = hz·dx − hx·dz = dx.
//   +x neighbour ⇒ cross>0 ⇒ LEFT ; −x ⇒ RIGHT ; ±y (dx=0) ⇒ LEFT.
runCase('3D omni, heading +z (up-swap)', { is3d: true, D: 24, halfAngle: 180, hx: 0, hy: 0, hz: 1,
  pts: [[12, 12, 12], [15, 12, 12], [9, 12, 12], [12, 15, 12], [12, 9, 12]] }, { left: 3, right: 1 });
// 3D, HORIZONTAL heading (1,0,0) ⇒ +Z up ⇒ cross = hx·dy − hy·dx = dy (same as 2D).
runCase('3D omni, heading +x (no swap)', { is3d: true, D: 24, halfAngle: 180, hx: 1, hy: 0, hz: 0,
  pts: [[12, 12, 12], [12, 15, 12], [12, 9, 12], [15, 12, 12], [9, 12, 12]] }, { left: 3, right: 1 });

// --- the id ARRAYS: same geometry, now also asserting membership + lengths ---
runCase('2D omni + ARRAYS, heading +x', { is3d: false, halfAngle: 180, hx: 1, hy: 0, arrays: true,
  pts: [[12, 12], [12, 15], [15, 12], [12, 9], [9, 12]] }, { left: 3, right: 1 });
runCase('2D cone 60 + ARRAYS, heading +x', { is3d: false, halfAngle: 60, hx: 1, hy: 0, arrays: true,
  pts: [[12, 12], [12, 15], [15, 12], [12, 9], [9, 12]] }, { left: 1, right: 0 });
runCase('2D omni + ARRAYS, heading +y', { is3d: false, halfAngle: 180, hx: 0, hy: 1, arrays: true,
  pts: [[12, 12], [15, 12], [9, 12], [12, 15], [12, 9]] }, { left: 3, right: 1 });
runCase('3D omni + ARRAYS, heading +z (up-swap)', { is3d: true, D: 24, halfAngle: 180, hx: 0, hy: 0, hz: 1, arrays: true,
  pts: [[12, 12, 12], [15, 12, 12], [9, 12, 12], [12, 15, 12], [12, 9, 12]] }, { left: 3, right: 1 });
// The cost rule: an unconsumed array port emits NOTHING.
runEmitCase('counts-only emits no array machinery', { is3d: false, halfAngle: 90, hx: 1, hy: 0,
  pts: [[12, 12], [12, 15]] }, false);
runEmitCase('wired arrays emit the arrays', { is3d: false, halfAngle: 90, hx: 1, hy: 0, arrays: true,
  pts: [[12, 12], [12, 15]] }, true);

rmSync(dir, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'ALL HEMIFIELD LOGIC CHECKS ✓' : `${fail} FAILED`}  (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);

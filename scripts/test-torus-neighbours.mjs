// TORUS SEAM regression test for the agent NEIGHBOUR QUERY (Get Nearby Agents /
// Get Agents In View) and the spatial-hash stencil they share.
//
// THE CLAIM UNDER TEST: on a torus world the neighbour set is the TORUS-SHORTEST
// one — two agents either side of the seam are neighbours — and every target
// agrees. Two independent failure modes produce a seam artifact and NOTHING else:
//   (a) the 3x3(x3) hash-bin stencil does not WRAP its bin index, so the bins
//       across the seam are never visited;
//   (b) the candidate distance test does not FOLD the delta to the shortest way
//       round, so a partner 1 unit away across the seam measures W-1 away.
// Both are invisible in the middle of the world, which is exactly why they need
// a dedicated test rather than being left to the sample models.
//
// THE FIXTURES ARE BUILT SO THE HASH IS GENUINELY USED (>= 3 bins per axis, and
// a bin edge WIDER than the query radius). With a small world `buildSpatialHash`
// returns null, every target falls back to all-pairs — which folds — and the bug
// hides completely. Tier B asserts the geometry that makes the test non-vacuous.
//
// Tier C is the strong one: ~400 agents scattered over the whole torus (so many
// land within a query radius of a seam), each target's reported neighbour COUNT
// compared against an INDEPENDENT brute-force O(N^2) torus recount written here
// from first principles. A NEGATIVE CONTROL recounts WITHOUT the fold and asserts
// it DISAGREES — proving the fixture really does contain cross-seam pairs, so a
// passing test is evidence and not a tautology.
//
// Run:  node scripts/test-torus-neighbours.mjs
import { build } from 'esbuild';
import { writeFileSync, rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = `
export { createAgentStore, computeAgentMaxHashBins, buildSpatialHash, seedAgents } from '../src/simulator/engine/agentEngine.ts';
export { compileAgentGraphWasmForModel, instantiateAgentWasm, buildAgentLayoutExtras } from '../src/modeler/vpl/compiler/agentWasm/compile.ts';
export { compileAgentGraphWebGPUForModel, isAgentGraphWebGPUSupported } from '../src/modeler/vpl/compiler/agentWebgpu/compile.ts';
export { compileAgentGraph } from '../src/modeler/vpl/compiler/compile.ts';
export { buildAgentAbiArgs } from '../src/modeler/vpl/compiler/agentAbi.ts';
export { migrateForHarness } from '../src/dev/compileHarness.ts';
export { agentAttrsOf, cellFieldAttrsOf } from '../src/model/attributeScope.ts';
`;
const dir = mkdtempSync(join(tmpdir(), 'gca-torus-'));
const entryPath = join(ROOT, 'scripts', '__torus_entry.ts');
writeFileSync(entryPath, ENTRY);
const outPath = join(dir, 'bundle.mjs');
await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: process.cwd() });
const m = await import(pathToFileURL(outPath).href);
const {
  createAgentStore, computeAgentMaxHashBins, buildSpatialHash, seedAgents,
  compileAgentGraphWasmForModel, instantiateAgentWasm, buildAgentLayoutExtras,
  compileAgentGraphWebGPUForModel, isAgentGraphWebGPUSupported,
  compileAgentGraph, buildAgentAbiArgs, migrateForHarness, agentAttrsOf, cellFieldAttrsOf,
} = m;

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log(`  FAIL: ${msg}`); } };

/** A deterministic uniform stream, so a failure is always reproducible. */
function rng(seed) { let s = seed >>> 0; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

// ---------------------------------------------------------------------------
// The model. `queryRadius` is an INLINE value on the node; `neighbourQueryRadius`
// is set >= it so the hash bins are wide enough for the stencil to be complete
// (the documented sizing rule — a query radius above it under-counts by design).
// ---------------------------------------------------------------------------
function buildModel({ W, H, D = 1, is3d = false, torus = true, radius = 2, nqr = 6, nodeType = 'getNearbyAgents', extraCfg = {} }) {
  const used = new Set();
  const nid = (p) => { let id; do { id = p + Math.random().toString(36).slice(2, 8); } while (used.has(id)); used.add(id); return id; };
  const aN = [], aEd = [];
  const an = (t, c) => { const n = { id: nid('a'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; aN.push(n); return n; };
  const aE = (s, sp, tt, tp, cat) => aEd.push({ id: nid('e'), source: s.id, target: tt.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
  const bs = an('behaviourStep', {});
  const q = an(nodeType, { _port_radius: String(radius), ...extraCfg });
  const al = an('arrayLength', {});
  const sa = an('setAttribute', { attributeId: 'count' });
  aE(bs, 'do', sa, 'do', 'flow');
  aE(q, 'agents', al, 'array', 'value');
  aE(al, 'length', sa, 'value', 'value');
  return {
    schemaVersion: 1,
    properties: {
      name: 'Torus Seam Test', dimension: is3d ? '3d' : '2d',
      gridWidth: W, gridHeight: H, gridDepth: D, topology: '2d-grid',
      boundaryTreatment: torus ? 'torus' : 'constant', useWasm: false, useWebGPU: false,
    },
    topologyMode: { gridCells: false, agents: true },
    centerBased: {
      enabled: true, maxAgents: 1000, maxBonds: 0, worldWidth: W, worldHeight: H,
      seedCount: 0, seedPattern: 'none', defaultRadius: 0.5, growthRate: 0,
      repulsionStiffness: 0, adhesionStiffness: 0, interactionRange: 1.5,
      drag: 1, timeStep: 0.1, momentum: 0, maxSpeed: 0, neighbourQueryRadius: nqr,
      useBondingPhysics: false, autoBond: false, agentTarget: 'wasm', agentUpdateMode: 'async',
      agentCapabilities: { motion: 'static', body: true, collision: 'off', bonds: 'off', autoBond: false, growth: false, division: false, lifespan: false, populationBirth: false, populationDeath: false, sensing: true, sensingHeadingSource: 'velocity', orientation: false, fieldCoupling: false, appearance: true },
    },
    attributes: [], modelAttributes: [], neighborhoods: [],
    agentAttributes: [{ id: 'count', name: 'Count', type: 'integer', defaultValue: '0' }],
    variables: [], agentVariables: [], indicators: [], mappings: [],
    graphNodes: [], graphEdges: [], agentGraphNodes: aN, agentGraphEdges: aEd, macroDefs: [],
  };
}

/** Compile both CPU targets, seed the given positions, run ONE behaviour step on
 *  each, and return the per-agent neighbour counts + the hash geometry + the WGSL. */
async function run(opts, positions) {
  const raw = buildModel(opts);
  const model = migrateForHarness(raw);
  const cfg = model.centerBased;
  const { W, H, D = 1, torus = true, nqr = 6 } = opts;
  const agentAttrs = agentAttrsOf(model);
  const specs = agentAttrs.map(a => ({ id: a.id, type: a.type, defaultValue: 0 }));
  const fieldSpecs = cellFieldAttrsOf(model);
  const total = W * H * D;

  const wasmR = compileAgentGraphWasmForModel(model);
  if (wasmR.error || !wasmR.bytes?.length) throw new Error(`WASM compile: ${wasmR.error}`);
  const jsR = compileAgentGraph(model.agentGraphNodes, model.agentGraphEdges, model, 0);
  if (jsR.error || !jsR.behaviourCode) throw new Error(`JS compile: ${jsR.error}`);
  // eslint-disable-next-line no-eval
  const jsFn = eval(jsR.behaviourCode);

  const layoutExtras = { ...buildAgentLayoutExtras(model), fieldTotal: total, syncAttrs: false };
  const A = createAgentStore(cfg, specs, { wasmBacked: false, fieldGates: layoutExtras.fieldGates });
  const B = createAgentStore(cfg, specs, { wasmBacked: true, maxHashBins: wasmR.layout.maxHashBins, layoutExtras, fieldGates: layoutExtras.fieldGates });
  for (const s of [A, B]) { s.worldWidth = W; s.worldHeight = H; s.worldDepth = D; }
  const seedSpecs = positions.map(p => (D > 1 ? { x: p.x, y: p.y, z: p.z, radius: 0.5 } : { x: p.x, y: p.y, radius: 0.5 }));
  seedAgents(A, seedSpecs, 0.5); seedAgents(B, seedSpecs, 0.5);

  // The bin edge the WORKER computes (max of the soft-sphere cutoff and the
  // model's Neighbour Query Radius) — reproduced here, not invented.
  const binEdge = Math.max(1e-3, 1.5 * 2 * 0.5, nqr);
  const reserve = computeAgentMaxHashBins(W, H, D, 1.5, 0.5, nqr);
  const hash = buildSpatialHash(A, binEdge, W, H, D, torus, reserve);

  const shape = { is3d: D > 1, agentAttrs: A.attrSpecs, fieldAttrs: fieldSpecs, hasLookupTables: false, bondAttrs: A.bondAttrSpecs, usesGeneration: true, gates: A.fieldGates };
  const rngState = new Uint32Array(1); rngState[0] = 12345;
  const rt = {
    hash, emptyI32: new Int32Array(0), modelAttrs: {}, viewer: '',
    indicators: new Float64Array(0), rngState, stopFlag: new Uint32Array(1),
    glyphCodes: new Uint32Array(1), glyphColors: new Uint32Array(1), lookupTables: {},
    width: W, height: H, total, torus, fieldArray: () => undefined, generation: 0,
  };
  jsFn(...buildAgentAbiArgs('loop', shape, A, rt));

  // WASM: copy the hash into the reserved views (the worker's own procedure),
  // seed the RNG cell, then call `behaviour` with the same hash dims + origin.
  const inst = await instantiateAgentWasm(wasmR.bytes, B.memory);
  const L = B.layout, buf = B.memory.buffer;
  const nBins = hash ? hash.nBinsX * hash.nBinsY * hash.nBinsZ : 0;
  if (hash) {
    new Int32Array(buf, L.hashBinStartOffset, nBins + 1).set(hash.binStart.subarray(0, nBins + 1));
    const used = hash.binStart[nBins];
    if (used > 0) new Int32Array(buf, L.hashBinAgentsOffset, used).set(hash.binAgents.subarray(0, used));
  }
  new Uint32Array(buf, L.rngStateOffset, 1)[0] = 12345;
  inst.behaviour(
    B.highWater, hash ? 1 : 0,
    hash ? hash.nBinsX : 0, hash ? hash.nBinsY : 0, hash ? hash.nBinsZ : 0,
    hash ? hash.binSizeX : 1, hash ? hash.binSizeY : 1, hash ? hash.binSizeZ : 1,
    W, H, D, torus ? 1 : 0,
    hash ? hash.originX : 0, hash ? hash.originY : 0, hash ? hash.originZ : 0, 0,
  );

  const gpuR = compileAgentGraphWebGPUForModel(model);
  return {
    hash,
    js: Array.from({ length: A.highWater }, (_, i) => A.attrRead.count[i]),
    wasm: Array.from({ length: B.highWater }, (_, i) => B.attrRead.count[i]),
    wgsl: gpuR?.error ? null : gpuR?.shaderCode,
    wgslError: gpuR?.error,
    gpuSupported: isAgentGraphWebGPUSupported(model),
  };
}

/** THE INDEPENDENT ORACLE — a brute-force O(N^2) recount written from first
 *  principles here, deliberately NOT sharing a line with the emitters under test.
 *  `fold` false is the NEGATIVE CONTROL (the answer a seam-blind implementation
 *  would give). */
function recount(positions, { W, H, D = 1, radius, torus, fold = true }) {
  const n = positions.length, out = new Array(n).fill(0);
  const hW = W / 2, hH = H / 2, hD = D / 2;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      let dx = positions[j].x - positions[i].x;
      let dy = positions[j].y - positions[i].y;
      let dz = D > 1 ? (positions[j].z - positions[i].z) : 0;
      if (torus && fold) {
        if (dx > hW) dx -= W; else if (dx < -hW) dx += W;
        if (dy > hH) dy -= H; else if (dy < -hH) dy += H;
        if (D > 1) { if (dz > hD) dz -= D; else if (dz < -hD) dz += D; }
      }
      if (dx * dx + dy * dy + dz * dz <= radius * radius) out[i]++;
    }
  }
  return out;
}

const diffCount = (a, b) => a.reduce((n, v, i) => n + (v === b[i] ? 0 : 1), 0);

console.log('=== TORUS SEAM — agent neighbour query (Get Nearby Agents) ===\n');

// ---------------------------------------------------------------------------
// TIER A — the hand-placed seam pairs. Every expectation is obvious by eye, so a
// failure names the exact geometry that broke (x seam / y seam / the corner).
// ---------------------------------------------------------------------------
{
  const W = 24, H = 24, radius = 2, nqr = 6;
  const SEED = [
    { x: 0.5, y: 12, expect: 1, what: 'x-seam left' },
    { x: 23.5, y: 12, expect: 1, what: 'x-seam right' },
    { x: 6, y: 0.5, expect: 1, what: 'y-seam bottom' },
    { x: 6, y: 23.5, expect: 1, what: 'y-seam top' },
    { x: 0.5, y: 0.5, expect: 1, what: 'corner a (BOTH seams at once)' },
    { x: 23.5, y: 23.5, expect: 1, what: 'corner b' },
    { x: 12, y: 4, expect: 1, what: 'interior control a' },
    { x: 13, y: 4, expect: 1, what: 'interior control b' },
    { x: 12, y: 18, expect: 0, what: 'isolated (the test can say no)' },
  ];
  for (const [nodeType, extraCfg, label] of [
    ['getNearbyAgents', {}, 'Get Nearby Agents'],
    ['getAgentsInView', { halfAngle: '180' }, 'Get Agents In View (omni)'],
  ]) {
    console.log(`--- Tier A: ${label} ---`);
    const r = await run({ W, H, radius, nqr, nodeType, extraCfg }, SEED);
    const h = r.hash;
    // TIER B (inline) — the geometry that makes the whole file non-vacuous.
    ok(!!h, `${label}: the spatial hash IS built (else all-pairs hides the bug)`);
    if (h) {
      console.log(`  hash: ${h.nBinsX}x${h.nBinsY} bins of ${h.binSizeX}x${h.binSizeY}, origin (${h.originX},${h.originY})`);
      ok(h.nBinsX >= 3 && h.nBinsY >= 3, `${label}: >= 3 bins per axis (a real 3x3 stencil)`);
      ok(h.binSizeX > radius && h.binSizeY > radius,
        `${label}: bin edge (${h.binSizeX}) exceeds the query radius (${radius}) — ONLY a wrapped stencil can cross the seam`);
    }
    for (let i = 0; i < SEED.length; i++) {
      ok(r.js[i] === SEED[i].expect, `${label} JS: agent ${i} (${SEED[i].what}) = ${r.js[i]}, expected ${SEED[i].expect}`);
      ok(r.wasm[i] === SEED[i].expect, `${label} WASM: agent ${i} (${SEED[i].what}) = ${r.wasm[i]}, expected ${SEED[i].expect}`);
    }
    console.log(`  JS   [${r.js.join(', ')}]`);
    console.log(`  WASM [${r.wasm.join(', ')}]`);
    ok(r.js.join() === r.wasm.join(), `${label}: JS and WASM agree element-for-element`);
    ok(r.gpuSupported, `${label}: the WebGPU agent gate accepts the model`);
    ok(!r.wgslError && !!r.wgsl, `${label}: the WGSL compiles (${r.wgslError ?? 'ok'})`);
    if (r.wgsl) {
      for (const ax of ['X', 'Y']) {
        ok(new RegExp(`% i32\\(control\\.nBins${ax}\\)\\) \\+ i32\\(control\\.nBins${ax}\\)\\) % i32\\(control\\.nBins${ax}\\)`).test(r.wgsl),
          `${label}: the WGSL stencil WRAPS the ${ax.toLowerCase()} bin index on a torus`);
      }
      ok(/control\.fieldTorus != 0u/.test(r.wgsl), `${label}: the WGSL folds the candidate delta on a torus`);
    }
    console.log('');
  }
}

// ---------------------------------------------------------------------------
// TIER C — the strong statement. A whole population scattered over the torus,
// every agent's count compared against the independent oracle, with a NEGATIVE
// CONTROL proving the fixture genuinely contains cross-seam pairs.
// ---------------------------------------------------------------------------
for (const dims of [
  { W: 60, H: 40, D: 1, is3d: false, radius: 3, nqr: 8, n: 400, label: '2D 60x40' },
  { W: 40, H: 40, D: 30, is3d: true, radius: 3, nqr: 8, n: 400, label: '3D 40x40x30' },
]) {
  const { W, H, D, is3d, radius, nqr, n, label } = dims;
  console.log(`--- Tier C: population recount, ${label} ---`);
  const rnd = rng(0xC0FFEE);
  const positions = Array.from({ length: n }, () => (
    is3d ? { x: rnd() * W, y: rnd() * H, z: rnd() * D } : { x: rnd() * W, y: rnd() * H }
  ));
  const r = await run({ W, H, D, is3d, radius, nqr }, positions);
  ok(!!r.hash, `${label}: the hash IS built`);
  if (r.hash) {
    const h = r.hash;
    console.log(`  hash: ${h.nBinsX}x${h.nBinsY}x${h.nBinsZ} bins of ${h.binSizeX.toFixed(2)}`);
    ok(h.binSizeX > radius, `${label}: bin edge (${h.binSizeX.toFixed(2)}) > query radius (${radius})`);
  }
  const truth = recount(positions, { W, H, D, radius, torus: true, fold: true });
  const seamBlind = recount(positions, { W, H, D, radius, torus: true, fold: false });
  const nBlind = diffCount(truth, seamBlind);
  ok(nBlind > 0, `${label}: the fixture CONTAINS cross-seam pairs (a seam-blind recount differs on ${nBlind} agents) — the test is not vacuous`);
  console.log(`  ${nBlind} of ${n} agents have at least one cross-seam neighbour`);
  const dJs = diffCount(truth, r.js), dWasm = diffCount(truth, r.wasm);
  ok(dJs === 0, `${label} JS: ${dJs} of ${n} agents disagree with the independent torus recount`);
  ok(dWasm === 0, `${label} WASM: ${dWasm} of ${n} agents disagree with the independent torus recount`);
  ok(diffCount(r.js, r.wasm) === 0, `${label}: JS and WASM agree element-for-element`);
  // The oracle must ALSO be able to fail — pin it against the seam-blind answer.
  ok(diffCount(r.js, seamBlind) === nBlind, `${label}: the target's answer differs from the seam-blind one on exactly the cross-seam agents`);
  console.log('');
}

// ---------------------------------------------------------------------------
// TIER D — the BOUNDED control. With a constant boundary the seam is NOT a
// wrap-around, so the very same fixture must give the seam-BLIND answer. This is
// what proves the torus branch is a real branch and not a fold applied always.
// ---------------------------------------------------------------------------
{
  const W = 60, H = 40, radius = 3, nqr = 8, n = 400;
  console.log('--- Tier D: bounded (constant boundary) control ---');
  const rnd = rng(0xC0FFEE);
  const positions = Array.from({ length: n }, () => ({ x: rnd() * W, y: rnd() * H }));
  const r = await run({ W, H, radius, nqr, torus: false }, positions);
  const bounded = recount(positions, { W, H, radius, torus: false });
  ok(diffCount(bounded, r.js) === 0, `bounded JS: ${diffCount(bounded, r.js)} agents disagree with the non-wrapping recount`);
  ok(diffCount(bounded, r.wasm) === 0, `bounded WASM: ${diffCount(bounded, r.wasm)} agents disagree with the non-wrapping recount`);
  const torusTruth = recount(positions, { W, H, radius, torus: true });
  ok(diffCount(bounded, torusTruth) > 0, 'the bounded and torus answers genuinely differ (the control discriminates)');
  console.log('');
}

rmSync(entryPath, { force: true });
rmSync(dir, { recursive: true, force: true });
console.log(`${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} checks passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

// AGENT ENGINE END-TO-END PHASE PROFILER — where does each millisecond of a
// generation go? Runs the REAL shipped `Particle Life.gcaproj` (override with
// MODEL=<name>) at several agent counts, on BOTH the JS and WASM agent targets,
// timing every per-generation phase separately:
//
//   reset      force-accumulator fills (per gen)
//   hash       maxR scan + buildSpatialHash (per gen)
//   hashCopy   hash → WASM memory copy-in (per gen, WASM only)
//   args       buildAgentAbiArgs loop-arg assembly (per gen, JS only)
//   behaviour  the compiled behaviour fn (per gen) — the per-pair rule work
//   force      the force integrator (per gen) — incl. the unconditional
//              density neighbour scan (runs even with engine physics OFF)
//   swap       xNext/yNext position commit (per gen)
//   snapshot   snapshotAgentsForRender (per FRAME, not per gen)
//   clone      structuredClone of the snapshot — an UPPER BOUND for the
//              postMessage ship (the real path transfers the buffers)
//
// This is the measurement tool the perf review is based on — rerun it after any
// engine change to see which phase moved. Run from the repo root:
//   node scripts/bench-agent-engine.mjs
//   MODEL="Particle Life 3D" node scripts/bench-agent-engine.mjs
import { build } from 'esbuild';
import { writeFileSync, rmSync, mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = `
export { createAgentStore, computeAgentMaxHashBins, buildSpatialHash, seedAgents, snapshotAgentsForRender } from '../src/simulator/engine/agentEngine.ts';
export { compileAgentGraphWasmForModel, instantiateAgentWasm, buildAgentLayoutExtras } from '../src/modeler/vpl/compiler/agentWasm/compile.ts';
export { compileAgentGraph } from '../src/modeler/vpl/compiler/compile.ts';
export { buildAgentAbiArgs } from '../src/modeler/vpl/compiler/agentAbi.ts';
export { migrateForHarness } from '../src/dev/compileHarness.ts';
export { agentAttrsOf, cellFieldAttrsOf } from '../src/model/attributeScope.ts';
export { resolveKeyLabels, normalizeLookupTable } from '../src/modeler/vpl/compiler/variegation.ts';
export { usesSoftCollision, usesEngineSprings, usesEngineGrowth, resolveMaxBonds } from '../src/model/centerBased.ts';
`;
const dir = mkdtempSync(join(tmpdir(), 'gca-benche-'));
const entryPath = join(ROOT, 'scripts', '__benche_entry.ts');
writeFileSync(entryPath, ENTRY);
const outPath = join(dir, 'bundle.mjs');
await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: process.cwd() });
const m = await import(pathToFileURL(outPath).href);
const {
  createAgentStore, computeAgentMaxHashBins, buildSpatialHash, seedAgents, snapshotAgentsForRender,
  compileAgentGraphWasmForModel, instantiateAgentWasm, buildAgentLayoutExtras,
  compileAgentGraph, buildAgentAbiArgs, migrateForHarness, agentAttrsOf, cellFieldAttrsOf,
  resolveKeyLabels, normalizeLookupTable, usesSoftCollision, usesEngineSprings, usesEngineGrowth,
} = m;

const cbNum = (cfg, k, d) => { const v = cfg?.[k]; return typeof v === 'number' && Number.isFinite(v) ? v : d; };

const MODEL_NAME = process.env.MODEL || 'Particle Life';
const rawModel = JSON.parse(readFileSync(join(ROOT, 'public', 'models', `${MODEL_NAME}.gcaproj`), 'utf8'));

// Scenarios: the shipped model's density is preserved by scaling the world with N
// (the "user grows the world as they add particles" case), plus one fixed-world
// row reproducing the reported 50k-struggles case (density blows up ⇒ pair count
// per agent blows up — the physics is O(N · density · r²), not O(N)).
const shipped = rawModel.properties;
const shippedDensity = 1800 / ((shipped.gridWidth || 320) * (shipped.gridHeight || 200));
const side = n => Math.round(Math.sqrt(n / shippedDensity));
const SCENARIOS = [
  { N: 2000, W: side(2000), H: side(2000), note: 'shipped density' },
  { N: 10000, W: side(10000), H: side(10000), note: 'shipped density' },
  { N: 50000, W: side(50000), H: side(50000), note: 'shipped density' },
  { N: 50000, W: 600, H: 600, note: 'the reported case — 5× density' },
];

// ---- verbatim JS 2D force loop (copied from sim.worker.ts runAgentStep, the
// current bbox-origin + doForce/springs-gated form) ----
function jsForceLoop(s, hash, o) {
  const hw = s.highWater, x = s.x, y = s.y, rad = s.radius, alive = s.alive;
  const xN = s.xNext, yN = s.yNext, vxArr = s.vx, vyArr = s.vy;
  const W = o.W, H = o.H, halfW = W / 2, halfH = H / 2;
  const range = o.range, muRep = o.muR, muAdh = o.muA, doForce = o.doForce, torus = o.torus;
  const momentum = o.momentum, maxSpeed = o.maxSpeed, growthRate = o.growthRate;
  const springs = o.springs, maxBonds = s.maxBonds, dtOverEta = o.dtOverEta;
  for (let i = 0; i < hw; i++) {
    if (!alive[i]) { xN[i] = x[i]; yN[i] = y[i]; continue; }
    const xi = x[i], yi = y[i], ri = rad[i];
    let fx = s.forceX[i], fy = s.forceY[i], dens = 0;
    if (hash) {
      const nBinsX = hash.nBinsX, nBinsY = hash.nBinsY;
      const binStart = hash.binStart, binAgents = hash.binAgents;
      let bx = ((xi - hash.originX) / hash.binSizeX) | 0; if (bx < 0) bx = 0; else if (bx >= nBinsX) bx = nBinsX - 1;
      let by = ((yi - hash.originY) / hash.binSizeY) | 0; if (by < 0) by = 0; else if (by >= nBinsY) by = nBinsY - 1;
      for (let ddy = -1; ddy <= 1; ddy++) {
        for (let ddx = -1; ddx <= 1; ddx++) {
          let nbx = bx + ddx, nby = by + ddy;
          if (torus) { nbx = ((nbx % nBinsX) + nBinsX) % nBinsX; nby = ((nby % nBinsY) + nBinsY) % nBinsY; }
          else if (nbx < 0 || nbx >= nBinsX || nby < 0 || nby >= nBinsY) continue;
          const b = nby * nBinsX + nbx, end = binStart[b + 1];
          for (let p = binStart[b]; p < end; p++) {
            const j = binAgents[p];
            if (j === i) continue;
            let dx = x[j] - xi, dy = y[j] - yi;
            if (torus) { if (dx > halfW) dx -= W; else if (dx < -halfW) dx += W; if (dy > halfH) dy -= H; else if (dy < -halfH) dy += H; }
            const d2 = dx * dx + dy * dy;
            const sij = ri + rad[j];
            const rmax = range * sij;
            if (d2 === 0 || d2 >= rmax * rmax) continue;
            dens++;
            if (doForce) { const d = Math.sqrt(d2); const F = ((d < sij) ? muRep : muAdh) * (d - sij); const k = F / d; fx += k * dx; fy += k * dy; }
          }
        }
      }
    }
    s.density[i] = dens;
    const bc = s.bondCount[i];
    if (springs && bc > 0) {
      const base = i * maxBonds;
      for (let bk = 0; bk < bc; bk++) {
        const p = s.bondPartner[base + bk];
        if (p < 0 || p >= hw || !alive[p]) continue;
        if (s.bondPartnerEpoch[base + bk] !== s.epoch[p]) continue;
        let dx = x[p] - xi, dy = y[p] - yi;
        if (torus) { if (dx > halfW) dx -= W; else if (dx < -halfW) dx += W; if (dy > halfH) dy -= H; else if (dy < -halfH) dy += H; }
        const d2b = dx * dx + dy * dy;
        if (d2b === 0) continue;
        const d = Math.sqrt(d2b);
        const F = s.bondStiffness[base + bk] * (d - s.bondRestLength[base + bk]);
        const k = F / d;
        fx += k * dx; fy += k * dy;
      }
    }
    let vxi = momentum * vxArr[i] + dtOverEta * fx;
    let vyi = momentum * vyArr[i] + dtOverEta * fy;
    if (maxSpeed > 0) { const sp = Math.sqrt(vxi * vxi + vyi * vyi); if (sp > maxSpeed) { const sc = maxSpeed / sp; vxi *= sc; vyi *= sc; } }
    vxArr[i] = vxi; vyArr[i] = vyi;
    let nx = xi + vxi, ny = yi + vyi;
    if (torus) { nx = ((nx % W) + W) % W; ny = ((ny % H) + H) % H; }
    else { nx = nx < 0 ? 0 : nx > W ? W : nx; ny = ny < 0 ? 0 : ny > H ? H : ny; }
    xN[i] = nx; yN[i] = ny;
    s.age[i] = s.age[i] + 1;
    const tr = s.targetRadius[i], cur = s.radius[i];
    if (tr !== cur) { const dd = tr - cur; s.radius[i] = Math.abs(dd) <= growthRate ? tr : cur + Math.sign(dd) * growthRate; }
  }
}

function fmt(msPerStep) { return msPerStep >= 100 ? msPerStep.toFixed(0) : msPerStep >= 10 ? msPerStep.toFixed(1) : msPerStep.toFixed(2); }

for (const sc of SCENARIOS) {
  const model = migrateForHarness(JSON.parse(JSON.stringify(rawModel)));
  model.properties.gridWidth = sc.W; model.properties.gridHeight = sc.H;
  model.centerBased.maxAgents = sc.N + 16;
  const cfg = model.centerBased;
  const is3d = model.properties.dimension === '3d' && (model.properties.gridDepth ?? 1) > 1;
  const W = sc.W, H = sc.H, D = is3d ? (model.properties.gridDepth || 1) : 1;
  const torus = model.properties.boundaryTreatment === 'torus';
  const agentAttrs = agentAttrsOf(model);
  const fieldSpecs = cellFieldAttrsOf(model);
  const specs = agentAttrs.map(a => ({ id: a.id, type: a.type, defaultValue: 0 }));

  // Compile both targets (from the dims-overridden model — the same thing the
  // app now does after the resize fix).
  const wasmR = compileAgentGraphWasmForModel(model);
  if (wasmR.error) { console.log(`SKIP N=${sc.N}: WASM compile: ${wasmR.error}`); continue; }
  const jsR = compileAgentGraph(model.agentGraphNodes ?? [], model.agentGraphEdges ?? [], model, 0);
  if (jsR.error || !jsR.behaviourCode) { console.log(`SKIP N=${sc.N}: JS compile: ${jsR.error}`); continue; }
  // eslint-disable-next-line no-eval
  const jsFn = eval(jsR.behaviourCode);

  // External caches (model attr defaults, lookup tables) — mirrors the worker.
  const cachedModelAttrs = {};
  for (const a of model.attributes) {
    if (!a.isModelAttribute) continue;
    if (a.type === 'color') { cachedModelAttrs[a.id + '_r'] = 10; cachedModelAttrs[a.id + '_g'] = 20; cachedModelAttrs[a.id + '_b'] = 30; }
    else if (a.type !== 'lookupTable') { const v = parseFloat(String(a.defaultValue ?? '0')); cachedModelAttrs[a.id] = Number.isFinite(v) ? v : 0; }
  }
  const cachedInteractionTables = {};
  let hasLookupTables = false;
  for (const a of model.attributes) {
    if (a.isModelAttribute && a.type === 'lookupTable') {
      hasLookupTables = true;
      cachedInteractionTables[a.id] = normalizeLookupTable(a.tableValues, resolveKeyLabels(a.rowKeySource, model), resolveKeyLabels(a.colKeySource, model));
    }
  }
  const cachedIndicators = new Float64Array((model.indicators ?? []).length);
  const readAttrs = {};
  for (const spec of fieldSpecs) readAttrs[spec.id] = new Float64Array(W * H * D);

  // Stores: A = plain JS, B = wasmBacked. Scatter-seed identically (LCG).
  const syncAttrs = cfg?.agentUpdateMode === 'sync';
  const layoutExtras = { ...buildAgentLayoutExtras(model), fieldTotal: W * H * D, syncAttrs };
  const A = createAgentStore(cfg, specs, { wasmBacked: false, syncAttrs });
  const B = createAgentStore(cfg, specs, { wasmBacked: true, syncAttrs, maxHashBins: wasmR.layout.maxHashBins, layoutExtras });
  for (const s of [A, B]) { s.worldWidth = W; s.worldHeight = H; s.worldDepth = D; s.dt = cbNum(cfg, 'timeStep', 1); }
  let seed = 20260722; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const seedSpecs = [];
  const r0 = cbNum(cfg, 'defaultRadius', 0.5);
  for (let i = 0; i < sc.N; i++) seedSpecs.push(is3d ? { x: rnd() * W, y: rnd() * H, z: rnd() * D, radius: r0 } : { x: rnd() * W, y: rnd() * H, radius: r0 });
  seedAgents(A, seedSpecs, r0); seedAgents(B, seedSpecs, r0);
  // deterministic per-agent attr values (species etc.)
  for (const s of [A, B]) for (const spec of agentAttrs) {
    const nOpts = spec.type === 'tag' ? Math.max(1, (spec.tagOptions ?? []).length) : 5;
    const arr = s.attrRead[spec.id];
    for (let i = 0; i < s.highWater; i++) arr[i] = i % nOpts;
    if (s.attrWrite[spec.id] !== arr) s.attrWrite[spec.id].set(arr);
  }

  // WASM setup: instantiate + one-time external-region copy-in (the worker
  // re-copies model attrs/tables each step — sub-µs for scalar attrs, measured
  // separately as negligible; the HASH copy is the per-step one that matters).
  const inst = await instantiateAgentWasm(wasmR.bytes, B.memory);
  const Bbuf = B.memory.buffer, BL = B.layout;
  for (const key of Object.keys(BL.modelAttrOffset)) new Float64Array(Bbuf, BL.modelAttrOffset[key], 1)[0] = typeof cachedModelAttrs[key] === 'number' ? cachedModelAttrs[key] : 0;
  for (const id of Object.keys(BL.lookupTableOffset)) { const t = cachedInteractionTables[id]; if (t) new Float64Array(Bbuf, BL.lookupTableOffset[id], t.length).set(t); }

  // Resolved force-pass config (the worker's runAgentStep resolution).
  const doForce = usesSoftCollision(cfg);
  const springs = usesEngineSprings(cfg);
  const growthRate = usesEngineGrowth(cfg) ? cbNum(cfg, 'growthRate', 0) : 0;
  const fOpts = {
    W, H, torus, range: cbNum(cfg, 'interactionRange', 1.5), muR: cbNum(cfg, 'repulsionStiffness', 2), muA: cbNum(cfg, 'adhesionStiffness', 0),
    momentum: cbNum(cfg, 'momentum', 0), maxSpeed: cbNum(cfg, 'maxSpeed', 0), growthRate,
    doForce, springs, dtOverEta: cbNum(cfg, 'timeStep', 1) / Math.max(1e-6, cbNum(cfg, 'drag', 1)),
  };
  const reserve = computeAgentMaxHashBins(W, H, D, cbNum(cfg, 'interactionRange', 1.5), cbNum(cfg, 'defaultRadius', 0.5), cbNum(cfg, 'neighbourQueryRadius', 5));
  const rngState = new Uint32Array(1); rngState[0] = 0x12345678;
  const ctx = { cachedModelAttrs, cachedInteractionTables, cachedIndicators, readAttrs, fieldSpecs, width: W, height: H, total: W * H * D, torus, hasLookupTables, activeViewer: '', rngState, stopFlag: new Uint32Array(1), GLYPH_NOOP_CODES: new Uint32Array(1), GLYPH_NOOP_COLORS: new Uint32Array(1) };
  const buildArgs = (s, hash) => buildAgentAbiArgs('loop', { is3d, agentAttrs: s.attrSpecs, fieldAttrs: fieldSpecs, hasLookupTables }, s, {
    hash, emptyI32: new Int32Array(0), modelAttrs: cachedModelAttrs, viewer: '', indicators: cachedIndicators,
    rngState, stopFlag: ctx.stopFlag, glyphCodes: ctx.GLYPH_NOOP_CODES, glyphColors: ctx.GLYPH_NOOP_COLORS,
    lookupTables: cachedInteractionTables, width: W, height: H, total: W * H * D, torus, fieldArray: (id) => readAttrs[id],
  });

  const phase = (t, name, fn) => { const t0 = performance.now(); const out = fn(); t[name] = (t[name] || 0) + (performance.now() - t0); return out; };
  const stepJS = (t) => {
    phase(t, 'reset', () => { A.forceX.fill(0, 0, A.highWater); A.forceY.fill(0, 0, A.highWater); A.forceZ.fill(0, 0, A.highWater); });
    const hash = phase(t, 'hash', () => {
      let maxR = r0; for (let i = 0; i < A.highWater; i++) if (A.alive[i] && A.radius[i] > maxR) maxR = A.radius[i];
      const binEdge = Math.max(1e-3, fOpts.range * 2 * maxR, cbNum(cfg, 'neighbourQueryRadius', 5));
      return buildSpatialHash(A, binEdge, W, H, D, torus, reserve);
    });
    const args = phase(t, 'args', () => buildArgs(A, hash));
    phase(t, 'behaviour', () => jsFn(...args));
    phase(t, 'force', () => jsForceLoop(A, hash, fOpts));
    phase(t, 'swap', () => { A.x.set(A.xNext); A.y.set(A.yNext); });
    return hash;
  };
  const stepWASM = (t) => {
    phase(t, 'reset', () => { B.forceX.fill(0, 0, B.highWater); B.forceY.fill(0, 0, B.highWater); B.forceZ.fill(0, 0, B.highWater); });
    const hash = phase(t, 'hash', () => {
      let maxR = r0; for (let i = 0; i < B.highWater; i++) if (B.alive[i] && B.radius[i] > maxR) maxR = B.radius[i];
      const binEdge = Math.max(1e-3, fOpts.range * 2 * maxR, cbNum(cfg, 'neighbourQueryRadius', 5));
      return buildSpatialHash(B, binEdge, W, H, D, torus, reserve);
    });
    let hv = 0, nbx = 0, nby = 0, nbz = 0, bsx = 1, bsy = 1, bsz = 1, ox = 0, oy = 0, oz = 0;
    phase(t, 'hashCopy', () => {
      if (!hash) return;
      hv = 1; nbx = hash.nBinsX; nby = hash.nBinsY; nbz = hash.nBinsZ; bsx = hash.binSizeX; bsy = hash.binSizeY; bsz = hash.binSizeZ; ox = hash.originX; oy = hash.originY; oz = hash.originZ;
      const nBins = nbx * nby * nbz;
      new Int32Array(Bbuf, BL.hashBinStartOffset, nBins + 1).set(hash.binStart.subarray(0, nBins + 1));
      const used = hash.binStart[nBins];
      if (used > 0) new Int32Array(Bbuf, BL.hashBinAgentsOffset, used).set(hash.binAgents.subarray(0, used));
      new Uint32Array(Bbuf, BL.rngStateOffset, 1)[0] = rngState[0];
    });
    phase(t, 'behaviour', () => inst.behaviour(B.highWater, hv, nbx, nby, nbz, bsx, bsy, bsz, W, H, D, torus ? 1 : 0, ox, oy, oz));
    phase(t, 'force', () => {
      if (inst.forcePass) inst.forcePass(B.highWater, hv, nbx, nby, nbz, bsx, bsy, bsz, fOpts.dtOverEta, fOpts.muR, fOpts.muA, fOpts.range, fOpts.momentum, fOpts.maxSpeed, fOpts.growthRate, W, H, D, 0, torus ? 1 : 0, ox, oy, oz, fOpts.doForce ? 1 : 0, fOpts.springs ? 1 : 0);
      else jsForceLoop(B, hash, fOpts);
    });
    phase(t, 'swap', () => { B.x.set(B.xNext); B.y.set(B.yNext); });
  };

  // Warmup + timed runs (wall-clock budget so the dense 50k row stays bounded).
  const BUDGET_MS = 15000, MIN_STEPS = 5, MAX_STEPS = sc.N <= 2000 ? 200 : sc.N <= 10000 ? 60 : 15;
  for (let i = 0; i < 3; i++) { stepJS({}); stepWASM({}); }
  const run = (stepFn) => {
    const t = {}; let steps = 0; const t0 = performance.now();
    while (steps < MAX_STEPS && (steps < MIN_STEPS || performance.now() - t0 < BUDGET_MS)) { stepFn(t); steps++; }
    for (const k of Object.keys(t)) t[k] /= steps;
    t.TOTAL = Object.keys(t).filter(k => k !== 'TOTAL').reduce((a, k) => a + t[k], 0);
    return { t, steps };
  };
  const js = run(stepJS);
  const wa = run(stepWASM);

  // Per-frame costs: snapshot + structured clone (upper bound on the ship).
  let tSnap = 0, tClone = 0, snapBytes = 0;
  for (let i = 0; i < 10; i++) {
    let t0 = performance.now(); const snap = snapshotAgentsForRender(A, false); tSnap += performance.now() - t0;
    t0 = performance.now(); structuredClone(snap); tClone += performance.now() - t0;
    if (i === 0) snapBytes = Object.values(snap).reduce((a, v) => a + (v?.buffer ? v.byteLength : 0), 0);
  }
  tSnap /= 10; tClone /= 10;

  // Context: mean live density (neighbour count within the ENGINE cutoff) + the
  // behaviour-radius neighbour estimate (what the per-pair rule actually visits).
  let densSum = 0; for (let i = 0; i < A.highWater; i++) if (A.alive[i]) densSum += A.density[i];
  const qr = cachedModelAttrs['queryRadius'] ?? cbNum(cfg, 'neighbourQueryRadius', 5);
  const estNbrs = (sc.N / (W * H * D)) * (is3d ? (4 / 3) * Math.PI * qr ** 3 : Math.PI * qr * qr);

  console.log(`\n=== ${MODEL_NAME}  N=${sc.N}  world ${W}x${H}${D > 1 ? 'x' + D : ''}  (${sc.note})  hashReserve=${reserve}`);
  console.log(`    est. behaviour neighbours/agent ~${estNbrs.toFixed(0)}  engine-cutoff density ~${(densSum / Math.max(1, A.highWater)).toFixed(2)}`);
  console.log(`    phase ms/step      JS        WASM`);
  for (const k of ['reset', 'hash', 'hashCopy', 'args', 'behaviour', 'force', 'swap', 'TOTAL']) {
    const a = js.t[k], b = wa.t[k];
    console.log(`    ${k.padEnd(12)} ${a != null ? fmt(a).padStart(9) : '        —'} ${b != null ? fmt(b).padStart(9) : '        —'}`);
  }
  console.log(`    steps/s          ${(1000 / js.t.TOTAL).toFixed(1).padStart(9)} ${(1000 / wa.t.TOTAL).toFixed(1).padStart(9)}   (JS ${js.steps} steps, WASM ${wa.steps} steps timed)`);
  console.log(`    per-frame: snapshot ${fmt(tSnap)} ms + clone ${fmt(tClone)} ms  (${(snapBytes / sc.N).toFixed(0)} B/agent, ${(snapBytes / 1024 / 1024).toFixed(2)} MB)`);
}
rmSync(entryPath, { force: true }); rmSync(dir, { recursive: true, force: true });

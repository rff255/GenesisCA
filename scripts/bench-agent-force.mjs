// DEV-only scale benchmark — the agent FORCE INTEGRATOR (the hot per-step agent
// code) on JS vs WASM, at 2k / 10k / 50k / 100k agents (the PR7 headline number).
//
// It is intentionally the force-pass-only benchmark (the W1 methodology): the
// neighbour pass (soft-sphere + density) + velocity Euler + position wrap, reading
// the same wasmBacked AgentStore the WASM module reads. It does NOT measure the
// graph behaviour fn (cheap for boids) or the structural phase (CPU on every
// target) — those are constant across JS/WASM/WebGPU. The hash is CPU-built (as in
// the real engine) and EXCLUDED from the timed region (same on every target).
//
// WebGPU is NOT measured here: its per-step cost is dominated by the whole-SoA
// upload + readback (the hash is CPU-built, so the GPU buffers must be re-synced
// every step) — a fixed per-step overhead that, below ~10k agents, exceeds the
// JS/WASM force loop entirely. That crossover is the documented finding; measuring
// it needs the wired runtime (deferred). This file gives the JS-vs-WASM half.
//
// Run from the repo root:  node scripts/bench-agent-force.mjs
// (it esbuild-bundles the TS engine + the WASM agent compiler to a temp ESM, DOM-
//  free — the W1 harness pattern.)

import { build } from 'esbuild';
import { writeFileSync, rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

// Anchor the engine imports at the repo root (this script lives in scripts/).
// Write the entry file INSIDE scripts/ so the relative '../src/...' specifiers
// resolve against the repo, not a temp dir; bundle out to a temp dir.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = `
export { createAgentStore, computeAgentMemoryLayout, computeAgentMaxHashBins, buildSpatialHash, seedAgents } from '../src/simulator/engine/agentEngine.ts';
export { compileAgentGraphWasm, instantiateAgentWasm } from '../src/modeler/vpl/compiler/agentWasm/compile.ts';
`;

const dir = mkdtempSync(join(tmpdir(), 'gca-bench-'));
const entryPath = join(ROOT, 'scripts', '__bench_entry.ts');
writeFileSync(entryPath, ENTRY);
const outPath = join(dir, 'bundle.mjs');
await build({
  entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node',
  outfile: outPath, logLevel: 'error',
  // resolve the relative '../src/...' imports against the repo root.
  absWorkingDir: process.cwd(),
});
const mod = await import(pathToFileURL(outPath).href);
const {
  createAgentStore, seedAgents, buildSpatialHash,
  compileAgentGraphWasm, instantiateAgentWasm, computeAgentMaxHashBins,
} = mod;

// ---- the model + config (Boids-like: torus, momentum 0.9, customForces) ----
const COUNTS = [2000, 10000, 50000, 100000];
const W = 800, H = 800; // a world large enough to keep ~uniform density at 100k
const cfg = {
  enabled: true, maxAgents: 0 /*set per count*/, maxBonds: 4,
  worldWidth: W, worldHeight: H, worldDepth: 1,
  repulsionStiffness: 2.0, adhesionStiffness: 0.0, interactionRange: 1.5,
  drag: 1.0, timeStep: 0.1, momentum: 0.9, maxSpeed: 2.0,
  neighbourQueryRadius: 5.0, defaultRadius: 0.5, growthRate: 0.0,
  useBondingPhysics: false, // customForces (boids) — soft-sphere OFF, like the sample
};

// A minimal agent graph: behaviourStep -> applyForce of a tiny constant jitter, so
// the WASM module exports `behaviour` + `forcePass`. The force pass is what we time;
// behaviour is a no-op-ish constant (boids' real behaviour is the neighbour
// accumulators, which add ~constant per-agent work to BOTH targets equally — the
// force loop is the JS-vs-WASM differentiator).
const nb = (id, nodeType, config = {}) => ({ id, type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType, config } });
const fe = (s, sh, t, th) => ({ id: s + '->' + t, source: s, sourceHandle: sh, target: t, targetHandle: th });
const agentGraphNodes = [
  nb('beh', 'behaviourStep'),
  nb('af', 'applyForce', { _port_fx: '0.01', _port_fy: '0.0' }),
];
const agentGraphEdges = [ fe('beh', 'output_flow_do', 'af', 'input_flow_do') ];
const model = {
  properties: { gridWidth: W, gridHeight: H, dimension: '2d', gridDepth: 1, boundaryTreatment: 'torus' },
  topologyMode: { gridCells: true, agents: true },
  centerBased: cfg, agentGraphNodes, agentGraphEdges, agentVariables: [],
  graphNodes: [], graphEdges: [], macroDefs: [], variables: [], attributes: [], neighborhoods: [],
};

// The FULL current 26-param ABI (mirrors FORCE_PASS_PARAMS in agentWasm/compile.ts).
// doCollision=0 (customForces bench) + doDensity=1 so the neighbour/density scan
// — the thing this bench times — actually runs (the older 20-arg call left the
// trailing params 0 and silently measured a skipped scan after the ABI grew).
const FORCE_PASS_PARAMS_ORDER = (s, hash, dtOverEta, bonding, torus) => ([
  s.highWater, hash ? 1 : 0, hash ? hash.nBinsX : 0, hash ? hash.nBinsY : 0, 0,
  hash ? hash.binSizeX : 1, hash ? hash.binSizeY : 1, 1,
  dtOverEta, cfg.repulsionStiffness, cfg.adhesionStiffness, cfg.interactionRange,
  cfg.momentum, cfg.maxSpeed, 0 /*growthRate*/,
  W, H, 1, bonding ? 1 : 0, torus ? 1 : 0,
  hash ? hash.originX ?? 0 : 0, hash ? hash.originY ?? 0 : 0, 0,
  0 /*doCollision*/, 0 /*doSprings*/, 1 /*doDensity*/,
]);

// ---- verbatim JS 2D force loop (copied from sim.worker.ts runAgentStep) ----
function jsForceLoop(s, hash, dtOverEta) {
  const hw = s.highWater, x = s.x, y = s.y, rad = s.radius, alive = s.alive;
  const xN = s.xNext, yN = s.yNext, vxArr = s.vx, vyArr = s.vy;
  const W2 = s.worldWidth, H2 = s.worldHeight, halfW = W2 / 2, halfH = H2 / 2;
  const range = cfg.interactionRange, muR = cfg.repulsionStiffness, muA = cfg.adhesionStiffness;
  const momentum = cfg.momentum, maxSpeed = cfg.maxSpeed, engineForces = false, torus = true;
  for (let i = 0; i < hw; i++) {
    if (!alive[i]) { xN[i] = x[i]; yN[i] = y[i]; continue; }
    const xi = x[i], yi = y[i], ri = rad[i];
    let fx = s.forceX[i], fy = s.forceY[i], dens = 0;
    if (hash) {
      const nBinsX = hash.nBinsX, nBinsY = hash.nBinsY, binStart = hash.binStart, binAgents = hash.binAgents;
      let bx = (xi / hash.binSizeX) | 0; if (bx < 0) bx = 0; else if (bx >= nBinsX) bx = nBinsX - 1;
      let by = (yi / hash.binSizeY) | 0; if (by < 0) by = 0; else if (by >= nBinsY) by = nBinsY - 1;
      for (let ddy = -1; ddy <= 1; ddy++) {
        for (let ddx = -1; ddx <= 1; ddx++) {
          let nbx = bx + ddx, nby = by + ddy;
          if (torus) { nbx = ((nbx % nBinsX) + nBinsX) % nBinsX; nby = ((nby % nBinsY) + nBinsY) % nBinsY; }
          else { if (nbx < 0 || nbx >= nBinsX || nby < 0 || nby >= nBinsY) continue; }
          const b = nby * nBinsX + nbx, end = binStart[b + 1];
          for (let p = binStart[b]; p < end; p++) {
            const j = binAgents[p];
            if (j === i) continue;
            let dx = x[j] - xi, dy = y[j] - yi;
            if (torus) { if (dx > halfW) dx -= W2; else if (dx < -halfW) dx += W2; if (dy > halfH) dy -= H2; else if (dy < -halfH) dy += H2; }
            const d2 = dx * dx + dy * dy, sij = ri + rad[j], rmax = range * sij;
            if (d2 === 0 || d2 >= rmax * rmax) continue;
            dens++;
            if (engineForces) { const d = Math.sqrt(d2); const F = ((d < sij) ? muR : muA) * (d - sij); const k = F / d; fx += k * dx; fy += k * dy; }
          }
        }
      }
    }
    s.density[i] = dens;
    let vxi = momentum * vxArr[i] + dtOverEta * fx;
    let vyi = momentum * vyArr[i] + dtOverEta * fy;
    if (maxSpeed > 0) { const sp = Math.sqrt(vxi * vxi + vyi * vyi); if (sp > maxSpeed) { const sc = maxSpeed / sp; vxi *= sc; vyi *= sc; } }
    vxArr[i] = vxi; vyArr[i] = vyi;
    let nx = xi + vxi, ny = yi + vyi;
    if (torus) { nx = ((nx % W2) + W2) % W2; ny = ((ny % H2) + H2) % H2; }
    else { nx = nx < 0 ? 0 : nx > W2 ? W2 : nx; ny = ny < 0 ? 0 : ny > H2 ? H2 : ny; }
    xN[i] = nx; yN[i] = ny;
  }
}

function copyHashIntoMemory(s, hash) {
  const buf = s.memory.buffer, L = s.layout;
  if (!hash) return { hashValid: 0 };
  const nBins = hash.nBinsX * hash.nBinsY * hash.nBinsZ;
  new Int32Array(buf, L.hashBinStartOffset, nBins + 1).set(hash.binStart.subarray(0, nBins + 1));
  const used = hash.binStart[nBins];
  if (used > 0) new Int32Array(buf, L.hashBinAgentsOffset, used).set(hash.binAgents.subarray(0, used));
  return { hashValid: 1 };
}

function median(a) { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; }

async function benchCount(N) {
  cfg.maxAgents = N;
  const attrSpecs = [];
  const maxHashBins = computeAgentMaxHashBins(W, H, 1, cfg.interactionRange, cfg.defaultRadius, cfg.neighbourQueryRadius);
  // --- JS store (plain) ---
  const sJS = createAgentStore(cfg, attrSpecs);
  sJS.worldDepth = 1; sJS.dt = cfg.timeStep;
  // --- WASM store (wasmBacked) ---
  const sW = createAgentStore(cfg, attrSpecs, { wasmBacked: true, maxHashBins });
  sW.worldDepth = 1; sW.dt = cfg.timeStep;

  // seed N agents at the same pseudo-random positions in BOTH stores.
  let seed = 12345; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const specs = []; for (let i = 0; i < N; i++) specs.push({ x: rnd() * W, y: rnd() * H, radius: 0.5 });
  seedAgents(sJS, specs, 0.5); seedAgents(sW, specs, 0.5);
  for (let i = 0; i < N; i++) { sW.vx[i] = (rnd() - 0.5); sW.vy[i] = (rnd() - 0.5); sJS.vx[i] = sW.vx[i]; sJS.vy[i] = sW.vy[i]; }

  // compile + instantiate the WASM module (behaviour + forcePass).
  const r = compileAgentGraphWasm(model.agentGraphNodes, model.agentGraphEdges, model, sW.layout);
  if (r.error) { console.log(`  [N=${N}] WASM compile error: ${r.error}`); }
  const inst = r.error ? null : await instantiateAgentWasm(r.bytes, sW.memory);
  const fpFn = inst ? inst.forcePass : null;

  const binEdge = Math.max(cfg.interactionRange * 2 * 0.5, cfg.neighbourQueryRadius);
  const dtOverEta = cfg.timeStep / cfg.drag;

  const STEPS = N >= 50000 ? 12 : 30;
  const WARM = 3;
  const jsTimes = [], wTimes = [];
  for (let step = 0; step < STEPS + WARM; step++) {
    // hash build (EXCLUDED from timing — CPU on every target).
    const hashJS = buildSpatialHash(sJS, Math.max(1e-3, binEdge), W, H, 1);
    sJS.forceX.fill(0, 0, sJS.highWater); sJS.forceY.fill(0, 0, sJS.highWater);
    const t0 = performance.now();
    jsForceLoop(sJS, hashJS, dtOverEta);
    const t1 = performance.now();
    { const tmp = sJS.x; sJS.x = sJS.xNext; sJS.xNext = tmp; const tmp2 = sJS.y; sJS.y = sJS.yNext; sJS.yNext = tmp2; }
    if (step >= WARM) jsTimes.push(t1 - t0);

    // WASM force pass.
    if (fpFn) {
      const hashW = buildSpatialHash(sW, Math.max(1e-3, binEdge), W, H, 1);
      sW.forceX.fill(0, 0, sW.highWater); sW.forceY.fill(0, 0, sW.highWater);
      const { hashValid } = copyHashIntoMemory(sW, hashW);
      const args = FORCE_PASS_PARAMS_ORDER(sW, hashW, dtOverEta, false, true);
      args[1] = hashValid;
      const t2 = performance.now();
      fpFn(...args);
      const t3 = performance.now();
      // commit (copy-into, wasmBacked).
      sW.x.set(sW.xNext); sW.y.set(sW.yNext);
      if (step >= WARM) wTimes.push(t3 - t2);
    }
  }
  const jsMs = median(jsTimes), wMs = wTimes.length ? median(wTimes) : NaN;
  const jsSps = 1000 / jsMs, wSps = wTimes.length ? 1000 / wMs : NaN;
  return { N, jsMs, wMs, jsSps, wSps, speedup: jsMs / wMs };
}

console.log('=== Agent FORCE-INTEGRATOR scale benchmark (force-pass only; hash build excluded) ===');
console.log('world ' + W + 'x' + H + ', torus, momentum 0.9, customForces (soft-sphere OFF, like boids)\n');
console.log('   N      JS ms/step   JS steps/s    WASM ms/step  WASM steps/s   WASM speedup');
console.log('   ------  -----------  -----------   ------------  ------------   ------------');
for (const N of COUNTS) {
  const r = await benchCount(N);
  const f = (v, w) => (Number.isFinite(v) ? v.toFixed(w) : 'n/a').padStart(11);
  console.log(`   ${String(N).padStart(6)}  ${f(r.jsMs, 3)}  ${f(r.jsSps, 1)}   ${f(r.wMs, 3).slice(0,12).padStart(12)}  ${f(r.wSps, 1).padStart(12)}   ${(Number.isFinite(r.speedup)? r.speedup.toFixed(2)+'x':'n/a').padStart(12)}`);
}
console.log('\nNote: WebGPU is NOT in this table — its per-step whole-SoA upload+readback');
console.log('(CPU-built hash) is a fixed overhead that dominates below ~10k agents, so');
console.log('WebGPU is a wash/regression vs JS/WASM at interactive counts; the win, if any,');
console.log('appears only at large counts and needs the wired runtime (deferred) to measure.');

rmSync(dir, { recursive: true, force: true });
rmSync(entryPath, { force: true });

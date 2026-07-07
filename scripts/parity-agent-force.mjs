// Force-pass PARITY harness — JS force loop vs the WASM `forcePass`, for the
// Collision capability (the milestone gap the behaviour-only parity harness never
// covered). The soft-sphere force pass is a SEPARATE WASM export from `behaviour`;
// `parity-agent-wasm.mjs` only exercises the behaviour fn, so the collision wiring
// (bonding || doCollision gate + muRep/muAdh split) needs its own JS↔WASM check.
//
// It verifies, over several steps of a small overlapping-agent world:
//   (A) JS↔WASM bit-parity of xNext/yNext/vx/vy/density for FOUR gate combos
//       (collision-only, bonding-only, both, neither);
//   (B) BEHAVIOUR: collision-on actually separates overlapping agents (the pass-
//       through bug the user reported), collision-off leaves them overlapping.
//
// Run from the repo root:  node scripts/parity-agent-force.mjs
import { build } from 'esbuild';
import { writeFileSync, rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = `
export { createAgentStore, computeAgentMaxHashBins, buildSpatialHash, seedAgents } from '../src/simulator/engine/agentEngine.ts';
export { compileAgentGraphWasm, instantiateAgentWasm } from '../src/modeler/vpl/compiler/agentWasm/compile.ts';
`;
const dir = mkdtempSync(join(tmpdir(), 'gca-fp-'));
const entryPath = join(ROOT, 'scripts', '__fp_entry.ts');
writeFileSync(entryPath, ENTRY);
const outPath = join(dir, 'bundle.mjs');
await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: process.cwd() });
const mod = await import(pathToFileURL(outPath).href);
const { createAgentStore, seedAgents, buildSpatialHash, compileAgentGraphWasm, instantiateAgentWasm, computeAgentMaxHashBins } = mod;

const W = 40, H = 40;
const baseCfg = {
  enabled: true, maxAgents: 200, maxBonds: 0,
  worldWidth: W, worldHeight: H, worldDepth: 1,
  repulsionStiffness: 2.0, adhesionStiffness: 1.5, interactionRange: 1.5,
  drag: 1.0, timeStep: 0.1, momentum: 0.0, maxSpeed: 0.0,
  neighbourQueryRadius: 5.0, defaultRadius: 0.5, growthRate: 0.0,
};

// The FULL 25-param force-pass ABI (mirrors FORCE_PASS_PARAMS in agentWasm/compile.ts).
const forceArgs = (s, hash, cfg, dtOverEta, bonding, doCollision, torus) => ([
  s.highWater, hash ? 1 : 0, hash ? hash.nBinsX : 0, hash ? hash.nBinsY : 0, 0,
  hash ? hash.binSizeX : 1, hash ? hash.binSizeY : 1, 1,
  dtOverEta, cfg.repulsionStiffness, cfg.adhesionStiffness, cfg.interactionRange,
  cfg.momentum, cfg.maxSpeed, 0 /*growthRate — collision/gas never grows*/,
  W, H, 1, bonding ? 1 : 0, torus ? 1 : 0,
  hash ? hash.originX : 0, hash ? hash.originY : 0, 0,
  doCollision ? 1 : 0, bonding ? 1 : 0 /*doSprings — no bonds in this harness (bc=0), so inert*/,
]);

// Verbatim JS 2D force loop — matches the CURRENT sim.worker.ts runAgentStep
// (doForce = doCollision||engineForces; muRep = doCollision?muR:0; muAdh = engineForces?muA:0).
function jsForceLoop(s, hash, cfg, dtOverEta, bonding, doCollision, torus) {
  const hw = s.highWater, x = s.x, y = s.y, rad = s.radius, alive = s.alive;
  const xN = s.xNext, yN = s.yNext, vxArr = s.vx, vyArr = s.vy;
  const W2 = s.worldWidth, H2 = s.worldHeight, halfW = W2 / 2, halfH = H2 / 2;
  const range = cfg.interactionRange, muR = cfg.repulsionStiffness, muA = cfg.adhesionStiffness;
  const momentum = cfg.momentum, maxSpeed = cfg.maxSpeed;
  const engineForces = bonding;
  const muRep = doCollision ? muR : 0, muAdh = engineForces ? muA : 0;
  const doForce = doCollision || engineForces;
  for (let i = 0; i < hw; i++) {
    if (!alive[i]) { xN[i] = x[i]; yN[i] = y[i]; continue; }
    const xi = x[i], yi = y[i], ri = rad[i];
    let fx = s.forceX[i], fy = s.forceY[i], dens = 0;
    const interact = (j) => {
      if (j === i) return;
      let dx = x[j] - xi, dy = y[j] - yi;
      if (torus) { if (dx > halfW) dx -= W2; else if (dx < -halfW) dx += W2; if (dy > halfH) dy -= H2; else if (dy < -halfH) dy += H2; }
      const d2 = dx * dx + dy * dy, sij = ri + rad[j], rmax = range * sij;
      if (d2 === 0 || d2 >= rmax * rmax) return;
      dens++;
      if (doForce) { const d = Math.sqrt(d2); const F = ((d < sij) ? muRep : muAdh) * (d - sij); const k = F / d; fx += k * dx; fy += k * dy; }
    };
    if (hash) {
      const nBinsX = hash.nBinsX, nBinsY = hash.nBinsY, binStart = hash.binStart, binAgents = hash.binAgents;
      let bx = ((xi - hash.originX) / hash.binSizeX) | 0; if (bx < 0) bx = 0; else if (bx >= nBinsX) bx = nBinsX - 1;
      let by = ((yi - hash.originY) / hash.binSizeY) | 0; if (by < 0) by = 0; else if (by >= nBinsY) by = nBinsY - 1;
      for (let ddy = -1; ddy <= 1; ddy++) {
        for (let ddx = -1; ddx <= 1; ddx++) {
          let nbx = bx + ddx, nby = by + ddy;
          if (torus) { nbx = ((nbx % nBinsX) + nBinsX) % nBinsX; nby = ((nby % nBinsY) + nBinsY) % nBinsY; }
          else { if (nbx < 0 || nbx >= nBinsX || nby < 0 || nby >= nBinsY) continue; }
          const b = nby * nBinsX + nbx, end = binStart[b + 1];
          for (let p = binStart[b]; p < end; p++) interact(binAgents[p]);
        }
      }
    } else {
      for (let j = 0; j < hw; j++) { if (alive[j]) interact(j); }
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
  if (!hash) return; // null hash => all-pairs fallback (hashValid=0 passed to WASM)
  const buf = s.memory.buffer, L = s.layout;
  const nBins = hash.nBinsX * hash.nBinsY * hash.nBinsZ;
  new Int32Array(buf, L.hashBinStartOffset, nBins + 1).set(hash.binStart.subarray(0, nBins + 1));
  const used = hash.binStart[nBins];
  if (used > 0) new Int32Array(buf, L.hashBinAgentsOffset, used).set(hash.binAgents.subarray(0, used));
}

// minimal agent graph so the WASM module exports behaviour + forcePass
const nb = (id, nodeType, config = {}) => ({ id, type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType, config } });
const fe = (s, sh, t, th) => ({ id: s + '->' + t, source: s, sourceHandle: sh, target: t, targetHandle: th });
const agentGraphNodes = [nb('beh', 'behaviourStep'), nb('af', 'applyForce', { _port_fx: '0.0', _port_fy: '0.0' })];
const agentGraphEdges = [fe('beh', 'output_flow_do', 'af', 'input_flow_do')];

function minPairDist(s) {
  let m = Infinity;
  for (let i = 0; i < s.highWater; i++) for (let j = i + 1; j < s.highWater; j++) {
    let dx = s.x[i] - s.x[j], dy = s.y[i] - s.y[j];
    if (dx > W / 2) dx -= W; else if (dx < -W / 2) dx += W;
    if (dy > H / 2) dy -= H; else if (dy < -H / 2) dy += H;
    const d = Math.hypot(dx, dy); if (d < m) m = d;
  }
  return m;
}

let fail = 0, checks = 0;
const torus = true;

async function runCombo(name, bonding, doCollision) {
  const cfg = { ...baseCfg };
  const attrSpecs = [];
  const maxHashBins = computeAgentMaxHashBins(W, H, 1, cfg.interactionRange, cfg.defaultRadius, cfg.neighbourQueryRadius);
  const sJS = createAgentStore(cfg, attrSpecs); sJS.worldDepth = 1; sJS.dt = cfg.timeStep;
  const sW = createAgentStore(cfg, attrSpecs, { wasmBacked: true, maxHashBins }); sW.worldDepth = 1; sW.dt = cfg.timeStep;

  // seed 60 agents heavily overlapping in a tight blob (many within one contact dist)
  let seed = 987654321; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const N = 60; const specs = [];
  for (let i = 0; i < N; i++) specs.push({ x: W / 2 + (rnd() - 0.5) * 3, y: H / 2 + (rnd() - 0.5) * 3, radius: 0.5 });
  seedAgents(sJS, specs, 0.5); seedAgents(sW, specs, 0.5);

  const r = compileAgentGraphWasm(agentGraphNodes, agentGraphEdges, {
    properties: { gridWidth: W, gridHeight: H, dimension: '2d', gridDepth: 1, boundaryTreatment: 'torus' },
    topologyMode: { gridCells: true, agents: true },
    centerBased: cfg, agentGraphNodes, agentGraphEdges, agentVariables: [],
    graphNodes: [], graphEdges: [], macroDefs: [], variables: [], attributes: [], neighborhoods: [],
  }, sW.layout);
  if (r.error) { console.log(`  ✗ ${name}: WASM compile error: ${r.error}`); fail++; return null; }
  const inst = await instantiateAgentWasm(r.bytes, sW.memory);
  const fpFn = inst.forcePass;

  const binEdge = Math.max(cfg.interactionRange * 2 * cfg.defaultRadius, cfg.neighbourQueryRadius);
  const dtOverEta = cfg.timeStep / cfg.drag;
  const STEPS = 25;
  let mism = 0;
  for (let step = 0; step < STEPS; step++) {
    const hashJS = buildSpatialHash(sJS, Math.max(1e-3, binEdge), W, H, 1);
    sJS.forceX.fill(0, 0, sJS.highWater); sJS.forceY.fill(0, 0, sJS.highWater);
    jsForceLoop(sJS, hashJS, cfg, dtOverEta, bonding, doCollision, torus);
    { const t = sJS.x; sJS.x = sJS.xNext; sJS.xNext = t; const t2 = sJS.y; sJS.y = sJS.yNext; sJS.yNext = t2; }

    const hashW = buildSpatialHash(sW, Math.max(1e-3, binEdge), W, H, 1);
    sW.forceX.fill(0, 0, sW.highWater); sW.forceY.fill(0, 0, sW.highWater);
    copyHashIntoMemory(sW, hashW);
    fpFn(...forceArgs(sW, hashW, cfg, dtOverEta, bonding, doCollision, torus));
    sW.x.set(sW.xNext); sW.y.set(sW.yNext);

    for (let i = 0; i < sJS.highWater; i++) {
      if (sJS.x[i] !== sW.x[i] || sJS.y[i] !== sW.y[i] || sJS.vx[i] !== sW.vx[i] || sJS.vy[i] !== sW.vy[i] || sJS.density[i] !== sW.density[i]) mism++;
    }
  }
  checks++;
  if (mism > 0) { console.log(`  ✗ ${name}: ${mism} JS↔WASM mismatches over ${STEPS} steps`); fail++; }
  else console.log(`  ✓ ${name}: JS↔WASM bit-parity (0 mismatches, ${STEPS} steps) | final minPairDist ${minPairDist(sJS).toFixed(3)}`);
  return sJS;
}

console.log('Force-pass parity (JS force loop ↔ WASM forcePass):');
const sCollisionOnly = await runCombo('collision-only (doCollision=1, bonding=0)', false, true);
const sBondingOnly = await runCombo('bonding-only  (doCollision=0, bonding=1)', true, false);
await runCombo('both          (doCollision=1, bonding=1)', true, true);
const sNeither = await runCombo('neither       (doCollision=0, bonding=0)', false, false);

// BEHAVIOUR: collision-only must SEPARATE the blob; neither must NOT.
console.log('\nBehaviour (the user-reported pass-through):');
const dCol = sCollisionOnly ? minPairDist(sCollisionOnly) : 0;
const dNone = sNeither ? minPairDist(sNeither) : 0;
checks++;
// collision-on pushes overlapping agents apart (minPairDist grows toward the
// contact distance ~1.0); no-force leaves the blob overlapping. A robust ratio
// check (collision separation >= 4× the no-force minimum) captures the fix.
if (dCol > 0.4 && dNone < 0.2 && dCol > dNone * 4) console.log(`  ✓ collision separates the blob (minPairDist ${dCol.toFixed(3)}) while no-force leaves overlaps (${dNone.toFixed(3)}) — ${(dCol / Math.max(dNone, 1e-6)).toFixed(1)}× apart`);
else { console.log(`  ✗ expected collision >> no-force separation (collision ${dCol.toFixed(3)}, no-force ${dNone.toFixed(3)})`); fail++; }

console.log(`\n${fail === 0 ? 'FORCE-PASS PARITY ✓' : `${fail} FAILED ✗`}  (${checks} checks)`);
rmSync(entryPath, { force: true }); rmSync(dir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);

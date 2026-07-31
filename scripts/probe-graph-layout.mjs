// PROBE / GATE — does a grown bond-graph lay out readably, or collapse into a
// jammed blob?
//
// Models the REAL generative process: start from K4 and grow by TRIANGLE SPLITS
// (the shipped `Cubic GRA` operation), placing newborns near the mother, and relax
// between splits with the REAL ENGINE FORCE PASS — the WASM `forcePass` export
// compiled by `agentWasm/compile.ts` and run over a real `createAgentStore`, driven
// exactly the way `sim.worker.ts` drives it (build the hash, copy it into the
// module's memory, call the export, commit xNext). So soft-sphere repulsion, bond
// springs AND the L1 long-range charge all come from SHIPPED code; nothing about
// the force law is reimplemented here.
//
// (Before L1 this file carried its own copy of the force loop plus a hand-written
// charge term, because there was no charge in the engine to call. That copy is
// gone: a probe that measures its own reimplementation cannot gate the product.)
//
// The engine's JS force loop is bit-identical to this WASM one — asserted by
// scripts/parity-agent-force.mjs, which covers charge across 2D/3D × torus/bounded
// × collision on/off — so these numbers characterise both CPU targets.
//
// Metrics
//   bond      : mean bond length / rest length            healthy ~1
//   nnb/bond  : mean distance to nearest NON-bonded node,
//               divided by mean bond length                healthy ~1 (nothing crammed between)
//               jammed  <<1 (unrelated nodes packed at contact distance)
//   overlap%  : share of nodes with a non-bonded node inside contact distance
//
// Run:  node scripts/probe-graph-layout.mjs
import { build } from 'esbuild';
import { writeFileSync, rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = `
export { createAgentStore, buildSpatialHash, formBond, computeAgentMaxHashBins } from '../src/simulator/engine/agentEngine.ts';
export { compileAgentGraphWasm, instantiateAgentWasm } from '../src/modeler/vpl/compiler/agentWasm/compile.ts';
export { chargeParamsOf, chargeBinEdgeOf, cbNum } from '../src/model/centerBased.ts';
`;
const dir = mkdtempSync(join(tmpdir(), 'gca-layout-'));
const entryPath = join(ROOT, 'scripts', '__layout_entry.ts');
writeFileSync(entryPath, ENTRY);
const outPath = join(dir, 'bundle.mjs');
await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: process.cwd() });
const {
  createAgentStore, buildSpatialHash, formBond, computeAgentMaxHashBins,
  compileAgentGraphWasm, instantiateAgentWasm, chargeParamsOf, chargeBinEdgeOf, cbNum,
} = await import(pathToFileURL(outPath).href);

const mulberry = seed => () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

// -- a plain adjacency model of the graph (the store mirrors it) --------------
function breakPair(s, a, b) {
  for (const [u, v] of [[a, b], [b, a]]) {
    const base = u * s.maxBonds;
    for (let k = 0; k < s.bondCount[u]; k++) {
      if (s.bondPartner[base + k] === v) {
        const last = s.bondCount[u] - 1;
        s.bondPartner[base + k] = s.bondPartner[base + last];
        s.bondRestLength[base + k] = s.bondRestLength[base + last];
        s.bondStiffness[base + k] = s.bondStiffness[base + last];
        s.bondPartnerEpoch[base + k] = s.bondPartnerEpoch[base + last];
        s.bondCount[u] = last; break;
      }
    }
  }
}
const partners = (s, i) => { const o = []; const b = i * s.maxBonds; for (let k = 0; k < s.bondCount[i]; k++) o.push(s.bondPartner[b + k]); return o; };

// -- the minimal agent graph the module needs to export behaviour + forcePass --
const nb = (id, nodeType, config = {}) => ({ id, type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType, config } });
const fe = (s, sh, t, th) => ({ id: s + '->' + t, source: s, sourceHandle: sh, target: t, targetHandle: th });
const agentGraphNodes = [nb('beh', 'behaviourStep'), nb('af', 'applyForce', { _port_fx: '0.0', _port_fy: '0.0' })];
const agentGraphEdges = [fe('beh', 'output_flow_do', 'af', 'input_flow_do')];

/** Copy the CPU-built hash into the module's reserved in-memory views — exactly
 *  what `runAgentStep` does before calling the WASM force pass (AW-HASH). */
function copyHashIntoMemory(s, hash) {
  if (!hash) return;
  const buf = s.memory.buffer, L = s.layout;
  const nBins = hash.nBinsX * hash.nBinsY * hash.nBinsZ;
  new Int32Array(buf, L.hashBinStartOffset, nBins + 1).set(hash.binStart.subarray(0, nBins + 1));
  const used = hash.binStart[nBins];
  if (used > 0) new Int32Array(buf, L.hashBinAgentsOffset, used).set(hash.binAgents.subarray(0, used));
}

function metrics(s) {
  const hw = s.highWater; let bsum = 0, bn = 0;
  for (let i = 0; i < hw; i++) { if (!s.alive[i]) continue; const b = i * s.maxBonds;
    for (let k = 0; k < s.bondCount[i]; k++) { const j = s.bondPartner[b + k]; if (j < i) continue; bsum += Math.hypot(s.x[j] - s.x[i], s.y[j] - s.y[i]); bn++; } }
  const bond = bn ? bsum / bn : 0;
  let nnbSum = 0, nnbN = 0, overlap = 0;
  for (let i = 0; i < hw; i++) {
    if (!s.alive[i]) continue;
    const ps = new Set(partners(s, i)); let best = Infinity;
    for (let j = 0; j < hw; j++) { if (j === i || !s.alive[j] || ps.has(j)) continue;
      const d = Math.hypot(s.x[j] - s.x[i], s.y[j] - s.y[i]); if (d < best) best = d; }
    if (best < Infinity) { nnbSum += best; nnbN++; if (best < s.radius[i] * 2) overlap++; }
  }
  const nnb = nnbN ? nnbSum / nnbN : 0;
  return { bond, nnb, ratio: bond ? nnb / bond : 0, overlapPct: nnbN ? 100 * overlap / nnbN : 0 };
}

// -- grow by triangle splits, relaxing between, through the REAL engine --------
async function grow({ target, range, rest, chargeOn, chargeMaxDist, ticksPerSplitRound, label }) {
  const rnd = mulberry(99);
  const MAX = target + 16, W = 4000, H = 4000, cx = W / 2, cy = H / 2;
  const cfg = {
    enabled: true, maxAgents: MAX, maxBonds: 3, worldWidth: W, worldHeight: H, worldDepth: 1,
    defaultRadius: 0.9, bondStiffness: 0.55, repulsionStiffness: 0.9, adhesionStiffness: 0,
    interactionRange: range, timeStep: 0.12, drag: 1, momentum: 0, maxSpeed: 0,
    neighbourQueryRadius: 6, growthRate: 0, bondRestLength: rest,
    // The capability profile is what turns the charge on — the same `usesCharge`
    // gate the engine reads, so the compiler emits the charge params only here.
    agentCapabilities: chargeOn
      ? { motion: 'force', body: true, collision: 'soft', bonds: 'physics', charge: 'on' }
      : { motion: 'force', body: true, collision: 'soft', bonds: 'physics', charge: 'off' },
    ...(chargeOn ? { chargeStrength: -3, chargeMaxDist } : {}),
  };
  const maxHashBins = computeAgentMaxHashBins(W, H, 1, cfg.interactionRange, cfg.defaultRadius, cfg.neighbourQueryRadius);
  const s = createAgentStore(cfg, [], { wasmBacked: true, maxHashBins });
  s.worldDepth = 1; s.dt = cfg.timeStep;

  const r = compileAgentGraphWasm(agentGraphNodes, agentGraphEdges, {
    properties: { gridWidth: W, gridHeight: H, dimension: '2d', gridDepth: 1, boundaryTreatment: 'constant' },
    topologyMode: { gridCells: false, agents: true },
    centerBased: cfg, agentGraphNodes, agentGraphEdges, agentVariables: [],
    graphNodes: [], graphEdges: [], macroDefs: [], variables: [], attributes: [], neighborhoods: [],
  }, s.layout);
  if (r.error) throw new Error(`agent WASM compile failed: ${r.error}`);
  const forcePass = (await instantiateAgentWasm(r.bytes, s.memory)).forcePass;
  if (!forcePass) throw new Error('the agent module exported no forcePass');

  // K4 seed
  for (let i = 0; i < 4; i++) { s.alive[i] = 1; s.epoch[i] = 1; s.radius[i] = 0.9; s.targetRadius[i] = 0.9;
    s.x[i] = cx + Math.cos(i * Math.PI / 2) * rest; s.y[i] = cy + Math.sin(i * Math.PI / 2) * rest; }
  s.highWater = 4; s.liveCount = 4;
  for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) formBond(s, a, b, rest, 0.55);

  // The engine's own resolvers decide the charge constants AND the bin edge — the
  // probe never recomputes them, so it cannot accidentally test a different force
  // (or a different stencil) from the one the product runs.
  const ch = chargeParamsOf(cfg);
  const binEdge = Math.max(cfg.interactionRange * 2 * cfg.defaultRadius, cfg.neighbourQueryRadius, chargeBinEdgeOf(cfg));
  const dtOverEta = cfg.timeStep / cfg.drag;
  const alloc = () => { const id = s.highWater++; s.alive[id] = 1; s.epoch[id] = 1; s.radius[id] = 0.9; s.targetRadius[id] = 0.9; s.liveCount++; return id; };

  let pairOps = 0, ticks = 0;
  const tick = () => {
    const hash = buildSpatialHash(s, Math.max(1e-3, binEdge), W, H, 1, false, maxHashBins);
    s.forceX.fill(0, 0, s.highWater); s.forceY.fill(0, 0, s.highWater);
    copyHashIntoMemory(s, hash);
    forcePass(
      s.highWater, hash ? 1 : 0, hash ? hash.nBinsX : 0, hash ? hash.nBinsY : 0, hash ? hash.nBinsZ : 0,
      hash ? hash.binSizeX : 1, hash ? hash.binSizeY : 1, hash ? hash.binSizeZ : 1,
      dtOverEta, cfg.repulsionStiffness, cfg.adhesionStiffness, cfg.interactionRange,
      cfg.momentum, cfg.maxSpeed, cfg.growthRate,
      W, H, 1, /*bonding*/ 0, /*torus*/ 0,
      hash ? hash.originX : 0, hash ? hash.originY : 0, hash ? hash.originZ : 0,
      /*doCollision*/ 1, /*doSprings*/ 1, /*doDensity*/ 0,
      ch.doCharge ? 1 : 0, ch.chargeK, ch.chargeMaxD2, ch.chargeMinC,
    );
    s.x.set(s.xNext); s.y.set(s.yNext);
    // Cost model: the 3×3 stencil visits every agent in the 9 bins around each
    // agent, so the pair-op count is what the cutoff really buys/costs.
    if (hash) { let c = 0; for (let b = 0; b < hash.nBinsX * hash.nBinsY; b++) { const n = hash.binStart[b + 1] - hash.binStart[b]; c += n; } pairOps += c * 9; }
    else pairOps += s.highWater * s.highWater;
    ticks++;
  };

  const t0 = Date.now();
  while (s.liveCount < target) {
    // one split round: split a random independent set (spaced-out ids)
    const cand = []; for (let i = 0; i < s.highWater; i++) if (s.alive[i] && s.bondCount[i] === 3) cand.push(i);
    const nSplit = Math.max(1, Math.min(cand.length >> 3, target - s.liveCount));
    const chosen = new Set();
    for (let t = 0; t < nSplit * 3 && chosen.size < nSplit; t++) {
      const i = cand[(rnd() * cand.length) | 0];
      if (chosen.has(i)) continue;
      if (partners(s, i).some(p => chosen.has(p))) continue;   // independent set
      chosen.add(i);
    }
    for (const i of chosen) {
      if (s.liveCount >= target) break;
      const [a, b, c] = partners(s, i);
      const j = alloc(), k = alloc();
      // newborns placed near the mother (the reference seeds at the parent midpoint)
      s.x[j] = s.x[i] + (rnd() - 0.5) * rest; s.y[j] = s.y[i] + (rnd() - 0.5) * rest;
      s.x[k] = s.x[i] + (rnd() - 0.5) * rest; s.y[k] = s.y[i] + (rnd() - 0.5) * rest;
      breakPair(s, i, b); breakPair(s, i, c);
      formBond(s, i, j, rest, 0.55); formBond(s, i, k, rest, 0.55); formBond(s, j, k, rest, 0.55);
      formBond(s, j, b, rest, 0.55); formBond(s, k, c, rest, 0.55);
    }
    for (let t = 0; t < ticksPerSplitRound; t++) tick();
  }
  for (let t = 0; t < 300; t++) tick();
  return { label, N: s.liveCount, ms: Date.now() - t0, nbrPerAgent: pairOps / Math.max(1, ticks) / Math.max(1, s.liveCount), ...metrics(s) };
}

const rest = 5, target = 1200;
console.log(`\nProbe: grow K4 -> ${target} nodes by TRIANGLE SPLIT, bond rest ${rest}, REAL engine force pass (WASM).`);
console.log(`  bond     = mean bond length / rest        (healthy ~1)`);
console.log(`  nnb/bond = nearest NON-bonded / bond      (healthy ~1, jammed <<1)`);
console.log(`  overlap% = nodes with a non-bonded neighbour inside contact distance`);
console.log(`  nbr/agent= mean candidates the 3x3 stencil visits per agent per tick (the cost)\n`);
console.log('  scenario                                         N     bond   nnb/bond   overlap%   nbr/agent    ms');
console.log('  ' + '-'.repeat(96));
const rows = [
  { label: 'SHIPPED: contact-only, 1 tick/round', range: 2.2, chargeOn: false, chargeMaxDist: 0, ticksPerSplitRound: 1 },
  { label: 'charge -3, cutoff   20 (= 4x rest), 8 ticks', range: 2.2, chargeOn: true, chargeMaxDist: 20, ticksPerSplitRound: 8 },
  { label: 'charge -3, cutoff   40 (= 8x rest), 8 ticks', range: 2.2, chargeOn: true, chargeMaxDist: 40, ticksPerSplitRound: 8 },
  { label: 'charge -3, cutoff   80 (=16x rest), 8 ticks', range: 2.2, chargeOn: true, chargeMaxDist: 80, ticksPerSplitRound: 8 },
  { label: 'charge -3, cutoff  160 (=32x rest), 8 ticks', range: 2.2, chargeOn: true, chargeMaxDist: 160, ticksPerSplitRound: 8 },
];
const results = [];
for (const r of rows) {
  const o = await grow({ target, rest, ...r });
  results.push(o);
  console.log(`  ${o.label.padEnd(46)} ${String(o.N).padStart(5)} ${(o.bond / rest).toFixed(2).padStart(8)} ${o.ratio.toFixed(2).padStart(10)} ${o.overlapPct.toFixed(1).padStart(10)} ${o.nbrPerAgent.toFixed(0).padStart(11)} ${String(o.ms).padStart(5)}`);
}

// ---------------------------------------------------------------------------
// 3D COST. The stencil is a 3×3×3 VOLUME, so at a given cutoff it sweeps 3× the
// linear extent in one more dimension — the candidate count per agent grows with
// the CUBE of the cutoff instead of the square. Measured here on a real uniformly
// packed population (spacing = bond rest) through the real force pass, so the "keep
// the 3D cutoff tight" guidance is a number, not an intuition.
// ---------------------------------------------------------------------------
async function cost({ is3d, cutoff, n, spacing }) {
  const side = Math.ceil(is3d ? Math.cbrt(n) : Math.sqrt(n));
  const span = (side + 2) * spacing;
  const W = span, H = span, D = is3d ? span : 1;
  const cfg = {
    enabled: true, maxAgents: n + 8, maxBonds: 0, worldWidth: W, worldHeight: H, worldDepth: D,
    defaultRadius: 0.9, repulsionStiffness: 0.9, adhesionStiffness: 0, interactionRange: 2.2,
    timeStep: 0.12, drag: 1, momentum: 0, maxSpeed: 0, neighbourQueryRadius: 6,
    growthRate: 0, bondRestLength: spacing,
    agentCapabilities: { motion: 'force', body: true, collision: 'soft', bonds: 'off', charge: 'on' },
    chargeStrength: -3, chargeMaxDist: cutoff,
  };
  const maxHashBins = computeAgentMaxHashBins(W, H, D, cfg.interactionRange, cfg.defaultRadius, cfg.neighbourQueryRadius);
  const s = createAgentStore(cfg, [], { wasmBacked: true, maxHashBins });
  s.worldDepth = D; s.dt = cfg.timeStep;
  const r = compileAgentGraphWasm(agentGraphNodes, agentGraphEdges, {
    properties: { gridWidth: W, gridHeight: H, dimension: is3d ? '3d' : '2d', gridDepth: D, boundaryTreatment: 'constant' },
    topologyMode: { gridCells: false, agents: true },
    centerBased: cfg, agentGraphNodes, agentGraphEdges, agentVariables: [],
    graphNodes: [], graphEdges: [], macroDefs: [], variables: [], attributes: [], neighborhoods: [],
  }, s.layout);
  if (r.error) throw new Error(r.error);
  const forcePass = (await instantiateAgentWasm(r.bytes, s.memory)).forcePass;
  let id = 0;
  for (let a = 0; a < side && id < n; a++) for (let b = 0; b < side && id < n; b++) for (let c = 0; c < (is3d ? side : 1) && id < n; c++) {
    s.alive[id] = 1; s.epoch[id] = 1; s.radius[id] = 0.9; s.targetRadius[id] = 0.9;
    s.x[id] = (a + 1) * spacing; s.y[id] = (b + 1) * spacing; s.z[id] = is3d ? (c + 1) * spacing : 0;
    id++;
  }
  s.highWater = id; s.liveCount = id;
  const ch = chargeParamsOf(cfg);
  const binEdge = Math.max(cfg.interactionRange * 2 * cfg.defaultRadius, cfg.neighbourQueryRadius, chargeBinEdgeOf(cfg));
  const hash = buildSpatialHash(s, Math.max(1e-3, binEdge), W, H, D, false, maxHashBins);
  // Candidates per agent = the population of the 3×3(×3) bin neighbourhood.
  let cand = 0;
  for (let i = 0; i < id; i++) {
    const bx = Math.min(hash ? hash.nBinsX - 1 : 0, Math.max(0, ((s.x[i] - (hash ? hash.originX : 0)) / (hash ? hash.binSizeX : 1)) | 0));
    const by = Math.min(hash ? hash.nBinsY - 1 : 0, Math.max(0, ((s.y[i] - (hash ? hash.originY : 0)) / (hash ? hash.binSizeY : 1)) | 0));
    const bz = is3d && hash ? Math.min(hash.nBinsZ - 1, Math.max(0, ((s.z[i] - hash.originZ) / hash.binSizeZ) | 0)) : 0;
    if (!hash) { cand += id; continue; }
    for (let dz = is3d ? -1 : 0; dz <= (is3d ? 1 : 0); dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx2 = bx + dx, ny2 = by + dy, nz2 = bz + dz;
      if (nx2 < 0 || nx2 >= hash.nBinsX || ny2 < 0 || ny2 >= hash.nBinsY || nz2 < 0 || nz2 >= hash.nBinsZ) continue;
      const b = (nz2 * hash.nBinsY + ny2) * hash.nBinsX + nx2;
      cand += hash.binStart[b + 1] - hash.binStart[b];
    }
  }
  const dtOverEta = cfg.timeStep / cfg.drag;
  copyHashIntoMemory(s, hash);
  const TICKS = 12; const t0 = Date.now();
  for (let t = 0; t < TICKS; t++) {
    s.forceX.fill(0, 0, id); s.forceY.fill(0, 0, id); s.forceZ.fill(0, 0, id);
    forcePass(
      id, hash ? 1 : 0, hash ? hash.nBinsX : 0, hash ? hash.nBinsY : 0, hash ? hash.nBinsZ : 0,
      hash ? hash.binSizeX : 1, hash ? hash.binSizeY : 1, hash ? hash.binSizeZ : 1,
      dtOverEta, cfg.repulsionStiffness, cfg.adhesionStiffness, cfg.interactionRange,
      cfg.momentum, cfg.maxSpeed, cfg.growthRate, W, H, D, 0, 0,
      hash ? hash.originX : 0, hash ? hash.originY : 0, hash ? hash.originZ : 0,
      1, 0, 0, ch.doCharge ? 1 : 0, ch.chargeK, ch.chargeMaxD2, ch.chargeMinC,
    );
  }
  return { n: id, cand: cand / id, msPerTick: (Date.now() - t0) / TICKS };
}

console.log('\n3D cost — the stencil is a VOLUME (uniform packing, spacing = bond rest 5, cutoff as a multiple of it):');
console.log('  dim   cutoff        N   cand/agent   ms/tick');
console.log('  ' + '-'.repeat(48));
for (const c of [{ is3d: false, cutoff: 20 }, { is3d: false, cutoff: 40 }, { is3d: true, cutoff: 20 }, { is3d: true, cutoff: 40 }]) {
  const o = await cost({ ...c, n: 1728, spacing: 5 });
  console.log(`  ${(c.is3d ? '3D' : '2D').padEnd(4)} ${String(c.cutoff).padStart(6)} (${c.cutoff / 5}x) ${String(o.n).padStart(6)} ${o.cand.toFixed(0).padStart(12)} ${o.msPerTick.toFixed(2).padStart(9)}`);
}

// ---------------------------------------------------------------------------
// THE GATE. The shipped (charge-off) row is the jammed baseline; the 8×-rest row
// is the shipped default. Assert the fix rather than eyeballing the table.
// ---------------------------------------------------------------------------
const base = results[0], fix = results[2];
let fail = 0;
const gate = (name, cond, detail) => { if (cond) console.log(`  ok  ${name}`); else { console.log(`FAIL  ${name} — ${detail}`); fail++; } };
console.log('\n=== GATE ===');
gate('baseline (charge off) reproduces the jam', base.overlapPct > 90 && base.ratio < 0.2,
  `overlap ${base.overlapPct.toFixed(1)}% (want >90), nnb/bond ${base.ratio.toFixed(2)} (want <0.2) — if this passes, the probe is no longer measuring the bug`);
gate('charge at 8x rest opens the layout: overlap <= 1%', fix.overlapPct <= 1, `overlap ${fix.overlapPct.toFixed(1)}%`);
gate('charge at 8x rest opens the layout: nnb/bond >= 0.6', fix.ratio >= 0.6, `nnb/bond ${fix.ratio.toFixed(2)}`);
console.log(`\n${fail === 0 ? 'LAYOUT PROBE ✓' : `${fail} FAILED ✗`}`);
rmSync(entryPath, { force: true }); rmSync(dir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);

// PROBE — why does the grown bond-graph look like a jammed blob, and what fixes it?
//
// Models the REAL generative process: start from K4 and grow by TRIANGLE SPLITS
// (the shipped `Cubic GRA` operation), placing newborns near the mother, running
// the REAL engine force loop between splits. Then measures layout quality with and
// without a LONG-RANGE charge force (the reference project's Barnes-Hut term,
// brute-forced here since N is small).
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
const ENTRY = `export { createAgentStore, buildSpatialHash, formBond, removeBondSlotForProbe } from '../src/simulator/engine/agentEngine.ts';`;
const dir = mkdtempSync(join(tmpdir(), 'gca-layout-'));
const entryPath = join(ROOT, 'scripts', '__layout_entry.ts');
writeFileSync(entryPath, `export { createAgentStore, buildSpatialHash, formBond } from '../src/simulator/engine/agentEngine.ts';`);
const outPath = join(dir, 'bundle.mjs');
await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: process.cwd() });
const { createAgentStore, buildSpatialHash, formBond } = await import(pathToFileURL(outPath).href);

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

// -- the REAL engine 2D force pass (verbatim shape from sim.worker.ts) --------
// `charge` adds the long-range N-body repulsion the engine does NOT have:
//   f = chargeStrength * (1/(1+d^2) - 1/(1+maxDist^2)) * d_hat   (the reference's law)
function forcePass(s, P) {
  const { W, H, dtOverEta, muR, range, lambda, hash, charge, chargeMaxDist } = P;
  const hw = s.highWater, x = s.x, y = s.y, rad = s.radius, alive = s.alive;
  const minC = 1 / (1 + chargeMaxDist * chargeMaxDist);
  for (let i = 0; i < hw; i++) {
    if (!alive[i]) continue;
    let fx = 0, fy = 0;
    const xi = x[i], yi = y[i], ri = rad[i];
    if (hash) {  // short-range soft-sphere, exactly as the engine does it
      const bx = Math.floor((xi - hash.originX) / hash.binSizeX), by = Math.floor((yi - hash.originY) / hash.binSizeY);
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        const nbx = bx + ox, nby = by + oy;
        if (nbx < 0 || nby < 0 || nbx >= hash.nBinsX || nby >= hash.nBinsY) continue;
        const bin = nby * hash.nBinsX + nbx;
        for (let p = hash.binStart[bin]; p < hash.binStart[bin + 1]; p++) {
          const j = hash.binAgents[p]; if (j === i) continue;
          const dx = x[j] - xi, dy = y[j] - yi;
          const d2 = dx * dx + dy * dy; if (d2 >= range * range || d2 === 0) continue;
          const d = Math.sqrt(d2), s0 = ri + rad[j];
          if (d < s0) { const f = muR * (d - s0) / d; fx += f * dx; fy += f * dy; }
        }
      }
    }
    if (charge !== 0) {  // LONG-RANGE charge (brute force; the reference uses Barnes-Hut)
      for (let j = 0; j < hw; j++) {
        if (j === i || !alive[j]) continue;
        const dx = x[j] - xi, dy = y[j] - yi;
        const d2 = dx * dx + dy * dy; if (d2 === 0 || d2 > chargeMaxDist * chargeMaxDist) continue;
        const c = charge * (1 / (1 + d2) - minC);
        fx += c * dx; fy += c * dy;
      }
    }
    const base = i * s.maxBonds;
    for (let k = 0; k < s.bondCount[i]; k++) {
      const j = s.bondPartner[base + k]; if (j < 0 || !alive[j]) continue;
      const dx = x[j] - xi, dy = y[j] - yi;
      const d = Math.hypot(dx, dy) || 1e-9;
      const f = lambda * (d - s.bondRestLength[base + k]) / d;
      fx += f * dx; fy += f * dy;
    }
    s.xNext[i] = xi + dtOverEta * fx; s.yNext[i] = yi + dtOverEta * fy;
  }
  for (let i = 0; i < hw; i++) if (alive[i]) { x[i] = s.xNext[i]; y[i] = s.yNext[i]; }
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

// -- grow by triangle splits, relaxing between ------------------------------
function grow({ target, range, rest, charge, chargeMaxDist, ticksPerSplitRound, label }) {
  const rnd = mulberry(99);
  const MAX = target + 16, W = 4000, H = 4000, cx = W / 2, cy = H / 2;
  const cfg = { maxAgents: MAX, maxBonds: 3, worldWidth: W, worldHeight: H, defaultRadius: 0.9,
    bondStiffness: 0.55, repulsionStiffness: 0.9, interactionRange: range, timeStep: 0.12, drag: 1, neighbourQueryRadius: 6 };
  const s = createAgentStore(cfg, [], { wasmBacked: false });
  // K4 seed
  for (let i = 0; i < 4; i++) { s.alive[i] = 1; s.epoch[i] = 1; s.radius[i] = 0.9; s.targetRadius[i] = 0.9;
    s.x[i] = cx + Math.cos(i * Math.PI / 2) * rest; s.y[i] = cy + Math.sin(i * Math.PI / 2) * rest; }
  s.highWater = 4; s.liveCount = 4;
  for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) formBond(s, a, b, rest, 0.55);

  const P = { W, H, dtOverEta: 0.12, muR: 0.9, range, lambda: 0.55, hash: null, charge, chargeMaxDist };
  const alloc = () => { const id = s.highWater++; s.alive[id] = 1; s.epoch[id] = 1; s.radius[id] = 0.9; s.targetRadius[id] = 0.9; s.liveCount++; return id; };

  while (s.liveCount < target) {
    // one split round: split a random subset (an independent set in practice — pick spaced-out ids)
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
    for (let t = 0; t < ticksPerSplitRound; t++) { P.hash = buildSpatialHash(s, Math.max(range, 6), false, W, H, 1); forcePass(s, P); }
  }
  for (let t = 0; t < 300; t++) { P.hash = buildSpatialHash(s, Math.max(range, 6), false, W, H, 1); forcePass(s, P); }
  return { label, N: s.liveCount, ...metrics(s) };
}

const rest = 5, target = 1200;
console.log(`\nProbe: grow K4 -> ${target} nodes by TRIANGLE SPLIT, bond rest ${rest}, real engine force loop.`);
console.log(`  bond     = mean bond length / rest        (healthy ~1)`);
console.log(`  nnb/bond = nearest NON-bonded / bond      (healthy ~1, jammed <<1)`);
console.log(`  overlap% = nodes with a non-bonded neighbour inside contact distance\n`);
console.log('  scenario                                         N     bond   nnb/bond   overlap%');
console.log('  ' + '-'.repeat(78));
const rows = [
  { label: 'SHIPPED: contact-only, 1 tick/round', range: 2.2, charge: 0, chargeMaxDist: 1, ticksPerSplitRound: 1 },
  { label: 'charge -3, cutoff   20 (= 4x rest), 8 ticks', range: 2.2, charge: -3, chargeMaxDist: 20, ticksPerSplitRound: 8 },
  { label: 'charge -3, cutoff   40 (= 8x rest), 8 ticks', range: 2.2, charge: -3, chargeMaxDist: 40, ticksPerSplitRound: 8 },
  { label: 'charge -3, cutoff   80 (=16x rest), 8 ticks', range: 2.2, charge: -3, chargeMaxDist: 80, ticksPerSplitRound: 8 },
  { label: 'charge -3, cutoff  160 (=32x rest), 8 ticks', range: 2.2, charge: -3, chargeMaxDist: 160, ticksPerSplitRound: 8 },
  { label: 'charge -3, cutoff 2000 (effectively inf)   ', range: 2.2, charge: -3, chargeMaxDist: 2000, ticksPerSplitRound: 8 },
];
for (const r of rows) {
  const o = grow({ target, rest, ...r });
  console.log(`  ${o.label.padEnd(46)} ${String(o.N).padStart(5)} ${(o.bond / rest).toFixed(2).padStart(8)} ${o.ratio.toFixed(2).padStart(10)} ${o.overlapPct.toFixed(1).padStart(10)}`);
}
console.log('');
rmSync(entryPath, { force: true }); rmSync(dir, { recursive: true, force: true });

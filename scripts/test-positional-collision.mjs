// Behaviour test for the HARD positional collision (resolvePositionalCollisions):
// it must project an overlapping blob to a NO-OVERLAP configuration (every pair
// separated to at least the contact distance) — the rigid distinction from the
// soft-sphere force, which only ever reduces overlap asymptotically.
//
// Run:  node scripts/test-positional-collision.mjs
import { build } from 'esbuild';
import { writeFileSync, rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os'; import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'pc-'));
const ep = join(ROOT, 'scripts', '__pc_entry.ts');
writeFileSync(ep, `
export { createAgentStore, seedAgents, resolvePositionalCollisions, computeAgentMaxHashBins } from '../src/simulator/engine/agentEngine.ts';
`);
const out = join(dir, 'b.mjs');
await build({ entryPoints: [ep], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error', absWorkingDir: process.cwd() });
const m = await import(pathToFileURL(out).href);
const { createAgentStore, seedAgents, resolvePositionalCollisions, computeAgentMaxHashBins } = m;

let fail = 0, checks = 0;
const R = 0.5, contact = 2 * R; // two default agents just touch at d = 1.0

function minPairDist(s, W, H, D, is3d) {
  let mn = Infinity;
  for (let i = 0; i < s.highWater; i++) for (let j = i + 1; j < s.highWater; j++) {
    let dx = s.x[i] - s.x[j], dy = s.y[i] - s.y[j], dz = is3d ? s.z[i] - s.z[j] : 0;
    if (dx > W / 2) dx -= W; else if (dx < -W / 2) dx += W;
    if (dy > H / 2) dy -= H; else if (dy < -H / 2) dy += H;
    if (is3d) { if (dz > D / 2) dz -= D; else if (dz < -D / 2) dz += D; }
    const d = Math.hypot(dx, dy, dz); if (d < mn) mn = d;
  }
  return mn;
}

function run(is3d, torus) {
  const W = 30, H = 30, D = is3d ? 30 : 1;
  const cfg = { maxAgents: 200, worldWidth: W, worldHeight: H, worldDepth: D, defaultRadius: R };
  const s = createAgentStore(cfg, []); s.worldDepth = D; s.dt = 0.1;
  // seed 48 agents heavily overlapping in a tight blob centred in the world
  let seed = 20240706; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const N = 48, spread = is3d ? 2.5 : 2.0, specs = [];
  for (let i = 0; i < N; i++) specs.push({
    x: W / 2 + (rnd() - 0.5) * spread, y: H / 2 + (rnd() - 0.5) * spread,
    z: is3d ? D / 2 + (rnd() - 0.5) * spread : 0, radius: R,
  });
  seedAgents(s, specs, R);
  const before = minPairDist(s, W, H, D, is3d);
  const binEdge = 5.0, reserve = computeAgentMaxHashBins(W, H, D, 1.5, R, 5.0);
  // 40 "steps" of 3 Jacobi sweeps each — plenty to converge a sparse target.
  for (let step = 0; step < 40; step++) resolvePositionalCollisions(s, 3, binEdge, reserve, W, H, D, is3d, torus);
  const after = minPairDist(s, W, H, D, is3d);
  const label = `${is3d ? '3D' : '2D'} ${torus ? 'torus' : 'bounded'}`;
  checks++;
  // (a) started overlapping; (b) resolved to essentially no overlap (>= 0.95·contact).
  const ok = before < 0.6 * contact && after >= 0.95 * contact;
  if (ok) console.log(`  ✓ ${label}: overlap ${before.toFixed(3)} → separated ${after.toFixed(3)} (contact ${contact}) — no residual overlap`);
  else { console.log(`  ✗ ${label}: before ${before.toFixed(3)} after ${after.toFixed(3)} (want before<${(0.6*contact).toFixed(2)}, after>=${(0.95*contact).toFixed(2)})`); fail++; }
  return { s, W, H, D, is3d };
}

console.log('Positional (hard) collision — resolves overlap to no-overlap:');
run(false, true);
run(false, false);
run(true, true);
run(true, false);

// Control: with ZERO iterations the blob stays overlapping (proves it's the pass,
// not the seed spacing, that separates).
{
  const W = 30, H = 30;
  const cfg = { maxAgents: 200, worldWidth: W, worldHeight: H, worldDepth: 1, defaultRadius: R };
  const s = createAgentStore(cfg, []); s.worldDepth = 1;
  let seed = 20240706; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const specs = []; for (let i = 0; i < 48; i++) specs.push({ x: W / 2 + (rnd() - 0.5) * 2, y: H / 2 + (rnd() - 0.5) * 2, radius: R });
  seedAgents(s, specs, R);
  const before = minPairDist(s, W, H, 1, false);
  const reserve = computeAgentMaxHashBins(W, H, 1, 1.5, R, 5.0);
  resolvePositionalCollisions(s, 0, 5.0, reserve, W, H, 1, false, true); // 0 sweeps = no-op
  const after = minPairDist(s, W, H, 1, false);
  checks++;
  if (before === after && before < 0.6 * contact) console.log(`  ✓ control: 0 iterations is a no-op (still overlapping ${after.toFixed(3)})`);
  else { console.log(`  ✗ control: 0 iterations changed positions (${before.toFixed(3)} → ${after.toFixed(3)})`); fail++; }
}

// WASM-target parity: the WASM agent target runs the SAME JS resolvePositionalCollisions
// over the wasmBacked store's typed-array VIEWS (the projection is CPU on every
// target — only the force pass differs). So a plain store and a wasmBacked store
// with the same seed must project BIT-IDENTICALLY (no separate WASM impl to drift).
{
  const W = 30, H = 30, D = 1;
  const cfg = { maxAgents: 200, worldWidth: W, worldHeight: H, worldDepth: D, defaultRadius: R };
  const reserve = computeAgentMaxHashBins(W, H, D, 1.5, R, 5.0);
  const mkSeeded = (wasmBacked) => {
    const s = wasmBacked
      ? createAgentStore(cfg, [], { wasmBacked: true, maxHashBins: reserve })
      : createAgentStore(cfg, []);
    s.worldDepth = D; s.dt = 0.1;
    let seed = 555777; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const specs = []; for (let i = 0; i < 48; i++) specs.push({ x: W / 2 + (rnd() - 0.5) * 2.2, y: H / 2 + (rnd() - 0.5) * 2.2, radius: R });
    seedAgents(s, specs, R);
    return s;
  };
  const sJS = mkSeeded(false), sW = mkSeeded(true);
  let mism = 0;
  for (let step = 0; step < 30; step++) {
    resolvePositionalCollisions(sJS, 3, 5.0, reserve, W, H, D, false, true);
    resolvePositionalCollisions(sW, 3, 5.0, reserve, W, H, D, false, true);
    for (let i = 0; i < sJS.highWater; i++) if (sJS.x[i] !== sW.x[i] || sJS.y[i] !== sW.y[i]) mism++;
  }
  checks++;
  if (mism === 0) console.log(`  ✓ WASM-target parity: plain store ↔ wasmBacked store bit-identical (0 mismatches, 30 steps)`);
  else { console.log(`  ✗ WASM-target parity: ${mism} mismatches`); fail++; }
}

console.log(`\n${fail === 0 ? 'POSITIONAL COLLISION ✓' : `${fail} FAILED ✗`}  (${checks} checks)`);
rmSync(ep, { force: true }); rmSync(dir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);

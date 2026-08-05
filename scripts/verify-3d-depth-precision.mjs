// 3D depth-precision harness — the bond-vs-agent occlusion contract.
//
// THE BUG THIS PINS (user-reported, 2026-08)
//   "In 3D, bonds (edges), when zoomed out, end up being drawn in front of all
//    agents ... extremely hard to visualize when the model has many bonds."
//
//   A bond is a LINE between two agent CENTRES; an agent is a sphere impostor whose
//   FS writes its FRONT SURFACE depth. Bonds draw FIRST, so the only margin a sphere
//   has to cover a bond is its own `radius`. A perspective depth buffer's WORLD-space
//   resolution is
//                       dz ~= z^2 / (near * 2^bits)
//   so with the old FIXED near = 0.05 the quantum grew with the SQUARE of the camera
//   distance. On a large world it overtook the agent radius almost immediately — a
//   600-unit Graph-Rewriting world with 0.7-unit nodes hit a 1.55-unit quantum at the
//   DEFAULT dist 1.9 — and the sphere's front surface then quantized into the SAME
//   24-bit bucket as the bond, so GL_LESS REJECTED the sphere and the bond mesh
//   punched through every node. Measured through the real WebGL renderer at dist 1.9:
//   83% of the node ink lost to bonds; 96% at dist 5.
//
//   There is no error, no warning and no wrong-looking buffer — it is only pixels.
//   Hence this harness is COMPUTED from the shipped projection, not structural.
//
// THE TWO ASSERTIONS
//   1. OCCLUSION MARGIN — at every zoom, the depth quantum must be a small fraction
//      of the agent radius, so a sphere front surface is many buckets nearer than the
//      bond ending at its centre. (The old fixed near fails this badly.)
//   2. WEBGPU CLIP SAFETY — the worker's WGSL passes feed this SAME GL-convention
//      matrix into WebGPU, whose clip volume keeps only z_clip in [0, w]: everything
//      closer than the z_ndc = 0 plane at 2*f*n/(f+n) is DISCARDED. That plane must
//      stay strictly in front of the nearest thing we draw, with margin — otherwise
//      raising `near` would silently clip geometry in free mode.
//
// Run from the repo root:  node scripts/verify-3d-depth-precision.mjs
//                          node scripts/verify-3d-depth-precision.mjs --old   (negative control)
import { build } from 'esbuild';
import { writeFileSync, mkdtempSync, rmSync, readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OLD = process.argv.includes('--old');   // negative control: the pre-fix fixed near

const ENTRY = `
export { sceneNearPlane, MIN_NEAR_PLANE, MIN_CAM_DIST, MAX_CAM_DIST } from '../src/simulator/render/gl3d.ts';
`;
const entryPath = join(ROOT, 'scripts', '__depth_entry.ts');
const dir = mkdtempSync(join(tmpdir(), 'gca-depth-'));
writeFileSync(entryPath, ENTRY);
const outPath = join(dir, 'bundle.mjs');
await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: process.cwd() });
const M = await import(pathToFileURL(outPath).href);
rmSync(entryPath, { force: true });

let pass = 0, fail = 0;
const ok = (cond, what, detail = '') => {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL  ${what}${detail ? `\n        ${detail}` : ''}`); }
};
const section = (s) => console.log(`\n-- ${s}`);

const DEPTH_BITS = 24;
const LEVELS = Math.pow(2, DEPTH_BITS) - 1;

/** Mirrors sceneCameraMatrices' far plane. */
const farOf = (r) => r * 8 + 100;
const nearOf = (r, W, H, D, t, fwd) => (OLD ? 0.05 : M.sceneNearPlane(r, W, H, D, t, fwd));

/** World-space depth resolution at eye distance z for a GL perspective [n, f].
 *  dz = dz_ndc * (f-n) z^2 / (2 f n), and one 24-bit step spans dz_ndc = 2/LEVELS. */
const quantum = (z, n, f) => ((f - n) * z * z) / (LEVELS * f * n);
/** Eye distance of the z_ndc = 0 plane — WebGPU's effective near clip for this matrix. */
const webgpuClipZ = (n, f) => (2 * f * n) / (f + n);
/** How far the scene reaches toward the camera (mirrors sceneReachTowardCamera). */
const reach = (W, H, D, t, fwd) =>
  0.5 * (W * Math.abs(fwd[0]) + H * Math.abs(fwd[1]) + D * Math.abs(fwd[2]))
  + (1.2 + Math.max(W, H, D) * 0.02) + Math.hypot(t[0], t[1], t[2]);

// The shipped camera range, plus the defaults the two 3D samples open at.
const DISTS = [M.MIN_CAM_DIST, 0.5, 0.8, 1.0, 1.9, 3, 5, 8, 12, 20, M.MAX_CAM_DIST];
// A panned target is the worst case for BOTH assertions (it grows the reach, shrinking
// the clearance the near plane is derived from). Two view axes: down an axis (the
// tightest support) and corner-on (the loosest — equals the half-diagonal).
const TARGETS = [[0, 0, 0], [40, -30, 20]];
const FWDS = [[0, 0, -1], [-0.577, -0.577, -0.577], [-0.7, -0.7, 0]];

/** One (model, dist, target, forward) case. */
function check(label, W, H, D, radius, dist, t, fwd) {
  const r = dist * Math.max(W, H, D);
  const n = nearOf(r, W, H, D, t, fwd), f = farOf(r);
  // Worst realistic eye distance for an agent: the far side of the population, i.e.
  // roughly the target distance (a nearer agent has a FINER quantum).
  return {
    label, dist, r, near: n, quantum: quantum(r, n, f), ratio: radius / quantum(r, n, f),
    clipZ: webgpuClipZ(n, f), nearestGeom: r - reach(W, H, D, t, fwd),
  };
}

// ─────────────────────────────────────────── assertion 1: occlusion margin
// A sphere must be at least this many depth buckets in front of the bond that ends
// at its centre. 8 leaves room for the float32 rounding in the FS's gl_FragDepth
// (~1 bucket near the far end of the range) plus the cos falloff over the disc.
//
// SCOPED TO THE ZOOMED-OUT REGIME (the camera outside the scene's reach), which is
// what the report is about and what the adaptive near plane can address. Inside the
// scene there is no clearance to scale — geometry may sit ON the camera — so the near
// plane floors and the quantum is whatever a single-pass z-buffer can give over that
// range; that is also the regime users report already looks right. Assertion 3 below
// pins that the fix is never WORSE than the old projection anywhere.
const MIN_BUCKETS = 8;

section(`occlusion margin (camera outside the scene) — radius must span >= ${MIN_BUCKETS} depth buckets${OLD ? '   [--old: PRE-FIX fixed near=0.05]' : ''}`);
// Every shipped 3D model, plus the Graph-Rewriting shape the bug was reported on
// (big world, small nodes) and a small world (where the old code was already fine).
const CASES = [
  { label: 'Morphogenesis - 3D Tissue', W: 200, H: 200, D: 200, radius: 1.6 },
  { label: 'Particle Life 3D', W: 160, H: 110, D: 70, radius: 1.2 },
  { label: 'Life3D (voxels, cell size 1)', W: 24, H: 24, D: 24, radius: 0.5 },
  { label: 'Accretor 300^3', W: 300, H: 300, D: 300, radius: 0.5 },
  { label: 'GRA-shaped: 600^3 world, 0.35 nodes', W: 600, H: 600, D: 600, radius: 0.35 },
  { label: 'GRA-shaped: 30000^3 world, 4.5 nodes', W: 30000, H: 30000, D: 30000, radius: 4.5 },
];
for (const c of CASES) {
  let worst = null, n = 0;
  for (const t of TARGETS) for (const fwd of FWDS) for (const dist of DISTS) {
    const row = check(c.label, c.W, c.H, c.D, c.radius, dist, t, fwd);
    if (row.nearestGeom <= 0) continue;              // camera inside the scene — see assertion 3
    n++;
    if (!worst || row.ratio < worst.ratio) worst = row;
  }
  if (!worst) { ok(true, `${c.label}: camera never leaves the scene reach at any shipped dist`); continue; }
  ok(worst.ratio >= MIN_BUCKETS,
     `${c.label}: worst of ${n} zoomed-out cases = ${worst.ratio.toFixed(0)} buckets`,
     `worst at dist ${worst.dist}: near=${worst.near.toFixed(3)} quantum=${worst.quantum.toExponential(2)} radius=${c.radius}`);
}

// ─────────────────────────────────────────── assertion 2: WebGPU clip safety
section('WebGPU clip safety — the z_ndc = 0 plane must stay in front of all geometry');
const MIN_CLIP_MARGIN = 1.8;   // nearestGeom / clipZ; the 0.25 factor targets ~2.0
for (const c of CASES) {
  let worst = null;
  for (const t of TARGETS) for (const fwd of FWDS) for (const dist of DISTS) {
    const row = check(c.label, c.W, c.H, c.D, c.radius, dist, t, fwd);
    if (row.nearestGeom <= 0) continue;              // camera inside the scene: near is floored, nothing to prove
    const margin = row.nearestGeom / row.clipZ;
    if (!worst || margin < worst.margin) worst = { ...row, margin };
  }
  if (!worst) { ok(true, `${c.label}: camera never leaves the scene reach at any shipped dist`); continue; }
  ok(worst.margin >= MIN_CLIP_MARGIN,
     `${c.label}: nearest geometry is ${worst.margin.toFixed(2)}x beyond the WebGPU clip plane`,
     `worst at dist ${worst.dist}: clipZ=${worst.clipZ.toFixed(2)} nearestGeom=${worst.nearestGeom.toFixed(2)}`);
}

// ─────────────────────────────────────────── assertion 3: never worse than pre-fix
section('the adaptive near plane is NEVER worse than the old fixed 0.05');
{
  let worse = 0, better = 0, same = 0;
  for (const c of CASES) for (const t of TARGETS) for (const fwd of FWDS) for (const dist of DISTS) {
    const r = dist * Math.max(c.W, c.H, c.D);
    const n = M.sceneNearPlane(r, c.W, c.H, c.D, t, fwd);
    if (n < 0.05 - 1e-12) worse++; else if (n > 0.05 + 1e-12) better++; else same++;
  }
  ok(worse === 0, `no case regresses the near plane (${better} improved, ${same} identical, ${worse} worse)`);
  ok(better > 0, 'the fix actually engages on the shipped camera range');
}

// ─────────────────────────────────────────── the resolver's own contract
section('sceneNearPlane contract');
const AX = [0, 0, -1];
ok(M.MIN_NEAR_PLANE === 0.05, 'MIN_NEAR_PLANE is the historical 0.05');
ok(M.sceneNearPlane(1, 200, 200, 200, [0, 0, 0], AX) === M.MIN_NEAR_PLANE,
   'camera INSIDE the scene reach falls back to the historical fixed near (identical to pre-fix)');
ok(M.sceneNearPlane(1e9, 200, 200, 200, [0, 0, 0], AX) > M.MIN_NEAR_PLANE,
   'camera far outside the scene reach scales the near plane up');
{
  let mono = true, bounded = true, prev = -1;
  for (let r = 1; r < 1e7; r *= 1.3) {
    const n = M.sceneNearPlane(r, 600, 600, 600, [0, 0, 0], AX);
    if (n < prev) mono = false;
    const clearance = r - reach(600, 600, 600, [0, 0, 0], AX);
    if (clearance > 0 && n > clearance * 0.25 + 1e-9) bounded = false;
    prev = n;
  }
  ok(mono, 'near is monotone non-decreasing in the camera distance');
  ok(bounded, 'near never exceeds a quarter of the clearance to the nearest geometry');
}
ok(M.sceneNearPlane(5000, 600, 600, 600, [0, 0, 0], AX) > M.sceneNearPlane(5000, 600, 600, 600, [900, 0, 0], AX),
   'panning the target away from the volume SHRINKS the near plane (bigger reach)');
ok(M.sceneNearPlane(5000, 600, 600, 600, [0, 0, 0], AX) > M.sceneNearPlane(5000, 600, 600, 600, [0, 0, 0], [-0.577, -0.577, -0.577]),
   'a corner-on view reaches further than an axis view, so it gets a smaller near plane');

// ─────────────────────────────────────────── the shipped 3D models actually parse
section('shipped 3D models are covered by the CASES table above');
const modelsDir = join(ROOT, 'public', 'models');
const shipped3d = [];
for (const f of readdirSync(modelsDir)) {
  if (!f.endsWith('.gcaproj')) continue;
  let j; try { j = JSON.parse(readFileSync(join(modelsDir, f), 'utf8')); } catch { continue; }
  const p = j.properties || {};
  if (p.dimension === '3d' && (p.gridDepth || 1) > 1) shipped3d.push({ f, W: p.gridWidth, H: p.gridHeight, D: p.gridDepth });
}
for (const m of shipped3d) {
  const covered = CASES.some((c) => c.W === m.W && c.H === m.H && c.D === m.D);
  ok(covered, `${m.f} (${m.W}x${m.H}x${m.D}) has a CASES entry`);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} passed, ${fail} failed${OLD ? '   (--old is the NEGATIVE CONTROL: it is EXPECTED to fail assertion 1)' : ''}`);
rmSync(dir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);

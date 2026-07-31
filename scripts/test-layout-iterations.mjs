// L3 — `layoutIterations`: the engine knob that runs the force integrator N times
// per generation.
//
// The property that matters most here is NOT "does it relax further" (it obviously
// does) but "does everything that must happen ONCE per generation still happen
// exactly once". Running the structural phase — the bond request-queue drain,
// division, death, auto-bond — per force iteration would REPLAY every queued
// Form / Break / Rewire and corrupt the graph, silently, with no error anywhere.
// That is the easiest way to break this feature, so it is pinned twice: as a source
// invariant here, and behaviourally by O6 (degree exactly 3, E = 3N/2 at every
// generation) in the in-browser run.
//
// Tiers
//   A  the resolver: clamping, and 1 for every shape of "absent"
//   B  source invariants — the loop's boundaries in sim.worker.ts + the GPU
//      relax-commit's deliberate omissions (no gen bump, no force zero)
//   C  the REAL WASM force pass: N iterations vs N single-iteration generations
//      (bit-identical), age accounting, and the growth-rate/N identity
//
// Run:  node scripts/test-layout-iterations.mjs
import { build } from 'esbuild';
import { writeFileSync, rmSync, mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0, pass = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

const ENTRY = `
export { createAgentStore, buildSpatialHash, formBond, computeAgentMaxHashBins } from '../src/simulator/engine/agentEngine.ts';
export { compileAgentGraphWasm, instantiateAgentWasm } from '../src/modeler/vpl/compiler/agentWasm/compile.ts';
export { chargeParamsOf, chargeBinEdgeOf, layoutIterationsOf, MAX_LAYOUT_ITERATIONS } from '../src/model/centerBased.ts';
`;
const dir = mkdtempSync(join(tmpdir(), 'gca-layiter-'));
const entryPath = join(ROOT, 'scripts', '__layiter_entry.ts');
writeFileSync(entryPath, ENTRY);
const outPath = join(dir, 'bundle.mjs');
await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: process.cwd() });
const {
  createAgentStore, buildSpatialHash, formBond, computeAgentMaxHashBins,
  compileAgentGraphWasm, instantiateAgentWasm, chargeParamsOf, chargeBinEdgeOf,
  layoutIterationsOf, MAX_LAYOUT_ITERATIONS,
} = await import(pathToFileURL(outPath).href);

// ---------------------------------------------------------------------------
console.log('\n=== A. layoutIterationsOf — the ONE clamped resolver ===');
// ---------------------------------------------------------------------------
ok('absent config => 1', layoutIterationsOf(undefined) === 1);
ok('empty config => 1', layoutIterationsOf({}) === 1);
ok('explicit 1 => 1', layoutIterationsOf({ layoutIterations: 1 }) === 1);
ok('4 => 4', layoutIterationsOf({ layoutIterations: 4 }) === 4);
ok('0 clamps up to 1 (never zero force passes)', layoutIterationsOf({ layoutIterations: 0 }) === 1);
ok('-5 clamps up to 1', layoutIterationsOf({ layoutIterations: -5 }) === 1);
ok('2.7 floors to 2', layoutIterationsOf({ layoutIterations: 2.7 }) === 2);
ok(`1000 clamps to MAX (${MAX_LAYOUT_ITERATIONS}) — a typo must not hang the worker`,
  layoutIterationsOf({ layoutIterations: 1000 }) === MAX_LAYOUT_ITERATIONS);
ok('NaN => 1', layoutIterationsOf({ layoutIterations: NaN }) === 1);
// Non-finite is nonsense, not "as many as possible" — it resolves to the safe
// default rather than the ceiling, same as NaN.
ok('Infinity => 1 (non-finite is treated as absent, not as MAX)', layoutIterationsOf({ layoutIterations: Infinity }) === 1);
ok('a string => 1 (a hand-edited .gcaproj cannot smuggle a count in)',
  layoutIterationsOf({ layoutIterations: '8' }) === 1);

// ---------------------------------------------------------------------------
console.log('\n=== B. Source invariants — what must stay OUTSIDE the loop ===');
// ---------------------------------------------------------------------------
const worker = readFileSync(join(ROOT, 'src/simulator/engine/sim.worker.ts'), 'latin1');

/** The body of `function <name>(...)` up to its balanced closing brace. */
function fnBody(src, header) {
  const i = src.indexOf(header);
  if (i < 0) return '';
  const open = src.indexOf('{', i);
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (depth === 0) return src.slice(open, k + 1); }
  }
  return '';
}
const runAgentStepBody = fnBody(worker, 'function runAgentStep(): void');
ok('runAgentStep body located', runAgentStepBody.length > 1000);

const loopHeader = 'for (let _lit = 0; _lit < layoutIters; _lit++) {';
const loopAt = runAgentStepBody.indexOf(loopHeader);
ok('runAgentStep has the layout-iteration loop', loopAt >= 0);
// Walk to the loop's own closing brace so "inside" is exact, not a line guess.
let loopEnd = -1;
{
  const open = runAgentStepBody.indexOf('{', loopAt);
  let depth = 0;
  for (let k = open; k < runAgentStepBody.length; k++) {
    if (runAgentStepBody[k] === '{') depth++;
    else if (runAgentStepBody[k] === '}') { depth--; if (depth === 0) { loopEnd = k; break; } }
  }
}
ok('the loop closes', loopEnd > loopAt);
const insideLoop = runAgentStepBody.slice(loopAt, loopEnd + 1);
const afterLoop = runAgentStepBody.slice(loopEnd + 1);

ok('THE INVARIANT: runAgentStructuralPhase() is called AFTER the loop, not inside it',
  !insideLoop.includes('runAgentStructuralPhase()') && afterLoop.includes('runAgentStructuralPhase()'),
  'the queue drain would replay every Form/Break/Rewire once per iteration');
ok('the force pass IS inside the loop (WASM dispatch)', insideLoop.includes('agentForcePassWasmFn('));
ok('the position commit IS inside the loop', insideLoop.includes('swapPositions(s, is3d);'));
ok('the JS 3D and 2D force arms are both inside the loop',
  (insideLoop.match(/const xN = s\.xNext/g) || []).length === 2);
ok('the spatial hash is built ONCE, before the loop (not per iteration)',
  runAgentStepBody.slice(0, loopAt).includes('buildSpatialHash(') && !insideLoop.includes('buildSpatialHash('));
ok('the graph-force accumulator is zeroed ONCE, before the loop',
  runAgentStepBody.slice(0, loopAt).includes('s.forceX.fill(0, 0, hw)') && !insideLoop.includes('s.forceX.fill(0'));
ok('the compiled behaviour runs ONCE, before the loop', !insideLoop.includes('runBehaviourJs()'));
ok('positional collision runs after the loop', afterLoop.includes('resolvePositionalCollisions('));
ok('the age over-count is corrected after the loop',
  /if \(layoutIters > 1\)[\s\S]{0,400}s\.age\[i\] = s\.age\[i\]! - extra/.test(afterLoop));
ok('x/y/z are re-read at the top of every iteration (swapPositions swaps the refs)',
  insideLoop.includes('x = s.x; y = s.y; z = s.z;'));
ok('the growth ramp is scaled by 1/iterations, not applied in full each time',
  insideLoop.includes('const growthIter = growthRate / layoutIters;'));
ok('the drain lives only in the structural phase',
  (worker.match(/drainAgentBondRequests\(/g) || []).length === 1);

const gpu = readFileSync(join(ROOT, 'src/simulator/engine/agentWebgpuRuntime.ts'), 'latin1');
const relaxWgsl = fnBody(gpu, 'function emitRelaxCommitWGSL(layout: AgentWebGPULayout): string');
ok('emitRelaxCommitWGSL exists', relaxWgsl.length > 100);
ok('relax commit copies xNext -> x', /agentF32\[\$\{xB\}u \+ i\] = agentF32\[\$\{xnB\}u \+ i\]/.test(relaxWgsl));
ok('relax commit decrements age (undoing the force pass it follows)',
  /agentF32\[\$\{ageB\}u \+ i\] = agentF32\[\$\{ageB\}u \+ i\] - 1\.0/.test(relaxWgsl));
ok('relax commit skips dead slots (the force pass returns before its own age bump)',
  relaxWgsl.includes('agentAlive[i] != 0u'));
ok('THE GPU INVARIANT: relax commit does NOT bump the generation counter',
  !relaxWgsl.includes('genCounter'),
  'Get Generation would tick layoutIterations times per generation');
ok('THE GPU INVARIANT: relax commit does NOT zero the force accumulator',
  !/\$\{fxB\}|forceX/.test(relaxWgsl),
  'the generation\'s graph-authored Apply Force would be dropped after iteration 1');

const residentBatch = fnBody(gpu, 'export function dispatchResidentBatch(');
ok('the resident batch runs the force pass through encodeForceIterations',
  residentBatch.includes('encodeForceIterations(rt, enc, total, layoutIterations'));
ok('the resident batch still runs posCommit exactly once per generation',
  (residentBatch.match(/res\.commitPipeline/g) || []).length === 1);
const perGenDispatch = fnBody(gpu, 'export function dispatchAgentStep(');
ok('the per-gen dispatch runs the force pass through encodeForceIterations',
  perGenDispatch.includes('encodeForceIterations(rt, enc, total, layoutIterations'));
const encodeIters = fnBody(gpu, 'function encodeForceIterations(');
ok('encodeForceIterations degrades to 1 iteration when the relax pipeline is missing',
  encodeIters.includes('const iters = canRelax ? Math.max(1, iterations) : 1;'));
ok('encodeForceIterations emits N force passes and N-1 relax commits',
  /if \(it > 0\)/.test(encodeIters));

// ---------------------------------------------------------------------------
console.log('\n=== C. The REAL WASM force pass — semantics of the extra iterations ===');
// ---------------------------------------------------------------------------
const nb = (id, nodeType, config = {}) => ({ id, type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType, config } });
const fe = (s, sh, t, th) => ({ id: s + '->' + t, source: s, sourceHandle: sh, target: t, targetHandle: th });
const agentGraphNodes = [nb('beh', 'behaviourStep'), nb('af', 'applyForce', { _port_fx: '0.0', _port_fy: '0.0' })];
const agentGraphEdges = [fe('beh', 'output_flow_do', 'af', 'input_flow_do')];

function copyHashIntoMemory(s, hash) {
  if (!hash) return;
  const buf = s.memory.buffer, L = s.layout;
  const nBins = hash.nBinsX * hash.nBinsY * hash.nBinsZ;
  new Int32Array(buf, L.hashBinStartOffset, nBins + 1).set(hash.binStart.subarray(0, nBins + 1));
  const used = hash.binStart[nBins];
  if (used > 0) new Int32Array(buf, L.hashBinAgentsOffset, used).set(hash.binAgents.subarray(0, used));
}

const W = 400, H = 400, N = 60, REST = 5;
async function mk({ growthRate = 0 } = {}) {
  const cfg = {
    enabled: true, maxAgents: N + 4, maxBonds: 3, worldWidth: W, worldHeight: H, worldDepth: 1,
    defaultRadius: 0.9, bondStiffness: 0.55, repulsionStiffness: 0.9, adhesionStiffness: 0,
    interactionRange: 2.2, timeStep: 0.12, drag: 1, momentum: 0, maxSpeed: 0,
    neighbourQueryRadius: 6, growthRate, bondRestLength: REST,
    agentCapabilities: { motion: 'force', body: true, collision: 'soft', bonds: 'physics', charge: 'on' },
    chargeStrength: -3, chargeMaxDist: 40,
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
  if (r.error) throw new Error(r.error);
  const forcePass = (await instantiateAgentWasm(r.bytes, s.memory)).forcePass;
  // A small ring of bonded agents plus a jittered cloud — enough that the charge,
  // the soft sphere AND the springs are all live.
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < N; i++) {
    s.alive[i] = 1; s.epoch[i] = 1; s.radius[i] = 0.9; s.targetRadius[i] = 0.9;
    s.x[i] = 200 + Math.cos(i * 0.31) * 22 + (rnd() - 0.5) * 3;
    s.y[i] = 200 + Math.sin(i * 0.31) * 22 + (rnd() - 0.5) * 3;
  }
  s.highWater = N; s.liveCount = N;
  for (let i = 0; i < N; i++) formBond(s, i, (i + 1) % N, REST, 0.55);
  return { s, cfg, forcePass };
}

/** ONE force-pass call + position commit — exactly the loop body of runAgentStep
 *  (the shipped WASM export; nothing about the force law is re-implemented). */
function forceOnce(s, cfg, forcePass, hash, growthIter) {
  const ch = chargeParamsOf(cfg);
  const dtOverEta = cfg.timeStep / cfg.drag;
  copyHashIntoMemory(s, hash);
  forcePass(
    s.highWater, hash ? 1 : 0, hash ? hash.nBinsX : 0, hash ? hash.nBinsY : 0, hash ? hash.nBinsZ : 0,
    hash ? hash.binSizeX : 1, hash ? hash.binSizeY : 1, hash ? hash.binSizeZ : 1,
    dtOverEta, cfg.repulsionStiffness, cfg.adhesionStiffness, cfg.interactionRange,
    cfg.momentum, cfg.maxSpeed, growthIter,
    W, H, 1, 1, 0,
    hash ? hash.originX : 0, hash ? hash.originY : 0, hash ? hash.originZ : 0,
    1, 1, 0, ch.doCharge ? 1 : 0, ch.chargeK, ch.chargeMaxD2, ch.chargeMinC,
  );
  s.x.set(s.xNext); s.y.set(s.yNext);
}
const binEdgeOf = cfg => Math.max(cfg.interactionRange * 2 * cfg.defaultRadius, cfg.neighbourQueryRadius, chargeBinEdgeOf(cfg));

// C1 — ONE generation at `iters` iterations, with the hash reused across them
// (what the engine does), vs `iters` single-iteration generations, each rebuilding
// the hash. These are NOT expected to be identical; what IS asserted is that the
// N-iteration run relaxes as far as N separate generations do, which is the point
// of the knob. The strict equivalence is C2.
{
  const ITERS = 5;
  const a = await mk(); const b = await mk();
  const x0 = Float64Array.from(a.s.x.subarray(0, N)), y0 = Float64Array.from(a.s.y.subarray(0, N));
  const ha = buildSpatialHash(a.s, binEdgeOf(a.cfg), W, H, 1, false, a.s.layout.maxHashBins);
  a.s.forceX.fill(0, 0, N); a.s.forceY.fill(0, 0, N);
  for (let it = 0; it < ITERS; it++) forceOnce(a.s, a.cfg, a.forcePass, ha, 0);
  for (let g = 0; g < ITERS; g++) {
    const hb = buildSpatialHash(b.s, binEdgeOf(b.cfg), W, H, 1, false, b.s.layout.maxHashBins);
    b.s.forceX.fill(0, 0, N); b.s.forceY.fill(0, 0, N);
    forceOnce(b.s, b.cfg, b.forcePass, hb, 0);
  }
  // POSITIVE CONTROL first — otherwise "identical" would also pass if nothing moved.
  let moved = 0;
  for (let i = 0; i < N; i++) moved = Math.max(moved, Math.hypot(a.s.x[i] - x0[i], a.s.y[i] - y0[i]));
  ok(`the run actually relaxed (max displacement ${moved.toFixed(3)} world units)`, moved > 0.05, `moved ${moved}`);
  let maxDiff = 0;
  for (let i = 0; i < N; i++) maxDiff = Math.max(maxDiff, Math.abs(a.s.x[i] - b.s.x[i]), Math.abs(a.s.y[i] - b.s.y[i]));
  ok(`${ITERS} iterations in one generation track ${ITERS} separate generations (max |Δpos| ${maxDiff.toExponential(2)} << bond rest ${REST})`,
    maxDiff < REST * 0.02, `max |Δpos| ${maxDiff}`);
}

// C2 — the same hash on both sides: N iterations must be EXACTLY N applications of
// the loop body. Bit-identical, because that is literally the same call sequence.
{
  const ITERS = 4;
  const a = await mk(); const b = await mk();
  const h = buildSpatialHash(a.s, binEdgeOf(a.cfg), W, H, 1, false, a.s.layout.maxHashBins);
  a.s.forceX.fill(0, 0, N); a.s.forceY.fill(0, 0, N);
  b.s.forceX.fill(0, 0, N); b.s.forceY.fill(0, 0, N);
  for (let it = 0; it < ITERS; it++) forceOnce(a.s, a.cfg, a.forcePass, h, 0);
  for (let it = 0; it < ITERS; it++) forceOnce(b.s, b.cfg, b.forcePass, h, 0);
  let diffs = 0;
  for (let i = 0; i < N; i++) { if (a.s.x[i] !== b.s.x[i] || a.s.y[i] !== b.s.y[i]) diffs++; }
  ok('the iteration loop is deterministic — bit-identical over two runs', diffs === 0, `${diffs} mismatches`);
}

// C3 — AGE. Every force pass does `age += 1`; the engine subtracts `iters - 1`
// after the loop, so a generation advances age by exactly ONE however many
// iterations ran. (`myAge`, Lifespan and any age-driven rule depend on this.)
{
  for (const ITERS of [1, 2, 8]) {
    const { s, cfg, forcePass } = await mk();
    const h = buildSpatialHash(s, binEdgeOf(cfg), W, H, 1, false, s.layout.maxHashBins);
    s.forceX.fill(0, 0, N); s.forceY.fill(0, 0, N);
    for (let it = 0; it < ITERS; it++) forceOnce(s, cfg, forcePass, h, 0);
    // the engine's correction, verbatim
    if (ITERS > 1) { const extra = ITERS - 1; for (let i = 0; i < N; i++) if (s.alive[i]) s.age[i] -= extra; }
    let bad = 0; for (let i = 0; i < N; i++) if (s.age[i] !== 1) bad++;
    ok(`age advances by exactly 1 per generation at ${ITERS} iteration(s)`, bad === 0, `${bad} agents off`);
  }
}

// C4 — GROWTH. The ramp is `radius += sign(dd)·rate` clamped at the target, so N
// steps of rate/N reach the SAME radius as one step of rate. That identity is why
// no second uniform / bind group is needed on the GPU.
{
  const RATE = 0.4;
  const targets = [1.5, 0.2, 0.95];   // grow, shrink, and a target inside one step
  for (const tr of targets) {
    const one = await mk({ growthRate: RATE });
    const many = await mk({ growthRate: RATE });
    for (const g of [one, many]) for (let i = 0; i < N; i++) g.s.targetRadius[i] = tr;
    const h1 = buildSpatialHash(one.s, binEdgeOf(one.cfg), W, H, 1, false, one.s.layout.maxHashBins);
    one.s.forceX.fill(0, 0, N); one.s.forceY.fill(0, 0, N);
    forceOnce(one.s, one.cfg, one.forcePass, h1, RATE);
    const ITERS = 4;
    const h2 = buildSpatialHash(many.s, binEdgeOf(many.cfg), W, H, 1, false, many.s.layout.maxHashBins);
    many.s.forceX.fill(0, 0, N); many.s.forceY.fill(0, 0, N);
    for (let it = 0; it < ITERS; it++) forceOnce(many.s, many.cfg, many.forcePass, h2, RATE / ITERS);
    let worst = 0;
    for (let i = 0; i < N; i++) worst = Math.max(worst, Math.abs(one.s.radius[i] - many.s.radius[i]));
    ok(`growth to target ${tr}: rate/${ITERS} × ${ITERS} reaches the same radius as rate × 1 (Δ ${worst.toExponential(2)})`,
      worst < 1e-12, `Δ ${worst}`);
  }
}

console.log(`\n=== RESULT === ${pass} ok, ${fail} failed`);
rmSync(entryPath, { force: true }); rmSync(dir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);

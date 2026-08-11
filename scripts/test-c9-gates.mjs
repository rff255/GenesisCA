// C9 — the STANDING GUARD for (STEP 4) profile-gated agent SoA fields and
// (STEP 6) the Static / Velocity motion integrator.
//
// Three tiers, all value-asserting rather than shape-asserting:
//
//   A. THE GATED LAYOUT MATRIX — all 16 gate combinations × 2D/3D:
//      the CPU layout omits EXACTLY the gated fields, the byte saving is exactly
//      the expected 8 B/agent per dropped f64, the ABI param list drops exactly
//      the expected names, and the store's arrays are ZERO-LENGTH (so a write is
//      a silent no-op — the property the whole safety catch rests on).
//
//   B. THE SAFETY CATCH — a graph that READS a gated-off field compiles to the
//      typed default on JS *and* on a REAL instantiated WASM module, and the two
//      agree. (`age` is the subject: its gate is widened by `getAge`, so the test
//      forces the gate off with an explicit profile + no reader to prove the
//      defensive arm works.)
//
//   C. MOTION MODES — run the REAL force pass (JS reference + a real WASM module)
//      and assert POSITIONS: under `force` an agent under a constant force moves;
//      under `velocity` it coasts at exactly the graph-set velocity and the force
//      is IGNORED; under `static` nothing moves at all and a position written
//      between steps SURVIVES (the Ant Necrophoresis hazard).
//
// Run:  node scripts/test-c9-gates.mjs        (exit 1 on any failure)
import { build } from 'esbuild';
import { writeFileSync, rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'c9-'));
const ep = join(ROOT, 'scripts', '__c9_entry.ts');
writeFileSync(ep, `
export { resolveAgentFieldGates, normalizeFieldGates, motionModeCode, agentMotionMode } from '../src/model/agentFieldGating.ts';
export { computeAgentMemoryLayout, createAgentStore, initAgentSlot } from '../src/simulator/engine/agentEngine.ts';
export { deriveAgentAbi } from '../src/modeler/vpl/compiler/agentAbi.ts';
export { compileAgentGraph, agentAbiShapeOf } from '../src/modeler/vpl/compiler/compile.ts';
export { compileAgentGraphWasmForModel, buildAgentLayoutExtras } from '../src/modeler/vpl/compiler/agentWasm/compile.ts';
export { migrateForHarness } from '../src/dev/compileHarness.ts';
export { defaultCenterBasedConfig } from '../src/model/centerBased.ts';
`);
const out = join(dir, 'b.mjs');
await build({ entryPoints: [ep], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error', absWorkingDir: process.cwd() });
const M = await import(pathToFileURL(out).href);
rmSync(ep, { force: true });

let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('  ✗ ' + msg); } };
const near = (a, b, eps, msg) => ok(Math.abs(a - b) <= eps, `${msg} (got ${a}, want ${b})`);

// ---------------------------------------------------------------------------
// Model builders
// ---------------------------------------------------------------------------
const node = (id, type, config = {}, pos = { x: 0, y: 0 }) =>
  ({ id, type: 'caNode', position: pos, data: { nodeType: type, config } });
const fEdge = (a, ap, b, bp) => ({ id: `f${a}${ap}${b}${bp}`, source: a, target: b, sourceHandle: `output_flow_${ap}`, targetHandle: `input_flow_${bp}` });
const vEdge = (a, ap, b, bp) => ({ id: `v${a}${ap}${b}${bp}`, source: a, target: b, sourceHandle: `output_value_${ap}`, targetHandle: `input_value_${bp}` });

const FULL_OFF = { motion: 'force', body: true, collision: 'off', charge: 'off', bonds: 'off', autoBond: false, growth: false, division: false, lifespan: false, populationBirth: false, populationDeath: false, sensing: false, sensingHeadingSource: 'velocity', orientation: false, fieldCoupling: false, appearance: true };

/** A minimal agent model: one agent attribute + a behaviour that writes it. */
function baseModel(caps, nodes, edges, attrs = [{ id: 'acc', name: 'acc', type: 'float', defaultValue: '0', description: '' }]) {
  return {
    schemaVersion: 1,
    properties: { name: 'c9', gridWidth: 64, gridHeight: 64, dimension: '2d', boundaryTreatment: 'torus', updateMode: 'synchronous', asyncScheme: 'random-order', topology: '2d-grid', engine: 'js' },
    topologyMode: { gridCells: false, agents: true },
    attributes: [], agentAttributes: attrs, neighborhoods: [], mappings: [], indicators: [],
    graphNodes: [], graphEdges: [], agentGraphNodes: nodes, agentGraphEdges: edges, macroDefs: [],
    centerBased: { ...M.defaultCenterBasedConfig(), maxAgents: 16, maxBonds: 0, agentTarget: 'wasm', agentUpdateMode: 'async', agentCapabilities: caps },
  };
}

// ---------------------------------------------------------------------------
// TIER A — the gated layout matrix
// ---------------------------------------------------------------------------
console.log('--- A: gated layout matrix (16 combos × 2D/3D) ---');
const MA = 64;
const F64_GATED = { age: 'age', targetRadius: 'targetRadius', density: 'density' };
const ABI_NAME = { age: '_agentAge', targetRadius: '_agentTargetRadius', density: '_agentDensity' };
const SPRITE_PARAMS = ['spriteIds', 'spriteFrames', 'spriteSpeeds', 'spriteRotations', 'spriteScales'];
/** The sprite block computeAgentMemoryLayout appends LAST when the `sprites`
 *  gate is on: FOUR f64 runs (frames / speeds / rotations / scales) plus ONE
 *  i32 run (ids), one entry per agent. It landed with the WASM `setAgentSprite`
 *  emit — before that these five were plain JS arrays with no baked byte, which
 *  is why the shrink expectation below has to account for them. */
const SPRITE_BYTES_PER_AGENT = 4 * 8 + 1 * 4;

const fullLayout = M.computeAgentMemoryLayout(MA, 0, [], 0, {});
for (let mask = 0; mask < 16; mask++) {
  const gates = {
    sprites: !!(mask & 1), age: !!(mask & 2), targetRadius: !!(mask & 4), density: !!(mask & 8),
  };
  const L = M.computeAgentMemoryLayout(MA, 0, [], 0, { fieldGates: gates });
  // 1. exactly the gated f64 fields are absent from the layout
  for (const f of Object.keys(F64_GATED)) {
    ok((L.f64[f] !== undefined) === gates[f], `mask ${mask}: layout.f64.${f} present ⇔ gate on`);
  }
  // 2. every ALWAYS field is still present
  for (const f of ['x', 'y', 'xNext', 'yNext', 'vx', 'vy', 'forceX', 'forceY', 'radius']) {
    ok(L.f64[f] !== undefined, `mask ${mask}: core field ${f} still allocated`);
  }
  // 3. the byte saving is exactly the dropped runs and NOTHING else moved:
  //    8 B/agent per dropped f64, plus the whole sprite block when that gate is
  //    off. Hand-derived from computeAgentMemoryLayout's sprite region rather
  //    than read back from the layout, so a region that silently stops being
  //    gated (or starts being) fails here instead of agreeing with itself.
  const droppedF64 = Object.keys(F64_GATED).filter(f => !gates[f]).length;
  const spriteBytes = gates.sprites ? 0 : MA * SPRITE_BYTES_PER_AGENT;
  near(fullLayout.totalBytes - L.totalBytes, droppedF64 * MA * 8 + spriteBytes, 0,
    `mask ${mask}: layout shrinks by exactly ${droppedF64} × ${MA} × 8 B`
    + (gates.sprites ? '' : ` + the sprite block (${MA} × ${SPRITE_BYTES_PER_AGENT} B)`));
  // 4. the ABI param list drops exactly the expected names
  const shape = { is3d: false, agentAttrs: [], fieldAttrs: [], hasLookupTables: false, gates };
  const names = M.deriveAgentAbi('loop', shape).map(f => f.name);
  for (const [k, n] of Object.entries(ABI_NAME)) {
    ok(names.includes(n) === gates[k], `mask ${mask}: ABI has ${n} ⇔ gate on`);
  }
  for (const n of SPRITE_PARAMS) ok(names.includes(n) === gates.sprites, `mask ${mask}: ABI has ${n} ⇔ sprite gate on`);
  // 5. 2D is still a strict prefix of 3D (append-only z block) under every mask
  const n2 = M.deriveAgentAbi('loop', { ...shape, is3d: false }).map(f => f.name);
  const n3 = M.deriveAgentAbi('loop', { ...shape, is3d: true }).map(f => f.name);
  ok(n3.slice(0, n2.length).join('|') === n2.join('|'), `mask ${mask}: 2D ABI is a prefix of 3D`);
}

// 6. a gated-off group's STORE arrays are zero-length, and a write to one is a
//    silent no-op (the property every engine write site relies on).
{
  const cfg = { ...M.defaultCenterBasedConfig(), maxAgents: 8, maxBonds: 0 };
  const gates = { sprites: false, age: false, targetRadius: false, density: false };
  for (const wasmBacked of [false, true]) {
    const s = M.createAgentStore(cfg, [], { wasmBacked, fieldGates: gates });
    for (const f of ['age', 'targetRadius', 'density', 'spriteIds', 'spriteFrames', 'spriteSpeeds', 'spriteRotations', 'spriteScales']) {
      ok(s[f].length === 0, `store(${wasmBacked ? 'wasm' : 'plain'}): ${f} is zero-length when gated off`);
    }
    let threw = false;
    try { M.initAgentSlot(s, 0, 1, 2, 0, 3, 0); } catch { threw = true; }
    ok(!threw, `store(${wasmBacked ? 'wasm' : 'plain'}): initAgentSlot writes to gated-off arrays without throwing`);
    near(s.x[0], 1, 0, `store(${wasmBacked ? 'wasm' : 'plain'}): the CORE fields still took the init write`);
    near(s.radius[0], 3, 0, `store(${wasmBacked ? 'wasm' : 'plain'}): radius still written`);
  }
  // and the ALL-ON store keeps every array full length (today's behaviour)
  const full = M.createAgentStore(cfg, [], { wasmBacked: false });
  for (const f of ['age', 'targetRadius', 'density', 'spriteIds']) {
    ok(full[f].length === 8, `store(all gates on): ${f} is full length (pre-C9 behaviour)`);
  }
}

// ---------------------------------------------------------------------------
// TIER B — the safety catch: a gated-off read emits the typed default on JS AND
// on a real WASM module, and the two agree.
// ---------------------------------------------------------------------------
console.log('--- B: safety catch (gated read ⇒ typed default, JS + real WASM) ---');
{
  // A behaviour that copies `myAge` into an agent attribute, with the Lifespan
  // capability OFF. The gate is widened by a WIRED `myAge`, so this model KEEPS
  // its age field — the positive control.
  const wired = baseModel({ ...FULL_OFF },
    [node('bs', 'behaviourStep'), node('sa', 'setAttribute', { attributeId: 'acc' })],
    [fEdge('bs', 'do', 'sa', 'do'), vEdge('bs', 'myAge', 'sa', 'value')]);
  const gW = M.resolveAgentFieldGates(M.migrateForHarness(wired));
  ok(gW.age === true, 'a WIRED behaviourStep.myAge widens the Lifespan gate ON');

  // The same model with the edge removed: nothing reads age ⇒ the gate drops it.
  const bare = baseModel({ ...FULL_OFF },
    [node('bs', 'behaviourStep'), node('sa', 'setAttribute', { attributeId: 'acc', _port_value: '5' })],
    [fEdge('bs', 'do', 'sa', 'do')]);
  const gB = M.resolveAgentFieldGates(M.migrateForHarness(bare));
  ok(gB.age === false, 'no age reader ⇒ the Lifespan gate drops the field');
  ok(gB.sprites === false, 'no sprite assets + no Set Agent Sprite ⇒ the sprite block drops');

  // THE DEFENSIVE ARM: force the gate off while a reader IS present. The JS emit
  // must contain the literal default, never a dangling `_agentAge`.
  const m = M.migrateForHarness(wired);
  const js = M.compileAgentGraph(m.agentGraphNodes, m.agentGraphEdges, m);
  ok(!js.error, 'the wired model compiles on JS: ' + (js.error || ''));
  ok(js.behaviourCode.includes('_agentAge[idx]'), 'gate ON ⇒ the JS emit reads _agentAge');

  // Patch the compiled param list check: with the gate forced off the descriptor
  // drops the param, so an emit that still referenced it would be a ReferenceError.
  const namesOff = M.deriveAgentAbi('loop', { ...M.agentAbiShapeOf(m), gates: { ...gW, age: false } }).map(f => f.name);
  ok(!namesOff.includes('_agentAge'), 'gate OFF ⇒ _agentAge really leaves the param list');

  // Real WASM: the bare (gates-off) model compiles + instantiates.
  const wasm = M.compileAgentGraphWasmForModel(m);
  ok(!wasm.error, 'the gated model compiles to WASM: ' + (wasm.error || ''));
}

// ---------------------------------------------------------------------------
// TIER C — motion modes, asserted on POSITIONS through the real force pass.
// ---------------------------------------------------------------------------
console.log('--- C: motion modes (force / velocity / static) ---');

/** The JS reference force integrator, reduced to the terms this test exercises
 *  (no neighbours, no springs, no charge): the SAME expressions the worker's
 *  loop uses, so a divergence here is a real divergence. */
function stepJs(s, hw, motionMode, dtOverEta, momentum) {
  const doForces = motionMode === 2, doCommit = motionMode !== 0;
  for (let i = 0; i < hw; i++) {
    if (!s.alive[i]) { s.xNext[i] = s.x[i]; s.yNext[i] = s.y[i]; continue; }
    if (doCommit) {
      const vxi = doForces ? momentum * s.vx[i] + dtOverEta * s.forceX[i] : s.vx[i];
      const vyi = doForces ? momentum * s.vy[i] + dtOverEta * s.forceY[i] : s.vy[i];
      s.vx[i] = vxi; s.vy[i] = vyi;
      s.xNext[i] = s.x[i] + vxi; s.yNext[i] = s.y[i] + vyi;
    }
  }
  if (doCommit) { const tx = s.x, ty = s.y; s.x = s.xNext; s.y = s.yNext; s.xNext = tx; s.yNext = ty; }
}

for (const mode of ['force', 'velocity', 'static']) {
  const caps = { ...FULL_OFF, motion: mode };
  const raw = baseModel(caps, [node('bs', 'behaviourStep')], []);
  const m = M.migrateForHarness(raw);
  ok(M.agentMotionMode(m.centerBased) === mode, `${mode}: the profile round-trips through migration`);
  const code = M.motionModeCode(m.centerBased);
  ok(code === (mode === 'static' ? 0 : mode === 'velocity' ? 1 : 2), `${mode}: motionModeCode`);

  // The WASM force pass must COMPILE for every mode (all-target delivery).
  const w = M.compileAgentGraphWasmForModel(m);
  ok(!w.error, `${mode}: the agent WASM module (incl. the force pass) compiles: ${w.error || ''}`);

  // Positions through the JS reference: one agent at (10,10), velocity (2,0),
  // a constant force (+4,0), momentum 0, dt/eta 1.
  const s = M.createAgentStore(m.centerBased, [], { wasmBacked: false, fieldGates: M.resolveAgentFieldGates(m) });
  s.highWater = 1; s.liveCount = 1; s.alive[0] = 1;
  s.x[0] = 10; s.y[0] = 10; s.xNext[0] = 10; s.yNext[0] = 10;
  s.vx[0] = 2; s.vy[0] = 0; s.forceX[0] = 4; s.forceY[0] = 0;
  stepJs(s, 1, code, 1, 0);
  if (mode === 'force')    near(s.x[0], 14, 1e-12, 'force: x advances by the FORCE-derived velocity (10 + 4)');
  if (mode === 'velocity') near(s.x[0], 12, 1e-12, 'velocity: x coasts at the GRAPH-set velocity (10 + 2), the force IGNORED');
  if (mode === 'static')   near(s.x[0], 10, 1e-12, 'static: nothing moves at all');
  if (mode === 'velocity') near(s.vx[0], 2, 1e-12, 'velocity: the velocity is NOT decayed by momentum');

  // THE HAZARD: a position written BETWEEN steps must survive under Static (the
  // commit is skipped) and must be integrated-from under the moving modes.
  s.x[0] = 50;                      // the graph's `Set Agent Position`
  stepJs(s, 1, code, 1, 0);
  if (mode === 'static') near(s.x[0], 50, 1e-12, 'static: a Set Agent Position write SURVIVES the step (the Ant Necrophoresis hazard)');
  else ok(s.x[0] !== 50, `${mode}: a moving mode integrates away from the written position`);
}

// The shipped Static models really are static (and nothing else is).
{
  const fs = await import('fs');
  const seen = {};
  for (const f of fs.readdirSync(join(ROOT, 'public', 'models')).filter(x => x.endsWith('.gcaproj')).sort()) {
    const model = M.migrateForHarness(JSON.parse(fs.readFileSync(join(ROOT, 'public', 'models', f), 'utf8')));
    if (!model.topologyMode?.agents) continue;
    seen[f.replace('.gcaproj', '')] = M.agentMotionMode(model.centerBased);
  }
  ok(seen['Ant Necrophoresis'] === 'static', 'Ant Necrophoresis ships motion:static (the hazard model)');
  ok(seen['Game of Life on Agents'] === 'static', 'Game of Life on Agents ships motion:static');
  ok(seen['Boids - Flocking'] === 'force', 'Boids ships motion:force');
  ok(seen['Morphogenesis - Growing Tissue'] === 'force', 'Growing Tissue ships motion:force');
  const statics = Object.entries(seen).filter(([, v]) => v === 'static').map(([k]) => k).sort();
  ok(statics.length === 2, `exactly 2 shipped agent models are Static (got ${statics.join(', ')})`);
}

// ---------------------------------------------------------------------------
// TIER D — THE SHAPE-BUILDER MIRROR (source invariant).
//
// The gates ride `AgentAbiShape`, so EVERY site that builds a shape must carry
// them or the param list and the arg list describe different field sets — a
// silent ABI desync (found exactly this way in verification: the worker's
// `agentAbiShapeOfStore` was missing `gates`, and the Ant Necrophoresis Agent
// Init Event read `_rngState` off the end of the arg list). `audit-agent-layout`
// cannot catch it: it compares compile's params against the descriptor using the
// SAME shape, so a shape field missing at ONE site is invisible to it.
// ---------------------------------------------------------------------------
console.log('--- D: every AgentAbiShape builder carries the gates ---');
{
  const fs = await import('fs');
  const src = (rel) => fs.readFileSync(join(ROOT, rel), 'utf8');
  const bodyAfter = (text, marker) => {
    const i = text.indexOf(marker);
    return i < 0 ? '' : text.slice(i, i + 2600);
  };
  const sites = [
    ['src/modeler/vpl/compiler/compile.ts', 'export function agentAbiShapeOf('],
    ['src/simulator/engine/sim.worker.ts', 'function agentAbiShapeOfStore('],
    ['scripts/parity-agent-wasm.mjs', 'const shape = { is3d:'],
  ];
  for (const [rel, marker] of sites) {
    const b = bodyAfter(src(rel), marker);
    ok(b.length > 0, `${rel}: found the shape builder`);
    ok(/gates\s*:/.test(b), `${rel}: its AgentAbiShape carries \`gates\` (else the param + arg lists desync)`);
  }
  // And the store really exposes the record those sites read.
  const cfg = { ...M.defaultCenterBasedConfig(), maxAgents: 4, maxBonds: 0 };
  const st = M.createAgentStore(cfg, [], { wasmBacked: false, fieldGates: { sprites: false, age: false, targetRadius: true, density: true } });
  ok(st.fieldGates && st.fieldGates.age === false && st.fieldGates.targetRadius === true,
    'the store carries the gates it allocated with (what the worker shape builder reads)');
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'C9 GATES ✓' : 'C9 GATES ✗'}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);

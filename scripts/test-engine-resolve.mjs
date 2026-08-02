// C4 (P1) — ENGINE RESOLUTION gate.
//
// The one thing this must prove: **the engine enum changes nothing for an
// existing model.** Every `.gcaproj` in public/models is migrated, resolved and
// re-baked, and the resulting engine must be EXACTLY the one its legacy
// useWasm/useWebGPU flags already asked for — model by model, both layers. That
// is the byte-identity argument in miniature (check-compile-identity proves the
// emitted bytes; this proves the INPUT to those compilers is unchanged).
//
// Then: the new-model Auto expectations, the save→load round-trip of `engine` +
// its legacy mirror, an OLD-shape file (no `engine`) loading identically, and
// negative controls proving the checks can fail.
//
//   node scripts/test-engine-resolve.mjs
import { build } from 'esbuild';
import { writeFileSync, readFileSync, readdirSync, mkdtempSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = `
export { migrateForHarness } from '../src/dev/compileHarness.ts';
export { migrateEngineField, engineFromLegacyFlags } from '../src/model/engineFieldMigration.ts';
export { resolveEngines, withResolvedEngine, engineFlags, selectedGridEngine, selectedAgentEngine, gridWebgpuOk } from '../src/model/engineResolution.ts';
export { agentTargetOf } from '../src/model/centerBased.ts';
export { defaultCenterBasedConfig } from '../src/model/centerBased.ts';
export { EMPTY_MODEL } from '../src/model/defaultModel.ts';
export { serializeModel } from '../src/model/fileOperations.ts';
export { isAgentGraphWasmSupported } from '../src/modeler/vpl/compiler/agentWasm/compile.ts';
export { isAgentGraphWebGPUSupported } from '../src/modeler/vpl/compiler/agentWebgpu/compile.ts';
`;
const dir = mkdtempSync(join(tmpdir(), 'gca-engine-'));
const entryPath = join(ROOT, 'scripts', '__engine_entry.ts');
writeFileSync(entryPath, ENTRY);
const outPath = join(dir, 'bundle.mjs');
await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: process.cwd() });
const M = await import(pathToFileURL(outPath).href);
try { unlinkSync(entryPath); } catch { /* best effort */ }

const {
  migrateForHarness, migrateEngineField, engineFromLegacyFlags,
  resolveEngines, withResolvedEngine, engineFlags, selectedGridEngine, selectedAgentEngine,
  agentTargetOf, defaultCenterBasedConfig, EMPTY_MODEL, serializeModel,
  isAgentGraphWasmSupported, isAgentGraphWebGPUSupported,
} = M;

let pass = 0;
const failures = [];
// A swappable sink so a NEGATIVE CONTROL can run the same assertions and have
// its (expected) failures counted separately instead of failing the run.
let sink = failures;
function ok(cond, msg) {
  if (cond) { if (sink === failures) pass++; return true; }
  sink.push(msg); return false;
}
function eq(a, b, msg) { return ok(a === b, `${msg} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

const clone = (m) => JSON.parse(JSON.stringify(m));
const load = (f) => JSON.parse(readFileSync(join(ROOT, 'public', 'models', f), 'utf8'));
const files = readdirSync(join(ROOT, 'public', 'models')).filter(f => f.endsWith('.gcaproj')).sort();

// ---------------------------------------------------------------------------
// 1 — every shipped model: the migration reproduces the legacy resolution
// ---------------------------------------------------------------------------
console.log(`\n=== 1. Legacy fidelity over ${files.length} shipped models ===`);
const perModel = [];
for (const f of files) {
  const raw = load(f);
  // What the file asks for TODAY, straight from the flags (the pre-C4 rule,
  // written out here so a change to `engineFromLegacyFlags` cannot mask a
  // regression — this is the independent reference, not a call into the code).
  const legacyGrid = raw.properties.useWebGPU ? 'webgpu' : raw.properties.useWasm ? 'wasm' : 'js';
  const legacyAgentSel = raw.centerBased?.agentTarget;

  const migrated = migrateForHarness(clone(raw));
  eq(migrated.properties.engine, legacyGrid, `${f}: migrated engine`);
  eq(selectedGridEngine(migrated), legacyGrid, `${f}: selectedGridEngine`);
  ok(migrated.properties.engine !== 'auto', `${f}: a legacy file must NOT become 'auto'`);

  const res = resolveEngines(migrated);
  eq(res.grid.requested, legacyGrid, `${f}: resolved grid requested`);
  eq(res.grid.auto, false, `${f}: grid not auto`);

  // Re-baking must restore the file's OWN flags (normalised to booleans).
  const baked = withResolvedEngine(migrated);
  eq(!!baked.properties.useWasm, !!raw.properties.useWasm, `${f}: baked useWasm`);
  eq(!!baked.properties.useWebGPU, !!raw.properties.useWebGPU, `${f}: baked useWebGPU`);
  ok(baked === migrated || legacyGrid !== engineFromLegacyFlags(raw.properties),
    `${f}: baking an already-consistent model must return the SAME reference`);

  // Agents: the migration leaves `agentTarget` alone, and the resolution equals
  // the pre-change answer (`agentTargetOf` with the two gates).
  eq(migrated.centerBased?.agentTarget, legacyAgentSel, `${f}: agentTarget untouched by migration`);
  if (migrated.topologyMode?.agents) {
    const before = agentTargetOf(migrated.centerBased, isAgentGraphWasmSupported(migrated), isAgentGraphWebGPUSupported(migrated));
    eq(res.agents?.resolved, before, `${f}: resolved agent engine === agentTargetOf`);
    eq(res.agents?.auto, false, `${f}: agents not auto`);
    // Baking must not touch an explicit agent target.
    eq(baked.centerBased?.agentTarget, legacyAgentSel, `${f}: baked agentTarget`);
  } else {
    ok(!res.agents, `${f}: no agent layer for a grid-only model`);
  }
  perModel.push({ f, grid: legacyGrid, agents: legacyAgentSel ?? null });
}
console.log(`  ${files.length} models · grid: ` +
  ['webgpu', 'wasm', 'js'].map(e => `${e} ${perModel.filter(m => m.grid === e).length}`).join(' · '));

// ---------------------------------------------------------------------------
// 2 — new-model Auto expectations
// ---------------------------------------------------------------------------
console.log('\n=== 2. Auto policy ===');
eq(EMPTY_MODEL.properties.engine, 'auto', 'EMPTY_MODEL declares Auto');
eq(defaultCenterBasedConfig().agentTarget, 'auto', 'a freshly-enabled Agents topology declares Auto');

// A NEW model: empty synchronous grid, no Overseer ⇒ every WebGPU gate passes.
{
  const m = migrateForHarness(clone(EMPTY_MODEL));
  const r = resolveEngines(m);
  eq(r.grid.selected, 'auto', 'new model: selected');
  eq(r.grid.resolved, 'webgpu', 'new model: Auto → WebGPU (empty sync grid passes every gate)');
  ok(r.grid.reason.length > 0, 'new model: Auto states a reason');
}
// …the same model in ASYNC mode ⇒ the GPU cannot express it ⇒ WASM.
{
  const m = migrateForHarness(clone(EMPTY_MODEL));
  m.properties.updateMode = 'asynchronous';
  const r = resolveEngines(m);
  eq(r.grid.resolved, 'wasm', 'async model: Auto → WASM');
  ok(/synchronous/i.test(r.grid.reason), `async model: the reason names the blocker — got "${r.grid.reason}"`);
}
// …and with an Overseer experiment ⇒ CPU, even though every gate passes.
{
  const m = migrateForHarness(clone(EMPTY_MODEL));
  m.overseerConfig = { enabled: true };
  const r = resolveEngines(m);
  eq(r.grid.resolved, 'wasm', 'Overseer model: Auto → WASM');
  ok(/Overseer/i.test(r.grid.reason), `Overseer model: the reason names the sweep — got "${r.grid.reason}"`);
}
// A real library model flipped to Auto keeps landing where the library policy put it.
const AUTO_GRID_CASES = [
  ['Game Of Life.gcaproj', 'webgpu', 'a sync grid model'],
  ['Amphiphile.gcaproj', 'wasm', 'an async grid model'],
  ['GoL Replicate Statistics.gcaproj', 'wasm', 'a SYNC model that ships on WebGPU but runs Overseer sweeps'],
];
for (const [f, expect, why] of AUTO_GRID_CASES) {
  const m = migrateForHarness(load(f));
  m.properties.engine = 'auto';
  eq(resolveEngines(m).grid.resolved, expect, `Auto on ${f} (${why})`);
}

// Agents under Auto.
const AUTO_AGENT_CASES = [
  ['Boids - Flocking.gcaproj', 'webgpu', 'the GPU runs this agent graph'],
  ['Ant Necrophoresis.gcaproj', 'wasm', 'the GPU rejects it (cross-agent write to a wired id)'],
  ['Cubic GRA.gcaproj', 'wasm', 'Overseer sweeps need CPU seed reproducibility'],
];
for (const [f, expect, why] of AUTO_AGENT_CASES) {
  const m = migrateForHarness(load(f));
  m.centerBased.agentTarget = 'auto';
  const r = resolveEngines(m);
  eq(r.agents?.resolved, expect, `Auto agents on ${f} (${why})`);
  ok((r.agents?.reason ?? '').length > 0, `Auto agents on ${f}: states a reason`);
}
// The JS fallback arm: a behaviour graph BOTH compiled agent engines reject.
// `setAgentSprite` is the documented single genuine gap on both targets.
{
  const m = migrateForHarness(load('Boids - Flocking.gcaproj'));
  const bs = m.agentGraphNodes.find(n => n.data?.nodeType === 'behaviourStep');
  ok(!!bs, 'sprite case: the sample has a Behaviour Step root');
  m.agentGraphNodes.push({
    id: '__spriteProbe', type: 'caNode', position: { x: 0, y: 0 },
    data: { nodeType: 'setAgentSprite', config: {} },
  });
  m.agentGraphEdges.push({
    id: '__spriteProbeEdge', source: bs.id, sourceHandle: 'output_flow_do',
    target: '__spriteProbe', targetHandle: 'input_flow_do',
  });
  ok(!isAgentGraphWasmSupported(m) && !isAgentGraphWebGPUSupported(m),
    'sprite case: both agent gates reject the graph (precondition)');
  m.centerBased.agentTarget = 'auto';
  eq(resolveEngines(m).agents?.resolved, 'js', 'Auto agents: falls back to JS when neither compiled engine can run the graph');
}

// An EXPLICIT choice is never silently replaced by Auto's pick — it keeps its
// request (so the compile error + the loud fallback still happen) and only the
// RESOLVED value reports the demotion.
{
  const m = migrateForHarness(load('Amphiphile.gcaproj'));
  m.properties.engine = 'webgpu';
  const r = resolveEngines(m);
  eq(r.grid.requested, 'webgpu', 'explicit WebGPU on an async model: requested stays WebGPU');
  eq(r.grid.resolved, 'js', 'explicit WebGPU on an async model: resolves to the JS fallback');
  eq(withResolvedEngine(m).properties.useWebGPU, true,
    'the REQUESTED engine is baked, so the WebGPU compile still runs and its error still surfaces');
}

// ---------------------------------------------------------------------------
// 3 — save → load round-trip, and an OLD-shape file
// ---------------------------------------------------------------------------
console.log('\n=== 3. Round-trip + old-shape files ===');
for (const f of ['Game Of Life.gcaproj', 'Amphiphile.gcaproj', 'Boids - Flocking.gcaproj', 'Cubic GRA.gcaproj']) {
  const migrated = migrateForHarness(load(f));
  const reloaded = migrateForHarness(JSON.parse(serializeModel(migrated)));
  eq(reloaded.properties.engine, migrated.properties.engine, `${f}: engine survives save→load`);
  eq(!!reloaded.properties.useWasm, !!migrated.properties.useWasm, `${f}: useWasm mirror survives`);
  eq(!!reloaded.properties.useWebGPU, !!migrated.properties.useWebGPU, `${f}: useWebGPU mirror survives`);
  eq(reloaded.centerBased?.agentTarget, migrated.centerBased?.agentTarget, `${f}: agentTarget survives`);

  // An OLD build reads only the flags. Dropping `engine` (what an old file looks
  // like) must reload to exactly the same engine.
  const oldShape = JSON.parse(serializeModel(migrated));
  delete oldShape.properties.engine;
  eq(migrateForHarness(oldShape).properties.engine, migrated.properties.engine,
    `${f}: an old-shape file (no engine field) loads identically`);
}
// An AUTO model saves with its mirror RESOLVED, so an older build runs the same
// engine — this is the whole point of keeping the mirror for a release cycle.
{
  const m = migrateForHarness(clone(EMPTY_MODEL));
  const saved = JSON.parse(serializeModel(m));
  eq(saved.properties.engine, 'auto', 'auto model: engine is written');
  eq(!!saved.properties.useWebGPU, true, 'auto model: the mirror carries the RESOLVED engine (WebGPU)');
  eq(!!saved.properties.useWasm, false, 'auto model: the mirror is mutually exclusive');
  // …and an old build that ignores `engine` reads that same engine.
  delete saved.properties.engine;
  eq(migrateForHarness(saved).properties.engine, 'webgpu', 'auto model: an old build sees WebGPU');
}
// An auto AGENT model bakes a concrete target for the same reason.
{
  const m = migrateForHarness(load('Boids - Flocking.gcaproj'));
  m.centerBased.agentTarget = 'auto';
  const saved = JSON.parse(serializeModel(m));
  eq(saved.centerBased.agentTarget, 'webgpu', 'auto agents: the saved target is concrete');
}

// ---------------------------------------------------------------------------
// 4 — negative controls (a gate that cannot fail proves nothing)
// ---------------------------------------------------------------------------
console.log('\n=== 4. Negative controls ===');
let caught = 0, missed = 0;
function control(name, fn) {
  const bucket = [];
  sink = bucket;
  try { fn(); } finally { sink = failures; }
  if (bucket.length) { caught++; console.log(`  caught: ${name}`); }
  else { missed++; console.log(`  MISSED: ${name}`); }
}
// (a) A migration that maps useWasm → 'webgpu' must be caught by check 1.
control('a wrong legacy mapping (wasm → webgpu)', () => {
  const raw = load('Amphiphile.gcaproj');
  const wrong = 'webgpu';
  eq(wrong, raw.properties.useWebGPU ? 'webgpu' : raw.properties.useWasm ? 'wasm' : 'js',
     'control: mis-mapped engine');
});
// (b) Auto must not pick WebGPU for an async model.
control('Auto picking WebGPU for an async model', () => {
  const m = migrateForHarness(load('Amphiphile.gcaproj'));
  m.properties.engine = 'auto';
  eq(resolveEngines(m).grid.resolved, 'webgpu', 'control: async → webgpu');
});
// (c) The Overseer preference must actually bite (this model passes every gate).
control('the Overseer preference being ignored', () => {
  const m = migrateForHarness(load('GoL Replicate Statistics.gcaproj'));
  m.properties.engine = 'auto';
  eq(resolveEngines(m).grid.resolved, 'webgpu', 'control: Overseer model → webgpu');
});

// ---------------------------------------------------------------------------
console.log('\n' + '='.repeat(58));
if (failures.length) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  ✗ ' + f);
}
console.log(`ENGINE RESOLUTION: ${pass} passed, ${failures.length} failed · negative controls ${caught} caught, ${missed} missed`);
process.exit(failures.length === 0 && missed === 0 ? 0 : 1);

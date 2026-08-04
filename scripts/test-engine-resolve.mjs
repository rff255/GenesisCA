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
export { migrateReproducibilityField } from '../src/model/reproducibilityMigration.ts';
export { reproducibilityOf, inferContract, engineHonoursContract, contractViolationFor, describeSweepMethodology } from '../src/model/reproducibility.ts';
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
  migrateReproducibilityField, reproducibilityOf, inferContract, engineHonoursContract,
  contractViolationFor, describeSweepMethodology,
  resolveEngines, withResolvedEngine, engineFlags, selectedGridEngine, selectedAgentEngine, gridWebgpuOk,
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

  // A model that DECLARES `properties.engine` is not a legacy file, so the
  // legacy-fidelity assertions below (which derive the expected engine from the
  // useWasm/useWebGPU mirror) do not apply to it — they are about what the C4
  // MIGRATION does to a file that predates the field. Such a model gets the
  // assertions that DO apply: the migration must leave its declaration alone,
  // and — when it declares `auto` — the resolution must actually be an auto one
  // that honours its reproducibility contract.
  if (raw.properties.engine !== undefined) {
    const migrated = migrateForHarness(clone(raw));
    eq(migrated.properties.engine, raw.properties.engine, `${f}: migration leaves an explicit engine untouched`);
    eq(migrated.centerBased?.agentTarget, raw.centerBased?.agentTarget, `${f}: migration leaves an explicit agentTarget untouched`);
    const res = resolveEngines(migrated);
    eq(res.grid.selected, raw.properties.engine, `${f}: the resolution reports the declared selection`);
    eq(res.grid.auto, raw.properties.engine === 'auto', `${f}: grid auto flag matches the declaration`);
    if (migrated.topologyMode?.agents) {
      eq(res.agents?.auto, raw.centerBased?.agentTarget === 'auto', `${f}: agents auto flag matches the declaration`);
      ok(res.agents?.resolved === 'js' || res.agents?.resolved === 'wasm' || res.agents?.resolved === 'webgpu',
        `${f}: the agent layer resolves to a real engine`);
      // Auto consults the contract, so an AUTO model can never violate it.
      if (res.agents?.auto) ok(!res.agents?.contractViolation, `${f}: an auto agent layer never violates its own contract`);
      // Exact means the agents must land on a CPU engine (the GPU agent RNG
      // cannot be seeded) — the C5 asymmetry, asserted on a real shipped file.
      if (res.agents?.auto && reproducibilityOf(migrated) === 'exact') {
        ok(res.agents?.resolved !== 'webgpu', `${f}: an Exact contract keeps auto agents off the GPU`);
      }
    }
    // The contract is a DECLARATION here, not an inference, so it must survive
    // the migration verbatim.
    eq(reproducibilityOf(migrated), raw.properties.reproducibility ?? reproducibilityOf(migrated),
      `${f}: migration leaves an explicit reproducibility contract untouched`);
    perModel.push({ f, grid: raw.properties.engine, agents: raw.centerBased?.agentTarget ?? null, contract: reproducibilityOf(migrated) });
    continue;
  }

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

  // --- C5 (P10) — THE MIGRATION-COHERENCE REQUIREMENT ----------------------
  // "After migration, every existing library model must resolve to EXACTLY the
  // same engines as before this phase." Two independent angles:
  //
  //  (a) the RESOLVED grid engine still equals the pre-phase answer, computed
  //      here from the file's own flags + the real gate (not from the code
  //      under test), so a policy change that leaked into the explicit branch
  //      would fail;
  //  (b) the contract migration itself is INERT: stripping the field it wrote
  //      and re-resolving must give the same engines on both layers.
  const legacyGridResolved = (legacyGrid === 'webgpu' && !gridWebgpuOk(migrated)) ? 'js' : legacyGrid;
  eq(res.grid.resolved, legacyGridResolved, `${f}: COHERENCE — resolved grid engine unchanged by the contract`);

  const noContract = clone(migrated);
  delete noContract.properties.reproducibility;
  const pre = resolveEngines(noContract);
  eq(res.grid.resolved, pre.grid.resolved, `${f}: COHERENCE — the contract migration did not move the grid engine`);
  eq(res.agents?.resolved ?? null, pre.agents?.resolved ?? null, `${f}: COHERENCE — the contract migration did not move the agent engine`);

  // The INFERENCE: statistical iff the resolved agent engine is WebGPU.
  const contract = reproducibilityOf(migrated);
  ok(contract === 'exact' || contract === 'statistical', `${f}: migration seeds a contract`);
  eq(contract, inferContract(res.agents?.resolved ?? null), `${f}: inferred contract matches the resolved agent engine`);
  // …and it is idempotent (re-running must not change it).
  eq(reproducibilityOf(migrateReproducibilityField(migrated)), contract, `${f}: contract migration is idempotent`);
  // A violation can never be present on a SHIPPED model: every one either runs
  // its agents on the CPU (exact) or declares statistical.
  ok(!res.agents?.contractViolation, `${f}: no contract violation on a shipped model`);

  perModel.push({ f, grid: legacyGrid, agents: legacyAgentSel ?? null, contract });
}
console.log(`  ${files.length} models · grid: ` +
  ['webgpu', 'wasm', 'js'].map(e => `${e} ${perModel.filter(m => m.grid === e).length}`).join(' · '));
{
  const stat = perModel.filter(m => m.contract === 'statistical');
  console.log(`  contract inferred: statistical ${stat.length} · exact ${perModel.length - stat.length}`);
  console.log(`    statistical: ${stat.map(m => m.f.replace('.gcaproj', '')).join(', ')}`);
  // The set is EXACTLY the models whose agents resolve to WebGPU — asserted per
  // model above; here we pin the population so a library change is noticed.
  ok(stat.length > 0 && stat.length < perModel.length,
    'the inference partitions the library (some statistical, some exact) — a constant would be meaningless');
}

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
// C5 — the GRID policy is CONTRACT-INDEPENDENT, and the Overseer special case
// is gone: the GPU grid seeds a per-cell RNG that `setRngSeed` re-derives, so it
// honours Exact. (This is why the shipped grid Overseer sample runs on WebGPU.)
{
  const m = migrateForHarness(clone(EMPTY_MODEL));
  m.overseerConfig = { enabled: true };
  const r = resolveEngines(m);
  eq(r.grid.resolved, 'webgpu', 'Overseer grid model: Auto → WebGPU (the grid honours Exact)');
  ok(!/Overseer/i.test(r.grid.reason), `the resolution no longer mentions the Overseer — got "${r.grid.reason}"`);
  ok(/Exact/i.test(r.grid.reason), `the reason states the contract asymmetry — got "${r.grid.reason}"`);
}
// A real library model flipped to Auto keeps landing where the library policy put it.
const AUTO_GRID_CASES = [
  ['Game Of Life.gcaproj', 'webgpu', 'a sync grid model'],
  ['Amphiphile.gcaproj', 'wasm', 'an async grid model'],
  ['GoL Replicate Statistics.gcaproj', 'webgpu', 'a SYNC Overseer model — it SHIPS on WebGPU, and a grid sweep reproduces there'],
];
for (const [f, expect, why] of AUTO_GRID_CASES) {
  const m = migrateForHarness(load(f));
  m.properties.engine = 'auto';
  eq(resolveEngines(m).grid.resolved, expect, `Auto on ${f} (${why})`);
}

// Agents under Auto — now decided by the DECLARED CONTRACT.
const AUTO_AGENT_CASES = [
  ['Boids - Flocking.gcaproj', 'statistical', 'webgpu', 'declares Statistical and the GPU runs this graph'],
  ['Boids - Flocking.gcaproj', 'exact', 'wasm', 'declares Exact — the GPU agent RNG cannot be seeded'],
  ['Ant Necrophoresis.gcaproj', 'statistical', 'wasm', 'the GPU rejects it (cross-agent write to a wired id)'],
  ['Ant Necrophoresis.gcaproj', 'exact', 'wasm', 'Exact keeps it on the CPU too'],
  ['Cubic GRA.gcaproj', 'exact', 'wasm', 'declares Exact — the Overseer sweep reproduces on the CPU'],
  ['Cubic GRA.gcaproj', 'statistical', 'webgpu', 'declaring Statistical releases the GPU (the old special case forced WASM)'],
];
for (const [f, contract, expect, why] of AUTO_AGENT_CASES) {
  const m = migrateForHarness(load(f));
  m.centerBased.agentTarget = 'auto';
  m.properties.reproducibility = contract;
  const r = resolveEngines(m);
  eq(r.agents?.resolved, expect, `Auto agents on ${f} under ${contract} (${why})`);
  ok((r.agents?.reason ?? '').length > 0, `Auto agents on ${f} under ${contract}: states a reason`);
  ok(!r.agents?.contractViolation, `Auto never violates the contract (${f}, ${contract})`);
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
// 3b — C5 (P10): the declared reproducibility contract
// ---------------------------------------------------------------------------
console.log('\n=== 3b. Reproducibility contract (C5) ===');

// The default + the shape of the field.
eq(reproducibilityOf({ properties: {} }), 'exact', 'absent contract ⇒ exact');
eq(reproducibilityOf({ properties: { reproducibility: 'statistical' } }), 'statistical', 'declared statistical');
eq(reproducibilityOf({ properties: { reproducibility: 'nonsense' } }), 'exact', 'a junk value falls back to exact');
eq(inferContract('webgpu'), 'statistical', 'inference: GPU agents ⇒ statistical');
eq(inferContract('wasm'), 'exact', 'inference: WASM agents ⇒ exact');
eq(inferContract('js'), 'exact', 'inference: JS agents ⇒ exact');
eq(inferContract(null), 'exact', 'inference: no agent layer ⇒ exact');

// THE POLICY MATRIX — which engine each layer HONOURS under each contract.
// `'statistical'` is a TOLERANCE, so everything satisfies it; only Exact bites,
// and only on the WebGPU AGENT engine (the grid's per-cell RNG is re-seedable).
const HONOUR = [
  ['grid', 'wasm', 'exact', true], ['grid', 'js', 'exact', true],
  ['grid', 'webgpu', 'exact', true, 'the GPU grid re-derives its per-cell RNG from Set Random Seed'],
  ['agents', 'wasm', 'exact', true], ['agents', 'js', 'exact', true],
  ['agents', 'webgpu', 'exact', false, 'the GPU agent RNG is seeded once at creation'],
  ['grid', 'webgpu', 'statistical', true], ['agents', 'webgpu', 'statistical', true],
];
for (const [layer, engine, contract, expect, why] of HONOUR) {
  eq(engineHonoursContract(layer, engine, contract), expect,
    `${layer}/${engine} under ${contract}${why ? ` — ${why}` : ''}`);
  eq(contractViolationFor(layer, engine, contract) === null, expect,
    `${layer}/${engine} under ${contract}: violation text ⇔ !honours`);
}

// Auto NEVER violates the contract, on any shipped model, under either contract.
for (const f of files) {
  for (const contract of ['exact', 'statistical']) {
    const m = migrateForHarness(load(f));
    m.properties.engine = 'auto';
    m.properties.reproducibility = contract;
    if (m.centerBased) m.centerBased.agentTarget = 'auto';
    const r = resolveEngines(m);
    ok(!r.grid.contractViolation && !r.agents?.contractViolation,
      `${f} under ${contract}: Auto satisfies its own contract`);
    // …and under Exact, Auto never lands agents on the GPU.
    if (contract === 'exact') {
      ok(r.agents?.resolved !== 'webgpu', `${f}: Auto under Exact keeps agents off the GPU`);
    }
  }
}

// An EXPLICIT WebGPU agent engine under Exact IS a violation — the one case.
{
  const m = migrateForHarness(load('Boids - Flocking.gcaproj'));
  m.properties.reproducibility = 'exact';
  m.centerBased.agentTarget = 'webgpu';
  const r = resolveEngines(m);
  eq(r.agents?.resolved, 'webgpu', 'an explicit choice is never overridden by the contract');
  ok(!!r.agents?.contractViolation, 'explicit WebGPU agents + Exact ⇒ a contract violation');
  ok(/Exact/.test(r.agents.contractViolation) && /Statistical/.test(r.agents.contractViolation),
    'the violation names both ways out (change the engine, or declare Statistical)');
  // Declaring Statistical clears it without touching the engine.
  m.properties.reproducibility = 'statistical';
  const r2 = resolveEngines({ ...m, properties: { ...m.properties } });
  eq(r2.agents?.resolved, 'webgpu', 'declaring Statistical keeps the same engine');
  ok(!r2.agents?.contractViolation, 'declaring Statistical clears the violation');
}
// An explicit WebGPU GRID under Exact is NOT a violation (the asymmetry).
{
  const m = migrateForHarness(load('Game Of Life.gcaproj'));
  m.properties.reproducibility = 'exact';
  m.properties.engine = 'webgpu';
  const r = resolveEngines(m);
  eq(r.grid.resolved, 'webgpu', 'explicit WebGPU grid runs');
  ok(!r.grid.contractViolation, 'a WebGPU GRID honours Exact — the measured asymmetry');
}

// The Overseer sweep methodology line.
{
  const cpu = describeSweepMethodology('exact', { grid: 'wasm', agents: 'wasm' }, null);
  eq(cpu.tone, 'exact', 'methodology: exact + all-CPU tone');
  ok(/bit-exactly/.test(cpu.text), 'methodology: exact + all-CPU promises bit-exact repeats');
  const gpu = describeSweepMethodology('exact', { grid: 'webgpu', agents: null }, null);
  eq(gpu.tone, 'exact', 'methodology: exact + GPU grid tone');
  ok(/device-specific/.test(gpu.text), 'methodology: exact + GPU warns the numbers are device-specific');
  const stat = describeSweepMethodology('statistical', { grid: 'js', agents: 'webgpu' }, null);
  eq(stat.tone, 'statistical', 'methodology: statistical tone');
  ok(/repeats \+ aggregates/.test(stat.text), 'methodology: statistical asks for repeats + aggregates');
  const bad = describeSweepMethodology('exact', { grid: 'js', agents: 'webgpu' }, 'BOOM');
  eq(bad.tone, 'warn', 'methodology: a live violation takes over the line');
  eq(bad.text, 'BOOM', 'methodology: the violation text is shown verbatim');
}

// Serialization: the contract round-trips, and an old-shape file re-infers it.
for (const f of ['Boids - Flocking.gcaproj', 'Cubic GRA.gcaproj', 'Game Of Life.gcaproj']) {
  const m = migrateForHarness(load(f));
  const saved = JSON.parse(serializeModel(m));
  eq(saved.properties.reproducibility, reproducibilityOf(m), `${f}: the contract is written on save`);
  eq(reproducibilityOf(migrateForHarness(saved)), reproducibilityOf(m), `${f}: it survives save→load`);
  const oldShape = JSON.parse(serializeModel(m));
  delete oldShape.properties.reproducibility;
  eq(reproducibilityOf(migrateForHarness(oldShape)), reproducibilityOf(m),
    `${f}: an old-shape file re-infers the SAME contract`);
}
// A user's explicit choice is never re-inferred away.
{
  const m = migrateForHarness(load('Boids - Flocking.gcaproj'));   // infers statistical
  m.properties.reproducibility = 'exact';
  eq(reproducibilityOf(migrateReproducibilityField(m)), 'exact',
    'a declared contract is preserved, never re-inferred');
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
// (c) C5 — Exact must keep agents off the GPU.
control('Auto putting agents on the GPU under an Exact contract', () => {
  const m = migrateForHarness(load('Boids - Flocking.gcaproj'));
  m.centerBased.agentTarget = 'auto';
  m.properties.reproducibility = 'exact';
  eq(resolveEngines(m).agents?.resolved, 'webgpu', 'control: exact agents → webgpu');
});
// (d) C5 — Statistical must RELEASE the GPU (proving the contract is read at
//     all, not just that Exact is a blanket CPU rule).
control('the Statistical contract being ignored (still forced to the CPU)', () => {
  const m = migrateForHarness(load('Boids - Flocking.gcaproj'));
  m.centerBased.agentTarget = 'auto';
  m.properties.reproducibility = 'statistical';
  eq(resolveEngines(m).agents?.resolved, 'wasm', 'control: statistical agents → wasm');
});
// (e) C5 — the inference must not be a constant.
control('a constant contract inference', () => {
  eq(inferContract('webgpu'), inferContract('wasm'), 'control: inference is constant');
});
// (f) C5 — COHERENCE: a contract that leaked into the EXPLICIT branch would move
//     a shipped model's engine. This is the check that guards the whole phase.
control('the contract leaking into an explicit engine choice', () => {
  const m = migrateForHarness(load('Boids - Flocking.gcaproj'));   // explicit webgpu agents
  m.properties.reproducibility = 'exact';
  eq(resolveEngines(m).agents?.resolved, 'wasm', 'control: explicit webgpu demoted by the contract');
});

// ---------------------------------------------------------------------------
console.log('\n' + '='.repeat(58));
if (failures.length) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  ✗ ' + f);
}
console.log(`ENGINE RESOLUTION: ${pass} passed, ${failures.length} failed · negative controls ${caught} caught, ${missed} missed`);
process.exit(failures.length === 0 && missed === 0 ? 0 : 1);

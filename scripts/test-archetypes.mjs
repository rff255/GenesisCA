// C7 (P6) — MODEL ARCHETYPE gate.
//
// The New-model chooser seeds a whole paradigm in one click. Three things have to
// stay true or the feature quietly lies:
//
//   1. `'empty'` is TODAY'S New, field-for-field — the historical behaviour must
//      stay reachable and unchanged (it is also the escape hatch).
//   2. Every seed is COHERENT: the topology/dimension the card claims, a closure-
//      stable capability profile, `engine: 'auto'`, the declared contract, and —
//      the two easy silent failures — a bond store for the bonded archetypes
//      (`resolveMaxBonds > 0`) and `useBondingPhysics` DERIVED from the profile
//      rather than typed in beside it.
//   3. Every seed RESOLVES: it survives the load-time migrations unchanged and
//      `resolveEngines` reports no contract violation (a card that seeds an
//      engine/contract pair the gates reject would ship a broken model).
//
//   node scripts/test-archetypes.mjs
import { build } from 'esbuild';
import { writeFileSync, mkdtempSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = `
export { MODEL_ARCHETYPES, buildArchetypeModel, GRA_PROFILE } from '../src/model/archetypes.ts';
export { EMPTY_MODEL } from '../src/model/defaultModel.ts';
export { AGENT_PRESETS, computeCapabilityClosure, matchAgentPreset, resolveAgentProfile } from '../src/model/agentCapabilities.ts';
export { resolveMaxBonds, usesBondingPhysics, usesEngineSprings, usesEngineCollision, collisionMode, usesCharge } from '../src/model/centerBased.ts';
export { resolveEngines } from '../src/model/engineResolution.ts';
export { reproducibilityOf } from '../src/model/reproducibility.ts';
export { migrateForHarness } from '../src/dev/compileHarness.ts';
export { describeGenerationPipeline } from '../src/model/generationPipeline.ts';
export { diagnoseTargets } from '../src/model/targetDiagnosis.ts';
`;
const dir = mkdtempSync(join(tmpdir(), 'gca-arch-'));
const entryPath = join(ROOT, 'scripts', '__arch_entry.ts');
writeFileSync(entryPath, ENTRY);
const outPath = join(dir, 'bundle.mjs');
await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: process.cwd() });
const M = await import(pathToFileURL(outPath).href);
try { unlinkSync(entryPath); } catch { /* best effort */ }

const {
  MODEL_ARCHETYPES, buildArchetypeModel, GRA_PROFILE, EMPTY_MODEL,
  AGENT_PRESETS, computeCapabilityClosure, matchAgentPreset, resolveAgentProfile,
  resolveMaxBonds, usesBondingPhysics, usesEngineSprings, usesEngineCollision, collisionMode, usesCharge,
  resolveEngines, reproducibilityOf, migrateForHarness, describeGenerationPipeline, diagnoseTargets,
} = M;

let pass = 0; const fails = [];
const ok = (cond, msg) => { if (cond) pass++; else fails.push(msg); };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// --- 1. `empty` IS today's New ---------------------------------------------
const empty = buildArchetypeModel('empty');
ok(empty === EMPTY_MODEL, "buildArchetypeModel('empty') returns EMPTY_MODEL itself (identity)");
ok(eq(empty, EMPTY_MODEL), "buildArchetypeModel('empty') deep-equals EMPTY_MODEL");
ok(empty.properties.reproducibility === undefined, "'empty' does not add a contract field (absent ⇒ exact)");
ok(empty.centerBased === undefined, "'empty' seeds no agent config");
ok(eq(empty.topologyMode, { gridCells: true, agents: false }), "'empty' is a grid-only model");

// --- 2. Every archetype builds a coherent model ------------------------------
const EXPECT = {
  ca2d:       { grid: true,  agents: false, dim: '2d', contract: 'exact' },
  ca3d:       { grid: true,  agents: false, dim: '3d', contract: 'exact' },
  particles:  { grid: false, agents: true,  dim: '2d', contract: 'statistical', preset: 'particle' },
  flocking:   { grid: false, agents: true,  dim: '2d', contract: 'statistical', preset: 'boids' },
  tissue:     { grid: false, agents: true,  dim: '2d', contract: 'exact',       preset: 'morphogenesis' },
  gra:        { grid: false, agents: true,  dim: '2d', contract: 'exact',       preset: 'custom' },
  caOnAgents: { grid: false, agents: true,  dim: '2d', contract: 'exact',       preset: 'caOnAgents' },
  empty:      { grid: true,  agents: false, dim: '2d', contract: 'exact' },
};

ok(MODEL_ARCHETYPES.length === Object.keys(EXPECT).length,
  `MODEL_ARCHETYPES has ${Object.keys(EXPECT).length} cards (got ${MODEL_ARCHETYPES.length})`);

for (const a of MODEL_ARCHETYPES) {
  const e = EXPECT[a.id];
  ok(!!e, `archetype '${a.id}' is expected by this gate (add it here when you add a card)`);
  if (!e) continue;
  const m = buildArchetypeModel(a.id);

  ok(m.topologyMode.gridCells === e.grid, `${a.id}: gridCells === ${e.grid}`);
  ok(m.topologyMode.agents === e.agents, `${a.id}: agents === ${e.agents}`);
  ok((m.properties.dimension ?? '2d') === e.dim, `${a.id}: dimension === ${e.dim}`);
  ok(m.properties.engine === 'auto', `${a.id}: engine === 'auto'`);
  ok(reproducibilityOf(m) === e.contract, `${a.id}: contract === ${e.contract}`);
  ok(a.label.length > 0 && a.description.length > 0 && a.tags.length > 0, `${a.id}: card copy present`);

  // 3D must be a REAL volume — `is3dModel` needs depth > 1, so a 3D card that
  // forgot gridDepth would render as a flat 2D grid claiming to be 3D.
  if (e.dim === '3d') ok((m.properties.gridDepth ?? 1) > 1, `${a.id}: gridDepth > 1 (a real volume)`);

  if (!e.agents) {
    ok(m.centerBased === undefined, `${a.id}: no agent config on a grid-only archetype`);
    continue;
  }

  const cb = m.centerBased;
  ok(!!cb, `${a.id}: seeds a centerBased config`);
  if (!cb) continue;
  const prof = resolveAgentProfile(m);
  ok(eq(computeCapabilityClosure(prof), prof), `${a.id}: capability profile is closure-stable`);
  ok(matchAgentPreset(prof) === e.preset, `${a.id}: preset match === ${e.preset}`);
  ok((cb.seedCount ?? 0) > 0, `${a.id}: seeds a starting population (${cb.seedCount})`);
  ok(cb.seedPattern === 'compact' || cb.seedPattern === 'scatter', `${a.id}: seedPattern set`);
  ok(cb.agentTarget === 'auto', `${a.id}: agentTarget === 'auto'`);
  // The agent world IS the grid frame 1:1, so the grid dims must be the world.
  ok(m.properties.gridWidth === cb.worldWidth && m.properties.gridHeight === cb.worldHeight,
    `${a.id}: grid dims === agent world dims (the 1:1 frame)`);

  // THE TWO SILENT FAILURES.
  // (a) `resolveMaxBonds` returns 0 when the ceiling is 0 EVEN IF the profile
  //     says bonds:'physics' — a bonded archetype that left the default 0 would
  //     have no bond store and nothing could ever bond.
  const wantsBonds = prof.bonds !== 'off';
  ok(wantsBonds ? resolveMaxBonds(cb) > 0 : resolveMaxBonds(cb) === 0,
    `${a.id}: bond store ${wantsBonds ? 'allocated' : 'dropped'} (resolveMaxBonds ${resolveMaxBonds(cb)})`);
  // (b) `useBondingPhysics` is the Properties panel's progressive-disclosure
  //     switch while the ENGINE is profile-driven; seeding them independently is
  //     how they drift, so it must be DERIVED.
  const derived = prof.collision !== 'off' || prof.bonds === 'physics' || prof.growth;
  ok(usesBondingPhysics(cb) === derived,
    `${a.id}: useBondingPhysics derived from the profile (${derived})`);

  // The profile and the engine resolvers must agree about what runs.
  ok(usesEngineCollision(cb) === (prof.collision !== 'off'), `${a.id}: collision resolver agrees with the profile`);
  ok(collisionMode(cb) === prof.collision, `${a.id}: collisionMode === profile.collision`);
  ok(usesEngineSprings(cb) === (prof.bonds === 'physics'), `${a.id}: spring resolver agrees with the profile`);
  ok(usesCharge(cb) === (prof.charge === 'on'), `${a.id}: charge resolver agrees with the profile`);
}

// --- 3. Every seed survives migration + resolves with no contract violation ---
for (const a of MODEL_ARCHETYPES) {
  const m = buildArchetypeModel(a.id);
  // migrateForHarness mirrors the LOAD_MODEL guards (engine, contract, agent
  // capability completion). A seed that changes under it is a seed that would
  // look different the moment the user saved and re-opened it.
  const after = migrateForHarness(JSON.parse(JSON.stringify(m)));
  ok(after.properties.engine === m.properties.engine, `${a.id}: engine survives the load-time migration`);
  ok(reproducibilityOf(after) === reproducibilityOf(m), `${a.id}: contract survives the load-time migration`);
  if (m.centerBased) {
    ok(eq(resolveAgentProfile(after), resolveAgentProfile(m)),
      `${a.id}: capability profile survives the load-time migration`);
  }

  const r = resolveEngines(m);
  ok(!r.grid.contractViolation && !r.agents?.contractViolation,
    `${a.id}: no contract violation (grid ${r.grid.resolved} / agents ${r.agents?.resolved ?? 'n/a'})`);
  ok(r.grid.selected === 'auto', `${a.id}: grid engine selection is Auto`);

  // The two read-only clarity panels must be able to describe every seed — they
  // are the surfaces the in-browser verification asserts through.
  const phases = describeGenerationPipeline(m);
  ok(Array.isArray(phases) && phases.length > 0, `${a.id}: generation pipeline describes it (${phases.length} phases)`);
  const diag = diagnoseTargets(m);
  const wantLayers = (m.topologyMode.gridCells !== false ? 1 : 0) + (m.topologyMode.agents ? 1 : 0);
  ok(diag.layers.length === wantLayers,
    `${a.id}: compatibility readout describes every active layer (${diag.layers.length})`);
  ok(diag.layers.every(l => l.verdicts.some(v => v.ok)),
    `${a.id}: every layer has at least one runnable engine`);
}

// --- 4. The GRA profile is the flagship shape, NOT socialGraph ---------------
ok(!eq(GRA_PROFILE, AGENT_PRESETS.socialGraph), 'GRA profile is NOT socialGraph');
ok(GRA_PROFILE.bonds === 'physics', 'GRA profile: bonds physics (rewritable, spring-laid-out edges)');
ok(GRA_PROFILE.charge === 'on', 'GRA profile: charge ON (the force that unfolds a grown graph)');
ok(GRA_PROFILE.motion === 'force', 'GRA profile: motion force');
ok(GRA_PROFILE.division === false, 'GRA profile: division OFF (a split is Create Agent + Rewire)');
ok(buildArchetypeModel('gra').centerBased.autoBond === false,
  'GRA seeds auto-bond OFF (a GRA bonds BY RULE; distance-bonding would fight it)');

// --- 5. Negative controls (the gate can fail) --------------------------------
{
  const m = buildArchetypeModel('flocking');
  ok(reproducibilityOf(m) !== 'exact', 'NEG: flocking would fail an exact-contract expectation');
  const t = buildArchetypeModel('tissue');
  ok(resolveMaxBonds({ ...t.centerBased, maxBonds: 0 }) === 0,
    'NEG: zeroing the tissue ceiling drops the bond store (the silent failure this gate catches)');
  ok(matchAgentPreset(AGENT_PRESETS.socialGraph) === 'socialGraph'
    && matchAgentPreset(GRA_PROFILE) === 'custom',
    'NEG: matchAgentPreset really distinguishes the two (GRA reads Custom, socialGraph does not)');
}

console.log(fails.length
  ? `\nFAILED ${fails.length} / ${pass + fails.length}\n` + fails.map(f => '  ✗ ' + f).join('\n') + '\n'
  : `OK — ${pass} archetype checks passed.`);
process.exit(fails.length ? 1 : 0);

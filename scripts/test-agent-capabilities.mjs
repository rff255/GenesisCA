// STEP 1 verification for Agent Capability Profiles: preset closure-stability +
// Full≡Morphogenesis, the usage-widened migration NEVER hides a used node on any
// shipped agent sample, per-preset gating, the removal cascades, and the
// footprint ordering. Pure (no GPU / worker) — bundles the model-layer module +
// the compileHarness migration and asserts.
//
// Run:  node scripts/test-agent-capabilities.mjs
import { build } from 'esbuild';
import { writeFileSync, rmSync, mkdtempSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = `
export * from '../src/model/agentCapabilities.ts';
export { migrateForHarness } from '../src/dev/compileHarness.ts';
export { getAllNodeDefs } from '../src/modeler/vpl/nodes/registry.ts';
export { legacyPhysicsFlagsInEffect } from '../src/model/centerBased.ts';
export { serializeModel } from '../src/model/fileOperations.ts';
`;
const dir = mkdtempSync(join(tmpdir(), 'gca-caps-'));
const entryPath = join(ROOT, 'scripts', '__caps_entry.ts');
writeFileSync(entryPath, ENTRY);
const outPath = join(dir, 'bundle.mjs');
await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: process.cwd() });
const m = await import(pathToFileURL(outPath).href);
const {
  AGENT_PRESETS, AGENT_PRESET_META, FULL_AGENT_PROFILE, computeCapabilityClosure,
  matchAgentPreset, inferAgentProfile, migrateAgentCapabilities, resolveAgentProfile,
  nodeSatisfiesCapabilities, agentNodeRequirement, AGENT_NODE_REQUIREMENT,
  estimateAgentFootprint, applyCapabilityEdit, defaultAgentCapabilities,
  migrateForHarness, getAllNodeDefs,
  legacyPhysicsFlagsInEffect, serializeModel,
} = m;

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log('  ✗ ' + msg); } };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// --- 1. Full ≡ Morphogenesis (deep-equal). ---
ok(eq(FULL_AGENT_PROFILE, AGENT_PRESETS.morphogenesis), 'Full === Morphogenesis');
ok(matchAgentPreset(FULL_AGENT_PROFILE) === 'morphogenesis', 'matchAgentPreset(Full) === morphogenesis');

// --- 2. Every preset is closure-stable + round-trips through matchAgentPreset. ---
for (const meta of AGENT_PRESET_META) {
  const p = AGENT_PRESETS[meta.key];
  ok(eq(computeCapabilityClosure(p), p), `preset ${meta.key} is closure-stable`);
  ok(matchAgentPreset(p) === meta.key, `matchAgentPreset(${meta.key}) round-trips`);
}
// default seed matches a known preset (boids).
ok(matchAgentPreset(defaultAgentCapabilities()) === 'boids', 'default enable = Boids');

// --- 3. Per-preset gating sanity (the Social-Graph proof). ---
const sg = AGENT_PRESETS.socialGraph;
ok(!nodeSatisfiesCapabilities('getRadius', sg), 'Social Graph hides Get Radius');
ok(!nodeSatisfiesCapabilities('applyForce', sg), 'Social Graph hides Apply Force');
ok(!nodeSatisfiesCapabilities('divideAgent', sg), 'Social Graph hides Divide Agent');
ok(!nodeSatisfiesCapabilities('getNearbyAgents', sg), 'Social Graph hides Get Nearby Agents');
ok(nodeSatisfiesCapabilities('getBondedAgents', sg), 'Social Graph SHOWS Get Bonded Agents (bonds=data)');
ok(nodeSatisfiesCapabilities('forEachBond', sg), 'Social Graph SHOWS For Each Bond');
ok(nodeSatisfiesCapabilities('behaviourStep', sg), 'behaviourStep is core (always shown)');
ok(nodeSatisfiesCapabilities('getAgentAttribute', sg), 'getAgentAttribute is core (edge traversal)');
const morph = AGENT_PRESETS.morphogenesis;
ok(nodeSatisfiesCapabilities('divideAgent', morph), 'Morphogenesis shows Divide Agent');
ok(nodeSatisfiesCapabilities('secreteToField', morph), 'Morphogenesis shows Secrete To Field');
ok(!nodeSatisfiesCapabilities('secreteToField', AGENT_PRESETS.boids), 'Boids hides Secrete To Field');

// --- 4. Removal cascades. ---
{
  const bodyOff = applyCapabilityEdit(morph, 'body', false);
  ok(!bodyOff.growth && !bodyOff.division && bodyOff.collision === 'off', 'body off drops growth/division/collision');
  const staticMotion = applyCapabilityEdit(morph, 'motion', 'static');
  ok(staticMotion.bonds !== 'physics' && !staticMotion.autoBond, 'static motion demotes physics bonds + autoBond');
  const closed = computeCapabilityClosure({ ...AGENT_PRESETS.particle, division: true });
  ok(closed.body, 'enabling division closes Body on');
}

// --- 5. Footprint ordering (Social Graph << Morphogenesis) + core floor. ---
{
  const dummyModel = { properties: { dimension: '2d', gridDepth: 1 }, topologyMode: { agents: true }, agentAttributes: [], centerBased: { maxBonds: 8 } };
  const fpSocial = estimateAgentFootprint(sg, dummyModel).bytesPerAgent;
  const fpMorph = estimateAgentFootprint(morph, dummyModel).bytesPerAgent;
  ok(fpSocial < fpMorph, `footprint social (${fpSocial}) < morphogenesis (${fpMorph})`);
  ok(estimateAgentFootprint(sg, dummyModel).groups.some(g => g.core), 'footprint has a core group');
}

// --- 6. The KEY migration property: on EVERY shipped agent sample, the inferred
//        profile hides NO node the agent graph (or its macros) actually uses. ---
const knownNodeTypes = new Set(getAllNodeDefs().map(d => d.type));
const modelsDir = join(ROOT, 'public', 'models');
const files = readdirSync(modelsDir).filter(f => f.endsWith('.gcaproj'));
let agentSamples = 0;
for (const f of files) {
  let raw; try { raw = JSON.parse(readFileSync(join(modelsDir, f), 'utf8')); } catch { continue; }
  const model = migrateForHarness(raw);
  if (!model?.topologyMode?.agents) continue;
  agentSamples++;
  // migration must have seeded an explicit profile (so gating is O(1)).
  ok(!!model.centerBased?.agentCapabilities, `${f}: migration seeded an explicit profile`);
  const prof = resolveAgentProfile(model);
  // every agent-graph node (+ macro internals reachable) that MAPS to a capability
  // must be satisfied by the inferred profile — i.e. migration never hides a used node.
  const scan = (nodes) => {
    for (const n of nodes ?? []) {
      const t = n?.data?.nodeType;
      if (typeof t !== 'string') continue;
      if (agentNodeRequirement(t) && !nodeSatisfiesCapabilities(t, prof)) {
        ok(false, `${f}: migration HIDES a used node '${t}' (requirement unmet)`);
      }
    }
  };
  scan(model.agentGraphNodes);
  for (const def of model.macroDefs ?? []) scan(def.nodes);
}
ok(agentSamples >= 5, `scanned ${agentSamples} agent samples (>=5)`);

// --- 7. AGENT_NODE_REQUIREMENT references only real (or reserved net-new) types. ---
const RESERVED = new Set(['spawnAgent', 'spawnEvent', 'getAgentsInView', 'senseHemifield', 'getAge']);
for (const t of Object.keys(AGENT_NODE_REQUIREMENT)) {
  ok(knownNodeTypes.has(t) || RESERVED.has(t), `requirement key '${t}' is a real or reserved node type`);
}

// --- 8. C6 (P5) — THE CAPABILITY PROFILE IS AUTHORITATIVE. ---------------------
// The claim under test: a model that goes through the app never lets the legacy
// `customForcesOnly` / `useBondingPhysics` flags decide its physics, because
// LOAD seeds a profile and SAVE writes it back. `legacyPhysicsFlagsInEffect` is
// the exact union of the resolvers' fallback conditions, so asserting it false
// after migration IS the claim — not a proxy for it.
let authorityChecked = 0;
for (const f of files) {
  let raw; try { raw = JSON.parse(readFileSync(join(modelsDir, f), 'utf8')); } catch { continue; }
  const loaded = migrateForHarness(raw);
  if (!loaded?.topologyMode?.agents) {
    // A non-agent model has no centerBased at all ⇒ nothing legacy to resolve.
    ok(!legacyPhysicsFlagsInEffect(loaded?.centerBased), `${f}: non-agent model — no legacy physics resolution`);
    continue;
  }
  authorityChecked++;
  // (a) LOAD: after migration, no capability-gated resolver takes a legacy arm.
  ok(!legacyPhysicsFlagsInEffect(loaded.centerBased), `${f}: LOAD leaves no legacy arm in effect`);
  // (b) SAVE: serializeModel writes centerBased verbatim, so the profile survives.
  const reparsed = JSON.parse(serializeModel(loaded));
  ok(!!reparsed.centerBased?.agentCapabilities, `${f}: SAVE writes agentCapabilities`);
  ok(eq(reparsed.centerBased.agentCapabilities, loaded.centerBased.agentCapabilities), `${f}: SAVE preserves the profile exactly`);
  ok(!legacyPhysicsFlagsInEffect(reparsed.centerBased), `${f}: the saved file needs no legacy arm`);
  // (c) The round-trip is a FIXED POINT: re-loading the saved file changes nothing.
  const reloaded = migrateForHarness(reparsed);
  ok(eq(reloaded.centerBased.agentCapabilities, loaded.centerBased.agentCapabilities), `${f}: load→save→load is idempotent`);
  // (d) NEGATIVE CONTROL — strip the profile (a hand-edited file) and the legacy
  //     arms DO decide; migrating it again puts the profile back. Without this,
  //     (a) could pass because the predicate is stuck at false.
  const stripped = JSON.parse(serializeModel(loaded));
  delete stripped.centerBased.agentCapabilities;
  ok(legacyPhysicsFlagsInEffect(stripped.centerBased), `${f}: NEG stripped profile ⇒ legacy arms in effect`);
  ok(!legacyPhysicsFlagsInEffect(migrateForHarness(stripped).centerBased), `${f}: re-migrating the stripped file bakes it again`);
}
ok(authorityChecked >= 8, `authority checked on ${authorityChecked} agent models (>=8)`);
// (d2) The PARTIAL-profile hole: a hand-edited `{ motion:'force' }` is TRUTHY, so it
//      used to slip past the migration and let collisionMode (which falls back
//      per-FIELD) resolve from the legacy flags — and saving wrote it straight back,
//      so "re-save to bake it" would not have fixed it. The migration now normalises
//      an EXISTING profile through the closure, which closes it.
{
  const base = files.map(f => { try { return JSON.parse(readFileSync(join(modelsDir, f), 'utf8')); } catch { return null; } })
    .find(r => r?.topologyMode?.agents);
  ok(!!base, 'found an agent model to build the partial-profile case from');
  if (base) {
    const partial = JSON.parse(JSON.stringify(base));
    partial.centerBased.agentCapabilities = { motion: 'force' };
    ok(legacyPhysicsFlagsInEffect(partial.centerBased), 'NEG a PARTIAL profile trips the predicate before migration');
    const fixed = migrateForHarness(partial);
    ok(!legacyPhysicsFlagsInEffect(fixed.centerBased), 'migration normalises a partial profile (closes the hole)');
    ok(eq(fixed.centerBased.agentCapabilities, computeCapabilityClosure(fixed.centerBased.agentCapabilities)),
      'the normalised profile is a closure fixed point');
    // and it SAVES normalised, so re-loading it stays fixed.
    ok(!legacyPhysicsFlagsInEffect(JSON.parse(serializeModel(fixed)).centerBased), 're-saving a repaired file keeps it repaired');
  }
}
// A PARTIAL profile (no `collision` key) still trips the predicate — collisionMode
// falls back per-FIELD, not per-object, so "has a profile" is not sufficient.
ok(legacyPhysicsFlagsInEffect({ agentCapabilities: { motion: 'force' } }), 'partial profile (no collision) ⇒ legacy arm in effect');
ok(!legacyPhysicsFlagsInEffect(null), 'no centerBased ⇒ nothing legacy in effect');

// (e) No SAVE path writes the legacy flag. The app must never re-emit
//     `customForcesOnly`; only the generator scripts (which author shipped
//     fixtures by hand) still do. Guards the "stop writing it on save" rule.
const srcDir = join(ROOT, 'src');
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]);
const writers = [];
for (const p of walk(srcDir)) {
  if (!/\.(ts|tsx)$/.test(p)) continue;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    // a WRITE looks like `customForcesOnly:` / `customForcesOnly =`; a read is
    // `cfg?.customForcesOnly`. Comments are skipped.
    const s = line.trim();
    if (s.startsWith('*') || s.startsWith('//')) continue;
    if (/customForcesOnly\s*[:=][^=]/.test(s)) writers.push(`${p}: ${s}`);
  }
}
ok(writers.length === 0, `no src/ path WRITES customForcesOnly (found: ${writers.join(' | ')})`);

console.log(`\n${fail === 0 ? 'ALL CAPABILITY TESTS PASS ✓' : 'SOME FAILED ✗'}  (${pass} passed, ${fail} failed)`);
rmSync(entryPath, { force: true });
rmSync(dir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);

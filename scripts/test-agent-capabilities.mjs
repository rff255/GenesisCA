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

console.log(`\n${fail === 0 ? 'ALL CAPABILITY TESTS PASS ✓' : 'SOME FAILED ✗'}  (${pass} passed, ${fail} failed)`);
rmSync(entryPath, { force: true });
rmSync(dir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);

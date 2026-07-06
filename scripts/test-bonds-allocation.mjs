// STEP 3 verification: the Bonds capability gates the ragged bond store. A
// Bonds=off model has effective maxBonds=0 (zero bond bytes) regardless of its
// config `maxBonds` ceiling; a Bonds!=off model keeps its store. The bond-off
// models stay byte-identical (they form no bonds) — proven by the parity harness.
//
// Run:  node scripts/test-bonds-allocation.mjs
import { build } from 'esbuild';
import { writeFileSync, rmSync, mkdtempSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os'; import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'ba-'));
const ep = join(ROOT, 'scripts', '__ba_entry.ts');
writeFileSync(ep, `
export { createAgentStore } from '../src/simulator/engine/agentEngine.ts';
export { resolveMaxBonds } from '../src/model/centerBased.ts';
export { resolveAgentProfile } from '../src/model/agentCapabilities.ts';
export { migrateForHarness } from '../src/dev/compileHarness.ts';
export { agentAttrsOf } from '../src/model/attributeScope.ts';
`);
const out = join(dir, 'b.mjs');
await build({ entryPoints: [ep], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error', absWorkingDir: process.cwd() });
const m = await import(pathToFileURL(out).href);
const P = join(ROOT, 'public', 'models');
let fail = 0, n = 0;
for (const f of readdirSync(P).filter(x => x.endsWith('.gcaproj'))) {
  const raw = JSON.parse(readFileSync(join(P, f), 'utf8'));
  if (!raw?.topologyMode?.agents) continue;
  const model = m.migrateForHarness(raw);
  const prof = m.resolveAgentProfile(model);
  const cfgMB = Math.max(0, Math.floor(model.centerBased?.maxBonds ?? 0));
  const effMB = m.resolveMaxBonds(model.centerBased);
  const specs = m.agentAttrsOf(model).map(a => ({ id: a.id, type: a.type, defaultValue: 0 }));
  const store = m.createAgentStore(model.centerBased, specs);
  const bondBytes = store.bondPartner.length * 4 + store.bondPartnerEpoch.length * 4 + store.bondTypeLabel.length * 4 + store.bondRestLength.length * 8 + store.bondStiffness.length * 8;
  const expectOff = prof.bonds === 'off';
  const okEff = expectOff ? effMB === 0 : effMB === cfgMB;
  const okStore = expectOff ? bondBytes === 0 : (cfgMB === 0 ? bondBytes === 0 : bondBytes > 0);
  n++;
  if (!okEff || !okStore) { fail++; console.log(`  ✗ ${f}: bonds=${prof.bonds} cfgMB=${cfgMB} effMB=${effMB} bondBytes=${bondBytes}`); }
}
console.log(`\n${fail === 0 ? 'BOND-ALLOCATION GATE ✓' : `${fail} FAILED ✗`}  (${n} agent samples)`);
rmSync(ep, { force: true }); rmSync(dir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);

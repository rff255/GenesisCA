// DEV check — for each agent sample model: gate (isAgentGraphWasmSupported) +
// the WASM agent module compiles cleanly + lists the node types it covers.
// Run from the repo root:  node scripts/check-agent-wasm-gate.mjs
import { build } from 'esbuild';
import { writeFileSync, rmSync, mkdtempSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = `
export { compileAgentGraphWasmForModel, isAgentGraphWasmSupported } from '../src/modeler/vpl/compiler/agentWasm/compile.ts';
export { migrateForHarness } from '../src/dev/compileHarness.ts';
export { instantiateAgentWasm } from '../src/modeler/vpl/compiler/agentWasm/compile.ts';
export { computeAgentMemoryLayout, computeAgentMaxHashBins } from '../src/simulator/engine/agentEngine.ts';
`;
const dir = mkdtempSync(join(tmpdir(), 'gca-gate-'));
const entryPath = join(ROOT, 'scripts', '__gate_entry.ts');
writeFileSync(entryPath, ENTRY);
const outPath = join(dir, 'bundle.mjs');
await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: process.cwd() });
const mod = await import(pathToFileURL(outPath).href);
const { compileAgentGraphWasmForModel, isAgentGraphWasmSupported, migrateForHarness, instantiateAgentWasm } = mod;

const modelsDir = join(ROOT, 'public', 'models');
const files = readdirSync(modelsDir).filter(f => f.endsWith('.gcaproj'));
const results = [];
for (const f of files) {
  let raw;
  try { raw = JSON.parse(readFileSync(join(modelsDir, f), 'utf8')); } catch { continue; }
  const model = migrateForHarness(raw);
  if (!model?.topologyMode?.agents) continue;   // agent models only
  const gate = isAgentGraphWasmSupported(model);
  let compileOk = false, err = null, types = [], bytesLen = 0, instOk = false;
  if (gate) {
    try {
      const r = compileAgentGraphWasmForModel(model);
      err = r.error || null;
      types = r.supportedTypes || [];
      bytesLen = r.bytes.length;
      compileOk = !r.error && r.bytes.length > 0;
      if (compileOk) {
        const mem = new WebAssembly.Memory({ initial: r.pages });
        try { await instantiateAgentWasm(r.bytes, mem); instOk = true; } catch (e) { err = 'instantiate: ' + (e?.message || e); }
      }
    } catch (e) { err = String(e?.message || e); }
  }
  results.push({ file: f, gate, compileOk, instOk, bytesLen, nTypes: types.length, err });
}
for (const r of results) {
  console.log(`${r.gate ? 'GATE✓' : 'GATE✗'} ${r.compileOk ? 'COMPILE✓' : 'COMPILE-'} ${r.instOk ? 'INST✓' : 'INST-'} bytes=${r.bytesLen} types=${r.nTypes}  ${r.file}${r.err ? '  ERR: ' + r.err : ''}`);
}
rmSync(entryPath, { force: true });
rmSync(dir, { recursive: true, force: true });

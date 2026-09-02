// Cross-target compile BYTE-IDENTITY regression tool.
//
// Compiles every library model (public/models/*.gcaproj) on all surfaces via the
// dev harness (`compileAll`) and hashes each emitted output (JS step/full code,
// WASM bytes, WGSL shader, agent JS/WASM/WebGPU, overseer driver). Two modes:
//
//   node scripts/check-compile-identity.mjs --capture <baseline.json>
//   node scripts/check-compile-identity.mjs --compare <baseline.json>
//
// Capture a baseline BEFORE a compiler-touching change, re-run with --compare
// after: any model whose emitted output changed is listed surface-by-surface.
// This is the proof standard for "existing models are byte-identical" (see
// CLAUDE.md — the N-D lookup-table work is the first consumer).
import { build } from 'esbuild';
import { writeFileSync, readFileSync, readdirSync, mkdtempSync } from 'fs';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = `export { compileAll, migrateForHarness } from '../src/dev/compileHarness.ts';\n`;
const dir = mkdtempSync(join(tmpdir(), 'gca-identity-'));
const entryPath = join(ROOT, 'scripts', '__identity_entry.ts');
writeFileSync(entryPath, ENTRY);
const outPath = join(dir, 'bundle.mjs');
await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: process.cwd() });
const { compileAll, migrateForHarness } = await import(pathToFileURL(outPath).href);

const mode = process.argv[2];
const file = process.argv[3];
if ((mode !== '--capture' && mode !== '--compare') || !file) {
  console.error('usage: node scripts/check-compile-identity.mjs --capture|--compare <baseline.json>');
  process.exit(2);
}

const sha = (s) => createHash('sha256').update(s ?? '').digest('hex').slice(0, 16);

const modelsDir = join(ROOT, 'public', 'models');
const files = readdirSync(modelsDir).filter((f) => f.endsWith('.gcaproj')).sort();
const result = {};
for (const f of files) {
  const model = migrateForHarness(JSON.parse(readFileSync(join(modelsDir, f), 'utf8')));
  const r = compileAll(model);
  result[f] = {
    'js.stepCode': sha(r.js.stepCode),
    'js.fullCode': sha(r.js.fullCode),
    // The CELL graph's GLOBAL once-per-event functions — the Grid Init Event and
    // every Grid Periodic Event. JS-on-CPU on EVERY compile target (the WASM /
    // WebGPU step compilers never see those roots), so they show up on NO other
    // surface here: without these two lines a regression in their param list or
    // their value-out preamble passes this gate silently. Same reasoning as
    // agent.divisionCode / agent.initCode below.
    'js.gridInitCode': sha(r.js.gridInitCode ?? ''),
    'js.gridPeriodicCode': sha(r.js.gridPeriodicCode ?? ''),
    'js.error': r.js.error,
    'wasm.bytes': sha(r.wasm.bytesJoined),
    'wasm.bytesLen': r.wasm.bytesLen,
    'wasm.error': r.wasm.error,
    'webgpu.shader': sha(r.webgpu.shaderCode),
    'webgpu.error': r.webgpu.error,
    'agent.behaviourCode': sha(r.agent.behaviourCode),
    // The DIVISION EVENT + AGENT INIT functions. They are JS-on-CPU on every
    // agent target (AGENT_WASM_CPU_ROOT_TYPES), so they show up on NO other
    // surface here — without these two lines a regression in the `division` /
    // `init` ABI (their param lists, their value-out preambles) passes this gate
    // silently. See docs/IMPACT_MAP_DIVISION_LIFECYCLE.md §5.5.
    'agent.divisionCode': sha(r.agent.divisionCode),
    'agent.initCode': sha(r.agent.initCode),
    // Population Periodic Events — the same argument, one root later.
    'agent.periodicCode': sha(r.agent.periodicCode ?? ''),
    'agent.error': r.agent.error,
    'agent.wasm.bytes': sha(r.agent.wasm.bytesJoined),
    'agent.wasm.error': r.agent.wasm.error,
    'agent.webgpu.shader': sha(r.agent.webgpu.shaderCode),
    'agent.webgpu.error': r.agent.webgpu.error,
    'agent.webgpu.om': sha((r.agent.webgpu.omShaders ?? []).map(o => `${o.mappingId}\n${o.code}`).join('\n---\n')),
    'agent.webgpu.omSupported': r.agent.webgpu.omSupported,
    'overseer.driver': sha(r.overseer.driverCode ?? ''),
    'overseer.error': r.overseer.error,
  };
  console.log(`compiled ${f}`);
}

if (mode === '--capture') {
  writeFileSync(file, JSON.stringify(result, null, 2));
  console.log(`\nbaseline captured: ${files.length} models -> ${file}`);
} else {
  const base = JSON.parse(readFileSync(file, 'utf8'));
  let diffs = 0;
  for (const f of Object.keys(base)) {
    if (!result[f]) { console.log(`MISSING model: ${f}`); diffs++; continue; }
    for (const k of Object.keys(base[f])) {
      const a = base[f][k], b = result[f][k];
      if (JSON.stringify(a) !== JSON.stringify(b)) { console.log(`DIFF ${f} :: ${k} :: ${a} -> ${b}`); diffs++; }
    }
  }
  for (const f of Object.keys(result)) if (!base[f]) console.log(`NEW model (not in baseline, ignored): ${f}`);
  console.log(diffs === 0 ? `\nBYTE-IDENTITY OK — ${Object.keys(base).length} models, all surfaces unchanged` : `\n${diffs} DIFF(S) FOUND`);
  process.exit(diffs === 0 ? 0 : 1);
}

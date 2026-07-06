// STEP 0 — 4-site agent-ABI FIELD-ORDER AUDIT. The three CPU-side ABI mirrors
// (compile.ts `buildAgent*Params`, the worker's `buildAgent*Args`, the parity
// harness's `buildArgs`) all DERIVE from the shared descriptor `deriveAgentAbi`
// (agentAbi.ts), so they cannot desync in ORDER by construction. This script is
// the standing guard that CATCHES a regression if someone hand-edits a site off
// the descriptor, plus the descriptor's internal invariants:
//
//   (A) compile.ts's PARAM name strings === the descriptor names, per kind, for
//       every shipped agent sample + a synthetic 2D+3D model (the worker + the
//       harness call `buildAgentAbiArgs` directly, so verifying compile matches
//       the descriptor closes the CPU 4-site loop).
//   (C) the 2D field list is a strict PREFIX of the 3D list (append-only z-block).
//   (D) no duplicate field names; every field has a valid cType.
//
// The cross-target SoA field-SET check (CPU AGENT_*_FIELDS vs the WebGPU
// AGENT_GPU_*_FIELDS) becomes load-bearing only once the SoA layout is
// profile-GATED (STEP 3) — until then both targets allocate the full struct, so
// that arm is a documented STEP-3 extension (see the note at the end).
//
// Run:  node scripts/audit-agent-layout.mjs   (exit 1 on any divergence)
import { build } from 'esbuild';
import { writeFileSync, rmSync, mkdtempSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os'; import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'audit-'));
const ep = join(ROOT, 'scripts', '__audit_entry.ts');
writeFileSync(ep, `
export { deriveAgentAbi } from '../src/modeler/vpl/compiler/agentAbi.ts';
export { buildAgentLoopParams, buildDivisionParams, buildAgentInitParams, agentAbiShapeOf } from '../src/modeler/vpl/compiler/compile.ts';
export { migrateForHarness } from '../src/dev/compileHarness.ts';
`);
const out = join(dir, 'b.mjs');
await build({ entryPoints: [ep], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error', absWorkingDir: process.cwd() });
const m = await import(pathToFileURL(out).href);
const { deriveAgentAbi, buildAgentLoopParams, buildDivisionParams, buildAgentInitParams, agentAbiShapeOf, migrateForHarness } = m;

const VALID_CTYPES = new Set(['f64[]', 'i32[]', 'u8[]', 'u32[]', 'clamped[]', 'scalar', 'obj', 'fn']);
const PARAM_FN = { loop: (model) => buildAgentLoopParams(model).params, division: buildDivisionParams, init: buildAgentInitParams };

let fail = 0, checks = 0;
const ok = (c, msg) => { checks++; if (!c) { fail++; console.log('  ✗ ' + msg); } };

function auditModel(name, model) {
  const shape = agentAbiShapeOf(model);
  for (const kind of ['loop', 'division', 'init']) {
    const fields = deriveAgentAbi(kind, shape);
    const names = fields.map(f => f.name);

    // (A) compile's PARAM string === the descriptor names.
    const paramStr = PARAM_FN[kind](model);
    ok(paramStr === names.join(', '), `${name} ${kind}: compile params match the descriptor`);

    // (D) no duplicate names; every cType valid.
    ok(new Set(names).size === names.length, `${name} ${kind}: no duplicate field names`);
    ok(fields.every(f => VALID_CTYPES.has(f.cType)), `${name} ${kind}: all cTypes valid`);

    // (C) 2D is a strict prefix of 3D (append-only z-block).
    const names2d = deriveAgentAbi(kind, { ...shape, is3d: false }).map(f => f.name);
    const names3d = deriveAgentAbi(kind, { ...shape, is3d: true }).map(f => f.name);
    ok(names3d.length >= names2d.length && names3d.slice(0, names2d.length).join(',') === names2d.join(','),
      `${name} ${kind}: 2D is a strict prefix of 3D`);
  }
}

// Every shipped agent sample (2D + 3D) + a synthetic minimal 2D/3D pair.
const P = join(ROOT, 'public', 'models');
let n = 0;
for (const f of readdirSync(P).filter(x => x.endsWith('.gcaproj'))) {
  let raw; try { raw = JSON.parse(readFileSync(join(P, f), 'utf8')); } catch { continue; }
  if (!raw?.topologyMode?.agents) continue;
  auditModel(f.replace('.gcaproj', ''), migrateForHarness(raw));
  n++;
}
// synthetic pair with agent attrs + a field + a lookup table (exercises the
// dynamic r_/w_/_field_ + `_lookupTables` slots in both dimensions).
for (const is3d of [false, true]) {
  const model = migrateForHarness({
    schemaVersion: 1,
    properties: { name: 'syn', dimension: is3d ? '3d' : '2d', gridWidth: 8, gridHeight: 8, gridDepth: is3d ? 8 : 1, boundaryTreatment: 'torus' },
    topologyMode: { gridCells: true, agents: true },
    centerBased: { enabled: true, maxAgents: 16, maxBonds: 3 },
    attributes: [
      { id: 'field1', name: 'f1', type: 'float', defaultValue: '0', agentAccess: 'readWrite' },
      { id: 'lt', name: 'lt', type: 'lookupTable', isModelAttribute: true },
    ],
    agentAttributes: [{ id: 'energy', name: 'e', type: 'float', defaultValue: '0' }],
    neighborhoods: [], mappings: [], indicators: [], variables: [], agentVariables: [],
    graphNodes: [], graphEdges: [], agentGraphNodes: [], agentGraphEdges: [], macroDefs: [],
  });
  auditModel(`synthetic ${is3d ? '3D' : '2D'}`, model);
  n++;
}

console.log(`\naudited ${n} agent models × 3 kinds — ${checks} checks`);
console.log(fail === 0 ? 'AGENT ABI FIELD-ORDER AUDIT ✓ (all 4 CPU sites in lockstep via the descriptor)' : `AUDIT FAILED ✗ (${fail} divergences)`);
console.log('NOTE: the cross-target SoA field-SET arm (CPU AGENT_*_FIELDS vs WebGPU AGENT_GPU_*_FIELDS) activates in STEP 3, when the layout becomes profile-gated.');
rmSync(ep, { force: true });
rmSync(dir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);

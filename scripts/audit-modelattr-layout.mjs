// MODEL-ATTRIBUTE SLOT LAYOUT AUDIT — the mirror-site drift guard.
//
//   node scripts/audit-modelattr-layout.mjs
//
// A colour model attribute occupies FOUR scalar slots (id_r/_g/_b/_a); every other
// model attribute occupies one. That expansion is consumed by six sites which must
// agree exactly:
//
//   1. sim.worker.ts        — cachedModelAttrs writer
//   2. SimulatorView.tsx    — the `init` message writer
//   3. wasm/layout.ts       — one f64 slot per key
//   4. webgpu/layout.ts     — one f32 slot per key
//   5. agentWasm/compile.ts — modelAttrKeysOf
//   6. agentWebgpu/compile  — agentWebGPUExtrasOf
//
// WHY THIS SCRIPT EXISTS: a partial edit does NOT crash. It silently shifts every
// subsequent attribute's offset in one target but not another, so the model runs
// and renders plausible garbage on WASM while JS looks fine. That is the same
// class as the agent-side "+64-cell corruption", which is why the agent ABI has
// scripts/audit-agent-layout.mjs — the model-attr split had no equivalent. This is
// it.
//
// All six now derive their slot list from the shared `modelAttrSlotKeys`
// (src/model/attributeScope.ts), so drift is structurally prevented rather than
// merely detected. This audit is defence-in-depth: it fails if a site stops
// routing through the helper, and it pins the colour-expansion contract itself.
//
// NB it deliberately does NOT assert the `lookupTable` filter is uniform — it is
// not, and that divergence is pre-existing and benign (the two layouts reserve a
// slot nothing reads). Unifying it would shift offsets on Chromatography /
// Accretor / Golly. See the note in attributeScope.ts.
import { build } from 'esbuild';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = `
export { modelAttrSlotKeys } from '../src/model/attributeScope.ts';
export { computeLayoutFromModel } from '../src/modeler/vpl/compiler/wasm/layout.ts';
export { computeWebGPULayout } from '../src/modeler/vpl/compiler/webgpu/layout.ts';
export { agentWebGPUExtrasOf } from '../src/modeler/vpl/compiler/agentWebgpu/compile.ts';
export { buildAgentLayoutExtras } from '../src/modeler/vpl/compiler/agentWasm/compile.ts';
export { EMPTY_MODEL } from '../src/model/defaultModel.ts';
`;
const dir = mkdtempSync(join(tmpdir(), 'gca-mattr-'));
const entryPath = join(ROOT, 'scripts', '__mattr_entry.ts');
writeFileSync(entryPath, ENTRY);
const outPath = join(dir, 'bundle.mjs');
await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: process.cwd() });
const M = await import(pathToFileURL(outPath).href);

let pass = 0, fail = 0;
const ok = (cond, what, detail = '') => {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL  ${what}${detail ? `\n        ${detail}` : ''}`); }
};
const section = (s) => console.log(`\n── ${s}`);

const attr = (o) => ({
  id: o.id, name: o.id, type: o.type, description: '',
  isModelAttribute: true, defaultValue: o.defaultValue ?? '0',
  ...o,
});

// ─────────────────────────────────────────── the expansion contract
section('modelAttrSlotKeys — the colour expansion contract');
ok(JSON.stringify(M.modelAttrSlotKeys({ id: 'tint', type: 'color' }))
   === JSON.stringify(['tint_r', 'tint_g', 'tint_b', 'tint_a']),
   'colour → exactly [_r, _g, _b, _a] in that order');
for (const t of ['float', 'integer', 'bool', 'tag', 'neighborIndex', 'lookupTable']) {
  ok(JSON.stringify(M.modelAttrSlotKeys({ id: 'x', type: t })) === JSON.stringify(['x']),
     `${t} → a single bare-id slot`);
}

// ─────────────────────────────────────────── cross-site agreement
section('cross-site agreement — a model with a colour attr between two scalars');
// The ordering matters: `before`/`after` bracket the colour attr so a wrong slot
// COUNT shows up as a shifted offset on `after`, not just a missing key.
const model = {
  ...M.EMPTY_MODEL,
  properties: { ...M.EMPTY_MODEL.properties, gridWidth: 8, gridHeight: 8 },
  attributes: [
    attr({ id: 'before', type: 'float', defaultValue: '1' }),
    attr({ id: 'tint', type: 'color', defaultValue: '#ff000080' }),
    attr({ id: 'after', type: 'float', defaultValue: '2' }),
    { id: 'cell', name: 'cell', type: 'bool', description: '', isModelAttribute: false, defaultValue: 'false' },
  ],
};

const expected = ['before', 'tint_r', 'tint_g', 'tint_b', 'tint_a', 'after'];

const wasm = M.computeLayoutFromModel(model);
const wasmKeys = Object.keys(wasm.modelAttrOffset);
ok(JSON.stringify(wasmKeys) === JSON.stringify(expected),
   'wasm/layout.ts slot list', `expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(wasmKeys)}`);
// f64 slots, 8 bytes apart, in declaration order — a wrong colour width shows here.
const wOff = expected.map(k => wasm.modelAttrOffset[k]);
ok(wOff.every((v, i) => i === 0 || v === wOff[i - 1] + 8),
   'wasm offsets are contiguous 8-byte f64 slots', JSON.stringify(wOff));

const gpu = M.computeWebGPULayout(model);
const gpuKeys = Object.keys(gpu.modelAttrOffset);
ok(JSON.stringify(gpuKeys) === JSON.stringify(expected),
   'webgpu/layout.ts slot list', `actual ${JSON.stringify(gpuKeys)}`);
const gOff = expected.map(k => gpu.modelAttrOffset[k]);
ok(gOff.every((v, i) => i === 0 || v === gOff[i - 1] + 4),
   'webgpu offsets are contiguous 4-byte f32 slots', JSON.stringify(gOff));

// Agent sites. agentWasm filters lookupTable; agentWebgpu does not — both are
// exercised here with no lookupTable present, so both must produce `expected`.
const aWasm = M.buildAgentLayoutExtras(model).modelAttrKeys ?? [];
ok(JSON.stringify(aWasm) === JSON.stringify(expected),
   'agentWasm modelAttrKeysOf slot list', `actual ${JSON.stringify(aWasm)}`);

const aGpu = M.agentWebGPUExtrasOf(model).modelAttrKeys ?? [];
ok(JSON.stringify(aGpu) === JSON.stringify(expected),
   'agentWebgpu agentWebGPUExtrasOf slot list', `actual ${JSON.stringify(aGpu)}`);

section('all four layout-deriving sites agree with each other');
const lists = { wasm: wasmKeys, webgpu: gpuKeys, agentWasm: aWasm, agentWebgpu: aGpu };
const ref = JSON.stringify(wasmKeys);
for (const [name, list] of Object.entries(lists)) {
  ok(JSON.stringify(list) === ref, `${name} matches wasm/layout.ts`, JSON.stringify(list));
}

section('a model with NO colour attr is unaffected (byte-identity guard)');
const plain = { ...model, attributes: model.attributes.filter(a => a.type !== 'color') };
const pKeys = Object.keys(M.computeLayoutFromModel(plain).modelAttrOffset);
ok(JSON.stringify(pKeys) === JSON.stringify(['before', 'after']),
   'no colour attr → no _r/_g/_b/_a slots at all', JSON.stringify(pKeys));

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

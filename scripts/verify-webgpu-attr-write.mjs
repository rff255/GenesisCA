// Guards the "drop the CPU sync attribute WRITE buffer on the WebGPU grid target"
// optimization (docs/HANDOFF_WEBGPU_CPU_ATTR_MEMORY.md). The direct sequel to
// verify-webgpu-nbr-table.mjs: that dropped the dead CPU neighbour table on the
// WebGPU target; THIS drops the next dead-weight — the sync attr WRITE
// double-buffer — so even a 600³ 3D WebGPU grid fits under the wasm32 4 GiB cap.
//
// Two invariants, both COMPUTED from the real modules (no logic replicated):
//
//   1. LAYOUT: computeLayoutFromModel with the write buffer ALIASED vs the full
//      (separate write region) differs by EXACTLY Σ writeable-attr-bytes (each
//      writeable attr's write region == its read region: cellsPerAttr *
//      bytesPerType, 8-aligned). The aliased layout for the shipped Accretor at
//      600³ FITS under the 4 GiB Memory cap (65536 pages) while the full one
//      OVERFLOWS it — the whole reason 600³ now loads on the WebGPU target. And
//      the aliased 300³/400³ layouts still fit (unchanged behaviour there).
//      NOTE: the nbr-table drop is ALREADY applied for a WebGPU model, so "full"
//      here means "nbr dropped, write buffer kept" — the residual dead weight
//      this fix removes.
//
//   2. WORKER DECISION: the shipped Accretor (WebGPU, 3D, sync) → the worker's
//      attrWriteAliased predicate (useWebGPU && gridCells && !async) is TRUE, and
//      the aliased layout reserves NO separate write region (every
//      attrWriteOffset[id] === its attrReadOffset[id]) while the full one does
//      (JS/WASM keep the separate buffer — byte-identical there).
//
// If this ever regresses (someone reserves the write buffer on WebGPU again, or
// the alias flag stops discriminating) one of these assertions fails loudly.
//
//   node scripts/verify-webgpu-attr-write.mjs
import { build } from 'esbuild';
import { writeFileSync, readFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY =
  `export { computeLayoutFromModel, bytesPerType, alignTo } from '../src/modeler/vpl/compiler/wasm/layout.ts';\n` +
  `export { migrateForHarness } from '../src/dev/compileHarness.ts';\n`;
const entryPath = join(ROOT, 'scripts', '__webgpu_attr_write_entry.ts');
writeFileSync(entryPath, ENTRY);
const dir = mkdtempSync(join(tmpdir(), 'gca-webgpu-attrw-'));
const outPath = join(dir, 'bundle.mjs');
await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: process.cwd() });
const { computeLayoutFromModel, bytesPerType, alignTo, migrateForHarness } = await import(pathToFileURL(outPath).href);

const PAGE = 65536;              // WebAssembly.Memory page size
const MAX_PAGES = 65536;         // wasm32 hard cap = 4 GiB
const GiB = 4 * 1024 * 1024 * 1024;

let failed = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  ok  ${label}${detail ? ' — ' + detail : ''}`);
  else { console.error(`FAIL  ${label}${detail ? ' — ' + detail : ''}`); failed++; }
};

// --- Load the shipped Accretor ----------------------------------------------
const model = migrateForHarness(JSON.parse(readFileSync(join(ROOT, 'public', 'models', 'Accretor.gcaproj'), 'utf8')));
const p = model.properties;

console.log('Accretor:', `${p.gridWidth}x${p.gridHeight}x${p.gridDepth}`,
  `dim=${p.dimension} boundary=${p.boundaryTreatment} useWebGPU=${p.useWebGPU}`,
  `updateMode=${p.updateMode}`,
  'attrs=' + model.attributes.filter(a => !a.isModelAttribute).map(a => a.id.slice(0, 8) + ':' + a.type).join(','));

// --- Invariant 2: the worker DECISION ----------------------------------------
const gridCells = model.topologyMode?.gridCells !== false;
const isAsync = p.updateMode === 'asynchronous';
// The SAME predicate the worker computes in the `init` handler for attrWriteAliased.
const attrWriteAliased = !!p.useWebGPU && gridCells && !isAsync;
ok('worker attrWriteAliased === true for the Accretor (WebGPU + sync grid)', attrWriteAliased);

// --- Invariant 1: the LAYOUT delta is exactly the write region ---------------
// computeLayoutFromModel(model, aliased) derives everything from the model. The
// second arg toggles ONLY the sync attr write buffer (the nbr table is dropped
// on BOTH sides here by passing neighborhoods:[] — it's already dropped for a
// WebGPU model, so it must not skew the write-buffer delta).
const layoutAt = (w, h, d, aliased) => {
  const m = structuredClone(model);
  m.properties.gridWidth = w; m.properties.gridHeight = h;
  m.properties.gridDepth = d; m.properties.dimension = '3d';
  m.neighborhoods = [];   // nbr table already dropped on the WebGPU target
  return computeLayoutFromModel(m, aliased);
};

// Writeable cell attrs = every non-model cell attr (constant boundary reserves
// total+1 cells per attr). The layout lays the READ block first (each attr
// 8-aligned then sized), then — in the full layout — the WRITE block right after
// (same rule, continuing the same offset). So the freed bytes == the write block,
// which we reproduce by continuing the same accumulator from the read-block end
// (its leading 8-align depends on where the read block landed — off-by-a-few if
// you naively restart at 0).
const cellAttrs = model.attributes.filter(a => a.isModelAttribute !== true);
const attrBlockEnd = (start, cellsPerAttr) => {
  let off = start;
  for (const a of cellAttrs) off = alignTo(off, 8) + cellsPerAttr * bytesPerType(a.type);
  return off;
};
const writeRegionBytes = (total) => {
  const cellsPerAttr = p.boundaryTreatment === 'torus' ? total : (total + 1);
  const readEnd = attrBlockEnd(0, cellsPerAttr);          // read block: from 0
  const writeEnd = attrBlockEnd(readEnd, cellsPerAttr);   // write block: continues
  return writeEnd - readEnd;
};

for (const N of [300, 400, 600]) {
  const total = N * N * N;
  const full = layoutAt(N, N, N, false);        // separate write buffer (JS/WASM)
  const aliased = layoutAt(N, N, N, true);       // write === read (WebGPU)
  const delta = full.totalBytes - aliased.totalBytes;
  const expectedWrite = writeRegionBytes(total);
  console.log(`\n[layout ${N}³] total=${total.toLocaleString()} cells`
    + ` full=${(full.totalBytes / GiB).toFixed(2)}GiB (${full.pages}p)`
    + ` aliased=${(aliased.totalBytes / GiB).toFixed(2)}GiB (${aliased.pages}p)`
    + ` writeRegion=${(delta / GiB).toFixed(2)}GiB`);
  ok(`${N}³ delta == the write region (Σ cellsPerAttr*bytesPerType, 8-aligned)`, delta === expectedWrite, `${delta} vs ${expectedWrite}`);
  ok(`${N}³ aliased layout reserves NO separate write region (write===read)`,
    cellAttrs.every(a => aliased.attrWriteOffset[a.id] === aliased.attrReadOffset[a.id]));
  ok(`${N}³ full layout DOES reserve a separate write region (JS/WASM keep it)`,
    cellAttrs.every(a => full.attrWriteOffset[a.id] !== full.attrReadOffset[a.id]));
  ok(`${N}³ aliased layout FITS under the 4 GiB cap`, aliased.pages <= MAX_PAGES, `${aliased.pages} <= ${MAX_PAGES} pages`);
}

// The headline: at 600³ the full (write-kept) layout OVERFLOWS the cap — the
// user's exact allocation error — while the aliased one fits. (At 300³/400³ both
// fit, so behaviour there is unchanged — only 600³ is unlocked by this fix.)
{
  const N = 600, total = N * N * N;
  const full = layoutAt(N, N, N, false);
  const aliased = layoutAt(N, N, N, true);
  ok('600³ full (write-kept) layout OVERFLOWS the 4 GiB cap (the reported error)',
    full.pages > MAX_PAGES, `${full.pages} > ${MAX_PAGES} pages`);
  ok('600³ aliased (write-dropped) layout FITS — 600³ now loads on WebGPU',
    aliased.pages <= MAX_PAGES, `${aliased.pages} <= ${MAX_PAGES} pages`);
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILURE(S)`);
process.exit(failed === 0 ? 0 : 1);

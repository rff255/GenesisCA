// Guards the "drop the dead CPU neighbour table on the WebGPU grid target"
// optimization (docs/HANDOFF_WEBGPU_NBR_TABLE_MEMORY.md).
//
// Two invariants, both COMPUTED from the real modules (no logic replicated):
//
//   1. LAYOUT: computeMemoryLayout with the neighbourhoods dropped ([]) vs full
//      differs by EXACTLY the per-cell neighbour region (Σ total*nSz*4); the
//      dropped layout for a 400³ 26-neighbour grid fits under the wasm32 4 GiB
//      Memory cap (65536 pages) while the full one overflows it. This is the
//      whole reason 400³ now loads on the WebGPU target.
//
//   2. WORKER DECISION: the shipped Accretor (WebGPU, 3D, SIE off) compiles CPU
//      init / gridInit / OM / inputColor functions whose source does NOT index a
//      neighbour table (`nIdx_<nbr>[`), while its STEP does — so the worker's
//      nbrTableDropped predicate is TRUE for it (only the GPU-only STEP reads
//      neighbours; its JS/WASM fallback is the one deliberately dropped).
//
// If this ever regresses (someone reserves the full table on WebGPU again, or a
// CPU function starts reading neighbours) one of these assertions fails loudly.
//
//   node scripts/verify-webgpu-nbr-table.mjs
import { build } from 'esbuild';
import { writeFileSync, readFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY =
  `export { computeMemoryLayout, computeLayoutFromModel } from '../src/modeler/vpl/compiler/wasm/layout.ts';\n` +
  `export { compileGraph } from '../src/modeler/vpl/compiler/compile.ts';\n` +
  `export { migrateForHarness } from '../src/dev/compileHarness.ts';\n`;
const entryPath = join(ROOT, 'scripts', '__webgpu_nbr_entry.ts');
writeFileSync(entryPath, ENTRY);
const dir = mkdtempSync(join(tmpdir(), 'gca-webgpu-nbr-'));
const outPath = join(dir, 'bundle.mjs');
await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: process.cwd() });
const { computeLayoutFromModel, compileGraph, migrateForHarness } = await import(pathToFileURL(outPath).href);

// The SAME predicate the worker's codeIndexesNeighbourTable() uses. A compiled
// param declaration is `nIdx_<nbr>,` (bare identifier + comma), so an identifier
// immediately followed by `[` appears only at a genuine read site.
const codeIndexesNeighbourTable = (code) => !!code && /nIdx_\w*\[/.test(code);

const PAGE = 65536;              // WebAssembly.Memory page size
const MAX_PAGES = 65536;         // wasm32 hard cap = 4 GiB
const GiB = 4 * 1024 * 1024 * 1024;

let failed = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  ok  ${label}${detail ? ' — ' + detail : ''}`);
  else { console.error(`FAIL  ${label}${detail ? ' — ' + detail : ''}`); failed++; }
};

// --- Load + compile the shipped Accretor -----------------------------------
const model = migrateForHarness(JSON.parse(readFileSync(join(ROOT, 'public', 'models', 'Accretor.gcaproj'), 'utf8')));
const p = model.properties;

console.log('Accretor:', `${p.gridWidth}x${p.gridHeight}x${p.gridDepth}`,
  `dim=${p.dimension} boundary=${p.boundaryTreatment} useWebGPU=${p.useWebGPU} sie=${p.skipIsolatedEmpty?.enabled}`,
  'nbrs=' + model.neighborhoods.map(n => n.id + ':' + ((n.coords3d?.length) || n.coords?.length || 0)).join(','));

// --- Invariant 2: the worker DECISION for the Accretor ----------------------
const js = compileGraph(model.graphNodes, model.graphEdges, model);
const stepReadsNbr = codeIndexesNeighbourTable(js.stepCode);
const cpuReadsNbr =
  codeIndexesNeighbourTable(js.initCode)
  || codeIndexesNeighbourTable(js.gridInitCode)
  || (js.outputMappingCodes ?? []).some((o) => codeIndexesNeighbourTable(o.code))
  || (js.inputColorCodes ?? []).some((ic) => codeIndexesNeighbourTable(ic.code));

console.log('\n[decision] Accretor compiled functions:');
ok('STEP reads neighbours (sanity — the accretion rule reads faces/edges/corners)', stepReadsNbr);
ok('init does NOT index nIdx_', !codeIndexesNeighbourTable(js.initCode));
ok('gridInit does NOT index nIdx_', !codeIndexesNeighbourTable(js.gridInitCode));
ok('OM passes do NOT index nIdx_', !(js.outputMappingCodes ?? []).some((o) => codeIndexesNeighbourTable(o.code)));
ok('inputColor passes do NOT index nIdx_', !(js.inputColorCodes ?? []).some((ic) => codeIndexesNeighbourTable(ic.code)));

const isAsync = p.updateMode === 'asynchronous';
const gridCells = model.topologyMode?.gridCells !== false;
const sieOn = !!p.skipIsolatedEmpty?.enabled && !isAsync && gridCells && !model.topologyMode?.agents && js.stepCode !== undefined;
const nbrTableDropped = !!p.useWebGPU && gridCells && !sieOn && !cpuReadsNbr;
ok('worker nbrTableDropped === true for the Accretor (WebGPU + no CPU neighbour reader)', nbrTableDropped);

// --- Invariant 1: the LAYOUT delta is exactly the neighbour region ----------
// computeLayoutFromModel derives everything (attrs / colours / indicators /
// lookup tables / scratch) from the model. Cloning it with neighborhoods:[] is
// EXACTLY the worker's dropped-table layout — every other region is identical.
const layoutAt = (w, h, d, neighborhoods) => {
  const m = structuredClone(model);
  m.properties.gridWidth = w; m.properties.gridHeight = h;
  m.properties.gridDepth = d; m.properties.dimension = '3d';
  m.neighborhoods = neighborhoods;
  return computeLayoutFromModel(m);
};

const nbrRegionBytes = (total) => model.neighborhoods.reduce((acc, n) => {
  const nSz = (n.coords3d?.length) || n.coords?.length || 0;
  // Each nbr region is 8-aligned then sized total*nSz*4 (see wasm/layout.ts).
  return Math.ceil(acc / 8) * 8 + total * nSz * 4;
}, 0);

for (const N of [300, 400, 512]) {
  const total = N * N * N;
  const full = layoutAt(N, N, N, model.neighborhoods);
  const dropped = layoutAt(N, N, N, []);
  const delta = full.totalBytes - dropped.totalBytes;
  const expectedNbr = nbrRegionBytes(total);
  console.log(`\n[layout ${N}³] total=${total.toLocaleString()} cells`
    + ` full=${(full.totalBytes / GiB).toFixed(2)}GiB (${full.pages}p)`
    + ` dropped=${(dropped.totalBytes / GiB).toFixed(2)}GiB (${dropped.pages}p)`
    + ` nbrRegion=${(delta / GiB).toFixed(2)}GiB`);
  ok(`${N}³ delta == the neighbour region (Σ total*nSz*4, 8-aligned)`, delta === expectedNbr, `${delta} vs ${expectedNbr}`);
  ok(`${N}³ dropped layout reserves NO neighbour region`, Object.keys(dropped.nbrIndexOffset).length === 0);
  ok(`${N}³ full layout DOES reserve the neighbour region (JS/WASM keep it)`, Object.keys(full.nbrIndexOffset).length === model.neighborhoods.length);
  ok(`${N}³ dropped layout FITS under the 4 GiB cap`, dropped.pages <= MAX_PAGES, `${dropped.pages} <= ${MAX_PAGES} pages`);
  if (N >= 400) {
    ok(`${N}³ full layout OVERFLOWS the 4 GiB cap (the original allocation error)`, full.pages > MAX_PAGES, `${full.pages} > ${MAX_PAGES} pages`);
  }
}

// --- Edge case (handoff Verify step 3): a WebGPU 3D model with a Grid Init
// Event AND a per-cell Init Event that READS A NEIGHBOUR attribute must KEEP the
// full table on the WebGPU target (runInit runs the CPU init, which indexes the
// real table). This asserts the flag routes it to the full-table path — the
// complement of the Accretor (whose init does NOT read neighbours -> dropped).
function buildInitReadsNbrModel(initReadsNbr) {
  const ids = new Set();
  const nid = (pre) => { let id; do { id = pre + Math.random().toString(36).slice(2, 9); } while (ids.has(id)); ids.add(id); return id; };
  const nodes = [], edges = [];
  const node = (nodeType, config) => { const n = { id: nid('n'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType, config: config || {} } }; nodes.push(n); return n; };
  const E = (s, sh, t, th) => edges.push({ id: nid('e'), source: s.id, target: t.id, sourceHandle: sh, targetHandle: th });

  // Minimal valid step: getCellAttribute -> setAttribute (no neighbour read).
  const step = node('step');
  const gcaS = node('getCellAttribute', { attributeId: 'alive' });
  const setS = node('setAttribute', { attributeId: 'alive' });
  E(step, 'output_flow_do', setS, 'input_flow_do');
  E(gcaS, 'output_value_value', setS, 'input_value_value');

  // A Grid Init Event (forces the CPU init path at runtime — gridInitFn !== null).
  node('gridInit');

  // A per-cell Init Event.
  const init = node('initEvent');
  const setI = node('setAttribute', { attributeId: 'alive' });
  E(init, 'output_flow_do', setI, 'input_flow_do');
  if (initReadsNbr) {
    // ...whose value READS A NEIGHBOUR (getNeighborsAttribute -> aggregate(sum)).
    const gnaI = node('getNeighborsAttribute', { neighborhoodId: 'moore3d', attributeId: 'alive' });
    const aggI = node('aggregate', { operation: 'sum' });
    E(gnaI, 'output_value_values', aggI, 'input_value_values');
    E(aggI, 'output_value_result', setI, 'input_value_value');
  } else {
    const gcaI = node('getCellAttribute', { attributeId: 'alive' });
    E(gcaI, 'output_value_value', setI, 'input_value_value');
  }

  const coords3d = [], coords2d = [];
  for (let dl = -1; dl <= 1; dl++) for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    if (dl === 0 && dr === 0 && dc === 0) continue; coords3d.push([dr, dc, dl]); coords2d.push([dr, dc]);
  }
  return migrateForHarness({
    schemaVersion: 1,
    properties: {
      name: 'edge-case', gridWidth: 32, gridHeight: 32, gridDepth: 32, dimension: '3d',
      boundaryTreatment: 'constant', updateMode: 'synchronous', asyncScheme: 'random-order',
      topology: '2d-grid', useWebGPU: true, useWasm: false, tags: [],
    },
    attributes: [{ id: 'alive', name: 'Alive', type: 'bool', description: '', defaultValue: 'false', isModelAttribute: false }],
    neighborhoods: [{ id: 'moore3d', name: 'Moore 3D', description: '', coords: coords2d, coords3d, margin: 2, includeCentralCell: false }],
    mappings: [], graphNodes: nodes, graphEdges: edges, macroDefs: [], indicators: [], variables: [],
  });
}

const decide = (model) => {
  const j = compileGraph(model.graphNodes, model.graphEdges, model);
  const cpu =
    codeIndexesNeighbourTable(j.initCode) || codeIndexesNeighbourTable(j.gridInitCode)
    || (j.outputMappingCodes ?? []).some((o) => codeIndexesNeighbourTable(o.code))
    || (j.inputColorCodes ?? []).some((ic) => codeIndexesNeighbourTable(ic.code));
  const sie = false;   // synthetic model has SIE off
  const dropped = !!model.properties.useWebGPU && model.topologyMode?.gridCells !== false && !sie && !cpu;
  return { initIndexesNbr: codeIndexesNeighbourTable(j.initCode), cpu, dropped, err: j.error };
};

console.log('\n[edge case] WebGPU 3D model, Grid Init Event + per-cell Init Event:');
const kept = decide(buildInitReadsNbrModel(true));
ok('init that READS a neighbour compiles clean', !kept.err, kept.err || '');
ok('init-reads-neighbour -> initCode indexes nIdx_', kept.initIndexesNbr);
ok('init-reads-neighbour -> table KEPT (nbrTableDropped === false)', kept.dropped === false);

const dropd = decide(buildInitReadsNbrModel(false));
ok('init that does NOT read neighbours compiles clean', !dropd.err, dropd.err || '');
ok('init-no-neighbour -> table DROPPED (the flag discriminates)', dropd.dropped === true && dropd.initIndexesNbr === false);

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILURE(S)`);
process.exit(failed === 0 ? 0 : 1);

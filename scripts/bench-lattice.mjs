// LATTICE (CA GRID) END-TO-END PHASE PROFILER — the grid sibling of
// scripts/bench-agent-engine.mjs. Where does each millisecond of a GRID
// generation go, on the JS and WASM compile targets, in 2D and 3D?
//
// It drives the REAL `sim.worker.ts` (bundled with a `self` shim) with REAL
// `init` / `step` / `colorPass` messages, so every number below is the code the
// app actually runs — the compiled step fn, `buildNeighborIndices`, the sync
// bulk copy, `computeLinkedIndicatorsFromBuffer`, `runColorPass`, the
// `sendColors` copy. Nothing is re-implemented (unlike the agent profiler,
// which had to copy the force loop).
//
// WebGPU is NOT covered here (no `navigator.gpu` in Node) — the WebGPU numbers
// in docs/PERF_REVIEW_LATTICE.md come from the in-browser probes documented
// there.
//
// Phases (per generation unless noted):
//   init        one-time: initGrid + buildNeighborIndices + compile/instantiate
//   nbrBytes    one-time: the per-cell neighbour index table reservation
//   step        the compiled step fn + the sync w->r bulk copy + indicator work
//               (measured as a whole: a `step` message with count=N,
//               skipColorPass, no colour ship)
//   colorPass   `colorPass` message: the Output Mapping loop over all cells
//   colorsShip  the `sendColors` Uint8ClampedArray copy of the colours buffer
//   getState    a full state serialize (the save path / the 3D readback proxy)
//
// Run from the repo root (large 3D rows want a bigger heap):
//   node --max-old-space-size=8192 scripts/bench-lattice.mjs
//   ONLY=gol,life3d node scripts/bench-lattice.mjs      (scenario ids, see SCEN)
import { build } from 'esbuild';
import { writeFileSync, rmSync, mkdtempSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// 1. Bundle the REAL worker with a `self` shim + the compiler entry points.
// ---------------------------------------------------------------------------
const ENTRY = `
import '../src/simulator/engine/sim.worker.ts';
export { compileGraph } from '../src/modeler/vpl/compiler/compile.ts';
export { compileGraphWasm } from '../src/modeler/vpl/compiler/wasm/compile.ts';
export { computeLayoutFromModel, buildViewerIds, computeMemoryLayout } from '../src/modeler/vpl/compiler/wasm/layout.ts';
export { migrateForHarness } from '../src/dev/compileHarness.ts';
export { expandVectorAttributes } from '../src/modeler/vpl/compiler/vectorAttr.ts';
export { buildLookupTablePayload } from '../src/modeler/vpl/compiler/variegation.ts';
export { hasGlyphsInModel } from '../src/modeler/vpl/compiler/glyphsUsage.ts';
`;

// The worker assigns `self.onmessage` at MODULE scope, so the shim must exist
// before the bundle body runs -> esbuild banner.
const BANNER = `
globalThis.__gcaOut = [];
globalThis.self = {
  _h: null,
  get onmessage() { return this._h; },
  set onmessage(fn) { this._h = fn; },
  postMessage(m) { globalThis.__gcaOut.push(m); },
};
globalThis.__gcaPost = (m) => { globalThis.self._h({ data: m }); };
if (typeof globalThis.navigator === 'undefined') globalThis.navigator = {};
`;

const dir = mkdtempSync(join(tmpdir(), 'gca-benchl-'));
const entryPath = join(ROOT, 'scripts', '__benchl_entry.ts');
writeFileSync(entryPath, ENTRY);
const outPath = join(dir, 'bundle.mjs');
await build({
  entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node',
  outfile: outPath, logLevel: 'error', absWorkingDir: process.cwd(),
  banner: { js: BANNER },
});
const m = await import(pathToFileURL(outPath).href);
const {
  compileGraph, compileGraphWasm, computeLayoutFromModel, buildViewerIds, computeMemoryLayout,
  migrateForHarness, expandVectorAttributes, buildLookupTablePayload, hasGlyphsInModel,
} = m;
const post = globalThis.__gcaPost;
const outbox = globalThis.__gcaOut;

// ---------------------------------------------------------------------------
// 2. Model loading + the init message (mirrors SimulatorView's construction).
// ---------------------------------------------------------------------------
function loadModel(name) {
  const file = join(ROOT, 'public', 'models', `${name}.gcaproj`);
  return migrateForHarness(JSON.parse(readFileSync(file, 'utf8')));
}

// SimulatorView's `toAttrDefMsg` — the fields the worker's AttrDef needs.
function toAttrDefMsg(a) {
  return {
    id: a.id, type: a.type, defaultValue: a.defaultValue, tagOptions: a.tagOptions,
    isModelAttribute: a.isModelAttribute, boundaryValue: a.boundaryValue,
    parentAttributeId: a.parentAttributeId, parentValues: a.parentValues,
    undefinedValue: a.undefinedValue, facePatternAssignments: a.facePatternAssignments,
    neighborhoodHintId: a.neighborhoodHintId, agentAccess: a.agentAccess,
  };
}

// `withEffectiveNeighborhoods` — the includeCentralCell expansion.
function effectiveNeighborhoods(model) {
  return model.neighborhoods.map(n => {
    if (!n.includeCentralCell) return n;
    const coords = [...n.coords, [0, 0]];
    const coords3d = n.coords3d ? [...n.coords3d, [0, 0, 0]] : undefined;
    return { ...n, coords, coords3d };
  });
}

function buildInit(model, opts = {}) {
  const p = model.properties;
  const w = opts.W ?? p.gridWidth, h = opts.H ?? p.gridHeight;
  const is3d = (p.dimension ?? '2d') === '3d';
  const d = is3d ? (opts.D ?? p.gridDepth ?? 1) : 1;
  // NB the `sie` override MUST reach the COMPILE too: `sparseSteppingEnabled`
  // drives the emitted loop shape AND the baked layout (active-list region +
  // compact packed-offset neighbour tables). Overriding only the init message
  // would leave the worker building a sparse layout for a non-sparse module —
  // a silent offset desync.
  const dimsModel = { ...model, properties: { ...p, gridWidth: w, gridHeight: h, gridDepth: d, ...(opts.sie ? { skipIsolatedEmpty: opts.sie } : {}) } };
  const js = compileGraph(model.graphNodes, model.graphEdges, dimsModel);
  if (js.error) throw new Error('JS compile: ' + js.error);
  let wasm = { error: 'skipped' };
  try {
    const layout = computeLayoutFromModel(dimsModel);
    wasm = compileGraphWasm(model.graphNodes, model.graphEdges, dimsModel, layout, buildViewerIds(dimsModel));
  } catch (e) { wasm = { error: String(e?.message || e) }; }
  const eff = effectiveNeighborhoods(dimsModel);
  const viewer = (model.mappings || []).find(mp => mp.isAttributeToColor)?.id ?? '';
  return {
    initMsg: {
      type: 'init', width: w, height: h, depth: d,
      attributes: expandVectorAttributes(model.attributes).map(toAttrDefMsg),
      agentAttributes: [],
      neighborhoods: eff.map(n => ({ id: n.id, coords: n.coords, coords3d: n.coords3d })),
      boundaryTreatment: p.boundaryTreatment,
      updateMode: p.updateMode || 'synchronous',
      asyncScheme: p.asyncScheme || 'random-order',
      stepCode: js.stepCode, initCode: js.initCode, gridInitCode: js.gridInitCode,
      skipIsolatedEmpty: opts.sie ?? p.skipIsolatedEmpty,
      inputColorCodes: js.inputColorCodes, outputMappingCodes: js.outputMappingCodes,
      stopMessages: js.stopMessages ?? [],
      activeViewer: viewer,
      variegated: model.variegatedCells?.enabled ? {
        sourceAttributeId: model.variegatedCells.sourceAttributeId,
        facePalettes: model.variegatedCells.facePalettes,
        facePatterns: model.variegatedCells.facePatterns,
        facePatternAssignments: (model.attributes.find(a => a.id === model.variegatedCells.sourceAttributeId)?.facePatternAssignments) || {},
      } : undefined,
      interactionTables: model.attributes
        .filter(a => a.isModelAttribute && a.type === 'lookupTable')
        .map(a => buildLookupTablePayload(a, dimsModel)),
      indicators: (opts.noIndicators ? [] : (model.indicators || [])).map(i => ({
        id: i.id, kind: i.kind, dataType: i.dataType, defaultValue: i.defaultValue,
        accumulationMode: i.accumulationMode, tagOptions: i.tagOptions,
        linkedAttributeId: i.linkedAttributeId, linkedAggregation: i.linkedAggregation,
        binCount: i.binCount, xAxis: i.xAxis, spatialBinMode: i.spatialBinMode,
        spatialBinCount: i.spatialBinCount, spatialBinSize: i.spatialBinSize,
        trackedValues: i.trackedValues, watched: i.watched,
      })),
      wasmStepBytes: wasm.error ? undefined : wasm.bytes,
      wasmStepError: wasm.error, wasmExports: wasm.exports, viewerIds: wasm.viewerIds,
      useWasm: !!opts.useWasm,
      useWebGPU: false, webgpuStopCheckInterval: 1,
      hasGlyphs: hasGlyphsInModel(dimsModel),
      agents: false, gridCells: true,
      agentUsesField: false, agentUsesDensity: false,
    },
    js, wasm, dimsModel, w, h, d,
  };
}

// ---------------------------------------------------------------------------
// 3. Timing helpers. The worker is synchronous for JS/WASM grids: a `step`
//    message returns after the whole batch, and pushes exactly one `stepped`.
// ---------------------------------------------------------------------------
function drain() { outbox.length = 0; }
function lastOf(type) { for (let i = outbox.length - 1; i >= 0; i--) if (outbox[i].type === type) return outbox[i]; return null; }
/** CRITICAL: `tryInstantiateWasmModule` resolves a PROMISE — right after a
 *  synchronous `init` post, `wasmStepFn` is still null and a step would silently
 *  run the JS fallback. The real app always has an event-loop gap between init
 *  and the first step; the harness must reproduce it. */
const tick = () => new Promise(r => setTimeout(r, 0));

function timeIt(fn, { budgetMs = 4000, minReps = 3, maxReps = 200 } = {}) {
  const t0 = performance.now();
  let reps = 0;
  while (reps < maxReps && (reps < minReps || performance.now() - t0 < budgetMs)) { fn(); reps++; }
  const dt = performance.now() - t0;
  return { ms: dt / reps, reps };
}

function fmt(v) {
  if (v == null || !Number.isFinite(v)) return '     —';
  return v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v >= 1 ? v.toFixed(2) : v.toFixed(3);
}
const pad = (s, n) => String(s).padStart(n);

// ---------------------------------------------------------------------------
// 4. Scenarios.
// ---------------------------------------------------------------------------
const AVAILABLE = readdirSync(join(ROOT, 'public', 'models')).filter(f => f.endsWith('.gcaproj')).map(f => f.slice(0, -8));

// (id, model, dims list) — dims are [W,H,D]; 3D models get 3-tuples.
const SCEN = [
  { id: 'gol', model: 'Game Of Life', note: '2D bool, Moore, no indicators', dims: [[256, 256, 1], [1024, 1024, 1], [2048, 2048, 1]] },
  { id: 'grayscott', model: 'Gray-Scott Reaction-Diffusion', note: '2D float, math-heavy', dims: [[256, 256, 1], [1024, 1024, 1]] },
  { id: 'wireworld', model: 'Extended Wireworld', note: '2D tag + 2 linked indicators', dims: [[256, 256, 1], [1024, 1024, 1]] },
  { id: 'kelp', model: 'Kelp War', note: '2D tag, 1 indicator, RNG', dims: [[256, 256, 1], [1024, 1024, 1]] },
  { id: 'mnca', model: 'MNCA - Multi Neighborhood CA', note: '2D, 4 large neighbourhoods', dims: [[256, 256, 1], [512, 512, 1]] },
  { id: 'life3d', model: 'Life3D', note: '3D bool, Moore-26', dims: [[32, 32, 32], [64, 64, 64], [96, 96, 96]] },
  { id: 'accretor', model: 'Accretor', note: '3D tag, 3 neighbourhoods, N-D table', dims: [[64, 64, 64], [128, 128, 128]] },
  { id: 'amphi', model: 'Amphiphile', note: '2D ASYNC (variegated)', dims: [[256, 256, 1], [512, 512, 1]] },
];

const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',').map(s => s.trim())) : null;
const scenarios = SCEN.filter(s => AVAILABLE.includes(s.model) && (!ONLY || ONLY.has(s.id)));

console.log('LATTICE PHASE PROFILER — real sim.worker.ts, real compiled JS + instantiated WASM');
console.log('node ' + process.version + '   ' + new Date().toISOString());

// --- ASSERT the WASM target really engages (the async-instantiate trap:
// `tryInstantiateWasmModule` resolves a promise, so a step posted in the SAME
// synchronous turn as `init` silently runs the JS fallback). Booby-trap the JS
// stepCode with a throwing function: if WASM is live it is never called. ---
{
  const gm = loadModel('Game Of Life'); delete gm.simulationState;
  const r = buildInit(gm, { W: 64, H: 64, D: 1, useWasm: true });
  const trap = { ...r.initMsg, stepCode: '(function(){ throw new Error("JS_STEP_RAN"); })' };
  const probe = async (withTick) => {
    drain(); post(trap); if (withTick) await tick();
    try { post({ type: 'step', count: 1, activeViewer: r.initMsg.activeViewer, skipColorPass: true }); return 'wasm'; }
    catch (e) { return String(e?.message).includes('JS_STEP_RAN') ? 'js' : 'err:' + e?.message; }
  };
  const noTick = await probe(false), withTick = await probe(true);
  const ok = withTick === 'wasm' && noTick === 'js';
  console.log(`WASM-engaged assertion (throwing JS stepCode): same-turn=${noTick}, after-tick=${withTick} -> ${ok ? 'PASS' : 'CHECK'}`);
  if (!ok) process.exitCode = 1;
}

for (const sc of scenarios) {
  let base;
  try { base = loadModel(sc.model); } catch (e) { console.log(`\nSKIP ${sc.id}: ${e.message}`); continue; }
  // Strip any embedded simulation state — we always start from a clean init.
  delete base.simulationState;
  console.log(`\n=== ${sc.model}  [${sc.id}]  ${sc.note}`);
  const rows = [];
  for (const [W, H, D] of sc.dims) {
    for (const target of ['js', 'wasm']) {
      let r;
      try {
        r = buildInit(base, { W, H, D, useWasm: target === 'wasm' });
      } catch (e) { console.log(`  ${W}x${H}x${D} ${target}: compile failed — ${e.message}`); continue; }
      if (target === 'wasm' && r.wasm.error) { console.log(`  ${W}x${H}x${D} wasm: ${r.wasm.error}`); continue; }
      const total = W * H * D;

      // --- one-time init (allocation + neighbour tables + eval/instantiate) ---
      drain();
      const t0 = performance.now();
      post(r.initMsg);
      const initMs = performance.now() - t0;
      await tick();   // let the WASM module instantiate (async)
      const err = outbox.find(o => o.type === 'error');
      if (err) { console.log(`  ${W}x${H}x${D} ${target}: worker error — ${err.message}`); continue; }

      // Neighbour table reservation (the memory finding).
      const eff = effectiveNeighborhoods(r.dimsModel);
      const nbrCells = eff.reduce((a, n) => a + ((n.coords3d ?? n.coords).length), 0);
      const nbrBytes = total * nbrCells * 4;
      const memLayout = computeMemoryLayout(
        r.dimsModel.attributes.filter(a => !a.isModelAttribute),
        r.dimsModel.attributes.filter(a => a.isModelAttribute),
        eff, r.dimsModel.indicators ?? [], total,
        (r.dimsModel.properties.updateMode === 'asynchronous'),
        r.dimsModel.properties.boundaryTreatment,
      );

      // --- warm ---
      drain(); post({ type: 'step', count: 3, activeViewer: r.initMsg.activeViewer, skipColorPass: true });

      // --- step batch (no colour pass, no colours ship measured separately) ---
      const N = total > 4e6 ? 2 : total > 1e6 ? 5 : total > 2e5 ? 20 : 50;
      const stepT = timeIt(() => {
        drain();
        post({ type: 'step', count: N, activeViewer: r.initMsg.activeViewer, skipColorPass: true });
      }, { budgetMs: 3500, minReps: 2, maxReps: 40 });
      const stepPerGen = stepT.ms / N;

      // --- colour pass alone. The JS/WASM `colorPass` handler runs its body in
      //     an async IIFE, so a synchronous timer around `post()` measures
      //     NOTHING — post K of them, then drain the microtask queue with one
      //     macrotask tick and divide. ---
      const K = total > 2e6 ? 3 : 20;
      const cp0 = performance.now();
      for (let i = 0; i < K; i++) { drain(); post({ type: 'colorPass', activeViewer: r.initMsg.activeViewer }); }
      await tick();
      const cpT = { ms: (performance.now() - cp0) / K };

      // --- the per-FRAME colours ship: `sendColors` does
      //     `new Uint8ClampedArray(colors)` (a total*4-byte copy) then a
      //     transferred postMessage. Measured directly — differencing two noisy
      //     step batches drowns it. ---
      const colorsSrc = new Uint8ClampedArray(total * 4);
      const shipT = timeIt(() => { const c = new Uint8ClampedArray(colorsSrc); if (c[0] === 12345) throw 0; },
        { budgetMs: 800, minReps: 5, maxReps: 200 });

      // --- the sync w->r bulk copy the WASM target pays every generation
      //     (`attrsA[id].set(attrsB[id])` per cell attr). JS gets it free via a
      //     ref swap. Measured over the model's REAL attribute set/types. ---
      let bulkMs = 0;
      if (r.dimsModel.properties.updateMode !== 'asynchronous') {
        const cellA = r.dimsModel.attributes.filter(a => !a.isModelAttribute);
        const mk = t => t === 'float' ? new Float64Array(total) : (t === 'bool' ? new Uint8Array(total) : new Int32Array(total));
        const pairs = cellA.map(a => [mk(a.type), mk(a.type)]);
        bulkMs = timeIt(() => { for (const [a, b] of pairs) a.set(b); }, { budgetMs: 800, minReps: 5, maxReps: 200 }).ms;
      }

      rows.push({
        W, H, D, total, target, initMs, nbrBytes, layoutBytes: memLayout.pages * 65536,
        stepPerGen, colorPassMs: cpT.ms, shipMs: shipT.ms, bulkMs,
        colorsBytes: total * 4, N,
      });
    }
  }
  if (!rows.length) continue;
  console.log('    grid              tgt   step/gen  bulkCopy  colourPass  colShip     init    nbrTable    wasmMem  colours');
  for (const x of rows) {
    const dim = `${x.W}x${x.H}${x.D > 1 ? 'x' + x.D : ''}`;
    console.log('    ' + dim.padEnd(16) + ' ' + x.target.padEnd(5)
      + pad(fmt(x.stepPerGen), 8) + 'ms'
      + pad(fmt(x.bulkMs), 8) + 'ms'
      + pad(fmt(x.colorPassMs), 10) + 'ms'
      + pad(fmt(x.shipMs), 7) + 'ms'
      + pad(fmt(x.initMs), 8) + 'ms'
      + pad((x.nbrBytes / 1048576).toFixed(1), 9) + 'MB'
      + pad((x.layoutBytes / 1048576).toFixed(1), 9) + 'MB'
      + pad((x.colorsBytes / 1048576).toFixed(1), 8) + 'MB');
  }
  for (const [W, H, D] of sc.dims) {
    const j = rows.find(x => x.target === 'js' && x.W === W && x.D === D);
    const wa = rows.find(x => x.target === 'wasm' && x.W === W && x.D === D);
    if (j && wa) console.log(`    WASM/JS step speedup @ ${W}x${H}${D > 1 ? 'x' + D : ''}: ${(j.stepPerGen / wa.stepPerGen).toFixed(2)}x`);
  }
}

// ---------------------------------------------------------------------------
// 5. Focused micro-measurements the table can't isolate.
// ---------------------------------------------------------------------------
console.log('\n=== FOCUSED: indicator scan cost (Extended Wireworld 1024x1024, WASM; 2 linked defs) ===');
try {
  const mm = loadModel('Extended Wireworld'); delete mm.simulationState;
  // Both orders — the first-measured config is COLD (JIT + page-fault warmup),
  // which produced a nonsense "indicators make it faster" result before.
  for (const order of [[true, false], [false, true]]) {
    const line = [];
    for (const noInd of order) {
      const r = buildInit(mm, { W: 1024, H: 1024, D: 1, useWasm: true, noIndicators: noInd });
      drain(); post(r.initMsg); await tick();
      for (let i = 0; i < 3; i++) { drain(); post({ type: 'step', count: 10, activeViewer: r.initMsg.activeViewer, skipColorPass: true }); }
      // 1 gen per batch so the per-gen scan is NOT amortized by the batch tail.
      const t = timeIt(() => { drain(); post({ type: 'step', count: 1, activeViewer: r.initMsg.activeViewer, skipColorPass: true }); }, { budgetMs: 2500, minReps: 5, maxReps: 60 });
      line.push(`${noInd ? 'OFF' : 'ON '} ${fmt(t.ms)} ms/gen`);
    }
    console.log('    ' + line.join('   |   ') + `   (order: ${order.map(x => x ? 'OFF' : 'ON').join(' then ')})`);
  }
} catch (e) { console.log('    skipped: ' + e.message); }

console.log('\n=== FOCUSED: batch size (deferred indicator scan) — Extended Wireworld 1024x1024 WASM ===');
try {
  const mm = loadModel('Extended Wireworld'); delete mm.simulationState;
  const r = buildInit(mm, { W: 1024, H: 1024, D: 1, useWasm: true });
  drain(); post(r.initMsg); await tick();
  drain(); post({ type: 'step', count: 3, activeViewer: r.initMsg.activeViewer, skipColorPass: true });
  for (const N of [1, 5, 20]) {
    const t = timeIt(() => { drain(); post({ type: 'step', count: N, activeViewer: r.initMsg.activeViewer, skipColorPass: true }); }, { budgetMs: 2500, minReps: 2, maxReps: 40 });
    console.log(`    gens/frame ${pad(N, 3)}: ${fmt(t.ms / N)} ms/gen  (batch ${fmt(t.ms)} ms)`);
  }
} catch (e) { console.log('    skipped: ' + e.message); }

// The 3D render tax: a 3D grid never gets WebGPU direct render (the attach is
// gated `!is3D`), so EVERY frame the colours buffer crosses worker->main and the
// main thread re-scans it in `Gl3DRenderer.uploadColors` (a per-cell alpha test
// + instance compaction into a `total*5` Float32Array). Both are O(total) and
// both are on the critical path of a 3D frame — replicated verbatim here.
console.log('\n=== FOCUSED: 3D render tax per FRAME (gl3d.uploadColors scan + instance buffer) ===');
{
  for (const [W, H, D, fill] of [[64, 64, 64, 0.10], [128, 128, 128, 0.05], [300, 300, 300, 0.02]]) {
    const total = W * H * D;
    let colorsBuf;
    try { colorsBuf = new Uint8ClampedArray(total * 4); } catch (e) { console.log(`    ${W}^3: alloc failed — ${e.message}`); continue; }
    for (let i = 0; i < total; i++) if ((i * 2654435761 % 1000) / 1000 < fill) colorsBuf[i * 4 + 3] = 255;
    let inst;
    try { inst = new Float32Array(total * 5); } catch (e) { console.log(`    ${W}^3: instData(${(total * 20 / 1048576).toFixed(0)} MB) alloc failed — ${e.message}`); continue; }
    const u = new Uint32Array(inst.buffer);
    const scan = timeIt(() => {
      let n = 0;
      for (let i = 0; i < total; i++) {
        const a = colorsBuf[i * 4 + 3];
        if (a !== 0) { const o = n * 5; u[o] = i; inst[o + 1] = colorsBuf[i * 4] / 255; inst[o + 2] = colorsBuf[i * 4 + 1] / 255; inst[o + 3] = colorsBuf[i * 4 + 2] / 255; inst[o + 4] = a / 255; n++; }
      }
      if (n === -1) throw 0;
    }, { budgetMs: 1500, minReps: 2, maxReps: 30 });
    const ship = timeIt(() => { const c = new Uint8ClampedArray(colorsBuf); if (c[0] === 12345) throw 0; }, { budgetMs: 800, minReps: 3, maxReps: 50 });
    console.log(`    ${String(W + '^3').padEnd(7)} total=${(total / 1e6).toFixed(1)}M  colours=${(total * 4 / 1048576).toFixed(0)} MB`
      + `   worker copy ${fmt(ship.ms)} ms  +  main-thread uploadColors scan ${fmt(scan.ms)} ms`
      + `   instData reservation ${(total * 20 / 1048576).toFixed(0)} MB`);
  }
}

console.log('\n=== FOCUSED: Skip Isolated Empty Cells (Accretor 128^3, WASM) ===');
try {
  const mm = loadModel('Accretor'); delete mm.simulationState;
  for (const on of [false, true]) {
    const sie = { ...(mm.properties.skipIsolatedEmpty ?? {}), enabled: on };
    const r = buildInit(mm, { W: 128, H: 128, D: 128, useWasm: true, sie });
    drain();
    const t0 = performance.now(); post(r.initMsg); const initMs = performance.now() - t0; await tick();
    drain(); post({ type: 'reset', activeViewer: r.initMsg.activeViewer });
    drain(); post({ type: 'step', count: 2, activeViewer: r.initMsg.activeViewer, skipColorPass: true });
    const t = timeIt(() => { drain(); post({ type: 'step', count: 5, activeViewer: r.initMsg.activeViewer, skipColorPass: true }); }, { budgetMs: 4000, minReps: 2, maxReps: 20 });
    const last = lastOf('stepped');
    console.log(`    SIE ${on ? 'ON ' : 'OFF'}: ${fmt(t.ms / 5)} ms/gen   init ${fmt(initMs)} ms   active=${last?.sieActive ?? 'n/a'}`);
  }
} catch (e) { console.log('    skipped: ' + e.message); }

rmSync(entryPath, { force: true });
rmSync(dir, { recursive: true, force: true });

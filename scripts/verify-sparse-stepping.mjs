// Correctness proof for "Skip Isolated Empty Cells" (docs/PLAN_LARGE_GRID_PERF.md).
//
// Proves the SPARSE compiled step (feature ON, iterating the active-cell list)
// produces BYTE-FOR-BYTE identical grids to the FULL loop (feature's own runtime
// `if (_activeList)` else-branch, i.e. 0..total), on the REAL compiled step
// function + the REAL shared active-set module (src/simulator/engine/activeSet.ts)
// — so it tests exactly what the worker runs, no browser needed.
//
//   node scripts/verify-sparse-stepping.mjs            # JS target
//   node scripts/verify-sparse-stepping.mjs --wasm     # + WASM target (Phase 2)
//
// Builds minimal 2D + 3D accretion models (empty cell with >=1 occupied Moore
// neighbour -> A; occupied cells frozen) with the feature enabled, runs FULL and
// SPARSE in lockstep, and asserts identical grids after every step.
import { build } from 'esbuild';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = `
export { compileAll, migrateForHarness } from '../src/dev/compileHarness.ts';
export { buildActiveOffsets, createActiveSet, rebuildActiveSet, applyTransition, compactActiveSet } from '../src/simulator/engine/activeSet.ts';
export { compileGraphWasm } from '../src/modeler/vpl/compiler/wasm/compile.ts';
export { computeLayoutFromModel } from '../src/modeler/vpl/compiler/wasm/layout.ts';
`;
const dir = mkdtempSync(join(tmpdir(), 'gca-sparse-'));
const entryPath = join(ROOT, 'scripts', '__sparse_entry.ts');
writeFileSync(entryPath, ENTRY);
const outPath = join(dir, 'bundle.mjs');
await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: process.cwd() });
const M = await import(pathToFileURL(outPath).href);
const { compileAll, migrateForHarness, buildActiveOffsets, createActiveSet, rebuildActiveSet, applyTransition, compactActiveSet } = M;

const wantWasm = process.argv.includes('--wasm');

// ---- minimal accretion model (empty + >=1 occupied Moore neighbour -> A) ----
function buildModel(is3d) {
  // Grid sized so the growing structure stays WELL within it over the step
  // budget → the active set stays sparse (maxActive << total), genuinely
  // exercising the sparse path throughout (not degenerating to a full grid).
  const W = is3d ? 60 : 140, H = W, D = is3d ? 60 : 1;
  const nodes = [], edges = [];
  let c = 0;
  const nid = (p) => p + (c++).toString(36);
  const node = (nodeType, config) => { const n = { id: nid('n'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType, config } }; nodes.push(n); return n; };
  const vE = (s, sp, t, tp) => edges.push({ id: nid('e'), source: s.id, target: t.id, sourceHandle: `output_value_${sp}`, targetHandle: `input_value_${tp}` });
  const fE = (s, sp, t, tp) => edges.push({ id: nid('e'), source: s.id, target: t.id, sourceHandle: `output_flow_${sp}`, targetHandle: `input_flow_${tp}` });

  const coords = [], coords3d = [];
  const zr = is3d ? 1 : 0;
  for (let dl = -zr; dl <= zr; dl++) for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    if (!dr && !dc && !dl) continue;
    coords.push([dr, dc]); coords3d.push([dr, dc, dl]);
  }

  const step = node('step', {});
  const myState = node('getCellAttribute', { attributeId: 'state' });
  const isEmpty = node('statement', { operation: '==', compareType: 'numerical', _port_y: '0' }); vE(myState, 'value', isEmpty, 'x');
  const nbrArr = node('getNeighborsAttribute', { neighborhoodId: 'moore', attributeId: 'state' });
  const cnt = node('groupCounting', { operation: 'greater' }); vE(nbrArr, 'values', cnt, 'values');
  const ge1 = node('statement', { operation: '>=', compareType: 'numerical', _port_y: '1' }); vE(cnt, 'count', ge1, 'x');
  const can = node('logicOperator', { operation: 'AND' }); vE(isEmpty, 'result', can, 'a'); vE(ge1, 'result', can, 'b');
  const gate = node('conditional', {}); fE(step, 'do', gate, 'check'); vE(can, 'result', gate, 'condition');
  const write = node('setAttribute', { attributeId: 'state', _port_value: '1' }); fE(gate, 'then', write, 'do');

  const model = {
    schemaVersion: 2,
    properties: {
      name: 'sparse-test', author: '', modelAuthor: '', description: '',
      topology: '2d-grid', boundaryTreatment: 'constant', updateMode: 'synchronous', asyncScheme: 'random-order',
      gridWidth: W, gridHeight: H, gridDepth: D, dimension: is3d ? '3d' : '2d', maxIterations: 100000, tags: [], useWasm: false,
      skipIsolatedEmpty: { enabled: true, emptyAttributeId: 'state', emptyValue: '0', rangeKind: 'neighborhood', neighborhoodId: 'moore' },
    },
    attributes: [{ id: 'state', name: 'State', type: 'tag', description: '', isModelAttribute: false, defaultValue: '0', boundaryValue: '0', tagOptions: ['empty', 'A'] }],
    neighborhoods: [{ id: 'moore', name: 'Moore', description: '', coords, coords3d: is3d ? coords3d : undefined, margin: 1 }],
    mappings: [], indicators: [], graphNodes: nodes, graphEdges: edges, macroDefs: [],
    topologyMode: { gridCells: true, agents: false },
  };
  return { model: migrateForHarness(model), W, H, D, coords3d };
}

function buildNbrTable(coords3d, W, H, D, torus) {
  const total = W * H * D, WH = W * H, sz = coords3d.length;
  const nIdx = new Int32Array(total * sz);
  for (let l = 0; l < D; l++) for (let r = 0; r < H; r++) for (let cc = 0; cc < W; cc++) {
    const idx = l * WH + r * W + cc;
    for (let k = 0; k < sz; k++) {
      const dr = coords3d[k][0], dc = coords3d[k][1], dl = coords3d[k][2] ?? 0;
      let nl = l + dl, nr = r + dr, nc = cc + dc, cell;
      if (torus) { nl = ((nl % D) + D) % D; nr = ((nr % H) + H) % H; nc = ((nc % W) + W) % W; cell = nl * WH + nr * W + nc; }
      else cell = (nl < 0 || nl >= D || nr < 0 || nr >= H || nc < 0 || nc >= W) ? total : nl * WH + nr * W + nc;
      nIdx[idx * sz + k] = cell;
    }
  }
  return nIdx;
}

function seedGrid(arr, W, H, D) {
  // A single central seed (+ a couple of offset seeds so growth is non-trivial /
  // multi-front). Grows a compact blob that stays well within the grid.
  const cx = W >> 1, cy = H >> 1, cz = D >> 1, WH = W * H;
  const at = (l, r, cc) => { if (l >= 0 && l < D && r >= 0 && r < H && cc >= 0 && cc < W) arr[l * WH + r * W + cc] = 1; };
  at(cz, cy, cx);
  at(cz, cy - 3, cx + 4);
  at(cz, cy + 4, cx - 2);
  if (D > 1) { at(cz - 3, cy + 2, cx - 3); at(cz + 4, cy - 1, cx + 2); }
}

function args(is3d, W, H, D, rState, wState, nIdx, nSz, activeList, activeCount, rng) {
  const total = W * H * D;
  const a = is3d ? [total, W, H, D, W * H] : [total, W, H];
  a.push(rState, wState, nIdx, nSz);
  a.push({}, new Uint8ClampedArray(total * 4), 'default-viz', {}, {}, rng, new Uint32Array(1), new Uint32Array(0), new Uint32Array(0));
  a.push(activeList, activeCount);
  return a;
}

function compareRun(label, stepFn, is3d, W, H, D, coords3d, steps) {
  const total = W * H * D, torus = false, sz = coords3d.length;
  const nIdx = buildNbrTable(coords3d, W, H, D, torus);
  let rF = new Int32Array(total + 1), wF = new Int32Array(total + 1);
  let rS = new Int32Array(total + 1), wS = new Int32Array(total + 1);
  seedGrid(rF, W, H, D); rS.set(rF);
  const { offsets, offCount } = buildActiveOffsets({ kind: 'neighborhood', coords: coords3d });
  const as = createActiveSet({ width: W, height: H, depth: D, total, is3d, torus }, offsets, offCount, 0);
  rebuildActiveSet(as, rS);
  const rngF = new Uint32Array([12345]), rngS = new Uint32Array([12345]);
  let maxActive = 0, finalFilled = 0;
  for (let s = 0; s < steps; s++) {
    stepFn(...args(is3d, W, H, D, rF, wF, nIdx, sz, null, 0, rngF));
    maxActive = Math.max(maxActive, as.count);
    stepFn(...args(is3d, W, H, D, rS, wS, nIdx, sz, as.list, as.count, rngS));
    // sparse maintenance BEFORE swap (r = pre-step, w = post-step)
    const n = as.count;
    for (let i = 0; i < n; i++) { const idx = as.list[i]; const wasE = rS[idx] === 0, isE = wS[idx] === 0; if (wasE !== isE) applyTransition(as, idx, wasE, isE); }
    if (as.staleCount > (as.count >> 2) + 64) compactActiveSet(as);
    // swap both
    let t = rF; rF = wF; wF = t; t = rS; rS = wS; wS = t;
    for (let i = 0; i < total; i++) if (rF[i] !== rS[i]) {
      return { ok: false, label, step: s, idx: i, full: rF[i], sparse: rS[i] };
    }
  }
  for (let i = 0; i < total; i++) if (rF[i] !== 0) finalFilled++;
  return { ok: true, label, steps, total, maxActive, finalFilled, ratio: +(maxActive / total).toFixed(3) };
}

let failed = false;
for (const is3d of [false, true]) {
  const { model, W, H, D, coords3d } = buildModel(is3d);
  const dimLabel = is3d ? '3D' : '2D';
  const r = compileAll(model);
  if (r.js.error) { console.error(`[${dimLabel}] JS compile error: ${r.js.error}`); failed = true; continue; }
  const stepFn = eval(r.js.stepCode);
  const steps = is3d ? 18 : 45;
  const res = compareRun(`${dimLabel} JS`, stepFn, is3d, W, H, D, coords3d, steps);
  if (res.ok) {
    console.log(`OK  ${res.label}: sparse==full over ${res.steps} steps (grid ${W}x${H}x${D}=${res.total}, maxActive ${res.maxActive} = ${(res.ratio * 100).toFixed(1)}% of grid, final ${res.finalFilled} filled)`);
    if (res.maxActive >= res.total) { console.error(`FAIL ${res.label}: active set covered the WHOLE grid — the sparse path was not exercised (test scenario too dense).`); failed = true; }
  } else { console.error(`FAIL ${res.label}: step ${res.step} cell ${res.idx} full=${res.full} sparse=${res.sparse}`); failed = true; }

  if (wantWasm) {
    // Phase 2: WASM target. Compiled WASM step is `step(total)` over shared
    // wasm memory — instantiate + drive it. (Wired in Phase 2.)
    if (r.wasm.error) { console.error(`[${dimLabel}] WASM compile error: ${r.wasm.error}`); failed = true; }
    else console.log(`(WASM ${dimLabel} target harness — Phase 2 pending)`);
  }
}

console.log(failed ? '\nSPARSE VERIFY: FAILED' : '\nSPARSE VERIFY: ALL PASS');
process.exit(failed ? 1 : 0);

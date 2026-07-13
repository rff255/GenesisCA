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
export { compileGraphWasm, instantiateWasmModule } from '../src/modeler/vpl/compiler/wasm/compile.ts';
export { computeLayoutFromModel, buildViewerIds } from '../src/modeler/vpl/compiler/wasm/layout.ts';
export { packNI, packNI3 } from '../src/modeler/vpl/compiler/niCodec.ts';
`;
const dir = mkdtempSync(join(tmpdir(), 'gca-sparse-'));
const entryPath = join(ROOT, 'scripts', '__sparse_entry.ts');
writeFileSync(entryPath, ENTRY);
const outPath = join(dir, 'bundle.mjs');
await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: process.cwd() });
const M = await import(pathToFileURL(outPath).href);
const { compileAll, migrateForHarness, buildActiveOffsets, createActiveSet, rebuildActiveSet, applyTransition, compactActiveSet,
  compileGraphWasm, instantiateWasmModule, computeLayoutFromModel, buildViewerIds, packNI, packNI3 } = M;

/** The compact packed-offset table (inline-neighbour mode) — mirrors the
 *  worker's buildNeighborIndices sparse branch. */
function buildPackedTable(coords3d, is3d) {
  const out = new Int32Array(coords3d.length);
  for (let n = 0; n < coords3d.length; n++) {
    const c = coords3d[n];
    out[n] = is3d ? packNI3(c[0], c[1], c[2] ?? 0) : packNI(c[0], c[1]);
  }
  return out;
}

/** A feature-OFF clone of the model — the classic-table REFERENCE compile. */
function offClone(model) {
  return migrateForHarness(JSON.parse(JSON.stringify({
    ...model,
    properties: { ...model.properties, skipIsolatedEmpty: undefined },
  })));
}

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

/** Three JS arms in lockstep:
 *   REF    — the feature-OFF compile (classic per-cell table)         [stepOff + nIdx]
 *   SPARSE — the feature-ON compile, active list + packed offsets      [stepOn + packed + list]
 *   ONFULL — the feature-ON compile, null list (its inline FULL loop)  [stepOn + packed]
 *  Byte-identical grids after every step prove both the sparse gating AND the
 *  inline-neighbour decode against the classic table. */
function compareRun(label, stepOff, stepOn, is3d, W, H, D, coords3d, steps) {
  const total = W * H * D, torus = false, sz = coords3d.length;
  const nIdx = buildNbrTable(coords3d, W, H, D, torus);
  const packed = buildPackedTable(coords3d, is3d);
  let rF = new Int32Array(total + 1), wF = new Int32Array(total + 1);
  let rS = new Int32Array(total + 1), wS = new Int32Array(total + 1);
  let rG = new Int32Array(total + 1), wG = new Int32Array(total + 1);
  seedGrid(rF, W, H, D); rS.set(rF); rG.set(rF);
  const { offsets, offCount } = buildActiveOffsets({ kind: 'neighborhood', coords: coords3d });
  const as = createActiveSet({ width: W, height: H, depth: D, total, is3d, torus }, offsets, offCount, 0);
  rebuildActiveSet(as, rS);
  const rngF = new Uint32Array([12345]), rngS = new Uint32Array([12345]), rngG = new Uint32Array([12345]);
  let maxActive = 0, finalFilled = 0;
  for (let s = 0; s < steps; s++) {
    stepOff(...args(is3d, W, H, D, rF, wF, nIdx, sz, undefined, undefined, rngF));
    maxActive = Math.max(maxActive, as.count);
    stepOn(...args(is3d, W, H, D, rS, wS, packed, sz, as.list, as.count, rngS));
    stepOn(...args(is3d, W, H, D, rG, wG, packed, sz, null, 0, rngG));
    // sparse maintenance BEFORE swap (r = pre-step, w = post-step)
    const n = as.count;
    for (let i = 0; i < n; i++) { const idx = as.list[i]; const wasE = rS[idx] === 0, isE = wS[idx] === 0; if (wasE !== isE) applyTransition(as, idx, wasE, isE); }
    if (as.staleCount > (as.count >> 2) + 64) compactActiveSet(as);
    // swap all three
    let t = rF; rF = wF; wF = t; t = rS; rS = wS; wS = t; t = rG; rG = wG; wG = t;
    for (let i = 0; i < total; i++) {
      if (rF[i] !== rS[i]) return { ok: false, label, step: s, idx: i, arm: 'sparse', full: rF[i], sparse: rS[i] };
      if (rF[i] !== rG[i]) return { ok: false, label, step: s, idx: i, arm: 'inline-full', full: rF[i], sparse: rG[i] };
    }
  }
  for (let i = 0; i < total; i++) if (rF[i] !== 0) finalFilled++;
  return { ok: true, label, steps, total, maxActive, finalFilled, ratio: +(maxActive / total).toFixed(3) };
}

let failed = false;
for (const is3d of [false, true]) {
  const { model, W, H, D, coords3d } = buildModel(is3d);
  const modelOff = offClone(model);
  const dimLabel = is3d ? '3D' : '2D';
  const r = compileAll(model);        // feature ON  (sparse + inline neighbours)
  const rOff = compileAll(modelOff);  // feature OFF (the classic-table REFERENCE)
  if (r.js.error) { console.error(`[${dimLabel}] JS (ON) compile error: ${r.js.error}`); failed = true; continue; }
  if (rOff.js.error) { console.error(`[${dimLabel}] JS (OFF) compile error: ${rOff.js.error}`); failed = true; continue; }
  const stepFn = eval(r.js.stepCode);
  const stepFnOff = eval(rOff.js.stepCode);
  const steps = is3d ? 18 : 45;
  const res = compareRun(`${dimLabel} JS`, stepFnOff, stepFn, is3d, W, H, D, coords3d, steps);
  if (res.ok) {
    console.log(`OK  ${res.label}: sparse==full over ${res.steps} steps (grid ${W}x${H}x${D}=${res.total}, maxActive ${res.maxActive} = ${(res.ratio * 100).toFixed(1)}% of grid, final ${res.finalFilled} filled)`);
    if (res.maxActive >= res.total) { console.error(`FAIL ${res.label}: active set covered the WHOLE grid — the sparse path was not exercised (test scenario too dense).`); failed = true; }
  } else { console.error(`FAIL ${res.label}: step ${res.step} cell ${res.idx} full=${res.full} sparse=${res.sparse}`); failed = true; }

  if (wantWasm) {
    // Phase 2: the REAL WASM sparse step. Compile the module against the sparse
    // layout, instantiate over a real WebAssembly.Memory, and run three arms in
    // lockstep: WASM-full (activeCount -1), WASM-sparse (the active list — a
    // VIEW over the wasm memory region, exactly like the worker), and the JS
    // full reference. Assert byte-identical grids after every step.
    const res2 = await (async () => {
      // Feature-ON module (sparse loop + inline neighbours, compact packed table)
      const layout = computeLayoutFromModel(model);
      if (!layout.sparseStepping || layout.activeListBytes <= 0) return { ok: false, why: 'layout did not reserve the active-list region' };
      const wres = compileGraphWasm(model.graphNodes, model.graphEdges, model, layout, buildViewerIds(model));
      if (wres.error) return { ok: false, why: 'WASM (ON) compile error: ' + wres.error };
      // Feature-OFF module (classic full loop + the per-cell table) — the REFERENCE
      const layoutOff = computeLayoutFromModel(modelOff);
      const wresOff = compileGraphWasm(modelOff.graphNodes, modelOff.graphEdges, modelOff, layoutOff, buildViewerIds(modelOff));
      if (wresOff.error) return { ok: false, why: 'WASM (OFF) compile error: ' + wresOff.error };
      const total = W * H * D, torus = false, sz = coords3d.length;
      const viewLen = total + 1;  // constant boundary sentinel
      // Sanity: the inline layout must have dropped the huge per-cell table —
      // ON totalBytes ≈ OFF totalBytes − total×sz×4 (table gone) + total×4
      // (active list added). Assert the net shrink within a page of slack.
      const expectedOn = layoutOff.totalBytes - total * sz * 4 + sz * 4 + total * 4;
      if (layout.totalBytes > expectedOn + 65536) return { ok: false, why: `inline layout did not drop the big nbr table (ON ${layout.totalBytes} vs OFF ${layoutOff.totalBytes} bytes)` };
      const mkOn = async () => {
        const memory = new WebAssembly.Memory({ initial: layout.pages });
        const inst = await instantiateWasmModule(wres, memory);
        const rV = new Int32Array(memory.buffer, layout.attrReadOffset['state'], viewLen);
        const wV = new Int32Array(memory.buffer, layout.attrWriteOffset['state'], viewLen);
        // COMPACT packed-offset table (the worker's sparse buildNeighborIndices).
        new Int32Array(memory.buffer, layout.nbrIndexOffset['moore'], sz).set(buildPackedTable(coords3d, is3d));
        const listV = new Int32Array(memory.buffer, layout.activeListOffset, total);
        return { step: inst.exports.step, rV, wV, listV };
      };
      const mkOff = async () => {
        const memory = new WebAssembly.Memory({ initial: layoutOff.pages });
        const inst = await instantiateWasmModule(wresOff, memory);
        const rV = new Int32Array(memory.buffer, layoutOff.attrReadOffset['state'], viewLen);
        const wV = new Int32Array(memory.buffer, layoutOff.attrWriteOffset['state'], viewLen);
        new Int32Array(memory.buffer, layoutOff.nbrIndexOffset['moore'], total * sz).set(buildNbrTable(coords3d, W, H, D, torus));
        return { step: inst.exports.step, rV, wV };
      };
      const ref = await mkOff();      // classic-table reference
      const spar = await mkOn();      // sparse + inline, active list
      const onFull = await mkOn();    // inline, full loop (-1)
      seedGrid(ref.rV, W, H, D); spar.rV.set(ref.rV); onFull.rV.set(ref.rV);
      const { offsets, offCount } = buildActiveOffsets({ kind: 'neighborhood', coords: coords3d });
      const as = createActiveSet({ width: W, height: H, depth: D, total, is3d, torus }, offsets, offCount, 0, spar.listV);
      rebuildActiveSet(as, spar.rV);
      let maxActive = 0;
      for (let s = 0; s < steps; s++) {
        ref.step(total);                            // OFF module: classic (i32)->()
        maxActive = Math.max(maxActive, as.count);
        spar.step(total, as.count);                 // ON module: sparse arm
        onFull.step(total, -1);                     // ON module: inline full arm
        // sparse maintenance BEFORE the w->r copy (r = pre-step, w = post-step)
        const n = as.count;
        for (let i = 0; i < n; i++) { const idx = as.list[i]; const wasE = spar.rV[idx] === 0, isE = spar.wV[idx] === 0; if (wasE !== isE) applyTransition(as, idx, wasE, isE); }
        if (as.staleCount > (as.count >> 2) + 64) compactActiveSet(as);
        // the worker's WASM post-step w->r copy
        ref.rV.set(ref.wV); spar.rV.set(spar.wV); onFull.rV.set(onFull.wV);
        for (let i = 0; i < total; i++) {
          if (ref.rV[i] !== spar.rV[i]) return { ok: false, why: `step ${s} cell ${i}: WASM table-ref=${ref.rV[i]} vs sparse-inline=${spar.rV[i]}` };
          if (ref.rV[i] !== onFull.rV[i]) return { ok: false, why: `step ${s} cell ${i}: WASM table-ref=${ref.rV[i]} vs inline-full=${onFull.rV[i]}` };
        }
      }
      return { ok: true, maxActive };
    })();
    if (res2.ok) console.log(`OK  ${dimLabel} WASM: sparse==full==JS over ${steps} steps (maxActive ${res2.maxActive})`);
    else { console.error(`FAIL ${dimLabel} WASM: ${res2.why}`); failed = true; }
  }
}

console.log(failed ? '\nSPARSE VERIFY: FAILED' : '\nSPARSE VERIFY: ALL PASS');
process.exit(failed ? 1 : 0);

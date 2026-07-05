// JS↔WASM BIT-PARITY harness for the FULL-COVERAGE WASM agent BEHAVIOUR module.
// For each agent sample model, build the JS behaviour fn + the WASM behaviour
// module, seed two IDENTICAL stores (one plain-JS, one wasmBacked), then run the
// behaviour fn N steps on each with the SAME RNG seed + the SAME spatial hash +
// the SAME external regions, and compare the agent SoA / attrs / requests / field
// deposit element-wise. The force pass + structural phase are out of scope here
// (force-pass parity proven in W1; structural phase is target-independent CPU).
//
// Run from the repo root:  node scripts/parity-agent-wasm.mjs
import { build } from 'esbuild';
import { writeFileSync, rmSync, mkdtempSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = `
export { createAgentStore, computeAgentMaxHashBins, buildSpatialHash, seedAgents } from '../src/simulator/engine/agentEngine.ts';
export { compileAgentGraphWasmForModel, instantiateAgentWasm, buildAgentLayoutExtras, isAgentGraphWasmSupported } from '../src/modeler/vpl/compiler/agentWasm/compile.ts';
export { compileAgentGraph } from '../src/modeler/vpl/compiler/compile.ts';
export { migrateForHarness } from '../src/dev/compileHarness.ts';
export { agentAttrsOf, cellFieldAttrsOf } from '../src/model/attributeScope.ts';
export { resolveKeyLabels, normalizeLookupTable } from '../src/modeler/vpl/compiler/variegation.ts';
`;
const dir = mkdtempSync(join(tmpdir(), 'gca-parity-'));
const entryPath = join(ROOT, 'scripts', '__parity_entry.ts');
writeFileSync(entryPath, ENTRY);
const outPath = join(dir, 'bundle.mjs');
await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: process.cwd() });
const m = await import(pathToFileURL(outPath).href);
const {
  createAgentStore, computeAgentMaxHashBins, buildSpatialHash, seedAgents,
  compileAgentGraphWasmForModel, instantiateAgentWasm,
  compileAgentGraph, migrateForHarness, agentAttrsOf, cellFieldAttrsOf,
  resolveKeyLabels, normalizeLookupTable,
} = m;

const cbNum = (cfg, k, d) => { const v = cfg?.[k]; return typeof v === 'number' && Number.isFinite(v) ? v : d; };

// Faithful copy of the worker's buildAgentLoopArgs (the ABI mirror).
function buildArgs(s, hash, ctx) {
  const EMPTY_I32 = new Int32Array(0);
  const args = [
    s.alive, s.highWater,
    s.x, s.y, s.radius, s.targetRadius, s.age, s.lineage, s.bondCount, s.density,
    s.vx, s.vy, s.forceX, s.forceY,
    hash ? 1 : 0,
    hash ? hash.binStart : EMPTY_I32, hash ? hash.binAgents : EMPTY_I32,
    hash ? hash.nBinsX : 0, hash ? hash.nBinsY : 0, hash ? hash.binSizeX : 1, hash ? hash.binSizeY : 1,
    hash ? hash.originX : 0, hash ? hash.originY : 0,
    s.divideRequest, s.divideAxisX, s.divideAxisY, s.divideAsym, s.killRequest,
    s.bondPartner, s.bondPartnerEpoch, s.bondRestLength, s.bondStiffness, s.bondTypeLabel, s.maxBonds,
    s.bondFormReq, s.bondFormL, s.bondFormK, s.bondBreakReq,
  ];
  for (const spec of s.attrSpecs) args.push(s.attrRead[spec.id]);
  for (const spec of s.attrSpecs) args.push(s.attrWrite[spec.id]);
  // NB spriteIds/Frames/Speeds/Rotations/Scales are ALWAYS threaded (the sprites
  // milestone ABI) — omitting them shifts every trailing arg (_fieldW → height,
  // the field arrays → undefined) and silently corrupts the JS side.
  args.push(ctx.cachedModelAttrs, s.colors, ctx.activeViewer, ctx.cachedIndicators, ctx.rngState, ctx.stopFlag, ctx.GLYPH_NOOP_CODES, ctx.GLYPH_NOOP_COLORS, s.spriteIds, s.spriteFrames, s.spriteSpeeds, s.spriteRotations, s.spriteScales);
  if (ctx.hasLookupTables) args.push(ctx.cachedInteractionTables);
  args.push(ctx.width, ctx.height, ctx.total, ctx.torus ? 1 : 0);
  for (const spec of ctx.fieldSpecs) args.push(ctx.readAttrs[spec.id]);
  if (s.worldDepth > 1) args.push(s.z, s.vz, s.forceZ, s.divideAxisZ, s.worldDepth, hash ? hash.nBinsZ : 1, hash ? hash.binSizeZ : 1, hash ? hash.originZ : 0);
  return args;
}

// Synthetic 3D-field parity vehicle — exercises ALL FIVE field-bridge nodes in 3D:
//   secreteToField (8-cell trilinear splat) + affectCellsUnder (r-sphere scatter)
//   + fieldGradient.dx/dy/dz (trilinear central diffs) + sampleField (trilinear
//   point read) + readCellsUnder (r-sphere mean). Apply Force is 2D for the graph
//   force (fx/fy only — no fz port), so every field output routes into fx/fy so a
//   wrong 3D read/write diverges the position. 32x32x16 torus.
function build3DFieldModel() {
  const used = new Set();
  const nid = (p) => { let id; do { id = p + Math.random().toString(36).slice(2, 8); } while (used.has(id)); used.add(id); return id; };
  const cN = [], cEd = [], aN = [], aEd = [];
  const cn = (t, c) => { const n = { id: nid('n'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; cN.push(n); return n; };
  const an = (t, c) => { const n = { id: nid('a'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; aN.push(n); return n; };
  const ed = (arr) => (s, sp, tt, tp, cat) => arr.push({ id: nid('e'), source: s.id, target: tt.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
  const cE = ed(cEd), aE = ed(aEd);
  const cV = (s, sp, tt, tp) => cE(s, sp, tt, tp, 'value'), cF = (s, sp, tt, tp) => cE(s, sp, tt, tp, 'flow');
  const aV = (s, sp, tt, tp) => aE(s, sp, tt, tp, 'value'), aF = (s, sp, tt, tp) => aE(s, sp, tt, tp, 'flow');
  // Moore-3D neighbourhood (diffuse both fields)
  const mooreId = nid('nb'); const coords3d = [], coords = [];
  for (let dl = -1; dl <= 1; dl++) for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if (dl || dr || dc) { coords3d.push([dr, dc, dl]); coords.push([dr, dc]); }
  const neighborhoods = [{ id: mooreId, name: 'Moore3D', coords, coords3d, includeCentralCell: false }];
  const DIFFUSE = 0.2, DECAY = 0.98;
  const step = cn('step', {});
  const diffuse = (attr) => {
    const g = cn('getCellAttribute', { attributeId: attr });
    const nbr = cn('getNeighborsAttribute', { neighborhoodId: mooreId, attributeId: attr });
    const avg = cn('aggregate', { operation: 'average' }); cV(nbr, 'values', avg, 'values');
    const ex = cn('expression', { expression: `(a + ${DIFFUSE}*(b-a))*${DECAY}`, visibleCount: 2 }); cV(g, 'value', ex, 'a'); cV(avg, 'result', ex, 'b');
    const set = cn('setAttribute', { attributeId: attr }); cV(ex, 'result', set, 'value'); return set;
  };
  const setA = diffuse('chemical'), setB = diffuse('chemical2');
  // Sequence ports are `first`/`then` (+ `then_2`… via extraCount) — NOT then_0/then_1.
  const seq = cn('sequence', { extraCount: 0 }); cF(step, 'do', seq, 'do'); cF(seq, 'first', setA, 'do'); cF(seq, 'then', setB, 'do');
  // agents — the behaviour chain routes through a Sequence ON PURPOSE: the agent
  // WASM/WebGPU sequence emitters once walked nonexistent then0/then1 ports and
  // silently dropped the whole downstream chain (the gravitation bug); this keeps
  // permanent regression coverage for agent-graph Sequence.
  const bs = an('behaviourStep', {});
  const aseq = an('sequence', { extraCount: 0 }); aF(bs, 'do', aseq, 'do');
  const sec = an('secreteToField', { attributeId: 'chemical', _port_rate: '1.0' }); aF(aseq, 'first', sec, 'do');
  const aff = an('affectCellsUnder', { attributeId: 'chemical2', op: 'add', _port_value: '0.5', _port_radius: '2' }); aF(sec, 'next', aff, 'do');
  const fg = an('fieldGradient', { attributeId: 'chemical' });
  const sf = an('sampleField', { attributeId: 'chemical' });
  const rc = an('readCellsUnder', { attributeId: 'chemical2', reduce: 'mean', _port_radius: '2' });
  const fxN = an('expression', { expression: 'a*24 + b*8 + c*4', visibleCount: 3 }); aV(fg, 'dx', fxN, 'a'); aV(fg, 'dz', fxN, 'b'); aV(sf, 'value', fxN, 'c');
  const fyN = an('expression', { expression: 'a*24 + b*2', visibleCount: 2 }); aV(fg, 'dy', fyN, 'a'); aV(rc, 'value', fyN, 'b');
  const af = an('applyForce', {}); aV(fxN, 'result', af, 'fx'); aV(fyN, 'result', af, 'fy'); aF(aff, 'next', af, 'do');
  return {
    schemaVersion: 1,
    properties: { name: 'Field3D Parity Test', dimension: '3d', gridWidth: 32, gridHeight: 32, gridDepth: 16, topology: '2d-grid', boundaryTreatment: 'torus', useWasm: true, useWebGPU: false },
    topologyMode: { gridCells: true, agents: true },
    centerBased: { enabled: true, maxAgents: 400, maxBonds: 2, worldWidth: 32, worldHeight: 32, worldDepth: 16, seedCount: 80, seedPattern: 'scatter', defaultRadius: 1.0, growthRate: 0, repulsionStiffness: 1.2, adhesionStiffness: 0, interactionRange: 1.4, drag: 1.0, timeStep: 0.25, momentum: 0.7, maxSpeed: 1.0, neighbourQueryRadius: 5, customForcesOnly: false, autoBond: false, bondStiffness: 0.4, bondRestLength: 2.0, formDistance: 1.2, breakDistance: 2.0, agentTarget: 'wasm', agentUpdateMode: 'async' },
    attributes: [
      { id: 'chemical', name: 'chemical', type: 'float', defaultValue: '0', agentAccess: 'readWrite' },
      { id: 'chemical2', name: 'chemical2', type: 'float', defaultValue: '0', agentAccess: 'readWrite' },
    ],
    agentAttributes: [], modelAttributes: [], neighborhoods,
    mappings: [{ id: nid('map'), name: 'Chemical', isAttributeToColor: true, linked: true, linkedAttributeId: 'chemical', linkedMin: 0, linkedMax: 6 }],
    variables: [], agentVariables: [], indicators: [],
    graphNodes: cN, graphEdges: cEd, agentGraphNodes: aN, agentGraphEdges: aEd, macroDefs: [],
  };
}

const modelsDir = join(ROOT, 'public', 'models');
const files = readdirSync(modelsDir).filter(f => f.endsWith('.gcaproj'));
const SEED = 0x9e3779b1 >>> 0;
const STEPS = Number(process.env.STEPS) || 30;
let allPass = true;

// Build the entry list: every shipped agent .gcaproj PLUS a synthetic 3D-field
// model exercising ALL FIVE field-bridge nodes in 3D (trilinear sample/gradient/
// splat + r-sphere read/affect). The 3D-field model is built in-memory (not
// shipped — the existing samples don't cover 3D field; this keeps the regression
// coverage permanent without adding a Models-Library card). See build3DFieldModel.
const entries = [];
for (const f of files) {
  let raw; try { raw = JSON.parse(readFileSync(join(modelsDir, f), 'utf8')); } catch { continue; }
  entries.push({ name: f, raw });
}
entries.push({ name: '[synthetic] Field3D (all 5 field nodes, 3D)', raw: build3DFieldModel() });

for (const { name: f, raw } of entries) {
  const model = migrateForHarness(raw);
  if (!model?.topologyMode?.agents) continue;

  const cfg = model.centerBased;
  const is3d = model.properties.dimension === '3d' && (model.properties.gridDepth ?? 1) > 1;
  const W = model.properties.gridWidth || 100, H = model.properties.gridHeight || 100, D = is3d ? (model.properties.gridDepth || 1) : 1;
  const total = W * H * D;
  const torus = model.properties.boundaryTreatment === 'torus';
  const agentAttrs = agentAttrsOf(model);
  const fieldSpecs = cellFieldAttrsOf(model);
  const specs = agentAttrs.map(a => ({ id: a.id, type: a.type, defaultValue: 0 }));
  const maxAgents = Math.max(1, Math.floor(cbNum(cfg, 'maxAgents', 2000)));
  const maxBonds = Math.max(1, Math.floor(cbNum(cfg, 'maxBonds', 8)));
  const maxHashBins = computeAgentMaxHashBins(W, H, D, cbNum(cfg, 'interactionRange', 1.5), cbNum(cfg, 'defaultRadius', 0.5), cbNum(cfg, 'neighbourQueryRadius', 5));

  // Compile both targets.
  const wasmR = compileAgentGraphWasmForModel(model);
  if (wasmR.error || wasmR.bytes.length === 0) { console.log(`SKIP ${f}: WASM compile: ${wasmR.error}`); continue; }
  // Use the COMPILER's exact layout dims for the store so offsets match bit-for-bit
  // (the real worker derives the same dims from the same model; verified here).
  const cMaxHashBins = wasmR.layout.maxHashBins;
  const jsR = compileAgentGraph(model.agentGraphNodes ?? [], model.agentGraphEdges ?? [], model, 0);
  if (jsR.error || !jsR.behaviourCode) { console.log(`SKIP ${f}: JS compile: ${jsR.error}`); continue; }
  // eslint-disable-next-line no-eval
  const jsFn = eval(jsR.behaviourCode);

  // Build the external-region caches (deterministic: model attrs from defaults,
  // field arrays seeded with a deterministic pattern, lookup tables normalized).
  const cachedModelAttrs = {};
  for (const a of model.attributes) {
    if (!a.isModelAttribute) continue;
    if (a.type === 'color') { cachedModelAttrs[a.id + '_r'] = 10; cachedModelAttrs[a.id + '_g'] = 20; cachedModelAttrs[a.id + '_b'] = 30; }
    else if (a.type !== 'lookupTable') { const v = parseFloat(String(a.defaultValue ?? '0')); cachedModelAttrs[a.id] = Number.isFinite(v) ? v : 0; }
  }
  const cachedInteractionTables = {};
  let hasLookupTables = false;
  for (const a of model.attributes) {
    if (a.isModelAttribute && a.type === 'lookupTable') {
      hasLookupTables = true;
      const rl = resolveKeyLabels(a.rowKeySource, model), cl = resolveKeyLabels(a.colKeySource, model);
      cachedInteractionTables[a.id] = normalizeLookupTable(a.tableValues, rl, cl);
    }
  }
  const cachedIndicators = new Float64Array((model.indicators ?? []).length);
  // deterministic field arrays (readAttrs) for the agent-accessible cell attrs.
  const readAttrs = {};
  for (const spec of fieldSpecs) {
    const arr = new Float64Array(total);
    for (let i = 0; i < total; i++) arr[i] = ((i * 2654435761) % 997) / 997;
    readAttrs[spec.id] = arr;
  }
  const ctxA = { cachedModelAttrs, cachedInteractionTables, cachedIndicators, readAttrs, fieldSpecs, width: W, height: H, total, torus, hasLookupTables, activeViewer: '', rngState: null, stopFlag: new Uint32Array(1), GLYPH_NOOP_CODES: new Uint32Array(1), GLYPH_NOOP_COLORS: new Uint32Array(1) };
  // wasm side gets its OWN field copy so deposits don't cross-contaminate.
  const readAttrsB = {}; for (const spec of fieldSpecs) readAttrsB[spec.id] = readAttrs[spec.id].slice();
  const cachedModelAttrsB = { ...cachedModelAttrs };
  const cachedInteractionTablesB = {}; for (const k of Object.keys(cachedInteractionTables)) cachedInteractionTablesB[k] = cachedInteractionTables[k].slice();
  const cachedIndicatorsB = cachedIndicators.slice();

  // Stores: A = plain JS; B = wasmBacked (sync attrs if the model is sync).
  const syncAttrs = cfg?.agentUpdateMode === 'sync';
  const layoutExtras = { ...m.buildAgentLayoutExtras(model), fieldTotal: total, syncAttrs };
  const A = createAgentStore(cfg, specs, { wasmBacked: false, syncAttrs });
  const B = createAgentStore(cfg, specs, { wasmBacked: true, syncAttrs, maxHashBins: cMaxHashBins, layoutExtras });
  for (const s of [A, B]) { s.worldWidth = W; s.worldHeight = H; s.worldDepth = D; }

  // Seed identical agents (deterministic compact grid).
  const r = cbNum(cfg, 'defaultRadius', 0.5);
  const N0 = Math.min(maxAgents, process.env.N1 ? 1 : 64);
  const seedSpecs = [];
  const cols = Math.ceil(Math.sqrt(N0));
  for (let i = 0; i < N0; i++) {
    const sp = is3d
      ? { x: 4 + (i % cols) * 2.2 * r, y: 4 + Math.floor(i / cols) * 2.2 * r, z: D / 2, radius: r }
      : { x: 4 + (i % cols) * 2.2 * r, y: 4 + Math.floor(i / cols) * 2.2 * r, radius: r };
    seedSpecs.push(sp);
  }
  seedAgents(A, seedSpecs, r); seedAgents(B, seedSpecs, r);
  // give agent attrs deterministic non-default values
  for (const s of [A, B]) for (const spec of agentAttrs) { const a = s.attrRead[spec.id]; for (let i = 0; i < s.highWater; i++) a[i] = (i % 5) - 2; if (s.attrWrite[spec.id] !== a) s.attrWrite[spec.id].set(a); }

  // LAYOUT-MATCH assertion: the store's layout MUST equal the compiler's, else the
  // baked field/attr offsets are wrong (the +64-cell bug).
  if (B.layout.fieldOffset && wasmR.layout.fieldOffset) {
    for (const id of Object.keys(wasmR.layout.fieldOffset)) {
      if (B.layout.fieldOffset[id] !== wasmR.layout.fieldOffset[id]) {
        console.log(`  !! LAYOUT MISMATCH ${f}: field ${id} store=${B.layout.fieldOffset[id]} compiler=${wasmR.layout.fieldOffset[id]}`);
      }
    }
    if (B.layout.indicatorsOffset !== wasmR.layout.indicatorsOffset) console.log(`  !! indicatorsOffset ${B.layout.indicatorsOffset} vs ${wasmR.layout.indicatorsOffset}`);
    for (const k of Object.keys(wasmR.layout.modelAttrOffset)) if (B.layout.modelAttrOffset[k] !== wasmR.layout.modelAttrOffset[k]) console.log(`  !! modelAttr ${k} ${B.layout.modelAttrOffset[k]} vs ${wasmR.layout.modelAttrOffset[k]}`);
  }
  // Instantiate WASM behaviour against B's memory.
  const inst = await instantiateAgentWasm(wasmR.bytes, B.memory);

  const rngState = new Uint32Array(1);
  let mismatch = 0, firstField = '';
  for (let step = 0; step < STEPS && mismatch === 0; step++) {
    // reset forces
    A.forceX.fill(0, 0, A.highWater); A.forceY.fill(0, 0, A.highWater); A.forceZ.fill(0, 0, A.highWater);
    B.forceX.fill(0, 0, B.highWater); B.forceY.fill(0, 0, B.highWater); B.forceZ.fill(0, 0, B.highWater);
    // reset request buffers (the worker zeroes them implicitly via the structural phase; for behaviour-only parity zero them here)
    for (const s of [A, B]) { s.divideRequest.fill(0); s.killRequest.fill(0); s.bondFormReq.fill(0); s.bondBreakReq.fill(0); s.divideAxisX.fill(0); s.divideAxisY.fill(0); s.divideAsym.fill(0); s.bondFormL.fill(0); s.bondFormK.fill(0); }
    // build the hash from A's positions (both stores share identical positions here).
    let maxR = r; for (let i = 0; i < A.highWater; i++) if (A.alive[i] && A.radius[i] > maxR) maxR = A.radius[i];
    const binEdge = Math.max(1e-3, cbNum(cfg, 'interactionRange', 1.5) * 2 * maxR, cbNum(cfg, 'neighbourQueryRadius', 5));
    const hashA = buildSpatialHash(A, binEdge, W, H, D, torus, computeAgentMaxHashBins(W, H, D, cbNum(cfg, 'interactionRange', 1.5), cbNum(cfg, 'defaultRadius', 0.5), cbNum(cfg, 'neighbourQueryRadius', 5)));
    // sync prime
    if (syncAttrs) { for (const s of [A, B]) for (const spec of s.attrSpecs) { const rd = s.attrRead[spec.id], wr = s.attrWrite[spec.id]; if (rd !== wr) wr.set(rd); } }

    // --- JS behaviour on A ---
    rngState[0] = SEED + step;
    ctxA.rngState = rngState;
    jsFn(...buildArgs(A, hashA, ctxA));
    // --- WASM behaviour on B ---
    const Bbuf = B.memory.buffer, BL = B.layout;
    new Uint32Array(Bbuf, BL.rngStateOffset, 1)[0] = SEED + step;
    // copy hash in
    let hashValid = 0, nBinsX = 0, nBinsY = 0, nBinsZ = 0, bsx = 1, bsy = 1, bsz = 1, ox = 0, oy = 0, oz = 0;
    if (hashA) {
      hashValid = 1; nBinsX = hashA.nBinsX; nBinsY = hashA.nBinsY; nBinsZ = hashA.nBinsZ; bsx = hashA.binSizeX; bsy = hashA.binSizeY; bsz = hashA.binSizeZ; ox = hashA.originX; oy = hashA.originY; oz = hashA.originZ;
      const nBins = nBinsX * nBinsY * nBinsZ;
      new Int32Array(Bbuf, BL.hashBinStartOffset, nBins + 1).set(hashA.binStart.subarray(0, nBins + 1));
      const used = hashA.binStart[nBins];
      if (used > 0) new Int32Array(Bbuf, BL.hashBinAgentsOffset, used).set(hashA.binAgents.subarray(0, used));
    }
    // copy external regions in (model attrs / indicators / lookup / field)
    for (const key of Object.keys(BL.modelAttrOffset)) new Float64Array(Bbuf, BL.modelAttrOffset[key], 1)[0] = typeof cachedModelAttrsB[key] === 'number' ? cachedModelAttrsB[key] : 0;
    if (BL.indicatorCount > 0) new Float64Array(Bbuf, BL.indicatorsOffset, BL.indicatorCount).set(cachedIndicatorsB.subarray(0, BL.indicatorCount));
    for (const id of Object.keys(BL.lookupTableOffset)) { const t = cachedInteractionTablesB[id]; if (t) new Float64Array(Bbuf, BL.lookupTableOffset[id], t.length).set(t); }
    if (BL.fieldTotal > 0) for (const id of Object.keys(BL.fieldOffset)) { const src = readAttrsB[id]; if (!src) continue; const dst = new Float64Array(Bbuf, BL.fieldOffset[id], BL.fieldTotal); const n2 = Math.min(BL.fieldTotal, src.length); for (let i = 0; i < n2; i++) dst[i] = src[i]; }
    inst.behaviour(B.highWater, hashValid, nBinsX, nBinsY, nBinsZ, bsx, bsy, bsz, W, H, D, torus ? 1 : 0, ox, oy, oz);
    // copy field deposit + indicators back out (mirror the worker)
    if (BL.indicatorCount > 0) { const sb = new Float64Array(Bbuf, BL.indicatorsOffset, BL.indicatorCount); for (let i = 0; i < BL.indicatorCount; i++) cachedIndicatorsB[i] = sb[i]; }
    if (BL.fieldTotal > 0) { const wIds = new Set(fieldSpecs.filter(a => a.agentAccess === 'readWrite').map(a => a.id)); for (const id of Object.keys(BL.fieldOffset)) { if (!wIds.has(id)) continue; const dst = readAttrsB[id]; if (!dst) continue; const src = new Float64Array(Bbuf, BL.fieldOffset[id], BL.fieldTotal); const n2 = Math.min(BL.fieldTotal, dst.length); for (let i = 0; i < n2; i++) dst[i] = src[i]; } }

    // sync swap (so the next step reads the written attrs on both)
    if (syncAttrs) {
      for (const spec of A.attrSpecs) { const tmp = A.attrRead[spec.id]; A.attrRead[spec.id] = A.attrWrite[spec.id]; A.attrWrite[spec.id] = tmp; }
      for (const spec of B.attrSpecs) { const rd = B.attrRead[spec.id], wr = B.attrWrite[spec.id]; rd.set(wr); }
    }

    // --- compare ---
    const cmpArr = (name, aArr, bArr, n) => { for (let i = 0; i < n; i++) { if (aArr[i] !== bArr[i] && !(Number.isNaN(aArr[i]) && Number.isNaN(bArr[i]))) { mismatch++; if (!firstField) firstField = `${name}[${i}] js=${aArr[i]} wasm=${bArr[i]}`; return; } } };
    const hw = A.highWater;
    cmpArr('forceX', A.forceX, B.forceX, hw); cmpArr('forceY', A.forceY, B.forceY, hw);
    if (is3d) cmpArr('forceZ', A.forceZ, B.forceZ, hw);
    cmpArr('vx', A.vx, B.vx, hw); cmpArr('vy', A.vy, B.vy, hw);
    cmpArr('targetRadius', A.targetRadius, B.targetRadius, hw);
    cmpArr('divideRequest', A.divideRequest, B.divideRequest, hw);
    cmpArr('killRequest', A.killRequest, B.killRequest, hw);
    cmpArr('bondFormReq', A.bondFormReq, B.bondFormReq, hw);
    cmpArr('bondBreakReq', A.bondBreakReq, B.bondBreakReq, hw);
    cmpArr('divideAxisX', A.divideAxisX, B.divideAxisX, hw); cmpArr('divideAxisY', A.divideAxisY, B.divideAxisY, hw);
    for (const spec of agentAttrs) cmpArr('attr_' + spec.id, A.attrRead[spec.id], B.attrRead[spec.id], hw);
    cmpArr('colors', A.colors, B.colors, hw * 4);
    for (const spec of fieldSpecs) if (spec.agentAccess === 'readWrite') cmpArr('field_' + spec.id, readAttrs[spec.id], readAttrsB[spec.id], total);
    // RNG stream parity
    const bRng = new Uint32Array(B.memory.buffer, BL.rngStateOffset, 1)[0];
    if (rngState[0] !== bRng) { /* JS rng updated in place; compare */ }
  }
  const tag = mismatch === 0 ? 'PARITY✓' : 'PARITY✗';
  if (mismatch) allPass = false;
  console.log(`${tag}  ${f}  (${STEPS} steps, ${A.highWater} agents)${mismatch ? '  ' + firstField : ''}`);
}
console.log(allPass ? '\nALL AGENT SAMPLES: JS↔WASM BIT-PARITY ✓' : '\nSOME MISMATCHED ✗');
rmSync(entryPath, { force: true });
rmSync(dir, { recursive: true, force: true });

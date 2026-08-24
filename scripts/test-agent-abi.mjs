// STEP 0 verification for the shared agent-ABI descriptor: prove that
// buildAgentAbiArgs('loop'|'division'|'init', ...) produces element-for-element
// IDENTICAL arg arrays to the ORIGINAL hand-written worker builders (replicated
// below), across 2D + 3D × with/without lookup tables × with agent attrs +
// fields. The parity harness already covers the 'loop' path end-to-end (JS↔WASM);
// this covers 'division' + 'init' + 'input' (which the harness never runs) by
// construction. 'input' (the Agent Input Mapping / Paint brush fn) is asserted
// against a HAND-WRITTEN expectation derived from 'division' — division MINUS its
// three daughter scalars — so widening a `kind === 'division'` branch to the
// shared `singleAgent` predicate can never silently change one without the other.
//
// Run:  node scripts/test-agent-abi.mjs
import { build } from 'esbuild';
import { writeFileSync, rmSync, mkdtempSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os'; import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'abi-'));
const ep = join(ROOT, 'scripts', '__abi_entry.ts');
writeFileSync(ep, `
export { buildAgentAbiArgs, deriveAgentAbi } from '../src/modeler/vpl/compiler/agentAbi.ts';
export { createAgentStore } from '../src/simulator/engine/agentEngine.ts';
export { buildAgentLoopParams, buildDivisionParams, buildAgentInitParams, buildAgentInputParams,
         compileAgentGraph, agentAbiShapeOf } from '../src/modeler/vpl/compiler/compile.ts';
export { inputParamsOf } from '../src/model/inputMappingParams.ts';
export { agentUsesDivisionSibling, agentUsesDivisionRequests } from '../src/modeler/vpl/compiler/divisionUse.ts';
export { resolveAgentFieldGates } from '../src/model/agentFieldGating.ts';
export { bondAttrsOf, agentAttrsOf, cellFieldAttrsOf } from '../src/model/attributeScope.ts';
export { migrateForHarness } from '../src/dev/compileHarness.ts';
export { EMPTY_MODEL } from '../src/model/defaultModel.ts';
`);
const out = join(dir, 'b.mjs');
await build({ entryPoints: [ep], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error', absWorkingDir: process.cwd() });
const m = await import(pathToFileURL(out).href);
const { buildAgentAbiArgs, deriveAgentAbi, createAgentStore } = m;

// --- Replicas of the ORIGINAL hand-written worker arg builders (pre-STEP-0). ---
function oldLoopArgs(s, hash, rt) {
  const EMPTY_I32 = rt.emptyI32;
  const args = [
    s.alive, s.highWater,
    s.x, s.y, s.radius, s.targetRadius, s.age, s.lineage, s.bondCount, s.density,
    s.vx, s.vy, s.forceX, s.forceY,
    hash ? 1 : 0,
    hash ? hash.binStart : EMPTY_I32, hash ? hash.binAgents : EMPTY_I32,
    hash ? hash.nBinsX : 0, hash ? hash.nBinsY : 0, hash ? hash.binSizeX : 1, hash ? hash.binSizeY : 1,
    hash ? hash.originX : 0, hash ? hash.originY : 0,
    s.divideRequest, s.divideAxisX, s.divideAxisY, s.divideAsym, s.killRequest,
    rt.agentCreate, rt.agentAddToWorld, s.maxAgents,   // unified spawning (Create/Add in behaviour)
    s.bondPartner, s.bondPartnerEpoch, s.bondRestLength, s.bondStiffness, s.bondTypeLabel, s.maxBonds,
    s.bondFormReq, s.bondFormL, s.bondFormK, s.bondBreakReq,
  ];
  for (const spec of s.attrSpecs) args.push(s.attrRead[spec.id]);
  for (const spec of s.attrSpecs) args.push(s.attrWrite[spec.id]);
  args.push(rt.modelAttrs, s.colors, rt.viewer, rt.indicators, rt.rngState, rt.stopFlag, rt.glyphCodes, rt.glyphColors, s.spriteIds, s.spriteFrames, s.spriteSpeeds, s.spriteRotations, s.spriteScales);
  if (rt.hasLookupTables) args.push(rt.lookupTables);
  args.push(rt.width, rt.height, rt.total, rt.torus ? 1 : 0);
  for (const spec of rt.fieldSpecs) args.push(rt.readAttrs[spec.id]);
  if (s.worldDepth > 1) args.push(s.z, s.vz, s.forceZ, s.divideAxisZ, s.worldDepth, hash ? hash.nBinsZ : 1, hash ? hash.binSizeZ : 1, hash ? hash.originZ : 0);
  return args;
}
function oldDivisionArgs(s, idx, di, ax, ay, rt) {
  const args = [
    idx, di, ax, ay,
    s.alive, s.highWater,
    s.x, s.y, s.radius, s.targetRadius, s.age, s.lineage, s.bondCount, s.density,
    s.vx, s.vy,
    s.bondPartner, s.bondRestLength, s.bondPartnerEpoch, s.maxBonds,
  ];
  for (const spec of s.attrSpecs) args.push(s.attrRead[spec.id]);
  for (const spec of s.attrSpecs) args.push(s.attrRead[spec.id]); // w_ aliases attrRead
  args.push(rt.modelAttrs, s.colors, rt.viewer, rt.indicators, rt.rngState, rt.stopFlag, rt.glyphCodes, rt.glyphColors, s.spriteIds, s.spriteFrames, s.spriteSpeeds, s.spriteRotations, s.spriteScales);
  if (rt.hasLookupTables) args.push(rt.lookupTables);
  args.push(rt.width, rt.height, rt.total, rt.torus ? 1 : 0);
  for (const spec of rt.fieldSpecs) args.push(rt.readAttrs[spec.id]);
  if (s.worldDepth > 1) args.push(s.z, s.vz, s.divideAxisZ, s.worldDepth);
  return args;
}
function oldInitArgs(s, create, add, seedBase, rt) {
  const args = [
    create, add, s.maxAgents,
    s.x, s.y, s.radius, s.targetRadius, s.age, s.lineage, s.vx, s.vy,
  ];
  for (const spec of s.attrSpecs) args.push(s.attrRead[spec.id]);
  for (const spec of s.attrSpecs) args.push(s.attrWrite[spec.id]);
  args.push(rt.modelAttrs, s.colors, rt.viewer, rt.indicators, rt.rngState, rt.stopFlag, rt.glyphCodes, rt.glyphColors, s.spriteIds, s.spriteFrames, s.spriteSpeeds, s.spriteRotations, s.spriteScales);
  if (rt.hasLookupTables) args.push(rt.lookupTables);
  args.push(rt.width, rt.height, rt.total, rt.torus ? 1 : 0);
  for (const spec of rt.fieldSpecs) args.push(rt.readAttrs[spec.id]);
  args.push(seedBase);
  if (s.worldDepth > 1) args.push(s.z);
  return args;
}

/** The 'input' kind's EXPECTED arg list, written out independently: it is the
 *  division list minus `__daughterIndex` / `__axisDefaultX` / `__axisDefaultY`
 *  (a paint has no daughter), with the SAME attrRead-aliased `w_` block (a paint
 *  is a sequential mutation BETWEEN steps, so a write must land on the live
 *  buffer) and the SAME z-block (no forceZ). */
function expectedInputArgs(s, idx, rt) {
  const args = [
    idx,
    // Brush KINDS: the editor fn may spawn agents around the one it painted and
    // remove agents, so it carries the grow-only closures + the kill lane.
    rt.agentCreate, rt.agentAddToWorld, s.maxAgents, s.killRequest,
    s.alive, s.highWater,
    s.x, s.y, s.radius, s.targetRadius, s.age, s.lineage, s.bondCount, s.density,
    s.vx, s.vy,
    s.bondPartner, s.bondRestLength, s.bondPartnerEpoch, s.maxBonds,
  ];
  for (const spec of s.attrSpecs) args.push(s.attrRead[spec.id]);
  for (const spec of s.attrSpecs) args.push(s.attrRead[spec.id]); // w_ aliases attrRead
  args.push(rt.modelAttrs, s.colors, rt.viewer, rt.indicators, rt.rngState, rt.stopFlag, rt.glyphCodes, rt.glyphColors, s.spriteIds, s.spriteFrames, s.spriteSpeeds, s.spriteRotations, s.spriteScales);
  if (rt.hasLookupTables) args.push(rt.lookupTables);
  args.push(rt.width, rt.height, rt.total, rt.torus ? 1 : 0);
  for (const spec of rt.fieldSpecs) args.push(rt.readAttrs[spec.id]);
  if (s.worldDepth > 1) args.push(s.z, s.vz, s.divideAxisZ, s.worldDepth);
  return args;
}

/** The 'spawner' kind's EXPECTED arg list, written out independently: it is the
 *  INIT list with the spawn trio followed by `_killRequest` + the brush block
 *  (`_brushX`, `_brushY`, `_brushRadius`), and `_brushZ` appended to the trailing
 *  3D block so 2D stays a strict prefix of 3D. */
function expectedSpawnerArgs(s, create, add, seedBase, bx, by, bz, br, rt) {
  const args = [
    create, add, s.maxAgents,
    s.killRequest,
    bx, by, br,
    s.x, s.y, s.radius, s.targetRadius, s.age, s.lineage,
    s.vx, s.vy,
  ];
  for (const spec of s.attrSpecs) args.push(s.attrRead[spec.id]);
  for (const spec of s.attrSpecs) args.push(s.attrWrite[spec.id]);
  args.push(rt.modelAttrs, s.colors, rt.viewer, rt.indicators, rt.rngState, rt.stopFlag, rt.glyphCodes, rt.glyphColors, s.spriteIds, s.spriteFrames, s.spriteSpeeds, s.spriteRotations, s.spriteScales);
  if (rt.hasLookupTables) args.push(rt.lookupTables);
  args.push(rt.width, rt.height, rt.total, rt.torus ? 1 : 0);
  for (const spec of rt.fieldSpecs) args.push(rt.readAttrs[spec.id]);
  args.push(seedBase);
  if (s.worldDepth > 1) args.push(s.z, bz);
  return args;
}

let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('  ✗ ' + msg); } };

function cmp(label, a, b) {
  if (a.length !== b.length) { ok(false, `${label}: length ${a.length} vs ${b.length}`); return; }
  for (let i = 0; i < a.length; i++) {
    // Strict identity for arrays/objects/functions; strict equality for scalars.
    if (a[i] !== b[i]) { ok(false, `${label}: element ${i} differs (old=${String(a[i]).slice(0,30)} new=${String(b[i]).slice(0,30)})`); return; }
  }
  ok(true, label);
}

for (const is3d of [false, true]) {
  for (const hasLT of [false, true]) {
    const cfg = { maxAgents: 16, maxBonds: 3, timeStep: 0.1, defaultRadius: 0.5 };
    const attrSpecs = [{ id: 'energy', type: 'float', defaultValue: 0 }, { id: 'kind', type: 'integer', defaultValue: 0 }];
    const s = createAgentStore(cfg, attrSpecs, { wasmBacked: false });
    s.worldDepth = is3d ? 8 : 1;
    const fieldSpecs = [{ id: 'chemical' }, { id: 'trail' }];
    const readAttrs = { chemical: new Float64Array(64), trail: new Float64Array(64) };
    const hash = { binStart: new Int32Array(4), binAgents: new Int32Array(16), nBinsX: 2, nBinsY: 2, nBinsZ: 2, binSizeX: 3, binSizeY: 3, binSizeZ: 3, originX: 1, originY: 2, originZ: 3 };
    const rtExternal = {
      modelAttrs: { a: 1 }, viewer: 'v', indicators: new Float64Array(1), rngState: new Uint32Array(1),
      stopFlag: new Uint32Array(1), glyphCodes: new Uint32Array(1), glyphColors: new Uint32Array(1),
      lookupTables: { t: new Float64Array(4) }, width: 8, height: 8, total: 64, torus: true,
      hasLookupTables: hasLT, fieldSpecs, readAttrs,
    };
    // The NEW descriptor rt (uses fieldArray + emptyI32, no fieldSpecs/hasLookupTables/readAttrs keys).
    const shape = { is3d: s.worldDepth > 1, agentAttrs: s.attrSpecs, fieldAttrs: fieldSpecs, hasLookupTables: hasLT };
    // ONE shared empty-Int32Array instance (the real worker's module-level
    // EMPTY_I32) so the no-hash fallback compares by identity like production.
    const emptyI32 = new Int32Array(0);
    const newRtBase = {
      emptyI32, modelAttrs: rtExternal.modelAttrs, viewer: rtExternal.viewer,
      indicators: rtExternal.indicators, rngState: rtExternal.rngState, stopFlag: rtExternal.stopFlag,
      glyphCodes: rtExternal.glyphCodes, glyphColors: rtExternal.glyphColors, lookupTables: rtExternal.lookupTables,
      width: 8, height: 8, total: 64, torus: true, fieldArray: (id) => readAttrs[id],
    };
    const tag = `[${is3d ? '3D' : '2D'}${hasLT ? '+LT' : ''}]`;

    // loop (with + without hash)
    for (const h of [hash, null]) {
      const oldL = oldLoopArgs(s, h, { ...rtExternal, emptyI32 });
      const newL = buildAgentAbiArgs('loop', shape, s, { ...newRtBase, hash: h });
      cmp(`${tag} loop ${h ? 'hash' : 'nohash'}`, oldL, newL);
    }
    // division
    {
      const oldD = oldDivisionArgs(s, 3, 1, 0.7, -0.3, rtExternal);
      const newD = buildAgentAbiArgs('division', shape, s, { ...newRtBase, hash: null, idx: 3, daughterIndex: 1, axisX: 0.7, axisY: -0.3 });
      cmp(`${tag} division`, oldD, newD);
    }
    // init
    {
      const create = () => 0, add = () => {};
      const oldI = oldInitArgs(s, create, add, 5, rtExternal);
      const newI = buildAgentAbiArgs('init', shape, s, { ...newRtBase, hash: null, agentCreate: create, agentAddToWorld: add, seedBase: 5 });
      cmp(`${tag} init`, oldI, newI);
    }
    // input (the Agent Input Mapping / Paint brush fn)
    {
      const expI = expectedInputArgs(s, 4, rtExternal);
      const newI = buildAgentAbiArgs('input', shape, s, { ...newRtBase, hash: null, idx: 4 });
      cmp(`${tag} input`, expI, newI);
      // THE `w_` ALIASING CLAIM, on a store where it is OBSERVABLE. In async
      // agent mode attrWrite ALIASES attrRead, so an attrWrite/attrRead mix-up is
      // invisible — only a SYNC-attr store (distinct buffers) can catch it, and a
      // paint that wrote attrWrite would be discarded by the next step's
      // primeAgentAttrWrite. Assert identity against attrRead explicitly.
      const sSync = createAgentStore(cfg, attrSpecs, { wasmBacked: false, syncAttrs: true });
      sSync.worldDepth = s.worldDepth;
      ok(sSync.attrWrite['energy'] !== sSync.attrRead['energy'],
        `${tag} input: (precondition) the sync store really has distinct r/w buffers`);
      const syncShape = { ...shape, agentAttrs: sSync.attrSpecs };
      const syncArgs = buildAgentAbiArgs('input', syncShape, sSync, { ...newRtBase, hash: null, idx: 4 });
      const syncNames = deriveAgentAbi('input', syncShape).map(f => f.name);
      let aliasOk = true;
      for (let i = 0; i < syncNames.length; i++) {
        const n = syncNames[i];
        if (n.startsWith('w_')) aliasOk = aliasOk && syncArgs[i] === sSync.attrRead[n.slice(2)];
        if (n.startsWith('r_')) aliasOk = aliasOk && syncArgs[i] === sSync.attrRead[n.slice(2)];
      }
      ok(aliasOk, `${tag} input: every r_/w_ arg is the LIVE attrRead buffer (a paint write must survive sync mode)`);
      // …and the structural claim that makes it safe to share branches with
      // 'division': input === division with the three daughter scalars removed.
      const dNames = deriveAgentAbi('division', shape).map(f => f.name);
      const iNames = deriveAgentAbi('input', shape).map(f => f.name);
      const dMinus = dNames.filter(n => n !== '__daughterIndex' && n !== '__axisDefaultX' && n !== '__axisDefaultY');
      const LIFECYCLE = new Set(['_agentCreate', '_agentAddToWorld', '_agentMaxAgents', '_killRequest']);
      const iMinus = iNames.filter(n => !LIFECYCLE.has(n));
      ok(dMinus.join(',') === iMinus.join(','),
        `${tag} input === division minus the daughter scalars, plus the spawn/kill lifecycle block`);
      // …and the lifecycle block sits immediately after `idx`, in ABI order.
      ok(iNames.slice(0, 5).join(',') === 'idx,_agentCreate,_agentAddToWorld,_agentMaxAgents,_killRequest',
        `${tag} input: the lifecycle block leads, right after idx`);
    }
    // spawner (a SPAWNER-kind Agent Input Mapping): once per brush application.
    {
      const create = () => 0, add = () => {};
      const expS = expectedSpawnerArgs(s, create, add, 7, 11, 22, 33, 44, rtExternal);
      const newS = buildAgentAbiArgs('spawner', shape, s, {
        ...newRtBase, hash: null, agentCreate: create, agentAddToWorld: add, seedBase: 7,
        brushX: 11, brushY: 22, brushZ: 33, brushRadius: 44,
      });
      cmp(`${tag} spawner`, expS, newS);
      // THE structural claim: spawner === init + the brush block + _killRequest.
      const initNames = deriveAgentAbi('init', shape).map(f => f.name);
      const spNames = deriveAgentAbi('spawner', shape).map(f => f.name);
      const BRUSH = new Set(['_brushX', '_brushY', '_brushZ', '_brushRadius', '_killRequest']);
      ok(spNames.filter(n => !BRUSH.has(n)).join(',') === initNames.join(','),
        `${tag} spawner === init + the brush block + _killRequest`);
      // A spawner has NO self: `idx` / `_alive` / `highWater` must be absent, or
      // every by-id emitter's strict guard would reference a missing symbol.
      ok(!spNames.includes('idx') && !spNames.includes('_alive') && !spNames.includes('highWater'),
        `${tag} spawner: no self (idx / _alive / highWater absent)`);
    }
    // Descriptor internal-consistency (audit-lite): 2D field list is a strict
    // PREFIX of the 3D list (append-only z-block), per kind.
    for (const kind of ['loop', 'division', 'init', 'input', 'spawner']) {
      const names2d = deriveAgentAbi(kind, { ...shape, is3d: false }).map(f => f.name);
      const names3d = deriveAgentAbi(kind, { ...shape, is3d: true }).map(f => f.name);
      ok(names3d.slice(0, names2d.length).join(',') === names2d.join(','), `${tag} ${kind}: 2D is a prefix of 3D`);
    }
  }
}

// ===========================================================================
// TIER 2 — PARAMS vs ARGS, the mirror the tier above cannot see.
//
// Everything above compares one ARG list against another ARG list. That proves
// the descriptor is internally consistent; it proves NOTHING about the pairing
// the DEV arity assert actually guards:
//
//     compile.ts  buildAgent*Params(model)      <->  worker  buildAgent*Args(store)
//
// The two sides build their `AgentAbiShape` from DIFFERENT inputs (a CAModel vs a
// live AgentStore + the worker's module globals), which is exactly the C9
// `gates`-missing-from-`agentAbiShapeOfStore` desync class. So this tier builds
// the worker side THE WAY THE WORKER DOES — from a real `createAgentStore` — and
// compares it against the REAL compile-side param strings.
//
// It also covers the FOURTH pair's extra term, which nothing tested at all: an
// Agent Input Mapping's compiled fn declares the mapping's RESOLVED CHANNEL list
// as LEADING params. The worker's assert used to add a hardcoded `3` (the legacy
// colour count) instead of the shipped count, so every mapping declaring a
// different parameter list fired a false-positive DESYNC — `parameters: []`
// (0 channels) produced the reported "declares 31 ... passes 35".
//
// THE INVARIANT, stated so the channel count cannot hide in it:
//   want - declared  ==  args - params  ∈ {0, 1}
// i.e. the gap is the documented trailing `_generation` asymmetry ALONE and is
// INDEPENDENT of how many channels the mapping declares.
// ===========================================================================
const {
  buildAgentLoopParams, buildDivisionParams, buildAgentInitParams, buildAgentInputParams,
  compileAgentGraph, inputParamsOf, resolveAgentFieldGates,
  bondAttrsOf, agentAttrsOf, cellFieldAttrsOf, migrateForHarness, EMPTY_MODEL,
} = m;

const paramNames = (s) => s.split(',').map(x => x.trim()).filter(Boolean);

/** The worker's OWN shape derivation (`agentAbiShapeOfStore` + the init handler's
 *  spec lists), replicated from a REAL store — never from `agentAbiShapeOf(model)`,
 *  which would make this tier compare the compile side with itself. */
function workerShapeOf(model) {
  const cb = model.centerBased ?? {};
  const attrSpecs = agentAttrsOf(model).map(a => ({ id: a.id, type: a.type, defaultValue: 0 }));
  const bondSpecs = bondAttrsOf(model).map(a => ({ id: a.id, type: a.type, defaultValue: 0 }));
  const store = createAgentStore(cb, attrSpecs, {
    wasmBacked: false,
    syncAttrs: cb.agentUpdateMode === 'sync',
    bondAttrSpecs: bondSpecs,
    fieldGates: resolveAgentFieldGates(model),
  });
  // The worker sets this from the grid `depth` local (`is3dModel(model)` ⟺ >1).
  store.worldDepth = model.properties?.dimension === '3d' ? Math.max(1, model.properties?.gridDepth ?? 1) : 1;
  const shape = {
    is3d: store.worldDepth > 1,
    agentAttrs: store.attrSpecs,
    fieldAttrs: cellFieldAttrsOf(model),
    hasLookupTables: (model.attributes ?? []).some(a => a.isModelAttribute && a.type === 'lookupTable'),
    bondAttrs: store.bondAttrSpecs,
    usesGeneration: true,          // the worker ALWAYS passes the value
    // D3 / D4 — SYMMETRIC: the worker reads the SHIPPED compiler-derived flags,
    // so this side must reproduce that (not always-true like `usesGeneration`).
    usesDivisionSibling: m.agentUsesDivisionSibling(model),
    usesDivisionRequests: m.agentUsesDivisionRequests(model),
    gates: store.fieldGates,
  };
  return { store, shape };
}

/** Assert one model's four ABI pairs. `channels` (input kind) is threaded through
 *  BOTH sides exactly as production does, so the invariant above must hold. */
function checkModel(label, model) {
  const { shape } = workerShapeOf(model);
  const kinds = [
    ['loop', paramNames(buildAgentLoopParams(model).params)],
    ['division', paramNames(buildDivisionParams(model))],
    ['init', paramNames(buildAgentInitParams(model))],
    ['input', paramNames(buildAgentInputParams(model))],
  ];
  for (const [kind, params] of kinds) {
    const args = deriveAgentAbi(kind, shape).map(f => f.name);
    const gap = args.length - params.length;
    ok(gap === 0 || gap === 1, `${label} ${kind}: args-params gap ${gap} (must be 0, or 1 for the _generation asymmetry)`);
    // The gap must be the trailing `_generation` and NOTHING else: every param
    // must appear at the same index in the arg list.
    const shifted = params.findIndex((p, i) => args[i] !== p);
    ok(shifted === -1, `${label} ${kind}: param[${shifted}] '${params[shifted]}' != arg[${shifted}] '${args[shifted]}' (a SHIFTED block, not the generation slack)`);
    if (gap === 1) ok(args[args.length - 1] === '_generation', `${label} ${kind}: the one extra arg is _generation (got '${args[args.length - 1]}')`);
  }
  return shape;
}

/** The FOURTH pair end-to-end: the REAL compiled fn's `.length` vs the worker's
 *  assert formula, for a given agent input mapping. */
function checkInputMapping(label, model, mappingId) {
  const { shape } = workerShapeOf(model);
  const res = compileAgentGraph(model.agentGraphNodes ?? [], model.agentGraphEdges ?? [], model);
  const entry = (res.inputMappingCodes ?? []).find(c => c.mappingId === mappingId);
  if (!entry) { ok(false, `${label}: no compiled input mapping '${mappingId}' (${res.error ?? 'no error'})`); return; }
  const mapping = (model.agentMappings ?? []).find(x => x.id === mappingId);
  const resolvedChannels = inputParamsOf(mapping).channels.length;
  ok(entry.channels === resolvedChannels,
    `${label}: the SHIPPED channel count (${entry.channels}) is the resolver's (${resolvedChannels})`);

  // eslint-disable-next-line no-eval
  const fn = eval(entry.code);
  const declared = fn.length;                                   // what the worker sees
  const args = deriveAgentAbi('input', shape).length;
  const want = args + entry.channels;                           // the worker's assert formula
  ok(declared === paramNames(buildAgentInputParams(model)).length + entry.channels,
    `${label}: fn.length == descriptor params + channels`);
  const gap = want - declared;
  ok(gap === 0 || gap === 1,
    `${label}: assert gap ${gap} with ${entry.channels} channel(s) — declares ${declared}, want ${want} (a hardcoded channel constant shows up HERE)`);
}

{
  // --- Synthetic matrix -----------------------------------------------------
  const CAPS = { motion: 'force', body: true, collision: 'off', charge: 'off', bonds: 'off', autoBond: false,
    growth: false, division: false, lifespan: false, populationBirth: false, populationDeath: false,
    sensing: false, orientation: false, fieldCoupling: false, appearance: true };
  const node = (id, nodeType, config = {}) => ({ id, type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType, config } });
  const vE = (s, sp, t, tp) => ({ id: `v${s}${sp}${t}${tp}`, source: s, target: t, sourceHandle: `output_value_${sp}`, targetHandle: `input_value_${tp}` });
  const fE = (s, sp, t, tp) => ({ id: `f${s}${sp}${t}${tp}`, source: s, target: t, sourceHandle: `output_flow_${sp}`, targetHandle: `input_flow_${tp}` });

  const MID = 'agent_input_probe';
  /** The user's reported graph: Get Velocity -> x2 -> Set Velocity, under an
   *  Agent Input Mapping root. `params` is the mapping's parameter list
   *  (undefined = LEGACY colour, [] = deliberately none). */
  const build = ({ params, is3d = false, caps = {}, agentAttrs = [], cellAttrs = [], readsGeneration = false }) => ({
    ...EMPTY_MODEL,
    properties: { ...EMPTY_MODEL.properties, dimension: is3d ? '3d' : '2d', gridDepth: is3d ? 8 : 1 },
    topologyMode: { gridCells: cellAttrs.length > 0, agents: true },
    attributes: cellAttrs,
    agentAttributes: agentAttrs,
    centerBased: { maxAgents: 64, maxBonds: 0, timeStep: 0.1, defaultRadius: 0.5, worldWidth: 64, worldHeight: 64,
      agentCapabilities: { ...CAPS, ...caps } },
    agentMappings: [{ id: MID, name: 'P', description: '', isAttributeToColor: false, linked: false,
      redDescription: '', greenDescription: '', blueDescription: '', ...(params !== undefined ? { parameters: params } : {}) }],
    agentGraphNodes: [
      node('bs', 'behaviourStep'),
      node('root', 'agentInputMapping', { mappingId: MID }),
      node('gv', 'getVelocity'),
      node('mx', 'arithmeticOperator', { operation: '*', _port_y: '2' }),
      node('sv', 'setVelocity'),
      ...(readsGeneration ? [node('gen', 'getGeneration'), node('sr', 'setAgentRadius')] : []),
    ],
    agentGraphEdges: [
      fE('root', 'do', 'sv', 'do'),
      vE('gv', 'vx', 'mx', 'x'), vE('mx', 'result', 'sv', 'vx'),
      ...(readsGeneration ? [fE('bs', 'do', 'sr', 'do'), vE('gen', 'generation', 'sr', 'radius')] : []),
    ],
  });

  const AGENT_ATTRS = [{ id: 'energy', name: 'E', type: 'float', defaultValue: '0', description: '' }];
  const FIELD_ATTRS = [{ id: 'chem', name: 'C', type: 'float', defaultValue: '0', description: '', agentAccess: 'readWrite' }];

  // Every parameter shape the resolver can produce: legacy(3), none(0),
  // one scalar(1), two scalars(2), colour+scalar(4), two colours(6).
  const PARAM_SHAPES = [
    ['legacy(absent)', undefined, 3],
    ['empty[]', [], 0],
    ['1 float', [{ key: 'k', name: 'K', type: 'float', defaultValue: '2' }], 1],
    ['2 scalars', [{ key: 'a', name: 'A', type: 'float', defaultValue: '1' }, { key: 'b', name: 'B', type: 'integer', defaultValue: '1' }], 2],
    ['colour+scalar', [{ key: 'tint', name: 'T', type: 'color', defaultValue: '#112233' }, { key: 'q', name: 'Q', type: 'bool', defaultValue: 'false' }], 4],
    ['2 colours', [{ key: 'c1', name: 'C1', type: 'color', defaultValue: '#000000' }, { key: 'c2', name: 'C2', type: 'color', defaultValue: '#ffffff' }], 6],
  ];
  for (const [pl, params, expectChannels] of PARAM_SHAPES) {
    for (const is3d of [false, true]) {
      for (const [vTag, extra] of [
        ['plain', {}],
        ['gates+attrs', { caps: { lifespan: true, growth: true, division: true, sensing: true }, agentAttrs: AGENT_ATTRS, cellAttrs: FIELD_ATTRS }],
      ]) {
        const label = `[T2 ${pl} ${is3d ? '3D' : '2D'} ${vTag}]`;
        const model = migrateForHarness(build({ params, is3d, ...extra }));
        ok(inputParamsOf(model.agentMappings[0]).channels.length === expectChannels,
          `${label}: resolver mints ${expectChannels} channel(s)`);
        checkModel(label, model);
        checkInputMapping(label, model, MID);
      }
    }
  }

  // Get Generation closes the documented ±1: the param side then declares it too.
  {
    const model = migrateForHarness(build({ params: [], readsGeneration: true }));
    const { shape } = workerShapeOf(model);
    const args = deriveAgentAbi('loop', shape).map(f => f.name);
    const params = paramNames(buildAgentLoopParams(model).params);
    ok(args.length === params.length && params[params.length - 1] === '_generation',
      `[T2 generation] a graph that READS the generation declares it (gap ${args.length - params.length})`);
  }

  // --- Every shipped agent model -------------------------------------------
  const modelsDir = join(ROOT, 'public', 'models');
  let shipped = 0;
  for (const f of readdirSync(modelsDir).filter(x => x.endsWith('.gcaproj')).sort()) {
    let raw;
    try { raw = JSON.parse(readFileSync(join(modelsDir, f), 'utf8')); } catch { continue; }
    const model = migrateForHarness(raw.model ?? raw);
    if (!model.topologyMode?.agents) continue;
    shipped++;
    checkModel(`[T2 ${f}]`, model);
  }
  ok(shipped >= 10, `[T2] swept the shipped agent models (${shipped} found — a broken loader must not pass vacuously)`);
}

// ===========================================================================
// TIER 3 — SOURCE INVARIANTS on the worker's arity assert + the channel plumbing.
//
// Tier 2's arithmetic is necessarily a MIRROR of the fixed formula, so on its own
// it could not notice the worker reverting to a hardcoded constant. These pin the
// shipped source: the assert must read the SHIPPED count, the compiler must ship
// it, and the paint handler must reject a mismatched payload.
// ===========================================================================
{
  const worker = readFileSync(join(ROOT, 'src', 'simulator', 'engine', 'sim.worker.ts'), 'utf8');
  const compile = readFileSync(join(ROOT, 'src', 'modeler', 'vpl', 'compiler', 'compile.ts'), 'utf8');

  /** The balanced-brace body of the block that STARTS at `anchor`. Searches for
   *  the opening brace AFTER the match so an anchor may include a signature. */
  const blockAfter = (src, anchor) => {
    const i = src.search(anchor);
    if (i < 0) return '';
    const s = src.indexOf('{', i + String(src.match(anchor)?.[0] ?? '').length - 1);
    if (s < 0) return '';
    let d = 0;
    for (let j = s; j < src.length; j++) {
      if (src[j] === '{') d++;
      else if (src[j] === '}' && --d === 0) return src.slice(s, j + 1);
    }
    return '';
  };

  // The SIBLING kinds must stay free of un-derived addends too: their `want` is
  // `buildX Args(...).length` and nothing else. `input` was the only pair with a
  // term outside the shared descriptor (the leading channels) — and therefore the
  // only one that COULD carry a hardcoded constant. Pin all four so a future kind
  // with its own leading block cannot repeat this.
  for (const [kind, re] of [
    ['behaviour', /const want = buildAgentLoopArgs\(s\)\.length;/],
    ['division', /const want = buildDivisionArgs\(s, 0, 0, 0, 0\)\.length;/],
    ['init', /const want = buildAgentInitArgs\(s, \(\) => 0, \(\) => \{\}, 0\)\.length;/],
  ]) {
    ok(re.test(worker), `[T3] the ${kind} arity assert derives 'want' from its arg builder alone (no literal addend)`);
  }

  const assertBlock = blockAfter(worker, /for \(const im of agentInputMappingFns\)/);
  ok(assertBlock.length > 0, '[T3] found the input-mapping arity-assert block');
  // Both KINDS must add the SHIPPED channel count, and each must derive its base
  // from ITS OWN arg builder — a spawner sized by the editor builder is exactly
  // the desync this pair exists to catch.
  ok(/buildAgentInputArgs\([\s\S]*?\)\.length \+ im\.channels/.test(assertBlock),
    '[T3] the EDITOR assert adds the SHIPPED im.channels (never a hardcoded channel count)');
  ok(/buildAgentSpawnerArgs\([\s\S]*?\)\.length \+ im\.channels/.test(assertBlock),
    '[T3] the SPAWNER assert adds the SHIPPED im.channels, off its OWN arg builder');
  ok(/im\.spawner/.test(assertBlock),
    '[T3] the assert branches on the SHIPPED brush kind (im.spawner)');
  ok(!/\.length \+ \d/.test(assertBlock),
    '[T3] the assert adds no NUMERIC literal to the arg count (the pre-fix `+ 3` bug)');

  ok(/inputMappingCodes\.push\(\{[^}]*channels: imResolved\.channels\.length/.test(compile),
    '[T3] the compiler SHIPS the resolved channel count alongside each input-mapping fn');
  ok(/agentInputMappingFns\.push\(\{[^}]*channels: im\.channels/.test(worker),
    '[T3] the worker STORES the shipped channel count per compiled input-mapping fn');

  const runBlock = blockAfter(worker, /function runAgentInputMapping\(/);
  ok(/values\.length !== im\.channels/.test(runBlock),
    '[T3] runAgentInputMapping rejects a payload whose channel count disagrees with the compiled fn');
}


// ===========================================================================
// TIER 4 — D3 / D4: the two GATED, TRAILING `division` blocks.
//
//   D3  `__siblingId`               — the OTHER daughter's slot id.
//   D4  the structural REQUEST QUEUE (`_bondFormReq` / `_bondFormL` /
//       `_bondFormK` / `_bondBreakReq` + one `_bondFormAttr_<id>` per bond
//       attribute) — so Form / Break / Rewire / Transfer Bond are usable in a
//       Division Event.
//
// Both are SYMMETRICALLY gated (Impact Map §5.3): unlike `_generation`, the
// WORKER gates too, off the flags the compiler SHIPS. So the pairing this tier
// must prove is that the arg/param GAP stays the documented {0,1} — i.e. the
// worker never silently passes an extra trailing block the fn does not declare,
// nor declares one it is never given.
//
// Every combination is exercised (neither / sibling only / requests only / both)
// against an INDEPENDENT expected suffix, in 2D and 3D, with and without bond
// attributes — the last of which is what makes the per-attribute cells real.
// ===========================================================================
{
  const { agentUsesDivisionSibling, agentUsesDivisionRequests } = m;
  const node = (id, nodeType, config = {}) => ({ id, type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType, config } });
  const CAPS4 = { motion: 'force', body: true, collision: 'off', charge: 'off', bonds: 'off', autoBond: false,
    growth: false, division: false, lifespan: false, populationBirth: false, populationDeath: false,
    sensing: false, orientation: false, fieldCoupling: false, appearance: true };

  /** A model with a Division Event, optionally wiring `siblingId` (D3) and/or
   *  issuing a Form Bond from the division flow chain (D4). `behaviourBond` puts
   *  a bond verb in the BEHAVIOUR chain instead — the case that must NOT turn D4
   *  on, since the scan is division-SUBTREE-scoped. */
  const buildDiv = ({ sibling = false, request = false, behaviourBond = false, is3d = false, bondAttrs = false, macroRequest = false }) => {
    const nodes = [node('bs', 'behaviourStep'), node('dv', 'divisionEvent'), node('sa', 'setAttribute', { attributeId: 'energy' })];
    const edges = [];
    if (sibling) edges.push({ id: 'es', source: 'dv', target: 'sa', sourceHandle: 'output_value_siblingId', targetHandle: 'input_value_agentId' });
    else edges.push({ id: 'ed', source: 'dv', target: 'sa', sourceHandle: 'output_flow_do', targetHandle: 'input_flow_do' });
    if (request) { nodes.push(node('fb', 'formBond')); edges.push({ id: 'er', source: 'dv', target: 'fb', sourceHandle: 'output_flow_do', targetHandle: 'input_flow_do' }); }
    if (behaviourBond) { nodes.push(node('bb', 'formBond')); edges.push({ id: 'eb', source: 'bs', target: 'bb', sourceHandle: 'output_flow_do', targetHandle: 'input_flow_do' }); }
    const macroDefs = [];
    if (macroRequest) {
      macroDefs.push({ id: 'md1', name: 'M', exposedInputs: [], exposedOutputs: [],
        nodes: [node('mfb', 'formBond')], edges: [] });
      nodes.push(node('mac', 'macro', { macroDefId: 'md1' }));
      edges.push({ id: 'em', source: 'dv', target: 'mac', sourceHandle: 'output_flow_do', targetHandle: 'input_flow_do' });
    }
    return migrateForHarness({
      ...EMPTY_MODEL,
      properties: { ...EMPTY_MODEL.properties, dimension: is3d ? '3d' : '2d', gridDepth: is3d ? 8 : 1 },
      topologyMode: { gridCells: false, agents: true },
      agentAttributes: [{ id: 'energy', name: 'E', type: 'float', defaultValue: '0', description: '' }],
      bondAttributes: bondAttrs ? [{ id: 'w', name: 'W', type: 'float', defaultValue: '0', description: '' }] : [],
      centerBased: {
        maxAgents: 32, maxBonds: 4, bondRequestDepth: 4, timeStep: 0.1, defaultRadius: 0.5, worldWidth: 32, worldHeight: 32,
        agentCapabilities: { ...CAPS4, bonds: 'physics', division: true },
      },
      agentGraphNodes: nodes, agentGraphEdges: edges, macroDefs,
    });
  };

  /** The expected TRAILING suffix of the `division` ABI, written out
   *  independently of the descriptor: siblingId, then the queue block, then the
   *  generation (which no fixture here reads, so it never appears). */
  const expectedTail = (sib, req, bondAttrIds) => [
    ...(sib ? ['__siblingId'] : []),
    ...(req ? ['_bondFormReq', '_bondFormL', '_bondFormK', '_bondBreakReq', ...bondAttrIds.map(id => `_bondFormAttr_${id}`)] : []),
  ];

  for (const is3d of [false, true]) {
    for (const bondAttrs of [false, true]) {
      for (const [sib, req] of [[false, false], [true, false], [false, true], [true, true]]) {
        const tag = `[T4 ${is3d ? '3D' : '2D'}${bondAttrs ? '+battr' : ''} sib=${sib} req=${req}]`;
        const model = buildDiv({ sibling: sib, request: req, is3d, bondAttrs });
        // The predicates ARE the gate — assert them before anything derived.
        ok(agentUsesDivisionSibling(model) === sib, `${tag}: agentUsesDivisionSibling === ${sib}`);
        ok(agentUsesDivisionRequests(model) === req, `${tag}: agentUsesDivisionRequests === ${req}`);
        // The descriptor's trailing block, against the independent expectation.
        const { shape } = workerShapeOf(model);
        // The WORKER shape always carries `_generation` (its arg side is
        // unconditional — the documented one-sided field), so drop it before
        // comparing the D3/D4 tail.
        const namesRaw = deriveAgentAbi('division', shape).map(f => f.name);
        const names = namesRaw[namesRaw.length - 1] === '_generation' ? namesRaw.slice(0, -1) : namesRaw;
        const want = expectedTail(sib, req, bondAttrs ? ['w'] : []);
        ok(want.length === 0 || names.slice(names.length - want.length).join(',') === want.join(','),
          `${tag}: division tail is '${want.join(',')}' (got '${names.slice(-Math.max(1, want.length)).join(',')}')`);
        // Nothing outside the tail may carry these names (a MID-list insertion
        // would shift every later arg and break the 2D-prefix rule).
        const head = names.slice(0, names.length - want.length);
        ok(!head.includes('__siblingId') && !head.includes('_bondBreakReq'),
          `${tag}: neither block leaks into the head of the division ABI`);
        // DIVISION-ONLY: no other kind grows them.
        for (const k of ['loop', 'init', 'input', 'spawner']) {
          const kn = deriveAgentAbi(k, shape).map(f => f.name);
          ok(!kn.includes('__siblingId'), `${tag}: '${k}' has no __siblingId`);
        }
        // 2D is still a strict prefix of 3D once the gated tail is stripped.
        const strip = (a) => { let e = a.length; while (e > 0 && (a[e - 1] === '_generation' || want.includes(a[e - 1]))) e--; return a.slice(0, e); };
        const n2 = strip(deriveAgentAbi('division', { ...shape, is3d: false }).map(f => f.name));
        const n3 = strip(deriveAgentAbi('division', { ...shape, is3d: true }).map(f => f.name));
        ok(n3.slice(0, n2.length).join(',') === n2.join(','), `${tag}: 2D prefix of 3D holds with the gated tail stripped`);
        // THE PAIRING the DEV arity assert guards: compile params vs worker args.
        checkModel(tag, model);
        // …and the compiled division fn really declares them (the emit side).
        const res = compileAgentGraph(model.agentGraphNodes, model.agentGraphEdges, model);
        ok(!res.error, `${tag}: the agent graph compiles (${res.error ?? 'ok'})`);
        // eslint-disable-next-line no-eval
        const fn = eval(res.divisionCode);
        ok(fn.length === paramNames(buildDivisionParams(model)).length,
          `${tag}: the compiled division fn declares exactly the descriptor's params`);
        ok(res.divisionCode.includes('_siblingId = __siblingId') === sib,
          `${tag}: the siblingId alias is emitted iff the param exists`);
        ok(res.divisionCode.includes('let _brqC = 0;') === req,
          `${tag}: the queue cursor is declared iff the queue block exists`);
        if (req) ok(/_bondFormReq\[_bq\]/.test(res.divisionCode), `${tag}: the division fn really writes the queue`);
      }
    }
  }

  // SCOPE — a bond verb in the BEHAVIOUR chain must NOT turn D4 on (the whole
  // reason the scan is division-subtree-scoped: every shipped GRA model rewrites
  // bonds in its behaviour step, and several could carry a Division Event).
  {
    const model = buildDiv({ behaviourBond: true });
    ok(agentUsesDivisionRequests(model) === false,
      '[T4 scope] a Form Bond in the BEHAVIOUR chain does not widen the division ABI');
    ok(!paramNames(buildDivisionParams(model)).includes('_bondFormReq'),
      '[T4 scope] …and the division params stay pre-D4');
  }
  // …while a MACRO instance in the division chain whose body holds one DOES.
  {
    const model = buildDiv({ macroRequest: true });
    ok(agentUsesDivisionRequests(model) === true,
      '[T4 scope] a reached MACRO whose body holds a bond verb widens the division ABI (macros expand at compile time)');
  }
  // A model with NO Division Event at all is untouched by either flag.
  {
    const model = migrateForHarness({
      ...EMPTY_MODEL,
      topologyMode: { gridCells: false, agents: true },
      centerBased: { maxAgents: 8, maxBonds: 2, agentCapabilities: { ...CAPS4, bonds: 'physics' } },
      agentGraphNodes: [node('bs', 'behaviourStep'), node('fb', 'formBond')],
      agentGraphEdges: [{ id: 'e', source: 'bs', target: 'fb', sourceHandle: 'output_flow_do', targetHandle: 'input_flow_do' }],
    });
    ok(agentUsesDivisionSibling(model) === false && agentUsesDivisionRequests(model) === false,
      '[T4 no-division] a model without a Division Event sets neither flag');
  }

  // --- SOURCE INVARIANTS: the worker must read the SHIPPED flags, gate the
  // SECOND drain on D4's, and disambiguate its overflow notice. Tier 4's
  // arithmetic above is a mirror of the descriptor and could not see a worker
  // that re-derived (or ignored) them.
  const worker4 = readFileSync(join(ROOT, 'src', 'simulator', 'engine', 'sim.worker.ts'), 'utf8');
  const sv4 = readFileSync(join(ROOT, 'src', 'simulator', 'SimulatorView.tsx'), 'utf8');
  ok(/usesDivisionSibling: agentUsesDivisionSibling, usesDivisionRequests: agentUsesDivisionRequests/.test(worker4),
    '[T4 src] agentAbiShapeOfStore passes the SHIPPED division flags (symmetric gating)');
  ok(/agentUsesDivisionSibling = !!msg\.agentUsesDivisionSibling/.test(worker4)
    && /agentUsesDivisionSibling = !!rc\.agentUsesDivisionSibling/.test(worker4),
    '[T4 src] the worker stores the shipped flags on BOTH init and recompile');
  ok(/agentUsesDivisionRequests && drainAgentBondRequests\(s, lambda\)/.test(worker4),
    '[T4 src] the SECOND drain is gated on the shipped D4 flag');
  ok((worker4.match(/drainAgentBondRequests\(s, lambda\)/g) || []).length === 2,
    '[T4 src] there are exactly TWO drains in the structural phase');
  ok(/queue full during division events/.test(worker4),
    '[T4 src] the second drain overflow notice is disambiguated from the first');
  ok(/buildDivisionArgs\(s, ev\.a, 0, ev\.axisX, ev\.axisY, ev\.b\)/.test(worker4)
    && /buildDivisionArgs\(s, ev\.b, 1, ev\.axisX, ev\.axisY, ev\.a\)/.test(worker4),
    '[T4 src] runDivisionEvent passes each daughter the OTHER one id');
  ok(/agentUsesDivisionSibling: agentUsesDivisionSibling\(model\)/.test(sv4)
    && /agentUsesDivisionRequests: agentUsesDivisionRequests\(model\)/.test(sv4),
    '[T4 src] SimulatorView SHIPS both flags (derived from the model, never in the worker)');
}

console.log(`\n${fail === 0 ? 'ALL ABI DESCRIPTOR TESTS PASS ✓' : 'SOME FAILED ✗'}  (${pass} passed, ${fail} failed)`);
rmSync(ep, { force: true });
rmSync(dir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);

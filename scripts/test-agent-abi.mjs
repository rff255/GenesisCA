// STEP 0 verification for the shared agent-ABI descriptor: prove that
// buildAgentAbiArgs('loop'|'division'|'init', ...) produces element-for-element
// IDENTICAL arg arrays to the ORIGINAL hand-written worker builders (replicated
// below), across 2D + 3D × with/without lookup tables × with agent attrs +
// fields. The parity harness already covers the 'loop' path end-to-end (JS↔WASM);
// this covers 'division' + 'init' (which the harness never runs) by construction.
//
// Run:  node scripts/test-agent-abi.mjs
import { build } from 'esbuild';
import { writeFileSync, rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os'; import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'abi-'));
const ep = join(ROOT, 'scripts', '__abi_entry.ts');
writeFileSync(ep, `
export { buildAgentAbiArgs, deriveAgentAbi } from '../src/modeler/vpl/compiler/agentAbi.ts';
export { createAgentStore } from '../src/simulator/engine/agentEngine.ts';
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
    // Descriptor internal-consistency (audit-lite): 2D field list is a strict
    // PREFIX of the 3D list (append-only z-block), per kind.
    for (const kind of ['loop', 'division', 'init']) {
      const names2d = deriveAgentAbi(kind, { ...shape, is3d: false }).map(f => f.name);
      const names3d = deriveAgentAbi(kind, { ...shape, is3d: true }).map(f => f.name);
      ok(names3d.slice(0, names2d.length).join(',') === names2d.join(','), `${tag} ${kind}: 2D is a prefix of 3D`);
    }
  }
}

console.log(`\n${fail === 0 ? 'ALL ABI DESCRIPTOR TESTS PASS ✓' : 'SOME FAILED ✗'}  (${pass} passed, ${fail} failed)`);
rmSync(ep, { force: true });
rmSync(dir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);

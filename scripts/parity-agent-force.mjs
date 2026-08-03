// Force-pass PARITY harness — JS force loop vs the WASM `forcePass`, for the
// Collision capability (the milestone gap the behaviour-only parity harness never
// covered). The soft-sphere force pass is a SEPARATE WASM export from `behaviour`;
// `parity-agent-wasm.mjs` only exercises the behaviour fn, so the collision wiring
// (bonding || doCollision gate + muRep/muAdh split) needs its own JS↔WASM check.
//
// It verifies, over several steps of a small overlapping-agent world:
//   (A) JS↔WASM bit-parity of xNext/yNext/vx/vy/density for FOUR gate combos
//       (collision-only, bonding-only, both, neither);
//   (B) BEHAVIOUR: collision-on actually separates overlapping agents (the pass-
//       through bug the user reported), collision-off leaves them overlapping.
//
// Run from the repo root:  node scripts/parity-agent-force.mjs
import { build } from 'esbuild';
import { writeFileSync, rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = `
export { createAgentStore, computeAgentMaxHashBins, buildSpatialHash, seedAgents, buildAgentOctree, agentOctreeNodeReserve } from '../src/simulator/engine/agentEngine.ts';
export { compileAgentGraphWasm, instantiateAgentWasm } from '../src/modeler/vpl/compiler/agentWasm/compile.ts';
`;
const dir = mkdtempSync(join(tmpdir(), 'gca-fp-'));
const entryPath = join(ROOT, 'scripts', '__fp_entry.ts');
writeFileSync(entryPath, ENTRY);
const outPath = join(dir, 'bundle.mjs');
await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: process.cwd() });
const mod = await import(pathToFileURL(outPath).href);
const { createAgentStore, seedAgents, buildSpatialHash, compileAgentGraphWasm, instantiateAgentWasm, computeAgentMaxHashBins, buildAgentOctree, agentOctreeNodeReserve } = mod;

const W = 40, H = 40;
const baseCfg = {
  enabled: true, maxAgents: 200, maxBonds: 0,
  worldWidth: W, worldHeight: H, worldDepth: 1,
  repulsionStiffness: 2.0, adhesionStiffness: 1.5, interactionRange: 1.5,
  drag: 1.0, timeStep: 0.1, momentum: 0.0, maxSpeed: 0.0,
  neighbourQueryRadius: 5.0, defaultRadius: 0.5, growthRate: 0.0,
};

// The FULL force-pass ABI (mirrors FORCE_PASS_PARAMS in agentWasm/compile.ts), plus
// L1's appended 4-param CHARGE block. The worker passes the charge block
// UNCONDITIONALLY (see the extra-args assertion below), so this mirror does too.
const forceArgs = (s, hash, cfg, dtOverEta, bonding, doCollision, torus, doDensity = true, ch = OFF_CHARGE, dims = { W, H, D: 1 }, tree = null) => ([
  s.highWater, hash ? 1 : 0, hash ? hash.nBinsX : 0, hash ? hash.nBinsY : 0, hash ? hash.nBinsZ : 0,
  hash ? hash.binSizeX : 1, hash ? hash.binSizeY : 1, hash ? hash.binSizeZ : 1,
  dtOverEta, cfg.repulsionStiffness, cfg.adhesionStiffness, cfg.interactionRange,
  cfg.momentum, cfg.maxSpeed, 0 /*growthRate — collision/gas never grows*/,
  dims.W, dims.H, dims.D, bonding ? 1 : 0, torus ? 1 : 0,
  hash ? hash.originX : 0, hash ? hash.originY : 0, hash ? hash.originZ : 0,
  doCollision ? 1 : 0, bonding ? 1 : 0 /*doSprings — no bonds in this harness (bc=0), so inert*/,
  doDensity ? 1 : 0 /*P1: run the neighbour/density scan*/,
  ch.doCharge ? 1 : 0, ch.chargeK, ch.chargeMaxD2, ch.chargeMinC,   // L1 charge block
  // C10 GLOBAL block — ALWAYS passed, like the L1 block (a 26/30-param module
  // ignores the extras; the dangerous direction is structurally impossible).
  tree ? Math.min(tree.nodeCount, s.layout?.chargeTreeNodes ?? 0) : 0, ch.chargeTheta2 ?? 0,
]);

/** Build the charge constants exactly the way the engine's `chargeParamsOf` does
 *  (precomputed cutoff² + minC, so JS and WASM fold identical constants). */
const mkCharge = (k, maxDist) => {
  const chargeMaxD2 = maxDist * maxDist;
  return { doCharge: true, chargeK: k, chargeMaxD2, chargeMinC: 1 / (1 + chargeMaxD2), doChargeTree: false, chargeTheta2: 0 };
};
const OFF_CHARGE = { doCharge: false, chargeK: 0, chargeMaxD2: 0, chargeMinC: 1, doChargeTree: false, chargeTheta2: 0 };
/** C10 — GLOBAL (Barnes-Hut) charge: no cutoff at all, so the CUTOFF pair term is
 *  OFF (`doCharge: false`) and the whole force comes from the tree traversal.
 *  Mirrors `chargeParamsOf` exactly. */
const mkGlobalCharge = (k, theta) => ({
  doCharge: false, chargeK: k, chargeMaxD2: 0, chargeMinC: 1,
  doChargeTree: true, chargeTheta2: theta * theta,
});

// Verbatim JS force loop — matches the CURRENT sim.worker.ts runAgentStep
// (doForce = doCollision||engineForces; muRep = doCollision?muR:0; muAdh = engineForces?muA:0).
// Like the engine it branches on `is3d` ONCE rather than carrying a dz that is
// always 0, so the 2D arm's arithmetic + stencil count stay exactly the 2D ones.
// L1: the charge term sits BEFORE the soft-sphere's rmax cutoff (its own cutoff is
// much wider), mirroring the engine.
function jsForceLoop(s, hash, cfg, dtOverEta, bonding, doCollision, torus, doDensity = true, ch = OFF_CHARGE, is3d = false, tree = null) {
  const hw = s.highWater, x = s.x, y = s.y, z = s.z, rad = s.radius, alive = s.alive;
  const xN = s.xNext, yN = s.yNext, zN = s.zNext, vxArr = s.vx, vyArr = s.vy, vzArr = s.vz;
  const W2 = s.worldWidth, H2 = s.worldHeight, D2 = s.worldDepth;
  const halfW = W2 / 2, halfH = H2 / 2, halfD = D2 / 2;
  const range = cfg.interactionRange, muR = cfg.repulsionStiffness, muA = cfg.adhesionStiffness;
  const momentum = cfg.momentum, maxSpeed = cfg.maxSpeed;
  const engineForces = bonding;
  const muRep = doCollision ? muR : 0, muAdh = engineForces ? muA : 0;
  const doForce = doCollision || engineForces;
  const { doCharge, chargeK, chargeMaxD2, chargeMinC, doChargeTree = false, chargeTheta2 = 0 } = ch;
  const doScan = doForce || doDensity || doCharge;   // P1 + L1: charge needs the scan too
  for (let i = 0; i < hw; i++) {
    if (!alive[i]) { xN[i] = x[i]; yN[i] = y[i]; if (is3d) zN[i] = z[i]; continue; }
    const xi = x[i], yi = y[i], zi = is3d ? z[i] : 0, ri = rad[i];
    let fx = s.forceX[i], fy = s.forceY[i], fz = is3d ? s.forceZ[i] : 0, dens = 0;
    const interact = (j) => {
      if (j === i) return;
      let dx = x[j] - xi, dy = y[j] - yi, dz = is3d ? z[j] - zi : 0;
      if (torus) {
        if (dx > halfW) dx -= W2; else if (dx < -halfW) dx += W2;
        if (dy > halfH) dy -= H2; else if (dy < -halfH) dy += H2;
        if (is3d) { if (dz > halfD) dz -= D2; else if (dz < -halfD) dz += D2; }
      }
      const d2 = is3d ? dx * dx + dy * dy + dz * dz : dx * dx + dy * dy;
      if (doCharge && d2 !== 0 && d2 <= chargeMaxD2) {
        const c = chargeK * (1 / (1 + d2) - chargeMinC);
        fx += c * dx; fy += c * dy; if (is3d) fz += c * dz;
      }
      const sij = ri + rad[j], rmax = range * sij;
      if (d2 === 0 || d2 >= rmax * rmax) return;
      dens++;
      if (doForce) {
        const d = Math.sqrt(d2); const F = ((d < sij) ? muRep : muAdh) * (d - sij); const k = F / d;
        fx += k * dx; fy += k * dy; if (is3d) fz += k * dz;
      }
    };
    if (doScan && hash) {
      const nBinsX = hash.nBinsX, nBinsY = hash.nBinsY, nBinsZ = hash.nBinsZ, binStart = hash.binStart, binAgents = hash.binAgents;
      let bx = ((xi - hash.originX) / hash.binSizeX) | 0; if (bx < 0) bx = 0; else if (bx >= nBinsX) bx = nBinsX - 1;
      let by = ((yi - hash.originY) / hash.binSizeY) | 0; if (by < 0) by = 0; else if (by >= nBinsY) by = nBinsY - 1;
      let bz = is3d ? ((zi - hash.originZ) / hash.binSizeZ) | 0 : 0; if (bz < 0) bz = 0; else if (bz >= nBinsZ) bz = nBinsZ - 1;
      const zLo = is3d ? -1 : 0, zHi = is3d ? 1 : 0;
      for (let ddz = zLo; ddz <= zHi; ddz++) {
        for (let ddy = -1; ddy <= 1; ddy++) {
          for (let ddx = -1; ddx <= 1; ddx++) {
            let nbx = bx + ddx, nby = by + ddy, nbz = bz + ddz;
            if (torus) {
              nbx = ((nbx % nBinsX) + nBinsX) % nBinsX; nby = ((nby % nBinsY) + nBinsY) % nBinsY;
              if (is3d) nbz = ((nbz % nBinsZ) + nBinsZ) % nBinsZ;
            } else {
              if (nbx < 0 || nbx >= nBinsX || nby < 0 || nby >= nBinsY) continue;
              if (is3d && (nbz < 0 || nbz >= nBinsZ)) continue;
            }
            const b = is3d ? (nbz * nBinsY + nby) * nBinsX + nbx : nby * nBinsX + nbx;
            const end = binStart[b + 1];
            for (let p = binStart[b]; p < end; p++) interact(binAgents[p]);
          }
        }
      }
    } else if (doScan) {
      for (let j = 0; j < hw; j++) { if (alive[j]) interact(j); }
    }
    if (doScan) s.density[i] = dens;
    // C10 / P11a - the GLOBAL (Barnes-Hut) traversal, a verbatim mirror of the
    // worker's block (accumulate unscaled, multiply by k ONCE at the end).
    if (doChargeTree && tree) {
      const tSX = tree.sortedX, tSY = tree.sortedY, tSZ = tree.sortedZ;
      const nSt = tree.nodeStart, nEn = tree.nodeEnd, nNx = tree.nodeNext;
      const nCx = tree.nodeCx, nCy = tree.nodeCy, nCz = tree.nodeCz, nEx = tree.nodeExt;
      const nodeN = tree.nodeCount;
      let tfx = 0, tfy = 0, tfz = 0;
      for (let ni = 0; ni < nodeN;) {
        let ndx = nCx[ni] - xi, ndy = nCy[ni] - yi, ndz = is3d ? nCz[ni] - zi : 0;
        if (torus) {
          if (ndx > halfW) ndx -= W2; else if (ndx < -halfW) ndx += W2;
          if (ndy > halfH) ndy -= H2; else if (ndy < -halfH) ndy += H2;
          if (is3d) { if (ndz > halfD) ndz -= D2; else if (ndz < -halfD) ndz += D2; }
        }
        const l2 = is3d ? ndx * ndx + ndy * ndy + ndz * ndz : ndx * ndx + ndy * ndy;
        const w = nEx[ni];
        if (w * w < chargeTheta2 * l2) {
          const c = (nEn[ni] - nSt[ni]) / (1 + l2);
          tfx += c * ndx; tfy += c * ndy; if (is3d) tfz += c * ndz;
          ni = nNx[ni];
        } else {
          if (nNx[ni] === ni + 1) {
            const pEnd = nEn[ni];
            for (let pp = nSt[ni]; pp < pEnd; pp++) {
              let pdx = tSX[pp] - xi, pdy = tSY[pp] - yi, pdz = is3d ? tSZ[pp] - zi : 0;
              if (torus) {
                if (pdx > halfW) pdx -= W2; else if (pdx < -halfW) pdx += W2;
                if (pdy > halfH) pdy -= H2; else if (pdy < -halfH) pdy += H2;
                if (is3d) { if (pdz > halfD) pdz -= D2; else if (pdz < -halfD) pdz += D2; }
              }
              // THE ASSOCIATION ORDER IS LOAD-BEARING (f64 addition is not
              // associative): the worker evaluates `1 + a + b [+ c]` strictly
              // left-to-right, so the mirror must too — `1 + (a + b)` diverges.
              const pc = is3d
                ? 1 / (1 + pdx * pdx + pdy * pdy + pdz * pdz)
                : 1 / (1 + pdx * pdx + pdy * pdy);
              tfx += pc * pdx; tfy += pc * pdy; if (is3d) tfz += pc * pdz;
            }
          }
          ni++;
        }
      }
      fx += chargeK * tfx; fy += chargeK * tfy; if (is3d) fz += chargeK * tfz;
    }
    let vxi = momentum * vxArr[i] + dtOverEta * fx;
    let vyi = momentum * vyArr[i] + dtOverEta * fy;
    let vzi = is3d ? momentum * vzArr[i] + dtOverEta * fz : 0;
    if (maxSpeed > 0) {
      const sp = Math.sqrt(is3d ? vxi * vxi + vyi * vyi + vzi * vzi : vxi * vxi + vyi * vyi);
      if (sp > maxSpeed) { const sc = maxSpeed / sp; vxi *= sc; vyi *= sc; vzi *= sc; }
    }
    vxArr[i] = vxi; vyArr[i] = vyi; if (is3d) vzArr[i] = vzi;
    let nx = xi + vxi, ny = yi + vyi, nz = zi + vzi;
    if (torus) {
      nx = ((nx % W2) + W2) % W2; ny = ((ny % H2) + H2) % H2;
      if (is3d) nz = ((nz % D2) + D2) % D2;
    } else {
      nx = nx < 0 ? 0 : nx > W2 ? W2 : nx; ny = ny < 0 ? 0 : ny > H2 ? H2 : ny;
      if (is3d) nz = nz < 0 ? 0 : nz > D2 ? D2 : nz;
    }
    xN[i] = nx; yN[i] = ny; if (is3d) zN[i] = nz;
  }
}

/** C10 - copy the engine-built octree into the module's reserved regions (the
 *  AW-HASH copy, one structure over). Mirrors the worker exactly. */
function copyTreeIntoMemory(s, tree) {
  if (!tree || !s.layout || !s.layout.chargeTreeNodes) return;
  const buf = s.memory.buffer, L = s.layout;
  const nN = Math.min(tree.nodeCount, L.chargeTreeNodes);
  const nP = Math.min(tree.pointCount, s.maxAgents);
  new Float64Array(buf, L.treeSortedXOffset, nP).set(tree.sortedX.subarray(0, nP));
  new Float64Array(buf, L.treeSortedYOffset, nP).set(tree.sortedY.subarray(0, nP));
  new Float64Array(buf, L.treeSortedZOffset, nP).set(tree.sortedZ.subarray(0, nP));
  new Float64Array(buf, L.treeNodeCxOffset, nN).set(tree.nodeCx.subarray(0, nN));
  new Float64Array(buf, L.treeNodeCyOffset, nN).set(tree.nodeCy.subarray(0, nN));
  new Float64Array(buf, L.treeNodeCzOffset, nN).set(tree.nodeCz.subarray(0, nN));
  new Float64Array(buf, L.treeNodeExtOffset, nN).set(tree.nodeExt.subarray(0, nN));
  new Int32Array(buf, L.treeNodeStartOffset, nN).set(tree.nodeStart.subarray(0, nN));
  new Int32Array(buf, L.treeNodeEndOffset, nN).set(tree.nodeEnd.subarray(0, nN));
  new Int32Array(buf, L.treeNodeNextOffset, nN).set(tree.nodeNext.subarray(0, nN));
}

function copyHashIntoMemory(s, hash) {
  if (!hash) return; // null hash => all-pairs fallback (hashValid=0 passed to WASM)
  const buf = s.memory.buffer, L = s.layout;
  const nBins = hash.nBinsX * hash.nBinsY * hash.nBinsZ;
  new Int32Array(buf, L.hashBinStartOffset, nBins + 1).set(hash.binStart.subarray(0, nBins + 1));
  const used = hash.binStart[nBins];
  if (used > 0) new Int32Array(buf, L.hashBinAgentsOffset, used).set(hash.binAgents.subarray(0, used));
}

// minimal agent graph so the WASM module exports behaviour + forcePass
const nb = (id, nodeType, config = {}) => ({ id, type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType, config } });
const fe = (s, sh, t, th) => ({ id: s + '->' + t, source: s, sourceHandle: sh, target: t, targetHandle: th });
const agentGraphNodes = [nb('beh', 'behaviourStep'), nb('af', 'applyForce', { _port_fx: '0.0', _port_fy: '0.0' })];
const agentGraphEdges = [fe('beh', 'output_flow_do', 'af', 'input_flow_do')];

function minPairDist(s) {
  const is3d = s.worldDepth > 1, D = s.worldDepth;
  let m = Infinity;
  for (let i = 0; i < s.highWater; i++) for (let j = i + 1; j < s.highWater; j++) {
    let dx = s.x[i] - s.x[j], dy = s.y[i] - s.y[j], dz = is3d ? s.z[i] - s.z[j] : 0;
    if (dx > W / 2) dx -= W; else if (dx < -W / 2) dx += W;
    if (dy > H / 2) dy -= H; else if (dy < -H / 2) dy += H;
    if (is3d) { if (dz > D / 2) dz -= D; else if (dz < -D / 2) dz += D; }
    const d = Math.hypot(dx, dy, dz); if (d < m) m = d;
  }
  return m;
}

let fail = 0, checks = 0;
const torus = true;

async function runCombo(name, bonding, doCollision, doDensity = true, opts = {}) {
  const { charge = OFF_CHARGE, is3d = false, torus: tor = torus } = opts;
  const D = is3d ? 20 : 1;
  // Charge widens the hash bin edge — THE trap. The harness mirrors the engine's
  // `chargeBinEdgeOf` join so both targets scan the same stencil.
  const cfg = { ...baseCfg, worldDepth: D };
  const attrSpecs = [];
  const maxHashBins = computeAgentMaxHashBins(W, H, D, cfg.interactionRange, cfg.defaultRadius, cfg.neighbourQueryRadius);
  // C10 - the tree regions exist only for a GLOBAL-charge model, and the RESERVE
  // must be the SAME number the compiler bakes (`buildAgentLayoutExtras` derives it
  // from `agentOctreeNodeReserve`) or the offsets desync.
  const treeNodes = charge.doChargeTree ? agentOctreeNodeReserve(cfg.maxAgents) : 0;
  const sJS = createAgentStore(cfg, attrSpecs); sJS.worldDepth = D; sJS.dt = cfg.timeStep;
  const sW = createAgentStore(cfg, attrSpecs, { wasmBacked: true, maxHashBins, layoutExtras: { chargeTreeNodes: treeNodes } }); sW.worldDepth = D; sW.dt = cfg.timeStep;

  // seed 60 agents heavily overlapping in a tight blob (many within one contact dist)
  let seed = 987654321; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const N = 60; const specs = [];
  for (let i = 0; i < N; i++) specs.push({ x: W / 2 + (rnd() - 0.5) * 3, y: H / 2 + (rnd() - 0.5) * 3, z: is3d ? D / 2 + (rnd() - 0.5) * 3 : 0, radius: 0.5 });
  seedAgents(sJS, specs, 0.5); seedAgents(sW, specs, 0.5);

  const r = compileAgentGraphWasm(agentGraphNodes, agentGraphEdges, {
    properties: { gridWidth: W, gridHeight: H, dimension: is3d ? '3d' : '2d', gridDepth: D, boundaryTreatment: tor ? 'torus' : 'constant' },
    topologyMode: { gridCells: true, agents: true },
    // The capability profile is what makes the compiler EMIT the charge params —
    // the same `usesCharge` gate the engine reads, so the module and the arg list
    // can only agree if the feature is actually wired end to end.
    centerBased: {
      ...cfg,
      agentCapabilities: (charge.doCharge || charge.doChargeTree) ? { motion: 'force', charge: 'on' } : undefined,
      // C10 - `chargeRange: 'global'` is what makes `buildAgentLayoutExtras` reserve
      // the tree regions AND `emitForcePass` emit the traversal instead of the pair
      // term, so the module and this harness's JS mirror can only agree if the whole
      // feature is wired end to end.
      ...(charge.doChargeTree ? { chargeRange: 'global', chargeTheta: Math.sqrt(charge.chargeTheta2) } : {}),
    },
    agentGraphNodes, agentGraphEdges, agentVariables: [],
    graphNodes: [], graphEdges: [], macroDefs: [], variables: [], attributes: [], neighborhoods: [],
  }, sW.layout);
  if (r.error) { console.log(`  ✗ ${name}: WASM compile error: ${r.error}`); fail++; return null; }
  const inst = await instantiateAgentWasm(r.bytes, sW.memory);
  const fpFn = inst.forcePass;

  // C10: only the CUTOFF law widens the edge (`chargeBinEdgeOf` returns 0 under
  // global — the tree carries the charge, so the stencil need not reach).
  const binEdge = Math.max(
    cfg.interactionRange * 2 * cfg.defaultRadius, cfg.neighbourQueryRadius,
    charge.doCharge ? Math.sqrt(charge.chargeMaxD2) : 0,
  );
  const dims = { W, H, D };
  const dtOverEta = cfg.timeStep / cfg.drag;
  const STEPS = 25;
  let mism = 0;
  for (let step = 0; step < STEPS; step++) {
    // THE RESERVE MUST BE PASSED (the probe harness already does): in a BOUNDED
    // world the bbox-anchored hash uses `floor(ext/edge)+1` bins per axis, which
    // can EXCEED the torus-derived `computeAgentMaxHashBins` reserve the module
    // was laid out with — and `copyHashIntoMemory` would then write past
    // `binStart` into the next region. The engine is safe (the worker's
    // `fits`-check falls back to JS); this harness had no such guard, so it must
    // build a hash that fits instead. Passing it also keeps BOTH sides on one hash.
    const hashJS = buildSpatialHash(sJS, Math.max(1e-3, binEdge), W, H, D, tor, maxHashBins);
    const treeJS = charge.doChargeTree ? buildAgentOctree(sJS, is3d, treeNodes) : null;
    sJS.forceX.fill(0, 0, sJS.highWater); sJS.forceY.fill(0, 0, sJS.highWater); sJS.forceZ.fill(0, 0, sJS.highWater);
    jsForceLoop(sJS, hashJS, cfg, dtOverEta, bonding, doCollision, tor, doDensity, charge, is3d, treeJS);
    { const t = sJS.x; sJS.x = sJS.xNext; sJS.xNext = t; const t2 = sJS.y; sJS.y = sJS.yNext; sJS.yNext = t2; if (is3d) { const t3 = sJS.z; sJS.z = sJS.zNext; sJS.zNext = t3; } }

    const hashW = buildSpatialHash(sW, Math.max(1e-3, binEdge), W, H, D, tor, maxHashBins);
    const treeW = charge.doChargeTree ? buildAgentOctree(sW, is3d, treeNodes) : null;
    sW.forceX.fill(0, 0, sW.highWater); sW.forceY.fill(0, 0, sW.highWater); sW.forceZ.fill(0, 0, sW.highWater);
    copyHashIntoMemory(sW, hashW);
    copyTreeIntoMemory(sW, treeW);
    fpFn(...forceArgs(sW, hashW, cfg, dtOverEta, bonding, doCollision, tor, doDensity, charge, dims, treeW));
    sW.x.set(sW.xNext); sW.y.set(sW.yNext); if (is3d) sW.z.set(sW.zNext);

    for (let i = 0; i < sJS.highWater; i++) {
      if (sJS.x[i] !== sW.x[i] || sJS.y[i] !== sW.y[i] || sJS.vx[i] !== sW.vx[i] || sJS.vy[i] !== sW.vy[i] || sJS.density[i] !== sW.density[i]) mism++;
      if (is3d && (sJS.z[i] !== sW.z[i] || sJS.vz[i] !== sW.vz[i])) mism++;
    }
  }
  checks++;
  if (mism > 0) { console.log(`  ✗ ${name}: ${mism} JS↔WASM mismatches over ${STEPS} steps`); fail++; }
  else console.log(`  ✓ ${name}: JS↔WASM bit-parity (0 mismatches, ${STEPS} steps) | final minPairDist ${minPairDist(sJS).toFixed(3)}`);
  return sJS;
}

console.log('Force-pass parity (JS force loop ↔ WASM forcePass):');
const sCollisionOnly = await runCombo('collision-only (doCollision=1, bonding=0)', false, true);
const sBondingOnly = await runCombo('bonding-only  (doCollision=0, bonding=1)', true, false);
await runCombo('both          (doCollision=1, bonding=1)', true, true);
const sNeither = await runCombo('neither       (doCollision=0, bonding=0)', false, false);
// P1 (the dead density scan): with forces off AND no density consumer the scan
// is skipped ENTIRELY on both targets — parity must hold on the skip path too
// (velocities integrate from the graph force only; density stays untouched).
await runCombo('density-skip  (doCollision=0, bonding=0, doDensity=0)', false, false, false);
await runCombo('density-only  (doCollision=0, bonding=0, doDensity=1)', false, false, true);

// ---------------------------------------------------------------------------
// L1 — the CHARGE combos. Charge is a second, much wider pair term evaluated
// BEFORE the soft-sphere cutoff, so it has to hold bit-parity independently of
// every other gate: with and without collision, in 2D and 3D, torus and bounded.
// A cutoff of 6 sits well inside the 40×40 world so the torus fold is exercised
// without the stencil covering the whole world.
// ---------------------------------------------------------------------------
console.log('\nL1 charge combos (charge on/off × 2D/3D × torus/bounded × collision on/off):');
const CH = mkCharge(-3, 6);
await runCombo('charge 2D torus,   collision=0', false, false, true, { charge: CH });
await runCombo('charge 2D torus,   collision=1', false, true, true, { charge: CH });
await runCombo('charge 2D bounded, collision=0', false, false, true, { charge: CH, torus: false });
await runCombo('charge 2D bounded, collision=1', false, true, true, { charge: CH, torus: false });
await runCombo('charge 2D torus,   bonding=1 (adhesion + charge)', true, true, true, { charge: CH });
await runCombo('charge 3D torus,   collision=0', false, false, true, { charge: CH, is3d: true });
await runCombo('charge 3D torus,   collision=1', false, true, true, { charge: CH, is3d: true });
await runCombo('charge 3D bounded, collision=1', false, true, true, { charge: CH, is3d: true, torus: false });
// Charge is the ONLY active term: no collision, no bonding, no density consumer.
// Without charge joining the scan gate this would skip the neighbour pass and the
// force would silently vanish, so it is a real gate check, not a duplicate.
await runCombo('charge-only   (collision=0, bonding=0, doDensity=0)', false, false, false, { charge: CH });
await runCombo('charge 3D bounded, charge-only', false, false, false, { charge: CH, is3d: true, torus: false });
// Sanity: charge OFF must still be identical to the pre-L1 behaviour (covered by
// the four original combos above, but assert the 3D arm too — it is a separate
// verbatim code path in BOTH the engine and this harness).
await runCombo('no-charge 3D torus, collision=1', false, true, true, { is3d: true });

// ---------------------------------------------------------------------------
// C10 / P11a — the GLOBAL (Barnes-Hut) charge combos. This is a DIFFERENT LAW,
// not a faster cutoff: no `maxDist` test at all, `min_c = 0`, and the sum comes
// from an octree traversal instead of the stencil. The whole determinism claim
// rests on JS and WASM walking the SAME tree in the SAME order, so it has to hold
// bit-exactly across dimensions, boundaries, theta values and every other gate.
// ---------------------------------------------------------------------------
console.log('\nC10 global (Barnes-Hut) charge combos (2D/3D x torus/bounded x theta x collision on/off):');
const GB = mkGlobalCharge(-3, 0.9);
await runCombo('global 2D torus,   collision=0', false, false, true, { charge: GB });
await runCombo('global 2D torus,   collision=1', false, true, true, { charge: GB });
await runCombo('global 2D bounded, collision=0', false, false, true, { charge: GB, torus: false });
await runCombo('global 2D bounded, collision=1', false, true, true, { charge: GB, torus: false });
await runCombo('global 2D torus,   bonding=1 (adhesion + global charge)', true, true, true, { charge: GB });
await runCombo('global 3D torus,   collision=0', false, false, true, { charge: GB, is3d: true });
await runCombo('global 3D torus,   collision=1', false, true, true, { charge: GB, is3d: true });
await runCombo('global 3D bounded, collision=1', false, true, true, { charge: GB, is3d: true, torus: false });
// theta sweep — a SMALLER theta opens more nodes (more exact, deeper traversal), a
// LARGER one collapses more; both must stay bit-identical across the two targets.
await runCombo('global 2D torus,   theta 0.3 (near-exact)', false, true, true, { charge: mkGlobalCharge(-3, 0.3) });
await runCombo('global 2D torus,   theta 1.4 (coarse)', false, true, true, { charge: mkGlobalCharge(-3, 1.4) });
await runCombo('global 3D bounded, theta 0.3 (near-exact)', false, true, true, { charge: mkGlobalCharge(-3, 0.3), is3d: true, torus: false });
// Global charge is the ONLY active term: no collision, no bonding, no density.
// Under global the charge does NOT join the scan gate (the tree carries it), so
// this exercises the path where the neighbour pass is skipped entirely.
await runCombo('global-only   (collision=0, bonding=0, doDensity=0)', false, false, false, { charge: GB });
await runCombo('global-only 3D bounded', false, false, false, { charge: mkGlobalCharge(-3, 0.9), is3d: true, torus: false });

// ---------------------------------------------------------------------------
// C10 — THE VALUE INVARIANT. Parity is a MIRROR test: it passes happily if BOTH
// targets are equally wrong (a traversal that never runs sums zero on both). So
// assert what the tree is FOR — that it approximates the exact all-pairs global
// sum, and that theta actually controls how well. A brute-force O(N^2) reference
// over the same positions is the oracle; the tree must land within a theta-scaled
// tolerance of it, and a SMALLER theta must be STRICTLY more accurate.
// ---------------------------------------------------------------------------
console.log('\nC10 value invariant (tree vs exact all-pairs global sum):');
{
  const cfgV = { ...baseCfg, worldDepth: 1 };
  const sV = createAgentStore(cfgV, []); sV.worldDepth = 1; sV.dt = cfgV.timeStep;
  let sd = 24680; const rr = () => { sd = (sd * 1103515245 + 12345) & 0x7fffffff; return sd / 0x7fffffff; };
  const spec = [];
  for (let i = 0; i < 240; i++) spec.push({ x: rr() * W, y: rr() * H, z: 0, radius: 0.5 });
  seedAgents(sV, spec, 0.5);
  const hw = sV.highWater;
  // EXACT: every pair, no cutoff, min_c = 0 — the law global charge claims to run.
  const exact = [];
  for (let i = 0; i < hw; i++) {
    let ex = 0, ey = 0;
    for (let j = 0; j < hw; j++) {
      if (j === i) continue;
      const dx = sV.x[j] - sV.x[i], dy = sV.y[j] - sV.y[i];
      const c = 1 / (1 + dx * dx + dy * dy);
      ex += c * dx; ey += c * dy;
    }
    exact.push([ex, ey]);
  }
  const treeErr = (theta) => {
    const t = buildAgentOctree(sV, false, agentOctreeNodeReserve(cfgV.maxAgents));
    const th2 = theta * theta;
    let num = 0, den = 0, maxAbs = 0;
    for (let i = 0; i < hw; i++) {
      const xi = sV.x[i], yi = sV.y[i];
      let tfx = 0, tfy = 0;
      for (let ni = 0; ni < t.nodeCount;) {
        const ndx = t.nodeCx[ni] - xi, ndy = t.nodeCy[ni] - yi;
        const l2 = ndx * ndx + ndy * ndy, w = t.nodeExt[ni];
        if (w * w < th2 * l2) {
          const c = (t.nodeEnd[ni] - t.nodeStart[ni]) / (1 + l2);
          tfx += c * ndx; tfy += c * ndy; ni = t.nodeNext[ni];
        } else {
          if (t.nodeNext[ni] === ni + 1) {
            for (let p = t.nodeStart[ni]; p < t.nodeEnd[ni]; p++) {
              const pdx = t.sortedX[p] - xi, pdy = t.sortedY[p] - yi;
              const pc = 1 / (1 + pdx * pdx + pdy * pdy);
              tfx += pc * pdx; tfy += pc * pdy;
            }
          }
          ni++;
        }
      }
      const [ex, ey] = exact[i];
      num += Math.hypot(tfx - ex, tfy - ey); den += Math.hypot(ex, ey);
      maxAbs = Math.max(maxAbs, Math.hypot(tfx, tfy));
    }
    return { rel: num / Math.max(1e-12, den), maxAbs };
  };
  const eFine = treeErr(0.2), eCoarse = treeErr(1.4);
  checks++;
  // (a) the force is REAL (a no-op traversal would give maxAbs 0);
  // (b) a near-exact theta tracks the brute-force sum closely;
  // (c) theta genuinely controls accuracy (fine strictly better than coarse).
  if (eFine.maxAbs > 1e-6 && eFine.rel < 0.02 && eCoarse.rel > eFine.rel) {
    console.log(`  ✓ tree ≈ exact all-pairs: rel err ${(eFine.rel * 100).toFixed(3)}% at θ=0.2 vs ${(eCoarse.rel * 100).toFixed(2)}% at θ=1.4 (θ controls accuracy; |f|max ${eFine.maxAbs.toExponential(2)})`);
  } else {
    console.log(`  ✗ tree vs exact: θ=0.2 rel ${eFine.rel}, θ=1.4 rel ${eCoarse.rel}, |f|max ${eFine.maxAbs} — want a real, theta-controlled approximation`);
    fail++;
  }
}

// BEHAVIOUR: collision-only must SEPARATE the blob; neither must NOT.
console.log('\nBehaviour (the user-reported pass-through):');
const dCol = sCollisionOnly ? minPairDist(sCollisionOnly) : 0;
const dNone = sNeither ? minPairDist(sNeither) : 0;
checks++;
// collision-on pushes overlapping agents apart (minPairDist grows toward the
// contact distance ~1.0); no-force leaves the blob overlapping. A robust ratio
// check (collision separation >= 4× the no-force minimum) captures the fix.
if (dCol > 0.4 && dNone < 0.2 && dCol > dNone * 4) console.log(`  ✓ collision separates the blob (minPairDist ${dCol.toFixed(3)}) while no-force leaves overlaps (${dNone.toFixed(3)}) — ${(dCol / Math.max(dNone, 1e-6)).toFixed(1)}× apart`);
else { console.log(`  ✗ expected collision >> no-force separation (collision ${dCol.toFixed(3)}, no-force ${dNone.toFixed(3)})`); fail++; }

// ---------------------------------------------------------------------------
// L1 — the two structural properties the parity loops above cannot see.
// ---------------------------------------------------------------------------
console.log('\nL1 structural:');

// (1) THE CONDITIONAL-ARITY CONTRACT. A charge-OFF module declares 26 params (so
//     its bytes are unchanged), but the worker ALWAYS passes 30. That is only safe
//     because the WebAssembly JS API drops arguments past a function's arity. The
//     whole design rests on it, so ASSERT it rather than trusting the spec.
{
  const cfg = { ...baseCfg, worldDepth: 1 };
  const maxHashBins = computeAgentMaxHashBins(W, H, 1, cfg.interactionRange, cfg.defaultRadius, cfg.neighbourQueryRadius);
  const model = (caps) => ({
    properties: { gridWidth: W, gridHeight: H, dimension: '2d', gridDepth: 1, boundaryTreatment: 'torus' },
    topologyMode: { gridCells: true, agents: true },
    centerBased: { ...cfg, agentCapabilities: caps }, agentGraphNodes, agentGraphEdges, agentVariables: [],
    graphNodes: [], graphEdges: [], macroDefs: [], variables: [], attributes: [], neighborhoods: [],
  });
  const sOff = createAgentStore(cfg, [], { wasmBacked: true, maxHashBins }); sOff.worldDepth = 1; sOff.dt = cfg.timeStep;
  const sOn = createAgentStore(cfg, [], { wasmBacked: true, maxHashBins }); sOn.worldDepth = 1; sOn.dt = cfg.timeStep;
  const sGl = createAgentStore(cfg, [], { wasmBacked: true, maxHashBins, layoutExtras: { chargeTreeNodes: agentOctreeNodeReserve(cfg.maxAgents) } }); sGl.worldDepth = 1; sGl.dt = cfg.timeStep;
  const rOff = compileAgentGraphWasm(agentGraphNodes, agentGraphEdges, model(undefined), sOff.layout);
  const rOn = compileAgentGraphWasm(agentGraphNodes, agentGraphEdges, model({ motion: 'force', charge: 'on' }), sOn.layout);
  // C10 — the GLOBAL module declares a THIRD arity (32). `model()` only sets the
  // capability, so the range rides on the config object below.
  const globalModel = model({ motion: 'force', charge: 'on' });
  globalModel.centerBased = { ...globalModel.centerBased, chargeRange: 'global', chargeTheta: 0.9 };
  const rGl = compileAgentGraphWasm(agentGraphNodes, agentGraphEdges, globalModel, sGl.layout);
  checks++;
  if (rOff.error || rOn.error || rGl.error) { console.log(`  ✗ conditional arity: compile error`); fail++; }
  else {
    const instOff = await instantiateAgentWasm(rOff.bytes, sOff.memory);
    const instOn = await instantiateAgentWasm(rOn.bytes, sOn.memory);
    const instGl = await instantiateAgentWasm(rGl.bytes, sGl.memory);
    const nOff = instOff.forcePass.length, nOn = instOn.forcePass.length, nGl = instGl.forcePass.length;
    // Seed one agent so a call actually executes the loop body.
    seedAgents(sOff, [{ x: W / 2, y: H / 2, radius: 0.5 }], 0.5);
    let threw = null;
    try { instOff.forcePass(...forceArgs(sOff, null, cfg, cfg.timeStep, false, true, true, true, mkCharge(-3, 6))); }
    catch (e) { threw = e; }
    const ok = nOff === 26 && nOn === 30 && nGl === 32 && threw === null;
    if (ok) console.log(`  ✓ conditional arity: charge-off module declares ${nOff} params, cutoff ${nOn}, GLOBAL ${nGl}; passing all 32 to the 26-param export is accepted (extras ignored)`);
    else { console.log(`  ✗ conditional arity: off=${nOff} (want 26), cutoff=${nOn} (want 30), global=${nGl} (want 32), extra-arg call ${threw ? 'THREW: ' + threw.message : 'ok'}`); fail++; }
  }
}

// (2) THE BIN-EDGE TRAP. Two UNBONDED agents at 0.9 × the charge cutoff must feel a
//     non-zero charge force. If the bin edge were not widened to cover the cutoff,
//     the 3×3 stencil would put them in non-adjacent bins, the pair would never be
//     visited, and the force would read ZERO — with every other check still green.
//     NEGATIVE CONTROL: the same geometry with a deliberately un-widened edge, which
//     must FAIL to see the pair. That is what proves this test can actually fail.
{
  const CUTOFF = 12, cfg = { ...baseCfg, worldDepth: 1 };
  const ch = mkCharge(-3, CUTOFF);
  const sep = 0.9 * CUTOFF;   // 10.8 — far outside contact (1.0) and outside the un-widened edge (5)
  const measure = (binEdge) => {
    const s = createAgentStore(cfg, []); s.worldDepth = 1; s.dt = cfg.timeStep;
    seedAgents(s, [{ x: W / 2 - sep / 2, y: H / 2, radius: 0.5 }, { x: W / 2 + sep / 2, y: H / 2, radius: 0.5 }], 0.5);
    const hash = buildSpatialHash(s, Math.max(1e-3, binEdge), W, H, 1, true);
    s.forceX.fill(0, 0, s.highWater); s.forceY.fill(0, 0, s.highWater);
    jsForceLoop(s, hash, cfg, cfg.timeStep / cfg.drag, false, false, true, false, ch, false);
    return { fx: Math.abs(s.vx[0]), bins: hash ? `${hash.nBinsX}×${hash.nBinsY}` : 'all-pairs' };
  };
  // The engine's real join: max(collision edge, charge cutoff).
  const widened = measure(Math.max(cfg.interactionRange * 2 * cfg.defaultRadius, cfg.neighbourQueryRadius, CUTOFF));
  // The negative control: the PRE-L1 edge, which does not know about charge.
  const narrow = measure(Math.max(cfg.interactionRange * 2 * cfg.defaultRadius, cfg.neighbourQueryRadius));
  checks++;
  if (widened.fx > 1e-9 && narrow.fx === 0) {
    console.log(`  ✓ bin-edge trap: at 0.9× cutoff the widened edge feels the charge (|v|=${widened.fx.toExponential(2)}, ${widened.bins} bins) while the un-widened edge sees NOTHING (${narrow.fx}, ${narrow.bins}) — the negative control fails as it must`);
  } else {
    console.log(`  ✗ bin-edge trap: widened |v|=${widened.fx} (want >0), un-widened |v|=${narrow.fx} (want exactly 0 — if non-zero this test cannot detect the bug)`);
    fail++;
  }
}

console.log(`\n${fail === 0 ? 'FORCE-PASS PARITY ✓' : `${fail} FAILED ✗`}  (${checks} checks)`);
rmSync(entryPath, { force: true }); rmSync(dir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);

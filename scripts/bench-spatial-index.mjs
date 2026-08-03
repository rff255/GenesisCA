// SPATIAL INDEX BENCHMARK — C11 / proposal P11 item 2 ("adaptive spatial index").
//
// THE QUESTION: does an EXACT tree-accelerated fixed-radius range query beat the
// shipped uniform spatial hash in the regimes GenesisCA models actually occupy?
//
// Three contenders, all returning the IDENTICAL neighbour set (asserted, sorted):
//
//   hash-shared  the SHIPPED path — ONE `buildSpatialHash` at the engine's real
//                bin edge `max(interactionRange*2*maxR, neighbourQueryRadius,
//                chargeBinEdgeOf)` (sim.worker.ts runAgentStep), queried with the
//                3x3(x3) stencil emitted by GetNearbyAgentsNode. When the hash
//                returns null (tiny world / <3 bins per axis) this degrades to
//                the engine's ALL-PAIRS fallback, exactly like the shipped emit.
//   hash-tuned   the CHEAP alternative the tree must beat to be worth building —
//                a SECOND hash whose bin edge is the QUERY's own radius. Same
//                code, same tight contiguous inner loop, no traversal.
//   tree         `buildAgentOctree` (C10's deterministic Morton octree — already
//                order-canonical and 3D-native) + an exact bbox-pruned range
//                query with the standard fully-inside shortcut.
//
// Everything is measured per GENERATION: index BUILD once + one query per agent.
// Torus is handled in the tree by minimum-image query-point replication (exact
// for r <= min(W,H,D)/2, which is also the engine's own minimum-image domain).
//
//   node scripts/bench-spatial-index.mjs              # full sweep
//   node scripts/bench-spatial-index.mjs --quick      # fewer reps (smoke)
//   node scripts/bench-spatial-index.mjs --stats      # shipped-model stats only
import { build } from 'esbuild';
import { writeFileSync, rmSync, mkdtempSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const QUICK = process.argv.includes('--quick');
const STATS_ONLY = process.argv.includes('--stats');

const ENTRY = `
export { createAgentStore, seedAgents, buildSpatialHash, buildAgentOctree,
         computeAgentMaxHashBins, agentOctreeNodeReserve } from '../src/simulator/engine/agentEngine.ts';
export { chargeBinEdgeOf, resolveMaxBonds } from '../src/model/centerBased.ts';
export { migrateForHarness } from '../src/dev/compileHarness.ts';
`;
const dir = mkdtempSync(join(tmpdir(), 'gca-benchspatial-'));
const entryPath = join(ROOT, 'scripts', '__benchspatial_entry.ts');
writeFileSync(entryPath, ENTRY);
const outPath = join(dir, 'bundle.mjs');
await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: process.cwd() });
const M = await import(pathToFileURL(outPath).href);
const { createAgentStore, seedAgents, buildSpatialHash, buildAgentOctree,
        computeAgentMaxHashBins, agentOctreeNodeReserve, chargeBinEdgeOf, migrateForHarness } = M;

const cbNum = (cfg, k, d) => { const v = cfg?.[k]; return typeof v === 'number' && Number.isFinite(v) ? v : d; };
const fmt = (v, p = 2) => (v >= 1000 ? v.toFixed(0) : v >= 100 ? v.toFixed(1) : v.toFixed(p));

// ===========================================================================
// PART 1 — the shipped samples' REAL radius / density stats.
// This is the table the decision rule is read against: a fixture class only
// counts as "occupied" if a shipped model sits in it.
// ===========================================================================

/** The engine's own bin edge (sim.worker.ts runAgentStep, verbatim). */
function engineBinEdge(cfg, maxR) {
  const range = cbNum(cfg, 'interactionRange', 1.5);
  const collision = Math.max(range * 2 * maxR, cbNum(cfg, 'neighbourQueryRadius', 5));
  return Math.max(collision, chargeBinEdgeOf(cfg));
}

/** Every agent-query radius the graph asks for, resolved through the model's
 *  inline value or (when wired) the model attribute the sample wires in. */
function graphQueryRadii(model) {
  const out = [];
  const modelAttrByName = new Map();
  for (const a of model.attributes ?? []) if (a.isModelAttribute) modelAttrByName.set(a.name, parseFloat(String(a.defaultValue ?? '0')));
  const scan = (nodes) => {
    for (const n of nodes ?? []) {
      const t = n.data?.nodeType;
      if (t !== 'getNearbyAgents' && t !== 'getAgentsInView' && t !== 'senseHemifield') continue;
      const inline = n.data?.config?._port_radius;
      let r = inline != null && inline !== '' ? parseFloat(String(inline)) : NaN;
      out.push({ node: t, radius: Number.isFinite(r) ? r : null });
    }
  };
  scan(model.agentGraphNodes);
  for (const d of model.macroDefs ?? []) scan(d.nodes);
  // A wired radius resolves at runtime; the shipped samples all wire a model
  // attribute whose name says so, so surface the candidates rather than guess.
  const wiredCandidates = [...modelAttrByName.entries()].filter(([k]) => /radius/i.test(k));
  return { queries: out, wiredCandidates };
}

function shippedStats() {
  const rows = [];
  const dirp = join(ROOT, 'public', 'models');
  for (const f of readdirSync(dirp).filter(f => f.endsWith('.gcaproj'))) {
    const raw = JSON.parse(readFileSync(join(dirp, f), 'utf8'));
    const model = migrateForHarness(raw);
    if (!(model.topologyMode?.agents)) continue;
    const p = model.properties, cfg = model.centerBased ?? {};
    const is3d = p.dimension === '3d' && (p.gridDepth ?? 1) > 1;
    const W = p.gridWidth, H = p.gridHeight, D = is3d ? (p.gridDepth ?? 1) : 1;
    const torus = p.boundaryTreatment === 'torus';
    const r0 = cbNum(cfg, 'defaultRadius', 0.5);
    const edge = engineBinEdge(cfg, r0);
    const reserve = computeAgentMaxHashBins(W, H, D, cbNum(cfg, 'interactionRange', 1.5), r0, cbNum(cfg, 'neighbourQueryRadius', 5));
    // Population: the model attribute that names it, else the cap (an upper bound).
    let N = null;
    for (const a of model.attributes ?? []) if (a.isModelAttribute && /^N\b|particles|agents|ants/i.test(a.name)) { const v = parseFloat(String(a.defaultValue ?? '')); if (Number.isFinite(v) && v > 1) N = v; }
    const cap = cbNum(cfg, 'maxAgents', 0);
    const nUsed = N ?? cap;
    const vol = is3d ? W * H * D : W * H;
    const spacing = is3d ? Math.cbrt(vol / Math.max(1, nUsed)) : Math.sqrt(vol / Math.max(1, nUsed));
    const { queries, wiredCandidates } = graphQueryRadii(model);
    // Would the shipped hash even build? (the <3-bins-per-axis all-pairs bail)
    const nx = torus ? Math.floor(W / edge) : null, ny = torus ? Math.floor(H / edge) : null, nz = is3d ? (torus ? Math.floor(D / edge) : null) : 1;
    const bails = torus && (nx < 3 || ny < 3 || (is3d && nz < 3));
    rows.push({
      model: f.replace(/\.gcaproj$/, ''), dims: is3d ? `${W}x${H}x${D}` : `${W}x${H}`, torus, N: nUsed, NisCap: N == null,
      binEdge: edge, spacing, queries, wiredCandidates, reserve, bails,
      torusBins: torus ? `${nx}x${ny}${is3d ? 'x' + nz : ''}` : 'bbox',
    });
  }
  return rows;
}

function printStats(rows) {
  console.log('\n=== SHIPPED AGENT MODELS — real radius / density stats ===');
  console.log('    (binEdge = the engine\'s ONE hash bin edge: max(range*2*maxR, neighbourQueryRadius, chargeCutoff))');
  console.log(`${'model'.padEnd(36)} ${'world'.padStart(12)} ${'bnd'.padStart(6)} ${'N'.padStart(6)} ${'binEdge'.padStart(8)} ${'spacing'.padStart(8)} ${'query r'.padStart(9)} ${'r/space'.padStart(8)} ${'edge/r'.padStart(7)}  hash`);
  for (const r of rows) {
    const qs = r.queries.length ? r.queries : [{ node: '(engine only)', radius: null }];
    for (let i = 0; i < qs.length; i++) {
      const q = qs[i];
      const rad = q.radius;
      // A wired radius resolves at runtime; the samples that wire one all wire a
      // *-radius model attribute. Only substitute it for a REAL agent-query node —
      // a model with no agent query at all (its "radius" attribute drives a FIELD
      // read) must show "—", not a number it never uses for an agent query.
      const wired = rad == null && q.node !== '(engine only)' ? (r.wiredCandidates[0]?.[1] ?? null) : null;
      const eff = rad ?? wired;
      console.log(
        `${(i === 0 ? r.model : '').padEnd(36)} ${(i === 0 ? r.dims : '').padStart(12)} ${(i === 0 ? (r.torus ? 'torus' : 'bnd') : '').padStart(6)} ` +
        `${(i === 0 ? String(r.N) + (r.NisCap ? '*' : '') : '').padStart(6)} ${(i === 0 ? fmt(r.binEdge) : '').padStart(8)} ${(i === 0 ? fmt(r.spacing) : '').padStart(8)} ` +
        `${(eff == null ? '—' : fmt(eff) + (rad == null ? 'w' : '')).padStart(9)} ${(eff == null ? '—' : fmt(eff / r.spacing)).padStart(8)} ` +
        `${(eff == null ? '—' : fmt(r.binEdge / eff)).padStart(7)}  ${i === 0 ? (r.bails ? `ALL-PAIRS (bins ${r.torusBins})` : `${r.torusBins} bins`) : ''}`);
    }
  }
  console.log('    N* = the maxAgents CAP (the model has no N attribute); "w" = radius wired from a model attribute.');
  console.log('    edge/r = the SHARED hash\'s over-scan factor for that query: candidates ~ (3*edge)^d vs the r-ball.');
}

// ===========================================================================
// PART 2 — the three contenders.
// ===========================================================================

// WORK COUNTERS — an implementation-INDEPENDENT cross-check on the wall clock.
// `cand` counts the candidates a contender actually examines (bin entries for a
// hash, points for the tree) and `nodes` the tree nodes visited. Ratios of these
// are immune to this prototype's constant factors (the shipped hash query is
// INLINED generated code inside the agent loop, while everything here is a
// standalone function pushing into a JS array), so where the wall clock and the
// candidate count disagree, say so rather than quoting the flattering one.
const WORK = { cand: 0, nodes: 0, on: false };

/** The SHIPPED hash stencil query, transcribed from GetNearbyAgentsNode's emit
 *  (2D + 3D arms, torus fold, `<= r2`, self + dead excluded). */
function hashQuery(s, hash, i, r, W, H, D, torus, is3d, out) {
  out.length = 0;
  const r2 = r * r, x = s.x, y = s.y, z = s.z, alive = s.alive;
  const xi = x[i], yi = y[i], zi = is3d ? z[i] : 0;
  const hW = W / 2, hH = H / 2, hD = D / 2;
  if (hash) {
    const { nBinsX, nBinsY, nBinsZ, binSizeX, binSizeY, binSizeZ, originX, originY, originZ, binStart, binAgents } = hash;
    let bx = ((xi - originX) / binSizeX) | 0; if (bx < 0) bx = 0; else if (bx >= nBinsX) bx = nBinsX - 1;
    let by = ((yi - originY) / binSizeY) | 0; if (by < 0) by = 0; else if (by >= nBinsY) by = nBinsY - 1;
    let bz = is3d ? ((zi - originZ) / binSizeZ) | 0 : 0; if (bz < 0) bz = 0; else if (bz >= nBinsZ) bz = nBinsZ - 1;
    const ez0 = is3d ? -1 : 0, ez1 = is3d ? 1 : 0;
    for (let ez = ez0; ez <= ez1; ez++) for (let ey = -1; ey <= 1; ey++) for (let ex = -1; ex <= 1; ex++) {
      let nbx = bx + ex, nby = by + ey, nbz = bz + ez;
      if (torus) {
        nbx = ((nbx % nBinsX) + nBinsX) % nBinsX; nby = ((nby % nBinsY) + nBinsY) % nBinsY;
        if (is3d) nbz = ((nbz % nBinsZ) + nBinsZ) % nBinsZ;
      } else if (nbx < 0 || nbx >= nBinsX || nby < 0 || nby >= nBinsY || (is3d && (nbz < 0 || nbz >= nBinsZ))) continue;
      const b = is3d ? (nbz * nBinsY + nby) * nBinsX + nbx : nby * nBinsX + nbx;
      if (WORK.on) WORK.cand += binStart[b + 1] - binStart[b];
      for (let p = binStart[b]; p < binStart[b + 1]; p++) {
        const j = binAgents[p];
        if (j === i || !alive[j]) continue;
        let dx = x[j] - xi, dy = y[j] - yi, dz = is3d ? z[j] - zi : 0;
        if (torus) {
          if (dx > hW) dx -= W; else if (dx < -hW) dx += W;
          if (dy > hH) dy -= H; else if (dy < -hH) dy += H;
          if (is3d) { if (dz > hD) dz -= D; else if (dz < -hD) dz += D; }
        }
        if (dx * dx + dy * dy + dz * dz <= r2) out.push(j);
      }
    }
  } else {
    // the engine's ALL-PAIRS fallback (hash null)
    if (WORK.on) WORK.cand += s.highWater;
    for (let j = 0; j < s.highWater; j++) {
      if (j === i || !alive[j]) continue;
      let dx = x[j] - xi, dy = y[j] - yi, dz = is3d ? z[j] - zi : 0;
      if (torus) {
        if (dx > hW) dx -= W; else if (dx < -hW) dx += W;
        if (dy > hH) dy -= H; else if (dy < -hH) dy += H;
        if (is3d) { if (dz > hD) dz -= D; else if (dz < -hD) dz += D; }
      }
      if (dx * dx + dy * dy + dz * dz <= r2) out.push(j);
    }
  }
  return out;
}

/** sorted-position -> agent id, for the tree. A shipped tree build would emit
 *  this array directly (one more Int32Array); the prototype reconstructs it and
 *  the cost is CHARGED to the tree build so the comparison stays fair. */
function treeSortedIds(s, tree) {
  const live = [];
  for (let i = 0; i < s.highWater; i++) if (s.alive[i]) live.push(i);
  const order = tree.order;                 // scratch field, present at runtime
  const ids = new Int32Array(tree.pointCount);
  for (let i = 0; i < tree.pointCount; i++) ids[i] = live[order[i]];
  return ids;
}

/** EXACT bbox-pruned range query over C10's octree. Standard three-way node
 *  test: prune (nearest bbox corner beyond r) / accept-all (farthest bbox corner
 *  within r) / descend. Non-torus; the caller replicates the query point for the
 *  minimum-image wrap. */
function treeQueryOne(tree, ids, cx, cy, cz, r, is3d, self, out) {
  const r2 = r * r;
  const { nodeCount, nodeStart, nodeEnd, nodeNext, sortedX, sortedY, sortedZ } = tree;
  const mnX = tree.nodeMinX, mnY = tree.nodeMinY, mnZ = tree.nodeMinZ;
  const mxX = tree.nodeMaxX, mxY = tree.nodeMaxY, mxZ = tree.nodeMaxZ;
  let ni = 0;
  while (ni < nodeCount) {
    if (WORK.on) WORK.nodes++;
    // nearest point of the node bbox to the query centre
    const nx = cx < mnX[ni] ? mnX[ni] - cx : cx > mxX[ni] ? cx - mxX[ni] : 0;
    const ny = cy < mnY[ni] ? mnY[ni] - cy : cy > mxY[ni] ? cy - mxY[ni] : 0;
    const nz = is3d ? (cz < mnZ[ni] ? mnZ[ni] - cz : cz > mxZ[ni] ? cz - mxZ[ni] : 0) : 0;
    if (nx * nx + ny * ny + nz * nz > r2) { ni = nodeNext[ni]; continue; }   // prune the subtree
    // farthest corner: whole node inside the ball ⇒ take every point, no tests
    const fx = Math.max(cx - mnX[ni], mxX[ni] - cx);
    const fy = Math.max(cy - mnY[ni], mxY[ni] - cy);
    const fz = is3d ? Math.max(cz - mnZ[ni], mxZ[ni] - cz) : 0;
    if (fx * fx + fy * fy + fz * fz <= r2) {
      // whole node inside: the points are TAKEN, not tested — not "candidates"
      for (let i = nodeStart[ni]; i < nodeEnd[ni]; i++) { const j = ids[i]; if (j !== self) out.push(j); }
      ni = nodeNext[ni]; continue;
    }
    if (nodeNext[ni] === ni + 1) {                                           // leaf ⇒ test its points
      if (WORK.on) WORK.cand += nodeEnd[ni] - nodeStart[ni];
      for (let i = nodeStart[ni]; i < nodeEnd[ni]; i++) {
        const j = ids[i]; if (j === self) continue;
        const dx = sortedX[i] - cx, dy = sortedY[i] - cy, dz = is3d ? sortedZ[i] - cz : 0;
        if (dx * dx + dy * dy + dz * dz <= r2) out.push(j);
      }
      ni++; continue;
    }
    ni++;                                                                     // descend
  }
  return out;
}

/** Torus-aware tree query: minimum-image by replicating the QUERY POINT. For a
 *  shift s the neighbour set of `p` over points `q+s` equals the set of `p-s`
 *  over the original points, so at most 2^d shifted queries suffice (only the
 *  axes whose ball crosses a world boundary), which is exact for r <= extent/2 —
 *  the same domain the engine's own fold assumes. */
function treeQuery(tree, ids, s, i, r, W, H, D, torus, is3d, out) {
  out.length = 0;
  const cx = s.x[i], cy = s.y[i], cz = is3d ? s.z[i] : 0;
  if (!torus) return treeQueryOne(tree, ids, cx, cy, cz, r, is3d, i, out);
  const sx = [0]; if (cx - r < 0) sx.push(-W); if (cx + r > W) sx.push(W);
  const sy = [0]; if (cy - r < 0) sy.push(-H); if (cy + r > H) sy.push(H);
  const sz = [0]; if (is3d) { if (cz - r < 0) sz.push(-D); if (cz + r > D) sz.push(D); }
  for (const ax of sx) for (const ay of sy) for (const az of sz) treeQueryOne(tree, ids, cx - ax, cy - ay, cz - az, r, is3d, i, out);
  return out;
}

// ===========================================================================
// PART 3 — fixtures + the measurement harness.
// ===========================================================================

function makeStore(N, W, H, D, is3d, r0) {
  const cfg = { maxAgents: N + 16, maxBonds: 0, defaultRadius: r0 };
  const s = createAgentStore(cfg, [], { wasmBacked: false });
  s.worldWidth = W; s.worldHeight = H; s.worldDepth = D;
  return s;
}

/** Deterministic LCG — every fixture is reproducible from its seed. */
function lcg(seed) { let v = seed >>> 0; return () => { v = (Math.imul(v, 1103515245) + 12345) & 0x7fffffff; return v / 0x7fffffff; }; }

/** `uniform`: agents spread over the whole world.
 *  `clustered`: `clusters` gaussian blobs of sigma = clusterSigma, placed
 *  uniformly — the GRA / tissue regime (a dense population in a sparse world). */
function seedFixture(s, N, W, H, D, is3d, r0, kind, opt = {}) {
  const rnd = lcg(opt.seed ?? 20260803);
  const gauss = () => { let u = 0, v = 0; while (u === 0) u = rnd(); while (v === 0) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const specs = [];
  const wrap = (v, L) => { v = v % L; return v < 0 ? v + L : v; };
  if (kind === 'uniform') {
    for (let i = 0; i < N; i++) specs.push(is3d ? { x: rnd() * W, y: rnd() * H, z: rnd() * D, radius: r0 } : { x: rnd() * W, y: rnd() * H, radius: r0 });
  } else {
    const k = opt.clusters ?? 1, sig = opt.clusterSigma ?? Math.min(W, H) * 0.05;
    const cs = [];
    for (let c = 0; c < k; c++) cs.push({ x: rnd() * W, y: rnd() * H, z: is3d ? rnd() * D : 0 });
    for (let i = 0; i < N; i++) {
      const c = cs[i % k];
      const p = { x: wrap(c.x + gauss() * sig, W), y: wrap(c.y + gauss() * sig, H), radius: r0 };
      if (is3d) p.z = wrap(c.z + gauss() * sig, D);
      specs.push(p);
    }
  }
  seedAgents(s, specs, r0);
}

const REPS = QUICK ? 1 : 3;

function measure(label, fn) {
  // best-of-REPS wall clock (the machine drifts; the minimum is the least noisy
  // estimator for a deterministic CPU workload)
  let best = Infinity;
  for (let k = 0; k < REPS; k++) { const t0 = performance.now(); fn(); const dt = performance.now() - t0; if (dt < best) best = dt; }
  return best;
}

/** Run one fixture through all three contenders + assert exactness. */
function runFixture(fx) {
  const { N, W, H, D, torus, is3d, r0, sharedEdge, queryR, kind, opt } = fx;
  const s = makeStore(N, W, H, D, is3d, r0);
  seedFixture(s, N, W, H, D, is3d, r0, kind, opt);
  const reserve = computeAgentMaxHashBins(W, H, D, 1.5, r0, sharedEdge);

  // --- build phase --------------------------------------------------------
  let hashShared = null, hashTuned = null, tree = null, ids = null;
  const tBuildShared = measure('hs', () => { hashShared = buildSpatialHash(s, sharedEdge, W, H, D, torus, reserve); });
  const tunedReserve = computeAgentMaxHashBins(W, H, D, 1.5, r0, queryR);
  const tBuildTuned = measure('ht', () => { hashTuned = buildSpatialHash(s, queryR, W, H, D, torus, tunedReserve); });
  const tBuildTree = measure('tr', () => { tree = buildAgentOctree(s, is3d, agentOctreeNodeReserve(s.maxAgents)); ids = treeSortedIds(s, tree); });

  // --- exactness (the non-negotiable gate) --------------------------------
  const a = [], b = [], c = [];
  let pairs = 0, diffs = 0, firstDiff = null;
  for (let i = 0; i < s.highWater; i++) {
    if (!s.alive[i]) continue;
    hashQuery(s, hashShared, i, queryR, W, H, D, torus, is3d, a);
    hashQuery(s, hashTuned, i, queryR, W, H, D, torus, is3d, b);
    treeQuery(tree, ids, s, i, queryR, W, H, D, torus, is3d, c);
    pairs += a.length;
    const sa = [...a].sort((p, q) => p - q), sb = [...b].sort((p, q) => p - q), sc = [...c].sort((p, q) => p - q);
    const eq = (u, v) => u.length === v.length && u.every((x, k) => x === v[k]);
    if (!eq(sa, sb) || !eq(sa, sc)) {
      diffs++;
      if (!firstDiff) firstDiff = { i, shared: sa.length, tuned: sb.length, tree: sc.length };
    }
  }

  // --- query phase (all agents, one generation's worth) --------------------
  const out = [];
  const tQShared = measure('qs', () => { for (let i = 0; i < s.highWater; i++) if (s.alive[i]) hashQuery(s, hashShared, i, queryR, W, H, D, torus, is3d, out); });
  const tQTuned = measure('qt', () => { for (let i = 0; i < s.highWater; i++) if (s.alive[i]) hashQuery(s, hashTuned, i, queryR, W, H, D, torus, is3d, out); });
  const tQTree = measure('qr', () => { for (let i = 0; i < s.highWater; i++) if (s.alive[i]) treeQuery(tree, ids, s, i, queryR, W, H, D, torus, is3d, out); });

  // --- WORK counts (untimed; implementation-independent) -------------------
  const count = (fn) => { WORK.cand = 0; WORK.nodes = 0; WORK.on = true; fn(); WORK.on = false; return { cand: WORK.cand, nodes: WORK.nodes }; };
  const wShared = count(() => { for (let i = 0; i < s.highWater; i++) if (s.alive[i]) hashQuery(s, hashShared, i, queryR, W, H, D, torus, is3d, out); });
  const wTuned = count(() => { for (let i = 0; i < s.highWater; i++) if (s.alive[i]) hashQuery(s, hashTuned, i, queryR, W, H, D, torus, is3d, out); });
  const wTree = count(() => { for (let i = 0; i < s.highWater; i++) if (s.alive[i]) treeQuery(tree, ids, s, i, queryR, W, H, D, torus, is3d, out); });

  return {
    fx, diffs, firstDiff, pairs, wShared, wTuned, wTree,
    sharedNull: hashShared == null, tunedNull: hashTuned == null,
    sharedBins: hashShared ? hashShared.nBinsX * hashShared.nBinsY * hashShared.nBinsZ : 0,
    sharedEdgeUsed: hashShared ? hashShared.binSizeX : 0,
    tunedBins: hashTuned ? hashTuned.nBinsX * hashTuned.nBinsY * hashTuned.nBinsZ : 0,
    nodes: tree ? tree.nodeCount : 0,
    shared: tBuildShared + tQShared, tuned: tBuildTuned + tQTuned, tree: tBuildTree + tQTree,
    bShared: tBuildShared, bTuned: tBuildTuned, bTree: tBuildTree,
    qShared: tQShared, qTuned: tQTuned, qTree: tQTree,
  };
}

function printRow(r) {
  const f = r.fx;
  const spacing = f.is3d ? Math.cbrt((f.W * f.H * f.D) / f.N) : Math.sqrt((f.W * f.H) / f.N);
  const speedTree = r.shared / r.tree, speedTuned = r.shared / r.tuned;
  const mark = (v) => v >= 1.5 ? '**' : v >= 1.0 ? ' +' : ' -';
  console.log(
    `${f.label.padEnd(34)} ${String(f.N).padStart(6)} ${fmt(f.queryR / spacing).padStart(7)} ${fmt(r.sharedEdgeUsed / f.queryR).padStart(7)} ` +
    `${(r.pairs / f.N).toFixed(1).padStart(7)} ${fmt(r.shared).padStart(8)} ${fmt(r.tuned).padStart(8)} ${fmt(r.tree).padStart(8)} ` +
    `${(fmt(speedTuned) + '×').padStart(7)}${mark(speedTuned)} ${(fmt(speedTree) + '×').padStart(7)}${mark(speedTree)}  ${r.diffs === 0 ? 'exact' : `DIFF×${r.diffs}`}${r.sharedNull ? ' [all-pairs]' : ''}`);
}

// ===========================================================================
// MAIN
// ===========================================================================

const stats = shippedStats();
printStats(stats);
if (STATS_ONLY) { rmSync(entryPath, { force: true }); rmSync(dir, { recursive: true, force: true }); process.exit(0); }

const fixtures = [];
const r0 = 1;

// --- A. UNIFORM density, sweeping the radius / mean-spacing ratio ----------
// The regime DC1 measured. The shipped hash sizes its bin edge to the query, so
// the stencil over-scan should be a CONSTANT ~2.9x (2D) / ~6.4x (3D) here.
for (const N of QUICK ? [4000] : [2000, 20000]) {
  for (const ratio of [0.5, 1, 2, 5, 10, 15]) {
    const W = 1000, H = 1000;
    const spacing = Math.sqrt((W * H) / N);
    const qr = ratio * spacing;
    if (qr > Math.min(W, H) / 2) continue;      // minimum-image domain
    fixtures.push({ label: `A uniform 2D r/space=${ratio}`, N, W, H, D: 1, torus: true, is3d: false, r0, sharedEdge: qr, queryR: qr, kind: 'uniform' });
  }
}
for (const ratio of [2, 5, 10]) {
  const N = QUICK ? 4000 : 20000, W = 200, H = 200, D = 200;
  const spacing = Math.cbrt((W * H * D) / N);
  const qr = ratio * spacing;
  if (qr > 100) continue;
  fixtures.push({ label: `A uniform 3D r/space=${ratio}`, N, W, H, D, torus: true, is3d: true, r0, sharedEdge: qr, queryR: qr, kind: 'uniform' });
}

// --- B. CLUSTERED in a SPARSE world (the GRA / tissue regime) --------------
// A torus hash spans the WHOLE world and coarsens to fit the bin cap, so a tight
// cluster in a huge torus is the structural degradation case. Bounded is the
// control: buildSpatialHash is bbox-anchored there, so it should NOT degrade.
for (const worldMul of QUICK ? [16] : [4, 16, 64]) {
  const N = 20000, qr = 8, sigma = 40;
  const W = sigma * 6 * worldMul, H = W;
  for (const torus of [true, false]) {
    fixtures.push({
      label: `B ${torus ? 'torus' : 'bnd  '} cluster world×${worldMul}`, N, W, H, D: 1, torus, is3d: false, r0,
      sharedEdge: qr, queryR: qr, kind: 'clustered', opt: { clusters: 4, clusterSigma: sigma },
    });
  }
}

// --- C. SHARED-EDGE over-scan: the shipped models' real shape --------------
// ONE hash serves every consumer, so its edge is the LARGEST radius any of them
// needs (a charge cutoff / neighbourQueryRadius) while a graph query may ask for
// far less. edge/r is the resulting over-scan, and it is what several shipped
// models actually sit on.
for (const [label, N, W, H, edge, qr] of [
  ['C GRA-like  edge20 r6', 3000, 600, 600, 20, 6],
  ['C SDCA-like edge28 r7', 400, 220, 220, 28, 7],
  ['C PL-like   edge24 r16', 1800, 320, 200, 24, 16],
  ['C Boids     edge14 r14', 260, 120, 120, 14, 14],
]) fixtures.push({ label, N, W, H, D: 1, torus: true, is3d: false, r0, sharedEdge: edge, queryR: qr, kind: 'uniform' });
// Particle Life 3D: the shipped world is too shallow for a 24-wide bin
// (floor(70/24) = 2 < 3), so buildSpatialHash BAILS and the engine runs ALL-PAIRS.
fixtures.push({ label: 'C PL3D shipped (hash bails)', N: 1200, W: 160, H: 110, D: 70, torus: true, is3d: true, r0: 1.2, sharedEdge: 24, queryR: 16, kind: 'uniform' });
// ...and the same model grown, where all-pairs is quadratic.
fixtures.push({ label: 'C PL3D grown N=8000', N: 8000, W: 160, H: 110, D: 70, torus: true, is3d: true, r0: 1.2, sharedEdge: 24, queryR: 16, kind: 'uniform' });

console.log('\n=== CONTENDERS — index build + one query per agent, best of ' + REPS + ' (ms) ===');
console.log('    hash-shared = the SHIPPED path (one hash at the engine bin edge)');
console.log('    hash-tuned  = a second hash at the QUERY radius (the cheap alternative)');
console.log('    tree        = buildAgentOctree + exact bbox-pruned range query');
console.log(`${'fixture'.padEnd(34)} ${'N'.padStart(6)} ${'r/space'.padStart(7)} ${'edge/r'.padStart(7)} ${'nbr/ag'.padStart(7)} ${'shared'.padStart(8)} ${'tuned'.padStart(8)} ${'tree'.padStart(8)} ${'tunedX'.padStart(9)} ${'treeX'.padStart(9)}  exactness`);

const results = [];
let totalDiffs = 0;
for (const fx of fixtures) {
  const r = runFixture(fx);
  results.push(r); totalDiffs += r.diffs;
  printRow(r);
  if (r.diffs) console.log(`      !! first diff at agent ${r.firstDiff.i}: shared=${r.firstDiff.shared} tuned=${r.firstDiff.tuned} tree=${r.firstDiff.tree}`);
}

console.log('\n    ** = >=1.5x faster than the shipped hash (the C11 decision threshold)');
console.log(`    EXACTNESS: ${totalDiffs === 0 ? 'ALL FIXTURES IDENTICAL neighbour sets across all three contenders' : `${totalDiffs} MISMATCHES — the prototype is NOT exact`}`);

// --- work counts: the implementation-INDEPENDENT view ---------------------
console.log('\n=== WORK per agent (candidates examined; tree also visits nodes) ===');
console.log('    A candidate is a bin entry (hash) or a leaf point distance-tested (tree). Points inside a');
console.log('    fully-contained tree node are TAKEN, not tested, so they are not candidates. Wall-clock and');
console.log('    candidate ratios should agree; where they do not, the constant factors are doing the work.');
console.log(`${'fixture'.padEnd(34)} ${'kept'.padStart(7)} ${'sharedC'.padStart(8)} ${'tunedC'.padStart(8)} ${'treeC'.padStart(8)} ${'treeN'.padStart(8)} ${'cand ratio'.padStart(11)} ${'time ratio'.padStart(11)}`);
for (const r of results) {
  const n = r.fx.N;
  const cr = r.wTree.cand > 0 ? r.wShared.cand / r.wTree.cand : Infinity;
  console.log(`${r.fx.label.padEnd(34)} ${(r.pairs / n).toFixed(1).padStart(7)} ${(r.wShared.cand / n).toFixed(1).padStart(8)} ${(r.wTuned.cand / n).toFixed(1).padStart(8)} ${(r.wTree.cand / n).toFixed(1).padStart(8)} ${(r.wTree.nodes / n).toFixed(1).padStart(8)} ${(fmt(cr) + '×').padStart(11)} ${(fmt(r.shared / r.tree) + '×').padStart(11)}`);
}

// --- build/query split for the fixtures where the tree wins ---------------
const winners = results.filter(r => r.shared / r.tree >= 1.5);
if (winners.length) {
  console.log('\n=== where the tree wins >=1.5x — build vs query split (ms) ===');
  console.log(`${'fixture'.padEnd(34)} ${'shared b'.padStart(9)} ${'shared q'.padStart(9)} ${'tree b'.padStart(9)} ${'tree q'.padStart(9)} ${'nodes'.padStart(7)}`);
  for (const r of winners) console.log(`${r.fx.label.padEnd(34)} ${fmt(r.bShared).padStart(9)} ${fmt(r.qShared).padStart(9)} ${fmt(r.bTree).padStart(9)} ${fmt(r.qTree).padStart(9)} ${String(r.nodes).padStart(7)}`);
}

if (totalDiffs !== 0) { rmSync(entryPath, { force: true }); rmSync(dir, { recursive: true, force: true }); process.exit(1); }
rmSync(entryPath, { force: true }); rmSync(dir, { recursive: true, force: true });

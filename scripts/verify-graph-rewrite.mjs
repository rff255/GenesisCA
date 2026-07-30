// GRAPH-REWRITING AUTOMATA — the invariant + oracle harness.
//
// Created in P1 (Neighbour State Census) and EXTENDED by every later phase of the
// milestone. Three tiers, following the structure of verify-agent-render.mjs:
//
//   A  Graph invariants (I1 handshake / I3 no dangling / I4 capacity) as reusable
//      checkers over a `getState`-shaped agent payload, EACH with a negative-
//      control mutation proving it fails when broken. `checkBondSymmetry` (I2)
//      and `checkDegreeRegular` (I6) arrive with P2 / P5.
//   B  The census LOWERING: both agent-target gates accept a census model, the
//      lowered graph has the expected shape, all three targets emit, and the pass
//      is a hot-path no-op when no census node exists.
//   D  BOND ATTRIBUTES (P2): compaction lockstep + I2 through the real engine.
//   E  PX: `agentUpdateMode: 'sync'` is DOUBLE-BUFFERED on the WebGPU agent target
//      (reads on the read run, writes on the write run, aliased when async) — with
//      a negative control that compiles against the pre-PX aliased layout.
//   C  The Conway oracles, run headless through the REAL compiled behaviour over a
//      real agent store: O7 (differential vs the shipped Game of Life on Agents),
//      O11 (block / blinker / toad / glider), O3 (identity rule leaves everything
//      bit-identical), plus a JS<->WASM cross-check of the census itself.
//
// Run from the repo root:  node scripts/verify-graph-rewrite.mjs
import { build } from 'esbuild';
import { writeFileSync, rmSync, mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The bundle entry is written at run time (scripts/__*_entry.ts is gitignored —
// the same pattern parity-agent-wasm.mjs uses) and removed at the end.
const ENTRY = `
export {
  createAgentStore, computeAgentMaxHashBins, buildSpatialHash, seedAgents, formBond, breakBond,
  freeAgentSlot, sweepStaleBonds, allocAgentSlot, initAgentSlot, divideAgent, bondAttrKind,
  serializeAgentStore, deserializeAgentStore,
  rewireBond, hasBond, drainAgentBondRequests, clearAgentBondRequests,
} from '../src/simulator/engine/agentEngine.ts';
export { BOND_REQ_NONE, BOND_REQ_ID_BIAS, bondReqSlotsForModel, agentGraphUsesBondRequests } from '../src/modeler/vpl/compiler/bondRequestQueue.ts';
export {
  DEFAULT_DIVIDE_PARTITION, dividePartitionFromConfig, dividePartitionKey, dividePartitionCode,
} from '../src/modeler/vpl/compiler/dividePartition.ts';
export { detectMissingConfig } from '../src/modeler/vpl/nodes/nodeValidation.ts';
export { resolveBondRequestDepth } from '../src/model/centerBased.ts';
export { serializeAgentState, deserializeAgentState } from '../src/model/fileOperations.ts';
export { bondAttrsOf } from '../src/model/attributeScope.ts';
export {
  compileAgentGraphWasmForModel, instantiateAgentWasm, buildAgentLayoutExtras, isAgentGraphWasmSupported,
} from '../src/modeler/vpl/compiler/agentWasm/compile.ts';
export {
  compileAgentGraphWebGPUForModel, isAgentGraphWebGPUSupported, compileAgentGraphWebGPU,
  agentWebGPUExtrasOf,
} from '../src/modeler/vpl/compiler/agentWebgpu/compile.ts';
export { computeAgentWebGPULayout } from '../src/modeler/vpl/compiler/agentWebgpu/layout.ts';
export { compileAgentGraph } from '../src/modeler/vpl/compiler/compile.ts';
export { buildAgentAbiArgs } from '../src/modeler/vpl/compiler/agentAbi.ts';
export { migrateForHarness } from '../src/dev/compileHarness.ts';
export { agentAttrsOf, cellFieldAttrsOf } from '../src/model/attributeScope.ts';
export { expandNeighbourCensus, buildCensusPorts, censusOptions, censusAttribute } from '../src/modeler/vpl/compiler/censusExpand.ts';
export { getEffectivePorts } from '../src/modeler/vpl/effectivePorts.ts';
`;
const entryPath = join(ROOT, 'scripts', '__gra_entry.ts');
writeFileSync(entryPath, ENTRY);
const dir = mkdtempSync(join(tmpdir(), 'gca-gra-'));
const outPath = join(dir, 'bundle.mjs');
await build({
  entryPoints: [entryPath], bundle: true, format: 'esm',
  platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: ROOT,
});
const m = await import(pathToFileURL(outPath).href);
const {
  createAgentStore, computeAgentMaxHashBins, buildSpatialHash, seedAgents, formBond, breakBond,
  freeAgentSlot, sweepStaleBonds, allocAgentSlot, initAgentSlot, divideAgent, bondAttrKind,
  serializeAgentStore, deserializeAgentStore, serializeAgentState, deserializeAgentState, bondAttrsOf,
  rewireBond, hasBond, drainAgentBondRequests, clearAgentBondRequests,
  BOND_REQ_NONE, BOND_REQ_ID_BIAS, bondReqSlotsForModel, agentGraphUsesBondRequests, resolveBondRequestDepth,
  DEFAULT_DIVIDE_PARTITION, dividePartitionFromConfig, dividePartitionKey, dividePartitionCode, detectMissingConfig,
  compileAgentGraphWasmForModel, instantiateAgentWasm, buildAgentLayoutExtras, isAgentGraphWasmSupported,
  compileAgentGraphWebGPUForModel, isAgentGraphWebGPUSupported, compileAgentGraphWebGPU,
  agentWebGPUExtrasOf, computeAgentWebGPULayout,
  compileAgentGraph, buildAgentAbiArgs, migrateForHarness, agentAttrsOf, cellFieldAttrsOf,
  expandNeighbourCensus, buildCensusPorts, censusOptions, censusAttribute, getEffectivePorts,
} = m;

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? '  — ' + extra : ''}`); }
};
const section = (t) => console.log(`\n=== ${t} ===`);

// ===========================================================================
// TIER A — the graph invariants
// ===========================================================================
//
// Every checker takes a NORMALISED graph view so the same code serves a live
// AgentStore (this harness) and a worker `getState` agent payload (the browser
// probe): { highWater, maxBonds, alive, bondCount, bondPartner }. `decodeAgentGraph`
// accepts either typed arrays or the ArrayBuffers `getState` transfers.
// Each returns null when the invariant HOLDS, else a human-readable violation.

export function decodeAgentGraph(p) {
  const asU8 = (v, n) => (v instanceof Uint8Array ? v : new Uint8Array(v, 0, n));
  const asI32 = (v, n) => (v instanceof Int32Array ? v : new Int32Array(v, 0, n));
  const asF64 = (v, n) => (v instanceof Float64Array ? v : new Float64Array(v, 0, n));
  const hw = p.highWater, mb = p.maxBonds;
  // P2 — the per-slot bond FIELDS I2 compares. Present on a live AgentStore and on
  // a `getState` agent payload alike; each is optional so the older callers (and a
  // legacy payload) still decode. `bondAttrs` mirrors the payload's `attrs` shape
  // ({ kind, buffer }) OR a live store's plain typed arrays.
  const bondFields = [];
  const bw = hw * mb;
  if (bw > 0) {
    if (p.bondRestLength) bondFields.push(['restLength', asF64(p.bondRestLength, bw)]);
    if (p.bondStiffness) bondFields.push(['stiffness', asF64(p.bondStiffness, bw)]);
    if (p.bondTypeLabel) bondFields.push(['typeLabel', asI32(p.bondTypeLabel, bw)]);
    for (const [id, e] of Object.entries(p.bondAttrs ?? {})) {
      // A LIVE store hands a typed array; a `getState` payload hands { kind, buffer }.
      // NB a typed array also HAS a `.buffer`, so discriminate on ArrayBuffer.isView
      // FIRST — testing `e.buffer !== undefined` reinterprets an f64 region as i32.
      if (ArrayBuffer.isView(e)) { bondFields.push([`attr:${id}`, e]); continue; }
      const kind = e.kind === 'float64' ? 'float64' : 'int32';
      bondFields.push([`attr:${id}`, kind === 'float64' ? asF64(e.buffer, bw) : asI32(e.buffer, bw)]);
    }
  }
  return {
    highWater: hw, maxBonds: mb,
    alive: asU8(p.alive, hw),
    bondCount: asI32(p.bondCount, hw),
    bondPartner: asI32(p.bondPartner, bw),
    bondFields,
  };
}

/** I1 — handshake lemma: Σ deg(v) == 2·|E| over the LIVE subgraph. Catches
 *  asymmetric bonds, half-applied form/break, bonds not cleaned up on death. */
export function checkHandshake(g) {
  let degSum = 0;
  const seen = new Set();
  for (let i = 0; i < g.highWater; i++) {
    if (!g.alive[i]) continue;
    const n = g.bondCount[i];
    degSum += n;
    for (let k = 0; k < n; k++) {
      const p = g.bondPartner[i * g.maxBonds + k];
      if (p < 0 || p >= g.highWater || !g.alive[p]) continue;
      seen.add(i < p ? `${i}:${p}` : `${p}:${i}`);
    }
  }
  if (degSum !== 2 * seen.size) return `Σdeg=${degSum} != 2·|E|=${2 * seen.size}`;
  return null;
}

/** I3 — no dangling: every recorded partner is in range, alive, and not self.
 *  (The epoch mechanism's whole job is preventing recycled-slot aliasing.) */
export function checkNoDangling(g) {
  for (let i = 0; i < g.highWater; i++) {
    if (!g.alive[i]) continue;
    for (let k = 0; k < g.bondCount[i]; k++) {
      const p = g.bondPartner[i * g.maxBonds + k];
      if (p === i) return `agent ${i} slot ${k}: self-bond`;
      if (p < 0 || p >= g.highWater) return `agent ${i} slot ${k}: partner ${p} out of range`;
      if (!g.alive[p]) return `agent ${i} slot ${k}: partner ${p} is dead`;
    }
  }
  return null;
}

/** I4 — capacity: bondCount never exceeds maxBonds (and is never negative).
 *  Catches an overflow that wraps instead of rejecting. */
export function checkCapacity(g) {
  for (let i = 0; i < g.highWater; i++) {
    if (!g.alive[i]) continue;
    const n = g.bondCount[i];
    if (n < 0 || n > g.maxBonds) return `agent ${i}: bondCount ${n} outside [0, ${g.maxBonds}]`;
  }
  return null;
}

/** I2 — bond symmetry: a bond is ONE object stored TWICE. For every live `i`,
 *  slot `k` with a live partner `p`, `p`'s list must contain `i`, and EVERY
 *  per-slot field (rest length, stiffness, type label, and every bond attribute)
 *  must read IDENTICALLY from both sides. Catches one-sided writes and a
 *  compaction that swaps some fields but not others (the phase's highest risk).
 *  Fields the caller did not supply are simply not compared. */
export function checkBondSymmetry(g) {
  for (let i = 0; i < g.highWater; i++) {
    if (!g.alive[i]) continue;
    for (let k = 0; k < g.bondCount[i]; k++) {
      const p = g.bondPartner[i * g.maxBonds + k];
      if (p < 0 || p >= g.highWater || !g.alive[p]) continue;   // I3's job, not I2's
      let kp = -1;
      for (let j = 0; j < g.bondCount[p]; j++) {
        if (g.bondPartner[p * g.maxBonds + j] === i) { kp = j; break; }
      }
      if (kp < 0) return `bond ${i}→${p}: partner has no reverse slot`;
      for (const [name, arr] of g.bondFields ?? []) {
        const a = arr[i * g.maxBonds + k], b = arr[p * g.maxBonds + kp];
        if (!Object.is(a, b)) return `bond ${i}↔${p}: ${name} ${a} != ${b}`;
      }
    }
  }
  return null;
}

/** A degree-regularity probe (I6's ingredient, used by the Life-on-Bonds checks:
 *  every live agent must carry exactly `d` bonds and E must equal d·N/2). */
export function checkDegreeRegular(g, d) {
  let live = 0, edges = 0;
  for (let i = 0; i < g.highWater; i++) {
    if (!g.alive[i]) continue;
    live++;
    if (g.bondCount[i] !== d) return `agent ${i}: degree ${g.bondCount[i]} != ${d}`;
    edges += g.bondCount[i];
  }
  edges /= 2;
  if (edges !== d * live / 2) return `E=${edges} != d·N/2=${d * live / 2}`;
  return null;
}

function tierA() {
  section('TIER A — graph invariants (with negative controls)');
  // A small healthy graph: a 12-node ring plus chords (degree 2 or 3).
  const build = () => {
    const N = 12, MB = 4;
    const g = {
      highWater: N, maxBonds: MB,
      alive: new Uint8Array(N).fill(1),
      bondCount: new Int32Array(N),
      bondPartner: new Int32Array(N * MB).fill(-1),
    };
    const link = (a, b) => {
      g.bondPartner[a * MB + g.bondCount[a]++] = b;
      g.bondPartner[b * MB + g.bondCount[b]++] = a;
    };
    for (let i = 0; i < N; i++) link(i, (i + 1) % N);
    link(0, 6); link(3, 9);
    return g;
  };

  const healthy = build();
  ok(checkHandshake(healthy) === null, 'I1 handshake holds on a healthy graph', String(checkHandshake(healthy)));
  ok(checkNoDangling(healthy) === null, 'I3 no dangling holds on a healthy graph', String(checkNoDangling(healthy)));
  ok(checkCapacity(healthy) === null, 'I4 capacity holds on a healthy graph', String(checkCapacity(healthy)));

  // --- negative controls: each mutation must trip its own checker ---
  // I1: drop ONE side of a bond (the classic half-applied break / asymmetric write).
  {
    const g = build();
    const p = g.bondPartner[0 * g.maxBonds + 0];
    // remove 0 from p's list only → p's degree drops, the edge still counts once.
    for (let k = 0; k < g.bondCount[p]; k++) {
      if (g.bondPartner[p * g.maxBonds + k] === 0) {
        g.bondPartner[p * g.maxBonds + k] = g.bondPartner[p * g.maxBonds + g.bondCount[p] - 1];
        g.bondCount[p]--;
        break;
      }
    }
    ok(checkHandshake(g) !== null, 'I1 negative control: one-sided bond removal is CAUGHT');
  }
  // I3: point a slot at a dead agent (recycled-slot aliasing).
  {
    const g = build();
    g.alive[5] = 0;
    ok(checkNoDangling(g) !== null, 'I3 negative control: partner pointing at a dead agent is CAUGHT');
  }
  // I3: point a slot at itself.
  {
    const g = build();
    g.bondPartner[2 * g.maxBonds + 0] = 2;
    ok(checkNoDangling(g) !== null, 'I3 negative control: self-bond is CAUGHT');
  }
  // I4: overflow the count (a queue that wraps instead of rejecting).
  {
    const g = build();
    g.bondCount[4] = g.maxBonds + 1;
    ok(checkCapacity(g) !== null, 'I4 negative control: bondCount > maxBonds is CAUGHT');
  }
  // I2 symmetry — a graph carrying per-slot fields on both sides.
  {
    const buildSym = () => {
      const N = 6, MB = 4;
      const g = {
        highWater: N, maxBonds: MB,
        alive: new Uint8Array(N).fill(1),
        bondCount: new Int32Array(N),
        bondPartner: new Int32Array(N * MB).fill(-1),
      };
      const w = new Float64Array(N * MB), lbl = new Int32Array(N * MB);
      g.bondFields = [['attr:w', w], ['attr:lbl', lbl]];
      let seq = 1;
      const link = (a, b) => {
        const ka = a * MB + g.bondCount[a]++, kb = b * MB + g.bondCount[b]++;
        g.bondPartner[ka] = b; g.bondPartner[kb] = a;
        w[ka] = w[kb] = seq * 0.25; lbl[ka] = lbl[kb] = seq; seq++;
      };
      for (let i = 0; i < N; i++) link(i, (i + 1) % N);
      link(0, 3);
      return g;
    };
    const healthySym = buildSym();
    ok(checkBondSymmetry(healthySym) === null, 'I2 symmetry holds on a healthy attributed graph', String(checkBondSymmetry(healthySym)));
    // negative control 1: a ONE-SIDED attribute write (the Set Bond Attribute bug).
    {
      const g = buildSym();
      g.bondFields[0][1][0 * g.maxBonds + 0] = 99;
      ok(checkBondSymmetry(g) !== null, 'I2 negative control: a one-sided attribute write is CAUGHT');
    }
    // negative control 2: a compaction that swaps bondPartner but NOT an attribute
    // (the phase's highest-risk edit — a field missed in removeBondSlot).
    {
      const g = buildSym();
      const a = 1, MB = g.maxBonds, n = g.bondCount[a], last = n - 1;
      g.bondPartner[a * MB + 0] = g.bondPartner[a * MB + last];   // partner moved…
      g.bondCount[a] = last;                                      // …attributes NOT
      ok(checkBondSymmetry(g) !== null, 'I2 negative control: a partner-only compaction swap is CAUGHT');
    }
    // negative control 3: a missing reverse slot (half-applied form).
    {
      const g = buildSym();
      g.bondCount[2] = 0;
      ok(checkBondSymmetry(g) !== null, 'I2 negative control: a missing reverse slot is CAUGHT');
    }
  }
  // degree regularity.
  {
    const N = 8, MB = 4;
    const g = { highWater: N, maxBonds: MB, alive: new Uint8Array(N).fill(1), bondCount: new Int32Array(N), bondPartner: new Int32Array(N * MB).fill(-1) };
    const link = (a, b) => { g.bondPartner[a * MB + g.bondCount[a]++] = b; g.bondPartner[b * MB + g.bondCount[b]++] = a; };
    for (let i = 0; i < N; i++) link(i, (i + 1) % N);          // ring: degree 2
    ok(checkDegreeRegular(g, 2) === null, 'degree-regularity holds on a 2-regular ring');
    ok(checkDegreeRegular(g, 3) !== null, 'degree negative control: wrong d is CAUGHT');
  }
}

// ===========================================================================
// TIER B — the census lowering
// ===========================================================================

let nId = 0;
const mkGraphBuilder = () => {
  const nodes = [], edges = [];
  const n = (t, c) => { const nd = { id: `n${nId++}`, type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c || {} } }; nodes.push(nd); return nd; };
  const e = (s, sp, t, tp, cat) => edges.push({ id: `e${nId++}`, source: s.id, target: t.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
  return { nodes, edges, n, v: (s, sp, t, tp) => e(s, sp, t, tp, 'value'), f: (s, sp, t, tp) => e(s, sp, t, tp, 'flow') };
};

const AGENT_CAPS = (over) => ({
  motion: 'force', body: true, collision: 'off', bonds: 'physics', autoBond: false,
  growth: false, division: false, lifespan: false, populationBirth: false, populationDeath: false,
  sensing: true, sensingHeadingSource: 'velocity', orientation: false, fieldCoupling: false,
  appearance: true, ...over,
});

/** A model wrapper around an agent graph (agents-only, 2D torus, sync attrs). */
const wrapModel = (name, agentNodes, agentEdges, agentAttributes, over = {}) => ({
  schemaVersion: 1,
  properties: {
    name, dimension: '2d', gridWidth: 32, gridHeight: 32, gridDepth: 1, topology: '2d-grid',
    boundaryTreatment: 'torus', updateMode: 'synchronous', useWasm: true, useWebGPU: false,
  },
  topologyMode: { gridCells: false, agents: true },
  centerBased: {
    enabled: true, agentTarget: 'wasm', maxAgents: 1200, maxBonds: 8, worldWidth: 32, worldHeight: 32,
    seedCount: 0, seedPattern: 'scatter', defaultRadius: 0.45, growthRate: 0,
    repulsionStiffness: 0, adhesionStiffness: 0, interactionRange: 1.5, drag: 1, timeStep: 0.5,
    momentum: 0, maxSpeed: 0, neighbourQueryRadius: 2, customForcesOnly: true, useBondingPhysics: false,
    autoBond: false, bondStiffness: 0, bondRestLength: 1.0, formDistance: 1.9, breakDistance: 2.5,
    agentUpdateMode: 'sync', agentCapabilities: AGENT_CAPS(),
    ...over,
  },
  attributes: [], modelAttributes: [], neighborhoods: [], mappings: [],
  agentAttributes, variables: [], agentVariables: [], indicators: [],
  graphNodes: [], graphEdges: [], agentGraphNodes: agentNodes, agentGraphEdges: agentEdges, macroDefs: [],
});

/** Census over a 3-option TAG attribute — the shape the exit gate asks for.
 *  `consume` selects which output ports the rule reads. */
function buildTagCensusModel(consume = ['count_0', 'count_1', 'count_2', 'total']) {
  const g = mkGraphBuilder();
  const bs = g.n('behaviourStep', {});
  const census = g.n('neighbourCensus', { attributeId: 'kind', source: 'bonded' });
  const outAttrs = { count_0: 'c0', count_1: 'c1', count_2: 'c2', total: 'tot' };
  const slots = consume.filter(p => outAttrs[p]);
  const first = slots[0];
  const set = g.n('setAttribute', {
    attributeId: outAttrs[first],
    extraCount: slots.length - 1,
    ...Object.fromEntries(slots.slice(1).map((p, i) => [`attr_${i + 2}`, outAttrs[p]])),
  });
  g.v(census, first, set, 'value');
  slots.slice(1).forEach((p, i) => g.v(census, p, set, `value_${i + 2}`));
  g.f(bs, 'do', set, 'do');
  return wrapModel('Census Tag Test', g.nodes, g.edges, [
    { id: 'kind', name: 'Kind', type: 'tag', defaultValue: '0', tagOptions: ['Red', 'Green', 'Blue'] },
    { id: 'c0', name: 'C0', type: 'integer', defaultValue: '0' },
    { id: 'c1', name: 'C1', type: 'integer', defaultValue: '0' },
    { id: 'c2', name: 'C2', type: 'integer', defaultValue: '0' },
    { id: 'tot', name: 'Tot', type: 'integer', defaultValue: '0' },
  ]);
}

function tierB() {
  section('TIER B — the census lowering');

  const model = migrateForHarness(buildTagCensusModel());

  // --- the dynamic ports come from the attribute's options ---
  {
    const censusNode = model.agentGraphNodes.find(n => n.data.nodeType === 'neighbourCensus');
    const attr = censusAttribute(censusNode.data.config, model);
    const opts = censusOptions(attr);
    ok(opts.length === 3 && opts.map(o => o.label).join(',') === 'Red,Green,Blue',
      'census options come from the tag attribute', JSON.stringify(opts));
    const ports = buildCensusPorts('neighbourCensus', censusNode.data.config, model);
    ok(ports.outputs.length === 3 && ports.outputs[0].id === 'count_0' && ports.outputs[2].label === 'Blue',
      'buildCensusPorts emits one labelled integer output per option');
    // effectivePorts (the drag/drop + menu port model) must agree with the builder.
    const eff = getEffectivePorts('neighbourCensus', censusNode.data.config, model);
    const effIds = eff.outputs.map(p => p.id).join(',');
    ok(effIds === 'count_0,count_1,count_2,total',
      'effectivePorts exposes the counts + total (no drift with the builder)', effIds);
    // A bool attribute yields False/True.
    const boolPorts = buildCensusPorts('neighbourCensus', { attributeId: 'b' },
      { attributes: [], agentAttributes: [{ id: 'b', name: 'B', type: 'bool' }] });
    ok(boolPorts.outputs.length === 2 && boolPorts.outputs[1].label === 'True',
      'a bool census attribute yields False / True ports');
    // Radius is hidden for the bonded source, shown for nearby.
    const bondedIn = getEffectivePorts('neighbourCensus', { attributeId: 'kind', source: 'bonded' }, model).inputs.map(p => p.id);
    const nearbyIn = getEffectivePorts('neighbourCensus', { attributeId: 'kind', source: 'nearby' }, model).inputs.map(p => p.id);
    ok(bondedIn.length === 0 && nearbyIn.join(',') === 'radius',
      'Radius is hidden for the bonded source and shown for nearby', `${bondedIn} | ${nearbyIn}`);
  }

  // --- the lowered graph shape ---
  {
    const { nodes, edges } = expandNeighbourCensus(model.agentGraphNodes, model.agentGraphEdges, model);
    const types = nodes.map(n => n.data.nodeType);
    ok(!types.includes('neighbourCensus'), 'no census node survives the lowering');
    ok(types.filter(t => t === 'getBondedAgents').length === 1, 'exactly ONE gather is synthesized');
    ok(types.filter(t => t === 'getAgentsAttribute').length === 1, 'exactly ONE value gather is synthesized (shared)');
    ok(types.filter(t => t === 'groupCounting').length === 3, 'one Count Matching per consumed state port');
    ok(types.filter(t => t === 'getConstant').length === 3, 'one constant per consumed state port');
    ok(types.filter(t => t === 'arrayLength').length === 1, 'Total lowers to an Array Length');
    // The Total reads the ID array (so it stays meaningful with no attribute set).
    const lenNode = nodes.find(n => n.data.nodeType === 'arrayLength');
    const gatherNode = nodes.find(n => n.data.nodeType === 'getBondedAgents');
    const lenEdge = edges.find(e => e.target === lenNode.id);
    ok(lenEdge && lenEdge.source === gatherNode.id, 'Total reads the gather directly, not the value array');
    // Deterministic ids (byte stability across recompiles).
    const again = expandNeighbourCensus(model.agentGraphNodes, model.agentGraphEdges, model);
    ok(JSON.stringify(again.nodes.map(n => n.id)) === JSON.stringify(nodes.map(n => n.id)),
      'synthetic ids are deterministic');
  }

  // --- only CONSUMED ports are synthesized ---
  {
    const one = migrateForHarness(buildTagCensusModel(['count_1']));
    const { nodes } = expandNeighbourCensus(one.agentGraphNodes, one.agentGraphEdges, one);
    const types = nodes.map(n => n.data.nodeType);
    ok(types.filter(t => t === 'groupCounting').length === 1, 'an unconsumed count synthesizes nothing');
    ok(!types.includes('arrayLength'), 'an unconsumed Total synthesizes nothing');
  }
  {
    // Total only → no attribute gather at all (one array producer, not two).
    const tot = migrateForHarness(buildTagCensusModel(['total']));
    const { nodes } = expandNeighbourCensus(tot.agentGraphNodes, tot.agentGraphEdges, tot);
    const types = nodes.map(n => n.data.nodeType);
    ok(!types.includes('getAgentsAttribute') && types.includes('arrayLength'),
      'a Total-only census needs no value gather');
  }

  // --- stale edges (an option was deleted) are DROPPED, never repointed ---
  {
    const stale = migrateForHarness(buildTagCensusModel(['count_2']));
    // shrink the tag to two options: count_2 no longer exists.
    stale.agentAttributes.find(a => a.id === 'kind').tagOptions = ['Red', 'Green'];
    const { nodes, edges } = expandNeighbourCensus(stale.agentGraphNodes, stale.agentGraphEdges, stale);
    const types = nodes.map(n => n.data.nodeType);
    ok(!types.includes('groupCounting'), 'an out-of-range count port synthesizes nothing');
    ok(!edges.some(e => e.targetHandle === 'input_value_value' && nodes.every(n => n.id !== e.source)),
      'no edge is left pointing at a removed node');
  }

  // --- HOT-PATH NO-OP when the graph has no census node ---
  {
    const gol = migrateForHarness(JSON.parse(readFileSync(join(ROOT, 'public/models/Game of Life on Agents.gcaproj'), 'utf8')));
    const r = expandNeighbourCensus(gol.agentGraphNodes, gol.agentGraphEdges, gol);
    ok(r.nodes === gol.agentGraphNodes && r.edges === gol.agentGraphEdges,
      'the lowering returns the SAME arrays when no census node exists');
  }

  // --- BOTH agent-target gates accept a census model (the whole point of 2.3) ---
  {
    ok(isAgentGraphWasmSupported(model) === true, 'WASM gate accepts a census model');
    ok(isAgentGraphWebGPUSupported(model) === true, 'WebGPU gate accepts a census model');
    const js = compileAgentGraph(model.agentGraphNodes, model.agentGraphEdges, model, 0);
    ok(!js.error && js.behaviourCode.includes('_agentBondCount') && /_count/.test(js.behaviourCode),
      'JS emits the bonded gather + the counters', js.error || '');
    const w = compileAgentGraphWasmForModel(model);
    ok(!w.error && w.bytes.length > 0, 'WASM emits a module', w.error || '');
    const gpu = compileAgentGraphWebGPUForModel(model);
    ok(!gpu.error && gpu.shaderCode.length > 0 && gpu.usesBondStore === true,
      'WebGPU emits a shader that binds the bond store', gpu.error || '');
    // The synthesized comparison operand must reach the WGSL predicate (this is
    // exactly what the groupCounting operand-port fix restored).
    const compares = [...gpu.shaderCode.matchAll(/if \(_gcV\d+ == ([-\d.]+)\)/g)].map(x => x[1]).sort();
    ok(compares.length === 3 && compares.join(',') === '0.0,1.0,2.0',
      'WGSL compares against the three option indices', compares.join(','));
  }

  // --- the shipped sample gates in on all three targets ---
  {
    const lob = migrateForHarness(JSON.parse(readFileSync(join(ROOT, 'public/models/Life on Bonds.gcaproj'), 'utf8')));
    ok(isAgentGraphWasmSupported(lob) === true, 'Life on Bonds: WASM gate accepts');
    ok(isAgentGraphWebGPUSupported(lob) === true, 'Life on Bonds: WebGPU gate accepts');
    const gpu = compileAgentGraphWebGPUForModel(lob);
    ok(!gpu.error && gpu.shaderCode.length > 0, 'Life on Bonds: WebGPU shader emits', gpu.error || '');
  }
}

// ===========================================================================
// TIER C — the Conway oracles, through the real compiled behaviour
// ===========================================================================

const cbNum = (cfg, k, d) => { const v = cfg?.[k]; return typeof v === 'number' && Number.isFinite(v) ? v : d; };

/** Build a runner for an agent model: a store holding a W×H lattice of agents at
 *  integer-centred positions, the compiled JS behaviour, and a `step()` that
 *  mirrors the worker's sync prime → behaviour → swap. Optionally also
 *  instantiates the WASM module over a second (wasmBacked) store. */
async function makeRunner(rawModel, { W, H, withWasm = false } = {}) {
  const model = migrateForHarness(rawModel);
  const cfg = model.centerBased;
  const agentAttrs = agentAttrsOf(model);
  const specs = agentAttrs.map(a => ({ id: a.id, type: a.type, defaultValue: 0 }));
  const syncAttrs = cfg?.agentUpdateMode === 'sync';
  const D = 1, total = W * H;

  const jsR = compileAgentGraph(model.agentGraphNodes ?? [], model.agentGraphEdges ?? [], model, 0);
  if (jsR.error) throw new Error(`JS compile: ${jsR.error}`);
  // eslint-disable-next-line no-eval
  const jsFn = eval(jsR.behaviourCode);

  const wasmR = withWasm ? compileAgentGraphWasmForModel(model) : null;
  // P4: ONE request-queue stride for both stores (the worker ships one number to
  // every target), so the plain store cannot fall back to the config depth while
  // the wasmBacked one uses the usage-gated layout value.
  const layoutExtras = { ...buildAgentLayoutExtras(model), fieldTotal: 0, syncAttrs };
  const bondReqSlots = layoutExtras.bondReqSlots ?? 1;
  const stores = [];
  const A = createAgentStore(cfg, specs, { wasmBacked: false, syncAttrs, bondReqSlots });
  stores.push(A);
  let B = null, inst = null;
  if (withWasm && wasmR && !wasmR.error && wasmR.bytes.length) {
    B = createAgentStore(cfg, specs, { wasmBacked: true, syncAttrs, maxHashBins: wasmR.layout.maxHashBins, layoutExtras, bondReqSlots });
    stores.push(B);
  }
  for (const s of stores) { s.worldWidth = W; s.worldHeight = H; s.worldDepth = D; }

  const r = cbNum(cfg, 'defaultRadius', 0.45);
  const seedSpecs = [];
  for (let i = 0; i < W * H; i++) seedSpecs.push({ x: (i % W) + 0.5, y: Math.floor(i / W) + 0.5, radius: r });
  for (const s of stores) seedAgents(s, seedSpecs, r);
  if (B) inst = await instantiateAgentWasm(wasmR.bytes, B.memory);

  const torus = model.properties.boundaryTreatment === 'torus';
  const hashReserve = computeAgentMaxHashBins(W, H, D, cbNum(cfg, 'interactionRange', 1.5), r, cbNum(cfg, 'neighbourQueryRadius', 5));
  const binEdge = Math.max(1e-3, cbNum(cfg, 'interactionRange', 1.5) * 2 * r, cbNum(cfg, 'neighbourQueryRadius', 5));
  // Lookup Table model attributes ride the ABI's `_lookupTables` slot — the
  // worker fills it from `cachedInteractionTables`, so the harness must too or
  // every table read returns 0 and a table-driven test becomes VACUOUS.
  const lookupTables = {};
  for (const a of model.attributes) {
    if (a.isModelAttribute && a.type === 'lookupTable' && Array.isArray(a.tableData)) {
      lookupTables[a.id] = Float64Array.from(a.tableData);
    }
  }
  const hasLookupTables = Object.keys(lookupTables).length > 0;

  const rngState = new Uint32Array(1);
  const ctx = {
    hash: null, emptyI32: new Int32Array(0), modelAttrs: {}, viewer: '',
    indicators: new Float64Array(0), rngState, stopFlag: new Uint32Array(1),
    glyphCodes: new Uint32Array(1), glyphColors: new Uint32Array(1), lookupTables,
    width: W, height: H, total, torus, fieldArray: () => undefined,
  };
  const shape = { is3d: false, agentAttrs: A.attrSpecs, fieldAttrs: cellFieldAttrsOf(model), hasLookupTables };

  /** Form the 8 Moore bonds of the lattice (what auto-bond builds at run time). */
  const bondMoore = () => {
    for (const s of stores) {
      for (let i = 0; i < W * H; i++) {
        const cx = i % W, cy = Math.floor(i / W);
        for (const [dx, dy] of [[1, 0], [1, 1], [0, 1], [-1, 1]]) {
          const nx = ((cx + dx) % W + W) % W, ny = ((cy + dy) % H + H) % H;
          formBond(s, i, ny * W + nx, 1.0, 0);
        }
      }
    }
  };

  const step = () => {
    for (const s of stores) {
      s.forceX.fill(0, 0, s.highWater); s.forceY.fill(0, 0, s.highWater);
      s.divideRequest.fill(0); s.killRequest.fill(0); s.bondFormReq.fill(0); s.bondBreakReq.fill(0);
      if (syncAttrs) for (const sp of s.attrSpecs) { const rd = s.attrRead[sp.id], wr = s.attrWrite[sp.id]; if (rd !== wr) wr.set(rd); }
    }
    const hash = buildSpatialHash(A, binEdge, W, H, D, torus, hashReserve);
    ctx.hash = hash;
    rngState[0] = 0x1234abcd;
    jsFn(...buildAgentAbiArgs('loop', shape, A, ctx));
    if (B && inst) {
      const buf = B.memory.buffer, BL = B.layout;
      new Uint32Array(buf, BL.rngStateOffset, 1)[0] = 0x1234abcd;
      for (const id of Object.keys(BL.lookupTableOffset ?? {})) {
        const t = lookupTables[id];
        if (t) new Float64Array(buf, BL.lookupTableOffset[id], t.length).set(t);
      }
      let hv = 0, nx = 0, ny = 0, nz = 0, bx = 1, by = 1, bz = 1, ox = 0, oy = 0, oz = 0;
      if (hash) {
        hv = 1; nx = hash.nBinsX; ny = hash.nBinsY; nz = hash.nBinsZ;
        bx = hash.binSizeX; by = hash.binSizeY; bz = hash.binSizeZ;
        ox = hash.originX; oy = hash.originY; oz = hash.originZ;
        const nBins = nx * ny * nz;
        new Int32Array(buf, BL.hashBinStartOffset, nBins + 1).set(hash.binStart.subarray(0, nBins + 1));
        const used = hash.binStart[nBins];
        if (used > 0) new Int32Array(buf, BL.hashBinAgentsOffset, used).set(hash.binAgents.subarray(0, used));
      }
      inst.behaviour(B.highWater, hv, nx, ny, nz, bx, by, bz, W, H, D, torus ? 1 : 0, ox, oy, oz);
    }
    if (syncAttrs) {
      for (const sp of A.attrSpecs) { const t = A.attrRead[sp.id]; A.attrRead[sp.id] = A.attrWrite[sp.id]; A.attrWrite[sp.id] = t; }
      if (B) for (const sp of B.attrSpecs) B.attrRead[sp.id].set(B.attrWrite[sp.id]);
    }
  };

  return { model, A, B, step, bondMoore, W, H };
}

/** A deterministic soup identical for every model (a xorshift over the slot id). */
const soup = (n, density = 0.30) => {
  const out = new Uint8Array(n);
  let s = 0x2545f491;
  for (let i = 0; i < n; i++) {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    out[i] = (s / 0x100000000) < density ? 1 : 0;
  }
  return out;
};

/** The identity-rule model: census (ALL ports) → N-D Lookup Table (tag-valued,
 *  every entry = Idle) → Switch. Case 0 (Idle) is deliberately unwired; case 1
 *  WRITES `alive = true`, so "nothing changed" is evidence the table really did
 *  return Idle everywhere and the census+table+switch chain has no side effect. */
function buildIdentityRuleModel() {
  const g = mkGraphBuilder();
  const bs = g.n('behaviourStep', {});
  const census = g.n('neighbourCensus', { attributeId: 'alive', source: 'bonded' });
  const own = g.n('getCellAttribute', { attributeId: 'alive' });
  // NB the config key is `tableId` (not attributeId) and the Switch's flow input
  // is `check` (not `do`) — getting either wrong makes the whole chain inert,
  // which would render O3 vacuous. The negative control below is what proves the
  // chain is really live.
  const lut = g.n('lookupInteraction', { tableId: 'rule' });
  g.v(own, 'value', lut, 'axis_0');
  g.v(census, 'count_1', lut, 'axis_1');
  const sw = g.n('switch', { mode: 'value', valueType: 'integer', caseCount: 2, firstMatchOnly: true, _port_case_0_val: '0', _port_case_1_val: '1' });
  g.v(lut, 'value', sw, 'value');
  const setAlive = g.n('setAttribute', { attributeId: 'alive', _port_value: 'true' });
  g.f(bs, 'do', sw, 'check');
  g.f(sw, 'case_1', setAlive, 'do');   // case_0 (Idle) intentionally unwired
  const model = wrapModel('Identity Rule Test', g.nodes, g.edges, [
    { id: 'alive', name: 'alive', type: 'bool', defaultValue: 'false' },
  ]);
  model.attributes.push({
    id: 'rule', name: 'Rule', type: 'lookupTable', isModelAttribute: true, defaultValue: '0',
    axes: [
      { name: 'Own', source: { kind: 'intRange', min: 0, max: 1 } },
      { name: 'Alive nbrs', source: { kind: 'intRange', min: 0, max: 8 } },
    ],
    tableData: new Array(2 * 9).fill(0),           // every input → verb 0 = Idle
    valueType: 'tag', valueTagOptions: ['Idle', 'Divide', 'Die', 'Bond', 'Unbond', 'Rewire'],
  });
  return model;
}

async function tierC() {
  section('TIER C — the Conway oracles (headless, through the real compiled behaviour)');
  const W = 32, H = 32, N = W * H;

  const lobRaw = JSON.parse(readFileSync(join(ROOT, 'public/models/Life on Bonds.gcaproj'), 'utf8'));
  const golRaw = JSON.parse(readFileSync(join(ROOT, 'public/models/Game of Life on Agents.gcaproj'), 'utf8'));

  // ---- O7: differential vs the shipped proximity model ----
  {
    const lob = await makeRunner(lobRaw, { W, H, withWasm: true });
    const gol = await makeRunner(golRaw, { W, H });
    lob.bondMoore();

    // Bonds are pre-formed here (the harness plays the part of the structural
    // phase's auto-bond), so the topology bootstrap generation does not apply and
    // the two models are compared with NO offset.
    const seed = soup(N, 0.30);
    for (const run of [lob, gol]) {
      for (const s of [run.A, run.B].filter(Boolean)) {
        s.attrRead.alive.set(seed); s.attrWrite.alive.set(seed);
      }
    }
    const g0 = decodeAgentGraph(lob.A);
    ok(checkDegreeRegular(g0, 8) === null, 'O7 setup: every agent carries exactly 8 Moore bonds', String(checkDegreeRegular(g0, 8)));

    let diverged = -1, wasmDiverged = -1, invViolation = null, aliveTrace = [];
    for (let t = 1; t <= 200; t++) {
      lob.step(); gol.step();
      for (let i = 0; i < N; i++) {
        if (lob.A.attrRead.alive[i] !== gol.A.attrRead.alive[i]) { diverged = t; break; }
      }
      if (lob.B) for (let i = 0; i < N; i++) {
        if (lob.A.attrRead.alive[i] !== lob.B.attrRead.alive[i]) { wasmDiverged = t; break; }
      }
      const g = decodeAgentGraph(lob.A);
      invViolation = checkHandshake(g) ?? checkNoDangling(g) ?? checkCapacity(g);
      if (t % 50 === 0) aliveTrace.push(`${t}:${lob.A.attrRead.alive.reduce((a, b) => a + b, 0)}`);
      if (diverged > 0 || wasmDiverged > 0 || invViolation) break;
    }
    const alive = lob.A.attrRead.alive.reduce((a, b) => a + b, 0);
    ok(diverged === -1,
      `O7  census (bonded) == shipped Game of Life on Agents over 200 generations  [alive ${aliveTrace.join(' ')}]`,
      diverged > 0 ? `first divergence at generation ${diverged}` : '');
    ok(alive > 0 && alive < N, 'O7  the board is genuinely evolving (not dead, not saturated)', `alive=${alive}`);
    ok(wasmDiverged === -1, 'O7  JS↔WASM bit-identical for the census model over the same run',
      wasmDiverged > 0 ? `diverged at generation ${wasmDiverged}` : '');
    ok(invViolation === null, 'O7  I1 + I3 + I4 hold at EVERY generation of the run', String(invViolation));

    // Negative control for the differential itself: perturb one cell and confirm
    // the comparison notices (a comparison that can never fail proves nothing).
    gol.A.attrRead.alive[123] ^= 1;
    let noticed = false;
    for (let i = 0; i < N; i++) if (lob.A.attrRead.alive[i] !== gol.A.attrRead.alive[i]) { noticed = true; break; }
    ok(noticed, 'O7  negative control: a single-cell perturbation IS detected');
  }

  // ---- O11: the Conway pattern oracles ----
  {
    const place = (run, cells) => {
      const a = new Uint8Array(N);
      for (const [x, y] of cells) a[((y % H) + H) % H * W + ((x % W) + W) % W] = 1;
      for (const s of [run.A, run.B].filter(Boolean)) { s.attrRead.alive.set(a); s.attrWrite.alive.set(a); }
      return a;
    };
    const snap = (run) => Array.from(run.A.attrRead.alive).join('');
    const cellsOf = (run) => {
      const out = [];
      for (let i = 0; i < N; i++) if (run.A.attrRead.alive[i]) out.push([i % W, Math.floor(i / W)]);
      return out;
    };

    const run = await makeRunner(lobRaw, { W, H });
    run.bondMoore();

    // block — a still life
    place(run, [[4, 4], [5, 4], [4, 5], [5, 5]]);
    const block0 = snap(run);
    let stable = true;
    for (let t = 0; t < 50; t++) { run.step(); if (snap(run) !== block0) { stable = false; break; } }
    ok(stable, 'O11 block is stable for 50 generations');

    // blinker — period exactly 2
    place(run, [[10, 10], [11, 10], [12, 10]]);
    const b0 = snap(run);
    run.step(); const b1 = snap(run);
    run.step(); const b2 = snap(run);
    ok(b1 !== b0 && b2 === b0, 'O11 blinker has period exactly 2');

    // toad — period exactly 2
    place(run, [[20, 20], [21, 20], [22, 20], [19, 21], [20, 21], [21, 21]]);
    const t0 = snap(run);
    run.step(); const t1 = snap(run);
    run.step(); const t2 = snap(run);
    ok(t1 !== t0 && t2 === t0, 'O11 toad has period exactly 2');

    // glider — returns to its shape translated by (1,1) after exactly 4 gens
    const gliderCells = [[1, 0], [2, 1], [0, 2], [1, 2], [2, 2]];
    place(run, gliderCells.map(([x, y]) => [x + 12, y + 4]));
    const norm = (cs) => {
      const mx = Math.min(...cs.map(c => c[0])), my = Math.min(...cs.map(c => c[1]));
      return cs.map(([x, y]) => `${x - mx},${y - my}`).sort().join(' ');
    };
    const shape0 = norm(cellsOf(run));
    const origin0 = [Math.min(...cellsOf(run).map(c => c[0])), Math.min(...cellsOf(run).map(c => c[1]))];
    for (let t = 0; t < 4; t++) run.step();
    const cells4 = cellsOf(run);
    const shape4 = norm(cells4);
    const origin4 = [Math.min(...cells4.map(c => c[0])), Math.min(...cells4.map(c => c[1]))];
    ok(shape4 === shape0, 'O11 glider returns to its shape after exactly 4 generations', `${shape0} vs ${shape4}`);
    ok(origin4[0] - origin0[0] === 1 && origin4[1] - origin0[1] === 1,
      'O11 glider translated by exactly (1,1) after 4 generations', `Δ=(${origin4[0] - origin0[0]},${origin4[1] - origin0[1]})`);
  }

  // ---- O3: the identity rule mutates nothing ----
  {
    const idModel = buildIdentityRuleModel();
    ok(isAgentGraphWasmSupported(migrateForHarness(idModel)) === true, 'O3  identity-rule model gates in on WASM');
    const run = await makeRunner(idModel, { W: 16, H: 16, withWasm: true });
    run.bondMoore();
    const n16 = 16 * 16;
    const seed = soup(n16, 0.35);
    for (const s of [run.A, run.B].filter(Boolean)) { s.attrRead.alive.set(seed); s.attrWrite.alive.set(seed); }
    const g0 = decodeAgentGraph(run.A);
    const e0 = g0.bondCount.reduce((a, b) => a + b, 0) / 2;

    let mutated = -1, requested = -1;
    for (let t = 1; t <= 100; t++) {
      run.step();
      for (let i = 0; i < n16; i++) if (run.A.attrRead.alive[i] !== seed[i]) { mutated = t; break; }
      const anyReq = run.A.divideRequest.some(v => v) || run.A.killRequest.some(v => v)
        || run.A.bondFormReq.some(v => v) || run.A.bondBreakReq.some(v => v);
      if (anyReq) { requested = t; break; }
      if (mutated > 0) break;
    }
    const g1 = decodeAgentGraph(run.A);
    const e1 = g1.bondCount.reduce((a, b) => a + b, 0) / 2;
    ok(mutated === -1, 'O3  every agent state is bit-identical after 100 generations of the Idle table',
      mutated > 0 ? `first mutation at generation ${mutated}` : '');
    ok(requested === -1, 'O3  no structural request is ever raised', requested > 0 ? `at generation ${requested}` : '');
    ok(g1.highWater === g0.highWater && e1 === e0, 'O3  N and E are unchanged', `N ${g0.highWater}->${g1.highWater}, E ${e0}->${e1}`);
    if (run.B) {
      let d = false;
      for (let i = 0; i < n16; i++) if (run.A.attrRead.alive[i] !== run.B.attrRead.alive[i]) { d = true; break; }
      ok(!d, 'O3  JS↔WASM agree on the identity run');
    }
    // Negative control: flip the table to verb 1 and the SAME graph must mutate.
    const mut = buildIdentityRuleModel();
    mut.attributes.find(a => a.id === 'rule').tableData = new Array(2 * 9).fill(1);
    const run2 = await makeRunner(mut, { W: 16, H: 16 });
    run2.bondMoore();
    run2.A.attrRead.alive.set(seed); run2.A.attrWrite.alive.set(seed);
    run2.step();
    let changed = false;
    for (let i = 0; i < n16; i++) if (run2.A.attrRead.alive[i] !== seed[i]) { changed = true; break; }
    ok(changed, 'O3  negative control: a non-Idle table DOES mutate the same graph');
  }

  // ---- the `nearby` census source compiles + counts ----
  {
    const g = mkGraphBuilder();
    const bs = g.n('behaviourStep', {});
    const census = g.n('neighbourCensus', { attributeId: 'alive', source: 'nearby', _port_radius: '1.5' });
    const set = g.n('setAttribute', { attributeId: 'n' });
    g.v(census, 'count_1', set, 'value');
    g.f(bs, 'do', set, 'do');
    const nearbyModel = wrapModel('Census Nearby Test', g.nodes, g.edges, [
      { id: 'alive', name: 'alive', type: 'bool', defaultValue: 'false' },
      { id: 'n', name: 'n', type: 'integer', defaultValue: '0' },
    ], { agentCapabilities: AGENT_CAPS({ bonds: 'off' }) });
    ok(isAgentGraphWasmSupported(migrateForHarness(nearbyModel)) === true, 'nearby census gates in on WASM');
    ok(isAgentGraphWebGPUSupported(migrateForHarness(nearbyModel)) === true, 'nearby census gates in on WebGPU');
    const run = await makeRunner(nearbyModel, { W: 16, H: 16, withWasm: true });
    const seed = soup(256, 0.4);
    for (const s of [run.A, run.B].filter(Boolean)) { s.attrRead.alive.set(seed); s.attrWrite.alive.set(seed); }
    run.step();
    // Independent recount of the Moore ring from the seed.
    let bad = -1;
    for (let i = 0; i < 256; i++) {
      const cx = i % 16, cy = Math.floor(i / 16);
      let want = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        want += seed[(((cy + dy) % 16 + 16) % 16) * 16 + (((cx + dx) % 16 + 16) % 16)];
      }
      if (run.A.attrRead.n[i] !== want) { bad = i; break; }
    }
    ok(bad === -1, 'nearby census counts the Moore ring exactly (independent recount)',
      bad >= 0 ? `agent ${bad}: got ${run.A.attrRead.n[bad]}` : '');
    if (run.B) {
      let d = false;
      for (let i = 0; i < 256; i++) if (run.A.attrRead.n[i] !== run.B.attrRead.n[i]) { d = true; break; }
      ok(!d, 'nearby census: JS↔WASM bit-identical');
    }
  }
}

// ===========================================================================
// TIER D — BOND ATTRIBUTES (P2): the compaction audit + I2 through the REAL engine
// ===========================================================================
//
// The phase's highest-risk edit is COMPACTION LOCKSTEP: `removeBondSlot` (used by
// Break Bond AND death) and `sweepStaleBonds` both swap-with-last across every
// ragged bond field. A field added to the store but missed in EITHER path corrupts
// silently on the first bond removal — an attribute ends up associated with the
// WRONG partner, and nothing errors.
//
// So this audit does NOT test internal consistency alone (a swap that moves both
// sides consistently-but-wrongly would pass I2). It runs the real engine against an
// INDEPENDENT truth map keyed by the unordered pair, and asserts after EVERY
// generation that the store's bond attributes match the truth for every live bond,
// on BOTH sides, with the edge sets identical.

const BOND_ATTR_SPECS = [
  { id: 'w', type: 'float', defaultValue: 0 },       // f64 region
  { id: 'lbl', type: 'integer', defaultValue: 0 },   // i32 region
  { id: 'flag', type: 'bool', defaultValue: 0 },     // i32 region (bond bools are i32)
];

function bondCfg(maxAgents, maxBonds) {
  return {
    enabled: true, maxAgents, maxBonds, worldWidth: 64, worldHeight: 64,
    seedCount: 0, defaultRadius: 0.5, growthRate: 0, repulsionStiffness: 0,
    adhesionStiffness: 0, interactionRange: 1.5, drag: 1, timeStep: 0.5,
    momentum: 0, maxSpeed: 0, neighbourQueryRadius: 2, customForcesOnly: true,
    useBondingPhysics: false, autoBond: false, bondStiffness: 0, bondRestLength: 1,
    agentCapabilities: AGENT_CAPS({ bonds: 'physics' }),
  };
}

/** Read a live store into the normalised graph view, including bond attributes. */
function storeGraph(s) {
  return decodeAgentGraph({
    highWater: s.highWater, maxBonds: s.maxBonds, alive: s.alive,
    bondCount: s.bondCount, bondPartner: s.bondPartner,
    bondRestLength: s.bondRestLength, bondStiffness: s.bondStiffness,
    bondTypeLabel: s.bondTypeLabel, bondAttrs: s.bondAttrs,
  });
}

/** Compare the store's live bonds against the truth map. Returns null or a msg. */
function auditAgainstTruth(s, truth) {
  const mb = s.maxBonds;
  let seen = 0;
  for (let i = 0; i < s.highWater; i++) {
    if (!s.alive[i]) continue;
    for (let k = 0; k < s.bondCount[i]; k++) {
      const p = s.bondPartner[i * mb + k];
      if (p < 0 || p >= s.highWater || !s.alive[p]) return `agent ${i} slot ${k}: dangling partner ${p}`;
      const key = i < p ? `${i}:${p}` : `${p}:${i}`;
      const t = truth.get(key);
      if (!t) return `bond ${i}↔${p} exists in the store but NOT in the truth map`;
      if (i < p) seen++;
      for (const spec of BOND_ATTR_SPECS) {
        const got = s.bondAttrs[spec.id][i * mb + k];
        if (!Object.is(got, t[spec.id])) {
          return `bond ${i}↔${p} (side ${i}): ${spec.id} = ${got}, truth ${t[spec.id]}`;
        }
      }
      if (!Object.is(s.bondRestLength[i * mb + k], t.L)) return `bond ${i}↔${p}: restLength drift`;
    }
  }
  if (seen !== truth.size) return `store has ${seen} live bonds, truth has ${truth.size}`;
  return null;
}

function tierD() {
  section('TIER D — bond attributes: compaction lockstep + I2 (real engine)');

  // --- the store actually allocates the regions ---
  {
    const s = createAgentStore(bondCfg(16, 4), [], { bondAttrSpecs: BOND_ATTR_SPECS });
    ok(!!s.bondAttrs && Object.keys(s.bondAttrs).length === 3, 'store allocates one ragged region per bond attribute');
    ok(s.bondAttrs.w instanceof Float64Array && s.bondAttrs.lbl instanceof Int32Array && s.bondAttrs.flag instanceof Int32Array,
      'bond attribute regions are typed by kind (float→f64, integer/bool/tag→i32)');
    ok(s.bondAttrs.w.length === 16 * 4, 'bond attribute regions are ragged (maxAgents × maxBonds)', String(s.bondAttrs.w.length));
    ok(bondAttrKind('float') === 'float64' && bondAttrKind('bool') === 'int32'
      && bondAttrKind('tag') === 'int32' && bondAttrKind('integer') === 'int32', 'bondAttrKind maps the four allowed types');
    // Bonds OFF ⇒ maxBonds 0 ⇒ zero bond-attribute bytes (handoff assumption 2).
    const off = createAgentStore({ ...bondCfg(16, 4), agentCapabilities: AGENT_CAPS({ bonds: 'off' }) }, [], { bondAttrSpecs: BOND_ATTR_SPECS });
    ok(off.maxBonds === 0 && off.bondAttrSpecs.length === 0 && Object.keys(off.bondAttrs).length === 0,
      'bonds=off allocates ZERO bond-attribute bytes (no specs, no regions)');
    ok(off.bondSlotArrays.length === 5, 'bonds=off leaves the compaction field list at the five built-ins');
  }

  // --- formBond writes initial values to BOTH sides ---
  {
    const s = createAgentStore(bondCfg(8, 4), [], { bondAttrSpecs: BOND_ATTR_SPECS });
    seedAgents(s, Array.from({ length: 4 }, (_, i) => ({ x: i, y: 0 })), 0.5);
    formBond(s, 0, 2, 1.5, 0.25, 7, [3.5, 42, 1]);
    const mb = s.maxBonds;
    ok(s.bondAttrs.w[0 * mb] === 3.5 && s.bondAttrs.lbl[0 * mb] === 42 && s.bondAttrs.flag[0 * mb] === 1,
      'formBond writes the initial attribute values on side A');
    ok(s.bondAttrs.w[2 * mb] === 3.5 && s.bondAttrs.lbl[2 * mb] === 42 && s.bondAttrs.flag[2 * mb] === 1,
      'formBond writes the SAME values on side B (I2 by construction)');
    formBond(s, 1, 3, 1, 0);   // no attr values → the spec defaults
    ok(s.bondAttrs.w[1 * mb] === 0 && s.bondAttrs.lbl[1 * mb] === 0, 'formBond without values uses the attribute defaults');
    ok(checkBondSymmetry(storeGraph(s)) === null, 'I2 holds after formBond');
  }

  // --- THE COMPACTION AUDIT: 500 generations of random form / break / death /
  //     stale-sweep against an independent truth map ---
  {
    const N = 40, MB = 6;
    const s = createAgentStore(bondCfg(N + 16, MB), [], { bondAttrSpecs: BOND_ATTR_SPECS });
    seedAgents(s, Array.from({ length: N }, (_, i) => ({ x: (i % 8) * 2, y: Math.floor(i / 8) * 2 })), 0.5);
    const truth = new Map();
    const key = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);
    // Deterministic PRNG so a failure is reproducible.
    let rs = 0x9e3779b9;
    const rnd = () => { rs ^= rs << 13; rs >>>= 0; rs ^= rs >>> 17; rs ^= rs << 5; rs >>>= 0; return rs / 0x100000000; };
    const pick = () => Math.floor(rnd() * s.highWater);

    let firstFail = null, gens = 0, forms = 0, breaks = 0, deaths = 0, divisions = 0, stales = 0;
    let sweptSlots = 0;
    for (let gen = 0; gen < 500 && firstFail === null; gen++) {
      gens++;
      // 1. form a few random bonds with random attribute values
      for (let t = 0; t < 5; t++) {
        const a = pick(), b = pick();
        if (a === b || !s.alive[a] || !s.alive[b]) continue;
        const vals = [Math.round(rnd() * 1000) / 8, (gen * 7 + t) | 0, rnd() < 0.5 ? 1 : 0];
        const L = 1 + Math.round(rnd() * 100) / 16;
        if (formBond(s, a, b, L, 0, 0, vals)) {
          truth.set(key(a, b), { w: vals[0], lbl: vals[1], flag: vals[2], L });
          forms++;
        }
      }
      // 2. break a few random existing bonds
      for (let t = 0; t < 3; t++) {
        const a = pick();
        if (!s.alive[a] || s.bondCount[a] === 0) continue;
        const k = Math.floor(rnd() * s.bondCount[a]);
        const b = s.bondPartner[a * MB + k];
        if (b < 0) continue;
        breakBond(s, a, b);
        truth.delete(key(a, b));
        breaks++;
      }
      // 3. occasionally kill an agent (freeAgentSlot → breakAllBonds → compaction
      //    on EVERY partner's list) and spawn a replacement so the graph churns
      //    through recycled slots (the epoch mechanism + the stale sweep).
      if (gen % 7 === 3) {
        const a = pick();
        if (s.alive[a]) {
          for (const k2 of [...truth.keys()]) {
            const [x, y] = k2.split(':').map(Number);
            if (x === a || y === a) truth.delete(k2);
          }
          freeAgentSlot(s, a);
          deaths++;
          const nid = allocAgentSlot(s);
          if (nid >= 0) initAgentSlot(s, nid, rnd() * 16, rnd() * 16, 0, 0.5, nid);
        }
      }
      // 3b. occasionally induce STALE bonds — mark an agent dead WITHOUT cleaning
      //     its partners' lists (a raw epoch bump). This is the exact condition
      //     `sweepStaleBonds` exists for, and the ONLY way to exercise its own
      //     swap-with-last: `freeAgentSlot` already removes the agent from every
      //     partner's list, so a normal death leaves nothing stale. Without this
      //     the THIRD compaction path is never executed and a missed field there
      //     goes undetected (verified: the negative control did not trip until
      //     this step existed).
      if (gen % 11 === 5) {
        const a = pick();
        if (s.alive[a] && s.bondCount[a] > 0) {
          for (const k2 of [...truth.keys()]) {
            const [x, y] = k2.split(':').map(Number);
            if (x === a || y === a) truth.delete(k2);
          }
          s.alive[a] = 0;
          s.epoch[a] = (s.epoch[a] + 1) | 0;
          stales++;
        }
      }
      // 4. occasionally divide — daughters INHERIT their partitioned bonds'
      //    attributes unchanged (P2 scope; P5 adds explicit per-bond assignment).
      if (gen % 23 === 11) {
        const a = pick();
        if (s.alive[a] && s.bondCount[a] > 0) {
          const before = new Map();   // partner id → the mother's attribute values
          for (let k = 0; k < s.bondCount[a]; k++) {
            const p = s.bondPartner[a * MB + k];
            before.set(p, BOND_ATTR_SPECS.map(sp => s.bondAttrs[sp.id][a * MB + k]));
          }
          const nid = divideAgent(s, a, 0, 0, 0, 0, 0, false, 64, 64, 1);
          if (nid >= 0) {
            divisions++;
            // INHERITANCE assertion: wherever a partner's bond ended up (daughter A
            // = the mother slot, or daughter B = the new slot), it must still carry
            // the mother's values.
            for (const [p, vals] of before) {
              if (!s.alive[p]) continue;
              for (const owner of [a, nid]) {
                for (let k = 0; k < s.bondCount[owner]; k++) {
                  if (s.bondPartner[owner * MB + k] !== p) continue;
                  BOND_ATTR_SPECS.forEach((sp, si) => {
                    if (!Object.is(s.bondAttrs[sp.id][owner * MB + k], vals[si]) && firstFail === null) {
                      firstFail = `gen ${gen}: division dropped ${sp.id} from the inherited bond ${owner}↔${p} (got ${s.bondAttrs[sp.id][owner * MB + k]}, want ${vals[si]})`;
                    }
                  });
                }
              }
            }
            // Re-sync the truth map from the store for every bond touching either
            // daughter (division re-partitions bonds by GEOMETRY and adds a
            // daughter–daughter bond with the attribute defaults — engine-owned
            // bookkeeping the truth map cannot predict, but the inheritance check
            // above already pinned the VALUES).
            for (const [p] of before) truth.delete(key(a, p));
            for (const owner of [a, nid]) {
              for (let k = 0; k < s.bondCount[owner]; k++) {
                const p = s.bondPartner[owner * MB + k];
                if (p < 0) continue;
                truth.set(key(owner, p), {
                  w: s.bondAttrs.w[owner * MB + k], lbl: s.bondAttrs.lbl[owner * MB + k],
                  flag: s.bondAttrs.flag[owner * MB + k], L: s.bondRestLength[owner * MB + k],
                });
              }
            }
          }
        }
      }
      // 5. the THIRD compaction path — the per-step stale sweep
      {
        let before = 0;
        for (let i = 0; i < s.highWater; i++) if (s.alive[i]) before += s.bondCount[i];
        sweepStaleBonds(s);
        let after = 0;
        for (let i = 0; i < s.highWater; i++) if (s.alive[i]) after += s.bondCount[i];
        sweptSlots += before - after;
      }

      // --- audit EVERY generation ---
      const g = storeGraph(s);
      const v = firstFail
        ?? checkHandshake(g) ?? checkNoDangling(g) ?? checkCapacity(g)
        ?? checkBondSymmetry(g) ?? auditAgainstTruth(s, truth);
      if (v) firstFail = `gen ${gen}: ${v}`;
    }
    ok(firstFail === null, `compaction audit: 500 gens of form/break/death/division/sweep — attributes never desync`, String(firstFail));
    ok(forms > 200 && breaks > 100 && deaths > 40 && divisions > 10 && truth.size > 0,
      `the audit actually churned the graph (${forms} forms, ${breaks} breaks, ${deaths} deaths, ${divisions} divisions, ${truth.size} live bonds after ${gens} gens)`);
    // COVERAGE of the third compaction path: without swept slots the stale sweep's
    // own swap-with-last is never executed and a missed field there is invisible.
    ok(stales > 20 && sweptSlots > 40,
      `the stale sweep actually compacted (${stales} induced-stale agents, ${sweptSlots} slots swept)`);
  }

  // --- PERSISTENCE: a bonded population with bond attributes must round-trip
  //     bit-exact through BOTH layers — the engine payload (`getState`) and the
  //     base64 `.gcaproj` / `.gcastate` encoding. The `.gcastate` layer needs an
  //     EXPLICIT arm for the nested `bondAttrs` record (the "field-name-generic"
  //     sweep only reaches TOP-LEVEL ArrayBuffer properties — handoff assumption 4).
  {
    const src = createAgentStore(bondCfg(12, 4), [], { bondAttrSpecs: BOND_ATTR_SPECS });
    seedAgents(src, Array.from({ length: 8 }, (_, i) => ({ x: i, y: 0 })), 0.5);
    formBond(src, 0, 1, 1, 0, 0, [1.25, 7, 1]);
    formBond(src, 1, 2, 2, 0, 0, [-3.5, -9, 0]);
    formBond(src, 2, 5, 3, 0, 0, [99.0625, 123456, 1]);
    breakBond(src, 1, 2);   // compact first, so the round-trip carries moved slots
    const transfers = [];
    const payload = serializeAgentStore(src, transfers);
    ok(!!payload.bondAttrs && Object.keys(payload.bondAttrs).length === 3,
      'getState payload carries one ragged buffer per bond attribute');

    const dst = createAgentStore(bondCfg(12, 4), [], { bondAttrSpecs: BOND_ATTR_SPECS });
    deserializeAgentStore(dst, payload);
    const cmp = (a, b) => {
      for (let i = 0; i < a.highWater; i++) {
        if (a.alive[i] !== b.alive[i] || a.bondCount[i] !== b.bondCount[i]) return `agent ${i}: liveness/degree differs`;
        for (let k = 0; k < a.bondCount[i]; k++) {
          const s1 = i * a.maxBonds + k;
          if (a.bondPartner[s1] !== b.bondPartner[s1]) return `agent ${i} slot ${k}: partner differs`;
          for (const spec of BOND_ATTR_SPECS) {
            if (!Object.is(a.bondAttrs[spec.id][s1], b.bondAttrs[spec.id][s1])) {
              return `agent ${i} slot ${k}: ${spec.id} ${a.bondAttrs[spec.id][s1]} !== ${b.bondAttrs[spec.id][s1]}`;
            }
          }
        }
      }
      return null;
    };
    ok(cmp(src, dst) === null, 'engine round-trip: every bond attribute value is bit-exact', String(cmp(src, dst)));

    // .gcaproj / .gcastate: the base64 encode/decode pair.
    const transfers2 = [];
    const payload2 = serializeAgentStore(src, transfers2);
    const encoded = serializeAgentState(payload2);
    ok(!!encoded.bondAttrs && Object.keys(encoded.bondAttrs).length === 3,
      '.gcastate encodes one base64 buffer per bond attribute');
    const decoded = deserializeAgentState(encoded);
    const dst2 = createAgentStore(bondCfg(12, 4), [], { bondAttrSpecs: BOND_ATTR_SPECS });
    deserializeAgentStore(dst2, decoded);
    ok(cmp(src, dst2) === null, '.gcastate base64 round-trip: every bond attribute value is bit-exact', String(cmp(src, dst2)));

    // A pre-P2 payload (no bondAttrs) must load cleanly at the DEFAULTS, never
    // inheriting a previous run's values on live slots.
    const legacy = { ...serializeAgentStore(src, []) };
    delete legacy.bondAttrs;
    const dst3 = createAgentStore(bondCfg(12, 4), [], { bondAttrSpecs: BOND_ATTR_SPECS });
    formBond(dst3, 3, 4, 1, 0, 0, [42, 42, 1]);   // pre-existing values to be cleared
    deserializeAgentStore(dst3, legacy);
    let stale = false;
    for (const spec of BOND_ATTR_SPECS) {
      for (let i = 0; i < dst3.bondAttrs[spec.id].length; i++) {
        if (dst3.bondAttrs[spec.id][i] !== spec.defaultValue) { stale = true; break; }
      }
    }
    ok(!stale, 'a pre-P2 payload (no bondAttrs) resets every bond attribute to its default');
  }

  // --- THE WEBGPU CAPABILITY GATE: P2 REJECTED a bond-attribute model at model
  //     level; P3 LIFTED that (see Tier F), so both gates must now accept it.
  {
    const g = mkGraphBuilder();
    const bs = g.n('behaviourStep', {});
    const feb = g.n('forEachBond', {});
    const gba = g.n('getBondAttribute', { attributeId: 'w' });
    const set = g.n('setAttribute', { attributeId: 'acc' });
    g.f(bs, 'do', feb, 'do');
    g.f(feb, 'body', set, 'do');
    g.v(feb, 'partnerId', gba, 'partnerId');
    g.v(gba, 'value', set, 'value');
    const withBond = migrateForHarness(wrapModel('Bond Attr Gate Test', g.nodes, g.edges, [
      { id: 'acc', name: 'Acc', type: 'float', defaultValue: '0' },
    ]));
    withBond.bondAttributes = [{ id: 'w', name: 'W', type: 'float', defaultValue: '0' }];
    ok(bondAttrsOf(withBond).length === 1, 'bondAttrsOf resolves the declared bond attribute');
    ok(isAgentGraphWasmSupported(withBond) === true, 'WASM gate ACCEPTS a bond-attribute model');
    ok(isAgentGraphWebGPUSupported(withBond) === true, 'WebGPU gate ACCEPTS a bond-attribute model (P3 lifted P2‘s model-level reject)');
    const w = compileAgentGraphWasmForModel(withBond);
    ok(!w.error && w.bytes.length > 0, 'the bond-attribute model compiles to WASM', w.error || '');
    // Bonds OFF ⇒ bondAttrsOf is empty ⇒ nothing to reject, so the gate is free again.
    const bondsOff = migrateForHarness(wrapModel('Bonds Off', mkGraphBuilder().nodes, [], []));
    bondsOff.agentGraphNodes = [{ id: 'bs0', type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: 'behaviourStep', config: {} } }];
    bondsOff.bondAttributes = [{ id: 'w', name: 'W', type: 'float', defaultValue: '0' }];
    bondsOff.centerBased.agentCapabilities = AGENT_CAPS({ bonds: 'off' });
    bondsOff.centerBased.autoBond = false;
    ok(bondAttrsOf(bondsOff).length === 0, 'bonds=off ⇒ bondAttrsOf is EMPTY (no regions, no ABI fields, no gate rejection)');
  }

  // --- NEGATIVE CONTROL for the audit itself: simulate the exact bug the phase
  //     risks (a compaction that moves bondPartner but leaves an attribute) and
  //     prove the audit catches it. A harness that only ever passes proves nothing.
  {
    const s = createAgentStore(bondCfg(8, 4), [], { bondAttrSpecs: BOND_ATTR_SPECS });
    seedAgents(s, Array.from({ length: 4 }, (_, i) => ({ x: i, y: 0 })), 0.5);
    const truth = new Map();
    formBond(s, 0, 1, 1, 0, 0, [1.5, 11, 0]); truth.set('0:1', { w: 1.5, lbl: 11, flag: 0, L: 1 });
    formBond(s, 0, 2, 2, 0, 0, [2.5, 22, 1]); truth.set('0:2', { w: 2.5, lbl: 22, flag: 1, L: 2 });
    ok(auditAgainstTruth(s, truth) === null, 'audit passes on a correct two-bond store');
    // The bug: agent 0 drops slot 0 by moving ONLY bondPartner from the last slot.
    const mb = s.maxBonds;
    s.bondPartner[0 * mb + 0] = s.bondPartner[0 * mb + 1];
    s.bondCount[0] = 1;
    // (bond 0↔1 is still in agent 1's list, so the truth map keeps it too.)
    ok(auditAgainstTruth(s, truth) !== null, 'audit negative control: a partner-only compaction swap is CAUGHT');
    ok(checkBondSymmetry(storeGraph(s)) !== null, 'I2 negative control (real store): the same bug is CAUGHT by symmetry');
  }
}

// ===========================================================================
// TIER E — PX: `agentUpdateMode: 'sync'` is double-buffered on the WebGPU target
// ===========================================================================
//
// GPU threads run in parallel and in an unspecified order, so ONE run per agent
// attribute means agent A's write is visible to agent B's read WITHIN one
// dispatch — async semantics silently applied to a synchronous model. Measured
// before the fix: the shipped Game of Life on Agents was wrong by 32-123 of 1024
// cells against a Conway reference, VARYING run to run (the variation was the
// race), while JS and WASM were exact.
//
// The fix is a second run per attribute (`agentAttrWriteBase`) + a per-generation
// commit pass. This tier pins BOTH halves at the shader level: every attribute
// READ resolves the read base and every WRITE the write base, so the two are
// DISJOINT under sync — and ALIASED under async, which is what keeps every
// existing agent model byte-identical.
//
// The negative control compiles the SAME sync model against a deliberately
// aliased (pre-PX) layout and asserts the disjointness check FAILS: a harness
// that could not detect the race would prove nothing.

/** Split a WGSL body into the `agentF32` element offsets it WRITES vs READS.
 *  A write is `agentF32[<N>u + <expr>] =` (an assignment target, not `==`). */
function agentF32Offsets(wgsl) {
  const writes = new Set(), reads = new Set();
  const WRITE_RE = /agentF32\[(\d+)u \+ [^\]]*\]\s*=(?!=)/g;
  let mt;
  while ((mt = WRITE_RE.exec(wgsl)) !== null) writes.add(Number(mt[1]));
  // Reads = every occurrence that is NOT an assignment target.
  const stripped = wgsl.replace(WRITE_RE, ' ');
  const READ_RE = /agentF32\[(\d+)u \+ /g;
  while ((mt = READ_RE.exec(stripped)) !== null) reads.add(Number(mt[1]));
  return { writes, reads };
}

function tierE() {
  section('TIER E — PX: sync agent attributes are double-buffered on WebGPU');

  const shipped = () => migrateForHarness(JSON.parse(readFileSync(join(ROOT, 'public/models/Game of Life on Agents.gcaproj'), 'utf8')));
  const sync = shipped();
  const async_ = shipped();
  async_.centerBased.agentUpdateMode = 'async';
  ok(sync.centerBased.agentUpdateMode === 'sync', 'the shipped Game of Life on Agents is a SYNC model');

  const rSync = compileAgentGraphWebGPUForModel(sync);
  const rAsync = compileAgentGraphWebGPUForModel(async_);
  const Ls = rSync.layout, La = rAsync.layout;
  const attr = Ls.agentAttrIds[0];

  // --- the layout ---
  ok(Ls.syncAttrs === true && La.syncAttrs === false,
    'the layout carries syncAttrs from the model update mode', `${Ls.syncAttrs} / ${La.syncAttrs}`);
  ok(Ls.agentAttrWriteBase[attr] !== Ls.agentAttrBase[attr],
    'SYNC: the attribute write run is DISTINCT from the read run',
    `${Ls.agentAttrBase[attr]} vs ${Ls.agentAttrWriteBase[attr]}`);
  ok(La.agentAttrWriteBase[attr] === La.agentAttrBase[attr],
    'ASYNC: the write base ALIASES the read base (zero extra bytes)');
  ok(Ls.f32Len - La.f32Len === Ls.agentAttrIds.length * Ls.maxAgents,
    'SYNC grows the SoA by exactly one extra run per attribute',
    `${La.f32Len} -> ${Ls.f32Len} (+${Ls.agentAttrIds.length * Ls.maxAgents})`);
  ok(Ls.agentAttrWriteBase[attr] === Ls.agentAttrBase[attr] + Ls.maxAgents,
    'the read and write blocks are CONTIGUOUS and in the same attribute order (the commit pass is one linear copy)');

  // --- the emitted shader: reads on the read run, writes on the write run ---
  {
    const { writes, reads } = agentF32Offsets(rSync.shaderCode);
    const rb = Ls.agentAttrBase[attr], wb = Ls.agentAttrWriteBase[attr];
    ok(reads.has(rb), 'SYNC shader: the attribute is READ at the read base', String(rb));
    ok(writes.has(wb), 'SYNC shader: the attribute is WRITTEN at the write base', String(wb));
    ok(!writes.has(rb),
      'SYNC shader: NOTHING writes the read run — a neighbour read can never see this generation',
      `writes=${[...writes].join(',')}`);
    ok(!reads.has(wb), 'SYNC shader: nothing reads the write run', `reads=${[...reads].join(',')}`);
  }
  {
    const { writes, reads } = agentF32Offsets(rAsync.shaderCode);
    const b = La.agentAttrBase[attr];
    ok(reads.has(b) && writes.has(b),
      'ASYNC shader: the attribute is read AND written at the same (aliased) base — the historical single-buffer emit');
  }

  // --- NEGATIVE CONTROL: the pre-PX aliased layout must FAIL the check ---
  {
    const extras = { ...agentWebGPUExtrasOf(sync), syncAttrs: false };   // force the OLD aliased layout
    const bad = computeAgentWebGPULayout(Ls.maxAgents, Ls.maxHashBins, undefined, Ls.agentAttrIds, extras);
    const r = compileAgentGraphWebGPU(sync.agentGraphNodes, sync.agentGraphEdges, sync, bad);
    const { writes, reads } = agentF32Offsets(r.shaderCode);
    const rb = bad.agentAttrBase[attr];
    ok(!r.error && writes.has(rb) && reads.has(rb),
      'negative control: with the write run aliased (pre-PX), the SAME run is read AND written — the race is CAUGHT',
      r.error || '');
  }

  // --- both shipped sync models compile with the double buffer + gate in ---
  for (const f of ['Game of Life on Agents.gcaproj', 'Life on Bonds.gcaproj']) {
    const mdl = migrateForHarness(JSON.parse(readFileSync(join(ROOT, 'public/models', f), 'utf8')));
    const r = compileAgentGraphWebGPUForModel(mdl);
    ok(!r.error && r.layout.syncAttrs === true, `${f}: compiles with a distinct attribute write run`, r.error || '');
    ok(isAgentGraphWebGPUSupported(mdl) === true, `${f}: the WebGPU gate accepts it`);
    ok(mdl.centerBased.agentTarget === 'webgpu', `${f}: ships on the WebGPU agent target (library policy)`);
  }
}

// ===========================================================================
// TIER F — P3: BOND ATTRIBUTES on the WebGPU agent target
// ===========================================================================
//
// The phase's highest-risk edit is the bondStore STRIDE. A bond slot went from
// `[partner, restBits]` to `[partner, restBits, ...attrs]`, so every emitter's
// index arithmetic had to widen. A missed site reads the WRONG LANE silently — no
// error, no crash, just a bond attribute that reads as a rest length (or a
// partner id read as an attribute). So this tier pins:
//
//   1. the layout arithmetic (stride, word indices, region sizing, append-last);
//   2. that NO bond emitter contains a stride literal inconsistent with the
//      layout's stride — checked over the WHOLE emitted shader, with a MUTATION
//      negative control that forces the stride back to 2 and proves the check
//      fails (the risk the handoff names, made detectable);
//   3. that a no-bond-attribute model's bond indexing is EXACTLY the pre-P3 form
//      (`* 2u`) — the byte-identity half;
//   4. Set Bond Attribute writes BOTH rows (I2 at the shader level) under a
//      `read_write` binding, and Form Bond writes its per-attribute request runs.
//
// I2 at RUNTIME on the GPU, and the cross-target agreement, are browser gates
// (real device) — recorded in the phase doc's Completion Report.

/** Every `bondStore[...]` index expression in a shader, as `{ stride, word }`.
 *  The emitted form is `<base> + u32(<k>) * <S>u` optionally `+ <W>u`, where
 *  `<base>` is itself `<idxExpr> * u32(control.maxBonds) * <S>u`. */
function bondStoreIndexShapes(wgsl) {
  const rowStrides = new Set();
  const ROW_RE = /\* u32\(control\.maxBonds\) \* (\d+)u/g;
  let mt;
  while ((mt = ROW_RE.exec(wgsl)) !== null) rowStrides.add(Number(mt[1]));
  const slots = [];
  const SLOT_RE = /bondStore\[(\w+) \+ u32\([^)]*\) \* (\d+)u(?: \+ (\d+)u)?\]/g;
  while ((mt = SLOT_RE.exec(wgsl)) !== null) slots.push({ stride: Number(mt[2]), word: mt[3] === undefined ? 0 : Number(mt[3]) });
  return { rowStrides, slots };
}

/** null when every bondStore index in `wgsl` agrees with stride `S`; else why. */
function bondStrideConsistent(wgsl, S) {
  const { rowStrides, slots } = bondStoreIndexShapes(wgsl);
  for (const r of rowStrides) if (r !== S) return `a bond ROW base uses stride ${r}, layout says ${S}`;
  for (const s of slots) {
    if (s.stride !== S) return `a bond SLOT index uses stride ${s.stride}, layout says ${S}`;
    if (s.word >= S) return `a bond slot word ${s.word} is outside stride ${S}`;
  }
  return null;
}

/** A bond-attribute agent model: For Each Bond → (read w) → Set Bond Attribute on
 *  the lower-id side only, plus a Form Bond seeding the initial values. */
function buildBondAttrGpuModel(over = {}) {
  const g = mkGraphBuilder();
  const bs = g.n('behaviourStep', {});
  const feb = g.n('forEachBond', {});
  const gba = g.n('getBondAttribute', { attributeId: 'w' });
  const inc = g.n('arithmeticOperator', { operation: 'add', _port_y: '1' });
  const sba = g.n('setBondAttribute', { attributeId: 'w' });
  const fb = g.n('formBond', { _port_bondAttr_w: '7', _port_bondAttr_lbl: '3' });
  g.f(bs, 'do', feb, 'do');
  g.f(feb, 'body', sba, 'do');
  g.f(feb, 'next', fb, 'do');
  g.v(feb, 'partnerId', gba, 'partnerId');
  g.v(gba, 'value', inc, 'x');
  g.v(inc, 'value', sba, 'value');
  g.v(feb, 'partnerId', sba, 'partnerId');
  const mdl = migrateForHarness(wrapModel('Bond Attr GPU Test', g.nodes, g.edges, [
    { id: 'acc', name: 'Acc', type: 'float', defaultValue: '0' },
  ], over));
  mdl.bondAttributes = [
    { id: 'w', name: 'W', type: 'float', defaultValue: '0' },
    { id: 'lbl', name: 'Label', type: 'integer', defaultValue: '0' },
  ];
  return mdl;
}

function tierF() {
  section('TIER F — P3: bond attributes on the WebGPU agent target');

  const mdl = buildBondAttrGpuModel();
  const r = compileAgentGraphWebGPUForModel(mdl);
  const L = r.layout;
  ok(!r.error && !!r.shaderCode, 'a bond-attribute model compiles to WGSL', r.error || '');
  ok(isAgentGraphWebGPUSupported(mdl) === true, 'the WebGPU gate ACCEPTS it (P2‘s model-level reject is lifted)');

  // --- 1. the layout arithmetic ---
  ok(L.bondSlotStride === 2 + L.bondAttrIds.length,
    'bondSlotStride == 2 + the bond-attribute count', `${L.bondSlotStride} vs 2+${L.bondAttrIds.length}`);
  ok(L.bondAttrIds.join(',') === 'w,lbl', 'bondAttrIds follows bondAttrsOf(model) order', L.bondAttrIds.join(','));
  ok(L.bondAttrWord.w === 2 && L.bondAttrWord.lbl === 3, 'each attribute owns one slot WORD, after partner+rest');
  ok(L.bondAttrIsFloat.w === true && L.bondAttrIsFloat.lbl === false,
    'float ⇒ f32 BITS, integer/bool/tag ⇒ a plain i32 word');
  ok(L.bondStoreLen === L.maxAgents * L.maxBonds * L.bondSlotStride,
    'bondStoreLen == maxAgents · maxBonds · stride', String(L.bondStoreLen));

  // A no-bond-attribute sibling: stride 2, no widening, no extra f32 runs — the
  // byte-identity half (check-compile-identity covers the shipped models).
  const plain = buildBondAttrGpuModel();
  plain.bondAttributes = [];
  const rp = compileAgentGraphWebGPUForModel(plain);
  ok(rp.layout.bondSlotStride === 2, 'NO bond attributes ⇒ stride 2 (the pre-P3 layout)');
  ok(rp.layout.bondStoreLen === rp.layout.maxAgents * rp.layout.maxBonds * 2, 'NO bond attributes ⇒ the pre-P3 bondStoreLen');
  ok(Object.keys(rp.layout.bondFormAttrBase).length === 0, 'NO bond attributes ⇒ no Form-Bond request runs');
  ok(bondStrideConsistent(rp.shaderCode, 2) === null,
    'NO bond attributes ⇒ every bond index is the pre-P3 `* 2u` form', String(bondStrideConsistent(rp.shaderCode, 2)));

  // The Form-Bond request runs are APPENDED LAST, so every pre-P3 f32 base is
  // byte-stable (the baked-offset lockstep).
  // P4: each Form-Bond request run is QUEUE-shaped (maxAgents * bondReqSlots) —
  // one initial-value cell per queue ENTRY, so queued forms cannot smear values.
  const reqRun = L.maxAgents * L.bondReqSlots;
  ok(L.bondFormAttrBase.w >= rp.layout.f32Len && L.bondFormAttrBase.lbl === L.bondFormAttrBase.w + reqRun,
    'the Form-Bond request runs are appended AFTER every other f32 run, in attribute order');
  ok(L.f32Len - rp.layout.f32Len === L.bondAttrIds.length * reqRun,
    'the SoA grows by exactly one QUEUE-shaped run per bond attribute', `${rp.layout.f32Len} -> ${L.f32Len}`);

  // --- 2. stride consistency over the WHOLE shader + the MUTATION control ---
  ok(bondStrideConsistent(r.shaderCode, L.bondSlotStride) === null,
    'every bondStore index in the shader uses the layout stride (no stale `* 2u`)',
    String(bondStrideConsistent(r.shaderCode, L.bondSlotStride)));
  {
    // MUTATION: force the ONE stride constant back to 2 while the attribute words
    // still say 2/3. If the emitters did not all derive from the layout, this could
    // not be detected — the check must FAIL here.
    const bad = { ...L, bondSlotStride: 2 };
    const rb = compileAgentGraphWebGPU(mdl.agentGraphNodes, mdl.agentGraphEdges, mdl, bad);
    ok(!rb.error && bondStrideConsistent(rb.shaderCode, L.bondSlotStride) !== null,
      'negative control: forcing the stride back to 2 is CAUGHT (a wrong-lane read)',
      rb.error || '');
  }

  // --- 3. the emitted reads/writes ---
  {
    const s = r.shaderCode;
    ok(/@binding\(11\) var<storage, read_write> bondStore/.test(s),
      'Set Bond Attribute promotes binding 11 to read_write (decision D3)');
    ok(r.usesBondStoreWrite === true, 'the result ships usesBondStoreWrite so the runtime binds `storage` + reads the lanes back');
    ok(/bondStore\[\w+ \+ u32\([^)]*\) \* 4u \+ 2u\] = bitcast<i32>/.test(s),
      'the float bond attribute is WRITTEN as f32 bits at its slot word');
    ok(/bitcast<f32>\(bondStore\[u32\(max\(\w+, 0\)\)\]\)/.test(s),
      'Get Bond Attribute reads through a bounds-clamped index (WGSL select evaluates both arms)');
    // I2 at the SHADER level: TWO scans, one anchored on the partner id and one on
    // `i32(idx)` — the own row and the partner's row.
    ok(/== i32\(idx\)/.test(s), 'Set Bond Attribute scans the PARTNER‘s row too (I2: both slots written)');
    const writes = (s.match(/bondStore\[[^\]]*\] = /g) || []).length;
    ok(writes === 2, 'exactly TWO bond-store writes per Set Bond Attribute (own side + partner side)', String(writes));
    ok(/agentAlive\[u32\(\w+\)\] != 0u/.test(s), 'the partner-side write is range + alive guarded (the by-id-writer discipline)');
    // Form Bond's initial values ride per-agent f32 request runs.
    // P4: the write addresses the current QUEUE ENTRY (`brqE…`), not a bare `idx`.
    const sLines = s.split(String.fromCharCode(10));
    const wLine = sLines.find(l => l.includes(`agentF32[${L.bondFormAttrBase.w}u + _brqE`) && l.includes('] = '));
    const lLine = sLines.find(l => l.includes(`agentF32[${L.bondFormAttrBase.lbl}u + _brqE`) && l.includes('] = '));
    ok(!!wLine && !!lLine,
      'Form Bond writes ONE initial-value cell per bond attribute, at the QUEUE ENTRY',
      `w=${wLine ?? 'MISSING'} lbl=${lLine ?? 'MISSING'}`);
  }

  // --- 4. a read-ONLY bond-attribute model keeps the read binding ---
  {
    const g = mkGraphBuilder();
    const bs = g.n('behaviourStep', {});
    const feb = g.n('forEachBond', {});
    const gba = g.n('getBondAttribute', { attributeId: 'w' });
    const set = g.n('setAttribute', { attributeId: 'acc' });
    g.f(bs, 'do', feb, 'do'); g.f(feb, 'body', set, 'do');
    g.v(feb, 'partnerId', gba, 'partnerId'); g.v(gba, 'value', set, 'value');
    const ro = migrateForHarness(wrapModel('Bond Attr Read Only', g.nodes, g.edges, [
      { id: 'acc', name: 'Acc', type: 'float', defaultValue: '0' },
    ]));
    ro.bondAttributes = [{ id: 'w', name: 'W', type: 'float', defaultValue: '0' }];
    const rr = compileAgentGraphWebGPUForModel(ro);
    ok(!rr.error && /@binding\(11\) var<storage, read>       bondStore/.test(rr.shaderCode),
      'a READ-ONLY bond-attribute model keeps the pre-P3 `read` binding', rr.error || '');
    ok(rr.usesBondStoreWrite !== true, 'a read-only model does not ask the runtime for a writable bond store');
    ok(bondStrideConsistent(rr.shaderCode, rr.layout.bondSlotStride) === null, 'read-only: stride consistent');
  }

  // --- 5. 3D + bonds-off ---
  {
    const d3 = buildBondAttrGpuModel();
    d3.properties.dimension = '3d'; d3.properties.gridDepth = 8;
    const r3 = compileAgentGraphWebGPUForModel(d3);
    ok(!r3.error && r3.layout.gridDepth === 8 && r3.layout.bondSlotStride === 4,
      '3D: a bond-attribute model compiles with the same widened stride', r3.error || '');
    ok(bondStrideConsistent(r3.shaderCode, 4) === null, '3D: stride consistent');

    const off = buildBondAttrGpuModel({ agentCapabilities: AGENT_CAPS({ bonds: 'off' }) });
    const ro = compileAgentGraphWebGPUForModel(off);
    ok(ro.layout.bondSlotStride === 2 && ro.layout.bondStoreLen === 0 && ro.layout.bondAttrIds.length === 0,
      'bonds=off ⇒ NO bond store, NO attribute words (bondAttrsOf applies the capability filter)');
  }
}


// ===========================================================================
// TIER G — P4: the STRUCTURAL REQUEST QUEUE + the atomic Rewire verb
// ===========================================================================
//
// The DRAIN is the thing under test here, so these run against the SHIPPED
// `drainAgentBondRequests` over a real AgentStore — the harness writes queue
// entries (playing the part of the compiled behaviour, whose emit is proven
// separately + bit-identically by the parity synthetic) and then checks what the
// engine did with them.
//
//   I5  atomicity   — D+3 ops: exactly D apply, the rest are rejected WHOLE and
//                     reported; a rewire that cannot complete applies NEITHER half
//   O5  conservation — a rewire-only rule keeps N, E and the full degree MULTISET
//                     invariant for 500 generations, exactly
//   ——  multi-op    — one agent performing 3 rewires (6 edge mutations) in ONE
//                     generation, with the graph consistent immediately after
//
// Every one is negative-controlled.

/** The degree MULTISET as a canonical string — a STRONGER conservation test than
 *  min/max, which a swap that moves degree between two nodes would pass. */
function degreeMultiset(g) {
  const d = [];
  for (let i = 0; i < g.highWater; i++) if (g.alive[i]) d.push(g.bondCount[i]);
  d.sort((a, b) => a - b);
  return d.join(',');
}

/** The live edge set as canonical `min:max` keys. */
function edgeSet(g) {
  const e = new Set();
  for (let i = 0; i < g.highWater; i++) {
    if (!g.alive[i]) continue;
    for (let k = 0; k < g.bondCount[i]; k++) {
      const p = g.bondPartner[i * g.maxBonds + k];
      if (p < 0 || p >= g.highWater || !g.alive[p]) continue;
      e.add(i < p ? `${i}:${p}` : `${p}:${i}`);
    }
  }
  return e;
}

/** Write ONE queue entry, exactly as the three emitters do (lanes: 0 = empty,
 *  BOND_REQ_NONE = side unused, id + BOND_REQ_ID_BIAS otherwise). `c` past the
 *  depth is clamped to the OVERFLOW BUCKET, mirroring the emitters' cursor. */
function queueOp(st, i, c, { from = -1, to = -1, L = 0, K = 0 } = {}) {
  const slots = st.bondReqSlots, depth = slots - 1;
  const e = i * slots + Math.min(c, depth);
  st.bondBreakReq[e] = from >= 0 ? from + BOND_REQ_ID_BIAS : BOND_REQ_NONE;
  st.bondFormReq[e] = to >= 0 ? to + BOND_REQ_ID_BIAS : BOND_REQ_NONE;
  st.bondFormL[e] = L; st.bondFormK[e] = K;
}

const queueCfg = (maxAgents, maxBonds, depth) => ({
  enabled: true, maxAgents, maxBonds, worldWidth: 64, worldHeight: 64,
  defaultRadius: 0.5, bondStiffness: 1, bondRestLength: 1, bondRequestDepth: depth,
  agentCapabilities: AGENT_CAPS({ bonds: 'data' }),
});

/** A store with `n` live agents and no bonds. */
function queueStore(n, maxBonds, depth) {
  const s = createAgentStore(queueCfg(n + 8, maxBonds, depth), []);
  s.worldWidth = 64; s.worldHeight = 64; s.worldDepth = 1;
  seedAgents(s, Array.from({ length: n }, (_, i) => ({ x: (i % 8) + 0.5, y: Math.floor(i / 8) + 0.5, radius: 0.5 })), 0.5);
  return s;
}

const allInvariants = (st) => {
  const g = decodeAgentGraph(st);
  return checkHandshake(g) ?? checkNoDangling(g) ?? checkCapacity(g) ?? checkBondSymmetry(g);
};

function tierG() {
  section('TIER G — P4: the request queue + the atomic Rewire verb');

  // --- 0. the slot resolver: usage-gated, so an unrelated model is byte-identical
  {
    ok(resolveBondRequestDepth({}) === 8, 'the default request-queue depth is 8');
    ok(resolveBondRequestDepth({ bondRequestDepth: 0 }) === 1
      && resolveBondRequestDepth({ bondRequestDepth: 1000 }) === 64,
      'the depth clamps to [1, 64]');
    const noVerb = { agentGraphNodes: [{ id: 'a', data: { nodeType: 'formBondX' } }], centerBased: {}, topologyMode: { agents: true } };
    ok(bondReqSlotsForModel(noVerb) === 1,
      'a graph with NO queue verb keeps 1 slot (the pre-P4 shape ⇒ byte-identical layout)');
    const withVerb = { agentGraphNodes: [{ id: 'a', data: { nodeType: 'rewireBond' } }], centerBased: {}, topologyMode: { agents: true } };
    ok(bondReqSlotsForModel(withVerb) === 9, 'a graph WITH a queue verb reserves depth + the overflow bucket');
    const inMacro = { agentGraphNodes: [], macroDefs: [{ id: 'm', nodes: [{ id: 'a', data: { nodeType: 'breakBond' } }] }], centerBased: {}, topologyMode: { agents: true } };
    ok(agentGraphUsesBondRequests(inMacro), 'a verb inside a MACRO definition still reserves the queue (macros expand at compile time)');
  }

  // --- 1. I5 — a full queue applies EXACTLY the depth and rejects the rest WHOLE
  {
    const D = 8, N = 20, MB = 16;
    const st = queueStore(N, MB, D);
    for (let k = 1; k <= MB; k++) formBond(st, 0, k, 1, 1);
    const before = edgeSet(decodeAgentGraph(st));
    ok(before.size === MB, 'I5 setup: agent 0 carries 16 bonds', String(before.size));

    // D + 3 break ops on agent 0, targeting partners 1..11.
    for (let c = 0; c < D + 3; c++) queueOp(st, 0, c, { from: c + 1 });
    const overflow = drainAgentBondRequests(st, 1);
    ok(overflow === true, 'I5: the overflow bucket is REPORTED when the queue is exceeded');

    const after = edgeSet(decodeAgentGraph(st));
    const want = new Set([...before].filter(e => { const t = Number(e.split(':')[1]); return t > D; }));
    ok(after.size === MB - D, `I5: EXACTLY ${D} of ${D + 3} ops applied`, `${after.size} edges left (want ${MB - D})`);
    ok([...want].every(e => after.has(e)) && [...after].every(e => want.has(e)),
      'I5: the graph is EXACTLY the pre-step graph minus those D edges (no extra, none missing)');
    ok(allInvariants(st) === null, 'I5: I1–I4 hold after the partially-rejected step', String(allInvariants(st)));

    // The queue must be fully CLEARED — a leftover entry would re-apply next step.
    let residue = 0;
    for (let c = 0; c < st.bondReqSlots; c++) if (st.bondBreakReq[c] !== 0 || st.bondFormReq[c] !== 0) residue++;
    ok(residue === 0, 'I5: the whole queue (incl. the overflow bucket) is cleared by the drain', String(residue));

    // NEGATIVE CONTROL: an unclamped cursor (wrapping instead of rejecting) would
    // have applied all 11 ops. Emulate it and prove the check distinguishes them.
    const st2 = queueStore(N, MB, D);
    for (let k = 1; k <= MB; k++) formBond(st2, 0, k, 1, 1);
    for (let c = 0; c < D + 3; c++) breakBond(st2, 0, c + 1);          // "all 11 applied"
    ok(edgeSet(decodeAgentGraph(st2)).size !== MB - D,
      'negative control: applying ALL D+3 ops gives a DIFFERENT graph (the check is not vacuous)');
  }

  // --- 2. I5 — a rewire that cannot complete applies NEITHER half
  {
    const st = queueStore(12, 3, 8);
    formBond(st, 0, 1, 1, 1);                       // the edge we will try to move
    for (let k = 3; k <= 5; k++) formBond(st, 2, k, 1, 1);   // agent 2 is FULL (3 of 3)
    const before = edgeSet(decodeAgentGraph(st));
    queueOp(st, 0, 0, { from: 1, to: 2 });          // rewire 0: 1 → 2 (2 has no room)
    drainAgentBondRequests(st, 1);
    const after = edgeSet(decodeAgentGraph(st));
    ok(hasBond(st, 0, 1), 'I5 rewire: a rejected rewire does NOT break its source edge');
    ok(!hasBond(st, 0, 2), 'I5 rewire: a rejected rewire forms nothing');
    ok(before.size === after.size && [...before].every(e => after.has(e)),
      'I5 rewire: the graph is EXACTLY unchanged (no half-applied rewire)');

    // A rewire whose FROM edge does not exist must not become a bare FORM (that
    // would silently RAISE the agent's degree — what a degree-preserving rule forbids).
    const st2 = queueStore(12, 4, 8);
    formBond(st2, 0, 1, 1, 1);
    queueOp(st2, 0, 0, { from: 7, to: 3 });         // 0 is not bonded to 7
    drainAgentBondRequests(st2, 1);
    ok(!hasBond(st2, 0, 3) && st2.bondCount[0] === 1,
      'I5 rewire: a rewire from a NON-EXISTENT edge applies nothing (never a bare form)');

    // NEGATIVE CONTROL: the non-atomic emulation (break then form) leaves the
    // half-applied state the invariant forbids.
    const st3 = queueStore(12, 3, 8);
    formBond(st3, 0, 1, 1, 1);
    for (let k = 3; k <= 5; k++) formBond(st3, 2, k, 1, 1);
    breakBond(st3, 0, 1); formBond(st3, 0, 2, 1, 1);        // the naive break-then-form
    ok(!hasBond(st3, 0, 1) && !hasBond(st3, 0, 2),
      'negative control: break-then-form leaves the edge GONE and unreplaced (the state I5 forbids)');
  }

  // --- 3. the terminator rule: an unresolvable op still OCCUPIES its entry
  {
    const st = queueStore(12, 4, 8);
    queueOp(st, 0, 0, {});                          // both sides unused (an unresolvable op)
    queueOp(st, 0, 1, { to: 5 });                   // a REAL form after it
    drainAgentBondRequests(st, 1);
    ok(hasBond(st, 0, 5),
      'the entry after an unresolvable op is still drained (the +2 lane bias prevents queue truncation)');

    // NEGATIVE CONTROL: had the unresolvable op written 0 lanes (the naive
    // "target + 1" encoding with target -1), the drain would stop at entry 0.
    const st2 = queueStore(12, 4, 8);
    st2.bondBreakReq[0] = 0; st2.bondFormReq[0] = 0;
    queueOp(st2, 0, 1, { to: 5 });
    drainAgentBondRequests(st2, 1);
    ok(!hasBond(st2, 0, 5),
      'negative control: a ZERO-lane entry DOES truncate the queue (which is why NONE is 1, not 0)');
  }

  // --- 4. MULTI-OP IN ONE STEP — the capability this phase exists to deliver
  {
    const st = queueStore(16, 6, 8);
    for (const p of [1, 2, 3]) formBond(st, 0, p, 1, 1);
    const before = decodeAgentGraph(st);
    const beforeMs = degreeMultiset(before), beforeE = edgeSet(before).size;
    // THREE rewires by ONE agent in ONE generation = 6 edge mutations.
    queueOp(st, 0, 0, { from: 1, to: 4 });
    queueOp(st, 0, 1, { from: 2, to: 5 });
    queueOp(st, 0, 2, { from: 3, to: 6 });
    const of2 = drainAgentBondRequests(st, 1);
    const after = decodeAgentGraph(st);
    ok(of2 === false, 'multi-op: three ops are well within the depth (no overflow)');
    ok(hasBond(st, 0, 4) && hasBond(st, 0, 5) && hasBond(st, 0, 6),
      'multi-op: all THREE new edges exist after ONE generation');
    ok(!hasBond(st, 0, 1) && !hasBond(st, 0, 2) && !hasBond(st, 0, 3),
      'multi-op: all THREE old edges are gone after the SAME generation');
    ok(allInvariants(st) === null, 'multi-op: the graph is consistent IMMEDIATELY after (I1–I4)', String(allInvariants(st)));
    ok(edgeSet(after).size === beforeE, 'multi-op: |E| unchanged (3 removed, 3 added)');
    ok(degreeMultiset(after) === beforeMs,
      'multi-op: the degree MULTISET is unchanged', `${beforeMs} -> ${degreeMultiset(after)}`);
  }

  // --- 5. O5 — pure rewiring conserves N, E and the degree MULTISET, 500 gens
  //
  // The rule is the canonical DOUBLE-EDGE SWAP, expressed node-locally: on a ring
  // 0-1-…-N-1-0, for every i ≡ 0 (mod 4) the pair of disjoint edges (i,i+1) and
  // (i+2,i+3) is swapped into (i,i+2) and (i+1,i+3) —
  //     agent i    rewires  i+1 → i+2
  //     agent i+3  rewires  i+2 → i+1
  // Each of the four endpoints keeps its degree exactly, so the whole degree
  // VECTOR (not merely the multiset) is invariant. It is an involution, so the
  // phase flips each generation and the rule exercises rewire on every step.
  {
    const N = 32, MB = 4, GENS = 500;
    const st = queueStore(N, MB, 8);
    for (let i = 0; i < N; i++) formBond(st, i, (i + 1) % N, 1, 1);
    const g0 = decodeAgentGraph(st);
    const ms0 = degreeMultiset(g0), n0 = g0.alive.reduce((a, b) => a + b, 0), e0 = edgeSet(g0).size;
    ok(checkDegreeRegular(g0, 2) === null && e0 === N, 'O5 setup: a 2-regular ring of 32 agents, E = 32');

    let bad = null, phase = 0, rewires = 0;
    for (let gen = 1; gen <= GENS && !bad; gen++) {
      for (let i = 0; i < N; i += 4) {
        const a = i, b = (i + 1) % N, c = (i + 2) % N, d = (i + 3) % N;
        if (phase === 0) { queueOp(st, a, 0, { from: b, to: c }); queueOp(st, d, 0, { from: c, to: b }); }
        else { queueOp(st, a, 0, { from: c, to: b }); queueOp(st, d, 0, { from: b, to: c }); }
        rewires += 2;
      }
      if (drainAgentBondRequests(st, 1)) { bad = `gen ${gen}: unexpected overflow`; break; }
      const g = decodeAgentGraph(st);
      const inv = checkHandshake(g) ?? checkNoDangling(g) ?? checkCapacity(g) ?? checkBondSymmetry(g);
      if (inv) { bad = `gen ${gen}: ${inv}`; break; }
      if (degreeMultiset(g) !== ms0) { bad = `gen ${gen}: degree multiset ${degreeMultiset(g)} != ${ms0}`; break; }
      if (edgeSet(g).size !== e0) { bad = `gen ${gen}: |E| ${edgeSet(g).size} != ${e0}`; break; }
      if (g.alive.reduce((x, y) => x + y, 0) !== n0) { bad = `gen ${gen}: N changed`; break; }
      phase ^= 1;
    }
    ok(bad === null, `O5: N, E and the full degree MULTISET are invariant over ${GENS} generations of pure rewiring`, String(bad));
    ok(rewires === GENS * (N / 4) * 2, 'O5: the run actually issued a rewire every generation', String(rewires));

    // NEGATIVE CONTROL: a NON-conserving edit (one bare break) must be caught by
    // the very same checks — otherwise the 500-generation pass proves nothing.
    breakBond(st, 0, st.bondPartner[0]);
    const gN = decodeAgentGraph(st);
    ok(degreeMultiset(gN) !== ms0 && edgeSet(gN).size !== e0,
      'negative control: a single bare break DOES change the multiset and |E|');
  }

  // --- 6. the three verbs on all three targets (emit shape; values are proven
  //        bit-identically by the parity synthetic and end-to-end in the browser)
  {
    const raw = buildRewireModel();
    const model = migrateForHarness(raw);
    ok(isAgentGraphWasmSupported(model), 'the WASM agent gate ACCEPTS a Rewire Bond graph');
    ok(isAgentGraphWebGPUSupported(model), 'the WebGPU agent gate ACCEPTS a Rewire Bond graph');

    const js = compileAgentGraph(model.agentGraphNodes, model.agentGraphEdges, model, 0);
    ok(!js.error, 'JS: a Rewire Bond graph compiles', js.error || '');
    ok(js.behaviourCode.includes('let _brqC = 0;'),
      'JS: the per-agent queue cursor is declared in the loop preamble');
    ok(/_bondBreakReq\[_bq\] = _bqOk \?/.test(js.behaviourCode) && /_bondFormReq\[_bq\] = _bqOk \?/.test(js.behaviourCode),
      'JS: a rewire writes BOTH lanes under ONE ok-guard (never a bare form)');
    ok(js.behaviourCode.includes('idx * 9 + (_brqC < 8 ? _brqC : 8)'),
      'JS: the entry address clamps to the overflow bucket at the configured depth');

    const w = compileAgentGraphWasmForModel(model);
    ok(!w.error && w.bytes.length > 0, 'WASM: a Rewire Bond graph compiles', w.error || '');
    ok(w.layout.bondReqSlots === 9, 'WASM: the layout reserves depth + the overflow bucket', String(w.layout.bondReqSlots));

    const g = compileAgentGraphWebGPUForModel(model);
    ok(!g.error, 'WebGPU: a Rewire Bond graph compiles', g.error || '');
    ok(g.layout.bondReqSlots === 9, 'WebGPU: the layout reserves depth + the overflow bucket', String(g.layout.bondReqSlots));
    ok(g.shaderCode.includes('var brqC: i32 = 0;'), 'WebGPU: the per-invocation queue cursor is declared');
    ok(/let _brqE\d+: u32 = idx \* 9u \+ u32\(min\(brqC, 8\)\);/.test(g.shaderCode),
      'WebGPU: the entry address clamps to the overflow bucket');
    ok(!/atomic/.test(g.shaderCode.split('brqC')[0] ?? ''),
      'WebGPU: NO atomics are used for the queue (each thread appends only to its own rows)');
    // The whole queue is written through the layout stride — a stale `+ idx]` on a
    // request run would silently address entry 0 of the wrong agent.
    const reqBases = ['bondFormReq', 'bondBreakReq', 'bondFormL', 'bondFormK'].map(f => g.layout.f32Base[f]);
    const stale = reqBases.some(b => g.shaderCode.includes(`agentF32[${b}u + idx]`));
    ok(!stale, 'WebGPU: no request run is addressed with a bare `idx` (every write goes to a queue ENTRY)');

    // A model WITHOUT any verb keeps the single-slot shape on every surface.
    const plain = migrateForHarness(buildRewireModel({ dropVerbs: true }));
    ok(bondReqSlotsForModel(plain) === 1, 'a verb-free model keeps 1 slot on every target');
    ok(!compileAgentGraph(plain.agentGraphNodes, plain.agentGraphEdges, plain, 0).behaviourCode.includes('_brqC'),
      'a verb-free model emits NO queue cursor (the byte-identity gate)');
  }
}

/** A minimal agent graph exercising all three queue verbs. `dropVerbs` returns the
 *  SAME graph with the verbs removed — the byte-identity control. */
function buildRewireModel({ dropVerbs = false } = {}) {
  const used = new Set();
  const nid = (p) => { let id; do { id = p + Math.random().toString(36).slice(2, 8); } while (used.has(id)); used.add(id); return id; };
  const aN = [], aEd = [];
  const an = (t, c) => { const n = { id: nid('a'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; aN.push(n); return n; };
  const aE = (s2, sp, tt, tp, cat) => aEd.push({ id: nid('e'), source: s2.id, target: tt.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
  const bs = an('behaviourStep', {});
  const gsh = an('getSelfHandle', {});
  const off = (k) => { const n = an('arithmeticOperator', { operation: '+', _port_y: String(k) }); aE(gsh, 'value', n, 'x', 'value'); return n; };
  if (!dropVerbs) {
    const brk = an('breakBond', {});
    const frm = an('formBond', { _port_restLength: '1', _port_stiffness: '1' });
    const rw = an('rewireBond', { _port_restLength: '1', _port_stiffness: '1' });
    aE(bs, 'do', brk, 'do', 'flow');
    aE(off(1), 'result', brk, 'targetAgent', 'value');
    aE(brk, 'next', frm, 'do', 'flow');
    aE(off(2), 'result', frm, 'targetAgent', 'value');
    aE(frm, 'next', rw, 'do', 'flow');
    aE(off(3), 'result', rw, 'fromAgent', 'value');
    aE(off(4), 'result', rw, 'toAgent', 'value');
  } else {
    const st = an('setTargetRadius', { _port_radius: '1' });
    aE(bs, 'do', st, 'do', 'flow');
    aE(off(1), 'result', st, 'radius', 'value');
  }
  return {
    schemaVersion: 1,
    properties: { name: 'Rewire Bond Test', dimension: '2d', gridWidth: 32, gridHeight: 32, gridDepth: 1, topology: '2d-grid', boundaryTreatment: 'torus', useWasm: false, useWebGPU: false },
    topologyMode: { gridCells: false, agents: true },
    centerBased: {
      enabled: true, maxAgents: 64, maxBonds: 6, worldWidth: 32, worldHeight: 32, seedCount: 16,
      seedPattern: 'scatter', defaultRadius: 0.5, growthRate: 0, repulsionStiffness: 0, adhesionStiffness: 0,
      interactionRange: 1.5, drag: 1, timeStep: 0.1, momentum: 0, maxSpeed: 0, neighbourQueryRadius: 8,
      useBondingPhysics: false, autoBond: false, bondStiffness: 1, bondRestLength: 1, formDistance: 1.2,
      breakDistance: 2.0, agentTarget: 'wasm', agentUpdateMode: 'async', bondRequestDepth: 8,
      agentCapabilities: AGENT_CAPS({ bonds: 'data' }),
    },
    attributes: [], modelAttributes: [], neighborhoods: [],
    agentAttributes: [], bondAttributes: [],
    variables: [], agentVariables: [], indicators: [], mappings: [],
    graphNodes: [], graphEdges: [], agentGraphNodes: aN, agentGraphEdges: aEd, macroDefs: [],
  };
}

// ===========================================================================
// TIER H — P5: the DIVISION BOND PARTITION (I7 / O4 / O9)
// ===========================================================================
//
// `divideAgent` split a mother's bonds GEOMETRICALLY. P5 lets the user NAME the
// partition (tension / alternate / byBondAttribute) plus decision D4, the
// daughter–daughter bond policy. Everything here runs through the SHIPPED engine
// (`divideAgent`) and the SHIPPED spec builder (`dividePartitionFromConfig`), and
// every new invariant carries a negative control.

const P5_SPECS = [
  { id: 'w', type: 'float', defaultValue: 0 },
  { id: 'kind', type: 'tag', defaultValue: 0 },   // 0 = apical, 1 = basal
  { id: 'on', type: 'bool', defaultValue: 0 },
];

/** The (partner → attribute tuple) multiset an agent's bond list holds. */
function bondBag(s, owner) {
  const mb = s.maxBonds, bag = new Map();
  for (let k = 0; k < s.bondCount[owner]; k++) {
    const p = s.bondPartner[owner * mb + k];
    bag.set(p, P5_SPECS.map(sp => s.bondAttrs[sp.id][owner * mb + k]));
  }
  return bag;
}

/** I7 — the conservation law across ONE division. The two daughters' inherited
 *  (partner, attribute-tuple) multiset must equal the mother's EXACTLY, plus the
 *  new A–B bond (P5 has no explicit "drop" verb, so nothing may vanish). Returns
 *  null when it holds, else a message. */
function checkI7(before, s, a, b, expectDaughterBond) {
  const bagA = bondBag(s, a), bagB = bondBag(s, b);
  const sawAB = bagA.has(b), sawBA = bagB.has(a);
  if (sawAB !== sawBA) return `the A–B bond is one-sided (A→B ${sawAB}, B→A ${sawBA})`;
  if (sawAB !== expectDaughterBond) return `daughter bond present=${sawAB}, expected ${expectDaughterBond}`;
  bagA.delete(b); bagB.delete(a);
  // No partner may land on BOTH daughters, and the union must be the mother's.
  for (const p of bagA.keys()) if (bagB.has(p)) return `partner ${p} landed on BOTH daughters`;
  if (bagA.size + bagB.size !== before.size) {
    return `inherited ${bagA.size + bagB.size} bonds, mother had ${before.size}`;
  }
  for (const [p, vals] of before) {
    const got = bagA.get(p) ?? bagB.get(p);
    if (!got) return `partner ${p} vanished in the division`;
    // O9 — the attributes travel WITH the bond and are not re-initialised.
    for (let i = 0; i < vals.length; i++) {
      if (!Object.is(got[i], vals[i])) {
        return `bond ${p} lost ${P5_SPECS[i].id} (got ${got[i]}, want ${vals[i]})`;
      }
    }
  }
  return null;
}

/** A hub agent bonded to `n` spokes, every bond carrying deterministic values.
 *  `kindOf(k)` picks the tag option; `wOf(k)` the float. */
function starStore(n, { kindOf = (k) => k % 2, wOf = (k) => 100 + k, maxBonds = 16 } = {}) {
  const s = createAgentStore(bondCfg(n + 8 + 8, maxBonds), [], { bondAttrSpecs: P5_SPECS });
  seedAgents(s, Array.from({ length: n + 1 }, (_, i) => (
    i === 0 ? { x: 32, y: 32 } : { x: 32 + 4 * Math.cos((i - 1) * 2 * Math.PI / n), y: 32 + 4 * Math.sin((i - 1) * 2 * Math.PI / n) }
  )), 0.5);
  for (let k = 0; k < n; k++) formBond(s, 0, k + 1, 1, 0, 0, [wOf(k), kindOf(k), kindOf(k) === 0 ? 1 : 0]);
  return s;
}

function tierH() {
  section('TIER H — P5: the division bond partition (I7 / O4 / O9)');

  // --- 0. the SPEC BUILDER (the one place a node config becomes an engine spec)
  {
    const model = { bondAttributes: [
      { id: 'w', name: 'W', type: 'float', defaultValue: '0' },
      { id: 'kind', name: 'Kind', type: 'tag', defaultValue: '0', tagOptions: ['apical', 'basal', 'lateral'] },
      { id: 'on', name: 'On', type: 'bool', defaultValue: 'false' },
    ], centerBased: { maxBonds: 8, agentCapabilities: AGENT_CAPS({ bonds: 'data' }) } };
    ok(dividePartitionKey(dividePartitionFromConfig({}, model)) === dividePartitionKey(DEFAULT_DIVIDE_PARTITION),
      'an empty config builds the DEFAULT (tension / auto) spec');
    ok(dividePartitionFromConfig({ partition: 'alternate' }, model).mode === 'alternate',
      'partition: alternate builds the alternate spec');
    const byTag = dividePartitionFromConfig(
      { partition: 'byBondAttribute', partitionAttributeId: 'kind', partTag_1: true, partTag_2: true }, model);
    ok(byTag.mode === 'byBondAttribute' && byTag.attributeId === 'kind'
      && byTag.tagB.length === 3 && byTag.tagB.join(',') === '0,1,1',
      'a TAG partition builds the per-option daughter table', byTag.tagB.join(','));
    const byBool = dividePartitionFromConfig({ partition: 'byBondAttribute', partitionAttributeId: 'on' }, model);
    ok(byBool.threshold === 0.5 && byBool.tagB.length === 0, 'a BOOL partition pins threshold 0.5 (false→A, true→B)');
    const byNum = dividePartitionFromConfig(
      { partition: 'byBondAttribute', partitionAttributeId: 'w', partitionThreshold: '105' }, model);
    ok(byNum.threshold === 105, 'a FLOAT partition carries the configured threshold');
    // Unresolvable ⇒ degrade to tension (NEVER a silent mis-partition), and the
    // node carries a badge saying so.
    const gone = dividePartitionFromConfig({ partition: 'byBondAttribute', partitionAttributeId: 'deleted' }, model);
    ok(gone.mode === 'tension', 'an unresolvable bond attribute DEGRADES to tension');
    const badge = detectMissingConfig('divideAgent', { partition: 'byBondAttribute', partitionAttributeId: 'deleted' },
      { ...model, attributes: [], agentAttributes: [] });
    ok(badge.length > 0, 'and the node is BADGED for it (never silent)', JSON.stringify(badge));
    const okBadge = detectMissingConfig('divideAgent', { partition: 'tension' },
      { ...model, attributes: [], agentAttributes: [] });
    ok(okBadge.length === 0, 'a tension partition needs no attribute (no badge)');
    // D4 rides every mode.
    ok(dividePartitionFromConfig({ daughterBond: 'always' }, model).daughterBond === 'always'
      && dividePartitionFromConfig({ daughterBond: 'never' }, model).daughterBond === 'never'
      && dividePartitionFromConfig({ daughterBond: 'nonsense' }, model).daughterBond === 'auto',
      'the daughterBond policy parses (auto / always / never, unknown ⇒ auto)');
  }

  // --- 1. `tension` is UNCHANGED: passing the default spec explicitly must give
  //        the SAME graph as the pre-P5 call with no spec at all.
  {
    const mk = () => starStore(7);
    const s1 = mk(), s2 = mk();
    const n1 = divideAgent(s1, 0, 0, 0, 0, 0.5, 0, false, 64, 64, 1);
    const n2 = divideAgent(s2, 0, 0, 0, 0, 0.5, 0, false, 64, 64, 1, undefined, DEFAULT_DIVIDE_PARTITION);
    ok(n1 === n2 && n1 >= 0, 'tension: the default spec allocates the same daughter slot');
    const sig = (s, a, b) => [...bondBag(s, a).entries()].concat([...bondBag(s, b).entries()])
      .map(([p, v]) => `${p}:${v.join('/')}`).sort().join('|');
    ok(sig(s1, 0, n1) === sig(s2, 0, n2), 'tension: the partition is byte-for-byte the pre-P5 result');
    ok(allInvariants(storeGraph(s1)) === null, 'tension: I1–I4 hold after the division');
  }

  // --- 2. `alternate` assigns A, B, A, B… in SLOT order (asserted by VALUE)
  {
    const s = starStore(8);
    const partners = [...bondBag(s, 0).keys()];   // slot order
    const nid = divideAgent(s, 0, 1, 0, 0, 0.5, 0, false, 64, 64, 1, undefined,
      { ...DEFAULT_DIVIDE_PARTITION, mode: 'alternate' });
    const bagA = bondBag(s, 0), bagB = bondBag(s, nid);
    let wrong = 0;
    partners.forEach((p, k) => {
      const wantA = (k % 2) === 0;
      if (wantA ? !bagA.has(p) : !bagB.has(p)) wrong++;
    });
    ok(wrong === 0, 'alternate: every EVEN slot went to daughter A and every ODD slot to B', String(wrong));
    // NEGATIVE CONTROL — the same assertion under an "all to A" partition FAILS,
    // so the check above is really discriminating.
    {
      const s2 = starStore(8);
      const ps = [...bondBag(s2, 0).keys()];
      const n2 = divideAgent(s2, 0, 1, 0, 0, 0.5, 0, false, 64, 64, 1, undefined,
        { ...DEFAULT_DIVIDE_PARTITION, mode: 'byBondAttribute', attributeId: 'w', threshold: 1e9 });
      const bA = bondBag(s2, 0), bB = bondBag(s2, n2);
      let w2 = 0;
      ps.forEach((p, k) => { const wantA = (k % 2) === 0; if (wantA ? !bA.has(p) : !bB.has(p)) w2++; });
      ok(w2 > 0 && bB.size === 1, 'NEG: an all-to-A partition FAILS the alternate check', `wrong=${w2} B=${bB.size}`);
    }
  }

  // --- 3. `byBondAttribute` — the headline: "give daughter A the apical bonds"
  {
    // 9 spokes over THREE tag options (apical=0, basal=1, lateral=2), with the
    // table apical+lateral → A, basal → B. Three options matter: with only two,
    // the per-option table and a plain 0.5 threshold agree by accident, so the
    // assertion could not tell them apart (found by a mutation control).
    const TAGB = [0, 1, 0];
    const s = starStore(9, { kindOf: (k) => k % 3 });
    const toA = [], toB = [];
    for (const [p, v] of bondBag(s, 0)) (TAGB[v[1]] === 0 ? toA : toB).push(p);
    ok(toA.length === 6 && toB.length === 3, 'the star has 6 apical/lateral + 3 basal bonds', `${toA.length}/${toB.length}`);
    const nid = divideAgent(s, 0, 1, 0, 0, 0.5, 0, false, 64, 64, 1, undefined,
      { mode: 'byBondAttribute', attributeId: 'kind', threshold: 0.5, tagB: TAGB, daughterBond: 'auto' });
    const bagA = bondBag(s, 0), bagB = bondBag(s, nid);
    bagA.delete(nid); bagB.delete(0);
    ok(toA.every(p => bagA.has(p)) && bagA.size === 6, 'byBondAttribute (tag): daughter A got EXACTLY the apical+lateral bonds',
      `${[...bagA.keys()]} vs ${toA}`);
    ok(toB.every(p => bagB.has(p)) && bagB.size === 3, 'byBondAttribute (tag): daughter B got EXACTLY the basal bonds',
      `${[...bagB.keys()]} vs ${toB}`);
    ok(allInvariants(storeGraph(s)) === null, 'byBondAttribute: I1–I4 hold after the split');
    // NEGATIVE CONTROL — flip the table and the SAME bonds go the other way.
    {
      const s2 = starStore(9, { kindOf: (k) => k % 3 });
      const n2 = divideAgent(s2, 0, 1, 0, 0, 0.5, 0, false, 64, 64, 1, undefined,
        { mode: 'byBondAttribute', attributeId: 'kind', threshold: 0.5, tagB: [1, 0, 1], daughterBond: 'auto' });
      const a2 = bondBag(s2, 0), b2 = bondBag(s2, n2);
      a2.delete(n2); b2.delete(0);
      ok(toB.every(p => a2.has(p)) && toA.every(p => b2.has(p)),
        'NEG: flipping the per-option table swaps the two daughters exactly');
    }
    // BOOL + THRESHOLD variants, asserted by value.
    {
      const sb = starStore(6, { kindOf: (k) => k % 2 });   // `on` = 1 iff kind===0
      const nb = divideAgent(sb, 0, 1, 0, 0, 0.5, 0, false, 64, 64, 1, undefined,
        { mode: 'byBondAttribute', attributeId: 'on', threshold: 0.5, tagB: [], daughterBond: 'auto' });
      const bA = bondBag(sb, 0), bB = bondBag(sb, nb);
      bA.delete(nb); bB.delete(0);
      ok(bB.size === 3 && [...bB.values()].every(v => v[2] === 1), 'byBondAttribute (bool): true → daughter B');
      ok(bA.size === 3 && [...bA.values()].every(v => v[2] === 0), 'byBondAttribute (bool): false → daughter A');
    }
    {
      const sn = starStore(6, { wOf: (k) => 100 + k });    // w = 100..105
      const nn = divideAgent(sn, 0, 1, 0, 0, 0.5, 0, false, 64, 64, 1, undefined,
        { mode: 'byBondAttribute', attributeId: 'w', threshold: 103, tagB: [], daughterBond: 'auto' });
      const bA = bondBag(sn, 0), bB = bondBag(sn, nn);
      bA.delete(nn); bB.delete(0);
      ok([...bA.values()].every(v => v[0] < 103) && bA.size === 3
        && [...bB.values()].every(v => v[0] >= 103) && bB.size === 3,
        'byBondAttribute (float): value < threshold → A, ≥ → B');
    }
  }

  // --- 4. D4 — the daughter–daughter bond policy
  {
    const free = () => {
      const s = createAgentStore(bondCfg(16, 8), [], { bondAttrSpecs: P5_SPECS });
      seedAgents(s, [{ x: 8, y: 8 }], 0.5);
      return s;
    };
    const d = (s, policy) => divideAgent(s, 0, 1, 0, 0, 0.5, 0, false, 64, 64, 1, undefined,
      { ...DEFAULT_DIVIDE_PARTITION, daughterBond: policy });
    const s1 = free(), n1 = d(s1, 'auto');
    ok(s1.bondCount[0] === 0 && s1.bondCount[n1] === 0, 'D4 auto: a FREE agent divides into two UNBONDED daughters (pre-P5 rule)');
    const s2 = free(), n2 = d(s2, 'always');
    ok(s2.bondCount[0] === 1 && s2.bondCount[n2] === 1 && s2.bondPartner[0 * s2.maxBonds] === n2,
      'D4 always: a FREE agent divides into two BONDED daughters');
    const s3 = starStore(4), n3 = d(s3, 'never');
    ok(!bondBag(s3, 0).has(n3) && !bondBag(s3, n3).has(0), 'D4 never: a BONDED mother yields two non-adjacent daughters');
    ok(allInvariants(storeGraph(s2)) === null && allInvariants(storeGraph(s3)) === null, 'D4: I1–I4 hold under every policy');
    // `always` with the Bonds capability OFF must not reject the division.
    const off = createAgentStore({ ...bondCfg(16, 8), agentCapabilities: AGENT_CAPS({ bonds: 'off' }) }, []);
    seedAgents(off, [{ x: 8, y: 8 }], 0.5);
    const nOff = divideAgent(off, 0, 1, 0, 0, 0.5, 0, false, 64, 64, 1, undefined,
      { ...DEFAULT_DIVIDE_PARTITION, daughterBond: 'always' });
    ok(nOff >= 0, 'D4 always with bonds=off still divides (mb === 0 ⇒ no bond to add)', String(nOff));
  }

  // --- 5. I7 + O9 over ≥1000 divisions, in EVERY mode, invariants every division
  {
    const MODES = [
      ['tension', { ...DEFAULT_DIVIDE_PARTITION }],
      ['alternate', { ...DEFAULT_DIVIDE_PARTITION, mode: 'alternate' }],
      ['byBondAttribute(tag)', { mode: 'byBondAttribute', attributeId: 'kind', threshold: 0.5, tagB: [0, 1], daughterBond: 'auto' }],
      ['byBondAttribute(float)', { mode: 'byBondAttribute', attributeId: 'w', threshold: 103, tagB: [], daughterBond: 'auto' }],
    ];
    for (const [name, spec] of MODES) {
      let rs = 0x1234567 ^ name.length;
      const rnd = () => { rs ^= rs << 13; rs >>>= 0; rs ^= rs >>> 17; rs ^= rs << 5; rs >>>= 0; return rs / 0x100000000; };
      const MB = 12, N = 24;
      const s = createAgentStore(bondCfg(600, MB), [], { bondAttrSpecs: P5_SPECS });
      seedAgents(s, Array.from({ length: N }, (_, i) => ({ x: 8 + (i % 6) * 3, y: 8 + Math.floor(i / 6) * 3 })), 0.5);
      // A random sparse graph with random attribute values on every edge.
      for (let t = 0; t < 90; t++) {
        const a = Math.floor(rnd() * N), b = Math.floor(rnd() * N);
        if (a !== b && !hasBond(s, a, b)) {
          formBond(s, a, b, 1 + rnd(), 0, 0, [100 + Math.floor(rnd() * 8), Math.floor(rnd() * 2), Math.floor(rnd() * 2)]);
        }
      }
      let divisions = 0, firstFail = null, rejects = 0;
      for (let gen = 0; gen < 4000 && divisions < 1000 && firstFail === null; gen++) {
        const a = Math.floor(rnd() * s.highWater);
        if (!s.alive[a]) continue;
        const before = bondBag(s, a);
        const nid = divideAgent(s, a, 0, 0, 0, 0.5, 0, false, 64, 64, 1, undefined, spec);
        if (nid < 0) { rejects++; continue; }
        divisions++;
        firstFail = checkI7(before, s, a, nid, before.size > 0);
        if (firstFail === null) firstFail = allInvariants(storeGraph(s));
        // Keep the population bounded + the graph churning: occasionally break a
        // bond and kill an agent, so compaction interleaves with the partition.
        if (divisions % 5 === 0) {
          const x = Math.floor(rnd() * s.highWater);
          if (s.alive[x] && s.bondCount[x] > 0) breakBond(s, x, s.bondPartner[x * MB]);
        }
        if (s.liveCount > 400) {
          const x = Math.floor(rnd() * s.highWater);
          if (s.alive[x]) freeAgentSlot(s, x);
        }
      }
      ok(divisions >= 1000 && firstFail === null,
        `I7/O9 ${name}: ${divisions} divisions conserve every (partner, attributes) bond + I1–I4 hold`,
        firstFail ?? `divisions=${divisions} rejects=${rejects}`);
    }
    // NEGATIVE CONTROL — checkI7 must CATCH a dropped attribute and a dropped bond.
    {
      const s = starStore(4);
      const before = bondBag(s, 0);
      const nid = divideAgent(s, 0, 1, 0, 0, 0.5, 0, false, 64, 64, 1, undefined, DEFAULT_DIVIDE_PARTITION);
      ok(checkI7(before, s, 0, nid, true) === null, 'checkI7 passes on a real division');
      const tampered = new Map([...before].map(([p, v], i) => [p, i === 0 ? [v[0] + 1, v[1], v[2]] : v]));
      ok(checkI7(tampered, s, 0, nid, true) !== null, 'NEG: checkI7 CATCHES a changed bond attribute (O9)');
      // Physically drop one inherited bond and re-check.
      const victim = [...before.keys()].find(p => p !== nid);
      breakBond(s, 0, victim); breakBond(s, nid, victim);
      ok(checkI7(before, s, 0, nid, true) !== null, 'NEG: checkI7 CATCHES a bond that vanished in the division');
    }
  }

  // --- 6. O4 — the deterministic growth law, in every mode
  {
    for (const [name, spec] of [
      ['tension', { ...DEFAULT_DIVIDE_PARTITION, daughterBond: 'always' }],
      ['alternate', { ...DEFAULT_DIVIDE_PARTITION, mode: 'alternate', daughterBond: 'always' }],
      ['byBondAttribute', { mode: 'byBondAttribute', attributeId: 'kind', threshold: 0.5, tagB: [0, 1], daughterBond: 'always' }],
    ]) {
      const N0 = 4, T = 8, MB = 32;
      const s = createAgentStore(bondCfg(N0 * (1 << T) + 64, MB), [], { bondAttrSpecs: P5_SPECS });
      seedAgents(s, Array.from({ length: N0 }, (_, i) => ({ x: 8 + i * 4, y: 8 })), 0.5);
      const E0 = 0;
      let bad = null, rejects = 0;
      for (let t = 1; t <= T && bad === null; t++) {
        const hw = s.highWater;
        for (let i = 0; i < hw; i++) {
          if (!s.alive[i]) continue;
          const nid = divideAgent(s, i, 0, 0, 0, 0.5, 0, false, 512, 512, 1, undefined, spec);
          if (nid < 0) { rejects++; }
        }
        const g = decodeAgentGraph({ highWater: s.highWater, maxBonds: s.maxBonds, alive: s.alive, bondCount: s.bondCount, bondPartner: s.bondPartner });
        const wantN = N0 * (1 << t), wantE = E0 + N0 * ((1 << t) - 1);
        const gotE = edgeSet(g).size;
        if (s.liveCount !== wantN) bad = `t=${t}: N=${s.liveCount}, want ${wantN} (rejects=${rejects})`;
        else if (gotE !== wantE) bad = `t=${t}: E=${gotE}, want ${wantE}`;
        else bad = allInvariants(storeGraph(s));
      }
      ok(bad === null, `O4 ${name}: N_t = N0·2^t and E_t = E0 + N0·(2^t − 1) EXACTLY for t = 1..${T} (no silent capacity rejection)`, bad ?? '');
    }
    // NEGATIVE CONTROL — under the `auto` policy free agents never bond, so the
    // edge law does NOT hold: the check is sensitive to the D4 policy it tests.
    {
      const N0 = 4, MB = 32;
      const s = createAgentStore(bondCfg(N0 * 16 + 64, MB), [], { bondAttrSpecs: P5_SPECS });
      seedAgents(s, Array.from({ length: N0 }, (_, i) => ({ x: 8 + i * 4, y: 8 })), 0.5);
      const hw0 = s.highWater;
      for (let i = 0; i < hw0; i++) if (s.alive[i]) divideAgent(s, i, 0, 0, 0, 0.5, 0, false, 512, 512, 1, undefined, DEFAULT_DIVIDE_PARTITION);
      const g = decodeAgentGraph({ highWater: s.highWater, maxBonds: s.maxBonds, alive: s.alive, bondCount: s.bondCount, bondPartner: s.bondPartner });
      ok(s.liveCount === N0 * 2 && edgeSet(g).size === 0,
        'NEG: under daughterBond=auto the SAME run yields E=0, so the O4 edge law is really testing D4');
    }
  }

  // --- 7. the TRANSPORT: the compiler's table + the three emitters
  {
    const model = buildDivideModel();
    const r = compileAgentGraph(model.agentGraphNodes, model.agentGraphEdges, migrateForHarness(model));
    ok(!r.error, 'a divide-partition model compiles on JS', r.error ?? '');
    ok(r.dividePartitions.length === 2, 'the table holds one entry per DISTINCT spec (2 of the 3 nodes share one)',
      String(r.dividePartitions.length));
    const keys = r.dividePartitions.map(dividePartitionKey);
    ok(keys.join('') === [...keys].sort().join(''),
      'the table is in CANONICAL (key-sorted) order — so it does not depend on node order or on which target compiled first');
    ok(r.dividePartitions.some(p => p.mode === 'tension')
      && r.dividePartitions.some(p => p.mode === 'byBondAttribute' && p.attributeId === 'kind' && p.tagB.join(',') === '0,1'),
      'the table carries the resolved specs', JSON.stringify(r.dividePartitions));
    // Every node's baked code is its OWN spec's 1-based position in that table
    // (this is what WASM / WebGPU read; the two tension nodes must share a code).
    const dNodes = model.agentGraphNodes.filter(n => n.data.nodeType === 'divideAgent');
    const codes = dNodes.map(n => dividePartitionCode(n.data.config));
    const wantCodes = dNodes.map(n => keys.indexOf(dividePartitionKey(dividePartitionFromConfig(n.data.config, migrateForHarness(model)))) + 1);
    ok(codes.join(',') === wantCodes.join(',') && codes[0] === codes[2] && codes[0] !== codes[1],
      'each node carries its 1-based code (deduped: the two tension nodes share one)', `${codes} vs ${wantCodes}`);
    ok(new RegExp(`_divideRequest\\[idx\\] = ${codes[0]};`).test(r.behaviourCode)
      && new RegExp(`_divideRequest\\[idx\\] = ${codes[1]};`).test(r.behaviourCode),
      'JS emits BOTH partition codes into the existing divideRequest cell');
    // ORDER-INDEPENDENCE: compiling WASM FIRST (the parity harness's order) must
    // bake the SAME codes. This is the hazard the `_stopIdx` convention has.
    {
      const m2 = buildDivideModel();
      compileAgentGraphWasmForModel(migrateForHarness(m2));   // WASM first…
      const wasmFirst = m2.agentGraphNodes.filter(n => n.data.nodeType === 'divideAgent').map(n => dividePartitionCode(n.data.config));
      compileAgentGraph(m2.agentGraphNodes, m2.agentGraphEdges, migrateForHarness(m2));  // …then JS
      const then = m2.agentGraphNodes.filter(n => n.data.nodeType === 'divideAgent').map(n => dividePartitionCode(n.data.config));
      ok(wasmFirst.join(',') === codes.join(',') && then.join(',') === codes.join(','),
        'the codes are ORDER-INDEPENDENT and IDEMPOTENT (WASM-first gives the same numbers)',
        `${wasmFirst} / ${then} vs ${codes}`);
    }
    // WebGPU emits the same codes.
    const gpu = compileAgentGraphWebGPUForModel(migrateForHarness(model));
    const gpuSrc = gpu?.shaderCode ?? '';
    // The WGSL writes the run by BASE (`agentF32[<base>u + idx] = <code>.0;`), so
    // anchor on the divideRequest run's own base rather than on the field name.
    const drBase = gpu?.layout?.f32Base?.divideRequest ?? -1;
    const drWrite = drBase === 0 ? 'agentF32[idx] = ' : `agentF32[${drBase}u + idx] = `;
    ok(!gpu.error && gpuSrc.includes(`${drWrite}1.0;`) && gpuSrc.includes(`${drWrite}2.0;`),
      'WebGPU emits the same 1-based codes (exact in f32, ROUNDED on readback)',
      gpu?.error ?? `no "${drWrite}{1,2}.0;" in the shader`);
    // WASM compiles + differs from the single-default variant (the code is baked).
    const wasmOk = isAgentGraphWasmSupported(migrateForHarness(model));
    ok(wasmOk, 'the WASM gate accepts a divide-partition model (no new node type, no new lane)');
    // BYTE IDENTITY at the emit level: a model whose ONLY Divide Agent node uses a
    // non-default partition still emits code 1 — the mode lives in the TABLE, so
    // switching modes cannot move a single byte of any target's output.
    {
      const m1 = buildDivideModel({ single: 'tension' }), m2 = buildDivideModel({ single: 'alternate' });
      const r1 = compileAgentGraph(m1.agentGraphNodes, m1.agentGraphEdges, migrateForHarness(m1));
      const r2 = compileAgentGraph(m2.agentGraphNodes, m2.agentGraphEdges, migrateForHarness(m2));
      ok(r1.behaviourCode === r2.behaviourCode,
        'a single-node model emits IDENTICAL code for tension and alternate (the mode rides the table)');
      ok(r1.dividePartitions[0].mode === 'tension' && r2.dividePartitions[0].mode === 'alternate',
        'and the two shipped TABLES differ — which is where the mode actually lives');
      const w1 = compileAgentGraphWasmForModel(migrateForHarness(m1));
      const w2 = compileAgentGraphWasmForModel(migrateForHarness(m2));
      ok(w1.bytes && w2.bytes && w1.bytes.length === w2.bytes.length
        && w1.bytes.every((b, i) => b === w2.bytes[i]),
        'WASM bytes are identical too');
    }
  }
}

/** An agent graph with three Divide Agent nodes: two default (tension) and one
 *  `byBondAttribute`, so the compiler's table must DEDUPE to two entries. */
function buildDivideModel({ single = null } = {}) {
  // DETERMINISTIC ids: the byte-identity assertion below compares two models'
  // emitted code, and a random id would make them differ for a reason that has
  // nothing to do with the partition.
  let seq = 0;
  const nid = (p) => `${p}${seq++}`;
  const aN = [], aEd = [];
  const an = (t, c) => { const n = { id: nid('a'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; aN.push(n); return n; };
  const aE = (s2, sp, tt, tp, cat) => aEd.push({ id: nid('e'), source: s2.id, target: tt.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
  const bs = an('behaviourStep', {});
  const chain = single
    ? [an('divideAgent', { partition: single, partitionAttributeId: single === 'byBondAttribute' ? 'kind' : '', daughterBond: 'auto' })]
    : [
      an('divideAgent', { partition: 'tension', daughterBond: 'auto' }),
      an('divideAgent', { partition: 'byBondAttribute', partitionAttributeId: 'kind', partTag_1: true, daughterBond: 'auto' }),
      an('divideAgent', { partition: 'tension', daughterBond: 'auto' }),
    ];
  aE(bs, 'do', chain[0], 'do', 'flow');
  for (let i = 1; i < chain.length; i++) aE(chain[i - 1], 'next', chain[i], 'do', 'flow');
  return {
    schemaVersion: 1,
    properties: { name: 'Divide Partition Test', dimension: '2d', gridWidth: 32, gridHeight: 32, gridDepth: 1, topology: '2d-grid', boundaryTreatment: 'torus', useWasm: false, useWebGPU: false },
    topologyMode: { gridCells: false, agents: true },
    centerBased: {
      enabled: true, maxAgents: 64, maxBonds: 6, worldWidth: 32, worldHeight: 32, seedCount: 8,
      seedPattern: 'scatter', defaultRadius: 0.5, growthRate: 0, repulsionStiffness: 0, adhesionStiffness: 0,
      interactionRange: 1.5, drag: 1, timeStep: 0.1, momentum: 0, maxSpeed: 0, neighbourQueryRadius: 8,
      useBondingPhysics: false, autoBond: false, bondStiffness: 1, bondRestLength: 1, formDistance: 1.2,
      breakDistance: 2.0, agentTarget: 'wasm', agentUpdateMode: 'async', bondRequestDepth: 8,
      agentCapabilities: AGENT_CAPS({ bonds: 'data', division: true }),
    },
    attributes: [], modelAttributes: [], neighborhoods: [],
    agentAttributes: [],
    bondAttributes: [{ id: 'kind', name: 'Kind', type: 'tag', defaultValue: '0', description: '', tagOptions: ['apical', 'basal'] }],
    variables: [], agentVariables: [], indicators: [], mappings: [],
    graphNodes: [], graphEdges: [], agentGraphNodes: aN, agentGraphEdges: aEd, macroDefs: [],
  };
}

tierA();
tierB();
await tierC();
tierD();
tierE();
tierF();
tierG();
tierH();

console.log(`\n${fail === 0 ? 'GRAPH-REWRITE HARNESS ✓' : 'GRAPH-REWRITE HARNESS ✗'}  (${pass} passed, ${fail} failed)`);
rmSync(entryPath, { force: true });
rmSync(dir, { recursive: true, force: true });
if (fail > 0) process.exit(1);

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
  rewireBond, transferBond, breakBondBetween, hasBond, drainAgentBondRequests, clearAgentBondRequests,
} from '../src/simulator/engine/agentEngine.ts';
export { BOND_REQ_NONE, BOND_REQ_ID_BIAS, BOND_REQ_BETWEEN_SIGN, BOND_REQ_TRANSFER_SIGN, BOND_REQ_BREAK_BETWEEN_SIGN, BOND_REQUEST_NODE_TYPES, bondReqSlotsForModel, agentGraphUsesBondRequests } from '../src/modeler/vpl/compiler/bondRequestQueue.ts';
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
export { resolveAxes } from '../src/modeler/vpl/compiler/variegation.ts';
export { buildAgentAbiArgs } from '../src/modeler/vpl/compiler/agentAbi.ts';
export { agentUsesDivisionSibling, agentUsesDivisionRequests } from '../src/modeler/vpl/compiler/divisionUse.ts';
export { migrateForHarness } from '../src/dev/compileHarness.ts';
export { migrateFormBondBetween } from '../src/model/formBondBetweenMigration.ts';
export { resolveAgentFieldGates } from '../src/model/agentFieldGating.ts';
export { agentAttrsOf, cellFieldAttrsOf } from '../src/model/attributeScope.ts';
export { expandNeighbourCensus, buildCensusPorts, censusOptions, censusAttribute } from '../src/modeler/vpl/compiler/censusExpand.ts';
export { getEffectivePorts } from '../src/modeler/vpl/effectivePorts.ts';
export {
  computeGraphMetrics, isGraphFrequencyMetric, graphMetricDataType, degreeHistogramKeys,
  GRAPH_METRICS, GRAPH_METRIC_INFO, DEFAULT_GRAPH_METRIC,
} from '../src/simulator/engine/graphMetrics.ts';
export { designTimeSeriesKeys } from '../src/simulator/indicatorChartSettings.ts';
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
  rewireBond, transferBond, breakBondBetween, hasBond, drainAgentBondRequests, clearAgentBondRequests,
  BOND_REQ_NONE, BOND_REQ_ID_BIAS, BOND_REQ_BETWEEN_SIGN, BOND_REQ_TRANSFER_SIGN, BOND_REQ_BREAK_BETWEEN_SIGN, BOND_REQUEST_NODE_TYPES,
  bondReqSlotsForModel, agentGraphUsesBondRequests, resolveBondRequestDepth,
  DEFAULT_DIVIDE_PARTITION, dividePartitionFromConfig, dividePartitionKey, dividePartitionCode, detectMissingConfig,
  compileAgentGraphWasmForModel, instantiateAgentWasm, buildAgentLayoutExtras, isAgentGraphWasmSupported,
  compileAgentGraphWebGPUForModel, isAgentGraphWebGPUSupported, compileAgentGraphWebGPU,
  agentWebGPUExtrasOf, computeAgentWebGPULayout,
  compileAgentGraph, resolveAxes, buildAgentAbiArgs, migrateForHarness, migrateFormBondBetween, agentAttrsOf, cellFieldAttrsOf,
  resolveAgentFieldGates,
  expandNeighbourCensus, buildCensusPorts, censusOptions, censusAttribute, getEffectivePorts,
  computeGraphMetrics, isGraphFrequencyMetric, graphMetricDataType, degreeHistogramKeys,
  GRAPH_METRICS, GRAPH_METRIC_INFO, DEFAULT_GRAPH_METRIC, designTimeSeriesKeys,
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
  // C9 — the plain store MUST use the same field gating the wasmBacked one gets
  // via `layoutExtras` (buildAgentLayoutExtras resolves it from the model). The
  // gated fields are MID-LIST in the ABI, so an ungated store here disagrees with
  // the compiled param list and every later argument shifts — silently, since a
  // shifted typed array is still an object.
  const fieldGates = layoutExtras.fieldGates;
  const A = createAgentStore(cfg, specs, { wasmBacked: false, syncAttrs, bondReqSlots, fieldGates });
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
    generation: 0,
  };
  // L2/L3 — the generation ALWAYS rides the arg list (params <= args is the safe
  // direction; the compiler decides the PARAM side from the graph). Without it a
  // cadence-gated rule reads `undefined % period`, never fires, and the tier
  // silently passes on a model that did nothing at all.
  const shape = { is3d: false, agentAttrs: A.attrSpecs, fieldAttrs: cellFieldAttrsOf(model), hasLookupTables, usesGeneration: true, gates: fieldGates };

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
      // the WASM surfaces read the generation from a MEMORY CELL, not a param
      new Uint32Array(buf, BL.generationOffset, 1)[0] = ctx.generation >>> 0;
      inst.behaviour(B.highWater, hv, nx, ny, nz, bx, by, bz, W, H, D, torus ? 1 : 0, ox, oy, oz);
    }
    if (syncAttrs) {
      for (const sp of A.attrSpecs) { const t = A.attrRead[sp.id]; A.attrRead[sp.id] = A.attrWrite[sp.id]; A.attrWrite[sp.id] = t; }
      if (B) for (const sp of B.attrSpecs) B.attrRead[sp.id].set(B.attrWrite[sp.id]);
    }
    ctx.generation++;   // the worker bumps at the END of a step (L2 pinned semantics)
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

  // --- 8. D2 — what the split CONSERVES (area, the default, vs volume in 3D)
  {
    const M3D = { properties: { dimension: '3d', gridDepth: 16 } };
    const M2D = { properties: { dimension: '2d', gridDepth: 1 } };

    // (a) THE BYTE-IDENTITY MECHANISM, asserted against the LITERAL pre-D2 key.
    //     `area` appends nothing, so every existing spec's key — and therefore
    //     the key-sorted table order, and therefore every `_divideIdx` — is
    //     unchanged. (A hard-coded string, not a re-derivation: a re-derivation
    //     would move with the code it is meant to pin.)
    ok(dividePartitionKey(DEFAULT_DIVIDE_PARTITION) === 'tension||0.5||auto',
      'D2: an AREA spec keys EXACTLY as it did pre-D2 (no suffix ⇒ unchanged sort order ⇒ unchanged codes)',
      dividePartitionKey(DEFAULT_DIVIDE_PARTITION));
    ok(dividePartitionKey({ ...DEFAULT_DIVIDE_PARTITION, conserve: 'volume' }) === 'tension||0.5||auto|volume',
      'D2: a VOLUME spec appends the suffix (a distinct table entry)',
      dividePartitionKey({ ...DEFAULT_DIVIDE_PARTITION, conserve: 'volume' }));
    // NEG — the two keys must actually DIFFER, else the table would dedupe them.
    ok(dividePartitionKey(DEFAULT_DIVIDE_PARTITION) !== dividePartitionKey({ ...DEFAULT_DIVIDE_PARTITION, conserve: 'volume' }),
      'D2: NEG — area and volume are NOT the same key');

    // (b) THE RESOLVER: absent ⇒ area; volume honoured in 3D; COERCED in 2D (a
    //     hidden control must have its STATE handled — a hand-edited 2D file
    //     cannot silently change behaviour).
    ok(dividePartitionFromConfig({}, M3D).conserve === 'area', 'D2: an absent conserve resolves to AREA');
    ok(dividePartitionFromConfig({ conserve: 'volume' }, M3D).conserve === 'volume',
      'D2: conserve=volume is honoured in a 3D model');
    ok(dividePartitionFromConfig({ conserve: 'volume' }, M2D).conserve === 'area',
      'D2: conserve=volume is COERCED to area in a 2D model');
    ok(dividePartitionKey(dividePartitionFromConfig({ conserve: 'volume' }, M2D)) === 'tension||0.5||auto',
      'D2: …so a 2D model\'s key (and code) is byte-identical whatever the config says');
    ok(dividePartitionFromConfig({ conserve: 'nonsense' }, M3D).conserve === 'area',
      'D2: an unknown conserve value falls back to area (closed enum, no badge needed)');

    // (c) THE ENGINE — run the SHIPPED `divideAgent` and read the radii back.
    const REL = (a, b) => Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(b));
    const spec = (conserve) => ({ ...DEFAULT_DIVIDE_PARTITION, conserve });
    const oneAgent = (r) => {
      const s = createAgentStore(bondCfg(16, 8), [], { bondAttrSpecs: P5_SPECS });
      seedAgents(s, [{ x: 16, y: 16, z: 8 }], r);
      s.radius[0] = r;
      return s;
    };
    const R = 2.5, D3 = 16;
    {   // symmetric VOLUME split in 3D: rA = rB = r·∛0.5, and rA³ + rB³ = r³.
      const s = oneAgent(R);
      const nid = divideAgent(s, 0, 1, 0, 0, 0.5, 0, false, 64, 64, D3, undefined, spec('volume'));
      const rA = s.radius[0], rB = s.radius[nid];
      ok(REL(rA, R * Math.cbrt(0.5)) && REL(rB, R * Math.cbrt(0.5)),
        'D2 volume (3D): each daughter is r·∛0.5 = 0.7937·r', `${rA} / ${rB} vs ${R * Math.cbrt(0.5)}`);
      ok(REL(rA ** 3 + rB ** 3, R ** 3),
        'D2 volume (3D): rA³ + rB³ = r³ — the VOLUME is conserved', `${rA ** 3 + rB ** 3} vs ${R ** 3}`);
    }
    {   // the DEFAULT (area) split in 3D is UNCHANGED — and demonstrably loses
      //  ~29 % of the volume, which is the whole reason the option exists.
      const s = oneAgent(R);
      const nid = divideAgent(s, 0, 1, 0, 0, 0.5, 0, false, 64, 64, D3, undefined, spec('area'));
      const rA = s.radius[0], rB = s.radius[nid];
      ok(REL(rA, R * Math.sqrt(0.5)) && REL(rA ** 2 + rB ** 2, R ** 2),
        'D2 area (3D, the default): rA² + rB² = r² — the historical split', `${rA} / ${rA ** 2 + rB ** 2} vs ${R ** 2}`);
      ok(REL((rA ** 3 + rB ** 3) / R ** 3, Math.SQRT1_2),
        'D2 area (3D): …and it keeps only 1/√2 ≈ 70.7 % of the volume (the ~29 % loss)',
        String((rA ** 3 + rB ** 3) / R ** 3));
      // NEG — the two modes must give DIFFERENT radii, else nothing above is
      // discriminating.
      const s2 = oneAgent(R);
      const n2 = divideAgent(s2, 0, 1, 0, 0, 0.5, 0, false, 64, 64, D3, undefined, spec('volume'));
      ok(!REL(s2.radius[0], rA) && s2.radius[0] > rA,
        'D2: NEG — volume radii DIFFER from (and exceed) the area radii', `${s2.radius[0]} vs ${rA}`);
      void n2;
    }
    {   // ASYMMETRIC volume split — each daughter's own cube root, still exact.
      const f = 0.3, s = oneAgent(R);
      const nid = divideAgent(s, 0, 1, 0, 0, f, 0, false, 64, 64, D3, undefined, spec('volume'));
      ok(REL(s.radius[0], R * Math.cbrt(f)) && REL(s.radius[nid], R * Math.cbrt(1 - f))
        && REL(s.radius[0] ** 3 + s.radius[nid] ** 3, R ** 3),
        'D2 volume (3D, asymmetric f=0.3): rA = r·∛f, rB = r·∛(1−f), rA³ + rB³ = r³',
        `${s.radius[0]} / ${s.radius[nid]}`);
    }
    {   // THE 2D COERCION, in the ENGINE (D <= 1) — bit-identical to the area run,
      //  so a spec that reached the worker without a model cannot change a 2D
      //  model's behaviour.
      const sa = oneAgent(R), sv = oneAgent(R);
      const na = divideAgent(sa, 0, 1, 0, 0, 0.5, 0, false, 64, 64, 1, undefined, spec('area'));
      const nv = divideAgent(sv, 0, 1, 0, 0, 0.5, 0, false, 64, 64, 1, undefined, spec('volume'));
      ok(Object.is(sa.radius[0], sv.radius[0]) && Object.is(sa.radius[na], sv.radius[nv]),
        'D2: in 2D (D = 1) the ENGINE coerces volume ⇒ BIT-IDENTICAL radii to the area split',
        `${sa.radius[0]}/${sa.radius[na]} vs ${sv.radius[0]}/${sv.radius[nv]}`);
    }

    // (d) THE TRANSPORT — the mode rides the TABLE, so it moves no emitted byte.
    {
      const m = buildDivideModel({ conserve: 'both', is3d: true });
      const r = compileAgentGraph(m.agentGraphNodes, m.agentGraphEdges, migrateForHarness(m));
      ok(!r.error && r.dividePartitions.length === 2,
        'D2: two nodes differing ONLY in conserve produce TWO table entries', r.error ?? String(r.dividePartitions.length));
      const dNodes = m.agentGraphNodes.filter(n => n.data.nodeType === 'divideAgent');
      const codes = dNodes.map(n => dividePartitionCode(n.data.config));
      ok(codes[0] !== codes[1], 'D2: …and the two nodes carry DIFFERENT codes', String(codes));
      ok(r.dividePartitions.some(p => p.conserve === 'area') && r.dividePartitions.some(p => p.conserve === 'volume'),
        'D2: the shipped table carries both conserve modes', JSON.stringify(r.dividePartitions.map(p => p.conserve)));
      // A SINGLE-node model emits IDENTICAL code + WASM bytes either way.
      const m1 = buildDivideModel({ single: 'tension', conserve: 'area', is3d: true });
      const m2 = buildDivideModel({ single: 'tension', conserve: 'volume', is3d: true });
      const r1 = compileAgentGraph(m1.agentGraphNodes, m1.agentGraphEdges, migrateForHarness(m1));
      const r2 = compileAgentGraph(m2.agentGraphNodes, m2.agentGraphEdges, migrateForHarness(m2));
      ok(r1.behaviourCode === r2.behaviourCode,
        'D2: a single-node model emits IDENTICAL JS for area and volume (the mode rides the table)');
      ok(r1.dividePartitions[0].conserve === 'area' && r2.dividePartitions[0].conserve === 'volume',
        'D2: and the two shipped TABLES differ — which is where the mode actually lives');
      const w1 = compileAgentGraphWasmForModel(migrateForHarness(m1));
      const w2 = compileAgentGraphWasmForModel(migrateForHarness(m2));
      ok(w1.bytes && w2.bytes && w1.bytes.length === w2.bytes.length && w1.bytes.every((b, i) => b === w2.bytes[i]),
        'D2: WASM bytes are identical too');
    }

    // (e) `myVolume` — the 3D-only value-out, USAGE-GATED on JS so an unwired
    //     port costs nothing (that gate is what keeps every 3D agent model's
    //     `agent.behaviourCode` byte-identical).
    {
      const mk = (wire) => {
        let seq = 0;
        const nid = (p) => `${p}${seq++}`;
        const aN = [], aEd = [];
        const an = (t, c) => { const n = { id: nid('a'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; aN.push(n); return n; };
        const bs = an('behaviourStep', {});
        const set = an('setAttribute', { attributeId: 'v' });
        aEd.push({ id: nid('e'), source: bs.id, target: set.id, sourceHandle: 'output_flow_do', targetHandle: 'input_flow_do' });
        if (wire) aEd.push({ id: nid('e'), source: bs.id, target: set.id, sourceHandle: `output_value_${wire}`, targetHandle: 'input_value_value' });
        const m = buildDivideModel({ single: 'tension', is3d: true });
        return { ...m, agentGraphNodes: aN, agentGraphEdges: aEd,
          agentAttributes: [{ id: 'v', name: 'V', type: 'float', defaultValue: '0' }] };
      };
      const none = compileAgentGraph(...(() => { const m = mk(null); return [m.agentGraphNodes, m.agentGraphEdges, migrateForHarness(m)]; })());
      const vol = compileAgentGraph(...(() => { const m = mk('myVolume'); return [m.agentGraphNodes, m.agentGraphEdges, migrateForHarness(m)]; })());
      ok(!none.behaviourCode.includes('_myVolume'),
        'D2: an UNWIRED myVolume emits NOTHING (the usage gate — byte-identity for every existing 3D model)');
      ok(/_myVolume = Math\.PI \* 4 \/ 3 \* _agentRadius\[idx\] \* _agentRadius\[idx\] \* _agentRadius\[idx\];/.test(vol.behaviourCode),
        'D2: a WIRED myVolume emits (4/3)πr³ on JS');
      // 2D hides the port, so it can only be reached by a STALE edge (a model
      // authored in 3D, then switched). All three targets then resolve it to the
      // typed default 0 — the C9 `myAge` safety-catch shape, one step stronger
      // than the `myZ` precedent (which emits nothing and leaves the reference
      // dangling). What must NEVER appear in 2D is the sphere formula.
      const m2d = (() => { const m = mk('myVolume'); return { ...m, properties: { ...m.properties, dimension: '2d', gridDepth: 1 } }; })();
      const two = compileAgentGraph(m2d.agentGraphNodes, m2d.agentGraphEdges, migrateForHarness(m2d));
      ok(/_myVolume = 0;/.test(two.behaviourCode) && !two.behaviourCode.includes('4 / 3'),
        'D2: in 2D a stale myVolume edge resolves to the typed default 0 (never a dangling reference)');
      // WASM + WebGPU emit it on demand (no usage gate needed — they are
      // per-port emitters), and only in 3D on the GPU.
      const mw = mk('myVolume');
      const w = compileAgentGraphWasmForModel(migrateForHarness(mw));
      ok(!w.error && w.bytes.length > 0, 'D2: a myVolume model compiles on WASM', w.error ?? '');
      const wNone = compileAgentGraphWasmForModel(migrateForHarness(mk(null)));
      ok(w.bytes.length !== wNone.bytes.length || !w.bytes.every((b, i) => b === wNone.bytes[i]),
        'D2: …and its WASM bytes DIFFER from the unwired model (the port really emits)');
      const g = compileAgentGraphWebGPUForModel(migrateForHarness(mw));
      ok(!g.error && /3\.14159265358979 \* 4\.0 \/ 3\.0/.test(g.shaderCode ?? ''),
        'D2: WebGPU emits (4/3)πr³ for myVolume', g.error ?? 'no (4/3)π in the shader');
      // THE EDITOR SURFACE — `hiddenPorts` through the SAME resolver the canvas and
      // drag-and-drop read, so what the user can wire matches what compiles.
      const outs = (t, model) => getEffectivePorts(t, {}, model).outputs.map(p => p.id);
      const m3 = migrateForHarness(buildDivideModel({ single: 'tension', is3d: true }));
      const m2 = migrateForHarness(buildDivideModel({ single: 'tension' }));
      ok(outs('behaviourStep', m3).includes('myVolume') && outs('divisionEvent', m3).includes('myVolume'),
        'D2: Volume is offered on BOTH roots in a 3D model');
      ok(!outs('behaviourStep', m2).includes('myVolume') && !outs('divisionEvent', m2).includes('myVolume'),
        'D2: …and on NEITHER in a 2D model (hiddenPorts)');
      ok(outs('behaviourStep', m3).includes('myArea') && outs('behaviourStep', m2).includes('myArea'),
        'D2: NEG — Area is offered in BOTH dimensions (πr², unchanged), so the check above is about Volume alone');
      // Volume follows Area into the Body capability's bucket. NB the profile is
      // USAGE-WIDENED (`resolveAgentProfile` -> `inferAgentProfile`), so the model
      // must carry no body-implying node — a Divide Agent alone widens body back
      // on via the closure — hence the bare behaviourStep graph here.
      const noBody = {
        ...m3,
        agentGraphNodes: [{ id: 'bs', type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: 'behaviourStep', config: {} } }],
        agentGraphEdges: [],
        centerBased: { ...m3.centerBased, agentCapabilities: { ...m3.centerBased.agentCapabilities, body: false, division: false, growth: false, collision: 'off' } },
      };
      const nb = outs('behaviourStep', noBody);
      ok(!nb.includes('myVolume') && !nb.includes('myArea'),
        'D2: Volume follows Area — both hidden when the Body capability is off', nb.join(','));
    }
  }
}

/** An agent graph with three Divide Agent nodes: two default (tension) and one
 *  `byBondAttribute`, so the compiler's table must DEDUPE to two entries. */
function buildDivideModel({ single = null, conserve = null, is3d = false } = {}) {
  // DETERMINISTIC ids: the byte-identity assertion below compares two models'
  // emitted code, and a random id would make them differ for a reason that has
  // nothing to do with the partition.
  let seq = 0;
  const nid = (p) => `${p}${seq++}`;
  const aN = [], aEd = [];
  const an = (t, c) => { const n = { id: nid('a'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; aN.push(n); return n; };
  const aE = (s2, sp, tt, tp, cat) => aEd.push({ id: nid('e'), source: s2.id, target: tt.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
  const bs = an('behaviourStep', {});
  const chain = conserve === 'both'
    // D2 — TWO nodes identical in every way EXCEPT `conserve`, so the table must
    // hold two entries and the two nodes must carry different codes.
    ? [
      an('divideAgent', { partition: 'tension', daughterBond: 'auto', conserve: 'area' }),
      an('divideAgent', { partition: 'tension', daughterBond: 'auto', conserve: 'volume' }),
    ]
    : single
    ? [an('divideAgent', { partition: single, partitionAttributeId: single === 'byBondAttribute' ? 'kind' : '', daughterBond: 'auto', ...(conserve ? { conserve } : {}) })]
    : [
      an('divideAgent', { partition: 'tension', daughterBond: 'auto' }),
      an('divideAgent', { partition: 'byBondAttribute', partitionAttributeId: 'kind', partTag_1: true, daughterBond: 'auto' }),
      an('divideAgent', { partition: 'tension', daughterBond: 'auto' }),
    ];
  aE(bs, 'do', chain[0], 'do', 'flow');
  for (let i = 1; i < chain.length; i++) aE(chain[i - 1], 'next', chain[i], 'do', 'flow');
  return {
    schemaVersion: 1,
    properties: { name: 'Divide Partition Test', dimension: is3d ? '3d' : '2d', gridWidth: 32, gridHeight: 32, gridDepth: is3d ? 16 : 1, topology: '2d-grid', boundaryTreatment: 'torus', useWasm: false, useWebGPU: false },
    topologyMode: { gridCells: false, agents: true },
    centerBased: {
      enabled: true, maxAgents: 64, maxBonds: 6, worldWidth: 32, worldHeight: 32, worldDepth: is3d ? 16 : 1, seedCount: 8,
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

// ===========================================================================
// TIER I — GRAPH INDICATORS (P6): exactness, fragmentation, opt-in cost
// ===========================================================================
//
// The exactness oracle. Every metric the worker ships is compared against an
// INDEPENDENTLY WRITTEN recount here — deliberately using a DIFFERENT algorithm
// shape where one exists (`refComponents` is a BFS flood fill, not a second
// union-find), so a shared bug is implausible rather than merely unlikely.
//
// `edgeCount` IS invariant I1: the shipped metric computes Σ deg / 2 while the
// reference counts DISTINCT unordered live pairs. Those two agree exactly iff the
// handshake lemma holds — so the metric and the invariant validate each other.

/** Reference node count — scan `alive` (the shipped metric uses the store's own
 *  `liveCount`, so this also cross-checks that bookkeeping). */
function refNodeCount(g) {
  let n = 0;
  for (let i = 0; i < g.highWater; i++) if (g.alive[i]) n++;
  return n;
}
/** Reference edge count — DISTINCT unordered live pairs (not Σ deg / 2). */
function refEdgeCount(g) {
  const seen = new Set();
  for (let i = 0; i < g.highWater; i++) {
    if (!g.alive[i]) continue;
    for (let k = 0; k < g.bondCount[i]; k++) {
      const p = g.bondPartner[i * g.maxBonds + k];
      if (p < 0 || p >= g.highWater || !g.alive[p] || p === i) continue;
      seen.add(i < p ? `${i}:${p}` : `${p}:${i}`);
    }
  }
  return seen.size;
}
/** Reference degree histogram — a DIRECT bondCount tally over live agents. */
function refDegreeHistogram(g) {
  const h = {};
  for (let d = 0; d <= g.maxBonds; d++) h[String(d)] = 0;
  for (let i = 0; i < g.highWater; i++) {
    if (!g.alive[i]) continue;
    h[String(g.bondCount[i])] = (h[String(g.bondCount[i])] ?? 0) + 1;
  }
  return h;
}
function refDegreeStats(g) {
  let sum = 0, max = 0, n = 0;
  for (let i = 0; i < g.highWater; i++) {
    if (!g.alive[i]) continue;
    n++; sum += g.bondCount[i];
    if (g.bondCount[i] > max) max = g.bondCount[i];
  }
  return { mean: n > 0 ? sum / n : 0, max };
}
/** Reference connected components — BFS FLOOD FILL over an explicitly built
 *  adjacency list. Structurally different from the shipped union-find, so the
 *  two agreeing is real evidence rather than a mirror. */
function refComponents(g) {
  const adj = new Map();
  const live = [];
  for (let i = 0; i < g.highWater; i++) if (g.alive[i]) { live.push(i); adj.set(i, []); }
  for (const i of live) {
    for (let k = 0; k < g.bondCount[i]; k++) {
      const p = g.bondPartner[i * g.maxBonds + k];
      if (p < 0 || p >= g.highWater || !g.alive[p] || p === i) continue;
      adj.get(i).push(p);
    }
  }
  const seen = new Set();
  let comps = 0;
  for (const start of live) {
    if (seen.has(start)) continue;
    comps++;
    const q = [start];
    seen.add(start);
    while (q.length) {
      const v = q.pop();
      for (const w of adj.get(v) ?? []) if (!seen.has(w)) { seen.add(w); q.push(w); }
      // BFS/DFS over an undirected list: also walk the REVERSE direction so a
      // one-sided bond still joins (matches the shipped union-both-ways rule).
      for (const w of live) {
        if (seen.has(w)) continue;
        if ((adj.get(w) ?? []).includes(v)) { seen.add(w); q.push(w); }
      }
    }
  }
  return comps;
}
/** All six references at once, keyed like the shipped result object. */
function refAllMetrics(g, liveCount) {
  const st = refDegreeStats(g);
  return {
    nodeCount: liveCount ?? refNodeCount(g),
    edgeCount: refEdgeCount(g),
    meanDegree: st.mean,
    maxDegree: st.max,
    degreeHistogram: refDegreeHistogram(g),
    componentCount: refComponents(g),
  };
}
function sameMetric(a, b) {
  if (typeof a === 'number' || typeof b === 'number') return Object.is(a, b);
  const ka = Object.keys(a ?? {}).sort(), kb = Object.keys(b ?? {}).sort();
  if (ka.join(',') !== kb.join(',')) return false;
  return ka.every(k => a[k] === b[k]);
}
/** Compare the SHIPPED metrics against the references; returns null or a message. */
function metricMismatch(view, ref) {
  const got = computeGraphMetrics(view, GRAPH_METRICS);
  for (const k of GRAPH_METRICS) {
    if (!sameMetric(got[k], ref[k])) {
      return `${k}: shipped ${JSON.stringify(got[k])} != reference ${JSON.stringify(ref[k])}`;
    }
  }
  return null;
}
/** The normalised view straight off a live store (what the worker feeds). */
function metricView(s) {
  return {
    highWater: s.highWater, maxBonds: s.maxBonds, liveCount: s.liveCount,
    alive: s.alive, bondCount: s.bondCount, bondPartner: s.bondPartner,
  };
}
/** A store of `n` seeded agents with a bond capacity of `mb`. */
// ===========================================================================
// TIER J — P4b: the FORM BETWEEN verb (third-party bond formation).
//
// The gate this tier exists for: the cubic TRIANGLE SPLIT must complete in ONE
// generation, so that O6 (`min deg == max deg == 3` and `E == 3N/2`) holds at
// EVERY generation, not merely between rule applications.
// ===========================================================================

/** Write ONE FORM BETWEEN entry, mirroring all three emitters: the op kind rides
 *  the SIGN of the break lane (negative), the ids carry the same `+2` bias. */
function queueBetween(st, i, c, { a = -1, b = -1, L = 0, K = 0 } = {}) {
  const slots = st.bondReqSlots, depth = slots - 1;
  const e = i * slots + Math.min(c, depth);
  const good = a >= 0 && b >= 0;
  st.bondBreakReq[e] = good ? -(a + BOND_REQ_ID_BIAS) : -BOND_REQ_NONE;
  st.bondFormReq[e] = good ? b + BOND_REQ_ID_BIAS : BOND_REQ_NONE;
  st.bondFormL[e] = L; st.bondFormK[e] = K;
}

/** A behaviour-pass spawn, byte-for-byte what the worker's grow-only
 *  `agentBehaviourCreate` + `agentBehaviourAddToWorld` closures do (and what the
 *  WebGPU readback's newborn reconcile does): grow-allocate beyond highWater,
 *  initialise the slot, then COMMIT it live. This is the ordering that makes a
 *  newborn a valid bond target in the SAME generation — the structural phase (and
 *  therefore the queue drain) runs strictly after the behaviour pass. */
function spawnLive(s, x, y, r = 0.5) {
  if (s.highWater >= s.maxAgents) return -1;
  const id = s.highWater++;
  initAgentSlot(s, id, x, y, 0, r, id);
  s.alive[id] = 1; s.liveCount++;
  return id;
}

/** A store with capacity for a growing cubic graph, seeded with K4 (4 agents,
 *  6 edges, every degree exactly 3 — the smallest cubic graph). */
function cubicK4(maxAgents, maxBonds, depth) {
  const s = createAgentStore(queueCfg(maxAgents, maxBonds, depth), []);
  s.worldWidth = 4096; s.worldHeight = 4096; s.worldDepth = 1;
  seedAgents(s, Array.from({ length: 4 }, (_, i) => ({ x: 1 + i, y: 1, radius: 0.5 })), 0.5);
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) formBond(s, i, j, 1, 1);
  return s;
}

/** The live partners of `v`, in slot order. */
const partnersOf = (s, v) =>
  Array.from({ length: s.bondCount[v] }, (_, k) => s.bondPartner[v * s.maxBonds + k]);

function tierJ() {
  section('TIER J — P4b: the Form Between encoding + the ONE-generation triangle split');

  // --- 0. registration + the usage gate cover the verb ---------------------
  //
  // The dedicated `formBondBetween` NODE was retired into Form Bond's optional
  // `agentA` port (formBondBetweenMigration.ts). The ENCODING below is unchanged;
  // only the second way of spelling it went away.
  {
    ok(BOND_REQUEST_NODE_TYPES.has('formBond'),
      'formBond is a queue verb (so the layout reserves the queue for it)');
    ok(!BOND_REQUEST_NODE_TYPES.has('formBondBetween'),
      'the retired formBondBetween node type is gone from the queue-verb set');
    const only = { agentGraphNodes: [{ id: 'a', data: { nodeType: 'formBond' } }], centerBased: {}, topologyMode: { agents: true } };
    ok(bondReqSlotsForModel(only) === 9,
      'a graph whose ONLY verb is Form Bond still reserves depth + the overflow bucket');
    const inMacro = { agentGraphNodes: [], macroDefs: [{ id: 'm', nodes: [{ id: 'a', data: { nodeType: 'formBond' } }] }], centerBased: {}, topologyMode: { agents: true } };
    ok(agentGraphUsesBondRequests(inMacro), 'a Form Bond inside a MACRO definition reserves the queue too');
    ok(BOND_REQ_BETWEEN_SIGN === -1, 'the op-kind marker is the break lane SIGN');
  }

  // --- 0b. THE RETIREMENT MIGRATION ---------------------------------------
  //
  // A legacy graph carrying the removed node type must load as the equivalent
  // Form Bond AND compile to the very same code — that equivalence is the whole
  // justification for retiring it.
  {
    const legacy = () => JSON.parse(JSON.stringify(betweenGraphNodesEdges('formBondBetween', 'agentB')));
    const l0 = legacy();
    const mig = migrateFormBondBetween({ agentGraphNodes: l0.nodes, agentGraphEdges: l0.edges, macroDefs: [] });
    const fb = mig.agentGraphNodes.find(n => n.id === 'fb');
    ok(fb.data.nodeType === 'formBond', 'migration: the node type becomes formBond');
    ok(!mig.agentGraphNodes.some(n => n.data.nodeType === 'formBondBetween'),
      'migration: no formBondBetween node survives');
    const handles = mig.agentGraphEdges.filter(e => e.target === 'fb').map(e => e.targetHandle).sort();
    ok(JSON.stringify(handles) === JSON.stringify(['input_flow_do', 'input_value_agentA', 'input_value_targetAgent']),
      'migration: agentB is re-pointed at targetAgent, agentA is left alone', JSON.stringify(handles));
    // Idempotent: a second pass returns the SAME model reference.
    ok(migrateFormBondBetween(mig) === mig, 'migration: idempotent (same reference on a clean model)');
    // A macroDef carrying one is migrated too.
    const l1 = legacy();
    const inMac = migrateFormBondBetween({ agentGraphNodes: [], agentGraphEdges: [], macroDefs: [{ id: 'm', nodes: l1.nodes, edges: l1.edges }] });
    ok(inMac.macroDefs[0].nodes.some(n => n.data.nodeType === 'formBond')
      && !inMac.macroDefs[0].nodes.some(n => n.data.nodeType === 'formBondBetween'),
      'migration: a formBondBetween inside a MACRO definition is migrated too');
    // THE EQUIVALENCE: the migrated graph emits exactly what the hand-authored
    // Form Bond emits — same node ids, same edge order, so the same code.
    const migrated = betweenEmitModel('formBondBetween', 'agentB');
    const native = betweenEmitModel('formBond', 'targetAgent');
    ok(!migrated.agentGraphNodes.some(n => n.data.nodeType === 'formBondBetween'),
      'migration: migrateForHarness (the LOAD_MODEL mirror) applies it too');
    const a = compileAgentGraph(migrated.agentGraphNodes, migrated.agentGraphEdges, migrated);
    const b = compileAgentGraph(native.agentGraphNodes, native.agentGraphEdges, native);
    ok(!a.error && !b.error, 'both the migrated and the hand-authored graph compile', String(a.error || b.error));
    ok(a.behaviourCode === b.behaviourCode,
      'migration: a migrated legacy graph emits BYTE-IDENTICAL JS to the hand-authored Form Bond');
    const aw = compileAgentGraphWasmForModel(migrated), bw = compileAgentGraphWasmForModel(native);
    ok(!aw.error && !bw.error && aw.bytes.length > 0
      && Buffer.compare(Buffer.from(aw.bytes), Buffer.from(bw.bytes)) === 0,
      'migration: ...and BYTE-IDENTICAL WASM module bytes', String(aw.error || bw.error));
  }

  // --- 1. the drain bonds the TWO NAMED AGENTS, not self ------------------
  //
  // This is the collision test: a Rewire fills BOTH lanes too, so if the sign were
  // ignored the entry would be applied as a plain self→B form — bonding the WRONG
  // pair with no error anywhere.
  {
    const st = queueStore(12, 4, 8);
    queueBetween(st, 0, 0, { a: 5, b: 7 });      // agent 0 asks for 5↔7
    drainAgentBondRequests(st, 1);
    ok(hasBond(st, 5, 7), 'Form Between bonds the two NAMED agents');
    ok(!hasBond(st, 0, 5) && !hasBond(st, 0, 7),
      'Form Between does NOT bond the requester to either endpoint');
    ok(allInvariants(st) === null, 'I1–I4 hold after a Form Between', String(allInvariants(st)));
    ok(st.bondCount[0] === 0, 'the requester\'s own degree is untouched');

    // NEGATIVE CONTROL: the SAME two ids with a POSITIVE break lane is the REWIRE
    // encoding and produces a different (here: empty) graph — proving the sign is
    // the load-bearing discriminator and this check is not vacuous.
    const st2 = queueStore(12, 4, 8);
    queueOp(st2, 0, 0, { from: 5, to: 7 });      // positive lanes ⇒ rewire(0, 5→7)
    drainAgentBondRequests(st2, 1);
    ok(!hasBond(st2, 5, 7),
      'negative control: the SAME ids with a POSITIVE break lane are a REWIRE, not a Form Between');

    // NEGATIVE CONTROL: an entry that only fills the FORM lane is a plain self-form
    // — the exact wrong result a sign-blind drain would produce.
    const st3 = queueStore(12, 4, 8);
    queueOp(st3, 0, 0, { to: 7 });
    drainAgentBondRequests(st3, 1);
    ok(hasBond(st3, 0, 7) && !hasBond(st3, 5, 7),
      'negative control: a sign-blind read of the entry would bond the REQUESTER to B');
  }

  // --- 2. semantics: self / dead / out of range / already bonded ----------
  {
    const st = queueStore(12, 4, 8);
    queueBetween(st, 0, 0, { a: 3, b: 3 });                 // a === b
    queueBetween(st, 0, 1, { a: 4, b: 999 });               // out of range
    queueBetween(st, 0, 2, { a: -1, b: 5 });                // unresolvable A
    freeAgentSlot(st, 9);
    queueBetween(st, 0, 3, { a: 6, b: 9 });                 // dead endpoint
    queueBetween(st, 0, 4, { a: 1, b: 2 });                 // a REAL one, after all of them
    drainAgentBondRequests(st, 1);
    ok(st.bondCount[3] === 0, 'a === b is a no-op');
    ok(st.bondCount[4] === 0, 'an out-of-range endpoint is a no-op');
    ok(st.bondCount[5] === 0, 'an unresolvable endpoint is a no-op');
    ok(st.bondCount[6] === 0, 'a DEAD endpoint is a no-op');
    ok(hasBond(st, 1, 2),
      'every rejected Form Between still OCCUPIES its entry (no queue truncation)');
    ok(allInvariants(st) === null, 'I1–I4 hold after the whole rejected batch');

    // idempotence — a second request for an existing edge changes nothing
    const before = edgeSet(decodeAgentGraph(st)).size;
    queueBetween(st, 0, 0, { a: 1, b: 2 });
    drainAgentBondRequests(st, 1);
    ok(edgeSet(decodeAgentGraph(st)).size === before, 'an already-bonded pair is a no-op (no double edge)');
  }

  // --- 3. I5 — a full endpoint rejects the WHOLE op ----------------------
  {
    for (const fullSide of ['A', 'B']) {
      const st = queueStore(14, 3, 8);
      // Fill agent 5's list (3 of 3).
      for (const k of [10, 11, 12]) formBond(st, 5, k, 1, 1);
      formBond(st, 7, 13, 1, 1);                            // agent 7 has room
      const before = edgeSet(decodeAgentGraph(st));
      const beforeMs = degreeMultiset(decodeAgentGraph(st));
      queueBetween(st, 0, 0, fullSide === 'A' ? { a: 5, b: 7 } : { a: 7, b: 5 });
      drainAgentBondRequests(st, 1);
      const after = edgeSet(decodeAgentGraph(st));
      ok(!hasBond(st, 5, 7), `I5 (${fullSide} full): the bond is not formed`);
      ok(st.bondCount[7] === 1, `I5 (${fullSide} full): the OTHER endpoint gains no half-bond`);
      ok(before.size === after.size && [...before].every(e => after.has(e)),
        `I5 (${fullSide} full): the graph is EXACTLY the pre-step graph`);
      ok(degreeMultiset(decodeAgentGraph(st)) === beforeMs,
        `I5 (${fullSide} full): the degree multiset is exactly unchanged`);
      ok(allInvariants(st) === null, `I5 (${fullSide} full): I1–I4 hold`);
    }
  }

  // --- 4. I2 — the created bond is symmetric in EVERY per-slot field ------
  {
    const specs = [
      { id: 'bw', type: 'float', defaultValue: 0 },
      { id: 'bk', type: 'integer', defaultValue: 0 },
    ];
    const s = createAgentStore(queueCfg(16, 4, 8), [], { bondAttrSpecs: specs });
    s.worldWidth = 64; s.worldHeight = 64; s.worldDepth = 1;
    seedAgents(s, Array.from({ length: 12 }, (_, i) => ({ x: 1 + i, y: 1, radius: 0.5 })), 0.5);
    const slots = s.bondReqSlots;
    const e = 0 * slots + 0;
    queueBetween(s, 0, 0, { a: 4, b: 9, L: 3.25, K: 7.5 });
    s.bondFormAttrs['bw'][e] = 2.75;
    s.bondFormAttrs['bk'][e] = 6;
    drainAgentBondRequests(s, 1);
    ok(hasBond(s, 4, 9), 'I2 setup: the Form Between bond exists');
    ok(checkBondSymmetry(decodeAgentGraph(s)) === null,
      'I2: the created bond agrees on EVERY per-slot field in both rows',
      String(checkBondSymmetry(decodeAgentGraph(s))));
    const slotOf = (i, p) => {
      for (let k = 0; k < s.bondCount[i]; k++) if (s.bondPartner[i * s.maxBonds + k] === p) return i * s.maxBonds + k;
      return -1;
    };
    const s49 = slotOf(4, 9), s94 = slotOf(9, 4);
    ok(s.bondRestLength[s49] === 3.25 && s.bondRestLength[s94] === 3.25,
      'I2: the requested rest length lands in BOTH slots', `${s.bondRestLength[s49]} / ${s.bondRestLength[s94]}`);
    ok(s.bondStiffness[s49] === 7.5 && s.bondStiffness[s94] === 7.5, 'I2: the stiffness lands in BOTH slots');
    ok(s.bondAttrs['bw'][s49] === 2.75 && s.bondAttrs['bw'][s94] === 2.75,
      'I2: the float bond attribute lands in BOTH slots');
    ok(s.bondAttrs['bk'][s49] === 6 && s.bondAttrs['bk'][s94] === 6,
      'I2: the integer bond attribute lands in BOTH slots');

    // The engine defaults when the request leaves L / K at 0: the contact distance
    // of the TWO NAMED AGENTS (not the requester's radii).
    const s2 = createAgentStore({ ...queueCfg(16, 4, 8) }, []);
    s2.worldWidth = 64; s2.worldHeight = 64; s2.worldDepth = 1;
    seedAgents(s2, Array.from({ length: 12 }, (_, i) => ({ x: 1 + i, y: 1, radius: 0.5 })), 0.5);
    s2.radius[4] = 2; s2.radius[9] = 3; s2.radius[0] = 100;
    queueBetween(s2, 0, 0, { a: 4, b: 9 });
    drainAgentBondRequests(s2, 1);
    const k49 = (() => { for (let k = 0; k < s2.bondCount[4]; k++) if (s2.bondPartner[4 * s2.maxBonds + k] === 9) return 4 * s2.maxBonds + k; return -1; })();
    ok(s2.bondRestLength[k49] === 5,
      'the default rest length is the NAMED pair\'s contact distance (2 + 3), not the requester\'s',
      String(s2.bondRestLength[k49]));
  }

  // --- 5. THE GATE — the cubic TRIANGLE SPLIT in ONE generation ----------
  //
  // v (deg 3, neighbours a,b,c) → v₁,v₂,v₃ with v₁–a, v₂–b, v₃–c and the triangle
  // v₁v₂, v₂v₃, v₃v₁. ΔN=+2, ΔE=+3, every degree stays 3.
  //
  // Expressed from v₁'s behaviour, as FIVE queue ops (plus 2 host Creates, which
  // consume no queue slot):
  //     rewire(from=b, to=v₂)      v₁ drops b, gains v₂   (atomic: deg stays 3)
  //     rewire(from=c, to=v₃)      v₁ drops c, gains v₃
  //     between(b, v₂)             b regains its third edge
  //     between(c, v₃)             c regains its third edge
  //     between(v₂, v₃)            ← THE EDGE NO SELF-RELATIVE VERB CAN MAKE
  // maxBonds is a TIGHT 3, so nothing may transiently exceed the cubic degree.
  {
    const SPLITS = 60, MB = 3;
    const st = cubicK4(4 + 2 * SPLITS + 8, MB, 8);
    const g0 = decodeAgentGraph(st);
    ok(checkDegreeRegular(g0, 3) === null && edgeSet(g0).size === 6,
      'O6 setup: K4 — 4 agents, 6 edges, every degree exactly 3', String(checkDegreeRegular(g0, 3)));

    let bad = null, splits = 0, ops = 0, maxOps = 0;
    for (let gen = 1; gen <= SPLITS && !bad; gen++) {
      // Pick the mother deterministically (round-robin over the live population).
      const live = [];
      for (let i = 0; i < st.highWater; i++) if (st.alive[i]) live.push(i);
      const v = live[(gen * 7) % live.length];
      const [a, b, c] = partnersOf(st, v);
      const nA = st.liveCount, nE = edgeSet(decodeAgentGraph(st)).size;

      // --- behaviour pass: create + commit the two newborns
      const v2 = spawnLive(st, st.x[v] + 0.25, st.y[v]);
      const v3 = spawnLive(st, st.x[v] - 0.25, st.y[v]);
      if (v2 < 0 || v3 < 0) { bad = `capacity exhausted at split ${gen}`; break; }
      // --- behaviour pass: queue the five ops on the MOTHER's own queue
      let k = 0;
      queueOp(st, v, k++, { from: b, to: v2 });
      queueOp(st, v, k++, { from: c, to: v3 });
      queueBetween(st, v, k++, { a: b, b: v2 });
      queueBetween(st, v, k++, { a: c, b: v3 });
      queueBetween(st, v, k++, { a: v2, b: v3 });
      ops = k; maxOps = Math.max(maxOps, k);

      // --- structural phase
      const overflow = drainAgentBondRequests(st, 1);
      if (overflow) { bad = `unexpected overflow at split ${gen}`; break; }

      // --- O6 IMMEDIATELY after the SAME generation
      const g = decodeAgentGraph(st);
      const reg = checkDegreeRegular(g, 3);
      if (reg) { bad = `gen ${gen}: O6 broken — ${reg}`; break; }
      const inv = allInvariants(st);
      if (inv) { bad = `gen ${gen}: ${inv}`; break; }
      const E = edgeSet(g).size;
      if (st.liveCount !== nA + 2) { bad = `gen ${gen}: ΔN = ${st.liveCount - nA} != +2`; break; }
      if (E !== nE + 3) { bad = `gen ${gen}: ΔE = ${E - nE} != +3`; break; }
      // the triangle is closed and a is still on the mother
      if (!(hasBond(st, v, v2) && hasBond(st, v, v3) && hasBond(st, v2, v3))) { bad = `gen ${gen}: the triangle is not closed`; break; }
      if (!(hasBond(st, v, a) && hasBond(st, b, v2) && hasBond(st, c, v3))) { bad = `gen ${gen}: the outer edges are wrong`; break; }
      splits++;
    }
    ok(bad === null, `THE GATE: ${SPLITS} triangle splits, each COMPLETE in ONE generation`, String(bad));
    ok(splits === SPLITS, `all ${SPLITS} splits applied`, `${splits}`);
    ok(maxOps === 5, 'the split costs FIVE queue ops (well inside the default depth of 8)', String(maxOps));
    const gEnd = decodeAgentGraph(st);
    ok(checkDegreeRegular(gEnd, 3) === null,
      `O6 at the end: min deg == max deg == 3 and E == 3N/2 (N=${st.liveCount})`, String(checkDegreeRegular(gEnd, 3)));
    ok(st.liveCount === 4 + 2 * SPLITS && edgeSet(gEnd).size === 6 + 3 * SPLITS,
      `the growth law holds exactly: N = 4 + 2t, E = 6 + 3t`,
      `N=${st.liveCount} E=${edgeSet(gEnd).size}`);

    // NEGATIVE CONTROL — the whole point of the phase. Run the SAME split WITHOUT
    // the v₂–v₃ Form Between (i.e. everything P4 alone could express) and prove
    // O6 FAILS immediately: two nodes sit at degree 2 and E != 3N/2.
    const stN = cubicK4(32, MB, 8);
    {
      const v = 0, [, b, c] = partnersOf(stN, v);
      const v2 = spawnLive(stN, 9, 9), v3 = spawnLive(stN, 9, 10);
      queueOp(stN, v, 0, { from: b, to: v2 });
      queueOp(stN, v, 1, { from: c, to: v3 });
      queueBetween(stN, v, 2, { a: b, b: v2 });
      queueBetween(stN, v, 3, { a: c, b: v3 });
      // (the v₂–v₃ edge deliberately omitted)
      drainAgentBondRequests(stN, 1);
      const g = decodeAgentGraph(stN);
      ok(checkDegreeRegular(g, 3) !== null,
        'negative control: WITHOUT the v₂–v₃ Form Between the split BREAKS O6 (the gate is not vacuous)',
        String(checkDegreeRegular(g, 3)));
      ok(edgeSet(g).size !== 3 * stN.liveCount / 2,
        'negative control: E != 3N/2 without that edge', `E=${edgeSet(g).size} N=${stN.liveCount}`);
      ok(allInvariants(stN) === null,
        'negative control: the graph is still CONSISTENT — only O6 fails (so O6 is really what is being tested)');
    }
  }

  // --- 6. the literal 7-op composition of the handoff also fits depth 8 ---
  //
  // 2 Form + 2 Break + 3 Form Between (v₁'s degree transiently reaches 5, so this
  // shape needs maxBonds >= 5) — recorded so P7 can pick either formulation.
  {
    const st = cubicK4(32, 6, 8);
    const v = 0, [a, b, c] = partnersOf(st, v);
    const v2 = spawnLive(st, 9, 9), v3 = spawnLive(st, 9, 10);
    let k = 0;
    queueOp(st, v, k++, { to: v2 });                 // form v₁–v₂   (deg 4)
    queueOp(st, v, k++, { to: v3 });                 // form v₁–v₃   (deg 5)
    queueOp(st, v, k++, { from: b });                // break v₁–b   (deg 4)
    queueOp(st, v, k++, { from: c });                // break v₁–c   (deg 3)
    queueBetween(st, v, k++, { a: b, b: v2 });
    queueBetween(st, v, k++, { a: c, b: v3 });
    queueBetween(st, v, k++, { a: v2, b: v3 });
    const overflow = drainAgentBondRequests(st, 1);
    const g = decodeAgentGraph(st);
    ok(k === 7 && overflow === false, 'the 7-op formulation fits the DEFAULT depth of 8 with no overflow');
    ok(checkDegreeRegular(g, 3) === null,
      'the 7-op formulation reaches the SAME cubic result in one generation', String(checkDegreeRegular(g, 3)));
    ok(hasBond(st, v, a) && hasBond(st, b, v2) && hasBond(st, c, v3) && hasBond(st, v2, v3),
      'the 7-op formulation closes the triangle and keeps a on the mother');
    ok(allInvariants(st) === null, 'the 7-op formulation: I1–I4 hold');
  }

  // --- 7. the emitters agree with the harness's encoding ------------------
  //
  // The helper above re-implements the lane encoding, so assert the SHIPPED JS
  // emitter produces the same shape (WASM/WebGPU are covered by the parity
  // synthetic and the emitted-shader checks).
  {
    const model = betweenEmitModel();
    const res = compileAgentGraph(model.agentGraphNodes, model.agentGraphEdges, model);
    const code = res.behaviourCode || '';
    ok(!res.error, 'the paired Form Bond graph compiles on the JS agent target', String(res.error));
    ok(/_bondBreakReq\[_bq\]\s*=\s*_bqOk\s*\?\s*-\(_bqA \+ 2\)\s*:\s*-1;/.test(code),
      'JS emit: the break lane is NEGATED (the op-kind marker)');
    ok(/_bondFormReq\[_bq\]\s*=\s*_bqOk\s*\?\s*_bqB \+ 2\s*:\s*1;/.test(code),
      'JS emit: the form lane carries B with the same +2 bias');
    ok(isAgentGraphWasmSupported(model), 'the WASM agent gate ACCEPTS the paired Form Bond');
    ok(isAgentGraphWebGPUSupported(model), 'the WebGPU agent gate ACCEPTS the paired Form Bond');
    const wg = compileAgentGraphWebGPUForModel(model);
    const wgsl = wg.shaderCode || '';
    ok(!wg.error && /= f32\(-select\(1, _brqA\d+ \+ 2, _brqOk\d+\)\);/.test(wgsl),
      'WGSL emit: the break lane is NEGATED via f32(-select(...)) (the op-kind marker)', String(wg.error));
    ok(/= f32\(select\(1, _brqB\d+ \+ 2, _brqOk\d+\)\);/.test(wgsl),
      'WGSL emit: the form lane carries B with the same +2 bias');
    ok(!/atomic/i.test(wgsl),
      'WGSL emit: still NO atomics anywhere (the ids are PAYLOAD on the requester\'s own rows, not addresses)');
  }

  // --- 8. the SPAWN-HANDLE shape the triangle split depends on --------------
  //
  // The split bonds agents it CREATED this generation, so the Create Agent handle
  // must survive as a VALUE into later flow nodes on every target. A pre-existing
  // WASM-only omission (`createAgent` missing from AGENT_VALUE_NO_HOIST, which the
  // WebGPU mirror always had) made exactly this shape fail to compile there —
  // "unsupported value node 'createAgent'" — silently clamping every behaviour-graph
  // spawning model to JS. Guarded here permanently because P4b's flagship rule needs it.
  {
    const model = spawnHandleModel();
    const w = compileAgentGraphWasmForModel(model);
    ok(isAgentGraphWasmSupported(model) && !w.error && w.bytes.length > 0,
      'a Create Agent handle consumed as a VALUE compiles on the WASM agent target', String(w.error));
    const g = compileAgentGraphWebGPUForModel(model);
    ok(isAgentGraphWebGPUSupported(model) && !g.error && (g.shaderCode || '').length > 0,
      'the same spawn-handle shape compiles on the WebGPU agent target', String(g.error));
    const js = compileAgentGraph(model.agentGraphNodes, model.agentGraphEdges, model);
    ok(!js.error, 'the same spawn-handle shape compiles on the JS agent target', String(js.error));
  }
}

/** Create Agent → Add To World → Form Between(handle, handle) — the spawn-handle
 *  shape the triangle split is built on, on all three targets. */
function spawnHandleModel() {
  let k = 0; const nid = () => 's' + (k++);
  const N = [], E = [];
  const an = (t, cfg = {}) => { const n = { id: nid(), position: { x: 0, y: 0 }, data: { nodeType: t, config: cfg } }; N.push(n); return n; };
  const ve = (s, sp, t, tp) => E.push({ id: nid(), source: s.id, target: t.id, sourceHandle: `output_value_${sp}`, targetHandle: `input_value_${tp}` });
  const fe = (s, sp, t) => E.push({ id: nid(), source: s.id, target: t.id, sourceHandle: `output_flow_${sp}`, targetHandle: 'input_flow_do' });
  const bs = an('behaviourStep', {});
  const c1 = an('createAgent', { _port_x: '5', _port_y: '5', _port_radius: '0.5' });
  const a1 = an('addAgentToWorld', {});
  const c2 = an('createAgent', { _port_x: '6', _port_y: '5', _port_radius: '0.5' });
  const a2 = an('addAgentToWorld', {});
  const fb = an('formBond', { _port_restLength: '1', _port_stiffness: '0' });
  ve(c1, 'handle', a1, 'handle'); ve(c2, 'handle', a2, 'handle');
  ve(c1, 'handle', fb, 'agentA'); ve(c2, 'handle', fb, 'targetAgent');
  fe(bs, 'do', c1); fe(c1, 'next', a1); fe(a1, 'next', c2); fe(c2, 'next', a2); fe(a2, 'next', fb);
  return {
    ...migrateForHarness({
      properties: { name: 'p4b-spawn', gridWidth: 32, gridHeight: 32, updateMode: 'synchronous' },
      topologyMode: { gridCells: false, agents: true },
      attributes: [], agentAttributes: [], neighborhoods: [], mappings: [], graphNodes: [], graphEdges: [],
      agentGraphNodes: N, agentGraphEdges: E,
      centerBased: { enabled: true, maxAgents: 64, maxBonds: 4, agentCapabilities: AGENT_CAPS({ bonds: 'data', populationBirth: true }) },
    }),
    agentGraphNodes: N, agentGraphEdges: E,
  };
}

/** The nodes+edges of a minimal behaviour that issues ONE two-id bond op, spelled
 *  with either the live `formBond`/`targetAgent` or the retired
 *  `formBondBetween`/`agentB` (so the migration can be checked for equivalence).
 *
 *  WARNING: `agentA` MUST be WIRED, not merely configured — the port carries no
 *  inline widget, so wiredness is the EDGE-map answer on all three targets, and a
 *  config-only `_port_agentA` would leave a Form Bond on its self-form arm. */
function betweenGraphNodesEdges(type = 'formBond', bPort = 'targetAgent') {
  const nodes = [
    { id: 'root', position: { x: 0, y: 0 }, data: { nodeType: 'behaviourStep', config: {} } },
    { id: 'ga', position: { x: 100, y: 0 }, data: { nodeType: 'getConstant', config: { constType: 'number', constValue: '1' } } },
    { id: 'gb', position: { x: 100, y: 80 }, data: { nodeType: 'getConstant', config: { constType: 'number', constValue: '2' } } },
    { id: 'fb', position: { x: 200, y: 0 }, data: { nodeType: type, config: { _port_restLength: '3', _port_stiffness: '4' } } },
  ];
  const edges = [
    { id: 'e0', source: 'root', sourceHandle: 'output_flow_do', target: 'fb', targetHandle: 'input_flow_do' },
    { id: 'e1', source: 'ga', sourceHandle: 'output_value_value', target: 'fb', targetHandle: 'input_value_agentA' },
    { id: 'e2', source: 'gb', sourceHandle: 'output_value_value', target: 'fb', targetHandle: 'input_value_' + bPort },
  ];
  return { nodes, edges };
}

/** A minimal agent model whose behaviour issues ONE two-id bond op. */
function betweenEmitModel(type = 'formBond', bPort = 'targetAgent') {
  const { nodes, edges } = betweenGraphNodesEdges(type, bPort);
  return {
    ...migrateForHarness({
      properties: { name: 'p4b-between', gridWidth: 32, gridHeight: 32, updateMode: 'synchronous' },
      topologyMode: { gridCells: false, agents: true },
      attributes: [], agentAttributes: [], neighborhoods: [], mappings: [], graphNodes: [], graphEdges: [],
      agentGraphNodes: nodes, agentGraphEdges: edges,
      centerBased: { enabled: true, maxAgents: 64, maxBonds: 4, agentCapabilities: AGENT_CAPS({ bonds: 'data' }) },
    }),
    // NOTE: no trailing agentGraph* override here — the harness migration is what
    // rewrites a legacy `formBondBetween` fixture, so it must be allowed to stick.
  };
}

function metricStore(n, mb) {
  const s = createAgentStore(bondCfg(Math.max(8, n + 8), mb), []);
  seedAgents(s, Array.from({ length: n }, (_, i) => ({ x: 1 + (i % 8) * 2, y: 1 + Math.floor(i / 8) * 2 })), 0.5);
  return s;
}
/** Deterministic LCG so the "random graph" fixture is reproducible. */
function lcg(seed) {
  let x = seed >>> 0;
  return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; };
}

function tierI() {
  section('TIER I — graph indicators (P6): exactness vs an independent recount');

  // ---- 1. exactness over a spread of graph shapes ------------------------
  const fixtures = [];
  {
    // ring of 12 (every degree 2, one component)
    const s = metricStore(12, 6);
    for (let i = 0; i < 12; i++) formBond(s, i, (i + 1) % 12, 1, 0);
    fixtures.push(['ring-12', s]);
  }
  {
    // ring + chords: mixed degrees 2/3/4
    const s = metricStore(12, 6);
    for (let i = 0; i < 12; i++) formBond(s, i, (i + 1) % 12, 1, 0);
    formBond(s, 0, 6, 1, 0); formBond(s, 2, 8, 1, 0); formBond(s, 0, 4, 1, 0);
    fixtures.push(['ring-12 + 3 chords', s]);
  }
  {
    // star: hub degree 7, seven leaves of degree 1
    const s = metricStore(8, 8);
    for (let i = 1; i < 8; i++) formBond(s, 0, i, 1, 0);
    fixtures.push(['star K1,7', s]);
  }
  {
    // five isolated agents — 0 edges, 5 components, the whole histogram at degree 0
    fixtures.push(['5 isolated', metricStore(5, 4)]);
  }
  {
    // two disjoint K4s — 2 components, 12 edges, every degree 3
    const s = metricStore(8, 6);
    for (const base of [0, 4]) {
      for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) formBond(s, base + a, base + b, 1, 0);
    }
    fixtures.push(['two disjoint K4', s]);
  }
  {
    // a HOLEY store: kill scattered agents so `alive` has gaps and slots recycle
    const s = metricStore(20, 6);
    for (let i = 0; i < 20; i++) formBond(s, i, (i + 1) % 20, 1, 0);
    for (const dead of [3, 4, 11, 17]) freeAgentSlot(s, dead);
    fixtures.push(['ring-20 with 4 agents killed (holes + broken bonds)', s]);
  }
  {
    // a pseudo-random graph
    const s = metricStore(24, 6);
    const rnd = lcg(0xC0FFEE);
    for (let t = 0; t < 60; t++) {
      const a = Math.floor(rnd() * 24), b = Math.floor(rnd() * 24);
      if (a !== b) formBond(s, a, b, 1, 0);
    }
    fixtures.push(['random 24-node graph (seeded)', s]);
  }
  {
    // the empty population (no agents at all)
    fixtures.push(['empty population', metricStore(0, 4)]);
  }

  for (const [name, s] of fixtures) {
    const g = storeGraph(s);
    const ref = refAllMetrics(g);
    const bad = metricMismatch(metricView(s), ref);
    ok(bad === null, `exactness — ${name}: all six metrics match an independent recount`, bad ?? '');
    // The store's own liveCount must agree with a scan of `alive` (the shipped
    // nodeCount is O(1) from liveCount, so this is what makes it trustworthy).
    ok(s.liveCount === refNodeCount(g), `  ${name}: store liveCount == alive scan (${s.liveCount})`);
    // edgeCount IS I1 — Σ deg / 2 vs distinct pairs, plus the invariant itself.
    let degSum = 0;
    for (let i = 0; i < g.highWater; i++) if (g.alive[i]) degSum += g.bondCount[i];
    ok(computeGraphMetrics(metricView(s), ['edgeCount']).edgeCount === degSum / 2
      && degSum / 2 === ref.edgeCount && checkHandshake(g) === null,
      `  ${name}: edgeCount == Σdeg/2 == |distinct pairs| (I1 holds)`);
    // The histogram's counts must sum to N — a metric that dropped a bucket would
    // still "look like a histogram".
    const hist = computeGraphMetrics(metricView(s), ['degreeHistogram']).degreeHistogram;
    const histSum = Object.values(hist).reduce((a, b) => a + b, 0);
    ok(histSum === ref.nodeCount, `  ${name}: histogram totals N (${histSum})`);
  }

  // ---- 2. the getState PAYLOAD path gives identical numbers --------------
  {
    let bad = null;
    for (const [name, s] of fixtures) {
      const transfers = [];
      const payload = serializeAgentStore(s, transfers);
      const g = decodeAgentGraph(payload);
      const fromPayload = computeGraphMetrics(
        { highWater: g.highWater, maxBonds: g.maxBonds, alive: g.alive, bondCount: g.bondCount, bondPartner: g.bondPartner },
        GRAPH_METRICS,
      );
      const fromStore = computeGraphMetrics(metricView(s), GRAPH_METRICS);
      for (const k of GRAPH_METRICS) {
        if (!sameMetric(fromPayload[k], fromStore[k])) { bad = `${name}/${k}: ${JSON.stringify(fromPayload[k])} != ${JSON.stringify(fromStore[k])}`; break; }
      }
      if (bad) break;
    }
    ok(bad === null, 'a `getState` payload gives the SAME metrics as the live store (the browser probe path)', bad ?? '');
  }

  // ---- 3. a FRAGMENTING graph: 1 → 2 → 1 → 3 ----------------------------
  {
    // two 6-cycles joined by two bridges
    const s = metricStore(12, 6);
    for (let i = 0; i < 6; i++) formBond(s, i, (i + 1) % 6, 1, 0);
    for (let i = 6; i < 12; i++) formBond(s, i, 6 + ((i - 6 + 1) % 6), 1, 0);
    formBond(s, 0, 6, 1, 0); formBond(s, 3, 9, 1, 0);
    const comps = () => computeGraphMetrics(metricView(s), ['componentCount']).componentCount;
    const refComps = () => refComponents(storeGraph(s));
    ok(comps() === 1 && refComps() === 1, `joined: componentCount == 1 (got ${comps()})`);
    breakBond(s, 0, 6);
    ok(comps() === 1 && refComps() === 1, 'one bridge broken: still ONE component (the other bridge holds)');
    breakBond(s, 3, 9);
    ok(comps() === 2 && refComps() === 2, `both bridges broken: the graph FRAGMENTS to 2 (got ${comps()})`);
    ok(checkHandshake(storeGraph(s)) === null && checkBondSymmetry(storeGraph(s)) === null,
      'the fragmented graph still satisfies I1 + I2');
    formBond(s, 1, 7, 1, 0);
    ok(comps() === 1 && refComps() === 1, 're-joining anywhere returns it to ONE component');
    // …and a THIRD piece: killing a cut vertex splits again.
    breakBond(s, 1, 7);
    freeAgentSlot(s, 0);
    ok(comps() === refComps() && comps() >= 2,
      `killing an agent tracks the split exactly (shipped ${comps()} == reference ${refComps()})`);
    // A metric that always answered 1 would have passed the first check only.
    ok(comps() !== 1, 'NEG: the metric is not a constant 1');
  }

  // ---- 4. opt-in cost: which passes actually run -------------------------
  {
    const s = fixtures[1][1];
    const v = metricView(s);
    const mk = () => ({ degree: 0, components: 0 });
    let p = mk(); computeGraphMetrics(v, [], p);
    ok(p.degree === 0 && p.components === 0 && Object.keys(computeGraphMetrics(v, [])).length === 0,
      'zero metrics requested ⇒ NO passes at all (the shape of "zero cost when unused")');
    p = mk(); computeGraphMetrics(v, ['nodeCount'], p);
    ok(p.degree === 0 && p.components === 0, 'nodeCount alone ⇒ no degree scan, no union-find (O(1) from liveCount)');
    p = mk(); computeGraphMetrics(v, ['componentCount'], p);
    ok(p.degree === 0 && p.components === 1, 'componentCount alone ⇒ union-find ONLY (no degree scan)');
    p = mk(); computeGraphMetrics(v, ['edgeCount', 'meanDegree', 'maxDegree', 'degreeHistogram'], p);
    ok(p.degree === 1 && p.components === 0,
      'all four degree metrics ⇒ ONE shared O(N) pass, and componentCount stays unpaid');
    p = mk(); computeGraphMetrics(v, GRAPH_METRICS, p);
    ok(p.degree === 1 && p.components === 1, 'everything ⇒ exactly one degree pass + one union-find');
  }

  // ---- 5. DATA-level negative controls ----------------------------------
  {
    const base = () => {
      const s = metricStore(10, 6);
      for (let i = 0; i < 10; i++) formBond(s, i, (i + 1) % 10, 1, 0);
      return s;
    };
    {
      const s = base();
      const v = metricView(s);
      s.bondCount[2] += 1;                       // phantom degree
      ok(metricMismatch(v, refAllMetrics(storeGraph(s))) !== null,
        'NEG: an inflated bondCount makes edgeCount disagree with the distinct-pair recount');
    }
    {
      const s = base();
      s.alive[4] = 0;                            // dead but liveCount not updated
      ok(metricMismatch(metricView(s), refAllMetrics(storeGraph(s))) !== null,
        'NEG: a stale liveCount is CAUGHT (nodeCount is O(1) from it, the reference scans `alive`)');
    }
    {
      const s = base();
      breakBond(s, 0, 1);
      const before = computeGraphMetrics(metricView(base()), ['edgeCount']).edgeCount;
      const after = computeGraphMetrics(metricView(s), ['edgeCount']).edgeCount;
      ok(after === before - 1, `NEG: breaking ONE bond drops edgeCount by exactly 1 (${before} → ${after})`);
    }
    {
      const s = base();
      const h0 = computeGraphMetrics(metricView(s), ['degreeHistogram']).degreeHistogram;
      breakBond(s, 0, 1);
      const h1 = computeGraphMetrics(metricView(s), ['degreeHistogram']).degreeHistogram;
      ok(h0['2'] === 10 && h1['2'] === 8 && h1['1'] === 2,
        'NEG: the histogram MOVES the two endpoints from degree 2 to degree 1',
        `${JSON.stringify(h0)} → ${JSON.stringify(h1)}`);
    }
  }

  // ---- 5b. the MEASURED cost at a realistic population --------------------
  // componentCount is the only non-trivial metric; the handoff requires its cost
  // to be stated rather than assumed. Reported as info + a generous ceiling so a
  // slow CI box can't turn a perf note into a red gate.
  {
    const N = 20000, MB = 6;
    const s = createAgentStore(bondCfg(N + 64, MB), []);
    seedAgents(s, Array.from({ length: N }, (_, i) => ({ x: 1 + (i % 200) * 0.3, y: 1 + Math.floor(i / 200) * 0.3 })), 0.5);
    const rnd = lcg(0xBEEF);
    let made = 0;
    for (let t = 0; t < N * 3; t++) {
      const a = Math.floor(rnd() * N), b = Math.floor(rnd() * N);
      if (a !== b && formBond(s, a, b, 1, 0)) made++;
    }
    const v = metricView(s);
    const time = (metrics) => {
      computeGraphMetrics(v, metrics);                       // warm
      const t0 = performance.now();
      for (let r = 0; r < 20; r++) computeGraphMetrics(v, metrics);
      return (performance.now() - t0) / 20;
    };
    const tDeg = time(['edgeCount', 'meanDegree', 'maxDegree', 'degreeHistogram']);
    const tComp = time(['componentCount']);
    const tAll = time(GRAPH_METRICS);
    console.log(`      cost @ N=${N} live, E=${made}, maxBonds=${MB}:  degree pass ${tDeg.toFixed(3)} ms · componentCount ${tComp.toFixed(3)} ms · all six ${tAll.toFixed(3)} ms`);
    ok(tComp < 100, `componentCount at ${N} agents / ${made} edges costs ${tComp.toFixed(3)} ms (well under a frame)`);
    ok(computeGraphMetrics(v, ['componentCount']).componentCount === refComponents(storeGraph(s)),
      '  …and is still EXACT at that scale (vs the BFS reference)');
  }

  // ---- 6. UI-facing derivations ------------------------------------------
  {
    ok(GRAPH_METRICS.length === 6 && GRAPH_METRICS.every(k => GRAPH_METRIC_INFO[k]?.label),
      'every metric has a label + hint (the panel dropdown reads them)');
    ok(isGraphFrequencyMetric('degreeHistogram') && GRAPH_METRICS.filter(isGraphFrequencyMetric).length === 1,
      'degreeHistogram is the ONLY frequency-shaped metric (so the rest take the scalar chart path)');
    ok(graphMetricDataType('meanDegree') === 'float'
      && ['nodeCount', 'edgeCount', 'maxDegree', 'componentCount', 'degreeHistogram'].every(k => graphMetricDataType(k) === 'integer'),
      'meanDegree formats as a decimal, the counts as integers');
    ok(degreeHistogramKeys(4).join(',') === '0,1,2,3,4' && degreeHistogramKeys(0).join(',') === '0',
      'the histogram categories are the FIXED window 0..maxBonds');
    // designTimeSeriesKeys must give a graph SCALAR the 'value' key (before P6 it
    // fell through to the linked branches and returned [] — no colour slot).
    const mdl = { centerBased: bondCfg(64, 5), attributes: [] };
    ok(designTimeSeriesKeys({ id: 'a', kind: 'graph', graphMetric: 'edgeCount', dataType: 'integer' }, mdl).join(',') === 'value',
      'designTimeSeriesKeys: a graph SCALAR gets the value series');
    ok(designTimeSeriesKeys({ id: 'b', kind: 'graph', graphMetric: 'degreeHistogram', dataType: 'integer' }, mdl).join(',') === '0,1,2,3,4,5',
      'designTimeSeriesKeys: the histogram gets one stable series per degree (0..maxBonds)',
      designTimeSeriesKeys({ id: 'b', kind: 'graph', graphMetric: 'degreeHistogram', dataType: 'integer' }, mdl).join(','));
  }
}

/** SOURCE-mutation negative controls: patch `graphMetrics.ts` itself, rebuild it
 *  in isolation (it has no imports), and prove the exactness oracle CATCHES each
 *  mutation. A harness that only ever passes is worthless — this is what shows
 *  the comparison above has teeth. */
async function tierIMutants() {
  section('TIER I — SOURCE-mutation negative controls on graphMetrics.ts');
  const src = readFileSync(join(ROOT, 'src/simulator/engine/graphMetrics.ts'), 'utf8');

  // FIXTURE 0 — a HEALTHY graph with holes and two components. The chord sits on
  // agents 2/4, NOT on agent 0, so the first live agent's degree is deliberately
  // NOT the maximum: a maxDegree mutant that latches the first value must fail.
  const s0 = metricStore(16, 6);
  for (let i = 0; i < 8; i++) formBond(s0, i, (i + 1) % 8, 1, 0);
  for (let i = 8; i < 16; i++) formBond(s0, i, 8 + ((i - 8 + 1) % 8), 1, 0);
  formBond(s0, 2, 4, 1, 0);
  freeAgentSlot(s0, 6);                    // a hole ⇒ the alive check matters
  const view0 = metricView(s0), ref0 = refAllMetrics(storeGraph(s0));
  ok(metricMismatch(view0, ref0) === null, 'mutation fixture 0 (healthy, holed, 2 components) is EXACT before any mutation');
  ok(s0.bondCount[0] < ref0.maxDegree, `  fixture 0: the FIRST live agent is not the max-degree one (${s0.bondCount[0]} < ${ref0.maxDegree})`);

  // FIXTURE 1 — a path 0–1–2–3–4 with agent 2 marked dead but its bonds LEFT
  // dangling (an I3-violating state produced only here, on purpose). Only
  // `componentCount` is compared on it: the shipped code and the BFS reference
  // both refuse to traverse a dead partner, so they agree at 2 components, while
  // a mutant that drops the alive check walks straight through and reports 1.
  const s1 = metricStore(5, 4);
  for (let i = 0; i < 4; i++) formBond(s1, i, i + 1, 1, 0);
  s1.alive[2] = 0; s1.liveCount -= 1;      // dangling by construction
  const view1 = metricView(s1);
  const refComps1 = refComponents(storeGraph(s1));
  ok(computeGraphMetrics(view1, ['componentCount']).componentCount === refComps1 && refComps1 === 2,
    'mutation fixture 1 (dangling dead agent): shipped and reference both report 2 components');

  const MUTANTS = [
    ['edgeCount forgets the /2 (double-counts every edge)',
      'out.edgeCount = degSum / 2;', 'out.edgeCount = degSum;', 0, GRAPH_METRICS],
    ['the degree scan skips the alive check (counts dead slots)',
      'if (!alive[i]) continue;\n      const d = bondCount[i] as number;', 'const d = bondCount[i] as number;', 0, GRAPH_METRICS],
    ['maxDegree latches the FIRST degree instead of the largest',
      'if (d > maxDeg) maxDeg = d;', 'if (maxDeg === 0) maxDeg = d;', 0, GRAPH_METRICS],
    ['meanDegree divides by highWater instead of the live count',
      'out.meanDegree = live > 0 ? degSum / live : 0;', 'out.meanDegree = hw > 0 ? degSum / hw : 0;', 0, GRAPH_METRICS],
    ['the union-find never decrements (every node its own component)',
      '      comps--;', '      ;', 0, ['componentCount']],
    ['componentCount unions across a DEAD partner',
      'if (p < 0 || p >= hw || p === i || !alive[p]) continue;', 'if (p < 0 || p >= hw || p === i) continue;', 1, ['componentCount']],
    ['the histogram drops the last bucket (degree == maxBonds)',
      'for (let d = 0; d <= mb; d++) m[String(d)] = hist[d]!;', 'for (let d = 0; d < mb; d++) m[String(d)] = hist[d]!;', 0, GRAPH_METRICS],
  ];
  const FIXTURES = [
    { view: view0, ref: ref0 },
    { view: view1, ref: { componentCount: refComps1 } },
  ];

  for (let mi = 0; mi < MUTANTS.length; mi++) {
    const [label, from, to, fx, metrics] = MUTANTS[mi];
    if (!src.includes(from)) { ok(false, `mutant anchor not found: ${label}`, from); continue; }
    const mutPath = join(dir, `mut_${mi}.ts`);
    writeFileSync(mutPath, src.replace(from, to));
    const outMut = join(dir, `mut_${mi}.mjs`);
    await build({ entryPoints: [mutPath], bundle: true, format: 'esm', platform: 'node', outfile: outMut, logLevel: 'error', absWorkingDir: ROOT });
    const mm = await import(pathToFileURL(outMut).href);
    const { view, ref } = FIXTURES[fx];
    const got = mm.computeGraphMetrics(view, metrics);
    let caught = false, detail = '';
    for (const k of metrics) {
      if (!sameMetric(got[k], ref[k])) { caught = true; detail = `${k}: ${JSON.stringify(got[k])} vs ${JSON.stringify(ref[k])}`; break; }
    }
    ok(caught, `NEG (source mutant, fixture ${fx}): ${label} — CAUGHT by the exactness oracle`, caught ? '' : `no metric moved (${JSON.stringify(got)})`);
    if (caught) console.log(`      ↳ ${detail}`);
  }
}

// ===========================================================================
// TIER L — P7: a SHIPPED flagship sample, run through its OWN compiled
// behaviour over a real agent store and a real structural drain.
//
//   (Tier K pinned `Cubic GRA`, retired from the library — see the note below.)
//   L  `SDCA - Couplers and Decouplers` — O8 (the Nowotny-Requardt hysteresis
//      band: no flicker inside the band; exactly invariant when the thresholds
//      never fire), with a single-threshold control that DOES flicker.
//
// The point of loading `public/models/*.gcaproj` rather than a synthetic is that
// these prove the SHIPPED artefacts, so a later edit to a generator that quietly
// breaks the rule fails here.
// ===========================================================================

const loadShipped = (name) =>
  migrateForHarness(JSON.parse(readFileSync(join(ROOT, `public/models/${name}.gcaproj`), 'utf8')));

/** Decode an attribute's serialized default the way the worker's spec builder does. */
const attrDefault = (a) => {
  const raw = a.defaultValue;
  if (raw === 'true') return 1;
  if (raw === 'false' || raw === undefined || raw === '') return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
};

/** Build a runnable rig for a SHIPPED agent-only model: a real store, its own
 *  compiled JS behaviour (and Agent Init Event, if it has one), and a `step()`
 *  that mirrors the worker exactly — prime → behaviour → swap → DRAIN. Model
 *  attributes are handed back as a live object so a test can move a slider. */
function shippedRig(model, { seedSpecs = null } = {}) {
  const cfg = model.centerBased;
  const W = model.properties.gridWidth, H = model.properties.gridHeight, D = 1;
  const specs = agentAttrsOf(model).map(a => ({ id: a.id, type: a.type, defaultValue: attrDefault(a) }));
  const bondSpecs = bondAttrsOf(model).map(a => ({ id: a.id, type: a.type, defaultValue: attrDefault(a) }));
  const syncAttrs = cfg?.agentUpdateMode === 'sync';
  const bondReqSlots = bondReqSlotsForModel(model);

  const res = compileAgentGraph(model.agentGraphNodes ?? [], model.agentGraphEdges ?? [], model, 0);
  if (res.error) throw new Error(`JS agent compile: ${res.error}`);

  // C9 gates optional per-agent SoA fields (targetRadius / age / density) on the
  // capability profile OR a graph usage, and `compileAgentGraph` derives its param
  // list from `resolveAgentFieldGates(model)`. The store MUST be built from the
  // same resolution or its ABI args disagree with those params — and because the
  // gated fields are MID-LIST, the mismatch SHIFTS every later argument rather
  // than dropping a trailing one.
  const fieldGates = resolveAgentFieldGates(model);
  const s = createAgentStore(cfg, specs, { wasmBacked: false, syncAttrs, bondReqSlots, bondAttrSpecs: bondSpecs, fieldGates });
  s.worldWidth = W; s.worldHeight = H; s.worldDepth = D;

  const r = cbNum(cfg, 'defaultRadius', 0.5);
  const seedCount = Math.max(0, Math.floor(cbNum(cfg, 'seedCount', 0)));
  if (seedSpecs) seedAgents(s, seedSpecs, r);
  else if (seedCount > 0) {
    // The worker's 2D `compact` pattern, verbatim (sim.worker.ts initAgents).
    const spacing = 2.1 * r, cols = Math.max(1, Math.ceil(Math.sqrt(seedCount)));
    const blockW = (cols - 1) * spacing, rows = Math.ceil(seedCount / cols), blockH = (rows - 1) * spacing;
    const ox = W / 2 - blockW / 2, oy = H / 2 - blockH / 2;
    const out = [];
    for (let i = 0; i < seedCount; i++) out.push({ x: ox + (i % cols) * spacing, y: oy + Math.floor(i / cols) * spacing, radius: r });
    seedAgents(s, out, r);
  }

  const lookupTables = {};
  const modelAttrs = {};
  for (const a of model.attributes) {
    if (!a.isModelAttribute) continue;
    if (a.type === 'lookupTable') { if (Array.isArray(a.tableData)) lookupTables[a.id] = Float64Array.from(a.tableData); }
    else modelAttrs[a.id] = Number(a.defaultValue) || 0;
  }
  // RULE-READABLE INDICATORS. `Get Indicator` compiles to `_indicators[<slot>]`
  // where the slot is the indicator's INDEX in `model.indicators`, and the worker
  // mirrors every COMPUTED metric whose result is a single number into that slot
  // once per generation (`refreshRuleReadableIndicators`). A rig that passed a
  // zero-length buffer read `undefined` for such a node, so a rule gated on e.g.
  // `nodes (N) <= cap` silently never fired — the shipped `Growing Graphs` node
  // cap is exactly that shape. Mirror the worker instead.
  const allIndicators = model.indicators ?? [];
  const indicators = new Float64Array(Math.max(1, allIndicators.length));
  const graphSlots = allIndicators
    .map((ind, i) => ({ i, metric: ind.graphMetric ?? 'nodeCount', kind: ind.kind }))
    .filter(x => x.kind === 'graph' && !isGraphFrequencyMetric(x.metric));
  const refreshIndicators = () => {
    if (!graphSlots.length) return;
    const got = computeGraphMetrics(metricView(s), graphSlots.map(g => g.metric));
    for (const g of graphSlots) if (typeof got[g.metric] === 'number') indicators[g.i] = got[g.metric];
  };
  const rngState = new Uint32Array(1);
  const hashReserve = computeAgentMaxHashBins(W, H, D, cbNum(cfg, 'interactionRange', 1.5), r, cbNum(cfg, 'neighbourQueryRadius', 5));
  const binEdge = Math.max(1e-3, cbNum(cfg, 'interactionRange', 1.5) * 2 * r, cbNum(cfg, 'neighbourQueryRadius', 5));

  // The worker's GROW-ONLY behaviour spawn closures (sim.worker.ts).
  const staged = new Set();
  const ctx = {
    hash: null, emptyI32: new Int32Array(0), modelAttrs, viewer: '',
    indicators, rngState, stopFlag: new Uint32Array(1),
    glyphCodes: new Uint32Array(1), glyphColors: new Uint32Array(1), lookupTables,
    width: W, height: H, total: 0, torus: model.properties.boundaryTreatment === 'torus',
    fieldArray: () => undefined, seedBase: 0, generation: 0,
    agentCreate: (x, y, z, rad) => {
      if (s.highWater >= s.maxAgents) return -1;
      const id = s.highWater++;
      initAgentSlot(s, id, x, y, z || 0, rad || r, id);
      s.alive[id] = 0; staged.add(id);
      return id;
    },
    agentAddToWorld: (id) => { if (staged.has(id) && !s.alive[id]) { s.alive[id] = 1; s.liveCount++; } },
  };
  // NB `bondAttrs` is NOT optional in practice: the ABI descriptor emits one
  // `_bondAttr_<id>` + one `_bondFormAttr_<id>` param per bond attribute, so
  // omitting it here silently SHIFTS every later argument (modelAttrs among them)
  // and the whole rule reads NaN with no error anywhere.
  const shape = {
    is3d: false, agentAttrs: s.attrSpecs, bondAttrs: bondAttrsOf(model),
    fieldAttrs: cellFieldAttrsOf(model), hasLookupTables: Object.keys(lookupTables).length > 0,
    // ALWAYS supplied (params <= args). A Periodic Step model whose generation
    // arg is missing reads `undefined % period`, never fires, and every O6 check
    // would then pass vacuously on a graph that did nothing.
    usesGeneration: true,
    // C9 made the ABI PROFILE-GATED (`_agentTargetRadius` / `_agentAge` /
    // `_agentDensity` appear only when the capability or a usage asks for them),
    // and those are MID-LIST — so a shape without `gates` produces MORE args than
    // the compiled fn has params and every later argument shifts. On the shipped
    // Cubic GRA (no growth capability) that put the viewer string where
    // `_rngState` belongs and the whole tier crashed. The worker
    // (`agentAbiShapeOfStore`) and `parity-agent-wasm` both pass `s.fieldGates`;
    // this is the THIRD mirror and must too.
    gates: s.fieldGates,
  };

  const behaviour = eval(res.behaviourCode);
  const reset = (seed = 0x1234abcd) => {
    rngState[0] = seed >>> 0;
    ctx.generation = 0;   // Reset zeroes the counter BEFORE the Init Event (L2)
    if (res.initCode) {
      staged.clear();
      // eslint-disable-next-line no-eval
      const initFn = eval(res.initCode);
      initFn(...buildAgentAbiArgs('init', shape, s, ctx));
      for (const id of staged) if (!s.alive[id]) { /* leaked stage — the worker frees it */ }
      // sync mode: the Init Event wrote the WRITE buffer; commit it (worker parity).
      if (syncAttrs) for (const sp of s.attrSpecs) s.attrRead[sp.id].set(s.attrWrite[sp.id]);
    }
    refreshIndicators();
  };

  /** One generation. Returns { overflow, queued } — `queued` is the set of agents
   *  that raised at least one structural request THIS generation, captured BEFORE
   *  the drain (that is what makes the independent-set check meaningful). */
  const step = () => {
    staged.clear();
    s.forceX.fill(0, 0, s.highWater); s.forceY.fill(0, 0, s.highWater);
    s.divideRequest.fill(0); s.killRequest.fill(0);
    clearAgentBondRequests(s);
    if (syncAttrs) for (const sp of s.attrSpecs) { const rd = s.attrRead[sp.id], wr = s.attrWrite[sp.id]; if (rd !== wr) wr.set(rd); }
    ctx.hash = buildSpatialHash(s, binEdge, W, H, D, ctx.torus, hashReserve);
    behaviour(...buildAgentAbiArgs('loop', shape, s, ctx));
    if (syncAttrs) for (const sp of s.attrSpecs) { const t = s.attrRead[sp.id]; s.attrRead[sp.id] = s.attrWrite[sp.id]; s.attrWrite[sp.id] = t; }
    const queued = new Set();
    const slots = s.bondReqSlots;
    for (let i = 0; i < s.highWater; i++) {
      for (let c = 0; c < slots; c++) {
        if (s.bondFormReq[i * slots + c] !== 0 || s.bondBreakReq[i * slots + c] !== 0) { queued.add(i); break; }
      }
    }
    const overflow = drainAgentBondRequests(s, 1);
    ctx.generation++;   // bump at the END of the step, like the worker
    refreshIndicators();   // the worker refreshes at the generation tail
    return { overflow, queued };
  };

  return { model, store: s, step, reset, modelAttrs, compiled: res };
}
/* TIER K RETIRED — it pinned the shipped `Cubic GRA`, which the author removed
 * from the library (commit 9c3807d). Its coverage survives elsewhere: Tier J's
 * triangle-split gate asserts O6 + I1-I4 after EVERY one of 60 synthetic splits
 * (with the no-Form-Between negative control that proves the check is real), and
 * Tier M asserts O6 + I1-I4 at every generation of the SHIPPED `Growing Graphs`
 * across eight published rules. `scripts/gen-cubic-gra.mjs` still regenerates the
 * model if it is ever restored. */
/** Structural surgery on a loaded model, for the negative controls. */
const cloneModel = (m) => migrateForHarness(JSON.parse(JSON.stringify(m)));
const findNode = (m, pred) => m.agentGraphNodes.find(pred);
function dropNode(m, id) {
  m.agentGraphNodes = m.agentGraphNodes.filter(n => n.id !== id);
  m.agentGraphEdges = m.agentGraphEdges.filter(e => e.source !== id && e.target !== id);
}


function tierL() {
  section('TIER L — P7: the SHIPPED `SDCA` — O8, the hysteresis band');

  const model = loadShipped('SDCA - Couplers and Decouplers');

  // --- 0. shape + gates ----------------------------------------------------
  {
    ok(bondAttrsOf(model).some(a => a.id === 'strength' && a.type === 'float'),
      'the LINK VALUE is a float BOND attribute — the capability this model exists to show');
    ok(model.agentGraphNodes.some(n => n.data.nodeType === 'setBondAttribute')
      && model.agentGraphNodes.some(n => n.data.nodeType === 'getBondAttribute'),
      'the link rule reads AND writes it');
    ok(model.agentGraphEdges.some(e => e.targetHandle === 'input_value_bondAttr_strength'),
      'a newly coupled link is born carrying its drive (Form Bond\'s per-bond-attribute initial value)');
    ok(model.agentGraphNodes.some(n => n.data.nodeType === 'formBond')
      && model.agentGraphNodes.some(n => n.data.nodeType === 'breakBond'),
      'couplers and decouplers are Form Bond / Break Bond');
    ok(isAgentGraphWasmSupported(model), 'the WASM agent gate accepts the shipped SDCA');
    ok(isAgentGraphWebGPUSupported(model), 'the WebGPU agent gate accepts the shipped SDCA');
    const w = compileAgentGraphWasmForModel(model);
    ok(!w.error && w.bytes.length > 0, 'it compiles on the WASM agent target', String(w.error));
    const g = compileAgentGraphWebGPUForModel(model);
    ok(!g.error && (g.shaderCode || '').length > 0, 'it compiles on the WebGPU agent target', String(g.error));
    for (const n of model.agentGraphNodes) {
      const iss = detectMissingConfig(n.data.nodeType, n.data.config ?? {}, model);
      if (iss && iss.length) { ok(false, `node ${n.data.nodeType} validates clean`, iss.join('; ')); return; }
    }
    ok(true, 'every node in the shipped agent graph validates clean');
  }

  /** Run `n` generations at a given drive, returning the edge set + invariants. */
  const phase = (rig, drive, n) => {
    rig.modelAttrs.drive = drive;
    let inv = null;
    for (let i = 0; i < n && !inv; i++) {
      rig.step();
      const g = decodeAgentGraph(rig.store);
      inv = checkHandshake(g) ?? checkNoDangling(g) ?? checkCapacity(g) ?? checkBondSymmetry(g);
    }
    return { edges: edgeSet(decodeAgentGraph(rig.store)), inv };
  };

  // --- 1. thresholds that NEVER fire => topology EXACTLY invariant ---------
  {
    const rig = shippedRig(model);
    rig.reset();
    rig.modelAttrs.agreeBonus = 0;
    rig.modelAttrs.lambdaOn = 5;        // unreachable
    rig.modelAttrs.lambdaOff = -1;      // unreachable
    const a = phase(rig, 0.5, 3);
    ok(a.inv === null, 'I1-I4 hold under the never-fires configuration', String(a.inv));
    // seed a topology by hand, then prove 40 generations change NOTHING
    for (let i = 0; i + 1 < Math.min(40, rig.store.highWater); i += 2) formBond(rig.store, i, i + 1, 7, 0.35);
    const before = edgeSet(decodeAgentGraph(rig.store));
    const b = phase(rig, 0.5, 40);
    ok(b.inv === null, 'I1-I4 hold across the invariance run', String(b.inv));
    ok(before.size > 0 && before.size === b.edges.size && [...before].every(e => b.edges.has(e)),
      `O8 (a): with thresholds that never fire the topology is EXACTLY invariant over 40 generations (${before.size} links)`,
      `${before.size} -> ${b.edges.size}`);
  }

  // --- 2. THE BAND — drive up across lambda2, back INTO the band ----------
  //
  // agreeBonus 0 makes the pair drive exactly the global Drive, so this is a pure
  // threshold experiment and the outcome is unambiguous.
  let banded = null;
  {
    const rig = shippedRig(model);
    rig.reset();
    rig.modelAttrs.agreeBonus = 0;
    rig.modelAttrs.lambdaOn = 0.65;
    rig.modelAttrs.lambdaOff = 0.35;

    const low = phase(rig, 0.20, 12);                 // below lambda1: nothing survives
    ok(low.edges.size === 0, 'below the decouple threshold the graph is edgeless', `E=${low.edges.size}`);

    const inBandBefore = phase(rig, 0.50, 12);        // INSIDE the band from empty
    ok(inBandBefore.edges.size === 0,
      'O8 (b): inside the band, an EDGELESS graph stays edgeless — the band\'s lower half couples nothing',
      `E=${inBandBefore.edges.size}`);

    const on = phase(rig, 0.80, 12);                  // above lambda2: couple
    ok(on.edges.size > 0, `O8 (c): above the couple threshold links FORM (E=${on.edges.size})`);

    const back = phase(rig, 0.50, 25);                // back INTO the band: must persist
    ok(back.inv === null, 'I1-I4 hold across the hysteresis run', String(back.inv));
    ok(back.edges.size >= on.edges.size,
      `O8 (d) THE TEST: back inside the band the links STAY — no flicker (E ${on.edges.size} -> ${back.edges.size})`);
    banded = back.edges.size;

    const off = phase(rig, 0.20, 25);                 // below lambda1: decouple
    ok(off.edges.size === 0,
      `O8 (e): below the decouple threshold they all break again (E=${off.edges.size})`);
  }

  // --- 3. NEGATIVE CONTROL — one symmetric threshold FLICKERS -------------
  //
  // Identical run with lambda1 == lambda2. Everything else is the same, so the
  // difference isolates the BAND as the thing that preserves the links.
  {
    const rig = shippedRig(model);
    rig.reset();
    rig.modelAttrs.agreeBonus = 0;
    rig.modelAttrs.lambdaOn = 0.65;
    rig.modelAttrs.lambdaOff = 0.65;     // no band at all
    phase(rig, 0.20, 12);
    const on = phase(rig, 0.80, 12);
    ok(on.edges.size > 0, 'control: with a single threshold links still form above it', `E=${on.edges.size}`);
    const back = phase(rig, 0.50, 25);
    ok(back.edges.size === 0,
      'NEG: with ONE symmetric threshold the same manoeuvre destroys every link — the hysteresis band is what preserves them',
      `E=${back.edges.size} (banded run kept ${banded})`);
  }

  // --- 4. the link value is really carried on the BOND --------------------
  {
    const rig = shippedRig(model);
    rig.reset();
    rig.modelAttrs.agreeBonus = 0;
    rig.modelAttrs.lambdaOn = 0.65; rig.modelAttrs.lambdaOff = 0.35;
    phase(rig, 0.80, 20);
    const st = rig.store;
    let sampled = 0, offBand = 0;
    for (let i = 0; i < st.highWater && sampled < 200; i++) {
      if (!st.alive[i]) continue;
      for (let k = 0; k < st.bondCount[i]; k++) {
        const v = st.bondAttrs['strength'][i * st.maxBonds + k];
        sampled++;
        if (!(v > 0.7 && v <= 0.8001)) offBand++;
      }
    }
    ok(sampled > 0 && offBand === 0,
      `every live link's stored value has converged to the drive 0.8 (${sampled} slots checked)`, `${offBand} off-band`);
    ok(checkBondSymmetry(decodeAgentGraph(st)) === null,
      'I2: both stored copies of every link value agree (the rule is symmetric in i and j)');
  }

  // --- 5. the long haul: 500 generations of live dual coupling ------------
  //
  // Shipped settings (Agreement Bonus 0.25), so the drive is genuinely
  // state-dependent and the topology churns every generation — couplers and
  // decouplers both firing. I1-I4 after every one of them.
  {
    const rig = shippedRig(model);
    rig.reset();
    let bad = null, churn = 0, prev = 0;
    for (let gen = 1; gen <= 500 && !bad; gen++) {
      rig.step();
      const g = decodeAgentGraph(rig.store);
      bad = checkHandshake(g) ?? checkNoDangling(g) ?? checkCapacity(g) ?? checkBondSymmetry(g);
      if (bad) { bad = `gen ${gen}: ${bad}`; break; }
      const e = edgeSet(g).size;
      if (e !== prev) churn++;
      prev = e;
    }
    ok(bad === null, 'I1-I4 hold at EVERY one of 500 generations of the shipped SDCA', String(bad));
    ok(churn > 20, `the long run is not a fixed point — the link count changed on ${churn} of 500 generations`);
  }
}

// ===========================================================================
// TIER N — B9: the TRANSFER verb (third-party IN-PLACE partner replacement).
//
// The point of the verb, and therefore of this tier: `rewireBond` is break+form
// at the REQUESTER, and break compacts by swapping the LAST slot into the freed
// one while form APPENDS — so it SCRAMBLES the third party's slot order. Transfer
// overwrites the third party's slot WHERE IT STANDS. Every check below that
// mentions a POSITION is testing the only thing that distinguishes the two verbs;
// everything else (I5 rejections, I2 symmetry) is the standard queue-verb contract.
// ===========================================================================

/** Write ONE TRANSFER entry, mirroring all three emitters: the op kind rides the
 *  SIGN of the FORM lane (negative) — the mirror image of Form Between. */
function queueTransfer(st, i, c, { partner = -1, to = -1 } = {}) {
  const slots = st.bondReqSlots, depth = slots - 1;
  const e = i * slots + Math.min(c, depth);
  const good = partner >= 0 && to >= 0;
  st.bondBreakReq[e] = good ? partner + BOND_REQ_ID_BIAS : BOND_REQ_NONE;
  st.bondFormReq[e] = good ? -(to + BOND_REQ_ID_BIAS) : -BOND_REQ_NONE;
}

/** The SLOT INDEX (within the agent's row) holding `p`, or -1. The whole verb is
 *  about this number not moving. */
function slotIndexOf(s, a, p) {
  for (let k = 0; k < s.bondCount[a]; k++) if (s.bondPartner[a * s.maxBonds + k] === p) return k;
  return -1;
}

/** A minimal agent graph using ONLY the Transfer verb — for the emit-shape and
 *  usage-gate checks (mirrors `buildRewireModel`). */
function buildTransferModel() {
  const m = buildRewireModel();
  // Replace the three verbs with a single transferBond fed by two offsets.
  const bs = m.agentGraphNodes.find(n => n.data.nodeType === 'behaviourStep');
  const keep = new Set(['behaviourStep', 'getSelfHandle', 'arithmeticOperator']);
  m.agentGraphNodes = m.agentGraphNodes.filter(n => keep.has(n.data.nodeType));
  const ids = new Set(m.agentGraphNodes.map(n => n.id));
  m.agentGraphEdges = m.agentGraphEdges.filter(e => ids.has(e.source) && ids.has(e.target));
  const offs = m.agentGraphNodes.filter(n => n.data.nodeType === 'arithmeticOperator');
  const tr = { id: 'tr1', type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: 'transferBond', config: {} } };
  m.agentGraphNodes.push(tr);
  m.agentGraphEdges.push({ id: 'et0', source: bs.id, target: tr.id, sourceHandle: 'output_flow_do', targetHandle: 'input_flow_do' });
  m.agentGraphEdges.push({ id: 'et1', source: offs[0].id, target: tr.id, sourceHandle: 'output_value_result', targetHandle: 'input_value_partnerAgent' });
  m.agentGraphEdges.push({ id: 'et2', source: offs[1].id, target: tr.id, sourceHandle: 'output_value_result', targetHandle: 'input_value_toAgent' });
  return m;
}

function tierN() {
  section('TIER N — B9: the Transfer verb (in-place third-party partner replacement)');

  // --- 0. registration + the usage gate cover the new verb -----------------
  {
    ok(BOND_REQUEST_NODE_TYPES.has('transferBond'),
      'transferBond is a queue verb (so the layout reserves the queue for it)');
    const only = { agentGraphNodes: [{ id: 'a', data: { nodeType: 'transferBond' } }], centerBased: {}, topologyMode: { agents: true } };
    ok(bondReqSlotsForModel(only) === 9,
      'a graph whose ONLY verb is Transfer still reserves depth + the overflow bucket');
    const inMacro = { agentGraphNodes: [], macroDefs: [{ id: 'm', nodes: [{ id: 'a', data: { nodeType: 'transferBond' } }] }], centerBased: {}, topologyMode: { agents: true } };
    ok(agentGraphUsesBondRequests(inMacro), 'a Transfer inside a MACRO definition reserves the queue too');
    ok(BOND_REQ_TRANSFER_SIGN === -1, 'the op-kind marker is the FORM lane SIGN');
  }

  // --- 1. THE POINT OF THE VERB: the slot INDEX at the third party is kept --
  //
  // Build a partner `b` whose list is [x, me, y] — `me` in the MIDDLE, so a
  // swap-with-last compaction would visibly move it (y would land in slot 1 and
  // the new partner at the end). Assert the position, the untouched siblings, and
  // then run the SAME scenario through `rewireBond` to prove the difference is
  // real rather than an artefact of the fixture.
  {
    const st = queueStore(12, 4, 8);
    const ME = 0, B = 1, TO = 2, X = 3, Y = 4;
    formBond(st, B, X, 1, 1);        // b slot 0
    formBond(st, B, ME, 1, 1);       // b slot 1  ← the one being rewritten
    formBond(st, B, Y, 1, 1);        // b slot 2
    formBond(st, TO, 5, 1, 1);       // to already has one bond, so the append is at 1
    ok(slotIndexOf(st, B, ME) === 1, 'setup: `me` sits in the MIDDLE of b\'s list');

    queueTransfer(st, ME, 0, { partner: B, to: TO });
    ok(drainAgentBondRequests(st, 1) === false, 'no overflow');

    ok(slotIndexOf(st, B, TO) === 1,
      'THE POINT: the new partner occupies the EXACT slot the old one did',
      `slot ${slotIndexOf(st, B, TO)}`);
    ok(slotIndexOf(st, B, X) === 0 && slotIndexOf(st, B, Y) === 2,
      'b\'s OTHER slots are untouched (no compaction ran on b at all)',
      `x@${slotIndexOf(st, B, X)} y@${slotIndexOf(st, B, Y)}`);
    ok(st.bondCount[B] === 3, 'b\'s degree is unchanged', String(st.bondCount[B]));
    ok(!hasBond(st, ME, B) && hasBond(st, B, TO), 'the edge moved from me to `to`');
    ok(st.bondCount[TO] === 2 && slotIndexOf(st, TO, B) === 1,
      '`to` APPENDS its side (the requester makes no promise about the receiver\'s own order)');
    ok(allInvariants(st) === null, 'I1–I4 hold after a Transfer', String(allInvariants(st)));

    // NEGATIVE CONTROL — the same scenario through REWIRE, which is what this verb
    // exists to replace. Rewire moves the REQUESTER's end: b simply LOSES `me`
    // (swap-with-last drags y into slot 1 — the scramble) and the new partner is
    // bonded to the REQUESTER, never to b. If this ever matched Transfer, the
    // checks above would be measuring nothing.
    const s2 = queueStore(12, 4, 8);
    formBond(s2, B, X, 1, 1); formBond(s2, B, ME, 1, 1); formBond(s2, B, Y, 1, 1);
    formBond(s2, TO, 5, 1, 1);
    rewireBond(s2, ME, B, TO, 1, 1);
    ok(slotIndexOf(s2, B, Y) === 1 && st.bondCount[B] === 3 && s2.bondCount[B] === 2,
      'negative control: REWIRE SCRAMBLES b — y jumps into slot 1 and b loses a degree',
      `y@${slotIndexOf(s2, B, Y)} deg ${s2.bondCount[B]}`);
    ok(hasBond(s2, ME, TO) && !hasBond(s2, B, TO),
      'negative control: REWIRE attaches the new partner to the REQUESTER, not to b');
    ok(hasBond(st, B, TO) && !hasBond(st, ME, TO),
      'the two verbs therefore produce DIFFERENT graphs (the verb is not a re-skin of Rewire)');
  }

  // --- 2. THE DECODE-ORDER TRAP -------------------------------------------
  //
  // A sign-blind read of a transfer entry (`bl = b+2` positive, `fl` negative)
  // decodes `to` to -1 and falls into the plain-BREAK arm with `from = b`, i.e.
  // the edge VANISHES instead of moving. Prove the shipped drain does not do that,
  // and prove the wrong outcome is genuinely different.
  {
    const st = queueStore(12, 4, 8);
    formBond(st, 0, 1, 1, 1);
    queueTransfer(st, 0, 0, { partner: 1, to: 2 });
    drainAgentBondRequests(st, 1);
    ok(hasBond(st, 1, 2), 'the transfer MOVED the edge (it was not decoded as a bare Break)');
    ok(edgeSet(decodeAgentGraph(st)).size === 1, 'exactly one edge exists afterwards');

    // What a sign-blind drain would have produced, built explicitly.
    const s2 = queueStore(12, 4, 8);
    formBond(s2, 0, 1, 1, 1);
    queueOp(s2, 0, 0, { from: 1 });            // the plain-BREAK encoding
    drainAgentBondRequests(s2, 1);
    ok(edgeSet(decodeAgentGraph(s2)).size === 0,
      'negative control: falling through to the BREAK arm destroys the edge instead of moving it');

    // And the mirror collision: the SAME two ids with BOTH lanes positive is a
    // REWIRE, which bonds the REQUESTER — a different graph again.
    const s3 = queueStore(12, 4, 8);
    formBond(s3, 0, 1, 1, 1);
    queueOp(s3, 0, 0, { from: 1, to: 2 });
    drainAgentBondRequests(s3, 1);
    ok(hasBond(s3, 0, 2) && !hasBond(s3, 1, 2),
      'negative control: both lanes POSITIVE is a REWIRE — it bonds the REQUESTER, not the third party');
  }

  // --- 3. I5 — every rejection leaves the graph EXACTLY unchanged ----------
  {
    const cases = [
      ['no such edge (b↔me does not exist)', (s) => { formBond(s, 1, 6, 1, 1); return { partner: 1, to: 2 }; }],
      ['b↔to ALREADY exists (would double-edge)', (s) => { formBond(s, 0, 1, 1, 1); formBond(s, 1, 2, 1, 1); return { partner: 1, to: 2 }; }],
      ['`to` is full', (s) => { formBond(s, 0, 1, 1, 1); for (const k of [6, 7, 8]) formBond(s, 2, k, 1, 1); return { partner: 1, to: 2 }; }],
      ['`to` is dead', (s) => { formBond(s, 0, 1, 1, 1); freeAgentSlot(s, 2); return { partner: 1, to: 2 }; }],
      ['`to` is out of range', (s) => { formBond(s, 0, 1, 1, 1); return { partner: 1, to: 999 }; }],
      ['`to` === the requester', (s) => { formBond(s, 0, 1, 1, 1); return { partner: 1, to: 0 }; }],
      ['`to` === the partner', (s) => { formBond(s, 0, 1, 1, 1); return { partner: 1, to: 1 }; }],
      ['the partner IS the requester', (s) => { formBond(s, 0, 1, 1, 1); return { partner: 0, to: 2 }; }],
      ['the partner is dead', (s) => { formBond(s, 0, 1, 1, 1); freeAgentSlot(s, 1); return { partner: 1, to: 2 }; }],
      ['unresolvable ids (both lanes NONE)', (s) => { formBond(s, 0, 1, 1, 1); return { partner: -1, to: -1 }; }],
    ];
    // The PROBE: a valid transfer queued AFTER the rejected one (0↔11 → 5↔11), so
    // a rejection that truncated the queue would be caught. Agents 0/5/11 are
    // therefore expected to change; every OTHER row must be untouched.
    for (const [name, setup] of cases) {
      const st = queueStore(12, 3, 8);
      const req = setup(st);
      formBond(st, 0, 11, 1, 1);                       // the probe's edge
      const before = [...edgeSet(decodeAgentGraph(st))].sort().join('|');
      const beforeSlots = Array.from({ length: st.highWater }, (_, i) => partnersOf(st, i).join(','));
      queueTransfer(st, 0, 0, req);                    // the REJECTED op
      queueTransfer(st, 0, 1, { partner: 11, to: 5 }); // the probe
      drainAgentBondRequests(st, 1);
      // Everything except the probe's own edge move must be identical.
      const after = [...edgeSet(decodeAgentGraph(st))]
        .map(e => e === '5:11' ? '0:11' : e).sort().join('|');
      ok(after === before,
        `I5 (${name}): the graph is EXACTLY the pre-op graph`, `${before} -> ${after}`);
      const afterSlots = Array.from({ length: st.highWater }, (_, i) => partnersOf(st, i).join(','));
      const moved = beforeSlots.filter((v, i) => i !== 0 && i !== 5 && i !== 11 && v !== afterSlots[i]).length;
      ok(moved === 0, `I5 (${name}): not one uninvolved slot moved`, `${moved} rows differ`);
      ok(hasBond(st, 5, 11) && !hasBond(st, 0, 11),
        `I5 (${name}): the rejected entry still OCCUPIES its slot (no queue truncation)`);
      ok(allInvariants(st) === null, `I5 (${name}): I1–I4 hold`, String(allInvariants(st)));
    }
  }

  // --- 4. I2 — the moved edge agrees on EVERY per-slot field, and KEEPS its
  //         values (it is the same edge re-pointed, not a fresh bond) ---------
  {
    const specs = [
      { id: 'bw', type: 'float', defaultValue: 0 },
      { id: 'bk', type: 'integer', defaultValue: 0 },
    ];
    const s = createAgentStore(queueCfg(16, 4, 8), [], { bondAttrSpecs: specs });
    s.worldWidth = 64; s.worldHeight = 64; s.worldDepth = 1;
    seedAgents(s, Array.from({ length: 12 }, (_, i) => ({ x: 1 + i, y: 1, radius: 0.5 })), 0.5);
    const ME = 0, B = 1, TO = 2;
    formBond(s, ME, B, 3.25, 7.5, 0, [2.75, 6]);
    const kB = B * s.maxBonds + slotIndexOf(s, B, ME);
    ok(s.bondRestLength[kB] === 3.25 && s.bondAttrs['bw'][kB] === 2.75, 'setup: the edge carries its values');

    queueTransfer(s, ME, 0, { partner: B, to: TO });
    drainAgentBondRequests(s, 1);
    ok(hasBond(s, B, TO), 'the transferred bond exists');
    ok(checkBondSymmetry(decodeAgentGraph(s)) === null,
      'I2: the moved bond agrees on EVERY per-slot field in both rows',
      String(checkBondSymmetry(decodeAgentGraph(s))));
    const kb = B * s.maxBonds + slotIndexOf(s, B, TO);
    const kt = TO * s.maxBonds + slotIndexOf(s, TO, B);
    ok(s.bondRestLength[kb] === 3.25 && s.bondRestLength[kt] === 3.25,
      'KEEP-VALUES: the rest length survives the transfer, in BOTH slots',
      `${s.bondRestLength[kb]} / ${s.bondRestLength[kt]}`);
    ok(s.bondStiffness[kb] === 7.5 && s.bondStiffness[kt] === 7.5, 'KEEP-VALUES: the stiffness survives, in BOTH slots');
    ok(s.bondAttrs['bw'][kb] === 2.75 && s.bondAttrs['bw'][kt] === 2.75,
      'KEEP-VALUES: the float bond attribute travels WITH the edge, into BOTH slots');
    ok(s.bondAttrs['bk'][kb] === 6 && s.bondAttrs['bk'][kt] === 6,
      'KEEP-VALUES: the integer bond attribute travels WITH the edge, into BOTH slots');
    ok(s.bondPartnerEpoch[kb] === s.epoch[TO],
      'the rewritten slot re-stamps the epoch of its NEW partner (so the stale sweep keeps it)');
    ok(allInvariants(s) === null, 'I1–I4 hold', String(allInvariants(s)));
  }

  // --- 5. multi-op: transfers compose in ONE generation, in slot order ------
  {
    const st = queueStore(16, 4, 8);
    const ME = 0;
    for (const p of [1, 2, 3]) formBond(st, ME, p, 1, 1);
    const posBefore = [1, 2, 3].map(p => slotIndexOf(st, p, ME));
    queueTransfer(st, ME, 0, { partner: 1, to: 6 });
    queueTransfer(st, ME, 1, { partner: 2, to: 7 });
    queueTransfer(st, ME, 2, { partner: 3, to: 8 });
    drainAgentBondRequests(st, 1);
    ok(st.bondCount[ME] === 0, 'three transfers in one generation shed all three edges', String(st.bondCount[ME]));
    const posAfter = [[1, 6], [2, 7], [3, 8]].map(([p, t]) => slotIndexOf(st, p, t));
    ok(JSON.stringify(posAfter) === JSON.stringify(posBefore),
      'every third party kept its slot POSITION through the batch',
      `${JSON.stringify(posBefore)} -> ${JSON.stringify(posAfter)}`);
    ok(allInvariants(st) === null, 'I1–I4 hold after the batch', String(allInvariants(st)));
  }

  // --- 6. the emitted SHAPE on all three targets ---------------------------
  {
    const model = migrateForHarness(buildTransferModel());
    ok(bondReqSlotsForModel(model) === 9, 'the model reserves the queue');

    const js = compileAgentGraph(model.agentGraphNodes, model.agentGraphEdges, model, 0);
    ok(!js.error, 'JS: a Transfer Bond graph compiles', js.error || '');
    ok(/_bondFormReq\[_bq\] = _bqOk \? -\(_bqT \+ 2\) : -1;/.test(js.behaviourCode),
      'JS: the FORM lane carries the negated target (the op-kind marker)');
    ok(/_bondBreakReq\[_bq\] = _bqOk \? _bqP \+ 2 : 1;/.test(js.behaviourCode),
      'JS: the BREAK lane carries the POSITIVE third party');
    ok(!/_bondFormL\[_bq\]/.test(js.behaviourCode.split('_bondFormReq')[1] ?? ''),
      'JS: a Transfer writes NO form-half parameters (it keeps the edge\'s own values)');

    const w = compileAgentGraphWasmForModel(model);
    ok(!w.error && w.bytes.length > 0, 'WASM: a Transfer Bond graph compiles', w.error || '');
    ok(w.layout.bondReqSlots === 9, 'WASM: the layout reserves the queue', String(w.layout.bondReqSlots));

    const g = compileAgentGraphWebGPUForModel(model);
    ok(!g.error, 'WebGPU: a Transfer Bond graph compiles', g.error || '');
    ok(g.shaderCode.includes('var brqC: i32 = 0;'), 'WebGPU: the per-invocation queue cursor is declared');
    // `reqAt` resolves the field NAME to a numeric run base, so the shader text
    // never contains "bondFormReq" — address the write through the layout, the
    // way Tier G's stale-`idx` check does.
    const fBase = g.layout.f32Base['bondFormReq'], bBase = g.layout.f32Base['bondBreakReq'];
    const lineWith = (base) => (g.shaderCode.match(/^.*$/gm) ?? [])
      .filter(l => l.includes(`agentF32[${base}u`) && l.includes('=') && !l.includes('let ')).join('\n');
    const fLine = lineWith(fBase), bLine = lineWith(bBase);
    ok(/= f32\(-select\(/.test(fLine),
      'WebGPU: the FORM lane is NEGATED (the op-kind marker)', fLine || '(no write found)');
    ok(/= f32\(select\(/.test(bLine) && !/-select/.test(bLine),
      'WebGPU: the BREAK lane carries the POSITIVE third party', bLine || '(no write found)');
    ok(!/atomic/.test(g.shaderCode.split('brqC')[0] ?? ''),
      'WebGPU: NO atomics are used for the queue (each thread appends only to its own rows)');

    // Both agent gates ACCEPT the verb — a new verb that silently clamps a model
    // to JS is the failure mode the all-target rule exists to prevent.
    ok(isAgentGraphWasmSupported(model), 'the WASM agent gate accepts Transfer Bond');
    ok(isAgentGraphWebGPUSupported(model), 'the WebGPU agent gate accepts Transfer Bond');
  }
}

// ===========================================================================
// TIER M — the SHIPPED `Growing Graphs`: an EXACTNESS oracle against the
// reference implementation (znah's js/graph.js, Paul Cousin's binary cubic GRA).
//
// This is the strongest fidelity check in the harness, and it is possible only
// because the reference is 40 lines. Its division phase LATCHES the flags its
// state phase computed and then divides EVERY flagged node, sequentially, each
// one reading the LIVE adjacency. The port cannot do that in one generation —
// two ADJACENT splitters corrupt each other's queued Rewire — so it drains the
// latches over K INDEPENDENT-SET ROUNDS: one reference tick is PERIOD = 1 + K
// generations. Because a latch is consumed exactly once and the drain finishes,
// N(t) must match the reference EXACTLY for every deterministic rule, not just
// for the rules whose flagged nodes happen to be pairwise non-adjacent.
//
// The BUDGETS ARE READ OFF THE SHIPPED FILE (the Cubic GRA / Tier K precedent):
// a later cadence retune cannot silently shorten these checks.
//
// A rule WITH mutation is deliberately excluded from the oracle: the reference
// flips on Math.random and the port on the seeded shared stream, so the two run
// different noise realisations — a difference in inputs, not in fidelity.
//
// It also pins the bootstrap: the shipped model must build precisely the
// reference's 10-node seed graph (a 10-cycle plus five chords = 15 edges) and
// its exact initial state vector, from a handle-indexed lookup table.
// ===========================================================================

/** The reference implementation, transcribed from js/graph.js (mutation off —
 *  the oracle rules are deterministic). Deliberately a SEPARATE implementation
 *  from anything under test: it is the ground truth, not a mirror. */
function refCurveGG(rule, cycles, limit = 12000) {
  const NN = 3, CaseN = (NN + 1) * 2;
  const nodes = [[9,1,2],[0,2,4],[1,3,0],[2,4,6],[3,5,1],[4,6,8],[5,7,3],[6,8,9],[7,9,5],[8,0,7]].map(a => a.slice());
  const states = [0,0,0,1,0,1,0,1,1,1];
  let dividing = [];
  const out = [];
  for (let c = 1; c <= cycles; c++) {
    // phase 0 — states + flags
    const cases = nodes.map((node, i) => node.reduce((a, j) => a + states[j], 0) + states[i] * (NN + 1));
    cases.forEach((r, i) => { states[i] = (rule >> r) & 1; dividing[i] = (rule >> (r + CaseN)) & 1; });
    // phase 1 — divide
    for (let i = 0; i < dividing.length; ++i) {
      if (nodes.length >= limit) break;
      if (!dividing[i]) continue;
      const [a, b, cc] = nodes[i];
      const j = nodes.length, k = j + 1;
      nodes[i][0] = a; nodes[i][1] = j; nodes[i][2] = k;
      nodes.push([i, b, k]); nodes.push([i, j, cc]);
      states.push(states[i], states[i]);
      nodes[b][nodes[b].indexOf(i)] = j;
      nodes[cc][nodes[cc].indexOf(i)] = k;
      dividing[i] = 0;
    }
    out.push(nodes.length);
  }
  return out;
}

/** Apply one of the shipped presets (both rule tables + the mutation rate) to a
 *  clone of the model, exactly as loading it in the simulator would. */
function withPresetGG(model, name) {
  const m = cloneModel(model);
  const p = (model.presets ?? []).find(x => x.name === name);
  if (!p) throw new Error(`no preset "${name}"`);
  for (const [tid, data] of Object.entries(p.state.lookupTableData ?? {})) {
    m.attributes.find(a => a.id === tid).tableData = data.slice();
  }
  for (const [k, v] of Object.entries(p.state.modelAttrs ?? {})) {
    m.attributes.find(a => a.id === k).defaultValue = String(v);
  }
  return m;
}

/** How many live agents still carry a LATCHED division intent? The threshold is
 *  READ OFF THE SHIPPED FILE (the `prio < PRIO_FLAG_LIMIT` statement node), so a
 *  later change to the priority banding cannot leave this measuring nothing. */
function flagLimitGG(model) {
  const n = model.agentGraphNodes.find(x => x.data.nodeType === 'statement'
    && x.data.config.operation === '<' && Number(x.data.config._port_y) > 1);
  if (!n) throw new Error('Tier M: could not find the prio flag-limit statement node');
  return Number(n.data.config._port_y);
}
function countLatchedGG(s, limit) {
  let n = 0;
  for (let i = 0; i < s.highWater; i++) if (s.alive[i] && s.attrRead.prio[i] < limit) n++;
  return n;
}
/** Agent `i`'s bond list IN SLOT ORDER — what the split reads (the mother keeps
 *  slot 0 and hands slots 1 and 2 to its daughters), so it is the thing the
 *  fidelity work is actually about. */
const slotsGG = (s, i) => Array.from({ length: s.bondCount[i] }, (_, k) => s.bondPartner[i * s.maxBonds + k]);

/** Re-cadence a model to PERIOD = 1 + k. The period appears in exactly two
 *  places: the state tick's Periodic Step and the division gate's
 *  `generation % PERIOD`. Used ONLY by the negative controls — k = 1 reproduces
 *  the single-round port this phase replaced. */
function withPeriodGG(m, k) {
  const out = cloneModel(m);
  const P = 1 + k;
  for (const n of out.agentGraphNodes) {
    if (n.data.nodeType === 'periodicStep') n.data.config = { ...n.data.config, period: P };
    if (n.data.nodeType === 'arithmeticOperator' && n.data.config.operation === '%') {
      n.data.config = { ...n.data.config, _port_y: String(P) };
    }
  }
  return out;
}

/** Put the split back on REWIRE — the pre-B9 shape, and the negative control for
 *  the whole in-place-receiver claim. `transferBond`'s two ports map 1:1 onto
 *  `rewireBond`'s (`partnerAgent` → `fromAgent`, `toAgent` → `toAgent`), so the
 *  mutant is a valid graph that performs the same edge MOVE by the scrambling
 *  route. */
function transfersToRewiresGG(model) {
  const out = cloneModel(model);
  const ids = new Set();
  for (const n of out.agentGraphNodes) {
    if (n.data.nodeType !== 'transferBond') continue;
    ids.add(n.id);
    n.data.nodeType = 'rewireBond';
    n.data.config = { ...n.data.config, _port_restLength: '0', _port_stiffness: '0' };
  }
  for (const e of out.agentGraphEdges) {
    if (ids.has(e.target) && e.targetHandle === 'input_value_partnerAgent') e.targetHandle = 'input_value_fromAgent';
  }
  return out;
}

/** Swap the LAST TWO links of a flow chain of `type` nodes — kept as a generic
 *  op-order mutator for future slot-order controls. */
function swapLastTwoFlowGG(model, type) {
  const out = cloneModel(model);
  const ids = out.agentGraphNodes.filter(n => n.data.nodeType === type).map(n => n.id);
  const set = new Set(ids);
  // the chain: n.next -> m.do among `ids`
  const nextOf = new Map();
  for (const e of out.agentGraphEdges) {
    if (set.has(e.source) && set.has(e.target) && e.sourceHandle.endsWith('_next')) nextOf.set(e.source, e.target);
  }
  const heads = ids.filter(i => ![...nextOf.values()].includes(i));
  const chain = [heads[0]];
  while (nextOf.has(chain[chain.length - 1])) chain.push(nextOf.get(chain[chain.length - 1]));
  if (chain.length < 3) throw new Error(`Tier M: expected a ${type} chain of >= 3, got ${chain.length}`);
  const [a, b, c] = chain.slice(-3);
  const tail = out.agentGraphEdges.find(e => e.source === c && e.sourceHandle.endsWith('_next'));
  for (const e of out.agentGraphEdges) {
    if (e.source === a && e.target === b) e.target = c;
    else if (e.source === b && e.target === c) { e.source = c; e.target = b; }
  }
  if (tail) tail.source = b;
  return out;
}

function tierM() {
  section('TIER M — the SHIPPED `Growing Graphs` — exactness against the reference');
  const model = loadShipped('Growing Graphs');
  const FLAG_LIMIT = flagLimitGG(model);

  // --- the cadence, read off the shipped file ------------------------------
  const PERIOD = Math.max(2, Number(
    model.agentGraphNodes.find(n => n.data.nodeType === 'periodicStep')?.data.config?.period ?? 2));
  const ROUNDS = PERIOD - 1;
  {
    const gate = model.agentGraphNodes.find(n =>
      n.data.nodeType === 'arithmeticOperator' && n.data.config.operation === '%');
    ok(!!gate && Number(gate.data.config._port_y) === PERIOD,
      `the division-round gate uses the SAME period as the state tick (${PERIOD})`,
      `gate % ${gate?.data.config._port_y} vs periodicStep period ${PERIOD}`);
    ok(ROUNDS >= 1, `the cadence is 1 state tick + ${ROUNDS} division rounds`);
  }

  // --- the rule tables ARE the rule integer, bit for bit -------------------
  // Row-major over [own state 0..1] x [ON neighbours 0..3] means the flat cell
  // index IS the reference's case index r = own*4 + onCount. If the stride order
  // ever flipped, the tables would silently address a TRANSPOSED rule.
  for (const id of ['ruleNext', 'ruleDivide']) {
    const attr = model.attributes.find(a => a.id === id);
    const ax = resolveAxes(attr, model);
    ok(JSON.stringify(ax.dims) === '[2,4]', `${id}: axes are [own 0..1] x [on 0..3]`, JSON.stringify(ax.dims));
    ok(JSON.stringify(ax.strides) === '[4,1]', `${id}: row-major stride => flat index == r = own*4 + onCount`, JSON.stringify(ax.strides));
  }
  {
    // The default tables must DECODE to a 16-bit rule integer that the shipped
    // preset catalogue actually contains. Pinning one specific number here would
    // only pin whichever rule the author last chose as the default (it has been
    // 2182 and 3260); what must hold is that the encoding is the reference's —
    // low byte = next state, high byte = divide, flat index = r — and that the
    // default is a coherent catalogue rule rather than an arbitrary bit pattern.
    const next = model.attributes.find(a => a.id === 'ruleNext').tableData;
    const div = model.attributes.find(a => a.id === 'ruleDivide').tableData;
    let R = 0;
    for (let r = 0; r < 8; r++) { R |= (next[r] & 1) << r; R |= (div[r] & 1) << (r + 8); }
    const catalogue = new Set((model.presets ?? [])
      .map(p => /^Rule (\d+)/.exec(p.description ?? ''))
      .filter(Boolean).map(m2 => Number(m2[1])));
    ok(next.every(v => v === 0 || v === 1) && div.every(v => v === 0 || v === 1),
      'the default tables are BITS (low byte = next state, high byte = divide)');
    ok(catalogue.has(R),
      `the default tables decode to a rule the shipped catalogue carries (got ${R})`,
      [...catalogue].join(','));
    // every preset must decode the same way
    let badP = 0;
    for (const p of model.presets ?? []) {
      const m = /^Rule (\d+)/.exec(p.description ?? '');
      if (!m) { badP++; continue; }
      const Rp = Number(m[1]);
      const n = p.state.lookupTableData?.ruleNext, d = p.state.lookupTableData?.ruleDivide;
      for (let r = 0; r < 8; r++) {
        if (n?.[r] !== ((Rp >> r) & 1)) badP++;
        if (d?.[r] !== ((Rp >> (r + 8)) & 1)) badP++;
      }
    }
    ok(badP === 0, `all ${(model.presets ?? []).length} presets decode to their stated rule integer`);
  }

  // --- the preset list IS znah's full catalogue ----------------------------
  // js/app.js ships a 12-entry named `presets` map AND a 22-entry `rules`
  // dropdown; the eleven rules that have no name ship here as "Rule <n>".
  {
    const NAMED = ['quadratic', 'quadratic - mutations', 'two branches', 'branching', 'meduza',
      'exp tree', 'exp hyper', 'exp fractal', 'exp symmetry', 'robust linear',
      'stable explosion', 'fancy tentacles'];
    const CATALOGUE = [2502, 6259, 0x426, 0x8a2, 0x8ae, 0x886, 0x887, 0x8bc, 0x457, 0x26a, 0x409,
      0x1016, 0x897, 0x4625, 0x4621, 0x6621, 0x56cc, 0xcbc, 0x3051, 0x1082, 0x289, 0x21f2];
    const presets = model.presets ?? [];
    const ruleOf = (p) => Number(/^Rule (\d+)/.exec(p.description ?? '')?.[1]);
    ok(presets.length === 23, 'the model ships 23 presets (12 named + 11 numbered)', String(presets.length));
    ok(JSON.stringify(presets.slice(0, 12).map(p => p.name)) === JSON.stringify(NAMED),
      'the 12 NAMED presets come first, in the reference demo\'s own order',
      JSON.stringify(presets.slice(0, 12).map(p => p.name)));
    const numbered = presets.slice(12);
    ok(numbered.every(p => p.name === `Rule ${ruleOf(p)}`),
      'every remaining preset is named for its rule integer');
    const nums = numbered.map(ruleOf);
    ok(JSON.stringify(nums) === JSON.stringify([...nums].sort((a, b) => a - b)),
      'the numbered presets are in ascending rule order', JSON.stringify(nums));
    // EVERY rule of the reference catalogue is reachable, and nothing extra.
    const covered = new Set(presets.map(ruleOf));
    const missing = [...new Set(CATALOGUE)].filter(r => !covered.has(r));
    const extra = [...covered].filter(r => !CATALOGUE.includes(r));
    ok(missing.length === 0 && extra.length === 0,
      `every one of the reference dropdown's ${new Set(CATALOGUE).size} rules ships as a preset, and nothing else`,
      `missing=[${missing}] extra=[${extra}]`);
  }

  // --- the bootstrap builds the reference's EXACT seed graph ---------------
  {
    const rig = shippedRig(model);
    rig.reset();
    ok(rig.store.liveCount === 10, 'the Agent Init Event places exactly 10 seeds', String(rig.store.liveCount));
    const st = Array.from({ length: 10 }, (_, i) => rig.store.attrRead.state[i]);
    ok(JSON.stringify(st) === '[0,0,0,1,0,1,0,1,1,1]', 'seed states == the reference state vector', JSON.stringify(st));
    rig.step();   // generation 0 wires the graph (Form Bond queues, the drain applies)
    const g = decodeAgentGraph(rig.store);
    const got = edgeSet(g);
    const CH = [2, 4, 0, 6, 1, 8, 3, 9, 5, 7];
    const want = new Set();
    // NB the key format must match `edgeSet`'s (`lo:hi`), or a mismatch here is
    // a formatting artefact rather than a real structural difference.
    for (let h = 0; h < 10; h++) {
      const a = [h, (h + 1) % 10].sort((p, q) => p - q); want.add(`${a[0]}:${a[1]}`);
      const b = [h, CH[h]].sort((p, q) => p - q); want.add(`${b[0]}:${b[1]}`);
    }
    const missing = [...want].filter(e => !got.has(e));
    const extra = [...got].filter(e => !want.has(e));
    ok(want.size === 15 && got.size === 15 && missing.length === 0 && extra.length === 0,
      'the bootstrap builds EXACTLY the reference\'s 15 edges (10-cycle + 5 chords)',
      `got ${got.size} missing=[${missing}] extra=[${extra}]`);
    ok(checkDegreeRegular(g, 3) === null, 'every seed has degree exactly 3');
    ok(checkHandshake(g) === null && checkNoDangling(g) === null && checkBondSymmetry(g) === null,
      'I1 / I3 / I2 hold on the seed graph');

    // --- and in the reference's SLOT ORDER, which is not decoration ---------
    // A bond APPENDS to both endpoints' lists, so a node's slot order is its
    // three incident edges sorted by formation time — and the split reads slot 0
    // (kept) and slots 1/2 (handed to the daughters), so the order propagates
    // into the structure forever. The bootstrap therefore scripts a GLOBAL
    // formation order: every agent forms only its own `next` edge, and a chord is
    // issued by its HIGHER endpoint.
    const REF_SEED = [[9,1,2],[0,2,4],[1,3,0],[2,4,6],[3,5,1],[4,6,8],[5,7,3],[6,8,9],[7,9,5],[8,0,7]];
    const orders = Array.from({ length: 10 }, (_, h) => slotsGG(rig.store, h));
    const matches = orders.filter((o, h) => JSON.stringify(o) === JSON.stringify(REF_SEED[h])).length;
    ok(matches === 9, 'the bootstrap reproduces the reference SLOT ORDER for 9 of the 10 seeds',
      `${matches}/10: ${JSON.stringify(orders)}`);
    // THE TENTH IS PROVABLY IMPOSSIBLE, and asserting WHICH one pins the proof:
    // node h's prev-edge is e(h-1) and its next-edge is e(h), so [prev, next] for
    // every h at once would need t(e9) < t(e0) < ... < t(e9). Exactly one node
    // must carry its two cycle edges the other way round.
    // Node 0's prev-edge e9 is issued by agent 9, i.e. LAST of all fifteen, so it
    // lands in slot 2 and the chord takes slot 1: [next, chord, prev].
    ok(JSON.stringify(orders[0]) === JSON.stringify([1, 2, 9]),
      'node 0 is the one provable exception ([next, chord, prev] — the cycle admits no consistent ordering)',
      JSON.stringify(orders[0]));
    // NEG: give each chord to its LOWER endpoint instead, so a chord can land
    // before a cycle edge, and the count must drop.
    {
      const mutated = cloneModel(model);
      // The chord-ownership test is the one Compare whose `x` comes from the
      // chordPartner lookup (several nodes share op '<' with both ports wired).
      const chordLut = mutated.agentGraphNodes.find(n => n.data.nodeType === 'lookupInteraction'
        && n.data.config.tableId === 'chordPartner');
      const cmpId = mutated.agentGraphEdges.find(e => e.source === chordLut?.id
        && e.targetHandle === 'input_value_x')?.target;
      const cmp = mutated.agentGraphNodes.find(n => n.id === cmpId && n.data.nodeType === 'statement');
      if (cmp) cmp.data.config = { ...cmp.data.config, operation: '>' };
      const r2 = shippedRig(mutated); r2.reset(); r2.step();
      const m2 = Array.from({ length: 10 }, (_, h) => slotsGG(r2.store, h))
        .filter((o, h) => JSON.stringify(o) === JSON.stringify(REF_SEED[h])).length;
      ok(!!cmp && m2 < 9, `NEG (mutant): giving each chord to its LOWER endpoint drops the slot-order match to ${m2}/10`);
    }
  }

  // --- THE SPLIT BUILDS THE REFERENCE'S EXACT LOCAL STRUCTURE --------------
  // znah's division is  nodes[i] = [a,j,k];  push([i,b,k]);  push([i,j,c]).
  // Ours is five queued ops, and because every bond APPENDS, the OP ORDER is
  // what decides the daughters' slot order. Assert all three lists through the
  // real engine, and negative-control the op order that produces them.
  //
  // ALL FOUR AFFECTED ROWS are asserted: the mother, both daughters, and — the
  // piece the Transfer verb exists for — the two RECEIVERS b and c, whose slot
  // holding the mother must be OVERWRITTEN IN PLACE rather than compacted.
  {
    const runOneSplit = (m) => {
      const rig = shippedRig(m); rig.reset();
      for (let g = 0; g < PERIOD; g++) rig.step();
      for (let c = 0; c < 8; c++) {
        rig.step();                                   // state tick
        for (let r = 1; r <= ROUNDS; r++) {
          const s = rig.store, hw = s.highWater;
          const pre = Array.from({ length: hw }, (_, i) => slotsGG(s, i));
          rig.step();
          for (let i = 0; i < hw; i++) {
            const now = slotsGG(s, i);
            const fresh = now.filter(p => p >= hw);
            if (fresh.length !== 2) continue;
            const [a, b, cc] = pre[i];
            const j = Math.min(...fresh), k = Math.max(...fresh);
            return {
              i, a, b, c: cc, j, k, mother: now, dj: slotsGG(s, j), dk: slotsGG(s, k),
              // the receivers, before and after — a Transfer must leave every one
              // of their other slots exactly where it was.
              preB: pre[b], postB: slotsGG(s, b), preC: pre[cc], postC: slotsGG(s, cc),
            };
          }
        }
      }
      return null;
    };
    /** znah's `node[node.indexOf(i)] = repl` — the ONE row operation Transfer
     *  reproduces. Used as the expectation, so the check states the reference
     *  semantics rather than a transcribed answer. */
    const reconnect = (row, from, to) => row.map(p => (p === from ? to : p));

    const sp = runOneSplit(withPresetGG(model, 'quadratic'));
    ok(!!sp, 'a split was observed');
    if (sp) {
      ok(JSON.stringify(sp.mother) === JSON.stringify([sp.a, sp.j, sp.k]),
        `the MOTHER keeps slot 0 and takes [a, j, k] — the reference's own row`, JSON.stringify(sp.mother));
      ok(JSON.stringify(sp.dj) === JSON.stringify([sp.i, sp.b, sp.k]),
        `daughter j is [i, b, k]`, JSON.stringify(sp.dj));
      ok(JSON.stringify(sp.dk) === JSON.stringify([sp.i, sp.j, sp.c]),
        `daughter k is [i, j, c]`, JSON.stringify(sp.dk));
      ok(JSON.stringify(sp.postB) === JSON.stringify(reconnect(sp.preB, sp.i, sp.j)),
        `receiver b is nodes[b][indexOf(i)] = j — IN PLACE`,
        `${JSON.stringify(sp.preB)} -> ${JSON.stringify(sp.postB)}`);
      ok(JSON.stringify(sp.postC) === JSON.stringify(reconnect(sp.preC, sp.i, sp.k)),
        `receiver c is nodes[c][indexOf(i)] = k — IN PLACE`,
        `${JSON.stringify(sp.preC)} -> ${JSON.stringify(sp.postC)}`);
    }
    // NEG (source mutation): put the split back on REWIRE — the verb this phase
    // replaced. Rewire is break+form at the MOTHER, so each receiver's row is
    // compacted instead of overwritten and the reference's order is lost.
    const sp2 = runOneSplit(transfersToRewiresGG(withPresetGG(model, 'quadratic')));
    const brokeB = !!sp2 && JSON.stringify(sp2.postB) !== JSON.stringify(reconnect(sp2.preB, sp2.i, sp2.j));
    const brokeC = !!sp2 && JSON.stringify(sp2.postC) !== JSON.stringify(reconnect(sp2.preC, sp2.i, sp2.k));
    ok(brokeB || brokeC,
      'NEG (mutant): replacing the two Transfers with REWIRES scrambles a receiver\'s slot order',
      sp2 ? `b ${JSON.stringify(sp2.preB)}->${JSON.stringify(sp2.postB)} c ${JSON.stringify(sp2.preC)}->${JSON.stringify(sp2.postC)}` : 'no split');
  }

  // --- THE DRAIN COMPLETES — the justification for K -----------------------
  // A latch that survives all K rounds is silently re-latched by the next state
  // tick, which is the ONE residual deviation from the reference. K was chosen
  // as the smallest value that drives the leftover count to ZERO; assert it, so
  // a cadence retune that reintroduces leftovers fails here.
  //
  // ALIGNMENT: generations 0..PERIOD-1 are the bootstrap cycle (generation 0 is
  // phase 0, but the seeds are still unwired so nothing is latched). After it,
  // generation ≡ 0 (mod PERIOD) is a state tick.
  const runCycles = (m, cycles, { cap = 1e9, onCycle = null, seed } = {}) => {
    const rig = shippedRig(m); seed === undefined ? rig.reset() : rig.reset(seed);
    for (let g = 0; g < PERIOD; g++) rig.step();           // the bootstrap cycle
    const s = rig.store, curve = [];
    for (let c = 0; c < cycles; c++) {
      rig.step();                                          // phase 0 — the STATE tick
      const latched = countLatchedGG(s, FLAG_LIMIT);
      let deepest = 0;
      for (let r = 1; r <= ROUNDS; r++) {                   // phases 1..K — the DRAIN
        const before = countLatchedGG(s, FLAG_LIMIT);
        rig.step();
        if (before > 0 && countLatchedGG(s, FLAG_LIMIT) < before) deepest = r;
      }
      if (onCycle) onCycle({ cycle: c, latched, deepest, leftover: countLatchedGG(s, FLAG_LIMIT), store: s });
      curve.push(s.liveCount);
      if (s.liveCount > cap) break;
    }
    return curve;
  };
  {
    let latched = 0, leftover = 0, deepest = 0;
    for (const name of ['meduza', 'Rule 17957', 'Rule 26145', 'exp hyper', 'two branches']) {
      runCycles(withPresetGG(model, name), 40, {
        cap: 6000,
        onCycle: (o) => { latched += o.latched; leftover += o.leftover; deepest = Math.max(deepest, o.deepest); },
      });
    }
    // THE DRAIN NO LONGER PROVABLY FINISHES, AND THAT IS A MEASURED CONSEQUENCE
    // OF THE FIDELITY WORK, NOT A REGRESSION IN THE MACHINERY.
    //
    // A latched node may split only when its handle is BELOW every bonded
    // neighbour's, so a path of flagged nodes with ascending handles drains ONE
    // PER ROUND — the round count a tick needs is the longest such chain. The
    // reference has no such limit: it divides sequentially in index order, so any
    // chain length costs it one pass.
    //
    // Before B9 the receivers' slot orders were SCRAMBLED by Rewire, which broke
    // those chains up by accident and let K = 8 drain every latch. With the
    // Transfer verb the port builds the reference's own adjacency, and with it the
    // reference's own long flagged chains. Raising K only postpones the leftovers
    // (measured on this same set: K = 8 / 12 / 20 all leave some), so K stays at
    // the 8 the layout budget was tuned against and the residue is DOCUMENTED
    // rather than papered over. What it costs is bounded and named below: one
    // published rule (`exp hyper`) of eighteen loses its N(t) exactness.
    //
    // The threshold is a RATE, calibrated well above the measurement (~1 %) and
    // well below "the drain stopped working" — a machinery regression would put
    // leftovers in the tens of percent.
    const rate = latched > 0 ? leftover / latched : 1;
    ok(rate < 0.05,
      `the ${ROUNDS}-round drain consumes ${(100 * (1 - rate)).toFixed(2)} % of latches (${leftover} of ${latched} survive into the next state tick)`,
      `rate ${(100 * rate).toFixed(2)} %`);
    ok(latched > 1000, `the drain check is not vacuous — ${latched} latches were raised`);
    ok(deepest > 0, `the drain does real work — the deepest round consuming a latch is ${deepest} of ${ROUNDS}`);
  }

  // --- THE DRAIN IS DETERMINISTIC ------------------------------------------
  // The priority IS the handle, so which nodes win a round no longer depends on
  // the shared RNG stream: a mutation-free rule must produce the SAME labelled
  // graph from any seed. (It used to be a random roll, which made the within-tick
  // split order — and therefore the whole embedding — vary run to run.)
  {
    const dump = (seed) => {
      const rig = shippedRig(withPresetGG(model, 'meduza'));
      rig.reset(seed);
      for (let g = 0; g < PERIOD * 12; g++) rig.step();
      const s = rig.store;
      return { n: s.liveCount, adj: Array.from({ length: s.highWater }, (_, i) => slotsGG(s, i).join(',')).join('|') };
    };
    const a = dump(0x1234abcd), b = dump(0xdeadbeef), c = dump(1);
    ok(a.n > 40 && a.adj === b.adj && a.adj === c.adj,
      `three different RNG seeds produce the IDENTICAL labelled graph (N=${a.n}) — the drain order is the handle, not a roll`,
      `${a.n} / ${b.n} / ${c.n}`);
  }

  // --- THE EXACTNESS ORACLE ------------------------------------------------
  // One reference tick is PERIOD generations. Every DETERMINISTIC published rule
  // must match cycle for cycle — including the rules whose flagged nodes CAN be
  // adjacent, which the single-round port could not follow at all.
  const oracleRules = [
    ['quadratic', 2182, 100],       // regression: independent flags, matched before this phase too
    ['exp tree', 2236, 100],        // regression: same class
    ['meduza', 2502, 55],           // THE GAP — adjacent flags
    ['Rule 17957', 17957, 60],      // the deepest drain in the catalogue (8 rounds)
    ['Rule 26145', 26145, 60],      // ditto
  ];
  for (const [name, rule, cyc] of oracleRules) {
    const mine = runCycles(withPresetGG(model, name), cyc);
    const ref = refCurveGG(rule, cyc);
    const n = Math.min(mine.length, ref.length, cyc);
    let firstDiff = -1;
    for (let i = 0; i < n; i++) if (mine[i] !== ref[i]) { firstDiff = i; break; }
    ok(firstDiff === -1,
      `"${name}" (rule ${rule}): N(t) matches the reference EXACTLY for ${n} cycles (N=${ref[n - 1]})`,
      firstDiff >= 0 ? `first divergence at cycle ${firstDiff + 1}: ${mine[firstDiff]} vs ${ref[firstDiff]}` : '');
  }
  // THE ONE DOCUMENTED DEVIATION, pinned rather than omitted. `exp hyper` flags
  // essentially everything, so its flagged chains outrun any practical K (see the
  // drain block above), and its N(t) parts company after roughly 25 cycles. It is
  // asserted BOTH ways — exact up to a floor, and known-divergent — so a future
  // change that makes it worse, or that fixes it, is noticed rather than silently
  // absorbed into a hand-written list.
  {
    const EXACT_FLOOR = 20;
    const mine = runCycles(withPresetGG(model, 'exp hyper'), 60, { cap: 6000 });
    const refH = refCurveGG(Number(/^Rule (\d+)/.exec((model.presets ?? []).find(p => p.name === 'exp hyper').description ?? '')[1]), mine.length);
    let firstDiff = -1;
    for (let i = 0; i < Math.min(mine.length, refH.length); i++) if (mine[i] !== refH[i]) { firstDiff = i; break; }
    ok(firstDiff === -1 || firstDiff >= EXACT_FLOOR,
      `"exp hyper" — the DOCUMENTED deviation — still matches the reference for its first ${firstDiff === -1 ? mine.length : firstDiff} cycles`,
      `diverges at cycle ${firstDiff + 1}`);
  }
  // NEG (source mutation): collapse the cadence to a SINGLE division round — the
  // port this phase replaced — and the same oracle must fail for a rule whose
  // flagged nodes can be adjacent. This is what makes the multi-round drain
  // demonstrably load-bearing: `meduza` diverges within a couple of cycles.
  {
    const one = withPeriodGG(withPresetGG(model, 'meduza'), 1);
    const rig = shippedRig(one); rig.reset();
    for (let g = 0; g < 2; g++) rig.step();                 // the bootstrap cycle at PERIOD 2
    const mine = [];
    for (let c = 0; c < 20; c++) { rig.step(); rig.step(); mine.push(rig.store.liveCount); }
    const ref = refCurveGG(2502, 20);
    let firstDiff = -1;
    for (let i = 0; i < 20; i++) if (mine[i] !== ref[i]) { firstDiff = i; break; }
    ok(firstDiff >= 0,
      `NEG (mutant): with ONE division round "meduza" diverges from the reference at cycle ${firstDiff + 1}`,
      'a single round matched — the drain rounds are not being tested');
  }
  // NEG (source mutation): revert the priority to the obvious-but-wrong form —
  // a bare roll, with no division intent folded in — and the SAME oracle must
  // fail. This is what makes the intent-aware gate demonstrably load-bearing
  // rather than a stylistic choice: without it a flagged node waits behind
  // neighbours that never wanted to split.
  {
    const m = withPresetGG(model, 'quadratic');
    // The priority expression bands the handle: `h * d + (1 - d) * UNFLAGGED`.
    const prioNode = m.agentGraphNodes.find(n => n.data.nodeType === 'expression'
      && /\bh\b/.test(String(n.data.config.expression)) && /\bd\b/.test(String(n.data.config.expression)));
    ok(!!prioNode, 'NEG setup: found the priority expression node');
    if (prioNode) {
      // Drop the banding: EVERY node stores its handle, flagged or not, so a
      // flagged node must now also out-rank neighbours that never wanted to split.
      prioNode.data.config = { ...prioNode.data.config, expression: 'h + d * 0' };
      const mine = runCycles(m, 40);
      const ref = refCurveGG(2182, 40);
      ok(mine.some((v, i) => v !== ref[i]),
        'NEG (mutant): an intent-BLIND priority breaks the exactness oracle',
        `mine ${mine[39]} vs ref ${ref[39]}`);
    }
  }

  // --- O6 at every generation, over several published rules ----------------
  // The budget is stated in REFERENCE TICKS and scaled by the shipped period, so
  // a cadence retune cannot silently shorten it.
  // The four NUMBERED rules are here on purpose: this phase added eleven presets
  // that nothing else exercises, and a catalogue entry that decoded to a broken
  // automaton would otherwise ship silently.
  const O6_TICKS = 30;
  for (const name of ['quadratic', 'meduza', 'exp tree', 'branching',
    'Rule 1033', 'Rule 4226', 'Rule 12369', 'Rule 17957']) {
    const rig = shippedRig(withPresetGG(model, name));
    rig.reset();
    let bad = null;
    const gens = O6_TICKS * PERIOD;
    for (let gen = 1; gen <= gens && !bad; gen++) {
      const { overflow } = rig.step();
      if (overflow) { bad = `gen ${gen}: request queue OVERFLOW`; break; }
      const g = decodeAgentGraph(rig.store);
      bad = checkHandshake(g) ?? checkNoDangling(g) ?? checkCapacity(g) ?? checkBondSymmetry(g);
      if (bad) { bad = `gen ${gen}: ${bad}`; break; }
      const reg = checkDegreeRegular(g, 3);
      if (reg) { bad = `gen ${gen}: O6 — ${reg}`; break; }
      const E = edgeSet(g).size, N = rig.store.liveCount;
      if (E !== 3 * N / 2) { bad = `gen ${gen}: E=${E} != 3N/2 (N=${N})`; break; }
    }
    ok(bad === null,
      `"${name}": O6 (deg 3, E = 3N/2) + I1-I4 hold at EVERY one of ${gens} generations (${O6_TICKS} ticks) -> N=${rig.store.liveCount}`,
      String(bad));
  }

  // --- the published rules are genuinely DIFFERENT automata ----------------
  // Six of them, INCLUDING two of the numbered ones this phase added, so a
  // catalogue entry that silently decoded to the same automaton would show up.
  {
    const outcomes = {};
    for (const name of ['quadratic', 'meduza', 'exp tree', 'branching', 'stable explosion',
      'exp hyper', 'Rule 1033', 'Rule 2222', 'Rule 12369', 'Rule 17957']) {
      const rig = shippedRig(withPresetGG(model, name));
      rig.reset();
      for (let g = 0; g < 20 * PERIOD; g++) rig.step();
      outcomes[name] = rig.store.liveCount;
    }
    ok(new Set(Object.values(outcomes)).size >= 7,
      `the presets produce distinct outcomes after ${20 * PERIOD} generations: ${JSON.stringify(outcomes)}`);
    // Calibrated against the reference rather than a magic threshold, so the
    // number cannot silently drift with the cadence.
    const q20 = refCurveGG(2182, 20)[19];
    ok(outcomes['quadratic'] === q20,
      `quadratic grows from the 10-node seed to the reference's own N after 20 ticks (${q20})`,
      String(outcomes['quadratic']));
    ok(outcomes['Rule 17957'] > 200, 'a NUMBERED catalogue rule grows too', String(outcomes['Rule 17957']));
  }
}

// ===========================================================================
// TIER O — Form Bond's OPTIONAL PAIR PORT (`agentA`, defaulting to self).
//
// Wiring `agentA` LOWERS the op to the Form Between encoding, so one node covers
// both "bond me to X" and "bond X to Y". Two claims have to hold, and they are
// checked at the two different levels they live at:
//
//   ENGINE  — a Between entry naming the REQUESTER produces exactly the bond the
//             self-form entry produces (this is what makes "unwired ⇒ self" a
//             real default rather than a near-enough one);
//   COMPILE — the unwired case still emits the historical self-form arm on all
//             three agent targets, and the wired case emits the Between arm.
//
// The link between the two is the parity harness's `[synthetic] Form Bond pair
// ports` VALUE INVARIANT, which pins the exact lanes the emitters write.
// ===========================================================================
function tierO() {
  section('TIER O — Form Bond\'s optional pair port (agentA defaults to self)');

  // --- 1. THE ENGINE CLAIM: a Between naming the requester ≡ the self-form ---
  {
    const selfForm = queueStore(12, 4, 8);
    queueOp(selfForm, 3, 0, { to: 7, L: 2.5, K: 4 });          // agentA UNWIRED
    drainAgentBondRequests(selfForm, 1);

    const viaPair = queueStore(12, 4, 8);
    queueBetween(viaPair, 3, 0, { a: 3, b: 7, L: 2.5, K: 4 }); // agentA = Get Self Handle
    drainAgentBondRequests(viaPair, 1);

    const eA = [...edgeSet(decodeAgentGraph(selfForm))].sort().join(',');
    const eB = [...edgeSet(decodeAgentGraph(viaPair))].sort().join(',');
    ok(eA === '3:7' && eA === eB,
      'wiring agentA to THIS agent forms exactly the bond the unwired node forms', `${eA} vs ${eB}`);
    // ...and not merely the same edge SET — the same slots, rest length and λ, so
    // nothing downstream (slot order, spring force) can tell the two apart.
    let same = true;
    for (let i = 0; i < selfForm.highWater; i++) {
      if (selfForm.bondCount[i] !== viaPair.bondCount[i]) { same = false; break; }
      for (let k = 0; k < selfForm.bondCount[i]; k++) {
        const o = i * selfForm.maxBonds + k;
        if (selfForm.bondPartner[o] !== viaPair.bondPartner[o]
          || selfForm.bondRestLength[o] !== viaPair.bondRestLength[o]
          || selfForm.bondStiffness[o] !== viaPair.bondStiffness[o]) { same = false; break; }
      }
    }
    ok(same, 'the two are identical slot-for-slot (partner, rest length, stiffness)');
    ok(allInvariants(viaPair) === null, 'I1–I4 hold after the paired form');

    // NEGATIVE CONTROL: the same entry naming a DIFFERENT first agent bonds that
    // pair instead — so the check above is really reading the first endpoint and
    // not just "some bond appeared".
    const third = queueStore(12, 4, 8);
    queueBetween(third, 3, 0, { a: 5, b: 7 });
    drainAgentBondRequests(third, 1);
    ok(hasBond(third, 5, 7) && !hasBond(third, 3, 7),
      'negative control: a wired agentA naming a THIRD PARTY bonds that pair, not the requester');
  }

  // --- 2. THE COMPILE CLAIM, on all three agent targets ---------------------
  {
    const mk = (wireA) => {
      const n = [], e = [];
      const an = (t, c) => { const x = { id: `n${n.length}`, type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c || {} } }; n.push(x); return x; };
      const ed = (s, sp, tt, tp, cat) => e.push({ id: `e${e.length}`, source: s.id, target: tt.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
      const bs = an('behaviourStep');
      const gsh = an('getSelfHandle');
      const off = (k) => { const x = an('arithmeticOperator', { operation: '+', _port_y: String(k) }); ed(gsh, 'value', x, 'x', 'value'); return x; };
      const fb = an('formBond', { _port_restLength: '0', _port_stiffness: '0' });
      ed(bs, 'do', fb, 'do', 'flow');
      ed(off(1), 'result', fb, 'targetAgent', 'value');
      if (wireA) ed(off(4), 'result', fb, 'agentA', 'value');
      return {
        schemaVersion: 1,
        properties: { name: 'pairport', dimension: '2d', gridWidth: 16, gridHeight: 16, gridDepth: 1, topology: '2d-grid', boundaryTreatment: 'torus', useWasm: false, useWebGPU: false },
        topologyMode: { gridCells: false, agents: true },
        centerBased: { ...queueCfg(64, 4, 8), worldWidth: 16, worldHeight: 16, agentTarget: 'wasm', agentUpdateMode: 'async' },
        attributes: [], modelAttributes: [], neighborhoods: [], agentAttributes: [],
        bondAttributes: [], variables: [], agentVariables: [], indicators: [], mappings: [],
        graphNodes: [], graphEdges: [], agentGraphNodes: n, agentGraphEdges: e, macroDefs: [],
      };
    };
    const plain = mk(false), paired = mk(true);

    // JS — the historical self-form arm writes the POSITIVE `BOND_REQ_NONE` break
    // lane; the paired one writes the NEGATED first id.
    const jsPlain = compileAgentGraph(plain.agentGraphNodes, plain.agentGraphEdges, plain, 0);
    const jsPaired = compileAgentGraph(paired.agentGraphNodes, paired.agentGraphEdges, paired, 0);
    ok(!jsPlain.error && !jsPaired.error, 'both shapes compile on JS', String(jsPlain.error || jsPaired.error));
    ok(/_bondBreakReq\[_bq\] = 1;/.test(jsPlain.behaviourCode),
      'JS: an UNWIRED agentA keeps the historical self-form break lane');
    ok(!/-\(_bqA \+ 2\)/.test(jsPlain.behaviourCode),
      'JS: an UNWIRED agentA emits NO Form Between encoding');
    ok(/_bondBreakReq\[_bq\] = _bqOk \? -\(_bqA \+ 2\)/.test(jsPaired.behaviourCode),
      'JS: a WIRED agentA emits the Form Between encoding (negative break lane)');

    // WASM — the module BYTES must differ (the paired one takes the other arm),
    // and the unwired one must still compile + be accepted by the gate.
    ok(isAgentGraphWasmSupported(plain) && isAgentGraphWasmSupported(paired),
      'both shapes pass the WASM agent gate');
    const wPlain = compileAgentGraphWasmForModel(plain);
    const wPaired = compileAgentGraphWasmForModel(paired);
    ok(!wPlain.error && !wPaired.error && wPlain.bytes.length && wPaired.bytes.length,
      'both shapes compile to WASM', String(wPlain.error || wPaired.error));
    ok(Buffer.compare(Buffer.from(wPlain.bytes), Buffer.from(wPaired.bytes)) !== 0,
      'WASM: wiring agentA changes the emitted module (the two arms are really different code)');

    // WebGPU — the negative-lane form appears only in the paired shader.
    ok(isAgentGraphWebGPUSupported(plain) && isAgentGraphWebGPUSupported(paired),
      'both shapes pass the WebGPU agent gate');
    const gPlain = compileAgentGraphWebGPUForModel(plain);
    const gPaired = compileAgentGraphWebGPUForModel(paired);
    ok(!gPlain.error && !gPaired.error, 'both shapes compile to WGSL', String(gPlain.error || gPaired.error));
    // `reqAt` resolves the field NAME to a numeric base, so the assertions key
    // off the layout's own base rather than a string that never appears.
    const breakAt = (r) => {
      const b = r.layout.f32Base['bondBreakReq'];
      return b === 0 ? 'agentF32\\[\\w+\\]' : `agentF32\\[${b}u \\+ \\w+\\]`;
    };
    ok(new RegExp(`${breakAt(gPaired)} = f32\\(-select\\(1, \\w+ \\+ 2, \\w+\\)\\);`).test(gPaired.shaderCode),
      'WGSL: a WIRED agentA emits the negated break lane');
    ok(!/= f32\(-select\(/.test(gPlain.shaderCode),
      'WGSL: an UNWIRED agentA emits NO negated lane (the historical self-form arm)');
    ok(new RegExp(`${breakAt(gPlain)} = 1\\.0;`).test(gPlain.shaderCode),
      'WGSL: the unwired arm writes the positive NONE break lane');
  }
}

// ===========================================================================
// TIER P — BREAK BOND's OPTIONAL PAIR PORT (`agentA`) and the BREAK BETWEEN
// encoding: BOTH request lanes negated.
//
// The verb closes the last gap in the self-anchored set: Rewire and Transfer are
// both ANCHORED AT THE REQUESTER, so no verb could sever an edge between two
// agents the rule is not part of. Wiring Break Bond's `agentA` lowers it to the
// one sign combination Form Between (−,+) and Transfer (+,−) left free.
//
// Three things have to hold, and they live at three different levels:
//   ENCODING — the six op kinds decode DISTINCTLY from the sign pair alone
//              (§1: the same two ids under all six encodings ⇒ six outcomes);
//   DECODE ORDER — the both-negative arm must be tested FIRST (§2), or the entry
//              falls into Form Between's `bl < 0` branch, decodes its second id
//              from a NEGATIVE lane, gets −1, fails that arm's gate and is
//              DROPPED: the bond silently survives;
//   I5     — a cut that cannot apply touches NOTHING (§3), and does not truncate
//              the queue behind it.
// ===========================================================================

/** Write ONE BREAK BETWEEN entry, mirroring all three emitters: BOTH lanes carry
 *  the negated, `+2`-biased id (an unresolvable side writes −NONE). */
function queueBreakBetween(st, i, c, { a = -1, b = -1 } = {}) {
  const slots = st.bondReqSlots, depth = slots - 1;
  const e = i * slots + Math.min(c, depth);
  const good = a >= 0 && b >= 0;
  st.bondBreakReq[e] = good ? -(a + BOND_REQ_ID_BIAS) : -BOND_REQ_NONE;
  st.bondFormReq[e] = good ? -(b + BOND_REQ_ID_BIAS) : -BOND_REQ_NONE;
}

/** A minimal agent graph whose only verb is a Break Bond, with `agentA` wired or
 *  not — the emit-shape + byte-identity fixture (mirrors Tier O's `mk`). */
function buildBreakPairModel(wireA) {
  const n = [], e = [];
  const an = (t, c) => { const x = { id: `n${n.length}`, type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c || {} } }; n.push(x); return x; };
  const ed = (s, sp, tt, tp, cat) => e.push({ id: `e${e.length}`, source: s.id, target: tt.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
  const bs = an('behaviourStep');
  const gsh = an('getSelfHandle');
  const off = (k) => { const x = an('arithmeticOperator', { operation: '+', _port_y: String(k) }); ed(gsh, 'value', x, 'x', 'value'); return x; };
  const bb = an('breakBond', {});
  ed(bs, 'do', bb, 'do', 'flow');
  ed(off(1), 'result', bb, 'targetAgent', 'value');
  // ⚠️ `agentA` must be WIRED, not merely configured: the port carries no inline
  // widget, so wiredness is the EDGE-map answer on all three targets and a
  // config-only `_port_agentA` would leave the node on its self-break arm.
  if (wireA) ed(off(4), 'result', bb, 'agentA', 'value');
  return {
    schemaVersion: 1,
    properties: { name: 'breakpair', dimension: '2d', gridWidth: 16, gridHeight: 16, gridDepth: 1, topology: '2d-grid', boundaryTreatment: 'torus', useWasm: false, useWebGPU: false },
    topologyMode: { gridCells: false, agents: true },
    centerBased: { ...queueCfg(64, 4, 8), worldWidth: 16, worldHeight: 16, agentTarget: 'wasm', agentUpdateMode: 'async' },
    attributes: [], modelAttributes: [], neighborhoods: [], agentAttributes: [],
    bondAttributes: [], variables: [], agentVariables: [], indicators: [], mappings: [],
    graphNodes: [], graphEdges: [], agentGraphNodes: n, agentGraphEdges: e, macroDefs: [],
  };
}

function tierP() {
  section('TIER P — Break Bond\'s optional pair port (the BREAK BETWEEN encoding)');

  // --- 0. registration + the marker ---------------------------------------
  {
    ok(BOND_REQUEST_NODE_TYPES.has('breakBond'),
      'breakBond is a queue verb (so the layout reserves the queue for it)');
    ok(BOND_REQ_BREAK_BETWEEN_SIGN === -1, 'the op-kind marker is BOTH lane SIGNS');
    const only = { agentGraphNodes: [{ id: 'a', data: { nodeType: 'breakBond' } }], centerBased: {}, topologyMode: { agents: true } };
    ok(bondReqSlotsForModel(only) === 9,
      'a graph whose ONLY verb is Break Bond reserves depth + the overflow bucket');
  }

  // --- 1. THE SIGN TABLE IS COMPLETE AND UNAMBIGUOUS ------------------------
  //
  // Feed the SAME two ids (A=1, B=2) through every encoding and read the graph
  // back. Six encodings, six distinct outcomes — which is what makes the sign
  // pair a real discriminator rather than a convention nothing checks.
  {
    const REQ = 0, A = 1, B = 2;
    const run = (write, seed) => {
      const st = queueStore(12, 4, 8);
      seed(st);
      write(st);
      drainAgentBondRequests(st, 1);
      return [...edgeSet(decodeAgentGraph(st))].sort().join(',');
    };
    const withAB = (st) => { formBond(st, A, B, 1, 1); };
    const withReqA = (st) => { formBond(st, REQ, A, 1, 1); };

    const outcomes = {
      // (+,+) — the three self-anchored verbs, disambiguated by which side is NONE
      form: run(st => queueOp(st, REQ, 0, { to: B }), () => {}),
      break_: run(st => queueOp(st, REQ, 0, { from: A }), withReqA),
      rewire: run(st => queueOp(st, REQ, 0, { from: A, to: B }), withReqA),
      // (−,+) FORM BETWEEN · (+,−) TRANSFER · (−,−) BREAK BETWEEN
      between: run(st => queueBetween(st, REQ, 0, { a: A, b: B }), () => {}),
      transfer: run(st => queueTransfer(st, REQ, 0, { partner: A, to: B }), withReqA),
      breakBetween: run(st => queueBreakBetween(st, REQ, 0, { a: A, b: B }), withAB),
    };
    ok(outcomes.breakBetween === '',
      'BREAK BETWEEN severs the bond between two agents the requester is NOT part of',
      outcomes.breakBetween);
    ok(outcomes.between === '1:2',
      'the SAME ids with only the BREAK lane negated FORM that bond instead (Form Between)',
      outcomes.between);
    ok(outcomes.transfer === '1:2',
      'the SAME ids with only the FORM lane negated hand the requester\'s edge to B (Transfer)',
      outcomes.transfer);
    ok(outcomes.rewire === '0:2',
      'both lanes POSITIVE is a Rewire — it re-points the REQUESTER\'s edge',
      outcomes.rewire);
    ok(outcomes.form === '0:2' && outcomes.break_ === '',
      'the two single-sided (+,+) encodings are still a plain Form / plain Break',
      `${outcomes.form} | ${outcomes.break_}`);
    // The decisive statement: the two-id verbs are pairwise distinguishable from
    // the OTHER two-id verbs given identical ids and identical starting graphs.
    const twoId = run(st => queueBreakBetween(st, REQ, 0, { a: A, b: B }), withAB);
    const asBetween = run(st => queueBetween(st, REQ, 0, { a: A, b: B }), withAB);
    const asTransfer = run(st => queueTransfer(st, REQ, 0, { partner: A, to: B }), withAB);
    ok(twoId !== asBetween && twoId !== asTransfer,
      'from ONE starting graph the three two-id encodings produce three DIFFERENT graphs',
      `${twoId} / ${asBetween} / ${asTransfer}`);
  }

  // --- 2. THE DECODE-ORDER TRAP -------------------------------------------
  //
  // `bl < 0` alone is Form Between's marker. A both-negative entry reaching that
  // branch decodes `b = fl >= 2 ? fl - 2 : -1` from a NEGATIVE lane, gets -1,
  // fails the `b >= 0 && ...` gate and is skipped — the bond SURVIVES. So the
  // wrong outcome here is a silent DROP, not a corruption; that is milder than
  // Transfer's (which destroys an edge) but just as invisible, and the shipped
  // drain must be shown to avoid it.
  {
    const st = queueStore(12, 4, 8);
    formBond(st, 1, 2, 1, 1);
    const before = [...edgeSet(decodeAgentGraph(st))].sort().join(',');
    queueBreakBetween(st, 0, 0, { a: 1, b: 2 });
    drainAgentBondRequests(st, 1);
    const after = [...edgeSet(decodeAgentGraph(st))].sort().join(',');
    ok(before === '1:2' && after === '',
      'the shipped drain SEVERS the edge (it did not fall into the Form Between arm)',
      `${before} -> ${after}`);

    // The wrong outcome, constructed explicitly: an entry the Form Between arm
    // REJECTS is dropped, leaving the graph untouched. Built by feeding that arm
    // an unresolvable second id — exactly what a negative form lane decodes to.
    const s2 = queueStore(12, 4, 8);
    formBond(s2, 1, 2, 1, 1);
    queueBetween(s2, 0, 0, { a: 1, b: -1 });
    drainAgentBondRequests(s2, 1);
    ok([...edgeSet(decodeAgentGraph(s2))].sort().join(',') === '1:2',
      'negative control: an entry the Form Between arm rejects leaves the bond INTACT — the failure mode a sign-blind decode would produce');

    // And the queue is still consumed either way: a probe queued behind the cut
    // must apply, so a mis-decode cannot be mistaken for a truncation.
    const s3 = queueStore(12, 4, 8);
    formBond(s3, 1, 2, 1, 1); formBond(s3, 3, 4, 1, 1);
    queueBreakBetween(s3, 0, 0, { a: 1, b: 2 });
    queueBreakBetween(s3, 0, 1, { a: 3, b: 4 });
    drainAgentBondRequests(s3, 1);
    ok(edgeSet(decodeAgentGraph(s3)).size === 0,
      'two third-party cuts in ONE generation both apply (the entry is a normal queue op)');
    ok(allInvariants(s3) === null, 'I1–I4 hold after the cuts', String(allInvariants(s3)));
  }

  // --- 3. I5 — every rejection leaves the graph EXACTLY unchanged ----------
  //
  // The probe (queued AFTER the rejected op) cuts 7↔8, so agents 7 and 8 are the
  // only rows expected to change; a rejection that truncated the queue, or that
  // touched anything at all, is caught.
  {
    const cases = [
      ['no such edge (a↔b does not exist)', (s) => { formBond(s, 1, 6, 1, 1); return { a: 1, b: 2 }; }],
      ['`a` is dead', (s) => { formBond(s, 1, 2, 1, 1); freeAgentSlot(s, 1); return { a: 1, b: 2 }; }],
      ['`b` is dead', (s) => { formBond(s, 1, 2, 1, 1); freeAgentSlot(s, 2); return { a: 1, b: 2 }; }],
      ['`a` is out of range', (s) => { formBond(s, 1, 2, 1, 1); return { a: 999, b: 2 }; }],
      ['`b` is out of range', (s) => { formBond(s, 1, 2, 1, 1); return { a: 1, b: 999 }; }],
      ['`a` === `b` (self-aliased)', (s) => { formBond(s, 1, 2, 1, 1); return { a: 1, b: 1 }; }],
      ['`a` === the requester, no such edge', (s) => { formBond(s, 1, 2, 1, 1); return { a: 0, b: 2 }; }],
      ['unresolvable ids (both lanes −NONE)', (s) => { formBond(s, 1, 2, 1, 1); return { a: -1, b: -1 }; }],
    ];
    for (const [name, setup] of cases) {
      const st = queueStore(12, 3, 8);
      const req = setup(st);
      formBond(st, 7, 8, 1, 1);                        // the probe's edge
      const before = [...edgeSet(decodeAgentGraph(st))].sort().join('|');
      const beforeSlots = Array.from({ length: st.highWater }, (_, i) => partnersOf(st, i).join(','));
      queueBreakBetween(st, 0, 0, req);                // the REJECTED op
      queueBreakBetween(st, 0, 1, { a: 7, b: 8 });     // the probe
      drainAgentBondRequests(st, 1);
      // Everything except the probe's own cut must be identical.
      const after = [...edgeSet(decodeAgentGraph(st))].sort().concat('7:8').sort().join('|');
      ok(after === before, `I5 (${name}): the graph is EXACTLY the pre-op graph`, `${before} -> ${after}`);
      const afterSlots = Array.from({ length: st.highWater }, (_, i) => partnersOf(st, i).join(','));
      const moved = beforeSlots.filter((v, i) => i !== 7 && i !== 8 && v !== afterSlots[i]).length;
      ok(moved === 0, `I5 (${name}): not one uninvolved slot moved`, `${moved} rows differ`);
      ok(!hasBond(st, 7, 8),
        `I5 (${name}): the rejected entry still OCCUPIES its slot (no queue truncation)`);
      ok(allInvariants(st) === null, `I5 (${name}): I1–I4 hold`, String(allInvariants(st)));
    }
  }

  // --- 4. I2/I3 — the cut is symmetric and compacts BOTH rows --------------
  //
  // The bond is removed from the middle of both endpoints' lists, so both rows
  // compact; neither may be left with a dangling slot or a stale count.
  {
    const st = queueStore(12, 4, 8);
    const A = 1, B = 2;
    formBond(st, A, 5, 1, 1); formBond(st, A, B, 1, 1); formBond(st, A, 6, 1, 1);
    formBond(st, B, 7, 1, 1); formBond(st, B, 8, 1, 1);
    const degA = st.bondCount[A], degB = st.bondCount[B];
    queueBreakBetween(st, 0, 0, { a: A, b: B });
    drainAgentBondRequests(st, 1);
    ok(st.bondCount[A] === degA - 1 && st.bondCount[B] === degB - 1,
      'BOTH endpoints lose exactly one degree', `${st.bondCount[A]}/${st.bondCount[B]}`);
    ok(st.bondCount[0] === 0, 'the REQUESTER is untouched (it was never part of the edge)');
    ok(!partnersOf(st, A).includes(B) && !partnersOf(st, B).includes(A),
      'I2: neither row still points at the other');
    ok(checkNoDangling(decodeAgentGraph(st)) === null,
      'I3: no dangling slot survives the double compaction',
      String(checkNoDangling(decodeAgentGraph(st))));
    ok(allInvariants(st) === null, 'I1–I4 hold', String(allInvariants(st)));
  }

  // --- 5. multi-op: cuts and forms compose in ONE generation, in slot order --
  {
    const st = queueStore(16, 4, 8);
    formBond(st, 1, 2, 1, 1); formBond(st, 3, 4, 1, 1);
    queueBreakBetween(st, 0, 0, { a: 1, b: 2 });      // cut a pair I am not in
    queueBreakBetween(st, 0, 1, { a: 3, b: 4 });      // and another
    queueOp(st, 0, 2, { to: 5 });                     // and bond myself to a fifth
    drainAgentBondRequests(st, 1);
    const e = [...edgeSet(decodeAgentGraph(st))].sort().join(',');
    ok(e === '0:5', 'two third-party cuts + one self-form all applied in ONE generation', e);
    ok(allInvariants(st) === null, 'I1–I4 hold after the mixed batch', String(allInvariants(st)));

    // Slot ORDER matters: a cut queued after a form must see the form's edge.
    const s2 = queueStore(16, 4, 8);
    queueBetween(s2, 0, 0, { a: 1, b: 2 });           // form 1↔2 …
    queueBreakBetween(s2, 0, 1, { a: 1, b: 2 });      // … then cut it
    drainAgentBondRequests(s2, 1);
    ok(edgeSet(decodeAgentGraph(s2)).size === 0,
      'a cut queued AFTER a form in the same generation severs the freshly-formed edge');
  }

  // --- 6. the emitted SHAPE on all three targets, and byte identity ---------
  {
    const plain = buildBreakPairModel(false), paired = buildBreakPairModel(true);

    // JS — the unwired arm keeps the historical single-sided break lanes; the
    // wired one negates BOTH.
    const jsPlain = compileAgentGraph(plain.agentGraphNodes, plain.agentGraphEdges, plain, 0);
    const jsPaired = compileAgentGraph(paired.agentGraphNodes, paired.agentGraphEdges, paired, 0);
    ok(!jsPlain.error && !jsPaired.error, 'both shapes compile on JS', String(jsPlain.error || jsPaired.error));
    ok(/_bondFormReq\[_bq\] = 1;/.test(jsPlain.behaviourCode)
      && /_bondBreakReq\[_bq\] = _bqT >= 0 \? _bqT \+ 2 : 1;/.test(jsPlain.behaviourCode),
      'JS: an UNWIRED agentA keeps the historical self-break lanes');
    ok(!/-\(_bqA \+ 2\)/.test(jsPlain.behaviourCode),
      'JS: an UNWIRED agentA emits NO two-id encoding');
    ok(/_bondBreakReq\[_bq\] = _bqOk \? -\(_bqA \+ 2\) : -1;/.test(jsPaired.behaviourCode),
      'JS: a WIRED agentA negates the BREAK lane');
    ok(/_bondFormReq\[_bq\] = _bqOk \? -\(_bqB \+ 2\) : -1;/.test(jsPaired.behaviourCode),
      'JS: a WIRED agentA negates the FORM lane too (the both-negative marker)');
    ok(!/_bondFormL\[_bq\]/.test(jsPaired.behaviourCode),
      'JS: a Break Between writes NO form-half parameters (it has no form half)');

    // WASM — both compile, the gate accepts both, and the BYTES differ (the two
    // arms are really different code, not one arm with a runtime flag).
    ok(isAgentGraphWasmSupported(plain) && isAgentGraphWasmSupported(paired),
      'both shapes pass the WASM agent gate');
    const wPlain = compileAgentGraphWasmForModel(plain);
    const wPaired = compileAgentGraphWasmForModel(paired);
    ok(!wPlain.error && !wPaired.error && wPlain.bytes.length && wPaired.bytes.length,
      'both shapes compile to WASM', String(wPlain.error || wPaired.error));
    ok(Buffer.compare(Buffer.from(wPlain.bytes), Buffer.from(wPaired.bytes)) !== 0,
      'WASM: wiring agentA changes the emitted module');

    // WebGPU — the negated lanes appear only in the paired shader. `reqAt`
    // resolves the field NAME to a numeric run base, so the assertions key off
    // the layout's own base rather than a string that never appears.
    ok(isAgentGraphWebGPUSupported(plain) && isAgentGraphWebGPUSupported(paired),
      'both shapes pass the WebGPU agent gate');
    const gPlain = compileAgentGraphWebGPUForModel(plain);
    const gPaired = compileAgentGraphWebGPUForModel(paired);
    ok(!gPlain.error && !gPaired.error, 'both shapes compile to WGSL', String(gPlain.error || gPaired.error));
    const at = (r, field) => {
      const b = r.layout.f32Base[field];
      return b === 0 ? 'agentF32\\[\\w+\\]' : `agentF32\\[${b}u \\+ \\w+\\]`;
    };
    ok(new RegExp(`${at(gPaired, 'bondBreakReq')} = f32\\(-select\\(1, \\w+ \\+ 2, \\w+\\)\\);`).test(gPaired.shaderCode),
      'WGSL: a WIRED agentA negates the break lane');
    ok(new RegExp(`${at(gPaired, 'bondFormReq')} = f32\\(-select\\(1, \\w+ \\+ 2, \\w+\\)\\);`).test(gPaired.shaderCode),
      'WGSL: a WIRED agentA negates the form lane too');
    ok(!/= f32\(-select\(/.test(gPlain.shaderCode),
      'WGSL: an UNWIRED agentA emits NO negated lane (the historical self-break arm)');
    ok(new RegExp(`${at(gPlain, 'bondFormReq')} = 1\\.0;`).test(gPlain.shaderCode),
      'WGSL: the unwired arm writes the positive NONE form lane');
    ok(!/atomic/.test(gPaired.shaderCode.split('brqC')[0] ?? ''),
      'WGSL: NO atomics (the two ids are PAYLOAD on the requester\'s own rows)');
  }
}

// ===========================================================================
// TIER Q — D4: STRUCTURAL REQUESTS FROM THE DIVISION EVENT + THE SECOND DRAIN
//           (and D3's `siblingId`, which is what makes them addressable).
//
// The one thing the agent tier genuinely could not express: **a daughter bonding
// a THIRD PARTY in the generation it was born**. P5's partition only
// redistributes the mother's existing bonds and `daughterBond` only adds the A–B
// edge, so the workaround was to flag the daughter and let its own behaviour step
// bond one generation later — precisely the transient-intermediate-state problem
// GRA rules exist to avoid.
//
// D4 gives the `division` ABI the request-QUEUE block and runs a SECOND
// `drainAgentBondRequests` right after every division event. This tier proves the
// three claims that makes:
//
//   §1  THE HEADLINE — a division event's Form Bond APPLIES this generation, with
//       I1–I4 green immediately after, and the daughters really are the ones
//       bonded (not the mother slot by accident).
//   §2  D3 — each daughter is handed the OTHER's id, verified BY VALUE and by
//       using it as a bond target.
//   §3  I5 — a rejected op (bond capacity) leaves the graph EXACTLY as the
//       division left it, and does not truncate the queue behind it.
//   §4  THE NEGATIVE CONTROL — the second drain does NOT re-apply a first-pass
//       op. The drain zeroes each entry's two lanes BEFORE decoding, so a second
//       pass sees nothing; the control reconstructs the failure by hand (re-arm
//       the entry) and shows it destroys the edge, so the check is discriminating
//       rather than vacuous.
//
// The tier replicates the worker's structural-phase ORDER with the SHIPPED engine
// primitives (drain → division → division events → drain) rather than a copy of
// the logic — the same discipline every other queue tier uses.
// ===========================================================================

/** Build an agents-only model whose Division Event issues structural requests.
 *  `target`: 'const' → Form Bond to a fixed third-party id · 'sibling' → Form
 *  Bond to the OTHER daughter (D3 as an addressable id) · 'attr' → write the
 *  sibling's id into an agent attribute (the value assertion). */
function buildDivisionRequestModel(target, thirdParty = 5) {
  const n = [], e = [];
  const an = (t, c) => { const x = { id: `n${n.length}`, type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c || {} } }; n.push(x); return x; };
  const ed = (s, sp, tt, tp, cat) => e.push({ id: `e${e.length}`, source: s.id, target: tt.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
  an('behaviourStep');
  const dv = an('divisionEvent');
  if (target === 'attr') {
    // Set Attribute on SELF (no agentId wired), value = the sibling's id.
    const sa = an('setAttribute', { attributeId: 'sib' });
    ed(dv, 'do', sa, 'do', 'flow');
    ed(dv, 'siblingId', sa, 'value', 'value');
  } else {
    const fb = an('formBond', {});
    ed(dv, 'do', fb, 'do', 'flow');
    if (target === 'sibling') ed(dv, 'siblingId', fb, 'targetAgent', 'value');
    else { const k = an('getConstant', { constType: 'integer', constValue: String(thirdParty) }); ed(k, 'value', fb, 'targetAgent', 'value'); }
  }
  return migrateForHarness({
    schemaVersion: 1,
    properties: { name: 'divreq', dimension: '2d', gridWidth: 16, gridHeight: 16, gridDepth: 1, topology: '2d-grid', boundaryTreatment: 'torus', useWasm: false, useWebGPU: false },
    topologyMode: { gridCells: false, agents: true },
    centerBased: { ...queueCfg(64, 4, 8), worldWidth: 64, worldHeight: 64, agentTarget: 'js', agentUpdateMode: 'async',
      agentCapabilities: AGENT_CAPS({ bonds: 'physics', division: true }) },
    attributes: [], modelAttributes: [], neighborhoods: [],
    agentAttributes: [{ id: 'sib', name: 'Sib', type: 'float', defaultValue: '-1', description: '' }],
    bondAttributes: [], variables: [], agentVariables: [], indicators: [], mappings: [],
    graphNodes: [], graphEdges: [], agentGraphNodes: n, agentGraphEdges: e, macroDefs: [],
  });
}

/** Compile one of those models and return a runner that replays the worker's
 *  structural phase over a REAL store, in the shipped order. */
function divisionRequestRunner(model) {
  const r = compileAgentGraph(model.agentGraphNodes, model.agentGraphEdges, model, 0);
  if (r.error || !r.divisionCode) return { error: r.error || 'no divisionCode', compiled: r };
  // eslint-disable-next-line no-eval
  const fn = eval(r.divisionCode);
  const shape = {
    is3d: false, agentAttrs: agentAttrsOf(model).map(a => ({ id: a.id })),
    fieldAttrs: cellFieldAttrsOf(model), hasLookupTables: false, bondAttrs: [],
    usesGeneration: true, gates: resolveAgentFieldGates(model),
    // The worker reads these off the SHIPPED flags; the harness reproduces that.
    usesDivisionSibling: m.agentUsesDivisionSibling(model),
    usesDivisionRequests: m.agentUsesDivisionRequests(model),
  };
  const rt = {
    hash: null, emptyI32: new Int32Array(0), modelAttrs: {}, viewer: '',
    indicators: new Float64Array(0), rngState: new Uint32Array(1), stopFlag: new Uint32Array(1),
    glyphCodes: new Uint32Array(1), glyphColors: new Uint32Array(1), lookupTables: {},
    width: 64, height: 64, total: 64 * 64, torus: true, fieldArray: () => undefined, generation: 0,
  };
  /** The SHIPPED structural-phase order for ONE division of agent `mother`.
   *  Returns { a, b } or null when the division itself was rejected. */
  const structuralPhase = (st, mother, lambda = 1) => {
    drainAgentBondRequests(st, lambda);                                     // pass 1
    const out = [0, 0, 0];
    const b = divideAgent(st, mother, 0, 0, 0, 0.5, lambda, true, 64, 64, 1, out, DEFAULT_DIVIDE_PARTITION);
    if (b < 0) return null;
    // Both daughters' queues must be EMPTY here — the safety claim the second
    // drain rests on. Asserted by the caller via `queueEmpty`.
    fn(...buildAgentAbiArgs('division', shape, st, { ...rt, idx: mother, daughterIndex: 0, axisX: out[0], axisY: out[1], siblingId: b }));
    fn(...buildAgentAbiArgs('division', shape, st, { ...rt, idx: b, daughterIndex: 1, axisX: out[0], axisY: out[1], siblingId: mother }));
    const overflow = drainAgentBondRequests(st, lambda);                    // pass 2 (D4)
    return { a: mother, b, overflow };
  };
  return { fn, shape, rt, structuralPhase, compiled: r };
}

/** A queue store carrying the division fixtures' agent attribute, so the `r_`/`w_`
 *  ABI slots resolve to real arrays (`queueStore` builds an attribute-less one). */
function divStore(n, maxBonds, depth) {
  const s = createAgentStore(queueCfg(n + 8, maxBonds, depth), [{ id: 'sib', type: 'float', defaultValue: -1 }]);
  s.worldWidth = 64; s.worldHeight = 64; s.worldDepth = 1;
  seedAgents(s, Array.from({ length: n }, (_, i) => ({ x: (i % 8) + 0.5, y: Math.floor(i / 8) + 0.5, radius: 0.5 })), 0.5);
  return s;
}

/** Is agent `i`'s whole request queue empty (every entry, incl. the overflow bucket)? */
const queueEmpty = (st, i) => {
  const s = st.bondReqSlots;
  for (let c = 0; c < s; c++) if (st.bondFormReq[i * s + c] !== 0 || st.bondBreakReq[i * s + c] !== 0) return false;
  return true;
};

async function tierQ() {
  section('TIER Q — D4: division-event structural requests + the SECOND drain');

  // --- 0. the compile shape (the gate, and that the emit really uses the queue)
  {
    const model = buildDivisionRequestModel('const');
    ok(m.agentUsesDivisionRequests(model) === true,
      'a Form Bond in the Division Event turns the D4 gate ON');
    const r = compileAgentGraph(model.agentGraphNodes, model.agentGraphEdges, model, 0);
    ok(!r.error, 'the model compiles', String(r.error));
    ok(/let _brqC = 0;/.test(r.divisionCode) && /_bondFormReq\[_bq\]/.test(r.divisionCode),
      'the division fn declares the queue cursor and writes the queue');
    // …and the BEHAVIOUR fn is untouched by this (no queue verb there).
    ok(!/_bondFormReq\[_bq\]/.test(r.behaviourCode),
      'the behaviour fn does NOT gain a queue write (the verb is division-scoped)');
    // THE SAFETY PROPERTY the second drain rests on, pinned in the SHIPPED
    // engine source: the drain zeroes an entry's two lanes BEFORE decoding it,
    // so a second pass can never re-apply a first-pass op.
    const eng = readFileSync(join(ROOT, 'src', 'simulator', 'engine', 'agentEngine.ts'), 'utf8');
    const drainSrc = eng.slice(eng.indexOf('export function drainAgentBondRequests'));
    const zeroAt = drainSrc.indexOf('s.bondBreakReq[base + c] = 0; s.bondFormReq[base + c] = 0;');
    const decodeAt = drainSrc.indexOf('if (bl < 0 && fl < 0)');
    ok(zeroAt > 0 && decodeAt > zeroAt,
      'the drain ZEROES each entry BEFORE decoding it (what makes a second pass safe)');
  }

  // --- 1. THE HEADLINE — a daughter bonds a THIRD PARTY this generation -----
  {
    const model = buildDivisionRequestModel('const', 5);
    const R = divisionRequestRunner(model);
    ok(!R.error, 'the division-request model compiles to a runnable fn', String(R.error));
    const st = divStore(8, 4, 8);
    const before = [...edgeSet(decodeAgentGraph(st))].sort().join(',');
    ok(before === '', '(precondition) the population starts unbonded');
    // Instrument the moment BETWEEN the division and the events: both daughters'
    // queues must be empty, which is why one drain after the events suffices.
    const out = [0, 0, 0];
    const probeSt = divStore(8, 4, 8);
    const pb = divideAgent(probeSt, 0, 0, 0, 0, 0.5, 1, true, 64, 64, 1, out, DEFAULT_DIVIDE_PARTITION);
    ok(pb > 0 && queueEmpty(probeSt, 0) && queueEmpty(probeSt, pb),
      'both daughters\' queues are EMPTY when their event runs (A\'s was drained in pass 1, B\'s cleared by initAgentSlot)');

    const res = R.structuralPhase(st, 0);
    ok(res !== null, 'the division itself succeeded');
    const edges = [...edgeSet(decodeAgentGraph(st))].sort().join(',');
    ok(hasBond(st, res.a, 5) && hasBond(st, res.b, 5),
      'BOTH daughters are bonded to the third party, in the SAME generation', edges);
    ok(st.bondCount[5] === 2, 'the third party gained exactly two bonds', String(st.bondCount[5]));
    ok(!res.overflow, 'no queue overflow');
    ok(allInvariants(st) === null, 'I1–I4 hold immediately after the second drain', String(allInvariants(st)));
    // The requests were CONSUMED — nothing is left to re-apply next generation.
    ok(queueEmpty(st, res.a) && queueEmpty(st, res.b),
      'both daughters\' queues are empty again after the second drain');
    // NEGATIVE CONTROL: WITHOUT the second drain the bond does not exist, so the
    // check above is really testing the drain and not the division.
    const st2 = divStore(8, 4, 8);
    drainAgentBondRequests(st2, 1);
    const o2 = [0, 0, 0];
    const b2 = divideAgent(st2, 0, 0, 0, 0, 0.5, 1, true, 64, 64, 1, o2, DEFAULT_DIVIDE_PARTITION);
    R.fn(...buildAgentAbiArgs('division', R.shape, st2, { ...R.rt, idx: 0, daughterIndex: 0, axisX: o2[0], axisY: o2[1], siblingId: b2 }));
    R.fn(...buildAgentAbiArgs('division', R.shape, st2, { ...R.rt, idx: b2, daughterIndex: 1, axisX: o2[0], axisY: o2[1], siblingId: 0 }));
    ok(!hasBond(st2, 0, 5) && !hasBond(st2, b2, 5),
      'negative control: with NO second drain the request is queued but never applied');
    ok(!queueEmpty(st2, 0), '…and the entries are still sitting in the queue');
  }

  // --- 2. D3 — each daughter is handed the OTHER's id -----------------------
  {
    // (a) BY VALUE: the event writes the sibling id into an agent attribute.
    const model = buildDivisionRequestModel('attr');
    ok(m.agentUsesDivisionSibling(model) === true, 'wiring `siblingId` turns the D3 gate ON');
    ok(m.agentUsesDivisionRequests(model) === false,
      'a Division Event with NO bond verb leaves the D4 gate OFF (the two are independent)');
    const R = divisionRequestRunner(model);
    ok(!R.error, 'the sibling-attribute model compiles', String(R.error));
    const st = divStore(8, 4, 8);
    const res = R.structuralPhase(st, 0);
    const sib = st.attrRead['sib'];
    ok(sib[res.a] === res.b && sib[res.b] === res.a,
      'each daughter read the OTHER daughter\'s id', `A=${sib[res.a]} (want ${res.b}) · B=${sib[res.b]} (want ${res.a})`);
    ok(res.a !== res.b && res.b > 0, 'the two daughters are distinct slots', `${res.a}/${res.b}`);
    // Untouched agents keep the attribute default — a broadcast write would show.
    ok(sib[1] === -1 && sib[7] === -1, 'no uninvolved agent was written');

    // (b) AS AN ADDRESS: Form Bond to `siblingId` bonds the two daughters.
    const model2 = buildDivisionRequestModel('sibling');
    const R2 = divisionRequestRunner(model2);
    ok(!R2.error, 'the sibling-bond model compiles', String(R2.error));
    const st2 = divStore(8, 4, 8);
    const res2 = R2.structuralPhase(st2, 0);
    ok(hasBond(st2, res2.a, res2.b), 'the two daughters bonded EACH OTHER through `siblingId`');
    ok(edgeSet(decodeAgentGraph(st2)).size === 1, 'exactly one edge was created (both events named the same pair)');
    ok(allInvariants(st2) === null, 'I1–I4 hold', String(allInvariants(st2)));
  }

  // --- 3. I5 — a REJECTED request leaves the graph exactly as the division left it
  {
    const model = buildDivisionRequestModel('const', 5);
    const R = divisionRequestRunner(model);
    const st = divStore(8, 2, 8);                 // maxBonds = 2
    // Fill agent 5's bond list so every Form Bond naming it must be REJECTED
    // whole-op (invariant I5: neither side is touched).
    formBond(st, 5, 6, 1, 1); formBond(st, 5, 7, 1, 1);
    ok(st.bondCount[5] === 2, '(precondition) the third party is at capacity');
    const before = [...edgeSet(decodeAgentGraph(st))].sort().join('|');
    const beforeSlots = Array.from({ length: st.highWater }, (_, i) => partnersOf(st, i).join(','));
    const res = R.structuralPhase(st, 0);
    ok(res !== null, 'the division still succeeded (the REQUEST is what fails, not the split)');
    const after = [...edgeSet(decodeAgentGraph(st))].sort().join('|');
    ok(after === before, 'I5: the rejected Form Bond changed NOTHING', `${before} -> ${after}`);
    ok(st.bondCount[5] === 2, 'I5: the full third party kept exactly its two bonds');
    ok(st.bondCount[res.a] === 0 && st.bondCount[res.b] === 0, 'I5: neither daughter gained a bond');
    // Compare over the PRE-division index range: the division appends a slot, so
    // `st.highWater` grew and a raw list-vs-list compare would differ in length.
    const moved = beforeSlots.filter((v, i) => v !== partnersOf(st, i).join(',')).length;
    ok(moved === 0, 'I5: not one pre-existing slot moved', `${moved} rows differ`);
    ok(allInvariants(st) === null, 'I5: I1–I4 hold after the rejection', String(allInvariants(st)));
    ok(queueEmpty(st, res.a) && queueEmpty(st, res.b),
      'I5: the rejected entries were still CONSUMED (no queue truncation)');
    // …and a probe queued BEHIND the rejected op still applies, so a rejection
    // can never be mistaken for a truncation.
    const st2 = divStore(8, 2, 8);
    formBond(st2, 5, 6, 1, 1); formBond(st2, 5, 7, 1, 1);
    const o = [0, 0, 0];
    drainAgentBondRequests(st2, 1);
    const b2 = divideAgent(st2, 0, 0, 0, 0, 0.5, 1, true, 64, 64, 1, o, DEFAULT_DIVIDE_PARTITION);
    R.fn(...buildAgentAbiArgs('division', R.shape, st2, { ...R.rt, idx: 0, daughterIndex: 0, axisX: o[0], axisY: o[1], siblingId: b2 }));
    queueOp(st2, 0, 1, { to: 1 });                  // the probe, BEHIND the rejected entry
    drainAgentBondRequests(st2, 1);
    ok(hasBond(st2, 0, 1), 'a probe queued behind the rejected op still applies');
  }

  // --- 4. THE NEGATIVE CONTROL: the second drain re-applies NOTHING ---------
  //
  // The discriminator has to be an op whose SECOND application is observable. A
  // Form is idempotent and a Break of a missing edge is a no-op, so the fixture
  // is: queue a BREAK, drain (pass 1) — the edge is cut and the entry zeroed —
  // then RE-FORM the same edge (standing in for "a division event created it")
  // and drain again. A drain that did not zero would cut it a second time.
  {
    const st = divStore(8, 4, 8);
    formBond(st, 0, 1, 1, 1);
    queueOp(st, 0, 0, { from: 1 });                 // Break(self=0, 1)
    drainAgentBondRequests(st, 1);                  // pass 1
    ok(!hasBond(st, 0, 1), '(precondition) pass 1 cut the edge');
    formBond(st, 0, 1, 1, 1);                       // the "division event" re-creates it
    drainAgentBondRequests(st, 1);                  // pass 2 — must be a no-op
    ok(hasBond(st, 0, 1),
      'the SECOND drain re-applied nothing — the edge survives (the entry was zeroed at decode time)');

    // The control, constructed by hand: re-ARM the entry after pass 1 and the
    // second pass DOES destroy the edge. Without this the check above would pass
    // even if the drain never ran at all.
    const st2 = divStore(8, 4, 8);
    formBond(st2, 0, 1, 1, 1);
    queueOp(st2, 0, 0, { from: 1 });
    drainAgentBondRequests(st2, 1);
    formBond(st2, 0, 1, 1, 1);
    queueOp(st2, 0, 0, { from: 1 });                // ← the entry a non-zeroing drain would leave
    drainAgentBondRequests(st2, 1);
    ok(!hasBond(st2, 0, 1),
      'negative control: an entry still armed at the second pass DOES re-apply (so the check above discriminates)');

    // The same claim end-to-end through a real division: running the second drain
    // TWICE must be indistinguishable from running it once.
    const model = buildDivisionRequestModel('const', 5);
    const R = divisionRequestRunner(model);
    const s1 = divStore(8, 4, 8), s2 = divStore(8, 4, 8);
    const r1 = R.structuralPhase(s1, 0);
    const r2 = R.structuralPhase(s2, 0);
    drainAgentBondRequests(s2, 1);                  // a THIRD pass
    drainAgentBondRequests(s2, 1);                  // …and a fourth
    ok([...edgeSet(decodeAgentGraph(s1))].sort().join(',') === [...edgeSet(decodeAgentGraph(s2))].sort().join(','),
      'extra drains after the division events are idempotent (the entries are already consumed)',
      `${[...edgeSet(decodeAgentGraph(s1))].sort().join(',')} vs ${[...edgeSet(decodeAgentGraph(s2))].sort().join(',')}`);
    ok(r1 !== null && r2 !== null && allInvariants(s2) === null, 'I1–I4 hold after the extra drains');
  }

  // --- 5. MULTIPLE divisions in one generation ------------------------------
  //
  // The events run in a loop and every daughter appends to its OWN queue, so the
  // second drain must apply all of them — the shape a real tissue produces.
  {
    const model = buildDivisionRequestModel('sibling');
    const R = divisionRequestRunner(model);
    const st = divStore(6, 4, 8);
    const lambda = 1, out = [0, 0, 0];
    drainAgentBondRequests(st, lambda);
    const evs = [];
    for (const mother of [0, 1, 2]) {
      const b = divideAgent(st, mother, 0, 0, 0, 0.5, lambda, true, 64, 64, 1, out, DEFAULT_DIVIDE_PARTITION);
      ok(b > 0, `division of agent ${mother} succeeded`);
      evs.push({ a: mother, b, ax: out[0], ay: out[1] });
    }
    for (const ev of evs) {
      R.fn(...buildAgentAbiArgs('division', R.shape, st, { ...R.rt, idx: ev.a, daughterIndex: 0, axisX: ev.ax, axisY: ev.ay, siblingId: ev.b }));
      R.fn(...buildAgentAbiArgs('division', R.shape, st, { ...R.rt, idx: ev.b, daughterIndex: 1, axisX: ev.ax, axisY: ev.ay, siblingId: ev.a }));
    }
    drainAgentBondRequests(st, lambda);
    const edges = [...edgeSet(decodeAgentGraph(st))].sort().join(',');
    ok(evs.every(ev => hasBond(st, ev.a, ev.b)), 'all three daughter pairs bonded', edges);
    ok(edgeSet(decodeAgentGraph(st)).size === 3, 'exactly three edges (one per division)', edges);
    ok(allInvariants(st) === null, 'I1–I4 hold after three divisions + one drain', String(allInvariants(st)));
  }

  // --- 6. THE BEHAVIOUR TARGET VARIES; THE DIVISION ROOT DOES NOT ----------
  //
  // The division root is JS-on-CPU on every agent target (it is in
  // `AGENT_WASM_CPU_ROOT_TYPES`, and the WebGPU agent compiler compiles the
  // BEHAVIOUR root only), so a model whose behaviour runs on WASM or the GPU
  // still has its division events — and D4's second drain — executed by the same
  // CPU code. That combination is exactly what must not regress, so it is pinned
  // here end-to-end: the WASM arm instantiates a REAL module over the wasmBacked
  // store, runs it, and must produce the IDENTICAL bond graph to the JS arm.
  {
    // A model whose BEHAVIOUR divides (agent 0 is gated out and stays the stable
    // third party) and whose DIVISION EVENT bonds each daughter to it + records
    // the sibling id. Compiles on all three agent targets.
    const n = [], e = [];
    const an = (t, c) => { const x = { id: `q${n.length}`, type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c || {} } }; n.push(x); return x; };
    const ed = (s, sp, tt, tp, cat) => e.push({ id: `q${e.length}`, source: s.id, target: tt.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
    const bs = an('behaviourStep');
    const gsh = an('getSelfHandle');
    const gHas = an('getCellAttribute', { attributeId: 'sib' });          // -1 until divided
    const cmpHas = an('statement', { compareType: 'numerical', operation: '<', _port_y: '0' });
    const cmpId = an('statement', { compareType: 'numerical', operation: '>=', _port_y: '1' });
    const andN = an('logicOperator', { operation: 'AND' });
    const cond = an('conditional');
    const div = an('divideAgent', {});
    ed(gHas, 'value', cmpHas, 'x', 'value'); ed(gsh, 'value', cmpId, 'x', 'value');
    ed(cmpHas, 'result', andN, 'a', 'value'); ed(cmpId, 'result', andN, 'b', 'value');
    ed(andN, 'result', cond, 'condition', 'value');
    ed(bs, 'do', cond, 'check', 'flow'); ed(cond, 'then', div, 'do', 'flow');
    const dv = an('divisionEvent');
    const fb = an('formBond', {});
    const k0 = an('getConstant', { constType: 'integer', constValue: '0' });
    const sSib = an('setAttribute', { attributeId: 'sib' });
    ed(dv, 'do', fb, 'do', 'flow'); ed(k0, 'value', fb, 'targetAgent', 'value');
    ed(fb, 'next', sSib, 'do', 'flow'); ed(dv, 'siblingId', sSib, 'value', 'value');
    const model = migrateForHarness({
      schemaVersion: 1,
      properties: { name: 'q6', dimension: '2d', gridWidth: 64, gridHeight: 64, gridDepth: 1, topology: '2d-grid', boundaryTreatment: 'torus', useWasm: false, useWebGPU: false },
      topologyMode: { gridCells: false, agents: true },
      centerBased: {
        enabled: true, maxAgents: 64, maxBonds: 8, bondRequestDepth: 8, worldWidth: 64, worldHeight: 64,
        defaultRadius: 1, timeStep: 0.1, bondStiffness: 0.2, bondRestLength: 4,
        useBondingPhysics: false, autoBond: false, agentUpdateMode: 'async', agentTarget: 'js',
        agentCapabilities: AGENT_CAPS({ bonds: 'physics', division: true }),
      },
      attributes: [], modelAttributes: [], neighborhoods: [],
      agentAttributes: [{ id: 'sib', name: 'Sib', type: 'integer', defaultValue: '-1', description: '' }],
      bondAttributes: [], variables: [], agentVariables: [], indicators: [], mappings: [],
      graphNodes: [], graphEdges: [], agentGraphNodes: n, agentGraphEdges: e, macroDefs: [],
    });

    const r = compileAgentGraph(model.agentGraphNodes, model.agentGraphEdges, model, 0);
    ok(!r.error, 'the cross-target fixture compiles on JS', String(r.error));
    // eslint-disable-next-line no-eval
    const behaviourJS = eval(r.behaviourCode);
    // eslint-disable-next-line no-eval
    const fnDiv = eval(r.divisionCode);
    const specs = [{ id: 'sib', type: 'integer', defaultValue: -1 }];
    const shape = {
      is3d: false, agentAttrs: specs, fieldAttrs: [], hasLookupTables: false, bondAttrs: [],
      usesGeneration: true, gates: resolveAgentFieldGates(model),
      usesDivisionSibling: m.agentUsesDivisionSibling(model),
      usesDivisionRequests: m.agentUsesDivisionRequests(model),
    };
    const rng = new Uint32Array(1);
    const rt = {
      hash: null, emptyI32: new Int32Array(0), modelAttrs: {}, viewer: '',
      indicators: new Float64Array(0), rngState: rng, stopFlag: new Uint32Array(1),
      glyphCodes: new Uint32Array(1), glyphColors: new Uint32Array(1), lookupTables: {},
      width: 64, height: 64, total: 64 * 64, torus: true, fieldArray: () => undefined, generation: 0,
    };
    const mkStore = (wasmBacked, layoutExtras) => {
      const s = createAgentStore(model.centerBased, specs, {
        wasmBacked, syncAttrs: false, layoutExtras, bondReqSlots: bondReqSlotsForModel(model),
        fieldGates: resolveAgentFieldGates(model),
        maxHashBins: computeAgentMaxHashBins(64, 64, 1, 1.5, 1, 5),
      });
      s.worldWidth = 64; s.worldHeight = 64; s.worldDepth = 1;
      seedAgents(s, Array.from({ length: 4 }, (_, i) => ({ x: 8 + i * 6, y: 20, radius: 1 })), 1);
      return s;
    };
    /** The worker's structural phase, replayed with the SHIPPED primitives. */
    const phase = (s) => {
      drainAgentBondRequests(s, 0.2);
      const evs = [], out = [0, 0, 0], hw = s.highWater;
      for (let i = 0; i < hw; i++) {
        if (!s.alive[i] || !s.divideRequest[i]) continue;
        s.divideRequest[i] = 0;
        const b = divideAgent(s, i, s.divideAxisX[i], s.divideAxisY[i], 0, s.divideAsym[i] || 0.5, 0.2, true, 64, 64, 1, out, DEFAULT_DIVIDE_PARTITION);
        if (b >= 0) evs.push({ a: i, b, ax: out[0], ay: out[1] });
      }
      for (const ev of evs) {
        fnDiv(...buildAgentAbiArgs('division', shape, s, { ...rt, idx: ev.a, daughterIndex: 0, axisX: ev.ax, axisY: ev.ay, siblingId: ev.b }));
        fnDiv(...buildAgentAbiArgs('division', shape, s, { ...rt, idx: ev.b, daughterIndex: 1, axisX: ev.ax, axisY: ev.ay, siblingId: ev.a }));
      }
      if (evs.length > 0) drainAgentBondRequests(s, 0.2);
      return evs;
    };
    const outcome = (s, evs) => {
      const sib = s.attrRead['sib'];
      return [
        evs.length,
        s.bondCount[0],
        evs.every(ev => hasBond(s, ev.a, 0) && hasBond(s, ev.b, 0)),
        evs.every(ev => sib[ev.a] === ev.b && sib[ev.b] === ev.a),
        [...edgeSet(decodeAgentGraph(s))].sort().join(','),
      ].join('|');
    };

    // --- JS behaviour ---
    const sJs = mkStore(false);
    rng[0] = 0x1234abcd;
    behaviourJS(...buildAgentAbiArgs('loop', shape, sJs, { ...rt, hash: null }));
    const evJs = phase(sJs);
    ok(evJs.length === 3, '[js] three agents divided (agent 0 is the gated-out third party)', String(evJs.length));
    ok(sJs.bondCount[0] === 6, '[js] all six daughters bonded the third party this generation', String(sJs.bondCount[0]));
    ok(allInvariants(sJs) === null, '[js] I1–I4 hold', String(allInvariants(sJs)));
    const jsOut = outcome(sJs, evJs);

    // --- WASM behaviour + the SAME JS division fn + the SAME drains ---
    const wr = compileAgentGraphWasmForModel(model);
    ok(isAgentGraphWasmSupported(model) && !wr.error, '[wasm] the behaviour graph compiles to a module', String(wr.error));
    const sW = mkStore(true, { ...buildAgentLayoutExtras(model), fieldTotal: 0, syncAttrs: false });
    const inst = await instantiateAgentWasm(wr.bytes, sW.memory);
    ok(!!inst && typeof inst.behaviour === 'function', '[wasm] the module instantiates over the wasmBacked store');
    new Uint32Array(sW.memory.buffer, sW.layout.rngStateOffset, 1)[0] = 0x1234abcd;
    inst.behaviour(sW.highWater, 0, 0, 0, 0, 1, 1, 1, 64, 64, 1, 1, 0, 0, 0);
    const evW = phase(sW);
    ok(allInvariants(sW) === null, '[wasm] I1–I4 hold', String(allInvariants(sW)));
    ok(outcome(sW, evW) === jsOut,
      '[wasm] the division events produce the IDENTICAL bond graph + sibling ids as JS', `${outcome(sW, evW)} vs ${jsOut}`);

    // --- WebGPU: the shader compiles and carries NO division-root code -------
    const gr = compileAgentGraphWebGPUForModel(model);
    ok(isAgentGraphWebGPUSupported(model) && !gr.error && !!gr.shaderCode,
      '[webgpu] the behaviour graph passes the gate and compiles', String(gr.error));
    ok(!/__siblingId|_bondFormReq/.test(gr.shaderCode),
      '[webgpu] the shader carries NO division-root code — the division event stays JS-on-CPU on every target');
  }

}


tierA();
tierB();
await tierC();
tierD();
tierE();
tierF();
tierG();
tierH();
tierJ();
tierI();
await tierIMutants();
tierL();
tierN();
tierO();
tierP();
await tierQ();
tierM();

console.log(`\n${fail === 0 ? 'GRAPH-REWRITE HARNESS ✓' : 'GRAPH-REWRITE HARNESS ✗'}  (${pass} passed, ${fail} failed)`);
rmSync(entryPath, { force: true });
rmSync(dir, { recursive: true, force: true });
if (fail > 0) process.exit(1);

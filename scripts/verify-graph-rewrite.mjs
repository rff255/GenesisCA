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
} from '../src/simulator/engine/agentEngine.ts';
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
  const stores = [];
  const A = createAgentStore(cfg, specs, { wasmBacked: false, syncAttrs });
  stores.push(A);
  let B = null, inst = null;
  if (withWasm && wasmR && !wasmR.error && wasmR.bytes.length) {
    const layoutExtras = { ...buildAgentLayoutExtras(model), fieldTotal: 0, syncAttrs };
    B = createAgentStore(cfg, specs, { wasmBacked: true, syncAttrs, maxHashBins: wasmR.layout.maxHashBins, layoutExtras });
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

  // --- THE WEBGPU CAPABILITY GATE: a model declaring bond attributes must be
  //     REJECTED by the WebGPU agent gate (so it clamps to WASM/JS with a stated
  //     reason) while the WASM gate ACCEPTS it. P3 lifts this.
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
    ok(isAgentGraphWebGPUSupported(withBond) === false, 'WebGPU gate REJECTS a bond-attribute model (clamps to WASM/JS — P3 lifts it)');
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

tierA();
tierB();
await tierC();
tierD();
tierE();

console.log(`\n${fail === 0 ? 'GRAPH-REWRITE HARNESS ✓' : 'GRAPH-REWRITE HARNESS ✗'}  (${pass} passed, ${fail} failed)`);
rmSync(entryPath, { force: true });
rmSync(dir, { recursive: true, force: true });
if (fail > 0) process.exit(1);

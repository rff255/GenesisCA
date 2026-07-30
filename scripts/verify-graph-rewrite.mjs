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
} from '../src/simulator/engine/agentEngine.ts';
export {
  compileAgentGraphWasmForModel, instantiateAgentWasm, buildAgentLayoutExtras, isAgentGraphWasmSupported,
} from '../src/modeler/vpl/compiler/agentWasm/compile.ts';
export {
  compileAgentGraphWebGPUForModel, isAgentGraphWebGPUSupported,
} from '../src/modeler/vpl/compiler/agentWebgpu/compile.ts';
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
  compileAgentGraphWasmForModel, instantiateAgentWasm, buildAgentLayoutExtras, isAgentGraphWasmSupported,
  compileAgentGraphWebGPUForModel, isAgentGraphWebGPUSupported,
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
  const hw = p.highWater, mb = p.maxBonds;
  return {
    highWater: hw, maxBonds: mb,
    alive: asU8(p.alive, hw),
    bondCount: asI32(p.bondCount, hw),
    bondPartner: asI32(p.bondPartner, hw * mb),
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

tierA();
tierB();
await tierC();

console.log(`\n${fail === 0 ? 'GRAPH-REWRITE HARNESS ✓' : 'GRAPH-REWRITE HARNESS ✗'}  (${pass} passed, ${fail} failed)`);
rmSync(entryPath, { force: true });
rmSync(dir, { recursive: true, force: true });
if (fail > 0) process.exit(1);

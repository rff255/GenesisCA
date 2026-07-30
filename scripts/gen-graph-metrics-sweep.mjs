#!/usr/bin/env node
/**
 * Generates public/models/Graph Metrics - Growth Sweep.gcaproj — the GRA P6
 * sample: GRAPH INDICATORS + the Overseer rule-space sweep, i.e. the MEASUREMENT
 * half of the graph-rewriting research loop.
 *
 * The model: 16 scattered seed agents on a 120x120 torus. Each step every agent
 * rolls Bernoulli(p) AND consults a 1-axis rule TABLE keyed by its own bond
 * degree; when both say yes it DIVIDES (daughterBond: always), so each division
 * adds exactly one node and exactly one edge. Nothing ever merges two lineages,
 * so the 16 seeds grow 16 independent trees — a structural claim the
 * `componentCount` indicator reads back directly.
 *
 * Six graph indicators are declared, one per metric, so the simulator charts the
 * whole measurement surface live: N, E, mean/max degree, the degree histogram
 * (a frequency-shaped metric, so it rides the existing bars/lines/stack charts)
 * and the component count.
 *
 * The Overseer graph is the research protocol, in two phases:
 *   A  O10 — the growth law. Randomize Table at density 1.0 (every degree may
 *      divide) so p is the ONLY factor, then 20 replicates of
 *      Reset -> Run T -> Collect nodeCount. E[N_T] = N0 (1+p)^T.
 *   B  the rule-space sweep. For each of 16 seeds: Randomize Table at density
 *      0.5 (a DIFFERENT rule each time), Reset, Run T, and collect N / E /
 *      mean degree / components. The journal records every {seed, density}, so
 *      an interesting rule reproduces in the editor.
 *
 * WHY agentTarget = 'wasm' (a deliberate, documented exception to the library's
 * WebGPU-where-gated-in policy): the sweep's whole point is reproducibility, and
 * the Overseer's seed policy drives `setRngSeed`, which re-seeds the shared
 * xorshift32 stream that JS and WASM use. The WebGPU agent target's per-agent
 * PCG is seeded ONCE at runtime creation (`seedAgentRng`) and `setRngSeed` does
 * not reach it, so a WebGPU-agent experiment would not reproduce across two
 * presses of Run Experiment. WASM keeps the sweep exact AND is bit-parity with
 * JS. See the P6 completion report.
 *
 * Re-run after a tweak:  node scripts/gen-graph-metrics-sweep.mjs
 * Re-running preserves any saved simulationState + library thumbnail.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../public/models/Graph Metrics - Growth Sweep.gcaproj');

// --- id generation (CLAUDE.md convention: never counter-based) ---------------
const usedIds = new Set();
function newId(prefix) {
  let id;
  do {
    id = prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  } while (usedIds.has(id));
  usedIds.add(id);
  return id;
}

function makeGraph() {
  const nodes = [];
  const edges = [];
  const node = (nodeType, config, col, row) => {
    const n = { id: newId('n'), type: 'caNode', position: { x: col * 250, y: row * 100 }, data: { nodeType, config } };
    nodes.push(n);
    return n;
  };
  const edge = (s, sp, t, tp, category) => {
    edges.push({
      id: newId('e'), source: s.id, target: t.id,
      sourceHandle: `output_${category}_${sp}`, targetHandle: `input_${category}_${tp}`,
    });
  };
  return { nodes, edges, node, vEdge: (s, sp, t, tp) => edge(s, sp, t, tp, 'value'), fEdge: (s, sp, t, tp) => edge(s, sp, t, tp, 'flow') };
}

const W = 120, H = 120;
const SEEDS = 16;        // N0 — also the number of independent lineages
const MAX_BONDS = 12;    // generous: a division can only raise a degree by 1
const T_REPLICATE = 40;  // the fixed developmental time point for O10
const DIVIDE_P = 0.05;   // per-agent, per-step division probability

// =============================================================================
// AGENT GRAPH — Behaviour Step: Bernoulli(p) AND rule[degree] => Divide Self
// =============================================================================
const ag = makeGraph();

const bs = ag.node('behaviourStep', {}, 0, 2);

// The die roll: p comes from a live model attribute so the user can retune it.
const pRead = ag.node('getModelAttribute', { attributeId: 'divideProb' }, 0, 0);
const roll = ag.node('getRandom', { randomType: 'bool' }, 1, 0);
ag.vEdge(pRead, 'value', roll, 'probability');

// The RULE: a 1-axis lookup table indexed by this agent's own bond degree.
// Randomize re-rolls WHICH degrees are allowed to divide — that is the rule space.
const degree = ag.node('getBondDegree', {}, 0, 4);
const ruleLookup = ag.node('lookupInteraction', { tableId: 'growthRule' }, 1, 4);
ag.vEdge(degree, 'value', ruleLookup, 'axis_0');
const ruleAllows = ag.node('statement', { operation: '>', compareType: 'numerical', _port_y: '0.5' }, 2, 4);
ag.vEdge(ruleLookup, 'value', ruleAllows, 'x');

const gate = ag.node('logicOperator', { operation: 'AND' }, 3, 2);
ag.vEdge(roll, 'value', gate, 'a');
ag.vEdge(ruleAllows, 'result', gate, 'b');

const cond = ag.node('conditional', {}, 4, 2);
ag.fEdge(bs, 'do', cond, 'do');
ag.vEdge(gate, 'result', cond, 'condition');

// daughterBond ALWAYS (D4): every division adds exactly one edge, even for an
// isolated seed — which is what makes E = N − N0 an exact structural law here.
const divide = ag.node('divideAgent', { axisSource: 'tension', partition: 'tension', daughterBond: 'always' }, 5, 2);
ag.fEdge(cond, 'then', divide, 'do');

// =============================================================================
// OVERSEER GRAPH — phase A (O10 replicates) then phase B (the rule sweep)
// =============================================================================
const ov = makeGraph();

const exp = ov.node('experiment', {}, 0, 3);
const clearN = ov.node('ovClearSeries', { series: 'N_T' }, 1, 3);
const clearSweepN = ov.node('ovClearSeries', { series: 'sweep_N' }, 2, 3);
const clearSweepE = ov.node('ovClearSeries', { series: 'sweep_E' }, 3, 3);
const clearSweepD = ov.node('ovClearSeries', { series: 'sweep_meanDegree' }, 4, 3);
const clearSweepC = ov.node('ovClearSeries', { series: 'sweep_components' }, 5, 3);
ov.fEdge(exp, 'do', clearN, 'do');
ov.fEdge(clearN, 'next', clearSweepN, 'do');
ov.fEdge(clearSweepN, 'next', clearSweepE, 'do');
ov.fEdge(clearSweepE, 'next', clearSweepD, 'do');
ov.fEdge(clearSweepD, 'next', clearSweepC, 'do');

// --- PHASE A: the growth law -------------------------------------------------
// density 1.0 => every table entry is 1 => every degree may divide => the ONLY
// factor is Bernoulli(p), so E[N_t] = N0 (1+p)^t exactly.
const openRule = ov.node('ovRandomizeTable', { tableId: 'growthRule', _port_seed: '1', _port_density: '1' }, 0, 5);
ov.fEdge(clearSweepC, 'next', openRule, 'do');
const logA = ov.node('ovLog', { text: 'Phase A - growth law: 20 replicates, every degree may divide.' }, 1, 5);
ov.fEdge(openRule, 'next', logA, 'do');

const repLoop = ov.node('loop', { _port_count: '20' }, 2, 5);
ov.fEdge(logA, 'next', repLoop, 'do');
const resetA = ov.node('ovResetBoard', {}, 3, 6);
const runA = ov.node('ovRunGenerations', { _port_count: String(T_REPLICATE) }, 4, 6);
const readN = ov.node('ovReadIndicator', { indicatorId: 'nodes', category: '' }, 4, 8);
const collectN = ov.node('ovCollectSample', { series: 'N_T', scope: 'experiment' }, 5, 6);
ov.fEdge(repLoop, 'body', resetA, 'do');
ov.fEdge(resetA, 'next', runA, 'do');
ov.fEdge(runA, 'next', collectN, 'do');
ov.vEdge(readN, 'value', collectN, 'value');

const meanN = ov.node('ovSeriesStat', { series: 'N_T', op: 'mean' }, 2, 1);
const logMeanN = ov.node('ovLog', { text: 'O10 mean N at T=' + T_REPLICATE + ': {value}  (expected N0*(1+p)^T)' }, 3, 1);
ov.fEdge(repLoop, 'next', logMeanN, 'do');
ov.vEdge(meanN, 'result', logMeanN, 'value');
const stdN = ov.node('ovSeriesStat', { series: 'N_T', op: 'std' }, 4, 0);
const logStdN = ov.node('ovLog', { text: 'O10 std: {value} (n = 20)' }, 5, 1);
ov.fEdge(logMeanN, 'next', logStdN, 'do');
ov.vEdge(stdN, 'result', logStdN, 'value');

// --- PHASE B: the rule-space sweep ------------------------------------------
const logB = ov.node('ovLog', { text: 'Phase B - rule sweep: 16 seeds x (Randomize -> Reset -> Run -> Measure).' }, 0, 10);
ov.fEdge(logStdN, 'next', logB, 'do');

const seeds = ov.node('ovSweepValues', { mode: 'list', list: '101, 202, 303, 404, 505, 606, 707, 808, 909, 1010, 1111, 1212, 1313, 1414, 1515, 1616' }, 0, 12);
const forEach = ov.node('forEachInArray', {}, 1, 10);
ov.fEdge(logB, 'next', forEach, 'do');
ov.vEdge(seeds, 'values', forEach, 'array');

const roll2 = ov.node('ovRandomizeTable', { tableId: 'growthRule', _port_density: '0.5' }, 2, 11);
ov.fEdge(forEach, 'body', roll2, 'do');
ov.vEdge(forEach, 'element', roll2, 'seed');

const resetB = ov.node('ovResetBoard', {}, 3, 11);
const runB = ov.node('ovRunGenerations', { _port_count: String(T_REPLICATE) }, 4, 11);
ov.fEdge(roll2, 'next', resetB, 'do');
ov.fEdge(resetB, 'next', runB, 'do');

const rN = ov.node('ovReadIndicator', { indicatorId: 'nodes', category: '' }, 4, 13);
const rE = ov.node('ovReadIndicator', { indicatorId: 'edges', category: '' }, 4, 14);
const rD = ov.node('ovReadIndicator', { indicatorId: 'meanDeg', category: '' }, 4, 15);
const rC = ov.node('ovReadIndicator', { indicatorId: 'components', category: '' }, 4, 16);

const cN = ov.node('ovCollectSample', { series: 'sweep_N', scope: 'experiment' }, 5, 11);
const cE = ov.node('ovCollectSample', { series: 'sweep_E', scope: 'experiment' }, 6, 11);
const cD = ov.node('ovCollectSample', { series: 'sweep_meanDegree', scope: 'experiment' }, 7, 11);
const cC = ov.node('ovCollectSample', { series: 'sweep_components', scope: 'experiment' }, 8, 11);
ov.fEdge(runB, 'next', cN, 'do');
ov.fEdge(cN, 'next', cE, 'do');
ov.fEdge(cE, 'next', cD, 'do');
ov.fEdge(cD, 'next', cC, 'do');
ov.vEdge(rN, 'value', cN, 'value');
ov.vEdge(rE, 'value', cE, 'value');
ov.vEdge(rD, 'value', cD, 'value');
ov.vEdge(rC, 'value', cC, 'value');

const logRow = ov.node('ovLog', { text: 'seed -> N = {value}' }, 9, 11);
ov.fEdge(cC, 'next', logRow, 'do');
ov.vEdge(rN, 'value', logRow, 'value');

const doneLog = ov.node('ovLog', { text: 'Sweep complete - export the Series table as CSV from the panel.' }, 2, 9);
ov.fEdge(forEach, 'next', doneLog, 'do');

// =============================================================================
// NON-GRAPH MODEL PARTS
// =============================================================================
const properties = {
  name: 'Graph Metrics - Growth Sweep',
  modelAuthor: 'Rodrigo F. Figueiredo',
  description:
    'The measurement half of the graph-rewriting research loop: six GRAPH INDICATORS ' +
    '(node count, edge count, mean/max degree, degree histogram, connected components) ' +
    'over a growing bond graph, plus an Overseer protocol that measures the growth law ' +
    'over 20 replicates and then sweeps 16 random rules.',
  ruleDescription:
    'THE MODEL. Sixteen scattered seed agents. Every step each agent rolls Bernoulli(p) ' +
    '(p = the live model attribute "Divide Probability") AND looks its own bond degree up ' +
    'in the "Growth Rule" lookup table; when both say yes it divides, with daughterBond = ' +
    'always. A division therefore adds exactly one node and exactly one edge, and nothing ' +
    'ever joins two lineages — so the sixteen seeds grow sixteen independent trees, which ' +
    'the Connected Components indicator reads back as a constant 16, and E = N - 16 exactly.\n\n' +
    'THE INDICATORS. One per metric, so the simulator charts the whole measurement surface ' +
    'live. Node/edge count, mean and max degree and the component count are scalars ' +
    '(sparklines); the Degree Histogram is frequency-shaped, so it renders through the same ' +
    'Bars / Lines / Stack charts a linked-frequency indicator uses. Edge count is computed ' +
    'via the handshake lemma (sum of degrees / 2) — the same identity the invariant harness ' +
    'checks, so the indicator and the invariant validate each other.\n\n' +
    'THE PROTOCOL (Overseer tab). Phase A measures the growth law: Randomize Table at ' +
    'density 1.0 opens every degree, then 20 replicates of Reset -> Run 40 -> Collect the ' +
    'node count, and the Journal logs mean and std. With p = 0.05 and N0 = 16 the ' +
    'expectation is 16 x 1.05^40 = 112.6. Phase B is the rule-space sweep: for each of 16 ' +
    'seeds, Randomize Table at density 0.5 (a DIFFERENT rule each time), Reset, Run 40, and ' +
    'collect N, E, mean degree and components — a rule -> outcome table you can export as ' +
    'CSV from the Experiments panel. The seed policy is sequential from base 90210, so the ' +
    'whole experiment reproduces exactly on every press of Run Experiment.\n\n' +
    'COMPILE TARGET. The agent layer runs on WebAssembly on purpose. The Overseer seed ' +
    'policy drives setRngSeed, which re-seeds the shared xorshift32 stream JS and WASM use; ' +
    'the WebGPU agent target seeds its per-agent PCG once at runtime creation, so a sweep ' +
    'there would not reproduce across runs. WASM keeps the experiment exact and is ' +
    'bit-identical to JS.',
  topology: '2d-grid',
  boundaryTreatment: 'torus',
  updateMode: 'synchronous',
  asyncScheme: 'random-order',
  gridWidth: W,
  gridHeight: H,
  maxIterations: 100000,
  tags: ['agents', 'graph rewriting', 'indicators', 'Overseer', 'statistics'],
  useWasm: true,
  useWebGPU: false,
};

// The rule table: one axis, the agent's own bond degree (0..MAX_BONDS), bool
// valued. Seeded all-ones so the model runs as pure Bernoulli(p) out of the box;
// `Randomize Table` (editor block or the Overseer node) re-rolls it.
const growthRuleTable = {
  id: 'growthRule',
  name: 'Growth Rule',
  type: 'lookupTable',
  description: 'May an agent of this bond degree divide? One row per degree. Randomize it (here or from the Overseer) to sweep the rule space.',
  isModelAttribute: true,
  defaultValue: '0',
  valueType: 'bool',
  axes: [{ name: 'Degree', source: { kind: 'intRange', min: 0, max: MAX_BONDS } }],
  tableData: Array.from({ length: MAX_BONDS + 1 }, () => 1),
  tableRoll: { seed: 1, density: 1 },
};

const attributes = [
  growthRuleTable,
  {
    id: 'divideProb', name: 'Divide Probability', type: 'float',
    description: 'Per-agent, per-step probability of attempting a division.',
    isModelAttribute: true, defaultValue: String(DIVIDE_P),
    hasBounds: true, min: 0, max: 0.3,
  },
];

const agentAttributes = [];

const agentMappings = [
  {
    id: 'degreeView', name: 'Degree', isAttributeToColor: true,
    description: 'Placeholder view — agents keep their default colour (the graph structure is what this model is about).',
    linked: false,
  },
];

// One indicator per metric — the whole measurement surface, charted live.
const indicators = [
  { id: 'nodes', name: 'nodes (N)', kind: 'graph', graphMetric: 'nodeCount',
    dataType: 'integer', defaultValue: '0', accumulationMode: 'per-generation', watched: true },
  { id: 'edges', name: 'edges (E)', kind: 'graph', graphMetric: 'edgeCount',
    dataType: 'integer', defaultValue: '0', accumulationMode: 'per-generation', watched: true },
  { id: 'meanDeg', name: 'mean degree', kind: 'graph', graphMetric: 'meanDegree',
    dataType: 'float', defaultValue: '0', accumulationMode: 'per-generation', watched: true },
  { id: 'maxDeg', name: 'max degree', kind: 'graph', graphMetric: 'maxDegree',
    dataType: 'integer', defaultValue: '0', accumulationMode: 'per-generation', watched: true },
  { id: 'degHist', name: 'degree histogram', kind: 'graph', graphMetric: 'degreeHistogram',
    dataType: 'integer', defaultValue: '0', accumulationMode: 'per-generation', watched: true },
  { id: 'components', name: 'components', kind: 'graph', graphMetric: 'componentCount',
    dataType: 'integer', defaultValue: '0', accumulationMode: 'per-generation', watched: true },
];

const centerBased = {
  enabled: true,
  agentTarget: 'wasm',
  maxAgents: 1500,
  maxBonds: MAX_BONDS,
  worldWidth: W,
  worldHeight: H,
  seedCount: SEEDS,
  // COMPACT, not scatter — a reproducible experiment needs a reproducible
  // INITIAL CONDITION. `seedPattern: 'scatter'` places the seeds with
  // `Math.random()` (sim.worker.ts initAgents, deliberately: seeding is a
  // one-time setup, not part of the replayable step). That is invisible to a
  // rule whose decisions ignore geometry, but this rule reads BOND DEGREE, and
  // degree depends on the division bond-partition, which is computed from the
  // TENSION AXIS — i.e. from positions. Measured: with `scatter` the Phase A
  // replicates (a degree-INDEPENDENT rule at density 1.0) reproduced exactly
  // while the Phase B sweep did not. `compact` is a deterministic lattice.
  seedPattern: 'compact',
  defaultRadius: 1.2,
  growthRate: 0,
  repulsionStiffness: 1.5,
  adhesionStiffness: 0,
  interactionRange: 1.5,
  drag: 1,
  timeStep: 0.1,
  momentum: 0,
  maxSpeed: 0,
  neighbourQueryRadius: 4,
  useBondingPhysics: true,
  autoBond: false,
  bondStiffness: 1.0,
  bondRestLength: 2.6,
  formDistance: 1.15,
  breakDistance: 1.8,
  agentUpdateMode: 'async',
  bondRequestDepth: 8,
  agentCapabilities: {
    motion: 'force', body: true, collision: 'soft', bonds: 'physics', autoBond: false,
    growth: false, division: true, lifespan: false, populationBirth: false,
    populationDeath: false, sensing: false, sensingHeadingSource: 'velocity',
    orientation: false, fieldCoupling: false, appearance: true,
  },
};

const model = {
  schemaVersion: 2,
  properties,
  attributes,
  neighborhoods: [],
  mappings: [],
  indicators,
  graphNodes: [],
  graphEdges: [],
  macroDefs: [],
  topologyMode: { gridCells: false, agents: true },
  centerBased,
  agentAttributes,
  agentVariables: [],
  bondAttributes: [],
  agentMappings,
  agentGraphNodes: ag.nodes,
  agentGraphEdges: ag.edges,
  overseerConfig: { enabled: true, seedPolicy: 'sequential', baseSeed: 90210 },
  overseerGraphNodes: ov.nodes,
  overseerGraphEdges: ov.edges,
};

mkdirSync(dirname(OUT), { recursive: true });

let preserved = null;
if (existsSync(OUT)) {
  try {
    const prev = JSON.parse(readFileSync(OUT, 'utf-8'));
    preserved = {
      simulationState: prev.simulationState,
      thumbnail: prev.properties?.thumbnail,
      presets: prev.presets,
    };
  } catch { /* regenerate from scratch */ }
}
if (preserved?.simulationState) model.simulationState = preserved.simulationState;
if (preserved?.thumbnail) model.properties.thumbnail = preserved.thumbnail;
if (preserved?.presets) model.presets = preserved.presets;

writeFileSync(OUT, JSON.stringify(model, null, 1));
console.log(`wrote ${OUT}`);
console.log(`  agent graph: ${ag.nodes.length} nodes / ${ag.edges.length} edges`);
console.log(`  overseer graph: ${ov.nodes.length} nodes / ${ov.edges.length} edges`);
console.log(`  indicators: ${indicators.length} (one per graph metric)`);
console.log(`  O10 expectation: N0 ${SEEDS} x (1 + ${DIVIDE_P})^${T_REPLICATE} = ${(SEEDS * Math.pow(1 + DIVIDE_P, T_REPLICATE)).toFixed(1)}`);

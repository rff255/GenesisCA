#!/usr/bin/env node
/**
 * Generates public/models/GoL Replicate Statistics.gcaproj — the Overseer
 * tutorial sample (experiment orchestration).
 *
 * Classic Conway Game of Life on a 60x60 torus, randomly seeded (p=0.35) by
 * the Init Event. The OVERSEER graph automates the classic "how many cells
 * survive?" experiment: 20 seeded replicates x (Reset -> Run 200 generations
 * -> Collect the live-cell count), then logs mean / std / n to the Journal.
 * The sequential seed policy (base 4242) makes the whole batch reproducible —
 * run it twice and the statistics match exactly (JS and WASM bit-identical).
 *
 * Built programmatically (mirrors gen-life3d.mjs). Re-run after a tweak:
 *   node scripts/gen-overseer-stats.mjs
 * Re-running preserves any saved simulationState + library thumbnail from the
 * existing output file.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../public/models/GoL Replicate Statistics.gcaproj');

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

// --- graph builders (one node/edge list per graph) ----------------------------
function makeGraph() {
  const nodes = [];
  const edges = [];
  const node = (nodeType, config, col, row) => {
    const n = { id: newId('n'), type: 'caNode', position: { x: col * 240, y: row * 95 }, data: { nodeType, config } };
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

const W = 60, H = 60;

// =============================================================================
// CELLS GRAPH — Conway's Game of Life (survive 2-3, born 3) + random init.
// =============================================================================
const g = makeGraph();

const stepNode = g.node('step', {}, 0, 0);
const aliveRead = g.node('getCellAttribute', { attributeId: 'alive' }, 0, 2);
const nbrGather = g.node('getNeighborsAttribute', { neighborhoodId: 'moore', attributeId: 'alive' }, 0, 4);
const countSum = g.node('aggregate', { operation: 'sum' }, 1, 4);
g.vEdge(nbrGather, 'values', countSum, 'values');

const survRange = g.node('statement', { operation: 'between', lowOp: '>=', highOp: '<=', compareType: 'numerical', _port_y: '2', _port_y2: '3' }, 2, 3);
const bornEq = g.node('statement', { operation: '==', compareType: 'numerical', _port_y: '3' }, 2, 5);
g.vEdge(countSum, 'result', survRange, 'x');
g.vEdge(countSum, 'result', bornEq, 'x');

const survives = g.node('logicOperator', { operation: 'AND' }, 3, 2);
g.vEdge(aliveRead, 'value', survives, 'a');
g.vEdge(survRange, 'result', survives, 'b');

const notAlive = g.node('logicOperator', { operation: 'NOT' }, 3, 5);
g.vEdge(aliveRead, 'value', notAlive, 'a');

const born = g.node('logicOperator', { operation: 'AND' }, 4, 5);
g.vEdge(notAlive, 'result', born, 'a');
g.vEdge(bornEq, 'result', born, 'b');

const nextState = g.node('logicOperator', { operation: 'OR' }, 5, 3);
g.vEdge(survives, 'result', nextState, 'a');
g.vEdge(born, 'result', nextState, 'b');

const writeAlive = g.node('setAttribute', { attributeId: 'alive' }, 6, 3);
g.fEdge(stepNode, 'do', writeAlive, 'do');
g.vEdge(nextState, 'result', writeAlive, 'value');

// Init Event — random soup, p = 0.35 (governed by the run's seed).
const initNode = g.node('initEvent', {}, 0, 8);
const rnd = g.node('getRandom', { randomType: 'bool', _port_probability: '0.35' }, 1, 9);
const writeSeed = g.node('setAttribute', { attributeId: 'alive' }, 2, 8);
g.fEdge(initNode, 'do', writeSeed, 'do');
g.vEdge(rnd, 'value', writeSeed, 'value');

// =============================================================================
// OVERSEER GRAPH — 20 seeded replicates -> mean +/- std of the survivor count.
// =============================================================================
const ov = makeGraph();

const expRoot = ov.node('experiment', {}, 0, 2);
const clear = ov.node('ovClearSeries', { series: 'aliveAt200' }, 1, 2);
const loop = ov.node('loop', { _port_count: '20' }, 2, 2);
const reset = ov.node('ovResetBoard', {}, 3, 3);
const run = ov.node('ovRunGenerations', { _port_count: '200' }, 4, 3);
const read = ov.node('ovReadIndicator', { indicatorId: 'population', category: 'true' }, 4, 5);
const collect = ov.node('ovCollectSample', { series: 'aliveAt200', scope: 'experiment' }, 5, 3);
ov.fEdge(expRoot, 'do', clear, 'do');
ov.fEdge(clear, 'next', loop, 'do');
ov.fEdge(loop, 'body', reset, 'do');
ov.fEdge(reset, 'next', run, 'do');
ov.fEdge(run, 'next', collect, 'do');
ov.vEdge(read, 'value', collect, 'value');

const meanStat = ov.node('ovSeriesStat', { series: 'aliveAt200', op: 'mean' }, 2, 0);
const logMean = ov.node('ovLog', { text: 'survivors @200 gens: mean = {value}' }, 3, 0);
ov.fEdge(loop, 'next', logMean, 'do');
ov.vEdge(meanStat, 'result', logMean, 'value');

const stdStat = ov.node('ovSeriesStat', { series: 'aliveAt200', op: 'std' }, 4, 1);
const logStd = ov.node('ovLog', { text: 'std = {value} (n = 20, seeds 4242..4261)' }, 5, 0);
ov.fEdge(logMean, 'next', logStd, 'do');
ov.vEdge(stdStat, 'result', logStd, 'value');

// =============================================================================
// NON-GRAPH MODEL PARTS
// =============================================================================
const properties = {
  name: 'GoL Replicate Statistics',
  author: 'John Conway (Game of Life)',
  modelAuthor: 'Rodrigo F. Figueiredo',
  description:
    'The Overseer tutorial: Conway’s Game of Life plus an experiment graph that ' +
    'answers "how many cells survive a random soup?" PROPERLY — 20 seeded replicates ' +
    'of Reset → Run 200 generations → Collect the live-cell count, then mean ± std in ' +
    'the Journal. Open the simulator’s Experiments panel and press Run Experiment; the ' +
    'sequential seed policy makes the whole batch exactly reproducible. Switch to the ' +
    'Modeler’s Overseer tab to see the protocol as a graph.',
  ruleDescription:
    'The Cells graph is classic Conway GoL (survive on 2-3 live Moore neighbours, born on ' +
    'exactly 3) with an Init Event seeding a p=0.35 random soup from the current RNG seed.\n\n' +
    'The Overseer graph is the experiment protocol: Clear Series → Loop ×20 { Reset Board ' +
    '→ Run Generations ×200 → Collect Sample ← Read Indicator(population, category true) } ' +
    '→ Log mean → Log std. The per-run seed policy (Model Properties → Overseer) is ' +
    '"sequential" with base 4242, so run k re-seeds with 4242+k at its Reset — replicates ' +
    'differ from each other, but the whole experiment reproduces exactly on every press of ' +
    'Run Experiment (JS and WASM targets bit-identical).',
  topology: '2d-grid',
  boundaryTreatment: 'torus',
  updateMode: 'synchronous',
  asyncScheme: 'random-order',
  gridWidth: W,
  gridHeight: H,
  maxIterations: 100000,
  tags: ['Overseer', 'experiment', 'statistics', 'Life', 'tutorial'],
  useWasm: true,
};

const attributes = [
  { id: 'alive', name: 'Alive', type: 'bool',
    description: 'Whether the cell is alive (1) or dead (0).',
    isModelAttribute: false, defaultValue: 'false' },
];

const neighborhoods = [
  { id: 'moore', name: 'Moore (8)',
    description: 'The 8 cells around the centre (classic Moore neighbourhood).',
    coords: [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]],
    margin: 1 },
];

const mappings = [
  // Linked Output Mapping — auto-generated colour pass (no graph nodes needed).
  { id: 'life_view', name: 'Alive / Dead', isAttributeToColor: true,
    description: 'Live cells cyan, dead cells near-black (auto-generated linked colour pass).',
    linked: true, linkedAttributeId: 'alive',
    linkedColors: { gradient: [
      { position: 0, r: 13, g: 27, b: 43 },
      { position: 1, r: 76, g: 201, b: 240 },
    ] } },
];

const indicators = [
  { id: 'population', name: 'population', kind: 'linked', dataType: 'bool', defaultValue: '0',
    accumulationMode: 'per-generation', watched: true,
    linkedAttributeId: 'alive', linkedAggregation: 'frequency', trackedValues: ['true'] },
];

// =============================================================================
// ASSEMBLE & WRITE
// =============================================================================
const model = {
  schemaVersion: 2,
  properties,
  attributes,
  neighborhoods,
  mappings,
  indicators,
  graphNodes: g.nodes,
  graphEdges: g.edges,
  macroDefs: [],
  topologyMode: { gridCells: true, agents: false },
  overseerConfig: { enabled: true, seedPolicy: 'sequential', baseSeed: 4242 },
  overseerGraphNodes: ov.nodes,
  overseerGraphEdges: ov.edges,
};

mkdirSync(dirname(OUT), { recursive: true });

let preserved = '';
if (existsSync(OUT)) {
  try {
    const prev = JSON.parse(readFileSync(OUT, 'utf-8'));
    if (prev.simulationState) { model.simulationState = prev.simulationState; preserved += ' +simulationState'; }
    if (prev.properties?.thumbnail) { model.properties.thumbnail = prev.properties.thumbnail; preserved += ' +thumbnail'; }
  } catch { /* unreadable / older format — write fresh */ }
}

writeFileSync(OUT, JSON.stringify(model, null, 2) + '\n', 'utf-8');
console.log(`Wrote ${OUT}${preserved ? ` (preserved${preserved})` : ''}`);
console.log(`  cells graph: ${g.nodes.length} nodes / ${g.edges.length} edges`);
console.log(`  overseer graph: ${ov.nodes.length} nodes / ${ov.edges.length} edges`);

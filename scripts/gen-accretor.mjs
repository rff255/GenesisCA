#!/usr/bin/env node
/**
 * Generates public/models/Accretor.gcaproj — the Accretor CA (Driessens &
 * Verstappen, via the Softology 2018-01-12 post "Accretor Cellular Automata").
 *
 * A 3D ACCRETION automaton. Empty cells crystallise into one of a few states
 * according to a randomly-filled RULE TABLE indexed by how many neighbours are
 * occupied in each of the three 3D neighbour shells:
 *
 *     newState = Rule[ myState, faceCount, edgeCount, cornerCount ]
 *
 * where the 26 Moore neighbours split into 6 FACES, 12 EDGES, 8 CORNERS. Only
 * EMPTY cells are evaluated (state != 0 is frozen forever — that is the
 * "accretion"), and an empty cell with zero face neighbours is skipped
 * (structural connectivity — these rules were built for 3D printing). Since
 * only empty cells update, the rule's STATE axis is always 0 for the cells
 * being written — but the full 4-axis table (state × faces × edges × corners =
 * 3×7×13×9 = 2457 entries for 3 states) is the faithful reproduction of the
 * blog's `Rule[]`, and this is the FIRST model that needs a multi-axis
 * (N-dimensional) Lookup Table (one intRange axis per neighbour-count shell).
 *
 * The rule table is filled RANDOMLY with a seeded xorshift32 PRNG at a chosen
 * density — the SEED IS THE RULE IDENTITY (same seed ⇒ same structure). The
 * table lives in the model (tableData) so a saved .gcaproj reproduces exactly;
 * `tableRoll` records {seed, density} so the user can re-roll it in the editor's
 * Randomize block. The whole point of this CA family is to re-roll seeds and
 * watch what grows.
 *
 * Start: the InitEvent seeds a random 5×5×5 block in the centre; the structure
 * accretes outward. A Stop Event pauses the run when the structure reaches any
 * grid border (constant boundary = empty, so it grows into open space).
 *
 * Compile target: WASM (default). Runs identically on JS, WASM, and WebGPU
 * (verified at cross-target parity — the multi-axis lookup emits the same
 * clamped Σ idxₖ·strideₖ read on all three).
 *
 *   node scripts/gen-accretor.mjs
 *
 * Env overrides (used by the seed search; the defaults are the shipped rule):
 *   GCA_SEED=<int>       rule-table fill seed        (default below)
 *   GCA_DENSITY=<0..1>   P(rule entry ≠ 0)           (default 0.2)
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '..', 'public', 'models', 'Accretor.gcaproj');

// --- tunables ---------------------------------------------------------------
const W = 40, H = 40, D = 40;
const STATES = ['empty', 'A', 'B'];          // 3 states (0 = empty)
// The shipped rule. Chosen by a seed search (scripts/__accretor_search.mjs) for
// a POROUS, dendritic structure with a near-even A/B mix that accretes over
// ~130 generations before reaching the grid edge. Re-roll it in the editor's
// Randomize block to grow an entirely different form (density is user-tunable
// — the blog's default is ~0.2; 0.13 gives more delicate, coral-like growth).
const RULE_SEED = Number(process.env.GCA_SEED ?? 25);
const RULE_DENSITY = Number(process.env.GCA_DENSITY ?? 0.13);

// --- id + node/edge helpers (mirror gen-life3d.mjs) -------------------------
const usedIds = new Set();
function newId(prefix) {
  let id;
  do { id = prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  while (usedIds.has(id));
  usedIds.add(id);
  return id;
}
const graphNodes = [], graphEdges = [];
function node(nodeType, config, col, row) {
  const n = { id: newId('n'), type: 'caNode', position: { x: col * 230, y: row * 90 }, data: { nodeType, config } };
  graphNodes.push(n);
  return n;
}
function edge(srcNode, srcPort, tgtNode, tgtPort, category) {
  graphEdges.push({
    id: newId('e'), source: srcNode.id, target: tgtNode.id,
    sourceHandle: `output_${category}_${srcPort}`, targetHandle: `input_${category}_${tgtPort}`,
  });
}
const vEdge = (s, sp, t, tp) => edge(s, sp, t, tp, 'value');
const fEdge = (s, sp, t, tp) => edge(s, sp, t, tp, 'flow');

// --- the seeded fill — EXACTLY randomFillTableData (variegation.ts) so the
//     generated table byte-matches what the editor's Randomize produces for the
//     same (seed, density, dims, policy). valueType 'tag', valueCount = 2 (A/B).
function randomFillTableData(total, seed, density, valueCount) {
  let rs = (seed >>> 0) || 0x12345678;
  const next = () => {
    rs = (rs ^ (rs << 13)) >>> 0;
    rs = (rs ^ (rs >>> 17)) >>> 0;
    rs = (rs ^ (rs << 5)) >>> 0;
    return rs / 4294967296;
  };
  const d = Math.min(1, Math.max(0, density));
  const count = Math.max(1, Math.floor(valueCount) || 1);
  const out = new Array(Math.max(0, total | 0));
  for (let i = 0; i < out.length; i++) {
    if (next() < d) out[i] = 1 + Math.floor(next() * count);
    else out[i] = 0;
  }
  return out;
}

// =============================================================================
// NEIGHBOURHOODS — the 26 Moore-3D neighbours split into three shells. coords3d
// is the source of truth ([dr, dc, dl]); coords is the SAME-LENGTH 2D
// projection (drops dl) the 2D layouts still read (stride invariant).
// =============================================================================
const faces3d = [], edges3d = [], corners3d = [];
for (let dl = -1; dl <= 1; dl++)
  for (let dr = -1; dr <= 1; dr++)
    for (let dc = -1; dc <= 1; dc++) {
      if (dl === 0 && dr === 0 && dc === 0) continue;
      const z = (dr === 0 ? 1 : 0) + (dc === 0 ? 1 : 0) + (dl === 0 ? 1 : 0); // # of zero components
      if (z === 2) faces3d.push([dr, dc, dl]);       // exactly one non-zero → face (6)
      else if (z === 1) edges3d.push([dr, dc, dl]);  // two non-zero → edge (12)
      else corners3d.push([dr, dc, dl]);             // all three non-zero → corner (8)
    }
const proj2d = (list) => list.map(([dr, dc]) => [dr, dc]);
const NBR_FACES = 'faces', NBR_EDGES = 'edges', NBR_CORNERS = 'corners';

// =============================================================================
// STEP GRAPH — the accretion rule + the edge-stop.
// =============================================================================
const stepNode = node('step', {}, 0, 0);

// Cell-top reads.
const myState = node('getCellAttribute', { attributeId: 'state' }, 0, 2);
const faceArr = node('getNeighborsAttribute', { neighborhoodId: NBR_FACES, attributeId: 'state' }, 0, 4);
const edgeArr = node('getNeighborsAttribute', { neighborhoodId: NBR_EDGES, attributeId: 'state' }, 0, 6);
const cornerArr = node('getNeighborsAttribute', { neighborhoodId: NBR_CORNERS, attributeId: 'state' }, 0, 8);

// Occupied-neighbour counts per shell. `greater` with the `compare` port left
// unwired defaults to 0 (inputs['compare'] || '0'), so this counts neighbours
// with state > 0 (occupied — empty is 0).
const faceCount = node('groupCounting', { operation: 'greater' }, 1, 4);
vEdge(faceArr, 'values', faceCount, 'values');
const edgeCount = node('groupCounting', { operation: 'greater' }, 1, 6);
vEdge(edgeArr, 'values', edgeCount, 'values');
const cornerCount = node('groupCounting', { operation: 'greater' }, 1, 8);
vEdge(cornerArr, 'values', cornerCount, 'values');

// The rule lookup: Rule[myState, faceCount, edgeCount, cornerCount].
const lookup = node('lookupInteraction', { tableId: 'rule' }, 2, 6);
vEdge(myState, 'value', lookup, 'axis_0');
vEdge(faceCount, 'count', lookup, 'axis_1');
vEdge(edgeCount, 'count', lookup, 'axis_2');
vEdge(cornerCount, 'count', lookup, 'axis_3');

// Update gate: only EMPTY cells with ≥1 face neighbour.
const isEmpty = node('statement', { operation: '==', compareType: 'numerical', _port_y: '0' }, 1, 2);
vEdge(myState, 'value', isEmpty, 'x');
const faceGE1 = node('statement', { operation: '>=', compareType: 'numerical', _port_y: '1' }, 2, 4);
vEdge(faceCount, 'count', faceGE1, 'x');
const canUpdate = node('logicOperator', { operation: 'AND' }, 3, 3);
vEdge(isEmpty, 'result', canUpdate, 'a');
vEdge(faceGE1, 'result', canUpdate, 'b');

const gateWrite = node('conditional', {}, 4, 3);
fEdge(stepNode, 'do', gateWrite, 'check');
vEdge(canUpdate, 'result', gateWrite, 'condition');
const writeState = node('setAttribute', { attributeId: 'state' }, 5, 3);
fEdge(gateWrite, 'then', writeState, 'do');
vEdge(lookup, 'value', writeState, 'value');

// --- edge-stop: fire a Stop Event when a BORDER cell is occupied ------------
const pos = node('getCellPosition', {}, 0, 11);
const colInt = node('statement', { operation: 'between', lowOp: '>=', highOp: '<=', compareType: 'numerical', _port_y: '1', _port_y2: String(W - 2) }, 1, 10);
vEdge(pos, 'col', colInt, 'x');
const rowInt = node('statement', { operation: 'between', lowOp: '>=', highOp: '<=', compareType: 'numerical', _port_y: '1', _port_y2: String(H - 2) }, 1, 12);
vEdge(pos, 'row', rowInt, 'x');
const layInt = node('statement', { operation: 'between', lowOp: '>=', highOp: '<=', compareType: 'numerical', _port_y: '1', _port_y2: String(D - 2) }, 1, 14);
vEdge(pos, 'layer', layInt, 'x');
const interior = node('logicOperator', { operation: 'AND' }, 2, 11);
vEdge(colInt, 'result', interior, 'a');
vEdge(rowInt, 'result', interior, 'b');
const interior2 = node('logicOperator', { operation: 'AND' }, 3, 11);
vEdge(interior, 'result', interior2, 'a');
vEdge(layInt, 'result', interior2, 'b');
const onBorder = node('logicOperator', { operation: 'NOT' }, 4, 11);
vEdge(interior2, 'result', onBorder, 'a');
const occupied = node('logicOperator', { operation: 'NOT' }, 2, 2);   // occupied = NOT isEmpty
vEdge(isEmpty, 'result', occupied, 'a');
const reachedEdge = node('logicOperator', { operation: 'AND' }, 5, 11);
vEdge(onBorder, 'result', reachedEdge, 'a');
vEdge(occupied, 'result', reachedEdge, 'b');
const gateStop = node('conditional', {}, 6, 11);
fEdge(stepNode, 'do', gateStop, 'check');
vEdge(reachedEdge, 'result', gateStop, 'condition');
const stopNode = node('stopEvent', { message: 'Structure reached the grid edge.' }, 7, 11);
fEdge(gateStop, 'then', stopNode, 'do');

// =============================================================================
// INIT GRAPH — seed a random 5×5×5 block in the centre. Each box cell gets a
// uniform random state (empty/A/B); cells outside the box stay at their default
// (empty). Runs once per cell on Reset.
// =============================================================================
const cx = Math.floor(W / 2), cy = Math.floor(H / 2), cz = Math.floor(D / 2);
const initNode = node('initEvent', {}, 0, 17);
const xIn = node('statement', { operation: 'between', lowOp: '>=', highOp: '<=', compareType: 'numerical', _port_y: String(cx - 2), _port_y2: String(cx + 2) }, 1, 16);
vEdge(initNode, 'x', xIn, 'x');
const yIn = node('statement', { operation: 'between', lowOp: '>=', highOp: '<=', compareType: 'numerical', _port_y: String(cy - 2), _port_y2: String(cy + 2) }, 1, 18);
vEdge(initNode, 'y', yIn, 'x');
const zIn = node('statement', { operation: 'between', lowOp: '>=', highOp: '<=', compareType: 'numerical', _port_y: String(cz - 2), _port_y2: String(cz + 2) }, 1, 20);
vEdge(initNode, 'z', zIn, 'x');
const inBox1 = node('logicOperator', { operation: 'AND' }, 2, 17);
vEdge(xIn, 'result', inBox1, 'a');
vEdge(yIn, 'result', inBox1, 'b');
const inBox = node('logicOperator', { operation: 'AND' }, 3, 18);
vEdge(inBox1, 'result', inBox, 'a');
vEdge(zIn, 'result', inBox, 'b');
const seedRand = node('getRandom', { randomType: 'integer', min: '0', max: '2' }, 3, 20);
const gateSeed = node('conditional', {}, 4, 18);
fEdge(initNode, 'do', gateSeed, 'check');
vEdge(inBox, 'result', gateSeed, 'condition');
const writeSeed = node('setAttribute', { attributeId: 'state' }, 5, 18);
fEdge(gateSeed, 'then', writeSeed, 'do');
vEdge(seedRand, 'value', writeSeed, 'value');

// =============================================================================
// OUTPUT MAPPING — standalone, so empty cells get alpha 0 (culled by the voxel
// renderer) and A/B get opaque colours. alpha = (state != 0) * 255.
// =============================================================================
const omNode = node('outputMapping', { mappingId: 'accretor' }, 0, 24);
const omState = node('getCellAttribute', { attributeId: 'state' }, 0, 26);
const omColor = node('categoricalColor', {
  count: 3,
  entry_0_r: '0', entry_0_g: '0', entry_0_b: '0',       // empty (alpha 0 anyway)
  entry_1_r: '90', entry_1_g: '210', entry_1_b: '150',  // A — green
  entry_2_r: '210', entry_2_g: '90', entry_2_b: '200',  // B — magenta
  default_r: '80', default_g: '80', default_b: '80',
}, 1, 26);
vEdge(omState, 'value', omColor, 'index');
const omOcc = node('statement', { operation: '!=', compareType: 'numerical', _port_y: '0' }, 1, 28);
vEdge(omState, 'value', omOcc, 'x');
const omAlpha = node('arithmeticOperator', { operation: '*', _port_y: '255' }, 2, 28);
vEdge(omOcc, 'result', omAlpha, 'x');
const looks = node('setCellLooks', {
  mappingId: 'accretor', useGlyph: false, setBackground: true, fallbackToGlyphColor: false,
}, 3, 27);
fEdge(omNode, 'do', looks, 'do');
vEdge(omColor, 'r', looks, 'r');
vEdge(omColor, 'g', looks, 'g');
vEdge(omColor, 'b', looks, 'b');
vEdge(omAlpha, 'result', looks, 'a');

// =============================================================================
// OVERSEER GRAPH — the RULE EXPLORER (the automated "re-roll until something
// interesting grows" workflow, Softology's core loop). Sweeps a list of rule
// seeds; for each: re-roll the rule table, Reset (a FIXED centre seed so the
// comparison isolates the RULE), run until the structure reaches the edge, then
// collect the total accreted-cell count into a series (the panel plots a
// histogram of rule → size). The RandomizeTable node journals every seed, so a
// standout rule reproduces by typing that seed into the editor's Randomize block.
// Uses a SEPARATE node/edge list (overseerGraphNodes / overseerGraphEdges).
// =============================================================================
const ovNodes = [], ovEdges = [];
function ovN(nodeType, config, col, row) {
  const n = { id: newId('o'), type: 'caNode', position: { x: col * 230, y: row * 90 }, data: { nodeType, config } };
  ovNodes.push(n);
  return n;
}
function ovE(s, sp, t, tp, category) {
  ovEdges.push({ id: newId('e'), source: s.id, target: t.id, sourceHandle: `output_${category}_${sp}`, targetHandle: `input_${category}_${tp}` });
}
const ovV = (s, sp, t, tp) => ovE(s, sp, t, tp, 'value');
const ovF = (s, sp, t, tp) => ovE(s, sp, t, tp, 'flow');

// Known-good rule seeds (from the density-0.13 seed search) — each grows a
// porous structure to the edge, so the sweep always shows interesting variety.
const EXPLORE_SEEDS = [25, 162, 85, 294, 93, 154, 62, 34];

const exp = ovN('experiment', {}, 0, 0);
const clear = ovN('ovClearSeries', { series: 'accreted' }, 1, 0);
const seeds = ovN('ovSweepValues', { mode: 'list', list: EXPLORE_SEEDS.join(', ') }, 0, 2);
const forEach = ovN('forEachInArray', {}, 2, 1);
ovV(seeds, 'values', forEach, 'array');
ovF(exp, 'do', clear, 'do');
ovF(clear, 'next', forEach, 'do');

// Per-seed body.
const roll = ovN('ovRandomizeTable', { tableId: 'rule', _port_density: String(RULE_DENSITY) }, 3, 1);
ovF(forEach, 'body', roll, 'do');
ovV(forEach, 'element', roll, 'seed');          // seed = the swept value
const reset = ovN('ovResetBoard', {}, 4, 1);
ovF(roll, 'next', reset, 'do');
const run = ovN('ovRunUntilStop', { _port_maxGens: '600' }, 5, 1);
ovF(reset, 'next', run, 'do');
// Measure the total accreted cells (A + B) at the moment it stops.
const readA = ovN('ovReadIndicator', { indicatorId: 'filled', category: 'A' }, 4, 3);
const readB = ovN('ovReadIndicator', { indicatorId: 'filled', category: 'B' }, 4, 4);
const total = ovN('arithmeticOperator', { operation: '+' }, 5, 3);
ovV(readA, 'value', total, 'x');
ovV(readB, 'value', total, 'y');
const collect = ovN('ovCollectSample', { series: 'accreted', scope: 'experiment' }, 6, 1);
ovF(run, 'next', collect, 'do');
ovV(total, 'result', collect, 'value');
const log = ovN('ovLog', { text: 'accreted {value} cells' }, 7, 1);
ovF(collect, 'next', log, 'do');
ovV(total, 'result', log, 'value');

// =============================================================================
// MODEL PARTS
// =============================================================================
const ruleAxes = [
  { name: 'State', source: { kind: 'intRange', min: 0, max: STATES.length - 1 } },
  { name: 'Faces', source: { kind: 'intRange', min: 0, max: 6 } },
  { name: 'Edges', source: { kind: 'intRange', min: 0, max: 12 } },
  { name: 'Corners', source: { kind: 'intRange', min: 0, max: 8 } },
];
const RULE_TOTAL = ruleAxes.reduce((a, ax) => a * (ax.source.max - ax.source.min + 1), 1); // 3*7*13*9 = 2457
const ruleData = randomFillTableData(RULE_TOTAL, RULE_SEED, RULE_DENSITY, STATES.length - 1);

const properties = {
  name: 'Accretor',
  author: 'Erwin Driessens & Maria Verstappen (Accretor); via Softology (2018)',
  modelAuthor: 'Rodrigo F. Figueiredo',
  description:
    "A 3D accretion automaton (Driessens & Verstappen). Empty cells crystallise " +
    "into A or B according to a RANDOMLY-FILLED rule table indexed by how many of " +
    "their 6 face, 12 edge, and 8 corner neighbours are occupied. Occupied cells " +
    "freeze forever. From a random 5×5×5 seed in the centre the structure accretes " +
    "outward until it reaches a grid edge. The rule is one 4-axis (state × face × " +
    "edge × corner count) Lookup Table filled by a seed — re-roll the seed in the " +
    "table's Randomize block (Attributes ▸ rule) to grow an entirely different form. " +
    "Orbit the camera and pull the clip plane to see inside. The Experiments panel " +
    "runs a Rule Explorer that sweeps a list of seeds and charts how big each rule's " +
    "structure grows — the automated version of re-rolling until something interesting appears.",
  topology: '2d-grid',
  boundaryTreatment: 'constant',
  updateMode: 'synchronous',
  asyncScheme: 'random-order',
  gridWidth: W,
  gridHeight: H,
  gridDepth: D,
  dimension: '3d',
  maxIterations: 100000,
  tags: ['3D', 'accretion', 'growth', 'rule-table', 'Driessens-Verstappen', 'voxel'],
  useWasm: true,
};

const attributes = [
  {
    id: 'state', name: 'State', type: 'tag',
    description: 'The cell\'s crystallised state: empty (0, still growable), or one of the accreted species A / B (frozen once set).',
    isModelAttribute: false, defaultValue: '0', boundaryValue: '0',
    tagOptions: STATES,
  },
  {
    id: 'rule', name: 'rule', type: 'lookupTable',
    description:
      'The accretion rule: newState = rule[state, faceCount, edgeCount, cornerCount]. ' +
      'A 4-axis table (3 states × 0..6 faces × 0..12 edges × 0..8 corners = 2457 ' +
      'entries) filled randomly at ~20% density — the SEED is the rule identity. ' +
      'Only the state=0 slice is consulted (empty cells accrete); re-roll the seed ' +
      'in the Randomize block to grow a different structure.',
    isModelAttribute: true, defaultValue: '0',
    axes: ruleAxes,
    valueType: 'tag',
    valueTagAttributeId: 'state',   // returned values are state indices (0/1/2)
    tableData: ruleData,
    tableRoll: { seed: RULE_SEED >>> 0, density: RULE_DENSITY },
  },
];

const neighborhoods = [
  { id: NBR_FACES, name: 'Faces (6)',
    description: 'The 6 orthogonal face-adjacent neighbours (±1 on exactly one axis).',
    coords: proj2d(faces3d), coords3d: faces3d, margin: 1 },
  { id: NBR_EDGES, name: 'Edges (12)',
    description: 'The 12 edge-adjacent neighbours (±1 on exactly two axes).',
    coords: proj2d(edges3d), coords3d: edges3d, margin: 1 },
  { id: NBR_CORNERS, name: 'Corners (8)',
    description: 'The 8 corner-adjacent neighbours (±1 on all three axes).',
    coords: proj2d(corners3d), coords3d: corners3d, margin: 1 },
];

const mappings = [
  { id: 'accretor', name: 'State (A / B)', isAttributeToColor: true,
    description: 'Empty cells fully transparent (alpha 0 → culled by the voxel renderer); A green, B magenta, opaque.',
    redDescription: 'By state', greenDescription: 'By state', blueDescription: 'By state' },
];

const indicators = [
  { id: 'filled', name: 'Accreted cells (by species)', kind: 'linked', dataType: 'tag',
    defaultValue: '0', accumulationMode: 'per-generation', watched: true,
    linkedAttributeId: 'state', linkedAggregation: 'frequency', trackedValues: ['A', 'B'] },
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
  graphNodes,
  graphEdges,
  macroDefs: [],
  topologyMode: { gridCells: true, agents: false },
  // The Rule Explorer experiment (Overseer). seedPolicy 'fixed' holds the centre
  // 5×5×5 seed constant across the sweep so the series isolates the RULE's effect.
  overseerConfig: { enabled: true, seedPolicy: 'fixed', baseSeed: 12345 },
  overseerGraphNodes: ovNodes,
  overseerGraphEdges: ovEdges,
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
console.log(
  `Wrote ${OUT}\n  ${graphNodes.length} nodes, ${graphEdges.length} edges, ` +
  `grid ${W}x${H}x${D}, rule seed ${RULE_SEED >>> 0} density ${RULE_DENSITY} ` +
  `(${RULE_TOTAL} entries, ${ruleData.filter(v => v !== 0).length} non-zero), ` +
  `Overseer Rule Explorer (${ovNodes.length} nodes, ${EXPLORE_SEEDS.length} seeds)${preserved}`,
);

#!/usr/bin/env node
/**
 * Generates public/models/Amphiphile.gcaproj
 *
 * A chemistry-CA demo of the Variegated Cells (Directional Interactions)
 * feature. Cells are either water (no face pattern) or amphiphile (a small
 * molecule with a hydrophilic Head face and a hydrophobic Tail face on
 * opposite sides). Each amphiphile cell carries an orientation (0..3, 90°
 * rotations); a per-step rule rotates unhappy amphiphiles toward a more
 * favourable encounter pattern. Over time the amphiphiles self-organise:
 * heads face water, tails clump together — the building blocks of micelles
 * and bilayers.
 *
 * Heavy arithmetic (energy sum, rotation update, RGB colour synthesis) is
 * routed through `expression` nodes so the formulas are legible in one place
 * instead of being spread across many one-operator nodes — mirrors the
 * gen-grayscott.mjs approach. Re-run after any tweak:
 *   node scripts/gen-amphiphile.mjs
 *
 * Re-running preserves the saved simulationState + library thumbnail from
 * the existing output file (they're added in-app, not by this script).
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../public/models/Amphiphile.gcaproj');

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

// --- graph builders ----------------------------------------------------------
const graphNodes = [];
const graphEdges = [];

function node(nodeType, config, col, row) {
  const n = {
    id: newId('n'),
    type: 'caNode',
    position: { x: col * 230, y: row * 90 },
    data: { nodeType, config },
  };
  graphNodes.push(n);
  return n;
}

function edge(srcNode, srcPort, tgtNode, tgtPort, category) {
  graphEdges.push({
    id: newId('e'),
    source: srcNode.id,
    target: tgtNode.id,
    sourceHandle: `output_${category}_${srcPort}`,
    targetHandle: `input_${category}_${tgtPort}`,
  });
}
const vEdge = (s, sp, t, tp) => edge(s, sp, t, tp, 'value');
const fEdge = (s, sp, t, tp) => edge(s, sp, t, tp, 'flow');

const PORT_IDS = 'abcdefgh';
function exprNode(expression, varNames, col, row, label) {
  const config = { expression, visibleCount: varNames.length };
  varNames.forEach((nm, i) => { config[`_varName_${PORT_IDS[i]}`] = nm; });
  const n = node('expression', config, col, row);
  if (label) n.data.label = label;
  return n;
}

// =============================================================================
// IDs referenced across the graph (must match the attributes / neighborhoods /
// mappings declared further down).
// =============================================================================
const ATTR_KIND = 'kind';
const ATTR_THRESHOLD = 'threshold';
const ATTR_DENSITY = 'density';
const ATTR_INTERACTION = 'interactions';
const NBR4 = 'nbr4';
const PAT_AMPHI = 'pat_amphi';
const MAPPING_SEED = 'seed';
const MAPPING_VIZ = 'viz';

// Tag indices for the kind attribute. Amphiphile is at index 1 — used by the
// step rule (only amphiphiles act on their orientation) and the init/seed
// graphs (writing kind = amphiphile).
const TAG_WATER = 0;
const TAG_AMPHI = 1;

// =============================================================================
// C. STEP GRAPH — for each amphiphile, sum encounter energies over its 4
// cardinal neighbours; if the sum is below the threshold, rotate by a random
// 1..3 step. Water cells are gated out at the top of the chain so they don't
// burn RNG entropy or waste energy lookups.
// =============================================================================

const stepNode = node('step', {}, 0, 0);

// --- read the current cell's species + orientation --------------------------
const kindRead = node('getCellAttribute', { attributeId: ATTR_KIND }, 0, 2);
const oriRead  = node('getOrientation', {}, 0, 3);

// --- gate 1: only amphiphiles continue --------------------------------------
const isAmphi = node('statement', {
  operation: '==',
  _port_y: String(TAG_AMPHI),
}, 1, 2);
isAmphi.data.label = 'Is amphiphile?';
vEdge(kindRead, 'value', isAmphi, 'x');

const condAmphi = node('conditional', {}, 2, 2);
fEdge(stepNode, 'do', condAmphi, 'check');
vEdge(isAmphi, 'value', condAmphi, 'condition');

// --- per-neighbour facing labels + interaction energies ----------------------
// 4 cardinal neighbours (NESW). For each: read the two face labels touching
// at the encounter, then look up the (myFace, theirFace) energy in the
// interaction table. Aggregate(sum) reduces the 4 scalars into a total.
const SLOT_LABEL = ['N', 'S', 'W', 'E']; // matches nbr4.coords order
const energyNodes = [];
for (let i = 0; i < 4; i++) {
  const gfl = node('getFacingLabels', {
    neighborhoodId: NBR4,
    _port_index: String(i),
  }, 3, 1 + i * 2);
  gfl.data.label = `Encounter ${SLOT_LABEL[i]}`;

  const li = node('lookupInteraction', {
    tableId: ATTR_INTERACTION,
  }, 4, 1 + i * 2);
  li.data.label = `Energy ${SLOT_LABEL[i]}`;
  vEdge(gfl, 'myFaceLabel',    li, 'labelA');
  vEdge(gfl, 'theirFaceLabel', li, 'labelB');
  energyNodes.push(li);
}

const energySum = node('aggregate', { operation: 'sum' }, 5, 4);
energySum.data.label = 'Total encounter energy';
for (const li of energyNodes) vEdge(li, 'value', energySum, 'values');

// --- gate 2: rotate only if total energy is below the threshold --------------
const threshold = node('getModelAttribute', {
  attributeId: ATTR_THRESHOLD, isColorAttr: false,
}, 5, 6);
const isUnhappy = node('statement', { operation: '<' }, 6, 5);
isUnhappy.data.label = 'Unhappy?';
vEdge(energySum, 'result', isUnhappy, 'x');
vEdge(threshold, 'value', isUnhappy, 'y');

const condUnhappy = node('conditional', {}, 7, 5);
fEdge(condAmphi, 'then', condUnhappy, 'check');
vEdge(isUnhappy, 'value', condUnhappy, 'condition');

// --- new orientation = (current + random 1..3) mod 4 ------------------------
// One random step in [1, 3] guarantees we move (never stay put on an unhappy
// state). `mod()` keeps the result in [0, 3] without bitwise ops (Expression
// node has no `&`); WASM / WebGPU `setOrientation` masks again with `& 3` as
// a defensive narrowing.
const randomStep = node('getRandom', {
  randomType: 'integer', min: '1', max: '3',
}, 5, 8);
randomStep.data.label = 'Random rotation step (1..3)';

const newOri = exprNode(
  'mod(ori + step, 4)',
  ['ori', 'step'],
  8, 5,
  'New orientation',
);
vEdge(oriRead,    'value', newOri, 'a');
vEdge(randomStep, 'value', newOri, 'b');

const setOri = node('setOrientation', {}, 9, 5);
fEdge(condUnhappy, 'then', setOri, 'do');
vEdge(newOri, 'result', setOri, 'value');

// =============================================================================
// D. INIT EVENT GRAPH — runs once per cell on Reset. With probability
// `density`, mark the cell as amphiphile. Either way, assign a random
// initial orientation in 0..3 so amphiphiles don't all start aligned.
// =============================================================================

const initNode = node('initEvent', {}, 0, 14);

// Branch A: maybe become amphiphile
const densityAttr = node('getModelAttribute', {
  attributeId: ATTR_DENSITY, isColorAttr: false,
}, 1, 13);
const isSeed = node('getRandom', { randomType: 'bool' }, 2, 13);
isSeed.data.label = 'Seed amphi here?';
vEdge(densityAttr, 'value', isSeed, 'probability');

const condSeed = node('conditional', {}, 3, 13);
fEdge(initNode, 'do', condSeed, 'check');
vEdge(isSeed, 'value', condSeed, 'condition');

const setKindAmphi = node('setAttribute', {
  attributeId: ATTR_KIND,
  _port_value: String(TAG_AMPHI),
}, 4, 13);
fEdge(condSeed, 'then', setKindAmphi, 'do');

// Branch B: always assign a random initial orientation
const randomOri = node('getRandom', {
  randomType: 'integer', min: '0', max: '3',
}, 1, 16);
randomOri.data.label = 'Random initial orientation';
const setOriInit = node('setOrientation', {}, 2, 16);
fEdge(initNode, 'do', setOriInit, 'do');
vEdge(randomOri, 'value', setOriInit, 'value');

// =============================================================================
// E. SEED INPUT-MAPPING GRAPH — painting writes kind = amphiphile +
// a fresh random orientation. The painted RGB is ignored.
// =============================================================================

const seedInput = node('inputColor', { mappingId: MAPPING_SEED }, 0, 21);
const seedKind  = node('setAttribute', {
  attributeId: ATTR_KIND,
  _port_value: String(TAG_AMPHI),
}, 1, 21);
fEdge(seedInput, 'do', seedKind, 'do');

const seedRand = node('getRandom', {
  randomType: 'integer', min: '0', max: '3',
}, 1, 23);
const seedOri  = node('setOrientation', {}, 2, 23);
fEdge(seedInput, 'do', seedOri, 'do');
vEdge(seedRand, 'value', seedOri, 'value');

// =============================================================================
// F. VISUALIZATION OUTPUT-MAPPING GRAPH — colour each cell by species +
// orientation. Water cells are dark grey; amphiphile cells get a smooth
// 4-position rainbow band that highlights which way the head is pointing.
//
// The colour math is `kind * amphiCh + (1 - kind) * waterCh` (no ternary
// because Expression has none, but kind is 0/1 so this trick works). The
// per-channel amphi tint is built from `255 - 80 * abs(ori - peakSlot)`,
// where peakSlot picks which orientation that channel peaks at. That gives
// a peaked, smoothly-falling triangle wave with rgb peaks staggered so the
// four orientations land on distinct hues.
// =============================================================================

const vizOutput   = node('outputMapping', { mappingId: MAPPING_VIZ }, 0, 28);
const vizKind     = node('getCellAttribute', { attributeId: ATTR_KIND }, 0, 30);
const vizOri      = node('getOrientation', {}, 0, 31);

const channelR = exprNode(
  'kind * max(0, 255 - 80 * abs(ori - 0)) + (1 - kind) * 40',
  ['kind', 'ori'], 1, 29, 'Red channel',
);
const channelG = exprNode(
  'kind * max(0, 255 - 80 * abs(ori - 2)) + (1 - kind) * 40',
  ['kind', 'ori'], 1, 30, 'Green channel',
);
const channelB = exprNode(
  'kind * max(0, 255 - 80 * abs(ori - 3)) + (1 - kind) * 40',
  ['kind', 'ori'], 1, 31, 'Blue channel',
);
for (const ch of [channelR, channelG, channelB]) {
  vEdge(vizKind, 'value', ch, 'a');
  vEdge(vizOri,  'value', ch, 'b');
}

const setColor = node('setColorViewer', { mappingId: MAPPING_VIZ }, 3, 30);
fEdge(vizOutput, 'do', setColor, 'do');
vEdge(channelR, 'result', setColor, 'r');
vEdge(channelG, 'result', setColor, 'g');
vEdge(channelB, 'result', setColor, 'b');

// =============================================================================
// B. NON-GRAPH MODEL PARTS
// =============================================================================

const properties = {
  name: 'Amphiphile (Variegated Cells demo)',
  author: 'GenesisCA',
  modelAuthor: 'Rodrigo F. Figueiredo',
  description:
    'A chemistry-CA demo of the Variegated Cells feature. Two species: water ' +
    '(no face pattern) and amphiphile (Head face pointing N, Tail face S). ' +
    'Each amphiphile carries an orientation (0/90/180/270°). Per-step rule: ' +
    'sum the four neighbour-encounter energies via the Interaction Table; if ' +
    'below the threshold, rotate by a random 1..3 step. Over time the ' +
    'amphiphiles self-organise — heads face water, tails cluster — the same ' +
    'logic that drives micelle/bilayer formation in real surfactant chemistry. ' +
    "Reset to randomise from scratch. Paint with the 'Seed' brush to add " +
    'amphiphiles at the cursor.',
  topology: '2d-grid',
  boundaryTreatment: 'torus',
  updateMode: 'synchronous',
  asyncScheme: 'random-order',
  gridWidth: 120,
  gridHeight: 120,
  maxIterations: 100000,
  tags: ['variegated cells', 'chemistry', 'self-organization', 'amphiphile', 'surfactant', 'micelle'],
  useWasm: true,
  useWebGPU: false,
};

const attributes = [
  // --- cell attributes ---
  { id: ATTR_KIND, name: 'Kind', type: 'tag',
    description: 'Cell species. Water has no face pattern (all faces are the implicit "none" label). Amphiphile carries the H/T face pattern + the orientation.',
    isModelAttribute: false, defaultValue: String(TAG_WATER),
    tagOptions: ['water', 'amphiphile'],
    // Variegation source assignment — amphiphile tag → pat_amphi face pattern.
    facePatternAssignments: { 'amphiphile': PAT_AMPHI },
  },
  // --- model attributes (knobs) ---
  { id: ATTR_THRESHOLD, name: 'Energy threshold', type: 'float',
    description: 'Cells with summed encounter energy STRICTLY below this rotate by a random 1..3 step. Higher = more churn (cells reach pickier "happy" states); lower = settle faster.',
    isModelAttribute: true, defaultValue: '0.5', hasBounds: true, min: -4, max: 4 },
  { id: ATTR_DENSITY, name: 'Initial amphi density', type: 'float',
    description: 'Probability that each cell starts as amphiphile on Reset. 0 = all water (paint your own); 1 = no water left.',
    isModelAttribute: true, defaultValue: '0.2', hasBounds: true, min: 0, max: 1 },
  { id: ATTR_INTERACTION, name: 'Interaction Table', type: 'interactionTable',
    description: 'Per-pair encounter energies between face labels (none/H/T). Head likes water, Tail clumps with Tail, Head-Head repels — classic surfactant. Live-edit during simulation to see the dynamics shift.',
    isModelAttribute: true, defaultValue: '0',
    symmetric: true,
    tableValues: {
      'none': { 'none': 0,    'H':  1.0,  'T': -0.5 },
      'H':    { 'none': 1.0,  'H': -0.5,  'T':  0   },
      'T':    { 'none': -0.5, 'H':  0,    'T':  1.0 },
    },
  },
];

const neighborhoods = [
  { id: NBR4, name: '4-Cardinal (N, S, W, E)',
    description: 'The 4 edge-adjacent neighbours. Tags on each slot drive the directional face-label resolution — N at slot 0 anchors the rotation math.',
    // Coords match the SLOT_LABEL array in section C: ['N','S','W','E'].
    coords: [[-1, 0], [1, 0], [0, -1], [0, 1]],
    tags: { 0: 'N', 1: 'S', 2: 'W', 3: 'E' },
    margin: 1 },
];

const mappings = [
  { id: MAPPING_SEED, name: 'Seed', isAttributeToColor: false,
    description: 'Paint to drop amphiphile molecules at the cursor (with random initial orientation). Painted colour is ignored.',
    redDescription: 'Ignored', greenDescription: 'Ignored', blueDescription: 'Ignored' },
  { id: MAPPING_VIZ, name: 'Species + Orientation', isAttributeToColor: true,
    description: 'Water cells render dark grey. Amphiphiles take a 4-position rainbow band (red→olive→mint→sky-blue) showing which way the head is pointing.',
    redDescription: 'Amphi (R peaks at orientation 0, head→N)',
    greenDescription: 'Amphi (G peaks at orientation 2, head→S)',
    blueDescription: 'Amphi (B peaks at orientation 3, head→W)' },
];

const variegatedCells = {
  enabled: true,
  sourceAttributeId: ATTR_KIND,
  faceLabels: ['H', 'T'],
  facePatterns: [
    {
      id: PAT_AMPHI,
      name: 'Amphiphile',
      layoutMode: 'edges',
      // Face slots: [N, NE, E, SE, S, SW, W, NW]. H at N, T at S, the other
      // 6 slots are 'none' so HE/HW/TE/TW encounters resolve to neutral.
      faces: ['H', null, null, null, 'T', null, null, null],
    },
  ],
};

// =============================================================================
// PRESETS — interaction-table variations + density / threshold pairings.
// Each preset captures the full set of knobs that produce a qualitatively
// different regime. Switch between them in the simulator's Presets dropdown.
// =============================================================================
const createdAt = Date.now();
function preset(name, description, modelAttrs, interactions) {
  return {
    id: newId('preset'),
    name,
    description,
    state: {
      schemaVersion: 2,
      modelAttrs,
      interactionTables: { [ATTR_INTERACTION]: interactions },
    },
    createdAt,
  };
}

const presets = [
  preset(
    'Classic surfactant',
    'Strong H-W attraction, strong T-T attraction. Tails clump readily, heads coat the water boundary.',
    { [ATTR_THRESHOLD]: 0.5, [ATTR_DENSITY]: 0.2 },
    {
      'none': { 'none': 0,    'H':  1.0,  'T': -0.5 },
      'H':    { 'none': 1.0,  'H': -0.5,  'T':  0   },
      'T':    { 'none': -0.5, 'H':  0,    'T':  1.0 },
    },
  ),
  preset(
    'Hydrophobic-dominant',
    'Tail-tail attraction much stronger. Tail clusters form faster but the head boundary is fuzzier.',
    { [ATTR_THRESHOLD]: 0.5, [ATTR_DENSITY]: 0.3 },
    {
      'none': { 'none': 0,    'H':  0.5,  'T': -1.0 },
      'H':    { 'none': 0.5,  'H': -0.2,  'T':  0   },
      'T':    { 'none': -1.0, 'H':  0,    'T':  2.0 },
    },
  ),
  preset(
    'Polar liquid',
    'Heads attract heads too (H-H positive). Amphiphiles line up head-to-head as well as tail-to-tail — chain-like structures.',
    { [ATTR_THRESHOLD]: 0.5, [ATTR_DENSITY]: 0.3 },
    {
      'none': { 'none': 0,    'H':  0.5,  'T': -0.5 },
      'H':    { 'none': 0.5,  'H':  1.0,  'T': -0.5 },
      'T':    { 'none': -0.5, 'H': -0.5,  'T':  1.0 },
    },
  ),
  preset(
    'Dense churn',
    'High density + high threshold. Most cells are always "unhappy"; constant rotation produces a busy turbulent visual.',
    { [ATTR_THRESHOLD]: 2.0, [ATTR_DENSITY]: 0.5 },
    {
      'none': { 'none': 0,    'H':  1.0,  'T': -0.5 },
      'H':    { 'none': 1.0,  'H': -0.5,  'T':  0   },
      'T':    { 'none': -0.5, 'H':  0,    'T':  1.0 },
    },
  ),
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
  indicators: [],
  graphNodes,
  graphEdges,
  macroDefs: [],
  presets,
  variegatedCells,
};

mkdirSync(dirname(OUT), { recursive: true });

let preserved = '';
if (existsSync(OUT)) {
  try {
    const prev = JSON.parse(readFileSync(OUT, 'utf-8'));
    if (prev.simulationState) {
      model.simulationState = prev.simulationState;
      preserved += ' +simulationState';
    }
    if (prev.properties?.thumbnail) {
      model.properties.thumbnail = prev.properties.thumbnail;
      preserved += ' +thumbnail';
    }
  } catch { /* unreadable / older format — just write a fresh file */ }
}

writeFileSync(OUT, JSON.stringify(model, null, 2) + '\n', 'utf-8');
console.log(
  `Wrote ${OUT}\n  ${graphNodes.length} nodes, ${graphEdges.length} edges, ` +
  `${attributes.length} attributes, ${neighborhoods.length} neighborhoods, ` +
  `${mappings.length} mappings, ${presets.length} presets, ` +
  `${variegatedCells.facePatterns.length} face patterns, ` +
  `${variegatedCells.faceLabels.length} face labels${preserved}`,
);

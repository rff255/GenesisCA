#!/usr/bin/env node
/**
 * Generates public/models/Gray-Scott Reaction-Diffusion.gcaproj
 *
 * Gray-Scott reaction-diffusion (Gray & Scott, 1983), 9-point weighted-Laplacian
 * CA form (per Karl Sims / Pearson). Two continuous float fields per cell:
 *   lapU = 0.2*sum(ortho U) + 0.05*sum(diag U) - 1.0*U
 *   lapV = 0.2*sum(ortho V) + 0.05*sum(diag V) - 1.0*V
 *   uvv  = U*V*V
 *   U'   = U + (Du*lapU - uvv + F*(1-U)) * dt
 *   V'   = V + (Dv*lapV + uvv - (F+k)*V) * dt
 *
 * The graph is ~50 nodes / ~59 edges — built programmatically here rather than
 * hand-typed as JSON. Re-run after any tweak: `node scripts/gen-grayscott.mjs`.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../public/models/Gray-Scott Reaction-Diffusion.gcaproj');

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

/** Create a node, push it, return it (callers reference theNode.id). */
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

/** Edge between two ports. Handle format: `${kind}_${category}_${portId}`. */
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

// =============================================================================
// C. STEP GRAPH — the Gray-Scott per-cell update
// =============================================================================

const stepNode = node('step', {}, 0, 0);

// --- shared reads ------------------------------------------------------------
const uRead = node('getCellAttribute', { attributeId: 'U' }, 0, 2);
const vRead = node('getCellAttribute', { attributeId: 'V' }, 0, 3);

const Fattr  = node('getModelAttribute', { attributeId: 'F',  isColorAttr: false }, 0, 5);
const kattr  = node('getModelAttribute', { attributeId: 'k',  isColorAttr: false }, 0, 6);
const Duattr = node('getModelAttribute', { attributeId: 'Du', isColorAttr: false }, 0, 7);
const Dvattr = node('getModelAttribute', { attributeId: 'Dv', isColorAttr: false }, 0, 8);
const dtattr = node('getModelAttribute', { attributeId: 'dt', isColorAttr: false }, 0, 9);

const orthoUgather = node('getNeighborsAttribute', { neighborhoodId: 'ortho', attributeId: 'U' }, 0, 11);
const diagUgather  = node('getNeighborsAttribute', { neighborhoodId: 'diag',  attributeId: 'U' }, 0, 12);
const orthoVgather = node('getNeighborsAttribute', { neighborhoodId: 'ortho', attributeId: 'V' }, 0, 13);
const diagVgather  = node('getNeighborsAttribute', { neighborhoodId: 'diag',  attributeId: 'V' }, 0, 14);

// --- neighbor sums (aggregate consumes the gather's array) -------------------
const orthoUsum = node('aggregate', { operation: 'sum' }, 1, 11);
const diagUsum  = node('aggregate', { operation: 'sum' }, 1, 12);
const orthoVsum = node('aggregate', { operation: 'sum' }, 1, 13);
const diagVsum  = node('aggregate', { operation: 'sum' }, 1, 14);
vEdge(orthoUgather, 'values', orthoUsum, 'values');
vEdge(diagUgather,  'values', diagUsum,  'values');
vEdge(orthoVgather, 'values', orthoVsum, 'values');
vEdge(diagVgather,  'values', diagVsum,  'values');

// --- Laplacians: 0.2*orthoSum + 0.05*diagSum - center ------------------------
// lapU
const lapU_a  = node('arithmeticOperator', { operation: '*', _port_y: '0.2'  }, 2, 11);
const lapU_b  = node('arithmeticOperator', { operation: '*', _port_y: '0.05' }, 2, 12);
const lapU_ab = node('arithmeticOperator', { operation: '+' }, 3, 11);
const lapU    = node('arithmeticOperator', { operation: '-' }, 4, 11);
vEdge(orthoUsum, 'result', lapU_a, 'x');
vEdge(diagUsum,  'result', lapU_b, 'x');
vEdge(lapU_a, 'result', lapU_ab, 'x');
vEdge(lapU_b, 'result', lapU_ab, 'y');
vEdge(lapU_ab, 'result', lapU, 'x');
vEdge(uRead,   'value',  lapU, 'y');

// lapV
const lapV_a  = node('arithmeticOperator', { operation: '*', _port_y: '0.2'  }, 2, 13);
const lapV_b  = node('arithmeticOperator', { operation: '*', _port_y: '0.05' }, 2, 14);
const lapV_ab = node('arithmeticOperator', { operation: '+' }, 3, 13);
const lapV    = node('arithmeticOperator', { operation: '-' }, 4, 13);
vEdge(orthoVsum, 'result', lapV_a, 'x');
vEdge(diagVsum,  'result', lapV_b, 'x');
vEdge(lapV_a, 'result', lapV_ab, 'x');
vEdge(lapV_b, 'result', lapV_ab, 'y');
vEdge(lapV_ab, 'result', lapV, 'x');
vEdge(vRead,   'value',  lapV, 'y');

// --- shared uvv = U * V * V --------------------------------------------------
const vv  = node('arithmeticOperator', { operation: '*' }, 1, 2);
const uvv = node('arithmeticOperator', { operation: '*' }, 2, 2);
vEdge(vRead, 'value', vv, 'x');
vEdge(vRead, 'value', vv, 'y');
vEdge(uRead, 'value', uvv, 'x');
vEdge(vv, 'result', uvv, 'y');

// --- U' = U + (Du*lapU - uvv + F*(1-U)) * dt ---------------------------------
const DuLapU          = node('arithmeticOperator', { operation: '*' }, 5, 7);
const oneMinusU       = node('arithmeticOperator', { operation: '-', _port_x: '1.0' }, 1, 4);
const FtimesOneMinusU = node('arithmeticOperator', { operation: '*' }, 2, 4);
const U_diff1         = node('arithmeticOperator', { operation: '-' }, 6, 4);
const U_rate          = node('arithmeticOperator', { operation: '+' }, 7, 4);
const U_delta         = node('arithmeticOperator', { operation: '*' }, 8, 4);
const U_next          = node('arithmeticOperator', { operation: '+' }, 9, 4);
vEdge(Duattr, 'value', DuLapU, 'x');
vEdge(lapU,   'result', DuLapU, 'y');
vEdge(uRead,  'value', oneMinusU, 'y');
vEdge(Fattr,      'value',  FtimesOneMinusU, 'x');
vEdge(oneMinusU,  'result', FtimesOneMinusU, 'y');
vEdge(DuLapU, 'result', U_diff1, 'x');
vEdge(uvv,    'result', U_diff1, 'y');
vEdge(U_diff1,         'result', U_rate, 'x');
vEdge(FtimesOneMinusU, 'result', U_rate, 'y');
vEdge(U_rate,  'result', U_delta, 'x');
vEdge(dtattr,  'value',  U_delta, 'y');
vEdge(uRead,   'value',  U_next, 'x');
vEdge(U_delta, 'result', U_next, 'y');

// --- V' = V + (Dv*lapV + uvv - (F+k)*V) * dt ---------------------------------
const FplusK  = node('arithmeticOperator', { operation: '+' }, 1, 6);
const DvLapV  = node('arithmeticOperator', { operation: '*' }, 5, 9);
const FkV     = node('arithmeticOperator', { operation: '*' }, 2, 6);
const V_sum1  = node('arithmeticOperator', { operation: '+' }, 6, 9);
const V_rate  = node('arithmeticOperator', { operation: '-' }, 7, 9);
const V_delta = node('arithmeticOperator', { operation: '*' }, 8, 9);
const V_next  = node('arithmeticOperator', { operation: '+' }, 9, 9);
vEdge(Fattr, 'value', FplusK, 'x');
vEdge(kattr, 'value', FplusK, 'y');
vEdge(Dvattr, 'value', DvLapV, 'x');
vEdge(lapV,   'result', DvLapV, 'y');
vEdge(FplusK, 'result', FkV, 'x');
vEdge(vRead,  'value',  FkV, 'y');
vEdge(DvLapV, 'result', V_sum1, 'x');
vEdge(uvv,    'result', V_sum1, 'y');
vEdge(V_sum1, 'result', V_rate, 'x');
vEdge(FkV,    'result', V_rate, 'y');
vEdge(V_rate,  'result', V_delta, 'x');
vEdge(dtattr,  'value',  V_delta, 'y');
vEdge(vRead,   'value',  V_next, 'x');
vEdge(V_delta, 'result', V_next, 'y');

// --- writes ------------------------------------------------------------------
const writeU = node('setAttribute', { attributeId: 'U' }, 10, 4);
const writeV = node('setAttribute', { attributeId: 'V' }, 10, 9);
fEdge(stepNode, 'do', writeU, 'do');
fEdge(stepNode, 'do', writeV, 'do');
vEdge(U_next, 'result', writeU, 'value');
vEdge(V_next, 'result', writeV, 'value');

// =============================================================================
// D. SEED INPUT-MAPPING GRAPH — paint sets U=0.5, V=0.25
// =============================================================================

const seedInput  = node('inputColor', { mappingId: 'seed' }, 0, 18);
const seedWriteU = node('setAttribute', { attributeId: 'U', _port_value: '0.5'  }, 1, 18);
const seedWriteV = node('setAttribute', { attributeId: 'V', _port_value: '0.25' }, 1, 19);
fEdge(seedInput, 'do', seedWriteU, 'do');
fEdge(seedInput, 'do', seedWriteV, 'do');

// =============================================================================
// E. V OUTPUT-MAPPING GRAPH — V -> black->white grayscale ramp
// =============================================================================

const vOutput     = node('outputMapping', { mappingId: 'vConc' }, 0, 22);
const vViewerRead = node('getCellAttribute', { attributeId: 'V' }, 0, 23);
// inMax 0.5 leaves headroom above V's observed ceiling (~0.42) so the brightest
// cells don't clip; smoothstep gives the ramp a softer toe/shoulder.
const vScale      = node('proportionMap', {
  method: 'linear',
  _port_inMin: '0', _port_inMax: '0.5', _port_outMin: '0', _port_outMax: '1',
}, 1, 23);
const vColor      = node('colorInterpolation', {
  method: 'smoothstep',
  _port_r1: '0', _port_g1: '0', _port_b1: '0',
  _port_r2: '255', _port_g2: '255', _port_b2: '255',
}, 2, 23);
const vSetViewer  = node('setColorViewer', { mappingId: 'vConc' }, 3, 22);
vEdge(vViewerRead, 'value', vScale, 'x');
vEdge(vScale, 'result', vColor, 't');
fEdge(vOutput, 'do', vSetViewer, 'do');
vEdge(vColor, 'r', vSetViewer, 'r');
vEdge(vColor, 'g', vSetViewer, 'g');
vEdge(vColor, 'b', vSetViewer, 'b');

// =============================================================================
// B. NON-GRAPH MODEL PARTS
// =============================================================================

const properties = {
  name: 'Gray-Scott Reaction-Diffusion',
  author: 'Peter Gray & Stephen K. Scott (1983); 9-point CA form per Karl Sims',
  modelAuthor: 'GenesisCA',
  description:
    'A two-chemical reaction-diffusion system (Gray-Scott, 1983). Feed chemical U ' +
    'is replenished everywhere; catalyst V consumes it autocatalytically ' +
    '(U + 2V -> 3V) and decays. Both species diffuse via a 9-point weighted ' +
    'Laplacian. Tuning the feed rate F and kill rate k yields spots, stripes, ' +
    'mazes, mitosis and solitons - Turing-like self-organization from simple ' +
    "local chemistry. Select the 'Seed' brush, paint a blob near the centre, " +
    'then press Play. Try the parameter presets for different regimes.',
  topology: '2d-grid',
  boundaryTreatment: 'torus',
  updateMode: 'synchronous',
  asyncScheme: 'random-order',
  gridWidth: 200,
  gridHeight: 200,
  maxIterations: 100000,
  tags: ['reaction-diffusion', 'continuous', 'pattern-formation', 'chemistry', 'Gray-Scott'],
  useWasm: true,
};

const attributes = [
  { id: 'U', name: 'U (feed chemical)', type: 'float',
    description: 'Concentration of the fed chemical U. Starts at 1.0 everywhere.',
    isModelAttribute: false, defaultValue: '1.0' },
  { id: 'V', name: 'V (catalyst chemical)', type: 'float',
    description: 'Concentration of the autocatalytic chemical V. Starts at 0.0; the Seed brush sets it to 0.25.',
    isModelAttribute: false, defaultValue: '0.0' },
  { id: 'F', name: 'F (feed rate)', type: 'float',
    description: 'Feed rate - how fast U is replenished. Primary pattern knob.',
    isModelAttribute: true, defaultValue: '0.055', hasBounds: true, min: 0, max: 0.1 },
  { id: 'k', name: 'k (kill rate)', type: 'float',
    description: 'Kill rate - how fast V is removed. Primary pattern knob.',
    isModelAttribute: true, defaultValue: '0.062', hasBounds: true, min: 0, max: 0.1 },
  { id: 'Du', name: 'Du (U diffusion)', type: 'float',
    description: 'Diffusion coefficient for U. 1.0 in the canonical formulation.',
    isModelAttribute: true, defaultValue: '1.0', hasBounds: true, min: 0, max: 2 },
  { id: 'Dv', name: 'Dv (V diffusion)', type: 'float',
    description: 'Diffusion coefficient for V. 0.5 in the canonical formulation.',
    isModelAttribute: true, defaultValue: '0.5', hasBounds: true, min: 0, max: 2 },
  { id: 'dt', name: 'dt (time step)', type: 'float',
    description: 'Integration time step. 1.0 for the canonical formulation; lower it if the field blows up.',
    isModelAttribute: true, defaultValue: '1.0', hasBounds: true, min: 0.1, max: 2 },
];

const neighborhoods = [
  { id: 'ortho', name: 'Orthogonal (von Neumann)',
    description: 'The 4 edge-adjacent neighbors. Weight 0.2 each in the 9-point Laplacian.',
    coords: [[-1, 0], [1, 0], [0, -1], [0, 1]], margin: 1 },
  { id: 'diag', name: 'Diagonal (corners)',
    description: 'The 4 corner neighbors. Weight 0.05 each in the 9-point Laplacian.',
    coords: [[-1, -1], [-1, 1], [1, -1], [1, 1]], margin: 1 },
];

const mappings = [
  { id: 'seed', name: 'Seed', isAttributeToColor: false,
    description: 'Paint to seed a reaction blob: sets U=0.5 and V=0.25 on painted cells. Painted color is ignored.',
    redDescription: 'Ignored', greenDescription: 'Ignored', blueDescription: 'Ignored' },
  { id: 'vConc', name: 'V Concentration', isAttributeToColor: true,
    description: 'Visualizes the V field as a black -> white grayscale ramp (V in [0, 0.4]).',
    redDescription: 'V concentration (grayscale)',
    greenDescription: 'V concentration (grayscale)',
    blueDescription: 'V concentration (grayscale)' },
];

// Famous Gray-Scott regimes (9-point, Du=1.0, Dv=0.5, dt=1.0). F/k tuned in-browser.
const createdAt = Date.now();
function preset(name, description, F, k) {
  return {
    id: newId('preset'),
    name,
    description,
    state: { schemaVersion: 2, modelAttrs: { F, k, Du: 1.0, Dv: 0.5, dt: 1.0 } },
    createdAt,
  };
}
// Ordered by ascending F — a tour through parameter space. All five verified
// in-browser (3000 gens from a solid seed): each is alive, bounded, NaN-free,
// and visually distinct.
const presets = [
  preset('Spots', 'Stable isolated spots on a uniform background.', 0.03, 0.062),
  preset('Mitosis', 'Spots that grow and split, endlessly dividing like cells.', 0.0367, 0.0649),
  preset('Worms', 'Fine reticulated worm-like filaments.', 0.046, 0.062),
  preset('Coral / Maze', 'Branching coral-like growth that fills the grid with maze walls.', 0.0545, 0.062),
  preset('Solitons', 'Dense "u-skate" regime with self-sustaining travelling pulses.', 0.062, 0.0609),
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
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(model, null, 2) + '\n', 'utf-8');
console.log(
  `Wrote ${OUT}\n  ${graphNodes.length} nodes, ${graphEdges.length} edges, ` +
  `${attributes.length} attributes, ${neighborhoods.length} neighborhoods, ` +
  `${mappings.length} mappings, ${presets.length} presets`,
);

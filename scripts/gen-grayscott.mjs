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
 * Each of the five equations above maps to a single `expression` node, so the
 * step graph is 23 nodes / 28 edges (vs. 45 / 53 when the arithmetic was wired
 * one operator per node — 24 `arithmeticOperator` nodes). The data reads and the
 * neighbour gather+sum pairs are still discrete nodes — an expression's inputs
 * are scalars, so the Laplacian sums are computed up front. The expressions'
 * association order deliberately reproduces the old operator chain exactly, so
 * the emitted arithmetic is bit-identical on every compile target.
 *
 * The V viewer is a LINKED Attribute→Color mapping (V over [0, 0.4] through a
 * magma-like 5-stop gradient) — the colour pass is synthesized by the compiler,
 * so there is no hand-built output-mapping subgraph here.
 *
 * Built programmatically rather than hand-typed as JSON. Re-run after any tweak:
 * `node scripts/gen-grayscott.mjs`.
 *
 * Re-running preserves the enrichment that lives in the output file but is
 * authored in-app: the saved simulationState, the library thumbnail, the
 * long-form ruleDescription, and each preset's id + createdAt (matched by name,
 * so preset CONTENT stays owned by this script while the file stops churning).
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
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

/** Create an `expression` node. `varNames` are the user-facing names for the
 *  input ports, in port order — port `a` = varNames[0], `b` = varNames[1], …
 *  so callers wire with `vEdge(src, srcPort, exprNode, 'a' | 'b' | …)`.
 *  `label` is the theory-facing name shown above the node header (`data.label`,
 *  the same per-node label macros use — it round-trips through save/load). */
const PORT_IDS = 'abcdefgh';
function exprNode(expression, varNames, col, row, label) {
  const config = { expression, visibleCount: varNames.length };
  varNames.forEach((nm, i) => { config[`_varName_${PORT_IDS[i]}`] = nm; });
  const n = node('expression', config, col, row);
  if (label) n.data.label = label;
  return n;
}

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

// --- Laplacians: 0.2*orthoSum + 0.05*diagSum - centre (9-point weighted) -----
// Each Laplacian is one expression node. Its scalar inputs come from the
// neighbour sums (an expression can't reduce an array itself) and the centre.
const lapU = exprNode('0.2*orthoSum + 0.05*diagSum - u', ['orthoSum', 'diagSum', 'u'], 2, 11,
  'U diffusion (∇²U)');
vEdge(orthoUsum, 'result', lapU, 'a');
vEdge(diagUsum,  'result', lapU, 'b');
vEdge(uRead,     'value',  lapU, 'c');

const lapV = exprNode('0.2*orthoSum + 0.05*diagSum - v', ['orthoSum', 'diagSum', 'v'], 2, 13,
  'V diffusion (∇²V)');
vEdge(orthoVsum, 'result', lapV, 'a');
vEdge(diagVsum,  'result', lapV, 'b');
vEdge(vRead,     'value',  lapV, 'c');

// --- shared autocatalytic reaction term: uvv = U * V * V --------------------
const uvv = exprNode('u * (v * v)', ['u', 'v'], 2, 2, 'Reaction (U·V²)');
vEdge(uRead, 'value', uvv, 'a');
vEdge(vRead, 'value', uvv, 'b');

// --- U' = U + (Du*lapU - uvv + F*(1-U)) * dt ---------------------------------
const uNext = exprNode(
  'u + (Du*lapU - uvv + F*(1 - u)) * dt',
  ['u', 'Du', 'lapU', 'uvv', 'F', 'dt'], 3, 4,
  'U update (U′)',
);
vEdge(uRead,  'value',  uNext, 'a');
vEdge(Duattr, 'value',  uNext, 'b');
vEdge(lapU,   'result', uNext, 'c');
vEdge(uvv,    'result', uNext, 'd');
vEdge(Fattr,  'value',  uNext, 'e');
vEdge(dtattr, 'value',  uNext, 'f');

// --- V' = V + (Dv*lapV + uvv - (F+k)*V) * dt ---------------------------------
const vNext = exprNode(
  'v + (Dv*lapV + uvv - (F + k)*v) * dt',
  ['v', 'Dv', 'lapV', 'uvv', 'F', 'k', 'dt'], 3, 9,
  'V update (V′)',
);
vEdge(vRead,  'value',  vNext, 'a');
vEdge(Dvattr, 'value',  vNext, 'b');
vEdge(lapV,   'result', vNext, 'c');
vEdge(uvv,    'result', vNext, 'd');
vEdge(Fattr,  'value',  vNext, 'e');
vEdge(kattr,  'value',  vNext, 'f');
vEdge(dtattr, 'value',  vNext, 'g');

// --- writes ------------------------------------------------------------------
const writeU = node('setAttribute', { attributeId: 'U' }, 4, 4);
const writeV = node('setAttribute', { attributeId: 'V' }, 4, 9);
fEdge(stepNode, 'do', writeU, 'do');
fEdge(stepNode, 'do', writeV, 'do');
vEdge(uNext, 'result', writeU, 'value');
vEdge(vNext, 'result', writeV, 'value');

// =============================================================================
// D. SEED INPUT-MAPPING GRAPH — paint sets U=0.5, V=0.25
// =============================================================================

const seedInput  = node('inputColor', { mappingId: 'seed' }, 0, 18);
const seedWriteU = node('setAttribute', { attributeId: 'U', _port_value: '0.5'  }, 1, 18);
const seedWriteV = node('setAttribute', { attributeId: 'V', _port_value: '0.25' }, 1, 19);
fEdge(seedInput, 'do', seedWriteU, 'do');
fEdge(seedInput, 'do', seedWriteV, 'do');

// NB there is no V output-mapping SUBGRAPH: the `vConc` mapping is LINKED (see
// `mappings` below), so `injectLinkedOutputMappings` synthesizes the colour pass
// at compile time. (The hand-built version used `colorInterpolation` +
// `setColorViewer`, both since retired from the registry.)

// =============================================================================
// B. NON-GRAPH MODEL PARTS
// =============================================================================

const properties = {
  // Authored creation date — the Models Library card stamp + Newest/Oldest sort.
  createdDate: '2026-05-14',
  name: 'Gray-Scott Reaction-Diffusion',
  author: 'Peter Gray & Stephen K. Scott (1983); 9-point CA form per Karl Sims',
  modelAuthor: 'Rodrigo F. Figueiredo',
  // Short Summary — the ONLY presentation text shown on a Models Library card.
  // The long-form explanation lives in `properties.ruleDescription`, which is
  // authored in-app and carried across a regenerate by the preserve tail below.
  description: 'A two-chemical reaction-diffusion system (Gray-Scott, 1983).',
  topology: '2d-grid',
  boundaryTreatment: 'torus',
  updateMode: 'synchronous',
  asyncScheme: 'random-order',
  gridWidth: 300,
  gridHeight: 300,
  maxIterations: 100000,
  tags: ['reaction-diffusion', 'continuous', 'pattern-formation', 'chemistry', 'Gray-Scott'],
  useWasm: false,
  useWebGPU: true,
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
    coords: [[-1, 0], [1, 0], [0, -1], [0, 1]], margin: 1, includeCentralCell: false },
  { id: 'diag', name: 'Diagonal (corners)',
    description: 'The 4 corner neighbors. Weight 0.05 each in the 9-point Laplacian.',
    coords: [[-1, -1], [-1, 1], [1, -1], [1, 1]], margin: 1, includeCentralCell: false },
];

const mappings = [
  { id: 'seed', name: 'Seed', isAttributeToColor: false,
    description: 'Paint to seed a reaction blob: sets U=0.5 and V=0.25 on painted cells. Painted color is ignored.',
    redDescription: 'Ignored', greenDescription: 'Ignored', blueDescription: 'Ignored' },
  // LINKED colour pass — the compiler synthesizes `getCellAttribute(V) ->
  // colorScale -> setCellLooks` from this config, so no output-mapping subgraph
  // is authored above. The 5-stop gradient is the magma-like ramp tuned in-app.
  { id: 'vConc', name: 'V Concentration', isAttributeToColor: true,
    description: 'Visualizes the V field as a black -> white grayscale ramp (V in [0, 0.4]).',
    redDescription: '', greenDescription: '', blueDescription: '',
    linked: true,
    linkedAttributeId: 'V',
    linkedColors: {
      gradient: [
        { position: 0.03389830508474576, r: 0,   g: 0,   b: 4 },
        { position: 0.25,                r: 81,  g: 18,  b: 124 },
        { position: 0.5,                 r: 183, g: 55,  b: 121 },
        { position: 0.8211864406779661,  r: 252, g: 137, b: 97 },
        { position: 1,                   r: 252, g: 253, b: 191 },
      ],
    },
    linkedMin: 0,
    linkedMax: 0.4 },
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
  variables: [],
};

mkdirSync(dirname(OUT), { recursive: true });

// Preserve enrichment data that lives in the output file but isn't produced by
// this script — the saved simulationState snapshot, the library thumbnail and
// the long-form ruleDescription are authored in-app after generation, so carry
// them across a regenerate. Preset ids + createdAt are carried too (matched by
// NAME): the preset CONTENT stays owned by this script, but a regenerate must
// not re-mint identifiers / timestamps the shipped file already carries.
// NB assign ruleDescription BEFORE thumbnail so the key order matches the file.
let preserved = '';
if (existsSync(OUT)) {
  try {
    const prev = JSON.parse(readFileSync(OUT, 'utf-8'));
    if (prev.simulationState) {
      model.simulationState = prev.simulationState;
      preserved += ' +simulationState';
    }
    if (prev.properties?.ruleDescription) {
      model.properties.ruleDescription = prev.properties.ruleDescription;
      preserved += ' +ruleDescription';
    }
    if (prev.properties?.thumbnail) {
      model.properties.thumbnail = prev.properties.thumbnail;
      preserved += ' +thumbnail';
    }
    const prevPresets = new Map((prev.presets ?? []).map((p) => [p.name, p]));
    let keptPresets = 0;
    for (const p of model.presets) {
      const old = prevPresets.get(p.name);
      if (!old) continue;
      if (old.id) p.id = old.id;
      if (old.createdAt != null) p.createdAt = old.createdAt;
      keptPresets++;
    }
    if (keptPresets) preserved += ` +${keptPresets} preset ids`;
  } catch { /* unreadable / older format — just write a fresh file */ }
}

writeFileSync(OUT, JSON.stringify(model, null, 2) + '\n', 'utf-8');
console.log(
  `Wrote ${OUT}\n  ${graphNodes.length} nodes, ${graphEdges.length} edges, ` +
  `${attributes.length} attributes, ${neighborhoods.length} neighborhoods, ` +
  `${mappings.length} mappings, ${presets.length} presets${preserved}`,
);

#!/usr/bin/env node
/**
 * Generates public/models/Life3D.gcaproj — a 3D Grid CA sample.
 *
 * 3D Life, Carter Bays' "5766" rule (survival on 5-7 live neighbours, birth on
 * exactly 6) over the 26-cell Moore-3D neighbourhood on a W×H×D torus. This is
 * the first model that exercises the 3D Grid CA engine end-to-end: a 3-tuple
 * `coords3d` neighbourhood, `total = W*H*D`, the per-cell `_layer` decode, and
 * the InitEvent `z` output (the seed fills a randomized slab of central layers).
 *
 * Built programmatically (mirrors gen-grayscott.mjs). Re-run after a tweak:
 *   node scripts/gen-life3d.mjs
 * Re-running preserves any saved simulationState + library thumbnail from the
 * existing output file.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../public/models/Life3D.gcaproj');

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

// --- grid dims ---------------------------------------------------------------
const W = 24, H = 24, D = 24;

// =============================================================================
// 26-cell Moore-3D neighbourhood. coords3d is the source of truth; coords is the
// SAME-LENGTH 2D projection the WASM/WebGPU 2D layouts still read (stride
// invariant: coords.length === coords3d.length).
// =============================================================================
const coords3d = [];
const coords2d = [];
for (let dl = -1; dl <= 1; dl++)
  for (let dr = -1; dr <= 1; dr++)
    for (let dc = -1; dc <= 1; dc++) {
      if (dl === 0 && dr === 0 && dc === 0) continue;
      coords3d.push([dr, dc, dl]);
      coords2d.push([dr, dc]);
    }

// =============================================================================
// C. STEP GRAPH — Bays 5766: survive on 5-7, born on exactly 6.
// =============================================================================
const stepNode = node('step', {}, 0, 0);

const aliveRead = node('getCellAttribute', { attributeId: 'alive' }, 0, 2);          // current state (bool)
const nbrGather = node('getNeighborsAttribute', { neighborhoodId: 'moore3d', attributeId: 'alive' }, 0, 4);
const countSum  = node('aggregate', { operation: 'sum' }, 1, 4);                     // live-neighbour count
vEdge(nbrGather, 'values', countSum, 'values');

// survival range [5,7] and birth == 6
const survRange = node('statement', { operation: 'between', lowOp: '>=', highOp: '<=', compareType: 'numerical', _port_y: '5', _port_y2: '7' }, 2, 3);
const bornEq    = node('statement', { operation: '==', compareType: 'numerical', _port_y: '6' }, 2, 5);
vEdge(countSum, 'result', survRange, 'x');
vEdge(countSum, 'result', bornEq, 'x');

// next = (alive AND inRange567) OR ((NOT alive) AND count==6)
const survives = node('logicOperator', { operation: 'AND' }, 3, 2);
vEdge(aliveRead, 'value', survives, 'a');
vEdge(survRange, 'result', survives, 'b');

const notAlive = node('logicOperator', { operation: 'NOT' }, 3, 5);
vEdge(aliveRead, 'value', notAlive, 'a');

const born = node('logicOperator', { operation: 'AND' }, 4, 5);
vEdge(notAlive, 'result', born, 'a');
vEdge(bornEq, 'result', born, 'b');

const nextState = node('logicOperator', { operation: 'OR' }, 5, 3);
vEdge(survives, 'result', nextState, 'a');
vEdge(born, 'result', nextState, 'b');

const writeAlive = node('setAttribute', { attributeId: 'alive' }, 6, 3);
fEdge(stepNode, 'do', writeAlive, 'do');
vEdge(nextState, 'result', writeAlive, 'value');

// =============================================================================
// INIT GRAPH — seed a randomized slab of central layers (uses InitEvent.z).
// alive = (z in [9,14]) AND random(p=0.32)
// =============================================================================
const initNode = node('initEvent', {}, 0, 9);
const slab = node('statement', { operation: 'between', lowOp: '>=', highOp: '<=', compareType: 'numerical', _port_y: '9', _port_y2: '14' }, 1, 9);
vEdge(initNode, 'z', slab, 'x');
const rnd = node('getRandom', { randomType: 'bool', _port_probability: '0.32' }, 1, 11);
const seed = node('logicOperator', { operation: 'AND' }, 2, 10);
vEdge(slab, 'result', seed, 'a');
vEdge(rnd, 'value', seed, 'b');
const writeSeed = node('setAttribute', { attributeId: 'alive' }, 3, 10);
fEdge(initNode, 'do', writeSeed, 'do');
vEdge(seed, 'result', writeSeed, 'value');

// =============================================================================
// OUTPUT MAPPING — explicit, so dead cells get alpha 0 (culled by the 3D
// voxel renderer) and live cells are opaque green. alpha = alive * 255.
// =============================================================================
const omNode = node('outputMapping', { mappingId: 'life' }, 0, 14);
const omAlive = node('getCellAttribute', { attributeId: 'alive' }, 0, 16);
const omAlpha = node('arithmeticOperator', { operation: '*', _port_y: '255' }, 1, 16); // alive * 255
vEdge(omAlive, 'value', omAlpha, 'x');
const looks = node('setCellLooks', {
  mappingId: 'life', useGlyph: false, setBackground: true, fallbackToGlyphColor: false,
  _port_r: '110', _port_g: '226', _port_b: '140',
}, 2, 15);
fEdge(omNode, 'do', looks, 'do');
vEdge(omAlpha, 'result', looks, 'a');

// =============================================================================
// B. NON-GRAPH MODEL PARTS
// =============================================================================
const properties = {
  name: 'Life3D',
  author: "Carter Bays (3D Life rule 5766)",
  modelAuthor: 'Rodrigo F. Figueiredo',
  description:
    "3D Game of Life on a 24x24x24 torus, Carter Bays' classic 5766 rule: a live " +
    'cell survives with 5-7 live neighbours (of 26), a dead cell is born with ' +
    'exactly 6. Reset seeds a randomized slab of central layers, then press Play ' +
    'to watch structures bloom and dissolve through the volume. Orbit the camera ' +
    'and pull the clip plane to see inside.',
  topology: '2d-grid',
  boundaryTreatment: 'torus',
  updateMode: 'synchronous',
  asyncScheme: 'random-order',
  gridWidth: W,
  gridHeight: H,
  gridDepth: D,
  dimension: '3d',
  maxIterations: 100000,
  tags: ['3D', 'Life', 'totalistic', 'Bays', 'voxel'],
  // 3D Grid CA: WASM (default target) — verified at JS↔WASM parity in PR5.
  useWasm: true,
};

const attributes = [
  { id: 'alive', name: 'Alive', type: 'bool',
    description: 'Whether the cell is alive (1) or dead (0).',
    isModelAttribute: false, defaultValue: 'false' },
];

const neighborhoods = [
  { id: 'moore3d', name: 'Moore 3D (26)',
    description: 'All 26 cells in the 3x3x3 cube around the centre (3D Moore neighbourhood).',
    coords: coords2d, coords3d, margin: 1,
    shape: { kind: 'moore', radius: 1 } },
];

const mappings = [
  { id: 'life', name: 'Alive / Dead', isAttributeToColor: true,
    description: 'Live cells opaque green; dead cells fully transparent (alpha 0) so the 3D voxel renderer culls them and you can see the structure.',
    redDescription: 'Green (live)', greenDescription: 'Green (live)', blueDescription: 'Green (live)' },
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
  topologyMode: { gridCells: true, agents: false },
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
  `${attributes.length} attributes, ${neighborhoods.length} neighborhoods (${coords3d.length}-cell 3D), ` +
  `${mappings.length} mappings, grid ${W}x${H}x${D}${preserved}`,
);

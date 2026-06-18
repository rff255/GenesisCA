#!/usr/bin/env node
/**
 * Generates public/models/Shift3D.gcaproj — a deterministic 3D Grid CA that
 * exercises the 3-axis NeighborIndex (offset) family end-to-end.
 *
 * Rule: every cell copies the `on` value of the cell ONE LAYER BELOW it
 * (offset (dr=0, dc=0, dl=-1), torus). So the seeded pattern rises through the
 * volume one layer per generation and wraps around — fully deterministic, so
 * JS / WASM / WebGPU must agree cell-for-cell. This is the canonical regression
 * for `neighborIndexFromOffset` (with the dl port) → `getNeighborAttributeByIndex`
 * on a 3D lattice, the inverse of the gated-only-in-2D world it used to live in.
 *
 * InitEvent seeds a hollow-box pattern on layer 0 only (so the rising sheet is
 * easy to see through the clip plane / culling).
 *
 * Built programmatically (mirrors gen-life3d.mjs). Re-run after a tweak:
 *   node scripts/gen-shift3d.mjs
 * Re-running preserves any saved simulationState + library thumbnail.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../public/models/Shift3D.gcaproj');

const usedIds = new Set();
function newId(prefix) {
  let id;
  do { id = prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); } while (usedIds.has(id));
  usedIds.add(id);
  return id;
}

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

const W = 16, H = 16, D = 16;

// =============================================================================
// STEP GRAPH — on = on(cell one layer below). NeighborIndex offset (0, 0, -1).
//   off = NeighborIndex(from Offset) dr=0 dc=0 dl=-1   (the new 3D dl port)
//   get = Get Neighbor Attr By Index (on) at that offset
//   set = setAttribute(on) = get
// =============================================================================
const stepNode = node('step', {}, 0, 0);
const off = node('neighborIndexFromOffset', { _port_dr: '0', _port_dc: '0', _port_dl: '-1' }, 0, 2);
const get = node('getNeighborAttributeByIndex', { attributeId: 'on' }, 1, 2);
vEdge(off, 'value', get, 'index');
const setOn = node('setAttribute', { attributeId: 'on' }, 2, 2);
fEdge(stepNode, 'do', setOn, 'do');
vEdge(get, 'value', setOn, 'value');

// =============================================================================
// INIT GRAPH — seed a hollow square ring on layer 0 only.
//   on = (z == 0) AND (x,y on the ring border of a centred 10x10 box)
// Using: onRing = (x in [3,12]) AND (y in [3,12]) AND ((x==3|x==12)|(y==3|y==12))
// Kept simple: full border test via four edge compares OR-ed.
// =============================================================================
const initNode = node('initEvent', {}, 0, 8);
const zIs0 = node('statement', { operation: '==', compareType: 'numerical', _port_y: '0' }, 1, 7);
vEdge(initNode, 'z', zIs0, 'x');
// x,y in [3,12]
const xIn = node('statement', { operation: 'between', lowOp: '>=', highOp: '<=', compareType: 'numerical', _port_y: '3', _port_y2: '12' }, 1, 9);
vEdge(initNode, 'x', xIn, 'x');
const yIn = node('statement', { operation: 'between', lowOp: '>=', highOp: '<=', compareType: 'numerical', _port_y: '3', _port_y2: '12' }, 1, 11);
vEdge(initNode, 'y', yIn, 'x');
const inBox = node('logicOperator', { operation: 'AND' }, 2, 10);
vEdge(xIn, 'result', inBox, 'a');
vEdge(yIn, 'result', inBox, 'b');
// border: x==3 OR x==12 OR y==3 OR y==12
const xEdgeLo = node('statement', { operation: '==', compareType: 'numerical', _port_y: '3' }, 2, 7);
vEdge(initNode, 'x', xEdgeLo, 'x');
const xEdgeHi = node('statement', { operation: '==', compareType: 'numerical', _port_y: '12' }, 2, 8);
vEdge(initNode, 'x', xEdgeHi, 'x');
const yEdgeLo = node('statement', { operation: '==', compareType: 'numerical', _port_y: '3' }, 2, 12);
vEdge(initNode, 'y', yEdgeLo, 'x');
const yEdgeHi = node('statement', { operation: '==', compareType: 'numerical', _port_y: '12' }, 2, 13);
vEdge(initNode, 'y', yEdgeHi, 'x');
const xEdge = node('logicOperator', { operation: 'OR' }, 3, 7);
vEdge(xEdgeLo, 'result', xEdge, 'a');
vEdge(xEdgeHi, 'result', xEdge, 'b');
const yEdge = node('logicOperator', { operation: 'OR' }, 3, 12);
vEdge(yEdgeLo, 'result', yEdge, 'a');
vEdge(yEdgeHi, 'result', yEdge, 'b');
const onBorder = node('logicOperator', { operation: 'OR' }, 4, 9);
vEdge(xEdge, 'result', onBorder, 'a');
vEdge(yEdge, 'result', onBorder, 'b');
const ringXY = node('logicOperator', { operation: 'AND' }, 5, 9);
vEdge(inBox, 'result', ringXY, 'a');
vEdge(onBorder, 'result', ringXY, 'b');
const seed = node('logicOperator', { operation: 'AND' }, 6, 8);
vEdge(zIs0, 'result', seed, 'a');
vEdge(ringXY, 'result', seed, 'b');
const writeSeed = node('setAttribute', { attributeId: 'on' }, 7, 8);
fEdge(initNode, 'do', writeSeed, 'do');
vEdge(seed, 'result', writeSeed, 'value');

// =============================================================================
// OUTPUT MAPPING — on → opaque cyan; off → transparent (culled by the renderer).
// =============================================================================
const omNode = node('outputMapping', { mappingId: 'view' }, 0, 16);
const omOn = node('getCellAttribute', { attributeId: 'on' }, 0, 18);
const omAlpha = node('arithmeticOperator', { operation: '*', _port_y: '255' }, 1, 18);
vEdge(omOn, 'value', omAlpha, 'x');
const looks = node('setCellLooks', {
  mappingId: 'view', useGlyph: false, setBackground: true, fallbackToGlyphColor: false,
  _port_r: '80', _port_g: '210', _port_b: '230',
}, 2, 17);
fEdge(omNode, 'do', looks, 'do');
vEdge(omAlpha, 'result', looks, 'a');

// =============================================================================
// MODEL PARTS
// =============================================================================
const properties = {
  name: 'Shift3D',
  author: 'GenesisCA (3D NeighborIndex demo)',
  modelAuthor: 'Rodrigo F. Figueiredo',
  description:
    'A 16x16x16 torus where every cell copies the value of the cell one layer ' +
    'below it — a seeded square ring rises through the volume one layer per ' +
    'generation and wraps around. The simplest demo of 3D NeighborIndex offsets: ' +
    'Neighbor Index (from Offset) with dr=0, dc=0, dl=-1 feeding Get Neighbor ' +
    'Attr By Index. Deterministic, so JS / WASM / WebGPU agree cell-for-cell.',
  topology: '2d-grid',
  boundaryTreatment: 'torus',
  updateMode: 'synchronous',
  asyncScheme: 'random-order',
  gridWidth: W, gridHeight: H, gridDepth: D,
  dimension: '3d',
  maxIterations: 100000,
  tags: ['3D', 'NeighborIndex', 'offset', 'demo', 'voxel'],
  useWasm: true,
};

const attributes = [
  { id: 'on', name: 'On', type: 'bool',
    description: 'Whether the cell is on (1) or off (0).',
    isModelAttribute: false, defaultValue: 'false' },
];

const neighborhoods = [];

const mappings = [
  { id: 'view', name: 'On / Off', isAttributeToColor: true,
    description: 'On cells opaque cyan; off cells transparent (alpha 0) so the voxel renderer culls them.',
    redDescription: 'Cyan (on)', greenDescription: 'Cyan (on)', blueDescription: 'Cyan (on)' },
];

const model = {
  schemaVersion: 2,
  properties, attributes, neighborhoods, mappings,
  indicators: [],
  graphNodes, graphEdges, macroDefs: [],
  topologyMode: { gridCells: true, agents: false },
};

mkdirSync(dirname(OUT), { recursive: true });

let preserved = '';
if (existsSync(OUT)) {
  try {
    const prev = JSON.parse(readFileSync(OUT, 'utf-8'));
    if (prev.simulationState) { model.simulationState = prev.simulationState; preserved += ' +simulationState'; }
    if (prev.properties?.thumbnail) { model.properties.thumbnail = prev.properties.thumbnail; preserved += ' +thumbnail'; }
  } catch { /* unreadable — write fresh */ }
}

writeFileSync(OUT, JSON.stringify(model, null, 2) + '\n', 'utf-8');
console.log(
  `Wrote ${OUT}\n  ${graphNodes.length} nodes, ${graphEdges.length} edges, ` +
  `${attributes.length} attributes, ${mappings.length} mappings, grid ${W}x${H}x${D}${preserved}`,
);

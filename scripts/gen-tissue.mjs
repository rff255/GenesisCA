#!/usr/bin/env node
/**
 * Generates public/models/Morphogenesis - Differential Tissue.gcaproj — a
 * Bond-Graph Agents developmental-tissue model showing AGENT SPECIALIZATION
 * (cells that divide differently by type / maturity / topology), not a uniform
 * ever-growing blob.
 *
 * Each cell carries a `maturity` (lineage depth). Division is ASYMMETRIC (the
 * Division Event): daughter 0 keeps the mother's maturity (self-renewal — a
 * persistent stem pool), daughter 1 advances to maturity+1 (differentiation).
 * A cell divides only while uncommitted (maturity < MAX) AND uncrowded
 * (Neighbour Density < cap — contact inhibition). So the tissue self-limits:
 * a stem niche (maturity 0) keeps proliferating at the growing edge, transit
 * cells form a graded shell, and terminally-mature cells stop. Colour encodes
 * the differentiation stage (Categorical Color on maturity).
 *
 * Demonstrates: differential division by maturity, contact inhibition by
 * topology, asymmetric inheritance, and a colour-coded fate map.
 *
 * Built programmatically (mirrors gen-boids.mjs). Re-run: node scripts/gen-tissue.mjs
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../public/models/Morphogenesis - Differential Tissue.gcaproj');

const usedIds = new Set();
function newId(p) { let id; do { id = p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); } while (usedIds.has(id)); usedIds.add(id); return id; }

const agentNodes = [], agentEdges = [];
function node(nodeType, config, col, row) {
  const n = { id: newId('a'), type: 'caNode', position: { x: col * 230, y: row * 95 }, data: { nodeType, config } };
  agentNodes.push(n); return n;
}
const edge = (s, sp, t, tp, c) => agentEdges.push({ id: newId('e'), source: s.id, target: t.id, sourceHandle: `output_${c}_${sp}`, targetHandle: `input_${c}_${tp}` });
const vEdge = (s, sp, t, tp) => edge(s, sp, t, tp, 'value');
const fEdge = (s, sp, t, tp) => edge(s, sp, t, tp, 'flow');

const MAX_MATURITY = 5;   // divisions stop at this lineage depth (terminal)
const DENSITY_CAP = 6;    // contact inhibition: no division when this crowded

// =============================================================================
// Behaviour graph: grow → colour by maturity → divide if (grown & uncrowded & uncommitted)
// =============================================================================
const bs = node('behaviourStep', {}, 0, 4);
const str = node('setTargetRadius', { _port_value: '3' }, 1, 4);
fEdge(bs, 'do', str, 'do');

// Colour the cell by its maturity (Categorical Color → Set Cell Looks, "current viewer").
const gMat = node('getCellAttribute', { attributeId: 'maturity' }, 1, 8);
const cc = node('categoricalColor', {
  count: 6,
  entry_0_r: '46',  entry_0_g: '170', entry_0_b: '95',   // 0 stem — green
  entry_1_r: '120', entry_1_g: '190', entry_1_b: '70',   // 1 — yellow-green
  entry_2_r: '205', entry_2_g: '205', entry_2_b: '55',   // 2 — yellow
  entry_3_r: '235', entry_3_g: '160', entry_3_b: '45',   // 3 — orange
  entry_4_r: '225', entry_4_g: '105', entry_4_b: '55',   // 4 — red-orange
  entry_5_r: '200', entry_5_g: '60',  entry_5_b: '60',   // 5 transit-late — red
  default_r: '150', default_g: '35',  default_b: '90',   // 6+ terminal — magenta
}, 2, 8);
vEdge(gMat, 'value', cc, 'index');
const sl = node('setCellLooks', { mappingId: '__current__', useGlyph: false, setBackground: true, fallbackToGlyphColor: false }, 3, 5);
vEdge(cc, 'r', sl, 'r'); vEdge(cc, 'g', sl, 'g'); vEdge(cc, 'b', sl, 'b');
fEdge(str, 'next', sl, 'do');

// Division gate: radius grown AND uncrowded AND maturity < MAX.
const cmpGrown = node('statement', { operation: '>=', _port_y: '2.9', compareType: 'numerical' }, 2, 0);
vEdge(bs, 'myRadius', cmpGrown, 'x');
const nd = node('neighbourDensity', {}, 2, 1.4);
const cmpRoom = node('statement', { operation: '<', _port_y: String(DENSITY_CAP), compareType: 'numerical' }, 3, 1.4);
vEdge(nd, 'value', cmpRoom, 'x');
const cmpYoung = node('statement', { operation: '<', _port_y: String(MAX_MATURITY + 1), compareType: 'numerical' }, 2, 2.6);
vEdge(gMat, 'value', cmpYoung, 'x');
const and1 = node('logicOperator', { operation: 'AND' }, 4, 0.7);
vEdge(cmpGrown, 'result', and1, 'a'); vEdge(cmpRoom, 'result', and1, 'b');
const and2 = node('logicOperator', { operation: 'AND' }, 5, 1.5);
vEdge(and1, 'result', and2, 'a'); vEdge(cmpYoung, 'result', and2, 'b');

const cond = node('conditional', {}, 6, 4);
vEdge(and2, 'result', cond, 'condition');
fEdge(sl, 'next', cond, 'check');
const div = node('divideAgent', { axisSource: 'tension', _port_asymmetry: '0.5' }, 7, 4);
fEdge(cond, 'then', div, 'do');

// =============================================================================
// Division Event: daughter 0 self-renews (keeps maturity); daughter 1 advances.
// =============================================================================
const de = node('divisionEvent', {}, 0, 14);
const gMatM = node('getCellAttribute', { attributeId: 'maturity' }, 1, 16);   // mother's (inherited) maturity
const exAdv = node('expression', { expression: 'a+1', visibleCount: 1 }, 2, 16);
vEdge(gMatM, 'value', exAdv, 'a');
const cmpNew = node('statement', { operation: '>=', _port_y: '1', compareType: 'numerical' }, 1, 13);  // daughterIndex >= 1
vEdge(de, 'daughterIndex', cmpNew, 'x');
const condD = node('conditional', {}, 3, 14);
vEdge(cmpNew, 'result', condD, 'condition');
fEdge(de, 'do', condD, 'check');
const saMat = node('setAttribute', { attributeId: 'maturity' }, 4, 14);
vEdge(exAdv, 'result', saMat, 'value');
fEdge(condD, 'then', saMat, 'do');

// =============================================================================
// Model
// =============================================================================
const model = {
  schemaVersion: 1,
  properties: {
    name: 'Morphogenesis — Differential Tissue',
    description: 'Developmental tissue with agent specialization: asymmetric division (self-renewal + differentiation), contact inhibition, and a colour-coded maturity gradient — a self-limiting tissue, not a uniform blob.',
    ruleDescription: 'Each cell has a maturity (lineage depth). Division is asymmetric (Division Event): daughter 0 keeps the mother maturity (self-renewal), daughter 1 advances. A cell divides only while grown, uncrowded (Neighbour Density cap — contact inhibition) and uncommitted (maturity < ' + MAX_MATURITY + '). A persistent stem pool proliferates at the edge; cells differentiate inward; terminal cells stop. Colour = maturity stage.',
    author: '', projectAuthor: '', tags: ['agents', 'morphogenesis', 'differentiation', 'stem cells', 'tissue'],
    dimension: '2d', gridWidth: 90, gridHeight: 90, gridDepth: 1,
    topology: '2d-grid', boundaryTreatment: 'constant',
    useWasm: false, useWebGPU: false,
  },
  topologyMode: { gridCells: true, agents: true },
  centerBased: {
    enabled: true, maxAgents: 2200, maxBonds: 6, worldWidth: 90, worldHeight: 90,
    seedCount: 5, defaultRadius: 1.6, growthRate: 0.04,
    repulsionStiffness: 2.5, adhesionStiffness: 0.4, interactionRange: 1.5, drag: 1.0, timeStep: 0.1,
    momentum: 0, maxSpeed: 0, neighbourQueryRadius: 5, customForcesOnly: false,
    autoBond: true, bondStiffness: 1.0, bondRestLength: 2.0, formDistance: 1.2, breakDistance: 2.2,
  },
  attributes: [
    { id: 'maturity', name: 'maturity', type: 'integer', description: 'Lineage depth / differentiation stage (0 = stem).', defaultValue: '0', hasRange: true, min: 0, max: 8 },
  ],
  modelAttributes: [],
  neighborhoods: [],
  mappings: [],
  variables: [],
  indicators: [],
  graphNodes: [{ id: newId('n'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: 'step', config: {} } }],
  graphEdges: [],
  agentGraphNodes: agentNodes,
  agentGraphEdges: agentEdges,
  macroDefs: [],
};

if (existsSync(OUT)) {
  try {
    const prev = JSON.parse(readFileSync(OUT, 'utf8'));
    if (prev.properties?.thumbnail) model.properties.thumbnail = prev.properties.thumbnail;
    if (prev.simulationState) model.simulationState = prev.simulationState;
  } catch { /* ignore */ }
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(model, null, 2));
console.log(`Wrote ${OUT}\n  agent nodes: ${agentNodes.length}, edges: ${agentEdges.length}`);

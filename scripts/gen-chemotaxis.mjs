#!/usr/bin/env node
/**
 * Generates public/models/Chemotaxis - Aggregation.gcaproj — a Bond-Graph
 * Agents CLOSED-FEEDBACK model (Keller-Segel / slime-mould aggregation) that
 * exercises the agent<->grid FIELD BRIDGE and the WASM-decoupled cell field:
 *
 *   - The CELL CA is a morphogen field: a `chemical` attribute that diffuses +
 *     decays each generation (Get Neighbors -> Aggregate average -> Set
 *     Attribute). Runs on WASM (useWasm) — the field diffusion takes the fast
 *     path while the agents stay JS (the decoupled target).
 *   - The AGENTS secrete into the field (Secrete To Field), sense its gradient
 *     (Field Gradient), and climb it (Apply Force) — chemotaxis. Diffusion turns
 *     each cluster's combined secretion into a peak, so more agents climb in:
 *     positive feedback -> spontaneous aggregation into spots/streams.
 *
 * The field is shown as a heat-map (a Linked Output Mapping on `chemical`); the
 * agents draw as circles on top. Built programmatically (mirrors gen-boids.mjs).
 * Re-run: node scripts/gen-chemotaxis.mjs
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../public/models/Chemotaxis - Aggregation.gcaproj');

const usedIds = new Set();
function newId(p) { let id; do { id = p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); } while (usedIds.has(id)); usedIds.add(id); return id; }

// --- cell graph (the diffusing field) ---
const cellNodes = [], cellEdges = [];
function cnode(nodeType, config, col, row) { const n = { id: newId('n'), type: 'caNode', position: { x: col*230, y: row*95 }, data: { nodeType, config } }; cellNodes.push(n); return n; }
// --- agent graph (chemotaxis) ---
const agentNodes = [], agentEdges = [];
function anode(nodeType, config, col, row) { const n = { id: newId('a'), type: 'caNode', position: { x: col*230, y: row*95 }, data: { nodeType, config } }; agentNodes.push(n); return n; }
const mkEdge = (arr) => (s, sp, t, tp, c) => arr.push({ id: newId('e'), source: s.id, target: t.id, sourceHandle: `output_${c}_${sp}`, targetHandle: `input_${c}_${tp}` });
const cE = mkEdge(cellEdges), aE = mkEdge(agentEdges);
const cV = (s,sp,t,tp)=>cE(s,sp,t,tp,'value'), cF = (s,sp,t,tp)=>cE(s,sp,t,tp,'flow');
const aV = (s,sp,t,tp)=>aE(s,sp,t,tp,'value'), aF = (s,sp,t,tp)=>aE(s,sp,t,tp,'flow');

// --- Moore neighbourhood (8 cells) ---
const mooreId = newId('nb');
const mooreCoords = [];
for (let dr=-1; dr<=1; dr++) for (let dc=-1; dc<=1; dc++) if (dr||dc) mooreCoords.push([dr,dc]);
const neighborhoods = [{ id: mooreId, name: 'Moore', description: '8 surrounding cells', coords: mooreCoords, includeCentralCell: false }];

// Diffusion length sqrt(DIFFUSE/(1-DECAY)) ~ 5 cells must reach across the
// inter-agent spacing so agents sense NEIGHBOURS' peaks (not just their own
// self-peak, whose gradient at the agent is ~0). 0.24/(1-0.99) -> length ~5.
const DIFFUSE = 0.24, DECAY = 0.99;

// =============================================================================
// Cell field: chemical' = (chemical + DIFFUSE*(avgNeighbour - chemical)) * DECAY
// =============================================================================
const step = cnode('step', {}, 0, 1);
const cGet = cnode('getCellAttribute', { attributeId: 'chemical' }, 1, 0);
const cNbr = cnode('getNeighborsAttribute', { neighborhoodId: mooreId, attributeId: 'chemical' }, 1, 2);
const cAvg = cnode('aggregate', { operation: 'average' }, 2, 2);
cV(cNbr, 'values', cAvg, 'values');
const cEx = cnode('expression', { expression: `(a + ${DIFFUSE}*(b-a))*${DECAY}`, visibleCount: 2 }, 3, 1);
cV(cGet, 'value', cEx, 'a'); cV(cAvg, 'result', cEx, 'b');
const cSet = cnode('setAttribute', { attributeId: 'chemical' }, 4, 1);
cV(cEx, 'result', cSet, 'value');
cF(step, 'do', cSet, 'do');

// =============================================================================
// Agents: secrete -> climb gradient -> wander
// =============================================================================
const bs = anode('behaviourStep', {}, 0, 2);
const sec = anode('secreteToField', { attributeId: 'chemical', _port_rate: '1.0' }, 1, 2);
aF(bs, 'do', sec, 'do');
const fg = anode('fieldGradient', { attributeId: 'chemical' }, 1, 4);
const KCHEM = 32;
const gx = anode('expression', { expression: `a*${KCHEM}`, visibleCount: 1 }, 2, 3.5);
aV(fg, 'dx', gx, 'a');
const gy = anode('expression', { expression: `a*${KCHEM}`, visibleCount: 1 }, 2, 4.5);
aV(fg, 'dy', gy, 'a');
const af = anode('applyForce', {}, 3, 3);
aV(gx, 'result', af, 'fx'); aV(gy, 'result', af, 'fy');
aF(sec, 'next', af, 'do');
// wander
const r1 = anode('getRandom', { mode: 'float' }, 2, 6), r2 = anode('getRandom', { mode: 'float' }, 2, 7);
const wx = anode('expression', { expression: '(a-0.5)*0.06', visibleCount: 1 }, 3, 6); aV(r1, 'value', wx, 'a');
const wy = anode('expression', { expression: '(a-0.5)*0.06', visibleCount: 1 }, 3, 7); aV(r2, 'value', wy, 'a');
const afW = anode('applyForce', {}, 4, 6); aV(wx, 'result', afW, 'fx'); aV(wy, 'result', afW, 'fy');
aF(af, 'next', afW, 'do');

// =============================================================================
// Model
// =============================================================================
const chemMappingId = newId('map');
const model = {
  schemaVersion: 1,
  properties: {
    name: 'Chemotaxis — Aggregation',
    description: 'Slime-mould / Keller-Segel aggregation: agents secrete a chemical into the grid (the field), it diffuses (WASM cell CA), and agents climb its gradient — spontaneous aggregation into spots. Showcases the agent↔grid feedback + the WASM-decoupled field.',
    ruleDescription: 'The cell CA diffuses + decays a `chemical` field each generation (runs on WASM). Each agent secretes into the field (Secrete To Field), reads the local gradient (Field Gradient) and applies a force up it (Apply Force) + a little wander; engine repulsion keeps cells apart. Diffusion makes a cluster a chemical peak, recruiting more agents — positive feedback drives aggregation.',
    author: '', projectAuthor: '', tags: ['agents', 'chemotaxis', 'aggregation', 'slime mould', 'keller-segel', 'field'],
    dimension: '2d', gridWidth: 100, gridHeight: 100, gridDepth: 1,
    topology: '2d-grid', boundaryTreatment: 'torus',
    useWasm: true, useWebGPU: false,   // the field diffusion takes the WASM fast path; agents stay JS
  },
  topologyMode: { gridCells: true, agents: true },
  centerBased: {
    enabled: true, maxAgents: 500, maxBonds: 2, worldWidth: 100, worldHeight: 100,
    seedCount: 220, seedPattern: 'scatter', defaultRadius: 1.0, growthRate: 0,
    repulsionStiffness: 1.2, adhesionStiffness: 0, interactionRange: 1.4, drag: 1.0, timeStep: 0.25,
    momentum: 0.7, maxSpeed: 1.0, neighbourQueryRadius: 5, customForcesOnly: false,
    autoBond: false, bondStiffness: 0.4, bondRestLength: 2.0, formDistance: 1.2, breakDistance: 2.0,
  },
  attributes: [
    { id: 'chemical', name: 'chemical', type: 'float', description: 'Diffusing chemoattractant secreted by the agents.', defaultValue: '0' },
  ],
  modelAttributes: [],
  neighborhoods,
  mappings: [
    { id: chemMappingId, name: 'Chemical', description: 'Heat-map of the chemoattractant field.', isAttributeToColor: true,
      linked: true, linkedAttributeId: 'chemical', linkedMin: 0, linkedMax: 6 },
  ],
  variables: [],
  indicators: [],
  graphNodes: cellNodes,
  graphEdges: cellEdges,
  agentGraphNodes: agentNodes,
  agentGraphEdges: agentEdges,
  macroDefs: [],
};

if (existsSync(OUT)) {
  try { const prev = JSON.parse(readFileSync(OUT, 'utf8'));
    if (prev.properties?.thumbnail) model.properties.thumbnail = prev.properties.thumbnail;
    if (prev.simulationState) model.simulationState = prev.simulationState;
  } catch { /* ignore */ }
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(model, null, 2));
console.log(`Wrote ${OUT}\n  cell nodes: ${cellNodes.length}, agent nodes: ${agentNodes.length}`);

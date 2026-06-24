#!/usr/bin/env node
/**
 * Generates public/models/Game of Life on Agents.gcaproj — the GENERICITY PROOF
 * of the Generic Agent Platform: a classic totalistic cellular automaton (Conway's
 * Game of Life) running on a grid of AGENTS instead of lattice cells.
 *
 * It exercises the whole new agent stack end-to-end:
 *   - Agent Init Event + Create Agent / Add Agent To World → spawn an exact W×H
 *     grid of static agents (positions from a Loop counter variable).
 *   - Get Nearby Agents (radius 1.5 → the 8 Moore neighbours at unit spacing).
 *   - Get Agents Attribute (the keystone gather) → the neighbours' `alive` values.
 *   - Aggregate (sum) → the live-neighbour count (alive is 0/1).
 *   - Compare + Logic → the GoL rule (born on 3, survive on 2-3).
 *   - SYNC agent update (read previous, write next) → simultaneous update.
 *   - customForcesOnly + momentum 0 + no force → the agents stay put (a static grid).
 *
 * Re-run: node scripts/gen-gol-agents.mjs   (preserves thumbnail/simulationState)
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../public/models/Game of Life on Agents.gcaproj');

let c = 0;
const newId = (p) => p + (c++).toString(36) + Math.random().toString(36).slice(2, 6);
const an = [], ae = [];
const node = (nodeType, config, col, row) => { const n = { id: newId('a'), type: 'caNode', position: { x: col * 220, y: row * 90 }, data: { nodeType, config: config || {} } }; an.push(n); return n; };
const E = (s, sp, t, tp, cat) => ae.push({ id: newId('e'), source: s.id, target: t.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
const vE = (s, sp, t, tp) => E(s, sp, t, tp, 'value');
const fE = (s, sp, t, tp) => E(s, sp, t, tp, 'flow');

const W = 32, H = 32;

// ===== Agent Init Event: spawn a W×H grid via a counter variable =====
const ai = node('agentInit', {}, 0, 0);
const loop = node('loop', { _port_count: String(W * H) }, 1, 0);
fE(ai, 'do', loop, 'do');
const gi = node('getVariable', { variableId: 'i' }, 2, -1.5);
const exX = node('expression', { expression: '(a % ' + W + ') + 0.5', visibleCount: 1 }, 3, -2);
vE(gi, 'value', exX, 'a');
const exY = node('expression', { expression: 'floor(a / ' + W + ') + 0.5', visibleCount: 1 }, 3, -1);
vE(gi, 'value', exY, 'a');
const ca = node('createAgent', { _port_radius: '0.45', _port_type: '0' }, 4, 0);
vE(exX, 'result', ca, 'x');
vE(exY, 'result', ca, 'y');
const rnd = node('getRandom', { randomType: 'bool', _port_probability: '0.30' }, 4, 1.5);
const saInit = node('setAgentAttribute', { attributeId: 'alive' }, 5, 0.5);
vE(ca, 'handle', saInit, 'agentId');
vE(rnd, 'value', saInit, 'value');
const aw = node('addAgentToWorld', {}, 6, 0);
vE(ca, 'handle', aw, 'handle');
const gi2 = node('getVariable', { variableId: 'i' }, 5, 2.5);
const inc = node('arithmeticOperator', { operation: 'add', _port_y: '1' }, 6, 2.5);
vE(gi2, 'value', inc, 'x');
const si = node('setVariable', { variableId: 'i' }, 7, 2.5);
vE(inc, 'result', si, 'value');
fE(loop, 'body', ca, 'do');
fE(ca, 'next', saInit, 'do');
fE(saInit, 'next', aw, 'do');
fE(aw, 'next', si, 'do');

// ===== Behaviour Step: the Game of Life rule (totalistic on the agent neighbourhood) =====
const bs = node('behaviourStep', {}, 0, 6);
const myAlive = node('getCellAttribute', { attributeId: 'alive' }, 1, 4.5);   // own state (agent attr)
const nb = node('getNearbyAgents', { _port_radius: '1.5' }, 1, 6);            // the 8 Moore neighbours
const gaa = node('getAgentsAttribute', { attributeId: 'alive' }, 2, 6);       // gather their alive flags
vE(nb, 'agents', gaa, 'agents');
const agg = node('aggregate', { operation: 'sum' }, 3, 6);                    // live-neighbour count
vE(gaa, 'values', agg, 'values');
// GoL: next = (count==3) OR (alive AND count==2)
const c3 = node('statement', { operation: '==', compareType: 'numerical', _port_y: '3' }, 4, 5);
vE(agg, 'result', c3, 'x');
const c2 = node('statement', { operation: '==', compareType: 'numerical', _port_y: '2' }, 4, 7);
vE(agg, 'result', c2, 'x');
const survive = node('logicOperator', { operation: 'AND' }, 5, 6.5);
vE(c2, 'result', survive, 'a');
vE(myAlive, 'value', survive, 'b');
const next = node('logicOperator', { operation: 'OR' }, 6, 6);
vE(c3, 'result', next, 'a');
vE(survive, 'result', next, 'b');
const saNext = node('setAttribute', { attributeId: 'alive' }, 7, 6);
vE(next, 'result', saNext, 'value');
// colour: dead = dark, alive = green
const cc = node('categoricalColor', { count: 2, entry_0_r: 22, entry_0_g: 24, entry_0_b: 34, entry_1_r: 90, entry_1_g: 225, entry_1_b: 140, default_r: 0, default_g: 0, default_b: 0 }, 8, 7.5);
vE(next, 'result', cc, 'index');
const scl = node('setCellLooks', { mappingId: '__current__' }, 9, 6.5);
vE(cc, 'r', scl, 'r'); vE(cc, 'g', scl, 'g'); vE(cc, 'b', scl, 'b');
fE(bs, 'do', saNext, 'do');
fE(saNext, 'next', scl, 'do');

const model = {
  schemaVersion: 1,
  properties: {
    name: 'Game of Life on Agents',
    description: "Conway's Game of Life running on a grid of AGENTS — the genericity proof of the agent platform. A totalistic CA rule via Get Nearby Agents → Get Agents Attribute → Aggregate, with the grid spawned by the Agent Init Event.",
    ruleDescription: 'Each static agent counts its live Moore neighbours (Get Nearby Agents within radius 1.5 → Get Agents Attribute(alive) → Aggregate sum) and applies the Game of Life rule (born on 3, survive on 2–3). The W×H grid is spawned in the Agent Init Event with Create Agent / Add Agent To World; agents are pinned (customForcesOnly + momentum 0) and updated synchronously.',
    author: 'Conway', modelAuthor: '', tags: ['agents', 'game-of-life', 'totalistic', 'genericity'],
    dimension: '2d', gridWidth: W, gridHeight: H, gridDepth: 1, topology: '2d-grid',
    boundaryTreatment: 'torus', updateMode: 'synchronous', asyncScheme: 'random-order',
    maxIterations: 0, useWasm: false, useWebGPU: false,
  },
  topologyMode: { gridCells: true, agents: true },
  centerBased: {
    enabled: true, maxAgents: W * H + 16, maxBonds: 2, worldWidth: W, worldHeight: H,
    seedCount: 0, seedPattern: 'scatter', defaultRadius: 0.45, growthRate: 0,
    repulsionStiffness: 0, adhesionStiffness: 0, interactionRange: 1.5, drag: 1.0, timeStep: 0.5,
    momentum: 0, maxSpeed: 0, neighbourQueryRadius: 2, customForcesOnly: true, autoBond: false,
    agentUpdateMode: 'sync',
  },
  attributes: [],
  agentAttributes: [{ id: 'alive', name: 'alive', type: 'bool', description: 'Game of Life cell state', isModelAttribute: false, defaultValue: 'false' }],
  neighborhoods: [],
  mappings: [{ id: 'viz', name: 'Life', description: 'Alive = green', isAttributeToColor: true, redDescription: '', greenDescription: '', blueDescription: '' }],
  variables: [],
  agentVariables: [{ id: 'i', name: 'i', description: 'spawn counter', kind: 'scalar', dataType: 'integer', initialValue: '0' }],
  indicators: [],
  graphNodes: [{ id: newId('n'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: 'step', config: {} } }],
  graphEdges: [],
  agentGraphNodes: an, agentGraphEdges: ae, macroDefs: [],
};

if (existsSync(OUT)) {
  try { const prev = JSON.parse(readFileSync(OUT, 'utf8'));
    if (prev.properties?.thumbnail) model.properties.thumbnail = prev.properties.thumbnail;
    if (prev.simulationState) model.simulationState = prev.simulationState;
  } catch { /* ignore */ }
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(model, null, 2));
console.log('Wrote ' + OUT + '  agent nodes: ' + an.length + ', edges: ' + ae.length);

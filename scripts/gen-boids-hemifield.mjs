#!/usr/bin/env node
/**
 * Generates public/models/Boids - Hemifield Vision.gcaproj — a Braitenberg-style
 * boids VARIANT that steers with the FOV SENSING nodes instead of averaging raw
 * neighbour positions. Where `Boids — Flocking` computes a cohesion/separation
 * VECTOR, this one computes a scalar TURN SIGNAL from left/right agent COUNTS
 * (Braitenberg vehicles 2/3) and applies it as a force perpendicular to the
 * heading — so the whole steering law is "which side is busier?".
 *
 * THREE FOV cones, each a different sensing role (and a different display
 * colour — the multi-cone `Show vision = All` demo):
 *
 *   1. Get Agents In View  (r 12, ±70°, CYAN)  → ALIGNMENT. The only array-
 *      producing FOV node: For Each In Array over the agents ahead, summing
 *      their velocities, then steering to match the mean (a classic boids rule,
 *      but restricted to what the agent can SEE).
 *   2. Sense Hemifield NEAR (r 4.5, ±110°, RED)   → SEPARATION. Turn AWAY from
 *      the busier side (a Braitenberg "coward": crossed excitatory wiring).
 *   3. Sense Hemifield FAR  (r 16,  ±55°,  GREEN) → COHESION. Turn TOWARD the
 *      busier side (an "aggressor": direct wiring).
 *
 * Turn force: with heading h = (vx, vy), the LEFT normal is (-vy, vx) — matching
 * Sense Hemifield's own side convention (`cross = hx·dy − hy·dx ≥ 0 ⇒ Left`).
 * So `turn = KFAR·(Lfar − Rfar) − KNEAR·(Lnear − Rnear)` pushed along that
 * normal turns toward the far crowd and away from the near one. Forward motion
 * is a self-propulsion term toward a cruise speed, plus a little wander (which
 * also kickstarts motion from the at-rest seed, where a zero heading makes every
 * cone omnidirectional and every turn force zero).
 *
 * Agents-only (no lattice), pure custom force (no engine collision/bonds/growth).
 * Built programmatically (mirrors gen-boids.mjs). Re-run:
 *   node scripts/gen-boids-hemifield.mjs
 * Re-running preserves any saved simulationState + library thumbnail.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../public/models/Boids - Hemifield Vision.gcaproj');

const usedIds = new Set();
function newId(prefix) {
  let id;
  do { id = prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); } while (usedIds.has(id));
  usedIds.add(id);
  return id;
}

// --- agent graph builders (write into agentGraphNodes/Edges) ------------------
const agentNodes = [];
const agentEdges = [];
function node(nodeType, config, col, row) {
  const n = { id: newId('a'), type: 'caNode', position: { x: col * 230, y: row * 95 }, data: { nodeType, config } };
  agentNodes.push(n);
  return n;
}
function edge(srcNode, srcPort, tgtNode, tgtPort, category) {
  agentEdges.push({ id: newId('e'), source: srcNode.id, target: tgtNode.id,
    sourceHandle: `output_${category}_${srcPort}`, targetHandle: `input_${category}_${tgtPort}` });
}
const vEdge = (s, sp, t, tp) => edge(s, sp, t, tp, 'value');
const fEdge = (s, sp, t, tp) => edge(s, sp, t, tp, 'flow');

// --- tuning ------------------------------------------------------------------
const R_VIEW = 12, A_VIEW = 70;     // alignment cone   (Get Agents In View)
const R_NEAR = 4.5, A_NEAR = 110;   // separation cone  (Sense Hemifield)
const R_FAR = 16, A_FAR = 55;       // cohesion cone    (Sense Hemifield)
const KFAR = 0.008;   // turn TOWARD the busier far side
const KNEAR = 0.070;  // turn AWAY from the busier near side (fewer, closer agents)
const KALI = 0.30;    // velocity matching over the in-view agents
const KPROP = 0.15, CRUISE = 0.75;  // self-propulsion toward a cruise speed
const WANDER = 0.045; // jitter — also the cold start from the at-rest seed

// --- Local Variables (per-agent alignment accumulators) ----------------------
const V = (id, name) => ({ id, name, description: '', kind: 'scalar', dataType: 'float', initialValue: '0' });
const variables = [V('cnt', 'in-view count'), V('sumVX', 'Σ in-view Vx'), V('sumVY', 'Σ in-view Vy')];

// =============================================================================
// Agent rule graph
// =============================================================================
const bs = node('behaviourStep', {}, 0, 4);

// --- 1. ALIGNMENT: the agents actually in the forward view cone --------------
const view = node('getAgentsInView', {
  _port_radius: String(R_VIEW), halfAngle: String(A_VIEW), headingSource: 'velocity',
  visionColor: '#50c8ff',
}, 1, 7);
const fe = node('forEachInArray', {}, 2, 4);
fEdge(bs, 'do', fe, 'do');
vEdge(view, 'agents', fe, 'array');

const gv = node('getVelocity', {}, 3, 6);
vEdge(fe, 'element', gv, 'agentId');

// Accumulator chain in the loop body: var = var + contribution.
let bodyRow = 4;
function accum(varId, srcNode, srcPort, inlineB) {
  const gvar = node('getVariable', { variableId: varId }, 4, bodyRow);
  const add = node('arithmeticOperator', { operation: 'add', ...(inlineB !== undefined ? { _port_y: inlineB } : {}) }, 5, bodyRow);
  vEdge(gvar, 'value', add, 'x');
  if (srcNode) vEdge(srcNode, srcPort, add, 'y');
  const sv = node('setVariable', { variableId: varId }, 6, bodyRow);
  vEdge(add, 'result', sv, 'value');
  bodyRow += 1.1;
  return sv;
}
const acCnt = accum('cnt', null, null, '1');
const acVX = accum('sumVX', gv, 'vx');
const acVY = accum('sumVY', gv, 'vy');
fEdge(fe, 'body', acCnt, 'do');
fEdge(acCnt, 'next', acVX, 'do');
fEdge(acVX, 'next', acVY, 'do');

// --- 2 + 3. the two hemifield sensors ---------------------------------------
const shNear = node('senseHemifield', {
  _port_radius: String(R_NEAR), halfAngle: String(A_NEAR), headingSource: 'velocity',
  visionColor: '#ff6464',
}, 7, 0);
const shFar = node('senseHemifield', {
  _port_radius: String(R_FAR), halfAngle: String(A_FAR), headingSource: 'velocity',
  visionColor: '#78e878',
}, 7, 1.4);

// turn = KFAR*(Lfar - Rfar) - KNEAR*(Lnear - Rnear)      a=Lf b=Rf c=Ln d=Rn
const exTurn = node('expression', {
  expression: `(a-b)*${KFAR} - (c-d)*${KNEAR}`, visibleCount: 4,
}, 8, 0.7);
vEdge(shFar, 'leftCount', exTurn, 'a');
vEdge(shFar, 'rightCount', exTurn, 'b');
vEdge(shNear, 'leftCount', exTurn, 'c');
vEdge(shNear, 'rightCount', exTurn, 'd');

// --- post-loop: own velocity + speed ----------------------------------------
const gvSelf = node('getVelocity', {}, 7, 3);
const exSpeed = node('expression', { expression: 'sqrt(a*a+b*b)', visibleCount: 2 }, 8, 3);
vEdge(gvSelf, 'vx', exSpeed, 'a');
vEdge(gvSelf, 'vy', exSpeed, 'b');

const gCnt = node('getVariable', { variableId: 'cnt' }, 7, 4.2);
const gVX = node('getVariable', { variableId: 'sumVX' }, 7, 5.2);
const gVY = node('getVariable', { variableId: 'sumVY' }, 7, 6.2);

// The steering force. LEFT normal of the heading (vx, vy) is (-vy, vx), so the
// turn term is  turn * (-vy, vx)/speed  — positive turn steers left, matching
// Sense Hemifield's own Left/Right convention. Then velocity-matching alignment
// (gated on having seen anyone) + self-propulsion toward CRUISE.
//   fx:  a=turn b=vy c=speed d=ΣVx e=count f=vx
//   fy:  a=turn b=vx c=speed d=ΣVy e=count f=vy   (note the +b, and b/f swap)
const ALI_PROP = ` + (d/max(e,1)-f)*${KALI}*min(e,1) + (${CRUISE}/max(c,0.001)-1)*f*${KPROP}`;
const exFX = node('expression', { expression: `a*(-b/max(c,0.001))${ALI_PROP}`, visibleCount: 6 }, 9, 2);
vEdge(exTurn, 'result', exFX, 'a');
vEdge(gvSelf, 'vy', exFX, 'b');
vEdge(exSpeed, 'result', exFX, 'c');
vEdge(gVX, 'value', exFX, 'd');
vEdge(gCnt, 'value', exFX, 'e');
vEdge(gvSelf, 'vx', exFX, 'f');

const exFY = node('expression', { expression: `a*(b/max(c,0.001))${ALI_PROP}`, visibleCount: 6 }, 9, 4);
vEdge(exTurn, 'result', exFY, 'a');
vEdge(gvSelf, 'vx', exFY, 'b');
vEdge(exSpeed, 'result', exFY, 'c');
vEdge(gVY, 'value', exFY, 'd');
vEdge(gCnt, 'value', exFY, 'e');
vEdge(gvSelf, 'vy', exFY, 'f');

const af = node('applyForce', {}, 10, 3);
vEdge(exFX, 'result', af, 'fx');
vEdge(exFY, 'result', af, 'fy');
fEdge(fe, 'next', af, 'do');

// --- wander (breaks symmetry, and kickstarts motion from the at-rest seed) ---
const r1 = node('getRandom', { mode: 'float' }, 9, 6);
const r2 = node('getRandom', { mode: 'float' }, 9, 7);
const exWX = node('expression', { expression: `(a-0.5)*${WANDER}`, visibleCount: 1 }, 10, 6);
vEdge(r1, 'value', exWX, 'a');
const exWY = node('expression', { expression: `(a-0.5)*${WANDER}`, visibleCount: 1 }, 10, 7);
vEdge(r2, 'value', exWY, 'a');
const afW = node('applyForce', {}, 11, 6.5);
vEdge(exWX, 'result', afW, 'fx');
vEdge(exWY, 'result', afW, 'fy');
fEdge(af, 'next', afW, 'do');

// =============================================================================
// Model assembly
// =============================================================================
const INSTRUCTIONS = [
  'Press Play. Every agent steers ONLY by comparing how many agents it sees on its left vs its right.',
  '',
  'To SEE what they see, set "Show vision" (right panel, Agents section) to All — three coloured cones are drawn on every agent:',
  '  • cyan  — the forward view cone whose agents it matches velocity with (alignment)',
  '  • red   — the wide near cone it turns AWAY from (separation)',
  '  • green — the narrow far cone it turns TOWARD (cohesion)',
  '',
  'Set it to Inspected instead to follow a single agent (hover / Shift+click one).',
  'Open the Modeler → Agents graph to retune the cones: each FOV node has a Radius input, a Half-angle, and its own Cone color.',
].join('\n');

const model = {
  schemaVersion: 1,
  properties: {
    // Authored creation date — the Models Library card stamp + Newest/Oldest sort.
    createdDate: '2026-07-28',
    name: 'Boids — Hemifield Vision',
    description: 'Braitenberg-style flocking: agents steer purely by how many neighbours they see on their LEFT vs RIGHT, through three differently-coloured vision cones.',
    ruleDescription: 'Two Sense Hemifield nodes give left/right agent counts in a wide NEAR cone and a narrow FAR cone. The turn signal KFAR*(Lfar-Rfar) - KNEAR*(Lnear-Rnear) is applied as a force along the heading’s left normal (-vy, vx), so an agent veers toward distant company and away from crowding. A Get Agents In View cone adds velocity matching over the agents actually ahead, and a self-propulsion term holds a cruise speed. No engine physics at all — collision, bonds and growth are off; the graph IS the whole rule.',
    instructions: INSTRUCTIONS,
    author: '', projectAuthor: '', tags: ['agents', 'flocking', 'boids', 'braitenberg', 'vision', 'emergence'],
    dimension: '2d', gridWidth: 120, gridHeight: 120, gridDepth: 1,
    topology: '2d-grid', boundaryTreatment: 'torus',
    useWasm: false, useWebGPU: false,
  },
  topologyMode: { gridCells: false, agents: true },
  centerBased: {
    enabled: true, agentTarget: 'webgpu', maxAgents: 600, maxBonds: 0,
    worldWidth: 120, worldHeight: 120,
    seedCount: 300, seedPattern: 'scatter', defaultRadius: 0.9, growthRate: 0,
    // Soft-sphere volume exclusion ONLY (no bonds, no springs, no growth, no
    // adhesion): the STEERING is 100% hemifield, the body just keeps agents from
    // sitting inside one another so a flock reads as distinct dots. Stiffness is
    // kept ≤ 0.4 so clampAgentDt leaves timeStep alone.
    repulsionStiffness: 0.4, adhesionStiffness: 0, interactionRange: 1.2, drag: 1.0, timeStep: 0.5,
    momentum: 0.9, maxSpeed: 1.1, neighbourQueryRadius: R_FAR, customForcesOnly: true,
    useBondingPhysics: false,
    autoBond: false, bondStiffness: 0.4, bondRestLength: 2.0, formDistance: 1.15, breakDistance: 1.8,
    agentCapabilities: {
      motion: 'force', body: true, collision: 'soft', bonds: 'off',
      autoBond: false, growth: false, division: false, lifespan: false,
      populationBirth: false, populationDeath: false,
      sensing: true, sensingHeadingSource: 'velocity', orientation: false,
      fieldCoupling: false, appearance: true,
    },
  },
  attributes: [],
  modelAttributes: [],
  neighborhoods: [],
  mappings: [],
  variables,
  indicators: [],
  graphNodes: [{ id: newId('n'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: 'step', config: {} } }],
  graphEdges: [],
  agentGraphNodes: agentNodes,
  agentGraphEdges: agentEdges,
  macroDefs: [],
};

// Preserve thumbnail / simulationState from any existing output.
if (existsSync(OUT)) {
  try {
    const prev = JSON.parse(readFileSync(OUT, 'utf8'));
    if (prev.properties?.thumbnail) model.properties.thumbnail = prev.properties.thumbnail;
    if (prev.simulationState) model.simulationState = prev.simulationState;
  } catch { /* ignore */ }
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(model, null, 2));
console.log(`Wrote ${OUT}\n  agent nodes: ${agentNodes.length}, edges: ${agentEdges.length}, variables: ${variables.length}`);

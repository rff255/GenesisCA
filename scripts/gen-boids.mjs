#!/usr/bin/env node
/**
 * Generates public/models/Boids - Flocking.gcaproj — a Bond-Graph Agents
 * FLOCKING model (Reynolds' boids) that exercises the agent NEIGHBOUR-ACCESS +
 * graph-authored-force primitives:
 *
 *   - Get Nearby Agents (radius) → the list of flock-mates within view.
 *   - For Each In Array → per-neighbour accumulation into Local Variables.
 *   - Get Agent Position / Get Velocity (of a neighbour) → cohesion + alignment.
 *   - Apply Force → the graph IS the physics (no engine soft-sphere here;
 *     customForcesOnly = true, momentum > 0 for inertia, maxSpeed caps cruise).
 *
 * The three classic rules: SEPARATION (steer away from close neighbours,
 * inverse-distance weighted), ALIGNMENT (match neighbours' average heading),
 * COHESION (steer toward the local centroid) + a little wander for liveliness.
 *
 * Built programmatically (mirrors gen-life3d.mjs). Re-run: node scripts/gen-boids.mjs
 * Re-running preserves any saved simulationState + library thumbnail.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../public/models/Boids - Flocking.gcaproj');

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

// --- Local Variables (per-agent neighbour accumulators) ----------------------
const V = (id, name) => ({ id, name, description: '', kind: 'scalar', dataType: 'float', initialValue: '0' });
const variables = [
  V('cnt', 'neighbours'), V('sumX', 'Σ neighbour X'), V('sumY', 'Σ neighbour Y'),
  V('sumVX', 'Σ neighbour Vx'), V('sumVY', 'Σ neighbour Vy'),
  V('sepX', 'Σ separation X'), V('sepY', 'Σ separation Y'),
];

// =============================================================================
// Agent rule graph
// =============================================================================
const bs = node('behaviourStep', {}, 0, 3);
const nb = node('getNearbyAgents', { _port_radius: '14' }, 1, 6);
const fe = node('forEachInArray', {}, 2, 3);
fEdge(bs, 'do', fe, 'do');
vEdge(nb, 'agents', fe, 'array');

// --- per-neighbour reads ---
// Torus-shortest displacement self→neighbour (dX, dY, Distance). Using the
// offset (NOT raw position subtraction) keeps cohesion/separation wrap-correct
// across the seam.
const go = node('getAgentOffset', {}, 3, 5);     // dX,dY,Distance self→neighbour
vEdge(fe, 'element', go, 'agentId');
const gv = node('getVelocity', {}, 3, 6.2);       // unchanged (alignment)
vEdge(fe, 'element', gv, 'agentId');

// Separation = −offset / (d² + 1)  (push AWAY, inverse-distance).  a=dX b=dY
const exSepX = node('expression', { expression: '-a/(a*a+b*b+1)', visibleCount: 2 }, 3, 7.4);
vEdge(go, 'dx', exSepX, 'a'); vEdge(go, 'dy', exSepX, 'b');
const exSepY = node('expression', { expression: '-b/(a*a+b*b+1)', visibleCount: 2 }, 3, 8.6);
vEdge(go, 'dx', exSepY, 'a'); vEdge(go, 'dy', exSepY, 'b');

// Accumulator chain in the loop body: var = var + contribution.
// accum(varId, srcNode, srcPort) → the setVariable node (chain its flow).
let bodyRow = 3;
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
const acSX = accum('sumX', go, 'dx');   // Σ (nbr − self) X   (offset, not raw position)
const acSY = accum('sumY', go, 'dy');   // Σ (nbr − self) Y
const acVX = accum('sumVX', gv, 'vx');  // unchanged
const acVY = accum('sumVY', gv, 'vy');  // unchanged
const acPX = accum('sepX', exSepX, 'result');
const acPY = accum('sepY', exSepY, 'result');
// body flow chain
fEdge(fe, 'body', acCnt, 'do');
fEdge(acCnt, 'next', acSX, 'do');
fEdge(acSX, 'next', acSY, 'do');
fEdge(acSY, 'next', acVX, 'do');
fEdge(acVX, 'next', acVY, 'do');
fEdge(acVY, 'next', acPX, 'do');
fEdge(acPX, 'next', acPY, 'do');

// --- post-loop: combine cohesion + alignment + separation into a force ---
// fx = ((sumX/n - myX)*kCoh + (sumVX/n)*kAli + sepX*kSep) * (n>0?1:0)
//   a=sumX b=cnt c=myX d=sumVX e=sepX
const gSumX = node('getVariable', { variableId: 'sumX' }, 7, 0);
const gSumY = node('getVariable', { variableId: 'sumY' }, 7, 1);
const gCnt = node('getVariable', { variableId: 'cnt' }, 7, 2);
const gVX = node('getVariable', { variableId: 'sumVX' }, 7, 3);
const gVY = node('getVariable', { variableId: 'sumVY' }, 7, 4);
const gSepX = node('getVariable', { variableId: 'sepX' }, 7, 5);
const gSepY = node('getVariable', { variableId: 'sepY' }, 7, 6);

// Own velocity + speed (for velocity-matching alignment + cruise propulsion).
const gvSelf = node('getVelocity', {}, 7, 7);   // self (no agentId)
const exSpeed = node('expression', { expression: 'sqrt(a*a+b*b)', visibleCount: 2 }, 8, 7);
vEdge(gvSelf, 'vx', exSpeed, 'a'); vEdge(gvSelf, 'vy', exSpeed, 'b');

// Force = cohesion (toward centroid) + alignment (match neighbours' mean
// velocity) + separation + self-propulsion toward a cruise speed.
// `sumX/n` is now the MEAN OFFSET to the local centroid (Σ of torus-correct
// (nbr−self) vectors / n), so cohesion needs NO myX subtraction.
//   a=Σoffset b=count d=Σvel e=Σsep f=myVel g=speed   (slot c stays unwired/0)
const KCOH = 0.005, KALI = 0.45, KSEP = 0.7, KPROP = 0.12, CRUISE = 0.7;
const FFORM2 = `((a/max(b,1))*${KCOH} + (d/max(b,1)-f)*${KALI} + e*${KSEP})*min(b,1)`
             + ` + (${CRUISE}/max(g,0.001)-1)*f*${KPROP}`;
const exFX = node('expression', { expression: FFORM2, visibleCount: 7 }, 8, 1.5);
vEdge(gSumX, 'value', exFX, 'a'); vEdge(gCnt, 'value', exFX, 'b');
vEdge(gVX, 'value', exFX, 'd'); vEdge(gSepX, 'value', exFX, 'e');
vEdge(gvSelf, 'vx', exFX, 'f'); vEdge(exSpeed, 'result', exFX, 'g');
// NOTE: the old `vEdge(bs, 'myX', exFX, 'c')` is REMOVED (cohesion no longer
// subtracts self). Slot `c` stays unwired→0; the formula does not reference it.
const exFY = node('expression', { expression: FFORM2, visibleCount: 7 }, 8, 3.5);
vEdge(gSumY, 'value', exFY, 'a'); vEdge(gCnt, 'value', exFY, 'b');
vEdge(gVY, 'value', exFY, 'd'); vEdge(gSepY, 'value', exFY, 'e');
vEdge(gvSelf, 'vy', exFY, 'f'); vEdge(exSpeed, 'result', exFY, 'g');

const af = node('applyForce', {}, 9, 2.5);
vEdge(exFX, 'result', af, 'fx');
vEdge(exFY, 'result', af, 'fy');
fEdge(fe, 'next', af, 'do');

// --- wander (a little random jitter, also kickstarts motion from rest) ---
const r1 = node('getRandom', { mode: 'float' }, 8, 5.5);
const r2 = node('getRandom', { mode: 'float' }, 8, 6.5);
const exWX = node('expression', { expression: '(a-0.5)*0.015', visibleCount: 1 }, 9, 5.5);
vEdge(r1, 'value', exWX, 'a');
const exWY = node('expression', { expression: '(a-0.5)*0.015', visibleCount: 1 }, 9, 6.5);
vEdge(r2, 'value', exWY, 'a');
const afW = node('applyForce', {}, 10, 6);
vEdge(exWX, 'result', afW, 'fx');
vEdge(exWY, 'result', afW, 'fy');
fEdge(af, 'next', afW, 'do');

// =============================================================================
// Model assembly
// =============================================================================
const model = {
  schemaVersion: 1,
  properties: {
    name: 'Boids — Flocking',
    description: 'Reynolds boids: separation + alignment + cohesion via Get Nearby Agents + Apply Force. Hundreds of agents flock with graph-authored forces (no engine repulsion).',
    ruleDescription: 'Each agent queries flock-mates within a radius (Get Nearby Agents), averages their position (cohesion) and velocity (alignment), sums inverse-distance away-vectors (separation), and steers with Apply Force. Motion is pure custom force (momentum gives inertia, maxSpeed caps the cruise).',
    author: '', projectAuthor: '', tags: ['agents', 'flocking', 'boids', 'emergence'],
    dimension: '2d', gridWidth: 120, gridHeight: 120, gridDepth: 1,
    topology: '2d-grid', boundaryTreatment: 'torus',
    useWasm: false, useWebGPU: false,
  },
  topologyMode: { gridCells: true, agents: true },
  centerBased: {
    enabled: true, agentTarget: 'webgpu', maxAgents: 600, maxBonds: 2, worldWidth: 120, worldHeight: 120,
    seedCount: 260, seedPattern: 'scatter', defaultRadius: 1.0, growthRate: 0,
    repulsionStiffness: 0, adhesionStiffness: 0, interactionRange: 1.5, drag: 1.0, timeStep: 0.5,
    momentum: 0.9, maxSpeed: 1.1, neighbourQueryRadius: 14, customForcesOnly: true,
    autoBond: false, bondStiffness: 0.4, bondRestLength: 2.0, formDistance: 1.15, breakDistance: 1.8,
  },
  attributes: [],            // boids carry no per-agent state; coloured by engine type palette
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

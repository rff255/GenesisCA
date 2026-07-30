#!/usr/bin/env node
/**
 * Generates public/models/Life on Bonds.gcaproj — the flagship P1 sample of the
 * Graph-Rewriting Automata milestone: Conway's Game of Life expressed as a
 * GRAPH rule (census → rule → state) instead of a lattice or proximity rule.
 *
 * The point of the model
 * ----------------------
 * A homogeneous rule on a graph cannot name its neighbours — there is no lattice
 * ordering and the degree varies — so it may only read an ORDER-INDEPENDENT,
 * DEGREE-TOLERANT aggregate: the multiset of neighbour states. That is exactly
 * what the Neighbour Census node emits (one integer port per state value). Here
 * the attribute is the bool `alive`, so the census has two ports (False / True)
 * plus Total, and the rule is the textbook `n == 3 || (alive && n == 2)`.
 *
 * The topology is a 32×32 torus lattice of agents BONDED to their 8 Moore
 * neighbours, so it reproduces Conway exactly — which makes it a differential
 * oracle against the shipped proximity-based `Game of Life on Agents` (same
 * neighbour set ⇒ identical state sequence; any divergence is a census bug).
 *
 * How the bonds are formed
 * ------------------------
 * By the engine's AUTO-BOND (Properties › Bond-Graph Agents), not by Form Bond:
 * Form Bond is ONE request per agent per step, so bonding 8 neighbours would take
 * 8 generations. With radius 0.45 the contact distance is 0.9, so a form
 * multiplier of 1.9 admits everything closer than 1.71 — the orthogonal
 * neighbours (1.0) and the diagonals (√2 ≈ 1.414) — and excludes the next ring
 * (2.0). The break multiplier 2.5 (→ 2.25) never fires because nothing moves.
 *
 * The one bootstrap subtlety
 * --------------------------
 * The structural phase (where auto-bond runs) executes at the END of a step, so
 * generation 1's behaviour still sees an EMPTY 1-ring. The rule is therefore
 * gated on the census's `Total > 0`: an isolated node keeps its state. That is
 * both the standard graph-automaton convention (a node with no 1-ring has no
 * rule to apply) and the device that makes generation 1 a pure topology
 * bootstrap — from generation 2 on, every agent has exactly 8 bonds forever and
 * the dynamics are pure Conway. So `Life on Bonds` at generation t+1 equals
 * `Game of Life on Agents` at generation t.
 *
 * Agents are pinned: bond stiffness 0 (so the springs the Bonds=Physics
 * capability enables apply zero force), no collision, no growth, momentum 0.
 * Update mode is SYNC — Conway is a synchronous automaton.
 *
 * Why the agent target is WASM, not WebGPU
 * ----------------------------------------
 * Both agent gates ACCEPT this model (the census lowers to already-supported node
 * types), and the census itself is exact on all three targets — verified in the
 * real worker: with `alive` frozen, JS, WASM and WebGPU produce byte-identical
 * per-agent counts matching an independent recount from the bond store.
 *
 * But `agentUpdateMode: 'sync'` is NOT honoured on the WebGPU agent target: the
 * behaviour shader reads neighbours' attributes out of the SAME `agentF32` region
 * it writes its own into, with no double buffer, so a neighbour may be read
 * before or after its own write depending on scheduling. Any synchronous,
 * neighbour-attribute-reading agent rule is therefore wrong there, and
 * NON-DETERMINISTICALLY so (measured: 14 or 18 of 1024 cells differ from Conway
 * run to run). This is PRE-EXISTING and not census-specific — the shipped
 * proximity-based `Game of Life on Agents`, which contains no census node, is
 * wrong by 18 cells on its own shipped WebGPU target too.
 *
 * This model is a differential ORACLE, so it must be exact: correctness outranks
 * the library's "WebGPU wherever the gate accepts" performance policy here. The
 * user can still select WebGPU (nothing is clamped) — we simply do not ship it
 * selected. Flip this back once the agent WebGPU sync path double-buffers.
 *
 * Re-run: node scripts/gen-life-on-bonds.mjs   (preserves thumbnail/simulationState)
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../public/models/Life on Bonds.gcaproj');

let c = 0;
const newId = (p) => p + (c++).toString(36) + Math.random().toString(36).slice(2, 6);
const an = [], ae = [];
const node = (nodeType, config, col, row) => { const n = { id: newId('a'), type: 'caNode', position: { x: col * 220, y: row * 90 }, data: { nodeType, config: config || {} } }; an.push(n); return n; };
const E = (s, sp, t, tp, cat) => ae.push({ id: newId('e'), source: s.id, target: t.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
const vE = (s, sp, t, tp) => E(s, sp, t, tp, 'value');
const fE = (s, sp, t, tp) => E(s, sp, t, tp, 'flow');

const W = 32, H = 32;

// ===== Agent Init Event =====
// Structurally IDENTICAL to gen-gol-agents.mjs (same node order, same single
// getRandom draw per agent, same spawn order) so that, seeded with the same RNG
// state, both models start from the SAME board in the SAME slot order — which is
// what makes the differential oracle a straight element-wise comparison.
const ai = node('agentInit', {}, 0, 0);
const loop = node('loop', { _port_count: String(W * H) }, 1, 0);
fE(ai, 'do', loop, 'do');
const gi = node('getVariable', { variableId: 'i' }, 2, -1.5);
const exX = node('expression', { expression: '(a % ' + W + ') + 0.5', visibleCount: 1 }, 3, -2);
vE(gi, 'value', exX, 'a');
const exY = node('expression', { expression: 'floor(a / ' + W + ') + 0.5', visibleCount: 1 }, 3, -1);
vE(gi, 'value', exY, 'a');
const ca = node('createAgent', { _port_radius: '0.45' }, 4, 0);
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

// ===== Behaviour Step: census → rule → state =====
const bs = node('behaviourStep', {}, 0, 6);
// ONE node for the whole neighbour multiset: `alive` is a bool, so the census
// has two count ports (False / True) plus Total. Only True + Total are wired,
// so the lowering synthesizes exactly one Count Matching (+ an Array Length).
const census = node('neighbourCensus', { attributeId: 'alive', source: 'bonded' }, 1, 6);
const myAlive = node('getCellAttribute', { attributeId: 'alive' }, 1, 4.5);
// Conway: next = (n == 3) OR (alive AND n == 2), where n = the True count.
const c3 = node('statement', { operation: '==', compareType: 'numerical', _port_y: '3' }, 3, 5);
vE(census, 'count_1', c3, 'x');
const c2 = node('statement', { operation: '==', compareType: 'numerical', _port_y: '2' }, 3, 7);
vE(census, 'count_1', c2, 'x');
const survive = node('logicOperator', { operation: 'AND' }, 4, 6.5);
vE(c2, 'result', survive, 'a');
vE(myAlive, 'value', survive, 'b');
const next = node('logicOperator', { operation: 'OR' }, 5, 6);
vE(c3, 'result', next, 'a');
vE(survive, 'result', next, 'b');
// The bootstrap / isolated-node gate: apply the rule only when the agent HAS a
// 1-ring. In sync agent mode the write buffer is primed from the read buffer, so
// "don't write" preserves the state exactly.
const hasRing = node('statement', { operation: '>', compareType: 'numerical', _port_y: '0' }, 3, 8.5);
vE(census, 'total', hasRing, 'x');
const gate = node('conditional', {}, 6, 7.5);
vE(hasRing, 'result', gate, 'condition');
const saNext = node('setAttribute', { attributeId: 'alive' }, 7, 6);
vE(next, 'result', saNext, 'value');
fE(bs, 'do', gate, 'do');
fE(gate, 'then', saNext, 'do');

const model = {
  schemaVersion: 1,
  properties: {
    name: 'Life on Bonds',
    description: "Conway's Game of Life as a GRAPH rule: each agent is bonded to its 8 Moore neighbours and reads its neighbours through a single Neighbour Census node — the multiset of neighbour states — instead of a lattice neighbourhood.",
    ruleDescription: 'Agents sit on a 32x32 torus lattice and are bonded to their 8 Moore neighbours by the engine auto-bond (form multiplier 1.9 x contact 0.9 = 1.71, which admits the orthogonal neighbours at 1.0 and the diagonals at 1.414 but excludes the next ring at 2.0). One Neighbour Census node over the bool `alive` attribute yields the True count and the Total; the rule is next = (n == 3) OR (alive AND n == 2). Auto-bond runs in the structural phase at the END of a step, so generation 1 still sees an empty 1-ring — the rule is therefore gated on Total > 0 (an isolated node keeps its state), which makes generation 1 a pure topology bootstrap. From generation 2 on every agent has exactly 8 bonds and the dynamics are Conway exactly. Agents are pinned (bond stiffness 0, no collision, no growth, momentum 0) and updated synchronously. The agent target is WebAssembly rather than WebGPU on purpose: the census is exact on all three targets, but WebGPU does not double-buffer agent attributes for synchronous mode, so any neighbour-reading sync rule races there (a pre-existing limitation that affects the proximity-based Game of Life on Agents too).',
    instructions: 'Press Play. Generation 1 only forms the bonds (the board is unchanged); Conway starts at generation 2. Open the Modeler > Agents graph to see the whole rule: one Neighbour Census node replaces the Get Bonded Agents -> Get Agents Attribute -> Count Matching chain you would otherwise wire once per state value.',
    author: 'Conway', modelAuthor: '', tags: ['agents', 'graph-rewriting', 'bonds', 'census', 'game-of-life'],
    dimension: '2d', gridWidth: W, gridHeight: H, gridDepth: 1, topology: '2d-grid',
    boundaryTreatment: 'torus', updateMode: 'synchronous', asyncScheme: 'random-order',
    maxIterations: 0, useWasm: true, useWebGPU: false,
  },
  topologyMode: { gridCells: false, agents: true },
  centerBased: {
    // WASM, not WebGPU — see the header note: the census is exact on all three
    // targets, but WebGPU does not double-buffer agent attributes for sync mode,
    // so a synchronous neighbour-reading rule races there (pre-existing; the
    // shipped Game of Life on Agents has the same defect). This model is an
    // oracle, so it ships on the target that is exact.
    enabled: true, agentTarget: 'wasm', maxAgents: W * H + 16, maxBonds: 8, worldWidth: W, worldHeight: H,
    seedCount: 0, seedPattern: 'scatter', defaultRadius: 0.45, growthRate: 0,
    repulsionStiffness: 0, adhesionStiffness: 0, interactionRange: 1.5, drag: 1.0, timeStep: 0.5,
    momentum: 0, maxSpeed: 0, neighbourQueryRadius: 2, customForcesOnly: true, useBondingPhysics: false,
    // Auto-bond by distance IS the topology builder. It rides the Bonds=Physics
    // capability, so the springs are enabled too — bondStiffness 0 makes their
    // force exactly zero, which is what keeps the lattice rigid.
    autoBond: true, bondStiffness: 0, bondRestLength: 1.0, formDistance: 1.9, breakDistance: 2.5,
    agentUpdateMode: 'sync',
    agentCapabilities: {
      motion: 'force', body: true, collision: 'off', bonds: 'physics', autoBond: true,
      growth: false, division: false, lifespan: false, populationBirth: false, populationDeath: false,
      sensing: false, sensingHeadingSource: 'velocity', orientation: false, fieldCoupling: false,
      appearance: true,
    },
  },
  attributes: [],
  agentAttributes: [{ id: 'alive', name: 'alive', type: 'bool', description: 'Game of Life cell state', isModelAttribute: false, defaultValue: 'false' }],
  neighborhoods: [],
  mappings: [],
  // A LINKED agent view — no colour nodes in the graph at all, so the behaviour
  // graph is nothing but the rule.
  agentMappings: [{
    id: 'agentViz', name: 'Life', description: 'Alive = green', isAttributeToColor: true,
    linked: true, linkedAttributeId: 'alive',
    linkedColors: { gradient: [{ position: 0, r: 22, g: 24, b: 34 }, { position: 1, r: 90, g: 225, b: 140 }] },
  }],
  variables: [],
  agentVariables: [{ id: 'i', name: 'i', description: 'spawn counter', kind: 'scalar', dataType: 'integer', initialValue: '0' }],
  indicators: [],
  graphNodes: [], graphEdges: [],
  agentGraphNodes: an, agentGraphEdges: ae, macroDefs: [],
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
console.log('Wrote ' + OUT + '  agent nodes: ' + an.length + ', edges: ' + ae.length);

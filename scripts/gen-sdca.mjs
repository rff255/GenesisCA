#!/usr/bin/env node
/**
 * Generates public/models/SDCA - Couplers and Decouplers.gcaproj — the second
 * flagship Graph-Rewriting Automata sample: a STRUCTURALLY DYNAMIC cellular
 * automaton after Ilachinski & Halpern (1987), with the Nowotny & Requardt
 * HYSTERESIS band as the anti-flicker device.
 *
 * ── THE DUAL COUPLING ───────────────────────────────────────────────────────
 * A value rule PLUS a link rule, each feeding the other:
 *
 *   values evolve on the topology   sigma_i' = f(sigma_i, #On among the bonded 1-ring)
 *   topology evolves on the values  lambda_ij' = psi(lambda_ij, sigma_i, sigma_j)
 *
 * The link rule splits into COUPLERS (add an edge) and DECOUPLERS (remove one),
 * exactly as the paper frames it. Here the coupling DRIVE for a pair is
 *
 *   d(i,j) = Drive + Agreement Bonus  if sigma_i == sigma_j
 *          = Drive                     otherwise
 *
 * and the LINK VALUE lambda is an exponential moving average of d, carried on the
 * bond itself as a BOND ATTRIBUTE — the capability this milestone added. It is
 * the link's memory: a bond that has been well-driven recently survives a dip.
 *
 * ── THE HYSTERESIS BAND (oracle O8) ─────────────────────────────────────────
 *   couple    when a NON-bonded nearby pair has d > Couple Above (lambda_2)
 *   decouple  when a BONDED pair's link value falls below Decouple Below (lambda_1)
 *   with lambda_2 >= lambda_1, so the interval [lambda_1, lambda_2] is a DEAD BAND
 *
 * Drive the density up across lambda_2 and back down to inside the band and the
 * edge turns on ONCE and stays on. A single symmetric threshold would chatter —
 * set Decouple Below equal to Couple Above and watch it.
 *
 * ── THE SINGLE-BUFFERING CAVEAT (documented, not fixed here) ────────────────
 * AGENT attributes are double-buffered under synchronous update, so the value
 * rule is a true synchronous CA: every node reads the previous generation.
 * BOND attributes are SINGLE-buffered on all three targets (P3's standing
 * decision), so a link write IS visible to a later reader in the same generation.
 * Both endpoints of a bond compute the SAME link value here (the rule is
 * symmetric in i and j — the canonical SDCA form), so the two rows never
 * disagree and invariant I2 holds; the only observable consequence is that the
 * moving average is applied TWICE per generation per bond, once from each
 * endpoint, i.e. the effective rate is 1-(1-r)^2. The fixed point is unchanged.
 * Making bond attributes synchronous is an all-three-targets change of its own.
 *
 * Re-run after a tweak:  node scripts/gen-sdca.mjs
 * Re-running preserves any saved simulationState + library thumbnail.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../public/models/SDCA - Couplers and Decouplers.gcaproj');

const usedIds = new Set();
function newId(prefix) {
  let id;
  do {
    id = prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  } while (usedIds.has(id));
  usedIds.add(id);
  return id;
}

function makeGraph() {
  const nodes = [];
  const edges = [];
  const node = (nodeType, config, col, row) => {
    const n = { id: newId('n'), type: 'caNode', position: { x: col * 240, y: row * 95 }, data: { nodeType, config } };
    nodes.push(n);
    return n;
  };
  const edge = (s, sp, t, tp, category) => {
    edges.push({
      id: newId('e'), source: s.id, target: t.id,
      sourceHandle: `output_${category}_${sp}`, targetHandle: `input_${category}_${tp}`,
    });
  };
  return {
    nodes, edges, node,
    vEdge: (s, sp, t, tp) => edge(s, sp, t, tp, 'value'),
    fEdge: (s, sp, t, tp) => edge(s, sp, t, tp, 'flow'),
  };
}

// --- tunables ----------------------------------------------------------------
const POP = 220;
const MAX_AGENTS = 400;
const MAX_BONDS = 6;
const RADIUS = 1.1;
const REST = 7.0;
const STIFF = 0.35;

// --- L3 LAYOUT ---------------------------------------------------------------
// THE WORLD SIZING RULE (shared with Cubic GRA): a bonded cloud laid out by the
// charge force settles at ~1.45 x the bond rest length, so each agent needs about
// (rest * 1.45)^2 of area, and the world must hold the CAP, not today's count:
//     side = ceil( sqrt( maxAgents * (rest * 1.45)^2 ) )
//          = ceil( sqrt( 400 * (7 * 1.45)^2 ) ) = 204  ->  220
// The old 110 x 110 gave 55 units^2 per agent against a bond rest of 7 (which
// needs ~103), so the couplers were choosing partners inside a jam.
const W = 220, H = 220;

// THE CHARGE — same measured shape as the flagship: a 4x-rest cutoff with a
// strong k beats an 8x-rest cutoff at the default k on BOTH quality and cost,
// because the bin edge IS the cutoff and candidates grow with its square.
const CHARGE_K = -10;
const CHARGE_CUTOFF = REST * 4;   // 28 world units

// SOLVER RELAXATION (L3). Two force passes per generation. SDCA is the model that
// wants the ENGINE knob rather than a rule-graph Periodic Step: its population is
// FIXED (no growth to outrun), its rule already carries its own rate semantics in
// Link Rate, and its couplers decide by DISTANCE — so what it needs is a settled
// cloud each generation, not a slower clock. Keeping the generation counter
// meaning one rule step also keeps the hysteresis band (O8) a per-generation
// property. The flagship Cubic GRA demonstrates the other half, cadence.
const LAYOUT_ITERATIONS = 2;

// =============================================================================
// AGENT INIT EVENT — spawn the population from the graph
// =============================================================================
// Not `seedCount` + `seedPattern: 'scatter'`: that places seeds with Math.random(),
// which is outside the replayable stream. Spawning from the Init Event uses the
// shared xorshift32 stream instead, so the whole initial condition — positions AND
// the random states that break the all-Off fixed point — is reproducible.
const ag = makeGraph();

const init = ag.node('agentInit', {}, 0, 0);
const spawnLoop = ag.node('loop', { mode: 'count', _port_count: String(POP) }, 1, 0);
ag.fEdge(init, 'do', spawnLoop, 'do');

const rx = ag.node('getRandom', { randomType: 'float', min: '0', max: '1' }, 2, -2);
const ry = ag.node('getRandom', { randomType: 'float', min: '0', max: '1' }, 2, -1);
const px = ag.node('expression', {
  expression: 'u * width', visibleCount: 2, _varName_a: 'u', _varName_b: 'width',
}, 3, -2);
ag.vEdge(rx, 'value', px, 'a');
ag.vEdge(init, 'worldWidth', px, 'b');
const py = ag.node('expression', {
  expression: 'u * height', visibleCount: 2, _varName_a: 'u', _varName_b: 'height',
}, 3, -1);
ag.vEdge(ry, 'value', py, 'a');
ag.vEdge(init, 'worldHeight', py, 'b');

const mk = ag.node('createAgent', { _port_radius: String(RADIUS) }, 4, 0);
ag.vEdge(px, 'result', mk, 'x');
ag.vEdge(py, 'result', mk, 'y');
const addw = ag.node('addAgentToWorld', {}, 5, 0);
ag.vEdge(mk, 'handle', addw, 'handle');
const coin = ag.node('getRandom', { randomType: 'bool', _port_probability: '0.35' }, 5, 2);
const setSeedState = ag.node('setAgentAttribute', { attributeId: 'state' }, 6, 0);
ag.vEdge(mk, 'handle', setSeedState, 'agentId');
ag.vEdge(coin, 'value', setSeedState, 'value');
ag.fEdge(spawnLoop, 'body', mk, 'do');
ag.fEdge(mk, 'next', addw, 'do');
ag.fEdge(addw, 'next', setSeedState, 'do');

// =============================================================================
// BEHAVIOUR STEP — the value rule, then the decouplers, then the couplers
// =============================================================================
const bs = ag.node('behaviourStep', {}, 0, 5);

// ---- 1. the VALUE rule ------------------------------------------------------
const census = ag.node('neighbourCensus', { attributeId: 'state', source: 'bonded' }, 0, 7);
const myState = ag.node('getCellAttribute', { attributeId: 'state' }, 0, 8);
const stateLut = ag.node('lookupInteraction', { tableId: 'stateRule' }, 1, 7);
ag.vEdge(myState, 'value', stateLut, 'axis_0');
ag.vEdge(census, 'count_1', stateLut, 'axis_1');
const setState = ag.node('setAttribute', { attributeId: 'state' }, 2, 7);
ag.vEdge(stateLut, 'value', setState, 'value');
ag.fEdge(bs, 'do', setState, 'do');

// ---- shared model-attribute reads -------------------------------------------
const mDrive = ag.node('getModelAttribute', { attributeId: 'drive' }, 0, 10);
const mBonus = ag.node('getModelAttribute', { attributeId: 'agreeBonus' }, 0, 11);
const mOn = ag.node('getModelAttribute', { attributeId: 'lambdaOn' }, 0, 12);
const mOff = ag.node('getModelAttribute', { attributeId: 'lambdaOff' }, 0, 13);
const mRate = ag.node('getModelAttribute', { attributeId: 'linkRate' }, 0, 14);
const mRadius = ag.node('getModelAttribute', { attributeId: 'couplingRadius' }, 0, 15);

/** d(i,j) = Drive + AgreementBonus * (sigma_i == sigma_j). Symmetric in i and j —
 *  which is what makes both endpoints compute the same link value. */
function driveFor(otherState, col, row) {
  const agree = ag.node('statement', { operation: '==', compareType: 'numerical' }, col, row);
  ag.vEdge(myState, 'value', agree, 'x');
  ag.vEdge(otherState, 'value', agree, 'y');
  // ONE Expression where a Multiply fed an Add. `drive + agree * bonus` binds
  // exactly as the chain did (`*` before `+`), so this is the same arithmetic in
  // the same order — a pure refactor, not a re-derivation.
  const d = ag.node('expression', {
    expression: 'drive + agree * bonus', visibleCount: 3,
    _varName_a: 'drive', _varName_b: 'agree', _varName_c: 'bonus',
  }, col + 1, row);
  ag.vEdge(mDrive, 'value', d, 'a');
  ag.vEdge(agree, 'result', d, 'b');
  ag.vEdge(mBonus, 'value', d, 'c');
  return d;
}

// ---- 2. the DECOUPLERS + the link-value update ------------------------------
const feBond = ag.node('forEachBond', {}, 2, 10);
ag.fEdge(setState, 'next', feBond, 'do');

const pState = ag.node('getAgentAttribute', { attributeId: 'state' }, 3, 9);
ag.vEdge(feBond, 'partnerId', pState, 'agentId');
const dBond = driveFor(pState, 4, 10);

const oldLambda = ag.node('getBondAttribute', { attributeId: 'strength' }, 4, 12);
ag.vEdge(feBond, 'partnerId', oldLambda, 'partnerId');
// lambda' = lambda + rate * (d - lambda) — the formula the model's Rule
// Description states, now written as itself instead of as three chained Math
// nodes. `(d - lambda) * rate` and `rate * (d - lambda)` are bit-identical
// (IEEE multiplication is commutative), so the refactor changes no decision.
const newLambda = ag.node('expression', {
  expression: 'lambda + rate * (d - lambda)', visibleCount: 3,
  _varName_a: 'lambda', _varName_b: 'rate', _varName_c: 'd',
}, 8, 12);
ag.vEdge(oldLambda, 'value', newLambda, 'a');
ag.vEdge(mRate, 'value', newLambda, 'b');
ag.vEdge(dBond, 'result', newLambda, 'c');

const writeLambda = ag.node('setBondAttribute', { attributeId: 'strength' }, 10, 11);
ag.vEdge(feBond, 'partnerId', writeLambda, 'partnerId');
ag.vEdge(newLambda, 'result', writeLambda, 'value');
ag.fEdge(feBond, 'body', writeLambda, 'do');

const tooWeak = ag.node('statement', { operation: '<', compareType: 'numerical' }, 10, 13);
ag.vEdge(newLambda, 'result', tooWeak, 'x');
ag.vEdge(mOff, 'value', tooWeak, 'y');
const decoupleIf = ag.node('conditional', {}, 11, 11);
ag.vEdge(tooWeak, 'result', decoupleIf, 'condition');
ag.fEdge(writeLambda, 'next', decoupleIf, 'check');
const decouple = ag.node('breakBond', {}, 12, 11);
ag.vEdge(feBond, 'partnerId', decouple, 'targetAgent');
ag.fEdge(decoupleIf, 'then', decouple, 'do');

// ---- 3. the COUPLERS --------------------------------------------------------
const cands = ag.node('getNearbyAgents', {}, 2, 16);
ag.vEdge(mRadius, 'value', cands, 'radius');
const feCand = ag.node('forEachInArray', {}, 3, 16);
ag.vEdge(cands, 'agents', feCand, 'array');
ag.fEdge(feBond, 'next', feCand, 'do');

const cState = ag.node('getAgentAttribute', { attributeId: 'state' }, 4, 15);
ag.vEdge(feCand, 'element', cState, 'agentId');
const dCand = driveFor(cState, 5, 16);

const strongEnough = ag.node('statement', { operation: '>', compareType: 'numerical' }, 8, 16);
ag.vEdge(dCand, 'result', strongEnough, 'x');
ag.vEdge(mOn, 'value', strongEnough, 'y');
const coupleIf = ag.node('conditional', {}, 9, 16);
ag.vEdge(strongEnough, 'result', coupleIf, 'condition');
ag.fEdge(feCand, 'body', coupleIf, 'check');
// A new link is born carrying its drive as its initial value — Form Bond's
// per-bond-attribute initial-value port (P2/P3). An already-bonded pair is an
// idempotent no-op, so no "is it bonded" test is needed.
const couple = ag.node('formBond', {
  _port_restLength: String(REST), _port_stiffness: String(STIFF),
}, 10, 16);
ag.vEdge(feCand, 'element', couple, 'targetAgent');
ag.vEdge(dCand, 'result', couple, 'bondAttr_strength');
ag.fEdge(coupleIf, 'then', couple, 'do');

// =============================================================================
// NON-GRAPH MODEL PARTS
// =============================================================================

// The value rule: 2 x (MAX_BONDS + 1) cells, [own state] x [On neighbours].
// Row-major: index = own * (MAX_BONDS + 1) + onCount.
// A rule that keeps the value field ALIVE on a graph whose degree is itself
// changing: On survives with one or two On neighbours, Off is born from an empty
// or nearly-empty ring. The first thing a hand-written table gets wrong here is
// making all-Off absorbing — [Off, 0] -> On is what prevents that.
const stateTable = [
  /* Off, 0..6 */ 1, 1, 0, 0, 0, 0, 1,
  /* On,  0..6 */ 0, 1, 1, 0, 0, 0, 0,
];

const attributes = [
  {
    id: 'stateRule', name: 'State Rule', type: 'lookupTable', isModelAttribute: true, defaultValue: '0',
    description:
      'The VALUE rule: what does a node become, given its own state and how many of its bonded ' +
      'neighbours are On? Randomize it to explore the value-rule space; the topology rule is ' +
      'controlled by the thresholds below.',
    valueType: 'bool',
    axes: [
      { name: 'Own state', source: { kind: 'intRange', min: 0, max: 1 } },
      { name: 'On neighbours', source: { kind: 'intRange', min: 0, max: MAX_BONDS } },
    ],
    tableData: stateTable,
    tableRoll: { seed: 7, density: 0.5 },
  },
  {
    id: 'drive', name: 'Drive', type: 'float', isModelAttribute: true,
    description:
      'The global coupling drive. This is the O8 knob: raise it above Couple Above to make links ' +
      'form, then lower it back INTO the band and watch them stay. The shipped default sits BELOW ' +
      'Decouple Below, so a pair only holds together while its endpoints agree.',
    defaultValue: '0.3', hasBounds: true, min: 0, max: 1,
  },
  {
    id: 'agreeBonus', name: 'Agreement Bonus', type: 'float', isModelAttribute: true,
    description:
      'Added to the drive when the two endpoints share a state — this is the term that makes the ' +
      'topology depend on the VALUES. At the shipped defaults an AGREEING pair drives at 0.75 (above ' +
      'Couple Above, so it couples) while a DISAGREEING one drives at 0.30 (below Decouple Below, so ' +
      'it eventually lets go) — that is the dual coupling in one line. Set it to 0 and the link rule ' +
      'becomes a pure global threshold, which is the cleanest way to see the hysteresis on its own.',
    defaultValue: '0.45', hasBounds: true, min: 0, max: 0.6,
  },
  {
    id: 'lambdaOn', name: 'Couple Above', type: 'float', isModelAttribute: true,
    description: 'A non-bonded nearby pair COUPLES when its drive exceeds this (lambda 2).',
    defaultValue: '0.65', hasBounds: true, min: 0, max: 1.5,
  },
  {
    id: 'lambdaOff', name: 'Decouple Below', type: 'float', isModelAttribute: true,
    description:
      'A bonded pair DECOUPLES when its link value falls below this (lambda 1). Keep it below ' +
      'Couple Above: the gap is the hysteresis band. Set the two equal to see the flicker the band exists to prevent.',
    defaultValue: '0.35', hasBounds: true, min: 0, max: 1.5,
  },
  {
    id: 'linkRate', name: 'Link Rate', type: 'float', isModelAttribute: true,
    description:
      'How fast a link value chases its drive (an exponential moving average). Lower values give the ' +
      'link more memory, so it survives longer dips. 1 makes the link value follow the drive exactly.',
    defaultValue: '0.5', hasBounds: true, min: 0.05, max: 1,
  },
  {
    id: 'couplingRadius', name: 'Coupling Radius', type: 'float', isModelAttribute: true,
    description: 'How far a coupler looks for a partner. The spatial candidate set, not the rule.',
    defaultValue: '7', hasBounds: true, min: 1, max: 20,
  },
];

const agentAttributes = [
  { id: 'state', name: 'state', type: 'bool', defaultValue: 'false', description: 'sigma — the node value.' },
];

const bondAttributes = [
  {
    id: 'strength', name: 'strength', type: 'float', defaultValue: '0',
    description:
      'lambda — the LINK VALUE, carried on the bond itself. An exponential moving average of the ' +
      'pair drive, so a link remembers how well it has been driven. Click an agent in the simulator ' +
      'to read its bonds and their link values.',
  },
];

const agentMappings = [
  {
    id: 'stateView', name: 'State', isAttributeToColor: true,
    description: 'sigma: Off / On.',
    linked: true, linkedAttributeId: 'state',
    linkedColors: { gradient: [{ position: 0, r: 56, g: 68, b: 92 }, { position: 1, r: 96, g: 220, b: 200 }] },
  },
];

const indicators = [
  { id: 'nodes', name: 'nodes (N)', kind: 'graph', graphMetric: 'nodeCount', dataType: 'integer', defaultValue: '0', accumulationMode: 'per-generation', watched: true },
  { id: 'edges', name: 'links (E)', kind: 'graph', graphMetric: 'edgeCount', dataType: 'integer', defaultValue: '0', accumulationMode: 'per-generation', watched: true },
  { id: 'meanDeg', name: 'mean degree', kind: 'graph', graphMetric: 'meanDegree', dataType: 'float', defaultValue: '0', accumulationMode: 'per-generation', watched: true },
  { id: 'components', name: 'components', kind: 'graph', graphMetric: 'componentCount', dataType: 'integer', defaultValue: '0', accumulationMode: 'per-generation', watched: true },
  { id: 'onCount', name: 'On nodes', kind: 'linked', linkedAttributeId: 'state', linkedAggregation: 'frequency', dataType: 'bool', defaultValue: 'false', accumulationMode: 'per-generation', watched: false },
];

const properties = {
  name: 'SDCA - Couplers and Decouplers',
  modelAuthor: 'Rodrigo F. Figueiredo',
  description:
    'A structurally dynamic cellular automaton after Ilachinski and Halpern (1987): a value rule and ' +
    'a link rule, dual-coupled, so the values evolve on the topology while the topology evolves on ' +
    'the values. Couplers add links, decouplers remove them, and the Nowotny-Requardt hysteresis band ' +
    'keeps an edge from chattering. The link value lives on the bond itself, as a bond attribute.',
  ruleDescription:
    'THE DUAL COUPLING. Two rules that feed each other:\n' +
    '  values evolve on the topology   sigma_i\' = f(sigma_i, number of On neighbours in the bonded 1-ring)\n' +
    '  topology evolves on the values  lambda_ij\' = psi(lambda_ij, sigma_i, sigma_j)\n' +
    'The value rule is the State Rule lookup table (Randomize it). The link rule is a drive plus two ' +
    'thresholds.\n\n' +
    'THE DRIVE. For a pair (i, j) the coupling drive is\n' +
    '    d = Drive + Agreement Bonus   when the two endpoints share a state\n' +
    '    d = Drive                     otherwise\n' +
    'so the Agreement Bonus is the term that makes the topology depend on the values. Set it to zero ' +
    'and the link rule becomes a pure global threshold — the cleanest way to see the hysteresis alone.\n\n' +
    'THE LINK VALUE IS A BOND ATTRIBUTE. Every bond carries "strength" (lambda), an exponential moving ' +
    'average of its pair drive: lambda\' = lambda + Link Rate x (d - lambda). It is the link\'s memory — ' +
    'a well-driven bond survives a dip. This is the model that shows why bond attributes exist; click ' +
    'any agent in the simulator to read its bonds and their link values. A newly coupled link is born ' +
    'carrying its drive as its initial value, through Form Bond\'s per-bond-attribute input.\n\n' +
    'THE HYSTERESIS BAND (Nowotny and Requardt). A non-bonded nearby pair COUPLES when d exceeds ' +
    'Couple Above (lambda 2); a bonded pair DECOUPLES when its link value falls below Decouple Below ' +
    '(lambda 1). With lambda 2 >= lambda 1 the interval between them is a DEAD BAND: drive the density ' +
    'up across lambda 2 and back down to inside the band and the edge turns on once and stays on. Set ' +
    'Decouple Below equal to Couple Above and the same manoeuvre makes it chatter — that contrast is ' +
    'the whole point of the device.\n\n' +
    'THE SINGLE-BUFFERING CAVEAT, HONESTLY. Agent attributes are double-buffered under synchronous ' +
    'update, so the value rule is a true synchronous CA: every node reads the previous generation. ' +
    'BOND attributes are SINGLE-buffered on all three compile targets, so a link write is visible to a ' +
    'later reader within the same generation. Both endpoints here compute the SAME link value (the ' +
    'rule is symmetric in i and j, which is the canonical SDCA form), so the two stored copies never ' +
    'disagree and the bond-symmetry invariant holds; the only observable consequence is that the ' +
    'moving average is applied twice per generation per bond, once from each endpoint, so the ' +
    'effective rate is 1-(1-r)^2. The fixed point is unchanged. Making bond attributes synchronous ' +
    'would be an all-three-targets change of its own.\n\n' +
    'THE INITIAL CONDITION. The population is spawned from the Agent Init Event rather than by the ' +
    'seed-pattern setting, because scattered seeding uses Math.random and would sit outside the ' +
    'replayable random stream. Spawning from the graph draws positions and the initial states from the ' +
    'shared stream instead, so the whole initial condition — including the random states that break ' +
    'the all-Off fixed point — is reproducible.',
  instructions:
    'Press Play. Links form, the value field flickers across them, and the force layout untangles the ' +
    'graph it is drawing.\n\n' +
    'To SEE the hysteresis: set Agreement Bonus to 0, then move Drive. Below 0.35 links break; between ' +
    '0.35 and 0.65 nothing happens at all; above 0.65 links form. Now bring Drive back to 0.5 — the ' +
    'links you just made STAY. Set Decouple Below equal to Couple Above (0.65) and repeat: this time ' +
    'they vanish the moment you leave the threshold. That is what the band is for.\n\n' +
    'Click any agent to inspect its bonds and their link values.',
  topology: '2d-grid',
  boundaryTreatment: 'torus',
  updateMode: 'synchronous',
  asyncScheme: 'random-order',
  gridWidth: W,
  gridHeight: H,
  maxIterations: 100000,
  tags: ['agents', 'graph rewriting', 'SDCA', 'bond attributes', 'hysteresis'],
  useWasm: true,
  useWebGPU: false,
};

const centerBased = {
  enabled: true,
  agentTarget: 'webgpu',
  maxAgents: MAX_AGENTS,
  maxBonds: MAX_BONDS,
  bondRequestDepth: 16,
  worldWidth: W,
  worldHeight: H,
  seedCount: 0,               // the Agent Init Event spawns the population
  seedPattern: 'compact',
  defaultRadius: RADIUS,
  growthRate: 0,
  repulsionStiffness: 1.0,
  adhesionStiffness: 0,
  interactionRange: 2.0,
  drag: 1,
  timeStep: 0.12,
  momentum: 0,
  maxSpeed: 0,
  neighbourQueryRadius: 8,
  useBondingPhysics: true,
  autoBond: false,
  bondStiffness: STIFF,
  bondRestLength: REST,
  formDistance: 1.15,
  breakDistance: 1.8,
  agentUpdateMode: 'sync',
  // L1 CHARGE — the only engine force with reach beyond contact distance, and so
  // the only one that can hold a bonded cloud open. Without it the couplers pick
  // partners out of a jam where every agent touches every other.
  chargeStrength: CHARGE_K,
  chargeMaxDist: CHARGE_CUTOFF,
  // L3 — two force passes per generation (see LAYOUT_ITERATIONS above).
  layoutIterations: LAYOUT_ITERATIONS,
  agentCapabilities: {
    motion: 'force', body: true, collision: 'soft', bonds: 'physics', autoBond: false,
    charge: 'on',
    growth: false, division: false, lifespan: false, populationBirth: true,
    populationDeath: false, sensing: true, sensingHeadingSource: 'velocity',
    orientation: false, fieldCoupling: false, appearance: true,
  },
};

const model = {
  schemaVersion: 2,
  properties,
  attributes,
  neighborhoods: [],
  mappings: [],
  indicators,
  graphNodes: [],
  graphEdges: [],
  macroDefs: [],
  topologyMode: { gridCells: false, agents: true },
  centerBased,
  agentAttributes,
  agentVariables: [],
  bondAttributes,
  agentMappings,
  agentGraphNodes: ag.nodes,
  agentGraphEdges: ag.edges,
};

mkdirSync(dirname(OUT), { recursive: true });

let preserved = null;
if (existsSync(OUT)) {
  try {
    const prev = JSON.parse(readFileSync(OUT, 'utf-8'));
    preserved = { simulationState: prev.simulationState, thumbnail: prev.properties?.thumbnail, presets: prev.presets };
  } catch { /* regenerate from scratch */ }
}
if (preserved?.simulationState) model.simulationState = preserved.simulationState;
if (preserved?.thumbnail) model.properties.thumbnail = preserved.thumbnail;
if (preserved?.presets) model.presets = preserved.presets;

writeFileSync(OUT, JSON.stringify(model, null, 1));
console.log(`wrote ${OUT}`);
console.log(`  agent graph: ${ag.nodes.length} nodes / ${ag.edges.length} edges`);
console.log(`  population ${POP}  maxBonds ${MAX_BONDS}  queue depth 16  band [lambda1 0.35, lambda2 0.65]`);

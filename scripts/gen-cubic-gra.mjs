#!/usr/bin/env node
/**
 * Generates public/models/Cubic GRA.gcaproj — the FLAGSHIP Graph-Rewriting
 * Automata sample: a 3-regular (cubic) graph that rewrites itself while STAYING
 * 3-regular, driven by a rule TABLE with a Randomize button, with an Overseer
 * protocol that sweeps rule space.
 *
 * ── THE OPERATION SET IS OURS ────────────────────────────────────────────────
 * This model does NOT claim faithfulness to any particular published GRA paper.
 * The lineage (Suzudo; Tomita, Kurokawa & Murata) is canonically 3-regular with
 * operations chosen to preserve the degree invariant, but the exact operation
 * sets in those papers are not reproduced here. We DEFINE our own cubic-preserving
 * set and test it against invariants that are true of ANY cubic graph regardless
 * of whose paper defined the moves (see IMPACT_MAP_GRAPH_REWRITING_AGENTS.md §6.2):
 *
 *   triangle split   v(a,b,c) -> v1,v2,v3 with v1-a, v2-b, v3-c and the triangle
 *                    v1v2, v2v3, v3v1.   dN = +2,  dE = +3
 *   idle             -                    dN =  0,  dE =  0
 *
 * E = 3N/2 is preserved exactly (3N/2 + 3 == 3(N+2)/2), and every node — old,
 * re-pointed or newborn — has degree exactly 3 the instant the generation ends.
 * That is oracle O6, and it is checked at EVERY generation by
 * scripts/verify-graph-rewrite.mjs (Tier K), which loads THIS file's output.
 *
 * The EDGE SWAP listed in the plan's operation table is NOT included: it is not
 * expressible with the current verb set (see the model's Rule Description and the
 * P7 completion report — breaking an edge between two OTHER agents has no verb,
 * so no single agent can issue a degree-neutral rewiring of a non-incident edge).
 * The triangle CONTRACT (the inverse of the split) is likewise omitted; the plan
 * marks it optional and a growth-only rule exercises O6 fully.
 *
 * ── HOW THE SPLIT IS EXPRESSED (5 queue ops, maxBonds 3) ─────────────────────
 * From the mother v1's own behaviour, in ONE generation, on ONE agent's request
 * queue (P4b):
 *     Create Agent x2 + Add Agent To World x2   (host calls, no queue slot)
 *     Rewire Bond   from=b  to=v2               v1 drops b, gains v2  (deg stays 3)
 *     Rewire Bond   from=c  to=v3
 *     Form Bond Between  b, v2                  b regains its third edge
 *     Form Bond Between  c, v3
 *     Form Bond Between  v2, v3                 <- the edge no self-relative verb can make
 * Peak degree during the drain is exactly 3, which is why maxBonds is a TIGHT 3.
 *
 * ── WHY THE RANDOM-PRIORITY GATE IS LOAD-BEARING ────────────────────────────
 * Two ADJACENT agents must never split in the same generation: v's rewire needs
 * the edge v-b to still exist when the drain reaches it, and a splitting b would
 * have re-pointed it away. The rule therefore restricts rewriting to an INDEPENDENT
 * SET: every agent rolls a fresh random priority each generation into an agent
 * attribute, and only an agent whose stored priority is STRICTLY less than every
 * bonded neighbour's may rewrite. Strict inequality cannot hold both ways, so the
 * winners are pairwise non-adjacent for ANY assignment of priorities — the
 * guarantee does not depend on the values being sensible, only on everyone reading
 * the same generation's values (which synchronous update gives for free).
 * Non-adjacent splitters never conflict: each one's rewire-break precedes its own
 * Form Between on the same neighbour, so a shared neighbour dips to 2 and returns
 * to 3 without ever exceeding maxBonds.
 * The SAME roll doubles as the rate knob (`priority < Split Rate`), so one random
 * number per agent per generation drives both.
 *
 * ── WHY agentTarget = 'wasm' ────────────────────────────────────────────────
 * A deliberate, documented exception to the library's WebGPU-where-gated-in policy,
 * inherited from P6: the Overseer's seed policy drives `setRngSeed`, which re-seeds
 * the shared xorshift32 stream JS and WASM use; the WebGPU agent target seeds its
 * per-agent PCG once at runtime creation, so a sweep there would not reproduce
 * across two presses of Run Experiment. WASM keeps the experiment exact and is
 * bit-identical to JS. The model still compiles and runs on all three targets.
 *
 * Re-run after a tweak:  node scripts/gen-cubic-gra.mjs
 * Re-running preserves any saved simulationState + library thumbnail.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../public/models/Cubic GRA.gcaproj');

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
const SEEDS = 4;              // K4 — the smallest cubic graph
const MAX_BONDS = 3;          // TIGHT: nothing may transiently exceed cubic degree
const RADIUS = 0.9;
const REST = 5.0;             // bond rest length (the layout scale)
const STIFF = 0.55;
const SPLIT_RATE = 0.02;      // upper bound on the fraction of nodes rewriting per generation
const MAX_AGENTS = 6000;

// --- L3 LAYOUT (measured, not guessed — scripts/probe-graph-layout.mjs) -------
//
// THE WORLD SIZING RULE. A 3-regular graph laid out by the charge force settles
// at a mean bond length of ~1.45 x rest, so each node needs about (rest*1.45)^2
// of area. The world must hold the CAP, not the current population, or the graph
// re-jams as it grows:
//     side = ceil( sqrt( maxAgents * (rest * 1.45)^2 ) )
//          = ceil( sqrt( 6000 * (5 * 1.45)^2 ) ) = 562  ->  600
// The old 220 x 220 gave 4.6 units per agent against a bond rest of 5 at N~2300:
// SATURATED, and no repulsion strength can open a box with no room in it (that is
// the second, independent cause the impact map identified — the charge force
// alone was never going to fix it).
const W = 600, H = 600;

// THE CHARGE. Measured on the real generative process (K4 -> 2500 by triangle
// split at this model's own 2%/generation rate, through the shipped WASM force
// pass), sweeping cutoff x strength:
//
//   world cutoff strength  settled nnb/bond  overlap%   live nnb  live ovl%  ms/gen
//    220    off      -      0.15             99.6       0.10      99.6       34   <- shipped
//    400    40      -3      0.73              0.2       0.56      13.0       40
//    400    40      -6      0.81              0.0       0.66       2.1       32
//    400    20      -3      0.57              0.6       0.44      56.1       23
//    400    20     -10      0.72              0.0       0.59       2.2       15   <- chosen
//
// STRENGTH IS A CHEAPER LEVER THAN REACH. Doubling the cutoff quadruples the
// candidates the 3x3 stencil visits (the bin edge IS the cutoff); raising |k|
// costs nothing. A 4x-rest cutoff at k = -10 matches the quality of an 8x-rest
// cutoff at the default k = -3 and runs 2.6x faster. The impact map's "quality
// saturates by ~8x rest" sweep held k fixed at -3 — this is the second axis of
// that surface, not a contradiction of it.
const CHARGE_K = -10;
const CHARGE_CUTOFF = REST * 4;   // 20 world units

// THE CADENCE (L2). The whole rule — priority roll, state update and rewrite —
// hangs off ONE Periodic Step, so a "rule step" is one generation of the
// automaton and the generations in between are pure layout relaxation. Gating
// only the rewrite would silently build a DIFFERENT automaton (states advancing
// twice per rewrite), which is exactly the mistake Periodic Step exists to make
// impossible.
//
// Period 2 is measured, not taste: relaxation ticks per rewrite of 1 / 2 / 3 / 4
// give live nnb/bond 0.59 / 0.65 / 0.68 / 0.71 at 2.2 / 0.2 / 0.0 / 0.0 % overlap
// — the knee is at 2, and every further tick costs a full force pass. It also
// keeps the Overseer's generation budget honest (see T_RUN).
const PERIOD = 2;

// The two state values. `Active`/`Dormant` is the whole alphabet — an 8-cell rule
// table you can read at a glance, which is the point of "census -> table -> verb".
const STATES = ['Dormant', 'Active'];
const VERBS = ['Idle', 'Split A', 'Split B', 'Split C'];

// =============================================================================
// AGENT GRAPH
// =============================================================================
const ag = makeGraph();

// THE ROOT IS A PERIODIC STEP, not a Behaviour Step: the automaton's clock runs
// at half the physics clock, so every rule step gets PERIOD relaxation passes to
// untangle what the previous rewrite tangled. Everything hangs off this one root
// (priority roll, state, rewrite) so state and structure can never drift out of
// phase with each other.
const bs = ag.node('periodicStep', { period: PERIOD, phase: 0 }, 0, 6);

// ---- 1. roll this generation's priority (read by neighbours NEXT generation) --
const rnd = ag.node('getRandom', { randomType: 'float', min: '0', max: '1' }, 0, 0);
const setPrio = ag.node('setAttribute', { attributeId: 'prio' }, 1, 0);
ag.vEdge(rnd, 'value', setPrio, 'value');
ag.fEdge(bs, 'do', setPrio, 'do');

// ---- 2. seed bootstrap vs the rule ------------------------------------------
// Form Bond writes the request queue at `idx`, so it is INVALID in the Agent Init
// Event; the K4 bootstrap therefore lives in the behaviour graph, gated on degree
// 0. A newborn already has degree 3 by its first behaviour step, so this branch
// runs exactly once, on the four seeds, at generation 1.
const deg = ag.node('getBondDegree', {}, 0, 2);
const isSeed = ag.node('statement', { operation: '==', compareType: 'numerical', _port_y: '0' }, 1, 2);
ag.vEdge(deg, 'value', isSeed, 'x');
const branch = ag.node('conditional', {}, 2, 6);
ag.fEdge(setPrio, 'next', branch, 'check');
ag.vEdge(isSeed, 'result', branch, 'condition');

// The four seeds are otherwise IDENTICAL, and K4 is vertex-transitive, so a
// deterministic rule would keep them identical forever and nothing would ever
// happen. Alternating their state by handle parity is the symmetry break; from
// then on every split injects fresh Dormant nodes and the diversity sustains itself.
const selfId = ag.node('getSelfHandle', {}, 3, 0);
const parity = ag.node('expression', {
  expression: 'handle % 2', visibleCount: 1, _varName_a: 'handle',
}, 4, 0);
ag.vEdge(selfId, 'handle', parity, 'a');
const seedState = ag.node('setAttribute', { attributeId: 'state' }, 5, 0);
ag.vEdge(parity, 'result', seedState, 'value');
ag.fEdge(branch, 'then', seedState, 'do');

const near = ag.node('getNearbyAgents', { _port_radius: '6' }, 3, 1);
const feSeed = ag.node('forEachInArray', {}, 4, 1);
ag.vEdge(near, 'agents', feSeed, 'array');
ag.fEdge(seedState, 'next', feSeed, 'do');
const seedBond = ag.node('formBond', { _port_restLength: String(REST), _port_stiffness: String(STIFF) }, 5, 1);
ag.vEdge(feSeed, 'element', seedBond, 'targetAgent');
ag.fEdge(feSeed, 'body', seedBond, 'do');

// ---- 3. the RULE: census -> table -> verb ------------------------------------
const census = ag.node('neighbourCensus', { attributeId: 'state', source: 'bonded' }, 0, 8);
const own = ag.node('getCellAttribute', { attributeId: 'state' }, 0, 9);

const lutState = ag.node('lookupInteraction', { tableId: 'ruleState' }, 1, 8);
ag.vEdge(own, 'value', lutState, 'axis_0');
ag.vEdge(census, 'count_1', lutState, 'axis_1');

const lutVerb = ag.node('lookupInteraction', { tableId: 'ruleVerb' }, 1, 10);
ag.vEdge(own, 'value', lutVerb, 'axis_0');
ag.vEdge(census, 'count_1', lutVerb, 'axis_1');

// The VALUE rule always applies — the state evolves whether or not the graph does.
const setState = ag.node('setAttribute', { attributeId: 'state' }, 2, 8);
ag.vEdge(lutState, 'value', setState, 'value');
ag.fEdge(branch, 'else', setState, 'do');

// ---- 4. the independent-set gate --------------------------------------------
const bonded = ag.node('getBondedAgents', {}, 0, 12);
const nbrPrio = ag.node('getAgentsAttribute', { attributeId: 'prio' }, 1, 12);
ag.vEdge(bonded, 'agents', nbrPrio, 'agents');
const minPrio = ag.node('aggregate', { operation: 'min' }, 2, 12);
ag.vEdge(nbrPrio, 'values', minPrio, 'values');

const myPrio = ag.node('getCellAttribute', { attributeId: 'prio' }, 0, 13);
const isLocalMin = ag.node('statement', { operation: '<', compareType: 'numerical' }, 3, 12);
ag.vEdge(myPrio, 'value', isLocalMin, 'x');
ag.vEdge(minPrio, 'result', isLocalMin, 'y');

const rate = ag.node('getModelAttribute', { attributeId: 'splitRate' }, 0, 14);
const underRate = ag.node('statement', { operation: '<', compareType: 'numerical' }, 3, 14);
ag.vEdge(myPrio, 'value', underRate, 'x');
ag.vEdge(rate, 'value', underRate, 'y');

const isCubic = ag.node('statement', { operation: '==', compareType: 'numerical', _port_y: '3' }, 3, 15);
ag.vEdge(deg, 'value', isCubic, 'x');

const gate1 = ag.node('logicOperator', { operation: 'AND' }, 4, 12);
ag.vEdge(isLocalMin, 'result', gate1, 'a');
ag.vEdge(underRate, 'result', gate1, 'b');
const gate2 = ag.node('logicOperator', { operation: 'AND' }, 5, 12);
ag.vEdge(gate1, 'result', gate2, 'a');
ag.vEdge(isCubic, 'result', gate2, 'b');

// The table PROPOSES, the gate DISPOSES: a blocked agent sees verb 0 (Idle).
const gatedVerb = ag.node('valueSwitch', { _port_elseValue: '0' }, 6, 11);
ag.vEdge(gate2, 'result', gatedVerb, 'condition');
ag.vEdge(lutVerb, 'value', gatedVerb, 'ifValue');

// ---- 5. Switch on the verb --------------------------------------------------
// Case 0 (Idle) is deliberately UNWIRED; every Split verb falls through to
// DEFAULT, which performs the split with the orientation taken from the verb.
const sw = ag.node('switch', {
  mode: 'value', valueType: 'integer', caseCount: 1, firstMatchOnly: true, _port_case_0_val: '0',
}, 7, 8);
ag.vEdge(gatedVerb, 'result', sw, 'value');
ag.fEdge(setState, 'next', sw, 'check');

// ---- 6. THE TRIANGLE SPLIT --------------------------------------------------
// Split A/B/C = verb 1/2/3 = keep the neighbour at bond-list slot 0/1/2; the
// other two are handed to the newborns.
// `verb - 1` is the 0-based bond slot to KEEP; the other two neighbours, handed
// to the newborns, are at (keep + 1) % 3 and (keep + 2) % 3. Two Expression nodes
// where five chained Math nodes used to sit — the same arithmetic, same order.
const bIdx = ag.node('expression', {
  expression: '(verb - 1 + 1) % 3', visibleCount: 1, _varName_a: 'verb',
}, 9, 13);
ag.vEdge(gatedVerb, 'result', bIdx, 'a');
const cIdx = ag.node('expression', {
  expression: '(verb - 1 + 2) % 3', visibleCount: 1, _varName_a: 'verb',
}, 9, 14);
ag.vEdge(gatedVerb, 'result', cIdx, 'a');

const bAgent = ag.node('arrayElement', {}, 11, 13);
ag.vEdge(bonded, 'agents', bAgent, 'array');
ag.vEdge(bIdx, 'result', bAgent, 'position');
const cAgent = ag.node('arrayElement', {}, 11, 14);
ag.vEdge(bonded, 'agents', cAgent, 'array');
ag.vEdge(cIdx, 'result', cAgent, 'position');

// ---- NEWBORN PLACEMENT: the parent MIDPOINT, not a fixed offset --------------
// v2 inherits the edge to b, so it is born half way to b; v3 half way to c. The
// old placement offset both newborns along a FIXED axis regardless of where b and
// c actually were, so roughly half of all splits started with the newborn on the
// far side of the mother from the neighbour it had to bond to — a stretched
// spring pulling it straight back through the structure.
//
// Get Agent Position in RELATIVE mode gives the torus-SHORTEST vector from self
// to the neighbour, so this is correct across a seam; hand-subtracting two
// absolute reads would place a newborn on the wrong side of the world there.
// The jitter (from this generation's priority roll, so it costs no extra node)
// separates the two newborns when b and c happen to be nearly coincident, and is
// mirrored between them so they never land on top of each other.
const pos = ag.node('getSelfPosition', {}, 8, 5);
const offB = ag.node('getAgentPosition', { mode: 'relative' }, 8, 3);
ag.vEdge(bAgent, 'value', offB, 'agentId');
const offC = ag.node('getAgentPosition', { mode: 'relative' }, 8, 7);
ag.vEdge(cAgent, 'value', offC, 'agentId');

const JITTER = REST * 0.12;
const midpoint = (col, row, offNode, axis, sign) => {
  const n = ag.node('expression', {
    expression: `self + toward * 0.5 ${sign} (jitter - 0.5) * ${JITTER}`,
    visibleCount: 3, _varName_a: 'self', _varName_b: 'toward', _varName_c: 'jitter',
  }, col, row);
  ag.vEdge(pos, axis, n, 'a');
  ag.vEdge(offNode, axis, n, 'b');
  ag.vEdge(myPrio, 'value', n, 'c');
  return n;
};
const x2 = midpoint(9, 4, offB, 'x', '+');
const y2 = midpoint(9, 5, offB, 'y', '+');
const x3 = midpoint(9, 6, offC, 'x', '-');
const y3 = midpoint(9, 7, offC, 'y', '-');

const mk2 = ag.node('createAgent', { _port_radius: String(RADIUS) }, 10, 4);
ag.vEdge(x2, 'result', mk2, 'x');
ag.vEdge(y2, 'result', mk2, 'y');
const add2 = ag.node('addAgentToWorld', {}, 11, 4);
ag.vEdge(mk2, 'handle', add2, 'handle');
const mk3 = ag.node('createAgent', { _port_radius: String(RADIUS) }, 10, 6);
ag.vEdge(x3, 'result', mk3, 'x');
ag.vEdge(y3, 'result', mk3, 'y');
const add3 = ag.node('addAgentToWorld', {}, 11, 6);
ag.vEdge(mk3, 'handle', add3, 'handle');

const bond = (col, row, type, wire) => {
  const n = ag.node(type, { _port_restLength: String(REST), _port_stiffness: String(STIFF) }, col, row);
  wire(n);
  return n;
};
const rw1 = bond(12, 4, 'rewireBond', n => { ag.vEdge(bAgent, 'value', n, 'fromAgent'); ag.vEdge(mk2, 'handle', n, 'toAgent'); });
const rw2 = bond(12, 5, 'rewireBond', n => { ag.vEdge(cAgent, 'value', n, 'fromAgent'); ag.vEdge(mk3, 'handle', n, 'toAgent'); });
const fb1 = bond(12, 6, 'formBondBetween', n => { ag.vEdge(bAgent, 'value', n, 'agentA'); ag.vEdge(mk2, 'handle', n, 'agentB'); });
const fb2 = bond(12, 7, 'formBondBetween', n => { ag.vEdge(cAgent, 'value', n, 'agentA'); ag.vEdge(mk3, 'handle', n, 'agentB'); });
const fb3 = bond(12, 8, 'formBondBetween', n => { ag.vEdge(mk2, 'handle', n, 'agentA'); ag.vEdge(mk3, 'handle', n, 'agentB'); });

ag.fEdge(sw, 'default', mk2, 'do');
ag.fEdge(mk2, 'next', add2, 'do');
ag.fEdge(add2, 'next', mk3, 'do');
ag.fEdge(mk3, 'next', add3, 'do');
ag.fEdge(add3, 'next', rw1, 'do');
ag.fEdge(rw1, 'next', rw2, 'do');
ag.fEdge(rw2, 'next', fb1, 'do');
ag.fEdge(fb1, 'next', fb2, 'do');
ag.fEdge(fb2, 'next', fb3, 'do');

// =============================================================================
// OVERSEER GRAPH — the rule-space sweep
// =============================================================================
// GENERATIONS, not rule steps. The rule runs on one generation in PERIOD, so a
// budget of 240 generations is 120 rule steps — the same amount of rewriting the
// pre-cadence sweep did, with the layout getting the generations in between.
// (This is the Overseer-accounting point L2 flagged: always say which unit.)
const T_RUN = 120 * PERIOD;
const ov = makeGraph();

const exp = ov.node('experiment', {}, 0, 3);
const clrN = ov.node('ovClearSeries', { series: 'N' }, 1, 3);
const clrE = ov.node('ovClearSeries', { series: 'E' }, 2, 3);
const clrD = ov.node('ovClearSeries', { series: 'maxDegree' }, 3, 3);
ov.fEdge(exp, 'do', clrN, 'do');
ov.fEdge(clrN, 'next', clrE, 'do');
ov.fEdge(clrE, 'next', clrD, 'do');

const banner = ov.node('ovLog', {
  text: 'Rule sweep: for each seed, roll BOTH tables, reset to K4 and run ' + T_RUN + ' generations.',
}, 4, 3);
ov.fEdge(clrD, 'next', banner, 'do');

const seeds = ov.node('ovSweepValues', {
  mode: 'list', list: '11, 22, 33, 44, 55, 66, 77, 88, 99, 110, 121, 132',
}, 0, 6);
const fe = ov.node('forEachInArray', {}, 1, 5);
ov.vEdge(seeds, 'values', fe, 'array');
ov.fEdge(banner, 'next', fe, 'do');

const rollV = ov.node('ovRandomizeTable', { tableId: 'ruleVerb', _port_density: '0.45' }, 2, 6);
ov.vEdge(fe, 'element', rollV, 'seed');
ov.fEdge(fe, 'body', rollV, 'do');
const rollSeedVal = ov.node('arithmeticOperator', { operation: '+', _port_y: '7' }, 2, 8);
ov.vEdge(fe, 'element', rollSeedVal, 'x');
const rollS = ov.node('ovRandomizeTable', { tableId: 'ruleState', _port_density: '0.5' }, 3, 6);
ov.vEdge(rollSeedVal, 'result', rollS, 'seed');
ov.fEdge(rollV, 'next', rollS, 'do');

// RUN UNTIL STOP, not a fixed-count run: a blow-up rule trips the population end
// condition and the sweep records WHEN, which is exactly the "grows / dies /
// blows up" classification the rule-space search is for. It also means a runaway
// rule can never drive the population into the agent cap, where a Create Agent
// would fail and the split would half-apply.
const reset = ov.node('ovResetBoard', {}, 4, 6);
const run = ov.node('ovRunUntilStop', { _port_maxGens: String(T_RUN) }, 5, 6);
ov.fEdge(rollS, 'next', reset, 'do');
ov.fEdge(reset, 'next', run, 'do');

const rN = ov.node('ovReadIndicator', { indicatorId: 'nodes', category: '' }, 5, 8);
const rE = ov.node('ovReadIndicator', { indicatorId: 'edges', category: '' }, 5, 9);
const rD = ov.node('ovReadIndicator', { indicatorId: 'maxDeg', category: '' }, 5, 10);
const cN = ov.node('ovCollectSample', { series: 'N', scope: 'experiment' }, 6, 6);
const cE = ov.node('ovCollectSample', { series: 'E', scope: 'experiment' }, 7, 6);
const cD = ov.node('ovCollectSample', { series: 'maxDegree', scope: 'experiment' }, 8, 6);
ov.fEdge(run, 'next', cN, 'do');
ov.fEdge(cN, 'next', cE, 'do');
ov.fEdge(cE, 'next', cD, 'do');
ov.vEdge(rN, 'value', cN, 'value');
ov.vEdge(rE, 'value', cE, 'value');
ov.vEdge(rD, 'value', cD, 'value');

const rowLog = ov.node('ovLog', { text: 'rule -> N = {value}' }, 9, 6);
ov.fEdge(cD, 'next', rowLog, 'do');
ov.vEdge(rN, 'value', rowLog, 'value');

const meanN = ov.node('ovSeriesStat', { series: 'N', op: 'mean' }, 2, 1);
const doneLog = ov.node('ovLog', { text: 'Sweep complete. Mean N over the rule space: {value}. Export the Series table as CSV.' }, 3, 1);
ov.fEdge(fe, 'next', doneLog, 'do');
ov.vEdge(meanN, 'result', doneLog, 'value');

const maxDegStat = ov.node('ovSeriesStat', { series: 'maxDegree', op: 'max' }, 2, 0);
const o6Log = ov.node('ovLog', { text: 'O6 check across the whole sweep - the largest degree ever observed: {value} (must be 3).' }, 4, 1);
ov.fEdge(doneLog, 'next', o6Log, 'do');
ov.vEdge(maxDegStat, 'result', o6Log, 'value');

// =============================================================================
// NON-GRAPH MODEL PARTS
// =============================================================================

// Rule tables. Both are 2 x 4 = 8 cells: [own state] x [Active neighbours 0..3].
// Row-major: index = own * 4 + activeCount.
//
// The shipped VERB rule: a Dormant node with one Active neighbour splits keeping
// slot 0; an Active node with one or two Active neighbours splits keeping slot 1
// or 0. Everything else idles. Press Randomize (or run the Overseer sweep) to
// roll a different rule.
const verbTable = [
  /* Dormant, 0 */ 1, /* 1 */ 0, /* 2 */ 1, /* 3 */ 0,
  /* Active,  0 */ 0, /* 1 */ 2, /* 2 */ 1, /* 3 */ 3,
];
// The shipped STATE rule: a Life-flavoured totalistic rule on the 3-ring.
// [Dormant,0] -> Active is what keeps the all-Dormant configuration from being
// ABSORBING — without it the automaton reaches a fixed point and never rewrites
// again, which is the first thing a hand-written rule table gets wrong.
const stateTable = [
  /* Dormant, 0 */ 1, /* 1 */ 1, /* 2 */ 0, /* 3 */ 0,
  /* Active,  0 */ 0, /* 1 */ 1, /* 2 */ 1, /* 3 */ 0,
];

const axes = () => ([
  { name: 'Own state', source: { kind: 'tagAttribute', attributeId: 'state' } },
  { name: 'Active neighbours', source: { kind: 'intRange', min: 0, max: 3 } },
]);

const attributes = [
  {
    id: 'ruleVerb', name: 'Verb Rule', type: 'lookupTable', isModelAttribute: true, defaultValue: '0',
    description:
      'What does a node DO, given its own state and how many of its three neighbours are Active? ' +
      'Idle rewrites nothing; Split A/B/C perform the triangle split, keeping the neighbour in ' +
      'bond slot 0, 1 or 2. Randomize rolls a new rule — that is the rule space this model exists to explore.',
    valueType: 'tag', valueTagOptions: VERBS,
    axes: axes(), tableData: verbTable,
    tableRoll: { seed: 11, density: 0.45, min: 1 },
  },
  {
    id: 'ruleState', name: 'State Rule', type: 'lookupTable', isModelAttribute: true, defaultValue: '0',
    description:
      'What does a node BECOME, given the same inputs? The value rule and the verb rule are rolled ' +
      'independently, so a rule is a pair of 8-cell tables.',
    valueType: 'tag', valueTagAttributeId: 'state',
    axes: axes(), tableData: stateTable,
    tableRoll: { seed: 18, density: 0.5, min: 1 },
  },
  {
    id: 'splitRate', name: 'Split Rate', type: 'float', isModelAttribute: true,
    description:
      'Upper bound on the fraction of nodes that may rewrite in one generation. A node rewrites only ' +
      'if its random priority is below this AND is the strict local minimum among its neighbours, so ' +
      'lowering it slows growth without ever letting two adjacent nodes rewrite together.',
    defaultValue: String(SPLIT_RATE), hasBounds: true, min: 0, max: 1,
  },
];

const agentAttributes = [
  {
    id: 'state', name: 'state', type: 'tag', tagOptions: STATES, defaultValue: '0',
    description: 'The node state — the alphabet the census counts and the rule tables are keyed by.',
  },
  {
    id: 'prio', name: 'prio', type: 'float', defaultValue: '0.5',
    description:
      'A fresh random priority each generation. Only a node whose priority is strictly below every ' +
      'bonded neighbour\'s may rewrite, which keeps the rewriting nodes pairwise non-adjacent.',
  },
];

const agentMappings = [
  {
    id: 'stateView', name: 'State', isAttributeToColor: true,
    description: 'Dormant / Active.',
    linked: true, linkedAttributeId: 'state',
    linkedColors: { tag: [{ r: 60, g: 72, b: 96 }, { r: 240, g: 176, b: 64 }] },
  },
];

const indicators = [
  { id: 'nodes', name: 'nodes (N)', kind: 'graph', graphMetric: 'nodeCount', dataType: 'integer', defaultValue: '0', accumulationMode: 'per-generation', watched: true },
  { id: 'edges', name: 'edges (E)', kind: 'graph', graphMetric: 'edgeCount', dataType: 'integer', defaultValue: '0', accumulationMode: 'per-generation', watched: true },
  { id: 'maxDeg', name: 'max degree', kind: 'graph', graphMetric: 'maxDegree', dataType: 'integer', defaultValue: '0', accumulationMode: 'per-generation', watched: true },
  { id: 'degHist', name: 'degree histogram', kind: 'graph', graphMetric: 'degreeHistogram', dataType: 'integer', defaultValue: '0', accumulationMode: 'per-generation', watched: true },
];

const properties = {
  name: 'Cubic GRA',
  modelAuthor: 'Rodrigo F. Figueiredo',
  description:
    'The flagship Graph-Rewriting Automaton: a 3-regular graph that rewrites itself while staying ' +
    '3-regular. A rule TABLE keyed by the neighbour census picks a verb; the triangle split adds two ' +
    'nodes and three edges in ONE generation, so min degree == max degree == 3 and E = 3N/2 hold at ' +
    'every single generation. Randomize the tables, or run the Overseer sweep over rule space.',
  ruleDescription:
    'THE OPERATION SET IS OURS. This model does not claim faithfulness to any particular published ' +
    'graph-rewriting-automata paper. The lineage (Suzudo; Tomita, Kurokawa and Murata) is canonically ' +
    '3-regular with operations chosen to preserve the degree invariant, but the exact operation sets ' +
    'in those papers are not reproduced here. We define our own cubic-preserving set and test it ' +
    'against invariants that are true of ANY cubic graph:\n\n' +
    '  triangle split   v(a,b,c) -> v1,v2,v3 with v1-a, v2-b, v3-c and the triangle v1v2, v2v3, v3v1.\n' +
    '                   Every new node has 1 external + 2 triangle edges = degree 3; a, b and c keep\n' +
    '                   degree 3. dN = +2, dE = +3, and 3N/2 + 3 = 3(N+2)/2, so E = 3N/2 survives.\n' +
    '  idle             nothing.\n\n' +
    'THE EDGE SWAP IS ABSENT, ON PURPOSE. A degree-neutral double-edge swap needs an agent to BREAK ' +
    'an edge between two OTHER agents, and there is no such verb: Break Bond and Rewire Bond are ' +
    'self-relative, and Form Bond Between only ever ADDS. Every combination of the available verbs ' +
    'that leaves the edge count unchanged also leaves every degree unchanged only when it is a no-op. ' +
    'The missing dual of Form Bond Between would close this. The triangle CONTRACT (the inverse of ' +
    'the split) is likewise omitted; a growth-only rule exercises the degree invariant fully.\n\n' +
    'HOW THE SPLIT IS EXPRESSED. From the mother\'s own behaviour, in one generation, on one request ' +
    'queue: Create Agent twice and Add Agent To World twice (host calls that consume no queue slot), ' +
    'then FIVE queued operations — Rewire Bond from b to v2, Rewire Bond from c to v3, Form Bond ' +
    'Between b and v2, Form Bond Between c and v3, and Form Bond Between v2 and v3. That last edge ' +
    'joins two agents created this very generation, and no self-relative verb can make it. The peak ' +
    'degree during the drain is exactly 3, which is why Max Bonds is a tight 3.\n\n' +
    'WHY THE PRIORITY GATE IS LOAD-BEARING. Two ADJACENT nodes must never rewrite in the same ' +
    'generation: the mother\'s Rewire needs its edge to b to still exist when the request queue is ' +
    'drained, and a splitting b would have re-pointed it away. So every node rolls a fresh random ' +
    'priority into an agent attribute each generation, and only a node whose stored priority is ' +
    'STRICTLY below every bonded neighbour\'s may rewrite. Strict inequality cannot hold both ways, so ' +
    'the rewriting nodes are pairwise non-adjacent for ANY priorities — the guarantee needs only that ' +
    'everyone reads the same generation\'s values, which synchronous update gives for free. ' +
    'Non-adjacent rewriters never conflict, because each one\'s Rewire-break precedes its own Form ' +
    'Between on the same shared neighbour, so that neighbour dips to degree 2 and returns to 3 without ' +
    'ever exceeding Max Bonds. The same roll doubles as the rate knob (priority < Split Rate).\n\n' +
    'THE RULE. Neighbour Census counts how many of the three neighbours are Active; that count and the ' +
    'node\'s own state index two 8-cell tables — one returning a VERB, one returning the NEXT STATE. ' +
    'Randomize either table (in the Attributes panel, or from the Overseer) to roll a new rule; the ' +
    'seed and density are stored, so an interesting rule reproduces exactly.\n\n' +
    'THE BOOTSTRAP. Form Bond writes the request queue at the acting agent, so it is invalid in the ' +
    'Agent Init Event. The four seeds therefore build their K4 from the behaviour graph, gated on bond ' +
    'degree 0 — a branch that runs exactly once, since a newborn already has degree 3 by its first ' +
    'behaviour step.\n\n' +
    'THE INDICATORS. Node count, edge count, max degree and the degree histogram. A cubic graph reads ' +
    'max degree 3 with the entire histogram in bucket 3, and E = 3N/2 — the invariant, visible live.\n\n' +
    'THE LAYOUT. A grown graph is only worth looking at if it can be read, and the engine\'s soft-sphere ' +
    'repulsion reaches only 1.8 units — well inside a bond rest length of 5 — so a node pushes back only ' +
    'once something is already on top of it. The long-range CHARGE force (Properties > Bond-Graph Agents) ' +
    'is what holds the structure open: every pair within its cutoff repels, with the force falling ' +
    'continuously to zero at the cutoff. A 4x-rest cutoff at strength -10 was measured against an ' +
    '8x-rest cutoff at -3: the same layout quality, 2.6x cheaper, because the spatial-hash bin edge IS ' +
    'the cutoff and the candidates it sweeps grow with its square. The world is sized to the agent CAP ' +
    'rather than to today\'s population — a 220 x 220 torus left 4.6 units per node against a bond rest ' +
    'of 5, and no repulsion strength can open a box with no room in it.\n\n' +
    'THE CADENCE. The rule hangs off a PERIODIC STEP, not a Behaviour Step: it runs on one generation in ' +
    'two, and the generation in between is pure layout relaxation. Growth otherwise outruns the force ' +
    'solver — every split tangles a neighbourhood, and the next generation splits again before it has ' +
    'untangled. Everything (priority roll, state update, rewrite) hangs off the SAME root, so state and ' +
    'structure can never drift out of phase; gating only the rewrite would quietly build a different ' +
    'automaton. Newborns are placed at the MIDPOINT between the mother and the neighbour they inherit, ' +
    'rather than at a fixed offset, so a split no longer starts with a newborn on the far side of its ' +
    'own new bond.\n\n' +
    'COMPILE TARGET. The agent layer runs on WebAssembly on purpose. The Overseer seed policy drives ' +
    'setRngSeed, which re-seeds the shared xorshift32 stream JS and WASM use; the WebGPU agent target ' +
    'seeds its per-agent PCG once at runtime creation, so a sweep there would not reproduce across ' +
    'runs. The model itself compiles and runs on all three agent targets.',
  instructions:
    'Press Play. Four seed nodes wire themselves into a K4, then the graph grows by triangle splits ' +
    'while the force layout untangles it. Watch the indicators: max degree pins at 3 and E tracks 3N/2 ' +
    'exactly — that is the whole point.\n\n' +
    'The rule runs on one generation in ' + PERIOD + ' (a Periodic Step), so the generations in between ' +
    'are pure layout relaxation — a generation is NOT a rule step here, which is worth remembering when ' +
    'reading the Overseer budget. Long-range charge repulsion is what holds the structure open; turn it ' +
    'off in Properties > Bond-Graph Agents to see what this model looked like before, and why it needed ' +
    'it.\n\n' +
    'Open the Attributes panel and press Randomize on Verb Rule or State Rule to roll a new automaton, ' +
    'or drag Split Rate to change how fast it grows. The Overseer tab runs the whole sweep: twelve ' +
    'rules, each reset to K4 and run for ' + T_RUN + ' generations, exported as a rule -> outcome table.',
  topology: '2d-grid',
  boundaryTreatment: 'torus',
  updateMode: 'synchronous',
  asyncScheme: 'random-order',
  gridWidth: W,
  gridHeight: H,
  maxIterations: 100000,
  tags: ['agents', 'graph rewriting', 'GRA', 'cubic', 'Overseer'],
  useWasm: true,
  useWebGPU: false,
  // THE CAPACITY GUARD, and it is load-bearing for O6. At the agent cap a Create
  // Agent returns -1, the split's Rewire finds no target and degrades to a bare
  // break, and the graph stops being cubic. Pausing at N = 3000 against a cap of
  // 6000 leaves a 2x margin that the fastest possible growth (bounded by the
  // independent-set gate) cannot cross inside one generation, so a running model
  // can never reach the cap. `ovRunUntilStop` in the sweep respects it too.
  endConditions: {
    enabled: true,
    indicatorConditions: [
      { id: 'capGuard', indicatorId: 'nodes', op: '>=', value: '3000' },
    ],
  },
};

const centerBased = {
  enabled: true,
  agentTarget: 'wasm',
  maxAgents: MAX_AGENTS,
  maxBonds: MAX_BONDS,
  bondRequestDepth: 8,
  worldWidth: W,
  worldHeight: H,
  seedCount: SEEDS,
  // COMPACT, not scatter: `scatter` places seeds with Math.random(), and this rule
  // is geometry-coupled through the force layout, so the Overseer sweep would not
  // reproduce. `compact` is a deterministic lattice (P6).
  seedPattern: 'compact',
  defaultRadius: RADIUS,
  growthRate: 0,
  repulsionStiffness: 0.9,
  adhesionStiffness: 0,
  interactionRange: 2.2,
  drag: 1,
  timeStep: 0.12,
  momentum: 0,
  maxSpeed: 0,
  neighbourQueryRadius: 6,
  useBondingPhysics: true,
  autoBond: false,
  bondStiffness: STIFF,
  bondRestLength: REST,
  formDistance: 1.15,
  breakDistance: 1.8,
  agentUpdateMode: 'sync',
  // L1 CHARGE — the long-range repulsion that holds the structure open. Without
  // it the soft sphere only repels once two nodes are practically touching (below
  // 1.8 units, against a bond rest of 5), so a growing graph collapses into a
  // jammed blob: 99.6 % of nodes with an unrelated node inside contact distance.
  chargeStrength: CHARGE_K,
  chargeMaxDist: CHARGE_CUTOFF,
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
  bondAttributes: [],
  agentMappings,
  agentGraphNodes: ag.nodes,
  agentGraphEdges: ag.edges,
  overseerConfig: { enabled: true, seedPolicy: 'sequential', baseSeed: 31415 },
  overseerGraphNodes: ov.nodes,
  overseerGraphEdges: ov.edges,
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
console.log(`  agent graph:    ${ag.nodes.length} nodes / ${ag.edges.length} edges`);
console.log(`  overseer graph: ${ov.nodes.length} nodes / ${ov.edges.length} edges`);
console.log(`  seeds ${SEEDS} (K4)  maxBonds ${MAX_BONDS}  queue depth 8  split = 5 queue ops`);

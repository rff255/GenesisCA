#!/usr/bin/env node
/**
 * Generates public/models/Growing Graphs.gcaproj — a port of Alex Mordvintsev's
 * (znah) "Growing Graphs" demo (znah.net/graphs), i.e. Paul Cousin's BINARY
 * CUBIC graph-rewriting automata, with znah's rule presets.
 *
 * ── THE RULE, verbatim from the reference implementation ─────────────────────
 * Every node is 3-regular and carries ONE BIT of state. Per rule tick:
 *
 *     r = ownState * 4 + (number of ON neighbours among the 3)      r in 0..7
 *     nextState = (R >> r) & 1
 *     divide    = (R >> (r + 8)) & 1
 *
 * so a whole automaton is ONE 16-bit integer R. Flagged nodes then perform the
 * TRIANGLE SPLIT: v(a,b,c) -> v, j, k with v keeping a, j taking b, k taking c,
 * plus the closing triangle v-j, v-k, j-k. Daughters inherit the mother's
 * POST-update state. dN = +2, dE = +3, and 3N/2 + 3 = 3(N+2)/2, so E = 3N/2 and
 * degree 3 survive every split — oracle O6.
 *
 * THE TWO RULE TABLES ARE THE RULE INTEGER, BIT FOR BIT. Each is a 2 x 4 lookup
 * table over [own state 0..1] x [ON neighbours 0..3]; row-major, so the flat
 * index IS znah's `r` and tableData[r] is exactly the corresponding bit of R.
 * That is why the port needs no translation layer: a preset is just R sliced
 * into two 8-entry bool arrays.
 *
 * ── THE INITIAL CONDITION IS EXACT ──────────────────────────────────────────
 * znah seeds the SAME 10-node cubic graph every run:
 *   nodes = [[9,1,2],[0,2,4],[1,3,0],[2,4,6],[3,5,1],[4,6,8],[5,7,3],[6,8,9],[7,9,5],[8,0,7]]
 *   states = [0,0,0,1,0,1,0,1,1,1]
 * which is a 10-cycle plus the five chords {0,2} {1,4} {3,6} {5,8} {7,9}. The
 * chord map is an INVOLUTION, so it is reproduced here by a 1-axis lookup table
 * indexed by the agent HANDLE: node h bonds to (h+1)%10, (h+9)%10 and chord[h].
 * Form Bond is symmetric and an already-bonded pair is an idempotent no-op, so
 * all 30 requests settle to exactly the 15 znah edges with no agent ever
 * exceeding maxBonds 3. The states come from a second handle-indexed table.
 *
 * Form Bond writes the acting agent's REQUEST QUEUE, so it is invalid in the
 * Agent Init Event: the Init Event only places the ten agents on a circle and
 * seeds their states, and the wiring happens on the first behaviour step, gated
 * on bond degree 0 (a branch that runs exactly once, since every later agent is
 * born with degree 3).
 *
 * ── THE TWO PHASES ARE THE REFERENCE'S TWO PHASES ───────────────────────────
 * znah alternates a STATE tick and a DIVISION tick, and the division tick does
 * NOT re-read the states — it replays the `dividing` flags the state tick
 * computed. That maps onto two Periodic Steps of period 2, one at each phase, so
 * ONE GenesisCA generation is ONE reference `grow()` call:
 *
 *   phase 0  census -> r -> next state (+ mutation), and the division intent
 *            stored in `prio`
 *   phase 1  split the flagged nodes; daughters inherit the mother's committed
 *            state
 *
 * ── THE ONE SEMANTIC DEVIATION, STATED HONESTLY ─────────────────────────────
 * znah divides ALL flagged nodes sequentially within a tick, including ADJACENT
 * ones. GenesisCA's structural request queue cannot: the mother's Rewire needs
 * its edge to b to still exist when the queue drains, and a splitting b would
 * have re-pointed it away. So this port splits an INDEPENDENT SET per tick.
 * A suppressed node is simply re-evaluated next tick, exactly as the reference
 * recomputes its flags every phase 0.
 *
 * HOW BIG IS THE DEVIATION? For a rule whose divide bit fires only at r = 3
 * (own OFF, three ON neighbours) two flagged nodes CANNOT be adjacent — a
 * flagged neighbour would have to be ON (from my side) and OFF (from its own) at
 * once — so the gate suppresses NOTHING and the port reproduces the reference
 * N(t) EXACTLY. Measured: `quadratic` (2182) and `exp tree` (2236) match cycle
 * for cycle over 100 cycles (verify-graph-rewrite.mjs Tier M). Where a rule CAN
 * flag two neighbours at once — `meduza` is one — the trajectory genuinely
 * differs. So: exact for one class of rules, qualitatively faithful for the
 * rest. Do not overclaim beyond that.
 *
 * THE GATE HAD TO BE INTENT-AWARE, and this is the load-bearing detail. The
 * obvious version — every node rolls a priority, split iff you are the strict
 * local minimum — costs roughly three quarters of the splits EVEN WHEN THE
 * FLAGGED NODES ARE ALREADY PAIRWISE NON-ADJACENT, because it makes a flagged
 * node wait its turn behind neighbours that never wanted to split. Measured on
 * `quadratic`, which cannot have two adjacent flagged nodes at all (a flagged
 * node is OFF with three ON neighbours, so a flagged neighbour would have to be
 * both), that did not merely slow growth: the automaton fell into its absorbing
 * all-OFF configuration and stopped at 16 nodes against the reference's 854.
 * So the priority carries the INTENT: a flagged node stores its roll in [0, 1),
 * an unflagged one stores roll + 2, and the division tick requires "below 1.5"
 * (I was flagged) AND "strictly below every neighbour's" (I won the contest).
 * A non-splitter is above 2 and therefore never blocks anyone, so a set of
 * non-adjacent flagged nodes ALL split — the reference behaviour, exactly.
 *
 * ── THE CADENCE ─────────────────────────────────────────────────────────────
 * Both phases carry rule work, so the layout gets its headroom from
 * `layoutIterations: 3` (three force passes per generation, six per full
 * reference tick) rather than from idle generations.
 *
 * ── THE LAYOUT: GLOBAL CHARGE ───────────────────────────────────────────────
 * The first shipped model to use `chargeRange: 'global'` (C10's deterministic
 * Barnes-Hut). znah's own layout is an unbounded n-body repulsion with a
 * quadtree, and the C10 benchmark found the same thing GenesisCA's own probe
 * did: for a GROWING graph a finite cutoff degrades as N rises (nnb/bond 0.53 ->
 * 0.37 from N 2.5k to 20k) while global holds flat at ~0.81 AND runs cheaper.
 *
 * Re-run after a tweak:  node scripts/gen-growing-graphs.mjs
 * Re-running preserves any saved simulationState + library thumbnail.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../public/models/Growing Graphs.gcaproj');

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

// =============================================================================
// THE REFERENCE CONSTANTS (js/graph.js + js/app.js of graphs-main)
// =============================================================================
const SEEDS = 10;
/** znah's `nodes` adjacency, flattened into the two structural facts it encodes:
 *  a 10-cycle (implicit) plus this chord involution. */
const CHORD = [2, 4, 0, 6, 1, 8, 3, 9, 5, 7];
/** znah's `states`. */
const INIT_STATE = [0, 0, 0, 1, 0, 1, 0, 1, 1, 1];

/** nextState bits: table[r] = (R >> r) & 1, r = own*4 + onNeighbours. */
const nextBits = R => Array.from({ length: 8 }, (_, r) => (R >> r) & 1);
/** divide bits: table[r] = (R >> (r + 8)) & 1  (CaseN = (NN+1)*2 = 8). */
const divideBits = R => Array.from({ length: 8 }, (_, r) => (R >> (r + 8)) & 1);

/** znah's `presets` table, verbatim (js/app.js). */
const PRESETS = [
  { name: 'quadratic', rule: 2182, flip: 0 },
  { name: 'quadratic - mutations', rule: 2182, flip: 5e-5 },
  { name: 'two branches', rule: 3260, flip: 0 },
  { name: 'branching', rule: 6259, flip: 1e-4 },
  { name: 'meduza', rule: 2502, flip: 0 },
  { name: 'exp tree', rule: 2236, flip: 0 },
  { name: 'exp hyper', rule: 618, flip: 0 },
  { name: 'exp fractal', rule: 649, flip: 0 },
  { name: 'exp symmetry', rule: 1111, flip: 0 },
  { name: 'robust linear', rule: 22220, flip: 1e-3 },
  { name: 'stable explosion', rule: 8690, flip: 1e-3 },
  { name: 'fancy tentacles', rule: 17953, flip: 5e-5 },
];
const DEFAULT_RULE = 2182;      // 'quadratic' — the demo's own default
const DEFAULT_FLIP = 0;

// =============================================================================
// TUNABLES
// =============================================================================
const MAX_BONDS = 3;            // TIGHT: nothing may transiently exceed cubic degree
const RADIUS = 0.9;
const REST = 5.0;               // bond rest length (the layout scale)
const STIFF = 0.55;
const MAX_AGENTS = 12000;
const NODE_CAP = 6000;          // the end-condition guard (a 2x margin on MAX_AGENTS)
// THE CADENCE IS THE REFERENCE'S OWN PHASE ALTERNATION. Period 2 with a rule
// rooted at EACH phase means one GenesisCA generation is one reference `grow()`
// call: phase 0 updates states and records the division intent, phase 1 divides.
const PERIOD = 2;
const LAYOUT_ITERATIONS = 3;    // force passes per generation

// THE WORLD SIZING RULE (shared with Cubic GRA / SDCA): a graph laid out by the
// charge force settles at ~1.45 x the bond rest length, so each node needs about
// (rest * 1.45)^2 of area and the world must hold the CAP, not today's count:
//     side = ceil( sqrt( 12000 * (5 * 1.45)^2 ) ) = 795  ->  800
const W = 800, H = 800;

// GLOBAL charge (C10). No cutoff term: every pair contributes, summed through a
// deterministic Barnes-Hut octree at theta = 0.9.
const CHARGE_K = -10;
const CHARGE_THETA = 0.9;

const JITTER = REST * 0.12;

// =============================================================================
// AGENT GRAPH
// =============================================================================
const ag = makeGraph();

// -----------------------------------------------------------------------------
// AGENT INIT EVENT — place the ten seeds on a circle and give them znah's states
// -----------------------------------------------------------------------------
// Deterministic: no random draw at all, so the initial condition reproduces
// exactly on every Reset regardless of where the shared RNG stream happens to be.
// The circle is sized from the LIVE world dimensions, so a simulator Resize
// re-centres and re-scales it instead of stranding the seeds in a corner.
const init = ag.node('agentInit', {}, 0, 0);
const spawn = ag.node('loop', { mode: 'count', _port_count: String(SEEDS) }, 1, 0);
ag.fEdge(init, 'do', spawn, 'do');

const TAU_OVER_N = (2 * Math.PI / SEEDS).toFixed(15);
const px = ag.node('expression', {
  expression: `w * 0.5 + w * 0.03 * cos(${TAU_OVER_N} * h)`,
  visibleCount: 2, _varName_a: 'h', _varName_b: 'w',
}, 2, -1);
ag.vEdge(spawn, 'index', px, 'a');
ag.vEdge(init, 'worldWidth', px, 'b');
const py = ag.node('expression', {
  expression: `t * 0.5 + t * 0.03 * sin(${TAU_OVER_N} * h)`,
  visibleCount: 2, _varName_a: 'h', _varName_b: 't',
}, 2, 1);
ag.vEdge(spawn, 'index', py, 'a');
ag.vEdge(init, 'worldHeight', py, 'b');

const mkSeed = ag.node('createAgent', { _port_radius: String(RADIUS) }, 3, 0);
ag.vEdge(px, 'result', mkSeed, 'x');
ag.vEdge(py, 'result', mkSeed, 'y');
const addSeed = ag.node('addAgentToWorld', {}, 4, 0);
ag.vEdge(mkSeed, 'handle', addSeed, 'handle');

// The seed's state comes from a HANDLE-indexed lookup table, so it is znah's
// `states` array literally. Create Agent allocates 0, 1, 2, … on a fresh reset,
// so the loop index and the handle agree.
const lutInit = ag.node('lookupInteraction', { tableId: 'initState' }, 3, 2);
ag.vEdge(spawn, 'index', lutInit, 'axis_0');
const seedState = ag.node('setAgentAttribute', { attributeId: 'state' }, 5, 0);
ag.vEdge(mkSeed, 'handle', seedState, 'agentId');
ag.vEdge(lutInit, 'value', seedState, 'value');

ag.fEdge(spawn, 'body', mkSeed, 'do');
ag.fEdge(mkSeed, 'next', addSeed, 'do');
ag.fEdge(addSeed, 'next', seedState, 'do');

// -----------------------------------------------------------------------------
// BEHAVIOUR STEP — the one-shot wiring of the exact znah seed graph
// -----------------------------------------------------------------------------
// This root runs EVERY generation (not on the rule cadence) but its whole body
// is gated on bond degree 0, so it fires exactly once per seed, on generation 0.
const bs = ag.node('behaviourStep', {}, 0, 4);
const deg = ag.node('getBondDegree', {}, 0, 6);
const isUnwired = ag.node('statement', { operation: '==', compareType: 'numerical', _port_y: '0' }, 1, 6);
ag.vEdge(deg, 'value', isUnwired, 'x');
const wireIf = ag.node('conditional', {}, 2, 4);
ag.fEdge(bs, 'do', wireIf, 'check');
ag.vEdge(isUnwired, 'result', wireIf, 'condition');

const selfH = ag.node('getSelfHandle', {}, 2, 2);
const nbNext = ag.node('expression', {
  expression: `(h + 1) % ${SEEDS}`, visibleCount: 1, _varName_a: 'h',
}, 3, 3);
ag.vEdge(selfH, 'handle', nbNext, 'a');
const nbPrev = ag.node('expression', {
  expression: `(h + ${SEEDS - 1}) % ${SEEDS}`, visibleCount: 1, _varName_a: 'h',
}, 3, 4);
ag.vEdge(selfH, 'handle', nbPrev, 'a');
const lutChord = ag.node('lookupInteraction', { tableId: 'chordPartner' }, 3, 5);
ag.vEdge(selfH, 'handle', lutChord, 'axis_0');

const bondCfg = { _port_restLength: String(REST), _port_stiffness: String(STIFF) };
const wire1 = ag.node('formBond', { ...bondCfg }, 4, 3);
ag.vEdge(nbNext, 'result', wire1, 'targetAgent');
const wire2 = ag.node('formBond', { ...bondCfg }, 4, 4);
ag.vEdge(nbPrev, 'result', wire2, 'targetAgent');
const wire3 = ag.node('formBond', { ...bondCfg }, 4, 5);
ag.vEdge(lutChord, 'value', wire3, 'targetAgent');
ag.fEdge(wireIf, 'then', wire1, 'do');
ag.fEdge(wire1, 'next', wire2, 'do');
ag.fEdge(wire2, 'next', wire3, 'do');

// -----------------------------------------------------------------------------
// PERIODIC STEP, PHASE 0 — the STATE tick (the reference's phase 0)
// -----------------------------------------------------------------------------
// Computes r from the CURRENT states (synchronous update means the census reads
// the previous generation through the double buffer), writes the next state, and
// stores the division intent + its tie-break in ONE number: see `prio` below.
const stateTick = ag.node('periodicStep', { period: PERIOD, phase: 0 }, 0, 9);

const census = ag.node('neighbourCensus', { attributeId: 'state', source: 'bonded' }, 0, 11);
const own = ag.node('getCellAttribute', { attributeId: 'state' }, 0, 12);
// An isolated node keeps its state and never divides — the standard graph-
// automaton convention, and here it also covers the one generation before the
// bootstrap has wired anything.
const wired = ag.node('statement', { operation: '>', compareType: 'numerical', _port_y: '0' }, 1, 11);
ag.vEdge(census, 'total', wired, 'x');
const ruleIf = ag.node('conditional', {}, 2, 9);
ag.fEdge(stateTick, 'do', ruleIf, 'check');
ag.vEdge(wired, 'result', ruleIf, 'condition');

// 1. the STATE rule + the mutation
const lutNext = ag.node('lookupInteraction', { tableId: 'ruleNext' }, 3, 11);
ag.vEdge(own, 'value', lutNext, 'axis_0');
ag.vEdge(census, 'count_1', lutNext, 'axis_1');

const mutRoll = ag.node('getRandom', { randomType: 'float', min: '0', max: '1' }, 3, 12);
const mutRate = ag.node('getModelAttribute', { attributeId: 'mutationRate' }, 3, 13);
const doFlip = ag.node('statement', { operation: '<', compareType: 'numerical' }, 4, 12);
ag.vEdge(mutRoll, 'value', doFlip, 'x');
ag.vEdge(mutRate, 'value', doFlip, 'y');
// s + f*(1 - 2s) is `f ? 1-s : s` for s, f in {0,1} — znah's `states[i] = 1 - states[i]`.
const nextState = ag.node('expression', {
  expression: 's + f * (1 - 2 * s)', visibleCount: 2, _varName_a: 's', _varName_b: 'f',
}, 5, 11);
ag.vEdge(lutNext, 'value', nextState, 'a');
ag.vEdge(doFlip, 'result', nextState, 'b');

const setState = ag.node('setAttribute', { attributeId: 'state' }, 6, 9);
ag.vEdge(nextState, 'result', setState, 'value');
ag.fEdge(ruleIf, 'then', setState, 'do');

// 2. the DIVISION INTENT, stored as a single number
//
// THE PRIORITY ENCODES BOTH THE FLAG AND THE TIE-BREAK, and that is what makes
// the independent-set gate cost nothing when it is not needed:
//     prio = roll             in [0, 1)   when the divide bit fired
//     prio = roll + 2         in [2, 3)   when it did not
// so at the DIVISION tick a node splits iff its stored priority is below 1.5
// (it was flagged) AND strictly below every bonded neighbour's (it wins the
// contest). A neighbour that did not want to split carries a value above 2 and
// therefore never blocks anyone.
//
// This is the fix for the obvious-but-wrong version of the gate. Comparing raw
// rolls — flagged or not — makes a node wait until it is the local minimum among
// ALL its neighbours, which throws away roughly three quarters of the splits
// even when the flagged nodes are already pairwise non-adjacent. For most of the
// published rules that does not merely slow growth, it changes the trajectory:
// the automaton reaches its absorbing all-OFF configuration and stops for good.
const lutDiv = ag.node('lookupInteraction', { tableId: 'ruleDivide' }, 3, 15);
ag.vEdge(own, 'value', lutDiv, 'axis_0');
ag.vEdge(census, 'count_1', lutDiv, 'axis_1');
const prioRoll = ag.node('getRandom', { randomType: 'float', min: '0', max: '1' }, 3, 16);
const prioVal = ag.node('expression', {
  expression: 'roll + (1 - d) * 2', visibleCount: 2, _varName_a: 'roll', _varName_b: 'd',
}, 5, 15);
ag.vEdge(prioRoll, 'value', prioVal, 'a');
ag.vEdge(lutDiv, 'value', prioVal, 'b');
const setPrio = ag.node('setAttribute', { attributeId: 'prio' }, 6, 12);
ag.vEdge(prioVal, 'result', setPrio, 'value');
ag.fEdge(setState, 'next', setPrio, 'do');

// -----------------------------------------------------------------------------
// PERIODIC STEP, PHASE 1 — the DIVISION tick (the reference's phase 1)
// -----------------------------------------------------------------------------
// The reference's division phase does not re-read the states either: it replays
// the flags the state tick computed. Here those flags live in `prio`.
const divideTick = ag.node('periodicStep', { period: PERIOD, phase: 1 }, 0, 16);

const myPrio = ag.node('getCellAttribute', { attributeId: 'prio' }, 0, 18);
const wasFlagged = ag.node('statement', { operation: '<', compareType: 'numerical', _port_y: '1.5' }, 1, 18);
ag.vEdge(myPrio, 'value', wasFlagged, 'x');

const bonded = ag.node('getBondedAgents', {}, 0, 17);
const nbrPrio = ag.node('getAgentsAttribute', { attributeId: 'prio' }, 1, 17);
ag.vEdge(bonded, 'agents', nbrPrio, 'agents');
const minPrio = ag.node('aggregate', { operation: 'min' }, 2, 17);
ag.vEdge(nbrPrio, 'values', minPrio, 'values');
const isLocalMin = ag.node('statement', { operation: '<', compareType: 'numerical' }, 3, 17);
ag.vEdge(myPrio, 'value', isLocalMin, 'x');
ag.vEdge(minPrio, 'result', isLocalMin, 'y');

const isCubic = ag.node('statement', { operation: '==', compareType: 'numerical', _port_y: '3' }, 3, 18);
ag.vEdge(deg, 'value', isCubic, 'x');

const gate1 = ag.node('logicOperator', { operation: 'AND' }, 5, 16);
ag.vEdge(wasFlagged, 'result', gate1, 'a');
ag.vEdge(isLocalMin, 'result', gate1, 'b');
const gate2 = ag.node('logicOperator', { operation: 'AND' }, 6, 16);
ag.vEdge(gate1, 'result', gate2, 'a');
ag.vEdge(isCubic, 'result', gate2, 'b');

const splitIf = ag.node('conditional', {}, 7, 16);
ag.fEdge(divideTick, 'do', splitIf, 'check');
ag.vEdge(gate2, 'result', splitIf, 'condition');

// The daughters inherit the mother's state, which by the division tick IS the
// post-update (post-mutation) state the state tick committed — exactly the
// reference's `states.push(states[i], states[i])`.
const stateNow = ag.node('getCellAttribute', { attributeId: 'state' }, 7, 19);

// 5. THE TRIANGLE SPLIT — 5 queue ops, maxBonds 3
// The mother keeps bond slot 0 and hands slots 1 and 2 to the daughters. WHICH
// slot is kept is irrelevant to the resulting graph: all three post-split nodes
// sit on the triangle with one external edge each, so permuting {a,b,c} among
// them gives an isomorphic graph.
const bAgent = ag.node('arrayElement', { _port_position: '1' }, 1, 20);
ag.vEdge(bonded, 'agents', bAgent, 'array');
const cAgent = ag.node('arrayElement', { _port_position: '2' }, 1, 21);
ag.vEdge(bonded, 'agents', cAgent, 'array');

// NEWBORN PLACEMENT: the MIDPOINT between the mother and the neighbour the
// newborn inherits, so a split never starts with a daughter on the far side of
// the mother from its own new bond. Get Agent Position in RELATIVE mode gives
// the shortest offset (and is correct across a torus seam); the jitter comes
// from this tick's priority roll, mirrored between the two daughters so they
// never land on top of each other.
const selfPos = ag.node('getSelfPosition', {}, 8, 20);
const offB = ag.node('getAgentPosition', { mode: 'relative' }, 8, 18);
ag.vEdge(bAgent, 'value', offB, 'agentId');
const offC = ag.node('getAgentPosition', { mode: 'relative' }, 8, 22);
ag.vEdge(cAgent, 'value', offC, 'agentId');

const midpoint = (col, row, offNode, axis, sign) => {
  const n = ag.node('expression', {
    expression: `self + toward * 0.5 ${sign} (jitter - 0.5) * ${JITTER}`,
    visibleCount: 3, _varName_a: 'self', _varName_b: 'toward', _varName_c: 'jitter',
  }, col, row);
  ag.vEdge(selfPos, axis, n, 'a');
  ag.vEdge(offNode, axis, n, 'b');
  ag.vEdge(myPrio, 'value', n, 'c');
  return n;
};
const x2 = midpoint(9, 18, offB, 'x', '+');
const y2 = midpoint(9, 19, offB, 'y', '+');
const x3 = midpoint(9, 21, offC, 'x', '-');
const y3 = midpoint(9, 22, offC, 'y', '-');

const mkJ = ag.node('createAgent', { _port_radius: String(RADIUS) }, 10, 18);
ag.vEdge(x2, 'result', mkJ, 'x');
ag.vEdge(y2, 'result', mkJ, 'y');
const addJ = ag.node('addAgentToWorld', {}, 11, 18);
ag.vEdge(mkJ, 'handle', addJ, 'handle');
// Daughters inherit the mother's POST-update (and post-mutation) state, exactly
// as znah's `states.push(states[i], states[i])` does in its division phase. The
// target is a one-hop Create Agent handle, so this is the documented spawn-
// configuration exemption from the synchronous cross-agent write gate.
const stJ = ag.node('setAgentAttribute', { attributeId: 'state' }, 12, 18);
ag.vEdge(mkJ, 'handle', stJ, 'agentId');
ag.vEdge(stateNow, 'value', stJ, 'value');

const mkK = ag.node('createAgent', { _port_radius: String(RADIUS) }, 10, 21);
ag.vEdge(x3, 'result', mkK, 'x');
ag.vEdge(y3, 'result', mkK, 'y');
const addK = ag.node('addAgentToWorld', {}, 11, 21);
ag.vEdge(mkK, 'handle', addK, 'handle');
const stK = ag.node('setAgentAttribute', { attributeId: 'state' }, 12, 21);
ag.vEdge(mkK, 'handle', stK, 'agentId');
ag.vEdge(stateNow, 'value', stK, 'value');

const bondOp = (col, row, type, wire) => {
  const n = ag.node(type, { ...bondCfg }, col, row);
  wire(n);
  return n;
};
const rwB = bondOp(13, 18, 'rewireBond', n => { ag.vEdge(bAgent, 'value', n, 'fromAgent'); ag.vEdge(mkJ, 'handle', n, 'toAgent'); });
const rwC = bondOp(13, 19, 'rewireBond', n => { ag.vEdge(cAgent, 'value', n, 'fromAgent'); ag.vEdge(mkK, 'handle', n, 'toAgent'); });
const fbB = bondOp(13, 20, 'formBondBetween', n => { ag.vEdge(bAgent, 'value', n, 'agentA'); ag.vEdge(mkJ, 'handle', n, 'agentB'); });
const fbC = bondOp(13, 21, 'formBondBetween', n => { ag.vEdge(cAgent, 'value', n, 'agentA'); ag.vEdge(mkK, 'handle', n, 'agentB'); });
const fbJK = bondOp(13, 22, 'formBondBetween', n => { ag.vEdge(mkJ, 'handle', n, 'agentA'); ag.vEdge(mkK, 'handle', n, 'agentB'); });

ag.fEdge(splitIf, 'then', mkJ, 'do');
ag.fEdge(mkJ, 'next', addJ, 'do');
ag.fEdge(addJ, 'next', stJ, 'do');
ag.fEdge(stJ, 'next', mkK, 'do');
ag.fEdge(mkK, 'next', addK, 'do');
ag.fEdge(addK, 'next', stK, 'do');
ag.fEdge(stK, 'next', rwB, 'do');
ag.fEdge(rwB, 'next', rwC, 'do');
ag.fEdge(rwC, 'next', fbB, 'do');
ag.fEdge(fbB, 'next', fbC, 'do');
ag.fEdge(fbC, 'next', fbJK, 'do');

// -----------------------------------------------------------------------------
// AGENT OUTPUT MAPPING — "Birth generation", znah's signature look
// -----------------------------------------------------------------------------
// znah colours each node by the generation it was BORN in, normalised by the
// current generation, so the structure reads as a growth history: the oldest
// core in deep indigo, the newest frontier bright. Age is engine-owned and
// advances once per generation, so birth generation = generation - age.
const omGen = ag.node('agentOutputMapping', { mappingId: 'birthView' }, 0, 25);
const genNow = ag.node('getGeneration', {}, 0, 26);
const myAge = ag.node('getAge', {}, 0, 27);
const birthT = ag.node('expression', {
  expression: '(g - a) / (g + 1)', visibleCount: 2, _varName_a: 'g', _varName_b: 'a',
}, 1, 26);
ag.vEdge(genNow, 'value', birthT, 'a');
ag.vEdge(myAge, 'value', birthT, 'b');
const scale = ag.node('colorScale', {
  method: 'linear',
  stopCount: 5,
  stop_0_position: '0',    stop_0_r: '16',  stop_0_g: '10',  stop_0_b: '60',
  stop_1_position: '0.35', stop_1_r: '90',  stop_1_g: '30',  stop_1_b: '150',
  stop_2_position: '0.65', stop_2_r: '215', stop_2_g: '60',  stop_2_b: '135',
  stop_3_position: '0.88', stop_3_r: '250', stop_3_g: '150', stop_3_b: '80',
  stop_4_position: '1',    stop_4_r: '255', stop_4_g: '245', stop_4_b: '200',
}, 2, 26);
ag.vEdge(birthT, 'result', scale, 't');
const paint = ag.node('setCellLooks', {
  mappingId: 'birthView', useGlyph: false, setBackground: true, fallbackToGlyphColor: false,
}, 3, 25);
ag.vEdge(scale, 'r', paint, 'r');
ag.vEdge(scale, 'g', paint, 'g');
ag.vEdge(scale, 'b', paint, 'b');
ag.fEdge(omGen, 'do', paint, 'do');

// =============================================================================
// NON-GRAPH MODEL PARTS
// =============================================================================

/** The rule axes: [own state 0..1] x [ON neighbours 0..3]. Row-major, so the
 *  flat index is own*4 + onCount — znah's `r`, exactly. */
const ruleAxes = () => ([
  { name: 'Own state', source: { kind: 'intRange', min: 0, max: 1 } },
  { name: 'ON neighbours', source: { kind: 'intRange', min: 0, max: 3 } },
]);

const attributes = [
  {
    id: 'ruleNext', name: 'Next State', type: 'lookupTable', isModelAttribute: true, defaultValue: '0',
    description:
      'What does a node BECOME, given its own bit and how many of its three neighbours are ON? ' +
      'Row-major, so the flat cell index is exactly the reference implementation\'s case index ' +
      'r = own*4 + onCount, and this table IS the low byte of the rule integer, bit for bit. ' +
      'Randomize it to roll a new automaton (the presets carry the published rules).',
    valueType: 'bool',
    axes: ruleAxes(), tableData: nextBits(DEFAULT_RULE),
    tableRoll: { seed: 2182, density: 0.5 },
  },
  {
    id: 'ruleDivide', name: 'Divide', type: 'lookupTable', isModelAttribute: true, defaultValue: '0',
    description:
      'Does a node SPLIT, given the same two inputs? This table is the HIGH byte of the rule ' +
      'integer (bit r+8). A flagged node performs the triangle split, which keeps the graph ' +
      '3-regular. The reference generator sets only one or two of these eight bits at random, ' +
      'so a low Randomize density is the honest way to explore rule space here.',
    valueType: 'bool',
    axes: ruleAxes(), tableData: divideBits(DEFAULT_RULE),
    tableRoll: { seed: 2182, density: 0.25 },
  },
  {
    id: 'mutationRate', name: 'Mutation Rate', type: 'float', isModelAttribute: true,
    description:
      'Per node, per rule tick, the probability that the new state is FLIPPED after the table ' +
      'decided it — the reference implementation\'s flipProb. Several published rules need it: ' +
      'they stall into a fixed point without noise and grow indefinitely with a little.',
    defaultValue: String(DEFAULT_FLIP), hasBounds: true, min: 0, max: 0.01,
  },
  {
    id: 'chordPartner', name: 'Seed Chords', type: 'lookupTable', isModelAttribute: true, defaultValue: '0',
    description:
      'BOOTSTRAP HELPER, not part of the rule. The chord of the initial 10-node cubic graph: ' +
      'node h bonds to (h+1) mod 10, (h+9) mod 10 and chordPartner[h]. The map is an involution, ' +
      'so the 30 symmetric Form Bond requests settle to exactly the reference graph\'s 15 edges.',
    valueType: 'integer',
    axes: [{ name: 'Seed handle', source: { kind: 'intRange', min: 0, max: SEEDS - 1 } }],
    tableData: CHORD.slice(),
  },
  {
    id: 'initState', name: 'Seed States', type: 'lookupTable', isModelAttribute: true, defaultValue: '0',
    description:
      'BOOTSTRAP HELPER, not part of the rule. The reference implementation\'s initial state ' +
      'vector [0,0,0,1,0,1,0,1,1,1], indexed by the seed handle.',
    valueType: 'bool',
    axes: [{ name: 'Seed handle', source: { kind: 'intRange', min: 0, max: SEEDS - 1 } }],
    tableData: INIT_STATE.slice(),
  },
];

const agentAttributes = [
  {
    id: 'state', name: 'state', type: 'bool', defaultValue: 'false',
    description: 'The node\'s single bit — the alphabet the census counts and both rule tables are keyed by.',
  },
  {
    id: 'prio', name: 'prio', type: 'float', defaultValue: '2.5',
    description:
      'The division intent AND its tie-break in one number, written by the state tick and read by ' +
      'the division tick: a flagged node stores its random roll in [0, 1), an unflagged one stores ' +
      'roll + 2. A node splits only if its value is below 1.5 (it was flagged) and strictly below ' +
      'every bonded neighbour\'s (it won the contest), so the splitters are pairwise non-adjacent ' +
      'while a neighbour that does not want to split never blocks anyone. The default is a ' +
      'non-splitter value, so a newborn can never look flagged before its first state tick.',
  },
];

const agentMappings = [
  {
    id: 'birthView', name: 'Birth generation', isAttributeToColor: true,
    description:
      'The reference demo\'s look: colour by the generation a node was born in, normalised by the ' +
      'current generation, so the oldest core is deep indigo and the growing frontier is bright.',
    linked: false,
  },
  {
    id: 'stateView', name: 'State', isAttributeToColor: true,
    description: 'The node bit: OFF / ON.',
    linked: true, linkedAttributeId: 'state',
    linkedColors: { gradient: [{ position: 0, r: 52, g: 60, b: 84 }, { position: 1, r: 250, g: 208, b: 100 }] },
  },
];

const indicators = [
  { id: 'nodes', name: 'nodes (N)', kind: 'graph', graphMetric: 'nodeCount', dataType: 'integer', defaultValue: '0', accumulationMode: 'per-generation', watched: true },
  { id: 'edges', name: 'edges (E)', kind: 'graph', graphMetric: 'edgeCount', dataType: 'integer', defaultValue: '0', accumulationMode: 'per-generation', watched: true },
  { id: 'maxDeg', name: 'max degree', kind: 'graph', graphMetric: 'maxDegree', dataType: 'integer', defaultValue: '0', accumulationMode: 'per-generation', watched: true },
];

// --- presets: one per published rule -----------------------------------------
const PRESET_BASE_TIMESTAMP = 1754000000000;
const presets = PRESETS.map((p, i) => ({
  id: newId('preset_'),
  name: p.name,
  description: `Rule ${p.rule} (0x${p.rule.toString(16).toUpperCase()})`
    + (p.flip > 0 ? `, mutation ${p.flip}` : ', no mutation'),
  state: {
    schemaVersion: 2,
    lookupTableData: { ruleNext: nextBits(p.rule), ruleDivide: divideBits(p.rule) },
    modelAttrs: { mutationRate: p.flip },
  },
  createdAt: PRESET_BASE_TIMESTAMP + i * 1000,
}));

const properties = {
  name: 'Growing Graphs',
  modelAuthor: 'Rodrigo F. Figueiredo',
  description:
    'Binary cubic graph-rewriting automata after Paul Cousin, ported from Alex Mordvintsev\'s ' +
    '(znah) Growing Graphs demo. Every node carries one bit and exactly three neighbours; one ' +
    '16-bit integer defines both the state rule and the division rule, and the triangle split keeps ' +
    'the graph 3-regular forever. Twelve presets carry the published rules.',
  ruleDescription:
    'CREDIT. The automaton family is Paul Cousin\'s binary cubic Graph-Rewriting Automata; this ' +
    'model is a port of Alex Mordvintsev\'s (znah) "Growing Graphs" demo, znah.net/graphs, and the ' +
    'twelve presets are that demo\'s published rule table.\n\n' +
    'THE RULE. Every node is 3-regular and holds one bit. Per rule tick a node computes\n' +
    '    r = own state x 4 + (number of ON neighbours)          r in 0..7\n' +
    '    next state = bit r of the rule integer\n' +
    '    divide     = bit r+8 of the rule integer\n' +
    'so a whole automaton is ONE 16-bit number. The two lookup tables in the Attributes panel ARE ' +
    'that number: each is 2 x 4 over [own state] x [ON neighbours], row-major, so a table cell\'s ' +
    'flat index is exactly r and its value is exactly the corresponding bit. Load a preset to see ' +
    'a published rule; Randomize a table to roll a new one.\n\n' +
    'THE TRIANGLE SPLIT. A flagged node v(a, b, c) becomes v, j, k: v keeps a, j takes b, k takes ' +
    'c, and the three of them close a triangle. Every one of them has one external edge plus two ' +
    'triangle edges = degree 3, so dN = +2, dE = +3 and E = 3N/2 survives (3N/2 + 3 = 3(N+2)/2). ' +
    'The daughters inherit the mother\'s post-update state. In GenesisCA that is five queued ' +
    'operations from the mother\'s own behaviour in ONE generation — two Rewire Bonds and three ' +
    'Form Bond Betweens (Create Agent and Add Agent To World are host calls that consume no queue ' +
    'slot). Peak degree during the drain is exactly 3, which is why Max Bonds is a tight 3.\n\n' +
    'THE INITIAL CONDITION IS EXACT. The reference implementation always seeds the same 10-node ' +
    'cubic graph — a 10-cycle plus the chords {0,2} {1,4} {3,6} {5,8} {7,9} — with the states ' +
    '[0,0,0,1,0,1,0,1,1,1]. Here the Agent Init Event places ten agents on a circle and reads their ' +
    'states from a handle-indexed table; the wiring happens on the first behaviour step (Form Bond ' +
    'writes the acting agent\'s request queue, so it is invalid in an Init Event), gated on bond ' +
    'degree 0 so it runs exactly once. Each node requests bonds to (h+1) mod 10, (h+9) mod 10 and ' +
    'its chord partner; Form Bond is symmetric and an existing bond is an idempotent no-op, so the ' +
    'thirty requests settle to precisely the reference graph\'s fifteen edges.\n\n' +
    'THE TWO PHASES ARE THE REFERENCE\'S TWO PHASES. The reference alternates a STATE tick and a ' +
    'DIVISION tick, and the division tick does not re-read the states — it replays the flags the ' +
    'state tick computed. Here that is two Periodic Steps of period 2, one rooted at each phase, so ' +
    'ONE generation is ONE reference tick: phase 0 runs the census, writes the next state and ' +
    'records the division intent; phase 1 splits the flagged nodes, and the daughters inherit the ' +
    'state phase 0 committed. Synchronous agent update is what makes phase 0 a true synchronous CA ' +
    '— the census reads the previous generation through the double buffer.\n\n' +
    'THE ONE SEMANTIC DEVIATION, STATED PLAINLY. The reference divides every flagged node within a ' +
    'tick, sequentially, including ADJACENT ones. GenesisCA\'s structural request queue cannot do ' +
    'that: the mother\'s Rewire needs its edge to b to still exist when the queue drains, and a ' +
    'splitting b would already have re-pointed it away. So this port splits an INDEPENDENT SET per ' +
    'tick, and a suppressed node is simply re-evaluated next tick — exactly as the reference ' +
    'recomputes its flags every phase 0.\n\n' +
    'HOW BIG IS THAT DEVIATION? Smaller than it sounds, and measurably so. For a rule whose divide ' +
    'bit fires only when a node is OFF with all three neighbours ON, two flagged nodes cannot be ' +
    'adjacent at all — a flagged neighbour would have to be ON (as seen from me) and OFF (as seen ' +
    'from itself) at the same time — so the independent set is the whole flagged set and this port ' +
    'reproduces the reference node count EXACTLY, cycle for cycle. That is verified for "quadratic" ' +
    'and "exp tree" over a hundred cycles. Where a rule CAN flag two neighbours at once — "meduza" ' +
    'is one — the trajectory genuinely differs. So: exact for one class of rules, qualitatively ' +
    'faithful for the rest.\n\n' +
    'HOW THE INDEPENDENT SET IS CHOSEN, AND WHY IT HAD TO BE INTENT-AWARE. The state tick stores ' +
    'the division intent and its tie-break in ONE number, the agent attribute "prio": a flagged node ' +
    'stores a random roll in [0, 1), an unflagged one stores that roll plus 2. The division tick ' +
    'then splits a node only if its value is below 1.5 (it was flagged) AND strictly below every ' +
    'bonded neighbour\'s (it won the contest). Strict inequality cannot hold both ways, so the ' +
    'splitters are pairwise non-adjacent for any rolls; and a node that did not want to split sits ' +
    'above 2, so it never blocks anyone. That last part is not a nicety. The obvious version of the ' +
    'gate — compare raw rolls, flagged or not — makes a flagged node wait until it is the local ' +
    'minimum among ALL its neighbours, which discards roughly three quarters of the splits even when ' +
    'the flagged nodes are already pairwise non-adjacent, and for several published rules that is ' +
    'enough to drop the automaton into its absorbing all-OFF configuration and stop it dead.\n\n' +
    'THE CADENCE. Both phases carry rule work, so the force solver gets its headroom from three ' +
    'force passes per generation (six per full reference tick) rather than from idle generations.\n\n' +
    'THE LAYOUT. Long-range GLOBAL charge: every pair repels, summed through a deterministic ' +
    'Barnes-Hut octree rather than cut off at a radius. That matches the reference demo\'s own ' +
    'n-body layout, and it is what a growing graph needs — a finite cutoff degrades as the ' +
    'population rises while global holds its quality flat.\n\n' +
    'COMPILE TARGET. Engine is set to Auto with an Exact reproducibility contract, so the agent ' +
    'layer resolves to WebAssembly: the WebGPU agent target seeds its per-agent RNG once at runtime ' +
    'creation, so a fixed seed would not replay there. Everything else about the model runs on all ' +
    'three agent targets.',
  instructions:
    'Press Play. Ten seed nodes wire themselves into the reference implementation\'s exact starting ' +
    'graph, then the automaton grows by triangle splits while the force layout untangles it. Watch ' +
    'the indicators: max degree pins at 3 and E tracks 3N/2 exactly, forever.\n\n' +
    'The two viewers are the point. "Birth generation" is the reference demo\'s look — each node ' +
    'coloured by when it was born, so the structure reads as its own growth history. "State" shows ' +
    'the single bit the rule runs on.\n\n' +
    'Open the Presets list and load the published rules: quadratic grows steadily, meduza and exp ' +
    'tree take completely different shapes, and the mutation presets keep rules alive that stall ' +
    'without noise. Mutation Rate is a live slider — nudge it on a stalled rule and watch it ' +
    'restart. In the Attributes panel, Randomize either rule table to roll an automaton nobody has ' +
    'seen; the seed and density are stored, so an interesting one reproduces exactly.\n\n' +
    'One generation is one reference tick, alternating a state phase and a division phase, so the ' +
    'node count moves on every other generation. The simulation pauses at ' + NODE_CAP + ' nodes so ' +
    'a runaway rule can never reach the agent cap.',
  topology: '2d-grid',
  boundaryTreatment: 'constant',
  updateMode: 'synchronous',
  asyncScheme: 'random-order',
  gridWidth: W,
  gridHeight: H,
  maxIterations: 100000,
  tags: ['agents', 'graph rewriting', 'GRA', 'cubic', 'znah'],
  // C4/C5 — declare the CHOICE, not the mirror: Auto + an Exact contract resolve
  // the agent layer to WebAssembly (a seeded run must replay). The mirror below
  // is the grid layer, which this agents-only model does not use.
  engine: 'auto',
  reproducibility: 'exact',
  useWasm: true,
  useWebGPU: false,
  // THE CAPACITY GUARD, load-bearing for the cubic invariant: at the agent cap a
  // Create Agent returns -1, the split's Rewire finds no target and degrades to a
  // bare break, and the graph stops being 3-regular. Pausing at half the cap
  // leaves a margin the fastest possible growth cannot cross in one generation.
  endConditions: {
    enabled: true,
    indicatorConditions: [
      { id: 'capGuard', indicatorId: 'nodes', op: '>=', value: String(NODE_CAP) },
    ],
  },
};

const centerBased = {
  enabled: true,
  agentTarget: 'auto',
  maxAgents: MAX_AGENTS,
  maxBonds: MAX_BONDS,
  bondRequestDepth: 8,
  worldWidth: W,
  worldHeight: H,
  seedCount: 0,                 // the Agent Init Event places the ten seeds
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
  // C10 — GLOBAL charge (deterministic Barnes-Hut). No cutoff: every pair
  // contributes. `chargeMaxDist` is unused in this mode and is left off.
  chargeStrength: CHARGE_K,
  chargeRange: 'global',
  chargeTheta: CHARGE_THETA,
  layoutIterations: LAYOUT_ITERATIONS,
  agentCapabilities: {
    motion: 'force', body: true, collision: 'soft', bonds: 'physics', autoBond: false,
    charge: 'on',
    // LIFESPAN is on because the "Birth generation" viewer reads Get Age — the
    // capability gate would otherwise hide a node this model actually uses.
    growth: false, division: false, lifespan: true, populationBirth: true,
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
  presets,
};

mkdirSync(dirname(OUT), { recursive: true });

let preserved = null;
if (existsSync(OUT)) {
  try {
    const prev = JSON.parse(readFileSync(OUT, 'utf-8'));
    preserved = { simulationState: prev.simulationState, thumbnail: prev.properties?.thumbnail };
  } catch { /* regenerate from scratch */ }
}
if (preserved?.simulationState) model.simulationState = preserved.simulationState;
if (preserved?.thumbnail) model.properties.thumbnail = preserved.thumbnail;

writeFileSync(OUT, JSON.stringify(model, null, 1));
console.log(`wrote ${OUT}`);
console.log(`  agent graph: ${ag.nodes.length} nodes / ${ag.edges.length} edges`);
console.log(`  seeds ${SEEDS} (10-cycle + 5 chords = 15 edges)  maxBonds ${MAX_BONDS}  split = 5 queue ops`);
console.log(`  default rule ${DEFAULT_RULE}  next=[${nextBits(DEFAULT_RULE)}]  divide=[${divideBits(DEFAULT_RULE)}]`);
console.log(`  presets: ${presets.length}`);

#!/usr/bin/env node
/**
 * Generates public/models/Growing Graphs.gcaproj — a port of Alex Mordvintsev's
 * (znah) "Growing Graphs" demo (znah.net/graphs), i.e. Paul Cousin's BINARY
 * CUBIC graph-rewriting automata, with znah's full published rule catalogue.
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
 * ── THE INITIAL CONDITION IS EXACT, SLOT ORDER INCLUDED ─────────────────────
 * znah seeds the SAME 10-node cubic graph every run:
 *   nodes = [[9,1,2],[0,2,4],[1,3,0],[2,4,6],[3,5,1],[4,6,8],[5,7,3],[6,8,9],[7,9,5],[8,0,7]]
 *   states = [0,0,0,1,0,1,0,1,1,1]
 * which is a 10-cycle plus the five chords {0,2} {1,4} {3,6} {5,8} {7,9}, and
 * EVERY row is literally [prev, next, chord]. The chord map is an INVOLUTION,
 * so it is reproduced here by a 1-axis lookup table indexed by the agent HANDLE.
 *
 * THE SLOT ORDER MATTERS, so the bonds are formed in a SCRIPTED GLOBAL ORDER.
 * A bond APPENDS to both endpoints' lists, so a node's slot order is its three
 * incident edges sorted by formation time — and slot order is what the split
 * reads (the mother keeps slot 0 and hands slots 1 and 2 to its daughters), so
 * it propagates into the geometry forever. The drain applies queues in ASCENDING
 * AGENT ORDER, so a global order is scripted by choosing WHICH agent issues each
 * bond:
 *     agent h  issues  form(h+1)                       ALWAYS   (the cycle edge)
 *     agent h  issues  form(chord[h])  iff chord[h] < h         (the chord)
 * i.e. the higher endpoint owns each chord and nobody issues its `prev` edge
 * (the previous agent already did, as its `next`). That lays the ten cycle edges
 * down in order e0, e1, ... e9 with each chord landing right after both its
 * endpoints' cycle edges, which reproduces [prev, next, chord] for NINE of the
 * ten nodes.
 *
 * NODE 0 CANNOT MATCH, and that is a proof, not a shortfall. Node h's prev-edge
 * is e(h-1) and its next-edge is e(h), so [prev, next] for EVERY h would need
 * t(e9) < t(e0) < t(e1) < ... < t(e9) — a cycle. Exactly one node must carry its
 * cycle edges the other way round; here it is node 0, which gets [1, 9, 2]
 * instead of [9, 1, 2].
 *
 * Form Bond writes the acting agent's REQUEST QUEUE, so it is invalid in the
 * Agent Init Event: the Init Event only places the ten agents on a circle and
 * seeds their states, and the wiring happens on the first behaviour step, gated
 * on bond degree 0 (a branch that runs exactly once, since every later agent is
 * born with degree 3).
 *
 * ── LATCH + MULTI-ROUND DRAIN: znah's division semantics, faithfully ─────────
 * The reference's phase 1 walks the flags its phase 0 LATCHED and divides EVERY
 * flagged node, sequentially, each one reading the LIVE adjacency — so a node
 * whose neighbour already split divides against its UPDATED neighbourhood. A
 * flag is consumed exactly once; newborns never divide in the same tick.
 *
 * GenesisCA's structural request queue drains in parallel, and two ADJACENT
 * splitters corrupt each other (the mother's Transfer needs its edge to b to still
 * exist when the queue drains, and a splitting b would have re-pointed it away).
 * So one generation can only ever split an INDEPENDENT SET. The port therefore
 * spends SEVERAL generations on one reference tick:
 *
 *     phase 0            the STATE tick: census -> r -> next state (+ mutation),
 *                        and LATCH the divide bit into `prio` (see below)
 *     phases 1 .. K      DIVISION ROUNDS: every still-latched node that wins the
 *                        intent-aware contest among its bonded neighbours splits
 *                        and CLEARS its own latch; the losers keep theirs and
 *                        try again next round, against the adjacency the winners
 *                        just rewrote
 *
 * That is znah's mutated-adjacency drain, executed in independent-set rounds
 * instead of in index order. Because a flag is consumed exactly once and every
 * flagged node eventually consumes it, dN per reference tick equals the
 * reference's exactly, provided the drain FINISHES inside K rounds.
 *
 * WHAT K COSTS, AND WHY IT IS NOT A CURE. A node loses a round only if a bonded
 * neighbour holds a lower priority, so a path of flagged nodes with ASCENDING
 * handles drains ONE PER ROUND and the rounds a tick needs are the longest such
 * chain. The reference has no such limit: it divides sequentially in index
 * order, so one pass covers a chain of any length. K is therefore chosen by
 * MEASUREMENT (see the K block in TUNABLES) and it does NOT make the drain
 * finish — raising it only postpones the residue.
 *
 * THE RESIDUAL DEVIATION, STATED HONESTLY. A node still latched after round K is
 * simply re-latched by the next state tick (the state tick OVERWRITES the latch,
 * exactly as the reference recomputes its flags every phase 0), i.e. it divides
 * a tick late. Measured over the eighteen mutation-free published rules, that
 * costs exactly ONE of them its N(t) exactness: `exp hyper`, from cycle 26. The
 * other seventeen match the reference cycle for cycle, and every rule stays
 * exactly 3-regular with E = 3N/2 throughout.
 *
 * The LABELLED graph, by contrast, is now the reference's: all four adjacency
 * rows a split touches match slot for slot (see the split block), so on
 * `quadratic` and `exp tree` the port's edge set is IDENTICAL to the
 * reference's, edge for edge at the same node ids.
 *
 * THE LATCH IS THE PRIORITY, and that is the load-bearing detail. The gate must
 * be INTENT-AWARE: the obvious version — every node takes a priority, split iff
 * you are the strict local minimum — makes a flagged node wait behind neighbours
 * that never wanted to split, which costs roughly three quarters of the splits
 * EVEN WHEN THE FLAGGED NODES ARE ALREADY PAIRWISE NON-ADJACENT. Measured on
 * `quadratic`, that did not merely slow growth: the automaton fell into its
 * absorbing all-OFF configuration and stopped at 16 nodes against the
 * reference's 854. So the flag and the tie-break live in ONE number:
 *     prio = the agent's own HANDLE   in [0, maxAgents)   flagged
 *     prio = PRIO_UNFLAGGED (1e6)                          not flagged
 * a node splits iff prio < PRIO_FLAG_LIMIT (1e5, i.e. it is still latched) AND
 * prio < every bonded neighbour's, and a splitter writes PRIO_UNFLAGGED — which
 * BOTH clears its latch and stops it blocking the neighbours it failed to let
 * through. A separate boolean `flagged` would duplicate what `prio < 1e5`
 * already says and could drift from it.
 *
 * THE PRIORITY IS THE HANDLE, so the drain order is DETERMINISTIC ASCENDING
 * HANDLE — which is exactly the reference's index walk, because Create Agent
 * allocates 0, 1, 2, ... and this model never kills an agent, so handle ==
 * znah's node index. An earlier port used a random roll here; that made the
 * within-tick split order (and therefore which neighbour each daughter inherits,
 * and therefore the whole embedding) vary run to run. Handles are unique, so the
 * strict inequality still resolves every contest and one round's splitters are
 * still pairwise non-adjacent.
 *
 * The constants are chosen to be EXACT IN f32 as well as f64 (the WebGPU agent
 * target stores agent attributes as f32): every value in play is an integer
 * below 2^24, so no comparison can be decided by a rounding artefact.
 *
 * ── THE CADENCE ─────────────────────────────────────────────────────────────
 * One reference tick is PERIOD = 1 + K generations, so the layout gets
 * PERIOD x layoutIterations force passes per rewrite — more relaxation per
 * rewrite than the old 2-generation cadence gave, at a LOWER per-generation
 * cost.
 *
 * ── THE LAYOUT: GLOBAL CHARGE ───────────────────────────────────────────────
 * The first shipped model to use `chargeRange: 'global'` (C10's deterministic
 * Barnes-Hut). znah's own layout is an unbounded n-body repulsion with a
 * quadtree, and the C10 benchmark found the same thing GenesisCA's own probe
 * did: for a GROWING graph a finite cutoff degrades as N rises (nnb/bond 0.53 ->
 * 0.37 from N 2.5k to 20k) while global holds flat at ~0.81 AND runs cheaper.
 *
 * Re-run after a tweak:  node scripts/gen-growing-graphs.mjs
 * `GG_ROUNDS=<n>` overrides K — the hook the K measurement drives.
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

/** znah's NAMED `presets` table, verbatim (js/app.js), in its own order. */
const NAMED_PRESETS = [
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
/** znah's `rules` dropdown — the CURATED catalogue, 22 rules (js/app.js line 18).
 *  Eleven of them have no preset name; those ship here as "Rule <n>". */
const RULE_CATALOGUE = [
  2502, 6259, 0x426, 0x8a2, 0x8ae, 0x886, 0x887, 0x8bc, 0x457, 0x26a, 0x409,
  0x1016, 0x897, 0x4625, 0x4621, 0x6621, 0x56cc, 0xcbc, 0x3051, 0x1082, 0x289, 0x21f2,
];
const namedRules = new Set(NAMED_PRESETS.map(p => p.rule));
/** The unnamed remainder, ascending — one preset each, no mutation (the
 *  dropdown carries no flipProb for them either; Mutation Rate stays live). */
const NUMBERED_PRESETS = [...new Set(RULE_CATALOGUE)]
  .filter(r => !namedRules.has(r))
  .sort((a, b) => a - b)
  .map(rule => ({ name: `Rule ${rule}`, rule, flip: 0 }));
const PRESETS = [...NAMED_PRESETS, ...NUMBERED_PRESETS];

const DEFAULT_RULE = 2182;      // 'quadratic' — the demo's own default
const DEFAULT_FLIP = 0;

// =============================================================================
// TUNABLES
// =============================================================================
// 4, not 3: the full-fidelity split order (below) takes the mother to degree 4
// transiently, which is the price of the reference's EXACT slot order on all four
// affected rows. O6 is checked after every generation, so an over-bond is still
// caught — one layer later than a tight capacity would have caught it.
const MAX_BONDS = 4;
// PURELY VISUAL. Collision is OFF (the reference has none), so nothing in the
// engine reads a radius — the old RADIUS_MAX bound existed to keep the soft-sphere
// search complete inside one hash bin and no longer applies. Sized to the layout
// scale (REST 25) so a node reads as a node rather than a speck.
const RADIUS = 4.5;
// THE PRIORITY BANDS (see the header). Both are integers below 2^24, so they are
// exact in f32 as well as f64 and no contest can turn on a rounding artefact.
//   flagged   -> the agent's own handle, in [0, MAX_AGENTS)
//   unflagged -> PRIO_UNFLAGGED, also what a splitter writes to consume its latch
const PRIO_UNFLAGGED = 1e6;
const PRIO_FLAG_LIMIT = 1e5;    // "still latched" test; MAX_AGENTS << this << PRIO_UNFLAGGED
// THE VISUAL NODE RADIUS is a live slider. Its bound is now purely aesthetic:
// with Collision OFF (znah's regime) no engine force reads the radius, so the old
// hash-bin-completeness ceiling is gone. Sized in the REST-25 scale.
const RADIUS_MIN = 1, RADIUS_MAX = 8;
// The growth ramp exists ONLY to carry the Node Radius slider onto the agents
// (Set Target Radius is the self-relative writer; see the behaviour graph). The
// ramp is `radius += sign(dd) * rate`, CLAMPED at the target, so any rate above
// the whole slider range lands in one generation instead of easing in.
const GROWTH_RATE = 10;
// =============================================================================
// THE PHYSICS REGIME IS znah's, PARAMETER FOR PARAMETER.
// =============================================================================
// The port's topology was already exact; its LAYOUT was not, and the cause was a
// scale mismatch rather than a tuning one. The charge law `k·(1/(1+d²) − minC)·d`
// has a BUILT-IN length scale (the knee at d = 1), so the same k means something
// completely different at a different bond rest length. The dimensionless ratio
// that decides the regime is the charge force at rest over the spring's own
// restoring scale, `|k| / (λ·(1+r²))`:
//
//     reference   |k|=3   λ=0.5   r=25   ->  3/(0.5·626)  = 0.0096   (bonds sit ~1% above rest)
//     port (was)  |k|=10  λ=0.55  r=5    ->  10/(0.55·26) = 0.699    (bonds sit ~48% above rest)
//
// i.e. the port's charge was ~73× stronger relative to its springs and the bond
// network was permanently inflated — which is what "it doesn't look like znah's"
// was. Adopting the reference's own numbers (rest 25, λ 0.5, k −3, cutoff 2000)
// puts the model back in its regime instead of near the knee.
const REST = 25.0;              // znah's linkDistance — the layout scale
const STIFF = 0.5;              // znah's linkStrength
const NODE_CAP = 10000;         // the end-condition guard — znah's own demo scale
// A generation can at most split a maximal independent set, so N can at most
// DOUBLE in one generation, and the end condition is evaluated after the
// generation that crossed the cap. maxAgents therefore has to be >= 2 x the cap
// or a pathological all-flagged rule could reach the ceiling, where Create Agent
// returns -1, the split's Transfer is rejected and the graph stops being cubic.
const MAX_AGENTS = 24000;
// K — the number of DIVISION ROUNDS per reference tick. Chosen by measurement:
// the point at which the drain provably FINISHES, plus a margin.
//
// RE-MEASURED after the priority became the agent's HANDLE (it was a random roll,
// which ordered the rounds differently and therefore drained differently). All 18
// mutation-free published rules, 100 reference ticks each, capped at 6000 nodes:
//     K     leftover latches      rules matching the reference N(t)   deepest round used
//     1     13048 / 44529 = 29.30 %      9 / 18                        1
//     2      2429 / 38347 =  6.33 %     15 / 18                        2
//     4        81 / 35144 =  0.23 %     15 / 18                        4
//     6         0 / 35148 =  0.00 %     18 / 18                        6
//     8         0 / 35148 =  0.00 %     18 / 18                        6
//    16         0 / 35148 =  0.00 %     18 / 18                        6   <- no deeper drain exists
// and re-run at the 10 000-node cap over 120 ticks (55 039 latches): still zero
// leftovers and still a deepest drain of 6.
//
// The worry that motivated the re-measurement — that a deterministic ascending
// order could line up a DESCENDING chain of flagged neighbours and drain one per
// round — does not materialise; handle order needs SHALLOWER drains than the
// random roll did (6 rather than 8), which is unsurprising given that ascending
// handle IS the order the reference itself divides in.
//
// K stays at 8 rather than dropping to the measured 6: that leaves a margin of
// two for a rule nobody has rolled yet (Randomize makes new automata reachable
// from the UI), and it keeps PERIOD at 9 — the cadence the layout's force-pass
// budget and the measured world extent below were both established against.
// Note the leftover rate alone would have justified K = 4; it does not, because
// leftovers concentrate in the deep-chain rules (17957, 26145, exp hyper), which
// diverge from the reference by cycle 5 at K = 4 while the average still reads
// 0.23 %. K is the point where the drain finishes, not where the average looks
// small.
//
// ⚠️ RE-MEASURED AGAIN after the split moved to the Transfer verb (below), and
// THE TABLE ABOVE NO LONGER HOLDS: the drain does not finish at ANY K.
//
// A latched node may split only when its handle is below every bonded
// neighbour's, so a path of flagged nodes with ASCENDING handles drains one per
// round; the rounds a tick needs are the longest such chain. Rewire used to
// SCRAMBLE each receiver's slot order, which broke those chains up by accident.
// Transfer reproduces the reference's adjacency exactly — and with it the
// reference's own long flagged chains. Measured on the same five-rule set
// (40 ticks, 6000-node cap): leftovers at K = 8 / 10 / 12 / 16 / 24 / 40 alike,
// and for `exp hyper` specifically the divergence merely slides from cycle 26
// (K = 8) to 28 (K = 12) to 30 (K = 20). The reference has no such limit — it
// divides sequentially in index order, so one pass covers any chain length, and
// only a sequential drain could match that.
//
// WHAT IT COSTS, MEASURED, over the 18 mutation-free published rules at 100
// reference ticks (6000-node cap):
//     Rewire split (before)   18/18 match N(t) exactly
//     Transfer split (now)    17/18 — `exp hyper` parts company at cycle 26
// WHAT IT BUYS, over the same runs — the LABELLED graph, edge for edge:
//     quadratic   43.5 % -> 100.0 %      identical to the reference's own edges
//     exp tree    22.0 % -> 100.0 %
//     meduza      47.7 % ->  79.2 %
// and meduza's hub structure, which is what the port visibly lacked:
//     max splits by one node   15 -> 49  (reference 49)
//     nodes that split >= 3x    3 -> 46  (reference 46)
//     share of splits in top 5 %  12.0 % -> 48.2 %  (reference 48.2 %)
// So K stays 8, and the residue is documented + pinned by the harness rather
// than chased with a larger cadence that does not fix it.
const DIVISION_ROUNDS = Math.max(1, Number(process.env.GG_ROUNDS) || 8);
const PERIOD = 1 + DIVISION_ROUNDS;
// ONE force pass per generation. PERIOD grew from 2 to 9, so the layout still
// gets 9 passes per reference tick — MORE relaxation per rewrite than the old
// 2 x 3 cadence gave — at a third of the per-generation cost.
// znah's `tickSteps = 2`: TWO force-integration passes per octree build. Our
// per-iteration spring re-reads the moved positions, which is the Jacobi analogue
// of the reference's two Gauss-Seidel link passes (see the residual note in the
// physics table below).
const LAYOUT_ITERATIONS = 2;

// THE WORLD IS SIZED FROM A MEASURED EXTENT, not from the packing rule the other
// GRA models use. That rule ("side = sqrt(N) * rest * 1.45") assumes a layout
// whose spacing is set by the bond rest length; GLOBAL charge has no cutoff, so
// the repulsion an outer node feels grows with the whole population and the
// structure inflates far past that — and its extent depends on the SHAPE the
// rule grows, not just on N. Measured in the real worker (WASM agent target) by
// growing to the 10 000-node cap inside a deliberately oversized world, so the
// boundary never touched the result:
//
//     meduza       N = 10610   extent 4639 x 4075     0 agents clamped   2.6x margin
//     exp tree     N = 10930   extent 5231 x 5497     0 agents clamped   2.2x margin
//     Rule 17957   N = 10002   extent 8378 x 8234     0 agents clamped   1.4x margin  <- worst
//
// so 12000 clears every one of them — over twice the extent of the compact-blob
// rules and still clear of the stringiest one in the catalogue. It is NOT sized
// larger than that on purpose: the world is what the view fits, so an oversized
// world leaves the interesting early growth (a few hundred nodes) a speck.
// Enlarging a bounded world is otherwise free — the spatial hash anchors on the
// agents' bounding box (and is capped at AGENT_HASH_BIN_CAP regardless) and the
// charge octree is built over the population, not the world.
// re-measured under the znah regime — see MEASURED EXTENTS below.
const W = 60000, H = 60000;

// GLOBAL charge (C10) with znah's own CUTOFF. `chargeMaxDist` under `global` is a
// C10 follow-up: the coefficient becomes `1/(1+l²) − 1/(1+R²)` and nodes/points
// beyond R are culled, exactly as the reference's `calcMultibodyForce` does it.
// WHY IT MATTERS: without a cutoff the far field of N distant nodes sums to ≈ N/l,
// which GROWS with the population — so an un-cut law inflates a growing graph
// without bound. R = 2000 = 80 rest lengths pins the scale.
const CHARGE_K = -3;            // znah's chargeStrength
const CHARGE_MAX_DIST = 2000;   // znah's chargeMaxDist
const CHARGE_THETA = 0.9;       // znah's Barnes-Hut theta (theta² = 0.81 in main.c)

// znah seeds a newborn at `(rnd() + p_mother + p_inherited)/2` with
// `rnd() = Math.random() − 0.5`, i.e. the MIDPOINT plus ±0.25 ABSOLUTE units — a
// symmetry breaker worth ~1% of the rest length, not a fraction of it. Our
// `(jitter − 0.5) * JITTER` with `jitter ∈ [0,1)` reproduces that amplitude.
// DEVIATION (documented): we draw ONE value per split and apply it as ±(j,j) to the
// two daughters rather than four independent per-axis draws — one RNG draw instead
// of four, same magnitude, still a symmetry breaker.
const JITTER = 0.5;

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

// The ring RADIUS is derived from the BOND REST LENGTH, not from the world: a
// 10-cycle whose links want to be REST long has circumference 10·REST, so the
// natural radius is 10·REST/2π. (It used to be 3% of the world width, which made
// the physical scale of the seed ring depend on an unrelated setting — at the new
// world size that would have started every bond ~50× its rest length.) The world
// dims still feed the CENTRE, so a simulator Resize re-centres the seeds.
const SEED_RING_R = (SEEDS * REST / (2 * Math.PI)).toFixed(6);
const TAU_OVER_N = (2 * Math.PI / SEEDS).toFixed(15);
const px = ag.node('expression', {
  expression: `w * 0.5 + ${SEED_RING_R} * cos(${TAU_OVER_N} * h)`,
  visibleCount: 2, _varName_a: 'h', _varName_b: 'w',
}, 2, -1);
ag.vEdge(spawn, 'index', px, 'a');
ag.vEdge(init, 'worldWidth', px, 'b');
const py = ag.node('expression', {
  expression: `t * 0.5 + ${SEED_RING_R} * sin(${TAU_OVER_N} * h)`,
  visibleCount: 2, _varName_a: 'h', _varName_b: 't',
}, 2, 1);
ag.vEdge(spawn, 'index', py, 'a');
ag.vEdge(init, 'worldHeight', py, 'b');

// Born at the CURRENT Node Radius, so a seed never pops from the default to the
// slider's value one generation later. Its own `getModelAttribute` node: value
// nodes are emitted per ROOT, and sharing one across the Init Event and the
// behaviour step would only obscure that.
const initRad = ag.node('getModelAttribute', { attributeId: 'nodeRadius' }, 2, 2);
const mkSeed = ag.node('createAgent', {}, 3, 0);
ag.vEdge(px, 'result', mkSeed, 'x');
ag.vEdge(py, 'result', mkSeed, 'y');
ag.vEdge(initRad, 'value', mkSeed, 'radius');
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
// BEHAVIOUR STEP — the one-shot bootstrap, then the DIVISION ROUNDS
// -----------------------------------------------------------------------------
// This root runs EVERY generation. Its first branch (the bootstrap wiring) is
// gated on bond degree 0, so it fires exactly once per seed, on generation 0.
// Its DONE continuation carries the division rounds — see below.
const bs = ag.node('behaviourStep', {}, 0, 4);
const deg = ag.node('getBondDegree', {}, 0, 6);
const isUnwired = ag.node('statement', { operation: '==', compareType: 'numerical', _port_y: '0' }, 1, 6);
ag.vEdge(deg, 'value', isUnwired, 'x');
const wireIf = ag.node('conditional', {}, 2, 4);
ag.vEdge(isUnwired, 'result', wireIf, 'condition');

// THE SCRIPTED FORMATION ORDER (see the header). Every agent forms its own
// `next` edge and NOBODY forms a `prev` edge — the previous agent already did.
// A chord is owned by its HIGHER endpoint. Because the drain applies queues in
// ascending agent order, that lays the cycle down as e0, e1, ... e9 with each
// chord immediately after both its endpoints' cycle edges, which is znah's
// [prev, next, chord] for nine of the ten nodes (node 0 is the provable
// exception — the cyclic ordering constraint has no solution).
const selfH = ag.node('getSelfHandle', {}, 2, 2);
const nbNext = ag.node('expression', {
  expression: `(h + 1) % ${SEEDS}`, visibleCount: 1, _varName_a: 'h',
}, 3, 3);
ag.vEdge(selfH, 'handle', nbNext, 'a');
const lutChord = ag.node('lookupInteraction', { tableId: 'chordPartner' }, 3, 5);
ag.vEdge(selfH, 'handle', lutChord, 'axis_0');

const bondCfg = { _port_restLength: String(REST), _port_stiffness: String(STIFF) };
const wireNext = ag.node('formBond', { ...bondCfg }, 4, 3);
ag.vEdge(nbNext, 'result', wireNext, 'targetAgent');
// The chord is issued ONLY by the higher endpoint, so it lands after BOTH its
// endpoints' cycle edges and therefore in slot 2 at both of them.
const ownsChord = ag.node('statement', { operation: '<', compareType: 'numerical' }, 4, 5);
ag.vEdge(lutChord, 'value', ownsChord, 'x');
ag.vEdge(selfH, 'handle', ownsChord, 'y');
const chordIf = ag.node('conditional', {}, 5, 4);
ag.vEdge(ownsChord, 'result', chordIf, 'condition');
const wireChord = ag.node('formBond', { ...bondCfg }, 6, 5);
ag.vEdge(lutChord, 'value', wireChord, 'targetAgent');
ag.fEdge(wireIf, 'then', wireNext, 'do');
ag.fEdge(wireNext, 'next', chordIf, 'check');
ag.fEdge(chordIf, 'then', wireChord, 'do');

// -----------------------------------------------------------------------------
// LIVE NODE RADIUS — a presentation knob, written every generation
// -----------------------------------------------------------------------------
// Every agent re-asserts the bounded model attribute on every generation, so the
// slider is live. It heads the behaviour chain, so it applies even while the
// graph is frozen by Max Generations below.
//
// SET TARGET RADIUS, not Set Agent Radius by id. The by-id setter would need its
// Agent port wired, and a wired non-spawn id is exactly what the synchronous
// cross-agent write gate rejects (it cannot know statically that Get Self Handle
// is self-targeted, and being conservative there is right). Set Target Radius is
// self-relative by construction; the engine's growth ramp then moves the actual
// radius, and GROWTH_RATE is set above the whole slider range so it lands in one
// generation rather than easing in.
//
// Presentation only in intent, but NOT free: soft collision reads the radius,
// which is why the slider's upper bound is exactly where the spatial-hash
// stencil would stop finding every colliding pair.
const radAttr = ag.node('getModelAttribute', { attributeId: 'nodeRadius' }, 1, 1);
const setRad = ag.node('setTargetRadius', {}, 2, 1);
ag.vEdge(radAttr, 'value', setRad, 'value');
ag.fEdge(bs, 'do', setRad, 'do');
ag.fEdge(setRad, 'next', wireIf, 'check');

// -----------------------------------------------------------------------------
// MAX GENERATIONS — freeze the AUTOMATON, keep the layout running
// -----------------------------------------------------------------------------
// `evolve` gates the state tick AND every division round, so past the limit the
// graph stops rewriting while the force solver, the render and every slider keep
// working — the "let it settle / look at it" control. 0 means unlimited.
//
// Freezing at an arbitrary GENERATION (rather than at a whole reference tick) is
// safe because O6 holds at every generation: a division round is complete in
// itself, so whenever it stops the graph is 3-regular with E = 3N/2. Any latches
// still outstanding simply wait; unfreezing drains them in the next rounds.
const maxGenAttr = ag.node('getModelAttribute', { attributeId: 'maxGen' }, 0, 14);
const genNode = ag.node('getGeneration', {}, 0, 15);
const capOff = ag.node('statement', { operation: '<', compareType: 'numerical', _port_y: '1' }, 1, 14);
ag.vEdge(maxGenAttr, 'value', capOff, 'x');
const underCap = ag.node('statement', { operation: '<', compareType: 'numerical' }, 1, 15);
ag.vEdge(genNode, 'value', underCap, 'x');
ag.vEdge(maxGenAttr, 'value', underCap, 'y');
const evolve = ag.node('logicOperator', { operation: 'OR' }, 2, 14);
ag.vEdge(capOff, 'result', evolve, 'a');
ag.vEdge(underCap, 'result', evolve, 'b');

// -----------------------------------------------------------------------------
// PERIODIC STEP, PHASE 0 — the STATE tick (the reference's phase 0)
// -----------------------------------------------------------------------------
// Computes r from the CURRENT states (synchronous update means the census reads
// the previous generation through the double buffer), writes the next state, and
// LATCHES the division intent + its tie-break into ONE number: see `prio` below.
const stateTick = ag.node('periodicStep', { period: PERIOD, phase: 0 }, 0, 9);

const census = ag.node('neighbourCensus', { attributeId: 'state', source: 'bonded' }, 0, 11);
const own = ag.node('getCellAttribute', { attributeId: 'state' }, 0, 12);
// An isolated node keeps its state and never divides — the standard graph-
// automaton convention, and here it also covers the one generation before the
// bootstrap has wired anything.
const wired = ag.node('statement', { operation: '>', compareType: 'numerical', _port_y: '0' }, 1, 11);
ag.vEdge(census, 'total', wired, 'x');
const runTick = ag.node('logicOperator', { operation: 'AND' }, 2, 10);
ag.vEdge(wired, 'result', runTick, 'a');
ag.vEdge(evolve, 'result', runTick, 'b');
const ruleIf = ag.node('conditional', {}, 2, 9);
ag.fEdge(stateTick, 'do', ruleIf, 'check');
ag.vEdge(runTick, 'result', ruleIf, 'condition');

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

// 2. LATCH the division intent, stored as a single number
//
// THE PRIORITY ENCODES BOTH THE LATCH AND THE TIE-BREAK, and that is what makes
// the independent-set drain cost nothing when it is not needed:
//     prio = the agent's own HANDLE   in [0, maxAgents)   when the divide bit fired
//     prio = PRIO_UNFLAGGED (1e6)                          when it did not
// so in a DIVISION ROUND a node splits iff its stored priority is below
// PRIO_FLAG_LIMIT (1e5 — it is still latched) AND strictly below every bonded
// neighbour's (it wins the contest). A neighbour that did not want to split
// carries 1e6 and therefore never blocks anyone. A splitter writes 1e6, which
// BOTH consumes its latch and stops it blocking the neighbours it beat — that
// write is what lets the losers through in a LATER round of the same tick.
//
// USING THE HANDLE rather than a random roll makes the drain order DETERMINISTIC
// ASCENDING HANDLE, which is exactly the reference's index walk (handle == znah
// node index: Create Agent allocates ascending and nothing ever dies here). With
// a random roll the within-tick order — and therefore which neighbour each
// daughter inherits, and therefore the embedding — varied run to run.
//
// The intent-aware banding is the fix for the obvious-but-wrong version of the
// gate. Comparing bare priorities — flagged or not — makes a node wait until it
// is the local minimum among ALL its neighbours, which throws away roughly three
// quarters of the splits even when the flagged nodes are already pairwise
// non-adjacent. For most of the published rules that does not merely slow
// growth, it changes the trajectory: the automaton reaches its absorbing all-OFF
// configuration and stops for good.
const lutDiv = ag.node('lookupInteraction', { tableId: 'ruleDivide' }, 3, 15);
ag.vEdge(own, 'value', lutDiv, 'axis_0');
ag.vEdge(census, 'count_1', lutDiv, 'axis_1');
const prioVal = ag.node('expression', {
  expression: `h * d + (1 - d) * ${PRIO_UNFLAGGED}`,
  visibleCount: 2, _varName_a: 'h', _varName_b: 'd',
}, 5, 15);
ag.vEdge(selfH, 'handle', prioVal, 'a');
ag.vEdge(lutDiv, 'value', prioVal, 'b');
const setPrio = ag.node('setAttribute', { attributeId: 'prio' }, 6, 12);
ag.vEdge(prioVal, 'result', setPrio, 'value');
ag.fEdge(setState, 'next', setPrio, 'do');

// -----------------------------------------------------------------------------
// DIVISION ROUNDS — every phase of the period EXCEPT 0
// -----------------------------------------------------------------------------
// Hand-gated on `generation % PERIOD != 0` rather than rooted at K separate
// Periodic Steps: the flow walk INLINES a node's body once per incoming path, so
// K periodic roots pointing at one split chain would emit K copies of it. One
// gate, one copy.
const roundPhase = ag.node('arithmeticOperator', { operation: '%', _port_y: String(PERIOD) }, 1, 16);
ag.vEdge(genNode, 'value', roundPhase, 'x');
const isRound = ag.node('statement', { operation: '!=', compareType: 'numerical', _port_y: '0' }, 2, 16);
ag.vEdge(roundPhase, 'result', isRound, 'x');
const roundIf = ag.node('conditional', {}, 3, 16);
// The bootstrap branch's DONE continuation: same root, next in flow order.
ag.fEdge(wireIf, 'next', roundIf, 'check');
ag.vEdge(isRound, 'result', roundIf, 'condition');

const myPrio = ag.node('getCellAttribute', { attributeId: 'prio' }, 0, 18);
const wasFlagged = ag.node('statement', { operation: '<', compareType: 'numerical', _port_y: String(PRIO_FLAG_LIMIT) }, 1, 18);
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
// The Max Generations freeze applies to the DIVISION rounds as well as the state
// tick, or a frozen graph would keep draining latches for K more generations.
const gate3 = ag.node('logicOperator', { operation: 'AND' }, 6, 17);
ag.vEdge(gate2, 'result', gate3, 'a');
ag.vEdge(evolve, 'result', gate3, 'b');

const splitIf = ag.node('conditional', {}, 7, 16);
ag.fEdge(roundIf, 'then', splitIf, 'check');
ag.vEdge(gate3, 'result', splitIf, 'condition');

// The daughters inherit the mother's state, which by the division rounds IS the
// post-update (post-mutation) state the state tick committed — exactly the
// reference's `states.push(states[i], states[i])`.
const stateNow = ag.node('getCellAttribute', { attributeId: 'state' }, 7, 19);

// 5. THE TRIANGLE SPLIT — 5 queue ops, maxBonds 4
// The mother keeps bond slot 0 and hands slots 1 and 2 to the daughters, exactly
// as the reference does; the two Transfers keep the receivers' own orders too.
const bAgent = ag.node('arrayElement', { _port_position: '1' }, 1, 20);
ag.vEdge(bonded, 'agents', bAgent, 'array');
const cAgent = ag.node('arrayElement', { _port_position: '2' }, 1, 21);
ag.vEdge(bonded, 'agents', cAgent, 'array');

// NEWBORN PLACEMENT: the MIDPOINT between the mother and the neighbour the
// newborn inherits, so a split never starts with a daughter on the far side of
// the mother from its own new bond — the reference's own layout hint (force.js
// `updateData` seeds a newborn at the mean of [mother, inherited neighbour]).
// Get Agent Position in RELATIVE mode gives the shortest offset (and is correct
// across a torus seam).
//
// THE JITTER IS DERIVED FROM THE HANDLE, not drawn. The reference adds a random
// offset here; this model declares an Exact reproducibility contract, so it uses
// a golden-ratio hash of the mother's handle instead — same decorrelating
// effect, but a Reset replays byte for byte. (It used to reuse the priority
// roll, which the handle band above no longer keeps in [0, 1).) The two
// daughters take opposite signs, so a mother whose two neighbours happen to be
// collinear with it still separates them.
const jitterSrc = ag.node('expression', {
  expression: 'h * 0.6180339887498949 % 1', visibleCount: 1, _varName_a: 'h',
}, 8, 16);
ag.vEdge(selfH, 'handle', jitterSrc, 'a');
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
  ag.vEdge(jitterSrc, 'result', n, 'c');
  return n;
};
const x2 = midpoint(9, 18, offB, 'x', '+');
const y2 = midpoint(9, 19, offB, 'y', '+');
const x3 = midpoint(9, 21, offC, 'x', '-');
const y3 = midpoint(9, 22, offC, 'y', '-');

const mkJ = ag.node('createAgent', {}, 10, 18);
ag.vEdge(x2, 'result', mkJ, 'x');
ag.vEdge(y2, 'result', mkJ, 'y');
ag.vEdge(radAttr, 'value', mkJ, 'radius');
const addJ = ag.node('addAgentToWorld', {}, 11, 18);
ag.vEdge(mkJ, 'handle', addJ, 'handle');
// Daughters inherit the mother's POST-update (and post-mutation) state, exactly
// as znah's `states.push(states[i], states[i])` does in its division phase. The
// target is a one-hop Create Agent handle, so this is the documented spawn-
// configuration exemption from the synchronous cross-agent write gate. Their
// `prio` is the attribute DEFAULT (2.5, a non-splitter), so a newborn can never
// divide in a later round of the SAME tick — the reference freezes its flag
// array at the tick boundary for exactly the same reason.
const stJ = ag.node('setAgentAttribute', { attributeId: 'state' }, 12, 18);
ag.vEdge(mkJ, 'handle', stJ, 'agentId');
ag.vEdge(stateNow, 'value', stJ, 'value');

const mkK = ag.node('createAgent', {}, 10, 21);
ag.vEdge(x3, 'result', mkK, 'x');
ag.vEdge(y3, 'result', mkK, 'y');
ag.vEdge(radAttr, 'value', mkK, 'radius');
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
// THE FIVE OPS, in the order that reproduces the reference EXACTLY (see the block
// below the flow wiring for the slot-by-slot derivation). A Transfer rewrites the
// third party's slot IN PLACE, which is what preserves b's and c's own ordering —
// a Rewire would have compacted them.
const fbJ = bondOp(13, 18, 'formBond', n => { ag.vEdge(mkJ, 'handle', n, 'targetAgent'); });
const trB = ag.node('transferBond', {}, 13, 19);
ag.vEdge(bAgent, 'value', trB, 'partnerAgent'); ag.vEdge(mkJ, 'handle', trB, 'toAgent');
const fbK = bondOp(13, 20, 'formBond', n => { ag.vEdge(mkK, 'handle', n, 'targetAgent'); });
const fbJK = bondOp(13, 21, 'formBondBetween', n => { ag.vEdge(mkJ, 'handle', n, 'agentA'); ag.vEdge(mkK, 'handle', n, 'agentB'); });
const trC = ag.node('transferBond', {}, 13, 22);
ag.vEdge(cAgent, 'value', trC, 'partnerAgent'); ag.vEdge(mkK, 'handle', trC, 'toAgent');

// CONSUME THE LATCH. Written last so nothing in the split chain reads a
// post-write value (synchronous agent attributes double-buffer, so this is
// visible from the NEXT round — which is exactly when the neighbours this node
// just beat need to see that it no longer blocks them).
const clearPrio = ag.node('setAttribute', { attributeId: 'prio', _port_value: String(PRIO_UNFLAGGED) }, 14, 22);

// THE OP ORDER IS EVERY NODE'S SLOT ORDER, so it is not free. A bond APPENDS to
// both endpoints' lists and a break COMPACTS by swapping the last slot into the
// freed one, so the five ops decide what the mother, both daughters AND the two
// receivers end up holding — and the split reads slot 0 (kept) and slots 1 and 2
// (handed to the daughters), so the order propagates into every later split.
//
// Trace it, with i = [a, b, c] and maxBonds 4:
//   1  Form Bond(i, j)        i = [a,b,c,j]        j = [i]
//   2  Transfer(b, i -> j)    b's slot holding i becomes j IN PLACE (b's order kept);
//                             i drops b — swap-with-last pulls j into slot 1 —
//                             i = [a,j,c]          j = [i,b]
//   3  Form Bond(i, k)        i = [a,j,c,k]        k = [i]
//   4  Form Between(j, k)     j = [i,b,k]          k = [i,j]
//   5  Transfer(c, i -> k)    c's slot holding i becomes k IN PLACE (c's order kept);
//                             i drops c — swap-with-last pulls k into slot 2 —
//                             i = [a,j,k]          k = [i,j,c]
//
// which is znah's division verbatim:  nodes[i] = [a,j,k]; push([i,b,k]);
// push([i,j,c]); nodes[b][indexOf(i)] = j; nodes[c][indexOf(i)] = k.
//
// MAX BONDS IS 4, NOT 3, AND THAT IS THE PRICE OF THE LAST ROW. The mother
// transiently reaches degree 4 at steps 1 and 3. A capacity-safe order does exist
// at maxBonds 3 (shed before gaining), but it hands j its slot 0 as `b` rather
// than `i`, i.e. one daughter's order breaks. So 3 keeps the tight "nothing may
// transiently exceed cubic degree" guard and gets 3 of the 4 lists exact; 4 gets
// all four. O6 is asserted at EVERY generation either way, so an over-bond is
// still caught — one layer later.
ag.fEdge(splitIf, 'then', mkJ, 'do');
ag.fEdge(mkJ, 'next', addJ, 'do');
ag.fEdge(addJ, 'next', stJ, 'do');
ag.fEdge(stJ, 'next', mkK, 'do');
ag.fEdge(mkK, 'next', addK, 'do');
ag.fEdge(addK, 'next', stK, 'do');
ag.fEdge(stK, 'next', fbJ, 'do');
ag.fEdge(fbJ, 'next', trB, 'do');
ag.fEdge(trB, 'next', fbK, 'do');
ag.fEdge(fbK, 'next', fbJK, 'do');
ag.fEdge(fbJK, 'next', trC, 'do');
ag.fEdge(trC, 'next', clearPrio, 'do');

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
    id: 'maxGen', name: 'Max Generations', type: 'integer', isModelAttribute: true,
    description:
      'FREEZE THE AUTOMATON at this generation, keeping everything else alive: the force layout keeps ' +
      'relaxing, the render keeps drawing and every other slider keeps working — the graph simply stops ' +
      'rewriting. 0 means unlimited. It gates the state tick AND the division rounds, so nothing is left ' +
      'half-drained; and because the cubic invariant holds at EVERY generation (not only at tick ' +
      'boundaries), freezing part-way through a tick still leaves a valid 3-regular graph. Raise it again ' +
      'and the automaton resumes from exactly where it stopped.',
    defaultValue: '0', hasBounds: true, min: 0, max: 5000,
  },
  {
    id: 'nodeRadius', name: 'Node Radius', type: 'float', isModelAttribute: true,
    description:
      'How big the nodes are drawn, live. Written to every agent on every generation, so dragging it ' +
      'takes effect immediately. It is not purely cosmetic — the soft-collision force reads the radius — ' +
      'and the upper bound is exactly where the spatial-hash stencil would stop finding every colliding ' +
      'pair, not an arbitrary cap. Bond rest length is ' + REST + ' for scale.',
    defaultValue: String(RADIUS), hasBounds: true, min: RADIUS_MIN, max: RADIUS_MAX,
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
    id: 'prio', name: 'prio', type: 'float', defaultValue: String(PRIO_UNFLAGGED),
    description:
      'The LATCHED division intent AND its tie-break in one number. The state tick writes it: a ' +
      'flagged node stores its OWN HANDLE (below ' + PRIO_FLAG_LIMIT + '), an unflagged one stores ' + PRIO_UNFLAGGED + '. Each of ' +
      'the ' + DIVISION_ROUNDS + ' division rounds that follow splits a node only if its value is below ' + PRIO_FLAG_LIMIT + ' (still ' +
      'latched) and strictly below every bonded neighbour\'s (it won the contest); a splitter then ' +
      'writes ' + PRIO_UNFLAGGED + ', which consumes its latch AND stops it blocking the neighbours it beat, so they ' +
      'split in a later round of the same tick against the adjacency it just rewrote. Handles are ' +
      'unique, so strict inequality always resolves and the splitters of any one round are pairwise ' +
      'non-adjacent — and because the winner is always the LOWEST handle, the drain order is the ' +
      'reference implementation\'s own ascending index walk rather than a random one. The default ' +
      'is a non-splitter value, so a newborn can never divide in a later round of the tick it was ' +
      'born in.',
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
    'the graph 3-regular forever. All ' + PRESETS.length + ' rules of the demo\'s catalogue ship as presets.',
  ruleDescription:
    'CREDIT. The automaton family is Paul Cousin\'s binary cubic Graph-Rewriting Automata; this ' +
    'model is a port of Alex Mordvintsev\'s (znah) "Growing Graphs" demo, znah.net/graphs, and the ' +
    'presets are that demo\'s published rule catalogue — its twelve named rules plus the eleven ' +
    'further rules its dropdown offers, which ship here under their rule number.\n\n' +
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
    'operations from the mother\'s own behaviour in ONE generation — two Form Bonds, two Transfer ' +
    'Bonds and one Form Bond Between (Create Agent and Add Agent To World are host calls that ' +
    'consume no queue slot). The mother transiently reaches degree 4 while it holds a new daughter ' +
    'and the old neighbour at once, which is why Max Bonds is 4; the cubic invariant is checked ' +
    'after every generation regardless.\n\n' +
    'THE INITIAL CONDITION IS EXACT, SLOT ORDER INCLUDED. The reference implementation always seeds ' +
    'the same 10-node cubic graph — a 10-cycle plus the chords {0,2} {1,4} {3,6} {5,8} {7,9} — with ' +
    'the states [0,0,0,1,0,1,0,1,1,1], and every one of its adjacency rows reads [prev, next, chord]. ' +
    'Here the Agent Init Event places ten agents on a circle and reads their states from a ' +
    'handle-indexed table; the wiring happens on the first behaviour step (Form Bond writes the acting ' +
    'agent\'s request queue, so it is invalid in an Init Event), gated on bond degree 0 so it runs ' +
    'exactly once.\n\n' +
    'The ORDER those bonds form in matters, because a bond appends to both endpoints\' lists and the ' +
    'split reads slot 0 (kept) and slots 1 and 2 (handed to the daughters) — so a node\'s slot order ' +
    'propagates into the structure forever. The requests are therefore scripted into a global order: ' +
    'each agent forms only its own (h+1) edge, nobody forms a (h-1) edge (the previous agent already ' +
    'did), and a chord is issued by its HIGHER endpoint. Because the engine drains request queues in ' +
    'ascending agent order, that lays the ten cycle edges down in order with each chord landing right ' +
    'after both its endpoints\' cycle edges — reproducing [prev, next, chord] for NINE of the ten ' +
    'nodes. The tenth cannot be done: node h\'s prev-edge is edge (h-1) and its next-edge is edge h, ' +
    'so [prev, next] everywhere at once would require edge 9 before edge 0 before ... before edge 9. ' +
    'Exactly one node must carry its cycle edges the other way round, and here it is node 0.\n\n' +
    'LATCH AND DRAIN — THE REFERENCE\'S DIVISION SEMANTICS. The reference alternates a STATE tick ' +
    'and a DIVISION tick. Its division tick does not re-read the states: it walks the flags the ' +
    'state tick LATCHED and divides every one of them, sequentially, each node reading the LIVE ' +
    'adjacency — so a node whose neighbour has already split divides against its updated ' +
    'neighbourhood. A latch is consumed exactly once, and nodes born in the tick do not divide in ' +
    'it.\n\n' +
    'GenesisCA\'s structural request queue drains in parallel, and two ADJACENT splitters would ' +
    'corrupt each other (the mother\'s Transfer needs its edge to b to still exist when the queue ' +
    'drains, and a splitting b would already have re-pointed it away). So a single generation can ' +
    'only split an INDEPENDENT SET, and one reference tick becomes ' + PERIOD + ' generations: one STATE ' +
    'tick that latches the flags, then ' + DIVISION_ROUNDS + ' DIVISION ROUNDS. Each round splits the latched nodes ' +
    'that win the contest among their bonded neighbours and clears their latch; the losers keep ' +
    'theirs and try again in the next round, against the adjacency the winners just rewrote. That ' +
    'is the reference\'s mutated-adjacency drain, executed in independent-set rounds instead of in ' +
    'index order.\n\n' +
    'HOW FAITHFUL IS IT? ALL FOUR adjacency rows a split touches are the reference\'s EXACTLY, slot ' +
    'order included: the mother keeps slot 0 and becomes [a, j, k], daughter j is [i, b, k], ' +
    'daughter k is [i, j, c], and each displaced neighbour has the slot that pointed at the mother ' +
    'OVERWRITTEN IN PLACE — the reference\'s own reconnect. The last of those is what the Transfer ' +
    'Bond verb exists for: Rewire Bond is a break plus a form, and a break compacts by moving the ' +
    'list\'s last entry into the freed slot, so it reordered the receiver. The operation order is ' +
    'not free either — every bond appends, so issuing the closing triangle edge before or after the ' +
    'second daughter\'s external edge decides which of them lands in which slot.\n\n' +
    'Measured against a transcription of the reference implementation, over 100 reference ticks ' +
    '(6000-node cap): the LABELLED graph — edge for edge, at the same node ids — is now IDENTICAL ' +
    'to the reference\'s on "quadratic" and "exp tree" (both were 43.5 % and 22.0 % before), and ' +
    '79.2 % identical on "meduza" (47.7 % before). The reference\'s habit of concentrating splits ' +
    'into a few long-lived hubs, which the port visibly lacked, is now reproduced exactly on ' +
    '"meduza": the busiest node splits 49 times against the reference\'s 49 (it was 15), 46 nodes ' +
    'split three or more times against 46 (it was 3), and the top 5 % of nodes account for 48.2 % ' +
    'of all splits against 48.2 % (it was 12.0 %).\n\n' +
    'THE ONE DEVIATION, stated plainly. Node count per reference tick matches cycle for cycle on ' +
    'seventeen of the eighteen mutation-free published rules. The exception is "exp hyper", which ' +
    'parts company after 26 cycles, and the cause is the drain rather than the split: a latched node ' +
    'may divide only when its handle is below every bonded neighbour\'s, so a path of flagged nodes ' +
    'with ascending handles drains one per round. The reference has no such limit — it divides ' +
    'sequentially in index order, so one pass covers a chain of any length. "exp hyper" flags ' +
    'essentially every node, and its chains outrun the eight division rounds; raising the round ' +
    'count only postpones the divergence (measured: cycle 26 at eight rounds, 28 at twelve, 30 at ' +
    'twenty), so the round count stays where the layout budget put it and the residue is documented ' +
    'instead. Every rule, "exp hyper" included, stays exactly 3-regular with E = 3N/2 throughout.\n\n' +
    'HOW THE INDEPENDENT SET IS CHOSEN, AND WHY IT HAD TO BE INTENT-AWARE. The latch and its ' +
    'tie-break live in ONE agent attribute, "prio": a flagged node stores its OWN HANDLE, an ' +
    'unflagged one stores a large sentinel. A division round splits a node only if its value is below ' +
    'the flag limit (still latched) AND strictly below every bonded neighbour\'s (it won the ' +
    'contest); the splitter then writes the sentinel, which consumes the latch and stops it blocking ' +
    'the neighbours it beat. Handles are unique, so strict inequality always resolves and one ' +
    'round\'s splitters are pairwise non-adjacent; and a node that did not want to split sits at the ' +
    'sentinel, so it never blocks anyone.\n\n' +
    'Using the HANDLE rather than a random roll is what makes the drain deterministic — and the ' +
    'lowest handle always winning is exactly the ascending index walk the reference itself divides ' +
    'in, since handles are allocated 0, 1, 2, ... and nothing ever dies here. An earlier version ' +
    'rolled a random priority, so which neighbour each daughter inherited (and therefore the whole ' +
    'embedding) changed from run to run.\n\n' +
    'The intent-aware banding is not a nicety either. The obvious version of the gate — compare bare ' +
    'priorities, flagged or not — makes a flagged node wait until it is the local minimum among ALL ' +
    'its neighbours, which discards roughly three quarters of the splits even when the flagged nodes ' +
    'are already pairwise non-adjacent, and for several published rules that is enough to drop the ' +
    'automaton into its absorbing all-OFF configuration and stop it dead.\n\n' +
    'TWO LIVE CONTROLS. "Max Generations" freezes the automaton at a chosen generation while the ' +
    'force layout, the render and every other slider keep running — set it, let the structure settle ' +
    'or look at it, then raise it and the automaton resumes exactly where it stopped (0 means ' +
    'unlimited). Freezing part-way through a tick is safe because the cubic invariant holds at every ' +
    'generation, not only at tick boundaries. "Node Radius" resizes every node live; its upper bound ' +
    'is purely cosmetic now that collision is off, so its bound is aesthetic, not a physics limit. ' +
    'Neither is part of the rule, so loading a preset leaves both where you put them.\n\n' +
    'THE CADENCE. One reference tick is ' + PERIOD + ' generations, so the force solver gets ' + (PERIOD * LAYOUT_ITERATIONS) + ' force ' +
    'passes per rewrite — more relaxation per rewrite than a two-generation cadence gives, at a ' +
    'lower per-generation cost.\n\n' +
    'THE PHYSICS IS THE REFERENCE DEMO, PARAMETER FOR PARAMETER. Bond rest length ' + REST + ', spring ' +
    'stiffness ' + STIFF + ', long-range charge k = ' + CHARGE_K + ' truncated at ' + CHARGE_MAX_DIST + ', Barnes-Hut theta ' + CHARGE_THETA + ', ' +
    'momentum 0.9 (a velocity decay of 0.1 in the demo), no speed cap, no collision, and an effective ' +
    'integration step of exactly 1 — the demo adds each force impulse straight to the velocity ' +
    'and moves by it, with no dt at all.\n\n' +
    'WHY THOSE NUMBERS AND NOT OTHERS. The charge law k*(1/(1+d^2) - minC) has a length scale built ' +
    'into it (the knee sits at d = 1), so the SAME k means something completely different at a ' +
    'different bond rest length. What decides whether the springs or the charge win is the ' +
    'dimensionless |k| / (lambda * (1 + rest^2)): the reference runs 3/(0.5*626) = 0.0096, while an ' +
    'earlier version of this port ran rest 5 with k -10, i.e. 10/(0.55*26) = 0.70 — seventy-three ' +
    'times more charge-dominated. Its bonds therefore sat about half again past their rest length and ' +
    'the whole graph read as inflated. Adopting the reference scale puts the model back in its ' +
    'regime instead of near the knee.\n\n' +
    'THE CHARGE HAS A CUTOFF, and it is not a detail. Summed over every pair, the far field of N ' +
    'distant nodes adds up to roughly N/l — which GROWS with the population, so an uncut law inflates ' +
    'a growing graph without bound. The reference culls at ' + CHARGE_MAX_DIST + ' (eighty rest lengths) and takes the ' +
    'coefficient continuously to zero there rather than stepping; this model does the same, through ' +
    'the same deterministic Barnes-Hut octree.\n\n' +
    'HOW CLOSE IT GETS, MEASURED. Relaxing the identical grown graph under both force laws and ' +
    'comparing the distributions that decide the look: with the reference link solve reduced to ' +
    'the single accumulation this engine performs, bond length agrees to 0.7-2.5 %, nearest ' +
    'non-bonded distance to 3-4 %, hub ring spacing to 0.5-9 % and overall extent to 0.2-11 % across ' +
    'three rules of different shape. The force law is therefore the same law. What remains is the ' +
    'link SOLVER: the reference sweeps its edge list twice, forward then backward, on predicted ' +
    'positions — a semi-implicit solve that is stiffer than an explicit one at the same stiffness, so ' +
    'its layout settles 13-25 % tighter. That cannot be matched by raising the stiffness (the ' +
    'explicit integrator goes unstable past about 0.6 on a cubic graph at this step and momentum, ' +
    'which is presumably why the reference chose 0.5) nor by adding passes, and a sequential ' +
    'edge-list sweep is not something the per-agent parallel force pass shared by all three compile ' +
    'targets can express. Since the difference is very close to a uniform scale factor, and the view ' +
    'is fitted anyway, what a viewer can actually see — the scale-free packing and ring ratios — ' +
    'agrees to within 4-11 %.\n\n' +
    'THE WORLD is ' + W + ' units across, measured rather than assumed: grown in the app to four thousand ' +
    'nodes the structure spans about 8500 x 7000 with a sevenfold margin and nothing touching the ' +
    'boundary. The bounds exist only so nothing can be clamped; the reference has none and fits its ' +
    'view to the structure instead, which is why the first few dozen nodes start small here — zoom ' +
    'in, or let it grow.\n\n' +
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
    'without noise. The twelve named rules come first, then the demo\'s eleven further rules under ' +
    'their rule number. Mutation Rate is a live slider — nudge it on a stalled rule and watch it ' +
    'restart. In the Attributes panel, Randomize either rule table to roll an automaton nobody has ' +
    'seen; the seed and density are stored, so an interesting one reproduces exactly.\n\n' +
    'Two more sliders are for looking rather than for the rule. Max Generations freezes the ' +
    'automaton at a generation you choose while the layout keeps untangling — the way to let a shape ' +
    'settle before judging it; put it back to 0 (or raise it) and growth resumes from where it ' +
    'stopped. Node Radius resizes every node live, from pinpricks to fat beads on a bond length of ' +
    REST + '.\n\n' +
    'One reference tick is ' + PERIOD + ' generations: a state tick that latches which nodes will divide, then ' +
    DIVISION_ROUNDS + ' division rounds that drain those latches a non-adjacent set at a time, so the node count ' +
    'climbs over several generations and then pauses while the next state is computed. The ' +
    'simulation stops at ' + NODE_CAP + ' nodes.\n\n' +
    'The world is big enough that a full-grown structure never reaches its edge, so while the graph ' +
    'is still young it is small in the view — scroll to zoom in on it, and back out as it grows.',
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
  // Create Agent returns -1, the split's Transfer finds no target and is rejected,
  // bare break, and the graph stops being 3-regular. A generation can at most
  // split a maximal independent set, i.e. at most double N, so pausing at
  // NODE_CAP with maxAgents >= 2 x NODE_CAP cannot be crossed.
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
  growthRate: GROWTH_RATE,
  // COLLISION IS OFF (znah has none), so the soft-sphere never runs and these two
  // are inert. repulsionStiffness is 0 rather than left at its default because
  // `effectiveAgentDt`'s stability bound reads it UNCONDITIONALLY (mu_eff = mu_R + lambda)
  // — a non-zero value there would clamp dt for a force the model never applies.
  repulsionStiffness: 0,
  adhesionStiffness: 0,
  interactionRange: 2.2,
  // THE EFFECTIVE STEP IS 1, which is what znah's integrator does: it adds the
  // per-step force impulse straight to the velocity (`vel += F`) and then moves by
  // it (`points += vel`), i.e. there is no dt/eta at all. Ours is
  // `v = momentum·v + (dt/eta)·F`, so dt/eta must be exactly 1 — and it cannot be
  // reached by setting timeStep alone, because the Mathias bound CLAMPS
  // dt to 0.2/mu_eff. With mu_eff = 0 + 0.5 the bound is exactly 0.4, so timeStep 0.4
  // is admitted unclamped and drag 0.4 makes dt/eta = 0.4/0.4 = 1 exactly.
  drag: 0.4,
  timeStep: 0.4,
  // znah's `velocityDecay = 0.1` => `vel *= 0.9` after every move. Substituting
  // w = u + F (his pre-decay velocity) into his loop gives w' = 0.9·w + F(x'),
  // x' = x + w — the SAME recursion as ours at dt/eta = 1, so momentum IS 1 - decay.
  momentum: 0.9,
  maxSpeed: 0,                  // znah caps nothing
  // Inert: nothing queries the hash (the rule's census is over BONDED partners and
  // the global charge rides the octree, not the stencil). Sized to the layout scale
  // only so the per-generation hash build stays cheap.
  neighbourQueryRadius: REST * 2,
  // FALSE so the neighbour scan is skipped ENTIRELY (`doScan` = force || density ||
  // cutoff-charge, and global charge does not join it). The bond springs are gated
  // on the Bonds=Physics capability, INDEPENDENTLY of this flag, so they still run.
  useBondingPhysics: false,
  autoBond: false,
  bondStiffness: STIFF,
  bondRestLength: REST,
  formDistance: 1.15,
  breakDistance: 1.8,
  agentUpdateMode: 'sync',
  // C10 + follow-up — GLOBAL charge (deterministic Barnes-Hut) WITH znah's cutoff.
  chargeStrength: CHARGE_K,
  chargeRange: 'global',
  chargeMaxDist: CHARGE_MAX_DIST,
  chargeTheta: CHARGE_THETA,
  layoutIterations: LAYOUT_ITERATIONS,
  agentCapabilities: {
    motion: 'force', body: true, collision: 'off', bonds: 'physics', autoBond: false,
    charge: 'on',
    // LIFESPAN is on because the "Birth generation" viewer reads Get Age — the
    // capability gate would otherwise hide a node this model actually uses.
    // GROWTH is on only to carry the Node Radius slider (Set Target Radius +
    // a snap-rate ramp). Nothing in the rule reads a radius, so the C8 geometry
    // verdict is unaffected; DIVISION stays off — the split is Create Agent +
    // Form/Transfer Bond, never the engine's Divide Agent.
    growth: true, division: false, lifespan: true, populationBirth: true,
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
console.log(`  cadence: PERIOD ${PERIOD} = 1 state tick + ${DIVISION_ROUNDS} division rounds`);
console.log(`  default rule ${DEFAULT_RULE}  next=[${nextBits(DEFAULT_RULE)}]  divide=[${divideBits(DEFAULT_RULE)}]`);
console.log(`  presets: ${presets.length} (${NAMED_PRESETS.length} named + ${NUMBERED_PRESETS.length} numbered)`);
console.log(`  world ${W}x${H}  cap ${NODE_CAP} nodes  maxAgents ${MAX_AGENTS}`);

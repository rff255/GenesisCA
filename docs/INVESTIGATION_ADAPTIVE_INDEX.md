# INVESTIGATION — adaptive spatial index for exact fixed-radius agent queries

**Phase**: C11 (P11b) of the Clarity & Simplification initiative.
**Status**: ⛔ **MEASURED — NOT SHIPPED.** No tree-accelerated query path was added
to the engine. The measurements, the analysis and the **retry preconditions** are
below; the E2-withdrawal precedent
([HANDOFF_LATTICE_DISPLAY_RES_PRESENT.md](HANDOFF_LATTICE_DISPLAY_RES_PRESENT.md))
is the model for this record.

**What DID ship from this phase**: the benchmark itself
([scripts/bench-spatial-index.mjs](../scripts/bench-spatial-index.mjs)) and one
diagnostics row, because the measurement turned up a real, shipped, *silent*
fast-path loss — see §6.

---

## 1. The question, and the decision rule fixed before the numbers

P11 item 2 of [PROPOSAL_CLARITY_SIMPLIFICATION.md](PROPOSAL_CLARITY_SIMPLIFICATION.md)
proposes an **adaptive index**: keep the uniform hash where it is near-optimal,
switch to a tree where trees win, choose per model from its actual radius/density
stats, and show the choice in the P4 diagnostics panel. Its own honesty clause is
the thing to test:

> the uniform hash is near-optimal for short radii at roughly uniform density
> (DC1 measured that regime and was not wrong); trees win when the radius is large
> relative to spacing or the population is heavily clustered in a huge sparse
> world — notably the GRA regime.

**The C11 decision rule (runbook §C11, written before any measurement):** ship the
adaptive index **only** where the tree wins **≥1.5×** on a fixture class that
**real models occupy**. Otherwise record everything and close with no engine change.

Two constraints framed the work and are worth restating because they eliminate
whole design branches:

- **Discrete decisions are never approximated** (P11 item 3). "How many agents
  within r" has no θ. So the contender had to be an **exact** range query —
  identical neighbour sets, asserted, not "close enough".
- **Iteration order is semantics.** The gather order feeds f32 accumulation and
  nearest/first semantics, so a shipped traversal would additionally need
  order-canonicalization identical on JS and WASM. That cost is real but it was
  never reached: the decision failed earlier, on the wins themselves.

---

## 2. What the shipped hash actually is (and why the proposal's hypothesis needed testing)

`buildSpatialHash` ([agentEngine.ts](../src/simulator/engine/agentEngine.ts)) is a
uniform CSR hash with three properties that matter here, and the first one is the
reason the "large radius" hypothesis is not automatically true for GenesisCA:

1. **The bin edge TRACKS the query radius.** The worker builds it at
   `max(interactionRange · 2 · maxR, neighbourQueryRadius, chargeBinEdgeOf(cfg))`
   (`sim.worker.ts`, both the JS/WASM and the per-generation WebGPU path). So a
   3×3(×3) stencil always spans ≥ 3r, and the over-scan is
   `(3r)^d / V_ball(r)` = **≈ 2.9× in 2D and ≈ 6.4× in 3D — a CONSTANT, independent
   of r/spacing.** A fixed-bin hash degrades as the radius grows; this one does not.
2. **Bounded worlds are bbox-anchored**; a cluster in a huge bounded volume pays for
   its own extent, not the volume's.
3. **A torus spans the whole world** and coarsens the edge to fit
   `AGENT_HASH_BIN_CAP` (65 536 bins). *This* is where the edge can float far above
   the query radius — and it is the structural degradation the tree could beat.

There is also a **bail**: fewer than 3 bins on any axis returns `null`, because the
wrapping 3-wide stencil would otherwise visit the same bin twice and double-count.
Every emitted query then takes its **all-pairs** fallback — correct, O(N²), silent.

---

## 3. Method

[scripts/bench-spatial-index.mjs](../scripts/bench-spatial-index.mjs) (new; run
`node scripts/bench-spatial-index.mjs`, `--quick`, or `--stats`) measures **three**
contenders per fixture, each doing one generation's work = index build + one query
per agent:

| contender | what it is |
|---|---|
| **hash-shared** | the SHIPPED path — ONE hash at the engine's real bin edge, queried with the stencil transcribed from `GetNearbyAgentsNode`'s emit (2D + 3D arms, torus fold, `<= r²`, self/dead excluded), including its all-pairs fallback when the hash bails |
| **hash-tuned** | a SECOND hash whose bin edge is the QUERY's own radius. The cheap alternative the tree has to beat to be worth building — same code, same tight contiguous inner loop, no traversal |
| **tree** | **C10's `buildAgentOctree`** (already Morton-ordered, order-canonical, 3D-native, with per-node bboxes) + an exact bbox-pruned range query: prune when the nearest bbox corner is beyond r, take the whole node when the farthest corner is within r, else descend / test leaf points. Torus by minimum-image query-point replication |

**The C10 tree was reused, per the orchestrator's note.** It needed no modification:
`nodeMinX/…/nodeMaxZ` (its scratch fields, live on the returned object) are exactly
the pruning structure a range query wants. The only thing a shipped version would
add is a `sortedId` array; the prototype reconstructs it and **charges that cost to
the tree build** so the comparison stays fair.

**Exactness is asserted, not assumed**: every fixture compares all three contenders'
neighbour sets per agent, sorted, and the script exits non-zero on any difference.

**Two honesty controls are built into the design**:

- **A noise floor.** When `sharedEdge === queryR` the two hashes are constructed
  *identically*, so `tunedX` must be 1.00; the spread of those rows measures the rig.
  Observed: **0.72×–1.57×**, worst at small absolute times. **Any claimed win below
  ~1.6× on a sub-10 ms fixture is inside this rig's noise**, and run-to-run the
  genuine tree wins themselves moved ±25 % (e.g. 2D r/space=10 at N=20 000:
  1.95× then 1.70×).
- **A work count.** Candidates examined per query — bin entries for a hash, leaf
  points distance-tested for the tree — is implementation-independent, so where the
  wall clock and the candidate ratio disagree, the constant factors are doing the
  work rather than the algorithm.

**Fidelity limit, and what the data says about it.** The shipped hash query is
*inlined generated code inside the agent loop*; every contender here is a standalone
function pushing into a JS array. Both hash contenders pay that overhead equally, so
hash-vs-hash is clean. The prior worry was that the inflated per-candidate cost would
bias the clock **toward** the tree — but §5.4 shows the bias runs the **other** way:
the tree's realised speedup is consistently far *below* its candidate advantage
(9.6× candidates → 2.0× time; 22.8× → 11.2×; 15.2× → 5.3×), because a traversal
spends its time on node bookkeeping and scattered access rather than on candidate
tests. **A shipped tree would therefore be expected to do no better than these
numbers, and plausibly worse against inlined emitted code.**

---

## 4. The shipped models' real radius / density stats

This table is what "a fixture class real models occupy" is read against
(`node scripts/bench-spatial-index.mjs --stats`). `binEdge` is the engine's ONE bin
edge; `edge/r` is the resulting over-scan for that query.

| model | world | bnd | N | binEdge | spacing | query r | **r/space** | **edge/r** | hash |
|---|---|---|---|---|---|---|---|---|---|
| Ant Necrophoresis | 80×80 | torus | 120 | 2.00 | 7.30 | — | — | — | 40×40 bins |
| Boids — Flocking | 120×120 | torus | 600\* | 14.00 | 4.90 | 14.00 | 2.86 | 1.00 | 8×8 bins |
| Boids — Hemifield Vision | 120×120 | torus | 600\* | 16.00 | 4.90 | 12.00 / 4.50 / 16.00 | 2.45 / 0.92 / 3.27 | 1.33 / 3.56 / 1.00 | 7×7 bins |
| Chemotaxis — Aggregation | 100×100 | torus | 500\* | 5.00 | 4.47 | — | — | — | 20×20 bins |
| **Cubic GRA** | 600×600 | torus | 6000\* | 20.00 | 7.75 | 6.00 | 0.77 | **3.33** | 30×30 bins |
| Game of Life on Agents | 32×32 | torus | 1040\* | 2.00 | 0.99 | 1.50 | 1.51 | 1.33 | 16×16 bins |
| Graph Metrics — Growth Sweep | 120×120 | torus | 1500\* | 4.00 | 3.10 | — | — | — | 30×30 bins |
| Life on Bonds | 32×32 | torus | 1040\* | 2.00 | 0.99 | — | — | — | 16×16 bins |
| Morphogenesis — 3D Tissue | 60×60×40 | bnd | 4000\* | 5.00 | 3.30 | — | — | — | bbox bins |
| Morphogenesis — Differential Tissue | 90×90 | bnd | 2200\* | 5.00 | 1.92 | — | — | — | bbox bins |
| Morphogenesis — Growing Tissue | 100×100 | torus | 1500\* | 5.00 | 2.58 | — | — | — | 20×20 bins |
| **Particle Life 3D** | 160×110×70 | torus | 1200 | 24.00 | 10.09 | 16.00 | 1.59 | 1.50 | **ALL-PAIRS (bins 6×4×2)** |
| Particle Life | 320×200† | torus | 1800† | 24.00 | 8.43† | 16.00 | 1.90† | 1.50 | 13×8 bins |
| **SDCA — Couplers and Decouplers** | 220×220 | torus | 400\* | 28.00 | 11.00 | 7.00 | 0.64 | **4.00** | 7×7 bins |

`*` = the `maxAgents` cap (the model declares no N attribute).
`†` = **HEAD values.** The working tree carries a pre-existing user modification to
`Particle Life.gcaproj` (400×400, `maxAgents` 50 000) which was left untouched and
uncommitted; the `--stats` output reflects whatever is on disk.

**Three facts fall straight out of this table.**

1. **No shipped model exceeds r/spacing = 3.27.** The proposal's "radius large
   relative to spacing" regime is *not occupied*. The largest is Boids' far cone.
2. **No shipped model triggers the bin cap.** A torus needs > 256 bins per axis
   (W/edge > 256) to coarsen; the widest shipped case is Cubic GRA at 30×30. The
   "clustered in a huge sparse world" regime is *not occupied either* — the GRA blob
   grows to occupy roughly a third of its 600² world, and its 20-wide bins tile it
   comfortably.
3. **The real over-scan in shipped models comes from a different cause than the
   proposal named**: ONE hash serves every consumer, so its edge is the LARGEST
   radius anything needs — a charge cutoff (Cubic GRA 20, SDCA 28) or
   `neighbourQueryRadius` (Particle Life 24) — while a graph query may ask for far
   less (6, 7, 16). That is `edge/r` up to 4.0×.

---

## 5. Results

`node scripts/bench-spatial-index.mjs` — index build + one query per agent, best of
3, ms. `**` marks the ≥1.5× decision threshold. **Two independent full runs were
taken** (run 1 / run 2 quoted where they differ materially); they agree on every
sign and on which fixtures clear the bar, and disagree by up to ±25 % on magnitudes
— with ONE exception that matters, called out in §5.3.

### 5.1 A — uniform density, sweeping radius / mean spacing

| fixture | N | r/space | nbr/agent | shared | tuned | tree | **treeX** |
|---|---|---|---|---|---|---|---|
| 2D | 2 000 | 0.5 | 0.7 | 2.03 | 1.84 | 3.90 | 0.52× |
| 2D | 2 000 | 1 | 3.1 | 1.63 | 1.68 | 5.29 | 0.31× |
| 2D | 2 000 | 2 | 12.6 | 1.79 | 2.20 | 2.45 | 0.73× |
| 2D | 2 000 | 5 | 78.5 | 6.20 | 6.07 | 5.36 | 1.16× |
| 2D | 2 000 | 10 | 315.1 | 24.37 | 26.84 | 12.59 | **1.94×** |
| 2D | 2 000 | 15 | 706.9 | 66.01 | 66.77 | 21.24 | **3.11×** (hash bails) |
| 2D | 20 000 | 0.5 | 0.8 | 10.79 | 6.89 | 16.69 | 0.65× |
| 2D | 20 000 | 1 | 3.1 | 13.26 | 13.91 | 22.54 | 0.59× |
| 2D | 20 000 | 2 | 12.6 | 25.86 | 25.79 | 28.62 | 0.90× |
| 2D | 20 000 | 5 | 78.4 | 74.77 | 78.97 | 62.88 | 1.19× |
| 2D | 20 000 | 10 | 314.1 | 269.2 | 270.4 | 138.4 | **1.95×** |
| 2D | 20 000 | 15 | 706.7 | 644.5 | 650.3 | 250.7 | **2.57×** |
| 3D | 20 000 | 2 | 33.5 | 109.4 | 105.2 | 131.2 | 0.83× |
| 3D | 20 000 | 5 | 523.7 | 1178 | 1219 | 577.0 | **2.04×** |
| 3D | 20 000 | 10 | 4188.5 | 7567 | 7595 | 2354 | **3.21×** (hash bails) |

**The hash wins or ties out to r/spacing ≈ 5 and loses beyond ≈ 10.** DC1's finding
stands, and the crossover is far above every shipped model (max 3.27).

### 5.2 B — clustered in a sparse world (the regime the proposal predicted)

Four Gaussian blobs (σ = 40) of 20 000 agents, r = 8, in progressively larger worlds.

| fixture | world | r/space | edge/r | shared | tuned | tree | **treeX** |
|---|---|---|---|---|---|---|---|
| torus ×4 | 960² | 1.18 | 1.00 | 49.34 | 53.83 | 51.34 | 0.96× |
| bounded ×4 | 960² | 1.18 | 1.00 | 51.94 | 48.26 | 51.46 | 1.01× |
| torus ×16 | 3 840² | 0.29 | 1.88 | 110.9 | 101.5 | 56.72 | **1.96×** |
| bounded ×16 | 3 840² | 0.29 | 1.32 | 55.62 | 56.90 | 57.90 | 0.96× |
| torus ×64 | 15 360² | 0.07 | 7.50 | 602.7 | 566.6 | 58.91 | **10.23×** |
| bounded ×64 | 15 360² | 0.07 | 4.29 | 569.8 | 512.0 | 141.9 | **4.01×** |

**The prediction is CONFIRMED — and its trigger is precisely the bin cap.** The
degradation appears exactly when the world grows past the point where the natural
bin edge would exceed 65 536 bins and `buildSpatialHash` coarsens. Bounded is the
control and behaves as designed (bbox-anchored, 0.96× at ×16); it only degrades at
×64, where the four blobs are spread so far apart that their joint bbox is
effectively the world again.

**But no shipped model is anywhere near this.** Reaching it needs W/edge > 256.

### 5.3 C — fixtures shaped like the shipped models

| fixture | N | edge/r | **tunedX** (run 1 / 2) | **treeX** (run 1 / 2) |
|---|---|---|---|---|
| GRA-like (edge 20, r 6) | 3 000 | 3.33 | 1.77× / 1.71× | 0.95× / 1.18× |
| SDCA-like (edge 28, r 7) | 400 | 4.49 | 1.99× / 1.87× ‡ | 1.51× / 1.57× ‡ |
| **PL-like (edge 24, r 16)** | 1 800 | 1.54 | 1.16× / 0.96× | **2.07× / 1.14×** |
| Boids (edge 14, r 14) | 260 | 1.07 | 0.72× / 1.02× | 0.46× / 0.71× |
| **PL3D shipped (hash bails)** | 1 200 | — | **7.94× / 6.43×** | **5.15× / 5.28×** |
| **PL3D grown** | 8 000 | — | **10.45× / 10.81×** | **12.28× / 11.30×** |

`‡` total wall clock 0.62 / 0.35 ms — **inside the measured noise floor**; disregard.

**THE ONE ROW THAT MOVED.** `PL-like` measured **2.07× in run 1 and 1.14× in run 2**
— an 1.8× swing on an identical, deterministic fixture. It was the single
shipped-shaped fixture where the tree appeared to clear the bar, and a second run
removed it. This is exactly why the decision rule is applied to *repeated*
measurements, and why the E2 precedent's "interleaved A/B, never quote an absolute"
caveat is carried into §9.

### 5.4 Work counts — the implementation-independent view

Candidates examined per agent (bin entries for a hash; leaf points distance-tested
for the tree — points inside a fully-contained node are *taken*, not tested).

| fixture | kept | sharedC | tunedC | treeC | treeNodes | **cand ratio** | time ratio |
|---|---|---|---|---|---|---|---|
| 2D uniform r/space=2 (N=20k) | 12.6 | 37.7 | 37.7 | 30.0 | 38.1 | 1.26× | 0.80× |
| 2D uniform r/space=5 | 78.4 | 230.7 | 230.7 | 76.7 | 67.9 | 3.01× | 1.16× |
| 2D uniform r/space=10 | 314.1 | 919.4 | 919.4 | 154.2 | 123.5 | 5.96× | 1.70× |
| 2D uniform r/space=15 | 706.7 | 2223.4 | 2223.4 | 231.4 | 181.2 | 9.61× | 2.01× |
| 3D uniform r/space=5 | 523.7 | 4320.8 | 4320.8 | 539.2 | 474.6 | 8.01× | 2.07× |
| B torus cluster ×16 | 49.5 | 474.8 | 474.8 | 62.6 | 59.6 | 7.59× | 2.04× |
| B torus cluster ×64 | 49.5 | 3800.6 | 3800.6 | 166.6 | 39.8 | 22.81× | 11.16× |
| **C GRA-like** | 0.9 | 31.0 | **3.7** | 14.4 | 19.9 | 2.16× | 1.18× |
| **C SDCA-like** | 1.2 | 75.2 | **4.8** | 10.8 | 16.3 | 6.97× | 1.57× |
| **C PL-like** | 22.6 | 157.0 | **68.6** | 55.4 | 33.1 | 2.83× | 1.14× |
| C Boids | 11.1 | 37.7 | 37.7 | 30.9 | 23.4 | 1.22× | 0.71× |
| **C PL3D shipped** | 16.7 | 1200.0 | 135.3 | **79.0** | 70.3 | 15.20× | 5.28× |
| **C PL3D grown** | 111.1 | 8000.0 | 900.7 | **214.6** | 194.0 | 37.28× | 11.30× |

Two things this table settles that the wall clock alone could not:

1. **The tree never realises its algorithmic advantage.** Every row's time ratio is
   well under its candidate ratio — roughly its square root across the sweep. A
   traversal pays in node bookkeeping and scattered memory what it saves in tests,
   and it would pay *more* against the shipped inlined emit.
2. **On the 2D shipped shapes the tuned HASH is algorithmically the best of the
   three**, not the tree: GRA-like 3.7 candidates vs the tree's 14.4, SDCA-like 4.8
   vs 10.8, PL-like 68.6 vs… 55.4 (the tree edges it here, and still loses on time).
   The tree only leads on candidates where the hash cannot tile at all (PL3D) or
   where the cap coarsens it (B ×16/×64). The reason is structural: a hash at edge = r
   has *tighter* cells than an octree leaf holding up to 16 points.

---

## 6. THE FINDING THAT MATTERED — Particle Life 3D silently runs all-pairs

`Particle Life 3D` ships a 160×110×70 torus with `neighbourQueryRadius = 24`. Its
depth admits `floor(70 / 24) = 2` bins — **under the 3-bin minimum** — so
`buildSpatialHash` returns `null` and **every neighbour query in that model runs the
all-pairs fallback**, on every target, every generation. Measured: **43.6 ms vs 5.5 ms**
per generation of queries at its shipped N = 1200, and **1037 ms vs 99 ms at N = 8000**
(the model's `maxAgents` is 2400, so the grown row is a scaling illustration, not a
shipped configuration).

Three things about this are worth separating:

- **The bail is CORRECT.** With 2 bins the wrapping 3-wide stencil visits a bin
  twice and would double-count neighbours. Returning `null` is the right call.
- **The fix is not a tree.** A hash at the *query* radius (16) tiles the same world
  `floor(160/16) × floor(110/16) × floor(70/16)` = 10×6×4 and beats the shipped path
  by **7.94×**, slightly MORE than the tree's 5.15× and for a fraction of the
  engineering. Equivalently, the model author could set `neighbourQueryRadius` to
  the 16 it actually queries with.
- **It was invisible.** Nothing reported it. That is the P4 gap, not a geometry gap,
  so **C11's one shipped change is a diagnostics row**, not an index — see §8.

**Confirmed on the shipped execution path, not just in the harness.** In the running
app (real file load, real worker, WebGPU agent target), `Particle Life 3D` reports
`spatialIndex: { built: false, reason: "the world (160x110x70) is under 3 bins wide
on some axis at the resolved bin edge (bins 6x4x2)" }` — and it reports it from the
**GPU-RESIDENT batch**, whose `computeResidentHashParams` carries the identical
3-bins rule. So the loss is real on every path this model can take, and the
diagnostic covers all of them. **The advice is actionable, measured**: reloading the
same model with `neighbourQueryRadius` lowered 24 → 16 (what its graph actually
queries with) makes the hash build — **240 bins of 16.0** (10×6×4). Positive control:
`Boids — Flocking` reports `spatial hash, 64 bins of 15.0`, matching its 8×8 row in
§4. **The shipped model was NOT retuned** (shipped-configs-are-deliberate); the
`nqr = 16` run was a probe and the fix is the user's call.

---

## 7. VERDICT — do not ship the adaptive index

Applying the rule literally:

| the tree wins ≥1.5× when… | occupied by a shipped model? |
|---|---|
| r/spacing ≳ 10 (2D) or ≳ 5 (3D) | **No** — the maximum across the library is 3.27 |
| the bin cap coarsens the edge (torus world > ~256 bins/axis) | **No** — the widest shipped case is 30 bins/axis |
| the hash bails to all-pairs (< 3 bins on an axis) | **Yes — Particle Life 3D.** But `hash-tuned` wins as much or more (6.4–7.9× vs 5.2×) |
| shipped-shaped fixtures (GRA / SDCA / Boids / PL) | occupied, and the tree measures **0.46×–1.18×**, or inside the noise floor |

**No shipped-shaped fixture survives a second run.** `PL-like` was the only one that
cleared the bar on the clock (2.07×) and it fell to 1.14× when re-measured;
`SDCA-like` clears it at a total wall clock of 0.35 ms, inside the noise floor;
`GRA-like` and `Boids` never clear it at all. And on the two 2D shipped shapes the
tuned *hash* examines fewer candidates than the tree does (§5.4), so there is not
even a latent algorithmic win hiding behind a poor constant factor.

It is also worth stating what this benchmark did NOT measure: the *gather* in
isolation. A real Particle Life generation does three table lookups and several
expressions per **accepted** neighbour on top of the gather, so a gather speedup is
diluted before it reaches the user. That makes the case weaker still, not stronger.

So: **every regime where the tree clearly wins is either unoccupied by the library,
or won more cheaply by a hash built at the right radius.** The adaptive index is
not shipped. The proposal's honesty clause turned out to be the whole answer —
DC1 measured the occupied regime and was not wrong, and GenesisCA's hash is
additionally *radius-adaptive*, which removes the mechanism by which trees usually
overtake a fixed-bin hash.

**If an index is ever wanted, the cheap alternative comes first.** "hash-tuned"
— a per-radius hash — matched or beat the tree on every shipped-shaped fixture
(1.71–1.99× on GRA-like and SDCA-like where the tree got ~1.2×), needs no traversal,
no order-canonicalization, and no new build-time structure. That, not a tree, is
what "adaptive index" should mean here. **It is not shipped either**, because the
same rule applies to it: the fixtures where it wins are sub-5 ms gathers whose
benefit has not been shown to reach a real generation, and it costs a second O(N)
build every step for every model that has it. It is recorded as the first thing to
try (§9.4), not as a pending change.

---

## 8. What shipped instead

1. **[scripts/bench-spatial-index.mjs](../scripts/bench-spatial-index.mjs)** — the
   measurement tool, with the exactness assertion, the shipped-model stats table
   (`--stats`), the noise-floor control and the work counters. Re-run it before
   re-opening this question.
2. **One diagnostics row.** `getDiagnostics` gained a `spatialIndex` block recorded
   at the worker's build sites — `noteAgentHash` for the two `buildSpatialHash`
   calls (JS/WASM and the per-generation WebGPU path) **and an equivalent record in
   the GPU-RESIDENT batch**, which builds its hash on the GPU and so never reaches
   `buildSpatialHash` at all. Every one records the decision the engine took; none
   re-derives it. The C3 popover shows **Agent neighbour index** with either
   `spatial hash, N bins of E` or an explanation that all-pairs is running and which
   setting dominates the bin edge. No simulation behaviour changed; no compiler file
   was touched (`git diff --stat` = `sim.worker.ts` + `SimulatorView.tsx`).

   *The resident path was the trap here: a first version recorded only at the two
   `buildSpatialHash` sites and reported `applicable: false` for Particle Life 3D —
   the very model the row exists for — because its batch never calls that function.*

**Deliberately NOT a toast.** C6's amber-toast channel is for "we are running
something else now" *fallback events*; an all-pairs index is harmless on a small
model (Game of Life on Agents would fire it constantly if the threshold were naive)
and the popover is the P4 surface that exists precisely for "which fast paths
engaged". A passive, on-demand row is the honest placement.

---

## 9. RETRY PRECONDITIONS — what must be true before re-opening this

Do not re-attempt the adaptive index until **at least one** of these holds, and
re-run `scripts/bench-spatial-index.mjs` first to confirm it on the machine of the
day:

1. **A real model with r/spacing ≥ 8.** Today's maximum is 3.27. A sensing model
   with a wide cone in a dense population would qualify; the fixture class is
   already in the script (`A uniform … r/space=10/15`).
2. **A real model that coarsens the bin cap** — a torus world more than ~256 bins
   wide at its bin edge (e.g. a GRA blob grown in a 10 000-wide world), or a bounded
   population whose bbox is effectively the world. Fixture class `B … world×16/×64`.
3. **The per-query over-scan is the measured bottleneck of a real generation.** This
   investigation measured the gather ALONE. Before believing a gather speedup
   matters, profile a real model with `scripts/bench-agent-engine.mjs` and show that
   neighbour gathering — not the per-pair rule work — dominates the `behaviour`
   phase.
4. **The cheap alternative has been tried and is insufficient.** A second hash at
   the query radius (or simply lowering `neighbourQueryRadius` to what the graph
   actually asks for) matched or beat the tree everywhere it mattered here. If a
   per-radius hash is shipped and *still* leaves a ≥1.5× gap on an occupied class,
   that is the moment for a tree.

And two things any future attempt must budget for, which this phase never reached:

- **Order-canonicalization across JS and WASM.** The gather order is semantics
  (f32 accumulation, nearest/first). The hash's order is "bin, then slot"; a tree's
  is Morton. Changing it changes results for every model that gathers, so a shipped
  tree query needs either a canonical re-sort (cost) or an accepted, documented
  behaviour change (a migration).
- **Three targets, not one.** WASM would need the traversal emitted (C10's charge
  traversal is the template), and WebGPU would need the tree uploaded per generation
  — which, as C10 recorded, forfeits GPU residency until a GPU-side tree build
  exists.

---

## 10. Reproducing

```
node scripts/bench-spatial-index.mjs            # full sweep (a few minutes)
node scripts/bench-spatial-index.mjs --quick    # fewer reps
node scripts/bench-spatial-index.mjs --stats    # the shipped-model table only
```

The script exits non-zero if any contender's neighbour set differs from the hash's.
Measurements in this document were taken on the development machine on 2026-08-03;
**quote the ratios, re-measure the absolutes.**

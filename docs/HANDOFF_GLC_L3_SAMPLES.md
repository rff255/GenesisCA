# PHASE L3 — Solver iterations, sample retune, Expression refactor

**Read first**: [HANDOFF_GRAPH_LAYOUT_CADENCE.md](HANDOFF_GRAPH_LAYOUT_CADENCE.md)
§0, §0b, §3.1 (the layout probe — your exit oracle). Design authority:
[IMPACT_MAP_GRAPH_LAYOUT_CADENCE.md](IMPACT_MAP_GRAPH_LAYOUT_CADENCE.md) §1.4, §1.5, §1.6.
**Predecessors' Completion Reports**: L1 (charge parameters + measured 3D cost),
L2 (`Periodic Step`, and the pinned generation semantics).

**State**: READY · **Depends on**: L1 **and** L2 · **This is the visible payoff.**

---

## 1. Why this phase exists

L1 and L2 built the capability. **Nothing the user opens has changed yet.** This phase
makes the shipped GRA models actually readable and faster, and cleans up their rule
graphs.

---

## 2. Scope

### 2.1 `layoutIterations` — an engine knob (NOT a graph node)

Run the force pass **N× per generation** (default **1** = today's behaviour exactly).
This is numerical relaxation, not rule logic — the same category as the existing
`positionalIterations`, and deliberately **not** a node (Impact Map §1.6).

The reference uses `tickSteps: 2`. Expect 2–8 to be the useful range; measure.

**`layoutIterations = 1` must be byte-identical to pre-L3.**

### 2.2 Retune the samples

Using L1 + L2, for `Cubic GRA` and `SDCA — Couplers and Decouplers`:

- **Charge on**, `chargeMaxDist` ≈ **8 × bond rest length** (Impact Map §1.3).
- **Unsaturate the world.** A 220×220 torus needs ~2.6× more area at N ≈ 5120
  (§1.4) — the graph *cannot* lay out at any repulsion strength. Enlarge it (or drop
  the torus for these models) so the target population has room. State the sizing rule
  you used.
- **Newborn placement at the parent midpoint**, not on top of the mother — the
  reference passes `addedHints` so each new node starts at the midpoint of its two
  parents plus a small jitter. Currently the triangle split's newborns start
  essentially coincident, so every split begins from a degenerate configuration.
- **A `Periodic Step`** so rewriting is slower than relaxation (the L2 point). Choose
  the period from measurement, not taste.

### 2.3 The Expression refactor

Replace the `arithmeticOperator` chains in the GRA models with **`expression`** nodes
for conciseness. Current counts: **`Cubic GRA` 10 Math**, **`SDCA` 9 Math**;
`Life on Bonds` already uses **2 Expressions**, so the idiom is established and the
node is agent-target-supported.

> ⚠️ **This is a PURE REFACTOR.** The rule's decisions must not change. Prove it: O6
> (`min degree == max degree == 3`, `E == 3N/2`) must still hold at every generation,
> and the model's behaviour must be unchanged. If a rewrite changes any decision, it
> is a bug in the refactor, not an improvement.
>
> Update the **generator scripts** too (`scripts/gen-*.mjs`), or a re-run silently
> reverts the models — the shipped-model/generator drift rule.

### 2.4 Promote the probe

Make `scripts/probe-graph-layout.mjs` a **permanent** layout-quality gate driving the
**real engine** (post-L1 it should exercise the shipped charge term, not its local
copy), so a future regression in the force pass is caught by metric, not by eye.

---

## 3. What this phase must NOT do

- **No new engine forces** (L1 is done) and **no cadence machinery** (L2 is done).
- **Do not** put `layoutIterations` in the graph.
- **Do not** change the rewrite rule's semantics while refactoring to Expression.

---

## 4. Exit gate — all must pass, all recorded

| # | Criterion |
|---|---|
| **THE PICTURE** | `Cubic GRA` at N ≥ 2000: probe **overlap ≤ 1 %**, **nnb ÷ bond ≥ 0.6** — **and a screenshot, in a visible pane, of a readable graph.** This phase exists to make it look right; if the pane cannot be displayed, **say so explicitly rather than claim a visual check you did not make.** |
| **Speed** | steps/s **improves** versus the pre-L3 model at equal N — report **both** numbers. (The density argument, Impact Map §1.5: a spread layout is cheaper.) |
| **The refactor is pure** | O6 holds every generation over ≥ 200 generations after the Expression rewrite; the decisions are unchanged |
| **Generators updated** | re-running `gen-*.mjs` reproduces the shipped models |
| **`layoutIterations = 1` byte-identical** | the default path must not move |
| **SDCA still satisfies O8** | hysteresis: no flicker in the band; invariant topology when thresholds never fire |
| **I1–I5** | hold over ≥ 500 generations of both samples |
| Standard | tsc · build · full harness sweep · `check-compile-identity` (justify each sample diff — the retuned models legitimately change; nothing else may) |

---

## 5. Assumptions to check FIRST (stop and report if any is false)

1. **L1's charge and L2's `Periodic Step` behave as their Completion Reports claim**
   on a real model — verify both on `Cubic GRA` before retuning anything else.
2. **The force pass can be run N× per generation** without breaking the structural
   phase's ordering or the request-queue drain (the drain must still happen **once**
   per generation, not once per iteration — **this is the easiest way to corrupt the
   graph in this phase**).
3. **The Expression node covers every operator** the GRA models' Math chains use. If
   one is missing, keep that Math node rather than changing semantics.

---

## Completion Report — L3

**State**: DONE
**Commit(s)**
- `ed10907` — feat(agents): layoutIterations — run the force integrator N times per generation
- `4713563` — feat(gra): retune the flagship samples for a readable layout, and refactor their Math chains to Expression
- (this report + the docs sweep — final commit)

**Files touched**
```
 src/model/types.ts                                 | layoutIterations field
 src/model/centerBased.ts                           | layoutIterationsOf + MAX_LAYOUT_ITERATIONS
 src/modeler/panels/AgentCapabilitiesSection.tsx    | the Solver row
 src/modeler/vpl/compiler/agentWebgpu/forcePass.ts  | export emitForceControlStruct
 src/simulator/engine/sim.worker.ts                 | the CPU iteration loop + age correction + GPU dispatch args
 src/simulator/engine/agentWebgpuRuntime.ts         | relaxCommit pipeline + encodeForceIterations (both dispatch sites)
 scripts/gen-cubic-gra.mjs                          | world/charge/cadence/midpoint + Expression refactor
 scripts/gen-sdca.mjs                               | world/charge/layoutIterations + Expression refactor
 public/models/{Cubic GRA,SDCA - Couplers and Decouplers}.gcaproj
 scripts/test-layout-iterations.mjs                 | NEW — 46 checks
 scripts/probe-graph-layout.mjs                     | promoted: the SHIPPED-model gate
 scripts/verify-graph-rewrite.mjs                   | generation-aware + period-scaled budgets
 scripts/audit-agent-layout.mjs                     | the trailing-_generation prefix rule
 CLAUDE.md · README.md · src/help/HelpView.tsx      | docs
```

### What shipped

**1. `layoutIterations` — an ENGINE knob (default 1 = byte-identical).** The force
integrator runs N times per generation, on **all three targets**. Deliberately not a graph
node: solver relaxation is not rule logic, the same category as `positionalIterations`.

The property that had to hold: **everything that must happen once per generation still
does.** The loop is kept tight around `[force pass → position commit]` and nothing else, so
the structural phase — the bond request-queue drain, division, death, auto-bond — runs once,
below it. The hash build, the compiled behaviour and the graph-force reset also stay outside.
Age advances exactly once per generation; growth ramps at `rate / iterations`, which reaches
the same target radius (the ramp is clamped and monotonic), so no second uniform or bind
group was needed on the GPU. On WebGPU a new **relax-commit** pass separates consecutive
force passes at BOTH dispatch sites through one shared `encodeForceIterations`; it
deliberately does not zero the force accumulator or bump the generation counter (which would
break L2's `Get Generation`).

**2. The samples, retuned — three independent causes, each measured.**

| | Cubic GRA |
|---|---|
| charge | ON, `k = −10`, cutoff `20` = **4 × rest** |
| world | **600 × 600** torus (was 220), sized to the agent CAP |
| cadence | the WHOLE rule on ONE **Periodic Step, period 2** |
| newborns | torus-shortest **midpoint** between mother and inherited neighbour |

SDCA takes the same charge law and world rule (`k = −10`, cutoff 28 = 4 × rest 7; world
220 × 220) plus **`layoutIterations: 2`** instead of a Periodic Step.

**3. The Expression refactor — 19 Math nodes → 0.** Cubic GRA 10 → 7 Expressions, SDCA
9 → 5.

**4. The probe is a permanent PRODUCT gate.** It now reads `Cubic GRA.gcaproj` and takes
world, torus, charge strength and cutoff, radius, rest, stiffness and the
relaxation-per-rewrite ratio *from the model*, and asserts the layout on the **LIVE** state
(`settleTicks: 0` — no free settle, because mid-growth is the only state anyone looks at).

### Decisions resolved (with reasoning)

1. **Cutoff 4 × rest at `k = −10`, NOT 8 × rest at `k = −3`** — a measured refinement of the
   handoff's "≈ 8 × bond rest", not a departure from it. **Strength is a cheaper lever than
   reach**: the spatial-hash bin edge IS the cutoff, so doubling the reach quadruples the
   candidates the 3×3 stencil sweeps, while raising `|k|` costs nothing. Sweeping both axes
   on the real generative process (K4 → 2500 by triangle split at the model's own
   2 %/generation rate, through the shipped WASM force pass):

   | world | cutoff | k | settled nnb/bond | overlap % | live nnb/bond | live overlap % | ms/gen |
   |---|---|---|---|---|---|---|---|
   | 220 | off | — | 0.15 | 99.6 | 0.10 | 99.6 | 34 |
   | 400 | 40 (8×) | −3 | 0.73 | 0.2 | 0.56 | 13.0 | 40 |
   | 400 | 40 (8×) | −6 | 0.81 | 0.0 | 0.66 | 2.1 | 32 |
   | 400 | 20 (4×) | −3 | 0.57 | 0.6 | 0.44 | 56.1 | 23 |
   | **400** | **20 (4×)** | **−10** | **0.72** | **0.0** | **0.59** | **2.2** | **15** |

   The Impact Map's "quality saturates by ~8 × rest" sweep held `k` at −3; this is the second
   axis of that surface. The chosen point matches 8×/−3 on quality at **2.6× the speed**.

2. **The whole rule hangs off ONE Periodic Step, not just the rewrite.** Gating only the
   rewrite while states kept updating every generation would build a *different* automaton —
   exactly the mistake `Periodic Step` exists to prevent. Period **2** is the measured knee:
   1 / 2 / 3 / 4 relaxation passes per rewrite give live nnb/bond 0.59 / 0.65 / 0.68 / 0.71
   at 2.2 / 0.2 / 0.0 / 0.0 % overlap — and every further pass costs a full force pass, so
   the wall clock to a given N rises linearly for a diminishing return.

3. **Cubic GRA uses CADENCE; SDCA uses the ENGINE KNOB. The split is the point.** A GROWING
   graph must outrun its own rewriting — that is rule semantics, so the flagship gates the
   rule. SDCA has a FIXED population that simply needs to settle — that is solver relaxation,
   so it raises `layoutIterations`, keeps one generation meaning one rule step (its
   hysteresis band is a per-generation property), and, because it runs on the WebGPU agent
   target, is also the shipped model that exercises the new GPU relax-commit pass. Between
   them the two samples demonstrate both halves of the milestone.

4. **World sized to the agent CAP, not to today's population**:
   `side = ceil(sqrt(maxAgents × (rest × 1.45)²))`, where 1.45 is the measured settled
   bond/rest under charge. Sizing to the current N would re-jam the moment it grew.

5. **The refactor keeps the chain's operator ORDER, never a re-derivation.**
   `(verb - 1 + 1) % 3` is the five-node chain written as itself; `drive + agree * bonus`
   binds exactly as the Multiply-then-Add did; `lambda + rate * (d - lambda)` relies only on
   IEEE commutativity of `*`. Where a chain was a single node, it still became an Expression
   so both models now contain **zero** `arithmeticOperator`.

### Assumptions that proved FALSE

**None of the three.** All held:

1. **L1's charge and L2's Periodic Step behave as their reports claim on a real model** —
   verified on `Cubic GRA` before anything else was retuned (charge live A/B, and the
   Periodic Step firing on schedule through the real worker).
2. **The force pass can run N× per generation without the drain also running N×** — the
   structural phase is a separate function called once after the loop, so the loop only had
   to be kept tight around force + commit. Pinned as a source invariant AND behaviourally by
   O6 (a replayed drain would blow the degree invariant on the first generation).
3. **Expression covers every operator the GRA Math chains use** — they use only
   `+ − * %`, and Expression's `%` and `/` carry the *same* zero-divisor guards as
   `arithmeticOperator`, so nothing had to stay a Math node.

**Two real findings worth the same prominence:**

- **`verify-graph-rewrite.mjs` would have passed VACUOUSLY on a cadence model.** Its two
  drivers never supplied the `_generation` arg (the L2 asymmetry is *params gated, args
  always*; only the worker and the parity harness passed it). A Periodic Step model therefore
  read `undefined % period`, never fired, and every O6 check passed on a graph that did
  nothing at all — which is exactly what it reported the first time the retuned model ran.
  Both drivers now always supply it, and Tier K reads the period off the shipped file and
  scales its generation budgets by it, so a future cadence retune cannot silently shorten the
  headline check.
- **`audit-agent-layout.mjs`'s "2D is a strict prefix of 3D" invariant was already false for
  any cadence-using model.** `_generation` is appended AFTER the 3D block (dead last on every
  kind, by L2's design), so the raw lists are not prefixes. Nothing exercised it until this
  phase shipped the first Periodic Step model. The audit now strips a trailing `_generation`
  before comparing AND separately asserts it is LAST on both sides — a strictly stronger
  statement. Negative-controlled: making the field 3D-only fails exactly that assertion.

### Verification

| Gate | Result |
|---|---|
| **THE PICTURE — probe, shipped model, N ≥ 2000, LIVE (no settle)** | **✓ overlap 0.0 % (≤ 1), nnb/bond 0.67 (≥ 0.6)**, bond/rest 1.11 |
| **THE PICTURE — real browser, screenshot, visible pane** | **✓ seen.** A 2434-node cubic graph rendered as a readable web — individual nodes, individual edges, visible split triangles. The pre-L3 model at the same scale renders as a solid orange disc. |
| **THE PICTURE — real browser, measured (N ≈ 2500)** | **✓ nnb/bond 0.15 → 0.749, overlap 99.46 % → 0.00 %**, with `E = 3N/2` and min = max degree = 3 in both |
| **Speed, real browser, equal N, positive-controlled** | **✓ 29.37 → 10.60 ms/generation = 34.0 → 94.3 generations/s (2.77×)**; per agent 10.50 → 4.12 µs (2.55×). Both runs asserted `genDelta 200` and all 200 sampled agents moved. |
| **The refactor is pure** | **✓** O6 (`min deg == max deg == 3`, `E == 3N/2`) at **EVERY one of 440 generations** (220 rule steps, 847 splits, N 4 → 1698) and at every one of **1000** in the long run (500 rule steps). `N = 4 + 2t`, `E = 6 + 3t` exactly. |
| **Generators updated** | **✓** re-running `gen-cubic-gra.mjs` / `gen-sdca.mjs` reproduces the shipped models (both were regenerated from the scripts) |
| **`layoutIterations = 1` byte-identical** | **✓** `check-compile-identity` unchanged on all 29 models at the knob commit |
| **SDCA still satisfies O8** | **✓** hysteresis + I1–I4 at every one of 500 generations; link values converge to the drive; both stored copies agree |
| **I1–I5 over ≥ 500 generations** | **✓** both samples (Cubic GRA 1000 generations; SDCA 500) |
| `check-compile-identity --compare .gra-baseline/compile-identity-L2.json` | **✓ 9 diffs, all on the two retuned samples** (their agent + overseer surfaces, and the vestigial grid shader whose baked `total` follows the world size). **The other 27 models are unchanged on every surface.** |
| `test-layout-iterations.mjs` | ✓ 46 checks, 2 negative controls |
| `probe-graph-layout.mjs` | ✓ incl. the new shipped-model gate; negative-controlled |
| `verify-graph-rewrite.mjs` | ✓ 405 |
| `parity-agent-wasm` · `parity-agent-force` (20) · `check-agent-wasm-gate` (14/14) | ✓ ✓ ✓ |
| `audit-agent-layout` (240) · `test-agent-abi` (28) · `test-rule-cadence` · `test-agent-capabilities` (80) · `test-ndtable` | ✓ ✓ ✓ ✓ ✓ |
| `verify-agent-render` · `verify-render-uniform-layouts` | ✓ ✓ |
| `tsc` · `npm run build` | ✓ ✓ |
| **Real GPU — the relax-commit runs** | **✓ decisive.** From the SAME seeded initial condition on the WebGPU agent target: **A** (`layoutIterations 2`, 10 gens) vs **B** (`1`, 20 gens) vs **C** (`1`, 10 gens) — RMS position difference **A↔B 0.19** vs **A↔C 1.03** (B↔C 1.01). A tracks B **5.4× closer** than C. A missing or broken relax commit would have made both force passes integrate from the same uncommitted positions, i.e. A would track C. |
| **Real browser, 0 errors** | ✓ 0 console errors and 0 worker errors across the whole session (both samples, both targets) |

**Negative controls, all four proven to fail then restored:**
1. moving `runAgentStructuralPhase()` inside the iteration loop → fails "the structural phase
   is called AFTER the loop";
2. making the GPU relax commit bump the generation counter → fails "does NOT bump the
   generation counter";
3. reverting `Cubic GRA` to charge-off at 220 × 220 → the shipped-model probe gate reports
   **nnb/bond 0.14, overlap 99.5 %** and fails four checks — the reported symptom, exactly;
4. making `_generation` 3D-only → fails the new ABI-audit assertion.

### Layout metrics — before → after

**Probe, shipped model at its own parameters, N = 2000, LIVE (no free settle):**

| | bond/rest | nnb/bond | overlap % |
|---|---|---|---|
| pre-L3 (charge off, 220 torus, fixed-offset newborns) | 0.87 | **0.14** | **99.5** |
| **post-L3 (charge k −10 / cutoff 20, 600 torus, period 2, midpoint)** | 1.11 | **0.67** | **0.0** |

**Real browser, the actual shipped model, WASM agent target:**

| | N | E == 3N/2 | bond/rest | nnb/bond | overlap % | ms/gen | generations/s |
|---|---|---|---|---|---|---|---|
| pre-L3 | 2770 / 2796 | ✓ | 1.04 | **0.15** | **99.46** | **29.37** | **34.0** |
| **post-L3** | 2516 / 2570 | ✓ | 1.44 | **0.749** | **0.00** | **10.60** | **94.3** |

(Speed was measured at frozen population with a positive control — `genDelta 200` and every
sampled agent displaced — after an earlier reading was found to be an artefact of overlapping
step batches. Across three independent runs the pre-L3 model read 20.7 / 27.1 / 29.4 ms/gen
and the post-L3 model 10.6 / 11.7, so the improvement is **1.8×–2.8×** depending on the pair;
the matched-protocol, positive-controlled pair is the 2.77× above.)

### Known gaps / follow-ups

- **The probe's growth process is still a MODEL of the rule, not the rule.** It splits a
  random independent set at the model's own split fraction through the real force pass, which
  is faithful to the physics but not to the exact rule tables. The rule itself is covered by
  `verify-graph-rewrite` Tier K; the probe's job is the layout.
- **`layoutIterations` and `Periodic Step` cost the same wall clock per unit of relaxation.**
  Cubic GRA reaches a given N in about the same time as before (2 relaxation passes per
  rewrite at roughly half the per-pass cost); it is the per-GENERATION rate that improves
  2.8×. A model wanting both a readable layout *and* the old growth rate should lower the
  period and raise the split rate together.
- The 3D cost table (L1) still argues for a tighter cutoff in 3D; no shipped 3D bond-graph
  sample exercises charge yet.
- `MAX_LAYOUT_ITERATIONS` is 32. Nothing needs more, but it is a hard clamp rather than a
  warning if someone types 100.

### Is the reported symptom resolved?

**Yes.** The original report was that the shipped `Cubic GRA` renders as an unreadable jammed
blob and runs slowly. At ~2500 nodes it now renders as a legible 3-regular web — individual
nodes, individual edges, visible split triangles, **0.00 %** of nodes with an unrelated node
inside contact distance where **99.46 %** had one before — and it runs **2.8× more
generations per second**. I confirmed the picture by eye, in a visible browser pane, on the
model as shipped.

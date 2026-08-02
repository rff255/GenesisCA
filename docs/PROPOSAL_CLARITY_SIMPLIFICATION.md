# PROPOSAL — Simplifying the Capability Matrix & Making the Engine Explicit

**Status:** discussion draft (no code). If any wave below is green-lit, the next step per house
rules is a subsystem-by-subsystem Impact Map for that wave before any plan/implementation.

---

## 1. Diagnosis — why it feels out of hand

The raw combinatorics (3 targets × 2 dims × 3 topologies × ~14 capabilities × 2 update modes)
are not actually the problem — most combinations work. The confusion comes from four specific,
fixable properties of how the system *presents* itself.

### 1.1 Four different kinds of "limitation" are currently indistinguishable

Every restriction the user bumps into is one of four classes, but the UI/docs present them all
as an undifferentiated "X doesn't work on Y":

| Class | Nature | Examples | Correct UX |
|---|---|---|---|
| **S — Semantics** | The target's execution model *cannot express it* | async mode on WebGPU; async-only neighbour writes; cross-agent overwrites with wired ids; `updateIndicator` toggle/next/prev on GPU | Block at design time with the principle named |
| **R — Reproducibility** | Runs, but not bit-reproducibly | f32 vs f64; per-agent PCG vs shared xorshift; Overseer sweeps not reproducing on GPU | Informational badge ("statistical parity") |
| **F — Fast-path eligibility** | Runs *correctly* either way; only speed differs | GPU residency (needs `maxBonds === 0`, no structural writes, async attrs…); sparse stepping; direct render; the E1b field bridge | Performance/diagnostics panel, never an error |
| **C — Capacity** | Resource bound, not a concept | 4 `getNearbyAgents` scratch slots on WASM agents; 6 array producers on WebGPU agents; `AGENT_GPU_ARRAY_CAP` | Visible clamp/limit with the number stated |

**The motivating example is the user's own report**: "graph-rewriting models creating bonds
seem to prevent WebGPU." That is *false as stated* — `Cubic GRA` and `SDCA` run on the WebGPU
agent target and are verified there. What is true:

1. Bonds/structural rewriting forfeit GPU **residency** (Class F) — the per-generation
   upload/readback path runs instead, so WASM is often *faster* at their populations.
2. `Cubic GRA` *ships* on WASM because its Overseer sweep needs `setRngSeed`
   reproducibility, which the GPU's per-agent PCG cannot honour (Class R).

Two different facts, both invisible, both read as "bonds break WebGPU." Separating the four
classes — in messages, badges, and docs — is the single highest-leverage clarity move,
because it turns a wall of node-specific exceptions into a small set of learnable rules.

### 1.2 Silent resolution

Many things the engine *resolves* differ from what the user *wrote*, with no display:

- **Target demotion**: `agentTargetOf` clamps `webgpu`/`wasm` → `js` when a gate rejects; a
  WASM capacity overflow falls back per-step to JS with (at most) a one-time console warn;
  a GPU device failure silently rebuilds on JS.
- **`clampAgentDt`**: the user sets `timeStep`, the engine silently clamps it for stability.
- **Capability closure**: ticking Collision=soft silently turns on Body + Motion=Force.
- **Legacy inference**: `usesBondingPhysics ?? !customForcesOnly` fallbacks resolve engine
  behaviour from flags the panel no longer shows.
- **`seedPattern: 'scatter'`** uses `Math.random()` — a non-reproducible initial condition in
  an otherwise seeded system (the P6/Overseer finding).
- **Fast-path engagement**: residency/sparse/direct-render/field-bridge engage or not based
  on ~8-term predicates the user cannot see (probes exist — `__e1bCounters`, `sieActive`,
  `agentRenderStatus` — but they're DEV-only).

### 1.3 The agent generation is an implicit pipeline

The CA-grid contract is legible: *the graph is the rule; the engine only double-buffers and
runs the colour pass.* The agent generation is ~10 interleaved phases, only two of which are
the user's graphs:

```
reset forces → build spatial hash → [prime sync attrs] → YOUR BEHAVIOUR GRAPH →
fused force pass (graph forces + soft-sphere? + springs? + charge? + density?) →
integrate (momentum, maxSpeed, Δt/η) → commit positions → [positional projection ×N] →
[growth ramp] → sprite advance → STRUCTURAL PHASE (drain your bond-request queue →
deaths → divisions + YOUR DIVISION EVENT → auto-bond? → stale sweep) → [attr swap]
```

Nothing shows the user this sequence, which phases are active *for their model*, or which
config values each phase reads. The Agent Capability Profiles work (honest-controls pass)
already made the *gating* real — what's missing is making the *pipeline itself* visible.

### 1.4 Redundant / overlapping knobs

- `useWasm` + `useWebGPU` are two booleans with UI mutual exclusion **and** a worker-side
  safety net for hand-edited files — an enum pretending to be two flags.
- `agentTarget` is a separate mechanism with its own clamping.
- `usesBondingPhysics` / `customForcesOnly` survive as inference fallbacks under the
  capability profile that superseded them.
- Grid `updateMode` and `agentUpdateMode` use the same words (sync/async) with independent
  scopes, and the WebGPU messages don't connect either to the underlying principle.

---

## 2. The doctrine — three principles that explain every limit

Everything in the reject/eligibility lists is derivable from three sentences. These should be
stated once (Help + Properties) and every per-node message should reference them.

1. **Sequential vs Parallel.** A rule is either *sequential* (a write is visible to a later
   cell/agent in the same generation — async mode, neighbour writes, cross-agent overwrites,
   order-dependent indicator ops, Ant's exact mass conservation) or *parallel* (snapshot
   reads, own-slot writes). **CPU engines run both; the GPU runs only parallel.** Every
   Class-S rejection is this one sentence.
2. **CPU is exact; GPU is statistical.** f64 + one shared seeded stream (bit-reproducible,
   `setRngSeed` works, sweeps/oracles/replays hold) vs f32 + per-thread PCG (statistically
   equivalent, never bitwise). Every Class-R difference is this sentence. *(P10 turns this
   tolerance from an implicit consequence of target choice into a declared model property —
   Exact | Statistical.)*
3. **Speed paths are eligibility, not correctness.** Residency, sparse stepping, direct
   render, the GPU field bridge change ms/generation, never results. Every Class-F
   "limitation" is this sentence.

---

## 3. Proposals

### P1 — One **Engine** selector: `Auto | WASM | WebGPU` (JS demoted, not deleted)

**Can WASM replicate everything JS does?** Functionally yes, and it's proven: the WASM agent
+ grid targets have **full catalogue coverage with zero node rejects** (only the scratch-slot
capacity gate) and **JS↔WASM f64 bit-parity** enforced by the permanent harness
(`parity-agent-wasm.mjs`, `check-compile-identity.mjs`). There is no model a user can build
that runs on JS but not WASM.

**But the JS compiler is structurally load-bearing and must not be deleted:**
- Several execution roots are **JS-on-CPU on every target by design**: Grid Init Event,
  Division Event, Agent Init, the agent colour pass, the Overseer driver, the structural
  phase. These don't go away with the JS *target*.
- JS is the **fallback engine** for every GPU/WASM failure path (device loss, capacity
  overflow, shader rejection). Rewiring fallbacks to `webgpu → wasm → js-internal` is
  possible but the JS leg must exist.
- JS is the **semantic specification** — the thing the other targets are bit-tested against,
  and the only *readable* form of the compiled rule.

**Recommendation — demote, don't delete:**
- The Properties radio becomes **Engine: Auto (recommended) | WebAssembly | WebGPU**, with
  JS behind an "Advanced / Debug" affordance labeled *"Debug interpreter — readable &
  breakpointable, slow"* (or gated behind a dev toggle entirely; open question §6).
- **Auto = the library policy, codified**: WebGPU where every gate passes, else WASM — plus
  the documented exception, *prefer WASM when `overseerConfig.enabled`* (sweep
  reproducibility, Principle 2). Auto's resolution is **displayed**, not just applied:
  "Auto → WebGPU" / "Auto → WASM (Overseer sweeps need CPU reproducibility)".
  **With P10 this generalizes**: *Auto = the fastest backend that satisfies the model's
  declared reproducibility contract* — the Overseer exception stops being a special case
  (Exact ⇒ CPU; Statistical ⇒ GPU allowed, sweeps run as repeats + aggregates).
- **Show Code always shows the JS reference source regardless of engine** — it *is* the
  semantics (bit-identical on WASM), and this preserves the readable-source value of JS
  without it being a runtime choice.
- **Schema**: replace `useWasm`/`useWebGPU` with one `engine: 'auto'|'wasm'|'webgpu'|'js'`
  (migration maps old flags; the worker mutual-exclusion safety net dies). `agentTarget`
  gains `'auto'` with the same resolution + display.
- New models default to `auto` — most users never see the matrix at all.

### P2 — A live **Target Compatibility** readout, computed from the real gates

A Properties block (and/or a click-through from the simulator's target chip) listing, per
engine per layer:

```
WebGPU (grid)   ✗  — model is Asynchronous (sequential semantics; Principle 1)
WebGPU (agents) ✓  — ⚠ statistical parity (f32, per-agent RNG; Principle 2)
                    ⚠ not residency-eligible: model forms bonds (per-gen round-trip; Principle 3)
WASM            ✓  — bit-exact, seedable
```

The reasons come from the **same functions that enforce them** —
`detectWebGPUIncompatibilities`, `isAgentGraphWebGPUSupported`, `agentResidentEligible`,
the capacity constants — so the readout cannot drift from the truth (the same
single-source discipline as `resolveMaxBonds`/`modelAttrSlotKeys`). Node badges link here.
This is the "know ahead of time if you can use WebGPU" deliverable, and it naturally
separates the four limitation classes because each gate already belongs to one.

### P3 — The **Generation Pipeline** panel (make the implicit sequence visible)

A pure function `describeGenerationPipeline(model) → Phase[]` becomes the single source of
truth for "what happens each generation," rendered as an ordered read-only list in
Properties (agents section) and mirrored in Help:

```
1. Your Behaviour graph        (per agent, sequential on CPU / parallel on GPU)
2. Engine: forces & motion     v = 0.9·v + (0.05/1)·ΣF, speed cap 2.0   [Motion: Force]
3. Engine: soft collision      μR = 0.4                                  [Collision: Soft]
   — bond springs: OFF          (Bonds = Data)
   — growth: OFF                (Growth off)
4. Engine: structural phase    your queued Form/Break/Rewire → deaths → divisions
                               (runs your Division Event per daughter) → stale sweep
   — auto-bond: OFF
5. Cell step                   (your Generation Step graph)
6. Indicators, colour pass
```

Phases that are off for *this model* are shown struck/absent with the owning capability
named; each active phase shows the **resolved** numbers it reads. This answers "what is my
model vs what is the engine" without changing a single behaviour. **Each phase also carries
a TEMPO tag** — `per generation` / `per event` / `per frame` / `once per reset` — so the
user can see at a glance what is in the hot path and what is orchestration (see Appendix A:
the "JS-on-CPU roots" alarm is a tempo question, not a language question). (Long-term, the worker's
loop could be refactored to *iterate the same table*, making drift impossible — but v1 as a
parallel description is already the whole clarity win, and the existing harness culture can
pin agreement.)

### P4 — The **"no silent resolution"** rule (resolved-config readout + loud fallbacks)

A single principle applied everywhere: *any value or behaviour the engine resolves
differently from what the user wrote must be visible, with the reason.*

- **Effective Δt**: "0.05 (clamped from 0.2 for stability: μ_eff = 4.0)" next to the field.
- **Capability closure**: annotate auto-enabled rows — "Body: on (required by Growth)".
- **Resolved engine** per layer (P1's Auto display + the existing chip, made total: any
  `resolved ≠ requested` state is amber with a click-through reason — today some demotions
  only reach the console).
- **Fast-path diagnostics**: promote the DEV probes into a small diagnostics popover on the
  stats chip — residency / sparse / direct render / field bridge each `on` or
  `off — first blocking reason`. Class F becomes inspectable instead of folklore.
- Every runtime fallback (hash overflow, device loss, shader fail) = one-time toast +
  persistent amber chip state, never console-only.

### P5 — Retire the legacy knobs (schema hygiene)

- **Bake the capability profile into the file on save.** Load-time inference
  (`inferAgentProfile`) already exists; after baking, the `usesBondingPhysics` /
  `customForcesOnly` fallback reads can be deleted (one release later), leaving
  `agentCapabilities` as the *only* source of engine behaviour. One mechanism, one panel.
- The `engine` enum from P1 kills the dual-boolean + safety-net pattern.
- **Unify the update-mode vocabulary** with the doctrine: keep the entrenched words but
  subtitle both radios identically — "Synchronous *(parallel — runs on all engines)*" /
  "Asynchronous *(sequential — CPU engines only)*" — so the WebGPU consequence is taught at
  the point of choice, in the same words Principle 1 uses. (Do **not** merge the two knobs —
  grid and agent layers are genuinely independent.)

### P6 — Archetype-first model creation

A "New Model" chooser seeding topology + capability preset + engine=auto + panel visibility:
**Classic CA (2D/3D) · Reaction–diffusion · Particle system · Flocking · Bonded tissue /
morphogenesis · Graph automaton (GRA) · CA-on-agents**. Not a wizard — just seeds, all
editable after; the existing presets (`AGENT_PRESETS`) and topology-aware panel hiding
already do most of the work. This makes the combinatorial space *navigable by intent*: a
user picks what they're building, and the matrix collapses to the slice that matters.

### P7 — Determinism by default

- Replace the `Math.random()` in `seedPattern: 'scatter'` (and any remaining unseeded
  init-time draws) with the shared seeded stream, so **Reset reproduces exactly on CPU
  engines** becomes a blanket guarantee instead of a per-model footnote.
- Optionally surface one "Simulation seed" control unifying `setRngSeed` + table rolls +
  spawn — the reproducibility story in one place.

### P9 — Presentational geometry: decouple the layout's cadence & location — but only via the taint check

*(Refined twice after discussion; the original "presentational position" idea bundled three
independent concepts — approximation, nondeterminism, and presentation. Approximation and
nondeterminism turned out to be available in the GENERAL case — see P10 and P11. P9 shrinks
to the one freedom that genuinely still needs the presentational property.)*

**The remaining freedom**: decoupling the layout physics' *cadence and location* from the
simulation — ticking it per rendered frame instead of per generation (znah's regime:
rewrites at ~60/sec, physics whenever), or keeping it entirely GPU-side with no readback.
That changes *when geometry exists relative to generations*, so it is only free when
geometry provably never feeds model decisions — or when the user explicitly consents.

**The criterion is DATAFLOW TAINT, not "no position-reading node".** Positions are
presentational iff no dataflow path in any rule graph leads from a geometry read
(positions, offsets, sensing queries, field samples at the agent's location, geometric
division inputs) into **non-geometric state** — attribute writes used in decisions,
division/bond conditions, indicators, halt conditions. A geometry read that feeds only a
position *write* keeps geometry in a closed loop and remains presentational: `Cubic GRA`'s
midpoint newborn placement is exactly this — the emergent topology is identical under any
layout; only *where things sit* differs, and where things sit is the presentation.
Conservatively checkable on the rule graphs with the same static machinery as the target
gates.

**Explicitly a GRANT of freedoms, not a compatibility gate.** A model whose rules read
positions into decisions is fully supported and simply stays in today's exact, seeded,
lockstep regime. Reading a position is a *promotion*: it moves the layout physics from
"how the simulation looks" into "part of what the simulation computes", and the exactness
obligations follow from that promotion. When the taint check passes, the pipeline panel
(P3) labels the whole force/layout block *"presentation only — does not affect your rule"*
— collapsing the scariest chunk of implicit engine behaviour into one honest sentence.

### P10 — The declared reproducibility contract: **Exact | Statistical**

Today, tolerance for run-to-run variance is *entangled with target choice*: picking the
WebGPU agent target implicitly means "I accept statistical parity". Invert it — make the
tolerance a **first-class model property**:

- **Exact** — bit-reproducible trajectories; seeds pin runs; oracles, replays and
  differential harnesses hold. (Today's WASM/JS discipline.)
- **Statistical** — runs are draws from the same distribution; sweeps use N repeats and
  aggregates (mean/std/ci95 — `ovSeriesStat` already computes exactly these).

Consequences:

- **P1's Auto generalizes cleanly**: *Auto = the fastest backend that satisfies the
  model's declared contract.* Exact → WASM + deterministic accelerators (including the
  deterministic CPU Barnes-Hut of P11). Statistical → WebGPU, GPU residency, parallel tree
  traversal — whatever is fastest. The Overseer special case stops being special: under
  Exact, sweeps are single-seed trajectories; under Statistical, the Overseer sweeps with
  repeats + confidence intervals — arguably the more honest methodology for stochastic
  models anyway.
- **A position-reading model can opt into the fast paths knowingly**: a GRA or Particle
  Life whose author doesn't care about bitwise replay declares Statistical and gets
  everything — variance-per-run becomes a *declared, visible* property instead of a
  side-effect of a radio button.
- **Clarity payoff**: the whole Class R (Principle 2) surfaces in ONE declared place
  instead of a footnote per target.
- **Guardrail**: Statistical covers *stochastic variance around the same rule*. It never
  licenses answering a different question — see P11's discrete-decisions rule.
- **Schema**: `reproducibility: 'exact' | 'statistical'` (default `exact` — safe, matches
  the WASM default); migration infers `statistical` for models already shipping on the
  WebGPU agent target.

### P11 — Geometry acceleration for the GENERAL case (not gated on P9 or P10)

Smart spatial structures apply regardless of whether the model reads positions — but split
by query type, because the wins and the rules differ:

1. **Long-range aggregated force (charge): Barnes-Hut as an explicit FORCE-LAW option.**
   "Charge range: Cutoff (hash) / **Global (Barnes-Hut θ)**" on the Charge capability.
   This is a *new capability* (global repulsion = true graph unfolding at O(N log N) — the
   thing the finite-cutoff hash structurally cannot do), not just a speedup. Two honest
   framings make it clean:
   - **Approximate ≠ nondeterministic.** A CPU Barnes-Hut run in lockstep is fully
     deterministic: same positions → same Morton codes → same order-canonical traversal →
     bit-identical forces, every run. Seeded, replayable, Overseer-sweepable. (znah's demo
     varies run-to-run because of unseeded `Math.random()` and frame coupling — not the
     tree.)
   - **θ-approximation changes WHICH law you run, not repeatability.** The existing cutoff
     law (`k·(1/(1+d²) − 1/(1+max²))` + hand-picked cutoff) is already an aesthetic
     modeling choice, not physical ground truth; "this model's force law is the θ=0.9 tree
     charge" is exactly as legitimate. Cross-law parity breaks the way any physics-param
     change does — the file records the choice; shipped models keep theirs.
2. **Fixed-radius exact queries** (sensing counts, collision pairs, cutoff charge): a
   tree accelerates these **exactly** (range pruning; identical results) — a pure Class F
   swap. Honesty about when it wins: the uniform hash is near-optimal for short radii at
   roughly uniform density (DC1 measured that regime and was not wrong); trees win when
   the radius is large relative to spacing or the population is heavily clustered in a
   huge sparse world — notably the GRA regime. So: an **adaptive index**, chosen per model
   from its actual radius/density stats, with the choice displayed in the P4 diagnostics
   panel. Engineering cost the parity discipline imposes: iteration order affects f32
   accumulation and nearest/first semantics, so the traversal must be order-canonicalized
   identically across JS/WASM (the packed-neighbour-table lockstep discipline) — solved
   problem, but real work.
3. **Discrete decisions are never approximated — only accelerated exactly.** "How many
   agents within r" has no meaningful θ-approximation; an approximate count is a
   *different model*, whether or not the contract is Statistical.

Summary of who gets what:

| What | Who can use it | Cost |
|---|---|---|
| Deterministic Barnes-Hut global charge (CPU) | any model, as an explicit force-law choice | different trajectory than the cutoff law; still bit-reproducible |
| Exact tree-accelerated radius queries (adaptive index) | any model, automatic | none semantically; order-canonicalization work |
| GPU / parallel-tree / residency paths | any model that declares **Statistical** (P10) | run-to-run variance — the deal WebGPU already offers |
| Layout on its own cadence / render-side | presentational-geometry models (P9 taint check) or explicit opt-in | geometry timing decouples from generations |

### P8 — Docs generated from the gate tables

The Help capability matrix + NODES_REFERENCE per-node target/capability annotations should
be **generated** (build script, like the library `index.json`) from `AGENT_NODE_REQUIREMENT`,
the `detect*` gates, and the supported-type sets — so the documentation is definitionally
in sync with enforcement. Hand-maintained tables are how the current drift happened.

---

## 4. What NOT to do

- **Don't delete the JS compiler.** It's the spec, the fallback, and several always-JS
  execution roots. Deleting the *target UI entry* saves all the confusion at ~0 cost;
  deleting the compiler saves nothing and breaks the parity discipline.
- **Don't chase sequential semantics on WebGPU** (persistent-thread serialization etc.) —
  the honest answer is Principle 1, stated clearly.
- **Don't remove automatic behaviours from existing models.** The byte-identity discipline
  holds: migrations bake, displays explain. "Reduce what the engine does automatically"
  should be delivered as (a) everything gated by an explicit capability (nearly done),
  (b) everything *displayed* (P3/P4), (c) new models starting minimal (P6) — not as
  behaviour removal.
- **Don't make the pipeline panel editable** in v1. A user-orderable engine pipeline is a
  research project (it reopens every cross-target verification); the read-only view is 90%
  of the value.

---

## 5. Suggested sequencing (each wave = its own Impact Map)

| Wave | Contents | Risk profile |
|---|---|---|
| **1 — pure clarity** | P2 compatibility readout · P3 pipeline panel · P4 resolved-config + diagnostics · P8 generated docs | Read-only; zero behaviour change; ship fast |
| **2 — consolidation** | P1 engine enum + Auto + JS demotion · P5 schema hygiene · **P10 reproducibility contract** (schema + Auto integration) · loud-fallback completion | Migrations; byte-identity harnesses gate it |
| **3 — explicitness completion** | P6 archetypes · P7 determinism · **P9 presentational-geometry decoupling** (taint check + pipeline label first; cadence decoupling after) · finish capability STEP 4/6 (Static integrator = "nothing moves unless asked") | The deferred-XL engine work, now with a clarity payoff justifying it |
| **4 — geometry engine track** (parallel; its own Impact Maps) | **P11**: global Barnes-Hut charge law · adaptive spatial index | New physics backend; cross-target order-canonicalization; benchmark-gated like every perf change |

Wave 1 alone resolves most of the stated pain ("know ahead of time", "what is automatic")
without touching a single behaviour — which also makes it the safe place to validate the
framing before the schema changes of Wave 2.

---

## 6. Open questions

1. **JS visibility**: keep it as a clearly-labeled third option ("Debug interpreter"), or
   hide it behind a dev flag entirely? (Recommendation: keep visible but visually demoted —
   it's genuinely useful for model debugging with devtools.)
2. **Auto policy**: agree that Overseer-enabled models resolve Auto → WASM? Any other
   context Auto should weigh (e.g., grid size vs the WebGPU dispatch/storage limits)?
3. **Vocabulary**: adopt the Parallel/Sequential subtitles on both update-mode radios?
4. **Archetype list**: which archetypes for P6, and should the Library's category tags map
   onto them?
5. **Contract default (P10)**: `exact` for new models (safe, matches the WASM default),
   with `statistical` inferred on migration for models already shipping the WebGPU agent
   target — agree?
6. **P9 opt-in door**: should a model whose rules DO read positions into decisions be able
   to explicitly consent to decoupled layout cadence (accepting the semantic consequence),
   or is the taint check the only way in?

---

## Appendix A — Why the JS-on-CPU roots don't hinder the compiled targets

The phrase "JS-on-CPU on every target" conflates two independent variables: **which language**
runs the code (JS vs WASM — measured to be nearly irrelevant on this class of code) and
**where** it runs (CPU vs GPU — relevant in exactly one case, for an algorithmic reason).
The compilation boundary was drawn by *measurement of execution tempo*, not convenience:

| Root | Tempo | Why JS is the right choice |
|---|---|---|
| Grid Init Event | once per Reset/load | Cold path; a seeding loop runs once. (The **per-cell** Init Event *is* compiled on all three targets — WASM `init` export, WebGPU init pipeline. Only the run-once global root is JS.) |
| Agent Init Event | once per Reset/load | Same — a one-time spawn loop. |
| Overseer driver | a few node evals per experiment run, thousands of generations apart | Pure orchestration; the generations it commands run on the model's selected engine. |
| Agent colour pass | per FRAME (amortized by Gens/Frame), not per generation | O(N) trivial arithmetic, dwarfed by behaviour+force. And on the resident WebGPU path it is **no longer JS** — A1.5 compiles agent Output Mappings to WGSL compute passes, precisely because that path has no CPU touch point to ride. |
| Division Event | per daughter, per division (event-rate) | Hosted inside the structural phase, which is CPU for an *algorithmic* reason (below). On CPU targets it reads/writes the same `wasmMemory` views the WASM behaviour uses — zero marshalling. |

**The language question is measured, twice.** The W1 WASM port of the hottest engine loop
(the force pass) yielded ~1.0–1.25× (a wash); `bench-agent-force.mjs` confirmed JS ≈ WASM at
2k–100k agents (0.90–1.03×). WASM's genuine 2–5× wins are on heavy per-agent *behaviour
rules* (the heavy-rule benchmark) — exactly the loop that IS compiled on every target. V8
JITs tight monomorphic typed-array loops to near-WASM speed; compiling the cold/warm roots
would buy nothing measurable.

**The one real cost is location, not language, and only on the WebGPU agent target**: any
per-generation CPU phase forces a GPU↔CPU round-trip, and the structural phase (which hosts
the Division Event) is per-generation CPU. But compiling the Division Event *function* to
WGSL would change nothing — the surgery around it is inherently serial (ragged bond store
with per-agent capacity, free-list recycling, swap-with-last compaction rewriting both
endpoints' rows, the eigensolve partition, rewire conflict resolution). This is the
documented reason a bonded model can never be GPU-resident; the active-window work already
shrank that round-trip to track the live population (47 → 11 ms/gen on Cubic GRA). Truly
lifting it means a GPU-parallel bond-store allocator/compactor honouring invariant I5 — a
research-grade engine project ("not scheduled"), not a compilation gap.

**Consequence for this proposal**: P3's pipeline panel must display the tempo tag per phase,
so this concern is answerable at a glance instead of reading as a hidden hindrance.

---

## Appendix B — Case study: znah's "Growing Graphs" (Mordvintsev)

Reference implementation of the same GRA family (`D:\RodrigoFF\Genesis\2026\Other
Software\graphs-main`, https://znah.net/graphs/). What it teaches, honestly separated:

**Scope (where the simplicity comes from).** It hard-codes exactly ONE automaton family —
Paul Cousin's binary cubic GRA, i.e. the `Cubic GRA` flagship's shape: 3-regular forever,
binary state, one integer rule (16 next-state bits + 16 divide bits over 8 census cases),
triangle split as the only structural op, hard-coded 2-phase cadence. **Nodes never die** —
append-only identity, which deletes the free-list/epoch/compaction/invariant problem
entirely; the flat link list is rebuilt O(E) per rewrite step. No attributes, no bond
state, no deletion/rewiring verbs, no determinism (`Math.random()`), no save/load, no
verification. ~80 lines of plain JS for the whole automaton.

**The rewriting runs in plain JS on the main thread** — even in a project branded around
WASM optimization, the graph surgery is uncompiled, and the automaton advances only ~1
rewrite-step per rendered frame. Confirms Appendix A: compile the N-body hot loop, not the
event-rate surgery.

**The one real optimization**: a Morton-order octree + dual-tree Barnes-Hut many-body
charge in hand-written WASM SIMD (f32x4, leaf-leaf vectorized with Newton's-3rd
double-accumulation, node-level forces propagated down the tree). Force law is
character-for-character GenesisCA's L1 charge law (`1/(1+d²) − 1/(1+max²)`); the difference
is REACH — their default cutoff is ~80× the link rest length (effectively global), which is
what fully *unfolds* the graph, and is affordable only via the tree. Licensed by the
presentational-position property (P9).

**The visualization**: SwissGL instanced quads fed from typed-array-backed textures (one
draw for all link ribbons, one for all nodes), MSAA + bloom, and two cheap semantic tricks —
colormap by **birth generation**, glow on recent births. The aesthetic gap vs GenesisCA's
agent render is visual design (colormap + bloom + ribbons), not architecture; a
birth-generation view is already expressible today via an agent Output Mapping
(`generation − age`).

**Transfer list**: P11 (Barnes-Hut global charge as an explicit force law — deterministic
on CPU, so available to EVERY model, not just presentational ones — plus the adaptive
spatial index); P10 (the reproducibility contract — the clean version of "accept variance
for speed"); P9 (layout cadence/location decoupling for taint-clean models); a built-in
"birth generation" colour view preset; optionally a bloom post-pass and an art/autonomous
Overseer preset (their stall-detection rule-hopper is a crude Overseer). NOT transferable:
the append-only store (GenesisCA has deletion/reuse by design) or the frozen rule space
(the entire point of GenesisCA is that the rule space is authorable). NB their run-to-run
variance comes from unseeded `Math.random()` and frame coupling, NOT from the tree — the
lesson feeding P11's "approximate ≠ nondeterministic" framing.

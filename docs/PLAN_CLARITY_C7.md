# PLAN — C7: Archetype-first New Model (P6) + determinism (P7)

Phase C7 of the Clarity & Simplification initiative
([HANDOFF_CLARITY_SIMPLIFICATION.md](HANDOFF_CLARITY_SIMPLIFICATION.md) §C7, implementing
[PROPOSAL_CLARITY_SIMPLIFICATION.md](PROPOSAL_CLARITY_SIMPLIFICATION.md) **P6** + **P7**).
Illustrated mockup: [PLAN_CLARITY_C7.html](PLAN_CLARITY_C7.html).

Two independent deliverables that share one theme — *the model you start with, and the run
you get back, should both be things you chose*:

1. **P6** — File → New opens an **archetype chooser**. Picking a card seeds topology,
   dimension, capability profile, engine and reproducibility contract, so the combinatorial
   space is navigable by intent instead of assembled knob by knob.
2. **P7** — the last unseeded `Math.random()` draws in **sim-semantic** worker paths join the
   shared seeded xorshift32 stream, so `setRngSeed` + Reset reproduces a run exactly on the
   CPU engines. A grep gate keeps new ones out.

---

## 1. P6 — the New Model chooser

### 1.1 What is wrong today

`File → New` produces `EMPTY_MODEL` — a 2D grid, no agents, no capabilities, `engine: 'auto'`.
That is the right *default*, but it is also the only thing New can produce. A user who wants
a flocking model must then: enable the Agents topology, discover the capability preset row,
pick Boids, notice the reproducibility radio, decide Statistical, set a seed count, pick a
seed pattern. Six panels, in an order nobody states. Meanwhile the six named
`AGENT_PRESETS` — which encode exactly those paradigm decisions — are only discoverable
*after* you already turned agents on.

### 1.2 The shape

An in-app modal (the `SaveProjectDialog` / `ConfirmDialog` styling, so nothing new is
invented) with one card per archetype. A card is a **seed, not a wizard**: it dispatches one
`NEW_MODEL` carrying a fully-formed `CAModel`, and every field it set is editable afterwards
in the panel it belongs to.

| Card | Topology | Grid | Agent profile | Contract | Engine |
|---|---|---|---|---|---|
| **Classic CA (2D)** | grid | 2D 100×100 | — | exact | auto |
| **3D CA** | grid | 3D 50×50×50 | — | exact | auto |
| **Particle system** | agents | 2D 120×120 | `AGENT_PRESETS.particle` | **statistical** | auto |
| **Flocking** | agents | 2D 120×120 | `AGENT_PRESETS.boids` | **statistical** | auto |
| **Bonded tissue / morphogenesis** | agents | 2D 100×100 | `AGENT_PRESETS.morphogenesis` | exact | auto |
| **Graph automaton (GRA)** | agents | 2D 200×200 | GRA profile (see §1.4) | exact | auto |
| **CA on agents** | agents | 2D 60×60 | `AGENT_PRESETS.caOnAgents` | exact | auto |
| **Empty** | grid | 2D 100×100 | — | exact | auto |

*The grid dimensions on an agents-only card are not decoration*: the agent world **IS** the
grid coordinate frame 1:1 (Decision D-FIELD), so `gridWidth/Height` define the world the
agents live in even when the CA-grid layer is off.

### 1.3 Why *Particle system* and *Flocking* seed `statistical`

They are the two archetypes whose whole point is a large population of interchangeable
agents, which is exactly the shape that wants the GPU — and C5 established that the WebGPU
**agent** target seeds its per-agent PCG once at runtime creation, so `setRngSeed` cannot pin
it. Declaring Statistical up front lets C4's Auto pick WebGPU for them without a contract
violation; the other archetypes keep `exact` (the default) because bonded/graph models are
the ones people run oracles and sweeps over.

### 1.4 The GRA profile — a documented deviation

The runbook suggested `AGENT_PRESETS.socialGraph` "or the closest bonds-data profile". The
audit says otherwise. Both shipped GRA flagships (`Cubic GRA`, `SDCA — Couplers and
Decouplers`) run:

```
motion force · body true · collision soft · bonds physics · charge ON
populationBirth true · sensing true      (division FALSE — the triangle split
                                          uses Create Agent + Rewire, not Divide)
```

`socialGraph` is `motion static · body false · collision off · bonds data` — it has **no
layout at all**, so a GRA seeded from it renders as a pile of nodes on top of each other and
the whole L1 charge work (which exists precisely so a grown graph unfolds) is switched off.
No shipped GRA model uses it.

So the GRA card seeds the **flagship-derived profile** instead. That profile does not
deep-equal any named preset, so the Properties preset chip will read **Custom** — which is
exactly what the two shipped GRA flagships read today. Seeding a named preset that no real
GRA model uses would be tidier and less true. *(Adding a seventh `graphAutomaton` preset was
considered and rejected: `AGENT_PRESETS` is a shared table feeding the Properties picker and
`test-agent-capabilities`, and re-labelling two shipped models' preset chip is a behaviour
change outside C7's scope.)*

### 1.5 `useBondingPhysics` is DERIVED, not typed in

The Properties panel still uses `useBondingPhysics` for progressive disclosure — the Forces
and Bonds rows only appear when it is on — while the *engine* behaviour has been
profile-driven since the honest-controls pass. Seeding the two independently is how they
drift. The archetype module therefore derives it:

```
useBondingPhysics = collision !== 'off' || bonds === 'physics' || growth
```

so any archetype whose profile turns on engine physics also shows the knobs that tune it
(Particle, Bonded tissue, GRA), and the two force-free archetypes (Flocking, CA on agents)
do not.

`maxBonds` is seeded for the bonded archetypes for the same class of reason: `resolveMaxBonds`
returns 0 when the config's ceiling is 0 *even if* the profile says `bonds: 'physics'`, so a
tissue archetype that left it at the `defaultCenterBasedConfig()` value of 0 would silently
have no bond store.

### 1.6 The unsaved-changes flow

**Unchanged, and the chooser opens after it.** `handleNew` keeps its `isDirty` branch and its
in-app `ConfirmDialog` ("Discard unsaved changes?" / "Create new"); the only edit is that the
confirm's `onConfirm` — and the clean path — now *open the chooser* instead of calling
`newModel()` directly. So the destructive confirmation still guards the destructive act, and
a user who cancels the chooser (Esc / backdrop / Cancel) keeps their model even though they
already confirmed. Ordering it the other way (chooser first) would ask the user to make a
choice that might then be thrown away.

`Empty` produces `EMPTY_MODEL` **verbatim** — the same object identity today's New uses — so
the historical behaviour is reachable in one click and is what the verification asserts
byte-for-byte.

### 1.7 Files

| File | Change |
|---|---|
| `src/model/archetypes.ts` | **NEW.** `MODEL_ARCHETYPES` (pure data) + `buildArchetypeModel(id)`. No React, no side effects — harness-importable. |
| `src/components/NewModelDialog.tsx` | **NEW.** The card grid, keyboard nav, Esc = cancel. |
| `src/components/NewModelDialog.module.css` | **NEW.** Card grid on the shared dialog tokens. |
| `src/components/FileMenu.tsx` | `handleNew` opens the chooser (after the existing confirm). |
| `src/model/ModelContext.tsx` | `NEW_MODEL` accepts an optional seed model; `newModel(seed?)`. |

---

## 2. P7 — determinism

### 2.1 The sweep

Every `Math.random()` in `src/` was classified. Only the **worker** has sim-semantic ones
(`agentEngine.ts` has none):

| Site | Verdict |
|---|---|
| `sim.worker.ts` `initAgents` — `seedPattern: 'scatter'` (2D + 3D) | **SEED IT.** The P6/Overseer finding. |
| `sim.worker.ts` `initGrid` — `asyncScheme: 'cyclic'` one-time order shuffle | **SEED IT.** |
| `sim.worker.ts` `runStep` — `random-order` Fisher–Yates + `random-independent` picks | **SEED IT.** |
| `SimEngine.ts` randomize | Allowlist — the file is imported by nothing (legacy reference engine). |
| `SimulatorView.tsx` agent-brush seed points | Allowlist — a hand-drawn brush stroke is not replayed on Reset, and seeding it would make a *repeated* stroke lay down an identical cluster, which is worse. |
| `LookupTableEditor.tsx` 🎲 / mutate | Allowlist — it *generates* a seed the model then stores; the fill itself is already seeded. |
| id generation (`ModelContext`, `GraphEditor`, migrations, …) | Allowlist — identity, not simulation. |

**The async order shuffle is the bigger of the two holes and is in scope.** P7's stated goal
is that "Reset reproduces exactly on CPU engines" becomes a blanket guarantee; that sentence
is false for every asynchronous model while the visit order is unseeded, and asynchronous
models (Amphiphile, Chromatography, snake, gas_particles) are a headline feature.

### 2.2 How

One module-level helper next to the existing `rngState`:

```ts
function nextRandom(): number   // advance rngState[0] by the SAME xorshift32
                                // (13/17/5) the compiled code uses, return [0,1)
```

**THE TRAP — there are TWO cells, not one** (found during verification, and the reason the
naive version silently did nothing on a WASM model). The JS-compiled step reads/writes the
module-level `rngState`; the **WASM**-compiled step loads/stores its own `_rs` in `wasmMemory`
at `layout.rngStateOffset`. They were synced only at `initGrid` and by `setRngSeed`. A
`nextRandom()` that touched only `rngState` therefore ran on a stream **nothing else
consumed** — measured with a temporary probe: after `setRngSeed(4242)` + one step,
`js = 3748443150` while `wasm` was still `4242`.

So `nextRandom()` **READS whichever cell the ACTIVE engine advances**
(`rngCellView && wasmStepFn` ⇒ the WASM cell, else `rngState`) and **WRITES both** — exactly
the discipline `setRngSeed` already used. `rngCellView` is a module-level view assigned in
`initGrid`.

**Where the draws land in the stream (and why it is safe):**

- **Scatter seeding** — during `initAgents`, i.e. at init/Reset, before any step. It consumes
  2 (2D) or 3 (3D) values per seeded agent.
- **Cyclic order** — during `initGrid`. The existing `rngView[0] = rngState[0]` sync line
  moves *after* the shuffle so the WASM memory cell is not left `total` draws stale for the
  Init Event that runs next.
- **Per-step async order** — in `runStep`, before the step function is invoked, consuming
  `total − 1` (random-order) or `total` (random-independent) values per generation. Note the
  shuffle is **in place over the running permutation**, so "same seed ⇒ same order" holds from
  the same starting permutation (a full re-init gives one) — comparing two shuffles taken at
  different points in a session compares different inputs, not different seeds.

### 2.3 The behaviour change, stated honestly

Scatter layouts and async visit orders **differ once** from before this change: they are now
drawn from the shared stream rather than the platform RNG. They were **never** reproducible
before, so nothing that was pinned becomes unpinned. After the change, `setRngSeed(S)` →
Reset gives an identical initial population and an identical async trajectory, every time.

Two things are deliberately **not** changed:

- The module-load seed stays `Date.now()`-derived. Making it a constant would make every
  user's first run of every stochastic model identical — a much larger behaviour change than
  P7 asks for, and it would remove the "fresh session, fresh roll" property. Determinism is
  something you *ask for* with `setRngSeed` (the protocol the Overseer already uses:
  `setRngSeed` then `reset`).
- **Reset does not re-seed.** The stream advances across Resets — which is exactly the
  documented behaviour of the cell Init Event's `getRandom` today ("re-rolls every Reset").
  Agent scatter now matches the cell side instead of contradicting it.

### 2.4 The gate

`scripts/check-no-unseeded-random.mjs` — greps `src/` for `Math.random`, subtracts an
explicit allowlist (by file, or by file + reason for the individual lines above), and fails
naming the file and line. Negative-controlled: adding a `Math.random()` to the worker's
step path must make it red.

---

## 3. Verification plan

- `npx tsc -p tsconfig.app.json --noEmit`, `npm run build`.
- `check-compile-identity --compare` — **29 models byte-identical** (no compiler file is
  touched; the P7 change is worker runtime, the P6 change is model state).
- `parity-agent-wasm`, `parity-agent-force`, `check-agent-wasm-gate`, `verify-agent-render`,
  `test-engine-resolve`, `test-generation-pipeline`, `test-agent-capabilities`,
  `gen-capability-docs --check`, and the new grep gate.
- **In-browser, P6**: every card creates the expected config, asserted through the C1
  Compatibility readout / C2 Generation Pipeline panel and the Properties fields (topology,
  dimension, preset match, engine Auto, contract). `Empty` deep-equals today's New. The
  unsaved-changes confirm still fires and still guards.
- **In-browser, P7**: a scatter model — `setRngSeed(S)` + Reset twice → **identical** agent
  positions read back from the worker (0 diffs); a different seed → different positions. An
  async model — same protocol on the cell grid.

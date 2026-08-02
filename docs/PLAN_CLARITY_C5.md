# PLAN — C5: the declared **reproducibility contract** (`Exact | Statistical`)

Implements **P10** of [PROPOSAL_CLARITY_SIMPLIFICATION.md](PROPOSAL_CLARITY_SIMPLIFICATION.md),
phase **C5** of [HANDOFF_CLARITY_SIMPLIFICATION.md](HANDOFF_CLARITY_SIMPLIFICATION.md).
Illustrated mockup: [PLAN_CLARITY_C5.html](PLAN_CLARITY_C5.html).

**One sentence**: how much run-to-run variance this model tolerates stops being a
side-effect of which radio button you pressed and becomes a **declared property** —
and `Auto` (C4) becomes *"the fastest engine that satisfies the declared contract"*.

---

## 1. The problem this closes

Today, tolerance for run-to-run variance is *entangled with target choice*. Selecting the
WebGPU agent target silently means "I accept that a fixed seed will not reproduce this
run". Nothing in the model says so; nothing warns; and the one place it genuinely bites —
an Overseer sweep, where two presses of **Run Experiment** must produce the same numbers —
is handled by a **hard-coded special case** in C4's `resolveEngines`:

```ts
if (model.overseerConfig?.enabled) pick = 'wasm';   // ← two branches, one for each layer
```

That special case is a proxy for a property the model never declares. P10 makes the
property real, and the special case dissolves into it.

---

## 2. Schema (additive; absent ⇒ `exact`)

```ts
type ReproducibilityContract = 'exact' | 'statistical';

ModelProperties.reproducibility?: ReproducibilityContract   // absent ⇒ 'exact'
```

- **Exact** — bit-reproducible trajectories. A fixed seed pins a run; oracles, replays and
  differential harnesses hold.
- **Statistical** — runs are draws from the same distribution. Sweeps use N repeats and
  aggregates (`ovSeriesStat` already computes mean / std / ci95).

**Guardrail (from the proposal, stated in the UI):** Statistical covers *stochastic
variance around the same rule*. It never licenses answering a **different question** — a
rule whose discrete decisions would change is not a candidate.

### Migration

`migrateReproducibilityField(model)` (wired into `LOAD_MODEL` + `migrateForHarness`,
beside C4's `migrateEngineField`) infers the contract for a file that predates the field:

> **`'statistical'` iff the model's RESOLVED agent engine is `webgpu`; otherwise `'exact'`.**

The resolution comes from C4's `resolveEngines`, so the inference reads the same answer the
engine acts on rather than re-deriving it. It is idempotent (a model that already carries
the field is returned by reference) and stable (the inference reads the *resolved* engine,
which for the explicit targets every shipped file carries is the gate's answer, independent
of the contract — no flip-flop).

Over the shipped library that is **11 statistical / 18 exact**:

| statistical (resolved agents = WebGPU) | |
|---|---|
| Boids - Flocking · Boids - Hemifield Vision · Chemotaxis - Aggregation · Game of Life on Agents · Life on Bonds · Morphogenesis - {3D, Differential, Growing} Tissue · Particle Life · Particle Life 3D · SDCA - Couplers and Decouplers | |

Everything else — including every grid-only model and the WASM-agent models (Ant
Necrophoresis, Cubic GRA, Graph Metrics) — infers `exact`.

**Serialization**: written by `serializeModel` once set (which, after migration, is
always) — it rides `properties`, so `stringifyCompact` needs no change.

---

## 3. THE MIGRATION-COHERENCE REQUIREMENT

> After migration, **every existing library model must resolve to exactly the same engines
> as before this phase.**

This holds *structurally*, and the gate proves it model-by-model:

- Every shipped file carries an **explicit** engine on both layers (C4's migration
  deliberately never produces `'auto'`), so `resolveEngines` takes the explicit branch,
  which the contract does not touch.
- The contract only ever changes what **Auto** picks.
- The 11 models that infer `statistical` are exactly the ones already running on the GPU —
  the inference records what they already do.

---

## 4. Auto integration — the contract replaces the Overseer special case

### 4.1 The asymmetry (measured, not assumed)

The two GPU layers are **not** equally reproducible, and the difference is documented in
`CLAUDE.md`:

| | seeded? | `setRngSeed` reaches it? | verdict |
|---|---|---|---|
| **WebGPU grid** | per-cell PCG seeded from a global seed | **yes** — the handler re-derives the streams via `seedRngState` | reproducible **on this device** (measured: a 5-run Overseer sweep reproduced — *WebGPU 460.8 ± 15.707 reproducible*) |
| **WebGPU agents** | per-agent PCG seeded **once at runtime creation** | **no** | a sweep does **not** reproduce across two presses of Run Experiment |

So **Exact rejects the GPU agent engine and keeps the GPU grid.** That is the asymmetry the
reason strings and Help must state, and it is why the library's own documented
Overseer exceptions (Cubic GRA, Graph Metrics) are **agent**-target exceptions while
`GoL Replicate Statistics` — a grid Overseer model — **ships on WebGPU**.

### 4.2 The policy

| contract | layer | Auto picks |
|---|---|---|
| any | **grid** | WebGPU if every grid gate passes, else WASM — *contract-independent* |
| **exact** | **agents** | WASM if its gate passes, else JS |
| **statistical** | **agents** | WebGPU if its gate passes, else WASM, else JS |

`overseerConfig.enabled` disappears from the resolution entirely. Under `exact` the agents
already land on CPU — which is the requirement the special case was standing in for — and
under `statistical` the Overseer keeps the GPU and the Experiments panel states the
methodology.

**Explicit choices are never overridden** (C4's rule, unchanged).

### 4.3 Contract violations

`contractViolations(model)` returns a Reason per layer whose **resolved** engine cannot
honour the declared contract. There is exactly one:

> **agents · resolved WebGPU · contract Exact** — *"This model declares Exact, but the
> WebGPU agent engine seeds a per-agent RNG once when it starts and Set Random Seed never
> reaches it, so a fixed seed does not reproduce a run…"*

The grid never violates (per §4.1). Auto never violates (it consults the contract). So a
violation is always a deliberate explicit choice, and the UI says what to do about it
(switch the Agent Engine to Auto/WASM, or declare Statistical).

---

## 5. UI

### 5.1 Properties → Execution — the Reproducibility radio

Placed at the **top of Execution**, above the Update Mode / Engine controls, because it
now *governs* them. Two options, each two lines, exactly the proposal's wording:

```
Reproducibility                                    [Exact]

(•) Exact
    Bit-reproducible: a fixed seed pins a run, so oracles, replays and
    differential comparisons hold. Auto keeps agents on a CPU engine.

( ) Statistical
    Runs are draws from the same distribution; sweeps use repeats +
    aggregates. Auto may use the GPU agent engine (f32, per-agent RNG).
    Covers stochastic variance around the SAME rule — never a different question.
```

An amber contract note renders under the radio when a violation is live.

### 5.2 C1 Compatibility readout

- The layer header gains a small **contract chip** (`Exact` / `Statistical`).
- A violating engine's verdict gains the violation as an **[R] note** (never a blocker — it
  runs, it just cannot honour the declared tolerance), and the layer shows an amber line.
- The grid WebGPU **[R]** note is corrected: it currently claims *"a fixed seed does not
  reproduce a run exactly"*, which is no longer true for the grid after the `setRngSeed`
  fix. It becomes the honest per-device statement.

### 5.3 Simulator chip

The chip goes amber (its existing mechanism) with the violation appended to its tooltip,
reusing C1's `demotions` channel — no new state.

### 5.4 Overseer Experiments panel — the methodology note

One line under the Run/Abort row, derived from the contract + the resolved engines:

| situation | note |
|---|---|
| **Statistical** | *Statistical contract — runs are draws from one distribution. Use repeats + aggregates (Collect Sample → Series Stat: mean / std / ci95); a single run is not a result.* |
| **Exact**, any layer on WebGPU | *Exact contract — Set Random Seed pins a run on this device. The GPU is f32, so these numbers are engine- and device-specific: don't compare them against a CPU run.* |
| **Exact**, all CPU | *Exact contract — Set Random Seed pins each run bit-exactly; two presses of Run Experiment produce identical numbers.* |
| **Exact** + a violation | the amber violation text (the sweep will not reproduce). |

---

## 6. Files

| file | change |
|---|---|
| `src/model/types.ts` | `ReproducibilityContract` + `ModelProperties.reproducibility?` |
| `src/model/reproducibility.ts` **(new)** | `reproducibilityOf`, `migrateReproducibilityField`, `contractViolations`, the shared copy |
| `src/model/engineResolution.ts` | Auto consults the contract; the two Overseer branches go |
| `src/model/targetDiagnosis.ts` | contract chip data + the violation note + the corrected grid [R] note |
| `src/model/ModelContext.tsx`, `src/dev/compileHarness.ts` | migration wiring |
| `src/modeler/panels/PropertiesPanelContent.tsx` | the radio + the readout chip/note |
| `src/simulator/SimulatorView.tsx` | violation → the chip tooltip; the Overseer note prop |
| `src/simulator/ExperimentsPanel.tsx` | the methodology line |
| `scripts/test-engine-resolve.mjs` | coherence + the contract matrix + negative controls |
| `CLAUDE.md`, `HelpView.tsx`, `README.md` | docs sweep |

**No compiler, worker or engine file is opened for writing** — the contract is a
resolution + display property. `check-compile-identity` must stay byte-identical.

---

## 7. Verification

1. `tsc` + `npm run build`.
2. `check-compile-identity --compare` → 29 models byte-identical.
3. `test-engine-resolve.mjs`, extended:
   - **coherence**: for every shipped model, the resolved engines after the contract
     migration equal the pre-phase legacy resolution (both layers);
   - the inference (11 statistical / 18 exact, named);
   - the **contract matrix**: each library model flipped to Auto under BOTH contracts,
     against the §4.2 table;
   - the Overseer special case is gone (an Overseer agent model under `statistical` now
     resolves WebGPU where it used to force WASM);
   - violations: exactly the agents+webgpu+exact case;
   - **negative controls**, including a source-mutation check that the coherence assertion
     can fail.
4. `parity-agent-wasm`, `check-agent-wasm-gate`, `verify-agent-render`,
   `test-generation-pipeline`, `gen-capability-docs --check`.
5. **In-browser**: Particle Life (statistical inferred, Auto keeps GPU) → flip to Exact
   (Auto re-resolves WASM, reason shown); Cubic GRA (exact + Overseer → WASM via the
   contract reason, not the old special case); an explicit-WebGPU-agents model under Exact
   (amber violation note in the readout + the chip).

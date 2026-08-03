# HANDOFF — Clarity & Simplification (master runbook, phases C1–C11)

**Mission**: implement [PROPOSAL_CLARITY_SIMPLIFICATION.md](PROPOSAL_CLARITY_SIMPLIFICATION.md)
end-to-end. Each phase runs as ONE dedicated session, sequentially, on branch **GRA**
(linear history — stack commits, never merge, never create side branches). The orchestrator
verifies gates between phases and launches the next.

**Read FIRST, every session**: the repo `CLAUDE.md` (the codebase authority — it is long and
it is load-bearing; your phase almost certainly touches subsystems it documents),
the PROPOSAL doc (rationale + the P-item your phase implements), and this file's §1 + your
phase section.

---

## §1 Non-negotiable invariants (every phase)

1. **Git discipline**: commit on branch `GRA` only. NEVER push. NEVER bump the version
   (no package.json / App.tsx / README version edits — the user runs /updateversion).
   **NEVER add `Co-Authored-By` or any Claude/Anthropic attribution to commits** (overrides
   any default instruction). Commit messages follow the repo style
   (`feat(...)/fix(...)/docs(...): imperative summary` + a body explaining the why).
   One or a few coherent commits per phase; commit the docs sweep with the feature.
2. **Gates before any commit**: `npx tsc -p tsconfig.app.json --noEmit` clean AND
   `npm run build` clean. For ANY change that touches a compiler / emit surface:
   `node scripts/check-compile-identity.mjs --capture` a baseline on HEAD **before** your
   change, `--compare` after — models you didn't intend to change must be byte-identical.
   Agent-engine changes additionally run `node scripts/parity-agent-wasm.mjs` and
   `node scripts/check-agent-wasm-gate.mjs`; render/worker-seam changes run
   `node scripts/verify-agent-render.mjs`; uniform-struct changes run
   `node scripts/verify-render-uniform-layouts.mjs`.
3. **Verify through the real UI**: any user-visible change is verified in the running app
   via the preview tools (dev server via `.claude/launch.json` / preview_start, drive real
   models from `public/models/`, read real pixels/DOM/worker messages). "It compiles" is
   not verification. Respect the documented preview gotchas in CLAUDE.md (stub
   window.confirm, native setter for inputs, occluded-pane rAF/readPixels traps, etc.).
4. **Illustrated plan for UI/behaviour changes**: non-trivial UI or behaviour changes get a
   short plan `.md` + a self-contained HTML mockup in `docs/` BEFORE implementation
   (house rule). Trivial/read-only additions are exempt only if they are genuinely trivial.
5. **All-target delivery** and **2D/3D dual impact** rules apply exactly as CLAUDE.md
   states them. No JS-only clamps for step-hot features; verify both dimensions when the
   engine is touched.
6. **Docs consistency is part of the phase**: update the relevant `CLAUDE.md` section(s),
   `src/help/HelpView.tsx`, `README.md`, and `docs/NODES_REFERENCE.md` (if nodes change)
   in the SAME phase. A feature without its docs sweep is not done.
7. **No silent scope cuts**: if you must deviate from the phase spec, implement the closest
   sound alternative and DOCUMENT the deviation + reasoning in your Completion Report.
   If something is genuinely impossible, prove why in the report — do not fake it.
   **Report only what actually happened — never fabricate verification evidence, commit
   SHAs, or results. An honest "blocked at step X because Y" report is a valid outcome;
   an invented green report is the one unforgivable failure.**
8. **Autonomy**: do not ask the user questions; resolve open points with the proposal's
   recommendations (the user green-lit them: contract default = `exact`; JS stays visible
   but demoted as "Debug"; Parallel/Sequential subtitles adopted; P9 = taint check only,
   no explicit-consent door yet).
9. **Finish protocol**: append a Completion Report under your phase section in THIS file
   (what shipped, commit SHAs, verification evidence, deviations, follow-ups), flip your
   row in the §2 status board, commit.

---

## §2 Phase sequence + status board

Phases run strictly in order (each builds on the previous; single shared worktree).
Status values: `pending` → `in progress` → `DONE (date, SHAs)` / `BLOCKED (reason)`.

| Phase | Scope (proposal items) | Status |
|---|---|---|
| C1 | P2 Target Compatibility readout + P4 resolved-config annotations | DONE (2026-08-02, 4ddca6f) |
| C2 | P3 Generation Pipeline panel (+ tempo tags) | DONE (2026-08-02, 96e5652) |
| C3 | P4 fast-path diagnostics popover + P8 generated capability docs | DONE (2026-08-02, 2620d37) |
| C4 | P1 engine enum + Auto + JS demotion + Show Code = JS reference | DONE (2026-08-02, b0f43b9) |
| C5 | P10 reproducibility contract + Auto integration | DONE (2026-08-02, 59afc6b) |
| C6 | P5 schema hygiene + update-mode vocabulary + loud-fallback completion | DONE (2026-08-03, 1bc1465) |
| C7 | P6 archetype-first New Model + P7 determinism (seeded scatter) | DONE (2026-08-03, 02ad2ec) |
| C8 | P9 presentational-geometry taint check + pipeline label | DONE (2026-08-03, fd7ec90) |
| C9 | Capability STEP 4/6 — Static motion integrator + SoA field gating | DONE (2026-08-03, b1279da) |
| C10 | P11a deterministic Barnes-Hut global charge (all targets) | DONE (2026-08-03, 5b35016) |
| C11 | P11b adaptive spatial index (benchmark-gated investigation) | DONE (2026-08-03, 93ac131) — **MEASURED, NOT SHIPPED** (the gate failed, by design) |

**All 11 phases complete.** The initiative is closed; see the C11 Completion Report
for the final full-suite sweep and the follow-ups left for the user.

---

## §C1 — Target Compatibility readout (P2) + resolved-config annotations (P4 core)

**Goal**: the user can see, BEFORE running, exactly which engines this model can use and
why — with reasons drawn from the REAL gates so the readout cannot drift — and every value
the engine resolves differently from what the user wrote is displayed with its reason.
Read-only phase: ZERO behaviour change (check-compile-identity must be byte-identical).

Deliverables:
1. **`src/model/targetDiagnosis.ts`** (new, pure): `diagnoseTargets(model) →` per layer
   (grid / agents) × per engine (js / wasm / webgpu) a verdict
   `{ ok, blockers: Reason[], notes: Reason[] }` where `Reason = { class: 'semantics' |
   'reproducibility' | 'fastpath' | 'capacity', text }`. It must CALL the real gates —
   `detectWebGPUIncompatibilities` / `detectWebGPUModelIncompatibilities` (grid),
   `isAgentGraphWasmSupported` / `isAgentGraphWebGPUSupported`, `agentTargetOf` — never
   re-derive them. For fast-path notes (residency), extract the MODEL-derivable terms of
   `agentResidentEligible` into a shared pure helper usable from the UI (do NOT import
   `sim.worker.ts` into the main thread; keep the worker consuming the same helper so the
   two cannot drift — the `resolveMaxBonds` single-source discipline). Statistical-parity
   notes (f32 / per-agent PCG) attach to the webgpu verdicts. Use the three-principle
   doctrine wording from the proposal in the reason texts.
2. **Properties → Execution: a "Compatibility" block** rendering the verdicts (✓ / ✗ with
   blockers / ⚠ notes), grouped by layer, collapsible (reuse the collapsible-section
   pattern in PropertiesPanelContent). Reasons show their class tag (S/R/F/C).
3. **P4 core annotations**:
   - Effective Δt: show `timeStep` alongside the CLAMPED value + reason when the
     `clampAgentDt` math would reduce it. If that math lives worker-side, extract it to a
     shared pure helper both sites import (worker behaviour must stay byte-identical).
   - Capability closure "why": in `AgentCapabilitiesSection`, annotate rows auto-enabled
     by the closure with "(required by X)" — derive from `computeCapabilityClosure`
     deltas, never a hand-written table.
   - Simulator target chip: extend the existing amber handling so EVERY
     resolved≠requested state is amber and clicking/hovering names the reason (reuse
     `diagnoseTargets` + the runtime status acks the chip already reads).
4. Docs sweep: CLAUDE.md (new subsection), HelpView (a short "Engine compatibility"
   explainer stating the three principles), README one-liner.

Verification: tsc/build; check-compile-identity byte-identical on ALL library models;
in-browser on at least: an async model (Amphiphile → WebGPU grid ✗ semantics), a bonded
WebGPU-agent model (Morphogenesis - Growing Tissue → ⚠ fast-path residency note), a GRA
model (Cubic GRA → runs-on-GPU ✓ + ⚠ notes — disproving the "bonds prevent WebGPU"
misread), a clean sync grid model (Game of Life → all ✓). Evidence in the report.

### Completion Report — C1 (2026-08-02)

**Status: DONE.** One commit: **`4ddca6f`** *feat(clarity): target-compatibility
readout + resolved-config annotations (C1)* on `GRA` (not pushed, no version bump,
no attribution lines). Plan + illustrated mockup: [PLAN_CLARITY_C1.md](PLAN_CLARITY_C1.md) / `.html`.

#### What shipped

1. **`src/model/targetDiagnosis.ts`** (new, pure) — `diagnoseTargets(model)` → per layer
   (grid / agents) × per engine (js / wasm / webgpu) `{ ok, blockers, notes }` with
   class-tagged reasons (`semantics` / `reproducibility` / `fastpath` / `capacity`), plus
   each layer's `requested` / `resolved` / `demotionReason`. Every **verdict** is produced by
   the enforcing function — `detectWebGPUIncompatibilities`, `detectWebGPUModelIncompatibilities`,
   `detectWasmIncompatibilities`, `isAgentGraphWasmSupported`, `isAgentGraphWebGPUSupported`,
   `agentTargetOf`, `residencyModelBlockers`, `resolveMaxBonds`. Nothing is re-implemented.
   - A gate that early-outs unless its target is selected (`detectWebGPUModelIncompatibilities`)
     is asked **hypothetically** via a shallow probe clone — otherwise the readout would say
     "no problem" for every non-WebGPU model.
   - **Reason texts are a diagnostic layer ON TOP of the verdict.** The agent gates return a
     bare boolean, so a "no" is explained by reading the gates' OWN tables
     (`AGENT_*_SUPPORTED_TYPES`, `AGENT_NEARBY_SCRATCH_SLOTS`=4, `AGENT_WEBGPU_NEARBY_SLOTS`=6)
     plus exact detectors for the documented op-level fundamentals (median / uniform-random
     aggregate, toggle/next/previous indicators, cross-agent overwrite to a WIRED non-spawn id —
     mirroring the gate's own node types / port names / Create-Agent exemption), falling back to
     a generic honest sentence. A reason can be unhelpfully generic, **never wrong about ✓/✗**.
2. **`src/model/agentResidency.ts`** (new, pure) — `residencyModelBlockers(cfg, facts)`, the
   MODEL half of `agentResidentEligible`. **The worker CALLS it** (keeping only its runtime
   terms: `rt.ready`, resolved target, `simulateAgents`), so engine decision and user
   explanation are ONE predicate; the main thread never imports the worker. Blockers ordered
   most-fundamental-first. `bondSlots` is passed IN — the worker supplies its store's real
   `s.maxBonds` (the actual allocation), the UI the prediction `resolveMaxBonds(cfg)`.
3. **P4 core** — `effectiveAgentDt(cfg)` in `centerBased.ts` (the Mathias-2020 clamp extracted
   verbatim; `clampAgentDt` now calls it, same operands/order); `capabilityClosureDrivers` in
   `agentCapabilities.ts` (DERIVED by probing each capability through `computeCapabilityClosure`,
   never a hand-written table); a collapsible **Compatibility** block in Properties; the
   effective-Δt line; the `(required by …)` row suffixes; and the simulator chip amber for
   **every** `resolved ≠ requested` state with the classified reason in its tooltip.
4. **Docs sweep** — a CLAUDE.md section, HelpView *"Engine compatibility — three principles"* +
   *"Nothing is resolved silently"*, a README bullet.

#### Verification evidence (real numbers / observations)

**Gates** — `npx tsc -p tsconfig.app.json --noEmit` clean; `npm run build` clean;
`check-compile-identity --compare` → **"BYTE-IDENTITY OK — 29 models, all surfaces unchanged"**;
`parity-agent-wasm.mjs` → **ALL AGENT SAMPLES: JS↔WASM BIT-PARITY ✓**; `parity-agent-force.mjs`
→ **FORCE-PASS PARITY ✓ (20 checks)**; `verify-agent-render.mjs` → **AGENT RENDER-LAYER INVARIANTS ✓**.

**Model sweep (all 29 library models)** — `verdict ⇔ blocker` consistency holds on every
layer/engine (no "✗ with no reason", no "✓ with a blocker"). The four async grid models
(Amphiphile, Chromatography, gas_particles, snake) are the ONLY grid-WebGPU ✗ — matching the
library compile-target policy exactly. No model demotes (`requested === resolved` everywhere)
except when deliberately provoked (below).

**In-browser (dev server, real library models, real DOM reads).** Screenshots were unavailable
(the Browser pane reports not-displayed — the documented occluded-pane trap), so evidence is
DOM text + computed styles + worker messages, which is the right evidence for a text/DOM feature.
- **Amphiphile** — `CA GRID / running WebAssembly`; **✗ WebGPU** with two **[S]** blockers
  ("requires synchronous update mode…" + "Transfer Cell Attributes to Neighbor requires
  asynchronous update mode"); ✓ WASM, ✓ JS.
- **Morphogenesis - Growing Tissue** — `AGENTS / running WebGPU`; **✓ WebGPU** carrying **[R]**
  statistical parity **and [F]** *"Not GPU-residency eligible — the behaviour graph rewrites
  structure…"*. Δt row: **"→ effective Δt 0.0625 — clamped from 0.1 for stability (μ_eff = 3.2)"**
  (matches the hand calculation 0.2/(2+1.2)). Closure annotations on 3 rows:
  `Motion (required by Collision, Bonds, Auto-bond)`, `Body / Extent (required by Collision,
  Growth, Division)`, `Bonds (required by Auto-bond)`.
- **Cubic GRA** — `AGENTS / running WebAssembly`; **✓ WebGPU** + [R] + [F] residency note —
  the direct in-UI disproof of *"bonds prevent WebGPU"*. Δt shows the non-binding bound
  ("= 0.1379 — not binding here"), correctly unclamped.
- **Game of Life** — `CA GRID / running WebGPU`; all three engines ✓.
- **Amber chip** — provoked through the REAL radio: on Ant Necrophoresis, selecting the WebGPU
  agent target (which its gate rejects) makes the readout show
  `requested WebGPU → running Debug / Reference (JS)` with an **[S]** cross-agent-write blocker,
  and the simulator chip becomes **`⚙ WASM · agents JS⚠`** in **`rgb(224,160,80)`** (#e0a050)
  with the classified reason + "Full readout: Properties → Compatibility" in its tooltip.
  **Negative control**: reloading the model fresh returns `⚙ WASM · agents WASM` in the default
  grey `rgba(128,144,160,0.7)`, no ⚠, generic tooltip.
- **Collapsible section** — collapsing hides the body (`display:none`) and writes
  `genesisca_properties_collapsed = ["compatibility"]`; expanding restores it and writes `[]`.
- **Behaviour unchanged at runtime** — Amphiphile steps generations 1–6; Growing Tissue runs to
  generation 40 on the WebGPU agent target. The refactored worker predicate reports
  `residentEligible: true` for **Boids** and `false` for **Growing Tissue** (via `__e1bCounters`),
  matching both the pre-change documented behaviour and this phase's readout. **0 console errors**
  across the whole session (fresh `console.error` hook, per the documented buffer caveat).
- **Help** — the "Engine compatibility — three principles" and "Nothing is resolved silently"
  subsections render in the Bond-Graph Agents chapter.

#### Deviations / decisions (no scope cuts)

1. **Section placement.** The spec said "Properties → Execution: a Compatibility block". It ships
   as its OWN `CollapsibleSection id="compatibility"` placed **directly under Execution** (which it
   explains) rather than nested inside that already-very-long body — same collapsible pattern,
   better discoverability. Behaviourally identical to the spec's intent.
2. **`detectWasmModelIncompatibilities` is deliberately NOT called.** It wraps the documented-
   deprecated `detectAgentTargetRestriction`, which keys off the GRID flags and would falsely
   block every agent model. The live per-node `detectWasmIncompatibilities` IS called, so a future
   WASM-only gap surfaces with no edit to the diagnosis module.
3. **Behaviour-scoped graph walks** were required for correctness: whole-graph scans wrongly
   reported Particle Life as residency-ineligible (its Create Agent is in the **Init Event**, and
   the compiler flags are behaviour-scoped) and named `agentInit` as an unsupported node type on
   Ant Necrophoresis. `walkAgentBehaviourNodes` mirrors the compilers' `behaviourReachableNodeIds`
   (flow edges out, value edges in); the FIELD term stays whole-graph, matching `agentUsesField`.
4. **Ant Necrophoresis' agent WebGPU verdict is ✗** (cross-agent write to a wired id). That is the
   pre-existing Cross-Agent Write Semantics gate, added after the CLAUDE.md line recording an
   earlier GPU-live verification of that model; it is consistent with the model shipping on WASM.
   C1 only surfaces it — no gate was changed.

#### Follow-ups for later phases (not defects)

- The residency facts are re-derived from node types in the UI rather than read from the WebGPU
  agent compile result. **C3** adds a supported `getDiagnostics` worker message carrying the real
  compiler flags — the readout's F-notes should then read from it (removing the conservative
  approximation entirely).
- `diagnoseTargets` runs both agent gates (each flattens the agent graph). Memoised on `model` in
  both consumers; if a future phase calls it more often, share one memo.

---

## §C2 — Generation Pipeline panel (P3)

**Goal**: one function is the single source of truth for "what happens each generation for
THIS model", rendered as a read-only ordered phase list — engine vs graph attribution,
tempo tags, resolved numbers, off-phases named with their owning capability.

Deliverables:
1. **`src/model/generationPipeline.ts`** (new, pure):
   `describeGenerationPipeline(model) → PipelinePhase[]`,
   `PipelinePhase = { id, title, owner: 'graph' | 'engine', tempo: 'generation' | 'event'
   | 'frame' | 'reset', active: boolean, capability?: string, detail?: string,
   presentation?: boolean /* reserved; set by C8 */ }`.
   Derive activity + numbers from the SAME resolvers the engine uses
   (`usesEngineCollision/Springs/Growth`, `usesCharge`, `usesBondingPhysics`,
   `resolveMaxBonds`, `layoutIterationsOf`, `chargeParamsOf`, momentum/maxSpeed/Δt via
   `cbNum` + the C1 Δt helper, `sparseSteppingEnabled`, topology, update modes) — never a
   parallel hand-written truth. Phase order mirrors the documented loops (CLAUDE.md: the
   agent step order incl. the structural sub-steps; cell step; indicators; colour pass;
   the once-per-reset init roots; the per-frame colour/OM pass). Include the integration
   formula with resolved numbers (e.g. `v = 0.9·v + (0.05/1)·ΣF, cap 2.0`).
2. **A "Generation Pipeline" collapsible section** in Properties (shown for every model;
   grid-only models get the short list). Inactive phases render struck/dimmed with
   "(off — <capability>)". Tempo tag as a small chip per row.
3. **Drift guard**: `scripts/test-generation-pipeline.mjs` — the function's activity bits
   must track the resolvers across a matrix of synthetic configs (bonding on/off,
   collision modes, growth, charge, sparse, async/sync, agents-only / grid-only / both);
   phase ORDER matches a hard-coded expectation list (changing order must be a conscious
   edit of the test). Include at least one negative control.
4. Docs sweep: CLAUDE.md subsection; HelpView "what runs each generation" content derived
   from the same function (no hand-written duplicate table); README bullet.
   Plan + mockup per §1 (this is a UI addition).

Verification: tsc/build; compile-identity untouched; the new harness green; in-browser:
Boids (motion/sensing active, bonds/growth struck), Growing Tissue (springs + growth +
division + structural active), Ant Necrophoresis (field deposit noted, sequential tag),
GoL grid-only (short list), Cubic GRA (queue drain + cadence note). Evidence in report.

### Completion Report — C2 (2026-08-02)

**Status: DONE.** Feature commit: **`96e5652`** *feat(clarity): generation-pipeline panel (C2)*
on `GRA` (this report rides the follow-up docs commit, as C1 did). Not pushed, no version bump,
no attribution lines. Plan + illustrated mockup:
[PLAN_CLARITY_C2.md](PLAN_CLARITY_C2.md) / `.html`.

#### What shipped

1. **`src/model/generationPipeline.ts`** (new, pure) — `describeGenerationPipeline(model) →
   PipelinePhase[]` in execution order, plus `describePipelineGroups(model)` (bracket headers
   carrying their own resolved number) and `integrationFormula(cfg)`.
   - **Every `active` bit and every number comes from the function the ENGINE consults**:
     `usesSoftCollision` / `usesPositionalCollision` / `usesEngineSprings` / `usesEngineGrowth` /
     `usesCharge` / `chargeParamsOf` / `chargeMaxDistOf` / `layoutIterationsOf` / `resolveMaxBonds` /
     `cbNum` / **C1's `effectiveAgentDt`** / `sparseSteppingEnabled`. Nothing is re-derived.
   - **Where a graph-content question HAS an engine usage gate, that gate is called** rather than
     scanned locally: `agentGraphUsesBondRequests` (the gate that SIZES the request queue) drives the
     drain row; `dividePartitionTableForModel` (the table the engine INDEXES at runtime) drives the
     divisions row *and* its partition/daughter-bond detail; `periodicParams` (the lowering's own
     clamp) produces the cadence note. The remaining content questions — "does the graph contain a
     Kill Agent / a Division Event root / a sprite / an Output Mapping" — have no resolver (the
     engine runs the phase and it no-ops), so they use the macro-aware `walkNodes` scan. **This split
     is stated explicitly in the module header**, not left implicit.
   - **Phase order read out of the shipped loops**, not invented: `runAgentStep` →
     `runAgentStructuralPhase` → `runStep`, the step-message batch loop, and the reset handler's
     `runInit` → `runGridInit` → `runAgentInit`. Agents step BEFORE cells; a field-using model gets
     *"reads/writes the cell field here — your deposit is what the cell step below then sees"* on the
     behaviour row, which is exactly WHY that order holds.
   - `presentation?` ships **reserved and never written**, so C8 needs no shape change.
2. **Properties → Generation Pipeline** (`GenerationPipelineBlock` in `PropertiesPanelContent.tsx`) —
   its own `CollapsibleSection id="pipeline"` directly under Compatibility (C1: *which engine*;
   C2: *what does it do*). Coloured left RAIL = owner attribution, per-row tempo CHIP, inactive rows
   struck + dimmed as `off — needs <capability>`, consecutive same-group rows inside a dashed bracket
   with the group's resolved number.
3. **`scripts/test-generation-pipeline.mjs`** — **3400 checks**: activity ⇔ resolver over a
   **288-combination** synthetic matrix; phase ORDER vs a hard-coded list (+ sub-lists must be ordered
   projections); all 29 shipped models; per-model assertions for the five verification models; **six
   negative controls**.
4. **Docs sweep** — a CLAUDE.md section; HelpView's *"What runs each generation"* rendering
   `<GenerationPipelineReference/>`, which calls **the same function** over a synthetic everything-on
   model (`FULL_AGENT_PROFILE`), so there is **no hand-written duplicate table**; a README bullet.

#### Verification evidence (real numbers / observations)

**Gates** — `npx tsc -p tsconfig.app.json --noEmit` clean; `npm run build` clean;
`check-compile-identity --compare` → **"BYTE-IDENTITY OK — 29 models, all surfaces unchanged"**;
`verify-agent-render.mjs` → **AGENT RENDER-LAYER INVARIANTS ✓**; the new harness →
**3400 passed, 0 failed · negative controls 6 caught, 0 missed**.

**The read-only guarantee is structural**: `git diff --stat` touches only `CLAUDE.md`, `README.md`,
`HelpView.tsx`, `PropertiesPanelContent.tsx` + the two new files. **No engine, compiler or worker file
was opened for writing.**

**The harness can genuinely fail — proven by SOURCE MUTATION**, not just by in-harness controls
(a test that only ever passes proves nothing):
- hard-coding `active: true` on the soft-collision row (the classic "parallel truth" drift) →
  **198 failures** and the matching negative control stops being caught;
- swapping the death/divide rows → the ORDER check fails with the **exact expected-vs-got diff**,
  plus 5 downstream failures.
Both mutations reverted; the harness is green again on the shipped source.

**In-browser (dev server, real library models, real DOM reads).** The Browser pane reports
`document.hidden === true` (the documented occluded-pane trap), so screenshots are unavailable and the
evidence is DOM text + computed styles — which is the right evidence for a text/DOM feature.
**0 console errors** across the whole session (fresh `console.error` hook after a reload, per the
documented persistent-buffer caveat).
- **Boids — Flocking** — `Integrate & commit positions · v = 0.9·v + (0.5/1)·ΣF · speed cap 1.1`;
  **struck**: Soft-sphere collision *(needs Collision = Soft-sphere)*, Bond springs *(needs Bonds =
  Physics)*, Growth ramp *(needs Growth)*, Divisions *(needs a Divide Agent node)*, Stale-bond sweep
  *(needs Bonds)* — exactly the runbook expectation.
- **Morphogenesis - Growing Tissue** — **21 phases**; springs `λ = 1.2 · rest length 1`, growth
  `radius → target, 0.035 per generation`, divisions `bonds partitioned by tension axis · daughter–
  daughter bond: auto`, auto-bond `form within 1.15×contact · break past 1.8×contact`, and the
  integration formula **`v = 0·v + (0.0625/1)·ΣF`** — the **clamped** Δt (C1 independently reported
  "effective Δt 0.0625 — clamped from 0.1"), so the panel shows what the integrator actually uses.
- **Ant Necrophoresis** — behaviour row reads *"asynchronous (**sequential** — a write is visible to a
  later agent this generation) · **reads/writes the cell field here — your deposit is what the cell
  step below then sees**"*; both halves present with **agents before cells** verified in the live DOM.
- **Game Of Life** — the grid-only **short list, 8 rows**, zero agent phases: Init/Grid Init (struck),
  Shuffle order (struck — synchronous), *Your Generation Step graph*, Skip isolated empty cells
  (struck), Double-buffer swap, Indicator aggregation (struck), Colour pass — cells.
- **Cubic GRA** — `Drain bond-request queue · **up to 8 requests per agent per generation**, applied in
  the order your graph issued them`; behaviour row carries **`cadence every 2`** (its Periodic Step,
  via the lowering's own `periodicParams` clamp); charge `k = -10 · cutoff 20`; and the spatial-hash
  row reads **`neighbour queries up to radius 6 (widened to the charge cutoff 20)`** — the documented
  bin-edge TRAP made visible. Sync agent mode ⇒ prime/commit rows both active. 4 computed indicators.
- **Owner attribution + tempo, measured**: on Cubic GRA the DOM carries **3 rails at `rgb(232,161,58)`
  titled "Your graph"** and **18 at `rgb(107,114,128)`** titled "The engine"; chips count
  18 × *per generation*, 1 × *per event*, 1 × *per frame*, 1 × *once per reset*, each with its
  explanatory tooltip.
- **Collapsible** — collapsing sets the body to `display:none` and writes
  `genesisca_properties_collapsed = ["pipeline"]`; expanding restores it and writes `[]`.
- **Help** — *"What runs each generation"* renders the derived 26-row list with owner + tempo per row.

#### Deviations / decisions (no scope cuts)

1. **Group headers ship as `describePipelineGroups(model)`, not a static const.** The spec's
   `PipelinePhase` has no place for a group's own resolved number, and the force loop's `×N iterations`
   must come from `layoutIterationsOf` like everything else. A companion function keeps that number on
   the same single-source rule instead of the UI re-deriving it.
2. **Two facts have no resolver and use a node scan** (Kill Agent / Division Event root / sprites /
   Output Mappings). The runbook says activity must come from the resolvers; where the engine has no
   resolver because the phase is simply a no-op without a request, a scan IS the source of truth. Both
   the module header and CLAUDE.md say so explicitly, and the two cases that DO have engine usage gates
   (`agentGraphUsesBondRequests`, `dividePartitionTableForModel`) call those gates rather than scanning.
3. **`indicators` is one phase for both layers**, not split per layer — linked indicators aggregate
   cell attributes and graph indicators measure the agent bond graph, so it belongs to neither half.
4. **The Help reference lists every phase the engine can run, without the active/struck state** (some
   are mutually exclusive — soft vs positional collision, sync swap vs async shuffle), and the caption
   says so. Rendering one model's subset there would teach a smaller sequence than exists.

#### Follow-ups for later phases (not defects)

- **C8** sets `PipelinePhase.presentation` and adds the *"presentation only — does not affect your
  rule"* label to the force/motion/layout rows. The field and the group ids are already in place.
- **C3**'s diagnostics answer the runtime half ("did residency/sparse actually ENGAGE?"). C2
  deliberately describes only what the model asks for; the two should read as a pair.
- The proposal notes the worker could eventually ITERATE this table, making drift impossible. That is a
  large engine refactor; v1 is a parallel description pinned by the harness — the fallback the proposal
  itself names.

---

## §C3 — Fast-path diagnostics popover (P4 rest) + generated capability docs (P8)

**Goal**: Class F becomes inspectable (which fast paths engaged, first blocking reason),
and the Help capability/limits documentation is GENERATED from the gate tables.

Deliverables:
1. **A supported `getDiagnostics` worker message** (promote the DEV probes): returns
   `{ residency: {eligible, engaged, firstBlocker?}, sparse: {configured, active, count},
   fieldBridge: {eligible, gpuGens, cpuGens}, directRender: {mode}, engine: {grid, agents,
   fallbackEvents: string[] } }` — sourced from EXISTING worker state
   (`agentResidentEligible` + its first failing term, `sieActive`, the `__e1bCounters`
   fields, `agentRenderActive`/`agentCompositeActive`, resolved targets, plus a NEW
   capped `runtimeEvents` log appended at every currently-silent fallback site: WASM
   instantiate fail, GPU device loss/build fail, per-step GPU bail, hash-overflow
   fallback [rate-limited], lattice webgpuGridFailed). On-demand request from the UI,
   never per-step.
2. **Diagnostics popover** on the simulator compile-target chip (click): Engine /
   Fast paths / Events sections; fast-path rows green "engaged" or grey
   "off — <first blocking reason>".
3. **P8 generated docs**: `scripts/gen-capability-docs.mjs` (node-only) emits a committed
   `src/help/capabilityMatrix.gen.ts` from the REAL tables: `AGENT_NODE_REQUIREMENT`, the
   registry × `AGENT_WASM_SUPPORTED_TYPES` / `AGENT_WEBGPU_SUPPORTED_TYPES` reject deltas,
   the documented WebGPU grid reject set, and the capacity constants. HelpView renders its
   capability/limits matrix FROM this module; delete superseded hand-written fragments.
   Provide a `--check` mode that fails when the committed module is stale.
4. Docs sweep per §1.

Verification: tsc/build; compile-identity untouched; verify-agent-render green (worker
protocol addition); in-browser: popover on (a) Boids/WebGPU → residency engaged;
(b) Growing Tissue/WebGPU → residency off "bonds"; (c) Accretor → sparse count matches the
◩ chip; (d) a forced fallback (DEV hook) → event logged + shown. `--check` green.

### Completion Report — C3 (2026-08-02)

**Status: DONE.** Feature commit: **`2620d37`** *feat(clarity): fast-path diagnostics +
generated capability docs (C3)* on `GRA` (this report rides the follow-up docs commit, as
C1 and C2 did). Not pushed, no version bump, no attribution lines. Plan + illustrated
mockup: [PLAN_CLARITY_C3.md](PLAN_CLARITY_C3.md) / `.html`.

#### What shipped

1. **`getDiagnostics` — a SUPPORTED worker message** (request/reply `getDiagnostics` →
   `diagnostics`), sent when the popover opens plus a 700 ms poll while it is open.
   **On demand only, never per step.** Every field is read from state the worker already
   maintains; the reply costs one predicate evaluation. Additive — no existing message
   shape touched.
   - **The residency reason comes from the SAME predicate the engine decided with**: the
     reply calls C1's `residencyModelBlockers` with the WORKER's facts — the compiler flags
     it was handed (`rt.usesSpawn` / `rt.usesStop` / `rt.indicatorsBuf`) and the bond
     capacity it actually ALLOCATED (`s.maxBonds`). This **discharges C1's own follow-up**
     ("the residency facts are re-derived from node types in the UI … C3 adds a supported
     `getDiagnostics` worker message carrying the real compiler flags"). Where the two
     differ, the popover shows the worker's answer, because it is the one the engine acted on.
   - **`residency.engaged` is a real counter** (`residentBatchCount`, bumped where
     `runAgentBatchResident` SUCCEEDS), not the eligibility predicate — a model that
     qualifies but whose pipeline build failed reads *eligible, not engaged* rather than lying.
   - **`sieActiveCount()`** extracted out of `sendColors`, so the `◩ N active` chip and the
     popover's Sparse row read ONE expression and cannot disagree.
   - A path that does not APPLY reports **`n/a` with the reason**, never a fabricated blocker.
2. **The runtime fallback log** — a capped `runtimeEvents` (40, oldest dropped) of
   `{ gen, text }`. **`postFallback(message)`** replaces the bare error post at the **15
   engine-fallback sites** (grid + agent WASM instantiate/compile/run, agent WebGPU
   build/step/resident-batch, both hash-overflow fallbacks, every `[webgpu]` grid init
   failure), keeping the banner and adding a durable record. Ordinary operational errors
   (a failed colour pass, a readback that threw) are deliberately EXCLUDED — that is what
   makes an empty Events list a meaningful statement.
   - **Two genuinely silent sites closed**: `startWebGPUInit`'s `!shaderCode` arm set
     `webgpuGridFailed` with no message at all, and the shared device's loss /
     uncaptured-error hooks were console-only. `sharedGpuDevice.ts` is imported BY the
     worker and must not import back, so it gained **`setSharedGpuEventSink(fn)`** — a
     one-line seam; absent sink ⇒ exactly the previous behaviour. Uncaptured errors capped at 3.
   - **Rate limiting reuses the EXISTING warn-once latches**, so a hash overflow logs once.
3. **The diagnostics popover** on the `⚙` compile-target chip — Engine / Fast paths /
   Events. Rows are green/grey, **never red**, with Principle 3 as the section footnote.
   Joins the single-open `overlayPopup` state (inheriting outside-pointerdown + Escape);
   geometry follows the capture-cluster lessons (own relative wrapper, upward-left and
   flush, `max-height` + scroll, inside `data-sim-overlay`); opens on **click**, not hover.
   `diagnostics` is cleared on **`modelVersion`** so a previous model's reading is never
   shown as current.
4. **P8 — [scripts/gen-capability-docs.mjs](../scripts/gen-capability-docs.mjs) →
   [src/help/capabilityMatrix.gen.ts](../src/help/capabilityMatrix.gen.ts)** (committed),
   with a `--check` staleness gate. HelpView renders four new blocks from it; the
   hand-typed counts are gone.

#### Verification evidence (real numbers / observations)

**Gates** — `npx tsc -p tsconfig.app.json --noEmit` clean; `npm run build` clean;
`check-compile-identity --compare` → **"BYTE-IDENTITY OK — 29 models, all surfaces
unchanged"**; `parity-agent-wasm` → **ALL AGENT SAMPLES: JS↔WASM BIT-PARITY ✓**;
`check-agent-wasm-gate` → **GATE✓ COMPILE✓ INST✓** on every sample; `verify-agent-render`
→ **AGENT RENDER-LAYER INVARIANTS ✓**; `gen-capability-docs --check` green.

**The `--check` gate is proven FAILABLE by a SOURCE mutation** (an in-file mutation alone
would prove only that it diffs its own output): removing `'getNearbyAgents'` from
`AGENT_WASM_SUPPORTED_TYPES` made it **exit 1** naming the exact drift
(`committed "wasm": true / generated "wasm": false`, line 457); reverted → green again.
A second control (hand-editing the committed count 53 → the stale 42 Help used to carry)
was likewise caught at the exact line.

**The first generated output caught two real defects — inspected, not assumed:**
- the WebGPU-grid probe reported the three unconditional rejects as *config-dependent*
  (the same reason recurs under every candidate op). Fixed by treating a rejection under
  the BARE config as proof the reject does not depend on configuration.
- the raw set delta listed `neighbourCensus`, `applyForceToAgents`, `periodicStep`,
  `agentOutputMapping`, `agentInit` and `divisionEvent` as unsupported — **actively wrong
  documentation**, the exact drift P8 exists to prevent. Fixed with three DERIVED
  exemptions: `entryPoint` (`category === 'event'` — the gates walk the behaviour-reachable
  cone, which never contains a root), `lowered` (**probed** by feeding each shipped
  pre-compile transform a one-node graph and seeing whether the node survives), and
  `cpuRoot`. After the exemptions **`setAgentSprite` is the single genuine gap on both
  targets** — exactly the carve-out CLAUDE.md documents.

**In-browser (dev server, real library models, real worker messages).** The Browser pane
reports `document.hidden === true` (the documented occluded-pane trap), so screenshots are
unavailable and the play loop is suspended; steps were driven one-per-reply through
`window.__simWorker` per the documented recipe. Evidence is DOM text + worker replies —
the right evidence for a text/DOM + protocol feature. **0 console errors** across the whole
session (fresh `console.error` hook, per the persistent-buffer caveat).
- **(a) Boids — Flocking, WebGPU agents → residency ENGAGED.** Popover: `GPU residency —
  engaged (1 batches)`, `Direct render — agents → canvas`, no events. After driving 12
  further batches the reply read `batches: 13` — the counter tracks real resident batches,
  it is not the eligibility flag.
- **(b) Morphogenesis — Growing Tissue, WebGPU agents → residency OFF with the reason.**
  `Agents — WebGPU` (running on the GPU, disproving "bonds prevent WebGPU") while
  `GPU residency — off — the behaviour graph rewrites structure (Divide / Form / Break /
  Rewire / Kill Agent, or a radius write) — the structural phase is CPU work between
  generations on every engine`.
- **(c) Accretor → sparse count matches the ◩ chip.** The SHIPPED Accretor has
  `skipIsolatedEmpty.enabled: false` (a deliberate config — it runs on WebGPU, where sparse
  is a documented no-op), so it correctly reports *off — Skip Isolated Empty Cells is off
  for this model*. To exercise the engaged state an in-memory variant (enabled + WASM grid,
  60³; the shipped file untouched) gave chip `◩ 1,795 active (0.0%)` and popover
  `Sparse stepping — 1,795 of 5,400,000 cells` — **identical numbers**, which is the shared
  helper working.
- **(d) A forced fallback is logged and shown.** A real, user-reachable configuration — an
  ASYNC model (Amphiphile) with the WebGPU grid target selected — produced Engine
  `WebGPU (failed — running on the CPU)` in amber with C1's classified `[S]` reason, and
  Events `gen 0 · [webgpu] compile failed: WebGPU target requires synchronous update
  mode…`. **No flooding**: the list stayed at exactly 1 across 250 step messages.
- **The `modelVersion` reset was confirmed live** — loading a new model while the popover
  was open switched it to *"Waiting for the simulation worker…"* rather than showing the
  previous model's reading as current.
- **Help renders the generated data**: `150 selectable node types (53 of them agent nodes,
  20 Overseer nodes)`; a 53-row matrix (`Set Sprite` ✗/✗, `Division Event` —/—); the 5
  grid rejects with correct conditions (3 *any configuration*, 2 op-specific); 10 capacity
  limits with their real numbers (scratch slots 4, array-producer slots 6, array cap 2,048,
  bond-request depth 8/64, hash bins 65,536, …).

#### Deviations / decisions (no scope cuts)

1. **The 40-entry cap is a structural safety net, not something I saturated — and the
   reason is worth recording.** A model load TERMINATES and recreates the worker, so the
   log is worker-scoped: 48 reloads of the deliberately-broken model left exactly **1**
   event, because each fresh worker records its own. "This session" therefore means this
   worker's life, which is the honest semantics; the cap protects a long-lived worker
   taking repeated per-step fallbacks, which a normal session never approaches.
2. **Rate limiting reuses the pre-existing warn-once latches** rather than adding a second
   mechanism. Their one-time character is therefore inherited (those booleans already gated
   the `error` post), not newly written — stated here rather than claimed as new evidence.
3. **`postFallback` is scoped to ENGINE FALLBACKS**, not to every `error` post. There are
   ~60 error sites in the worker; logging "paint readback failed" alongside "the GPU device
   was lost" would make the Events list noise and destroy the meaning of an empty one.
4. **The WebGPU grid reject set is probed with a candidate-operation list.** That list is
   the probe's INPUT SPACE — the gate still produces every verdict — because
   `detectWebGPUIncompatibilities` is an inline switch with no exported list and its
   `updateIndicator` arm is config-dependent. Documented in the generator.
5. **`docs/NODES_REFERENCE.md` per-node annotations are NOT regenerated** (the runbook
   scopes P8 here to the Help matrix). Its target facts live in a prose *Notes* column, so
   converting it is a separate migration; the generator is shaped to emit it later.
6. **No toasts for fallback events** — the runbook assigns the UI half of loud fallbacks to
   **C6**. C3 built the log C6 consumes.

#### Follow-ups for later phases (not defects)

- **C6** surfaces `runtimeEvents` as one-time toasts and adds its own "legacy physics flags
  in effect" event; the log + the `postFallback` seam are in place for it.
- The generated module also exports `AGENT_CAPABILITY_LIST` (the capability rows with their
  descriptions), currently unused: HelpView still hand-lists the capabilities in prose.
  A later docs pass can render that from the generated data too.
- `NODES_REFERENCE.md` (see deviation 5) is the remaining half of P8.

---

## §C4 — One Engine selector: `auto | wasm | webgpu` (+ Debug JS) (P1)

**Goal**: replace the dual grid booleans + separate agent radio semantics with ONE
resolved-and-displayed engine model. JS demoted to an explicitly-labeled Debug choice.
Show Code always shows the JS reference source.

Deliverables:
1. **Schema**: `ModelProperties.engine?: 'auto' | 'wasm' | 'webgpu' | 'js'`;
   `CenterBasedConfig.agentTarget` gains `'auto'`. Migration (LOAD_MODEL + macroImport +
   `migrateForHarness`): absent `engine` → derive the EXPLICIT equivalent of the legacy
   flags (`useWebGPU→'webgpu'`, else `useWasm→'wasm'`, else `'js'`) so every existing file
   behaves byte-identically (legacy files do NOT become auto). `EMPTY_MODEL` defaults
   `engine:'auto'` + `agentTarget:'auto'`. **Serialization writes BOTH** the new field and
   the legacy flags (kept in sync) for one release cycle so older builds open new files.
2. **Resolution**: `resolveEngines(model) → { grid, agents?: { requested, resolved,
   reason } }` — single source consumed by SimulatorView's compile paths, the C1
   chip/readout, and C3 diagnostics. Auto policy THIS phase: WebGPU where every gate
   passes, else WASM; prefer WASM when `overseerConfig.enabled` (C5 replaces this with
   the contract). The worker's safety-net demotions stay unchanged.
3. **UI**: Properties Compile Target radio becomes **Auto (recommended) / WebAssembly /
   WebGPU**, Auto displaying its resolution ("Auto → WebGPU"), plus an Advanced reveal
   containing **Debug (JS) — readable & breakpointable, slow**. Same treatment for the
   agent target radio. Plan + mockup per §1.
4. **Show Code**: always shows the JS reference source with a header note ("reference
   semantics — the engine runs <resolved>").
5. **New gate**: a script asserting `resolveEngines` over every `public/models/*.gcaproj`
   matches the legacy-flag resolution exactly, plus new-model Auto expectations + the
   save/load round-trip of `engine` + legacy flags.
6. Docs sweep (CLAUDE.md compile-target sections' framing, HelpView, README).

Verification: tsc/build; compile-identity byte-identical for ALL library models; the new
gate green; in-browser: library models resolve unchanged; a New model shows
"Auto → WebAssembly"; save→load round-trips.

### Completion Report — C4 (2026-08-02)

**Status: DONE.** Feature commit: **`b0f43b9`** *feat(clarity): one Engine selector —
auto | wasm | webgpu (+ Debug JS) (C4)* on `GRA` (this report rides the follow-up docs
commit, as C1–C3 did). Not pushed, no version bump, no attribution lines. Plan +
illustrated mockup: [PLAN_CLARITY_C4.md](PLAN_CLARITY_C4.md) / `.html`.

#### What shipped

1. **Schema + migration.** `ModelProperties.engine?: 'auto'|'wasm'|'webgpu'|'js'` and
   `'auto'` on `CenterBasedConfig.agentTarget` ([types.ts](../src/model/types.ts)).
   **`useWasm`/`useWebGPU` are NOT deleted — they become the RESOLVED MIRROR**, which is
   the representation every downstream consumer already reads (worker init message, both
   layout builders, the WebGPU/WASM node gates, the CaNode badge). That is what makes the
   phase byte-identical AND what lets an older build open a file written by a newer one;
   the removal schedule is recorded in CLAUDE.md and on the fields themselves.
   [engineFieldMigration.ts](../src/model/engineFieldMigration.ts) (wired into `LOAD_MODEL`
   + `migrateForHarness`) seeds the **explicit equivalent** of a legacy file's flags —
   **a legacy file never becomes `'auto'`**. `EMPTY_MODEL.engine = 'auto'`,
   `defaultCenterBasedConfig().agentTarget = 'auto'`.
2. **`resolveEngines(model)`** ([engineResolution.ts](../src/model/engineResolution.ts)) —
   the single source: per layer `{ selected, requested, resolved, reason, auto }`, every
   verdict from the ENFORCING gate (C1's discipline), **memoised on the model object**
   (WeakMap) so the per-node CaNode badge is O(1) rather than O(N²).
   **`withResolvedEngine`** bakes the resolution into the mirror — deliberately the
   **requested** engine, not the resolved one, so an explicit choice the gates reject is
   still COMPILED and still fails loudly (that compile error is what produces C3's
   fallback event; baking the demotion would have silently deleted it).
3. **Consumers**: `withPipelineModel` in SimulatorView (init / soft recompile / Show Code),
   `needsFullInit` (comparing the RESOLVED engines, so an `'auto'` model that re-picks
   after a graph edit reinitialises), the C1 readout (whose grid WebGPU verdict now shares
   `gridWebgpuBlockers` with the resolver, so verdict and explanation cannot disagree), the
   simulator chip (**preferring C3's `getDiagnostics.engine`** when the worker has replied
   — the runbook's C3 hand-off), the CaNode badge, and `serializeModel`.
4. **UI**: one shared `EngineRadio` renders both layers — **Auto (recommended) /
   WebAssembly / WebGPU** with **Debug / Reference (JS)** behind an **Advanced** reveal
   (auto-open when JS is selected, so the selected option can never be hidden). Auto shows
   a green `Auto → WebGPU` badge + the reason; a rejected explicit choice shows an amber
   `WebGPU → running JS`. Everything in the panel that keyed off the raw mirror flags (the
   async-mode greying, the WebGPU stop-check interval) now reads the RESOLVED engine.
5. **Show Code always shows the JS reference source**, with a header naming the engine that
   actually runs. The WebGPU compile still runs when WebGPU is resolved — its error must
   keep surfacing — only the displayed text changed.
6. **[scripts/test-engine-resolve.mjs](../scripts/test-engine-resolve.mjs)** — 367 checks.
7. **Docs sweep** — a CLAUDE.md section (+ the "three targets" framing in the Graph→Compile
   and WASM sections updated, not deleted), HelpView (a rewritten Engine bullet + a new
   *"Auto — and why JS is not a peer"* subsection), a README bullet.

#### Verification evidence (real numbers / observations)

**Gates** — `npx tsc -p tsconfig.app.json --noEmit` clean; `npm run build` clean;
`check-compile-identity --compare` → **"BYTE-IDENTITY OK — 29 models, all surfaces
unchanged"**; `test-engine-resolve` → **367 passed, 0 failed · 3 negative controls caught**;
`parity-agent-wasm` → **ALL AGENT SAMPLES: JS↔WASM BIT-PARITY ✓**; `check-agent-wasm-gate`
→ **GATE✓ COMPILE✓ INST✓** on every sample; `verify-agent-render` → **✓**;
`verify-render-uniform-layouts` → **✓**; `test-generation-pipeline` → **3400 passed**;
`gen-capability-docs --check` green.

**The new gate is proven FAILABLE by TWO SOURCE MUTATIONS** (an in-harness control alone
only proves the harness can count):
- removing the Overseer preference from `resolveGridLayer` → **3 failures** and its matching
  negative control stops being caught;
- mis-mapping `useWasm → 'js'` in the migration → **38 failures** across 9 models.
Both reverted; green again on the shipped source.

**In-browser (dev server, real library models, real clicks, real worker).** The Browser pane
reports `document.hidden === true` (the documented occluded-pane trap), so screenshots are
unavailable and the evidence is DOM text + computed styles + worker messages — the right
evidence for a text/DOM feature. **0 console errors** across the whole session (fresh
`console.error` hook, per the persistent-buffer caveat).
- **Library models resolve UNCHANGED.** Accretor loads with **WebGPU** checked (its file's
  `useWebGPU`), Amphiphile with **WebAssembly**, Cubic GRA's **Agent Engine** with
  **WebAssembly** — and Cubic GRA's grid radio is correctly absent (agents-only).
  A module-level sweep over Accretor / Amphiphile / Cubic GRA / Game Of Life confirmed
  `legacy === resolved` on every one.
- **Auto, through the real radio.** Accretor → Auto shows the green badge **`Auto → WebGPU`**
  (`rgb(92,191,122)`) with *"Every WebGPU gate passes, so Auto runs the grid on the GPU."*,
  the C1 readout switches to **`Auto → running WebGPU`**, and the **WebGPU stop-check field
  becomes enabled** (it reads the resolved engine, so Auto lights up the same UI an explicit
  pick does). Amphiphile → Auto shows **`Auto → WebAssembly`** with *"Auto picked
  WebAssembly — WebGPU target requires synchronous update mode…"* and leaves the
  Asynchronous radio enabled. Cubic GRA's agents → Auto shows **`Auto → WebAssembly`** with
  the **Overseer** reason — the sweep-reproducibility exception, visible in the UI.
- **A NEW model (File → New) shows `Auto → WebGPU`** — see deviation 1.
- **The Advanced reveal works**: 3 radios before, 4 after clicking `▸ Advanced`, with
  *Debug / Reference (JS)* the fourth.
- **Show Code** renders `/* Reference semantics — the engine runs on WebGPU. … */` followed
  by `// === Step Function ===` and the JS source — on a model running WebGPU.
- **Behaviour unchanged at runtime**: Coagulation under `engine:'auto'` steps to
  **generation 50** with the chip reading `⚙ WebGPU` in the neutral grey (no demotion);
  Morphogenesis - Growing Tissue runs to **generation 145** on the WebGPU agent target with
  the chip reading `⚙ agents WebGPU`.
- **Save → load round-trip**, through the real `serializeModel`: a Cubic GRA with agents
  flipped to Auto saves `engine:'wasm'` + `useWasm:true/useWebGPU:false` + a **concrete**
  `agentTarget:'wasm'` (so an older build reads the same engine), and reloads to the same
  engine.

#### Deviations / decisions (no scope cuts)

1. **A new model resolves `Auto → WebGPU`, not `Auto → WebAssembly`.** The runbook's
   verification bullet expects WebAssembly, but the POLICY sentence — in both the proposal
   (*"Auto = the library policy, codified: WebGPU where every gate passes, else WASM"*) and
   this runbook's own §C4 — gives WebGPU for an empty synchronous grid, and **C5 states
   explicitly that "the GRID stays WebGPU-eligible under exact"**, so resolving new models
   to WASM here would be contradicted next phase. The policy wins; the expectation bullet
   is the casualty, recorded here rather than quietly satisfied by inventing an extra
   policy term.
2. **`macroImport` is not a migration site.** The runbook lists it, but a `.gcamacro`
   carries a `MacroDef`, which has no `properties` and no `centerBased` — there is nothing
   to migrate. Stated in the migration module's header.
3. **The legacy flags are kept as a resolved MIRROR rather than deleted**, per the runbook's
   own "serialization writes BOTH … for one release cycle". This is also what makes the
   byte-identity result achievable: every existing consumer keeps reading the exact value it
   read before. `serializeModel` bakes the mirror so a saved file can never disagree with
   the live resolution, and the removal schedule is documented.
4. **`withResolvedEngine` bakes the REQUESTED engine, not the resolved one.** Baking the
   demotion would stop SimulatorView compiling the requested target, and it is that
   compile's ERROR that produces the user-visible message and C3's fallback event (C3
   verified exactly this on an async model with WebGPU selected). Auto never picks a failing
   engine, so the distinction only affects explicit choices — where preserving the loud
   failure is the point.
5. **Show Code is JS-only, so the emitted WGSL is no longer reachable from the UI.** That is
   the spec (*"always shows the JS reference source"*), and it removes a real capability;
   the shader remains available through the dev harness, and re-adding it as a read-only
   Advanced view is recorded as a follow-up rather than smuggled in here.
6. **Two copy fixes found by driving the real UI**: the agent WebGPU option inherited the
   grid's "sync only" tag (wrong — the WebGPU agent target runs async models), so the tag
   became a per-radio prop; and the Agents topology description still pointed at "the Agent
   Compile Target below".

#### Follow-ups for later phases (not defects)

- **C5** replaces the Auto policy with the declared reproducibility contract; the Overseer
  special case (currently two hard-coded branches in `resolveGridLayer` /
  `resolveAgentLayer`) is exactly what it subsumes. `LayerResolution.reason` is already the
  string the UI renders, so C5 changes the policy without touching the UI.
- **Skip Isolated Empty Cells vs Auto**: Auto currently picks WebGPU on a model with sparse
  stepping enabled, where the GPU ignores it. The reason string SAYS so rather than dropping
  the fact, but a contract-aware Auto (C5) could weigh it — flagged, deliberately not
  invented as an extra policy term here.
- A read-only **WGSL inspector** (see deviation 5).
- The mirror-flag REMOVAL (one release cycle out) — at that point `withResolvedEngine`
  collapses to the `agentTarget` bake and every consumer must already read `resolveEngines`.

---

## §C5 — Reproducibility contract: Exact | Statistical (P10)

**Goal**: run-to-run tolerance becomes a declared model property; Auto consults it.

Deliverables:
1. **Schema**: `ModelProperties.reproducibility?: 'exact' | 'statistical'`; absent →
   `'exact'`. Migration: infer `'statistical'` iff the model's resolved AGENT target is
   webgpu; everything else exact. Serialized once set.
2. **Auto integration** (extends `resolveEngines`): Auto(exact) → WASM for the AGENT
   layer (GPU agents are not bit-reproducible); the GRID stays WebGPU-eligible under
   exact (grid WebGPU is seeded/per-device deterministic — document this asymmetry in the
   reason string and Help). Auto(statistical) → the library policy (WebGPU where gates
   pass). The Overseer-prefers-WASM special case is REPLACED by the contract; an
   Overseer-enabled model under statistical keeps GPU and the Experiments panel shows a
   repeats+aggregates methodology note; under exact it resolves CPU + single-seed
   trajectories. Explicit engine choices are never overridden — but an engine that cannot
   honour the declared contract renders an amber note in the C1 readout.
3. **UI**: a Reproducibility radio in Properties → Execution (Exact default) with a
   two-line explanation; C1 readout + chip display contract violations; Overseer panel
   methodology note.
4. Docs sweep + plan/mockup per §1 (CLAUDE.md: add the contract as the organizing surface
   in the Overseer + WebGPU framing; keep historical prose).

Verification: tsc/build; compile-identity 100% (schema additive); the C4 gate script
extended: WebGPU-agent library models infer statistical, others exact, resolution under
each contract matches the spec matrix; in-browser: Particle Life (webgpu agents) shows
Statistical inferred + Auto keeps GPU; flipping to Exact re-resolves Auto→WASM with the
reason shown; Cubic GRA (exact + Overseer) resolves WASM via the contract reason.

### Completion Report — C5 (2026-08-02)

**Status: DONE.** One commit: **`59afc6b`** *feat(clarity): declared reproducibility
contract — Exact | Statistical (C5)* on `GRA` (not pushed, no version bump, no attribution
lines). Plan + illustrated mockup: [PLAN_CLARITY_C5.md](PLAN_CLARITY_C5.md) / `.html`.

#### What shipped

1. **Schema** — `ModelProperties.reproducibility?: 'exact' | 'statistical'`, absent ⇒
   `'exact'`. **Exact** = bit-reproducible trajectories (a fixed seed pins a run);
   **Statistical** = runs are draws from the same distribution, sweeps use repeats +
   aggregates. The proposal's **guardrail** ships as UI copy: *Statistical covers stochastic
   variance around the SAME rule — it never licenses answering a different question.*
2. **[reproducibility.ts](../src/model/reproducibility.ts)** (new, pure) — `reproducibilityOf`,
   the shared copy (`REPRODUCIBILITY_LABEL/SUMMARY/GUARDRAIL`), `inferContract`,
   `engineHonoursContract` / `contractViolationFor`, `describeSweepMethodology`. The violation
   predicate is **told what RESOLVED** rather than resolving anything itself — the caller
   passes `resolveEngines`' answer, so there is exactly one resolution in the system.
   Deliberately import-free of `engineResolution` (which imports `reproducibilityOf` from
   here) — one-way, no cycle, mirroring the C4 `engineFieldMigration` split.
3. **[reproducibilityMigration.ts](../src/model/reproducibilityMigration.ts)** (new) — wired
   into `LOAD_MODEL` + `migrateForHarness` **after** `migrateEngineField`. Infers
   **`'statistical'` iff the RESOLVED agent engine is WebGPU**, reading `resolveEngines`
   rather than re-deriving it. Idempotent, stable, and it never re-infers a contract the user
   declared. Over the shipped library: **11 statistical / 18 exact**.
4. **Auto integration** ([engineResolution.ts](../src/model/engineResolution.ts)) — C4's two
   hard-coded `if (overseerConfig.enabled) pick = 'wasm'` branches are **gone**; the Overseer
   no longer appears in the resolution at all. `EngineResolution` gained `contract`, and
   `LayerResolution` a `contractViolation`.

   | contract | layer | Auto picks |
   |---|---|---|
   | any | grid | WebGPU if every grid gate passes, else WASM — **contract-independent** |
   | exact | agents | WASM if its gate passes, else JS |
   | statistical | agents | WebGPU → WASM → JS |

5. **UI** — a **Reproducibility** radio opening Properties → Execution (above Update Mode /
   Engine because it now governs them; outside the grid-cells gate, since it matters most for
   an agents-only model); a contract chip + an `[R]` note + an amber layer line in the C1
   Compatibility readout; the violation appended to the simulator `⚙` chip's tooltip via C1's
   **existing** amber `demotions` channel (one mechanism, no new state or colour); and a
   one-line **methodology** note in the Overseer Experiments panel.
6. **Docs sweep** — a CLAUDE.md section (+ the C4 Auto-policy table rewritten and the Overseer
   sweep bullet cross-linked, historical prose kept), HelpView (*"Reproducibility: Exact or
   Statistical"* + an Overseer cross-reference paragraph), a README bullet.

#### THE ASYMMETRY — the load-bearing fact, and it is measured

The two GPU layers are **not** equally reproducible, which is why the contract is not simply
"no GPU". Both facts are already recorded in `CLAUDE.md`; C5 only reads them:

| | seeded how | `setRngSeed` reaches it? | verdict |
|---|---|---|---|
| **WebGPU grid** | per-CELL PCG from a global seed | **yes** — the handler re-derives via `seedRngState` | reproducible **on this device** (measured: *WebGPU 460.8 ± 15.707 reproducible* across presses of a 5-run sweep) ⇒ **honours Exact** |
| **WebGPU agents** | per-AGENT PCG, **once at runtime creation** | **no** | a sweep does not reproduce ⇒ **cannot honour Exact** |

This is corroborated by the library itself: the documented sweep exceptions (`Cubic GRA`,
`Graph Metrics - Growth Sweep`) are **agent**-target exceptions, while `GoL Replicate
Statistics` — a grid Overseer model — **ships on WebGPU**.

#### Verification evidence (real numbers / observations)

**Gates** — `npx tsc -p tsconfig.app.json --noEmit` clean; `npm run build` clean;
`check-compile-identity --compare` → **"BYTE-IDENTITY OK — 29 models, all surfaces
unchanged"**; `test-engine-resolve` → **719 passed, 0 failed · 6 negative controls caught**;
`test-generation-pipeline` → **3400 passed**; `parity-agent-wasm` → **ALL AGENT SAMPLES:
JS↔WASM BIT-PARITY ✓**; `check-agent-wasm-gate` → **GATE✓ COMPILE✓ INST✓** on every sample;
`verify-agent-render` → **✓**; `gen-capability-docs --check` green.

**The read-only guarantee is structural**: `git diff --stat` touches the two new model
modules, the two migration call sites, `engineResolution` / `targetDiagnosis` / `types`, and
three UI files. **No compiler, worker or engine file was opened for writing.**

**The gate is proven FAILABLE by TWO SOURCE MUTATIONS** (an in-harness control alone only
proves the harness can count):
- making `inferContract` a constant `'exact'` → **14 failures**, including the per-model
  inference checks *and* `no contract violation on a shipped model` firing on all 11
  GPU-agent samples (the inference and the violation predicate cross-check each other);
- making the agent Auto policy ignore the contract (`const exact = false`) → **30 failures**
  and its matching negative control stops being caught.
Both reverted; green again on the shipped source.

**In-browser (dev server, real library models, real clicks, real worker).** The Browser pane
reports `document.hidden === true` (the documented occluded-pane trap), so screenshots are
unavailable and the evidence is DOM text + computed styles + worker messages — the right
evidence for a text/DOM feature. **0 console errors** across the session (fresh
`console.error` hook, per the persistent-buffer caveat).
- **Particle Life** (WebGPU agents) loads with **Statistical** checked — the migration
  inferred it — and its agent engine unchanged at the shipped explicit WebGPU.
- **Auto under Statistical keeps the GPU**: flipping the Agent Engine to Auto shows
  **`Auto → WebGPU`** with *"This model declares Statistical and the GPU can run this agent
  graph, so Auto picks WebGPU."*
- **Flipping the contract to Exact re-resolves Auto** to **`Auto → WebAssembly`** with
  *"This model declares Exact, so Auto keeps agents on WebAssembly… (The WebGPU agent engine
  seeds its per-agent RNG once at start-up and Set Random Seed never reaches it.)"*
- **The violation, all three surfaces**: with Exact declared and WebGPU explicitly selected,
  the radio shows the amber ⚠ sentence; the Compatibility readout reads
  `AGENTS · Exact · running WebGPU` with the violation as an `[R]` note on the **still-✓**
  WebGPU verdict plus the `⚠ Contract:` layer line; and the simulator chip becomes
  **`⚙ agents WebGPU⚠`** in **`rgb(224,160,80)`** with `⚠ Reproducibility contract (exact):`
  in its tooltip. **Negative control**: reloading Particle Life fresh (statistical inferred)
  returns the chip to `⚙ agents WebGPU` in the default grey `rgba(128,144,160,0.7)`, no ⚠, no
  contract text.
- **Cubic GRA** (exact + Overseer) loads with **Exact** checked and its explicit WebAssembly
  agent engine **unchanged** (coherence). Flipping it to Auto gives **`Auto → WebAssembly`**
  whose reason **names the contract and does NOT mention the Overseer** — the runbook's
  headline C5 requirement. Flipping its contract to Statistical then gives **`Auto → WebGPU`**,
  which the old special case forbade: the Overseer case is genuinely subsumed, not
  re-implemented.
- **All three methodology forms, live**: Cubic GRA (exact, all-CPU) → *"Exact contract — Set
  Random Seed pins each run bit-exactly; two presses of Run Experiment produce identical
  numbers."*; the same model under Statistical → *"…runs are draws from one distribution. Use
  repeats + aggregates… a single run is not a result."*; **GoL Replicate Statistics** (exact,
  WebGPU grid) → *"…pins a run on this device. A layer runs on the GPU in f32, so these
  numbers are engine- and device-specific: do not compare them against a CPU run."* — and its
  chip stays **grey `⚙ WebGPU`**, i.e. the GPU grid is correctly **not** a violation.
- **Behaviour unchanged at runtime**: GoL Replicate Statistics steps to **generation 40**
  through the real worker after the contract migration.
- **Help** renders *"Reproducibility: Exact or Statistical"* and the Overseer cross-reference.

#### Deviations / decisions (no scope cuts)

1. **THE ONE DEVIATION — the Overseer clause is honoured on the AGENT layer only; a grid
   Overseer model under Exact keeps WebGPU.** The runbook says *"an Overseer-enabled model
   under exact resolves CPU"*, which for the grid would contradict its own neighbouring
   sentence (*"the GRID stays WebGPU-eligible under exact"*) — and, more importantly, it is
   not true: `setRngSeed` **does** re-derive the grid's per-cell streams, a WebGPU grid sweep
   was measured reproducing across presses, and the library ships exactly such a model on
   WebGPU. Asserting otherwise would have put an amber "cannot honour Exact" note on
   `GoL Replicate Statistics`, which demonstrably can. The clause is fully honoured where it
   is true — under Exact the **agents** land on CPU, which is the requirement the special case
   stood in for, and `Cubic GRA` (the runbook's own verification model) resolves WASM via the
   contract reason. **Consequence**: the C4 test's synthetic expectation *"`GoL Replicate
   Statistics` flipped to Auto → wasm"* becomes `webgpu`, updated with its justification in
   the script. **No shipped model's resolution changes** — that expectation was a what-if, not
   the coherence requirement.
2. **The grid's Auto policy is contract-INDEPENDENT**, and the contract appears only in the
   *reason string* when it picks WebGPU under Exact (documenting the asymmetry where the user
   meets it) rather than as a second policy branch that never fires.
3. **C1's grid-WebGPU `[R]` note was factually corrected** in passing: it claimed *"a fixed
   seed does not reproduce a run exactly"*, which the `setRngSeed` fix had already made false
   for the GRID. It now states the honest per-device version. In scope because the contract is
   precisely about this claim.
4. **A violation is a note, never a blocker**, and it is surfaced on the WebGPU *verdict row*
   whenever the contract is Exact — not only once that engine is the resolved one — so the
   consequence of picking it is visible **before** it is picked.
5. **The chip reuses C1's amber `demotions` channel** rather than adding a second amber
   mechanism: a resolved engine that cannot honour the declared contract is the same class of
   surprise as a demotion (the model claims a guarantee it does not deliver).

#### Follow-ups for later phases (not defects)

- **C7** seeds the contract per archetype (`statistical` for *Particle system* / *Flocking*),
  which is exactly the inference this phase encodes — the field and its default are in place.
- The Overseer's own `seedPolicy` and the contract are now adjacent concepts stated in two
  places (the Overseer config block and the Execution radio). A later pass could show the
  contract chip inside the Overseer block too; the string is already shared.
- C4's noted *Skip Isolated Empty Cells vs Auto* question is untouched — a contract-aware Auto
  could weigh it, but sparse stepping is a **fast path** (Class F), not a reproducibility
  concern, so it does not belong to this contract.

---

## §C6 — Schema hygiene + vocabulary + loud fallbacks (P5 + P4 completion)

**Goal**: one mechanism per concept; every silent demotion becomes loud.

Deliverables:
1. **Capability profile authoritative**: verify LOAD_MODEL always seeds
   `agentCapabilities` and SAVE always writes it; the resolvers' legacy fallback arms
   (`usesBondingPhysics ?? !customForcesOnly`) remain for hand-edited files but emit a C3
   diagnostics event when they actually fire ("legacy physics flags in effect — resave to
   bake the capability profile"). Stop writing `customForcesOnly` on save if any path
   still does (verify by grep + round-trip test); document the removal schedule for the
   legacy reads in CLAUDE.md.
2. **Update-mode vocabulary**: both radios (grid `updateMode`, `agentUpdateMode`) gain
   the doctrine subtitles — "Synchronous *(parallel — runs on all engines)*" /
   "Asynchronous *(sequential — CPU engines only)*" — and the reject texts in gates/
   readout use the same words.
3. **Loud fallbacks, UI side** (C3 built the worker log): every runtime fallback event
   surfaces as a one-time amber toast (the `showAgentNotice` pattern, de-duped per event
   text) + persists in the diagnostics Events list + keeps the chip amber while
   resolved≠requested. Compile-time gate clamps show in the C1 readout only (no toast).
4. Docs sweep per §1.

Verification: tsc/build; compile-identity 100%; parity + gate harnesses green (resolver
logic untouched — only event emission added); in-browser: force each fallback → exactly
one toast + Events row + amber chip; a hand-stripped legacy-flag file fires the "resave to
bake" event; after resave it is gone.

### Completion Report — C6 (2026-08-03)

**Status: DONE.** Feature commit: **`1bc1465`** *feat(clarity): schema hygiene +
update-mode vocabulary + loud fallbacks (C6)* on `GRA` (this report rides the follow-up
docs commit, as C1–C5 did). Not pushed, no version bump, no attribution lines. Plan +
illustrated mockup: [PLAN_CLARITY_C6.md](PLAN_CLARITY_C6.md) / `.html`.

**Mockup judgment (§1.4 asks for it either way):** two deliverables are copy-only and
would be exempt; the third changes an observable behaviour on a shared surface (a
fallback stops painting the red banner and becomes an amber toast), so a small
before/after mockup was produced.

#### What shipped

1. **The capability profile is authoritative — each half VERIFIED, not assumed.**
   - **LOAD always seeds it.** `LOAD_MODEL` calls `migrateAgentCapabilities`
     unconditionally, and the earlier guard `if (topologyMode.agents && !centerBased)
     centerBased = defaultCenterBasedConfig()` guarantees the object it seeds into
     exists. The **viewer** goes through the same reducer (`ViewerApp` → `loadModel`),
     so an exported presentation is covered.
   - **SAVE always writes it.** `serializeModel` → `stringifyCompact` is a whole-object
     walker with no field picking; `withResolvedEngine` spreads `centerBased`.
   - **No `src/` path writes `customForcesOnly`** — it is read exactly ONCE, in
     `usesBondingPhysics`. Only the generator scripts still emit it into the fixtures
     they author; left alone (shipped configs are deliberate, and the field is inert
     once a profile is present). Now gate-asserted.
   - **`legacyPhysicsFlagsInEffect(cfg)`** ([centerBased.ts](../src/model/centerBased.ts))
     is the observation seam: the **exact union of the two fallback conditions, derived
     from the same field tests** — `!agentCapabilities` (what `usesEngineSprings` /
     `usesEngineGrowth` branch on, per OBJECT) OR `collision` not one of the three
     literals (what `collisionMode` branches on, per FIELD). `usesBondingPhysics` is
     deliberately EXCLUDED: it has no capability control, so it is not a fallback but
     the only mechanism. The worker calls it once per worker
     (`checkLegacyPhysicsFlags`, latched, after `centerBasedConfig` is assigned in
     `init` AND `recompile`) and emits the C3 event. **Zero resolver logic touched.**
2. **A real hole this closed (a finding, not a planned deliverable).** A **PARTIAL**
   profile (`{ motion: 'force' }`) is truthy, so the old migration early-returned and
   let it through — and `collisionMode`, which falls back per FIELD, then silently
   resolved that model's collision from the legacy flags. Worse, `serializeModel` wrote
   the partial profile straight back, so the event's own advice ("re-save to bake the
   profile") would **not** have fixed it. `migrateAgentCapabilities` now COMPLETES an
   existing profile from the SAME inference the absent case uses, explicit keys winning
   — **behaviour-preserving by construction** (for a complete profile every inferred key
   is overwritten; the only key the shipped library omits is the net-new `charge`, which
   inference sets to `'off'`, already what `usesCharge`'s strict `=== 'on'` resolves).
   Confirmed by measurement first: across the 8 shipped models with an explicit profile,
   the closure's only delta was `charge:'off'`.
3. **Update-mode vocabulary** — both radios carry Principle 1's words; reject texts
   realigned in `detectWebGPUModelIncompatibilities` (the sentence C1's readout shows)
   and the WebGPU grid engine hint; the agent sync hint dropped its stale *"required by
   the forthcoming WebGPU agent target"*.
4. **Loud fallbacks, UI side** — `postFallback` posts `{ …, fallback: true, gen }`; the
   main thread splits the `error` branch into a de-duplicated one-time amber toast +
   `runtimeFallbackCount` (which keeps the ⚙ chip amber, with the count in the tooltip)
   versus the unchanged red banner. `pendingStep.current = false` runs in BOTH branches.
   Both reset on `modelVersion`. The shared-GPU event sink is promoted to `postFallback`.

#### Deviations / decisions (documented, no scope cuts)

1. **The agent radio's Asynchronous subtitle is NOT the runbook's verbatim text.**
   *"(sequential — CPU engines only)"* is exactly right for the grid (WebGPU rejects
   async at the model level) but **FALSE for agents**: `Morphogenesis - Growing Tissue`
   ships async agents ON WebGPU. What the parallel GPU cannot honour is a cross-agent
   OVERWRITE (`isAgentGraphWebGPUSupported` rejects precisely that), so the subtitle
   reads *"(sequential — a cross-agent write needs a CPU engine)"* — same vocabulary,
   true consequence.
2. **The per-node texts in `detectWebGPUIncompatibilities` were left unchanged.** They
   are CAPTURED by `check-compile-identity` as `webgpu.error` (Amphiphile,
   Chromatography, gas_particles carry them in the baseline), so rewording them would
   fail the byte-identity gate for a cosmetic gain — and they already carry the doctrine
   (*"WebGPU runs cells in parallel; …"*). **General rule now recorded in CLAUDE.md: a
   compiler-visible error STRING is a captured surface — treat it like emitted code.**
3. **`webgpuGridFailed`'s "shader not produced" arm stays log-only**, honouring C3's
   deliberate choice (the compiler already reports that reason through the
   compile-error path; a second toast would double-report).
4. **The legacy-flags event is a TRIPWIRE, not a routine notice.** Because deliverable 2
   closed the partial-profile hole, no app path can now reach the engine profileless —
   which is the P5 goal. The seam remains as the guard that fires if a future path
   regresses, and is verified by stripping the profile at the worker boundary (below).
5. **`usesBondingPhysics` is NOT on the removal list** — it is still the only control
   for adhesion `μ_A`. The three divergent fallback predicates in `centerBased.ts` were
   deliberately NOT unified (that would change resolution for partial profiles and the
   byte-identity gate forbids it); the divergence is recorded in CLAUDE.md so the
   removal phase unifies them on purpose.

#### Verification evidence (real numbers / observations)

**Gates** — `npx tsc -p tsconfig.app.json --noEmit` clean; `npm run build` clean;
`check-compile-identity --compare` → **"BYTE-IDENTITY OK — 29 models, all surfaces
unchanged"** (re-run after EVERY step, including the migration change);
`parity-agent-wasm` → **ALL AGENT SAMPLES: JS↔WASM BIT-PARITY ✓**; `parity-agent-force`
→ **20 checks ✓**; `check-agent-wasm-gate` → **GATE✓ COMPILE✓ INST✓**;
`verify-agent-render` ✓; `verify-render-uniform-layouts` ✓; `test-engine-resolve` →
**719 passed, 6 negative controls caught**; `test-generation-pipeline` → **3400 passed,
6 caught**; `test-agent-abi` → 28 ✓; `audit-agent-layout` ✓; `gen-capability-docs
--check` green.

**`test-agent-capabilities` grew 76 → 202 checks** with the new §8 authority section, and
**both of its negative controls are proven by SOURCE MUTATION**: making
`legacyPhysicsFlagsInEffect` always-false → **15 failures** naming every NEG check;
adding `customForcesOnly:` to `defaultCenterBasedConfig` → the write guard fails naming
the exact file and line. Both reverted; 202/202 after.

**In-browser** (dev server, real library models, real worker messages). The Browser pane
reports `document.hidden === true` (the documented occluded-pane trap), so evidence is
DOM + worker protocol, which is the right evidence for a text/DOM + protocol feature.
**0 console errors** across the whole session (fresh `console.error` hook).
- **Both radio subtitles render** (Ant Necrophoresis, a grid+agents model, so both are
  present): grid → `Synchronous (parallel — runs on all engines)` /
  `Asynchronous (sequential — CPU engines only)`; agents →
  `Synchronous (parallel — runs on all engines)` /
  `Asynchronous (sequential — a cross-agent write needs a CPU engine)`. The WebGPU
  engine hint reads *"Runs parallel rules only, so it needs Synchronous update mode"*.
- **A REAL fallback, end to end** (Amphiphile with the WebGPU engine — an async model, a
  user-reachable configuration): the worker posted `fallback: true`, an **amber toast
  appeared** (captured by a MutationObserver: `⚠ [webgpu] compile failed: Asynchronous
  is the SEQUENTIAL update mode…` — the realigned doctrine text), the chip turned amber
  (`⚙ JS⚠`, `rgb(224,160,80)`) with *"⚠ 1 runtime fallback this session"* in its tooltip,
  and the popover's **Events** row carried it.
- **De-duplication + distinctness** (six further messages, verbatim from real
  `postFallback` sites, delivered through the live worker's message channel): sampling
  the live toast text — *before* any → `null`; after message C → the C toast; 4 s later →
  `null` (auto-dismissed); **re-posting C → `null` (no re-toast)**; a distinct message D
  → the D toast. The chip counter moved `1 → 3 → 5 → 7` for distinct messages and **did
  not move for either repeat**.
- **The legacy-flags seam fires** — the profile stripped from the OUTGOING worker payload
  (exactly the seam's boundary; everything downstream is the real worker + real
  handler): the worker posted *"[agents] legacy physics flags in effect — … Re-save the
  model to bake the profile."*, the chip went amber (`⚙ agents WebGPU⚠`), and the Events
  row shows it. **And it is gone once the profile is present**: reloading the same model
  normally gives **0 fallbacks**, a neutral grey chip (`rgba(128,144,160,0.7)`) and no
  fallback line in the tooltip — the non-regression that matters, since `Morphogenesis -
  Growing Tissue` is one of the 6 shipped agent models with NO `agentCapabilities` on
  disk.
- **A compile-time / model-level clamp shows amber but never toasts** (a C5 contract
  violation: Exact + the WebGPU agent engine): `⚙ agents WebGPU⚠` amber with the
  contract line in the tooltip, **0 fallback posts, no toast**, no "runtime fallback"
  line — the runbook's "no toast for compile-time clamps" rule, observed.

#### Follow-ups for later phases (not defects)

- **The removal schedule is now written down in CLAUDE.md.** The `?? legacy` arms are
  deletable one release after the shipped generators emit `agentCapabilities` (6 of 14
  agent models still rely on load-time inference). Doing so should also unify the three
  divergent fallback predicates in `centerBased.ts`, deliberately.
- **An Adhesion capability** would let `useBondingPhysics` join the removal list; today
  it is the only control for `μ_A`.
- The worker's `legacyPhysicsNoticeSent` latch is per-WORKER (C3's Events log has the
  same scope), so a full reinit can re-post the notice; the main-thread per-message
  de-dupe absorbs it, so the user still sees exactly one toast. Observed: 2 worker posts
  → chip count 1.

---

## §C7 — Archetype-first New Model (P6) + determinism (P7)

**Goal**: the combinatorial space becomes navigable by intent at creation time; seeding is
reproducible by default.

Deliverables:
1. **New Model chooser**: File → New opens a dialog with archetype cards: *Classic CA
   (2D)*, *3D CA*, *Particle system*, *Flocking*, *Bonded tissue / morphogenesis*, *Graph
   automaton (GRA)*, *CA-on-agents*, *Empty*. Each seeds: topology, dimension, capability
   preset (`AGENT_PRESETS` where applicable), engine `auto`, contract (`exact`, except
   *Particle system* + *Flocking* seed `statistical` — the GPU-population archetypes).
   Esc / *Empty* = today's behaviour. Unsaved-changes confirm flow unchanged.
   Plan + mockup per §1.
2. **P7 seeded scatter**: `seedPattern: 'scatter'` (and ANY other `Math.random()` in
   engine seeding/sim-semantic paths — sweep the worker + agentEngine) draws from the
   seeded shared stream, so Reset reproduces exactly on CPU engines. Document the
   behaviour change (scatter layouts differ once vs pre-change; they were never
   reproducible before). Add a grep gate script (allowlist: id generation, UI-only).
3. Docs sweep per §1.

Verification: tsc/build; compile-identity 100%; parity harnesses green (they seed
explicitly — confirm unaffected); in-browser: each archetype creates the expected config
(assert via the C1/C2 panels); a scatter model: two Resets at a fixed seed → IDENTICAL
initial positions (worker readback), `setRngSeed` pins them; grep gate green.

### Completion Report — C7 (2026-08-03)

**Status: DONE.** Commit **`02ad2ec`** *feat(clarity): archetype-first New Model + seeded
engine draws (C7)* on `GRA` (feature + docs in one commit; this report rides the follow-up
docs commit, as C1–C6 did). Not pushed, no version bump, no attribution lines. Plan +
illustrated mockup: [PLAN_CLARITY_C7.md](PLAN_CLARITY_C7.md) / `.html`.

#### What shipped

1. **P6 — the New Model chooser** ([archetypes.ts](../src/model/archetypes.ts) +
   [NewModelDialog.tsx](../src/components/NewModelDialog.tsx)). Eight cards; each seeds
   topology, dimension, the agent capability profile, `engine: 'auto'` and the contract.
   **No new schema** — `NEW_MODEL` gained an optional `seed: CAModel` (absent ⇒
   `EMPTY_MODEL`) and `newModel(seed?)` carries it. `buildArchetypeModel('empty')` returns
   `EMPTY_MODEL` **itself** (object identity), so today's New is one click away and is what
   the gate asserts.
2. **P7 — `nextRandom()`** replaced `Math.random()` at the three sim-semantic worker sites:
   `initAgents`' scatter placement, `initGrid`'s cyclic order shuffle, and `runStep`'s
   per-step `random-order` / `random-independent` order. Plus the `rngCellView` lockstep
   below.
3. **`scripts/check-no-unseeded-random.mjs`** — allowlist-with-a-reason grep gate, which
   ALSO fails on a **stale** allowlist entry (a file with no draw left silently protects a
   future one).
4. **`scripts/test-archetypes.mjs`** (201 checks) — the P6 drift guard.
5. **Docs sweep**: CLAUDE.md (new C7 section + Project-Structure tree + the state-management
   bullet + **two now-false claims corrected**, see below), HelpView (a "Starting a model —
   the archetype chooser" section under The Modeler, a "What a seed actually pins" section
   under Bond-Graph Agents, and the stale Overseer scatter caveat rewritten), README (the
   New-model bullet, the async update-schemes bullet, the agent config-panel bullet).

#### THE FINDING — there are TWO RNG cells, and the naive P7 fix was a silent no-op on WASM

The JS-compiled step reads/writes the module-level `rngState`; the **WASM**-compiled step
loads/stores its own `_rs` in `wasmMemory` at `layout.rngStateOffset`. They were synced only
at `initGrid` and by `setRngSeed`. A `nextRandom()` that touched only `rngState` therefore
advanced a stream **nothing else consumed** on a WASM-target model — the shuffle looked
seeded and was not.

Measured directly with a temporary worker probe (added, used, removed): after
`setRngSeed(4242)` + one step, `js = 3748443150` while `wasm` was **still `4242`**. The fix:
`nextRandom()` READS whichever cell the ACTIVE engine advances (`rngCellView && wasmStepFn` ⇒
the WASM cell, else `rngState`) and WRITES **both** — the discipline `setRngSeed` already
used. `initGrid` also now publishes the seed to the WASM cell **after** the order block, so
the cyclic shuffle's draws are not left stale for the Init Event that runs next.

**Verification lesson worth keeping**: the async order shuffle is **in place over the running
permutation**, so two shuffles taken at different points in a session have different INPUTS —
comparing them proves nothing about the seed. The decisive test is predicting the result.

#### Deviations / decisions (documented, no scope cuts)

1. **The GRA card seeds a CUSTOM profile, not `AGENT_PRESETS.socialGraph`** (the runbook
   suggested "Social Graph or the closest bonds-data profile"). Audited: both shipped GRA
   flagships (`Cubic GRA`, `SDCA`) run `motion:force · body · collision:soft · bonds:physics
   · charge:ON · sensing` (and `division:false` — their split is Create Agent + Rewire).
   `socialGraph` is `static / no body / bonds:data / charge:off`, i.e. **no layout at all**:
   a graph seeded from it renders as a pile and the entire L1 charge force is off. No shipped
   GRA model uses it. `GRA_PROFILE` deep-equals no named preset, so the picker reads
   **Custom** — exactly what those two flagships read today. Adding a 7th preset was
   considered and rejected (a shared table feeding the Properties picker +
   `test-agent-capabilities`; re-labelling two shipped models is outside C7's scope).
2. **The async order shuffle is IN SCOPE and was seeded**, not just scatter. §C7 says "ANY
   other `Math.random()` in engine seeding/sim-semantic paths", and P7's own claim ("Reset
   reproduces exactly on the CPU engines") is FALSE for every asynchronous model while the
   visit order is unseeded. Behaviour change documented: async trajectories differ once; they
   were never reproducible before.
3. **The session seed stays `Date.now()`-derived and Reset does not re-seed.** A constant
   session seed would make every user's first run of every stochastic model identical — a far
   larger change than P7 asks for. And Reset re-rolling matches the *documented* behaviour of
   the cell Init Event's `getRandom`; agent scatter now MATCHES the cell side instead of
   contradicting it. Pinning is `setRngSeed` then Reset — the Overseer's own protocol.
4. **`useBondingPhysics` is DERIVED** from the seeded profile
   (`collision !== 'off' || bonds === 'physics' || growth`) rather than typed in beside it: it
   is the panel's progressive-disclosure switch while the ENGINE is profile-driven, and
   seeding them independently is how they drift. Gate-asserted per card.
5. **A C1 defect this feature made prominent, fixed here** (scope expansion, deliberate): an
   agent graph with **no behaviour root yet** — the state EVERY freshly created agent model is
   in — made both gates early-out, and C1's fall-through then invented a
   capacity/fundamentals blocker ("too many simultaneous Get-Nearby-Agents producers"). Both
   the Compatibility readout and the Agent Engine hints now name the real cause. Mirrors
   `isAgentGraphWasmSupported`'s own early-out (incl. the `periodicStep` arm).
6. **Card names are seeded** ("Untitled Flocking Model", …). It is the standard
   new-from-template behaviour and it is the only visible effect the *Classic CA (2D)* card
   would otherwise have (its config is identical to Empty — the empty model IS a 2D grid CA).
   `Empty` keeps `EMPTY_MODEL`'s "Untitled Model" exactly.
7. **Two now-false claims in CLAUDE.md were corrected, not left standing**: the GRA-sample
   note that "`seedPattern: 'scatter'` places seeds with `Math.random()` … deliberately", and
   the SDCA note that scatter "sits outside the replayable stream". Both now state the C7
   fix while preserving the reasoning that still matters (a degree-reading rule is
   geometry-coupled, so `compact` remains the simplest thing to sweep over). Help's Overseer
   caveat likewise.

#### Verification evidence (real numbers / observations)

**Gates** — `npx tsc -p tsconfig.app.json --noEmit` clean; `npm run build` clean;
`check-compile-identity --compare` → **"BYTE-IDENTITY OK — 29 models, all surfaces
unchanged"** (re-run after the P6 change, after the P7 change, and after the `nextRandom`
lockstep fix); `test-archetypes` **201 ✓**; `check-no-unseeded-random` **OK (32 allowlisted
draws in 13 files)**; `parity-agent-wasm` → **ALL AGENT SAMPLES: JS↔WASM BIT-PARITY ✓**;
`parity-agent-force` **20 ✓**; `check-agent-wasm-gate` **GATE✓ COMPILE✓ INST✓**;
`verify-agent-render` ✓; `test-engine-resolve` **719 passed, 6 negative controls caught**;
`test-generation-pipeline` **3400 passed, 6 caught**; `test-agent-capabilities` **202 ✓**;
`gen-capability-docs --check` green.

**Negative controls, by SOURCE MUTATION** (applied, observed, reverted): dropping the tissue
card's `maxBonds` → `test-archetypes` fails with `tissue: bond store allocated
(resolveMaxBonds 0)` — the exact silent failure the gate exists for. Putting a
`Math.random()` back in the worker's order shuffle → the grep gate fails naming
`sim.worker.ts:4326`. Adding a bogus allowlist entry → the stale-entry check fails naming it.

**In-browser** (dev server, real worker; the pane reports `document.hidden === true` — the
documented occluded-pane trap — so evidence is DOM + worker protocol + worker-buffer
readback, which is the right evidence for a dialog + a seeding change). **0 console errors**
on a fresh load through a complete New → Bonded tissue flow (fresh `console.error` hook).

- **All 8 archetypes created through the real File ▾ → New → card → Create flow**, each
  asserted through the C1 Compatibility readout / C2 Generation Pipeline / the Properties
  fields: `Classic CA` 100×100 2D exact **Auto → WebGPU** · `3D CA` **50×50×50**, 3D radio
  checked, exact, Auto → WebGPU · `Particle system` 120×120, seed **300**, maxAgents 1000,
  maxBonds **0**, **Statistical**, **Scatter**, preset description = *Particle System*,
  Forces rows shown · `Flocking` 120×120, seed 260, **Statistical**, Scatter, preset =
  *Boids / Flocking*, Forces rows **hidden** · `Bonded tissue` 100×100, seed 12, maxBonds
  **8**, **auto-bond checked**, Compact, preset = *Morphogenesis / Cells* · `GRA` 200×200,
  seed 4, maxBonds 8, **Charge strength/cutoff rows present**, auto-bond off, preset =
  **Custom**, and the simulator readout showed **`● 4 agents`** (the seed reached the
  engine) · `CA on agents` 60×60, seed 256, preset = *CA on Agents*, `useBondingPhysics`
  checkbox **false** and no Forces rows (the derived rule, checked directly) · `Empty` →
  **"Untitled Model"**, no agent section, 100×100, exact.
- **The unsaved-changes flow**: with a dirty model, New raises *"Discard unsaved changes? …
  Create new"* verbatim; **Cancel keeps the model**; **accepting it opens the CHOOSER** (not
  a create), and **Esc-cancelling the chooser after accepting still keeps the model** — the
  documented semantic.
- **P7 scatter determinism, agent SoA read back from the worker** (Flocking archetype, 260
  agents): `setRngSeed(12345)` + Reset, three times interleaved with a different seed →
  **0 of 260 agents differ** each time (first agent `92.12488980777562, 47.84003277402371`,
  reproduced across a full page reload and the `nextRandom` fix); seed `999` → **all 260
  differ**. Element-wise at seed 777: `sameSeedDiffs 0 / 260`, and a Reset **without**
  re-seeding → `260 / 260` differ (the documented "Reset advances the stream").
- **P7 async order determinism — the decisive test** (gas_particles, async `random-order`,
  WASM target): all **10 000** entries of the worker's post-step order array are reproduced
  EXACTLY by an independent in-page re-implementation of xorshift32(13/17/5) + Fisher–Yates
  seeded with 4242 over the pre-step permutation — `firstDiff: -1`. The predicted RNG state
  after the shuffle, **3748443150**, equals what the worker reported. Before the lockstep
  fix, the same probe showed the WASM cell frozen at the seed while the JS cell advanced.
- **Help renders both new sections** and the stale scatter caveat is gone
  (`staleScatter: false`).

#### Follow-ups for later phases (not defects)

- **`src/simulator/engine/SimEngine.ts` is dead code** — imported by nothing (verified), and
  the only reason it needs an allowlist entry in the new gate. A deletion candidate for a
  future hygiene pass (it is named in CLAUDE.md's Project Structure tree).
- **A "Simulation seed" control** (P7's optional half) is NOT shipped: seeding is still
  reachable only through the Overseer's seed policy or a raw `setRngSeed`. Surfacing one
  control that unifies `setRngSeed` + table rolls + spawn would complete the reproducibility
  story in one place.
- **`Classic CA (2D)` and `Empty` differ only by name.** If a future phase wants starter
  CONTENT (a Moore neighbourhood + an `alive` attribute + a linked colour view), the card is
  the natural home; C7 deliberately seeded configuration only, per the runbook.

---

## §C8 — Presentational-geometry taint check + pipeline label (P9, detection only)

**Goal**: statically decide "does geometry ever feed model decisions?" and label the
pipeline accordingly. NO cadence/location decoupling this phase (explicitly out of scope).

Deliverables:
1. **`src/modeler/vpl/compiler/geometryTaint.ts`** (new, pure):
   `analyzeGeometryTaint(model) → { presentational: boolean, witness?: TaintPath }`.
   Geometry SOURCES: position/offset/velocity/curvature reads, proximity queries
   (getNearbyAgents, getAgentsInView, senseHemifield, neighbourDensity), field samples at
   position (sampleField, fieldGradient, readCellsUnder), `forEachBond.currentLength`;
   ENGINE-geometric config: `divideAgent` with `partition:'tension'` (geometry→topology)
   and auto-bond ON (geometry→topology ⇒ NOT presentational). Tainting SINKS: attribute
   writes, indicator writes, structural verbs whose flow-condition cone or target-id
   derivation is tainted, stop events, field deposits. Geometry→geometry-only paths
   (position writes, Apply Force, setVelocity, sprite rotation) do NOT taint (the
   Cubic-GRA-midpoint rule). Conservative propagation through the value DAG + flow
   conditions; unknown constructs/macros → taint. Cover all agent roots.
2. **Integration**: set C2's `PipelinePhase.presentation`; force/motion/layout phases
   render "*presentation only — does not affect your rule*" when presentational; C1
   readout gains the informational note. ZERO engine behaviour change.
3. **Harness**: `scripts/test-geometry-taint.mjs` loading the REAL shipped models,
   asserting verdicts against a HAND-AUDIT you perform and record in the report (do the
   audit first, then encode it). Expect e.g.: Cubic GRA / SDCA presentational (verify
   their configs: census over BONDED, no tension partition, no auto-bond); Life on Bonds
   TAINTED (auto-bond forms topology from distance); Chemotaxis / Ant / GoL-on-agents /
   Tissues tainted; Boids / Particle Life — audit their real graphs (sensing→force-only
   should be presentational) and assert whatever the audit finds. Print witness paths for
   tainted verdicts.
4. Docs sweep per §1.

Verification: tsc/build; compile-identity 100% (zero emit impact); harness green with
verdicts matching the recorded hand-audit; in-browser: label present on a presentational
model, absent on a tainted one.

### Completion Report — C8 (2026-08-03)

**Status: DONE.** Feature commit: **`fd7ec90`** *feat(clarity): presentational-geometry taint
check + pipeline label (C8)* on `GRA` (this report rides the follow-up docs commit, as C1/C2 did).
Not pushed, no version bump, no attribution lines. Plan + illustrated mockup:
[PLAN_CLARITY_C8.md](PLAN_CLARITY_C8.md) / `.html`.

#### What shipped

1. **`src/modeler/vpl/compiler/geometryTaint.ts`** (new, pure) —
   `analyzeGeometryTaint(model) → { applicable, presentational, witness?, witnesses[] }`.
   `applicable` is false for a grid-only model (no layout physics ⇒ the question is meaningless)
   and an inapplicable model is never `presentational`. The module header carries the full
   source / sink / exemption tables; the design points:
   - **The criterion is DATAFLOW TAINT**, evaluated as a **fixpoint over (value taint ⇄ flow-gate
     taint)** — necessary because a local variable written under a geometry-dependent branch is
     tainted even when the value itself is a constant.
   - **Port-level granularity**, not node-level: `forEachBond.currentLength` is a distance while
     `partnerId` out of the same node is topology; `behaviourStep.myX/Y/Z` are geometry while
     `myBondDegree` is not.
   - **THE CONSERVATIVE DEFAULT IS AN INVERSION**: the module allowlists the geometry-only sinks
     and pure control flow; **any other flow node taints**. A future state-writing node taints from
     the day it is added unless someone deliberately allowlists it. Same for an unexpandable macro.
   - **Local variables are CONDUITS, not sinks** (per-agent per-step scratch) — this is exactly
     what keeps Boids presentational: geometry → 7 accumulators → Apply Force.
   - **Engine-geometric config** comes from the engine's own resolvers — `usesEngineSprings ∧
     autoBond ∧ resolveMaxBonds > 0` (the same expression the pipeline panel uses) and
     `dividePartitionFromConfig(...).mode === 'tension'` on a **reachable** Divide Agent.
   - **Flattening** via `expandMacros` + `collapseReroutes` — the two structural transforms every
     compiler front-end runs first — so macro internals and reroute relays are analysed for real
     rather than treated as opaque. All **five** agent roots are walked.
   - **Witnesses are readable and classified** (`dataflow` | `condition` | `location` |
     `engine-config`); the first step names the PORT that made it geometry.
2. **`PipelinePhase.presentation`** — `describeGenerationPipeline` sets it on
   `PRESENTATION_PHASE_IDS` (force reset, charge, soft collision, springs, integrate, growth,
   positional projection). The **spatial hash is deliberately NOT a mover** — it is a query
   structure the RULE also reads.
3. **UI** — `PhaseRow` renders a green `presentation` chip (tooltip = the explainer) plus the
   italic *"presentation only — does not affect your rule"*; the pipeline legend gains an entry;
   `GeometryTaintNote` in the C1 Compatibility readout renders green **"Layout is presentation"**
   or grey **"Layout is part of your rule"** + the first witness. `PRESENTATION_ONLY_LABEL` /
   `PRESENTATION_ONLY_EXPLAINER` / `GEOMETRY_PROMOTED_EXPLAINER` are exported so the UI, Help and
   the harness share one string.
4. **`scripts/test-geometry-taint.mjs`** — 210 checks (below).
5. **Docs sweep** — a CLAUDE.md section, a Help section *"Is the layout part of your rule, or just
   how it looks?"*, a README bullet.

#### THE HAND-AUDIT (performed BEFORE the analyzer was written; it is what the harness encodes)

Method: a throwaway dumper over `migrateForHarness(model)` printed every shipped agent model's
node-type census, its full labelled edge list, its non-empty node configs, and the resolved
`autoBond` / `resolveMaxBonds` / `dividePartitionTableForModel`. Each model was then read by hand
against the criterion. 14 agent models; the other 15 shipped models are grid-only ⇒ inapplicable.

| Model | Verdict | Reason found by hand |
|---|---|---|
| Ant Necrophoresis | **tainted** | `Read Cells Under "corpse"` → expression → Value Switch → Compare → Logic gates the pick/drop that writes `carrying`; and `Affect Cells Under` deposits at the position |
| Boids — Flocking | **presentation** | `Get Nearby Agents` → For Each → `Get Agent Offset` / `Get Velocity` → 7 local variables → **`Apply Force` only** (no attribute write anywhere) |
| Boids — Hemifield Vision | **presentation** | `Get Agents In View` + `Sense Hemifield` ×2 → local variables → `Apply Force` ×2 |
| Chemotaxis — Aggregation | **tainted** | `Secrete To Field "chemical"` (deposit at the position); its `Field Gradient → Apply Force` half is clean |
| **Cubic GRA** | **tainted** | K4 bootstrap: `Get Nearby Agents` → `For Each.element` → **`Form Bond.targetAgent`**, gated on `myBondDegree == 0` |
| Game of Life on Agents | **tainted** | `Get Nearby Agents` → `Get Agents Attribute "alive"` → `Aggregate(sum)` → Compare/Logic → `Set Attribute "alive"` |
| Graph Metrics — Growth Sweep | **tainted** | `divideAgent` partition = `tension` (the rule itself reads only bond degree — topology) |
| Life on Bonds | **tainted** | **auto-bond alone** — the rule graph is entirely clean (census over BONDED, `total > 0` gate), but the engine builds the Moore ring by distance |
| Morphogenesis — 3D Tissue | **tainted** | auto-bond + tension partition + (`myRadius`, `Neighbour Density`) → conditional → `Divide Agent` |
| Morphogenesis — Differential Tissue | **tainted** | same three reasons |
| Morphogenesis — Growing Tissue | **tainted** | auto-bond + tension partition + `myRadius` → Compare → `Divide Agent` |
| Particle Life | **presentation** | `Get Nearby Agents` → offsets + a species `Table Lookup` → **`Apply Force` / `Set Velocity` only** |
| Particle Life 3D | **presentation** | same shape, 3D |
| **SDCA — Couplers and Decouplers** | **tainted** | the COUPLERS half: `Get Nearby Agents(couplingRadius)` → `For Each.element` → **`Form Bond.targetAgent`** |

**The analyzer reproduced all 14 verdicts on its first run**, and the witness it prints for each
tainted model is the same path the audit found.

#### ⚠ THE FINDING — Cubic GRA and SDCA are TAINTED, against the runbook's expectation

§C8 expected both to be presentational and named three things to verify. **All three check out**:
their `neighbourCensus` really is `source: 'bonded'`, neither has a `tension` partition (neither
has a Divide Agent at all), and `autoBond` is `false` on both. **But none of those three covers a
proximity-seeded Form Bond**, which both models have — and which is *geometry → topology* by the
runbook's own stated criterion (*"a Form Bond whose target came from getNearbyAgents = geometry →
topology ⇒ tainted"*). The runbook is internally inconsistent for these two models; per its own
instruction the audit wins.

**And the verdict is substantively right, not a technicality.** Cubic GRA's K4 bootstrap fires on
generation 1 while the four seeds are still settling; if the layout ticked on its own cadence, the
positions at bootstrap time would differ and the K4 could form differently (or incompletely).
SDCA's coupling *is* the Ilachinski–Halpern model — proximity decides which pairs may couple, which
is precisely why "where things sit" is load-bearing there. Granting either the P9 freedoms would
have been wrong.

Net effect: **4 of 14 shipped agent models are presentational**, so the feature is neither vacuous
nor universally true — which is the useful outcome.

#### Verification evidence (real numbers / observations)

**Gates** — `npx tsc -p tsconfig.app.json --noEmit` clean; `npm run build` clean;
`check-compile-identity --compare` → **"BYTE-IDENTITY OK — 29 models, all surfaces unchanged"**
(re-run after the docs sweep); `test-geometry-taint` **210 passed, 0 failed · 6 controls caught,
0 missed**; `test-generation-pipeline` **3401 passed, 0 failed · 6 caught, 0 missed`;
`test-engine-resolve` **719 passed, 0 failed`; `parity-agent-wasm` **JS↔WASM BIT-PARITY ✓**;
`check-agent-wasm-gate` GATE✓ COMPILE✓ INST✓; `verify-agent-render` ✓;
`test-agent-capabilities` **202 passed**; `test-archetypes` **201 passed**;
`check-no-unseeded-random` OK; `gen-capability-docs --check` up to date.

**The read-only guarantee is structural**: `git show --stat fd7ec90` touches only `CLAUDE.md`,
`README.md`, `HelpView.tsx`, `PropertiesPanelContent.tsx`, `generationPipeline.ts`,
`test-generation-pipeline.mjs` + the four new files. **No engine, compiler or worker file was
opened for writing.**

**THE HARNESS CAN GENUINELY FAIL — proven by SOURCE MUTATION** (`--mutate`), five patches to
`geometryTaint.ts`, each applied and reverted:

| mutation | result |
|---|---|
| make every unknown flow node clean (drop the attribute-write sink) | **CAUGHT** — 18 failures |
| treat Apply Force as a tainting sink (break the closed-loop rule) | **CAUGHT** — 19 failures |
| drop the `createAgent.{x,y,z,radius}` exemption (break the Cubic-GRA-midpoint rule) | **CAUGHT** — 1 failure |
| ignore auto-bond | **CAUGHT** — 7 failures |
| make branch conditions never taint | **CAUGHT** — 6 failures |

**5 caught, 0 missed**; the suite is green again on the shipped source.

**In-browser** (dev server on :51730, real library models, real DOM + computed styles). The Browser
pane reports `document.hidden === true` — the documented occluded-pane trap — so screenshots are
unavailable and the evidence is DOM text and computed style, which is the right evidence for a
text/DOM feature. **0 console errors** across the whole session (fresh `console.error` hook after a
reload, per the documented persistent-buffer caveat), over 6 model loads.

- **Particle Life** (presentational) — **7 `presentation` chips** on exactly
  `[2 Reset force accumulators, 7 Long-range charge, 8 Soft-sphere collision, 9 Bond springs,
  10 Integrate & commit positions, 11 Growth ramp, 12 Positional collision projection]`, **7**
  occurrences of *"presentation only — does not affect your rule"*, the legend entry
  *"presentation = decides only where things sit"*, and the chip tooltip carrying the explainer.
  The C1 note reads **"Layout is presentation — No rule in this model reads geometry into a
  decision…"** with computed `border-color: rgba(92,191,122,.35)` / `background:
  rgba(92,191,122,.08)` (the green, informative styling).
- **Boids — Flocking** (presentational) — 7 chips, 7 labels, the same green note.
- **Morphogenesis — Growing Tissue** (tainted) — **0 chips, 0 labels, no legend entry**, and the
  note reads **"Layout is part of your rule — …"** with computed `border-color: rgb(42,46,54)` /
  `background: rgba(255,255,255,.03)` (grey, NOT amber — the promotion framing), followed by
  *"e.g. Auto-bond forms and breaks bonds BY DISTANCE — the topology your rule reads is built from
  where agents sit."*
- **Cubic GRA** and **SDCA** (tainted) — 0 chips, 0 labels, and both carry the witness
  *"Get Nearby Agents · agents → For Each In Array → Form Bond · targetAgent"* — the in-app
  confirmation of the finding above.
- **Help** — the new *"Is the layout part of your rule, or just how it looks?"* section renders
  under *What runs each generation*.

#### Deviations / decisions (documented, no scope cuts)

1. **RADIUS is a gated addition to the runbook's source list.** `getRadius` / `getAgentRadius` /
   `behaviourStep.myRadius|myArea` / `divisionEvent.myArea` count as geometry **iff
   `usesEngineGrowth(cfg) && growthRate > 0`** — because the growth ramp writes the radius INSIDE
   the force-iteration loop (C2 puts `agent.growth` in the `forces` group), i.e. inside the very
   block P9 decouples; with growth off the radius only changes when the graph writes it, so
   reading it is an ordinary state read. Resolver-driven, so it cannot drift. **It changes no
   shipped verdict** (the three tissues that read `myRadius` are tainted twice over anyway) — it
   is there so the criterion is right, not to move an answer.
2. **Macros are ANALYSED, not blanket-tainted.** §C8 says "unknown constructs/macros → taint";
   since `expandMacros` is available and is what the compilers themselves run, flattening is
   strictly more precise AND still conservative. A macro that *cannot* be expanded (recursion
   depth, missing definition) does taint, with a witness saying so.
3. **The verdict is a three-state answer, not a boolean**: `applicable` distinguishes "the layout
   is presentation" from "this model has no layout". A grid-only model reporting
   `presentational: true` would have been vacuously true and misleading in the UI.
4. **Field deposits taint UNCONDITIONALLY**, on their LOCATION rather than their value — their own
   witness class (`location`). A constant-valued `Secrete To Field` still makes which cells change
   depend on where the agent is, and the cell rule then reads those cells.
5. **The cell graph is deliberately not walked**, with the reason stated in the module header: a
   lattice cell's position is fixed, so no cell node is a geometry source, and the one coupling
   (the field bridge) is caught at the deposit on the agent side before it becomes cell state.
6. **The in-browser presentational model is Particle Life / Boids, not Cubic GRA or SDCA** — the
   runbook's suggested subjects turned out tainted (the finding above), so the label had to be
   demonstrated on a model that actually earns it. Both directions are shown on five models.
7. **A full interaction mockup was judged unwarranted** and the judgment is recorded in
   §5 of the plan doc: the change is two text additions (a chip + a note) inside two blocks that
   already shipped with their own illustrated mockups, with no new panel, control, interaction or
   layout. `PLAN_CLARITY_C8.html` therefore shows the before/after rows and the criterion rather
   than a panel walkthrough.
8. **C2's harness assertion was updated, not deleted**: *"C2 never sets `presentation`"* became
   *"only the force/motion/layout phases may carry `presentation`"* plus *"cell / colour / init
   phases are never `presentation`"* — so the field stays pinned to the mover set.

#### Follow-ups for later phases (not defects)

- **The freedoms themselves are unbuilt.** C8 only detects. Ticking the layout on its own cadence
  or keeping it GPU-side with no readback is later work, and it now has a machine-checkable
  precondition plus a per-model answer to gate on.
- **The P9 explicit-consent door** (a position-reading model opting into the freedoms knowingly)
  is deliberately absent per the runbook's autonomy note. When it lands it should read off
  `witnesses` so the consent dialog can name exactly what the user is waiving.
- **A "near-miss" readout** — "this model would be presentational but for auto-bond" — would be a
  cheap, high-value addition for the tissue class, since `witnesses` already carries every reason
  separately.
- **C9's Static integrator interacts with this**: a `motion: 'static'` model has no layout physics
  to speak of, so `PRESENTATION_PHASE_IDS` may want to fold into whatever C9 does to those rows.

---

## §C9 — Capability STEP 4/6: Static motion integrator + SoA field gating

**Goal**: complete the explicitness program's engine half — "nothing moves unless asked",
and profile-gated SoA fields stop charging memory for off capabilities. This is the
deferred-XL item; treat it with full engine-change discipline. Write the impact-map
section FIRST (inside your plan doc), per the house rule.

Scope + order:
1. **STEP 4 (SoA field gating)** first — the `field.gate(profile)` hook exists in
   agentAbi.ts. Gate the Sprite block / Lifespan(`age`) / Growth(`targetRadius`) /
   Collision(`density`) fields on their capabilities — but WIDEN each gate by actual
   usage (a node or engine phase that reads the field keeps it allocated; e.g. `density`
   stays whenever collision OR division OR a neighbourDensity node needs it). THE SAFETY
   CATCH: a compiled read of a dropped field must emit the typed default (0) on ALL THREE
   agent targets — implement that first, then gate. Layout lockstep: every mirror
   (compile params ↔ worker args ↔ parity harness ↔ WASM layout ↔ WebGPU layout) moves
   together; extend `audit-agent-layout.mjs` to the gated matrix.
2. **STEP 6 (Static integrator)**: `motion:'static'` skips force integration entirely on
   all three targets (JS both arms; WASM via an APPENDED forcePass param — respect the
   conditional-arity contract; WebGPU via a ForceControl flag + the uniform-layout
   harness); `motion:'velocity'` integrates velocity but seeds no forces. Positions stay
   writable via Set Agent Position; sprite advance + structural phase unaffected.
   Byte-identity for every `motion:'force'` model.
3. Full harness sweep: parity-agent-wasm (+ a new static/velocity synthetic),
   parity-agent-force, audit-agent-layout, test-agent-abi, check-agent-wasm-gate,
   verify-agent-render, verify-render-uniform-layouts, compile-identity (only
   deliberately-changed surfaces may move — enumerate + justify each in the report).
   In-browser: all 9+ agent samples behave unchanged; a static synthetic skips the force
   pass (C3 diagnostics row shows it; measure the per-gen delta).
4. Docs sweep incl. rewriting the CLAUDE.md STEP 4/6 "deferred" sections.

### Completion Report — C9 (2026-08-03)

**Status: DONE.** Feature commit: **`b1279da`** *feat(clarity): profile-gated agent SoA
fields + the Static integrator (C9)* on `GRA` (this report rides the follow-up docs commit,
as C1–C8 did). Not pushed, no version bump, no attribution lines. Plan + **impact map**
(written first, per the house rule for engine-layout changes):
[PLAN_CLARITY_C9.md](PLAN_CLARITY_C9.md).

#### What shipped

1. **`src/model/agentFieldGating.ts`** (new, pure) — the ONE source for BOTH halves:
   `resolveAgentFieldGates(model)` (which optional per-agent fields exist) and
   `agentMotionMode` / `motionIntegrates` / `motionAppliesForces` / `motionModeCode`.
2. **STEP 4 — four optional field groups gated by CAPABILITY *or USAGE***: `sprites`
   (36 B/agent; the only group with no baked byte on any target — plain JS arrays),
   `age`, `targetRadius`, `density` (8 B each).
   - **THE SAFETY CATCH is one uniform representation: a dropped field is a ZERO-LENGTH
     typed array, never `undefined`.** On a zero-length `TypedArray` `a[i] = v` is a
     **silent no-op**, so every engine WRITE (`initAgentSlot`, `divideAgent`'s daughter
     seeding, `paintAgents`, and `deserializeAgentStore`'s `copyInto`, which already clamps
     to `min(dst, src)`) needs **no guard at all**. Only READS do, and all three agent
     compilers emit the typed default for them — JS via `ctx.agentGates` (the node emitters
     + the `behaviourStep.myAge` preamble), WASM via `ctx.layout.f64[f] === undefined`
     (`gatedF64Read`; the writes are skipped), WebGPU via `hasF32` / `gatedF32`. The catch
     was built and gate-tested BEFORE any field was dropped, per the runbook order.
   - **Usage widening**: `age` = `lifespan || getAge || a WIRED behaviourStep.myAge`;
     `targetRadius` = `growth || usesEngineGrowth(cfg) || setTargetRadius || setAgentRadius`;
     `density` = **deliberately the neighbour-SCAN predicate** (`neighbourDensity ||
     divideAgent || usesSoftCollision || usesBondingPhysics || usesCharge`), because that
     scan is the field's only writer, so density-off means the scan never runs and nothing
     writes it on any target; `sprites` = `model.sprites.length > 0 || setAgentSprite`.
   - **The lockstep**: the resolved record is **SHIPPED** on the init/recompile message as
     `agentFieldGates` (the `agentBondReqSlots` precedent) into
     `createAgentStore({ fieldGates })` and onto `store.fieldGates`, and
     `computeAgentMemoryLayout` reads it off `AgentLayoutExtras.fieldGates` (filled by
     `buildAgentLayoutExtras` from the same resolver). It is also in `needsFullInit` — the
     gates decide byte offsets, so a change is structural.
3. **STEP 6 — `Motion: Static | Velocity | Force` drives the ENGINE on all three targets.**
   Force = the historical integrator byte-for-byte; Velocity advances `x += v` with the
   velocity the graph SET and seeds no engine force (so `Set Velocity` genuinely coasts);
   Static moves nothing — the force accumulation, the integrate block **and the position
   commit** are all skipped. WASM emits one of three **compile-time** variants
   (`emitForcePass(…, motionMode)`); WebGPU gates at runtime on a new
   `ForceControl.motionMode` (appended last, `FORCE_CONTROL_BYTES` unchanged); the resident
   `posCommit` is compiled for the mode (Static writes `xNext = x`), and the per-gen GPU path
   refreshes `s.xNext` from the live `s.x` before the upload so the readback commit is an
   identity.
4. **C2 pipeline integration** — `Reset force accumulators` is off unless Motion = Force;
   `Integrate & commit positions` is off under Static with the detail *"nothing moves —
   positions change only when your graph writes them"* (Velocity shows `x += v`).
5. **`scripts/test-c9-gates.mjs`** (new, 413 checks) + the docs sweep (CLAUDE.md's STEP 4/6
   "deferred" section rewritten as DONE, HelpView, README, and a status banner on
   `HANDOFF_AGENT_CAPABILITY_PROFILES.md`).

#### ⚠ THE HAZARD THE RUNBOOK DID NOT NAME — and the bug verification caught

- **`Ant Necrophoresis` SHIPS `motion: 'static'`** and moves its ants with `Set Agent
  Position`. CLAUDE.md's own Ant section recorded that its inert force pass **"MUST run"**,
  because `swapPositions` copies `xNext` over `x` every step. So the naive "skip the force
  pass under Static" would have **reverted every graph position write** and frozen the model.
  The force pass and the position commit are therefore skipped **together**, on all three
  targets — that coupling is the load-bearing design decision of STEP 6.
- **A real ABI desync, found by in-browser verification, not by any harness.** The gates ride
  `AgentAbiShape`, and the worker's `agentAbiShapeOfStore` was missing `gates` — so the
  compiler built a SHORTER param list than the worker's arg list and every later arg shifted.
  Ant Necrophoresis' Agent Init Event died with *"Cannot read properties of undefined
  (reading '0')"* (`_rngState` off the end of the arg list) and zero agents spawned.
  **`audit-agent-layout` cannot catch this class** — it compares compile's params against the
  descriptor using the SAME shape, so a shape field missing at ONE site is invisible to it.
  Fixed, and pinned permanently by **tier D** of the new harness (a source invariant over all
  three shape builders).

#### Verification evidence (real numbers / observations)

**Gates** — `npx tsc -p tsconfig.app.json --noEmit` clean; `npm run build` clean;
`test-c9-gates` **413 passed, 0 failed**; `parity-agent-wasm` **ALL AGENT SAMPLES: JS↔WASM
BIT-PARITY ✓** (23 entries); `parity-agent-force` **✓ (20 checks)**; `check-agent-wasm-gate`
**GATE✓ COMPILE✓ INST✓** on every sample; `audit-agent-layout` **✓ (240 checks)**;
`test-agent-abi` **28 ✓**; `verify-agent-render` **✓**; `verify-render-uniform-layouts` **✓**
(the ForceControl writer vs its WGSL struct, with the new `motionMode`);
`test-generation-pipeline` **3401 passed · 6 controls caught**; `test-geometry-taint`
**210 ✓**; `test-engine-resolve` **719 ✓**; `test-agent-capabilities` **202 ✓**;
`test-bonds-allocation` **19 ✓**; `test-positional-collision` **6 ✓**;
`check-no-unseeded-random` OK; `gen-capability-docs --check` up to date.

**THE HARNESS CAN GENUINELY FAIL — proven by SOURCE MUTATION**: disabling the layout's gate
skip (`if (false && gk && !gates[gk]) continue;`) gave **38 failures**; forcing the WGSL
commit gate open (`if (true)` in place of `if (fc.motionMode != 0u)`) flipped the
emitted-shader check to false. Both reverted; green again on the shipped source.

**COMPILE-IDENTITY — 28 diffs, every one enumerated and deliberate.** They are exactly
`agent.behaviourCode` + `agent.wasm.bytes` for the **14 shipped agent models** — and nothing
else: **no grid surface (`js.stepCode` / `wasm.bytes` / `webgpu.shader`), no
`agent.webgpu.shader`, no overseer driver moved.** The cause is uniform and measured per
model:

| model | sprites | age | targetRadius | density | f64 B/agent reclaimed | motion |
|---|---|---|---|---|---|---|
| Ant Necrophoresis | ✗ | ✗ | ✗ | ✗ | 24 | **static** |
| Boids — Flocking | ✗ | ✗ | ✗ | ✗ | 24 | force |
| Boids — Hemifield Vision | ✗ | ✗ | ✗ | ✓ | 16 | force |
| Chemotaxis — Aggregation | ✗ | ✗ | ✗ | ✓ | 16 | force |
| Cubic GRA | ✗ | ✗ | ✗ | ✓ | 16 | force |
| Game of Life on Agents | ✗ | ✗ | ✗ | ✗ | 24 | **static** |
| Graph Metrics — Growth Sweep | ✗ | ✗ | ✗ | ✓ | 16 | force |
| Life on Bonds | ✗ | ✗ | ✗ | ✗ | 24 | force |
| Morphogenesis — 3D Tissue | ✗ | ✗ | ✓ | ✓ | 8 | force |
| Morphogenesis — Differential Tissue | ✗ | ✗ | ✓ | ✓ | 8 | force |
| Morphogenesis — Growing Tissue | ✗ | ✗ | ✓ | ✓ | 8 | force |
| Particle Life | ✗ | ✗ | ✗ | ✗ | 24 | force |
| Particle Life 3D | ✗ | ✗ | ✗ | ✗ | 24 | force |
| SDCA — Couplers and Decouplers | ✗ | ✗ | ✗ | ✓ | 16 | force |

**No shipped agent model has sprites**, so all 14 drop the 5 sprite ABI params (hence the
`behaviourCode` change), and all 14 drop at least one f64 field (hence the `wasm.bytes`
change: the baked offsets move). The three tissues keep `targetRadius` (Growth); the eight
models whose neighbour scan runs keep `density`. **Behaviour is preserved**: the gated-off
fields were provably unwritten (the scan predicate) or their consumer was already a no-op
(`growthRate === 0` makes the ramp `cur + sign(dd)·0 === cur` — the new `growthIter > 0`
guard is that condition made explicit). The one observable is that `age` freezes at 0 on
models that never read it, visible only in the agent inspector, which now reports the typed
default rather than `undefined`.

**In-browser (dev server, real library models, real worker).** The Browser pane reports
`document.hidden === true` — the documented occluded-pane trap — so the play loop is
suspended and screenshots are unavailable; steps were driven one-per-reply through
`window.__simWorker` and read back with `getState` / `getDiagnostics`, which is the right
evidence for an engine/ABI change. **0 console errors and 0 worker `error` messages across
the whole session** (fresh `console.error` hook after a reload, per the persistent-buffer
caveat).

- **Ant Necrophoresis (WASM agents, `motion: static`) — THE HAZARD MODEL.** 120 ants; over
  300 generations **114 of 120 moved**, i.e. the `Set Agent Position` writes survive the
  step, and **every position is still exactly integral** (`fractionalPos: 0` — the model's
  own discrete-cell invariant). The gated arrays are genuinely gone in the live store:
  `age`, `targetRadius`, `density` and `spriteIds` all read **length 0** off `getState`.
- **Boids — Flocking, WebGPU agents (force)** — 260 agents, polarization **0 → 0.9987**.
- **Boids — Flocking, JS agents (force)** — polarization **0.9982** (the third target).
- **Game of Life on Agents, WebGPU agents (`motion: static`)** — 1024 agents; alive counts
  evolve **304 → 352 → 282 → 284** over three single steps (a genuine Conway trajectory)
  while **not one coordinate changed** — static really is static, and the rule still runs.
- **Morphogenesis — Growing Tissue, WebGPU agents (force + Growth)** — **12 → 768 agents,
  3616 edges**, the growth ramp active (radius 1.6 → 2.7087) and `targetRadius` correctly
  **allocated at full length (768)** — the gate keeps what the model needs.
- **THE MOTION MATRIX on the real GPU**, same model + same seed, only the mode changed
  (max per-agent displacement over 200 generations):
  **force `149.05` · velocity `1.4e-5` · static `5e-6`.** The force run is the positive
  control proving the measurement can see motion; the other two are the f32 round-trip
  floor. *(A first attempt used exact `!==` and reported "all 520 coordinates changed" on
  WebGPU — that was the f64→f32→f64 readback, not motion. Measuring the magnitude instead
  of equality is what made the answer honest.)*
- **JS and WASM freeze exactly** under the same Static configuration: **0 of 520 coordinates
  changed** (f64 throughout, so no round-trip floor).

#### Deviations / decisions (documented, no scope cuts)

1. **The `AGENT_*_FIELDS` reorder (the handoff's STEP 4 prerequisite) was NOT needed, and is
   not done.** Its purpose was to keep offsets stable ACROSS profiles; the actual requirement
   is only that a GIVEN profile produces one consistent layout at every mirror, which the
   shipped record guarantees. Skipping it avoids a second, independent offset change.
2. **The gate is `AgentAbiShape.gates`, not the per-field `gate(profile)` closure** the STEP-0
   descriptor reserved. That hook stays unused for the reason P2 already recorded: **the SHAPE
   is the gate** — every call site produces a shape and none produces a profile.
3. **The WebGPU agent SoA layout is deliberately left UNGATED** (its emitters do carry the
   safety catch). Its runs are a per-generation mirror re-uploaded from the CPU store, not
   where agents live, so there is no memory win; gating them would additionally have to move
   the windowed upload/readback plan (`buildF32ReadPlan`, whose `compactBase` THROWS on an
   unplanned base) — a real corruption risk for zero benefit. Flipping it on later is a
   layout-only change.
4. **WASM uses a compile-time motion variant instead of the runbook's "APPENDED forcePass
   param".** The motion mode is a MODEL property that cannot change without a recompile —
   exactly the reasoning behind `forcePassParamsFor(chargeOn)` deciding the param LIST at
   compile time — so a runtime param would add an ABI slot (and an arity contract to police)
   for a constant. The conditional-arity contract is therefore untouched, and
   `parity-agent-force`'s existing arity assertions still hold.
5. **The static/velocity synthetic lives in the NEW `test-c9-gates.mjs`, not in
   `parity-agent-wasm.mjs`.** That harness runs the BEHAVIOUR function only; the motion mode
   affects only the FORCE pass, so an entry there would not exercise it. The new harness
   asserts POSITIONS (with value invariants) and additionally covers what parity cannot: the
   gated layout matrix and the shape-builder mirror rule. `parity-agent-wasm` WAS updated to
   thread the store's gates, so all 23 of its entries now run against gated stores.
6. **`density`'s gate is the scan predicate, not "is there a reader"** — deliberately wider,
   because a model whose scan runs must have somewhere to put the count.

#### Follow-ups (not defects)

- **The WebGPU agent SoA layout gate** (deviation 3) — the emitters are ready; it needs the
  windowed upload/readback plan to learn about absent runs, plus real-GPU verification.
- **Motion = Static could skip the force DISPATCH entirely** on the GPU paths (today the
  shader runs and no-ops). Cheap, but it needs its own measurement to be worth claiming.
- **`Body` (velocity / force / radius) is still always allocated** — the original STEP 6
  named it, §C9 did not, and it would drag the render snapshot, `getAgentState`, serialize
  and all three integrators into a second layout change.


---

## §C10 — P11a: deterministic Barnes-Hut global charge (all targets)

**Goal**: "Charge range: Cutoff / Global (Barnes-Hut)" as an explicit force-law option on
the Charge capability — deterministic on CPU, all-target delivery, benchmark-proven.
Impact-map section first, inside the plan doc.

Scope:
1. **Config**: `CenterBasedConfig.chargeRange?: 'cutoff' | 'global'` (default cutoff =
   byte-identical), `chargeTheta?` (default 0.9). UI rows in the Charge block.
2. **CPU (JS + WASM lockstep, bit-parity MANDATORY)**: Morton-sorted octree with
   index tie-break (order-canonical), node mass/extent accumulation, per-agent traversal.
   Global = no cutoff (`min_c = 0`); same charge law otherwise. Choose the simplest
   parity-safe seam for sharing the per-generation tree between JS and WASM (engine-TS
   build over appended agent-memory regions à la the spatial hash, or an emitted build —
   justify the choice). f64 on CPU. Single-tree traversal unless dual-tree is proven
   parity-safe. Extend `parity-agent-force.mjs` (or a dedicated harness) with global
   combos, 2D+3D.
3. **WebGPU**: CPU-built tree uploaded per generation (the CPU-built-hash precedent) +
   WGSL traversal in the force pass (f32, statistical — consistent with the target).
   A resident model using global charge falls back to the per-gen path this phase
   (Class F, shown in diagnostics + C1 note); GPU tree BUILD is a recorded follow-up.
   Bindings gated on usage (the Naga stripped-binding discipline).
4. **Benchmark gate**: extend `scripts/probe-graph-layout.mjs` — global BH on the grown
   GRA blob must measurably beat the tuned cutoff on unfolding metrics (nnb/bond,
   overlap) within a sane per-gen budget at N≈2.5k/5k/20k; record numbers. If it does NOT
   improve, STOP and document honestly (ship nothing or ship as experimental —
   benchmark-gated means gated).
5. Shipped models: do NOT retune them (shipped-configs-are-deliberate rule). Note the new
   option in relevant model descriptions only if unambiguous.
6. Harnesses + docs sweep per §1.

### Completion Report — C10 (2026-08-03)

**Status: DONE.** Feature commit **`5b35016`** *feat(clarity): deterministic Barnes-Hut
GLOBAL charge, all agent targets (C10)* on `GRA` (this report rides the follow-up docs
commit, as C1–C9 did). Not pushed, no version bump, no attribution lines. The user's
pre-existing `public/models/Particle Life.gcaproj` modification was left untouched and
uncommitted. Impact map + plan (written FIRST, per the house rule):
[PLAN_CLARITY_C10.md](PLAN_CLARITY_C10.md) / `.html`.

#### THE BENCHMARK GATE — it passed, and it inverted L1's own prediction

The decision rule was fixed in the plan **before** the numbers were taken. L1 had measured
that layout quality "saturates by ~8× the bond rest length" and recorded in CLAUDE.md that
*"no Barnes–Hut tree is needed"*. C10 re-measured that claim at scale rather than assuming
either way — `probe-graph-layout.mjs` grows the GRA blob at N ≈ 2.5k / 5k / 20k in a world
scaled to the population (`side = √(N·(rest·1.45)²)`), same seed, same split fraction, same
tick budget, k = −3 for both, and the ONLY difference is the law:

| N | bond/rest | nnb/bond (↑ better) | overlap % (↓ better) | ms/tick |
|---|---|---|---|---|
| 2 500 · cutoff 8× rest | 0.95 | 0.53 | 16.9 | 6.38 |
| 2 500 · **global θ 0.9** | 1.36 | **0.83** | **4.2** | **3.98** |
| 5 000 · cutoff 8× rest | 0.90 | 0.47 | 37.9 | 21.14 |
| 5 000 · **global θ 0.9** | 1.35 | **0.82** | **4.9** | **13.87** |
| 20 000 · cutoff 8× rest | 0.83 | 0.37 | 82.1 | 236.17 |
| 20 000 · **global θ 0.9** | 1.34 | **0.81** | **4.4** | **163.05** |

Verdicts: **nnb/bond +0.300 / +0.351 / +0.445**, **overlap −12.7 / −33.1 / −77.8 points**,
**cost ×0.62 / ×0.66 / ×0.69**. (The quality metrics are deterministic and reproduced
exactly across two full runs; the ms/tick ratios varied 0.61–0.73× run to run — quote the
range, not a single figure.)

**The SHAPE is the finding, not the deltas.** The cutoff law *degrades* as N grows
(nnb/bond 0.53 → 0.37, overlap 17 % → 82 %) while global holds flat (0.83 → 0.81, ~4 %).
That is the P11 claim made measurable: **a finite cutoff cannot open a graph that outgrows
it, however it is tuned** — which is why this is a new capability rather than a speedup. It
is also *cheaper*, because at an 8×-rest cutoff the hash bin edge IS the cutoff, so the 3×3
stencil sweeps a 120×120 area in a dense world while the tree stays O(N log N).

**Why this does not contradict L1**: L1's sweep ran at N = 1200 in a 4000-wide world (very
sparse) with 8 relaxation ticks per split round. Both statements are true of their own
regime, and CLAUDE.md now says so in both places. ⇒ **gate PASSED ⇒ the UI ships enabled.**

#### What shipped

1. **Schema** — `ChargeRange = 'cutoff' | 'global'`; `CenterBasedConfig.chargeRange?` +
   `chargeTheta?`. Absent ⇒ `cutoff` ⇒ byte-identical, **no migration** (charge is net-new
   since L1, so no shipped file can carry the field).
2. **Resolvers** ([centerBased.ts](../src/model/centerBased.ts)) — `chargeRangeOf` /
   `usesGlobalCharge` / `chargeThetaOf` (CLAMPED to [0.1, 1.5], never throwing: θ is part of
   a declared law a `.gcaproj` records). `ChargeParams` gains `doChargeTree` + `chargeTheta2`
   (precomputed, the `dtOverEta` discipline). **`doCharge` keeps its exact pre-C10 meaning —
   "run the CUTOFF pair term" — and is FALSE under global**, which is what makes
   double-counting structurally impossible and leaves every existing consumer unchanged.
   **`chargeBinEdgeOf` returns 0 under global**: the stencil carries no charge, so widening
   it would be pure cost (in 3D the candidate count grows with the CUBE of the edge).
3. **Engine** — `buildAgentOctree` ([agentEngine.ts](../src/simulator/engine/agentEngine.ts)):
   Morton codes over the bounding CUBE, an **order-canonical stable LSD radix sort** (3 ×
   10-bit passes seeded from an id-ordered array ⇒ exactly `(morton, id)` with no comparator),
   a deterministic DFS with per-LEVEL octant histograms, centre-of-mass + bbox-extent
   accumulation, and skip links (`next[n] === n+1` IS the leaf test). Reuses per-store
   scratch, so a steady-state generation allocates nothing.
4. **CPU pair (JS + WASM), bit-parity mandatory** — the traversal runs in both verbatim JS
   arms (2D + 3D) and in `emitForcePass` as a **compile-time variant** that emits the tree
   **instead of** the pair term. Conditional arity gains a third value: **26 / 30 / 32**
   params (charge off / cutoff / global; the global block is `treeNodeCount:i32,
   chargeTheta2:f64`). The worker always passes 32; extras past a module's arity are ignored,
   so the dangerous direction stays impossible.
5. **WebGPU** — the CPU-built tree is uploaded per generation (`uploadAgentChargeTree`, the
   `uploadAgentHash` precedent) into TWO new bindings (**7** f32 runs, **8** i32 runs)
   declared only when the layout reserved nodes (Naga stripped-binding discipline). The
   traversal is emitted by **ONE shared helper** used by BOTH the canonical and the B1 mirror
   bodies — the rule `chargeTerm` already follows. `ForceControl` gains 3 fields;
   **`FORCE_CONTROL_BYTES` 128 → 144**, covered by the uniform-layout registry. A failed or
   oversized upload leaves BOTH `chargeGlobal` and `treeNodeCount` at 0 (warned once), so the
   shader never walks a truncated tree.
6. **Residency** — global charge is a blocker (`residencyModelBlockers` key `chargeGlobal`,
   text *"the tree is rebuilt on the CPU and uploaded every generation"*), surfaced in C1's
   readout and C3's diagnostics. **GPU tree BUILD is a recorded follow-up, not a hidden gap.**
7. **C2 pipeline** — `agent.charge` reports `k = −10 · GLOBAL (Barnes–Hut θ = 0.9) — every
   pair interacts, summed through a deterministic octree`, and the hash phase stops claiming
   a charge-widened bin edge under global.
8. **UI** — a **Charge range** select + (under Global) an **Accuracy θ** field, with the
   cutoff field HIDDEN under Global rather than shown inert (the `hiddenPorts` doctrine).
9. **Docs sweep** — CLAUDE.md (a new "Charge RANGE" section + an explicit ⚠️ correction on
   L1's "no Barnes–Hut is needed" bullet, so the two regimes read together), HelpView (a
   "Charge range" subsection with the benchmark and the determinism framing), README.

#### THE SEAM DECISION (the runbook asked for it to be justified)

**Engine-TS build + per-target traversal**, not an emitted build. The BUILD is where two
implementations drift — a bbox reduction, a float→int quantization, a sort tie-break, a
recursive split order — and it runs **once per generation**; the TRAVERSAL is the hot part
and is pure arithmetic over shared bytes, which is exactly the shape the force pass already
keeps bit-identical. So the single implementation sits where the risk is and the mirrored
one where it is cheap. It is also literally the `buildSpatialHash` precedent (built in TS,
copied into WASM memory, uploaded to the GPU). An emitted build would triple the surface
that must agree on Morton quantization for zero measured benefit.

#### TWO REAL BUGS THE HARNESS CAUGHT (neither was in the runbook)

1. **f64 ASSOCIATION ORDER IS LOAD-BEARING.** JS evaluates `1 + a + b [+ c]` strictly
   left-to-right; the first WASM emit folded it as `1 + (a + b + c)`. Same value in exact
   arithmetic, one ULP apart in f64 — and the integrator amplifies it. It surfaced as **4
   mismatches in *2D bounded* only**, while torus and 3D happened not to differ; the fix had
   to canonicalise the worker, the WASM emit AND the harness's own mirror (which had picked
   the other association). **Generalise: emitted arithmetic must mirror the JS ASSOCIATION,
   not merely its value.**
2. **A latent defect in `parity-agent-force.mjs` itself.** It called `buildSpatialHash`
   WITHOUT the reserve, so in a BOUNDED world the bbox-anchored hash (`floor(ext/edge)+1`
   bins per axis) could exceed the torus-derived `computeAgentMaxHashBins` reserve the module
   was laid out with, and `copyHashIntoMemory` then wrote past `binStart` into the next
   region. The ENGINE is safe (the worker's `fits`-check falls back to JS); the harness had
   no such guard. Only the global combos exposed it, because they are the first combos whose
   agents spread far enough. Fixed by passing the reserve (as `probe-graph-layout` already
   did).

#### Verification evidence (all re-run immediately before committing)

**Gates** — `tsc -p tsconfig.app.json --noEmit` clean; `npm run build` clean;
**`check-compile-identity --compare`: 29 models, ALL SURFACES UNCHANGED** (baseline captured
from the untouched tree at session start — mtime-confirmed to predate every source edit);
`parity-agent-force` **34 checks ✓**; `parity-agent-wasm` **ALL AGENT SAMPLES: JS↔WASM
BIT-PARITY ✓**; `audit-agent-layout` **347 checks ✓**; `test-c9-gates` **413 ✓**;
`verify-render-uniform-layouts` ✓ (the widened `ForceControl`); `verify-agent-render` ✓;
`test-generation-pipeline` **3401 ✓ · 6 controls caught**; `test-geometry-taint` **210 ✓**;
`test-engine-resolve` **719 ✓**; `test-agent-capabilities` **202 ✓**; `test-agent-abi`
**28 ✓**; `check-agent-wasm-gate` GATE✓ COMPILE✓ INST✓; `check-no-unseeded-random` OK;
`test-archetypes` **201 ✓**; `gen-capability-docs --check` up to date;
`probe-graph-layout` **LAYOUT PROBE ✓** (all L1 gates + the 9 new C10 gates).

**COMPILE-IDENTITY — ZERO moved surfaces, and the enumeration is why.** Every mechanism is
usage-gated on `usesGlobalCharge`, which no shipped model sets:
- `AgentLayoutExtras.chargeTreeNodes = 0` ⇒ the 10 WASM tree regions reserve **0 bytes** and
  are appended AFTER every existing region ⇒ no baked offset moves ⇒ `agent.wasm.bytes`
  unchanged.
- `forcePassParamsFor(charge, /*global*/ false)` returns the pre-C10 list ⇒ the type section
  and declared arity are unchanged; `P.chargeTreeNodes === -1` ⇒ **no traversal is emitted**
  and no locals are allocated (an unconditional `em.allocLocal` would have moved every
  module's bytes — the L1 `chargeOn` precedent).
- `layout.chargeTreeNodes === 0` ⇒ the WGSL declares no bindings 7/8 and emits no traversal.
  (The `ForceControl` struct did gain 3 members, but the force-pass shader is **not** a
  captured surface — `check-compile-identity` captures `agent.webgpu.shader` (behaviour) and
  `agent.webgpu.om`, verified by inspection of the script.)
- `chargeParamsOf`'s four pre-existing fields keep their exact values for cutoff/off models.

**JS↔WASM bit-parity — 13 new global combos, 0 mismatches over 25 steps each**: 2D torus
collision 0/1, 2D bounded collision 0/1, 2D torus + bonding/adhesion, 3D torus collision 0/1,
3D bounded collision 1, θ = 0.3 (2D torus) / θ = 1.4 (2D torus) / θ = 0.3 (3D bounded),
global-only (no collision/bonding/density) in 2D and 3D. Plus the **32-param arity contract**
(26 / 30 / 32, and passing all 32 to the 26-param export is accepted).

**THE VALUE INVARIANT — because parity is a mirror test.** Parity would pass happily if BOTH
targets summed zero, so the harness also compares the tree against a brute-force O(N²) exact
all-pairs sum over 240 agents: **relative error 0.013 % at θ = 0.2 vs 3.76 % at θ = 1.4**
(|f|max 9.6). That asserts three things at once — the force is real, it tracks the law it
claims to run, and **θ genuinely controls accuracy**.

**Harnesses proven failable by SOURCE MUTATION**: aliasing two octree runs in
`computeAgentMemoryLayout` (`treeSortedYOffset = treeSortedXOffset`) makes
`audit-agent-layout` report 2 failures; reverted, green again. (The association-order bug and
the harness reserve bug above are two more instances of these gates catching real defects
rather than confirming a prior belief.)

**Real GPU (in-browser, occluded pane ⇒ protocol + buffer readbacks, not composited pixels)**
— **all 12 force-shader variants compile with 0 errors** on a real device (2D / 3D /
no-tree × mirror on-off × force-scatter on-off), with bindings 7/8 present iff the layout
reserved nodes. A **real dispatch** (200 agents, 33 tree nodes, bounded world, momentum 0 and
dtOverEta 1 so `vx` IS the force) matches the CPU f64 traversal to **max relative error
2.6e-6, mean 2.1e-7** — pure f32 rounding — with **0 validation errors**.

**In-browser, real worker, real model** — a `Cubic GRA` variant with `chargeRange: 'global'`
loaded through the real file input (WASM agent target): **6 → 26 agents over 120
generations**, every tracked agent moving (mean displacement 15.0, max 27.4, 0 NaN), and the
automaton's own invariant intact: **min degree = max degree = 3, E = 39 = 3N/2**. The
Properties **Charge range** select shows both options and flips **Cutoff ⇄ Global
bidirectionally** — under Global the *Charge cutoff* field disappears and *Accuracy θ*
appears, and the C2 pipeline detail swaps between `k = −10 · cutoff 20 (…)` and `k = −10 ·
GLOBAL (Barnes–Hut θ = 0.9) — every pair interacts, summed through a deterministic octree`.
The Help tab renders the new "Charge range" subsection with its table. **0 console errors**
across the whole session.

*(One measurement lesson worth carrying: `getState`'s agent payload ships raw `ArrayBuffer`s,
not typed arrays. A first probe compared `a.x[i]` directly, got `NaN`, and reported "0 agents
moved" — an artifact of the probe, not the engine. Decode before measuring.)*

#### Deviations / decisions (documented, no scope cuts)

1. **`doCharge` was NOT generalised into a tri-state.** Keeping it as exactly "run the cutoff
   pair term" leaves every existing consumer (JS, WASM, both GPU dispatch sites, the C2
   pipeline) unchanged and makes double-counting impossible by construction.
2. **`ForceControl` grew to 144 bytes rather than packing the mode into `doCharge`.** Three
   explicit fields are clearer, the harness pins them, and 16 bytes of uniform is free.
3. **The B1 MIRROR force pipeline binds the tree too**, even though a global-charge model is
   never residency-eligible today. The shared emitter declares bindings 7/8 whenever the
   layout reserved nodes, so the two pipelines must agree or the bind group mismatches —
   defence in depth against exactly the drift the shared emitter exists to prevent.
4. **Self-interaction is NOT excluded** — the reference behaviour. A node containing the agent
   can pass the θ test (its centre of mass can sit up to ≈ `extent·√3` from a contained
   point); leaf-level self is *exactly* zero (`d = 0 ⇒ c·d = 0`), so the error is confined to
   the far field, which is what θ names. Documented rather than silently "fixed", since a
   bbox containment test would change the law.
5. **The node reserve is `maxAgents + 64` with a LEAF degradation** rather than a proven
   worst-case bound. A node that runs out of reserve becomes a leaf, which sums its points
   exactly — so the cap can make the result *slower*, never *wrong*, and it bites at the same
   place every run (determinism preserved). Measured node counts on real blobs sit far below
   N (33 nodes for 200 agents).
6. **Torus uses the minimum-image convention**, the same fold every other engine force uses.
   A node straddling the seam has a large extent, fails θ, and is descended to leaves where
   the fold is exact — graceful, not silent.
7. **No shipped model was retuned** (shipped-configs-are-deliberate). The benchmark suggests
   Global would suit `Cubic GRA` and `SDCA` as they grow, but that is the user's call, so
   their descriptions were left alone.

#### Follow-ups (not defects)

- **A GPU tree BUILD** would lift the residency blocker (the only reason global charge forfeits
  residency). Needs a parallel Morton sort + node accumulation on the GPU, and its own
  determinism story — which is precisely why it was not smuggled in here.
- **`computeAgentMaxHashBins` under-reserves for BOUNDED worlds** (`floor(ext/edge)+1` per
  axis can exceed the torus-derived `floor(W/edge)`). The engine is safe — the worker's
  `fits`-check falls back to JS, loudly, once — but it means a bounded model can silently
  lose the WASM force pass for a step. Pre-existing, surfaced here, out of C10's scope.
- **θ has no per-model guidance yet.** 0.9 is the reference value and the benchmark used it
  throughout; a "θ vs quality vs cost" sweep would let the UI recommend rather than default.

---

## §C11 — P11b: adaptive spatial index (benchmark-gated investigation)

**Goal**: decide with numbers whether exact tree-accelerated radius queries beat the
uniform hash in GenesisCA's real regimes; ship only what wins. This phase may
legitimately ship NO engine change — that outcome is the protocol working.

Protocol:
1. Extend `scripts/bench-agent-engine.mjs` with clustered-in-sparse-world fixtures (the
   GRA regime) + large-radius sensing fixtures, comparing the shipped hash vs a prototype
   exact octree range query (Node-side prototype is fine; it MUST return identical
   neighbour sets — assert).
2. Decision rule: ship the adaptive index ONLY where the tree wins ≥1.5× on a fixture
   class real models occupy (use the shipped samples' radius/density stats). Otherwise
   write `docs/INVESTIGATION_ADAPTIVE_INDEX.md` recording measurements + retry
   preconditions (the E2-withdrawal precedent) and close with no engine change.
3. If shipping: order-canonicalized traversal on JS+WASM (parity mandatory), heuristic
   selection displayed in C3 diagnostics, full harness sweep.
4. Docs sweep either way.

### Completion Report — C11 (2026-08-03) — THE FINAL PHASE

**Status: DONE — and the deliverable is a MEASURED "NO".** Feature commit
**`93ac131`** *feat(clarity): measure the adaptive spatial index; surface the
all-pairs bail (C11)* on `GRA` (this report rides the follow-up docs commit, as
C1–C10 did). Not pushed, no version bump, no attribution lines. The user's
pre-existing `public/models/Particle Life.gcaproj` modification was left untouched
and uncommitted. Full record: [INVESTIGATION_ADAPTIVE_INDEX.md](INVESTIGATION_ADAPTIVE_INDEX.md).

**No adaptive index was shipped. That is the protocol working, not a shortfall** —
the decision rule was fixed before any number was taken and the numbers failed it.

#### THE BENCHMARK GATE — and why it failed

[scripts/bench-spatial-index.mjs](../scripts/bench-spatial-index.mjs) (new) runs three
contenders per fixture, each doing one generation's work (index build + one query per
agent): **hash-shared** (the SHIPPED path — one hash at the engine's real bin edge,
queried with the stencil transcribed from `GetNearbyAgentsNode`'s emit, including its
all-pairs fallback), **hash-tuned** (a second hash at the QUERY radius — the cheap
alternative a tree must beat to be worth building), and **tree** (**C10's
`buildAgentOctree` reused unmodified**, per the orchestrator's note — it is already
order-canonical, 3D-native, and its per-node bboxes are exactly the pruning structure
a range query wants — plus an exact bbox-pruned range query with the standard
fully-inside shortcut and minimum-image query replication for the torus).

**Exactness is asserted, not assumed**: every fixture compares all three contenders'
neighbour sets per agent, sorted; the script exits non-zero on any difference.
**Result: ALL FIXTURES IDENTICAL, on both full runs.**

**The structural finding that decided it.** GenesisCA's hash is not a fixed-bin hash:
the worker sizes its bin edge at `max(interactionRange·2·maxR, neighbourQueryRadius,
chargeBinEdgeOf)`, so the 3×3(×3) stencil always spans ≥ 3r and the over-scan is a
**CONSTANT ≈2.9× (2D) / ≈6.4× (3D), independent of r/spacing**. The mechanism by which
trees normally overtake a hash is simply absent.

| regime | tree vs shipped hash | occupied by a shipped model? |
|---|---|---|
| uniform, r/spacing ≤ 5 | 0.31×–1.19× (hash wins/ties) | **YES — all of them** (max r/spacing = **3.27**) |
| uniform, r/spacing 10 / 15 (2D) | 1.70–1.95× / 2.01–3.11× | No |
| uniform 3D, r/spacing 5 / 10 | 2.04–2.07× / 3.09–3.21× | No |
| torus cluster, world ×16 / ×64 | 1.96–2.04× / **10.23–11.16×** | No (needs > ~256 bins/axis for the 65 536-bin cap to coarsen; widest shipped is 30) |
| shipped-shaped (GRA / SDCA / Boids / PL) | **0.46×–1.18×**, or inside the noise floor | YES |

Two honesty controls are built into the harness and both mattered. **A noise floor**:
rows where `sharedEdge === queryR` construct two *identical* hashes, so their ratio
must be 1.00 — observed spread **0.72×–1.57×**, worst at small absolute times, which
disqualifies the `SDCA-like 1.51×/1.57×` row (total wall clock 0.35–0.62 ms). **Work
counts** (candidates examined — implementation-independent): the tree's realised
speedup is consistently *far below* its candidate advantage (9.6× candidates → 2.0×
time), i.e. traversal bookkeeping eats most of the algorithmic edge — and on the 2D
shipped shapes a **per-radius HASH examines fewer candidates than the tree does**
(GRA-like 3.7 vs 14.4; SDCA-like 4.8 vs 10.8). **The one shipped-shaped fixture that
appeared to clear the bar — PL-like at 2.07× — measured 1.14× on a second full run.**

⇒ **every regime where the tree clearly wins is either unoccupied by the library or
won more cheaply by a hash built at the right radius.** Not shipped; retry
preconditions in the investigation doc §9.

#### THE FINDING THAT MATTERED — a shipped model silently running all-pairs

`buildSpatialHash` returns `null` when the world is under **3 bins wide on any axis**
(correct — a wrapping 3-wide stencil would visit a bin twice and double-count), and
every emitted query then takes its all-pairs fallback. **The shipped `Particle Life
3D` sits exactly there**: a 160×110×70 torus with `neighbourQueryRadius: 24` gives
`floor(70/24) = 2` bins in z ⇒ **6×4×2 ⇒ all-pairs, every generation, on every target,
with nothing reporting it**. Measured **43.6 ms vs 5.5 ms** of queries at its shipped
N = 1200. `computeResidentHashParams` carries the identical rule, so the GPU-resident
batch bails too.

So C11's one shipped change is a **diagnostics row**, not an index: `getDiagnostics`
gained a `spatialIndex` block recorded **at the build sites** (`noteAgentHash` for both
`buildSpatialHash` calls **and an equivalent record inside the resident batch**, which
builds its hash GPU-side and never reaches that function — a first version reported
`applicable: false` for precisely the model the row exists for), and the C3 popover
shows **Agent neighbour index**. **Deliberately not a toast**: an all-pairs index is
harmless on a small model, so the passive P4 surface is the honest placement.

#### A STANDING GATE WAS RED ON THE BASE COMMIT (found, diagnosed, repaired)

`scripts/verify-graph-rewrite.mjs` — the 12-tier GRA harness — **crashed on `b1710d9`**
(`TypeError: Cannot create property '0' on string ''`), reproduced with C11's changes
stashed. Cause: **C9 made the agent ABI profile-gated**, and the gated fields
(`_agentTargetRadius` / `_agentAge` / `_agentDensity`) are **MID-LIST**, so the
harness's two ungated stores/shapes produced MORE args than the compiled param list and
**every later argument shifted** — the viewer string `''` landed where `_rngState`
belongs. The worker (`agentAbiShapeOfStore`) and `parity-agent-wasm` both pass
`s.fieldGates`; this harness is the **FOURTH mirror** and never got it. Repaired in
both rigs (`resolveAgentFieldGates(model)` / `layoutExtras.fieldGates`).

**The crash was masking 7 further failures** — O7 JS↔WASM bit-identity, three O11
oscillator checks, the O3 negative control, and both nearby-census checks — all of
which are the same shift seen through the JS behaviour reading shifted arrays. After
the repair: **405 passed, 0 failed**. **The ENGINE was never affected** (the worker and
`parity-agent-wasm` pass gates correctly, and both were green throughout); only the
harness mirror was stale. *Generalise: `audit-agent-layout` checks the four sites it
knows about — a harness that hand-builds an ABI shape is a mirror too, and a mid-list
gated field shifts silently rather than dropping a trailing arg.*

#### Verification evidence

**FINAL FULL-SUITE SWEEP — every gate re-run after the last edit, all green:**

| gate | result |
|---|---|
| `tsc -p tsconfig.app.json --noEmit` | clean |
| `npm run build` | clean |
| `check-compile-identity --compare` | **BYTE-IDENTITY OK — 29 models, all surfaces unchanged** (baseline captured at session start, before any edit) |
| `parity-agent-wasm` | ALL AGENT SAMPLES: JS↔WASM BIT-PARITY ✓ |
| `parity-agent-force` | FORCE-PASS PARITY ✓ (34 checks) |
| `check-agent-wasm-gate` | GATE✓ COMPILE✓ INST✓ (all samples) |
| `audit-agent-layout` | AGENT ABI FIELD-ORDER AUDIT ✓ |
| `test-agent-abi` | 28 passed, 0 failed |
| `verify-agent-render` | AGENT RENDER-LAYER INVARIANTS ✓ |
| `verify-render-uniform-layouts` | GPU UNIFORM LAYOUTS ✓ |
| `test-c9-gates` | 413 passed, 0 failed |
| `test-engine-resolve` | 719 passed, 0 failed · 6 controls caught |
| `test-generation-pipeline` | 3401 passed, 0 failed · 6 controls caught |
| `test-geometry-taint` | 210 passed, 0 failed · 6 controls caught |
| `test-agent-capabilities` | 202 passed, 0 failed |
| `test-archetypes` | 201 checks passed |
| `check-no-unseeded-random` | OK |
| `gen-capability-docs --check` | up to date (53 agent nodes, 5 grid rejects, 10 limits) |
| **`verify-graph-rewrite`** | **405 passed, 0 failed** (was CRASHING before this phase's repair) |
| `probe-graph-layout` | LAYOUT PROBE ✓ |

**In-browser (dev server, real models, real worker, real WebGPU; 0 console errors).**
The Browser pane reports not-displayed, so evidence is worker protocol + DOM text —
the right evidence for a diagnostics row.
- **Particle Life 3D** (shipped file, real file-input load, WebGPU agent target,
  **GPU-resident batch engaged**) reports `spatialIndex: { built: false, binEdge:
  26.67, reason: "the world (160x110x70) is under 3 bins wide on some axis at the
  resolved bin edge (bins 6x4x2)" }`, and the popover renders *"Agent neighbour index
  — off — every neighbour query is running all-pairs — … The bin edge is the LARGEST
  of interaction range x 2 x radius, Neighbour Query Radius and the charge cutoff;
  lowering whichever dominates lets the hash build."*
- **The advice is ACTIONABLE, measured**: the same model reloaded with
  `neighbourQueryRadius` 24 → 16 (what its graph actually queries with) reports
  `built: true, 240 bins of 16.0` (10×6×4). **The shipped model was NOT retuned** —
  shipped-configs-are-deliberate; this was a probe and the change is the user's call.
- **Positive control — Boids — Flocking**: `spatial hash, 64 bins of 15.0`, matching
  its 8×8 row in the stats table.
- The popover's other rows (residency engaged 1 batch, sparse n/a, field bridge n/a,
  direct render agents → canvas) are unchanged.

#### Deviations / decisions (documented, no scope cuts)

1. **A dedicated script rather than extending `bench-agent-engine.mjs`** (the runbook
   allows either). `bench-agent-engine` is the per-PHASE profiler for a whole
   generation; this needs a different unit (one index, one query shape) and its own
   exactness assertion. Both remain useful and neither perturbs the other.
2. **A third contender was added — `hash-tuned`.** The runbook specifies hash vs tree.
   Measuring a *per-radius hash* alongside is what turned "the tree wins 5× on PL3D"
   into "a one-line hash change wins 7.9× there", which is the difference between
   shipping a backend and not. A two-contender benchmark would have produced a
   defensible but wrong conclusion.
3. **One diagnostics row WAS shipped**, though the phase's headline outcome is "no
   engine change". It is not an index and changes no simulation behaviour
   (`git diff --stat` = `sim.worker.ts` + `SimulatorView.tsx` + docs/help;
   compile-identity byte-identical). Leaving a measured, silent, shipped fast-path
   loss unreported would have contradicted the entire initiative.
4. **The GRA harness repair was taken on** rather than merely reported. It is
   verification tooling, not `src/`, and leaving the milestone's own 405-check gate
   dead through the final phase — while *reporting* a green suite — was not defensible.
5. **`Particle Life 3D` was not retuned**, and neither was any other model.

#### Follow-ups left for the user (none is a defect in this phase)

- **`Particle Life 3D`'s `neighbourQueryRadius`.** Lowering 24 → 16 restores a real
  spatial hash (measured). Purely the user's call; the diagnostics row now says so.
- **A per-radius ("tuned") hash as a real feature** — the cheapest form of "adaptive
  index", and the only contender that beat the shipped path on shipped shapes. Not
  shipped because its wins are sub-5 ms gathers whose benefit has not been shown to
  reach a whole generation, and it costs a second O(N) build per step. §9.4 of the
  investigation is the precondition list.
- **`computeAgentMaxHashBins` under-reserves for BOUNDED worlds** (carried over from
  C10, still open; engine-safe via the worker's fits-check).
- **A GPU tree BUILD** (C10's follow-up) would lift global charge's residency blocker.

---

## Closing note — the initiative is complete

Eleven phases, C1 → C11, all `DONE`. Wave 1 (C1–C3) made the engine's decisions
inspectable without changing one, Wave 2 (C4–C6) consolidated the schema behind them,
Wave 3 (C7–C9) finished explicitness and paid off the deferred-XL capability work, and
Wave 4 (C10–C11) took the geometry track: one measured YES that shipped a new force
law, and one measured NO that shipped a benchmark and a diagnostics row instead. Both
outcomes came from the same rule applied before the numbers existed.

---

## Orchestrator log

- 2026-08-02: runbook created. Launching C1.
- 2026-08-03: **C11 DONE** (`93ac131`) — **and with it the ENTIRE INITIATIVE. All 11
  phases complete; no phase is left open.** P11b was benchmark-gated and **THE GATE
  FAILED, which is the protocol working**: no adaptive index shipped. The new
  `scripts/bench-spatial-index.mjs` pits the shipped hash against a per-radius hash and
  an exact bbox-pruned range query over **C10's octree, reused unmodified**, asserting
  IDENTICAL neighbour sets everywhere (they are, on both full runs). **The structural
  reason**: GenesisCA's hash sizes its bin edge to the query radius, so its over-scan is
  a CONSTANT ~2.9×/6.4× and the mechanism by which trees overtake a fixed-bin hash is
  absent. The hash wins or ties to r/spacing ≈ 5 and loses past ≈ 10 — **no shipped
  model exceeds 3.27**; the tree's ≥1.5× wins live only in unoccupied regimes (large
  radius; a torus wide enough for the 65 536-bin cap to coarsen, where it reaches 10×).
  The single shipped-shaped fixture that looked like a win (2.07×) **fell to 1.14× on a
  second run**, and work counts show the realised speedup is far below the
  candidate-count advantage while a per-radius HASH examines fewer candidates than the
  tree on the 2D shipped shapes. **THE FINDING THAT MATTERED**: the shipped
  `Particle Life 3D` (160×110×70 torus, `neighbourQueryRadius` 24 ⇒ `floor(70/24) = 2`
  bins in z) **cannot build a hash and runs ALL-PAIRS on every target, silently** —
  43.6 ms vs 5.5 ms of queries at N=1200. The bail is CORRECT and the fix is not a tree
  (a hash at the query radius wins more), so C11 shipped a **diagnostics row** instead:
  a `spatialIndex` block recorded at the build sites **including the GPU-resident batch,
  which builds its hash GPU-side and never reaches `buildSpatialHash`** — the trap a
  first version fell into, reporting "n/a" for exactly the model the row exists for.
  Verified in-browser that the advice is actionable (`nqr` 24 → 16 ⇒ 240 bins of 16.0);
  **the shipped model was NOT retuned**. **ALSO: a standing gate was RED on the base
  commit** — `verify-graph-rewrite` was CRASHING (reproduced with C11 stashed) because
  **C9's profile-gated ABI fields are MID-LIST** and this harness is a FOURTH ABI mirror
  that never got `gates`, so its args out-numbered the compiled params and everything
  shifted; the crash **masked 7 further failures**. Repaired in both rigs → **405
  passed, 0 failed**; the engine was never affected. Compile-identity **byte-identical
  on all 29 models**, and all 20 standing gates green in the final sweep. **Two lessons
  worth carrying**: (1) a benchmark needs the CHEAP alternative as a third contender —
  two contenders here would have justified a whole backend that a one-line hash change
  beats; (2) `audit-agent-layout` guards the four sites it knows about, but **any
  harness that hand-builds an ABI shape is a mirror too**, and a mid-list gated field
  shifts silently rather than dropping a trailing argument.
- 2026-08-03: **C10 DONE** (`5b35016`). P11a — "Charge range: Cutoff | Global (Barnes-Hut θ)" as an
  explicit force-law option, deterministic on the CPU pair, delivered on all three agent targets.
  **THE BENCHMARK GATE PASSED AND INVERTED L1's PREDICTION**: on the grown GRA blob at equal
  seed/ticks in a world scaled to the population, global beats the tuned 8×-rest cutoff on every
  axis at every size AND costs less per tick — nnb/bond 0.53→0.83 (N 2.5k), 0.47→0.82 (5k),
  0.37→0.81 (20k); overlap 16.9→4.2 %, 37.9→4.9 %, 82.1→4.4 %; cost ×0.62/×0.66/×0.69. The SHAPE is
  the finding: the cutoff law degrades as N grows while global holds flat, i.e. a finite cutoff
  cannot open a graph that outgrows it however it is tuned. CLAUDE.md's L1 "no Barnes-Hut is
  needed" bullet now carries an explicit ⚠️ pointing at the new section, since both statements are
  true of their own regime (L1 measured N=1200 in a very sparse world). **Compile-identity: ZERO
  moved surfaces on all 29 models** — every mechanism is usage-gated (0 reserved bytes, the pre-C10
  WASM param list, no GPU bindings declared), enumerated in the report. All 17 standing gates green;
  `parity-agent-force` 20→34 checks and `audit-agent-layout` 240→347, the latter proven failable by
  a source mutation. Real GPU: all 12 force-shader variants compile 0 errors and a real dispatch
  matches the CPU traversal to 2.6e-6 (f32); in-browser a global-charge `Cubic GRA` grows 6→26
  agents with the cubic invariant intact (deg 3/3, E = 3N/2), 0 console errors. **TWO FINDINGS worth
  carrying**: (1) **f64 ASSOCIATION ORDER is load-bearing** — `1 + a + b` folded as `1 + (a + b)` in
  the WASM emit diverges by an ULP the integrator amplifies, and it showed up in *2D bounded only*
  while torus and 3D happened not to differ; emitted arithmetic must mirror the JS association, not
  just its value. (2) `parity-agent-force` had a latent defect the new combos exposed — it built the
  spatial hash WITHOUT the reserve, so a bounded world's bbox hash could overrun `binStart` into the
  next region (the engine is safe via the worker's fits-check; the harness had no guard). **C11 may
  proceed** — note its exact-tree prototype can reuse `buildAgentOctree` (it is already
  order-canonical and 3D-native), and that `computeAgentMaxHashBins` under-reserves for BOUNDED
  worlds (recorded as a follow-up, engine-safe but it costs a bounded model its WASM force pass for
  that step).
- 2026-08-03: **C9 DONE** (`b1279da`). The deferred-XL engine phase: STEP 4 (profile-gated agent
  SoA fields, capability OR usage) + STEP 6 (the Static / Velocity motion integrator on all three
  agent targets). **Compile-identity moved 28 surfaces, all enumerated and deliberate**: exactly
  `agent.behaviourCode` + `agent.wasm.bytes` for the 14 shipped agent models (none has sprites, so
  all drop the 5 sprite ABI params, and all drop >=1 f64 field, so the baked offsets move). NO grid
  surface, NO `agent.webgpu.shader`, NO overseer driver changed. All 15 standing gates green; the
  new `test-c9-gates.mjs` is 413 checks in four tiers and was proven failable by two SOURCE
  mutations. Verified in-browser on Ant Necrophoresis (WASM/static), Boids (WebGPU + JS/force),
  GoL-on-Agents (WebGPU/static), Growing Tissue (WebGPU/force+growth) and a three-mode GPU matrix
  (displacement 149.05 force / 1.4e-5 velocity / 5e-6 static), 0 console + 0 worker errors.
  **TWO FINDINGS worth carrying**: (1) `Ant Necrophoresis` ships `motion:'static'` and moves its
  ants with Set Agent Position, so the force pass and the position COMMIT must be skipped TOGETHER
  or every graph write is reverted — the runbook did not name this; (2) a real ABI desync (the
  worker's `agentAbiShapeOfStore` missing `gates`) that `audit-agent-layout` structurally cannot
  catch, now pinned by tier D of the new harness. **C10 may proceed** — note it will add force-law
  terms to the same three force passes C9 just gated, so it should read `motionAppliesForces` /
  `motionModeCode` rather than re-deriving, and the WebGPU `ForceControl` now ends at
  `motionMode` (u[29]) inside the unchanged 128-byte block.
- 2026-08-03: **C8 DONE** (`fd7ec90`). Compile-identity byte-identical on all 29 models (zero emit
  impact by construction — no engine/compiler/worker file touched); the new taint harness is 210
  checks with 6 in-harness controls and 5 SOURCE-MUTATION controls all caught; every standing gate
  green. Verified in-browser on 5 models, both label states, 0 console errors. **Finding for later
  phases: `Cubic GRA` and `SDCA` are TAINTED, not presentational** — both seed bonds from a
  proximity query (geometry → topology), which the runbook's three named checks did not cover; the
  hand-audit table is in the C8 report. 4 of 14 shipped agent models are presentational (Boids ×2,
  Particle Life ×2). C9 may proceed; note its Static-integrator work interacts with
  `PRESENTATION_PHASE_IDS`.
- 2026-08-02: **C1 DONE** (`4ddca6f`). Compile-identity byte-identical on all 29 models; parity /
  force / render harnesses green; verified in-browser on Amphiphile, Growing Tissue, Cubic GRA,
  Game of Life + a provoked demotion (amber chip) and its negative control. C2 (Generation
  Pipeline panel) may proceed — it can reuse C1's `diagnoseTargets` resolvers and the
  `effectiveAgentDt` helper for its resolved numbers.
- 2026-08-02: **C2 DONE** (`96e5652`). Compile-identity byte-identical on all 29 models; the new
  `test-generation-pipeline.mjs` green (3400 checks, 288-combination matrix, 6 negative controls) and
  proven failable by two source mutations; verify-agent-render green. Verified in-browser on Boids,
  Growing Tissue, Ant Necrophoresis, Game Of Life and Cubic GRA. C3 (fast-path diagnostics + generated
  capability docs) may proceed — it owns the RUNTIME half of the same story (C2 describes what the
  model asks for; C3 reports what actually engaged), and `PipelinePhase.presentation` is already
  reserved for C8.
- 2026-08-02: **C3 DONE** (`2620d37`). Compile-identity byte-identical on all 29 models; parity /
  agent-wasm-gate / verify-agent-render green; the new `gen-capability-docs --check` gate green and
  proven failable by a SOURCE mutation (dropping a node from `AGENT_WASM_SUPPORTED_TYPES` → exit 1
  naming the drift). Verified in-browser on Boids (residency engaged, batches 1 → 13), Growing Tissue
  (residency off with the structural blocker), an Accretor variant (sparse count identical to the ◩
  chip), and a forced async-on-WebGPU fallback (logged + shown, no flooding across 250 step messages).
  C1's residency approximation is now discharged — the popover reads the worker's real compiler flags.
  C4 (the engine enum) may proceed; it should consume `getDiagnostics`'s resolved `engine.grid` /
  `engine.agents` / `agentEngineActive` rather than re-deriving runtime state, and must regenerate
  `capabilityMatrix.gen.ts` if it touches the gates (`node scripts/gen-capability-docs.mjs`).
- 2026-08-02: **C4 DONE** (`b0f43b9`). Compile-identity byte-identical on all 29 models; the new
  `test-engine-resolve.mjs` green (367 checks, 3 negative controls) and proven failable by TWO SOURCE
  MUTATIONS (dropping the Overseer preference → 3 failures; mis-mapping the migration → 38). parity /
  agent-wasm-gate / verify-agent-render / render-uniform-layouts / generation-pipeline /
  gen-capability-docs --check all green. Verified in-browser on Accretor, Amphiphile, Cubic GRA,
  Growing Tissue, Coagulation and a File → New model: library models resolve UNCHANGED, Auto shows its
  pick + reason (incl. the Overseer exception), the Advanced reveal holds Debug JS, Show Code carries
  the reference header, and models still step (Coagulation gen 50 under Auto→WebGPU, Tissue gen 145 on
  the WebGPU agent target), 0 console errors. **NB the one deviation C5 must absorb**: a NEW model
  resolves `Auto → WebGPU`, not the WebAssembly this runbook's C4 bullet expected — the policy sentence
  in the proposal AND §C4 says WebGPU-where-gates-pass, and C5's own spec keeps the grid
  WebGPU-eligible under `exact`. C5 may proceed: it replaces the two hard-coded Overseer branches in
  `resolveGridLayer`/`resolveAgentLayer` with the contract, and `LayerResolution.reason` is already the
  string the UI renders, so the policy changes without touching the UI.
- 2026-08-02: **C5 DONE** (`59afc6b`). Compile-identity byte-identical on all 29 models; `test-engine-resolve`
  extended to **719 checks / 6 negative controls** and proven failable by TWO SOURCE MUTATIONS (a constant
  `inferContract` → 14 failures; Auto ignoring the contract → 30). parity-agent-wasm / check-agent-wasm-gate /
  verify-agent-render / test-generation-pipeline / gen-capability-docs --check all green. Verified in-browser on
  Particle Life (Statistical inferred; Auto keeps the GPU; flipping to Exact re-resolves `Auto → WebAssembly`
  with the contract reason), a provoked violation (amber in the radio, the readout and the ⚙ chip) with its
  negative control, Cubic GRA (Exact + Overseer → WASM **via the contract reason, with no mention of the
  Overseer**; declaring Statistical releases the GPU — the special case is subsumed, not re-implemented), and all
  three Overseer methodology forms. **NB the one deviation C6+ should know about**: the Overseer clause is
  honoured on the AGENT layer only — a grid Overseer model under Exact keeps WebGPU, because `setRngSeed` DOES
  re-derive the grid's per-cell streams (measured: a 5-run sweep reproduced) and the library ships exactly such a
  model (`GoL Replicate Statistics`) on WebGPU; asserting otherwise would have flagged a shipped model that
  demonstrably reproduces. C6 may proceed — it inherits a `contract`-carrying `resolveEngines` (its `reason` /
  `contractViolation` strings are already what the UI renders) and C3's `runtimeEvents` log for the loud-fallback
  UI; its update-mode vocabulary work should reuse the doctrine wording the contract copy now shares.

- **2026-08-03 — C6 DONE** (`1bc1465`). P5 + the P4 completion. `check-compile-identity` byte-identical (29
  models) at every step; tsc / build / parity-agent-wasm / parity-agent-force / check-agent-wasm-gate /
  verify-agent-render / verify-render-uniform-layouts / test-engine-resolve / test-generation-pipeline /
  test-agent-abi / audit-agent-layout / gen-capability-docs --check all green. `test-agent-capabilities` grew
  76 → 202 checks with an authority section (load/save round-trip, fixed point, the write guard), both negative
  controls proven by SOURCE MUTATION. Verified in-browser: both radio subtitles; a REAL fallback (async model +
  WebGPU) producing an amber toast + amber chip + Events row; de-dupe (a repeat re-toasts NOT, the chip counter
  does not move); the legacy-flags seam firing when a profileless config reaches the worker AND being silent
  once the profile is present; and a compile-time clamp going amber WITHOUT a toast. **Three things C7+ should
  know.** (1) **A compiler-visible error STRING is a captured surface** — `check-compile-identity` stores
  `webgpu.error` / `js.error`, so the per-node reject texts in `detectWebGPUIncompatibilities` could NOT be
  reworded; only the non-captured model-level sentence was. Treat error text like emitted code. (2) The phase
  found and closed a real hole beyond its brief: a **PARTIAL** `agentCapabilities` object is truthy, so the
  migration used to let it through and `collisionMode` (which falls back per FIELD) silently resolved from the
  legacy flags — and saving wrote the partial profile back, so the event's own "re-save to bake it" advice was
  false. `migrateAgentCapabilities` now COMPLETES an existing profile from the same inference the absent case
  uses (explicit keys win), which is behaviour-preserving by construction and measured byte-identical.
  Consequence: **no app path can now reach the engine profileless**, so the legacy event is a tripwire rather
  than a routine notice. (3) The runbook's verbatim *"Asynchronous (sequential — CPU engines only)"* is FALSE
  for the AGENT radio (Growing Tissue ships async agents on WebGPU); it reads *"a cross-agent write needs a CPU
  engine"* there. C7 may proceed — the toast/chip channel (`fallback: true`) and `legacyPhysicsFlagsInEffect`
  are in place, and the legacy-read REMOVAL SCHEDULE is now written down in CLAUDE.md (note `useBondingPhysics`
  is NOT on it: it is still the only control for adhesion μ_A).
- **2026-08-03 — C7 DONE** (`02ad2ec`). P6 archetype chooser + P7 seeded engine draws.
  `check-compile-identity` 29 models byte-identical; two new gates
  (`test-archetypes.mjs` 201 checks, `check-no-unseeded-random.mjs`), both proven failable
  by SOURCE MUTATION; every existing harness green. In-browser: all 8 archetypes created
  through the real File ▾ → New flow and asserted via the C1/C2 panels + Properties (incl.
  `● 4 agents` reaching the engine on the GRA card and `Empty` reproducing today's New); the
  unsaved-changes confirm still guards New, and cancelling the chooser AFTER accepting it
  keeps the model; seeded scatter reproduces 0/260 diffs at a fixed seed and 260/260 at a
  different one; the async order array is reproduced EXACTLY (10 000/10 000) by an
  independent re-implementation seeded the same way. **Four things C8+ should know.**
  (1) **There are TWO RNG cells** — `rngState` (JS step) and the WASM memory cell (WASM
  step), synced only at `initGrid` and `setRngSeed`. The naive P7 fix advanced only the
  former and was a SILENT NO-OP on WASM (measured: `js 3748443150` vs `wasm 4242` after one
  step). `nextRandom()` now reads whichever cell the ACTIVE engine advances and writes both;
  any future engine-side draw must go through it. (2) The async order shuffle is **in place
  over the running permutation**, so comparing two shuffles taken at different points in a
  session compares different INPUTS — verify by PREDICTING the result, not by repeating the
  seed mid-session. (3) The GRA archetype seeds a **Custom** profile, not `socialGraph`: the
  audit found both shipped GRA flagships run force/body/soft/physics-bonds/charge-on and
  `socialGraph` has no layout at all. If C8's taint check wants a "typical GRA config",
  `GRA_PROFILE` in `archetypes.ts` is it. (4) C7 also fixed a C1 reason this feature made
  prominent: an agent graph with **no behaviour root yet** (every freshly created agent
  model) used to report an invented capacity/fundamentals blocker; it now names the real
  cause. C8 may proceed.

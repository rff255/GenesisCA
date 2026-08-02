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
| C2 | P3 Generation Pipeline panel (+ tempo tags) | pending |
| C3 | P4 fast-path diagnostics popover + P8 generated capability docs | pending |
| C4 | P1 engine enum + Auto + JS demotion + Show Code = JS reference | pending |
| C5 | P10 reproducibility contract + Auto integration | pending |
| C6 | P5 schema hygiene + update-mode vocabulary + loud-fallback completion | pending |
| C7 | P6 archetype-first New Model + P7 determinism (seeded scatter) | pending |
| C8 | P9 presentational-geometry taint check + pipeline label | pending |
| C9 | Capability STEP 4/6 — Static motion integrator + SoA field gating | pending |
| C10 | P11a deterministic Barnes-Hut global charge (all targets) | pending |
| C11 | P11b adaptive spatial index (benchmark-gated investigation) | pending |

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

*Completion Report: — to be appended by the phase session —*

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

*Completion Report: — to be appended by the phase session —*

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

*Completion Report: — to be appended by the phase session —*

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

*Completion Report: — to be appended by the phase session —*

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

*Completion Report: — to be appended by the phase session —*

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

*Completion Report: — to be appended by the phase session —*

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

*Completion Report: — to be appended by the phase session —*

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

*Completion Report: — to be appended by the phase session —*

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

*Completion Report: — to be appended by the phase session —*

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

*Completion Report: — to be appended by the phase session —*

---

## Orchestrator log

- 2026-08-02: runbook created. Launching C1.
- 2026-08-02: **C1 DONE** (`4ddca6f`). Compile-identity byte-identical on all 29 models; parity /
  force / render harnesses green; verified in-browser on Amphiphile, Growing Tissue, Cubic GRA,
  Game of Life + a provoked demotion (amber chip) and its negative control. C2 (Generation
  Pipeline panel) may proceed — it can reuse C1's `diagnoseTargets` resolvers and the
  `effectiveAgentDt` helper for its resolved numbers.

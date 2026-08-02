# PLAN — C2: the Generation Pipeline panel (P3)

Phase C2 of [HANDOFF_CLARITY_SIMPLIFICATION.md](HANDOFF_CLARITY_SIMPLIFICATION.md).
Implements [PROPOSAL_CLARITY_SIMPLIFICATION.md](PROPOSAL_CLARITY_SIMPLIFICATION.md) **P3**
(the implicit-pipeline diagnosis, §1.3) + its **tempo tags** (Appendix A).

Illustrated mockup: [PLAN_CLARITY_C2.html](PLAN_CLARITY_C2.html).

**Read-only phase. ZERO behaviour change** — nothing in this plan touches the engine, a
compiler, the worker, or any emitted surface. `check-compile-identity` must stay
byte-identical on every model.

---

## 1. The problem, restated from the diagnosis

The CA-grid contract is legible: *the graph is the rule; the engine double-buffers and runs
the colour pass.* The AGENT generation is ~14 interleaved phases, only two of which are the
user's graphs — and **nothing shows the user that sequence**, which phases are active *for
their model*, or which resolved config values each phase reads.

The engine already gates each phase honestly (the Agent Capability Profiles "honest-controls"
pass made every physics capability drive real engine behaviour). What is missing is making
the *pipeline itself* visible.

Concretely, a user cannot today answer any of these from the UI:

- "Is the engine applying forces to my agents, or only my Apply Force?"
- "My Growth capability is on — does the ramp actually run?" (it needs `growthRate > 0` too)
- "Where does my Division Event run, and how often?"
- "What is the actual Δt / momentum / speed cap the integrator uses?"
- "Is `Skip Isolated Empty Cells` doing anything for this model?" (it is ignored on WebGPU,
  on async, on agent models, on glyph models — four silent no-ops)

---

## 2. What ships

### 2.1 `src/model/generationPipeline.ts` (new, pure)

```ts
describeGenerationPipeline(model: CAModel): PipelinePhase[]

interface PipelinePhase {
  id: string;                 // stable — tests + the C8 hook key off it
  title: string;
  owner: 'graph' | 'engine';
  tempo: 'generation' | 'event' | 'frame' | 'reset';
  active: boolean;
  capability?: string;        // shown when !active: "(off — Growth)"
  detail?: string;            // resolved numbers / formula
  presentation?: boolean;     // RESERVED — C8 sets it; C2 never writes it
}
```

**THE DESIGN RULE (inherited from C1's `targetDiagnosis.ts`)**: every `active` bit comes from
the function the ENGINE consults, never a parallel hand-written truth.

| Phase's activity | Resolved by |
|---|---|
| soft-sphere collision | `usesSoftCollision(cfg)` |
| positional projection | `usesPositionalCollision(cfg)` + `cbNum(cfg,'positionalIterations')` |
| bond springs | `usesEngineSprings(cfg)` |
| long-range charge | `usesCharge(cfg)` + `chargeParamsOf(cfg)` |
| growth ramp | `usesEngineGrowth(cfg) && cbNum(cfg,'growthRate') > 0` |
| auto-bond | `usesEngineSprings(cfg) && cfg.autoBond && resolveMaxBonds(cfg) > 0` |
| bond store / sweep | `resolveMaxBonds(cfg) > 0` |
| structural queue drain | `agentGraphUsesBondRequests(model)` — the gate that SIZES the queue |
| divisions | `dividePartitionTableForModel(model).length > 0` — the table the engine INDEXES |
| force iterations | `layoutIterationsOf(cfg)` |
| integration formula | `cbNum` momentum / maxSpeed / drag + C1's `effectiveAgentDt(cfg)` |
| sync attr prime/commit | `cfg.agentUpdateMode === 'sync'` |
| sparse cell stepping | `sparseSteppingEnabled(model)` |
| async cell order shuffle | `properties.updateMode === 'asynchronous'` + `asyncScheme` |
| cadence (Periodic Step) | `periodicParams(config)` — the SAME clamp the lowering applies |

The handful of facts with no resolver — "does the graph contain a Kill Agent / a Division
Event root / a sprite node" — come from a **macro-aware node scan** (the `walkNodes`
discipline C1 established). This is stated in the module header and in the report: those are
graph-content questions, not config questions, so a scan IS the source of truth. The
`bondReqSlots` / `dividePartitionTable` cases are deliberately routed through the engine's
own usage gates rather than a local scan, precisely because those gates exist.

**Phase ORDER mirrors the documented loops exactly**, read out of the shipped code
(`sim.worker.ts` `runAgentStep` / `runAgentStructuralPhase` / `runStep`, the step-message
batch loop, and the reset handler):

```
RESET   1. Init Event (per cell)                     graph
        2. Grid Init Event (once)                    graph
        3. Agent Init Event (once)                   graph

GEN     4. Reset force accumulators                  engine
        5. Build spatial hash                        engine     [bin edge …]
        6. Prime synchronous attribute buffer        engine     (sync only)
        7. YOUR BEHAVIOUR STEP GRAPH                 graph
        8. Commit synchronous attribute writes       engine     (sync only)
           ── force iterations ×N ──
        9.   Long-range charge                       engine
       10.   Soft-sphere collision                   engine
       11.   Bond springs                            engine
       12.   Integrate + commit positions            engine     v = m·v + (Δt/η)·ΣF, cap …
       13.   Growth ramp                             engine
           ── end iterations ──
       14. Positional collision projection           engine
           ── structural phase ──
       15.   Drain bond-request queue                engine
       16.   Deaths                                  engine
       17.   Divisions                               engine
       18.   YOUR DIVISION EVENT GRAPH               graph      [event tempo]
       19.   Auto-bond by distance                   engine
       20.   Stale-bond sweep                        engine
           ── end structural ──
       21. Advance sprite frames                     engine
       22. Refresh rule-readable indicators          engine
       23. YOUR GENERATION STEP GRAPH (cells)        graph
       24. Double-buffer swap                        engine     (sync only)
       25. Indicator aggregation                     engine

FRAME  26. Colour pass — cells (A→C)                 graph/engine
       27. Colour pass — agents (A→C)                graph/engine
```

Agents step BEFORE cells — the documented closed agent↔grid loop (Decision D-FIELD: the
agent gathers the field as of the previous cell step, deposits, then the cell CA steps).

A **grid-only** model gets the short list: the reset roots it has, 23–26.
An **agents-only** model omits 23–26's cell half.

### 2.2 Properties → a "Generation Pipeline" collapsible section

Reuses the existing `CollapsibleSection` (id `pipeline`, persisted in
`genesisca_properties_collapsed`), placed directly under **Compatibility** — C1 answers
*"which engine?"*, C2 answers *"what does it do?"*.

Row anatomy:

```
 ┌── owner rail (accent = your graph, grey = engine)
 │
 ▌ 7  Your Behaviour Step graph                     [per generation]
 ▌    runs once per agent
 │ 12 Integrate + commit positions                  [per generation]
 │    v = 0.9·v + (0.05/1)·ΣF, speed cap 2.0
 │ 13 Growth ramp                            (off — Growth)   ← struck + dimmed
```

- **Owner attribution** is the point of the panel: a left rail + a colour separates *your
  graph* from *the engine*. A legend states it once.
- **Tempo chip** per row (`per generation` / `per event` / `per frame` / `once per reset`),
  colour-coded, so Appendix A's "is this in the hot path?" is answerable at a glance.
- **Inactive rows** render struck + dimmed with `(off — <capability>)`. They are NOT hidden:
  seeing that bond springs exist and are off is the clarity win.
- **Nesting**: the force-iteration group and the structural group render with a bracket +
  a group header carrying its own resolved number (`×2 iterations`).

### 2.3 `scripts/test-generation-pipeline.mjs` (drift guard)

1. **Activity ⇔ resolver** over a synthetic-config MATRIX: bonding on/off × collision
   (off/soft/positional) × growth × charge × sparse × async/sync (grid and agents) ×
   topology (agents-only / grid-only / both). For each combination the harness calls the
   REAL resolvers itself and asserts the phase's `active` bit equals them. A drift in either
   direction fails.
2. **Phase ORDER** against a hard-coded expectation list — changing the order must be a
   conscious edit of the test (the runbook's explicit requirement).
3. **Shipped models**: every `public/models/*.gcaproj` produces a pipeline; per-model
   spot-assertions for the five verification models.
4. **NEGATIVE CONTROLS** (≥1 required; we ship several): mutate a config so a phase's
   expected activity flips and assert the harness CATCHES it — proving the test can fail.

### 2.4 Docs sweep

- **CLAUDE.md**: a new subsection under the clarity work documenting the module, the
  single-source rule, the phase order, and the "scan vs resolver" split.
- **HelpView**: a "What runs each generation" explainer whose phase list is **rendered from
  `describeGenerationPipeline`** on a representative synthetic model — no hand-written
  duplicate table (the runbook forbids one).
- **README**: one bullet.

---

## 3. Explicit non-goals (this phase)

- **Not editable.** The proposal's §4 says so: a user-orderable engine pipeline reopens every
  cross-target verification. Read-only is 90 % of the value.
- **Not a live runtime view.** Whether residency/sparse ENGAGED at runtime is C3's
  diagnostics popover. C2 describes what the model asks for, from the model alone.
- **`presentation` is reserved, never set.** C8 (the geometry taint check) sets it and adds
  the "presentation only" label. C2 ships the field so C8 needs no shape change.
- **The worker does not iterate this table.** The proposal notes that would make drift
  impossible; it is a large engine refactor. v1 is a parallel description pinned by a
  harness — exactly the "existing harness culture can pin agreement" fallback the proposal
  named.

---

## 4. Risk + verification

| Risk | Mitigation |
|---|---|
| The description drifts from the engine | Every activity bit calls the engine's own resolver; the harness re-derives them independently and compares |
| Phase order silently reordered | Hard-coded order expectation in the harness |
| A behaviour change sneaks in | Read-only module + a new UI section only; `check-compile-identity --compare` on all models |
| The panel misleads on a model I did not test | In-browser verification on 5 models spanning grid-only / flocking / bonded+division / field+sequential / GRA-with-cadence |

In-browser verification targets (from the runbook):

| Model | What it must show |
|---|---|
| Boids — Flocking | motion/integration active; bonds, springs, growth, division struck |
| Morphogenesis - Growing Tissue | springs + growth + division + structural active, resolved formula |
| Ant Necrophoresis | sequential (async agents) tag; field-deposit note |
| Game Of Life | grid-only short list |
| Cubic GRA | structural queue-drain detail + its Periodic Step cadence note |

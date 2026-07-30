# PHASE P6 — Graph indicators + the Overseer rule-space sweep

**Read first**: [HANDOFF_GRAPH_REWRITING_AGENTS.md](HANDOFF_GRAPH_REWRITING_AGENTS.md)
§0 (invariants), §3, §5. Design authority:
[IMPACT_MAP_GRAPH_REWRITING_AGENTS.md](IMPACT_MAP_GRAPH_REWRITING_AGENTS.md) §3.7 (the gap),
§5 (I1 — which is also this phase's oracle) ·
[PLAN_GRAPH_REWRITING_AGENTS.md](PLAN_GRAPH_REWRITING_AGENTS.md) §P6, §4 (O10).

**State**: READY · **Depends on**: nothing structurally · **Blocks**: P7's Overseer sweep

---

## 1. Why this phase exists

GRA research is not "watch it run" — it is **"roll a rule, measure what it did,
keep the seed"**. Suzudo's whole programme was a search over rule tables. GenesisCA
already has the search half (seeded table Randomize + the Overseer: sweep, replicate
statistics, journal, CSV export). What it lacks is the **measurement** half: there is
no way to ask *how many nodes and edges are there, what is the degree distribution,
did the graph fragment*.

Today the only workaround is a standalone indicator plus `Update Indicator`
*increment* per agent — which works on JS/WASM but is order-dependent on WebGPU, and
is laborious for anything beyond a single counter.

---

## 2. Scope — what you build

### 2.1 A new indicator kind

`Indicator.kind` is currently `'standalone' | 'linked'`. Add **`'graph'`** with a
`graphMetric` field:

| metric | shape | cost |
|---|---|---|
| `nodeCount` | scalar | O(1) — `liveCount` |
| `edgeCount` | scalar | O(N) — via I1, `Σ bondCount / 2` |
| `meanDegree` | scalar | O(N) |
| `maxDegree` | scalar | O(N) |
| `degreeHistogram` | **frequency map** (degree → count) | O(N) |
| `componentCount` | scalar | O(E·α) union-find |

`degreeHistogram` is frequency-map-shaped, so it renders through the **existing**
bars / lines / stacked chart machinery with no new chart code — that is the point of
choosing that shape.

### 2.2 Where it computes

In the worker, **after the structural phase** (so the reported graph is the settled
one the user sees), over the agent store. **Compute a metric only when an indicator
for it exists** — `componentCount` is the only non-trivial one and nobody should pay
for it unless they asked. State the measured cost of `componentCount` at a realistic
population in the report.

**Reuse I1 as the implementation and the test.** `edgeCount` = `Σ bondCount / 2` is
exactly the handshake lemma, which `verify-graph-rewrite.mjs` already checks — so the
indicator and the invariant validate each other.

### 2.3 Surfacing

- Render like other indicators (the value display + charts + the ⌫ clear + the ⚙
  chart settings). Scalars use the sparkline path; `degreeHistogram` uses the
  frequency path.
- **Readable by `ovReadIndicator`** so the Overseer can sweep — that is the whole
  point. A frequency-shaped metric takes a category exactly like a linked-frequency
  indicator does.
- The Indicators panel (in Properties) gets the `graph` kind with its metric
  dropdown. **Gate the kind on `topologyMode.agents`** — a graph indicator is
  meaningless without an agent layer.
- Spatial axes (rows/columns/layers) are **not applicable** — exclude graph
  indicators from the spatial path, as the existing code excludes standalone ones.

### 2.4 An Overseer sweep protocol

Demonstrate the research loop end to end:

```
Clear Series
forEachInArray(ovSweepValues [seeds])
  ovRandomizeTable(rule, seed = element, density = …)
  ovResetBoard
  ovRunUntilStop(N)
  ovCollectSample(nodes  ← ovReadIndicator nodeCount)
  ovCollectSample(edges  ← ovReadIndicator edgeCount)
  ovCollectSample(degree ← ovReadIndicator meanDegree)
  ovLog
```

Ship it as a protocol inside the P7 sample if that reads better — coordinate by
leaving it usable, and say in your report where you put it.

---

## 3. What this phase must NOT do

- **Do not** add graph *nodes* (no "Get Node Count" value node) — this is a
  measurement layer, not new rule vocabulary. If a rule needs the count, that is a
  separate design conversation.
- **Do not** change the structural phase's ordering or the queue drain.
- **Do not** make any metric mandatory-cost.

---

## 4. Exit gate — all must pass, all recorded

| # | Criterion |
|---|---|
| **Exactness** | every metric agrees **exactly** with an independent recount from a `getState` payload — `edgeCount` against I1, `degreeHistogram` against a direct `bondCount` tally, `componentCount` against an independently written union-find in the harness. Assert values, not shapes. |
| **A fragmenting graph** | `componentCount` tracks a graph that is deliberately split (break the bonds joining two halves) — 1 → 2 → back to 1. A metric that only ever reports 1 would pass a weaker test. |
| **O10 growth-law statistics** | each node divides with probability `p` ⇒ `E[N_t] = N₀(1+p)^t`; 20 Overseer replicates, the mean inside the CI. This exercises the whole sweep harness, not just the metric. |
| **Sweep reproducibility** | a ≥16-seed sweep produces a rule→outcome table, **identical across two runs** (same seeds ⇒ same values), exported to CSV. |
| **Zero cost when unused** | a model with no graph indicator must not compute any of them — demonstrate it (a counter or a timing), do not merely assert it. |
| Byte identity | `check-compile-identity --compare .gra-baseline/compile-identity-P5.json` — all 26 models unchanged (this phase should touch no compiler at all; if it does, justify). |
| Standard gates | tsc · build · `parity-agent-wasm` · `check-agent-wasm-gate` · `audit-agent-layout` · `test-agent-abi` · `verify-graph-rewrite` · `verify-agent-render` |
| Real UI | create each metric in the Modeler, watch it chart in the Simulator during a run, and run the Overseer sweep through the real panel. Record what you observed. |

---

## 5. Assumptions to check FIRST (stop and report if any is false)

1. **`Indicator.kind` is genuinely extensible** — adding a third kind does not require
   touching every consumer with an exhaustive switch that silently defaults. Grep the
   consumers first; if a `kind` switch defaults to a wrong branch, report before building.
2. **`ovReadIndicator` reads whatever is in the worker's indicator map**, so a new
   producer needs no Overseer change. Verify — the Overseer is a separate compiler.
3. **The worker has the agent store available at the point you intend to compute** —
   and on the WebGPU agent target the CPU mirror is fresh there (the readback has
   already happened). If it has not, the metric would silently report a stale
   generation on that target only — check, do not assume.

---

## Completion Report — P6

**State**: DONE
**Commit(s)**: see the Status Board row in the master handoff
**Files touched** (`git diff --stat`, excluding docs):

```
 scripts/gen-graph-metrics-sweep.mjs            | NEW  (the sample generator)
 scripts/verify-graph-rewrite.mjs               | +Tier I + Tier I mutants
 src/simulator/engine/graphMetrics.ts           | NEW  (the ONE implementation)
 src/simulator/engine/sim.worker.ts             | graphDefs + computeGraphIndicators + the DEV probe
 src/simulator/SimulatorView.tsx                | ship `graphMetric` in init + updateIndicators
 src/simulator/IndicatorDisplay.tsx             | the graph kind's shape flags + badge
 src/simulator/indicatorChartSettings.ts        | designTimeSeriesKeys for the graph kind
 src/model/types.ts                             | IndicatorKind += 'graph'; Indicator.graphMetric?
 src/model/ModelContext.tsx                     | ADD_INDICATOR seeds the metric
 src/modeler/panels/IndicatorsPanelSection.tsx  | + Graph button, metric dropdown, badge, hide Accumulation
 src/modeler/panels/PropertiesPanelContent.tsx  | end-condition category for the histogram
 src/modeler/vpl/CaNode.tsx                     | ovReadIndicator category for the histogram
 src/modeler/vpl/nodes/nodeValidation.ts        | ovReadIndicator requires a category for the histogram
 public/models/Graph Metrics - Growth Sweep.gcaproj | NEW  (the sample)
```

**NO compiler file was touched** — not `compiler/**`, not any agent/target emitter.

### What shipped
- **A third `Indicator.kind`, `'graph'`**, with `Indicator.graphMetric?` — six metrics: `nodeCount`,
  `edgeCount`, `meanDegree`, `maxDegree`, `degreeHistogram` (frequency-shaped) and `componentCount`.
- **[src/simulator/engine/graphMetrics.ts](../src/simulator/engine/graphMetrics.ts)** — the SINGLE
  implementation, taking the same normalised graph view the harness's `decodeAgentGraph` produces,
  so a live `AgentStore` and a `getState` payload are interchangeable. `computeGraphMetrics(view,
  metrics, passes?)` shares ONE O(N) degree pass across edge/mean/max/histogram and runs the
  union-find ONLY when `componentCount` is asked for.
- **Worker**: `graphDefs` built in `initIndicators`, `computeGraphIndicators()` called from
  `sendColors` (the one message-assembly point — after the batch's structural phase, and after every
  mutation tail), results merged into the SAME id-keyed `indicators` payload. A DEV
  `__graphIndicatorStats` probe reports `calls / degreePasses / componentPasses` — the evidence for
  the zero-cost claim.
- **UI**: "+ Graph" in Properties → Indicators (gated on `topologyMode.agents`), a Graph Metric
  dropdown with per-metric hints, Accumulation hidden for the kind, `GRAPH` / `G` badges, and the
  frequency-shaped histogram riding the existing Bars / Lines / Stack charts with **no new chart code**.
- **`ovReadIndicator` needed no Overseer change** (assumption 2 held); the histogram's category is
  offered as a real list (degrees `0..maxBonds`) in CaNode and required by `nodeValidation`.
- **`verify-graph-rewrite.mjs` Tier I** (230 → **297** checks) + a **Tier I source-mutation** block.
- **The sample `Graph Metrics - Growth Sweep`** + its two-phase Overseer protocol (where the §2.4
  protocol went — it is a shipped library model, so P7 can adopt or clone it directly).

### Decisions resolved
| ID | Decision taken | Why |
|---|---|---|
| where the metrics compute | **`sendColors`**, not the structural phase | It is the ONE message-assembly point, so it covers the batch tail AND every mutation tail (reset / paint / seed / load state) with one call, and it is exactly the granularity every consumer observes (charts, end conditions, `O.indicator` all read the `stepped` payload). It runs after the structural phase by construction. |
| `degreeHistogram` categories | the **FIXED** window `0..maxBonds`, not the observed range | A stable key set keeps the multi-line / stacked charts coherent, pins palette slots by position, and makes the categories design-time enumerable (`designTimeSeriesKeys`). |
| Accumulation on a graph indicator | **hidden**, not shown-and-inert | A graph metric is an instantaneous measurement of the settled graph, not a per-step quantity to sum. The project's own rule: never expose a control that does nothing. |
| where the sweep protocol lives | a **shipped library model**, not a doc snippet | §2.4 allowed either; a runnable model is what "leave it usable" means, and it doubles as the O10 + reproducibility vehicle. |
| the sample's agent target | **`wasm`** (a documented exception to the WebGPU-where-gated-in policy) | See the finding below: the Overseer's seed policy cannot reach the WebGPU agent PCG, so a sweep there is not reproducible. Both gates DO accept the model. |
| the sample's seed pattern | **`compact`** | See the finding below. |

### Assumptions that proved FALSE
**None of the three §5 assumptions failed.** For the record, with the evidence:

1. **`Indicator.kind` IS extensible.** Every value-shape-driven path works unchanged: history
   collection in `SimulatorView` (branches on `typeof v`), all four chart components, end-condition
   evaluation, and `O.indicator`. There are `kind`-switch sites that would have defaulted to the
   LINKED branch, but **none silently produces a wrong VALUE** — they are cosmetic/affordance only,
   and all are fixed here: the list badge, the simulator `S`/`L` badge, `designTimeSeriesKeys` (a
   graph SCALAR fell through and returned `[]`), `isScalarDef`/`isFreqDef`, the `ovReadIndicator`
   category widget + validation, and the end-condition category widget. The worker's
   `initIndicators` `if/else if` simply had no `graph` arm (added). The two worker sites that DO
   filter on `kind === 'standalone'` (`isIntEncodedIndicator`, `agentWebgpuIndicatorIsInt`) correctly
   exclude graph — nothing in a rule graph writes it.
2. **`ovReadIndicator` reads the worker's map.** `OvReadIndicatorNode.compile` emits
   `O.indicator(id[, category])`, and `overseerRuntime`'s `indicator()` reads `rt.lastIndicators[id]`,
   which is assigned wholesale from every `stepped` message's `indicators`. A new producer needs no
   Overseer change — verified end to end by the sweep, which reads all four metrics.
3. **The agent store is available and the CPU mirror is authoritative at the compute point.**
   Verified in code, not assumed: bond topology (`bondCount` / `bondPartner`) is only ever mutated by
   the CPU structural phase — the WebGPU behaviour shader reads `bondStore` and, since P3, writes only
   ATTRIBUTE lanes (`bondAttrWord = 2 + i` in `agentWebgpu/layout.ts`, never word 0 = partner);
   `agentAlive` is GPU-written only inside `addAgentToWorld` (i.e. under `usesSpawn`), reconciled by
   `readbackAgentStep` every generation on the per-generation GPU path. The ONE path that can leave
   the CPU mirror stale is the resident batch (`agentStoreStale = true` is set at exactly one site),
   and `agentResidentEligible()` requires **`s.maxBonds === 0` and `!rt.usesSpawn`** — so nothing the
   metrics read can change during it. The probe reports `agentStoreStale` so this stays checkable.

### Findings for later phases (NOT assumption failures — adjacent, pre-existing)
- **A reproducible experiment needs a reproducible INITIAL CONDITION.** `seedPattern: 'scatter'`
  places seeds with **`Math.random()`** (`sim.worker.ts` `initAgents`, deliberately — "seeding is a
  one-time setup, not part of the replayable step"). Invisible to a geometry-blind rule, but a rule
  that reads **bond degree** is geometry-coupled: degree comes from the division bond-partition,
  which is computed from the TENSION AXIS, i.e. from positions. **Measured**: with `scatter`, the
  Phase A replicates (a degree-INDEPENDENT rule) reproduced exactly across runs while the Phase B
  sweep did not; with `compact`, two full runs export byte-identical CSV. **P7's samples must seed
  deterministically.**
- **Sweep on JS/WASM, not the WebGPU agent target.** The seed policy drives `setRngSeed`, which
  re-seeds the shared xorshift32 stream JS/WASM use. The WebGPU agent target's per-agent PCG is
  seeded ONCE at runtime creation (`seedAgentRng(rt, 0x1234abcd)`) and `setRngSeed` never reaches it,
  so a WebGPU-agent experiment does not reproduce across runs. Making it reproducible would mean
  re-seeding the agent PCG from `setRngSeed` — a small, self-contained follow-up, deliberately NOT
  taken here (out of P6's scope, and it changes an RNG stream).

### Verification
| Gate | Result |
|---|---|
| tsc / build | clean (`tsc -p tsconfig.app.json --noEmit`, `npm run build`) |
| parity-agent-wasm | ALL AGENT SAMPLES: JS↔WASM BIT-PARITY ✓ (incl. every synthetic) |
| check-agent-wasm-gate | 12/12 GATE✓ COMPILE✓ INST✓ (incl. the new sample, bytes=2534, types=9) |
| audit-agent-layout / test-agent-abi | 156 checks ✓ / 28 ✓ |
| check-compile-identity | `--compare .gra-baseline/compile-identity-P5.json` → **26 models, all surfaces unchanged** (this phase touched no compiler) |
| verify-agent-render | ✓ |
| verify-graph-rewrite | **297 passed, 0 failed** (230 → 297; Tier I + the source-mutation block) |
| Real in-browser run | see below |

**Tier I in detail** — 8 graph fixtures (ring-12, ring+3 chords, star K1,7, 5 isolated, two disjoint
K4, a ring-20 with 4 agents killed, a seeded random 24-node graph, the empty population), each with
all six metrics compared against independently written references (`refComponents` is a **BFS flood
fill**, a different algorithm shape from the shipped union-find), the store's `liveCount` cross-checked
against an `alive` scan, `edgeCount == Σdeg/2 == |distinct pairs|` with I1 green, and the histogram
totalling N. Then: the `getState`-payload path gives identical numbers; a **fragmenting graph**
1 → (one bridge cut) 1 → (both cut) **2** → (re-joined) 1 → (cut vertex killed) 2, with a
`NEG: the metric is not a constant 1`; the pass counters; four data-level negative controls; and
**seven SOURCE-MUTATION negative controls** on `graphMetrics.ts`, each rebuilt in isolation and each
CAUGHT (drop the `/2`, drop the alive check, latch the first max degree, divide by `highWater`, never
decrement the union-find, union across a dead partner, drop the last histogram bucket).

**Measured `componentCount` cost** at a realistic population: **20 000 live agents / 46 247 edges →
2.07 ms** (the shared degree pass 0.87 ms; all six together 1.77 ms), and still exact against the BFS
reference at that scale.

**Real in-browser run** (dev server, visible pane, real worker, WASM agent target):
- **Exactness**: after 30 generations, the `stepped` payload's six values match a page-side
  independent recount from a `getState` payload with **0 diffs** — N=77, E=61, meanDeg=1.5844155844,
  maxDeg=4, histogram `{0:4,1:36,2:27,3:8,4:2,…}` summing to 77, components=16 — with Σdeg = 122 = 2·61.
- **Simulator UI**: all six render with the `G` badge; scalars as sparklines, the histogram cycling
  Bars → **Lines** (one coloured curve per degree, screenshot-confirmed) → Stack through the existing
  chart code; `components` draws a flat line at 16 (the conservation law).
- **Modeler UI**: "+ Graph" appears (agents topology on), creates an indicator, and its Graph Metric
  dropdown cycles through **all six** with the right hint each time; Accumulation is absent. A metric
  created mid-session reaches the worker via `updateIndicators` and reports the same value as its twin.
- **O10 through the real Overseer panel**: 20 replicates → mean N₄₀ = **121.65**, std **25.744**,
  n=20 → SE 5.757, 95% CI **[110.37, 132.93]**; the theoretical `16·1.05^40 = 112.64` is **inside** it
  (1.57 SE away). The branching process's theoretical sd ≈ 24.8 also matches the observed 25.74.
- **Sweep reproducibility**: two full presses of Run Experiment export **byte-identical CSV**
  (85 rows, 0 diffs) covering both phases. The 16-seed rule→outcome table spans N = 28..184 with
  `E = N − 16` and `components = 16` in **every** row.
- **Zero cost when unused**: Boids (an agent model with a live store and no graph indicator) ran
  **200 generations over 40 batches** and `__graphIndicatorStats` reports
  `defs: [], calls: 0, degreePasses: 0, componentPasses: 0`.
- **0 fresh console errors** on a clean page load + model load + stepping + panel exercise.

### Invariants
| ID | Held? | Evidence |
|---|---|---|
| I1 handshake | ✓ | It IS `edgeCount`. Asserted on all 8 Tier I fixtures (`Σdeg/2 == |distinct pairs|` AND `checkHandshake === null`) and in the real worker (Σdeg 122 = 2·61). |
| I2 symmetry | ✓ | `checkBondSymmetry` green on the fragmented graph after bridge cuts; the rest of the harness unchanged. |
| I3 no dangling | ✓ | Unchanged (no engine change); the exactness comparison would diverge if a partner were dangling, since the shipped `edgeCount` uses Σdeg/2 and the reference counts live pairs. |
| I4 capacity | ✓ | Unchanged; the histogram clamps to `0..maxBonds` so a capacity violation shows as a moved bucket rather than a silent drop. |
| I5 atomicity | ✓ | Unchanged (P4/P5 own it); the sweep's 16 runs kept `E = N − 16` exactly, which a half-applied division would break. |

### Known gaps / follow-ups for the next phase
- **P7 can use the sample's protocol directly** — `Graph Metrics - Growth Sweep`'s Overseer graph is
  the `Clear Series → Randomize → replicate loop → sweep forEach → Collect → Log` shape the plan
  specifies, already wired to graph indicators. Clone it into Cubic GRA and swap the rule.
- **Seed deterministically** (`compact` or an Agent Init Event) in any model that will be swept, and
  **run sweeps on the JS or WASM agent target** — see the two findings above.
- **A degree-regularity metric is NOT part of P6.** I6 (`min == max == d`) lives in the harness
  (`checkDegreeRegular`); if the Cubic GRA sample wants it on screen, `maxDegree` + the degree
  histogram already show it (a cubic graph reads `maxDegree == 3` with the whole histogram in
  bucket 3), so no new metric is needed.
- **`componentCount` counts an isolated agent as one component.** Deliberate and standard; a model
  that wants "components of size ≥ 2" would need a new metric, not a change to this one.

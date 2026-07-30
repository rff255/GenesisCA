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

*(fill in per the master handoff §5 template)*

# Plan — Graph Layout (charge force) + Rule Cadence

> Design authority: [IMPACT_MAP_GRAPH_LAYOUT_CADENCE.md](IMPACT_MAP_GRAPH_LAYOUT_CADENCE.md).
> Execution: [HANDOFF_GRAPH_LAYOUT_CADENCE.md](HANDOFF_GRAPH_LAYOUT_CADENCE.md).
> Illustrated: [PLAN_GRAPH_LAYOUT_CADENCE.html](PLAN_GRAPH_LAYOUT_CADENCE.html).

**Goal.** Make a grown bond graph *readable* and *fast*, and give the rule graph
control over **when** it rewrites — without putting solver internals in the graph.

Three phases, strictly sequential. L1 is the fix; L2 is an independent generic
primitive; L3 is the visible payoff and depends on both.

---

## L1 — The charge force

**The one-line change in concept, the four-surface change in practice.** Add a
long-range repulsive term with a finite cutoff to the fused pair loop, gated behind a
new capability, default off.

**Deliverable**
- `AgentCapabilities.charge` (`'off' | 'on'`), closure requires `motion: 'force'`.
- `CenterBasedConfig.chargeStrength` (default ≈ −3) and `chargeMaxDist`
  (default ≈ 8 × bond rest length — Impact Map §1.3), with `usesCharge(cfg)` resolved
  the way `usesSoftCollision` is.
- The law `f = strength·(1/(1+d²) − 1/(1+maxDist²))·(p_j − p_i)`, added to the fused
  neighbour pass on **JS (2D and 3D arms), WASM, WebGPU, and the B1 mirror variant**.
- The charge cutoff joins the hash `binEdge` max.
- Properties UI: a Charge section under Bond-Graph Agents, revealed when the
  capability is on.

**Exit gate**
| # | Criterion |
|---|---|
| **The measured fix** | `probe-graph-layout.mjs` on a grown 1200-node cubic graph: overlap **99.2 % → ≤ 1 %**, nearest-non-bonded ÷ bond **0.06 → ≥ 0.6** |
| **Byte identity** | charge **off** ⇒ all 28 models unchanged on every surface |
| **JS↔WASM bit-parity** | `parity-agent-force.mjs` with **new charge combos** (on/off × 2D/3D × torus/bounded × collision on/off) |
| **The bin-edge trap** | a test proving the stencil covers `chargeMaxDist` — i.e. a pair at 0.9 × cutoff **is** counted. Without it, truncation is silent. |
| **The B1 mirror** | the mirror force variant produces the same result as the canonical one **with charge on** |
| **3D** | works and is measured; document the practical cutoff (the stencil is a volume) |
| **Real GPU** | 2D + 3D shaders compile 0 errors; a real run, 0 worker/GPU errors |
| Standard | tsc · build · `parity-agent-wasm` · `check-agent-wasm-gate` · `audit-agent-layout` · `test-agent-abi` · `verify-graph-rewrite` · `verify-agent-render` · `verify-render-uniform-layouts` |

---

## L2 — Rule cadence

**Deliverable**
- **`Get Generation`** — a universal value node (cells **and** agents), all targets,
  returning the current generation as an integer. Defined behaviour in the Agent Init
  Event and the Division Event (pin it, test it).
- **`Periodic Step`** — an event root with `period` + `phase` (+ a `Step Index`
  output = ⌊gen/period⌋), **multiple allowed**, implemented as a **pure pre-compile
  lowering** into the single `behaviourStep` (`sequence` + `conditional`). Zero
  per-target emit.
- **The GPU residency counter** — a storage-buffer generation counter bumped by a
  pass that already runs per generation, because `dispatchResidentBatch` submits all
  N generations at once with no CPU touch point (Impact Map §3.2).

**Exit gate**
| # | Criterion |
|---|---|
| **Residency correctness** | on the resident WebGPU path, a rule reading `Get Generation` over a **multi-generation batch** observes **N distinct values**, not one repeated. Assert the values, and negative-control it (a uniform-only implementation must fail this). |
| **Cadence works** | a Periodic Step at period 10 fires on exactly gens 0,10,20,… — asserted by value on **all three targets** |
| **Two phases** | period 2 / phase 0 and period 2 / phase 1 reproduce the reference's alternating states-then-divisions scheme |
| **Byte identity** | no Periodic Step and no `Get Generation` ⇒ all 28 models unchanged |
| **Multiplicity** | ≥3 Periodic Steps at different periods coexist; `behaviourStep` singleton rules still hold |
| **Init / division semantics** | the pinned values, asserted |
| Standard | as L1, plus `parity-agent-wasm` with a **permanent cadence synthetic** carrying a value invariant |

---

## L3 — Solver iterations, sample retune, Expression refactor

**Deliverable**
- **`layoutIterations`** — an engine knob (default 1 = today's behaviour) running the
  force pass N× per generation. **Not** a graph node (Impact Map §1.6).
- **Sample retune**, using L1 + L2:
  - charge on, `chargeMaxDist` ≈ 8 × rest;
  - world enlarged/unbounded so the graph is not saturated (Impact Map §1.4);
  - **newborns placed at the parent midpoint**, not on top of the mother;
  - a `Periodic Step` so rewriting is slower than relaxation.
- **The Expression refactor** — replace the `arithmeticOperator` chains in the GRA
  models with `expression` nodes for conciseness (`Cubic GRA` 10 Math, `SDCA` 9;
  `Life on Bonds` already uses 2 Expressions, so the idiom is established and the
  node is agent-target-supported).
- Promote `probe-graph-layout.mjs` to a **permanent** layout-quality gate.

**Exit gate**
| # | Criterion |
|---|---|
| **The picture** | `Cubic GRA` at N ≥ 2000: overlap ≤ 1 %, nnb ÷ bond ≥ 0.6 — **and a screenshot in a visible pane showing a readable graph**. This is the phase's reason to exist; if the pane cannot be displayed, say so rather than claim it. |
| **Speed** | steps/s **improves** vs the pre-L3 model at equal N (the density argument, Impact Map §1.5) — report both numbers |
| **Behaviour preserved** | the Expression refactor is a **pure refactor**: O6 (`min deg == max deg == 3`, `E == 3N/2`) still holds every generation, and the rule's decisions are unchanged |
| **`layoutIterations` = 1 is byte-identical** | the default path must not move |
| Standard | full gate sweep + `verify-graph-rewrite` |

---

## Sequencing

```
L1 charge force  →  L2 cadence  →  L3 solver knob + samples + Expression refactor
```

L1 and L2 are technically independent, but L3 needs both, and serialising keeps
`agentEngine.ts` / the force pass under one editor at a time.

---

## Risks, ranked

1. **The hash bin edge** (L1). If the charge cutoff does not join the `binEdge` max,
   the force is silently truncated — the model looks plausible and is wrong. It has an
   explicit exit-gate test for exactly this reason.
2. **The B1 mirror force variant** (L1). A second force pipeline exists; missing it
   makes the mirror path diverge only for models that engage it.
3. **GPU residency and the generation** (L2). Measured: one submit for N generations.
   A uniform-based implementation is wrong *only there*, and only under a
   multi-generation batch — i.e. invisible to a single-step test.
4. **Mid-list ABI/param insertion** (L1, L2). P5 established that a mid-list lane
   shifts baked offsets and diffs every agent model. Append.
5. **3D cost** (L1). The charge stencil is a volume; the neighbour count grows
   cubically with the cutoff. Measure, document, do not assume the 2D default transfers.

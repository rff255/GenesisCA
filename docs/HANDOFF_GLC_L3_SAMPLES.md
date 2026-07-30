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

*(fill in per the master handoff §5 template, plus: the before → after probe metrics,
the before → after steps/s, and the screenshot evidence. Close with a short statement
of whether the original reported symptom — the unreadable blob — is resolved.)*

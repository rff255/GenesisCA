# PHASE L2 — Rule cadence: `Get Generation` + `Periodic Step`

**Read first**: [HANDOFF_GRAPH_LAYOUT_CADENCE.md](HANDOFF_GRAPH_LAYOUT_CADENCE.md)
§0 (invariants), **§0b (measured traps)**, §3.3 (the residency test).
Design authority: [IMPACT_MAP_GRAPH_LAYOUT_CADENCE.md](IMPACT_MAP_GRAPH_LAYOUT_CADENCE.md)
§1.6, §3, §5.

**State**: READY · **Depends on**: nothing · **Blocks**: L3

---

## 1. Why this phase exists

The reference layout engine decouples two clocks: it rewrites on a growth accumulator
while running physics **every frame**, so the layout gets ~120 relaxation iterations
per second against a much slower rewrite rate. GenesisCA runs **one physics step per
rewrite**, so the layout never settles.

**But there is no engine clock to decouple** — the force pass already runs
unconditionally every generation. What is missing is the **rule's** ability to say
*"only rewrite every Nth generation"*.

**Verified**: there is **no way to read the generation from a cell or agent rule
graph.** `ovGetGeneration` is Overseer-only; `generation` appears **0 times** in
`agentAbi.ts`.

**Design principle (the user's call, and correct):** cadence is *model semantics* and
belongs in the **rule graph** — that is what keeps GenesisCA generic. The one thing
that must **not** go in the graph is how many times the *solver* iterates per
generation; that is numerical relaxation, an engine knob (L3), the same category as
`positionalIterations`.

---

## 2. Scope — what you build

### 2.1 The primitive — `Get Generation`

A **universal** value node (cells **and** agents; not `bondGraph`-gated), outputting
the current generation as an integer, on all three targets. Immediately composable:

```
Get Generation → Expression("g % 10 == 0") → Conditional → [the rewrite]
```

Threading: one scalar into the agent ABI (`agentAbi.ts` — one edit, four mirrors
follow), the WASM param list (**append**), the WebGPU Control uniform, and the cell
step's parameters.

**Pin the semantics and test them:**
- What does it return in the **Agent Init Event** (before any step has run)?
- In the **Division Event**?
- On the **cell** grid vs the **agent** loop — are they the same counter?

State the answers in the Completion Report; a later phase must not have to guess.

### 2.2 The sugar — `Periodic Step`

An **event root** with `period` + `phase` config, **multiple allowed per graph**, plus
a **`Step Index`** value output = ⌊gen / period⌋ (the rule-step counter a GRA rule
actually reasons about).

**Implement it as a pure pre-compile LOWERING** into the existing single
`behaviourStep` — synthesize `sequence` + `conditional(gen % period == phase)` around
each root's chain. This is the P1 census pattern:

- **zero per-target emit** — all three targets work by construction;
- the capability gates see only already-supported node types;
- `behaviourStep` is **untouched**, so every existing model stays byte-identical.

Wire the lowering into all three agent front-ends at the same point the other
lowerings run.

⚠️ `behaviourStep` is in `SINGLETON_NODE_TYPES`. `Periodic Step` must be **exempt from
the singleton rule** while the synthesized `behaviourStep` still satisfies it.

`phase` matters as much as `period`: the reference alternates
`this.phase = 1 - this.phase` (states on even ticks, divisions on odd) — exactly two
Periodic Steps at period 2, phases 0 and 1.

### 2.3 THE delicate point — GPU residency

**Measured** (`agentWebgpuRuntime.ts` ~:2793): `dispatchResidentBatch` encodes **all N
generations into ONE command encoder and submits once**, with **no CPU touch point per
generation**. A generation supplied through the Control uniform is therefore
**constant for the whole batch** — silently wrong, on that path only, and invisible to
any single-step test.

**Fix**: a GPU-side generation counter in a **storage buffer**, incremented by a pass
that already runs once per generation (`posCommit` does). The behaviour shader reads
the counter instead of a uniform. Cheap, preserves residency.

**Alternative if that proves infeasible**: make a generation-reading model
residency-ineligible (correct but slow) — and **say so loudly**, because it silently
removes the resident fast path from a whole class of models.

---

## 3. What this phase must NOT do

- **No `layoutIterations`** and **no sample retuning** — L3.
- **No charge-force work** — L1.
- **Do not** put solver iteration count in the graph (Impact Map §1.6 — a category
  error).
- **Do not** change `behaviourStep` itself.

---

## 4. Exit gate — all must pass, all recorded

| # | Criterion |
|---|---|
| **THE residency test** | on the **resident WebGPU path**, a rule reading `Get Generation` across a **multi-generation batch** observes **N distinct values**, asserted by value. **Negative-control it**: implement/revert to a uniform-only read and watch this test fail. Without the negative control this test proves nothing. |
| **Cadence correctness** | a `Periodic Step` at period 10 phase 0 fires on exactly generations 0, 10, 20 … — asserted by value on **all three targets** |
| **Two phases** | period 2 / phase 0 and period 2 / phase 1 reproduce the alternating states-then-divisions scheme |
| **Multiplicity** | ≥ 3 Periodic Steps at different periods coexist and each fires on its own schedule; the `behaviourStep` singleton rule still holds |
| **Init / division semantics** | the values pinned in §2.1, asserted |
| **Byte identity** | no `Periodic Step` and no `Get Generation` ⇒ `check-compile-identity` unchanged on every surface |
| **Parity** | `parity-agent-wasm` with a **permanent cadence synthetic** carrying a **value invariant** (recomputed independently), JS↔WASM bit-identical |
| **Cells too** | `Get Generation` works in a cell rule, verified by value |
| Standard | tsc · build · `check-agent-wasm-gate` · `audit-agent-layout` · `test-agent-abi` · `verify-graph-rewrite` · `verify-agent-render` · `verify-render-uniform-layouts` |

---

## 5. Assumptions to check FIRST (stop and report if any is false)

1. **`posCommit` (or an equivalent) really runs once per generation inside the
   resident batch** and can host the counter increment. If no per-generation GPU pass
   exists on that path, the design changes — **stop and report**.
2. **The agent ABI can take one more scalar by appending** without shifting a baked
   offset, and the WASM param list likewise.
3. **The Control uniform has room** and its layout is registered in
   `verify-render-uniform-layouts.mjs` (watch alignment — a scalar after a `vec3`
   needs `@align(16)`).
4. **A non-singleton event root is expressible** — i.e. the compiler/validation can
   accept N `Periodic Step` roots. If the root-finding logic assumes exactly one
   behaviour-like root, say so before building.

---

## Completion Report — L2

*(fill in per the master handoff §5 template. State the pinned Init/Division semantics
explicitly — L3 and future phases will rely on them.)*

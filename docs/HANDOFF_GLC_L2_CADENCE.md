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

**State**: DONE
**Commit(s)**: `54fb4d5` — feat(agents): rule cadence - Get Generation + Periodic Step
**Files touched**
```
 CLAUDE.md                                           | docs (new "Rule Cadence" section)
 README.md                                           | docs
 docs/HANDOFF_GLC_L2_CADENCE.md                      | this report
 docs/HANDOFF_GRAPH_LAYOUT_CADENCE.md                | status board
 docs/NODES_REFERENCE.md                             | counts 151/148 -> 153/150 + 2 rows
 src/help/HelpView.tsx                               | docs
 scripts/parity-agent-wasm.mjs                       | the permanent cadence synthetic + value invariant
 scripts/test-rule-cadence.mjs                       | NEW — 107 checks
 src/modeler/vpl/nodes/GetGenerationNode.ts          | NEW
 src/modeler/vpl/nodes/PeriodicStepNode.ts           | NEW
 src/modeler/vpl/compiler/generationUse.ts           | NEW — the ONE usage predicate
 src/modeler/vpl/compiler/periodicExpand.ts          | NEW — the lowering
 src/modeler/vpl/compiler/agentAbi.ts                | the trailing `_generation` field
 src/modeler/vpl/compiler/compile.ts                 | cell params + agent shape + lowering
 src/modeler/vpl/compiler/wasm/{layout,compile}.ts   | generationOffset + the i32 load
 src/modeler/vpl/compiler/webgpu/{layout,encoder,compile}.ts | Control.generation
 src/modeler/vpl/compiler/agentWasm/compile.ts       | f64 load + gate + lowering
 src/modeler/vpl/compiler/agentWebgpu/compile.ts     | genCounter binding + gate + lowering
 src/modeler/vpl/{CaNode.tsx,nodes/{registry,nodeValidation}.ts} | UI + validation
 src/simulator/engine/agentEngine.ts                 | agent generationOffset
 src/simulator/engine/agentWebgpuRuntime.ts          | genCounter buffer + THE posCommit bump
 src/simulator/engine/webgpuRuntime.ts               | uploadCellGeneration
 src/simulator/engine/sim.worker.ts                  | the setGeneration seam + views + uploads
 src/simulator/SimulatorView.tsx                     | usesGeneration threading
```

### What shipped

**`Get Generation`** — a UNIVERSAL value node (Cells AND Agents), on all six compile
surfaces. **`Periodic Step`** — an agent event root, N per graph, implemented as a **pure
pre-compile lowering** into `Get Generation → Math(%) → Compare(==) → If/Then` hung off ONE
`behaviourStep` and sequenced, so it costs **zero per-target emit** and the capability gates
never see it. Plus a **GPU-side generation counter** so the residency fast path keeps working.

### Pinned semantics (L3 and later phases rely on these)

- **0-based, naming the generation being computed NOW.** The first step after a Reset reads
  `0`. The worker increments at the END of a step, so every rule running during generation
  *g* — cell step, agent behaviour — reads exactly `g`.
- **Init events read 0.** Reset zeroes the counter BEFORE the cell Init Event, the Grid Init
  Event and the Agent Init Event, so a seeding rule always sees 0 regardless of how long the
  previous run lasted. **Asserted** by running the compiled init fn.
- **A Division Event reads the generation the division happened in.** It runs in the
  structural phase of generation *g*, after the behaviour and before the increment, so it
  reads the same *g* the behaviour that requested the division read. **Asserted** by running
  the compiled division fn with a supplied generation (17 in, 17 out).
- **An Output Mapping reads the generation ABOUT TO BE computed** (`g+1` after generation
  *g*) — the colour pass runs after the increment on every target, so the cell OM, the agent
  OM and the resident-batch OM all agree. (Consistent, not arbitrary: this is what the CPU
  path already did.)
- **Cells and agents share ONE counter.** The agent step runs before the cell step within a
  generation and the counter is bumped once per generation, so both layers read the same value.
- **Overseer is NOT included** — it has its own `ovGetGeneration`, and the overseer driver's
  preamble has no `_generation`; adding one would also go stale after a simulator Resize.

### Decisions resolved (with reasoning)

1. **The agent WebGPU generation is a STORAGE buffer bumped by `posCommit`, not a uniform.**
   This is THE phase. `dispatchResidentBatch` encodes all N generations into ONE submit with
   no CPU touch point, so a uniform is frozen for the batch. `posCommit` is the only pass that
   already runs once per generation there; ONE invocation (`i == 0u`) bumps the counter, and
   the bump sits **before** the `highWater` guard so an empty population still ticks. The
   buffer is created unconditionally (4 bytes) because the bump is unconditional; only the
   behaviour/OM **bind-group entry** is gated (Naga strips a declared-but-unused global).
   **Residency eligibility is untouched** — reading the generation costs no readback.
2. **The two WASM surfaces use a MEMORY CELL, not a param.** Appended at the very END of each
   layout, so no baked offset moves and an unusing model's module is byte-identical — no usage
   gate needed at all. It also serves EVERY cell entry point (step / init / grid init / input
   colour / output mapping) with zero signature changes, where params would have meant five.
3. **The agent ABI field is asymmetric: PARAM gated, ARG always.** An unconditional field
   would change every agent model's emitted param string and break byte-identity. `params ⊆
   args` is the safe direction for a JS function (extra arg ignored; missing param reads
   `undefined`), so the worker and the parity harness always pass `true` — the L1
   `forcePassParamsFor` discipline. Pinned by an explicit arity-contract test.
4. **Periodic Step is agent-only.** The handoff specifies the `behaviourStep` lowering; a cell
   equivalent would double the verification surface for a gate a cell rule can compose by hand
   from the universal `Get Generation`.
5. **Branch order is stated with a `Sequence`, not inferred from edge order.** A flow fan-out
   would compile identically (edge-array order), but the sequence makes "unconditional chain
   first, then the gates" a property of the emitted graph rather than of an implicit contract.

### Assumptions that proved FALSE

**None of the four.** All held:
1. **`posCommit` really runs once per generation inside the resident batch** and can host the
   counter — confirmed in `dispatchResidentBatch`'s `for (g …)` loop, and then behaviourally
   (20 distinct generations in one batch).
2. **Both memory layouts take an appended region** without shifting a baked offset — and this
   turned out to be *better* than the param route the handoff assumed, so the WASM surfaces
   need no usage gate.
3. **The Control uniform has room** — true for the CELL grid (the existing 16-byte control
   block had 8 bytes of padding, so `controlBytes` is unchanged). The AGENT side deliberately
   did **not** use its uniform (see decision 1). The cell `Control` is a hand-written struct
   inside `emitBindings` with NO separate index table (the worker writes it through
   `layout.controlOffsets`), so it is not a `verify-render-uniform-layouts` candidate.
4. **A non-singleton event root is expressible** — trivially, because the lowering means the
   compilers never see one.

**One REAL BUG surfaced and fixed** (not an assumption, but worth the same prominence): both
agent gates early-outed on `nodes.find(behaviourStep)` over the **PRE-flatten** graph. A model
made of Periodic Steps alone has no `behaviourStep` node yet, so it **compiled perfectly and
was then rejected**, silently clamping to JS — exactly the failure mode invariant §0.3 exists
to prevent. The early-out now accepts `behaviourStep || periodicStep`; the post-flatten lookup
remains the real check.

### Verification

| Gate | Result |
|---|---|
| **THE residency test** (real GPU, resident batch) | **✓** ONE 20-generation resident batch (`residentEligible: true`): `changes 20` (twenty DISTINCT generation values), `sum 190` = Σ 0..19 **exactly**, `lastGen 19`, period-10 gate last fired at 10; all 8 agents agree; 0 worker + 0 console errors. A second batch continued to `changes 40 / sum 780 / lastGen 39 / p10 30` |
| **THE residency NEGATIVE CONTROL** | **✓** with the `posCommit` bump removed (uniform-equivalent), the SAME run reads `changes 1 / sum 0 / lastGen 0 / p10 0` — ONE frozen value. Restored + re-verified |
| **Cadence, all three targets, by value** | **✓** JS (agent loop): period 10 phase 0 fires on exactly **0, 10, 20, 30**. WASM: the parity synthetic's per-step value invariant covers period 10 phases 0 and 3 (0/10/20 and 3/13/23) on a REAL module. WebGPU: the resident run's `p10 = 10` then `30` |
| **Two phases** | **✓** period 2 phase 0 → 0,2,4,6 and phase 1 → 1,3,5,7, never coinciding (JS); on the real GPU `even 18 / odd 19` after 20 generations |
| **Multiplicity** | **✓** 3 gates (periods 2/3/5) + an unconditional Behaviour Step chain: each fires on its own schedule and the unconditional chain still runs EVERY generation; exactly ONE `behaviourStep` in the lowered graph (the singleton rule holds), one shared `Get Generation`, 4-branch `Sequence` (`first/then/then_2/then_3`) |
| **Init / division semantics** | **✓** run and asserted — division reads 17 when 17 is supplied; the Agent Init Event's created agent gets 0 |
| **Cells too** | **✓** JS + a **REAL instantiated WASM module** in Node (2D 7×5 gen 42, 3D 6×4×3 gen 7 — every cell exact, JS↔WASM bit-identical) and the **real GPU** (`useWebGPUStatus ready:true`, all 256 cells === 4 after 5 generations) |
| **Byte identity** | **✓** `check-compile-identity --compare .gra-baseline/compile-identity-L1.json` — 29 models, all surfaces unchanged |
| **Parity** | **✓** `parity-agent-wasm` with the permanent `[synthetic] Rule cadence (Get Generation + 5 Periodic Steps)` entry carrying a per-step VALUE invariant; negative-controlled (always-firing gates → `hitsC 1 !== expected 0`) |
| `test-rule-cadence.mjs` | **✓ 107 checks** |
| `tsc` · `npm run build` | ✓ · ✓ |
| `check-agent-wasm-gate` · `audit-agent-layout` (192) · `test-agent-abi` (28) | ✓ ✓ ✓ |
| `verify-graph-rewrite` (405) · `verify-agent-render` · `verify-render-uniform-layouts` · `parity-agent-force` (20) · `probe-graph-layout` | ✓ ✓ ✓ ✓ ✓ |

**Environment note**: ports 51730/51733/51737/51741 were all held by other chats' dev servers,
so the in-browser work ran against the existing `dev2` (51733), which serves this same working
tree — verified by importing the new modules in-page before testing.

### Known gaps / follow-ups

- **No sample uses cadence yet.** L3 owns sample retuning; a Periodic Step at ~10 on `Cubic
  GRA`'s rewrite chain is the intended payoff (the layout then gets ~10 relaxation steps per
  rewrite), and it composes with L3's `layoutIterations` knob rather than replacing it.
- **Overseer accounting**: `ovRunGenerations(600)` becomes 60 rule-steps at period 10. Sample
  descriptions must say which unit they mean — L3's copy pass.
- **Periodic Step is agent-only** (see decision 4). If a cell model ever wants the sugar, the
  same lowering applies to the `step` root; nothing in `periodicExpand.ts` is agent-specific
  beyond the root type name.
- The cell WebGPU `Control` struct is still outside `verify-render-uniform-layouts`'s registry
  (it has no separate hand-written index table — the worker writes through
  `layout.controlOffsets`). Adding it would need the harness to accept an offsets-object
  writer; noted, not done.

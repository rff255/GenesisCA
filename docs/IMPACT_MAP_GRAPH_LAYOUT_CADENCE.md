# Impact Map — Graph Layout (charge force) + Rule Cadence

> **Status:** design authority for the follow-on milestone to
> [IMPACT_MAP_GRAPH_REWRITING_AGENTS.md](IMPACT_MAP_GRAPH_REWRITING_AGENTS.md).
> Two independent features, both driven by one reported symptom: the shipped
> `Cubic GRA` renders as an unreadable jammed blob and runs slowly.
> Plan: [PLAN_GRAPH_LAYOUT_CADENCE.md](PLAN_GRAPH_LAYOUT_CADENCE.md) (+ `.html`).
> Execution: [HANDOFF_GRAPH_LAYOUT_CADENCE.md](HANDOFF_GRAPH_LAYOUT_CADENCE.md).
>
> **Everything below is MEASURED**, not reasoned. The probe is
> [scripts/probe-graph-layout.mjs](../scripts/probe-graph-layout.mjs) (committed);
> the profiler is `scripts/bench-agent-engine.mjs`. Reference implementation studied:
> `znah.net/graphs` (Graph-Rewriting Automata + a WASM force layout).

---

## 1. The diagnosis

### 1.1 The engine has no force that can open a structure

The agent pair law ([sim.worker.ts](../src/simulator/engine/sim.worker.ts) ~:1955):

```js
const sij  = ri + rad[j];        // contact distance
const rmax = range * sij;         // interactionRange is a MULTIPLIER of contact, not a distance
if (d2 >= rmax*rmax) continue;
const F = ((d < sij) ? muRep : muAdh) * (d - sij);
```

For the shipped `Cubic GRA` (`defaultRadius 0.9`, `interactionRange 2.2`,
`bondRestLength 5`):

- **repulsion exists only below `sij` = 1.8 units**;
- from 1.8 to `rmax` = 3.96 the coefficient is `muAdh` — **attraction**;
- beyond 3.96, nothing;
- **bonds pull from 5 units.**

So a bonded pair rests at 5 apart — a distance at which repulsion has been zero for
a long time. **A node pushes back only once something is practically on top of it.**
Nothing holds the structure open.

| | reference | GenesisCA |
|---|---|---|
| repulsion reach | 2000 | **1.8** |
| link / bond rest length | 25 | 5 |
| **reach ÷ link** | **80×** | **0.36×** |

### 1.2 Measured, on the real generative process

Grow K4 → 1200 nodes by triangle split (the shipped operation) through the **real
engine force loop**:

| scenario | bond/rest | nearest **non**-bonded ÷ bond | overlap |
|---|---|---|---|
| shipped (contact-only), 1 tick/round | 1.00 | **0.06** | **99.2 %** |
| contact-only, **30×** the settle time | 1.00 | 0.06 | 99.4 % |
| **`interactionRange` widened 2.2 → 25** | 1.00 | **0.06** | **99.4 %** |
| **+ long-range charge** | 1.51 | **0.81** | **0.0 %** |

**99.2 % of nodes have an unrelated node inside contact distance**, and unrelated
nodes sit **16× closer than bonded partners**. That is the reported blob, quantified.

> ⚠️ **The third row is the load-bearing negative result.** Widening
> `interactionRange` does nothing, because it only widens the *search* — the force is
> zero past `sij` regardless. Worse, past `sij` the sign flips to `muAdh`, so on a
> model with adhesion enabled, widening it pulls **tighter**. **This is not a tuning
> problem and must not be "fixed" with parameters.**

### 1.3 A finite cutoff is enough — Barnes–Hut is NOT required

Charge cutoff sweep, same graph, same tick budget:

| cutoff | bond/rest | nnb ÷ bond | overlap |
|---|---|---|---|
| none | 1.00 | 0.06 | 99.2 % |
| 20 (4× rest) | 1.28 | 0.68 | **0.0 %** |
| **40 (8× rest)** | 1.51 | **0.81** | **0.0 %** |
| 80 (16× rest) | 1.81 | 0.87 | 0.0 % |
| 2000 (effectively ∞) | 3.25 | 0.86 | 0.0 % |

Quality saturates by ~8×; an unbounded cutoff merely **inflates** the layout
(bond 3.25× rest) without improving separation.

**Consequence — the central design decision of this milestone:** a cutoff charge
force **reuses the existing uniform spatial hash** (widen the bin edge) and is **one
extra term in the fused pair loop that all three targets already have**. No octree,
no Morton sort, no new spatial structure, no per-target tree traversal. Barnes–Hut is
**deferred** as a later optimisation whose exactness reference is this implementation.

### 1.4 The world is also saturated (independent second cause)

`Cubic GRA` runs in a **220 × 220 torus**. A 3-regular graph needs ~`N · rest²` area:

| N | area/agent | spacing | needs `rest` = 5 |
|---|---|---|---|
| 1000 | 48.4 | 6.96 | ok |
| 2000 | 24.2 | 4.92 | **saturated** |
| 5120 | 9.45 | 3.07 | **2.6× too small** |

At the reported N ≈ 5120 the graph **cannot lay out at any repulsion strength** —
there is no room. A bounded torus is the wrong container for something that grows.

### 1.5 Why it is slow — the same bug

Per-phase profile (`bench-agent-engine.mjs`), cost ∝ N × **local density**:

| | ms/step | steps/s |
|---|---|---|
| N=10 000, spread | 12.1 | 83 |
| N=50 000, spread | 55 | 18 |
| N=50 000, **5× denser** | **103** | **10** |

The collapsed layout **maximises** local density, so the model runs in its own worst
case. **Fixing the layout makes it faster.** Note also **WASM ≈ JS** throughout
(12.1 vs 12.4 ms) — the compile target is not the lever here.

### 1.6 Cadence — the fourth cause, and the right place to fix it

The reference decouples two clocks: `grow()` fires on a growth accumulator, while
`tick(2)` runs **every frame unconditionally** — the layout gets ~120 relaxation
iterations/second against a much slower rewrite rate. GenesisCA runs **one physics
step per rewrite**, so the layout never settles.

**But there is no engine clock to decouple.** The force pass already runs
unconditionally every generation. What is missing is the *rule's* ability to say
*"only rewrite on every Nth generation"*. Verified: **there is no way to read the
generation from a cell or agent rule graph** — `ovGetGeneration` is Overseer-only,
and `generation` is not in the agent ABI at all
([agentAbi.ts](../src/modeler/vpl/compiler/agentAbi.ts): 0 occurrences).

**Design principle (user's, and correct):** cadence is *model semantics* and belongs
in the **rule graph**, not an engine knob — that is what keeps GenesisCA generic.

**The one thing that must NOT go in the graph:** how many times the *solver* iterates
per generation. That is numerical relaxation, not rule logic — the same category as
the existing `positionalIterations`. Putting it in the graph would be like exposing
an ODE's step count as a node.

---

## 2. Feature A — the charge force

### 2.1 The law

```
f_ij = chargeStrength · ( 1/(1 + d²) − 1/(1 + maxDist²) ) · (p_j − p_i)
```

(the reference's law; the `− min_c` term makes the force go continuously to zero at
the cutoff instead of stepping). `chargeStrength < 0` = repulsive. Applied for every
pair within `chargeMaxDist`, **in addition to** soft-sphere and bond springs.

### 2.2 Where it goes

A second term in the **existing fused neighbour pass**, which already exists on all
three agent targets:

| surface | file | note |
|---|---|---|
| JS | `sim.worker.ts` `runAgentStep` (2D **and** 3D arms) | the two arms are separate verbatim code paths — both must gain the term |
| WASM | `agentWasm/compile.ts` `emitForcePass` | `FORCE_PASS_PARAMS` gains scalars — **append at the END** |
| WebGPU | `agentWebgpu/forcePass.ts` | `ForceControl` uniform gains fields — watch `verify-render-uniform-layouts` |
| B1 mirror | the bin-sorted mirror force variant | a second force pipeline exists; it must gain the term too or the mirror path silently diverges |

### 2.3 The hash bin edge — the one subtle coupling

`binEdge = max(range * 2 * maxR, neighbourQueryRadius)`. The charge cutoff must join
that `max`, or the 3×3(×3) stencil will not cover the charge radius and the force
will be **silently truncated** (correct-looking, wrong physics). This is the single
easiest way to get this feature subtly wrong.

Cost estimate at cutoff = 8 × rest with a healthy layout: ~250 neighbours/agent in
2D (≈1.3 M pair-ops at N = 5000 — a few ms). **3D is much worse** (the stencil is a
volume): budget for it, measure it, and document the practical cutoff there.

### 2.4 Capability + byte-identity

A new `AgentCapabilities` member (e.g. `charge: 'off' | 'on'`), default **off**, with
`computeCapabilityClosure` requiring `motion: 'force'`. **Charge-off models must emit
byte-identical code on every target** — that is the regression gate.

---

## 3. Feature B — rule cadence

### 3.1 Two layers

**Primitive — `Get Generation`** (value node, universal: cells *and* agents, all
targets). Composable immediately:
`Get Generation → Expression("g % 10 == 0") → Conditional`.

**Sugar — `Periodic Step`** (event root, `period` + `phase`, **multiple allowed**),
implemented as a **pure pre-compile lowering** into the existing single
`behaviourStep` — `sequence` + `conditional(gen % period == phase)` around each
root's chain. This is the P1 census pattern: **zero per-target emit**, all three
targets by construction, and `behaviourStep` stays byte-identical for every existing
model.

`phase` is as important as `period`: the reference alternates
`this.phase = 1 - this.phase` (states on even ticks, divisions on odd) — i.e. exactly
two Periodic Steps at period 2, phases 0 and 1.

Recommended extra output on the root: **`Step Index` = ⌊gen / period⌋**, the rule-step
counter a GRA rule actually reasons about.

### 3.2 THE delicate point — GPU residency

**Measured**: `dispatchResidentBatch` ([agentWebgpuRuntime.ts](../src/simulator/engine/agentWebgpuRuntime.ts) ~:2793)
encodes **all N generations into ONE command encoder and submits once**, with **no
CPU touch point per generation**. A generation supplied via the Control uniform would
therefore be **constant across the whole batch** — silently wrong, and only on that
one path.

**Fix**: a GPU-side generation counter in a storage buffer, incremented by a pass that
already runs per generation (`posCommit` does). Cheap, preserves residency.
**Alternative** (worse): make a generation-reading model residency-ineligible.

### 3.3 Semantics to pin down

- What does `Get Generation` return in the **Agent Init Event** (before any step) and
  in the **Division Event**? Define it, test it.
- Gating the state update and the rewrite **together** is what makes a periodic rule
  faithful — updating states every generation while rewriting every 10th silently
  builds a *different* automaton. This is the strongest argument for the event-root
  sugar over raw modulo boilerplate.
- **Overseer accounting**: `ovRunGenerations(600)` becomes 60 rule-steps at period 10.
  Sample descriptions must say which unit they mean.

---

## 4. Subsystem impact

✅ reuse · ✏️ modify · ➕ new · **L** = owning phase

| # | Subsystem | File(s) | Change | L | Risk |
|---|---|---|---|---|---|
| 1 | Capability schema | `model/types.ts`, `agentCapabilities.ts` | ➕ `charge` mode + closure + preset | L1 | default off ⇒ byte-identical |
| 2 | Config | `model/centerBased.ts` | ➕ `chargeStrength`, `chargeMaxDist` + resolvers | L1 | mirror the `usesSoftCollision` resolver pattern |
| 3 | JS force pass | `sim.worker.ts` | ✏️ charge term in **2D and 3D** arms | L1 | two separate verbatim arms |
| 4 | WASM force pass | `agentWasm/compile.ts` | ✏️ term + `FORCE_PASS_PARAMS` **appended** | L1 | mid-list params shift baked offsets |
| 5 | WebGPU force pass | `agentWebgpu/forcePass.ts` | ✏️ term + `ForceControl` fields | L1 | uniform layout harness |
| 6 | B1 mirror force | the mirror pipeline | ✏️ same term | L1 | **easy to miss** ⇒ silent divergence |
| 7 | Hash bin edge | `sim.worker.ts` + both GPU hash paths | ✏️ charge cutoff joins the `max` | L1 | **silent truncation if missed** |
| 8 | Force parity harness | `scripts/parity-agent-force.mjs` | ➕ charge combos | L1 | the JS↔WASM gate |
| 9 | `Get Generation` node | new node + registry | ➕ universal value node | L2 | 5 ABI/uniform surfaces |
| 10 | Agent ABI | `compiler/agentAbi.ts` | ➕ `generation` scalar | L2 | one edit, four mirrors follow |
| 11 | GPU generation counter | `agentWebgpuRuntime.ts` | ➕ storage counter bumped per gen | L2 | **the residency trap (§3.2)** |
| 12 | `Periodic Step` | new root + `compiler/periodicExpand.ts` | ➕ lowering | L2 | singleton rules; no-op when unused |
| 13 | Solver iterations | `centerBased.ts` + worker | ➕ `layoutIterations` engine knob | L3 | not a graph node — by design |
| 14 | Samples | `Cubic GRA`, `SDCA`, generators | ✏️ charge on, world sizing, newborn placement, **Expression instead of Math** | L3 | the visible payoff |
| 15 | Layout-quality harness | `scripts/probe-graph-layout.mjs` | ✏️ promote to a permanent gate | L3 | the exit oracle |
| 16 | Docs | CLAUDE.md, Help, README, NODES_REFERENCE | ✏️ every phase | all | atomic with the change |

---

## 5. Decisions

| ID | Decision | Resolution |
|---|---|---|
| **DC1** | Barnes–Hut now? | **NO** — measured (§1.3): a 4–8× cutoff suffices. Cutoff charge in the existing pair loop; BH deferred, with this as its exactness reference. |
| **DC2** | Charge on all three targets? | **Yes, same law, same cutoff, same pass.** No target-specific algorithm ⇒ no new cross-target divergence class. |
| **DC3** | Cadence in the graph or the engine? | **Graph** (user's call, and correct — genericity). Solver iterations stay an engine knob. |
| **DC4** | `Periodic Step`: new root or config on `behaviourStep`? | **New root type**, so `behaviourStep` is untouched and existing models are byte-identical. |
| **DC5** | GPU generation under residency | **Storage counter bumped by `posCommit`** (§3.2). |
| **DC6** | Default `chargeMaxDist` | **~8 × bond rest length**, from §1.3. Expose it; do not hard-code a world-absolute default. |
| **DC7** | Torus vs unbounded for graph models | Sample-level in L3 (enlarge / unbound). A general "auto-growing world" is **out of scope**. |

---

## 6. Explicit non-goals

- **Barnes–Hut / octree** (DC1 — deferred, not needed for the measured fix).
- **A GPU spatial tree.**
- **Auto-sizing worlds** as an engine feature.
- **Changing the engine's generation clock** — there is nothing to change (§1.6).
- **Solver iterations as a graph node** (§1.6 — a category error).

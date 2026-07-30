# PHASE P4 — Structural request queue + the Rewire verb

**Read first**: [HANDOFF_GRAPH_REWRITING_AGENTS.md](HANDOFF_GRAPH_REWRITING_AGENTS.md)
§0 (invariants), §3 (verification recipes), §5 (Completion Report template).
Design authority: [IMPACT_MAP_GRAPH_REWRITING_AGENTS.md](IMPACT_MAP_GRAPH_REWRITING_AGENTS.md)
§3.2, §3.3 (the defect), §5 (invariants I5/I6), §6.1 (D5, D6) ·
[PLAN_GRAPH_REWRITING_AGENTS.md](PLAN_GRAPH_REWRITING_AGENTS.md) §P4, §4 (oracles O5, I5).

**State**: **DONE** (see the Completion Report) · **Depends on**: nothing structurally (P2/P3 are the bond-attribute
line; this is the request line) · **Blocks**: P5, and the milestone's flagship oracle O6

---

## 1. Why this phase is the keystone

Form Bond and Break Bond each write a **single `i32` cell** per agent:

```ts
// FormBondNode.compile
_bondFormReq[idx] = ((target)|0) + 1; _bondFormL[idx] = restLength; _bondFormK[idx] = stiffness;
// BreakBondNode.compile
_bondBreakReq[idx] = ((target)|0) + 1;
```

Both node descriptions already admit it: *"One request per agent per step — a later
call this step replaces an earlier one."*

Every degree-preserving graph rewrite — triangle split, pair annihilation, edge swap
— needs **2–5 edge mutations at one node in one step**. Emulating that across several
generations means the intermediate states **violate the very invariant the rule is
defined to preserve**, so invariant **I6** (`min deg == max deg == d`, `E == d·N/2`)
is not merely unmet, it is *untestable*. **This phase is what makes the milestone's
flagship oracle possible.**

---

## 2. Scope — what you build

### 2.1 Bounded per-agent request queues

Replace the single cells with **bounded queues**: capacity `D` slots per agent plus a
per-agent cursor. Decision **D5** recommends a fixed per-agent depth, default **8**,
user-configurable in Properties → Bond-Graph Agents.

- Addressing mirrors the bond store: `base = idx * D`, slot `c`.
- **Overflow REJECTS the excess op and surfaces a notice — never wraps, never
  half-applies** (invariant **I5**). Follow the existing `agentOverflow` notice
  precedent used by division and `formBond` capacity rejection.
- The structural phase drains each agent's queue **in slot order**, before death and
  division (do not change the existing phase ordering — bonds → death → division →
  division event → auto-bond → stale sweep).
- P2 added per-agent **bond-attribute initial-value** request cells alongside
  `bondFormL`/`bondFormK`. Those are part of a form request and must become
  per-slot too — miss them and initial values smear across queued bonds.

### 2.2 The `rewireBond` verb (decision D6 — ONE atomic op)

`rewireBond(from, to)`: atomically `break(self, from)` + `form(self, to)`. This is the
operation GRA actually names, and atomicity is free if the engine applies it as one
queue entry. **Do not** implement it as two queued ops — that reintroduces the
half-applied state I5 forbids, and it is what O5 tests for.

### 2.3 All three agent targets

Each target's emitter writes a queue slot and bumps the cursor:
- **JS** — `compile.ts` agent path.
- **WASM** — `agentWasm/compile.ts`; the request arrays are named layout regions
  (`ctx.layout.i32['bondFormReq']` etc.).
- **WebGPU** — the request fields live in `AGENT_GPU_REQUEST_FIELDS`
  (`'bondFormReq','bondFormL','bondFormK','bondBreakReq'`, plus the divide/kill set),
  laid out as runs in `agentF32`. A queue means `D` runs per field.
  **No atomics are needed** — each thread appends only to **its own** queue, and the
  emit is sequential within a thread. Do not reach for atomics; say in the report
  that you confirmed this.

### 2.4 Register the node properly

`rewireBond` needs the **five** edits or it half-works: the def, the registry, BOTH
`AGENT_*_SUPPORTED_TYPES`, `nodeValidation.detectMissingConfig`, and
`AGENT_NODE_REQUIREMENT` (requires `bonds !== 'off'`). The parity harness is what
catches a miss.

---

## 3. What this phase must NOT do

- **Do not change the division bond partition** — that is P5.
- **Do not** widen GPU residency, or touch the force pass.
- **Do not** convert bond attributes to double-buffered storage. P3 found they are
  single-buffered **by design on all three targets**; changing that is an
  all-three-targets semantic change and is explicitly NOT this phase (see §6).

---

## 4. Exit gate — all must pass, all recorded

| # | Oracle | Criterion |
|---|---|---|
| **I5** | **Atomicity** | a rule requesting `D + 3` ops per agent: **exactly `D` apply**, the remainder are rejected with a notice, and the resulting graph is *exactly* the pre-step graph plus those `D` ops. **No partial rewires anywhere.** |
| **O5** | **Pure rewiring conserves** | a rule using only `rewireBond`: **N, E and the full degree MULTISET are invariant** over 500 generations, exactly. (The multiset, not just min/max — a swap that moves degree between two nodes would pass a weaker check.) |
| **I1–I4** | handshake / symmetry / no-dangling / capacity | hold every generation of both runs above |
| — | **Multi-op in ONE step** | demonstrate a single agent performing ≥3 edge mutations in one generation and the graph being consistent immediately after — this is the capability the phase exists to deliver |
| — | Parity | `parity-agent-wasm` with a **new permanent queue synthetic** (queue several ops incl. a rewire, overflow the queue, break some bonds), JS↔WASM bit-identical, carrying a **value invariant** recomputed independently from the store |
| — | Byte identity | `check-compile-identity --compare .gra-baseline/compile-identity-P3.json` — all 26 models unchanged. **A model that issues at most one request per step must emit the same behaviour**; if the queue changes emitted code for such models, justify each diff. |
| — | Layout | `audit-agent-layout` + `test-agent-abi` before AND after |
| — | Real GPU + real worker | a queue/rewire model on all three targets, 0 errors; `createShaderModule` clean |

**Traps.** `verify-graph-rewrite.mjs` already has `checkHandshake`/`checkNoDangling`/
`checkCapacity` and Tiers through F — extend it, and **negative-control every new
invariant** (a harness that only ever passes proves nothing; P1 found three bugs
this way). The Browser pane may report hidden ⇒ drive the worker directly.
`getState.agents.*` is **Float64**.

---

## 5. Assumptions to check FIRST (stop and report if any is false)

1. **The request cells are consumed in exactly one place** — the structural phase's
   step 1 — and cleared there. If any other site reads or clears them, the queue
   drain must cover it; report before building.
2. **Each agent writes only its own request slots** on every target (no cross-agent
   request writes). If a node can write *another* agent's request, the no-atomics
   claim in §2.3 is wrong and the WebGPU design changes.
3. **P2's bond-attribute form-request cells** are per-agent and part of the form
   request (so they become per-slot with it). Confirm their shape before changing it.

---

## 6. Known limitation to carry forward, NOT to fix here

P3 established that **bond attributes are single-buffered on all three targets**, even
under `agentUpdateMode: 'sync'` — so a bond-attribute write is immediately visible to
a later reader in the same generation, while *agent* attributes under sync are not.
True synchronous bond semantics would need `bondAttrsWrite` + a swap on the CPU store
**and** the matching GPU change — an all-three-targets milestone of its own. **Do not
schedule the GPU half alone** (P3's explicit warning). P7's SDCA sample must document
its link-update semantics honestly in light of this.

---

## Completion Report — P4

**State**: **DONE**

**Commit(s)**: `<sha>` — `feat(agents): per-agent structural request queue + the atomic Rewire Bond verb`

**Files touched**

```
 CLAUDE.md                                          (the P4 section; node counts 149/146 -> 150/147; the P1 auto-bond note corrected)
 README.md                                          (the graph-rewriting bullet)
 docs/NODES_REFERENCE.md                            (scope + counts, the Rewire Bond row, Form/Break Bond rows)
 docs/HANDOFF_GRAPH_REWRITING_AGENTS.md             (Status Board)
 src/help/HelpView.tsx                              ("Rewiring the graph - several bond ops in ONE step")
 src/model/types.ts                                 (CenterBasedConfig.bondRequestDepth)
 src/model/centerBased.ts                           (resolveBondRequestDepth + BOND_REQUEST_DEPTH_MAX + the default)
 src/model/agentCapabilities.ts                     (AGENT_NODE_REQUIREMENT.rewireBond)
 src/modeler/panels/PropertiesPanelContent.tsx      ("Bond Requests / Agent / Step")
 src/modeler/vpl/bondAttrPorts.ts                   (rewireBond grows the per-bond-attribute ports too)
 src/modeler/vpl/types.ts                           (CompileContext.bondReqSlots)
 src/modeler/vpl/nodes/{registry,nodeValidation}.ts (the five registrations)
 src/modeler/vpl/nodes/RewireBondNode.ts            NEW
 src/modeler/vpl/nodes/{FormBond,BreakBond}Node.ts  (route through the shared emitter; descriptions)
 src/modeler/vpl/compiler/bondRequestQueue.ts       NEW  (the shape + encoding + the usage gate)
 src/modeler/vpl/compiler/bondRequestEmitJS.ts      NEW  (the ONE JS emitter for all three verbs)
 src/modeler/vpl/compiler/compile.ts                (ctx.bondReqSlots + the per-iteration cursor in both agent loops)
 src/modeler/vpl/compiler/agentWasm/compile.ts      (emitBondRequest, the cursor local, bondReqSlots in the extras)
 src/modeler/vpl/compiler/agentWebgpu/{compile,layout}.ts (emitBondRequest + reqAt + `var brqC`; queue-shaped runs)
 src/simulator/engine/agentEngine.ts                (queue-shaped store + layout, rewireBond, drainAgentBondRequests, clearAgentBondRequests)
 src/simulator/engine/agentWebgpuRuntime.ts         (queue-shaped upload/readback)
 src/simulator/engine/sim.worker.ts                 (the drain call + the overflow notice; agentBondReqSlots)
 src/simulator/SimulatorView.tsx                    (ships agentBondReqSlots; needsFullInit)
 scripts/verify-graph-rewrite.mjs                   (TIER G - 45 new checks, every one negative-controlled)
 scripts/parity-agent-wasm.mjs                      (whole-queue comparison + the permanent queue synthetic)
```

### What shipped

1. **A bounded per-agent request QUEUE** replaces the single request cell. `slots = D + 1`
   (`D` = `bondRequestDepth`, default **8**, clamped [1, 64]); entry `c` of agent `idx` lives at
   `idx * slots + c`, exactly like the ragged bond store. **Entry `D` is the OVERFLOW BUCKET** —
   written by every op past the queue, applied by **none**; its occupancy IS the overflow flag, so
   the drain needs no cursor array and the agent ABI keeps its exact field list.
2. **One entry carries BOTH sides** (`bondBreakReq` = break, `bondFormReq` = form, plus
   `bondFormL`/`bondFormK`/`bondFormAttr_<id>`), so ONE entry expresses all three verbs and
   **`rewireBond` is atomic by construction** rather than two queued ops that could half-apply.
3. **`Rewire Bond`** (`rewireBond`) — the verb GRA names. `rewireBond()` in the engine PRE-CHECKS
   (the `a↔from` edge must exist; `to` live / in range / not `a`; `to` has room unless already
   bonded) and then breaks + forms, or **does nothing at all** (**I5**). All five registrations done
   (def, registry, both `AGENT_*_SUPPORTED_TYPES`, `nodeValidation`, `AGENT_NODE_REQUIREMENT`), plus
   `bondAttrPorts` so a rewire seeds the new edge's attribute values like Form Bond.
4. **All three agent targets**, each through ONE shared emitter, with a per-agent-ITERATION cursor
   (`_brqC` / an i32 local / `var brqC`) declared **only when the graph uses a verb**.
5. **The drain moved into the ENGINE** — `drainAgentBondRequests(store, lambda)` — so the invariant
   harness exercises the SHIPPED code, not a copy. The worker's structural phase step 1 just calls it
   and posts the overflow notice; **phase ordering is unchanged**.
6. **UI**: *Bond Requests / Agent / Step* in Properties → Bond-Graph Agents (shown once bonds exist),
   in `needsFullInit` (the stride IS the array shape).

### Decisions resolved

| ID | Decision taken | Why |
|---|---|---|
| **D5** (queue depth) | **Fixed per-agent depth, default 8, configurable [1, 64]**, with entry `D` as a dedicated OVERFLOW BUCKET. | Matches `maxBonds`, gives the clean "rejected, whole op" story (I5), and the bucket removes the need for a cursor ARRAY — which is what keeps the agent ABI's field list, and therefore every shipped model's emitted code, unchanged. |
| **D6** (rewire atomicity) | **ONE verb, ONE queue entry.** | Two queued ops would reintroduce exactly the half-applied state I5 forbids, and O5 is the test that catches it. Atomicity is free when both sides ride one entry. |
| **NEW — the `+2` lane bias** | `0` = empty · `1` = side unused · `v + 2` = agent `v`, instead of the historical `target + 1`. | It is what lets the drain stop at the first empty entry (O(ops) not O(D) per agent) **and** what stops a Form Bond whose target resolved to `-1` from writing `0` and TRUNCATING the queue — silently dropping every LATER op that agent issued. Negative-controlled in Tier G. |
| **NEW — the queue stride is USAGE-GATED** | `bondReqSlotsForModel(model)` returns **1** when the agent graph (top level + every macro def) contains no queue verb. | The four request regions sit in the MIDDLE of the CPU layout and near the end of the GPU one, so growing them unconditionally would have shifted baked offsets for every agent model and diffed all ~11 agent `agent.wasm.bytes` / `agent.webgpu.shader` / `agent.behaviourCode` hashes. It is a general USAGE property (the `hasGlyphsInModel` / `agentUsesDensity` precedent), not a rule-shape test — and the result is **26/26 models byte-identical**. |
| **NEW — a rewire with an unresolvable side is an explicit NO-OP entry**, not a degraded form | Both lanes write `NONE`. | Degrading to a bare Form would RAISE the agent's degree — the exact thing a degree-preserving rule forbids — and it would do so silently. |
| **NEW — no atomics on WebGPU** (confirmed, per §2.3) | Each thread appends only to its OWN agent's rows. | Verified: every request emitter on every target addresses `idx`; there is no node that writes another agent's request (assumption 2 held). Asserted in Tier G over the emitted shader. |

### Assumptions that proved FALSE

**None.** All three §5 assumptions held, each checked in code before building:

1. **The request cells are consumed in exactly ONE place** — `runAgentStructuralPhase` step 1
   (`sim.worker.ts`). The only other writers are `initAgentSlot` / `freeAgentSlot` (slot hygiene) and
   the WebGPU readback (which fills them); no other site reads or clears them. The drain moved to the
   engine as `drainAgentBondRequests`, still the single consumption point.
2. **Each agent writes only its OWN request slots** on every target — JS `_bondFormReq[idx]`, WASM
   `ctx.idxLocal`, WebGPU `f32At(ctx, …, 'idx')`. **So the no-atomics WebGPU design is correct**, and
   Tier G asserts no request run is addressed with a bare `idx` (i.e. every write goes to a queue
   ENTRY) and that no atomic appears on the queue path.
3. **P2's bond-attribute form-request cells are per-agent and part of the form request** — one
   `Float64Array(maxAgents)` per attribute, read in the drain right beside `bondFormL`/`bondFormK`.
   They became per-ENTRY with the rest (missing that would smear one entry's initial values across
   the whole queue; the parity synthetic checks the per-entry values explicitly).

### Verification

| Gate | Result |
|---|---|
| tsc / build | ✓ `npx tsc -p tsconfig.app.json --noEmit` clean · `npm run build` clean (42 precache entries) |
| parity-agent-wasm | ✓ ALL entries + synthetics bit-identical, **including the new `[synthetic] Bond request QUEUE`**. Comparison widened to the WHOLE per-agent entry block (`hw × bondReqSlots`) for all five lanes — comparing only entry 0 would have missed a divergence in the 2nd..Dth op, which is the entire point of the queue. |
| check-agent-wasm-gate | ✓ every sample `GATE✓ COMPILE✓ INST✓` |
| audit-agent-layout / test-agent-abi | ✓ 156 checks, all 4 CPU sites in lockstep · ✓ 28 ABI tests (both run before AND after) |
| check-compile-identity | ✓ vs `.gra-baseline/compile-identity-P3.json` — **26 models, ALL surfaces unchanged**. No diff to justify: the usage gate keeps every verb-free model on the pre-P4 single-slot layout, so no baked offset moves and no emitted line changes. |
| verify-graph-rewrite | ✓ **180 passed, 0 failed** (135 → 180; the new **Tier G**, plus Tier F made queue-aware) |
| Others | ✓ parity-agent-force (7) · test-bonds-allocation (16) · test-agent-capabilities (76) · verify-agent-render · verify-render-uniform-layouts · test-cross-agent-writes · test-positional-collision (6) |
| Real in-browser run | see below |

**Negative controls** (a harness that only ever passes proves nothing):
- Tier G carries **five** of its own: applying all D+3 ops gives a different graph; the naive
  break-then-form leaves the state I5 forbids; a ZERO-lane entry *does* truncate the queue (which is
  why NONE is 1); a single bare break *does* change the multiset and |E|; and a verb-free model emits
  no cursor.
- The **parity synthetic** was negative-controlled three ways by mutating shipped code and reverting:
  (a) WASM writing `0` instead of `NONE` for the unused lane → `PARITY✗ bondBreakReq[1] js=1 wasm=0`;
  (b) WASM omitting the cursor bump → `PARITY✗ bondFormReq[0] js=1 wasm=113`;
  (c) **the SHARED `BOND_REQ_ID_BIAS` 2 → 3**, which both targets follow identically so parity alone
  passes → caught only by the **value invariant**: `INVARIANT(js) agent 0 entry 0: breakLane 4 !== 3`.

**REAL WORKER + REAL GPU** (dev server, throwaway 64-agent model, generated → measured → deleted).
Hub agent: step 1 requests **11 Form Bonds** against depth 8; step 2+ runs `For Each Bond { Rewire
Bond(partner → partner + 8) }` = up to **8 atomic rewires (16 edge mutations) per generation**,
iterating the PRE-step bond list. I1–I4 checked from `getState` every generation. **All three targets
produced the IDENTICAL sequence, generation for generation, with 0 worker errors and 0 console
errors** (chip read `agents JS` / `agents WASM` / `agents WebGPU`):

| gen | hub degree | E | hub partners |
|---|---|---|---|
| 1 | 8 | 8 | 1..8 — **exactly 8 of 11 requested**, ONE overflow notice |
| 2 | 8 | 8 | 9..16 — 8 atomic rewires in ONE step |
| 3–7 | 8 | 8 | 17..24 · 25..32 · 33..40 · 41..48 · 49..56 |
| 8 | 8 | 8 | 56..63 — the out-of-range rewire (`56 → 64`) **rejected atomically**, so 56 kept its bond |

- **Multi-op in ONE step, demonstrated live**: 8 forms in generation 1, then 8 rewires (16 edge
  mutations) per generation, with the graph consistent immediately after each.
- **I5 live**: exactly `D` applied, the remainder rejected whole with the notice, and generation 8's
  rejected rewire left the edge intact rather than half-removed.
- **Regression smoke on shipped bonded models**: `Life on Bonds` (WebGPU agents) reaches N=1024,
  E=4096 after 50 generations with all invariants green; `Morphogenesis - Growing Tissue` grows
  12 → 192 agents with 777 bonds. 0 errors on both.

### Invariants

| ID | Held? | Evidence |
|---|---|---|
| **I1** handshake | **YES** | Every generation of the 500-generation O5 run, every generation of the D+3 / multi-op / rewire-rejection cases, and every generation of the 8-generation run on all THREE targets in the real worker (plus the two shipped-model smokes). |
| **I2** symmetry | **YES** | Checked alongside I1 in `allInvariants` for every Tier G case and in the browser checker (every partner's reverse slot). Unchanged from P3 — the queue only changes WHEN ops are applied, not how `formBond`/`breakBond` write both slots. |
| **I3** no dangling | **YES** | Same runs; the drain range-guards every decoded id and `rewireBond` rejects a dead/out-of-range `to`. |
| **I4** capacity | **YES** | Same runs; capacity is enforced by `formBond`/`addBondSlot` as before, and the queue rejects rather than wrapping. |
| **I5** atomicity | **YES — the phase's headline** | D+3 ops ⇒ exactly D applied, the resulting graph EXACTLY the pre-step graph minus those D edges (set equality, both directions), the whole queue cleared, and the overflow REPORTED. A rewire whose form half cannot complete leaves the graph **exactly unchanged**; a rewire from a non-existent edge applies nothing (never a bare form). Negative-controlled against the naive break-then-form. Observed live at generation 8 of the browser run. |
| **O5** conservation | **YES** | A node-local **double-edge-swap** rule (`agent i` rewires `i+1 → i+2`; `agent i+3` rewires `i+2 → i+1`, for every `i ≡ 0 mod 4` on a 2-regular 32-ring, phase-flipped each generation) kept **N, E and the full degree MULTISET** invariant for **500 generations**, exactly — 8000 rewires — with I1–I4 green at every one. Negative-controlled: one bare break changes both the multiset and \|E\|. |

### Known gaps / follow-ups for the next phase

1. **P5 must read the queue's shape before implementing per-bond division assignment.** The queue is
   `[bondBreakReq, bondFormReq, bondFormL, bondFormK, bondFormAttr_<id>…]` at `idx * bondReqSlots + c`,
   with entry `bondReqSlots - 1` reserved as the overflow bucket, and **`clearAgentBondRequests` is
   the ONE place a whole entry is zeroed** — a new lane goes in `AGENT_REQUEST_QUEUE_FIELDS` (CPU) +
   `AGENT_GPU_QUEUE_FIELDS` (GPU) + `clearAgentBondRequests` and nowhere else. If P5 wants a
   per-bond daughter ASSIGNMENT it should decide early whether that is (a) a new lane on the existing
   entry, (b) a separate per-bond request region, or (c) division-event-time state — the queue is
   sized per AGENT, not per BOND, so (a) only works for an assignment issued as an op.
2. **The division event still cannot raise a bond request.** The division ABI carries no
   `_bondFormReq` block (unchanged from P2), so Form/Break/Rewire Bond are not usable inside it, and a
   request written there would land one generation late anyway (the structural phase's step 1 has
   already run). P5 will need either an ABI extension or an assignment verb that the engine applies
   inside `divideAgent`.
3. **Bond attributes remain SINGLE-buffered on all three targets** (P3's decision, unchanged here).
   True synchronous bond semantics is an all-three-targets change; do not schedule the GPU half alone.
4. **No shipped sample uses the queue yet** — coverage is Tier G (engine), the parity synthetic
   (emit, all targets) and the throwaway browser model (end-to-end). **P7's Cubic GRA / SDCA samples
   are the first real coverage**; a triangle split (N+2, E+3, degree stays 3) is now expressible
   because the three edge mutations fit one step.
5. **The queue costs `(D+1)` cells per agent per lane** — at the default depth 8 that is 8× the
   pre-P4 request memory, but **only for a model that uses a verb** (the usage gate). A model that
   only ever issues one op per step can set the depth to 1 and pay nothing extra.

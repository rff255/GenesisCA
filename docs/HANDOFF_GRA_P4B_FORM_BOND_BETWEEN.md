# PHASE P4b — the `Form Bond Between` verb (third-party bond formation)

**Read first**: [HANDOFF_GRAPH_REWRITING_AGENTS.md](HANDOFF_GRAPH_REWRITING_AGENTS.md)
§0 (invariants), §3, §5. **Predecessor**: [HANDOFF_GRA_P4_REQUEST_QUEUE.md](HANDOFF_GRA_P4_REQUEST_QUEUE.md)
— this phase completes its verb set and must obey its queue discipline.

**State**: **DONE** (see the Completion Report) · **Depends on**: P4 (the queue) · **Blocks**: **P7's flagship Cubic GRA
sample and the milestone's headline oracle O6**

**Origin**: inserted by the orchestrator while preparing P7. Not a defect — a genuine
expressiveness gap found by working the flagship sample's rule out on paper before
asking a session to build it.

---

## 1. The gap, precisely

The milestone's flagship oracle **O6** needs the cubic **triangle split**:

> `v` with neighbours `a,b,c` → `v₁,v₂,v₃`, with `v₁–a`, `v₂–b`, `v₃–c` and the
> triangle `v₁v₂, v₂v₃, v₃v₁`. Every new node has degree `1 + 2 = 3`; `a,b,c` keep
> degree 3. **ΔN = +2, ΔE = +3**, so `E = 3N/2` is preserved exactly.

With P4's queue, an agent `v` (becoming `v₁`) can already do almost all of it in ONE
step, well within the default depth of 8:

| op | verb | works today? |
|---|---|---|
| create `v₂`, `v₃` | Create Agent ×2 + Add Agent To World | ✅ |
| `v₁–v₂`, `v₁–v₃` | Form Bond ×2 | ✅ |
| re-point `b`→`v₂`, `c`→`v₃` | Rewire Bond ×2 | ✅ |
| **`v₂–v₃`** | — | ❌ **impossible** |

`formBond` is **self-to-target**. The `v₂–v₃` edge joins two agents that are *both*
newborns — neither is `self`, and neither runs its own behaviour until the next
generation. So the one edge that makes the split degree-preserving cannot be created,
and O6 is not expressible.

**This is not a workaround-able gap.** Spreading the split across two generations
leaves an intermediate state where `E ≠ 3N/2` and two nodes have degree 2 — i.e. it
violates precisely the invariant the rule exists to preserve, which is what O6 tests.

---

## 2. Scope — what you build

### 2.1 The verb

**`formBondBetween(agentA, agentB)`** — the requesting agent asks the engine to bond
two *other* agents. Same optional payload as Form Bond: rest length, stiffness, and
the per-bond-attribute initial values.

**The critical property that makes this cheap and safe: the request rides the
REQUESTING agent's OWN queue**, carrying two agent ids in its payload. No thread ever
writes another thread's queue, so — exactly as in P4 — **no atomics are needed on
WebGPU**. The CPU structural phase drains it and calls the existing
`formBond(store, a, b, L, K, attrs)`.

Semantics, mirroring the existing verbs:
- No-op if either id is out of range, dead, or `a === b`.
- No-op if already bonded.
- **Rejects (whole op, no partial state) if either endpoint's bond list is full** —
  invariant **I5**.
- Symmetric, like every bond: both rows get the slot, with identical attributes (**I2**).

### 2.2 The design question — resolve it early and state it

P4's queue entry encodes an op in **two lanes** (`0` = empty, `1` = side unused,
`v+2` = agent), and **a rewire already uses both lanes**. So `formBondBetween` — which
also needs two agent ids — **collides with the rewire encoding**. You must
disambiguate.

**Constraint that decides the shape** (learned by P5): a new lane appended
**mid-list** in `AGENT_F64_FIELDS` / `AGENT_GPU_F32_FIELDS` shifts every later baked
offset, which diffs every agent model's bytes and fails the byte-identity gate. P5
avoided a lane entirely for that reason.

So either:
- **append an op-kind lane at the very END** of the field list, so no existing offset
  moves (verify with `audit-agent-layout` + `check-compile-identity`), or
- **encode the op kind in the existing lanes' unused value space** (P4's `+2` bias
  leaves `0` and `1` as sentinels; a third sentinel or a sign convention may be
  enough).

Pick one, justify it, and **prove it with the byte-identity gate**.

### 2.3 All three targets, and the five registrations

Emit on JS, WASM and WebGPU. The node needs the **five** edits or it half-works: the
def, the registry, BOTH `AGENT_*_SUPPORTED_TYPES`, `nodeValidation.detectMissingConfig`,
and `AGENT_NODE_REQUIREMENT` (requires `bonds !== 'off'`).

**Extend `drainAgentBondRequests` in the engine, not the worker** (P4's standing
instruction). A new lane goes in `AGENT_REQUEST_QUEUE_FIELDS` + `AGENT_GPU_QUEUE_FIELDS`
+ `clearAgentBondRequests` and **nowhere else**.

---

## 3. What this phase must NOT do

- **Do not** build the Cubic GRA sample — that is P7. Build the *verb*, and prove it
  with a minimal synthetic.
- **Do not** change the structural-phase ordering, the division partition, or bond
  attribute buffering.
- **Do not** add any other new verb. One verb, one phase.

---

## 4. Exit gate — all must pass, all recorded

| # | Criterion |
|---|---|
| **The triangle split works in ONE generation** | a synthetic agent performs *2 Create + 2 Form + 2 Rewire + 1 Form-Between* in a single generation, and immediately afterwards the graph satisfies **`min degree == max degree == 3` and `E == 3N/2`** — i.e. **O6 holds at every generation**, not merely at rule boundaries. **This is the gate the phase exists for.** Run it for ≥ 50 splits. |
| **I5 atomicity** | a Form-Between whose endpoint is full is rejected **whole** — the graph is exactly the pre-step graph. Verify by construction (fill a bond list, then request). |
| **I1–I4** | hold every generation of the above |
| **Symmetry (I2)** | the created bond is present in both rows with identical rest length, stiffness and every bond attribute |
| Parity | `parity-agent-wasm` with a **permanent form-between synthetic**, JS↔WASM bit-identical, carrying a **value invariant** recomputed independently from the store |
| Byte identity | `check-compile-identity --compare .gra-baseline/compile-identity-P6.json` — all 27 models unchanged; **any diff means the encoding shifted offsets** and must be fixed, not justified |
| Standard gates | tsc · build · `check-agent-wasm-gate` · `audit-agent-layout` · `test-agent-abi` · `verify-graph-rewrite` (extend; negative-control the new invariant) · `verify-agent-render` · `parity-agent-force` |
| Real GPU + worker | the triangle-split synthetic on **all three targets**, 0 errors, `createShaderModule` clean |

---

## 5. Assumptions to check FIRST (stop and report if any is false)

1. **A newborn created this generation can be bonded in the same generation.** The
   structural phase creates agents and drains requests in the same pass; confirm the
   ORDER makes `v₂`/`v₃` valid bond targets by the time the Form-Between drains. **If
   it does not, say so immediately** — it changes the whole design and P7's sample.
2. **`formBond` can be called with two arbitrary ids** (it is `formBond(store, a, b, …)`
   — not implicitly self-relative) so the drain can call it directly.
3. **The queue's per-agent depth covers 7 ops** (default 8). If the triangle split
   needs more than the default, the sample will need a raised depth — note it for P7.

---

## Completion Report — P4b

**State**: **DONE**

**Commit(s)**
- `e1649af` — `fix(agents): the Create Agent handle is not hoistable on the WASM agent target`
  (a **PRE-EXISTING, phase-BLOCKING** defect, in its own commit — see "Assumptions" below)
- `6492a51` — `feat(agents): Form Bond Between - the third-party bond verb (GRA P4b)`

**Files touched**

```
 CLAUDE.md                                        (the P4b section; node counts 150/147 -> 151/148; the Project Structure tree)
 README.md                                        (the graph-rewriting bullet)
 docs/NODES_REFERENCE.md                          (scope + counts, the Form Bond Between row)
 docs/HANDOFF_GRAPH_REWRITING_AGENTS.md           (Status Board)
 src/help/HelpView.tsx                            ("Rewiring the graph" gained the Form Bond Between paragraph)
 src/model/agentCapabilities.ts                   (AGENT_NODE_REQUIREMENT.formBondBetween -> 'bonds')
 src/modeler/vpl/bondAttrPorts.ts                 (BOND_ATTR_PORT_TYPES — it forms a bond, so it seeds attributes)
 src/modeler/vpl/nodes/FormBondBetweenNode.ts     NEW
 src/modeler/vpl/nodes/{registry,nodeValidation}.ts (2 of the five registrations)
 src/modeler/vpl/compiler/bondRequestQueue.ts     (the encoding table + BOND_REQ_BETWEEN_SIGN + the verb in BOND_REQUEST_NODE_TYPES)
 src/modeler/vpl/compiler/bondRequestEmitJS.ts    (the 'between' verb)
 src/modeler/vpl/compiler/agentWasm/compile.ts    (the 'between' branch + supported types + dispatch)
 src/modeler/vpl/compiler/agentWebgpu/compile.ts  (same, WGSL)
 src/simulator/engine/agentEngine.ts              (drainAgentBondRequests decodes the sign FIRST)
 scripts/verify-graph-rewrite.mjs                 (TIER J — 58 new checks; 297 -> 355)
 scripts/parity-agent-wasm.mjs                    (the permanent Form-Between synthetic + its value invariant)
```

### What shipped

1. **`formBondBetween(agentA, agentB)`** — bond two OTHER agents by id, with the same payload as
   Form Bond (rest length, stiffness, one initial-value port per bond attribute). All five
   registrations plus `BOND_REQUEST_NODE_TYPES` (so the usage gate sizes the queue for it) and
   `BOND_ATTR_PORT_TYPES`.
2. **All three agent targets**, through the same one-emitter-per-target structure P4 established.
   **No atomics on WebGPU** — confirmed and asserted over the emitted shader: the two ids are
   PAYLOAD on the requester's own rows, never addresses.
3. **The drain decodes the op kind FIRST** (`drainAgentBondRequests`, still the ONE consumption
   point, still in the engine). It calls the existing `formBond(store, a, b, …)`, which IS the
   whole-op gate — **I5 and I2 come for free and cannot drift** from the other verbs.
4. **The triangle split completes in ONE generation on all three targets**, at a TIGHT `maxBonds 3`.

### Decisions resolved

| ID | Decision taken | Why |
|---|---|---|
| **§2.2 the encoding** | **The op kind rides the SIGN of the break lane** (`−(a+2)`), NOT a new op-kind lane and NOT a third sentinel. | Both `bondFormReq`/`bondBreakReq` are `AGENT_I32_FIELDS`, i.e. **signed on every target** (Int32Array / i32 region / f32 run), so the sign bit is free real estate. It costs **zero new fields**, so **zero baked offsets move** — the constraint §2.2 flagged from P5. Appending a lane at the END of the field list would also have worked, but it grows every agent model's layout for a feature almost none of them use, and it would need a second usage gate to stay byte-identical; the sign needs none. A third sentinel in the `+2` value space would have capped `maxAgents` implicitly. **Proven with the byte-identity gate: 27 models, all surfaces unchanged.** |
| **NEW — an unresolvable Form Between writes `(−NONE, NONE)`** | not `(0, 0)`, and not a degraded plain form. | The `+2` bias exists so a written entry is never `0/0` (which is the drain's terminator — writing it truncates the queue and silently drops every LATER op). Negating `NONE` keeps that property while still marking the entry as a Form Between. Degrading to a form would bond the REQUESTER to B — the wrong pair, silently. |
| **NEW — the rest-length default is the NAMED pair's contact distance** | `rad[a] + rad[b]`, not `rad[requester] + rad[b]`. | The requester is not an endpoint of this bond; using its radius would make an identical request behave differently depending on who asked. Asserted by value in Tier J. |
| **NEW — the split is FIVE queue ops, not seven** | `2 Rewire + 3 Form Between` (Creates/Adds are host calls and consume no slot). | It keeps `v₁`'s degree at exactly 3 throughout, so it works at a TIGHT `maxBonds 3` — which is itself a proof that nothing transiently over-bonds. The handoff's literal 7-op shape (`2 Form + 2 Break + 3 Between`) also fits depth 8 but transiently reaches degree 5; both are covered by Tier J. |

### Assumptions that proved FALSE

**None of the three §5 assumptions.** All were checked in code before anything was written:

1. **A newborn created this generation CAN be bonded in the same generation — CONFIRMED on all
   three targets.** The behaviour pass runs strictly before the structural phase, and the newborn is
   already `alive` with `highWater` bumped by then. JS/WASM: `agentBehaviourCreate` bumps
   `s.highWater` and `agentBehaviourAddToWorld` sets `alive[id]=1` during the behaviour call, and
   `runAgentStep` calls `runAgentStructuralPhase()` afterwards (`sim.worker.ts`). WebGPU:
   `readbackAgentStep` reconciles the bump-allocated newborns (`initAgentSlot` + `alive=1` +
   `liveCount++` + `s.highWater = end`) and only then does `runAgentStepWebGPU` call
   `runAgentStructuralPhase()`. `drainAgentBondRequests` captures `hw = s.highWater` at entry, so the
   newborns are inside its range. Demonstrated end-to-end: 54 splits, every one bonding two agents
   created in the same generation.
2. **`formBond(store, a, b, …)` takes two arbitrary ids** — not self-relative. Confirmed at
   `agentEngine.ts:1239`; the drain calls it directly.
3. **The default depth of 8 covers the split** — it costs **5** queue ops (or 7 in the alternative
   formulation). **P7 needs no raised depth.**

**BUT — a PRE-EXISTING, phase-BLOCKING defect was found and fixed in its own commit** (`e1649af`),
following P1's precedent with the agent `groupCounting`/`groupStatement` operand-port defect:

> **The Create Agent handle was not hoist-protected on the WASM agent target.** `createAgent` is an
> alloc SIDE EFFECT whose `handle` is produced by the FLOW emitter (which caches the host-call
> result), so it has no value emitter and must never be hoisted to agent-loop top. The **WebGPU**
> mirror has carried `'createAgent'` in `AGENT_VALUE_NO_HOIST` since the unified-spawning port; the
> **WASM** list omitted it. Consequence: the DOCUMENTED spawn idiom — Create Agent → Add To World →
> consume the handle as a value — failed to compile on WASM with
> `agentWasm: unsupported value node 'createAgent'`, so **every behaviour-graph spawning model
> silently clamped to JS**. Reproduced with a probe containing no P4b node at all (WebGPU compiled
> the same graph cleanly), which is what identified it as pre-existing. It blocks P4b because the
> triangle split necessarily consumes a Create Agent handle as a value. One line; `check-compile-identity`
> stayed 27/27 (no shipped model uses behaviour-graph spawning on WASM, which is why it was latent).
> **Guarded permanently** by Tier J §8 and negative-controlled by removing the entry again.

### Verification

| Gate | Result |
|---|---|
| tsc / build | ✓ `npx tsc -p tsconfig.app.json --noEmit` clean · `npm run build` clean (42 precache entries) |
| parity-agent-wasm | ✓ ALL entries + synthetics bit-identical, **including the new `[synthetic] Form Bond BETWEEN`** |
| check-agent-wasm-gate | ✓ 11/11 `GATE✓ COMPILE✓ INST✓` |
| audit-agent-layout / test-agent-abi | ✓ 168 checks, all 4 CPU sites in lockstep · ✓ 28 ABI tests (the layout is untouched — that is the point of the encoding decision) |
| check-compile-identity | ✓ vs `.gra-baseline/compile-identity-P6.json` — **27 models, ALL surfaces unchanged.** No diff to justify: the sign encoding adds no field, so no baked offset moves. |
| verify-graph-rewrite | ✓ **355 passed, 0 failed** (297 → 355; the new **Tier J**) |
| Others | ✓ parity-agent-force (7) · verify-agent-render · test-bonds-allocation (17) · test-agent-capabilities (78) |
| Real GPU + worker | see below |

**Negative controls** (a harness that only ever passes proves nothing) — all by **mutating the
shipped source and reverting**:
- **WASM drops the negation** → `PARITY✗ … bondBreakReq[0] js=-3 wasm=3`.
- **BOTH targets drop it identically** → **parity PASSES**, caught only by the value invariant:
  `INVARIANT(js) agent 0 entry 0: breakLane 3 !== -3`. This is the control that matters — the sign is
  written independently in three emitters, so a shared mistake is the realistic failure mode.
- **The engine drain ignores the sign** (`if (bl < 0)` → `if (false)`) → **20 Tier J checks fail**,
  including `THE GATE: … — gen 1: O6 broken — agent 1: degree 2 != 3`.
- **The WASM no-hoist entry removed again** → `a Create Agent handle consumed as a VALUE compiles on
  the WASM agent target — agentWasm: unsupported value node 'createAgent'`.
- In-harness: the same ids with a POSITIVE break lane are a Rewire; a sign-blind read bonds the
  REQUESTER to B; and **the split WITHOUT the `v₂–v₃` Form Between breaks O6 while leaving I1–I4
  green** — so the gate provably tests O6 and not something weaker.

**REAL WORKER + REAL GPU** (dev server, throwaway K4-seeded triangle-split model; generated →
measured → deleted). Rule: `if degree == 0 → Form Bond to every nearby agent` (the K4 bootstrap);
`else if selfHandle == 0 → the split`. `maxBonds` a tight **4**, `bondRequestDepth` 8. Every
generation was read back with `getState` and checked with an **independent** page-side recount of
N / E / min degree / max degree / handshake / symmetry / dangling / capacity.

| target | chip | gen 1 | gen 2 | gen 55 | O6 failures | worker errors | console errors |
|---|---|---|---|---|---|---|---|
| JS | `agents JS` | N=4 E=6 deg 3/3 | N=6 E=9 deg 3/3 | N=112 E=168 deg 3/3 | **0 / 55** | 0 | 0 |
| WASM | `agents WASM` | idem | idem | idem | **0 / 55** | 0 | 0 |
| WebGPU | `agents WebGPU` | idem | idem | idem | **0 / 55** | 0 | 0 |

- **54 triangle splits, each COMPLETE in ONE generation**, with `min deg == max deg == 3` and
  `E == 3N/2` holding **immediately after every single generation** — never merely between rule
  applications. The growth law is exact: `N = 4 + 2t`, `E = 6 + 3t`.
- The **WebGPU sequence is generation-for-generation identical to WASM's** (the structural phase is
  CPU on every target, so the graph is exact, not merely statistical).
- No silent fallback: a failed WebGPU runtime build or a dispatch validation error posts a worker
  `error`, and none was seen across 55 generations on any target.

### Invariants

| ID | Held? | Evidence |
|---|---|---|
| **I1** handshake | **YES** | Every generation of all three 55-generation browser runs, and every Tier J case (`allInvariants` after each). |
| **I2** symmetry | **YES** | `checkBondSymmetry` over every per-slot field after a Form Between, plus explicit by-value assertions that the requested rest length, stiffness, float bond attribute and integer bond attribute all land in **BOTH** rows. Held every generation of the browser runs. |
| **I3** no dangling | **YES** | Same runs; the drain range- and alive-guards both endpoints before calling `formBond`. |
| **I4** capacity | **YES** | Same runs; `formBond` checks BOTH lists before adding either slot. |
| **I5** atomicity | **YES** | A Form Between whose endpoint list is full — tested with **either** side full — leaves the graph *exactly* the pre-step graph (edge-set equality both ways) and the degree multiset exactly unchanged, with no half-bond on the other endpoint. Self / dead / out-of-range / already-bonded are likewise whole no-ops that still occupy their entry. |
| **O6** cubic regularity | **YES — the phase's headline** | 60 splits in the harness and 54 in the real worker on all three targets, with `min deg == max deg == 3` and `E == 3N/2` asserted after **every** generation. Negative-controlled: omitting only the `v₂–v₃` edge breaks it. |

### Known gaps / follow-ups for the next phase

1. **P7 needs no raised queue depth.** The triangle split costs **5** queue ops (2 Rewire +
   3 Form Between) — or 7 in the `2 Form + 2 Break + 3 Between` formulation — against the default 8.
   Create Agent / Add To World are host calls and consume no slot. The 5-op form additionally keeps
   `v₁`'s degree at exactly 3 throughout, so it runs at `maxBonds 3`; the 7-op form transiently
   reaches degree 5 and needs `maxBonds ≥ 5`.
2. **P7's Cubic GRA sample is the first shipped coverage.** Today's coverage is Tier J (engine +
   emit), the parity synthetic (JS↔WASM) and the throwaway browser model (end-to-end, three
   targets). The bootstrap matters: a cubic seed cannot be built in the **Agent Init Event** (Form
   Bond is init-invalid — it writes the queue at `idx`), so the sample must seed its K4 from the
   behaviour graph. Gating the seeding branch on `myBondDegree == 0` is the clean way — a newborn
   already has degree 3 by its first behaviour step, so it never re-seeds.
3. **The verb has no dedicated UI beyond its ports.** Both ids are wired values; there is no
   "pick a partner" affordance, consistent with Rewire Bond.
4. **A Form Between is applied in the REQUESTER's queue order**, so two agents requesting the same
   edge in one step resolve as first-wins-then-no-op (idempotent). Requests are never merged or
   deduplicated across agents; that is intentional and matches every other verb.

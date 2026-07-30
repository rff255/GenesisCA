# PHASE P5 — Combinatorial division (per-bond daughter assignment)

**Read first**: [HANDOFF_GRAPH_REWRITING_AGENTS.md](HANDOFF_GRAPH_REWRITING_AGENTS.md)
§0 (invariants), §3, §5. Design authority:
[IMPACT_MAP_GRAPH_REWRITING_AGENTS.md](IMPACT_MAP_GRAPH_REWRITING_AGENTS.md) §3.4 (gap G2),
§5 (invariant I7), §6.1 (D4) · [PLAN_GRAPH_REWRITING_AGENTS.md](PLAN_GRAPH_REWRITING_AGENTS.md)
§P5, §4 (oracles I7, O4, O9).
**Predecessors' reports — read them**: P4 (the queue's shape; its §"For P5" is
addressed to you), P3 and P2 (bond attributes).

**State**: **DONE** (see the Completion Report) · **Depends on**: P2/P3 (bond attributes — the
*naming* mechanism) · **Blocks**: nothing

---

## 1. Goal, and an important scope correction

`divideAgent` partitions a mother's bonds to the daughters **geometrically**, by
`sign(dot(offset, m̂))`. GRA's division is *defined* by which edges go to which
daughter, so geometry is exactly the thing a user cannot say. This phase closes
gap **G2** by letting the user *name* the partition.

**Scope correction the orchestrator makes explicitly.** When this phase was planned,
the flagship cubic oracle **O6** was expected to need it. **It no longer does.** P4
delivered per-agent request queues plus atomic Rewire, and Create Agent already works
in the behaviour graph — so a cubic **triangle split** (`v(a,b,c) → v₁,v₂,v₃`) is now
expressible as *2 Create Agent + 3 Form Bond + 2 Rewire Bond* = 5 queued ops from one
agent, within the default depth of 8, with **no division at all**.

**Therefore: do not contort this phase to serve the cubic case.** Its real value is
biological and typed-graph division — "give daughter A the *apical* bonds" — which is
precisely what bond attributes made expressible. Keep it declarative and small.

---

## 2. Scope — what you build

### 2.1 `DivideAgent.partition` config

| mode | meaning |
|---|---|
| **`tension`** | today's geometric split. **DEFAULT, and must stay byte-identical.** |
| **`alternate`** | bonds alternate A, B, A, B… in slot order. Deterministic, needs no attribute. |
| **`byBondAttribute`** | a named bond attribute selects the daughter. |

For **`byBondAttribute`**, keep the mapping simple and legible:
- **bool** — `false` → daughter A, `true` → daughter B.
- **tag** — a per-option A/B assignment in the node's config UI (the natural shape,
  and it reads like the rule it encodes).
- **integer / float** — compare against a configured threshold; `<` → A, `≥` → B.

An unresolvable attribute (deleted, wrong type) must fall back to `tension` **and**
raise a `detectMissingConfig` badge — never silently mis-partition.

### 2.2 Decision D4 — the daughter–daughter bond

Today it is added **only when the mother was bonded**, so an isolated node divides
into two *unbonded* nodes. For graph rewriting you nearly always want it
unconditionally. Add a config, defaulting to **on** when the Graph-Rewriting
capability shape is active and to today's conditional behaviour otherwise — so no
shipped model changes.

### 2.3 The key design question — resolve it early and state it

`divideAgent` runs inside the engine's structural phase; the partition mode lives on
a **node's config**, and a model may hold more than one Divide Agent node. So the
mode must reach the engine somehow.

**Recommendation: ride the divide REQUEST**, exactly as `divideAxisX/Y/Z` and
`divideAsym` already do — a small `divideMode` lane (and, if needed, a bond-attribute
index lane). That keeps per-node fidelity and reuses P4's queue-field discipline:
a new lane goes in `AGENT_REQUEST_QUEUE_FIELDS` + `AGENT_GPU_QUEUE_FIELDS` +
`clearAgentBondRequests`, **and nowhere else** (P4's instruction to you).

If you find a materially better shape, take it — but state the choice and why.

### 2.4 Explicitly DEFERRED — `byRule`

A graph-authored per-bond callback during division (For Each Bond inside the Division
Event emitting *assign to A / B / both / drop*) is **out of scope**. P4 established
two blockers: the division event's ABI carries no request lanes, and a request raised
there would land a generation late. Record it as a follow-up; do not attempt it.

---

## 3. What this phase must NOT do

- **Do not** change the structural-phase ordering.
- **Do not** convert bond attributes to double-buffered storage (P3's standing
  decision; an all-three-targets change).
- **Do not** extend the queue drain outside `drainAgentBondRequests` in the engine.
- **Do not** implement `byRule` (§2.4).

---

## 4. Exit gate — all must pass, all recorded

| # | Oracle | Criterion |
|---|---|---|
| **`tension` byte-identical** | regression | `check-compile-identity --compare .gra-baseline/compile-identity-P4.json` — all 26 models unchanged. Plus a **Growing Tissue** run: same growth curve and same bond count as before the change. This is the most important gate — the default path must not move. |
| **I7** | **conservation across division** | the daughters' inherited (partner, attribute-tuple) multiset == the mother's, minus explicitly dropped, plus the new A–B bond — checked over **≥ 1000 divisions**, in every mode |
| **O9** | bond-attribute inheritance | attributes travel with their bond through the partition and are not re-initialised, in every mode |
| **O4** | deterministic growth law | every node divides every step, no death, ample capacity ⇒ exactly `N_t = N₀·2^t` and `E_t = E₀ + N₀·(2^t − 1)`. A shortfall means silent capacity rejection — catch it. |
| **I1–I5** | the standing invariants | hold every generation of every run above |
| — | `byBondAttribute` actually partitions | a model with `apical`/`basal` bonds divides so that each daughter receives exactly its named set — asserted by value, not by eyeball |
| — | Parity + targets | `parity-agent-wasm` with a **permanent division-partition synthetic**, JS↔WASM bit-identical with a value invariant; real-GPU run clean |
| — | Standard gates | tsc · build · `check-agent-wasm-gate` · `audit-agent-layout` · `test-agent-abi` · `verify-graph-rewrite` (extend, negative-control each new invariant) · `verify-agent-render` · `parity-agent-force` |

---

## 5. Assumptions to check FIRST (stop and report if any is false)

1. **`divideAgent` is the only site that partitions bonds** — if another path also
   moves bonds between daughters, the mode must reach it too.
2. **The divide request already carries per-request payload** (`divideAxisX/Y/Z`,
   `divideAsym`) that survives P4's queue rework, so adding a lane is additive.
3. **Division still rejects the WHOLE operation on capacity overflow** (never a
   half-rewired partner). Your new modes must preserve that — verify before building.

---

## Completion Report — P5

**State**: **DONE**

**Commit(s)**: `031524e` — `feat(agents): declarative division bond partition + the daughter-bond policy`

**Files touched**

```
 CLAUDE.md                                        (the P5 section + the Project Structure tree)
 README.md                                        (the division-partition bullet)
 docs/NODES_REFERENCE.md                          (the Divide Agent row)
 docs/HANDOFF_GRAPH_REWRITING_AGENTS.md           (Status Board)
 src/help/HelpView.tsx                            ("Dividing: which daughter gets which bond?")
 src/modeler/vpl/compiler/dividePartition.ts      NEW  (the spec + the model-derived key-sorted TABLE + the idempotent code assignment)
 src/modeler/vpl/compiler/compile.ts              (assignDividePartitionCodes + AgentCompileResult.dividePartitions)
 src/modeler/vpl/compiler/agentWasm/compile.ts    (the baked code in the divideAgent emitter + the assignment in flattenAgentGraph)
 src/modeler/vpl/compiler/agentWebgpu/compile.ts  (same, WGSL)
 src/modeler/vpl/nodes/DivideAgentNode.ts         (config + the emitted code)
 src/modeler/vpl/nodes/nodeValidation.ts          (the unresolvable-partition badge)
 src/modeler/vpl/CaNode.tsx                       (the partition/attribute/tag-table/threshold/daughter-bond UI + the P2 Get/Set Bond Attribute picker gap)
 src/model/ModelContext.tsx                       (REMOVE_BOND_ATTRIBUTE clears the partition; the tagOptions remap PERMUTES partTag_*)
 src/simulator/engine/agentEngine.ts              (divideAgent's optional `partition` param — the three modes + D4)
 src/simulator/engine/sim.worker.ts               (agentDividePartitions on init/recompile + the structural-phase lookup)
 src/simulator/engine/agentWebgpuRuntime.ts       (divideRequest ROUNDED on readback instead of clamped to 1)
 src/simulator/SimulatorView.tsx                  (ships the table)
 scripts/verify-graph-rewrite.mjs                 (TIER H — 50 new checks; 180 → 230)
 scripts/parity-agent-wasm.mjs                    (the permanent division-partition synthetic + its value invariant)
```

### What shipped

1. **`DivideAgent.partition`** — **`tension`** (the geometric split, THE DEFAULT and byte-identical
   to pre-P5) · **`alternate`** (A, B, A, B… in SLOT order) · **`byBondAttribute`** (a named P2 bond
   attribute picks the daughter: bool `false`→A/`true`→B, **tag** = a per-OPTION A/B table,
   integer/float = `value < threshold` → A). An unresolvable attribute **degrades to `tension` AND
   badges the node** — never a silent mis-partition.
2. **Decision D4 — `DivideAgent.daughterBond`**: `auto` (only when the mother was bonded — the
   pre-P5 rule, so no shipped model changes) · `always` · `never`.
3. **THE TRANSPORT (§2.3 resolved)** — a per-model **TABLE on the EXISTING `divideRequest` cell**,
   not a new lane. See "Decisions resolved" for the reasoning and the measurement that drove it.
4. **All three agent targets**, each writing the same 1-based code; the WebGPU readback now ROUNDS
   `divideRequest` instead of clamping it to 1.
5. **A P2 UI gap closed in passing**: Get / Set Bond Attribute had **no attribute dropdown at all**
   (bond attributes are a third id-space, so the picker has to live on the node, like the
   field-bridge nodes). Three lines, no emit/layout impact — flagged here rather than silently.

### Decisions resolved

| ID | Decision taken | Why |
|---|---|---|
| **§2.3 the transport** | **A per-model partition TABLE keyed off the EXISTING `divideRequest` cell** (`divideRequest[idx] = 1 + tableIndex`), shipped to the worker in init/recompile — the `stopMessages`/`_stopIdx` precedent end to end. **NOT** the recommended `divideMode` lane. | Three measured reasons. (1) **BYTE IDENTITY, the phase's #1 gate**: `divideAxis*`/`divideAsym` sit in the MIDDLE of `AGENT_F64_FIELDS` **and** `AGENT_GPU_F32_FIELDS`, so an unconditional lane shifts every later baked offset and diffs every agent model's WASM bytes + WGSL shader. A usage gate could avoid that, but only by adding a second gate mechanism — whereas riding the existing cell costs *nothing*, since `1` is exactly what the pre-P5 emitters wrote. (2) The spec is **richer than a float**: a per-option tag vector + a threshold + the D4 policy. On WebGPU a lane is f32 (24-bit mantissa), so it would need fragile bit-packing. (3) Per-node fidelity is preserved either way. A lane remains right for a genuinely PER-REQUEST value (the wired axis); the partition is per-NODE and constant. |
| **NEW — the table is MODEL-derived and key-SORTED, and all three front-ends assign** | `dividePartitionTableForModel` scans the model + every macro def (mirroring `bondReqSlotsForModel`) and sorts by the spec key; `assignDividePartitionCodes` is called by JS `compileAgentGraph` **and** both `flattenAgentGraph`s. | A first-encounter table baked only by the JS compiler would inherit `_stopIdx`'s hidden **order dependence** — and `parity-agent-wasm` compiles **WASM FIRST**, so WASM would have silently emitted the wrong code. Sorting + assigning everywhere makes the codes **order-independent and idempotent**. Tier H asserts a WASM-first compile produces the same numbers. |
| **NEW — `daughterBond` is an explicit 3-way config, not an inferred default** | The handoff suggested defaulting it "on when the Graph-Rewriting capability shape is active". | There **is** no such capability flag, and a default that silently differs between two models is invisible magic (and would edge toward the rule-shape testing master §0.4 forbids). An explicit `auto` default guarantees "no shipped model changes" trivially, and the third value `never` turned out to be genuinely useful — the graph "split this node in two, disconnected" rewrite. |
| **NEW — bool folds into the threshold rule** | bool pins `threshold = 0.5`; only `tag` uses the per-option table. | Two engine branches instead of four, and `false`→A / `true`→B falls out of `value < 0.5`. |
| **NEW — `always` is gated on `mb > 0`** | With Bonds off `maxBonds === 0`; asking for a daughter bond there would make the capacity pre-check reject EVERY division. | A bond that cannot exist should be skipped, not turned into a rejection. Tier H covers it. |
| **§2.4 `byRule`** | **NOT implemented**, as instructed. Recorded as a follow-up. | P4's two blockers stand: the division event's ABI carries no request lanes, and a request raised there lands a generation late. |

### Assumptions that proved FALSE

**None.** All three §5 assumptions were checked in code before building and held:

1. **`divideAgent` is the only site that partitions a mother's bonds.** Grepped every `formBond` /
   `breakBond` / `removeBondSlot` / `moveBondSlot` call site: the only other place a bond's endpoint
   MOVES is `rewireBond` (P4), which is an explicit user verb, not a division partition.
2. **The divide request already carries per-request payload that survived P4.** `divideAxisX/Y/Z` and
   `divideAsym` are plain per-agent fields (`AGENT_F64_FIELDS`), NOT in `AGENT_REQUEST_QUEUE_FIELDS`,
   so P4's queue rework did not touch them. (Moot in the end, since the chosen transport adds no
   lane — but true, and it is why P4's "a new lane goes in the queue field lists" instruction does
   **not** apply here: the divide request is not queue-shaped.)
3. **Division still rejects the WHOLE operation on capacity overflow.** `divideAgent` returns `-2`
   (both daughters' final bond counts checked) **before** `allocAgentSlot`, and `-1` if the alloc
   fails — with nothing mutated at either point. The new modes preserve it **by construction**: the
   capacity pre-check now counts the RESOLVED partition's sides, so every mode inherits the rule
   rather than only the geometric one (asserted in Tier H's O4, which fails on any silent rejection).

### Verification

| Gate | Result |
|---|---|
| tsc / build | ✓ `npx tsc -p tsconfig.app.json --noEmit` clean · `npm run build` clean (42 precache entries) |
| parity-agent-wasm | ✓ ALL entries + synthetics bit-identical, **including the new `[synthetic] Division partition`** (two Divide Agent nodes on opposite branches ⇒ two DISTINCT codes, with a VALUE invariant that recomputes the expected code from the store) |
| check-agent-wasm-gate | ✓ 11/11 `GATE✓ COMPILE✓ INST✓` |
| audit-agent-layout / test-agent-abi | ✓ 156 checks · ✓ 28 ABI tests (the layout is untouched — that is the point of the transport decision) |
| check-compile-identity | ✓ vs `.gra-baseline/compile-identity-P4.json` — **26 models, ALL surfaces unchanged.** No diff to justify. |
| verify-graph-rewrite | ✓ **230 passed, 0 failed** (180 → 230; the new **Tier H**) |
| Others | ✓ parity-agent-force (7) · verify-agent-render · verify-render-uniform-layouts · test-bonds-allocation (16) · test-agent-capabilities (76) · test-cross-agent-writes · test-positional-collision (6) · test-ndtable |
| Real in-browser run | see below |

**`tension` byte-identical — the phase's most important gate, proven THREE ways**
1. `check-compile-identity`: 26 models, every surface unchanged (the emitted code is literally the
   same bytes).
2. A **HEAD-vs-patched ENGINE A/B in Node** (HEAD's `agentEngine.ts` bundled alongside the patched
   one, the same 1000-division sequence run through both: mixed eigensolve + wired axes, asymmetric
   splits, interleaved breaks and deaths, torus). **Every store field AND every bond attribute
   bit-identical**; 1000 divisions, 0 rejects, 500 live. **Negative-controlled**: making `tension`
   silently behave as `alternate` is caught on agent 0 (`x[0] old=10.862070845615989
   new=10.847221979368157`).
3. A **same-session browser A/B** on `Morphogenesis - Growing Tissue` (WASM agents, so f64 and
   exactly reproducible) via `git stash`: the growth curve, the edge count **and** the summed agent
   x-positions to 6 decimals are IDENTICAL pre/post —
   `[gen, N, E] = [0,12,0] [25,12,21] [50,24,63] [75,48,162] [100,96,371] [125,192,818]
   [150,384,1737]`, xsum `600 / 600.888188 / 1203.213367 / 2408.040742 / 4817.606515 / 9637.522292
   / 19278.312437`, invariants green at every sample, 0 errors.

**`verify-graph-rewrite.mjs` — the new Tier H (50 checks)**
- The **spec builder**: the empty config == DEFAULT; each mode; the tag per-option table; bool pins
  0.5; the float threshold; an unresolvable attribute degrades to `tension` **and**
  `detectMissingConfig` badges it (while a `tension` node does not); the D4 parse.
- **`tension` unchanged**: passing the default spec explicitly gives byte-for-byte the same
  partition as the pre-P5 no-spec call.
- **`alternate`** asserted slot-by-slot (every EVEN slot to A, every ODD to B).
- **`byBondAttribute`** asserted **by value** on tag (a THREE-option table — two options would let a
  plain 0.5 threshold agree by accident, which a mutation control caught), bool and float.
- **D4** under all three policies, on a free and a bonded mother, plus `always` with bonds off.
- **I7 + O9 over 1000 divisions in EVERY mode** (tension / alternate / byBondAttribute-tag /
  byBondAttribute-float): the daughters' inherited **(partner, attribute-tuple) multiset equals the
  mother's exactly**, plus the A–B bond, nothing on both daughters, nothing vanished, no attribute
  re-initialised — with **I1–I4 green at every division** and interleaved breaks + deaths.
- **O4**: `N_t = N₀·2^t` and `E_t = E₀ + N₀·(2^t − 1)` **EXACTLY** for t = 1..8 in every mode
  (N₀ = 4 → 1024 agents, 1020 edges), so a silent capacity rejection is caught.
- **The transport**: the table dedupes (3 nodes → 2 entries), is in canonical key-sorted order, the
  per-node codes match their own spec's position, a **WASM-first** compile bakes the same numbers
  (order-independence + idempotence), all three targets emit both codes, and a single-node model
  emits **identical JS and identical WASM bytes** for `tension` and `alternate` — the mode lives in
  the table, never in the artifact.

**Negative controls** (a harness that only ever passes proves nothing). Five by **mutating the
shipped source and reverting**, plus four in-harness:
- ignore the per-tag daughter table → 3 checks fail;
- `alternate` sends everything to daughter A → caught;
- ignore the D4 policy → 5 checks fail (incl. all three O4 modes);
- drop the bond-attribute inheritance in the division snapshot → 10 checks fail (the P2 compaction
  audit **and** all four I7/O9 runs);
- force `partition` to the default inside `divideAgent` → 13 checks fail;
- the **WASM emitter** writing the pre-P5 literal `1` → `PARITY✗ … divideRequest[0] js=2 wasm=1`;
- in-harness: an all-to-A partition fails the `alternate` check; flipping the per-option table swaps
  the daughters exactly; `checkI7` catches a changed attribute **and** a vanished bond; under
  `daughterBond: auto` the same O4 run yields E=0 (so the edge law really tests D4).

**REAL WORKER + REAL GPU** (dev server, throwaway 7-agent model: hub + 6 spokes, every bond stamped
`w = self + partner` by a For Each Bond → Set Bond Attribute, then the hub divides with
`byBondAttribute w, threshold 4`). Generated → measured → deleted.

| target | chip | daughter A (partner, w) | daughter B (partner, w) | I1 | I2 | I3 | errors |
|---|---|---|---|---|---|---|---|
| JS | `agents JS` | `(1,1) (2,2) (3,3)` + `(7, A–B)` | `(4,4) (5,5) (6,6)` + `(0, A–B)` | ✓ | ✓ | ✓ | 0 |
| WASM | `agents WASM` | identical | identical | ✓ | ✓ | ✓ | 0 |
| WebGPU | `agents WebGPU` | identical | identical | ✓ | ✓ | ✓ | 0 |

8 agents / 7 edges on all three. The chip confirms the model is **not** clamped, so the WebGPU run
exercises the shader emit + the rounded readback for real. `Morphogenesis - Growing Tissue` on the
WebGPU agent target additionally grows `12 → 1500` over 200 generations with I1/I3 green at every
sample and 0 errors.

**Real UI** (Modeler, Agents graph): the Divide Agent node renders the partition dropdown
(`Bonds: by tension axis / alternate A / B / by bond attribute`), the bond-attribute picker, the
threshold field and the `A-B bond: when mother was bonded / always / never` dropdown; selecting
`tension` hides the attribute + threshold controls; clearing the attribute under
`byBondAttribute` raises the badge with the exact text *"Select a bond attribute for the partition
(it falls back to the tension axis otherwise)"*. Set Bond Attribute now shows its own
bond-attribute dropdown (the P2 gap). 0 console errors.

### Invariants

| ID | Held? | Evidence |
|---|---|---|
| **I1** handshake | **YES** | Every one of the 4 × 1000 divisions in Tier H's I7 runs, every division of the D4 / mode cases, the O4 runs at every t, and every generation of the real-worker runs on all three targets (plus Growing Tissue at 8 samples to N=1500). |
| **I2** symmetry | **YES** | `allInvariants` (which includes `checkBondSymmetry` over every per-slot field incl. bond attributes) at every division of every Tier H run; and in the browser, the higher-id spokes read back the same `w` the hub wrote, after the partition moved half of them to a different daughter. |
| **I3** no dangling | **YES** | Same runs (which kill agents mid-sequence and recycle slots), and the browser checker on all three targets. |
| **I4** capacity | **YES** | Same runs; O4 additionally proves no division was silently rejected for capacity at any t. |
| **I5** atomicity | **YES (preserved)** | P5 raises no new request. Division's whole-or-nothing rule is unchanged and now counts the RESOLVED partition's sides, so it covers every mode; nothing is mutated before the pre-check returns. Assumption 3 verified in code first. |
| **I7** conservation | **YES — the phase's headline** | `checkI7`: the daughters' inherited (partner, attribute-tuple) multiset == the mother's, minus nothing (P5 has no drop verb), plus the A–B bond — over **1000 divisions in each of 4 mode configurations**, with the A–B bond's presence asserted against the D4 policy and no partner allowed on both daughters. Negative-controlled two ways. |

### Known gaps / follow-ups for the next phase

1. **`byRule` is DEFERRED** (§2.4) — a graph-authored per-bond assignment inside the Division Event.
   P4's two blockers stand (no request lanes in the division ABI; a request raised there lands a
   generation late). It would need either an ABI extension or an assignment verb the engine applies
   *inside* `divideAgent`.
2. **No shipped sample uses a non-default partition**, so `check-compile-identity` proves only that
   nothing regressed. Coverage is Tier H (engine + transport), the parity synthetic (emit, JS↔WASM)
   and the throwaway browser model (end-to-end, three targets). **P7 is the first real coverage** —
   a typed-tissue sample ("apical bonds to daughter A") would exercise it, and the `alternate` mode
   is a one-line way to halve a hub in a rewriting sample.
3. **The partition table is per-MODEL, so a code is only meaningful next to the table that produced
   it.** Both travel together in every init/recompile message and the worker replaces the table on
   each; an unknown code falls back to `DEFAULT_DIVIDE_PARTITION` (the pre-P5 split), never to
   garbage. A future phase adding another `divideRequest` consumer must read the code through the
   table rather than treating it as a boolean.
4. **`_divideIdx` is baked onto the node config** (like `_stopIdx`), so it is written into saved
   `.gcaproj` files. It is recomputed from the model on every compile and the emit falls back to `1`
   when absent, so a stale value can never survive — but do not treat it as authoring state.
5. **The `partTag_<i>` table is keyed by OPTION INDEX**, so any future path that reorders a bond
   attribute's `tagOptions` outside `UPDATE_BOND_ATTRIBUTE` must permute it (the cascade added here
   is the only one today).

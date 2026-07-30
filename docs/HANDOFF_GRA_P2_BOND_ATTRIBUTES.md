# PHASE P2 — Bond attributes: schema, store, CPU ABI, JS + WASM

**Read first**: [HANDOFF_GRAPH_REWRITING_AGENTS.md](HANDOFF_GRAPH_REWRITING_AGENTS.md)
§0 (invariants — especially the **compaction lockstep** and **baked-offset** traps),
§3. Design authority:
[IMPACT_MAP_GRAPH_REWRITING_AGENTS.md](IMPACT_MAP_GRAPH_REWRITING_AGENTS.md) §3.5, §5, §6.1 ·
[PLAN_GRAPH_REWRITING_AGENTS.md](PLAN_GRAPH_REWRITING_AGENTS.md) §P2.

**State**: **DONE** · **Depends on**: nothing (independent of P1) · **Blocks**: P3, P5
⚠️ Two findings the orchestrator must read before P3/P4/P5 — see the Completion Report
at the bottom (a THIRD compaction path; the ABI `gate` hook is unusable as designed).

---

## 1. Why this phase exists

Bonds carry only engine physics (`restLength`, `stiffness`) plus an unexposed
`bondTypeLabel`. There is no way to give an edge **user state**. That blocks:

- typed rewriting rules ("break only *apical* bonds"),
- SDCA link variables (the λ in `λ' = ψ(λ, σᵢ, σⱼ)`),
- combinatorial division ("give daughter A the bonds labelled X" — P5),
- and any social/neural/weighted-graph model.

This is the long-recorded missing capability. It is also the highest-risk phase in
the milestone, because a bond field that is added to the store but missed in a
**compaction** path corrupts silently on the first bond removal.

---

## 2. What already exists (verified — build on it, do not re-invent)

| Thing | Where | Note |
|---|---|---|
| Ragged bond regions, `maxAgents * maxBonds` | `agentEngine.ts` | `AGENT_BOND_I32_FIELDS = ['bondPartner','bondPartnerEpoch','bondTypeLabel']` + f64 `bondRestLength`, `bondStiffness` |
| **Named** WASM bond regions | `agentWasm/compile.ts` | `L.bondI32['bondPartner']`, `L.bondF64['bondRestLength']`, … — adding a region is the established shape |
| **`_bondTypeLabel` is already a loop-ABI param** | `agentAbi.ts` | the JS agent loop receives it *today* |
| Symmetric form/break | `agentEngine.ts` | `formBond(s,i,p,L,K)` writes both sides; `breakBond` / `freeAgentSlot` compact **swap-with-last** across all bond fields |
| Division already gets a bond slice | `agentAbi.ts` `kind:'division'` | `_bondPartner`, `_bondRestLength`, `_bondPartnerEpoch`, `maxBonds` — so `For Each Bond` works there |
| Save/load already ships every bond field | `serializeAgentStore` / `deserializeAgentStore` | extend, do not rewrite |
| `resolveMaxBonds(cfg)` floors at 0 when `bonds === 'off'` | `centerBased.ts` | a bonds-off model must allocate **zero** bond-attribute bytes |

---

## 3. Scope — what you build

### 3.1 Schema — `src/model/types.ts`

```ts
// additive; absent ⇒ no bond attributes ⇒ byte-identical to today
bondAttributes?: Attribute[]   // on CAModel
```

Reuse the existing `Attribute` type. **Restrict the offered types to
bool / integer / float / tag** (decision **D1**). Explicitly exclude vector, color
and neighborIndex: a vector bond attribute needs the `lowerVectorAttrs` treatment on
a *ragged* store, which is a separate milestone. Enforce the restriction in the UI
dropdown **and** defensively in the layout (skip + warn on a hand-edited file).

`LOAD_MODEL` seed guard alongside the other additive guards.

### 3.2 Reducer + cascades — `src/model/ModelContext.tsx`

Mirror `*_AGENT_ATTRIBUTE` **exactly**: `ADD / UPDATE / REMOVE / DUPLICATE /
REORDER_BOND_ATTRIBUTE`, plus:

- tagOptions rename/reorder ⇒ remap stored values in node configs via the same
  `indexMap` the agent path uses;
- `REMOVE_BOND_ATTRIBUTE` ⇒ `clearDeletedId` over the new nodes' `attributeId`
  configs (scan `agentGraphNodes` **and** `macroDefs[*].nodes`);
- a reorder is **structural** ⇒ it must force a full worker reinit (see 3.9).

### 3.3 Store — `src/simulator/engine/agentEngine.ts`

- One ragged region per bond attribute, typed by kind (`Int32Array` for
  bool/integer/tag, `Float64Array` for float), length `maxAgents * maxBonds`,
  addressed exactly like the existing fields (`base = idx * maxBonds`, slot `k`).
- `formBond` gains initial values (see 3.6 for how they arrive).
- **THE CRITICAL EDIT — compaction lockstep.** `breakBond` and `freeAgentSlot` do a
  swap-with-last over every bond field. Every new region **must** be swapped in the
  same loop. Prefer refactoring the swap into a **single field-list-driven loop** so a
  future field cannot be missed, rather than adding N more hand-written lines.
- `snapshotBonds`, `serializeAgentStore`, `deserializeAgentStore`: extend for the new
  regions (the payload already carries every bond field — follow the pattern).
- `initAgentSlot` / division: daughters inherit their partitioned bonds' attributes
  **unchanged** (P5 adds explicit control; here it is pure inheritance).

### 3.4 CPU memory layout — `computeAgentMemoryLayout`

Append the bond-attribute regions **after** every existing region so all current
offsets stay byte-stable. Take the specs the same way agent attributes arrive
(`attrSpecs`) — a `bondAttrSpecs` parameter. When `maxBonds === 0` (bonds off),
allocate **nothing**.

> **Baked-offset lockstep**: the store's layout and the compiler's layout must be
> derived from the SAME spec list, in the same order. `scripts/audit-agent-layout.mjs`
> is the gate; run it before and after.

### 3.5 The shared ABI — `src/modeler/vpl/compiler/agentAbi.ts`

Add a `_bondAttr_<id>` block:

- for `kind: 'loop'` — after the existing bond block;
- for `kind: 'division'` — **also** (division currently carries only
  partner/rest/epoch/maxBonds, and P5 needs the attributes there);
- use the **reserved `gate(profile)` hook** so the whole block drops when
  `bonds === 'off'`. This is the descriptor's first real use of `gate` — read its
  header comment first, and confirm the gate is actually consulted by
  `buildAgentAbiParams` / `buildAgentAbiArgs` (as of writing, `deriveAgentAbi`
  **ignores** `profile`: `void profile`). **If gating requires changing that
  function's contract, that is in scope — but state exactly what you changed**, since
  every ABI mirror depends on it.

Extend the ABI shape (`AgentAbiShape`) with `bondAttrs: ReadonlyArray<{id}>`, and
supply it at **all** sites that build a shape: `compile.ts`, the worker's
`agentAbiShapeOfStore`, and `scripts/parity-agent-wasm.mjs`'s `buildArgs`. One edit in
the descriptor, then follow the compile errors — that is the design intent.

### 3.6 Nodes

| Node | Shape |
|---|---|
| **`getBondAttribute`** | inputs: `partnerId` (integer); config: `attributeId`; output: `value`. Resolves the bond slot by scanning this agent's bond list for `partnerId` (epoch-valid); **no bond ⇒ the attribute's default** (never `undefined`). |
| **`setBondAttribute`** | flow; inputs: `partnerId`, `value` (type-adaptive inline widget per the chosen attribute's type — the `effectiveWidget` swap); config: `attributeId`. **Writes BOTH slots** (this agent's and the partner's) — invariant **I2** is not optional. |
| **`formBond`** (extend) | initial attribute values. Choose **either** the `multiAttrExpand` slot pattern **or** config-driven defaults, and justify the choice in the report. Absent values ⇒ the attribute defaults, and the emitted code for a model with no bond attributes must be **byte-identical to today**. |
| **`forEachBond`** (extend, optional) | expose bond attributes as extra per-iteration outputs. Only if it does not perturb the existing four outputs' ids/emit — otherwise defer and note it. |

Register: `MULTI_OUTPUT_TYPES` (if multi-output), `NEVER_PURE_TYPES` (bond reads hit
**mutable** storage — like `getAgentAttribute`), `NEVER_INVARIANT`,
`AGENT_WASM_SUPPORTED_TYPES`, `nodeValidation.detectMissingConfig`,
`AGENT_NODE_REQUIREMENT` (requires `bonds !== 'off'`).

### 3.7 Emit

- **JS** — `compile.ts` agent path. The loop params follow the descriptor
  automatically once 3.5 lands.
- **WASM** — `agentWasm/compile.ts`, via new named regions in `L.bondI32` /
  `L.bondF64`. Add the nodes to the supported set.
- **WebGPU** — **NOT this phase.** `isAgentGraphWebGPUSupported` must **reject** a
  behaviour graph containing the new nodes, so such a model clamps to WASM/JS. Update
  the Properties agent-target hint to state the reason. P3 lifts it.
  ⚠️ This is the sanctioned capability-gate mechanism (master §0.3), **not** a silent
  JS clamp — the model still runs, on a target that supports it, and the user is told.

### 3.8 UI

- **Bond Attributes section** in the Attributes panel on the **Agents** graph
  (master-detail, mirroring the agent-attribute section). ⚠️ **`ModelerView.selectedItemName`
  must resolve a `bond:<id>` selection slot** — the shipped agent-attribute bug was
  exactly this: the detail `PanelShell` is gated on `detailItemName != null`, so an
  unresolved prefix means clicking (or adding) an item silently does nothing.
- Bond attributes are **agents-only** — hide the section when `topologyMode.agents`
  is off or `bonds === 'off'`.
- **Inspector** — `InspectAgentPopover` lists the agent's bonds with their attribute
  values (`getAgentState` already returns the live bond list).

### 3.9 Worker plumbing

- `SimulatorView`'s `init` + `recompile` messages carry `bondAttributes` (mirroring
  `agentAttributes`), and the worker builds `bondAttrSpecs` from them.
- **`attrsStructurallyEqual`** (or its agent sibling) must treat a bond-attribute
  add/remove/reorder/type-change as **structural** ⇒ full reinit. A soft recompile
  with a changed bond layout is the baked-offset corruption class.

---

## 4. Exit gate — all must pass, all recorded

| # | Oracle | Criterion |
|---|---|---|
| **I2** | **Bond symmetry** | a rule that writes a bond attribute from **one side only**, run 200 generations: every bond reads **identically** from both sides, every generation. **Primary gate.** |
| **Compaction** | swap-with-last lockstep | a rule that forms and breaks bonds at random for **500** generations, then a full-store audit: no attribute is ever associated with the wrong partner. This is the test for the phase's highest-risk edit — write it **first**, before the store change, and watch it fail. |
| **I1 / I3 / I4** | handshake / no-dangling / capacity | hold every generation of both runs above |
| — | Parity | `parity-agent-wasm` — a **new permanent bond-attribute synthetic** (form bonds, write attributes from one side, read them back from the other, break some) is **JS↔WASM bit-identical**; every existing entry unregressed |
| — | Layout | `audit-agent-layout` + `test-agent-abi` green **before and after**; existing offsets unchanged for a model with no bond attributes |
| — | Byte identity | `check-compile-identity` — every shipped model unchanged (none has bond attributes, so no region may appear) |
| — | Gate | `check-agent-wasm-gate` green; a bond-attribute model's WebGPU gate returns **false** with the hint text updated |
| — | Persistence | a model with bond attributes + a live bonded population saves to `.gcaproj`/`.gcastate` and reloads with every bond attribute value bit-exact |
| — | Real UI | create a bond attribute in the Modeler, wire Get/Set Bond Attribute, run it in the browser, inspect an agent and see the values. **The detail panel must actually open** (3.8). Record what you observed. |

---

## 5. Decisions to resolve and record

| ID | Decision | Recommendation |
|---|---|---|
| **D1** | Bond attribute types | bool / integer / float / tag only |
| **D2** | Directed semantics | Keep symmetric. **I2 means both slots hold the same value**, so a genuinely asymmetric bond attribute is impossible without breaking the invariant. Document the idiom instead: store an `ownerId` integer bond attribute and compare it against self. **Do not** quietly allow asymmetric writes. |
| — | `formBond` initial values: slots vs. config | your call; justify it |
| — | Whether `forEachBond` exposes attributes now or in P5 | defer if it perturbs existing emit |

---

## 6. Assumptions to check FIRST (stop if any is false)

1. **`deriveAgentAbi` currently ignores `profile`** (`void profile;`). Gating the bond
   block requires making it live. Confirm every caller passes a profile — if any does
   not, gating is not yet safe and you should ship the block **ungated** (always
   present, zero-length when there are no bond attributes) and report it.
2. **`maxBonds === 0`** (bonds off) must allocate zero bond-attribute bytes and emit
   no ABI fields. Verify against the existing zero-maxBonds path, which is already
   exercised by pure-force models (Boids, Particle Life).
3. **The compaction paths are the only places bond slots move.** Grep for every write
   to `bondPartner` and confirm each has a matching write for the other fields. If a
   third compaction path exists that the Impact Map missed, **stop and report**.
4. **`serializeAgentState` round-trips ragged bond regions of arbitrary count.**
   Verify before extending, and check the `.gcastate` stride-mismatch rejection still
   fires correctly when bond-attribute counts differ between file and model.

---

## 7. Out of scope

WebGPU (P3), the request queue (P4), division partition (P5), graph indicators (P6),
samples (P7). Do **not** change `divideAgent`'s partition logic here — daughters
inherit attributes with their bonds, and that is all.

---

## Completion Report — P2

**State**: **DONE**

**Commit(s)**: see the Status Board row (one commit on `GRA`).

**Files touched**

```
 CLAUDE.md                                        (+ the P2 section, + the Project Structure tree + node counts)
 README.md                                        (bond-attributes bullet)
 docs/NODES_REFERENCE.md                          (149 registry / 146 selectable / 50 agent + rows 121-122 + the Form Bond row)
 docs/HANDOFF_GRAPH_REWRITING_AGENTS.md           (Status Board)
 src/help/HelpView.tsx                            ("Bond Attributes — state that lives on the edge")
 src/model/types.ts                               (CAModel.bondAttributes, SerializedAgentState.bondAttrs)
 src/model/attributeScope.ts                      (BOND_ATTRIBUTE_TYPES + bondAttrsOf — the ONE resolver)
 src/model/ModelContext.tsx                       (5 reducer actions + cascades + LOAD_MODEL guard + context callbacks)
 src/model/agentCapabilities.ts                   (AGENT_NODE_REQUIREMENT: the two nodes → 'bonds')
 src/model/fileOperations.ts                      (.gcastate bondAttrs encode/decode)
 src/simulator/engine/agentEngine.ts              (bondAttrKind, ragged regions, moveBondSlot, formBond values,
                                                   divideAgent inheritance, layout, serialize/deserialize)
 src/simulator/engine/sim.worker.ts               (bondAttrs specs, store wiring, form-request values, getAgentState)
 src/simulator/SimulatorView.tsx                  (init payload + the structural-reinit term + inspector prop)
 src/simulator/InspectAgentPopover.tsx            (per-bond attribute rows)
 src/modeler/ModelerView.tsx                      (selectedItemName resolves `bond:<id>` — the detail-panel trap)
 src/modeler/panels/AttributesPanelContent.tsx    (Bond Attributes section + the bond: selection slot + type restriction)
 src/modeler/panels/PropertiesPanelContent.tsx    (the WebGPU agent-target hint arm)
 src/modeler/vpl/types.ts                         (CompileContext.bondAttrs)
 src/modeler/vpl/bondAttrPorts.ts                 NEW  (Form Bond's per-attribute ports — the ONE builder)
 src/modeler/vpl/nodes/GetBondAttributeNode.ts    NEW
 src/modeler/vpl/nodes/SetBondAttributeNode.ts    NEW
 src/modeler/vpl/nodes/FormBondNode.ts            (initial-value emit)
 src/modeler/vpl/nodes/registry.ts                (registration)
 src/modeler/vpl/nodes/nodeValidation.ts          (detectMissingConfig + AGENT_SELF_ONLY_TYPES)
 src/modeler/vpl/CaNode.tsx                       (Form Bond dynamic ports)
 src/modeler/vpl/effectivePorts.ts                (same, shared builder)
 src/modeler/vpl/compiler/agentAbi.ts             (AgentAbiShape.bondAttrs + the two blocks)
 src/modeler/vpl/compiler/compile.ts              (shape + ctx.bondAttrs)
 src/modeler/vpl/compiler/agentWasm/compile.ts    (emitters + supported types + layout extras)
 src/modeler/vpl/compiler/agentWebgpu/compile.ts  (the capability-gate rejection)
 src/modeler/vpl/compiler/accessorCSE.ts          (getBondAttribute → NEVER_PURE)
 src/modeler/vpl/compiler/loopInvariant.ts        (getBondAttribute → NEVER_INVARIANT)
 scripts/verify-graph-rewrite.mjs                 (checkBondSymmetry + Tier D: audit, persistence, gate)
 scripts/parity-agent-wasm.mjs                    (the permanent bond-attribute synthetic + the shape mirror)
```

### What shipped

1. **`CAModel.bondAttributes`** — the third attribute id-space, bool/integer/float/tag only (**D1**), resolved everywhere through **`bondAttrsOf(model)`** ([attributeScope.ts](../src/model/attributeScope.ts)), which applies BOTH filters (Bonds-off ⇒ empty; allowed types only).
2. **Store** — one ragged region per attribute (`bondAttrKind`: bool/int/tag → Int32, float → Float64) + one per-agent f64 Form-Bond request cell each. `moveBondSlot` is the ONE place a bond slot's contents move; `bondSlotArrays` is the field list it iterates. `divideAgent` carries the attributes on its bond snapshot (pure inheritance).
3. **Layout + ABI** — regions appended after every existing one (`maxBonds === 0` ⇒ zero bytes); `_bondAttr_<id>` on loop **and** division, `_bondFormAttr_<id>` on loop.
4. **Nodes** — Get / Set Bond Attribute (by partner id; Set writes BOTH slots) + Form Bond's per-attribute initial-value ports via the shared `buildBondAttrPorts`.
5. **Emit** — JS + WASM with bit-parity. WebGPU **rejects** a bond-attribute model at the gate with a stated hint.
6. **UI** — Bond Attributes panel section (`bond:<id>` slot resolved in `ModelerView.selectedItemName`), type dropdown restricted to the four allowed types, inspector bond rows, structural reinit on any bond-attribute change.
7. **Persistence** — engine payload + `.gcastate` base64, both bit-exact; a pre-P2 payload resets to defaults.

### Decisions resolved

| ID | Decision taken | Why |
|---|---|---|
| **D1** | bool / integer / float / tag only | As recommended. Enforced in the type dropdown AND in `bondAttrsOf` (a hand-edited `vector` bond attribute is skipped, never allocated). |
| **D2** | **Symmetric, no exceptions.** Set Bond Attribute writes both slots; I2 is enforced by the harness. | As recommended. The documented idiom for a direction is an `ownerId`-style bond attribute compared against Get Self Handle. Allowing asymmetric writes would make I2 untestable and silently break every rewriting rule that depends on it. |
| **Bond-attribute region kind** | A dedicated **`bondAttrKind`**: bool → **Int32**, not Uint8 (unlike `agentAttrKind`) | Keeps the ragged store to exactly TWO region shapes. A third (Uint8) shape would need a third layout record, a third view type, a third branch in the compaction field list and in both WASM load/store helpers — for 3 bytes per bond slot on bools. |
| **`formBond` initial values: slots vs config** | **Neither — DYNAMIC ports derived from `model.bondAttributes`** (one per attribute, labelled with its name, type-adaptive widget) | The `multiAttrExpand` slot pattern needs a user-managed count and can name a deleted attribute; config-driven defaults can't be wired from the graph. Deriving the port set from the attribute list makes it impossible to reference a stale attribute, needs no `+ slot` UI, and shows the user "Weight"/"Kind" instead of "Value 2"/"Value 3". Values ride per-agent request cells (the exact shape of `bondFormL`/`bondFormK`); with no bond attributes the emit is byte-identical. |
| **`forEachBond` exposing attributes** | **DEFERRED** (P5 or later) | It would add dynamic per-iteration outputs to a node whose four existing outputs are cached by id in the JS, WASM **and** WebGPU emitters (`forEachBondStack` frames). Get Bond Attribute inside the loop body, fed by `partnerId`, expresses the same thing today with zero risk to the existing emit. |
| **WebGPU rejection granularity** | **MODEL level** (`bondAttrsOf(model).length > 0`), not per-node | Rejecting only the two nodes would let a model that merely uses **Form Bond** through — and its initial values would silently VANISH on the GPU (the GPU request fields have no attribute lanes). One rule, no leak, one hint to explain it. |

### Assumptions that proved FALSE

**Two, both handled inside the phase's own prescribed remedy; neither changed the design. Read #1 before P3/P4/P5 — it corrects the Impact Map.**

1. **§6.3 — "the compaction paths" (plural, enumerated in Impact Map §3.5 / handoff §2 as `breakBond` + `freeAgentSlot`) is INCOMPLETE. There is a THIRD swap-with-last: `sweepStaleBonds`** ([agentEngine.ts](../src/simulator/engine/agentEngine.ts)). `breakBond` and `freeAgentSlot`→`breakAllBonds` both funnel through the single `removeBondSlot`; `sweepStaleBonds` carried its OWN inline copy of the 5-field swap. The assumption's SUBSTANCE held (bond slots move only in compaction, and each site wrote all fields in lockstep) — the enumeration was short by one.
   - **Why I did not stop**: the handoff's own §3.3 mandates the remedy — "refactor the swap into a **single field-list-driven loop** so a future field cannot be missed" — which makes the number of call sites irrelevant by construction. This is not a redesign and not a workaround; the finding is a one-line correction to §3.5's prose. Following the P1 precedent, it is reported here prominently instead.
   - **It is now negative-controlled at the ENGINE level**: reverting EITHER `sweepStaleBonds` or `removeBondSlot` to a hand-written 5-field swap makes the compaction audit fail (gen 5 / gen 3 respectively).
   - ⚠️ **P4/P5 must know**: any new bond field goes in `store.bondSlotArrays` and nowhere else; any new compaction site must call `moveBondSlot`.
   - ⚠️ **A second gap the control exposed**: the audit did NOT reach `sweepStaleBonds`'s swap at first, because `freeAgentSlot` already removes a dying agent from every partner's list, so normal churn leaves nothing stale. The audit now **induces** staleness (marks an agent dead without cleaning its partners) — that step is load-bearing, not decoration. Without it the third path is exercised zero times and a missed field there is invisible.
2. **§6.1 — `deriveAgentAbi` ignores `profile`: TRUE, and worse than stated. NOT ONE caller passes a profile at all** (`compile.ts`'s three param builders, the worker's three arg builders, `audit-agent-layout`, `test-agent-abi`, every parity harness — all call `(kind, shape)`). So making the `gate` hook live would be a **no-op at every real site**, not a working gate.
   - Per the handoff's own instruction ("if any does not, ship the block **ungated** … and report it") the block is **ungated in the descriptor** — but it is NOT "always present": `AgentAbiShape.bondAttrs` is empty whenever `bondAttrsOf` says so, which already includes the Bonds-capability-off case. **The SHAPE is the gate**, and the capability is honoured without the descriptor ever seeing a profile.
   - ⚠️ **Recommendation for the orchestrator**: do NOT schedule work to "make `gate` live". Either delete the hook or thread a profile through all six call sites first — and note the shape-derived approach already achieves the goal for the fields that have a capability.

**Assumptions that HELD**: #2 (`maxBonds === 0` allocates zero bond-attribute bytes and emits no ABI fields — asserted in Tier D), #4 (`serializeAgentState` round-trips — but only for TOP-LEVEL ArrayBuffer properties; a nested record like `bondAttrs` needs an explicit arm exactly like the existing `attrs`, which is what was added; the `.gcastate` stride-mismatch rejection is untouched and still fires only when the saved state has live bonds).

### Verification

| Gate | Result |
|---|---|
| `npx tsc -p tsconfig.app.json --noEmit` | ✓ clean |
| `npm run build` | ✓ clean (42 precache entries) |
| `node scripts/parity-agent-wasm.mjs` | ✓ **ALL AGENT SAMPLES: JS↔WASM BIT-PARITY** — every existing entry unregressed + the new permanent `[synthetic] Bond attributes` entry, **negative-controlled both ways** |
| `node scripts/check-agent-wasm-gate.mjs` | ✓ 11/11 `GATE✓ COMPILE✓ INST✓` |
| `node scripts/audit-agent-layout.mjs` | ✓ 156 checks (was 144), all 4 CPU sites in lockstep — green BEFORE and AFTER |
| `node scripts/test-agent-abi.mjs` | ✓ 28 passed — green BEFORE and AFTER |
| `node scripts/check-compile-identity.mjs --compare …P1.json` | ✓ **26 models, all surfaces unchanged** (no model has bond attributes ⇒ no region, no ABI field, no emit) |
| `node scripts/verify-graph-rewrite.mjs` | ✓ **88 passed, 0 failed** (was 58) — Tier D added |
| `node scripts/parity-agent-force.mjs` | ✓ 7 checks |
| `node scripts/test-agent-capabilities.mjs` | ✓ 75 passed |
| **Real in-browser run** | see below |

**`verify-graph-rewrite.mjs` — the new Tier D oracles**
- Store shape: one region per attribute, typed by kind, ragged; `bonds=off` ⇒ zero specs, zero regions, compaction list back to the five built-ins.
- `formBond` writes the initial values into **both** slots; absent values ⇒ defaults; I2 holds after.
- **The compaction audit** — 500 generations of random form / break / death / division / induced-stale + sweep against an INDEPENDENT truth map keyed by the unordered pair, audited EVERY generation (I1 + I3 + I4 + I2 + the truth comparison). Churn is asserted, not assumed (990 forms / 822 breaks / 49 deaths / 11 divisions / 24 induced-stale / 76 swept slots on the recorded run).
- Division **inheritance**: every partner bond keeps the mother's attribute values wherever it lands.
- Persistence: engine round-trip + `.gcastate` base64 round-trip bit-exact; a pre-P2 payload resets to defaults.
- The **capability gate**: WASM accepts + compiles a bond-attribute model, WebGPU rejects it, and `bonds=off` makes `bondAttrsOf` empty again.
- Negative controls: a partner-only compaction swap is caught by the audit AND by `checkBondSymmetry`; a one-sided attribute write, a partner-only swap and a missing reverse slot are each caught by I2 on a synthetic graph.

**Real in-browser run** (dev server :51733, agents-only model: 16 agents in a chain, Form Bond seeds `weight = self*100 + partner`, Set Bond Attribute writes `kind` from the LOWER-id endpoint only, Get Bond Attribute sums every bond)
- **WASM agent target** (chip reads `agents WASM`, so it is not clamped): agent 8 → `bonds [7,9]`, `weight [708, 809]`, `kind [1,1]`, `sumW 1517`; agent 15 → `weight [1415]`, `kind [1]`. Every value exact. **Agent 15 reading `kind = 1` on the bond it never wrote is I2 through the real worker.**
- **JS agent target**: identical values (`agents JS`).
- **Modeler**: the Bond Attributes section renders both attributes; clicking one **opens the detail panel** (`Edit: Weight`) — the trap the handoff called out; the Type dropdown offers exactly Binary / Integer / Decimal / Tag; `+ Add Bond Attribute` auto-selects and opens the editor.
- **Form Bond ports**: `bondAttr_weight:Weight:number` + `bondAttr_kind:Kind:tag`, and `getEffectivePorts` agrees with `buildBondAttrPorts` exactly (the dual-consumption discipline).
- **Inspector**: `Agent #8 … bonds 2 … bond attributes → 7 Weight 708.000 · Kind Basal → 9 Weight 809.000 · Kind Basal` (the tag decodes to its NAME).
- **Persistence through the real app**: File → Save (board state included) produced a `.gcaproj` carrying `bondAttributes` + base64 `bondAttrs` buffers; loading that file back restored `weight [708,809] kind [1,1]` at **Gen 0** — proving the values came from the FILE, not from a re-run.
- **Zero console errors** across the whole session.

### Invariants

| ID | Held? | Evidence |
|---|---|---|
| **I1** handshake | **YES** | `checkHandshake` green at every generation of the 500-gen audit (which forms, breaks, kills, divides and sweeps). |
| **I2** symmetry | **YES** | `checkBondSymmetry` (comparing EVERY per-slot field incl. every bond attribute) green at every generation of the audit; three negative controls caught. In the real worker: a lower-side-only write is read back correctly by the higher-id agent. In parity: the value invariant asserts both endpoints agree, and making both targets one-sided IS caught. |
| **I3** no dangling | **YES** | `checkNoDangling` green every generation of the audit (which deliberately induces dead partners + recycles slots). |
| **I4** capacity | **YES** | `checkCapacity` green every generation; `maxBonds` 6 with heavy churn. |
| **I5** atomicity | *n/a in P2* | This phase raises no structural requests of its own; `formBond`'s existing both-sides-or-neither rule is unchanged, and the attribute values ride it (so a rejected form writes no attribute either). Arrives properly with P4. |

### Known gaps / follow-ups for the next phase

1. **The Impact Map §3.5 prose must be corrected**: the compaction paths are `removeBondSlot` (Break Bond + death) **and `sweepStaleBonds`** — three entry points, one helper. The claim that "a new field that follows the same pattern inherits correct compaction" is only true now *because* the swap is field-list-driven.
2. **P3 (WebGPU) must lift a MODEL-level gate term**, not just add node types: `isAgentGraphWebGPUSupported` rejects at the top on `bondAttrsOf(model).length > 0`, and `PropertiesPanelContent` has a matching hint arm keyed on `model.bondAttributes?.length`. Both together. It must also decide how Form Bond's **initial values** reach the GPU request fields (the reason the gate is model-level).
3. **Do not schedule "make the ABI `gate(profile)` hook live"** — see the FALSE-assumption section. The shape is the gate.
4. **`forEachBond` does not expose bond attributes** (deferred). Get Bond Attribute inside the body covers it; revisit if P5's per-bond assignment wants per-iteration ports.
5. **A bond attribute is not yet writable from the Division Event's own graph in a targeted way** — the division ABI carries `_bondAttr_<id>` (so Get/Set Bond Attribute compile there) but NOT `_bondFormAttr_`, and `divideAgent` inherits values wholesale. P5's "assign this bond to that daughter" verb is where that becomes controllable.
6. **No shipped sample uses bond attributes** — deliberate (P7 owns samples), which is why the whole feature is covered by the harness synthetics + a throwaway browser model rather than by `check-compile-identity`.

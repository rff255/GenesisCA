# PHASE P2 — Bond attributes: schema, store, CPU ABI, JS + WASM

**Read first**: [HANDOFF_GRAPH_REWRITING_AGENTS.md](HANDOFF_GRAPH_REWRITING_AGENTS.md)
§0 (invariants — especially the **compaction lockstep** and **baked-offset** traps),
§3. Design authority:
[IMPACT_MAP_GRAPH_REWRITING_AGENTS.md](IMPACT_MAP_GRAPH_REWRITING_AGENTS.md) §3.5, §5, §6.1 ·
[PLAN_GRAPH_REWRITING_AGENTS.md](PLAN_GRAPH_REWRITING_AGENTS.md) §P2.

**State**: READY · **Depends on**: nothing (independent of P1) · **Blocks**: P3, P5

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

*(fill in per the master handoff §5 template. The orchestrator will use §"Assumptions
that proved FALSE" and the D-decisions to refine P3 and P5 before launching them.)*

# Plan — Graph-Rewriting Automata on the Bond-Graph Agent tier

> **Design authority:** [IMPACT_MAP_GRAPH_REWRITING_AGENTS.md](IMPACT_MAP_GRAPH_REWRITING_AGENTS.md).
> **Execution:** one fresh session per phase, orchestrated via
> [HANDOFF_GRAPH_REWRITING_AGENTS.md](HANDOFF_GRAPH_REWRITING_AGENTS.md).
> **Illustrated:** [PLAN_GRAPH_REWRITING_AGENTS.html](PLAN_GRAPH_REWRITING_AGENTS.html).

**Goal.** Make GenesisCA a place to *do* Graph-Rewriting Automata research, with an
authoring surface a non-mathematician can use: **census → rule table → verb**.
Bond attributes (the long-recorded missing capability) land as phases 2–3 and are
the enabler for typed rewriting and combinatorial division.

---

## 1. The authoring model this plan delivers

```
   ┌─────────────────────────┐
   │  Neighbour State Census │   one node → one output port per state value
   │  (bonded 1-ring)        │   "2 red, 1 blue, 0 green"
   └───────────┬─────────────┘
               │  counts
   ┌───────────▼─────────────┐
   │  N-D Lookup Table       │   axes: [own state, #red, #blue, …]
   │  value type: TAG        │   value: Idle | Divide | Die | Bond | Unbond | Rewire
   └───────────┬─────────────┘   ← seeded Randomize = rule-space search
               │  verb
   ┌───────────▼─────────────┐
   │  Switch on the verb     │ → Divide Agent / Kill Agent / Form Bond /
   └─────────────────────────┘    Break Bond / Rewire Bond
```

Everything on that diagram except the census node and the Rewire verb **already
exists**. The rule is a *table you can look at*, not a formula; a Randomize button
rolls new rules; the Overseer sweeps them and reports which ones grow.

---

## 2. Phase sequence

Each phase is one fresh session. Dependencies are strict left-to-right unless noted.

```
P1  Census + Rule-Table macro + Life-on-Bonds sample     ← no engine change; proves the loop
P2  Bond attributes — schema, store, CPU ABI, JS + WASM  ← the recorded missing capability
P3  Bond attributes — WebGPU                             ← depends on P2
P4  Structural request QUEUE + the Rewire verb           ← the atomicity unblock (independent of P2/P3)
P5  Combinatorial division (per-bond assignment)         ← depends on P4 (and reads better with P2)
P6  Graph indicators + Overseer rule-space sweep         ← independent; best after P4
P7  Sample models (Cubic GRA, SDCA) + full docs sweep    ← depends on P4, P5, P6
P8  Visual before/after motif editor        [STRETCH — separate decision, not scheduled]
```

**Launch order:** P1 → P2 → P3 → P4 → P5 → P6 → P7. P4 may run in parallel with
P2/P3 if two sessions are available (disjoint files: P4 is worker + request buffers,
P2/P3 are the bond store + layouts) — but the orchestrator should serialise unless
throughput demands otherwise, because both touch `agentEngine.ts`.

---

### P1 — Neighbour State Census + the GRA Rule Table macro

**Why first:** it is the entire "less mathematical" win, it needs **zero engine
change**, and it is verifiable against Conway's Life — the least ambiguous oracle in
the field.

**Deliverable**
- **`neighbourCensus` node** (agent, `requirements: { bondGraph: true }`): config =
  one agent tag/bool attribute; **multi-output, one integer port per option** (labelled
  with the option name) + a `total` port. Optionally a `source` config:
  `bonded` (default) | `nearby` (radius), so it also serves proximity models.
- **Lowering, not emitting** — a shared pre-compile transform
  `expandNeighbourCensus` (the `expandComposites` / `expandMultiAttrs` pattern)
  rewrites each census node into the existing
  `getBondedAgents → getAgentsAttribute → groupCounting` chain, once per consumed
  output port. **Consequence: zero per-target emit; all three agent targets work by
  construction**, and the WASM/WebGPU gates see only already-supported node types.
- **"GRA Rule Table" default macro** (`public/macros/`): census → N-D Lookup Table
  (tag-valued) → Switch → the five verbs, pre-wired with labelled reroutes.
- **Sample: `Life on Bonds`** (`scripts/gen-life-on-bonds.mjs`) — agents on a 32×32
  torus lattice, **bonded** to their 8 Moore neighbours by the Agent Init Event,
  Conway's rule expressed as census → table → set state. Agents pinned
  (`motion: 'static'`-profile, `customForcesOnly`, momentum 0).

**Exit gate**
- **O7 (differential vs. a shipped model)** — the bonded Life must produce a
  **cell-for-cell identical state sequence** to the shipped proximity-based
  `Game of Life on Agents` over ≥ 200 generations, on the same seed. Same
  neighbourhood ⇒ identical dynamics; any divergence is a census bug.
- **O3 (identity rule)** — a table mapping every input to `Idle` leaves N, E and every
  agent state bit-identical for 100 generations.
- **O11 (Life patterns)** — block still-life stable ≥ 50 gens; blinker period exactly
  2; toad period 2; glider returns to its start shape translated by (1,1) after
  exactly 4 generations.
- Lowering is a **hot-path no-op** when no census node exists ⇒
  `scripts/check-compile-identity.mjs` reports all shipped models unchanged.
- `scripts/parity-agent-wasm.mjs` green, incl. a new census synthetic.

---

### P2 — Bond attributes: schema, store, CPU ABI, JS + WASM

**Deliverable**
- **Schema** `CAModel.bondAttributes?: Attribute[]` — additive, types restricted to
  **bool / integer / float / tag** (decision D1). LOAD_MODEL guard; reducer actions
  mirroring `*_AGENT_ATTRIBUTE` (add/update/remove/duplicate/reorder) with the
  tagOptions remap + removal cascade over node configs.
- **Store** — one ragged region per bond attribute (`maxAgents * maxBonds`), typed by
  kind, appended to `computeAgentMemoryLayout` **after** the existing regions so
  every current offset stays byte-stable. `formBond` takes initial values.
  **Both compaction paths (`breakBond`, `freeAgentSlot`) must swap the new fields in
  lockstep** — the single highest-risk line in the phase.
- **ABI** — a `_bondAttr_<id>` block in `deriveAgentAbi` for `kind: 'loop'` **and**
  `kind: 'division'` (division currently carries only partner/rest/epoch/maxBonds —
  it needs the attribute regions too for P5). Use the reserved `gate(profile)` hook so
  the whole block drops when `bonds === 'off'`. **One edit; all four mirrors follow.**
- **Nodes** — `getBondAttribute(partnerId)` / `setBondAttribute(partnerId, value)`
  (write is symmetric: both slots, per I2); `formBond` gains attribute slots
  (the `multiAttrExpand` slot pattern, or config-driven initial values —
  implementer's call, documented in the completion report). `forEachBond` optionally
  exposes attributes as extra outputs.
- **Emit** — JS + WASM (`L.bondI32` / `L.bondF64` named regions). Added to
  `AGENT_WASM_SUPPORTED_TYPES`. **WebGPU gate REJECTS** models using the new nodes ⇒
  clamps to WASM/JS, with the Properties hint stating why (P3 lifts it).
- **UI** — a Bond Attributes section on the Agents graph (master-detail, mirroring
  agent attributes). ⚠️ `ModelerView.selectedItemName` must resolve a `bond:<id>`
  slot or the detail panel silently never mounts (the shipped agent-attribute bug).
- **Inspector** — the agent popover lists bonds with their attribute values.
- **Save/load** — `.gcaproj` bond attrs; `.gcastate` bond payload (the serializer
  already ships every bond field — extend it, don't rewrite it).

**Exit gate**
- **I2 (bond symmetry)** — after each of 200 generations of a rule that writes bond
  attributes from *one* side only, every bond reads identically from both sides.
- **I1 (handshake)** and **I4 (capacity)** hold every generation.
- **Compaction test** — a rule that breaks bonds at random for 500 generations, then
  a full-store audit: no attribute is ever associated with the wrong partner.
  (This is the swap-with-last lockstep test; it is the reason for the 500 gens.)
- `scripts/parity-agent-wasm.mjs` — a new bond-attribute synthetic, JS↔WASM
  **bit-identical**; all existing entries unregressed.
- `scripts/audit-agent-layout.mjs` + `scripts/test-agent-abi.mjs` green
  (layout ≡ compiler layout; the four ABI mirrors agree).
- `scripts/check-compile-identity.mjs` — every shipped model unchanged (no model has
  bond attributes yet, so the new regions must not exist for them).

---

### P3 — Bond attributes on WebGPU

**Deliverable**
- Widen the `bondStore` from stride 2 to `2 + N` through **one shared constant**
  (`BOND_STRIDE`), never a find-and-replace over the `* 2u` sites.
- Resolve **D3**: promote binding 11 to `var<storage, read_write>` (recommended —
  each thread writes only its own slots, and the symmetric partner write is a second
  indexed store, which is thread-owned too *only if* the partner is not concurrently
  written; **if that cannot be guaranteed, route bond-attribute writes through a
  request buffer and say so in the completion report**).
- Un-gate the P2 nodes in `AGENT_WEBGPU_SUPPORTED_TYPES`; keep `usesBondStore` gating
  the binding declaration (Naga strips unused globals ⇒ bind-group mismatch).
- Upload/readback the attribute lanes in `agentWebgpuRuntime.ts`.

**Exit gate**
- **Real-GPU** `createShaderModule` with 0 errors and 0 validation errors, 2D + 3D.
- **Cross-target agreement** — the same bond-attribute model run on JS, WASM and
  WebGPU produces the same *statistical* outcome; the *structural* invariants
  (I1, I2, I4) hold exactly on all three.
- `scripts/verify-agent-render.mjs` + a real in-browser run of a bond-attribute model
  on `agentTarget: 'webgpu'` with 0 worker/GPU errors.

---

### P4 — Structural request queue + the Rewire verb

**The atomicity unblock.** Without it, invariant **I6** is untestable and no
degree-preserving GRA can be authored.

**Deliverable**
- Replace the single `bondFormReq` / `bondBreakReq` cells with **bounded per-agent
  queues** (depth configurable, default 8 — decision D5), plus a per-agent cursor.
  Overflow **rejects the excess op and surfaces a notice** — never wraps, never
  half-applies (I5).
- **`rewireBond` verb** — atomic `break(self, b)` + `form(self, c)` applied as a unit
  (decision D6). This is the operation GRA names; atomicity is free if the engine
  applies it as one step-1 entry.
- Emit on **all three** agent targets (each writes a queue slot + bumps the cursor).
- Structural phase drains the queues in slot order, before death/division (unchanged
  ordering).

**Exit gate**
- **I5 (atomicity)** — a rule that requests `depth + 3` ops per agent: exactly `depth`
  apply, the remainder are rejected, and the graph is *exactly* the pre-step graph
  plus those `depth` ops. No partial rewires anywhere.
- **O5 (pure rewiring conserves)** — a rule using only `rewireBond`: N, E and the
  full **degree multiset** are invariant over 500 generations, exactly.
- **I1–I4** every generation.
- JS↔WASM bit-parity on a new queue synthetic; WebGPU real-GPU run.

---

### P5 — Combinatorial division (per-bond assignment)

**Deliverable**
- `DivideAgent.partition` config: `tension` (current, default — byte-identical) |
  `alternate` | `byBondAttribute` | `byRule`.
- **`byRule`** exposes an `assignBondToDaughter` verb inside the Division Event, used
  under a `For Each Bond` over the mother's inherited bonds: **A / B / both / drop**.
  (The division ABI already carries the bond slice; P2 adds the attribute regions.)
- **D4** — a config for "always add the daughter–daughter bond", defaulting to *on*
  under the Graph Rewriting capability preset.
- Engine: `divideAgent` gains an assignment callback / mode; overflow still rejects
  the **whole** division (I5).

**Exit gate**
- **I7 (conservation)** — the daughters' inherited (partner, attributes) multiset
  equals the mother's minus explicitly dropped, plus the A–B bond. Checked every
  division over ≥ 1000 divisions.
- **`tension` mode is byte-identical** to pre-change (`check-compile-identity` +
  a Growing Tissue regression: same growth curve, same bond count).
- **O6 (degree preservation)** — the cubic **triangle split** (§4, O6) implemented
  with P4's queue + P5's assignment holds `E == 3N/2` and `min deg == max deg == 3`
  at every rule step, over ≥ 200 splits.

---

### P6 — Graph indicators + the Overseer rule-space sweep

**Deliverable**
- Agent-side graph indicators: **node count, edge count, mean degree, max degree,
  degree histogram, connected components**. (Components: a union-find pass in the
  structural phase or a bounded label-propagation — implementer's call; document the
  cost, it is the only non-O(N) one.)
- Surface them like linked indicators (chart + CSV) and make them readable by
  `ovReadIndicator` so the Overseer can sweep.
- Overseer sample protocol: `Clear Series → forEach(seed in sweep) {
  ovRandomizeTable(rule, seed) → ovResetBoard → ovRunUntilStop(N) →
  ovCollectSample(nodes, edges, meanDegree) → ovLog }`.

**Exit gate**
- Indicator values agree **exactly** with an independent recount from `getState`
  (edge count via I1, degree histogram vs. a direct `bondCount` tally).
- A 16-seed sweep produces a rule → outcome table, reproducible across two runs
  (same seeds ⇒ same values), exported to CSV.

---

### P7 — Sample models + documentation sweep

**Deliverable**
- **`Cubic GRA`** — 3-regular seed graph, the triangle-split / triangle-contract /
  edge-swap operation set, rule table with Randomize, shipping the Overseer sweep
  from P6. This is the flagship.
- **`SDCA — Couplers and Decouplers`** — Ilachinski–Halpern: a value rule plus a link
  rule with the Nowotny–Requardt hysteresis band (on above λ₂, off below λ₁).
- Docs: CLAUDE.md section, HelpView, README, `docs/NODES_REFERENCE.md` (node counts +
  table rows + Mermaid), library compile-target policy applied.

**Exit gate**
- Both samples run on their gated-in targets with 0 errors, and satisfy I1–I4 (and
  I6 for the cubic one) over ≥ 500 generations in the real worker.
- A verification pass in a **visible** browser pane (the force-directed embedding is
  the whole point — someone must look at it).

---

### P8 — Visual before/after motif editor *(stretch; separate decision)*

Draw the pattern (centre + coloured neighbours) on the left, the replacement on the
right, interfaces matched by position; compile to the existing nodes via a shared
pre-compile expansion. Scope strictly to **node-local, unordered-neighbour** rules.
⚠️ Introduces a *fourth* graph-shaped editing surface — see Impact Map §6.4. Do not
schedule without an explicit decision.

---

## 3. What each phase must NOT do

- **No JS-only features.** Every phase either lands all three agent targets or uses
  the existing **capability gate** to reject cleanly with a stated reason (the
  PR6b-1/2/3 precedent). Never add a node to a silent JS clamp.
- **No shape-specific gates.** Gates key on general properties (`topologyMode`,
  resolved target, capability profile, usage flags) — never on a particular model.
- **No layout reordering** of existing regions. Bond-attribute regions append.
- **No scope creep into rotation systems, motif matching, or the cell-grid graph
  mode** (Impact Map §6.3).

---

## 4. Test-oracle catalogue

The verification contract. **O1–O5 and O9–O10 are mathematically self-evident** (no
literature dependency). **O6 and O7/O11** are the ones that connect to the field, and
both are chosen so that the oracle is unambiguous.

A shared harness `scripts/verify-graph-rewrite.mjs` should implement O1–O5, O9 as
reusable checkers over a `getState` agent payload, so every later phase reuses them.
**Every invariant added there needs a negative-control mutation proving it fails when
broken** (the project's harness rule).

---

### O1 — Handshake lemma *(universal, every phase)*
> In any undirected graph, `Σ deg(v) = 2|E|`.

Check `Σ over live agents bondCount[i] == 2 × |distinct live bonds|`, every
generation. **Catches:** asymmetric bonds, half-applied form/break, bonds not cleaned
on death. Zero literature risk — it is a lemma.

### O2 — Bond symmetry *(P2 onward)*
For every live `i`, every epoch-valid slot `k` with partner `p`: `p`'s list contains
`i`, with identical rest length, stiffness **and every bond attribute**.
**Catches:** one-sided writes; compaction that swaps some fields but not others.

### O3 — Identity rule *(P1)*
A rule table mapping every input to `Idle` ⇒ N, E, every agent state and every bond
attribute bit-identical over 100 generations. **Catches:** spurious mutation.

### O4 — Deterministic doubling *(P5)*
Every node divides every step; no death; ample capacity. Then exactly:
```
N_t = N_0 · 2^t
E_t = E_0 + N_0 · (2^t − 1)     # each division adds exactly one A–B bond
```
**Catches:** off-by-one in the division population bound, mis-counted inherited bonds,
silent capacity rejection (which shows as N falling behind the closed form).

### O5 — Pure rewiring conserves *(P4)*
A rule using only `rewireBond`: **N, E and the full degree multiset** are invariant.
**Catches:** rewire implemented as non-atomic break+form (degree dips), or a rewire
that drops the old edge without adding the new one.

### O6 — Cubic degree preservation *(P5/P7 — the flagship GRA oracle)*
Operation set (defined by us; see Impact Map §6.2 for why this is safe):

| op | effect | ΔN | ΔE |
|---|---|---|---|
| **triangle split** — `v(a,b,c)` → `v₁,v₂,v₃`, `v₁–a, v₂–b, v₃–c`, triangle `v₁v₂v₃` | each new node: 1 external + 2 triangle = deg 3 | +2 | +3 |
| **triangle contract** (inverse) | — | −2 | −3 |
| **edge swap** | — | 0 | 0 |

Invariants, at **every rule step**:
```
min degree == max degree == 3
E == 3N/2                        # 3N/2 + 3 == 3(N+2)/2  ✓
```
**Catches:** everything — non-atomic ops, lost bonds, wrong division partition,
capacity rejection. **This is the end-to-end GRA test**, and it is only satisfiable
after P4 (atomicity) and P5 (combinatorial partition). ⚠️ It tests *our* operation
set; a session verifying Suzudo's exact set may adjust the sample model, not the
engine.

### O7 — Differential vs. a shipped model *(P1 — the strongest early oracle)*
Bond each agent to its 8 Moore neighbours, run Conway's rule via census → table.
Must produce a **cell-for-cell identical state sequence** to the shipped
`Game of Life on Agents` (which uses proximity for the same neighbour set) over
≥ 200 generations from the same seed. **Catches:** any census miscount. Zero
literature risk — it is a differential test against already-verified code.

### O8 — SDCA hysteresis *(P7)*
With the Nowotny–Requardt band (`λ₂ ≥ λ₁`): drive the neighbour density up across
λ₂ and back down between λ₂ and λ₁ — the edge must **turn on once and not flicker**.
Also: value rule = identity + thresholds that never fire ⇒ topology exactly
invariant. **Catches:** threshold applied symmetrically (no hysteresis).

### O9 — Bond-attribute conservation across division *(P5)*
The daughters' inherited (partner, attribute-tuple) multiset == the mother's, minus
explicitly dropped, plus the new A–B bond's initial values. **Catches:** attributes
re-initialised instead of inherited; attributes attached to the wrong partner after
the geometric/rule partition.

### O10 — Growth-law statistics *(P6 — exercises the Overseer)*
Each node divides with probability `p` per step ⇒ `E[N_t] = N_0 (1+p)^t`.
20 replicates via the Overseer; the mean must sit inside the CI. **Catches:** biased
RNG consumption in the structural path; also a smoke test of the whole sweep harness.

### O11 — Conway pattern oracles *(P1)*
Block stable ≥ 50 gens; blinker period exactly 2; toad period 2; beacon period 2;
glider returns to its shape translated by (1,1) after exactly 4 generations
(torus large enough to avoid wrap interference). **Catches:** an off-by-one in the
census or the table's own-state axis.

---

## 5. Sample models (deliverables, not just tests)

| Model | Phase | Demonstrates | Oracle |
|---|---|---|---|
| **Life on Bonds** | P1 | census → table → state; a graph rule with fixed topology | O7, O11 |
| **Cubic GRA** | P7 | the flagship: degree-preserving rewriting, Randomize, Overseer sweep | O6 |
| **SDCA — Couplers and Decouplers** | P7 | Ilachinski–Halpern dual coupling + hysteresis | O8 |
| *(optional)* **Bond-Typed Tissue** | P5 | bond attributes driving division partition (apical/basal) | O9 |

---

## 6. Open decisions (owner: orchestrator)

Carried from Impact Map §6.1 — each must be **resolved and recorded** in the phase
that first needs it.

| ID | Decision | Needed by | Recommendation |
|---|---|---|---|
| D1 | Bond attribute types | P2 | bool / integer / float / tag only |
| D2 | Directed semantics | P2 | keep symmetric; document the `ownerId`-attribute idiom |
| D3 | WebGPU bond writes | P3 | `read_write` for attributes; requests for structural ops |
| D4 | Always add the A–B bond | P5 | config, default on under the Graph Rewriting preset |
| D5 | Queue depth | P4 | fixed per-agent, default 8, configurable |
| D6 | Rewire atomicity | P4 | one atomic verb |
| D7 | Census `source` (bonded vs nearby) | P1 | ship both; `bonded` default |
| D8 | Ship P8 (motif editor) at all | — | defer; separate decision |

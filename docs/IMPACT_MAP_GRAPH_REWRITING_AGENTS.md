# Impact Map — Graph-Rewriting Automata on the Bond-Graph Agent tier

> **Status:** design authority. Subsystem-by-subsystem impact analysis for making
> GenesisCA a first-class **Graph-Rewriting Automata (GRA)** environment, plus the
> long-recorded **bond attributes** capability. No code has changed. The phased
> plan is [PLAN_GRAPH_REWRITING_AGENTS.md](PLAN_GRAPH_REWRITING_AGENTS.md) (+ `.html`
> mockup); execution is orchestrated via
> [HANDOFF_GRAPH_REWRITING_AGENTS.md](HANDOFF_GRAPH_REWRITING_AGENTS.md).
>
> **Companion, different substrate:** [INVESTIGATION_GRAPH_CA.md](INVESTIGATION_GRAPH_CA.md)
> studies a *cell-grid* graph mode (static topology, CSR adjacency). That document's
> **Phase 6** is "Structurally Dynamic CA" and it concluded CSR is the *worst*
> structure for mutation. **This document is the answer to that problem**: the agent
> tier's bond store is *already* a mutable ragged adjacency with per-node capacity —
> the structure SDCA/GRA needs. GRA belongs on the agent tier, not the lattice.

---

## 1. Executive summary

**The ask.** Make GenesisCA able to *study* Graph-Rewriting Automata — automata
where the graph itself is rewritten by local rules — and make authoring them
**non-mathematical**: a table and a handful of verbs, not a category-theoretic
gluing morphism.

**The finding.** The bond-graph agent tier is already ~70% of a GRA engine. Agents
are nodes with arbitrary user state; bonds are a symmetric, epoch-stamped, ragged
adjacency; Divide / Kill / Form Bond / Break Bond / Create Agent are the rewrite
verbs; the structural phase is a deterministic conflict arbiter; and the force
engine gives a **live force-directed embedding for free** — which most GRA tooling
has to bolt on. What is missing is not a paradigm, it is four concrete mechanics.

**The four gaps** (each verified in code, §3):

| # | Gap | Consequence for GRA |
|---|---|---|
| G1 | **One structural request slot per agent per step** — `_bondFormReq[idx]` / `_bondBreakReq[idx]` are single `i32` cells; a later call in the same step *replaces* the earlier one | A rewrite that adds 2 edges and drops 1 takes 3 steps, and the intermediate states **violate the rule's invariants**. This is what makes degree-preserving GRA inexpressible. |
| G2 | **Division partitions bonds geometrically** (`sign(dot(offset, axis))`) | GRA's division is *defined* by which edges go to which daughter. Geometry is exactly the thing you cannot say. |
| G3 | **No bond attributes.** `bondTypeLabel` exists in the store and rides the ABI but nothing exposes it | No edge state, no edge types, no labelled rules, no SDCA link variables. |
| G4 | **No neighbour-state census as a first-class value** | The multiset of neighbour states — the *only* legal input to a homogeneous graph rule — must be hand-wired once per state value. |

**The reduction that makes this tractable.** General graph rewriting needs subgraph
isomorphism (NP-hard). **Node-local** rewriting does not: the match is always "a
node and its 1-ring", which is a lookup, not a search. Every GRA in the literature
that is actually *simulated* (as opposed to *formalised*) takes this restriction.
So the whole authoring surface reduces to:

> **census → table → verb**
>
> `(own state, counts of neighbour states) → a rule table → one of {Idle, Divide, Die, Bond, Unbond, Rewire}`

GenesisCA already ships the table (N-D Lookup Table, tag-valued, with seeded
Randomize) and the verbs. It is missing the census (G4) and the verbs' *atomicity*
(G1) and *combinatorial control* (G2).

**Recommended scope.** Phases 1–7 in the plan; the visual before/after motif editor
(Phase 8) is a separate decision. **Bond attributes (G3) are phases 2–3** and are
independently valuable — they are the enabler for typed rewriting, SDCA link
variables, and combinatorial division ("give daughter A the bonds labelled *apical*").

---

## 2. What GRA is, in this codebase's vocabulary

### 2.1 The lineages

- **GRA proper** — Suzudo (~2004–05); Tomita, Kurokawa & Murata (*Graph automata:
  natural expression of self-reproduction*, Physica D 2002; self-describing
  graph-rewriting automata, ~2007). Canonically a **3-regular** graph, a small state
  alphabet, and operations chosen to *preserve* the degree invariant.
  ⚠️ **Citation confidence: MEDIUM.** The lineage and the degree-invariant design are
  solid; exact titles/venues/operation sets are from memory and **must be verified
  against the sources before any published claim of faithfulness**. Nothing in this
  plan *depends* on that verification — see §6.2 (we define our own operation set and
  test it against invariants that are true by construction).
- **Structurally Dynamic CA** — Ilachinski & Halpern 1987 (**verified** in
  [INVESTIGATION_GRAPH_CA.md](INVESTIGATION_GRAPH_CA.md) §13). A value rule *plus* a
  link rule `λᵢⱼ' = ψ(λᵢⱼ, σᵢ, σⱼ)` split into **couplers** (add edge) and
  **decouplers** (remove edge). Nowotny & Requardt add the **hysteresis** anti-flicker
  device (on above λ₂, off below λ₁, λ₂ ≥ λ₁).
- **Hypergraph rewriting** — Wolfram Physics Project (2020). Out of scope: hyperedges
  are not bonds.
- **Graph grammars** — DPO/SPO (Ehrig et al.). The formalism we are deliberately
  *not* exposing.

### 2.2 The three things that make GRA look mathematical, and how each is avoided

| Difficulty | Why it is hard in general | How node-local GRA avoids it | GenesisCA's existing analogue |
|---|---|---|---|
| **Matching** | subgraph isomorphism is NP-hard | the match is a node + its 1-ring — a lookup | `For Each Bond` / `Get Bonded Agents` |
| **Gluing** (where do dangling edges reattach?) | the interface morphism; the reason DPO is category-theoretic | the only node ever removed/split is the centre, so the dangling edges are exactly *its* bonds — a per-bond **assignment**, authorable as a flow chain | the Division Event (already receives a bond slice — §3.4) |
| **Parallel conflict** | overlapping matches | a deterministic structural phase + capacity rejection + a documented update mode | `runAgentStructuralPhase`, `agentUpdateMode` |

**This is the load-bearing design claim of the whole milestone**: with node-local
rules, the formalism collapses to a table plus verbs, and the user never meets a
pushout.

---

## 3. Current-capability audit (verified in code)

### 3.1 The mapping that already works

| GRA concept | GenesisCA today | Where |
|---|---|---|
| node + state | agent + `agentAttributes` | `agentAttrsOf`, [attributeScope.ts](../src/model/attributeScope.ts) |
| edge | bond — symmetric, epoch-stamped, capacity `maxBonds` | [agentEngine.ts](../src/simulator/engine/agentEngine.ts) `formBond`/`breakBond` |
| 1-ring | Get Bonded Agents / For Each Bond | [ForEachBondNode.ts](../src/modeler/vpl/nodes/ForEachBondNode.ts) |
| degree | Get Bond Degree (`s.bondCount`) | `GetBondDegreeNode.ts` |
| neighbour-state multiset | Get Agents Attribute → Group Counting (per value, hand-wired) | — |
| rule table | **N-D Lookup Table**, tag-valued, seeded Randomize | CLAUDE.md "N-Dimensional Lookup Tables" |
| division | Divide Agent + per-daughter Division Event | [DivideAgentNode.ts](../src/modeler/vpl/nodes/DivideAgentNode.ts) |
| annihilation | Kill Agent (`freeAgentSlot` breaks all bonds, bumps epoch) | `agentEngine.ts` |
| coupler / decoupler | Form Bond / Break Bond | [FormBondNode.ts](../src/modeler/vpl/nodes/FormBondNode.ts), [BreakBondNode.ts](../src/modeler/vpl/nodes/BreakBondNode.ts) |
| node creation | Create Agent → Add Agent To World (init **and** behaviour) | unified spawning |
| update scheme | `agentUpdateMode: sync | async` | `centerBased.ts` |
| conflict arbitration | the structural phase (see §3.2) | `sim.worker.ts` `runAgentStructuralPhase` |
| **layout** | the force engine — live force-directed embedding, 2D + 3D | — |
| rule-space search | Randomize seed + the **Overseer** (sweep, replicate stats, journal) | CLAUDE.md "Overseer" |

### 3.2 The structural phase is already the conflict arbiter

`runAgentStructuralPhase()` ([sim.worker.ts](../src/simulator/engine/sim.worker.ts)),
run once per generation on the **settled post-force state**, in this fixed order:

```
1.  bond requests   — apply bondFormReq / bondBreakReq, then CLEAR both slots
1b. death           — freeAgentSlot (breaks all bonds, bumps epoch)
1c. division        — divideAgent over the PRE-division population only
    → runDivisionEvent(divideEvents)   (per (mother, daughterA, daughterB))
2.  auto-bond by distance (opt-in, hysteresis)
3.  stale-bond sweep (epoch mismatch)
```

Three consequences that any GRA design must respect:

- **A bond request written by the Division Event lands one step later.** Step 1 has
  already run when `runDivisionEvent` fires; the request survives in the buffer and
  is consumed by the *next* generation's step 1. Not a bug — but it means "the
  daughters bond to X at birth" is not currently expressible atomically.
- **Division is atomic per agent**: capacity overflow (`maxAgents` or either
  daughter's `maxBonds`) rejects the **whole** division and surfaces a notice. There
  is never a half-rewired partner.
- **The daughter–daughter bond is only added when the mother was bonded.** An
  isolated node dividing yields two *unbonded* nodes. For GRA you almost always want
  it unconditionally (§5, D4).

### 3.3 G1 — one request slot per agent per step (verified)

```ts
// FormBondNode.compile
_bondFormReq[idx] = ((target)|0) + 1; _bondFormL[idx] = restLength; _bondFormK[idx] = stiffness;
// BreakBondNode.compile
_bondBreakReq[idx] = ((target)|0) + 1;
```

Single `i32` cells indexed by agent. Both node descriptions already say so:
*"One request per agent per step — a later call this step replaces an earlier one."*
This is the **single biggest blocker** for faithful GRA: every degree-preserving
operation (triangle split, edge swap, pair annihilation) needs 2–5 edge mutations
at one node **in one step**, and the intermediate states of a multi-step emulation
violate the very invariant the rule is defined to preserve.

### 3.4 G2 — division partitions bonds geometrically

`divideAgent` assigns each partner bond to the nearer daughter by
`sign(dot(offset, m̂))`, adds a daughter–daughter bond, and stamps the resolved axis.
There is no hook to say *"daughter A takes the bonds labelled X"*.

**The foothold**: the Division Event's ABI **already carries a bond slice** —
`_bondPartner`, `_bondRestLength`, `_bondPartnerEpoch`, `maxBonds`
([agentAbi.ts](../src/modeler/vpl/compiler/agentAbi.ts), `kind === 'division'`), so
`For Each Bond` works inside it today. The missing piece is an *assignment verb*,
not new plumbing.

### 3.5 G3 — bond attributes: what exists and what does not

**Exists** (engine + CPU ABI):

- `AGENT_BOND_I32_FIELDS = ['bondPartner', 'bondPartnerEpoch', 'bondTypeLabel']`
  plus f64 `bondRestLength`, `bondStiffness` — all ragged, `maxAgents * maxBonds`.
- The WASM layout exposes **named** bond regions: `L.bondI32['bondPartner']`,
  `L.bondF64['bondRestLength']`, … — so adding a region is the established shape.
- **`_bondTypeLabel` is already a loop-ABI parameter.** The JS agent loop receives it
  today; a node reading it needs *no ABI change*.
- `formBond(s, i, p, L, K)` writes `bondTypeLabel[base] = typeLabel`; the compaction
  paths (`breakBond`, `freeAgentSlot`) already swap-with-last **all** bond fields in
  lockstep — so a new field that follows the same pattern inherits correct compaction.
- `snapshotBonds` / `serializeAgentStore` / `deserializeAgentStore` already round-trip
  every bond field.

**Does not exist**: any schema (`bondAttributes`), any node (Get/Set Bond Attribute),
any UI, any initial-value input on Form Bond, and — critically — **any bond payload on
the WebGPU agent target beyond partner + rest length** (§3.6).

### 3.6 The WebGPU bond store is the tightest constraint

[agentWebgpu/layout.ts](../src/modeler/vpl/compiler/agentWebgpu/layout.ts):

```
bondStoreLen = maxAgents * maxBonds * 2      // stride 2 i32 per bond slot
bond k of agent idx = bondStore[idx*maxBonds*2 + k*2]      // partner (i32)
                      bondStore[idx*maxBonds*2 + k*2 + 1]  // rest length (f32 bits)
```

and the binding is **read-only**:

```wgsl
@group(0) @binding(11) var<storage, read> bondStore : array<i32>;
```

Three consequences for bond attributes on WebGPU:

1. The stride-2 literal `* 2u` appears at ~4 emit sites (`forEachBond`,
   `getBondedAgents`, …) — widening it must go through **one shared constant**, not
   a find-and-replace.
2. `read` means **Set Bond Attribute cannot write from the behaviour shader**. Either
   promote the binding to `read_write` (the `agentAlive` precedent under spawning) or
   route bond writes through the request mechanism. **Decision D3.**
3. `usesBondStore` gates the binding's *declaration* — Naga strips an unused storage
   global and the bind group then mismatches the pipeline layout (the shipped
   GoL-on-agents bug). Any new binding follows that discipline.

### 3.7 What is genuinely absent (no foothold at all)

- **Rotation system.** Bond slot order is insertion / swap-with-last. There is no
  cyclic order around a node ⇒ planarity-preserving GRA cannot be expressed
  faithfully. **Out of scope**, flagged in §6.
- **Merge / fuse two nodes into one.** No primitive. (Pair annihilation = kill one +
  rewire the other's bonds ⇒ needs G1's queue.)
- **Graph-global metrics.** No node/edge count, degree histogram, or component count.
  Partial workaround today: standalone indicators + `Update Indicator` *increment*
  per agent (works JS/WASM; WebGPU rejects the order-dependent ops but increment is
  fine).

---

## 4. Subsystem impact table

✅ reuse as-is · ✏️ modify · ➕ new · 🚫 gate off. **P** = the phase that owns it.

| # | Subsystem | File(s) | Change | P | Risk / verify |
|---|---|---|---|---|---|
| 1 | Node registry | `vpl/nodes/registry.ts` + new node files | ➕ Neighbour State Census, Get/Set Bond Attribute, Rewire Bond, Assign Bond To Daughter | 1,2,4,5 | catalogue counts in NODES_REFERENCE |
| 2 | Census lowering | ➕ `compiler/censusExpand.ts` | ➕ shared pre-compile expansion → existing gather+count nodes | 1 | **zero per-target emit** if lowered (the `expandComposites` pattern) |
| 3 | Default macros | `public/macros/*.gcamacro` | ➕ "GRA Rule Table" macro | 1 | dev-server restart to re-index |
| 4 | Schema | `model/types.ts` | ➕ `CAModel.bondAttributes?: Attribute[]`; ➕ `DivideAgent.partition` config; ➕ `graphRewrite?` config block if needed | 2,5 | additive; LOAD_MODEL guards |
| 5 | Reducer + cascades | `model/ModelContext.tsx` | ➕ ADD/UPDATE/REMOVE/DUPLICATE/REORDER_BOND_ATTRIBUTE; tagOptions remap; removal clears node configs | 2 | mirror `*_AGENT_ATTRIBUTE` exactly |
| 6 | Agent store | `engine/agentEngine.ts` | ✏️ per-bond-attribute ragged regions; `formBond` initial values; compaction lockstep; snapshot/serialize | 2 | **compaction must swap ALL fields** — a missed field silently corrupts on any break |
| 7 | CPU memory layout | `engine/agentEngine.ts` `computeAgentMemoryLayout` | ✏️ append bond-attr regions (existing offsets byte-stable) | 2 | baked-offset lockstep: store layout ≡ compiler layout |
| 8 | Shared ABI | `compiler/agentAbi.ts` | ✏️ `_bondAttr_<id>` block in `loop` + `division`; use the reserved `gate(profile)` for `bonds === 'off'` | 2 | **one edit serves all 4 mirrors** — that is the point of the descriptor |
| 9 | JS agent compiler | `compiler/compile.ts` | ✏️ census/bond-attr/rewire emit; `buildAgentLoopParams` follows the descriptor | 1,2,4,5 | `NEVER_PURE_TYPES` for bond reads (mutable storage) |
| 10 | WASM agent compiler | `compiler/agentWasm/compile.ts` | ✏️ bond-attr regions via `L.bondI32`/`L.bondF64`; queue emit; supported-types entries | 2,4,5 | JS↔WASM **bit-parity** is the gate |
| 11 | WebGPU agent compiler | `compiler/agentWebgpu/{compile,layout}.ts` | ✏️ bondStore stride constant; ➕ attr lanes; `read`→`read_write` or a write request; supported-types | 3,4,5 | Naga strips unused globals → bind-group mismatch; real-GPU verify |
| 12 | Structural phase | `engine/sim.worker.ts` | ✏️ request **queues** instead of single slots; rewire op; division bond assignment | 4,5 | order + atomicity; overflow rejects whole ops |
| 13 | Capability profiles | `model/agentCapabilities.ts` | ✏️ `AGENT_NODE_REQUIREMENT` for the new nodes; a "Graph Rewriting" preset | 1,2,4 | `bonds !== 'off'` gates the whole family |
| 14 | Node validation | `nodes/nodeValidation.ts` | ✏️ `detectMissingConfig` for every new reference-typed config | 1,2,4,5 | a missing case ⇒ silent `_undef` |
| 15 | Modeler UI | `panels/AttributesPanelContent.tsx` | ➕ Bond Attributes section (Agents graph), master-detail like agent attrs | 2 | `selectedItemName` must resolve `bond:<id>` or the detail panel never mounts |
| 16 | Properties UI | `panels/AgentCapabilitiesSection.tsx` | ✏️ bond-request queue depth; division partition mode | 4,5 | live vs `needsFullInit` |
| 17 | Indicators | `engine/sim.worker.ts`, `IndicatorDisplay.tsx` | ➕ graph indicators (N, E, mean/max degree, degree histogram, components) | 6 | agent-side aggregation, not cell-linked |
| 18 | Overseer | `compiler/overseer/*`, `ExperimentsPanel.tsx` | ✅ reuse — rule-space sweep needs no new node | 6 | `ovRandomizeTable` already re-rolls a table |
| 19 | Inspector | `InspectAgentPopover.tsx` | ✏️ show bond list + bond attribute values | 2 | `getAgentState` already returns live bonds |
| 20 | Save / load | `model/fileOperations.ts` | ✏️ bond attrs in `.gcaproj`; bond payload in `.gcastate` | 2 | `serializeAgentState` already ships every bond field |
| 21 | Samples | `scripts/gen-*.mjs`, `public/models/` | ➕ Life-on-Bonds, Cubic GRA, SDCA | 1,7 | gen scripts + library policy (WebGPU where gated-in, else WASM) |
| 22 | Docs | CLAUDE.md, HelpView, README, NODES_REFERENCE | ✏️ every phase, same commit | all | the atomic-update rule |
| 23 | Harnesses | `scripts/` | ➕ `verify-graph-rewrite.mjs` (the invariant oracles, §5) | 1+ | **negative-controlled** or it proves nothing |

---

## 5. The invariants — what "correct" means here

These are the contract. They are **mathematically true by construction** (no
literature dependency), machine-checkable every step, and each one catches a
specific class of bond-bookkeeping bug. The plan's test catalogue
([PLAN](PLAN_GRAPH_REWRITING_AGENTS.md) §4) turns them into oracles.

| ID | Invariant | Catches |
|---|---|---|
| **I1 — Handshake lemma** | `Σ over live agents bondCount[i] == 2 × (number of distinct live bonds)` | asymmetric bonds, half-applied form/break, lost bonds on death |
| **I2 — Bond symmetry** | for every live `i`, slot `k` with epoch-valid partner `p`: `p`'s list contains `i`, with **identical** rest length, stiffness and every bond attribute | one-sided writes, compaction that swaps some fields but not others |
| **I3 — No dangling** | every epoch-valid partner id is in range, `alive`, and `!= self` | recycled-slot aliasing (the epoch mechanism's whole job) |
| **I4 — Capacity** | `bondCount[i] <= maxBonds` for all `i`, always | queue overflow silently wrapping instead of rejecting |
| **I5 — Atomicity** | a rejected op (capacity/overflow) leaves the graph **exactly** as before | half-applied rewrites — the worst failure mode, since it silently breaks I1/I6 |
| **I6 — Degree preservation** | under an operation set chosen to preserve degree `d`: `min degree == max degree == d` and `E == d·N/2`, at **every rule step** | the real end-to-end GRA test; only satisfiable once ops are atomic (G1) |
| **I7 — Conservation across division** | multiset of the daughters' inherited (partner, attributes) == the mother's, minus explicitly dropped, plus the new A–B bond | the combinatorial division path (G2) |

**I5 + I6 together are the argument for Phase 4.** With one request slot per step, a
degree-preserving operation *cannot* be atomic, so I6 is violated at every
intermediate generation and the invariant is untestable. Making the request buffers
bounded queues is what makes the whole milestone verifiable.

---

## 6. Risks, decisions, and explicit non-goals

### 6.1 Decisions to confirm before Phase 2 exits

- **D1 — Bond attribute types.** Recommend **bool / integer / float / tag only** in
  v1 (the scalar-numeric set that fits one number exactly on every target). Exclude
  vector / color / neighborIndex: a vector bond attribute would need the
  `lowerVectorAttrs` treatment on a *ragged* store — a separate milestone.
- **D2 — Directed semantics.** Bonds are symmetric. A "direction" is expressible as a
  bond attribute the two sides interpret differently, **but I2 (symmetry) means both
  slots hold the same value** — so an asymmetric bond attribute is *not* possible
  without breaking the invariant. Recommend: keep symmetric, document the idiom
  (store `ownerId` in a bond attribute and compare against self).
- **D3 — WebGPU bond writes.** `read_write` bondStore (mirrors the `agentAlive`
  spawning precedent) vs. routing writes through the CPU structural phase. Recommend
  **read_write** for attribute writes (thread-owned slot ⇒ no race) while *structural*
  ops stay request-based.
- **D4 — Always add the daughter–daughter bond in graph-rewriting mode?** Today it is
  conditional on the mother being bonded. Recommend a config, defaulting to
  unconditional when the Graph Rewriting capability preset is active.
- **D5 — Queue depth** (Phase 4): fixed per-agent capacity (recommend 8, configurable)
  vs. a shared ring. Fixed is simpler, matches `maxBonds`, and gives a clean
  "rejected, whole op" story (I5).
- **D6 — Rewire atomicity.** Is `Rewire(a→b, a→c)` one verb (atomic, cannot half-fail)
  or a queued break+form pair? Recommend **one verb**: it is the operation GRA
  actually names, and atomicity is free if the engine applies it as a unit.

### 6.2 Literature-faithfulness risk (and why it does not block anything)

Exact operation sets from the GRA papers are **memory-sourced (medium confidence)**.
The mitigation is structural: **the test oracles do not depend on them.** We define
our own cubic-preserving operation set —

> **triangle split**: node `v` with neighbours `a,b,c` → `v₁,v₂,v₃` with `v₁–a`,
> `v₂–b`, `v₃–c` and triangle edges `v₁v₂, v₂v₃, v₃v₁`. Every new node has degree
> `1 + 2 = 3`; `a,b,c` keep degree 3. **N: +2, E: +3**, so `E = 3N/2` is preserved
> exactly (`3N/2 + 3 = 3(N+2)/2`). Its inverse (**triangle contract**) is the
> annihilation. **Edge swap** conserves both.

— and test against `E == 3N/2` + min-degree == max-degree == 3, which are true of
*any* cubic graph regardless of whose paper defined the moves. If a later session
verifies Suzudo's exact set and it differs, only the *sample model* changes; no
engine or compiler work is invalidated.

### 6.3 Explicit non-goals (v1)

- **Rotation systems / planarity preservation** (§3.7). Needs an ordered cyclic
  adjacency; the bond store is a set with swap-with-last compaction.
- **Genus / Euler-characteristic tracking** — depends on faces, hence on a rotation
  system.
- **Subgraph / motif matching beyond the 1-ring.** The whole design rests on avoiding
  it. Two-hop remains hand-wireable (`Get Agent Attribute` by id).
- **Node merge / fusion** as a primitive (expressible via kill + rewire once Phase 4
  lands).
- **Hypergraph rewriting.**
- **The cell-grid graph mode** — that is [INVESTIGATION_GRAPH_CA.md](INVESTIGATION_GRAPH_CA.md),
  a different substrate with a different data-structure problem.

### 6.4 Standing risks

- **Baked-offset desync** (the documented `+64-cell` corruption class): the agent
  store's layout and the compiler's layout must be derived from the *same* inputs.
  Every phase that touches the layout re-runs `scripts/audit-agent-layout.mjs`.
- **Compaction lockstep**: `breakBond` and `freeAgentSlot` swap-with-last. A bond
  attribute added to the store but missed in *either* compaction path corrupts
  silently on the first bond removal — invisible until a user's rule breaks a bond.
  **I2 is the test that catches it.**
- **Capability-gate drift**: the palette gate, the WASM gate, and the WebGPU gate are
  three lists. A node added to one and not the others is either invisible or a silent
  target clamp.
- **UX overload**: GenesisCA already has two node graphs (Cells, Agents) and a third
  (Overseer). The motif editor (Phase 8) would introduce a *fourth* graph-shaped
  surface. Keep it modally distinct or defer.

---

## 7. Why this is a strong fit (the honest case)

1. **The data structure is already right.** The companion investigation concluded CSR
   is the worst structure for a mutating graph. The bond store is a mutable ragged
   adjacency with per-node capacity and epoch-stamped recycling — exactly what SDCA/GRA
   need, already verified across three compile targets.
2. **Layout is free and meaningful.** Springs + repulsion embed the evolving graph
   live in 2D or 3D. GRA papers publish static snapshots; this is an interactive
   force-directed view of the same object, with a brush.
3. **Rule-space search already exists.** Seeded table Randomize + the Overseer
   (sweep, replicate statistics, journal, CSV export) *is* the GRA research workflow —
   roll a rule, run it, measure whether it grows / dies / blows up, keep the seed.
4. **The authoring surface can genuinely be non-mathematical.** census → table →
   verb, with an optional before/after picture editor on top, and no user ever sees a
   pushout.

# PHASE P1 — Neighbour State Census + the GRA Rule Table

**Read first**: [HANDOFF_GRAPH_REWRITING_AGENTS.md](HANDOFF_GRAPH_REWRITING_AGENTS.md)
§0 (invariants), §3 (verification recipes). Design authority:
[IMPACT_MAP_GRAPH_REWRITING_AGENTS.md](IMPACT_MAP_GRAPH_REWRITING_AGENTS.md) §2, §3.7 ·
[PLAN_GRAPH_REWRITING_AGENTS.md](PLAN_GRAPH_REWRITING_AGENTS.md) §P1, §4.

**State**: READY · **Depends on**: nothing · **Blocks**: nothing (P2 is independent)

---

## 1. Why this phase exists

A homogeneous rule on a graph can only read its neighbours through an
**order-independent, degree-tolerant aggregate** — the multiset of neighbour states.
Today expressing that multiset means hand-wiring
`Get Bonded Agents → Get Agents Attribute → Count Matching` **once per state value**,
plus a tag constant each. For a 4-state model that is 9 nodes and 12 wires before the
rule even starts.

This phase collapses it to **one node with one labelled output port per state value**,
and ships the rule-table idiom on top. **It is the entire "less mathematical"
win, and it needs no engine change.**

---

## 2. Scope — what you build

### 2.1 `neighbourCensus` node — `src/modeler/vpl/nodes/NeighbourCensusNode.ts`

```
type:         'neighbourCensus'
label:        'Neighbour Census'
category:     'data'
requirements: { bondGraph: true }
config:       { attributeId: '', source: 'bonded' | 'nearby', /* nearby only: */ radius }
ports (static):  radius (integer, inlineWidget number, hidden unless source==='nearby')
ports (dynamic): one INTEGER OUTPUT per option of the chosen attribute,
                 labelled with the option NAME, id `count_<i>`
                 + `total` (integer) — the live neighbour count
compile:      '' — the lowering handles it (see 2.2)
```

- **Attribute scope**: `agentAttrsOf(model)` filtered to **tag** and **bool** types
  (bool ⇒ two ports, `False` / `True`). An integer/float attribute has no finite
  option set — exclude it (a future "binned census" is out of scope).
- **Dynamic ports**: build them with a shared exported helper consumed by **BOTH**
  `CaNode.tsx` and [effectivePorts.ts](../src/modeler/vpl/effectivePorts.ts) — the
  `buildExtraSlotPorts` precedent. If those two drift, drag-and-drop offers ports the
  canvas does not render.
- Register in `MULTI_OUTPUT_TYPES` (values resolve via `_v<id>_<portId>`).
- `hiddenPorts` hides `radius` unless `source === 'nearby'`.
- **Do NOT** add it to `AGENT_WASM_SUPPORTED_TYPES` / `AGENT_WEBGPU_SUPPORTED_TYPES` —
  after the lowering, no compiler ever sees a census node (see 2.3).

### 2.2 The lowering — `src/modeler/vpl/compiler/censusExpand.ts`

`expandNeighbourCensus(nodes, edges, model) → { nodes, edges }`, following the
established shared-pre-compile-transform pattern
([expandComposites.ts](../src/modeler/vpl/compiler/expandComposites.ts),
[multiAttrExpand.ts](../src/modeler/vpl/compiler/multiAttrExpand.ts),
[forceToAgentsExpand.ts](../src/modeler/vpl/compiler/forceToAgentsExpand.ts)).

Per census node, synthesize **once**:

```
source==='bonded' :  getBondedAgents        →  getAgentsAttribute(attributeId)  →  ids/values
source==='nearby' :  getNearbyAgents(radius) → getAgentsAttribute(attributeId)  →  ids/values
```

then, **only for output ports that are actually consumed**, per option `i`:

```
getConstant(constType='tag', tagAttributeId=attributeId, index=i)   ──┐
                                                                     ├→ groupCounting(operation='equals')
getAgentsAttribute.values ───────────────────────────────────────────┘        .count  →  the consumer
```

and for a consumed `total` port: `arrayLength(values)`.

Rules:
- **Deterministic synthetic ids** — `${censusId}__cn<i>` etc. WASM/WebGPU byte
  stability depends on it (the `multiAttrExpand` discipline).
- **Emit only consumed ports.** An unconsumed count must synthesize nothing, or a
  4-state census costs 4 loops when the rule reads one.
- **Share the gather.** ONE `getBondedAgents` + ONE `getAgentsAttribute` per census
  node, fanned out to every counter. (Do not rely on accessor-CSE — it is gated off
  in async agent mode.)
- **Hot-path no-op**: no census node ⇒ return the SAME arrays (`check-compile-identity`
  must show every shipped model unchanged).
- **Bool attributes**: `getConstant` with `constType 'bool'` (or the tag path if the
  bool has no tagOptions — verify which the codebase's `getConstant` expects and
  record it in the report).

### 2.3 Wire the lowering into ALL THREE agent front-ends

Call `expandNeighbourCensus` **immediately after `collapseReroutes` and before
`expandMultiAttrs`** in:

1. `compileAgentGraph` — [compile.ts](../src/modeler/vpl/compiler/compile.ts)
2. `flattenAgentGraph` — [agentWasm/compile.ts](../src/modeler/vpl/compiler/agentWasm/compile.ts)
3. `flattenAgentGraph` — [agentWebgpu/compile.ts](../src/modeler/vpl/compiler/agentWebgpu/compile.ts)

> **This is the load-bearing step.** `flattenAgentGraph` is shared by each target's
> **capability gate** *and* its emitter. Because the gate inspects the FLATTENED
> graph, it sees only `getBondedAgents` / `getAgentsAttribute` / `groupCounting` /
> `getConstant` / `arrayLength` — all already supported — so the census node runs on
> **JS, WASM and WebGPU with zero per-target emit**. Verify this by asserting the
> gates return `true` for a census model; if a gate returns `false`, the wiring is in
> the wrong place.

### 2.4 Supporting edits

| File | Change |
|---|---|
| `vpl/nodes/registry.ts` | register the node |
| `nodes/nodeValidation.ts` | `detectMissingConfig`: "Select an attribute" when `attributeId` is unset or no longer resolves to a tag/bool agent attribute |
| `model/agentCapabilities.ts` | `AGENT_NODE_REQUIREMENT`: `source==='bonded'` ⇒ requires `bonds !== 'off'`; `'nearby'` ⇒ requires sensing. If the table cannot express a config-dependent requirement, pick the weaker one and **say so in the report** |
| `model/ModelContext.tsx` | `REMOVE_AGENT_ATTRIBUTE` / tagOptions edits must clear or remap the census `attributeId` (reuse the existing `clearDeletedId` / indexMap cascades) |
| `vpl/CaNode.tsx` | config UI: attribute dropdown + source segmented control; collapsed label `Census · <attr>` |

### 2.5 The "GRA Rule Table" default macro — `public/macros/`

A `.gcamacro` wiring: **Neighbour Census → N-D Lookup Table (tag-valued) → Switch →
five verb stubs** (Divide Agent / Kill Agent / Form Bond / Break Bond / *Idle*), with
labelled reroutes so the shape is readable on drop. Ships in the Palette's Default
Macros. ⚠️ Vite indexes `public/macros/` at **startup** — restart the dev server or
`index.json` will not list it.

### 2.6 Sample — `scripts/gen-life-on-bonds.mjs` → `public/models/Life on Bonds.gcaproj`

Mirror the structure of `scripts/gen-gol-agents.mjs` (read it first — it is the
model this one must match):

- 32×32 torus lattice of agents, spawned by the **Agent Init Event**, positioned on
  integer cells.
- **Bonded to their 8 Moore neighbours at init** (this is the change vs. the shipped
  model, which finds neighbours by proximity). `maxBonds` ≥ 8.
- Rule: `alive' = (n == 3) || (alive && n == 2)`, where `n` = the census's `True`
  count over the bonded 1-ring.
- Agents pinned: Particle-style capability profile, `customForcesOnly`, momentum 0,
  no collision, no growth. **`agentUpdateMode: 'sync'`** (Conway is synchronous).
- Compile target per the library policy: WebGPU if the gate accepts, else WASM.
- ⚠️ **Bonding 8 neighbours per agent at init needs 8 Form Bond calls per agent — and
  Form Bond is ONE request per agent per step (Impact Map §3.3).** Options, in order
  of preference: (a) rely on **auto-bond by distance** (Properties → Agents) with a
  radius that captures exactly the Moore ring — cleanest, no requests at all;
  (b) spread the bonding over 8 init/warm-up generations; (c) if neither works,
  **STOP and report** — it means P4 (the queue) is a prerequisite for this sample and
  the orchestrator will resequence. Try (a) first.

### 2.7 The invariant harness — `scripts/verify-graph-rewrite.mjs`

Create it in this phase with `checkHandshake` (I1), `checkNoDangling` (I3),
`checkCapacity` (I4) over a `getState` agent payload, following the tier structure of
`scripts/verify-agent-render.mjs`. **Each checker needs a negative-control mutation
proving it fails when broken** — a harness that only ever passes proves nothing.
(`checkBondSymmetry` / `checkDegreeRegular` arrive in P2 / P5.)

---

## 3. Exit gate — all must pass, all recorded in the Completion Report

| # | Oracle | Criterion |
|---|---|---|
| **O7** | **Differential vs. the shipped model** | `Life on Bonds` and `Game of Life on Agents` produce **cell-for-cell identical** alive-state sequences over ≥ 200 generations from the same seed. Same neighbour set ⇒ identical dynamics; any divergence is a census bug. **This is the primary gate.** |
| **O11** | Conway patterns | block stable ≥ 50 gens; blinker period **exactly** 2; toad period 2; glider returns to its shape translated by (1,1) after **exactly** 4 generations |
| **O3** | Identity rule | a table mapping every input to `Idle` ⇒ N, E and every agent state bit-identical over 100 generations |
| **I1/I3/I4** | Invariants | hold every generation of the O7 run |
| — | Gate check | `isAgentGraphWasmSupported` **and** `isAgentGraphWebGPUSupported` return `true` for a census model (proves 2.3 is wired correctly) |
| — | Byte identity | `check-compile-identity` — every shipped model unchanged (the lowering is a no-op when unused) |
| — | Parity | `parity-agent-wasm` green with a **new permanent census synthetic** (a census over a 3-option tag, all three counts consumed, values stored to agent attributes so a mis-mapped port is caught) |
| — | Gate/ABI | `check-agent-wasm-gate`, `audit-agent-layout`, `test-agent-abi` green |
| — | Real UI | load `Life on Bonds` in the browser, step it through the real worker, observe the population evolving and the invariants holding. Record what you observed. |

**Verification note**: run O7 by loading both models and stepping each through
`window.__simWorker`, comparing the alive-attribute arrays from `getState`. The
agent id ordering must be made comparable — sort by (row, col) derived from position,
or seed both models so slot order matches. Say which you did.

---

## 4. Assumptions to check FIRST (stop if any is false)

1. **`groupCounting` accepts an agent-values array on all three targets.** CLAUDE.md
   says the whole agent catalogue runs on WASM and WebGPU; but
   `GetAgentsAttributeNode.ts`'s doc-comment still says *"JS-only"* — that comment is
   believed **stale**, contradicted by `AGENT_WASM_SUPPORTED_TYPES`. **Verify against
   the supported-type sets, not the comment**, and fix the comment if stale.
2. **`getConstant` with `constType: 'tag'` needs `tagAttributeId` to resolve against
   AGENT attributes** on the Agents graph — the graph-aware `tagAttrScope` work says
   it does. Verify, because the lowering synthesizes these nodes.
3. **The auto-bond radius can capture exactly the Moore 8-ring** on an integer
   lattice (diagonal √2 ≈ 1.414 in, next ring 2.0 out — a comfortable band). If
   auto-bond's hysteresis (`formDistance`/`breakDistance` × contact) cannot express
   it, fall back to 2.6(b).
4. **Nothing in the lowering needs a new scratch slot budget.** `getBondedAgents` and
   `getAgentsAttribute` are array producers with a per-node scratch slot on
   WASM/WebGPU; a census emits ONE of each, but a model with several census nodes
   multiplies them. **Check the `AGENT_NEARBY_SCRATCH_SLOTS`-style budget** and report
   the practical census-node limit per graph.

---

## 5. Out of scope

Bond attributes (P2), the request queue (P4), division partition (P5), graph
indicators (P6), the Cubic GRA / SDCA samples (P7). Do not touch the engine, the
store layout, or the ABI descriptor in this phase.

---

## Completion Report — P1

*(fill in per the master handoff §5 template)*

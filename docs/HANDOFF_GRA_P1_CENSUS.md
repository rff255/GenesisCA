# PHASE P1 — Neighbour State Census + the GRA Rule Table

**Read first**: [HANDOFF_GRAPH_REWRITING_AGENTS.md](HANDOFF_GRAPH_REWRITING_AGENTS.md)
§0 (invariants), §3 (verification recipes). Design authority:
[IMPACT_MAP_GRAPH_REWRITING_AGENTS.md](IMPACT_MAP_GRAPH_REWRITING_AGENTS.md) §2, §3.7 ·
[PLAN_GRAPH_REWRITING_AGENTS.md](PLAN_GRAPH_REWRITING_AGENTS.md) §P1, §4.

**State**: **DONE** (`2a8fb42` + `b519565`) · **Depends on**: nothing · **Blocks**: nothing
(P2 is independent). ⚠️ Two findings the orchestrator must read before P3 — see the
Completion Report at the bottom.

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

**State**: **DONE**

**Commit(s)**
- `2a8fb42` — `fix(agents): Count Matching and Group Assert read their declared operand ports`
  (a **pre-existing P1-BLOCKING defect** found while checking §4.1 — isolated in its own
  commit so the orchestrator can re-scope it if it disagrees with the call; see
  "Scope call" below)
- `b519565` — `feat(agents): Neighbour State Census — the multiset a graph rule reads`

**Files touched**

```
 CLAUDE.md                                        (+ the P1 section, + the Project Structure tree)
 README.md                                        (census bullet + the 11th sample)
 docs/NODES_REFERENCE.md                          (147 registry / 144 selectable / 48 agent + row 120)
 src/help/HelpView.tsx                            (the "Neighbour Census" Help section)
 src/model/agentCapabilities.ts                   (bondsOrSensing key + the node requirement)
 src/modeler/vpl/CaNode.tsx                       (dynamic ports + config UI + collapsed label)
 src/modeler/vpl/effectivePorts.ts                (dynamic ports — the shared builder)
 src/modeler/vpl/nodes/nodeValidation.ts          (detectMissingConfig case)
 src/modeler/vpl/nodes/registry.ts                (registration)
 src/modeler/vpl/nodes/NeighbourCensusNode.ts     NEW
 src/modeler/vpl/compiler/censusExpand.ts         NEW  (the lowering + the port builder)
 src/modeler/vpl/compiler/compile.ts              (wire the lowering — JS agent front-end)
 src/modeler/vpl/compiler/agentWasm/compile.ts    (wire the lowering + the operand-port fix)
 src/modeler/vpl/compiler/agentWebgpu/compile.ts  (wire the lowering + the operand-port fix)
 src/modeler/vpl/nodes/GetAgentsAttributeNode.ts  (stale "JS-only" comment)
 src/modeler/vpl/nodes/GetBondedAgentsNode.ts     (stale "JS-only" comment)
 scripts/verify-graph-rewrite.mjs                 NEW  (the milestone harness — 58 checks)
 scripts/gen-life-on-bonds.mjs                    NEW  → public/models/Life on Bonds.gcaproj
 scripts/gen-gra-rule-table-macro.mjs             NEW  → public/macros/GRA Rule Table.gcamacro
 scripts/parity-agent-wasm.mjs                    (2 permanent synthetics + their invariants)
 public/macros/index.json                         (regenerated)
```

**No engine, store, ABI-descriptor, `divideAgent` or request-buffer file was touched** — as
the phase requires.

### What shipped

1. **`neighbourCensus` node** — config `{ attributeId, source: 'bonded' | 'nearby' }`; static
   `radius` (hidden unless `nearby`) + `total`; **dynamic** integer output per state value of a
   tag/bool AGENT attribute, labelled with the option name. `compile()` returns `''`.
2. **`expandNeighbourCensus`** (`compiler/censusExpand.ts`) — the shared pre-compile lowering
   into `getBondedAgents|getNearbyAgents → getAgentsAttribute → getConstant + groupCounting`
   per **consumed** port, `+ arrayLength` for `total`. Wired into **all three** agent
   front-ends right after `collapseReroutes`, so both capability gates see only supported
   types ⇒ **JS + WASM + WebGPU with zero per-target emit**.
3. **`buildCensusPorts`** — the ONE dynamic-port builder consumed by both `CaNode.tsx` and
   `effectivePorts.ts` (the `buildExtraSlotPorts` dual-consumption discipline; the harness
   asserts they agree).
4. **Supporting wiring** — registry, `detectMissingConfig` (unset/non-enumerable attribute
   **and** the config-specific capability mismatch), `AGENT_NODE_REQUIREMENT`, CaNode config
   UI (attribute dropdown + source select) + collapsed label `Census · <attr>`.
5. **`Life on Bonds`** sample — Conway on a bonded 32×32 torus lattice, one census node.
6. **`GRA Rule Table`** default macro — census + own state → Table Lookup → Switch → labelled
   flow reroutes → Idle / Divide / Die / Bond / Unbond.
7. **`scripts/verify-graph-rewrite.mjs`** — the milestone's invariant + oracle harness
   (58 checks, three tiers, every invariant negative-controlled).

### Decisions resolved

| ID | Decision taken | Why |
|---|---|---|
| **D7** (census `source`) | **Ship both**; `bonded` is the default | As recommended. Both are verified end-to-end; `nearby` has its own exactness check (an independent Moore-ring recount) in the harness. |
| Capability requirement | New **disjunctive** key `bondsOrSensing` (satisfied by `bonds !== 'off'` **or** `sensing`), widening to `bonds: 'data'` | `AGENT_NODE_REQUIREMENT` is type-keyed and cannot see the per-node `source`. The handoff said "pick the weaker one and say so"; the codebase already has the disjunctive precedent `sensingOrCollision`, which is strictly more honest than picking one arbitrarily. The **config-specific** mismatch (a bonded census in a bonds-off model, or a nearby census with Sensing off) is badged precisely by `detectMissingConfig`. |
| `getConstant` encoding | tag → `{constType:'tag', tagAttributeId, constValue:String(i)}`; bool → `{constType:'bool', constValue:'true'|'false'}` | Verified against `GetConstantNode.compile`: the tag branch emits `parseInt(raw)||0` (so index 0 is correct) and the bool branch emits `1`/`0`, which is exactly how the agent SoA stores a bool. Both are exact small integers on all three targets. |
| `total` source | Reads the **gather's id array**, not the value array | Keeps `total` meaningful when no attribute is configured, and makes a Total-only census cost ONE array producer instead of two. Lengths are identical (both skip dead/oob ids). |
| Bonding the Moore ring | **Auto-bond** (handoff option (a)) | Assumption 3 held with room to spare — see below. No warm-up generations needed. |
| `Life on Bonds` compile target | **`wasm`**, deviating from the library's "WebGPU where the gate accepts" policy | Both gates accept it and the census is exact on WebGPU, but `agentUpdateMode: 'sync'` is not honoured there (finding below). This model is a differential ORACLE, so correctness outranks the perf policy. Nothing is clamped — the user can still select WebGPU. |

### Assumptions checked (§4)

| # | Assumption | Verdict |
|---|---|---|
| 1 | `groupCounting` accepts an agent-values array on all three targets | **TRUE** — `getBondedAgents`, `getAgentsAttribute`, `groupCounting`, `getConstant` and `arrayLength` are all in **both** `AGENT_WASM_SUPPORTED_TYPES` and `AGENT_WEBGPU_SUPPORTED_TYPES`. The `"JS-only"` doc comments on `GetAgentsAttributeNode` / `GetBondedAgentsNode` were indeed **stale** and are corrected. ⚠️ But a *related* assumption was FALSE — see "the one blocking defect" below. |
| 2 | `getConstant` tag resolves against AGENT attributes | **TRUE, and simpler than assumed** — `getConstant.compile` never resolves `tagAttributeId` at all; the tag branch just emits `parseInt(constValue)`. `tagAttributeId` is a UI-only affordance (it names the options in the picker), and the graph-aware `tagAttrScope` in CaNode already includes agent attributes. So the lowering's synthesized constants are correct by construction on every target. |
| 3 | Auto-bond can capture exactly the Moore 8-ring | **TRUE, comfortably** — radius 0.45 ⇒ contact 0.9; `formDistance 1.9` ⇒ threshold **1.71**, which admits 1.0 and √2 ≈ 1.414 and excludes 2.0. Verified in the **real worker**: after one structural phase every one of 1024 agents has **degree exactly 8**, **E = 4096**, and the partner set equals the expected torus Moore ring with **0 mismatches**. |
| 4 | No new scratch-slot budget is needed | **TRUE**, and the practical limit is now documented. **WASM**: `AGENT_NEARBY_SCRATCH_SLOTS = 4` counts only `getNearbyAgents`/`getAgentsInView`; `getBondedAgents` + `getAgentsAttribute` use the bump-pointer scratch and are **not** counted ⇒ a **bonded** census costs **0** of the budget (unlimited per graph), a **nearby** census costs 1 (≤ 4). **WebGPU**: `AGENT_WEBGPU_NEARBY_SLOTS = 6` counts **every** array producer and a census emits **2** ⇒ **≤ 3 census nodes per graph** (fewer with other producers); above that the model clamps to JS — a capacity gate, not a node ban. |

### Assumptions that proved FALSE

**One, and it was P1-blocking. It is FIXED, in its own commit.**

- **Both agent compilers read `groupCounting`'s comparison operand from ports that do not
  exist.** `GroupCountingNode` declares `values` / **`compare`** / **`compareHigh`** and the JS
  emitter reads those; `agentWasm/compile.ts::emitGroupCounting` and
  `agentWebgpu/compile.ts::emitGroupCounting` read **`value` / `value2`**. `groupStatement` had
  the same defect (`x` declared, `value` read). Since no port carries those ids, a **wired**
  operand silently fell back to **0** on WASM and WebGPU while JS read the real value — a
  cross-target divergence with no error. Proved by compiling a bonded count graph with a wired
  `getConstant(1)`: the WGSL emitted `if (_gcV10 == 0.0)`. **Latent** because no shipped model
  uses either node on the AGENT graph (the lattice compilers read the correct ports), which is
  why `check-compile-identity` is unaffected by the fix.
  - **Why this blocked P1**: the census lowering synthesizes exactly
    `getConstant → groupCounting.compare`, so every census would have counted "neighbours whose
    state == 0" for *every* port on two of three targets — while both gates returned `true`.
  - **Scope call (flagged for the orchestrator)**: I did **not** stop, because this is not a
    redesign or a workaround — it is a 4-line correction to use the ids the node defs declare,
    with an obvious right answer, in the very node P1 depends on, and the codebase has direct
    precedent (the N-D Lookup Table phase fixed the identical `'row'`/`'col'` vs `labelA`/`labelB`
    class in the same commit). It is isolated in commit `2a8fb42` so it can be reverted or
    re-scoped independently. **Guarded permanently** by a new parity synthetic that wires all
    three operands over a bonded 1-ring **and** carries a value invariant recounted from the
    store's own bond list — negative-controlled both ways (reverting the WASM fix →
    `PARITY✗ cEq js=1 wasm=0`; making both targets equally wrong → the invariant fires instead).

### FINDING — pre-existing, OUT OF SCOPE, needs an orchestrator decision

**`agentUpdateMode: 'sync'` is NOT honoured on the WebGPU agent target.** The behaviour shader
reads neighbours' attributes out of the **same `agentF32` region it writes its own into**, with
no double buffer, so a neighbour may be read pre- or post-write depending on scheduling. Any
**synchronous, neighbour-attribute-reading** agent rule — i.e. exactly the totalistic-CA / GRA
class this whole milestone is about — is therefore wrong there, **non-deterministically**.

Measured in the real worker against a hand-written Conway reference, from the identical
313-alive board:

| model | JS | WASM | WebGPU |
|---|---|---|---|
| `Game of Life on Agents` (**shipped**, census-free, proximity) | 0 wrong | 0 wrong | **18 of 1024 wrong**, every trial |
| `Life on Bonds` (census, bonded) | 0 wrong | 0 wrong | **14 or 18 wrong, varying run to run** |

**The census itself is exact on all three targets.** With `alive` frozen (the rule writes the
count into a separate attribute, so there is no read/write race), JS, WASM and WebGPU produce
**byte-identical per-agent counts** matching an independent recount from the bond store —
0 mismatches over 1024 agents, in the real worker. So this is upstream of P1 and equally
affects a census-free shipped model.

CLAUDE.md's older claim that on the GPU "the mode only affects CPU buffering + residency
eligibility; a parallel dispatch is snapshot-reads + thread-own-writes either way" holds only
for a rule that reads no neighbour **attribute**. The fix is a decision — **double-buffer the
GPU attr region for sync models** vs. **reject sync + neighbour-attribute-read on WebGPU** — and
belongs to the agent WebGPU runtime. **It directly affects P3** (bond attributes on WebGPU) and
any GRA sample intended to run on the GPU.

### Verification

| Gate | Result |
|---|---|
| `npx tsc -p tsconfig.app.json --noEmit` | ✓ clean |
| `npm run build` | ✓ clean (42 precache entries) |
| `node scripts/parity-agent-wasm.mjs` | ✓ **ALL AGENT SAMPLES: JS↔WASM BIT-PARITY** — 27 entries incl. `Life on Bonds.gcaproj` and **two new permanent synthetics** (`Group operand ports`, `Neighbour Census`), each with a bond-list recount invariant, each negative-controlled |
| `node scripts/check-agent-wasm-gate.mjs` | ✓ 11/11 `GATE✓ COMPILE✓ INST✓` (incl. `Life on Bonds`, 2813 bytes / 11 types) |
| `node scripts/audit-agent-layout.mjs` | ✓ 144 checks, all 4 CPU sites in lockstep |
| `node scripts/test-agent-abi.mjs` | ✓ 28 passed |
| `node scripts/check-compile-identity.mjs --compare …P0.json` | ✓ **25 models, all surfaces unchanged**; `Life on Bonds` correctly reported NEW (the lowering is a hot-path no-op) |
| `node scripts/verify-graph-rewrite.mjs` | ✓ **58 passed, 0 failed** (see below) |
| `node scripts/test-agent-capabilities.mjs` | ✓ 73 passed (was 67; the new `bondsOrSensing` key adds parametrized checks) |
| `node scripts/parity-agent-force.mjs` | ✓ 7 checks |
| `node scripts/verify-agent-render.mjs` | ✓ |
| **Real in-browser run** | see below |

**`verify-graph-rewrite.mjs` — which oracles**
- **Tier A** — I1 `checkHandshake`, I3 `checkNoDangling`, I4 `checkCapacity`, `checkDegreeRegular`,
  each **negative-controlled** (one-sided bond removal; partner→dead agent; self-bond;
  `bondCount > maxBonds`; wrong `d`). All five mutations are caught.
- **Tier B** — the lowering: option/port derivation for tag **and** bool, `effectivePorts` agrees
  with the builder, radius hidden/shown by source, no census node survives, exactly one gather +
  one value gather, one counter per consumed port, `total` → Array Length reading the id array,
  deterministic synthetic ids, unconsumed ports synthesize nothing, a Total-only census needs no
  value gather, stale (deleted-option) edges are dropped with no dangling source, **hot-path
  no-op returns the SAME arrays**, **both gates accept**, all three targets emit, WebGPU binds the
  bond store, and the **WGSL compares against the three real option indices** (`0.0,1.0,2.0`).
- **Tier C** — through the REAL compiled behaviour over a real agent store:
  **O7** `Life on Bonds` == the shipped `Game of Life on Agents` **cell-for-cell over 200
  generations** (bonds pre-formed by the harness, so no offset), board genuinely evolving,
  **JS↔WASM bit-identical** over the same run, **I1+I3+I4 hold at every generation**, plus a
  negative control proving a single-cell perturbation is detected.
  **O11** block stable ≥ 50 gens; blinker period **exactly 2**; toad period **exactly 2**; glider
  returns to its shape translated by **exactly (1,1)** after **exactly 4** generations.
  **O3** an all-Idle rule table (census → Lookup Table → Switch) leaves every agent state, N and
  E **bit-identical over 100 generations**, raises **no** structural request, and JS↔WASM agree —
  with a **negative control** proving a non-Idle table DOES mutate the same graph.
  Plus: the `nearby` source gates in on both targets and counts the Moore ring **exactly**
  against an independent recount, JS↔WASM bit-identical.

> **Harness lesson worth keeping.** The O3 negative control caught **three real harness bugs that
> had made O3 vacuous**: `lookupInteraction`'s config key is `tableId` (not `attributeId`), the
> Switch's flow input is `check` (not `do`), and the harness must populate `ctx.lookupTables`
> from the model or every table read returns 0. A test that only ever passes proves nothing.

**Real in-browser run** (dev server on :51741, real worker driven via `window.__simWorker`)
- `Life on Bonds` loads through the real FileMenu path; **0 console errors**, 0 worker error /
  overflow / stop messages across the whole session.
- **Topology**: gen 0 → 1024 agents, **0 bonds**; after ONE structural phase → **E = 4096,
  min degree = max degree = 8**, and the partner set matches the expected torus Moore ring with
  **0 mismatches over all 1024 agents**. I1/I3/I4 hold at gens 1, 2, 21, 41, 61, 81, 101, 121.
- **The bootstrap works as designed**: generation 1 leaves the board **bit-identical**
  (`Total > 0` gate), Conway starts at generation 2.
- **O7 in the real worker**: seeded both models identically (`setRngSeed` + Reset → identical
  initial boards, confirmed), then **150 generations**: `Life on Bonds`[t+1] == `Game of Life on
  Agents`[t] **cell-for-cell, no divergence**, with 60 distinct boards over the first 60
  generations (genuinely evolving, not a fixed point).
- **Census exactness per target** (the frozen-`alive` probe): JS / WASM / WebGPU all produce
  identical per-agent counts matching an independent bond-store recount, **0 mismatches**.
- **The macro** is listed in `/macros/index.json` as `GRA Rule Table` and the model in
  `/models/index.json` with its tags.
- **Visual**: the simulator renders the 32×32 agent lattice with the **bond mesh drawn** (you can
  see the graph), green live cells, the `ⓘ Instructions` pill, the `Agents (A→C) · Life` viewer
  tab from the linked agent mapping, and Show/Simulate rows for both Agents and Bonds.

### Invariants

| ID | Held? | Evidence |
|---|---|---|
| **I1** handshake | **YES** | `checkHandshake` green at every generation of the 200-gen O7 run (headless) and at 8 checkpoints of the 120-gen browser run (Σdeg 8192 == 2·4096). Negative control (one-sided removal) caught. |
| **I2** symmetry | *n/a in P1* | No bond attributes yet (P2); the harness's `checkBondSymmetry` slot is reserved. Bond *partner* symmetry is implied by I1 holding together with I3. |
| **I3** no dangling | **YES** | `checkNoDangling` green throughout both runs. Three negative controls (dead partner, self-bond, out-of-range) all caught. |
| **I4** capacity | **YES** | `checkCapacity` green throughout; `bondCount` is exactly 8 with `maxBonds` 8. Negative control caught. |
| **I5** atomicity | *n/a in P1* | No structural requests are raised by this phase (O3 asserts exactly that). Arrives with P4. |
| *(degree regularity)* | **YES** | `checkDegreeRegular(g, 8)` green — min == max == 8 and E == 8·1024/2 == 4096, in both the headless and the browser runs. |

### Known gaps / follow-ups for the next phase

1. **The WebGPU sync race (above) is the headline item.** It needs a decision before any GRA
   sample can ship on the GPU, and it is a prerequisite for P3 being meaningful.
2. **`Life on Bonds` ships on `wasm`.** Flip it back to `webgpu` once the sync path
   double-buffers — the gate already accepts it and the census is already exact there.
3. **The one-generation topology bootstrap** is a property of auto-bond running in the structural
   phase (i.e. at the END of a step). If P4's request queue makes 8 Form Bonds in one step
   possible, `Life on Bonds` could bond from the Agent Init Event instead and drop the
   `Total > 0` gate — worth revisiting, though the gate is independently defensible.
4. **WebGPU census budget**: ≤ 3 census nodes per graph (2 array producers each against
   `AGENT_WEBGPU_NEARBY_SLOTS = 6`). If a GRA sample needs more, either raise the cap or teach the
   lowering to share one gather across sibling census nodes on the same source (currently each
   census node emits its own).
5. **`checkBondSymmetry` (I2) and `checkDegreeRegular` as an I6 oracle** are stubbed/partial in
   `verify-graph-rewrite.mjs` — P2 and P5 fill them in. The Tier-A structure and the
   `decodeAgentGraph` normalisation are ready for both (`decodeAgentGraph` already accepts a raw
   `getState` payload, so a browser probe reuses the same checkers).
6. **A binned census** over an integer/float attribute is deliberately out of scope; the node
   excludes those types today.

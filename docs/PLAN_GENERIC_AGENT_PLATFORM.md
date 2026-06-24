# PLAN — Generic Agent Platform: agent attributes, agent variables, the full node catalogue + graph-authored spawning in the Agents graph

> ## STATUS: PLAN ONLY — not yet implemented. Branch `agents_floating_cells` (or a fresh branch off it).
> Build-ready runbook in the style of [HANDOFF_AGENTS_FLOATING_CELLS.md](HANDOFF_AGENTS_FLOATING_CELLS.md) /
> [HANDOFF_3D_GRID_CA.md](HANDOFF_3D_GRID_CA.md): phased PRs (files+symbols, acceptance test, risk), explicit design
> decisions, the full node catalogue, the two acceptance-target sample models, open questions, doc updates, verification.
> Illustrated mockup: **[PLAN_GENERIC_AGENT_PLATFORM.html](PLAN_GENERIC_AGENT_PLATFORM.html)**.
>
> **This revision SUPERSEDES the earlier `scope: cell|agent|both` discriminator design.** Per the user's direction:
> "shared" attributes make no sense (there is no 1:1 cell↔agent relationship). Agents own a **separate** attribute set;
> cell attributes gain an **agent-access permission**. Agents sit *above* the CA — they read/write cell attributes (the
> environment/field) under that permission, but CA cells can never read agent attributes. The node catalogue goes
> **comprehensive** (no deferrals) so the Agents graph can replicate a totalistic CA on a displaced grid of agents
> *and* author stigmergy models (ant necrophoresis). Two genuinely-new engine pieces: graph-authored **agent spawning**
> and a once-only **Agent Init Event**.
>
> A subsystem-mapping + design pass + an adversarial review produced this; the review's **5 blockers** + per-PR
> amendments are folded in (§0.4). Several **open questions** in §5 want a one-line confirmation before coding.

---

## §0 — Mission, scope, verification

### 0.1 Mission

Today the agent engine **reuses cell state** (Decision D-IDX): the agent loop variable is `idx`, agents store the *same*
attribute set as cells (`buildAgentAttrSpecs()` = `cellAttrs.map(...)` at [sim.worker.ts:468](../src/simulator/engine/sim.worker.ts);
`buildAgentLoopParams` emits `r_<id>`/`w_<id>`/`_field_<id>` all over the *one* `model.attributes.filter(!isModelAttribute)`
list at [compile.ts:2072-2103](../src/modeler/vpl/compiler/compile.ts)), they share `model.variables`, and the Attributes
panel only relabels its header on the Agents sub-tab.

**Make agents first-class authorable entities** — author per-agent behaviour exactly as you author cell rules:

1. **Agent attributes** = their own set (`agentAttributes[]`), accessed only by agents (own-state + other-agent-by-id).
2. **Cell attributes** gain an **agent-access permission** (`none` / `read` / `read&write`) controlling whether agents may
   *consult* (read) or *deposit-into/consume* (write) them through the field bridge. CA cells can never touch agent state.
3. **Agent local variables** = their own set (`agentVariables[]`), separate from cell variables.
4. **Comprehensive node coverage**: every universal node + first-class agent equivalents of the lattice neighbour ops, for
   **nearby AND bonded** agent sets (sources / filter / join / gather / pick / aggregate / set-many) — enough to
   replicate a totalistic CA on a grid of agents *and* the ant-necrophoresis stigmergy model.
5. **Graph-authored spawning**: a two-phase **Create Agent → set attributes/position/radius/type → Add Agent To World**,
   plus a once-only **Agent Init Event** root in which the user loops and spawns the initial population.

**Invariants that bound the milestone:**
- **Lattice 2D + 3D byte-identity on all three targets (JS/WASM/WebGPU).** A model with no agent graph compiles to
  byte-identical `stepCode` / WASM bytes / WGSL — `cellAttrsOf(model)` returns the identical list to today's
  `filter(!isModelAttribute)`, and the cell compilers never read `agentAttributes`.
- **The four shipped agent models keep running with zero behaviour change** (Boids — Flocking, Morphogenesis —
  Differential Tissue, Chemotaxis — Aggregation, Agent WASM Drift Test).
- **Agents stay JS-primary.** Every new node is excluded from `isAgentGraphWasmSupported`, so a graph using one clamps
  the *whole* agent graph to JS via `agentTargetOf` (all-or-nothing — never silently wrong, only deferred-perf). WebGPU
  agents stay deferred. **The just-shipped JS↔WASM agent bit-parity (PR6b-1/2) must not regress.**

### 0.2 In scope
The agent attribute set + the cell agent-access permission; the agent variable set; the comprehensive agent node
catalogue (8 array/movement nodes + the universal-node compile fixes); graph-authored spawning + the Agent Init Event
(6 nodes); the load-time migrations; the macro availability gate; two acceptance-target samples; the documentation sweep.

### 0.3 Explicitly OUT OF SCOPE
- **agent-WASM emit for any new node** — they clamp to JS this milestone (a later PR ports them).
- **WebGPU agents** (deferred). **3D agents** (Phase E) — including a Force-Z arm.
- **`.gcastate` FILE-format agent persistence** (in-session `getState`/`loadState` round-trips agents; the base64 file
  format is still pending) — the new samples must NOT embed an agent `simulationState`.
- **Richer agent representation** beyond per-agent colour (glyphs/shapes/sprites so species are visually distinct) — a
  future visual milestone, noted by the user; this plan keeps the existing `colorIdx = idx*4` per-agent colour.

### 0.4 Reconcile — adversarial-review corrections (these AMEND the design; where they conflict, this section wins)

**Five blockers (resolved here, reflected in the decisions + PRs):**

- **B1/B2 — spawn buffers must NOT enter the baked WASM memory layout.** `computeAgentMemoryLayout`
  ([agentEngine.ts:181](../src/simulator/engine/agentEngine.ts)) accumulates offsets through the FIXED const arrays
  `AGENT_F64_FIELDS` / `AGENT_I32_FIELDS` / `AGENT_U8_FIELDS` / `AGENT_BOND_*`. Inserting spawn/staged buffers there
  shifts every region after the insertion point (bond store, freeList, colors, attr regions, AND the AW-RNG/AW-HASH
  control region the PR6b-2 WASM module reads at baked offsets) → breaks JS↔WASM bit-parity. **Resolution:** spawn is
  JS-clamped (the spawn nodes exclude the graph from WASM), so a spawning model runs on the **non-wasm-backed** store
  (plain typed arrays). The spawn/staged-request buffers are therefore **ordinary `AgentStore` fields allocated in
  `createAgentStore`'s non-wasm branch only** — NOT entries in `computeAgentMemoryLayout`'s field arrays. (If ever a WASM
  layout slot is needed, it must be appended strictly AFTER `nearbyScratchOffset`, the current last region, with a
  `compileAll` byte-identity proof — but this milestone needs none.)
- **B3/B4 — the Agent Init Event is a once-per-reset ZERO-AGENT setup function, not a per-agent clone of
  `divisionEvent`.** `divisionEvent` is run *per daughter* with a leading `idx` and a `myX = _agentX[idx]` preamble; an
  Init Event that "loops and spawns N agents" has **no implicit `idx`** and emits **no `idx`-indexed preamble**. Its
  body operates on the **explicit ids `Create Agent` returns**. Its value-outs are `worldWidth`/`worldHeight`
  (`= _fieldW`/`_fieldH`) `[+worldDepth]` + `seedIndexBase`. It needs its OWN `buildAgentInitParams ↔ buildAgentInitArgs`
  ABI pair (fully specified in D-AGENT-INIT, NOT a mechanical `divisionEvent` clone). `runAgentInit` fires on **Reset
  only, not on recompile** (else a live param edit re-spawns the init population on top of the existing one).
- **B5 — a graph-spawned agent is unbondable in the SAME step.** `runAgentStructuralPhase` applies in fixed order: bond
  form/break → death → division → (NEW) spawn-apply → auto-bond → sweep. The bond-request pass already ran before the
  new agent exists, and the deferred `Create Agent` handle is a *staged index*, not a live id. **Resolution:** document
  the limitation prominently (a `Form Bond` to a just-created child no-ops this step; bond it next generation), rather
  than reordering (which would require staged-index→live-id resolution).

**Factual / per-PR amendments folded in:**
- The **Chemotaxis migration rationale** is corrected: `chemical` IS read via `getCellAttribute`/`getNeighborsAttribute`
  — but on the **CELL graph**, not the agent graph. The migration scans only `agentGraphNodes`, so the conclusion
  (`chemical` stays a cell attr with `agentAccess: 'readWrite'`) is right; the **rule** is: *a cell attribute migrates to
  `agentAttributes` only when referenced as agent-state by the AGENT graph; cell-graph usage is irrelevant to the move.*
- The **DUPLICATE migration case** = a cell attr referenced by the AGENT graph BOTH as agent-state (`getCellAttribute`)
  AND as a field (`secreteToField`/etc.). None of the four shipped models hit it → PR1 needs a **synthetic fixture**.
- The worker splits into **two ordered lists** — `agentSpecs` (drives `r_`/`w_`) and `fieldSpecs` (drives `_field_`,
  pruned by `agentAccess`) — both derived from the shared `attributeScope.ts` helpers (the count guard can't catch
  ORDER drift between two same-typed lists).
- **GoL-on-agents requires `customForcesOnly: true` + `momentum: 0` + no Apply Force/Set Velocity** (else the engine
  soft-sphere relaxes a packed grid apart and the totalistic count is wrong); `getNearbyAgents` radius in `(1.5, 2)` for
  unit spacing to capture exactly the 8 Moore neighbours.
- **`agentUsesField`** (the WebGPU field-readback switch) must be **node-presence-only** (conservative), never gated on
  access-resolution — or the readback desyncs from what the compiler emitted.
- **`Set Velocity`** is a no-op under `momentum === 0` (overdamped — the integrator overwrites it) → document it
  requires `momentum > 0`; add a hint.
- **`Get Bonded Agents`** must replicate `forEachBond`'s **two-part guard** (`alive[partner]` AND
  `bondPartnerEpoch === epoch[partner]` — the dangling-bond ABI) and loop to `bondCount[idx]`, not `maxBonds`.
- **`Join Agents`** filters the AGENT empty sentinel `-1` (NOT `INVALID_NI`) — verify the `JoinNeighbors` clone, don't
  assume verbatim.
- **The async-CSE gate** must cover the retargeted own-state `getCellAttribute` (now an agent-SoA read), not just
  `getAgentAttribute`.
- **`getAgentRadius`** is `NEVER_PURE` (radius is mutated intra-step by `divideAgent`/`setAgentRadius`).
- The **arity-guard verification needs a synthetic SPAWNING fixture** — the four shipped models have no `agentInit`, so
  they don't exercise the new `buildAgentInitParams↔Args` pair.
- **`macroDefAvailableInGraph`** scans nested internals for ANY `requirements.bondGraph` node OR any `LATTICE_ONLY_TYPES`
  member (not a hardcoded list — the agent node set is now ~20+).

### 0.5 How to verify (four surfaces, every PR)
- **(a)** `npx tsc -b` (or `tsc -p tsconfig.app.json --noEmit`) before every commit.
- **(b)** the dev compile harness ([compileHarness.ts](../src/dev/compileHarness.ts), cache-busted import) — lattice 2D+3D
  byte-identity (GoL/Life3D/snake/Gray-Scott/Amphiphile/Chromatography string-equal before/after) + agent-loop shape.
- **(c)** **MANDATORY real-worker arity guard** via `window.__simWorker` on every PR touching an agent param list: assert
  `agentBehaviourFn.length === buildAgentLoopArgs(s).length`, `agentDivisionFn.length === buildDivisionArgs(...).length`,
  and (PR4+) `agentInitFn.length === buildAgentInitArgs(s).length` — on a **synthetic spawning fixture** for the last.
  The harness has no arg builder; only the worker proves ABI lockstep.
- **(d)** `preview_eval` for UI (short evals; `window.__*` DEV hooks for canvas/React-Flow drags).

### 0.6 Branch discipline
Feature branch off `master`/`agents_floating_cells`. Never push / never add `Co-Authored-By`. Each PR small, `tsc`-clean,
individually verifiable. Non-trivial UI/behaviour PRs ship an illustrated HTML mockup (this plan ships
[PLAN_GENERIC_AGENT_PLATFORM.html](PLAN_GENERIC_AGENT_PLATFORM.html); PR1/PR3/PR4 each ship a `MOCKUP_*` file).

---

## §1 — Design decisions

### D-AGENT-ATTRS — agents own a parallel `agentAttributes[]` set
Add **`CAModel.agentAttributes?: Attribute[]`** — a second id-space reusing the `Attribute` type verbatim (always
`isModelAttribute: false`; globals are read via the existing `getModelAttribute` against the shared `modelAttrs` arg).
Cell attributes stay in `model.attributes`. New **`src/model/attributeScope.ts`** is the single source of truth:
```ts
agentAttrsOf(m)          = (m.agentAttributes ?? [])
cellAttrsOf(m)           = m.attributes.filter(a => !a.isModelAttribute)        // byte-identical to today
cellFieldAttrsOf(m)      = cellAttrsOf(m).filter(a => a.agentAccess && a.agentAccess !== 'none')
cellFieldWriteAttrsOf(m) = cellAttrsOf(m).filter(a => a.agentAccess === 'readWrite')
```
The agent SoA (`buildAgentAttrSpecs`, `createAgentStore`, `computeAgentMemoryLayout` baked offsets, the agent-WASM spec)
is keyed by **`agentAttrsOf`**. In the behaviour/division/init loops the **own-agent channel `r_<id>`/`w_<id>`** iterates
`agentAttrsOf`; the **field channel `_field_<id>`** iterates `cellFieldAttrsOf`. These are **disjoint id-spaces**, so the
prefixes name physically distinct buffers — the collision the abandoned discriminator feared is structurally impossible.
Both the param builder AND the worker arg builder import these helpers so they cannot drift in ORDER.

### D-CELL-AGENT-ACCESS — the cell-attribute agent permission
Add an additive **`Attribute.agentAccess?: 'none' | 'read' | 'readWrite'`** on CELL attributes (absent ⇒ `'none'` for
new/non-agent models; the migration sets explicit values for agent models). It gates ONLY the field bridge: `'read'` ⇒
field READ nodes (`sampleField`/`fieldGradient`/`readCellsUnder`) may target it; `'readWrite'` ⇒ ALSO field WRITE nodes
(`affectCellsUnder`/`secreteToField`). `_field_<id>` is threaded ONLY for `cellFieldAttrsOf` (write ⊆ read, so a writable
attr always has a `_field_` slot). A defensive compile guard errors clearly if a field node targets a non-permitted attr.
CA cells can NEVER read agent attributes — that's **structural** (the cell compilers never iterate `agentAttributes`),
not a flag. **`agentUsesField` (the WebGPU readback switch) is recomputed from field-node-PRESENCE only** (conservative),
never from access resolution.

### D-VAR-SCOPE — agents own a parallel `agentVariables[]` set
Add **`CAModel.agentVariables?: Variable[]`** (reuse `Variable`, no scope field). `buildVariableJS(variables)` gains a
list param; the cell step passes `model.variables`, the agent behaviour/division/init pass `model.agentVariables`. The
variable reducer actions gain `target: 'cell' | 'agent'` (default `'cell'`). `variableScopeMigration` MOVES any
`model.variables` referenced by `agentGraphNodes` (or reachable macro internals) into `agentVariables` (DUPLICATE via a
fresh id if also cell-referenced). Disjoint id-spaces keep the `_var_<id>` naming byte-unchanged; this also FIXES the
agent-WASM array-var false-positive (the gate reads `agentVariables`). Needed for the gather→per-agent-accumulator path.

### D-COMPREHENSIVE-NODES — the full agent node catalogue (8 new array/movement nodes, JS-only)
Sources for **nearby** (`getNearbyAgents`, exists) AND **bonded** (`getBondedAgents`, NEW) agent-id arrays, plus
filter/join/gather/pick/set-many over agent-id arrays. New array nodes are **clones of their lattice analogues with the
NI codec REMOVED** — integer agent ids, **`-1` empty sentinel (NOT `INVALID_NI`)**, reading the agent SoA at `[id]`
instead of resolving an NI to a cell index. They ride the proven `_v<id>_result`/`_count`/`_vals`/`_work` scratch +
`MULTI_OUTPUT_TYPES` + `isArrayProducer` + `sourceYieldsArray` + `buildScratchDecl` registration path (the documented
"8-site" array-producer discipline — enumerate every site per node in PR3). All `requirements: { bondGraph: true }`,
excluded from `isAgentGraphWasmSupported` (clamp-to-JS). Purity: gathers + picks are `NEVER_PURE`; all are
`NEVER_INVARIANT`.

The list: **Get Bonded Agents** (data sibling of ForEachBond; the two-part epoch+alive guard; loop to `bondCount`),
**Filter Agents** (clone FilterNeighbors), **Join Agents** (clone JoinNeighbors; `-1` sentinel), **Pick Random Agent**
(clone PickRandomNeighbor; `-1` sentinel), **Pick N Random Agents** (clone PickNRandomNeighbors), **Get Agents
Attribute** (the keystone gather, clone GetNeighborsAttrByIndexes → `r_<attr>[id]` → typed[]), **Set Agents Attribute**
(write-many, clone SetNeighborAttributeByIndex's loop). Plus **Set Velocity** (write `_agentVX/VY[idx]` directly — the
momentum companion to Apply Force; integration-safe; **no-op under `momentum===0`** — document + hint). **Movement
verdict:** Apply Force + Set Velocity cover all movement; **NO "Move Agent" teleport** (it bypasses `xNext/yNext` and the
force pass overwrites it same-step). Aggregate/GroupCounting/GroupReduce already compose over any array source → totalistic
counts + density reductions fall out for free.

### D-SPAWN — graph-authored two-phase spawning
NEW nodes **Create Agent** + **Add Agent To World**, context-switched on `ctx.agentRoot`:
- **Inside the Agent Init Event** (sequential single-context): Create Agent allocs IMMEDIATELY — pop a free-list/grow
  slot, run `initAgentSlot`, then **force `alive[id]=0; liveCount--`** (deviating from `allocAgentSlot`'s default
  `alive=1`/`liveCount++` — the slot is *staged*, not live), and return the **real id** so same-pass Set-by-id nodes
  target it. Add Agent To World sets `alive[id]=1; liveCount++`. At the END of `runAgentInit`, a **leak sweep** frees any
  still-`alive===0` staged slot — via a dedicated free path (`freeAgentSlot` early-returns on dead slots, so it can't be
  reused as-is).
- **Inside Behaviour Step** (parallel-ish; `highWater` captured once): Create Agent CANNOT alloc inline (it would be
  iterated this step). It stages a **per-agent spawn request** (a JS-store-only buffer per B1/B2; one staged spawn per
  agent per step — the `bondFormReq` precedent); Add Agent To World sets the commit flag. A **new structural-phase
  spawn-apply loop** (AFTER division, before auto-bond) `allocAgentSlot → initAgentSlot → apply staged values`, collects
  newIds, and **REJECTS cleanly on `-1`** (the existing `agentOverflow` toast — never a half-spawn, the `divideAgent`
  capacity-precheck template). The new agent first behaves NEXT generation, and is **unbondable this step** (B5).

The **Set-by-id setters** (`setAgentPosition` writing BOTH `_agentX/Y[/Z]` AND `_agentXNext/YNext`, `setAgentRadius`
writing BOTH `_agentRadius` AND `_agentTargetRadius`, `setAgentType` writing `_agentType` + re-stamping the palette colour)
guard `< _agentMaxAgents` (NOT `< highWater && _alive`) so a staged-not-committed agent is targetable. `setAgentAttribute`
gets a staged-id emit variant (drops the `_alive` guard) in the init/spawn context. **Open question Q2** pins whether
behaviour-step Create supports per-attr staging or is geometry/type-only in v1.

### D-AGENT-INIT — the once-only Agent Init Event root
NEW **`agentInit`** singleton entry-point. Unlike the cell Init Event (looped over `total`), it compiles to a SINGLE
once-per-reset **setup function** — **no implicit `idx`, no `myX`-indexed preamble** (B3/B4). The user wires a Loop /
For Each In Array inside the DO chain and emits Create Agent per iteration. Value-outs: `worldWidth`/`worldHeight`
(`= _fieldW`/`_fieldH`) `[+worldDepth in 3D]` + `seedIndexBase` (`= highWater` before init = where the config-seed block
ended). `compileAgentGraph` returns `initCode` (currently hardcoded `''` at [compile.ts:2219](../src/modeler/vpl/compiler/compile.ts)).
A **NEW `buildAgentInitParams ↔ buildAgentInitArgs` ABI pair** — fully specified, NOT a `divisionEvent` clone: the param
list leads with the writable geometry buffers + the control boxes (`_highWaterBox`/`_liveCountBox`/`_agentSeedBase`/
`_agentOverflow`/`_agentMaxAgents` + the `_agentStage`/`_agentInitSlot`/`_agentColor` host closures) + the field block
+ the `r_`/`w_` agent attrs (the trailing 3D block gated identically on both sides). The worker de-no-ops `runAgentInit`
([sim.worker.ts:633](../src/simulator/engine/sim.worker.ts), already called on reset; **gate OFF on recompile** per
B4-fix) to run `agentInitFn` ONCE. Composition with the config seed is ADDITIVE: `initAgents()` lays the `seedCount`
baseline FIRST, then the Init Event runs and may spawn MORE (a pure-graph-init model sets `seedCount = 0`). The Init Event
does NOT re-fire per config-seeded or per-division agent (those use `initAgentSlot` defaults / `divisionEvent`). Add an
`agentInitFn` arity check to the DEV guard ([sim.worker.ts:2831-2842](../src/simulator/engine/sim.worker.ts)).

### D-AGENT-COMPILE-FIXES — universal-node completeness (KEPT; now init-aware)
`compileAgentGraph` runs NONE of the cell pre-resolve passes today, so several universal nodes silently break in agents.
All four fixes apply to the behaviour, division, AND new init roots:
- **FIX 1** — thread `_lookupTables` into `buildAgentLoopParams`/`buildDivisionParams`/`buildAgentInitParams` at a
  **pinned slot (after `glyphColors`, before the `_field_` block)**, ABI-mirrored in the arg builders, gated
  `hasLookupTables`, + the per-table `_rowCount`/`_colCount` pre-resolve over `agentGraphNodes`, in ONE commit. (Else
  `lookupInteraction`/`interactionTableMap` reference an undeclared param.)
- **FIX 2** — run `preResolveIndicators` (`_indicatorIdx` + `_tagLen`) over `agentGraphNodes`. (Else `_indicators[-1]`.)
- **FIX 3** — replicate `collectViewerRefs` → `_isV_<safeId>` viewer-hoist into the behaviour + division + init
  preambles. (Else a real `setCellLooks` `mappingId` ReferenceErrors → worker dies. Live crash today.)
- **FIX 4** — run `preResolveStopEvents` over `agentGraphNodes` + collect agent `stopMessages`. (Else `_stopFlag[0] =
  <undefined>` → NaN, no message.)

### D-ASYNC-CSE — gate accessor-CSE off in async agent mode (KEPT)
`compileAgentGraph` CSEs unconditionally today ([compile.ts:2128](../src/modeler/vpl/compiler/compile.ts) — comment
"agents are sync, so CSE is sound"). But `agentUpdateMode` **defaults to `'async'`** (single-buffered agent attrs). Gate
`canonicalizeAccessorEdges` to `agentUpdateMode === 'sync'`. The gate must cover the **retargeted own-state
`getCellAttribute`** (now an agent-SoA read mutated by a `setAgentsAttribute` to a neighbour), not only `getAgentAttribute`.

### D-MACRO-AVAIL — a macro availability predicate (KEPT)
A NEW **`macroDefAvailableInGraph(macroDefId, kind, model)`** (NOT `countMacroSubgraphIssues`, which is a badge counter
with no graph-kind param) — recurses the macroDef + nested macros and returns false if any internal node carries
`requirements.bondGraph` (agent-only, hide on Cells) or is in `LATTICE_ONLY_TYPES` (hide on Agents). Wired into the
Palette project-macro listing + the macro-instance add path.

### D-ABI-MIRROR — the #1 hazard, now spanning THREE param/arg pairs (KEPT, extended)
Every `buildAgentLoopParams` edit lands in the IDENTICAL slot in `buildAgentLoopArgs`; `buildDivisionParams ↔
buildDivisionArgs`; and the new `buildAgentInitParams ↔ buildAgentInitArgs` — each pair in **one commit**, both sides
importing the shared `attributeScope.ts` ordered helpers. The agent SoA layout (`buildAgentAttrSpecs` /
`createAgentStore` / `computeAgentMemoryLayout` baked offsets / the agent-WASM spec) all derive from ONE ordered list
(`agentAttrsOf`). The runtime arity-desync guard catches COUNT drift but **NOT an ORDER swap of two same-typed lists**
(now `agentSpecs` AND `fieldSpecs` both drive the signature) — the shared helper + the single-commit discipline + the
mandatory real-worker arity run are the backstop.

---

## §2 — The agent node catalogue (every node → status)

**New (`new`)** — 14 nodes, all `requirements.bondGraph`, JS-only:
| node | type | role |
|---|---|---|
| Get Bonded Agents | `getBondedAgents` | the agent's bonded partners → id[] (epoch+alive guard, loop to `bondCount`) |
| Filter Agents | `filterAgents` | filter an agent-id[] by an attribute predicate → result[] + count |
| Join Agents | `joinAgents` | union / intersection of two agent-id sets (`-1` sentinel) |
| Pick Random Agent | `pickRandomAgent` | pick one id from an id[] via shared `_rs` (`-1` empty) |
| Pick N Random Agents | `pickNRandomAgents` | partial Fisher-Yates → up to N distinct ids |
| Get Agents Attribute | `getAgentsAttribute` | **keystone gather**: one attribute over an id[] → typed[] |
| Set Agents Attribute | `setAgentsAttribute` | write-many: set an attribute on every agent in an id[] |
| Set Velocity | `setVelocity` | write `_agentVX/VY[idx]` (momentum companion; needs `momentum>0`) |
| Agent Init Event | `agentInit` | once-per-reset setup root (loop + spawn the initial population) |
| Create Agent | `createAgent` | alloc a staged agent → handle/id (immediate in init / deferred in behaviour) |
| Add Agent To World | `addAgentToWorld` | commit a staged agent (alive) |
| Set Agent Position | `setAgentPosition` | by-id write `_agentX/Y[/Z]` + `_agentXNext/YNext` (guard `< maxAgents`) |
| Set Agent Radius | `setAgentRadius` | by-id write `_agentRadius` + `_agentTargetRadius` |
| Set Agent Type | `setAgentType` | by-id write `_agentType` + re-stamp palette colour |

**Retargeted (`retargeted`)** — emit unchanged; on the Agents tab the dropdown + validation resolve against
`agentAttrsOf`: `getCellAttribute` / `setAttribute` / `updateAttribute` (the agent's **own** state, D-IDX `r_/w_<id>[idx]`),
`getAgentAttribute` / `setAgentAttribute` (other agent **by id**; the latter gets the staged-id guard variant).

**Fixed (`fix`)** — the 5 field nodes get a filtered dropdown + validation (read → `cellFieldAttrsOf`, write →
`cellFieldWriteAttrsOf`) + the defensive compile guard; emit unchanged: `sampleField`, `fieldGradient`, `readCellsUnder`
(read), `affectCellsUnder`, `secreteToField` (write). Plus the four D-AGENT-COMPILE-FIXES (lookup tables / indicators /
viewer-hoist / stop events) which currently break in agents.

**Exists, unchanged (`exists`)** — `behaviourStep`, `divisionEvent`, `getNearbyAgents`, `forEachBond`, `applyForce`,
`getSelfPosition`/`getAgentOffset`/`getVelocity`/`getRadius`/`getBondDegree`/`getCurvature`/`neighbourDensity` (geometry
reads; `getAgentRadius` reclassified **`NEVER_PURE`**), `setTargetRadius`/`formBond`/`breakBond`/`divideAgent`/`killAgent`
(actions), and every universal node (`aggregate`/`groupCounting`/`groupOperator`/`forEachInArray`/`arrayElement`/
`arrayLength`/`getConstant`/`arithmeticOperator`/`statement`/`logicOperator`/`conditional`/`switch`/`sequence`/`loop`/
`expression`/`getRandom`/`setCellLooks`/`categoricalColor`/`colorScale`/`getModelAttribute`/…) — available in both graphs.

**No agent meaning (`lattice-only`, hidden on the Agents tab)** — `step`/`initEvent`/`inputColor`/`outputMapping`
(cell roots), the neighbour + NI-codec family, the neighbourhood writes, `getCellPosition` (= Get Self Position),
`markCellUpdated`, `moveSelfToNeighbor`, the variegated/facing family.

---

## §3 — The phased PR plan

```
PR1 — Agent attribute model: agentAttributes[] + cell agentAccess permission + migration + attributeScope helper   (HIGH)
PR2 — Agent variables: agentVariables[] + variableScopeMigration                                                    (MEDIUM)
PR3 — Universal-node FIXES 1-4 + the 8 new array/movement nodes + async-CSE gate + macro-avail gate                 (MEDIUM)
PR4 — Graph-authored spawn (Create/Add + setters) + the Agent Init Event                                            (HIGH)
PR5 — Samples (GoL-on-agents + ant necrophoresis) + docs sweep                                                      (LOW-MED)
Deferred — agent-WASM emit for the new nodes; WebGPU agents; 3D agents
```
PR2 + PR3-FIX1-4 are lower-risk and may proceed early; **PR1 and PR4 must not start until B1-B5 + the §0.4 amendments are
folded in** (they are, in this plan).

### PR1 — Agent attribute model + cell agent-access permission  (HIGH)
**Goal.** `agentAttributes[]` + `Attribute.agentAccess`, all consumption through `attributeScope.ts`, the migration of the
4 shipped models, lattice byte-identity preserved.

**Files.** `types.ts` (CAModel.agentAttributes; Attribute.agentAccess; JSDoc the inert-for-agents fields) ·
`attributeScope.ts` (NEW) · `agentAttributeSplitMigration.ts` (NEW) · `ModelContext.tsx` (ADD_AGENT_ATTRIBUTE reducer +
callback + both useMemo dep arrays; LOAD_MODEL wiring after the 5 node-migrators + macroImport; UPDATE_ATTRIBUTE
agentAccess cascade) · `compile.ts` (buildAgentLoopParams/buildDivisionParams `r_/w_ ← agentAttrsOf`, `_field_ ←
cellFieldAttrsOf`; cell sites ← cellAttrsOf) · `sim.worker.ts` (`buildAgentAttrSpecs ← agentAttrsOf`; split into
`agentSpecs` + `fieldSpecs`; `buildAgentLoopArgs`/`buildDivisionArgs` mirror, one commit; init/recompile payload carries
agentAttributes + each cell attr's agentAccess) · `agentEngine.ts` (`createAgentStore`/`computeAgentMemoryLayout` caller
passes agent-derived specs; serialize already id-keyed) · `agentWasm/compile.ts` (spec ← agentAttrsOf — the baked-offset
lockstep, same atomic edit) · `AttributesPanelContent.tsx` (Agents tab lists agentAttrsOf with its own +Add + an agent
detail editor hiding cell-only field groups; Cells tab adds the Agent Access segmented control) · `CaNode.tsx` +
`nodeValidation.ts` (retarget the own/other-agent attribute dropdowns to agentAttrsOf via `getActiveGraphKind()`; the new
`hasAgentAttr` predicate; field-node filtered dropdowns + reject non-permitted) · `SimulatorView.tsx`
(`attrsStructurallyEqual`/`needsFullInit` on agentAttributes-set OR agentAccess change; `agentUsesField` node-presence-only;
re-run `isAgentGraphWasmSupported`) · `stringifyCompact` (add `agentAttributes` to the one-line allowlist) · NEW
`docs/MOCKUP_AGENT_ATTRS.html`.

**Migration (`agentAttributeSplitMigration`).** Idempotent (keyed off `agentAttributes` empty + agent nodes present).
STEP 1: build a reference index over `agentGraphNodes` + reachable macro internals, classifying each referenced cell attr
as **agent-state** (`getCellAttribute`/`setAttribute`/`updateAttribute` in the agent graph), **field-read**
(`sampleField`/`fieldGradient`/`readCellsUnder`), and/or **field-write** (`affectCellsUnder`/`secreteToField`). STEP 2 per
cell attr: state-only ⇒ **MOVE** to `agentAttributes`; field-only ⇒ **STAY** + set `agentAccess` (read or readWrite);
**BOTH state AND field** ⇒ **DUPLICATE** (clone with a fresh id into `agentAttributes`, rewrite ONLY the state-referencing
agent-graph nodes' `attributeId` incl. macro internals; field nodes keep the cell id) + set `agentAccess`. **Cell-graph
usage is irrelevant to the move** (Chemotaxis's `chemical` is cell-graph-read AND agent-field-written → STAYS a cell attr
with `readWrite`).

**Acceptance.** (1) No-agent-graph model → byte-identical step/WASM/WGSL on all 3 targets (harness, 2D + 3D). (2)
Post-migration: Tissue → `agentAttributes=[maturity]`, 0 field attrs; Chemotaxis → `agentAttributes=[]`,
`attributes=[chemical(readWrite)]`; Boids/Drift → both empty; re-run = no change (idempotent). (3) Real-worker arity guard
passes on Tissue + Chemotaxis. (4) All 4 shipped models seed+step+colour identically. (5) Harness assertion: every
agent-graph own-state attributeId resolves in `agentAttributes`; every field-node attributeId resolves to a cell attr with
`agentAccess !== 'none'`; every CELL-graph attributeId still resolves in `model.attributes` (chemical not moved). (6) A
**synthetic DUPLICATE fixture** (one attr used as agent-state AND a field) migrates correctly (macro-internal rewrite).

**Risk.** HIGH — D-ABI-MIRROR ORDER drift (two same-typed lists drive the signature) + the DUPLICATE-case rewrite
(miss a state node incl. a macro internal → undeclared `r_<A>` ReferenceError kills the worker).

### PR2 — Agent variables  (MEDIUM)
**Goal.** `agentVariables[]` (D-VAR-SCOPE) — the gather→per-agent-accumulator path PR3/PR5 need.
**Files.** `types.ts` (CAModel.agentVariables) · `variableScopeMigration.ts` (NEW) · `ModelContext.tsx` (ADD_VARIABLE
`target`; cascades scan agentVariables) · `compile.ts` (`buildVariableJS(list)`; agent sites pass `model.agentVariables`,
cell step `model.variables`) · `VariablesPanelSection` (source by `getActiveGraphKind()`) · `agentWasm/compile.ts` (the
array-var gate reads `agentVariables` — the false-positive fix) · `modelElementDrag.ts`.
**Acceptance.** Agent-scope array var → agent behaviour hoists it to function scope + per-agent reset; cell step
byte-identical; migration idempotent + moves a synthetic agent-referenced var; arity guard still passes (var blocks aren't
positional params).
**Risk.** MEDIUM — same MOVE/DUPLICATE logic as PR1; the `buildVariableJS` list-param threading + the agentWasm gate. No
ABI-mirror risk (body decls, not params).

### PR3 — Universal-node fixes + the comprehensive node family  (MEDIUM)
**Goal.** FIXES 1-4 (D-AGENT-COMPILE-FIXES) + the 8 new array/movement nodes + D-ASYNC-CSE + D-MACRO-AVAIL. JS-only.
**Files.** `compile.ts` (the 4 fixes; the new array producers' scratch + `varName()` registration — **add
`getAgentsAttribute` to the `_vals` OR-list at [compile.ts:758], `pickNRandomAgents` to the `_work`+`_result` block**;
`filterAgents`/`joinAgents` → `MULTI_OUTPUT_TYPES`; the new gathers → `isArrayProducer`/`sourceYieldsArray`; the
async-CSE gate) · the 8 NEW node files (clones, NI-codec removed, `-1` sentinel) · `registry.ts` · `nodeValidation.ts`
(detectMissingConfig cases; `macroDefAvailableInGraph`) · `accessorCSE.ts` (`NEVER_PURE += getAgentsAttribute,
getBondedAgents, pickRandomAgent, pickNRandomAgents`; confirm `getAgentRadius`) · `loopInvariant.ts` (`NEVER_INVARIANT +=`
all 8) · `agentWasm/compile.ts` (exclude all 8 from the supported set; surface the clamp reason in the radio hint) ·
`PalettePanelContent.tsx` (an "Agent Neighbours" group) · NEW `docs/MOCKUP_AGENT_NODES.html`.
**Acceptance.** A real `setCellLooks{mappingId}` in an agent graph compiles + colours (FIX3 — crashes today); a lookup
table / indicators / stop event in an agent graph work (FIX1/2/4); `Get Nearby Agents → Get Agents Attribute → Group
Counting(==1)` yields the exact per-agent count; the 8 nodes appear only on the Agents tab and clamp `agentTarget='js'`;
async-CSE gate OFF in async mode; every new node in `NEVER_INVARIANT`, every gather/pick in `NEVER_PURE`; the macro gate
hides a lattice-internal macro on Agents; lattice byte-identity holds.
**Risk.** MEDIUM — `NEVER_PURE`/`NEVER_INVARIANT` completeness (a miss hoists a mutable gather above the loop); the
agentWasm exclusion completeness; FIX1 is an ABI-mirror edit (pinned slot).

### PR4 — Graph-authored spawn + the Agent Init Event  (HIGH)
**Goal.** D-SPAWN + D-AGENT-INIT. JS-only.
**Files.** the 6 NEW node files (`AgentInitNode`/`CreateAgentNode`/`AddAgentToWorldNode`/`SetAgentPositionNode`/
`SetAgentRadiusNode`/`SetAgentTypeNode`) · `registry.ts` · `compile.ts` (`ctx.agentRoot`; emit `initCode`; the NEW
`buildAgentInitParams↔buildAgentInitArgs` pair — fully specified per D-AGENT-INIT; context-switched Create/Add emit;
the by-id setters guarded `< _agentMaxAgents`; the staged-id `setAgentAttribute` variant) · `agentEngine.ts` (the
**JS-store-only** spawn/staged-request buffers — NOT in `computeAgentMemoryLayout`, per B1/B2; the staged-alloc + the
leak-sweep free path) · `sim.worker.ts` (de-no-op `runAgentInit`, **reset-only, not recompile**; the structural-phase
spawn-apply loop AFTER division with clean overflow REJECT; the staged-slot leak sweep at end-of-init; extend the DEV
arity guard with `agentInitFn`) · `nodeValidation.ts` (Agent Init Event singleton; Create/Add require a flow-reachable
agentInit OR behaviourStep ancestor) · `PalettePanelContent.tsx` · NEW `docs/MOCKUP_AGENT_SPAWN.html`.
**Acceptance.** `seedCount=0` + an Agent Init Event running `Loop(N) → Create → Set Position/Type → Add` seeds exactly N
agents with the staged geometry/type on Reset (getAgentState round-trip); the **arity guard passes for `agentInitFn`** on
this synthetic spawning fixture; a behaviour-step Create+Add spawns an agent that first appears next generation; overflow
at apply REJECTS cleanly (toast, `liveCount` never exceeds `maxAgents`, no half-spawn); a Create-without-Add leaves no
leaked slot after a second Reset; `runAgentInit` does NOT re-spawn on a live recompile; the 4 shipped models still seed
identically (no agentInit ⇒ `initCode` stays `''`).
**Risk.** HIGH — the THIRD positional ABI pair (superset = most drift); the staged-not-alive leak guard +
`freeAgentSlot`'s dead-slot early-return; the staged-id guard relaxation; the clean overflow reject (the half-division
bug class); B5 (same-step unbondable — documented).

### PR5 — Samples + docs  (LOW-MEDIUM)
**Goal.** The two acceptance-target samples + the atomic doc sweep.
**Files.** `scripts/gen-gol-agents.mjs` + `scripts/gen-ant-necrophoresis.mjs` (NEW) · `public/models/GameOfLifeOnAgents.gcaproj`
+ `public/models/AntNecrophoresis.gcaproj` (NEW) · `CLAUDE.md` · `src/help/HelpView.tsx` · `README.md` ·
`docs/NODES_REFERENCE.md` · `docs/HANDOFF_AGENTS_FLOATING_CELLS.md`. Both generators preserve any later-added thumbnail on
re-run (gen-amphiphile precedent) and embed NO agent `simulationState` (the `.gcastate` agent file format stays deferred).
**Acceptance.** GameOfLifeOnAgents (with **`customForcesOnly:true`, `momentum:0`, no Apply Force, `getNearbyAgents`
radius ∈ (1.5,2)**) reproduces a blinker / still-life; AntNecrophoresis concentrates a uniform corpse field into piles
(a corpse-field spatial histogram goes flat → clustered); both load from the library + run JS-target with 0 console
errors; lattice 2D+3D byte-identity holds (final sweep); `tsc -b` + build clean; CLAUDE.md / Help / README /
NODES_REFERENCE agree.
**Risk.** LOW-MEDIUM — final end-to-end integration test; the stigmergy intra-step deposit order-dependence is benign for
autocatalytic drop but must be documented.

---

## §4 — The two acceptance-target sample models

### 4.1 Game of Life on a grid of agents (the genericity proof)
A static near-lattice of agents, **`customForcesOnly: true`, `momentum: 0`, no Apply Force / Set Velocity** (so the
integrator leaves positions fixed — the engine soft-sphere would otherwise relax a packed grid apart). A bool
`agentAttribute` `alive`. Behaviour Step → **Get Nearby Agents** (radius ∈ (1.5, 2) → exactly the 8 Moore neighbours) →
**Get Agents Attribute**(`alive`) → **Group Counting**(`== 1` alive) → the GoL rule (Compare 3 / Compare 2 + own) → **Set
Attribute**(`alive`) → **Set Cell Looks** (current viewer). Proves the gather + aggregate + own-state path end-to-end.

### 4.2 Ant necrophoresis (stigmergy) — the worked node graph
Ants = agents with a `carrying` bool `agentAttribute`; corpses = a `corpse` **cell-attribute field** with
`agentAccess: 'readWrite'` (the stigmergy substrate). Pick-up/drop probability is **sigmoidal in the local corpse
density** (autocatalytic — dense piles attract drops, so they self-enhance).

**Agent graph — Agent Init Event (once per Reset):**
- `Loop(numAnts)` → **Create Agent** (x/y = Get Random · world bounds, type = ant, radius = 1) → handle `h` → **Set Agent
  Attribute**(`h`, `carrying`, false) → **Add Agent To World**(`h`).
- `Loop.next` → `Loop(numCorpses)` → **Secrete To Field**(`corpse`, rate 1) at a Get-Random position (seed a roughly
  uniform corpse field).

**Agent graph — Behaviour Step (per ant, per generation):**
1. **Random walk** — Apply Force(fx = (Get Random − 0.5)·wander, fy = …) [momentum 0 ⇒ overdamped step].
2. **Sense** — Read Cells Under(`corpse` [read], op = mean, radius R) → `localDensity`.
3. **Stigmergy decision** —
   - `Conditional(carrying == false)` → THEN (maybe PICK UP): `pPick = Expression(1 / (1 + exp(k·(localDensity − d0))))`
     [dense → low pick-up, cluster-preserving] → `Conditional(Get Random < pPick AND localDensity > 0)` → Affect Cells
     Under(`corpse`, subtract 1) + Set Attribute(`carrying` = true).
   - ELSE (maybe DROP): `pDrop = Expression(1 / (1 + exp(−k·(localDensity − d1))))` [dense → high drop, autocatalytic] →
     `Conditional(Get Random < pDrop)` → Affect Cells Under(`corpse`, add 1) + Set Attribute(`carrying` = false).
4. **Appearance** — Set Cell Looks (current viewer): Categorical Color(`carrying`) → ant body (carrying = red, empty = grey).

**Cell graph (the substrate):** Generation Step → (optional slow diffusion/decay of `corpse`) → Output Mapping: Color
Scale over `corpse` (the pile heatmap). **Acceptance:** from a uniform field + scattered ants, the autocatalytic drop
concentrates corpses into a few piles over time (a corpse-field spatial-frequency histogram goes flat → clustered).

---

## §5 — Open questions (one-line confirmations before coding)

- **Q1 — Agent Init Event scope.** Fire ONLY for graph-spawned (Create Agent) agents (config-seeded get `initAgentSlot`
  defaults; daughters get `divisionEvent`)? **Rec: yes** — once-only-graph-authored; a pure-graph-init model sets
  `seedCount = 0`. (Looping the seeded ids / sequencing init-then-division for daughters is out of scope.)
- **Q2 — behaviour-step Create richness.** Is behaviour-step Create geometry/type-only at stage (no per-attr Set-by-id on
  the deferred handle) in v1, or does it ship a full staged-attr block + a special Set-by-id-on-a-handle emit mode?
  **Rec: geometry/type-only deferred** + full-attr immediate-in-init (the init path has no ambiguity).
- **Q3 — multiple spawns per agent per step.** One staged spawn per agent per step (the `bondFormReq` precedent), or a
  fixed-capacity per-agent spawn array (the `divideAxis` precedent)? **Rec: one-per-step v1** (note the limitation).
- **Q4 — GoL-on-agents positions.** Pinned-to-lattice (the clean correctness proof) or drifting (a stronger but fuzzier
  genericity proof)? **Rec: pinned** (`customForcesOnly` + `momentum 0`), with a note that drift works too.
- **Q5 — first-field-node UX.** When a field node first targets a cell attr defaulting to `agentAccess: 'none'`, auto-grant
  `readWrite` on wire (smooth) or require an explicit set + show the badge (explicit permission)? **Rec: auto-grant on
  first wire** + a visible Agent-access control to revoke, so the field bridge isn't a cliff on first use.
- **Q6 — PR ordering.** Ship PR1 (attributes) and PR2 (variables) separately (isolate the ABI risk)? **Rec: yes** — and
  PR2 + PR3-FIX1-4 may land before PR1/PR4.

---

## §6 — Documentation + verification

**Doc sweep (PR5, atomic):** `CLAUDE.md` (replace the D-IDX "cell attrs DOUBLE as agent attrs" paragraph with the
parallel-array model; add D-CELL-AGENT-ACCESS / D-SPAWN / D-AGENT-INIT / D-COMPREHENSIVE-NODES; restate the KEPT
decisions; the THREE positional ABI pairs note; the Project Structure tree — `attributeScope.ts`, the two migrations, the
14 new node files), `src/help/HelpView.tsx`, `README.md`, `docs/NODES_REFERENCE.md` (the 14 new node rows + count +
Mermaid; the retargeted dropdowns + the field-node agentAccess gate), `docs/HANDOFF_AGENTS_FLOATING_CELLS.md` (append the
milestone section). Required illustrated mockups: `MOCKUP_AGENT_ATTRS.html`, `MOCKUP_AGENT_NODES.html`,
`MOCKUP_AGENT_SPAWN.html`.

**Verification (every PR):** `tsc -b` clean; the harness lattice 2D+3D byte-identity sweep (all 3 targets); the
**mandatory real-worker arity guard** on every PR touching an agent param list (behaviour + division always; `agentInit`
on a synthetic spawning fixture from PR4); migration idempotency + the field/state classification assertions; the four
shipped agent models' behaviour parity; the per-FIX correctness checks; the new-node correctness + clamp-to-JS checks;
the spawn/init runtime checks (exact-N seed, deferred next-gen, clean overflow, no leaked slot, no recompile re-spawn);
the two-sample acceptance.

---

## §7 — Reference: load-bearing facts (verified by direct read)
- `buildAgentLoopParams` threads `r_<id>`/`w_<id>`/`_field_<id>` over the ONE `filter(!isModelAttribute)` list; NO
  `_lookupTables` — [compile.ts:2072-2103](../src/modeler/vpl/compiler/compile.ts).
- `buildAgentAttrSpecs()` = `cellAttrs.map(...)` — [sim.worker.ts:468](../src/simulator/engine/sim.worker.ts).
- `compileAgentGraph` returns `initCode: ''` hardcoded; runs `canonicalizeAccessorEdges` unconditionally; runs NONE of
  the cell pre-resolve passes — [compile.ts:2112-2219](../src/modeler/vpl/compiler/compile.ts).
- `computeAgentMemoryLayout` accumulates offsets through FIXED `AGENT_*_FIELDS` const arrays (the B1/B2 byte-shift
  hazard) — [agentEngine.ts:152-181](../src/simulator/engine/agentEngine.ts); `divideAgent`/the divide-request +
  structural-phase apply are the spawn precedent — [agentEngine.ts:1047](../src/simulator/engine/agentEngine.ts),
  [sim.worker.ts:1139-1247](../src/simulator/engine/sim.worker.ts).
- `runAgentInit`/`runDivisionEvent` dispatch + the DEV arity guard already exist —
  [sim.worker.ts:633,648,2831-2842](../src/simulator/engine/sim.worker.ts).
- `CenterBasedConfig.agentUpdateMode` defaults `'async'`; `agentTarget` defaults `'js'`; `agentTargetOf` clamps —
  [types.ts:658-672](../src/model/types.ts), [centerBased.ts](../src/model/centerBased.ts).
- Gating: `LATTICE_ONLY_TYPES` + `requirements.bondGraph` + universal-by-absence; `isNodeAvailable` reads
  `getActiveGraphKind()` — [nodeValidation.ts:497-536](../src/modeler/vpl/nodes/nodeValidation.ts).

# Graph-Rewriting Automata (GRA)

> Area doc for **GenesisCA**. Neighbour census, bond attributes, the structural request queue, rewire/transfer/form-between verbs, division partitions, graph indicators and the flagship samples. Read before touching bond topology or the request queue.
>
> **Also read** — a change here usually reaches [`agent-engine.md`](agent-engine.md) · [`agent-nodes.md`](agent-nodes.md) · [`agent-compilers.md`](agent-compilers.md) · [`indicators.md`](indicators.md) · [`model-library.md`](model-library.md).
> Keep following those onward until a pass turns up nothing new; the reading is not done at the first
> doc that answers your question. See *Read to CLOSURE, not to the first hit* in `../../CLAUDE.md`.
>
> Sections below were moved **verbatim** out of `CLAUDE.md` (2026-09-06) so the always-loaded
> file could stay small. Nothing was rewritten or deleted. See `../../CLAUDE.md` for the
> project-wide rules and the routing table, and `docs/HANDOFF_*.md` for the full build narratives.
>
> **Paths here are repo-root-relative** (e.g. `src/model/types.ts`), exactly as they were in `CLAUDE.md`.
> Read them from the repository root; they will not resolve as links from this directory.

**Contents**

- Graph-Rewriting Automata (GRA) — the agent tier's rewriting layer (branch `GRA`, COMPLETE)

---

## Graph-Rewriting Automata (GRA) — the agent tier's rewriting layer (branch `GRA`, COMPLETE)

**What it is.** Automata whose GRAPH is rewritten by local rules. GenesisCA authors them
with **`census → table → verb`** — a neighbour-state multiset indexes a lookup TABLE, the
table returns a verb, the verb is one of Divide / Die / Bond / Unbond / Rewire / Form
Between. **No user ever meets a pushout or a gluing morphism.** The reduction that makes
this work is *node-locality*: general graph rewriting needs subgraph isomorphism (NP-hard),
but a NODE-LOCAL rule's match is always "a node and its 1-ring", which is a lookup.

**Design authority**: [docs/IMPACT_MAP_GRAPH_REWRITING_AGENTS.md](docs/IMPACT_MAP_GRAPH_REWRITING_AGENTS.md)
+ [PLAN_GRAPH_REWRITING_AGENTS.md](docs/PLAN_GRAPH_REWRITING_AGENTS.md) (+ `.html` mockup).
**Execution runbook + per-phase reports**: [docs/HANDOFF_GRAPH_REWRITING_AGENTS.md](docs/HANDOFF_GRAPH_REWRITING_AGENTS.md).
The milestone ran as eight sessions (P1, P2, PX, P3, P4, P4b, P5, P6, P7); the subsections
below are organised by CAPABILITY, not by phase.

**Why the agent tier and not the lattice.** [INVESTIGATION_GRAPH_CA.md](docs/INVESTIGATION_GRAPH_CA.md)
studied a cell-grid graph mode and concluded CSR adjacency is the *worst* structure for a
MUTATING graph. The bond store is already a mutable ragged adjacency with per-node capacity
and epoch-stamped recycling — exactly what SDCA/GRA need — and the force engine gives a
live **force-directed embedding for free**, which most GRA tooling has to bolt on.

**The four gaps the Impact Map found, and where each closed:**

| # | Gap | Closed by |
|---|---|---|
| G1 | ONE structural request slot per agent per step ⇒ a degree-preserving rewrite could not be atomic | the bounded per-agent **request QUEUE** + the atomic **Rewire Bond** verb, completed by the **paired Form Bond** (the third-party encoding) |
| G2 | division partitioned bonds GEOMETRICALLY (`sign(dot(offset, axis))`) | the declarative **division bond partition** (tension / alternate / byBondAttribute) + the `daughterBond` policy |
| G3 | no **bond attributes** — no edge state, no typed rules, no SDCA link variable | `CAModel.bondAttributes` end-to-end on all three agent targets |
| G4 | no neighbour-state **census** as a first-class value | the `neighbourCensus` node, LOWERED to existing nodes ⇒ zero per-target emit |

**The invariants are the contract** (Impact Map §5), machine-checked by
[scripts/verify-graph-rewrite.mjs](scripts/verify-graph-rewrite.mjs) — **517 checks (Tier K retired), twelve
tiers (A…M), every invariant negative-controlled**: I1 handshake (`Σdeg == 2|E|`), I2 bond
symmetry (every per-slot field agrees in BOTH rows), I3 no dangling, I4 capacity, I5
atomicity (a rejected op leaves the graph EXACTLY as before), I6 degree preservation, I7
conservation across division. Tiers L and M load the SHIPPED sample `.gcaproj` files and run
them through their own compiled behaviour, so a later edit to a generator that quietly
breaks a rule fails the harness.

### G4 closed — the Neighbour State Census (the authoring win)

**Zero engine change** — the authoring win: `census → table → verb` instead of a
category-theoretic gluing morphism.

#### Why a census is the ONLY legal read
A homogeneous rule on a graph cannot NAME its neighbours — there is no lattice ordering and the degree varies — so it may read only an **order-independent, degree-tolerant aggregate**: the multiset of neighbour states ("2 red, 1 blue, 0 green"). Expressing that by hand meant `Get Bonded Agents → Get Agents Attribute → Count Matching` plus a tag constant **once per state value** (9 nodes / 12 wires for a 4-state model, before the rule starts).

#### The node — `neighbourCensus` ([NeighbourCensusNode.ts](src/modeler/vpl/nodes/NeighbourCensusNode.ts))
`requirements: { bondGraph: true }`, config `{ attributeId, source: 'bonded' | 'nearby' }`. **Static** ports: `radius` (inline number, hidden unless `source === 'nearby'` via `hiddenPorts`) + `total` (the live neighbour count). **Dynamic** ports: one labelled INTEGER output per state value of the chosen **tag/bool AGENT attribute** (`count_<i>`; a bool gives False/True). `compile()` returns `''` — no compiler ever sees the node.
- The dynamic ports are built by the shared **`buildCensusPorts`** consumed by BOTH [CaNode.tsx](src/modeler/vpl/CaNode.tsx) AND [effectivePorts.ts](src/modeler/vpl/effectivePorts.ts) (the `buildExtraSlotPorts` dual-consumption discipline — if those drift, drag-and-drop offers ports the canvas never renders). They render BEFORE the static `Total`.
- **NOT** in `MULTI_OUTPUT_TYPES` and **NOT** in `AGENT_*_SUPPORTED_TYPES` — after the lowering there is no census node left for either to see.
- Attribute scope = `agentAttrsOf(model)` filtered to tag/bool. Integer/float have no finite option set (a "binned census" is a separate feature).

#### The lowering — [censusExpand.ts](src/modeler/vpl/compiler/censusExpand.ts) (the load-bearing design)
`expandNeighbourCensus(nodes, edges, model)` rewrites each census node into the hand-wired chain BEFORE any target compiles — the sanctioned "lower to primitives" pattern (`expandMacros` / `collapseReroutes` / `expandMultiAttrs` / `lowerVectorAttrs` / `expandComposites` / `expandForceToAgents`):
```
getBondedAgents | getNearbyAgents(radius)  →  getAgentsAttribute(attr)  ─┬→ getConstant(option i) → groupCounting(equals).count → count_<i>
                     └────────────────────────────────────────────────────→ arrayLength.length                                → total
```
Wired into **all three** agent front-ends immediately after `collapseReroutes` — `compileAgentGraph` ([compile.ts](src/modeler/vpl/compiler/compile.ts)), and BOTH `flattenAgentGraph`s ([agentWasm](src/modeler/vpl/compiler/agentWasm/compile.ts) / [agentWebgpu](src/modeler/vpl/compiler/agentWebgpu/compile.ts)). **That placement is the whole trick**: `flattenAgentGraph` is shared by each target's capability GATE *and* its emitter, so the gate inspects the FLATTENED graph and sees only already-supported node types ⇒ the census runs on **JS, WASM and WebGPU with ZERO per-target emit**, and bit-parity is inherited from the primitives. Rules the implementation keeps:
- **Deterministic synthetic ids** (`${censusId}__cnG/__cnV/__cnK<i>/__cnC<i>/__cnLen`) so WASM bytes / WGSL text stay byte-stable across recompiles.
- **Only CONSUMED ports synthesize anything** — an unconsumed count costs nothing (a 4-state census must not run 4 loops when the rule reads one).
- **ONE shared gather + ONE shared value gather**, fanned out to every counter. Do NOT rely on accessor-CSE — it is gated OFF in async agent mode.
- **`total` reads the ID array directly** (not the value array), so it stays meaningful with no attribute configured and a Total-only census costs ONE array producer, not two.
- **Stale edges are DROPPED, never repointed** (a `count_<i>` beyond the live option set after a tagOptions deletion) — the `multiAttrExpand` `STALE_SLOT_HANDLE` discipline.
- **Hot-path no-op**: no census node ⇒ the SAME arrays are returned (every shipped model byte-identical; `check-compile-identity` proves it).

#### Supporting wiring
`registry.ts`; `AGENT_NODE_REQUIREMENT: neighbourCensus → 'bondsOrSensing'` — a NEW **disjunctive** capability key (the `sensingOrCollision` precedent) because the table is type-keyed and cannot see the per-node `source`; the config-specific mismatch (a bonded census in a bonds-off model) is badged by `detectMissingConfig` instead, which also badges an unset / no-longer-enumerable attribute. The `REMOVE_AGENT_ATTRIBUTE` cascade needs **no new code** — the census stores only `config.attributeId`, which `clearDeletedId` already clears; a tagOptions edit needs no remap either (the ports and the synthesized constants are both derived from the LIVE attribute).

#### **Array-producer budget (the practical census limit per graph)**
- **WASM**: `AGENT_NEARBY_SCRATCH_SLOTS = 4` counts ONLY `getNearbyAgents` / `getAgentsInView`. `getBondedAgents` + `getAgentsAttribute` use the bump-pointer scratch and are NOT counted ⇒ a **bonded** census costs **0** of the budget (unlimited); a **nearby** census costs 1 (so ≤ 4).
- **WebGPU**: `AGENT_WEBGPU_NEARBY_SLOTS = 6` counts EVERY array producer, and a census emits 2 (gather + value gather) ⇒ **≤ 3 census nodes per graph** (fewer if the graph has other producers). Above that the model clamps to JS — a capacity gate, not a node ban.

#### The sample — `Life on Bonds` ([scripts/gen-life-on-bonds.mjs](scripts/gen-life-on-bonds.mjs))
Conway's Life as a GRAPH rule: a 32×32 torus lattice of agents **bonded to their 8 Moore neighbours**, one census node over the bool `alive`, rule `n == 3 || (alive && n == 2)`.
- **The topology is built by AUTO-BOND, not Form Bond** (P1-era reason: Form Bond was then one request per agent per step, so 8 neighbours would have taken 8 generations. **P4's request QUEUE removed that limit** — a Form Bond in a loop can now build the whole ring in one step — but the model keeps auto-bond, which needs no graph at all). With radius 0.45 the contact distance is 0.9, so `formDistance 1.9` admits everything under **1.71** — the orthogonals (1.0) and diagonals (√2 ≈ 1.414) — and excludes the next ring (2.0); `breakDistance 2.5` never fires because nothing moves. **Verified in the real worker: degree exactly 8 on all 1024 agents, E = 4096, and the partner set matches the expected Moore ring with 0 mismatches.** Auto-bond rides the Bonds=**Physics** capability, so the springs are on — `bondStiffness: 0` makes their force exactly zero, which is what keeps the lattice rigid.
- **The one bootstrap subtlety**: the structural phase (where auto-bond runs) executes at the END of a step, so generation 1's behaviour still sees an EMPTY 1-ring. The rule is therefore gated on the census's **`Total > 0`** — an isolated node keeps its state, which is both the standard graph-automaton convention and what makes generation 1 a pure topology bootstrap. **So `Life on Bonds`[t+1] == `Game of Life on Agents`[t]** (verified, 150 generations, cell-for-cell, real worker). In sync agent mode "don't write" preserves the value (the write buffer is primed from the read buffer), so the gate needs no else-branch.
- **Ships on `agentTarget: 'webgpu'`** per the library policy. P1 originally shipped it on `wasm` because the GPU did not double-buffer sync agent attributes (the finding below); **PX fixed that**, and this model is what proves it — its O7 differential passes cell-for-cell ON the GPU.

#### The "GRA Rule Table" macro ([scripts/gen-gra-rule-table-macro.mjs](scripts/gen-gra-rule-table-macro.mjs) → `public/macros/`)
The authoring idiom as a droppable template: Neighbour Census + Get Self Attribute → **Table Lookup** (tag-valued) → **Switch** → labelled flow reroutes → Idle (unwired — doing nothing is a verb) / Divide / Die / Bond / Unbond. The three model-specific references are left BLANK on purpose so the dropped macro shows amber "select a…" badges naming exactly what to fill in. ⚠️ Vite indexes `public/macros/` at **startup / closeBundle** — restart the dev server (or build) or `index.json` will not list it.

#### **FINDING (P1, pre-existing) — `agentUpdateMode: 'sync'` was NOT honoured on the WebGPU agent target. FIXED in PX (below).**
The behaviour shader read neighbours' attributes out of the **SAME `agentF32` region it wrote its own into**, with no double buffer, so a neighbour could be read pre- or post-write depending on scheduling. Any **synchronous, neighbour-attribute-reading** agent rule — i.e. exactly the totalistic-CA / GRA class — was therefore wrong there, and **non-deterministically** so. Measured in the real worker against a hand-written Conway reference: **`Game of Life on Agents` (SHIPPED, census-free, `getNearbyAgents`) was wrong by 18 of 1024 cells on its own shipped WebGPU target** (0 on JS and WASM); `Life on Bonds` by **14 or 18 depending on the trial** — the run-to-run variation is the race. **The census itself is exact on all three targets**: with `alive` frozen (no write ⇒ no race), JS, WASM and WebGPU produce byte-identical per-agent counts matching an independent recount from the bond store, 0 mismatches over 1024 agents. CLAUDE.md's older claim that on the GPU "the mode only affects CPU buffering… a parallel dispatch is snapshot-reads + thread-own-writes either way" held only for a rule that reads no neighbour ATTRIBUTE.

#### Verification
[scripts/verify-graph-rewrite.mjs](scripts/verify-graph-rewrite.mjs) — the milestone's invariant + oracle harness, **created here and extended by every later phase**. Three tiers, 58 checks: **A** the reusable graph invariants over a `getState`-shaped payload (`decodeAgentGraph` + `checkHandshake` I1 / `checkNoDangling` I3 / `checkCapacity` I4 / `checkDegreeRegular`), **each with a negative-control mutation** proving it fails when broken; **B** the lowering (ports, shape, consumed-only, stale-edge drop, determinism, hot-path no-op, BOTH gates accepting, and the WGSL comparing against the real option indices); **C** the Conway oracles run headless through the REAL compiled behaviour over a real store — **O7** (census == the shipped proximity model, 200 generations, + JS↔WASM bit-identity + I1/I3/I4 every generation), **O11** (block stable 50 gens; blinker/toad period exactly 2; glider back to its shape translated exactly (1,1) after 4), **O3** (an all-Idle rule table leaves every agent, N and E bit-identical for 100 generations, with a negative control proving a non-Idle table DOES mutate the same graph). Plus a permanent `[synthetic] Neighbour Census` entry in [parity-agent-wasm.mjs](scripts/parity-agent-wasm.mjs) carrying a bond-list recount invariant (negative-controlled: mis-mapping two count ports is caught).
- **Harness lesson worth keeping**: the O3 negative control caught TWO real harness bugs that had made O3 vacuous — `lookupInteraction`'s config key is **`tableId`** (not `attributeId`) and the Switch's flow input is **`check`** (not `do`), and separately the harness has to populate `ctx.lookupTables` from the model or every table read returns 0. A test that only ever passes proves nothing.

---

### G3 closed (part 1) — Bond Attributes: schema, store, CPU ABI, JS + WASM

**Per-EDGE user state** — the long-recorded missing capability and the enabler for typed rewriting rules ("break only *apical* bonds"), SDCA link variables, and P5's combinatorial division. Phase doc: [docs/HANDOFF_GRA_P2_BOND_ATTRIBUTES.md](docs/HANDOFF_GRA_P2_BOND_ATTRIBUTES.md). **JS + WASM with bit-parity; the WebGPU agent target REJECTS a bond-attribute model** (the sanctioned capability gate — P3 lifts it).

#### Schema — the THIRD attribute id-space
`CAModel.bondAttributes?: Attribute[]`, alongside `attributes` (cell/model) and `agentAttributes`. **Only bool / integer / float / tag** (decision **D1**) — the scalar-numeric set that fits one number exactly on every target; `vector` / `color` / `neighborIndex` are excluded because a vector bond attribute needs the `lowerVectorAttrs` treatment on a RAGGED store (a separate milestone). Enforced in the type dropdown AND defensively in `bondAttrsOf`.

**`bondAttrsOf(model)`** ([attributeScope.ts](src/model/attributeScope.ts)) is the ONE resolver every mirror derives from — the memory layout, the ABI block, the worker's store specs, the WASM emitters, the SimulatorView init message, the WebGPU gate. It applies **two** filters, and both must ride together everywhere: `resolveMaxBonds(centerBased) === 0` (Bonds capability off) ⇒ **EMPTY**, and only `BOND_ATTRIBUTE_TYPES` survive.

#### **Decision D2 — bonds are SYMMETRIC, and that is not negotiable**
A bond is ONE object stored TWICE. `Set Bond Attribute` writes **both** slots and invariant **I2** requires them to agree, so an asymmetric bond attribute is *impossible* without breaking the invariant. The idiom for a directed quantity is to **store** an owner/direction VALUE (an `ownerId` integer bond attribute compared against Get Self Handle), never to write the two sides differently.

#### Store — and THE COMPACTION LOCKSTEP RULE (the phase's highest risk)
[agentEngine.ts](src/simulator/engine/agentEngine.ts): one ragged region per bond attribute (`maxAgents * maxBonds`), typed by **`bondAttrKind`** — deliberately NARROWER than `agentAttrKind`: **bool/integer/tag → Int32, float → Float64**, so the ragged store keeps exactly TWO region shapes (a bond bool costs 3 spare bytes rather than adding a third shape to the layout, the compaction list and both compilers). Plus one **per-agent f64 Form-Bond request cell** per attribute (the sibling of `bondFormL`/`bondFormK`).

> **`moveBondSlot(store, dst, src)` is the ONLY place a bond slot's contents move**, and it iterates `store.bondSlotArrays` — the fixed list of every ragged per-slot array (the five built-ins + one per bond attribute). **THREE** compaction paths call it: `removeBondSlot` (used by Break Bond **and** death via `breakAllBonds`) and **`sweepStaleBonds`**, which carries its OWN swap-with-last. ⚠️ The Impact Map named only two; the sweep is a third and it was NOT in the enumeration — see the Completion Report. A field added to the store but missed in ANY of them does not crash: it silently associates a value with the WRONG partner on the first bond removal. The field-list-driven helper makes that structurally impossible; the 500-generation compaction audit is the oracle, and it is **negative-controlled against BOTH paths**.

`divideAgent`'s bond snapshot carries the attributes, so a daughter inherits its partitioned bonds' values UNCHANGED (P5 adds explicit assignment). `initAgentSlot` clears the request cells (recycled-slot hygiene). `serializeAgentStore` / `deserializeAgentStore` add a `bondAttrs` record; deserialize FILLS each region with its default first, so an attribute missing from an older payload can't inherit a previous run's values.

#### Layout + ABI
`computeAgentMemoryLayout` appends `bondAttrOffset` + `bondFormAttrOffset` **after every existing region** (including `stopFlagOffset`), so every pre-P2 layout is byte-identical and `maxBonds === 0` allocates zero bytes. `createAgentStore` OVERRIDES `layoutExtras.bondAttrSpecs` with its own `opts.bondAttrSpecs` (the `syncAttrs` precedent) so the allocated arrays and the baked offsets come from ONE list.

[agentAbi.ts](src/modeler/vpl/compiler/agentAbi.ts) gains `AgentAbiShape.bondAttrs` → `_bondAttr_<id>` (loop **and** division) + `_bondFormAttr_<id>` (loop only — division carries no `_bondFormReq`). **The `gate(profile)` hook stays UNUSED, deliberately**: NOT ONE caller passes a profile (`compile.ts`'s three param builders, the worker's three arg builders, every harness), so making it live would be a no-op at every real site. **The SHAPE is the gate** — `bondAttrsOf` returns empty when Bonds is off, so the block drops without the descriptor ever seeing a profile. Every shape-building site must supply `bondAttrs`: `agentAbiShapeOf` (compile.ts), `agentAbiShapeOfStore` (worker), and the parity harness's `buildArgs` — **omitting it shifts every later arg** (the harness proved this loudly: `w_sumL` resolved to the string `''`).

#### Nodes
| Node | Shape |
|---|---|
| **Get Bond Attribute** | `partnerId` → `value`. Scans this agent's bond list for the partner (the same straight partner-id scan `forEachBond`/`hasBond` use — no epoch re-check, the post-step sweep keeps the list clean). **No bond ⇒ the attribute's DEFAULT**, never `undefined`/NaN. In `NEVER_PURE_TYPES` (mutable storage + slots move under compaction) and `NEVER_INVARIANT` / `AGENT_VALUE_NO_HOIST` (it reads the CURRENT agent's list). |
| **Set Bond Attribute** | flow; `partnerId` + `value`. Writes **BOTH** slots (own side unguarded — `idx` is live; partner side range + alive guarded). No such bond ⇒ no-op. |
| **Form Bond** (extended) | one **dynamic input port per bond attribute** (`bondAttr_<id>`, labelled with the attribute NAME, type-adaptive inline widget), built by the shared **`buildBondAttrPorts`** ([bondAttrPorts.ts](src/modeler/vpl/bondAttrPorts.ts)) consumed by BOTH CaNode and effectivePorts (the dual-consumption discipline). The values ride the per-agent request cells; the structural phase hands them to `formBond`, which stamps them into both slots. **A model with no bond attributes emits byte-identical code.** |

**Why dynamic ports rather than `multiAttrExpand`-style slots** (the recorded choice): the port set is derived from `model.bondAttributes`, so it can never name a deleted attribute, needs no `+ slot` UI, and each port's widget/label comes straight from the attribute — the user sees "Weight" and "Kind", not "Value 2" and "Value 3".

A node naming an attribute the model no longer declares emits its literal default (Get) or nothing (Set) rather than referencing an undefined `_bondAttr_<id>` param — so a hand-edited or Bonds-off model can't produce a dangling reference.

#### The WebGPU capability gate (P2 only — **LIFTED by P3**)
P2 shipped a MODEL-level rejection (`isAgentGraphWebGPUSupported` returned false when `bondAttrsOf(model).length > 0`) rather than three node-level ones, because Form Bond's initial values would otherwise have silently VANISHED on the GPU (its request fields had no attribute lanes). **P3 removed it** — bond attributes now run on all three agent targets; see the P3 section below.

#### UI + worker
A **Bond Attributes** section in the Attributes panel on the **Agents** sub-tab, shown only when the Bonds capability is on. ⚠️ `ModelerView.selectedItemName` resolves the **`bond:<id>`** slot — an unresolved prefix means the detail `PanelShell` (gated on `detailItemName != null`) never mounts, so clicking or adding an item does NOTHING visible (the bug that shipped once for agent attributes). The agent inspector lists each bond with its attribute values (tag values decode to their NAMES). `SimulatorView` ships `bondAttributes` in the init message and treats **any** bond-attribute add/remove/retype/**reorder** as STRUCTURAL (`attrsStructurallyEqual`) ⇒ full worker reinit — a soft recompile against a changed bond layout is the baked-offset corruption class.

#### The simulator's BOND inspector — select and edit one edge
An inspect click (**Shift+LMB**, or the toolbar ⓘ Inspect toggle) that lands on **no agent** but near a **bond LINE** pins an [`InspectBondPopover`](src/simulator/InspectBondPopover.tsx) — the EDGE twin of `InspectAgentPopover`, sharing its CSS, header drag, Esc-close and Close-all. Shows the two endpoint ids (each a chip that pins THAT agent's inspector), the torus-folded current length, the rest length, the stiffness and **one row per bond attribute**; a model with NO bond attributes still gets the built-ins. **2D ONLY** (a 3D line pick is a follow-up; the 3D gesture is simply not offered rather than half-shipped).
- **`bondsAvailableRef` gates the whole hit test** (`resolveMaxBonds(model.centerBased) > 0`), so a bond-free model — Boids, whose profile is `bonds: 'off'` — is byte-identically unaffected.
- **AGENTS WIN THE CLICK** (the bond pick runs only after `pickAgentAt` returns -1). Consequence, documented in Help: in a packed tissue whose cells TOUCH, the bond line is entirely under the two discs and cannot be picked — measured on `Morphogenesis - Growing Tissue`, whose best clearance anywhere is **1.3 screen px**. Read those values from either endpoint's agent inspector, which already lists every bond with its attribute values.
- **`pickBondAt` folds BOTH the click point and the far endpoint relative to `i`** with the SAME torus rule `drawAgentsOverlay` strokes the segment with, so the hit test matches the drawn line across a seam. Tolerance `BOND_PICK_PX` (6) screen px, nearest segment wins.
- **THE POPOVER READS LIVE AND WRITES ON APPLY.** A rule often rewrites a bond attribute EVERY generation (SDCA's link value is an EMA), so write-on-change would fight both the rule and the 3 Hz poll: each row reads the live value until the user touches it, then a per-field local draft wins and **Apply** commits every dirty field in ONE `setBondState`. Drafts clear on Apply, so rows return to live.
- **The stiffness row is HIDDEN when `usesEngineSprings` is false** (with `bonds: 'data'` it feeds nothing) — the standing enabled-control rule. Rest length is always shown: `forEachBond.restLength` makes it graph-readable regardless of springs.
- **Two worker messages, classified deliberately.** `getBondState {a,b}` joins the **one-shot staleness READERS** beside `getAgentState`/`readAgents` (a free-mode WebGPU model must not report stale positions in the length); `setBondState {a,b,restLength?,stiffness?,attrs?}` joins **`AGENT_GPU_DEFER_TYPES`** (a mutation: deferred during an in-flight GPU readback + sets `agentGpuUploadPending`, so the per-generation `uploadAgentBondStore` carries the edit to the GPU).
- **The write goes through [`setBondFields`](src/simulator/engine/agentEngine.ts), which writes BOTH slots** (**I2** — a bond is one object stored twice) via the new `bondSlotIndex` (epoch-checked, so a slot pointing at a RECYCLED id reads as absent). It rejects the whole patch when the bond does not exist, so a broken bond can never be half-written.
- **The highlight is DERIVED per draw** (`drawCursorLayer`, accent `rgba(232,161,58)`) from the open popovers + the LIVE snapshot — never cached at selection time — so it tracks the moving endpoints; it is additionally **gated on the cached `live` flag**, so a bond that BREAKS stops being stroked even though both endpoints survive (the popover then reads "Bond no longer exists"). A liveness flip forces one `scheduleCursorDraw`, since nothing else repaints while paused.
- Bond popovers join the `modelVersion` close-all (a pair of ids into the OLD population) and add a `bondInspectKeysRef.current.length > 0` term to the agent UI-sync driver.
- **Verified through the real UI** (real gestures, real worker): on **SDCA** (WebGPU agent target, float `strength` bond attribute) a Shift+LMB at a bond midpoint opens `Bond #0 ↔ #181` with the right length; typing 0.777 + Apply makes **BOTH endpoints' own ragged rows read 0.777** via the independent `getAgentState` path (**I2 through the UI**); the highlight is the accent colour with **every one of its 200 px within 2.09 px of the true segment**, moves with the agents, and drops to **0 px** when the bond is cut while both endpoints stay alive. **The edit reaches the GPU**: strength forced to 0.05 while paused, then ONE generation of the GPU rule produced exactly `0.05 + 0.75·(0.75 − 0.05) = 0.575` — a value reachable only from the edited number (an un-propagated edit would have left it at 0.75). On **Growing Tissue** (bonded, NO bond attributes) the popover shows built-ins only. Loading another model clears it; **0 console errors** throughout.

#### Verification (all in `scripts/`)
- **`verify-graph-rewrite.mjs` Tier D** — `checkBondSymmetry` (**I2**, comparing EVERY per-slot field) with three negative controls, and the **500-generation compaction audit**: random form / break / death / division / induced-stale + sweep against an INDEPENDENT truth map keyed by the unordered pair. Internal consistency alone would not do — a swap that moves both sides consistently-but-wrongly passes I2, so the audit compares against a map the engine never sees. **Negative-controlled at the ENGINE level**: reverting `sweepStaleBonds` OR `removeBondSlot` to a hand-written 5-field swap makes it fail (gen 5 / gen 3). ⚠️ The audit had to **INDUCE staleness** (mark an agent dead without cleaning its partners' lists) to reach the sweep's swap at all — `freeAgentSlot` already cleans partners, so normal churn leaves nothing stale and the first version of the control did not trip.
- **`parity-agent-wasm.mjs`** — a permanent `[synthetic] Bond attributes` entry: writes each bond from the LOWER-id endpoint only, reads every bond back, over a topology whose slots were already compacted by breaks. Carries a **VALUE invariant** (each bond equals `min*1000+max`, both endpoints agree, the f64 and i32 regions agree, per-agent sums match) — negative-controlled BOTH ways: making only WASM one-sided is caught by parity, making BOTH one-sided is caught only by the invariant.
- Persistence: the engine payload AND the base64 `.gcastate` encoding round-trip bit-exact; a pre-P2 payload resets every bond attribute to its default.
- **Real browser** (agents-only model, 16 agents in a chain): Form Bond seeds `weight = self*100 + partner` (708 / 809 / 1415 exactly), Set Bond Attribute writes `kind` from the lower side only and the HIGHER agent reads it back (**I2 through the real worker**), Get Bond Attribute sums correctly — **identical on the WASM and JS agent targets**; the Bond Attributes panel + detail editor open with the type dropdown restricted to the four allowed types; Form Bond shows both attributes as labelled ports; the inspector renders `→ 7  Weight 708.000 · Kind Basal`; a Save-then-Load `.gcaproj` round-trip restores every value at **Gen 0** (proving they came from the file). Zero console errors throughout.

---

### Prerequisite — synchronous agent attributes are double-buffered on WebGPU

**`agentUpdateMode: 'sync'` is now honoured on the WebGPU agent target.** It was not: the behaviour shader read a neighbour's attribute from the SAME `agentF32` run it wrote its own into, so with threads running in parallel and in an unspecified order **agent A's write became agent B's read within one dispatch** — async (single-buffer) semantics silently applied to a model the user configured as synchronous. Every totalistic-CA / GRA rule is exactly that shape, so the milestone's own flagship samples would have been silently wrong on the GPU. Runbook: [docs/HANDOFF_GRA_PX_WEBGPU_SYNC_ATTRS.md](docs/HANDOFF_GRA_PX_WEBGPU_SYNC_ATTRS.md). Pre-existing defect (found by P1), not caused by any phase.

**Measured before → after** (real worker, real GPU; the shipped `Game of Life on Agents` on its own `agentTarget: 'webgpu'`, against a hand-written Conway reference from the identical seeded board): **123 / 56 / 32 / 32 wrong of 1024, varying run to run → 0, 0, 0**, with the post-step alive count landing on the JS/WASM value (359) instead of drifting (330/335/347/355). The run-to-run VARIATION was the race; JS and WASM were 0 throughout, which is what validates the measurement.

#### The design — a second run + a per-generation commit pass (the CPU targets' double buffer, on the GPU)
- **Layout** ([agentWebgpu/layout.ts](src/modeler/vpl/compiler/agentWebgpu/layout.ts)): `AgentWebGPUExtras.syncAttrs` (fed by `agentWebGPUExtrasOf` from `centerBased.agentUpdateMode`, the same general property `createAgentStore` and the WASM `AgentLayoutExtras` read) allocates a **second contiguous block of per-attribute runs** — `agentAttrWriteBase[id]` — right after the read block, in the SAME attribute order. **When async the write base ALIASES the read base** (identical value, zero extra bytes).
- **Emit** ([agentWebgpu/compile.ts](src/modeler/vpl/compiler/agentWebgpu/compile.ts)): a single accessor **`attrAt(ctx, attr, idx, 'read' | 'write')`** replaces every `f32At(ctx, attr, …)`. **4 read sites** (`getCellAttribute` own-read, `getAgentAttribute` by-id, the `getAgentsAttribute` gather, `filterAgents`) → read base. **5 write sites** (`setAttribute` self + by-id [then a separate `setAgentAttribute`], `updateAttribute`, `setAgentsAttribute`, and `createAgent`'s newborn attribute defaults) → write base. `updateAttribute` read-modify-writes the WRITE run, mirroring JS's `w_<attr>[idx]` and the WASM `pushAgentAttrWriteAddr` — so a preceding Set in the same step is what an Update sees. **This mirrors the WASM agent compiler's `pushAgentAttrReadF64` / `pushAgentAttrWriteAddr` split exactly**; that split (`syncAttrs ? attrWriteOffset : attrOffset`) is the pattern PX ports to the GPU.
- **Commit** ([agentWebgpuRuntime.ts](src/simulator/engine/agentWebgpuRuntime.ts) `attrCommitWGSL`): a tiny compute pass appended to every `dispatchAgentStep` encoder folds write → read, once per generation. **A COMPUTE pass, not `copyBufferToBuffer` — a same-buffer copy is a WebGPU validation error** (the L1 voxel `posCommit` precedent). Both blocks are contiguous, so it is ONE linear copy of `agentAttrIds.length · maxAgents` elements, dispatched through the 2-D `dispatchAgents` tiling (a flat 1-D dispatch silently no-ops past 65535 workgroups). It covers **all `maxAgents` slots, not just `highWater`** — a Create Agent newborn lives beyond the live range and its GPU-written defaults must reach the read run before the reconcile. Built ONLY when `layout.syncAttrs`, so an async model creates no extra module/pipeline.
- **Prime** (`uploadAgentSoA`): the write runs are seeded from `s.attrRead` alongside the read runs — the GPU analogue of `primeAgentAttrWrite`. **Mandatory**: an attribute the behaviour never writes would otherwise be 0 in the write run and the commit would clobber it.
- **The readback side needed NO change** — and that is the point of committing rather than reading the write run: after the commit the READ runs hold the committed generation, so `readbackAgentStep` (→ `s.attrWrite`, then the worker's `swapAgentAttrs`), the spawn reconcile, and `readbackAgentFrame` all keep reading `agentAttrBase` verbatim.
- **Residency is UNCHANGED** — `agentResidentEligible` still requires async attrs, so a sync model takes the per-generation path (where the CPU re-uploads every generation anyway). The commit pass IS wired into `dispatchResidentBatch`'s per-gen loop under the same null-check, so it is dead code today but a future residency widening inherits the correct semantics instead of silently reintroducing the race.

#### Byte-identity — the async fast path is untouched
`check-compile-identity` vs the P2 baseline: **26 models, exactly 2 diffs**, both the `agent.webgpu.shader` of the two SYNC models. A literal `diff` of the emitted WGSL before/after for **Boids** (no agent attrs) and **Particle Life** (one agent attr) is **byte-identical, zero lines**, with `f32Len` unchanged (12600 / 70400). The sync `Game of Life on Agents` shader differs by **exactly one line** — the `setAttribute` write moved from `agentF32[21840u + idx]` (read run) to `agentF32[22880u + idx]` (write run) while both its reads stay at 21840.

#### `Life on Bonds` flips to WebGPU
P1 shipped it on `wasm` because correctness outranked the perf policy; with the race gone it ships on `agentTarget: 'webgpu'` per the library policy, and it is the differential ORACLE that proves the fix: **P1's O7 (cell-for-cell vs. `Game of Life on Agents`) passes ON THE GPU** — identical seeded boards, 60 vs 61 generations (the one-gen auto-bond bootstrap offset), **0 of 1024 cells differ**. Both models are on `webgpu`, both `syncAttrs: true`.

#### Verification
- **`verify-graph-rewrite.mjs` Tier E** (new, 17 checks → 106 total): the layout (`syncAttrs` from the update mode, write ≠ read under sync, aliased under async, the SoA grows by exactly one run per attribute, the two blocks contiguous) + the emitted WGSL (the attribute is read at the read base, written at the write base, **nothing writes the read run**, nothing reads the write run; async reads AND writes the same aliased base). **Two negative controls**: compiling the same sync model against a deliberately aliased (pre-PX) layout is CAUGHT, and reverting the `setAttribute` emit to the read run makes the tier FAIL with exactly the race diagnostic (verified by mutation, then restored).
- **Real GPU, real worker** (0 console + 0 worker errors throughout): the primary gate 3× at 0/1024; **50, 20 and 100 generations from three seeds all exact** vs the Conway reference (boards genuinely evolving, 286→152 / 298→190 / 331→58); `Life on Bonds` (shipped file, unpatched) resolves to `webgpu` and is exact over 40 generations, 3 trials; **async unregressed** — Boids flocks to polarization **0.9983** over 400 gens and Particle Life's `species` histogram is unchanged over 200 gens with agents moving, both with `residentEligible: true` (so the resident batch with the added conditional pass ran).
- ⚠️ **Verification trap**: the service worker runtime-caches model `.gcaproj` (StaleWhileRevalidate), so a browser probe that `fetch`es a model file just edited on disk gets the PRE-EDIT copy. Use `fetch(url + '?t=' + Date.now(), { cache: 'reload' })` — the first `Life on Bonds` run reported `agentTarget: 'wasm'` purely from that cache.
- tsc · build · `parity-agent-wasm` (JS↔WASM bit-parity, all entries) · `check-agent-wasm-gate` · `audit-agent-layout` · `test-agent-abi` · `parity-agent-force` · `verify-agent-render` · `verify-render-uniform-layouts` · `audit-modelattr-layout` · `test-agent-capabilities` · `test-cross-agent-writes` — all green.

---

### G3 closed (part 2) — Bond Attributes on the WebGPU agent target

**Bond attributes now run on ALL THREE agent targets.** P2 shipped them on JS + WASM and rejected them at MODEL level on WebGPU; P3 lifts that. Runbook: [docs/HANDOFF_GRA_P3_BOND_ATTRS_WEBGPU.md](docs/HANDOFF_GRA_P3_BOND_ATTRS_WEBGPU.md).

#### The layout — ONE stride constant, widened in place
A GPU bond slot went from `[partner, restLengthBits]` to **`[partner, restLengthBits, ...userBondAttributes]`**, so the slot stride is `2 + N`. **`AgentWebGPULayout.bondSlotStride` is the SINGLE definition** ([agentWebgpu/layout.ts](src/modeler/vpl/compiler/agentWebgpu/layout.ts), + the exported `bondSlotStrideOf`): the layout, all three pre-existing bond emitters, the two new ones and the runtime upload/readback ALL derive from it. **Never write a literal `2` for the stride** — a missed site reads the WRONG LANE silently (no error, no crash: an attribute read as a rest length, or a partner id read as an attribute). The emitters index exclusively through `bondRowBaseExpr` / `bondSlotWord`, and Tier F asserts stride consistency over the WHOLE emitted shader with a **mutation negative control** that forces the stride back to 2.
- `bondAttrWord[id]` = `2 + i` · `bondAttrIsFloat[id]` — a `float` attribute stores **f32 BITS** (`bitcast`, exactly like restLength), bool/integer/tag a plain i32 word (mirroring the CPU `bondAttrKind`).
- `bondFormAttrBase[id]` — one per-agent f32 run in `agentF32` carrying **Form Bond's INITIAL value** (the GPU sibling of `bondFormL`/`bondFormK`), **appended after every other run** so all pre-P3 bases stay byte-stable. This is exactly why P2's gate had to be model-level: a Form-Bond-only model would otherwise have silently dropped its initial values.
- **No bond attributes ⇒ stride 2, no extra runs, `* 2u` verbatim** — every shipped model's shader is unchanged (`check-compile-identity`: 26 models, all surfaces).

#### Binding 11 is `read_write` only when something writes it
`ctx.usesBondStoreWrite` (set by the Set Bond Attribute emitter) promotes the declaration and is shipped on the compile result → SimulatorView → the worker → `createAgentWebGPURuntime`, which binds `storage` instead of `read-only-storage` and gives the buffer COPY_SRC. `usesBondStore` still gates the DECLARATION itself (Naga strips an unused storage global ⇒ the bind group mismatches the pipeline layout — a shipped bug). A read-only bond-attribute model keeps the pre-P3 `read` binding.

#### Runtime round-trip
`uploadAgentBondStore` writes the attribute lanes from `s.bondAttrs[id]` in `bondAttrIds` order (= `bondAttrsOf(model)` = the store's `bondAttrSpecs` — the baked-offset lockstep); the new **`readbackAgentBondStore`** copies ONLY the attribute words back (partner / restLength are CPU-owned — the structural phase forms, breaks and compacts them; the shader never writes them). It runs **BEFORE `runAgentStructuralPhase`**, so a bond broken this step drops its values with its slot. The Form-Bond request runs upload as 0 each step (a fresh request slate, like `bondFormReq`) and read back into `s.bondFormAttrs`. **NO commit pass and no second (write) region for bonds** — see below.

#### Why bond attributes are SINGLE-buffered on the GPU (and PX's pattern is NOT copied)
PX's follow-up recommended a `bondAttrWriteBase` mirroring the agent-attribute double buffer. **That would have introduced a GPU-ONLY semantic divergence**: the CPU targets store bond attributes SINGLE-buffered *by deliberate P2 design* ("a bond is one object stored twice, so a write goes to BOTH slots — there is no read/write double buffer to keep in step", [agentEngine.ts](src/simulator/engine/agentEngine.ts)), **even under `agentUpdateMode: 'sync'`**. Adding a GPU write region would make a sync model's GPU result deterministically differ from its CPU result. Cross-target agreement outranks a mechanism, so the GPU mirrors the CPU. (True *synchronous* bond semantics would need a CPU double buffer too — an all-three-targets change, recorded as a follow-up.) A bonded model is never residency-eligible (`agentResidentEligible` requires `s.maxBonds === 0`), so the bond store is uploaded and read back every generation — which is what makes single buffering safe here.

#### ⚠️ Set Bond Attribute is ORDER-UNDEFINED on WebGPU when BOTH endpoints write one bond
A bond is stored twice, so this node necessarily writes a word in the **partner's** row — the same hazard class as the gated `CROSS_AGENT_OVERWRITE` set. **Measured on real hardware** (32- and 512-agent rings, sync agent mode, 4 trials each):

| rule shape | CPU (JS ≡ WASM) | WebGPU | I2 |
|---|---|---|---|
| **one-sided** (only the lower id writes) | `w == 10` on all 32 edges | **identical — 0 of 32 edges differ** | holds |
| **symmetric** (both write the SAME value) | `w == seed_i + seed_p` | **identical — 0 of 32 differ, 3 trials** | holds |
| **asymmetric** (both write DIFFERENT values) | `max(i,p)` everywhere (last writer in index order) | **30 of 32 differ** (510 of 512 at N=512) — the LOWER id wins — and **2 edges TEAR I2** | **violated on 2 edges** |
| Form Bond initial values | correct | identical | holds |

**Decision: ALLOW + document (option A).** Only the ASYMMETRIC case breaks, and that case is *already* invalid on every target — P2's decision **D2** rules it out ("a genuinely asymmetric bond attribute is impossible without breaking I2; store an owner value instead"). Gating it would clamp every bond-attribute-WRITING model — i.e. essentially every GRA rule, since an SDCA link rule writes every step — off the GPU. Documented in the node description, HelpView, the Properties agent-target hint and here. NB the GPU outcome was *stable across trials on this device*; that is a driver artifact, not a guarantee — WebGPU orders nothing between invocations.

#### A JS-only defect this surfaced (fixed here)
Form Bond's per-bond-attribute INLINE widget values were dropped on the **JS** target: `compileFlowChain`'s generic branch resolved inline values from `def.ports` (STATIC only) and wired dynamic ports from the edge map, so a DYNAMIC port with an inline widget and no wire fell through entirely and the node used the attribute default. WASM/WebGPU read `_port_*` straight from config and were correct — measured `lbl = 0` on JS vs `5` on WASM/WebGPU from the same model. Fixed by also resolving `buildBondAttrPorts(nodeType, model).inputs` (the ONE editor port builder, so the compiler cannot drift from what the canvas draws). Byte-identity unaffected (no shipped model has bond attributes).

#### Verification
- **`verify-graph-rewrite.mjs` Tier F** (new, 29 checks → 135 total): the layout arithmetic; stride consistency across the whole shader **with a mutation control** (forcing the stride back to 2 is caught); the no-bond-attribute model emitting the pre-P3 `* 2u` form; the `read_write` promotion + **exactly two** bond-store writes per Set (own row + partner row, the partner one range+alive guarded) = **I2 at the shader level**; Form Bond's request runs; a read-ONLY model keeping the `read` binding; 3D; bonds=off.
- **Real GPU / real worker** (0 console + 0 worker errors throughout): **200 generations on WebGPU with mid-run bond breaking** (so CPU compaction interleaves with the GPU readback) — **I1/I2/I3/I4 green at EVERY generation**, 0 value errors, edge count 32 → 30 → 32; **cross-target agreement 2D and 3D** — JS ≡ WASM ≡ WebGPU exactly on the one-sided, symmetric and Form-Bond models; regression smoke on the shipped bonded WebGPU models (Growing Tissue 12→24 agents / 36 edges; `Life on Bonds` 4096 edges, every agent degree 8).
- `check-compile-identity` vs the PX baseline: **26 models, all surfaces unchanged**. tsc · build · `parity-agent-wasm` · `check-agent-wasm-gate` · `audit-agent-layout` · `test-agent-abi` · `parity-agent-force` · `verify-agent-render` · `verify-render-uniform-layouts` — all green.

---

### G1 closed — the structural request QUEUE + the atomic Rewire verb

**THE KEYSTONE PHASE.** Form Bond and Break Bond each wrote a SINGLE `i32` cell per agent, so a later call in the same step silently REPLACED an earlier one. Every degree-preserving graph rewrite — triangle split, pair annihilation, edge swap — needs **2–5 edge mutations at one node in ONE step**; emulating that across generations makes the intermediate states violate the very invariant the rule preserves, which is why invariant **I6** was not merely unmet but *untestable*. Runbook: [docs/HANDOFF_GRA_P4_REQUEST_QUEUE.md](docs/HANDOFF_GRA_P4_REQUEST_QUEUE.md).

#### The queue — ONE shape, four consumers ([bondRequestQueue.ts](src/modeler/vpl/compiler/bondRequestQueue.ts))
```
slots  = D + 1                D = resolveBondRequestDepth(cfg)   (default 8, clamped [1,64])
base   = idx * slots          agent-major, exactly like the ragged bond store
slot c ∈ [0, D)               the QUEUE, drained in slot order (= the order the rule issued them)
slot D                        the OVERFLOW BUCKET — written by every op past the queue, applied
                              by NONE; its occupancy IS the overflow flag
```
Per entry the queue REUSES the existing request arrays as lanes, so **the ABI field list is unchanged**: `bondBreakReq` = the break side, `bondFormReq` = the form side, plus `bondFormL`/`bondFormK`/`bondFormAttr_<id>` for the form half. Because every entry carries BOTH sides, **one entry expresses all three verbs** and `rewireBond` is atomic *by construction* rather than two queued ops that could half-apply.
- **THE `+2` LANE BIAS IS LOAD-BEARING**: `0` = empty slot · `1` (`BOND_REQ_NONE`) = this side unused · `v + 2` = agent `v`. Every emitted op writes a NON-ZERO value into BOTH lanes, so the drain can stop at the first `0/0` entry (O(ops), not O(D), per agent). With the naive `target + 1` encoding a Form Bond whose target resolved to `-1` would write `0` and **truncate the queue**, silently dropping every LATER op that agent issued this step. `verify-graph-rewrite` negative-controls exactly this.
- **A REWIRE WITH AN UNRESOLVABLE SIDE WRITES `NONE` INTO BOTH LANES** — an explicit no-op entry. It must NOT degrade into a bare Form: that would RAISE the agent's degree, the exact thing a degree-preserving rule forbids.
- **`bondReqSlotsForModel(model)` returns 1 when the agent graph uses NO queue verb** (scanning the top-level agent graph AND every macro def, since macros expand at compile time). That reproduces the pre-P4 layout byte-for-byte — a general USAGE property, not a rule-shape test — and is what keeps all 26 shipped models byte-identical on every surface.

#### The drain lives in the ENGINE, not the worker
**`drainAgentBondRequests(store, lambda)`** ([agentEngine.ts](src/simulator/engine/agentEngine.ts)) is the ONE place queue entries are consumed; `runAgentStructuralPhase`'s step 1 just calls it and posts the overflow notice. It lives there so `scripts/verify-graph-rewrite.mjs` exercises the SHIPPED drain — **a drain the tests re-implement proves nothing**. Phase ordering is bonds → death → division → division event → **[D4: a SECOND drain]** → auto-bond → stale sweep. **D4 added that second pass** (gated on `agentUsesDivisionRequests`), so a Division Event can issue Form / Break / Rewire / Transfer Bond and have it applied in the SAME generation — safe because the drain zeroes an entry BEFORE decoding it, so a second pass re-applies nothing. See the *D3 + D4* section below.

#### `rewireBond` — the atomic verb (invariant I5)
`rewireBond(store, a, from, to, …)` PRE-CHECKS, then breaks + forms, or **does nothing at all**: `a↔from` must exist (else the "rewire" would be a bare form), `to` must be live / in range / not `a`, and `to` must have room unless `a↔to` already exists. `a`'s own capacity needs no check — the break frees one of its slots first. `to === from` re-forms the same edge with the new L/λ/attributes. There is never a half-rewired partner.

#### Emit — one shared emitter per target, a per-ITERATION cursor
The cursor (`_brqC` in JS, an i32 local on WASM, `var brqC` in WGSL) is a per-agent-iteration local, **declared only when the graph uses a verb** — on WASM `em.allocLocal` and on WGSL a `var` line both change the emitted bytes even when unused, so that usage gate IS the byte-identity gate. It always bumps, so an op past the queue lands in the overflow bucket instead of overwriting the last real entry.
- **JS** — [bondRequestEmitJS.ts](src/modeler/vpl/compiler/bondRequestEmitJS.ts), one emitter for all three node files.
- **WASM** — `emitBondRequest` in [agentWasm/compile.ts](src/modeler/vpl/compiler/agentWasm/compile.ts). Putting the ENTRY index in an i32 local lets the existing `pushI32ElemAddr`/`pushF64ElemAddr` helpers (`regionOffset + local*width`) address a queue entry unchanged.
- **WebGPU** — `emitBondRequest` + `reqAt` in [agentWebgpu/compile.ts](src/modeler/vpl/compiler/agentWebgpu/compile.ts). **NO ATOMICS**: a thread appends only to its OWN agent's rows and the emit is sequential within a thread (contrast Apply Force To Agent, which scatters into another agent's slot and does need an atomic CAS).

#### The layout lockstep
`AgentLayoutExtras.bondReqSlots` / `AgentMemoryLayout.bondReqSlots` / `AgentWebGPULayout.bondReqSlots` / `AgentStore.bondReqSlots` all come from ONE number, computed on the main thread (`bondReqSlotsForModel`) and shipped on **every** target as `agentBondReqSlots` in the init/recompile messages — because all three emitters BAKE the stride. `AGENT_REQUEST_QUEUE_FIELDS` (CPU) / `AGENT_GPU_QUEUE_FIELDS` (GPU) are the ONE list saying which fields are queue-shaped, consumed by both the offsets and the views/upload/readback over them. `bondReqSlotsForModel` is in SimulatorView's `needsFullInit` set: the stride IS the array shape, so a depth change — or **adding the first Form/Break/Rewire node**, which flips it from 1 to D+1 — needs a reinit, not a soft recompile. `clearAgentBondRequests` is the one place an agent's whole queue is zeroed (slot hygiene on alloc/free), so a new lane goes there and nowhere else.

#### Verification
`scripts/verify-graph-rewrite.mjs` **Tier G** (135 → **180** checks): the usage gate; **I5** — D+3 ops apply EXACTLY D with the rest rejected whole, the graph exactly the pre-step graph minus those D edges, the queue fully cleared; **I5 rewire** — a rewire that cannot complete leaves the graph EXACTLY unchanged, and one from a non-existent edge never becomes a bare form; the terminator rule; **multi-op** — 3 rewires (6 edge mutations) by one agent in ONE generation with I1–I4 green immediately after; **O5** — a double-edge-swap rule keeps N, E and the **full degree multiset** invariant over **500 generations**, exactly; plus the emit shape on all three targets. **Every one is negative-controlled.** `parity-agent-wasm` gained the permanent `[synthetic] Bond request QUEUE` entry (4 explicit ops + a 12-iteration loop ⇒ overflow) whose **value invariant recomputes the expected queue independently** — negative-controlled three ways, including a SHARED-constant mutation that both targets follow identically (which parity alone would pass).

### G1 completed — third-party bond formation (the *between* encoding)

> **⚠️ THE `formBondBetween` NODE IS RETIRED (2026-08-11).** Everything below describes the
> ENCODING, which is unchanged and very much alive — it is what a **Form Bond with its `agentA`
> port WIRED** lowers to (see "Form Bond names BOTH ends" below). The dedicated node was a second
> spelling of the same op and was folded into Form Bond; a legacy `.gcaproj` is rewritten on load
> by [formBondBetweenMigration.ts](src/model/formBondBetweenMigration.ts) — see "Retiring the
> Form Bond Between node" at the end of this section. Read `formBondBetween(a, b)` below as
> "a Form Bond with `agentA` = a and `Target` = b".

**The one edge a self-relative verb cannot make.** Form Bond is self-to-target, so an edge joining two agents that are BOTH someone else is inexpressible. That blocks the milestone's flagship oracle **O6**, the cubic **triangle split** (`v(a,b,c) → v₁,v₂,v₃` with the triangle closed): its `v₂–v₃` edge joins two agents the rule CREATED THIS GENERATION — neither is `self`, and neither runs its own behaviour until the next step. Spreading the split over two generations leaves an intermediate state with degree-2 nodes and `E ≠ 3N/2`, i.e. it violates precisely the invariant O6 tests. Runbook: [docs/HANDOFF_GRA_P4B_FORM_BOND_BETWEEN.md](docs/HANDOFF_GRA_P4B_FORM_BOND_BETWEEN.md).

#### THE ENCODING — the op kind rides the SIGN of the break lane (zero new fields)
A Form Between needs TWO agent ids in one queue entry, which is exactly what a **Rewire** already uses both lanes for — so the two collide and must be disambiguated. A new "op kind" lane was **rejected**: `bondFormReq`/`bondBreakReq` sit MID-LIST in `AGENT_I32_FIELDS` (and `AGENT_GPU_F32_FIELDS`), so any additional field shifts every later baked offset and diffs every agent model's bytes (the constraint P5 hit). Instead:

| verb | `bondBreakReq` | `bondFormReq` |
|---|---|---|
| Form(self→t) | `NONE` (+1) | `t+2` \| `NONE` |
| Break(self,t) | `t+2` \| `NONE` | `NONE` (+1) |
| Rewire(from→to) | `from+2` \| `NONE` — **> 0** | `to+2` \| `NONE` |
| **FormBetween(a,b)** | **`−(a+2)` \| `−NONE` — < 0** | `b+2` \| `NONE` |

*(Transfer and Break Between later took the two remaining sign combinations — the complete table
is under "G1 finished — `Transfer Bond`" below.)*

- **Every lane is signed on every target** — `bondFormReq`/`bondBreakReq` are `AGENT_I32_FIELDS` ⇒ `Int32Array` on the CPU, an i32 region in the WASM layout, an f32 run on the GPU — so nothing is truncated or wrapped. **Cost: zero new fields, zero moved offsets** ⇒ `check-compile-identity` 27/27 unchanged.
- **The "never write 0" rule survives**: an unresolvable Form Between writes `(−NONE, NONE)` = `(−1, +1)`, still non-zero on both lanes, so it cannot truncate the queue, and it decodes to `a<0`/`b<0` = an explicit no-op. The drain's terminator test (`bl === 0 && fl === 0`) is untouched.
- **The sign is decoded FIRST in the drain** — without that branch the entry falls through and is applied as a plain self→B form, i.e. it bonds the WRONG PAIR with no error anywhere. Negative-controlled by mutating the shipped `if (bl < 0)` to `if (false)`: the triangle split breaks at generation 1 with `degree 2 != 3`.

#### The verb ([FormBondBetweenNode.ts](src/modeler/vpl/nodes/FormBondBetweenNode.ts))
`formBondBetween(agentA, agentB)` + the same payload as Form Bond (rest length, stiffness, one initial-value port per bond attribute). **The request rides the REQUESTING agent's OWN queue, carrying both ids as PAYLOAD, not as addresses** — no thread ever writes another thread's rows, so exactly as in P4 the **WebGPU emit still needs no atomics** (asserted over the emitted shader). The drain calls the existing `formBond(store, a, b, …)`, which IS the whole-op gate: self / dead / out of range / already bonded / **either** list full ⇒ nothing on either side (**I5**), and it stamps both slots identically (**I2**). Rest length 0 ⇒ the **NAMED pair's** contact distance (`rad[a]+rad[b]`), not the requester's. All five registrations done (def, registry, both `AGENT_*_SUPPORTED_TYPES`, `nodeValidation`'s init-invalid set, `AGENT_NODE_REQUIREMENT` → `bonds`), plus `BOND_REQUEST_NODE_TYPES` (so the usage gate sizes the queue for it) and `BOND_ATTR_PORT_TYPES` (it forms a bond, so it seeds attributes).

#### The triangle split costs FIVE queue ops, not seven
From `v₁`'s behaviour, with `maxBonds` a TIGHT **3** (nothing transiently exceeds the cubic degree): `rewire(b → v₂)` · `rewire(c → v₃)` · `pair(b, v₂)` · `pair(c, v₃)` · **`pair(v₂, v₃)`** (a Form Bond with `agentA` wired). The two Create Agent + two Add To World calls are HOST calls and consume **no** queue slot. The handoff's literal `2 Form + 2 Break + 3 Between` formulation is 7 ops and also fits the default depth 8 (but transiently reaches degree 5, so it needs `maxBonds ≥ 5`). **Default depth 8 covers both** — P7 needs no raised depth.

#### Verification
`verify-graph-rewrite.mjs` **Tier J** (297 → **355** checks): registration + the usage gate; the drain bonds the two NAMED agents and NOT the requester; self / dead / out-of-range / already-bonded / unresolvable are no-ops that still OCCUPY their entry; **I5** with EITHER endpoint full leaves the graph exactly unchanged and the degree multiset exactly unchanged; **I2** across rest length, stiffness and both bond-attribute kinds; **THE GATE — 60 triangle splits, each COMPLETE in ONE generation**, with `checkDegreeRegular(g,3)` and I1–I4 asserted after EVERY one, `ΔN=+2`/`ΔE=+3` per split and `N = 4+2t`, `E = 6+3t` exactly (K4 → N=124, E=186); the 7-op formulation; and the emitted shape on all three targets. **Negative controls**: the same ids with a POSITIVE break lane are a Rewire (the sign is the discriminator); a sign-blind read bonds the REQUESTER to B; and — the decisive one — running the SAME split **without** the `v₂–v₃` Form Between breaks O6 while leaving I1–I4 green, so the gate is provably testing O6 and not something weaker. `parity-agent-wasm` gained the permanent `[synthetic] Form Bond BETWEEN` entry, whose entries 0 and 1 carry the **same two ids** and must differ ONLY in the sign; its value invariant recomputes the whole queue independently. Negative-controlled three ways: WASM-only drops the negation (`js=-3 wasm=3`); **both targets drop it identically** (parity PASSES, the value invariant catches it: `breakLane 3 !== -3`); and the engine drain ignores the sign.

**Real worker + real GPU** — a throwaway K4-seeded triangle-split model (generated → measured → deleted): **all three agent targets produced the IDENTICAL sequence**, 54 splits over 55 generations, **O6 (`min deg == max deg == 3` and `E == 3N/2`) TRUE at EVERY generation** together with I1–I4, ending at N=112 / E=168 = 3·112/2, with **0 worker errors and 0 console errors** (chip read `agents JS` / `agents WASM` / `agents WebGPU`).

#### `Form Bond` names BOTH ends — the optional `agentA` port (defaults to self)

Form Bond gained an **optional first-endpoint port `agentA` ("Agent A (self)")**, placed before `Target`. **Unwired ⇒ THIS agent** (the historical node, verbatim); **wired ⇒ the op LOWERS to the Form Between encoding** — the negated break lane, the same queue entry `formBondBetween` writes, with the second id read from `targetAgent` instead of `agentB`. So one node covers both "bond me to X" and "bond X to Y". **`formBondBetween` was subsequently RETIRED into this port** — see the next subsection.
- **Wiring `Get Self Handle` into `agentA` is indistinguishable from leaving it unwired** — not by a compile-time fold, but because the drain's Form Between arm calls the very same `formBond(a, b, …)`, and its extra `a < hw && alive[a]` checks are trivially true when `a` IS the requester (the drain already skipped dead agents, and `i < hw` by the loop bound). Rest length 0 likewise resolves to `rad[a]+rad[b]`, which equals the self-form's `rad[i]+rad[to]`. **Verified end-to-end on all three agent targets: the two produce the identical edge set AND identical slots** (partner, rest length, stiffness).
- **THE BYTE-IDENTITY RULE, and where it bites.** The wiredness comes from the **EDGE MAP** (`ctx.adj.inputToSource` on WASM/WebGPU; on JS `inputs['agentA'] !== undefined`, which IS the edge-map answer because the port carries **no inline widget** — `getInlineValue` returns undefined for one, so the only other way that key is set does not exist. **Give `agentA` a widget and the JS test silently starts reading an unwired node as wired.**) It is resolved **BEFORE any local or name is minted**: `em.allocLocal` changes the WASM module bytes and `fresh()` shifts every later WGSL name, even when the value is unused — so an unwired node must not mint so much as one extra. `effVerb === verb` on the unwired path ⇒ the historical arm verbatim. `check-compile-identity`: **29 models, all surfaces unchanged**.
- **Nothing else needed a change**, and each was checked rather than assumed: `geometryTaint` already treats every `formBond` value input as tainting (it is in `STRUCTURAL_VERBS` with no `GEOMETRY_ONLY_INPUT_PORTS` exemption), so a proximity-derived `agentA` taints exactly like `formBondBetween.agentA`; the **synchronous cross-agent OVERWRITE gate does NOT apply** (it lists only the four by-id SETTERS — a bond request is a queue entry on the requester's OWN rows, drained on the CPU, which is also why WebGPU still needs no atomics here); `BOND_REQUEST_NODE_TYPES` / `BOND_ATTR_PORT_TYPES` / `AGENT_NODE_REQUIREMENT` / the capability matrix all key off the node TYPE, which is unchanged.
- **Verification.** `verify-graph-rewrite.mjs` **Tier O** (517 → **533** checks): the ENGINE claim (a Between naming the requester ≡ the self-form, slot-for-slot) + a negative control (a third-party `agentA` bonds that pair, not the requester); the COMPILE claim on all three targets (JS emits the historical `= 1;` break lane unwired and `-(_bqA + 2)` wired; the WASM module BYTES differ between the two shapes; the WGSL emits the negated lane only when wired — asserted against `layout.f32Base['bondBreakReq']`, since `reqAt` resolves the field NAME to a numeric base and it never appears in the shader text). `parity-agent-wasm` gained the permanent `[synthetic] Form Bond pair ports` entry laying the three shapes side by side plus a real `formBondBetween` carrying the SAME ids, whose VALUE invariant asserts entry 2 and entry 3 are byte-identical (the lowering reuses the encoding rather than approximating it). *(Superseded in part by the retirement below: slot 3 is now a SECOND paired Form Bond, so the check reads "the entry depends only on the ids + params, never on which node instance issued it"; the tier counts moved 533 → 543.)* **Negative-controlled both ways**: WASM-only drops the lowering ⇒ parity catches it (`bondFormReq[4] js=1 wasm=8`); **both targets drop it identically ⇒ parity PASSES and only the value invariant catches it** (`entry 1: breakLane 1 !== -2`).
- **Real GPU + real worker**: both shapes device-compile with **0 shader errors and 0 validation errors**; a model where every agent asks for a bond between `i+1` and `i+2` produces the path `1-2…6-7` with the **requester at degree 0** and `Σdeg = 12 = 2|E|` — **identically on JS, WASM and WebGPU**, 0 console errors.

### G1 finished — `Transfer Bond` (third-party IN-PLACE partner replacement)

**The last piece of slot-order fidelity, and the one edge case Rewire could not express.**
`rewireBond(me, b → to)` is break + form AT THE REQUESTER, and the engine's `breakBond` compacts
by swapping the LAST slot into the freed one while `formBond` APPENDS — so a rewire **SCRAMBLES
THE THIRD PARTY'S SLOT ORDER** (and attaches the new partner to the REQUESTER, never to `b`).
Reference graph-automaton implementations reconnect a displaced neighbour with a single
**in-place** overwrite (`node[node.indexOf(i)] = j`). Slot order is not cosmetic: a cubic split
keeps slot 0 and hands slots 1 and 2 to its daughters, so a scrambled receiver propagates into
every later split and into the embedding forever. Design note: [HANDOFF_CLARITY_SIMPLIFICATION.md](docs/HANDOFF_CLARITY_SIMPLIFICATION.md) §3.B9.

**The verb.** `transferBond(me, b, to)` — rewrite `b`'s slot holding `me` IN PLACE to `to`
(position preserved); `me` loses `b` through ordinary compaction; `to` APPENDS the mirror slot.
Degrees: `b` unchanged, `me` −1, `to` +1.

#### THE ENCODING — the NEGATIVE FORM lane, the mirror image of Form Between's marker
Form Between took the break lane's sign; the FORM lane's sign was still free (Form / Break /
Rewire / Form Between never write it negative). So **`fl < 0` ⇒ TRANSFER**, with `bl = b + 2`
(the third party) and `fl = −(to + 2)`; the requester is implicit. **Zero new fields, zero moved
offsets, queue stride / ABI / layouts untouched** — the same argument P4b made, and the reason
`check-compile-identity` reports every model byte-identical after the verb lands.

| verb | `bondBreakReq` | `bondFormReq` |
|---|---|---|
| Form(self→t) | `NONE` (+1) | `t+2` \| `NONE` |
| Break(self,t) | `t+2` \| `NONE` | `NONE` (+1) |
| Rewire(from→to) | `from+2` \| `NONE` — **> 0** | `to+2` \| `NONE` — **> 0** |
| FormBetween(a,b) | `−(a+2)` \| `−NONE` — **< 0** | `b+2` \| `NONE` |
| **Transfer(b,→to)** | `b+2` \| `NONE` — **> 0** | **`−(to+2)` \| `−NONE` — < 0** |
| BreakBetween(a,b) | `−(a+2)` \| `−NONE` — **< 0** | `−(b+2)` \| `−NONE` — **< 0** |

The table is now **COMPLETE**: the op kind is read off the SIGN PAIR alone — `(+,+)` is the three
self-relative verbs (disambiguated by which side is `NONE`, as before) and each of the three
remaining combinations names one two-id verb. A seventh op kind would need a real field.

⚠️ **DECODE ORDER IS LOAD-BEARING.** The `fl < 0` branch must sit immediately after the existing
`bl < 0` branch in `drainAgentBondRequests`. Fall through and `to` decodes to −1, the entry lands
in the plain-BREAK arm with `from = b`, and **the transfer silently degrades to a bare Break** —
an edge vanishes with no error anywhere. Proven by source mutation: disabling the branch fails 41
harness checks. An unresolvable transfer writes `NONE` / `−NONE`, still non-zero on both lanes
(so it cannot truncate the queue) and still `fl < 0` (so it decodes as a no-op transfer, not a
Break). **The BREAK BETWEEN arm (both lanes negative) is decoded ahead of BOTH of these** — see
"Break Bond names BOTH ends" under "Agent action TARGETING".

#### THE BOND KEEPS ITS VALUES (a deliberate deviation from the B9 assessment)
It is the SAME edge re-pointed, so the rewritten slot at `b` retains its rest length, stiffness,
type label and every bond attribute, and the slot appended at `to` is stamped with those SAME
values — which is what makes **I2** hold by construction. Per-edge state therefore travels WITH
the edge, which is the semantically useful behaviour for a rewriting rule. Consequently the node
has **no rest-length / stiffness / bond-attribute ports** and is **NOT** in `BOND_ATTR_PORT_TYPES`
(B9's assessment expected it to seed attributes like a Form); and the emitters skip the form-half
parameter cells entirely, exactly as `break` does — the drain reads them for neither.

#### I5 / I2 — the whole-op pre-check list ([agentEngine.ts](src/simulator/engine/agentEngine.ts) `transferBond`)
All BEFORE any write, so a rejection leaves the graph EXACTLY as it was: `me` / `b` / `to` live,
in range and pairwise distinct; **`b↔me` must EXIST** (else it is a bare form at `to`, silently
raising a degree); **`b↔to` must NOT already exist** — the in-place rewrite would give `b` two
slots pointing at `to`, a DOUBLE EDGE no compaction path can undo; `to` must have room (`me`
needs no capacity check — it only loses). **I3**: `b`'s slot is OVERWRITTEN, never blanked, so it
is never transiently dangling.

#### All-target emit
One emitter per target, mirroring Form Between with the negation moved to the other lane: JS
([bondRequestEmitJS.ts](src/modeler/vpl/compiler/bondRequestEmitJS.ts) `'transfer'`), WASM
(`emitBondRequest`, `0 - x` via `OP_I32_SUB` — the encoder has no negate op), WebGPU
(`f32(-select(…))`). **WebGPU still needs NO atomics** — the entry rides the requesting agent's
own rows and the two ids are PAYLOAD, not addresses. Registered in `BOND_REQUEST_NODE_TYPES` (so
the usage gate sizes the queue), both `AGENT_*_SUPPORTED_TYPES`, `AGENT_NODE_REQUIREMENT` →
`bonds`, `nodeValidation`'s init-invalid set, `geometryTaint`'s `STRUCTURAL_VERBS`,
`targetDiagnosis`'s residency `STRUCTURAL` set and the registry.

#### Verification
- **`verify-graph-rewrite.mjs` Tier N** (new, 539 total): the slot POSITION preserved at the third
  party with its siblings untouched (the point of the verb) + a REWIRE control proving the two
  verbs build DIFFERENT graphs; the decode-order trap, both ways; **I5 across ten rejection paths**
  (no such edge / would-double-edge / full / dead / out of range / every self-alias / unresolvable)
  each asserting the graph is EXACTLY the pre-op graph, that not one uninvolved slot moved, and
  that a probe op queued AFTER the rejection still applies (no truncation); **I2 + KEEP-VALUES**
  across rest length, stiffness and both bond-attribute kinds; multi-op in one generation; and the
  emitted shape + both agent gates on all three targets. **Two SOURCE-MUTATION controls, both
  caught**: disabling the `fl < 0` decode → 41 failures; replacing the in-place rewrite with
  break+form → exactly the two position checks.
- **`parity-agent-wasm.mjs`** gained a permanent `[synthetic] TRANSFER Bond` entry placing a
  Transfer and a Rewire carrying THE SAME TWO IDS side by side. **Negative-controlled both ways**:
  dropping the negation on WASM only is caught by parity (`js=-4 wasm=4`); dropping it on BOTH
  targets passes parity and is caught by the **value invariant** (`formLane 4 !== -4`), which
  recomputes the whole expected queue independently.

#### Retiring the `Form Bond Between` node (branch `polishing`, 2026-08-11)

Once Form Bond's optional `agentA` port lowered to the very same queue encoding, the two nodes were
two spellings of one op — so the node was **removed** and Form Bond is the single bond-forming verb.
User call: *"just one node 'Form Bond' that can be used either with self or between two other agents
should be enough"*.

- **[formBondBetweenMigration.ts](src/model/formBondBetweenMigration.ts)** rewrites a legacy graph on
  load: `nodeType` → `formBond`, and the second endpoint's port `agentB` → `targetAgent` (the edge's
  `targetHandle` `input_value_agentB` → `input_value_targetAgent`, plus a stale `_port_agentB` config
  key). **`agentA` is untouched** — it is the port that makes the op a pair op. Everything else
  already matched port-for-port (`do`/`next`, `restLength`, `stiffness`, and the same dynamic
  `bondAttr_<id>` ports from the shared `buildBondAttrPorts`). Wired into the established trio:
  `LOAD_MODEL`, `cloneMacroWithFreshIds` (macro import) and `migrateForHarness`. Idempotent
  (same model reference when nothing matched); sweeps the agent graph, macroDefs **and** — purely
  defensively, since the node is `bondGraph`-gated — the cell + overseer stores.
- **BYTE-IDENTICAL, measured, no accepted diff.** `check-compile-identity`: **29 models, all surfaces
  unchanged**, `Growing Graphs` (the one shipped model that used the node) included. That holds
  because the migration preserves node ids, edge ids and BOTH array orders, and all three emitters
  already routed a wired `agentA` through the identical `effVerb === 'between'` arm — so the emitted
  JS text, the WASM module bytes and the WGSL are the same characters/bytes as before.
- **What was removed**: the node file + registry entry, and its membership in
  `AGENT_WASM_SUPPORTED_TYPES` / `AGENT_WEBGPU_SUPPORTED_TYPES` / `BOND_REQUEST_NODE_TYPES` /
  `BOND_ATTR_PORT_TYPES` / `AGENT_NODE_REQUIREMENT` / `nodeValidation`'s init-invalid set /
  `geometryTaint`'s `STRUCTURAL_VERBS` + label tables / `targetDiagnosis`'s residency `STRUCTURAL` set.
  **`'between'` is no longer a NODE verb** — `BondRequestVerb` is now the four real verbs
  (`form`/`break`/`rewire`/`transfer`) and the new `BondRequestOp = BondRequestVerb | 'between'`
  types the `effVerb` the three emitters branch on. **The queue ENCODING and the engine's drain arm
  are untouched.**
- **Generators** re-emit the new form (`gen-growing-graphs`, `gen-cubic-gra` — `formBond` with
  `agentA` wired and `agentB` → `targetAgent`); **`public/models/*.gcaproj` was deliberately NOT
  regenerated** — the shipped files keep loading through the migration.
- **Harnesses**: `verify-graph-rewrite` Tier J's fixtures moved to the wired Form Bond and gained a
  **retirement-migration block** (533 → **543** checks) asserting the node/handle rewrite, macro
  coverage, idempotence, and — the load-bearing one — that a MIGRATED legacy graph emits
  **byte-identical JS AND byte-identical WASM bytes** to the hand-authored Form Bond. ⚠️ That fixture
  WIRES `agentA` through a real edge rather than a `_port_agentA` config: the port carries no inline
  widget, so wiredness is the EDGE-map answer on all three targets, and a config-only value would
  leave the node on its self-form arm. `parity-agent-wasm` keeps both synthetics (renamed
  `[synthetic] Form Bond pair encoding …`), so the sign-vs-Rewire discrimination stays pinned.
- **Catalogue**: **150 selectable** node types (153 − 3 hidden macro), **53 agent**.

### G2 closed — the DIVISION BOND PARTITION

`divideAgent` split a mother's bonds between its two daughters purely **geometrically** (`sign(dot(offset, m̂))`). A graph-rewriting rule is *defined* by which EDGES go to which daughter, so geometry is exactly the thing a user cannot say. P5 lets the user **name** the partition, plus decision **D4** (the daughter–daughter bond policy). Runbook: [docs/HANDOFF_GRA_P5_DIVISION_PARTITION.md](docs/HANDOFF_GRA_P5_DIVISION_PARTITION.md).

**Scope correction the orchestrator made explicitly**: the flagship cubic oracle O6 no longer needs this — P4's queue + Create Agent in the behaviour graph express a triangle split as 5 queued ops with no division at all. P5's value is **typed biological division** ("give daughter A the *apical* bonds"), so it is deliberately small and declarative. **`byRule`** (a graph-authored per-bond callback inside the Division Event) is **explicitly DEFERRED** — the division ABI carries no request lanes and a request raised there lands a generation late.

#### The three modes + D4 ([dividePartition.ts](src/modeler/vpl/compiler/dividePartition.ts) — the ONE definition)
`DivideAgent.partition`: **`tension`** (the geometric split — **THE DEFAULT, and byte-identical to pre-P5**) · **`alternate`** (A, B, A, B… in SLOT order; deterministic, needs no attribute) · **`byBondAttribute`** (a named P2 bond attribute picks the daughter: **bool** false→A/true→B, **tag** = a per-OPTION A/B table [the shape the rule actually reads like], **integer/float** = `value < threshold` → A). `DivideAgent.daughterBond` (**D4**): **`auto`** (only when the mother was bonded — the pre-P5 rule, so no shipped model changes) · **`always`** (keeps a rewritten graph connected through every split) · **`never`** (the deliberate "split this node in two, disconnected" rewrite).
- **An unresolvable attribute DEGRADES to `tension` AND raises a `detectMissingConfig` badge** — the partition is never silently wrong. Both the spec builder and the engine apply the same rule (the engine's `store.bondAttrs[id]` lookup returns null for a bonds-off / deleted / hand-edited attribute).
- **D4 `always` still needs a bond store**: with the Bonds capability off `maxBonds === 0`, and asking for a bond there would make the capacity pre-check reject EVERY division instead of skipping a bond that cannot exist.
- **`daughterBond` is an explicit 3-way config, NOT an inferred default.** The handoff suggested defaulting it "on when the Graph-Rewriting capability shape is active"; there is no such capability flag, and a default that silently differs between two models is invisible magic. Explicit + `auto`-default guarantees no shipped model changes, and `never` turned out to be genuinely useful (the graph "split" rewrite).

#### THE TRANSPORT — a per-model TABLE on the EXISTING request cell, not a new lane
The partition lives on a **node's config** but is applied by the **ENGINE**, and a model may hold several Divide Agent nodes. The chosen shape reuses the `stopMessages` / `_stopIdx` precedent end to end: the compiler collects one entry per DISTINCT spec into a table, bakes the 1-based `_divideIdx` onto each node, every target emits `divideRequest[idx] = <code>` into the cell that already carried the 0/1 flag, and the table travels to the worker in the init/recompile message (`agentDividePartitions`). `runAgentStructuralPhase` looks the spec up by the code it read back.
- **This is a deliberate deviation from the handoff's §2.3 "add a `divideMode` lane" recommendation**, for three measured reasons. (1) **BYTE IDENTITY**, the phase's most important gate: `divideAxis*`/`divideAsym` sit in the MIDDLE of both `AGENT_F64_FIELDS` and `AGENT_GPU_F32_FIELDS`, so an unconditional lane shifts every later baked offset and diffs every agent model's WASM bytes + WGSL shader; a usage gate could avoid that, but only by adding a second gate mechanism — riding the existing cell costs *nothing*, since `1` is what the pre-P5 emitters already wrote. (2) The spec is **richer than a float** (a per-option tag vector + a threshold + the D4 policy); on WebGPU a lane is f32 (24-bit mantissa), so it would need fragile bit-packing. (3) Per-node fidelity is preserved either way. **A lane is still right for a genuinely PER-REQUEST value (a wired axis); the partition is per-NODE and constant.**
- **The table is MODEL-derived and key-SORTED**, and `assignDividePartitionCodes(nodes, model)` is called by **all three** agent front-ends (JS `compileAgentGraph`, both `flattenAgentGraph`s). So — unlike `_stopIdx` — the codes are **ORDER-INDEPENDENT and IDEMPOTENT**: they do not depend on the JS compiler running first (the parity harness compiles **WASM first**, which would have silently given WASM the wrong code under a first-encounter table). Scanning the model + every macro def mirrors `bondReqSlotsForModel`; over-counting an uninstantiated macro def only lengthens the table.
- **A model with ONE distinct spec — which is every shipped model — assigns code 1**, so switching a mode cannot move a byte of any target's output. **The mode lives entirely in the shipped table, never in the compiled artifact** (Tier H asserts exactly this).
- **WebGPU readback**: `divideRequest` is no longer a 0/1 flag, so `readbackAgentStep` **ROUNDS** it instead of clamping to 1 (`Math.min(255, Math.round(dr))` — the CPU array is a Uint8Array, and an out-of-range value would wrap modulo 256 and could alias a DIFFERENT spec).

#### The engine ([agentEngine.ts](src/simulator/engine/agentEngine.ts) `divideAgent`)
`divideAgent(..., partition = DEFAULT_DIVIDE_PARTITION)` — an OPTIONAL trailing param, so every existing caller (and the harness) reproduces pre-P5 semantics exactly. The mode only decides `sides[k]`; the **daughter PLACEMENT is always along the resolved axis** (the partition chooses which EDGES move, never where the daughters land), and the **capacity pre-check counts the RESOLVED partition's sides**, so every mode inherits the whole-or-nothing rule (**I5**) rather than only the geometric one. Bond attributes ride the existing bond snapshot untouched (**O9**).

#### Cascades + UI
`REMOVE_BOND_ATTRIBUTE` clears a Divide Agent's `partitionAttributeId` **and** its `partTag_*` table; a tagOptions rename/reorder **PERMUTES** `partTag_<i>` through the same `indexMap` the other tag consumers use (the table is keyed by OPTION INDEX, so a reorder would otherwise send the wrong bonds to the wrong daughter). CaNode renders the mode dropdown + the bond-attribute picker + the per-option A/B checkboxes (tag) or a threshold `InlineNumberInput` (integer/float) + the A–B-bond dropdown. **P2 UI gap closed in passing**: Get / Set Bond Attribute had NO attribute dropdown at all (bond attributes are a third id-space, so — like the field-bridge nodes — the picker must live on the node); a 3-line block was added alongside the new one.

#### Verification
- **`tension` byte-identical — the phase's most important gate, proven three ways**: `check-compile-identity` (26 models, every surface unchanged); a **HEAD-vs-patched ENGINE A/B in Node** over **1000 divisions** (mixed eigensolve + wired axes, asymmetric splits, interleaved breaks/deaths) — **every store field AND every bond attribute bit-identical**, negative-controlled (making `tension` silently behave as `alternate` is caught on the first agent); and a **same-session browser A/B** on `Morphogenesis - Growing Tissue` (WASM agents) via `git stash` — the growth curve, edge count **and** the summed agent x-positions to 6 decimals are IDENTICAL pre/post (`12/0 → 12/21 → 24/63 → 48/162 → 96/371 → 192/818 → 384/1737`).
- **`verify-graph-rewrite.mjs` Tier H** (180 → **230** checks): the spec builder (incl. the degrade + the badge); `alternate` asserted slot-by-slot; `byBondAttribute` on tag / bool / float asserted **by value**; D4 under all three policies + bonds-off; **I7 + O9 over 1000 divisions in EVERY mode** (the daughters' inherited (partner, attribute-tuple) multiset equals the mother's exactly, plus the A–B bond, with I1–I4 green at every division); **O4** — `N_t = N₀·2^t` and `E_t = E₀ + N₀·(2^t − 1)` EXACTLY for t = 1..8 in every mode (so a silent capacity rejection is caught); and the transport (table dedupe, canonical order, order-independence, all three emitters). **Every new invariant is negative-controlled**, five of them by MUTATING the shipped source and reverting: ignore the per-tag table → caught; `alternate` all-to-A → caught; ignore D4 → caught (5 checks); drop the attribute inheritance → caught (10 checks); force the default spec → caught (13 checks); the WASM emitter writing the pre-P5 literal → caught by parity.
- **Real worker, all three targets**: a 7-agent star (hub + 6 spokes, `w = self + partner` stamped on every bond) divides the hub with `byBondAttribute w < 4`. **JS, WASM and WebGPU produce the IDENTICAL partition** — daughter A holds partners 1,2,3 (w 1,2,3) + the A–B bond, daughter B holds 4,5,6 (w 4,5,6) + the A–B bond — with I1/I2/I3 green, 8 agents / 7 edges, the chip reading `agents WebGPU` (not clamped), and 0 console errors.
- `parity-agent-wasm` gained the permanent **`[synthetic] Division partition`** entry (two Divide Agent nodes on opposite branches ⇒ two DISTINCT codes) whose **value invariant** recomputes the expected code from the store — parity alone would pass happily if both targets emitted a constant 1, which is the pre-P5 literal and therefore the most likely way to get this wrong.
- tsc · build · `check-agent-wasm-gate` (11/11) · `audit-agent-layout` (156) · `test-agent-abi` (28) · `parity-agent-force` (7) · `verify-agent-render` · `verify-render-uniform-layouts` · `test-bonds-allocation` · `test-agent-capabilities` (76) · `test-cross-agent-writes` · `test-positional-collision` · `test-ndtable` — all green.

#### D2 — `conserve: 'area' | 'volume'` + the 3D `myVolume` output (branch `tasks_batch_2026_08`)

Phase **D2** of [docs/IMPACT_MAP_DIVISION_LIFECYCLE.md](docs/IMPACT_MAP_DIVISION_LIFECYCLE.md) (§3). **THE FACT IT FIXES, measured:** the split conserved **AREA in BOTH dimensions** (`rA = r·√f`, verbatim), so in 3D **~29 % of the volume disappeared at every symmetric division** — at `asym = 0.5` each daughter is `r/√2` and `VA + VB = 2·(1/√2)³·V = 0.707·V`. `DivideAgent.conserve` now says what the daughter RADII preserve: **`area`** (`rA² + rB² = r²` — **THE DEFAULT**, so every shipped model and every user file is untouched) or **`volume`** (`rA = r·∛f` ⇒ `rA³ + rB³ = r³`, ~12 % larger daughters).
- **3D ONLY, and the STATE is handled, not just the markup**: "conserve r³" is meaningless on a disc, so the CaNode row is **hidden** in 2D **and** `volume` is coerced to `area` **twice** — in `dividePartitionFromConfig` (it has the model, so a 2D model's spec/key/code are identical whatever the config says) and again in `divideAgent` on `D <= 1` (the last word, for a spec that reached the worker without a model). Measured: a 2D `volume` run is **bit-identical** to the area run.
- **TRANSPORT: the P5 partition TABLE, unchanged.** `conserve` is per-NODE and constant, exactly like the partition mode, so it rides `DividePartitionSpec` — **no new store field, no ABI field, no layout change, and NO emitter change on any of the three targets**; every emitter still writes `dividePartitionCode(config)` into the existing `divideRequest` cell, and the spec already travels in `agentDividePartitions`.
- **⚠ THE BYTE-IDENTITY MECHANISM — the suffix is CONDITIONAL.** `dividePartitionKey` appends `|volume` **only for the non-default value**, so an area spec produces the EXACT pre-D2 key ⇒ the key-SORTED table's order is unchanged ⇒ every 1-based code, every `_divideIdx` and every emitted byte is unchanged. (The impact map proposed appending `|area` to *every* key; that also preserves the order — no key can be a proper prefix of another, since all five fields are `|`-delimited and the last is one of three non-prefixing words — but leaving existing keys byte-untouched is strictly stronger and makes the claim decidable by inspection. A collision is impossible either way: a volume key ends `|volume`, an area key ends in its `daughterBond` word.)
- **`myVolume`** ((4/3)πr³) joins **Behaviour Step** and **Division Event**, `hiddenPorts`-gated on 3D — *"conserve volume" with no way to read volume is a half-feature*. **⚠ It is the ONE root value-out that is USAGE-GATED on JS** (`rootPortConsumed`, scanning the flattened edge list): every other port predates the byte-identity gate and is emitted unconditionally, so an unconditional new preamble line would diff every 3D agent model's `agent.behaviourCode` / `agent.divisionCode` for a value nobody reads. WASM + WGSL are per-port emitters and gated by construction. In 2D a **stale** edge (a model authored in 3D, then switched) resolves to the typed default **0 on all three targets** — the C9 `myAge` safety-catch shape, one step stronger than the `myZ` precedent, which emits nothing and leaves the reference dangling.
- **`myArea` is the agent's extent in the model's OWN dimension (SUPERSEDES the D2-era "stays πr² in 3D" call, reversed by user decision 2026-08-25)**: the disc area **πr²** in 2D (byte-identical emit — non-negotiable) and the **SPHERE SURFACE area 4πr²** in 3D, on both roots (behaviourStep on all three agent targets via `areaExpr` in compile.ts / the agentWasm + agentWebgpu emitters; divisionEvent JS-on-CPU). `myVolume` stays (4/3)πr³. **The JS↔WASM association order is mirrored exactly** (`PI [,4], r, MUL, r, MUL`) — fixing a LATENT parity bug where the old WASM `(r*r)*PI` folding was bit-different from JS's `(PI*r)*r` on ~35 % of radii (never shipped: **no shipped model reads `myArea`**, so no WASM bytes ever carried it — which is also why no threshold rescale was needed; the only compile-identity diffs are the two 3D agent models' JS surfaces, each a provably-dead unconsumed preamble const). Guarded by two permanent `parity-agent-wasm` synthetics (3D 4πr² + 2D πr² value invariants, negative-controlled incl. the both-targets-drop-the-4 case only the invariant catches) + a `verify-graph-rewrite` myArea tier (all 3 targets × both dimensions). **No `Get Area` / `Set Area` nodes** (an area is Get Radius + one Math node; setting one is `sqrt(A/π)` → Set Agent Radius) — the anti-bloat rule.
- **Verification.** `check-compile-identity` **31 models, ALL surfaces unchanged** (now including the two D1 surfaces). `verify-graph-rewrite` **Tier H 612 → 639**: the literal pre-D2 key asserted as a hard-coded string; the resolver's 3D-honour / 2D-coerce / unknown-value arms; the ENGINE through the SHIPPED `divideAgent` — symmetric volume `rA = rB = r·∛0.5` and `rA³ + rB³ = r³`, the default area split `rA² + rB² = r²` **keeping only 1/√2 = 70.7 % of the volume**, an asymmetric `f = 0.3` split, the 2D bit-identical coercion, and a **NEG** proving the two modes give different radii; the transport (two conserve-only-different nodes ⇒ two entries + different codes, while a single-node model's JS **and WASM bytes** are identical either way); and the `myVolume` gate on all three targets. `parity-agent-wasm` gained **`[synthetic] Division conserve (area vs volume codes + 3D myVolume)`** — a 3D model whose two Divide Agent nodes differ ONLY in `conserve`, with per-agent DISTINCT radii so its **VALUE invariant** recomputes (4/3)πr³ from the store. **Negative-controlled three ways**: a WASM-only `/3 → /2` fails PARITY; the same wrong formula on BOTH targets passes parity and is caught only by the INVARIANT; dropping the key suffix collapses the two codes and is caught by the invariant. Direct-engine 3D run at `r = 2.5`: volume ⇒ `rA = rB = 1.984251314960`, `rA³+rB³ = 15.625000000000 = r³`; area ⇒ `1.767766952966`, `rA²+rB² = 6.250000000000 = r²` with `rA³+rB³ = 11.048543456040 = 0.7071·r³`; `f = 0.3` ⇒ `1.673582375205 / 2.219760004357` (= `r·∛0.3` / `r·∛0.7`) summing to exactly `r³`.

#### D3 + D4 — the Division Event configures BOTH daughters, and can BOND them (branch `tasks_batch_2026_08`)

Phases **D3 + D4** of [docs/IMPACT_MAP_DIVISION_LIFECYCLE.md](docs/IMPACT_MAP_DIVISION_LIFECYCLE.md) (§2.3 Design C, ADOPTED). **THE GAP THEY CLOSE:** at the Divide Agent node's flow position the daughters *do not exist and may never exist* (a division can be rejected whole — invariant I5), so the request "give me references to the two daughters" is unanswerable there; the moment where everything the user wants IS expressible is the **Division Event**, which runs AFTER `divideAgent` has committed — both daughters alive, both ids known, graph settled. What it lacked was (a) the identity of the OTHER daughter and (b) the ability to issue structural requests. Both are cheap because **the division root is JS-on-CPU on every agent target** (`AGENT_WASM_CPU_ROOT_TYPES`; the WebGPU agent compiler compiles the behaviour root only), so the `division` ABI has exactly TWO mirrors — `buildDivisionParams` and the worker's `buildDivisionArgs` — and **no WASM bytes and no WGSL are involved**.

- **D3 — `siblingId`.** One value output on Division Event = the OTHER daughter's slot id (`runDivisionEvent` already held `{mother, a, b}`), so ONE invocation can set BOTH daughters by id — the strict `_alive[__sa]` guard the division root emits is satisfied, because both daughters are alive by then.
- **D4 — the structural REQUEST QUEUE on the `division` kind + a SECOND drain.** The `loop` kind's queue block (`_bondFormReq` / `_bondFormL` / `_bondFormK` / `_bondBreakReq` + one `_bondFormAttr_<id>` per bond attribute) is added to `division`, and `runAgentStructuralPhase` runs **`drainAgentBondRequests` a second time immediately after `runDivisionEvent`** — so **a daughter can be bonded to a THIRD PARTY in the generation it is born**, the one edge the agent tier could not express (P5's partition only redistributes the mother's EXISTING bonds; `daughterBond` only adds the A–B edge; the workaround was to flag the daughter and bond one generation later — exactly the transient-intermediate-state problem GRA rules exist to avoid).
- **⚠ IT ALSO CLOSES A LATENT FOOTGUN.** No gate stopped a Form Bond being placed in a Division Event before this (`AGENT_SELF_ONLY_TYPES` lists the bond verbs for the **init/spawner** roots only), and the JS emitter happily emitted `_bondFormReq[…]` — a reference the division signature did not carry, so the fn threw at runtime, `agentDivisionFn` was **nulled**, and every later division event was silently skipped. D4 makes it WORK; the alternative was a refusal badge. Leaving it as it was is the one option that is wrong.
- **THE SECOND DRAIN IS SAFE BY CONSTRUCTION, and each reason was VERIFIED in the engine, not assumed.** (1) `drainAgentBondRequests` **ZEROES an entry's two lanes immediately after reading them, BEFORE decoding** (`s.bondBreakReq[base+c] = 0; s.bondFormReq[base+c] = 0;`), so a second pass re-applies nothing and picks up only what the events queued. (2) Both daughters' queues are **provably empty** when their event runs — daughter A's is the mother's, drained in structural step 1; daughter B's was cleared by `initAgentSlot` → `clearAgentBondRequests`. (3) **I5 is inherited per op** (formBond / breakBond / rewireBond / transferBond are each whole-or-nothing) and the overflow bucket is still applied by nobody. (4) **No layout change**: `bondReqSlotsForModel` scans `model.agentGraphNodes` UNSCOPED, so a queue verb in a Division Event already sized the queue.
- **BOTH GATES ARE SYMMETRIC — do NOT copy `_generation`'s pattern here** (Impact Map §5.3). `_generation` is param-gated but ALWAYS passed, which the worker's DEV arity assert tolerates as `params ∈ {args − 1, args}`; a second always-passed-but-param-gated field would widen that to `args − 2` and weaken the check. So `usesDivisionSibling` / `usesDivisionRequests` gate the **param side AND the arg side**: the compiler derives them from the model, **SHIPS** them in the init/recompile message (`agentUsesDivisionSibling` / `agentUsesDivisionRequests` — the `agentBondReqSlots` / `agentFieldGates` discipline; the worker keeps no model and never re-derives), and D4's flag additionally gates the second drain. The arity assert stays exact.
- **[divisionUse.ts](src/modeler/vpl/compiler/divisionUse.ts) is the ONE source of both predicates**, and its two rules are load-bearing. **(a) The scope is the DIVISION SUBTREE, never the whole agent graph** — reachability over the model's own edges (flow edges OUT of a reached node + value edges INTO one, the `targetDiagnosis.behaviourReachedIds` walk), because every shipped GRA model rewrites bonds in its BEHAVIOUR step and may also carry a Division Event; a whole-graph scan would hand those models a queue block they never use and diff their `agent.divisionCode`. **(b) It is a SUPERSET, deliberately** — a reached macro instance contributes its WHOLE body (what `expandMacros` produces) and a macroDef that itself holds a `divisionEvent` is scanned wholesale, because the compiler emits the `siblingId` alias / the `_brqC` cursor from the SAME predicate: `true`-but-unused costs one dead `const`, while `false`-but-used emits an undeclared identifier.
- **ABI PLACEMENT:** both blocks are appended **after the 3D block and BEFORE `_generation`** (which stays dead last on every kind), in the order `__siblingId` → queue block. The division fn is SINGLE-agent, so its `_brqC` cursor is one `let` at the top of the fn — each invocation (once per daughter) starts at slot 0 of its own agent's provably-empty queue. `audit-agent-layout` learned to strip both blocks like it strips `_generation` before the "2D is a strict PREFIX of 3D" comparison, plus a new (stronger) claim that the trailing gated block is IDENTICAL in 2D and 3D.
- **The overflow notice is disambiguated** (§5.7): the second drain says *"Bond request queue full during division events"*, since the same sentence twice in one step reads as a bug and the two passes have different causes.
- **Verification.** `check-compile-identity` **31 models, ALL surfaces unchanged** (`agent.divisionCode` included, thanks to D1 — no shipped model wires `siblingId` or issues a bond request from a Division Event, so both gates resolve false everywhere). `tsc` clean. `verify-graph-rewrite` **643 → 699** via a new **Tier Q** (56 checks): the gate; the emit; the **headline** — a division event's Form Bond bonds BOTH daughters to a third party in the SAME generation with I1–I4 green immediately after, plus a negative control showing that WITHOUT the second drain the request is queued and never applied; **D3 by value** (each daughter reads the other's id, uninvolved agents untouched) and **as an address** (Form Bond → `siblingId` bonds the pair); **I5** over a capacity rejection (the graph is EXACTLY the post-division graph, not one slot moved, the entry still consumed, a probe behind it still applies); **THE NEGATIVE CONTROL** that the second drain re-applies nothing, with a hand-built control proving the check discriminates; multiple divisions in one generation; and **the cross-target arm** — a real instantiated WASM behaviour module over a wasmBacked store produces the **IDENTICAL bond graph + sibling ids** as the JS behaviour (same JS division fn, same drains), while the WebGPU shader compiles, passes its gate and carries **no** division-root code. **Proven failable by SOURCE MUTATION**: deleting the drain's entry-zeroing fails 4 Tier-Q checks by name (23 harness-wide). `test-agent-abi` **629 → 1048** via a **Tier 4** sweeping all four gate combinations × 2D/3D × ±bond attributes against an INDEPENDENT expected tail, plus the scope claims (a behaviour-chain bond verb does NOT widen the division ABI; a reached macro DOES) and source invariants on the worker's shipped-flag plumbing, the second drain's gate, and that there are **exactly two** drains. `audit-agent-layout` **347 → 443** with a synthetic pair that USES both blocks (so the new strip is non-vacuous — reverting it fails exactly 2 checks). `parity-agent-wasm` all entries green (the division root is CPU-only, so parity is deliberately not its gate).
- **⚠ NOT verified in a browser this session** (the Chrome tooling was unreachable): the end-to-end run used the Node harness idiom instead — the SHIPPED engine primitives replaying the worker's structural-phase order with the SHIPPED compiled fns, per agent target. A real-worker browser pass is worth doing when the tooling is available.
- **STILL DEFERRED** (Impact Map §2.1/§2.2): **Design A — staged daughter handles is REJECTED**, not deferred (daughter A IS the mother slot, so by-handle writes cannot be rolled back on a rejected division — I5); **Design B — per-daughter payload ports** is deferred (sound but expensive: N attrs × 2 daughters × maxAgents lanes on three layouts, and it structurally cannot express "bond daughter B to X", which C2 now can).

#### D1 — `check-compile-identity` now hashes the DIVISION and AGENT-INIT code
A prerequisite, and a real blind spot: the gate hashed `agent.behaviourCode` / `agent.wasm.bytes` / `agent.webgpu.shader` / `agent.webgpu.om` but **not** `agent.divisionCode` and **not** the agent init code — and those two are **JS-on-CPU on every agent target** (`AGENT_WASM_CPU_ROOT_TYPES`), so they appear on no other surface. A regression in the whole `division` / `init` ABI passed the project's primary byte-identity gate silently. `compileAll` now returns both and the script hashes them (`agent.divisionCode` / `agent.initCode`). Non-vacuous on the shipped library: **2 models carry a Division Event** (Morphogenesis — 3D Tissue / Differential Tissue) and **7 carry an Agent Init Event**. **An OLD baseline stays usable** — `--compare` iterates the baseline's own keys, so the new surfaces are simply absent there.

### The measurement layer — graph indicators + the Overseer rule-space sweep

The MEASUREMENT half of the GRA research loop. The mechanism lives in the **"Graph Indicators"** subsection of the Indicators chapter above (schema, metrics, cost, freshness, the `kind`-consumer sweep); this section records the phase's sample, its findings and its verification. Runbook: [docs/HANDOFF_GRA_P6_GRAPH_INDICATORS.md](docs/HANDOFF_GRA_P6_GRAPH_INDICATORS.md). **Zero compiler change** — `check-compile-identity` reports 26 models byte-identical on every surface.

#### The sample — `Graph Metrics - Growth Sweep` ([scripts/gen-graph-metrics-sweep.mjs](scripts/gen-graph-metrics-sweep.mjs))
Sixteen seed agents; each step every agent rolls Bernoulli(p) AND looks its own bond degree up in a 1-axis **rule table**, dividing when both agree (`daughterBond: always`). A division therefore adds exactly one node and exactly one edge and nothing ever joins two lineages, so the model carries **three structural laws the indicators read back directly**: `E = N − 16`, `componentCount ≡ 16`, and `E[N_t] = 16·(1+p)^t`. All six metrics are declared, so the simulator charts the whole measurement surface live. The Overseer graph is the research protocol in two phases — **A** the growth law (Randomize at density 1.0 ⇒ every degree may divide ⇒ p is the only factor; 20 replicates of Reset → Run 40 → Collect N) and **B** the rule sweep (16 seeds × Randomize at density 0.5 → Reset → Run 40 → Collect N/E/mean degree/components), exportable as CSV.

#### Two findings worth carrying forward
- **A reproducible experiment needs a reproducible INITIAL CONDITION.** `seedPattern: 'scatter'` USED to place seeds with **`Math.random()`** ([sim.worker.ts](src/simulator/engine/sim.worker.ts) `initAgents`) — that was the P6/P7 finding, and **C7 FIXED it**: scatter now draws from the shared seeded stream, so `setRngSeed(S)` + Reset reproduces the layout exactly (see "Determinism — every simulation-semantic draw is seeded"). The finding's REASONING still matters and is why this model ships `compact`: a rule that reads **bond degree** is geometry-coupled (degree comes from the division bond-partition, computed from the TENSION AXIS, i.e. from positions), so an initial condition that varies at all varies the result. **Measured at the time**: with the then-unseeded `scatter`, Phase A (a degree-INDEPENDENT rule) reproduced exactly across runs while Phase B did not; with `compact` (a deterministic lattice) two full runs export **byte-identical CSV**. Post-C7 either pattern reproduces under a fixed seed; `compact` additionally does not consume the stream, so it is still the simplest thing to sweep over.
- **Sweep on JS/WASM, not the WebGPU agent target.** The Overseer's seed policy drives `setRngSeed`, which re-seeds the shared xorshift32 stream JS and WASM use. The WebGPU agent target's per-agent PCG is seeded ONCE at runtime creation (`seedAgentRng(rt, 0x1234abcd)` in [agentWebgpuRuntime.ts](src/simulator/engine/agentWebgpuRuntime.ts)) and `setRngSeed` never reaches it, so a WebGPU-agent experiment does not reproduce across two presses of Run Experiment. Hence the sample's `agentTarget: 'wasm'` — a deliberate, documented exception to the library's WebGPU-where-gated-in policy (both gates DO accept the model). **Since C5 this fact IS the reproducibility contract** (see "The declared reproducibility contract"): a model declaring `exact` has Auto keep its agents on a CPU engine for exactly this reason, and the Experiments panel states the resulting methodology. NB the same is NOT true of the WebGPU **grid**, whose per-cell streams `setRngSeed` does re-derive — which is why `GoL Replicate Statistics` ships a grid Overseer sweep on WebGPU.

#### Verification
- **`verify-graph-rewrite.mjs` Tier I** (230 → **297** checks): all six metrics compared against **independently written** references over 8 graph shapes (ring, ring+chords, star, isolated, two disjoint K4, a holed store with killed agents, a seeded random graph, the empty population) — `refComponents` is a **BFS flood fill**, deliberately a different algorithm shape from the shipped union-find; the `getState`-payload path gives identical numbers; `edgeCount == Σdeg/2 == |distinct pairs|` with I1 green on every fixture; a **fragmenting graph** 1 → (one bridge cut) 1 → (both cut) **2** → (re-joined) 1 → (cut vertex killed) 2, plus a `NEG: the metric is not a constant 1`; the pass counters (zero requested ⇒ no passes; nodeCount alone ⇒ none; componentCount alone ⇒ union-find only; the four degree metrics ⇒ ONE shared pass); four data-level negative controls; and **seven SOURCE-MUTATION negative controls** on `graphMetrics.ts` (drop the /2, drop the alive check, latch the first max degree, divide by highWater, never decrement the union-find, union across a dead partner, drop the last histogram bucket) — each rebuilt in isolation and each CAUGHT.
- **Cost, measured**: 20 000 live agents / 46 247 edges ⇒ degree pass **0.87 ms**, `componentCount` **2.07 ms**, all six **1.77 ms** — and still exact against the BFS reference at that scale.
- **Real worker, exactness**: after 30 generations the `stepped` payload's six values match a page-side independent recount from a `getState` payload with **0 diffs** (N=77, E=61, mean 1.5844, max 4, histogram summing to N, components 16), handshake lemma holding.
- **Real UI**: all six render in the simulator with the `G` badge (scalars as sparklines, the histogram cycling Bars → **Lines** → Stack through the existing chart code); the Modeler's "+ Graph" button creates one and its Graph Metric dropdown cycles through all six with per-metric hints; a metric created mid-session reaches the worker through `updateIndicators` and reports the same value as its twin. 0 fresh console errors on a clean load.
- **O10 through the real Overseer panel**: 20 replicates, mean N₄₀ = **121.65**, std 25.744 → 95% CI **[110.37, 132.93]**, and the theoretical `16·1.05^40 = 112.64` is **inside** it (the branching process's theoretical sd ≈ 24.8 also matches the observed 25.74).
- **Sweep reproducibility**: two full presses of Run Experiment export **byte-identical CSV** (85 rows, 0 diffs) covering both phases; the 16-seed table spans N = 28..184 with `E = N − 16` and `components = 16` in **every** row.
- **Zero cost when unused, demonstrated**: Boids (an agent model with a live store, no graph indicator) ran 200 generations over 40 batches and `__graphIndicatorStats` reports `calls 0, degreePasses 0, componentPasses 0`.
- tsc · build · `check-compile-identity` (26, unchanged) · `parity-agent-wasm` · `check-agent-wasm-gate` (12/12) · `audit-agent-layout` · `test-agent-abi` · `verify-agent-render` — all green.

### The flagship samples

**TWO shipped library models — `SDCA` and `Growing Graphs`. `Cubic GRA` was retired from the
library (2026-08-05); its generator is kept and its design record below stands.** All are
agents-only, synchronous, and carry graph indicators;
all compile and run on **all three agent targets** (their generators are
[scripts/gen-cubic-gra.mjs](scripts/gen-cubic-gra.mjs), [scripts/gen-sdca.mjs](scripts/gen-sdca.mjs)
and [scripts/gen-growing-graphs.mjs](scripts/gen-growing-graphs.mjs), and the harness's Tiers L/M
load the generated `.gcaproj` directly).

#### `Cubic GRA` — a 3-regular graph that rewrites itself while STAYING 3-regular

**RETIRED FROM THE SHIPPED LIBRARY (2026-08-05)** — the author removed the `.gcaproj`;
[scripts/gen-cubic-gra.mjs](scripts/gen-cubic-gra.mjs) still regenerates it. The design record
below is kept because the milestone's verbs, invariants and layout rules were derived here.

**THE OPERATION SET IS OURS, and the model says so.** The lineage (Suzudo; Tomita, Kurokawa
& Murata) is canonically 3-regular with degree-preserving operations, but the exact
operation sets in those papers are **not** reproduced — the Impact Map §6.2 mitigation is
structural: we define our own cubic-preserving set and test against invariants true of ANY
cubic graph. **Never claim faithfulness to a specific paper for this model.**

| op | effect | ΔN | ΔE |
|---|---|---|---|
| **triangle split** — `v(a,b,c)` → `v₁,v₂,v₃`, `v₁–a`, `v₂–b`, `v₃–c` + the triangle `v₁v₂v₃` | each new node: 1 external + 2 triangle = deg 3 | +2 | +3 |
| **idle** | — | 0 | 0 |

- **The split is FIVE queue ops in ONE generation** at a TIGHT `maxBonds: 3` — 2 Rewire Bond
  + 3 paired Form Bond (Create Agent / Add Agent To World are host calls consuming no queue
  slot). The peak degree during the drain is exactly 3, which is itself the proof that
  nothing transiently over-bonds. `E = 3N/2` survives because `3N/2 + 3 = 3(N+2)/2`.
- **THE EDGE SWAP IS ABSENT, AND THAT IS A REAL FINDING, NOT AN OMISSION.** A degree-neutral
  double-edge swap requires an agent to BREAK an edge between two OTHER agents, and there is
  no such verb: Break Bond and Rewire Bond are self-relative, a paired Form Bond only ADDS,
  and every zero-ΔE combination of the available verbs that also leaves every degree
  unchanged is a no-op. **The missing dual of the paired Form Bond (`Break Bond Between`, plus
  2-hop bond visibility) would close it** — see the deferred list in the P7 report.
- **THE RANDOM-PRIORITY GATE IS LOAD-BEARING, not decoration.** Two ADJACENT agents must
  never rewrite in the same generation: the mother's Rewire needs its edge to `b` to still
  exist when the queue drains, and a splitting `b` would have re-pointed it away. So every
  agent rolls a fresh random priority into an agent attribute each generation, and only an
  agent whose STORED priority is strictly below every bonded neighbour's may rewrite. Strict
  inequality cannot hold both ways ⇒ the rewriters are pairwise **non-adjacent for ANY
  priorities** — the guarantee needs only that everyone reads the same generation's values,
  which synchronous update gives for free. NON-adjacent rewriters provably never conflict:
  each one's Rewire-break precedes its own Form Between on the same shared neighbour, so
  that neighbour dips to 2 and returns to 3 without ever exceeding `maxBonds`. The same roll
  doubles as the rate knob (`priority < Split Rate`). **Negative-controlled in Tier K**:
  forcing the gate true makes the graph stop being cubic.
- **The K4 bootstrap lives in the BEHAVIOUR graph, gated on `myBondDegree == 0`** — Form Bond
  writes the request queue at the acting agent, so it is invalid in the Agent Init Event. A
  newborn already has degree 3 by its first behaviour step, so the branch runs exactly once.
  The four seeds alternate state by handle parity: K4 is vertex-transitive, so without a
  symmetry break a deterministic rule keeps them identical forever and nothing happens.
- **The rule is TWO 8-cell tables**, both keyed by `[own state] × [Active neighbours 0..3]`
  (axis 0 is a `tagAttribute` axis bound to the AGENT tag attribute): a **verb** table
  (tag-valued: Idle / Split A / Split B / Split C — the letter names which incident edge the
  mother keeps) and a **next-state** table. Both carry a seeded `tableRoll` so Randomize
  rolls a new automaton. **A hand-written table's first failure mode is an ABSORBING
  configuration** — `[Dormant, 0] → Dormant` makes the all-Dormant state a fixed point and
  the automaton never rewrites again; the shipped table maps it to Active.
- **The population guard is load-bearing for O6.** At the agent cap `createAgent` returns −1,
  the split's Rewire finds no target and degrades to a bare break, and the graph stops being
  cubic. An **end condition** pauses at `nodes >= 3000` against `maxAgents: 6000` — a 2×
  margin the fastest possible growth cannot cross in one generation (verified in-app: Play
  auto-paused at gen 25 / N = 3046 with Split Rate forced to 1). The Overseer sweep uses
  `ovRunUntilStop`, which respects it, so a blow-up rule is CLASSIFIED rather than fatal.
- **`agentTarget: 'wasm'` is a documented exception** to the library's WebGPU-where-gated-in
  policy, inherited from P6: the Overseer seed policy drives `setRngSeed`, which re-seeds the
  shared xorshift32 stream JS and WASM use, while the WebGPU agent target seeds its per-agent
  PCG once at runtime creation — a WebGPU sweep would not reproduce. Both gates ACCEPT the
  model; only the sweep's reproducibility motivates the choice.
- **THE LAYOUT (L3) — three independent causes, all measured, all fixed.** Grown to N = 2000
  at the model's own parameters, on the LIVE state (no free settle): **nnb/bond 0.10 → 0.67,
  overlap 99.6 % → 0.0 %**. In the real browser at N ≈ 2500: **0.15 → 0.749** and
  **99.5 % → 0.00 %**, at **2.8× the generations per second** (29.4 → 10.6 ms/generation).
  1. **CHARGE ON, `k = −10`, cutoff `20` = 4 × bond rest.** **STRENGTH IS A CHEAPER LEVER
     THAN REACH**, measured: the spatial-hash bin edge IS the cutoff, so doubling reach
     quadruples the candidates the 3×3 stencil sweeps, while raising `|k|` costs nothing. A
     4×-rest cutoff at −10 matches an 8×-rest cutoff at the default −3 on layout quality
     (settled nnb/bond 0.72 vs 0.73) and runs **2.6× faster** (15 vs 40 ms/generation at
     N = 2500). The Impact Map's "quality saturates by ~8× rest" sweep held `k` at −3; this
     is the SECOND axis of that surface, not a contradiction of it.
  2. **THE WORLD IS SIZED TO THE AGENT CAP, not to today's population**:
     `side = ceil(sqrt(maxAgents × (rest × 1.45)²))` → **600** (1.45 = the measured settled
     bond/rest under charge). The old 220 × 220 left 4.6 units per node against a bond rest
     of 5 — SATURATED, and no repulsion strength can open a box with no room in it.
  3. **CADENCE + NEWBORN PLACEMENT.** The WHOLE rule (priority roll, state, rewrite) hangs
     off ONE **Agent Periodic Step at period 2**, so the generation in between is pure relaxation
     and state can never drift out of phase with structure — gating only the rewrite would
     quietly build a DIFFERENT automaton. Period 2 is the measured knee: 1 / 2 / 3 / 4
     relaxation passes per rewrite give live nnb/bond 0.59 / 0.65 / 0.68 / 0.71, and every
     further pass costs a full force pass. Newborns start at the torus-shortest **MIDPOINT**
     between the mother and the neighbour they inherit (Get Agent Position in RELATIVE mode,
     so it is correct across a seam — hand-subtracting two absolute reads is not) instead of
     at a fixed offset; on its own that moves live nnb/bond **0.47 → 0.59**.
  **A generation is NOT a rule step in this model.** The Overseer budget is stated in
  GENERATIONS (`T_RUN = 120 × PERIOD`), and `verify-graph-rewrite`'s Tier K reads the period
  off the shipped file and scales its own budgets by it, so a future cadence retune cannot
  silently shorten the headline O6 check.
- **The rule graph uses `expression`, not chained `arithmeticOperator`** (L3): 10 Math nodes
  → 7 Expressions. A PURE refactor — `(verb - 1 + 1) % 3` is the five-node chain written as
  itself. O6 still holds at EVERY one of 440 generations (220 rule steps).

#### `SDCA — Couplers and Decouplers` — Ilachinski & Halpern's dual coupling

The model that shows **why bond attributes exist**. A value rule *plus* a link rule, each
feeding the other: `σᵢ' = f(σᵢ, #On in the bonded 1-ring)` and
`λᵢⱼ' = ψ(λᵢⱼ, σᵢ, σⱼ)`, the link rule splitting into COUPLERS (Form Bond) and DECOUPLERS
(Break Bond).

- **The link value λ IS a float BOND attribute** — an exponential moving average of the pair
  drive `d = Drive + AgreementBonus·(σᵢ == σⱼ)`, so the link has MEMORY and a well-driven
  bond survives a dip. A newly coupled link is born carrying its drive through **Form Bond's
  per-bond-attribute initial-value port**.
- **The Nowotny–Requardt hysteresis band**: couple when `d > λ₂`, decouple when the link
  value falls below `λ₁`, with `λ₂ ≥ λ₁` — the interval between them is a DEAD BAND. Drive
  the density up across λ₂ and back INTO the band and the edge turns on once and stays on.
- **⚠️ THE SINGLE-BUFFERING CAVEAT, DOCUMENTED (not fixed here).** AGENT attributes are
  double-buffered under synchronous update, so the value rule is a true synchronous CA. **BOND
  attributes are SINGLE-buffered on all three targets** (P3's standing decision), so a link
  write IS visible to a later reader in the same generation. Both endpoints here compute the
  SAME link value (the rule is symmetric in i and j — the canonical SDCA form), so the two
  stored copies never disagree and **I2 holds**; the only observable consequence is that the
  moving average is applied TWICE per generation per bond, once from each endpoint, i.e. the
  effective rate is `1−(1−r)²`. The fixed point is unchanged. Making bond attributes
  synchronous is an **all-three-targets change of its own** — do not schedule the GPU half.
- **The population is spawned from the Agent Init Event**, not by `seedPattern: 'scatter'`
  (which at the time sat outside the replayable stream — C7 has since seeded it): a Loop over Create
  Agent → Add Agent To World → a by-id Set Attribute draws positions AND the initial states
  from the shared xorshift32 stream, so the whole initial condition is reproducible.
- **`agentTarget: 'webgpu'`** — the library policy, both gates accept, no sweep to reproduce.
- **THE LAYOUT (L3): the same charge rule as the flagship, but the ENGINE knob instead of
  cadence.** Charge on at `k = −10`, cutoff `28` = 4 × bond rest; the world sized to the cap
  by the shared rule (`ceil(sqrt(400 × (7 × 1.45)²))` → **220**, was 110, i.e. 55 units² per
  agent against a need of ~103 — the couplers were choosing partners inside a jam). **And
  `layoutIterations: 2` rather than an Agent Periodic Step — the split is deliberate.** A GROWING
  graph must outrun its own rewriting, which is rule semantics, so the flagship uses cadence;
  SDCA has a FIXED population that simply needs to settle, which is solver relaxation, so it
  uses the engine knob and keeps one generation meaning one rule step (its hysteresis band is
  a per-generation property, and its own rate semantics already live in the rule as Link
  Rate). Between them the two samples demonstrate both halves of the milestone — and because
  SDCA runs on the WebGPU agent target, it is also the shipped model that exercises the new
  GPU relax-commit pass.
- **The rule graph uses `expression`, not chained `arithmeticOperator`** (L3): 9 Math nodes
  → 5 Expressions, including `lambda + rate * (d - lambda)` written as the formula the Rule
  Description states. PURE: `(d-λ)*rate` and `rate*(d-λ)` are bit-identical (IEEE
  multiplication is commutative) and `drive + agree * bonus` binds as the chain did. O8 and
  I1–I4 still hold at every one of 500 generations.

#### `Growing Graphs` — Paul Cousin's binary cubic GRA, ported from znah's demo

A port of **Alex Mordvintsev's (znah) "Growing Graphs"** demo (znah.net/graphs) of **Paul
Cousin's** binary cubic Graph-Rewriting Automata, with that demo's FULL published rule
catalogue — its 12 NAMED presets plus the 11 further rules of its `rules` dropdown, which ship
as `Rule <n>` (23 presets: named first in znah's order, then numbered ascending). Generator:
[scripts/gen-growing-graphs.mjs](scripts/gen-growing-graphs.mjs); the reference implementation
is `js/graph.js` (80 lines) + `js/app.js` in the `graphs-main` tree. **Credit the lineage in
this order — Cousin defines the automata, Mordvintsev's demo is what this reproduces — and
never claim more fidelity than the measured result below.**

- **THE WHOLE AUTOMATON IS ONE 16-BIT INTEGER**, and the two rule tables ARE that integer,
  bit for bit: `r = own*4 + (ON neighbours)` (r ∈ 0..7), `nextState = (R >> r) & 1`,
  `divide = (R >> (r+8)) & 1`. Both tables are 2×4 over `[own state intRange 0..1] ×
  [ON neighbours intRange 0..3]`, and **row-major means the flat cell index IS `r`** — so a
  preset is just `R` sliced into two 8-entry bool arrays, with no translation layer. Verified,
  not assumed: Tier M asserts `resolveAxes(...).strides === [4, 1]` on both tables (a
  transposed table would silently address a different rule) and re-derives every preset's
  cells from its stated rule integer.
- **LATCH + MULTI-ROUND DRAIN — the reference's division semantics, and the reason the port is
  now faithful for EVERY rule.** znah's phase 0 LATCHES the divide bits; its phase 1 walks that
  latch array and divides **every** flagged node, sequentially, each one reading the **LIVE**
  adjacency (`reconnect` mutates a partner's list, so a later splitter sees the updated
  neighbourhood). A latch is consumed exactly once and newborns never divide in the same tick
  (`dividing.length` is frozen at the tick boundary). GenesisCA's structural request queue
  drains in PARALLEL and two ADJACENT splitters corrupt each other (the mother's Transfer needs
  its edge to `b` to still exist at drain time), so one generation can only split an
  INDEPENDENT SET. The model therefore spends **PERIOD = 1 + K generations per reference tick**:
  an Agent Periodic Step at phase 0 does census → next state (+ mutation) → **latch**, then K
  **DIVISION ROUNDS** each split the still-latched winners and CLEAR their latch, so the losers
  win a later round *against the adjacency the winners just rewrote*. That IS znah's
  mutated-adjacency drain, executed in rounds instead of index order.
- **K = 8, CHOSEN BY MEASUREMENT — RE-MEASURED after the priority became the HANDLE** (all 18
  mutation-free published rules × 100 reference ticks, through the real compiled behaviour):
  leftover latches **29.30 % at K=1 → 6.33 % (K=2) → 0.23 % (K=4) → 0.00 % (K=6)**, and
  **K=16 never uses a seventh round**, re-confirmed at the 10 000-node cap over 120 ticks
  (55 039 latches). Rules matching the reference: **9/18 (K=1) → 15/18 (K=2, K=4) → 18/18
  (K≥6)**. **The worry that motivated the re-measurement did not materialise**: a deterministic
  ascending order could in principle line up a DESCENDING chain of flagged neighbours and drain
  one per round, but handle order in fact needs SHALLOWER drains than the random roll did
  (**6 rather than 8**) — unsurprising, since ascending handle IS the order the reference
  divides in. **K stays 8** (not the measured 6) so the drain carries a margin of two for a rule
  nobody has rolled yet, and so PERIOD stays 9 — the cadence the layout's force-pass budget and
  the measured world extent were both established against. **⚠️ That table was measured against
  the REWIRE split and no longer holds — see the Transfer bullets below: with the faithful slot
  order the drain does not finish at ANY K, so Tier M asserts a leftover RATE rather than zero
  and K stays 8 because raising it does not help.** `LAYOUT_ITERATIONS` is 1: the layout gets 9 force passes per reference tick at a third of the
  per-generation cost of the old 2×3 cadence.
- **THE LATCH *IS* THE PRIORITY, AND THE PRIORITY IS THE AGENT'S HANDLE.** The gate must be
  INTENT-AWARE (below), so the flag and the tie-break live in the same number; a second boolean
  would duplicate `prio < PRIO_FLAG_LIMIT` and could drift from it. Flagged ⇒ `prio = handle`
  (∈ [0, maxAgents)); unflagged ⇒ `prio = PRIO_UNFLAGGED` (1e6), which is also what a splitter
  writes — **both** consuming its latch **and** unblocking the neighbours it beat, the single
  write that makes the later rounds work. **Both constants are integers below 2²⁴, so they are
  exact in f32 as well as f64** and no contest can turn on a rounding artefact on the WebGPU
  agent target. **The handle IS znah's node index** (Create Agent allocates ascending; nothing
  dies here), so the lowest-handle-wins rule reproduces the reference's index walk. An earlier
  version rolled a random priority: the within-tick split order — and therefore which neighbour
  each daughter inherited, and therefore the whole embedding — varied run to run. Tier M asserts
  three different RNG seeds now produce the **identical labelled graph**.
- **THE INTENT-AWARE BANDING IS THE LOAD-BEARING DESIGN DETAIL, and the obvious version is
  measurably WRONG.** Cubic GRA's gate — everyone takes a priority, split iff you are the strict
  local minimum — makes a flagged node wait behind neighbours that **never wanted to split**,
  discarding ~¾ of the splits *even when the flagged nodes are already pairwise non-adjacent*.
  For `quadratic` (2182) that did not merely slow growth: the automaton fell into its absorbing
  all-OFF configuration and **stopped at 16 nodes against the reference's 854**. So a division
  round requires **`prio < 1e5`** (still latched) **AND** `prio < min(neighbour prio)` (I won the
  contest); a non-splitter sits at 1e6 and can never block anyone. **Safety is unchanged** — two
  adjacent splitters would need `p_i < p_j` and `p_j < p_i`, and handles are unique so strict
  inequality always resolves. The agent attribute's DEFAULT is `PRIO_UNFLAGGED`, which is also
  what stops a daughter dividing in a later round of the tick it was born in — the analogue of
  the reference freezing its flag array.
- **THE DIVISION ROUNDS ARE HAND-GATED (`generation % PERIOD != 0`), NOT K Agent Periodic Steps.**
  The flow walk INLINES a node's body once per incoming path, so K periodic roots pointing at
  one split chain would emit K copies of it. One `getGeneration → Math(%) → Compare(!=) → If`
  hung off the behaviour root's DONE continuation, one copy. The state tick stays a real
  Agent Periodic Step (phase 0), so the cadence is still visible in the C2 pipeline panel.
- **THE FIDELITY RESULT — measured, and much stronger than the first port's.** With the drain,
  N(t) matches the reference cycle for cycle for **every mutation-free published rule**, up to
  whichever side hits a node cap first. The gap this closed, K=1 → K=8 (100 cycles, cap 20 000):
  `meduza` **1/100 exact → 88/89** (deviation 84.0 % @25 and 92.2 % @50 → **0.00 % at both**);
  `Rule 17957` **0/21 → 100/100** (2223 % off → 0.00 %); `Rule 26145` **0/22 → 100/100**;
  `exp hyper` 0/67 → 42/43; `exp symmetry` 6/77 → 55/56; `Rule 1062` 5/60 → 56/57 — every
  residual "miss" is the cycle in which the reference's own node limit stops it. `quadratic`
  and `exp tree` stay **100/100 at BOTH K**, which is the regression proof that the extra
  no-op rounds change nothing for the rules that never needed them.
- **SLOT ORDER IS THE FIDELITY FRONTIER, and ALL FOUR rows a split touches are now EXACT.** A
  bond APPENDS to both endpoints' lists, so a node's slot order is its incident edges sorted by
  formation time — and the split reads slot 0 (kept) and slots 1/2 (handed to the daughters), so
  slot order propagates into the embedding forever. The split's **operation order is therefore
  not free**: `form(i,j)` · **`transfer(b, i→j)`** · `form(i,k)` · `between(j,k)` ·
  **`transfer(c, i→k)`** yields `mother = [a,j,k]`, `j = [i,b,k]`, `k = [i,j,c]` **and** both
  receivers `nodes[b][indexOf(i)] = j` / `nodes[c][indexOf(i)] = k` — znah's division, verbatim,
  every row. Tier M asserts all four through the real engine, expressing the receiver rows as the
  reference's own `reconnect` rather than a transcribed answer, and negative-controls them by
  putting the split back on **Rewire** (a source mutation that scrambles a receiver).
- **`maxBonds` IS 4, AND THAT IS THE PRICE OF THE LAST ROW.** The mother transiently reaches
  degree 4 at the two `form(i,·)` steps. A capacity-safe order does exist at `maxBonds 3` (shed
  before gaining), but it hands daughter `j` its slot 0 as `b` rather than `i` — one daughter's
  order breaks. So 3 keeps the tight "nothing may transiently exceed cubic degree" guard and gets
  3 of the 4 rows; 4 gets all four, and O6 (asserted after EVERY generation) still catches an
  over-bond, one layer later.
- **WHAT THE TRANSFER VERB BOUGHT, MEASURED** (against a transcription of the reference, 100
  reference ticks, 6000-node cap; Rewire split → Transfer split):

  | | quadratic | exp tree | meduza |
  |---|---|---|---|
  | LABELLED edge set identical to the reference | 43.5 % → **100.0 %** | 22.0 % → **100.0 %** | 47.7 % → **79.2 %** |
  | max splits by one node (ref) | 5 → 5 (5) | 5 → 5 (5) | 15 → **49** (49) |
  | nodes splitting ≥ 3× (ref) | 4 → 9 (8) | 25 → 16 (15) | 3 → **46** (46) |
  | share of splits in the top 5 % (ref) | 25.7 % → 31.1 % (31.8 %) | 29.0 % → 30.3 % (31.7 %) | 12.0 % → **48.2 %** (48.2 %) |

  On `quadratic` and `exp tree` the port's edge set is now **IDENTICAL to the reference's, edge
  for edge at the same node ids** — full labelled isomorphism, not just N(t). And `meduza`'s hub
  structure — the thing the port visibly lacked, and the user's original observation — now
  matches the reference **exactly** on all three hub statistics.
- **⚠️ WHAT IT COST: the drain no longer provably finishes, and ONE published rule loses its N(t)
  exactness.** A latched node may split only when its handle is below every bonded neighbour's,
  so a path of flagged nodes with ASCENDING handles drains ONE PER ROUND and the rounds a tick
  needs are the longest such chain. Rewire used to SCRAMBLE each receiver's slot order, which
  broke those chains up by accident; Transfer reproduces the reference's adjacency and with it
  the reference's own long flagged chains. **Raising K does not fix it** — measured on the same
  five-rule set, leftovers persist at K = 8 / 10 / 12 / 16 / 24 / 40 alike, and for `exp hyper`
  the divergence merely slides from cycle 26 (K=8) to 28 (K=12) to 30 (K=20). The reference has
  no such limit: it divides sequentially in index order, so one pass covers any chain length, and
  only a sequential drain could match that. **So K stays 8** (the cadence the layout budget was
  tuned against) and the residue is pinned rather than chased: over the 18 mutation-free
  published rules at 100 ticks, **17/18 match N(t) exactly** (was 18/18); the exception is
  `exp hyper`, exact for its first 26 cycles. Every rule, that one included, stays exactly
  3-regular with `E = 3N/2` throughout. Tier M now asserts a leftover RATE (`< 5 %`, measured
  ~0.94 %) instead of zero, and pins `exp hyper`'s divergence floor so a change that makes it
  worse — or that fixes it — is noticed.
- **The other residuals, stated honestly.** A node still latched after round K is re-latched by
  the next state tick, i.e. it divides a tick late — measured at **~0.94 %** of latches, and that
  is exactly the mechanism behind the one `exp hyper` deviation above. A rule WITH mutation cannot match at all (the reference flips on
  `Math.random`, the port on the seeded shared stream) — a different noise realisation, not a
  fidelity gap, and the oracle excludes those 5 presets for that reason.
- **THE INITIAL CONDITION IS THE REFERENCE'S, EXACTLY — INCLUDING 9 OF THE 10 SLOT ORDERS.**
  znah always seeds the same 10-node cubic graph — a 10-cycle plus the chords {0,2} {1,4} {3,6}
  {5,8} {7,9}, states `[0,0,0,1,0,1,0,1,1,1]` — and **every row is literally
  `[prev, next, chord]`**. The chord map is an **involution**, so it ships as a 1-axis
  **handle-indexed lookup table** (`chordPartner`), with a second one (`initState`) for the
  states. The Agent Init Event places ten agents on a circle sized from the LIVE world dims and
  reads their states from the table; the **wiring** happens on the first behaviour step (Form Bond
  writes the acting agent's request queue, so it is invalid in an Init Event), gated on bond
  degree 0 so it runs exactly once. **The formation order is SCRIPTED**, since the drain applies
  queues in ascending agent order: agent `h` forms only its own `(h+1)` edge (nobody forms a
  `prev` edge — the previous agent already did) and issues its chord **only when it is the HIGHER
  endpoint**. That lays the cycle down as e0…e9 with each chord immediately after both its
  endpoints' cycle edges ⇒ **9 of 10 rows match znah exactly**.
  **THE TENTH IS PROVABLY IMPOSSIBLE, not a shortfall**: node `h`'s prev-edge is `e(h-1)` and its
  next-edge is `e(h)`, so `[prev, next]` for every `h` at once needs
  `t(e9) < t(e0) < … < t(e9)` — a cycle. Exactly one node must carry its cycle edges the other way
  round; here node 0 gets `[next, chord, prev]`. Tier M asserts the 9/10 count, WHICH node is the
  exception, and negative-controls it (giving each chord to its LOWER endpoint drops it to 4/10 —
  which is what the pre-2026-08-04 bootstrap produced).
- **The split is FIVE queue ops** (2 Form Bond + 2 Transfer Bond + 1 paired Form Bond — Create
  Agent / Add Agent To World are host calls consuming no queue slot), with the mother keeping bond
  slot 0 — and unlike Cubic GRA that is **NOT** an arbitrary choice here: slot 0 is `a`, the
  neighbour znah's mother keeps, so the fixed orientation is what makes the mother's row match.
- **TWO LIVE PRESENTATION SLIDERS** (both bounded model attributes, deliberately absent from the
  presets so loading a rule never moves them). **Max Generations** gates BOTH the state tick and
  the division rounds (`0` = unlimited), freezing the automaton while the force layout, the render
  and every other control keep running; freezing part-way through a tick is safe **because O6
  holds at every generation, not only at tick boundaries**. **Node Radius** is written by every
  agent every generation via **Set Target Radius** + a snap-rate growth ramp (`growthRate 2`,
  above the whole slider range, so it lands in one generation) — **not** Set Agent Radius by id,
  whose wired Agent port is exactly what the synchronous cross-agent write gate rejects, correctly
  (it cannot know statically that Get Self Handle is self-targeted). Its upper bound **1.35** is
  PURELY COSMETIC since the physics-parity pass (Collision is OFF, so no engine force reads a
  radius and the old hash-completeness ceiling no longer applies). The `growth` capability is on
  ONLY to carry this; nothing in the rule reads a radius, so the C8 geometry verdict is unchanged.

#### THE PHYSICS IS znah's, PARAMETER FOR PARAMETER (the layout-fidelity pass)
The topology was already exact (Tier M) while the LAYOUT still did not look like the reference, and
the cause was a **scale mismatch, not a tuning one**. Every row below was checked against
`graphs-main/js/force.js` + `src/main.c`; the acceptance measurement is
[scripts/test-growing-graphs-physics.mjs](scripts/test-growing-graphs-physics.mjs), which relaxes the
SAME grown graph under both force laws and reads every parameter off the shipped `.gcaproj`.

| what | reference | ours (shipped) | note |
|---|---|---|---|
| bond rest length | `linkDistance` **25** | `bondRestLength` **25** | was 5 |
| spring stiffness | `linkStrength` **0.5** | `bondStiffness` **0.5** | was 0.55 |
| spring law | `s = (l−L)/l·λ`, applied ±FULLY to both endpoints | `F = λ(l−L)·r̂` per endpoint | same magnitude |
| spring SOLVER | **2 Gauss-Seidel sweeps** (fwd+bwd) on PREDICTED positions `pos+vel`, `l²` floored at 1 | ONE Jacobi accumulation per force iteration | **the one residual — see below** |
| charge law | `c = mass·(1/(1+l²) − 1/(1+R²))` on the RAW displacement | identical | ✓ |
| charge k | `chargeStrength` **−3** | `chargeStrength` **−3** | was −10 |
| charge cutoff | `chargeMaxDist` **2000**, culled inside the traversal | `chargeMaxDist` **2000** under `chargeRange:'global'` | **the engine addition** |
| Barnes-Hut θ | `theta2 = 0.81` ⇒ **0.9** | `chargeTheta` **0.9** | ✓ |
| tree rebuild | once per FRAME, before `tickSteps` | once per GENERATION, before the iteration loop | ✓ |
| integration | `vel += F; pos += vel; vel *= 0.9` — **no dt at all** | `v = momentum·v + (dt/η)·F; x += v` | equivalent iff dt/η = 1 |
| momentum | `1 − velocityDecay` = **0.9** | `momentum` **0.9** | was 0 |
| effective step | 1 | `timeStep 0.4 / drag 0.4` ⇒ **exactly 1** | see the clamp trick |
| speed cap | none | `maxSpeed 0` (uncapped) | ✓ |
| collision | **none** | `collision:'off'`, `repulsionStiffness 0` | was `soft`, 0.9 |
| solver passes/step | `tickSteps` **2** | `layoutIterations` **2** | was 1 |
| newborn placement | mean of `[mother, inherited]` + `±0.5` ABSOLUTE | midpoint + `±0.25` (one draw, applied ±diagonally) | was `±0.3` = 6% of rest |
| world bounds | **none** (the view auto-fits the extent) | bounded 60000², measured so nothing clamps | |

- **THE ONE NUMBER THAT EXPLAINS THE OLD LOOK.** The charge law has a length scale BUILT IN (the
  knee at `d = 1`), so the same `k` means something completely different at a different rest
  length. The regime is the dimensionless **`|k| / (λ·(1+rest²))`**: the reference's is
  `3/(0.5·626) = 0.0096`; the port's was `10/(0.55·26) = 0.699` — **73× more charge-dominated**,
  so its bonds sat ~48% past rest and the graph read as permanently inflated. The harness asserts
  this ratio as a pure CONFIG check, which catches the defect without needing a run.
- **THE dt/η = 1 TRICK, because it cannot be reached by `timeStep` alone.** `effectiveAgentDt`
  CLAMPS `dt` to `0.2/μ_eff` with `μ_eff = repulsionStiffness + bondStiffness` — read
  UNCONDITIONALLY, even with collision off. So `repulsionStiffness: 0` (honest — nothing uses it)
  gives `μ_eff = 0.5`, bound `0.4`; `timeStep 0.4` is then admitted UNCLAMPED and `drag 0.4` makes
  `dt/η = 0.4/0.4 = 1` exactly. Verified live: the C1 row reads `requested 0.4 · dt 0.4 · μ_eff 0.5
  · clamped false`.
- **`useBondingPhysics: false` is a PERFORMANCE choice, not a physics one.** Springs ride the
  Bonds=Physics capability independently, so turning the legacy bundle off costs nothing and makes
  `doScan` false — the whole neighbour pass is skipped (global charge does not join that gate).
- **THE SEED RING is derived from the REST LENGTH** (`10·REST/2π ≈ 39.8`), not from 3% of the world
  as before. The world dims still set the CENTRE, so a Resize re-centres; but a world-relative ring
  would have started every bond ~50× its rest length at the new world size.
- **THE RESIDUAL, NAMED AND MEASURED: the link SOLVER, and it is not closable here.** With the
  reference's link solve reduced to OUR single Jacobi accumulation (the harness's `--ref-jacobi`
  control) the two land on each other — **bond length 0.7–2.5%, nearest non-bonded 3.2–4.0%, hub
  ring spacing 0.5–8.8%, extent 0.2–11.4%** across three shape-different rules. So the force LAW is
  identical; a two-body bonded pair settles at **25.237332 in both, to six decimals**. What is left
  is that two GS sweeps on predicted positions are a SEMI-IMPLICIT solve, stiffer at the same λ, so
  the reference settles **13–25% tighter**. It cannot be compensated: raising λ makes the explicit
  integrator UNSTABLE (measured — λ ≥ 0.7 diverges on a cubic graph at dt/η = 1 and momentum 0.9,
  because the graph Laplacian's top eigenvalue is 6 and the loop gain passes 2; **0.5 is already at
  the edge, which is presumably why the reference chose it**), and adding Jacobi passes does not
  help (2/4/8 give the same answer — only the residual net force drops, 6.8 → 0.5). A true
  edge-list Gauss-Seidel sweep is inherently SEQUENTIAL and cannot be expressed by the per-agent
  parallel force pass all three targets share. Since the difference is close to a uniform SCALE
  factor and the view is fitted anyway, the harness gates on the **scale-free** ratios, which agree
  to **3.2–11.2% (packing)** and **3.9–10.1% (ring spacing)**.
- **THE WORLD (60000²) IS MEASURED IN THE APP, not from the harness.** The harness grows the whole
  topology at once and relaxes from a near-origin start, which produces a violent transient
  overshoot (rule 2502 measured 74 307 at 400 frames, contracting to 25 971 by 1200) — useless for
  sizing. The real model grows INCREMENTALLY: measured in the live worker at **N = 4062 the
  structure spans 8451 × 7040 with a 7.1× margin and 0 agents on the boundary**. Bounds exist only
  so nothing can be clamped; the reference has none and fits its view to the structure, which is
  why the first few dozen nodes are small here.
- **`NODE_CAP` 10000 with `maxAgents` 24000 — the 2× margin is REQUIRED, not padding.** A
  generation can split at most a maximal independent set, so N can at most DOUBLE in one
  generation, and the end condition is evaluated *after* the generation that crossed the cap.
  At the ceiling `Create Agent` returns −1, the split's Rewire finds no target and the graph
  stops being cubic — so `maxAgents ≥ 2 × NODE_CAP` is what makes the cubic invariant
  unbreakable. Verified in the app: Play pauses at **N = 10114**, E = 15171 = 3N/2, max degree 3.
- **THE FIRST SHIPPED MODEL ON `engine: 'auto'`** (C4) with `reproducibility: 'exact'` (C5).
  Verified in the real app: the chip reads **`agents WASM`** and the Properties Engine row
  reads **`Auto → WebAssembly`** with the reason *"This model declares Exact, so Auto keeps
  agents on WebAssembly"*. **This is what made `test-engine-resolve.mjs` §1 need a branch**:
  that sweep asserts LEGACY fidelity (`migrated.engine === the engine the flags asked for`,
  and *"a legacy file must NOT become 'auto'"*), which is a statement about the C4
  **migration**, not about what a model may declare. A file that already carries
  `properties.engine` now takes an explicit-declaration branch instead: the migration must
  leave it untouched, the auto flags must match the declaration, and an Exact contract must
  keep auto agents off the GPU. All 6 of the sweep's negative controls still fire, and the
  new branch was shown non-vacuous by flipping the model's contract to `statistical` (the
  check count drops 719 → 718 — the Exact assertion is the one that stops applying).
- **Geometry verdict: PRESENTATIONAL** (C8) — the rule is purely topological (a census over
  BONDED neighbours, a handle-indexed bootstrap), and the only geometry read feeds Create
  Agent's x/y, a geometry-only sink. Confirmed live: the C2 pipeline panel tags the force
  phases *presentation only — does not affect your rule* alongside
  `k = -3 · GLOBAL (Barnes–Hut θ = 0.9) — summed through a deterministic octree, truncated at 2000`.
- **The `lifespan` capability is ON because the "Birth generation" viewer reads Get Age.**
  `test-agent-capabilities.mjs` caught the omission ("migration HIDES a used node 'getAge'") —
  a real model bug, since the capability gate would have hidden a node the model uses. The
  viewer is a STANDALONE agent Output Mapping colouring by `(generation − age) / (generation
  + 1)` through a Color Scale, reproducing znah's growth-history look.
- **23 presets** (the 12 named ones in znah's own order, then the 11 unnamed rules of its
  dropdown as `Rule <n>`, ascending), each carrying both rule tables as `lookupTableData` plus
  `modelAttrs.mutationRate`. Tier M asserts the list IS the reference catalogue — nothing
  missing, nothing extra, named-first, numbered ascending, every entry decoding to its stated
  rule integer. Verified end-to-end in the browser by clicking the real Load buttons WHILE
  PLAYING: `Rule 17957 / 12369 / 2222 / 4226` and `quadratic` each post `updateLookupTable`
  payloads matching that rule's bits exactly (recomputed independently in the page).

### Verification of the samples — O6, O8 and the exactness oracle (harness Tiers L and M)

**Tier K is RETIRED** (2026-08-05) — it pinned the shipped `Cubic GRA`, which the author removed
from the library. Its coverage survives in **Tier J** (the synthetic triangle-split gate asserts
O6 + I1–I4 after every one of 60 splits, with the no-Form-Between negative control) and **Tier M**
(O6 + I1–I4 at every generation of the SHIPPED `Growing Graphs`, across eight published rules).
The paragraph below records what Tier K measured while the model shipped.

- **O6, the milestone's headline result, in the then-SHIPPED `Cubic GRA`**: `min degree == max
  degree == 3` AND `E == 3N/2` at **EVERY** generation — 220 generations at the shipped Split
  Rate (847 splits, N 4 → 1698) and **500 generations** at a slower rate, with I1–I4 after
  every one and the growth law exact (`N = 4 + 2t`, `E = 6 + 3t` — the observable form of I5,
  since a half-applied split would put N and E off the closed form). **Two negative
  controls**: dropping ONLY the `v₂–v₃` paired Form Bond breaks O6 while I1–I4 stay green
  (so the tier really tests O6 and not something weaker), and disabling the priority gate
  makes adjacent rewriters collide. **In the real app** (WASM agent target, real worker) at
  generation 270: N = 5120, E = 7680 = 3N/2, min = max = 3, handshake exact, 0 dangling.
- **O8, hysteresis, in the SHIPPED SDCA**: thresholds that never fire ⇒ topology EXACTLY
  invariant over 40 generations; inside the band an edgeless graph stays edgeless; above λ₂
  292 links form; **back inside the band they STAY (292 → 292, no flicker)**; below λ₁ they
  all break. **Negative control**: the identical run with `λ₁ == λ₂` destroys every link on
  the way back — the band is what preserves them. I1–I4 after every one of 500 generations,
  with the link count changing on 496 of them (not a fixed point). **In the real app**
  (WebGPU agent target) the same five-step manoeuvre reproduced exactly: 0 → 0 → 293 → **293**
  → 0, and the single-threshold control collapsed to 0.
- **THE EXACTNESS ORACLE, in the SHIPPED `Growing Graphs` (Tier M)**: N(t) matches the
  reference implementation **cycle for cycle** for `quadratic` (2182, 100 cycles → 588),
  `exp tree` (2236, 100 → 2408), **`meduza` (2502, 55 → 7518)**, **`Rule 17957` (60 → 3234)**
  and **`Rule 26145` (60 → 3298)** — i.e. including the rules whose flagged nodes CAN be
  adjacent, which the pre-drain port could not follow. The reference is transcribed into the
  tier as a SEPARATE implementation (the ground truth, not a mirror of anything under test).
  **ALL BUDGETS ARE READ OFF THE SHIPPED FILE** (`PERIOD` from the state tick's Agent Periodic Step,
  cross-checked against the division gate's `% PERIOD`), the Cubic-GRA/Tier-K precedent, so a
  cadence retune cannot silently shorten a check. **Negative-controlled twice**: a source
  mutant that collapses the cadence to a SINGLE division round makes `meduza` diverge at cycle
  2 (the old behaviour — this is what proves the drain rounds are load-bearing), and a mutant
  that reverts the priority to the intent-blind form breaks the oracle. The same tier pins the
  bootstrap by SET COMPARISON (exactly the reference's 15 edges, its exact state vector), the
  table stride order, the preset catalogue (23, named-first, numbered ascending, complete and
  with nothing extra), **the drain completing (0 of 9069 latches survive a tick)**, and O6 +
  I1–I4 at every one of 270 generations (30 reference ticks) across eight published rules —
  four of them the NEW numbered ones, so a broken catalogue entry cannot ship silently.
- **`Growing Graphs` in the real app** (WASM agent target, real worker, 0 console errors):
  the chip reads `agents WASM`; **Play grows `meduza` to the cap and STOPS there — N = 10114,
  E = 15171 = 3N/2, max degree 3**, with the *Birth generation* viewer rendering the growth
  history (indigo core → bright frontier). **Scale runs to the 10 000-node cap** on the shipped
  file: `meduza` N = 10278 at generation 585 (65 ticks), **6.28 ms/generation**;
  `Rule 17957` N = 10002 at generation 1620 (180 ticks), **7.44 ms/generation** — both with
  `E = 3N/2`, min = max degree 3, 0 dangling, 0 asymmetric bonds, **0 agents on the boundary**,
  0 queue overflows, 0 worker errors. Switching presets (incl. numbered ones) mid-play posts
  the right tables. **NB the Library card is served through the SW runtime cache** — a probe
  that regenerates the model on disk and then clicks the card can silently load the PREVIOUS
  copy (it did here: 12 presets instead of 23); purge the cache entry or load the file through
  the File-menu input.
- **Overseer sweep, in the real panel**: 12 rules × `ovRunUntilStop(120)` in 1.7 s;
  `ovRandomizeTable` re-rolls BOTH tables and journals every `{seed, density}`; N spans 4..274
  (rules that die, grow and blow up) while the `maxDegree` series reads **mean 3, std 0, min
  3, max 3** — O6 across the whole rule space. **Two presses give identical series** (the
  reproducibility the `wasm` target was chosen for).


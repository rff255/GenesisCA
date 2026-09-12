# Compiler core — the shared passes and the JS reference target

> Area doc for **GenesisCA**. The two-pass JS compiler and the analyses every target consumes: value sinking, accessor CSE, the async read-after-write hazard, the multi-attribute-slot and periodic-event lowerings, rule cadence, and parameterized input mappings. Read before touching `src/modeler/vpl/compiler/*.ts`.
>
> **Also read** — a change here usually reaches [`compiler-wasm.md`](compiler-wasm.md) · [`compiler-webgpu.md`](compiler-webgpu.md) · [`agent-compilers.md`](agent-compilers.md) · [`value-types.md`](value-types.md) · [`cell-features.md`](cell-features.md) · [`grid-3d.md`](grid-3d.md) · [`testing-harnesses.md`](testing-harnesses.md) · [`rule-trace.md`](rule-trace.md).
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

- Value Sinking (cross-target compile optimisation)
  - Why it matters
  - Flow graphs are DAGs, not trees
  - Iterating flow outputs / value inputs of a flow node
  - Analyzer
  - Per-target consumption
  - Side-effect handling
  - When sinking does NOT help
  - Gotchas
- Accessor CSE (cross-target compile optimisation)
  - Why it matters
  - Purity rules
  - Async-mode gate
  - Per-target wiring
  - Interaction with aggregate fusion
  - Gotchas
  - Behavioural changes you may see
- Async Read-After-Write Hazard (volatile-ized attribute reads — JS + WASM)
- Multi-Attribute Slots on Get/Set Attribute (branch `multi_attr_slots`)
  - Config / port encoding (slot 1 = legacy, zero migration)
  - Compile = ONE shared expansion pass, zero per-target emit ([multiAttrExpand.ts](src/modeler/vpl/compiler/multiAttrExpand.ts))
  - Editor
  - Verified
- Bond-Graph Agents — Floating Cells (milestone, branch `agents_floating_cells`)
  - Parameterized Input Mappings — declared parameters replace hardcoded R/G/B (branch `polishing`)
- Agent-compiler branch-scope + RNG-order fixes (branch `improvements`, 2026-07-28)
  - Defect 1 — `usedVolatiles` over-skipped `next`, so a branch never claimed its own volatile
  - Defect 2 — the force-emit dragged a SHARED pure input into one branch
  - Defect 3 — RNG DRAW ORDER: JS hoisted, WASM/WebGPU emit at the use site
  - Verified
  - The invariant the fixes preserve — ONE Get Random node = ONE draw, shared
  - Rule of thumb this leaves behind
- Get Grid Dimensions (universal node — Cells AND Agents, all 6 compile surfaces)
  - Emit — no ABI change anywhere; W/H/D were already in scope on all six surfaces
  - `CompileContext.agentGraph` (new)
  - Registration checklist (what a multi-output universal value node needs)
  - Latent bug fixed in the same pass
  - Verification
- Rule Cadence — `Get Generation` (universal) + `Agent Periodic Step` (agents) — branch `GRA`
  - `Get Generation` ([GetGenerationNode.ts](src/modeler/vpl/nodes/GetGenerationNode.ts)) — the primitive
  - Threading — six surfaces, NO new per-target algorithm
  - THE delicate point — GPU residency (why a STORAGE buffer, not a uniform)
  - `Agent Periodic Step` ([PeriodicStepNode.ts](src/modeler/vpl/nodes/PeriodicStepNode.ts)) — the sugar
  - Verification
- Global Periodic Events — `Grid Periodic Event` + `Population Periodic Event` (branch `tasks_batch_02-09`)
  - The architecture — the Grid Init Event's, verbatim
  - `CompileResult.gridPeriodicCodes` / `AgentCompileResult.periodicCodes`
  - Ordering — the TOP of the generation, and both consequences are deliberate
  - The grid half — the buffer discipline is `runGridInit`'s
  - The agent half — the Agent Init Event's ABI, REUSED
  - ⚠ RESIDENCY IS A CORRECTNESS TERM
  - The enumeration sweep (the documented agent-root list, plus the cell-root sites)
  - Verification
- The TRACE BUILD — `compileGraph(…, { trace: true })` (2026-09-12) → [`rule-trace.md`](rule-trace.md)

---

## Value Sinking (cross-target compile optimisation)

All three compile targets share `src/modeler/vpl/compiler/sinkAnalysis.ts` — a target-independent analyzer that, for every value-producing node in a root's flow tree, computes the lowest-common-ancestor (LCA) of all its uses. Values used in exactly one switch case or if branch are emitted *inside* that branch; values used across multiple branches stay at the LCA (function-top in the worst case). The classic compiler-theory name is *lazy code motion* / *partial dead code elimination*.

### Why it matters
- Pre-sinking, every value-producing node referenced anywhere in the flow tree was emitted at cell-top regardless of which branch consumed it. On type-dispatch models (Wireworld, Predator-Prey, multi-species) most cells discarded most pre-computed values after the switch picked one case.
- Post-sinking, an Empty Wireworld cell (~80% of a sparse board) does one attribute read and skips the entire branch body — no filter loops, no scratch fills, no intermediate booleans.

### Flow graphs are DAGs, not trees
- A flow node CAN have multiple incoming flow edges (e.g., two switch cases targeting the same downstream Conditional). `compileFlowChain` in all three compilers (JS / WASM / WebGPU) has NO visited check — it inlines the flow node's body INLINE at every walking pass. The compiler is by design unaware that it's emitting the same body twice; the `compiled: Set` in `compileValueNode` (and analogous caches in WASM `valueLocals` / WebGPU `valueLocals`) dedupes value emission across the two walks.
- Any new flow-walk analysis must record value-input uses on every visit (not just the first) and treat the scope tree as path-dependent. The sink analyzer's `flowNodeContainingScopes` Map + `taintedSeed` post-process in [sinkAnalysis.ts](src/modeler/vpl/compiler/sinkAnalysis.ts) is the working template: track every parent scope a flow node was reached from, then climb out of "diamond-tainted" scopes (multi-parent flow nodes' bodies + containing scopes) when assigning emit locations.
- Editor connection validation prevents flow CYCLES but NOT flow diamonds (a flow input port can have multiple incoming edges). Both compilers and analyzers must tolerate diamonds.

### Iterating flow outputs / value inputs of a flow node
- `def.ports` only lists STATIC ports. Switch's `case_N` flow outputs and `case_N_cond` / `case_N_val` value inputs are DYNAMIC — they exist in the edge maps (`flowOutputToTargets`, `inputToSource`, `inputToSources`) but NOT in `def.ports`. Walkers that iterate `def.ports` will silently skip them.
- Correct pattern: iterate the edge map keyed by `${nodeId}:`. Examples: `collectValueDeps` in [compile.ts](src/modeler/vpl/compiler/compile.ts) walks ALL flow output edges via `for (const [key, targets] of flowOutputToTargets)` with prefix check; `recordValueInputs` in [sinkAnalysis.ts](src/modeler/vpl/compiler/sinkAnalysis.ts) walks dynamic value-input edges via the same prefix pattern after the static port iteration.

### Analyzer
- `analyzeSinkScopes({ nodes, edges, rootNodeId, rootFlowPortId })` walks the flow tree from the root, assigns each branch port (then/else/body/case_N/default) a `ScopeId`, then propagates use-scopes back through the value DAG to a worklist fixpoint. Sequence is transparent (no new scope). Switch with `caseCount === 0` and a default inlines the default at the parent scope.
- `recordValueInputs` walks BOTH static `def.ports` value inputs AND any dynamic-port edges from the same node (switch's `case_N_cond` / `case_N_val` live only in the edge map, not in static port lists). Without this the switch's per-case value-input sources would default to `CELL_TOP`.
- `hoistPastLoops` walks UP from each value's LCA past any Loop body and any ForEach body where the value isn't in that forEach's `elementDependents` transitive closure. Loops have a per-iteration recompute cost branches don't, so the LCA's "smallest scope where uses are dominated" rule would regress if a loop-invariant value landed inside a loop body. The hoist is conservative — for Loop nodes (no iteration-variable value output) we always hoist past; for ForEach we hoist past only when the value isn't element-dependent.

### Per-target consumption
- **JS** ([compile.ts](src/modeler/vpl/compiler/compile.ts)): `routeValueEmit` dispatches each value to either `valueLines` (CELL_TOP, current behaviour) or a per-scope `branchValueLines` buffer. `flushBranchValues` runs at every branch entry in `compileFlowChain` (conditional then/else, loop body, forEach body, switch case_N, switch default — both `firstMatchOnly=true` and the independent-cases mode). Lines are stored unindented and the flush applies the indent from the current flow-walk position, which sidesteps any drift between the analyzer's depth count and the emit indent. `collectValueDeps` walks ALL flow output edges (looked up via `flowOutputToTargets`) rather than static `def.ports`, so switch's dynamic case ports are reached during pre-emission.
- **WebGPU** ([webgpu/compile.ts](src/modeler/vpl/compiler/webgpu/compile.ts)): `routeEmissionForNode` wraps each value-/array-node emitter call in a buffer-swap — `ctx.lines` is replaced with a temporary array for the emitter's pushes, then captured lines route to `ctx.lines` (CELL_TOP) or `ctx.branchLines[scope]`. `flushBranchValues` runs at every branch entry. `preEmitValueNodes` still walks the flow tree to trigger compileValueNode for every referenced value before `compileFlowChain` runs — sinking changes WHERE the lines land, not WHETHER they're emitted. WGSL's block scoping then makes branch-local declarations work naturally for single-branch values.
- **WASM** ([wasm/compile.ts](src/modeler/vpl/compiler/wasm/compile.ts)): `emitValuesForScope(ctx, scope)` iterates `sinkAnalysis.valuesByScope[scope]` in topo order and calls `compileValueNode` / `compileArrayNode` for each. The bytecode lands at the current emit position — implicitly INSIDE the branch when called from inside an `emitter.ifThen` / `ifThenElse` / `loop` callback (WASM's structured control flow). No buffer-swap needed — WASM's emitter callbacks already enforce scoping for the bytecode they produce. The eager `preEmitValueNodes` pass was removed. WASM locals are still function-scope (only the `localSet` instruction sequence moves inside the branch); the per-cell scratch bump-pointer reset is unchanged because branches are mutually exclusive within a cell, so any branch's array-producing values get the full scratch budget from a fresh reset offset.

### Side-effect handling
- RNG-using nodes (`getRandom`, `pickRandomNeighbor`, `pickNRandomNeighbors`) participate in sinking. Cells that don't reach a branch with a getRandom don't burn RNG entropy. **Behaviour change for random-using models**: pre-sinking, every cell advanced the shared xorshift32 stream once per getRandom node per step; post-sinking, only cells whose path reaches the getRandom advance it. Models seeded prior to this change will produce different output starting at gen 1. JS↔WASM parity is preserved (both consume the same analyzer output and burn the RNG for the same cells). WebGPU uses per-cell PCG, so the change there is intrinsically per-cell (no cross-cell coupling either way).
- Scratch arrays (filterNeighbors, getNeighborsAttribute, etc.) reset their write head at use site (`.length = 0` in JS, `localSet $scratchTop, scratchStart` in WASM, `_len = 0` in WGSL). Sinking them is safe — the reset always precedes the fill within the value's emit.
- **Local-variable readers are routed by the "volatile-hoist" mechanism, not ordinary sinking.** Any value transitively reading `getVariable` must NOT be sunk to scope-entry by sink analysis — its inputs are mutated by `setVariable` / `setArrayElement` during the cell body. Instead [volatileHoist.ts](src/modeler/vpl/compiler/volatileHoist.ts) emits it at the LCA flow scope of its uses, just before the consuming flow node (after the mutating siblings, dominating every branch). See the Local Variables → "Volatile values" section. Lockstepped across JS / WASM / WebGPU.

### When sinking does NOT help
- Game of Life and similar models where every cell runs the same rule: nothing to sink. Compile output is unchanged.
- ProportionMap / Interpolation / arithmetic-only graphs without a switch or conditional: all values are at CELL_TOP regardless. Compile output is unchanged.
- Dense-mix workgroups on WebGPU: GPU divergence executes all touched branches with lane-masking, so per-cell wins from skipping a branch can be partially or fully absorbed by sibling-branch execution times. Sparse type-dispatch models (Wireworld) still win because most workgroups land on spatially-uniform regions.

### Gotchas
- The analyzer expects a **flat post-macro-expansion graph**. ALL THREE targets now run the shared `expandMacros` ([macroExpand.ts](src/modeler/vpl/compiler/macroExpand.ts)) up front (JS's old lazy `inlineMacroValues`/`inlineMacroFlow` path is gone), so the analyzer always sees fully flat graphs — former macro internals are ordinary top-level nodes with proper per-node emit scopes.
- `compileRoot` (JS) takes raw `graphNodes` / `graphEdges` even though they're redundant with `nodeMap` etc. — the analyzer rebuilds adjacency internally, keeping it target-independent. Same pattern for WASM (`compileEntry` takes a precomputed `SinkAnalysisResult`) and WebGPU (`baseCtx.graphNodes` / `baseCtx.graphEdges` threaded through, analyzer called per-entry inside `compileEntry`).
- WebGPU's buffer-swap captures only the emitter's OWN push'es. Recursive `compileValueNode` calls for input sources have already routed their own emissions via their own wrappers, since inputs are resolved upstream of the wrapped emit call.

---

## Accessor CSE (cross-target compile optimisation)

All three compile targets run `canonicalizeAccessorEdges` from [accessorCSE.ts](src/modeler/vpl/compiler/accessorCSE.ts) before sink analysis. It computes a structural "purity key" for every value-producing node, groups nodes that share a key, picks one canonical per group (lexicographically smallest id), and rewrites consumer edges so non-canonical equivalents become unreachable. The downstream compilers (sink analysis, loop-invariance, fusion, per-target emit) see the dedup'd edges naturally — no per-target emit changes needed because all three lookup sources via `inputToSource` / `inputToSources`.

### Why it matters
- Lets users freely re-instance simple accessors in multi-equation graphs (Gray-Scott reaction-diffusion is the canonical case: each equation reads `u`, `v`, `∇²u`, `∇²v` — pre-CSE forced the user to either share one node and run cables everywhere, or pay 2× the read cost).
- Catches deeper duplicates too: `Compare(GetCellAttribute(u), GetConstant(3))` × 2 collapses all three pairs (the two compares, the two gets, the two constants), recursively.

### Purity rules
- **Impure (never canonicalised, each instance emits independently):** `getRandom`, `pickRandomNeighbor`, `pickNRandomNeighbors` (RNG side effect); `getIndicator` (`_indicators[id]` is mutable mid-cell via `SetIndicator`/`UpdateIndicator`); `aggregate` / `groupOperator` with `op === 'random'`; `macro` (opaque container — v1 doesn't introspect macro internals); entry-point types (`step`, `inputColor`, `initEvent`, `outputMapping`, `macroInput`, `macroOutput`).
- **Pure (CSE-eligible):** every other value-producing node, **provided every value input is also pure**. Impurity propagates through the key — `Compare(GetRandomA, k)` and `Compare(GetRandomB, k)` get different keys (even with identical configs) because the random source IDs differ in the `nonpure:<nodeId>:<port>` tag. Two consumers wired to the SAME `GetRandom` do canonicalise (they share the canonical key of that single source).

### Async-mode gate
- The pass is a no-op when `model.properties.updateMode === 'asynchronous'`. Async-mode Step shares one buffer, so a `GetCellAttribute` read can change after an intervening write within the same cell body — CSE would silently merge them, breaking the model. InputColor / OutputMapping / Init are individually safe to CSE in async mode (no in-loop mutation), but the global edge rewrite spans all roots, so the simplest sound design is "all-or-nothing per model".

### Per-target wiring
- **JS** ([compile.ts](src/modeler/vpl/compiler/compile.ts)): runs at the top of `compileGraph` right after async-validation, before `buildAdjacency`. Macros aren't pre-expanded in JS, so CSE only sees top-level nodes — fine because macros are impure anyway.
- **WASM** ([wasm/compile.ts](src/modeler/vpl/compiler/wasm/compile.ts)): runs AFTER `expandMacros`, so duplicate accessors inside (or across) macro instances also get merged.
- **WebGPU** ([webgpu/compile.ts](src/modeler/vpl/compiler/webgpu/compile.ts)): same — runs AFTER `expandMacros` on `expanded.edges` before `buildAdjacency`.

### Interaction with aggregate fusion
- `detectFusableConsumers` runs AFTER CSE on the rewritten edges. The common case (two `getNeighborsAttribute → aggregate` pipelines with identical inputs+op) merges into one pipeline that still has exactly one consumer → fuses normally.
- Corner-case regression: two `aggregate` nodes with DIFFERENT ops over the SAME `getNeighborsAttribute`. Pre-CSE: 2 fused gather+reduce loops (2 × N_nbr work). Post-CSE: 1 canonical scratch fill + 2 unfused reductions reading scratch (3 × N_nbr). Accepted as a v1 tradeoff — uncommon shape vs the broad Gray-Scott win.

### Gotchas
- `handleId` does NOT encode the source node id (`${kind}_${category}_${portId}` only) — CSE rewrites `edge.source` and leaves `sourceHandle` intact, which is sound because canonical and non-canonical share the same node TYPE → same port set.
- Vite dev-server module cache for `compile.ts` is sticky: editing the import line without restarting the dev server can leave the worker (which loaded the pre-edit module) emitting un-deduplicated code. Verify via a cache-bust import (`?t=Date.now()`) when smoke-testing fresh edits.
- The purity key serialises config minus *compiler-injected* underscored keys (`_resolvedTagIndex`, `_elemKind`, `_indicatorIdx`, `_attr_*_default`, etc.) — those are derived from other config or graph structure, so structurally-identical nodes already match on the source keys that produced them. **EXCEPTION: `_port_*` (inline-widget values) and `_varName_*` (expression variable names) MUST stay in the key** — they're user-facing inputs that change the emitted output despite the leading underscore. Dropping them merges nodes that differ only in an inline value (two `Compare`s reading the same attribute but testing `== 5` vs `== 10`; two `Get Array Element`s at different inline positions) → silently wrong results. The filter is `k.startsWith('_') && !k.startsWith('_port_') && !k.startsWith('_varName_')`. Adding a new user-facing config field needs no change; a new compiler-injected one should keep the leading-underscore convention (and NOT use the `_port_`/`_varName_` prefixes).
- Dynamic value-input ports (`switch.case_N_cond` / `case_N_val`) aren't in `def.ports` — `purityKey` walks them from the edge map, same pattern as `sinkAnalysis.recordValueInputs`. Adding another dynamic-port node means it would benefit from CSE automatically as long as the dynamic ports follow the `${nodeId}:${portId}` edge-map convention.
- The pass is an O(N+E) edge-array rebuild. On Gray-Scott with ~12 duplicate accessors it shaves ~1 µs of compile time; even on huge models the cost is dominated by graph size, not CSE bookkeeping. No bypass flag.

### Behavioural changes you may see
- For seeded random models: pre-CSE, two `GetRandom` instances wired to the same Compare both advanced the shared `_rs` xorshift stream once per cell. CSE doesn't merge separate `GetRandom` instances (they're impure), so the RNG stream draws are unchanged. But: when two equivalent `Compare(GetRandom, …)` nodes are wired to a SHARED `GetRandom`, the redundant Compare collapses — only one branch evaluation per cell — and downstream branches that depended on this Compare's result see the same RNG draw. Models that incidentally relied on the duplicate emit (e.g., two Compare nodes each re-reading the same `GetRandom` output but bundled into different branches) won't see a behaviour change because both Compares read the SAME varname (`_v<random>`) anyway; CSE just folds the consumer.

---

## Async Read-After-Write Hazard (volatile-ized attribute reads — JS + WASM)

In **asynchronous** update mode `r_<attr>` and `w_<attr>` alias one buffer (single-buffer; the per-cell `w.set(r)` copy is skipped), so a write to attribute A is immediately visible to a later read of A. But sink analysis treats an attribute read as a pure, hoistable value and could emit it ABOVE a write to the same attribute that precedes it in flow order — capturing the stale pre-write value. Canonical repro: a Snake model's "Can it move?" gate read the head's `Direction` (via `getCellAttribute → getNeighborAttributeByIndex`) *before* the direction-decision branch wrote it, while the move re-read it after — gate and move disagreed, so the snake died at obstacles instead of turning.

Fix: extend the existing **volatile-hoist** mechanism (previously only `getVariable`/Local-Variable reads) to also treat an attribute/orientation read as volatile when a write to the SAME attribute may execute before its use in flow order. Membership in the volatile set excludes the read from sink-to-cell-top and pins it at the use site (after the write) via `volatileHoist`'s `emitBefore` — exactly the same machinery Local Variables use.

- [asyncWriteHazard.ts](src/modeler/vpl/compiler/asyncWriteHazard.ts) — `computeAsyncReadWriteHazards({nodeMap, adjacency, rootNodeId, rootFlowPortId, isAsync})` returns the DIRECT-reader node ids with a may-write-before hazard. **PRECISE**: a reader is flagged ONLY when a matching write may precede its use (attribute-id granularity; a synthetic `__orientation__` key matches orientation read/write pairs). Readers of never-written attributes, and readers that precede every write, are NOT flagged → byte-identical output. **No-op for sync** (`isAsync` false → empty set). Algorithm mirrors `sinkAnalysis`/`volatileHoist`'s flow walk (Sequence transparent; conditional/loop/forEach/switch open child scopes) so "flow order" matches `compileFlowChain` emission order: `writesInSubtree` (post-order union of writes per flow subtree) + a `writtenBefore` prefix walk (earlier siblings' subtree writes accumulate; loop/forEach bodies seed with the whole body's writes for next-iteration visibility; branches stay mutually exclusive; an `entryPrefix` fixpoint unions over diamond paths). For each flow node it walks the transitive value-input cone and flags any direct reader whose read keys intersect the prefix.
- **Direct-reader seeds**: `getCellAttribute`, `getNeighborAttributeByIndex`, `getNeighborAttributeByTag`, `getNeighborsAttribute`, `getNeighborsAttrByIndexes`, `filterNeighbors`, `getOrientation`, `getFacingOrientation`, `getNeighborOrientationByIndex`, `getFacingLabels`/`getAllFacingLabels` (orientation + `config._sourceAttrId`). Consumers (aggregate/group*/compares/…) are NOT seeds — they become volatile through the closure. **Writers**: `setAttribute`, `updateAttribute`, `setNeighborhoodAttribute`, `setNeighborAttributeByIndex`, `setOrientation`, `setFacingOrientation`, `setNeighborOrientationByIndex`, `moveSelfToNeighbor` (each `attr_i` + orientation when `includeOrientation`). `markCellUpdated` writes a scheduler flag, not attribute storage.
- **Seeding**: `computeVolatileValueClosure` (shared) + the JS local copy (compile.ts) + `computeVolatileValueClosureWasm` each gained an optional `extraSeeds` param; the hazard ids are unioned into the volatile seed and the existing consumer-BFS propagates volatility to the derived chain. Hazard analysis is gated to the `step`/`initEvent` roots (inputColor/outputMapping have their own per-cell copy semantics, not the single-buffer step hazard). JS derives `isAsync` from `model.properties.updateMode` inside `compileRoot`; WASM uses `ctx.layout.isAsync`.
- **Aggregate fusion** ([fusion.ts](src/modeler/vpl/compiler/fusion.ts)) gained a `hazardReads` param: a `getNeighborsAttribute` that is a hazard refuses fusion (mirrors the sub-attribute refusal) so it materialises and gets pinned, instead of the fused inline read bypassing the pin. **JS-only** — WASM never consults the fusion map (its `getNeighborsAttribute` gather is always a phantom).
- **Untouched**: sink exclusion, `emitBefore` consumption, `forceVolatileCurrentScope`, `computeVolatileHoist`, `loopInvariant` (the affected reads are already `NEVER_INVARIANT` → no loop-hoist change → perf cost ≈ nil; emission merely relocates within the per-cell body), the worker, and **all WebGPU files** (WebGPU rejects async at the model level).
- **Known limitations**: (1) WASM neighbor-aggregate over a written attr — WASM's `getNeighborsAttribute` is a phantom, so the aggregate (the real inline reader) is pinned via closure-propagation rather than the materialise path; the Snake doesn't exercise this shape. (2) A single shared read node wired to multiple uses with a write *between* two of them is emitted once before the first use (stale for the later) — identical to existing `getVariable` volatile behavior; the common pattern uses separate read nodes, each pinned at its own use.
- Verified: snake gate `Direction` read now emits after the direction write (JS, confirmed in the compiled step) and the snake compiles clean on JS + WASM; all 11 library models (3 async, 8 sync) compile with no errors; sync output byte-identical by construction.

---

## Multi-Attribute Slots on Get/Set Attribute (branch `multi_attr_slots`)

The four attribute-accessor nodes — **`getCellAttribute` / `setAttribute`** (universal, cell OR agent graph; `setAttribute` additionally takes an OPTIONAL agent id), **`getModelAttribute`** and the by-id agent read **`getAgentAttribute`** — take a **dynamic number of attribute slots** (the `moveSelfToNeighbor` payload-slot / Switch-Sequence dynamic-port pattern applied to the accessors): one Get reads N attributes through N output ports, one Set writes N attributes through N input ports. Collapses the "one node + one wire per attribute" clutter. Plan + mockup: [docs/PLAN_MULTI_ATTR_SLOTS.md](docs/PLAN_MULTI_ATTR_SLOTS.md)/`.html`.

### Config / port encoding (slot 1 = legacy, zero migration)
- Slot 1 stays the legacy `attributeId` + port `value` (+ `r`/`g`/`b` for a color model attr) — old files load + compile byte-identically; `extraCount` absent ⇒ 0 (hot-path no-op).
- `extraCount` = the number of EXTRA slots, indexed **2..extraCount+1** (mirrors Sequence's `then_2…`). Per slot i: config `attr_${i}`; port `value_${i}` (get: output, set: input); set slots store their inline value at `_port_value_${i}`. A **color model attr** in a `getModelAttribute` slot exposes `r_${i}`/`g_${i}`/`b_${i}` (color-ness resolved LIVE from the model, no per-slot `isColorAttr` to go stale).
- Slot removal takes the **LAST slot only** (Sequence's rule) — never shifts lower slots, so a wired `value_2` can't silently re-pair with a different attribute.

### Compile = ONE shared expansion pass, zero per-target emit ([multiAttrExpand.ts](src/modeler/vpl/compiler/multiAttrExpand.ts))
`expandMultiAttrs(nodes, edges, model)` rewrites every multi-slot accessor into the SINGLE-slot primitives all five compilers already emit — the exact `expandMacros`/`collapseReroutes`/`lowerVectorAttrs`/`expandComposites` lowering pattern, so **JS / WASM / WebGPU, cell + agent graphs, 2D + 3D work by construction** and no analyzer/gate/emitter ever sees a multi-slot node. Wired into all SIX front-ends immediately AFTER `collapseReroutes`, BEFORE `lowerFacingSource`/`lowerVectorAttrs` (so a **vector attribute in an extra slot** lowers normally — verified): JS `compileGraph` + `compileAgentGraph`, `wasm/compile.ts`, `webgpu/compile.ts`, agentWasm + agentWebgpu `flattenAgentGraph` (the agent gates therefore accept multi-slot graphs for free).
- **Gets**: original kept for slot 1 (config PRUNED of the extra keys so accessor-CSE's purity key equals a plain single get) + one synthesized clone per extra slot (`${origId}__ma${i}` — deterministic, WASM/WebGPU byte-stable); `value_${i}` (or `r/g/b_${i}`) consumers rewire to the clone. `getAgentAttribute`'s shared `agentId` edge **fans out** (original keeps it, each clone gets a copy of the same source).
- **Sets**: a linear flow splice `do → set(slot1=original) → set(slot2) → … → set(slotN) → next` (the `lowerVectorAttrs` component-write shape); `value_${i}` edges retarget to clone i, `_port_value_${i}` copies to the clone's `_port_value`, the original's former `next` consumers re-source from the LAST clone. Slots execute in slot order — async read-after-write matches a hand-built chain (the hazard analyzer sees the expanded chain natively; runtime-verified: a post-write multi-get reads the just-written values).
- **Stale slot edges are DROPPED**, never passed through: an unmapped `value_${i}` source handle on a single-output get would silently resolve to the slot-1 variable (`varName` falls back to `_v<id>`) — reading the WRONG attribute.

### Editor
- [effectivePorts.ts](src/modeler/vpl/effectivePorts.ts) + CaNode both push **`buildExtraSlotPorts(nodeType, config, model)`** (exported from multiAttrExpand.ts — the ONE port builder, so the two can't drift): labels = the slot attribute's NAME, get slots output `any` (vector attr → `vector`), set slots input with a **type-adaptive inline widget** (bool/tag/number by the slot attr's type; none for vector/color/NI — the same mapping as the primary's `effectiveWidget` swap). CaNode's widget block resolves per-slot **tagOptions** for `value_${i}` tag widgets; the slot-row config UI (per-slot dropdown + `+ Attribute` / `− last`) renders after each node's primary dropdown; collapsed labels append ` +N`. The existing port-id-signature `updateNodeInternals` effect re-measures handles on slot changes for free.
- **`slotVectorDims(nodeType, portId, config, model)`** — the port-aware sibling of `vectorPortDims` for `value_${i}` ports, consulted by `isValidConnection` so a vector attr in an extra slot wires vector↔vector only. Scalar slots behave like other dynamic ports (permissive, same as switch case ports).
- [nodeValidation.ts](src/modeler/vpl/nodes/nodeValidation.ts): per-slot "Select an attribute (slot N)" badges using the same graph-aware scope per node type as the primary. [ModelContext.tsx](src/model/ModelContext.tsx) `REMOVE_ATTRIBUTE`/`REMOVE_AGENT_ATTRIBUTE` cascade `clearDeletedSlotIds` — clears `attr_${i}` keys naming the deleted attribute, SCOPED to `MULTI_ATTR_TYPES` so `moveSelfToNeighbor`'s payload slots keep their existing behaviour.

### Verified
tsc + build clean. Cell grid: exact values through the **real worker on all 3 targets** (multi-get o1=532 / wired slot o2=3 / inline slot o3=7.5 / multi model-attr o4=6004; WebGPU `useWebGPUStatus ready:true` = device shader-compiled), async read-after-write through the expansion (97, not the stale 32), vector-attr-in-slot (54) + 3-target compile. Agents: `scripts/parity-agent-wasm.mjs` gained a **permanent multi-slot synthetic** (own get/set + by-id pair with fan-out, wired + inline slots, async agent hazard) — 12/12 bit-parity. Regression: GoL (2D WASM) + Life3D (3D WASM) step clean; extraCount=0 is the same-array-refs no-op.

---

## Bond-Graph Agents — Floating Cells (milestone, branch `agents_floating_cells`)

*(continued from `CLAUDE.md`; other parts of this milestone live in sibling area docs.)*

### Parameterized Input Mappings — declared parameters replace hardcoded R/G/B (branch `polishing`)

*"We must abolish the assumption that input mappings will have r,g,b."* A Colour→Attribute mapping
declares its own named **parameters** (name + type); each becomes value-output ports on its event
root, one type-adaptive widget in the brush panel, and one assignable row in the image-import
dialog. A brush that stamps `species = Predator, energy = 40, hungry = true` now says exactly that
instead of encoding it in a colour the graph has to decode. Design authority:
[docs/IMPACT_MAP_PARAM_INPUT_MAPPINGS.md](docs/IMPACT_MAP_PARAM_INPUT_MAPPINGS.md) +
[PLAN_PARAM_INPUT_MAPPINGS.md](docs/PLAN_PARAM_INPUT_MAPPINGS.md) (+ `.html` mockup); **the v2
follow-ups F1–F7 — brush-geometry outputs, image→agent-population init, a `vector` parameter type,
retiring the WASM entry, the empty-`mappingId` asymmetry, parameter presets, and an inline tag list
as a graph-side tag SOURCE — are recorded in the
Impact Map's own Follow-ups register** and are the candidates to fold into
[HANDOFF_CLARITY_SIMPLIFICATION.md](docs/HANDOFF_CLARITY_SIMPLIFICATION.md) §3.

**The compile surfaces are JS + WASM for cells and JS only for agents** — there is no WebGPU
input-mapping shader (finding below), so "all targets" here means those two plus an unchanged
CPU-patch path on WebGPU. Shipped in three phases: **1** the resolver + ports + both cell compilers
+ the worker ABI + the brush panel (deliberately user-INVISIBLE — no editor, so every model still
resolved LEGACY); **2** the parameter editor + the edge cascade + cell/agent consistency; **3** the
image channel→parameter assignment + the docs sweep. `check-compile-identity` was **29 models, zero
diffs at every phase**.

- **`src/model/inputMappingParams.ts` is THE RESOLVER — the single source of truth.** NOTHING else
  may read `mapping.parameters` (only the reducer and, from Phase 2, the editor). A grep for
  `\.parameters` outside it should stay that short. **⚠ `undefined` ≠ `[]`**: absent means the
  LEGACY colour parameter, an EMPTY array means deliberately no parameters (a stamp that ignores the
  brush) — any `parameters?.length ? … : legacy` test silently mis-classifies `[]`, which is exactly
  why the distinction is made in ONE place. The `resolveMaxBonds` / `resolveAxes` discipline.
- **THE LOAD-BEARING ABSTRACTION: a parameter has N CHANNELS** — `color` → 3, every other type → 1.
  The port list, the ABI argument list and the paint `values` payload are ALL the flat channel list,
  in declared order. A `color` parameter is therefore THREE integer channel ports (`tint_r/_g/_b`),
  **not** a composite `color` port: the legacy default must expose ports named exactly `r`/`g`/`b`
  (or every existing wire's `output_value_r` handle dangles), an entry root that ORIGINATES a
  composite is a new producer kind `expandComposites` has no vocabulary for, and the ABI is a flat
  list of numbers either way. The brush still shows ONE `ColorField` for it — the split is an engine
  detail, not a UI one.
- **THE GOVERNING SAFETY PRINCIPLE — absent `parameters` ⇒ byte-identical emit on every surface.**
  The legacy resolution mints one `color` parameter whose channel ports are `r`/`g`/`b`, whose JS
  ABI names are `_r`/`_g`/`_b` and whose WASM params are indices 1/2/3 as **i32**. The JS header and
  the single-line triple-`const` alias fall out of the generic channel loop with NO branch, so
  `check-compile-identity` is **29 models, zero diffs** — verified at every step, and proven
  load-bearing by a source mutation (joining the alias line with two spaces instead of one produces
  9 diffs). **RESOLVER, NOT MIGRATION** (D1): the correct legacy value is a CONSTANT, not something
  inferred from usage, so no `.gcaproj` is rewritten and load→save is unchanged.
- **Dynamic ports.** Both roots' `def.ports` shrink to just `do`; `buildInputParamPorts` is the ONE
  builder consumed by BOTH `effectivePorts.getEffectivePorts` AND `CaNode`'s derivation (the
  `buildCensusPorts` / `buildExtraSlotPorts` dual-consumption discipline — if those drift,
  drag-and-drop offers ports the canvas never renders). Handle remeasure is free: CaNode's
  `portIdSignature` effect already fires `updateNodeInternals` on any port-set change.
  `getEffectivePortsForType` forwards no model, so the builder returns the LEGACY shape with none —
  also the right answer for a freshly-dropped root (`mappingId: ''`).
- **STALE EDGES ARE REPORTED, NEVER REPOINTED** (the `STALE_SLOT_HANDLE` rule). An edge leaving a
  root through a channel port the parameters no longer produce would resolve to `_v<rootId>_<goneKey>`
  — an identifier no alias line declares. `detectDanglingRefs(nodes, model, edges?)` gained an
  optional EDGES argument (both compile call sites pass it) and names it:
  *"…is wired from a parameter its mapping no longer declares (energy)"*; `detectMissingConfig`
  badges the same case in the Modeler (it reads the connected-handle set, which carries OUTPUT
  handles too), and separately badges a WIRED root whose mapping declares `[]`.
- **WASM — the highest-risk surface, and why it is not clamped to JS.** `EntryPointOpts.paramOutputs`
  became `Record<string, LocalRef>` so each channel's VALTYPE travels with it, updated at **BOTH**
  mirrored registration sites (the second runs after the per-cell cache clear). A parameterized entry
  mints a function type PER ARITY — `(i32 idx, f64 c0 … f64 cN)`, appended AFTER the fixed type block
  (`baseTypeCount` mirrors the `sparse` branch) so a legacy module's type section is untouched;
  legacy keeps `TYPE_IDX_IDX_RGB` verbatim. **Uniform f64 for every declared channel** rather than
  per-type i32/f64: one arity key, matches the JS + agent ABIs, and exact for every integer/bool/tag
  value a brush can produce (≤ 2⁵³). Emitting on WASM at all is NOT optional: `importImage` runs the
  input-mapping fn ONCE PER CELL over the whole grid (25 M invocations at 5000²) — paint is event
  tempo, image import is not, so a JS clamp would be a silent performance cliff. **⚠ A wrong valtype
  here does not crash** — it reinterprets an f64 param's bits as an i32 local and produces plausible,
  deterministic garbage.
- **⚠ THERE IS NO WebGPU INPUT-MAPPING SHADER** (a code-reality finding that shrank the scope): the
  WGSL emit produces only `step`, `init` and `outputMapping_<id>`. On the WebGPU target a paint is
  `readbackAttrs` → the **JS** fn on the CPU → `patchWebGPUCells`. **The compile surfaces are JS +
  WASM for cells and JS only for agents.** (Both stale "inputColor is an entry-point shader" claims
  — `webgpu/compile.ts`'s `emitVariableDeclsWgsl` comment and this file's Local Variables bullet —
  were corrected in Phase 3.)
- **The worker payload is MESSAGE-LEVEL `values: number[]`** (D5), on `PaintMsg` AND
  `PaintAgentsColorMsg` — so the cell and agent messages are structurally IDENTICAL, and the per-cell
  `r,g,b` is gone (all five producers read one brush state per stroke, so it was dead generality plus
  an allocation per painted cell). Legacy resolves to `[r, g, b]`, so both handlers' spreads are the
  historical calls. **The colour read moved from the five producers to the FLUSH** — one read per
  stroke, and a mid-drag change now lands on the rest of the stroke (the Manual Brush's rule).
- **`importImage` — see the Phase 3 subsection.** The message carries an explicit per-channel
  ASSIGNMENT (`channels?: ImageChannelSource[]`); ABSENT ⇒ the legacy `[r, g, b]`, verbatim.
- **Brush panel.** `InputParamsPanel` ([src/simulator/InputParamsPanel.tsx](src/simulator/InputParamsPanel.tsx))
  is the sibling of `ManualBrushPanel`, used by the cell brush AND the agent Paint brush. Two
  deliberate differences from Manual, which their opposite semantics require: **no per-row checkbox**
  (a parameter is an ARGUMENT — always passed) and a `color` parameter is ONE `ColorField`. The
  modifier+RMB colour popover and the "Shift+RMB color" hint are **hidden** for a parameterized
  mapping — there is no brush colour to edit, and an enabled-but-inert control is the one thing the
  UI must not do. (Binding the popover to a chosen COLOUR parameter was considered and NOT taken:
  the parameter's own `ColorField` already opens a swatch popover with the same picker, so a second
  modifier-gesture route to the same control would be a second way to do one thing.)
- **DEFAULTS + a BOUNDED slider + the tag-index answer (the 2026-08-11 polish round).**
  - **Every parameter type gets a DEFAULT widget in the editor** (`ParamDefaultWidget` in
    [MappingsPanelContent.tsx](src/modeler/panels/MappingsPanelContent.tsx)), not just `color` —
    a number field, a bool select, the tag option select, the colour swatch. Its value is read
    through **`paramFallbackValue`**, the SAME resolution `encodeChannelValues` falls back to, so
    the widget cannot show one number while an untouched brush paints another. **The seeding
    needed NO new plumbing**: `InputParamsPanel` already rendered `values[key] ?? paramFallbackValue`
    and `defaultImageChannelSources` already seeded its CONSTANT channels through
    `encodeChannelValues`, so declaring a default now reaches the brush row, the paint payload and
    the image dialog at once. What was missing was only the UI to declare it.
  - **A numeric parameter with BOTH `min` and `max` renders a range slider beside its number
    field** — the Model Attribute bounds pattern (`hasBounds && min != null && max != null`),
    reused verbatim: `step = 1` for integer, `(max − min) / 100` for float, with the same min/max
    on the `NumberField` so a typed value clamps exactly as a drag constrains. Either bound blank
    ⇒ the plain field (an unbounded slider has no meaningful extent). **Cells and agents share the
    component**, so both got it.
  - **A row that differs from its default grows a `⟳` reset** (hidden when it matches — the
    standing "an enabled control must do something" rule).
  - **⚠ THE TAG-OPTIONS COMMA BUG, and the rule it re-teaches.** The inline option list stores a
    string ARRAY, so the old controlled `<input>` round-tripped `options.join(', ')` ⇄
    `text.split(',').map(trim).filter(Boolean)` on EVERY keystroke — and that round trip is lossy
    for exactly the character you must type to add an option: `"a,"` parses to `['a']` and renders
    back as `"a"`, so the comma was eaten on the next render and a second option could not be
    started (the user's report: *"it only works if I write both options together, then add a comma
    in between"*). Fixed with the repo's standard **draft/commit** discipline (`TagOptionsInput`,
    the `CustomLabelInput` / `NumberField` precedent): free text while editing, parse once on
    blur/Enter, and a resync effect keyed on the COMMITTED text so a mid-edit draft is never
    clobbered. **GENERAL RULE: never make a controlled input's `value` a lossy transform of the
    stored shape** — if the stored shape is not a string, the field needs a draft.
  - **THE TAG SEMANTICS, stated where the user asks the question.** A tag channel carries the
    option **INDEX** on every target — that is the whole payload. So an INLINE list is ad-hoc: it
    names the choices in the brush panel, but nothing else in the model knows those names and a
    graph-side Get Constant / Compare / Switch can only compare the number. Binding a tag
    **ATTRIBUTE** gives the identical index with the names available to every tag-aware node. The
    editor now says so under an inline list AND prints the live index map (`0=idle, 1=walk, …`).
    **Making the inline list a graph-side tag SOURCE was investigated and deliberately NOT shipped
    — it is compiler-gate-visible** (`danglingRefs`' `KEY_SPACE` maps `tagAttributeId` to the
    ATTRIBUTE id space, so a synthetic `param:<mid>:<key>` fails the pre-compile gate) and it needs
    its own index-remap cascade in `UPDATE_MAPPING` (a reorder would otherwise silently re-point
    every stored constant). Recorded as **F7** in
    [IMPACT_MAP_PARAM_INPUT_MAPPINGS.md](docs/IMPACT_MAP_PARAM_INPUT_MAPPINGS.md) with the full
    blast radius.
- **Persistence (D6)** mirrors the Manual Brush exactly: declared values live in a per-model
  `genesisca_input_params_v1:<modelName>` key as `Record<mappingId, Record<paramKey, string>>`, with
  a signature-keyed merge over every C→A mapping × its parameters' key AND type (so a retype
  re-derives one row while a rename leaves brush state alone). **No `SimulationState` field, no
  `fileOperations` change** — the LEGACY colour keeps living in `brushColor`, so every existing
  `.gcastate` and "Save with simulator controls" round-trips unchanged. *(Deviation from the impact
  map, which sketched the store keyed by CHANNEL: keying by PARAMETER is the same information and
  lets a `color` parameter round-trip as the one hex its widget edits.)*
- **Gate — [scripts/test-param-input-mappings.mjs](scripts/test-param-input-mappings.mjs) — Phase 1 half (of 202 total; §12 covers the defaults / tag-index / comma-bug round).**
  The library gives ZERO coverage for the new path (every shipped model has `parameters` absent), so
  byte-identity proves we broke nothing and proves NOTHING about whether the feature works. This
  builds models in memory and asserts **VALUES** through the real compiled fns on JS **and a real
  instantiated WASM module in Node**: the resolver's legacy shape, channel order, `[]` ≠ `undefined`,
  the two port builders agreeing, the legacy emit SHAPE + the `(i32,i32,i32,i32)` type, a
  6-channel round-trip (JS exact, WASM bit-identical), the minted `(i32, f64×6)` type, the stale-edge
  error + badge, a zero-channel entry that still paints, and the agent twin. **⚠ Check 5 — a `float`
  parameter carrying `0.1` (and `1/3`) arriving intact — is the ONLY gate that catches a stale
  `valtype: I32`; write it first.** **Negative-controlled by SOURCE MUTATION**: forcing `paramRefs`
  back to I32 fails 2 checks (the module stops validating), and forcing the WHOLE parameterized ABI
  to i32 — which VALIDATES and RUNS — fails 7, with `2.5` arriving as `2` and `0.1` as `0`, exactly
  the predicted silent-garbage mode.

#### PHASE 2 — the parameter editor, the edge cascade, cell/agent consistency

- **THE PREREQUISITE NOBODY PLANNED FOR: A RESOLVER'S DEFAULT MUST BE REPRESENTABLE.** The editor
  shows the RESOLVED list, so the FIRST edit of a legacy mapping has to MATERIALISE it
  (`materialiseInputParams`) — and under Phase 1's rules that materialised parameter (key `color`,
  type `color`) minted `color_r`/`color_g`/`color_b`, so **"I added a second parameter" would have
  silently dangled every wire out of the root**. Fixed in the resolver: **`color` is a RESERVED key**
  — a colour parameter keyed exactly `LEGACY_COLOR_PARAM_KEY` mints the historical un-prefixed
  `r`/`g`/`b` + `_r`/`_g`/`_b`, so writing the resolver's own output back is a no-op for ports, ABI
  **and the emitted character stream**. `mintParamKey` never hands that key to a NEW parameter, so
  only the materialised default can hold it. Every other resolver in this codebase already satisfied
  this by construction (`resolveMaxBonds`, `resolveAxes`, `agentAbiShapeOf`); this one now does too.
  `legacy` still means strictly *"the field was ABSENT"* — a materialised mapping is NOT legacy (it
  gets the parameter panel and the f64 WASM signature); only its CHANNELS are identical, which is the
  part wires and emits depend on.
- **THE EDGE CASCADE — `patchAllEdges` ([ModelContext.tsx](src/model/ModelContext.tsx)), genuinely new
  machinery.** `patchAllNodes` rewrites node CONFIGS; **nothing in the reducer removed EDGES on a
  model edit** until now. `patchAllEdges` is its sibling — same four stores (Cells / Agents /
  Overseer / every macroDef), same array-identity preservation when nothing matched (so an edit that
  prunes nothing cannot re-render every graph), and its predicate receives the edge's SOURCE NODE
  (edges carry only ids). ⚠ Its result carries `macroDefs` too, so a site spreading BOTH it and
  `patchAllNodes` would have the second spread win — combine deliberately; no current site needs both.
- **`removedChannelPortIds(before, after)` is THE CASCADE RULE, in the resolver** — shared by the
  reducer (which prunes) and the harness (which asserts), so the two cannot disagree about what
  "removed" means. **DROP, NEVER REPOINT** (the `STALE_SLOT_HANDLE` rule: a re-aimed edge silently
  resolves to the WRONG value). Wired into `UPDATE_MAPPING` **and** `UPDATE_AGENT_MAPPING`, gated on
  `'parameters' in changes` and returning `null` when nothing was destroyed — so a rename, a reorder
  and every non-parameter edit never walk the graphs at all. What moves wires: **rename → nothing**
  (ports are keyed by `key`, which is why they are separate fields) · **retype scalar↔scalar →
  nothing** · **retype across the colour boundary → the removed channels' edges** · **delete / `[]` →
  all of that parameter's edges**. `detectDanglingRefs` + `detectMissingConfig` stay as the BACKSTOP
  for a hand-edited file.
- **The editor** (`InputParamsEditor` in [MappingsPanelContent.tsx](src/modeler/panels/MappingsPanelContent.tsx))
  is ONE component used by the CELL C→A mappings **and** the AGENT ones, so the two layers cannot
  drift. Row = `[name] [type ▾] [×]` + the type-specific block (min/max · tag source [a live tag
  ATTRIBUTE or an inline list] · colour default) + a per-parameter description + a live `ports: …`
  readout + a `⋮⋮` reorder handle; `+ Parameter` appends. **`key` is deliberately NOT editable** — a
  key change IS a delete + re-add, and offering it as a text field would make every keystroke a
  wire-dropping event. Reordering keeps every wire but DOES change the ABI order (a recompile, and
  correct). **The three R/G/B channel textareas are now A→C-ONLY** — for C→A they documented a
  HARDCODED encoding the user then had to re-implement in the graph, and each parameter's own
  description replaces them; for an OUTPUT colour, documenting three channels is still a real thing.
- **The agent side needed no reshape** — Phase 1 had already unified it (one `buildInputParamPorts`
  for both roots, the resolved channels in `compileAgentGraph`'s emit, a structurally identical
  `paintAgentsColor { values }`, and `InputParamsPanel` in the agent Paint brush). Phase 2 adds the
  editor + the cascade on `agentMappings`, and corrects the last "R/G/B outputs" prose. The `'input'`
  ABI kind is untouched by construction: the brush channels are PREPENDED by the caller, outside the
  shared descriptor.
- **Gate — the harness grew 62 → 111 checks** (§9 materialisation, §10 the cascade). The cascade is
  driven through the **REAL reducer** (`modelReducer` is exported and bundles cleanly in Node — it
  calls no React API), so what the harness exercises is what the app dispatches, gate and all:
  delete drops exactly one edge and keeps the unrelated ones, a colour delete drops all three, retype
  colour→float drops two, rename/reorder keep every wire AND edge-array identity, `[]` drops all,
  materialisation preserves the r/g/b wires (and a materialise-then-add still does), the cascade is
  SCOPED to the edited mapping, and the same on the AGENT store. **Negative-controlled by SOURCE
  MUTATION — 3 mutations, 3 caught**: an over-dropping cascade (7 failures), a REPOINTING one (8),
  and removing the reserved-key rule so materialisation moves the ports (7).
- **Real-UI verified end to end** (dev server, real clicks, real worker): the editor renders for a
  shipped legacy mapping showing `Brush colour · Color · ports: r, g, b`; a real `+ Parameter` click
  MATERIALISES it and the existing `output_value_r` wire SURVIVES; a rename keeps the key and the
  wire; a real `×` on the colour parameter drops **exactly** that one value wire (total edges −1) and
  keeps the flow wire, after which the model still compiles clean with ZERO badges on the root. A
  4-parameter / 6-channel fixture paints through the real load→compile→ship→worker chain on the WASM
  target with **all six values exact (`7.25`, `2`, `1`, `10/20/30`), untouched cells still 0**; the
  AGENT twin paints agents 1 and 4 with all five channels exact while 0/2/3/5 stay 0, and deleting a
  wired agent parameter drops exactly its edge with the cell graph untouched. All four shipped legacy
  Wireworld brushes still write their real attributes. 0 console errors. ⚠ **Verification trap**: the
  worker's `getState` attribute records carry the **ATTRIBUTE** type (`'float'`/`'integer'`/`'bool'`),
  not the buffer type — decoding a Float64 buffer as `Uint8Array` reads byte 0 of each double and
  reports a convincing all-zeros "the paint did nothing".

#### PHASE 3 — the image channel→parameter assignment, and the docs sweep

- **ONE message field, ONE rule: `ImportImageMsg.channels?: ImageChannelSource[]`** — one entry per
  RESOLVED channel, in the flat channel (= ABI) order, each either
  `{kind:'pixel', ch:'r'|'g'|'b'|'a'|'lum'}` or `{kind:'const', value}`. **ABSENT ⇒ LEGACY ⇒ the
  per-cell payload is exactly the pixel's `[r, g, b]`**, byte-for-byte the historical import (alpha
  ignored, as it always was). This REPLACED Phase 1's `values?: number[]` baseline, whose worker-side
  "overwrite the first three channels with R/G/B" was a SECOND implicit assignment rule living in the
  worker; now the main thread always sends the explicit list (the dialog's table, or
  `defaultImageChannelSources` for the paths that never open it) and the worker resolves, never
  decides. `resolveImageChannelValues(sources, r, g, b, a, out?)` is the shared resolution the worker
  calls per cell with a **REUSED scratch array** — the payload is spread into the call immediately
  and never retained, and this runs 25 M times at 5000².
- **THE AUTO-ASSIGNMENT IS COLOUR-FIRST, not first-three-channels** (`defaultImageChannelSources`):
  the first `color` parameter takes R/G/B; if the mapping declares none, the first three channels do;
  everything else is a CONSTANT seeded from the brush panel's current value for that parameter. The
  Impact Map proposed the flat rule; for `[bool alive, color tint]` that would feed R into `alive`
  and split `tint` across G/B/const — visibly wrong. Colour-first also makes a MATERIALISED legacy
  mapping resolve to exactly the historical `[r, g, b]`, so materialising a mapping does not silently
  change what an image import does. The default is safe to be smart **because the dialog SHOWS it**.
- **`pixelLuminance` (BT.601) is now ONE formula, shared** — `imageMapping.ts`'s private `lum`
  DELEGATES to the resolver's export. Binarize collapses a pixel to black/white by that measure, so
  a `lum` source over a binarized image must read back exactly the 0/255 that decision produced; two
  copies of three constants is the drift class this repo keeps closing. (A deliberate deviation from
  the Impact Map's *"keep `imageMapping.ts` completely unchanged"* — which meant its SAMPLING
  SEMANTICS, unchanged here; the delegation is a pure export move in the correct dependency direction,
  simulator → model.)
- **The dialog's table is at CHANNEL grain** (`ChannelRow` in
  [ImageMappingDialog.tsx](src/simulator/ImageMappingDialog.tsx)) — a `color` parameter is THREE
  independently-assignable rows (Tint R / Tint G / Tint B), which is what an image import wants; the
  BRUSH panel is deliberately the opposite (one swatch, because there the split is an engine detail).
  The constant widget is type-adaptive per channel (bool → a select, tag → its option NAMES, else a
  number), so a tag constant is never a bare index. Shown **only** for a non-legacy mapping; a
  legacy one gets today's dialog verbatim, and `parameters: []` gets an honest note (the image then
  decides only WHICH cells are written, not what they become). The assignment re-seeds on the
  CHANNEL SIGNATURE (the flat port-id list), never on a mere re-render, so a user's edits survive.
- **Average / invert / binarize are PIXEL-SPACE and stay meaningful** under parameters (they change
  what r/g/b/lum read) — so they are NOT gated on parameters. They ARE **greyed in place with the
  reason in a tooltip** when EVERY channel is a constant, because then the image is not sampled at
  all: that is the doctrine's "temporarily unavailable, one control away ⇒ disable in place" arm.
- **Show Code no longer asserts `(_r, _g, _b)`** (`inputChannelBlock` in
  [showCode.ts](src/simulator/showCode.ts), used by BOTH the cell and agent input-mapping blocks):
  the brush arguments are printed FROM THE RESOLVER, ahead of the ABI table, and a `tag` parameter
  additionally prints its option→index table (the lookup-table convention). Show Code's whole job
  after `250e645` is to be a PORT-READY document, so a parameterized mapping claiming the legacy
  triple would have described code that is not the code beside it.
- **The docs sweep**: HelpView gains *"Input Mapping Parameters"* under Mappings + rewritten brush,
  image-import, node-catalogue and Agent-Input-Mapping paragraphs; `docs/NODES_REFERENCE.md`'s two
  root rows become "DYNAMIC — one value output per declared parameter" with a header note naming the
  resolver; README needs no change (its Features summary is one-to-three-sentence product copy and
  the input mapping is not one of its groups).
- **Gate — the harness grew 111 → 133 checks** (§11, the image path). It drives the SHIPPED
  `resolveImageChannelValues` into the REAL compiled input-mapping fn once per pixel and asserts the
  written attribute VALUES on JS **and a real instantiated WASM module**, over a deliberately
  NON-default assignment (`strength ← lum`, `species ← const 2`, `flag ← alpha`, `tint ← R/G/B`) so a
  hardcoded first-three rule anywhere in the chain fails; plus the auto-assignment rule (colour-first,
  brush-value seeding, `[]`), the per-source resolution, the reused-scratch contract, `lum` agreeing
  with `gridifyImage`'s own binarize mask, and the LEGACY import writing exactly the pixel r/g/b.
  **Negative-controlled by SOURCE MUTATION — 3 mutations, 3 caught**: `lum → r` (3 failures incl.
  both E2E arms), dropping the colour-first rule (3), and a scratch slot left stale (1 — and the
  first version of that check MISSED it, because it reused the same constant on both calls; the
  check now varies both a pixel source AND a constant).
- ⚠ **`check-compile-identity` hashes EMITTED output, not compiler source** — verified empirically
  here by editing a comment in `webgpu/compile.ts` and re-running (29/29 unchanged). A comment fix in
  a compiler file is safe; a change to an emitted STRING (including an error message) is not.

**B — agent sprites (an optional exhibition layer; static image / animated GIF/WebP per agent).** `CAModel.sprites?: SpriteAsset[]` ([types.ts](src/model/types.ts): `{ id, name, dataUrl, mimeType, scale?, loop? }`) — additive, travels in the `.gcaproj` as a base64 data URL. `ADD/DUPLICATE/REMOVE/UPDATE/REORDER_SPRITE(S)` reducers ([ModelContext.tsx](src/model/ModelContext.tsx)); `REMOVE_SPRITE` cascades `clearDeletedId('spriteId')` over `setAgentSprite` nodes. **Decode is MAIN-THREAD only** ([spriteRegistry.ts](src/simulator/spriteRegistry.ts)) via WebCodecs **`ImageDecoder`** (animated GIF/WebP/PNG natively — NO new dependency; the project already uses WebCodecs for WebM recording) → `ImageBitmap[]`, with a `createImageBitmap` single-frame fallback; the worker never carries the pixels. The **`SpriteRegistry`** (keyed by sprite id, re-decodes only changed `dataUrl`s, `onReady` redraws) is owned by SimulatorView and reconciled on `model.sprites` change. **Sprite Library** UI = a "Sprites" section in the Mappings panel, **MASTER-DETAIL + DRAGGABLE, the same shape as the mappings above it** (the `767541b` agent-views conversion applied to sprites; import png/jpeg/gif/webp ≤4 MB / a frame SEQUENCE / a sprite SHEET, ≤4 MB each). The LIST is a `listItem` row per asset — a 24px thumbnail (the row's identity — a sprite is a picture), the name, a `Nf` frame-count badge for a multi-frame asset, and a `⋮⋮` reorder handle — with `+ Image / GIF` / `+ Frame sequence` / `+ Sprite sheet` / **Duplicate** / **Delete** in the button row (the last two disabled until a row is selected). The selected asset's editor (name, size×, loop, a sheet summary + its **Edit sheet grid…** dialog, the rotation block + `CompassDial`, the chroma key + its click-the-image `SpriteBgPicker`) opens in the SHARED second detail panel.
  - **The Mappings panel's ONE detail slot is now THREE-way discriminated**: a bare id = a CELL mapping, `agentmap:<id>` = an agent view, **`sprite:<id>` = a Sprite Library asset** — so picking in any layer deselects the others for free. ⚠ **`ModelerView.selectedItemName` MUST resolve the `sprite:` prefix** (against `model.sprites`) or the detail `PanelShell` — gated on `detailItemName != null` — never mounts and clicking a row does NOTHING visible; the same trap the agent-attributes and agent-views conversions each hit.
  - **Auto-select is keyed on `sprites.length`, NOT the array** (`model.sprites ?? []` mints a fresh `[]` every render), so every append path — the three imports AND Duplicate — opens the new asset's editor straight away. `DUPLICATE_SPRITE` deep-clones the whole asset (data URL, frames, sheet spec, rotation + chroma settings) with a fresh id + " (copy)" and APPENDS.
  - **Drag-to-canvas** rides a new payload kind **`{ kind: 'sprite', spriteId }`** ([modelElementDrag.ts](src/modeler/vpl/modelElementDrag.ts)), whose `RELATED_NODES` entry is the single consumer `setAgentSprite` keyed `spriteId` (+ `extraConfig: { setSprite: true }`, so the facet that READS the id is on regardless of what the node's `defaultConfig` later becomes). **It is graph-kind-gated in `relatedEntriesForPayload` exactly like `agent-mapping`** — `[]` off the Agents graph. `setAgentSprite` is `requirements.bondGraph`, so `isNodeAvailable` already keeps it out of the drop MENU there; the gate is what stops the drag HIGHLIGHT (`relatedNodePotentialPorts`, which never consults that gate) lighting up ports for a node the drop would then refuse to create. `titleByKind` in GraphEditor labels it **"Sprite"** — that Record is total, so a new kind will not compile without the entry.
- **PLAYBACK IS LOGIC-DRIVEN, NOT a simulator transport** (the core correction): the **Set Agent Sprite** node ([SetAgentSpriteNode.ts](src/modeler/vpl/nodes/SetAgentSpriteNode.ts), `requirements.bondGraph`) carries **independently-tickable facets** — *Change sprite* (config `setSprite` + `spriteId` picker), *Set frame* (config `setFrame` + the `frame` input — jump/reset), *Set speed* (config `setSpeed` + the `speed` input — frames per step, **negative = reverse**, 0 = hold). `hiddenPorts` shows the frame/speed inputs only when their facet is ticked. Tick only what you want to change (swap sprite but keep frame/speed; only change speed; reset to frame 0; …). The node writes the per-agent display buffers; a pre-resolve in `compileAgentGraph` bakes `spriteId` → a 1-based `_spriteSlot` into `model.sprites` (0 = none/clear).
- **Persistent per-agent state + engine advance** ([agentEngine.ts](src/simulator/engine/agentEngine.ts)): `AgentStore.spriteIds: Int32Array` (0=none, ≥1=slot) + `spriteFrames: Float64Array` (current frame, fractional) + `spriteSpeeds: Float64Array` (frames/step). PLAIN arrays regardless of backing (never wasm/webgpu-backed — only the JS node + engine touch them); reset to 0 in `initAgentSlot` (recycled slots don't inherit a stale sprite). **`advanceAgentSprites(store)`** does `frame += speed` for every live agent with a sprite, called per step from `runAgentStep` (and after `runAgentStepWebGPU`), gated on `hasAgentSprites` — so the animation only progresses while the sim runs (logic-driven). Unbounded by design (the render floors + wraps/clamps). The 3 buffers ride the agent loop ABI (`buildAgentLoopParams` ↔ the worker's `buildAgentLoopArgs`/`buildDivisionArgs`/`buildAgentInitArgs`, after `glyphColors`); the WASM/WebGPU behaviour ABIs are untouched (JS-only param list). The snapshot ships `spriteIds`+`spriteFrames` ONLY when `hasAgentSprites` (the z/vz "A1" length-0 gate → non-sprite agent models byte-identical); `spriteSpeeds` stays worker-side. `agentHasSprites` rides `init`/`recompile` (from `(model.sprites?.length ?? 0) > 0`).
- **Render** ([SimulatorView.tsx](src/simulator/SimulatorView.tsx) `drawAgentsOverlay`): when the snapshot's `spriteIds[i] > 0` and the sprite is decoded, blit the frame `floor(spriteFrames[i])` wrapped (loop) / clamped (once, per the sprite's `loop` flag), aspect-preserved, sized to the agent diameter × the sprite `scale`, alpha = the agent colour's A; else the existing filled circle. Bonds draw under sprites; recording/screenshot capture the display canvas → sprites for free. There is **NO simulator playback panel + NO playback rAF** (a draft built under the wrong model was removed).
- **All-target story**: Set Agent Sprite runs on **all three agent targets** — the five sprite buffers live in the shared agent memory on JS/WASM (see “Set Agent Sprite on the WASM agent target”) and get their own `agentF32` runs on the GPU (see “… on the WebGPU agent target”), so a sprite-driving BEHAVIOUR graph compiles like any other setter and never clamps the model. The one fast path it forfeits is **GPU residency** (the CPU ticks `frame += speed` once per generation); an Agent Output Mapping graph avoids even that, since OM passes are CPU-side on every agent target. Sprites render in BOTH the 2D overlay AND the **3D voxel view** (the 3D billboard pass below).
- **Verified**: tsc + `npm run build` clean; GoL + Life3D byte-clean on all 3 targets; Boids agent behaviour unregressed; a standalone agent OM graph compiles (writes `spriteIds`/`spriteSpeeds`/`colors`) + the linked path synthesizes; **runtime end-to-end** (Boids + a Set Agent Sprite OM pass, real worker): all 260 agents got `spriteId=1`, the frame advanced exactly `0.5`/step (the engine advance from the node-set speed), the snapshot shipped both buffers, the render drew sprites (canvas pixel-sample: 157k sprite-colour pixels, 0 default-circle pixels), 0 console errors. Catalogue: **115 selectable** node types (118 − 3 hidden macro), **42 agent** nodes.

## Agent-compiler branch-scope + RNG-order fixes (branch `improvements`, 2026-07-28)

Two latent defects in the **JS agent compiler's value placement**, surfaced by the Ant Necrophoresis rebuild and fixed here. Both broke the project's own JS↔WASM **bit-parity** invariant for the agent target (one by crashing, one by silently diverging). Touched: [volatileHoist.ts](src/modeler/vpl/compiler/volatileHoist.ts), [sinkAnalysis.ts](src/modeler/vpl/compiler/sinkAnalysis.ts), [compile.ts](src/modeler/vpl/compiler/compile.ts) — **no WASM / WebGPU / worker / engine file** (`agent.wasm.bytes`, `agent.webgpu.shader`, `wasm.bytes`, `webgpu.shader` and `js.stepCode` are byte-identical for every library model; only three agent models' `agent.behaviourCode` moved, and only textually — see Verified).

### Defect 1 — `usedVolatiles` over-skipped `next`, so a branch never claimed its own volatile
`computeVolatileHoist` assigns each volatile value to the FIRST member of its LCA scope whose *subtree* uses it, and the compilers force-emit it there. `usedVolatiles(F)` deliberately skipped F's `next` port (an earlier fix: a value read AFTER a loop must belong to the later sibling, not the loop). But the skip applied at EVERY recursion depth — so a volatile consumed by the **2nd or later statement of a branch body** was invisible to the branch-opening node. Ownership fell through to a LATER top-level sibling, the value was scheduled AFTER the branch that reads it, and the JS compiler's inline fallback then declared it INSIDE the branch → `ReferenceError: _v… is not defined` on the post-branch read.
- **Fix:** `usedVolatiles(flowNodeId, includeNext)`. The top-level call (a member of the LCA scope) passes `false` — the next-chain is a later sibling, preserving the loop fix. Every RECURSIVE call passes `true` — anything reached through a BRANCH port lives in a nested block where the next-chain is simply the rest of that block's statements. Cache key carries the flag.
- **This helper is SHARED with the agent WASM/WebGPU compilers** (hazard pinning), so the fix also makes a hazard-pinned read dominate its branch there. No shipped model's WASM/WGSL output changed.

### Defect 2 — the force-emit dragged a SHARED pure input into one branch
While force-emitting a volatile, `forceVolatileCurrentScope` routes EVERY emission (including non-volatile inputs reachable only through the volatile) to the current flow position — necessary because such an input is never pre-emitted and its own sink buffer was already flushed. But when that input is used from BOTH branches (sink scope `CELL_TOP`), pinning it inside the first branch left the sibling referencing an out-of-scope `const`.
- **Fix** ([compile.ts](src/modeler/vpl/compiler/compile.ts) `routeValueEmit`): under the force window, a NON-volatile node whose own sink scope is `CELL_TOP` routes to `valueLines` instead. It is pure, so cell-top always dominates, and `valueLines` is assembled ABOVE `flowLines` — safe to push to mid-walk. **A sink-scope inversion is impossible** (a producer's use-set is a superset of its consumer's, so its LCA is at-or-above), and anything depending on a volatile IS volatile — so a cell-top-sink pure value can only depend on other cell-top-sink pure values.
- Branch-scoped inputs (the documented `getRandom`-feeding-volatile-arithmetic case) keep the current position — unchanged.

### Defect 3 — RNG DRAW ORDER: JS hoisted, WASM/WebGPU emit at the use site
Evaluating an RNG node is a **side effect** (it advances the shared `_rs` stream), so WHERE it is emitted decides where the draw lands. The agent WASM/WebGPU compilers emit a draw at its flow USE SITE (RNG is in `AGENT_VALUE_NO_HOIST`); JS sink analysis hoisted a draw whose uses all sit at agent-loop top into the pre-flow value block, ordered TOPOLOGICALLY. A graph with a draw inside a branch and another after it therefore advanced the stream in a different order per target — each target individually a correct random walk, but bit-parity gone and every downstream decision diverging. Neither `setVariable` (pins the assignment, not the draw) nor reordering the cell-top block can fix it: WASM interleaves branch-local draws BETWEEN top-level ones, which a hoisted block cannot express.
- **Fix** ([compile.ts](src/modeler/vpl/compiler/compile.ts)): for a **`behaviourStep`** root, seed every RNG node into the volatile set. That routes it through `volatileHoist` — *"emit at the LCA flow scope, immediately before the consuming flow node"* — which IS flow order, matching the other targets by construction. A branch-local draw stays in its branch (volatileHoist deliberately never hoists past loops or out of branches), so entropy is still spent only when the branch runs.
- **`isRngNode(node)` is now exported from [sinkAnalysis.ts](src/modeler/vpl/compiler/sinkAnalysis.ts)** — ONE predicate shared by `isLoopPinned` (never hoist a draw out of a loop body) and this seeding (never hoist a draw above its consuming flow node). They must agree or the two rules disagree about the same node.
- **SCOPE — `behaviourStep` only, deliberately.** It is the sole root the WASM/WebGPU agent compilers emit (agent init / division event / agent output mappings are JS-on-CPU on EVERY target, so they cannot diverge), and the **CELL grid is already in lockstep** because its WASM/WebGPU compilers consume this same sink analysis. Widening it would rewrite the RNG stream of many library models for zero correctness gain.

### Verified
- **Two permanent synthetics in [scripts/parity-agent-wasm.mjs](scripts/parity-agent-wasm.mjs)** — `[synthetic] RNG draw order (branch draw + post-branch draws)` (a branch-local draw + two post-branch draws, each stored to an agent attribute so any reordering mismatches) and `[synthetic] Branch scope (value used inside AND after a branch)` (covers BOTH defect 1 — a `valueSwitch` read by the 2nd statement of a branch and again after it — and defect 2 — a `getVariable` read in both branches over a shared pure input). **Negative-controlled**: with the fixes reverted, the first MISMATCHES (`attr_sel js=0 wasm=-1`) and the second throws `ReferenceError: _v… is not defined`; with them, both pass at 30 and 250 steps.
- **Byte-identity** ([scripts/check-compile-identity.mjs](scripts/check-compile-identity.mjs), 24 models): every cell-grid surface unchanged, every `agent.wasm.bytes` / `agent.webgpu.shader` unchanged. Only **Ant Necrophoresis / Boids / Chemotaxis** `agent.behaviourCode` differ — exactly the three agent models with RNG. **Their runtime behaviour is unchanged**, proven two ways: (a) the WASM modules are byte-identical and JS↔WASM parity was green BEFORE and AFTER, so `JS_before == WASM == JS_after`; (b) the emitted diffs are textual relocations only — the draws move as a contiguous block preserving their relative order with no other draw interleaved (Boids/Chemotaxis), and Ant's hazard-volatile `r_carrying` read regroups within the same straight-line prefix, above the only write.
- All other harnesses green: `parity-agent-force` (7), `check-agent-wasm-gate` (9/9), `test-agent-abi` (28), `audit-agent-layout`, `test-ndtable`, `verify-sparse-stepping`, `test-grid-dimensions`, `test-loop-index`, `test-cross-agent-writes`, `test-positional-collision`, `tsc -p tsconfig.app.json --noEmit`.
- **Real worker, in-browser, on the JS agent target** (the changed path): Ant Necrophoresis at generation 20 000 — corpses on ground 742 + carried 12 = **754, exactly the seeded total**, 0 non-binary cells, 120 ants still on exact integer positions, clustering 3.74 vs the 0.93 random baseline; **Boids** flocks to polarization **0.9984**; **Chemotaxis** builds its field (0 → 26.9) and aggregates (occupied bins 170 → 107, cluster-sum-of-squares 332 → 610). Zero worker errors throughout.

### The invariant the fixes preserve — ONE Get Random node = ONE draw, shared
A `getRandom` (or any RNG node) is drawn **once per cell / per agent per step**, and EVERY consumer sees that same number no matter where in the flow it is read — inside a branch, after it, in a sibling branch, or through an intermediate expression. Flow-ordering a draw moves WHERE it is emitted; it never splits it into two draws (the per-node `compiled` dedup + the value cache still hold). Verified after the fixes:
- **Cell grid**: one `getRandom` feeding a `then` write, an `else` write and a post-branch write emits exactly ONE `_rs` advance per cell and all three consumers reference the same `_v<id>`. (The cell path was untouched by these fixes — the RNG seeding is scoped to `behaviourStep` — so this is unchanged behaviour, confirmed rather than altered.)
- **Agents, JS**: the same four shapes (both-top-level / branch+after / then+else / via-expression) each emit exactly one draw per agent, and the consumers read equal values.
- **Agents, JS ↔ WASM**: the `[synthetic] RNG sharing (one draw, many consumers across scopes)` entry in [scripts/parity-agent-wasm.mjs](scripts/parity-agent-wasm.mjs) covers a pre-branch read + both sibling branches + a post-branch read + an expression-mediated read. **It carries a VALUE `invariant` (see below), not just cross-target agreement** — the WASM/WebGPU agent compilers drop their value cache at branch exit (`enterCacheScope`/`exitCacheScope`), so a re-emit there would be a genuine second draw that parity alone could never see if both targets did it identically.

**New harness capability — a per-entry `invariant(store)` hook** in `parity-agent-wasm.mjs`, run on BOTH stores (JS and wasmBacked) after each step and reported as `INVARIANT(js|wasm) <message>`. Use it whenever an entry asserts a SEMANTIC property rather than "the two targets agree" — parity is a mirror test and passes happily when both sides are equally wrong. Negative-controlled: pointing the post-branch consumer at a SECOND `getRandom` makes it fail with `top 0.317… !== afterBranch 0.750…`.

### Rule of thumb this leaves behind
When adding a node whose EVALUATION is a side effect (an RNG draw, a mutable-storage read), it must be **flow-ordered on every target** — add it to `isRngNode` (or seed it into the volatile closure) rather than letting sink analysis hoist it. And when touching `usedVolatiles`, remember the two roles of `next`: a later sibling at the caller's own scope, but part of the block everywhere below.

---

## Get Grid Dimensions (universal node — Cells AND Agents, all 6 compile surfaces)

A value node exposing the SIZE of the world the rule runs in: **Width**, **Height** and (3D only) **Depth**. It is **UNIVERSAL** — available on BOTH the Cells graph (the lattice grid size) and the Agents graph (the agent world size; the agent world IS the cell grid **1:1**, so the two report the same numbers, and the node renders as **"Get World Dimensions"** there via `agentLabel`/`agentDescription`). It reads no per-cell / per-agent state, so it works in **every event on both graphs** (Step / Init / Grid Init / Input Mapping / Output Mapping — Behaviour Step / Agent Init / Division Event / Agent Output Mapping).

**Center outputs** (`centerX`/`centerY`/`centerZ` = ⌊W/2⌋ / ⌊H/2⌋ / ⌊D/2⌋, matching the hand-wired `size/2`-then-truncate idiom): opt-in via the **`withCenter` config checkbox** ("Output center") — but the checkbox is **UI declutter ONLY**: `hiddenPorts` hides the three ports when off, while **every compiler emits the centres UNCONDITIONALLY** (three cheap loop-invariant constants), so a wire into a centre port keeps working if the checkbox is later unticked (the stale-edge-on-hidden-output trap). `centerZ` is additionally hidden in 2D (value 0 there). Per-surface emit: JS cell `Math.floor(W/2)`; WASM/WebGPU cell bake the floored literal; JS agent `Math.floor(_fieldW/2)` (centerZ from the derived depth); agentWasm `floor(field* × 0.5)` (exact for integer dims ⇒ JS↔WASM bit-parity); agentWebgpu `floor(control.field* * 0.5)` (f32, exact for grid-scale ints).

**Why:** a rule that wants to be grid-size INDEPENDENT (seed the middle, normalise a coordinate to 0..1, fade by distance from an edge, keep agents inside the world) previously had to hard-code the dimensions — silently wrong the moment the user hits the simulator's **Resize** — or route them through the one event root that happens to expose them (Grid Init's width/height/depth, Init Event's maxX/maxY, Agent Init's World Width/Height). The values are always **LIVE**: nothing is baked into the `.gcaproj`, and a simulator Resize recompiles through the `dimsModel` override, so the node reports the real dims.

### Emit — no ABI change anywhere; W/H/D were already in scope on all six surfaces
- **JS cell** ([GetGridDimensionsNode.ts](src/modeler/vpl/nodes/GetGridDimensionsNode.ts)): the `W` / `H` / `D` step params (`D` only exists in a 3D signature → 2D emits the literal `1`, keeping 2D byte-identical).
- **WASM cell** ([wasm/compile.ts](src/modeler/vpl/compiler/wasm/compile.ts)): `i32` constants baked from `ctx.model.properties` (exactly how `initEvent` bakes maxX/maxY).
- **WebGPU cell** ([webgpu/compile.ts](src/modeler/vpl/compiler/webgpu/compile.ts)): `i32` literals baked from `ctx.layout.gridWidth/Height/Depth` (`gridDepth` is 1 in 2D).
- **JS agent**: `_fieldW` / `_fieldH`. **Depth derives from `_fieldTotal`** — `_fieldD` is **NOT in the Agent Init Event's ABI** ([agentAbi.ts](src/modeler/vpl/compiler/agentAbi.ts)'s trailing 3D block omits it for `kind === 'init'`), so a naive `_fieldD` emit would `ReferenceError` the moment the node is dropped in an Agent Init Event. The derived form `((_fieldW > 0 && _fieldH > 0) ? Math.round(_fieldTotal / (_fieldW * _fieldH)) : 1)` is correct in **all four** agent roots — the SAME trick the Agent Init Event's own World Depth port uses.
- **WASM agent** ([agentWasm/compile.ts](src/modeler/vpl/compiler/agentWasm/compile.ts)): the behaviour's `fieldW` / `fieldH` / `fieldD` f64 params (always present; `fieldD` = `s.worldDepth`, i.e. 1 in 2D). In `AGENT_WASM_SUPPORTED_TYPES`.
- **WebGPU agent** ([agentWebgpu/compile.ts](src/modeler/vpl/compiler/agentWebgpu/compile.ts)): `control.fieldW` / `fieldH` / `fieldD` (always in the Control uniform). In `AGENT_WEBGPU_SUPPORTED_TYPES`.

### `CompileContext.agentGraph` (new)
A universal node's `compile()` has no idea which ROOT it sits under, but it must emit against the right ABI. `agentGraph` is true for **all FOUR** agent roots (`AGENT_ROOT_TYPES` in [compile.ts](src/modeler/vpl/compiler/compile.ts)) — **distinct from `agentRoot`**, which is `undefined` on `agentOutputMapping` (it only tags the three roots whose live-agent guard differs). Any future universal node that reads the same thing from a different ABI on the two graphs should branch on `agentGraph`, NOT on `agentRoot` (an agent OM graph would otherwise emit the cell `W`/`H` and blow up).

### Registration checklist (what a multi-output universal value node needs)
`MULTI_OUTPUT_TYPES` (3 ports) ✓; **NOT** `NEVER_INVARIANT` — it has no value inputs and reads only function PARAMS, so loop-invariance correctly hoists it out of the per-cell / per-agent loop (contrast `getCellPosition`, which reads the per-cell `_row`/`_col` and MUST be `NEVER_INVARIANT`); **NOT** `NEVER_PURE_TYPES` — the dims are immutable, so two instances CSE-merge (a free win); **NOT** `LATTICE_ONLY_TYPES` + **no `requirements`** = the definition of "universal" (available on both graphs); **NOT** in `OVERSEER_UNIVERSAL_TYPES` — the overseer driver's preamble provides no `W`/`H`, and baking them would go stale after a simulator Resize. No `detectMissingConfig` case (no config). `hiddenPorts` hides `depth` in 2D via `is3dModelLike`.

### Latent bug fixed in the same pass
`agentWebgpu`'s `emitBehaviourStep` had **no `myZ` case**, so a 3D model wiring **Behaviour Step → Z** silently read `0.0` on the WebGPU agent target while JS/WASM read `_agentZ[idx]`. No shipped model wires it (byte-identity confirms), so this was latent. Gated on `ctx.is3d` (the `z` SoA run only exists in 3D).

### Verification
- **[scripts/test-grid-dimensions.mjs](scripts/test-grid-dimensions.mjs)** (the regression standard for this node): availability (universal / hidden on Overseer / Depth hidden in 2D); **cells 2D + 3D compiled AND RUN** — the JS step and a **real instantiated WASM module in Node** both leave every cell holding exactly W/H/D, JS↔WASM bit-identical; WGSL bakes the literals; **agents 2D + 3D** — the JS behaviour loop RUN (every agent holds W/H/D), the **Agent Init Event RUN through the real spawn idiom** (Create Agent lands at x=W, y=H, z=D — the `_fieldD`-absent trap), both agent gates accept the node, both modules/shaders compile.
- **[scripts/parity-agent-wasm.mjs](scripts/parity-agent-wasm.mjs)**: a permanent synthetic 3D grid-dims agent model (`buildGridDimsModel`) → 13/13 JS↔WASM bit-parity. NB parity alone would pass if BOTH targets were wrong — the value assertions live in `test-grid-dimensions.mjs`.
- **[scripts/check-compile-identity.mjs](scripts/check-compile-identity.mjs)**: all 23 library models byte-identical on every surface.

---

## Rule Cadence — `Get Generation` (universal) + `Agent Periodic Step` (agents) — branch `GRA`

Gives the rule graph control over **when** it runs. Cadence is *model semantics* — "rewrite the graph every 10th generation, update states on the others" is a property of the automaton, not an engine knob — so it lives in the graph. (The one thing that deliberately does NOT: how many times the *solver* iterates per generation. That is numerical relaxation, an engine knob, the same category as `positionalIterations`.) Design authority: [docs/IMPACT_MAP_GRAPH_LAYOUT_CADENCE.md](docs/IMPACT_MAP_GRAPH_LAYOUT_CADENCE.md) §1.6/§3; phase report [docs/HANDOFF_GLC_L2_CADENCE.md](docs/HANDOFF_GLC_L2_CADENCE.md).

### `Get Generation` ([GetGenerationNode.ts](src/modeler/vpl/nodes/GetGenerationNode.ts)) — the primitive
A **universal** value node (Cells AND Agents; not Overseer, which has its own `ovGetGeneration`) outputting the current generation. Before it there was NO way to read the generation from a cell or agent rule at all.

**PINNED SEMANTICS (later work relies on these):**
- **0-based, and it names the generation being computed NOW** — the first step after a Reset reads `0`. The worker increments at the END of a step, so every rule running during generation *g* reads exactly `g`.
- **Init events read 0.** Reset zeroes the counter BEFORE the cell Init Event, the Grid Init Event and the Agent Init Event, so a seeding rule always sees 0 regardless of how long the previous run lasted.
- **A Division Event reads the generation the division happened in** — it runs in the structural phase of generation *g*, after the behaviour and before the increment, so it reads the same *g* the behaviour that requested the division read.
- **An Output Mapping reads the generation ABOUT TO BE computed** (`g+1` after generation *g*): the colour pass runs after the increment, on every target, so the cell OM, the agent OM and the resident-batch OM all agree.
- **Cells and agents share ONE counter** (the worker's `generation`), bumped once per generation.

### Threading — six surfaces, NO new per-target algorithm
| surface | mechanism |
|---|---|
| Cell JS | a trailing `_generation` param on the step / per-cell / output-mapping signatures, appended LAST and **gated on real usage** (the sparse-stepping discipline) |
| Cell WASM | an **i32 cell in `wasmMemory`** at `layout.generationOffset` |
| Cell WebGPU | `Control.generation` (byte 8 of the existing 16-byte control block — no buffer change), declared only when read |
| Agent JS | a trailing `_generation` ABI field ([agentAbi.ts](src/modeler/vpl/compiler/agentAbi.ts)) |
| Agent WASM | an **f64 cell in the agent memory** at `layout.generationOffset` — the 16-param behaviour signature is untouched |
| Agent WebGPU | a `genCounter` **STORAGE buffer** (binding 15), bumped GPU-side (see below) |

**Why the two WASM surfaces need no usage gate at all:** the cell is appended at the very END of each memory layout, so every existing baked offset — and therefore every emitted instruction — is unchanged. A model that never places the node emits no load, and its module is byte-identical. One mechanism also serves EVERY cell entry point (step / init / grid init / input colour / output mapping) with zero signature changes.

**The ONE asymmetric ABI field.** `AgentAbiShape.usesGeneration` gates the PARAM side (the compiler passes the graph's real answer, so an unusing model keeps its historical param string) while the **worker and the parity harness always pass `true`**, so the value is always supplied. `params ⊆ args` is the safe direction for a JS function — an extra trailing arg is ignored, a missing param reads `undefined` — which makes the dangerous direction structurally impossible (the L1 `forcePassParamsFor` discipline). Pinned by the arity-contract block in [scripts/test-rule-cadence.mjs](scripts/test-rule-cadence.mjs).

**ONE seam moves the counter** ([sim.worker.ts](src/simulator/engine/sim.worker.ts)): `setGeneration` / `advanceGeneration` replace every `generation++` / `= 0` / `+= count`, and keep the JS variable, the two WASM memory views and the cell-WebGPU control word in step. (Named `advanceGeneration`, not `bumpGeneration`, because `runAgentBatchResident` already takes a BOOLEAN param called `bumpGeneration`.) The cell WebGPU word is also re-seeded when the runtime is (re)built — a rebuilt buffer is zero-initialised, so a soft recompile at generation 500 would otherwise read 0.

### THE delicate point — GPU residency (why a STORAGE buffer, not a uniform)
**Measured**: `dispatchResidentBatch` ([agentWebgpuRuntime.ts](src/simulator/engine/agentWebgpuRuntime.ts)) encodes **ALL N generations of a batch into ONE command encoder and submits once**, with no CPU touch point between generations. A generation supplied through the Control uniform would therefore be **frozen for the whole batch** — silently wrong, on that path only, and **invisible to any single-step test**.

**The fix**: the per-generation **`posCommit`** pass (the only pass that already runs exactly once per generation inside that submit) owns the counter — `if (i == 0u) { genCounter[0] = genCounter[0] + 1u; }`, from ONE invocation (no race) and **before the `highWater` guard** so an empty population still advances the clock. WebGPU's implicit inter-pass ordering makes the bump visible to the next generation's behaviour pass. The host seeds the counter ONCE per batch (`uploadAgentGeneration`); the per-gen GPU path just writes it before each dispatch. **Residency is preserved** — reading the generation costs no readback and adds no eligibility term.

The `genCounter` buffer is created UNCONDITIONALLY (4 bytes) because posCommit bumps it unconditionally — only the behaviour/OM **bind-group entry** is gated on `usesGeneration` (a declared-but-unused storage global is stripped by Naga, which would mismatch the reflected layout — the same rule as `usesSpawn`/`usesStop`/`usesForceScatter`).

### `Agent Periodic Step` ([PeriodicStepNode.ts](src/modeler/vpl/nodes/PeriodicStepNode.ts)) — the sugar
**The type id stays `periodicStep`** (ids are never renamed); only the LABEL moved, in the Global Periodic Events round — the unqualified "Periodic Step" read as GLOBAL to users when it is emphatically per-agent. An agent event root (`period` + `phase` + a `Step Index` = ⌊generation/period⌋ output) whose chain runs only when `generation % period === phase`. **Multiple per graph** — deliberately NOT in `SINGLETON_NODE_TYPES`. Two at period 2, phases 0 and 1, reproduce the classic "states on even ticks, rewrites on odd" alternation; gating the state update and the rewrite on the SAME tick is what makes a periodic automaton faithful, and that is the argument for the root over hand-wired modulo boilerplate.

**Implemented as a pure pre-compile LOWERING** ([periodicExpand.ts](src/modeler/vpl/compiler/periodicExpand.ts)) into `Get Generation → Math(%) → Compare(==) → If/Then` hung off ONE `behaviourStep`, sequenced — the P1 census pattern, so **zero per-target emit**, all three targets by construction, and the capability gates + WASM/WebGPU supported-type sets never see a `periodicStep` node. Rules it keeps: deterministic synthetic ids; **ONE shared `Get Generation`** fanned out to every gate (accessor-CSE is OFF in async agent mode, so duplicates would not merge); `Step Index` synthesized only when consumed; **at most ONE `behaviourStep` in the output** (an existing one is REUSED, so the singleton the three agent compilers look up still holds); branch order = **the unconditional chain first, then the gates**, stated explicitly with a `sequence` rather than left to edge-array order. Hot-path no-op when the graph has none.

**The worker's DEV ABI-arity assertion had to learn about the asymmetry (fixed):** it asserted `fn.length === args.length`, which the param-gated/arg-always split breaks by exactly one slot — so a shipped agent model with NO cadence node posted `ABI ARITY DESYNC` on every load. It now accepts `params === args` OR `params === args - 1` and nothing else, so the dangerous direction (`params > args`) is still an error. Found only by an in-browser smoke run on the shipped `Cubic GRA` — every headless gate was green, because none of them exercises the worker's runtime assertions.

**A silent-clamp bug this surfaced (fixed):** both agent gates early-outed on `nodes.find(behaviourStep)` over the **PRE-flatten** graph. A graph made of Agent Periodic Steps alone has no `behaviourStep` node yet — so it compiled perfectly and was then rejected by the gate, silently clamping to JS. The early-out now accepts `behaviourStep || periodicStep`; the post-flatten lookup remains the real check.

**Scope**: Agent Periodic Step is agent-only (`requirements.bondGraph`) and PER AGENT. A CELL rule composes the same gate by hand from Get Generation, which is universal — or uses the **Grid Periodic Event**, the GLOBAL root added later (see "Global Periodic Events" below, which is also where the per-agent/global naming split is recorded).

### Verification
[scripts/test-rule-cadence.mjs](scripts/test-rule-cadence.mjs) (107 checks): cells run on JS **and a REAL instantiated WASM module** in Node (2D + 3D, bit-identical); the OFF path emits no param / no WGSL field and keeps `generationOffset` last; the lowering's structure, multiplicity, ordering and clamping; cadence **by value** on the agent JS loop (period 10 fires on exactly 0/10/20/30; two phases alternate; three periods coexist while the unconditional chain still runs every generation); the pinned init/division semantics **run** and asserted; the agent WASM/WebGPU gates + emit; and the ABI arity contract. A permanent `[synthetic] Rule cadence (Get Generation + 5 Agent Periodic Steps)` entry in [scripts/parity-agent-wasm.mjs](scripts/parity-agent-wasm.mjs) carries a **per-step VALUE invariant** that recomputes each gate's schedule independently (parity alone would pass if both targets fired unconditionally) — negative-controlled by making every gate always-on.

**THE residency test (real GPU, in-browser)**: a residency-eligible WebGPU-agent model whose rule counts how many times the generation CHANGED, run as ONE 20-generation resident batch (`residentEligible: true`) — `changes 20`, `sum 190` (= Σ 0..19 exactly), `lastGen 19`, and a period-10 gate last firing at 10, all 8 agents agreeing, 0 errors; a second batch continued to `changes 40 / sum 780 / lastGen 39 / p10 30`. **Negative-controlled**: with the posCommit bump removed (uniform-equivalent) the SAME run reads `changes 1 / sum 0 / lastGen 0 / p10 0` — one frozen value. Cell WebGPU was verified on the real device too (`useWebGPUStatus ready:true`, all 256 cells === 4 after 5 generations).

**An audit invariant this widened**: `_generation` is appended AFTER the 3D block (dead last on every ABI kind), so `audit-agent-layout.mjs`'s "2D is a strict prefix of 3D" check reports a false divergence for any cadence-using model — which nothing exercised until `Cubic GRA` shipped an Agent Periodic Step in L3. The audit now strips a trailing `_generation` before the prefix comparison AND separately asserts that, when present, it is LAST on both sides (negative-controlled: making it 3D-only fails exactly that assertion).

---

## Global Periodic Events — `Grid Periodic Event` + `Population Periodic Event` (branch `tasks_batch_02-09`)

The once-per-firing-generation counterpart to the PER-AGENT `Agent Periodic Step`: a root whose chain runs **ONCE GLOBALLY** — not per cell, not per agent, **no `self`** — on generations where `generation % Period === Phase`. What the Grid Init Event and the Agent Init Event are to Reset, these are to a cadence: *periodically add substrate, spawn a wave of agents, sweep the population, or read an indicator and fire a Stop Event.* **`gridPeriodic`** lives on the Cells graph, **`agentPeriodic`** on the Agents graph.

**THE RENAME THAT CAME WITH THEM.** `periodicStep`'s label became **`Agent Periodic Step`** (the type id is unchanged — ids are never renamed). The user's report is the whole justification: *"it got me very confused into thinking that it was a global periodic step"*. The two names are deliberately **first-word-distinct** — "Agent Periodic **Step**" vs "**Population** Periodic **Event**" — because the confusion was about SCANNING a name, so a shared prefix would have reproduced it.

### The architecture — the Grid Init Event's, verbatim
Each root compiles to **ONE JS function the worker executes**, on JS, WASM and WebGPU alike. The WASM/WebGPU **step** compilers only walk the `step` / `initEvent` / mapping (and behaviour) roots, so they never see `gridPeriodic` or `agentPeriodic` — **no per-target emit, no supported-type set to widen, no capability gate to change**, and ALL-TARGET delivery holds by construction rather than by care. `AGENT_WASM_CPU_ROOT_TYPES` gains `agentPeriodic`, which is what makes `gen-capability-docs` classify it `exempt` on both agent targets (the generated `agentGapsWasm` / `agentGapsWebgpu` stay **0**).

### `CompileResult.gridPeriodicCodes` / `AgentCompileResult.periodicCodes`
Both are `PeriodicEventCode[]` = `{ period, phase, code }` — **an ARRAY, because neither root is a singleton** (several cadences per graph is the point, as for Agent Periodic Step). The cadence is resolved by the SHARED **`periodicParams`** clamp (period ≥ 1, phase folded into `[0, period)`) at COMPILE time and shipped with the code, so **the worker never re-derives it** — one definition, two consumers, and a hand-edited `period: 0` can never divide by zero. They ride the init/recompile messages as `gridPeriodicCodes` / `agentPeriodicCodes`.

### Ordering — the TOP of the generation, and both consequences are deliberate
`runPeriodicEvents()` fires at the top of `runOneGeneration`, **before the agent step and before the cell step**:
- **Cells**: what the event writes is visible to THAT generation's rule (add substrate, then let the rule consume it in the same generation).
- **Agents**: `runAgentStep` captures its loop bound AFTER this runs, so **a newborn behaves and integrates the SAME generation** — like an Agent-Init-Event agent, and unlike a Behaviour-Step spawn (which lands past an already-captured bound and waits a generation). The node's own doc says so.

### The grid half — the buffer discipline is `runGridInit`'s
Sync mode seeds the write buffer from the read buffer, runs the due fns, then copies write → read (so cells the event never touches persist); async shares one buffer; under the WebGPU `attrWriteAliased` optimisation both copies are self-copies, which is correct because the event writes FINAL values. A firing sets `colorsDirty`, and under **Skip Isolated Empty Cells** it calls `rebuildActiveSetFromGrid()` + `sieColorDirtyAll = true` (the event may write ANY cell, including one outside the active set — the paint/gridInit rule).

**⚠ THE `gpuOwnsAttrs` STALE-MIRROR CASE, handled explicitly.** On the WebGPU grid target `readAttrs` is stale after a step. `runGridPeriodicEvents` deliberately does NOT read back itself (it is synchronous; the readback is async) — **the CALLER owns it**: the `webgpuActive` batch branch tests `gridPeriodicDue()` first, and only on a firing does `await ensureCpuAttrsFresh()` → run → `uploadAttrs` + `gpuOwnsAttrs = false`. So an evolved GPU board is never clobbered by a stale mirror, and **the round trip costs nothing on the generations that do not fire** — which is the whole reason `gridPeriodicDue()` exists as a separate cheap predicate (one modulo per event).

### The agent half — the Agent Init Event's ABI, REUSED
`agentPeriodic` compiles against **`buildAgentInitParams`** (the `'init'` ABI kind) and is called through the SAME `buildAgentInitArgs` with the SAME module-level **grow-only** spawn closures (`agentBehaviourCreate` / `agentBehaviourAddToWorld`) and the SAME leak sweep the behaviour graph uses. **That reuse is the design**: it adds NO ABI kind, no `deriveAgentAbi` arm, no worker arg builder and no `test-agent-abi` shape — the root is entirely off the ABI-mirror surface, and Create Agent → set-by-handle → Add Agent To World works with zero new machinery. `compile.ts` maps it to `agentRoot: 'init'` for exactly this reason. Its extra `seedIndexBase` value-out is `highWater` at the firing (so a spawn loop can number its own batch). The worker's DEV arity assert gained a FIFTH `!arityOk(` site for the new fn list (pinned by `test-rule-cadence`).

### ⚠ RESIDENCY IS A CORRECTNESS TERM
A GPU-resident batch encodes N generations into ONE submit with **no CPU touch point between them** — which is precisely what a per-generation CPU event needs. So `residencyModelBlockers` gained the key **`periodicEvents`**, fed by `usesPeriodicEvents` (**ONE term covering BOTH roots**, since either one needs the same per-generation pause), and the worker's `agentResidentEligible` facts object sets it from `gridPeriodicFns.length > 0 || agentPeriodicFns.length > 0`. **Without it the resident batch silently skips every firing** — no error, no log, just a model that quietly stops adding substrate. Class-F (a speed path forfeited), never an error, and surfaced in the C1 / C3 readouts like every other blocker.

### The enumeration sweep (the documented agent-root list, plus the cell-root sites)
`MULTI_OUTPUT_TYPES` + `AGENT_ROOT_TYPES` + the `agentRoot` derivation (compile.ts) · `NEVER_INVARIANT` (loopInvariant) · `GENERATION_NODE_TYPES` (generationUse — both roots emit `stepIndex`, so they force `_generation` to be threaded) · `LATTICE_ONLY_TYPES` + the selfless-root validation walk (nodeValidation) · `ROOT_TYPES` / `CONTROL_FLOW` / `NODE_LABEL` (geometryTaint) · `LOWERED_AWAY` (targetDiagnosis) · `AGENT_WASM_CPU_ROOT_TYPES` (agentWasm) · `SCALAR_CONFIG_KEYS` (explicitControls — `period` / `phase` are bindable) · the CaNode cadence config block · `generationPipeline` (two new rows, `periodic.grid` / `periodic.agent`, at the top of the PER GENERATION section) · `showCode` (driver skeleton + a section per compiled event) · `compileHarness` + `check-compile-identity` (`js.gridPeriodicCode` / `agent.periodicCode` as NEW hashed keys — the cell `js.gridInitCode` joined them, closing a pre-existing blind spot: a JS-on-CPU root appears on NO other surface). **`patchAllNodes` and the clipboard need nothing** — neither root stores a model-element id.

### Verification
[scripts/test-global-periodic.mjs](scripts/test-global-periodic.mjs) — the editor surface + the rename, the cadence clamp, then the claims that matter: the compiled grid fn RUN with the worker's exact buffer discipline over views into a **REAL instantiated WASM module's memory**, after which the **WASM `step` reads the periodic's write** (the shared-bytes claim the whole architecture rests on); the compiled agent fn RUN through the shared `buildAgentAbiArgs('init', …)` against a REAL `createAgentStore` with a replica of the grow-only closures (exact positions, per-newborn attribute writes through the handle, bounded by `maxAgents` with no wrap, the leak sweep); the ABI-reuse claim compared against `buildAgentInitParams`; the residency blocker; and the hot-path no-op. **Negative-controlled by SOURCE MUTATION — 5 mutations, 5 caught**: emit the raw generation as `stepIndex`, emit constants instead of the LIVE grid dims, ignore the `periodicParams` clamp, compile the population root against the LOOP ABI, and drop the residency blocker.

---

## The TRACE BUILD — `compileGraph(…, { trace: true })` (2026-09-12)

`compileGraph` / `compileAgentGraph` take an additive `opts: CompileOptions` whose only member today is
`trace`. With it, the compiler emits the **trace build** that Rule Trace re-evaluates one element with:
per-node `_tr.v(id, port, value)` records, per-flow-node `_tr.f(id)` / `_tr.o(id, port)` records, a
**single-element body** (`const idx = _traceIdx`), accessor-CSE skipped and aggregate fusion disabled.
Everything else — sinking, loop-invariance, volatile hoisting, the async hazard, every lowering pass —
runs **unchanged**. The full contract is in [`rule-trace.md`](rule-trace.md); four things concern anyone
editing this layer:

- ⚠ **With `opts` absent, NOTHING changes.** Every trace line is behind the flag and the helpers return
  `''`. The proof is `check-compile-identity` — 31 models, every surface unchanged — and **the six trace
  surfaces are on that list too**, so an emit change to the trace build is caught the same way.
- ⚠ **A record is APPENDED to the node's own code and never hoisted.** A record above a `const` in the
  same block touches it in its temporal dead zone, where even `typeof` throws.
- ⚠ **Every lowering pass returns an additive `origin` map** (`TraceOriginMap`), folded in pass order
  into the `TraceOriginTable` that maps a lowered id back to the user node, port, composite component and
  macro path. Eleven passes carry one today. **No id is ever renamed to make this work** — a rename moves
  emitted bytes on every target and can flip accessor-CSE's *lexicographically smallest id* canonical
  pick. ⚠ **A new lowering pass that forgets its `origin` map does not break the build**; it makes a node
  stop lighting up, which nobody notices — so `scripts/test-rule-trace.mjs` § A fails on any lowered id
  that resolves to nothing.
- ⚠ **The bulk `w.set(r)` copy becomes a SINGLE-ELEMENT copy in trace mode, not nothing.** Dropping it
  outright traced `updateAttribute`'s read-modify-write wrong (caught on Extended Wireworld): an
  attribute the rule does not write must still be there to read.

The trace **root keys** (`step`, `init`, `gridInit`, `gridPeriodic:<id>`, …) have exactly ONE definition,
in `src/modeler/vpl/compiler/traceOrigin.ts`, **because the compiler is the side that writes them** into
`CompileResult.trace.paramNames`; `src/simulator/engine/traceProtocol.ts` re-exports the lot. ⚠ A key
built under one spelling and prefix-filtered under another fails **silently** — the periodic root simply
never pairs with its code and that trace goes missing with no error anywhere.

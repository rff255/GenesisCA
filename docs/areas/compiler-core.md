# Compiler core — shared passes, the JS reference target, schema features

> Area doc for **GenesisCA**. The two-pass JS compiler, value sinking, accessor CSE, async hazards, and every schema-level feature that lowers to nodes (composites, local variables, sub-attributes, linked OMs, multi-attr slots, variegation, RGBA, rule cadence). Read before touching src/modeler/vpl/compiler/**.
>
> Sections below were moved **verbatim** out of `CLAUDE.md` (2026-09-06) so the always-loaded
> file could stay small. Nothing was rewritten or deleted. See `../../CLAUDE.md` for the
> project-wide rules and the routing table, and `docs/HANDOFF_*.md` for the full build narratives.
>
> **Paths here are repo-root-relative** (e.g. `src/model/types.ts`), exactly as they were in `CLAUDE.md`.
> Read them from the repository root; they will not resolve as links from this directory.

**Contents**

- RGBA Colours (alpha through the colour-producer chain — branch `presentation_export`)
- Value Sinking (cross-target compile optimisation)
- Accessor CSE (cross-target compile optimisation)
- Async Read-After-Write Hazard (volatile-ized attribute reads — JS + WASM)
- Variegated Cells (Directional Interactions) — opt-in feature, all three compile targets
- Chemistry Primitives (B.0 + B.1 + B.3 + GroupOperator.weightedRandom)
- Local Variables (schema-level feature, all three compile targets)
- Sub-Attributes (schema-level feature)
- Linked Output Mappings (schema-level feature, all three compile targets)
- Composite Value Types — Vector & Color + Get Self Handle
- Multi-Attribute Slots on Get/Set Attribute (branch `multi_attr_slots`)
- Parameterized Input Mappings — declared parameters replace hardcoded R/G/B (branch `polishing`)
- Agent-compiler branch-scope + RNG-order fixes (branch `improvements`, 2026-07-28)
- Get Grid Dimensions (universal node — Cells AND Agents, all 6 compile surfaces)
- Rule Cadence — `Get Generation` (universal) + `Agent Periodic Step` (agents) — branch `GRA`
- Global Periodic Events — `Grid Periodic Event` + `Population Periodic Event` (branch `tasks_batch_02-09`)

---

## RGBA Colours (alpha through the colour-producer chain — branch `presentation_export`)

Alpha flows end-to-end from every colour **producer** to the `colors` buffer, on all five compilers (JS / WASM / WebGPU × cell + agent), 2D + 3D, grid + agents. Impact map + illustrated plan: [docs/IMPACT_MAP_RGBA_COLORS.md](docs/IMPACT_MAP_RGBA_COLORS.md) / [PLAN_RGBA_COLORS.md](docs/PLAN_RGBA_COLORS.md) (+ `.html`).

**The starting point:** the engine was only HALF RGBA-ready. The **sink** took alpha (`colors` is RGBA; `setCellLooks` has an `a` port; 2D composites it; the 3D voxel renderer culls alpha-0 and blends the rest; agent discs/sprites honour it) — but every **producer** upstream was RGB-only, including the schema (`RGB`/`ColorStop` had no `a`), and `linkedOutputMappings` wired only r/g/b, so every auto colour pass was hard-opaque. Work therefore ran **sink-backwards**: schema → producers → linked-OM wiring → pickers.

### The governing invariant
> **Absent alpha ⇒ 255 ⇒ opaque ⇒ behaviour-identical.** Every alpha field is OPTIONAL (`a?: number`); every parser defaults to 255 — exactly what `setCellLooks`' inline default already wrote. **No `.gcaproj` migration.**

### `colorHex.ts` — the ONE hex ⇄ RGBA source ([src/model/colorHex.ts](src/model/colorHex.ts))
`hexToRgba` / `rgbaToHex` / `hexRgbPart` / `rgbaToCss` / `isOpaque` / `OPAQUE`. **The load-bearing rule: `rgbaToHex` emits 6 DIGITS when alpha is 255**, so an opaque colour round-trips to the exact string it had before alpha existed and every saved `.gcaproj` stays byte-identical. Alpha only widens the encoding when actually used. Created because the codebase had grown **three divergent hex pairs** (a regex/black-fallback one; a **24-bit-mask one that silently corrupts an 8-digit hex into the wrong channels**; a third inline copy) plus two `toHexColor` clones falling back to `#888888`. The MappingsPanel copy is now DELETED; the out-of-scope cosmetic sites (brush, chart series colours, sprite chroma-key, comment/group nodes) keep theirs and **must never receive an 8-digit hex**.

### Option A — the byte-identity gate (the load-bearing design decision)
A multi-output node emits all ports together, so an unconditional `_v<id>_a` would add a dead const to every model with a linked float/integer OM — harmless at runtime, but it would turn the `check-compile-identity.mjs` baseline red across ~10 models and **burn the cheapest regression net this change has**. So **`<node>HasAlpha(config)` gates BOTH the `a` PORT (`hiddenPorts`) AND the emit**: no declared alpha ⇒ the verbatim pre-alpha three-channel form. An **explicit 255 counts as opaque**, so dragging alpha to full and back leaves no trace. ONE predicate per node (`colorScaleHasAlpha` / `categoricalHasAlpha` / `colorConstantHasAlpha`) shared by `hiddenPorts`, all five compilers, and the linked-OM injector — so port and emit **cannot** disagree.
- **`getModelAttribute` is deliberately NOT gated**: a colour model attr ALWAYS occupies four slots, so `_a` always exists and always holds a real value (255 for a `#rrggbb` default).
- **The per-target subtlety JS lacks:** on WASM `em.allocLocal` changes the MODULE BYTES even for an unused local; on WebGPU a `fresh()` name + its `var` line change the SHADER. So the alpha local/name is minted **LAST and only when declared** — the opaque path allocates exactly `[tLoc, r, g, b]` and consumes the same fresh names. Every emit branch walks a **channel table** whose 4th entry only exists when `withA`.
- All four nodes were already in `MULTI_OUTPUT_TYPES` (getModelAttribute via the `isColorAttr` check), so `_v<id>_a` resolves through the existing `_v<id>_<portId>` convention — **no `varName()` case, no scratch registration**.

### `modelAttrSlotKeys` — 6 mirror sites → 1 source ([attributeScope.ts](src/model/attributeScope.ts))
A colour **model attribute** splits into scalar slots; alpha appends a 4th (`id_r/_g/_b/_a`). That expansion was inlined at SIX sites that must agree exactly or the baked offsets desync — and **a desync does NOT crash**, it silently shifts every later attribute's offset in one target but not another (the agent side's "+64-cell corruption" class). They now ALL route through `modelAttrSlotKeys`, whose own file already forbids this inlining ("NEVER inline a filter at a mirror site — call a helper"); the colour sites merely predate the rule. Drift is now **structurally impossible**. The sites: `sim.worker.ts` (cachedModelAttrs writer) · `SimulatorView.tsx` (the `init` writer) · `wasm/layout.ts` (f64/slot) · `webgpu/layout.ts` (f32/slot) · `agentWasm` `modelAttrKeysOf` · `agentWebgpu` `agentWebGPUExtrasOf`. **The copy loops are key-driven** (`Object.keys(modelAttrOffset)` → `cachedModelAttrs[key]`) so they inherit the new slot for free.
- **SCOPE: the helper owns the COLOUR expansion ONLY.** It deliberately does NOT unify the `lookupTable` filter — the six sites **diverge** on it today (the two layouts reserve a slot nothing reads; SimulatorView + agentWasm skip it). That divergence is pre-existing and benign, but unifying it would REMOVE a reserved slot and shift every later attribute's offset on **Chromatography / Accretor / Golly**. Each caller keeps its own filter.
- **[scripts/audit-modelattr-layout.mjs](scripts/audit-modelattr-layout.mjs)** (NEW) is the defence-in-depth for the partial-edit failure mode — the model-attr split had no equivalent of `audit-agent-layout.mjs`. 18 checks; asserts all four layout-deriving sites agree on `[before, tint_r, tint_g, tint_b, tint_a, after]` with contiguous 8-byte / 4-byte slots.
- **`color` is offered ONLY for model attributes** (`{selected.isModelAttribute && <option value="color">}`), so there is no colour CELL attribute and `boundaryValue`/`undefinedValue` need no widening.

### Linked Output Mappings — the conditional 4th edge
`injectLinkedOutputMappings` + `injectAgentLinkedOutputMappings` add the `a` edge **only when the palette carries a non-255 alpha** (the `expandComposites`-style hot-path no-op); an opaque palette synthesizes exactly the three historical edges. Two coupled parts, both on the SAME predicate the node's `a` PORT uses: the config builders write `stop_${i}_a` / `entry_${i}_a` only when declared (an unconditional key would also perturb **accessor-CSE's purity key**, which hashes config), and the injector adds the edge only when the built config has alpha. The agent injector reuses the same builders, so alpha flows there for free.

### `ColorField` — one widget, seven sites ([src/modeler/vpl/widgets/ColorField.tsx](src/modeler/vpl/widgets/ColorField.tsx))
**The native `<input type="color" alpha>` is NOT viable — measured, not assumed.** Safari 18.4+ only (~12.6% global; **Chrome ✗ through 150, Edge ✗, Firefox ✗** — [caniuse](https://caniuse.com/wf-input-color-alpha)). Probed in a Chrome 148 renderer: `'alpha' in input === false`, and `value = '#ff000080'` → **`'#ff0000'` — silently TRUNCATED, no error**. It would light up ONLY in the browser where GenesisCA is least capable (WebGPU + Tauri are Chromium-bound) and stay dark for the actual audience; a progressive-enhancement branch would give ~87% of users a different control AND still need the fallback built. **Do not revisit this without re-measuring caniuse.**
- So: a checkerboard-backed swatch rendering the true `rgba()` composite (alpha is VISIBLE, not a number to read), opening a popover with the native picker + an alpha slider. Follows the `BrushColorPopover` precedent. **The native element is the RGB sub-control only, fed `hexRgbPart` — alpha is never round-tripped through it.**
- **The popover is PORTALLED to `document.body` (load-bearing — `createPortal`).** It's `position: fixed` at coords measured from the swatch's `getBoundingClientRect()`, which is correct ONLY when no ancestor is transformed: **a `transform` makes that element the containing block for its `fixed` descendants** (CSS spec), and VPL nodes live inside React Flow's `.react-flow__viewport`, which always carries `transform: translate(…) scale(…)`. In-tree, the popover was therefore offset by the live pan AND scaled by the zoom on EVERY canvas node (measured: `matrix(2,0,0,2,383,360.5)` → the popover landed +1990px/+1147px away at 416px wide), while the panel sites (no transformed ancestor) looked fine — the reported "wrong position for all nodes that have the color button". The portal escapes the transform so ONE positioning path serves canvas + panels (both verified `dx:0, dy:0`, 208px). **Any future fixed-position popover rendered from inside a VPL node must portal too**; `position: absolute` (e.g. CaNode's `.linkMenu`) is transform-safe and needs no portal. React portals propagate events through the REACT tree, so the existing `stopPropagation`/`nodrag` guards still keep a click off the node's drag surface.
- **Dismissal**: capture-phase outside `pointerdown` (a press that starts a drag elsewhere still dismisses — the GraphEditor context-menu lesson) + Escape + an **outside `wheel`**. The wheel arm matters because the popover is measured ONCE at open: a canvas zoom (or panel scroll) would slide the swatch out from under a stranded popover, and unlike a pan it fires no pointerdown. A wheel INSIDE the popover is ignored (the alpha slider).
- Sites: `GradientStopsEditor` (shared by the Color Scale node AND the linked float/integer editor — `sampleAt` + the CSS bar carry alpha over a checkerboard), `MappingsPanel` `ColorSwatch` (bool + tag; the callers spread `...c`, so alpha rides along with **no call-site change**), `CaNode` `CategoricalColorEditor` + `getColorConstant`, `AttributesPanel` colour default (`#rrggbbaa`), `SimulatorView` model-attr (the live `_a` slot).
- **A shared widget carrying alpha does NOT mean its CALL SITES do** (the bug this cost): BOTH `GradientStopsEditor` consumers silently dropped `a` in their config round-trip — `ColorScaleEditor` (CaNode) hand-rolled a parse/write over `position|r|g|b` only, and `MappingsPanelContent`'s `editorStops`/`onStops` mapped `ColorStop`↔`GradStop` without `a`. The widget set the stop's alpha, the mapper discarded it, the next render read back opaque — so **the picker looked like it refused any alpha but 255** while the compiler had been alpha-ready the whole time. Fixed by routing the node through its OWN exported `readColorScaleStopsRaw` + `writeColorScaleStops` (the `CategoricalColorEditor` rule: *reuse the node's parser so the editor and the compiler can never disagree*) and by threading `a` through both legs of the linked mapper. **`readColorScaleStopsRaw` (unsorted) exists specifically for the editor** — `GradientStopsEditor` addresses stops by ARRAY INDEX (drag/select/delete), so the compiler's position-sorted `readColorScaleStops` would retarget a stop dragged past a neighbour mid-drag. `writeColorScaleStops` owns the key names + the Option-A gate, so a new stop-editing UI can't reintroduce the drop.
- **Why the RGBA milestone's verification missed it**: the compiler side was proven with SYNTHETIC configs (`test-rgba-colors.mjs` builds `stop_N_a` by hand) and the editor side was browser-verified only on the **bool** linked path (`ColorSwatch`, which spreads `...c` and was never broken). Neither exercised the **gradient editor's round-trip**. A shared widget + a green compiler test is not evidence a picker works — **drive the actual UI and read the value back**.
- **Every site writes `a` ONLY when non-opaque**, so an opaque palette keeps no alpha key, its pre-alpha config, its 3-port shape and its byte-identical emit. `CategoricalColorEditor` widens the WHOLE palette when ANY entry declares alpha — a mixed palette must write every entry's `a`, else an opaque one reads as `undefined` and silently takes the pre-alpha path for that entry.
- **`multiAttrExpand`'s colour slots** were an uncatalogued site: `a_${i}` needed in THREE coordinated places — the port builder, the consumer remap, and the **`STALE_SLOT_HANDLE` regex** (a miss there leaves the alpha edge unclaimed, falling through to the pruned slot-1 node and silently resolving to the WRONG variable).

### Out of scope (deliberate)
The **Colour→Attribute direction** (brush / image import): `InputColor`'s `(_r, _g, _b, idx, …)` ABI is untouched and image import still ignores source alpha — a separable ABI change with its own verification surface. Cosmetic pickers (`bg2d`/`bg3d`, comment/group node colours, indicator chart `seriesColors`, sprite chroma-key) stay RGB.

### Verification ([scripts/test-rgba-colors.mjs](scripts/test-rgba-colors.mjs) — 95 checks)
**THE LIBRARY GIVES ZERO COVERAGE FOR THIS FEATURE** (audited across all 23 models): **no shipped model has a colour attribute at all**, none uses `getColorConstant` or `makeColor`/`breakColor`, and none has an agent linked OM. Also, **`colorScale`/`categoricalColor` appear in ZERO `.gcaproj` files** — the linked-OM path *synthesizes* them at compile time (real in ~10 models' emitted code, invisible in the model files; a grep-based audit wrongly calls them dead). So `check-compile-identity.mjs` can prove we broke nothing but **nothing about whether the new code works** — hence a synthetic suite asserting **VALUES**, not "it compiled":
- colour model attr `#ff000080` → `Get Model Attribute.a` === **128** on JS **and a REAL instantiated WASM module** (modelAttrs seeded via the same key-driven copy the worker does), JS↔WASM bit-identical
- `Colour Constant(a=128)` → `Set Cell Looks` → `colors[0..3] === [10,20,30,128]` (alpha at the actual SINK)
- Colour Scale alpha **interpolates**: 0→200 at t=0.5 === **100** (JS + real WASM)
- Categorical Color selects per entry (11, 22) + falls back to `default_a` (33)
- the opaque emit is byte-for-byte the pre-alpha form; an opaque scale emits **no alpha var on WGSL**
- linked OM: opaque → `colors[colorIdx+3] = 255;` / alpha → `colors[colorIdx+3] = _v__linkedOM_viz_color_a;`

**Byte-identity: `check-compile-identity.mjs` — 23 models, all surfaces unchanged**, at every phase (the whole point of Option A). Plus `audit-modelattr-layout` 18 ✓, `audit-agent-layout` 120 ✓, `parity-agent-wasm` all samples ✓, tsc + `npm run build` clean. **Browser-verified** on Game of Life: two ColorFields render for the bool linked mapping (titles `#000000`/`#ffffff` — the 6-digit opaque round-trip), the popover opens with the alpha slider and a 6-digit-fed native picker, driving alpha to 128 gives title `#ffffff80` + composite `rgba(255,255,255,0.5)` while the opaque sibling stays `#000000`, and importing the compiler **in-page** on a linked mapping emits the alpha wire; zero console errors.

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

## Variegated Cells (Directional Interactions) — opt-in feature, all three compile targets

Opt-in support for chemistry CA models where the interaction between two cells depends on **which face of one meets which face of the other** (water-aabb, micelle/bilayer formation, chirality, structured-solvent dynamics). Off by default; the Properties → Execution checkbox (`model.variegatedCells.enabled`) unlocks a dedicated sidebar panel, a per-cell orientation buffer, an Init Event entry-point, face-label palettes, and a set of orientation/face nodes. (The Lookup Table attribute type is available independently — a tag×tag table needs no variegation.) Models with the feature off behave byte-identically (the regions are stub-allocated).

### Single source of truth
- `src/modeler/vpl/compiler/variegation.ts` is shared by the JS/WASM/WebGPU compilers AND the worker runtime to prevent byte-level drift: `DIRECTION_TAGS` (`[N,NE,E,SE,S,SW,W,NW]`), `buildDirectionMap`, `buildFacePatternLookup` (palette-aware), `normalizeLookupTable(values, rowLabels, colLabels)` (rectangular), `resolveKeyLabels(source, model)`. Any new variegation math goes here, never inlined per-target.

### Orientation
- Per-cell **orientation** = 0–3 (0/90/180/270° clockwise rotation), auto-allocated when the feature is on. Defaults to 0; sentinel cell carries fixed boundary value 0.
- JS: `Int32Array` (`r_orientation` / `w_orientation`, sync-mode bulk-copy line in the step). WASM: i32/cell region in `wasmMemory` (read/write offsets in layout). WebGPU: co-located INSIDE the attrs buffer as one u32 word per cell appended after the cell-attr region, so the attrsBufA/B ping-pong swaps orientation read↔write for free.
- Orientation-reading nodes are `NEVER_INVARIANT` (loopInvariant.ts) so emits stay per-cell.

### Schema (all additive, no version bump)
- `CAModel.variegatedCells?: VariegatedCellsConfig` — `{ enabled, sourceAttributeId, facePalettes: FaceLabelPalette[], facePatterns: FacePattern[] }`. **Multiple palettes**: `FaceLabelPalette = { id, name, labels: string[] }`. Each species → one pattern → one palette, so `facePatternLookup` stays ONE species×8 Int32Array (built palette-aware in `buildFacePatternLookup`); `getFacingLabels` returns per-species-palette indices — no per-palette buffers.
- `FacePattern` — `{ id, name, paletteId, layoutMode, faces }`. Named 8-slot layout (N/NE/E/SE/S/SW/W/NW; edges-only disables the 4 corners) drawing labels from `paletteId`. Implicit `none` (index 0) covers unassigned slots + non-variegated neighbours.
- **Lookup Tables** (`AttributeType += 'lookupTable'`, renamed from `interactionTable`) — a (possibly **rectangular**) float matrix with independent `rowKeySource` + `colKeySource` (`LookupKeySource = { kind:'facePalette', paletteId } | { kind:'tagAttribute', attributeId } | { kind:'single' }`). Face-palette axis labels = `['none', ...palette.labels]`; tag-attribute axis labels = the tag's `tagOptions` (no implicit none); **`single` axis labels = `['value']`** — a one-element axis that collapses the 2-D table into a 1-D "map" keyed only by the other axis (e.g. tag×single), so no bogus single-option tag attribute is needed. A pure tag×tag table needs NO variegation. The `single` kind is purely additive: every consumer derives dim/labels through `resolveKeyLabels`, and the `KeySourceField` dropdown ([AttributesPanelContent.tsx](src/modeler/panels/AttributesPanelContent.tsx), now in the detail panel) offers it as "Single value (map)". The stored axis key stays the stable `'value'` sentinel (so renaming the table never strands its cell values), but `LookupTableEditor` DISPLAYS the table's own name as the single axis's header (more meaningful than a generic "value"). Row-major storage `row * colCount + col` (stride = colCount). `Attribute` fields: `rowKeySource?`/`colKeySource?`, `symmetric?` (only when both sources identical), `tableValues?` (sparse `rowLabel → colLabel → float`), plus `facePatternAssignments?` on the variegation source. `resolveKeyLabels(source, model)` (variegation.ts) is the single source of truth for axis labels+dim. Live-tunable via worker `updateLookupTable`. Migration `lookupTableMigration.ts` (LOAD_MODEL): `interactionTable`→`lookupTable`, `faceLabels`→`facePalettes[0]`, defaults both sources to that palette (square, preserves old behaviour).

### Node set (orientation/facing/face-label nodes gated by `requirements.variegated`; the two table nodes are NOT — they work with tag×tag tables sans faces)
- Readers (`data`): `getOrientation`, `getFacingOrientation` (neighbour you face in a config direction, no neighborhood), `getNeighborOrientationByIndex` (read-only, both modes), `getFacingLabels` (multi-output `myFaceLabel`/`theirFaceLabel`), `getAllFacingLabels` (8-slot Moore or 4-slot `cardinalsOnly`), `interactionTableMap` (label "Table Map"; vectorised lookup over parallel index arrays).
- Logic: `lookupInteraction` (label "Table Lookup"; index a Lookup Table by row+col → float; loop-invariant when both indices are).
- Writers (`output`): `setOrientation` (sync+async), `setFacingOrientation` (async-only), `setNeighborOrientationByIndex` (async-only). `moveSelfToNeighbor` requires variegated only when `includeOrientation`.
- `getConstant` gains a `faceLabel` constType (gated on variegated) with a `facePaletteId` selector — `preResolveVariegatedNodes` (compile.ts) bakes the face-label NAME into a compile-time index within the chosen palette (none=0; user labels 1-based). Same pre-resolve injects `_resolvedDirIdx`/`_resolvedDr`/`_resolvedDc` for facing nodes and per-table `_rowCount`/`_colCount` (col=stride) for `lookupInteraction`/`interactionTableMap`.

### Init Event entry-point (`initEvent`)
- Singleton entry-point that runs **once per cell on simulator Reset** (after defaults applied, before the first colour pass — NOT on Load State). Outputs `x`, `y`, `maxX`, `maxY` + a `DO` flow chain. Useful beyond variegation: any procedural initial state (gradients, deterministic noise, random orientations). Compiled as a separate root (`compileGraph*` emit an `init` entry alongside `step`); worker `runInit` dispatches it before the first step. On all three targets — WASM exports `init`, WebGPU builds an init pipeline.

### Compile-target coverage
- **JS / WASM / WebGPU all lockstepped** (the older "WASM/WebGPU fall back to JS for variegated models" caveat is obsolete). Only `setFacingOrientation` / `setNeighborOrientationByIndex` stay rejected on WebGPU (async-only; WebGPU is sync-only). `detectWebGPUIncompatibilities` / `detectWasmIncompatibilities` enforce.
- WebGPU adds a 9th storage binding (`varAux`: facePatternLookup i32 + interaction tables as f32-bitcast-u32). Requires `maxStorageBuffersPerShaderStage` in `requiredLimits`; conservative adapters that cap at 8 fall back to JS.

### Cascade rules (ModelContext)
- 5 reducer actions: `UPDATE_VARIEGATED_CELLS`, `ADD/REMOVE/DUPLICATE/UPDATE_FACE_PATTERN`. Tag-option rename remaps `facePatternAssignments` keys; face-pattern delete clears assignments; deleting the variegation source attr clears `sourceAttributeId`; changing it away from tag detaches.

### Panel UX
- `ActivityBar` elides the **V** tab entirely when `variegatedCells.enabled` is false; `ModelerView` auto-switches the active panel to Properties if the user disables variegation while the V panel is open. `VariegatedCellsPanelContent` uses the canonical PanelContent.module.css primitives (source attribute selector, **multi-palette** Face Label Palettes editor, face-patterns list with a palette selector + 3×3 grid widget). `LookupTableEditor` (renamed from `InteractionTableEditor`, now takes `rowLabels`/`colLabels`) is shared between the Attributes panel (with row/col key-source pickers) and the simulator LEFT panel (the Model Attributes section).

### Gotchas
- The worker's `AttrDef` and SimulatorView's `init` message must carry the variegated payload (facePatternLookup + interaction tables + orientation) or the regions silently no-op. Interaction-table typed-array VIEWS over `wasmMemory` must be COPIED into, never reassigned (the usual view discipline).
- WGSL has no f64 — interaction-table math runs in f32 (intentional drift vs JS/WASM on chaotic models, same tradeoff as cell attrs). RNG differs (per-cell PCG on WebGPU vs shared xorshift32 on JS/WASM).
- Cell inspector publishes orientation as an extra row (`<int> (N/E/S/W)`) for variegated models.

### Amphiphile sample model + interaction-table presets
- `scripts/gen-amphiphile.mjs` programmatically builds `public/models/Amphiphile.gcaproj` (mirrors `gen-grayscott.mjs`), implementing the Kier book Example 5.3 move-into-empty rule: every non-empty cell rolls Bernoulli(P_break = ∏ P_B over neighbours), samples a direction by cumulative J-weighting over empty cardinals, moves atomically into the chosen empty cell; free amphis (all 4 cardinals empty) rotate uniformly. Re-running the script preserves any later-added `simulationState` + thumbnail in the existing output (like gen-grayscott). Showcases Variegated Cells + Local Variables + chemistry primitives end-to-end.
- `SimulationState.interactionTables?: Record<attrId, Record<row, Record<col, number>>>` extends presets to capture/restore lookup tables (field name kept for preset back-compat). `applySimulationState` restores them to BOTH the worker (`updateLookupTable`, with per-table resolved row/col labels) AND model state (`updateAttribute`), so the Properties panel + `.gcaproj` save reflect the preset. Amphiphile ships 9 presets (book Example 5.3 defaults + the 8 Kier 1996 Table I parameter sets).
- **`attrsStructurallyEqual` reinit guard** (worker, [SimulatorView.tsx](src/simulator/SimulatorView.tsx)): the model→worker reinit trigger compares only the fields the init layout depends on (id, type, isModelAttribute, defaultValue, boundaryValue, tagOptions, parentAttribute*/Values, undefinedValue, facePatternAssignments, neighborhoodHintId) — NOT reference equality on `model.attributes`, and NOT live-tunable fields (name, description, hasBounds/min/max, symmetric, tableValues). Without this, every `updateAttribute` (preset apply, Reset-to-Default, per-cell table edit) wiped the grid via full re-init. Latent bug, not just a preset prerequisite.

### Chromatography sample model (Kier, Cheng & Karnes 2000)
- `scripts/gen-chromatography.mjs` builds `public/models/Chromatography.gcaproj` (mirrors `gen-amphiphile.mjs`; same `node`/`vEdge`/`fEdge`/`groupNode` helpers + preserve-`simulationState`+thumbnail re-run tail). A 43×200 async column on a **FULL torus** — the paper's *"cylinder with ingredients flowing back to the top of the system"* (p.111) / *"on the surface of a torus to remove boundary conditions"* (p.21): `boundaryTreatment:'torus'` wraps BOTH axes — horizontal = the tube circumference, vertical = the gravity-driven mobile phase exits the bottom and re-enters the top, so it **recirculates as continuous flow**. Cell types `empty/W/B/S1/S2` (solvent / immobile stationary phase B / two solutes). **No variegation** — interactions depend only on the type PAIR, so `PB` (break) and `J` (join) are two `lookupTable` model attrs **keyed by `tagAttribute: cellType` on both axes** (the non-face Lookup Table path; `empty` rows/cols = 1, neutral). Move rule mirrors the Amphiphile's: gate (occupied AND not B ⇒ only W/S1/S2 move) → `forEachInArray` over the 4 cardinal NEAR neighbours filling `pbFactors[d]`=PB(my,nbr) and `weights[d]`=empty?J(my,far):0 (FAR = the 2-step extended-von-Neumann *k* cell) → Bernoulli(∏pbFactors) → hasA(empty) gate → `weightedRandom(weights)` → `moveSelfToNeighbor`.
- **TOPOLOGY — do NOT cap it (a fixed bug + the crux of the model).** An earlier build added immovable `wall` cells in the first/last rows to make a *closed* cylinder. That was WRONG: with no vertical recirculation, gravity drained every mobile cell to the bottom and the column ended up "just water at the bottom" (the user's bug report). The caps were borrowed from **Cheng & Kier 1995** (the oil-water paper), where two boundary rows DO turn the torus into a closed cylinder — but that model is a *shake-flask* where two liquids settle into static layers under a swap-gravity; it is NOT a flow-through column. The chromatography paper keeps the **full torus** precisely so the mobile phase recirculates. Verified post-fix (gen 350, WASM): W stays uniform ~0.69 across all 20 row-bands (no pooling), S1 (weak B-affinity) migrates to mean row ~53 while S2 (strong) lags at ~15 → two separated peaks.
- **Gravity** (Cheng & Kier 1995, JCICS 35:1054 — the cited oil-water paper defines gravity as a vertical SWAP ratio against the move-into-vacancy baseline P0; the chromatography paper simplifies it to ONE per-species term applied to all mobile components, *"the probability of a cell moving to a position further down the column"* = "the force pushing the mobile phase"): rendered as an additive `+G` on the SOUTH move-into-empty weight, on the same baseline scale as J. Implemented as a **post-loop OVERWRITE** of `weights[2]` using a CONSTANT index — two **JS-compile-only** hazards forced this exact shape (WASM tolerated both): (1) feeding the `forEachInArray` **index** into a compare/expression — rather than only into `arrayElement.position`/`setArrayElement.index` — gets that reader hoisted out of the loop by JS loop-invariance → runtime `_fei… is not defined`; (2) reading a SINGLE element of a Local-Variable array via `getVariable`+`arrayElement` (read-modify-write) tripped a `_v… is not defined` scoping bug. Overwriting `weights[2]` with a freshly-recomputed `empty?(J+G):0` (no variable read, constant index) is JS+WASM-safe and behaviourally identical to adding G inside the loop. **When generating Kier-style move models, keep the forEach index flowing only into array accessors.** (**Update — hazard #1 root-caused & fixed:** `forEachInArray` is now in `NEVER_INVARIANT` ([loopInvariant.ts](src/modeler/vpl/compiler/loopInvariant.ts)). Previously, when the forEach's input array was loop-invariant — e.g. a constant NI array from `getAllNeighborIndexes` — the composite rule classified the forEach node itself as invariant and propagated that to every `element`/`index` consumer whose OTHER inputs were also invariant, hoisting them to the function preamble where the per-iteration var is undefined (symptom: `breakDownNeighborIndex(element)` reads 0 for every neighbour). Marking the forEach never-invariant keeps all element/index consumers inside the loop on JS **and** WASM. The index-into-array-accessor workaround above is retained but no longer strictly required for #1.)
- **Detector line (event-driven stop)**: a bool cell attribute `monitor`, independent of the chemistry, that the `initEvent` flags `true` on the **bottom row** (the column outlet). A second flow branch off `step` (sibling of the move chain) fires a **`stopEvent`** node when a monitor cell has come to hold a solute — i.e. the leading solute (S1) has eluted (full traversal). Reuses `myType` (the cell-top `cellType` snapshot) so detection is correct even if the same async update also moves the solute on. This is the event-driven analog of the paper's fixed 600-iteration snapshot. Verified: stop fires at ~gen 1320 with an S1 cell at row 199, S1 mean row ~169 vs S2 ~48 (maximal separation at elution). Uses the existing Stop Event pipeline end-to-end (compiler collects the node + assigns `_stopIdx`; SimulatorView shows the blue pause notice) — no engine changes.
- **Chromatogram = the paper's Figure 3**: a linked **frequency spatial indicator** on `cellType` (`xAxis:'rows'`, `spatialBinMode:'absolute'`, `spatialBinSize:10`) with **`trackedValues:['S1','S2']`** so the chart shows ONLY the two solute curves — W/B/empty (which would otherwise dominate the shared Y-axis and flatten the solutes to ~0; `IndicatorSpatialChart` has no per-series hide) are filtered out at the worker's `sendColors` step. (Earlier builds carried a `soluteId` sub-attribute through the move + an Init-Event write to achieve this; the general **Track Categories / `trackedValues`** indicator option replaced it — no extra attribute, no per-cell maintenance. See the Indicators §.) Colour view = a **linked categorical** output mapping on `cellType` (zero graph nodes).
- 17 presets (`interactionTables` PB+J + `modelAttrs.gravity`): Table 1 standard + Table 2 affinity (5, both solutes share the swept PB(SB)/J(SB)) + Table 4 flow-rate/gravity 2·5·10 (3) + Table 5 solvent polarity PB(WW)/J(WW) (3) + Table 6 stationary solvation PB(WB)/J(WB) (3) + Table 7 solute+stationary solvation (2). Async ⇒ JS/WASM only (WebGPU excluded by `moveSelfToNeighbor`); verified that S1 (weak B-affinity, PB 0.90/J 0.20) outruns S2 (strong, PB 0.10/J 2.00). The `initEvent` seeds a probabilistic injection band on row `INJECTION_ROW` (=2, a couple rows below the very top — keeps a solute from taking the one upward move that would wrap it to the column foot via the vertical torus, which would blot the chromatogram's far end; ≈10 S1 + 10 S2) and a W/B/empty bulk (≈69%/7%/24%) on every other row; B's "≥3 cells apart" constraint is not enforced.

---

## Chemistry Primitives (B.0 + B.1 + B.3 + GroupOperator.weightedRandom)

Additions on the `variegated_cells` branch that collapse the per-direction unroll typical of Kier-style chemistry CA models. Together they cut the Amphiphile example graph from 125 → ~109 nodes (175 → 137 edges), and the high-level structure now mirrors the book's pseudocode for the move-into-empty rule. (The later "Transfer Cell Attributes to Neighbor" rework trimmed it further to 91 nodes / 89 edges by dropping the per-payload feeder reads — the node now reads the cells directly.)

### B.0 — `cardinalsOnly` flag on `GetAllFacingLabels`
Optional config (default false). When true, the node emits 4-slot N/E/S/W arrays (cardinal directions only) instead of the default 8-slot Moore arrays. Slot indexing collapses 0/2/4/6 → 0/1/2/3. The face-rotation arithmetic still uses the Moore slot for lookup, but the OUTPUT arrays are 4-wide. Per-target: JS allocates `Int32Array(4)`, WASM allocates `4 × I32`, WebGPU `array<i32, 4>`. UI checkbox in CaNode. Book §2.3.6 P_B product naturally fits this — it's defined over Von Neumann (4 cardinals) not full Moore.

### B.1 — `InteractionTableMap` node
Vectorised `LookupInteraction` over parallel face-label arrays. Inputs: `myFaces` + `theirFaces` (parallel int arrays — typically the two outputs of `GetAllFacingLabels` in cardinals-only mode). Output: `values` (float array, length = min of input lengths). Replaces N scalar `LookupInteraction` chains with one node + one per-cell loop. Pair with `Aggregate.product` for the book's `P_break = ∏ P_B(myFace, theirFace)` formula. Registered as an `ARRAY_NODE_EMITTER` on all three targets. `requirements: { variegated: true }`.

### D.2 — `GroupOperator.weightedRandom` op (replaces standalone `SampleArrayByWeight`)
Cumulative-sum weighted sampling folded into the existing `GroupReduce` node alongside its sibling `random` (uniform) op. Treats the input array as weights; outputs `result` = picked weight, `index` (alias `position`) = picked index. Empty / zero-sum input → `index = -1`, `result = 0`. Always advances the shared RNG once (xorshift32 on JS/WASM, per-cell PCG on WebGPU) — same always-advance semantics as every other RNG-using node so cross-target branched control flow stays in step. FP-drift fallback picks the last index if numerical drift puts u >= sum. The sibling uniform `random` op likewise draws from the shared `_rs` xorshift32 on JS/WASM (`floor((_rs/2^32)·len)`, always-advance) — it formerly used `Math.random()` on JS only (standalone `GroupOperatorNode.compile` + the fused `buildFusedGroupOperatorJS` path), which broke JS↔WASM parity + reproducibility; now both targets pick the same index for a given RNG state (WebGPU still rejects the `random` op).

The earlier standalone `SampleArrayByWeight` node was removed: the multi-source scalar variant exposed an invisible coupling (the SampleArrayByWeight's output `index` had no intrinsic order — it only worked when the same code wrote both the weight edges AND the consumer's index lookup, since edge order alone determined the implicit array order). `GroupOperator.weightedRandom` keeps the same operational shape (`values → result + position`, like uniform `random`) but its semantics demand a properly-ordered array source (or the same multi-source scalar convention Aggregate uses).

All three input shapes supported, mirroring Aggregate / the uniform `random` op:
- Single ArrayRef source (e.g. `InteractionTableMap → groupOperator.weightedRandom`) — the canonical chemistry pattern.
- Multi-source scalars (e.g. 4× per-direction `wt_d → groupOperator.weightedRandom`) — what the current Amphiphile uses pre-D.4.
- Single `getNeighborsAttribute` nbr-path source — materialises to a temporary array, then samples.

WASM emit lives in three sites paralleling the other groupOperator ops: `emitAggregateOrCount` (nbr-path), `emitArrayAggregate` (single ArrayRef), `emitScalarAggregate` (multi-source scalars). WebGPU emit lives at the top of `emitAggregateOrCount` and materialises all three input shapes through a unified post-fill path. JS emit is in `GroupOperatorNode.compile()` (standalone) plus `buildFusedGroupOperatorJS` (fused-nbr path).

### B.3 — `MoveSelfToNeighbor` node (label "Transfer Cell Attributes to Neighbor")
Flow node that copies/moves/swaps the *current* values of chosen cell attributes (and optionally orientation) between this cell and a target neighbour. Static ports: `do` (flow), `targetNI` (NI value) — there are NO payload or orientation input ports (both removed; the slots read straight from the cells). Config: `payloadCount` + per-slot `attr_${i}` (which cell attributes to transfer), `operation` (`'copyTo'` self→nbr / `'copyFrom'` nbr→self / `'swap'`), `nonReceiving` (`'untouched'` | `'defaults'`, copyTo/copyFrom only — what to do with the SOURCE cell that gave its values), `includeOrientation` (transfer orientation as an extra slot; reset default 0; requires Variegated Cells).

Per included attribute `A` (neighbour cell `nbr`), all inside `if (NI valid && nbr < total)`:
- copyTo: `w_A[nbr] = w_A[idx]`; if defaults → `w_A[idx] = default_A`.
- copyFrom: `w_A[idx] = w_A[nbr]`; if defaults → `w_A[nbr] = default_A`.
- swap: `tmp = w_A[idx]; w_A[idx] = w_A[nbr]; w_A[nbr] = tmp`.
The pre-rework behaviour (= **Copy To + Defaults**) is preserved byte-for-byte.

**Post-update semantics (key — user requirement):** reads AND writes both go through the WRITE buffer (`w_A` in JS, `attr.writeOffset` in WASM) at the node's flow position — NOT a cell-top snapshot. So whatever was written to self or the neighbour *earlier in this step* (setAttribute / setNeighborAttributeByIndex / setOrientation) is what gets transferred. Async-only ⇒ write buffer aliases read buffer (`writeOffset === readOffset`), so it IS the live current state. This intentionally differs from the old cell-top-snapshot behaviour.

Async-only (it writes neighbour cells: copyTo / swap / copyFrom+defaults). WebGPU rejects via `detectWebGPUIncompatibilities`; sync mode rejected. JS + WASM emit only (no WebGPU emitter).

Pre-resolve (`preResolveMoveNodes` in `compile.ts`) bakes each slot's attribute defaultValue into `_attr_${i}_default` config (string), normalising `'true'`/`'false'` → `'1'`/`'0'` — used for the Defaults option. WASM reuses the read-modify-write-at-writeOffset pattern (mirrors `updateAttribute`); swap uses temp locals.

**Orientation gating (non-variegated safety):** orientation only exists in Variegated Cells models (the `r_/w_orientation` buffers are allocated only then). A stale `includeOrientation: true` on a model whose variegation was later turned off (or a hand-edited file) would emit a reference to the unallocated buffer. Guard: the CaNode "Include Orientation" checkbox is rendered ONLY when `model.variegatedCells?.enabled`; and the emit ignores the flag when not variegated — JS reads `_includeOriResolved` (baked by `preResolveMoveNodes` as `includeOrientation && variegated`), WASM gates `includeOri` on `ctx.layout.variegatedEnabled` (it no longer hard-errors). Variegated models are byte-identical (the flag passes through). The `nodeValidation` badge still flags the mismatch in the modeler.

CaNode UI: Operation dropdown + Source-cell dropdown (hidden for swap) + attribute-slot rows (dropdown + `−`, `+ Slot`) + `Include Orientation` checkbox (variegated models only). One node replaces the old multi-node Amphiphile move sequence.

Migration: `src/model/moveSelfToNeighborMigration.ts` (mirrors `colorScaleMigration`; wired into LOAD_MODEL + `macroImport`) upgrades legacy nodes (payload/orientation ports + `transferOrientation`) → `operation:'copyTo'` + `nonReceiving:'defaults'` + `includeOrientation`, dropping the dead `payload_*` / `orientation` edges (handles `input_value_payload_*` / `input_value_orientation`). Idempotent — keyed off a missing `operation` config key. The node type id stays `moveSelfToNeighbor` (only label + config changed).

### Pre-resolve config injections (compile.ts)
`interactionTableMap` joins `lookupInteraction` in the variegation pre-resolve pass that injects per-table `_rowCount`/`_colCount` (col = row-major stride) resolved via the table's `rowKeySource`/`colKeySource` → `resolveKeyLabels(...).length`. JS-target only; WASM/WebGPU read per-table `ctx.layout.interactionTableOffsets[id].colCount` directly (the old single global `interactionTableLabelCount` is gone). The Lookup Table memory region is allocated whenever the model has any `lookupTable` model attr — independent of variegation (WASM `lookupTables` layout param; WebGPU varAux). JS emits the `_lookupTables` param when `variegated || hasLookupTables`.

### Behavioural notes
- `groupOperator.weightedRandom` always advances the RNG even on empty/zero-sum input. Models that relied on conditional RNG skipping would see different sequences — but no existing model uses this pattern (the op is new).
- InteractionTableMap is pure (CSE-eligible per `accessorCSE.ts`'s purity rules — it has no RNG, indicator reads, or write side-effects). `groupOperator.weightedRandom` is impure (RNG) — same as the existing `random` op. The accessor-CSE classifier already filters `groupOperator` instances by op name (any op === `'random'`), and the same filter covers `weightedRandom` automatically.
- `interactionTableMap` on a sub-attribute source: untested. The scalar `lookupInteraction` doesn't handle sub-attributes either (interaction tables are typically full model-attribute lookups). If users need sub-attribute-aware variants, file follow-up.

---

## Local Variables (schema-level feature, all three compile targets)

**Local Variables** are per-cell mutable scratch storage referenced by id across the graph. They let the user write rules as imperative pseudocode — "declare a value here, mutate it in a loop, read it elsewhere" — bridging the gap between GenesisCA's pure-dataflow model and the imperative style most CA rules are written in (e.g. "for each direction d, weights[d] = compute(d); then sample by weights").

### Lifetime + storage

- **Per-cell, per-step.** Each cell sees a fresh copy populated with `initialValue` at the start of its computation; mutations live only within that cell-step. No persistence across cells, no persistence across steps.
- **JS:** function-local in the compiled step. Array variables get ONE typed-array buffer allocated outside the cell loop (reused per cell) and refilled via `.fill(initialValue)` at cell-top. Scalar variables become per-cell `let _var_<id> = <init>;` declarations.
- **WASM:** ctx.variableLocals maps each variable to a slot. Scalars get a WASM function-local (`F64` for float, `I32` otherwise). Arrays get a function-local holding a scratch offset that's bumped each cell at cell-top (storage lives in per-cell scratch — fresh allocation, then unrolled fill with the initial value). `emitVariableStorage()` runs once at function entry; `emitVariableReset()` runs at cell-top inside `emitBody`.
- **WebGPU:** WGSL `var<function>` declarations at the top of every entry function (one shader invocation = one cell, so function scope is naturally per-cell). Scalars: `var<function> _var_X: T = init;`. Arrays: `var<function> _var_X: array<T, N>;` + unrolled init. WGSL types: i32 for bool/int/tag, f32 for float (no f64 in WGSL — same precision tradeoff as cell attrs).

### Schema (`Variable` in src/model/types.ts)

`{ id, name, description?, kind: 'scalar' | 'array', dataType: 'bool' | 'integer' | 'float' | 'tag', length?, initialValue, attributeId? }`. The `initialValue` string follows the same encoding as `Attribute.defaultValue` (bools as `"true"`/`"false"`, tag indices as `"0"`/`"1"`/..., numbers as decimal strings). For arrays, ALL elements reset to that one value (uniform fill — per-index init is a v1 limitation).

`model.variables` is the top-level array on CAModel. Cascade rules in ModelContext: removing the attribute a tag variable references demotes the variable to integer + clears `attributeId`; remapping the parent attr's `tagOptions` remaps the variable's `initialValue` via the same indexMap used for graph nodes; changing the attr's type away from tag also detaches.

### Three new node types

- **`getVariable`** (value): outputs the current value (scalar) OR the underlying typed array (array). Consumers iterate it like any other array source (Aggregate, GroupReduce, ArrayElement, ForEachInArray). Registered in BOTH `VALUE_NODE_EMITTERS` and `ARRAY_NODE_EMITTERS` on WASM and WebGPU — the dispatcher picks the right path based on the consumer's input port; the emitter errors out if the variable's kind doesn't match the dispatch path. Also listed in `isArrayProducer` on both backends so array consumers route correctly.
- **`setVariable`** (flow): assigns a value to a scalar variable. Validation rejects array variables (use SetArrayElement instead).
- **`setArrayElement`** (flow): writes `variable[index] = value` for array variables. Out-of-range writes silently skip — bounds-checked at runtime on all three targets (JS `if (i >= 0 && i < arr.length)`, WASM via `i32` compares wrapped in `ifThen`, WGSL via `if (i >= 0 && i < N)`).

### Loop-invariance gotcha (critical)

`getVariable` is on the `NEVER_INVARIANT` list in `loopInvariant.ts`. Without this, the composite rule classifies the GetVariable read (which has no value inputs) as vacuously invariant — and through it, every downstream consumer (Aggregate over the variable, GroupOperator over the variable, ArrayElement at the variable's chosen index). The hoist then emits the consumer chain at function scope BEFORE the cell loop runs and ANY writes happen. Symptom: `_rs` (declared just before the cell loop) is referenced in the hoisted weightedRandom emit (which uses RNG), producing `Cannot access '_rs' before initialization` at runtime. The fix is the entry in `NEVER_INVARIANT` — without it the model compiles but is silently broken for any variable used by a downstream aggregate.

### Volatile values (critical — the deeper mutation hazard)

`NEVER_INVARIANT` keeps the read per-cell, but a second hazard remains: **sink analysis** would still hoist a value like `aggregate.sum(getVariable(weights))` to scope-entry (above the `forEach` body that calls `setArrayElement(weights, …)`), so the aggregate reads the all-`initialValue` array before the loop populates it. Symptom (Amphiphile): `sumW` always 0 → `condCanMove` never fires → no cell ever moves, even though gen advances and counts are preserved. The fix is the **volatile-hoist** mechanism (shared [volatileHoist.ts](src/modeler/vpl/compiler/volatileHoist.ts)): nodes that transitively read `getVariable` (`computeVolatileValueClosure`) are emitted at the **LCA flow scope of all their uses**, immediately before the first flow node in that scope whose subtree references the value — i.e. AFTER the mutating flow siblings (so the read sees post-write state) and dominating every branch (so a value used across multiple `switch` cases / `if` arms is emitted ONCE, not re-declared per branch). `computeVolatileHoist` returns `emitBefore: Map<flowNodeId, volatileId[]>`; each compiler force-emits those before the flow node in its `compileFlowChain` target loop. **NO loop-hoist** — a volatile read inside a loop body stays there (re-evaluated each iteration after the in-loop write); diamond regions hoist out (mirrors sinkAnalysis).
- **The two bugs this closed (all three targets):** (1) the original "emit inline at first use" v1 scheme broke when a volatile value was consumed in MULTIPLE sibling branches — the first branch declared it in its own block and siblings referenced an out-of-scope variable (JS `ReferenceError`; WASM stale function-local; WGSL block-scope error). (2) On JS specifically, a macro of `getNeighbors→count → setVariable` read across switch cases hit BOTH this AND the (now-deleted) lazy-inliner's missing internal value-dep emit. Both are gone — verified runtime-correct on JS + WASM (a derived volatile `gv+100` read across two switch cases yields the right value on every cell on both branches) and compile-clean + structurally hoisted on WebGPU.
- **JS** ([compile.ts](src/modeler/vpl/compiler/compile.ts)): volatile closure; volatiles skipped in `collectValueDeps`; `compileFlowChain` calls `compileValueNode(vId)` for `volatileHoist.get(target.nodeId)` before the dispatch (routes inline at the enclosing indent via the existing `volatileEmitTarget`; the `compiled` set dedups in-branch uses).
- **WASM** ([wasm/compile.ts](src/modeler/vpl/compiler/wasm/compile.ts)): `computeVolatileValueClosureWasm` + `emitValuesForScope` skips them; `compileFlowChain` pre-emits `ctx.volatileHoist.get(target.nodeId)` (dispatch value vs array; **skip `getVariable`** — it reads variable storage directly with no temp local, and is dual-registered in both emitter tables so eager emission picks the wrong path).
- **WebGPU** ([webgpu/compile.ts](src/modeler/vpl/compiler/webgpu/compile.ts)): forces every volatile's `sinkAnalysis.emitScope` to `CELL_TOP` (so `routeEmissionForNode` emits at the current flow position when triggered); `ctx.suppressVolatile` makes `compileValueNode`/`compileArrayNode` skip volatiles during `preEmitValueNodes`; `compileFlowChain` pre-emits `ctx.volatileHoist.get(target.nodeId)` (skip `getVariable` — its WGSL emit returns the `var<function>` directly, no block-scoped `let`).
- Companion fix: `findElementDependents` (JS) and `elementDependentsByForEach` (sinkAnalysis) must seed the BFS with BOTH `forEach.element` AND `forEach.index` — Amphiphile's body indexes parallel arrays by `index`, so index-dependent values were wrongly hoisted out of the loop.
- **`forceVolatileCurrentScope` / `ctx.forceCurrentScope` (critical — the nested non-volatile input):** a volatile value's input can be a NON-volatile node reachable ONLY through the volatile (e.g. `getRandom` feeding `getVariable + rand`). Such an input is NEVER pre-emitted (the pre-emit walk skips the volatile that would reach it), so it's first compiled DURING the volatile's force-emit — and if routed to its own sink scope it lands in an already-flushed branch buffer (JS `branchValueLines` / WebGPU `branchLines`) → undefined at runtime in the branch that uses it (symptom: JS `ReferenceError: _v… is not defined` → worker dies → generation stuck at 0; WebGPU `unresolved value '_…'` at device shader-compile). Fix: while force-emitting a volatile (the `volatileHoist.emitBefore` loop in each `compileFlowChain`), set a flag so EVERY emission — the volatile AND its transitively-pulled inputs — routes to the CURRENT flow position. JS = `forceVolatileCurrentScope` short-circuit at the top of `routeValueEmit`; WebGPU = `ctx.forceCurrentScope` short-circuit at the top of `routeEmissionForNode`. WASM needs no flag — it emits bytecode positionally, so the input's `localSet` already lands inside the branch (this is why WASM "worked" while JS/WebGPU broke on the same model). Inputs shared with a non-volatile consumer are already pre-emitted (cached) so the flag is a no-op for them; it only catches volatile-only-reachable inputs. **Carve-out (added with the branch-scope fix): a non-volatile input dragged in by the force-emit whose OWN sink scope is `CELL_TOP` is SHARED** — its uses span sibling branches — so pinning it at the current flow position declares it inside ONE branch and the sibling reference is out of scope. Those route to `valueLines` instead (pure ⇒ cell-top always dominates, and `valueLines` is assembled ABOVE `flowLines`, so pushing mid-walk is safe). Branch-scoped inputs — the canonical `getRandom`-feeding-volatile-arithmetic case — keep the current position. See "Agent-compiler branch-scope + RNG-order fixes".

### ForEach.index — companion enhancement

`ForEachInArray` exposes a new `index` output port carrying the per-iteration loop counter. The compile plumbing was already there (`_fei<id>` in JS, `fi` in WASM-WebGPU local); just needed a port + a varName mapping in all three targets. Body-side nodes that need to index parallel arrays by slot (`kindsArr[d]`, `myFaceArr[d]`, etc.) read this instead of `element`. Amphiphile's per-direction loop body uses it heavily.

### Validation

- All three nodes require `variableId`. Missing config → warning badge.
- SetVariable rejects array-typed variables; SetArrayElement rejects scalar-typed.
- Local Variables now emit on **all three targets** (JS, WASM, WebGPU — see "Lifetime + storage" above for the per-target storage strategy). The earlier `detectWasmIncompatibilities` / `detectWebGPUIncompatibilities` guards that rejected the three nodes have been removed.

### Panel UI

`VariablesPanelSection` lives **inside the Attributes panel** (a section below Cell + Model Attributes), but its editor opens in the **shared second detail panel** (not inline). It's a CONTROLLED master-detail child: `{ mode: 'list'|'detail', selectedId, onSelect }` props — `AttributesPanelContent` owns one discriminated `attr:`/`var:` selection slot and renders `<VariablesPanelSection mode="list">` in the primary panel and `<VariablesPanelSection mode="detail">` in the detail panel (when a `var:` is selected). Selecting an attribute clears the variable selection and vice-versa. A `.sectionHelp` line carries a short description under the section title (styled to match the compile-target option descriptions: `0.66rem`, `#888`, non-italic). Inspector fields: name, description, kind, dataType, length, initialValue, tag attribute for tag-typed variables, delete button. `+ Variable` adds a new variable with sensible defaults (scalar float, initialValue 0). Variable rows are draggable to the canvas like the other panel elements: payload `{ kind: 'variable', variableId, varKind }` in [modelElementDrag.ts](src/modeler/vpl/modelElementDrag.ts); `relatedEntriesForPayload` kind-gates the related nodes (scalar → Get/Set Variable, array → Get Variable/Set Array Element) so the drop menu never offers a node that would instantly carry a validation badge. All consumers of `RELATED_NODES` lookups go through `relatedEntriesForPayload`.

### Behavioural notes

- The `_var_<id>` JS local name uses a sanitised version of the variable id (`[^a-zA-Z0-9_]` → `_`). Stable across the GetVariable / SetVariable / SetArrayElement emit + the `variable.ts::variableLocalName` helper.
- Array length is fixed at compile time (the value of `length` config). Resizing the variable's length re-allocates the typed-array on the next recompile.
- The reset cost is ONE `.fill()` call per array variable per cell — V8 optimises this to a memset. Scalar variables cost one `let` per cell. Both are negligible compared to the work the cell rule does.
- On JS/WASM, variable decls are injected only into the `step` root (`buildVariableJS` is called inside the step compile; InputColor + OutputMapping don't get them). WebGPU's `emitVariableDeclsWgsl` runs at the top of every entry function (step/initEvent/outputMapping — **there is NO WebGPU inputColor shader**; painting runs the JS fn on the CPU then `patchWebGPUCells`) — a benign superset (dead decls if no variable node is reached there). If a future model needs variables in InputColor/OutputMapping on JS/WASM too, extend `buildVariableJS` / `emitVariableStorage` to those compile branches.

---

## Sub-Attributes (schema-level feature)

A **sub-attribute** is a cell attribute that's "only well-defined" on cells whose parent (Tag or Boolean) cell attribute holds one of a chosen set of values. Wireworld's `charge` only makes sense on Wire / Pulsar / Switch cells; sub-attributes encode this in the schema so the compiler injects parent-check guards automatically, and the graph never has to wire up manual filter-by-type chains.

### Schema

Three optional fields on `Attribute` (`src/model/types.ts`):
- `parentAttributeId?: string` — presence marks the attribute as a sub-attribute; references the parent cell attribute.
- `parentValues?: string[]` — encoded same as `defaultValue` (tag indices as `"0"`/`"1"`/..., bools as `"true"`/`"false"`).
- `undefinedValue?: string` — the value reads see when parent doesn't match.

The existing `defaultValue` plays a double role: init/reset value AND the value the copy-line / pre-scrub uses for non-matching cells between steps. Three fields total, all optional, all additive — old `.gcaproj` files load unchanged.

### Read semantics — context-dependent

- **Scalar reads** (`GetCellAttribute`, `GetNeighborAttributeByIndex` with a fixed index, `GetNeighborAttributeByTag`): the read emit wraps with `parent_matches(r_parent[idx]) ? raw_read : undefinedValue`. The user explicitly asked for ONE specific cell's value; they get a value either way.
- **Iteration contexts** (per-neighbor reads inside `GetNeighborsAttribute`, predicates inside `FilterNeighbors`, the per-element loop in `Aggregate`/`GroupOperator`/`GroupCounting` when fed from sub-attribute sources, and the worker's `computeLinkedIndicators` aggregation): non-matching cells are EXCLUDED from the iteration entirely. They don't appear in result arrays, predicates never evaluate them, aggregations skip them. The user's mental model is "a sub-attribute doesn't exist on cells where the parent doesn't match" — iteration treats those cells as if they weren't there.

### Write semantics

Writes ALWAYS proceed (rule a) regardless of parent. Storage at non-matching indices is invisible to reads (the guard returns `undefinedValue`), so "garbage" stored there is harmless. This sidesteps the order-of-writes hazard in async mode: a rule that writes `charge` before `cellType=Wire` in the same cell must not silently drop the charge write.

### Per-cell conditional copy (sync mode)

Both JS and WASM compilers emit a per-cell conditional copy at the top of the step loop body for sub-attributes: `w_subattr[i] = parent_matches(r_parent[i]) ? r_subattr[i] : defaultValue`. This:
- Auto-scrubs storage to `defaultValue` one step after a flip-OUT (parent transitions out of valid).
- Establishes a "starting point" for the cell rule. User writes (which happen later in the cell body) overwrite as needed, so order between `setAttribute(charge)` and `setAttribute(cellType)` doesn't matter.
- JS: in `compile.ts`, the bulk `cellAttrs.map(a => 'w_${a.id}.set(r_${a.id});')` skips sub-attrs; `subAttrSyncCopyLines` are injected at the top of the loop body instead. InputColor (per-cell, non-loop) uses the same conditional shape inline.
- WASM: `emitBulkCopyLines` skips sub-attrs (no bulk `memory.copy`); `emitBody` emits a `select`-based conditional copy at the top of each cell iteration for sub-attrs.

### Async-mode pre-scrub (worker)

Async mode shares a single buffer (`r_` and `w_` point at the same typed array), so the per-cell copy doesn't fit. Instead, `sim.worker.ts` runs `applySubAttributeAsyncScrub()` once per step before the cell loop: for each sub-attribute, set storage to `defaultValue` at indices where the parent's value isn't in `parentValues`. O(N) per sub-attribute per step.

### CompileContext (JS-target)

JS-target nodes that emit attribute reads call `ctx.readAttrExpr(attrId, idxExpr)` (5th arg on the `NodeTypeDef.compile` signature) instead of inlining `r_<id>[<idx>]`. For sub-attributes the helper emits the wrapped expression; for regular attributes it passes through. The matching `ctx.parentMatchesExpr` returns the iteration-skip predicate (or null for regular attrs). Helpers live in `src/modeler/vpl/compiler/subAttribute.ts` (target-independent core: `isSubAttribute`, `subAttrInfo`, plus JS-string emit helpers `attrValueLiteralJS`, `parentMatchExprJS`).

### Compile-target coverage

- **JS** — full support, scalar + iteration.
- **WASM** — full support across the whole node catalogue. All scalar reads, the per-cell sync conditional copy, and every iteration emitter (`aggregate`, `groupCounting`, `groupOperator` including `median`/`random`, `groupStatement` for allIs/noneIs/hasA/etc., `filterNeighbors`, `getNeighborsAttrByIndexes`) handle sub-attributes. For `aggregate.average` and `groupOperator.min`/`max` on sub-attrs, the WASM emit tracks a `matchCount` local so the post-divide uses the filtered count and `bestIdx` reports the position-in-filtered-set (matches JS semantics). Median materialises into per-cell scratch with parent-match filter, then sorts the filtered prefix. Random filters values into scratch and picks uniformly from the filtered length (RNG still advances on empty matches to mirror JS `Math.random()` semantics; empty filtered set returns 0).
- **WebGPU** — full support across the WebGPU subset of the catalogue (the general `aggregate.median` / `groupOperator.random` rejection still applies, regardless of sub-attr status, because the WGSL emit doesn't have a sort or random-pick path). Scalar reads use `select(undefined, raw, parent_match)` via `readAttrGuarded`. Iteration consumer loops (filterNeighbors, getNeighborsAttrByIndexes, aggregate/groupOperator/groupCounting/groupStatement nbr-path) inject `if (!parent_match) { continue; }`; for nbr-path aggregate, `matchCount` drives the average post-divide and `(matchCount - 1)` is the iterTag for groupOperator min/max (position-in-filtered-set, matching JS/WASM). Aggregate fusion is disabled when the source attribute is a sub-attribute (route through the materialised filter-with-push path instead). Per-cell conditional copy via WGSL `select(defaultWord, attrsRead[..], parent_match)` mirrors JS/WASM's sync copy line at the top of `step`. Sub-attribute linked indicators bypass the GPU reduction shader (LinkedDef.isSubAttribute) and route through the CPU `computeLinkedIndicatorsFromBuffer` path, which already applies the parent-match guard.

### Indicator aggregation

`computeLinkedIndicatorsFromBuffer` (sim.worker.ts) is an iteration context. For sub-attribute linked indicators, the per-cell loop prepends a parent-check guard — non-matching cells contribute to neither frequency buckets nor total sums. As a free upside, "total energy of predators"–style indicators become trivially expressible: mark `energy` as a sub-attribute of `creatureType` with `parentValues=[Predator]` and use a vanilla Total linked indicator on `energy`.

### Cascade behaviour

In `ModelContext` (`UPDATE_ATTRIBUTE` / `REMOVE_ATTRIBUTE` reducers):
- Deleting an attribute that's used as a sub-attribute's parent auto-detaches the dependents (clears `parentAttributeId` / `parentValues` / `undefinedValue` on each).
- Editing a parent's `tagOptions` remaps sub-attributes' `parentValues` (mirrors the existing tag-index remap for node configs). Tag entries whose names were removed are dropped from the set; surviving names are remapped to their new index.
- Changing a parent attribute's type AWAY from Tag/Bool auto-detaches dependents.

### Gotchas

- The worker's `AttrDef` must carry the three sub-attribute fields (`parentAttributeId`, `parentValues`, `undefinedValue`). SimulatorView's `init` message construction must include them or the async pre-scrub silently no-ops because `cellAttrs[i].parentAttributeId` is `undefined`.
- `scratchCtorForAttr` (JS compile.ts) returns `''` for sub-attributes — the scratch array must be a plain `Array` (not typed) so `GetNeighborsAttribute`'s filter-with-push pattern can call `.length = 0` and `.push()`. Typed arrays don't permit those operations.
- WASM `select` (opcode `0x1b`) pops `[a, b, cond]` and pushes `a` when `cond != 0`, else `b`. The emit pushes value-first, then undefined, then condition — so `cond=match`, `a=value`, `b=undefined`. Easy to flip if you're not careful.
- WGSL `select(falseValue, trueValue, cond)` is the OPPOSITE order from WASM `select`. Both targets emit conditional copy + scalar-read guards, but the literal argument order differs — `readAttrGuarded` emits `select(undefined, raw, match)` and the per-cell copy emits `select(defaultWord, attrsRead[..], match)`.
- WebGPU's `LinkedDef.isSubAttribute` must be set when building `linkedDefs` from the model. `buildReductionPlan` uses it to skip sub-attr indicators (CPU readback path applies the parent-match guard); without the flag, the reduction shader would aggregate over every cell and double-count the defaultValue bucket (sub-attr storage is scrubbed to defaultValue on non-matching cells by the sync copy line).

---

## Linked Output Mappings (schema-level feature, all three compile targets)

A quality-of-life feature that lets users **auto-generate** an Attribute→Color output mapping's color pass instead of hand-building the node graph — the on-ramp for newcomers who just want to *see* their model. Each A→C mapping (`isAttributeToColor`) has a **Color pass** mode:

- **Standalone** (classic): the user builds the color pass by hand (Output Mapping event node → … → Set Cell Looks).
- **Linked**: the user picks a cell attribute and the color pass is generated automatically — **bool** → two colors (default black/white); **float / integer** → a Color Scale spanning a user-set min/max (palette presets or hand-tuned stops); **tag** → one distinct color per option (categorical, no blending).
- **Override-after-background**: if the user *also* drops an Output Mapping node for a linked mapping, the auto pass runs **first** (a background coloring every cell), then the user's graph runs and overrides whichever cells it paints (special colors, glyphs). Both write the same `colors` buffer; within one OM function the LAST write wins.

### Architecture — synthesis, NOT per-target emit
The auto pass is produced by a **shared, target-agnostic pre-compile graph transform** that synthesizes **real nodes** (`getCellAttribute → colorScale | categoricalColor → setCellLooks` (plain mode), rooted at an `outputMapping` node, sequenced via a `Sequence` node). All three compilers then reuse their existing per-node emitters — there is **no per-target color math** for linked mappings. This is the key reason the feature is low-risk: it rides the already-verified `colorScale` / `getCellAttribute` / `setCellLooks` / `sequence` emitters on JS/WASM/WebGPU.

- `src/modeler/vpl/compiler/linkedOutputMappings.ts` — `injectLinkedOutputMappings(graphNodes, graphEdges, model)` returns augmented `{ nodes, edges }`. Hot-path no-op when no linked mappings. Per linked mapping: synthesize the value chain + a terminal `setCellLooks` (plain mode); if no user OM node exists, synthesize an `outputMapping` root → auto chain; if a user node exists with downstream, insert a `Sequence` (`first` = auto, `then` = the user's original target, preserving its target handle); user node with no downstream → wire root straight to the auto chain. Deterministic synthetic ids prefixed `__linkedOM_<mappingId>_`.
- **Per-compiler injection points** (all BEFORE accessor-CSE + `buildAdjacency`): JS `compileGraph` ([compile.ts](src/modeler/vpl/compiler/compile.ts)) — injected at the TOP, **before** the `graphNodes.length === 0` early return, so a linked-only model (no user nodes) still compiles; WASM `compileGraphWasm` and WebGPU `compileGraphWebGPU` — **after** `expandMacros`, before CSE. WebGPU MUST rebind the `const nodes` used by the OM-emission loop (`outputNodes.find(... mappingId ...); if (!root) continue;`) or it silently shows default colors while JS/WASM render.

### Freshness guarantee (no stale definitions)
The synthesized subgraph is **ephemeral** — never serialized, rebuilt from the *current* model on every recompile (and `SimulatorView`'s `useEffect([model])` recompiles on every model change). Only the small `Mapping.linked*` config persists. Two layers keep it sound: the ModelContext cascade (layer 1) + the transform's live resolve/guard/clamp (layer 2). The transform resolves the attribute live by id, branches on its live `type`, and (tag) clamps the palette to the live `tagOptions`, so a stale config can never emit a dangling read. Attribute **rename** needs no cascade (synthesis is id-based, never name-based).

### Schema ([types.ts](src/model/types.ts), all optional → old files load unchanged)
- `Mapping.linked?`, `linkedAttributeId?`, `linkedMin?`, `linkedMax?`, `linkedColors?: LinkedColorSet`.
- `ColorStop { position: number; r,g,b }` — gradient stop; `position` is in **[0,1]** (same space as the Color Scale node) and is mapped onto `[linkedMin, linkedMax]` at compile time (raw attribute value fed as `t`; ColorScale clamps outside the range).
- `LinkedColorSet { gradient?: ColorStop[]; method?: string; tag?: RGB[] }`. `gradient` covers bool (2 stops at 0/1) / float / integer; `method` is the interpolation curve; `tag` is per-option colors. Absent sub-fields → auto defaults generated by the transform.

### `categoricalColor` node ([CategoricalColorNode.ts](src/modeler/vpl/nodes/CategoricalColorNode.ts)) — the only NEW emitter
First-class, user-facing color node: input `index` (int), multi-output `r`/`g`/`b`, config `count` + `entry_<i>_(r|g|b)` + `default_(r|g|b)`. Emits an N-way integer-compare select (discrete lookup; contrast `colorScale` which interpolates). Used by the transform for tag attributes, and available for hand-built graphs. Registered in `MULTI_OUTPUT_TYPES` (compile.ts) + both WASM/WebGPU `VALUE_NODE_EMITTERS` (per-port `setCachedPort` is the multi-output registration). Pure → CSE-eligible by default. Config UI = palette editor in CaNode (`CategoricalColorEditor`). `readCategoricalEntries` / `readCategoricalDefault` are shared by all three emitters.

### Color Scale presets + shared editor
- `src/modeler/vpl/nodes/colorScalePresets.ts` — `COLOR_SCALE_PRESETS` (Grayscale, Viridis, Magma, Plasma, Inferno, Rainbow, Heat, Cool→Warm, Cividis) + `presetStops(name)`. Single source for both consumers.
- `src/modeler/vpl/widgets/GradientStopsEditor.tsx` — the gradient-bar editor (draggable stops + position/color/delete detail + Add Stop) **plus a preset dropdown**, extracted so it's reused by BOTH the Color Scale node (`ColorScaleEditor` is now a thin config↔stops wrapper) AND the linked float/integer editor. The linked editor adds the min/max Range + the Curve (`method`) dropdown for full parity with the node. Bool uses two pickers; tag uses per-option pickers. Defaults: float → Viridis, integer → Rainbow (via the transform's `defaultGradientStops`).

### Cascade ([ModelContext.tsx](src/model/ModelContext.tsx))
- `REMOVE_ATTRIBUTE`: unlinks any mapping linked to the deleted attribute (clears `linked*`).
- `UPDATE_ATTRIBUTE` type change: resets `linkedColors`/`linkedMin`/`linkedMax` (keeps the link) so a stale palette can't mismatch the new type — handled in both the tag/bool branch and the fall-through (covers float↔integer).
- `UPDATE_ATTRIBUTE` tagOptions change: remaps `linkedColors.tag[]` by the same `indexMap` (renamed/reordered keep their color, deleted drop out, new options get `defaultTagColor`).

### Gotchas
- Viewer tabs come from `model.mappings.filter(isAttributeToColor)` ([SimulatorView.tsx](src/simulator/SimulatorView.tsx)), so a linked mapping is selectable with no node placed; the worker dispatches the OM by `mappingId === activeViewer` exactly like a standalone OM (no new runtime path).
- `style={{ width: N, ...sharedStyle }}` foot-gun: if `sharedStyle` sets `width: '100%'`, the spread overrides the `N`. Put the override AFTER the spread (bit the GradientStopsEditor position input — kept the bar from squashing the color/delete controls).
- Inline-style overrides in shared widgets: the position spinbox is fixed-width + `flex: 0 0 auto`; the color input is `flex: 1`. Don't reintroduce `width: 100%` on the spinbox.
- A linked-only model with no Step node still hits the separate "No Step node" compile gate (the empty-graph reorder only covers the `length === 0` check). Realistic models always have a Step; relaxing the Step requirement is out of scope.

---

## Composite Value Types — Vector & Color + Get Self Handle

Two new **bundled value port types** (the Unreal/Blender Make-Break pattern) so a graph passes a whole vector or colour on ONE wire instead of per-component scalars, plus a small agent node exposing the self id.

### Data types ([types.ts](src/modeler/vpl/types.ts) `PortDataType`)
- **`vector`** — a 2D/3D vector value (the Z component exists only in a 3D model; the Z port is hidden via `hiddenPorts` keyed on `is3dModelLike`).
- **`color`** — RGBA (0–255 channels, A defaults 255).
- Both are **EDITOR SUGAR**, not a runtime value type — they're LOWERED to scalar nodes before any per-target compile (see "All-target lowering" below). So the compilers carry **zero** vector/colour-specific emit; vectors run NATIVELY on JS / WASM / WebGPU via the verified scalar emitters (NOT a JS-only clamp — this is the ALL-TARGET DELIVERY rule).

### Nodes (6)
- **Get Self Handle** ([GetSelfHandleNode.ts](src/modeler/vpl/nodes/GetSelfHandleNode.ts), `getSelfHandle`, agent/`bondGraph`): outputs the current agent's own id (`const _v<id> = idx`). Feed it to the by-id nodes (Get Agent Attribute, a wired Set Attribute, Get Agent Position/Offset, Form/Break Bond). Emitted on **all three** agent targets (JS / WASM `localGet(idxLocal)` / WebGPU `f32(idx)`) + in `AGENT_WASM_SUPPORTED_TYPES` + `AGENT_WEBGPU_SUPPORTED_TYPES`. (This one is a real node, not lowered.) **In `NEVER_INVARIANT`** ([loopInvariant.ts](src/modeler/vpl/compiler/loopInvariant.ts)) — it has NO value inputs and emits the bare loop variable `idx`, so without it loop-invariance treats it as vacuously invariant and hoists it ABOVE the per-agent `for (let idx…)` decode (JS `idx is not defined`; WASM silently reads `idxLocal`=0 → always handle 0). Surfaces the moment Get Self Handle feeds a by-id node (e.g. Get Agent Position's `Reference` / Form Bond).
- **Make Vector** / **Break Vector** / **Vector Op** (Add/Subtract/Scale/Dot/Cross/Length/Normalize/Distance/Negate/Lerp/**Rotate (2D)**/**Rotate Around Axis (3D)**) — Vector Op + Break Vector are multi-output (in `MULTI_OUTPUT_TYPES` for the editor; the compiler never sees them). Vector Op's `hiddenPorts` shows ports per op (B for binary ops, Scalar for scale, T for lerp, `Axis` for rotateAxis, `Angle°` for both rotations, `value` for Dot/Length/Distance else `result`). **The two rotations take DEGREES** (`Angle°`, inline widget) — matching every other user-facing angle surface (the FOV nodes' Half-angle°, sprite compass degrees), while the Expression node's raw `sin`/`cos` stay radians; the lowering multiplies by π/180 (`DEG_TO_RAD`, exported from [VectorOpNode.ts](src/modeler/vpl/nodes/VectorOpNode.ts)) and then uses the already-lockstepped `sin`/`cos` arithmetic ops, so both rotations run on **all three targets, cell + agent, 2D + 3D, with zero per-target emit**. A positive angle rotates **from +X toward +Y = CLOCKWISE on screen** (rows/Y grow downward — the same convention Sense Hemifield's `cross = hx·dy − hy·dx ≥ 0 ⇒ Left` uses). **Rotate** spins the XY plane about Z and passes Z through unchanged (available in 2D AND 3D — in 3D it IS a rotation about the Z axis). **Rotate Around Axis** is Rodrigues (`v·cosθ + (k̂×v)·sinθ + k̂(k̂·v)(1−cosθ)`) with the axis normalised through the SAME guarded divide `normalize` lowers to, so a **zero axis ⇒ k̂ = (0,0,0) (÷0→0) ⇒ v·cosθ** — documented, well-defined on every target; it is offered ONLY in a 3D model (the CaNode dropdown filters it on `is3dModelLike`, and a stale `rotateAxis` config stays selectable + carries a `nodeValidation` badge). cos / sin / (1−cos) / the normalised axis / the axis dot are each ONE synthesized node reused per component (structural sharing — accessor-CSE is off in async agent mode). Verified by [scripts/test-vector-rotate.mjs](scripts/test-vector-rotate.mjs) — hand-computed VALUES on JS + a real instantiated WASM module in Node, bit-identical, plus **geometric invariants asserted on the compiled output** (length preserved, axial component preserved, signed turn == the requested angle) so it isn't a mirror of the lowering; negative-controlled against a sign flip and a 1−cos mutation. A permanent `[synthetic] Vector Op rotate2d + rotateAxis` entry in [scripts/parity-agent-wasm.mjs](scripts/parity-agent-wasm.mjs) guards the agent-graph JS↔WASM parity.
- **Make Color** / **Break Color** (`makeColor`/`breakColor`) over `[r, g, b, a]`.

### All-target lowering ([expandComposites.ts](src/modeler/vpl/compiler/expandComposites.ts)) — the key design
A shared pre-compile graph transform rewrites every composite node into plain **`arithmeticOperator` + `getConstant`** scalar nodes BEFORE any target compiles — exactly the pattern of `expandMacros` / `collapseReroutes` / `injectLinkedOutputMappings`. Because the output is ordinary scalar nodes whose JS/WASM/WebGPU emit is already verified by every math-heavy model (Gray-Scott, MNCA, chemistry), vectors run natively on all targets with NO per-target vector code. The SAME deterministic transform runs in ALL 5 compiler front-ends, so the lowered graph is identical across targets and parity is inherited from the scalar primitives.
- **Lowering, by node:** Make Vector/Color → its output's component sources ARE its scalar inputs (pass-through). Break Vector/Color → each scalar output resolves to one component of the input composite. Vector Op → a small tree of `arithmeticOperator` nodes per component (add/sub/scale/cross/normalize/negate/lerp) or one scalar result (dot/length/distance). `lengthOf` = √(Σ component²); normalize divides each by the shared length (the `/` op's ÷0-guard makes a zero vector normalize to zero).
- **Recursive component resolution** (`vecComponentsOf` / `scalarSourceOf` / `resolveScalarInput` / `resolveVecInput`, memoised + cycle-guarded): a vector value bottoms out at a real scalar source or a literal, through any nesting (Vector Op → Vector Op), Break→Make round-trips, and shared values (one Vector Op result → many consumers synthesises once). Literals connect as an inline `_port_*` when the target port has an inline widget, else a synthetic `getConstant`.
- **Wired into all 5 front-ends** after `collapseReroutes`: JS `compileGraph` + `compileAgentGraph`, `compileGraphWasm`, `compileGraphWebGPU`, and BOTH `flattenAgentGraph`s (WASM + WebGPU) — the agent flatten is shared by the gate + the emitter, so a vector agent graph LOWERS to arithmeticOperator/getConstant (which ARE in the agent allowlists) and the gate now ACCEPTS it (runs on WASM/WebGPU, no JS clamp). Hot-path no-op when the graph has no composite nodes (every non-vector model + the 8 agent samples are byte-identical).

### Port wiring + UX
- `isValidConnection` ([GraphEditor.tsx](src/modeler/vpl/GraphEditor.tsx)): a composite port connects ONLY to the SAME composite type — never to a scalar, and (unlike every other type) **not to an `any` port either**, so the lowering always has a well-defined producer. The ONE exception is a port marked `compositeCapable` (the Value Switch relay ports) — see "Composite RELAY" below. `portsCompatible` mirrors the rule for the suggestion layer, threading the source side's `compositeCapable` through `ConnectionOrigin` exactly as `arrayCapable` already was.
- Distinct pin colours: vector = teal (`.handleVector`), color = pink (`.handleColor`) in [CaNode.module.css](src/modeler/vpl/CaNode.module.css) + `portHandleClass`. Vector Op op-dropdown UI in CaNode.
- **Apply Force "Vector input" mode** (`config.vectorInput`, default off): an additive `force` vector port that, when on, replaces the X/Y/Z component ports (`hiddenPorts`). `expandComposites` lowers it to the existing fx/fy/fz scalar ports (sets `vectorInput` false + wires the resolved components), so vector mode runs on **all** agent targets — `applyForce.compile` + the WASM/WebGPU emitters are component-only (no per-target vector path).
- Catalogue: **113 selectable** node types (116 − 3 hidden macro), **40 agent** nodes. *(Later raised to **115 selectable** / **42 agent** by the Agent Output-Mapping Graphs + Sprites milestone — `agentOutputMapping` + `setAgentSprite`.)*

### Composite RELAY — one Value Switch per component (the `arrayCapable` sibling)

**Value Switch relays SHAPE, not just value** — `result = cond ? ifValue : elseValue` is a scalar when fed scalars, an ARRAY when both branches are array producers, and a **`vector` / `color` when BOTH branches carry the SAME composite**. Shipped as a **pure LOWERING**, so — unlike the array relay, which needed a WASM `OP_SELECT` emit and a WGSL copy loop — it required **zero per-target code**: `expandComposites` rewrites the relay into one **scalar `valueSwitch` per component**, all sharing the one condition node, and every target emits it through the already-verified scalar path. All 31 shipped models stay byte-identical.
- **[compositeRelay.ts](src/modeler/vpl/compiler/compositeRelay.ts) is the ONE resolver** (the `arrayRelay.ts` precedent): `makeCompositeTypeResolver` walks `ifValue`/`elseValue` recursively, memoised + cycle-guarded, and returns a composite type **only when both branches agree** (`a !== null && a === b`). Consumed by BOTH the editor (`isValidConnection`) and the compiler (the lowering + the shape gate), so what the canvas accepts and what the compiler lowers cannot drift. Nested relays fall out of the recursion for free.
- **`PortDef.compositeCapable`** (`ifValue`/`elseValue`/`result` on `valueSwitch`) is `arrayCapable`'s sibling but **LOAD-BEARING**: `arrayCapable` only widens the suggestion menu (the wiring was already legal), whereas a composite→`any` wire is REFUSED by default, so this flag is what permits it at all.
- **MIXED BRANCHES ARE REFUSED, NEVER GUESSED** — "one vector, one number" has no per-component meaning. Two layers: `isValidConnection` refuses the second wire (it resolves the SIBLING branch's type before accepting), and the compile-path-only **`detectCompositeShapeMismatch`** reports a NAMED error for a graph that reached the compiler mismatched (a hand-edited file, or a wire made legal then invalidated by a later config edit) rather than silently emitting zeros. **It runs AFTER `collapseReroutes`** in both `compileGraph` and `compileAgentGraph` — a reroute is not a registry node, so gating before the collapse would refuse a perfectly legal rerouted vector.
- **A REROUTE RELAYS A COMPOSITE TOO**, and that was a pre-existing gap this closed: `getNodeDef('reroute')` is `undefined`, so a rerouted vector could be created from the drop menu but never wired onward. `rerouteCompositeType(node.data)` reads the relayed wire's own `dataType` and is consulted by BOTH the gate and the editor resolver.
- **THE SUGGESTION LAYER WAS THE OTHER HALF OF THE BUG.** `any` used to be universally compatible, so the connection-drop menu from a `vector` output offered ~33 nodes that can never take one (Math, Compare, Aggregate, Set Indicator…) — and `addNodeAndConnect` **bypasses `isValidConnection`**, so picking one CREATED the wire and compiled to an undeclared identifier (`w_mag[idx] = _vn1_vector;`), a silent runtime ReferenceError. The composite carve-out in `portsCompatible` narrows that menu to **Reroute / Value Switch / Vector Op / Break Vector**; a scalar `float` output still offers all 36 (no regression).
- **THE SWEEP (42 registry node types carry `any` value ports) — the decision table.** Everything else REFUSES, and each for a stated reason, not by omission: **the element-of-an-array relays** (`arrayElement`, `forEachInArray.element`, `getRandom` options mode, `groupOperator` random/min/max) refuse because an **array of composites does not exist** — there is no producer for one, so the relay could never fire; **type-driven storage** (Get/Set Attribute, Get/Set Variable, the neighbour and by-id readers/writers) already handles composites through `vectorPortDims` for the documented `VECTOR_LOWERED` set and refuses elsewhere by design (an array-of-neighbours read, `updateAttribute`'s increment/max, … — the modeler badges those); **numeric consumers** (Compare, Math, Aggregate, Group∗, Proportion Map, Interpolation, indicators) refuse because a per-component answer is not what "compare"/"sum" means — use Break Vector, or Vector Op's `length`/`dot`/`distance`, which ARE the composite-aware forms. Pinned by the harness (10 node types asserted NON-composite), so a future `compositeCapable` added carelessly fails a check.
- **`inKey(nodeId, port)`** — `expandComposites`' `inEdge` map keys use a raw **NUL byte** separator (they render as a space, the documented trap). The relay work introduced a named builder used at all 4 sites, so the separator can no longer drift between a writer and a reader (which is exactly the bug that made the first implementation silently never detect a relay).
- **Gate**: [scripts/test-composite-relay.mjs](scripts/test-composite-relay.mjs) — **86 checks**: the resolver; a `Get Random` vector → vector-attribute `Set Attribute` running with correct per-component VALUES on JS, a **real instantiated WASM module** and WGSL; the relay selecting the right branch per component on all three (JS↔WASM bit-identical); colour arity 4 (alpha survives); nested relays; the agent front-end + both agent gates accepting; the shape gate's named errors; the reroute path; the sweep pins; and the byte-identity fast paths. **Negative-controlled by SOURCE MUTATION — 5 mutations, 5 caught**: drop the relay lowering (18 fails), drop the shape gate (5), make ONE agreeing branch enough (4), stop a reroute relaying (2), drop `compositeCapable` (11).

### Verified (cross-target, runtime — NOT JS-only)
All 10 Vector Ops compile clean on JS/WASM/WebGPU (grid) + correct JS values (add=4, dot=11, cross=0, length=2.236, normalize=0.447, distance=2.828, negate=−1, lerp=2, scale=2, subtract=−2); **WASM grid runtime** (length model → all cells 5) + **WebGPU grid runtime** (add+break → all cells 4) via the real worker; wired Make Vector input → 5, Break→Make round-trip → 13; the **agent gate now returns `true`** for a reachable vector graph on BOTH WASM + WebGPU (was JS-clamped), Apply Force vector mode emits the lowered `_agentForceX[idx] += _v__vec0`; colour Make/Break works; Game of Life byte-identical on all 3 targets (lowering is a no-op for non-vector graphs); all 8 agent samples (+ synthetic 3D-field) still JS↔WASM bit-parity; tsc + build clean.

### Stored `vector` attribute + variable type (branch `absorb_old_automatosgt`) — the STORAGE composite
The Make/Break-Vector nodes above pass a vector on a WIRE; this adds a vector as a **stored** cell-attribute / agent-attribute / Local-Variable type, so a model can persist a per-cell / per-agent direction (a flow field, a facing/orientation, an accumulated force) as ONE named thing instead of hand-maintaining `fooX`/`fooY`[/`fooZ`] scalars. The canonical motivation was **agent orientation as a vector** (not just a compass angle) and dropping the per-component force-accumulator boilerplate.
- **Schema ([types.ts](src/model/types.ts), additive):** `AttributeType += 'vector'` + `Attribute.vectorDims?: 2|3`; `VariableDataType += 'vector'` + `Variable.vectorDims?: 2|3`. Old files load unchanged (no migration). Offered for **cell + agent** attributes and **scalar** Local Variables — NOT model attributes (they take the color-split path) and NOT array variables. The 3D option (`Vector (3D)`) is offered only when `vectorDimsForModel(model) === 3`.
- **WHERE THE VECTOR *VARIABLE* LIVES IN THE UI, and the docs drift that hid it (user-reported 2026-09-02: *"cant we define variables of type vector?"*).** It is the **Data Type** dropdown of the Local Variables detail editor ([VariablesPanelSection.tsx](src/modeler/panels/VariablesPanelSection.tsx)) — Attributes panel → Local Variables (or **Agent Variables** on the Agents sub-tab) → select a variable → *Vector (2D)* / *Vector (3D)*, whereupon the Initial Value row becomes one `InlineNumberInput` per component writing the comma-joined `"x,y[,z]"`. **Verified working in the real UI on the cell graph, the agent graph, and in 3D** — the feature was never broken. **The blocker was DOCUMENTATION**: HelpView's dedicated *Local Variables* section — the one place a user looks — enumerated the allowed types as "binary / integer / decimal / tag" and **omitted vector**, and `docs/NODES_REFERENCE.md`'s Get/Set Variable rows described only a scalar/array value port. So the app said yes and the docs said no. Both are fixed; **when a type/kind is added to ANY element, sweep the ENUMERATING prose too** (a bullet that lists the allowed values is a source of truth that silently goes stale, unlike a bullet that describes one). The list-row **badge** now also carries the dimensionality — `typeBadgeLabel(type, vectorDims)` in [typeLabels.ts](src/model/typeLabels.ts), shared by the Attributes AND Variables lists so they cannot drift — because a bare `VECTOR` cannot be told apart from a 3D one at a glance.
- **Runtime-VALUE coverage (not just emit shape).** [scripts/test-vector-attr-compile.mjs](scripts/test-vector-attr-compile.mjs) gained a **vector LOCAL VARIABLE runtime tier**: three graphs (read the initial value without writing · Set→Get round trip · the `acc + delta` accumulator) run through the compiled JS step AND a **real instantiated WASM module**, asserting the NUMBERS (asymmetric per component, so an x/y swap or a collapsed pair cannot pass) plus the WGSL emit shape and `expandVectorVariables`' per-component `initialValue` split. The agent half is a permanent **`[synthetic] Vector AGENT VARIABLE`** entry in [parity-agent-wasm.mjs](scripts/parity-agent-wasm.mjs) whose **VALUE invariant recomputes `(5 + x, 7 + 2y)` from the store's own positions** — negative-controlled by dropping the `initialValue` on BOTH targets, which parity passes and only the invariant catches (`vx 4 !== 5 + x 9`).
- **The design = LOWER TO SCALAR-FLOAT COMPONENTS (the storage analogue of `expandComposites`).** A `vector` attr/var is rewritten to `dims` scalar `float` components (`<id>_vx`/`_vy`[/`_vz`]) BEFORE any target compiles, so **every downstream layer (all 5 compilers, the worker SoA, save/load, indicators) sees ONLY scalar floats — zero new per-target emit, zero new value-runtime type.** The ONE compiler-facing transform is **`lowerVectorAttrs(nodes, edges, model)`** in [vectorAttr.ts](src/modeler/vpl/compiler/vectorAttr.ts): it (a) rewrites every VALUE read that references a vector — the own `getCellAttribute`/`getVariable`, the **neighbour reads** `getNeighborAttributeByIndex`/`getNeighborAttributeByTag`, and the by-id agent read `getAgentAttribute` — into a **Make Vector** over per-component reads (with the shared value input — the NI `index` / the `agentId` — **fanned out** to every component reader, reusing the ONE source node), (b) rewrites every FLOW write — the own `setAttribute`/`setVariable`, the **neighbour writes** `setNeighborAttributeByIndex`/`setNeighborhoodAttribute`, (a `setAttribute` with a WIRED agent id fans that id out to every component setter too) — into a **Break Vector** + a **linear flow-splice** (`do → set_vx → set_vy [→ set_vz] → next`, shared value input fanned out), (c) does a **config-slot expansion** of `moveSelfToNeighbor` (each vector payload slot → its scalar-component slots, `payloadCount` grows, `_attr_${i}_default` re-baked), and (d) reassigns `model` to the component-expanded attrs/variables. It runs AFTER `expandMacros`/`collapseReroutes` (so it sees a flat graph) and BEFORE `expandComposites` (so the Make/Break it synthesizes get lowered to scalar arithmetic like any other vector wire). It BAKES `_resolvedTagIndex` on synthesized `getNeighborAttributeByTag` readers + `_attr_${i}_default` on the move clone, so WASM/WebGPU (which have no JS pre-pass and never see the JS-mutated config for these freshly-created nodes) read the right tag/default. **Hot-path no-op** when the model has no vector attrs/vars (returns the same arrays — every existing model byte-identical). The set of lowered node types is exported as **`VECTOR_LOWERED`** (consumed by the validation guard).
- **The unified TYPE-DRIVEN ports (no dedicated Get/Set Vector nodes).** Every node whose `value` port carries a stored attr/var — the own `getCellAttribute`/`setAttribute`, the neighbour reads `getNeighborAttributeByIndex`/`getNeighborAttributeByTag`, the by-id agent read `getAgentAttribute`, the neighbour writes `setNeighborAttributeByIndex`/`setNeighborhoodAttribute`, and `getVariable`/`setVariable` — becomes vector-aware: when the picked attribute/variable is a vector, that `value` port's `dataType` flips to `vector` (and Set drops its inline number widget). The shared resolver **`vectorPortDims(nodeType, config, model): 2|3|null`** ([vectorAttr.ts](src/modeler/vpl/compiler/vectorAttr.ts) — keyed off `VECTOR_ATTR_PORT_NODES`; returns null for every other node type, so effectivePorts/CaNode call it GENERICALLY) is consulted by BOTH [effectivePorts.ts](src/modeler/vpl/effectivePorts.ts) (the port-shape source the drag/drop + drop-menu read) AND `isValidConnection` ([GraphEditor.tsx](src/modeler/vpl/GraphEditor.tsx), which resolves src/tgt vector-ness from each node's live config + enforces the composite `vector`↔`vector` exact-match). So dragging a vector attr/var onto the canvas gives the ordinary Get/Set node with a vector port, and it connects only to Make/Break/VectorOp/another vector attr. (The earlier dedicated `getVectorAttribute`/`setVectorAttribute`/`getVectorVariable`/`setVectorVariable` nodes were REMOVED from the registry + deleted.)
- **The ABI-mirror discipline (the silent-corruption class).** Every memory-LAYOUT + worker-message site that iterates attributes must see the SAME component expansion the compiler used, or its offsets desync (the `+64-cell` corruption). `expandVectorAttributes(attrs)` / `expandVectorVariables(vars)` (deterministic) is called at: [wasm/layout.ts](src/modeler/vpl/compiler/wasm/layout.ts) `computeLayoutFromModel`, [webgpu/layout.ts](src/modeler/vpl/compiler/webgpu/layout.ts) `computeWebGPULayout`, both agent layouts (`compileAgentGraphWasmForModel` / `compileAgentGraphWebGPUForModel` via `expandVectorAttributes(agentAttrsOf(model))`), and [SimulatorView.tsx](src/simulator/SimulatorView.tsx)'s worker `init` + `updateIndicators` messages (`attributes`/`agentAttributes` expanded before `toAttrDefMsg`). Variables ride the compiled step fn (`lowerVectorAttrs` reassigns `model.variables`/`agentVariables` before `buildVariableJS`), so no worker message carries them.
- **Facing/orientation via composition (no dedicated `facing` config):** an agent's heading is just a vector agent-attribute wired through Get Self Attribute → Break Vector → the `Get Agents In View` / `Sense Hemifield` **wired heading** input. So the FOV Sensing nodes get a real facing source with zero new machinery.
- **Save/load:** the `.gcaproj` stores the raw `vector` attr (schema round-trips); the worker + any embedded `.gcastate` only ever see the expanded float components (`ATTR_TYPE_MAP` never receives a `vector` — `serializeSimState` iterates the WORKER state, whose buffers are already component-keyed, so they serialize as `float64`). `attrsStructurallyEqual` ([SimulatorView.tsx](src/simulator/SimulatorView.tsx)) compares `vectorDims` (defense-in-depth: a 2D↔3D dims change re-lays-out the SoA → full worker reinit, even if `defaultValue` somehow didn't change alongside).
- **Simulator peripherals (all vector-aware):** the cell inspector ([InspectCellPopover.tsx](src/simulator/InspectCellPopover.tsx)) + the agent-state inspect popover recombine a vector's components into a `(x, y[, z])` readout (`decodeVectorFromValues`); the Manual Brush / seed-config / agent-Edit panels ([ManualBrushPanel.tsx](src/simulator/ManualBrushPanel.tsx)) render a labelled X/Y[/Z] widget, and every brush set-builder in SimulatorView splits a vector into per-component `{attrId, value}` sets via **`encodeAttrSets`** (the vector id itself never exists in the worker; its paint guard would silently skip it). The CaNode value-port handle renders teal (`portHandleClass` `vector`) via a `vectorPortDims` retype mirroring effectivePorts; a vector `setVariable` drops its inline number widget.
- **Coverage (v2) — SINGLE-vector reads/writes lowered; array-of-vectors + comparison still badged.** `lowerVectorAttrs` lowers everything in `VECTOR_LOWERED`: the OWN-cell/OWN-agent/OWN-variable Get/Set, the **neighbour reads** (`getNeighborAttributeByIndex`/`getNeighborAttributeByTag`), the **by-id agent read** (`getAgentAttribute`) and the by-id `setAttribute`, the **neighbour writes** (`setNeighborAttributeByIndex`/`setNeighborhoodAttribute`), and **`moveSelfToNeighbor`** — so a cell/agent can read a neighbour's / another agent's vector, write one, and transfer one, all correctly. **Verified end-to-end on JS + WASM + WebGPU through the REAL worker** (a neighbour `getNeighborAttributeByIndex(flow).x` read returns the actual east-neighbour value, torus-wrapped, 0 mismatches on all three targets; the own vector Set seeds `flow` via `initEvent → Make Vector → setAttribute`). Still NOT lowered (no vector representation — a vector array/comparison isn't a value shape the compilers have): **array-of-vectors reads** (`getNeighborsAttribute`/`getNeighborsAttrByIndexes`/`getAgentsAttribute`), `filterNeighbors` (scalar comparison), `updateAttribute` (inc/dec/max/min undefined on a vector), and the **field-bridge** nodes. Those emit `r_<id>[…]`/`w_<id>[…]` against the component-expanded buffer that has no `<id>` array (crashes at run time), so `detectMissingConfig` ([nodeValidation.ts](src/modeler/vpl/nodes/nodeValidation.ts)) badges any node NOT in `VECTOR_LOWERED` that references a vector attr via `config.attributeId`. Workaround: read the vector via Get Attribute / Get Neighbor Attr / Get Agent Attribute + Break Vector (or Get + Vector Op + Set for `updateAttribute`).
- **Adversarial-review hardening (all confirmed + fixed):** (1) the guard above was extended to `moveSelfToNeighbor`'s `attr_${i}` slots (it only checked `attributeId`). (2) A vector is a **scalar-only** type: the Local-Variables **Kind** dropdown resets a vector variable's type to Decimal when switched to Array (an `{kind:'array', dataType:'vector'}` would expand away yet still list in Set Array Element → `_var_<id> is not defined`); `expandVectorVariables` / `vectorPortDims` / `lowerVectorAttrs` also skip an array-kind vector (`isScalarVectorVar`) as defense-in-depth for hand-edited files. (3) The **Sub-attribute** editor is hidden for a vector cell attr (the components don't carry `parentAttributeId`/`parentValues`/`undefinedValue`, so it was a silent no-op). (4) The Type dropdown keeps showing **Vector (3D)** when the attr/var is *already* `vectorDims===3` (a 3D→2D model switch otherwise misreported it as "Binary").

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


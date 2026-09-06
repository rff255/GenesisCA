# Lattice cell features — variegation, sub-attributes, chemistry, linked OMs

> Area doc for **GenesisCA**. The schema-level features that belong to the CA grid specifically: Variegated Cells (orientation, face labels, lookup tables), sub-attributes, the Kier-style chemistry primitives, and Linked Output Mappings (the auto colour pass). Read before touching `variegation.ts`, `subAttribute.ts` or `linkedOutputMappings.ts`.
>
> **Also read** — a change here usually reaches [`compiler-core.md`](compiler-core.md) · [`value-types.md`](value-types.md) · [`indicators.md`](indicators.md) · [`simulation-engine.md`](simulation-engine.md).
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

- Variegated Cells (Directional Interactions) — opt-in feature, all three compile targets
  - Single source of truth
  - Orientation
  - Schema (all additive, no version bump)
  - Node set (orientation/facing/face-label nodes gated by `requirements.variegated`; the two table nodes are NOT — they work with tag×tag tables sans faces)
  - Init Event entry-point (`initEvent`)
  - Compile-target coverage
  - Cascade rules (ModelContext)
  - Panel UX
  - Gotchas
  - Amphiphile sample model + interaction-table presets
  - Chromatography sample model (Kier, Cheng & Karnes 2000)
- Chemistry Primitives (B.0 + B.1 + B.3 + GroupOperator.weightedRandom)
  - B.0 — `cardinalsOnly` flag on `GetAllFacingLabels`
  - B.1 — `InteractionTableMap` node
  - D.2 — `GroupOperator.weightedRandom` op (replaces standalone `SampleArrayByWeight`)
  - B.3 — `MoveSelfToNeighbor` node (label "Transfer Cell Attributes to Neighbor")
  - Pre-resolve config injections (compile.ts)
  - Behavioural notes
- Sub-Attributes (schema-level feature)
  - Schema
  - Read semantics — context-dependent
  - Write semantics
  - Per-cell conditional copy (sync mode)
  - Async-mode pre-scrub (worker)
  - CompileContext (JS-target)
  - Compile-target coverage
  - Indicator aggregation
  - Cascade behaviour
  - Gotchas
- Linked Output Mappings (schema-level feature, all three compile targets)
  - Architecture — synthesis, NOT per-target emit
  - Freshness guarantee (no stale definitions)
  - Schema ([types.ts](src/model/types.ts), all optional → old files load unchanged)
  - `categoricalColor` node ([CategoricalColorNode.ts](src/modeler/vpl/nodes/CategoricalColorNode.ts)) — the only NEW emitter
  - Color Scale presets + shared editor
  - Cascade ([ModelContext.tsx](src/model/ModelContext.tsx))
  - Gotchas

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

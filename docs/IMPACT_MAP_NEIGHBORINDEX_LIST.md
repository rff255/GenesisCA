# Impact Map — Wave A (NeighborIndex) + Wave B (List Attributes)

> **Wave A.6 update (2026-05-08):** the runtime representation in this document
> (packed `(dr, dc)` i32) is now the actual implementation. Wave A initially
> shipped with slot-index runtime values, and Wave A.6 brought it back into line
> with this document's original proposal — the NI runtime is now position-only
> with a `0x80000000` "no neighbor" sentinel, 16-bit signed dr (high) and dc
> (low) per axis. The neighborhood-coupling on `filterNeighbors` /
> `flipNeighborIndex` / `neighborIndexFromOffset` / access nodes was removed in
> A.6. See `docs/NODES_REFERENCE.md` §7 for the current node API.

## Context

This document maps the cross-cutting subsystem impact of two architectural waves agreed in conversation with the user (2026-05-07):

- **Wave A** — NeighborIndex as a first-class basic type, plus the Section A index-kind fixes and the option-3/4 primitives (pick-random-coord, array-iteration flow) from the prior async-mode issue map.
- **Wave B** — Bounded fixed-size list attribute type ("up to N elements per cell, capacity declared at edit time").

The point of this doc is to surface cross-subsystem collisions **on paper** before any code touches them. It is NOT an implementation plan — it is the precondition to writing one.

Structure: one section per subsystem, each with two columns — Wave A impact and Wave B impact. After the per-subsystem walk, three closing sections: cross-wave collisions, open design decisions, and a recommended PR sequence.

Note: Wave A scope was subsequently expanded to include NeighborIndex as a storable cell + model attribute kind, with a clickable-grid editor and a `flipNeighborIndex` value node. See the Wave A implementation plan for the refined scope. Brush integration and auto color-mapping for NI cell attrs are deferred to a Wave A.5 follow-up.

---

## Naming & Conventions

- **NI** = NeighborIndex. Proposed runtime representation: packed `i32` carrying `(dRow << 8) | (dCol & 0xFF)` with 8-bit signed offsets — covers any realistic neighborhood (MNCA-style ±10 fits comfortably), zero allocation in hot loops, identical bytes on JS/WASM/WebGPU.
- **List attribute** = an attribute whose value per cell is an array of bounded length. Storage layout: `Uint16Array` of `total` entries holding each cell's current length, plus a typed-array slab of `total × capacity` entries holding element values. `elementType ∈ {bool, int, float, tag, neighborIndex}`.
- **Subsystems covered:** type system, JS compiler, WASM compiler, WebGPU compiler, `.gcaproj` schema, `.gcastate` schema, web worker (sim.worker.ts), brush/paint UI, visualization, color mappings, node catalogue, indicators, model-attributes UI, macro system.

---

## Wave A — Summary

**Scope:** add `'neighborIndex'` to the port-type vocabulary; rewrite the existing neighbor-touching nodes to use it on the affected ports; add a `pickRandomNeighbor` value node and a `forEachInArray` flow node; add structural validation that catches Section A1/A2/A3 hazards as port-type mismatches instead of silent runtime bugs. Subsequently expanded to include NI as a storable cell + model attribute kind with a clickable-grid editor and a `flipNeighborIndex` value node.

**What does NOT change (post-refinement):** brush/paint UI, color mappings, indicators (the brush + viz integration for NI cell attrs is deferred to Wave A.5).

**Estimated PR count:** 4 small PRs (type system + migration | new nodes + retypes | NI as attribute kind + editor | docs sweep).

## Wave B — Summary

**Scope:** add `kind: 'list'` to the `Attribute` type with `elementType` + `capacity` config; new typed-array layout in worker; new node set for list operations (length, get/set element, append, pop, clear); new attribute editor UI; aggregation pipeline plug-in (existing `groupCounting`/`groupOperator` already accept arrays — they just see the active slice); design decisions for brush behavior and color-mapping input.

**What does change:** schema (.gcaproj + .gcastate both need bumps), every compile target's runtime layout, worker init/getState/loadState branches, brush UX, color-mapping pipeline (the "what is the scalar input from a list?" question), model-attributes panel UI.

**Estimated PR count:** 5–8 PRs across two months.

---

## 1. Type system / port validation

### Wave A
- Add `'neighborIndex'` to the `dataType` union in `src/modeler/vpl/types.ts` (currently `bool | integer | float | tag | color-r | color-g | color-b | any`).
- Visual treatment: distinct port handle color or icon (not blue-data, not green-flow — proposal: amber).
- `isValidConnection` (in GraphEditor): NI ports connect only to NI ports; widen `any` to accept NI silently for back-compat.
- `nodeValidation.ts`: add structural detection for "int output of `groupOperator.index` etc. is wired into a coord-idx port (now a NI port)" — fires a warning badge during the migration window.

### Wave B
- No new port-type entry — list attributes are read/written via existing `isArray: true` ports (`bool[]`, `int[]`, `float[]`, `tag[]`, `neighborIndex[]`).
- Attribute-definition type (in `src/model/types.ts`) gets a new variant: `{ kind: 'list', elementType, capacity, defaultLength?, defaultElement? }`.
- Validation: list-attribute config requires elementType and capacity; defaultLength ≤ capacity.

---

## 2. JS compiler (`src/modeler/vpl/compiler/compile.ts`)

### Wave A
- NI runtime representation: packed i32 (`(dr + 128) << 8 | (dc + 128) & 0xFF` — biased so unpacking is `(packed >> 8) - 128`, `(packed & 0xFF) - 128`, no sign-extension surprises).
- New emitters:
  - `pickRandomNeighbor(NI[]) → NI` — `arr[Math.floor(Math.random() * arr.length)]`.
  - `forEachInArray(arr, body)` — emits a `for (let _i=0; _i<arr.length; _i++) { const _ni = arr[_i]; <body with _ni bound> }`. Generic over typed arrays.
  - `getAttrAtNeighborIndex(NI, attrId)` — unpacks dr/dc and computes `r_<attr>[(row + dr + H) % H * W + (col + dc + W) % W]` (or constant-boundary variant — uses existing nbrCellIdx logic).
  - `setAttrAtNeighborIndex(NI, attrId, value)` — same with write side, with the `if (_ni < total)` guard for constant boundaries.
  - `flipNeighborIndex(NI, mode)` — bitmask flip on the packed representation: horizontal flips dc, vertical flips dr, both flips both.
- Existing nodes retyped:
  - `getNeighborAttributeByIndex` — `Index: integer` → `Index: NI`.
  - `setNeighborAttributeByIndex` — same.
  - `filterNeighbors.result` — `int[]` → `NI[]`.
  - `getNeighborIndexesByTags.indexes` — `int[]` → `NI[]`.
  - `joinNeighbors.A/B/result` — `int[]` → `NI[]`.
  - `getNeighborsAttrByIndexes.indexes` — `int[]` → `NI[]`.
- `groupCounting.indexes`, `groupStatement.indexes`, `groupOperator.index` — these stay `integer`/`integer[]` (they're list-positions, not coord-idxes). Rename labels: "Index" → "Position", "Indexes" → "Positions". Add tooltip explaining this is a list-position, not a neighbor handle.
- All these retypes are non-breaking at runtime because the packed int is a number — the byte-level emission is identical. Only the *type system* changes.

### Wave B
- New per-list-attribute layout in compiled function params:
  - `r_<attrId>_len: Uint16Array` (length-per-cell)
  - `r_<attrId>_data: Uint8Array | Int32Array | Float64Array` (elementType-dependent slab, length = total × capacity)
  - Same with `w_` prefix for double-buffered sync mode.
- New emitters:
  - `getListLength(attrId)` → reads `r_<attrId>_len[idx]`.
  - `getListElement(attrId, listIdx)` → reads `r_<attrId>_data[idx * <capacity> + listIdx]` with bounds check.
  - `setListElement(attrId, listIdx, value)` → writes `w_<attrId>_data[...]` with bounds check + length update if listIdx == len.
  - `appendToList(attrId, value)` → reads `w_<attrId>_len[idx]`, writes if < capacity, increments length.
  - `popFromList(attrId)` → reads `w_<attrId>_data[idx * cap + len - 1]`, decrements length.
  - `clearList(attrId)` → `w_<attrId>_len[idx] = 0`.
  - `getListSlice(attrId)` → returns `r_<attrId>_data.subarray(idx * cap, idx * cap + r_<attrId>_len[idx])` — feeds existing aggregation nodes directly.
- Async neighbor writes to lists: `appendToNeighborList(NI, attrId, value)` — async-only (already a constraint via ASYNC_ONLY_TYPES).

---

## 3. WASM compiler (`src/modeler/vpl/compiler/wasm/`)

### Wave A
- NI = i32 (packed). Identical to JS bytes.
- All new emitters mirror JS — straight i32 arithmetic plus the existing `nbrCellIdx`-equivalent helpers in `encoder.ts`.
- `_resolvedTagIndexes` precompute pattern carries over: precompute `_resolvedNeighborIndexes` for static NI constants (e.g., from a `neighborIndexFromTag` constructor).

### Wave B
- New `layout.ts` regions per list attribute: `<attrId>_lenOffset`, `<attrId>_dataOffset`, `<attrId>_capacity`.
- Linear-memory layout: `Uint16Array` (lengths) followed by `Uint8Array|Int32Array|Float64Array` (data slab).
- `i32.load_u16` / `i32.store_u16` for length access; `i32.load` / `f64.load` for data access depending on element type.
- New WASM emitters mirror the JS emitters (length read/write, bounds check, append, etc.).
- **Critical lockstep concern (per `feedback_compiler_lockstep.md` memory):** every Wave B JS emitter must land with a matching WASM emitter in the same PR.

---

## 4. WebGPU compiler (`src/modeler/vpl/compiler/webgpu/`)

### Wave A
- NI = i32 in WGSL. Storage and per-cell scratch arrays already use i32 — no layout change.
- `nbrCellIdx(cellIdx, dr, dc)` already exists per CLAUDE.md / docs/HUGE_GRID_OPTIMIZATIONS.md §2.1; NI unpack helpers are trivial (`(packed >> 8) - 128`, `(packed & 0xFF) - 128`).
- `pickRandomNeighbor`: trivial — `let randIdx = pcgRandU32() % arrayLength(arr); return arr[randIdx];`.
- `forEachInArray`: WGSL `for (var _i = 0u; _i < arrayLength(&arr); _i = _i + 1u)`. Body re-emitted inside the loop. Watch for code blow-up if `body` is large; usual practice is just to emit it once.

### Wave B
- New WGSL bindings per list attribute: `var<storage, read_write> <attrId>_len: array<u32>;`, `var<storage, read_write> <attrId>_data: array<i32|f32|u32>;`.
- Length read: `<attrId>_len[cellIdx]`. Element read: `<attrId>_data[cellIdx * <capacity>u + listIdx]`.
- **Async-mode interaction:** WebGPU rejects async at compile time (per CLAUDE.md "Compile-time rejections"). So list-attribute writes to **neighbors** never reach WebGPU — only self-list operations do. Self-list writes from a single cell to its own length+data slot have no contention because each cell has its own slot. **No atomic ops needed for v1.** Big simplification.
- Append from self: `let curLen = <attrId>_len[cellIdx]; if (curLen < <capacity>u) { <attrId>_data[cellIdx * <capacity>u + curLen] = value; <attrId>_len[cellIdx] = curLen + 1u; }`.
- Storage buffer size check: list attributes with high capacity at huge grids can exceed `maxStorageBufferBindingSize`. The existing defensive check in `setupBuffersAndPipelines` (per CLAUDE.md "WebGPU key gotchas") catches this — extend the message to identify which list attribute exceeded the cap.
- Direct OffscreenCanvas render path: lists don't touch the color buffer, so the `presentColors` shader is unaffected.

---

## 5. `.gcaproj` schema (`src/model/schema.ts`, `src/model/fileOperations.ts`)

### Wave A
- Schema bump: `2 → 3` (port retypes) → `3 → 4` (NI attribute kind, in PR A.3).
- Migration on load (PR A.1): walk every node, every macro internal node, every port; relabel `dataType: 'integer'` → `dataType: 'neighborIndex'` on the specific ports listed in §2 (filterNeighbors.result, getNeighborIndexesByTags.indexes, joinNeighbors.A/B/result, getNeighborAttributeByIndex.index, setNeighborAttributeByIndex.index, getNeighborsAttrByIndexes.indexes). All other int ports stay as int.
- The `groupCounting.indexes`/`groupStatement.indexes`/`groupOperator.index` outputs stay int (intentionally — they're list-positions). Their labels migrate to "Position(s)".
- New `Attribute` variant (PR A.3): `{ kind: 'neighborIndex', defaultValue: number /* packed NI */, neighborhoodHintId?: string /* viewport-only */ }`.

### Wave B
- Schema bump: `4 → 5` (or whatever Wave A landed on).
- New `Attribute` variant: `{ kind: 'list', elementType: 'bool'|'int'|'float'|'tag'|'neighborIndex', capacity: number, defaultLength?: number, defaultElement?: any }`.
- Migration on load: legacy attributes have no `kind` field → default to scalar (existing behavior).
- `stringifyCompact` (the custom `.gcaproj` serializer) already filters undefined; just confirms list config serializes cleanly.

---

## 6. `.gcastate` schema (`src/model/fileOperations.ts` `serializeSimState` / `readStateFile`)

### Wave A
- NI cell attributes serialize via the existing `Int32Array` base64 path — same code path as int/tag attrs. No format change beyond an attr-kind tag.

### Wave B
- Schema bump: state files versioned independently of model files.
- New per-list-attribute serialization: `{ lengths: base64(Uint16Array), data: base64(<typed slab>) }`.
- `arrayBufferToBase64`/`base64ToArrayBuffer` already handle arbitrary typed arrays — extend `deserializeTypedArray` switch to include the list-attribute branch.
- Validation in `applySimulationState`: confirm capacity matches the model's current attribute config; reject if mismatch (same dimension-mismatch pattern already used).

---

## 7. Web Worker (`src/simulator/engine/sim.worker.ts`)

### Wave A
- NI cell attrs allocate `Int32Array` (same path as int/tag); init seeds from `defaultValue`. `getState` / `loadState` already handle `Int32Array` — just register the new kind.

### Wave B
- `init` handler: allocate `<attrId>_len` and `<attrId>_data` for each list attribute; seed from `defaultLength`/`defaultElement`.
- `getState`: copy + transfer both arrays per list attribute.
- `loadState`: restore both arrays after dimension validation.
- `paint`/`importImage`/`randomize`/`reset`/`writeRegion`/`clearRegion`: list attributes need policy decisions per handler — see §9 (brush) and §13 (open design decisions).
- `recompile` message: list-attribute layout changes require full reinit (not soft recompile). Adding a new list attr or changing capacity = structural change.

---

## 8. Brush / Paint UI (`src/simulator/SimulatorView.tsx`)

### Wave A
- No change in PR A.1–A.4. Brush integration for NI cell attrs is deferred to Wave A.5 (reuses the clickable-grid editor as a brush widget).

### Wave B
- **Open design problem.** Brush sets one value per cell; lists need a policy. Three options:
  - **(a) Replace-on-paint** (default proposal): paint sets list to `[brushValue]` (single-element list). Simple, predictable, matches scalar UX.
  - **(b) Append-on-paint** (per-attribute opt-in): each click appends `brushValue` to the list, up to capacity.
  - **(c) Disabled**: list attributes can't be brushed; only graph-driven changes mutate them.
- Recommendation: ship (a) as default, expose (b) as an attribute-level config (`brushMode: 'replace' | 'append' | 'disabled'`). Default to (c) for `elementType: neighborIndex` since "paint a neighbor handle" doesn't have a coherent UX.
- The brush color picker already shows the brush value via the active Color→Attribute mapping. List attributes need their mapping to specify "this color maps to *what list state*?" — see §10.

---

## 9. Visualization (`src/simulator/SimulatorView.tsx` color buffer + viewer tabs)

### Wave A
- No change in PR A.1–A.4. Default NI→color mapping deferred to Wave A.5 (proposed: hue from `atan2(dc, dr)`, saturation from magnitude).

### Wave B
- The output color buffer is per-cell RGBA. To visualize a list-typed attribute, the Attribute→Color mapping must reduce the list to something viewable.
- **Open design problem.** Three options for the mapping input from a list:
  - **(a) Aggregate-then-map**: mapping definition declares an aggregation (length, sum, mean, max, min, first, last, distinctCount). The graph sees a single scalar and maps it to RGB as today. Lowest-friction, maps naturally onto existing pipeline.
  - **(b) Pick-element**: mapping declares a fixed list-idx (e.g., `[0]`, `[length-1]`); other elements are ignored.
  - **(c) Per-element-then-blend**: each element produces a color, blended (sum/avg). Heavy and ill-defined for non-color elementTypes.
- Recommendation: ship (a) as the only option in v1 (with a default of "length"). Add (b) as a follow-up if user demand justifies.

---

## 10. Color Mappings (Attribute→Color and Color→Attribute)

### Wave A
- No change.

### Wave B
- **Attribute→Color (output mapping):** the "input" port for a list attribute on a mapping is the aggregated scalar (per §9 option a). The mapping's graph sees `getModelAttribute` / `getCellAttribute` returning a scalar, exactly as today.
- **Color→Attribute (input mapping):** brush click → mapping graph → `setAttribute` writes one value. For list attributes, the existing `setAttribute` becomes ambiguous (set what? clear and add? append?). Resolution depends on §8 brush policy:
  - Replace mode: `setAttribute` for a list attr clears and writes single-element list of given value.
  - Append mode: `setAttribute` becomes implicit `appendToList`.
- Mapping pipeline already accommodates a scalar input port; list-attribute mappings just declare the aggregation up front. No structural change to the mapping editor UI other than a new "Aggregation" dropdown when the selected attribute is list-typed.

---

## 11. Node catalogue (`src/modeler/vpl/nodes/`)

### Wave A
- **New nodes:**
  - `pickRandomNeighbor` — value, `I: NI[]`, `O: NI`. Replaces broken `groupOperator(random)` for B1 pattern.
  - `forEachInArray` — flow, `I: DO`, `I: Array` (any typed array), `O: BODY` flow + `O: Element` value port exposed inside the loop body. Generic from day 1.
  - `neighborIndexFromOffset` — value, config (dr, dc), `O: NI`. Static constructor for hand-coded handles.
  - `neighborIndexFromTag` — value, config (neighborhoodId, tagName), `O: NI`. Compile-time resolved.
  - `flipNeighborIndex` — value, config `mode ∈ {horizontal, vertical, both}`, `I: NI`, `O: NI`. Bitmask flip on the packed representation.
- **Retyped existing nodes** (no node-list change, just port type updates):
  - `getNeighborAttributeByIndex` (input port retyped to NI; deprecate the silent array→element-0 coercion path with a hard validation error in nodeValidation.ts).
  - `setNeighborAttributeByIndex` (input port retyped to NI; the array variant takes `NI[]` cleanly).
  - `filterNeighbors`, `getNeighborIndexesByTags`, `joinNeighbors`, `getNeighborsAttrByIndexes` (output ports retyped).
- **Renamed labels (no behavior change):** `groupCounting.indexes` → "Positions", `groupStatement.indexes` → "Positions", `groupOperator.index` → "Position". Tooltip on each: "list-position into the input array, NOT a neighbor handle."
- **`HelpView.tsx` + `docs/NODES_REFERENCE.md`:** update with the new type, new nodes, retyped ports. Per `feedback_docs_consistency.md`: code + Help tab + README + reference doc all in the same PR.

### Wave B
- **New nodes (cell-self list ops):**
  - `getListLength` — value, config attrId, `O: Length` (int).
  - `getListElement` — value, config attrId, `I: ListIdx` (int), `O: Value` (elementType).
  - `getListSlice` — value, config attrId, `O: Values` (elementType[]). Returns the active prefix; feeds aggregation nodes directly.
  - `setListElement` — flow, config attrId, `I: ListIdx`, `I: Value`. Bounds-checked; expanding length on idx == length is allowed up to capacity.
  - `appendToList` — flow, config attrId, `I: Value`. No-op if list is at capacity.
  - `popFromList` — flow, config attrId, `O: Value` (optional out port).
  - `clearList` — flow, config attrId.
- **New nodes (neighbor list ops, async-only):**
  - `getNeighborListAttribute` — value, config (neighborhoodId or NI input?), `O: Values` array. Need to choose tag-based vs NI-based addressing. Probably NI-based for consistency with Wave A.
  - `appendToNeighborList` — flow, `I: NI`, `I: Value`. Async-only.
- Existing aggregation nodes (`groupCounting`, `groupOperator`, `groupStatement`, `aggregate`, `filterNeighbors`) work with list-attr arrays directly — their array input is just whatever scalar elementType the list holds.

---

## 12. Indicators (`src/model/types.ts` indicator definitions, worker-side aggregation)

### Wave A
- No change. Indicators read from cell-attribute typed arrays, never from NI handles.

### Wave B
- New "linked list indicator": aggregates over a list-typed attribute. Aggregation options: length, sum, distinctValueCount, total (sum-of-all-cells-list-lengths), frequency-by-element-value.
- `computeLinkedIndicators` in worker: branch on attribute kind. List branch walks lengths array + active prefixes per cell.
- WebGPU-side reduction: per CLAUDE.md, GPU-side reductions cover eligible linked-indicator aggregations. List length aggregation is GPU-eligible (one workgroup-sum over the lengths array). Element-value frequency over a flattened list is GPU-eligible but requires careful indexing.
- Saved-state files (`.gcastate`): per CLAUDE.md, indicators reset on load — so list indicators don't need to be persisted.

---

## 13. Model-attributes UI (`src/modeler/panels/AttributesPanelContent.tsx`)

### Wave A
- New `'neighborIndex'` option in the cell-attribute kind dropdown (PR A.3).
- New `NeighborIndexPicker` component — fixed-size grid (e.g., 9×9) with central cell highlighted; user clicks any cell. Optional neighborhood dropdown overlays the chosen neighborhood's cells as visual highlights. Output is a packed NI value.
- Same component reused in `PropertiesPanelContent.tsx` for model-attribute editing when kind = NI.

### Wave B
- New "List" attribute kind selector at the top of the attribute editor.
- When kind == list, show:
  - `elementType` dropdown (bool/int/float/tag/neighborIndex).
  - `capacity` number input (1..256 proposed range, with warning above 32 about memory at huge grids).
  - `defaultLength` number input (0..capacity).
  - `defaultElement` widget (type-dependent on elementType).
  - `brushMode` dropdown (replace/append/disabled — default replace, force disabled for elementType==neighborIndex).
- Storage estimate display: "At 5000×5000 with capacity=32 floats: ~6 GB" — warns user before they pick something unusable.
- Model-level (global) list attributes: same UI, but the editor lets the user enter the literal list values (not per-cell, just the global value). Bounded slider + per-element widget.

---

## 14. Macro system (`src/model/macroImport.ts`, `src/modeler/vpl/compiler/compile.ts` macro emit)

### Wave A
- NI flows through macro ports as a typed value. Macro `MacroDef.exposedInputs/Outputs` declares `dataType: 'neighborIndex'`.
- Existing macros loaded from older `.gcaproj` files: their NI-relevant ports stay typed `'integer'` until the user re-edits — they keep working at runtime (packed int is still a number). Validation badges on stale macros nudge the user to re-save.
- `cloneMacroWithFreshIds` (per CLAUDE.md macro import notes): no changes — port types travel with the MacroDef, not regenerated.

### Wave B
- Lists flow through macro ports as typed arrays (`int[]`, `float[]`, etc.). No special handling.
- Default `.gcamacro` files in `public/macros/` won't reference list attributes (they don't exist yet); when users build macros that take a list as input, the macro signature carries the elementType.

---

## Cross-Wave Collisions

These are the spots where Wave A's choices constrain Wave B's design (or vice versa):

1. **List of NeighborIndex.** Wave B's `elementType` enum must include `'neighborIndex'`. This means Wave A's NI type must be defined and stable *before* Wave B locks down its elementType list. **Order: Wave A first, period.**

2. **`forEachInArray` (Wave A) is generic from day 1.** Wave A's flow primitive iterates any typed array (`bool[]`/`int[]`/`float[]`/`tag[]`/`NI[]`). Wave B reuses the same node for list iteration — no duplicate.

3. **Migration ordering.** The `.gcaproj` schema bumps need to be sequential: Wave A bumps schema 2→3 (NI port retypes), then 3→4 (NI attribute kind); Wave B bumps 4→5 (list attribute kind). Loaders must handle each step independently so files saved at any version migrate forward correctly.

4. **Compiler-target lockstep (per `feedback_compiler_lockstep.md`).** Every emitter touched in either wave must land on JS + WASM + WebGPU in the same PR. The Wave B WebGPU story is materially simpler than feared because async + list neighbor writes don't reach WebGPU — but the JS/WASM/WebGPU emit triple must still ship together for self-list operations.

5. **Brush + Color-Attribute mapping interaction.** Wave B's brush policy (§8) and color-mapping pipeline (§10) cannot be designed independently — the brush click feeds the mapping which feeds `setAttribute`. Settle the brush policy first, then derive the mapping behavior. Wave A.5 will face a parallel design problem for NI brush + viz.

---

## Open Design Decisions

### Wave A — Resolved (this session)

1. **NI internal representation:** packed i32 with biased 8-bit offsets. Resolved.
2. **Migration of `groupOperator.index` etc.:** rename ports to "Position(s)" and document the list-position semantics; nodeValidation warning when wired into NI ports. Not deprecated.
3. **`forEach` flow node generic from day 1:** yes, ship as `forEachInArray` generic over `bool[]`/`int[]`/`float[]`/`tag[]`/`NI[]`.
4. **Clickable-grid editor anchoring:** offset + viewport mode. NI stores (dr, dc); user picks a neighborhood at edit time as a visual guide; value stays portable.
5. **Brush + viz scope:** deferred to Wave A.5 — Wave A ships NI as a storable attribute kind with default values only; no brush, no auto-viz; users set NI cell attrs only via graph nodes.

### Wave B — Pending user input

6. **Brush behavior on list attributes:** replace (default) / append (opt-in) / disabled (forced for NI elementType)? Recommendation: **all three, attribute-level config, default replace**.

7. **Color-mapping input from a list:** aggregate-then-map (default "length") / pick-element / both? Recommendation: **aggregate-then-map only in v1**, evaluate user demand for pick-element later.

8. **List capacity range:** 1..N where N = ? Recommendation: **1..256 with a warning above 32** — covers realistic use cases (history buffers, agent inventories) without inviting accidentally GB-scale buffers.

9. **Async-only for list neighbor writes:** confirm `appendToNeighborList` is async-only (mirroring `setNeighborAttributeByIndex`). Recommendation: **yes**, same constraint, same compile-time rejection in sync mode.

10. **Per-cell list-attribute overhead at huge grids:** at 5000×5000 with capacity=32 floats per cell, that's 200 MB just for one list attribute's data slab. Hard cap somewhere? Recommendation: **soft warning at attribute-edit time when projected size > 500 MB**, hard error at init time when buffer exceeds `maxStorageBufferBindingSize`.

11. **List indicator types:** length / sum / distinctValueCount / total / frequency-by-value — which ship in v1? Recommendation: **length + total** for v1; the rest as follow-ups.

---

## Recommended PR Sequence

### Wave A (4 PRs)

- **PR A.1 — Type system + migration:** add `'neighborIndex'` to dataType union, port-type validation in `isValidConnection`, schema bump 2→3, migration on load, label rename for groupCounting/Statement/Operator outputs ("Position(s)"), nodeValidation warnings for legacy graphs. **No new nodes yet.**
- **PR A.2 — Section A fix nodes + retypes:** new `pickRandomNeighbor`, `forEachInArray` (generic), `neighborIndexFromOffset`, `neighborIndexFromTag`, `flipNeighborIndex`. Retype existing neighbor nodes to use NI ports. JS + WASM + WebGPU emitters land together.
- **PR A.3 — NI as storable attribute kind:** schema bump 3→4, new `NeighborIndexPicker` component, attributes panel + properties panel updates, worker init for NI cell attrs.
- **PR A.4 — Docs + Help tab + reference:** update `docs/NODES_REFERENCE.md` (new section for NI, new nodes, retyped ports, deprecation notes for list-position outputs), `src/help/HelpView.tsx`, `README.md` if user-facing surface changes.

### Wave B (expected ~6 PRs)

- **PR B.1 — Schema + worker:** schema bump for `.gcaproj` and `.gcastate`, model-types extension, worker init + getState + loadState branches. No nodes yet, no UI yet — list attributes can be created via hand-edited JSON for testing.
- **PR B.2 — JS compiler + new self-list nodes:** all the cell-self list ops (length, get/set element, append, pop, clear, slice). JS-only first, validate behavior on a test model.
- **PR B.3 — WASM + WebGPU lockstep:** match all PR B.2 emitters across both targets (per `feedback_compiler_lockstep.md`).
- **PR B.4 — Async neighbor list ops:** `getNeighborListAttribute`, `appendToNeighborList`. JS+WASM emit (WebGPU rejects async, so no WebGPU emitter needed — confirm rejection path).
- **PR B.5 — Model-attributes UI + brush policy:** new attribute editor for list kind, brush policy implementation, per-attribute brush mode config.
- **PR B.6 — Color-mapping aggregate input + list indicators + docs:** the §9-10 aggregation-then-map pipeline, list indicator types from open decision #11, full docs sweep (NODES_REFERENCE, HelpView, README).

---

## Verification

This is an analysis deliverable — no code yet. Verification means user reads the map and confirms:

- Subsystem coverage in §1–§14 matches what they had in mind.
- Cross-wave collisions don't surprise them, and the proposed orderings are acceptable.
- The open design decisions for Wave B (#6–#11) get a yes / no / different-direction answer when Wave B planning begins.
- The PR sequence feels right.

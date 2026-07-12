# PLAN — N-Dimensional Lookup Tables + Seeded Table Randomization (Accretor)

Companion docs: [IMPACT_MAP_ND_LOOKUP_TABLES.md](IMPACT_MAP_ND_LOOKUP_TABLES.md) (subsystem survey with file:line anchors) · [PLAN_ND_LOOKUP_TABLES.html](PLAN_ND_LOOKUP_TABLES.html) (illustrated mockup — axes editor, slice view + Randomize, node ports, sample graph).

## 1. Summary

Generalize the existing 2-axis `lookupTable` model-attribute type to **N axes** (new axis kind: **integer range**), stored as a dense flat `tableData: number[]`, emitted on **all six compile surfaces** (JS/WASM/WebGPU lattice + agent WASM/WebGPU ABI mirrors) as a multi-stride flat read — plus a **seeded random fill** (editor button + Overseer node) so rule-table CA families (Accretor being the flagship) can be authored, re-rolled, and searched. Ship an **Accretor** library sample proving it end-to-end on all three targets.

The core realization: a 2-D table already compiles to a flat array read at `row*colCount+col` everywhere; N-D is the same flat read with `Σ idxₖ·strideₖ` — a few more multiply-adds per emit, **zero new runtime machinery** (the table regions in WASM memory / varAux / auxF32 are already flat and size-agnostic).

## 2. What Accretor needs vs. what exists

Already shipping: 3D grid + voxel renderer, multiple named neighborhoods (faces/edges/corners as three neighborhoods), Group Counting `> 0` per neighborhood, Init Event with x/y/z for the 5×5×5 center seed, `state == 0` gating (accretion freeze), Stop Event at the grid edge, `setRngSeed` + Overseer seed policy, Table Lookup with **wired** (computed) indices.

Missing: (1) tables with more than 2 axes / integer-range axes; (2) any seeded random table fill. Nothing named `range`, `seed`, or `random` exists in any lookup-table path today — both features are pure additions.

## 3. Schema changes (all additive, no migration)

```ts
// types.ts
export type LookupKeySource =
  | { kind: 'facePalette'; paletteId: string }
  | { kind: 'tagAttribute'; attributeId: string }
  | { kind: 'single' }
  | { kind: 'custom'; labels: string[] }
  | { kind: 'intRange'; min: number; max: number };   // NEW — labels = String(min)..String(max)

export interface LookupAxis { name?: string; source: LookupKeySource }

// on Attribute (lookupTable only):
axes?: LookupAxis[];        // present ⇒ axes mode (supersedes rowKeySource/colKeySource); 1..6 axes
tableData?: number[];       // axes mode: dense row-major over axes in declared order, length = Π dims
tableRoll?: { seed: number; density: number };  // informational randomize metadata

// on SimulationState (presets):
lookupTableData?: Record<string, number[]>;    // axes-mode preset capture (legacy interactionTables kept)
```

## 4. Core architecture decisions

### D-NDT-1 — Axes mode is additive; the legacy 2-axis path stays byte-identical
`axes` absent ⇒ every existing code path runs verbatim (`rowKeySource`/`colKeySource`, nested `tableValues`, the exact current emit strings/bytecode/WGSL). Axes present ⇒ the new path. Emit branches on mode inside each emitter, so `compileAll` output for every existing library model is **string-equal before/after** — the byte-identity proof standard. No file migration, no auto-conversion; the editor offers an explicit one-shot "Convert to multi-axis" (seeds `axes` from row/col + translates `tableValues`→`tableData`).

### D-NDT-2 — Dense flat `tableData`, row-major over declared axis order
Nested label-keyed records don't generalize to N levels, every runtime consumer already wants the dense flat array (`normalizeLookupTable` converts sparse→dense on every use today), and random fill produces dense data. Cost: axis-shape edits must **structurally remap** `tableData` (one shared `remapTableDataAxis(data, dims, axisIdx, indexMap)` powering the ModelContext cascades: tag rename/reorder, custom-label edit, intRange min/max change, tagAttribute-axis detach → collapse to `single` keeping slice 0). Accretor's 3-state table is 2,457 numbers ≈ a few KB of JSON — negligible in `.gcaproj`.

### D-NDT-3 — `resolveAxes(attr, model)` is the new single source of truth
Lives in variegation.ts beside `resolveKeyLabels` (which gains the `intRange` arm). Returns `{ axes:{name,labels,dim}[], dims, strides, mins, total }`. **Legacy tables resolve as N=2** with identical numbers, so all 11 current `resolveKeyLabels` table call sites (compilers ×5, worker payload build, editor ×2) migrate to one helper and cannot drift. `normalizeLookupTableND` + the shared `randomFillTableData` sit next to it.

### D-NDT-4 — Static `axis_0..axis_5` ports (expression-node pattern), NOT dynamic edges
Table Lookup gains six **static** integer input ports in `def.ports`, sliced + relabeled per the referenced table's axes (the exact `expression` visibleCount pattern, mirrored in CaNode + effectivePorts like `buildExtraSlotPorts`). Static ports mean every compiler's existing input resolution, CSE purity keys, and sink analysis work unchanged — no `${nodeId}:` prefix-scan additions. Legacy tables keep showing `labelA`/`labelB` (wires never move); axes-mode hides them and shows `axis_0..axis_{N-1}` labeled with axis names. Cap of 6 axes is what justifies the static-max approach.

### D-NDT-5 — OOB unification: axes mode clamps; legacy stays raw
Today OOB diverges across targets (raw / guard-to-0 / clamp). Axes mode emits a **saturating clamp per axis** — `clamp((v|0) − min, 0, dim−1)` — identically on all six surfaces (GPU-safe, target-consistent, and free insurance for Accretor where counts are range-bound by construction). Legacy emit is untouched (byte-identity). The **agentWebgpu port-name bug** (`row`/`col` vs `labelA`/`labelB` — always reads `[0,0]` on that target) is fixed in the same emitter; it's a broken-path behavior fix, no shipped sample affected.

### D-NDT-6 — Randomize is a design-time action writing model data; the house xorshift32 is the fill PRNG
The editor's Randomize block calls `randomFillTableData(resolved, seed, density, valuePolicy)` and commits via the existing `onChange` → `updateAttribute` — so the rolled rule **lives in the model**, saves into `.gcaproj`, and is inspectable. Value policy by `valueType`: bool → 1; integer/tag → uniform over the non-zero value space; float → uniform (0,1]. The PRNG is the inline xorshift32 (13/17/5, `>>>0`, `/2^32`) — no shared main-thread PRNG exists today, so this helper becomes it. Same (seed, density, shape) ⇒ identical table on any machine. `tableRoll` metadata records seed+density for UI/reproducibility; the data stays authoritative.

### D-NDT-7 — `ovRandomizeTable` is runtime-only (slider semantics)
The Overseer node re-rolls the WORKER's table (via the shared fill + `updateLookupTable`) without dirtying the model — mirroring `ovSetModelAttribute`. The journal logs `{tableId, seed, density}` per roll, so a discovered-interesting rule is reproduced by entering that seed in the editor and Applying. This makes "sweep 50 seeds × run-until-stop × screenshot the survivors" a pure Overseer protocol — the Softology workflow, automated.

### D-NDT-8 — `interactionTableMap` (Table Map) stays 2-index
Its vectorized shape is inherently two parallel index arrays. Axes-mode tables with exactly 2 axes are allowed; N>2 ⇒ validation badge + compile error. It remains LATTICE_ONLY on agents. No Accretor dependency.

## 5. Phased delivery

### PR1 — Engine: schema + resolveAxes + all six emit paths
types.ts additions · `resolveKeyLabels` intRange arm + `resolveAxes` + `normalizeLookupTableND` + `randomFillTableData` + `remapTableDataAxis` · pre-resolve `_dims`/`_mins` · LookupInteractionNode axes-mode emit + static `axis_*` ports + effectivePorts/CaNode slicing · WASM + WebGPU + agentWasm + agentWebgpu layout `dims` + emit branches (+ the agentWebgpu port fix) · worker payload `dims`/`data` + `normalizeLookupTableND` at both call sites · SimulatorView init/updateLookupTable payload build · nodeValidation cases · ModelContext cascades.
**Verify:** tsc + build; `compileAll` byte-identity on every library model (legacy path untouched); a synthetic 3-axis coded-index model (entry = i0·10000 + i1·100 + i2) read back per-cell with 0 mismatches on JS/WASM/WebGPU through the real worker; agent JS↔WASM parity harness 0 mismatches; clamp behavior probed at both ends of each axis.

### PR2 — Authoring: axes editor + N-D slice view + Randomize
AttributesPanelContent axes-list editor (kind dropdown incl. Integer range min/max, name field, add / remove-last only — no reorder, the multi-attr-slots discipline) + "Convert to multi-axis" · LookupTableEditor slice view (last two axes span the 2D grid; steppers for outer axes) reusing the per-valueType cell widgets · Randomize block (Seed + 🎲, Density, policy row, Apply) in both mount points (modeler + simulator live panel) · presets `lookupTableData` capture/restore + reset-to-default snapshots · `symmetric` hidden for N≠2.
**Verify:** author a 4-axis table from scratch in the UI; randomize twice with the same seed ⇒ identical `tableData`; live re-roll during a run updates the sim; preset round-trip; cascade tests (tag rename, intRange grow/shrink, axis-source detach).

### PR3 — The Accretor sample + docs sweep
`scripts/gen-accretor.mjs` → `public/models/Accretor.gcaproj`: 3D 60³ bounded (constant boundary), tag attr `state` (empty/A/B), **three neighborhoods** (faces 6 / edges 12 / corners 8 as explicit `coords3d` + same-length 2D projections), rule table axes `[State(tag) × Faces 0..6 × Edges 0..12 × Corners 0..8]` valueType tag, `tableData` pre-rolled by the script with a curated seed (density 0.2, documented in the description) · Step graph: `state==0` gate → 3× (Get Neighbors Attribute → Count Matching `> 0`) → `faces ≥ 1` gate → Table Lookup(state, f, e, c) → Set Attribute · Init Event: center 5×5×5 random state · Stop Event: non-empty cell at any grid border · standalone Output Mapping writing alpha 0 for empty (voxel culling) + per-state colors · linked frequency indicator (trackedValues A,B) to watch growth · `useWasm: true`.
Docs atomically: CLAUDE.md (Lookup Tables + new section), HelpView, README, NODES_REFERENCE.
**Verify:** grows from the seed into a coherent structure and stops at the edge on JS, WASM, and WebGPU; JS↔WASM identical populations per generation (same RNG stream); re-rolling the table seed in the editor yields a different morphology.

### PR4 — Overseer `ovRandomizeTable` + the Accretor Explorer protocol
Node def + registry + `OV_ACTION_TYPES` + compiler case + `O.randomizeTable` + `OverseerDeps.randomizeTable` wired in SimulatorView + validation + count bumps (137→138 selectable / 19→20 overseer; NODES_REFERENCE O-table, README, CLAUDE.md). Optionally ship the sample's Overseer graph: `Loop × N { Randomize(seed=base+i) → Reset → Run Until Stop → Collect(filled-cell count) → Screenshot }` — automated rule-space search with a journal of seeds.
**Verify:** two experiment runs with the same base seed produce identical journals + series on JS/WASM; the logged seed reproduces the structure via the editor.

## 6. Risks & gotchas

1. **Layout lockstep (the +64-cell class):** WASM/WebGPU/agent table regions are sized by Π dims at layout time and read at baked offsets — the compiler and the worker/store MUST derive dims from the same `resolveAxes`. Mitigation: one helper, and the agent-side `buildAgentLayoutExtras` single-source rule already enforces the pattern; extend `audit-agent-layout.mjs` to cover `dims`.
2. **`tableData` layout invalidation on axis edits:** any dim change must remap-or-zero deterministically (D-NDT-2's shared remap); remove-last-only ordering prevents silent axis shifts, mirroring multi-attr slots.
3. **Emit byte-identity:** keep the legacy emit strings/opcodes character-for-character (branch, don't refactor); prove with `compileAll` string equality across the whole library.
4. **f32 exactness on GPU:** table values are small ints — exact in f32; the coded-index verification value must stay < 2^24.
5. **CSE purity assumption:** tables must remain read-only during a step. `ovRandomizeTable`/editor rolls mutate **between** steps on the main thread (same channel as today's live table edits) — no purity change needed; do NOT add mid-step mutation.
6. **stringifyCompact:** confirm a 2,457-element `tableData` array serializes acceptably (valid JSON regardless; check formatting/size on save).
7. **`_rowCount` is dead on lattice paths today** — don't build on it; `_dims` replaces it for axes mode, legacy keys left as-is.

## 7. Open decisions (user input welcome, defaults chosen)

- **Slice-view orientation:** v1 fixes the LAST two axes as the visible grid (deterministic vs. storage). A "choose visible axes" picker can come later.
- **Float fill policy:** uniform (0,1] chosen for v1; a min/max range field could be added later.
- **Accretor grid size:** 60³ default (interactive on WASM; the blog uses larger — users can resize).

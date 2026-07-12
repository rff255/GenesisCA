# IMPACT MAP — N-Dimensional Lookup Tables + Seeded Table Randomization (Accretor enablement)

**Status:** survey complete, no code written. Companion plan: [PLAN_ND_LOOKUP_TABLES.md](PLAN_ND_LOOKUP_TABLES.md) (+ illustrated mockup `PLAN_ND_LOOKUP_TABLES.html`).

**Goal:** reproduce the Accretor CA family (Driessens & Verstappen, via the Softology 2018-01-12 post): a 3D accretion automaton whose rule is `Rule[state, faceCount, edgeCount, cornerCount] → newState` — a 4-axis table (3 states ⇒ 3×7×13×9 = 2,457 entries) filled **randomly with a seeded PRNG** at a chosen density. Two capability gaps: (1) lookup tables are strictly 2-axis; (2) there is no seeded random table fill anywhere. Everything else Accretor needs (3D grid, multiple named neighborhoods, per-neighborhood counting, Init-Event seeding, Stop Events, voxel rendering with alpha, `setRngSeed`) already ships.

---

## 0. The load-bearing invariants today (from the code survey)

- **Two chokepoints own axis geometry**: `resolveKeyLabels(source, model)` ([variegation.ts:169](../src/modeler/vpl/compiler/variegation.ts)) — the single source of truth for one axis' ordered labels/dimension — and `normalizeLookupTable(values, rowLabels, colLabels)` (variegation.ts:191) — sparse nested `tableValues` → row-major `Float64Array`, stride = `colLabels.length`. Every consumer funnels through them (11 `resolveKeyLabels` call sites across compile.ts, wasm/layout, webgpu/layout, agentWasm, agentWebgpu, SimulatorView ×6, AttributesPanelContent).
- **One baked stride**: every emitter computes `row * colCount + col`. `_colCount` is injected into node config by `preResolveVariegatedNodes` (compile.ts:1722–1728 via `lookupTableDims`, :1680). **`_rowCount` is injected but DEAD on all lattice paths** — only agentWasm consumes `rows*cols` (as a guard bound).
- **Storage is label-keyed sparse 2-level**: `Attribute.tableValues?: Record<rowLabel, Record<colLabel, number>>` — the shape every ModelContext remap cascade, preset snapshot, and the editor operate on. It does not generalize to N levels.
- **Tables are read-only during a step** (upload-only; never mutated mid-cell). This is what makes `lookupInteraction`/`interactionTableMap` CSE-pure and loop-invariant-hoistable — properties to preserve.
- **OOB behavior is inconsistent across the 6 targets today** (see §16 matrix): raw on the 3 lattice targets, guard-to-0 on agentWasm, saturating clamp on agentWebgpu.
- **Pre-existing bug found in survey:** agentWebgpu's `emitLookupInteraction` ([agentWebgpu/compile.ts:1296-1297](../src/modeler/vpl/compiler/agentWebgpu/compile.ts)) reads value inputs from ports `'row'`/`'col'`, but the node def declares `labelA`/`labelB` — so on the agent-WebGPU target both indices resolve to the default `0` and the lookup always reads the clamped `[0,0]` cell. Lattice + agentWasm use the correct ids. Fix rides this change (same emitter).

---

## 1. Schema — `src/model/types.ts`

| Item | Today | Change |
|---|---|---|
| `LookupKeySource` (types.ts:29–36) | 4 kinds: `facePalette` / `tagAttribute` / `single` / `custom{labels}` | **+ `{ kind: 'intRange'; min: number; max: number }`** — an integer-range axis (Accretor's count axes). Additive; legacy row/col sources may also use it. |
| Axes | exactly `rowKeySource?` + `colKeySource?` (types.ts:99,102) | **+ `axes?: LookupAxis[]`** where `LookupAxis = { name?: string; source: LookupKeySource }`. When present (length ≥ 1, cap 6) it **supersedes** row/col. Absent ⇒ legacy 2-axis path, byte-identical. |
| Storage | `tableValues?: Record<string, Record<string, number>>` (types.ts:116) | **+ `tableData?: number[]`** — dense row-major flat array over the axes in declared order (length = Π dims), used **only** in axes mode. `tableValues` untouched for legacy tables. |
| Randomize metadata | — | **+ `tableRoll?: { seed: number; density: number }`** — informational; the DATA stays authoritative. Seeds the editor fields; journaled by the Overseer node. |
| `valueType` / `valueTagOptions` / `valueTagAttributeId` / `symmetric` | types.ts:107–133 | Unchanged. `symmetric` remains meaningful only for 2 identical axes → editor hides it for axes-mode N≠2. |
| `SimulationState.interactionTables` (types.ts:600) | 3-level nested Record (presets) | Kept for legacy. **+ `lookupTableData?: Record<attrId, number[]>`** sibling field for axes-mode presets. |

No file-format migration needed — everything is additive; old `.gcaproj` load unchanged. `lookupTableMigration.ts` untouched.

## 2. Axis resolution — `src/modeler/vpl/compiler/variegation.ts`

- `resolveKeyLabels` gains an `intRange` arm → labels `[String(min) … String(max)]` (span clamped, see caps §17).
- **New `resolveAxes(attr, model)`** — the N-D single source of truth. Returns `{ axes: {name, labels, dim}[], dims: number[], strides: number[], total: number, mins: number[] }`. For a legacy table (no `axes`) it returns the 2-axis equivalent built from `rowKeySource`/`colKeySource` — so every consumer can migrate to `resolveAxes` and treat legacy as N=2 with identical numbers.
- **New `normalizeLookupTableND(attr, resolved)`** → dense `Float64Array` from `tableData` (axes mode) or via the legacy `normalizeLookupTable` (2-axis mode). The legacy function is kept verbatim.
- **New shared `randomFillTableData(resolved, seed, density, valuePolicy)`** — ONE seeded fill implementation (xorshift32, 13/17/5, `>>>0`, `/2^32` — the house PRNG; there is no shared main-thread PRNG today, so this becomes it) consumed by the editor Randomize button AND `ovRandomizeTable`. Deterministic: same (seed, density, dims, policy) ⇒ identical data on any machine.

## 3. ModelContext cascades — `src/model/ModelContext.tsx`

Today's cascades are label-keyed against nested `tableValues` (REMOVE_ATTRIBUTE detach :349–364; `applyCustomAxisRemap` :444–464; tag-rename remap :490–573). Axes-mode needs **structural** equivalents operating on `tableData` + dims:

- **REMOVE_ATTRIBUTE**: an axis whose source is `tagAttribute` referencing the removed id → axis collapses to `{kind:'single'}` (dim 1, keep slice at old index 0); `valueTagAttributeId` detach unchanged.
- **Tag rename/reorder** on a referenced tag attribute: gather-remap `tableData` along that axis via the same `indexMap` used for node configs; `valueType==='tag'` cell-value remap applies to `tableData` exactly as it does to `tableValues` today.
- **Custom-label edit** on an axis: name-paired index remap (the N-D generalization of `applyCustomAxisRemap`).
- **intRange min/max edit**: remap by value identity (grow ⇒ zero-fill, shrink ⇒ drop, min shift ⇒ offset gather).
- All remaps are one shared helper `remapTableDataAxis(data, dims, axisIdx, indexMap)`.

## 4. JS compiler — `compile.ts` + the two node files

- **Pre-resolve** (compile.ts:1722–1728): for axes-mode tables inject `_dims: number[]` + `_mins: number[]` (+ keep `_rowCount`/`_colCount` for legacy). `lookupTableDims` → generalized via `resolveAxes`.
- **`LookupInteractionNode.ts`**: compile() **branches on axes mode**. Legacy emit string stays **byte-identical** (`_tbl[la*colCount+lb] || 0`). Axes mode emits per-axis clamped index math: `ik = min(max((axis_k|0) - min_k, 0), dim_k-1)`, flat = `Σ ik·stride_k`, then `_tbl[flat] || 0`.
- **Ports**: static max-axes `axis_0…axis_5` integer inputs added to `def.ports` (the **expression-node pattern** — static ports sliced/relabeled per config/model, NOT switch-style dynamic edges), so every compiler's static input resolution works unchanged. Legacy tables show `labelA`/`labelB` and hide the axis ports; axes-mode hides `labelA`/`labelB` and shows/labels `axis_0…axis_{N-1}` with the axis names. Existing 2-axis wires never move.
- **`InteractionTableMapNode.ts`**: supports axes-mode tables **only when N=2** (same vectorized 2-index shape); N>2 ⇒ validation badge + compile error. Legacy emit untouched.
- **`_lookupTables` param gating** (`variegated || hasLookupTables`, compile.ts:1311/1332/2019) — unchanged (axes-mode tables are still `type==='lookupTable'` model attrs).

## 5. WASM compiler — `wasm/layout.ts` + `wasm/compile.ts`

- **layout.ts**: `interactionTableOffsets: Record<id, {offset, rowCount, colCount}>` (:160, alloc :369–380) → carries `dims: number[]` (legacy = `[rowCount, colCount]`, fields kept). Region size = Π dims × 8 (f64), same alignment. `computeLayoutFromModel` (:455–461) resolves via `resolveAxes`.
- **compile.ts** `lookupInteraction` (:2138–2160): axes-mode branch emits i32 clamp per axis (`i32.lt_s`/`select` pair or `max(min())` composition) + multiply-add chain + `f64Load(slot.offset, 3)`. Legacy branch emits the exact current sequence (byte-identical modules for existing models). `interactionTableMap` (:4690–4777): N=2 axes-mode allowed, else unchanged.

## 6. WebGPU compiler — `webgpu/layout.ts` + `webgpu/compile.ts`

- **layout.ts**: `WebGPUInteractionTableLayout` (:53–62) gains `dims`; varAux packing (:298–307) sizes by Π dims (f32 words, same 16-B alignment).
- **compile.ts** `lookupInteraction` (:2180–2199): axes-mode emits `bitcast<f32>(varAux[u32(off + Σ clamp(ik,0,dimk-1)·stridek)])`. Legacy emit + its explicit no-clamp comment untouched. f32 exactness holds — table values are small ints (states/booleans), well under 2^24.
- `interactionTableMap` (:1133–1162): N=2 only, as above.

## 7. Agent WASM — `agentWasm/compile.ts` + `agentEngine.ts`

- `AgentMemoryLayout.lookupTableOffset/Cols/Bytes` (agentEngine.ts:155–157) + `AgentLayoutExtras.lookupTables: Record<id,{rows,cols}>` (:184) → extras carry `dims: number[]` (legacy `{rows,cols}` kept = dims`[r,c]`); region size Π dims × 8 (`computeAgentMemoryLayout` :369–383).
- `emitLookupInteraction` (agentWasm/compile.ts:1268–1290): axes-mode branch — per-axis clamp + multiply-add; keeps the existing guard style. `buildAgentLayoutExtras` (:4719–4745) resolves via `resolveAxes`. **Layout-lockstep discipline applies**: the store's extras and the compiled module MUST derive from the same `resolveAxes` output (the established `buildAgentLayoutExtras` single-source rule).
- `interactionTableMap` is LATTICE_ONLY — no agent change.

## 8. Agent WebGPU — `agentWebgpu/compile.ts` + `agentWebgpu/layout.ts`

- layout (:285–298): `lookupTables: Record<id,{base,rowCount,colCount}>` in auxF32 → gains `dims`; size Π dims (f32).
- `emitLookupInteraction` (:1289–1303): axes-mode branch with per-axis `clamp()` (it already clamps). **Bug fix folded in:** read ports `labelA`/`labelB` (currently `'row'`/`'col'` — always reads `[0,0]`). This is a behavior fix on a broken path; no shipped sample uses agent-side Table Lookup on WebGPU (the heavy-rule bench is WASM/JS).

## 9. Cross-cutting analyzers — no structural change

- **accessorCSE**: both nodes stay pure (tables remain read-only during a step; `ovRandomizeTable` mutates between runs on the main thread, like `updateLookupTable` live edits today). Axis inputs are static ports → purity keys pick them up automatically.
- **loopInvariant**: both stay composite — an N-D lookup with all-invariant indices still hoists out of the cell loop (the documented LookupInteraction property).
- **sinkAnalysis / volatileHoist**: nothing table-specific today; static axis ports keep it that way.

## 10. Worker — `sim.worker.ts` (+ `webgpuRuntime.ts`, `agentWebgpuRuntime.ts`)

- `InteractionTablePayload` (:93–103) + `InitMsg.interactionTables` (:133): gains optional `dims?: number[]` + `data?: number[]` (axes mode) alongside legacy `rowLabels/colLabels/values`.
- `initVariegation` (:2187–2206) + the `updateLookupTable` handler (:5154–5175): normalize via `normalizeLookupTableND`; the **copy-into-view discipline is unchanged** (views over `wasmMemory` at baked offsets; `existing.set(normalized)`, never reassign).
- WebGPU `uploadInteractionTable` (webgpuRuntime.ts:1021) + `syncVariegationToGPU` (:2214–2228): size-agnostic already (writes `count` words) — only the payload plumbing changes.
- Agent external-region copy-in: sizes derive from the extras' dims (§7).

## 11. SimulatorView — `SimulatorView.tsx`

- **Init payload build** (:3221–3228 and the duplicate :3671–3678): per-table payload adds `dims`/`data` for axes-mode via `resolveAxes`.
- **`updateLookupTable` posts** (live edit :6488–6507; reset-to-default :6516–6537; preset apply :6838–6851): same payload extension; `interactionTableDefaultsRef` snapshots `tableData` for axes-mode.
- **Presets**: `snapshotInteractionTables` (:6661–6670) + `serializePreset` (fileOperations.ts:546–558) + `applySimulationState` restore (:6838–6851) — axes-mode tables ride the new `lookupTableData` field; legacy field untouched (old presets keep loading).
- **Overseer deps** (:1018–1054): + `randomizeTable(attrId, seed, density)` (PR4) — SimulatorView owns the model, resolves axes + value policy, calls the shared fill, posts `updateLookupTable`. Runtime-only (never dirties the model), mirroring `ovSetModelAttribute` slider semantics.

## 12. Editor UI

- **AttributesPanelContent.tsx** (lookupTable detail block :433–523): a **mode-aware axes editor** — legacy tables keep the two `KeySourceField`s verbatim; a "Convert to multi-axis…" action seeds `axes` from row/col (+ translates `tableValues`→`tableData` once); axes-mode renders the axes list (name + source kind incl. **Integer range** min/max + add / remove-last — the multi-attr-slots discipline: **no reorder, remove last only**, so `tableData` layout and wired `axis_k` ports never silently shift).
- **LookupTableEditor.tsx**: axes-mode renders a **2D slice view** — pick which two axes span the grid is unnecessary in v1: the LAST two axes span the grid, steppers/selects for the outer axes (simplest deterministic mapping to row-major storage). Cell edits write `tableData[flatIdx]` through the same `onChange` contract. Existing per-`valueType` widgets reused. Plus the **Randomize block**: Seed (integer + 🎲 reroll), Density (0–1), fill-value policy row, Apply → `randomFillTableData` → `onChange({tableData, tableRoll})`. Works in BOTH mount points (modeler detail panel + simulator right panel — live during a run).
- **CaNode.tsx**: Table Lookup port derivation (slice/relabel `axis_0…axis_5` per the referenced table — mirrored in **effectivePorts.ts** per the buildExtraSlotPorts dual-consumption pattern; the port-id-signature `updateNodeInternals` effect re-measures handles on table swaps for free). Table picker (:2903–2922) unchanged.
- **nodeValidation.ts** (:506–517): + axes-mode checks — unwired/invalid table, `interactionTableMap` on N>2, intRange sanity (min ≤ max), table too large (see caps).

## 13. Overseer (PR4) — `ovRandomizeTable`

Standard one-node extension chain: node def (`requirements:{overseer:true}`, config `tableId`, inline `seed`+`density` inputs) → registry → `OV_ACTION_TYPES` + compiler `case` → `O.randomizeTable(...)` → `OverseerDeps.randomizeTable` wired in SimulatorView → validation badge → docs count bumps (**137→138 selectable / 19→20 overseer**; NODES_REFERENCE O-table, README :217, CLAUDE.md counts). Journal line records `{tableId, seed, density}` so an interesting rolled rule is reproducible in the editor. ExperimentsPanel needs no change.

## 14. Sample + scripts

- **`scripts/gen-accretor.mjs`** → `public/models/Accretor.gcaproj` (clone the gen-life3d.mjs skeleton: `node()/vEdge()/fEdge()` helpers, `coords3d` + same-length 2D `coords` projection, `dimension:'3d'`, `useWasm:true`, preserve-simulationState+thumbnail tail). Contents per the plan §PR3.
- **Existing scripts to re-verify, not change**: `gen-chromatography.mjs`/`gen-amphiphile.mjs` (legacy 2-axis tables — must stay byte-identical), `audit-agent-layout.mjs` + `parity-agent-wasm.mjs` + `test-agent-abi.mjs` (agent extras shape gains `dims` — the audit's cross-checks must cover it), `bench-agent-behaviour.mjs` (legacy table on agents).

## 15. Docs (atomic with the feature, per the docs-consistency rule)

CLAUDE.md (Lookup Tables section + Overseer node family + counts) · HelpView.tsx (Lookup Table copy :433–483 + Overseer section) · README.md (feature list + count :217) · NODES_REFERENCE.md (counts :7–12, Table Lookup/Map rows :209–211, Overseer table :785–806).

## 16. OOB semantics — current matrix and the unification decision

| Target | Today | After |
|---|---|---|
| JS lattice | raw (`\|0` + trailing `\|\|0`) | legacy: unchanged · axes-mode: **saturating clamp per axis** |
| WASM lattice | raw load, no check | same split |
| WebGPU lattice | raw (explicit no-clamp comment) | same split |
| agentWasm | guard-to-0 on flat bound | same split (legacy guard kept) |
| agentWebgpu | saturating clamp (+ wrong ports bug) | clamp kept · **port bug fixed** |

Rationale: clamping only the NEW mode preserves byte-identity for every existing model while giving Accretor GPU-safe, target-consistent semantics (counts can't exceed axis ranges anyway; clamp is insurance, not behavior).

## 17. Caps & non-impacts

- **Caps**: axes ≤ 6; intRange span ≤ 4096 labels; total entries — editor warns > 65,536, hard cap 1,048,576 (8 MB f64 WASM region / 4 MB f32 GPU). Accretor's 5-state worst case is 4,095 entries (32 KB) — three orders of magnitude of headroom.
- **Explicit non-impacts**: `ATTR_TYPE_MAP` (lookupTable is never a per-cell runtime buffer); `.gcastate` (tables ride presets, not sim state — unchanged posture); dev harness `compileHarness.ts` (nothing table-specific; used as the byte-identity checker); recording/render; the reroute/macro/composite pre-compile transforms (tables are config-referenced, not graph-structural); `interactionTableMap` on agents (stays LATTICE_ONLY).
- **Byte-identity proof obligation**: `compileAll` output (JS stepCode / WASM bytes / WGSL) string-equal before/after for every library model (all use legacy tables or none); JS↔WASM agent parity harness 0 mismatches (9 entries).

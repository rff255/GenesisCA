# PLAN — Large-grid CA performance: "Skip Isolated Empty Cells" + inline neighbours

**Branch:** `sim_agent_fixes` (continue on it). **Status:** planned 2026-07-13; implementation is AUTONOMOUS (the user is unavailable — do NOT stop to ask or wait for manual testing; commit each milestone; verify rigorously yourself).

## PROGRESS (2026-07-13)
- ✅ **Phase 0** (commit `e3a63ea`): schema (`ModelProperties.skipIsolatedEmpty`) + Properties UI ("Skip Isolated Empty Cells", gridCells-only, empty attr/value + neighbourhood/radius range) + ModelContext cascades. Byte-identical (24 models).
- ✅ **Phase 1** (commit `cc3a324`): the shared active-set engine (`src/simulator/engine/activeSet.ts`) + the **JS** sparse step (`sparseSteppingEnabled` gate + `if (_activeList)` loop variant, linked-indicators routed to the worker full-grid scan) + full worker wiring (setup/rebuild on init/reset/recompile/loadState/mutations, per-step transition maintenance, `buildLoopArgs` active-list). VERIFIED: `scripts/verify-sparse-stepping.mjs` (sparse==full byte-for-byte, 2D+3D, genuinely sparse 48%/36%) + END-TO-END on the real Accretor through the real worker (radius-1/faces range == full at a fixed RNG seed; corners range != full → proves the active set gates; zero errors). byte-identity + tsc + build clean.
- ⏳ **Phase 2** (WASM sparse step) — NOT STARTED. The WASM step's outer loop (`compileEntry` in `wasm/compile.ts` ~line 7074: `for outerCounter < total { iLocal := outerCounter | orderArray[outerCounter] }`) must gain a sparse variant iterating an active-list wasmMemory region. Design: add `activeListOffset` (total×4) to `wasm/layout.ts` (when sparse); the step signature becomes `step(total, activeCount)` (activeCount −1 ⇒ full loop; ≥0 ⇒ iterate `activeListMem[0..activeCount]`); the worker copies `activeSet.list` into the region + passes activeCount + extends the runStep transition-detection block to WASM (drop the `!callWasm` guard) + the linked routing already covers WASM. Extend `verify-sparse-stepping.mjs --wasm` to instantiate + drive the WASM step and assert == JS == full.
- ⏳ **Phase 3** (inline neighbours) — NOT STARTED. See the "Feature B" section + the neighbour-emitter map committed in the git history (the background survey). Largest/riskiest phase.
- ⏳ **Phase 4** (enable on the Accretor + bump grid + docs) — NOT STARTED. **NB:** do NOT enable on the Accretor until Phase 2 lands — the Accretor defaults to WASM, so enabling with only JS sparse would leave it inert on WASM (or, if switched to JS, could REGRESS since JS-full is ~3-5× slower per cell and the Accretor fills a large grid fraction). Enable once WASM sparse (Phase 2) makes it a win on the default target.

The foundation (Phases 0-1) is complete, correct, opt-in, and byte-identical when off. Phases 2-4 build on it. Resume from Phase 2.

## Why
Measured on the Accretor (WASM), two real bottlenecks make large 3D grids slow:
1. **The Generation Step is O(total cells).** Every cell — including the vast majority that are empty and far from the structure — runs the full neighbour gather each generation. Unthrottled, 40³ ran ~66 gen/s but 120³ couldn't finish one batch in 3 s (it scales with cell count). The user's insight: only cells at/near the growing SURFACE matter.
2. **The precomputed neighbour-index table is `total × nSz × 4` bytes.** 0.83 GB at 200³ (3 s init), **2.8 GB at 300³** (10 s init, against the 4 GB WASM ceiling). It dominates init time + memory.

Two independent, stacking optimizations fix these. **Both ship under ONE opt-in feature** so existing models are byte-identical when it is off.

---

## Feature A — "Skip Isolated Empty Cells" (opt-in, CA-grid only)

### User requirements (verbatim intent — honor exactly)
- An **optional toggle**, only meaningful/shown when the model uses the CA grid (`topologyMode.gridCells !== false`).
- Named exactly **"Skip Isolated Empty Cells"** in the UI.
- When enabled, the user MUST specify:
  - **a cell attribute** (which attribute defines "empty"),
  - **which value** of that attribute defines an "empty" cell,
  - **a neighbourhood OR a distance/radius** — the shell within which empty cells near a non-empty cell are STILL processed (their Generation Step + Output Mapping run).
- The user must **still be able to interact (draw/paint) with isolated empty cells** — painting is never gated by the active set; painting updates the active set + shows immediately.
- OFF by default → every existing model byte-identical.

### Semantics (precise)
"Empty" = `readAttrs[emptyAttrId][idx] === emptyValueEncoded`. A cell is **ACTIVE** iff it is within the **active-range** of at least one **non-empty** cell. A non-empty cell is within range 0 of itself → always active. **Only ACTIVE cells run the Generation Step and the Output Mapping colour pass.** Isolated empty cells (no non-empty cell within active-range) are SKIPPED — they keep their state + colour (the "empty" appearance, established by the full initial colour pass / default colour fill).

`active-range` = the offset set of the chosen **neighbourhood** (its `coords3d`/`coords`) ∪ `{(0,0,0)}`, OR a **radius** sphere/box by a metric (reuse `generateCoords3d`/the disk helpers). Store the dilation offsets once at init.

This is **state-defined** (recomputed-equivalent each step via incremental maintenance), NOT change-tracking — robust for monotonic (Accretor) and non-monotonic models.

### Schema (additive — `src/model/types.ts` `ModelProperties`)
```ts
skipIsolatedEmpty?: {
  enabled: boolean;
  emptyAttributeId: string;      // a cell attribute id
  emptyValue: string;            // encoded like Attribute.defaultValue (tag index / "true"/"false" / number)
  rangeKind: 'neighborhood' | 'radius';
  neighborhoodId?: string;       // when rangeKind === 'neighborhood'
  radius?: number;               // when rangeKind === 'radius' (default 1)
  radiusMetric?: 'chebyshev' | 'manhattan' | 'euclidean';  // default chebyshev (Moore)
};
```
Additive/optional → old `.gcaproj` load unchanged. Add the LOAD_MODEL guard (default absent) + cascades in `ModelContext.tsx` (clear/repoint on delete of the referenced attribute or neighbourhood; remap `emptyValue` on a tagOptions edit — mirror the existing sub-attribute/linked-OM cascades).

### UI (`src/modeler/panels/PropertiesPanelContent.tsx`, Execution section)
- A checkbox **"Skip Isolated Empty Cells"**, rendered ONLY when `topologyMode.gridCells !== false`.
- When checked, reveal: an "Empty attribute" dropdown (cell attrs), an "Empty value" widget (type-adaptive: tag→InlineTagSelect, bool→select, int/float→NumberField — reuse the pattern from the Manual Brush / sub-attribute editors), a "Processing range" mode toggle (Neighbourhood / Distance), and either a neighbourhood dropdown or a radius NumberField (+ metric select).
- `nodeValidation`/panel validation: when enabled, require `emptyAttributeId` + a valid range.
- (UI is a standard config section; a quick self-contained HTML mockup is OPTIONAL — produce one only if it clarifies the layout.)

### Worker (`src/simulator/engine/sim.worker.ts`) — the active-set engine
Factor the maintenance into a **shared pure module `src/simulator/engine/activeSet.ts`** so BOTH the worker AND the Node verification harness use the SAME logic (no divergence). Design:

State (allocated only when the feature is on + sync mode + gridCells):
- `emptyVal: number` (decoded via `encodeAttrValue`), `emptyAttrId`.
- `activeOffsets: Int32Array` — flat (dl,dr,dc) triples of the active-range dilation (neighbourhood coords3d ∪ origin, OR the radius sphere via `generateCoords3d`). Boundary-aware application at use time.
- `nearCount: Uint16Array(total)` — # of non-empty cells within active-range of each cell.
- `activeList: Int32Array(total)` + `activeCount` — compacted active indices for the sparse loop.
- `activeMember: Uint8Array(total)` — list membership (dedupe on append).

Helpers (pure, in `activeSet.ts`):
- `dilate(idx, delta:+1|-1, cb)` — for each offset, compute M (decode idx→coords, add offset, apply boundary: torus wrap or drop OOB for constant), `nearCount[M]+=delta`; on 0→1 call `cb(M,'add')`; on 1→0 call `cb(M,'remove')`.
- `isEmpty(attrArr, idx) => attrArr[idx] === emptyVal`.
- `rebuildFromScratch(attrArr)` — zero all; for each non-empty cell, `dilate(+1)` appending on 0→1. O(total) reads + O(nonEmpty × offsets). Called after init/reset/gridInit/loadState.
- `applyTransition(idx, wasEmpty, isEmptyNow)` — if became non-empty: `dilate(+1)` (append newly-0→1); if became empty: `dilate(-1)` (mark 0-reached stale). No-op if unchanged.
- `compact()` — rebuild activeList from `nearCount>0` (drop stale); call every N steps if `staleCount` high (monotonic models never need it).

Per-step (sync, feature on) in `runStep`:
1. Run the compiled step over `activeList[0..activeCount]` (sparse loop — see compiler).
2. For each idx in activeList: `wasEmpty = isEmpty(readAttrs, idx)` (r = pre-step) vs `isEmptyNow = isEmpty(writeAttrs, idx)` (w = post-step, pre-swap); `applyTransition(idx, wasEmpty, isEmptyNow)`. (Only active cells can transition — inactive cells aren't stepped, stay empty.)
3. Buffer swap as usual. Periodic `compact()`.

Init/reset: after defaults + `runInit` + `runGridInit` (before the first colour pass), call `rebuildFromScratch(readAttrs)`. Same after `loadState`.

Mutation handlers (paint / paintManual / importImage / writeRegion / clearRegion): after writing cells, for each written cell call `applyTransition` (so newly-non-empty cells dilate the active set). THEN recolour the WRITTEN cells specifically (targeted colour pass over the painted list — see colour pass), so painting an isolated cell always shows even if it stays "empty". Painting is never gated by the active set (writes go direct — the user requirement).

**Colour pass:** the Output Mapping colour pass runs over `activeList` when the feature is on (only active cells recolour). The full INITIAL colour pass (after init, over all cells) sets every empty cell to the empty appearance; thereafter active-only. The colour-pass fn must accept an index list (like the sparse step). Paint recolours over the painted list.

### Gating
- Feature effective ONLY when: `enabled` + `gridCells !== false` + **synchronous** update mode (async's single-buffer + shuffle order is incompatible with the active-set-over-a-list model; reject/ignore in async — surface a validation note) + a valid config. Otherwise the worker runs the normal full path (byte-identical).
- WebGPU: the active-set is a CPU concept; on the WebGPU target, IGNORE the feature for now (run full) — a GPU stream-compaction sparse dispatch is a later follow-up. Document it; do not block.

---

## Feature B — inline neighbours (drop the 2.8 GB table) — FUSED into A's sparse path

The full neighbour-index table (`buildNeighborIndices`, `total × nSz` Int32) is the memory/init blocker. **When Feature A is on, do NOT build the full table** — build the compact per-neighbourhood offset table (like WebGPU) and have the sparse-path neighbour-access emitters compute the neighbour index INLINE. This unblocks 300³ (no 2.8 GB table, no 10 s init) AND, combined with A, processes only active cells.

- **Reference implementation:** the WebGPU path already does exactly this — `nbrCellIdx(cellIdx, baseOffset, k)` in `src/modeler/vpl/compiler/webgpu/encoder.ts` (decode idx→coords, add the offset, torus-wrap / constant-sentinel, re-encode), and the compact offset upload in `src/simulator/engine/webgpuRuntime.ts` `uploadNeighborOffsets`. Port that math to the JS + WASM neighbour-access emitters as an **inline mode**.
- **Compile-context flag** `neighbourMode: 'table' | 'inline'` (default `'table'`). The neighbour-access emitters (`getNeighborsAttribute`, `getNeighborAttributeByIndex`, `getNeighborAttributeByTag`, `filterNeighbors`, `getNeighborsAttrByIndexes`, `getAllNeighborIndexes`, and any other `nIdx[...]` reader) branch on it. `'table'` mode = **byte-identical to today**. `'inline'` mode = compute from the compact offsets + grid dims + boundary. Compile with `'inline'` only when Feature A is on.
- Worker: when the feature is on, skip `buildNeighborIndices` (the big table); instead build/pass the compact offset table (per-neighbourhood dr/dc/dl) + grid dims + boundary flag as step params. When off, unchanged (table).
- This is the LARGEST + riskiest phase. Do it AFTER Phase 1/2 (A with the table) so the frontier + step speedup are already proven; then swap the neighbour source.

---

## Phased implementation (commit + VERIFY after each)

**MANDATORY verification gates (run before EVERY commit):**
- `npx tsc -b` (or `npx tsc -p tsconfig.app.json --noEmit`) clean; `npm run build` clean.
- **Byte-identity (feature OFF):** `node scripts/check-compile-identity.mjs --capture` a baseline on the CURRENT `sim_agent_fixes` HEAD BEFORE starting; after each phase, `--compare <baseline>` MUST show every library model's JS/WASM/WGSL/agent/overseer emit UNCHANGED. This is the primary safety net — the feature is opt-in, so nothing else may drift.
- **Sparse == full (feature ON):** `node scripts/verify-sparse-stepping.mjs` (NEW — see below) MUST show byte-for-byte identical grids between the full path and the sparse path on the Accretor over ≥200 steps, on JS AND WASM.
- If a gate fails, FIX before committing. Never commit a red gate.

### Phase 0 — schema + UI + cascades (no engine behaviour)
- Add the schema, LOAD_MODEL guard, ModelContext cascades, the Properties UI + validation.
- Property is read but the engine ignores it (no behaviour change yet).
- Verify: tsc/build clean; check-compile-identity byte-identical (property unused).
- **Commit:** `feat(sim): Skip Isolated Empty Cells — schema + Properties UI (no engine yet)`.

### Phase 1 — active-set engine + sparse step (JS), table still built
- `src/simulator/engine/activeSet.ts` (shared pure module) + wire into the worker (init/reset/step/paint/loadState).
- JS compiler (`compile.ts`): emit a sparse loop variant selected at runtime by an `_activeList`/`_activeCount` param (sync step + colour pass). Body identical; only the loop header + colour-pass loop differ. `buildLoopParams`/`buildLoopArgs` carry the new params (append at the end so the OFF path signature is unchanged → byte-identical).
- Sparse colour pass over the active list; targeted recolour over the paint list.
- Write `scripts/verify-sparse-stepping.mjs`: build the Accretor (via the gen script's model or a fixture), compile JS via the dev harness (`compileAll`), run N steps full vs sparse (import `activeSet.ts` for the real logic), assert byte-identical grids each step; print the active/total ratio (speedup proxy).
- Verify all gates (JS sparse==full; byte-identity off).
- **Commit:** `feat(sim): active-set engine + sparse JS step (Skip Isolated Empty Cells)`.

### Phase 2 — sparse step on WASM
- WASM compiler (`wasm/compile.ts` `emitBody`/the step loop): emit the sparse loop variant (iterate the active list) selected by the same runtime param. OFF path byte-identical (verified by check-compile-identity WASM bytes).
- Extend `verify-sparse-stepping.mjs` to compile + run WASM sparse and assert == JS == full.
- Verify all gates.
- **Commit:** `feat(sim): sparse WASM step (Skip Isolated Empty Cells)`.

### Phase 3 — inline neighbours (Feature B), drop the table when the feature is on
- Add `neighbourMode: 'table'|'inline'` to the compile context; branch every `nIdx[...]` reader (JS + WASM) — `'table'` byte-identical, `'inline'` = the WebGPU nbrCellIdx math.
- Worker: when the feature is on, skip `buildNeighborIndices`; build/pass the compact offsets + dims + boundary. Reuse WebGPU's `uploadNeighborOffsets` shape.
- Verify: sparse-inline == sparse-table == full on the Accretor (JS + WASM); byte-identity off (table mode untouched); measure 300³ init time + memory (should drop from 10 s/2.8 GB to ~fast/light).
- **Commit:** `feat(sim): inline neighbours in the sparse path — unblocks 300³ (Skip Isolated Empty Cells)`.

### Phase 4 — enable on the Accretor + bump grid + docs
- `scripts/gen-accretor.mjs`: set `skipIsolatedEmpty` (empty attr `state`, value `0`/empty, range = the Faces neighbourhood or radius 1) and bump the default grid (e.g. 120³–200³ once the step is sparse; try 300³ once Phase 3 lands — confirm smooth init + interactive FPS). Regenerate.
- Update `CLAUDE.md` (a new major section for the feature + the Accretor bullet), `README.md`, `src/help/HelpView.tsx`, `docs/NODES_REFERENCE.md` if any node text changes (none expected — this is a model-property + engine feature, no new nodes).
- Update the memory note `project_large_grid_perf` (create it) + MEMORY.md.
- Verify all gates once more; if a browser is available, do a real-worker run of the Accretor at the bumped size (asym + sym still grow + edge-stop; painting an isolated empty cell works). If headless, rely on the Node harnesses.
- **Commit:** `feat(accretor): enable Skip Isolated Empty Cells + bump grid; docs`.

### If you run low on session budget / hit the usage limit
Commit whatever phase is complete + green, then **schedule a continuation session** (same mechanism as this plan's kickoff — a one-time cron ~1 hour out) with a prompt: "Continue `docs/PLAN_LARGE_GRID_PERF.md` from the next unstarted phase on branch `sim_agent_fixes`; verify + commit each; self-schedule again if not done." STOP scheduling once Phase 4 is committed + all gates green. Do NOT leave a phase half-done and uncommitted.

---

## Safety / risk
- **Off by default + opt-in** → the ONLY models affected are ones that enable it (initially just the Accretor). Every other model is byte-identical (proven by check-compile-identity each phase). This is the primary safety net — keep the OFF path untouched (append new params at the END of signatures; branch inside emitters; never reorder existing emit).
- **Correctness** → the Node harness proves sparse==full byte-for-byte before each commit. The shared `activeSet.ts` means the harness tests the REAL worker logic.
- **Do not** touch async mode, WebGPU sparse, or the global (non-feature) neighbour emit — those stay full/table. Async + WebGPU ignore the feature (run full).
- Match the 2D/3D dual-impact rule: the active-set offsets + inline neighbours must be correct in BOTH 2D and 3D (the Accretor is 3D; also add a 2D fixture to the harness — e.g. a Game-of-Life-style empty=dead model — to prove 2D sparse==full).

## Key files
- Schema/cascades: `src/model/types.ts`, `src/model/ModelContext.tsx`.
- UI: `src/modeler/panels/PropertiesPanelContent.tsx`, `src/modeler/vpl/nodes/nodeValidation.ts` (if a badge is warranted).
- JS compiler: `src/modeler/vpl/compiler/compile.ts` (step loop ~1930–1990, `buildLoopParams` ~1285, `decodeCoordLines` ~1270, the InputColor/OutputMapping compile, `is3dModel`).
- WASM compiler: `src/modeler/vpl/compiler/wasm/compile.ts` (`emitBody`, the loop, layout).
- Worker: `src/simulator/engine/sim.worker.ts` (`runStep`, `buildLoopArgs`, `buildNeighborIndices`, `resetGrid`, `runGridInit`, `runColorPass`, paint/writeRegion/clearRegion/importImage handlers, `applySimulationState`/`loadState`).
- Inline-neighbour reference: `src/modeler/vpl/compiler/webgpu/encoder.ts` (`nbrCellIdx`), `src/simulator/engine/webgpuRuntime.ts` (`uploadNeighborOffsets`).
- Shared new: `src/simulator/engine/activeSet.ts`; harness `scripts/verify-sparse-stepping.mjs`.
- Model: `scripts/gen-accretor.mjs`. Byte-identity harness: `scripts/check-compile-identity.mjs`.

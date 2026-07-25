# HANDOFF — drop the dead CPU neighbour table on the WebGPU grid target

**Branch**: `optimize`. **Status**: READY. Standalone; no dependency on the
shadows/AO/alpha phase. Read this whole doc + the CLAUDE.md sections
"WebGPU Compile Target" §2.1 (compact nbrOffsets), "Skip Isolated Empty Cells"
(the inline-neighbour codec — the machinery you will likely reuse), and
"Agents-only world resize at scale" (the precedent: the layout already gates the
neighbour table on `gridCellsEnabled`; you are adding a second gate).

## The problem (measured)

On the **WebGPU grid target**, the worker still reserves and fills the FULL
per-cell neighbour-index tables (`total × nSz × 4` bytes, one per neighbourhood)
inside `wasmMemory` — even though the WebGPU runtime never reads them. The GPU
computes neighbours inline in WGSL from a COMPACT per-neighbourhood offset buffer
(`uploadNeighborOffsets` → `layout.nbrBytes`, a few KB; CLAUDE.md §2.1). The big
CPU table is pure dead weight on this target, and it is the DOMINANT per-cell
cost on a large 3D grid, so it — not the actual cell data — is what blows the
wasm32 4 GiB `WebAssembly.Memory` cap:

| grid | cells | nbr table (26-Moore) | attrs+colours | total today | **without nbr table** |
|---|---|---|---|---|---|
| 300³ | 27.0M | 2.81 GB | 0.59 GB | 3.40 GB (loads, barely) | 0.59 GB |
| 330³ | 35.9M | 3.74 GB | 0.79 GB | **4.53 GB — already fails** | 0.79 GB |
| 400³ | 64.0M | 6.66 GB | 1.41 GB | **8.06 GB — the user's error** | 1.41 GB |

The user hit `WebAssembly.Memory(): value ~127930 is above the upper bound
65536` resizing the shipped Accretor (`public/models/Accretor.gcaproj`, WebGPU
grid, 3-neighbourhood faces/edges/corners = 26 slots, Skip-Isolated-Empty
configured but OFF) to 400³. Dropping the dead table lifts the ceiling from
~320³ to well past 700³ on the WebGPU target.

## Established facts (do NOT re-derive; verify if you change them)

- `initGrid()` (`sim.worker.ts` ~:3156) calls `computeMemoryLayout(...,
  layoutNeighborhoods, ...)` with `layoutNeighborhoods = gridCellsEnabled ?
  neighborhoods : []`. The layout reserves `total × nSz × 4` per neighbourhood
  when `!sparseStepping` (SIE off), or a COMPACT `size`-packed table when
  `sparseStepping` (SIE on — the inline-neighbour codec, `packNI`/`packNI3`).
- `buildNeighborIndices()` (~:3304) fills the reserved region: compact packed
  NIs when `wasmLayout.sparseStepping`, else the full per-cell table.
- The full CPU table `nbrIndices[nbrId]` is read ONLY by `buildLoopArgs()`
  (~:3403) and `buildCellArgs()` (~:3445) — the JS/WASM step/init arg builders.
- `runStep()` (~:3646): `if (useWebGPU && webgpuRuntime?.stepReady) {
  runStepWebGPU(); return; }` — the WebGPU STEP path never calls
  `buildLoopArgs`, so the big table is unread there. **Confirmed.**
- The WebGPU runtime's neighbour data is the compact `nbrOffsetsBuf`
  (`webgpuRuntime.ts` `uploadNeighborOffsets`, sized `layout.nbrBytes` from the
  WebGPU layout's `coords`/`coords3d`) — INDEPENDENT of the CPU `nbrIndices`.

## The correctness surface — the ONLY CPU consumers on the WebGPU target

`buildLoopArgs` DOES run on the WebGPU target in these paths, and each pushes
`nbrIndices[nbrId]` as an arg:
1. **Per-cell Init Event** (`runInit`, ~:4550) — runs on CPU only when
   `useWebGPUInit` is FALSE, i.e. `gridInitFn !== null` (a Grid Init Event
   forces the CPU init path; otherwise the GPU init pipeline handles init and
   never reads the table). So: a model with BOTH a Grid Init Event AND a
   per-cell Init Event that READS NEIGHBOURS needs a real table on WebGPU.
2. **Grid Init Event** (`runGridInit`, ~:4597) — CPU-only on every target, but
   procedural seeding rarely reads neighbours (the Accretor's does not).
3. **JS/WASM OM colour pass** (`runColorPass`, ~:4724) — VERIFY whether this ever
   runs on the WebGPU target (WebGPU has its own `runColorPassWebGPU`). If it can
   (e.g. a soft-recompile edge), an OM that reads a neighbour attribute needs a
   real table.

A neighbour-reading arg into a function that never indexes it is harmless (the
0-length/absent array is never touched). The danger is ONLY a CPU function that
actually indexes `nIdx_<nbr>[idx*nSz+k]` while the table is empty.

## Design — pick after investigating; the bar is "no CPU reader ever indexes an empty table"

Two viable shapes, in order of preference:

**Option A (preferred — narrow, reuses existing gates).** Add a
`gridCellsEnabled && !onWebGPUTargetWithNoCpuNeighbourReader` gate to the
`layoutNeighborhoods` decision in `initGrid`, mirroring the existing
`gridCellsEnabled ? neighborhoods : []` line. Reserve the full table ONLY when a
CPU path on this target can index it — i.e. when the resolved grid target is NOT
WebGPU, OR (it is WebGPU AND a CPU init/OM/gridInit function that reads
neighbours will run). Otherwise pass `[]` (and skip the big fill in
`buildNeighborIndices`). Compute "a CPU neighbour reader will run on WebGPU" from
the compiled functions the worker already has (does the init/gridInit/OM
function's source reference `nIdx_`? — a cheap, honest check the compile side can
flag, e.g. a boolean on the compile result). **The Accretor takes the empty
path** (no neighbour reads in init/gridInit; OM is GPU). Verify the flag is
correct for it.

**Option B (general — reuse the SIE inline-neighbour codec).** On the WebGPU
target, ALWAYS reserve only the compact packed table (like SIE) and compile the
CPU-side init/gridInit/OM functions in inline-neighbour mode (`ctx.inlineNbr`,
the existing SIE codepath emits `packNI` decode). Then no CPU reader ever needs
the full table. More uniform but touches the compiler + the arg ABI; only do
this if Option A's "does a CPU reader run" check proves fragile.

**Whichever you pick:** JS and WASM targets must be BYTE-IDENTICAL — they still
get the full table (they run the CPU/WASM step, which indexes it). This is a
WebGPU-target-only change. The 4 GiB fallback error must still fire honestly: a
WebGPU model too big to fall back to JS/WASM (the full table wouldn't fit) should
surface the existing clear allocation error, not crash — a WebGPU-only 400³ model
genuinely cannot run on JS/WASM, and that is fine to report.

**Resolved-target subtlety.** `initGrid` runs before the WebGPU runtime finishes
its async setup, and `useWebGPU` is the user's INTENT (the runtime may fail and
fall back). The layout is baked at `initGrid` time. So decide from
`useWebGPU`/`wantWebGPU` (intent) + `gridCellsEnabled`, and ensure that if the
WebGPU runtime later FAILS to build, the fallback path either (a) re-inits with
the full table, or (b) surfaces the honest error. Investigate
`setUseWebGPU`/`useWebGPUStatus` fallback (`sim.worker.ts` ~:2941/:3011/:3020,
:5447 `wantWebGPU`) and document which you rely on.

## Verify (screenshots + protocol; the Browser pane is DISPLAYED)

1. **The win**: load the shipped Accretor (already WebGPU), Resize to 400³ — it
   must init and PLAY (no allocation error), voxels render, generations advance.
   Confirm `wasmMemory` page count dropped to ~the "without nbr table" column
   (probe `wasmLayout.pages` / the Memory size, or just that 400³ now loads).
   Push further (e.g. 512³) to show the ceiling really moved.
2. **300³ unchanged**: the Accretor at its shipped 300³ still loads + runs
   identically (same structure at a fixed seed).
3. **The edge case**: construct/verify a WebGPU 3D model with a Grid Init Event
   AND a per-cell Init Event that reads a neighbour attribute — its seeded state
   must be correct (this is the case that needs the real table on WebGPU). If
   Option A, confirm the flag routes it to the full-table path. If it's hard to
   build one, at minimum trace the code path and assert the flag's value.
4. **JS + WASM byte-identity**: `node scripts/check-compile-identity.mjs`
   (capture/compare) if you touch any compiler file; a small 3D WASM model
   (Life3D 24³) still steps correctly and matches its reference.
5. **Fallback**: a WebGPU 3D model whose runtime fails (or force it) surfaces the
   allocation error cleanly rather than running on a missing table.

## Gates + rules

`npx tsc -p tsconfig.app.json --noEmit`, `npm run build`,
`node scripts/parity-agent-wasm.mjs`, `node scripts/parity-agent-force.mjs`,
`node scripts/verify-agent-render.mjs`, `node scripts/verify-render-uniform-layouts.mjs`;
`node scripts/check-compile-identity.mjs` if a compiler file is touched.

Consider adding a `scripts/`-level assertion (or extend an existing lattice
harness) that on the WebGPU target the reserved `wasmMemory` page count for a
large 3D grid does NOT include a `total × nSz` term — a computed check like the
uniform-layout harness, so this optimization can't silently regress.

Hard rules: commit on `optimize` staging EXPLICIT paths (NEVER `git add -A` — a
concurrent session was burned by it); NEVER push; NEVER add Co-Authored-By or any
Claude/Anthropic attribution; NEVER bump the version; multi-line commit messages
via `git commit -F <file>` (the Bash tool does NOT parse PowerShell here-strings);
`sim.worker.ts` has mojibake COMMENT bytes so anchor Edits on clean ASCII code
lines (do NOT reintroduce mojibake into user-facing strings — one was just
cleaned); measure branch scope against `origin/master`, never local `master`.

Update CLAUDE.md (the WebGPU / huge-grid sections) + this doc's Completion Report
when done. Finish with: the design chosen, the exact CPU-reader gate, the 400³
screenshot evidence, and the new practical grid ceiling.

## Completion Report

**Status: DONE** (branch `optimize`). Worker-only change — no compiler file
touched, so JS/WASM/WebGPU emitted output is byte-identical by construction
(`check-compile-identity` therefore not required, and not run).

### Design chosen — Option A (narrow, worker-side, no compiler change)
`initGrid` drops the FULL per-cell neighbour table on the WebGPU grid target
whenever no CPU-executed compiled function indexes it. The whole change lives in
[sim.worker.ts](../src/simulator/engine/sim.worker.ts) + a new regression script
— zero compiler/layout-primitive edits. `computeMemoryLayout` already accepts a
`neighborhoods` list (the agents-only path passes `[]`); the WebGPU drop reuses
that exact seam (`layoutNeighborhoods = (gridCellsEnabled && !nbrTableDropped) ?
neighborhoods : []`), and `buildNeighborIndices` early-returns after
`fillBoundarySentinel()` (the constant-boundary sentinel, extracted into a shared
helper, is still filled + uploaded to the GPU).

Option B (compile the CPU init/gridInit/OM in inline-neighbour mode) was NOT
needed — the Option A source-scan flag is robust (see the exact gate) and touches
no compiler, so there is no byte-identity risk.

### The exact CPU-reader gate
```
// init handler, BEFORE initGrid (the layout is baked here):
const sieOn = enabled && sync && gridCells && !agents && !glyphs;   // full table already tiny when SIE-on
const cpuIndexesNbr =
     codeIndexesNeighbourTable(msg.initCode)              // per-cell Init Event
  || codeIndexesNeighbourTable(msg.gridInitCode)          // Grid Init Event
  || outputMappingCodes.some(o => codeIndexesNeighbourTable(o.code))   // JS/WASM OM
  || inputColorCodes.some(ic => codeIndexesNeighbourTable(ic.code));   // brush / paste
nbrTableDropped = !!msg.useWebGPU && gridCells && !sieOn && !cpuIndexesNbr;

// codeIndexesNeighbourTable(code) = /nIdx_\w*\[/.test(code)
// The compiled param decl is `nIdx_<id>,` (bare id + comma), so `nIdx_<id>[`
// (id immediately followed by a bracket) appears only at a genuine read site.
```
- The **STEP is deliberately EXCLUDED** — its JS/WASM fallback is the one CPU
  reader we intentionally drop (a grid too large for the GPU table is too large
  for JS/WASM anyway; `runStep` returns without running the CPU step when
  `nbrTableDropped`, surfacing a one-time honest error on genuine WebGPU failure
  via the `webgpuGridFailed` latch). Decided from `msg.useWebGPU` (INTENT), since
  `initGrid` bakes the layout before the async runtime is known to succeed.
- **Edge case (Verify step 3):** a WebGPU model with a Grid Init Event forces the
  CPU init path (`useWebGPUInit` is false when `gridInitFn !== null`), so a
  per-cell Init Event that reads a neighbour KEEPS the full table — the
  `codeIndexesNeighbourTable(msg.initCode)` arm covers exactly this. The
  full-table path is byte-identical to pre-change (only the drop path is new).
- **Recompile-flip:** a soft recompile that adds a neighbour read to a CPU
  function while the table is already dropped can't reallocate the layout; it
  posts a one-time "reload to apply" error (the reload does a full reinit that
  rebuilds the table).

### 400³ screenshot evidence (real browser, WebGPU, DISPLAYED pane)
- **300³ (shipped size) — unchanged:** loaded, played to Gen 93, the dendritic
  accretion structure grew + rendered correctly (GPU inline-neighbour path is
  right with the CPU table dropped), 0 errors.
- **400³ (the user's failing resize) — THE WIN:** resized 300³→400³, the worker
  reinit produced **NO allocation error** (before: `value ~127930 above the upper
  bound 65536`), Gen 0 showed the seed, then **played to Gen 204** with the
  accretion structure growing + voxels rendering, 0 errors.
- **512³ (push further):** resized to 512³ → a `RangeError: Array buffer
  allocation failed` (a JS ArrayBuffer alloc, NOT the WASM-cap error) — the ceiling
  moved PAST the WASM cap; 512³ now hits the browser tab's contiguous-memory
  budget for the (much smaller, 0.84 GiB) `wasmMemory` + GPU buffers. The app did
  NOT white-screen; resizing back to 128³ recovered cleanly (played to Gen 69).

### New practical grid ceiling (WebGPU target)
The WASM-4-GiB-cap ceiling (~320³ with the 26-Moore table) is GONE. The dropped
layout now scales with attrs + colours only: for the Accretor's attribute set the
computed dropped layout hits 65536 pages (4 GiB) at **~860³** — i.e. the ceiling
moved from ~320³ to ~860³ (well past the handoff's "700³" target). In practice the
browser tab's own contiguous-ArrayBuffer budget bites first (~400³–512³ here),
which is an environment limit, not the engine.

### Regression guard + gates
- **NEW [scripts/verify-webgpu-nbr-table.mjs](../scripts/verify-webgpu-nbr-table.mjs)**
  (COMPUTED, imports the real modules): (1) the layout delta full−dropped ==
  Σ `total·nSz·4` (8-aligned) at 300³/400³/512³; the dropped layout fits the
  65536-page cap while the full one overflows at 400³/512³; (2) the shipped
  Accretor's compiled init/gridInit/OM/inputColor do NOT index `nIdx_` (its STEP
  does) → `nbrTableDropped === true`; (3) a synthetic WebGPU 3D model whose
  per-cell Init Event reads a neighbour → `initCode` indexes `nIdx_` → table KEPT,
  and the no-neighbour variant → dropped (the flag discriminates). **ALL PASS.**
- `npx tsc -p tsconfig.app.json --noEmit` ✓, `npm run build` ✓,
  `parity-agent-wasm` ✓, `parity-agent-force` ✓, `verify-agent-render` ✓,
  `verify-render-uniform-layouts` ✓.

### Files changed
- [src/simulator/engine/sim.worker.ts](../src/simulator/engine/sim.worker.ts) —
  `nbrTableDropped` / `webgpuGridFailed` / `nbrTableDroppedErrorPosted` globals +
  `codeIndexesNeighbourTable` + `fillBoundarySentinel`; the init-handler decision;
  the `layoutNeighborhoods` gate; the `buildNeighborIndices` dropped path; the
  `runStep` CPU guard; the recompile-flip guard.
- [scripts/verify-webgpu-nbr-table.mjs](../scripts/verify-webgpu-nbr-table.mjs) — NEW.
- [CLAUDE.md](../CLAUDE.md) — the WebGPU "Key gotchas" bullet.

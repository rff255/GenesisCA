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
(fill in when executed)

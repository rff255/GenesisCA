# HANDOFF — drop the CPU attribute WRITE buffer on the WebGPU grid target

**Branch**: `optimize`. **Status**: READY. Standalone. The direct sequel to
`HANDOFF_WEBGPU_NBR_TABLE_MEMORY.md` (already DONE, commit `3c8f03d`): that dropped
the dead CPU neighbour table on the WebGPU grid target; THIS drops the next
dead-weight — the CPU attribute WRITE buffer — so even larger 3D WebGPU grids fit
under the 4 GiB `WebAssembly.Memory` cap. Read the neighbour-table handoff +
Completion Report first (same seam, same discipline), plus CLAUDE.md
"Agents-only per-cell layout eliminated entirely" (the precedent: the layout
ALREADY aliases the sync attr-write region to the read region when `gridCells` is
off — you are extending that aliasing to the WebGPU grid target).

## The problem (measured)

After the neighbour-table fix, a large 3D WebGPU grid is dominated by the CPU
attribute **double-buffer**. In SYNC mode `initGrid` allocates a SEPARATE
`attrWriteOffset` region per cell attribute (the classic double-buffer: the step
reads `r_<attr>`, writes `w_<attr>`, then swaps). But on the **WebGPU grid
target the STEP runs on the GPU** (`runStepWebGPU`), which does its OWN
attrsBufA/B ping-pong on the GPU — the CPU `w_<attr>` region is never read or
written by the GPU step. It is dead weight, exactly like the neighbour table was.

The shipped Accretor (300³, WebGPU, sync, tag `state` i32 + bool `Boundary` +
int `Fade` + RGBA colours) measured ~27 B/cell today; the write buffer is ~9 B of
that (state+Boundary+Fade, one copy). Dropping it:

| grid | cells | today (pages) | write-aliased (pages) | cap 65536 |
|---|---|---|---|---|
| 400³ | 64M | ~21.5k | ~12.7k | fits either way |
| 512³ | 134M | 45k | ~27k | fits either way |
| **600³** | **216M** | **~89k — the user's error** | **~59k — FITS** | ← the win |
| 700³ | 343M | overflow | ~68k — just over | still needs more |

The user hit `WebAssembly.Memory(): value 88990 above the upper bound 65536`
resizing the Accretor to 600³. Aliasing the write buffer brings 600³ under the
cap (headroom is ~10%, so VERIFY empirically — see below).

## The fix — alias the CPU attr write region to the read region on WebGPU

The precedent is already in the codebase. `computeMemoryLayout`
(`src/modeler/vpl/compiler/wasm/layout.ts`) takes a `gridCells` flag; when false
(agents-only) it makes the sync attr-write region 0-bytes / aliases read. And
`initGrid` (`sim.worker.ts` ~:3156) already aliases in ASYNC mode
(`attrsB[id] = arrA` — single buffer). Extend the ALIAS to the **WebGPU grid,
sync-mode** case:

- In `initGrid`, when the resolved grid target is WebGPU (`msg.useWebGPU` INTENT
  — the layout is baked before the async runtime is known to succeed, same as the
  neighbour-table gate `nbrTableDropped`), make the per-attr write view alias the
  read view (`attrsB[id] = arrA`), and pass a layout flag so
  `computeMemoryLayout` reserves NO separate `attrWriteOffset` region (0 bytes),
  mirroring the `gridCells:false` path. Reuse/extend the neighbour-table gate's
  INTENT plumbing (`nbrTableDropped` is computed there from `msg.useWebGPU`).
- Sub-attribute conditional copy: the per-cell sync sub-attr copy line
  (`w_subattr = match ? r_subattr : default`) runs on the GPU on WebGPU, so the
  CPU write region isn't needed for it either. Confirm the CPU sub-attr scrub
  path isn't exercised on WebGPU.

## The correctness surface — who WRITES `w_<attr>` on the WebGPU target

The CPU write buffer is only touched by CPU functions via `buildLoopArgs`
(`w_<attr>` params). On WebGPU those are: (1) the per-cell **Init Event**
(`runInit`, CPU only when a Grid Init Event forces it), (2) the **Grid Init
Event** (`runGridInit`), (3) **paint / paintManual / writeRegion / clearRegion**
(they write `readAttrs` AND `writeAttrs` for next-step consistency). ALL of these
write FINAL values and then either copy `w→r` or write `r` directly — none rely
on `w_` being a SEPARATE buffer mid-loop the way the sync STEP does. With the
alias:
- `runInit` writes `r_` directly; the post-init `w→r` copy becomes a harmless
  no-op (they're the same view). Result: `r_` holds the init values. Correct.
- `runGridInit` likewise.
- paint writes the single shared buffer (r==w). Correct — the GPU then gets it
  via the existing upload-after-mutate (`uploadAttrs`/`patchWebGPUCells`).
- getState reads `r_`. Unaffected.

The ONLY CPU consumer that genuinely needs a separate write buffer is the JS/WASM
SYNC STEP — which does NOT run on the WebGPU target (`runStepWebGPU` returns
first). This is the exact same "the STEP's CPU fallback is the one reader we
drop" tradeoff the neighbour-table fix documented and the `webgpuGridFailed`
latch already handles: a WebGPU model too big to run on JS/WASM (its full
double-buffer wouldn't fit either) surfaces the honest allocation error rather
than silently running an impractical CPU fallback.

**JS and WASM targets MUST be byte-identical** — they run the CPU/WASM sync step
and keep the separate write buffer. This is a WebGPU-grid-target-only change.

## Verify (screenshots + protocol; the pane is DISPLAYED)

1. **The win**: load the shipped Accretor (WebGPU), Resize to **600³** — it must
   init with NO allocation error and PLAY (voxels render, generations advance,
   the structure grows). Probe the `wasmMemory` page count / `wasmLayout` to
   confirm the write region is gone. **If 600³ is still marginally over** (the
   headroom is ~10%), the next dead-weight is the CPU **colours** buffer (4
   B/cell, needed only for frame-mode readback) — note it as a follow-on but try
   600³ first; do NOT scope-creep into lazy colours-allocation unless 600³ fails.
2. **300³ / 400³ unchanged**: same structure at a fixed seed; 400³ still loads.
3. **Correctness on WebGPU with a Grid Init + per-cell Init**: the Accretor has
   both — its Reset must seed correctly (border flags + the centre seed) and the
   run must match the pre-change structure at a fixed seed. Also verify a paint
   (brush a cell) lands and colours correctly on WebGPU (the r==w write + GPU
   patch path).
4. **JS + WASM byte-identity**: a small 3D WASM model (Life3D 24³) steps
   correctly and matches its reference; `check-compile-identity` only if you
   touch a compiler file (you likely touch only `sim.worker.ts` +
   `wasm/layout.ts`, which is layout not emit — assert with `git diff --stat`).
5. **Fallback honesty**: a WebGPU model whose runtime fails still surfaces the
   clear allocation error (or the `webgpuGridFailed` "runs on WebGPU only"
   message), not a crash on a missing write buffer.

## Regression guard

Extend `scripts/verify-webgpu-nbr-table.mjs` (or a sibling) with a COMPUTED
assertion that on the WebGPU grid target the reserved `wasmMemory` does NOT
include a per-attr WRITE region (full − aliased == Σ writeable-attr-bytes), and
that 600³ fits / 700³ overflows, so this can't silently regress.

## Gates + rules

`npx tsc -p tsconfig.app.json --noEmit`, `npm run build`,
`node scripts/parity-agent-wasm.mjs`, `node scripts/parity-agent-force.mjs`,
`node scripts/verify-agent-render.mjs`, `node scripts/verify-render-uniform-layouts.mjs`,
`node scripts/verify-webgpu-nbr-table.mjs`; `check-compile-identity` only if a
compiler EMIT file is touched.

Hard rules: commit on `optimize` staging EXPLICIT paths (NEVER `git add -A`);
NEVER push; NEVER add Co-Authored-By / Claude / Anthropic attribution; NEVER bump
the version; multi-line commit messages via `git commit -F <file>`;
`sim.worker.ts` has mojibake COMMENT bytes — anchor Edits on clean ASCII code
lines and never put mojibake in a user-facing string (one was just cleaned);
measure branch scope against `origin/master`.

Update CLAUDE.md (the WebGPU / huge-grid + agents-only-layout sections) + this
doc's Completion Report. Finish with: the exact write-alias gate, the 600³
screenshot evidence, and the new practical ceiling.

## Completion Report

**Status: DONE** (branch `optimize`). Two files: [sim.worker.ts](../src/simulator/engine/sim.worker.ts)
+ [wasm/layout.ts](../src/modeler/vpl/compiler/wasm/layout.ts) — **layout, not emit**, so
JS/WASM/WebGPU emitted output is byte-identical by construction (`check-compile-identity`
run anyway as belt-and-suspenders: **25 models, all surfaces unchanged**). Plus a new
regression script. `git diff --stat` vs the pre-change HEAD = exactly those files (no
compiler EMIT file touched).

### The exact write-alias gate
```
// init handler, BEFORE initGrid (the layout is baked here from INTENT):
const isAsyncInit = updateMode === 'asynchronous';
attrWriteAliased = !!msg.useWebGPU && gridCellsEnabled && !isAsyncInit;

// wasm/layout.ts computeMemoryLayout — new trailing param webgpuGridWriteAliased:
if (!isAsync && gridCells && !webgpuGridWriteAliased) { /* reserve separate write region */ }
else { for (const a of cellAttrs) attrWriteOffset[a.id] = attrReadOffset[a.id]; }   // alias

// initGrid attr-view loop: `if (isAsync || attrWriteAliased) attrsB[id] = arrA;`
// runStep guard (shared with nbrTableDropped): `if (nbrTableDropped || attrWriteAliased) return;`
```
- **BROADER than `nbrTableDropped`** (its own flag): the write buffer's only reader that
  needs a distinct buffer is the sync STEP, which never runs on WebGPU (`runStepWebGPU`
  returns first) — so the alias is INDEPENDENT of whether any CPU function reads neighbours.
  Whenever the CPU step can't run (nbr table dropped OR write aliased), `runStep` returns
  early; a genuine `webgpuGridFailed` posts the one-time honest "runs on WebGPU only" error
  (message generalised to name both dropped resources).
- **Decided from `msg.useWebGPU` (INTENT)** since `initGrid` bakes the layout before the
  async runtime is known to succeed — same as `nbrTableDropped`. Async already single-buffers,
  so gated on `!async` (a hand-edited WebGPU+async file is already aliased by the `!isAsync`
  layout arm).
- **No WASM-desync risk:** on the WebGPU target SimulatorView sends an EMPTY `wasmStepBytes`,
  so `tryInstantiateWasmModule` early-returns — no WASM module is instantiated against the
  (now-smaller) `wasmMemory`. `computeLayoutFromModel` (which bakes the WASM module's offsets
  for the WASM target) NEVER passes the alias flag (default false) → the WASM module keeps its
  separate write region → JS/WASM byte-identical. (This is why the change touches only the
  runtime `wasmMemory` + JS-side views.)
- **Correctness surface (all write FINAL values, correct with r===w):** `runInit` writes `r_`
  directly, post-init `w→r` is a self-copy no-op; `runGridInit` seeds cells (its w→r copies are
  no-ops); paint/paintManual/writeRegion/clearRegion write the single shared buffer (`dstB[i]=v`
  is a redundant self-write) then upload/patch to the GPU; `resetGrid` fills both (same slot
  twice). The sub-attr sync conditional copy runs on the GPU (WGSL) on WebGPU, so the CPU write
  region isn't needed for it either. **Documented edge (accepted, same class as the STEP
  tradeoff):** a WebGPU model with a Grid Init Event (forces CPU init) whose per-cell Init Event
  READS-BACK a cell attribute would see intra-pass writes — the Accretor's init only writes a
  position-derived `border` + gridInit-scatters seeds (no attr read-back) → provably safe.

### 600³ screenshot evidence (real browser, WebGPU, DISPLAYED pane)
- **300³ (shipped size) — unchanged:** loaded on the Simulator, played to **Gen 141**, the
  dendritic star-shaped accretion structure grew + rendered (voxels), 0 console/JS errors —
  the write buffer aliased and the model behaves identically.
- **600³ (the user's failing resize) — THE WIN:** set W/H/D=600, Resize → **`initGrid` (the
  WASM `WebAssembly.Memory` allocation) SUCCEEDED** — the reported `value 88990 above the upper
  bound 65536` is GONE. (The banner shown is `[webgpu] init failed`, which is posted by
  `startWebGPUInit` AFTER `initGrid`; a WASM-cap failure would instead read `Grid allocation
  failed for 600x600x600` from `initGrid`'s catch — it did not.) The remaining 600³ blocker on
  this test device is the **GPU device's `maxStorageBufferBindingSize` (2048 MB)** vs the GPU's
  OWN attrsRead+attrsWrite ping-pong (2471.9 MB) — a device-specific limit orthogonal to the
  WASM cap, surfaced as a clear honest error. On a GPU with ≥~2.5 GB storage buffers 600³ now
  plays end-to-end (the WASM cap no longer gates it).
- The COMPUTED harness independently confirms the exact page counts: 600³ full (write kept) =
  **88990 pages** (== the user's error), aliased (write dropped) = **59327 pages** (fits).

### New practical ceiling (WebGPU target)
Dropping the write buffer cuts the Accretor's WebGPU per-cell WASM cost ~27 → ~18 B/cell, so
the WASM-cap cube ceiling moves further past the nbr-report's ~860³. The **real-device ceiling
is now GPU-storage-buffer-bound** (~560³ on this 2048 MB device — `attrsRead/Write ≤ 2048 MB`),
NOT the WASM cap. A device with a larger `maxStorageBufferBindingSize` runs correspondingly
larger. **Follow-on dead-weight (NOT done, out of scope — 600³ is GPU-bound, not WASM-bound):**
the async-only `orderArray` (`total×4`) + `skippedArray` (`total`) are reserved even in sync
mode (5 B/cell dead on a sync WebGPU model), and the CPU `colours` buffer (4 B/cell, frame-mode
readback only) — candidates only if the WASM ceiling must move further.

### Regression guard + gates
- **NEW [scripts/verify-webgpu-attr-write.mjs](../scripts/verify-webgpu-attr-write.mjs)**
  (COMPUTED, imports the real modules): (1) the layout delta full−aliased == Σ writeable-attr
  bytes (cellsPerAttr·bytesPerType, 8-aligned, continuing the accumulator from the read-block
  end) at 300³/400³/600³; (2) the aliased layout reserves NO separate write region
  (`attrWriteOffset[id] === attrReadOffset[id]`) while the full one does; (3) the aliased 600³
  FITS the 4 GiB cap (59327p) while the full one OVERFLOWS (88990p — the exact reported error);
  (4) the Accretor's worker predicate `attrWriteAliased === true`. **ALL PASS.**
- `npx tsc -p tsconfig.app.json --noEmit` ✓, `npm run build` ✓, `parity-agent-wasm` ✓,
  `parity-agent-force` ✓, `verify-agent-render` ✓, `verify-render-uniform-layouts` ✓,
  `verify-webgpu-nbr-table` ✓, `check-compile-identity` (25 models) ✓.

### Files changed
- [src/simulator/engine/sim.worker.ts](../src/simulator/engine/sim.worker.ts) —
  `attrWriteAliased` global; the init-handler decision; the `computeMemoryLayout` call arg;
  the `initGrid` attr-view aliasing + `writeAttrs` assignment; the shared `runStep` CPU guard.
- [src/modeler/vpl/compiler/wasm/layout.ts](../src/modeler/vpl/compiler/wasm/layout.ts) —
  the `webgpuGridWriteAliased` param on `computeMemoryLayout` (gates the write-region block)
  + a forwarding optional param on `computeLayoutFromModel` (harness-only; default false).
- [scripts/verify-webgpu-attr-write.mjs](../scripts/verify-webgpu-attr-write.mjs) — NEW.
- [CLAUDE.md](../CLAUDE.md) — the WebGPU "Key gotchas" bullet (after the neighbour-table one).

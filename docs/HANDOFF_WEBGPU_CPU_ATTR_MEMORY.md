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
(fill in when executed)

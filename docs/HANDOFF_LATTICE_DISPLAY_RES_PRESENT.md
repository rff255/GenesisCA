# HANDOFF — display-resolution GPU present for GRID-ONLY 2D WebGPU models

**Branch**: `optimize`. **Status**: ⛔ **WITHDRAWN — DO NOT EXECUTE / DO NOT
RE-EXECUTE.** Shipped as `7fd8f37`, then REVERTED in `b2e544b` (2026-07-27)
after the user's stable A/B against v1.28.0 showed a THROUGHPUT REGRESSION at
high gens/frame on their GPU (G/F=50: 2300 → 1600 g/s; G/F=100: 2500 → 2000)
plus a structural ~5-frame interaction lag (the camera became a main→worker
round-trip; the base applies it INSTANTLY on the main thread, matching the
JS/WASM targets). The premise (a costly main-thread `drawImage` scale of the
grid-sized canvas) was never verified and measured ~0.002 ms at 1000². The
per-batch cost on the WebGPU grid is dominated by the PRESENT/FENCE vsync
coupling, which is DRIVER-controlled — see the failed-decoupling record below
before attempting anything in this area again. E2 (grid+agents composite,
`974eba1`) is NOT withdrawn: it rides the agent-residency present path and the
user verified it smooth; the revert moved its shader back inline.

## ⚠️ Failed follow-up experiments (2026-07-27) — recorded so they are not re-tried blindly

Two attempts to decouple the present from the per-batch backpressure fence
(the "agent-grade" pattern) were implemented and A/B-measured, and NEITHER
demonstrated improvement; both were reverted uncommitted:

1. **Present deferred past the batch fence** (colour pass in the fence, present
   submitted after the await): NO improvement — `onSubmittedWorkDone` is
   queue-global, so the deferred present simply lands inside the NEXT batch's
   fence (in-order queue). Measured slightly worse (extra submit + phase).
2. **One-deep pipeline** (await the PREVIOUS batch's boxed bare-fence, bounded
   queue depth 1; real readbacks stay synchronous): measured worse-to-neutral.
   Working theory: with two presents potentially outstanding,
   `getCurrentTexture` can block the worker thread on swap-chain depth. NB
   `return promise` inside an async function AWAITS it — a deferred fence must
   be BOXED (`{ fence }`) or the stall silently returns.

**Measurement caveat that gates any retry:** the test box's throughput drifted
±40% between SAME-condition runs minutes apart (650 → 400 g/s, zero changes),
so sequential absolute comparisons there are unreliable — exactly the master
handoff §0.7 trap ("interleaved A/B; never quote an absolute"). Any future
attempt needs a stable rig: in-worker `performance.now` probes, interleaved
A/B, many repetitions — and should validate on the USER's machine, whose base
overhead is already small (~2500 g/s at G/F=100 = ~5 ms/batch fixed).

The original (now-withdrawn) plan follows for reference. This is the
GRID-ONLY sibling of the E2 composite (`974eba1`), unifying how the two paths
present so a lattice-only model and a lattice+agents model render the SAME way.
Read first: CLAUDE.md "E2 — single-canvas composite render" (the display-res
grid-plane shader you REUSE) + [HANDOFF_E2_DISPLAY_RES_COMPOSITE.md](HANDOFF_E2_DISPLAY_RES_COMPOSITE.md)
(its Completion Report describes `GRID_PRESENT_WGSL` + `GridPlaneView` in
`agentWebgpuRuntime.ts`), and the grid direct-render path in `webgpuRuntime.ts`
(`presentShaderSource`/`presentColors`, `setupDirectRender`, `presentToCanvas`,
`dispatchColorPassAndPresent`, `directRender`).

## The problem (confirmed from the code)

A grid-only 2D WebGPU model direct-renders via the `presentColors` COMPUTE shader,
which maps canvas pixel `(gid.x, gid.y)` DIRECTLY to `cellIdx = gid.y*dim.x+gid.x`
— i.e. **the OffscreenCanvas is GRID-sized (W×H)**, and the main thread
`drawImage`-SCALES that grid-sized canvas to the viewport with the zoom/pan
transform every frame (`draw()` in SimulatorView). At a large grid (2000²+) that
main-thread scale of a big canvas is the dominant per-frame cost the L2 probe
found (~330 ms/frame at 2000²). E2 already solved the identical problem for
grid+agents by presenting at DISPLAY resolution GPU-side; grid-only was left on
the old path. **The user's call: unify them — consistency between lattice and
lattice+agents is worth it regardless of the exact ms.** (Measurement skipped by
the user's explicit decision.)

## The fix — reuse E2's display-res grid-plane present for grid-only

Replace the grid runtime's grid-resolution compute present with a
**DISPLAY-resolution, camera-aware grid-plane RENDER present** — the SAME shader
logic E2 shipped (`GRID_PRESENT_WGSL`: a fullscreen triangle whose FS inverts the
camera per display pixel → `col=floor(wx)`, `row=floor(wy)` → samples `colorsBuf`
NEAREST → crisp CA blocks). Concretely:

- **Share the shader.** Extract/export E2's `GRID_PRESENT_WGSL` + the
  `GridPlaneView` uniform + its writer to a shared module (or export from
  `agentWebgpuRuntime.ts`) and use it from the GRID runtime (`webgpuRuntime.ts`)
  too. Behavioral consistency (same crisp-cell look, same camera math) is the
  goal — do NOT fork a second copy of the cell-sampling logic.
- **Grid runtime present becomes display-res.** `setupDirectRender` configures
  the canvas at DISPLAY-pixel size (not W×H) as a RENDER_ATTACHMENT; the present
  becomes the grid-plane render pass into that display-sized canvas. `colorsBuf`
  is the same source (bind it read-only in the FS).
- **2D grid camera (main → worker).** The main thread currently owns zoom/pan (in
  `draw()`'s `drawImage`). Add a 2D grid camera message (mirror the voxel
  `setGridCamera` / agent `setAgentCamera`: scalePx/oxPx/oyPx + torus + showGrid),
  rAF-coalesced + deduped; the worker re-presents on camera change AND on every
  colour refresh (step tail, mutation tail, viewer switch, reset — everywhere
  `dispatchColorPassAndPresent` runs today).
- **Main thread blits 1:1.** `draw()` for a grid-only 2D WebGPU model blits the
  DISPLAY-sized canvas 1:1 (no more `drawImage`-scaling a grid-sized canvas);
  gridlines/brush-cursor overlay on top as today. Re-attach on a real display-size
  change (the A1/voxel attach discipline — transferred canvas dims are fixed).

## Gate + fallbacks

Enable for: **2D + WebGPU grid + NO agents + OffscreenCanvas** (the current 2D
direct-render set). Everything else unchanged: JS/WASM grid, 3D (the voxel
renderer), agent models (A1/A2/E2), a non-OffscreenCanvas browser → the existing
paths. **Glyph models**: glyphs are a MAIN-THREAD overlay drawn on the display
canvas after the blit, so a display-res present should keep them working — VERIFY
a glyph 2D WebGPU model; only exclude glyphs from this path if they actually break.

## What MUST NOT regress (these are decoupled from the display present — keep it so)

- **Recording** builds frames from the grid `colorsBuf` (grid resolution, 1px=1cell
  — CLAUDE.md: direct render ships colours while the recording flag is set), NOT
  from the display canvas. Keep that — do NOT record the display-res canvas (CA
  recordings want native grid resolution). Confirm a recording is still grid-res.
- **Screenshot** is already display-res (documented) — unchanged.
- **Paint / brush / writeRegion / inspect** read/patch `colorsBuf`/attrs
  (readback or GPU patch), independent of the display present — a paint just
  re-presents through the new path. Verify paint lands + colours correctly and the
  cell inspector still reads the right cell.
- **Pan / zoom** must track live (that's the whole point — the camera now drives
  the GPU present); a viewer-mapping switch re-presents.

## Consistency note (the user's actual goal)

After this, grid-only and grid+agents both present the grid via the SAME
display-res grid-plane shader. If a clean single shared present path falls out
(grid-only = grid plane; grid+agents = grid plane + agent discs), take it — but do
NOT risk regressing the working E2 path to force a refactor; reusing the shader
source is the required bar, a unified present is a bonus. Note any deeper
unification opportunity in the Completion Report.

## Verify (screenshots REQUIRED; the pane is DISPLAYED)

1. **Large grid** (Game of Life or Coagulation on WebGPU, resized 2000²+): the
   display shows crisp CA cells at any zoom; pan/zoom track live; the main thread
   no longer scales a grid-sized canvas (the display canvas is display-sized —
   confirm via the DOM canvas dims + that `draw()` blits 1:1). A worker trace or a
   frame-time read showing the per-frame main-thread cost dropped is a plus but not
   required (measurement was descoped).
2. **Small grid** (300²): unchanged look; crisp cells; paint/brush/inspect work.
3. **Recording** a grid-only WebGPU model produces GRID-resolution frames (not
   display-res).
4. **Glyph** 2D WebGPU model: glyphs still overlay correctly (or excluded if
   broken — say which).
5. **Fallbacks unchanged**: JS/WASM 2D grid (its own path), 3D (voxel render),
   agent models incl. **E2 grid+agents composite UNREGRESSED** (Chemotaxis/
   GoL+Boids still crisp + no readback), agents-only Boids.
6. Viewer-mapping switch + reset re-present correctly.

Flag the composited-pixel eyeball for the user; screenshot the crisp-at-zoom large
grid yourself as the pass/fail.

## Gates
`npx tsc -p tsconfig.app.json --noEmit`, `npm run build`,
`node scripts/parity-agent-wasm.mjs`, `node scripts/parity-agent-force.mjs`,
`node scripts/verify-agent-render.mjs`, `node scripts/verify-render-uniform-layouts.mjs`
(GridPlaneView is already registered — keep it green; the vec3 align-16/size-12
§10 trap applies to any struct edit). No compiler files expected — assert with
`git diff --stat`; if a compiler file is touched, run `check-compile-identity`.

## Hard rules
Commit on `optimize` staging EXPLICIT paths (NEVER `git add -A`); NEVER push;
NEVER add Co-Authored-By / Claude / Anthropic attribution; NEVER bump the
version; multi-line commit messages via `git commit -F <file>`; `sim.worker.ts`
mojibake comment bytes — anchor Edits on clean ASCII code lines, never a user-
facing mojibake string; measure branch scope against `origin/master`.

Update CLAUDE.md (the WebGPU direct-render / E2 sections — note grid-only now
shares the display-res present) + this doc's Completion Report. Finish with the
large-grid crisp-at-zoom screenshot + confirmation the E2 path is unregressed.

## Completion Report
(fill in when executed)

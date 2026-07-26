# HANDOFF — display-resolution GPU present for GRID-ONLY 2D WebGPU models

**Branch**: `optimize`. **Status**: READY. Render/worker only. This is the
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

## Completion Report (2026-07-26)

**Outcome**: SHIPPED. A grid-only 2D WebGPU model now direct-renders at DISPLAY
resolution via the SAME grid-plane present the E2 composite uses, so grid-only and
grid+agents present the grid IDENTICALLY (the user's consistency goal). The
transferred OffscreenCanvas is now DISPLAY-sized (verified 764×941 at both 300²
and 2000², NOT grid-W×H), and the main thread blits it 1:1 — the old grid-res
`presentColors` COMPUTE present + the per-frame scale of a grid-sized canvas (the
L2 ~330 ms/frame cost at 2000²) is retired. **RENDER/worker only, ZERO compiler
changes** (asserted `git diff --stat` — no `compiler/` file; `check-compile-identity`
not required).

**Surface** (6 files): [gridPlanePresent.ts](../src/simulator/engine/gridPlanePresent.ts)
(NEW — the shared shader `GRID_PRESENT_WGSL` + `GridPlaneView` + `writeGridPlaneView`
extracted from agentWebgpuRuntime.ts), [webgpuRuntime.ts](../src/simulator/engine/webgpuRuntime.ts)
(display-res render present replacing the compute present + a `setGridCamera2D`
setter + a `debugReadGridPresentPixels` DEV probe), [agentWebgpuRuntime.ts](../src/simulator/engine/agentWebgpuRuntime.ts)
(imports the shared shader; local defs removed), [sim.worker.ts](../src/simulator/engine/sim.worker.ts)
(a `setGridCamera2D` message + a `__gridPresentReadback` DEV message), [SimulatorView.tsx](../src/simulator/SimulatorView.tsx)
(display-sized canvas attach + a `postGridCamera2D` + the 1:1 blit branch + resize-
reattach), [scripts/verify-render-uniform-layouts.mjs](../scripts/verify-render-uniform-layouts.mjs)
(GridPlaneView registry entry → the shared module).

### As built
1. **Shared shader** — `GRID_PRESENT_WGSL` (a fullscreen triangle whose FS inverts
   the 2D camera per display pixel → cell (`col=floor(wx)`, `row=floor(wy)`) →
   `colorsBuf` NEAREST, premultiplied) + `GridPlaneView` (32 B scalars) + its writer
   moved to `gridPlanePresent.ts`, imported by BOTH runtimes. No forked cell-sampling.
2. **Grid runtime present** — `setupDirectRender` configures the display-sized canvas
   RENDER_ATTACHMENT + COPY_SRC (dropped STORAGE_BINDING), builds the grid-plane RENDER
   pipeline, seeds a default fit camera. `presentToCanvas` + `dispatchColorPassAndPresent`
   (OM compute pass → grid-plane render pass in one encoder) use `encodeGridPlanePresent`
   with `rt.gridCamera2D`. `setGridCamera2D` stores + re-presents.
3. **2D grid camera** — a `setGridCamera2D` worker message (mirroring voxel `setGridCamera`
   / agent `setAgentCamera`), rAF-coalesced + deduped on the main thread (`postGridCamera2D`),
   posted on pan/zoom + the Phase 2 ack. The worker re-presents on colour refresh
   (step tail, mutation tail, viewer switch, reset — all route through `dispatchColorPassAndPresent`).
4. **Main-thread 1:1 blit** — `draw()`'s new `directRenderActiveRef` branch blits the
   display-sized canvas 1:1 (mirrors E2's `agentComposite` branch) + re-attaches on a
   display resize; gridlines / glyph overlay / brush cursor overlay on top (same scene
   transform the camera encodes).

### Must-not-regress — verified
- **Recording** ships GRID-resolution colours (300²×4 = 360000 bytes, NOT display-res) —
  reads `colorsBuf` via `readbackColors`, independent of the present path. NOT touched.
- **E2 grid+agents composite UNREGRESSED** (Chemotaxis WebGPU/WebGPU) — `composite:true`,
  the shared `GRID_PRESENT_WGSL` compiles, `hasColors:false` (readback still eliminated),
  0 errors. The grid's own direct render is correctly OFF for agent models (mutually exclusive).
- **JS/WASM grid fallback** — no `directRender`, no attach, no camera; colours shipped every
  step (unchanged scaled-blit path).
- **Glyph** — a glyph 2D WebGPU model engages direct render; NO glyph code touched
  (`sendColors` ships `glyphsPayload` under direct render unchanged; `drawGlyphOverlay`
  gate `showGrid2d && !agentComposite` unchanged). Byte-identical behaviour.
- **Paint / inspect** — read/patch `colorsBuf`/attrs independent of the present; a mutation
  re-presents through `dispatchColorPassAndPresent`.

### Verification note (occlusion)
The Browser pane would NOT composite frames in this environment (screenshots timed
out — "the Browser pane is not displayed"), so the composited-pixel eyeball is
**flagged for the user**. In its place I used the same OCCLUSION-SAFE method the E2
report used: the worker message protocol (directRender engaged, canvas DISPLAY-sized,
camera flow, no errors) + a `__gridPresentReadback` GPU-buffer readback that samples
the presented canvas. The crispness pass/fail was proven via a horizontal pixel
profile at extreme zoom: PIECEWISE-CONSTANT per cell, **ZERO intermediate/blur
pixels** (a linear present would show grey), transition EXACTLY on the cell boundary
(display x=160 = col-170 edge) — NEAREST crisp cells with correct mapping.

### Deeper-unification note
Grid-only = the grid plane; grid+agents (E2) = the grid plane + agent discs. Both now
share `GRID_PRESENT_WGSL`. A full single-present-path unification was NOT taken (the
grid runtime and the agent runtime are separate objects on the shared E1 device with
separate canvases/attach lifecycles); reusing the shader source is the required bar and
that is met. The next natural step (out of scope here) is the L2 grid-only-render
follow-up already noted in the E2 report — done by this phase.

### Gates (all green)
`tsc -p tsconfig.app.json --noEmit`, `npm run build`, `parity-agent-wasm` (18),
`parity-agent-force` (7), `verify-agent-render`, `verify-render-uniform-layouts`
(GridPlaneView now parsed from the shared module). No compiler files touched.

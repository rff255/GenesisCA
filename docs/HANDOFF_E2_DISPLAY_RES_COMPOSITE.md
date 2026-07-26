# HANDOFF — E2 redesign: DISPLAY-resolution single-canvas grid+agents composite

**Branch**: `optimize`. **Status**: READY. Render-only. This RESURRECTS + REDESIGNS
the dormant E2 composite. Read first: CLAUDE.md "E2 — single-canvas composite
render" + the note **"E2 single-canvas composite is DISABLED (world-res rejected,
2026-07-23)"** (the `agentComposite` hard-false gate + why), the master status
board's E2 row in [HANDOFF_GPU_AGENT_RENDER.md](HANDOFF_GPU_AGENT_RENDER.md), the
original [HANDOFF_GPU_AGENT_RENDER_E2.md](HANDOFF_GPU_AGENT_RENDER_E2.md), and the
A1/C direct-render sections (how agents render at DISPLAY resolution through the
camera — you are matching that).

## Why the first E2 was disabled, and the fix in one line

The shipped E2 composited both layers into ONE **grid-W×H (world-resolution)**
canvas — grid cells written 1:1, agents drawn at `scalePx=1` — and let the main
thread SCALE that whole canvas up to the display. The grid was fine (cells are
world-sized), but a small agent rendered at world resolution became a
**cell-sized blob** once scaled (the user's "agents become a blob of cells"). So
`agentComposite` was hard-disabled and grid+agents-on-WebGPU fell back to the D
two-canvas path (decoupled) / CPU-overlay + grid-colours readback (field-coupled).

**The fix (user's design, and the correct one): render at DISPLAY resolution
through the camera — exactly like the agents-only render — with the grid drawn as
a camera-transformed PLANE colored by the cell buffer.** No world-res canvas, no
main-thread scaling, no blur.

## The design — ONE display-res canvas, ONE camera, TWO passes

Into a **display-pixel-sized** canvas (the A1/C sizing, NOT grid-W×H), in one
encoder:

1. **Grid-plane pass** (the new part). A single quad spanning the grid's world
   extent `[0,0]..[W,H]`, transformed by the SAME camera MVP the agent discs use
   (reuse the agent `RenderView` / `sceneCameraMatrices` source so grid and agents
   cannot disagree on the transform). Its FRAGMENT shader maps the interpolated
   world position back to a cell — `col=floor(wx)`, `row=floor(wy)` — and samples
   the grid runtime's `colorsBuf` (`cellColour[row*W+col]`) with **NEAREST**
   semantics (integer floor = hard cell edges = the crisp CA-block look; do NOT
   linear-interpolate). Bounds-guard outside `[0,W)×[0,H)` → transparent/bg.
   - **This is DISPLAY-PIXEL-BOUND, not cell-count-bound** — one cell lookup per
     covered display pixel, so a 5000² field costs the same to present as a 300²
     one. This is the whole point (the survival-bias-corrected requirement: field
     grids WILL grow). Do NOT render one instanced quad per cell (W×H instances) —
     the single sampled plane is the efficient realization of "a plane of cells".
2. **Agent-disc pass** on top (`loadOp:'load'`), display resolution, unchanged
   from the A1 2D disc / C sphere path.

Per-layer `showGrid`/`showAgents` toggles carry over. The canvas is the
worker-presented / transferred canvas shown directly (or blitted 1:1) — **the
main thread never scales a world-res canvas again**.

## What it must cover (do not regress the E1/E1b/D work)

- **Decoupled** grid+agents (D: independent grid + agents, e.g. GoL+Boids) AND
  **field-coupled** (E1b: agents read/write the grid field, e.g. Chemotaxis, Ant
  Necrophoresis) — BOTH on WebGPU grid + WebGPU agent. The grid `colorsBuf` is the
  same source in both; the E1b GPU field bridge (buffer copies) is orthogonal and
  must stay intact (the composite only reads `colorsBuf` for DISPLAY; it does not
  touch the field round-trip).
- Re-enable the `agentComposite` gate (currently hard-false) for
  `WebGPU grid + WebGPU agent + 2D + !sprites + !metaballs`. The 3D voxel+sphere
  composite stays out of scope (a separate future phase).
- **Zero compiler changes** — this is render/worker only (`agentWebgpuRuntime.ts`
  + `sim.worker.ts` + `SimulatorView.tsx`, like the original E2). Assert with
  `git diff --stat`; if a compiler file is touched, run `check-compile-identity`.

## Bonus this unlocks (verify, note — do not scope-creep into it)

The L2 lattice probe (2026-07-25, visible pane) found large 2D grids are
**display-bound**: the main thread spent ~330 ms/frame scaling a 2000² world-res
canvas. A display-resolution GPU grid present is the same fix for that. This
redesign delivers it FOR grid+agents composite models. Applying the same
display-res present to GRID-ONLY 2D WebGPU models (which today direct-render to a
grid-res OffscreenCanvas + main-thread scale) is a natural FOLLOW-UP — note it in
the Completion Report, do not build it here.

## Verify (screenshots REQUIRED; the pane is DISPLAYED)

The exact failure was zoom blur, so the ZOOM test is mandatory:
1. A field-coupled model (Chemotaxis) on WebGPU grid + WebGPU agent: composite
   engages, both layers show, **0 grid-colours readbacks** (`hasColors:false` on
   stepped — the readback the redesign eliminates; prove via the worker trace).
2. **Zoom WAY in** on an agent — it must be a CRISP round disc (NOT a blocky
   cell-sized square). Zoom out — agents stay crisp dots, grid cells are crisp
   blocks. This is the whole reason for the redesign; screenshot both zoom levels.
3. Grid cells render as sharp squares (nearest), not blurred/interpolated.
4. A **decoupled** model (a GoL-grid + Boids-agents synthetic, or build one):
   same — composite engages, agents crisp, grid crisp, no readback.
5. `showGrid`/`showAgents` toggles work; pan/zoom track live.
6. Fallbacks unchanged: agents-only Boids-webgpu (A1 disc render), grid-only
   GoL-webgpu (its own direct render), JS/WASM grid / 3D / sprites / metaballs →
   composite gate false.
7. Confirm the E1b field bridge still works (Chemotaxis field builds + agents
   aggregate) and Ant Necrophoresis piles form — the composite is display-only.

Flag the composited-pixel eyeball (crispness at zoom) for the user to sign off —
but you CAN and MUST screenshot the zoom test yourself; that is the pass/fail.

## Gates
`npx tsc -p tsconfig.app.json --noEmit`, `npm run build`,
`node scripts/parity-agent-wasm.mjs`, `node scripts/parity-agent-force.mjs`,
`node scripts/verify-agent-render.mjs`, `node scripts/verify-render-uniform-layouts.mjs`
(if you add/modify a render uniform struct — likely a small grid-plane view
uniform; register it in the harness, mind the vec3 align-16/size-12 §10 trap).

## Hard rules
Commit on `optimize` staging EXPLICIT paths (NEVER `git add -A`); NEVER push;
NEVER add Co-Authored-By / Claude / Anthropic attribution; NEVER bump the
version; multi-line commit messages via `git commit -F <file>`; `sim.worker.ts`
mojibake comment bytes — anchor Edits on clean ASCII code lines, never a user-
facing mojibake string; measure branch scope against `origin/master`.

Update CLAUDE.md (replace the "E2 DISABLED" note with the redesign) + the E2
status-board row + this doc's Completion Report. Finish with the crisp-at-zoom
screenshot evidence + the readback-eliminated trace.

## Completion Report
(fill in when executed)

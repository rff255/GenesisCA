# PHASE E2 HANDOFF — Single-Canvas Composite Render (2D core; 3D as a gated stretch)

Read first: [HANDOFF_GPU_AGENT_RENDER.md](HANDOFF_GPU_AGENT_RENDER.md) §0/§3 +
ALL Status Board rows; then this doc; then the E1 + E1b Completion Reports
(the shared device + the resident field bridge you render for) and the
A1/C/D reports (the render seams being unified). CLAUDE.md context: the
WebGPU grid section's direct-render bullets (`setupDirectRender` /
`presentColors` / `dispatchColorPassAndPresent`), the A1/A2/C/D/E1/E1b
subsections.

**Problem**: 2D grid+agents models composite TWO canvases today (the grid's
path below, the agent canvas above — D), and the WebGPU grid's own direct
render is still DISABLED for agent models entirely (the pre-A1 gate
`!agentModel`, SimulatorView ~:3758 — agent models force the grid onto the
colors-readback path). With the shared device (E1) one canvas can carry
both layers in one encoder.

**Objective (2D core)**: for 2D grid+agents models where the GRID is WebGPU
and the AGENT render is active (decoupled per D, or field-coupled resident
per E1b), present BOTH layers into ONE canvas per frame: the grid's present
pass first, the agent instanced-quad pass second (same encoder, same
texture view — z-order preserved: grid under agents). This removes the
grid's per-gen colors readback for agent models (the last big CPU cost in
that configuration) and the two-canvas composite.

**3D stretch (EXPLICITLY OPTIONAL — may STOP)**: lifting D's `!is3D`
carve-out needs a WGSL instanced-voxel pass (a port of gl3d's cube
instancing basics) depth-composited with the C sphere pass. Attempt ONLY
after the 2D core is verified and committed as its own milestone; if the
voxel pass exceeds a session's scope, STOP and record — a follow-up phase
picks it up. Do not let the stretch endanger the core.

---

## Work items (2D core)

1. **Combined present** (`agentWebgpuRuntime.ts` + `webgpuRuntime.ts`):
   a `presentCompositeEncode(encoder, canvasCtx)` that (a) runs the grid's
   present (the existing `presentColors` compute writing the storage
   texture, or its render-pass equivalent) targeting the SHARED canvas,
   then (b) the agent quad pass with `loadOp:'load'` on the same texture
   view (grid pixels preserved under the discs). Both runtimes are on the
   shared device (E1) — assert that in the gate. Mind the canvas configure:
   ONE context, configured once, `rgba8unorm`; the grid's present shader
   writes premultiplied — the agent pass blends over it (the A1 blend
   states already do).
2. **Gate + canvas plumbing** (`SimulatorView.tsx`): for 2D grid+agents
   with WebGPU grid + agent render active → ONE transferred canvas (reuse
   the agent attach seam; the grid's separate direct-render canvas is NOT
   built in this configuration). `draw()` blits the one canvas. The grid's
   `!agentModel` direct-render exclusion stays for CPU-overlay agent
   configurations (unchanged); the NEW combined path is a separate arm.
   Camera: the grid layer is the world-rect blit (the existing grid
   present is full-grid; the agent camera already maps world→screen) —
   the grid present must go through the SAME camera transform as the
   agents. If the existing grid present shader cannot pan/zoom (it writes
   1:1 texels), keep the grid at world resolution on the canvas and…
   STOP: do NOT invent a resampling shader ad hoc. Instead adopt the
   simplest correct arrangement: the combined canvas is WORLD-sized for
   the grid layer with the agent pass rendered in world space too, and
   the main thread's existing zoom/pan blit scales the composite (exactly
   how the grid direct render works today — `draw()` already does this
   composite blit; the agent camera uniform then uses world-space
   coordinates with scalePx=1, ox=oy=0). This keeps both layers on the
   proven paths; display-resolution crispness for agents at high zoom is
   an accepted tradeoff in this configuration (document it).
3. **Worker orchestration** (`sim.worker.ts`): the combined-present call
   sites mirror the agent present points (batch tail, camera/mutation
   one-shots, refreshDisplay), all inside the existing deferral. Recording
   for this configuration: the grid colors readback mirror under recording
   (the existing `recording` gate) still works — verify the capture path
   composites both layers (display-canvas capture).
4. **Fallbacks**: any ineligibility (CPU grid, sprites, metaballs, 3D)
   keeps the D two-path arrangement or the CPU overlay exactly as today.

## Do NOT touch
Compilers, agentEngine, gl3d (unless the 3D stretch is attempted, and then
only additively per C's discipline).

## Verification (2D core, all mandatory)
- tsc, build, parity ×2; git diff --stat audit.
- Real GPU in-browser:
  - The D synthetic (decoupled grid+agents) with a WebGPU grid: ONE canvas
    carries both layers (grid pixels + agent discs — pixel probes at
    overlap), free-runs, 0 errors; the grid's colors readback is absent in
    free mode (instrument).
  - Chemotaxis WebGPU/WebGPU (E1b resident): the composite shows field +
    agents; metrics unchanged from E1b.
  - Recording captures both layers; getState fresh for both.
  - CPU-grid agent models + agents-only + 3D: unchanged paths.
- Flag the visual composite for the visible-pane eyeball list.

## Completion Report
(fill in when done — commits, deviations + why, measured numbers, gotchas;
if the 3D stretch was attempted, its own subsection or STOP finding)

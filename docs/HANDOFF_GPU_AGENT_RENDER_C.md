# PHASE C HANDOFF — 3D Free-Mode WGSL Sphere Render (gl3d keeps frame mode)

Read first: [HANDOFF_GPU_AGENT_RENDER.md](HANDOFF_GPU_AGENT_RENDER.md) §0/§3 +
the A1/A1.5/A2/B1 Status Board rows (their LESSONS bind you — especially the
present-ordering/black-at-load lesson and the explicit-path-staging rule);
then this doc; then the A1/A2/A1.5 Completion Reports (the render machinery,
`AgentRenderSurface`, the OM pass — you extend the same files); then
PLAN_GPU_AGENT_RENDER.md § Extension roadmap Phase C. CLAUDE.md context:
"PR8 — WebGL2 3D voxel renderer" + "3D viewport" rounds (the gl3d camera/
lighting you must match), "Agent-engine performance review round", and the
A1/A2/A1.5 subsections.

**Objective**: 3D agent models currently pay the per-frame readback + snapshot
+ main-thread WebGL2 draw even when fully resident (the resident SIM already
runs 3D). In free mode, render the agents as **sphere impostors in WGSL from
the worker's buffers** into a second canvas layered UNDER the gl3d canvas;
gl3d renders ONLY the overlays (axes/grid/bounds/gizmo/brush outline) over a
transparent clear. Any feature that needs CPU state flips UI-sync → frame
mode → gl3d renders everything exactly as today. Both feeds work: resident
(WebGPU target) and snapshot-fed (CPU targets, the A2 surface).

**The gate** (general; extends the 2D gate rather than forking it):
agents-only AND `is3D` AND no sprites AND metaballs OFF AND
`resolveMaxBonds(model.centerBased) === 0` (no bond lines to draw — resident
models satisfy this already; it only bites snapshot-fed 3D bonded models,
which keep the CPU path) AND **3D alpha-blend OFF** (translucent spheres need
back-to-front sorting — gl3d's job; opaque impostors + depth-write only) AND
OffscreenCanvas supported. Re-evaluate on every model/settings change
(flipping Alpha blend ON must cleanly drop back to the CPU path).

---

## Work items

1. **WGSL sphere impostor pipeline** (`agentWebgpuRuntime.ts`, alongside the
   2D disc pipeline): port gl3d's sphere-impostor math (SPHERE_VS/SPHERE_FS
   in [src/simulator/render/gl3d.ts](../src/simulator/render/gl3d.ts)) to
   WGSL — camera-facing billboard quad per agent (instanced, vertex pulling
   from `agentF32` x/y/z/radius + `agentColors` + `agentAlive`, same
   world remap as gl3d: **col→+X, row→−Y, layer→−Z**, the Z-up basis), FS
   ray-sphere intersection + `@builtin(frag_depth)` so spheres depth-sort
   among themselves, discard on miss/dead/alpha-0.
   - **Lighting parity is part of the spec**: implement the same shading
     formula gl3d's sphere FS uses (`ambient + diffuse·max(0,n·L)` +
     Blinn-Phong `specular·pow(max(0,n·H),32)`), driven by uniforms
     (lightWorldDir, ambient, diffuse, specular). Shadows/AO are NOT
     replicated (they need the shadow map — models wanting them use frame
     mode; note it in Help).
   - The 3D RenderView uniform: the **MVP matrix (16 f32)** + camera
     position + viewport + light params + bg colour. The MAIN thread
     computes the MVP with the SAME math gl3d uses (its mat4 helpers are
     internal — EXPORT the needed ones from gl3d.ts rather than duplicating;
     exporting is a type-only-safe additive change) and ships it in the
     camera message, so the two renderers can never disagree on projection.
   - Depth: request a depth texture for the render pass (the 2D path has
     none — make it conditional on the 3D mode).
2. **Layering + gl3d overlay mode** (`SimulatorView.tsx` + minimal
   `gl3d.ts`): in 3D free mode, the worker canvas (spheres, opaque or
   bg-cleared) is a sibling UNDER the gl3d canvas; gl3d gets an
   **overlays-only** flag (skip voxels/agents/bonds/metaballs; clear
   transparent) — a small additive `Gl3DRenderer` option, NOT a fork. The
   existing 3D pointer handling stays on the gl3d canvas (top), so orbit/
   pan/zoom/brush events are untouched. On camera motion: update gl3d
   (overlays) AND post the 3D camera message (rAF-coalesced; remember the
   double-rAF re-blit lesson — here the worker canvas is composited by the
   browser, no blit, so instead ensure a present follows every camera
   message, and the overlays redraw on the same frame).
   - Frame mode (UI-sync ON, any interaction/recording/pause): gl3d renders
     EVERYTHING as today from the snapshot; hide/clear the worker canvas.
     The flip is the existing UI-sync driver — extend its effect to toggle
     the canvas visibility + the gl3d overlays-only flag.
   - Known accepted losses in free mode (document in Help + the report):
     overlay-vs-sphere depth interaction (the brush plane won't occlude
     spheres; "Draw agents in front" semantics collapse to always-front for
     overlays) and shadows/AO/alpha-blend (gated off or frame-mode-only).
3. **Worker** (`sim.worker.ts`): the 3D camera message variant (same
   `setAgentCamera` message, a `mode:'3d'` view payload), present points
   unchanged (batch present + camera present + mutation present — all
   already exist); the readback policy is IDENTICAL to 2D (nothing 3D-
   specific about free/frame/one-shot).
4. **Recording/screenshot in 3D** read gl3d's `readPixels` — recording
   already forces UI-sync ON ⇒ frame mode ⇒ gl3d full render ⇒ correct
   captures with zero new code. VERIFY this explicitly (a recording started
   mid-free-run must contain spheres).

## Do NOT touch
The lattice compilers, agentWasm/agentWebgpu compilers (C is render-only —
zero compiler changes; assert with `git diff --stat`), agentEngine,
the 2D render paths (byte-behaviour-identical for 2D models).

## Verification (all mandatory)
- tsc, build, parity ×2; `git diff --stat` shows no compiler files.
- Real GPU in-browser (message-count probes, NOT setTimeout chains):
  - **Particle Life 3D on the WebGPU target** (the shipped sample):
    engages 3D direct render, free-runs resident (no snapshot, liveCount),
    0 errors; agents move in 3D (getAgentState z varies).
  - Boids 3D variant on a CPU target engages via the snapshot-fed surface.
  - Interaction flips: arming the agent brush / pinning the inspector
    flips frame mode (snapshot resumes, gl3d full render); releasing
    returns to free.
  - Fallbacks: 3D Tissue (bonds/division → ineligible) keeps today's path;
    Alpha blend ON drops to CPU path cleanly; 2D models byte-unchanged.
  - Recording mid-free-run contains spheres (the frame-mode flip).
  - Overlay layering: axes/gizmo/bounds render over the sphere canvas
    (DOM order + transparent gl3d clear verified via element stacking +
    pixel probes on the composite).
- The visual look (lighting parity vs gl3d's spheres) needs a VISIBLE pane —
  note it for the orchestrator/user eyeball, like A1/A2.

## Completion Report
(fill in when done — commits, deviations + why, measured numbers, gotchas,
notes for D)

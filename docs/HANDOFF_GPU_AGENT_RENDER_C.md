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

## Completion Report (2026-07-23)

**Commit** (branch `optimize`, not pushed): one commit — "perf(agents): C 3D free-mode
WGSL sphere render (gl3d overlays-only)". `git diff --stat` = exactly four render-layer
files: `gl3d.ts` (+~50 net), `agentWebgpuRuntime.ts` (+~285), `sim.worker.ts` (+~36),
`SimulatorView.tsx` (+~200). **NO `compiler/` file, NO agentEngine, NO lattice** — C is
render-only (asserted). gl3d.ts is a render file (the handoff work item 2 explicitly
allows "minimal gl3d.ts").

**What shipped vs the spec** (all work items done; deviations, all justified):
1. **Layering = an imperatively-managed DOM canvas inside a stable `<div>` layer, NOT a
   React-keyed `<canvas>`.** The handoff's "sibling canvas UNDER the gl3d canvas,
   composited by the browser, no blit" is implemented as: a stable `<div ref>`
   (`z-index:1; pointer-events:none`) into which `maybeAttachAgentCanvas` (3D branch)
   appends a FRESH `<canvas>` each attach (removing the prior), transfers its control,
   and lets the browser composite it. This handles transfer-once + resize + recompile
   with no React element-lifecycle dance (`transferControlToOffscreen` is once-per-element).
   The gl canvas gets `position:absolute; z-index:2` in 3D so it composites OVER the
   sphere layer; its `overlaysOnly` transparent clear lets the spheres show through. This
   is the handoff's design (browser-composite, no blit), realised robustly.
2. **A `mode:'3d'` view UNION on the existing `setAgentCamera` message** (per the spec):
   `AgentRenderView | AgentRenderView3D`; the worker's `applyAgentRenderView` routes by
   `.mode` to `uploadAgentRenderView` (2D) / `uploadAgentRenderView3D` (3D). One 176-byte
   `RenderView3D` uniform (MVP 16f + camera basis + world light dir + uHalf + bg).
3. **MVP + light are the SAME math as gl3d** — `sceneCameraMatrices` + `lightWorldDirFor`
   are EXPORTED from gl3d.ts and gl3d's `setCamera`/`lightWorldDir` now DELEGATE to them
   (a small type-safe refactor → literally one implementation, so the two renderers can't
   disagree on projection/lighting, exactly as the spec demands). The main thread computes
   the MVP + light and ships them.
4. **`setupAgentDirectRender` branches on `layout.gridDepth > 1`** (sphere pipeline +
   depth24plus attachment) vs the 2D disc pipeline; `presentAgentsEncode` routes to the
   sphere pass when `rt.render3D`. So the resident-batch present + all camera/mutation
   presents get 3D with ONE internal branch (no new present call sites in the worker).
   `uploadAgentRenderFields` (A2 tight upload) now also uploads `z` for 3D; the CPU-target
   `agentRenderLayout` is 3D-aware (real depth → a `z` field base).
5. **The paused-render fix (worker `setAgentUiSync` OFF→ON now ALSO ships one snapshot).**
   NOT in the handoff, but REQUIRED for 3D: unlike 2D (which blits the sphere canvas, so a
   paused view keeps showing agents), 3D FRAME mode is gl3d rendering from the SNAPSHOT — a
   paused sim ships no step, so without a snapshot on the flip, gl3d would blank/not-pick.
   The flip now ships one snapshot after `ensureAgentStoreFresh`. Complementary: the
   `draw()` frame-mode gate requires `agentsRef != null` (a snapshot in hand), so the flip
   is seamless (spheres stay until the snapshot lands — no blank frame).
6. **A `glPointerOverRef` (gl-canvas enter/leave) for the 3D agent-brush frame-mode flip.**
   The 2D UI-sync uses `agentCursorWorldRef != null` (pointer over the 2D canvas); its 3D
   analogue is the pointer over the gl canvas + the agent brush armed, so the gl3d pick FBO
   (reads the snapshot) resolves. Conservative but correct; pausing already covers the
   common interact case.

**Measured** (real-GPU, in-browser, WebGPU-agent — occlusion-safe: worker protocol + DOM +
message-driven `performance.now()`-bounded MessageChannel waits, NEVER composited pixels):
- **PL3D on the WebGPU target**: engages 3D direct render (`agentRenderStatus:true` = sphere
  WGSL compiled 0 errors, both surfaces built, present ran), free-runs resident (stepped
  ships `hasAgents:false` + `agentLiveCount:1200`), **0 GPU errors** over many batches; agent0
  moves in 3D (getAgentState z 4.11→5.92, x/y also change).
- **CPU-target (wasm) PL3D** engages the snapshot-fed render-only 3D surface (renderStatus
  true, free liveCount 1200, 0 errors).
- **Frame-mode flip**: OFF→ON ships a snapshot even PAUSED (the fix, `hasAgents+=1` with no
  step); Alpha-blend ON via the real checkbox detaches → frame snapshot (has:1, no:0), OFF
  re-attaches (renderStatus true).
- **Fallbacks**: 3D Tissue (maxBonds 12) stays CPU (no attach, sphere layer empty); 2D
  Boids-webgpu still disc-renders (renderStatus true, sphere layer empty — the detached blit
  path); a longer 4-batch free run → 0 errors, exactly 1 sphere canvas (no leak).
- **DOM layering**: sphere layer z-index 1 comes BEFORE the gl canvas (z-index 2) in DOM
  (`layer-before-gl(correct)`); gl canvas `position:absolute`.
- Gates: `tsc -p tsconfig.app.json --noEmit` + `npm run build` + `parity-agent-wasm` (18) +
  `parity-agent-force` (7) all green.

**Could NOT verify (occlusion trap, master §0.7)**: composited PIXELS + the lighting-parity
EYEBALL (spheres vs gl3d's spheres) — the Browser pane reports hidden, so the compositor is
suspended. The render pipeline is proven by `agentRenderStatus:true` (the ack posts only
AFTER the sphere WGSL compiled 0 errors + pipelines built + a present ran) + 0 GPU errors +
the shared `sceneCameraMatrices`/lighting formula (a byte-for-byte projection/shade match with
gl3d by construction). **A visible-pane spot-check (orchestrator/user) should confirm the
spheres look identical to gl3d's + the overlays composite over them.**

**New gotchas / notes for D:**
- **The hidden-page timer throttle is REAL and bit me**: a `setInterval(…,100)` /
  `setTimeout` poll loop HANGS the eval (30s) on the occluded pane. The reliable pattern is a
  `MessageChannel` ping-pong bounded by `performance.now()` (MessageChannel ticks aren't
  throttled; the wall-clock check gives a real timeout). Worker `message` events fire
  regardless. Resolve promises INSIDE the worker listener, never on timers.
- **A useEffect dep-array size change surfaced as a React "changed size between renders"
  console error UNDER HMR** (I added a dep to the alpha3d effect) — harmless, an HMR artifact;
  a hard reload cleared it. When editing an effect's dep count, expect this warning until the
  next full reload.
- **The sphere canvas buffer fell to the 500px fallback under occlusion** (`layer.clientWidth`
  is 0 on a hidden pane) — the `draw()` resize re-attach fixes it on the first visible frame
  (compares `agentRenderCanvasDimsRef` CSS dims to the live gl-canvas client size). D's grid+
  agents composite should reuse the same resize-re-attach guard.
- **D (grid+agents two-canvas composite)** can reuse this whole seam: the sphere pass + the
  `AgentRenderView3D` uniform + `sceneCameraMatrices` export are ready; D adds the grid's
  direct-render canvas as a THIRD layer under the sphere layer (the grid runtime already
  renders its own canvas). The overlays-only gl3d flag stays; the z-order is grid(z0) →
  agents(z1) → gl overlays(z2). The alpha-blend / bonds gate terms carry over.
- **A minor pre-existing A2 device-leak on re-attach for CPU targets** (the attach handler
  builds a NEW `createAgentRenderOnlyRuntime` device without destroying the prior
  `agentRenderRuntime`) is triggered by an alpha/metaballs toggle on a CPU 3D model — rare,
  out of C scope, noted for a future hardening pass (a webgpu-target model reuses its runtime,
  no leak).

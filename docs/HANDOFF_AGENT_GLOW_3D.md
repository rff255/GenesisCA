# QUEUED PHASE — 3D Agent Glow (parity with the 2D direct-render Glow)

**Status**: QUEUED — runs AFTER the lattice optimization batch (L1 in particular
restructures the 3D render seam this phase builds on). Requested by the user
2026-07-24 after confirming the 3D spheres look correct.

Read first: [HANDOFF_GPU_AGENT_RENDER.md](HANDOFF_GPU_AGENT_RENDER.md) §0
(Invariants — the §0 #7 known-traps bind verbatim) + §3 (protocol); then the
**Phase C** Completion Report in [HANDOFF_GPU_AGENT_RENDER_C.md](HANDOFF_GPU_AGENT_RENDER_C.md)
(the 3D sphere pass + the free/frame flip you extend), the **A1** report
([HANDOFF_GPU_AGENT_RENDER_A1.md](HANDOFF_GPU_AGENT_RENDER_A1.md), work item 1 —
the 2D glow you are matching), and whatever the lattice **L1** report says about
the 3D render seam after it lands.

**Objective**: the Glow graphics option (`genesisca_sim_settings.agentGlow
{on,size,intensity,steepness,core}`) renders for 2D agents only; its UI is gated
`{!is3D && …}` in [SimulatorView.tsx](../src/simulator/SimulatorView.tsx). Give
3D agent models the same option, with the SAME look and the SAME parameters.

> **UPDATE (branch `updates`)** — 2D is now covered on BOTH paths: the WGSL
> pipeline described below AND a Canvas2D sibling (`drawAgentGlow` in
> SimulatorView.tsx) for the CPU overlay, so bonded / sprite / metaball /
> field-coupled 2D models glow too. That directly ANSWERS §2 below for the 2D
> case and is the precedent for 3D: the CPU overlay's answer was *implement the
> same falloff in the other renderer*, which is exactly what gl3d needs. Two
> details that carry over: the CPU pass draws glow **on top of** the opaque
> bodies (the draw order §"Design" already specifies here), and `intensity > 1`
> is reproduced by drawing the sprite `ceil(intensity)` times at
> `intensity/ceil(intensity)` rather than clamping. The note below that "the CPU
> 2D overlay still ignores glow" is now OBSOLETE.
>
> **UPDATE 2 (branch `updates`) — THE 2D SHAPE CHANGED; MATCH THE NEW ONE.**
> Glow is no longer one falloff from the centre. It is a **SOLID (opaque) CORE
> plus an additive halo drawn UNDER it**, with a fourth parameter `core ∈ [0,1]`
> (`agentGlow {on,size,intensity,steepness,core}`):
> - `coreR = radPx + core*glowSize`, `R = radPx + glowSize`; `core = 0` (the
>   default) ⇒ the core is exactly the agent's own body.
> - the halo profile is remapped over the **band outside the core**:
>   `t = clamp((1 - d) / (1 - coreR/R), 0, 1)`, `g = intensity * pow(t, steepness)`
>   — NOT `pow(1 - d, steepness)`. Inside the core it plateaus at `intensity`.
> - draw order per renderer is **halo (additive, depth-write off) FIRST, opaque
>   body OVER it** — the reverse of the "bodies → glow" order §"Design" states
>   below. That inversion is the entire point: an additive layer on top of the
>   body ADDS the body's own colour to itself, which is what made clusters blow
>   out and lone agents dim (the reported bug). For 3D this means: opaque spheres
>   pass ordering must put the additive halo **before** the opaque spheres, or
>   equivalently let the depth-tested opaque spheres overwrite it.
> - the GPU 2D path now issues TWO draws (glow pipeline then plain pipeline) from
>   two entry-point pairs (`vsGlow`/`fsGlow`, `vsMain`/`fsMain`) sharing one
>   `buildVert(vi, inst, halo)`; `RenderView.glowCore` was APPENDED LAST so no
>   existing member moved. Mirror that structure in the sphere pass.
> - the CPU 2D path draws an opaque core disc of radius `coreR` **only when
>   `core > 0`** (at 0 the agent's own body IS the core), so sprites/metaballs
>   are untouched by default. gl3d should follow the same rule.

---

## Why this is not a one-line gate lift (the two real costs)

1. **Pipeline shape.** The 2D glow is an additive-blend variant of the DISC
   pipeline (`renderGlowPipeline`, `agentWebgpuRuntime.ts` ~:1562, selected per
   frame by `rt.renderGlow`). The 3D pass is a SPHERE-IMPOSTOR pipeline built
   *instead of* the disc pipeline (~:1108, ~:1458) — opaque, depth-tested,
   writing `@builtin(frag_depth)` so spheres occlude correctly. Additive glow
   needs depth-WRITE off, so 3D needs a **second pass after the opaque spheres**
   (depth-test ON so geometry still occludes the glow, depth-write OFF, additive
   blend), not a pipeline swap. Draw order: opaque spheres → glow pass → (bonds /
   overlays as today).
2. **The free/frame split — the load-bearing constraint.** In 3D, free mode
   renders the WGSL spheres in the worker, but ANY interaction (brush, inspect,
   pause, recording) flips to frame mode where **gl3d** (WebGL2, main thread)
   draws everything — and gl3d has NO glow/bloom today (verified: zero matches
   for glow|bloom in [gl3d.ts](../src/simulator/render/gl3d.ts)). A glow that
   exists only in the WGSL pass would VANISH the moment the user touches the
   model and would never appear in a recording (recording forces frame mode).
   That breaks the project's feature-preservation rule and reads as a bug.
   ⇒ **The effect must exist in BOTH renderers.**

## Design (follow the Phase C precedent)

- Implement the falloff ONCE as a shared formula and mirror it in the two
  shading languages, exactly as Phase C handled projection + lighting by
  EXPORTING `sceneCameraMatrices` / `lightWorldDirFor` from gl3d so the two
  renderers cannot disagree. Keep the 2D formula as the reference:
  `intensity * pow(max(0, 1 - d), steepness)` over a quad enlarged by
  `glowSize`, additive blend.
- **gl3d (GLSL)**: an additive billboard pass after the opaque sphere pass —
  reuse the existing sphere instance buffer (positions/radius/colour are
  already there; the sprite pass at C is the precedent for a second billboard
  pass), `depthMask(false)`, `blendFunc(ONE, ONE)`, quad scaled by glowSize.
- **WGSL sphere runtime**: the sibling additive pass in
  `agentWebgpuRuntime.ts`, sharing the RenderView glow uniforms already
  present (`glowOn/glowSize/glowIntensity/glowSteepness`, ~:1178) — they are
  threaded for 2D and can be reused unchanged.
- **UI**: drop the `{!is3D && …}` gate; retitle the tooltip (it currently says
  "Not available in 3D yet"). The 2D CPU overlay already draws glow (see the
  UPDATE above) — the 3D CPU-side equivalent is gl3d.

## Verification
- Standard gates: tsc, build, `parity-agent-wasm`, `parity-agent-force`,
  `verify-agent-render` (standing gate). No compiler files expected — assert
  with `git diff --stat`.
- Real-GPU in-browser: a 3D agent model (Particle Life 3D) with Glow ON renders
  glow in FREE mode; flipping to frame mode (arm the brush / pause / record)
  keeps the SAME look — the flip must be visually seamless, which is the whole
  point of doing both renderers. Recording a 3D glow model contains the glow.
  Glow OFF is byte-identical to today. 2D glow unchanged.
- **Visible-pane eyeball required** (the occluded pane cannot judge this): the
  two renderers' glow must match closely enough that the free↔frame flip is not
  noticeable. Flag it for the user rather than claiming it.
- NB the 2D glow's visual result has never been eyeballed either (branch
  verification debt) — check it in the same pass and fix if it looks wrong.

## Completion Report
(fill in when executed)

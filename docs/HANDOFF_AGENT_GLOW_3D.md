# SHIPPED — 3D Agent Glow (dual-Kawase bloom over the agent layer)

**Status**: ✅ **SHIPPED** (branch `polishing`, 2026-08-10). See the
**Completion Report** at the bottom for what was built, the measured
verification and the one follow-up. Everything above that report is the
historical design record — **§"Design" remains superseded by UPDATE 3**, and
UPDATE 3's own cost estimate was partly wrong in the shipped direction's favour
(no float FBO turned out to be needed; see the report).

Originally requested by the user 2026-07-24 after confirming the 3D spheres look
correct; re-requested 2026-08-10 as "Missing 'glow' option for 3D".

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
>
> **UPDATE 3 (branch `updates`, 2026-08-07) — THE 2D ARCHITECTURE CHANGED AGAIN,
> AND THE REFERENCE SAYS 3D IS A DIFFERENT TECHNIQUE ENTIRELY. READ THIS BEFORE
> ANYTHING BELOW; §"Design" is now WRONG for 3D.**
>
> 2D was reworked to **accumulate-exactly-then-compress-once** (HDR additive
> accumulation + ONE tonemap), ported from the SandboxScience Particle Life
> renderer at the user's request. See the "Agent glow" section of CLAUDE.md for
> the full design. The relevant part for 3D:
>
> **THE REFERENCE HAS NO PER-PARTICLE GLOW IN 3D.** Its 2D
> `assets/particle-life-gpu/shaders/render/particle_render_glow.wgsl` draws an
> enlarged quad per particle with `pow(saturate(1 - dist²), steepness)`, additive
> into `rgba16float`. Its **3D**
> `assets/particle-life-gpu-3d/shaders/render/particle_render_glow.wgsl` contains
> ONLY `vertexCircle`/`fragmentCircle` — **no glow quads at all**. The 3D glow is
> a **dual-Kawase BLOOM post-process** (`assets/particle-life-gpu-3d/shaders/compose/bloom.wgsl`):
> soft-knee bright pass → downsample chain → upsample chain → added to the HDR
> colour (`hdr_color + bloom_color * bloom.intensity`) before the tonemap in
> `compose/compose_hdr.wgsl`. That is a screen-space effect on the whole 3D
> scene, not a per-agent halo — and it is *why* their 3D reads better than a
> billboard would: a bloom blooms the SPHERE SHADING (specular highlight, rim,
> the bright side of every sphere), which is exactly the 3D cue a flat additive
> billboard cannot give.
>
> ⇒ **§"Design" below (a per-particle additive billboard pass mirrored in the two
> renderers) is superseded.** Doing it that way would put a flat 2D halo on a lit
> 3D sphere and would NOT look like the reference. The correct 3D port is the
> bloom chain, and it must land in BOTH renderers (see §2 — the free/frame split
> is unchanged and still binding).
>
> **WHY IT WAS NOT DONE IN THE 2D SESSION** (explicit scope call, user-sanctioned
> — "2D quality is the primary ask… do not ship a half-verified 3D path"):
> - it is **two HDR pipelines, not one shader**. The WGSL sphere pass can take an
>   `rgba16float` target + a compose pass the way `presentAgentsEncode` now does
>   for 2D — but **gl3d is WebGL2** and has no float target today: it needs
>   `EXT_color_buffer_float` (or `_half_float`) probed at context creation with a
>   fallback for adapters that lack it, a float FBO sized to the canvas and
>   resized with it, ping-pong FBO chains for the Kawase levels (≈4–6 mip levels,
>   each an FBO + texture), two new GLSL programs (bright pass, blur), and a
>   compose blit — all inside a renderer that currently draws straight to the
>   default framebuffer and whose `render()` also serves the PICK FBO and the
>   shadow map.
> - **the two must MATCH across the free↔frame flip**, and a bloom's look is
>   dominated by mip count, kernel offsets and the knee — three chances for the
>   two implementations to drift in a way only a human eye can catch.
> - **the doc's own verification bar requires a VISIBLE-pane eyeball** (§Verification),
>   which the automated session cannot supply. Shipping it unseen would be
>   exactly the half-verified path the brief forbids.
>
> **WHAT THE NEXT SESSION INHERITS (all reusable):**
> - `src/simulator/glowTone.ts` — the shared exposure + curve. A 3D compose must
>   use the SAME `GLOW_TONE_EXPOSURE` and the same `x/(1+x)` on the magnitude, or
>   3D and 2D will disagree about what Intensity means.
> - `agentWebgpuRuntime.ts`: `GLOW_HDR_FORMAT`, `ensureGlowHdrTex` /
>   `destroyGlowHdrTex` / `encodeGlowHdrPass`, and `GLOW_COMPOSE_WGSL` — the HDR
>   target + compose scaffolding is already built and already teardown-safe; the
>   sphere path needs the same three calls plus the bloom chain between them.
> - the `[glow-arch]` block in `scripts/verify-agent-render.mjs` — extend it with
>   the 3D pins rather than starting a new block (it is negative-controlled,
>   10/10 mutations caught).
> - **the UI gate is still `!is3D`** and the tooltip still says 3D is unsupported;
>   both are in SimulatorView's agent common-controls.
>
> **A CHEAPER OPTION, if the full bloom is judged not worth it:** the reference's
> bloom is a *scene* effect, so a defensible reduced scope is "bloom the agent
> layer only" — the WGSL sphere pass already renders into its own canvas, and
> gl3d could render agents to an offscreen FBO. That halves the integration risk
> (no interaction with voxels / bonds / overlays / shadows) at the cost of not
> blooming the CA grid behind the agents. Decide deliberately; do not drift into
> it.

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

## Design — ⚠ SUPERSEDED BY UPDATE 3 (kept for the free/frame reasoning only)

The per-particle billboard design below is **not** what the reference does in 3D
and should not be implemented as written; UPDATE 3 explains why and what replaces
it. What still holds verbatim from this section: the draw-ordering / depth rules
(§2 and the gl3d bullet's `depthMask(false)`), the "implement it ONCE and mirror
it, as Phase C did for projection + lighting" discipline, and the UI gate to drop.


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
  **UPDATE 3**: 2D has now been eyeballed via downloaded PNGs (old/new/off) and
  measured numerically (see the CLAUDE.md "Agent glow" section); the remaining
  eyeball debt is 3D's free↔frame match.

## Completion Report — SHIPPED 2026-08-10 (branch `polishing`)

**What shipped**: the bloom UPDATE 3 called for, scoped to the **agent layer**
(that update's own "cheaper option"), implemented in **gl3d** (the frame path)
and made unconditional by **pinning frame mode while 3D glow is on**.

`git diff --stat` = [gl3d.ts](../src/simulator/render/gl3d.ts) +
[SimulatorView.tsx](../src/simulator/SimulatorView.tsx) +
[verify-agent-render.mjs](../scripts/verify-agent-render.mjs). **No compiler /
worker / engine file**, so compile identity holds by construction.

### The two places UPDATE 3's costing was wrong (both in our favour)
1. **No float FBO, no extension probe, no fallback.** UPDATE 3 assumed
   `EXT_color_buffer_float` because the 2D path needs `rgba16float`. It needs it
   because it ACCUMULATES N unbounded per-agent halos additively. The bloom does
   not: the source is the agent layer rendered ONCE with opaque depth-tested
   bodies (bounded in [0,1] by construction) and every Kawase tap is a weighted
   AVERAGE (also bounded). The only unbounded step is `× intensity`, which
   happens in the composite shader in float right before the tonemap. **RGBA8
   end to end is exact enough**, which deleted the single largest cost item.
2. **"The two must MATCH across the free↔frame flip" is dissolved, not solved.**
   3D glow **pins frame mode** (`agentGlow.on && is3D` detaches the worker's
   sphere direct render, exactly like `alpha3d`), so there is only ever ONE
   renderer while glow is on and the flip cannot pop. That also removes the
   visible-pane eyeball this doc made a blocker: there is no second
   implementation to compare against.

### Design as built
- **Source**: the agent layer re-rendered ALONE into a level-0 FBO (transparent
  clear, own depth). Re-drawing rather than reading the finished frame back buys
  BOTH invariants at once — the source is agents-only (**a grid+agents model
  never blooms its lattice**) and the existing render is untouched, so the
  composite can only ADD light (`blendFunc(ONE, ONE)`).
- **Occlusion mirrors the main pass**: `agentsInFront` ON ⇒ unoccluded in both;
  OFF ⇒ the voxels' depth is laid into the source FBO **colour-masked** (exact
  occlusion, zero colour contribution).
- **Chain**: canonical dual-Kawase down (5 taps) / up (8 taps), ≤ 6 levels,
  separate upsample ping targets so the up chain never writes the down level it
  is reading.
- **Compression is SHARED with 2D**: the same Reinhard `x/(1+x)` on the
  MAGNITUDE with the hue exact, at the same `GLOW_TONE_EXPOSURE` — so Intensity
  means the same thing in both views, which is what UPDATE 3 required.
- **All four sliders map to something real** (none disabled): `size` → level
  count + a sub-level offset (continuous between the power-of-two steps);
  `intensity` → gain; `steepness` → the upsample spread (wide vs tight);
  `core` → the composite mask `1 − core·coverage`, the 3D form of the solid
  core — **at core = 1 an agent body is left bit-exact**.
- **Lazy + released**: nothing is allocated until the option is switched on, a
  `size`/`intensity` of 0 is treated as OFF, a model with no agents never builds
  the chain, and `setAgentGlow` frees the whole chain when glow goes off.

### Verification (real GPU, occluded pane ⇒ `readPixels`)
- **Glow OFF is byte-identical**: 0 of 1,000,000 bytes on the bonded 3D Tissue
  (chosen because it is never direct-render eligible, so the frame path is
  stable and the comparison is apples-to-apples). `size = 0` likewise.
- **Particle Life 3D**: lit px 18,019 → 58,565; luminance 5.07M → 8.34M.
- **Intensity monotone**: 5.07 / 6.28 / 8.34 / 11.63 / 15.11 M at 0 / 0.2 / 0.6
  / 1.5 / 3.0. **Size monotone**: 35k / 58k / 70k / 91k lit px at 2 / 8 / 20 / 40.
- **Core = 1 ⇒ bodies bit-exact**: 3,141 of 3,141 3×3-eroded body pixels
  unchanged, maxDelta 0.
- **Additive-only**: 0 channels darker on the Tissue and on a voxel+agent scene.
  On Particle Life, **17 channels of 1,000,000 off by exactly 1**, all
  edge-adjacent, every one on a pixel that got net brighter — MSAA-resolve
  rounding (the context is `antialias: true`), not a darkening path.
- **Voxels never bloom**: with **94,328 voxel instances** in the scene the bloom
  source held **101 non-empty pixels (the 5 agents) and ZERO voxel-coloured
  pixels**, in BOTH `agentsInFront` branches. A grid-ONLY model with glow maxed
  (size 40, intensity 3) is **0 bytes different**.
- **Frame pin**: flips bidirectionally and repeatably through the real checkbox;
  a forced re-attach with glow on leaves `directActive` false.
- **Picking unaffected** (identical results on vs off); **a real screenshot
  download** goes 17,960 → 42,359 lit px (76 → 162 KB); `gl.getError()` 0 throughout.
- Gates: `tsc`, `npm run build`, `verify-agent-render`,
  `verify-render-uniform-layouts` all green.

### Guard
The `[mirror invariant]` block in `verify-agent-render.mjs` went from ONE
sanctioned frame-pin detach to **two** (alpha-blend + glow), both required to
POST before they mirror. Negative-controlled: deleting the glow detach's post
fails exactly that check.

### The one follow-up
**Port the bloom chain to the worker's WGSL sphere pass** to lift the frame pin,
so a 3D glow model keeps the free-mode GPU fast path. The 2D HDR scaffolding in
`agentWebgpuRuntime.ts` (`GLOW_HDR_FORMAT`, `ensureGlowHdrTex` /
`destroyGlowHdrTex` / `encodeGlowHdrPass`, `GLOW_COMPOSE_WGSL`) is still the
right starting point, and the RGBA8 finding above means the WGSL side does not
need the HDR target either. If that lands, the free↔frame match becomes a real
concern again and **the visible-pane eyeball this doc demanded comes back with
it**.

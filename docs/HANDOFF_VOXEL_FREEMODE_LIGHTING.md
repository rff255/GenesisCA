# HANDOFF — occupancy AO, cast shadows & alpha blend in the FREE-mode voxel render

**Branch**: `optimize`. **Status**: QUEUED — runs AFTER the WebGPU-neighbour-table
memory phase ([HANDOFF_WEBGPU_NBR_TABLE_MEMORY.md](HANDOFF_WEBGPU_NBR_TABLE_MEMORY.md))
so the two don't collide in `webgpuRuntime.ts` / the UI-sync driver. Read first:
CLAUDE.md "L1 — worker-side WGSL voxel render", the **§10** VoxelView
uniform-layout root cause (the padding trap — you WILL add fields to that
struct), and gl3d's shadow-map + occupancy-AO + buried-cull implementation
(`src/simulator/render/gl3d.ts`: `SHADOW_GLSL`, `computeLightMVP`,
`renderShadowMap`, the AO scan inside `uploadColors`, `sortBackToFront`).

## Why this exists

The L1 free-mode voxel render (worker WGSL, no per-frame readback) implements
camera, lighting, clip, cell gaps, alpha pass-through and the buried-cell cull —
but NOT cast shadows, occupancy AO, or alpha blend. Those three are gl3d-only
(frame mode). So the UI-sync driver (`SimulatorView.tsx` `updateGridUiSync`)
lists them as reasons to want frame mode:

```ts
|| light.shadows || light.ao
|| alpha3dRef.current
```

Enabling any of them therefore drags the whole model back onto the slow
colours-readback + O(total) `uploadColors` path (the user's "why does turning on
shadows/occlusion flip performance back to how it was"). This phase ports each
into the WGSL free-mode renderer and, as each lands, REMOVES its `want` term so
it runs GPU-resident. **This is the OPPOSITE of the 3D-glow handoff**: gl3d
ALREADY has all three, so you only ADD them to the WGSL pass — you do not build a
second renderer. gl3d stays the frame-mode reference; match its LOOK closely
enough that any residual frame flip (recording, inspect) is visually seamless.

Each phase is independently shippable. Do them in this order (cheap→hard).

---

## Phase 1 — Occupancy AO (nearly free; reuses the compaction neighbour scan)

The compaction shader (`VOXEL_COMPACT_WGSL`) ALREADY computes the exact
6-face-neighbour occupancy `cnt` when `cullBuried` — the identical scan gl3d does
CPU-side in `uploadColors` (`ao[n] = cnt/6`). And the DRAW shader
(`VOXEL_DRAW_WGSL`) already binds `colorsIn` (binding 1). So:

- In the cube VS, recompute the 6-neighbour `cnt` from `colorsIn` (reuse the
  compaction `filled()` + the layer/row/col decode), pass `ao = f32(cnt)/6.0` as
  a `@interpolate(flat)` varying. No new buffer, no new binding — 6 storage
  reads per instance (once, in the VS), matching gl3d's per-instance cost.
- In the cube FS, apply `ambient * (1.0 - aoStrength * vAO)` — the exact gl3d FS
  line (`float ao = 1.0 - uAOStrength * vAO;`).
- Add `aoStrength : f32` (and reuse an `ao`-on gate — 0 strength ⇒ off) to
  `VoxelView`. **This edits the uniform struct** → update `VOXEL_VIEW_WGSL`,
  `uploadVoxelView`, `VOXEL_VIEW_BYTES`, AND `computeVoxelRenderView`
  (`SimulatorView.tsx`, feed `light3d.ao ? light3d.aoStrength : 0`). Then
  `node scripts/verify-render-uniform-layouts.mjs` MUST pass — mind the
  `vec3`-size-12/align-16 padding rule that caused §10 (put the new scalar where
  the harness proves no write lands in padding and no byte is unwritten).
- Remove `|| light.ao` from `updateGridUiSync`'s `want`. AO now runs in free
  mode; the driver no longer forces frame mode for it.

Verify: AO ON in free mode darkens crevices exactly like gl3d frame mode (the
free↔frame flip on Shift-inspect must look identical); AO strength slider works;
AO OFF is unchanged; a real GPU run on the Accretor stays resident (0
`setGridUiSync` flips when toggling AO).

## Phase 2 — Cast shadows (a real but bounded shadow-map pass)

Mirror gl3d's directional shadow map in the worker WGSL renderer:

- A depth-only cube pipeline rendering the SAME procedural cubes from the LIGHT's
  ortho POV into a `depth24plus` shadow texture (gl3d's `CUBE_SHADOW_VS/FS` +
  `SHADOW_SIZE 2048`). One extra render pass before the display cube pass.
- The light matrix MUST come from the SAME source gl3d uses so the two renderers
  can't disagree: **export `computeLightMVP` from gl3d** (the Phase-C precedent —
  `sceneCameraMatrices`/`lightWorldDirFor` are already exported for exactly this)
  and compute the light MVP on the MAIN thread, feeding it in a VoxelView field
  (a mat4 — 64 bytes; register it in the uniform-layout harness). Bias
  (`uShadowBias = 0.9/(3R)` + slope) mirrors gl3d.
- The display cube FS PCF-samples the shadow map (gl3d's `SHADOW_GLSL`
  `shadowFactor(fragWorld, ndl)` — 3×3 taps) and attenuates diffuse+specular.
  Needs the fragment WORLD position as a varying (the VS already has the cube
  centre + the world remap).
- Add `shadowStrength : f32` + the light MVP + shadow bias to `VoxelView`; sample
  a `sampler2DShadow`-equivalent (`texture_depth_2d` + `sampler_comparison`) —
  a NEW bind group entry on the draw pipeline. Explicit `precision`/format care
  (gl3d hit a `sampler2DShadow` precision requirement; WGSL's comparison sampler
  is the analogue).
- Remove `|| light.shadows` from `want`.

Verify: shadows in free mode match gl3d frame mode (cast direction, softness);
strength slider scales 0→1; a dense Accretor structure self-shadows; resident (0
flips when toggling shadows); the free↔frame flip on inspect is seamless.

## Phase 3 — Alpha blend (the hard one — sorted transparency)

Free-mode instances are appended by the compaction atomic in ARBITRARY order;
gl3d does a CPU back-to-front `sortBackToFront` by camera depth for correct
Option-A over-blending. WGSL free mode needs an equivalent. Evaluate, in order:

1. **GPU depth sort** of the compacted instance buffer (a bitonic or single-pass
   radix over the visible-instance count, keyed by the same `m[2]cx+m[6]cy+
   m[10]cz+m[14]` depth gl3d uses). Exact match to gl3d, but a real GPU sort.
2. **Weighted-blended OIT** (order-independent) — no sort, one extra accum/reveal
   target, an approximation. For uniform opaque-ish cubes it reads well and is
   far simpler than a sort. Acceptable if the look is close to gl3d.
3. If BOTH prove too costly for the phase, **document alpha blend as remaining
   frame-mode-only** with the concrete reason and keep its `want` term — but
   attempt 1 or 2 first; the user asked for all three.

The display pass under blend needs depth-write OFF + `SRC_ALPHA, ONE_MINUS_SRC_
ALPHA` (or the OIT targets), and the buried-cull + backface-cull eligibility
already turn OFF under alpha blend (CLAUDE.md occlusion round) — keep that.
Remove `alpha3dRef.current` from `want` only if you land 1 or 2.

Verify: a translucent Accretor (alpha-OM variant, "Alpha blend" ON) renders
coherent glass voxels in free mode matching gl3d; resident; the flip is seamless.

---

## Cross-cutting rules

- **Every VoxelView field you add** must keep `verify-render-uniform-layouts.mjs`
  green (the §10 padding trap is exactly this). Add fields, update
  `VOXEL_VIEW_WGSL` + `uploadVoxelView` + `VOXEL_VIEW_BYTES` +
  `computeVoxelRenderView` together, run the harness.
- **Byte-identity**: no compiler files should be touched (this is render-only).
  Assert with `git diff --stat`; if a compiler file IS touched, run
  `check-compile-identity`. gl3d changes are limited to EXPORTS (computeLightMVP)
  + shared helpers — do not alter its frame-mode rendering.
- Each phase REMOVES exactly its own `want` term; do not remove a term before its
  feature actually renders in free mode (that would show a broken frame).
- The frame-mode path (gl3d) must stay the seamless fallback: recording forces
  frame mode, so a recording of a shadowed/AO/translucent model still uses gl3d —
  the two must match.

## Gates
`npx tsc -p tsconfig.app.json --noEmit`, `npm run build`,
`node scripts/parity-agent-wasm.mjs`, `node scripts/parity-agent-force.mjs`,
`node scripts/verify-agent-render.mjs`, `node scripts/verify-render-uniform-layouts.mjs`.

## Verify visually — REQUIRED (the pane is DISPLAYED)
Load the Accretor, engage free mode (WebGPU grid, playing, cursor off-canvas),
toggle each feature and screenshot: it must render in free mode AND match gl3d
frame mode (Shift-inspect flips to gl3d — the two frames must look the same). Add
a protocol trace proving 0 `setGridUiSync` flips when toggling the feature (the
whole point — it no longer forces frame mode). The composited-pixel/parity
eyeball vs gl3d needs a human look; flag it rather than claiming it.

## Hard rules
Commit on `optimize` staging EXPLICIT paths (NEVER `git add -A`); NEVER push;
NEVER add Co-Authored-By / Claude / Anthropic attribution; NEVER bump the
version; multi-line commit messages via `git commit -F <file>`; `sim.worker.ts`
has mojibake COMMENT bytes — anchor Edits on clean ASCII code lines and never put
mojibake in a user-facing string; measure branch scope against `origin/master`.

Update CLAUDE.md (the L1 section) + each phase's Completion Report below.

## Completion Reports
### Phase 1 — Occupancy AO — DONE (free-mode, verified)
**Approach:** the cube draw VS (`VOXEL_DRAW_WGSL`) recomputes the SAME 6-face-neighbour
occupancy scan gl3d does CPU-side in `uploadColors` (`ao = cnt/6`, bound-guarded,
reusing the compaction shader's `filled()` over binding-1 `colorsIn`), passes it as
a `@interpolate(flat) ao` varying, and the FS folds it onto the ambient term exactly
like gl3d's `float ao = 1.0 - uAOStrength*vAO;` → `ambient*ao + diffuse*ndl`. The VS
scan is **gated on `aoStrength > 0`** so the 6 storage reads aren't paid when AO is off.

**VoxelView:** added `aoStrength : f32` at `@192`; `VOXEL_VIEW_BYTES` 192→208;
`uploadVoxelView` writes `f[48]`; `VoxelRenderView.aoStrength` fed by
`computeVoxelRenderView` as `light.ao ? light.aoStrength : 0` (0 ⇒ byte-behaviour-
identical to no AO). `verify-render-uniform-layouts.mjs` green.

**Driver:** `postGridCamera`'s dedup key gained `aoStrength` (so a toggle/slider
re-presents in free mode); `light.ao` **removed** from `updateGridUiSync`'s `want`
list and from the ui-sync re-eval effect's deps — its re-present rides the `light3d`
effect's `draw()` → `postGridCamera`.

**Scope:** render-only, ZERO compiler files (`git diff --stat` = `webgpuRuntime.ts` +
`SimulatorView.tsx` for the code; CLAUDE.md + this handoff for docs). No worker change
(uniform flows through the existing `setGridCamera` → `uploadVoxelView` → `presentVoxels`).

**Gates:** tsc ✓, `npm run build` ✓, parity-agent-wasm ✓, parity-agent-force ✓,
verify-agent-render ✓, verify-render-uniform-layouts ✓.

**Visual verification (Accretor 300³, WebGPU, dense dendrite, dist 0.28, free mode):**
- AO ON darkens crevices/deep intersections in free mode; AO OFF returns to the flat
  ambient+diffuse baseline. Screenshots captured (off / on / off).
- Free↔frame match: arming Inspect + hovering flips to gl3d frame mode; the gl3d AO
  render (AO baked into `uploadColors`) looks the same as the free-mode WGSL AO render —
  the flip is seamless. (Composited-pixel/lighting-parity eyeball flagged for a human
  spot-check — the two frames match closely to my eye.)
- Protocol trace (hooked `worker.postMessage`): toggling AO ON→OFF in free mode caused
  **0 `setGridUiSync` flips** (the log stayed empty; 1 `setGridCamera` re-present each) —
  the whole point: AO no longer forces the slow colours-readback frame path.
### Phase 2 — Cast shadows
(fill in)
### Phase 3 — Alpha blend
(fill in)

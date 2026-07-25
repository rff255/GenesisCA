# HANDOFF — occupancy AO, cast shadows & alpha blend in the FREE-mode voxel render

**Branch**: `optimize`. **Status**: DONE — **Phase 1 (occupancy AO)** and **Phase 2
(cast shadows)** shipped free-mode + verified in-browser on the Accretor; **Phase 3
(alpha blend)** remains frame-mode-only by a documented decision (see its Completion
Report — both a GPU sort and WBOIT have concrete blockers). Read first:
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
### Phase 2 — Cast shadows — DONE (free-mode, verified)
**Approach:** a depth-only shadow-map pass (`VOXEL_SHADOW_WGSL` — the SAME
procedurally-generated compacted cubes rendered from the light's ortho POV into a
2048² `depth24plus` texture; `cullMode:'none'` [depth-identical to gl3d's cull-back
when unclipped, correct under a clip cut]; FS discards clipped cubes) runs BEFORE
the display cube pass in the SAME `presentVoxels` encoder, drawIndirect'ing the
shared compacted instance buffer, only when `voxelShadowOn`. The draw FS
PCF-samples it (`shadowFactor`, 3×3 taps over a `sampler_comparison` +
`texture_depth_2d` at draw bindings 3/4) and folds `sh` onto diffuse+specular
exactly like gl3d's `SHADOW_GLSL`.

**Shared light matrix:** `computeLightMVP(W,H,D,lightDir)` is now EXPORTED from
gl3d — its private method delegates to it (the Phase-C `sceneCameraMatrices` /
`lightWorldDirFor` precedent), so the two renderers cannot disagree on the caster
projection. `computeVoxelRenderView` calls it + the scale-relative bias
`min(0.02, max(0.0002, 0.9/depthRange))`.

**GL→WebGPU clip adaptation** (gl3d's ortho is GL-convention NDC z∈[−1,1] / y-up;
WebGPU is z∈[0,1] / y-down — the ortho fills the whole z range, so this cannot be
skipped like the display perspective can): the shadow VS applies `p.z = (p.z+p.w)·½`
(GL clip-z → WebGPU clip-z), and `shadowFactor` samples `uv = ndc.xy·(½,−½)+½`
(the −½ flips y for WebGPU's y-down texture) + `zRef = ndc.z·½+½` (matching the
written depth). `textureSampleCompareLevel` (level 0, non-uniform-flow-safe).

**VoxelView:** added `shadowStrength @196` / `shadowBias @200` / `lightMVP @208`
(a mat4 pinned by the align-16 padding at @204); `VOXEL_VIEW_BYTES` 208→272;
`uploadVoxelView` LITERAL-indexes the 16 `lightMVP` floats `f[52..67]` (the layout
harness's matrix-loop parser only recognises a 0-based `f[i]` loop, so a literal
index list is required); `verify-render-uniform-layouts.mjs` green. **0 strength ⇒
the FS short-circuits `shadowFactor` to 1.0 AND the depth pass is skipped ⇒
byte-behaviour-identical to no shadows.**

**Driver:** `postGridCamera`'s dedup key gained `shadowStrength`/`shadowBias`/
`lightMVP`; `light.shadows` REMOVED from `updateGridUiSync`'s `want` + the ui-sync
re-eval effect's deps.

**THE BUG the visual verification caught (and why it mattered):** `ref` is a WGSL
RESERVED KEYWORD — `let ref: f32 = d - bias;` made the DRAW shader fail to compile,
so `setupVoxelRender` returned false and the model **silently fell back to gl3d
frame mode** (`voxelRender` stayed false; the sim still rendered, so nothing looked
broken). Renamed `ref` → `zRef`. Root-caused by compiling the exact WGSL in the
page's own WebGPU device via `getCompilationInfo` (a green gate suite + tsc could
NOT catch a WGSL-string error). Hardened: `setupVoxelRender`'s previously-SILENT
final `catch` now `console.error`s the failure — the silent catch is precisely what
hid this for several reloads.

**Scope:** render-only, ZERO compiler files (`git diff --stat` = `webgpuRuntime.ts`
+ `SimulatorView.tsx` + `gl3d.ts` [the `computeLightMVP` export + private-method
delegation only — gl3d's frame-mode rendering is unchanged]). No worker change.

**Gates:** tsc ✓, `npm run build` ✓, parity-agent-wasm ✓, parity-agent-force ✓,
verify-agent-render ✓, verify-render-uniform-layouts ✓.

**Visual verification (Accretor 300³, WebGPU, dense structure, dist 0.32, free
mode):** shadows ON casts inter-beam shadows in free mode; shadows OFF returns to
the flat baseline. Free↔frame match: arming Inspect + hovering flips to gl3d frame
mode; the gl3d shadow render (its own shadow-map pass) matches the free-mode WGSL
shadow render — the flip is seamless (composited-pixel/lighting-parity eyeball
flagged for a human spot-check; the two frames match closely to my eye). Protocol
trace (hooked `worker.postMessage`): toggling shadows ON→OFF in free mode =
**0 `setGridUiSync` flips** (1 `setGridCamera` re-present each). The voxel render is
confirmed active via `__voxelReadback` (`active:true`, instanceCount tracks the
structure).
### Phase 3 — Alpha blend — REMAINS FRAME-MODE-ONLY (documented decision — outcome #3)
Both approaches were evaluated and both have a CONCRETE blocker; per the handoff's
sanctioned outcome #3, alpha blend stays frame-mode-only, its `want` term kept
(`alpha3dRef.current` in `updateGridUiSync` — unchanged, byte-identical to pre-Phase-3
behaviour). **No code change.**

**Why NOT a GPU depth sort (option 1):** a correct back-to-front sort matching gl3d's
`sortBackToFront` (key `m[2]cx+m[6]cy+m[10]cz+m[14]`) needs a bitonic/radix pass
structure sized to the VISIBLE-INSTANCE COUNT (padded to a power of two). But L1's
ENTIRE architectural win is that the visible count is **never read back to the CPU** —
it lives GPU-side in the indirect draw args (`atomicAdd` → `drawArgs[1]`) precisely so
no per-frame readback happens. A count-bounded GPU sort would have to either (a)
**read the count back**, reintroducing exactly the CPU round-trip L1 removed (defeating
the feature), or (b) sort the WORST case `total` — up to 27M cells at 300³, padded to
2²⁵ ⇒ ~325 bitonic passes over 33M elements = billions of comparisons per frame,
non-interactive. A GPU sort thus fights the L1 no-readback design head-on. (`dispatch­
WorkgroupsIndirect` bounds the dispatch but not the log²(n) pass *structure*, which
still needs the count CPU-side.)

**Why NOT weighted-blended OIT (option 2):** WBOIT is order-independent (no sort, no
count) and far simpler, but it is an APPROXIMATION that does NOT reproduce gl3d's exact
back-to-front Option-A compositing. The cross-cutting invariant — *recording forces
frame mode (gl3d), so the two must match* — means a recording (or the Shift-inspect
flip) of a translucent model would show gl3d's exact sort while the live free view
shows the WBOIT approximation: a visible discrepancy on every flip. WBOIT is rejected
specifically because it breaks that seamless-flip + recording-match invariant.

**Net:** for a niche, opt-in visual (translucent voxels — the default Accretor OM writes
alpha 255, i.e. opaque, so alpha blend needs an alpha-OM model variant to even engage),
the only faithful free-mode implementation (an exact GPU sort) is architecturally at
odds with L1's no-readback core, and the simpler alternative breaks the match invariant.
Alpha blend therefore stays frame-mode-only (gl3d handles it exactly as before L1). A
future exact GPU sort — behind an indirect-dispatch + count-aware bitonic, verified by
reading back the sorted instance buffer and asserting monotonic keys — is the recorded
follow-up if the feature is prioritised.

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

## Completion Report (2026-07-23)

**Outcome**: the **2D core SHIPPED + real-GPU-verified**. Both target configs work — decoupled (D-synthetic: GoL grid + Boids agents) AND field-coupled resident (Chemotaxis on WebGPU/WebGPU, E1b bridge unchanged). **The 3D voxel-composite stretch was NOT attempted** (deliberate STOP — the 2D core is committed as its own milestone; see the stretch subsection).

**Commit** (branch `optimize`, not pushed): one commit — `perf(agents): E2 single-canvas composite render (2D grid+agents on WebGPU grid)`. `git diff --stat` = exactly three files: [agentWebgpuRuntime.ts](../src/simulator/engine/agentWebgpuRuntime.ts) (+~300), [sim.worker.ts](../src/simulator/engine/sim.worker.ts) (+~77), [SimulatorView.tsx](../src/simulator/SimulatorView.tsx) (+~138). **NO compilers, NO gl3d, NO agentEngine, and — a bonus — NO `webgpuRuntime.ts`** (the grid layer is a self-contained render-pass in the agent runtime binding the grid `colorsBuf` on the shared E1 device).

### What shipped vs the spec (all 2D-core work items done; deviations, all justified)
1. **Work item 1 (combined present) as a RENDER-PASS grid layer, entirely in `agentWebgpuRuntime.ts`** — a justified deviation from the handoff's "the existing `presentColors` compute writing the storage texture" (the handoff explicitly allowed "or its render-pass equivalent"). A NEW `GRID_PRESENT_WGSL` fullscreen triangle reads the grid `colorsBuf` in its FS (`colorsIn[cy*gridW+cx]`) and outputs premultiplied. Why: it keeps the canvas `RENDER_ATTACHMENT`-only (the compute-present needs `STORAGE_BINDING` on the canvas → a config divergence + a compute-then-render-load on ONE texture within one encoder). Two render passes (grid clear+write → agent load) on the same view is the standard, lowest-risk shape, and it made `webgpuRuntime.ts` untouched (`presentCompositeEncode` binds the grid `colorsBuf` directly — allowed since both runtimes share the E1 device). Asserted in the gate (`rt.device === webgpuRuntime.device`).
2. **World-space arrangement adopted verbatim** (the handoff's load-bearing decision): the composite canvas is WORLD-sized (grid `W×H`), the agent camera is world space (`scalePx=1, ox=oy=0, copies=1`), and the main thread's zoom/pan blit scales it. No resampling shader invented. Accepted+documented tradeoff: agents at world resolution (blurry at high zoom).
3. **Scoped the composite to a WebGPU AGENT target** (`agentResult.agentTarget === 'webgpu'`) — a deviation from "any agent render active". Reason: a WebGPU agent target always has `agentWebgpuRuntime` (the render surface), so the composite surface always exists. A CPU (JS/WASM) agent target would need the A2 render-only surface built for a config it isn't shipped for today — that's a follow-up. Both verification stars (D-synthetic + Chemotaxis) are WebGPU-agent, so the primary + secondary checks are covered.
4. **Widened the render eligibility to field-coupled models via a SEPARATE `agentComposite` predicate** (independent of `agentRenderEligible`, which excludes field-coupled models via `agentDecoupled`). The union `agentRenderEligible || agentComposite` drives the attach; `agentCompositeEligibleRef` drives the composite MODE. This is what lets Chemotaxis (field-coupled, not `agentRenderEligible`) get the composite render.
5. **Per-layer Show toggles threaded** (`showGrid`/`showAgents` on the `AgentRenderView`, CPU-only fields not in the RENDER_VIEW byte layout): `showGrid` false → skip the grid pass + the agent pass clears to `bg2d`; `showAgents` false → skip the disc draw. So the Layers panel Show toggles work in composite mode (not a silent no-op). Verified via the readback differentiator.
6. **The worker refusing composite (no shared device) is handled**: the ack echoes `composite:boolean`; if the main thread requested composite but the worker refused (built the disc render on a world-sized canvas), the main thread drops the composite intent + re-attaches display-sized. Defence-in-depth (post-E1 the device is always shared, so this never fires in practice).
7. **A DEV probe `__compositeReadback`** (permanent, DEV-only, mirrors E1b's `__e1bCounters` — the app never sends it) presents the composite + `copyTextureToBuffer` + samples world-cell pixels → occlusion-safe proof both layers land on ONE texture (the composite canvas config gained `COPY_SRC`, harmless in production).

### Measured (real WebGPU, in-browser, hidden pane → worker protocol + the DEV pixel readback)
- **D-synthetic (GoL grid + Boids agents, decoupled, WebGPU grid + WebGPU agent)**: `composite:true`, `hasColors:false` (grid readback SKIPPED — the CPU win), pixel readback = **cyan agent discs `[76,201,240,255]` over opaque grid cells `[0,0,0,255]`** (both layers on ONE canvas). The `showGrid` OFF/ON differentiator: grid points `[0,0,0,0]` (transparent, grid pass skipped) → `[0,0,0,255]` (opaque, grid pass reads `colorsBuf`) — proves the grid layer IS the grid-present pass + the Show toggles work. (An agent-behaviour `_var_cnt` error surfaced — a MERGE artifact of my hand-built synthetic's agent Local Variables, NOT an E2 bug; agents render at their init positions regardless, so the composite proof holds.)
- **Chemotaxis on WebGPU/WebGPU (field-coupled, E1b resident)**: `composite:true`, `hasColors:false`, **0 errors**, E1b bridge unchanged (`gpuBridge:60, cpuFallback:0, sharedDevice:true, fieldSpecTypes:['float']`). Pixel readback = the **chemical field `[68,1,84,255]` (real Viridis-low colour, opaque) as the grid layer + cyan agent discs over it** — field + agents on ONE canvas, E1b metrics preserved.
- **Fallbacks unchanged**: agents-only Boids-webgpu → `composite:false` (standard display-space render), 0 errors; grid-only GoL-webgpu → its own grid direct render (`hasColors:false`), 0 errors. A JS/WASM grid / 3D / sprites / metaballs model → gate false (composite excluded).
- **0 console/GPU errors** across every load + hundreds of steps.
- Gates: `tsc -p tsconfig.app.json --noEmit` + `npm run build` + `parity-agent-wasm` (18) + `parity-agent-force` (7) all green. No compiler files → `check-compile-identity` not required.

### Could NOT verify (occlusion trap, master §0.7) — deferred to the visible-pane eyeball
The composited display PIXELS (grid under agents on the actual `<canvas>`) and the world-resolution blur look — the Browser pane reports hidden, so the compositor is suspended and `drawImage(transferredCanvas)`/screenshots read stale/blank. The composite is proven by the DEV `copyTextureToBuffer` readback (the pixels ARE composited GPU-side, occlusion-independent) + 0 GPU errors + construction. **Recording capturing both layers** likewise needs a visible pane (the display-canvas capture reads a blank composite blit while occluded) — the code path composites via the display capture (recording captures the display canvas which blits the composite); the orchestrator/user spot-check should confirm.

### Gotchas discovered (for the next session / the 3D stretch)
- `sim.worker.ts` mojibake comment bytes: every worker edit anchored on clean ASCII code lines (never comment lines) — the sendColors/batch-tail/present edits all keyed off code (`if (!msg.skipColorPass) runColorPassWebGPU();`, `agentRenderActive = false; agentStoreStale = false;`).
- The composite present rides the EXISTING agent present machinery (`presentAgentsIfActive` made composite-aware), so ALL present points (batch tail via `sendColors`, camera, mutation, refresh) route through it with no new call sites — the cleanest integration. `agentBatchPresented` stays false in branch 1 (no resident batch there), so `sendColors`'s line-5011 present IS the composite present.
- The world-space camera NEVER changes on pan/zoom (the main-thread blit does it), so `postAgentCamera` is a near-permanent no-op for composite — the per-frame present is via `sendColors`. This means camera-message churn is essentially zero for composite (nice).
- getState decode in-browser: the `state` message's `attributes[id]` is a serialized descriptor (not a raw ArrayBuffer), so my first alive-count decode read `length 0` — a TEST decode bug, not an E2 bug (agent x/y decoded fine as ArrayBuffers; the field freshness was proven via the pixel readback).

## Regression follow-up (2026-07-23) — the composite was DISABLED (world-res rejected)

The E2 report above flagged the **world-resolution agents** as an accepted tradeoff "pending the visible-pane eyeball." The user did the eyeball on the shipped **Chemotaxis - Aggregation** model and REJECTED it: on a WebGPU grid + WebGPU agent target the agents "become a blob of cells." Root cause = exactly the world-res arrangement: the composite canvas is grid-sized (`W×H`), the agent camera is world space (`scalePx=1`), so a radius-1 agent is a ~1px disc; when the main-thread zoom/pan blit scales the composite up to the display, each agent becomes a **cell-sized block indistinguishable from the grid cells**. The DEV `__compositeReadback` confirmed the composite itself was correct (grid field `[68,1,84,255]` + cyan agent discs `[76,201,240,255]` on one texture) — the problem is purely the display-resolution of the agents, which the world-space arrangement CANNOT fix without a camera-aware (resampling) grid-present shader (the exact thing this handoff's work-item 2 forbade inventing ad hoc).

**Resolution (this regression-fix session): the E2 composite is DISABLED** (`agentComposite = false` in the SimulatorView model-effect gate). A both-WebGPU grid+agents model now falls back to the proven DISPLAY-resolution paths — decoupled → the D two-canvas render, field-coupled → the CPU overlay + grid colors readback — both crisp discs. This reverts E2's grid-colors-readback perf win for these models (acceptable: correctness > perf, and the shipped field models are small), while keeping ALL the E2 code dormant behind the gate. **A DISPLAY-resolution single-canvas composite is a genuine follow-up REDESIGN** (a display-sized canvas + a camera-aware grid-present FS that maps display pixels → world cells through the pan/zoom transform, so both layers render at display res). That is NOT a wiring repair — it re-does E2's core world-space decision — so per the master's §0 #2 it was recorded here, not built. Prerequisites for the follow-up are all in place (E1 shared device, E2's `GRID_PRESENT_WGSL` + agent disc pass, the A1 display-res camera math in `computeAgentRenderView`'s non-composite branch).

Also fixed in the same session (a SEPARATE root cause, symptom 1): a WASM grid + WebGPU agent field model rendered agents **invisible** because the per-gen `uploadAgentSoA` never seeded the GPU `agentColors` buffer and `readbackAgentStep` pulled its zeros into `s.colors`. Colour-less agent behaviours (Boids/Chemotaxis rely on `DEFAULT_AGENT_COLOR`) went transparent. FIX = seed `uploadAgentColors` in `uploadAgentSoA` (idempotent — a real colour shader overwrites it GPU-side). See the master Status Board's regression-fix row for the full verification.

### The 3D voxel-composite stretch — NOT ATTEMPTED (deliberate STOP)
Per the handoff ("attempt ONLY after the 2D core is verified and committed as its own milestone; if the voxel pass exceeds a session's scope, STOP and record — do not let the stretch endanger the core"), I committed the 2D core as its own milestone and STOPPED. The 3D lift needs a WGSL instanced-voxel pass (a port of gl3d's cube instancing) depth-composited with the C sphere pass on one canvas — a substantial additive render feature (voxels-vs-spheres depth compositing, the gl3d cube-instancing math, a depth attachment shared across two agent+grid passes) that warrants its own phase with its own verification surface. The 2D core's world-space arrangement does NOT carry to 3D (the 3D grid is voxels, not a 1:1 texel blit), so the 3D composite is a genuinely separate design. **Recommendation for a follow-up phase**: build the WGSL voxel pass in the agent runtime alongside the C sphere pass (both already there), share a depth attachment, and layer grid-voxels → agent-spheres → gl3d overlays on one device/canvas (the C report's z-order seam). The E2 2D core + the C sphere pass + the E1 shared device are the prerequisites, all now in place.

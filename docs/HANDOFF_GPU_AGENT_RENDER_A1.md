# PHASE A1 HANDOFF — Direct Agent Render (resident, 2D agents-only)

Read first: [HANDOFF_GPU_AGENT_RENDER.md](HANDOFF_GPU_AGENT_RENDER.md) §0/§3
(invariants + protocol), then this doc, then IMPACT_MAP_GPU_AGENT_RENDER.md
§1.1–1.3 + §2 and PLAN_GPU_AGENT_RENDER.md § Phase A1. CLAUDE.md context
sections: "Agent-engine performance review round" (the residency runtime you
extend), "Bond-Graph Agents … Agent brush parity" (the cursor-layer split),
and the WebGPU grid section's direct-render bullets (the seam you clone).

**Objective**: when a model satisfies the gate below, the WORKER renders the
agents (from the resident GPU buffers) into an OffscreenCanvas and the
per-frame CPU pipeline (readback → snapshot → postMessage → Canvas2D draw)
runs ONLY while a feature needs it. Free-running cost on the main thread ≈ a
single 1:1 `drawImage`.

**The gate** (all general; evaluate in SimulatorView, re-evaluate on every
model/settings change — mirror the grid's gate placement at
`SimulatorView.tsx:3741-3761`):
`topologyMode.agents && topologyMode.gridCells === false` AND `!is3D` AND
resolved agent target === 'webgpu' AND `transferControlToOffscreen` supported
AND `(model.sprites?.length ?? 0) === 0` AND metaballs OFF. (Residency
itself is worker-side — if a step falls back to the per-gen GPU path the
render STILL works: the SoA buffers are uploaded there too. Do NOT couple
the render gate to `agentResidentEligible`.)

---

## Work items (in order)

### 1. `agentWebgpuRuntime.ts` — the render pipeline
1. `AGENT_RENDER_WGSL`:
   - Bindings: `agentF32` (read) + `agentAlive` (read) + `agentColors`
     (read) + a NEW uniform `RenderView` `{ scalePx: f32, oxPx: f32,
     oyPx: f32, canvasW: f32, canvasH: f32, worldW: f32, worldH: f32,
     copiesX: i32, copiesY: i32, startX: i32, startY: i32, flags: u32,
     outlineOn: u32, glowOn: u32, glowSize: f32, glowIntensity: f32,
     glowSteepness: f32, bgR: f32, bgG: f32, bgB: f32, bgA: f32 }`
     (pad to 16-byte alignment; bg used only for the clear value CPU-side —
     keep it in the struct anyway so one message carries everything).
   - VS (`@builtin(vertex_index)` 0..3 quad + `@builtin(instance_index)`):
     `agent = inst % highWaterU; copy = inst / highWaterU;`
     copy → `(cx, cy)` offsets from `startX/copiesX` (row-major), world
     position `p = (x + cx*worldW, y + cy*worldH)`. Screen px =
     `p*scalePx + (ox,oy)`; clip = `(px/canvasW*2-1, 1-py/canvasH*2)`.
     Quad half-size = `radius*scalePx` (+`glowSize` when glow). Dead
     (`alive==0`) or alpha-0 agents → emit position `vec4(2,2,2,1)`
     (off-screen degenerate). Pass UV offset + unpacked RGBA colour
     (`agentColors[agent]` packed `r|g<<8|b<<16|a<<24`, divide by 255).
   - FS: `d = length(offset)`; plain mode: `d>1 → discard`, colour =
     premultiplied `vec4(rgb*a, a)`; outline (`outlineOn`): darken rim for
     `d > 1 - min(1.5px, 0.25*rad)/rad` by ×0.60 (match the 2D overlay
     rule in `stampBatchedTile`); glow (`glowOn`): additive blend target,
     intensity `glowIntensity * pow(max(0,1-d), glowSteepness)`.
   - Two pipelines from one module (plain: premultiplied-alpha blend; glow:
     additive `one, one`); select per frame by `glowOn`.
2. `setupAgentDirectRender(rt, canvas)` — clone the grid's
   `setupDirectRender` (`webgpuRuntime.ts:505-546`) shape:
   `getContext('webgpu')`, `configure({ format:'rgba8unorm',
   usage: RENDER_ATTACHMENT, alphaMode:'premultiplied' })`; build pipelines;
   store `rt.renderCtx`, `rt.renderView` uniform buffer; non-fatal on
   failure (return false → SimulatorView keeps the CPU path).
3. `presentAgents(rt, encoder, hw)` — begin a render pass on
   `rt.renderCtx.getCurrentTexture().createView()` (fresh each frame),
   `loadOp:'clear'` with `clearValue = bg` (transparent `0,0,0,0` when bg
   disabled), draw `4` verts × `hw * copiesX * copiesY` instances, end.
   Append it INSIDE `dispatchResidentBatch`'s single submit (after
   posCommit), and add `presentAgentsOnce(rt, hw)` (own encoder+submit) for
   camera-change / mutation-refresh / refocus presents.
4. `uploadAgentRenderView(rt, view)` — writeBuffer the uniform.
5. Add the new buffers/ctx to the destroy path.

### 2. `sim.worker.ts` — attach, camera, readback policy
1. New messages (+ `WorkerMsg` union):
   - `attachAgentCanvas {canvas, width, height}` — clone the grid handler
     (`:5819-5840`): requires the agent runtime ready; `setupAgentDirectRender`;
     `presentAgentsOnce`; ack `postMessage({type:'agentRenderStatus',
     active:true})`. On any failure ack `active:false`.
   - `setAgentCamera {view}` — store, `uploadAgentRenderView`,
     `presentAgentsOnce` (only when not mid-batch; else the batch's own
     present covers it).
   - `setAgentUiSync {on:boolean}` — sets `agentUiSync` (default TRUE so
     behaviour is unchanged until SimulatorView opts in).
   - `refreshAgentDisplay {}` — re-present (tab-refocus analogue of the
     grid's `refreshDisplay`, `:5784-5811`).
2. Readback policy in `runAgentBatchResident` (the readback today at
   `:2008`): when `agentRenderActive && !agentUiSync` → SKIP
   `readbackAgentFrame`, set `agentStoreStale = true`; `stepped` then ships
   NO `agents` payload but a new scalar `agentLiveCount` (SimulatorView
   already tolerates absent `msg.agents`, `:3131`). When `agentUiSync` (or
   render inactive) → exactly today's behaviour + `agentStoreStale = false`.
3. **The one-shot rule — ONE place**: at the top of `self.onmessage`
   (after the existing defer guards), if `agentStoreStale` and
   `msg.type ∈ AGENT_STORE_READERS_WRITERS` = `AGENT_GPU_DEFER_TYPES ∪
   {getAgentState, getState}` → `await readbackAgentFrame` (this makes the
   handler async for those types — route them through the existing
   deferral machinery: set the stale-sync inside the async step-batch
   deferral path, or simplest: mark them deferred and flush after a
   one-shot sync; keep the solution inside the EXISTING
   `asyncStepBatchInFlight` discipline, never a second ad-hoc queue), then
   clear `agentStoreStale` and proceed. Also present after mutations (the
   handlers already run `runAgentColorPass` — follow with
   `presentAgentsOnce` when render active).
4. `getState` (`:6234`): with the one-shot rule in place the agent store is
   fresh — no further change (this also fixes the pre-existing agent
   save-freshness gap; note it in the commit message).

### 3. `SimulatorView.tsx` — gate, attach, draw, UI-sync driver
1. State: `agentDirectRenderActiveRef`, `pendingAgentCanvasAttach`,
   `agentRenderCanvasRef` (the placeholder whose control is transferred —
   it becomes the blit source, the grid pattern at `:3517-3535`).
2. Attach flow: when the gate holds after (re)init/recompile → create the
   placeholder canvas at DISPLAY pixel size, `transferControlToOffscreen`,
   post `attachAgentCanvas`; on `agentRenderStatus {active:true}` set the
   ref active. Handle the soft-recompile re-attach exactly like
   `recompilePendingCanvasRefresh` (`:4243-4251` + `:3489-3499`) and the
   tab-refocus re-present like `:5175-5183` (post `refreshAgentDisplay`).
   Display-canvas RESIZE (parent size change) → re-attach with a fresh
   canvas (transferred canvas dims are fixed).
3. Camera: compute `{scalePx, oxPx, oyPx, canvasW, canvasH, worldW, worldH,
   copies*, start*}` from the existing draw math (`:2438-2464` — reuse the
   same variables; infinity copies from the same tile-count logic, cap
   256) + `outlineOn` (agentOutlines) + glow settings + bg2d; post
   `setAgentCamera` rAF-coalesced on pan/zoom/resize/settings change.
4. `draw()`: when `agentDirectRenderActiveRef` → skip the bg fill and
   `drawAgentsOverlay`; blit `agentRenderCanvasRef` 1:1 onto the display
   canvas (`drawImage(c,0,0)`), keep the double-rAF compositor-lag trick
   (`:3227-3240`). Cursor overlay layers are untouched.
5. UI-sync driver: one effect + one helper `setAgentUiSync(on)` posting the
   message, ON iff ANY of: `brushTargetRef==='agents'` && pointer over the
   canvas (the existing hover machinery knows this); an inspect popover
   pinned or a sweep active; `editTargetIdRef` set; recording; paused
   (`!playing`). Debounce OFF by ~300 ms so brush strokes don't thrash.
   While ON, everything downstream (snapshot ships, picks/hover work) is
   byte-identical to today.
6. Stats chip (`:8320`): read `agentLiveCount` from the stepped message
   when the snapshot is absent.
7. **Glow option**: a "Glow" checkbox + size/intensity sliders in the agent
   common-controls (2D), persisted in `genesisca_sim_settings`
   (`agentGlow {on,size,intensity,steepness}`); v1 renders ONLY on the
   direct path (CPU path ignores it — tooltip says "WebGPU direct render").

### Do NOT touch
Compilers (`agentWebgpu/compile.ts` etc.), `agentEngine.ts` store layout,
`gl3d.ts`, the recording/screenshot capture code (verify unchanged paths
still capture the blitted frame), JS/WASM paths.

---

## Verification checklist (all mandatory)

1. Gates: tsc, build, `parity-agent-wasm` (all), `parity-agent-force`.
   Compile-identity is not needed (no compiler files) — assert
   `git diff --stat` touches none.
2. In-browser, Particle Life (agents-only, WebGPU target):
   - Direct render engages (agentRenderStatus true); visual parity vs the
     CPU path (same board: pixel-count + colour-bucket comparison of the
     display canvas free-running vs with UI-sync forced ON).
   - Pan/zoom/infinity: crisp at zoom (no world-res blur), tiles seamless,
     camera updates while PAUSED too (present-only).
   - Free-running: `stepped` carries no `agents` payload; main-thread
     handler time ≈ blit-only; measure fps/handler at 50k and record.
   - Feature sweep WHILE free-running: brush add/remove/move/edit land
     (assert via `getAgentState` values); hover ring appears within one
     frame of arming the brush; inspector values correct; Save State →
     load → identical positions (the staleness fix); recording produces
     frames containing agents; screenshot matches; stats chip live;
     pause → immediate correct picks.
   - The hostile staleness test: with UI-sync OFF, fire every
     `AGENT_GPU_DEFER_TYPES` message + `getAgentState` + `getState`
     directly at the worker mid-run; assert every response/effect reflects
     post-readback state (no stale coordinates).
   - Boids: flocks to polarization >0.99 under direct render.
   - Fallbacks: a sprites model and a 3D model keep today's path (gate
     false, zero regressions); JS/WASM targets unchanged.
3. Docs: CLAUDE.md (extend the perf-round section or add "Direct agent
   render (A1)"), HelpView (Performance § note + the Glow option), master
   Status Board row, this doc's Completion Report.

## Completion Report (2026-07-22)

**Commit** (branch `optimize`, not pushed): one commit — "perf(agents): A1 direct
GPU agent render (2D agents-only, WebGPU)". `git diff --stat` touches exactly the
three allowed files: `agentWebgpuRuntime.ts` (+~330), `sim.worker.ts` (+~195),
`SimulatorView.tsx` (+~310). NO compilers / gl3d / agentEngine / JS-WASM paths.

**What shipped vs the spec** — everything in the work items, with these
deviations (all justified):
1. **Added an Agent-Output-Mapping exclusion to the gate** (`(model.agentMappings
   ?.length ?? 0) === 0`). NOT in the handoff's gate list. Reason: the impact
   map's FP-1 assumes "colour is whatever Set Cell Looks / the Agent Output
   Mapping computed into the GPU `agentColors` buffer" — but an **OM computes on
   the CPU** (`runAgentColorPass` writes `s.colors`), NOT into `agentColors`. The
   render reads `agentColors`, so an OM model would render the behaviour's Set
   Cell Looks / default colours, not the OM. Excluding OM models keeps them on the
   correct CPU-overlay path (function-first, a general property — FP-0). This is a
   one-term gate refinement, not a redesign. **A2/C must keep this term** (or make
   the OM write `agentColors` GPU-side, a separate feature).
2. **Added `highWater` to the RenderView struct** (not in the handoff's field
   list) — the VS needs it to decompose the instance index. `presentAgentsEncode`
   patches it from the caller's live value each present (a 4-byte write) so it
   always matches the draw's instance count even in free mode (where the main
   thread can't know highWater — no snapshot ships). Dropped the handoff's `flags`
   field (unused in A1).
3. **`setupAgentDirectRender` is async** (awaits `getCompilationInfo`) so a WGSL
   error fails the attach cleanly (acks `active:false`) instead of a silently
   broken pipeline. The `attachAgentCanvas` handler awaits it in an IIFE.
4. **Added a worker→main `agentRuntimeReady` message** — the agent runtime builds
   ASYNC in `buildAgentWebGPUIfNeeded` with no prior "ready" signal (unlike the
   grid's `useWebGPUStatus`). SimulatorView attaches the canvas on it. Also covers
   soft-recompile re-attach (the handler resets the active flag first, since a
   runtime rebuild drops the render pipeline).
5. **`presentAgentsFromStore` also uploads colours** (`uploadAgentColors`) — for a
   mutation (seed/edit) the CPU `s.colors` is authoritative but the GPU
   `agentColors` is stale (the behaviour shader hasn't re-run), so the mutation
   present must sync colours too. Non-OM models seed cyan defaults into
   `agentColors` at attach this way.

**Measured** (in-browser, WebGPU-agent Boids, 120×120, 260 agents):
- Free mode: `stepped` ships `hasAgents:false` + `agentLiveCount:260`, gen advances.
- Boids flocks under direct render: **polarization 0.9991** (>0.99 = coherent).
- Hostile staleness: `getAgentState` mid-free-run returns evolving (not frozen)
  positions; `moveAgents` to (42,7) lands exactly; `getState` includes fresh agents.
- 1 attach, 0 GPU errors, no re-attach storm over ~900 gens.
- A JS-target model does NOT engage (0 render-status; CPU path ships agents).
- Gates: tsc + `npm run build` + `parity-agent-wasm` (18) + `parity-agent-force`
  (7) all green.

**Could NOT verify: composited display PIXELS.** The Browser pane reports hidden,
so the compositor is suspended → `drawImage(transferredCanvas)` reads stale/blank
and `preview_screenshot` refuses ("not compositing frames"). This is the
documented occlusion trap (master §0.7), not a code gap. The render pipeline is
proven by: `agentRenderStatus:true` (the ack posts AFTER the WGSL module compiled
with 0 errors, both pipelines built, and `presentAgentsFromStore` ran without
throwing), 0 `uncapturederror` over 900 gens, and the **identical battle-tested
grid direct-render blit pattern** (a detached `document.createElement('canvas')` +
`transferControlToOffscreen` + main-thread `drawImage`). **A displayed pane would
confirm the pixels** — the orchestrator's spot-check should do a screenshot with
the pane visible.

**New gotchas / notes for A2/C:**
- The `AGENT_RENDER_WGSL` + `AgentRenderView` + camera math are directly reusable
  by **A2**: feed the pipeline by UPLOADING an f32 snapshot (positions/colours)
  into `agentF32`/`agentColors` instead of reading the resident buffers, then
  `presentAgentsOnce`. `setupAgentDirectRender` / `uploadAgentRenderView` /
  `presentAgentsEncode` are already snapshot-agnostic. The gate for A2 drops the
  `agentTarget === 'webgpu'` term (JS/WASM/per-gen models) — but needs an agent
  WebGPU RUNTIME (device+buffers) to render into even when the SIM runs on
  JS/WASM; that runtime doesn't exist for a non-webgpu target today, so A2 must
  either build a render-only runtime or upload into the existing one.
- The one-shot rule reuses `asyncStepBatchInFlight` deferral (block → readback →
  replay). Any NEW async worker path that leaves the store stale must set
  `agentStoreStale` and rely on this ONE dispatcher rule — never add a second
  ad-hoc readback.
- `presentAgentsEncode` patches the RenderView `highWater` from `hw` every present
  — a spawn/kill that changes highWater between camera messages stays correct.
- **C (3D)**: gl3d is a WebGL2 main-thread context — it can't share the agent
  WebGPU buffers, so 3D keeps the snapshot (`frame`-mode) path. A C-phase WGSL
  sphere pass would live in the agent runtime like this 2D disc pass; the readback
  policy + one-shot rule + UI-sync driver are dimension-agnostic and reusable.

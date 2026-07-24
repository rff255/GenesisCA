# PHASE HANDOFF — L1: Worker-side WGSL voxel render for 3D grids

Read first: [HANDOFF_LATTICE_GPU.md](HANDOFF_LATTICE_GPU.md) §0 Invariants + §3
Protocol + your Status Board row. Then this document top to bottom. Then
[IMPACT_MAP_LATTICE_GPU.md](IMPACT_MAP_LATTICE_GPU.md) §1 (feature matrix),
§2 (L1 row), §3 (risks 1, 4, 5, 6) and [PLAN_LATTICE_GPU.md](PLAN_LATTICE_GPU.md) §L1.
CLAUDE.md sections to read (NOT the whole file): "3D Grid CA" (PR6/PR8 + the
viewport rounds), "WebGPU Compile Target", and the agent arc's
"Direct agent render" + "Phase C" subsections.

---

## 1. Objective

A 3D CA grid on the **WebGPU** target must render **from the GPU, inside the
worker**, with **no per-frame colours readback, no colours postMessage, and no
main-thread `uploadColors` rescan** — while every existing 3D feature keeps
working via the readback policy.

**Measured target** ([PERF_REVIEW_LATTICE.md](PERF_REVIEW_LATTICE.md) §3):

| model | today | of which is simulation | after L1 (expected) |
|---|---|---|---|
| Accretor 300³ (27M cells) | **540 ms** worker + **218 ms** main thread | **2.35 ms** | ~10 ms/frame |
| Life3D 128³ (2.1M) | 70 + 17 ms | ≈ 0 (hidden) | ~5 ms/frame |
| Life3D 96³ (0.9M) | 36.9 + 7 ms | 2.8 ms | ~4 ms/frame |

Plus: 3.5–108 MB/frame of traffic removed and the 515 MB `instData`
reservation gone.

**This is the lattice twin of the shipped agent Phase C.** Read
[HANDOFF_GPU_AGENT_RENDER_C.md](HANDOFF_GPU_AGENT_RENDER_C.md) and its
Completion Report before writing code — the layering, the free/frame flip, the
camera message, the shared camera/lighting helpers, and the "every present-only
path needs a main-thread re-blit follow-up" lesson all transfer directly.

## 2. Gate (GENERAL properties only)

Engage the worker-side voxel render iff **all** hold:

```
model.properties.dimension === '3d' && (gridDepth ?? 1) > 1     // a real volume
&& the resolved GRID target is WebGPU (useWebGPU && !webgpuResult.error)
&& OffscreenCanvas + transferControlToOffscreen supported
&& !hasGlyphsInModel(model)          // glyphs are a main-thread overlay (already badge-rejected in 3D)
&& light3d.shadows === false && light3d.ao === false   // frame-mode features (§4)
```

Anything else — 2D, a JS/WASM 3D grid, a glyph model, shadows/AO on — keeps
today's path **byte-for-byte**. Agent 3D models are **out of scope for L1**: the
agent sphere pass already owns a layered canvas (Phase C), and composing voxels
with spheres in one depth buffer is a separate follow-up (recorded in
[PLAN_LATTICE_GPU.md](PLAN_LATTICE_GPU.md) and in the E2 3D-lift note). Gate L1
on `topologyMode?.agents !== true` for now and say so in the report.

**Toggling shadows or AO must detach free mode and re-attach when they go back
off** — exactly how the 3D alpha-blend toggle drives the agent sphere pass today
([SimulatorView.tsx](../src/simulator/SimulatorView.tsx) `alpha3d` effect).

## 3. Work items (in order)

### W1 — the WGSL voxel pass in `webgpuRuntime.ts`

Anchors: `setupDirectRender` ([webgpuRuntime.ts](../src/simulator/engine/webgpuRuntime.ts):475),
`dispatchColorPassAndPresent` (:1042), `dispatchStep` (:919), `dispatchCells` (:609).
Clone the **structure** of `setupAgentSphereRender`
([agentWebgpuRuntime.ts](../src/simulator/engine/agentWebgpuRuntime.ts):1448).

1. `setupVoxelRender(rt, canvas)` — configure the transferred `OffscreenCanvas`
   context (`format: 'rgba8unorm'`, `alphaMode: 'premultiplied'`, usage
   `RENDER_ATTACHMENT`), create a `depth24plus` depth texture sized to the
   canvas, compile the voxel shader module, validate with `getCompilationInfo()`,
   build the pipelines. Set `rt.voxelRender = true`.
2. **Instance compaction on the GPU.** A compute pass over `total` cells
   (`dispatchCells`, the 2-D tiling helper — **required**, a flat 1-D dispatch
   silently no-ops past 4.19M cells) that:
   - reads `colorsBuf[idx]`'s alpha; skips alpha 0;
   - applies the **buried-cell cull** under the same eligibility rule
     `gl3d.buriedCullEligible()` uses (cell gaps OFF ⇒ `cubeScale ≥ 1`, no alpha
     blend, no clip interval) — read the 6 face-neighbours from `colorsBuf`;
   - `atomicAdd`s an instance counter and scatters the cell index into an
     instance buffer.
   Then draw **indirectly** (`drawIndirect`) so the CPU never learns the count.
   The counter buffer is cleared with `enc.clearBuffer` in the same encoder.
3. **The render pass**: instanced unit cubes (36 verts), one instance per
   compacted cell. The VS must decode `(col,row,layer)` from the flat index with
   **integer math** (`u32` attribute + `uniform1ui`-equivalent u32 uniforms) —
   *never* route a cell index through f32 (the documented 2²⁴ corruption bug;
   27M > 2²⁴). World remap **must match gl3d exactly**: `col→+X`, `row→−Y`,
   `layer→−Z`.
4. **Uniforms**: MVP + camera basis + light direction + ambient/diffuse/specular
   + clip interval (lo/hi + axis, incl. the `'camera'` axis forward vector) +
   `uCubeScale` (cell gaps) + background colour + alpha-blend flag. Compute the
   MVP and light direction on the **main thread** with the ALREADY-EXPORTED
   `sceneCameraMatrices` ([gl3d.ts](../src/simulator/render/gl3d.ts):333) and
   `lightWorldDirFor` (:356) — the same single-source trick Phase C used, so the
   two renderers cannot disagree.
5. **Alpha blend**: when on, sort instances back-to-front. Do it on the GPU or
   accept unsorted-with-depth-write for v1 and **gate free mode off when alpha
   blend is on** (the simplest correct choice, and it mirrors the agent Phase C
   gate). State your choice in the report.
6. `presentVoxels(rt)` — encode compaction + render into ONE encoder + ONE submit.
7. `destroyVoxelRender(rt)` — release the depth texture, buffers and canvas
   context on every teardown path. Acquire/release the device **only** through
   [sharedGpuDevice.ts](../src/simulator/engine/sharedGpuDevice.ts).

### W2 — worker wiring in `sim.worker.ts`

Anchors: `finalizeStepWebGPU` (:3999) and its `wantColors` (:4040);
`sendColors` (:4958) and its direct-render short-circuit (:5076);
`case 'attachCanvas'` (:6154); the agent precedents `case 'attachAgentCanvas'`
(:6178), `case 'setAgentCamera'` (:6254), `case 'setAgentUiSync'` (:6276),
`case 'refreshAgentDisplay'` (:6304); the one-shot rule (:5138–5150);
`presentAgentsIfActive` (:884); `ensureAgentStoreFresh` (:905).

1. New messages `attachVoxelCanvas` / `setGridCamera` / `setGridUiSync` /
   `refreshGridDisplay`, mirroring the agent four.
2. Module state `voxelRenderActive` / `gridUiSync` / `gridColorsStale`,
   reset on EVERY runtime teardown (mirror lines :954 and :1145 for agents).
3. `wantColors` in `finalizeStepWebGPU` gains a `voxelRenderActive && !recording
   && inspectCellIdxs.length === 0 && gridUiSync === false` suppression arm —
   **structurally identical** to the existing `!rt.directRender` term, so the
   selective watched-attr readback and the reductions path are untouched.
4. `sendColors` skips the colours copy/transfer when the voxel render owns the
   display and UI-sync is off (extend the :5076 short-circuit condition), and
   presents the frame instead (`presentVoxels`), exactly like
   `presentAgentsIfActive`.
5. **The one-shot rule (critical).** Extend the SINGLE dispatcher gate at :5138
   so that when `gridColorsStale` and a message reads or mutates grid state
   (`getState`, `paint`, `paintManual`, `writeRegion`, `clearRegion`,
   `importImage`, `readRegion`, `setInspectCells`, `loadState`, `colorPass`),
   the worker blocks (`asyncStepBatchInFlight = true`), awaits a readback, then
   replays the message. **Do not add a second staleness mechanism.**
6. Present on every present-only path (mutation tails, `colorPass`,
   `refreshGridDisplay`, camera changes) — and remember the Phase C/A2 lesson:
   **the first present after attach must not be the only upload**, and the main
   thread needs a re-blit follow-up (double-rAF) after a camera post.

### W3 — main thread in `SimulatorView.tsx`

Anchors: the attach gate (:4243 — `… && !is3D && !agentModel`); the two-phase
`useWebGPUStatus` attach handler (:3898–:3971); the 3D branch of `draw()` (:2576)
incl. the `uploadColors` identity gate (:2683) and `clearVoxels` (:2694);
`postAgentCamera` / `computeAgentRenderView3D` (:2375) as the camera precedent;
the `alpha3d` detach effect.

1. Turn the `!is3D` exclusion into a positive 3D voxel gate (§2) and attach a
   **sibling canvas UNDER the gl3d canvas** (the Phase C layering: an absolutely
   positioned wrapper, sphere/voxel layer `z-index:1`, gl canvas `z-index:2`).
   Re-attach only on a REAL size change (`parentW/H >= 2`) — the occluded-pane
   attach-storm guard.
2. In `draw()`'s 3D branch: when free mode is active, call
   `r.setOverlaysOnly(true)` ([gl3d.ts](../src/simulator/render/gl3d.ts):1492),
   skip `uploadColors` entirely, show the voxel canvas; when frame mode is
   active, hide it and run today's code path verbatim.
3. Post the camera (rAF-coalesced + deduped) whenever the voxel canvas exists,
   reusing `sceneCameraMatrices` + `lightWorldDirFor` so the uniform matches
   gl3d bit-for-bit.
4. Drive `setGridUiSync`: ON while the pointer is over the GL canvas, a brush is
   armed, an inspect popover is pinned/sweeping, recording is on, or
   shadows/AO/alpha-blend are enabled; debounced OFF (~300 ms) otherwise.
   Mirror the agent `setAgentUiSync` driver.
5. Frame mode requires a colours buffer **in hand** before flipping (the Phase C
   "no blank frame" rule): keep showing the voxel canvas until `colorsRef` is
   populated.

## 4. Explicit scope boundary — shadows and occupancy AO

`gl3d` renders cast shadows via a shadow-map pass and occupancy AO via a CPU
6-neighbour scan baked in `uploadColors`. **Do not port them in L1.** Gate them
to **frame mode**: with either enabled the voxel render detaches and gl3d renders
the frame exactly as today (correct, just not accelerated). Document this in
CLAUDE.md and in the Lighting panel's tooltips. A WGSL shadow pass is a recorded
follow-up.

## 5. Do NOT touch

- **Any compiler file** (`src/modeler/vpl/compiler/**`). L1 reads `colorsBuf`,
  which all three targets already write. `check-compile-identity` must report
  **all models unchanged**; if it doesn't, you changed something you shouldn't have.
- `agentEngine.ts`, `agentWebgpuRuntime.ts`, the agent render/residency paths.
- `activeSet.ts` / sparse stepping (that is L3).
- The 2D render path, the JS/WASM step paths, `wasm/layout.ts`.
- The `asyncStepBatchInFlight` message-deferral semantics (that is L2, and even
  there only the fence relaxes).

## 6. Verification checklist (all mandatory)

**Static / harness**
- [ ] `npx tsc -p tsconfig.app.json --noEmit` clean
- [ ] `npm run build` clean
- [ ] `node scripts/check-compile-identity.mjs` — **every model unchanged on
      every surface** (capture the baseline on the pre-change commit via
      `git stash`)
- [ ] `node scripts/parity-agent-wasm.mjs` + `node scripts/parity-agent-force.mjs`
      green (nothing agent-side moved)
- [ ] `node scripts/bench-lattice.mjs` — CPU-target rows unchanged within noise
- [ ] `git diff --stat` shows ONLY `webgpuRuntime.ts`, `sim.worker.ts`,
      `SimulatorView.tsx` (+ optionally a small `gl3d.ts` export/no-op) and docs

**In-browser (real GPU, occlusion-safe — see master §3)**
- [ ] Life3D patched to 96³ + `useWebGPU:true` **engages** the voxel render
      (an ack message reports active; the voxel WGSL compiled with **0 errors**
      via `getCompilationInfo`; **0 GPU validation errors** via `pushErrorScope`)
- [ ] In free mode, `stepped` carries **no `colors`** and the generation advances
- [ ] **Correctness by buffer readback, not pixels**: `copyBufferToBuffer` the
      instance-count buffer and assert it equals an independently computed
      alive-cell count (alpha ≠ 0) from a `getState` — this is the definitive
      proof the compaction is right while occluded
- [ ] **Hostile staleness probe**: with free mode running, fire `paint`,
      `getState` and `setInspectCells` — each must reflect post-readback state
- [ ] Accretor 300³ (as shipped, WebGPU): measure `count:0` / `count:1` /
      `count:10` and report the new frame time + marginal ms/gen vs the review's
      540 / 2.35
- [ ] Shadows ON → detaches to frame mode; OFF → re-attaches. Same for AO and
      alpha blend
- [ ] **Fallbacks unchanged**: a 2D WebGPU model (Game Of Life) still direct-renders
      with no colours shipped; a 3D **WASM** model (Life3D default) still ships
      colours and renders through gl3d; a glyph model and an agent 3D model do
      NOT engage
- [ ] Recording in 3D still produces frames (frame mode via the UI-sync driver)
- [ ] 0 console errors across the whole session

**Deferred to an orchestrator/user spot-check in a VISIBLE pane** (say so in the
report — do not claim it): the composited voxel image, lighting parity with
gl3d, the clip interval / cell-gaps look, and the brush-plane overlay compositing
over the voxel layer.

## 7. Docs to update in this phase

- `CLAUDE.md` — the "3D Grid CA" section (a new subsection describing the
  worker-side voxel render, its gate, the free/frame policy, and the
  shadows/AO frame-mode boundary) + the WebGPU section's note that 3D no longer
  forces the readback path.
- `src/help/HelpView.tsx` — the 3D View / Lighting copy: shadows and occlusion
  are "high-quality mode" and cost per-frame CPU.
- This document's Completion Report + the master Status Board row.

## 8. Completion Report

`## Completion Report (<date>)`
- commits (hashes + one line each)
- deviations from this spec and why
- measured before/after (bench-lattice rows + the in-browser probes)
- the alpha-blend decision (§3 W1.5) and any other scope call
- new gotchas discovered (add the durable ones to master §0.7)
- what L3 (sparse on WebGPU) and the 3D grid+agent composite follow-up must know

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

## 8. Completion Report (2026-07-24)

**Commit** (branch `optimize`, not pushed): one commit — *perf(lattice): L1 worker-side WGSL
voxel render for 3D WebGPU grids*. `git diff --stat` = exactly the three files the checklist
allows plus docs: `webgpuRuntime.ts` (+~380), `sim.worker.ts` (+~150), `SimulatorView.tsx`
(+~250), `HelpView.tsx` (copy), `CLAUDE.md`, this doc, the master Status Board. **NO compiler
file, NO gl3d.ts, NO agent path, NO activeSet** — L1 is render/worker-only.

### What shipped vs the spec

All of W1/W2/W3 as written, with three deviations (all justified, all narrowing risk):

1. **§2's `light3d.shadows === false && light3d.ao === false` (and alpha blend) are enforced as
   FRAME-MODE terms, not ATTACH terms.** The spec's requirement is "toggling shadows or AO must
   detach free mode and re-attach when they go back off". Making them UI-sync terms achieves
   exactly that (free mode disengages, the voxel canvas hides, gl3d renders the frame verbatim,
   and switching them off releases free mode) with **no attach/detach churn, no canvas
   re-transfer, and one less way for the attach lifecycle to go wrong**. Verified through the
   real checkboxes for all three.
2. **`voxelRenderActive` is DERIVED (`voxelRenderOn() = !!webgpuRuntime?.voxelRender`), not a
   module flag.** The spec said "module state … reset on EVERY runtime teardown". A derived
   getter makes the reset structural: the pipelines die with the runtime and a rebuilt runtime
   starts `false`, so the documented "a REBUILT runtime must reset its flags" trap cannot bite.
   `useWebGPUStatus` carries the live flag so the main thread re-attaches after a rebuild with
   no extra message.
3. **No `gridColorsStale` flag.** W2.5 asked for the one-shot rule to cover grid state. It
   already does: the grid's one-shot mechanism is `gpuOwnsAttrs` / `ensureCpuAttrsFresh`, which
   `getState` / `paint` / `paintManual` / `writeRegion` / `clearRegion` / `readRegion` /
   `loadState` / `setInspectCells` / `colorPass` all honour today **because 2D direct render has
   exercised the identical state for years**. Free mode reproduces exactly that state
   (`gridDisplayOwnedByGpu()` extends the existing `rt.directRender` term). Adding a second
   staleness flag was explicitly forbidden by the spec; the only gap found was
   `requestColorsSnapshot`, whose GPU-readback arm was gated on `rt.directRender` — extended to
   include `rt.voxelRender`. The hostile probe passes (below).

**Alpha-blend decision (W1.5)**: option (b) — **gate free mode off when alpha blend is on** (the
simplest correct choice, mirroring the agent Phase C gate). No GPU sort was written. Alpha blend
therefore pins frame mode and gl3d does its back-to-front sort exactly as today.

**Two additions beyond the spec, both required for feature preservation:**
- `capture3dPixels()` — screenshot/recording in free mode composite the worker's voxel canvas
  UNDER gl3d's overlays-only `readPixels` output. Without it a screenshot taken mid-run would be
  "overlays over nothing" (recording is covered by the UI-sync flip, but a screenshot is a
  one-shot with no flip). A transferred canvas is still a valid `CanvasImageSource` — the same
  property the 2D direct-render blit relies on.
- `__voxelReadback` — a DEV-only probe (the `__compositeReadback` precedent; the app never sends
  it) that presents one frame and reads the indirect draw args back. This is the occlusion-safe
  correctness proof the checklist demands.

### Measured

**bench-lattice (CPU targets, A/B against the stashed pre-change tree)** — unchanged within
noise, as expected (on a CPU target `gridDisplayOwnedByGpu()` is one extra `false` per
`sendColors`): GoL 1024² wasm 12.3 → 12.3 ms/gen, 2048² wasm 50.4 → 51.5, JS 99.0 → 97.9.

**In-browser, real GPU, Accretor 300³ (27M cells), gens/frame = 1, interleaved A/B ×3** so
drift cannot favour either mode:

| | frame mode (= today's 3D path) | free mode (L1) |
|---|---|---|
| pair 1 | 614 ms | 155 ms |
| pair 2 | 769 ms | 124 ms |
| pair 3 | 753 ms | 123 ms |
| `count: 0` (fixed per-frame cost) | 860 ms | 8.7 ms |

**≈ 6.2× on the worker frame time**, and that is *before* counting what leaves the main thread:
the per-frame O(total) `uploadColors` rescan (bench: 54.9 ms at 300³ on this machine; 218 ms in
the review's measurement) and 103 MB/frame of copy + structured transfer, both gone entirely in
free mode. The marginal per-generation slope in free mode is ~1.6–2.7 ms, consistent with the
review's 2.35 ms GPU step — i.e. **the frame is now simulation-dominated instead of
render-dominated**, which was the phase's objective.

**Honesty note on the absolute free-mode figure**: on an occluded pane, per-frame latency at the
~100 ms scale is dominated by scheduling noise (a control experiment produced
`skipColorPass:true` *slower* than `skipColorPass:false` — physically impossible, so the noise
floor exceeds the residual). `getCurrentTexture()` on a canvas the compositor is not driving is
the likely stall. The **frame-mode side was tightly clustered (734–819 ms over 12 samples) and no
free-mode sample ever exceeded 244 ms**, so the sign and magnitude of the win are unambiguous;
the residual ~120 ms should be re-measured in a VISIBLE pane and is expected to be lower.

### Verification performed (all protocol/buffer-level, per master §3)

- Life3D 96³ + WebGPU **engages** — `voxelRenderStatus {active:true}` is posted only after BOTH
  WGSL modules compiled with **0 errors** (`getCompilationInfo`) and a present ran. 0 worker
  errors and 0 console errors across the entire session (the shared device's uncaptured-error
  handler posts a worker `error`, and none arrived over ~114 messages incl. many presents).
- Free mode: generations advance with **no `colors`** on `stepped`; frame mode ships them.
- **Compaction correctness by buffer readback** (the definitive occlusion-safe proof): the GPU
  instance count read out of the indirect draw args equals an independently CPU-computed count
  from a colours snapshot — **4432 = 4432** on the sparse state, and **12432 → 6600** on a solid
  20³ block (exactly 18³ = 5832 buried cells culled). Every sampled compacted index is a
  genuinely visible cell; `vertexCount === 36`. Toggling the buried cull via the camera uniform
  changes the count in step (8707 un-culled vs 2734 culled), so the clip-open case correctly
  keeps interior cells.
- **Hostile staleness probe** (free mode running): `getState` agrees with a colours snapshot
  **cell-for-cell over 884,736 cells, 0 mismatches**; `setInspectCells` on a live cell reports
  `alive: 1`; `paintManual` on a dead cell lands and reads back.
- Shadows / Occlusion / Alpha blend each flip the worker's `uiSync` to true via the **real
  checkboxes** and release it when unchecked.
- **Fallbacks unchanged**: 2D WebGPU GoL still direct-renders (`directRender:true`, zero
  `voxelRenderStatus` messages); 3D WASM Life3D ships colours with no attach; a glyph-3D model
  and an agent-3D model (Morphogenesis — 3D Tissue) never attach.
- **Recording** through the real button: Play → free mode → start recording flips UI-sync ON and
  `stepped` ships colours again → stop returns to free.
- **Recompile / runtime rebuild**: `useWebGPUStatus {ready:true, voxelRender:false}` → automatic
  re-attach → `voxelRenderStatus {active:true}`, and free mode resumes.
- Gates: `tsc -p tsconfig.app.json --noEmit`, `npm run build`, `check-compile-identity`
  (**25 models, all surfaces unchanged** — verified with a `git stash` pre/post capture),
  `parity-agent-wasm`, `parity-agent-force`, `verify-agent-render` all green.

**Deferred to an orchestrator/user spot-check in a VISIBLE pane** (explicitly NOT claimed): the
composited voxel image, lighting parity against gl3d's cubes, the clip-interval / cell-gaps look,
the brush-plane overlay compositing over the voxel layer, and a re-measure of the free-mode
frame time.

### New gotchas (durable — candidates for master §0.7)

- **The identity baseline must be captured with `git stash`, and confirmed reproducible.** My
  first `--capture` on the (clean) pre-change tree produced an Accretor whose WASM was 6736 bytes
  — the `skipIsolatedEmpty.enabled: true` variant — while three later captures all produced 2845
  (the shipped `enabled: false`). The stash-based pre/post comparison is 0 diffs, and the
  anomalous capture was never reproduced. **Capture twice and compare the two captures before
  trusting any DIFF**, or a phantom "you broke the compiler" will burn an hour.
- **Do not hand-post a message that a main-thread driver also owns.** Posting `setGridUiSync`
  directly left the driver's mirror (`gridUiSyncPostedRef`) disagreeing with the worker, so a
  later real UI action (start recording) *looked* like it failed to flip the mode. Drive the real
  UI, or re-sync the mirror first.
- **Per-frame latency measured on an occluded pane is unusable above ~10 ms.** Use interleaved
  A/B for comparisons and never quote an absolute.
- **A 27M-cell runtime rebuild can exceed a 30 s eval timeout** (`seedRngState` alone builds a
  108 MB Uint32Array). Any probe issued around a Recompile must be bounded by
  `performance.now()`, not left awaiting a worker reply.
- **A backtick inside a WGSL comment terminates the TS template literal** holding the shader.

### What the next phases must know

- **L3 (sparse stepping on WebGPU)**: L1 is what makes L3 visible at all — the render tax that
  hid the 2.35 ms step is gone, and the marginal per-gen cost is now the dominant term at 300³.
  The compaction pass here is the exact clear → atomic-count → scatter → indirect shape L3 needs
  for the active set, and `dispatchCells` + the 2-D index recovery are already proven at 27M
  cells. NB the compaction reads **`colorsBuf`**, not attrs, so an L3 active list is independent
  of it — but if L3 makes the step skip cells, the colour pass must still cover every cell whose
  colour can change, or the voxel render will show stale voxels (they are the same buffer).
- **The 3D grid+agents composite follow-up**: the voxel layer and the agent sphere layer are two
  sibling divs at `z-index: 1` and are currently mutually exclusive by gate. Compositing them
  needs ONE canvas with a shared depth buffer (both passes into one encoder), not two layers —
  the agent pass already has its own depth attachment, so the merge is a render-pass
  restructure, not a wiring change.
- **L5 (`instData` sizing)** still matters: it is the CPU renderer's buffer, which frame mode and
  every CPU-target 3D model still use.

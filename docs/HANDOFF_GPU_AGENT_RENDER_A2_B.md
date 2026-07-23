# PHASE A2 + B HANDOFF — Snapshot-Fed Renderer / Bin-Sorted Iteration

Read first: [HANDOFF_GPU_AGENT_RENDER.md](HANDOFF_GPU_AGENT_RENDER.md) §0/§3,
then this doc, then PLAN_GPU_AGENT_RENDER.md §A2/§B and the A1 doc's
Completion Report (A2 reuses its pipeline verbatim). One phase session per
LETTER (A2 is one session; B1 one session; B2 one session after refinement).

---

## A2 — the same renderer, snapshot-fed (JS / WASM / per-gen-GPU targets)

**Objective**: agent models on CPU targets (and non-resident WebGPU models)
lose the ~10 ms main-thread Canvas2D draw: the worker uploads the f32 render
fields to the SAME render pipeline A1 built and presents on the same canvas.
The CPU keeps simulating; only the DRAW moves to the GPU.

**Gate** (general): the A1 gate MINUS the WebGPU-target term — i.e. 2D +
agents-only + no sprites + metaballs off + OffscreenCanvas — for ANY agent
target. (Field-coupled/grid models stay CPU-drawn until Phase D.)

Work items:
1. `agentWebgpuRuntime.ts`: allow a RENDER-ONLY runtime — factor
   `createAgentRenderOnlyRuntime()` (device + the A1 render pipeline +
   three small upload buffers `x/y/radius+alive+colors`, capacity
   maxAgents) so CPU-target models don't build compute pipelines. Reuse
   `AGENT_RENDER_WGSL` unchanged (bind the upload buffers in place of the
   resident SoA — same struct layout: pad the upload to the `agentF32`
   stride OR add a second bind-group layout over tight arrays; prefer the
   tight-array variant `x[],y[],r[]` f32 + alive u32 + colors u32 with a
   shader `override`/const flag, keeping ONE WGSL source).
2. `sim.worker.ts`: after each CPU step batch (where `snapshotAgentsForRender`
   runs today), when render-active: write the fields into the upload
   buffers (`queue.writeBuffer` — ~0.6 MB at 50k) + `presentAgentsOnce`;
   ship the snapshot only under `agentUiSync` (same policy as A1 — the
   CPU store is ALWAYS fresh here, so no staleness rule is needed:
   one-shots serve directly).
3. `SimulatorView.tsx`: widen the gate; everything else from A1 (attach,
   camera, draw blit, UI-sync) is shared code — no duplication.
4. Verify: Boids on the JS target and on WASM — identical dynamics
   (bit-parity harness unaffected), draw handler ≈ blit-only, feature sweep
   as in A1 (staleness test not applicable), fallbacks intact. Record the
   handler-ms before/after at 50k on the WASM target.

## B1 — bin-sorted mirror for the ENGINE force pass (no compiler changes)

**Objective**: the resident hash build additionally scatters a bin-SORTED,
field-major mirror of the fields the ENGINE force pass reads (`x,y[,z],
radius, vx,vy[,vz]`) + `sortedId`; the force shader's neighbour scan
iterates `binStart[b]..binStart[b+1]` runs against the mirror (coalesced)
instead of indirecting `hashBinAgents[j] → agentF32[...]`. Writes (force
accumulate, velocity integrate) stay canonical via `sortedId`.

Work items:
1. `agentWebgpu/layout.ts` runtime side (`agentWebgpuRuntime.ts`): mirror
   buffer (fields × maxAgents f32) + `sortedId` (u32 × maxAgents); the
   existing scatter pass (`emitHashScatterWGSL`) extends to also write the
   mirror + id (same atomic cursor — one extra store per field).
2. `forcePass.ts` (resident variant only): the scan loop reads the mirror;
   the self agent still reads canonical (its own slot). Behaviour shader is
   UNTOUCHED in B1.
3. Gating: mirror pass + mirrored scan only on the resident path; the
   per-gen path is unchanged. If the force scan is skipped entirely
   (`doDensity`/collision off — the density-skip), do NOT build the mirror
   (`needScan` flag) — zero cost for pure-custom-force models.
4. Verify: `parity-agent-force.mjs` still bit-exact for the CPU targets
   (untouched); GPU: exact neighbour-SET equality on a frozen frame (dump
   per-agent neighbour counts with and without the mirror on the same
   uploaded state — counts and SUMS must match; float ORDER may differ →
   assert |Δ| within f32 reorder tolerance); soft-collision gas model:
   statistical equivalence (min-pair-distance trajectory) + bench numbers
   at 10k/50k dense.

## B2 — fused gather in the compiler (REFINE BEFORE LAUNCH)

Design (from the plan): when `forEachInArray` directly consumes a
`getNearbyAgents` array, emit the loop as bin-run iteration over the mirror,
reading neighbour FIELDS (incl. agent attrs — extend the mirror to attr
runs when this fires) from sorted storage; materialize `sortedId[s]` only
where the body consumes IDENTITY (Form Bond targets, applyForceToAgent ids,
ids stored to variables/arrays, id comparisons). Unfusable shapes keep the
canonical path.

The orchestrator must refine this into exact emitter work items after B1's
report (mirror layout finalized) — including: the identity-consumption
analysis (a small backward walk from the forEach element uses), the
`AGENT_VALUE_NO_HOIST`/scratch-slot interactions, and a parity plan
(statistical stance + frozen-frame neighbour-set equality + the full
`check-compile-identity` baseline discipline, since this TOUCHES COMPILERS).

## Completion Reports
(one per session — A2 / B1 / B2)

### A2 Completion Report (2026-07-22)

**Commit** (branch `optimize`, not pushed): one commit — "perf(agents): A2 snapshot-fed
agent render for CPU targets". `git diff --stat` touches exactly the SAME three allowed
files as A1: `agentWebgpuRuntime.ts` (+~110), `sim.worker.ts` (+~55),
`SimulatorView.tsx` (+~30). NO compilers / gl3d / agentEngine / JS-WASM paths.

**Key realization** — A1's render pipeline was already snapshot-agnostic:
`presentAgentsFromStore` uploads positions+colours from the CPU store and presents.
The core A2 work was therefore (a) a WebGPU render RUNTIME for CPU targets (none exists
today — the agent WebGPU runtime is only built when `agentTarget === 'webgpu'`), and
(b) widening the gate. Nearly all of A1 (camera, attach handshake, UI-sync driver,
`draw()` blit, the `sendColors` per-batch present) is reused UNCHANGED.

**What shipped vs the spec** (deviations, all justified):
1. **Parameterize over copy (the orchestrator's steer), not a second WGSL variant.** The
   handoff work item 1 floated a tight `x[],y[],r[]` bind-group variant with a shader
   `override`. Instead: define `AgentRenderSurface` (device + layout + the three render
   buffers + render-pipeline state); `AgentWebGPURuntime` is structurally a superset, so
   every render helper is retyped to `AgentRenderSurface` and takes BOTH. The render-only
   runtime allocates the FULL `agentF32` buffer (so the baked x/y/radius bases in the
   UNCHANGED `AGENT_RENDER_WGSL` stay valid) but a new tight `uploadAgentRenderFields`
   writes ONLY the x/y/radius runs [0,hw) + full alive + colours (~1 MB at 50k). ONE WGSL
   source, one bind-group layout, no shader flag. Cleaner than a second variant.
2. **CPU render-ready signal reuses `agentRuntimeReady`.** `buildAgentWebGPUIfNeeded`
   posts `agentRuntimeReady` for a CPU target too (when a render layout is pending), so
   the ENTIRE main-thread attach/re-attach/refocus machinery is IDENTICAL to A1. The
   render-only surface is then built lazily inside `attachAgentCanvas` (device acquisition
   is async there anyway). No new attach path.
3. **Present rides the EXISTING `sendColors` path.** `presentAgentsIfActive()` was made
   surface-dispatching (webgpu → full `presentAgentsFromStore`; CPU → tight
   `presentAgentRenderFromStore`). Since `sendColors` already calls it on every step
   batch + mutation, the CPU present + free-mode snapshot-skip work with ZERO new
   worker call sites — `sendColors` is target-agnostic.
4. **`agentRenderLayout` is computed in `compileAgentModel` for CPU targets** (minimal
   `computeAgentWebGPULayout(maxAgents, 0, undefined, [], { gridDepth: 1 })`) and shipped
   in BOTH init + recompile messages via `agentResult`, so a soft recompile carries it
   for free. gridDepth is hardcoded 1 (A2 render is 2D-only; the gate excludes 3D).
5. **Gate: dropped the `agentTarget === 'webgpu'` term; RELAXED the OM-exclusion to
   `agentTarget !== 'webgpu' || agentMappings.length === 0`** (a refinement of the
   orchestrator's steer). The CPU present ALWAYS uploads `s.colors` (CPU-computed by
   `runAgentColorPass`, INCLUDING OM colours), so OM models on a CPU target render correctly
   (verified: 6 OM species colours; Particle Life is `agentTarget: 'wasm'`). **The OM
   exclusion is KEPT for the WebGPU target** — a resident WebGPU batch presents the GPU
   `agentColors` the behaviour wrote, NOT the CPU OM `s.colors`, so a WebGPU+OM model would
   show behaviour/default colours; it stays on the CPU overlay until A1.5. (An earlier draft
   dropped the OM term entirely; corrected in this session to avoid that WebGPU+OM
   regression — the orchestrator's "OM on CPU targets" intent is met exactly.)

**Verified in-browser** (hidden pane → worker protocol + snapshot VALUES, not composited
pixels — the occlusion trap, master §0.7):
- **Particle Life on WASM (agentTarget wasm) + 1 Agent Output Mapping ENGAGES A2**:
  `agentRenderStatus:true`, `runtimeReady:1`, 0 errors. Its snapshot `s.colors` carries
  **6 distinct OM species colours** (~300 agents each) — the exact buffer the render uploads
  via `uploadAgentColors`. (The A1-excluded case now works.)
- **Boids on the JS target (agentTarget None→js) ENGAGES** (`active:true`) and flocks to
  **polarization 0.998** under A2 direct render.
- **Free mode** (UI-sync OFF): `step` ships a stepped message with NO `agents` payload +
  `agentLiveCount` (verified 1800 AND 50000). UI-sync ON resumes snapshots.
- **Fallbacks keep the CPU overlay** (no attach, `renderStatus` never active): Particle Life
  **3D**, **Ant Necrophoresis** (grid+agents), and a **sprites** model.
- **0 console/worker errors** across all loads/steps/mutations at 50k agents.

**Measured** (50k Particle Life, WASM target): per-frame main-thread busy-time via an
idle-probe — sync ≈ 126 ms, free ≈ 114 ms (**~12 ms delta**). INDICATIVE not authoritative:
the hidden pane's display canvas is 0 px, so `drawAgentsOverlay` (the ~10 ms real cost A2
removes) is a partial no-op and the idle-probe is contaminated by listener ordering + queued
worker work. The real handler-ms savings need a VISIBLE pane (same occlusion limit A1 hit;
A1's pixels were user-confirmed separately). The ~12 ms delta is roughly consistent with the
"~10 ms Canvas2D draw" the objective cites.

**New gotchas / notes for B1 / C / A1.5:**
- **The re-attach storm while occluded is PRE-EXISTING A1 SHARED behaviour, not an A2
  regression** — decisively confirmed: Boids on the **webgpu** target (A1 path) storms
  IDENTICALLY (652 attach/1.5s) in the same hidden pane. Root cause: the hidden pane's
  `canvas.parentElement.clientWidth === 0`, so `maybeAttachAgentCanvas` attaches at 1×1 but
  `draw()`'s resize-check sees `dims.w (1) !== parentW (0)` → detach + re-attach loop. A REAL
  display width → `dims === parentW` → no storm. It's occlusion-only + lives in A1's shared
  `draw()`/attach code (out of A2's scope). **The orchestrator's visible-pane spot-check will
  see no storm.** If a future phase wants to harden it, guard `maybeAttachAgentCanvas` + the
  `draw()` resize-check against a 0/degenerate parent size (A1 shared code).
- **A1.5 is now moot on CPU targets** and the WebGPU+OM case is safely gated. A2 covers
  OM-coloured models on CPU targets (the CPU present always uploads `s.colors` = OM colours).
  A2's gate KEEPS the OM exclusion for the WebGPU target (`agentTarget !== 'webgpu' ||
  agentMappings.length === 0`), so a WebGPU+OM model stays on the CPU overlay (A1 behaviour,
  correct colours) — NO regression. A1.5 remains needed ONLY to let a WebGPU-target OM model
  use the resident fast path: compile the agent OM graph into a GPU colour pass writing
  `agentColors` (the agentWebgpu emitters already do this for behaviour Set Cell Looks). When
  A1.5 lands, drop the `agentTarget !== 'webgpu'` half of A2's OM term.
- `AgentRenderSurface` + the tight uploader + `createAgentRenderOnlyRuntime` are reusable by
  **C (3D)** if a 3D WGSL sphere pass is ever fed from the CPU store the same way.
- The render-only surface has its OWN GPUDevice (like the full runtime). `destroyAgentRenderSurface`
  releases it; `initAgents` / `buildAgentWebGPUIfNeeded` tear it down on every re-init/recompile
  (no cross-load device leak).

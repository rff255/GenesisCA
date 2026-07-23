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

### B1 Completion Report (2026-07-22)

**Commits** (branch `optimize`, not pushed): B1's diff **spans TWO commits**. Most of the
implementation (forcePass.ts mirror variant, agentWebgpuRuntime.ts mirror scatter/force/buffers/
destroy, sim.worker.ts `needScan`) was accidentally swept into the orchestrator's unrelated
hotfix `380b00b` by a `git add -A` while this session was in flight. The B1 SESSION commit then
carries the remainder: removing a stray temp-debug line left in `sim.worker.ts` by that sweep +
these docs (CLAUDE.md B1 subsection, master Status Board, this report). Net production diff for
B1 = `forcePass.ts` + `agentWebgpuRuntime.ts` + one `sim.worker.ts` line — NO compilers touched
beyond `agentWebgpu/forcePass.ts` (a compiler-dir file, hence the full identity discipline),
NO gl3d / agentEngine / JS-WASM / behaviour-shader paths.

**What shipped vs the spec** (deviations, all justified):
1. **Mirror force pass = a resident-only VARIANT FLAG on `emitAgentForcePassWGSL`, default false**
   (the orchestrator's binding steer). `mirror=false` emits BYTE-IDENTICAL WGSL to the pre-B1
   force pass (proven empirically: 2D/3D x scatter-on/off all byte-identical vs `HEAD`), so the
   per-gen `rt.forcePipeline` + `check-compile-identity` are untouched. The mirror force is a
   SEPARATE pipeline (`res.forceMirrorPipeline`) built only under `needScan`; `dispatchResidentBatch`
   routes to it when set, else the shared per-gen pipeline.
2. **Mirror field SET = the spec's `x,y[,z],radius,vx,vy[,vz]`** even though B1's force scan reads
   only `x/y/[z]/radius` for neighbours — `vx/vy[/vz]` ride the mirror for B2's fused gather (neighbour
   velocities) at trivial cost. Field order is the exported `agentMirrorFields(is3d)`, the SINGLE
   source shared by the scatter emit (runtime) + the force scan emit (forcePass.ts).
3. **Self-skip via `j = sortedId[p]` + `j != i`** (mirror stencil), matching the canonical body's
   guard exactly; the mirror holds only alive agents (scatter skips dead) so NO `agentAlive[j]` check.
   The all-pairs fallback (hashValid 0 => no scatter => no mirror this batch) stays fully canonical.
4. **`needScan` computed in `runAgentBatchResident`** = `usesBondingPhysics || usesSoftCollision ||
   agentUsesDensity` (the exact gate the force uniform's `bonding/doCollision/doDensity` come from,
   STATIC per model under residency eligibility). Passed to `ensureAgentResident(rt, needScan)`;
   Boids/PL (`customForcesOnly`) => `needScan=false` => no mirror (verified in Node + in-browser).

**Verified** (all real-GPU where GPU-relevant; the pane is occlusion-hidden so compute + readback +
worker protocol + DOM, never composited pixels — master 0.7; message-driven waits, NOT throttled
`setTimeout`):
- **Gates**: `tsc` + `npm run build` + `parity-agent-force` (7) + `parity-agent-wasm` + a **standalone
  byte-diff** of `emitAgentForcePassWGSL(layout)` old-vs-new (byte-identical, 4 combos) +
  `check-compile-identity --compare` (25 models, all surfaces unchanged) — all green.
- **Standalone GPU force test** (page context): the mirror force fed a matched-order hash is
  **BIT-IDENTICAL** to the canonical force — 0 density-count mismatch, 0 position delta (same
  neighbour order => identical float sums) — AND matches an independent CPU brute-force neighbour
  count (0 mismatches). Proves the mirror force math + field/slot reads are correct GIVEN a correct mirror.
- **GPU-scatter validation** (worker, temp readback, since removed): a soft-collision gas ENGAGES the
  mirror (`needScan=true hasMirror=true forceMirrorPipeline=set`, `hashValid=1` so the mirror stencil
  IS exercised) and a direct readback of `sortedBuf`/`sortedId`/`agentF32` confirms **every alive agent
  appears EXACTLY ONCE** in the mirror with correct field values: `radiusMismatch=0`, `idOutOfRange=0`,
  `idDead=0`, `aliveSeenOnce=450/450` AND `50000/50000` — a correct CSR permutation.
- **End-to-end physics**: the resident gas (GPU scatter + mirror force) produces physically-correct
  collision (median-nn 1.45, 0.35% overlapping pairs in a dense 50%-packed world), 0 worker errors
  over 180 gens on the CLEAN build (temp debug removed).
- **No-regression gating**: Boids (webgpu target, custom force) builds NO mirror (`needScan=false
  hasMirror=false forceMirrorPipeline=null`) and flocks to polarization **0.998**.

**Measured — B1 is a WASH (honest, matches W1's WASM-force conclusion).** Whole-batch GPU timing
(the only timing this worker-round-trip path exposes; the force pass is 1 of ~6 passes/gen + the
per-frame readback), dense soft-collision gas, `hashValid=1` so the mirror stencil runs, median of
5 batches x(10-30 gens):

| N (agents) | mirror ON (ms/gen) | mirror OFF / canonical (ms/gen) | delta |
|---|---|---|---|
| 10,000 | 3.73 | 3.46 | mirror ~8% slower |
| 50,000 | 46.83 | 47.03 | wash (mirror ~0.4% faster) |

Both within measurement noise (hidden-tab GPU throttling + round-trip jitter; 10k batches ranged
96-126 ms mirror vs 99-106 canonical). The force-pass-specific coalescing improvement is BELOW the
resolution of whole-batch worker timing — the extra scatter stores (6/agent) + the `sortedId` read
offset the coalescing gain at these scales, and the batch is dominated by hash-build + behaviour +
readback + present. **B1 is correctness-neutral, zero-cost-for-custom-force INFRASTRUCTURE for B2**
(the compiler fused gather, where the behaviour graph's `getNearbyAgents` loops read neighbour FIELDS
from the same sorted storage — the intended coalescing win), NOT a standalone speedup here. This is
the same finding W1 reported for the WASM force pass; it is a PERF assumption ("pure win") that did
not hold, NOT a correctness issue — the mirror is bit-correct and fully gated.

**Mirror-layout facts B2 will need:**
- Field-major mirror: `sorted[k * layout.maxAgents + slot]` for `agentMirrorFields(is3d)[k]`
  (`['x','y','radius','vx','vy']` 2D, `['x','y','z','radius','vx','vy','vz']` 3D). `sortedId[slot]` =
  the canonical agent id at that CSR slot. Both are `AgentResidentRuntime.sortedBuf`/`sortedIdBuf`,
  allocated only when `needScan` (`rt.resident.hasMirror`).
- CSR order: `slot in [binStart[b], binStart[b+1])` per bin `b`; `binStart` is the layout's
  `hashBinStartBase` run in `hashBinsBuf`; the same `slot` also holds `binAgents[slot] = i32(id)`.
  Slots are packed contiguously `[0, liveCount)`.
- The mirror is CURRENTLY GPU-storage-only (`STORAGE | COPY_DST`, no `COPY_SRC`) — B2's parity
  harness must add `COPY_SRC` (temporarily or permanently) to read it back for frozen-frame checks.
- B2 will want to EXTEND the mirror with the neighbour fields the fused `getNearbyAgents` bodies read
  (agent attrs -> attr runs; velocities already present). The mirror-field list is one place
  (`agentMirrorFields`); the scatter loops it, so adding a run is a one-line list edit + a matching
  read-base in the fused emitter.

**New gotchas discovered:**
- **A mirror buffer read back to the CPU needs `COPY_SRC`.** The mirror + `hashBinsBuf` are created
  `STORAGE | COPY_DST` (the force shader reads them via storage binding — never a copy), so a naive
  `copyBufferToBuffer` from them is a validation error (silent zeros — my first validation read
  `slots=0`). Production never copies them; only a debug/parity readback does.
- **`hashValid` must be 1 for the mirror STENCIL to run.** `computeResidentHashParams` returns
  `hashValid=0` (all-pairs, canonical reads — NO mirror) when the world is too small to tile (< 3 bins/
  axis) OR when `nBins > maxHashBins` after coarsening. `maxHashBins = min(cap, nx*ny)` with edge =
  `max(range*2*defaultRadius, neighbourQueryRadius)`; pick the bench/verify world so `nBins <= maxHashBins`
  AND `nx,ny >= 3` (a too-large world at 50k => `hashValid=0` => O(N^2) all-pairs => the renderer HUNG).
- **Cross-load `setRngSeed`+`reset` is NOT deterministic** across two model loads (the agent-init spawn
  differed by >world-size) — use `loadState` for a same-frozen-state cross-config comparison; the
  standalone matched-order GPU test is the cleaner mirror-vs-canonical proof anyway.

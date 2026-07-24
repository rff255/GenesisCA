# AUDIT — branch `optimize` (`origin/master..optimize`, 41 commits)

**Scope**: every change on `optimize` vs **`origin/master`** (merge base `4a8a02b`, the
v1.28.0 bump). `git diff origin/master...optimize` = 35 files (19 source/scripts).
Read-only audit session — no production source was modified. Fix plan:
[HANDOFF_AUDIT_FIXES.md](HANDOFF_AUDIT_FIXES.md).

> **STATUS — 2026-07-23: the fix pass is DONE.** Commits `8441b0a` (BLOCKER + 3
> HIGH), `8f35802` (MEDIUM), `070a1e5` (LOW/NIT) on `optimize`. **Every BLOCKER,
> HIGH, MEDIUM and LOW finding except L2 is FIXED**; NITs N1/N3/N4 addressed or
> accepted; N2 deferred to its owning session; M4 investigated with a plan (no code).
> Per-finding status is marked inline below; evidence + gate results are in the fix
> handoff's Completion Report. **Merge verdict is now: NOT BLOCKED.**

---

## ⛔ BLOCKER — read this first — **[FIXED `8441b0a`]**

**B1 — a soft recompile can ZERO the entire live agent population (silent data
corruption).** `buildAgentWebGPUIfNeeded()` destroys and rebuilds the agent WebGPU
runtime (fresh, spec-zero-initialised GPU buffers) but does **not** set
`agentGpuUploadPending`. The PR7c resident batch uploads the CPU SoA **only** when
that flag is set ([sim.worker.ts:2162](../src/simulator/engine/sim.worker.ts)), so the
first resident batch after a rebuild dispatches against an **all-zero** agent SoA and
then `readbackAgentFrame` writes those zeros back into every **live** CPU slot —
x/y → 0, radius → 0, velocities → 0, every agent attribute → 0. The corruption is
permanent (the next present/save/readback carries it).

- Rebuild without a store re-init happens on **every soft recompile**
  ([sim.worker.ts:5922](../src/simulator/engine/sim.worker.ts) — the `recompile` case
  calls `buildAgentWebGPUIfNeeded()`; `initAgents()` — the only setter at
  [:947](../src/simulator/engine/sim.worker.ts) — runs there only when the WASM
  backing changed).
- `recompile` is also **not** in the dispatcher's `agentGpuUploadPending = true` set
  ([sim.worker.ts:5156](../src/simulator/engine/sim.worker.ts): `AGENT_GPU_DEFER_TYPES
  ∪ {loadState, reset, setRngSeed, importImage}`).
- The per-generation GPU path is immune (it uploads the SoA every gen,
  [sim.worker.ts:2290](../src/simulator/engine/sim.worker.ts)) — this is a
  **residency-only** regression introduced by 614bbee.
- **Masking, not prevention**: for a *render-eligible* model the canvas re-attach
  runs `presentAgentsFromStore` → `uploadAgentSoA`, which re-seeds the GPU. But the
  attach is a main-thread round-trip (`agentRuntimeReady` → `attachAgentCanvas`), so
  a `step` already in flight from the play loop is processed **first**. And a
  residency-eligible model that is *not* render-eligible (3D + Alpha blend ON is the
  clean case — residency has no 3D/alpha term) has **no attach at all**, so the
  corruption is deterministic there.
- Affected model class: any agents-only / field-decoupled model on the **WebGPU agent
  target** that satisfies `agentResidentEligible()` (Particle Life, Boids, Particle
  Life 3D). Not reachable on JS/WASM agent targets.

Fix: set `agentGpuUploadPending = true` in `buildAgentWebGPUIfNeeded()` (one line,
independently revertable). See HANDOFF item 1.

**FIXED (`8441b0a`)** — and reproduced BOTH ways in the real app before/after
(Particle Life on the WebGPU agent target, render-ineligible via a sprite, soft
recompile driven by a real Modeler name edit): pre-fix every live agent collapsed to
`x=0, y=0, radius=0` permanently with zero errors; post-fix positions survive and
keep evolving. M3's fix (a `recompile` one-shot readback) additionally makes the
recompile lossless rather than merely consistent.

---

## Counts

| Severity | Count |
|---|---|
| BLOCKER | 1 |
| HIGH | 3 |
| MEDIUM | 6 |
| LOW | 6 |
| NIT | 4 |

~~**Merge verdict: BLOCKED** on B1 (silent data corruption) and H1 (a shipped sample
loses its defining visual). Both are small, local fixes. H2 (worker lock-up) and H3
(GPU resource leak) should land in the same pass. Everything else is safe to defer.~~

**Merge verdict (2026-07-23, post fix pass): NOT BLOCKED.** B1/H1/H2/H3 fixed +
regression-proved; all six MEDIUM and five of six LOW findings fixed; the fix pass
also closed one defect the audit missed (the recompile message dropping
`agentRenderLayout`, which permanently disabled direct render for CPU-target agent
models after their first graph edit). Remaining open: **M4** (investigated, plan
written, no code — a WebGPU-grid + WebGPU-agent decoupled model still runs its
agents on JS), **L2** (cosmetic infinity-tiling cap), **N2** (an untracked bench
script owned by another session), **N3** (sub-millionth-unit f32 quantisation), and
the visible-pane verification debt below.

---

## Per-phase spec-vs-execution

| Phase | Spec followed? | Declared deviations re-verified | Undeclared deviations / defects found |
|---|---|---|---|
| **P0/P1/P2 perf round** (pre-A1: batch serialization, density skip, PR7c residency, splat + f32 snapshot) | Yes — all work items present; ABI mirrors updated (`FORCE_PASS_PARAMS` +`doDensity` @25 ↔ worker call ↔ `parity-agent-force`) | n/a (no handoff — a review-driven round) | **B1** (`agentGpuUploadPending` not set on runtime rebuild). **M2** (f32 snapshot + splat introduced a min-radius divergence only on the *later* A1 GPU path). |
| **A1** resident direct render | Yes — pipeline, readback policy, one-shot rule, gate/attach/UI-sync/glow all present; diff confined to the 3 allowed files | ✅ all 5 deviations justified + implemented as described (OM gate term, `highWater` in RenderView, async setup, `agentRuntimeReady`, colour upload on mutation present) | **H1** (no bonds term in the 2D gate → bond lines silently lost). **M1** (the gate is computed only in `initWorkerWithDimensions` → stale across soft recompiles). **M2** (no `max(1.2px)` radius clamp → sub-pixel agents vanish). **L1** (bg2d dropped when *Show agents* is off). **L2** (>256 infinity tiles → agents untiled while the grid tiles). |
| **A2** snapshot-fed render (CPU targets) | Yes — `AgentRenderSurface` parameterise-over-copy, tight uploader, gate widened, present rides `sendColors` | ✅ all 5 justified; the OM-term refinement (`agentTarget !== 'webgpu' \|\| …`) is exactly as described and correct | **H3** — the attach handler never reuses/destroys an existing `agentRenderRuntime`, so **every** re-attach builds a new surface (3 big buffers + a shared-device refcount) and orphans the old one. The C report flagged this as "pre-existing, out of scope"; the **E1 report claims it is FIXED — it is not** (E1 only stopped the *device* from being duplicated; the refcount now leaks instead, so the device can never be destroyed). |
| **B1** bin-sorted mirror | Yes — `mirror` default-false variant flag, `needScan` gate, shared `agentMirrorFields` | ✅ 4 deviations justified. The honest "perf = a wash" reporting is correct and valuable | None. Mirror build is one-shot per runtime (`ensureAgentResident` early-returns on `rt.resident`), so a later `needScan` flip silently keeps the canonical path — **correct, just un-optimised** (documented here, not a defect). |
| **A1.5** GPU agent-OM colour pass | Yes — `emitAgentRootModule` factored, `agentSubsetSupported` factored, separate `omSupported` verdict, per-OM pipelines, gate relaxed | ✅ all 5 justified; the "OM dispatch only in `dispatchResidentBatch`" analysis holds (every other present path uploads the CPU `s.colors`) | **M1 (sub-case)** — adding an agent mapping is a *soft* recompile, so a newly-added **unsupported** OM on a WebGPU target leaves the stale-eligible direct render presenting behaviour/default colours instead of the CPU OM colours. |
| **A1.5 side-finding** (getState vx/vy) | n/a | ✅ Verified independently: `serializeAgentStore` ships `store.vx` (a `Float64Array`) — the "garbage" was an f32 view over f64 bytes. Correctly resolved as a false alarm with no code change; the trap is in master §0 #7 | None. |
| **C** 3D sphere render | Yes — WGSL sphere pass, overlays-only gl3d flag, shared `sceneCameraMatrices`/`lightWorldDirFor`, `mode:'3d'` view union, gate terms | ✅ all 6 justified. `setCamera`/`lightWorldDir` genuinely delegate (single source verified) | **L3-adjacent**: overlays-only skips `renderAgentRings()` (hover/inspect rings) — safe only because arming those features flips frame mode; worth a comment. Nothing else. |
| **D** field-decoupled residency | Yes — predicate replaces the agents-only proxy in both gates, `bumpGeneration`, `draw()` unchanged, transparent clear | ✅ all 6 justified. The "run the resident batch FIRST" reordering is genuinely the safer failure mode (verified: `runAgentBatchResident` returns before `generation += count` and before mutating the SoA on the pre-dispatch failure paths) | **M4** — D's own report notes it, but it is worth escalating: a **WebGPU grid + WebGPU agent** decoupled model still runs its agents on **JS** (`runAgentStep()` in the `webgpuActive` branch, [sim.worker.ts:5431](../src/simulator/engine/sim.worker.ts)). E1b routed the *field* sub-case onto the GPU and left the non-field sub-case behind, so the user's explicit "WebGPU agents" selection is silently ignored for exactly that config. |
| **E1** shared GPUDevice | Item 1 shipped; items 2/3 correctly **STOPPED** with a documented false-assumption finding (§0 #2 obeyed — the right call) | ✅ both deviations justified. Refcount + acquire-on-throw-release + consolidated hooks all verified in code | **H3** (the leak-fix claim is overstated — see A2 row). **L4** — the DEV leak metric (`sharedGpuRefCount` / `sharedGpuAdapterRequestCount`) is exported but **never imported anywhere**, so the E1 verification cannot be re-run as committed. |
| **E1b** GPU field bridge | Yes — prime/fold `copyBufferToBuffer`, live `attrsReadBuf` re-resolve per gen, float-only gate, DEV probe | ✅ all 3 justified. Deviation 1 (gate on `fieldReadLen/fieldWriteLen` rather than `agentUsesField`) verified as a safe superset: the degenerate case folds identity. `total*4` correctly excludes the constant-boundary sentinel | None functional. Note the copy-endpoint usage-flag audit ("already satisfied") re-verified: grid `attrsBufA/B` = `STORAGE\|COPY_DST\|COPY_SRC`, agent `fieldReadBuf` `COPY_DST`, `fieldDepositBuf` `COPY_DST\|COPY_SRC`. |
| **E2** single-canvas composite | 2D core shipped, then **disabled** after the user rejected the world-resolution look; 3D stretch correctly STOPPED | ✅ the disable is a legitimate, recorded response (correctness > perf) and leaves the code dormant behind `const agentComposite = false` | **M6** — the disable never reached `HelpView.tsx`: [:1793](../src/help/HelpView.tsx) still documents the composite as a live feature *and* advertises its (now non-existent) blur tradeoff. Violates §0.6 docs-consistency. **L3** — the dormant path has a latent conflict: `dispatchResidentBatch` calls `presentAgentsEncode` (disc-only, `loadOp:'clear'`), which would wipe the grid layer if the composite is ever re-enabled together with residency. |

---

## Findings

### HIGH

**H1 — 2D bonded agent models silently lose their bond lines under direct render.** **[FIXED `8441b0a`]**
The A1/A2 2D gate has no bonds term ([SimulatorView.tsx:4273-4286](../src/simulator/SimulatorView.tsx));
only the C (3D) arm adds `resolveMaxBonds(...) === 0`. When direct render is active,
`draw()` blits the agent canvas and **skips `drawAgentsOverlay()` entirely**
([SimulatorView.tsx:3328](../src/simulator/SimulatorView.tsx)) — and the GPU disc
pass draws discs only. Bond lines are drawn exclusively in the CPU overlay
([SimulatorView.tsx:2901](../src/simulator/SimulatorView.tsx)).
*Affected shipped samples*: **Morphogenesis — Growing Tissue** (2D, agents-only,
`maxBonds:10`) and **Morphogenesis — Differential Tissue** (2D, agents-only,
`maxBonds:6`) — both are `agentTarget:'js'`, so they take the A2 render-only path,
and both satisfy every other gate term. On any WebGPU-capable browser they now render
as unconnected discs; bonds are the defining visual of a *tissue* model.
The `showBonds` Layers toggle also becomes a no-op there.
*Fix*: add `resolveMaxBonds(model.centerBased) === 0` to the shared gate (not just
the 3D arm), or render bonds in the GPU pass. The gate term is the minimal, safe fix.

**H2 — the worker can dead-lock permanently if `sendColors()` throws inside the
UI-sync OFF→ON handler.** **[FIXED `8441b0a`]** [sim.worker.ts:6251-6252](../src/simulator/engine/sim.worker.ts):
```
asyncStepBatchInFlight = true;
void (async () => { await ensureAgentStoreFresh(); sendColors(); endAsyncStepBatch(); })();
```
There is no `try/finally`. Both async *step* branches correctly use
`.catch(...).finally(endAsyncStepBatch)` ([:5482](../src/simulator/engine/sim.worker.ts),
[:5567](../src/simulator/engine/sim.worker.ts)); this one does not. `sendColors()`
does real work that can throw (typed-array slicing at capacity, a `postMessage`
transfer-list `DataCloneError`, an OM colour-pass edge case). If it throws,
`asyncStepBatchInFlight` stays `true` forever and the top-of-dispatcher guard
([:5122](../src/simulator/engine/sim.worker.ts)) defers **every** subsequent message
with no replay — the simulator freezes with no error surfaced. Same shape (lower risk,
`ensureAgentStoreFresh` catches internally) in the one-shot rule at
[:5145-5147](../src/simulator/engine/sim.worker.ts).
*Fix*: wrap both IIFE bodies in `try { … } finally { endAsyncStepBatch(); }`.

**H3 — the A2 render-only surface leaks on every re-attach (GPU buffers + a shared-device
reference that can never be released).** **[FIXED `8441b0a`]** The attach handler
([sim.worker.ts:6180-6186](../src/simulator/engine/sim.worker.ts)) reads
`let rt = agentWebgpuRuntime; if (!rt) rt = await createAgentRenderOnlyRuntime(...)`
— it never consults or destroys the existing `agentRenderRuntime`, then overwrites it
([:6199](../src/simulator/engine/sim.worker.ts)). Each `createAgentRenderOnlyRuntime`
allocates three `maxAgents`-sized buffers **and** `acquireSharedGpuDevice()`
([agentWebgpuRuntime.ts:1884](../src/simulator/engine/agentWebgpuRuntime.ts)), so the
orphan's refcount is never returned — the shared device becomes undestroyable and the
buffers are only reclaimed by (unreliable) GC finalisers.
Re-attach fires on **every real display-size change** ([SimulatorView.tsx:3291-3296](../src/simulator/SimulatorView.tsx)),
i.e. once per frame while a panel splitter is dragged. At Particle Life scale
(50k agents) that is ~600 KB of GPU buffers per frame of drag.
The E1 Completion Report explicitly claims "the C-report leak … is FIXED by E1" —
**that claim is wrong**; E1 fixed only the duplicate-device half.
*Fix*: in the attach handler, destroy any existing `agentRenderRuntime` before
building a new one (or reuse it when the layout is unchanged).

### MEDIUM

**M1 — the direct-render gate is computed only inside `initWorkerWithDimensions`, so
it goes stale across soft recompiles.** **[FIXED `8f35802`]** [SimulatorView.tsx:4246-4308](../src/simulator/SimulatorView.tsx)
is inside the full-init path; `needsFullInit` ([:4618-4681](../src/simulator/SimulatorView.tsx))
does **not** include `model.sprites` or `model.agentMappings`. Consequences:
- Adding a **sprite** to a running direct-rendered agent model keeps direct render on
  → sprites are never drawn (the GPU pass draws discs; `drawAgentsOverlay` is skipped)
  until an unrelated full reinit. The gate's `(model.sprites?.length ?? 0) === 0` term
  becomes a lie.
- Adding an agent **Output Mapping whose graph is not GPU-supported** on a WebGPU
  target keeps direct render on → the resident batch presents behaviour/default
  colours instead of the CPU OM colours.
(`agentAccess` is safe — `attrsStructurallyEqual` compares it at
[:652](../src/simulator/SimulatorView.tsx) → full reinit. Metaballs and 3D alpha-blend
each have their own detach/re-attach effect.)
*Fix*: either add `model.sprites` / `model.agentMappings` identity to `needsFullInit`,
or (better) re-evaluate the gate in the soft-recompile path and detach/attach like the
metaballs effect does.

**M2 — sub-pixel agents disappear under direct render (CPU/GPU visual divergence).** **[FIXED `8f35802`]**
The CPU overlay clamps the drawn radius to `Math.max(1.2, r*scale)` at all three draw
sites ([SimulatorView.tsx:2958](../src/simulator/SimulatorView.tsx),
[:3049](../src/simulator/SimulatorView.tsx), [:3075](../src/simulator/SimulatorView.tsx));
the GPU disc VS uses `radPx = ar * rv.scalePx` with **no floor**
([agentWebgpuRuntime.ts:1232](../src/simulator/engine/agentWebgpuRuntime.ts)). Zoomed
out (or on a large world), a radius-1 agent below ~1.2 screen px renders as a
near-empty quad on the fast path and a visible dot on the CPU path. A1's verification
item "visual parity vs the CPU path (pixel-count + colour-bucket comparison)" was
**not** performed (occlusion), so this slipped through.
*Fix*: `radPx = max(ar * scalePx, 1.2)` in the disc VS (and mirror the `>= 2` outline
threshold), or document the divergence.

**M3 — GPU-side progress is discarded on a runtime rebuild (visible rewind).** **[FIXED `8f35802`]**
`buildAgentWebGPUIfNeeded()` sets `agentStoreStale = false`
([sim.worker.ts:1132](../src/simulator/engine/sim.worker.ts)) **without** reading the
GPU state back. In free mode the CPU store can be many frames behind, so a soft
recompile silently rewinds the simulation to the last synced frame. (Independent of
B1: fixing B1 makes the rewind *consistent* rather than corrupting.)
*Fix*: `await ensureAgentStoreFresh()` before dropping the runtime (or accept + document).

**M4 — a WebGPU-grid + WebGPU-agent model without a field runs its agents on JS.** **[OPEN — investigated, plan in the fix handoff's Completion Report]**
[sim.worker.ts:5431](../src/simulator/engine/sim.worker.ts): the `webgpuActive`
branch's non-E1b arm calls `runAgentStep()` — the JS/WASM agent step — regardless of
`agentTarget === 'webgpu'`. E1b routed the *float-field* sub-case onto the GPU runtime
and left the no-field sub-case on JS. So a decoupled grid+agents model gets neither
the GPU agent behaviour the user selected nor residency, and its RNG family/dynamics
differ from the same model with a JS/WASM grid. Pre-existing (D's report noted it) but
now inconsistent with E1b and worth closing.

**M5 — `uploadAgentColors` allocates a fresh `Uint32Array(maxAgents)` on every call** **[FIXED `8f35802`]**
([agentWebgpuRuntime.ts:1767](../src/simulator/engine/agentWebgpuRuntime.ts)). It is on
the **per-frame** path twice over (`uploadAgentRenderFields` for A2, `uploadAgentSoA`
per generation for the per-gen GPU path) — 200 KB of garbage per call at 50k agents.
Every sibling uploader uses persistent scratch (`rt.f32Upload`, `renderF32Scratch`).
*Fix*: persistent scratch on the surface (a 3-line change).

**M6 — user-facing doc drift: HelpView still documents the disabled E2 composite.** **[FIXED `8f35802`]**
[HelpView.tsx:1793](../src/help/HelpView.tsx) tells users that a 2D grid+agents model
on WebGPU/WebGPU "composites both layers … into ONE canvas in a single GPU pass, so
the grid no longer copies its colours back" and warns about the world-resolution
softness. The composite is hard-disabled (`const agentComposite = false`,
[SimulatorView.tsx:4303](../src/simulator/SimulatorView.tsx)); CLAUDE.md and the E2
report were updated, HelpView was not. §0.6 requires all layers to agree.

### LOW

**L1 — the 2D background disappears when "Show agents" is unticked under direct
render.** **[FIXED `070a1e5`]** [SimulatorView.tsx:3279-3286](../src/simulator/SimulatorView.tsx): the
`agentDirect && !showGrid2d && bg2dRef.current` arm intentionally does nothing
("bg is drawn by the render shader's clear"), but the blit that would carry that clear
is gated on `showAgentsRef.current` ([:3329](../src/simulator/SimulatorView.tsx)) — so
with agents hidden the backdrop is never painted.

**L2 — infinity tiling silently collapses to one tile past 256 copies.** **[OPEN — cosmetic, deferred]**
`computeAgentRenderView` leaves `copiesX/Y = 1, startX/Y = 0` when the tile count
exceeds 256 ([SimulatorView.tsx:4389-4390 region](../src/simulator/SimulatorView.tsx)),
so at extreme zoom-out the grid tiles but the agents appear only in the home tile. The
CPU overlay tiles unconditionally. Cosmetic, rare.

**L3 — dormant E2 code has a latent conflict with residency.** **[FIXED `070a1e5`]**
`dispatchResidentBatch` unconditionally appends `presentAgentsEncode`
([agentWebgpuRuntime.ts:2531](../src/simulator/engine/agentWebgpuRuntime.ts)), which is
the disc-only pass with `loadOp:'clear'` and does **not** consult `rt.renderComposite`
([:1801](../src/simulator/engine/agentWebgpuRuntime.ts)). If the composite is ever
re-enabled for a residency-eligible model the batch present would wipe the grid layer.
Harmless today (composite off; and the only composite-eligible configs took the
non-resident `webgpuActive` branch) — but it must be fixed before any E2 revival.

**L4 — the E1 device-leak metric is unreachable.** **[FIXED `8441b0a`]** `sharedGpuRefCount()` and
`sharedGpuAdapterRequestCount()` ([sharedGpuDevice.ts:154,161](../src/simulator/engine/sharedGpuDevice.ts))
are exported and imported by nothing. A page-side `import()` of the module would get a
*different* module instance from the worker's, so the E1 "adapterRequests = 1,
refCount = 2" result cannot be reproduced from the committed tree (the probe message
the session used was evidently not kept). Either wire them into the existing
`__e1bCounters` probe or delete them.

**L5 — `buildAgentDiscPipelines` orphans the previous `renderViewBuf`/pipelines on a
re-attach** **[FIXED `8441b0a`]** ([agentWebgpuRuntime.ts:1542-1554](../src/simulator/engine/agentWebgpuRuntime.ts)):
it assigns `rt.renderViewBuf = …` without destroying the old buffer. 96 bytes per
re-attach — negligible, but the same re-attach loop as H3.

**L6 — `renderAgentRings()` is skipped in gl3d overlays-only mode** **[FIXED `070a1e5` — comment]**
([gl3d.ts:2345-2351](../src/simulator/render/gl3d.ts)). Correct today only because
every ring-producing feature (agent brush hover, inspector) flips UI-sync ON → frame
mode. Fragile coupling; worth an explicit comment so a future UI-sync condition change
does not silently drop the rings.

### NIT

**N1** **[FIXED `070a1e5`]** — the `AGENT_GPU_ARRAY_CAP` comment claims "models with maxAgents ≤ the cap
emit byte-identical shaders" ([agentWebgpu/compile.ts:1612](../src/modeler/vpl/compiler/agentWebgpu/compile.ts)).
They do not: the emit changed from `i32(control.maxAgents)` (a uniform read) to a
literal at [:2547](../src/modeler/vpl/compiler/agentWebgpu/compile.ts). It is
*semantically* equivalent below the cap; the shader text differs for every model with
`getNearbyAgents`. Fix the comment so a future identity check is not mis-triaged.

**N2** **[DEFERRED — owned by a concurrent session]** — `scripts/bench-lattice.mjs` is present in the working tree **untracked**
(`git status`), a leftover from an earlier session. Either commit it deliberately or
delete it.

**N3** **[ACCEPTED — no change]** — the P2 f32 render snapshot quantises positions used by the agent
group-move brush (`start + delta` is posted from snapshot values), so a group move
rounds each agent's f64 position to f32. Sub-millionth of a world unit; noted only for
completeness.

**N4** **[FIXED `070a1e5` — comment]** — `deferredDuringAgentGpuStep` / `flushDeferredAgentGpuMsgs`
([sim.worker.ts:2010-2012](../src/simulator/engine/sim.worker.ts)) are now effectively
unreachable during a step batch: the `asyncStepBatchInFlight` guard runs first and
catches everything. Dead-ish machinery worth a comment (or removal) so the two
deferral systems are not mistaken for peers.

---

## Clean — checked and found correct (negative results)

- **Stop Events under the D resident batch.** The decoupled resident branch
  ([sim.worker.ts:5499-5525](../src/simulator/engine/sim.worker.ts)) has no
  `drainAgentStop()` / `stopFlag` check — but `agentResidentEligible()` requires
  `stopMessages.length === 0` **and** `!rt.usesStop`
  ([:137-158](../src/simulator/engine/sim.worker.ts)), and `stopMessages` is the
  combined cell+agent list. A model with any Stop Event is residency-ineligible. ✔
- **Generation counting on the decoupled path.** `bumpGeneration = !gridSteps`; the
  grid loop's `runStep(true)` increments. Verified once-per-gen for agents-only,
  decoupled, frozen-cells and no-`stepFn` variants. ✔
- **Deferred indicator scan + sparse colour pass** in the resident branch mirror the
  per-gen loop exactly (same `indicatorScanPending` drain, same `runColorPass(true)`). ✔
- **The P0 async-batch deferral** is set/cleared on both async step branches via
  `.finally` and the replay preserves order (a replayed `step` re-arms the guard and
  the remainder re-defers). ✔ (except H2's third site)
- **The one-shot staleness rule lives in exactly one place**
  ([sim.worker.ts:5138-5150](../src/simulator/engine/sim.worker.ts)) and covers
  `AGENT_GPU_DEFER_TYPES ∪ {getAgentState, getState}`. Every stale-store present path
  is gated on `!agentStoreStale` (`sendColors`, `setAgentCamera` falls back to a raw
  GPU present), so no consumer observes stale coordinates. ✔
- **`colorPass` (viewer switch) while stale** does not ship a stale snapshot (free
  mode ships none) and does not present from the stale store. ✔
- **Transfer-list duplicate-buffer trap**: the shared length-0 `EMPTY` placeholder
  ([agentEngine.ts:1717](../src/simulator/engine/agentEngine.ts)) is correctly guarded
  by per-field `length > 0` checks before `agentTransfers.push`. ✔
- **`vx/vy` gated on `includeSprites`**: both consumers are guarded —
  gl3d ([:1788](../src/simulator/render/gl3d.ts) `svx.length === hw`) and the 2D
  sprite branch (only reached when sprites are active). ✔
- **2D canvas sizing**: the display canvas is CSS-pixel sized
  ([SimulatorView.tsx:2777](../src/simulator/SimulatorView.tsx)) and the attach uses
  the same `parentElement.clientWidth/Height`, so the 1:1 blit is correct (no DPR
  mismatch). The 3D sphere canvas correctly uses `css × dpr` with CSS 100%. ✔
- **E1 refcount discipline**: every `createX` releases on throw; every `destroyX`
  releases instead of destroying; the concurrent-acquire race drops the redundant
  device. ✔ (the only leak is H3's *missing* destroy call, not the singleton itself)
- **E1b copy geometry**: `total*4` excludes the constant-boundary sentinel at index
  `total`; `buildGpuFieldBridge()` re-resolves `attrsReadBuf` every generation
  (ping-pong safe); `gpuOwnsAttrs` stays true so `getState` pulls fresh grid attrs. ✔
- **E1b float-only gate** correctly rejects int/bool/tag fields (bit-pattern
  mismatch) and non-shared devices. ✔
- **Density-skip (P1) gate parity** across the three targets: JS
  `doForce || agentUsesDensity` where `engineForces === bonding`
  ([sim.worker.ts:1538](../src/simulator/engine/sim.worker.ts)); WASM
  `bonding | doCollision | doDensity`; WGSL `fc.bonding != 0 || fc.doCollision != 0 ||
  fc.doDensity != 0`. Identical. The density store is skipped in lockstep on all
  three. ✔
- **`agentUsesDensity` detection** is macro-aware and covers `neighbourDensity` +
  `divideAgent` across the whole agent graph (behaviour, init, division and OM roots
  all live in `agentGraphNodes`). ✔
- **B1 mirror correctness**: the mirror body omits the `agentAlive[j]` check only
  because the scatter skips dead agents; `mirror=false` emits the canonical body
  verbatim; the mirror pipeline is built only under `needScan`. ✔
- **Array-producer cap safety**: every producer that writes the capped
  `var<function>` arrays is bounded by a source array that is itself capped
  (`emitJoinAgents` gained explicit guards; `pickNRandomAgents`/`filterAgents` copy
  from a capped input). ✔
- **Cross-agent-write WebGPU gate** (`isAgentGraphWebGPUSupported`) matches the
  sync-mode compile gate: same 4 node types, same one-hop `createAgent`-handle
  exemption, behaviour-reachable scope. ✔
- **Lattice compilers untouched**: `git diff origin/master...optimize --stat` shows no
  `compiler/wasm/`, `compiler/webgpu/`, `compile.ts` emit change (the only
  `compile.ts` hunk is a comment). gl3d changes are additive + delegate-only. ✔
- **Gates re-run in this session**: `npx tsc -p tsconfig.app.json --noEmit` clean;
  `node scripts/parity-agent-wasm.mjs` — all samples + 10 synthetics bit-parity ✓;
  `node scripts/parity-agent-force.mjs` — 7 checks ✓ (incl. the two new density-skip
  combos). ✔

---

## Verification debt (claims resting on occluded-pane probes)

1. **Composited pixels were never seen** for A1 (2D), A2, C (3D spheres), D (grid under
   agents) and E2 — every phase report flags this. A1's 2D pixels were later
   user-confirmed in the real app; **A2, C and D have no visual confirmation at all**.
   H1 (missing bonds), M2 (vanishing sub-pixel agents) and L1 (missing backdrop) are
   exactly the class of defect a visible-pane check would have caught immediately.
2. **A1's "visual parity vs the CPU path" checklist item was not executed** — that is
   the direct cause of M2 going unnoticed.
3. **C's lighting-parity eyeball** (WGSL spheres vs gl3d spheres) is still open; the
   shared `sceneCameraMatrices`/`lightWorldDirFor` make projection identical by
   construction, but shadows/AO are deliberately absent in free mode and the *look*
   was never compared.
4. **D's z-order pixel probe and "recording contains both layers"** were not run.
5. **E1's device-leak metric cannot be reproduced** from the committed tree (L4).
6. **`check-compile-identity` vs `origin/master` is expected to differ** on the
   `agent.wasm` and `agent.webgpu` surfaces (P1's `doDensity`, the array cap, the
   diamond fix). Each phase compared against its own immediate baseline, which is
   correct — but there is no single end-to-end identity statement for the branch. A
   fresh capture on `origin/master` (via a temporary `git worktree`) compared against
   HEAD would let a reviewer confirm the *lattice* surfaces are byte-identical and
   enumerate exactly which agent surfaces moved and why.
7. **No harness covers the render/readback layer at all.** `parity-agent-*` exercise
   the compilers/engine; nothing exercises the gate matrix, the attach lifecycle, the
   free/frame flip, or the one-shot rule. B1, H2, H3 and M1 are all outside every
   automated check on this branch.

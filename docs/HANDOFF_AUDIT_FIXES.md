# HANDOFF — AUDIT FIX PASS (branch `optimize`)

Read first: [HANDOFF_GPU_AGENT_RENDER.md](HANDOFF_GPU_AGENT_RENDER.md) §0 (invariants)
and §3 (protocol), then **[AUDIT_OPTIMIZE_BRANCH.md](AUDIT_OPTIMIZE_BRANCH.md) top to
bottom** — it is the ground truth for every item below (each work item cites its
finding id). CLAUDE.md context: the "Direct agent render — GPU-side, free-when-idle
(A1 + A2 + A1.5 + C + D)", "Agent-engine performance review round", "E1/E1b/E2"
subsections, and "Bond-Graph Agents … Agent brush parity".

**Objective**: close the audit's BLOCKER + HIGH findings (silent agent-state
corruption, a shipped sample losing its bonds, a worker dead-lock path, a per-frame
GPU leak), then the MEDIUM correctness/consistency items. **Every work item is
independently revertable** — one commit per item, in the order below.

**This is a fix pass, not a feature phase.** If an item's premise turns out to be
false, STOP on that item, record what you found in the Completion Report, and move to
the next one — do not redesign.

---

## Work items (in order — severity first)

### 1. BLOCKER — re-upload the agent SoA whenever the GPU runtime is rebuilt
*(audit B1)*

A rebuilt agent WebGPU runtime has spec-zero-initialised buffers, but the resident
batch only uploads when `agentGpuUploadPending` is set, so the first resident batch
after a rebuild dispatches on zeros and `readbackAgentFrame` writes those zeros into
every live CPU slot (permanent corruption of positions/radius/velocity/attributes).

- [src/simulator/engine/sim.worker.ts:1127](../src/simulator/engine/sim.worker.ts)
  `buildAgentWebGPUIfNeeded()` — at the top (beside the existing
  `agentRenderActive = false; agentStoreStale = false; agentCompositeActive = false;`
  line at :1132) add `agentGpuUploadPending = true;` with a comment naming the reason
  (fresh GPU buffers are zeroed; the resident batch's conditional upload at
  [:2162](../src/simulator/engine/sim.worker.ts) would otherwise skip the seed).
- Sanity-check the other rebuild call sites need nothing more: `:5284` (init),
  `:5816`, `:6552`, `:6850` all call `initAgents()` first (which already sets the flag
  at [:947](../src/simulator/engine/sim.worker.ts)); `:5922` (recompile) is the leaking
  one this fixes.
- **Do NOT** try to also preserve the GPU-side progress here — that is item 6.

### 2. HIGH — keep bonded 2D agent models on the CPU overlay
*(audit H1 — two shipped samples currently render without bond lines)*

- [src/simulator/SimulatorView.tsx:4273](../src/simulator/SimulatorView.tsx)
  `const agentRenderEligible = …` — move the bonds term out of the 3D-only arm at
  [:4286](../src/simulator/SimulatorView.tsx) so it applies to **both** dimensions:
  `&& resolveMaxBonds(model.centerBased) === 0` as a shared term (the 3D arm then only
  carries the alpha-blend term). `resolveMaxBonds` is already imported.
- Update the gate comment to state the reason plainly: the GPU disc/sphere pass draws
  no bond lines and `draw()` skips `drawAgentsOverlay()`
  ([:3328](../src/simulator/SimulatorView.tsx)), which is the sole bond renderer
  ([:2901](../src/simulator/SimulatorView.tsx)).
- Docs: CLAUDE.md's "Direct agent render" gate bullet + the HelpView "Direct agent
  render" bullet must both name the no-bonds requirement (they currently list only
  sprites/metaballs).
- *Alternative considered and rejected for this pass*: emitting bond lines in the GPU
  pass is a real render feature (a line pipeline + the bond pair buffer), not a wiring
  repair — record it as a follow-up if you want the fast path for tissue models.

### 3. HIGH — never leave `asyncStepBatchInFlight` set on a throw
*(audit H2 — a throw inside the UI-sync IIFE dead-locks the worker permanently)*

- [src/simulator/engine/sim.worker.ts:6251](../src/simulator/engine/sim.worker.ts)
  (`case 'setAgentUiSync'`) — wrap the IIFE body:
  `void (async () => { try { await ensureAgentStoreFresh(); sendColors(); } finally { endAsyncStepBatch(); } })();`
- [src/simulator/engine/sim.worker.ts:5145](../src/simulator/engine/sim.worker.ts)
  (the one-shot rule) — same `try/finally` shape for symmetry/defence-in-depth.
- Leave the two async step branches alone — they already use
  `.catch(...).finally(endAsyncStepBatch)` ([:5482](../src/simulator/engine/sim.worker.ts),
  [:5567](../src/simulator/engine/sim.worker.ts)).
- Add a one-line rule to the master handoff §0 #7 trap list: *every* path that sets
  `asyncStepBatchInFlight` must clear it from a `finally`.

### 4. HIGH — stop leaking a render-only surface (and a shared-device reference) per re-attach
*(audit H3 — the E1 report's "leak fixed" claim is only half true)*

- [src/simulator/engine/sim.worker.ts:6180](../src/simulator/engine/sim.worker.ts)
  (`case 'attachAgentCanvas'`) — before building a new render-only surface, tear down
  any existing one: if `agentWebgpuRuntime` is null and `agentRenderRuntime` is set,
  either **reuse** it when `pendingAgentRenderLayout` matches the surface's layout
  (`maxAgents` + `gridDepth` + `f32Len` are enough) or
  `destroyAgentRenderSurface(agentRenderRuntime); agentRenderRuntime = null;` first.
  Reuse is preferable (a display resize does not change the layout) — it also avoids
  re-acquiring the device on every splitter drag frame.
- If you reuse the surface, `setupAgentDirectRender` must not orphan the previous
  render-view buffer either — fix [agentWebgpuRuntime.ts:1542](../src/simulator/engine/agentWebgpuRuntime.ts)
  (`buildAgentDiscPipelines`) to `rt.renderViewBuf?.destroy()` before reassigning
  (audit L5), and do the same for `renderView3DBuf` in `setupAgentSphereRender`
  ([:1479](../src/simulator/engine/agentWebgpuRuntime.ts)).
- Correct the E1 Completion Report's "the C-report leak is FIXED by E1" sentence in
  [HANDOFF_GPU_AGENT_RENDER_E.md](HANDOFF_GPU_AGENT_RENDER_E.md) to say what E1
  actually fixed (duplicate devices) and point at this item.

### 5. MEDIUM — re-evaluate the direct-render gate on a soft recompile
*(audit M1 — sprites silently unrendered; an unsupported OM silently mis-coloured)*

- Cheapest correct fix: add to `needsFullInit`
  ([src/simulator/SimulatorView.tsx:4618](../src/simulator/SimulatorView.tsx)):
  `|| prev.sprites !== model.sprites || prev.agentMappings !== model.agentMappings`.
  (Identity comparison matches the existing `prev.mappings !== model.mappings` style;
  both already force a worker message rebuild anyway, so the extra reinit cost is
  bounded.)
- If you prefer not to widen `needsFullInit` (it also resets the grid), the
  alternative is to recompute `agentRenderEligible` in the soft-recompile path
  ([:4737 onward](../src/simulator/SimulatorView.tsx)) and detach/re-attach exactly
  like the metaballs effect ([:5855 region](../src/simulator/SimulatorView.tsx)).
  Pick one, state which in the report.
- **Investigate before implementing**: confirm whether a sprite add currently reaches
  the worker at all as `agentHasSprites` on recompile ([:4845](../src/simulator/SimulatorView.tsx))
  — it does; the defect is main-thread-only (the gate), so the worker side needs no
  change.

### 6. MEDIUM — don't discard GPU-side progress on a runtime rebuild
*(audit M3)*

- [src/simulator/engine/sim.worker.ts:1132](../src/simulator/engine/sim.worker.ts):
  `buildAgentWebGPUIfNeeded()` clears `agentStoreStale` without reading back. Make the
  drop path await `ensureAgentStoreFresh()` **before** `destroyAgentWebGPURuntime(...)`
  (the function is sync today — either make the teardown block an awaited IIFE guarded
  by `asyncStepBatchInFlight` + `finally endAsyncStepBatch()`, per item 3's rule, or
  do the readback in the *caller* (`recompile`) before invoking the rebuild).
- This is a behaviour change (a soft recompile mid-free-run will now preserve the
  latest frame instead of rewinding). If the readback proves awkward to sequence
  safely, STOP and record — the rewind is *consistent* once item 1 lands, so this is a
  quality fix, not a correctness one.

### 7. MEDIUM — floor the GPU disc radius to match the CPU overlay
*(audit M2 — sub-pixel agents vanish on the fast path)*

- [src/simulator/engine/agentWebgpuRuntime.ts:1232](../src/simulator/engine/agentWebgpuRuntime.ts)
  (`agentRenderWGSL` VS): `let radPx: f32 = max(ar * rv.scalePx, 1.2);` — matching the
  three CPU sites (`Math.max(1.2, ar[i]! * scale)`,
  [SimulatorView.tsx:2958/3049/3075](../src/simulator/SimulatorView.tsx)).
- Check the outline band still behaves: the CPU rule strokes only at `rad >= 2`; the
  FS band is derived from `in.radPx`, so the floor keeps them consistent.
- No compiler files involved (this is the runtime's own WGSL string) → no
  `check-compile-identity` requirement, but note it in the report.

### 8. MEDIUM — fix the HelpView drift for the disabled E2 composite
*(audit M6 — §0.6 docs-consistency)*

- [src/help/HelpView.tsx:1793](../src/help/HelpView.tsx): delete (or rewrite as a
  "planned/disabled" note) the "Single-canvas composite (2D grid+agents on WebGPU)"
  bullet — the composite is hard-off at
  [SimulatorView.tsx:4303](../src/simulator/SimulatorView.tsx) and its
  world-resolution tradeoff no longer exists.
- While in that section, make the "Direct agent render" bullet mention the no-bonds
  requirement (item 2) so the Help matches the shipped gate.

### 9. MEDIUM — per-frame allocation in `uploadAgentColors`
*(audit M5)*

- [src/simulator/engine/agentWebgpuRuntime.ts:1765](../src/simulator/engine/agentWebgpuRuntime.ts):
  hoist the `new Uint32Array(ma)` into persistent scratch on the surface (mirror
  `renderF32Scratch` / `renderAliveScratch` at
  [:1100](../src/simulator/engine/agentWebgpuRuntime.ts)); it is called once per
  present **and** once per generation via `uploadAgentSoA`
  ([:637](../src/simulator/engine/agentWebgpuRuntime.ts)).
- Free perf, zero behaviour change. Record a before/after `bench-agent-engine` number
  only if it moves the needle (it may not).

### 10. LOW batch — cheap correctness/hygiene
Each is a one- or two-line change; group them in ONE commit.
- **L1** [SimulatorView.tsx:3279](../src/simulator/SimulatorView.tsx): when
  `agentDirect && !showAgents`, the backdrop is never painted. Either blit the agent
  canvas unconditionally (it carries the clear) and let `showAgents` gate only the
  *worker-side* draw via the render view, or fall through to the CPU bg fill in that
  case.
- **L3** [agentWebgpuRuntime.ts:1801](../src/simulator/engine/agentWebgpuRuntime.ts):
  make `presentAgentsEncode` a no-op (or route to `presentCompositeEncode`) when
  `rt.renderComposite` — so a future E2 revival cannot have the resident batch clear
  the grid layer. Add a comment at
  [:2531](../src/simulator/engine/agentWebgpuRuntime.ts) noting the coupling.
- **L4** [sharedGpuDevice.ts:154/161](../src/simulator/engine/sharedGpuDevice.ts):
  surface `sharedGpuRefCount()` / `sharedGpuAdapterRequestCount()` through the existing
  `__e1bCounters` DEV probe ([sim.worker.ts:6665](../src/simulator/engine/sim.worker.ts))
  so the E1 leak metric is reproducible — **or** delete both exports. Do not leave
  them unreachable.
- **L6** [gl3d.ts:2345](../src/simulator/render/gl3d.ts): comment why
  `renderAgentRings()` is safe to skip in overlays-only mode (every ring producer
  flips UI-sync ON → frame mode).
- **N1** [agentWebgpu/compile.ts:1612](../src/modeler/vpl/compiler/agentWebgpu/compile.ts):
  correct the "byte-identical shaders" claim to "semantically identical below the cap;
  the emitted literal replaces the `control.maxAgents` read".
- **N4** [sim.worker.ts:2010](../src/simulator/engine/sim.worker.ts): note that
  `deferredDuringAgentGpuStep` is unreachable while an async step batch is in flight
  (the `asyncStepBatchInFlight` guard runs first), so the two deferral systems are not
  peers.
- **N2**: decide `scripts/bench-lattice.mjs` (untracked in the working tree) — commit
  it deliberately or delete it. Do **not** sweep it in with `git add -A`.

### 11. INVESTIGATE (do not implement blind) — WebGPU-grid + WebGPU-agent decoupled models run agents on JS
*(audit M4)*

[sim.worker.ts:5431](../src/simulator/engine/sim.worker.ts): the `webgpuActive`
branch's non-E1b arm calls `runAgentStep()` (the JS/WASM agent step) even when
`agentTarget === 'webgpu'`. E1b routed the float-field sub-case onto the GPU runtime
and left the no-field sub-case behind, so a decoupled grid+agents model on
WebGPU/WebGPU silently ignores the user's agent-target choice **and** never runs
resident.

Investigate, then write a short plan (do not implement in this pass):
1. Can the `webgpuActive` branch simply call `runAgentStepWebGPU()` (no bridge) when
   `agentTarget === 'webgpu' && agentWebgpuRuntime` — i.e. is the E1b `else if` arm's
   `runAgentStep()` a genuine requirement or just the pre-E1b default?
2. Can the resident batch be reached from that branch at all (it would need the grid's
   async `runStepWebGPU` interleaved with `runAgentBatchResident` inside the existing
   `asyncStepBatchInFlight` deferral — D's report calls this "aspirational")?
3. What does it change for the user: RNG family (xorshift32 → per-agent PCG) and f32
   precision, i.e. a **statistical**, documented difference — confirm that is
   acceptable for a target the user explicitly selected.

---

## Do NOT touch

- The lattice compilers (`compiler/compile.ts` emit, `compiler/wasm/*`,
  `compiler/webgpu/*`) — this branch leaves them byte-identical and this pass must too.
- The JS agent compiler + `agentEngine.ts` store layout / ABI (`agentAbi.ts` and the
  three mirrors) — no item here needs them.
- `agentWasm/compile.ts` and `agentWebgpu/compile.ts` emit paths — item 10's N1 is a
  **comment** only. If any item tempts you into an emitter change, STOP: the full
  `check-compile-identity` baseline discipline applies and that is a separate pass.
- The E2 composite's dormant code beyond L3's guard — re-enabling it needs the
  display-resolution redesign the E2 report records, not a wiring repair.
- Version numbers, `git push`, any Claude/Anthropic attribution.

---

## Verification checklist (all mandatory)

Standard gates, after **each** commit that touches worker/runtime/render code:
- `npx tsc -p tsconfig.app.json --noEmit` and `npm run build`
- `node scripts/parity-agent-wasm.mjs` (all samples + synthetics)
- `node scripts/parity-agent-force.mjs`
- `node scripts/check-compile-identity.mjs` — **only if** a `compiler/` file changed
  (expected: none in this pass; assert with `git diff --stat`).

Per-item functional checks (**in-browser, VISIBLE pane where a pixel is the claim** —
this pass exists partly because the branch's occluded-pane verification missed exactly
these):
1. **Item 1 (BLOCKER)**: load Particle Life, set the agent target to WebGPU, Play, then
   make a trivial agent-graph edit (soft recompile) while it runs → agents keep their
   positions (pre-fix: they collapse to the corner / vanish). Repeat with Particle Life
   3D + **Alpha blend ON** (render-ineligible, residency-eligible) — the deterministic
   case. Assert via `getAgentState` (Float64!) that x/y/radius are non-zero after the
   recompile.
2. **Item 2**: load **Morphogenesis — Growing Tissue** and **— Differential Tissue** →
   bond lines visible again, `showBonds` toggle works. Confirm Boids/Particle Life
   (maxBonds 0) still take the direct path (`agentRenderStatus:true`).
3. **Item 3**: force a throw inside the UI-sync path (temporarily) and confirm the
   worker still responds to a subsequent `step`; remove the temporary throw.
4. **Item 4**: on a JS-target agents-only model, drag the panel splitter for ~2 s and
   assert (via the item-10 L4 probe, or a temporary one) that the shared-device
   refcount does **not** grow monotonically.
5. **Item 5**: with a 2D agents-only model direct-rendering, add a sprite → sprites
   appear (pre-fix: discs). Add a GPU-unsupported agent OM on a WebGPU target → colours
   match the CPU path.
6. **Item 7**: zoom out on Particle Life until agents are sub-pixel → dots remain
   visible and match the CPU-overlay look (toggle metaballs on/off to force the CPU
   path for an A/B).
7. **Regression sweep** (any target): Boids-webgpu still flocks (polarization > 0.99),
   Chemotaxis on WASM-grid + JS-agents unchanged, Chemotaxis on WebGPU/WebGPU still
   engages the E1b bridge (`__e1bCounters` → `gpuBridge > 0, cpuFallback 0`),
   3D Tissue still renders bonds via the CPU path.

---

## Completion Report skeleton

`## Completion Report (<date>)`
- **Commits** (one per work item, `optimize`, not pushed) + `git diff --stat` per item.
- **Per item**: what changed vs the spec above; any item STOPPED and why.
- **Gates**: tsc / build / parity ×2 / (identity if applicable) results.
- **In-browser results**: the checklist above, with the pane state (visible/occluded)
  stated for each claim.
- **New gotchas** discovered.
- **Left open**: which audit findings were deliberately deferred (with the finding id),
  and the item-11 investigation outcome + proposed plan.
- Update the master Status Board with an "AUDIT FIX PASS" row.

---

## Completion Report (2026-07-23)

### Commits (branch `optimize`, NOT pushed)

| # | Commit | Items | `git diff --stat` |
|---|---|---|---|
| 1 | `8441b0a` fix(agents): audit BLOCKER + 3 HIGH | 1 (B1), 2 (H1), 3 (H2), 4 (H3+L5) + L4 wiring | CLAUDE.md, HANDOFF_GPU_AGENT_RENDER{,_E}.md, HelpView.tsx, SimulatorView.tsx, agentWebgpuRuntime.ts, sim.worker.ts — 7 files, +105/−17 |
| 2 | `8f35802` fix(agents): audit MEDIUM batch | 5 (M1 + a found-in-verification A2 gap), 6 (M3), 7 (M2), 8 (M6), 9 (M5) | CLAUDE.md, HelpView.tsx, SimulatorView.tsx, agentWebgpuRuntime.ts, sim.worker.ts — 5 files, +123/−24 |
| 3 | `070a1e5` fix(agents): audit LOW batch | 10 (L1, L3, L6, N1, N4) | agentWebgpu/compile.ts (COMMENT only), SimulatorView.tsx, agentWebgpuRuntime.ts, sim.worker.ts, gl3d.ts — 5 files, +35/−4 |

(Two commits by a CONCURRENT session — `b858a2d` docs, `efc6cf0` an Accretor `.gcaproj`
fix — are interleaved in the log. They touch no file in this pass.)

### Per item

**1 — BLOCKER B1: FIXED.** `agentGpuUploadPending = true` at the top of
`buildAgentWebGPUIfNeeded()`. Checked the other four call sites: `:5296` (init),
`:5828`, `:6595`, `:6893` all call `initAgents()` first (which already sets it);
only the `recompile` site lacked it, as the audit stated.
**Regression proof (real UI, pre/post A/B with the identical procedure)** — Particle
Life on the WebGPU agent target (`__e1bCounters.agentTarget === 'webgpu'`), one
injected sprite so the model is render-INELIGIBLE (no canvas attach can mask the
result — deterministic, and a general model property rather than a UI toggle);
soft recompile driven by a **real model-name edit in the Modeler Info panel**;
positions read with `getAgentState` (f64-safe):
- **pre-fix** (the one line commented out): agents 0/5/100 went
  `(244.4, 111.7) (38.4, 60.9) (266.6, 128.1)` → **`(0,0) (0,0) (0,0)` with radius 0**,
  still zero after 3 further steps, `live: true`, **0 errors** (silent + permanent).
- **post-fix**: `(20.0, 48.1) (270.4, 60.7) (249.4, 80.5)` preserved and still
  evolving after the rebuild (`runtimeReady: 1`, `recompile` posted, 0 errors).

**2 — H1: FIXED.** `resolveMaxBonds(model.centerBased) === 0` moved out of the
3D-only arm into a shared gate term; the 3D arm keeps only the alpha-blend term.
Verified in-browser: **Morphogenesis — Growing Tissue** posts **0** `attachAgentCanvas`
(CPU overlay ⇒ bonds render, `showBonds` works again) while **Boids** (Bonds
capability off ⇒ `resolveMaxBonds` 0) still posts the attach and keeps the fast
path. **3D Tissue** re-checked: `eligible:false`, 0 attaches, snapshot carries
`bonds`. Docs: CLAUDE.md gate bullet + the HelpView bullet now name the requirement.
The GPU bond-line pass is recorded as a follow-up, not attempted.

**3 — H2: FIXED.** Both non-step sites that set `asyncStepBatchInFlight` now clear it
from a `finally` (the `setAgentUiSync` OFF→ON IIFE and the one-shot rule).
Verified BOTH ways with a temporary unconditional `throw` in the UI-sync IIFE:
with the `finally` the worker keeps answering (`step` gen 2 → 4, `getAgentState`
answered); without it the next `step` never returns (`timeout stepped`) — the
dead-lock reproduced, then the temporary throw removed. Master §0 #7 gained the rule.

**4 — H3 + L5: FIXED.** The attach handler REUSES `agentRenderRuntime` when the
shipped layout matches (`maxAgents` + `gridDepth` + `f32Len`) and destroys a
stale-layout surface first; a failed setup on a reused surface also clears the
module ref. `buildAgentDiscPipelines` / `setupAgentSphereRender` destroy the previous
render-view uniform (L5).
**Measured pre/post** via the L4 metric (surfaced through `__e1bCounters`), 6
consecutive re-attaches on a JS-target agents-only model: **pre-fix `gpuRefCount`
1 → 7** (+1 per attach, exactly the audit's claim); **post-fix 1 → 1**,
`gpuAdapterRequests` 1, all 6 attaches ack `active: true`, sim keeps stepping.
The E1 report's "the C-report leak is FIXED by E1" sentence is corrected in place.

**5 — M1: FIXED (detach path chosen, NOT `needsFullInit`).** Widening
`needsFullInit` would reset the grid and re-seed the agent population on every
sprite/OM edit; instead one module-scope `agentRenderModelTermsOk()` feeds BOTH the
init gate and a soft-recompile refresh of `agentRenderModelTermsOkRef`, which
`maybeAttachAgentCanvas` consults exactly like the metaballs suppression.
**Deviation from the handoff's sketch**: the refresh does NOT call
`maybeAttachAgentCanvas()` when the terms go back to OK — the `agentRuntimeReady`
that follows the same recompile already re-attaches, and posting both produced TWO
attaches whose SECOND ack found no pending canvas and took the "attach failed"
branch, leaving direct render OFF (observed in the trace).
**Bug found while verifying (fixed here, same family)**: the recompile message never
carried `agentRenderLayout`, while the worker does
`pendingAgentRenderLayout = rc.agentRenderLayout ?? null` — so every soft recompile
NULLED it, after which `buildAgentWebGPUIfNeeded` stops posting `agentRuntimeReady`
for a CPU target and the attach handler bails `active:false`. **A JS/WASM-target
agent model therefore lost direct render permanently on its first graph edit**
(pre-existing A2 plumbing gap; the audit did not list it).
Verified in-browser on Boids via the new DEV hook `window.__agentRenderState()`:
baseline `directActive:true` → real sprite import in the Modeler Mappings panel →
`modelTermsOk:false, directActive:false` → Remove sprite → `modelTermsOk:true,
directActive:true` with exactly ONE attach ack, 0 errors.

**6 — M3: FIXED, by a different (simpler) route than the handoff sketched.** Rather
than restructuring `buildAgentWebGPUIfNeeded`'s teardown into an awaited IIFE,
`recompile` was added to the **one-shot staleness set** in the dispatcher — the
mechanism that already exists for exactly this ("block, readback, replay"). The
readback lands before the rebuild, and item 1's `agentGpuUploadPending` then re-seeds
the fresh runtime from it, so a soft recompile is now lossless. This keeps the
one-shot rule in ONE place (master §0 invariant 4).

**7 — M2: FIXED.** `let radPx: f32 = max(ar * rv.scalePx, 1.2);` in the disc VS,
matching the CPU overlay's three `Math.max(1.2, ar[i]! * scale)` sites; the FS rim
band derives from the same `radPx`, so the `>= 2` outline behaviour stays consistent.
No compiler file involved (the runtime's own WGSL string).
**Verification honesty**: the shader compiled on the REAL device (an
`agentRenderStatus{active:true}` ack requires `buildAgentDiscPipelines` →
`getCompilationInfo` with 0 errors) and the change is pure shader arithmetic mirroring
the CPU rule — but the pixel-level zoomed-out A/B needs a VISIBLE pane and was NOT
performed (the pane reports hidden; see Left open).

**8 — M6: FIXED.** The "Single-canvas composite" bullet is deleted from HelpView
(the composite is hard-off), and the "Direct agent render" bullet now names the
no-bonds requirement (item 2).

**9 — M5: FIXED.** `uploadAgentColors` packs into `rt.renderColorScratch`
(persistent, declared on `AgentRenderSurface` so the full webgpu runtime shares it);
slots past `highWater` are zeroed explicitly, so behaviour is unchanged. No
`bench-agent-engine` number recorded — at 50k agents this is ~200 KB of avoided
garbage per call, below the whole-batch timing resolution the branch's earlier perf
work already documented.

**10 — LOW batch: L1, L3, L6, N1, N4 FIXED; L4 landed in commit 1; N2 SKIPPED.**
- **L1**: the `agentDirect && !showGrid2d && bg2d` no-op branch now also requires
  `showAgents`, so hiding agents falls through to the CPU bg fill (the blit that
  carried the shader clear is `showAgents`-gated).
- **L3**: `presentAgentsEncode` returns early on a composite surface + a comment at
  the `dispatchResidentBatch` call site.
- **L4**: `sharedGpuRefCount()` / `sharedGpuAdapterRequestCount()` are surfaced
  through `__e1bCounters` (`gpuRefCount`, `gpuAdapterRequests`, plus
  `hasRenderOnlySurface`) — landed in commit 1 because item 4's verification needed
  it. Re-confirmed live: Chemotaxis on WebGPU/WebGPU reports `refCount 2, adapters 1`.
- **L6**: comment added at the gl3d overlays-only early return.
- **N1**: the `AGENT_GPU_ARRAY_CAP` comment no longer claims byte-identical shaders
  below the cap (semantically identical; the emitted literal replaced the
  `control.maxAgents` read).
- **N4**: `deferredDuringAgentGpuStep` documented as not a peer of
  `asyncStepBatchInFlight`.
- **N2 SKIPPED — deliberately**: `scripts/bench-lattice.mjs` is owned by a CONCURRENT
  planning session (explicitly out of bounds for this pass). Still untracked; that
  session should commit or delete it.

**11 — INVESTIGATED, not implemented.** See the section below.

### Gates

Run before EACH commit (all green every time):
- `npx tsc -p tsconfig.app.json --noEmit` — clean.
- `npm run build` — clean.
- `node scripts/parity-agent-wasm.mjs` — all samples + 13 synthetics, JS↔WASM bit-parity.
- `node scripts/parity-agent-force.mjs` — 7 checks.
- `node scripts/check-compile-identity.mjs` — run for commit 3 (the only one touching
  a file under `compiler/`, a comment): baseline captured on the parent commit via
  `git stash`, compared after → **BYTE-IDENTITY OK, 25 models, all surfaces
  unchanged**. Commits 1 and 2 touch no `compiler/` file (asserted with
  `git diff --stat`), so the identity check does not apply there.

### In-browser results (pane state stated per claim)

The Browser pane reports **hidden/occluded** throughout, so every claim below rests on
worker protocol + DOM/DEV-hook probes, never on composited pixels or rAF. All probes
are message-driven (`stepped`/`agentState`/`agentRenderStatus`/`__e1bCounters`); the
one time a `setTimeout`-based sleep was used it hung (hidden-tab timer throttling) —
split across tool calls instead.

| Check | Result | Pane |
|---|---|---|
| Item 1 pre-fix corruption | agents → (0,0), radius 0, permanent, 0 errors | occluded (state probes) |
| Item 1 post-fix | positions preserved + evolving across a real soft recompile | occluded (state probes) |
| Item 2 Growing Tissue | 0 `attachAgentCanvas` ⇒ CPU overlay ⇒ bonds drawn | occluded (protocol) |
| Item 2 Boids | attach posted, direct path kept | occluded (protocol) |
| Item 3 with `finally` | worker answers after a throw (gen 2 → 4) | occluded (protocol) |
| Item 3 without `finally` | `timeout stepped` — dead-lock reproduced | occluded (protocol) |
| Item 4 post-fix | 6 re-attaches → refCount 1, adapters 1, 6× `active:true` | occluded (DEV metric) |
| Item 4 pre-fix | 6 re-attaches → refCount 1 → **7** | occluded (DEV metric) |
| Item 5 sprite add/remove | `directActive` true → false → true, 1 ack, 0 errors | occluded (DEV hook) |
| Item 7 floored radius | shader compiles + pipelines build on the real device | occluded — **pixel A/B NOT done** |
| Regression: Boids-webgpu | polarization **0.998** over 200 gens, direct render active | occluded (getAgentState) |
| Regression: Chemotaxis WASM+JS | gen 100, f64 agent positions, `eligible:false`, 0 errors | occluded (protocol) |
| Regression: Chemotaxis WebGPU/WebGPU | `gpuBridge 100, cpuFallback 0, sharedDevice true, refCount 2, adapters 1` | occluded (DEV probe) |
| Regression: 3D Tissue | `eligible:false`, 0 attaches, snapshot carries `bonds`, gen 25 | occluded (protocol) |

### New gotchas discovered

1. **A hidden pane throttles `setTimeout` to a standstill** — a `sleep()`-based probe
   hangs indefinitely while worker messages keep flowing. Drive everything off
   message events and split awaits across tool calls (the master's occlusion trap,
   now with a concrete failure mode).
2. **Editing a watched source file mid-probe triggers a Vite full reload** and wipes
   every `window.__*` probe helper. Re-inject the harness after any edit; keep the
   bootstrap in one re-runnable block.
3. **`agentRenderStatus{active:true}` with no pending canvas is treated as a FAILURE**
   and turns direct render off. Any new attach trigger must not race the
   `agentRuntimeReady` handler (which nulls the pending canvas and re-attaches) —
   this is what made the naive M1 fix regress.
4. **A worker message that rebuilds GPU state must be in the one-shot staleness set**,
   not just the mutation set — `recompile` was the missing reader.
5. The **`sprites` gate term doubles as a clean way to make a model render-INELIGIBLE**
   for probing (a general model property, no UI toggle, no rendering side effect when
   no node references the sprite).

### Item 11 — INVESTIGATION (M4: a WebGPU-grid + WebGPU-agent decoupled model runs its agents on JS)

Confirmed as described. In the `webgpuActive` step branch, the E1b arm routes a
**float-field** model onto `runAgentStepWebGPU(bridge)`, and the sibling
`else if (agentStore && simulateAgents && webgpuRuntime)` arm calls the CPU
`runAgentStep()` **regardless of `agentTarget`** — so a decoupled (no-field)
grid+agents model on WebGPU/WebGPU silently ignores the user's agent-target choice.

1. **Can that arm just call `runAgentStepWebGPU()` (no bridge)?** — Yes, on the
   evidence: it is the pre-E1b default, not a requirement. `runAgentStepWebGPUInner`
   already takes the bridge as an OPTIONAL param and skips all field work when
   `fieldReadLen === fieldWriteLen === 0`; the JS/WASM-grid branch already dispatches
   WebGPU agents exactly this way; and it returns `false` on any failure so the
   caller can fall back to `runAgentStep()` for that generation (the same
   bail-out contract E1b's arm uses). Proposed shape:
   `else if (agentStore && simulateAgents && agentTarget === 'webgpu' && agentWebgpuRuntime) { if (!(await runAgentStepWebGPU())) runAgentStep(); … }`
   plus the sprite-advance the GPU path skips (copy E1b's `advanceAgentSprites`
   line) — then the existing `else if` for CPU targets.
2. **Can the RESIDENT batch be reached from that branch?** — Not without
   restructuring, but it is closer than D's report implied. `agentResidentEligible()`
   never tests the grid target, so these models already qualify; what is missing is a
   decoupled variant of D's interleave inside the *async* branch: run
   `runAgentBatchResident(count, /*bump*/false)` once, then the per-gen
   `runStepWebGPU()` loop, all inside the existing `asyncStepBatchInFlight` deferral.
   Both runtimes are on the SAME device since E1, so submits serialise on one queue
   and the layers are decoupled by definition (no field), making order irrelevant.
   The care points are (a) generation counting exactly once (D's `bumpGeneration`
   already solves this), (b) the stop-check/`finalizeStepWebGPU` cadence, which today
   is per-gen inside the loop, and (c) a resident-batch bail-out must fall through to
   the per-gen loop without double-stepping (D's ordering argument applies verbatim).
3. **What changes for the user**: the RNG family (shared xorshift32 → per-agent PCG)
   and f32 agent math — i.e. the documented *statistical, not bitwise* difference.
   That is acceptable and expected here: the user explicitly selected the WebGPU agent
   target, and the SAME model with a JS/WASM grid already runs its agents that way, so
   the current behaviour is the inconsistency, not the fix.

**Recommended plan** (its own small milestone, not this pass): land (1) alone first —
it is a ~6-line change in one branch, honours the user's selection, and is verifiable
with the existing probes (`__e1bCounters.agentTarget` + f32-quantised positions +
a Boids-style polarization metric on a decoupled synthetic). Treat (2) as a separate
follow-up behind its own measurement, since it changes batch structure in the branch
that already caused the P0 concurrency bug.

### Left open (deliberately deferred)

- **M4** — investigated only (item 11 above); no code change in this pass.
- **N2** — `scripts/bench-lattice.mjs`, owned by a concurrent session.
- **L2** — infinity tiling collapses past 256 tiles (cosmetic, rare; untouched).
- **N3** — f32 render-snapshot quantisation of group-move positions (sub-millionth of
  a world unit; untouched).
- **Verification debt items 1–4** (composited-pixel confirmation for A2/C/D, A1's
  visual-parity A/B, C's lighting eyeball, D's z-order probe) remain open: they need a
  VISIBLE pane. Item 7 (the 1.2 px floor) adds one more entry to that list — the
  arithmetic mirrors the CPU rule and the shader compiles on the device, but the
  zoomed-out look was not compared.
- **Verification debt item 7** — there is still no automated harness over the
  render/gate/attach layer. This pass added `window.__agentRenderState()` (DEV) and
  the `__e1bCounters` device metrics, which make the gate matrix and the attach
  lifecycle probeable from a script; a real harness remains future work.

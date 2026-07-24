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

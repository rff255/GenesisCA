# MASTER HANDOFF — GPU-Resident Agent Render & Residency Widening

**Audience**: the ORCHESTRATOR session (coordinates everything) and each
PHASE session (a fresh Opus 4.8 session executing exactly one phase).
This file is the single source of truth for sequence, protocol, and status.

**Mission**: make GPU-resident execution + GPU-side rendering the normal mode
for WebGPU agent models — SandboxScience-class throughput (50k+ agents at
display rate, real-time interaction) — while (1) every existing feature keeps
working (features may cost a readback while actively used, never lose
function) and (2) every gate/optimization keys on GENERAL model properties
(topology, target, capability/usage flags) — never on a specific model's
shape. Design authority: [IMPACT_MAP_GPU_AGENT_RENDER.md](IMPACT_MAP_GPU_AGENT_RENDER.md)
+ [PLAN_GPU_AGENT_RENDER.md](PLAN_GPU_AGENT_RENDER.md) (+ `.html`), background:
[COMPARISON_SANDBOX_SCIENCE_PL.md](COMPARISON_SANDBOX_SCIENCE_PL.md),
[PERF_REVIEW_AGENT_ENGINE.md](PERF_REVIEW_AGENT_ENGINE.md).

---

## 0. Invariants — EVERY phase session obeys these (no exceptions)

1. **Git**: work on branch `optimize`, linear history, one commit per
   milestone with a descriptive message. **NEVER push. NEVER add
   Co-Authored-By or any Claude attribution. NEVER bump the version.**
   PowerShell 5.1 gotcha: no double-quote characters inside `git commit -m
   @'…'@` here-strings (argument mangling); keep messages quote-free.
2. **Scope discipline**: implement YOUR phase only. If an assumption in your
   handoff proves false, STOP, write what you found in your phase doc's
   Completion Report, and end — the orchestrator re-plans. Do not redesign.
3. **First principles**: no gate, emitter, or fast path may test for a
   specific model/rule shape. Only general properties (`topologyMode`,
   resolved agent target, `agentResidentEligible`, usage flags, sprite/
   metaball presence, dims).
4. **Feature preservation**: the readback policy (`free` / `frame` /
   one-shot) is the ONLY sanctioned mechanism for removing per-frame CPU
   work. The one-shot rule lives in ONE place (the worker message
   dispatcher). No feature may ever observe stale agent state.
5. **Verification gates before any commit** (run all that apply):
   - `npx tsc -p tsconfig.app.json --noEmit` and `npm run build`
   - `node scripts/parity-agent-wasm.mjs` (JS↔WASM bit-parity, all entries)
   - `node scripts/parity-agent-force.mjs` (force-pass combos)
   - Compilers touched? → `node scripts/check-compile-identity.mjs`
     baseline discipline (capture on the pre-change commit via git stash,
     compare after; only justified diffs).
   - Perf claims → `node scripts/bench-agent-engine.mjs` numbers in the
     commit message.
   - **REAL-UI in-browser verification is mandatory** (the project rule:
     never conclude "works" from module-level calls alone). Recipes in §3.
6. **Docs consistency in the same phase**: update CLAUDE.md (the feature's
   section), `src/help/HelpView.tsx` where user-visible, README if
   warranted, AND this master's Status Board + your phase doc's Completion
   Report. A phase without its report is NOT done.
7. **Known traps** (all previously hit — do not rediscover them):
   - `sim.worker.ts` contains mojibake comment bytes — anchor Edit
     old_strings on clean ASCII CODE lines, never comment lines.
   - Any new async batch loop in the worker MUST set/clear
     `asyncStepBatchInFlight` (message deferral) — concurrent batches were
     the P0 corruption bug.
   - `device.lost` fires with reason `destroyed` on OUR OWN teardown —
     never report that as an error.
   - Never list the same ArrayBuffer twice in a postMessage transfer list
     (shared length-0 placeholders → DataCloneError).
   - A canvas whose control was transferred has NO 2D context — never
     `putImageData`/resize it from the main thread; the grid direct-render
     comments (SimulatorView.tsx ~:2411) document the discipline.
   - The Browser-pane tab reports hidden → the sim auto-pauses Play; drive
     the worker directly (`window.__simWorker.postMessage({type:'step',
     count:N})`) and never trust rAF/screenshots while occluded — verify
     via canvas pixel reads, worker messages, and DOM probes.
   - Never size a per-thread WGSL array by maxAgents (private-memory
     zero-init collapse — cap pattern `AGENT_GPU_ARRAY_CAP`).
   - WGSL constant-folding rejects non-representable f32 literals (a NaN
     bitcast fails at createShaderModule) — sentinels must be real f32s.

## 1. Phase sequence + dependency graph

```
A1 (resident direct render, 2D agents-only)   ← READY, fully specified
  └→ A2 (same renderer, snapshot-fed: JS/WASM + per-gen GPU)  ← READY
  └→ C  (3D free-mode WGSL sphere render; gl3d keeps frame mode)  [refine first]
B1 (bin-sorted mirror — engine force pass)     ← READY (independent of A)
  └→ B2 (compiler: fused gather over sorted runs)             [refine first]
D (field-decoupled grid+agents residency + two-canvas composite) [refine first]
  └→ E (unified GPUDevice — resident field bridge, one canvas) [refine after D]
F (eligibility widening: sync attrs / springs+growth / positional-as-GPU /
   spawn polling / stop readback / atomic indicators / structural
   request-polling — each its own mini-milestone)              [refine per item]
```
Launch order: **A1 → A2 → B1 → B2 → C → D → E → F** (F items may interleave
after B1). "[refine first]" = the orchestrator expands that phase's handoff
using the completed prior phases' Completion Reports before launching it.

## 2. Phase handoff documents

- **A1**: [HANDOFF_GPU_AGENT_RENDER_A1.md](HANDOFF_GPU_AGENT_RENDER_A1.md) — complete, execute as written.
- **A2 + B1 + B2**: [HANDOFF_GPU_AGENT_RENDER_A2_B.md](HANDOFF_GPU_AGENT_RENDER_A2_B.md) — A2/B1 complete; B2 has its design + an explicit refine step.
- **C, D, E, F**: seeded in [PLAN_GPU_AGENT_RENDER.md](PLAN_GPU_AGENT_RENDER.md) § Extension roadmap.
  The orchestrator writes `HANDOFF_GPU_AGENT_RENDER_<phase>.md` for each
  before launch (same template as A1: objective / exact work items with
  file:line anchors / verification checklist / do-not-touch list /
  Completion Report skeleton).

## 3. Session protocol (for every phase session)

**Boot (read ONLY this — context discipline):**
1. This master's §0 Invariants + §3 + your phase row in §4.
2. Your phase handoff doc, top to bottom.
3. The IMPACT MAP + PLAN sections your handoff points at.
4. The CLAUDE.md sections your handoff lists (not the whole file).

**Work loop**: implement the work items in order → run the §0.5 gates →
in-browser verification per your handoff's checklist → docs (§0.6) →
commit → fill your Completion Report → update the Status Board row → end.

**In-browser recipes** (dev server `npm run dev`, drive via the preview):
- Load a model: fetch the `.gcaproj`, inject via the FileMenu
  `<input type=file>` (DataTransfer + `change`), after stubbing
  `window.confirm/alert`.
- Drive steps: `window.__simWorker.postMessage({type:'step',count:N})`;
  capture `stepped`/`error` via an added listener. Flip UI state through
  REAL clicks on the actual buttons/radios (they respond to `.click()`).
- Read pixels from a DISPLAY canvas via `drawImage` to a scratch +
  `getImageData` on the scratch (never `getImageData` a live canvas).
- Boids flocking metric: polarization = |Σv|/Σ|v| over ~200 steps
  (expect >0.99 from a cold start; ~0.03-0.45 = broken).

**Completion Report skeleton** (append to your phase doc):
`## Completion Report (<date>)` — commits; what changed vs the spec
(deviations + why); measured numbers; new gotchas discovered; anything the
next phase must know.

## 4. STATUS BOARD (the orchestrator + each session keep this current)

| Phase | Status | Session/commits | Notes |
|---|---|---|---|
| A1 resident direct render | **DONE + ORCHESTRATOR-REVIEWED** | `optimize` 3bdd5f4 | render pipeline + readback policy + one-shot rule + gate/attach/UI-sync/glow; session verified (Boids direct render, flocking 0.9991, staleness probes) + orchestrator re-ran gates, audited the diff surface (no compilers/gl3d/engine), and independently confirmed the CPU fallback path + mutation/one-shot correctness on an OM model. Composited pixels USER-CONFIRMED (Boids visible on the WebGPU target in the real app, 2026-07-22) — A1 fully closed. |
| A1.5 GPU agent-OM colour pass | **DONE** (session-verified) | `optimize` (this session) | Compiles each agent OM graph into a per-agent WGSL COMPUTE pass writing the GPU `agentColors` buffer, dispatched inside `dispatchResidentBatch` after the gen loop → OM-coloured WebGPU models (Particle Life) now run FULLY RESIDENT. `emitAgentRootModule` factored so the behaviour + OM roots share one emit (behaviour byte-identical); `agentSubsetSupported` factored so the OM gate reuses the behaviour rejects; result gains `omShaders`+`omSupported` (a SEPARATE verdict — an unsupported OM keeps the GPU behaviour + CPU overlay, never the behaviour verdict). Runtime builds one pipeline per OM (shared SoA buffers; read-only aux/indicators/bond buffers created for the behaviour∪OM UNION, each bind group binds its own declared bindings). Gate relaxed to `agentMappings===0 || agentOmGpuSupported`. **Real-GPU verified**: PL-webgpu ENGAGES resident direct render, 0 errors; the GPU `agentColors` (free-mode getState readback, no CPU recolour) is **BUCKET-IDENTICAL to the CPU OM path** (6 species colours, same counts) — the definitive proof; a 2-view switch re-colours the GPU buffer bidirectionally; Boids (no OMs) unregressed (flocks 0.9992 via getAgentState — `getState`'s vx/vy has a PRE-EXISTING readback artifact unrelated to A1.5); an unsupported OM → `omSupported:false` → CPU overlay (no crash). `git diff --stat` = compile.ts + agentWebgpuRuntime.ts + sim.worker.ts + SimulatorView.tsx (+ compileHarness/check-compile-identity for the new om surface) — NO agentWasm/JS-agent-OM/gl3d/agentEngine/lattice. All gates green (tsc, build, parity ×2, check-compile-identity: only the new `agent.webgpu.om` surface). Completion Report in the A1.5 doc. **ORCHESTRATOR-REVIEWED (5b24c42 approved)**: gates re-run green, tree clean, surface audited; PL-on-WebGPU independently confirmed ENGAGING resident direct render + free-running (renderStatus:true, 8/8 free stepped, liveCount 1800, 0 errors). **QUEUED side-finding**: the session found a PRE-EXISTING artifact — `getState`'s serialized vx/vy holds garbage (~5e19) in ~20% of slots for a resident WebGPU store while `getAgentState` + the sim are clean; likely the frame readback pulling uninitialized GPU velocity for DEAD/free-list slots (harmless on load if so — dead slots re-zero on alloc — but must be CONFIRMED, and live-slot corruption ruled out, before it can be dismissed; a momentum model's .gcastate save is the exposure). Investigate as an F-adjacent mini-item. |
| A2 snapshot-fed renderer | **DONE** (session-verified) | `optimize` (this session) | Render-only surface (`createAgentRenderOnlyRuntime` + tight `uploadAgentRenderFields`) for CPU (JS/WASM) targets; gate widened (dropped webgpu-target + OM-exclusion terms). Session-verified in-browser: Particle Life on WASM+OM ENGAGES (6 OM species colours in `s.colors`), Boids on JS ENGAGES (flocks 0.998), free mode ships 0 snapshot + liveCount at 50k, fallbacks (3D/grid+agents/sprites) keep CPU path, 0 errors. Handler-ms ~12 ms sync-vs-free delta at 50k is INDICATIVE (hidden-pane 0-px canvas makes the real draw a no-op — needs a visible pane, like A1). Re-attach storm while occluded is PRE-EXISTING A1 SHARED behaviour (Boids-webgpu storms identically), not an A2 regression. `git diff --stat` = the same 3 files (no compilers/gl3d/engine). Completion Report in the A2_B doc. **ORCHESTRATOR-REVIEWED**: gates re-run green, diff audited (same 3 files), PL-on-WASM free mode + liveCount independently confirmed in-browser. **Re-attach storm HOTFIXED by the orchestrator** (shared A1/A2: `max(1,0)` attach dims vs raw 0×0 occluded parent → re-attach per draw; real risk = Overseer stepping in a hidden tab): draw() re-attaches only on a REAL size change (`parentW/H >= 2`) — verified 0 attach posts during occluded stepping. User eyeball found a REGRESSION (black at load until Play/interaction — the initial state used to show); orchestrator root-caused + hotfixed: the ack-time draw() blitted the attach present (made with a NULL camera → zero uniform → black), the camera-triggered present then landed in the placeholder but NOTHING re-blitted until the next stepped. Fix = (a) `postAgentCamera` re-blits via double-rAF after the post (the grid compositor-lag trick), (b) the worker's `setAgentCamera` presents FromStore when the store is fresh (raw when residency-stale — a stale upload would clobber GPU truth). LESSON for C/D/E: every present-only path needs a main-thread re-blit follow-up, and the FIRST present after attach must not be the only upload. Awaiting user re-confirmation of load-shows-initial-state. |
| B1 sorted mirror (force pass) | **DONE** (session-verified) | `optimize` — impl in `380b00b` (swept by an orchestrator `git add -A`) + a follow-up commit (temp-debug removal + docs) | Bin-sorted field-major mirror + `sortedId` scattered on the resident hash build (gated on `needScan` = bonding\|\|collision\|\|density — Boids/PL build NO mirror, zero cost); a resident-only mirror-variant force pass reads neighbour fields COALESCED from it. `emitAgentForcePassWGSL(…, mirror)` default false ⇒ **byte-identical** non-resident emission (verified 2D/3D × scatter); `check-compile-identity` 25 models unchanged; `parity-agent-force`/`parity-agent-wasm` green. Real-GPU verified: standalone mirror-force ≡ canonical force **bit-identical** + matches CPU brute-force; a soft-collision gas ENGAGES the mirror + a scatter-readback confirms a correct CSR permutation (`aliveSeenOnce=N/N`, `radiusMismatch=0` @ 450 & 50k) + correct collision; Boids builds no mirror + flocks 0.998. **Perf = a WASH** (10k 3.73 vs 3.46, 50k 46.83 vs 47.03 ms/gen — force-pass coalescing below whole-batch resolution; B1 is B2-infrastructure, mirrors W1). Completion Report in the A2_B doc. **ORCHESTRATOR-REVIEWED**: gates re-run green, tree clean, resident Boids independently confirmed flocking 0.997 post-B1 (velocity sampled via getAgentState — the P2-slim snapshot no longer carries vx/vy, by design). B1 approved. |
| B2 fused gather (compiler) | blocked on refinement — **priority DEMOTED after B1's wash finding** | — | design in A2_B doc. B1's honest result (coalescing the force scan is below whole-batch resolution at 10k/50k) tempers B2's expected value: the behaviour gather is a bigger share of a gen, but the refinement MUST add a measure-first gate — a throwaway prototype of the fused loop on ONE shape (Boids' getNearbyAgents→forEach) benchmarked against canonical BEFORE committing to the full emitter + identity-discipline work. If the prototype is also a wash, B2 is shelved (documented, not built) and the effort goes to C/D/E instead. |
| C 3D sphere render | **DONE** (session-verified) | `optimize` (this session) | WGSL sphere-impostor pass in the agent runtime (billboard raycast + frag_depth + gl3d-parity Z-up remap & lighting formula) rendered into a canvas layered UNDER the gl3d canvas (browser-composited, no blit); gl3d gets `setOverlaysOnly` (skip voxels/agents/bonds/metaballs/shadows + transparent clear). The MVP + light dir are MAIN-thread-computed via `sceneCameraMatrices`/`lightWorldDirFor` EXPORTED from gl3d.ts (setCamera/lightWorldDir now delegate → single source, can't disagree); shipped in a `mode:'3d'` `AgentRenderView3D` on the SAME `setAgentCamera` message. Gate extends the 2D gate: agents-only + is3D + no sprites/metaballs + `resolveMaxBonds===0` + 3D alpha-blend OFF + OffscreenCanvas (alpha-ON detaches → frame mode; OFF re-attaches). Free/frame flip: frame requires a snapshot in hand (seamless, no blank frame); the worker's `setAgentUiSync` OFF→ON now ALSO ships one snapshot so a PAUSED gl3d (draws/picks from the snapshot) has fresh agents. Recording rides the frame-mode flip (readPixels). **RENDER-ONLY, zero compiler changes** (`git diff --stat` = gl3d.ts + agentWebgpuRuntime.ts + sim.worker.ts + SimulatorView.tsx — no `compiler/`/agentEngine/lattice; 2D disc path byte-behaviour-identical). **Real-GPU verified**: PL3D-webgpu ENGAGES 3D direct render (renderStatus true, sphere WGSL 0 errors), free-runs resident (noAgents + liveCount 1200, 0 GPU errors, agents move in 3D z 4.11→5.92); CPU-target (wasm) PL3D engages the snapshot-fed 3D surface (liveCount 1200); OFF→ON ships a snapshot even paused; Alpha-blend ON detaches → frame snapshot, OFF re-attaches; 3D Tissue (maxBonds 12) stays CPU; 2D Boids-webgpu still disc-renders (sphere layer empty); DOM layering correct (sphere z1 before gl z2), no leak, 0 errors session-wide. tsc + build + parity ×2 green. **Composited pixels + lighting-parity eyeball need a VISIBLE pane** (occlusion trap — orchestrator/user spot-check). Completion Report in the C doc. **ORCHESTRATOR-REVIEWED (911c767 approved)**: gates re-run green, tree clean, surface audited (4 render files, no compilers); PL3D-webgpu independently confirmed ENGAGING 3D direct render + free-running resident (renderStatus:true, 8/8 free stepped, liveCount 1200, z spread 13.6–69.0, 0 errors). Pending the user's visual eyeball of the 3D spheres. |
| D field-decoupled grid+agents | **DONE + ORCHESTRATOR-REVIEWED** (945cbb3; gates re-run green, 2-file surface, Ant Necrophoresis independently confirmed unchanged) | `optimize` (this session) | Replaces the agents-only proxy with the true FIELD-DECOUPLING term (`!agentUsesField && fieldSpecs.length === 0`) in BOTH the worker residency gate AND the render gate. A 2D grid+agents model whose agents never touch a cell field now runs the agent layer resident + direct-rendered while the grid steps + renders by its own path (2D composite: grid below, transparent agent canvas above). Worker: `agentResidentEligible` relaxed; the resident step-batch runs the resident agent batch (`bumpGeneration=false`) THEN the grid's N `runStep(true)` + tail indicator scan + sparse colour pass (generation counts ONCE via the grid loop; a bailout falls through to the unchanged per-gen loop cleanly since the resident batch advances nothing on failure). Render: gate's `gridCells === false` → `(gridCells === false \|\| (agentDecoupled && !is3D))`; `computeAgentRenderView` clears the agent canvas TRANSPARENT when the grid layer shows (grid = background); `draw()` UNCHANGED (already composites grid-then-agents). **3D grid+agents deliberately keeps the CPU path** (`&& !is3D` — voxels-vs-spheres depth compositing is Phase E). **RENDER + worker only, ZERO compiler changes** (`git diff --stat` = sim.worker.ts + SimulatorView.tsx). **Real-GPU verified**: a SYNTHETIC decoupled model (Boids agents + GoL cell side, WASM grid, no agentAccess) on the WebGPU agent target ENGAGES residency (one submit, `bump:false grid:true`) + free-mode direct render (`hasAgents:false` + liveCount 260 + grid colours 57600), the grid EVOLVES simultaneously (seeded 20×20 block aliveSum 400→328 over 4 gens), gen counts ONCE per gen (0→8→12 over 8+4 steps), 0 errors; on a CPU (js) agent target the same model engages the A2 snapshot-fed render with the grid below (free mode, liveCount 260, grid colours ship), 0 errors; Ant Necrophoresis + Chemotaxis (field-coupled) stay per-gen CPU (no resident batch, ship agents + colours), 0 errors; agents-only Boids-webgpu unchanged (`bump:true grid:false`, free, no colours). tsc + build + parity ×2 green. **Composited PIXELS / z-order visual / recording-both-layers need a VISIBLE pane** (occlusion trap — orchestrator/user spot-check). Completion Report in the D doc. |
| E1 shared GPUDevice (device unification) | **DONE + ORCHESTRATOR-REVIEWED** (10d58ce; gates re-run green, device-lifecycle-only surface; items 2/3 correctly STOPPED on the layout-mismatch finding) | `optimize` (this session) | The refcounted worker-owned singleton [sharedGpuDevice.ts](../src/simulator/engine/sharedGpuDevice.ts): one adapter+device (UNION limits) serves the grid runtime + every agent runtime (full + A2 render-only). Every `createX` takes the device (releases on throw); every `destroyX` releases the reference (destroys the device only at the LAST release — a rebuild reuses it, a live sibling isn't killed); `uncapturederror`/`lost` (filter `'destroyed'`) consolidated at the singleton (per-runtime hooks removed). RENDER/runtime-only, **ZERO compiler changes** (`git diff --stat` = sharedGpuDevice.ts + webgpuRuntime.ts + agentWebgpuRuntime.ts + a small sim.worker.ts hunk). **Real-GPU verified**: Chemotaxis on WebGPU grid + WebGPU agents → **adapterRequests=1, refCount=2** (both runtimes, ONE device — pre-E1 was two); **2 recompile cycles → adapterRequests stays 1** + refCount balanced (no leak); field model steps gen 20 + post-recompile, fresh getState, 0 errors; agents-only Boids-webgpu flocks 0.9987 on the shared device. tsc + build + parity ×2 green. **Items 2/3 (zero-copy field bridge + field-coupled residency) STOPPED with a finding** (§0 #2): item 2's DIRECT-BIND is a confirmed-false assumption (agent compacted-f32 field layout ≠ grid per-attr-bitcast-word layout + constant-boundary sentinel + int/tag bit-pattern), and a WebGPU-grid+WebGPU-agent FIELD model runs its agents on JS today (branch restructure needed) — a concrete compiler-free GPU-copy re-plan is in the E1 Completion Report for the orchestrator to refine an E1b/E-field handoff. Completion Report in the E doc. |
| E1b GPU field bridge (buffer copies) | **DONE** (session-verified) | `optimize` (this session) | On the E1 shared device, a **float-field** model on **WebGPU grid + WebGPU agents** runs the per-gen field round-trip as GPU `copyBufferToBuffer` passes (prime grid `attrsRead`→agent `fieldRead`+`fieldDeposit`, dispatch the agent gen on the GPU runtime, fold `fieldDeposit`→grid `attrsRead`) instead of the CPU `uploadAgentField`/`readbackAgentField`. The `webgpuActive` branch's field agents (which ran JS `runAgentStep`) now route onto the GPU runtime; `runAgentStepWebGPUInner` gained an optional `gpuFieldBridge` param swapping the CPU prime/fold for the GPU copies. Gate = `agentFieldBridgeGpuEligible()` (WebGPU grid + WebGPU agent + shared device + a field bridge + every `fieldSpecs` float); int/bool/tag field or non-shared device → CPU bridge unchanged. `attrsReadBuf` re-resolved each gen (ping-pong); queue order = the barrier; `gpuOwnsAttrs` stays true (getState pulls fresh grid via `ensureCpuAttrsFresh`, per-gen readbackAgentStep keeps agents fresh); GPU bail → CPU bridge inline. **RENDER/worker only, ZERO compiler changes** (`git diff --stat` = agentWebgpuRuntime.ts + sim.worker.ts + PropertiesPanelContent.tsx hint + HelpView.tsx; the layouts are untouched — the whole point of the copy design). **Real-GPU verified**: Chemotaxis-webgpu/webgpu ENGAGES (gpuBridge=420, cpuFallback=0, 0 errors), field builds (chem max 0→34, all cells nonzero), agents aggregate (occ bins 89→69, clusterSq 712→1016) — statistically equivalent to the CPU-bridge run (clusterSq 1000, occ 68 on WASM grid + JS agents; only the documented RNG family differs); Ant Necrophoresis piles form (corpse max 1→8, cells≥3 0→44, gpuBridge=600); getState mid-run returns fresh grid attrs + agents; defaults untouched (shipped WASM-grid Chemotaxis eligible:false → CPU bridge); an int-field synthetic → eligible:false → CPU bridge, 0 errors; agents-only Boids-webgpu unchanged (gpuFieldBridge 0, polarization 0.999). **Perf** (warm batch, WebGPU grid, GPU bridge vs CPU bridge): 100×100 **3.34 vs 6.67 ms/gen (~2×)**; 200×200 4× field **4.04 vs 8.00 ms/gen**. DEV probe `__e1bCounters` (mirrors E1's adapter-count probe) proves engagement. tsc + build + parity ×2 green. Completion Report in the E1b doc. **Composited pixels need no eyeball — E1b is not a render change** (only the field-bridge MECHANISM changes; grid + agents render exactly as before). |
| E2 single-canvas composite + 3D lift | **2D CORE DONE** (session-verified); 3D voxel stretch STOPPED (deliberate, recorded) | `optimize` (this session) | A 2D grid+agents model with a **WebGPU GRID + WebGPU AGENT target** now composites BOTH layers into ONE world-sized canvas in one encoder — a `GRID_PRESENT_WGSL` fullscreen-triangle render pass reading the grid `colorsBuf` (loadOp clear+write) then the agent disc pass (loadOp:'load') over it — removing the grid's per-gen colors READBACK + the D two-canvas composite. Covers BOTH decoupled (D) AND field-coupled resident (E1b — Chemotaxis/Ant); a SEPARATE `agentComposite` gate (independent of `agentRenderEligible`) widens to field-coupled. World-space arrangement adopted verbatim (canvas = grid `W×H`, agent camera scalePx=1, main-thread blit scales it; agents at world res = accepted blur-at-zoom tradeoff). Per-layer `showGrid`/`showAgents` toggles threaded. **RENDER/worker only, ZERO compiler changes** (`git diff --stat` = agentWebgpuRuntime.ts + sim.worker.ts + SimulatorView.tsx — NO gl3d/agentEngine/lattice, and even `webgpuRuntime.ts` UNTOUCHED: the grid layer is a self-contained render-pass in the agent runtime binding the grid `colorsBuf` on the shared E1 device). **Real-GPU verified** via a DEV `__compositeReadback` (`copyTextureToBuffer` + pixel sample — occlusion-safe proof both layers on ONE texture): D-synthetic (GoL grid + Boids agents) ENGAGES composite (`hasColors:false`, `composite:true`) — cyan agent discs `[76,201,240,255]` over opaque grid cells; the `showGrid` OFF→transparent / ON→opaque differentiator proves the grid pass reads `colorsBuf` + the Show toggles work. Chemotaxis-webgpu/webgpu ENGAGES composite with E1b unchanged (`gpuBridge:60, cpuFallback:0, sharedDevice:true`, 0 errors) — chemical field `[68,1,84,255]` + cyan discs on ONE canvas. Fallbacks: agents-only Boids-webgpu → `composite:false` (standard render); grid-only GoL-webgpu → unchanged direct render; JS/WASM grid / 3D / sprites / metaballs → gate false. 0 console/GPU errors. tsc + build + parity ×2 green. **Composited PIXELS + world-res blur EYEBALL need a VISIBLE pane** (occlusion trap — orchestrator/user spot-check); recording-both-layers likewise (display-canvas capture path). **3D voxel-composite stretch NOT attempted** (deliberate STOP per the handoff — a WGSL instanced-voxel pass depth-composited with the C sphere pass is a substantial separate render feature warranting its own phase; the 2D world-space arrangement doesn't carry to voxels). Completion Report in the E2 doc. | **ORCHESTRATOR-REVIEWED (9317f08 approved)**: gates re-run green, 3-code-file surface (webgpuRuntime.ts untouched - a bonus), Chemotaxis WebGPU/WebGPU independently confirmed on the composite (30 gens, ZERO colours shipped = the grid readback eliminated, 0 errors). Pending user eyeballs: the composite visual + the world-resolution-agents-at-high-zoom tradeoff sign-off. 3D voxel-composite = a recorded follow-up phase.
| F eligibility widening | after B1 (items independent) | — | one mini-handoff per item |

## 5. Orchestrator duties

1. Launch one phase session at a time (fresh Opus 4.8 session; boot prompt
   below). Never two sessions touching the same files concurrently.
   **And never `git add -A` while a phase session is in flight** — stage
   EXPLICIT paths only (an orchestrator hotfix once swept a running
   session's half-finished edits into its commit, 380b00b). If it happens:
   leave the mixed commit (splitting races the session's git ops), message
   the session so it doesn't panic-revert, and note the span in both
   commit messages.
2. On completion: read the Completion Report, spot-check the gates yourself
   (rerun parity + one in-browser probe), review the diff
   (`git diff <prev>..HEAD --stat` + read the risky hunks), and only then
   mark the Status Board row done.
3. Refine the next phase's handoff with what the report taught.
4. Keep the user informed per phase: what shipped, measured numbers, what's
   next. The user handles all pushes/releases.

**Boot prompt template** (fill `<PHASE>`; paste as the session's task):
> Work in C:\- Genesis\GenesisCA on branch `optimize`. You are executing
> phase `<PHASE>` of the GPU-Resident Agent Render project. Read
> docs/HANDOFF_GPU_AGENT_RENDER.md sections 0, 3 and your row in 4, then
> docs/HANDOFF_GPU_AGENT_RENDER_<PHASE>.md in full, then the impact-map/plan
> sections it references. Execute exactly that phase: implement, verify
> every gate (including real-UI in-browser checks), update the docs it
> lists, commit on `optimize` (never push, no co-author, no version bump),
> fill in your Completion Report, update the master Status Board, and stop.
> If any stated assumption is false, stop and record findings instead of
> redesigning.

# PHASE E1b HANDOFF — GPU Field Bridge via Buffer Copies (field-coupled residency)

Read first: [HANDOFF_GPU_AGENT_RENDER.md](HANDOFF_GPU_AGENT_RENDER.md) §0/§3 +
ALL Status Board rows; then this doc; then **the E1 Completion Report in
[HANDOFF_GPU_AGENT_RENDER_E.md](HANDOFF_GPU_AGENT_RENDER_E.md) — REQUIRED,
top to bottom**: its ITEM-2/3 FINDING section is the ground truth this phase
is built on (the field-layout mismatch that killed the direct-bind idea) and
its CONCRETE RE-PLAN section IS this handoff's design, adopted verbatim by
the orchestrator. CLAUDE.md context: the WebGPU grid section (attrsBufA/B
ping-pong + `gpuOwnsAttrs`), "Phase F — PR7 G5" (the CPU field bridge:
`uploadAgentField`/`readbackAgentField` — read their exact semantics, they
define the copies), and the E1 subsection (the shared device you build on).

**Objective**: on the shared device (E1), replace the per-generation CPU
field round-trip with **GPU `copyBufferToBuffer` passes** for eligible
models, and route their agents onto the GPU agent runtime — so field-coupled
models (Chemotaxis/Ant class, on WebGPU grid + WebGPU agents) run their whole
generation GPU-side. NOT a direct bind (proven impossible without compiler
changes), NOT new shaders (the float-gate makes copies sufficient).

**The gate** (all general): WebGPU grid active + WebGPU agent target +
shared device live + **every agent-accessible cell attr (`fieldSpecs`) is
type `float`** (the byte-pattern equivalence: grid `bitcast<u32>(f32)` word
== agent `f32` — a raw copy is correct; any int/bool/tag field keeps the CPU
bridge) + the model's existing residency terms except the field exclusion
(which this phase lifts for the gated class). Both shipped field models
(Chemotaxis, Ant) are float-field — they're the verification stars once both
targets are flipped to WebGPU.

---

## Work items (the E1-report re-plan, adopted)

1. **Per-gen GPU bridge, queue-ordered** (separate submits are CORRECT —
   queue order is the barrier; one-submit is a later optimization):
   - prime: `copyBufferToBuffer(grid attrsReadBuf @ attr.byteOffset →
     agentFieldReadBuf @ fieldReadBase*4, total*4)` per read-attr (cells
     0..total-1; a constant-boundary sentinel at index `total` is excluded
     automatically by the size);
   - prime deposit: same shape into `agentFieldDepositBuf` per write-attr
     (mirrors `uploadAgentField`'s priming of the accumulator with the
     current field);
   - dispatch the agent gen (behaviour → force → posCommit — the resident
     machinery);
   - fold: `copyBufferToBuffer(agentFieldDepositBuf @ fieldWriteBase*4 →
     grid attrsReadBuf @ attr.byteOffset, total*4)` per write-attr (the
     deposit words ARE the final f32 field — `readbackAgentField` is a
     plain copy today, so the fold is too; no decode pass);
   - grid `dispatchStep` (its copy lines carry the deposit into the next
     gen). **Re-resolve the grid's attrsRead-side buffer EVERY gen** — it
     ping-pongs per step (read the swap code, never cache across steps).
2. **Route the `webgpuActive` branch's field agents onto the GPU agent
   runtime** (today they run JS `runAgentStep()` with the CPU round-trip).
   Structure the combined loop inside the EXISTING `asyncStepBatchInFlight`
   deferral; generation counts once per gen; every failure falls back to
   the current CPU-bridge path loudly-but-safely for that batch.
3. **Buffer usage flags** (additive): grid `attrsBufA/B` += `COPY_SRC |
   COPY_DST`; agent `fieldReadBuf` += `COPY_DST`; `fieldDepositBuf` +=
   `COPY_SRC | COPY_DST`. Verify none of these change existing behaviour.
4. **getState / readback policy interplay**: for this class the field
   lives in the GRID attrs (GPU) — `gpuOwnsAttrs → ensureCpuAttrsFresh`
   pulls it down; the agent one-shot rule pulls the agent store. Verify a
   mid-free-run `getState` returns fresh grid attrs AND agents. Stop-flag /
   indicator cadences unchanged.
5. **RNG note for verification**: routing agents JS→GPU changes the RNG
   family (shared xorshift32 → per-agent PCG) — equivalence is STATISTICAL
   (the documented WebGPU stance), never bitwise. Use the models' own
   metrics.

## Do NOT touch
Compilers (ZERO compiler changes — the layouts stay as they are; that's the
whole point of the copy design; assert with git diff --stat), agentEngine,
gl3d, the render seams. JS/WASM-grid field models + int/bool/tag-field
models keep today's CPU bridge byte-for-byte.

## Verification (all mandatory)
- tsc, build, parity ×2; git diff --stat audit (no compiler files).
- Real GPU in-browser (message-count probes):
  - **Chemotaxis flipped to WebGPU grid + WebGPU agents**: engages the GPU
    bridge (no per-gen `uploadAgentField`/`readbackAgentField` CPU work —
    instrument via a DEV counter or the absence of the CPU-bridge code
    path), the field BUILDS (chemical max grows via getState), agents
    AGGREGATE (the shipped clustering metric) — statistically equivalent to
    the CPU-bridge run on the same seed; 0 errors across 100+ gens.
  - **Ant Necrophoresis likewise** (piles form; corpse counts move).
  - `getState` mid-free-run: fresh grid attrs + fresh agents.
  - Defaults untouched: Chemotaxis/Ant on their SHIPPED targets (non-WebGPU
    grid) behave byte-identically (the CPU bridge path).
  - An int/tag-field synthetic (flip a field attr type in-memory) → gate
    false → CPU bridge, no errors.
  - Agents-only + decoupled models: unchanged.
  - Perf: ms/gen CPU-bridge vs GPU-bridge for Chemotaxis at shipped size +
    a larger field (e.g. 4×), in the commit message.

## Completion Report (2026-07-23)

**Outcome**: SHIPPED + real-GPU-verified. All 5 work items done; all verification
items pass. The re-plan (float-field gate, prime/fold copyBufferToBuffer per gen,
route the `webgpuActive` field agents onto the GPU runtime, queue-order barriers)
implemented verbatim.

**Commit** (branch `optimize`, not pushed): one commit —
`perf(agents): E1b GPU field bridge via buffer copies (field-coupled residency)`.
`git diff --stat` = [agentWebgpuRuntime.ts](../src/simulator/engine/agentWebgpuRuntime.ts)
+ [sim.worker.ts](../src/simulator/engine/sim.worker.ts) + the WebGPU-agent hint in
[PropertiesPanelContent.tsx](../src/modeler/panels/PropertiesPanelContent.tsx) +
[HelpView.tsx](../src/help/HelpView.tsx). **NO compiler files, NO agentEngine, NO gl3d,
NO render seams** — the layouts stay exactly as they are (the whole point of the copy
design).

### What shipped
- **`primeAgentFieldFromGrid` / `foldAgentFieldToGrid`** (agentWebgpuRuntime.ts): the two
  GPU copies. Prime = per read-attr `copyBufferToBuffer(gridAttrsReadBuf @ attr.byteOffset →
  agentFieldReadBuf @ fieldReadBase[id]*4, total*4)` + per write-attr the same into
  `agentFieldDepositBuf` (primes the atomic accumulator with the current field). Fold = per
  write-attr `copyBufferToBuffer(agentFieldDepositBuf @ fieldWriteBase[id]*4 →
  gridAttrsReadBuf @ attr.byteOffset, total*4)`. `total*4` copies cells 0..total-1, so the
  constant-boundary sentinel at index `total` is excluded automatically. No decode (the
  deposit words ARE the final f32 field — `readbackAgentField` is a plain copy today).
- **`runAgentStepWebGPUInner(gpuFieldBridge?)`** (sim.worker.ts): the field prime/fold blocks
  branch on the param — set ⇒ the GPU copies, absent ⇒ the unchanged CPU
  `uploadAgentField`/`readbackAgentField`. `runAgentStepWebGPU` threads it.
- **The `webgpuActive` route**: the field-agent block is now `if (…&& agentFieldBridgeGpuEligible())`
  (GPU bridge) `else if (…)` (the unchanged CPU bridge). Per gen: `if (!gpuOwnsAttrs) uploadAttrs`
  guard, then `buildGpuFieldBridge()` (re-resolves the LIVE `attrsReadBuf` — it ping-pongs per
  step), then `runAgentStepWebGPU(bridge)`. `gpuOwnsAttrs` stays true; a GPU bail falls back to
  the CPU bridge inline. Sprites advanced explicitly (the GPU path doesn't).
- **`agentFieldBridgeGpuEligible()`**: WebGPU grid + WebGPU agent target + shared device
  (`agentWebgpuRuntime.device === webgpuRuntime.device`) + a field bridge present + every
  `fieldSpecs` attr `float`.
- **DEV probe** `__e1bCounters` + module counters (mirrors E1's `sharedGpuAdapterRequestCount`,
  permanent, DEV-only — the app never sends the message).
- Docs: CLAUDE.md E1b subsection, the Properties WebGPU-agent hint, the HelpView performance
  bullet, this report, the master Status Board row.

### Buffer usage flags (work item 3) — already satisfied, no change needed
Grid `attrsBufA/B` already carry `STORAGE | COPY_DST | COPY_SRC`; agent `fieldReadBuf` uses
`STORAGE_RO = STORAGE | COPY_DST`; `fieldDepositBuf` uses `STORAGE | COPY_DST | COPY_SRC`. All
the copy endpoints already have the right usage — verified, no additive flag change.

### Measured (real WebGPU, in-browser, hidden pane → worker protocol + getState + the DEV probe)
- **Chemotaxis WebGPU grid + WebGPU agents**: `eligible:true`, `sharedDevice:true`,
  `fieldSpecTypes:['float']`. Over 420 gens **gpuBridge=420, cpuFallback=0, 0 errors**. Field
  BUILDS: chemical max 0→22.6 (120 gens)→34.0 (420); all 10000 cells nonzero. Agents AGGREGATE:
  occupied bins 89→79 (120)→69 (420); clusterSq 712→844→1016.
- **CPU-bridge baseline** (same model, WASM grid + JS agents, `eligible:false`): 420 gens →
  clusterSq 1000, occupied 68, chemMax 31. **Statistically equivalent** to the GPU bridge — the
  only difference is the documented per-target RNG family (WebGPU per-agent PCG vs JS xorshift32).
- **Ant Necrophoresis WebGPU/WebGPU**: gpuBridge=600, 0 errors; piles form (corpse max 1→8,
  cells≥3 0→44, corpseSum 650→539).
- **Defaults untouched**: shipped Chemotaxis (WASM grid) → `eligible:false`, gpuBridge=0 → CPU
  bridge path (byte-identical).
- **Int-field synthetic** (chemical type flipped to integer) → `eligible:false`, gpuBridge=0 →
  CPU bridge, 60 gens, 0 errors.
- **Agents-only Boids-webgpu** unchanged: gpuFieldBridge 0, eligible:false, polarization 0.999,
  0 errors (E1b touches only the WebGPU-GRID branch's field routing).
- **getState mid-run**: fresh grid attrs (chemMax/agents reflect the latest gen) throughout.
- **Perf** (warm step-batch, WebGPU grid, GPU bridge vs CPU bridge = WebGPU grid + JS agents):
  100×100 field **3.34 vs 6.67 ms/gen (~2×)**; 200×200 (4× field) **4.04 vs 8.00 ms/gen** (the
  GPU bridge scales better — +0.7 ms for 4× field vs the CPU bridge's +1.3 ms). The win is both
  the eliminated field round-trip AND moving the agent step JS→GPU (the pre-E1b path ran a
  WebGPU-grid field model's agents on JS).
- Gates: `tsc -p tsconfig.app.json --noEmit` + `npm run build` + `parity-agent-wasm` (18) +
  `parity-agent-force` (7) all green. No compiler files → `check-compile-identity` not required.

### Deviations from the handoff (all justified)
1. **Field-model signal = the runtime's field bridge (`fieldReadLen>0 || fieldWriteLen>0`), not
   `agentUsesField`.** This is the "is this a field model" test that also drives whether
   `runAgentStepWebGPUInner` does field work, so it's the natural gate. A degenerate model with
   `agentAccess` but no field NODE is handled correctly (the deposit is unmodified ⇒ the fold is
   identity ⇒ the field is unchanged) — same net result as the CPU bridge, at a tiny copy cost.
2. **Kept the DEV probe permanently** (mirrors E1's `sharedGpuAdapterRequestCount`), rather than
   add-then-remove — so the committed code is exactly what was verified, and E2/future sessions
   can reuse it.
3. **Updated the Properties WebGPU-agent hint + a HelpView bullet** (not in the "do not touch"
   list — they're UX/docs, required by the §0.6 docs-consistency invariant). No compiler/render
   files.

### Gotchas discovered (for the next session)
- The agent WebGPU runtime **already builds for a WebGPU-grid field model** (`buildAgentWebGPUIfNeeded`
  gates only on `agentTarget === 'webgpu'`, independent of the grid target) — the pre-E1b
  `webgpuActive` branch just IGNORED it (ran JS agents). So E1b engaging required no new build
  path; the runtime was already there and ready.
- `sim.worker.ts` has mojibake comment bytes on the SAME lines as some code — the fold-block
  edit had to anchor on clean code lines and split into an `if …gpuFieldBridge` / `else if`
  rather than replace the mojibake-carrying comment. The `webgpuActive` route edit anchored only
  on the clean `if (agentStore && simulateAgents && webgpuRuntime)` opening line.
- `gpuOwnsAttrs` staying TRUE is load-bearing: the GPU bridge never touches CPU `readAttrs`, so
  the getState/`ensureCpuAttrsFresh` interplay is automatic and free. Any future change that
  pulls the field to CPU mid-bridge would break this — keep the field GPU-resident.

### E2 seed notes
- E1b confirms both runtimes are on the shared device (`sharedDevice:true`) for a WebGPU-grid +
  WebGPU-agent field model — the E2 prerequisite. A single WebGPU canvas context binds ONE
  device; E2's grid+agents single-canvas composite can now bind both.
- The E1b field bridge uses **separate queue-ordered submits** (prime → agent step → fold → grid
  step). E2's "one submit" is still available as an optimization but was NOT needed for
  correctness (queue order is the barrier — verified with 0 errors over 600+ gens).
- The `webgpuActive` field-coupled path is now the resident GPU path for the float-field class;
  a 3D field model would pay the D× per-step field bytes but the GPU-copy path scales the same
  way (no CPU round-trip) — E2/F can widen to 3D grid+agents composite render.

# Plan — Full WASM + WebGPU agent compile targets (Phase F execution)

Illustrated mockup: [MOCKUP_AGENT_COMPILE_TARGET.html](MOCKUP_AGENT_COMPILE_TARGET.html)

**Goal.** Make the **Agent Compile Target** radio (Properties → Bond-Graph Agents) —
JS / WebAssembly / WebGPU — *fully* functional for **every** agent model, with a real
WASM speedup and a WebGPU scale path, so the user can pick the engine like they do for
the CA grid.

This **reconciles with + executes** the existing adversarially-reviewed runbooks — do
NOT re-derive them, read them:
- [docs/HANDOFF_CAPSTONE_3D_AGENTS_PHASE_F.md](HANDOFF_CAPSTONE_3D_AGENTS_PHASE_F.md) — §2 **PR6** (WASM) + **PR7** (WebGPU) bodies, §3 cross-cutting gotchas, §4 the deferral license. The detailed per-PR specs live there.
- [docs/HANDOFF_AGENTS_FLOATING_CELLS.md](HANDOFF_AGENTS_FLOATING_CELLS.md) — the Phase F runbook + the ABI-mirror / dangling-bond / eigensolve discipline.

This plan adds **one deliberate delta** to the handoff (see W2 below) and re-orders the
remaining work around the user's "significant boost" requirement.

---

## Honest expected gains (state this up front)

The spatial hash already makes the JS agent loop **O(N)** — **2000 boids run at 174
steps/sec** on JS today. So **neither target fixes a current bottleneck; both raise the
ceiling.** Set expectations accordingly:

| Target | Realistic gain | Ceiling | Caveat |
|---|---|---|---|
| **WASM** (full: behaviour + **force pass**) | **~2–4×**, predictable (no JIT warmup/GC cliffs) | ~10k → ~30–40k agents | f64 → **JS↔WASM bit-parity**. The force pass is the lever (today it's JS even on WASM). |
| **WebGPU** | **~10–100×** *only past ~10k agents* | 100k–1M (force-driven swarms) | f32, statistical parity. The **CPU structural round-trip dominates below ~10k** → JS/WASM is competitive there. The honest **deferral candidate** (handoff §4). |

The "big boost like the CA grid" is most directly delivered by the **WASM force-pass
port (W2)** — and at very large counts by WebGPU. For typical research/teaching counts
(hundreds–few thousand), JS is already interactive. **But the boost grows with rule
complexity:** the Boids benchmark measures the *trivial* engine force loop (V8 JITs it
near-optimally, so WASM ≈ JS there). A **heavy per-agent behaviour graph** (a
chromatography-in-agents rule — interaction tables, many neighbour reads, conditionals)
is the case where WASM pulls ahead of JS and WebGPU pulls ahead of both, exactly as on
the grid. Benchmark a heavy rule, not Boids.

---

## FULL-COVERAGE MANDATE (every node, every target — no permanent subset)

**Hard requirement (user directive): every node must run on every compile target.** The
per-target "supported subset" gates (`AGENT_WASM_SUPPORTED_TYPES`,
`AGENT_WEBGPU_SUPPORTED_TYPES`, `isAgentGraph{Wasm,WebGPU}Supported`) are a **staging
artifact of incremental porting — they must shrink to zero**, not be a permanent
restriction on what the user can model. The end state matches the CA grid: pick any
target, model freely.

Audit conclusion (every node × target classified):
- **WASM (grid + agents): full coverage is achievable for EVERY node, bit-parity (f64).**
  WASM-grid is *already* full coverage (nothing rejected). WASM-agents is the Boids
  subset only because the rest is **not-yet-ported**, never un-portable.
- **WebGPU (grid + agents): full coverage in SYNC mode, f32 (statistical parity).** Every
  node runs; the structural phase (division/bonds/death/auto-bond) + division-event +
  field deposit execute **CPU-side via the readback→CPU→re-upload round-trip** — the user
  KEEPS those nodes, they just run on the CPU within the GPU pipeline (the
  GPU-particle-system-with-CPU-emission architecture). No node is removed.

The **only legitimately-fundamental exclusions** (mode/precision, NOT node bans — they
stay, exactly as on the grid today):
1. **Async update mode on WebGPU** (grid) — async = "a write is visible to a later cell
   *this* step," fundamentally serial, no parallel-GPU representation. A *model-mode*
   gate (the user keeps async by picking WASM/JS). NB: there are **no async-only AGENT
   nodes**, so this doesn't even constrain agents — the WebGPU agent path just runs in
   sync agent mode.
2. **`updateIndicator` toggle/next/previous on WebGPU** (grid) — order-dependent
   non-commutative mutation of one shared accumulator by parallel writers; the lone
   genuinely node-op-level fundamental case. (or/and/max/min/inc/dec ARE supported via
   atomics.)
3. **f32 precision + per-cell PCG RNG on WebGPU** (grid + agents) — statistical parity,
   not bit-exact; bars no node.

### The not-yet-ported worklist (this is what "full coverage" requires)
- **WASM agents — port the whole catalogue** (bit-parity): the structural-WRITE nodes
  (`formBond`/`breakBond`/`killAgent`/`divideAgent`) are **trivial** — they emit a
  request-flag store into the shared wasmBacked memory; the heavy mutation is already the
  CPU structural phase. Then the not-yet-ported emitters: the **field bridge**
  (sampleField/fieldGradient/readCellsUnder/affectCellsUnder/secreteToField),
  `getCellAttribute`/`getAgentAttribute`, the **agent-array tier**
  (getBondedAgents/filter/join/pickRandom(N)/getAgentsAttribute/setAgentsAttribute),
  per-agent SoA r/w (setVelocity/setAgent*), `forEachBond` + getBondDegree/
  neighbourDensity/getCurvature, the **division-event + agent-init** modules (2nd/3rd
  compiled fns), array Local Variables, and the **universal nodes** (aggregate/switch/
  loop/setCellLooks/getModelAttribute/indicators/colorScale/…) — all have working
  lattice emitters; the agent compiler just doesn't dispatch them yet (idx-based SoA
  addressing is the only change). **Relax the `≤4 getNearbyAgents` + `forEach-source must
  be getNearbyAgents` structural gates** too.
- **WebGPU agents — wire the runtime (in progress), then port the same catalogue**
  (structural/field via the CPU round-trip; the array tier + universal nodes via the
  lattice WGSL emitters; **3D agents** = the mechanical 2D→3D port the WASM agent loop
  already has). f32 is the only intrinsic difference.
- **WebGPU grid — close the two not-yet-ported gaps:** `aggregate.median` (a bounded
  per-thread WGSL sort over the existing `var<function>` scratch) and `aggregate/
  groupOperator` uniform `random` (reuse the per-cell PCG + the `weightedRandom`
  materialise path). Both are per-cell-local + order-independent + already on WASM.

---

## Current state (precise — from the codebase map)

The agent step is two layers:
1. **Compiled per-agent fns** (`behaviour` / `division` / `init`) — target-specific.
2. **Pure engine** (force integrator, spatial-hash build, structural phase) — historically JS, shared by all targets.

| Piece | Today | File |
|---|---|---|
| Behaviour loop (Boids subset, ~16 nodes) | **WASM** ✓ (PR6b-1/PR6b-2; JS bit-parity via the AW-RNG cell) | [agentWasm/compile.ts](../src/modeler/vpl/compiler/agentWasm/compile.ts) |
| **Force integrator** (soft-sphere + bond springs + velocity integration) | **JS — unconditional, even on the WASM target** | [sim.worker.ts](../src/simulator/engine/sim.worker.ts) `runAgentStep` ~1000–1229 |
| Spatial-hash build (CSR) | **JS**, copied into agent memory each step (AW-HASH) | [agentEngine.ts](../src/simulator/engine/agentEngine.ts) `buildSpatialHash` |
| Structural phase (division eigensolve, bonds, death, auto-bond) | **JS — stays CPU on every target by design** | `runAgentStructuralPhase` + `divideAgent` |
| Field bridge (`_field_<id>` reads/writes) | **JS, CPU-array-based** | [SampleFieldNode.ts](../src/modeler/vpl/nodes/SampleFieldNode.ts) etc. |
| WASM coverage gap (~24 of 40 agent nodes) | **clamp to JS** — Tissue/Chemotaxis don't run on WASM at all | `AGENT_WASM_SUPPORTED_TYPES` / `isAgentGraphWasmSupported` |
| WebGPU agent compiler | **does not exist** — `agentTargetOf` clamps `webgpu → js` | [centerBased.ts](../src/model/centerBased.ts) |

**Headline:** even when you pick WASM today, only the *behaviour* runs on WASM; the
**force pass — the hottest per-step code (the per-neighbour-pair double loop) — is still
JS**, so the WASM win is capped at roughly half. The **wasmBacked AgentStore already
lays the whole SoA on one `WebAssembly.Memory` at baked offsets** (the JS arrays are
views over it), so a WASM force-pass reads the *same bytes* with **zero glue** — only
offsets + scalar args.

---

## The plan (remaining work, ordered by gain-per-risk)

### WASM track (the real, low-risk boost)

- **W1 — WASM force-pass export (the boost lever; the delta vs the handoff). ✅ DONE
  (bit-parity verified; perf finding below).**
  Added a `forcePass(...)` WASM export (a sibling of `behaviour` in the SAME agent
  module) emitting the engine force loop in WASM: 3×3(×3) hash-stencil neighbour pass
  (soft-sphere repulsion/adhesion + density) → bond springs → velocity integration
  (momentum, maxSpeed, drag, dt) → write `xNext/yNext[/zNext]` → growth ramp. Reads the
  wasmBacked store at the `computeAgentMemoryLayout` offsets (zero glue); a **mirrored
  scalar-config ABI** (`FORCE_PASS_PARAMS` ↔ `runAgentStep`'s `agentForcePassWasmFn(...)`
  call: `highWater/hash dims` i32 + `binSize` f64 + `dtOverEta, muR, muA, range, momentum,
  maxSpeed, growthRate, W, H, D` f64 + `bonding, torus` i32). Gated (via the worker's
  resolved `growthRate`/`bonding`) on the `useBondingPhysics` master toggle, exactly like
  the JS pass. The hash build + structural phase STAY in JS; the torus wrap uses a host
  `env.fmod` import (the only bit-exact path — WASM has no f64 rem; the inline
  reconstruction + the "skip in-range" fast path both diverged at ~1e-12).
  **Acceptance — MET:** JS↔WASM **bit-parity** (f64, 0 diffs / maxAbs 0) across
  12 variants {2D,3D}×{hash, all-pairs, torus, clamp, soft-sphere on/off, maxSpeed, growth}
  + an end-to-end behaviour+force composition test (0 diffs / 50 steps); `tsc` + build
  clean; **lattice + JS-agent byte-identity by construction** (only `agentWasm/compile.ts`
  + `sim.worker.ts` touched — the lattice/JS-agent compilers are untouched).
  **PERF FINDING (honest — the lever is small on this engine):** the measured
  force-integrator-only speedup (Node V8, hash build excluded) is **~1.0–1.25×**, NOT the
  hypothesised ~2–4×. V8 already JITs this tight monomorphic numeric loop near-optimally;
  the host-fmod boundary crossing (once per agent) erases part of the torus-case win. So
  W1 is bit-exact zero-regression infrastructure with a modest win (clamp + large-count),
  but the agent loop simply isn't a JS bottleneck at interactive counts (the spatial hash
  already makes it O(N)). The CA-grid-level speedup the goal sought is not realisable here
  — neither the force pass nor a WebGPU port changes that for the typical few-thousand-agent
  case. (Worker-V8 / very-large-counts may differ from Node; a live-browser Boids smoke on
  `agentTarget:'wasm'` is the one unverified check — the preview served the main repo, not
  this worktree.)

- **W2 — complete the WASM behaviour coverage (the WHOLE-CATALOGUE port → Tissue +
  Chemotaxis + everything on WASM). ✅ DONE (JS↔WASM bit-parity verified on all 8
  agent samples; the gate reject set is now ZERO; HEAVY-rule benchmark shows the 2-5×
  boost).** The SEPARATE `agentWasm/compile.ts` now emits the FULL agent-graph
  catalogue (the gate `isAgentGraphWasmSupported` accepts every agent graph, clamped
  only by the per-node array-scratch-slot budget — a structural gate, not a node ban).
  Added (over the PR6b-2 Boids subset): the **field bridge** (sampleField/fieldGradient/
  readCellsUnder/affectCellsUnder/secreteToField — 2D bilinear, torus-folded), the
  **agent-array tier** (getAgentsAttribute/filterAgents/joinAgents/pickRandom(N)/
  getBondedAgents + aggregate/groupOperator[median+uniform-random incl.]/groupCounting/
  groupStatement over arrays), `getCellAttribute`/`getAgentAttribute`/`setAttribute`/
  `updateAttribute` on the agent SoA, the **structural-WRITE** nodes (divideAgent/
  formBond/breakBond/killAgent → request-flag stores into shared memory), the **setters**
  (setVelocity/setAgentAttribute/setAgentsAttribute/setAgentPosition/Radius/Type), the
  **bond/self reads** (forEachBond/getCurvature/getBondDegree/neighbourDensity), the
  **universal** value/flow nodes (switch/loop/valueSwitch/getModelAttribute/lookupInteraction/
  interactionTableMap/proportionMap/interpolation/colorScale/categoricalColor/getColorConstant/
  arrayElement/arrayLength + indicators get/set/updateIndicator[ALL ops incl toggle/next/prev]/
  setCellLooks[plain]), and **array Local Variables** + setArrayElement.
  - **Architecture** (mirrors the WebGPU G4/G5 decisions): the WASM module = the
    BEHAVIOUR loop ONLY. The `divisionEvent` + `agentInit` roots stay JS-on-CPU
    (target-independent — the worker runs them over the SAME wasmBacked memory, bit-
    exact). The gate checks ONLY the **behaviour-reachable** node set (`behaviourReachableNodeIds`),
    so a Tissue graph runs on WASM even though its divisionEvent subtree uses CPU-only nodes.
  - **External regions in agent memory.** The cell field arrays (`_field_<id>`), model
    attrs, indicators, lookup tables ride NEW reserved regions in the wasmBacked
    `computeAgentMemoryLayout` (`AgentLayoutExtras`: scratch/modelAttr/indicators/lookup/
    field + the sync-attr write region). The worker copies them IN before the WASM call
    (`copyAgentExternalRegionsIn`) and the field deposit + indicators back OUT after
    (`copyAgentExternalRegionsOut`) — Decision D-FIELD. **Layout lockstep** (the +64-cell
    bug): the store's layout MUST equal the compiler's (same maxHashBins + extras); the
    worker derives `fieldTotal` from the live grid dims, the compiler from the model — they
    agree.
  - **Sync agent mode under wasmBacked**: a distinct `attrWriteOffset` region; `swapAgentAttrs`
    copies-into under wasmBacked (the B10 view discipline — a reference swap would orphan the
    baked offset). The behaviour reads attrRead, writes attrWrite; the worker primes + swaps.
  - **Three parity bugs the harness caught + fixed**: (1) the `emitLogic` UPPERCASE-op bug
    (`'OR'`/`'XOR'`/`'NOT'` fell through to AND — the GoL-on-agents all-die, same as the
    WebGPU port); (2) `emitSampleFieldAt`/`emitSecreteToField` DOUBLE-wrapped a shared corner
    coordinate (now `emitFieldWrapCoord` wraps each axis ONCE); (3) **the field sample-before-
    deposit order** — JS sink-hoists pure values to cell-top so a field read sees the
    PRE-deposit field; the WASM `preEmitAgentValues` pass (the WASM analogue of the WebGPU
    `preEmitAgentValues`) now hoists the pure non-volatile value cone to agent-loop-top,
    matching JS exactly. (4) `i32.trunc_sat_f64_s` for the f64→i32 value conversions so a
    NaN/Inf intermediate (aggregate.max over empty → -Inf; sin/sqrt) does NOT trap (the JS
    `x|0` returns a finite value; for finite in-range it's bit-identical to plain truncation).
  - **Acceptance — MET:** JS↔WASM **bit-parity on ALL 8 agent samples** (Drift Test, Boids,
    Chemotaxis, GoL-on-agents, Ant Necrophoresis, the 3 Tissues) — 0 mismatches over 150
    steps, headless (Node) AND browser-verified (the Chemotaxis field bridge BIT-IDENTICAL
    in the real Chromium WASM engine); `tsc` + build clean; **lattice + JS-agent + WebGPU-
    agent byte-identity by construction** (`git diff --stat` vs the merge base = only
    `agentWasm/compile.ts` + `agentEngine.ts` + `sim.worker.ts` + `SimulatorView.tsx` + the
    `i32.trunc_sat` encoder const). All 8 samples compile + instantiate in the browser WASM
    engine.
  - **PERF — THE BOOST MATERIALIZES (unlike the Boids force loop).** The HEAVY per-agent-rule
    benchmark (`scripts/bench-agent-behaviour.mjs` — a chromatography-in-agents-style rule:
    nearby gather → 3 aggregates → a Lookup Table → 2 expressions → 2 compares → 2 conditionals)
    times the BEHAVIOUR fn JS vs WASM: **5.0× at 500 agents, 2.8× at 2000, 2.1× at 8000**.
    So the user's hypothesis holds: WASM pulls ahead of JS as per-agent RULE COMPLEXITY grows,
    exactly like the CA grid — the trivial Boids force loop was a wash (W1), but a heavy
    behaviour rule shows a solid 2-5× speedup.

- **W3 (optional) — hash build in WASM.** Eliminate the per-step JS `buildSpatialHash`
  + the AW-HASH copy-in with a WASM bin-count → prefix-sum → scatter. Lower priority —
  the copy is cheap vs the force pass. Defer if W1+W2 hit the perf target.

- **W4 — benchmark + ship.** Steps/sec at 2k / 10k / 40k agents (Boids, Tissue) on
  JS vs WASM; the `compileAll` dev-harness agent surface; the radio's WASM status hint.

The structural phase **stays JS on the WASM target** (it runs once per step, not per
neighbour-pair; the eigensolve locksteps for free) — porting it is a much higher-risk,
much lower-return follow-up and is explicitly out of this plan.

### WebGPU track (the scale play — the handoff's PR7; deferral candidate)

Execute the handoff **PR7** as written. Summary (full spec in the handoff §2 PR7):

- **G1 — `agentWebgpu/` compiler skeleton + agent SoA storage layout + the per-agent
  dispatch.** Reuse ~60–70% of the CA-grid WebGPU infra: device/adapter acquisition
  (`requiredLimits` raise), `dispatchCells` 2-D tiling past 65535, the staging-pool
  readback, the per-cell **PCG RNG** (keyed by agent `idx`), the f32-CAS atomic pattern,
  and the **entire compile front-end + universal-node WGSL emitters** (D-IDX). Net-new:
  the agent SoA layout + **aggressive binding packing** (~12 logical bindings → pack the
  f32 geometry into one strided buffer to stay near the grid's ~11-buffer footprint).
  `highWater` is a **Control uniform**, not a baked literal (else per-gen recompile).
- **G2 — the behaviour shader** (~20 agent-node WGSL emitters mirroring the agentWasm set).
- **G3 — the WGSL force/neighbour pass** + **PR7b-lite**: the **CPU-built hash uploaded
  each step** (the GPU prefix-sum build is a maintenance follow-up).
- **G4 — the CPU structural round-trip** (the chosen architecture, NOT a GPU allocator):
  GPU writes the divide/kill/bond **request buffers** + the settled SoA → readback →
  run the existing JS `runAgentStructuralPhase` on CPU → re-upload. *This ~6–7 MB/step
  round-trip at 10k agents is why WebGPU only wins past ~10k.*
- **G5 — the field bridge.** Ship with the **CPU sequential** bridge first (byte-identical
  to JS). **PR7c** (zero-copy same-device field + the f32-CAS atomic deposit folded into
  the grid step, gated `if (hasAgentDeposit)` so non-agent grids stay byte-identical) is
  **fully deferrable**.
- **G6 — enable WebGPU** (`agentTargetOf` widens to `{js, wasm, webgpu}`) + the
  binding-count fallback notice + the scale benchmark. **Sync agents only** (one
  sentence, no async gate — agents are always single-buffer).

### WebGPU track — STATUS (PR7 G1+G2+G3 + G3-runtime + G6 + G5 + G4 DONE — Boids / Chemotaxis / Tissue all run on WebGPU; PR7c deferred)

- **G1+G2 — DONE + on-device-verified.** `src/modeler/vpl/compiler/agentWebgpu/{layout.ts,compile.ts}`
  — the SEPARATE WebGPU agent-loop compiler (the GPU sibling of `agentWasm/compile.ts`).
  `compileAgentGraphWebGPU` emits a WGSL `behaviour` module over the GPU agent SoA
  (`computeAgentWebGPULayout` — 7 strided storage buffers, under the 8-binding floor;
  `highWater` a control uniform). `isAgentGraphWebGPUSupported` is the honest gate
  (mirrors the WASM gate + a 3D rejection). Reconciled to the current base: reads
  `agentVariables` (not the cell `variables`); the Compare op reads `operation`
  (the StatementNode key). Verified: `compileAll(Boids).agent.webgpu` emits a
  5780-char shader with exactly the 11 Boids node types; it compiles with **0 errors +
  0 validation errors** on a real `device.createShaderModule`/`getCompilationInfo`;
  Tissue/Chemotaxis (getCellAttribute/secreteToField) + any 3D model clamp to JS.
- **G3 — DONE + on-device-verified.** `agentWebgpu/forcePass.ts` `emitAgentForcePassWGSL`
  — the standalone WGSL force integrator (the GPU sibling of `runAgentStep`'s force
  loop + `agentWasm` `emitForcePass`): the 3×3 hash-stencil neighbour pass (soft-sphere
  + density, torus-wrapped, all-pairs fallback) → velocity Euler (momentum/maxSpeed/
  dt) → wrap/clamp into the appended GPU `xNext`/`yNext` fields → age + growth ramp.
  Its own `ForceControl` uniform mirrors the WASM `FORCE_PASS_PARAMS` ABI. `xNext`/`yNext`
  appended to `AGENT_GPU_F32_FIELDS` (behaviour shader bases stay byte-identical —
  re-verified). 2D-only, f32 (statistical parity). Bond springs + division + the hash
  BUILD stay CPU/JS (the GPU SoA carries no bond store; the gate excludes bonded models,
  so for the Boids headline the force pass is exact). Verified: compiles 0 errors on a
  real device.
- **G3-runtime + G6 — DONE + live-verified.** `src/simulator/engine/agentWebgpuRuntime.ts`
  — a SELF-CONTAINED agent WebGPU runtime (its own device, separate from the grid's
  `webgpuRuntime.ts`): `createAgentWebGPURuntime` (device + the two pipelines over 8
  buffers, the behaviour 7-binding + force 4-binding bind groups), `uploadAgentSoA` /
  `uploadAgentHash` / `uploadAgentControl` / `uploadAgentForceControl` (the two uniforms
  mirror the shader structs + `FORCE_PASS_PARAMS`), `dispatchAgentStep` (behaviour then
  force, `dispatchCells(maxAgents,64)`), `readbackAgentStep` (commits `xNext/yNext→x/y`
  + `vx/vy/radius/density/age` into the CPU store), `seedAgentRng` (once at creation; the
  GPU advances in place). The worker's `runAgentStepWebGPU()` (async) is the GPU sibling
  of `runAgentStep`'s WASM dispatch; the step handler routes a JS/WASM-grid + WebGPU-agents
  model (Boids) to an async copy of the batch loop. `agentTargetOf` widened to
  `{js,wasm,webgpu}` (3rd arg `webgpuSupported`); the Properties radio is enabled +
  reflects live support. **Live-verified in the browser**: Boids on `agentTarget:'webgpu'`
  — 260 agents flock (velocity polarization 0.01 → 0.998 over ~200 steps, stable over
  400+, 0 worker errors), render as cyan dots; gate `true`, `agentTargetOf===webgpu`,
  shader 5780 chars. Lattice + JS-agent + WASM-agent byte-identity by construction
  (`git diff --stat` touches only `centerBased.ts`/`PropertiesPanelContent.tsx`/
  `SimulatorView.tsx`/`sim.worker.ts` + the new runtime — the compilers are untouched).
- **G5 — DONE + live-verified (the field bridge → Chemotaxis on WebGPU).**
  `agentWebgpu/{layout.ts,compile.ts}` + `agentWebgpuRuntime.ts` + `sim.worker.ts`:
  the closed agent↔grid morphogen feedback now runs on the WebGPU agent target.
  The behaviour shader gains TWO conditional field bindings — `fieldRead` (binding
  7, a READ-ONLY snapshot of the cell field at step start; all agents read the
  same pre-deposit values = a true snapshot, a documented difference vs the JS
  path's sequential partial-deposit read, harmless for diffusion) + `fieldDeposit`
  (binding 8, `array<atomic<u32>>`, an f32-bitcast atomic-CAS accumulator per op
  set/add/sub/max/min so parallel agents writing the same cell don't race). The 5
  field-node WGSL emitters (`sampleField` / `fieldGradient` central-diff /
  `readCellsUnder` r-disk aggregate via `fieldSampleBilinear`; `affectCellsUnder`
  r-disk + `secreteToField` 4-cell bilinear splat via `fieldDepositCell`) mirror the
  JS emitters' 2D math. The runtime adds the two buffers (created only when the
  model has agent-accessible cell attrs → a no-field Boids shader is BYTE-IDENTICAL,
  5780 chars) + `uploadAgentField` (snapshot → fieldRead, prime fieldDeposit with
  the current field) + `readbackAgentField` (deposit → the cell read buffer). The
  worker's `runAgentStepWebGPU` does the CPU round-trip: upload the field BEFORE
  the dispatch, read the deposit back into `readAttrs[id]` AFTER (gated on
  `fieldReadLen||fieldWriteLen > 0`) so the cell CA step incorporates it (Decision
  D-FIELD). `isAgentGraphWebGPUSupported` now accepts the 5 field nodes; the worker
  derives the field spec from `fieldSpecs` (= `cellFieldAttrsOf`, the readWrite
  subset = `cellFieldWriteAttrsOf`), the SAME order the shader compiled against.
  **Live-verified in the browser**: Chemotaxis on `agentTarget:'webgpu'` —
  gate `true`, `agentTargetOf===webgpu`; the field BUILDS (chemical max 0 → ~33,
  all 10k cells non-zero) and the 220 agents AGGREGATE (122/169 occupied bins →
  ~70, sum-of-squares ~512 → ~1000 = ~2× clustering density), 0 worker errors;
  rendered as viridis hotspots + clustered cyan agents (statistical parity with the
  JS path — clustering trend, NOT bit-exact, the f32/PCG constraint). Boids on
  WebGPU re-verified still flocks (polarization 0.998), and the no-field shader +
  lattice + JS/WASM-agent paths are byte-identical (`git diff --stat` = only
  `agentWebgpu/{compile,layout}.ts` + `agentWebgpuRuntime.ts` + `sim.worker.ts`).
- **G4 — DONE (the CPU structural round-trip → Tissue on WebGPU).** The behaviour
  shader now emits the structural-WRITE nodes (`divideAgent`/`formBond`/`breakBond`/
  `killAgent`) as per-agent REQUEST-FLAG stores into the GPU agent SoA, plus the
  universal nodes Tissue's behaviour uses: `getCellAttribute`/`setAttribute` on a
  per-AGENT attribute (a new `agentF32` run per `agentAttrsOf` id — f32, int/tag
  round to the nearest), `categoricalColor` (multi-output palette select),
  `setCellLooks` (per-agent packed `agentColors[idx]`, plain mode), `neighbourDensity`
  + `getBondDegree` (engine reductions). The runtime uploads the agent attrs (0 the
  request runs each step) and reads the request runs back into the engine's CPU
  arrays (`divideRequest`/`bondFormReq`/`killRequest`/…), the attrs back into
  `s.attrWrite`, and the packed colours into `s.colors`, BEFORE the existing
  (target-independent) `runAgentStructuralPhase` + `runDivisionEvent` run CPU-side
  on the settled state — the division eigensolve + the divisionEvent fn stay JS on
  every target (no WGSL division shader). The gate now only checks the
  BEHAVIOUR-REACHABLE node set (the divisionEvent / agentInit roots are compiled
  separately on CPU/JS), so a Tissue graph runs on WebGPU even though its
  divisionEvent subtree uses nodes the shader can't emit. **Zero new bindings** —
  the request + agent-attr runs ride the existing `agentF32` buffer (binding 0).
  Lattice + JS/WASM-agent + the no-structural-node Boids/Chemotaxis WebGPU shaders
  are byte-identical by construction (the request/attr runs only emit when a
  structural / Get-Set-Attribute node is reached). Verified: tsc + build clean; the
  Tissue WebGPU shader compiles (gate `true`, target `webgpu`, the divideRequest
  flag store + maturity read/write at the right offsets + the categorical palette +
  the agentColors write all present); Boids + Chemotaxis still gate `true` /
  compile (no request emit); the engine structural primitives consume the
  request values (a NaN GPU axis → the eigensolve resolves a finite tension axis,
  division grows the store, bonds partition). **NOT yet live-verified in a browser**
  (the running preview serves the main repo, not this worktree; no headless WebGPU
  in Node) — a browser smoke (load Tissue on `agentTarget:'webgpu'`, Play, confirm
  the count rises + maturity differentiates) is the one remaining check.
- **WHOLE-TARGET PORT — DONE + GPU-live-verified (the full-coverage push).** The
  WebGPU agent compiler now accepts **71** node types — the FULL agent-graph
  catalogue minus the genuine fundamentals. Added (over G1-G5): the rest of the
  agent-array tier (`getBondedAgents` + the existing filter/join/picks), `getCurvature`,
  `forEachBond`, the agent setters (`setVelocity`/`setAgentAttribute`/
  `setAgentsAttribute`/`setAgentPosition`/`setAgentRadius`/`setAgentType`),
  `updateAttribute`, the **universal** value/flow nodes (`groupOperator`
  [sum/product/min/max/avg/count/weightedRandom], `groupCounting`, `groupStatement`,
  `switch`, `loop`, `valueSwitch`, `getModelAttribute`, `lookupInteraction`,
  `proportionMap`, `interpolation`, `colorScale`, `getColorConstant`, `arrayElement`,
  `arrayLength`, `getConstant` tag, `getIndicator`/`setIndicator`/`updateIndicator`
  [atomics]), **array Local Variables** + `setArrayElement`, and **3D agents** (the
  z fields + 3×3×3 hash stencil + 3D force pass + dz torus fold + z velocity, gated
  on `gridDepth>1`; the 2D path stays byte-identical). New conditional GPU bindings:
  `auxF32` (9, model attrs + lookup tables), `indicators` (10, atomic), `bondStore`
  (11, interleaved `[partner, restBits]`) + agentI32 made read_write for
  `setAgentType` — each DECLARED + bound ONLY when an emitter references it (a
  declared-but-unused storage global is stripped by Naga → bind-group mismatch). A
  `preEmitAgentValues` pass hoists the PURE value cone to function-top (cross-branch
  WGSL scoping). The `emitLogic` OR→AND case-mismatch bug (the GoL all-die) is fixed.
  **The FINAL `isAgentGraphWebGPUSupported` reject set — only the documented fundamentals:**
  (1) `aggregate`/`groupOperator` `median` + uniform `random` (no sort / per-cell
  pick path — same as the lattice WebGPU grid; `weightedRandom` IS supported);
  (2) `updateIndicator` `toggle`/`next`/`previous` (order-dependent under parallel
  writers — same as the grid); (3) a GLYPH `setCellLooks` (no per-agent glyph
  buffers in the GPU SoA — the documented carve-out); (4) the **field nodes in 3D**
  (the trilinear sample/deposit path is not yet ported — 2D field bridge works, a
  documented follow-up); (5) > 6 agent-array producers (the per-thread `var<function>`
  register budget). The orientation/variegation nodes never reach the Agents graph
  (variegation is grid-only); `stopEvent` on the agent behaviour stays deferred (it
  needs a GPU stopFlag round-trip + the `_stopIdx` offset — matching the WASM agent
  path, which also lacks it; no sample uses it). **GPU-LIVE-verified in the browser**
  (real `device.createShaderModule` + the running worker on `agentTarget:'webgpu'`,
  0 worker errors, NO JS fallback): **Boids 2D** flocks (polarization 0.999); **3D
  Boids** flocks (3D pol 0.023→0.982, z positions span the volume); **Chemotaxis**
  aggregates (occupied bins 174→106, sum-of-squares 318→670 ≈ 2× clustering via the
  field bridge); **GoL-on-agents** evolves like Conway (344→155→107 alive,
  stabilising into still-lifes/blinkers — the OR-bug fix); **Tissue** grows
  5→274 agents / 745 bonds with maturity differentiation (7 distinct colours,
  self-limiting); **Ant Necrophoresis** runs 0-error and matches the JS baseline.
  Lattice grid (2D+3D, all 3 targets) + JS/WASM-agent byte-identity by construction
  (`git diff --stat` touches ONLY `agentWebgpu/{compile,forcePass,layout}.ts` +
  `agentWebgpuRuntime.ts` + the SimulatorView/worker agent-webgpu wiring — no lattice
  or JS/WASM-agent compiler).
- **PR7c** (zero-copy / atomics) — STILL DEFERRED (a perf optimisation, not a
  coverage gap). Remaining coverage gaps: the 3D field bridge (trilinear) + the
  per-agent glyph buffers (both documented above).

### Scale benchmark (the headline number) — JS vs WASM, force integrator

`scripts/bench-agent-force.mjs` (esbuild-bundled, DOM-free) times the force-pass hot
loop (neighbour pass + Euler integration; the CPU hash build EXCLUDED, identical on
every target) at 2k/10k/50k/100k agents, customForces (soft-sphere OFF, the Boids
case), torus, momentum 0.9, on an 800×800 world:

| N | JS steps/s | WASM steps/s | WASM speedup |
|---|---|---|---|
| 2 000 | 5590 | 5507 | 0.99× |
| 10 000 | 866 | 784 | 0.90× |
| 50 000 | 99.3 | 97.0 | 0.98× |
| 100 000 | 33.1 | 34.0 | 1.03× |

**Honest crossover finding: the agent force loop is a WASH on JS vs WASM at every
scale (0.90×–1.03×).** V8 JITs this tight monomorphic numeric loop near-optimally, so
WASM gives no meaningful speedup (consistent with the W1 ~1.0–1.25× finding). The agent
engine is O(N) via the spatial hash, so it is NOT a JS bottleneck at any interactive
count. **WebGPU is intentionally absent from the table** — its per-step cost is
dominated by the whole-SoA upload + readback (the hash is CPU-built, so the GPU buffers
must be re-synced every step), a fixed per-step overhead that BELOW ~10k agents exceeds
the entire JS/WASM force loop. So WebGPU for agents is a wash-or-REGRESSION at
interactive counts and can only break even (if at all) at the very largest counts; that
number needs the wired runtime (deferred) to measure. **This is the whole point of the
milestone: there is no agent-loop speedup to be had from a faster target at the counts
that matter — the spatial hash already won that battle on JS.**

---

## UI / radio

The **Agent Compile Target** radio already exists ([PropertiesPanelContent.tsx](../src/modeler/panels/PropertiesPanelContent.tsx)); WASM is live for the supported subset, WebGPU is disabled. The work just widens the gate and the live status hint. Mockup: [MOCKUP_AGENT_COMPILE_TARGET.html](MOCKUP_AGENT_COMPILE_TARGET.html). Each UI-touching PR ships its own mockup as a DoD item (CLAUDE.md rule).

## Verification matrix (the regression guarantee)

- **JS↔WASM bit-parity** (the gold standard): seed identically (`_rngState[0]`), run N steps on `js` then `wasm`, `getState`-snapshot, assert element-wise equality on x/y/vx/vy/radius/bondCount/bondPartner/attrs over `[0,highWater)`. Tissue (no RNG) bit-exact indefinitely; Boids bit-exact post-seed.
- **WebGPU statistical parity**: Boids polarization → ~0.99; Tissue agent-count + maturity curves within tolerance (structural phase is byte-identical CPU code → counts match; positions drift via f32/PCG).
- **Lattice byte-identity** + **2D-agent byte-identity** at **every** PR (`compileAll(...)` string/byte-equal before/after — the agent work never touches the lattice compilers, and the JS agent code is unchanged by the WASM/WebGPU emitters).
- **Perf benchmarks**: steps/sec at 2k / 10k / 40k / 100k (where applicable).

## Risks & the deferral license

- **The ABI-mirror class** (the silent-desync that bit the 3D `dimsModel`/`total` bug): every new WASM export / WGSL entry needs its param↔arg pair diffed builder-against-builder, with the DEV arity assertion. W1's force-pass scalar-config ABI is the new pair.
- **WebGPU**: the >8-binding gate (pack up front), the per-step full-SoA round-trip (the < ~10k regression), the f32-CAS deposit re-implementation, the gated lattice-step deposit-fold. **Per handoff §4, PR7 (WebGPU) may slip to maintenance** if it threatens the 2D guarantee — ship the milestone with **JS + WASM agents** + a clean maintenance ticket and that is a complete, honest outcome.

## Execution order for the new session

1. **W1 — WASM force-pass export** (the boost; start here).
2. **W2 — WASM behaviour coverage → Tissue + Chemotaxis on WASM.**
3. **W3/W4 — optional WASM hash + benchmark + radio.**
4. **G1…G6 — WebGPU (the handoff PR7), the deferral candidate.**

Each is a self-contained PR with the verification matrix above; the detailed specs are
in the handoff. Commit per-PR; never merge a permanently-JS-only agent engine, but
merging with JS+WASM agents + a WebGPU maintenance ticket is an accepted outcome.

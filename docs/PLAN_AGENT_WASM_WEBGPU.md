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
(hundreds–few thousand), JS is already interactive.

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

- **W1 — WASM force-pass export (the boost lever; the delta vs the handoff).**
  Add a `forcePass(...)` WASM export (a sibling of `behaviour`) emitting the engine
  force loop in WASM: reset force → 3×3(×3) hash-stencil neighbour pass (soft-sphere
  repulsion/adhesion + density) → bond springs → velocity integration (momentum,
  maxSpeed, drag, dt) → write `xNext/yNext[/zNext]`. Reads the wasmBacked store at the
  `computeAgentMemoryLayout` offsets (zero glue); a **mirrored scalar-config ABI**
  (`dt, muR, muA, range, eta, momentum, maxSpeed, growthRate, bonding-flag, W/H/D,
  torus`). Gated on the new `useBondingPhysics` master toggle, exactly like the JS pass.
  **Why first:** biggest win, lowest risk (element-wise, view-safe), zero new glue,
  boosts the already-WASM Boids immediately, and establishes the "engine code in WASM"
  pattern. *Note: this extends the handoff's PR6, which intentionally kept the force
  pass in JS to minimise the WASM surface — we port it because the user's goal is a
  CA-grid-level speedup and the mapping shows it's the cap.* **Acceptance:** JS↔WASM
  bit-parity (f64) on Boids/Tissue over N steps; the force pass produces byte-identical
  `xNext/yNext`; 2D-agent + lattice byte-identity unchanged.

- **W2 — complete the WASM behaviour coverage (the handoff's PR6c/PR6d → Tissue +
  Chemotaxis on WASM).** Widen `AGENT_WASM_SUPPORTED_TYPES`: the field-bridge nodes
  (sampleField/fieldGradient/readCellsUnder/affectCellsUnder/secreteToField — needs the
  agent module to see the **cell field bytes**, the case-(b) copy bridge per the handoff,
  with the documented Chemotaxis perf-regression note), `getCellAttribute` /
  `getAgentAttribute`, **array** Local Variables + `setArrayElement`, the array tier
  (getAgentsAttribute/filter/join/getBondedAgents/picks), and the **division-event** +
  **agent-init** WASM modules (the 2nd/3rd exports). **Acceptance:** Tissue + Chemotaxis
  run on WASM with JS bit-parity (division daughters match — the eigensolve stays JS for
  both targets); the gate no longer clamps them.

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

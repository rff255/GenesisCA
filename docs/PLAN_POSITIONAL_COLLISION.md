# Plan — Real Positional (Hard) Collision for Bond-Graph Agents

**Branch:** `absorb_old_automatosgt` · **Status:** planned → implementing
**Illustrated companion:** [PLAN_POSITIONAL_COLLISION.html](PLAN_POSITIONAL_COLLISION.html)

## Why

The `Collision` capability had two dropdown values — **Soft-sphere** and **Positional** — but they were never two behaviours: nothing ever implemented a hard/positional collision, so both ran the identical soft-sphere force (the honest-controls pass folded `positional`→`soft` and removed the phantom option). The user wants two *genuine* choices. This plan makes **Positional** a real, distinct collision: a rigid, no-overlap constraint, on all three targets (JS / WASM / WebGPU), 2D and 3D.

## The two collision models (genuinely different physics)

| | **Soft-sphere** (`soft`) | **Positional** (`positional`) — NEW |
|---|---|---|
| Kind | A penalty **force** `F = μ_R·(d − s)` added to the force accumulator | A **position constraint** applied after integration |
| Overlap | Transient overlap allowed; only asymptotically non-penetrating (stiffer = tighter) | **Zero overlap** — overlapping pairs are projected to exactly touching |
| Feel | Springy / bouncy (molecular-dynamics, center-based cells) | Rigid (billiard balls / position-based dynamics) |
| Needs Motion=Force | Yes (the force integrator applies it) | **No** — the projection edits positions directly, so it works under any Motion |
| Tuning | `Repulsion Stiffness` (μ_R), `Interaction Range` | `Positional Iterations` (more = tighter packing) |

`off` = neither. Adhesion (cohesion, `μ_A`) + bond springs + growth stay orthogonal (unchanged), so a positional gas is *hard collisions, no cohesion*.

## Algorithm — Jacobi position projection (PBD), parallel-safe for all 3 targets

Runs **after** the per-agent force integration writes the tentative `xNext/yNext[/zNext]`, and **before** `swapPositions` commits them. For `positionalIterations` sweeps:

1. **Accumulate** (per agent `i`, reading the *current* tentative positions of neighbours): for each neighbour `j` within contact (`d < s_ij = r_i + r_j`, `d > 0`), add a half-correction pushing `i` away from `j`:
   `corr_i += (0.5·(s_ij − d)) · (x_i − x_j)/d` (torus-shortest displacement).
2. **Apply** (per agent): `xNext_i += corr_i`, then re-wrap (torus) / clamp (bounded) to the world.

**Jacobi, not Gauss-Seidel** — each sweep reads the positions from the *start* of the sweep and applies all corrections at once, so it is **order-independent** → identical on serial (JS/WASM) and parallel (WebGPU) execution, and needed for GPU parity. A pair resolves exactly in one sweep; dense packing (many contacts per agent) converges over a few sweeps (hence the iteration knob). Equal split (half each) = equal-mass particles (there is no mass field).

**Buffer reuse (no new SoA field):** the correction accumulator reuses the per-agent **`forceX/forceY[/forceZ]`** buffers — they are dead after the force integration consumed them into velocity, and are reset to 0 at the top of the next step. Each sweep zeroes them before accumulate. So the SoA stays lean (nothing added — aligned with the capability-profiles milestone) and the field already rides every target's ABI.

## Integration points (IMPLEMENTED — the positional projection is a CPU post-step on ALL targets)

**Key architectural realisation:** the projection is a **CPU post-step constraint on the committed positions** — exactly like the agent **structural phase** (bonds / division / death), which CLAUDE.md already documents as *target-independent CPU/JS, run on the settled state after the force pass*. So there is ONE implementation, [`resolvePositionalCollisions`](../src/simulator/engine/agentEngine.ts) (in `agentEngine.ts` next to `buildSpatialHash`), called on every target — no separate WASM export, no GPU shader:

- **JS + WASM** ([sim.worker.ts](../src/simulator/engine/sim.worker.ts) `runAgentStep`): the call sits between `swapPositions` and the structural phase, on the committed `x/y[/z]`. The WASM agent target runs the SAME function over the wasmBacked store's typed-array VIEWS (WASM memory), so JS and WASM are **bit-identical** (verified: plain store ↔ wasmBacked, 0 mismatches). The soft-sphere **repulsion** gate changed from `usesEngineCollision` to **`usesSoftCollision`** (`collision==='soft'`), so a positional model runs the projection *instead of* soft repulsion (adhesion still under `usesBondingPhysics`). Inlined interaction (no closure) → V8-optimal; a native WASM port would be a wash (the W1 finding: V8 JITs a tight monomorphic numeric loop near-optimally).
- **WebGPU** ([sim.worker.ts](../src/simulator/engine/sim.worker.ts) `runAgentStepWebGPU`): the call sits after `readbackAgentStep` (which ALREADY commits the GPU positions to the CPU store each step) and before the CPU structural phase — so **no GPU shader and no extra readback**; the next step's `uploadAgentSoA` sends the non-overlapping positions back to the GPU. WebGPU's f32 force pass ⇒ the read-back positions are f32-precision, so this is **statistical parity** vs the f64 JS/WASM targets (the documented WebGPU-agent stance — and no worse than the structural phase, which is likewise CPU here). Verified on a real GPU: a positional gas resolves 1.577 → 2.0 (contact), 0 errors, `resolvedAgentTarget: 'webgpu'`.

*(This supersedes the earlier "WASM export + WebGPU shader pair" sketch below — the CPU-post-step design is simpler, has one source of truth, and matches the established structural-phase pattern.)*

## Schema + capability + UI

- `CenterBasedConfig.positionalIterations?: number` (default **2**, clamp ≥1; live-tunable — no reinit).
- [centerBased.ts](../src/model/centerBased.ts): `collisionMode(cfg)` → `'off'|'soft'|'positional'` (legacy fallback = `usesBondingPhysics ? 'soft' : 'off'`); `usesSoftCollision` = `collisionMode==='soft'`; `usesPositionalCollision` = `collisionMode==='positional'`. `usesEngineCollision` stays = "any collision on".
- `computeCapabilityClosure`: **remove** the `positional→soft` fold; positional needs **Body** (not Motion=Force — it edits positions directly). Soft still needs Body + Motion=Force.
- Dropdown restores three options: **Off / Soft-sphere / Positional**, with honest descriptions of the difference. A `Positional Iterations` numeric row appears when positional is selected.

## Byte-identity + parity

- **No shipped model uses `positional`** — the inference only ever produces `soft`/`off`. Gating soft-repulsion on `usesSoftCollision` (= true for `soft`, false for `off`) is identical to the old `usesEngineCollision` for every shipped/legacy model; the projection runs only for `positional` (which none infer). **Byte-identical** for all shipped + legacy files (re-verify with the byte-identity audit + parity-agent-wasm).
- **New verification:** `scripts/parity-agent-force.mjs` gains a **positional** combo (JS↔WASM bit-parity of the projection over an overlapping blob) + a behaviour assertion (positional drives min-pair-distance to ≈ the contact distance with **no residual overlap**, vs soft leaving transient overlap). WebGPU: real-device shader compile (0 errors, 2D+3D) + an end-to-end dispatch showing no overlap.
- Adversarial-review workflow over the finished 3-target implementation (ABI/ordering/parity), mirroring the collision-wiring review.

## Out of scope (v1)

- Mass-weighted correction (equal split only — no mass field).
- A per-pair relaxation/stiffness factor (iterations is the knob; dense packing = more iterations).
- Friction / restitution (this is a *separation* constraint, not a full contact solver).

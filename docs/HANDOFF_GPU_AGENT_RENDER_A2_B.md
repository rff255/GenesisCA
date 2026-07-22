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

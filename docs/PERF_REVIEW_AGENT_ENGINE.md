# Agent Engine Performance Review — 2026-07-22

Trigger: Particle Life (2D + 3D) "struggles before even 50k particles" while other
web particle-life apps run 50-100k+ fluidly, plus the arbitrary-looking
`[agents] spatial hash (400 bins) exceeds the WebGPU reserve (104)` error after a
resize to 600×600.

Everything below is **measured**, not guessed — via the new phase profiler
[scripts/bench-agent-engine.mjs](../scripts/bench-agent-engine.mjs) (Node, real
`Particle Life.gcaproj`, real compiled JS + instantiated WASM) and in-browser
worker/main-thread instrumentation on an NVIDIA Pascal machine. Rerun the
profiler after any engine change to see which phase moved.

---

## 1. Bugs found & FIXED in this pass

### 1a. Resize → agent-compiler dims desync (the user's error; corruption hazard)
`initWorkerWithDimensions` built its dims-overridden `dimsModel` for the GRID
compilers only; `compileAgentModel` compiled from the raw model. So after a
simulator Resize the agent WASM/WebGPU layouts baked the OLD dims:
- **WebGPU**: compiled hash reserve (Particle Life: ⌊320/24⌋×⌊200/24⌋ = 104 bins)
  < live hash (600×600 → 400+ bins) → the reported error + **permanent
  silent JS demotion** every step. The user's perceived perf at 600×600 included
  this — the GPU/WASM target they selected wasn't running.
- **WASM (worse)**: the worker builds the store layout from LIVE dims while the
  module baked MODEL-dims offsets — every region after the hash reserve
  (nearby-scratch, model attrs, **lookup tables**, fields) desyncs → silent
  wrong-offset reads (Particle Life would read its rules matrix from garbage).

**Fix**: `compileAgentModel(stopIdxBase, dimsModel?)` — both call sites (init +
soft recompile) pass the same dims-overridden model the grid compilers get; plus
a defence-in-depth **layout-lockstep signature** (`agentWasmLayoutSig` =
`{maxHashBins, totalBytes}`) shipped with the WASM bytes and asserted by the
worker before instantiating (mismatch → loud error + safe JS-on-views fallback).
Verified in-browser: WASM & WebGPU targets at 600×600 run 100+ gens with zero
errors, agents move, no NaN.

### 1b. WebGPU agent scratch arrays sized at maxAgents (occupancy collapse)
Every WGSL thread declared `var<function> array<i32, maxAgents>` per
array-producer slot. WGSL zero-initializes function-address-space vars, so at
maxAgents=50k every thread allocated + zeroed **200 KB of private memory per
dispatch** → measured 415 ms/gen on a Pascal. **Fix**: capped at
`min(maxAgents, AGENT_GPU_ARRAY_CAP = 2048)` (+ fill-guards in nearby/join).
Models with maxAgents ≤ 2048 emit byte-identical shaders. Measured: 415 → ~190
ms/gen at 50k. Semantics: a single query yielding > 2048 members truncates
(documented GPU capacity bound; JS/WASM keep all).

---

## 2. Where a generation actually goes (measured)

`node scripts/bench-agent-engine.mjs` — Particle Life 2D, per-step ms
(phases: hash build, behaviour fn, force pass, snapshot; reset/args/swap/hashCopy
all ≤ 0.05 ms and omitted):

| Scenario                        | hash | behaviour JS/WASM | force JS/WASM | total JS/WASM | steps/s |
|---------------------------------|------|-------------------|---------------|---------------|---------|
| 2k @ 267² (shipped density)     | 0.11 | 4.6 / 4.0         | 2.9 / 2.8     | 7.6 / 6.9     | 131/145 |
| 10k @ 596²                      | 0.43 | 25.5 / 21.1       | 16.7 / 16.6   | 42.7 / 38.2   | 23/26   |
| 50k @ 1333²                     | 2.2  | 176 / 157         | 121 / 113     | 299 / 272     | 3.3/3.7 |
| **50k @ 600² (the user's case)**| 2.2  | 671 / 598         | 449 / 394     | 1123 / 994    | 0.9/1.0 |

Per-frame (once per rendered frame, NOT per gen): snapshot 1.5 ms + structured
clone ≤ 3.9 ms at 50k (45 B/agent, ~2.15 MB, shipped via transferables).

In-browser confirmation (50k @ 600², WASM target): worker step ≈ 1030 ms/gen
(matches the harness), main-thread handler (snapshot consume + the batched-disc
draw of 50k agents) ≈ 25 ms/frame. WebGPU agent target on the same board:
~190 ms/gen after the scratch-cap fix (was ~415).

**Conclusions:**
1. **The per-pair physics is >99% of step time.** Hash, snapshot shipping,
   arg-building, swaps — all noise. The engine's overheads are NOT the problem;
   the pair count is: cost ∝ N × density × r². The user's 50k @ 600² has ~112
   in-radius neighbours per agent ⇒ ~5.6M heavy pair-bodies + ~36M candidate
   distance tests twice per step.
2. **The force pass costs ~70% as much as the behaviour — and for Particle Life
   it computes nothing.** Engine physics is OFF (`collision off`, no springs,
   no growth), yet the fused force pass unconditionally runs its full 3×3-bin
   neighbour scan just to count `density` — which no node in the model reads.
   Same bin edge as the behaviour's gather (max(cutoff, neighbourQueryRadius)),
   so it re-enumerates essentially the same candidate set the behaviour already
   paid for. This is the **single biggest cheap win**: skipping it would take
   50k @ 600² from ~1120 → ~680 ms/gen (~1.65×), and every custom-force model
   (Particle Life, Boids-class, GoL-on-agents) benefits on all three targets.
3. **WASM ≈ 1.1× JS on this workload** (memory-bound neighbour iteration; V8
   handles the monomorphic typed-array loop well). The compile target is not
   the lever here — the pair count and the executor (CPU vs GPU) are.
4. **WebGPU at 50k is ~5.4× WASM (190 vs 1030 ms) but far below what the GPU
   can do.** Live-varying N shows ~60% of the 190 ms is
   **maxAgents-proportional fixed overhead** (full-SoA JS pack + 4.2 MB upload +
   4.2 MB readback + commit loop + mapAsync sync, all over maxAgents=50016 every
   generation, even at 5k live agents). This is the measured, quantified case
   for the deferred PR7c (GPU residency).

## 3. Why other web particle-life apps are "super fast"

Sandbox-science-class apps keep the whole population **GPU-resident**: positions/
velocities live in GPU buffers across frames, the neighbour grid is built on the
GPU, nothing is read back per generation (the render samples the same buffers).
Their per-frame CPU cost is ~zero regardless of N. GenesisCA's WebGPU agent
target currently does upload → dispatch → **readback every generation** (the
CPU engine owns the state so brushes/inspector/bonds/division keep working) —
architecturally ~2 orders of magnitude more per-gen overhead at 50k. Closing
that gap is PR7c, not parameter tuning.

## 4. Prioritized recommendations

**P0 — correctness: RESOLVED (2026-07-22, the batch re-entrancy fix).**
- Root cause found via a state-roundtrip experiment (loadState the SAME agent
  state into both targets): a single GPU step matches a single JS step to
  1.4e-5 (pure f32) on every agent, one batch-of-5 is BITWISE identical to five
  singles, the GPU HOLDS a loaded 0.999-polarization flock indefinitely, and
  with STRICTLY SEQUENTIAL batches GPU Boids flocks 0.378→0.998 exactly like
  JS. **The GPU physics was correct all along.** The divergence appeared ONLY
  when multiple `step` messages were queued at once: the async WebGPU batch
  loops yield to onmessage at every await, so a queued `step` started a
  CONCURRENT batch interleaved with the running one — stale CPU uploads raced
  fresh GPU results → frozen/plateaued dynamics with zero errors. (The
  synchronous JS/WASM batch loop cannot be interleaved, which is why only the
  GPU paths broke — and why probe scripts that post several step messages at
  once were the reliable reproducer while the send-await-send Play loop mostly
  wasn't.) **Fix**: while an async step batch is in flight the worker defers
  EVERY incoming message and replays them in order when the batch settles
  (`asyncStepBatchInFlight` + `endAsyncStepBatch` in sim.worker.ts), restoring
  the synchronous path's semantics; plus permanent GPU diagnostics
  (`device.onuncapturederror`, `device.lost`, `pushErrorScope` around the
  dispatch). Verified: the previously-failing 10×40-overlapped-burst pattern
  now flocks 0.223→0.998 on the GPU target; the WebGPU-grid burst path
  serializes cleanly too. The WebGPU agent target is trustworthy again.

**P1 — the cheap 1.6×: skip the dead density scan.**
Compile-side flag (does any reachable node read `neighbourDensity`?) threaded to
the worker; when false AND soft-collision off AND springs off, the force pass
skips the neighbour scan entirely (JS branch, a WASM forcePass param like
`doCollision`, a GPU force-shader variant). All-target, small surface,
measured-large payoff for every custom-force model.

**P1 — WebGPU per-gen overhead:** iterate upload/readback/commit and the
dispatch bound over `highWater`, not `maxAgents` (measured ~60% of GPU step time
at 5k live/50k max). Then the real PR7c: persist the SoA on-GPU across
generations, read back once per FRAME (gens/frame batching), hash built on GPU
or uploaded only. Ceiling: 50k+ at 60 fps for Particle-Life-class models.

**P2 — render:** the batched-disc Canvas2D path costs ~25 ms/frame at 50k
(caps fps at ~40 even with free physics). The deferred point-splat fast path
(sub-2px discs → per-color ImageData/rect splats), or a WebGL point sprite
layer, is the fix for 10k+ populations.

**P2 — snapshot:** ship render-only fields, as Float32, and skip vx/vy unless
sprites orient-to-velocity / metaballs need them (45 → ~21 B/agent). Minor
today (~5 ms/frame at 50k), matters once physics is GPU-resident.

**P3 — Float64 SoA → Float32:** halves memory bandwidth in every loop, but
breaks the JS↔WASM f64 bit-parity contract — only worth considering as part of
a deliberate precision-policy decision. Not recommended now.

**User-facing guidance** (worth a note in Help): agent physics cost scales with
N × density × queryRadius² — growing the world with N (constant density) keeps
per-agent cost flat; cranking N in a fixed world is quadratic-feeling. And
`neighbourQueryRadius` (the config ceiling) sets the hash bin edge for BOTH
passes — keep it as small as the model's largest query actually needs.

## 5. Measurement tooling added

- **[scripts/bench-agent-engine.mjs](../scripts/bench-agent-engine.mjs)** — the
  per-phase profiler used above (real .gcaproj, JS + real WASM, wall-clock
  budgeted, `MODEL="Particle Life 3D"` env override).
- Browser recipes (documented here since the preview auto-pauses Play when the
  tab is hidden — drive the worker directly): hook `window.__simWorker`,
  `postMessage({type:'step',count:N})` round-trip timing = worker gen cost;
  wrapping `worker.onmessage` times the main-thread handler (snapshot + draw);
  `getAgentState` probes verify per-agent values; polarization
  (|Σv|/Σ|v| over the stepped snapshot) is the flocking-correctness metric.

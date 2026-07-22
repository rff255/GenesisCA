# SandboxScience Particle Life vs GenesisCA agents — gap analysis (2026-07-22)

Source studied: the user's local copy of `SandboxScience-master` (the code behind
sandbox-science.com) — `components/particle-life/ParticleLifeGpu.vue` +
`assets/particle-life-gpu/shaders/**`. Reference point: their DEFAULT 2D sim =
**64,000 particles, world = the canvas (1920×929 px), 7 types, per-pair maxR ∈
[32, 64] px, glow render, ~100 fps** (vsync-limited).

## How their pipeline works (verified in source)

1. **One `requestAnimationFrame` = one dt-scaled sim step + the render, in ONE
   command encoder / ONE queue submit.** `step()` encodes: binning → forces →
   advance → `renderParticles` — the render pass draws **directly from the same
   GPU particle buffer** (instanced quads, `draw(4, NUM_PARTICLES)`, vertex
   pulling from the storage buffer) into an HDR target, then glow/compose. The
   canvas is a WebGPU canvas. **The CPU never touches particle data** — zero
   readbacks in the steady state (`readBufferFromGPU` exists only for
   export / population-resize paths).
2. **Counting sort every step, not an index table.** `binFillSize` (atomic
   counts) → `binPrefixSum` → `particleSort` **scatters the PARTICLES
   THEMSELVES into bin order** (ping-pong source/destination buffers). The
   force kernel then iterates each neighbour bin as a **contiguous run**
   (`binOffset[i]..binOffset[i+1]` over the sorted array) — fully coalesced
   memory reads.
3. **AoS 20-byte particles** (`x, y, vx, vy, type` as f32) — one fetch pulls
   the whole neighbour. The interaction matrix is **packed one u32 per pair**
   (rule 8-bit, minR 8-bit, maxR 16-bit) — one word read per pair.
4. **Continuous time**: dt = smoothed wall-clock delta, friction as a
   precomputed `pow(1-f, dt·60)`. So "100 fps" literally means ~100 sim
   steps/s, each under the ~10 ms vsync budget.
5. It is a **single hard-coded sim**: no rule graph, no cell grid, no bonds /
   division / fields, no inspector-grade CPU state. The whole app IS this
   kernel plus UI.

## The arithmetic of their default

Density 64k / 1.78M px² ≈ 0.036 particles/px²; mean pair radius ≈ 48 px ⇒
**~260 in-radius neighbours per particle** ⇒ ~16.6M pair evaluations per step ⇒
at 100 fps **≈ 1.7 G pair-force evaluations/s**. That is what a discrete GPU
delivers when the reads are sorted/coalesced and the kernel is minimal.

GenesisCA's resident path (post-PR7c), 50k @ 600² with queryRadius 16 ⇒ ~112
neighbours ⇒ ~5.6M pairs/gen at ~50 gens/s ≈ **0.28 G pairs/s** — about **6×
less pair throughput**, plus per-frame CPU work they don't have at all
(readback ~4–5 MB `mapAsync` + snapshot + postMessage + Canvas2D draw ~10 ms).

## Where the remaining gap actually is (ranked)

1. **Render architecture (biggest, and it caps fps regardless of sim speed).**
   They render on-GPU from the sim buffers in the same submit; we read the SoA
   back every frame and draw on the main-thread Canvas2D. Even with a free
   simulation, our frame cost is ~12–15 ms at 50k ⇒ ~60–80 fps ceiling and a
   busy main thread.
2. **Force-kernel memory pattern.** Our resident hash stores agent **indices**
   (CSR) — every neighbour access is an indirected, scattered SoA read. Their
   sort makes neighbour data contiguous. On GPUs this is typically worth 2–4×
   on a gather-bound kernel.
3. **Kernel generality.** Ours is graph-compiled (three Table Lookups through
   an f32-bitcast aux buffer per pair, generic ports/guards); theirs is a
   hand-fused closed form with a packed u32 matrix. Maybe 1.5–2×. This is the
   price of being an authoring tool rather than one sim — we keep it.

## What to do about it (proposal, needs greenlight)

- **A. GPU-resident agent RENDER** — the worker draws agents straight from the
  resident SoA to the OffscreenCanvas (the WebGPU grid already has the
  direct-render + `attachCanvas` infrastructure): instanced-quad point sprites,
  optional additive glow (their exact technique — cheap and pretty). Per-frame
  readback becomes **on-demand** (inspector / pause / save / indicators at low
  rate). Removes items: readback, snapshot, clone, Canvas2D — the whole
  per-frame CPU cost. This is the single biggest remaining lever and makes fps
  independent of population for the render side.
- **B. Bin-sorted resident iteration** — extend the resident hash build's
  scatter to also write a **bin-sorted mirror of the agent data** (ping-pong),
  and iterate `binStart..binEnd` contiguously in getNearbyAgents / the force
  pass. Coalesced reads → expect a multiple on the sim side at high density.
- **C. Not worth it**: per-model packed interaction words (breaks table
  generality), dt-continuous time (we are a discrete-generation CA tool by
  design), AoS conversion (with B, sorted SoA coalesces the same).

Honest bound: with A+B a Particle-Life-class model should run 64k at display
rate; a dedicated single-purpose app will always keep some edge from kernel
fusion (item 3) — parity of feel, not of microbenchmarks, is the target.

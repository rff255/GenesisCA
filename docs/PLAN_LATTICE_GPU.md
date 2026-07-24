# PLAN — Lattice GPU Render & Residency

Design authority for the CA-grid performance work. Measurements:
[PERF_REVIEW_LATTICE.md](PERF_REVIEW_LATTICE.md). Subsystem risk +
feature-preservation matrix: [IMPACT_MAP_LATTICE_GPU.md](IMPACT_MAP_LATTICE_GPU.md).
Illustrated version: [PLAN_LATTICE_GPU.html](PLAN_LATTICE_GPU.html).
Execution runbook: [HANDOFF_LATTICE_GPU.md](HANDOFF_LATTICE_GPU.md).

---

## Mission

Make the CA grid as fast as the hardware allows **for whatever the user
models** — 2D and 3D, every compile target — without a single model-specific
fast path, and without any feature losing function.

Two constraints govern every decision:

1. **Generality.** Gates key on general model properties only (`dimension`,
   `gridDepth`, resolved compile target, `topologyMode`, `hasGlyphs`,
   `skipIsolatedEmpty.enabled`, boundary treatment, compiler-computed usage
   flags). Never on a rule shape, a node count, or a shipped model.
2. **Feature preservation.** The readback policy (`free` / `frame` /
   the one-shot rule) is the *only* sanctioned way to remove per-frame CPU work.
   A feature may cost a readback **while in use**; it may never stop working.

---

## The measured problem, in one picture

At the default **gens/frame = 1**, the simulation is a minority of the frame
everywhere the GPU is involved:

```
Accretor 300³, WebGPU  ──────────────────────────────────────────────────── 758 ms/frame
  GPU step        ▏2.35 ms
  colours readback ████████ ~110 ms      (108 MB GPU→CPU)
  colour pass      ████████████████ ~215 ms
  copy + transfer  ██ 30 ms              (108 MB)
  main-thread rescan ████████████████ 218 ms   (uploadColors over 27M cells)

Life3D 128³, WebGPU   ──────── 87 ms/frame      (GPU step ≈ 0, everything else render tax)
GoL 1000², WebGPU     ─ 7.2 ms/frame            (GPU step 0.29 ms; 6.9 ms fence + round trip)
GoL 1000², WASM       ──── 26.9 ms/frame        (step 14.7 ms + 10.3 ms colour pass/ship)
```

So the plan attacks, in order: **the 3D render round trip**, **the per-batch
GPU fence**, **the full-grid dispatch on WebGPU**, and **the CPU neighbour
tables**.

---

## L1 — Worker-side WGSL voxel render for 3D grids  ★ headline

**Problem (measured).** A 3D grid never gets WebGPU direct render — the attach
is gated `!is3D` because [gl3d.ts](../src/simulator/render/gl3d.ts) is a
**WebGL2 renderer on the main thread** and needs a CPU colours buffer. Every
frame therefore pays a `total×4` GPU→CPU readback, a `total×4` copy, a
`total×4` structured transfer, and an **O(total) main-thread rescan** in
`uploadColors`. At 300³: 103 MB moved, ~270 ms of bookkeeping, around a
**2.35 ms** simulation. Even at 96³ it is 15× overhead.

**Design.** Do for the GRID exactly what shipped for AGENTS in Phase C: the
**worker renders into a transferred `OffscreenCanvas`** with a WGSL pass reading
the existing `colorsBuf`, layered **under** the gl3d canvas; gl3d renders only
its interaction overlays over a transparent clear (`setOverlaysOnly`, already
shipped). The main thread posts a camera uniform; nothing crosses the wire per
frame.

- **Render**: instanced unit cubes, one instance per **visible** cell.
  Visibility (alpha ≠ 0) and the buried-cell cull are computed **on the GPU**
  (a compaction pass writing an instance buffer + an indirect draw) — the same
  count → scan → scatter machinery the agent resident hash already ships.
- **Parity, scoped honestly**: free mode ships the *core* look — per-cube
  normal shading (ambient + diffuse + Blinn-Phong specular), the clip interval,
  cell gaps, background colour, alpha blend + back-to-front sort, and the Z-up
  remap **shared with gl3d** (export the remap + camera + light helpers the way
  Phase C exported `sceneCameraMatrices` / `lightWorldDirFor`, so the two
  renderers cannot disagree). **Cast shadows and occupancy AO stay
  frame-mode features**: enabling either detaches free mode and gl3d renders
  the frame exactly as today — the same pattern the 3D alpha-blend toggle
  already uses for the agent sphere pass.
- **Readback policy**: `free` while nothing needs CPU colours; `frame` when the
  pointer is over the canvas, a brush/inspect popover is live, recording is on,
  or shadows/AO are enabled; **one-shot** for any message that reads or mutates
  grid state, in the single existing dispatcher gate.

**Gate (general).** `dimension === '3d' && gridDepth > 1` **and** the resolved
grid target is WebGPU **and** `OffscreenCanvas.transferControlToOffscreen`
exists **and** `!hasGlyphs` (glyphs are a main-thread overlay and are already
badge-rejected in 3D) **and** the light config has shadows + AO off. Anything
else keeps today's path byte-for-byte.

**Expected.** Accretor 300³ **758 → ~10 ms/frame (≈ 50–75×)**; Life3D 128³
**87 → ~5 ms**; Life3D 96³ **44 → ~4 ms**. Plus: 108 MB/frame of traffic gone,
the 515 MB `instData` reservation gone, and the main thread free.

**Zero compiler changes** — the pass reads `colorsBuf`, which all three targets
already write. `check-compile-identity` must report every model unchanged.

---

## L2 — Pipelined step batches (overlap CPU and GPU)

**Problem (measured).** A WebGPU grid costs a **flat ~7 ms per step batch,
independent of grid size** (6.2 / 7.2 / 6.7 ms at 300² / 1000² / 2000², while
the kernels are 0.17 / 0.29 / 1.08 ms). Decomposition at 1000²: an empty batch
round-trips in **0.53 ms**, but a batch containing **one** dispatch takes
**7.5 ms** — ≈ 6.7 ms of submit→fence latency around a 0.29 ms kernel. The
worker fences (`onSubmittedWorkDone`) before posting `stepped`, and the app only
posts the next batch from the `stepped` handler, so **CPU and GPU never
overlap**.

**Design.** Bounded pipelining: let batch *N+1* be encoded and submitted while
batch *N*'s fence is still outstanding, capped at a small depth (1–2 frames) so
back-pressure is preserved. **The message-deferral invariant does not change**:
`asyncStepBatchInFlight` keeps deferring every incoming message — only the GPU
*fence* relaxes. (Relaxing the deferral is what caused the P0 agent corruption;
that is explicitly out of scope.)

*Optional sub-item*: record K generations into ONE command encoder (removes
K−1 submits). Gated on no per-generation standalone-indicator resets (those use
`queue.writeBuffer`, which cannot be interleaved between passes of one encoder)
and on stop-event checking cadence ≤ K. Glyph clears fold in via
`enc.clearBuffer`. Measured value is smaller than the fence — treat as a bonus.

**Gate (general).** WebGPU grid target + not recording + no per-gen indicator
reset (for the single-encoder sub-item) + stop-check cadence honoured.

**Expected.** 2D WebGPU at gens/frame = 1: **7.2 → ~1.5 ms/frame (≈ 4×)**;
compounds with L1 in 3D.

**⚠ Precondition.** The 6.7 ms figure was measured in an **occluded** pane.
L2 begins by re-measuring it in a **visible** pane. If the fence is actually
~1 ms there, L2 is **cancelled and documented as not worth it** — that is a
valid, valuable outcome.

---

## L3 — Sparse stepping on WebGPU

**Problem (measured).** "Skip Isolated Empty Cells" gives **13.8×** on Accretor
128³ on the CPU targets (24.2 → 1.75 ms/gen) — and WebGPU **ignores it
entirely**, dispatching all `total` cells every generation (`sieActive: -1`).
At 300³ the GPU spends 2.35 ms/gen on 27M cells of which a few hundred thousand
matter.

**Design.** Maintain the active set **on the GPU**: a per-generation
clear → count → exclusive-scan → scatter over the empty-attribute buffer
(the shipped agent resident-hash algorithm), then dispatch the step **indirectly**
over the compacted list. Reset / paint / load rebuild it from the uploaded state.

**Gate (general).** The existing `sparseSteppingEnabled` predicate (enabled +
synchronous + grid cells + no agents + no glyphs) **plus** the WebGPU target.
When SIE is off, the emitted shader must be **byte-identical** to today's.

**Expected.** Accretor 300³ marginal **2.35 → ~0.1 ms/gen**; unblocks much
larger sparse volumes. Compounds with L1 (which removes the render tax that
currently hides this entirely).

**Compiler change** → `check-compile-identity` baseline discipline is mandatory.

---

## L4 — Inline neighbours on the CPU targets (decouple from SIE)

**Problem (measured).** JS/WASM reserve `total × nSz × 4` bytes and fill them in
a nested loop at init: **173 MB / 0.50 s** (MNCA 256²), **693 MB / 2.0 s**
(MNCA 512²), **208 MB / 0.61 s** (Accretor 128³), **128 MB / 0.45 s**
(GoL 2048²). A 300³ Moore-26 model needs **2.8 GB** — impossible under the
wasm32 4 GiB ceiling. WebGPU removed this in 2023 (inline offsets); the SIE
work built the same **compact packed-NI** path for JS + WASM, but it is
reachable **only when sparse stepping is on**.

**Design.** Decouple "inline neighbours" from "sparse active set" — one new
general predicate consumed by the JS compiler, the WASM compiler, `wasm/layout.ts`
**and** the worker's `buildNeighborIndices`, in exact lockstep (the
`sparseSteppingEnabled` pattern), plus a layout signature the worker asserts
before instantiating (the `agentWasmLayoutSig` precedent).

**Open question — this phase is measurement-gated.** Is inline decode faster or
slower than a table fetch on the CPU? WebGPU found ALU beats a cold global read;
on a CPU with cache-resident tables it may go either way, and JS aggregate
**fusion** is disabled in inline mode (the fused builders read the table), which
could cost more than the table saves. **The phase starts with a throwaway A/B on
GoL / Wireworld / MNCA / Life3D / Accretor and STOPS if inline loses.**

**Expected if it wins.** MNCA 512²: **693 MB → ~1.4 KB**, init **2.0 s → ~10 ms**;
300³ becomes possible on WASM; every large CPU-target model gets its startup
back.

---

## L5 — Size the 3D instance buffer by visible cells

`Gl3DRenderer.uploadColors` allocates `total × 5` floats — **515 MB at 300³** —
sized by the whole volume although only alive cells are instanced. Grow-on-demand
from a small base. Local, low risk, and it still matters after L1 because
**CPU-target 3D keeps the CPU renderer**.

---

## L6 — Widen the WebGPU indicator reduction plan

The CPU fallback costs **3.5–4 ms/gen per 1M cells** (measured on Wireworld's
two linked defs) and at gens/frame = 1 the existing batch-tail deferral cannot
help by construction. [webgpuReduce.ts](../src/simulator/engine/webgpuReduce.ts)
already GPU-reduces `total` on int/tag/bool and `frequency` on bool/tag; adding
float `total` (an f32-bitcast CAS loop, the pattern `updateIndicator` already
uses) and bounded-cardinality integer `frequency` removes the last common
per-frame O(total) CPU scan on the GPU target.

---

## Sequencing

```
L1 (3D WGSL voxel render)  ────────────────►  the headline; unblocks 3D entirely
   └► L3 (sparse on WebGPU)  ──────────────►  only visible once L1 removes the render tax
L2 (pipelining)  ──────────────────────────►  independent; MEASURE FIRST in a visible pane
L4 (inline neighbours, CPU)  ──────────────►  independent; A/B-gated, may be cancelled
L5 (instData sizing)  ─────────────────────►  independent, tiny
L6 (indicator reductions)  ────────────────►  independent, bounded
```

Recommended launch order: **L1 → L2 → L5 → L3 → L6 → L4**. L5 is cheap enough
to fold into whichever session has room. L4 last because it is the one whose
*value* is unproven.

---

## Extension roadmap — scoping limits vs fundamentals

**Scoping limits** (lift later if wanted):

- SIE excludes **glyph** models (a sparse glyph clear would lift it).
- SIE on WebGPU (**L3**), inline neighbours on CPU (**L4**), GPU voxel render
  (**L1**) — all scope, all planned.
- Shadows / occupancy AO in free-mode 3D (frame-mode features in L1; a WGSL
  shadow pass could lift it later).
- Workgroup-tiled stencil ([HUGE_GRID §2.2](HUGE_GRID_OPTIMIZATIONS.md)) and
  sub-word attribute packing (§2.3) — both deferred as premature by measurement.
- A **display-resolution** grid+agent composite (the E2 world-resolution version
  was user-rejected and is disabled) — an independent, still-open redesign.

**Genuine fundamentals** (audited in the Impact Map §5, do not attempt):

- **Asynchronous update mode on WebGPU** — a write visible to a later cell in the
  same step is inherently serial.
- **Order-dependent indicator ops** (`toggle` / `next` / `previous`) on WebGPU —
  non-commutative mutation of one accumulator by parallel writers.
- **SIE requires synchronous mode**, and **SIE excludes agent models** (agents
  deposit into cell attributes outside the step, so the active set cannot see
  those transitions).
- f32-vs-f64 and per-cell-PCG-vs-shared-RNG are **documented intentional
  differences**, not limits.

---

## Explicit non-goals

- No rule-semantics, node-catalogue, schema or `.gcaproj` change.
- No model-specific gate or threshold tuned to a shipped model.
- No second `GPUDevice`, no COOP/COEP / `SharedArrayBuffer`, no server.
- No precision-policy change.
- No attempt to remove the JS/WASM **3D** colours readback (a CPU renderer
  reading CPU colours — intrinsic; L5 is the only honest gain there).
- No attempt to remove the CPU-target `sendColors` copy (`colors` is a view over
  `wasmMemory` at a baked offset — structurally untransferable).

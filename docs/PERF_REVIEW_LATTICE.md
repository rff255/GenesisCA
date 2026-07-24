# CA Grid (Lattice) Performance Review — 2026-07-24

The lattice sibling of [PERF_REVIEW_AGENT_ENGINE.md](PERF_REVIEW_AGENT_ENGINE.md).
Scope: the **cell grid** simulation + render, 2D **and** 3D, on all three compile
targets, in the **general** case — no model-specific fast paths.

Everything below is **measured**, not guessed:

- **[scripts/bench-lattice.mjs](../scripts/bench-lattice.mjs)** (new) — drives the
  **real `sim.worker.ts`** (bundled with a `self` shim) with real `init` / `step` /
  `colorPass` messages, over real library `.gcaproj` models at several grid sizes,
  on the JS target and a **really instantiated WASM module**. Nothing is
  re-implemented, so `initGrid`, `buildNeighborIndices`, the compiled step, the
  sync bulk copy, `computeLinkedIndicatorsFromBuffer`, `runColorPass` and the
  `sendColors` copy are all the code the app actually runs.
- **In-browser probes** on the same machine (NVIDIA **Pascal**, Chrome 148,
  `navigator.gpu` present, `maxStorageBufferBindingSize` 2 GB,
  `maxComputeWorkgroupsPerDimension` 65535) for everything Node cannot see —
  every WebGPU number, the per-frame readback, and the main-thread handler cost.
  Driven through `window.__simWorker` per the occlusion-safe recipes in
  [HANDOFF_GPU_AGENT_RENDER.md](HANDOFF_GPU_AGENT_RENDER.md) §3.

Rerun the profiler after any lattice change to see which phase moved.

> **Harness trap worth knowing** — `tryInstantiateWasmModule` resolves a
> **promise**, so a `step` posted in the *same synchronous turn* as `init`
> silently runs the JS fallback. The harness asserts WASM really engaged by
> booby-trapping the JS `stepCode` with a throwing function (`same-turn=js,
> after-tick=wasm -> PASS` on every run). Before the fix, every "WASM" row was
> secretly JS.

---

## 1. Executive summary — where a lattice generation actually goes

| Case | What the user sees at gens/frame = 1 | Of which is SIMULATION | Overhead ratio |
|---|---|---|---|
| **3D WebGPU, Accretor 300³ (27M cells)** | **540 ms** worker + **218 ms** main thread | **2.35 ms** | **≈ 320×** |
| **3D WebGPU, Life3D 128³ (2.1M)** | **70 ms** worker + **17 ms** main thread | ≈ 0 ms (hidden in the readback) | ≫ 100× |
| **3D WebGPU, Life3D 96³ (0.9M)** | 36.9 ms worker + 7 ms main | 2.8 ms | ≈ 15× |
| **2D WebGPU, GoL 1000²** | 7.2 ms | 0.29 ms | ≈ 25× |
| **2D WebGPU, GoL 300²** | 6.2 ms | 0.17 ms | ≈ 36× |
| **2D WASM, GoL 1000²** | 26.9 ms | 14.7 ms | ≈ 1.8× |

Three conclusions, in priority order:

1. **A 3D WebGPU grid never gets direct render.** The canvas attach is gated
   `!is3D` ([SimulatorView.tsx](../src/simulator/SimulatorView.tsx) ~:4243)
   because the voxel renderer is WebGL2 on the **main thread** and needs a CPU
   colours buffer. So every frame pays: a GPU→CPU readback of `total×4` bytes,
   a `total×4` copy in `sendColors`, a `total×4` structured transfer, and an
   **O(total) main-thread rescan** in `Gl3DRenderer.uploadColors`. At 300³ that
   is 103 MB moved and ~270 ms of pure bookkeeping around a **2.35 ms**
   simulation. This is the single biggest lattice finding.
2. **Even in 2D, the WebGPU grid is dominated by a FLAT per-batch cost.**
   ~7 ms per step batch **independent of grid size** (6.2 / 7.2 / 6.7 ms at
   300² / 1000² / 2000²). At the default gens/frame = 1 the GPU work is 3–15%
   of the frame. See §4 for the decomposition and the honesty caveat.
3. **On the CPU targets the neighbour index table is the memory story.**
   `total × nSz × 4` bytes, reserved up front, filled in a nested loop at init:
   **173 MB / 0.50 s** for MNCA at 256², **693 MB / 2.0 s** at 512², **208 MB /
   0.61 s** for Accretor at 128³, **128 MB / 0.45 s** for GoL at 2048². WebGPU
   solved this in 2023 (inline offsets, [HUGE_GRID_OPTIMIZATIONS.md](HUGE_GRID_OPTIMIZATIONS.md) §2.1)
   and the "Skip Isolated Empty Cells" work built the same **compact packed-NI**
   path for JS + WASM — but it is only reachable when *sparse stepping* is on.

---

## 2. CPU targets (JS / WASM) — the phase table

`node scripts/bench-lattice.mjs`. All figures **ms**, per generation except
`colourPass` / `colShip` / `init` which are **per frame** / one-time.
`bulkCopy` is the sync `w→r` copy the **WASM** target pays every generation (JS gets
it free via a ref swap) — it is already *inside* the WASM `step/gen` column and
is broken out to show its share. `nbrTable` is the non-sparse neighbour-index
reservation; `wasmMem` is the whole `WebAssembly.Memory`.

### 2D

| model | grid | step/gen JS | step/gen WASM | WASM/JS | bulkCopy | colourPass JS/WASM | colShip | init | nbrTable | wasmMem |
|---|---|---|---|---|---|---|---|---|---|---|
| Game of Life | 256² | 1.66 | 0.85 | **1.95×** | 0.01 | 1.15 / 0.27 | 0.16 | 21–29 | 2 MB | 2.8 MB |
| Game of Life | 1024² | 28.6 | 14.1 | **2.03×** | 0.05 | 9.2 / 3.7 | 1.0 | 104 | 32 MB | 43 MB |
| Game of Life | 2048² | 112 | 55.4 | **2.03×** | 0.30 | 36.4 / 18.5 | 4.5 | 420–450 | 128 MB | 172 MB |
| Gray-Scott | 256² | 2.87 | 1.38 | 2.09× | 0.05 | 0.83 / 0.32 | 0.18 | 28–41 | 2 MB | 4.6 MB |
| Gray-Scott | 1024² | 48.8 | 24.6 | 1.98× | 1.7 | 10.0 / 3.4 | 1.0 | 110 | 32 MB | 73 MB |
| Ext. Wireworld | 1024² | 14.0 | 5.97 | **2.35×** | 1.6 | 7.9 / 2.2 | 1.1 | 150–170 | 48 MB | 83 MB |
| Kelp War | 1024² | 64.2 | 44.7 | 1.43× | 0.3 | 9.9 / 3.3 | 1.0 | 97–140 | 32 MB | 49 MB |
| MNCA | 256² | 78.7 | 57.5 | 1.37× | 0.02 | 0.55 / 0.29 | 0.16 | **496** | **173 MB** | 175 MB |
| MNCA | 512² | 317 | 229 | 1.39× | 0.06 | 1.2 / 0.5 | 0.31 | **2025** | **693 MB** | 698 MB |
| Amphiphile (async) | 256² | 19.1 | 5.23 | **3.65×** | — | 0.65 / 0.45 | 0.15 | 17–24 | 2 MB | 2.9 MB |
| Amphiphile (async) | 512² | 103 | 31.3 | **3.30×** | — | 2.3 / 1.7 | 0.30 | 44 | 8 MB | 11 MB |

### 3D

| model | grid | step/gen JS | step/gen WASM | WASM/JS | colourPass JS/WASM | colShip | init | nbrTable |
|---|---|---|---|---|---|---|---|---|
| Life3D | 32³ | 1.89 | 0.95 | 1.99× | 0.47 / 0.24 | 0.07 | 32–81 | 3.3 MB |
| Life3D | 64³ | 15.1 | 15.9 | 0.95× ⚠ | 3.2 / 3.9 | 0.34 | 90 | 26 MB |
| Life3D | 96³ | 51.8 | 25.8 | 2.01× | 10.6 / 3.7 | 0.75 | 274–314 | 88 MB |
| Accretor | 64³ | 2.33 | 3.65 | 0.64× ⚠ | 3.4 / 0.8 | 0.31 | 110–123 | 26 MB |
| Accretor | 128³ | 44.7 | 26.8 | 1.67× | 29.8 / 13.6 | 2.1 | 614–622 | **208 MB** |

⚠ The two sub-1× cells are run-to-run noise (a concurrent browser probe was
competing); the 32³/96³/128³ rows of the same models are consistent at ~1.7–2.0×.

**Findings.**

- **WASM is worth 1.4–4× on the lattice** — unlike the agent engine, where the
  same comparison was a wash (~1.1×). Branchy tag/async rules gain the most
  (Wireworld 2.35×, Amphiphile 3.3–3.7×); memory-bound huge-neighbourhood rules
  the least (MNCA 1.4×). **The lattice compile target genuinely matters.**
- **The sync bulk copy is NOT a bottleneck**: 0.05–2.0 ms/gen, i.e. 3–10% of a
  WASM step even on the float-heavy models. See §7 (ruled out).
- **The colour pass is a real per-frame cost** and is 2.5–3× cheaper on WASM
  than JS (it is the same loop over every cell). At 1024² it is 8–10 ms on JS.
- **`init` is dominated by `buildNeighborIndices`** and tracks `nbrTable` almost
  exactly (MNCA 512²: 693 MB → 2.0 s of nested-loop writes).

### Focused: linked indicators (the CPU scan)

Extended Wireworld 1024², WASM, 2 linked defs. Order-sensitive (the first
config measured is cold) so both orders were run; take the **second** of each:

| | ms/gen at gens/frame = 1 |
|---|---|
| indicators ON (warm) | 9.2 – 9.6 |
| indicators OFF (warm) | 5.66 |
| **cost of the 2 linked scans** | **≈ 3.5 – 4.0 ms/gen at 1M cells** |

Batch amortization (the existing deferred-scan path):

| gens/frame | ms/gen |
|---|---|
| 1 | 9.26 |
| 5 | 5.51 |
| 20 | 4.90 |

So the deferral works exactly as designed — and at **gens/frame = 1 it is a
no-op by construction**, which is the common case. On WebGPU the equivalent
work is already GPU-reduced for the eligible aggregations
([webgpuReduce.ts](../src/simulator/engine/webgpuReduce.ts)); the CPU targets
have no equivalent except the SIE-incremental path.

### Focused: "Skip Isolated Empty Cells" (Accretor 128³, WASM)

| | step/gen | init |
|---|---|---|
| SIE **OFF** | 24.2 ms | 611 ms |
| SIE **ON** | **1.75 ms** | **61 ms** |
| ratio | **13.8×** | **10.0×** |

Two independent wins: the O(active) step loop **and** the compact packed-NI
neighbour tables (which is what collapses `init`, and what makes 300³ loadable
at all on a CPU target — the full table would be 2.8 GB).

> **NB for anyone re-running this**: the `skipIsolatedEmpty` override must reach
> the **compile** as well as the init message. `sparseSteppingEnabled(model)`
> drives the emitted loop shape *and* the baked layout; overriding only the init
> message makes the worker build a sparse layout for a non-sparse module — a
> silent offset desync that produced a bogus "2.5×" reading in the first run of
> this review.

---

## 3. 3D render tax — the headline

### 3a. Synthetic replica (Node) of the two O(total) render phases

`Gl3DRenderer.uploadColors` copied verbatim + the `sendColors`
`new Uint8ClampedArray(colors)` copy:

| volume | cells | colours buffer | worker copy | main-thread `uploadColors` scan | `instData` reservation |
|---|---|---|---|---|---|
| 64³ | 0.26M | 1 MB | 0.31 ms | 0.93 ms | 5 MB |
| 128³ | 2.1M | 8 MB | 1.98 ms | 7.75 ms | 40 MB |
| **300³** | **27M** | **103 MB** | **30.2 ms** | **53.3 ms** | **515 MB** |

`instData` is `total × 5` floats — sized by the **whole volume**, not by the
number of *visible* cells, even though only alive cells are instanced.

### 3b. Real app, real GPU (in-browser)

| model / target | fixed per frame, no colour pass | fixed per frame + colour pass | n=1 gen | marginal ms/gen | main-thread handler (median) | colours shipped |
|---|---|---|---|---|---|---|
| Life3D 96³ **WebGPU** | 22.9 | 35.1 | **36.9** | **2.81** | 7.0 | 3.54 MB |
| Life3D 96³ **WASM** | 21.4 | 12.4 | 45.4 | 25.8 | 7.0 | 3.54 MB |
| Life3D 128³ **WebGPU** | 40.2 | 71.3 | **69.7** | ≈ 0 (hidden) | 17.1 | 8.4 MB |
| Accretor 300³ **WebGPU** (as shipped) | (cold outlier) | 327 | **540.8** | **2.35** | **217.9** | **108 MB** |

The WASM 96³ marginal (25.8 ms/gen) matches the Node harness (25.8) to three
digits — a clean cross-validation of both measurement rigs.

**The Accretor line is the whole argument.** The GPU simulates 27 million cells
in **2.35 ms**. The user gets **1.8 fps**, because every frame the worker reads
108 MB back, copies it, transfers it, and the main thread rescans all 27M cells
to rebuild an instance buffer.

**The 3D compile-target comparison is therefore misleading today**: WebGPU is
**9.2× faster per generation** than WASM at 96³ (2.81 vs 25.8) but only
**1.23× faster end-to-end** (36.9 vs 45.4), because both pay the same per-frame
readback/ship/rescan tax and it dominates.

---

## 4. 2D WebGPU — a flat per-batch cost

Game of Life, direct render active (`hasColors: false` on every `stepped` — the
colours never cross the wire), NVIDIA Pascal.

| grid | n=1 | n=10 (ms/gen) | n=100 (ms/gen) | marginal ms/gen | implied fixed per batch |
|---|---|---|---|---|---|
| 300² (90k) | 6.18 | 1.26 | 0.279 | 0.170 | ≈ 6.0 |
| 1000² (1M) | 7.18 | 1.02 | 0.362 | 0.289 | ≈ 7.2 |
| 2000² (4M) | 6.65 | 2.95 | 1.268 | 1.082 | ≈ 6.0 |

Decomposition at 1000² using a `count: 0` step (the worker skips the loop
entirely but still runs the tail):

| probe | ms | what it isolates |
|---|---|---|
| `count:0, skipColorPass` | **0.53** | postMessage round trip + `finalizeStepWebGPU` fence with **nothing submitted** + `sendColors` |
| `count:0` (colour pass on) | **4.05** | + the OM dispatch + the present pass + reductions |
| `count:1, skipColorPass` | **7.51** | + **one** `dispatchStep` submit and its fence |
| `count:1` (colour pass on) | 7.18 | the colour pass is **free** once a step already paid the latency |

So a *single* compute submit costs **≈ 6.7 ms from submit to fence completion**
while the kernel itself is 0.29 ms. The worker's back-pressure fence
(`await rt.device.queue.onSubmittedWorkDone()` when there is nothing to read
back, [sim.worker.ts](../src/simulator/engine/sim.worker.ts) `finalizeStepWebGPU`)
plus the app's strictly serialized `stepped → draw → sendNextStep` loop means
**CPU and GPU never overlap**: the GPU is idle while the CPU works and vice versa.

> **HONESTY CAVEAT — this one number needs re-measuring in a VISIBLE pane
> before any work is built on it.** The Browser pane reports `document.hidden`,
> and while Chrome does not throttle worker *compute*, GPU-process scheduling
> for an occluded page is not something this review could rule out. The
> *shape* of the finding (flat, grid-size-independent, ~25–36× the kernel at
> gens/frame = 1) is robust across three grid sizes and two models; the
> *magnitude* (6.7 ms) is the part to re-confirm. Pascal power management is
> the other plausible contributor: a GPU that idles between fenced frames
> clocks down.

**2D CPU target for comparison** (GoL 1000², WASM, real app): fixed per frame
**10.3 ms** (colour pass ~2 + colours copy ~1 + a 4 MB transfer), marginal
**14.7 ms/gen**, main-thread handler **0.7 ms**. So on the CPU targets the
per-frame overhead is ~40% of a frame at gens/frame = 1 — significant, but the
simulation is still the majority. On WebGPU it is 93–97%.

---

## 5. Memory ceilings actually hit

| target | dominant reservation | 1024² Moore | 2048² Moore | MNCA 512² | Accretor 128³ | Accretor 300³ |
|---|---|---|---|---|---|---|
| JS / WASM | `total × nSz × 4` neighbour table | 32 MB | 128 MB | **693 MB** | 208 MB | **2.8 GB — impossible** |
| JS / WASM **+ SIE** | `nSz × 4` packed NIs | ~64 B | ~64 B | ~1.4 KB | ~200 B | ~200 B |
| WebGPU | none (inline offsets) | ~64 B | ~64 B | ~3 KB | ~200 B | ~200 B |
| 3D render (main thread) | `total × 5` f32 `instData` | — | — | — | 40 MB | **515 MB** |

The wasm32 4 GiB `WebAssembly.Memory` ceiling is a hard wall: a 300³ Moore-26
model **cannot** run on JS or WASM without the SIE compact tables. WebGPU has
had the fix since the inline-offset work; the CPU targets have the machinery
but it is coupled to sparse stepping.

---

## 6. Model / documentation drift found in passing

The shipped **`Accretor.gcaproj`** has `properties.skipIsolatedEmpty.enabled =
false` and `useWebGPU = true`, while its own `ruleDescription` tells the user
*"The 300×300×300 volume (27M cells) is practical because 'Skip Isolated Empty
Cells' is ON"*. As shipped it therefore runs the full 27M-cell dispatch every
generation (which the GPU handles fine, at 2.35 ms) and then pays the full 3D
render tax (540 + 218 ms/frame). Not a code bug — a model/doc mismatch worth
the user's attention, and a good illustration of why sparse stepping on the
WebGPU target (L3) matters.

---

## 7. What is NOT worth doing (measured negatives)

| candidate | measurement | verdict |
|---|---|---|
| **Eliminating the sync `w→r` bulk copy** | 0.05–2.0 ms/gen = 3–10% of a WASM step | **No.** The WASM module's read/write offsets are *baked*, so a ref-swap is impossible by construction; the alternative is a second module or an indirection in every access. Cost/benefit is bad. |
| **Batching N generations into ONE command encoder** | marginal per-gen on WebGPU is 0.17–1.08 ms of which the submit is a small part; the measured cost is the **fence**, not the submit count | **Low value on its own.** Fold it in as an optional sub-item of the pipelining phase (L2), not as its own phase. It also forces GPU-side replacements for the per-gen `queue.writeBuffer` indicator reset and stop-flag clear. |
| **Removing the `sendColors` colours copy on CPU targets** | 1.0 ms at 1M, 4.5 ms at 4M, 30 ms at 27M | **Cannot.** `colors` is a *view over `wasmMemory`* at a baked offset, so it can neither be transferred nor double-buffered without breaking the WASM ABI. A `SharedArrayBuffer` would need COOP/COEP, which the standalone-`.html` export explicitly avoids. **Irreducible.** |
| **f64 → f32 cell attributes** | would halve float bandwidth (Gray-Scott bulk copy 1.7 → 0.85 ms/gen, some step gain) | **No** — it breaks the JS↔WASM f64 bit-parity contract, exactly as concluded for the agent SoA. Only as a deliberate precision-policy decision. |
| **Workgroup-tiled stencil on WebGPU** ([HUGE_GRID §2.2](HUGE_GRID_OPTIMIZATIONS.md)) | the marginal GPU kernel is 0.17–2.35 ms while the frame is 7–540 ms | **Premature.** Optimising 3% of the frame. Revisit only after L1 + L2, and only for MNCA-class models. |
| **Sub-word packing of bool/tag attrs on WebGPU** ([HUGE_GRID §2.3](HUGE_GRID_OPTIMIZATIONS.md)) | a memory-ceiling item; no size measured here hit the 2 GB buffer limit | **Defer.** Not a speed lever. |
| **Making the colour pass incremental** | 8–10 ms/frame at 1024² JS, 2–4 ms WASM | **No general form.** Which cells changed colour is not derivable without evaluating the mapping (a model attribute or viewer switch can recolour every cell). The SIE active set already gives the only sound sparse version, and it is already wired (`runColorPass(sparseOk)`). |

---

## 8. Prioritized recommendations

Full design in [PLAN_LATTICE_GPU.md](PLAN_LATTICE_GPU.md); subsystem risk in
[IMPACT_MAP_LATTICE_GPU.md](IMPACT_MAP_LATTICE_GPU.md).

| # | phase | measured target | expected win | confidence |
|---|---|---|---|---|
| **L1** | **Worker-side WGSL voxel render for 3D grids** | 23–330 ms readback + 7–218 ms main-thread rescan + 3.5–108 MB/frame + 515 MB `instData` | **Accretor 300³: 758 → ~10 ms/frame (≈ 50–75×).** Life3D 128³: 87 → ~5 ms | **High** — direct analogue of the shipped agent Phase C, and the costs are measured, not modelled |
| **L2** | **Pipelined step batches (overlap CPU and GPU)** | the flat ~7 ms per-batch fence on WebGPU | 2D WebGPU at gens/frame = 1: 7.2 → ~1.5 ms/frame (≈ 4×); compounds with L1 in 3D | **Medium** — re-measure the fence in a visible pane FIRST (§4 caveat) |
| **L3** | **Sparse stepping on WebGPU** (GPU active-set compaction) | WebGPU runs all `total` cells; SIE gives 13.8× on CPU | Accretor 300³ marginal 2.35 → ~0.1 ms/gen; unblocks much larger sparse volumes | **Medium-high** — the algorithm is the agent resident-hash count→scan→scatter, already shipped once |
| **L4** | **Inline neighbours on the CPU targets** (decouple from SIE) | 173/693/208/128 MB tables, 0.5–2.0 s init | MNCA 512²: 693 MB → ~1.4 KB, init 2.0 s → ~10 ms; 300³ becomes possible on WASM. Step time **must be measured** (may be faster *or* slower) | **Medium** — the emitters exist; the A/B on step time is the open question |
| **L5** | **Size `instData` by visible cells, not `total`** | 515 MB at 300³ for ~1M visible cells | ~500 MB of main-thread heap on CPU-target 3D (where the readback is intrinsic) | **High** — small, local, low risk |
| **L6** | **Widen the WebGPU indicator reduction plan** | CPU fallback = 3.5–4 ms/gen per 1M cells | removes a per-frame O(total) CPU scan for float-total and integer-frequency indicators | **Medium** — bounded, but needs a CAS loop for f32 sums |

**Not planned** (see §7): bulk-copy elimination, colours-copy elimination,
f32 attributes, workgroup tiling, sub-word packing.

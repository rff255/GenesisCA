# GenesisCA — Performance Optimization Paths

This document maps the option space for accelerating the GenesisCA simulator beyond what
the current loop-wrapped JS compiler delivers. It is a **working reference** to inform
future work — it captures both the chosen path and the deferred alternatives, so the
deferred options don't have to be re-analysed from scratch when priorities change.

**Audience:** future-self / contributors deciding what to do when the next performance
ceiling is hit.

---

## 1. Decision Summary

| Wave | Status | What it is | When |
|---|---|---|---|
| **Wave 1** | Active / planned | JS micro-optimizations to the existing compiler + worker | Now |
| **Wave 2** | Conditional on Wave 1 numbers | WebAssembly compile target (second compiler backend) | If Wave 1's gain is insufficient |
| **Waves 3+** (WebGPU, SAB multi-worker, hybrid routing, sparse regions) | **Deferred indefinitely** | Major substrate shifts | See §6 for re-evaluation triggers |

The deferred options were rejected not because they're technically inferior but because
they all violate at least one of:

- **Universal browser compatibility** (no Chrome-only paths, no special hosting headers)
- **All-features-preserved** (async modes, neighbor writes, every node type must keep working)
- **UX homogeneity** (no path where the user's experience depends on which browser they
  loaded the app in)

---

## 2. Where Time Actually Goes Today

The architecture is already well-tuned for single-threaded CPU. Confirming this matters
because it shapes which optimizations have headroom:

- **Structure of Arrays** — typed array per attribute (`Uint8Array` bool, `Int32Array`
  int/tag, `Float64Array` float). Cache-friendly.
- **Pre-computed neighbor index tables** — `Int32Array` lookup per neighborhood. No
  per-step boundary math.
- **Loop-wrapped compilation** — graph compiles to ONE function with the for-loop
  inside, not per-cell closures. V8 sees a long-lived, monomorphic JIT target.
- **Web Worker isolation** — UI never blocks.
- **Double-buffer pointer swap** — no copy between generations in sync mode.

**Hot path:** `src/simulator/engine/sim.worker.ts` + `src/modeler/vpl/compiler/compile.ts`.

**Per-step cost (typical complex model):**

| Grid size | Cells | Ops/cell | Total ops | JS time (V8) |
|---|---|---|---|---|
| 100 × 100 | 10 K | 20–100 | 200 K – 1 M | < 1 ms |
| 1000 × 1000 | 1 M | 20–100 | 20 M – 100 M | ~50–300 ms |
| 2500 × 2500 | 6.25 M | 20–100 | 125 M – 625 M | ~300 ms – 2 s |
| 5000 × 5000 | 25 M | 20–100 | 500 M – 2.5 B | ~1–10 s |

The CLAUDE.md target is **< 2 s/step at 5000²**. JS hits the wall around 2500² for
complex models and around 5000² even for simple ones.

---

## 3. Wave 1 — JS Micro-Optimizations (status as of landing)

Sub-architectural fixes that compound. Each is local, preserves every feature, and lands
as a separate commit so we can attribute the gain.

### Landed

| # | Issue | File | Expected gain |
|---|---|---|---|
| 1 | Scratch arrays were `new Array(n)` (untyped, polymorphic) → switched to `Uint8Array` / `Int32Array` / `Float64Array` matching the source attribute type | `compile.ts` — `buildScratchDecl()` + `scratchCtorForAttr()` | 1.3–2× on neighbor-heavy models |
| 2 | Aggregate used `.reduce((s,v)=>s+v, 0)` (closure defeats inlining) → hand-written `for` loops per op (sum/product/max/min/avg/median/and/or). Helper vars renamed to `_v{id}_*` so macro inlining catches them. | `AggregateNode.ts` | 2–4× on Aggregate-heavy models |
| 4 | `Math.random()` per cell → inlined xorshift32 (Marsaglia 13/17/5) operating on a function-scope `_rs` uint32. State persists across steps via a `_rngState: Uint32Array(1)` threaded through every compiled function (`step`, `inputColor`, `outputMapping`). | `GetRandomNode.ts`, `compile.ts` (param lists + load/save), `sim.worker.ts` (state + arg push) | 3–5× faster RNG; benefits any model that calls GetRandom in the hot path |
| 5 | `_indicators["name"]` string-keyed object access → `_indicators[N]` typed-array index access. Compiler pre-resolves indicator IDs to numeric indices (mirrors `_resolvedTagIndex` pattern, also covers macro internals). Worker storage switched from `Record<string, number>` to `Float64Array`. Outgoing payload still id-keyed for UI compatibility. | `compile.ts` (`preResolveIndicators()`), `Get/Set/UpdateIndicatorNode.ts`, `sim.worker.ts` (typed arrays + id↔idx maps for state save/load) | Eliminates per-cell hash lookup; significant for models with in-loop indicator updates |

**Smoke test (Game of Life, 500² grid, 1000+ generations):** No errors. Compiled output
shape verified via Show Code panel. Bit-equivalent simulation results (no observable
behaviour change).

### Deferred (analysis revealed they're not free)

**#3 — Color buffer copy/transfer.** The plan claimed `new Uint8ClampedArray(colors)` +
transfer was wasteful. Investigation showed it's equivalent in cost to plain
`postMessage(colors)` (structured-clone): both do one O(N) copy. The genuine win
(~30–50ms/step at 5000²) requires either:
- Main-thread protocol change to return buffers (workers go from per-step alloc+copy
  to per-step transfer-only — but adds round-trip coordination), or
- Ditching cross-step color history (breaks conditional-write models where the step
  doesn't write every pixel — a real correctness regression).
Neither is a "Wave 1 quick win." Revisit alongside Wave 2 or as part of a wider
worker-protocol rework if it shows up as a genuine bottleneck in the benchmark suite.

**#6 — OffscreenCanvas via `transferControlToOffscreen`.** Larger UX-touching change
than the plan implied: GIF capture, screenshot export, and brush-cursor drawing all
currently assume main-thread canvas access. Net step-time win is zero (it just shifts
work off the main thread). Defer until UI-jank-under-load becomes a felt problem,
which Wave 2 (WASM) may also alleviate.

---

## 4. Wave 2 — WebAssembly Compile Target (chosen, conditional)

**The bet:** the JS JIT is leaving 3–5× on the table for compute-heavy loops; predictable
AOT-compiled WASM closes that gap. All features preserved.

### Approach

1. Define a small **typed IR layer** between the React Flow graph and the emitter — same
   data the current `compile()` consumes, but explicitly typed (so emitter can pick
   i32/f64/etc.).
2. Add a `compileWasm()` per node alongside the existing `compile()`. Initially just the
   hot ones (GetNeighborsAttribute, SetAttribute, Aggregate, GetConstant, branching/switch,
   math); fall back to "this node disables WASM mode" for any node not yet ported.
3. Emit WAT (text), pass through `wabt.js` or a hand-written minimal binary encoder
   (~30 KB; full wabt is overkill).
4. `WebAssembly.compile()` at edit time (debounced); `WebAssembly.instantiate()` in the
   worker.
5. Worker calls the exported `step` function instead of the JS one. Same params (typed
   array views over WASM linear memory).
6. Grid storage: cell attribute arrays live in WASM linear memory. JS holds typed-array
   views over that memory for paint, save/load, color writeback.
7. Indicators live in WASM memory too; JS reads them after each step.
8. Settings toggle: `"Compile target: WASM (default) / JS (debug)"`. Default on. JS path
   remains for debug.

### What changes for the user

**Invisible:**
- Graph editor, all panels, all node configs, file formats (`.gcaproj`, `.gcastate`) — unchanged.
- Simulation results bit-identical to JS.
- All node types, all sync/async modes (incl. random-order/random-independent/cyclic),
  indicators (standalone + linked), macros, save/load state, paint, image import,
  presets — all preserved.
- Bundle size: ~30–50 KB for the WAT/binary emitter. Negligible.

**Visible:**
- **Edit-time compile latency** — `WebAssembly.compile()` is slower than `new Function()`.
  Imperceptible on small graphs; potentially 50–200 ms pause when committing edits to
  very large graphs. Mitigated by debouncing graph→compile (already done for soft
  recompile) and compiling in a worker.
- **Show Code panel** (`buildFullCode()` in SimulatorView) — keep showing the JS form for
  readability with a "running as WebAssembly" note. Toggle to view WAT can come later.
- **Debug fallback toggle in settings** — "Use WASM compiler" (default on). Critical
  because WASM debugging is materially worse than JS.
- **First-time edit-time perception** — very-large-graph editors might briefly notice the
  extra compile time. Worth profiling and deciding whether to ship a "compiling…" indicator.

### Skipped within Wave 2 (revisit if needed)

- **WASM-SIMD** — additional 2–4× on some ops. Worth revisiting if Wave 2 lands and we
  still want more.
- **Streaming compilation / `compileStreaming`** — only matters at very large graph
  sizes; revisit if perceived latency is an issue.

---

## 5. Deferred Options (reference for future revisit)

These were explored and **declined** for the reasons in §1. Captured here in full so the
analysis doesn't have to be redone if priorities shift.

### Option B — WebGL2 fragment-shader compute

**Approach:** Cell attributes stored as textures. Each step renders a full-screen quad to
a target texture; fragment shader reads neighbors from source texture, writes new state.
Ping-pong source/target.

**Pros**
- Massive parallelism — 10–100× on simple sync rules at large grids
- Broad browser support (WebGL2 is universal except very old Safari)
- Color writeback is essentially free — the simulation result IS the texture you display

**Cons**
- Needs a graph→GLSL transpiler (separate compiler backend, 4–6 weeks)
- **Async mode CANNOT be expressed** — fragment shaders have no order-dependent execution
- **SetNeighborhoodAttribute / SetNeighborAttributeByIndex CANNOT be expressed** — no atomics or scattered writes
- Indicator aggregation needs separate reduction passes (multi-pass shader reductions or readback to CPU)
- Switch with many cases / dynamic control flow has high register pressure
- Texture format limits — float attrs need RG32F textures; integer types need careful packing
- Paint and image-import need rework (must write to GPU textures, not JS arrays)
- Debugging shaders is much harder than debugging JS

**Why declined:** explicit feature loss for 2–3 node types and async mode.

### Option C — WebGPU compute shaders

**Approach:** Like B but compute shaders with workgroup atomics and shared memory.

**Pros over B**
- Atomic operations enable indicator counting on GPU (no readback per step)
- Compute shaders are more flexible — no need to reframe everything as a render
- Workgroup shared memory unlocks faster neighborhood patterns
- Cleaner API for general compute

**Cons vs B**
- **Browser support:** Chrome/Edge stable; Safari 18+ partial; Firefox behind a flag.
  Users on Firefox/older Safari hit fallback.
- Same async / neighbor-write limitations as B
- Newer API, less battle-tested tooling

**Why declined:** Chrome-first deployment violates UX homogeneity. Same feature loss as B.

### Option D — SharedArrayBuffer + multi-worker (sync only)

**Approach:** Cell arrays as SharedArrayBuffer. N workers (one per core). Divide grid
into horizontal strips. Each runs the same compiled step on its strip. Atomics-based
barrier between generations.

**Pros**
- Linear-ish speedup with cores (4–8× typical desktop)
- **Reuses existing JS compiled step** — no new compiler backend
- Compounds with Wave 1 wins and with Wave 2 (WASM)

**Cons**
- Requires `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` headers.
  **GitHub Pages does NOT serve these.** Hosting becomes harder (Cloudflare Pages,
  Netlify, custom worker, or `coi-serviceworker` shim — each has caveats)
- Async mode is fundamentally sequential — no parallelism possible
- Strip boundaries need a 1-cell halo; arbitrary neighborhoods (not just Moore) make
  halo computation fiddly
- Per-step worker sync overhead — barriers + edge-row coherency
- Indicator aggregation needs cross-worker reduction
- Doesn't help small grids (sync overhead > work)

**Why declined:** GitHub Pages hosting requirement vs. COOP/COEP needs. Async mode
doesn't benefit. Could revisit if hosting moves and async perf is acceptable to leave
out.

### Option E — Hybrid auto-routing

**Approach:** Static analysis classifies the graph at compile time. Route to the best-fit
backend: simple sync → GPU, complex/async → WASM, debug → JS.

**Pros**
- Best perf for each model class
- Async and edge-case features keep working
- Lets you ship Option A first, Option C later, without forcing migration

**Cons**
- Maintenance: 2–3 compiler backends to keep in lockstep
- Bugs may differ between backends — debugging story complicates
- Auto-routing rules need ongoing tuning as features land
- Initial design work to define routing predicates

**Why declined:** Only makes sense as an end-state once one of B/C is shipped. Premature.

### Option F — Spatial partitioning / dirty regions

**Approach:** Track which cells changed last generation. Only process active regions.
Tile the grid; skip "settled" tiles entirely.

**Pros**
- Massive speedup for sparse models (Game of Life late-stage, settled patterns,
  isolated activity)
- Pure CPU optimization, no new backend, stacks with everything else
- Implementation is fairly local

**Cons**
- **Useless for dense-activity models** (turbulence, full-grid stochastic models — common in CA research)
- Bookkeeping overhead can be net-negative for small grids or always-active models
- Adds complexity to async mode (which has its own ordering)
- Doesn't address the "5000×5000 always-active rule" target

**Why declined:** Doesn't help the targeted bottleneck (advanced models with dense
activity). Worth keeping in mind as an opt-in mode if a specific model archetype demands
it.

---

## 6. Comparison Matrix

| Option | Speedup ceiling | Effort | Browser compat | Async preserved | All nodes preserved | Hosting impact |
|---|---|---|---|---|---|---|
| Wave 1 (micro-opts) | 2–4× | days | universal | yes | yes | none |
| Wave 2 (WASM) | 3–5× (×SIMD: ×2-4 more) | weeks | universal | yes | yes | none |
| B. WebGL2 | 10–100×* | many weeks | universal | **no** | **no** (async, neighbor-write) | none |
| C. WebGPU | 10–100×* | many weeks | Chrome-first | **no** | **partial** | none |
| D. SAB multi-worker | 4–8× | weeks | needs COOP/COEP | **no** | yes | **breaks GitHub Pages** |
| E. Hybrid routing | depends | overhead on top of A+C | inherits | inherits | inherits | inherits |
| F. Sparse/dirty regions | model-dependent | weeks | universal | partial | yes | none |

*GPU speedups assume the model is GPU-eligible.

---

## 7. Re-evaluation Triggers

Conditions under which a deferred option would be worth revisiting:

- **Option B/C (GPU)** — if the user is willing to drop async mode + neighbor-write nodes
  for a specific simulation context (e.g. a "performance preset" for sync-only models).
  Or: if WebGPU support reaches Firefox/Safari stable AND atomics enable async-mode
  emulation that's fast enough.
- **Option D (SAB multi-worker)** — if hosting moves off GitHub Pages, OR if a
  `coi-serviceworker` shim turns out to work reliably across the supported browser
  matrix. Requires async-mode users to accept single-threaded fallback.
- **Option E (hybrid routing)** — only relevant once one of B/C/D is shipped.
- **Option F (sparse regions)** — if a specific model class repeatedly hits performance
  walls AND that class is sparse-activity. Could ship as opt-in per-model setting.
- **WASM-SIMD** (extension of Wave 2) — if Wave 2 lands and aggregate/neighborhood ops
  remain the bottleneck.

---

## 8. Benchmark Log

Standardized suite, run before/after each wave. Update this table as measurements come in.

**Status:** Wave 1 has landed (compiled output verified via Show Code; smoke test on
500² Game-of-Life-derived model ran 1000+ generations cleanly). Numbers below are pending
— need to pick the complex/async benchmark models first, then take baseline measurements
on the prior commit and post-Wave-1 measurements on this commit.

**Models in the suite:**
- *Game of Life* — sync, simple, neighbor-read only
- *(TBD)* — representative complex sync model with multiple neighborhoods, indicators, switch
- *(TBD)* — async model with neighbor writes (e.g. mass-conserving particle model)

| Model | Grid | Baseline (pre-Wave-1) | After Wave 1 | After Wave 2 |
|---|---|---|---|---|
| GoL | 1000² | _TBD_ | _TBD_ | _TBD_ |
| GoL | 2500² | _TBD_ | _TBD_ | _TBD_ |
| GoL | 5000² | _TBD_ | _TBD_ | _TBD_ |
| Complex sync | 1000² | _TBD_ | _TBD_ | _TBD_ |
| Complex sync | 2500² | _TBD_ | _TBD_ | _TBD_ |
| Complex sync | 5000² | _TBD_ | _TBD_ | _TBD_ |
| Async | 1000² | _TBD_ | _TBD_ | _TBD_ |
| Async | 2500² | _TBD_ | _TBD_ | _TBD_ |

**Metrics per cell:** ms/step at steady state. Also track gen/sec headline number, paint
latency on 5000², and peak memory.

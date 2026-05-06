# GenesisCA — Optimizations for Huge Grids

This document captures three known memory-scaling techniques that would let
GenesisCA push grids well beyond the current ~5000×5000 ceiling on WebGPU.

It is a **deferred-work reference** — none of these are implemented today.
Each is well-established in the wider GPU compute / cellular-automata
literature; the trade-offs and design notes here are project-specific.

**Audience:** future-self / contributors when the next "I want a 10,000² grid"
question lands and the v1 WebGPU layout starts hitting buffer limits.

---

## 1. Where the limits live today

Three independent ceilings stack up:

| Limit | Where | Typical value |
|---|---|---|
| JavaScript heap (worker) | V8 (Chromium) | ~4 GB on 64-bit; lifted by Electron `--max-old-space-size` |
| GPU storage buffer | `adapter.limits.maxStorageBufferBindingSize` | 128 MB default; up to 2 GB on modern adapters |
| GPU VRAM | physical card | 1-2 GB (integrated) / 8-24 GB (discrete) |

On the WebGPU path, the GPU buffer ceiling typically bites first. Concrete
examples from the current layout (`src/modeler/vpl/compiler/webgpu/layout.ts`):

| Resource | Formula | 1000² | 5000² | 10000² |
|---|---|---|---|---|
| Per-attribute buffer (read) | `cells × 4 B` | 4 MB | 100 MB | 400 MB |
| Per-attribute buffer (write) | `cells × 4 B` (sync ping-pong) | 4 MB | 100 MB | 400 MB |
| Colors buffer | `cells × 4 B` | 4 MB | 100 MB | 400 MB |
| Neighbor index table — Moore (8 nbrs) | `cells × nbr_size × 4 B` | 32 MB | 800 MB | 3.2 GB ❌ |
| Neighbor index table — MNCA (~360 nbrs) | `cells × nbr_size × 4 B` | 1.4 GB ❌ | 36 GB ❌❌ | n/a |

The neighbor index table dominates on any model with non-trivial
neighborhoods, and it grows linearly in both grid size *and* neighborhood
size. That's the single biggest target.

---

## 2. Optimization paths (highest payoff first)

### 2.1 Implicit / sparse neighbor lookup

**Idea.** Stop storing a per-cell neighbor index table. The current layout
precomputes `total × nbr_size` 4-byte indices (the table that can hit 36 GB
above). For *every* lattice neighborhood — Moore, von Neumann, MNCA's
multi-radius rings, custom user offsets — the neighbor of cell `(r, c)` at
offset `(Δr, Δc)` is purely a function of `(r, c)` and `(Δr, Δc)`. Boundary
treatment (torus wrap, constant sentinel) is also a function of those plus
the boundary mode flag.

**What to store instead.** Just the offsets — `nbr_size × 8 B` (a `vec2<i32>`
pair per neighbor). Total per-model size: a few KB regardless of grid size.

**What the shader does.** At each cell, compute `nbrIdx = wrap(r + Δr) ×
width + wrap(c + Δc)` (or the constant-boundary variant) for each neighbor,
inline. Two integer ops per neighbor lookup vs one global memory fetch from
a multi-GB buffer.

**Savings.** Catastrophic on the neighbor table — the 3.2 GB at 10000² Moore
becomes ~64 bytes total. The 36 GB MNCA case becomes ~3 KB. The buffer
disappears entirely.

**Cost.**
- Per-neighbor lookup goes from a single memory read to ~5 integer ops
  (modulo, add, multiply). On modern GPUs, ALU is faster than global memory
  for cold reads, so this is often *also* a perf win.
- Boundary modes need a branch (or branchless `select(...)`) per neighbor.
  Small but non-zero shader complexity.
- User-defined irregular neighborhoods (uncommon but supported by the
  Neighborhoods panel) still work — the offsets are just a longer list.
  Doesn't break the abstraction.

**Implementation notes.**
- Neighbor offsets fit in a small `array<vec2<i32>>` per neighborhood,
  uploaded once at compile time alongside model attrs.
- The `getNeighborAttribute` family of nodes already operates by index;
  swapping the index source from "table fetch" to "computed" is a per-node
  emitter change.
- Boundary mode can be baked into the shader at compile time (one shader
  per `(boundary, sync)` combo) or branched at runtime via the model-attrs
  uniform.

**Estimated effort.** Medium — touches every neighbor-reading WGSL emitter
in `src/modeler/vpl/compiler/webgpu/compile.ts`, plus the layout / upload
helpers in `webgpuRuntime.ts`. Roughly the size of the array-emitter pass
(commit `7d9dec4`).

**Headline result.** 5000² → 10000² becomes feasible on adapters that can't
allocate the index table today.

---

### 2.2 Tile-based dispatch with workgroup-shared memory

**Idea.** Standard GPU stencil pattern. Today's step shader dispatches one
thread per cell, and each thread independently fetches its `nbr_size`
neighbors from global memory. Adjacent threads in the same workgroup
overlap heavily — a 16×16 workgroup with a 3×3 neighborhood reads each cell
~9 times across the workgroup.

**What changes.** Each workgroup loads a tile of cells (e.g. 16×16) plus a
halo (the neighborhood radius around the tile) into `var<workgroup>` shared
memory in one cooperative pass. Then every thread reads its neighbors from
shared memory instead of global memory. Bandwidth goes down by roughly the
neighborhood-overlap factor.

**Savings.** Doesn't shrink any buffer — this is a *throughput* optimization
that lets you hit higher framerates at any given grid size, or run the same
framerate with a less-capable GPU. On Wireworld-class models (small
neighborhood, light per-cell work) the win is small. On MNCA-class models
(huge neighborhoods, lots of overlapping reads) the win is large.

**Cost.**
- Workgroup-shared memory is bounded
  (`adapter.limits.maxComputeWorkgroupStorageSize`, typically 16 KB - 32 KB).
  Big neighborhoods × multi-attribute models force smaller tiles, which
  reduces the overlap-amortization win.
- Halo loading needs careful indexing for boundary tiles.
- Shader complexity goes up significantly. The current single-thread-per-
  cell pattern is much easier to maintain.

**When to do this.** After §2.1 — the index-table problem dominates. Tiling
won't help if you can't even allocate the buffer in the first place.

**Implementation notes.**
- Per-attribute tiles: each attribute the rule reads needs its own
  workgroup-shared array. Multi-attribute models scale shared memory linearly.
- Probably worth gating per-shader: only tile when neighborhood size and
  per-cell read count justify it (compile-time decision based on graph
  analysis).
- Different tile sizes for different models — square (16×16) for Moore,
  longer tiles for MNCA-style annular neighborhoods.

**Estimated effort.** High — most invasive of the three. The step shader
becomes meaningfully different in shape.

**References.** Hwu/Kirk *Programming Massively Parallel Processors*,
chapter on stencil computations. NVIDIA's CUDA Conway's Game of Life
samples. Lattice-Boltzmann fluid solvers use the same pattern.

---

### 2.3 Sub-word packing for bool / small-tag attributes

**Idea.** WGSL storage buffers can't hold `array<bool>`, `array<u8>`, or
`array<u16>` — the smallest scalar storage type is `u32` (4 bytes). Today
each bool cell occupies a full u32, wasting 31 bits per cell. Same for tag
attributes with small option counts (a 4-option tag fits in 2 bits but
takes 32).

**Two granularities.**

| Approach | Cells per u32 | Memory saving | Read cost | Write cost |
|---|---|---|---|---|
| Byte packing | 4 (bool) | 4× | 1 shift + mask | atomic CAS or 4-aligned write |
| Bit packing | 32 (bool) | 32× | 1 shift + mask | atomic CAS |

For bools, bit packing wins on memory but write atomicity is fiddly:
neighboring threads writing to the same word need a CAS loop, since
atomic-OR/atomic-AND with a mask doesn't compose as cleanly when mixed
with read-modify-write. Byte packing avoids the CAS — each thread writes
a full byte aligned to a position in the u32 — at the cost of 8× less
saving.

**Generality concern (and why it's not actually narrow).** This isn't a
"models with one bool only" optimization — it's a *layout* choice applied
per attribute, transparently to the rule designer. A model with 5 bool
attrs gets the saving on each one. A model with 0 bool attrs doesn't get
it (and isn't penalised). The same machinery generalises to small-cardinality
tag attributes: a 4-option tag attr packs 16 cells per u32 (2 bits each).

**Where it does and doesn't help.**
- **Helps:** any model with one or more bool / small-tag attrs.
  GoL (1 bool: alive). Wireworld (1 tag with 4 options: empty/wire/head/tail).
  Coagulation (1 bool). Most "alive/dead state" rules.
- **Doesn't help:** float / int / large-cardinality-tag attrs. Those need
  their full bits and can't be compressed below u32.

**Cost.**
- Compiler complexity: the per-attribute emit needs to know which
  packing each attr uses and emit shift/mask code accordingly. Not a model-
  shape special case but it IS another dimension in the layout matrix
  (currently every attr is "u32 per cell"; with packing there'd be 3-4
  layout flavours).
- Write semantics: bit-packed writes need atomic CAS to be race-free in
  sync mode. This pushes complexity into every `setAttribute(boolAttr)`
  emission. Byte packing avoids this.
- The per-cell copy preamble (current step shader prefix) becomes
  block-level: instead of one `attrsWrite[idx] = attrsRead[idx]` per cell,
  you'd copy entire u32 words atomically. Cleaner overall.

**Recommended starting point.** Byte packing only, restricted to bool
attrs. 4× saving with minimal shader complexity, no atomic CAS, no
generality drop. Bit packing and small-tag packing can be added later if
the 4× isn't enough.

**Estimated effort.** Medium — the layout and per-attr emit pattern are
already abstractable (`WebGPULayoutAttr` describes each attr's offset and
size). Adding a `packing: 'word' | 'byte' | 'bit'` field per attr +
shift/mask in the read/write emitters is the bulk of the work.

**Why u32 today (the constraint that's not GenesisCA-specific).** WGSL
spec, §6.3 Storable Types: storage buffer element types must be `i32`,
`u32`, `f32`, plus optionally `f16`/`atomic<u32>`/`atomic<i32>`/structs of
those. There's no `u8`, `u16`, or `bool`. The 4-byte minimum is a
WebGPU-level constraint that every WebGPU-using app accepts. So "send it
as a boolean" isn't an option in any architecture; the choice is always
"how many bools per u32."

---

## 3. Combined impact (rough order-of-magnitude)

Take the worst current case: MNCA-style model (~360-cell neighborhood) at
5000². Today's WebGPU footprint:

| Resource | Current | After §2.1 | After §2.1 + §2.3 (bool packing, hypothetical) |
|---|---|---|---|
| Neighbor index | 36 GB ❌ | ~3 KB | ~3 KB |
| Per-bool-attr | 100 MB | 100 MB | 25 MB |
| Per-int-attr | 100 MB | 100 MB | 100 MB |
| Total (1 bool + 1 int + colors) | 300 MB+ | ~204 MB | ~129 MB |

The neighbor-table compression (§2.1) is the breakthrough — without it,
huge-neighborhood models simply can't run on most adapters. The bool
packing (§2.3) is a nice 4× on top, only relevant after §2.1 unblocks the
basic case.

§2.2 (tiling) doesn't change the table; it changes per-step throughput.

---

## 4. Order of attack (when and if this becomes a priority)

1. **§2.1 first.** Largest absolute win, single biggest unblocker for huge
   grids on indicator-light hardware. Doesn't change the user-facing
   experience or any rule semantics.
2. **§2.3 second.** Independent of §2.1. Comfortable headroom for grids
   beyond what §2.1 alone allows. Affects only the layout/codegen, not the
   rule designer's view.
3. **§2.2 last.** Throughput / framerate win, not a memory-ceiling win.
   Adds significant shader complexity for a smaller payoff than the first
   two. Skip unless huge grids are actually working but slow.

Before any of this lands, run the existing benchmark suite (see
`PERFORMANCE_OPTIMIZATION_PATHS.md` §8) at the target grid size on the
target hardware to confirm which ceiling is actually being hit.

---

## 5. Out of scope

These are intentionally NOT in this doc:

- **HashLife-style hierarchical chunking** for sparse / repetitive
  patterns (works only for binary-state CAs with known stable templates;
  doesn't fit the general-purpose layout).
- **Multi-GPU dispatch / SLI.** WebGPU spec exposes one adapter at a time;
  no portable multi-GPU path exists today.
- **Off-loading compute to a server.** Out of scope per the all-client
  constraint.
- **Native rewrite (Rust + wgpu / native compute kernels).** A separate,
  much larger project.

---

## 6. References

- [WGSL spec §6.3 Storable Types](https://www.w3.org/TR/WGSL/#storable-types)
- [WebGPU spec — Adapter Limits](https://www.w3.org/TR/webgpu/#supported-limits)
- Hwu, Kirk, El Hajj — *Programming Massively Parallel Processors*, 4th ed.
  (chapters on tiled stencil patterns)
- GPU Gems 3, Chapter 37 — Game-of-Life-style cellular automata on the GPU
- Lattice-Boltzmann GPU implementations — same neighbor-overlap-tiling
  pattern (e.g. NVIDIA's open-source LBM samples)
- HashLife and related techniques — Bill Gosper's original 1984 paper, and
  Tomas Rokicki's modern HashLife implementations (for context only — not
  proposed for adoption here)

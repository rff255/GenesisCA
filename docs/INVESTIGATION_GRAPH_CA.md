# Investigation — Graph Cellular Automata mode for GenesisCA

> **Status:** feasibility study + literature review + subsystem Impact Map. This is the *precursor* to a formal plan, not a commitment to build. No code has changed. Per the project's "Illustrated plans required for UI/behavior changes" rule, the formal `PLAN_GRAPH_CA.md` + HTML mockup come *after* the scope decisions in §12 are made.
>
> **How this was produced:** multi-agent research workflow — 6 web-research literature topics each independently fact-checked (citations confirmed against arXiv/DOI/publisher), 5 codebase subsystem deep-reads, a synthesis pass, and an adversarial critique. The two load-bearing codebase claims (`topology` is dead data; `NodeRequirements = {async?, variegated?}`) were also verified firsthand. Citation reliability is noted in §2.9.

---

## 1. Executive summary

**The ask:** add a **Graph mode** to GenesisCA — a new optional model mode (like Variegated Cells or Asynchronous update) that swaps the substrate from a fixed 2D lattice to an **arbitrary graph**: cells become graph nodes, each with a *variable-degree* neighborhood (an adjacency set of any size), and the mode enables a graph-specific node/feature set while gating off lattice-only ones.

**The single most important finding (from the literature):** on an irregular graph, a homogeneous update rule **cannot be positional**. A lattice rule `τ: Σ^(d+1) → Σ` takes a *fixed* number of *ordered* arguments ("the cell to my left", "neighbor #3"). An arbitrary graph gives you neither a fixed count (degree varies node to node) nor a canonical order (no left/right/up/down). So every well-defined graph-CA rule must consume neighbors through an **order-independent, degree-tolerant aggregate** — count, sum, **density (sum ÷ degree)**, mean, max/min, threshold/majority — *not* through fixed slots (Marr & Hütt 2009; Grattarola et al. 2021).

**Why this is good news for GenesisCA specifically:** the app's core neighbor-reading idiom is *already* aggregate-based. `GetNeighborsAttribute → Aggregate (Sum/Average/Max/Min/Count)` is exactly the degree-robust pattern the literature prescribes, and the runtime already reads neighbors through an **opaque flat index table** (`nIdx_<nbr>[idx*nSz + n]`), not coordinate math, in its hot loop. The lattice is *implicit*, not deeply wired into the rule evaluation. The graph-unsafe nodes are a clearly delimited minority (offset/position nodes, variegated orientation) that the existing capability-gate (`NodeTypeDef.requirements`) can disable with one new flag.

**The real work is in three places, not the rule evaluation:**
1. **The engine's neighbor representation** — replace the dense `total × nSz` rectangular index table with a **CSR (compressed-sparse-row) ragged adjacency** (`rowOffsets[N+1]` + `colIndices[E]`), and change the compiled per-cell loop bound from a constant `nSz` to a data-dependent `rowOffsets[idx+1] - rowOffsets[idx]`. This is a cross-target change (JS / WASM / WebGPU in lockstep).
2. **A separate graph-view renderer** — the lattice path's whole speed comes from blitting *one* `ImageData` for the entire grid; that is fundamentally incompatible with per-node drawing. The per-cell `colors` buffer and the index-keyed inspect/paint protocol are reused as-is; the 2D-bound code (the `ImageData` blit, `row*w+col` picking, the geometric brush) gets a sibling graph code path chosen by topology.
3. **A topology data model + editor** — there is *no* place in the schema today for adjacency or node positions (only `gridWidth/gridHeight`), and the `topology` field is **dead data** (declared, saved, never branched on). Graph mode must introduce the topology branch that does not currently exist.

**Recommended scope (see §11 for phasing):**
- **MVP (Phases 1–3):** static, undirected graph; count/density/aggregate rules only; JS + WASM targets; fixed/precomputed node coordinates rendered on Canvas2D; generators (ring, lattice, ER, Watts–Strogatz, Barabási–Albert) + edge-list import. This delivers the headline capability — *"hold the rule fixed, swap the topology, watch the dynamics change"* — which is a genuine differentiator for a CA IDE.
- **Phase 4–5:** force-directed layout (off-main-thread), GPU-instanced rendering for large graphs, WebGPU compute target, GraphML/GEXF round-trip.
- **Phase 6 (separate, ambitious):** **Structurally Dynamic CA** — rules that mutate the topology itself (add/remove edges). This is a different beast (mutable adjacency, conflict semantics) and should be a deliberate, separate decision.

---

## 2. Literature foundations (the deep dive)

Graph Cellular Automata (GCA), also called *cellular automata on graphs* or *network automata*, have a 40-year literature spanning four loosely-connected lineages: (a) the **formal CA-on-graphs** tradition (Wolfram → Marr & Hütt), (b) **automata networks / Boolean networks** (Kauffman, Goles–Martínez), (c) **structurally dynamic** CA where the graph rewires itself (Ilachinski–Halpern), and (d) the modern **learned / message-passing** view (Grattarola et al., building on GNNs and Neural CA). They all converge on the same structural principle. Below, organized by the questions that matter for implementation.

### 2.1 A lattice is just a special-case graph

A classical CA is the 4-tuple `(D, Σ, N, τ)`: a regular lattice domain `D`, a finite state alphabet `Σ`, a fixed neighborhood template `N` (von Neumann d=4, Moore d=8), and a transition function `τ` applied homogeneously and synchronously everywhere. A regular grid is a **degree-regular, vertex-transitive graph** — every vertex has identical local structure. GCA replace `D` with an arbitrary graph `G=(V,E)`; node *i*'s neighborhood becomes its adjacency set `{j | {i,j} ∈ E}` and its degree `dᵢ = |neighborhood|`. Everything that "just works" on a lattice — fixed arity, a canonical neighbor order, the same local structure at every cell — is a *coincidence of regularity* that an arbitrary graph does not provide (Marr & Hütt 2009; O'Sullivan 2001).

### 2.2 The central problem: variable degree + no canonical order ⇒ rules must be aggregate-based

This is **the** definitional obstacle and it dictates the whole node-set design.

- **Variable degree.** `τ: Σ^(d+1) → Σ` takes a fixed number of positional arguments. With different `dᵢ` per node a single positionally-indexed homogeneous rule cannot even be written down.
- **No canonical order ("anonymity" / permutation invariance).** A graph node has no left/right/up/down. A homogeneous graph rule must be invariant to any permutation of its neighbors — it can only depend on order-independent functions of the *multiset* of neighbor states. Marr & Hütt call this **isotropy**; the GNN literature calls it **permutation-invariant aggregation** (Grattarola et al. 2021; Gilmer et al. 2017).

**The canonical resolution (Marr & Hütt 2009):** make the rule a function of the **neighbor-state density** `ρᵢ(t) = (1/dᵢ) Σⱼ Aᵢⱼ xⱼ(t)` rather than of individual positional inputs. Three constraints define a GCA rule: *Homogeneity* (one rule for all nodes), *Isotropy* (depends only on `ρ`), *Functional simplicity* (piecewise-constant in `ρ`). **Dividing the neighbor sum by the local degree `dᵢ` is the device that makes a rule degree-portable** — the same threshold means the same thing at degree 3 and degree 30. Without it, a raw count threshold silently changes behavior across the degree distribution.

This yields the rule taxonomy that maps directly onto GenesisCA's node palette:

| Rule family | Definition | GenesisCA mapping | Graph-safe? |
|---|---|---|---|
| **Totalistic** | next state = f(neighbor total/density) only | `GetNeighborsAttribute → Aggregate(Sum/Count/Average)` | ✅ inherently |
| **Outer-totalistic** | f(neighbor total, own state) — e.g. Game of Life | same + a `GetCellAttribute` on self | ✅ inherently |
| **Threshold / majority** | single cutoff κ on density `ρ` | density → `Compare ≥ κ` | ✅ (needs density node) |
| **Normalized / averaged** | density = sum ÷ degree | `Average`, or a new `NeighborDensity` node | ✅ (the portability device) |
| **Fixed-arity / offset / lookup-table** | f(neighbor *at slot k*); anisotropic weights | `GetNeighborAttributeByIndex`, neighborhood tags, variegated faces | ❌ **must be gated off** |

For d=2 the (α,β,γ) parametrization (each ∈ {0,1,+,−} = force-0/force-1/keep/flip over densities ρ∈{0,½,1}) recovers exactly the **64 outer-totalistic ECA rules**; the 0/1-exchange symmetry `T: ξ↦1−ξ` collapses them to **34 distinct rules**, of which **14 are "topologically sensitive"** and **4 (ECA 37, 108, 109, 133) change Wolfram class** when a regular ring is randomized (Marr & Hütt 2009 — all four facts verified verbatim from the source). *Those four are the ready-made demo seeds for a "hold rule, swap topology" feature.*

### 2.3 The message-passing view validates the aggregate node design (GNCA)

Grattarola, Livi & Alippi, *Learning Graph Cellular Automata* (NeurIPS 2021), recast a GCA step as **one round of GNN message passing**: each node updates from `(its own state, a PERMUTATION-INVARIANT aggregation of neighbor messages)` — i.e. `gather neighbor states → order-independent aggregate → update`. They prove a GNN-parametrized update can represent *any* discrete-state GCA, and explicitly note **GCA generalize grid CA the way GNNs generalize CNNs**. This is the same anonymity/aggregation principle as Marr & Hütt, recast for arbitrary degree, and it tells us GenesisCA's `GetNeighbors → Aggregate → update` pipeline is not just *a* way to write graph rules — it is *the* general form. (Lineage: Mordvintsev et al., *Growing Neural Cellular Automata*, Distill 2020, for the per-cell-NN CA idea; Gilmer et al. 2017 for the message-passing/aggregation formalism; Gala et al. 2024 for the E(n)-equivariant extension.)

**Design takeaway:** treat the graph-CA step explicitly as a **segmented reduction whose per-segment operator is the compiled transition function** (see §2.8). This reuses the existing "compile the node graph once, run per cell" pipeline verbatim — only the neighbor-iteration preamble changes.

### 2.4 Automata networks, Boolean networks, and processes-on-networks

The broader frame: an **automata network** is a graph of finite-state entities each updating by a local rule over its neighbors. Homogeneous + isotropic ⇒ GCA; allowing *per-node individual* (and directed) rules ⇒ Kauffman's **Random Boolean Networks** (RBN, 1969) — the heterogeneous-rule limit GCA give up to stay homogeneous. **Threshold automata networks** have deep dynamical results (Goles & Olivos 1980 period bounds; Goles & Martínez 1990). On complex topologies, Boolean dynamics differ sharply by structure (Aldana 2003, scale-free).

Many famous "dynamical processes on networks" are graph CA in disguise and make compelling sample models: **epidemic spreading** SIR/SIS (Pastor-Satorras & Vespignani 2001; survey Pastor-Satorras et al., Rev. Mod. Phys. 2015), the **voter/opinion model** (Sood & Redner 2005), and **Conway's Life redefined on a network** (Kayama & Imamura 2013; cf. Bak–Chen–Creutz 1989 self-organized criticality in Life). The classic generator families — **Erdős–Rényi** random (1960), **Watts–Strogatz** small-world (1998), **Barabási–Albert** scale-free (1999) — are exactly the dynamically-distinct classes the CA-on-graphs literature studies, so they're the right built-in generators (Newman 2003 survey).

**Update schemes matter more on graphs.** Synchronous vs asynchronous update can change attractors/dynamics, and the effect is more pronounced on irregular topologies (Gershenson 2004; Paulevé & Sené 2022). GenesisCA already has synchronous and three asynchronous schemes — they carry over conceptually, but async on a graph needs care (see §2.5, §5).

### 2.5 Structurally Dynamic CA (dynamic topology) — the ambitious tier

Ilachinski & Halpern, *Structurally Dynamic Cellular Automata* (Complex Systems 1987), make the **connectivity graph itself a dynamical object**. Alongside the value rule there is a **link transition rule** `λᵢⱼ^(T+1) = ψ(λᵢⱼ^T, σᵢ^T, σⱼ^T)` (`λᵢⱼ ∈ {0,1}` = edge present/absent), decomposed into **couplers** (add edges) and **decouplers** (remove edges). The defining feature is a **dual coupling**: values evolve as a function of the current topology, and topology evolves as a function of the current values. (Accessible primary on-ramp: Halpern, *Sticks and Stones*, Am. J. Phys. 1989 — cells = "stones", links = "sticks".) A second lineage uses SDCA as discrete-spacetime substrates with signed/directed bonds and — critically for us — a **hysteresis trick** to stop edges flickering: a bond turns on above a high threshold and stays on until a low threshold, λ₂ ≥ λ₁ (Nowotny & Requardt 1999, 2006). A modern learning/memory template commits to an explicit adjacency matrix + update operator (Singh 2025).

**The engineering hazard SDCA surfaces (relevant even before we build it):**
- **Synchronous topology mutation requires double-buffering the *topology*, not just the value arrays.** Both rules read the old config (states + adjacency at T) and write the new one at T+1; this makes coupler/decoupler conflicts commute trivially (every rule sees the same frozen snapshot).
- **The value rule must read T's structure while the structure rule reads T's values** — mixing them is a read-after-write hazard *exactly analogous* to GenesisCA's existing async cell-attribute hazard (`asyncWriteHazard.ts`).
- **Asynchronous topology mutation is non-commutative and order-dependent** — a coupler firing at cell *i* changes which neighbors cell *j* sees in the same sweep. This is the topology analogue of the neighbor-write hazards GenesisCA already documents for async.
- **CSR is the *worst* structure for mutation** (edge insert/delete is O(E)). SDCA needs either a dynamic structure (PCSR, CSR++, Hornet — see §2.8) or a delta-log-then-rebuild-to-CSR-at-step-boundary scheme. **This decision must be made consciously in the schema even if we build nothing now** (§4, §12).

> ⚠️ The SDCA-specific mechanics (couplers/decouplers, the coupling/decoupling-threshold detail) inform §7.4's sync-semantics argument. The 1987 Ilachinski–Halpern paper and the dual-coupling framing are confirmed; the encyclopedia entry is by **Ilachinski** (2009), in the Adamatzky-edited *Encyclopedia of Complexity and Systems Science* (the "Adamatzky (ed.)" attribution was corrected). Treat SDCA as a clearly-scoped *future* tier, not MVP.

### 2.6 Topology regulates dynamics — the headline simulator feature

Marr & Hütt's deep result: because the rule stays *formally fixed* while topology varies, dynamical change is attributable to topology alone. Changing the graph (regular ↔ small-world ↔ scale-free ↔ real network) induces transitions between Wolfram complexity classes **with no change to the update rule**. Concrete, verified facts worth shipping as presets: the 34-distinct-rule reduction, the 14 topologically-sensitive rules, the 4 class-changers (ECA 37/108/109/133), and the finding that **complex-pattern capacity peaks around degree d≈4 and decays as the neighborhood grows** (because large degree makes every node see nearly the same density, homogenizing dynamics). The last point is a useful in-app expectation-setter: *denser graphs tend to look "boring."*

### 2.7 Visualization precedent

The state of the art for visualizing dynamical processes on graphs (verified sources in §13):
- **Layout.** Two regimes: graphs *with intrinsic coordinates* (lattices, meshes, geo networks) render directly; *abstract* graphs need a layout pass — force-directed **Fruchterman–Reingold** (1991) or **ForceAtlas2** (Jacomy et al. 2014, with Barnes–Hut O(n log n) approximation). **Run layout once and cache it; never re-layout per generation** — honor the "mental map" stability principle (Misue et al. 1995). Animate only the state-color.
- **Scale.** Canvas2D is fine for design-time and < ~1k nodes; thousands+ needs GPU-instanced rendering. GPU layout+render for the web is demonstrated (GraphWaGu, Dyken et al. 2022; libraries: Sigma.js/regl, Cytoscape.js, Gephi/ForceAtlas2). **Edges are the cost bottleneck** — add level-of-detail (hide edges/labels below a zoom threshold, cluster dense regions).
- **Picking at scale.** Replace coordinate hit-testing with **GPU color-coded picking** (render unique per-node id-colors to an offscreen buffer, read back a small region under the cursor). This keeps brush/selection working independent of node count.
- **Dense graphs.** A **node-link** view is best for sparse/spatial graphs and path-tracing; an **adjacency-matrix** view is more readable for dense graphs (Ghoniem et al. 2004). A per-node **state-history timeline** is a cheap, high-value analysis addition (Beck et al. 2017 dynamic-graph-viz taxonomy).
- **UX risk.** GenesisCA already has a node graph (the VPL rule editor). A topology graph is a *second* graph. **Two graphs is a real conceptual-overload risk** — keep topology editing visually and modally distinct from rule editing.

### 2.8 Performance / data structures — how to "deal with varying neighborhoods"

This is the concrete answer to the user's "deal with varying neighborhoods" question, at the storage/compute layer.

- **Representation: CSR.** Store adjacency as **`rowOffsets: Uint32Array[N+1]` + `colIndices: Uint32Array[E]`** — node *i*'s neighbors are `colIndices[rowOffsets[i] .. rowOffsets[i+1]]`. CSR is the de-facto standard static graph encoding: compact, coalesced sequential neighbor reads, one extra indirection. It is the variable-degree replacement for the fixed-stride `nIdx` table. **Keep the SoA per-attribute typed arrays unchanged** — SoA is the right state layout for graphs too. (Verified: CSR-as-standard + its O(E) edge-insert immobility are textbook; the dynamic-CSR papers exist precisely to fix that.)
- **Compute = SpMV / segmented reduction.** The synchronous graph step is a **pull/gather** (each cell reads neighbor states via `colIndices`, writes only its own `w_` buffer) — no atomics, double-buffers exactly like the current sync lattice step, and maps onto the well-optimized SpMV/segmented-reduction structure. Reserve push/scatter for a future sparse-frontier optimization (overkill for all-cells-update-every-gen CA).
- **The hub problem (load balancing).** Power-law degree (scale-free) means one-loop-per-cell spends nearly all time in a few hub cells, and on GPU causes severe warp divergence. The fix is **merge-path / load-balanced partitioning** into equal-edge-count tiles (Merrill–Garland 2016; Osama et al. 2023; Baxter's Modern GPU). Reordering cell indices for locality at graph-load time attacks the real bottleneck (random neighbor-state gather) more than any format change.
- **Per-target reality.** JS: data-dependent inner loop, scratch sized to **maxDegree**. WASM: single-threaded today, so the merge-path win is smaller but still helps cache; it's the prerequisite for future threads/SIMD. WebGPU: two storage buffers (rowOffsets, colIndices) + the existing attr buffers; **do not rely on subgroup/warp-vote ops** (not in base WGSL); precompute a merge-path tile partition on CPU/WASM and dispatch one workgroup per tile; respect `maxStorageBufferBindingSize` for `colIndices` on large E. **Avoid plain ELLPACK** (max-degree padding) for scale-free graphs — prohibitive waste on a single hub; **SELL-C-σ** is an optional middle ground for moderate degree variance.
- **Parallel async = graph coloring.** Sequential single-buffer async is trivially correct but unparallelizable. To parallelize, precompute a **distance-1 graph coloring** at load time (Jones–Plassmann / Alabandi–Burtscher 2022) and update one color class per sub-pass (red-black/multicolor Gauss–Seidel). Use distance-2 coloring if rules write neighbors-of-neighbors. **Ship sequential async first; add coloring as the parallel fast path.**
- **Mutable graphs (SDCA only).** If the graph can change during a run, plain CSR is unsuitable; use **PCSR** (Packed-CSR, PMA gaps — simplest for CPU/WASM), **CSR++**, or **Hornet** (GPU-resident). If the graph is static once simulation starts (like every current model), plain CSR is strictly better.

### 2.9 Citation reliability note

Of ~40 citations across the six topics, the overwhelming majority are **confirmed** against arXiv/DOI/publisher. Caveats to carry into any published version:
- **Refuted (metadata only, substance intact):** the SDCA encyclopedia entry is by **Andrew Ilachinski** (2009), within the *Encyclopedia of Complexity and Systems Science* edited by Adamatzky (not "Adamatzky (ed.)"). The Towards Data Science explainer is by **"Adam Mehdi," 2022** (not "Adam Mehdi Gabriel," 2021) — a secondary source anyway.
- **Uncertain (could not fully confirm online):** Majercik 1994 M.S. thesis (existence uncertain — drop or soften); Sean Baxter's *Modern GPU* (a real library/doc set, not a peer-reviewed paper).
- **Uncertain claim:** the specific `(0,+,1)` tuple for the majority rule could not be quoted verbatim from Marr & Hütt — present it as illustrative, not as a confirmed entry in the taxonomy.

Full verified bibliography in §13.

---

## 3. Conceptual model — graph CA on GenesisCA's terms

### 3.1 Mapping onto the Six Fundamentals
The model's six theoretical fundamentals survive almost intact; only the spatial ones generalize:

1. **Unlimited per-cell computing power** — unchanged.
2. **N internal attributes / state** — unchanged. A node has the same attribute set; SoA storage is identical.
3. **Cells read only neighborhood states** — generalizes: "neighborhood" = the node's **adjacency set** (variable size) instead of a fixed offset template.
4. **Writability (sync = self only; async = neighbors too)** — unchanged semantically; "neighbor" is now a graph neighbor.
5. **Space & time discrete** — *space* generalizes from "n-dimensional grid" to "nodes of a graph"; time unchanged.
6. **Synchronicity** — unchanged (sync/async schemes carry over; async-on-graph parallelization needs coloring, §2.8).

### 3.2 What replaces "Topology / Boundary / Grid Size"
Today **Properties → Structure** is *Topology (always `2d-grid`) + Boundary Treatment + Grid Size (W×H)*. In graph mode:
- **Topology** becomes a real choice and gains a **graph definition** (node count + adjacency + optional positions), produced by a generator, an importer, or hand-editing.
- **Grid Size** → **Node count** (graph order). `total = N`, decoupled from `W×H`.
- **Boundary Treatment** is *mostly N/A* — a graph either has an edge or it doesn't; there is no wrap/sentinel. A "torus" *generator* bakes wrap into its edges. Graph mode should **pin boundary treatment to a single value** and hide the control (decision needed: does that value imply the `total` or `total+1` sentinel allocation? — see §5, §12).
- **Neighborhoods** are reinterpreted as **edge-types** (see §3.3).

### 3.3 Neighborhoods → edge-types (Option B, recommended)
Today a `Neighborhood` is a named list of `(dr,dc)` offsets, and nodes select a `neighborhoodId`. The cleanest graph analogue keeps that selector working: a **neighborhood becomes a named edge-type** (a relation), and the graph's edges carry an edge-type id. "Get neighbors via neighborhood X" → "get neighbors connected by edge-type X." This lets multiple relations coexist (e.g. "spatial" vs "social" edges) and preserves the existing `GetNeighborsAttribute(neighborhoodId)` wiring.
- **MVP simplification:** a single implicit default edge-type ("Adjacency"). All existing `GetNeighborsAttribute` references bind to it. *Open decision (§12): how the default neighborhood↔edge-type binding is auto-created so existing graphs/macros that reference a `neighborhoodId` keep working.*

### 3.4 Directed vs undirected; positions vs topology
- **Undirected** for MVP (symmetric adjacency). Directed edges (needed for some RBN/SDCA models) are a later flag; CSR already handles directed naturally (just don't symmetrize).
- **Positions are separate from topology** (a key viz decision). Graphs *with* intrinsic coordinates (a generated lattice, an imported geo-net) store positions as data and render directly. *Abstract* graphs run a one-shot layout and **cache the result** in the `.gcaproj`. Never re-layout during playback.

---

## 4. Data model & file format

### 4.1 Schema additions (`src/model/types.ts`)
**Single source of truth for "are we in graph mode":** mirror the `variegatedCells` sub-object pattern — drive everything off `graphTopology?.enabled` (absent === disabled). **Do not** also make the `topology` enum live; that creates two sources of truth and invites drift. Leave `topology` as derived/display, or drop it.

```ts
interface GraphTopologyConfig {
  enabled: boolean;
  directed?: boolean;                 // default false (undirected) for MVP
  nodeCount: number;                  // = total
  // Runtime adjacency, CSR (the simulation-facing form):
  rowOffsets: Uint32Array | number[]; // length N+1, prefix-summed
  colIndices: Uint32Array | number[]; // length E (or 2E if undirected stored both ways)
  maxDegree: number;                  // DERIVED; single source of truth (see 4.4)
  // Optional render coordinates (cached layout or intrinsic):
  positions?: Array<[number, number]>;        // length N
  // Optional edge-types (relations) → neighborhoods:
  edgeTypes?: Array<{ id: string; name: string }>;
  edgeTypeOf?: Uint8Array | number[];          // per-edge type id (omitted = single default)
  // Provenance: regenerate deterministically instead of storing a huge CSR (see 4.3):
  generator?: { kind: 'ring'|'lattice'|'er'|'ws'|'ba'|'import'; params: Record<string, number>; seed: number };
}
// attached additively to CAModel:  graphTopology?: GraphTopologyConfig
```

### 4.2 Serialization (`fileOperations.ts`)
- `stringifyCompact` already inlines `coords`/`graphNodes`/`graphEdges` one-item-per-line; **add `rowOffsets`/`colIndices`/`positions`/`edgeTypeOf` to that inlined-array allowlist** so `.gcaproj` diffs stay clean.
- Large CSR arrays should serialize as **base64 typed arrays** (the `.gcastate` precedent: `arrayBufferToBase64` / `deserializeTypedArray`) rather than JSON number lists, to keep file size sane. (Note the library-precache size guard in `vite.config.ts` — big embedded graphs stay out of the precache like the big sim-states already do.)
- **Bump `SCHEMA_VERSION`** and add a `graphTopology` guard in `createInitialState`. Old loaders ignore the field (additive); new loaders handle absence (= lattice).

### 4.3 Generators + the determinism contract (critical, easy to get silently wrong)
Ship generators mirroring the current Structure panel: **Ring/Lattice, Erdős–Rényi, Watts–Strogatz (rewiring-p), Barabási–Albert (m)** (the dynamically-distinct classes from §2.4). Two storage strategies:
- **Store the realized CSR** (robust, larger file), or
- **Store just `{kind, params, seed}` and rebuild on load** (compact). This requires a **frozen, versioned PRNG**: the same `(seed, params)` must produce a **bit-identical CSR across browsers and across app versions forever**, or saved-as-spec models silently drift on reload. *Pick and pin the PRNG algorithm now.* (Recommendation: store realized CSR for imports/hand-edits; offer "store as spec" only for pure generator output, with a pinned PRNG.)

### 4.4 The `maxDegree` lifecycle (a silent-corruption hazard)
Scratch arrays (`GetNeighborsAttribute`, `FilterNeighbors`) must be sized to **maxDegree**, not a constant `nSz`. A stale `maxDegree` (after Regenerate/Import/edge-edit) **overflows scratch → memory corruption** — the exact class as the historical Amphiphile NI-poisoning bug. Make `maxDegree` a **derived-on-topology-change single source of truth** that (a) recomputes whenever adjacency changes, (b) re-uploads to the worker, and (c) re-bakes into the WASM layout. Specify the invalidation rule explicitly.

### 4.5 Node-id codec vs the `INVALID_NI` sentinel (a collision hazard)
A graph "neighbor index" must reference a neighbor by **node-id / edge-index**, not a packed `(dr,dc)` offset (`niCodec.ts`). But `INVALID_NI = 0x80000000` is itself a valid-looking full-range i32. **Node-ids must be capped below `0x80000000`** so the "no neighbor" sentinel never collides with a real id. Document this next to the codec branch. (5000×5000 = 25M < 2³¹ ≈ 2.1B, so the cap is not a practical limit.)

---

## 5. Engine / worker changes (`sim.worker.ts`, `wasm/layout.ts`)

The saving grace: the hot loop reads neighbors through an **opaque flat index table** (`nIdx_<nbr>[idx*nSz+n]`), so the only compile-time grid coupling at the read site is the **uniform stride `idx*nSz`**. There is no coordinate math in the hot loop to rewrite.

1. **`buildNeighborIndices()` (~L877)** — branch on topology. For `2d-grid`, keep the `row*width+col` + `(dr,dc)` + torus/sentinel arithmetic (the optimal fast path). For graph, **load the model's CSR** into worker memory (typed-array *views* over `wasmMemory`, copied-into not reassigned — the standard discipline) instead of computing offsets.
2. **`total = width*height` → `total = nodeCount`** in `initGrid` (~L751); SoA buffers and `colors` size off `total` already.
3. **Loop-arg convention** — `buildLoopArgs`/`buildCellArgs` (~L937) pass `(nIdx_<nbr>, nSz_<nbr>)` today. Graph mode passes `(nIdx_<nbr>=colIndices, rowOffsets_<nbr>)`. **These have different param *counts*, not just different indexing** — so it is a per-model param-arity branch in *both* the worker and the compiler that must stay in lockstep. Encode it as a **single shared descriptor** consumed by worker + JS + WASM so they cannot drift.
4. **Pull/gather sync step** double-buffers exactly like today (no atomics).
5. **Sentinel** — graph nodes simply list their real neighbors (variable count, no padding); the `+1` constant-boundary sentinel is unneeded for graph mode. Decide `cellsPerAttr = total` (no sentinel) for graph (avoids the `4*(N+1)` byte-length hazard in `deserializeTypedArray`).
6. **Async + coloring** — sequential single-buffer async works unchanged for a flat node set; parallel async needs a load-time graph coloring (§2.8). **Re-examine `asyncWriteHazard.ts` and the accessor-CSE async gate** under graph adjacency — a write to a `colIndices`-addressed neighbor is the same hazard class, and the neighbor-write seeds (`MoveSelfToNeighbor`, `SetNeighborAttributeByIndex`) must resolve correctly under node-id NIs (verify, don't assume).
7. **`attrsStructurallyEqual` reinit guard** — a topology change (Regenerate / new CSR / new nodeCount) is a **structural** change that must force a worker reinit. `graphTopology` fields are *not* in the compared set today, so a "Regenerate" could soft-recompile and run the **old CSR**. Add graph-topology fields to the guard (this directly enables the §11 "hold rule, swap topology" workflow without running stale adjacency).
8. **Sim-state save/load** (`.gcastate` + embedded) — `applySimulationState` validates `gridWidth/gridHeight` match before loading. A graph snapshot has `nodeCount`, not W×H: add a **graph branch to the dim-validation** (reject mismatched `nodeCount` cleanly, no silent abort), ensure `ATTR_TYPE_MAP` coverage, keep the typed-array view-restore discipline, and handle the byte-length/`+1` interaction (point 5 above resolves it by dropping the sentinel for graphs).

---

## 6. Compiler changes (all three targets, lockstep)

Per the compiler-lockstep rule, every neighbor-emit change lands on JS / WASM / WebGPU together and exits on a **byte-shape parity check** via the dev-server compiler-import harness.

1. **Neighbor-loop emit shape** — replace the constant `nSz` inner-loop bound with data-dependent bounds:
   ```js
   const _nb = rowOffsets_<nbr>[idx], _ne = rowOffsets_<nbr>[idx+1];
   for (let _k = _nb; _k < _ne; _k++) { const _ni = colIndices_<nbr>[_k]; /* read r_attr[_ni] */ }
   ```
   Touch every neighbor-iterating emitter: JS `buildFusedAggregateJS`/`GroupOperator`/`GroupCounting`/`GroupStatement` (`compile.ts` ~L128–299), WASM `wasm/compile.ts`, WebGPU `webgpu/compile.ts`. Scratch → maxDegree.
2. **`niCodec.ts` is the deepest lattice coupling and the single chokepoint.** Today an NI *is* a `(dr,dc)` offset and `niCellExprStmts` resolves it via `(row+dr, col+dc)` + W/H modulo. Graph mode redefines NI as a **node-id / edge-index** resolved via `colIndices[offset+k]`. Provide a graph-mode codec module the compilers import based on topology.
3. **Bypass — don't just swap — the W/H literal baking.** WASM `pushNiCellIdx` bakes `gridWidth/gridHeight` literals and recomputes `row=idx/W,col=idx%W`; WebGPU `nbrCellIdxFromNi` bakes `gw/gh` shader literals. In graph mode W/H are synthetic, so these paths must be **fully bypassed**, not just have the decode swapped. (WebGPU additionally must re-introduce an explicit `colIndices` storage buffer — graph mode undoes the §2.1 "compute neighbor from offsets" optimization for the lattice.)
4. **Enumerate every `niCodec` call site to gate** (the critique caught the design under-counting these): `packNI`/`unpackNI`/`niDrExpr`/`niDcExpr`/`FlipNeighborIndex`/`BreakDownNeighborIndex`/`GetAllNeighborIndexes` (offset emit)/the compile-time tag pre-pass. `FilterNeighbors`/`JoinNeighbors` set-identity must use the **node-id** (not the packed offset) for `Set`/`indexOf` dedup, and preserve an `INVALID_NI`-equivalent "no neighbor" sentinel + its guards (`!== INVALID_NI`, `< total`).
5. **Node graph-safety** (which existing nodes survive — see §7 for the full table). Clean: `GetNeighborsAttribute`, `Aggregate`, `GroupOperator/Counting/Statement`, `FilterNeighbors`, `JoinNeighbors`, `PickRandomNeighbor`/`PickNRandomNeighbors`, `ArrayElement`/`ArrayLength`/`ForEachInArray` (shape, not geometry). Break: `GetNeighborAttributeByIndex`/`SetNeighborAttributeByIndex`, `GetAllNeighborIndexes` (offset form), `NeighborIndexFromOffset`, `BreakDownNeighborIndex`, `FlipNeighborIndex`, `GetNeighborAttributeByTag` (tags are offset-slots), `MoveSelfToNeighbor` (target resolution), `InitEvent` x/y/maxX/maxY, all variegated/orientation/face nodes.
6. **`NeighborDensity` must be correct by construction.** Density `ρ = (1/dᵢ)Σⱼ xⱼ` is the single most load-bearing literature property. `Aggregate.Average` equals `ρ` **only if** the neighbor array excludes the center and includes *all* real neighbors (array length == degree). With `includeCentralCell`, or with sub-attribute iteration-skip excluding non-matching neighbors, **array length ≠ degree and Average ≠ ρ**. **Resolve this in the Impact Map, not Phase 3:** if the divisor can diverge from degree, ship `NeighborDensity` as a **first-class node** computing `sum / GetDegree`, not a macro over `Average`.

---

## 7. Node set & capability gating

### 7.1 The gate (`NodeRequirements` in `vpl/types.ts`)
Confirmed firsthand: `NodeRequirements = { async?, variegated? }`, consumed by `detectCapabilityRequirements` + `isNodeAvailable` (`nodeValidation.ts`), driving palette / Add-Node menu / connection-drop filtering + the amber CaNode badge, with per-target compiler rejection as defence-in-depth. Add **two flags**:
- `graph?: boolean` — node requires graph mode (new graph-only nodes).
- `lattice?: boolean` (a.k.a. `requiresRegularGrid?`) — node requires the lattice (gated *off* in graph mode).

Wire both into the two functions + the three compilers' incompatibility detectors (`detectWasmIncompatibilities`/`detectWebGPUIncompatibilities` + a new `detectGraphIncompatibilities`). Add a **worker-side mutual-exclusion safety net** for hand-edited `.gcaproj` (graph ⊥ variegated, graph ⊥ WebGPU-until-Phase-5), mirroring the existing WebGPU↔async enforcement.

### 7.2 Disabled in graph mode (`lattice: true`)
All offset/position/tag nodes from §6.5, plus the **entire variegated-cells/orientation/facing subsystem** (4-fold rotation + N/E/S/W faces are square-lattice-only — hard-disable, don't generalize), and **spatial (rows/columns) indicators** (no lattice axes).

### 7.3 New graph-only nodes (`graph: true`)
- **`GetDegree`** — per-node neighbor count (also the divisor for correct density).
- **`NeighborDensity`** — `sum(neighbor attr) / degree` as one node (§6.6).
- **`GetNeighbors`** (all) — already exists as `GetNeighborsAttribute`; binds to the default edge-type.
- **`GetNeighborByEdgeIndex`** (kth neighbor) — *only* meaningful with a documented **stable neighbor ordering** (by node-id). Offer it with that caveat; it's the escape hatch for users who genuinely need positional access (it turns the graph into a labeled special case, abandoning strict anonymity).
- **Node-identity output on `InitEvent`** — replace x/y/maxX/maxY with a node-id (and optionally degree, position) so procedural init works.
- **Edge-type-aware neighbor access** — `GetNeighborsAttribute(edgeTypeId)` once multiple relations exist.

### 7.4 SDCA mutation nodes (Phase 6, future)
`AddEdge` / `RemoveEdge` (and later `AddNode`/`RemoveNode`) — couplers/decouplers (§2.5). These require a **mutable adjacency structure** (PCSR/CSR++, §2.8) and **double-buffered topology** under sync + conflict semantics under async. The hysteresis trick (λ₂≥λ₁) is the standard anti-flicker device. **Gate behind a separate `graphTopology.dynamic` flag**; do not build in MVP, but keep the schema's adjacency representation mutation-aware (decision in §12).

---

## 8. Visualization & interaction — the explicit ask

### 8.1 "How to visualize" — a separate graph-view render path
Branch at `draw()` (`SimulatorView.tsx` ~L742) on `model.properties` topology to a sibling **`drawGraph()`**. **Biggest reuse win:** the worker's per-cell `colors` buffer (one RGBA per node index) and the index-keyed inspect/paint protocol need **zero change** — a node's color is the same buffer slot the compiled color pass already writes. What's replaced is purely main-thread 2D geometry:

| Lattice path (keep as `2d-grid` impl) | Graph path (new) |
|---|---|
| `new ImageData(colors, w, h)` + one `drawImage` | per-node fill at laid-out position; **instanced/point renderer** at scale |
| `screenToGrid` (floor division) | **nearest-node hit-test** (spatial index / GPU color-coded picking) → node id |
| `gridToScreen` (square cell rect) | `nodeToScreen` (center + radius); inspector contour square → ring |
| geometric brush stamp (`brushShapeOffsets`/`lineStampCells`/Bresenham/silhouette) | **node selection** (click / drag-lasso / graph-distance flood) |
| gridlines, infinity-tiling, image-import (1px=1cell) | **gated off**; edges drawn as lines with LOD |

Abstract `screenToGrid`/`gridToScreen` into a **picker interface** (`screenToCellId` / `cellIdToScreen`) with the current code as the `2d-grid` impl — this localizes nearly all picking changes. Repointing `cellIdx → nodeId` is essentially free downstream (the inspector is already index-keyed); the only two main-thread `idx = row*w+col` derivations (`handleMouseDown`, `handleMouseMove`) need graph variants.

### 8.2 Layout
- **Positions with intrinsic coordinates** (generated lattice, imported geo-net, or stored cached layout): render directly.
- **Abstract graphs:** a **one-shot, cancelable, off-main-thread** layout pass (Web Worker `d3-force`/ForceAtlas2 for CPU; a WebGPU compute path for large graphs, GraphWaGu-style) with a **"freeze layout"** that locks positions before simulating. **Never re-layout per generation.** Cache the result in the `.gcaproj`.
- A **"intrinsic positions?" toggle** is the single highest-leverage UI decision — it determines render cost, animation semantics, and whether a layout pass runs at all.

### 8.3 "Deal with varying neighborhoods" — at three layers
1. **Rule semantics:** aggregate/density nodes (§2.2) — the rule is degree-agnostic by construction; `GetDegree`/`NeighborDensity` make degree a first-class input.
2. **Storage:** ragged CSR (§2.8) — variable neighbor count with no padding waste.
3. **Visualization:** *encode degree visually* — node radius/size ∝ degree (or any attribute), optional edge bundling for hubs, LOD that hides edges in dense regions. This makes degree heterogeneity *legible* rather than just handled.

### 8.4 Performance honesty (a perf note the first design missed)
A graph renderer needs the `colors` buffer **on the main thread every frame**, which **disables the WebGPU/OffscreenCanvas direct-render color-skip optimization** for all graph models (and couples recording the same way). The lattice's one-blit fast path does not translate to per-node drawing. Budget for an instanced GPU point renderer or aggressive viewport culling **from the start**; a naive per-node Canvas2D loop is orders of magnitude slower at large N. Confirm the worker's `recording`/`wantColors` plumbing keeps shipping colors when the graph renderer (not the blitter) is active.

### 8.5 Dense-graph + analysis affordances (later)
Optional **adjacency-matrix view** for dense graphs (Ghoniem et al.), and a per-node **state-history timeline** (cheap, high-value). Both are additive.

---

## 9. Modeler UX

- **Properties → Execution:** a "Graph mode" checkbox calling an `updateGraphTopology({enabled})` action (mirror the variegated checkbox at `PropertiesPanelContent.tsx` ~L288).
- **Topology editor panel:** a new mode-gated ear-tab (append to `ActivityBar` only when `graphTopology?.enabled`, register in `ModelerView` `panelComponents`, auto-switch-away on disable — exactly the variegated template). Contents: generator picker (ring/lattice/ER/WS/BA with param sliders), importer (edge-list/CSV → later GraphML/GEXF), degree-distribution stats, and pick-to-add/remove-node + drag-to-create/delete-edge editing. **Keep this visually distinct from the VPL rule graph (§2.7 two-graphs risk).**
- **Adapt grid-only panels:** Structure section swaps W×H for node-count + generator; **Neighborhoods panel** becomes an *edge-type* editor wired into the same id-keyed `ModelerDetailContext` detail slot (the `(dr,dc)` shape-tool grid + tag UI are hidden; the tag-index-remap cascade goes inert); hide variegated tab + spatial-indicator axis options + end-condition spatial filter.

---

## 10. Subsystem Impact Map

Every touch-point, with the verify note where the critique flagged risk. (✅ reuse as-is · ✏️ modify · ➕ new · 🚫 gate off)

| # | Subsystem | File(s) | Change | Risk / verify |
|---|---|---|---|---|
| 1 | Schema | `model/types.ts` | ➕ `GraphTopologyConfig`; leave `topology` derived | additive; bump `SCHEMA_VERSION` |
| 2 | Default | `model/defaultModel.ts` | absent = disabled (no change) | — |
| 3 | Reducer + cascades | `model/ModelContext.tsx` | ➕ `UPDATE_GRAPH_TOPOLOGY`; cascades for REMOVE_ATTRIBUTE / REMOVE_NEIGHBORHOOD / topology-change clears edgeType refs; LOAD_MODEL migration | mirror variegated cascades exactly |
| 4 | Properties UI | `panels/PropertiesPanelContent.tsx` | ✏️ Graph toggle in Execution | — |
| 5 | Capability gate | `vpl/types.ts`, `nodes/nodeValidation.ts` | ➕ `graph?`/`lattice?` flags + checks + `detectGraphIncompatibilities` | 4-place lockstep (gate + 3 compilers) |
| 6 | Panels show/hide | `ActivityBar.tsx`, `ModelerView.tsx` | ➕ topology panel; 🚫 variegated tab | auto-switch-away on disable |
| 7 | Worker grid/adjacency | `simulator/engine/sim.worker.ts` | ✏️ `buildNeighborIndices` → CSR; `total=N`; loop-arg descriptor; sentinel; reinit guard; sim-state dim-validation | view-copy discipline; `attrsStructurallyEqual`; `.gcastate` nodeCount validation |
| 8 | WASM layout | `compiler/wasm/layout.ts` | ✏️ CSR region sizing; bypass W/H literals | maxDegree re-bake |
| 9 | JS compiler | `compiler/compile.ts` | ✏️ stride→offset emit; `_row/_col` no-op; InitEvent node-id | every neighbor emitter |
| 10 | WASM compiler | `compiler/wasm/compile.ts` | ✏️ stride→offset; bypass `pushNiCellIdx` W/H | parity gate |
| 11 | WebGPU compiler | `compiler/webgpu/*` | ✏️ re-introduce colIndices buffer; bypass `nbrCellIdxFromNi`; merge-path tiles | `maxStorageBufferBindingSize`; **Phase 5** |
| 12 | NI codec | `compiler/niCodec.ts` | ✏️ graph-mode codec (node-id, not dr/dc); cap id < `0x80000000` | enumerate ALL call sites |
| 13 | Node registry | `vpl/nodes/registry.ts` + node files | ➕ GetDegree, NeighborDensity, GetNeighborByEdgeIndex; 🚫 offset/variegated nodes | density correctness (§6.6) |
| 14 | Async hazards / CSE | `compiler/asyncWriteHazard.ts`, `accessorCSE.ts` | ✏️ verify under graph adjacency | neighbor-write seeds resolve under node-id NI |
| 15 | Renderer | `simulator/SimulatorView.tsx` | ➕ `drawGraph()` + picker interface; 🚫 gridlines/infinity/image-import | colors-every-frame perf (§8.4) |
| 16 | Layout | new `simulator/graphLayout.worker.ts` | ➕ one-shot ForceAtlas2/d3-force | off-main-thread; cache result |
| 17 | Picking | `SimulatorView.tsx` | ➕ nearest-node / GPU color-pick → nodeId | two `row*w+col` spots |
| 18 | Painting | `SimulatorView.tsx` | ➕ node selection; 🚫 geometric brush | same `paint` message shape |
| 19 | Cell inspector | `InspectCellPopover.tsx` | ✏️ neighborIndex decode → node-id; suppress orientation row | `decodeAttrValue` branch |
| 20 | Manual brush | `simulator` Manual panel | ✏️ NI picker (offset grid → node-id picker) | per-attr widgets |
| 21 | Indicators | `simulator/IndicatorDisplay.tsx`, worker | 🚫 spatial (rows/cols) axes + end-condition filter | linked/standalone unaffected |
| 22 | Save/load sim-state | `model/fileOperations.ts`, worker | ✏️ nodeCount validation; ATTR_TYPE_MAP; byte-length/+1 | reject mismatched nodeCount cleanly |
| 23 | Recording | `simulator/recording/*` | ✏️ capture rendered canvas, not w×h ImageData | frame source/resolution |
| 24 | Presentation export | `src/export/` (planned) | ✏️ bundle GraphRenderer + layout + CSR | scope statement needed |
| 25 | Copy/paste | `SimulatorView.tsx` | 🚫 region clipboard; (➕ node-set clipboard later) | gate Ctrl+C/V/X off |
| 26 | Serialization | `model/fileOperations.ts` | ✏️ inline CSR/positions; base64 large arrays | precache size guard |

---

## 11. Phased implementation plan

Each phase lists the touch-points (numbers from §10). Every cross-target phase exits on the dev-server byte-shape parity check.

- **Phase 0 — Impact Map + decisions + mockup.** Resolve §12; write `PLAN_GRAPH_CA.md` + illustrated HTML mockup (per convention). *Subsystems: docs only.*
- **Phase 1 — Data model + generators (no sim yet).** Schema (1,2,3), serialization (26), generators + determinism contract (4.3), topology panel skeleton (4,6). Deliverable: create/import/save/load a graph; no simulation. *#1,2,3,4,6,26.*
- **Phase 2 — Engine + JS compiler (headless correctness).** CSR build (7), JS stride→offset (9), niCodec graph mode (12), capability gate (5), GetDegree/NeighborDensity (13). Verify via dev-server compiler imports against a hand-computed graph. *#5,7,9,12,13,14.*
- **Phase 3 — WASM + minimal render + interaction.** WASM (8,10), `drawGraph()` with fixed coordinates (15), picker + node-select paint (17,18), inspector (19). Deliverable: **the headline demo — same rule, swap ring↔WS↔BA, watch dynamics change** (ship ECA 37/108/109/133 as presets). *#8,10,15,17,18,19,21.*
- **Phase 4 — Force layout + scale.** Off-main-thread layout (16), instanced/point renderer + edge LOD (15), GPU color-coded picking (17), manual brush (20), sim-state save/load (22), recording (23). *#15,16,17,20,22,23.*
- **Phase 5 — WebGPU + interop.** WebGPU CSR + merge-path (11), GraphML/GEXF round-trip (26), presentation export (24), parallel async via graph coloring (7/14). *#7,11,14,24,26.*
- **Phase 6 — Structurally Dynamic CA (separate decision).** Mutable adjacency (PCSR/CSR++), AddEdge/RemoveEdge nodes (7.4), double-buffered topology + sync/async conflict semantics + hysteresis. *#1,3,7,9,10,12,13.*

---

## 12. Risks, open questions, decisions to confirm

**Must decide before Phase 0 exits (each causes silent corruption or rework if deferred):**
1. **Scope:** MVP static graph (Phases 1–5) only, or commit to SDCA (Phase 6) — because the SDCA ambition changes the adjacency representation decision *now* (mutable structure vs plain CSR).
2. **Generator provenance:** store realized CSR (robust) vs store-spec-and-rebuild (compact, needs a **frozen versioned PRNG** for cross-browser/version bit-identity). Recommendation: realized CSR default; spec-mode only for pure generator output with a pinned PRNG.
3. **`maxDegree` lifecycle:** single derived-on-topology-change source of truth + explicit invalidation + re-upload + WASM re-bake (else scratch overflow).
4. **Node-id cap < `0x80000000`** so it never collides with `INVALID_NI`.
5. **One mode flag:** drive everything off `graphTopology?.enabled`; `topology` enum derived/display only.
6. **`NeighborDensity` as first-class node** (not an `Average` macro) unless `Aggregate.Average`'s divisor is *proven* to equal degree under `includeCentralCell` + sub-attribute skip.
7. **Default edge-type↔neighborhood binding:** how existing `GetNeighborsAttribute(neighborhoodId)` references auto-bind to the single MVP "Adjacency" edge-type.
8. **width/height in graph mode:** exactly which synthetic value flows to the compiled step args and the ~40 `gridWidth/gridHeight` ref reads in `SimulatorView` (positions-extent bbox? `N×1`?). Each wrong choice breaks a different call site silently.
9. **Boundary treatment** pinned to one value for graph mode, and whether that implies the `+1` sentinel slot (recommend: no sentinel, `cellsPerAttr = total`).

**Lower-risk open questions:** directed-edge support timing; adjacency-matrix view; per-node timeline; node-set copy/paste; how big a graph the Canvas2D path should serve before forcing WebGPU.

**The UX risk to manage continuously:** GenesisCA will have *two* graphs (the VPL rule graph and the topology graph). Keep them modally and visually distinct or new users will conflate them.

---

## 13. Verified bibliography

*(Confirmed against arXiv/DOI/publisher unless marked. See §2.9 for caveats.)*

**Foundations & formal CA-on-graphs**
- Marr, C. & Hütt, M.-T. (2009). *Outer-totalistic cellular automata on graphs.* Physics Letters A 373(5):546–549. arXiv:0812.2408. — **THE foundational formalism** (density normalization, (α,β,γ), 64→34 rules, ECA 37/108/109/133 class-changers, d≈4 complexity peak).
- Marr, C. & Hütt, M.-T. (2005). *Topology regulates pattern formation capacity of binary cellular automata on graphs.* Physica A 354:641–662.
- Wolfram, S. (1983). *Statistical mechanics of cellular automata.* Rev. Mod. Phys. 55(3):601–644. (totalistic/outer-totalistic origin)
- Wolfram, S. (1984). *Universality and complexity in cellular automata.* Physica D 10(1):1–35. (the four classes)
- O'Sullivan, D. (2001). *Graph-cellular automata: a generalised discrete urban and regional model.* Environ. Plan. B 28(5):687–705.
- Darabos, C., Giacobini, M. & Tomassini, M. (2007). *Performance and robustness of cellular automata computation on irregular networks.* Adv. Complex Syst. 10(supp01):85–110.
- Behrens, F., Hudcová, B. & Zdeborová, L. (2024). *Dynamical phase transitions in graph cellular automata.* Phys. Rev. E 109(4):044312. arXiv:2310.15894.

**Message-passing / learned (GNCA)**
- Grattarola, D., Livi, L. & Alippi, C. (2021). *Learning Graph Cellular Automata.* NeurIPS 34. arXiv:2110.14237. — GCA = message passing; can represent any discrete-state GCA.
- Mordvintsev, A., Randazzo, E., Niklasson, E. & Levin, M. (2020). *Growing Neural Cellular Automata.* Distill. DOI 10.23915/distill.00023.
- Gilmer, J. et al. (2017). *Neural Message Passing for Quantum Chemistry.* ICML 2017, PMLR 70:1263–1272. arXiv:1704.01212.
- Gala, G., Grattarola, D. & Quaeghebeur, E. (2024). *E(n)-equivariant Graph Neural Cellular Automata.* TMLR. arXiv:2301.10497.

**Automata networks / Boolean networks / processes on networks**
- Kauffman, S. A. (1969). *Metabolic stability and epigenesis in randomly constructed genetic nets.* J. Theor. Biol. 22(3):437–467.
- Goles, E. & Olivos, J. (1980). *Periodic behaviour of generalized threshold functions.* Discrete Math. 30(2):187–189.
- Goles, E. & Martínez, S. (1990). *Neural and Automata Networks: Dynamical Behavior and Applications.* Kluwer, Math. & Its Applications vol. 58.
- Aldana, M. (2003). *Boolean dynamics of networks with scale-free topology.* Physica D 185(1):45–66.
- Gershenson, C. (2004). *Updating schemes in random Boolean networks: Do they really matter?* Artificial Life IX:238–243.
- Paulevé, L. & Sené, S. (2022). *Boolean networks and their dynamics: the impact of updates.* Systems Biology Modelling and Analysis (Wiley), ch. 6.
- Pastor-Satorras, R. & Vespignani, A. (2001). *Epidemic spreading in scale-free networks.* PRL 86(14):3200–3203.
- Pastor-Satorras, R., Castellano, C., Van Mieghem, P. & Vespignani, A. (2015). *Epidemic processes in complex networks.* Rev. Mod. Phys. 87(3):925–979.
- Sood, V. & Redner, S. (2005). *Voter model on heterogeneous graphs.* PRL 94(17):178701.
- Kayama, Y. & Imamura, Y. (2013). *Network representation of the Game of Life and self-organized criticality.* IEEE ALIFE 2013.
- Bak, P., Chen, K. & Creutz, M. (1989). *Self-organized criticality in the 'Game of Life'.* Nature 342:780–782.
- Newman, M. E. J. (2003). *The structure and function of complex networks.* SIAM Review 45(2):167–256.

**Structurally Dynamic CA**
- Ilachinski, A. & Halpern, P. (1987). *Structurally Dynamic Cellular Automata.* Complex Systems 1(3):503–527.
- Halpern, P. (1989). *Sticks and Stones: A guide to structurally dynamic cellular automata.* Am. J. Phys. 57(5):405–408.
- Nowotny, T. & Requardt, M. (1999). *Pregeometric concepts on graphs and cellular networks…* Chaos, Solitons & Fractals 10(2–3):469–481. arXiv:hep-th/9801199.
- Nowotny, T. & Requardt, M. (2006). *Emergent Properties in Structurally Dynamic Disordered Cellular Networks.* arXiv:cond-mat/0611427. (hysteresis trick)
- Requardt, M. & Rastgoo, S. (2015). *The Structurally Dynamic Cellular Network and Quantum Graphity Approaches…* arXiv:1501.00391.
- Alonso-Sanz, R. & Adamatzky, A. (2008). *On Memory and Structural Dynamism in Excitable Cellular Automata with Defensive Inhibition.* Int. J. Bifurcation & Chaos 18(2):527–539.
- Singh, J. (2025). *A Computational Model of Learning and Memory Using Structurally Dynamic Cellular Automata.* arXiv:2501.06192.
- Ilachinski, A. (2009). *Structurally Dynamic Cellular Automata* (encyclopedia entry), in *Encyclopedia of Complexity and Systems Science* (Adamatzky, ed.), Springer. *(corrected attribution)*

**Generators (network models)**
- Erdős, P. & Rényi, A. (1960). *On the evolution of random graphs.* Publ. Math. Inst. Hungar. Acad. Sci. 5:17–61.
- Watts, D. J. & Strogatz, S. H. (1998). *Collective dynamics of 'small-world' networks.* Nature 393:440–442.
- Barabási, A.-L. & Albert, R. (1999). *Emergence of scaling in random networks.* Science 286(5439):509–512.

**Visualization & layout**
- Fruchterman, T. M. J. & Reingold, E. M. (1991). *Graph Drawing by Force-Directed Placement.* Softw. Pract. Exper. 21(11):1129–1164.
- Jacomy, M., Venturini, T., Heymann, S. & Bastian, M. (2014). *ForceAtlas2…* PLOS ONE 9(6):e98679.
- Misue, K., Eades, P., Lai, W. & Sugiyama, K. (1995). *Layout Adjustment and the Mental Map.* JVLC 6(2):183–210.
- Beck, F., Burch, M., Diehl, S. & Weiskopf, D. (2017). *A Taxonomy and Survey of Dynamic Graph Visualization.* Computer Graphics Forum 36(1):133–159.
- Ghoniem, M., Fekete, J.-D. & Castagliola, P. (2004). *A Comparison of the Readability of Graphs Using Node-Link and Matrix-Based Representations.* InfoVis 2004:17–24.
- Dyken, L. et al. (2022). *GraphWaGu: GPU Powered Large Scale Graph Layout Computation and Rendering for the Web.* EGPGV 2022:73–83.
- Franz, M. et al. (2016). *Cytoscape.js…* Bioinformatics 32(2):309–311.
- Bastian, M., Heymann, S. & Jacomy, M. (2009). *Gephi…* ICWSM 3:361–362.

**Performance / data structures**
- Merrill, D., Garland, M. & Grimshaw, A. (2012). *Scalable GPU Graph Traversal.* PPoPP '12.
- Beamer, S., Asanović, K. & Patterson, D. (2012). *Direction-Optimizing Breadth-First Search.* SC '12.
- Wang, Y. et al. (2016/2017). *Gunrock: GPU Graph Analytics.* PPoPP '16 / ACM TOPC. arXiv:1701.01170.
- Merrill, D. & Garland, M. (2016). *Merge-Based Parallel Sparse Matrix-Vector Multiplication.* SC '16. (merge-path load balancing)
- Liu, W. & Vinter, B. (2015). *CSR5…* ICS '15:339–350. arXiv:1503.05032.
- Kreutzer, M. et al. (2014). *SELL-C-σ…* SIAM J. Sci. Comput. 36(5). arXiv:1307.6209.
- Osama, M., Porumbescu, S. D. & Owens, J. D. (2023). *A Programming Model for GPU Load Balancing.* PPoPP '23:79–91. arXiv:2301.04792.
- Busato, F. et al. (2018). *Hornet: An Efficient Data Structure for Dynamic Sparse Graphs and Matrices on GPUs.* IEEE HPEC 2018.
- Firmli, S. et al. (2020). *CSR++: A Fast, Scalable, Update-Friendly Graph Data Structure.* OPODIS 2020.
- Wheatman, B. & Xu, H. (2018). *Packed Compressed Sparse Row (PCSR).* IEEE HPEC 2018.
- Alabandi, G. & Burtscher, M. (2022). *Improving the Speed and Quality of Parallel Graph Coloring.* ACM TOPC 9(3).

*(Uncertain/secondary, use with care: Majercik 1994 M.S. thesis (existence unconfirmed); Baxter, Modern GPU library docs; Adam Mehdi, "Exploring Graph Cellular Automata," Towards Data Science, 2022.)*

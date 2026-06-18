# Investigation — Cellular Potts Model (CPM) / morphogenesis mode for GenesisCA

> **Status:** feasibility study + literature review + subsystem Impact Map. This is the *precursor* to a formal plan, **not a commitment to build**. No code has changed. Per the project's "Illustrated plans required for UI/behavior changes" rule, a formal `PLAN_CPM.md` + HTML mockup come *after* the scope decisions in §12 are made.
>
> **How this was produced:** the same multi-agent research workflow used for the Graph-CA investigation (21 agents, ~3.9 M tokens) — **7** web-research literature topics (foundations, Hamiltonian terms, dynamics, applications/extensions, software/visualization, performance/implementation, **plus an explicit CPM-vs-vertex-vs-center-based substrate comparison** added to serve the user's actual morphogenesis goal), each independently fact-checked (citations confirmed against arXiv / DOI / PubMed / publisher; Artistoo claims verified against the eLife paper *and* the GitHub source), plus 5 codebase subsystem deep-reads, a synthesis pass, and an adversarial critique. The load-bearing codebase claims — `topology` is dead data, the async single-buffer + `orderArray` mechanism, `MoveSelfToNeighbor`/`SetNeighborAttributeByIndex` write a neighbour *site*, the `lookupTable` tag×tag attribute type exists, and there is **no per-cell-ID object level today** — were each verified firsthand (Grep/Read; see §2.7 and inline file:line refs).
>
> **Framing note (read this first):** the user's actual goal is **cell division, morphogenesis, and arbitrarily sophisticated update rules over many per-cell attributes, with the dynamic spatiality/adjacency inherent to a real multicellular system, ultimately in 3D** (2D first is acceptable). CPM is *a candidate starting substrate*, not the goal. §3 is an explicit, evidence-based substrate comparison (CPM vs vertex vs center-based/off-lattice) that gives an honest recommendation; the rest of the document assumes CPM-first **but flags exactly where CPM's ceiling is and where a second engine would be the better target.**

---

## 1. Executive summary

**The ask.** Add a **CPM mode** to GenesisCA — a new optional model mode (toggled in Properties, like Variegated Cells or Asynchronous update) that turns the substrate from "one cell per lattice site, synchronous deterministic rule" into the **Glazier–Graner–Hogeweg model**: a lattice where one *biological cell* is a connected domain of **many** sites sharing an integer ID, and the update is **Metropolis Monte Carlo** — propose copying a neighbour's cell-ID into a boundary site, accept with probability `min(1, exp(−ΔH/T))` against an energy (Hamiltonian) `H`. On top of that substrate: cell growth, division, death, chemical fields, and (eventually) 3D — the morphogenesis end goal.

**The single most important finding (engine paradigm — the central tension).** GenesisCA's defining architectural commitment is *compile the node graph to a per-cell step function, then call it once per generation over the whole grid* (`fn(...buildLoopArgs())`, [sim.worker.ts:1192](../src/simulator/engine/sim.worker.ts)). **A graph compiled per-site cannot, by itself, express a correct CPM Metropolis copy-attempt.** Three things break it: (a) the volume/perimeter energy terms need each *biological cell's current total* volume — a per-cell-ID global quantity the per-site graph has no way to read or maintain; (b) the accept step must *atomically* commit a site write **plus** two accumulator updates, and a per-cell compiled function has neither the cross-site reduction state nor a transactional commit; (c) the loop shape is wrong — CPM does ~N *propose→accept-or-reject* attempts that each mutate one site the next attempt reads, not "visit every cell once and write its next state." **Recommendation: CPM is a *hybrid* — a new worker-side Metropolis driver (a `'cpm'` update mode) that owns the per-cell-ID bookkeeping and the accept/reject, with the node graph repurposed to compute *only* a scalar ΔH for a proposed copy** (a new energy/Hamiltonian event root, sibling to `Step`/`InitEvent`). This is the CPM analogue of the Graph-CA investigation's central "CSR vs the dead `topology` field" finding.

**Why this is *not* hopeless news for GenesisCA specifically.** Roughly 60–70% of the wiring is reusable, and the closest existing machinery maps remarkably well:
- The **asynchronous update mode** is structurally already a sequential, single-buffer, site-visiting sweep with neighbour writes — exactly CPM's substrate. Async aliases the write buffer to the read buffer (`attrsB[attr.id] = arrA`, [sim.worker.ts:804](../src/simulator/engine/sim.worker.ts)) so a write is immediately visible (CPM's in-place spin update), and builds an `orderArray` of shuffled site indices ([sim.worker.ts:859-874](../src/simulator/engine/sim.worker.ts)) — the random copy-attempt schedule.
- The neighbour-write primitive **already exists**: `MoveSelfToNeighbor` emits `w_A[nbr] = w_A[idx]` ([MoveSelfToNeighborNode.ts:84](../src/modeler/vpl/nodes/MoveSelfToNeighborNode.ts)), which is literally a spin-copy into an adjacent site; `SetNeighborAttributeByIndex` writes `w_attr[nbrCell] = value` ([SetNeighborAttributeByIndexNode.ts:34](../src/modeler/vpl/nodes/SetNeighborAttributeByIndexNode.ts)). Both guard the constant-boundary sentinel with `if (cell < total)`.
- The **Metropolis accept gate already exists**: `GetRandom` in bool mode compiles to `(_rs / 4294967296) < prob ? 1 : 0` ([GetRandomNode.ts:37](../src/modeler/vpl/nodes/GetRandomNode.ts)) over a shared xorshift32 stream — wire `prob = exp(−ΔH/T)` and you have `rand() < exp(−ΔH/T)`.
- The **adhesion J(τ,τ′) contact-energy matrix maps cleanly onto the existing `lookupTable` attribute type** — a tag×tag float matrix keyed by cell *type* on both axes (the `tagAttribute` key-source path, [types.ts:9,19-22](../src/model/types.ts)), live-tunable via the `updateLookupTable` worker message ([sim.worker.ts:164](../src/simulator/engine/sim.worker.ts)). The chromatography model already uses exactly this shape (a tag×tag PB/J table). **No new attribute type is needed for adhesion.**
- **`T`, `λ_V`, `λ_S`** map onto bounded float **model attributes** with sliders ([Attribute.hasBounds/min/max](../src/model/types.ts:39-43)).
- **Rendering is mostly reusable** (unlike Graph CA): CPM is still a 2-D lattice, so the existing Canvas2D `colors`-buffer blit carries over unchanged — colour a site by its cell-ID or its type via an ordinary Output Mapping. The genuinely new render work is *membrane/boundary drawing*, *colour-by-cell-ID at scale*, and an optional *chemical-field overlay*.
- **Artistoo** (Wortel & Textor, eLife 2021) is a pure-JavaScript browser CPM that runs interactive 2D *and* 3D simulations with no GPU (≈20 fps is its stated real-time threshold), benchmarked at or slightly above C++ Morpheus on three of four examples — **except cell division, where it lagged but stayed real-time-feasible** (a caveat that matters because division is precisely GenesisCA's hardest phase). It is the existence proof that a zero-install in-browser CPM is feasible, and its modular `Constraint.deltaH(sourcei, targeti, src_type, tgt_type)` design is the architectural template for GenesisCA's energy-term nodes.

**The genuinely new subsystems (where the work concentrates — and where division/morphogenesis lives):**
1. **A per-cell-ID object/accumulator tier** (volume, perimeter, target volume, type, centroid) indexed by cell ID, length = `maxCells`, **maintained incrementally** on every accepted copy (±1 volume on the two cells touching a flip; never recomputed). GenesisCA has *no* per-agent/per-object level today — every attribute is per-*site* (one typed array of length `total`) or a single global scalar. This is the central new data structure.
2. **A bespoke Metropolis worker loop** that picks boundary source→target pairs, calls the compiled ΔH function, does the `exp(−ΔH/T)` accept, commits the relabel, and updates the accumulators — replacing the per-cell `runStep` dispatch when `cpm.enabled`.
3. **Cell division / growth / death as post-MCS structural events** — division allocates a fresh cell ID, splits a cell's sites along an axis, and reseeds the daughters' targets. This breaks the fixed-array assumption and needs a `maxCells`-capped, free-listed ID registry.
4. **A connectivity / fragmentation guard** (a local test, Durand & Guesnet 2016) so cells don't shatter into disconnected specks — a correctness requirement, not polish.
5. **Membrane rendering + colour-by-cell-ID** (new render passes) and, for morphogenesis, a **reaction-diffusion chemical-field layer** (a second scalar grid the cells sense/secrete).

**Recommended scope (see §11 for phasing).**
- **Phase 0–2 (the proof):** `cpm` update mode forcing async-like single-buffer dynamics; per-cell-ID volume bookkeeping; an Adhesion (J-matrix) + Volume energy graph; the Metropolis driver; JS only → **2D cell sorting from differential adhesion** (the Graner–Glazier 1992 founding result — the unambiguous correctness test).
- **Phase 3–4:** WASM target; perimeter constraint; connectivity guard; boundary-edge sampler for speed; membrane rendering + colour-by-cell-ID; cell **growth + division** (the morphogenesis on-ramp).
- **Phase 5–6:** reaction-diffusion chemical fields + chemotaxis; the Act persistent-migration model; 3D lattice — the same Hamiltonian + kernel (an *incremental engine change*: a bigger stencil + parameter rescale) **but a wholesale new 3D renderer** (Canvas2D is hard-wired — §9). The "3D is easy" claim is true of the *engine*, not the *renderer*; never quote one half without the other.
- **Out of scope for v1:** WebGPU CPM (sequential accept/reject; needs a checkerboard scheduler — a separate, later milestone, exactly as async is already WebGPU-rejected). **And out of scope as a *substrate*:** confluent epithelial sheet-mechanics (folding, T1 intercalation, tube/branch formation) — that is *vertex-model* territory, CPM's documented ceiling (§3).

**CPM's ceiling — hear this before committing (§3 expands).** CPM buys deformable shape + free dynamic adjacency cheaply, but at the cost of physical rigour: Monte-Carlo "time" is not real time; a single `T` knob couples adhesion, motility, surface roughness and effective size; and the modified-Metropolis algorithm breaks detailed balance, so long-time behaviour is degenerate — cells can stochastically go extinct without a no-extinction guard (Voss-Böhme 2012). It is the **wrong tool for confluent epithelial sheet-mechanics** (folding, T1 intercalation, tube/branch formation — *vertex-model* territory), and for **huge dispersed 3D populations with rich per-cell phenotype logic + trivial division** an off-lattice **center-based** model (PhysiCell-style) is the better complementary engine. The recommendation is therefore CPM-***first***, not CPM-only — keep the per-cell IR engine-agnostic so a second engine stays open (§3.2).

---

## 2. Literature foundations (the deep dive)

The Cellular Potts Model has a 30+-year literature in developmental and biophysical modelling. It is organised below by the questions that drive implementation: what CPM *is* (and how it differs from a CA), the energy terms and their incremental ΔH, the Monte-Carlo dynamics + connectivity, what it is *used* for, the software/visualization precedent (esp. Artistoo), and performance/parallelism. Every citation in this section was independently fact-checked; reliability is summarised in §2.7.

### 2.1 What CPM is — and why it is not a cellular automaton in GenesisCA's sense

The **Cellular Potts Model (CPM)**, a.k.a. the **Glazier–Graner–Hogeweg (GGH)** model, is a lattice model where each site `x` holds a "spin" `σ(x)` = the integer **ID of the biological cell** occupying it (`σ=0` = medium/ECM). **A biological cell is a connected set of many sites sharing one σ value** — cells are spatially *extended*, not one-site. A second map `τ(σ)` assigns each cell a *type* (phenotype): `τ` — not the individual ID — drives the adhesion coupling and per-type parameters, and `τ(0)=medium`. CPM is a "large-Q" extension of the q-state Potts model of statistical physics (Wu 1982): unlike the magnetic Potts model where q is a small fixed count of spin states, here Q grows with the number of cells (one spin value per cell), and the domains are constrained to behave like deformable cells with a target volume (Graner & Glazier 1992; verified — the 1992 abstract literally describes "a modified version of the large-Q Potts model with differential adhesivity").

The model is defined by an **energy (Hamiltonian) `H`, not a transition rule**, and evolves by **minimising `H` via Monte Carlo**. This inverts *every* assumption of a classical CA:

| | Classical CA (GenesisCA today) | Cellular Potts Model |
|---|---|---|
| **Cell ↔ site** | one cell per site | one biological cell = *many* sites |
| **State per site** | a finite state alphabet Σ | a (large, unbounded) cell ID σ |
| **Update unit** | synchronous deterministic `τ` applied to every site | one stochastic **copy attempt** at a boundary site |
| **Buffering** | double buffer (read→write) | single buffer, mutated between attempts |
| **What drives it** | a transition rule | minimisation of a global energy under thermal fluctuation |
| **Time unit** | one synchronous "generation" | one **Monte Carlo Step** = N copy attempts |

This is why CPM maps onto GenesisCA's **asynchronous** mode (single buffer, random visit order, neighbour writes), not its synchronous double-buffer path — but it is *more* than async: async still runs a deterministic per-cell `runStep`, whereas CPM runs a propose→accept-or-reject inner loop.

The founding biological idea CPM operationalises is **Steinberg's Differential Adhesion Hypothesis** (Steinberg 1963, 1970): dissociated embryonic cells of two types behave like immiscible liquids and sort so the more-cohesive (lower interfacial-energy) population is enveloped by the less-cohesive one, reaching a path-independent lowest-energy configuration. **Cell sorting** — a mixed aggregate spontaneously segregating into an engulfed core + outer shell, *purely from the adhesion matrix, with no "seek-like-cells" rule* — was the validating result of Graner & Glazier 1992 and is the canonical first model any CPM engine should reproduce.

### 2.2 The Hamiltonian, term by term, and how each contributes a *local* ΔH

The engine **never computes global `H`** — it computes a *local* `ΔH` for a single proposed copy, summed over independent energy terms, because only one site changes spin. Each term also pairs with a tiny bit of *incrementally maintained* per-cell state. This per-term `deltaH(sourceSite, targetSite, srcType, tgtType)` + `postSetpix`/`postMCS` bookkeeping pattern (verified against Artistoo's actual `src/hamiltonian/*.js`) is the exact contract a node-graph compiler must emit.

**(1) Adhesion / contact energy** — `H_adh = Σ_{neighbour site-pairs} J(τ(σ_i), τ(σ_j))·(1 − δ(σ_i, σ_j))`. A penalty `J` for every adjacent pair of sites belonging to *different* cells; the Kronecker `(1−δ)` zeroes same-cell interiors so only interfaces count. `J` is a small symmetric **type×type matrix** (medium = type 0); lower `J` = stronger sticking; differential `J` values alone drive sorting. ΔH is purely *local* — re-sum `J` over the target site's own neighbourhood under the proposed spin minus the current spin. **No per-cell state.** (Artistoo: `deltaH = H(targeti, src_type) − H(targeti, tgt_type)`, `H(i,t) = Σ_neighbours J(neighbourType, t) where neighbourType ≠ t` — verified verbatim in `src/hamiltonian/Adhesion.js`.) **This is the cheapest term and the first milestone.**

**(2) Volume constraint** — `H_vol = Σ_cells λ_V·(v(σ) − V_target(σ))²`, a quadratic "spring" keeping each cell near its target size (incompressibility / deformability). A flip changes exactly two cells by ±1 voxel. The incremental ΔH only re-evaluates those two quadratics; closed-form, `ΔH_vol = λ_V·Δ·(2(v − V_t) + Δ)` with `Δ = ±1`. **Required state:** a per-cell `volume[cellID]` map, incremented/decremented by ±1 on every accepted flip. (Artistoo: `deltaH = volconstraint(+1, src) − volconstraint(0, src) + volconstraint(−1, tgt) − volconstraint(0, tgt)` — verified in `VolumeConstraint.js`.)

**(3) Surface / perimeter constraint** — `H_surf = Σ_cells λ_S·(s(σ) − S_target(σ))²` (membrane elasticity / stiffness; perimeter in 2D, surface area in 3D = count of unlike-spin boundary faces). Unlike volume, a single flip can change perimeter by *more* than ±1 and can touch *more than two* cells (CompuCell3D manual, verified verbatim: "Copying a single pixel may cause surface change in more than two cells — this is especially true in 3D"). The incremental ΔH loops the target's neighbourhood once to build a per-affected-cell `pchange`, then evaluates the quadratic difference. **Required state:** a per-cell perimeter map, updated by a post-flip neighbourhood re-walk.

**(4) Common extensions (each adds to the same ΔH):**
- **Chemotaxis** — `ΔH_chem = −μ·(C(target) − C(source))`, biasing copies up a diffusing chemical field `C` (Savill & Hogeweg 1997, the "H" in GGH — the first CPM-PDE coupling). `C` is a *global* field maintained by a separate reaction-diffusion solver; **no per-cell state**, just two field lookups.
- **Act model (persistent migration)** — `ΔH_Act = (λ_Act/Max_Act)·(GM_Act(source) − GM_Act(target))`, where `GM_Act` is the *geometric mean* of per-site activity over the same-cell Moore neighbourhood; a freshly-copied site is set to `Max_Act` and decays by 1 each MCS (Niculescu, Textor & de Boer 2015 — equation verified verbatim from PMC). **Required state:** a per-*site* activity field + a per-MCS decay sweep.
- **Length / elongation** — `H_len = λ_L·(l − L_target)²`, `l` = major-axis length from the cell's inertia tensor. **Required state:** per-cell second moments (Σx, Σy, Σx², Σy², Σxy, count), updated ±point per flip.
- **Persistence / preferred-direction** — `ΔH = −λ_dir·(displacement · cellHeading)`; **state:** per-cell centroid history + heading.

**The unifying engine insight (the crux for incremental bookkeeping):** every term that depends on a cumulative per-cell quantity (volume, perimeter, centroid, length moments, activity) pairs a `deltaH` reading cached scalars with a `postSetpix` updater that maintains them. Recomputing volume per attempt by scanning the grid is O(total) per attempt = catastrophic at 25M sites; incremental ±1 is mandatory.

### 2.3 The dynamics — modified Metropolis Monte Carlo, temperature, connectivity

**The elementary move (copy attempt):** pick a random *target* boundary site `x` and a random neighbour *source* `x′`; propose `σ(x) ← σ(x′)` (one cell extends one pixel into a neighbour or medium; the target's old cell loses a pixel). *(Convention note — used consistently in §2.3, §6.1 and §7.1: matching Artistoo, the engine samples the **target** from the boundary set and the **source** from the target's neighbours, then copies source→target. Some texts sample the source first; the meaning is identical, only the sampling order differs — so "source" and "target" never silently swap roles in this document.)* Compute ΔH for that single flip; **accept with P = 1 if ΔH ≤ 0, else exp(−ΔH/T)**; otherwise reject. Attempts are processed *one at a time*, mutating the lattice between attempts (an intrinsically **sequential** Markov chain). **One Monte Carlo Step (MCS) = N copy attempts** (N = number of sites, scaled by a `Flip2DimRatio` in CompuCell3D) and is the model's unit of time. (All verified — Metropolis 1953 for the `min(1, exp(−ΔE/T))` acceptance; CompuCell3D manual verbatim for `P = e^((−ΔE−δ)/kT)`, the `FirstOrderExpansion` variant, and `MCS = Flip2DimRatio × lattice_sites`.)

**Temperature `T` is *not* heat — it is a fluctuation amplitude / cell-membrane motility** (CompuCell3D explicitly calls it `FluctuationAmplitude` and notes "Temperature" was confusing). `T=0` freezes the configuration in the first local energy minimum (deterministic gradient descent); too-large `T` dissolves cells into noise; tuning `T` lets the system escape shallow minima and reach biologically relevant sorted/morphogenetic states. **`T` is the single most important and least intuitive parameter** — it needs a default + a tooltip.

**Boundary-restricted attempts.** An interior copy (source and target share the cell ID) changes nothing — `ΔH = 0`, a no-op. On a packed tissue *most* sites are interior, so iterating all sites wastes nearly all attempts. Real engines restrict attempts to boundary sites: Artistoo keeps a `borderpixels` **DiceSet** (O(1) insert/delete/random-sample) and the loop is `while(delta_t<1){ delta_t += 1/borderpixels.length; tgt = borderpixels.sample(); … }` (verified in `src/models/CPM.js`). This makes per-MCS cost scale with *boundary length*, not area — the single biggest performance lever.

**Connectivity / fragmentation (a correctness requirement, not polish).** A naive copy can disconnect a cell into islands (biologically meaningless), and the standard algorithm only preserves connectivity over a limited `T` range. Two approaches: a **hard** local-connectivity test (Durand & Guesnet 2016 prove a *local* test on the changing site's neighbourhood is sufficient to forbid fragmentation at *all* temperatures, runs *faster* than the standard algorithm, and restores detailed balance — verified verbatim from arXiv:1609.03832) or a **soft** large-ΔH penalty (Artistoo's `SoftConnectivityConstraint`). The 2D test does **not** guarantee single-connectedness in 3D, so plan it as an engine-side hard veto, especially once division and large deformations are in play.

### 2.4 What CPM is used for — and the must-have vs advanced feature split

CPM dominates the cell-based morphogenesis literature. Applications span **cell sorting** (the founding DAH result), **Dictyostelium aggregation/slug migration** (Savill & Hogeweg 1997; Marée & Hogeweg 2001 — adhesion + cAMP chemotaxis + differentiation + division produce a 3D fruiting body), **tumour growth & invasion** (Szabó & Merks 2013 — Gompertzian avascular growth, nutrient-limited necrotic cores, haptotaxis/protease "fingering" invasion), **angiogenesis/vasculogenesis** (Merks et al. 2008 — contact-inhibited chemotaxis self-organises endothelial cells into vascular networks and sprouts), **biofilms**, and tissue/epidermis/kidney-tube morphogenesis (Hirashima, Rens & Merks 2017 walk four worked examples: sorting, cyst formation, kidney tube, blood vessels).

**Must-have core** (the minimum for any developmental result, and exactly the user's stated goal):
1. **Differential adhesion** (the type×type `J` matrix) — without it there is no sorting and effectively no CPM.
2. **Volume constraint** (target volume per cell) — cells maintain physical extent.
3. **Perimeter/surface constraint** — controls membrane fluctuation and shape.
4. **Cell types `τ`** with per-type adhesion + parameters.
5. **Coupling to reaction-diffusion CHEMICAL FIELDS** — a continuum PDE layer (`∂c/∂t = D∇²c + S − εc`) cells sense (chemotaxis) and modify (secretion/uptake). Present in essentially every non-trivial morphogenesis model; effectively a must-have, *not* an advanced option.
6. **Growth** (raise V_target over time), **division/mitosis** (split a cell at a doubling volume), **death** (necrosis/apoptosis by shrinking V_target). The minimum for development/tumours, and **the GenesisCA end goal**.

**Advanced** (defer): subcellular **compartments** (a cell as linked sub-cells, for polarity/nucleus/complex shape); explicit **ECM** (frozen domains/links/fibers with degradation, anisotropic invasion); the **Act** persistent-migration model and other polarity models; **intracellular ODE/SBML networks** (true multiscale); length/connectivity/elongation constraints; **3D**. Critically, **3D CPM is a first-class, widely-used capability** (CompuCell3D, Morpheus, Artistoo all do 2D and 3D) and needs *no new algorithm* — the *same* Hamiltonian + Monte-Carlo kernel work in 3D, only area-dependent parameters rescale (2D pixel = 4 neighbours, 3D voxel = 6) and the neighbour stencil enlarges. **This is the pivotal fact for the 2D→3D roadmap: 3D is incremental, not architectural.**

### 2.5 Software precedent + visualization (the architectural template)

**Artistoo** (Wortel & Textor, eLife 2021) is *the* load-bearing reference and the closest analogue to GenesisCA's deployment model: a pure-JavaScript ES6 CPM library that runs interactive 2D *and* 3D simulations entirely in the browser, **no server / plugin / install** (viewers explore via parameter sliders on a plain HTML page; builders write JS). Verified from the eLife paper and GitHub source:
- Modular architecture: `Grid2D`/`Grid3D` (each pixel stores a cell ID), a `CPM`/`GridBasedModel` engine running the Metropolis loop, pluggable `Constraint` objects each exposing a `deltaH(...)` the engine sums, a `GridManipulator` (seed/divide/kill), `Stats`, and a `Canvas` renderer.
- It *also* implements a generic `CA` class (its benchmark suite includes Conway's Game of Life) — **the same library spans plain CA and CPM, exactly the unification GenesisCA would attempt.**
- Hard-vs-soft constraint split: hard constraints (`HardVolumeRangeConstraint`, `BarrierConstraint`, hard `ConnectivityConstraint`) **veto** a copy attempt *before* energy is computed; soft constraints only bias acceptance.
- Performance: benchmarked "slightly faster in all but one" of four examples (Game of Life, Act-migration, cell sorting, cell division) vs C++ **Morpheus**; only division lagged. Speed scales linearly with pixel count; ~20 fps is the stated real-time threshold. **This is the existence proof that browser-resident interactive CPM is performant** — and GenesisCA's WASM target should comfortably exceed pure JS.

Other ecosystem tools frame the feature/UX expectations: **CompuCell3D** (Swat et al. 2012) is the heavyweight C++/Python reference with the full constraint catalogue, PDE solvers, the **Mitosis plugin** (split at `DoublingVolume` into two ~equal daughters), growth, compartments, and 3D; **Morpheus** (Starruß et al. 2014) is the GUI-driven, *no-code* declarative environment (MorpheusML/XML) coupling CPM with ODEs + reaction-diffusion — the closest spiritual analogue to GenesisCA's accessibility goal; **Tissue Simulation Toolkit** and **Chaste** round out the C++ ecosystem (Chaste implements CPM, CA, centre-based, Voronoi, and vertex models behind one API — the best "swappable spatial engines" architectural precedent).

**Visualization techniques converge on a small palette GenesisCA should adopt wholesale:**
- **Colour by cell ID** (each cell a distinct hue — shows individual movement/sorting) vs **colour by cell TYPE** (all cells of a kind share a colour — shows tissue pattern). Two Attribute→Color mappings over the same lattice.
- **Filled cells vs cell BOUNDARIES/membranes** — boundary mode (draw an edge where two adjacent sites have different cell IDs) is both far cheaper and the canonical "tissue" look.
- **Chemical-field heatmap overlays** — a separate continuous scalar lattice (from the reaction-diffusion PDE), drawn as a colour ramp / contour lines *under* the cells.
- **Cell-centroid tracks** — polylines of each cell's centre of mass over time (needs per-cell centroid accumulation).

### 2.6 Performance & the per-cell-ID accumulator (the structure the audit calls the crux)

The performance-critical insight is **incremental bookkeeping**: never recompute a cell's volume/perimeter by scanning the lattice; keep per-cell-ID accumulator *arrays* (length = `maxCells`) updated ±1 on each accepted copy. A copy attempt is then O(neighbourhood), independent of cell or lattice size. Cells-in-Silico (Berghoff et al. 2020) calls this "Additional Cell Data" (volume, surface, age, type, centre of mass); Artistoo calls it `cellvolume[]` / `cellperimeters[]` keyed by ID.

**Parallel / GPU CPM is hard precisely because accept/reject is sequential** (each accepted copy mutates state the next proposal reads). The dominant trick is **checkerboard / sub-lattice decomposition** — colour the lattice so simultaneously-updated sites are ≥ interaction radius apart (2-color nearest-neighbour, 8-color Moore/D3C27), update one colour per phase — plus **atomic** updates (atomicAdd / compareExchange) on the shared per-cell volume array to resolve many-threads-one-cell races. Lineage: Chen et al. 2007 (MPI checkerboard, 10⁷+ cells), Tapia & D'Souza 2011 (GPU checkerboard + atomic CAS on the volume array, ~80× over serial, up to 256³), and — most relevant — **Sultan, Devi, Mueller & Textor 2023** (the Artistoo group's GPU CPM), which shows that *naive* parallelism **biases the dynamics**: the *waiting-time distribution* between successive copy attempts at the same pixel must be preserved (large checkerboard subsections + frequent colour switching + atomics, not locks) or cell-sorting/motility silently breaks. They report ~3500× over their own CPU code, ~25000× over Morpheus in 2D, ~600× in 3D, millions of cells.

**The honest conclusion for WebGPU:** CPM can be GPU-accelerated, but only via a *fundamentally different scheduler* than GenesisCA's per-cell-parallel sweep — a multi-phase checkerboard dispatch with atomics and explicit bias control, not one thread per cell. **A first CPM mode should target JS/WASM only** (mirroring how async is already WebGPU-rejected: `detectWebGPUModelIncompatibilities` rejects `updateMode === 'asynchronous'`, [nodeValidation.ts](../src/modeler/vpl/nodes/nodeValidation.ts)), with a checkerboard WGSL path deferred to a later wave.

### 2.7 Citation reliability note

All cited works in this section were independently fact-checked against arXiv / DOI / PubMed / publisher pages, and the Artistoo implementation claims were verified against both the eLife paper *and* the GitHub source (`src/hamiltonian/*.js`, `src/models/CPM.js`). **Verdict: HIGH reliability.** Every load-bearing technical claim survived adversarial scrutiny: the two-term Hamiltonian (adhesion `(1−δ)·J` + `λ_V` volume), the Metropolis `exp(−ΔH/T)` acceptance and `MCS = N attempts` definition, `T` as a fluctuation amplitude (verbatim from CompuCell3D), the incremental volume/perimeter ΔH (verbatim from Artistoo source), the Act-model geometric-mean equation (verbatim from PMC), the boundary-only-copy fact, the connectivity local-test result (Durand & Guesnet, verbatim), and the Artistoo browser/~20 fps/Morpheus-competitive existence proof (verbatim from eLife). Page ranges that *looked* risky (e.g. Graner & Glazier PRL 69:2013–2016; Niculescu PLoS Comput Biol 11(10):e1004280) all checked out. Two corrections from verification, neither load-bearing: one earlier source merged two distinct Popławski papers (the 2007 chick-limb *Physica A* paper and the 2008 biofilm *Math. Biosci. Eng.* paper) into one invalid citation — both real, cite separately; and the Chen et al. 2007 DOI was wrong in one brief (correct: `10.1016/j.cpc.2007.03.007`). Full annotated bibliography in §13.

### 2.8 Firsthand codebase verifications (done before asserting)

To avoid the "plausible-but-wrong" trap, the highest-leverage codebase claims were confirmed by direct Grep/Read, not taken from the audit alone:
- **`topology` is dead data.** `grep` for `topology` in `src/` matches exactly two sites: the type declaration ([types.ts:203](../src/model/types.ts)) and the seed ([defaultModel.ts:12](../src/model/defaultModel.ts)). **Zero branch sites.** It is safe to repurpose (or to add a sibling `lattice`/`dimensions` field) — confirmed.
- **Async single-buffer.** `attrsB[attr.id] = arrA` aliases write→read when `isAsync` ([sim.worker.ts:804](../src/simulator/engine/sim.worker.ts)); `writeAttrs = isAsync ? attrsA : attrsB` ([sim.worker.ts:813](../src/simulator/engine/sim.worker.ts)) — confirmed.
- **`orderArray` + Fisher-Yates.** Built per step for `random-order`, with-replacement for `random-independent`, init-shuffled for `cyclic` ([sim.worker.ts:859-874, 1150-1164](../src/simulator/engine/sim.worker.ts)) — confirmed.
- **Neighbour-write spin-copy.** `MoveSelfToNeighbor` emits `w_A[nbr] = w_A[idx]` inside `if (ni valid && nbr < total)` ([MoveSelfToNeighborNode.ts:70-86](../src/modeler/vpl/nodes/MoveSelfToNeighborNode.ts)) — confirmed.
- **Metropolis gate.** `GetRandom` bool mode: `(_rs / 4294967296) < ${prob} ? 1 : 0` ([GetRandomNode.ts:37](../src/modeler/vpl/nodes/GetRandomNode.ts)) — confirmed.
- **`lookupTable` is tag×tag.** `AttributeType` includes `'lookupTable'` and `LookupKeySource` includes `{ kind: 'tagAttribute'; attributeId }` ([types.ts:9, 19-22, 71-87](../src/model/types.ts)) — confirmed.
- **No per-cell-ID object level.** `grep` for `cellId|perimeter|maxCells|sigma|biological cell` (case-insensitive) across `src/`: every `cellIdx` hit is a *lattice-site* index (`row*width+col`), never a biological-cell object; `perimeter`/`maxCells`/`sigma` have **zero** domain hits. **There is no per-agent/object/accumulator tier today** — confirmed.
- **Step calls compiled fn once per generation.** `fn(...buildLoopArgs())` ([sim.worker.ts:1192](../src/simulator/engine/sim.worker.ts)); the loop is inside the compiled function — confirmed.

---

## 3. Substrate choice — is CPM the right starting point?

The user's goal is **division + morphogenesis + rich per-cell rules + dynamic adjacency, ultimately in 3D**, not "CPM" per se. The literature offers a near-perfect head-to-head: Osborne, Fletcher, Pitt-Francis, Maini & Gavaghan (PLoS Comput Biol 2017, verified) implement five cell-based model families in *one* framework (Chaste) and benchmark identical scenarios. This section weighs the realistic candidates and gives an honest recommendation. **There is no single winner — the families are complementary — but for GenesisCA's specific architecture, CPM is the best *first* substrate, with a known ceiling.**

### 3.1 The candidates, scored against GenesisCA's goal

| Substrate | Cell shape | Division | Adjacency / topology | Per-cell rich state | 3D | Browser precedent | Fit to GenesisCA's lattice/SoA/compile stack |
|---|---|---|---|---|---|---|---|
| **Cellular Potts (CPM/GGH)** | **emergent, deformable, sub-cell resolution** | easy (split pixel set, relabel) | **implicit & free** (which IDs touch on the lattice) | rules over per-site + per-cell-ID state | same kernel, only param rescale | **Artistoo (pure JS, proven)** | **highest** — it *is* a lattice CA + Metropolis + energy + per-cell-ID bookkeeping |
| **Vertex model** | explicit, tightly controlled (polygons/polyhedra sharing edges) | mid (insert edge through centroid) | **explicit mesh; needs T1/T2 topological ops** | per-cell + edge state | "arguably the most technically challenging to extend to 3D" (Osborne 2017, verified verbatim) | none mature | low — mesh + topological transitions are alien to a lattice engine; worst browser fit; slowest framework benchmarked |
| **Center-based / off-lattice** (overlapping spheres, Voronoi; PhysiCell) | **none** (spherical points) | **trivial** (place 2 daughters on a mitotic axis) | distance-based or Delaunay/Voronoi graph | **richest** (PhysiCell: per-agent Phenotype + custom Cell_Functions; scales to 10⁵–10⁶ cells in 3D) | native (PhysiCell is 3D) | none browser-native at scale | medium — off-lattice force integration is a *different* engine; but the per-cell-rules + division story is ideal |
| **Subcellular element** | full deformable 3D | duplicate element cloud | distance-based | very rich | native | none | low — many elements per cell under Langevin dynamics; overkill for browser scale |
| **Phase-field / multi-phase-field** | beautiful deformable | PDE division | implicit (field overlap) | per-field | native | none | low — one PDE field *per cell* is the heaviest option; hostile to a per-cell-step compiler |

### 3.2 The honest recommendation

**Start with CPM, keep the node-graph engine-agnostic, and treat a center-based off-lattice mode as the natural *second* engine.** The reasoning:

1. **CPM is the lowest-friction first substrate for *this* codebase.** GenesisCA is already a lattice engine with per-attribute SoA typed arrays, precomputed neighbour-index tables, a node graph compiled to a per-cell step on JS/WASM/WebGPU, and a single-buffer async path. A CPM *is* a lattice CA with a Monte-Carlo accept/reject and an energy over neighbour pairs — it reuses ~60–70% of the stack. Vertex and center-based each require a *different* core (a mesh with topological transitions; off-lattice force integration) that shares far less.

2. **CPM gives free deformable shape AND free dynamic adjacency** — two of the user's explicit requirements — at the cost of physical rigour. "Which cells are adjacent" is just "which IDs touch on the lattice," computed implicitly each step with no mesh or Delaunay rebuild. This directly satisfies the "dynamic spatiality/adjacency inherent to a real multicellular system" requirement that vertex/Voronoi models must pay for with explicit T1/T2 topology edits.

3. **Division is easy on a lattice** (split a cell's site set along an axis, relabel half with a fresh ID) and **3D is incremental** (same Hamiltonian + kernel, only parameter rescaling + a bigger stencil). The 2D-now/3D-later trajectory is genuinely supported by the substrate.

4. **Artistoo is the only proven zero-install browser engine** in any of these families, and it is a CPM. That de-risks the entire endeavour and gives a behavioural oracle to validate against.

**But be brutally honest about CPM's ceiling** (the user should hear this up front):
- **CPM dynamics are non-physical.** Monte-Carlo "time" is not physical time; `T` couples adhesion + motility + surface roughness + effective size into one knob; and the modified Metropolis algorithm breaks detailed balance, so long-time behaviour is degenerate (cells can stochastically die out absent a no-extinction guard — Voss-Böhme 2012, verified). These are tolerable for morphogenesis pattern-formation but must be documented so users don't over-interpret parameters.
- **CPM is the *wrong* tool for confluent epithelial sheet-mechanics** — folding, tube/branch formation, T1 intercalation. That is *vertex-model* territory. If the project's morphogenesis goal drifts that way, a vertex engine is the right (but harder, browser-unfriendly) target — not a retrofit onto CPM.
- **For huge dispersed 3D populations with rich per-cell phenotype logic and trivial division**, the off-lattice center-based model (PhysiCell-style point + pairwise force) is the better complementary target. PhysiCell's per-agent Phenotype + user-assignable Cell_Functions is *exactly* the "arbitrary per-cell attributes + sophisticated rules" the user wants — and it is the substrate where division is genuinely trivial.

**Design consequence:** keep the node graph and the per-cell-step IR **engine-agnostic** at the abstraction level, so the same "per-cell update + per-cell attributes" nodes can later compile to a force-integration step (center-based) rather than only a lattice copy-attempt (CPM). CPM-first does not foreclose the off-lattice second engine; it accelerates getting *something* morphogenetic on screen.

---

## 4. Conceptual model — how CPM maps onto the Six Fundamentals, and the engine-paradigm decision

GenesisCA's model definition rests on Six Fundamentals (cells have computing power; N internal attributes = state; cells read neighbour states; writability; discrete space+time; synchronicity). CPM stretches several of them:

| Fundamental | Classical CA reading | CPM reading |
|---|---|---|
| **1. Computing power** | per-cell rule | the *graph* computes ΔH for a proposed copy; the *engine* does accept/reject + bookkeeping |
| **2. N attributes = state** | per-site attribute vector | per-*site* spin (cell-ID) + per-*biological-cell* object record (type, V, V_target, perimeter, centroid) — **a new tier** |
| **3. Read neighbours** | read neighbour states | read the neighbour *site's* spin + the *cell's* aggregate volume/perimeter |
| **4. Writability** | sync = own only; async = neighbours too | a copy *writes a neighbour site's spin* — async writability, already supported |
| **5. Discrete space+time** | grid + generations | grid + **MCS** (= N copy attempts), 2D now / 3D later |
| **6. Synchronicity** | sync (parallel) or async (sequential) | a **new** `cpm` mode: sequential, single-buffer, **stochastic accept/reject** — beyond async's deterministic per-cell sweep |

**The engine-paradigm decision (hard fit question #1).** Three options:
- **(A) Pure compile-to-per-cell-step.** *Rejected.* A per-site compiled function cannot read per-cell-ID volume, cannot do a transactional accept (write + two accumulator updates), and the loop shape is a sweep, not propose/accept. CPM cannot be expressed this way.
- **(B) Fully bespoke worker engine, no graph.** Workable but throws away GenesisCA's whole value proposition (author behaviour as a node graph). The energy terms *are* naturally a node graph (Artistoo proves the modular-constraint design), so hardcoding them is a waste.
- **(C) Hybrid (recommended).** A new worker-side Metropolis driver owns the loop, the per-cell-ID accumulators, the accept/reject, and the incremental bookkeeping; the **node graph is repurposed to compute a single scalar ΔH** for a proposed copy via a new energy/Hamiltonian event root (sibling to `Step`/`InitEvent`), reusing the existing value-node emitter library (reads, neighbour aggregates, arithmetic, `lookupTable` lookups, `GetRandom`). Division/growth/death are post-MCS structural events triggered from the graph but executed by the engine.

Hybrid is the equivalent of the Graph-CA investigation's "CSR" central finding: **the node graph stays the authoring surface, but a new engine path drives it.**

---

## 5. Data model & file format — the two-level state

### 5.1 The per-site spin (free)

`σ(x)` = an **integer cell attribute** (`AttributeType 'integer'` → `Int32Array`, [types.ts:9](../src/model/types.ts)). Int32 gives ~2.1 B distinct IDs — ample. The spin field needs **no new primitive**; it is a per-site attribute like any other, and cell *type* `τ` is a **tag attribute** (or derived from the per-cell-ID record).

### 5.2 The per-biological-cell object tier (the central new structure)

Per-cell-ID object properties (type, current volume, target volume, perimeter, target perimeter, centroid, age, lineage) have **no home** in today's two-tier schema (per-site attributes / global scalars). Sub-attributes ([Attribute.parentAttributeId](../src/model/types.ts:55-64)) look superficially similar but are *per-site storage with a parent-match guard* — they cannot store one value per biological cell. **A new tier is required.**

**Recommended shape:** a `cpm.cellObjectAttributes?` list on the CAModel (analogous to `attributes`, but indexed by cell ID) + a model-level `maxCells` capacity, and worker-side parallel typed arrays of length `maxCells` plus a **free-list** for ID recycling on death/division. Cell ID 0 = medium. These arrays are read by the energy graph and updated **incrementally** on every accepted copy.

**Critical:** because the WASM memory layout and typed arrays are allocated **once at init** ([initGrid, sim.worker.ts:750-800](../src/simulator/engine/sim.worker.ts)) and never resized mid-run, `maxCells` must be an **over-allocated ceiling** (with a free-list), not true dynamic growth. True growth would require a full reinit (losing run state). The per-site spin Int32Array absorbs new IDs trivially (division is a *site* relabel needing no reallocation); only the per-cell-ID accumulator arrays need the ceiling.

**Where the accumulators physically live (a real architectural fork — resolved).** Phase 2 (JS-only) keeps them as plain worker-side typed arrays. From **Phase 3 onward (the WASM energy kernel)** they are **promoted to a baked-in `wasmMemory` region** — exactly like the orientation and interaction-table regions — so the compiled WASM `GetCellVolume`/`GetCellPerimeter` read them directly at a fixed offset, with the JS driver touching them through typed-array *views* under the mandatory **copy-into-never-reassign** discipline (the documented "reassigning a view orphans WASM from JS mutations" gotcha). This is a *fork, not a detail*: a JS-side-only array would strand the WASM target and stall Phase 3, so the wasmMemory-baked layout is the single source of truth once WASM is in play.

**`maxCells` sizing policy + overflow behaviour (resolved).** Default `maxCells = clamp(initialDistinctCellIds × 4, 256, hardCap)` — a growth-headroom multiple of the seed count — user-overridable in the CPM panel. **Overflow is never silent:** a `DivideCell` that would exceed `maxCells` is *rejected* (the division is a no-op) and surfaced through the existing Stop-Event / blue-notice channel, the same way an end-condition pause is shown — never a wrap-around into a live ID. The free-list recycles the IDs of cells that reach volume 0 (death). Raising `maxCells` mid-run resizes the baked arrays, so it is a **structural change** that must trip the `attrsStructurallyEqual` reinit guard (§12.1), not a soft recompile.

### 5.3 The J adhesion matrix (reuse `lookupTable`)

The type×type contact-energy `J(τ,τ′)` maps **directly** onto the existing `lookupTable` model attribute with `rowKeySource = colKeySource = { kind: 'tagAttribute', attributeId: <cellType> }` ([types.ts:19-22, 74-87](../src/model/types.ts)) — a symmetric tag×tag float matrix. The `symmetric` flag already matches `J`'s symmetry; it is live-tunable via `updateLookupTable` ([sim.worker.ts:164](../src/simulator/engine/sim.worker.ts)) and serialises via `SimulationState.interactionTables` ([types.ts](../src/model/types.ts)). **No new attribute type.** Per-*type* target volumes (a vector indexed by type) fit a `tagAttribute × { kind: 'single' }` lookupTable; per-*cell-ID* targets live in the object tier (§5.2).

### 5.4 Parameters: `T`, `λ_V`, `λ_S`

Bounded float **model attributes** ([Attribute.hasBounds/min/max](../src/model/types.ts:39-43)) → range sliders, live-tunable via `updateModelAttrs` ([sim.worker.ts:171](../src/simulator/engine/sim.worker.ts)). `T` gets a default + a tooltip clarifying it is a membrane-fluctuation amplitude.

### 5.5 Serialization

The per-site spin serialises today (an integer cell attribute, already in `ATTR_TYPE_MAP`). New work:
- **Register the object-tier array kinds in `ATTR_TYPE_MAP`** ([fileOperations.ts:383-386](../src/model/fileOperations.ts)). **Hazard:** a missing entry silently falls through to `'float64'` and corrupts the round-trip — register at the same time the kind is added.
- **A new `SimulationState` field** for the variable-length object table + live cell count + ID free-list ([types.ts](../src/model/types.ts) — `SimulationState` only serialises per-site grid arrays sized to `total` today).
- **Bump `SCHEMA_VERSION`** ([schema.ts:10](../src/model/schema.ts), currently 2) with an additive migration (old files have no CPM tier).

---

## 6. Engine / worker — the Metropolis driver + incremental bookkeeping

### 6.1 The new driver loop

Add `updateMode = 'cpm'` (or a `cpm.enabled` sub-object that *forces* async-like single-buffer dynamics) and a worker branch in `runStep` ([sim.worker.ts:1097](../src/simulator/engine/sim.worker.ts)) that, instead of calling the compiled per-cell `runStep`, runs per MCS:

```
clear per-step flags
for k in 0..N:                       # N copy attempts = 1 MCS
  tgt = boundary.sampleRandom()      # boundary-edge sampler (DiceSet)
  src = randomNeighbour(tgt)         # reuse buildNeighborIndices tables
  if spin[src] == spin[tgt]: continue          # interior no-op
  if !localConnectivityOK(tgt, src): continue  # hard fragmentation veto
  dH = energyFn(tgt, src, spin[tgt], spin[src],
                volume[spin[tgt]], volume[spin[src]], ...)   # compiled ΔH graph
  if dH <= 0 || rand() < exp(-dH/T):           # Metropolis accept (xorshift32)
    volume[spin[tgt]]--; perimeter update...   # incremental bookkeeping
    spin[tgt] = spin[src]
    volume[spin[tgt]]++; perimeter update...
    boundary.update(tgt and neighbours)        # maintain edge list
post-MCS: growth (raise V_target), division/death (structural events), field diffusion
generation++  (one generation = one MCS)
```

Reuse: the async single-buffer aliasing ([sim.worker.ts:802-813](../src/simulator/engine/sim.worker.ts)), `buildNeighborIndices` ([sim.worker.ts:877](../src/simulator/engine/sim.worker.ts)), the shared xorshift32 RNG ([sim.worker.ts:849-850](../src/simulator/engine/sim.worker.ts)), and the per-step transient flag mechanism (`skippedArray`, [sim.worker.ts:870](../src/simulator/engine/sim.worker.ts)) as the model for a boundary-eligibility mask.

### 6.2 Incremental bookkeeping (hard fit question #3)

Volume/perimeter/centroid live in the per-cell-ID accumulator arrays (§5.2) **in the worker**, updated only on accepted copies — never recomputed (O(total) per attempt = catastrophic at 25M sites). The accumulators are *initialised* after Reset/Randomize/Load by one full scan binned by cell ID — reuse the existing per-step reduction pattern (`computeLinkedIndicatorsFromBuffer` / `computeSpatialIndicators`, [sim.worker.ts:1976, 2087](../src/simulator/engine/sim.worker.ts)) as the template, run *once* at init rather than per step.

**Mid-run mutation hooks — a silent-corruption hazard; do NOT mark these "reuse".** The accumulators are *derived from* the spin field, so **any** handler that mutates a site's spin outside the driver must keep them in sync. `paint` / `paintManual` / `writeRegion` / `clearRegion` / `importImage` and cell-level copy/paste all write `readAttrs[spin][idx]` directly ([paint handlers ~2444](../src/simulator/engine/sim.worker.ts)), bypassing the Reset/Randomize/Load re-scan. Each must either **incrementally patch** the touched cells' volume/perimeter/centroid (single-site brush — cheap) or **trigger a full re-scan** (large region / image import — simpler than tracking every touched cell). Cell *paste* additionally must **remap pasted cell-IDs through the free-list** — two disconnected pasted regions sharing a live ID would read as one fragmented "cell" — or, if that is too much for v1, cell copy/paste is **gated off** in CPM mode. Without these hooks every subsequent ΔH is computed against stale volumes and cells silently decay or explode: exactly the Amphiphile-NI-poisoning hazard class (§12.1), just triggered by interaction instead of init. The §10 Impact Map therefore marks brush/paint **modify**, not reuse.

**Perimeter costs more than volume (the pseudocode in §6.1 understates it).** Volume is a clean ±1 on exactly two cells. Perimeter (surface area in 3D) can change by **more than ±1** and can touch **more than two** cells in a single flip (CompuCell3D: *"copying a single pixel may cause surface change in more than two cells"*), so its update re-walks the flipped site's whole neighbourhood and adjusts several cells' perimeter accumulators — budget it as **O(neighbourhood) per accepted flip**, not O(1).

### 6.3 Boundary-edge sampler (efficiency, hard fit question #6)

A `borderpixels` DiceSet (O(1) insert/delete/sample) so attempts target only interfaces. Maintained incrementally via a per-site differing-neighbour counter (the `skippedArray` Uint8 region shows per-site flags are feasible; an edge *list* is the efficient structure). Without it, a packed tissue wastes nearly all attempts on interior sites.

### 6.4 Connectivity guard

A **hard** local-connectivity test (Durand & Guesnet 2016) evaluated *before* ΔH so fragmenting moves are cheaply rejected; optionally a **soft** large-ΔH penalty term. Engine-side, not graph-side (no flood-fill primitive exists in the node catalogue). **The test is *local*** — it inspects only the flipping site's own neighbourhood (an O(neighbourhood-size) pattern check, ~8 reads in 2D Moore), **not** a global connected-component scan — so it is genuinely cheap per attempt and belongs in the **headline (Phase 2), not deferred**: without it the cell-sorting demo can shatter into disconnected specks and look wrong. (The 2D local test does *not* guarantee single-connectedness in 3D — it must be revisited for Phase 6.)

### 6.5 Async fit and the accessor-CSE / hazard interactions

CPM is single-buffer, so it inherits async's compiler treatment: **accessor-CSE stays a no-op** ([accessorCSE.ts:28-37](../src/modeler/vpl/compiler/accessorCSE.ts) — a read can change after an intervening write) and the async read-after-write hazard analyser ([asyncWriteHazard.ts](../src/modeler/vpl/compiler/asyncWriteHazard.ts)) is *not authoritative* for CPM correctness because the **new driver owns ordering** — the ΔH graph is a pure read-only value function (no in-graph commit). Keep CSE off; treat the hazard analyser as belt-and-suspenders.

---

## 7. Compiler — the energy graph (all three targets) + RNG

### 7.1 The ΔH energy graph

Compile a **new energy/Hamiltonian event root** (sibling to `Step`/`InitEvent`) the way the compilers already emit a separate `init` entry. Its compiled function takes the proposed `(sourceSite, targetSite, srcType, tgtType)` + the affected cells' current `volume`/`perimeter` as inputs and **returns a scalar ΔH**. The existing value-node library covers the terms:
- **Adhesion ΔH:** `GetNeighborsAttribute` (the target's neighbourhood) → per-neighbour `lookupInteraction` (the J matrix) → `Aggregate(Sum)`, evaluated before-vs-after. `lookupInteraction` emits `_lookupTables[id][row*colCount+col]` ([LookupInteractionNode.ts:38](../src/modeler/vpl/nodes/LookupInteractionNode.ts)) — already a compiled value path on all three targets.
- **Volume/perimeter ΔH:** the closed-form quadratic difference `λ·Δ·(2(v−V_t)+Δ)` via `arithmeticOperator` nodes reading the cell's current volume (a new "Get Cell Volume" value node backed by the accumulator tier).
- **Metropolis accept:** the engine owns it, but `exp` is already an imported WASM host function + a JS/WGSL intrinsic in the Math node set — so even a graph-side `exp(−ΔH/T)` is cheap if ever needed.

### 7.2 New value nodes for the cell tier

`GetCellVolume`, `GetCellPerimeter`, `GetCellType`, `GetCellTargetVolume`, `GetNeighbouringCells`/contact-length — read the per-cell-ID accumulators (worker-provided), analogous to how today's nodes read per-site attributes. The `Step` event exposes no coordinates ([StepNode.ts](../src/modeler/vpl/nodes/StepNode.ts) — its only output port is `do`; only `InitEvent` exposes x/y, [InitEventNode.ts:24-27](../src/modeler/vpl/nodes/InitEventNode.ts)) — the energy/CPM event must expose the proposed site coordinates (the compiler already computes `_row`/`_col` internally, [compile.ts:1725-1726](../src/modeler/vpl/compiler/compile.ts)) for perimeter geometry and division-axis selection.

### 7.3 RNG & determinism (hard fit question #5)

JS/WASM share the xorshift32 stream (`_rngState[0]`, [GetRandomNode.ts:32-34](../src/modeler/vpl/nodes/GetRandomNode.ts)) — a single sequential proposal stream maps cleanly onto Metropolis. WebGPU's per-cell PCG is *useless* for a sequential proposal stream (it's seeded for parallel work). Document CPM as intrinsically stochastic, replay-only with a fixed seed, JS↔WASM reproducible.

### 7.4 Compiler-lockstep & WebGPU

The project's three-target lockstep rule applies, but CPM is **JS/WASM-only initially**: gate the new CPM nodes via the `requirements` capability mechanism (add a `cpm?` flag to `NodeRequirements`, [vpl/types.ts:76-81](../src/modeler/vpl/types.ts)) so WebGPU auto-rejects them (lockstep satisfied as a no-op rejection, mirroring the async-only nodes' `requirements.async` gate). Extend `detectWebGPUModelIncompatibilities` ([nodeValidation.ts](../src/modeler/vpl/nodes/nodeValidation.ts)) with a "CPM requires JS/WASM" check, and force-disable the WebGPU radio when CPM is on (mirror the existing async-radio-disabled-when-WebGPU pattern, [PropertiesPanelContent.tsx:165](../src/modeler/panels/PropertiesPanelContent.tsx)).

---

## 8. Node set & gating (hard fit question #9)

**New CPM nodes:**
- **Energy/Hamiltonian event root** (the ΔH entry point) — sibling to `Step`/`InitEvent`.
- **Energy-term value nodes** (optional sugar): Adhesion term, Volume-constraint term, Perimeter term, Chemotaxis term — each emitting a ΔH contribution summed into the root's output. (Mirrors Artistoo's pluggable constraints.)
- **Cell-property reads:** `GetCellVolume`, `GetCellPerimeter`, `GetCellType`, `GetCellTargetVolume`, `GetNeighbouringCells` / contact-length-with-type.
- **Structural-event flow nodes:** `DivideCell` (split a cell's site set along an axis, allocate a fresh ID, reseed daughter targets), `SetCellTargetVolume` (growth/death by ramping target), `SetCellType` (differentiation).
- **Chemical-field nodes** (Phase 5): `SecreteToField`, `SampleField`, plus a model-level field config (D, decay).

**Reused:** `GetNeighborsAttribute`, `Aggregate`, `lookupInteraction`/`interactionTableMap` (J matrix), `GetRandom`, `arithmeticOperator`/`exp`, the whole value-emitter library.

**Gated off in CPM mode:** the synchronous-only assumption nodes; nodes whose semantics assume "compute my own next state" rather than "contribute energy." The capability gate (`detectCapabilityRequirements`/`isNodeAvailable`, [nodeValidation.ts:440-464](../src/modeler/vpl/nodes/nodeValidation.ts)) handles palette/badge filtering; the compiler's requirements-rejection loop ([compile.ts:1336-1353](../src/modeler/vpl/compiler/compile.ts)) handles hard rejection.

**Neighborhood validity (a CPM-mode constraint that's easy to break silently).** The *same* stencil drives **both** the copy-attempt candidate set **and** the adhesion `(1−δ)` sum, so in CPM mode the neighbourhood must be a **contiguous adjacency** (von Neumann / Moore), not an arbitrary user-drawn offset set — a disconnected or long-range stencil silently breaks the physics. v1 pins CPM to a built-in von Neumann/Moore stencil and adds a Neighborhoods-panel validity guard that rejects non-contiguous stencils while CPM is on; a *separate, larger* 2nd-order adhesion-interaction neighbourhood is an advanced later option.

**The energy root is RNG-free and flow-sink-free (determinism + reachability).** The driver owns the proposal/accept RNG stream — draw order per attempt is **border-sample → neighbour-pick → accept-draw**, all off the shared `_rngState[0]` — so `GetRandom` is gated **off inside the energy root** (a graph-side RNG draw would race the driver's accept draw on the same stream → non-reproducible runs). For the same structural reason, `StopEvent` is **unreachable** from a pure-ΔH value root (it has no flow sink to fire from) and is gated off there; *end-conditions still work*, evaluated **per-MCS** by the driver (§10), and "one generation = one MCS" redefines what `maxGenerations` counts.

---

## 9. Visualization (hard fit question #8)

CPM is still a 2-D lattice, so **~70–80% of the renderer is reusable as-is**: the worker fills one RGBA quad per site into the `colors` buffer ([sim.worker.ts:1699](../src/simulator/engine/sim.worker.ts)), and `SimulatorView` blits it via `new ImageData(colors.buffer, w, h)` + scaled `drawImage` ([SimulatorView.tsx:780-784, 906-925](../src/simulator/SimulatorView.tsx)). **Colouring a site by its cell-ID or type is just an Output Mapping that writes this same buffer — zero new render path.** Brush seeding (paint a contiguous patch with one cell ID — [paint/paintManual](../src/simulator/SimulatorView.tsx:2444-2447)), zoom/pan, infinity tiling, recording, and the per-site inspector ([InspectCellPopover.tsx](../src/simulator/InspectCellPopover.tsx) — a `cellId`/`type`/`volume` row appears for free) all carry over.

**New render work (localised, additive):**
- **Membrane/boundary drawing** — a new per-site pass in `draw()` ([SimulatorView.tsx:742](../src/simulator/SimulatorView.tsx)) that strokes an edge where a neighbour's cell-ID differs. (Today's only edge-stroking is the *uniform* gridline pass [931-963] and the brush silhouette — neither reads neighbour cell-ID; gridlines are NOT membranes.)
- **Colour-by-cell-ID at scale** — the only categorical node, `categoricalColor` ([CategoricalColorNode.ts:7-19](../src/modeler/vpl/nodes/CategoricalColorNode.ts)), needs a *design-time fixed* palette count; it cannot map hundreds of runtime cell IDs. Add a runtime **hash-id→RGB** value-node (lockstep) or a render-time recolor mode.
- **Chemical-field heatmap overlay** — a second RGBA buffer composited over the cell view; follows the existing glyph-fallback double-blit pattern ([SimulatorView.tsx:877-903](../src/simulator/SimulatorView.tsx)) — a small addition, not a rewrite. A field is itself a float attribute coloured by a Color Scale, so a *single* field view already works; the *overlay* (field under cells) is the new piece.
- **Centroid/track markers** — entirely new (no vector/path overlay primitive); also needs the per-cell-ID centroid reduction (engine-side).

**Direct-render gotcha:** under WebGPU direct render the full colors buffer is *not* on the main thread ([SimulatorView.tsx:1176-1186](../src/simulator/SimulatorView.tsx)). Since CPM is JS/WASM-only, the membrane/centroid main-thread overlays are unaffected — but document the constraint for any future WebGPU CPM.

**3D** is the only wholesale renderer change (Canvas2D is hard-wired, [SimulatorView.tsx:754](../src/simulator/SimulatorView.tsx)) — but it is well isolated behind `draw()`/`colorsRef`, and the existing WebGPU OffscreenCanvas direct-render proves an alternate renderer can sit behind the same `colors` contract.

---

## 10. Subsystem Impact Map

Every touch-point, grouped, colour-coded by the kind of change. **Reuse (the encouraging story): the SoA state engine, the async single-buffer + orderArray substrate, the colors-buffer/blit pipeline, the inspect/paint protocol, the `lookupTable` (J-matrix), model-attribute sliders, and indicators all largely carry over.** The concentrated *new* work is the per-cell-ID tier, the Metropolis driver, and division/fields.

**Legend:** ◼ reuse as-is · ◼ modify · ◼ new · ◼ gate off

### Schema & state
| Change | Kind | File / symbol |
|---|---|---|
| `cpm?: CpmConfig` sub-object (enabled, cellIdAttributeId, maxCells, T/λ refs, adhesionTableId, cellObjectAttributes) | **new** | [types.ts](../src/model/types.ts) (template: `VariegatedCellsConfig`, types.ts:470-483) |
| Per-cell-ID object tier (`cellObjectAttributes`) | **new** | [types.ts](../src/model/types.ts) CAModel |
| `UPDATE_CPM` reducer action + attribute-delete cascade (clear cellIdAttributeId) | **modify** | [ModelContext.tsx](../src/model/ModelContext.tsx) (template: `UPDATE_VARIEGATED_CELLS`, ModelContext.tsx:892-900) |
| LOAD_MODEL migration guard (additive) + `SCHEMA_VERSION` bump | **modify** | [ModelContext.tsx:697-752](../src/model/ModelContext.tsx), [schema.ts:10](../src/model/schema.ts) |
| Per-site SoA attribute storage (spin = integer attr) | **reuse** | [sim.worker.ts:796-810](../src/simulator/engine/sim.worker.ts) |
| Dead `topology` field → promote to `lattice`/`dimensions` (2D/3D) | **modify** | [types.ts:203](../src/model/types.ts) (zero readers — confirmed safe) |

### Engine & driver
| Change | Kind | File / symbol |
|---|---|---|
| `updateMode='cpm'` Metropolis driver (propose/accept loop) | **new** | [sim.worker.ts:1097 runStep](../src/simulator/engine/sim.worker.ts) |
| Per-cell-ID accumulator arrays (volume/perimeter/centroid, length maxCells) + free-list | **new** | initGrid region ([sim.worker.ts:750](../src/simulator/engine/sim.worker.ts)); layout ([wasm/layout.ts](../src/modeler/vpl/compiler/wasm/layout.ts)) |
| Boundary-edge sampler (DiceSet) + differing-neighbour counter | **new** | [sim.worker.ts](../src/simulator/engine/sim.worker.ts) (model: `skippedArray`:870) |
| Local connectivity guard (Durand-Guesnet) | **new** | engine-side |
| Division / growth / death structural events (post-MCS) | **new** | engine-side; triggered by `DivideCell`/`SetCellTargetVolume` nodes |
| Accumulator init scan after Reset/Randomize/Load | **new** | template: [computeLinkedIndicatorsFromBuffer:1976](../src/simulator/engine/sim.worker.ts) |
| Async single-buffer aliasing + orderArray | **reuse** | [sim.worker.ts:802-813, 859-874](../src/simulator/engine/sim.worker.ts) |
| `buildNeighborIndices` (torus/constant boundary) | **reuse** | [sim.worker.ts:877](../src/simulator/engine/sim.worker.ts) |
| xorshift32 RNG in memory | **reuse** | [sim.worker.ts:849-850](../src/simulator/engine/sim.worker.ts) |

### Compiler & nodes
| Change | Kind | File / symbol |
|---|---|---|
| Energy/Hamiltonian event root (compiles to a scalar-ΔH fn) | **new** | [compile.ts](../src/modeler/vpl/compiler/compile.ts) (model: the `init` entry) |
| Cell-property read nodes (volume/perimeter/type/target) | **new** | new node files |
| `DivideCell` / `SetCellTargetVolume` / `SetCellType` flow nodes | **new** | new node files (gate: `requirements.cpm`) |
| `NodeRequirements += cpm?` capability flag | **modify** | [vpl/types.ts:76-81](../src/modeler/vpl/types.ts) |
| `detectCapabilityRequirements`/`isNodeAvailable` + WebGPU/Wasm incompat | **modify** | [nodeValidation.ts:440-464, 540-546](../src/modeler/vpl/nodes/nodeValidation.ts) |
| `lookupInteraction` (J matrix) value emit, all 3 targets | **reuse** | [LookupInteractionNode.ts:38](../src/modeler/vpl/nodes/LookupInteractionNode.ts) |
| `GetNeighborsAttribute`→`Aggregate`, arithmetic, `exp`, `GetRandom` | **reuse** | value-emitter library |
| Accessor-CSE off + hazard analyser non-authoritative | **reuse** | [accessorCSE.ts:28-37](../src/modeler/vpl/compiler/accessorCSE.ts) |
| WebGPU per-cell-parallel emit (sequential CPM incompatible) | **gate off** | [webgpu/compile.ts](../src/modeler/vpl/compiler/webgpu/compile.ts) |

### Rendering & interaction
| Change | Kind | File / symbol |
|---|---|---|
| Membrane/boundary edge-draw pass | **new** | [SimulatorView.tsx:742 draw()](../src/simulator/SimulatorView.tsx) (beside gridlines:963) |
| Hash-id→RGB colour mode (many cells) | **new** | new value-node OR render mode |
| Chemical-field overlay (composited blit) | **new** | model: glyph-fallback double-blit [877-903](../src/simulator/SimulatorView.tsx) |
| Centroid/track markers + per-cell centroid reduction | **new** | render + engine |
| colors-buffer blit / ImageData / drawImage | **reuse** | [SimulatorView.tsx:780-784, 906-925](../src/simulator/SimulatorView.tsx) |
| Output-Mapping/viewer-tab pipeline (colour by cell-ID/type) | **reuse** | [SimulatorView.tsx:3921](../src/simulator/SimulatorView.tsx) |
| Brush / manual-brush seeding — **needs the §6.2 accumulator-patch hook** | **modify** | [paint/paintManual:2444-2447](../src/simulator/SimulatorView.tsx) |
| Per-site inspector (cellId/type/volume rows) | **reuse** | [InspectCellPopover.tsx](../src/simulator/InspectCellPopover.tsx) |
| 3D renderer (Canvas2D hard-wired) | **new** (Phase 6) | [SimulatorView.tsx:754](../src/simulator/SimulatorView.tsx); seam: directRender/OffscreenCanvas |

### Files, export, misc
| Change | Kind | File / symbol |
|---|---|---|
| `ATTR_TYPE_MAP` += object-tier kinds (silent-corruption hazard) | **modify** | [fileOperations.ts:383-386](../src/model/fileOperations.ts) |
| `SimulationState` += object table + live cell count + free-list | **modify** | [types.ts SimulationState](../src/model/types.ts) |
| `.gcastate` validation (cellCount/maxCells, not just grid dims) | **modify** | `applySimulationState` |
| `attrsStructurallyEqual` reinit guard += CPM layout fields | **modify** | [SimulatorView.tsx:1916-1930](../src/simulator/SimulatorView.tsx) |
| `initMsg` += CPM payload (maxCells, object-tier, J table) | **modify** | [SimulatorView.tsx:1700-1760](../src/simulator/SimulatorView.tsx) |
| Properties→Execution CPM toggle (forces async, disables WebGPU) | **modify** | [PropertiesPanelContent.tsx:165, 228, 288-304](../src/modeler/panels/PropertiesPanelContent.tsx) |
| ActivityBar CPM tab (gated on cpm.enabled) + ModelerView auto-switch | **modify** | [ActivityBar.tsx:47-49](../src/modeler/ActivityBar.tsx), [ModelerView.tsx:86-87](../src/modeler/ModelerView.tsx) |
| Reaction-diffusion chemical-field subsystem (Phase 5) | **new** | worker + a second scalar grid + secretion/diffusion pass |
| Recording / presentation export | **reuse** | included for free (renders whatever `draw()` produces) |
| Linked/spatial indicators (per-type counts, total volume metrics) | **reuse** | [sim.worker.ts:1976, 2087](../src/simulator/engine/sim.worker.ts) |
| `J` matrix UI (tag×tag editor) | **reuse** | existing `LookupTableEditor` |

### Subsystems that stay (mostly) unchanged — explicit verdict + CPM catch
*(The Impact Map above is thorough on new work; these seven are the "is X handled?" questions, answered.)*

| Subsystem | Verdict | CPM-specific catch |
|---|---|---|
| Undo/redo (graph history), Macros | **reuse** | authoring-layer only; unaffected by the runtime engine swap |
| End conditions (`maxGenerations`, indicator rules) | **reuse** | evaluated **per-MCS**; "one generation = one MCS" rescales `maxGenerations` |
| `StopEvent` node | **gate off** (in energy root) | a pure-ΔH *value* root has no flow sink to fire it; end-conditions cover the need |
| Manual brush (per-attribute runtime brush) | **modify** | the natural "stamp a cell ID" seeding tool — needs the §6.2 accumulator hook |
| Cell copy/paste / cut (Ctrl+C/V/X) | **modify or gate off** | must remap pasted IDs through the free-list + re-scan, else ID-collision = a fragmented "cell"; disable in CPM if deferred |
| Recording (GIF/WebM) | **reuse** | captures `draw()` output — but confirm the new membrane/centroid/field overlay passes actually land in the captured frames (the §9 direct-render gotcha) |
| Presentation HTML export (self-contained Simulator+model) | **modify** | must serialize the per-cell-ID tier + `maxCells` + free-list + J-table **and ship the bespoke Metropolis driver**, not the compiled per-cell step |
| Space = step | **modify** | advances **one MCS** (N attempts — a visible jump); sub-MCS single-attempt stepping is a later debug affordance |

---

## 11. Phased plan (if it were built)

Sequenced so the headline demo — **2D cell sorting from differential adhesion** — lands as early as Phase 2, exactly as Graner & Glazier 1992 used it as the founding validation. **Currently parked at "research only."**

- **Phase 0 — decisions.** Confirm hybrid engine, `maxCells` ceiling + free-list, mode flag = `cpm.enabled` (single source of truth), JS/WASM-only, the four §12 hazard contracts.
- **Phase 1 — data model + per-cell-ID tier.** `cpm` config sub-object; object-tier arrays in the worker; J-matrix via `lookupTable`; `T`/`λ_V` model attributes; accumulator init scan. Serialization + reinit guard.
- **Phase 2 — Metropolis driver + adhesion+volume energy graph (JS) + connectivity guard. ★ headline: 2D cell sorting.** Boundary sampler; accept/reject; incremental volume bookkeeping; **the hard local-connectivity guard from the start** (cheap, local — without it the demo can fragment); the energy event root + Adhesion + Volume nodes; colour-by-type Output Mapping. The unambiguous correctness test (dense core engulfs the looser shell).
- **Phase 3 — WASM target + perimeter + membranes.** Port the driver/energy to WASM and **promote the accumulators to the baked `wasmMemory` region** (§5.2); perimeter constraint + neighbourhood-rewalk bookkeeping; membrane render pass; colour-by-cell-ID (hash mode).
- **Phase 4 — growth + division + death (the morphogenesis on-ramp).** `SetCellTargetVolume` growth; necrosis (shrink V_target → free-list recycle); and `DivideCell` — **the hardest correctness step**: compute the cleavage plane through the centroid ⟂ the major principal axis from the per-cell **second-moment accumulators** (Σx, Σy, Σx², Σy², Σxy — the same state the Length term needs, so add it as a division prerequisite, not an afterthought), assign sites by side of the plane, **then run a per-daughter connected-component repair** that reassigns stragglers so a non-convex split cannot leave a disconnected daughter, allocate a fresh ID from the free-list, and reseed both daughters' V_target. This is where division/morphogenesis becomes real.
- **Phase 5 — chemical fields + chemotaxis + Act migration.** Reaction-diffusion scalar field(s); secrete/sample nodes; chemotaxis ΔH term; field heatmap overlay; the Act persistent-migration model. Validate vs Dictyostelium-style aggregation (Savill & Hogeweg) and a contact-inhibited-chemotaxis vascular network (Merks 2008).
- **Phase 6 — 3D.** 3D lattice + stencil + parameter rescaling (same Hamiltonian/kernel); a new WebGL/WebGPU renderer behind the `draw()`/`colors` seam. (WebGPU *compute* CPM via checkerboard is a separate, later decision.)

Validate each phase against literature benchmarks (sorting → growth+division → chemotaxis morphogenesis) using Artistoo as a behavioural oracle, not bit-exact cross-target parity (WGSL f32 + per-cell RNG already preclude that, and parallel CPM intentionally matches statistics, not trajectories).

---

## 12. Risks, open questions & decisions to confirm

**Silent-corruption hazards (decide these up front — they fail *quietly*):**
1. **`maxCells` lifecycle.** The per-cell-ID accumulator arrays are sized once. A stale `maxCells` after a Regenerate/Import/Reset that births more cells → overflow / wrong cell loses volume. Make it derived-on-change, re-uploaded to the worker, re-baked into the layout, and add it to the `attrsStructurallyEqual` reinit guard ([SimulatorView.tsx:1916-1930](../src/simulator/SimulatorView.tsx)) — exactly the class of bug the Amphiphile NI-poisoning fix addressed.
2. **`ATTR_TYPE_MAP` omission.** A missing entry for an object-tier array kind silently mislabels it `'float64'` and corrupts the `.gcaproj`/`.gcastate` round-trip ([fileOperations.ts:374-386](../src/model/fileOperations.ts)). Register at the same commit.
3. **`.gcastate` validation.** `applySimulationState` validates grid dims today; a CPM snapshot also has a `maxCells`/cellCount/free-list — mismatches must be rejected cleanly (there's no try/catch around deserialize, so a throw silently aborts the whole load).
4. **Single source of truth for the mode.** Drive everything off `cpm.enabled`; leave the dead `topology` enum derived/display-only. Add worker-side mutual-exclusion safety nets (CPM ⟂ WebGPU; CPM forces async) for hand-edited files — mirror the existing `useWasm`/`useWebGPU` net ([sim.worker.ts:2390-2399](../src/simulator/engine/sim.worker.ts)).

**Open questions for the user:**
- **Substrate confirmation (§3).** Is CPM the agreed starting substrate, or does the morphogenesis goal lean toward off-lattice (center-based) division-heavy populations, or vertex-style sheet mechanics? CPM-first is the recommendation, but the answer shapes whether the engine-agnostic IR work in Phase 0 is worth front-loading.
- **Authoring surface.** Should users *author* the Hamiltonian as energy-term nodes (maximally flexible, the Artistoo/Morpheus philosophy), or pick from a few fixed terms with parameters (simpler, less powerful)? **Recommendation: hybrid, built-in-terms-first** — ship the canonical terms (J-matrix adhesion, volume, perimeter) as built-in parameterised terms for the zero-friction path, **and** expose the energy root so advanced users can add custom ΔH-contribution nodes the driver sums on top. This mirrors the existing Linked-Output-Mappings "auto + override" philosophy and matches GenesisCA's accessibility goal without capping power.
- **Scope of v1.** Sorting-only (Phases 0–2) as a feasibility spike, or commit through division (Phase 4)? Division is where the morphogenesis payoff is, but also the largest new capability (free-list, connectivity, splitting + the cleavage/CC-repair geometry of §11). **Recommendation: gate the decision on whether Phase 2 cell-sorting validates against Artistoo** — prove the engine paradigm first, then commit to division.
- **Chemical fields (reaction-diffusion).** Must-have for any *interesting* morphogenesis — but a genuinely new subsystem (a PDE layer). In or out of the first real milestone? **Recommendation: out of the headline v1, first post-MVP (Phase 5).** Cell-sorting + volume/adhesion + division is already a complete, compelling story; chemical fields are a whole reaction-diffusion grid + secrete/sample plumbing — but chemotaxis is the single most-requested extension, so they are the natural *first* addition once the core is proven.

---

## 13. Verified bibliography (annotated)

**Confidence:** all 13 anchor works below confirmed against arXiv / DOI / PubMed / publisher; Artistoo internals confirmed against the GitHub source. Two metadata corrections noted in §2.7 (a conflated Popławski citation; a wrong Chen-2007 DOI) — both underlying papers real.

**Foundations & dynamics**
- **Graner & Glazier (1992)** Simulation of biological cell sorting using a two-dimensional extended Potts model. *Phys. Rev. Lett.* 69(13):2013–2016. doi:10.1103/PhysRevLett.69.2013. — *The founding CPM paper: large-Q extended Potts + differential adhesion + area constraint; cell sorting.*
- **Glazier & Graner (1993)** Simulation of the differential adhesion driven rearrangement of biological cells. *Phys. Rev. E* 47(3):2128–2154. doi:10.1103/PhysRevE.47.2128. — *Full long-form formulation; the canonical Hamiltonian + dynamics reference.*
- **Steinberg (1963)** Reconstruction of tissues by dissociated cells. *Science* 141(3579):401–408. — *The Differential Adhesion Hypothesis CPM operationalises.* (**1970**, *J. Exp. Zool.* 173(4):395–433, develops the surface-tension hierarchy.)
- **Wu (1982)** The Potts model. *Rev. Mod. Phys.* 54(1):235–268. — *The q-state Potts model CPM extends (Ising = q=2).*
- **Metropolis et al. (1953)** Equation of state calculations by fast computing machines. *J. Chem. Phys.* 21(6):1087–1092. — *The `min(1, exp(−ΔE/T))` acceptance CPM specialises.*
- **Durand & Guesnet (2016)** An efficient Cellular Potts Model algorithm that forbids cell fragmentation. *Comput. Phys. Commun.* 208:54–63. arXiv:1609.03832. — *Local connectivity test, no fragmentation at all T, faster, preserves detailed balance.*

**Hamiltonian extensions & applications**
- **Savill & Hogeweg (1997)** Modelling morphogenesis: from single cells to crawling slugs. *J. Theor. Biol.* 184(3):229–235. — *First CPM–PDE (cAMP chemotaxis) coupling; the "H" in GGH.*
- **Niculescu, Textor & de Boer (2015)** Crawling and gliding: a computational model for shape-driven cell migration. *PLoS Comput. Biol.* 11(10):e1004280. — *The Act persistent-migration model (geometric-mean activity).*
- **Marée & Hogeweg (2001)** How amoeboids self-organize into a fruiting body. *PNAS* 98(7):3879–3883. — *Landmark CPM morphogenesis (adhesion + chemotaxis + differentiation + division → 3D culmination).*
- **Merks, Perryn, Shirinifard & Glazier (2008)** Contact-inhibited chemotaxis in de novo and sprouting blood-vessel growth. *PLoS Comput. Biol.* 4(9):e1000163. — *Canonical CPM angiogenesis/vasculogenesis.*
- **Szabó & Merks (2013)** Cellular Potts modeling of tumor growth, tumor invasion, and tumor evolution. *Front. Oncol.* 3:87. — *CPM cancer modelling (Gompertzian growth, necrotic cores, fingering invasion).*
- **Hirashima, Rens & Merks (2017)** Cellular Potts modeling of complex multicellular behaviors in tissue morphogenesis. *Dev. Growth Differ.* 59(5):329–339. doi:10.1111/dgd.12358. — *Tutorial review; four worked morphogenesis examples.*
- **Scianna & Preziosi (2012)** Multiscale developments of the cellular Potts model. *Multiscale Model. Simul.* 10(2):342–382; and (2013) *Cellular Potts Models* (Chapman & Hall/CRC, ISBN 9781466514782). — *Authoritative multiscale-extension review + book.*

**Software, visualization & performance**
- **Wortel & Textor (2021)** Artistoo, a library to build, share, and explore simulations of cells and tissues in the web browser. *eLife* 10:e61288. doi:10.7554/eLife.61288. — ***The* browser-CPM existence proof + modular-constraint architectural template; benchmarked at/above C++ Morpheus.*
- **Swat, Thomas, Belmonte, Shirinifard, Hmeljak & Glazier (2012)** Multi-scale modeling of tissues using CompuCell3D. *Methods Cell Biol.* 110:325–366. — *Reference C++/Python CPM; full constraint catalogue, Mitosis plugin, 2D/3D, the de-facto feature spec.*
- **Starruß, de Back, Brusch & Deutsch (2014)** Morpheus: a user-friendly modeling environment for multiscale and multicellular systems biology. *Bioinformatics* 30(9):1331–1332. — *No-code declarative (MorpheusML) CPM + ODE + reaction-diffusion; closest spiritual analogue to GenesisCA's accessibility goal.*
- **Chen, Glazier, Izaguirre & Alber (2007)** A parallel implementation of the Cellular Potts Model. *Comput. Phys. Commun.* 176(11–12):670–681 (correct doi:10.1016/j.cpc.2007.03.007). — *Checkerboard-subgrid MPI parallel CPM; 10⁷+ cells.*
- **Tapia & D'Souza (2011)** Parallelizing the Cellular Potts Model on graphics processing units. *Comput. Phys. Commun.* 182(4):857–865. — *GPU checkerboard + atomic CAS on the per-cell volume array; ~80× over serial, up to 256³.*
- **Sultan, Devi, Mueller & Textor (2023)** A parallelized cellular Potts model that enables simulations at tissue scale. arXiv:2312.09317. — *GPU CPM (Artistoo group); waiting-time-distribution bias analysis; ~3500×/25000×/600× speedups, millions of cells.*
- **Berghoff, Rosenbauer, Hoffmann & Schug (2020)** Cells in Silico. *BMC Bioinformatics* 21:436. — *Large-scale CPU/MPI CPM; per-cell "Additional Cell Data" under domain decomposition; 1000³ voxels.*

**Substrate-comparison & alternatives (for §3)**
- **Osborne, Fletcher, Pitt-Francis, Maini & Gavaghan (2017)** Comparing individual-based approaches to modelling the self-organization of multicellular tissues. *PLoS Comput. Biol.* 13(2):e1005387. — *The five-family head-to-head (CA, CPM, overlapping-spheres, Voronoi, vertex) in one framework; runtime ranking CA<CP<OS≈VT<VM; "vertex … most technically challenging to extend to 3D."*
- **Fletcher, Osterfield, Baker & Shvartsman (2014)** Vertex models of epithelial morphogenesis. *Biophys. J.* 106(11):2291–2304. — *The vertex standard; T1/T2/division topological transitions.*
- **Ghaffarizadeh, Heiland, Friedman, Mumenthaler & Macklin (2018)** PhysiCell: an open source physics-based cell simulator for 3-D multicellular systems. *PLoS Comput. Biol.* 14(2):e1005991. — *Off-lattice center-based; richest per-cell state (Phenotype + custom Cell_Functions); trivial division; 10⁵–10⁶ cells in 3D; "PhysiCell does not model cell morphology."*
- **Voss-Böhme (2012)** Multi-scale modeling in morphogenesis: a critical analysis of the cellular Potts model. *PLoS One* 7(9):e42852. — *The essential CPM caveat: broken detailed balance, degenerate long-time behaviour (cell extinction), parameter coupling, non-physical time.*
- **Sandersius & Newman (2008)** Modeling cell rheology with the Subcellular Element Model. *Phys. Biol.* 5(1):015002. — *The high-fidelity/high-cost SEM end of the spectrum.*
- **Mirams et al. (2013)** Chaste: an open source C++ library for computational physiology and biology. *PLoS Comput. Biol.* 9(3):e1002970. — *One API spanning CPM/CA/centre-based/Voronoi/vertex — the "swappable spatial engines" architectural precedent.*

---

*Companion visual: `docs/INVESTIGATION_CPM.html` (self-contained inline SVG/CSS/JS). Status: research reference — no implementation planned.*

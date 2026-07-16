# CompuCell3D vs GenesisCA — Capability Comparison & Gap-Closure Draft

> **Status:** research + source-verified comparison + a *general* gap-closure roadmap. This is a **strategic precursor**, not a commitment to build and not a formal per-feature plan. Per the project convention, formal `PLAN_*.md` + HTML mockups come per-workstream *after* scope decisions. No code has changed.
>
> **How this was produced:** direct reading of the downloaded CompuCell3D source (`CompuCell3D-master/`, the actual current C++ core + Python package — ~1,090 C++ core files, ~233 Python files, 309 example `.cc3d` projects) via four parallel source deep-dives (Potts core engine, the 55-plugin catalogue, the PDE-solver/steppable suite, the Python/CC3DML/SBML layer), cross-checked against the CC3D website, Wikipedia, and the scientific literature; combined with GenesisCA's own prior feasibility studies [INVESTIGATION_CPM.md](INVESTIGATION_CPM.md) and [INVESTIGATION_CENTER_BASED.md](INVESTIGATION_CENTER_BASED.md) and the current shipped state (per [CLAUDE.md](../CLAUDE.md): classic-CA + the bond-graph agent engine + the 3-target compiler + fields + Overseer).
>
> **Read §1 first.** The honest headline is that "make GenesisCA simulate everything CompuCell3D can" is not a feature or even a milestone — it is **three genuinely-new engines/tiers + a large energy-term library + a scientific ecosystem**, layered on plumbing GenesisCA already has. But a *surprisingly large fraction of CC3D's actual biology is already reachable* through GenesisCA's shipped **center-based agent engine** — via a different substrate. The document separates "the irreducible CC3D-only core" from "already covered, differently."

---

## 1. Executive summary

**What CompuCell3D is.** CC3D is a mature (20+ year), open-source, **multiscale virtual-tissue modelling framework** built on the **Cellular Potts Model (CPM / Glazier–Graner–Hogeweg)**. Its defining idea: a *biological cell is a connected domain of many lattice pixels/voxels sharing one cell-ID*, and the tissue evolves by **Metropolis Monte-Carlo energy minimization** — repeatedly propose copying a neighbour's cell-ID into a boundary pixel, accept with probability `min(1, exp(−ΔH/T))` against an effective energy (Hamiltonian) `H`. On top of that deformable-cell substrate it couples **three biological scales**: CPM cells (tissue morphodynamics) + **PDE reaction-diffusion chemical fields** (a suite of ~13 solvers) + **subcellular ODE reaction networks** (an independent SBML/libRoadRunner integrator *inside every cell*, plus MaBoSS Boolean networks). Models are authored in CC3DML (declarative XML) or `PyCoreSpecs` (Python) for the physics, plus **Python "steppables"** for imperative control logic; run in a Qt **Player** (VTK visualization) or headless for HPC parameter sweeps. It ships ~309 validated example models and underpins a large published literature (tumour growth, angiogenesis, somitogenesis, gastrulation, branching morphogenesis, immunology, tissue engineering, toxicology).

**What GenesisCA is (for contrast).** A **browser-based, zero-install, node-graph (visual programming) Cellular-Automata IDE** that compiles the graph to **three real targets (JS / WASM / WebGPU)** and runs it in a Web Worker. Its cell model is the *classic* CA (one cell = one lattice site with N typed attributes), 2D and 3D, up to 5000²+/large volumes, sync or async. Crucially, GenesisCA also **already ships a second engine** — the **center-based "bond-graph agent" engine** (PhysiCell-style off-lattice soft spheres with forces, bonds, growth, division, death, and a closed agent↔grid field feedback) — which the team built *instead of* CPM after explicitly investigating both.

**The central finding.** CC3D and GenesisCA aim at overlapping *biology* (tissue morphogenesis: adhesion, sorting, chemotaxis, division, fields) but from **different engine paradigms**. "Everything CC3D can do" decomposes into these buckets:

| Bucket | GenesisCA today | Verdict |
|---|---|---|
| **The CPM deformable-cell substrate** (extended shape, membrane fluctuation, sorting/engulfment by *surface energy*, precise volume/surface/length constraints, compartmentalized cells) | **None** (classic CA is 1-cell-1-site; agents are rigid spheres) | **The irreducible CC3D-only core. A new 3rd engine.** |
| **The CPM energy-term library** (Contact/differential adhesion, Chemotaxis, FocalPointPlasticity/Elasticity links, Connectivity, Polarization, ExternalPotential, LengthConstraint…) | **Partial, in the *agent* paradigm** (adhesion, bonds/springs, chemotaxis-via-force, external force all exist as agent nodes; the lookup-table *is* the adhesion J-matrix) | **Concept largely reachable; CPM-native form is new.** |
| **PDE reaction-diffusion field suite** (named multi-field, per-cell-type diffusion constants, secretion/uptake, per-face boundary conditions, steady-state, stability auto-scaling) | **Partial** (the grid *is* a field; Gray-Scott reaction-diffusion ships; the agent↔grid field bridge does secrete/sample/gradient) — but no parameterized named-field *solver* abstraction | **Extend, don't invent.** |
| **Subcellular ODE / SBML reaction networks** (per-cell CVODE integrator, SBML/Antimony import, MaBoSS Boolean) | **Zero** (confirmed — no ODE integrator, no SBML anywhere in the codebase) | **Genuinely new tier. Big lift.** |
| **Cell lifecycle** (growth, division with orientation control, death, differentiation) | **Yes, in the agent engine** (tension-axis eigensolve division, growth ramp, death, type switching); classic-CA cells cannot divide | **Covered for agents; CPM needs a pixel-split.** |
| **Scientific ecosystem** (VTK/PIF output, restart/reproducibility, parameter scans, ~309 validated demos, the Python escape hatch, HPC/batch) | **Partial** (Overseer *is* a built-in parameter-scan + replicate-statistics engine; `.gcaproj`/`.gcastate` serialization; presentation export) — but no standard scientific I/O, no scripting escape hatch, a small model library | **Overseer is a real asset; the rest is a long tail.** |

**The honest verdict (expanded in §5).** Literally matching CC3D is a **multi-year, multi-engine program** — CC3D is two decades of specialized computational biology. *But* GenesisCA's shipped agent engine already reaches a large fraction of CC3D's **applications** (adhesion-driven sorting, chemotaxis, secretion/morphogen fields, division, mechanical links, 3D) through a different — arguably more *accessible* (node graph, no code, browser) and, for the cell engine, more *performant* (WASM/WebGPU vs CC3D's CPU-only Potts) — substrate. The two capabilities that are **irreducibly CC3D and not approximable by the agent engine** are: (a) **CPM deformable-shape phenomenology** (things that *depend on* cells changing shape and sharing fluctuating membranes — sorting/engulfment by surface tension, compartmental cells, precise shape constraints), and (b) the **subcellular SBML/ODE multiscale tier**. Those two are the true north of any "parity" effort. The recommended posture (§5) is not "clone CC3D" but "**add CC3D's irreducible core as new engines/tiers while keeping GenesisCA's accessibility + browser + multi-target identity as the differentiator.**"

---

## 2. What CompuCell3D is and what it is capable of (source-verified)

### 2.1 The paradigm — the Cellular Potts Model

- **Cells as pixel-sets.** The lattice is a 3D field of *pointers to cell objects*, `WatchableField3D<CellG*>` (`Potts3D/Potts3D.cpp`). Every voxel holds a `CellG*`; **all voxels pointing at the same `CellG` are one biological cell**. A cell's `volume` is literally its pixel count, maintained incrementally by `VolumeTrackerPlugin::field3DChange` on every flip. **Medium = cell-ID 0 = null pointer.**
- **Lattices.** Square (Cartesian) and **hexagonal** (`LatticeType {SQUARE, HEXAGONAL}`), 2D/3D, plus a 2.5D mode. Hex uses volume/surface multiplicative factors so geometry stays consistent.
- **Neighbourhoods** are precomputed by a `BoundaryStrategy` singleton, selectable by **neighbour order** (1st, 2nd, 3rd… shells, effectively unbounded reach) or a Euclidean **distance cutoff**. The pixel-copy neighbourhood can differ from the energy neighbourhood (this is how 2.5D works).
- **The Monte-Carlo Step (MCS).** `Simulator::step` runs `sites × Flip2DimRatio` copy attempts (default one attempt per site per MCS), then runs steppables once. Each attempt (`Potts3D::metropolisFast`): pick a random source site → pick a random neighbour target → if same cell, skip → compute `ΔE = Σ energyFunctions.changeEnergy(...)` → **accept iff `ΔE ≤ offset` or `rand() < exp(−(ΔE−offset)/(kT))`** → on accept, relabel the target pixel to the source cell and fire change-watchers. This is the **modified Metropolis** algorithm; alternative acceptance functions exist (first-order linear, or a **custom muParser expression** over `Energy`/`Temperature`).
- **"Temperature"** `T` is a per-copy **fluctuation amplitude** (per-cell `fluctAmpl`, per-type motility, or the global `Temperature`) — it sets the amount of stochastic membrane fluctuation / effective cell motility.
- **Parallelism.** Shared-memory **OpenMP checkerboard** domain decomposition (each region split into 2×2×2 subgrids with barriers so parallel copy attempts never touch adjacent boundary pixels). *Only `metropolisFast` is parallel; the default is serial.* **The CPM engine has no GPU path** — GPU (OpenCL/ViennaCL) is reserved for the diffusion solvers.

### 2.2 The Hamiltonian and the plugin energy library

There is **no hard-coded Hamiltonian**; `ΔE` is a *sum over registered `EnergyFunction` plugins*. This is CC3D's core extensibility: ~33 of its 55 plugins contribute energy terms, ~19 are trackers/data-providers that maintain the state those terms read, and 3 are mechanisms. The library (source-verified) includes:

- **Geometric constraints:** `Volume` (`λ_V·(V−V_target)²`), `Surface` (`λ_S·(S−S_target)²`), `LengthConstraint` (elongate/shorten via inertia-tensor principal axis), and per-cell-`LocalFlex` variants.
- **Differential adhesion (the CPM signature):** `Contact` (a pairwise type×type boundary-energy matrix `J(τ_i,τ_j)` — the term whose relative magnitudes drive **cell sorting, engulfment, compartmentalization**), `AdhesionFlex` (adhesion computed from per-cell "cadherin" molecule densities via a binding formula), `Compartment`/`ContactInternal` (separate internal vs external energies for compartmentalized cells), `ContactLocalProduct/Flex`, `ContactMultiCad`, `ContactOrientation`/`OrientedContact` (orientation-dependent adhesion), `ConvergentExtension`.
- **Chemotaxis:** `Chemotaxis` (`ΔE = −λ·Δconcentration` along a named PDE field's gradient, with saturating/log/power formula variants, per-type, restrictable to interfaces with chosen types), plus `ChemotaxisSimple`/`ChemotaxisDicty`.
- **Mechanical cell-cell links:** `FocalPointPlasticity` (**dynamic spring junctions** that *form on contact and break when overstretched*, energy `λ·(d−d_target)²`, with `Lambda`/`TargetDistance`/`MaxDistance`/`MaxNumberOfJunctions`/`ActivationEnergy`, plus intra-cluster links and custom force laws) and `Elasticity`/`Plasticity` (permanent explicit spring links), `Curvature` (penalize curvature along linked chains).
- **Connectivity** (`Connectivity`/`ConnectivityGlobal`/`LocalFlex`) — veto copies that would fragment a cell into disconnected pieces (a *correctness* term, not polish).
- **Polarization/motility/forcing:** `CellOrientation`, `Polarization23`, `VectorFieldPolarization` (align motion to an external vector field), `ImplicitMotility` (active random motility bias), `Viscosity` (velocity-difference drag), `ExternalPotential` (constant drift/gravity/flow via `−λ⃗·Δx`).
- **Cluster-level:** `ClusterSurface` (surface constraint on a whole compartmentalized cell).
- **Trackers/providers** the above read: `CenterOfMass`, `MomentOfInertia`, `NeighborTracker` (neighbour list + common contact area), `PixelTracker`/`BoundaryPixelTracker`, `CellVelocity`, `CellTypeMonitor`, `VolumeTracker`/`SurfaceTracker`, etc.

### 2.3 The multiscale stack

1. **CPM cells** (§2.1–2.2) — the tissue/cell scale.
2. **PDE reaction-diffusion fields** (`steppables/PDESolvers/`) — a *suite* of ~13 solvers registered by name in CC3DML: `DiffusionSolverFE` (explicit forward-Euler diffusion+decay, with **automatic stability sub-stepping** — if the user's D exceeds the CFL limit it runs multiple scaled sub-steps per MCS), `DiffusionSolverFE_Implicit` (Eigen, unconditionally stable), `FlexibleDiffusionSolverFE`, `ReactionDiffusionSolverFE`/`FVM` (**multi-field coupled reaction-diffusion with user-supplied muParser reaction expressions per field**; the FVM one adds **membrane-permeability flux boundary conditions** and adaptive time-substepping in physical units), `SteadyStateDiffusionSolver` (directly solves ∂C/∂t=0 via FISHPACK Fortran), `KernelDiffusionSolver` (Green's-function convolution), `AdvectionDiffusionSolverFE` (field carried *with* moving cells), `FastDiffusionSolver2DFE`, plus **OpenCL/ViennaCL GPU** variants. Fields support **per-cell-type diffusion & decay constants**, **secretion/uptake** (constant, on-contact, Michaelis-Menten uptake), and **independent per-face boundary conditions** (Periodic/Dirichlet/Neumann). Fields are double-buffered `Array3D` with a halo — directly analogous to a WebGPU ping-pong diffusion kernel.
3. **Subcellular ODE reaction networks** (Python: `cc3d/core/SBMLSolverHelper.py` + `RoadRunnerPy.py`) — **each cell can own an independent `libRoadRunner` (CVODE) integrator** at `cell.dict['SBMLSolver'][name]`, loaded from an **SBML/Antimony/CellML** model; also free-floating (whole-sim) and per-link models. `timestep_cell_sbml()` advances every cell's ODEs in lockstep with the CPM; the modeler reads/writes species (`cell.sbml.DN['D']`) to couple subcellular kinetics ↔ cell behaviour ↔ neighbours. **MaBoSS** gives the same for Boolean regulatory networks. *This is the canonical, heavily-used multiscale pattern (e.g. Delta-Notch lateral inhibition, one gene circuit per cell).*

### 2.4 Cell lifecycle

- **Growth** — a steppable raises `cell.targetVolume` over time; the Volume energy term makes the cell grow into it.
- **Division / mitosis** (`Mitosis/MitosisSteppable`) — splits a cell along a plane through its centre of mass, perpendicular to a chosen orientation: **explicit vector, along the major/minor inertia axis, or random**; parent/child side controllable; compartmental (cluster) mitosis supported; the geometric split is C++, attribute inheritance is the modeler's Python `update_attributes()` (which also `copy_sbml_simulators` to the daughter).
- **Death** — set volume→0 (VolumeTracker reaps it) or delete directly.
- **Differentiation** — change `cell.type` in a steppable (often driven by the cell's SBML state or its neighbours).

### 2.5 The scientific workflow and ecosystem

- **A model is a project folder** (`.cc3d` manifest) bundling: a **CC3DML `.xml`** (declarative Potts + plugins + PDE steppables + initializers) *or* an equivalent **`PyCoreSpecs`** Python spec, a main `.py` that registers steppables and calls `run()`, one or more **Python steppable** files (imperative `start`/`step(mcs)`/`finish` control logic with full access to cells, fields, mitosis, and SBML), and resources (PIF cell layouts, initial fields, parameter-scan specs).
- **Initializers:** blob, uniform box, **PIF** (Potts-Initial-File pixel layout), polygon, tube, random, or a Wavefront `.obj` mesh.
- **Visualization:** the Qt **Player** (VTK) renders the cell field (colour by type/ID), cell/cluster borders, **FPP link overlays**, scalar chemical-field heatmaps, **vector fields**, in 2D and full 3D (rotate/clip/cross-section), plus real-time scientific plots from steppables.
- **Output:** `.vtk` field snapshots (the reload/replay format), `.png` screenshots, PIF dumps, and full **restart/serialization** (including pickled per-cell SBML state).
- **Parameter scans / batch:** template the model with `{{vars}}` + a `ParameterScanSpecs.json`; the driver runs the **Cartesian product** of value lists, resumable and parallel-safe across processes/nodes (FileLock); a **headless CLI** (`run_script.py`) runs GUI-less on clusters; `CC3DCaller` embeds a run in plain Python for optimization loops.
- **The ecosystem:** ~309 validated demo projects, decades of published/reproducible models, an active community, and — critically — the **Python escape hatch**: *anything the declarative layer can't express, the modeler writes as arbitrary Python in a steppable.*

### 2.6 Scale, performance, and honest limitations

- **Scale:** "tens of thousands of cells on a single laptop." CPM cost scales with lattice size × neighbour order; the Potts engine is **CPU/OpenMP only (no GPU)**; diffusion can use OpenCL/ViennaCL GPU. Single-node (no MPI).
- **CC3D's own limitations** (relevant because they are exactly where GenesisCA is strong): Monte-Carlo "time" is **not physical time**; a single `T` couples adhesion, motility, surface roughness and effective cell size; the modified-Metropolis dynamics **break detailed balance** (long-time behaviour can be degenerate; cells can stochastically go extinct without guards); the CPM is the **wrong tool for confluent epithelial sheet mechanics** (folding/T1/tube formation — that is *vertex-model* territory); and the **authoring workflow is two-language desktop software** (CC3DML XML + Python, conda install) — a real barrier for non-programmers, which is precisely GenesisCA's target audience.

---

## 3. How CompuCell3D compares to GenesisCA

### 3.1 The fundamental substrate difference

| | **CompuCell3D** | **GenesisCA — classic CA** | **GenesisCA — bond-graph agents** |
|---|---|---|---|
| **A "cell" is** | a deformable domain of *many* lattice pixels sharing an ID | *one* lattice site with N typed attributes | a floating point-agent with radius (soft sphere) |
| **Update** | Metropolis MC energy minimization (propose→accept spin-copy) | compiled per-site step function, once/generation | force ODE integration (sum neighbour forces, overdamped step) |
| **Shape** | emergent, fluctuating (the whole point) | none (a site) | rigid sphere (radius grows) |
| **Adjacency** | dynamic (fluctuating membranes) | fixed neighbour table | distance-based (spatial hash, rebuilt per step) |
| **Cell count** | fixed-ish + division/death | fixed = grid sites | dynamic (division/death, capacity-capped) |
| **Targets** | C++ (OpenMP CPU); diffusion on OpenCL GPU | JS / WASM / WebGPU | JS / WASM / WebGPU |
| **Authoring** | CC3DML XML + Python steppables (desktop) | node graph (browser, no code) | node graph (browser, no code) |

The load-bearing point: **GenesisCA's two engines bracket CPM but neither *is* CPM.** Classic CA is *below* it (no extended cells); center-based agents are *beside* it (extended but rigid, off-lattice). CC3D's deformable-membrane phenomenology sits in the gap.

### 3.2 Capability matrix (CC3D capability → GenesisCA state)

Legend: ✅ have · 🟡 partial/different-paradigm · ❌ none.

| CC3D capability | GenesisCA | Via / note |
|---|---|---|
| Extended deformable cells (multi-pixel, shape) | ❌ | The irreducible CPM core |
| Metropolis energy-minimization engine | ❌ | Would be a new 3rd engine ([INVESTIGATION_CPM.md](INVESTIGATION_CPM.md)) |
| Differential adhesion → cell sorting | 🟡 | Agents: soft-sphere adhesion sorts spheres (qualitative, not surface-tension); lookup-table = the J-matrix |
| Volume / Surface / Length constraints | 🟡/❌ | Agent radius+growth ≈ volume; *surface/shape* constraints have no analog |
| Chemotaxis up a field gradient | ✅ | Agent `Field Gradient` → `Apply Force`; a first-class agent node |
| FocalPointPlasticity / Elasticity spring links | ✅ | Agent **bonds** (rest length + stiffness, form/break) — a direct analog |
| Cell division (with orientation) | ✅ | Agent division along the tension-axis eigenvector; growth ramp; death |
| Secretion / uptake into fields | ✅ | Agent field bridge: `Secrete To Field` / `Affect Cells Under` |
| PDE reaction-diffusion fields | 🟡 | Grid *is* a field; Gray-Scott ships; no named multi-field *solver* abstraction, no per-type D |
| Per-cell-type diffusion constants, per-face BCs, steady-state | ❌ | Net-new field-solver features |
| Subcellular ODE / SBML per cell | ❌ | Zero — no ODE integrator anywhere (confirmed) |
| Boolean regulatory networks (MaBoSS) | ❌ | Zero |
| Compartmentalized (sub-celled) cells / clusters | ❌ | No cluster/compartment tier |
| Connectivity guard (anti-fragmentation) | ❌ (n/a today) | Needed *if* CPM is built |
| Polarization / external potential / viscosity | 🟡 | Agents: momentum, apply-force, cross-agent force ≈ several of these |
| Parameter scans / replicate statistics | ✅ | **Overseer** (sweeps, replicate mean±σ, run-until-stop, CSV/JSON) |
| 3D lattice + 3D rendering | ✅ | 3D grid CA + WebGL2 voxel renderer + 3D agents (spheres/bonds/sprites, lighting/shadows) |
| Standard scientific output (VTK/PIF) | ❌ | `.gcaproj`/`.gcastate` + GIF/WebM/PNG, not VTK |
| Restart / serialization | 🟡 | `.gcastate` snapshots; not full reproducible restart of a running experiment |
| Python/scripting escape hatch | ❌ | Node-graph only (by design) — the accessibility/expressivity tradeoff |
| Validated model library | 🟡 | ~2 dozen library models vs CC3D's ~309 demos + literature |
| Accessibility (no code, zero-install, browser) | ✅✅ | **GenesisCA's decisive advantage** |
| Cell-engine GPU acceleration | ✅✅ | WASM default + WebGPU; CC3D's Potts is CPU-only |

### 3.3 Where GenesisCA is already ahead / genuinely different

- **Accessibility.** A visual node graph in a browser with **no install and no code** vs CC3D's conda-installed desktop + two-language (XML+Python) authoring. This is GenesisCA's reason to exist and it is a real, large advantage for the "non-programmer scientist / educator / student" audience CC3D itself names as underserved.
- **Multi-target performance for the *cell* engine.** GenesisCA compiles to **WASM (default) and WebGPU**; CC3D's Potts engine is CPU/OpenMP only. For the embarrassingly-parallel classic-CA and agent-force workloads, GenesisCA's ceiling is higher on commodity hardware.
- **Built-in experiment orchestration.** The **Overseer** already does what CC3D's parameter-scan tooling does — sweeps, replicate statistics (mean±σ), run-until-stop protocols, journaled/reproducible runs, CSV/JSON + chart export — *inside the same tool*, no shell scripts.
- **One-file shareable output.** The presentation `.html` export (a self-contained simulator + model) has no CC3D equivalent (CC3D sharing is a project folder + a conda environment).
- **The agent engine's WebGPU fit.** Center-based force summation is a near-ideal GPU compute dispatch (and GenesisCA runs it on WebGPU today); CPM's sequential accept/reject is *not*, which is exactly why CC3D never GPU-accelerated its Potts core.

### 3.4 Where CompuCell3D is fundamentally ahead

- **The CPM deformable-cell substrate itself** and everything that *depends on shape*: sorting/engulfment by **surface tension**, membrane-fluctuation dynamics, precise volume/surface/length constraints, **compartmentalized cells**. GenesisCA has *no* representation of a cell with a mutable shape.
- **The subcellular ODE/SBML multiscale tier** — a validated stiff ODE integrator per cell, SBML/Antimony import, Boolean networks. GenesisCA has *nothing* here.
- **The mature multi-field PDE suite** — 13 solvers, per-type diffusion, secretion/uptake kinetics, per-face boundary conditions, steady-state, adaptive stability. GenesisCA has the *primitive* (grid reaction-diffusion) but not the *parameterized scientific abstraction*.
- **The ecosystem** — VTK/standard I/O, full reproducible restart, ~309 validated demos, decades of peer-reviewed models, and the **Python escape hatch** that lets a modeler express *anything* the declarative layer can't. A node-graph tool trades expressivity for accessibility; matching CC3D's open-ended expressivity is a genuine design tension (§5).

---

## 4. Gap-closure draft (the roadmap)

Organized as workstreams. Each notes the CC3D capability, GenesisCA's current state, the net-new work, the target/dimension matrix impact (the project's non-negotiable JS/WASM/WebGPU × 2D/3D rule), a rough **effort** (S/M/L/XL, calibrated so that "the entire shipped agent-engine milestone" ≈ **XL**), and a **priority** for a parity effort. This is a *general* draft — each workstream would get its own Impact Map + `PLAN_*.md` + HTML mockup before implementation, per project convention.

### WS-1 — The CPM engine (a third engine) · Effort XL · Priority 1
The single biggest and most CC3D-defining piece. Fully pre-scoped by [INVESTIGATION_CPM.md](INVESTIGATION_CPM.md) (which estimates ~60–70% of the *plumbing* is reusable and cites **Artistoo** — a pure-JS browser CPM at ~20 fps in 2D *and* 3D — as the in-browser existence proof). Net-new subsystems:
1. **A per-cell-ID object/accumulator tier** (volume, perimeter/surface, target volume, type, centroid) indexed by cell ID, maintained *incrementally* on every accepted copy. *Reuse note:* the agent engine's per-agent object store (SoA indexed by id, `maxCells` cap + free-list) is the template — this tier already exists in spirit.
2. **A worker-side Metropolis driver** (a new `'cpm'` update mode) that picks boundary source→target pairs, calls a compiled **ΔH** function, does the `exp(−ΔH/T)` accept, commits the relabel, and updates accumulators — replacing the per-site `runStep` dispatch.
3. **A new "energy / ΔH" event root** (sibling to Step/Init) — the node graph is repurposed to compute *one scalar ΔH for a proposed copy* rather than a per-cell next-state. The existing async single-buffer + `orderArray` machinery is structurally the CPM substrate already; `GetRandom(bool)` is already the Metropolis accept gate.
4. **A connectivity / fragmentation guard** (a local test) — a correctness requirement.
5. **Membrane rendering + colour-by-cell-ID** (new render passes over the existing 2D blit; 3D reuses the voxel renderer).
- **Targets:** JS + WASM feasible; **WebGPU CPM is out of scope** (sequential accept/reject; needs a checkerboard scheduler — a later milestone, exactly as async is already WebGPU-rejected). 2D first; 3D is an *incremental engine* change (bigger stencil) but the renderer already exists.
- **The correctness milestone:** 2D cell **sorting from differential adhesion** (the Graner–Glazier 1992 founding result) — the unambiguous "the CPM engine works" test.

### WS-2 — The CPM energy-term library (plugins as nodes) · Effort L · Priority 1 (with WS-1)
Turn CC3D's ~33 energy plugins into GenesisCA energy-term nodes feeding the ΔH root. The good news is the differential-adhesion core maps onto existing machinery:
- **Contact / differential adhesion** → the existing **N-D lookup table** (tag×tag float `J`-matrix keyed by cell type), live-tunable — *no new attribute type needed.*
- **Volume / Surface / LengthConstraint** → `λ·(x−target)²` over the per-cell accumulators; `T`/`λ_V`/`λ_S` → bounded model-attribute sliders.
- **Chemotaxis** → `−λ·Δfield` (the field layer is WS-3; the *math* is trivial node arithmetic).
- **FocalPointPlasticity / Elasticity links** → conceptually the agent **bond** system (rest length + stiffness + form/break); porting the *concept* into the CPM tier is new but the design is proven.
- **Connectivity, Polarization, ExternalPotential, ConvergentExtension, Compartment-contact** → each a modest energy-term node.
- **Effort split:** the *first five* (Volume, Surface, Contact, Chemotaxis, one link type) are the 80/20 that unlock most published models; the long tail (~25 more plugins) is incremental **M** each.

### WS-3 — The PDE reaction-diffusion field solver suite · Effort L · Priority 2
GenesisCA already has the *primitive* (a grid attribute *is* a scalar field; Gray-Scott reaction-diffusion ships; the agent↔grid field bridge does bilinear/trilinear sample + gradient + deposit). What's missing is the **parameterized scientific abstraction**:
- A **named multi-field** concept (fields as first-class model objects, not just cell attributes) with **per-cell-type diffusion & decay constants**, **secretion/uptake** (constant / on-contact / Michaelis-Menten — the agent secrete nodes already do part of this), and **independent per-face boundary conditions** (Periodic/Dirichlet/Neumann).
- A **stability auto-scaling** wrapper (sub-step when D exceeds the CFL limit — CC3D's `DiffusionSolverFE::Scale`).
- Optionally a **steady-state** solver and a **user-authorable reaction term** (already natural in the node graph).
- **Targets:** **WebGPU is an excellent fit** (double-buffered `Array3D` with halo = a ping-pong storage-buffer diffusion kernel; this is the one place GenesisCA could *out-perform* CC3D). JS/WASM straightforward. 2D + 3D.

### WS-4 — The subcellular ODE / SBML tier · Effort XL · Priority 3
The genuinely-new multiscale tier; **zero exists today**. To match CC3D:
- A **per-cell (per-agent) ODE integrator** — a stiff-capable solver (RK4 baseline; CVODE-class BDF for stiff gene circuits) advancing each cell's own state each step. *Reuse:* the agent per-object store + the "run a small function per agent" pattern already exist; the integrator kernel is new.
- **A reaction-network authoring path.** Two options: **(a)** an **SBML/Antimony importer** (to reuse the enormous existing SBML model corpus — the higher-value, higher-effort path) or **(b)** a **node-graph reaction editor** (species + reactions → auto-generated ODEs — more on-brand for GenesisCA, avoids a parser). A hybrid (import *and* visual editing) is ideal but XL.
- **Coupling** — read/write species ↔ cell attributes ↔ neighbours each step (GenesisCA's field bridge + neighbour-sensing already model this pattern).
- Optionally **Boolean networks** (MaBoSS analog) — a much smaller, discrete cousin (**M**), a good first deliverable to prove the "logic-inside-each-cell" tier.
- **Targets:** JS/WASM natural; **WebGPU per-cell ODE integration is feasible** (one thread per cell) but f32/precision caveats apply (document as an intentional target difference, like the existing RNG/precision notes).

### WS-5 — Cell lifecycle parity (division / differentiation / compartments) · Effort M–L · Priority 2
- **Division & growth** — *already shipped for agents* (tension-axis eigensolve, growth ramp, death, type switching). For **CPM**, division is a **pixel-set split** along an orientation (CC3D offers major/minor-axis/random) + daughter-ID allocation — new but well-defined (part of WS-1's structural phase). Classic-CA cells fundamentally cannot divide (1 cell = 1 fixed site) — this is a *paradigm* limit, not a gap to close.
- **Compartmentalized cells** (clusters of sub-cells with internal vs external adhesion, cluster-surface constraints) — **net-new** for CPM; no analog in any current engine. **L**, lower priority (used by a minority of CC3D models but genuinely CC3D-only).

### WS-6 — The scientific ecosystem · Effort L (spread) · Priority 3
- **Parameter scans / replicate statistics** — *substantially already shipped* as the **Overseer**. The gap is convenience (parity with CC3D's template-`{{var}}` + JSON Cartesian-product runner and resumable HPC batch) — **S–M** to extend.
- **Standard scientific I/O** — a **VTK exporter** (fields + cell/ID field) so GenesisCA output interoperates with ParaView and CC3D's own reload path; **PIF import/export** for cell layouts. **M.**
- **Reproducible restart** — snapshot/restore a *running experiment* (not just a starting configuration), including RNG + ODE state. **M** (extends `.gcastate`).
- **A validated model library** — port canonical CC3D demos (cell sorting, bacterium-macrophage chemotaxis, Delta-Notch, tumour growth) as GenesisCA models; this is *the* credibility deliverable and also the best driver of which features to build. Ongoing.
- **The escape-hatch question (design tension).** CC3D's open-ended expressivity comes from arbitrary Python in steppables. A node-graph tool cannot fully match that without *becoming* a programming environment. Options: (a) accept the node-graph ceiling and lean on accessibility as the differentiator; (b) add a constrained **"expression/script node"** (already have an Expression node — extend it) for the last-mile logic; (c) a full embedded JS "steppable" (contradicts the no-code identity). **Recommend (b)** — bounded expressivity without abandoning the visual model.

### WS-7 — Scale & performance parity · Effort M · Priority 3
- 3D rendering and large grids **already exist**; the agent engine is O(N) via a spatial hash; WASM/WebGPU give a higher ceiling than CC3D's CPU Potts.
- The one perf item unique to CPM: an efficient **boundary-edge sampler** (only propose copies at cell boundaries) so the Metropolis loop isn't dominated by interior no-op attempts — part of WS-1 Phase 3.

---

## 5. Strategic recommendation

**1. Name the goal honestly.** "Simulate everything CompuCell3D can" literally = **a CPM engine (WS-1/2) + a PDE field-solver suite (WS-3) + a subcellular ODE/SBML tier (WS-4) + compartmental cells (WS-5) + the scientific ecosystem (WS-6)**. That is a **multi-year, multi-engine program**, each of WS-1 and WS-4 comparable in scope to the *entire* bond-graph agent milestone that already shipped. It is not a feature or a single milestone. CC3D is two decades of specialized computational biology with ~1M lines and hundreds of validated models; feature-for-feature parity is the wrong target.

**2. Separate "reachable today" from "irreducible."** A large fraction of CC3D's *applications* — adhesion-driven aggregation/sorting (qualitatively), chemotaxis, secretion/morphogen fields, division, mechanical links, 3D tissues — are **already expressible in GenesisCA's shipped agent engine**, through a different (rigid-sphere, off-lattice) substrate. Many CC3D demo models could be *approximated* now. The **irreducible CC3D-only core** is exactly two things: **(a) CPM deformable-shape phenomenology** (sorting/engulfment by surface tension, membrane fluctuation, precise shape constraints, compartmental cells) and **(b) the subcellular SBML/ODE tier.** Those two are the honest definition of "parity," and everything else is either already present or an extension.

**3. Recommended sequencing (if this direction is pursued).**
   - **Phase A — the CPM engine (WS-1) + the 80/20 energy terms (WS-2: Contact + Volume + Surface + Chemotaxis + one link type)**, JS→WASM, 2D. Deliverable: **differential-adhesion cell sorting** — the canonical CPM result and the credibility milestone. This alone makes GenesisCA "a CPM tool," which is *the* thing CC3D is.
   - **Phase B — the PDE field suite (WS-3)** with WebGPU (a place GenesisCA can *beat* CC3D) + cell growth/division in CPM (WS-5) → chemotaxis-guided morphogenesis and tumour-growth-class models.
   - **Phase C — the subcellular tier (WS-4)**, starting with the smaller **Boolean-network** cousin, then a **node-graph reaction editor** and/or SBML import → the Delta-Notch-class multiscale demos.
   - **Phase D — the ecosystem (WS-6):** VTK/PIF I/O, reproducible restart, the ported validated-model library, and the constrained expression/script escape hatch; extend Overseer to full parameter-scan parity.
   - **The long tail (WS-2 remainder, WS-5 compartments)** as demand-driven increments.

**4. Keep GenesisCA's identity as the differentiator.** The winning move is **not** "reimplement CC3D in the browser" — it is "**bring CC3D's biology into a zero-install, no-code, visually-authored, WASM/WebGPU-accelerated tool.**" GenesisCA's accessibility + multi-target performance + built-in experiment orchestration are advantages CC3D structurally lacks. A GenesisCA that runs a CPM cell-sorting model *and* a chemotaxis model *and* a Delta-Notch multiscale model — authored as node graphs, in a browser, shareable as one HTML file — would be a genuinely new point in the design space, not a clone.

**5. Immediate next step (low-cost, high-value).** Before committing to Phase A, **port 3–5 canonical CC3D models to the *existing* agent engine** (cell sorting, bacterium-macrophage chemotaxis, a growing-tissue/tumour model) to (a) establish exactly how far the current substrate reaches, (b) surface the concrete feature gaps that most block real biology, and (c) produce the credibility artefacts that would justify the CPM investment. This turns the abstract roadmap above into an evidence-driven build order.

---

## Appendix — source evidence pointers (CompuCell3D-master)

- **Potts core:** `CompuCell3D/core/CompuCell3D/Potts3D/{Potts3D.cpp,Cell.h,AcceptanceFunction.h,EnergyFunctionCalculator.cpp,CellInventory.h}`, `Simulator.cpp`, `PublicUtilities/ParallelUtilsOpenMP.cpp`.
- **Energy plugins:** `CompuCell3D/core/CompuCell3D/plugins/{Volume,Surface,Contact,AdhesionFlex,Chemotaxis,FocalPointPlasticity,Elasticity,Connectivity,Compartment,ExternalPotential,...}/`.
- **PDE solvers:** `CompuCell3D/core/CompuCell3D/steppables/PDESolvers/{PDESolversProxy.cpp,DiffusionSolverFE_CPU.cpp,ReactionDiffusionSolverFE.cpp,ReactionDiffusionSolverFVM.cpp,SteadyStateDiffusionSolver.cpp,DiffSecrData.h,OpenCL/,CUDA/}`.
- **Mitosis / initializers:** `steppables/{Mitosis/MitosisSteppable.cpp, BlobFieldInitializer, PIFInitializer, ...}`.
- **Python / CC3DML / SBML:** `cc3d/core/{PySteppables.py,PyCoreSpecs.py,SBMLSolverHelper.py,RoadRunnerPy.py,MaBoSSCC3D.py,CMLFieldHandler.py,RestartManager.py}`, `cc3d/CompuCellSetup/`, `cc3d/run_script.py`, `cc3d/core/param_scan/`, `CompuCell3D/core/pyinterface/`, and the ~309 `CompuCell3D/core/Demos/**/*.cc3d`.
- **GenesisCA counterparts:** [INVESTIGATION_CPM.md](INVESTIGATION_CPM.md), [INVESTIGATION_CENTER_BASED.md](INVESTIGATION_CENTER_BASED.md), and the "Bond-Graph Agents", "3D Grid CA", "Overseer", and "N-Dimensional Lookup Tables" sections of [CLAUDE.md](../CLAUDE.md).

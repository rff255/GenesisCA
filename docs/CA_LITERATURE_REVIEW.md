# GenesisCA Literature Review

## Cellular Automata Models Across the Sciences

> **About this document.** This is the foundational literature review that anchors GenesisCA's feature roadmap. It catalogues canonical CA models from physics, chemistry, biology, ecology, sociology, transport, earth sciences, theory and cryptography, and identifies which models the current build can already reproduce versus which would require new capabilities. A separate `docs/ROADMAP.md` (planned) will translate the gaps surfaced here into a prioritised implementation plan.

## Executive Summary

This document surveys ~50 significant cellular-automata (CA) models across ten scientific and engineering disciplines. For each entry we capture the originator(s), key publication, mechanism, real-world significance, and — most importantly for GenesisCA — the distinguishing CA features the model requires (attribute types, neighbourhood, update mode, topology, stochasticity, multi-species needs, conservation laws). At the end of the document a Top-Tier Shortlist names the models we plan to ship as in-app examples and use as the driving requirements for new features.

The catalogue is intended to be **read by both modellers and the GenesisCA development effort**. Modellers can use it as a reference of canonical CA work in their domain, with citations and feature requirements. The development effort uses it to validate feature priorities (e.g. "we should add Metropolis Monte Carlo because three different shortlisted chemistry / biology models need it").

## How to Read This Document

- Each model entry has a fixed schema: **Field**, **Originator(s) and Year**, **Key Publication**, **Description**, **Significance**, and **Distinguishing CA Features**.
- The "Distinguishing CA Features" bullets use a deliberately consistent vocabulary so they can be searched across the document — e.g. "hexagonal lattice" (not "hex grid"), "Metropolis Monte Carlo" (not "MC sweep"), "anisotropic neighbourhood" (not "directional neighbours"), "vector cell state" (not "list per cell").
- Some models are listed in **multiple fields** when their reach crosses domains (e.g. Lattice Boltzmann appears under both Physics and Earth Sciences because of its dominant role in subsurface-flow modelling).

## Already Supported by GenesisCA

These models can be built today using the current node library, 2D grid, custom-neighbourhood facility, sync / async modes and indicator system. They are listed here so users can find ready-to-load example projects in the Models Library, and so the shortlist below can focus on models that drive *new* feature work.

- **Conway's Game of Life** — the canonical baseline (Moore neighbourhood, sync, binary state).
- **Wolfram Elementary Cellular Automata, Rules 0–255** — including Rule 30 (chaotic / pseudo-random) and Rule 110 (Turing-complete). All 256 are reachable by the same project: a model attribute selects the rule, and the neighbourhood reads the three cells one row above (see "1D-on-2D" note below).
- **Wireworld** — 4-state, Moore neighbourhood, synchronous; logic-circuit demonstrations.
- **Brian's Brain** — 3-state excitable medium, Moore neighbourhood, synchronous.
- **Greenberg–Hastings excitable media** — basic 3-state form (more elaborate variants benefit from upcoming features).
- **Drossel–Schwabl Forest Fire** — three-state stochastic CA; SOC analysis benefits from upcoming power-law indicator viz.
- **Schelling Segregation** — binary agents, async movement, satisfaction threshold.
- **Nagel–Schreckenberg Traffic** — single-row neighbourhood, integer velocity, stochastic deceleration.
- **Basic Gray–Scott Reaction-Diffusion** — two continuous fields with diffusion coupling expressed via Aggregate over neighbours.
- **WaTor Predator–Prey** — multi-species via tag attribute + Switch; movement in async mode.

This list will grow as more shortlisted models are built and added to the Models Library.

## Note: The 1D-on-2D-Strip Pattern

GenesisCA's grid is currently 2D-only. This is **not a limitation** for the great majority of 1D CA models (Wolfram elementary CAs, Nagel–Schreckenberg traffic, totalistic 1D rules, etc.). The pattern is:

1. Create a 2D grid where the *generation axis* is laid out along the rows (row 0 is generation 0, row 1 is generation 1, …) or, equivalently, the simulation works on a single row and rows above are written as history.
2. Define a custom neighbourhood that reads the **three cells one row above** the current cell (offsets `(-1,-1)`, `(-1,0)`, `(-1,+1)`).
3. The Update Rules graph computes the new cell value from those three reads — a totalistic or LUT-based rule looks up the result via a model attribute (e.g. "rule number") and a Switch / GetConstant / GetBit pattern.

This trick covers any 1D radius-r CA by reading `2r+1` cells from the row above. It's already shipping inside several Models Library projects as the canonical Wolfram-rule explorer. Throughout the rest of this document, models flagged as "needs 1D topology" in older CA literature can be assumed reachable via this pattern unless explicitly noted otherwise.

---

## 1. PHYSICS & FLUID DYNAMICS

Cellular automata have been instrumental in computational fluid dynamics, providing efficient discrete alternatives to partial differential equation solvers while maintaining physical consistency through local conservation laws and reversibility.

### 1.1 HPP Model (Hardy–Pomeau–de Pazzis)

- **Field:** Physics / Fluid Dynamics
- **Originator(s) and Year:** Jean Hardy, Yves Pomeau, Olivier de Pazzis; 1973, 1976
- **Key Publication:** Hardy, J., Pomeau, Y., & de Pazzis, O. (1973, 1976) "Molecular dynamics of a classical fluid simulated by twenty collision rules," *Physical Review Letters*; follow-up 1976 paper.
- **Description:** The HPP model is a 2D lattice gas cellular automaton simulating fluid particle interactions. Particles move at unit speed on a square lattice and undergo elastic collisions. Eight possible velocities are allowed (±1 in x and y, combinations thereof). Particles are strictly conserved (Boolean occupancy per velocity per cell). At each time step, particles propagate to neighboring cells and collide according to deterministic rules that preserve mass and momentum.
- **Why Significant:** First lattice-based model of hydrodynamics from CA; demonstrated that the macroscopic Navier–Stokes equations can be derived from a discrete CA system. Foundation for later lattice Boltzmann methods.
- **Distinguishing CA Features:**
  - **State:** Boolean per velocity channel (8 channels; can be treated as integer encoding, or 8 separate binary layers)
  - **Neighborhood:** Cartesian (von Neumann), but specialized to four cardinal directions
  - **Grid Topology:** Square lattice, typically periodic (toroidal)
  - **Update Mode:** Fully synchronous (all cells update simultaneously)
  - **Symmetry:** High isotropy in collision rules; deterministic
  - **Conservation:** Strict mass and momentum conservation
  - **Interaction Range:** Neighbors only (radius 1)

### 1.2 FHP Model (Frisch–Hasslacher–Pomeau)

- **Field:** Physics / Fluid Dynamics
- **Originator(s) and Year:** Uriel Frisch, Brosl Hasslacher, Yves Pomeau; 1986
- **Key Publication:** Frisch, U., Hasslacher, B., & Pomeau, Y. (1986) "Lattice-gas automata for the Navier-Stokes equation," *Physical Review Letters*, 56(14), 1505–1508.
- **Description:** The FHP model improves on HPP by using a hexagonal lattice instead of square, providing six velocity channels (typically 6 + rest, or 7 states per cell). Each cell can hold 0–1 particle per velocity direction; collisions are implemented via lookup tables on the 7-bit state. The hexagonal grid symmetry ensures isotropy and proper Navier–Stokes reproduction. Particles propagate and collide synchronously each time step.
- **Why Significant:** First CA model demonstrating correct 2D fluid behavior; eliminated the anisotropy artifacts of HPP. Directly validated against experiments; was a major breakthrough bridging discrete and continuum mechanics.
- **Distinguishing CA Features:**
  - **State:** Boolean per velocity channel (6 or 7 directions including rest; can encode as single integer or bit-vector)
  - **Neighborhood:** Hexagonal (six cardinal neighbors + self)
  - **Grid Topology:** Hexagonal lattice, typically toroidal boundary
  - **Update Mode:** Fully synchronous
  - **Symmetry:** Sixfold rotational invariance; collision rules preserve isotropy
  - **Conservation:** Mass and momentum strictly conserved
  - **Collision Rule:** Deterministic lookup table based on incoming 6-bit pattern

### 1.3 Lattice Boltzmann Methods (LBM)

- **Field:** Physics / Fluid Dynamics
- **Originator(s) and Year:** Evolved from lattice gas CA; developed extensively in early 1990s (Qian, d'Humières, and others)
- **Key Publication:** Qian, Y. H., d'Humières, D., & Lallemand, P. (1992) "Lattice BGK models for Navier-Stokes equation," *Europhysics Letters*, 17(6), 479–484; Chopard, B. & Droz, M. (1998) *Cellular Automata Modeling of Physical Systems*, Cambridge University Press.
- **Description:** LBM replaces Boolean particle occupancy with real-valued probability distributions *f_i* for each velocity direction, effectively coarse-graining the lattice gas CA. A cell's state is a vector of 9 values (D2Q9: 2D, 9 velocities) representing directional particle densities. Dynamics proceed in two steps: collision (relaxation toward equilibrium) and streaming (propagation). The collision step uses a simple relaxation operator; streaming is exact. LBM avoids Boolean artifacts while retaining discrete lattice structure and local interactions.
- **Why Significant:** Modern standard for computational fluid dynamics; combines efficiency of CA with accuracy of continuous methods. Requires no explicit particle tracking; scales to millions of cells. Widely used in industry and research.
- **Distinguishing CA Features:**
  - **State:** Real-valued (float) distribution functions (typically 9 per cell in 2D: D2Q9)
  - **Neighborhood:** Discrete lattice directions (Moore neighborhood with asymmetry for propagation)
  - **Grid Topology:** Square or other regular lattice; typically periodic or open
  - **Update Mode:** Two-phase: collision (synchronous, local) then streaming (deterministic propagation)
  - **Stochasticity:** None (fully deterministic)
  - **Boundary Conditions:** Specialized (bounce-back, pressure, inlet/outlet)
  - **Multi-layer/Species:** Can be extended to multiple fluids (immiscible, miscible); multi-phase with color gradients

### 1.4 Ising Model (Cellular Automaton Variant)

- **Field:** Physics / Statistical Mechanics
- **Originator(s) and Year:** Ernst Ising (1925, original); Cellular automaton implementation by Vichniac, Pomeau, and Herrmann (1980s)
- **Key Publication:** Vichniac, G. Y., Pomeau, Y., & Herrmann, H. J. (1986) "Simulation of the Ising model on a cellular automaton," *Journal of Statistical Physics*, 40, 793–813.
- **Description:** A 2D grid where each cell is a spin (up or down, or ±1). Dynamics evolve via Metropolis or heat-bath dynamics: at each step, a cell tentatively flips, and the flip is accepted based on Boltzmann probability or heat-bath rule. In the cellular automaton variant, updates are synchronous and local (neighborhood-based). The energy function includes nearest-neighbor interaction and external field. System exhibits ferromagnetic phase transition and critical phenomena.
- **Why Significant:** Archetypal model of phase transitions and critical phenomena; illustrates universality class behavior. CA implementation is computationally efficient and pedagogically valuable.
- **Distinguishing CA Features:**
  - **State:** Binary (spin ±1, or 0/1)
  - **Neighborhood:** von Neumann or Moore (typically Moore for 2D)
  - **Grid Topology:** Square lattice, often with periodic boundaries
  - **Update Mode:** Synchronous; or random sequential for true thermodynamic equilibrium
  - **Stochasticity:** Yes—probabilistic acceptance of spin flips (Metropolis or other)
  - **Temperature Parameter:** External (controls flip acceptance rates)
  - **Interaction:** Short-range (nearest neighbors) and long-range zero-field effects

### 1.5 Bak–Tang–Wiesenfeld Sandpile (Self-Organized Criticality)

- **Field:** Physics / Complex Systems
- **Originator(s) and Year:** Per Bak, Chao Tang, Kurt Wiesenfeld; 1987
- **Key Publication:** Bak, P., Tang, C., & Wiesenfeld, K. (1987) "Self-organized criticality: An explanation of 1/f noise," *Physical Review Letters*, 59(4), 381–384.
- **Description:** A 2D cellular automaton where each cell stores a continuous quantity (sand height or "slope"). At each time step, check all cells: if a cell exceeds a critical threshold (typically 3), it "topples," distributing sand to its four neighbors (von Neumann). The toppling can trigger avalanche cascades. Stochastic: new sand is added at random locations. Despite simple rules, the system self-tunes to criticality, exhibiting power-law avalanche-size distributions and 1/*f* noise without parameter tuning.
- **Why Significant:** First example of self-organized criticality—demonstrates how complex, scale-invariant systems emerge from simple local dynamics without fine-tuning. Inspired research into avalanche dynamics, earthquakes, forest fires, and many other phenomena.
- **Distinguishing CA Features:**
  - **State:** Integer (discrete or continuous real-valued height/slope per cell)
  - **Neighborhood:** von Neumann (four neighbors)
  - **Grid Topology:** Square lattice, typically open (or with boundary conditions to dissipate sand)
  - **Update Mode:** Synchronous or sequential; typically relaxed until stable
  - **Stochasticity:** Random addition of particles (external drive)
  - **Conservation:** Loosely (sand is added and may leave boundaries)
  - **Threshold Dynamics:** Critical, with cascade propagation

### 1.6 Margolus Block Cellular Automaton (Reversible, Billiard Ball)

- **Field:** Physics / Computation
- **Originator(s) and Year:** Norman Margolus; 1980s
- **Key Publication:** Margolus, N. (1984) "Physics and computation," MIT PhD thesis; Toffoli, T. & Margolus, N. (1987) *Cellular Automata Machines: A New Environment for Modeling*, MIT Press.
- **Description:** A block CA divides the grid into 2×2 blocks; each block evolves as a unit according to a lookup table. Two partitioning schemes (even and odd offsets) alternate each generation, ensuring proper propagation of information. Margolus neighborhood CAs are typically designed to be reversible: the transition rule is a permutation of states. Classic example: "billiard ball" model, where 2×2 blocks contain particles that undergo elastic collisions, simulating deterministic computation. Conserves particle number and momentum; reversible in time.
- **Why Significant:** Demonstrates that reversible computation can be implemented in CA; underpins universal computation models. Physically inspired; obeys thermodynamic conservation laws exactly.
- **Distinguishing CA Features:**
  - **State:** Depends on rule; often a small integer (e.g., 0–3 per cell in a 2×2 block, giving 2^4 = 16 possible block states)
  - **Neighborhood:** 2×2 block structure (Margolus neighborhood); alternating partition every generation
  - **Grid Topology:** Square lattice; must be even-sized in both dimensions
  - **Update Mode:** Fully synchronous block updates; two alternating partition schemes per cycle
  - **Reversibility:** Bijective state transitions (permutation of 16 block states)
  - **Conservation:** Particle/energy/momentum typically conserved
  - **Interaction Range:** Radius 1 in block space (2 cells in original lattice)

### 1.7 Crystal/Snowflake Growth (Reiter Model)

- **Field:** Physics / Earth Science / Crystallography
- **Originator(s) and Year:** Clifford A. Reiter; 2005 (and earlier work in 1980s–1990s)
- **Key Publication:** Reiter, C. A. (2005) "A local cellular model for snow crystal growth," *Chaos, Solitons & Fractals*, 23(4), 1111–1119.
- **Description:** A 2D hexagonal-lattice CA model of snowflake growth. Each cell holds a real value representing water amount at that location (0 = water vapor, ≥1 = ice). The rule has two key parameters controlling nucleation and diffusion. Ice-like cells are "fixed" (receptive to vapor diffusion from neighbors), while non-ice cells undergo diffusion to neighbors. Vapor diffuses preferentially to ice cell boundaries, creating the characteristic dendritic patterns. Different parameter settings reproduce different snowflake morphologies (plates, dendrites, sectors) observed at different temperatures and saturations.
- **Why Significant:** Elegantly demonstrates emergence of fractal-like natural patterns from simple local rules. Widely used in teaching and art. Predicts real crystal morphologies; validates diffusion-limited growth theories.
- **Distinguishing CA Features:**
  - **State:** Real-valued (water/vapor concentration per cell)
  - **Neighborhood:** Hexagonal (six neighbors, reflecting crystal symmetry)
  - **Grid Topology:** Hexagonal lattice
  - **Update Mode:** Synchronous or sequential (different orders give slightly different patterns)
  - **Stochasticity:** Typically deterministic, but minor noise can be added for realism
  - **Boundary Dynamics:** Boundary cells undergo diffusion; interior ice is static
  - **Parameters:** Temperature and supersaturation (controls relative rates of nucleation and diffusion)
  - **Symmetry:** Sixfold rotational due to hexagonal lattice

---

## 2. CHEMISTRY & REACTION-DIFFUSION

Cellular automata naturally represent reaction-diffusion systems, where chemical concentrations evolve locally based on reactions and diffusion. Many iconic patterns (spirals, stripes, spots) emerge from simple CA rules.

### 2.1 Belousov-Zhabotinsky Reaction (CA Modeling)

- **Field:** Chemistry / Excitable Media
- **Originator(s) and Year:** Boris Belousov (1950s, experimental); Anatol Zhabotinsky (1960s); CA models later (1980s–2000s)
- **Key Publication:** Experimental: Belousov, B. P. (1959), *Oscillations of oxidizing reactions*, unpublished; Zhabotinsky, A. M. (1964) "Periodic processes of malonic acid oxidation in a liquid phase," *Biofizika*, 9, 306–311. CA variant: See references in Chopard & Droz (1998).
- **Description:** The Belousov-Zhabotinsky (BZ) reaction is a chemical oscillator; when stirred, it undergoes periodic color changes; when unstirred in a thin layer (petri dish), it forms expanding concentric rings and spirals. CA models represent BZ as a grid of cells, each storing concentrations of key chemical species (e.g., activator, inhibitor, as continuous or discrete states). Simple CA rules implement diffusion and reaction kinetics locally. As the system evolves, stable spiral waves and traveling pulses emerge spontaneously. The Hodgepodge Machine (see below) is a direct CA analogue.
- **Why Significant:** Iconic example of spatiotemporal self-organization and pattern formation in chemical systems. Demonstrates that complex macroscopic behavior emerges from simple local chemical rules. Links theory (Turing patterns) with real experiments.
- **Distinguishing CA Features:**
  - **State:** Real or integer vectors (typically 2–4 concentrations per cell: activator, inhibitor, etc.)
  - **Neighborhood:** Moore (8 neighbors) or von Neumann (4 neighbors)
  - **Grid Topology:** Square lattice, typically open or large
  - **Update Mode:** Synchronous
  - **Reaction Kinetics:** Nonlinear transitions based on local state
  - **Diffusion:** Smoothing rules (e.g., state ← 0.7 × state + 0.3 × average(neighbors))
  - **Wave Phenomena:** Spiral and concentric waves emerge; no explicit wave rules
  - **Multi-species:** Typically 3–4 species for realistic BZ behavior

### 2.2 Hodgepodge Machine

- **Field:** Chemistry / Excitable Media
- **Originator(s) and Year:** Martin Gerhardt and Heike Schuster, University of Bielefeld; 1989
- **Key Publication:** Gerhardt, M., Schuster, H., & Tyson, J. J. (1990) "A cellular automaton model of excitable media," *Physica D*, 46(3), 392–415.
- **Description:** A 2D CA designed to simulate excitable chemical reactions (particularly BZ). Each cell's state is an integer from 0 to *n* (typically 0–255), representing infection or excitation level. State 0 = healthy (resting), state *n* = ill (excited), intermediate states = infected (refractory). Local update rule: if the cell is healthy, new state = (*a* / *k*₁) + (*b* / *k*₂), where *a* is count of infected neighbors, *b* is count of ill neighbors, and *k*₁, *k*₂ are constants. Non-healthy cells increment toward ill or decrement toward recovery. Results in oscillatory, wave-like dynamics with spiral patterns similar to BZ experiments.
- **Why Significant:** Directly bridged cellular automata and chemical reaction kinetics; simple discrete rules reproduce BZ wave phenomena. Used in education and early work on pattern formation.
- **Distinguishing CA Features:**
  - **State:** Integer, typically 0–255 (infection level, not binary)
  - **Neighborhood:** Moore (8 neighbors)
  - **Grid Topology:** Square lattice, typically toroidal
  - **Update Mode:** Synchronous
  - **Threshold Dynamics:** Multi-level (0 = healthy, intermediate = infected, max = ill); recovery via decay
  - **Nonlinear Interactions:** Count-based rule (number of infected neighbors)
  - **Wave Propagation:** Spiral and concentric waves emerge
  - **Parameters:** *k*₁ and *k*₂ control oscillation rates and pattern scales

### 2.3 Gray–Scott Model (Reaction-Diffusion)

- **Field:** Chemistry / Pattern Formation
- **Originator(s) and Year:** Peter Gray and Stephen K. Scott; 1983 (continuous PDE); CA variant by many authors (1990s–2000s)
- **Key Publication:** Gray, P. & Scott, S. K. (1983) "Autocatalytic reactions in the isothermal, continuous stirred tank reactor: oscillations and instabilities in the system A + 2B → 3B; B → C," *Proceedings of the Royal Society of London*, A415, 461–432. CA descriptions in Wolfram Demonstrations and various papers.
- **Description:** A reaction-diffusion system with two chemical species: *U* (feed) and *V* (catalyst). Rules: *U* undergoes reaction with *V* (autocatalytic, →*V*); *V* decays; both diffuse. A CA version represents *U* and *V* as continuous scalar fields (one per cell). Each timestep: update reaction (based on local *U*, *V*, and rates *F* and *k*), then apply diffusion (neighboring cell values influence local concentration). By varying *F* (feed rate) and *k* (decay rate), the system exhibits diverse patterns: stable spots, stripes, labyrinth, chaos, and solitons. Directly comparable to real chemical experiments.
- **Why Significant:** Demonstrates that simple chemical reactions can produce Turing-pattern-like self-organization without explicit morphogenetic genes. Gray–Scott patterns resemble animal skin pigmentation, plant markings, and embryonic patterning. Central to understanding diffusion-driven instability.
- **Distinguishing CA Features:**
  - **State:** Two continuous real-valued fields per cell (*U* and *V* concentrations)
  - **Neighborhood:** Moore, von Neumann, or larger (diffusion range)
  - **Grid Topology:** Square lattice, typically toroidal (no flux boundaries)
  - **Update Mode:** Synchronous; reaction before diffusion (or vice versa)
  - **Diffusion:** Linear diffusion operator (weighted sum of neighbor values)
  - **Reaction Kinetics:** Cubic nonlinearity (*U* + 2*V* → 3*V*; *V* → ∅)
  - **Parameter Sensitivity:** Small changes in *F* and *k* cause dramatic pattern shifts
  - **Wave Phenomena:** Traveling waves, spirals, and solitary structures can occur

### 2.4 Turing Patterns (CA Implementation)

- **Field:** Chemistry / Biology / Pattern Formation
- **Originator(s) and Year:** Alan M. Turing (1952, continuous PDE); discrete CA implementations (1980s–2000s, various authors)
- **Key Publication:** Turing, A. M. (1952) "The chemical basis of morphogenesis," *Philosophical Transactions of the Royal Society B*, 237, 37–72. CA versions: Young, D. A. (1984) "A local activator-inhibitor model of vertebrate skin patterns," *Mathematical Biosciences*, 72, 51–58.
- **Description:** Turing's theory: two chemicals (activator *A*, inhibitor *I*) interact and diffuse at different rates; under certain conditions (activator diffuses slowly, inhibitor quickly), spatially uniform states become unstable, and smooth patterns (spots, stripes, labyrinths) spontaneously form. CA implementation: each cell holds *A* and *I* concentrations. Update: reaction step (typically *A* increases *A* and *I*, *I* inhibits *A*), then diffusion step. Different parameter ratios produce different steady-state patterns. Explanatory theory for animal coat patterns, plant leaf margins, and embryonic patterning.
- **Why Significant:** Turing's foundational work on morphogenesis; explains spontaneous pattern formation without explicit positional information. CA implementations provide efficient, intuitive simulations. Links mathematics, physics, chemistry, and biology.
- **Distinguishing CA Features:**
  - **State:** Two real-valued concentrations per cell (activator and inhibitor)
  - **Neighborhood:** von Neumann or Moore (diffusion range)
  - **Grid Topology:** 2D square lattice, toroidal boundary
  - **Update Mode:** Synchronous; alternating reaction and diffusion steps
  - **Reaction Kinetics:** Specific nonlinear forms (e.g., *A* → 2*A* + *I*, *I* → ∅)
  - **Diffusion Rates:** Must differ between species; critically affects patterns
  - **Stochasticity:** None (deterministic)
  - **Pattern Sensitivity:** Critical transition parameters; bifurcation analysis required

### 2.5 Greenberg–Hastings Excitable Media Model

- **Field:** Chemistry / Excitable Media / Physics
- **Originator(s) and Year:** James M. Greenberg and Stuart P. Hastings; 1978
- **Key Publication:** Greenberg, J. M. & Hastings, S. P. (1978) "Spatial patterns for discrete models of diffusion in excitable media," *SIAM Journal on Applied Mathematics*, 34(3), 515–523.
- **Description:** A 3-state cellular automaton: resting (R), excited (E), refractory (F). Rules: E → F (always), F → R (always), R → E if at least one neighbor is E (typically a threshold, e.g., ≥1 excited neighbor). A cell cannot refire until it has recovered. This implements an excitable medium: stimulation generates propagating pulses that cannot travel backward through refractory zones. Spiral waves and concentric rings emerge as stable patterns.
- **Why Significant:** Simple, exactly solvable model of excitable dynamics. Demonstrates spiral wave formation in a minimal system. Widely used in neuroscience, cardiology, and chemical physics to study autowaves and pattern stability.
- **Distinguishing CA Features:**
  - **State:** Ternary (0=resting, 1=excited, 2=refractory) or multi-state (levels of refractoriness)
  - **Neighborhood:** Typically Moore or von Neumann
  - **Grid Topology:** 2D square lattice, toroidal or open
  - **Update Mode:** Synchronous
  - **Threshold Rule:** Excited if ≥*k* neighbors are excited (typically *k*=1)
  - **Refractory Period:** Fixed number of steps before recovery
  - **Wave Phenomena:** Stable spiral waves and concentric rings
  - **Stochasticity:** None (fully deterministic)

### 2.6 FitzHugh–Nagumo Model (CA Variant)

- **Field:** Neuroscience / Excitable Media
- **Originator(s) and Year:** Richard FitzHugh (1961) and Jinichi Nagumo (1962); CA implementations later
- **Key Publication:** FitzHugh, R. (1961) "Impulses and physiological states in theoretical models of nerve membrane," *Biophysical Journal*, 1(6), 445–466. Nagumo, J., Arimoto, S., & Yoshizawa, S. (1962) "An active pulse transmission line simulating nerve axon," *Proceedings of the IRE*, 50(10), 2061–2070.
- **Description:** A 2-variable model of neuronal excitability. Variables: *V* (membrane voltage, fast), *w* (recovery/gating variable, slow). Dynamics couple cubic nonlinearity with linear recovery feedback. When voltage crosses threshold, rapid depolarization occurs; slow recovery brings system back to rest. CA version: each cell's state is (*V*, *w*); update involves local nonlinear kinetics plus diffusive coupling to neighbors. Produces action potentials (spikes) and, in spatial settings, traveling waves along neural fibers.
- **Why Significant:** Prototypical reduced model of neuronal dynamics; much simpler than Hodgkin–Huxley but retains essential excitability. CA version allows study of spatiotemporal waves in neural tissue. Used in cardiac electrophysiology and general excitability studies.
- **Distinguishing CA Features:**
  - **State:** Two real-valued variables per cell (*V* and *w*)
  - **Neighborhood:** von Neumann or Moore (for diffusive coupling)
  - **Grid Topology:** 1D or 2D lattice
  - **Update Mode:** Synchronous
  - **Nonlinearity:** Cubic in *V*; linear in *w*
  - **Time-Scale Separation:** *V* changes fast, *w* slowly (ε parameter)
  - **Diffusion:** Only voltage typically diffuses; recovery is local
  - **Wave Phenomena:** Traveling pulses, restitution curves, spiral waves (in 2D)

---

### 2.7 Kier–Seybold–Cheng Water & Solute Diffusion CA

- **Field:** Chemistry / Solution Chemistry (foundational for chromatography CA)
- **Originator(s) and Year:** Lemont B. Kier, Paul G. Seybold, Chao-Kun Cheng (Virginia Commonwealth University); core papers 1990–2009
- **Key Publication:** Kier, L. B., & Cheng, C.-K. (2000). "A Cellular Automata Model of Water." *Journal of Chemical Information and Modeling*, 40(2), 374–382. DOI: 10.1021/ci00019a026. Textbook: Kier, Seybold & Cheng (2005), *Modeling Chemical Systems using Cellular Automata: A Textbook and Laboratory Manual*, Springer (ISBN 978-1-4020-3690-6).
- **Description:** Lattice-based CA representing liquid water and dissolved solutes. Water structure is modelled as fractions of unbound and multiply-hydrogen-bonded H₂O molecules; solute diffusion is governed by probabilistic breaking of solute–water hydrogen bonds and translational steps on the lattice. Stochastic dynamics mimic random walk; bond-breaking probability depends on solute hydropathy.
- **Significance:** Demonstrates that CA can capture water's anomalous diffusion behaviour and the hydrophobic effect — predicts that lipophilic solutes diffuse faster than polar ones. Foundational textbook widely used in computational chemistry education; provides the substrate that later chromatography CAs build on.
- **Distinguishing CA Features:**
  - Attributes: integer (H-bond count), boolean (solute presence), float (state lifetime)
  - Neighborhood: von Neumann or Moore (local interactions)
  - Update mode: stochastic, asynchronous (random order of water and solute moves)
  - Topology: 3D cubic lattice (also reduced to 2D in pedagogical variants)
  - Stochasticity: yes — random H-bond breaking, random walk
  - Multi-species: yes — water, solute, optionally dissolved gas

### 2.8 DeSoi–Kier Enantiomer Separation CA (β-Cyclodextrin Chromatography)

- **Field:** Chemistry / Chromatography
- **Originator(s) and Year:** Darren DeSoi, Lemont B. Kier, Chao-Kun Cheng, H. Thomas Karnes (Virginia Commonwealth University); 2013
- **Key Publication:** DeSoi, D., Kier, L. B., Cheng, C.-K., & Karnes, H. T. (2013). "An expanded cellular automata model for enantiomer separations using a β-cyclodextrin stationary phase." *Journal of Chromatography A*, 1291, 73–83.
- **Description:** A 2D cellular automaton grid simulates a chromatographic column where enantiomers diffuse, interact with β-cyclodextrin stationary-phase sites via CA rules encoding binding affinity, and move under mobile-phase flow. The model scales from molecular one-to-one binding interactions up to full HPLC chromatograms with predicted retention factors and selectivity (α values). Diffusion and adsorption kinetics are encoded in stochastic transition probabilities.
- **Significance:** First CA model of chromatographic separation dynamics at column scale; successfully predicts both selectivity and peak resolution for multiple enantiomers (mandelic acid, brompheniramine, cyclohexylphenylglycolic acid) at varying temperatures. Demonstrates CA can replace fine continuum models for chiral separations; pedagogically valuable for teaching partition equilibrium and band broadening.
- **Distinguishing CA Features:**
  - Attributes: integer (enantiomer count per cell), float (concentration / time / temperature-dependent affinity)
  - Neighborhood: von Neumann (local diffusion and binding)
  - Update mode: stochastic kinetic Monte Carlo (binding events probabilistic; flow deterministic)
  - Topology: 2D square lattice (column cross-section × axial flow)
  - Stochasticity: yes — random binding/unbinding and random-walk diffusion
  - Multi-species: yes — two enantiomers, mobile phase, stationary-phase β-CD
  - Conserved quantities: enantiomer mass within the column (loss / elution allowed)

### 2.9 Aerogel Supercritical Fluid Chromatography CA

- **Field:** Chemistry / Chromatography
- **Originator(s) and Year:** ~2010–2015 (silica-aerogel SFC literature; first authors not definitively recovered in open search)
- **Key Publication:** "Application of silica aerogels as stationary phase in supercritical fluid chromatography: experimental study and modelling with cellular automata." (ResearchGate publication 260200933.)
- **Description:** A discrete CA on a 2D or 3D lattice models PAH solute molecules (naphthalene, anthracene, etc.) moving under a pressure gradient (mobile-phase flow) in a porous aerogel stationary phase. Lattice sites represent aerogel pores and surface; solute diffusion is Brownian and adsorption / desorption onto the surface is stochastic with explicit temperature and pressure dependence. Excluded volume prevents multiple solutes per site.
- **Significance:** Validates CA for realistic chromatographic hardware (aerogel columns); demonstrates quantitative agreement between simulated retention factors and experimental data across multiple operating conditions. Shows CA can model porous-media chromatography without solving Navier–Stokes equations.
- **Distinguishing CA Features:**
  - Attributes: boolean or integer (solute occupancy), float (pressure, temperature fields)
  - Neighborhood: von Neumann (local diffusion)
  - Update mode: hybrid — deterministic pressure gradient + stochastic adsorption
  - Topology: 2D or 3D, with explicit pore-scale morphology idealised on lattice
  - Stochasticity: yes — random diffusion and adsorption / desorption events
  - Multi-species: yes — multiple PAH species; mobile phase implicit
  - Conserved quantities: total solute mass (within column boundary)

### 2.10 Larson–Scriven–Davis Lattice Monte Carlo for Amphiphile Self-Assembly

- **Field:** Chemistry / Self-Assembly
- **Originator(s) and Year:** R. G. Larson, L. E. Scriven, H. T. Davis (University of Minnesota); core papers 1985, 1988, 1989
- **Key Publication:** Larson, R. G. (1988). "Monte Carlo lattice simulation of amphiphilic systems in two and three dimensions." *Journal of Chemical Physics*, 89(3), 1642–1650. DOI: 10.1063/1.455243. Earlier: Larson, Scriven & Davis (1985), *J. Chem. Phys.*, 83(5), 2411–2420 (DOI: 10.1063/1.449286). Phases: Larson (1989), *J. Chem. Phys.*, 91(4), 2479–2488 (DOI: 10.1063/1.457010).
- **Description:** A square / cubic lattice (2D or 3D) where oil and water occupy single sites and amphiphiles are chains of adjacent sites with a hydrophilic head and hydrophobic tail(s). Monte Carlo moves include kink diffusion, rotation and translation of amphiphile chains. The model exhibits self-assembly of spherical micelles, cylindrical micelles, lamellar bilayers, bicontinuous phases and inverted structures depending on amphiphile concentration, chain length and head/tail ratio R. Critical micelle concentration, aggregation numbers and phase diagrams are computed by ensemble averaging over MC trajectories.
- **Significance:** Paradigm-establishing work for computational colloid chemistry (>1000 citations). Demonstrates that geometric packing constraints govern micelle morphology; enables prediction of CMC as a function of chemical structure; accommodates multiple aggregate morphologies in a single model; calibrated to experimental surfactant systems (SDS, nonionic surfactants).
- **Distinguishing CA Features:**
  - Attributes: integer (chain segment type: head, tail, oil, water), vector (chain orientation)
  - Neighborhood: nearest-neighbour lattice (4 in 2D square, 6 in 2D honeycomb, 26 in 3D with diagonals)
  - Update mode: stochastic Metropolis Monte Carlo, ~1000s of MC sweeps per trajectory
  - Topology: 2D square or 3D cubic lattice (also 2D hex in later variants)
  - Stochasticity: yes — moves accepted/rejected via Boltzmann weight
  - Multi-species: yes — amphiphile, oil, water with asymmetric head/tail interaction
  - Conserved quantities: total molecule count per phase; total chain length

### 2.11 Kier–Cheng–Testa Percolation CA for Micelle Formation

- **Field:** Chemistry / Self-Assembly
- **Originator(s) and Year:** Lemont B. Kier, Chao-Kun Cheng, Bernard Testa, Paul-André Carrupt; 1996
- **Key Publication:** Kier, L. B., Cheng, C. K., Testa, B., Carrupt, P.-A. (1996). "A Cellular Automata Model of Micelle Formation." *Pharmaceutical Research*, 13, 1419–1422. PubMed ID: 8893286.
- **Description:** A pure stochastic CA (not full lattice Monte Carlo) where amphiphiles are modelled by treating each face of a square lattice cell as an independent structure. The model predicts the onset concentration and 50%-probability of a spanning cluster, which coincides with percolation phenomena and the critical micelle concentration (CMC). Water and solution phenomena are represented in the discrete grid.
- **Significance:** Pioneering application of CA to amphiphilic self-assembly; demonstrates that percolation theory predicts micellisation; smaller code footprint than Larson lattice MC and conceptually distinct (global cluster connectivity rather than thermodynamic energy minimisation). Motivated Kier's broader chemistry CA programme.
- **Distinguishing CA Features:**
  - Attributes: multi-state (amphiphile orientation per cell face; water occupation), integer phase occupancy
  - Neighborhood: von Neumann or Moore
  - Update mode: stochastic kinetic; asynchronous
  - Topology: 2D square lattice
  - Stochasticity: yes — random bond breaking / forming
  - Multi-species: yes — amphiphile, water; implicit oil phase
  - Special requirement: cluster / connected-component detection (spanning cluster as the order parameter)

### 2.12 Smit–Esselink–Hilbers Lattice Surfactant Phase Diagrams

- **Field:** Chemistry / Self-Assembly
- **Originator(s) and Year:** B. Smit, K. Esselink, P. A. J. Hilbers, N. M. van Os, L. A. M. Rupert, I. Szleifer; 1992–1993
- **Key Publication:** Smit, B. et al. (1992). "Phase diagram for the lattice model of amphiphile and solvent mixtures by Monte Carlo simulation." *Journal of the Chemical Society, Faraday Transactions*, 88(18), 2163–2171.
- **Description:** A 3D simple cubic lattice model where amphiphiles are flexible chains (typically 4–8 segments) of explicit head and tail segments; solvent (water) occupies remaining sites. Monte Carlo simulations in the NPT ensemble (constant pressure and temperature) explore the phase space. The model exhibits a detailed temperature–concentration phase diagram showing micelle formation at low concentration, mixed micellar / aggregate regions at intermediate concentration, and transitions to bilayer, lamellar and bicontinuous phases at higher concentrations.
- **Significance:** Demonstrates that a simple lattice model reproduces experimentally observed phase behaviour (CMC, micellar solution structure, bilayer transitions); computes surface tension and elasticity of bilayers. Influential for understanding thermodynamic driving forces in self-assembly; widely extended to mixed surfactant systems, ionic surfactants and polymer–amphiphile blends.
- **Distinguishing CA Features:**
  - Attributes: integer (site type: head, tail, water)
  - Neighborhood: nearest-neighbour on cubic lattice (coordination number 6)
  - Update mode: stochastic Metropolis Monte Carlo; NPT ensemble (volume fluctuates)
  - Topology: 3D cubic lattice with periodic boundary conditions
  - Stochasticity: yes — random moves, volume scaling, chain configuration sampling
  - Multi-species: yes — amphiphile (head + tail) and water
  - Conserved quantities: molecule counts; volume changes via NPT ensemble

## 3. BIOLOGY & MEDICINE

Cellular automata have provided insights into cellular growth, tumor dynamics, morphogenesis, and tissue-level phenomena. The discrete, local-interaction nature of CA mirrors biological cell behavior.

### 3.1 Conway's Game of Life

- **Field:** Computer Science / Theoretical Biology / Recreation
- **Originator(s) and Year:** John Horton Conway; 1970
- **Key Publication:** Gardner, M. (1970) "Mathematical Games: The fantastic combinations of John Conway's new solitaire game 'life'," *Scientific American*, 223(4), 120–123.
- **Description:** A 2D binary cellular automaton with 2 states (alive/dead) and Moore neighborhood. Rules (B3/S23): A dead cell becomes alive if exactly 3 alive neighbors; an alive cell survives if it has 2 or 3 alive neighbors; else it dies (starvation or overcrowding). Despite simplicity, Game of Life produces astonishing complexity: still lifes, oscillators, spaceships, and gliders; universal Turing-complete computation possible. Starting from a random or minimal seed, intricate structures emerge and persist.
- **Why Significant:** Canonical example of complexity from simple rules; demonstrates computational universality in CA. Sparked interest in CA and artificial life. Remains the most-studied CA; countless variations exist.
- **Distinguishing CA Features:**
  - **State:** Binary (0=dead, 1=alive)
  - **Neighborhood:** Moore (8 neighbors)
  - **Grid Topology:** Infinite 2D square lattice (usually finite with open boundary, or toroidal)
  - **Update Mode:** Fully synchronous
  - **Stochasticity:** None
  - **Computation:** Turing-complete; supports arbitrary universal computation
  - **Gliders/Spaceships:** Mobile structures propagating across grid
  - **Long-Range Effects:** None (all interaction ≤1 cell distance)

### 3.2 Eden Model (Growth/Aggregation)

- **Field:** Biology / Mathematics
- **Originator(s) and Year:** Murray Eden; 1961
- **Key Publication:** Eden, M. (1961) "A two-dimensional growth process," in *Proceedings of the Fourth Berkeley Symposium on Mathematical Statistics and Probability*, pp. 223–239.
- **Description:** A stochastic growth model on a lattice. Start with a single seed cell (black); at each timestep, choose a uniformly random unoccupied cell adjacent to the existing cluster and add it (color it black). This creates a "blob"—a connected cluster growing outward. After *t* steps, the cluster has *t*+1 cells. Properties: interior density equilibrates to ~0.65, boundary is rough and fractal (~dimension ~1.7 in 2D), overall shape approaches circular with stochastic fluctuations.
- **Why Significant:** Simplest stochastic growth model; used to study bacterial colonies, tumor growth, wound healing, and percolation. Provides baseline for more complex models.
- **Distinguishing CA Features:**
  - **State:** Binary (0=unoccupied, 1=cluster)
  - **Neighborhood:** von Neumann (can also be Moore)
  - **Grid Topology:** 2D square lattice, open boundary (cluster grows into empty space)
  - **Update Mode:** Sequential (random selection of boundary cells)
  - **Stochasticity:** Essential (random cell selection)
  - **Growth Rate:** Linear in time
  - **Boundary Roughness:** Fractal structure; not smooth
  - **Conservation:** None (cells only added, not conserved)

### 3.3 Anderson–Chaplain Tumor Growth Model

- **Field:** Medicine / Oncology
- **Originator(s) and Year:** Alexander R. A. Anderson and Mark A. J. Chaplain; 1998
- **Key Publication:** Anderson, A. R. & Chaplain, M. A. J. (1998) "Continuous and discrete mathematical models of tumor-induced angiogenesis," *Bulletin of Mathematical Biology*, 60(5), 857–900.
- **Description:** A hybrid cellular automaton–continuum model of solid tumor growth. Discrete part: each cell in the lattice is either tumor, vasculature (blood vessel), or empty. Tumor cells proliferate, migrate, and degrade extracellular matrix (ECM). Continuum part: oxygen concentration and matrix-degradative enzyme (MDE) concentration are treated as PDEs defined on the lattice. At each timestep: solve PDEs for oxygen and MDE (on grid of cell locations), update tumor cells based on local oxygen (if too low, tumor cell dies or becomes quiescent), move cells based on chemotaxis and mechanical pressure. Results show vascular invasion, irregular growth fronts, and necrotic cores—qualitative features of real tumors.
- **Why Significant:** Foundational hybrid model showing how discrete cell behavior, coupled with continuum biochemistry, produces realistic tumor morphologies. Used widely in computational oncology.
- **Distinguishing CA Features:**
  - **State:** Cell type (tumor, vessel, empty) at discrete lattice sites; plus continuous PDE fields (O₂, MDE)
  - **Neighborhood:** von Neumann or Moore (cell communication)
  - **Grid Topology:** 2D square lattice
  - **Update Mode:** Synchronous for discrete cells; PDEs on same grid
  - **Hybrid Nature:** Discrete CA + continuous PDEs (not purely discrete)
  - **Multi-species:** Tumor cells, endothelial cells, ECM, biochemicals (O₂, MDE)
  - **Chemotaxis:** Cells move up gradients (PDEs)
  - **Death/Proliferation:** Rate-dependent on local oxygen

### 3.4 Cellular Potts Model (Glazier–Graner–Hogeweg)

- **Field:** Biology / Tissue Dynamics
- **Originator(s) and Year:** James A. Glazier and François Graner (1992); extended by Paulien Hogeweg
- **Key Publication:** Glazier, J. A. & Graner, F. (1992) "Simulation of the differential adhesion driven rearrangement of biological cells," *Physical Review E*, 47(3), 2128–2154. Hogeweg, P. (2000) "Evolving mechanisms of morphogenesis," *International Journal of Developmental Biology*, 46, 645–655.
- **Description:** A lattice-based model where each cell (biological cell, not lattice site) is a cluster of lattice sites sharing a unique ID. Each lattice site stores the ID of the cell occupying it. Energy function includes adhesion (surface tension between cell types), volume constraints, and surface area. At each MC step: propose an exchange of a random lattice site from cell A with a neighbor from cell B; accept based on Metropolis dynamics (probability ∝ exp(−ΔE/*T*)). Cells move, deform, and rearrange based on energy minimization. Supports cell–cell adhesion differences, morphogenesis, cell sorting, and complex tissue shapes.
- **Why Significant:** Most realistic discrete model of cell-level tissue dynamics; captures volume and shape changes. Widely used in developmental biology to study gastrulation, cell sorting, and tumor growth. Bridges discrete (individual cells) and continuum (tissue-level) scales.
- **Distinguishing CA Features:**
  - **State:** Cell ID per lattice site (integer); each "cell" is a connected region
  - **Neighborhood:** von Neumann or Moore
  - **Grid Topology:** 2D or 3D square lattice
  - **Update Mode:** Asynchronous; Monte Carlo (random lattice site updates)
  - **Stochasticity:** Essential (Metropolis algorithm)
  - **Energy Function:** Adhesion + volume constraints + perimeter penalties
  - **Multi-type:** Multiple cell types with different adhesions (differential adhesion)
  - **Shape Flexibility:** Cells can deform extensively

### 3.5 Excitable Cardiac Tissue (Arrhythmia) Model

- **Field:** Medicine / Cardiology
- **Originator(s) and Year:** Various authors (1980s–2000s); based on FitzHugh–Nagumo and other models
- **Key Publication:** Courtemanche, M., Ramirez, R. J., & Nattel, S. (1998) "Ionic mechanisms underlying human atrial action potential properties," *American Journal of Physiology*, 275(1), H301–H321 (continuous model); CA versions in various computational cardiology works.
- **Description:** 2D or 3D CA of cardiac tissue. Each cell represents a small patch of myocardium; state includes voltage (*V*) and recovery variables (*u*, *v*). Local update rule simulates action potential (AP) generation: *V* increases (inward current), reaches threshold, depolarizes rapidly, then repolarizes slowly via recovery. Neighboring cells couple electrically (diffusion of voltage). If a region becomes refractory before excitation can propagate, a spiral (re-entry) can form, causing arrhythmia. By modulating coupling strength or refractory period, one studies normal vs. arrhythmic regimes.
- **Why Significant:** Provides mechanistic understanding of cardiac arrhythmias (atrial fibrillation, ventricular tachycardia). Used to test antiarrhythmic drugs and pacing strategies. Computationally efficient compared to ionic models.
- **Distinguishing CA Features:**
  - **State:** 2–4 real-valued variables per cell (voltage *V*, gates *u*, *v*, etc.)
  - **Neighborhood:** von Neumann (electrical coupling)
  - **Grid Topology:** 2D or 3D lattice (3D more realistic)
  - **Update Mode:** Synchronous
  - **Excitability:** Threshold-based; refractory period crucial
  - **Spiral Waves:** Re-entrant vortices form under certain conditions
  - **Tissue Anisotropy:** Can include preferential conduction (different rates in x vs. y)
  - **Boundary Conditions:** Open or periodic; impact on re-entry stability

### 3.6 Gene Regulatory Network (Boolean, Kauffman-style)

- **Field:** Biology / Genetics / Systems Biology
- **Originator(s) and Year:** Stuart A. Kauffman (1969); Boolean network interpretation; later CA variants
- **Key Publication:** Kauffman, S. A. (1969) "Metabolic stability and epigenesis in randomly constructed genetic nets," *Journal of Theoretical Biology*, 22(3), 437–467. CA extensions: various papers from 2010s onward.
- **Description:** A network of binary genes (ON/OFF). Each gene's next state is determined by a local Boolean function of inputs from other genes (typically 2–3 regulators per gene). All genes update synchronously. Long-term behavior: the network settles into attractors (stable states or limit cycles, called "attractors"). The structure and size of attractors depend on network topology and rule complexity. Can model developmental pathways, cell-state transitions, and disease mechanisms. CA variant: genes are lattice cells with local (or small-world) connectivity.
- **Why Significant:** Provides conceptual framework for understanding genetic regulation without detailed molecular knowledge. Explains how complex cellular behavior (differentiation, homeostasis) emerges from gene regulatory logic. Relevant to cancer, development, and evolution.
- **Distinguishing CA Features:**
  - **State:** Binary per cell (gene ON/OFF)
  - **Neighborhood:** Variable; typically 2–4 input genes per cell, not necessarily neighbors
  - **Grid Topology:** Can be regular lattice (local) or random network (small-world)
  - **Update Mode:** Synchronous (all genes update simultaneously)
  - **Boolean Functions:** Look-up table per gene (AND, OR, XOR, etc.)
  - **Stochasticity:** None (deterministic attractors)
  - **Attractor Dynamics:** System converges to fixed points or limit cycles
  - **Scaling:** Can have 10s to 1000s of genes

### 3.7 Virus/Immune System CA Model

- **Field:** Medicine / Immunology / Virology
- **Originator(s) and Year:** Various authors (1990s–2010s); Immune System Simulator (IMMSIM) notable
- **Key Publication:** Farmer, J. D., Packard, N. H., & Perelson, A. S. (1986) "The immune system, adaptation, and machine learning," *Physica D*, 22(1–3), 187–204 (early reference).
- **Description:** A spatial CA where lattice cells represent tissue; cell state indicates whether the cell is healthy, infected (virus present), or dying. Immune cells (T-cells, antibodies) are modeled as mobile agents moving through the grid. Locally: healthy cells can be infected by neighboring virus particles (increasing stochastically); infected cells produce virus (replicating at a rate); immune cells detect antigen on infected cells and kill them. Model can include viral mutation, immune memory, and latency. Evolutionary arms race between virus and immune system emerges.
- **Why Significant:** Explains immune-viral dynamics spatially; shows how local interactions (cell death, immune response) produce complex population-level dynamics. Applicable to HIV, influenza, and other infections. Supports vaccine design and therapy timing.
- **Distinguishing CA Features:**
  - **State:** Cell state (healthy, infected, dead, or immune cell type) per lattice site; can be multi-state or vector
  - **Neighborhood:** Moore or von Neumann (local spread and immune reconnaissance)
  - **Grid Topology:** 2D or 3D lattice
  - **Update Mode:** Asynchronous (immune cells move stochastically; infections probabilistic)
  - **Stochasticity:** High (probabilistic infection, immune response, mutation)
  - **Multi-agent:** Immune cells tracked individually (not purely cellular automaton in strict sense, but CA-like)
  - **Temporal Dynamics:** Acute vs. chronic infection emerges from rules
  - **Heterogeneity:** Multiple immune cell types, multiple viral variants

---

## 4. ECOLOGY & ENVIRONMENTAL SCIENCE

Cellular automata are natural for modeling spatial population dynamics, where local interactions (predation, competition, birth/death) drive global patterns.

### 4.1 Forest Fire Model (Drossel–Schwabl)

- **Field:** Ecology / Self-Organized Criticality
- **Originator(s) and Year:** Barbara Drossel and Friedrich Schwabl; 1992
- **Key Publication:** Drossel, B. & Schwabl, F. (1992) "Self-organized criticality in a forest-fire model," *Physica A*, 191(1–4), 47–52.
- **Description:** A 2D CA where each cell is empty, occupied by a tree, or burning. Rules: Empty cells regrow with small probability *p*; trees catch fire if a neighbor is burning (ignition); burning trees become empty. A lightning strike (additional small probability) ignites trees randomly, introducing external excitation. At criticality (tuned *p*), avalanche size distribution is power-law (scale-free). No explicit parameter tuning needed; system self-organizes to criticality.
- **Why Significant:** Classical example of self-organized criticality (SOC). Explains universal scaling in forest fires, earthquakes, and sandpiles without fine-tuning. Inspired paradigm shift in understanding complex systems.
- **Distinguishing CA Features:**
  - **State:** Ternary (0=empty, 1=tree, 2=burning)
  - **Neighborhood:** von Neumann (fire spreads orthogonally)
  - **Grid Topology:** 2D square lattice, periodic
  - **Update Mode:** Synchronous
  - **Stochasticity:** Two parameters: growth probability *p*, lightning probability *f*
  - **Avalanche Dynamics:** Power-law cluster size distribution
  - **External Drive:** Lightning strikes; tuning ignition rate approaches criticality
  - **Dissipation:** Burning trees disappear (energy loss)

### 4.2 WaTor Model (Wa-Tor: Predator-Prey CA)

- **Field:** Ecology / Population Dynamics
- **Originator(s) and Year:** Alexander K. Dewdney; 1984
- **Key Publication:** Dewdney, A. K. (1984) "Sharks and fish wage an ecological war on the toroidal planet Wa-Tor," *Scientific American*, 251(12), 14–22.
- **Description:** A 2D toroidal CA modeling predator-prey dynamics on a hypothetical planet. Three cell states: empty, fish (prey), shark (predator). Rules: Fish move to a random neighboring empty cell and reproduce if mature (age ≥ threshold); sharks move to a fish (eating it) or empty cell, and reproduce if they've eaten enough; starving sharks die. Simple breeding ages and energy thresholds create cyclic population dynamics: high fish → high shark population → overhunting → low fish → starvation → low shark → recovery → repeat. Complex spatiotemporal patterns emerge (clusters, waves).
- **Why Significant:** Demonstrates predator-prey oscillations and spatial structure from discrete local rules. Shows how simple hunger/reproduction thresholds produce realistic ecological cycles. Used in teaching and research on spatial dynamics.
- **Distinguishing CA Features:**
  - **State:** Cell type (empty, fish, shark)
  - **Neighborhood:** Moore (8 neighbors for movement)
  - **Grid Topology:** 2D square lattice, toroidal (periodic)
  - **Update Mode:** Sequential or pseudo-random (order matters; can model random sweep)
  - **Stochasticity:** Randomness in movement and reproduction direction
  - **Multi-species:** Two species (prey and predator)
  - **Energy/Age Tracking:** Each fish and shark has internal age/hunger counter
  - **Population Cycles:** Emergent oscillation of predator and prey numbers

### 4.3 Klausmeier Vegetation Model (Dryland Patterning)

- **Field:** Ecology / Earth Science
- **Originator(s) and Year:** Chris Klausmeier; 2002
- **Key Publication:** Klausmeier, C. A. (2002) "Desertification by grazing: a partial differential equation and its application," *Ecology Letters*, 5(4), 465–474. Also: Klausmeier, C. A. (1999) "Regular and irregular patterns in semiarid vegetation," *Science*, 284(5415), 1826–1828.
- **Description:** A reaction-advection-diffusion model of vegetation in sloped terrain. Variables: plant biomass *B*, soil water *W* (both continuous per cell). Water flows downslope; vegetation increases water infiltration (positive feedback). Rules: water advects downslope, plants consume water and grow, biomass spreads (diffusion-like). The interplay between water infiltration feedback and diffusion causes vegetation to self-organize into traveling bands aligned transverse to slope. In CA form: each cell updates *B* and *W* based on local state and neighbors.
- **Why Significant:** Explains banded vegetation patterns observed in drylands (Niger, Morocco, Sudan); validates Turing-like instability theory in ecology. Used to predict desertification and restoration strategies.
- **Distinguishing CA Features:**
  - **State:** Two real-valued fields (plant biomass *B*, soil water *W*)
  - **Neighborhood:** von Neumann or Moore (diffusion); directional (advection downslope)
  - **Grid Topology:** 2D lattice, oriented (landscape has slope direction)
  - **Update Mode:** Synchronous
  - **Anisotropy:** Advection directional (downslope)
  - **Feedback:** Positive feedback (*B* increases infiltration → more *W* uptake)
  - **Wave Phenomena:** Traveling stripes/bands emerge
  - **Boundary Conditions:** Slope boundary with outflow; potentially open upper boundary

### 4.4 Rietkerk Vegetation Pattern Model

- **Field:** Ecology / Earth Science
- **Originator(s) and Year:** Max Rietkerk; 2004 (original continuous; CA variant by Rietkerk et al.)
- **Key Publication:** Rietkerk, M., Boerlijst, M. C., van Langevelde, F., HilleRisLambers, R., van de Koppel, J., Kumar, L., Prins, H. H. & de Roos, A. M. (2002) "Self-organized patchiness and catastrophic shifts in ecosystems," *Science*, 305(5692), 1926–1929.
- **Description:** A spatially explicit model of savanna vegetation using a cellular automaton. States per cell: vegetation cover and soil water. Local rules implement: water infiltration (higher vegetation → better infiltration), vegetation growth (dependent on water), and grazing pressure (external parameter). The interplay between positive feedback (plants improve water, enabling more plants) and dispersal limitation creates patchy distributions. Patch-size distribution follows a power law, consistent with observations. Near critical transitions (grazing threshold), system becomes fragmented (early warning signal).
- **Why Significant:** Early example of cellular automata in ecosystem modeling; shows how scale-free patch distributions emerge from simple local rules. Used as early warning signal for ecosystem collapse (desertification).
- **Distinguishing CA Features:**
  - **State:** Vegetation cover (continuous 0–1) and soil water (continuous) per cell
  - **Neighborhood:** von Neumann or Moore
  - **Grid Topology:** 2D square lattice, periodic or open
  - **Update Mode:** Synchronous
  - **Positive Feedback:** Vegetation increases water; water increases vegetation
  - **Stochasticity:** Often deterministic; can add noise (grazing variability)
  - **Patch Dynamics:** Power-law patch-size distribution near criticality
  - **Bifurcations:** Transitions from homogeneous to patchy to desertified as grazing increases

### 4.5 SIR/SIS Epidemic Model (Spatial CA)

- **Field:** Epidemiology / Ecology
- **Originator(s) and Year:** Various authors (2000s–present); spatial extensions of classic SIR/SIS
- **Key Publication:** White, R., Engelen, G., & Uljee, I. (1997) "The use of constrained cellular automata for high-resolution modelling of urban land-use dynamics," *Environment and Planning B: Planning and Design*, 24(3), 323–343. Also: Riley, S. (2007) "Large-scale spatial-transmission models of infectious disease," *Science*, 316(5829), 1298–1301.
- **Description:** A 2D CA modeling disease spread. Each cell holds population counts: Susceptible (*S*), Infected (*I*), Recovered (*R*). Or SIS (no recovery, only Susceptible-Infected-Susceptible cycling). Local rules: within-cell transmission (increased *I* → more *S* become *I*), between-cell transmission (infected neighbors increase infection rate), recovery (*I* → *R*), loss of immunity (SIS only: *R* → *S*). Spatially, disease spreads via infected individuals moving to neighbors or long-range dispersal (stochastic). Global patterns: epidemic waves, spatial heterogeneity, endemicity pockets.
- **Why Significant:** Extends classic SIR to include spatial structure, which changes invasion speed and endemic levels. Realistic for human diseases (influenza, COVID-19) and wildlife diseases (rabies, plague). Guides spatial intervention strategies.
- **Distinguishing CA Features:**
  - **State:** Counts or fractions (*S*, *I*, *R*) per cell; can be discrete or continuous
  - **Neighborhood:** von Neumann or Moore (contact radius)
  - **Grid Topology:** 2D or 3D lattice
  - **Update Mode:** Synchronous
  - **Stochasticity:** Probabilistic transitions between compartments
  - **Multi-species:** Transmission network (host populations, vectors if relevant)
  - **Spatial Spread:** Local transmission + long-distance dispersal
  - **Parameters:** Infection rate *β*, recovery rate *γ*, basic reproduction number *R₀*

---

## 5. SOCIOLOGY & BEHAVIOURAL SCIENCE

Cellular automata provide intuitive discrete models of social interaction, opinion dynamics, and cultural evolution, where local opinion exchange drives global consensus or polarization.

### 5.1 Schelling Segregation Model

- **Field:** Sociology / Urban Planning
- **Originator(s) and Year:** Thomas C. Schelling; 1969–1971
- **Key Publication:** Schelling, T. C. (1969) "Models of segregation," *The American Economic Review*, 59(2), 488–493. Schelling, T. C. (1971) "Dynamic models of segregation," *Journal of Mathematical Sociology*, 1(2), 143–186.
- **Description:** A 2D lattice where each cell is empty or occupied by an agent of type A or B (e.g., two racial groups). Each agent has a tolerance threshold: if the fraction of similar neighbors falls below the threshold, the agent moves to a random empty location. Despite agents being tolerant (e.g., willing to live in 40% dissimilar neighborhoods), neighborhoods rapidly segregate—a classic example of how global patterns (segregation) emerge from local preference. Key insight: preference for diversity at micro level produces homogeneity at macro level.
- **Why Significant:** Foundational in agent-based modeling and complexity science. Explains observed segregation without invoking active discrimination. Widely applied in urban planning, real estate, and policy studies. Introduced quantitative approach to social dynamics.
- **Distinguishing CA Features:**
  - **State:** Agent type (A, B, or empty)
  - **Neighborhood:** Moore (8 neighbors, or variable)
  - **Grid Topology:** 2D square lattice
  - **Update Mode:** Sequential (agents move in random order)
  - **Stochasticity:** Random target selection for moving agents; can add noise to threshold
  - **Agent Memory:** None (greedy local decisions)
  - **Multi-group:** Extensible to 3+ groups
  - **Threshold Parameter:** Controls segregation rate; higher tolerance → slower segregation

### 5.2 Sakoda Checkerboard Model (Precursor)

- **Field:** Sociology / Social Interaction
- **Originator(s) and Year:** James M. Sakoda; 1971
- **Key Publication:** Sakoda, J. M. (1971) "The checkerboard model of social interaction," *Journal of Mathematical Sociology*, 1(1), 119–132.
- **Description:** A precursor to Schelling's model (developed independently). A checkerboard grid where checkers (agents) of two colors move based on attitudes toward neighbors: positive, neutral, or negative. Each agent's next position is determined by the predominant local attitude; agents move toward areas where neighbors are more favorable. Formally more general than Schelling, but required computer simulation (Schelling's model could be run manually on a checkerboard), limiting its uptake.
- **Why Significant:** Historically important as an early formal model of social interaction on a grid. Demonstrates simultaneous discovery (with Schelling); shows how computational feasibility affects scientific impact.
- **Distinguishing CA Features:**
  - **State:** Agent type and attitude toward neighbors
  - **Neighborhood:** Moore (8 neighbors)
  - **Grid Topology:** 2D square (checkerboard)
  - **Update Mode:** Asynchronous (agents move based on calculated preference)
  - **Attitudes:** Positive, neutral, negative toward each neighbor type
  - **Movement:** Greedy (move toward most favorable area)
  - **Multi-group:** Can model 2+ groups with varying affinities

### 5.3 Voter Model

- **Field:** Sociology / Opinion Dynamics
- **Originator(s) and Year:** Clifford Cogburn; 1975 (original voter model context); later developed by many
- **Key Publication:** Holley, R. A. & Liggett, T. M. (1975) "Ergodic theorems for weakly interacting infinite systems and the voter model," *Annals of Probability*, 3(4), 643–663.
- **Description:** A 1D or 2D lattice where each cell holds a binary opinion (0 or 1). At each step: pick a random cell and a random neighbor; the cell adopts the neighbor's opinion (copy-cat behavior). Simple but profound: despite this simple rule, the system exhibits coarsening (domains of same opinion grow over time) and eventually reaches consensus (all 0s or all 1s) in 1D or finite 2D systems. In infinite 2D, consensus takes infinite time (but dominance emerges).
- **Why Significant:** Tractable model of opinion consensus and polarization. Shows how consensus emerges from imitation without global coordination. Starting point for more complex opinion models (Sznajd, bounded confidence).
- **Distinguishing CA Features:**
  - **State:** Binary opinion per cell
  - **Neighborhood:** von Neumann or Moore
  - **Grid Topology:** 1D or 2D lattice
  - **Update Mode:** Asynchronous (pick random cell, copy from random neighbor)
  - **Stochasticity:** Essential (randomness in selection)
  - **Dynamics:** Coarsening (domain growth); consensus in finite systems
  - **Interaction:** Imitation only (no deliberation or contrarianism)
  - **Scaling:** Consensus time grows with system size

### 5.4 Sznajd Model (Opinion Dynamics)

- **Field:** Sociology / Econophysics / Opinion Formation
- **Originator(s) and Year:** Katarzyna Sznajd and Jozef Sznajd; 2000
- **Key Publication:** Sznajd, K. & Sznajd, J. (2000) "Opinion evolution in closed community," *International Journal of Modern Physics C*, 11(6), 1157–1165.
- **Description:** A binary-opinion CA based on social validation: if two adjacent agents (a "pair") share the same opinion, they convince all their neighbors to adopt that opinion ("United we stand, divided we fall"). If the pair disagrees, they cause disagreement among neighbors. Dynamics produce rapid polarization: opinion clusters grow explosively, boundary between clusters is unstable, and system reaches consensus or bistability quickly. Variants include contrarian agents (who reverse majority opinion) and continuous opinion versions.
- **Why Significant:** Shows how peer pressure and group confidence can accelerate consensus vs. polarization. More realistic than voter model for human opinion (peer pressure matters). Applied to elections, social media dynamics, and cultural trends.
- **Distinguishing CA Features:**
  - **State:** Binary opinion (0 or 1, or continuous in variants)
  - **Neighborhood:** Specific pair rule (two adjacent cells influence neighbors)
  - **Grid Topology:** 1D line or 2D lattice (variations exist)
  - **Update Mode:** Sequential or parallel (order matters)
  - **Social Validation:** Requires agreeing pair to propagate; disagreeing pair broadcasts discord
  - **Polarization:** Rapid; much faster than voter model
  - **Stochasticity:** Usually deterministic; stochasticity in perturbations adds realistic noise
  - **Attractors:** Consensus or polarized states (2–3 large domains)

### 5.5 Hegselmann–Krause Bounded Confidence Model

- **Field:** Sociology / Opinion Dynamics
- **Originator(s) and Year:** Rainer Hegselmann and Ulrich Krause; 2002
- **Key Publication:** Hegselmann, R. & Krause, U. (2002) "Opinion dynamics and bounded confidence: models, analysis and simulation," *Journal of Artificial Societies and Social Simulation*, 5(3), article 2.
- **Description:** Agents hold continuous opinions (e.g., 0–100 scale). At each timestep, each agent updates by averaging the opinions of neighbors whose opinion is within a "confidence bound" ε (e.g., within ±10 of their own). Agents disregard outliers. This simple homophily-based rule produces complex outcomes: consensus (all agents converge), polarization (stable distinct clusters), or fragmentation. Critical parameters: ε (confidence range), number of agents, initial distribution.
- **Why Significant:** Explains opinion fragmentation and persistent disagreement despite agents being willing to change and interact (unlike models assuming fixed opinions). Relevant to political polarization, misinformation spread, and consensus on scientific issues.
- **Distinguishing CA Features:**
  - **State:** Continuous opinion per agent (scalar, [0, 1] or similar)
  - **Neighborhood:** Defined by opinion distance, not spatial proximity (can map to spatial lattice, but optional)
  - **Grid Topology:** Can be regular lattice or fully connected (network)
  - **Update Mode:** Synchronous (all agents update based on current opinions)
  - **Threshold:** Confidence bound ε determines interaction; soft boundary (not step function)
  - **Stochasticity:** None (deterministic averaging)
  - **Dynamics:** Convergence to clusters separated by ≥2ε
  - **Parameters:** Confidence range ε; initial opinion distribution

### 5.6 Axelrod Cultural Dissemination Model

- **Field:** Sociology / Cultural Evolution
- **Originator(s) and Year:** Robert Axelrod; 1997
- **Key Publication:** Axelrod, R. (1997) "The dissemination of culture: A model with local convergence and global polarization," *Journal of Conflict Resolution*, 41(2), 203–226.
- **Description:** Agents on a 2D lattice each hold a cultural state represented as a vector of traits (e.g., 5 cultural dimensions, each with 10 possible values). Interaction rule: two agents interact (have conversation) only if they share at least one trait (homophily). When they interact, a randomly chosen differing trait on one agent adopts the other's variant (cultural diffusion). Over time, similar neighbors become more similar, but distant agents with no common traits never interact. Paradoxically, despite local convergence, global polarization emerges: the system settles into isolated cultural regions with no bridges between them.
- **Why Significant:** Explains cultural persistence and diversity despite forces for homogenization. Addresses Axelrod's question: "If culture is disseminating, why do cultural differences persist?" Shows how local convergence (→ homogeneity) and global polarization (→ diversity) can coexist due to disconnected clusters.
- **Distinguishing CA Features:**
  - **State:** Vector of cultural traits per agent (multi-feature, multi-variant)
  - **Neighborhood:** Moore (8 neighbors)
  - **Grid Topology:** 2D square lattice, toroidal
  - **Update Mode:** Sequential or asynchronous (random pair interaction)
  - **Interaction Condition:** Occurs only if agents share ≥1 trait (homophily gate)
  - **Stochasticity:** Random trait exchange among differing features
  - **Multi-feature:** Essential; single feature would lead to complete consensus
  - **Cultural Regions:** Stable clusters separated by barriers of zero interaction

### 5.7 Nowak–May Spatial Cooperation (Prisoner's Dilemma)

- **Field:** Sociology / Game Theory / Evolution
- **Originator(s) and Year:** Martin A. Nowak and Robert M. May; 1992
- **Key Publication:** Nowak, M. A. & May, R. M. (1992) "Evolutionary games and spatial chaos," *Nature*, 359, 826–829.
- **Description:** A 2D lattice where each cell holds one agent playing an iterated prisoner's dilemma (PD) against neighbors. Two strategies: cooperate (C) or defect (D). Payoff matrix: mutual cooperation rewards both; mutual defection costs both; defector beats cooperator (exploit). After a round of games, each agent's payoff determines reproduction: higher payoff → reproduce with higher probability, or neighbors copy successful strategies. Remarkably, spatial structure allows cooperation to persist even though defection dominates in well-mixed populations. Spatial domains of cooperators form and persist, creating a dynamic "rock-paper-scissors" pattern.
- **Why Significant:** Demonstrates that spatial structure facilitates cooperation (evolution of altruism). No punishing mechanism, tit-for-tat, or kinship needed; just local interaction. Explains cooperation in biological and social systems. Spawned vast literature on spatial evolutionary games.
- **Distinguishing CA Features:**
  - **State:** Strategy per agent (0=defect, 1=cooperate) and cumulative payoff
  - **Neighborhood:** Moore or von Neumann (play against all neighbors)
  - **Grid Topology:** 2D square lattice, toroidal
  - **Update Mode:** Synchronous games; then asynchronous strategy update (copy successful neighbor with probability ∝ payoff)
  - **Payoff Matrix:** PD parameters (reward, cost, temptation, sucker's payoff)
  - **Evolutionary Rule:** Replication proportional to fitness
  - **Pattern Dynamics:** Spatial domains compete; coexistence of C and D strategies
  - **Stochasticity:** Probabilistic reproduction and neighborhood selection

---

## 6. PUBLIC RESOURCES, URBAN & TRANSPORT

Cellular automata excel at modeling transportation networks, urban growth, and resource distribution due to their discrete nature and spatial locality.

### 6.1 Nagel–Schreckenberg Traffic Model

- **Field:** Transportation / Traffic Flow
- **Originator(s) and Year:** Kai Nagel and Michael Schreckenberg; 1992
- **Key Publication:** Nagel, K. & Schreckenberg, M. (1992) "A cellular automaton model for freeway traffic," *Journal of Physics I France*, 2(12), 2221–2229.
- **Description:** A 1D cellular automaton modeling a single-lane highway. Each cell is either empty or contains a car; cars have integer velocity (0 to *v*_max, typically 5). At each timestep: cars accelerate (v ← v+1 if possible), decelerate to avoid collision (if car ahead, v ← distance − 1), and then move forward by velocity. Stochasticity: with probability *p*, a car randomly slows (simulating distraction or braking). Despite simplicity, the model reproduces empirical traffic phenomena: free flow at low density, start-stop waves at high density, and a critical transition.
- **Why Significant:** First CA model of traffic; validated against real highway data. Shows phase transition from fluid to jammed flow. Widely studied; basis for urban traffic management research and optimization.
- **Distinguishing CA Features:**
  - **State:** Velocity per occupied cell (0 to *v*_max; integer)
  - **Neighborhood:** Ahead (asymmetric; cars look forward 1 cell)
  - **Grid Topology:** 1D line (can be 2D for multi-lane)
  - **Update Mode:** Synchronous (all cars move in parallel)
  - **Stochasticity:** Probabilistic random braking (parameter *p*)
  - **Asymmetry:** Directional (one-way traffic)
  - **Velocity Distribution:** Emergent from simple rules; realistic histograms
  - **Waves:** Start-stop waves propagate backward at high density

### 6.2 Biham–Middleton–Levine Traffic Model

- **Field:** Transportation / Traffic Flow / Self-Organization
- **Originator(s) and Year:** Ofer Biham, A. Alan Middleton, Dov Levine; 1992
- **Key Publication:** Biham, O., Middleton, A. A., & Levine, D. (1992) "Self-organization and a dynamical transition in traffic-flow models," *Physical Review A*, 46(10), R6124–R6127.
- **Description:** A 2D lattice representing an intersection grid. Two types of cars: red (move right) and blue (move down), moving only in their designated directions. At each step: red cars move right (if next cell is empty), then blue cars move down. System exhibits bistability and self-organization: at low density, flow is smooth; as density increases, traffic jams suddenly form (phase transition); further increases lead to intermediate states combining jammed and free-flowing regions. The transition is sharp and related to frustration (cars blocking each other).
- **Why Significant:** Simplest system exhibiting phase transitions and self-organization. Demonstrates critical phenomena in traffic; no explicit optimization, yet self-organized states emerge. Used to study traffic control and interventions.
- **Distinguishing CA Features:**
  - **State:** Car type (empty, red-car, blue-car)
  - **Neighborhood:** Moore (movement checks neighbors orthogonally)
  - **Grid Topology:** 2D square lattice, toroidal (periodic)
  - **Update Mode:** Sequential (red cars move first, then blue)
  - **Stochasticity:** Typically deterministic; randomness in initial conditions
  - **Asymmetry:** Two types with different movement directions
  - **Phase Transition:** Smooth flow → intermediate → jammed; first-order transition
  - **Self-Organization:** High-density jams form without explicit rule for congestion

### 6.3 Burstedde Pedestrian Dynamics (Social Force CA)

- **Field:** Urban Planning / Pedestrian Dynamics
- **Originator(s) and Year:** Christof Burstedde, Kai Klauck, Andreas Schadschneider, Johannes Zittartz; 2001
- **Key Publication:** Burstedde, C., Klauck, K., Schadschneider, A., & Zittartz, J. (2001) "Simulation of pedestrian dynamics using a two-dimensional cellular automaton," *Physica A*, 295(3–4), 507–525.
- **Description:** A 2D lattice CA for pedestrian crowds. Each cell is either empty or occupied by a pedestrian. Pedestrians update position stochastically (not deterministically) based on a "floor field": a continuous scalar field that diffuses and decays. Pedestrians move toward low-field cells (e.g., toward exit), creating non-local attraction. Field is also modified by pedestrian motion (increased value near pedestrians, like pheromone). Results: lane formation in counterflow, oscillatory door dynamics, crowd waves. Computationally efficient (≫ social force continuum models).
- **Why Significant:** Bridges discrete (CA) and continuum (field) approaches. Demonstrates collective phenomena (lanes, oscillations) from simple individual rules. Applicable to emergency evacuation, crowd management, and urban design.
- **Distinguishing CA Features:**
  - **State:** Occupancy (empty/pedestrian) per lattice cell; associated with continuous floor field *φ*
  - **Neighborhood:** von Neumann or Moore (for movement)
  - **Grid Topology:** 2D square lattice, open boundary (or target destination)
  - **Update Mode:** Asynchronous (random order pedestrian moves)
  - **Floor Field:** Diffusive, decaying continuous field; modified by agents
  - **Bias**: Movement probabilities depend on floor field gradient
  - **Stochasticity:** Probabilistic movement (not greedy)
  - **Phenomena:** Emergent lanes, oscillations at doors, pattern formation

### 6.4 SLEUTH Urban Growth Model

- **Field:** Urban Planning / Land-Use Change
- **Originator(s) and Year:** Keith C. Clarke; developed 1997–2000s
- **Key Publication:** Clarke, K. C., Hoppen, S., & Gaydos, L. (1997) "A self-modifying cellular automaton model of historical urbanization in the San Francisco Bay area," *Environment and Planning B*, 24(2), 247–261.
- **Description:** SLEUTH (Slope, Land use, Excluded, Urban extent, Transport, Hillshade) is a CA urban growth model. Inputs: six GIS layers. Core CA rule: a cell becomes urban based on: its own state (urban), number of urban neighbors (spreading), distance to roads (accessibility), slope (steepness discourages development), etc. Four "growth rules" compete stochastically: spontaneous (random urbanization), diffusive (clustering around existing urban), road-influenced (along roads), and edge growth (fill-in at urban frontier). A genetic algorithm tunes parameters to fit historical growth; then predict future. Applied to 100+ cities globally.
- **Why Significant:** Operationalizes CA for real-world urban planning. Demonstrates CA's value for land-use forecasting and scenario planning. Widely adopted in planning agencies.
- **Distinguishing CA Features:**
  - **State:** Land-use class per cell (urban, agricultural, etc.); binary simplification: urban/non-urban
  - **Neighborhood:** Moore neighborhood for spread rules; long-range for road influence
  - **Grid Topology:** 2D raster lattice (geographic grid, 30m–100m cells typical)
  - **Update Mode:** Stochastic; multiple competing rules
  - **Multi-layer Input:** Slope, roads, existing urban areas, excluded zones (all GIS layers)
  - **Calibration:** Genetic algorithm fits parameters to historical data
  - **Stochasticity:** Probabilistic cell transitions (proportional to potential)
  - **Forecasting:** Applied to predict urbanization over decades

---

## 7. EARTH SCIENCES, GEOLOGY & MINING

Cellular automata model geological processes (erosion, landslides, cave formation) and wildfire spread, where spatial propagation of physical disturbance occurs naturally.

### 7.1 Wildfire Spread (FARSITE-style CA)

- **Field:** Geoscience / Wildland Management
- **Originator(s) and Year:** Various (1990s–2000s); FARSITE (Fire Area Simulator) by Mark Finney (USDA); CA variants improve speed
- **Key Publication:** Finney, M. A. (1994) "Farsite: Fire Area Simulator," USDA Forest Service, Intermountain Research Station. Arca, B., Ghisu, T., & Casula, G. (2007) "A cellular automata model for fire spread simulation," in *Environmental Modelling & Software*.
- **Description:** A 2D CA on a landscape (DEM: digital elevation model). Each cell: fuel load (vegetation), temperature, moisture. Fire spreads from burning cells to neighbors based on: fuel amount, wind speed/direction, slope (uphill faster), and local temperature. Burn time is computed (fuel-dependent). CA variant: discrete time steps; check if neighbor is burning and cell is susceptible (temp high enough, fuel present), then cell ignites. Rate of spread depends on gradient and wind (anisotropic). Results predict fire perimeter, burn area, and growth over hours/days.
- **Why Significant:** Enables fast, spatially explicit fire prediction for management. CA is more computationally efficient than vector-based FARSITE while maintaining accuracy. Used operationally in fire agencies.
- **Distinguishing CA Features:**
  - **State:** Cell state (unburned, burning, burned) and internal state (fuel, moisture, temperature)
  - **Neighborhood:** Moore or von Neumann; directional bias (wind, slope)
  - **Grid Topology:** 2D raster, aligned with landscape DEM
  - **Update Mode:** Synchronous or asynchronous (stagger burning cells)
  - **Anisotropy:** Wind and slope create directional spread; uphill faster
  - **Continuous Data:** Fuel load, DEM, wind as continuous inputs
  - **Wave-Like Dynamics:** Fire front propagates; acceleration on slopes
  - **Boundary:** Open (fire exits domain or burns to edge)

### 7.2 Landslide/Avalanche CA Model

- **Field:** Geomorphology / Hazard Assessment
- **Originator(s) and Year:** Various (1990s–2000s); related to sandpile models
- **Key Publication:** Hanisch, J. (1998) "Simulation of debris flow hazards using a cellular automaton model," *GIS and Environmental Modelling*, Longley et al. eds.; Thoeni, K., Ries, J. B., & Schott, B. (2008) "Landslides and sediment flux responses to recent climate change," *Catena*, 71(1), 1–12.
- **Description:** A 2D lattice representing a terrain (slope). Each cell stores a "height" or sediment amount. Rules: if a cell exceeds a stability threshold (angle of repose), material topples to downslope neighbors (avalanche rule, similar to sandpile). Additional rules: earthquake or rainfall triggers instability (probabilistic); water infiltration weakens slopes. Propagation is avalanche-like: one cell failing can trigger neighbor failures. Results: realistic debris flow paths, fan deposition, and power-law avalanche-size distributions.
- **Why Significant:** Explains catastrophic slope failure and debris flows; shows self-organized criticality (power laws). Used in hazard mapping and early warning systems.
- **Distinguishing CA Features:**
  - **State:** Height or sediment amount per cell (continuous or integer)
  - **Neighborhood:** von Neumann or Moore (material flows downslope)
  - **Grid Topology:** 2D slope-aligned lattice (DEM-based)
  - **Update Mode:** Relaxation (iterate toppling until stable)
  - **Threshold Dynamics:** Angle of repose; exceeding triggers avalanche
  - **Directionality:** Material flows downslope (asymmetric)
  - **Stochasticity:** Triggering (rainfall, earthquake) probabilistic
  - **Cascade Behavior:** Single perturbation can trigger large avalanches

### 7.3 Erosion/Geomorphology CA

- **Field:** Geomorphology / Hydrology
- **Originator(s) and Year:** Various (2000s–present); extensions of sandpile and landscape evolution models
- **Key Publication:** Coulthard, T. J., Macklin, M. G., & Kirkby, M. J. (2002) "A cellular model of Holocene upland river basin and alluvial fan evolution," *Earth Surface Processes and Landforms*, 27(3), 269–288.
- **Description:** A 2D DEM-based CA modeling hillslope and river erosion. Each cell stores elevation and soil/rock type. Water flows downslope (gradient-driven). Rules: erosion proportional to water flux and slope; transport of sediment; deposition in low areas. Cells lower neighbors via erosion; sediment from upslope accumulates. Over time, valleys deepen, plateaus lower, and characteristic landscape forms (gullies, fans) emerge. Results match observed drainage patterns and topography.
- **Why Significant:** Efficient tool for long-term landscape simulation (millennia to millions of years). Shows emergence of drainage networks and valleys from local erosion rules. Applied to paleoclimate impact assessment and landscape archaeology.
- **Distinguishing CA Features:**
  - **State:** Elevation (continuous), sediment flux (continuous) per cell
  - **Neighborhood:** D8 (8-neighbor flow routing) or D4 (4-neighbor); asymmetric (downslope)
  - **Grid Topology:** 2D raster DEM
  - **Update Mode:** Synchronous or sequential (flow-based)
  - **Water Flux:** Computed from elevation gradient (multiple-flow direction or single-flow)
  - **Erosion/Deposition:** Rate-dependent on water flux and local slope
  - **Conservation:** Loosely (sediment is conserved locally, but leaves domain)
  - **Emergent Patterns:** Branching drainage networks form spontaneously

---

### 7.4 SCIARA Family — Lava Flow CA (SCIARA, SCIARA-γ2, SCIARA-fv3)

- **Field:** Earth Sciences / Volcanology
- **Originator(s) and Year:** G. M. Crisci, S. Di Gregorio, R. Rongo, W. Spataro, M. V. Avolio (Università della Calabria); 1999 first implementation, SCIARA-γ2 in 2006, SCIARA-fv3 in 2015+
- **Key Publication:** Crisci, G., Di Gregorio, S., Nicoletta, F., Rongo, R., & Spataro, W. (1999). "Analysing Lava Risk for the Etnean Area: Simulation by Cellular Automata Methods." *Natural Hazards*, 20, 215–229. Updated: Avolio, M. V. et al. (2006). "SCIARA-γ2: An Improved Cellular Automata Model for Lava Flows and Applications to the 2002 Etnean Crisis." *Computers & Geosciences*, 32(7), 876–889. Latest: Spataro, D. et al. (2015), "The New SCIARA-fv3 Numerical Model and Acceleration by GPGPU Strategies," *International Journal of High Performance Computing Applications*, 29(2), 137–152.
- **Description:** SCIARA simulates macroscopic lava flow on irregular topography via a continuous CA. The local transition function computes outflows from each cell to its neighbours based on topographic elevation, lava height and cell-to-cell potential differences, with empirical Bingham-like rheology. SCIARA-fv3 added improved cooling models and finite-volume discretisation. The model is calibrated to multiple Mt. Etna eruptions (1991, 2001, 2002, 2004, 2006), with operational use in hazard mapping and emergency response.
- **Significance:** Longest-validated and most-applied CA volcanology model; demonstrated real-time forecasting capability during active eruptions and is used for civil-defence planning in Italy. Established the macroscopic-CA paradigm for complex geophysical flows; >1000 citations across the family.
- **Distinguishing CA Features:**
  - Attributes: cell elevation, lava height, temperature (cooling), lava state
  - Neighborhood: Moore (8-neighbours) with elevation-dependent anisotropic weighting
  - Update mode: synchronous, deterministic
  - Topology: 2D irregular grid (DEM-driven)
  - Stochasticity: low (empirical friction parameters; some variants probabilistic)
  - Conservation laws: mass-conservative outflow distribution (ratios sum to 1 across neighbours)

### 7.5 MAGFLOW Lava Flow CA (Monte Carlo Variant)

- **Field:** Earth Sciences / Volcanology
- **Originator(s) and Year:** Developed for Mt. Etna simulations; ~2007–2010 main development period
- **Key Publication:** "Simulations of the 2004 Lava Flow at Etna Volcano Using the MAGFLOW Cellular Automata Model." *Bulletin of Volcanology*, Springer (2007); sensitivity-analysis follow-up in *Environmental Modelling & Software* (2012).
- **Description:** MAGFLOW uses a Monte Carlo anisotropic algorithm to compute lava flow paths on complex topography. Lava is distributed from a source cell to neighbouring cells based on slope and physical constraints. Designed for near-real-time emergency forecasting; calibrated and tested on the 2004 Mt. Etna eruption with published validation metrics.
- **Significance:** Competing approach to SCIARA with focus on operational emergency-response speed; reproduces observed lava advance timing during the 2006 Etna eruption. Demonstrates CA versatility for volcanology (non-Bingham variants).
- **Distinguishing CA Features:**
  - Attributes: lava height, cell temperature, outflow potential
  - Neighborhood: weighted Moore neighbourhood (anisotropic, slope-dependent)
  - Update mode: synchronous; stochastic Monte Carlo distribution
  - Topology: 2D regular grid on topographic DEM
  - Stochasticity: yes — Monte Carlo anisotropic distribution
  - Conservation laws: mass conservation

### 7.6 PYR / PYR2 Pyroclastic Flow CA

- **Field:** Earth Sciences / Volcanology
- **Originator(s) and Year:** Crisci / Spataro / Rongo group (Università della Calabria); 1990s–2000s. Applications: Mt. Pinatubo 1991, Soufrière Hills 1996.
- **Key Publication:** Group publications in *Journal of Volcanology and Geothermal Research*, *Natural Hazards* and *Computers & Geosciences*; PYR2 is part of the same SCIARA / SCIDDICA family.
- **Description:** PYR2 extends the empirical CA methodology to simulate pyroclastic flows (faster, more lethal than lava). Uses energy dissipation and cell-transition rules mimicking mass redistribution on topography; successfully applied to historical eruptions for hazard assessment and pathway reconstruction.
- **Significance:** Extends the CA paradigm beyond lava to pyroclastic flow — a critical hazard type — and demonstrates that the same empirical macroscopic CA strategy generalises to high-velocity, high-momentum flows. Validated on destructive historical events.
- **Distinguishing CA Features:**
  - Attributes: mass height, velocity component, temperature / energy state
  - Neighborhood: Moore with elevation weighting (anisotropic)
  - Update mode: synchronous
  - Topology: 2D grid on topographic surface
  - Stochasticity: low (empirical friction-like parameters)
  - Conservation laws: mass conservation in outflow distribution

### 7.7 SCIDDICA Debris Flow & Landslide CA (S₃-hex Variant)

- **Field:** Earth Sciences / Geomorphology (debris flow, fast-moving landslides)
- **Originator(s) and Year:** D. D'Ambrosio, S. Di Gregorio, R. Rongo, W. Spataro, G. A. Trunfio; 1990s–2010s evolution
- **Key Publication:** D'Ambrosio, D., Di Gregorio, S., Rongo, R., Spataro, W., & Trunfio, G. A. (2000). "First Simulations of the Sarno Debris Flows Through Cellular Automata Modelling." *Geomorphology*, 33(3–4), 137–159. Also: D'Ambrosio et al. (2012), "SCIDDICA-SS3: A New Version of Cellular Automata Model for Simulating Fast Moving Landslides." *Journal of Supercomputing*, 65(2), 682–696.
- **Description:** SCIDDICA models debris flow and fast-moving landslides by simulating mass redistribution on irregular topography. Each cell computes outflows of debris material to neighbouring cells based on gravitational potential, friction and mass balance. Designed for granular, cohesionless flows (saturated / unsaturated debris). The hexagonal variant (S₃-hex) explicitly addresses directional bias of square lattices. Validated on historical events (1997 Lake Albano, Sarno debris flows in Italy). Accounts for material entrainment and deposition.
- **Significance:** Extends the macroscopic-CA flow paradigm from lava and pyroclastic to debris flows; demonstrates that empirical CA local rules generalise across very different flow regimes (high-solid-fraction granular flows). Used operationally for landslide hazard mapping in Europe; the hexagonal variant is technically noteworthy for addressing lattice anisotropy.
- **Distinguishing CA Features:**
  - Attributes: debris height / volume, material composition (optional), velocity / momentum (in some variants)
  - Neighborhood: Moore (square) or hexagonal (6 neighbours)
  - Update mode: synchronous
  - Topology: 2D irregular grid; optionally hexagonal lattice (S₃-hex)
  - Stochasticity: deterministic (empirical friction and outflow rules)
  - Conservation laws: mass conservation in outflows

### 7.8 CATS — Cellular Automata for Turbidite Systems

- **Field:** Earth Sciences / Sedimentology, Basin Analysis
- **Originator(s) and Year:** Various authors; CATS specifically developed ~2010s for reservoir-scale turbidite simulation
- **Key Publication:** "CATS — A Process-Based Model for Turbulent Turbidite Systems at the Reservoir Scale." *Marine and Petroleum Geology* (2016). Also: simulations of the 1999 Capbreton Canyon turbidity current with a CA model (2012).
- **Description:** CATS simulates turbidity-current flow and sedimentation in submarine channels and fans using a CA approach. Each cell computes water entrainment from ambient, particle settling, bed erosion and suspended-load redistribution to neighbouring downslope cells. Multi-grain-size capability (sand / silt / clay fractionation). Reproduces realistic deposition patterns: proximal sands, distal fines, channel-levee architectures. Validated against modern and ancient turbidite systems.
- **Significance:** Extends CA to Earth-surface processes (sedimentation, geomorphology). Valuable for petroleum reservoir prediction (net-sand maps, fluid-flow simulation preparation). Process-based (not statistical) approach to facies prediction; used in industry for resource assessment in deep-water basins.
- **Distinguishing CA Features:**
  - Attributes: water height, suspended-sediment concentration per grain size, bed thickness, bed composition
  - Neighborhood: downslope-weighted Moore neighbourhood (anisotropic flow direction)
  - Update mode: synchronous or quasi-steady (flow-dominated)
  - Topology: 2D / 3D grid on bathymetric surface
  - Stochasticity: optional stochastic sediment partition in settling / deposition
  - Conservation laws: mass conservation (sediment + water)

### 7.9 Aeolian Dune Migration CA (DuBeVeg and Variants)

- **Field:** Earth Sciences / Geomorphology, Aeolian Sedimentology
- **Originator(s) and Year:** A. C. W. Baas and others; 2000s–2010s
- **Key Publication:** Baas, A. C. W. (2002). "Chaos, Self-Organization, and Determinism in Geomorphology." *Geomorphology*, 49(3), 213–241. Also: "Investigating Parabolic and Nebkha Dune Formation Using a Cellular Automaton Modelling Approach." *Earth Surface Processes and Landforms* (2006). Recent biogeomorphic variant: DuBeVeg in *Journal of Marine Science and Engineering* (2022).
- **Description:** CA simulates dune-field evolution by modelling sand transport (saltation, creep) and deposition under wind. Each cell's state holds sand height; transition rules approximate wind shear stress → sand mobility and lee-side shadow zones → deposition. Vegetated variants (DuBeVeg) couple vegetation-colonisation rules (vegetation stabilises sand, reducing mobility). Reproduces realistic dune-field patterns: barchan chains, parabolic dunes, vegetated hummocks.
- **Significance:** Demonstrates CA for slow landscape evolution; valuable for predicting coastal erosion / accretion, desert migration hazards and palaeo-dune reconstruction. The vegetation-coupled variant highlights CA's strength for multi-component interactive systems.
- **Distinguishing CA Features:**
  - Attributes: sand height, vegetation cover (optional), grain-size distribution
  - Neighborhood: wind-directional, anisotropic (upwind / downwind cells weighted)
  - Update mode: synchronous or sequential (explicit wind-driven redistribution)
  - Topology: 2D regular grid (plan view)
  - Stochasticity: wind direction / speed randomness (imposed or implicit)
  - Conservation laws: sand mass conservation

### 7.10 Olami–Feder–Christensen (OFC) Earthquake CA

- **Field:** Earth Sciences / Geophysics, Seismicity
- **Originator(s) and Year:** Z. Olami, H. J. S. Feder, K. Christensen; 1992
- **Key Publication:** Olami, Z., Feder, H. J. S., & Christensen, K. (1992). "Self-Organized Criticality in a Continuous, Nonconservative Cellular Automaton Modeling Earthquakes." *Physical Review Letters*, 68(8), 1244–1247. DOI: 10.1103/PhysRevLett.68.1244.
- **Description:** OFC is a CA version of the Burridge–Knopoff spring-block earthquake model. A 2D grid of blocks connected elastically represents a fault. Stress accumulates quasi-statically (external loading); when local stress exceeds friction, blocks slip instantaneously, triggering cascades of stress redistribution. The model exhibits self-organized criticality (SOC), producing power-law earthquake-magnitude distributions (Gutenberg–Richter law) from simple deterministic rules with no tuned criticality parameter. Variants: conservative vs. non-conservative stress transfer; 1D / 2D / 3D lattices; continuous deformation.
- **Significance:** Paradigm-establishing model demonstrating that SOC and realistic seismic statistics emerge naturally from CA rules. Reproduces Gutenberg–Richter, Omori–Utsu and Bath's laws. Foundational for SOC theory in geophysics; widely cited (1000s of citations); widely used to test earthquake-forecasting hypotheses and understand fault-network dynamics.
- **Distinguishing CA Features:**
  - Attributes: block stress, friction threshold, displacement
  - Neighborhood: von Neumann or Moore (nearest-neighbour stress transfer)
  - Update mode: quasi-static loading + synchronous avalanche slip events
  - Topology: 2D or 3D square / cubic lattice
  - Stochasticity: fully deterministic; randomness emerges from non-linear dynamics
  - Conservation laws: energy dissipation (non-conservative stress transfer in canonical variant)

### 7.11 Discontinuous CA Method (DCAM) / CASRock — Rock Fracture Propagation

- **Field:** Earth Sciences / Rock Mechanics, Geotechnical Engineering
- **Originator(s) and Year:** Development 2000s–2020s. Notable: Yan, Pan, Lisjak and colleagues (continuum–discontinuum CA coupling).
- **Key Publication:** Yan, C., Zheng, H., & Jia, G. (2016). "A Discontinuous Cellular Automaton Method for Modeling Rock Fracture Propagation and Coalescence Under Fluid Pressurization Without Remeshing." *Rock Mechanics and Rock Engineering*, 49(6), 2539–2555.
- **Description:** Discontinuous CA methods model brittle rock failure by discretising a rock mass into elasto-plastic cellular elements. Fractures propagate by activating element boundaries; the level-set method tracks crack location, eliminating remeshing. Microfractures initiate at stress concentrations and coalesce into macroscopic fractures following Coulomb / tensile failure criteria. Hydraulic-fracturing variants couple fluid-pressure evolution into the CA stress-transfer scheme.
- **Significance:** Demonstrates CA utility for quasi-brittle mechanics; overcomes remeshing limitations of FEM for fracturing. Successfully simulates realistic microcrack-coalescence patterns and predicts onset of macroscopic failure. Industrial applications include mine design (pillar stability, cave-back prediction) and hydraulic-fracture propagation; CASRock is commercial geotechnical software.
- **Distinguishing CA Features:**
  - Attributes: stress tensor per cell, damage / failure state per bond
  - Neighborhood: cell-to-cell stress transfer via elastic spring-stiffness network
  - Update mode: quasi-static load stepping → dynamic rupture avalanche
  - Topology: 3D network of cells with fracture-interface bonds (level-set tracked)
  - Stochasticity: heterogeneous strength can be stochastic; otherwise deterministic
  - Conservation laws: mechanical equilibrium

### 7.12 Lattice Boltzmann Method for Subsurface Flow & CO₂ Sequestration

- **Field:** Earth Sciences / Hydrogeology, Petroleum Reservoir Engineering, Carbon Storage
- **Originator(s) and Year:** Method developed 1980s–1990s (Frisch–Hasslacher–Pomeau, McNamara & Zanetti, Benzi–Succi–Vergassola); applications to reservoir rocks and fractured media: 2000s–present
- **Key Publication:** Succi, S. (2001). *The Lattice Boltzmann Equation for Fluid Dynamics and Beyond*, Oxford University Press. Reviews: Chen & Doolen (1998), *Annual Review of Fluid Mechanics*, 30, 329–364. Subsurface applications: Eker & Akin (2006), "Lattice Boltzmann Simulation of Fluid Flow in Synthetic Fractures," *Transport in Porous Media*, 65(3), 363–384; Pan, Hilpert & Law (2004), "Lattice-Boltzmann Simulation of Two-Phase Flow in Porous Media," *Water Resources Research*, 40(1), W01501.
- **Description:** LBM is a mesoscale simulation method that treats fluid flow on a discrete lattice. Particles move to nearest-neighbour lattice sites, collide (evolving velocity distributions) and relax toward equilibrium. Derived from lattice-gas CA but with continuous velocity distributions, eliminating discretisation artefacts. Applied to two-phase CO₂–brine flow in reservoir rocks, single-phase flow in fractures and CO₂ sequestration in porous media; can operate directly on digitised rock microstructure images from CT scans. Intrinsically parallel; captures interface tension, wetting and capillarity via collision operators.
- **Significance:** Industry-standard for pore-scale reservoir simulation. Mature CA variant for geophysics / engineering; enables direct micro-scale → macroscopic property upscaling (permeability, capillary-pressure curves). Widely adopted in petroleum engineering, groundwater modelling and geologic CO₂ storage design; GPU acceleration enables large simulations.
- **Distinguishing CA Features:**
  - Attributes: per-velocity distribution functions f_i (vector cell state — 9 floats in D2Q9, 19 in D3Q19)
  - Neighborhood: nearest lattice neighbours (D2Q9, D3Q19, D3Q27)
  - Update mode: synchronous streaming + collision (two sub-steps within each generation)
  - Topology: 2D / 3D regular cubic lattice
  - Stochasticity: deterministic (collision is a deterministic relaxation operator)
  - Multi-component: two-phase flows tracked via separate distribution functions or colour-gradient method
  - Conservation laws: mass and momentum conservation built into the lattice structure

### 7.13 CO₂ Hydrate Growth & Sequestration CA

- **Field:** Earth Sciences / Subsurface Flow, Carbon Storage, Geochemistry
- **Originator(s) and Year:** 2010s–2020s applications (CO₂ sequestration is a recent focus)
- **Key Publication:** "Stochastic Cellular Automata Modeling of CO₂ Hydrate Growth and Morphology." *ACS Publications* (2023). Related: "Multiblock Pore-Scale Modeling and Upscaling of Reactive Transport: Application to Carbon Sequestration." *Transport in Porous Media* (2012).
- **Description:** CA models simulate CO₂ migration and hydrate formation in subsurface saline aquifers or depleted oil fields. Cell transitions capture: (i) two-phase CO₂–brine flow through pore space, (ii) CO₂ dissolution and hydrate crystallisation, (iii) capillary trapping and residual saturation. Stochastic variants model heterogeneous permeability and pore-throat distributions. Tracks plume geometry over geological timescales (100s–1000s of years).
- **Significance:** Emerging area critical for climate-change mitigation. CA provides a fast, parallelisable alternative to continuum simulation for long-term CO₂ sequestration assessment; enables uncertainty quantification via ensemble CA runs; relevant to regulatory frameworks (EPA underground injection control, IPCC carbon-storage guidelines).
- **Distinguishing CA Features:**
  - Attributes: CO₂ saturation, brine saturation, pressure, temperature (if thermal), hydrate state
  - Neighborhood: lattice neighbour flow connections (varies by lattice type)
  - Update mode: synchronous or sequential (staggered for multiphase)
  - Topology: 3D porous-medium lattice (discretised from permeability fields)
  - Stochasticity: stochastic permeability heterogeneity, hydrate-nucleation kinetics
  - Conservation laws: mass (CO₂ + brine), energy (if thermal), phase equilibrium

### 7.14 Dendritic Crystal Growth CA (Hydrothermal Vein Textures)

- **Field:** Earth Sciences / Geochemistry, Mineralogy (also materials-science crossover)
- **Originator(s) and Year:** 2000s–2010s; foundational crystal-growth CA work by Zhao, Billings, et al.
- **Key Publication:** Zhao, X., & Billings, S. A. (2006). "Cellular Automata Modelling of Dendritic Crystal Growth Based on Moore and von Neumann Neighbourhoods." *Journal of Crystal Growth*, 293(1), 10–26.
- **Description:** CA models simulate slow dendritic (branching) crystal growth in cooling melts or hydrothermal solutions. Each cell represents a lattice site; cell state indicates crystal phase or liquid. Diffusion of heat / solute is approximated on the CA lattice. Nucleation occurs stochastically; growth propagates outward where local conditions (temperature, supersaturation) permit. Moore vs. von Neumann neighbourhood choice strongly affects anisotropy and branching patterns.
- **Significance:** Links CA to ore mineralogy; relevant for understanding hydrothermal vein textures and crystal habits in ore deposits. Demonstrates CA can model crystal-scale geochemistry (less industrial than flow-based models, but theoretically influential for pattern-formation physics in minerals).
- **Distinguishing CA Features:**
  - Attributes: phase state (liquid / crystal), temperature / concentration per cell
  - Neighborhood: Moore (8 in 2D) or von Neumann (4 in 2D) — the choice directly controls dendritic aspect ratio
  - Update mode: synchronous
  - Topology: 2D / 3D crystal lattice
  - Stochasticity: stochastic nucleation; deterministic diffusion approximation
  - Conservation laws: energy balance, solute balance (implicit in diffusion operator)

### 7.15 Mining-Specific CA — Status Note

Mining-specific CA modelling (block-caving granular flow, sublevel-caving draw control, ore-body discretisation for mine planning, dilution prediction) is **largely absent from the canonical peer-reviewed CA literature**. The CAVESIM model and coupled FLAC3D–CA approaches exist but are primarily industrial software / grey literature with limited validation papers. Likewise, banded-iron-formation replacement and hydrothermal vein / ore-genesis CAs are under-represented despite the geology being well studied.

This is a genuine open opportunity — both for novel CA research and as a domain GenesisCA could distinguish itself in if coupled to real mine data. The closest established CA work is granular-flow / debris-flow models (SCIDDICA family) and rock-fracture CAs (DCAM / CASRock) that share key kinematics with cave-back propagation and ore-pass flow.

## 8. COMPUTER SCIENCE & THEORY

Cellular automata are computationally universal; specific CA rules have been shown capable of universal computation or intricate behaviors with minimal rules.

### 8.1 Elementary Cellular Automaton Rule 30

- **Field:** Computer Science / Theory / Cryptography
- **Originator(s) and Year:** Stephen Wolfram; 1983
- **Key Publication:** Wolfram, S. (1983) "Statistical mechanics of cellular automata," *Reviews of Modern Physics*, 55(3), 601–644.
- **Description:** A 1D CA with 3 neighbors (left, self, right) and 2 states (0/1). Rule 30 maps the 8 possible 3-cell patterns to new states via a specific lookup table (binary 00011110 = 30 in decimal). From any initial condition, Rule 30 generates seemingly random, chaotic sequences. The center column (state of the middle cell over time) appears truly pseudorandom and passes standard randomness tests. Wolfram proposed Rule 30 as a pseudorandom number generator for Mathematica.
- **Why Significant:** Canonical example of chaos in a simple system; demonstrates that randomness can emerge deterministically. Despite cryptographic vulnerabilities discovered later, Rule 30 remains pedagogically important. Illustrates Wolfram's CA classification.
- **Distinguishing CA Features:**
  - **State:** Binary (0 or 1)
  - **Neighborhood:** Totalistic, size 3 (left, center, right)
  - **Grid Topology:** 1D line, typically infinite (or very large, open boundary)
  - **Update Mode:** Synchronous
  - **Stochasticity:** None (fully deterministic)
  - **Rule Representation:** Single byte (8 bits, one per possible configuration)
  - **Output:** Chaotic sequence; unpredictable appearance despite determinism
  - **Cryptographic Note:** Vulnerable to Meier-Staffelbach attack; not suitable for real cryptography

### 8.2 Elementary Cellular Automaton Rule 110

- **Field:** Computer Science / Theory / Computation
- **Originator(s) and Year:** Stephen Wolfram; 1983 (identified); Matthew Cook (1990s, universality proof)
- **Key Publication:** Wolfram, S. (1986) "Cellular automata as models of complexity," *Nature*, 311, 419–424. Cook, M. (2004) "Universality in Elementary Cellular Automata," *Complex Systems*, 15(1), 1–40.
- **Description:** A 1D binary CA (like Rule 30) but with rule number 110 (binary 01101110). Rule 110 exhibits "Class 4" behavior: neither fully chaotic nor fully stable, but intricate structures. Localized particles (solitons) can be created, annihilated, and collided, computing with them. Matthew Cook proved that Rule 110 is Turing-complete: by constructing cyclic tag systems as soliton collisions, Rule 110 can perform arbitrary computation.
- **Why Significant:** Simplest known universal Turing machine in 1D. Demonstrates that computational universality can emerge from minimal rules. Supports Wolfram's hypothesis about Class 4 CAs and computation.
- **Distinguishing CA Features:**
  - **State:** Binary
  - **Neighborhood:** Totalistic, size 3
  - **Grid Topology:** 1D line
  - **Update Mode:** Synchronous
  - **Stochasticity:** None
  - **Computational Power:** Turing-complete (proven)
  - **Particle-Like Structures:** Solitons and defects can be harnessed for logic
  - **Proof Technique:** Cyclic tag system simulation via collision dynamics

### 8.3 Langton's Ant

- **Field:** Computer Science / Artificial Life / Computation
- **Originator(s) and Year:** Chris Langton; 1986
- **Key Publication:** Langton, C. G. (1986) "Studying artificial life with cellular automata," *Physica D*, 22(1–3), 120–149.
- **Description:** A 2D grid of cells, each colored black or white. An ant (point mass) occupies one cell and follows rules: if on white, turn right 90°, flip cell to black, move forward one cell; if on black, turn left 90°, flip cell to white, move forward one cell. Starting on a white grid, the ant initially creates simple patterns (symmetric, small), then chaotic motion (≈10k steps), then surprisingly settles into a repetitive "highway"—a recurrent pattern that repeats every 104 steps. This highway propagates indefinitely in one direction.
- **Why Significant:** Demonstrates emergence of order from random initial conditions in a deterministic system. Shows artificial life potential; the ant exhibits "life-like" behavior (exploration, construction) despite trivial rules. Proven to be Turing-complete.
- **Distinguishing CA Features:**
  - **State:** Cell color (binary) plus ant position and orientation (global state)
  - **Neighborhood:** Central cell (ant's current location)
  - **Grid Topology:** 2D infinite lattice (usually simulated as large finite)
  - **Update Mode:** Sequential (ant moves one step per timestep)
  - **Stochasticity:** None (fully deterministic)
  - **Computation:** Turing-complete (via circuit construction)
  - **Emergent Behavior:** Highway pattern; never repeats (until highway) for ≥10k steps
  - **Universality:** Supports arbitrary Turing machine via trajectory manipulation

### 8.4 Langton's Loops (Self-Replicating CA)

- **Field:** Computer Science / Artificial Life / Self-Replication
- **Originator(s) and Year:** Chris Langton; 1984
- **Key Publication:** Langton, C. G. (1984) "Self-reproduction in automata networks," *Physica D*, 10(1–2), 135–144.
- **Description:** A simplified self-replicating automaton based on von Neumann's universal constructor but vastly smaller. A "loop" (closed path of cells) carries genetic information and machinery. The loop processes its instruction tape and can: replicate (build a new loop alongside), mutate (slightly alter the genetic sequence), and move. Starting from a single loop, population grows—loops duplicate. Mutations allow evolutionary exploration. The system is smaller than Codd's CA but loses full universal computation capability.
- **Why Significant:** Demonstrates minimal self-replication; inspired research in artificial life and evolutionary CA. More tractable for simulation and study than von Neumann's original.
- **Distinguishing CA Features:**
  - **State:** Integer (0–7 or similar; encodes cell type)
  - **Neighborhood:** von Neumann (4 orthogonal neighbors)
  - **Grid Topology:** 2D square lattice
  - **Update Mode:** Synchronous
  - **Self-Replication:** Loops use local rules to replicate within the lattice
  - **Genetic Information:** Instruction tape carried within loop structure
  - **Evolution:** Mutations occur; successful variants spread
  - **Size:** ~20–100 cells per loop (vs. millions for von Neumann)

### 8.5 Wireworld

- **Field:** Computer Science / Logic Circuit Simulation
- **Originator(s) and Year:** Brian Silverman; 1987
- **Key Publication:** Silverman, B. (1987) "Wireworld," *Computer Recreations, Scientific American* (later publication).
- **Description:** A 4-state CA (empty, electron-head, electron-tail, conductor). Rules: electron-head → electron-tail, electron-tail → conductor, conductor → electron-head if ≥1 neighbor is electron-head. Unlike Game of Life (where patterns interact via count), Wireworld explicitly models electron flow along conductor paths. By arranging conductors into patterns, one can build logic gates (AND, OR, XOR), wires, clocks, and diodes. The state propagates along conductor "wires" like actual electrons in circuits.
- **Why Significant:** Explicitly designed for circuit simulation; Turing-complete. Intuitive for engineering; demonstrates how discrete CA can faithfully model physical computation.
- **Distinguishing CA Features:**
  - **State:** 4-state (0=empty, 1=head, 2=tail, 3=conductor)
  - **Neighborhood:** Moore
  - **Grid Topology:** 2D square lattice
  - **Update Mode:** Synchronous
  - **Stochasticity:** None
  - **Logic Gates:** AND, OR, XOR, NOT easily constructed
  - **Circuit Topology:** Wires, diodes, clocks, memory elements possible
  - **Universality:** Turing-complete (proven by demonstration of universal gates)

### 8.6 Von Neumann Universal Constructor

- **Field:** Computer Science / Theory / Self-Replication
- **Originator(s) and Year:** John von Neumann; 1949–1951 (design, posthumously detailed)
- **Key Publication:** Von Neumann, J. (1966) *Theory of Self-Reproducing Automata*, edited by A. W. Burks, University of Illinois Press. (Earlier: von Neumann lectures, 1949.)
- **Description:** A self-replicating machine in a 29-state 2D cellular automaton. The machine consists of three components: a "description" (genetic tape), a universal constructor that reads the tape and builds the machine described therein, and a universal copier that duplicates the description. By copying its own description and passing it to a newly constructed copy, the machine replicates. Mutations are possible (tape errors), allowing evolution. The construction requires ~45 million cells and estimated >10¹⁸ time steps to replicate.
- **Why Significant:** Foundational work on self-reproduction in machines; addressed the question "Can machines reproduce?" Inspired all later work in artificial life. Demonstrated that self-replication and evolution could arise from local CA rules. Computationally universal.
- **Distinguishing CA Features:**
  - **State:** 29 discrete states per cell
  - **Neighborhood:** von Neumann (4 orthogonal)
  - **Grid Topology:** 2D square lattice
  - **Update Mode:** Synchronous
  - **Universality:** Turing-complete; universal constructor
  - **Self-Replication:** Tapes can self-replicate with fidelity and mutations
  - **Complexity:** Enormous; smallest working construction not found until decades later
  - **Biological Analogy:** Separates description (DNA) from construction machinery

### 8.7 Codd's Cellular Automaton (Self-Reproducing, 8-State)

- **Field:** Computer Science / Self-Replication / Computation
- **Originator(s) and Year:** Edgar F. Codd; 1968
- **Key Publication:** Codd, E. F. (1968) *Cellular Automata*, Academic Press.
- **Description:** Codd simplified von Neumann's 29-state CA to 8 states by using Wang's W-machine as a basis. Codd designed a self-replicating computer: a data structure that reads its own code tape and constructs a copy. The CA size is smaller than von Neumann's (though still millions of cells) but computational universality is preserved. The design was theoretically sound but never fully implemented due to size and complexity.
- **Why Significant:** Shows that von Neumann's complexity could be reduced while maintaining universality. Bridged abstract automata theory and practical computation.
- **Distinguishing CA Features:**
  - **State:** 8 states (vs. 29 for von Neumann)
  - **Neighborhood:** von Neumann
  - **Grid Topology:** 2D square lattice
  - **Update Mode:** Synchronous
  - **Universality:** Turing-complete; universal constructor
  - **Self-Replication:** Yes; still requires >10¹⁸ time steps (estimated)
  - **Reduction:** Simpler than von Neumann; still impractical to simulate

### 8.8 Banks' Cellular Automaton (Universal Constructor)

- **Field:** Computer Science / Universal Computation
- **Originator(s) and Year:** Edwin Roger Banks; 1971
- **Key Publication:** Banks, E. R. (1971) *Information Processing and Transmission in Cellular Automata*, MIT PhD thesis.
- **Description:** Banks developed 2-state cellular automata capable of universal computation (universal constructor). Using specialized rules and large configurations, Banks showed that the minimum complexity for a universal constructor is achievable with 2 states and von Neumann neighborhood. The construction is enormous but theoretically minimal in state count.
- **Why Significant:** Demonstrates that universality requires minimal state alphabet (2-state). Theoretical lower bound on CA universality. Raised question of practical implementability.
- **Distinguishing CA Features:**
  - **State:** Binary (0/1)
  - **Neighborhood:** von Neumann
  - **Grid Topology:** 2D square lattice
  - **Update Mode:** Synchronous
  - **Universality:** Turing-complete; universal constructor possible
  - **Minimality:** 2-state is minimal for known universal construction
  - **Size:** Largest configurations; impractical to simulate

### 8.9 Brian's Brain

- **Field:** Computer Science / Recreation / Pattern Formation
- **Originator(s) and Year:** Brian Silverman; (sometime in 1970s–1980s; popularized via Rudy Rucker)
- **Key Publication:** Often found in recreational CA collections; no single canonical paper. Described in books on CA (e.g., Rudy Rucker works).
- **Description:** A 3-state CA: off (0), on (1), dying (2). Rules: off → on if exactly 2 on neighbors; on → dying (always); dying → off (always). Cells cannot re-fire immediately (refractory period = 1 step enforced by dying state). Starting from random initial conditions, Brian's Brain generates intricate wave-like patterns: propagating fronts, spirals, and oscillating structures. Unlike Game of Life, patterns are less stable but more dynamic and interconnected (fewer "still lifes").
- **Why Significant:** Shows that 3 states suffice for complex behavior; ternary states are natural for excitable media. Used in recreational mathematics and art. Illustrates different complexity regime from Game of Life.
- **Distinguishing CA Features:**
  - **State:** Ternary (0=off, 1=on, 2=dying/refractory)
  - **Neighborhood:** Moore
  - **Grid Topology:** 2D square lattice
  - **Update Mode:** Synchronous
  - **Stochasticity:** None (deterministic)
  - **Excitable Dynamics:** Refractory period prevents self-sustaining loops
  - **Patterns:** Waves, spirals, chaotic turbulence
  - **Stability:** Less stable than Game of Life; continuous activity

---

## 9. CRYPTOGRAPHY & INFORMATION SECURITY

Cellular automata have been explored as pseudorandom number generators and stream ciphers, though most practical proposals have been cryptanalyzed.

### 9.1 Rule 30 as PRNG

- **Field:** Cryptography / Pseudorandom Number Generation
- **Originator(s) and Year:** Stephen Wolfram; 1985–1990s
- **Key Publication:** Wolfram, S. (1985) "Cryptography and cellular automata," *Proceedings of Advances in Cryptology—CRYPTO '85*, Springer-Verlag, pp. 429–432.
- **Description:** Wolfram proposed using the center column of Rule 30 (1D CA, binary state) as a pseudorandom number generator. The rule is simple and deterministic; starting from a random seed, the evolution of the center cell produces a bit sequence that passes many standard tests for randomness (chi-square, spectral analysis, etc.). Wolfram implemented this in Mathematica for random number generation.
- **Why Significant:** Demonstrates CA can generate high-quality pseudorandom sequences. Used in commercial software. However, cryptanalytic attacks (Meier-Staffelbach) showed Rule 30 is breakable, limiting cryptographic use but not affecting non-cryptographic applications.
- **Distinguishing CA Features:**
  - **State:** Binary
  - **Neighborhood:** Size 3 (left, center, right)
  - **Grid Topology:** 1D line
  - **Update Mode:** Synchronous
  - **Seed:** Initial configuration (typically random or user-supplied)
  - **Output:** Center column over time (1 bit per timestep)
  - **Period:** Pseudorandom (long but finite, depends on grid size)
  - **Cryptographic Weakness:** Vulnerable to chosen-plaintext and correlation attacks

### 9.2 CA-Based Stream Ciphers

- **Field:** Cryptography / Symmetric Encryption
- **Originator(s) and Year:** Various (1990s–2000s); notably CAR30, nonuniform CA approaches
- **Key Publication:** Guan, P. (1987) "Cellular automaton public-key cryptosystem," *Complex Systems*, 1(1), 51–56. Meier, W. & Staffelbach, O. (1991) "Analysis of pseudorandom sequences generated by cellular automata," in *Advances in Cryptology—EUROCRYPT '91*, pp. 186–199. Recent: Mariot, L. (2024) "Insights gained after a decade of cellular automata-based cryptography," *arXiv:2405.02875*.
- **Description:** Stream ciphers where CA generate keystream: plaintext is XORed with CA-generated bits. Designs include: (1) nonuniform CA combining rules 90 and 150 (better properties than Rule 30 alone), (2) CAR30: combines Rule 30 with hybrid linear CA and maximum-length sequences, (3) CA on graphs (network topology not regular lattice). Key is CA initial configuration and rule parameters. Encryption is done by XOR (Vernam cipher style).
- **Why Significant:** Theoretical interest in efficient encryption; practical implementations proved vulnerable to various attacks (linear algebra over GF(2), correlation attacks, guess-and-determine). Most CA-based ciphers are now known to be weak or broken. However, continues to be researched in modified forms.
- **Distinguishing CA Features:**
  - **State:** Binary (per cell) or multi-state (variant designs)
  - **Neighborhood:** Variable (local or semi-local)
  - **Grid Topology:** 1D line, 2D lattice, or general graph
  - **Update Mode:** Synchronous (keystream generation)
  - **Key:** Initial CA configuration and rule numbers
  - **Stochasticity:** None (deterministic keystream)
  - **Cryptanalysis:** Vulnerability to linear algebra and side-channel attacks
  - **Status:** Mostly superseded by proven cryptographic primitives (AES, etc.)

---

## 10. BONUS FIELDS

### 10.1 Cellular Automata in Materials Science: Grain Growth

- **Field:** Materials Science / Metallurgy
- **Originator(s) and Year:** Various (1990s–present); notable work by Kartman, Raabe, and others
- **Key Publication:** Raabe, D. (2002) "Cellular automata in materials science with particular reference to recrystallization simulation," *Annual Review of Materials Research*, 32, 53–76.
- **Description:** CA models of grain growth in metallic materials during recrystallization or solidification. Each lattice cell's state represents either empty space or a crystalline grain with an orientation (e.g., Euler angles). Rules: energetically unfavorable grain boundaries migrate (higher-angle boundaries move faster). Simulated via Monte Carlo or direct propagation rules. Grains grow at expense of neighbors, particularly those with high-angle boundaries. Results: realistic grain microstructures, texture evolution, and subgrain dislocation dynamics.
- **Why Significant:** Enables efficient prediction of microstructure evolution in metals (crucial for manufacturing and materials design). CA is orders of magnitude faster than molecular dynamics or finite-element methods while capturing essential physics.
- **Distinguishing CA Features:**
  - **State:** Grain ID (integer) and orientation per cell
  - **Neighborhood:** Moore or von Neumann (local grain boundary interactions)
  - **Grid Topology:** 2D or 3D lattice
  - **Update Mode:** Monte Carlo (random site selection) or deterministic propagation
  - **Stochasticity:** Yes (grain boundary mobility has probabilistic component)
  - **Anisotropy:** Boundary energy depends on misorientation (crystallographic)
  - **Texture Evolution:** Collective grain growth produces preferred orientations
  - **Industrial Application:** Used in materials processing simulation

### 10.2 Economic/Agent-Based Models (Game Theory, Market Dynamics)

- **Field:** Economics / Computational Social Science
- **Originator(s) and Year:** Various (1990s–present); influenced by Schelling, Axelrod, and game theory literature
- **Key Publication:** Tesfatsion, L. & Judd, K. L. (Eds.). (2006) *Handbook of Computational Economics*, vol. 2, Elsevier. Also: Farmer, J. D. & Foley, D. (2009) "The economics of the elephant," *PNAS*, 106(38), 15033–15038.
- **Description:** CA and agent-based models of economic systems: asset pricing, wealth distribution, labor markets, trade networks. Agents are cells or nodes; states encode income, preferences, or strategy. Update rules: trading (with neighbors), adaptation (copy successful neighbor's strategy), innovation (random new strategy). Macro-level behavior: boom/bust cycles, inequality growth, equilibrium/disequilibrium states. Models test policy interventions (taxation, redistribution).
- **Why Significant:** Provides mechanistic understanding of emergent economic phenomena without assuming rational agents or equilibrium. Shows how inequality and cycles emerge from local interactions.
- **Distinguishing CA Features:**
  - **State:** Economic variable per agent (wealth, strategy, preference)
  - **Neighborhood:** Network (often not regular lattice; scale-free or small-world)
  - **Grid Topology:** Varies (regular lattice, random graph, or empirical network)
  - **Update Mode:** Asynchronous (agents trade, adapt sequentially)
  - **Stochasticity:** High (random mutations, shocks, matching)
  - **Heterogeneity:** Agents often have diverse strategies, preferences
  - **Macroscopic Observables:** Wealth distribution (Pareto tail), price volatility, growth rates
  - **Policy Testing:** Models used to evaluate interventions

---

## 11. AUTHORITATIVE REFERENCES

Key books and reviews cited throughout:

1. **Toffoli, T. & Margolis, N. (1987).** *Cellular Automata Machines: A New Environment for Modeling.* MIT Press.
   - Foundational; introduces Margolus neighborhood and reversible CA in depth.

2. **Ilachinski, A. (2001).** *Cellular Automata: A Discrete Universe.* World Scientific, Singapore.
   - Most comprehensive single-author reference; ~800 pages; covers theory, applications, artificial life.

3. **Chopard, B. & Droz, M. (1998/2005).** *Cellular Automata Modeling of Physical Systems.* Cambridge University Press.
   - Detailed treatment of CA for physics and PDEs; lattice Boltzmann, reaction-diffusion, etc.

4. **Wolfram, S. (2002).** *A New Kind of Science.* Wolfram Media.
   - Massive (1192 pages); elementary CA classification; computational universality; philosophical implications.

5. **Gardner, M. (1970–1983).** "Mathematical Games" columns in *Scientific American*.
   - Popular coverage; Game of Life (1970), and many other CA; made CA accessible to general audience.

6. **von Neumann, J. (1966).** *Theory of Self-Reproducing Automata.* University of Illinois Press. (Edited by A. W. Burks.)
   - Posthumous collection of von Neumann's work on self-replication and universality.

---

## Top-Tier Shortlist for GenesisCA

The shortlist is scoped to **models that drive new feature priorities** for GenesisCA. Models already shipping or already buildable with the current toolkit are listed in "Already Supported by GenesisCA" above so users can find example projects. Each shortlist entry below carries a one-line rationale and (where relevant) the GenesisCA capability it would unlock.

Roughly ranked by feature-coverage diversity, not pedagogical priority:

1. **Bak–Tang–Wiesenfeld sandpile** *(physics, SOC).* Integer height + threshold toppling. Achievable now; *would unlock proper SOC analysis with a power-law / log-log indicator viz.*
2. **Langton's Ant** *(theory, agents).* Single mover on a binary grid. Achievable via async + tag attribute; *first-class agent / mover abstraction would make this and WaTor much cleaner.*
3. **WaTor predator–prey** *(ecology, multi-species).* Same first-class-agent argument; multi-species movement under shared rules.
4. **FHP lattice gas** *(physics, fluids).* Six per-direction booleans per cell on a hexagonal lattice. *Reinforces vector cell state + hexagonal-rendering asks.*
5. **Reiter snowflake** *(physics, morphogenesis).* Continuous state on a hexagonal lattice; diffusion + reception threshold. *Hex rendering + trigonometry / pre-computed neighbour mask.*
6. **Cellular Potts Model (CPM)** *(biology, tissue dynamics).* Cell-ID per site, energy-based Metropolis updates. *Major new primitive: Metropolis Monte Carlo.*
7. **Margolus billiard-ball reversible CA** *(physics, reversibility).* Alternating 2×2 block partitioning. *First-class Margolus block update mode.*
8. **Klausmeier / Rietkerk vegetation patterning** *(ecology).* Coupled continuous fields with anisotropic flow.
9. **Anderson–Chaplain tumour growth** *(biology / medicine).* Multi-field reaction-diffusion + cell migration.
10. **Hodgepodge machine / FitzHugh–Nagumo** *(chemistry, excitable media).* Pedagogical bridge from discrete to continuous excitable systems.
11. **Sznajd / Hegselmann–Krause / Axelrod** *(sociology).* Opinion dynamics beyond Schelling — broadens the social-dynamics library.
12. **Burstedde pedestrian dynamics** *(public resources, transport).* Floor-field CA with static + dynamic fields.
13. **SLEUTH urban growth** *(public resources, urban).* Multi-rule stochastic CA with growth coefficients; demonstrates parameterised real-world fit.
14. **Wildfire spread (FARSITE-style)** *(earth sciences).* Heterogeneous terrain via per-cell tunable attributes.
15. **DeSoi–Kier β-cyclodextrin enantiomer chromatography** *(chemistry).* Column-scale separation with stochastic stationary-phase binding. *Probabilistic-binding pattern; chain / list cell attribute for solute identity stacks.*
16. **Larson–Scriven–Davis amphiphile self-assembly** *(chemistry, soft matter).* Lattice MC with head/tail chains forming micelles, bilayers, lamellae. *Metropolis primitive + composite cell state — synergises with CPM.*
17. **Kier–Cheng–Testa percolation micelle CA** *(chemistry).* Pure CA predicting CMC via spanning-cluster percolation. *Cluster / connected-component detection as a built-in.*
18. **SCIARA-fv3 lava flow** *(earth sciences, volcanology).* Empirical macroscopic CA on a topographic DEM; mass-conservative outflow ratios summing to 1 across neighbours; operationally validated against multiple Etna eruptions. *Anisotropic / topography-weighted neighbourhood + first-class "weighted outflow" pattern.*
19. **Olami–Feder–Christensen earthquake** *(earth sciences, seismology).* Quasi-static stress loading with synchronous avalanche slips; Gutenberg–Richter power-law magnitudes. Achievable today; *benefits from the same power-law / log-log indicator viz called out for sandpile, plus an "event-size" indicator that captures avalanche magnitudes.*
20. **SCIDDICA debris flow (S₃-hex)** *(earth sciences, geomorphology).* Companion to SCIARA for granular debris flows; the hex-lattice variant explicitly motivates hex visualisation.
21. **Lattice Boltzmann Method for porous-media flow / CO₂ sequestration** *(earth sciences, subsurface flow).* D2Q9 / D3Q19 distribution functions per cell; mass + momentum conservation built into the lattice. *Strongest single justification for vector cell state and for multi-pass-within-a-generation (streaming + collision).*

### Cross-Cut Feature Asks That Emerge from the Shortlist

The shortlist surfaces a handful of recurring capability needs. Sorted by how many shortlisted models they unlock:

- **Metropolis / Monte Carlo update primitive** — CPM, Larson amphiphile self-assembly, Smit–Esselink–Hilbers, Ising-style models.
- **Vector / list / chain per-cell state** — FHP (per-direction occupancy), LBM (D2Q9 distribution), CPM (cell IDs as flexible structures), Larson micelle chains, DeSoi chromatography solute stacks.
- **Anisotropic / topography-weighted neighbourhood with mass-conservative outflow distribution** — SCIARA, MAGFLOW, SCIDDICA, CATS, dune CAs, CO₂ migration.
- **Power-law / log-log indicator viz** — sandpile, forest fire, OFC earthquake (Gutenberg–Richter analysis).
- **Cluster / connected-component detection** — Kier–Cheng–Testa percolation micelle, sandpile avalanche labelling, ecology patch analysis, fracture-network percolation.
- **Hexagonal lattice rendering** — FHP, Reiter snowflake, SCIDDICA-S₃-hex. Hex *neighbourhoods* are already achievable via custom-coord lists; the missing piece is visualisation so cells render as hexes, not skewed squares.
- **Margolus block partitioning** — billiard ball, reversible CAs, lattice-gas variants.
- **Trigonometry / exp / log on the math node** — Reiter snowflake, wave equations, anisotropic chemistry.
- **Stochastic distributions beyond uniform** — Brownian-noise biological models, kinetic chemistry, hydrate nucleation.
- **Multi-pass within a generation** — LBM streaming + collision split, RD sub-stepping, MC sweep counts.
- **First-class agent / mover abstraction** — Langton's ant, WaTor.

These will be the spine of the Phase 2 feature roadmap (`docs/ROADMAP.md`).

---

## FINAL NOTES ON GAPS AND RESEARCH FRONTIERS

Several areas have growing CA work but less canonical "textbook" status (yet):

- **Neural CA (Lenia, Growing Neural CA):** Emerging field; differentiable CA for morphogenesis. Requires continuous state, large neighborhoods, optimization-based evolution.
- **Margolus Block CAs (Billiard Ball, Critters):** Reversible; specialized (2×2 partitioning, alternating schemes); valuable for physics but fewer standard references.
- **Continuous CA:** CML (coupled map lattice), PDE-approximating CA; increasing relevance but less uniform treatment.
- **Probabilistic/Stochastic CA:** Growing importance (biological noise, quantum CA); various update schemes (asynchronous, event-driven).
- **Higher-Dimensional Lattices:** 3D and beyond; lattice Boltzmann in 3D (D3Q27); less explored in pure CA literature.
- **Non-Lattice Topologies:** Graph-based CA (small-world, scale-free networks); relevant to social and biological networks; fewer standard models.

---



---

## SOURCES & BIBLIOGRAPHY

### Web Search References (as consulted)
- [Lattice gas automaton - Wikipedia](https://en.wikipedia.org/wiki/Lattice_gas_automaton)
- [Cellular automata - Scholarpedia](http://www.scholarpedia.org/article/Cellular_automata)
- [Conway's Game of Life - Wikipedia](https://en.wikipedia.org/wiki/Conway's_Game_of_Life)
- [Self-organized criticality - Wikipedia](https://en.wikipedia.org/wiki/Self-organized_criticality)
- [Rule 110 - Wikipedia](https://en.wikipedia.org/wiki/Rule_110)
- [Rule 30 - Wikipedia](https://en.wikipedia.org/wiki/Rule_30)
- [Langton's Ant - Wikipedia](https://en.wikipedia.org/wiki/Langton's_ant)
- [Wireworld - Wikipedia](https://en.wikipedia.org/wiki/Wireworld)
- [Von Neumann universal constructor - Wikipedia](https://en.wikipedia.org/wiki/Von_Neumann_universal_constructor)
- [Codd's cellular automaton - Wikipedia](https://en.wikipedia.org/wiki/Codd's_cellular_automaton)
- [Reversible cellular automaton - Wikipedia](https://en.wikipedia.org/wiki/Reversible_cellular_automaton)
- [Forest-fire model - Wikipedia](https://en.wikipedia.org/wiki/Forest-fire_model)
- [Wa-Tor - Wikipedia](https://en.wikipedia.org/wiki/Wa-Tor)
- [Greenberg–Hastings cellular automaton - Wikipedia](https://en.wikipedia.org/wiki/Greenberg-Hastings_cellular_automaton)
- [Schelling's model of segregation - Wikipedia](https://en.wikipedia.org/wiki/Schelling's_model_of_segregation)
- [Sznajd model - Wikipedia](https://en.wikipedia.org/wiki/Sznajd_model)
- [Nagel–Schreckenberg model - Wikipedia](https://en.wikipedia.org/wiki/Nagel%E2%80%93Schreckenberg_model)
- [Biham–Middleton–Levine traffic model - Wikipedia](https://en.wikipedia.org/wiki/Biham%E2%80%93Middleton%E2%80%93Levine_traffic_model)
- [Cellular Potts model - Wikipedia](https://en.wikipedia.org/wiki/Cellular_Potts_model)
- [Brian's Brain - Wikipedia](https://en.wikipedia.org/wiki/Brian's_Brain)
- [Elementary cellular automaton - Wikipedia](https://en.wikipedia.org/wiki/Elementary_cellular_automaton)
- [A New Kind of Science - Wikipedia](https://en.wikipedia.org/wiki/A_New_Kind_of_Science)
- [FitzHugh–Nagumo model - Wikipedia](https://en.wikipedia.org/wiki/FitzHugh%E2%80%93Nagumo_model)
- [Cellular Automata Machines - MIT Press](https://mitpress.mit.edu/9780262526319/cellular-automata-machines/)
- [Cellular Automata: A Discrete Universe - Andrew Ilachinski (Amazon, World Scientific)](https://www.amazon.com/Cellular-Automata-Discrete-Andrew-Ilachinski/dp/981238183X)
- [Cellular Automata Modeling of Physical Systems - Chopard & Droz (Cambridge University Press)](https://www.cambridge.org/core/books/cellular-automata-modeling-of-physical-systems/)

All search results have been consulted; hyperlinks embedded above per user request.

---

This concludes the **Comprehensive Catalog of Significant Cellular Automata Models & Methods**. The document is self-contained and can be used as a reference for feature planning, research prioritization, and understanding the CA landscape across disciplines.
# Investigation — Bond-Graph Morphogenesis (glued cells, geometry-driven division, mechano-chemical autonomy)

> **Status:** feasibility study + literature synthesis + subsystem Impact-Map **DELTA**. Precursor to a formal plan, **not** a commitment to build. No code has changed.
>
> **This document EXTENDS [INVESTIGATION_CENTER_BASED.md](INVESTIGATION_CENTER_BASED.md)** (the "CB doc"). It does **not** re-derive the center-based substrate, the force-integration driver, the `maxCells`/free-list tier, the per-step neighbour rebuild, the renderer, or the 50-row Impact Map — read the CB doc first; everything here is the **delta on top of it**. Where the CB doc already settled a hazard or a reuse, this doc cites it (`CB §N`, `CB Impact #N`) and adds only what the *bond graph + geometry-driven division + mechano-chemical field* require beyond it.
>
> **What's genuinely new here vs the CB doc.** The CB doc deliberately scoped *adjacency* to **implicit distance-cutoff** (`r_max` neighbours, recomputed every step, no stored edge — CB §2.1, §2.4) and division to a **free partition** (two daughters at `xᵢ ± ε·m̂` along a *random/oriented* axis — CB §2.3, §6.4). The user's actual vision needs two things the CB doc explicitly left out:
> 1. **Cells GLUED into a programmable, persistent, dynamic CONNECTION TOPOLOGY** — an *explicit labelled bond graph* over the force agents, not just whoever is momentarily within `r_max`. This is the **SDCA (Structurally Dynamic CA) tier** from [INVESTIGATION_GRAPH_CA.md](INVESTIGATION_GRAPH_CA.md) (the "GraphCA doc", §2.5/§2.8/§7.4), now riding on continuous-position agents instead of fixed nodes.
> 2. **DIVISION as a geometry-driven GRAPH-REWRITE** — the split axis is a *physically-realizable vector* set by neighbour pressure/tension/density (Hertwig long-axis), daughters placed along it, and **each bond inherited by whichever daughter ends up on its side** of the cut. This is the **opposite** of the "free partition of which bonds go where" the user's earlier framing implied — and §3 corrects that framing explicitly.
>
> **How produced:** three primary papers (Okuda/Eiraku 2018; Vikran/Hirashima 2025; Nelson 2009) + a division-plane-law literature topic (Hertwig→Minc→Bosveld→Besson-Dumais) + a bond/vertex/L-system computational-lineage topic, each fact-checked; plus firsthand codebase reads grounding every reuse claim (the `MoveSelfToNeighbor` emit template [MoveSelfToNeighborNode.ts:70-95](../src/modeler/vpl/nodes/MoveSelfToNeighborNode.ts); the build-once fixed-stride lattice adjacency table [buildNeighborIndices, sim.worker.ts:877-913](../src/simulator/engine/sim.worker.ts); the `VariegatedCellsConfig`/`FaceLabelPalette` schema templates [types.ts:444-483](../src/model/types.ts); the `UPDATE_VARIEGATED_CELLS` reducer recipe [ModelContext.tsx:188,892,1242](../src/model/ModelContext.tsx); the Gray-Scott Laplacian field at [scripts/gen-grayscott.mjs](../scripts/gen-grayscott.mjs)).

---

## 1. Verdict — the vision is well-founded, and it is a SYNTHESIS of four tiers

**The user's vision is sound, ambitious, and — critically — not one model but a *synthesis* of four complementary tiers that the literature treats as separable layers.** Built in the right order, each tier is independently demonstrable and each one is a real differentiator. The honest framing: this is **center-based + an SDCA bond graph + geometry-driven division-as-rewrite + (for autonomy) a reaction-diffusion field with geometry/curvature feedback.** None of the four is speculative; each maps to a primary paper that exists and was verified.

> **Scoping caveat stated up front (so the effort is not misread as a small delta on shipping code).** Tier (I) — the entire center-based substrate this document rides on — is **itself research-only and unbuilt**: there is **zero** `centerBased` / `maxCells` / `bondGraph` / free-list code in `src/` today (the CB doc is explicitly "no implementation planned"). So every "✅ reuse" below means **reuse-of-*planned*** machinery — this is a layer on top of a large, also-unbuilt project, and the real effort is the bond/division/field delta **plus** the whole center-based substrate beneath it. Read the §7 Impact Map's "reuse" tags in that light.

| Tier | What it buys | Why it matters (primary source) |
|---|---|---|
| **(I) Center-based agent mechanics** | the substrate — soft-sphere agents, overdamped force integration, growth, death, dynamic `r_max` adjacency, native 3D, strong GPU fit | This is the **CB doc** in full. The literature *built this family for* division + morphogenesis (PhysiCell; Drasdo/Höhme). The user's "rules over volume, radius, age decide when to divide/grow/die" is PhysiCell's Phenotype + Cell_Functions verbatim (CB §2.3). **Already analysed — reused wholesale.** |
| **(II) Explicit dynamic BOND graph (the glue)** | cells *glued/coupled* to specific neighbours by **persistent labelled edges** that survive momentary separation and break only by rule — a programmable topology, not whoever-is-near | The user's "cells glue/couple to neighbours" is **not** distance-adjacency; it is the **SDCA tier** (GraphCA §2.5/§7.4). The mechanics precedent is **PhysiCell spring adhesion** (`state.attached_cells` + Hookean contact) and **CompuCell3D FocalPointPlasticity** (per-link target length `L`, stiffness `λ`, `MaxDistance` break, `MaxNumberOfJunctions` cap, `E = Σ λ(l−L)²`, explicit create/delete-link through mitosis) — the closest existing precedent to exactly this feature. **NEW vs the CB doc.** |
| **(III) Geometry-driven DIVISION-as-rewrite** | division split along a **physically-realizable axis** (Hertwig long-axis / tension / neighbour-density), daughters placed along it, **bonds inherited by geometry** (each partner reattaches to the nearer daughter) | The user's exact constraint. **Okuda/Eiraku 2018**: "the direction of the dividing plane is regulated to be normal to the longest axis of the individual cell shape" and each original neighbour's shared face is partitioned to the daughter it lies against — *bond/neighbour inheritance follows from the geometry of the cut, not a free choice.* Grounded by the **division-plane-law lineage** (Hertwig 1884 → Minc-Burgess-Chang 2011 → Bosveld 2016 → Besson-Dumais 2011). **NEW vs the CB doc's free-partition division.** |
| **(IV) Mechano-chemical field + curvature feedback (autonomy)** | a reaction-diffusion morphogen field cells secrete into and sense, plus **curvature/density geometry sensing**, as per-cell rule INPUTS — so branching/tubulation **emerge from coupling, not a script** | **Okuda/Eiraku 2018**: a discrete Gierer-Meinhardt Turing field on the cell adjacency graph, activator→growth→deformation→re-patterning, the (γ, χ) ratio selecting undulation/tubulation/branching. **Vikran/Hirashima 2025**: curvature as the master sense→act→re-sense loop (with the *mandatory time-lag/hysteresis* that makes it repeat, not stall). **Nelson 2009**: geometry sculpts source/sink morphogen + stress fields that instruct each cell. **NEW vs the CB doc** (which deferred chemistry to its Phase 5 and never touched curvature). |

**The single most important synthesis claim:** tiers (II), (III) and (IV) are *exactly* what turns the CB doc's "soft spheres that sort and divide randomly" into **actual programmable multicellular SHAPE**. The bond graph (II) gives the cell aggregate a *connectivity* (chains, sheets, clusters, branches — not a gas of spheres). Geometry-driven division (III) makes growth *structured* (the tissue elongates/folds along mechanical axes instead of ballooning). The field + curvature feedback (IV) makes the whole thing *autonomous* (the rule reads the shape it is building and steers — branching emerges). Remove any one and you lose a qualitative capability the user asked for.

**The one honest scoping decision this doc forces (the bonds-vs-vertex substrate question — see §2):** there are two ways to make "the connection topology" concrete. **(A) explicit bond graph over center-based agents** (soft spheres + labelled dynamic edges) — lighter, fits the per-cell IR, great for aggregates/chains/clusters/branching-by-chemotaxis, but **NO true cell shape**; vs **(B) a vertex/polygon model** where cells share faces and the face network *is* the topology made geometric — true deformable shape + gap-free tiling + real curvature (Okuda paper 3), but **heavier**, and the per-cell-step compiler *partially breaks* because the integrated degree of freedom is a *shared vertex*. **Recommendation: (A) first, (B) as the eventual true-shape target.** §2 makes that case honestly.

---

## 2. Two concrete realizations — and which is the better FIRST target

The user's "cells glued into a dynamic connection topology" admits two faithful realizations. Both are real model families with literature. They differ on a single axis — **is a "connection" an explicit edge between cell *centres*, or the shared *geometry* of two cells' boundaries** — and that axis decides everything about fit, cost, and what shape you can build.

### 2.A — Center-based + explicit bond graph (RECOMMENDED FIRST TARGET)

Each cell is a **soft sphere at a continuous centre** (tier I, the CB doc) **plus an explicit list of labelled bonds** to specific partner cells. A bond is a first-class object with its own state — borrowing FocalPointPlasticity's data model directly:

- **rest/target length `L`**, **spring stiffness `λ`**, **type-pair label** (which adhesion class), **age/strength**, and a **`MaxDistance` break threshold**.
- Per-bond force `F = λ(l − L)·r̂` summed into the agent's net force *alongside* the soft-sphere repulsion (the bond list is a **second neighbour set** iterated after the distance candidates — see §5).
- Bonds **form** on contact (a `FormBond` rule, gated on type-compatibility + a `maxBonds` cap), **break** above a strain threshold or by rule (`BreakBond`), and are **inherited at division by geometry** (tier III, §3).

**Why this is the better first target — five concrete reasons, each grounded:**

1. **It fits the per-cell IR almost intact.** The CB doc already established that each agent summing its own forces and integrating its own position is *"a true per-cell step that survives almost intact"* (CB §1, §4 option C). Adding bonds changes only the *data* behind "get my partners": the compiled force step now reduces over **two** sets — the distance candidates *and* the persistent bond list — but it is still one agent, one net-force vector, one position write. No new degree-of-freedom ownership problem.

2. **The bond force reuses the CB doc's already-new vector reduction.** The CB doc's single genuinely-new emit is the **vector force reduction `Σ F(d)·r̂`** plus `GetNeighborPosition` (CB §7.1, Impact #24a). A bond spring is *the same vector reduction* over a different (persistent, ragged) partner list — the per-bond magnitude `λ(l−L)` is scalar value-node math the existing library already covers. **The bond graph adds an iteration source, not a new emit kind.**

3. **The bond data model is FocalPointPlasticity, which is exactly GenesisCA's `lookupTable`-keyed differential-adhesion already.** The CB doc reuses the `tag×tag lookupTable` as the adhesion matrix (CB §5.2, Impact #23/#48). A **bond-spring matrix** (`λ` and `L` per type-pair) is the same `lookupTable` mechanism with two value channels — no new attribute type.

4. **It is GPU-native and 3D-clean.** The CB doc's "strong WebGPU fit" (CB §2.7, §7.3) survives: a per-bond force is still an embarrassingly-parallel per-agent gather (each agent reads its own bond list). 3D is a dimensionality switch (bonds gain a z-component for free). The vertex model is the inverse on both axes (§2.B).

5. **It is the right substrate for the user's headline shapes** — aggregates, **chains** (1-2 bonds/cell), **clusters** (differential-adhesion sorting + bonds locking the sorted state), and **branching-by-chemotaxis** (bonded filaments growing up a field gradient). The computational-lineage research confirms this is a *well-precedented* point: family (2), "explicit labelled bonds" — PhysiCell springs + CC3D FocalPointPlasticity — *not* the implicit adjacency of base PhysiCell/CPM and *not* the shared-face mesh of vertex models.

**Its ceiling (stated bluntly, inheriting the CB doc's):** **there is still no true cell SHAPE.** A cell is a point + a radius + a bond list. You get *connectivity* and *topology*, but each cell is a sphere — so you cannot model the cell *deforming* into a wedge (apical constriction), nor get gap-free space-filling tiling, nor compute real geometric curvature of a sheet from cell polygons. For the user's stated 2D-first aggregate/chain/cluster/branch goals this is *fine* (curvature is approximated from the bond-fan geometry — §6.3); for folding-epithelium sheet mechanics it is not, which is precisely what (B) buys.

### 2.B — Vertex model (the eventual TRUE-SHAPE target; NOT first)

Cells are **polygons (2D) / polyhedra (3D) that share edges/faces**; the **shared-face adjacency network IS the connection topology, made geometric.** "A glued to B" means "A and B share a face," and the shared-face *area* is a real contact quantity (Okuda paper 3 feeds it into the diffusive flux). This is the only family that delivers **true deformable cell shape, tight gap-free confluent tiling, and real geometric curvature** — the paper-3 epithelial undulation/tubulation/branching the user referenced.

**Why it is NOT the first (or even second) target — the honest fit-breakage, grounded firsthand:** This is the most important caveat in the document. GenesisCA's load-bearing commitment is *"compile the node graph to a per-cell step, call it once per generation over `total` sites"* — the unit of state and iteration is **ONE entity per index** ([`total = width*height`, sim.worker.ts:751](../src/simulator/engine/sim.worker.ts); [`fn(...buildLoopArgs())`, sim.worker.ts:1192](../src/simulator/engine/sim.worker.ts); lattice geometry baked into the loop body, [compile.ts:1748-1752](../src/modeler/vpl/compiler/compile.ts)). The vertex model breaks this *worse than CPM or center-based*:

- **The integrated DOF is a VERTEX, shared by ~3 cells (2D) / ~4 (3D).** Force balance integrates *vertices* (`η dr/dt = −∇U`), but a vertex belongs to multiple cells. The energy `U(area, perimeter, line-tension)` is **per-cell**, yet the gradient that moves a vertex sums contributions from **every incident cell**. The per-cell step has **no clean owner for the vertex update** — a genuine two-level coupling (per-cell energy → per-vertex force) the single-index loop cannot express. This is structurally *worse* than CPM (graph demoted to a scalar ΔH, bespoke driver owns everything) and center-based (each agent integrates its OWN position). **This is the single most important finding of the vertex audit:** the engine-agnostic-IR abstraction that *holds* for CPM↔center-based **partially BREAKS for vertex** because the integrated DOF is multi-cell-shared, not per-cell.
- **It needs a SECOND iteration domain (vertices) the engine has zero infrastructure for.** Center-based adds ONE tier (agents). Vertex adds TWO — a per-cell area/perimeter/type tier (which *does* reuse the CB doc's `maxCells`/free-list machinery verbatim) **plus** a per-vertex position/DOF tier — bridged by explicit ordered cell→vertex loops + shared-edge records.
- **Explicit mutable mesh topology with T1/T2 surgery.** T1 (neighbour exchange: a short shared edge collapses to a vertex, re-resolves perpendicular), T2 (a vanishing small cell collapses to a vertex), and topology-rewriting division (split a cell through a plane, insert 2 vertices, rewire local faces). These are delicate local surgeries with **degenerate / self-intersecting-polygon hazards** — a silent-corruption class (an inadvertent self-intersection silently produces *negative areas*, energy blows up) nastier than center-based's "append two agents." (Fletcher 2014 is the standard reference; Okuda's Reversible Network Reconnection is the 3D version.)
- **Force emit is harder than the CB doc's already-new vector reduction:** per-vertex force = −∇ of a *sum of incident-cell* energies, coupling through shared topology.
- **The renderer is not reused:** filled polygons from ordered vertex loops + point-in-polygon picking, vs the CB doc's filled circles + nearest-centre picking. Neither reuses the dense `ImageData` lattice blit.
- **Worst GPU/3D/browser cost of all candidates:** GPU "poor" (T1/T2 mutate topology mid-step, hostile to a fixed kernel); 3D "the most technically challenging" (Osborne 2017 — polyhedral T1/T2 is research-grade); browser precedent "none mature." (Both prior docs independently score vertex *low fit* — [CB §3.1 substrate table, INVESTIGATION_CENTER_BASED.md:173](INVESTIGATION_CENTER_BASED.md); [CPM §3.1, INVESTIGATION_CPM.md:159](INVESTIGATION_CPM.md). There is **zero** vertex/mesh/half-edge infrastructure in `src/` today — confirmed: the 3 grep hits for "vertex" are SVG/CSS icon-path coordinates, not a model.)

**The crisp tension to internalise:** the very property that makes vertex *appealing* for adjacency — *"the shared-face network IS the explicit connection graph"* — is the **same** property that makes the integrated DOF (the vertex) belong to multiple cells, which is the **precise** thing that breaks the per-cell-step compiler. Adjacency-for-free and DOF-ownership-breakage are two faces of one coin.

### 2.C — The recommendation

**Build (A) — center-based + explicit bond graph — first.** It fits the compile paradigm, is GPU-native, is 3D-clean, reuses the CB doc's force machinery + `lookupTable` adhesion + `maxCells` tier, and delivers the user's headline shapes (aggregates → chains → clusters → branching). Treat **(B) — vertex — as a third engine** behind the same engine-agnostic per-cell IR both prior docs recommend, scoped *only* if/when the goal drifts to shape-driven **sheet mechanics specifically** (folding epithelia, apical constriction, lumen/tube formation), with the honest caveat that the IR abstraction only *partially* covers vertex (the per-cell energy terms author as nodes; the per-vertex force assembly does not).

> A first-build sequencing consequence: **(A) layers on top of the CB doc, not beside it.** Bonds are a *later wave* of the center-based effort, not a parallel mode — build the CB doc's Phases 0-4 (agent tier, force driver, distance neighbours, division, death) first, then add bonds as the **mutable-topology wave** (§7).

---

## 3. Geometry-driven DIVISION — the centrepiece (and the correction of the free-partition framing)

This is the heart of the user's vision and the place where the design must be most precise. **The earlier framing — that a dividing cell *freely partitions which bonds go to which daughter* — is physically wrong, and this section corrects it.** The split is not a free choice; it is a **geometric consequence of a physically-realizable axis**, and bond inheritance *follows* from that geometry.

### 3.1 The split axis is a VECTOR, computed from neighbour mechanics — not chosen freely

The division-plane-law literature is unanimous and quantitative: **the division axis is a computed vector, defaulting to the cell's longest morphological axis (Hertwig's long-axis rule), modulated by mechanical tension and neighbour packing.**

- **Hertwig 1884** (the founding law, verified): cells place the division plane **perpendicular to the longest axis of their interphase shape**; reshaping the cell reorients the cleavage. Geometry sets the axis — not a fixed internal program.
- **Minc, Burgess & Chang 2011** (Cell 144:414, verified) makes it *computable*: forcing eggs into micro-shaped chambers, cell shape **predicts** spindle orientation and division plane via length-dependent astral-microtubule pulling forces. The axis = **principal eigenvector of the cell's geometry** (inertia/covariance tensor).
- **Okuda/Eiraku 2018** states the rule the user's vision needs verbatim: *"the direction of the dividing plane is regulated to be normal to the longest axis of the individual cell shape, on the plane of the tissue surface."* The cell's elongation is itself shaped by neighbour pressure/packing — so the axis is *physically realizable*, set by the mechanical neighbourhood.
- **Bosveld 2016** (Nature 530:495, verified) identifies the *sensor*: tricellular junctions store interphase-shape anisotropy (= **neighbour packing**) and recruit the force generators that orient the spindle. Junction geometry — set by how neighbours pack — is the read-out.
- **Tension can override shape** (Scarpa/Mao 2017; Campinho 2013; Wyatt 2015): in tissues, divisions orient along **mechanical tension**, and dividing along that axis **relaxes anisotropic stress** (an emergent homeostatic-packing driver). Nestor-Bergmann 2019: the shape principal axis ≈ the local principal stress axis, so one orientation tensor carries both.

**In center-based + bond-graph terms — and the honest physics correction (an earlier draft of this recipe was wrong here):**

A soft sphere has **no cell shape**, so the *faithful* Hertwig/Minc long-axis (the principal axis of the cell's own deformed geometry) is **literally uncomputable in realization (A)** — only the vertex model (B) carries a real cell shape to take the long axis of. What (A) *can* compute from the bond/neighbour configuration is a **mechanical proxy: the tension axis** — and it must be weighted by bond *tension*, **not** by uniform neighbour packing. (An unweighted `Σ offset⊗offset` packing tensor's principal eigenvector points to where neighbours are *most spread* — in a packed tissue that is typically the cell's **short/compressed** axis, so dividing along it would be **backwards**.)

```
# (A) tension-proxy division axis — a unit vector m̂ per dividing cell i:
for k in bonds(i):
  r̂_k = (position[partner_k] − position[i]) / l_k
  w_k = max(0, λ_k·(l_k − L_k))             # TENSILE (stretched) bonds only = the stretch/tension
M = Σ_k w_k · (r̂_k ⊗ r̂_k)                   # 2×2 (3D: 3×3) tension tensor
m̂ = principal eigenvector of M               # the net-STRETCH (elongation) direction
if Σ_k w_k ≈ 0:                              # relaxed/compressed → no tension signal (DEGENERATE)
  m̂ = minor eigenvector of Σ_k (r̂_k ⊗ r̂_k)  # divide into the lowest-density "room" gap (least resistance)
  # (or a uniform-random axis if even the packing is isotropic)
```

The split plane is **perpendicular to `m̂` through the centroid**; daughters are placed at `centroid ± ½·offset·m̂` (the CB doc's `xᵢ ± ε·m̂` dumbbell, CB §6.4 — but `m̂` is now the *computed tension axis*, not random). **Attribution corrected:** this is the **mechanical tension/packing rule** (Campinho 2013 / Wyatt 2015 / Scarpa-Mao 2017 / Nestor-Bergmann 2019 — divisions orient along, and *relieve*, principal tension), **not** the shape rule (Hertwig/Minc), which needs true cell shape and so lives in (B). Nestor-Bergmann 2019 shows the tension axis ≈ the shape long-axis *in real tissue*, so the proxy is well-motivated — but it is a genuinely different computation and must not be mislabelled. The 2×2 eigensolve is closed-form (no iterative solver); the whole thing is a per-cell **outer-product reduction over the bond list** GenesisCA already compiles, plus a tiny fixed-size eigensolve the engine owns. **The faithful geometric long-axis (Hertwig) division the user pictures is, by this analysis, a concrete reason to scope (B) vertex** (it is the one tier-III mechanism (A) cannot do faithfully) — see §2 and §9.

### 3.2 Bonds are inherited BY GEOMETRY — the partition follows the cut

This is the user's explicit constraint, and it is **deterministic, not a free choice:**

> For each pre-existing bond `i—partner_k`, assign it to **whichever daughter centre is on the same side of the division plane as `partner_k`** — i.e. the nearer daughter, `sign(dot(offset_k, m̂))`. Then create exactly **one new bond between the two daughters.**

This is the center-based analogue of Okuda/Eiraku's per-face partition (*"each original neighbour's shared face is partitioned to whichever daughter it lies against"*) and of VirtualLeaf's wall-partition division (pick an axis, build the new shared wall, assign the parent's wall nodes to the two daughters). The computational-lineage research confirms it is the **standard partition rule** in vertex and center-based morphogenesis models. The bond-graph version re-partitions **bonds** rather than mesh walls — which is *cheaper* than the mesh case because an explicit bond graph has no shared geometry to keep manifold (no vertex-merge/re-resolve; "neighbour exchange" is just delete-one-bond/add-another).

**The correction, stated plainly:** the user's earlier mental model ("the rule freely decides which bonds go to which daughter") would let a rule produce *physically impossible* topologies (e.g. all bonds to one daughter, leaving the other floating, or interleaved partitions no real cleavage could make). The geometric rule **forbids** that: the daughter that ends up on a partner's side *gets* that partner's bond, full stop. The only authoring freedom is in choosing the **axis source** (shape vs tension vs density) and the **division-readiness predicate** (when, §4) — never the partition itself.

### 3.3 Morphogen inheritance at division

Okuda/Eiraku 2018: daughters inherit the **mother's molecular concentrations** (so molecule *count* splits with volume; concentration conserved). For the field tier (IV), a `DivideCell` must therefore split the mother's per-agent field-coupled attributes by the volume ratio (concentration-preserving) — a small explicit rule the engine owns, flagged so it isn't forgotten (the CB doc never had a field, so this is new). **Be explicit about count-vs-concentration** in whatever the engine stores (the Okuda caution: conserving concentration means splitting count with volume).

### 3.4 The post-division hazard inherits from the CB doc — *plus* a bond-overflow twin

The CB doc's #1 correctness hazard — overlapping daughters → stiff repulsion → forward-Euler overshoot unless `Δt ≤ Δt*_mono` (Mathias 2020; CB §2.2, §6.3, §13.1) — applies **unchanged**. The bond graph adds a **twin hazard at the same moment**: division *mutates other agents' bond lists* (each partner's bond now points at a daughter) **and** creates the daughter-daughter bond, so a division near the `maxBonds` ceiling can overflow a partner's bond list *exactly when the geometry is densest*. This is the **riskiest single piece** of the whole feature — it hits `maxBonds` overflow **and** the bond double-buffer hazard (§5.2) **and** the post-division `Δt` overshoot simultaneously. Mitigation: reject + surface (never wrap) on `maxBonds` overflow, mutate bond lists into the *write* buffer only, and clamp `Δt` against the monotonicity bound (§5.3).

---

## 4. WHEN to divide / grow / die — rules over arbitrary attributes (the per-cell IR, mostly reused)

The user wants "rules over arbitrary cell attributes (volume, surface area, radius, #glued neighbours, bond strengths, age…) + model attributes decide WHEN to divide, how much to grow, when to die." **This is almost entirely the CB doc's per-cell rule graph + a handful of new read nodes** — the rules layer is where reuse is highest.

The decision predicates are ordinary value-node math (`Compare`/`Statement`/`arithmetic` over attribute reads → a `DivideCell`/`KillCell`/`SetTargetRadius` flow node), exactly as the CB doc's §7. What's **new** is the *set of readable quantities* the bond graph + field make first-class:

| Sensed input | Node | Grounding |
|---|---|---|
| **# glued neighbours** (bond degree) | `GetBondDegree` | the GraphCA `GetDegree` template (§2.2/§7.3); **first-class, not an `Average`-macro** (§9 gotcha) |
| **summed/mean bond strength** | `SummedBondStrength` / per-bond `ForEachInArray` over the bond list | reuses the per-bond loop (§5); FocalPointPlasticity exposes per-link length/tension |
| **neighbour density** | `NeighbourDensity` | GraphCA "density first-class" (§12.6) + Nelson "stress maxima = growth maxima"; **first-class, not `Average`** |
| **local curvature** | `GetCurvature` (fit a circle/plane to the bond fan; angle-deficit) | Vikran/Hirashima "curvature is the master sensed cue" (§6.3) |
| **mechanical pressure / tension** | `LocalPressure` (Σ repulsive overlap) / bond tension `λ(l−L)` | Nelson "tension→proliferate, compression→arrest"; sets the division axis (§3.1) |
| **field value / gradient at self** | `SampleField` | Okuda activator-as-mitogen; Nelson morphogen thresholds (§6) |
| volume / surface area / radius / age | existing reads + `GetRadius` (CB §7.2) | PhysiCell Phenotype; growth = target-radius ODE (CB §2.3) |

**Growth** = the CB doc's per-cell target-radius/volume ODE (CB §2.3, §6.4), with the rate **gated** by a sensed input — Okuda's activator-as-mitogen **Hill function** (`λ = λ_ref · cᴬ^α / (ρ_sw^α + cᴬ^α)`, α=10 ≈ a sharp switch) is the canonical "chemistry gates growth" primitive, and Nelson's "tension/stretch → grow, compression/crowding → arrest" is the mechanical gate. **Death** = the CB doc's free-slot recycle (CB §2.3, §6.4), with the rate optionally curvature-biased (Vikran/Hirashima: extrusion higher in concave regions). All three reuse the CB doc's structural-event machinery verbatim — the *only* delta is the new sensed inputs above feeding the predicates.

---

## 5. The bond graph as a runtime tier — the SDCA delta on the CB engine

The CB doc's engine (force driver, `maxCells`/free-list, per-step distance-neighbour rebuild, position double-buffer, division/death — CB §6) is the substrate. Bonds add a **second, persistent, mutable adjacency layer** on top. This is the GraphCA **SDCA tier** (§2.5/§2.8/§7.4) realised on moving agents — and it carries that tier's hazards.

### 5.1 Storage — a persistent ragged adjacency, NOT the distance neighbour list

The CB doc's per-step distance neighbours are *recomputed and thrown away* each step (CB §6.2). **Bonds must persist across steps** — they are stored state, not a query result. Treat the bond graph as a **ragged per-agent partner list** (the GraphCA CSR/PCSR family, §2.8):

- A per-agent **fixed-capacity bond array** (`maxBonds` slots/agent, mirroring FocalPointPlasticity's `MaxNumberOfJunctions`) holding `{partnerId, partnerEpoch, restLength L, stiffness λ, typeLabel, age/strength}` — SoA, viewed over `wasmMemory` from the WASM phase under the copy-into-never-reassign discipline (the CB doc's view gotcha, CB §5.1). The **`partnerEpoch`** is load-bearing (see the dangling-bond hazard below): a free-list slot reused by a new agent must not silently inherit old bonds.
- **`maxBonds` is a hard ceiling** — overflow rejects + surfaces (never wraps), exactly the `maxCells` policy (CB §13.1) and the Amphiphile-NI-poisoning hazard class.
- Because edge insert/delete is the operation, **plain CSR is the wrong structure** (O(E) mutation — GraphCA §2.8); the per-agent fixed-capacity array *is* the PCSR-lite that makes form/break O(1).
- **Bond serialization** rides the CB doc's `SimulationState` agent-table extension (CB §5.4, Impact #41): the bond arrays + per-agent bond counts serialize as base64 typed arrays. Because the array is **ragged over a free-list with holes**, serialize it as `maxBonds`-strided dense blocks keyed by the same alive-mask + `highWater` as the agent table, and **remap partner ids** if slots compact on save (the ragged + free-list + remap interaction is genuinely new, *not* a clone of #41). **Validate on load** — length matches `liveAgentCount`, every `partnerId` in `[0, highWater)`, *alive*, and `partnerEpoch` current — and **reject loudly** (no try/catch around deserialize → silent whole-load abort, the CB doc's §13.1 #4 / CPM §12.3 hazard).
- **The dangling-bond / free-list ABI (a silent-corruption hazard the bond tier introduces — the critique caught this, and it is as dangerous as the §3.4 division triple-hazard).** The CB free-list recycles a dead agent's slot for a new agent, but a bond stores a raw `partnerId`; a surviving bond pointing at a recycled slot would silently spring to a *stranger*. Three mandatory guards: (1) a **slot epoch/generation counter** bumped on every recycle, stored in the bond as `partnerEpoch` and checked against the partner's live epoch on every read (mismatch = stale → skip + mark-for-break); (2) an explicit **"on death, break all bonds to *and* from this agent"** structural rule (a dying agent must scrub its partners' back-references, not just its own list); (3) a **per-step stale-partner sweep** (not only on-load — deaths happen at runtime).
- **Stability invariant (state it, don't assume it):** an attractive Hookean bond `λ(l−L)` with no floor pulls `l→0` and blows up `r̂` as two bonded centres coincide. The model relies on the CB soft-sphere **repulsion dominating attraction at short range** — make it an explicit required invariant (repulsion stiffness ≥ max bond `λ` near contact), or bonds collapse cells onto each other.

### 5.2 Mutation timing — bonds mutate in the post-step STRUCTURAL phase, single store (sync-only in v1)

The CB doc settled that center-based is **synchronous** — agents read a frozen old-position snapshot, write new (CB §4). The critique corrected an earlier over-statement here: a **separate per-step bond double-buffer is NOT required** in a sync overdamped engine, because —

- **Bonds are READ during the force pass and MUTATED only AFTER it, in the post-step structural phase.** `FormBond`/`BreakBond`/division-reattach run on the *settled* state once forces are integrated and positions committed — exactly like the CB doc's division-append on settled state (CB §6.4). A **single structurally-mutated bond store** therefore suffices; mutations become visible only to the *next* step's force pass. (The [asyncWriteHazard.ts](../src/modeler/vpl/compiler/asyncWriteHazard.ts) precedent shows *why* a mid-pass mutation read back by the same pass would corrupt — the sync design sidesteps it by deferring all bond mutation to the structural phase; a real write-buffer becomes necessary only for a future async/parallel variant, GraphCA §5/§7.4.)
- **Async is OUT for v1.** GraphCA §7.4 flags that mutable topology under async needs conflict semantics (two agents forming/breaking the same bond non-commutatively). v1 is sync-only — consistent with the CB doc forcing sync (CB §13.1 #6).
- **Hysteresis is mandatory anti-flicker.** A bond that forms at distance `d < d_form` and breaks at `d > d_break` with `d_form < d_break` (the λ₂≥λ₁ trick, GraphCA §7.4; Nowotny-Requardt 2006) — without it, a bond at the threshold toggles *every step*, thrashing the topology and the renderer. **Form and break thresholds must differ** by construction.

### 5.3 The force pass iterates TWO sets

The CB doc's force pass (CB §6.1) gathers distance candidates. Bonds add a **second iteration**:

```
Fnet = 0
for j in distanceNeighbours(i):           # CB doc — soft-sphere repulsion+adhesion
  Fnet += F_softsphere(d_ij) · r̂_ij
for k in bondList(i):                      # NEW — persistent bonds
  l = ‖position[partner_k] − position[i]‖
  Fnet += λ_k · (l − L_k) · r̂_ik          # FocalPointPlasticity spring; vector reduction (CB Impact #24a)
  if l > MaxDistance_k:  markBondForBreak(i, k)   # into the WRITE bond buffer
velocity[i] = Fnet / η + migration + Langevin
position_new[i] = position_old[i] + Δt · velocity[i]
```

The per-bond spring force is the **same vector reduction `Σ F·r̂`** the CB doc already calls genuinely-new emit (CB Impact #24a) — bonds reuse it over the bond list. The only new emit beyond the CB doc is the **bond-list iteration** (a ragged loop over the persistent bond array, structurally the GraphCA stride→offset emit the variable-degree neighbour path already needs) and `GetNeighborPosition` resolving a *bond partner's* continuous coords (the CB doc's `GetNeighborPosition` over a different index source). `Δt` clamping against the monotonicity bound (CB §6.3) now also accounts for bond stiffness `λ` in `F(r₀)` — stiff bonds shrink the stable step, re-evaluate on parameter change.

### 5.4 FORM / BREAK / reattach emit reuses the `MoveSelfToNeighbor` template

The three structural bond ops have a directly reusable emit precedent. [`MoveSelfToNeighborNode.ts:70-95`](../src/modeler/vpl/nodes/MoveSelfToNeighborNode.ts) is the **canonical "resolve a target neighbour index, guard it valid, read-modify-write the write buffer" shape**:

```js
const niLocal = `_msn_ni_${_nodeId}`;
lines.push(`const ${niLocal} = (${ni}) | 0;`);          // resolve target
lines.push(`if (${niLocal} !== ${0x80000000|0} && ${nbr} < total) {`);  // guard
  lines.push(`  w_${attrId}[${nbr}] = w_${attrId}[idx];`);              // RMW into write buffer
lines.push(`}`);
```

`FormBond`, `BreakBond`, and division-reattachment follow this exact shape — resolve the partner agent id, guard it valid + alive + under `maxBonds`, then write the bond record into the **write bond buffer** (not positions). The guard gains a `maxBonds`-overflow rejection (surface, don't wrap). This is the lightest possible new emit — a structural reuse of the codebase's most structural existing node.

---

## 6. Mechano-chemical feedback — first-class, the autonomy layer (tier IV)

Tiers I-III give a glued, dividing aggregate that grows along mechanical axes. **Tier IV is what makes morphogenesis *autonomous* — branching/tubulation emerge from coupling, not a script.** All three primary papers converge here: the rule must *sense the shape it is building and steer*. This is the **closed loop** Nelson and Vikran/Hirashima both center on, and the **Turing field** Okuda/Eiraku couples to growth.

### 6.1 The reaction-diffusion field — reuse the CB doc's Phase-5 field + the Gray-Scott Laplacian

The CB doc already scoped a chemical microenvironment as its Phase-5 first post-MVP addition: a coarse Cartesian field cells secrete into and sense, reusing `gridWidth/gridHeight` as field-voxel resolution and the existing per-site float SoA + `float64` round-trip (CB §5.3, §2.5, Impact #46). **This delta adds only the two coupling nodes and the Turing reaction:**

- **`SecreteToField` / `SampleField`** — scatter a secretion into the agent's voxel; gather the local value + gradient `∇c` at the agent's continuous position. (The CB doc named these `SecreteToField`/`SampleField` in its Phase-5 node list, §8 — this delta makes them tier-IV-first-class.)
- **The diffusion + reaction pass reuses GenesisCA's existing Gray-Scott machinery** — [`scripts/gen-grayscott.mjs`](../scripts/gen-grayscott.mjs) already proves the node-graph + 3-target compiler express a Laplacian + reaction on a grid. Okuda's discrete Gierer-Meinhardt is *the same shape*: per cell, `GetNeighborsAttribute → (concentration-difference × shared-boundary-area) → Aggregate.Sum` is the diffusive flux; the reaction is Hill/quadratic arithmetic nodes; Euler-step two float attributes (activator + inhibitor). **Area-weighted graph-Laplacian diffusion** (flux ∝ shared-boundary area / contact area of overlapping spheres) makes *geometry feed back into chemistry for free* — exactly Okuda's coupling.
- **Two opposite branching logics** (Nelson) ship as presets: **chemoattraction** (grow toward field max — stereotyped, lung/trachea FGF) vs **autocrine chemorepulsion** (branch at field min to maximize spacing — non-stereotyped, mammary TGFβ1). Both are a `SampleField → Compare → DivideCell`/migration-bias chain.

### 6.2 The (γ, χ) morphology knob — a single powerful design dimension

Okuda/Eiraku's central result: the **ratio of patterning rate γ to deformation rate 1/τ_cycle** selects the morphology — low γ → **branching**, mid γ → **tubulation**, high γ → **undulation**; χ = µᴬ/µᴵ sets feature size (tube diameter ∝ χ^¼·φ^½). Surfacing this **single ratio as a user-facing morphology slider** is a cheap, powerful authoring dimension — one bounded model attribute that walks the user through the three emergent regimes. (The two-timescale solver Okuda needs — many chemistry sub-steps per mechanics step, topology/reconnection checks on a coarse interval — maps onto a configurable inner-loop count, which the CB doc's driver already contemplates.)

### 6.3 Curvature feedback — the geometry sense→act→re-sense loop (Vikran/Hirashima)

Curvature is the *master* geometric cue, and it is a **per-cell SENSED attribute** computable in center-based mode from the bond/neighbour fan:

- **`GetCurvature`** — estimate local boundary curvature from the spread/anisotropy of bond-partner offset vectors (a circle/plane fit, or angle-deficit over the neighbour fan). Provide **lateral** (the cell's own neighbour-ring bend) and, in field/substrate models, **topographical** (substrate) curvature as separate channels (the paper distinguishes them).
- **The bent-beam strain rule** (a pure value node): convex side → **stretched/tensile**, concave → **compressed**. Sign(curvature) → a strain attribute downstream rules branch on (proliferation up under tension, extrusion up under compression).
- **The mandatory time-lag/hysteresis (the single easiest-to-miss subtlety).** Vikran/Hirashima is emphatic: the curvature→ERK→apical-actin loop is a **stabilizing negative feedback** (high positive curvature recruits actin that *reduces* it), and what makes morphogenesis **repeat rather than equilibrate** is the **F-actin memory/hysteresis** — a finite actuator retention time (≈1/γ) with an *optimal window* — that *lags* the fast sensor. **A naive symmetric negative-feedback implementation just FLATTENS and stalls — it never repeats.** Implement as **two coupled per-cell attributes**: a *fast sensor* (`signal = f(curvature)`, saturating in a few steps) and a *slow leaky-integrator actuator* that lags it (polymerize when sensor high, slowly decay) and feeds a force/length change. The lag is what makes branching *repeat* rather than equilibrate. This is a Local-Variable / per-cell-attribute pattern GenesisCA already supports — but the **explicit time delay must be authored**, and the curvature feedback must NOT be modelled as a Turing RD system (the paper has no Turing mechanism — it is an excitable curvature-gated loop + an externally-sourced FGF; do not conflate with §6.1's Turing field).
- **Passive lateral-curvature propagation is FREE** in a force-based engine: bending the tip moves cells, the neighbour geometry updates, and the flank cells' `GetCurvature` rises next step — the cycle restarts with no special rule. This is exactly the self-organization Vikran/Hirashima argues for, and it falls out of tiers I+II+IV automatically.

### 6.4 The self-organization design axiom (a UX principle)

Both reviews state it almost as a spec: **the regulated quantity must be the same quantity the cell senses and acts on, inside one closed loop** (Vikran/Hirashima), and **geometry sculpts the fields that instruct the cells that reshape the geometry** (Nelson). The authoring implication: ship a **"curvature-control" / "field-control" macro** that wires sense → act → re-sense on the same attribute — the robustness-to-noise recipe, and a good template for a no-code morphogenesis authoring pattern. (Differential adhesion — Nelson/Steinberg — is already the `lookupTable` `tag×tag` matrix; cell sorting falls out for free, and bonds *lock* the sorted state.)

---

## 7. Subsystem Impact Map — the DELTA on the CB doc's 50 rows

**This table lists ONLY what the bond graph + geometry-driven division + field/curvature add *beyond* the CB doc's Impact Map (its §11, rows #1-50).** Everything in the CB doc (agent tier, force driver, `maxCells`/free-list, distance-neighbour rebuild, position double-buffer, division/death, entity renderer, mode-wiring template, `lookupTable` adhesion, serialization, reinit guard, gating) is the prerequisite substrate — **reused as-is, not relisted.** Legend: ✅ reuse · ✏️ modify · ➕ new · 🚫 gate-off · ⚠️ silent-corruption hazard.

### Bond-graph tier (the SDCA delta)
| # | Subsystem | File / symbol | Change | Grounding / hazard |
|---|---|---|---|---|
| D1 | **Persistent ragged bond store** (per-agent `maxBonds` array `{partnerId, L, λ, typeLabel, strength}`, SoA, wasmMemory-viewed) | new worker tier, sibling to the CB agent SoA ([initGrid, sim.worker.ts:750](../src/simulator/engine/sim.worker.ts)) | ➕ | the GraphCA SDCA/PCSR tier (§2.8); **NOT** the CB distance list (that's recomputed; bonds persist) |
| D2 | **Post-step structural bond mutation** (single store; form/break/reattach on settled state — *not* a separate per-step double-buffer, §5.2) | force driver (extends CB §6.1) | ➕ | a real write-buffer is needed only for a future async/parallel variant ([asyncWriteHazard.ts](../src/modeler/vpl/compiler/asyncWriteHazard.ts)) |
| D3 | **`FormBond` / `BreakBond` flow nodes** (resolve partner, guard alive + `maxBonds`, write bond buffer) | new node files; emit template = [MoveSelfToNeighborNode.ts:70-95](../src/modeler/vpl/nodes/MoveSelfToNeighborNode.ts) | ➕ | reuses the resolve→guard→RMW-write-buffer shape; reject (never wrap) on overflow |
| D4 | **`maxBonds` ceiling + overflow rejection** | bond store + structural events | ➕ ⚠️ | the `maxCells` policy (CB §13.1); Amphiphile-NI-poisoning class |
| D5 | **Hysteresis (form `d_form` < break `d_break`)** | force/structural pass | ➕ ⚠️ | mandatory anti-flicker (GraphCA §7.4 λ₂≥λ₁); without it bonds toggle every step |
| D6 | **Per-bond spring force in the vector reduction** | extends CB Impact #24a (`Σ F·r̂`) | ✏️ | bonds = a second iteration source over the CB doc's already-new vector emit |
| D7 | **Bond-list iteration emit** (ragged loop over the persistent array) | 3 compilers | ➕ | GraphCA stride→offset emit; lockstep JS/WASM/WebGPU |
| D8 | **Bond serialization + load validation** (base64; `maxBonds`-strided over the free-list; partner-in-range + alive + epoch; partner-id remap on compaction) | extends CB Impact #41 (`SimulationState` agent table) | ✏️ ⚠️ | ragged+free-list+remap is **new**, not a #41 clone; reject loudly (CB §13.1 #4) |
| D8b | **Dangling-bond / free-list ABI** (`partnerEpoch` slot-generation tag + "break all bonds on death" + per-step stale sweep) | bond store + death event | ➕ ⚠️ | **silent-corruption class** — a recycled dead slot re-points a spring to a stranger (§5.1) |
| D8c | **Initial-bond seeding** (start bonded / bond-on-first-contact / import a seed topology) | seeding (extends CB `seedAgents`) | ➕ | the "glues into chains" demo presupposes a t=0 bonding rule |
| D8d | **Bond-graph indicators** (mean degree, bond count, connected-component count) | indicators (CB reuse) | ➕ | required by the "validate statistically" mandate (§8) |
| D8e | **Bond inspector sub-table + manual glue/cut brush** (pick two agents to bond/break) | inspector + a 3rd interaction mode (CB point-pick/place-agent) | ➕ | bonds add an authoring + introspection surface neither CB mode covers |
| D8f | **Bond render in recording/HTML-export + 3D bond primitive** (line segments now; tubes + depth-sort + line-pick in 3D) | recorder/export + the CB instanced-sphere renderer | ➕ | the GIF/WebM/presentation path captures the blit today; the vector bond layer must be included |
| D9 | **Bond-spring matrix** (`λ`, `L` per type-pair) | existing `lookupTable` (2-channel) | ✅ | the CB doc's `lookupTable` adhesion matrix (CB §5.2), two value channels |
| D10 | **Bond render layer** (draw bonds as line segments between agent centres) | extends the CB `drawAgents()` (CB Impact #27) | ➕ | a line/path primitive (the CB doc's vector-overlay primitive, #33, covers it) |
| D11 | **Async gated OFF for bonds (v1)** | worker mutual-exclusion net (CB Impact #45) | 🚫 | mutable topology under async needs conflict semantics (GraphCA §7.4) |

### Geometry-driven division delta (extends CB division Impact #10)
| # | Subsystem | File / symbol | Change | Grounding / hazard |
|---|---|---|---|---|
| D12 | **Division-axis computation** (Σ outer-products over bonds → 2×2/3×3 eigenvector = Hertwig long-axis / tension) | extends CB §6.4 `divide()` | ➕ | Hertwig 1884 + Minc 2011 + Okuda "normal to longest axis"; closed-form 2×2 eigensolve, engine-owned |
| D13 | **`GetBondDegree` / `SummedBondStrength` / `NeighbourDensity` read nodes** (axis + predicate inputs) | new node files; GraphCA `GetDegree` template (§2.2) | ➕ | **first-class, NOT `Average`-macro** (§9 gotcha) |
| D14 | **Geometric bond reattachment at division** (each partner → nearer daughter; one new daughter-daughter bond) | division structural event | ➕ ⚠️ | **riskiest piece** — mutates partners' bond lists + `maxBonds` overflow + bond double-buffer at once (§3.4) |
| D15 | **Shape-vs-tension axis weighting** | bounded model attribute (CB §5.2) | ✅ | the Scarpa/Mao 2017 knob; reuses bounded-float slider |
| D16 | **Morphogen split at division** (concentration-preserving; count splits with volume) | division event (only with tier IV) | ➕ | Okuda inheritance rule; count-vs-concentration caution |

### Mechano-chemical field + curvature delta (extends CB Phase-5 field Impact #46)
| # | Subsystem | File / symbol | Change | Grounding |
|---|---|---|---|---|
| D17 | **`SampleField` / `SecreteToField` nodes** | new node files (CB §8 named them) | ➕ | Okuda activator-as-mitogen; Nelson source/sink |
| D18 | **Discrete Gierer-Meinhardt reaction + area-weighted diffusion** | reuses the [Gray-Scott Laplacian](../scripts/gen-grayscott.mjs) | ✅/✏️ | `GetNeighbors → (Δc × contactArea) → Aggregate.Sum` flux + Hill reaction |
| D19 | **`GetCurvature` (lateral + topographical channels)** + bent-beam strain node | new node files | ➕ | Vikran/Hirashima; estimate from bond-fan anisotropy |
| D20 | **Curvature-feedback macro** (fast sensor + slow hysteretic actuator) | Local-Variable / per-cell-attribute pattern (existing) | ➕ ⚠️ | **mandatory time-lag** — symmetric feedback just flattens + stalls |
| D21 | **(γ, χ) morphology slider** | bounded model attribute | ✅ | Okuda undulation/tubulation/branching knob |

### Mode-wiring (a near-mechanical clone — same as the CB doc, listed for completeness)
| # | Subsystem | File / symbol | Change | Grounding |
|---|---|---|---|---|
| D22 | `bondGraph?`/`centerBased?` sub-object extension + `UPDATE_*` reducer + cascade + default-fill | [ModelContext.tsx:188,892,1242](../src/model/ModelContext.tsx); schema templates [types.ts:444-483](../src/model/types.ts) | ➕ | the `VariegatedCellsConfig`/`UPDATE_VARIEGATED_CELLS` recipe verbatim |
| D23 | Bond-label palette (type-pair adhesion classes) | clone of [`FaceLabelPalette`, types.ts:444](../src/model/types.ts) | ➕ | structural template reuse |
| D24 | `requirements.bondGraph?` capability gate + panel | clone of `requirements.variegated` (CB §8) | ✏️ | mechanical clone |

**The reuse headline (calibrated):** the bond graph adds **one persistent ragged adjacency tier + its double-buffer + form/break/reattach emit (reusing the `MoveSelfToNeighbor` shape) + a hysteresis rule** on top of the CB doc; division adds **an axis eigensolve + geometric reattachment + new read nodes**; the field/curvature tier adds **two coupling nodes + the Gray-Scott reaction + a curvature node + the hysteretic-actuator macro**. The per-bond force *reuses* the CB doc's already-new vector reduction; the adhesion/bond matrix *reuses* `lookupTable`; the field *reuses* Gray-Scott; the mode-wiring *reuses* the variegated recipe. **The genuinely new work concentrates in: the persistent bond tier (D1-D8), the geometric division-rewrite (D12, D14), and the curvature hysteresis loop (D19-D20).**

---

## 8. Phased plan (if it were built) — bonds as a wave on top of the CB doc

**Build the CB doc's Phases 0-4 first** (agent tier, force driver, distance neighbours, division, death — the substrate). Then layer this delta as a **mutable-topology wave**, sequenced so each phase has a visible demo.

**Scope split (resolving the critique's "v1 ambiguity").** **v1 = the glued-divide differentiator** (B1-B2, tiers I-III, **NO field**) — cells glue into chains/clusters and divide along their tension axis. **v2 = autonomy** (B3-B4, the reaction-diffusion field + curvature feedback) — branching/tubulation emerge from coupling. The v1 headline is deliberately **not** gated on the open field-scope question (§9.2): tiers I-III already stand alone as a visible differentiator over the CB doc's gas-of-spheres.

- **Phase B0 — decisions (§10).** Confirm (A) center-based+bonds over (B) vertex; bonds sync-only v1; `maxBonds` ceiling + reject-on-overflow; geometry-driven (not free) bond partition; hysteresis mandatory; engine-agnostic IR commitment.
- **Phase B1 — the bond tier (v1 core).** Persistent ragged bond store + post-step structural mutation + the **dangling-bond ABI** (`partnerEpoch` + break-on-death + stale sweep, D1-D2/D8b); initial-bond seeding (D8c); the bond-spring matrix via `lookupTable` (D9); `FormBond`/`BreakBond` nodes (D3) with `maxBonds` rejection (D4) + hysteresis (D5); per-bond force in the vector reduction (D6-D7); bond render + inspector/glue-cut brush (D10/D8e) + bond-graph indicators (D8d). **Demo: a 2D soft-cell aggregate that GLUES into chains and clusters** (differential adhesion sorts; bonds lock the sorted state — visibly distinct from the CB doc's gas-of-spheres).
- **Phase B2 — geometry-driven division-as-rewrite (v1 headline). ★ the centrepiece.** The **tension-proxy** division-axis eigensolve + degenerate fallback (D12, §3.1 — faithful Hertwig long-axis would need (B) vertex) + `GetBondDegree`/`NeighbourDensity`/`SummedBondStrength` reads (D13) + geometric bond reattachment (D14) with the post-division `Δt`+`maxBonds` guard (§3.4); tension-vs-density-gap weighting (D15). **Demo: a glued cluster that GROWS and DIVIDES along its tension axis, bonds inherited by geometry** — the tissue elongates along a mechanical axis instead of ballooning. *Tiers I-III with no field — the minimal v1 differentiator.*
- **Phase B3 — the field + chemotaxis branching (v2 — autonomy).** `SampleField`/`SecreteToField` (D17) + Gierer-Meinhardt/Gray-Scott reaction (D18) + the two branching presets (chemoattract/chemorepel). **Demo (the v2 autonomy headline): the v1 aggregate now BRANCHES under a chemotactic field** — morphogenesis from coupling, not a script. *Gated on the field-scope decision (§9.2); not part of the v1 differentiator.*
- **Phase B4 — curvature feedback + the (γ,χ) knob.** `GetCurvature` + bent-beam strain (D19) + the fast-sensor/slow-actuator hysteresis macro (D20) + the morphology slider (D21). **Demo: repetitive branching/tubulation that re-fires from passive curvature propagation** (the Vikran/Hirashima loop).
- **Phase B5 — WebGPU bonds + 3D.** Bonds ride the CB doc's strong WebGPU fit (per-agent bond gather is parallel); 3D is the dimensionality switch (bonds + axis gain a z) behind the CB doc's new instanced-sphere renderer.
- **(Deferred / separate decision) — the vertex engine (B)** behind the shared IR, only if the goal drifts to shape-driven sheet mechanics (§2.B).

Validate **statistically**, not bit-exact (WGSL f32 + per-cell PCG preclude parity — the CB doc's Gray-Scott tradeoff): sorting/cluster metrics, division-axis alignment vs the tension field, branch count/spacing vs the (γ,χ) regime, Okuda/Nelson canonical morphologies as built-in examples.

---

## 9. Risks, open questions, and the substrate decision

### 9.1 Silent-corruption hazards (the bond-graph delta on the CB doc's §13.1)
1. **The division reattachment triple-hazard (riskiest).** Division mutates partners' bond lists *and* creates the daughter-daughter bond *and* seeds overlapping daughters — hitting `maxBonds` overflow, the stale-partner/epoch invariants, and the post-division `Δt` overshoot **simultaneously** (§3.4, D14). Mutate in the post-step structural phase only; on `maxBonds` overflow during reattach **reject the whole division** (never leave a partner half-rewired); clamp `Δt ≤ Δt*_mono` against the *combined* worst case (max repulsion stiffness + max bond `λ` + post-division overlap), and serialize the case where a partner is **also** dividing this step.
2. **Bonds are NOT covered by the CB distance-neighbour reuse.** Treating bonds as "just another neighbourhood" loses persistence across steps — they are stored state, not a per-step query (D1). The CB doc's distance list is recomputed; bonds must survive.
3. **The dangling-bond / free-list ABI** (D8b) — a recycled dead slot silently re-points a bond to a stranger; needs the `partnerEpoch` slot-generation tag + break-bonds-on-death + a per-step stale sweep (§5.1). (Bond mutation is deferred to the post-step structural phase, so **no** separate per-step double-buffer is needed — §5.2.)
4. **`maxBonds` overflow must reject + surface, never wrap** (D4) — the `maxCells`/Amphiphile-NI-poisoning class.
5. **Hysteresis is mandatory** (D5) — equal form/break thresholds flicker every step.
6. **Curvature feedback must be asymmetric/hysteretic** (D20) — a symmetric negative-feedback loop just flattens and stalls; the time-lag actuator is what makes it repeat (the single easiest-to-miss modelling subtlety, per Vikran/Hirashima).
7. **`NeighbourDensity`/`GetBondDegree`/curvature must be first-class nodes, NOT an `Average` macro** — `Average` equals density only if the array length equals the degree; a degree-tolerant first-class node is required (GraphCA §12.6 / §6.6).
8. **Field/division concentration split** (D16) — be explicit about count-vs-concentration; conserving concentration means splitting molecule count with volume (Okuda).
9. **Short-range stability invariant** — an attractive bond with no repulsion floor collapses bonded centres together (`l→0`, `r̂` blows up); the soft-sphere **repulsion must dominate attraction at short range** (§5.1).

### 9.2 Open questions for the user
- **The substrate decision (the headline open question).** Confirm **(A) center-based + explicit bond graph FIRST** (recommended — fits the IR, GPU-native, 3D-clean, delivers aggregates/chains/clusters/branching, but **no true cell shape**) vs jumping to **(B) vertex** (true deformable shape + gap-free tiling + real curvature, but the per-cell-step compiler *partially breaks* on the shared-vertex DOF — §2.B). Recommendation: (A) first, (B) as a deferred third engine behind the shared IR *only* for sheet mechanics. **Sharpened by the critique:** (A) faithfully delivers *glued topology + **tension-axis** (not shape-axis) division + chemotaxis branching* — but **not** the faithful geometric long-axis (Hertwig) division *or* true deformable shape/curvature, both of which need (B) (§3.1). So if **faithful geometry-driven long-axis division is non-negotiable** for you, that is the argument to scope (B) vertex as a **deliberate second engine** sooner, not a vaguely-deferred third.
- **Bond mutation under async.** Confirm sync-only v1 (recommended); async mutable topology (conflict semantics) is a later decision.
- **Division axis source.** In (A): the **tension-proxy** axis (principal eigenvector of the stretched-bond tension tensor) with a **density-gap fallback** for relaxed/compressed cells (§3.1) — the faithful *shape* long-axis is not available without (B). Optional Besson-Dumais stochasticity. Confirm.
- **Field tier scope (resolved as a recommendation).** **v1 = the glued-divide demo (tiers I-III, no field); v2 = the field + autonomous branching** (§8). The field is where morphogenesis becomes *autonomous*, so it is the natural first v2 addition — but v1 stands alone, so the commitment need not bundle it. Confirm the split.
- **Curvature feedback scope.** Full sense→act→re-sense hysteresis loop (tubulation/repetitive branching) vs curvature-as-a-read-only-input first. The hysteresis loop is the autonomy generator but the hardest to author correctly.
- **The new authoring/UX subsystems bonds require (don't forget these).** Initial-bond **seeding** (start-bonded vs bond-on-contact vs import a seed topology), bond-graph **indicators** (mean degree / bond count / connected-component count — needed for statistical validation), a manual **glue/cut brush** + a bond sub-table in the **inspector**, **save/load** of the ragged bond layer over the free-list, and **recording / HTML-export / 3D** of the line-segment bond layer (D8c-D8f). None exist in the CB doc; each is net-new.
- **The engine-agnostic IR commitment** (shared with both prior docs) — confirm, since it is the prerequisite for ever adding (B) and it is already non-trivial work (the CB doc proved the current IR bakes lattice geometry).

---

## 10. Verified bibliography (the delta — the 3 papers + the division-plane & bond/vertex/L-system lineage)

> The center-based substrate bibliography is in [INVESTIGATION_CENTER_BASED.md §14](INVESTIGATION_CENTER_BASED.md) (Meineke, Drasdo/Höhme, PhysiCell, CBMOS, Mathias 2020, ya||a, BioFVM, …) and is not repeated. Below are **only** the works grounding *this* delta. Flags: ✓ confirmed (venue/DOI verified); ~ uncertain (paper real, some metadata unverified — verify page/issue before citing).

**The three primary papers (mechano-chemical morphogenesis)**
- ✓ **Okuda, Miura, Inoue, Adachi & Eiraku (2018)** "Combining Turing and 3D vertex models reproduces autonomous multicellular morphogenesis with undulation, tubulation, and branching." *Scientific Reports* 8:2386. doi:10.1038/s41598-018-20678-6. — *The synthesis blueprint: a 3D vertex mesh (shared faces = topology) bidirectionally coupled to a discrete Gierer-Meinhardt Turing field; activator→growth→division→deformation→re-patterning; division plane "normal to the longest axis," neighbour faces partitioned by side of plane; (γ,χ) selects undulation/tubulation/branching. Caution: equations are OCR-garbled in the source — verify signs/exponents against the PDF; it is a VERTEX model, so its mechanics map onto §2.B not §2.A; division-mechanics details defer to Okuda 2013 refs 30/38.*
- ✓ **Vikran & Hirashima (2025)** "Curvature feedback for repetitive tissue morphogenesis — Bridging algorithmic principles and self-regulatory systems." *Seminars in Cell & Developmental Biology* 173:103633. doi:10.1016/j.semcdb.2025.103633. (open access) — *Conceptual review: morphogenetic motifs (bend/twist/elongate/topological-transform) as L-system-like rewrites; curvature as the master sense→act→re-sense cue; the MANDATORY time-lag/hysteresis (slow F-actin actuator lagging the fast ERK sensor) that makes branching repeat vs stall. Caution: NO equations — for the quantitative model go to primary ref Hirashima & Matsuda 2024 Curr. Biol. 34:683; NO Turing mechanism (externally-sourced FGF + excitable curvature-gated signal — do not import a Turing assumption here); abstract the named molecules to generic fast-sensor/slow-actuator variables.*
- ✓ **Nelson, C. M. (2009)** "Geometric control of tissue morphogenesis." *Biochim. Biophys. Acta (Mol. Cell Res.)* 1793(5):903–910. doi:10.1016/j.bbamcr.2008.12.014. — *Conceptual review: geometry→field→cell→geometry closed loop; source/sink geometry (not biochemistry) dominates morphogen-gradient SHAPE; chemoattraction (grow toward max) vs autocrine chemorepulsion (branch at min) as two branching logics; stress maxima = growth maxima, deformation precedes proliferation; differential adhesion (Steinberg) = a tag×tag matrix → sorting; anisotropic neighbour stiffness turns isotropic forces into anisotropic shape. Caution: NO equations — pair with a quantitative force/division-axis/RD source for constants.*

**Division-plane laws (the geometry-driven axis)**
- ✓ **Hertwig (1884)** the long-axis rule — division plane ⟂ the longest interphase axis (frog-egg compression). *(Historical; attested in Wikipedia + PMC reviews.)*
- ✓ **Minc, Burgess & Chang (2011)** "Influence of Cell Geometry on Division-Plane Positioning." *Cell* 144(3):414–426. PMID 21295701. — *The quantitative shape→division-axis mapping (length-dependent astral-MT pulling); the axis = principal eigenvector of cell geometry.*
- ✓ **Bosveld et al. (2016)** "Epithelial tricellular junctions act as interphase cell shape sensors to orient mitosis." *Nature* 530(7591):495–498. PMID 26886796. — *Neighbour-packing geometry (tricellular junctions) is the spindle-orienting sensor.*
- ✓ **Wyatt et al. (2015)** "Emergence of homeostatic epithelial packing and stress dissipation through divisions oriented along the long cell axis." *PNAS* 112(18):5726–5731. — *Long-axis divisions dissipate stress → homeostatic packing (the stress-relaxation feedback demo).*
- ✓ **Campinho et al. (2013)** "Tension-oriented cell divisions limit anisotropic tissue tension during zebrafish epiboly." *Nature Cell Biol.* 15(12):1405–1414. — *Divisions orient along, and relax, the tension field.*
- ✓ **Scarpa/Mao et al. (2017)** "E-cadherin and LGN align epithelial cell divisions with tissue tension independently of cell shape." *PNAS* doi:10.1073/pnas.1701703114. PMID 28674014. — *Tension as a DIRECT cue that can override shape (the shape-vs-tension blend knob). ~ exact author list unverified.*
- ✓ **Nestor-Bergmann et al. (2019)** "Decoupling the Roles of Cell Shape and Mechanical Stress in Orienting and Cueing Epithelial Mitosis." *Cell Reports* 26(8):2088–2100. PMID 30784591. — *Shape principal axis ≈ local principal stress axis; orientation governed by shape, rate by stress (one orientation tensor carries both).*
- ✓ **Besson & Dumais (2011)** "Universal rule for the symmetric division of plant cells." *PNAS* 108(15):6294–6299. PMID 21383128. — *The probabilistic shortest-wall rule (∝ exp(−β·area), β≈20.6) — the optional division-axis stochasticity.*
- ✓ **Louveaux, Julien, Mirabet, Boudaoud & Hamant (2016)** "Cell division plane orientation based on tensile stress in Arabidopsis." *PNAS* 113(30):E4294–E4303. doi:10.1073/pnas.1600677113. — *Tensile stress overrides the geometric rule (mechanics+geometry as the unifying principle).*
- ~ **Cuvelier et al. (2024)** "A cytokinetic ring-driven cell rotation achieves Hertwig's rule in early development." *PNAS* 121(26):e2318838121. — *The physical mechanism executing Hertwig's rule. ~ lead author uncertain — verify before citing the name.*
- ✓ **Errera (1888)** the minimal-area dividing-wall rule (plant analogue). *(Historical; attested in Besson & Dumais 2011.)*

**Bond / vertex / L-system computational lineage (the connection-topology & division-as-rewrite vocabulary)**
- ✓ **Ghaffarizadeh, Heiland, Friedman, Mumenthaler & Macklin (2018)** PhysiCell. *PLOS Comput. Biol.* 14(2):e1005991. — *The base center-based engine; its later spring-adhesion (`state.attached_cells` + `standard_elastic_contact_function` + automated attach/detach, v1.11–1.14) is the EXPLICIT-bond precedent — the bond-graph idea realised on force agents. ~ cite the software/changelog for the spring mechanism (a dedicated peer-reviewed "mechanics v2" paper was not confirmed).*
- ✓ **CompuCell3D FocalPointPlasticity** (Reference Manual; Swat et al. 2012 *Methods Cell Biol.* 110:325–366 ~). — *The canonical explicit-link data model: per-link target length `L`, stiffness `λ`, `MaxDistance` break, `MaxNumberOfJunctions` cap, `E = Σ λ(l−L)²`, initiator/initiated roles, create/delete-link through mitosis — structurally the closest precedent to this delta's bond graph. (Parameters confirmed from the manual; Swat et al. volume/pages ~ unverified.)*
- ✓ **Fletcher, Osterfield, Baker & Shvartsman (2014)** "Vertex models of epithelial morphogenesis." *Biophys. J.* 106(11):2291–2304. PMID 24896108. — *The vertex standard: division (insert 2 vertices), T1 (neighbour exchange), T2 (cell removal) — the §2.B substrate and the operations it would require.*
- ~ **Okuda, Inoue, Eiraku, Sasai & Adachi (2013)** "Reversible network reconnection model for simulating large deformation in dynamic tissue morphogenesis." *Biomech. Model. Mechanobiol.* 12(4):627–644. doi:10.1007/s10237-012-0430-7. — *3D vertex reconnection (the 3D T1/T2 framework); division-mechanics detail behind Okuda/Eiraku 2018. ~ volume/pages unverified (Springer auth-walled).*
- ✓ **Okuda, Inoue, Eiraku, Adachi & Sasai (2016)** "Modeling cell apoptosis … reversible network reconnection framework." *Biomech. Model. Mechanobiol.* 15(4):805–816. doi:10.1007/s10237-015-0724-7. PMID 26361766. — *The apoptosis companion (cell removal on a 3D shared-face mesh).*
- ✓ **Merks, Guravage, Inzé & Beemster (2011)** "VirtualLeaf: An Open-Source Framework for Cell-Based Modeling of Plant Tissue Growth and Development." *Plant Physiol.* 155(2):656–666. PMID 21148415. — *The closest "explicit shared boundary + geometry-driven division-as-partition" precedent: division picks an axis, builds a new shared wall, partitions the parent's wall nodes between daughters — the bond-graph version re-partitions BONDS instead of walls (§3.2).*
- ✓ **Prusinkiewicz & Lindenmayer (1990)** *The Algorithmic Beauty of Plants* (ch. 7, "Modeling of cellular layers" — map L-systems). Springer. ISBN 0387972978. (free at algorithmicbotany.org). — *The theoretical origin of division-as-graph-rewrite: a cell is a graph face, division is a rewriting production that inserts a new wall edge splitting the face. The abstract template behind §3's geometry-driven rewrite (Vikran/Hirashima's "morphogenesis = iterative L-system-like rewriting" framing rests on this).*
- ~ **Lindenmayer (1968)** "Mathematical models for cellular interactions in development I & II." *J. Theoret. Biol.* 18. — *The L-system origin (parallel rewriting of cell topology). ~ exact page numbers unverified — confirm before citing pages.*

---

*Companion: this document extends [INVESTIGATION_CENTER_BASED.md](INVESTIGATION_CENTER_BASED.md) (substrate, the 50-row Impact Map, the full center-based bibliography) and references [INVESTIGATION_GRAPH_CA.md](INVESTIGATION_GRAPH_CA.md) (the SDCA/PCSR mutable-topology tier) + [INVESTIGATION_CPM.md](INVESTIGATION_CPM.md) (the engine-agnostic-IR recommendation). Per CLAUDE.md's "illustrated plans required" rule, a formal `PLAN_*.md` + HTML mockup follow the §9.2 scope decisions. Status: research reference — no implementation planned.*

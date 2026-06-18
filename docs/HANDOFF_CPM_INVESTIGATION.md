# HANDOFF — Investigation: Cellular Potts Model (CPM) mode for GenesisCA

> **You (the next session) are being asked to do for the *Cellular Potts Model (CPM)* exactly what a previous session successfully did for a *Graph Cellular Automata* mode:** a deep, fact-checked literature dive + a subsystem-by-subsystem codebase audit + a synthesized design/Impact-Map + a polished visual presentation. This document is your runbook. Follow it.
>
> **Two reference artifacts to open first — they are your quality bar and structural template:**
> - [docs/INVESTIGATION_GRAPH_CA.md](INVESTIGATION_GRAPH_CA.md) — the detailed written investigation (literature review → conceptual model → Impact Map → visualization → phased plan → bibliography).
> - [docs/INVESTIGATION_GRAPH_CA.html](INVESTIGATION_GRAPH_CA.html) — the self-contained visual companion (inline SVG diagrams, CSS plots, an impact-map matrix, a phased timeline, a small live JS demo).
>
> Produce the CPM equivalents: `docs/INVESTIGATION_CPM.md` and `docs/INVESTIGATION_CPM.html`.

---

## 0. Mission & success criteria

Investigate how GenesisCA could gain a **CPM mode** — a new optional model mode (toggled in Properties, like Variegated Cells or Asynchronous update) that enables CPM-specific nodes/features. Deliver:
1. A thorough, **citation-verified** literature review of the Cellular Potts Model.
2. A concrete answer to **"what would we need to implement"** — grounded in the actual GenesisCA codebase (file + symbol references), as a subsystem Impact Map.
3. A clear treatment of **"how to deal with CPM's specifics"** — the energy/Monte-Carlo paradigm, extended cells, per-cell bookkeeping, and visualization.
4. A **presentable HTML** visual companion.

**Default stance: this is a research/feasibility investigation, not a commitment to build.** When the deliverables are done, summarize and *ask the user* about scope/next steps (the Graph-CA session ended with the user choosing "research only" — do the same: present, then ask, don't start coding).

> ⚠️ **The single most important warning:** **CPM is NOT a cellular automaton in GenesisCA's sense, and it is NOT a topology variant like Graph CA.** Do not assume the Graph-CA design transfers. CPM is a *stochastic energy-minimization* model on a lattice where one biological "cell" spans **many** lattice sites, and the update is **Metropolis Monte Carlo** (propose a site-copy, accept/reject by `exp(-ΔH/T)`), not a synchronous deterministic per-cell function. The genuinely hard and interesting part of this investigation is the **fit analysis**: can CPM be expressed within GenesisCA's compile-the-graph-to-a-per-cell-step architecture at all, or does it need a bespoke engine loop with the node-graph supplying only the energy (ΔH) terms? See §2 and §6.

---

## 1. Essential CPM domain primer (so you scope the research correctly)

You must internalize this before launching research, or your topic briefs will be mis-scoped. *Verify all of it during research — treat it as a seed, not gospel.*

**What CPM is.** The Cellular Potts Model (CPM), a.k.a. the **Glazier–Graner–Hogeweg (GGH)** model, is a lattice model from developmental/biophysical modeling (Graner & Glazier 1992; Glazier & Graner 1993). Each lattice **site** `x` holds a "spin" `σ(x)` = the **integer ID of the biological cell occupying that site** (`σ=0` is usually medium/empty). A **biological cell is a connected domain of many sites sharing the same ID** — cells are spatially *extended*, not one-site. Each cell ID has a **type** `τ(σ)` (e.g. "dark", "light", "medium").

**The energy (Hamiltonian) H** — the model is defined by an energy, not a transition rule:
- **Adhesion / boundary energy:** `Σ over neighbor site-pairs  J(τ(σ(x)), τ(σ(x'))) · (1 − δ(σ(x),σ(x')))` — a contact-energy `J` between the *types* of every pair of touching sites that belong to different cells. (The differential-adhesion hypothesis, Steinberg, drives cell sorting.)
- **Volume/area constraint:** `Σ over cells  λ_V · (v(σ) − V_target(σ))²` — each cell is pushed toward a target volume.
- **Surface/perimeter constraint (optional):** `Σ over cells  λ_S · (s(σ) − S_target(σ))²`.
- **Optional terms:** chemotaxis (`−μ · Δ(chemical field)` along the copy), persistent motion / Act model, length constraint, connectivity, cell growth/division/death.

**The dynamics — modified Metropolis Monte Carlo:**
1. Pick a random **source** site `x` and a random **neighbor target** `x'` (copies happen only where `σ(x) ≠ σ(x')`, i.e. at cell boundaries).
2. Propose copying `σ(x) → σ(x')` (the source cell tries to extend into the target site, the target's cell loses a site).
3. Compute `ΔH` of that single copy (local for adhesion; needs the cells' *current* volume/perimeter for the constraint terms).
4. **Accept** with probability `P = 1 if ΔH ≤ 0, else exp(−ΔH / T)`; otherwise reject.
5. One **Monte Carlo Step (MCS)** = `N` copy attempts (`N` = number of sites). `T` = "temperature" = membrane-fluctuation amplitude.

**Why this breaks GenesisCA's assumptions (the fit tension you must analyze):**
- **One biological cell = many lattice sites** ⇒ there is a *per-cell-ID object level* (type, target volume, *current* volume, *current* perimeter) that does not exist today — GenesisCA's "cell" is one site, and its only aggregate level is global *model attributes*.
- **Stochastic, asynchronous, energy-driven update** ⇒ not a synchronous deterministic per-cell function. The accept/reject depends on `ΔH`, which depends on **global per-cell quantities maintained incrementally** as sites flip.
- **Boundary-restricted copy attempts + connectivity constraint** ⇒ a different inner loop than "iterate all cells, run f."

**Closest existing GenesisCA machinery (verify these as fit hypotheses, don't assert them):**
- **Async mode** (single-buffer, `orderArray` random-order site selection, neighbor-WRITE nodes `SetNeighborAttributeByIndex` / `MoveSelfToNeighbor`) is the nearest dynamics primitive to "pick a random site, copy a neighbor's value into it."
- **`GetRandom` < probability** is the Metropolis acceptance gate.
- **The `lookupTable` attribute type** (tag×tag matrix, added for variegated chemistry) is a strong fit for the **adhesion J-matrix** (type×type contact energies).
- **Model attributes with bounds/sliders** fit `λ_V`, `λ_S`, `T`.
- **The hard gap:** the **per-cell-ID incremental bookkeeping** (each cell's current volume/perimeter updated on every accepted flip, and ΔH reading those). There is no per-cell-object accumulator level today. **This is THE central architectural question of the investigation.**
- **Rendering is *mostly reusable* (unlike Graph CA):** CPM is still a 2-D lattice, so the existing Canvas2D `colors`-buffer blit largely carries over — color each site by its cell ID or type. The new rendering work is **cell-boundary (membrane) drawing**, cell-ID/type color mappings, and optional **chemical-field overlays**, not a from-scratch renderer.
- **Artistoo** (Wortel & Textor, eLife 2021) is a TypeScript/JS CPM library that **runs in the browser** — it is the proof-of-feasibility and the single most relevant architectural reference. Study it.

---

## 2. The process that worked — replicate it exactly

The previous session used the **Workflow tool** (multi-agent orchestration; "ultracode" was on). Use the same approach. The structure: fan-out research + adversarial verification + codebase audit → synthesis → critique → you assemble the deliverables.

### 2.1 ⚠️ THE THROTTLE LESSON (do not skip — it cost two failed runs)
The first attempt launched **~11 web-heavy agents concurrently** and **every one died** with `API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited`. The cause: **web-research agents each fire many WebSearch/WebFetch round-trips, so even a handful running at once spikes the request rate and trips a transient server-side throttle.** What finally worked:
- **Codebase-audit agents:** run in **parallel but ≤5 at a time** (they read files, fewer API round-trips — this wave succeeded).
- **Literature research agents:** run **FULLY SEQUENTIAL — one web-research agent at a time** (a `for` loop with `await` inside, not `parallel()`/`pipeline()`). This was the recovery that succeeded for all 6 topics.
- **Stagger the two waves** (codebase first, then literature) so peak concurrency stays low.
- **Resilience:** `agent()` returns `null` on a terminal API error, so a sequential loop that pushes only truthy results survives partial failures. If a wave still fails on the throttle, **wait ~2 minutes** (a background `sleep`) and re-run — failed agents just re-run.

### 2.2 The phase structure
1. **Inspect (parallel ≤5):** one agent per codebase subsystem (§5), structured output.
2. **Research (SEQUENTIAL):** one agent per literature topic (§4), structured output; immediately followed by a **Verify** agent that independently re-checks every citation + the load-bearing claims (this is what kept the Graph-CA bibliography honest — LLMs hallucinate citations).
3. **Synthesize:** one strong agent takes all findings → the full design draft (the §7 .md outline).
4. **Critique:** one skeptical agent reviews the draft for codebase-accuracy errors, missing subsystems, literature misstatements, and underspecified decisions.
5. **You (main loop):** firsthand-verify the load-bearing codebase claims (§8), then write `INVESTIGATION_CPM.md` and `INVESTIGATION_CPM.html`, folding in the critique.

### 2.3 Ready-to-run workflow script
Drop this into the **Workflow** tool (adjust if your harness differs). The literature loop is deliberately sequential. **Tell agents to load `WebSearch`/`WebFetch` via ToolSearch (`"web search fetch"`) first.**

```javascript
export const meta = {
  name: 'cpm-investigation',
  description: 'Research Cellular Potts Model literature + audit GenesisCA subsystems to design a CPM mode',
  phases: [
    { title: 'Inspect',   detail: 'audit GenesisCA subsystems a CPM mode would touch (5, parallel)' },
    { title: 'Research',  detail: 'CPM literature, ONE web-research agent at a time (throttle-safe)' },
    { title: 'Verify',    detail: 'adversarially verify citations & claims, sequential' },
    { title: 'Synthesize',detail: 'design the CPM mode end-to-end' },
    { title: 'Critique',  detail: 'completeness/correctness critic' },
  ],
}

const LIT_SCHEMA = { type:'object', additionalProperties:false, properties:{
  topic:{type:'string'}, summary:{type:'string', description:'3-5 dense paragraphs'},
  keyConcepts:{type:'array', items:{type:'object', additionalProperties:false, properties:{name:{type:'string'},description:{type:'string'}}, required:['name','description']}},
  keyWorks:{type:'array', items:{type:'object', additionalProperties:false, properties:{authors:{type:'string'},year:{type:'string'},title:{type:'string'},venue:{type:'string'},contribution:{type:'string'},url:{type:'string'}}, required:['authors','year','title','contribution']}},
  relevanceToGenesisCA:{type:'string'}, designImplications:{type:'array', items:{type:'string'}}, openProblems:{type:'array', items:{type:'string'}},
}, required:['topic','summary','keyConcepts','keyWorks','relevanceToGenesisCA','designImplications'] }

const VERIFY_SCHEMA = { type:'object', additionalProperties:false, properties:{
  verdicts:{type:'array', items:{type:'object', additionalProperties:false, properties:{claim:{type:'string'},verdict:{type:'string',enum:['confirmed','refuted','uncertain']},evidence:{type:'string'},correctedClaim:{type:'string'}}, required:['claim','verdict','evidence']}},
  citationCheck:{type:'array', items:{type:'object', additionalProperties:false, properties:{citation:{type:'string'},exists:{type:'string',enum:['yes','no','uncertain']},note:{type:'string'}}, required:['citation','exists']}},
  overallReliability:{type:'string'},
}, required:['verdicts','overallReliability'] }

const CODE_SCHEMA = { type:'object', additionalProperties:false, properties:{
  subsystem:{type:'string'}, summary:{type:'string'},
  keyFiles:{type:'array', items:{type:'object', additionalProperties:false, properties:{path:{type:'string'},role:{type:'string'},symbols:{type:'string'}}, required:['path','role']}},
  cpmFitAssumptions:{type:'array', items:{type:'string'}, description:'specific code that helps OR blocks CPM (one-site-per-cell, sync update, no per-cell-ID level, etc.)'},
  extensionPoints:{type:'array', items:{type:'string'}}, cpmModeImpact:{type:'string'}, gotchas:{type:'array', items:{type:'string'}},
}, required:['subsystem','summary','keyFiles','cpmFitAssumptions','cpmModeImpact'] }

const LIT_TOPICS = [ /* paste the 6 briefs from §4 here as {key, brief} */ ];
const CODE_SUBS  = [ /* paste the 5 briefs from §5 here as {key, brief} */ ];

phase('Inspect');
const codeRaw = await parallel(CODE_SUBS.map(s => () => agent(
  `You are a senior engineer auditing the GenesisCA codebase (TypeScript/React node-graph IDE for Cellular Automata; cwd = repo root). We are evaluating a new CELLULAR POTTS MODEL (CPM) mode — a stochastic energy-minimization lattice model where ONE biological cell spans MANY lattice sites and the update is Metropolis Monte Carlo (propose a site-copy, accept by exp(-dH/T)). Read the actual files. Quote symbols + file:line. Focus on how the existing engine/model maps onto (or blocks) CPM.\n\nSUBSYSTEM (${s.key}):\n${s.brief}\n\nThe "cpmFitAssumptions" array is the most important output. Return the structured object.`,
  { label:`code:${s.key}`, phase:'Inspect', schema: CODE_SCHEMA }
)));
const code = codeRaw.filter(Boolean);

phase('Research');
const researched = [];
for (let i=0;i<LIT_TOPICS.length;i++){
  const t = LIT_TOPICS[i];
  const r = await agent(
    `You are a rigorous research librarian. Load WebSearch+WebFetch via ToolSearch ("web search fetch"). Do MULTIPLE searches, fetch primary sources (papers, arXiv, DOI, author pages, Artistoo/CompuCell3D docs). Research this CELLULAR POTTS MODEL topic.\n\nTOPIC (${t.key}):\n${t.brief}\n\nGive REAL citations (authors, year, exact title, venue, URL). Do NOT invent papers; mark anything from memory as "UNVERIFIED". Focus designImplications on a node-graph CA IDE (GenesisCA) that compiles a node graph to a per-cell step on JS/WASM/WebGPU and wants to add a CPM mode. Return the structured object.`,
    { label:`research:${t.key}`, phase:'Research', schema: LIT_SCHEMA }
  );
  if (r) researched.push({ topic:t.key, research:r });
  log(`research ${researched.length}/${LIT_TOPICS.length} (last ${t.key}${r?'':' FAILED'})`);
}

phase('Verify');
const lit = [];
for (const item of researched){
  const v = await agent(
    `Adversarial fact-checker. Use WebSearch/WebFetch ("web search fetch"). Verify EVERY citation exists (yes/no/uncertain) and try to REFUTE the top ~5 claims for CPM topic "${item.topic}"; default "uncertain" if unconfirmed.\n\nRESEARCH:\n${JSON.stringify(item.research)}\n\nReturn the structured verification.`,
    { label:`verify:${item.topic}`, phase:'Verify', schema: VERIFY_SCHEMA }
  );
  lit.push({ ...item, verification:v });
}

phase('Synthesize');
const synthesis = await agent(
  `You are GenesisCA's lead architect. Using the findings below, write a COMPREHENSIVE markdown design for a CPM mode following the section outline in docs/HANDOFF_CPM_INVESTIGATION.md §7. Be honest about the central tension: CPM is stochastic Metropolis Monte Carlo on extended (multi-site) cells with per-cell incremental bookkeeping — decide whether it fits the compile-to-per-cell-step model, needs a bespoke worker engine loop with graph-supplied energy terms, or a hybrid. Ground every codebase claim in file paths from the findings.\n\n=== LITERATURE ===\n${JSON.stringify(lit)}\n\n=== CODEBASE ===\n${JSON.stringify(code)}`,
  { label:'synthesis', phase:'Synthesize' }
);

phase('Critique');
const critique = await agent(
  `Skeptical principal engineer. Find what's WRONG/MISSING in this CPM design: codebase-accuracy errors, missing subsystems (save/load, indicators, recording, presentation export, manual brush, inspector, copy/paste, neighborhoods/color-mappings panels), literature misstatements vs the verification, underspecified decisions, and whether it answers (1) literature (2) what-to-implement (3) the Monte-Carlo/extended-cell specifics. Give actionable top recommendations.\n\n=== DESIGN ===\n${synthesis}\n\n=== CODEBASE ===\n${JSON.stringify(code)}\n=== VERIFICATION ===\n${JSON.stringify(lit.map(l=>({topic:l.topic, verification:l.verification})))}`,
  { label:'critique', phase:'Critique', schema:{ type:'object', additionalProperties:false, properties:{
    technicalErrors:{type:'array',items:{type:'string'}}, missingSubsystems:{type:'array',items:{type:'string'}},
    literatureIssues:{type:'array',items:{type:'string'}}, underspecifiedDecisions:{type:'array',items:{type:'string'}},
    answersUserQuestions:{type:'string'}, topRecommendations:{type:'array',items:{type:'string'}} },
    required:['technicalErrors','missingSubsystems','underspecifiedDecisions','topRecommendations'] } }
);

return { literature: lit, codebase: code, synthesis, critique };
```

> **If the Workflow tool isn't available to you** (no ultracode / not opted in): use the **`deep-research` skill** for the literature, and spawn the codebase audit with sequential **Agent** tool calls (subagent_type `Explore` for read-only search). The sequential-literature + parallel-codebase + throttle-wait discipline still applies.

---

## 3. Reading the workflow result (it's large)
The result JSON (`{ literature, codebase, synthesis, critique }`) lands in a temp `.output` file; the `synthesis` field is one giant line. **You cannot `Read` a 25k+-token single line.** Use **Grep** to find section offsets (`"codebase":`, `"subsystem":`, `"critique":`, `"technicalErrors":`), then `Read` with `offset`/`limit`. The previous session also hit "output too large" on `Read` — page through it. Persisted Grep results (when output is big) save to a tool-results file you can then `Read`.

---

## 4. Literature research topics (6) — paste into `LIT_TOPICS`

```
[
  { key:'foundations', brief:`Cellular Potts Model (CPM) / Glazier-Graner-Hogeweg (GGH) foundations. Site spin sigma(x)=cell ID; cells = connected multi-site domains; cell type tau(sigma); medium=0. The energy/Hamiltonian formalism vs a CA transition rule. The Differential Adhesion Hypothesis (Steinberg) and cell sorting as the founding result. CONTRAST CPM with classical cellular automata (synchronous deterministic, one cell per site) and with the q-state Potts model it extends. Cite Graner & Glazier 1992 (PRL, "Simulation of biological cell sorting using a two-dimensional extended Potts model"), Glazier & Graner 1993 (PRE), Steinberg's DAH, and a modern review (e.g. Glazier/Balter/Poplawski; or Hirashima/Rens/Merks). Be precise about what "energy minimization via Monte Carlo" means for a modeling IDE.` },
  { key:'hamiltonian-terms', brief:`The CPM Hamiltonian terms in DETAIL and how each contributes to a LOCAL deltaH for a single proposed copy: (1) adhesion/boundary energy with the contact-energy matrix J(type,type) summed over neighbor site-pairs across cell boundaries; (2) volume/area constraint lambda_V (v - V_target)^2; (3) surface/perimeter constraint lambda_S (s - S_target)^2; (4) common extensions: chemotaxis (mu * chemical-gradient term), persistent migration / the Act model, length/elongation constraint, connectivity penalty, growth/division. For EACH term, how is deltaH computed incrementally for one site flip, and which GLOBAL per-cell quantities (current volume, current perimeter) must be maintained. This is the crux for an incremental-bookkeeping engine.` },
  { key:'dynamics-algorithm', brief:`The CPM update algorithm in DETAIL: the modified Metropolis / Monte Carlo Step (MCS) loop, boundary-site (copy-attempt) selection, the acceptance probability P = 1 if deltaH<=0 else exp(-deltaH/T), the role of temperature T (membrane fluctuation amplitude), and the CONNECTIVITY/FRAGMENTATION problem and the local-connectivity constraints used to prevent cells splitting. Determinism/RNG, why CPM is intrinsically stochastic & asynchronous. How an MCS relates to "one generation". Cite the algorithmic literature (Glazier-Graner; connectivity: Durand & Guesnet, or the "local connectivity" constraint papers; Cipra on Metropolis).` },
  { key:'applications-extensions', brief:`What CPM is USED for and the major feature extensions users expect (defines scope): cell sorting, morphogenesis, gastrulation, tumor growth & invasion, angiogenesis/vasculogenesis, chemotaxis, biofilms, epidermis. Extensions: subcellular compartments, ECM/links/fibers, coupling to reaction-diffusion CHEMICAL FIELDS (a PDE layer cells sense/secrete), cell growth/division/death, 3D CPM. Which of these are "must-have" vs "advanced". Cite Merks & Glazier; Swat et al. (CompuCell3D); Scianna & Preziosi reviews.` },
  { key:'software-visualization', brief:`Existing CPM software and how they are ARCHITECTED and VISUALIZED, with emphasis on browser/JS feasibility. ARTISTOO (Wortel & Textor, eLife 2021 / "Artistoo, a library to build, share, and explore simulations of cells and tissues in the web browser") is the key reference — study its architecture, how it runs CPM in JS, its performance, its API for the Hamiltonian. Also CompuCell3D (Python/C++ + CC3DML), Morpheus (GUI + MorpheusML), Tissue Simulation Toolkit, Chaste. Visualization techniques: color by cell ID vs cell TYPE, drawing cell BOUNDARIES/membranes, chemical-field heatmap overlays, cell centroid tracks, the "checkerboard"/parallel rendering. What UI they expose for J-matrix, lambdas, T, target volumes. This grounds the GenesisCA visualization + UX sections.` },
  { key:'performance-implementation', brief:`Data structures & performance for CPM, and the specific challenge of fitting it into a compile-to-per-cell-step engine (JS/WASM/WebGPU, Web Worker). The spin lattice; per-cell INCREMENTAL bookkeeping (volume/perimeter updated on each accepted copy, NOT recomputed); boundary/edge lists for efficient copy-attempt selection; Metropolis efficiency. PARALLEL/GPU CPM: checkerboard/sub-lattice decomposition and its bias issues, edge-based parallelism (cite Tapia & D'Souza "Parallelizing the Cellular Potts Model on GPU and CPU", or Chen/Glazier parallel CPM). Whether/how CPM can be GPU-accelerated (WebGPU) given its inherently sequential accept/reject. Compare to GenesisCA's async single-buffer + orderArray model. Be concrete about the per-cell-ID accumulator structure (an array indexed by cell ID, length = max cells).` }
]
```

---

## 5. Codebase subsystems to audit (5) — paste into `CODE_SUBS`

Same five seams the Graph-CA audit used, **reframed for CPM's needs**. (The Graph-CA findings already in `docs/INVESTIGATION_GRAPH_CA.md` and in `CLAUDE.md` are a head start — but re-audit; CPM stresses different parts, especially async/moves/model-attributes/lookupTable.)

```
[
  { key:'modes-plumbing', brief:`How GenesisCA wires OPTIONAL MODES end-to-end, as the template for a CPM-mode flag. Trace model.variegatedCells.enabled (a CAModel sub-object with enabled flag + dedicated reducer actions + cascades) AND model.properties.updateMode==='asynchronous'. Read: src/model/types.ts, src/model/defaultModel.ts, src/model/ModelContext.tsx, src/modeler/panels/PropertiesPanelContent.tsx, src/modeler/vpl/types.ts (NodeTypeDef.requirements = {async?,variegated?}), src/modeler/vpl/nodes/nodeValidation.ts (detectCapabilityRequirements/isNodeAvailable + detectWebGPU/WasmIncompatibilities), src/modeler/ActivityBar.tsx, src/modeler/ModelerView.tsx. NOTE: ModelProperties.topology is DEAD data (declared/saved, never branched). Output the EXACT touch-point list to add a new mode. A CPM mode likely (a) is a sub-object config like variegatedCells AND (b) forces an async-like stochastic single-buffer update — check how async is enforced/gated.` },
  { key:'engine-monte-carlo-fit', brief:`THE CRUX. Audit the simulation worker (src/simulator/engine/sim.worker.ts) for how close its ASYNC update is to a CPM Metropolis loop. Examine: async single-buffer mode (writeAttrs aliases readAttrs), orderArray (random-order / random-with-replacement / cyclic site selection, Fisher-Yates), the per-step loop, neighbor-WRITE nodes (SetNeighborAttributeByIndex, MoveSelfToNeighbor) and how they copy a value into a neighbor cell, GetRandom (probabilistic gate Math.random()<p), model attributes (global params), the markCellUpdated/skipped mechanism. Then identify what's MISSING for CPM: (1) a per-CELL-ID accumulator level (current volume/perimeter per biological cell, length=maxCells) updated incrementally on accepted copies; (2) computing deltaH and an accept/reject (exp(-dH/T)) gate; (3) boundary-site-restricted attempts; (4) connectivity constraint; (5) the J-matrix lookup (does the variegated lookupTable type / interaction-table machinery fit?). Be concrete: can a node-graph compiled per-cell express a Metropolis copy-attempt, or does CPM need a NEW engine loop where the graph only computes deltaH? Read also src/modeler/vpl/compiler/variegation.ts + the lookupTable handling.` },
  { key:'compiler-targets', brief:`How the three compilers (src/modeler/vpl/compiler/compile.ts JS, wasm/compile.ts, webgpu/compile.ts) emit the per-cell step, with emphasis on ASYNC semantics, RNG (GetRandom xorshift32 on JS/WASM, per-cell PCG on WebGPU), neighbor-write emission, and the async read-after-write hazard analysis (asyncWriteHazard.ts) + accessorCSE async gate. Question to answer: could a CPM "energy graph" (nodes computing deltaH terms from local site config + per-cell volume/perimeter) be compiled and called by a worker-side Metropolis driver? Or is CPM fundamentally a NEW engine path that doesn't reuse the per-cell-step compile model? Assess WebGPU feasibility given CPM's sequential accept/reject (checkerboard?). Note the compiler-lockstep rule (JS/WASM/WebGPU change together).` },
  { key:'rendering-sim', brief:`How the simulator renders + interacts (src/simulator/SimulatorView.tsx) and how much REUSES for CPM (CPM is still a 2D lattice, so far more reusable than Graph CA). Examine: the colors RGBA buffer blit (ImageData, one color per site index = reusable: color a site by its cell-ID or type), the color-mapping pipeline (Attribute->Color), Set Cell Looks / glyph overlay, the brush/paint (seed cells), zoom/pan, cell inspector. Identify the NEW rendering needs for CPM: drawing cell BOUNDARIES/membranes (sites whose neighbor has a different cell ID), coloring by cell ID (many distinct cells) vs by type, optional CHEMICAL-FIELD heatmap overlay, cell centroid/track display. What in the existing color-mapping + glyph + indicator infra already covers this?` },
  { key:'model-attributes-fileformat', brief:`The model data structure for representing CPM's two-level state + parameters + persistence. Read src/model/types.ts (CAModel, Attribute cell-vs-model, AttributeType incl. tag/lookupTable, sub-attributes parentAttribute*, Neighborhood, color mappings, indicators), src/model/fileOperations.ts (.gcaproj/.gcastate serialize incl. ATTR_TYPE_MAP, base64 typed arrays), src/model/schema.ts. Key questions: how to represent (a) the per-SITE cell-ID spin (an integer cell attribute), (b) the per-BIOLOGICAL-CELL object properties (type, target volume, current volume, perimeter) which are per-cell-ID NOT per-site (is there ANY existing per-agent/object level? sub-attributes? a new structure?), (c) CPM parameters: the J adhesion matrix (does the lookupTable tag x tag type fit?), lambda_V, lambda_S, T (model attributes with bounds?), per-type target volumes. How would all this serialize? Note: spatial indicators, neighborhoods, and the variegated lookupTable/interaction-table are the most CPM-relevant existing primitives.` }
]
```

---

## 6. The hard fit questions your investigation MUST answer
These are CPM-specific and the heart of the analysis. Make sure the synthesis + your final doc resolve (or explicitly flag) each:
1. **Engine paradigm:** Does CPM reuse the compile-to-per-cell-step model, need a **bespoke worker Metropolis loop** (graph supplies only the per-copy ΔH energy), or a **hybrid**? Recommend one. (This is the equivalent of Graph-CA's "CSR vs the dead `topology` field" central finding.)
2. **The extended-cell / two-level state:** Where do per-biological-cell properties (type, target/current volume, perimeter) live? A new per-cell-ID **object/accumulator table** (array indexed by cell ID, length = max cells), maintained incrementally on accepted copies. How does the node graph read them (a new "Get Cell Property" node level)?
3. **Incremental bookkeeping:** volume/perimeter must update on each accepted flip, not be recomputed — how, and where (worker vs compiled graph)?
4. **The Hamiltonian as a graph:** can users *author* the energy terms (adhesion via J-matrix, volume, surface, chemotaxis) as nodes, or are they fixed terms with parameters? Map the J-matrix to the existing **`lookupTable`** primitive; map λ/T to **model attributes**.
5. **Acceptance & RNG:** the `exp(−ΔH/T)` Metropolis gate (`GetRandom`), and cross-target RNG/determinism (JS/WASM xorshift vs WebGPU PCG).
6. **Boundary selection + connectivity:** efficient copy-attempt selection and the fragmentation constraint.
7. **Parallelism / WebGPU:** is GPU CPM viable (checkerboard) or is CPM JS/WASM-only like async? (Probably JS/WASM-first — verify.)
8. **Visualization:** cell-ID vs type coloring, **boundary/membrane rendering**, chemical-field overlays — how much the existing color-mapping/glyph infra covers.
9. **What is gated off / on:** which existing nodes make no sense in CPM, and what NEW nodes/value-types CPM needs (GetCellProperty, energy-term nodes, copy-attempt context, secrete/sense chemical field, divide/grow).
10. **The silent-corruption hazards** (the Graph-CA critique found several — do the same): e.g. `maxCells` sizing of the per-cell accumulator (stale → overflow), `attrsStructurallyEqual` reinit guard for new structures, `.gcastate` validation, single source of truth for the mode flag.

---

## 7. Deliverable spec

### 7.1 `docs/INVESTIGATION_CPM.md` (mirror the Graph-CA .md outline)
Status banner ("research only") → §1 Executive summary + recommended scope → §2 Literature foundations (the deep dive, organized by what matters: the energy/MC paradigm, the Hamiltonian terms, extended cells, dynamics+connectivity, applications, software precedent incl. Artistoo, performance) with **verified citations and a §2.x reliability note** → §3 Conceptual model (how CPM maps onto the Six Fundamentals; the engine-paradigm decision) → §4 Data model & file format (two-level state, J-matrix=lookupTable, params, serialization) → §5 Engine/worker (Metropolis loop, incremental bookkeeping, boundary selection, connectivity, async fit) → §6 Compiler (energy-graph vs bespoke loop; all three targets; RNG) → §7 Node set & gating → §8 Visualization (boundaries, cell-ID/type, chemical fields) → §9 Modeler UX → **§10 Subsystem Impact Map (a table — every touch-point with file refs + reuse/modify/new/gate-off + verify notes)** → §11 Phased plan → §12 Risks/open questions/decisions to confirm → §13 Verified bibliography (annotated, with confirmed vs uncertain flagged).

### 7.2 `docs/INVESTIGATION_CPM.html` (mirror the Graph-CA .html — self-contained, inline CSS/SVG/JS, no external assets)
Use the **same Nocturne dark theme + amber accent** design system as `INVESTIGATION_GRAPH_CA.html` (open it and reuse the CSS block + component classes: `.card`, `h2 .n`, `.tag`, `.matrix`, `.callout`, `.callgrid`, `.conf`, `.biblio`, the sticky TOC). Suggested figures/diagrams (hand-built inline SVG):
- **Extended cells diagram:** a lattice where many same-colored sites form one biological cell; show the spin σ = cell ID and the type τ. Contrast "GenesisCA today: 1 cell = 1 site" vs "CPM: 1 cell = many sites."
- **The Hamiltonian, visually:** the three energy terms (adhesion across boundaries, volume constraint spring, perimeter) as labeled SVG.
- **The Metropolis copy attempt:** a boundary site, a proposed copy, ΔH computed, `exp(−ΔH/T)` accept/reject gate — a flow diagram.
- **A real plot:** the acceptance probability `P = exp(−ΔH/T)` vs ΔH for a couple of temperatures T (shows the role of T).
- **Two-level state diagram:** per-site spin lattice + the per-cell-ID accumulator table (volume/perimeter/type/target).
- **J-matrix → lookupTable** mapping (reuse the existing primitive).
- **Engine-fit diagram:** "compile-per-cell-step" vs "bespoke Metropolis worker loop with graph-supplied ΔH" — the central decision.
- **Rendering reuse diagram:** colors buffer reused; ADD boundary drawing + field overlay.
- **Impact-map matrix** (colored chips), **phased timeline**, **hazard callouts**, **literature lineage + citation-confidence bar**.
- **A small live JS demo:** a tiny CPM is feasible but harder than the Graph-CA majority demo — a minimal Metropolis cell-sorting on a small grid (two cell types, adhesion-driven) is the ideal payoff if you can get it correct and cheap; otherwise an *animated* schematic of "boundary site copy → accept/reject" is an acceptable fallback. Keep JS self-contained, defensive, pausable.

---

## 8. How to verify (do this — the previous session did)
- **Firsthand-confirm the load-bearing codebase claims** before asserting them in the doc (the Graph-CA session confirmed "`topology` is dead data" and the `NodeRequirements` shape via Grep/Read). For CPM, firsthand-verify the highest-leverage claims, e.g.: the async single-buffer + `orderArray` mechanism, that `MoveSelfToNeighbor`/`SetNeighborAttributeByIndex` write a neighbor site, the `lookupTable` attribute type exists and is tag×tag, and that there is **no per-cell-ID object level** today (grep for any agent/object indexing).
- **Verify the HTML renders:** a `dev` server config already exists in `.claude/launch.json` (Vite, port 51730). Use `preview_start` (name `dev`), then `preview_eval` to `fetch`/navigate to `/docs/INVESTIGATION_CPM.html` (Vite serves on-disk files under root). Check: title, section count, every `figure svg` present with non-zero height, **no `preview_console_logs` errors**, and exercise the live demo via `preview_eval` (click its buttons, read state).
  - **Known gotcha:** `preview_screenshot` **times out (~30s) on these long pages** even though the renderer is responsive — don't rely on it; verify via `preview_eval` DOM checks (element `getBoundingClientRect`, `scrollWidth` vs `innerWidth` for no horizontal overflow) instead. (Also: `preview_eval` has a 30s tool timeout — keep evals short; don't chain long `setTimeout` waits.)

---

## 9. Project conventions to honor (from CLAUDE.md + memory — read them)
- **Read `CLAUDE.md` fully**, especially: the model definition + Six Fundamentals, the **Async** mode, **`MoveSelfToNeighbor`** ("Transfer Cell Attributes to Neighbor"), **Variegated Cells + `lookupTable`/interaction tables**, **Sub-Attributes**, **`GetRandom`/RNG**, and the three-target **compiler-lockstep** rule. Read the memory index `MEMORY.md` (it has a `project_graph_ca` pointer and `feedback_*` rules).
- **Impact Map First** (memory `feedback_impact_map_first`): for changes touching ≥3 subsystems, a subsystem-by-subsystem Impact Map precedes any plan — your §10 is that map.
- **Illustrated plans** convention: UI/behavior changes get a self-contained HTML mockup alongside the .md — that's your `INVESTIGATION_CPM.html`.
- **Docs consistency**, **English only**, **TypeScript strict**.
- **Never push, never add Co-Authored-By** (memory `feedback_no_push`, `feedback_no_coauthor`). This is investigation only — **do not write code, do not start implementation, do not write a formal PLAN** unless the user explicitly asks after seeing the findings.
- **Save a memory** when done (a `project_cpm.md` file + a one-line `MEMORY.md` pointer), mirroring `project_graph_ca.md`.

## 10. Pointers / templates
- **Quality bar + structural template:** `docs/INVESTIGATION_GRAPH_CA.md` and `docs/INVESTIGATION_GRAPH_CA.html` (open both first; reuse the HTML's CSS/components).
- **Most CPM-relevant existing code to study:** `src/simulator/engine/sim.worker.ts` (async loop, orderArray, neighbor writes), `src/modeler/vpl/compiler/variegation.ts` + the `lookupTable` handling (J-matrix fit), `src/modeler/vpl/nodes/MoveSelfToNeighborNode.ts`, `GetRandom`, `src/model/types.ts`.
- **External reference to study:** Artistoo (browser CPM) — its docs/source show exactly how to run CPM in JS in a browser.
- **Memory:** `~/.claude/projects/.../memory/project_graph_ca.md` (the prior investigation's record) and `MEMORY.md`.

---

### TL;DR of the recipe
Parallel-audit 5 subsystems (≤5 at once) → **sequentially** research+verify 6 CPM literature topics (one web agent at a time — this avoids the throttle that killed the first runs) → synthesize → critique → firsthand-verify the load-bearing codebase facts → write `INVESTIGATION_CPM.md` + `INVESTIGATION_CPM.html` (reuse the Graph-CA HTML's design) → verify the HTML via the `dev` preview (DOM eval, not screenshot) → summarize and **ask the user about scope** (don't build). The defining intellectual task: **CPM is stochastic Metropolis energy-minimization on multi-site cells — decide how that fits (or doesn't) GenesisCA's compile-to-per-cell-step engine, and where the per-cell-ID bookkeeping lives.**

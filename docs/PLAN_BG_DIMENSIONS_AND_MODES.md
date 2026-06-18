# Plan — Dimensions, Modes, Vocabulary, 3D Neighbourhoods, Variegated-in-3D & Transparency

> **Status:** concrete design extension. This **extends** [PLAN_BOND_GRAPH_MORPHOGENESIS.md](PLAN_BOND_GRAPH_MORPHOGENESIS.md) (the "BG plan"). It does **NOT** re-derive the bond-graph engine, the agent SoA, the force integrator, the structural-phase eigensolve, or the agent serializer — those are settled there and cited (`BG §N`, `BG D-X`). This document answers the user's **new** observations: the **Cells/Agents vocabulary**, the **closed agent↔grid feedback loop** (stigmergy), the **Dimension/Topology mode UI** and the **two-graph Modeler split**, the **3D CA grid engine**, **3D neighbourhood editing**, **variegated cells in 3D**, and **authorable RGBA transparency** with a see-through 3D renderer.
>
> **Grounding discipline.** Every codebase claim carries a `file:line`. Every recommendation that touches a research question cites the industry norm established in the research appendix of this effort (Golly / PhysiCell / CompuCell3D / Morpheus / Ready for neighbourhoods + orientation; McGuire-Bavoil / volume-ray-march for transparency).
>
> **Per CLAUDE.md ("Illustrated plans required for UI/behavior changes")** an HTML mockup (`PLAN_BG_DIMENSIONS_AND_MODES.html`) should accompany this for the Dimension/Topology Execution panel, the two-graph Modeler sub-tab strip, the 3D-neighbourhood parametric-shape + slice-stack editor, and the transparent 3D viewport. (Mockup deferred to the implementation PR; this doc is the written half.)

---

## §1 — Executive summary, the mode matrix, and the build DAG

### 1.1 What this adds

The BG plan introduced *one* new thing — agents (bond-graph nodes) living over the lattice field. The user's new observations sharpen that into a **two-axis design space** and demand four cross-cutting capabilities the BG plan only gestured at:

1. **Vocabulary** (§2): pin down the words. **Cells = grid slots** (the traditional CA lattice sites); **Agents = bond-graph nodes** (continuous-position, possibly free-floating/unbound). This is a rename across the prior docs (the BG plan's "cells/agents" usage becomes "agents"; the field/grid sites are "cells").
2. **Mode UI + Modeler split** (§3): Properties → Execution gains a **Dimension** radio (2D / 3D) and a **Topology** checkbox pair (Grid Cells / Bond-Graph Agents, ≥1 checked). The Modeler splits into **two sub-tab graphs** (Grid-Cells graph / Bond-Graph-Agents graph), each with its own palette gated by topology.
3. **Closed agent↔grid feedback** (§4): agents secrete into / consume from the grid (the field) underneath; the grid evolves and feeds back into the agents — a *stigmergy* loop. This formalizes BG §3.0's scatter/gather bridge as a first-class, bidirectional design property.
4. **3D engine + neighbourhoods + variegated + transparency** (§5–§8): the dimensionality work.

### 1.2 The 2-axis mode matrix

The two independent axes — **Dimension** (2D/3D) and **Topology** (Grid-Cells and/or Agents) — yield six meaningful configurations:

| | **Grid Cells only** | **Agents only** | **Both (Cells + Agents)** |
|---|---|---|---|
| **2D** | **Ships today.** Every existing `.gcaproj` is this cell. Classic 2D CA (GoL, Wireworld, Gray-Scott, chromatography). | 2D off-lattice morphogenesis: a cluster of glued agents that divide/branch with no field. (BG M1–M3.) | 2D agents suspended over a 2D field CA — the stigmergy loop (BG M4; §4 here). The canonical morphogenesis target. |
| **3D** | 3D CA volume. Totalistic 3D-Life (Bays 5766/4555), 3D Larger-than-Life, 3D Gray-Scott. Engine cheap, **renderer wholesale-new** (§5, §8). | 3D off-lattice agents (spheres + bond tubes), orbit camera, slice. (BG M6.) | The full vision: 3D tissue of dividing agents in a 3D morphogen field. **The most expensive cell** (3D field volume + 3D agents + transparency). |

**Invariants enforced in the reducer (§3):** ≥1 topology always checked; absent topology on an old file defaults to `{ gridCells: true, agents: false }`; absent `dimension` defaults to `'2d'`. So every legacy model loads as the top-left cell, byte-identically.

### 1.3 The build DAG

The user's directive: *2D-grid works today; add EITHER 3D-grid OR 2D-agents next (two independent next steps), then combine.* Formalized:

```
                          ┌─────────────────────────────────┐
                          │  T0  2D Grid Cells (SHIPS TODAY) │
                          └───────────────┬─────────────────┘
                                          │
              ┌───────────────────────────┼───────────────────────────┐
              │ (independent)             │                           │ (independent)
              ▼                           ▼                           ▼
   ┌──────────────────────┐   ┌──────────────────────────┐   ┌────────────────────────┐
   │ A. 3D GRID CA        │   │ M0. MODE UI + MODELER     │   │ B. 2D AGENTS (CB+BG)   │
   │  engine 3-ify (§5)   │   │     SPLIT (§3) + VOCAB(§2) │   │  agent SoA, forces,    │
   │  + 3D neighbourhoods │   │  (enabling shell; cheap)  │   │  bonds, division (BG)  │
   │  (§6)                │   │                           │   │                        │
   └─────────┬────────────┘   └──────────────┬────────────┘   └───────────┬────────────┘
             │                               │                            │
             │        ┌──────────────────────┴───────────┐                │
             │        │ X. RGBA ALPHA (authorable, §8)    │                │
             │        │  3-target emitter unpin + 2D blit │                │
             │        └──────────────────┬────────────────┘                │
             │                           │                                 │
             ▼                           ▼                                 ▼
   ┌──────────────────────┐                                   ┌────────────────────────┐
   │ A2. 3D GRID RENDERER │                                   │ B2. CLOSED FEEDBACK     │
   │  (WebGL2 instanced   │◄───── shares 3D renderer ─────────│  agent↔field stigmergy  │
   │   cubes + transparency)│       + alpha + camera           │  (§4) → 2D morphogenesis│
   └─────────┬────────────┘                                   └───────────┬────────────┘
             │                                                            │
             └──────────────────────────┬─────────────────────────────────┘
                                        ▼
                          ┌─────────────────────────────────┐
                          │  C. COMBINE → 3D morphogenesis  │
                          │  3D agents over 3D field, OIT   │
                          │  (most expensive matrix cell)   │
                          └─────────────────────────────────┘
```

**Reading the DAG.** `M0` **is not one cheap step — it splits into M0a (cheap) and M0b (expensive); see §1.5 C1.** `M0a` (the Dimension radio + Topology checkboxes + the `dimension`/`gridDepth`/`topology` schema fields + reducers) is the genuinely-cheap enabling shell, and it is **all that `A` (3D grid) needs** — a 3D grid CA requires no second graph. `M0b` (the second `agentGraphNodes` rule graph + the `activeGraph` sub-tab swap + the per-graph fork across ~20 `graphNodes` consumers) is the **sleeper cost** and is **gated behind the agent compiler `B`** — do not ship an agent graph nobody can compile. `A` (3D grid) and `B` (2D agents) are the two genuinely-independent next steps the user named — neither blocks the other. `X` (RGBA alpha) is a small cross-cutting prerequisite that **both** A2 and B2/C need (a 3D scene with no see-through is useless), so it slots in once and is shared. The 3D *renderer* (camera/instancing/transparency) is built once for A2 and **reused** by the 3D-agent path — do not build two 3D renderers.

### 1.4 The headline honesty (carried from every prior doc)

> **3D-is-easy is true of the engine, not the renderer.** The engine 3-ification (§5) is overwhelmingly incremental: `total = W*H*D`, a z-decode, a 3-tuple offset table — a cell is still one entity per index. The 3D **renderer** is wholesale new: the entire shipping path is a 2D `ImageData` blit on a hard `getContext('2d')` ([SimulatorView.tsx:754,780-784,788](../src/simulator/SimulatorView.tsx)) that the brush/gridline/glyph overlays are welded to — you cannot `getContext('webgl2')` on it. Quoting "3D is a flag flip" is the exact half-truth the investigations warn against.

---

## §1.5 — Critique corrections (read before §3, §4, §8)

An adversarial review found the per-section analysis accurate but caught five load-bearing issues. They are resolved authoritatively here; the affected sections carry inline pointers back to this list.

**C1 — The two-graph Modeler split is the sleeper cost; split M0 into M0a (cheap) and M0b (expensive).** The §1.3 DAG calls `M0` a "cheap enabling shell," which is only half true. The Dimension radio + Topology checkboxes + the `dimension`/`gridDepth`/`topology` schema fields + their reducers *are* cheap — but the **second agent rule graph** (`agentGraphNodes`/`agentGraphEdges`) is **not**: it forks `model.graphNodes`, which the audit estimates **~20 sites** read, and every one must branch:
- the **compiler entry** on all 3 targets;
- **`fileOperations`** save (`stringifyCompact`) **and** `readModelFile` recovery + `LOAD_MODEL` migration;
- the **ModelContext element-cleanup cascades** — `patchAllNodes` / `clearDeletedId` / the tag-option remap — which today scan `graphNodes` + `macroDefs[*].nodes` and **must also scan `agentGraphNodes`**, or deleting an attribute/neighbourhood leaves dangling `_undef` configs in the agent graph (the exact bug class CLAUDE.md calls out);
- **undo** (`graphHistory`), **clipboard** paste, and the three add-node menus (palette / quick-add / connection-drop).

**Decision: M0a ships first** = the mode UI + schema fields + reducers (the ≥1-topology invariant, the default-fill migration). This is genuinely cheap **and is all the 3D-grid path (A) needs** — a 3D grid CA requires NO second graph. **M0b is gated** = the `agentGraphNodes` second graph + the `activeGraph` sub-tab swap + the ~20-site per-graph fork; **do not ship it until the agent compiler (node B) is actually being built**, because an empty agent graph nobody can compile is dead weight that still forces every consumer to branch. This lets milestone A (3D grid) proceed with **zero two-graph cost**.

**C2 — Agent→cell writes: ANY attribute, over a RADIUS — and the buffer/timing that makes it correct.** An earlier draft over-narrowed this to "deposit into one dedicated single-buffered attribute." That was wrong *as a constraint*. **Agents can write ANY cell attribute, over a radius of cells** — radius 1 = the single cell under the agent; radius `r` = the `r`-disk (2D) / ball (3D) of cells under it — with a chosen **op** (`set` / `add` / `subtract` / `max` / `min` — the `UpdateAttribute` op set). The node is the agent analogue of the brush stamp: `AffectCellsUnder(attributeId, op, radius)`. What *is* load-bearing is the **timing**, because the grid CA is synchronous (double-buffered):
1. **Agents write the grid's READ buffer in a deposit phase BEFORE the grid step**, so the grid rule (which reads `r_`) incorporates the write (a diffusion rule then spreads it). Writing `w_` instead is clobbered by the step's top-of-loop `w_.set(r_)` copy. This works for **any** attribute + radius — no special attribute needed.
2. **A dedicated `source` attribute is an OPTIONAL modeling pattern, not an engine requirement.** Use it only when you want an injected *source rate* kept separate from a *diffusing concentration* (rule: `chemical_w = diffuse(chemical_r) + source_r`, agents write `source`). Otherwise agents write the field attribute directly and the grid rule's own `r_[idx]` term carries it forward.
3. **Many-agents-→-one-cell** is resolved by the **sequential agent loop applying each write's op in order** (`add` accumulates, `max` takes the largest) — a NEW agent-tier engine guarantee, **not** the compile-time `asyncWriteHazard.ts` analyzer (which orders emits *within one cell's rule body* and has nothing to do with runtime multi-agent accumulation). The **symmetric read** is also any-attribute + optional radius: `ReadCellsUnder(attributeId, radius, reduce)` — a point sample at the agent's position, or a `mean`/`gradient`/`max` over the `r`-disk/ball.

**C3 — "Agents only" (lattice-less) is the most novel matrix cell and was unspecified.** The whole engine is lattice-keyed (`total = W*H`, the cell SoA, neighbour tables, the colors buffer). An agents-only model (`topology.gridCells:false`) has no `total`, no cell SoA, no neighbour indices. **Decision: an agents-only model allocates NO grid** — a **virtual world rectangle** (`worldW × worldH[ × worldD]`, a new bounded model setting) defines agent bounds + the coordinate frame, the cell SoA + neighbour tables are skipped, and the **colors buffer is sized per-agent** (`maxAgents × 4`) and consumed by the entity renderer, not the lattice blit. The field/grid nodes are gated off (no cells to read). This is a real worker-init branch — flag it as **new** in the impact map, not implied-free by the matrix.

**C4 — 3D transparency v1 default: lead with the clip/slice plane, not depth-sort.** The research's de-facto norm is **layered: slicing/clipping planes first** (CompuCell3D, ParaView, Simularium), transparency second. Depth-sorted alpha blending is **incorrect on interpenetrating geometry** — which is *exactly* the dividing-daughter / dense-interior moment morphogenesis exists to show. So **v1 = a clip/slice plane** as the primary "see inside" affordance (cheap, correct, the industry-first norm) + **per-cell/agent alpha opt-in**; reserve **weighted-blended OIT** (McGuire–Bavoil, sort-free, WebGL2-friendly) for true volumetric translucency, and never ship raw depth-sort as the default. Cross-target note: the WebGPU present shader already unpacks alpha but the canvas is `alphaMode:'opaque'` (webgpuRuntime.ts:516) — it silently ignores alpha until that flips, a divergence the lockstep policy must reject.

**C5 — The 3D consumer-scan (not "minor").** Three subsystems need explicit 3D work, each a real change: **spatial indicators** — the rows/columns X-axis has no "layers" option; decide a 3rd-axis enum vs binning one axis while folding the other two (UI + worker + schema). **Cell inspector** — the `(dr, dc)` neighborIndex decode row needs a 3rd offset. **Recording / screenshot** — the grid-resolution `ImageData` capture has no volume analogue; both move to display-canvas capture (changing the existing capture path's resolution semantics).

---

## §2 — Vocabulary: Cells vs Agents (and the rename it implies)

### 2.1 The two words, pinned

| Term | Definition | Storage | Index space |
|---|---|---|---|
| **Cell** | A **grid slot** — a traditional CA lattice site. Has a fixed position implied by its index. This is the *field*. | Per-site SoA, one typed array per attribute, length `total` ([sim.worker.ts:796-810](../src/simulator/engine/sim.worker.ts)). | `idx = (layer*H + row)*W + col`, dense, no holes. |
| **Agent** | A **bond-graph node** — a continuous-position entity that may be bonded into a graph or float free/unbound. This is the *morphogenesis tier*. | Engine-owned agent SoA + bond store, length `maxCells`, free-list-holed (BG N3). | `idx < highWater`, skip `!alive` (BG §2.1). |

The decisive distinction: **a cell's position is its index; an agent's position is a float it carries.** A cell can never move off its slot; an agent has no slot.

### 2.2 The rename across the prior docs

The BG plan and the center-based investigation used "cell" for **both** the lattice site *and* the bond-graph node, which collides. Under the user's vocabulary:

| Prior-doc phrase | New phrase |
|---|---|
| "the bond-graph cell", "center-based cell", "divide the cell" | **agent** ("divide the agent") |
| "the field", "the lattice CA", "per-voxel attribute" | **cells** / **the grid** / **cell attribute** (unchanged — already correct) |
| BG node names: `divideCell`, `killCell`, `SetCellLooks`(on agents) | rename to `divideAgent`, `killAgent`; `SetCellLooks` stays (it sets *looks* for whichever entity the active root iterates — see §8) |
| BG `behaviourStep` "once per live agent" | unchanged wording, but the docstring says "agent" not "cell" |
| BG `maxCells` / `liveAgentCount` | keep `maxCells` as the *capacity* constant name (it is the agent-table capacity) but document it as "max **agents**"; prefer `maxAgents` in new code |

**The existing-codebase collision (must be handled, not renamed in schema).** GenesisCA already labels lattice attributes "Cell Attributes" everywhere — the Attributes panel, `ManualBrushPanel`, the inspector. Under the new vocabulary "Cell Attributes" is *correct* for the grid (cells = grid slots), so the lattice side needs **no rename**. The agent side needs its OWN attribute label: when the user is editing the **Agents** graph, the Attributes panel's section header reads **"Agent Attributes"**. This is a **per-mode label swap only**, NOT a schema rename — internal ids (`isModelAttribute`, attribute ids) are untouched, mirroring the CLAUDE.md type-name-display convention (`bool`→Binary is UI-only). The user never sees the word "cell" while authoring agent rules, and never sees "agent" while authoring grid rules.

> **Rename is additive, not a migration.** No `.gcaproj` stores these strings — they are UI labels and node `label`/`description` fields. Renaming `divideCell` → `divideAgent` is a node-type-id change that needs a one-line migration (like `tagConstant`→`getConstant.tag`, CLAUDE.md), but since the BG nodes are *unbuilt*, just name them `divideAgent`/`killAgent` from the start — there is nothing to migrate.

---

## §3 — The mode UI and the Modeler split

### 3.1 Properties → Execution: Dimension radio + Topology checkboxes

The Execution section ([PropertiesPanelContent.tsx:133-304](../src/modeler/panels/PropertiesPanelContent.tsx)) already renders four control clusters with one consistent shape: a `<div style={{ marginTop: 14, borderTop: '1px solid #333', paddingTop: 10 }}>` wrapper + a `.fieldLabel` + per-option `<label>` + a `#888 0.66rem` description span. The Variegated checkbox ([:288-304](../src/modeler/panels/PropertiesPanelContent.tsx)) and the Compile-Target radio ([:204-255](../src/modeler/panels/PropertiesPanelContent.tsx)) are the **verbatim templates**. Add two new clusters **above** the Variegated one:

**Dimension radio** (a primitive enum, written exactly like Update Mode at [:144-145](../src/modeler/panels/PropertiesPanelContent.tsx)):

```tsx
// cluster 1 — clone of the Compile-Target radio shape
<input type="radio" name="dimension" checked={(properties.dimension ?? '2d') === '2d'}
       onChange={() => updateProperties({ dimension: '2d' })} />   // 2D
<input type="radio" name="dimension" checked={properties.dimension === '3d'}
       onChange={() => updateProperties({ dimension: '3d' })} />   // 3D
```

**Topology checkboxes** (a richer feature → its own reducer + sub-object, clone of the Variegated checkbox at [:289-295](../src/modeler/panels/PropertiesPanelContent.tsx)):

```tsx
// cluster 2 — two checkboxes, ≥1 must stay checked
<input type="checkbox" checked={topology.gridCells} disabled={lastChecked('gridCells')}
       onChange={e => updateTopology({ gridCells: e.target.checked })} />   // Grid Cells
<input type="checkbox" checked={topology.agents}    disabled={lastChecked('agents')}
       onChange={e => updateTopology({ agents: e.target.checked })} />      // Bond-Graph Agents
```

`lastChecked(k)` greys the **last** remaining checked box so the UI can never produce an all-false state (the `disabled`+`opacity:0.55`+`cursor:'not-allowed'` pattern the Update-Mode radio uses when WebGPU forces sync, [:157-165](../src/modeler/panels/PropertiesPanelContent.tsx)). The reducer also rejects all-false as defense-in-depth (§3.4).

### 3.2 State ownership — `dimension` on properties, `topology` as a sub-object

| Field | Where | Why | Template |
|---|---|---|---|
| `dimension?: '2d' \| '3d'` | `ModelProperties` ([types.ts:192-235](../src/model/types.ts)) | Flat enum the compiler reads cheaply; sits beside `updateMode`. | `updateMode` |
| `topology?: { gridCells: boolean; agents: boolean }` | `CAModel` sub-object ([types.ts:540](../src/model/types.ts), after `variegatedCells`) | Gates a whole sub-panel + a second graph + has a cascade → earns its own reducer. | `VariegatedCellsConfig` ([types.ts:470-483](../src/model/types.ts)) |
| `gridDepth?: number` | `ModelProperties` (next to `gridWidth`/`gridHeight` at [:207-208](../src/model/types.ts)) | Default 1 → 2D models byte-identical (`W*H*1 === W*H`, §5). | `gridHeight` |

Reducer `UPDATE_TOPOLOGY` clones `UPDATE_VARIEGATED_CELLS` ([ModelContext.tsx:892-900](../src/model/ModelContext.tsx)) with the ≥1 guard inside:

```ts
case 'UPDATE_TOPOLOGY': {
  const current = state.model.topology ?? { gridCells: true, agents: false };
  const next = { ...current, ...action.changes };
  if (!next.gridCells && !next.agents) return state;          // reject all-false
  return { ...state, isDirty: true, model: { ...state.model, topology: next } };
}
```

Wire `updateTopology` into BOTH `useMemo` dep arrays ([ModelContext.tsx:1311,:1357](../src/model/ModelContext.tsx)) — the easy-to-miss step that silently breaks consumers.

### 3.3 The two-graph Modeler split — one editor, two root-level graphs

**The load-bearing reuse: GraphEditor already swaps which graph it edits, behind ONE ReactFlow instance.** It has no single graph — it has a `currentScope: string[]` stack. The scope-switch effect ([GraphEditor.tsx:1060-1086](../src/modeler/vpl/GraphEditor.tsx)) loads `model.graphNodes` at root scope or a `macroDef.nodes` deeper; write-back is symmetric in `scheduleSync` ([:724-736](../src/modeler/vpl/GraphEditor.tsx)). **The Cells/Agents split is the same idea one level up:** an `activeGraph: 'cells' | 'agents'` selector that, at root scope, chooses *which arrays* the existing effect loads.

**Schema — two named array pairs (the existing graph BECOMES the Cells graph):**

```ts
interface CAModel {
  graphNodes: GraphNode[];        // [types.ts:528] — UNCHANGED, this IS the Grid-Cells graph (zero migration)
  graphEdges: GraphEdge[];        // [types.ts:529]
  agentGraphNodes?: GraphNode[];  // NEW — the Bond-Graph-Agents graph (empty in old files)
  agentGraphEdges?: GraphEdge[];  // NEW
  macroDefs?: MacroDef[];         // [types.ts:530] — UNCHANGED, model-global, SHARED by both graphs
  topology?: TopologyConfig;      // NEW
}
```

**Editor wiring** (thread `activeGraph` from ModelerView into GraphEditor):

```ts
// the root branch of the scope-switch effect [GraphEditor.tsx:1063-1065] forks on activeGraph:
if (scopeId === 'root') {
  const [nds, eds] = activeGraph === 'agents'
    ? [model.agentGraphNodes ?? [], model.agentGraphEdges ?? []]
    : [model.graphNodes, model.graphEdges];
  setNodes(toRFNodes(nds)); setEdges(toRFEdges(eds));
}
// scheduleSync [:724-736] forks symmetrically: setGraph(...) vs setAgentGraph(...)
// add `activeGraph` to the effect dep array [:1086] alongside currentScope + modelVersion
```

`clearHistory()` already fires on every scope change ([:1079](../src/modeler/vpl/GraphEditor.tsx)); the `activeGraph` swap MUST also trigger it (it's in the same effect, so adding `activeGraph` to the dep array gets it for free) — otherwise Ctrl+Z after an Agents→Cells switch applies an agent-graph snapshot onto the cells graph.

**The sub-tab strip** lives **inside the graph area**, a sibling of the macro breadcrumb ([:3685-3704](../src/modeler/vpl/GraphEditor.tsx)) — NOT in the left ActivityBar (that switches *info panels*, a different axis). It renders only the pills for **checked** topologies. Macro drill-down composes orthogonally: entering a macro from either graph pushes onto `currentScope` as today, and the breadcrumb shows `Agents › someMacro`.

### 3.4 Two palettes, gated by the active sub-tab

`NodeRequirements` ([vpl/types.ts:76-93](../src/modeler/vpl/types.ts)) is `{ async?, variegated? }`; `isNodeAvailable(def, model)` ([nodeValidation.ts:459-464](../src/modeler/vpl/nodes/nodeValidation.ts)) returns false on an unmet flag; the Palette filters `getAllNodeDefs().filter(d => isNodeAvailable(d, model))` ([PalettePanelContent.tsx:177](../src/modeler/panels/PalettePanelContent.tsx)). Add two flags:

```ts
interface NodeRequirements { async?: boolean; variegated?: boolean; lattice?: boolean; bondGraph?: boolean; }
// lattice-only family (neighborhood/grid nodes): requirements.lattice = true
// agent family (behaviourStep, divideAgent, GetBondDegree, SampleField, …): requirements.bondGraph = true
```

**The one wrinkle (gotcha):** `isNodeAvailable` gates by **model state**, but the palette must gate by the **active sub-tab**. A model with *both* topologies enabled would otherwise show agent nodes in the Cells palette. Thread the active-graph kind into the filter — cleanest is a `graphState.ts` module global (the same pub/sub `currentModelElementDrag` already uses, [GraphEditor.tsx:61](../src/modeler/vpl/GraphEditor.tsx)) so the Palette, the unified quick-add menu, AND the connection-drop menu all read it without prop-drilling. Then: agent nodes show only when `activeGraph==='agents'`; lattice nodes only when `activeGraph==='cells'`.

### 3.5 Cascade & validation (decision table)

| Event | Behaviour | Template |
|---|---|---|
| Uncheck a topology (UI) | Last-checked box is `disabled` → can't reach all-false. | Update-Mode disable ([PropertiesPanelContent.tsx:157-165](../src/modeler/panels/PropertiesPanelContent.tsx)) |
| All-false write (hand-edited file / code path) | Reducer returns `state` unchanged. | §3.2 reducer |
| Old file with no `topology` | `LOAD_MODEL` defaults `{ gridCells: true, agents: false }`. | `createInitialState` migration guards (CLAUDE.md) |
| Disable a topology while editing its graph | Sub-tab pill elides; ModelerView auto-switches `activeGraph` to the surviving topology. | V-tab elision ([ActivityBar.tsx:47-49](../src/modeler/ActivityBar.tsx)) + auto-switch ([ModelerView.tsx:85-87](../src/modeler/ModelerView.tsx)) |
| Re-enable a topology | Its retained graph data reappears (NOT wiped on disable — mirrors how variegated data persists, [types.ts:471-473](../src/model/types.ts)). | — |
| New agent node with required config | MUST add a `detectMissingConfig` case ([nodeValidation.ts](../src/modeler/vpl/nodes/nodeValidation.ts)) or the compiler emits `_undef` (BG §9.1 #7). | — |
| `EMPTY_MODEL` | Seeds `dimension:'2d'`, `topology:{gridCells:true,agents:false}`, `agentGraph*:[]` ([defaultModel.ts:5-29](../src/model/defaultModel.ts)). | — |

**Save/load** (`fileOperations.ts`): round-trip `agentGraphNodes`/`agentGraphEdges` + `topology`/`dimension`/`gridDepth` — additive optional fields; the custom `stringifyCompact` must inline the new node/edge arrays like the existing ones and filter `undefined` (CLAUDE.md). Old files lacking them load fine.

> **Both halves of a gate land together** (CLAUDE.md): the Topology checkbox AND the sub-tab elision AND the auto-switch ship in one PR. Shipping the checkbox without the auto-switch strands a user on a hidden graph.

---

## §4 — The closed agent↔grid feedback loop (stigmergy)

### 4.1 What the user observed

> *Agents secrete into / consume from the grid (the field) underneath, which affects the field AND themselves AND other agents.*

This is **stigmergy**: indirect coordination through a shared environment. An agent's action modifies the grid; the grid evolves under its own CA rule; the changed grid changes every agent that later senses it. It is the PhysiCell+BioFVM architecture (discrete agents over a continuum field) with **GenesisCA's CA engine as the field solver** — and it closes the loop the BG plan's §3.0 opened (scatter/gather) into a true feedback cycle.

The grid here is **cells** (grid slots, §2). The morphogenesis tier is **agents**. The field is a *normal GenesisCA lattice CA* — authored with the entire existing modeler (the Grid-Cells graph, §3) — so it gets attributes, neighbourhoods, init, color mappings, indicators, save/load **for free** (BG §3.0). The agents add their own tier.

### 4.2 The scatter/gather loop (one generation)

```
  ┌────────────────────────── ONE GENERATION ──────────────────────────┐
  │                                                                      │
  │  (1) SCATTER  agents deposit/consume into cell attributes           │
  │       SecreteToField(substrate, +rate)  → w_cell_<sub>[voxelOf(a)] += rate    │
  │       (bilinear 4-cell splat, accumulate; many agents → one cell OK) │
  │                              │                                        │
  │                              ▼                                        │
  │  (2) GRID STEPS  the Grid-Cells CA runs its own rule (K sub-steps)   │
  │       diffuse / react / decay — ordinary getNeighbors→aggregate→…    │
  │       reads the deposited `source` attribute, double-buffered        │
  │                              │                                        │
  │                              ▼                                        │
  │  (3) GATHER  agents sense the (now-changed) grid                    │
  │       SampleField(substrate)   → bilinear read at agent (x,y[,z])    │
  │       FieldGradient(substrate) → ∇c for chemotaxis                   │
  │                              │                                        │
  │                              ▼                                        │
  │  (4) BEHAVE  agents run behaviourStep over the sensed values:        │
  │       grow / divide / die / bond / change attributes / re-secrete    │
  │       → which changes WHERE/HOW-MUCH they scatter next gen ──────────┘
  │                                                                      │
  └──────────────────────────────────────────────────────────────────────┘
   The loop is CLOSED: (4)→(1) next gen. Field affects agents (3→4);
   agents affect field (1→2); agents affect OTHER agents via the field (1→2→3).
```

**What agents can write (general — corrected per §1.5 C2):** an agent can write **any cell attribute, over a radius** of cells under it — `AffectCellsUnder(attributeId, op, radius)`, the agent analogue of the brush stamp (radius 1 = the cell under the agent; radius `r` = the `r`-disk/ball; op = set/add/subtract/max/min). It is **not** restricted to a single special attribute. The one load-bearing rule is **timing**: agents write the grid's **READ buffer** in a deposit phase **before** the grid step, so the grid rule (which reads `r_`) incorporates the write and spreads it — writing `w_` would be clobbered by the step's top-of-loop `w_.set(r_)` copy. A **dedicated `source` attribute** (rule: `chemical_w = diffuse(chemical_r) + source_r`) is an **optional** modelling pattern for keeping an injected source separate from a diffusing concentration, **not** a requirement. **Multiple agents → one cell** is resolved by the **sequential agent loop applying each op in order** (`add` accumulates, `max` wins) — a **new agent-tier engine guarantee**, **not** the compile-time `asyncWriteHazard.ts` analyzer. The gather (`ReadCellsUnder(attributeId, radius, reduce)`) runs **after** the grid step (sense the diffused result) and is likewise any-attribute + optional radius.

**Coordinate map:** the grid's `W×H[×D]` defines the world rectangle; an agent at `(x,y[,z])` maps to cell `(⌊x⌋,⌊y⌋[,⌊z⌋])`; agents share the grid's boundary treatment (torus wrap / wall). The bilinear splat/sample handles the sub-cell fraction.

### 4.3 Worked example — hypoxia-driven branching (tumour/vasculature)

A complete closed loop exercising every arrow, authored across the two graphs:

**Grid-Cells graph (the field CA — ordinary lattice nodes):** an oxygen attribute `O2` (float) that diffuses and decays.

```
getNeighborsAttribute(O2) → aggregate.sum → expression( O2 + dt*(D*lap - decay*O2 + source_O2) ) → setAttribute(O2)
   (cells with `source_O2 < 0`, written by agent consumption, become local sinks → a hypoxic gradient forms)
```

**Bond-Graph-Agents graph (the agent rules — new agent nodes):**

```
# (1→2) every agent CONSUMES O2 at its location — the sink that creates hypoxia
SecreteToField(O2, rate = −uptakeRate)        # negative secretion = consumption

# (3→4a) sense local O2; below threshold ⇒ hypoxic ⇒ necrose
SampleField(O2) ──┐
                  ├─ Compare("<", necroticThreshold) ── then ──▶ killAgent
GetModelAttr(necroticThreshold) ┘

# (3→4b) mild hypoxia ⇒ secrete VEGF back INTO the grid (a SECOND cell attribute)
SampleField(O2) ──┐
                  ├─ Compare("<", hypoxicThreshold) ── then ──▶ SecreteToField(VEGF, +vegfRate)
GetModelAttr(hypoxicThreshold) ┘

# (3→4c) any agent sensing high VEGF gradient DIVIDES up that gradient → branching toward hypoxia
FieldGradient(VEGF) ─ magnitude ─┐
                                 ├─ Compare(">", sproutThreshold) ── then ──▶ divideAgent { axisSource: "field-gradient" }
GetModelAttr(sproutThreshold) ───┘                                              (engine reads ∇VEGF for the division axis)
```

**The emergent loop:** agents consume O2 → a hypoxic region forms (grid step) → hypoxic agents secrete VEGF into the grid → VEGF diffuses (grid step) → the VEGF gradient steepens toward the hypoxic core → agents divide up that gradient, sprouting new vessel agents toward the hypoxia → the new vessels relieve hypoxia (re-oxygenate by consuming less / the necrotic core stops growing) → the gradient flattens → branching slows. **Nothing is scripted** — branching morphology emerges from the closed coupling (BG §6.1, Nelson). The VEGF field is a *second* cell attribute the user added with zero new mechanism; the agent↔grid bridge (`SecreteToField`/`SampleField`/`FieldGradient`) is the only new code.

**Why this needs the closed loop, not just gather:** if agents only *read* the field (gather) without *writing* it (scatter), there is no hypoxia (no consumption sink) and no VEGF trail (no deposition) — the morphology never forms. The user's observation that the feedback must be *closed* is exactly right: it is the write-back that makes the field a coordination medium rather than a static backdrop.

### 4.4 Three feedback channels (the loop is richer than scatter/gather)

| Channel | Mechanism | Node(s) |
|---|---|---|
| **Field → agent** | bilinear sample / gradient at the agent's float position | `SampleField`, `FieldGradient` (BG §3.1) |
| **Agent → field** | bilinear splat into a `source` cell attribute (accumulate) | `SecreteToField` (BG §3.1) |
| **Agent → field → agent** (stigmergy proper) | agent A deposits; the grid diffuses; agent B (or A later) senses — indirect, time-delayed coordination | composition of the above two + the grid CA step |
| **Field reads agents** (optional, full bidirectionality) | agents scatter a per-cell occupancy/density the grid rule reads | `GetAgentDensityHere` (a cell-side read node, BG §3.0) — lets the grid respond to where agents are (ECM deposition, contact guidance, laid-down trails) |

All four feed the **same** graphs — there is **no "environment phase."** The field is a separate *root* (the Grid-Cells Step) for its own diffusion, but agents READ it inline as ordinary value nodes (BG §3.4). Do not introduce a special environment-evaluation order.

---

## §5 — The 3D CA grid engine

### 5.1 The three engine seams (all incremental)

A cell is still **one entity per index**; the only change is the index↔coordinate bijection. Three localized seams:

**Seam 1 — `total` and SoA.** `initGrid` sets `total = width * height` ([sim.worker.ts:751](../src/simulator/engine/sim.worker.ts)); every typed array is allocated `total`-long and is otherwise dimension-agnostic ([:796-810](../src/simulator/engine/sim.worker.ts)).

```ts
total = width * height * depth;   // depth defaults to 1 → W*H*1 === W*H, 2D byte-identical
```

The double-buffer swap, async `orderArray`, glyph/orientation/lookup regions, save/load — all unchanged (they only care about `total`).

**Seam 2 — the offset table (the highest-leverage change).** `buildNeighborIndices` ([sim.worker.ts:877-913](../src/simulator/engine/sim.worker.ts)) is the **one** place lattice geometry is materialized — a double `for row/col` loop reading 2-tuples `[dr,dc]`, wrapping/sentinel-ing, writing a flat `Int32Array` of `total*nbrSize`. 3-ify:

```ts
for (let layer = 0; layer < depth; layer++)
  for (let row = 0; row < height; row++)
    for (let col = 0; col < width; col++) {
      const cellIdx = (layer*height + row)*width + col;
      for (let n = 0; n < nbrSize; n++) {
        const [dr, dc, dl = 0] = nbr.coords[n]!;   // dl=0 default ⇒ 2D neighbourhoods unchanged
        let nL = layer+dl, nR = row+dr, nC = col+dc;
        if (out of range on ANY of the 3 axes) {
          if (torus) { nL = ((nL%depth)+depth)%depth; nR = …; nC = …; }
          else { indices[cellIdx*nbrSize+n] = total; continue; }   // sentinel unchanged
        }
        indices[cellIdx*nbrSize+n] = (nL*height + nR)*width + nC;
      }
    }
```

**The stride stays `coords.length`**, so the flat `Int32Array` keeps its shape and **EVERY downstream consumer is byte-compatible** — every neighbour-access node reads `nIdx_<nbr>[idx*nSz + k]` exactly as before, drawing from a 3D space. This single change makes the whole neighbour-access node family 3D for free.

**Seam 3 — the per-cell-step preamble.** The compiled step decodes `_row=(idx/W)|0; _col=idx-_row*W` at [compile.ts:1751-1752](../src/modeler/vpl/compiler/compile.ts), repeated in InputColor/OutputMapping/InitEvent. Add the z-decode:

```js
const _layer = (idx / (W*H)) | 0;
const _row   = ((idx / W) | 0) % H;
const _col   = idx - (_layer*H + _row)*W;
// InitEvent additionally: _v<id>_z = _layer;  _v<id>_maxZ = D-1;
```

Gate the fast path: when `D===1` emit the current 2-line decode verbatim → **zero regression** for every existing model. **Do NOT rename `_row`/`_col`** — existing NI/sub-attr nodes read them; ADD `_layer`/`_z`.

### 5.2 What reuses vs what forks per target

| Subsystem | 2D→3D | Note |
|---|---|---|
| SoA allocation, double-buffer, async order | **reuse 100%** | `total`-keyed, dimension-agnostic |
| Offset table (Seam 2) | **one-loop change** | highest leverage |
| **JS** step decode (Seam 3) | **cheap** — add `D`/`WH` to `buildLoopParams` ([compile.ts:1145](../src/modeler/vpl/compiler/compile.ts)) + `buildLoopArgs` ([sim.worker.ts:938](../src/simulator/engine/sim.worker.ts)); JS takes `total,W,H` as **runtime args** | free arg-pass |
| **WASM** decode | **real lockstep** — WASM **bakes `W`/`H`/`total` as compile-time literals** ([wasm/compile.ts:1700-1701,:330-332](../src/modeler/vpl/compiler/wasm/compile.ts)); thread `D`/`WH` into the layout + emitter; fork `getSelfPosition` `x=idx%W;y=idx/W` ([:2054-2056](../src/modeler/vpl/compiler/wasm/compile.ts)) | NOT free |
| **WebGPU** decode | **real lockstep** — W/H baked as WGSL literals; stale baked `total` is the documented **Resize-bug class** (evolves only the first W*H cells of a 3D buffer) | NOT free |
| Indicators (linked/spatial) | **extend** — `computeSpatialIndicators` bins by `row=⌊i/W⌋`/`col=i%W`; add a layer bin or 3D histograms fold layers together | minor |
| End conditions / StopEvent / recording / save-load | **reuse** | index-agnostic; register any new array kind in `ATTR_TYPE_MAP` |
| Constant-boundary sentinel | **extend** — `total` sentinel + `total+1` views ([:795](../src/simulator/engine/sim.worker.ts)) must honor the 3-axis bounds check, or 3D faces corrupt | — |

### 5.3 Build-order consequence

The engine 3-ification is **headless-testable before any 3D renderer exists**: ship Seam 2 + Seam 3, then verify with a **totalistic 3D rule** (3D-Life / Bays 5766) via `getState` + indicator histograms — no rendering needed. This matches the user's caveat (§6) that *3D CA does not auto-extend from 2D except totalistic rules*: a totalistic rule needs only the neighbour **count**, so the moment the offset table is 3D and the decode lands, a 3D-Life rule runs correctly and is verifiable. The renderer (§8) is a separate, larger milestone (`A2`).

---

## §6 — 3D neighbourhoods: editing paths, the recommendation, and the industry norm

### 6.1 The key fact: editing is decoupled from runtime

Every runtime consumer operates on the **flat `coords` list** and never inspects how it was produced — `buildNeighborIndices` ([sim.worker.ts:877-913](../src/simulator/engine/sim.worker.ts)) consumes the tuples; the compiled reads index the resolved table; tags resolve a flat coord-array **index** ([GetNeighborAttributeByTagNode.ts:13-23](../src/modeler/vpl/nodes/GetNeighborAttributeByTagNode.ts), dimension-agnostic). **So the editing strategy is a free choice** — it just has to write a flat list. The hard runtime cost is the *lattice* going 3D (§5), NOT the neighbourhood.

### 6.2 The industry norm (grounded in the research)

> **Across every established 3D CA / lattice tool, 3D neighbourhoods are PARAMETRIC** — a named shape + a radius/order, never a hand-edited offset list.

- **Golly** (the reference open-source CA tool): `3D.lua` uses `3D<S>/<B><letter>` with five **hardcoded named shells** — Moore (26), Face/von Neumann (6), Corner (8), Edge (12), Hexahedral (12). There is **no 3D offset editor.**
- **3D Life** (Bays 5766/4555): B/S counts over the fixed 26-cell Moore shell.
- **3D Larger-than-Life** (Imai/Oroji/Kubota 2018): `L=(r, β1, β2, σ1, σ2)` — one radius defines a `(2r+1)³` cube (729 cells at r=4). Purely parametric.
- **CompuCell3D**: `<NeighborOrder>N</NeighborOrder>` — integer interaction shells (1st/2nd/3rd nearest-neighbour by Euclidean distance), only orders 1–4 used in practice.
- **Morpheus**: a single `Order` or `Distance` number.
- **Ready** (reaction-diffusion): named 3D **19-point / 27-point Laplacian** stencils + a "Convert to Full Kernel" escape hatch (OpenCL code, not a drawing UI).

**The only two "editing" affordances that exist anywhere:** (a) **drawing in 2D** (Golly's 2D Larger-than-Life custom `N@` / weighted `NW`, built by drawing live cells and running `create-custom-ltl.lua` — documented for **2D only**); (b) **writing a convolution kernel as code** (Ready). A hand-edited 3D offset list is **essentially unheard-of in shipping tools** — the cardinality blow-up (a Moore-r cube is `(2r+1)³`: 27/125/343/729) makes per-cell editing impractical, and totalistic rules only need the count anyway.

**Conclusion: the user's instinct is correct.** Parametric named-shape + radius is the de-facto standard. A node-graph CA IDE that ships a usable 3D-shell picker meets the norm; one that *also* offers a real interactive 3D editor would lead the field — but should default to parametric.

### 6.3 The paths (decision table)

| Path | What it is | Runtime cost | Editor cost | Verdict |
|---|---|---|---|---|
| **1. Parametric generators** | Pick `{kind:'ball'\|'shell'\|'ring'\|'disk'\|'moore'\|'vonNeumann'\|'rangeN', radius/axis/metric}`; a pure `generateCoords3d(spec)` materializes the flat list. | **ZERO new runtime** | small new panel (radius/axis/metric inputs) | **PRIMARY ✅** — the industry norm; one extra loop over `layer` in the `annulusCells` analogue ([NeighborhoodsPanelContent.tsx:75-91](../src/modeler/panels/NeighborhoodsPanelContent.tsx)) |
| **2. 2D-slice-stack editor** | Reuse the existing 2D grid editor **verbatim** + a Z-slice selector (`±margin` stepper); each slice edits `(dr,dc)` at fixed `dl`. | **ZERO new runtime** | near-free (reuses `annulusCells`/`lineCells`/`applyCellsChanges` [:75-185](../src/modeler/panels/NeighborhoodsPanelContent.tsx)) | **SECONDARY ✅** — hand-tuning + per-slice tags |
| **3. Orbit-able 3D voxel picker** | A WebGL voxel view, click voxels to toggle. | needs the 3D render+pick stack (itself unbuilt) | hard (occlusion, depth disambiguation) | **DEFER** — Option 1+2 cover the cases |
| **4. Parametric-only, no tags/no picking (the user's minimal proposal)** | Option 1 alone, with tags + direct-neighbor-picking gated off in 3D. | ZERO | smallest | **VALID minimal v1** — my rec upgrades it to 1+2 (both cost no runtime) |

### 6.4 The recommendation

**Ship Option 1 (parametric generators) as the primary 3D path + Option 2 (slice-stack) for hand-tuning.** Both write the same flat `coords3d` and require **zero new runtime**. Concretely:

```ts
// schema — additive, old 2D files load unchanged
interface Neighborhood {
  coords: Array<[number, number]>;            // [types.ts:95] UNCHANGED (2D)
  coords3d?: Array<[number, number, number]>; // NEW — presence = 3D
  shape?: NeighborhoodShapeSpec;              // NEW — drives the parametric editor + re-tune
}
type NeighborhoodShapeSpec =
  | { kind:'moore'|'vonNeumann'|'ball'|'rangeN', radius:number, metric?:'chebyshev'|'manhattan'|'euclidean' }
  | { kind:'shell', rIn:number, rOut:number }
  | { kind:'ring'|'disk', axis:'x'|'y'|'z', radius:number, width?:number };
```

Store **both** the spec AND the materialized coords (coords is the runtime source of truth; a cascade re-materializes on spec edit, like the `linkedOutputMappings` cascade — never let a stale spec emit a dangling read). Expose `radius` + `metric` so one dropdown reproduces Moore (L∞) / von Neumann (L1) / sphere (L2) — and document the mapping in-app (the CompuCell3D/Golly naming diverges across tools).

### 6.5 Validate the user's "no tags / no direct-picking in 3D"

| User proposal | Verdict | Why |
|---|---|---|
| **Parametric shapes** | ✅ **Endorsed** | The industry norm (§6.2). |
| **No direct-neighbor-PICKING in 3D** | ✅ **Endorsed — stronger reason than UX** | The `neighborIndex` i32 codec packs **exactly two 16-bit offsets** (`packNI = ((dr&0xFFFF)<<16)|(dc&0xFFFF)`). A third axis forces a codec redesign across JS/WASM/WebGPU + the `NeighborIndexValuePicker` widget. Gate the `neighborIndex` value type + `GetNeighborAttributeByIndex`/`SetNeighborAttributeByIndex` + the picker behind a `requirements: { lattice2d: true }` flag so the palette hides them in 3D. Tag-based nodes (`GetNeighborAttributeByTag`) are the 3D-safe substitute. |
| **No tags in 3D** | ⚠️ **Softened (optional)** | Tags are runtime-**dimension-agnostic** (they resolve a flat coord index). A blanket ban is fine for minimum scope, but it forecloses anisotropic hand-built 3D neighbourhoods needlessly. **Recommendation:** keep tags available in 3D but expose tagging ONLY through the slice-stack editor (right-click-a-cell per slice) — large *generated* shapes simply don't offer per-voxel tags (a generated ball has no meaningful labels). This is a more capable line than a ban at no runtime cost; the blanket ban is also acceptable if the user wants the smallest surface. |

**Symmetry gotcha:** the 2D `expandSymmetry` diagonal mirrors (`[c,r]`/`[-c,-r]`, [NeighborhoodsPanelContent.tsx:64-65](../src/modeler/panels/NeighborhoodsPanelContent.tsx)) do **NOT** generalize to 3D — full 3D symmetry is the 48-element octahedral group (axis permutations × sign flips). In a 3D editor restrict to the three axis-plane mirrors (H/V + a new "L" layer mirror); do not port D/D2.

---

## §7 — Variegated cells in 3D

### 7.1 The complication (analysis)

2D variegation is byte-locked to four constants that all break in 3D:

| 2D constant | Value | 3D analogue | Cost |
|---|---|---|---|
| **Orientation** | 0–3 (four 90° rotations of a square), `& 3` clamp ([SetOrientationNode.ts:23](../src/modeler/vpl/nodes/SetOrientationNode.ts)) | **0–23** — the chiral octahedral rotation group (≅ S4, 24 rotations: 1 identity + 9 face-axis + 8 body-diagonal + 6 edge-axis) | fork `& 3` → `% 24` per dimension |
| **Face set** | 8 Moore directions `DIRECTION_TAGS`, `FACE_SLOT_COUNT = 8` ([variegation.ts:18,23](../src/modeler/vpl/compiler/variegation.ts)) | **6 faces** (±X/±Y/±Z, von Neumann) — or 26 with edges+corners | parameterize the `*8` stride |
| **Rotation arithmetic** | closed-form `(dirIdx + 2k) & 7` ([GetFacingLabelsNode.ts:70-71](../src/modeler/vpl/nodes/GetFacingLabelsNode.ts)) | **NO closed form** — a precomputed `24×6` (orientation×face) permutation table | one-time ~50-line generator |
| **Pattern editor** | a `3×3` CSS grid (the flat 2D Moore shell, [VariegatedCellsPanelContent.tsx:9-18,379-381](../src/modeler/panels/VariegatedCellsPanelContent.tsx)) | a **6-face cube net** (the cube has 11 nets — no canonical flat layout) | the genuinely hard piece |

**The math is clean** (24 rotations, 6 faces, integer-exact table lookups — the orientation buffer is already one i32/cell, [sim.worker.ts:832-843](../src/simulator/engine/sim.worker.ts), wide enough for 0–23 with no width change). **But the literature has NO precedent** for a full per-face 3D variegated rule system:

- **PhysiCell** (the leading off-lattice framework) explicitly does **not** implement polarized cell-cell adhesion or cell-orientation updates — directionality is a single continuous migration-bias vector (unit direction + scalar bias ∈[0,1] + persistence).
- Kier's "variegated cell" (the direct ancestor of GenesisCA's feature) was published **2D-only** (square, 4 faces) — amphiphiles, micelles, chiral water. No 3D 6-face version exists.
- 3D vertex models have face normals + apical-basal polarity but hand-tune per-face behaviour ad hoc; Cellular Potts expresses anisotropy via energy/shape, not a 6-face table.

So the blocker is **not** the compiler (the orientation buffer + table-bake pattern extend cleanly) — it is (1) the **UX of editing 6 faces × 24 orientations** (no canonical cube unfolding; 24×24=576 relative-orientation pairings are not hand-editable as a flat table), and (2) the **absence of any convention to copy**.

### 7.2 The recommendation: defer variegation to 3D-later; 2D-only in v1

> **Ship 3D grid CA with variegation DISABLED in v1.** Add 3D variegation as a clearly-scoped later milestone.

This is nearly free structurally: the orientation/face machinery is **entirely behind** `if (variegated || hasLookupTables)` ([compile.ts:1156](../src/modeler/vpl/compiler/compile.ts)) and `requirements.variegated` ([vpl/types.ts:80](../src/modeler/vpl/types.ts)). A 3D model with `variegatedCells.enabled === false` **never touches any 2D-locked code**. The gate: when `dimension === '3d'`, force `variegatedCells.enabled = false` (or elide the V tab), exactly as `ActivityBar` already elides V when disabled ([:47-49](../src/modeler/ActivityBar.tsx)).

**Decision table:**

| Option | Verdict |
|---|---|
| **3D grid in v1 WITHOUT variegation; 3D variegation later** | ✅ **STRONGLY RECOMMENDED** — decouples the big 3D-grid/render/split work from the contained-but-real 3D-variegation work; 2D variegated models (Amphiphile, Chromatography) stay byte-identical; variegation is opt-in and already cleanly gated, so deferring costs nothing structurally. |
| Ship 3D + 3D variegation together | ❌ Couples the 24×6 table + cube-net editor + tri-target lockstep into the v1 critical path for a feature few initial 3D models use. Higher risk. |

**If 3D variegation is later built, the settled choices (for the record):**

- **Orientation:** discrete `0..23` index into the chiral octahedral group, resolved through a precomputed `ORIENT_FACE_3D: Int32Array(24*6)` table (the exact analogue of `(dirIdx+2k)&7` — there is NO modular formula). Fits the existing single-i32 buffer; integer-exact on all 3 targets (avoids the WGSL-no-f64 hazard). **NOT quaternions** — those belong to the off-lattice *agent* tier (continuous SO(3)), not lattice cells.
- **Face set:** **6 faces only** (von Neumann), the 3D analogue of `cardinalsOnly` ([GetAllFacingLabelsNode.ts:22](../src/modeler/vpl/nodes/GetAllFacingLabelsNode.ts)). Edges (12) / corners (8) deferred (the 26-slot editor is the wall).
- **Editor:** an **unfolded cube net** (the standard cross/T cubemap layout used by Unity/OpenGL) — 6 dropdowns, as legible as today's 3×3, reuses the existing per-slot dropdown component; only the position table changes (a `FACE_NET_POS_3D` analogue of `SLOT_GRID_POS`). NOT a 3×3×3 grid (27 cells, only 6 are faces — less legible).
- **Stride:** change `*8` → `*faceCount` ([variegation.ts:91,104](../src/modeler/vpl/compiler/variegation.ts)) parameterized by dimension, in the shared parity module, propagated to all 3 targets in one lockstep change.
- **Reuse win:** `LookupInteractionNode`/`InteractionTableMapNode` are **unchanged** — they key on dimension-agnostic face-LABEL indices; only the face-RESOLUTION (which slot faces which neighbour) is 3D-specific.

**The forking discipline (gotcha):** `& 3` and `& 7` are 2D-square-lattice constants masquerading as bit-twiddling — fork them **by dimension**, never globally, or every existing 2D variegated model silently breaks. The 2D and 3D paths must coexist.

---

## §8 — RGBA transparency: authorable alpha (3 targets) + the transparent 3D renderer

### 8.1 The colors buffer is ALREADY RGBA — alpha is just pinned to 255

This is **not** "add a channel" — it is "unpin the alpha byte." Alpha is forced opaque at exactly three emit sites + two fallbacks:

| Site | Current | File:line |
|---|---|---|
| **JS** `setCellLooks` | `colors[colorIdx+3] = 255;` (a string literal in `compile()`) | [SetCellLooksNode.ts:65](../src/modeler/vpl/nodes/SetCellLooksNode.ts) |
| **WASM** `setCellLooks` | `i32Const(255); i32Store8(colorsOffset+3)` | [wasm/compile.ts:5062-5064](../src/modeler/vpl/compiler/wasm/compile.ts) |
| **WebGPU** `setCellLooks` | `... \| (255u<<24u)` — `colors` is `array<u32>`, alpha is the **top byte** | [webgpu/compile.ts:2706-2709](../src/modeler/vpl/compiler/webgpu/compile.ts) |
| writeDefaultColors fallback | `a=255` | [sim.worker.ts:1715](../src/simulator/engine/sim.worker.ts) |
| SimEngine (reference-only) | `a=255` | [SimEngine.ts:189,227](../src/simulator/engine/SimEngine.ts) |

**Three free wins:** (1) the 2D renderer **already composites per-pixel alpha** — `clearRect` ([SimulatorView.tsx:788](../src/simulator/SimulatorView.tsx)) leaves the canvas transparent and `drawImage` does source-over, so a non-255 alpha already shows through to the page; (2) **save/load already round-trips alpha** — `fileOperations.ts` base64's the whole RGBA buffer, no serializer change; (3) the **WebGPU present shader already unpacks alpha** ([webgpuRuntime.ts:493-497](../src/simulator/engine/webgpuRuntime.ts)) — but the canvas is `alphaMode:'opaque'` ([:516](../src/simulator/engine/webgpuRuntime.ts)), discarding it.

### 8.2 Make alpha authorable (3-target lockstep)

**(a) Set Cell Looks gains an `a` input port** (after `glyphB` at [SetCellLooksNode.ts:50](../src/modeler/vpl/nodes/SetCellLooksNode.ts)), `inlineWidget:'number'`, `defaultValue:'255'`. Both cells and agents set alpha through this same node:

```js
// JS [SetCellLooksNode.ts:65] — was `colors[colorIdx+3] = 255;`
colors[colorIdx+3] = ${inputs['a'] || '255'};
// WASM [wasm/compile.ts:5062-5064] — replace i32Const(255) with pushValueAs(inputs['a'] ?? 255)
// WebGPU [webgpu/compile.ts:2709] — replace (255u<<24u) with ((u32(clamp(<a>,0,255)))<<24u)
```

**(b) Color Scale + Categorical Color gain an `a` OUTPUT channel.** Today both emit only `r`/`g`/`b` ([ColorScaleNode.ts:41-43](../src/modeler/vpl/nodes/ColorScaleNode.ts), [CategoricalColorNode.ts:44-46](../src/modeler/vpl/nodes/CategoricalColorNode.ts)). Add a fourth `_v${id}_a` variable (per-stop for Color Scale, per-entry `entry_${i}_a` for Categorical, default 255) + the **full multi-output registration** (`MULTI_OUTPUT_TYPES`, `varName()` special-case, WASM/WebGPU `setCachedPort('a',…)`) — or downstream references an undeclared `_v${id}_a` (CLAUDE.md varName discipline). Optional: if the consumer doesn't wire `a`, the inline-255 default applies.

**(c) Linked Output Mappings.** Extend `LinkedColorSet`/`ColorStop`/`RGB` ([types.ts:111-124](../src/model/types.ts)) with optional `a?: number` (additive), and have `linkedOutputMappings.ts:73-75` emit an `a` edge when authored. Surface alpha as a 4th slider in the gradient-stops editor.

**Default MUST be 255 everywhere** (inline `defaultValue:'255'` + `|| '255'` fallbacks) so every existing model stays byte-identical — verify via the cross-target compiler-import parity check (CLAUDE.md: compare `.stepCode`/`.bytes`/`.shaderCode` on an unchanged model before/after).

### 8.3 The 2D renderer — mostly free, one fix + a global slider

The lattice base blit already composites alpha. Two additions:
- **Global see-through slider:** wrap the `drawImage` calls ([SimulatorView.tsx:919,923](../src/simulator/SimulatorView.tsx)) in `ctx.save(); ctx.globalAlpha = seeThroughRef.current; …; ctx.restore();` (precedent: `globalAlpha` at [indicatorChartSettings.ts:98](../src/simulator/indicatorChartSettings.ts)). Persist in `genesisca_sim_settings`. Final alpha = `authored_alpha * global`.
- **Glyph-fallback fix:** the recolor hard-sets `buf[o+3]=255` ([SimulatorView.tsx:899](../src/simulator/SimulatorView.tsx)) — preserve the source alpha for translucent glyph-fallback.
- **WebGPU 2D:** flip `alphaMode:'opaque'`→`'premultiplied'` ([webgpuRuntime.ts:516](../src/simulator/engine/webgpuRuntime.ts)) + premultiply in the present shader (`vec4(r*a,g*a,b*a,a)`), gated behind the see-through state, so all three targets render translucency identically (the lockstep policy frowns on a cross-target visual divergence).

### 8.4 The 3D transparent renderer (net-new, rides the 3D renderer from §5/`A2`)

This is the genuinely hard piece — and the per-agent/per-cell alpha is **already** the 4th byte of the index-keyed `colors` slot, so the data is there; the renderer must (1) enable GL blending, (2) **cull alpha-zero entities** (never instance the full `W*H*D` volume — at 256³=16.7M cells a full-volume instance buffer is fatal; scan to occupied/alpha>0 into the instance buffer), and (3) handle draw order.

**The industry norm (grounded in the research):** layered — **slicing/clipping planes first** (CompuCell3D, ParaView, Simularium), **weighted-blended OIT** (McGuire-Bavoil 2013) for translucency (WebGL2-compatible, sort-free, no atomics), **3D-texture volume ray-march** for a dense voxel grid (order-independent). Depth peeling / WebGPU per-pixel linked lists only for pixel-exact OIT.

**Decision table for draw order:**

| Option | When | Tradeoff |
|---|---|---|
| **0. Clip / slice plane** | **v1 PRIMARY "see inside"** | Cheap (`discard` past the plane), **correct** (no blend-order problem), the **industry-first norm** (CompuCell3D / ParaView / Simularium). Authorable as a bounded model attribute, live-tunable. |
| **A. Depth-sorted back-to-front** | v1 translucency layer (**opt-in, not the default**) | Cheap, reuses the painter's-algorithm sort. **Incorrect for interpenetrating/dividing daughters** (two spheres at one centroid) + dense interiors — so it is NOT the default see-inside mechanism (§1.5 C4). O(N log N) CPU sort, fine to ~10⁴. |
| **B. Weighted-blended OIT** (McGuire-Bavoil) | v2 upgrade | Sort-free, correct for arbitrary overlap, WebGL2 + WebGPU. One accumulation pass + a resolve; approximate (weighting heuristic). Best for "see into the tissue." |
| **C. Volume ray-march a 3D texture** | dense voxel GRID | Order-independent, front-to-back accumulation — the natural fit for a *cell* (grid) volume rather than a cube-per-cell. |
| **D. Depth peeling / PPLL** | offline/screenshot | Exact but N× cost (PPLL is WebGPU-only — atomics). Not the interactive hot path. |

**Recommendation:** instanced cubes (crisp, obviously a lattice, correct occlusion via the depth buffer) **+ a slicing/clip plane** as the primary "see inside" affordance (cheap `if(dot(worldPos,planeN)>planeD) discard;`, surfaced as a **bounded model attribute** reusing the live-slider machinery so "reveal interior" is authorable + live-tunable) **+ opt-in per-cell alpha (depth-sorted, Option A — never the default**, since it sorts wrong exactly at the division moment morphogenesis exists to show, §1.5 C4), with **weighted-blended OIT (Option B)** as the v2 upgrade behind the same alpha plumbing. For a dense *cell* field, **volume ray-march (Option C)** is the alternative to per-cell cubes. The "global see-through" slider becomes a uniform multiply in the impostor fragment shader (the same slider as the 2D path).

**Alpha semantics:** expose **both** per-channel authorable alpha (Set Cell Looks + palette nodes, §8.2) AND a separate global see-through slider — they compose (`final = authored * global`). Ship the global slider first (no emit changes — pure `globalAlpha`/uniform), then layer the per-cell channel.

> **Both cells and agents set alpha** through the SAME `setCellLooks.a` port (§2: agents read their attributes via `idx` exactly like cells), so the authorable-alpha work in §8.2 is dimension- and topology-agnostic — it serves the 2D lattice, the 3D grid volume, and the 3D agent spheres with one emitter change per target.

---

## §9 — Revised build roadmap (honoring the DAG)

| Phase | Milestone | Demo | Depends on | Targets |
|---|---|---|---|---|
| **M0** | **Mode UI + Modeler split + vocabulary** (§2, §3) | Properties shows Dimension/Topology; the Modeler shows Cells/Agents sub-tab pills; agent palette gated; old files load as 2D-Grid-Cells. | T0 | UI only |
| **X** | **Authorable RGBA alpha** (§8.2, §8.3) | A 2D cell fades to translucent against the page; global see-through slider; all 3 targets byte-identical when alpha=255. | M0 (independent of A/B) | JS→WASM→WebGPU |
| **A** | **3D grid engine + 3D neighbourhoods** (§5, §6) | A totalistic **3D-Life** rule runs headless — verified via `getState` + indicator histograms, NO renderer yet. Parametric shell picker + slice-stack editor. | M0 | JS→WASM→WebGPU |
| **B** | **2D agents** (CB substrate + BG M1–M3) | Soft spheres push apart; glue into chains; a cluster grows and divides along its tension axis. | M0 | JS-reference (BG D-TARGET) |
| **A2** | **3D grid renderer** (§5.2, §8.4) | Orbit a 3D-Life volume; slice into it; transparent voxels reveal the interior. | A + X | WebGL2 (new) |
| **B2** | **Closed agent↔grid feedback** (§4) | The hypoxia→VEGF→branching loop (§4.3) — painting a wound perturbs it live. | B (+ X for the 2D field blit alpha) | JS-reference |
| **C** | **Combine → 3D morphogenesis** | 3D tissue of dividing agents in a 3D morphogen field; OIT see-through. | A2 + B2 (shares the 3D renderer + alpha + camera) | WebGL2 + JS-reference |

**Critical-path notes:** `M0` first (both A and B want it). `A` and `B` are the two independent next steps — run them in parallel if staffed, in either order if not. `X` (alpha) is a small shared prerequisite for everything 3D/translucent — land it once, early. The **3D renderer is built once** (A2) and reused by C — do not build two.

---

## §10 — Risks & open decisions

| # | Risk / decision | Recommendation |
|---|---|---|
| R1 | **Compiler must fork per-graph.** The Cells compiler reads `graphNodes`; the Agents compiler needs `agentGraphNodes`. Sharing one array makes the fork impossible. | Separate arrays (§3.3) — non-negotiable. The agent compile entry (BG `behaviourStep` root) is BG-scoped; this doc only guarantees the clean schema split. |
| R2 | **`graphState.ts` singletons** (clipboard, undo stacks, `quickAddApi`, `isConnectingGlobal`) would cross-contaminate if two LIVE editors existed. | Single-editor `activeGraph` swap (§3.3), NOT two mounted editors. `clearHistory()` on swap. |
| R3 | **WASM/WebGPU bake geometry as literals** — the 3D z-decode is real lockstep work, not the free arg-pass JS gets. A stale baked `total` evolves only the first W*H cells. | Thread `D`/`WH` into the WASM layout + WGSL literals at the same commit (§5.2). |
| R4 | **Alpha default drift.** Any non-255 default silently darkens every existing model. | `defaultValue:'255'` + `|| '255'`/`?? 255` fallbacks; cross-target parity check before/after (§8.2). |
| R5 | **3D renderer sold as "a flag."** It is wholesale-new (§1.4, §8.4). | Quote "engine cheap, renderer expensive" in every estimate. |
| R6 | **3D variegation scope creep.** The 24×6 table + cube-net editor + tri-target lockstep is a real subsystem. | Defer (§7.2) — gate `variegated` off when `dimension==='3d'`. |
| R7 | **Spec/coords desync** in parametric 3D neighbourhoods. | Re-materialize coords on spec edit (cascade); coords is the single runtime source of truth (§6.4). |
| R8 | **Thumbnails composite translucent frames** against the Models Library card background. | Force the thumbnail capture opaque, or document the behaviour (§8 gotcha). |
| **D1** | **Tags in 3D — ban or slice-only?** (§6.5) | Slice-only (keeps anisotropic hand-built neighbourhoods, no runtime cost) — but a blanket ban is acceptable for minimum scope. **User to decide.** |
| **D2** | **3D draw order v1** — depth-sort (cheap, wrong on overlap) vs OIT (correct, costlier)? (§8.4) | **Clip/slice plane PRIMARY** (correct, industry-norm) + **opt-in** depth-sort alpha; OIT as v2 (§1.5 C4). Never depth-sort as the default. |
| **D3** | **3D field rendering** — instanced cubes vs volume ray-march for a dense *cell* volume? (§8.4) | Cubes for sparse/discrete; volume ray-march for dense continuous fields. Ship cubes first. |
| **D4** | **`gridDepth` location** — flat decode vs precomputed per-axis caches? (§5.2) | Flat `idx=(z*H+y)*W+x` decode — zero new storage, every node reuses; the division is one op/cell V8/WASM optimize. |
| **D5** | **Build order** — `A` (3D grid) or `B` (2D agents) first? | User's call; the DAG makes them independent. If the morphogenesis vision is the priority, `B` first (it's the harder, more novel substrate). If a quick visible 3D win is wanted, `A` first (totalistic 3D-Life is verifiable headless before any renderer). |

**The single sentence:** make the words precise (cells = grid, agents = bond-graph), expose Dimension + Topology as two cheap Execution clusters that fork the Modeler into two reused-machinery graphs, formalize the closed agent↔grid stigmergy loop as the morphogenesis engine, 3-ify the grid engine incrementally while building the 3D *renderer* honestly as net-new with authorable RGBA alpha and a clip-plane/OIT see-through — and **defer 3D variegation**, the one piece with no industry precedent and a genuinely hard editor.

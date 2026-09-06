# `docs/areas/` — subsystem reference docs

> One doc per subsystem of **GenesisCA**. These hold the invariants, the gotchas and the traps for each
> area. They are **read on demand**, not auto-loaded — the routing table in
> [`../../CLAUDE.md`](../../CLAUDE.md) says which one to open for what you are about to touch.

Most of this content was moved **verbatim** out of `CLAUDE.md` on 2026-09-06, when that file had reached
6,753 lines / 1.85 MB and was being injected into *every* session — including tasks that touched none of
it. Nothing was deleted. The full build narratives (measurements, verification transcripts, phase
reports, design rationale) live in `docs/HANDOFF_*.md`, `docs/PLAN_*.md`, `docs/IMPACT_MAP_*.md` and
`docs/INVESTIGATION_*.md`.

Paths inside these docs are **repo-root-relative** (e.g. `src/model/types.ts`), as they were in
`CLAUDE.md` — read them from the repository root.

## The docs are a GRAPH — walk it to closure

Every doc opens with an **`Also read`** line naming the areas a change there usually reaches, and the
prose cross-links onward from there. **Following those is not optional**: the routing table gives you an
entry point, and stopping at the first doc that answers your question is exactly how a locally-correct
change ends up missing the mirror it had to keep in step. The procedure — route, compute the blast
radius, follow, repeat until a pass turns up nothing new — is *Read to CLOSURE, not to the first hit* in
`../../CLAUDE.md`.

| doc | size | covers |
|---|---|---|
| [architecture.md](architecture.md) | 21 KB | The six fundamentals, the model schema, the tech stack, the graph→compile strategy, the file formats, the presentation export, the open investigations. |
| [project-structure.md](project-structure.md) | 23 KB | The full annotated tree of `src/`, `scripts/`, `docs/` and `public/`. Where things live. |
| [compiler-core.md](compiler-core.md) | 101 KB | The two-pass JS compiler and the analyses every target consumes: value sinking, accessor CSE, the async read-after-write hazard, the multi-attribute-slot and periodic-event lowerings, rule cadence, parameterized input mappings. |
| [value-types.md](value-types.md) | 57 KB | What a value can BE and how it is stored: `vector` / `color` composites (wire AND stored attribute), alpha through the whole colour-producer chain, Local Variables. |
| [cell-features.md](cell-features.md) | 46 KB | The schema features that belong to the CA grid: Variegated Cells (orientation, face labels, lookup tables), sub-attributes, the chemistry primitives, Linked Output Mappings. |
| [compiler-wasm.md](compiler-wasm.md) | 8 KB | The hand-rolled WASM encoder/emitter for the cell grid. |
| [compiler-webgpu.md](compiler-webgpu.md) | 28 KB | The WGSL emitter and GPU runtime for the cell grid. |
| [engines-and-targets.md](engines-and-targets.md) | 74 KB | The Auto/WASM/WebGPU selector, `resolveEngines`, the compatibility readout, the generation pipeline, fast-path diagnostics, the Exact\|Statistical contract, geometry taint. |
| [simulation-engine.md](simulation-engine.md) | 117 KB | `sim.worker.ts`, the SoA grid, step batching, the busy overlay, sparse stepping, the Grid Init Event. |
| [modeler-ui.md](modeler-ui.md) | 173 KB | React Flow graph editor, `CaNode`, panels, reroutes, the cross-tab clipboard, and the large "Key Patterns" catalogue of editor gotchas. |
| [simulator-ui.md](simulator-ui.md) | 100 KB | `SimulatorView`: rendering, the transport bar, capture (screenshot/recording), the cursor overlay, panel layout and resize. |
| [agent-engine.md](agent-engine.md) | 64 KB | The off-lattice agent tier itself: the SoA store, the force driver, bonds, division, the closed field↔grid feedback, the worker protocol, the physics knobs. |
| [agent-nodes.md](agent-nodes.md) | 92 KB | What a rule can SAY on the Agents graph: the node catalogue, agent attributes vs variables, targeting, cross-agent write semantics, the Stop Event. |
| [agent-compilers.md](agent-compilers.md) | 87 KB | The three agent compile targets: the JS agent compiler, the WASM whole-target port, the WebGPU agent compiler + runtime, the production-hardening audit. |
| [agent-capabilities.md](agent-capabilities.md) | 28 KB | The opt-in capability modules, the dependency closure, the three enforcement gates, the shared ABI descriptor (`agentAbi.ts`), the profile-gated SoA fields. |
| [agent-render.md](agent-render.md) | 195 KB | Drawing agents: the worker-side GPU direct render, the UI-sync policy, sprites on all three targets, 3D billboards, residency, the active window. |
| [agent-brush-ui.md](agent-brush-ui.md) | 83 KB | The agent brush (add/remove/move/edit/push/pull/glue/cut/paint), brush kinds, the 3D control overhaul, inspectors, vision cones, follow mode. |
| [graph-rewriting.md](graph-rewriting.md) | 147 KB | Neighbour census, bond attributes, the structural request queue, rewire/transfer/form-between verbs, division partitions, graph indicators. |
| [grid-3d.md](grid-3d.md) | 130 KB | The W×H×D lattice across all three targets, 3D neighbourhoods, the WebGL2 voxel renderer, the worker WGSL voxel pass, the 3D viewport. |
| [macros.md](macros.md) | 83 KB | Macro defs, boundary nodes, expansion, reference export/import, explicit controls, moving a selection across a boundary, linked vs independent copies. |
| [indicators.md](indicators.md) | 31 KB | Standalone/linked/graph indicators, spatial (chromatogram) indicators, charts, the manual brush, end conditions, stop events. |
| [overseer.md](overseer.md) | 17 KB | The third graph: replicate statistics, parameter sweeps, run-until-stop protocols, the Experiments panel, CSV/JSON export. |
| [io-and-formats.md](io-and-formats.md) | 49 KB | Save/load, simulation state, presets, the standalone `.html` presentation export, PWA/Tauri, CSV import & export, reset-restores-board. |
| [gis.md](gis.md) | 64 KB | Esri ASCII grids, GeoTIFF, GeoJSON, the georeference record, the backdrop map, the GIS gate, the satellite-data samples. |
| [model-library.md](model-library.md) | 27 KB | The sample models, their generator scripts, and the conventions for adding one. |
| [testing-harnesses.md](testing-harnesses.md) | 9 KB | Index of the 67 `scripts/*.mjs` harnesses, grouped, plus the house style that makes them trustworthy. |

## Adding an area

A new area doc is warranted when a genuinely new subsystem appears — not for a new feature inside an
existing one. It needs three things:

1. a row in the routing table in `../../CLAUDE.md` (the only edit the always-loaded file should need);
2. an **`Also read`** line naming the areas a change there reaches;
3. a mention from at least one sibling's `Also read` line, so the walk can reach it from elsewhere.

`node scripts/check-claude-md-budget.mjs` enforces (1) and (2), and fails on a routing entry or a
cross-link that points at a doc which does not exist. It does not enforce (3) — an area nobody links to
is still reachable from the routing table, but it will be found only by someone who already suspected it
existed.

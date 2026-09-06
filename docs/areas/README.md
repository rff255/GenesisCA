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

| doc | size | covers |
|---|---|---|
| [architecture.md](architecture.md) | 20 KB | The six fundamentals, the model schema, the tech stack, the graph→compile strategy, the file formats, the presentation export, the open investigations. |
| [project-structure.md](project-structure.md) | 23 KB | The full annotated tree of `src/`, `scripts/`, `docs/` and `public/`. Where things live. |
| [compiler-core.md](compiler-core.md) | 196 KB | The two-pass JS compiler, value sinking, accessor CSE, async hazards, and every schema-level feature that lowers to nodes. |
| [compiler-wasm.md](compiler-wasm.md) | 7 KB | The hand-rolled WASM encoder/emitter for the cell grid. |
| [compiler-webgpu.md](compiler-webgpu.md) | 27 KB | The WGSL emitter and GPU runtime for the cell grid. |
| [engines-and-targets.md](engines-and-targets.md) | 74 KB | The Auto/WASM/WebGPU selector, `resolveEngines`, the compatibility readout, the generation pipeline, fast-path diagnostics, the Exact\|Statistical contract, geometry taint. |
| [simulation-engine.md](simulation-engine.md) | 116 KB | `sim.worker.ts`, the SoA grid, step batching, the busy overlay, sparse stepping, the Grid Init Event. |
| [modeler-ui.md](modeler-ui.md) | 172 KB | React Flow graph editor, `CaNode`, panels, reroutes, the cross-tab clipboard, and the large "Key Patterns" catalogue of editor gotchas. |
| [simulator-ui.md](simulator-ui.md) | 100 KB | `SimulatorView`: rendering, the transport bar, capture (screenshot/recording), the cursor overlay, panel layout and resize. |
| [agent-engine.md](agent-engine.md) | 264 KB | The off-lattice agent tier: the SoA store, forces, bonds, division, the field bridge, the three agent compile targets, capability profiles. |
| [agent-render.md](agent-render.md) | 194 KB | Drawing agents: the worker-side GPU direct render, the UI-sync policy, sprites on all three targets, 3D billboards, residency and the active window. |
| [agent-brush-ui.md](agent-brush-ui.md) | 82 KB | The agent brush (add/remove/move/edit/push/pull/glue/cut/paint), brush kinds, the 3D control overhaul, inspectors, vision cones, follow mode. |
| [graph-rewriting.md](graph-rewriting.md) | 147 KB | Neighbour census, bond attributes, the structural request queue, rewire/transfer/form-between verbs, division partitions, graph indicators. |
| [grid-3d.md](grid-3d.md) | 130 KB | The W×H×D lattice across all three targets, 3D neighbourhoods, the WebGL2 voxel renderer, the worker WGSL voxel pass, the 3D viewport. |
| [macros.md](macros.md) | 83 KB | Macro defs, boundary nodes, expansion, reference export/import, explicit controls, moving a selection across a boundary, linked vs independent copies. |
| [indicators.md](indicators.md) | 30 KB | Standalone/linked/graph indicators, spatial (chromatogram) indicators, charts, the manual brush, end conditions, stop events. |
| [overseer.md](overseer.md) | 16 KB | The third graph: replicate statistics, parameter sweeps, run-until-stop protocols, the Experiments panel, CSV/JSON export. |
| [io-and-formats.md](io-and-formats.md) | 49 KB | Save/load, simulation state, presets, the standalone `.html` presentation export, PWA/Tauri, CSV import & export, reset-restores-board. |
| [gis.md](gis.md) | 63 KB | Esri ASCII grids, GeoTIFF, GeoJSON, the georeference record, the backdrop map, the GIS gate, the satellite-data samples. |
| [model-library.md](model-library.md) | 27 KB | The sample models, their generator scripts, and the conventions for adding one. |
| [testing-harnesses.md](testing-harnesses.md) | 9 KB | Index of the 67 `scripts/*.mjs` harnesses, grouped, plus the house style that makes them trustworthy. |

## Adding an area

A new area doc is warranted when a genuinely new subsystem appears — not for a new feature inside an
existing one. Give it a row in the routing table in `../../CLAUDE.md`; that is the only edit the
always-loaded file should need.

`node scripts/check-claude-md-budget.mjs` fails if a routing entry points at a missing doc, or if a doc
here is unreachable from `CLAUDE.md` — an unrouted area doc is one nobody will ever open.

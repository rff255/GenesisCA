# Changelog

All notable changes to GenesisCA are documented here. The newest release is at
the top. Full commit history and older releases:
https://github.com/rff255/GenesisCA/releases

The version at the top of `package.json` is the single source of truth; each
entry below is cut when that version is tagged (see `.github/workflows/release.yml`).

## [1.25.0] - 2026-07-06

Agent & CA-grid UX batch. Additive and gated throughout — the lattice (2D+3D,
all three compile targets) and every untouched model are byte-identical.

### Agents — brush parity (2D + 3D)
- Full agent brush matching the CA-grid brush: shapes (rect/circle/ring/line,
  volumetric in 3D), Single/Area scope, and modes Add/Remove/Move/Edit/Glue/Cut/Bond.
  Edit reuses the manual-value panel plus geometry rows; `paintAgents` gains an
  optional `geom`.
- Affected-agent highlighting under area brushes, a visible Bond scan-radius
  cursor, brush-cursor visibility parity (with a "Show brush cursor" toggle), and
  an agents-only 2D environment background.
- Topology-aware Layers/brush target; the brush honours the environment bounds
  (no acting or cursor in the letterbox when infinity is off).
- Perf: rAF-coalesced cursor redraws (skipped while playing); a main-area click
  restores keyboard focus so transport shortcuts work.

### Agents — sprites
- Agent sprites: rotation (per-sprite default direction, orient-to-velocity,
  per-agent angle/vector via Set Agent Sprite), scale override, chroma-key
  (pick-from-image), image sequences, and sprite sheets. Set Agent Sprite is now a
  by-id setter (safe no-op in the Init Event).
- Recording fixes: persistent post-recording slowdown (display/blit-source canvas
  de-opt) and stale-trail / stale-agent-on-load artifacts.

### Simulator
- Map Image to Cells dialog (replaces Open-Image): region box + cell-reference
  alignment, zoom/pan viewport, resize-grid vs paste-centered, optional
  manual-input mapping, and Ctrl+V paste. 2D-only.
- Presets: drag-to-reorder and duplicate. Duplicate buttons for
  attributes/variables/mappings/indicators (cell + agent). Indicators: a
  Clear-chart button and a selectable time-axis Window (always bounded, at most
  5000 samples per series).

### Lookup Tables
- User-editable custom row/column labels (kept unique — no ghost columns) and a
  selectable value type (Binary checkbox / Integer / Float / Tag, with tag values
  from an existing attribute). Enables a Golly-style Born/Survive sample with no
  placeholder tag attributes.

### Modeler UX
- Cleaner CA-grid vs Agents separation: Neighborhoods tab elided for agents-only
  models, Mappings panel grouped by topology, all event-root nodes rendered white.
- Graph-aware tag / own-attribute resolution for universal nodes on the Agents
  graph (agent attrs + agent-accessible cell fields), fixing empty tag dropdowns
  and missing value widgets.
- Field-bridge nodes (sampleField/fieldGradient/readCellsUnder/affectCellsUnder/
  secreteToField) gained config UI so field logic is buildable in the modeler.
- Dropped the Randomize action; per-model save defaults.

### Fixes
- Hardened screenshot capture and fixed an agent-WebGPU `GPUDevice` leak
  (load-lifecycle audit).
- Docs sweep (CLAUDE.md batch section, README, in-app Help) and library-model
  updates, including a Game of Life "bumblebee" initial state.

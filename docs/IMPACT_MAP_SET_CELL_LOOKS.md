# Impact Map — merge `Set Color Viewer` + `Set Cell Glyph` → `Set Cell Looks`

Goal: one appearance node with a **Use glyph** toggle. Plain mode = a flat cell
color (today's Set Color Viewer). Glyph mode adds an optional **cell background
color**, a **glyph + glyph color** (keeping the common-glyph picker), and a
**"show glyph color when zoomed out"** option so the macro view stays meaningful.
The mockup (`set_cell_looks_node_and_zoom_behavior`) illustrates the node + the
close-up / zoomed-out rendering.

## Design

New node `setCellLooks` (category `color`, replaces both old types). Config:
`{ mappingId, useGlyph:false, setBackground:true, fallbackToGlyphColor:false }`.

Static ports: `do`, `next`, `r`/`g`/`b` (CELL color — flat in plain mode,
background in glyph mode), `glyph` (inlineWidget `glyph` = the picker),
`glyphR`/`glyphG`/`glyphB` (GLYPH color).

`hiddenPorts(config)`:
- `!useGlyph` → hide `glyph`,`glyphR`,`glyphG`,`glyphB`.
- `useGlyph && !setBackground` → hide `r`,`g`,`b`.

Emit (all three targets, viewer-guarded via the existing `_isV_` hoist /
`activeViewer` compare; `CURRENT_VIEWER_SENTINEL` bypasses the guard in BOTH
modes):
- write the `colors` RGBA buffer with `r/g/b` when `!useGlyph || setBackground`
  (identical to today's Set Color Viewer — this IS the macro/all-zoom appearance);
- write `glyphCodes[idx]` + packed `glyphColors[idx]` from `glyph`/`glyphR/G/B`
  when `useGlyph` (identical to today's Set Cell Glyph).

So the background reuses the always-present `colors` buffer (no new buffer); the
glyph overlay draws on top when zoomed in.

**"Show glyph color when zoomed out"** is a pure RENDER concern (no compiler
change): below the glyph zoom threshold, fill each glyphed cell with its glyph
color instead of skipping. Driven by scanning the model for `setCellLooks`
nodes with `useGlyph && fallbackToGlyphColor` and collecting their `mappingId`s
(sentinel → all viewers); the simulator fills when the active viewer matches.

## Parity / migration

- old `setColorViewer` → `setCellLooks` `{useGlyph:false, setBackground:true}`. Edges (`r/g/b`) unchanged.
- old `setCellGlyph` → `setCellLooks` `{useGlyph:true, setBackground:false, fallbackToGlyphColor:false}`. Its `r/g/b` were the GLYPH color → rewrite edge handles `input_value_r/g/b` → `input_value_glyphR/glyphG/glyphB` and config `_port_r/g/b` → `_port_glyphR/glyphG/glyphB`; `glyph` unchanged. `setBackground:false` preserves the old "glyph node never touches the `colors` buffer" behaviour, so a model that paired a Set Color Viewer (background) with a Set Cell Glyph still renders identically after both migrate.
- New file `src/model/setCellLooksMigration.ts` (mirrors `tagConstantMigration` + the edge-rewrite shape of `moveSelfToNeighborMigration`), wired into `LOAD_MODEL` (ModelContext) and `macroImport`. Idempotent.

## Subsystem-by-subsystem touch points

| Subsystem | File | Change |
|---|---|---|
| Node def | `nodes/SetCellLooksNode.ts` *(new)* | merged def + JS `compile()`; exports `CURRENT_VIEWER_SENTINEL` |
| Node def (retire) | `nodes/SetColorViewerNode.ts`, `nodes/SetCellGlyphNode.ts` | deleted; sentinel moves to new file |
| Registry | `nodes/registry.ts` | swap imports + `ALL_NODES` entries |
| Validation | `nodes/nodeValidation.ts` | one `setCellLooks` case (mapping required unless sentinel) |
| JS compiler | `compiler/compile.ts` | `collectViewerRefs` scans `setCellLooks`; sentinel import |
| WASM compiler | `compiler/wasm/compile.ts` | `FLOW_NODE_EMITTERS.setCellLooks` (combined), drop old two |
| WebGPU compiler | `compiler/webgpu/compile.ts` | flow emitter `setCellLooks` (combined), drop old two |
| Glyph alloc | `compiler/glyphsUsage.ts` | `hasGlyphsInModel` = any `setCellLooks` with `useGlyph` |
| Linked OM | `compiler/linkedOutputMappings.ts` | synthesize `setCellLooks {useGlyph:false}` not `setColorViewer` |
| Drag suggestions | `modelElementDrag.ts` | `mapping-a2c` related node → `setCellLooks` |
| Sink analysis | `compiler/sinkAnalysis.ts` | comment only |
| Node UI | `CaNode.tsx` | merged config UI (Use glyph + background + fallback + pickers + glyph palette); collapsed label + color-dot cases; sentinel import |
| Simulator render | `simulator/SimulatorView.tsx` | zoom-out glyph-color fallback fill + `glyphFallbackViewers` scan |
| Migration | `model/setCellLooksMigration.ts` *(new)*, `ModelContext.tsx`, `macroImport.ts` | convert old nodes on load/import |
| Docs | `CLAUDE.md`, `HelpView.tsx`, `README.md`, `docs/NODES_REFERENCE.md` | node count, glyph/looks sections |

Worker (`sim.worker.ts`), WASM/WebGPU `layout.ts`, `webgpuRuntime.ts`: glyph
buffers already gate on `layout.hasGlyphs` (from `hasGlyphsInModel`) — no code
change, only stale comments mentioning `setCellGlyph` (left as-is or refreshed).

## Verification

tsc; cross-target byte/shape parity via `import()` of the three compilers in
`preview_eval` on a 3-mode fixture (plain / glyph+bg+fallback / glyph-only);
a live worker run of a glyph model on JS + WASM confirming close-up glyphs and
zoomed-out glyph-color fill; load an existing glyph library model to confirm the
migration round-trips.

# Plan — Simulator/agents fix batch (branch `sim_agent_fixes`)

Five user-reported issues, fixed together. Illustrated mockup:
[PLAN_SIM_AGENT_FIXES.html](PLAN_SIM_AGENT_FIXES.html).

## A — 3D "Draw agents in front" is now an option, and helper overlays keep real depth

The 3D view drew agents over EVERYTHING by clearing the depth buffer after the voxel
pass — including over the axes / floor grid / bounds box / brush plane, so a brush
plane in front of the blob was swallowed by spheres. Now ([gl3d.ts](../src/simulator/render/gl3d.ts)):

- The depth-clear applies only vs the **voxels**: after clearing, the helper overlays
  are re-drawn **depth-only** (color-mask off, same viz gates), restoring their depth
  so they occlude/are occluded by agents normally.
- A **"Draw agents in front"** checkbox (3D View panel, agent models only, default ON =
  historical behaviour, persisted in `genesisca_sim_settings.agentsFront3d`) turns the
  clear off entirely — full normal depth for sparse grids where seeing both layers
  interleaved is useful.

Verified: toggling changes 30k px and restores exactly; enabling the brush plane now
*reduces* visible agent pixels where the plane is in front (the depth-restore working).

## B — Brush cursor no longer competes with the running simulation

Three compounding per-pointermove costs were removed:

1. **Cursor overlay layer** — the cell-brush silhouette + agent-brush footprint/scan
   ring (white, on a canvas composited with CSS `mix-blend-mode: difference` — the
   negative-cursor trick moved to the compositor) and the coloured highlight rings (a
   second normal-blend canvas) draw on TWO dedicated overlay canvases above the scene.
   `drawCursorLayer` reads the transform `draw()` stashes in `viewXformRef`; cursor
   movement redraws ONLY the overlays. Bonus: the cursor now stays fluid at display
   rate even when the sim renders at 1 fps (it used to freeze between sim frames).
2. **rAF-coalesced hover pipeline** — the idle mousemove work (screenToGrid, chip,
   O(agents) `agentsInShapeAt`/`pickAgentAt` scans) ran per RAW event (125–1000 Hz
   mice); it now runs at most once per frame (`processHoverWork`). Same for the 3D
   footprint-hover (plane pick + footprint recompute + GL re-render).
3. **Hover chip external store** — the hovered-cell readout was React state that
   re-rendered the whole SimulatorView per cell crossing; it is now a module-level
   store + a tiny memoized `<HoverCoordsChip>` subscriber.

Measured: paused, a 60-move burst = **0 scene draws** (was a full scene redraw per
frame); playing, a 234-move burst leaves the sim's draw rate unchanged (80 → 78/s).
Note: recordings/screenshots no longer include the brush cursor (it lives above the
captured scene canvas) — generally the desired behaviour.

## C — "Phantom" disconnected agents in division-only models

Audited `divideAgent` + the structural phase end-to-end and ran instrumented worker
runs (10k+ generations across three configs, including capacity-saturated with 5,942
overflow rejections): division is atomic on reject and the engine never places a
daughter away from its mother; no position jumps, no phantom births, no isolated
agents appeared in the shipped models. Two REAL hygiene gaps were hardened anyway
([agentEngine.ts](../src/simulator/engine/agentEngine.ts)):

- `initAgentSlot` now zeroes the whole force accumulator (only `forceZ` was reset —
  slots (re)allocated mid-step relied on the next step's 0..highWater fill) and the
  request payloads (`divideAxis*/divideAsym/bondForm*`), so a recycled slot can never
  pair a fresh flag with a previous occupant's payload.
- `divideAgent` rejects on a non-finite mother position/radius instead of placing
  both daughters at NaN (invisible spheres whose forces poison every neighbour).

The visible scatter in the report is most consistent with agents detached by growth
pressure at bond-capacity saturation (agents can't re-attach when every neighbour's
bond list is full) drifting outward — emergent physics rather than an engine defect.
If it reproduces with a specific model file, that file would pin it down.

## D — Loading a model no longer shows the previous model's state

Reproduced: Life3D → Morphogenesis 3D Tissue left Life3D's 1,112 voxels rendering
under the new agents-only model. Root cause: the model-load reinit clears BOTH
`colorsRef` and `lastUploadedColors3dRef` — so the draw-path guard that zeroes stale
voxel instances (keyed on `lastUploadedColors3dRef`) never fired, and the agents-only
worker never ships a colours buffer to overwrite them. The guard now keys on the
renderer's live `instanceCount`. (The agent-side leak in the other direction was
already fixed by `clearAgents`; 2D was already covered via `srcCanvasRef` nulling.)

## E — Save-dialog checkmarks remember the user's last choice for THIS model

Unchecking all three boxes and saving repeatedly re-checked grid+controls each time
(the content-derived defaults re-derive per save; a definition-only save leaves no
snapshot → the deliberate ON-fallback re-arms). New `ModelState.lastSaveOptions`
(in-session only, never serialized): reset by NEW_MODEL/LOAD_MODEL, recorded by
`markSaved(fileName, opts)` on a successful save. The dialog opens with
`lastSaveOptions ?? deriveSaveOptions(model)` — so repeated saves keep the user's
explicit choice, while a freshly loaded model still derives from its own content
(presets iff present, grid/controls from its embedded snapshot's composition).

Verified: all-off stays all-off across saves; loading Amphiphile resets to its own
derivation (controls ON, board OFF, presets ON).

## Verification summary

tsc + `npm run build` clean; JS↔WASM agent parity 12/12 (engine touched → re-run);
agent gate harness all ✓; Growing Tissue division regression 12 → 1500 by gen 220;
all five behaviours verified live in the browser (details above).

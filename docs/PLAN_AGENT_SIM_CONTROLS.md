# Plan — Agent & 3D-Simulator control overhaul (10-part change set)

Illustrated mockup: [PLAN_AGENT_SIM_CONTROLS.html](PLAN_AGENT_SIM_CONTROLS.html)

A batch of UX + behaviour fixes for the Bond-Graph-Agents / 3D-grid simulator. Each
item below maps a user request → the exact code surface. The lattice (2D + 3D, all
three compile targets) and every non-agent model are **byte-identical** — all new
behaviour is additive and gated on `topologyMode.agents` / a default-true flag.

## 1. Independently freeze the CA-grid step and/or the agent step ("interaction" toggle)

The agent step and the cell step run back-to-back every generation
(`sim.worker.ts:3752-3753` JS/WASM, `3698-3708` WebGPU), so a running sim always
moves BOTH layers. Add two **runtime** simulator toggles (persisted in
`genesisca_sim_settings`, NOT the model):

- **Simulate CA grid** → gates `runStep()` / `runStepWebGPU()`.
- **Simulate agents** → gates `runAgentStep()` (movement + the field deposit/gather + the structural phase).

Freezing the agent step stops agents from moving AND from changing cells (the
`AffectCellsUnder`/`SecreteToField` deposit lives inside `runAgentStep`); freezing
the grid step lets agents navigate a static field. New `setSimLayers` worker message
+ two module booleans (default `true` → no behaviour change).

## 2. Clip-plane / brush-plane slider maxes don't update on resize

`clipExt`/`planeMax` (`SimulatorView.tsx:6099-6105`) read `model.properties.gridWidth/Height/gridDepth`,
but the simulator **Resize** button only updates the live `gridWidth.current`/`simWidth`
(it deliberately never dispatches `updateProperties`). Fix: read the live dims
(`gridWidth.current || simWidth`, …) exactly like the brush-size fields already do,
and re-clamp `clip.lo/hi` + `plane.pos` into the new range on a dims change.

## 3. Auto-orbit should spin both directions

The rAF loop does `cam.yaw += speed * dt` (`SimulatorView.tsx:3368`) but the speed
slider is `min=0.05` (one direction). Lower the min to `-2` so the slider spans
negative→positive (0 = stopped); reverse spin already works mathematically.

## 4. Dock the agent brush into the right side panel

The agent brush is a floating canvas overlay (`SimulatorView.tsx:5797-5865`,
`position:absolute`). Move it into a new **Agents** `rightPanelSection` after
Indicators (gated on `isAgentModel`), dropping the absolute positioning. All
state/refs/handlers are component-scoped → no plumbing change.

## 5. Clip plane doesn't clip bonds

Bonds render via the unlit **LINE** program (`gl3d.ts:renderBonds` → `drawLines`),
which has no clip uniforms — so the clip plane (only in the voxel/sphere FS) skips
them. Add a world-pos varying + clip uniforms to `LINE_VS/LINE_FS` and a `clip`
arg to `drawLines`; `renderBonds` passes the active clip (axes/grid/bounds/gizmo
stay unclipped, `clip=null`).

## 6. Clip plane → clip **interval** (slab) instead of a half-space

Today the clip is a single half-space (`discard where w > value`). Replace with an
interval `[lo, hi]` along the axis: **two handles** ("From" / "To"). Visible when
`lo ≤ w ≤ hi`; the gap is the slab thickness. `ClipPlane3D.value:number` →
`{ lo:number; hi:number }`. Updated in all clipping shaders (voxel FS, voxel-pick
FS, sphere FS, sphere-pick FS, the new bond clip) + `setCommonUniforms` /
`setSphereUniforms`.

## 7. Toggle rendering of the CA grid and/or the agents

Two render toggles (`showCaGrid` / `showAgents`, default true, both 2D + 3D):

- 3D: extend `Viz3D` with `voxels`/`agents`; gate the voxel draw + the bond/sphere
  draw in `gl3d.render()`. Gate the **draw**, not the upload, so the GPU buffers
  stay current for re-enable.
- 2D: skip the colour blit (clear the canvas) / skip `drawAgentsOverlay`.

## 8. In 3D, agents always render on top of the grid

Today agents depth-interleave with voxels via `gl_FragDepth`. Per the request
("like 2D, where the grid is the background the agents navigate"), clear the depth
buffer after the voxel pass and before the bond/sphere passes — agents+bonds always
draw on top of the grid while still depth-sorting among themselves.

## 9. Nearby-agent gathering must use an efficient spatial structure

**Already done.** Nearby-agent gathering uses a **uniform CSR spatial hash**
(`agentEngine.ts:buildSpatialHash`) — O(N), 3D-aware (z-major bins, 3×3×3 stencil),
reused scratch (no per-step GC), used in **all four** query sites (Get Nearby Agents
JS + WASM emitters, the force-pass neighbour loop, the auto-bond form pass). A
uniform grid is the appropriate structure for near-uniform agent density (an octree
only wins for highly clustered/sparse distributions and has worse cache behaviour
here). Action: **verify + document** (this milestone) and **fix the stale comment**
at `sim.worker.ts:860-864` that still claims "all-pairs O(N²)". No structural
replacement — that would be a regression.

## 10. Gate the engine physics behind a "Use bonding physics" master toggle

Enabling Agents currently runs the soft-sphere repulsion/adhesion + growth by
default (`customForcesOnly` — the inverse switch — is hidden, hand-edit only). Add a
`CenterBasedConfig.useBondingPhysics?: boolean` master toggle in **Properties →
Bond-Graph Agents**, **default OFF** when enabling agents:

- OFF → no engine soft-sphere, no bond springs, no growth ramp, no auto-bond. Agents
  move only by graph-authored **Apply Force** / **Set Velocity** (+ explicit
  division/death/Form-Bond nodes). The "agents that have nothing to do with bonds"
  case.
- ON → the full center-based tissue engine; the Forces + Bonds parameter rows appear.

`usesBondingPhysics(cfg) = cfg.useBondingPhysics ?? !cfg.customForcesOnly` — the
back-compat fallback reproduces **every** existing model's behaviour with **no
migration** (a loaded file with neither field resolves to `!customForcesOnly` =
today's `engineForces`). The worker gates soft-sphere (`engineForces`), bond springs,
growth (`growthRate→0`), and auto-bond on the resolved flag. The previously-hidden
`momentum` / `maxSpeed` / `neighbourQueryRadius` are surfaced too (a new **Motion**
section, always shown — they matter to custom-force models).

## Cross-cutting verification

- `tsc -b` clean; lattice (GoL 2D, Life3D ×3 targets) byte-identical.
- Load **Boids** (custom forces) + **Morphogenesis Tissue** (bonding physics) + a 3D
  agent model; exercise: layer show/simulate toggles, clip interval + bond clipping,
  agents-on-top, resize → slider maxes track, auto-orbit reverse, docked agent brush,
  the bonding-physics toggle reveal/hide.

# HANDOFF — scene wireframes (bounds / grid / axes) occlude correctly in free mode

**Branch**: `optimize`. **Status**: READY. Render-only. Read CLAUDE.md
"L1 — worker-side WGSL voxel render" (the free-mode two-canvas architecture you
are fixing), the §10 VoxelView uniform-layout trap (if you add a uniform), and
gl3d's overlay + line-pipeline code (`gl3d.ts`: `renderOverlays`,
`renderBrushPlane`, the `LINE_*` program, `setOverlaysOnly`, the `Viz3D` flags).

## The bug (user-reported)

In the free-mode 3D voxel render, the **bounds box, floor grid, and main axes are
always drawn IN FRONT of the cells** — a wireframe that should be occluded by
voxels between it and the camera instead composites on top.

## Root cause (confirmed)

Free mode is a TWO-CANVAS split: the worker's WGSL renderer draws the voxels into
the voxel canvas (`z-index:1`), and gl3d — with `overlaysOnly = true` — draws ONLY
the overlays into its own transparent canvas (`z-index:2`) ON TOP, then RETURNS
before ever drawing voxels (`gl3d.ts` render(), the `if (overlaysOnly) { … return; }`
block ~:2345). Two canvases ⇒ two separate depth buffers ⇒ the overlay canvas
always composites above the voxel canvas, so bounds/grid/axes can never be
depth-occluded by the voxels. In FRAME mode (one gl3d canvas, one depth buffer,
voxels + overlays together) they occlude correctly — so this is FREE-MODE-ONLY.

## The fix — the free-mode renderer owns the scene-anchored wireframes

Draw the **bounds box, floor grid, and main axes** in the WORKER's WGSL voxel
renderer (`webgpuRuntime.ts`), depth-tested against the SAME depth buffer the
voxel cube pass writes (the voxel render already has a `depth24plus` attachment —
CLAUDE.md L1 / §10). Then STOP drawing those three in gl3d's `overlaysOnly` path
so they aren't double-drawn. Keep everything else gl3d draws in free mode ON TOP
(they are meant to be always-visible UI, not scene geometry): the **gizmo**
(corner widget), the **brush interaction plane + outline**, **hover cells**, and
**axis labels**. Only the scene-anchored wireframes (bounds/grid/axes) move.

Design notes:
- Add a small WGSL LINE pipeline to the voxel renderer: `vec3` position +
  `vec3` colour, an MVP uniform (reuse the voxel `VoxelView` MVP — the SAME
  main-thread `sceneCameraMatrices` source gl3d uses, so the two renderers can't
  disagree on projection), depth-test ON + depth-write ON, drawn AFTER the cube
  pass (or before — depth test handles order). Line-list topology; generate the
  bounds/grid/axes vertices from the grid dims (mirror gl3d's `renderOverlays`
  geometry: the bounds box edges, the floor-grid lines stepped like gl3d's
  `>100 cells/axis` rule, the RGB axes from the origin with arrowheads — see
  gl3d's "3D viewport feedback round 6/7" origin-axes geometry).
- The colours/step/toggle semantics must match gl3d: the `Viz3D` `axes`/`grid`/
  `bounds` flags gate each; thread them to the worker (a field in the camera/view
  message, or a small `setGridViz` message). When a flag is off, draw nothing.
- **If you add a VoxelView uniform field**, keep `verify-render-uniform-layouts.mjs`
  green (the §10 padding trap — `vec3` size-12/align-16). Prefer a SEPARATE line
  uniform buffer over widening VoxelView, to avoid touching the cube struct.
- gl3d's frame-mode rendering is UNCHANGED — it still draws bounds/grid/axes in
  frame mode (one canvas, correct depth). Only its `overlaysOnly` (free-mode)
  branch stops drawing those three.

## Verify (screenshots REQUIRED; the pane is DISPLAYED)

Load the Accretor (WebGPU, 3D), play into free mode, and orbit so the bounds box
/ grid / axes pass BEHIND part of the growing structure:
- The wireframe must be OCCLUDED by voxels in front of it and VISIBLE where no
  voxel is between it and the camera (screenshot the before/after).
- Toggle Axes / Grid / Bounds — each shows/hides in free mode.
- The gizmo, brush plane, brush outline, hover cursor, and axis labels still
  render ON TOP (unchanged).
- Flip to frame mode (Shift-inspect / pause) — the overlays still occlude
  correctly (gl3d path unchanged), and the free↔frame flip is visually
  consistent (the wireframe looks the same in both).
- A 3D WASM model (Life3D, gl3d frame-mode always) is unchanged.

## Gates
`npx tsc -p tsconfig.app.json --noEmit`, `npm run build`,
`node scripts/parity-agent-wasm.mjs`, `node scripts/parity-agent-force.mjs`,
`node scripts/verify-agent-render.mjs`, `node scripts/verify-render-uniform-layouts.mjs`.
No compiler files expected — assert with `git diff --stat`.

## Hard rules
Commit on `optimize` staging EXPLICIT paths (NEVER `git add -A`); NEVER push;
NEVER add Co-Authored-By / Claude / Anthropic attribution; NEVER bump the
version; multi-line commit messages via `git commit -F <file>`; `sim.worker.ts`
mojibake comment bytes — anchor on ASCII; measure scope against `origin/master`.

Update CLAUDE.md (the L1 section) + this doc's Completion Report. Finish with the
before/after screenshot evidence.

## Completion Report
(fill in when executed)

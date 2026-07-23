# PHASE D HANDOFF — Field-Decoupled Grid+Agents (residency relax + layered render)

Read first: [HANDOFF_GPU_AGENT_RENDER.md](HANDOFF_GPU_AGENT_RENDER.md) §0/§3 +
ALL Status Board rows in §4 (every lesson binds you); then this doc; then the
A1/A2/A1.5/C Completion Reports (you extend the same seam; the C report seeds
this phase's layering approach); then PLAN_GPU_AGENT_RENDER.md § Extension
roadmap Phase D. CLAUDE.md context: the A1/A2/A1.5/C direct-render
subsections, "Agent-engine performance review round" (residency), and the
WebGPU grid section's direct-render bullets (the grid canvas you now
composite with).

**Problem**: everything so far requires agents-ONLY models (`gridCells ===
false`) — a proxy for the real constraint, which is FIELD COUPLING (the
agent↔grid morphogen round-trip). A grid+agents model whose agent layer never
touches a cell field is two INDEPENDENT simulations sharing a viewport: the
agent layer could be resident + direct-rendered while the grid steps and
renders by its existing path.

**Objective**: replace the agents-only proxy with the true first-principles
term — "no field coupling" — in BOTH the residency gate and the render gate,
and composite the render as layers: the grid below (its existing render path,
any target), the transparent agent canvas above (today's z-order — agents
always draw over the grid in 2D).

**The decoupling predicate** (general; compute ONCE, share both gates):
`agentUsesField === false` (the compile-side flag — no field node reachable)
AND `fieldSpecs.length === 0` (no cell attribute has `agentAccess !== 'none'`
— defence-in-depth: with no field nodes the ABI threads nothing, but the
predicate should be belt-and-braces and cheap). Everything else in each gate
stays as-is (sprites/metaballs/bonds/alpha terms per mode; the resident gate
keeps its other exclusions).

---

## Work items

1. **Worker — residency relax** (`sim.worker.ts`):
   - `agentResidentEligible`: replace `!gridCellsEnabled` with the decoupling
     predicate. Everything else unchanged.
   - The step-batch loops: today the resident branch is taken only for
     agents-only models. For a decoupled grid+agents model the batch must run
     BOTH: the resident agent batch (one submit, N gens) AND the grid's N
     cell steps (its existing per-gen path — JS/WASM sync loop or the WebGPU
     grid branch). They are order-independent BY THE PREDICATE (no shared
     state), so structure it simply: run the cell steps first (synchronous
     for JS/WASM), then await the resident agent batch, then the colour pass
     + sendColors as today. For a WebGPU GRID + resident agents, both are
     async — run them sequentially within the existing
     `asyncStepBatchInFlight` deferral (NEVER a second ad-hoc queue; the P0
     lesson). Generation counting: the existing loops already `generation++`
     per cell step — make sure it counts ONCE per gen, not per layer.
   - The readback policy / one-shot rule are unchanged (they're about the
     agent store only).
2. **Render gate + composite** (`SimulatorView.tsx`):
   - The direct-render gate's `topologyMode.gridCells === false` term
     relaxes to `(gridCells === false || decoupled)` (the flag threaded from
     the compile result like `agentUsesDensity`).
   - `draw()`: when agent direct render is active AND the grid layer shows,
     draw the grid EXACTLY as today (srcCanvas blit / putImageData path, or
     the grid's own direct-render blit), THEN blit the agent canvas 1:1
     above it (2D). The agent canvas clear must be TRANSPARENT in this
     configuration even when `bg2d` is set (the grid IS the background —
     mirror the existing `showGrid2d` logic that suppresses the bg fill).
   - 3D: the C seam already layers under gl3d; for decoupled grid+agents 3D
     the gl3d VOXEL pass must still render (it is NOT skipped — only
     agents/bonds are skipped in overlays-only... which means overlays-only
     is wrong here). Scope decision, deliberate: **3D grid+agents keeps the
     CPU path in D** (the gate keeps `is3D → agents-only`); lifting it needs
     voxels-vs-spheres depth compositing across two canvases, which is
     Phase E territory (one device, one canvas). Document this in the gate
     comment + Help.
3. **Recording/screenshot**: the 2D agent-model capture path reads the
   DISPLAY canvas (which now holds grid + agent blits) — verify unchanged
   correctness; recording still flips frame mode.
4. **Fallbacks**: field-coupled models (Ant Necrophoresis, Chemotaxis) must
   keep TODAY'S paths bit-for-bit (their `agentUsesField` is true). Sprites/
   metaballs/bond terms unchanged.

## Do NOT touch
Compilers (the decoupling flag already exists compile-side — if a new flag
is genuinely needed, it must be a general property and the identity
discipline applies; expected: NO compiler changes), agentEngine, gl3d beyond
what C already added.

## Verification (all mandatory)
- tsc, build, parity ×2; `git diff --stat` audit.
- In-browser (worker message-count probes):
  - A SYNTHETIC decoupled grid+agents model (none shipped — build one
    in-memory from general edits: take Boids, set `topologyMode.gridCells
    = true`, give the cell graph a trivial Step (e.g. GoL's graph spliced,
    or an empty Step root) and NO agentAccess attrs): on the WebGPU agent
    target it ENGAGES residency + direct render (free mode, no snapshot),
    the GRID evolves simultaneously (getState cell attrs change per gen),
    generation counts once per gen, 0 errors. On a CPU agent target it
    engages the snapshot-fed render with the grid below.
  - Z-order: the agent canvas composites ABOVE the grid blit (pixel probe
    where a disc overlaps a live cell).
  - Ant Necrophoresis + Chemotaxis: `agentUsesField` true → ineligible →
    byte-identical behaviour (their stepped flow unchanged, snapshots ship
    as today).
  - Agents-only models: unchanged (the relax is additive).
  - Recording a decoupled model contains BOTH layers.
- Note for the eyeball list: the composite's visual (grid under agents)
  needs a visible pane.

## Completion Report
(fill in when done — commits, deviations + why, measured numbers, gotchas,
notes for E)

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

## Completion Report (2026-07-23)

**Commit** (branch `optimize`, not pushed): one commit — "perf(agents): D field-decoupled
grid+agents residency + layered render". `git diff --stat` = exactly two files:
`sim.worker.ts` (+~34 net) + `SimulatorView.tsx` (+~23 net). **NO compiler files, NO
agentEngine, NO gl3d** — the decoupling flags (`agentUsesField`, `fieldSpecs`) already
existed compile-side, so D is render + worker only, exactly as the handoff predicted.

**What shipped vs the spec** (all work items done; deviations, all justified):
1. **The decoupling predicate is TWO terms, both already present-or-cheap.** The worker
   gate already had `&& !agentUsesField`; D only ADDED `&& fieldSpecs.length === 0` and
   REMOVED `&& !gridCellsEnabled`. So the full predicate (`!agentUsesField &&
   fieldSpecs.length === 0`) is the two terms the handoff names, grouped + commented as
   one. The main-thread gate computes its own equivalent (`!agentUsesField() &&
   model.attributes.every(a => !a.agentAccess || a.agentAccess === 'none')`).
2. **Resident batch runs the agent batch FIRST, grid steps second (inside `if (ok)`)** —
   a justified deviation from the handoff's "cell steps first, then await the resident
   batch." They're order-independent (decoupled = no shared state), and `runAgentBatch
   Resident` advances NOTHING on failure (it returns false before `generation += count`
   and before mutating the SoA), so running it first means a bailout falls through to the
   existing per-gen loop with a clean, un-stepped grid. Stepping the grid first would
   double-step it on fallback. Equivalent result, safer failure mode.
3. **`bumpGeneration` param on `runAgentBatchResident`** (default true) — the cleanest way
   to "count once per gen." Agents-only keeps the batch owning the count (true); a decoupled
   batch passes false and the cell-step loop's `runStep(true)` does the `generation++`.
4. **`draw()` needed NO change.** The existing 2D structure already blits the grid
   (`showGrid2d` → srcCanvas) THEN the agent canvas above, and already suppresses the CPU
   bg fill when the grid shows. The ONLY render tweak was `computeAgentRenderView`: clear
   the agent canvas TRANSPARENT (bgA=0) when `showGrid2d` so the grid shows through
   (mirroring the draw() bg-fill suppression). The grid renders via its normal
   `colors → srcCanvas → putImageData` path (the grid's own direct-render attach is gated
   `!agentModel`, so an agent model never GPU-direct-renders the grid — the composite is
   always CPU-grid-blit + GPU-agent-blit).
5. **The per-gen fallback loop needed NO change** — it already steps both layers (grid
   `runStep(true)` + agent `runAgentStepWebGPU`) and counts once (grid step increments; the
   agent step does not). So a decoupled model that's residency-INELIGIBLE (e.g. resident
   batch bailed) or CPU-target already worked correctly through the existing loop; D just
   adds the resident FAST path on top.
6. **3D grid+agents keeps the CPU path** (the `&& !is3D` on the decoupled render arm), per
   the deliberate scope decision — documented in the gate comment + Help. NOTE: the WORKER
   residency has NO 3D restriction, so a 3D decoupled grid+agents model can still run its
   SIM resident (one submit) and render via gl3d from the readback snapshot (UI-sync stays
   ON when render inactive → snapshot ships). Only the DIRECT render is 3D-excluded.

**Measured** (real WebGPU, in-browser, hidden pane → worker protocol + `getState` +
a TEMP `__dresident` probe, since removed):
- SYNTHETIC decoupled model (Boids agents + GoL cell side, WASM grid, no agentAccess),
  WebGPU agent target: resident batch engaged (`{bump:false, count:8, grid:true}` then
  `{bump:false, count:4, grid:true}` — one submit per batch), free mode ships
  `hasAgents:false` + `agentLiveCount:260` + grid colours (57600 = 120²×4), grid EVOLVES
  (seeded 20×20 block: aliveSum 400→328 over 4 gens = GoL ran), generation counts ONCE
  (0→8→12 over 8+4 steps), 0 errors.
- Same model, CPU (js) agent target: A2 snapshot-fed render engages (free mode
  `hasAgents:false` + liveCount 260) + grid steps below (colours ship), 0 errors.
- Ant Necrophoresis + Chemotaxis (`agentUsesField` true): NO resident batch, per-gen CPU
  path ships agents + colours, 0 errors.
- Agents-only Boids (WebGPU): unchanged (resident `{bump:true, count:10, grid:false}`,
  free mode, no colours).
- Gates: tsc + `npm run build` + `parity-agent-wasm` (18) + `parity-agent-force` (7) green.

**Could NOT verify (occlusion trap, master §0.7)**: the composited PIXELS (grid under
agents), the z-order pixel probe (a disc overlapping a live cell), and a recording of a
decoupled model containing BOTH layers — the Browser pane reports hidden, so the
compositor is suspended and `drawImage(transferredCanvas)`/screenshots read stale/blank.
The composite is proven by CONSTRUCTION: the existing `draw()` already blits grid-then-
agent (unchanged), and the transparent-clear tweak is verified logically (bgA=0 when the
grid shows). **A visible-pane spot-check should confirm the grid shows under the agents.**

**New gotchas / notes for E:**
- **The step-batch has THREE branches**; D touched only the middle one (`agentStore &&
  agentTarget === 'webgpu' && agentWebgpuRuntime` — JS/WASM grid + WebGPU agents). A
  WebGPU-GRID + WebGPU-agent decoupled model goes to the `webgpuActive` branch, which runs
  agents via the JS `runAgentStep()` (NOT the resident path) — so it renders fine
  (present-from-store, no staleness) but does NOT run resident. E (unified device) is the
  place to make a WebGPU grid + resident agents share one device/submit; today they don't
  interleave in the resident path. The handoff's "WebGPU GRID + resident agents both async"
  is aspirational — the current webgpuActive branch structure doesn't route WebGPU agents
  resident, and it wasn't needed for D's primary case (the synthetic uses a WASM grid).
- **Loading a new model RECREATES the worker** (`window.__simWorker` changes) — an
  in-browser message listener attached to the old worker goes stale silently (a step
  reaches the new worker but your capture never fires). Re-attach the listener on the
  CURRENT `window.__simWorker` after every model load. (Cost me two confusing empty
  captures on the Ant/Chemotaxis loads.)
- **E (unified device, resident field bridge, one canvas)** can build directly on D: the
  field-coupled models are the ones D EXCLUDES (`agentUsesField` true). E makes the field
  round-trip resident (same-device zero-copy) so those models qualify too, and folds the
  grid + agent + overlay render into one device/canvas — at which point the `&& !is3D`
  render restriction (D's 3D scope carve-out) can lift (voxels + spheres depth-composite
  on one device). D's worker-residency-has-no-3D-restriction (only the render does) is the
  seam E extends.
- **`fieldSpecs.length === 0` slightly tightens the agents-only case** vs the old
  `!gridCellsEnabled`: an agents-only model that happened to carry a cell attr with
  `agentAccess !== 'none'` would now be residency-INELIGIBLE (whereas `!gridCellsEnabled`
  made it eligible). This never occurs in practice (agents-only = no cell field; the grid
  is off so a field bridge can't work anyway), and the new predicate is semantically MORE
  correct. All shipped agents-only models have zero agent-accessible cell attrs.

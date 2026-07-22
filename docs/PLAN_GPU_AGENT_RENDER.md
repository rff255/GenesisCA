# Plan — GPU-Resident Agent Render (A) + Bin-Sorted Iteration (B)

Prereq reading: [IMPACT_MAP_GPU_AGENT_RENDER.md](IMPACT_MAP_GPU_AGENT_RENDER.md)
(subsystem impacts, feature matrix, risks). Illustration:
[PLAN_GPU_AGENT_RENDER.html](PLAN_GPU_AGENT_RENDER.html).

Ground rules (from the user):
1. **Every current feature keeps working.** A feature may cost a readback
   while in use; it must never lose function.
2. **First principles only.** Gates and optimizations key on general model
   properties (topology, target, capability/usage flags, density) — never on
   a specific model's shape. Boids and morphogenesis-class models must
   benefit wherever the same general conditions hold.

---

## Phase A1 — direct render for resident-eligible models (the headline)

**Eligibility (all general):** 2D + agents-only (`topologyMode.agents &&
!gridCells`) + resolved agent target `webgpu` + resident-eligible (the
existing `agentResidentEligible`) + OffscreenCanvas supported + no CPU-only
visual active (model has no sprites; metaballs off). Anything else: today's
path, unchanged.

1. **Render pipeline** (`agentWebgpuRuntime.ts`):
   - `AGENT_RENDER_WGSL`: VS pulls `agentF32[x/y/radius]` + `agentColors`
     by `instance_index % highWater`; copy index = `instance_index /
     highWater` → world offset from the tiling uniform (torus copies).
     Camera uniform maps world→clip. Dead/invisible agents emit a degenerate
     quad.
   - FS: disc SDF, premultiplied output; optional outline rim (uniform flag =
     the existing `agentOutlines` setting); optional **glow** mode — additive
     blend + radial falloff (`glowSize/intensity/steepness` uniforms), a new
     Graphics option for ALL agent models (CPU path gets a cheap
     shadowBlur-free approximation later or simply doesn't offer it — TBD in
     review; the option is stored as a simulator setting, not model schema).
   - `ensureAgentRenderPipeline` + `presentAgents(encoder)` appended to
     `dispatchResidentBatch`'s single submit; `presentAgentsOnce()` for
     camera/mutation/refocus refreshes.
   - Canvas config mirrors the grid: `rgba8unorm`, `premultiplied`,
     clear colour = `bg2d` (worker receives it via the camera message).
2. **Worker** (`sim.worker.ts`): `attachAgentCanvas` (clone of the grid
   handler), `setAgentCamera`, the **readback policy** (`free`/`frame` +
   the ONE-PLACE one-shot rule in the message dispatcher: any agent-reading /
   agent-mutating message while `agentStoreStale` → `readbackAgentFrame`
   first), `stepped` ships `liveCount` scalar in `free` mode.
3. **SimulatorView**: the gate; the two-phase attach (+ soft-recompile
   re-attach + `refreshDisplay` analogue); `draw()` blits the worker canvas
   1:1 and skips `drawAgentsOverlay`; pan/zoom/resize → `setAgentCamera`
   (rAF-coalesced); the **UI-sync driver** (brush-armed pointer / pinned
   inspector / edit target / recording / paused ⇒ `setAgentUiSync on`).
4. **Verification** (in-browser, real UI — the standard):
   - Boids + Particle Life 50k: fps with the panel closed vs open; expect
     render-side cost ~0 and worker-only frames; visual parity vs the CPU
     overlay (disc positions/colours/outlines), infinity tiling seams, pan/
     zoom crispness.
   - Feature sweep while free-running: brush add/remove/move/edit lands
     (values asserted via `getAgentState`), inspector values correct
     mid-run, save→load round-trip equals a paused save, recording produces
     frames with agents, screenshot matches, stats chip live.
   - The hostile staleness test: fire every mutating/reading message with
     readback off and assert no stale value is ever served.
   - Cross-checks: JS/WASM targets byte-identical behaviour (no compiler
     changes); 3D unchanged; a sprites model falls back cleanly.

## Phase A2 (optional, later) — the same renderer for non-resident paths

The pipeline is snapshot-agnostic: feed it by UPLOADING the f32 snapshot
(positions/colors) instead of reading the resident buffers. That gives the
~10 ms Canvas2D draw savings to **JS/WASM agent targets and per-gen WebGPU
models too** (upload 50k×12B ≈ 0.6 MB ≪ readback we already do). Same
shaders, same camera, same gates minus residency. Do after A1 proves the
seam.

## Phase B — bin-sorted neighbour iteration (the sim-side multiple)

- **B1 (no compiler changes):** extend the resident hash build with a scatter
  pass writing a bin-sorted, field-major mirror of the SoA + `sortedId`; the
  ENGINE force pass (soft-sphere/density — runs for gas/collision models)
  iterates bin runs against the mirror. Pure win where the scan runs at all.
- **B2 (compiler):** when a `forEachInArray` consumes a `getNearbyAgents`
  array directly (the dominant shape in every gather model — Boids, PL,
  GoL-on-agents), fuse the loop to iterate the bin runs in sorted order,
  reading neighbour FIELDS from the mirror; materialize the canonical id
  (`sortedId[s]`) only where the body consumes identity itself (Form Bond
  targets, id comparisons, arrays stored to variables). Explicit rule, badged
  by tests; unfusable shapes keep the canonical path (correct, just unsorted).
- **Verification:** bit-parity is NOT expected vs the unsorted GPU order
  (float sum order changes — within the documented WebGPU statistical-parity
  stance); assert statistical equivalence (Boids polarization, PL clustering)
  + exact neighbour-SET equality on a frozen frame; re-run bench at 2k/10k/
  50k × densities to publish the multiple.

## Sequencing + effort

A1 is the milestone (worker+runtime+SimulatorView, no compilers) — the
biggest UX win and the lowest risk. A2 is a small follow-up. B is a separate
sim-side milestone with compiler surface; measure after A1 (the render win
changes what's worth chasing).

## Extension roadmap — v1 limits are SCOPING, not theory

The v1 gates pick the smallest correct step, not the reachable ceiling. The
honest fundamentality audit, restriction by restriction:

**Already covered today (broader than it looks):** the resident SIM
(`agentResidentEligible`) has **no 3D term** — a 3D agents-only model on the
WebGPU target already runs its generations GPU-resident (the hash params
carry depth); only its RENDER still round-trips to feed the WebGL2 viewer.
And the density skip / splat / snapshot slims benefit every agent model on
every target, grid+agents and 3D included.

**Phase C — 3D direct render (scoping, not fundamental).** The WebGL2 gl3d
context can't share WebGPU buffers, but nothing stops the agent runtime from
rendering 3D itself: a WGSL **sphere-impostor pass** (the same billboard-
raycast math gl3d's GLSL uses) + depth buffer into the OffscreenCanvas.
The mode machinery makes a clean hybrid: `free` mode = WGSL spheres from the
resident buffers; `frame` mode (interaction/recording) = the snapshot ships
and gl3d renders exactly as today, overlays/gizmos and all. Work items:
matching the lighting model between the two renderers, and keeping
pick/inspect on the gl3d path (it's frame-mode by definition).

**Phase D — grid+agents WITHOUT field coupling (scoping).** When the agent
graph never touches a cell field (no field nodes, no `agentAccess` attrs —
flags we already compute), the two sims are independent: the agent layer can
be resident while the grid steps on its own. Relax the gate's
`!gridCellsEnabled` proxy to "no field coupling", and composite the RENDER as
**two canvases** (the grid's direct-render canvas below, the transparent
premultiplied agent canvas above — `draw()` already blits one; blitting two
is trivial, and agents-above-grid is today's z-order anyway).

**Phase E — the unified device (the real unlock for field-coupled models).**
The ONLY reason Chemotaxis/Ant-class models round-trip the field per
generation is that the grid runtime and the agent runtime are **two separate
GPUDevices** — our code structure, not hardware. Unify them on one device
and the agent shader reads/deposits **directly on the grid's attribute
buffers** (the deposit atomic-CAS shader code already exists — it currently
targets a CPU-round-tripped copy): grid step → agent behaviour → deposits →
next grid step, all resident, plus a single render pass compositing grid +
agents on one canvas. The biggest refactor in this roadmap, and fundamental
to nothing.

**Phase F — widening resident eligibility (each item staged, none
fundamental):**
- *Sync agent attrs* → a GPU copy/ping-pong pass per gen (the posCommit
  pattern).
- *Springs / growth* → the bond store already has a GPU binding (11); growth
  is a one-line ramp in posCommit.
- *Positional collision* → the Jacobi projection is order-independent BY
  DESIGN — ideal as a GPU compute pass (arguably more natural there than on
  the CPU).
- *Spawn* → the atomic spawn cursor already exists; reconcile per frame
  instead of per gen.
- *Stop events* → a 4-byte flag readback per batch — trivially compatible
  with residency.
- *Indicators* → GPU atomic accumulation + a small per-frame readback (the
  grid's `webgpuReduce` is the precedent).
- *Structural (division/death/bond requests)* → the eigensolve stays CPU,
  but only the small per-agent REQUEST fields need per-gen polling, not the
  full SoA — "request-polling residency" gets morphogenesis-class models
  most of the win.

**Actually fundamental (unchanged by any phase):** asynchronous GRID update
mode on WebGPU; order-dependent ops (toggle/next/previous indicators,
cross-agent overwrite order); and the JS/WASM SIM staying on the CPU — by
definition of picking a CPU target (A2 still hands those targets the render
win).

## Explicit non-goals

- No dt-continuous time (GenesisCA is a discrete-generation tool).
- No AoS conversion, no per-model packed interaction words (table generality
  stays).

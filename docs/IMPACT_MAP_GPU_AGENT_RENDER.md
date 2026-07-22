# Impact Map — GPU-Resident Agent Render (A) + Bin-Sorted Iteration (B)

**Goal**: extract WebGPU's full benefit for agent models the way dedicated GPU
particle apps do — render straight from the simulation's GPU buffers, read back
to the CPU only when a feature actually needs CPU state — while **every existing
feature keeps working** (interaction, recording, inspector, save/load may cost a
readback while active, never lose function) and **every optimization stays
first-principles** (keyed on general model properties — topology, compile
target, capability/usage flags — NEVER on "this looks like Particle Life").
Beneficiaries today: Boids, Particle Life 2D, any custom-force agents-only
model; automatically: every future model that satisfies the same general gates.

Companion analysis: [COMPARISON_SANDBOX_SCIENCE_PL.md](COMPARISON_SANDBOX_SCIENCE_PL.md).
Plan + illustrated mockup: [PLAN_GPU_AGENT_RENDER.md](PLAN_GPU_AGENT_RENDER.md) / `.html`.

---

## 0. The two first principles the whole design hangs on

- **FP-1 — The render is a VIEW of engine-owned state.** The proposed render
  pipeline reads ONLY engine-owned SoA fields (`x`, `y`, `radius`, `alive`,
  `colors`) that exist for **every** agent model regardless of its rule graph.
  It therefore needs **zero compiler changes** and is graph-agnostic by
  construction — a Boids flock, a morphogenetic gas, and a particle soup all
  render through the identical pipeline. (Colour is whatever the model's
  Set Cell Looks / Agent Output Mapping already computed into the GPU
  `agentColors` buffer.)
- **FP-2 — The CPU never *needs* per-frame agent state; specific FEATURES do.**
  Today the per-frame readback exists because the *render* is a CPU consumer.
  Once the render is GPU-side, each remaining CPU consumer is an identifiable
  feature (brush, inspector, save, recording…) that can request state
  **on demand** — so the cost model becomes "free when idle, pay while used",
  which is exactly the behaviour the user asked for.

---

## 1. Subsystem-by-subsystem impact

### 1.1 `agentWebgpuRuntime.ts` (the core of A)
- **New: agent render pipeline** — instanced quads (`draw(4, highWater)`),
  vertex-pulling `x/y/radius` from `agentF32` and packed RGBA from
  `agentColors` (both ALREADY on the GPU for any WebGPU-agent model — resident
  or per-gen). `alive==0` or `a==0` → degenerate quad (discard). Fragment:
  disc SDF + optional outline rim (the `agentOutlines` option) + optional
  additive **glow** (radial falloff, one pass — a new general Graphics option
  for all agent models, not a PL feature).
- **New: camera + tiling uniforms** — `{centerX, centerY, scaleX, scaleY}`
  world→clip, and `{start, numCopies}` for infinity tiling via render-side
  instancing (`instance = agent × copy` — the SandboxScience technique, which
  is also exactly our torus semantics).
- **New: canvas plumbing** — mirror the GRID's proven direct-render seam
  (`setupDirectRender`, `webgpuRuntime.ts:505-546`): `getContext('webgpu')`,
  `rgba8unorm`, `alphaMode:'premultiplied'`, background = clear colour
  (`bg2d`). Present = a render pass appended to the SAME encoder as the
  resident batch (one submit per frame — the whole point), plus a
  present-only dispatch for camera changes / mutation refresh / tab-refocus.
- **Changed: `readbackAgentFrame` becomes policy-driven** (see 1.2) instead of
  unconditional at the end of every resident batch
  (today: `sim.worker.ts:2008`).
- **B (later): sorted-mirror regions** — after the existing count+scan hash
  passes, a scatter writes a bin-SORTED mirror of the SoA (field-major) +
  `sortedId`, so neighbour iteration reads contiguous runs. Runtime-only
  buffers; the canonical SoA keeps agent identity stable (unlike
  SandboxScience, our agents HAVE identity — bonds, inspector, brushes — so we
  sort a read-mirror, never the agents themselves).

### 1.2 `sim.worker.ts`
- **New message `attachAgentCanvas`** — clone of the grid's `attachCanvas`
  handler (`:5819-5840`): store the OffscreenCanvas on the agent runtime, set
  up the render pipeline, present once, ack with a status message.
- **New message `setAgentCamera {cx, cy, sx, sy, tiling?}`** — updates the
  camera uniform + present-only dispatch (no step). Sent by SimulatorView on
  pan/zoom/resize (cheap, coalesced to rAF).
- **New: readback POLICY** — a small state machine replacing the unconditional
  per-frame readback:
  - `frame` (today's behaviour): readback + ship the snapshot every batch.
    Active while the main thread holds it on (`setAgentUiSync {on:true}`) —
    i.e. while a feature needs live CPU state.
  - `free`: no readback, no snapshot in `stepped` (the protocol ALREADY
    tolerates this — SimulatorView only updates on `msg.agents !== undefined`,
    `SimulatorView.tsx:3131`). A worker-side `agentStoreStale` flag records
    that the CPU store lags the GPU.
  - **One-shot syncs**: `getAgentState` (`:6140`), `getState` (`:6234` —
    today it never readbacks the AGENT runtime, a latent gap the explorers
    confirmed), pause, and any incoming mutation message while stale →
    `readbackAgentFrame` first, then serve/apply. This is the load-bearing
    correctness rule: **no CPU consumer ever sees stale state; it just pays a
    one-shot readback (~2 ms at 50k).**
- **Changed: `stepped` payload** — in `free` mode carries `liveCount` from the
  cached store value (correct: resident-eligible models have no structural
  phase, so liveCount changes only via CPU mutations, which flip the dirty
  flag anyway).
- **Unchanged**: `agentGpuUploadPending` (mutations → re-upload) already
  covers the write direction (`:4884-4889` → `:1962-1966`); the deferral of
  mutations during in-flight batches already exists (`AGENT_GPU_DEFER_TYPES`).

### 1.3 `SimulatorView.tsx`
- **Gate** (mirrors the grid's, `:3741-3761`): direct agent render iff
  `topologyMode.agents && !gridCells` (agents-only) AND 2D AND resolved agent
  target is `webgpu` AND `transferControlToOffscreen` exists AND **no
  CPU-only visual is active** (sprites present in the model, metaballs/goo
  enabled → fall back to today's CPU overlay path wholesale — function first;
  these can be ported later, see plan phases). All general properties — FP-0.
- **Two-phase attach** — reuse the exact grid handshake (fresh placeholder
  canvas → `transferControlToOffscreen` → attach message → ack → swap
  `blitSource`), including the `recompilePendingCanvasRefresh` analogue for
  soft recompiles and the `refreshDisplay` analogue for the tab-hidden
  unpresented-canvas case (`:5175-5183` / worker `:5784-5811`).
- **`draw()`** — under direct agent render: skip `drawAgentsOverlay` and blit
  the worker canvas 1:1 (camera lives in the worker). Cursor overlays are
  untouched — they already live on the separate `cursorNeg`/`cursorHl`
  layers above the display canvas.
- **The "UI sync" driver (the coexistence heart)** — SimulatorView flips
  `setAgentUiSync` ON while any of: pointer over the canvas with the agent
  brush armed; an inspector popover pinned or a sweep in progress; the edit
  panel targeting an agent; **recording**; the sim paused. OFF otherwise
  (idle watching = zero per-frame CPU cost). While ON, everything behaves
  byte-for-byte like today (snapshot ships, picks/hover/membership scans read
  it, `drawAgentsOverlay` is *still skipped* — the GPU frame stays the
  renderer; only the DATA flows again).
- **Pick/hover** (`pickAgentAt :5522`, membership scans `:5779-6008`, hover
  driver `:6758-6781`): unchanged code; they read the snapshot, which is
  fresh whenever they can run (their triggers are exactly the UI-sync
  triggers). One-frame latency on the first hover after idle — acceptable,
  stated.
- **Recording / screenshot**: unchanged code paths. Both capture the DISPLAY
  canvas (`:3273-3298`, `:7445-7454`), which under direct render holds the
  blitted GPU frame — verified equivalent by the explorers. Recording also
  flips UI-sync ON (belt-and-braces so `liveCount`/stats stay live on the
  recorded HUD… and because the user explicitly accepts a perf drop here).
- **Stats chip** (`:8320`): reads `liveCount` from the last snapshot — in
  `free` mode the worker ships the scalar in `stepped`, so the chip stays
  live without the arrays.

### 1.4 Compilers — **ZERO impact for A** (the FP-1 guarantee)
No agent-graph emitter changes: the render reads engine-owned fields only.
**B** touches `agentWebgpu/compile.ts` emitters (neighbour-gather loops read
the sorted mirror; ids materialize from `sortedId` only where the graph
consumes identity) — scoped separately in the plan; JS/WASM targets and the
lattice grid are untouched by both A and B.

### 1.5 3D (`gl3d.ts`) — unaffected in A1, extendable (plan Phase C)
The 3D view is a main-thread WebGL2 context; it cannot share WebGPU buffers —
so A1 keeps 3D agent models on today's snapshot path (= the `frame` mode).
NB the resident SIM already covers 3D (the eligibility gate has no 3D term);
only the render round-trip remains, and Phase C removes it with a WGSL
sphere-impostor pass in the agent runtime (`free` mode) while gl3d keeps
serving `frame` mode unchanged. See the plan's Extension roadmap for the full
scoping-vs-fundamental audit (grid+agents Phases D/E, eligibility Phase F).

### 1.6 Engine (`agentEngine.ts`) — unaffected by A
The CPU store stays the identity authority (slots, bonds, epochs, free-list).
B adds no store fields (the mirror is a runtime GPU buffer).

### 1.7 Save/load, presets, Overseer, indicators, end conditions
- `getState`/`.gcastate`: gains the one-shot agent readback (fixing the
  latent freshness gap noted in 1.2 as a side benefit).
- Overseer / indicators / stop events: models using them are already
  residency-INELIGIBLE (worker gate `:1934-1935`), and the explorers confirmed
  zero main-thread per-frame agent dependence — no interaction.

### 1.8 Docs + verification
CLAUDE.md (this feature's section + the perf-review round), HelpView
(Performance § gains a "direct agent render" paragraph + the Glow option),
README one-liner, and the verification matrix in the plan (feature-by-feature
in-browser checks + the perf numbers re-measured).

---

## 2. Feature-preservation matrix (the user's constraint, explicit)

| Feature | Mode under direct render | Cost while used |
|---|---|---|
| Watching the sim run | `free` — GPU renders, zero CPU/frame | none (the win) |
| Pan / zoom / infinity | camera uniform + render-side tiling | ~0 (present-only dispatch) |
| Agent brush (add/remove/move/edit/glue/cut/bond) | UI-sync `frame` while pointer armed | per-frame readback (~2 ms @50k) while brushing |
| Hover highlight / area preview | same as brush | same |
| Inspector (click / sweep / pinned) | one-shot + `frame` while pinned | one readback + per-frame while pinned |
| Edit panel prefill / Apply | one-shot (`getAgentState` syncs first) | one readback |
| Recording (GIF/WebM) | `frame` forced ON; capture reads the display canvas as today | per-frame readback + capture (accepted) |
| Screenshot | display-canvas capture, unchanged | one frame |
| Save State / Save Project / presets | one-shot readback before serialize | one readback |
| Pause | one-shot sync on pause | one readback |
| Outlines / background colour | in-shader rim / clear colour | free |
| Sprites / metaballs / goo | fall back to the CPU overlay path (v1) | today's cost |
| 3D view | unchanged CPU path | today's cost |
| JS / WASM agent targets | unchanged CPU path (phase A2 can lift them later) | today's cost |

---

## 3. Risk register (ranked)

1. **Stale-store correctness** — any CPU consumer running while `free`.
   Mitigation: the one-shot rule lives in ONE place (the worker message
   dispatcher: "if stale and this message reads/writes agents → readback
   first"), not scattered per feature. Verification: a hostile test that
   fires every mutation/inspect/save message mid-free-run and asserts values.
2. **Canvas-attach lifecycle** — the grid seam's documented gotchas apply
   verbatim (soft-recompile re-attach, tab-hidden unpresented canvas, fixed
   dims at transfer, never touch a transferred canvas's 2D context). We
   inherit the battle-tested pattern rather than inventing one.
3. **Two GPU devices, two canvases** — the grid's direct render and the agent
   render are different devices and can't share a canvas; the agents-only
   gate sidesteps layering entirely (there IS no grid layer). A future
   grid+agents direct composite is explicitly out of scope.
4. **B's identity remap** — sorted-space iteration must never leak a sorted
   index where the graph expects a canonical id. Mitigation: B is phased
   behind A, force-pass-first (no graph ids at all), then the fused
   gather+forEach case with an explicit id-materialization rule.

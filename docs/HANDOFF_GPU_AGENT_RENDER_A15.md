# PHASE A1.5 HANDOFF — GPU Agent-OM Colour Pass (resident fast path for OM-coloured models)

Read first: [HANDOFF_GPU_AGENT_RENDER.md](HANDOFF_GPU_AGENT_RENDER.md) §0/§3 +
the A1/A1.5/A2 Status Board rows; then this doc; then the A1 + A2 Completion
Reports (the render/readback machinery you build on). CLAUDE.md context:
"Agent polish round → Agent Output Mappings" (the CPU OM colour pass you are
mirroring), "Phase F — PR7 WHOLE-TARGET PORT" (the agentWebgpu emitter set +
gate you extend), "Agent-engine performance review round" (the resident batch).

**Problem**: A1's resident direct render reads the GPU `agentColors` buffer,
but Agent-Output-Mapping colours are computed CPU-side (`runAgentColorPass`
runs the compiled JS OM fns over the CPU store into `s.colors`). So A1's gate
excludes any model with `agentMappings` — including Particle Life — from the
resident fast path. (A2 already covers OM models on CPU targets: the snapshot
upload carries `s.colors`.)

**Objective**: compile each agent Output-Mapping graph into a per-agent WGSL
COMPUTE pass that writes the GPU `agentColors` buffer, dispatched GPU-side —
so OM-coloured models satisfy the A1 gate and run fully resident. First
principles: the OM graphs use the same node catalogue the behaviour compiler
already emits; a graph the emitters can't express keeps the CPU path via the
gate (never a model-shape test).

---

## Work items

1. **Compiler** (`agentWebgpu/compile.ts` — FULL check-compile-identity
   discipline applies; every existing surface must stay byte-identical):
   - After the behaviour compile, run `injectAgentLinkedOutputMappings` over
     the agent graph (exactly as `compileAgentGraph` does on the JS side) and,
     for EVERY `agentOutputMapping` root (user + synthesized), compile its
     flow chain into a separate WGSL entry (one small module per mapping id,
     mirroring the grid's per-OM pipelines): per-agent loop shape = the
     behaviour entry's (idx guard + alive skip), reusing the existing
     `VALUE/FLOW` emitters unchanged. `setCellLooks` in this context writes
     packed `agentColors[idx]` (the emitter already does exactly this for the
     behaviour graph; the `__current__` sentinel + per-mapping dispatch rule
     mirrors the CPU pass: each OM pass is dispatched only for its own
     mapping, so inside an OM module the viewer guard is a no-op).
   - Result additions: `omShaders: { mappingId, code }[]` + a
     `omSupported: boolean` (false if ANY reachable OM node falls outside the
     supported set — same reject logic as the behaviour gate, factored, not
     duplicated). Do NOT alter `isAgentGraphWebGPUSupported`'s behaviour
     verdict: OM support is a SEPARATE flag (a model with a GPU behaviour but
     an unsupported OM graph still runs the behaviour on GPU with the CPU
     overlay render, exactly as today).
2. **Runtime** (`agentWebgpuRuntime.ts`): build one compute pipeline per OM
   shader (validated up front like the behaviour module); `dispatchAgentOM
   (rt, mappingId, encoder?)` over highWater (dispatchCells tiling). Bind
   only what each module references (the Naga stripped-binding trap).
3. **Worker** (`sim.worker.ts`):
   - Ship the OM shaders + `omSupported` in init/recompile (mirror how the
     behaviour shader travels). Track `agentColorViewer` (already threaded
     for the CPU pass) → pick the active OM pipeline.
   - Dispatch points: inside `dispatchResidentBatch` per generation AFTER
     the behaviour pass (colours read attrs the behaviour just wrote);
     `presentAgentsOnce` paths prepend an OM dispatch when active; viewer
     switch (`colorPass` message) → OM dispatch + present; after mutations/
     uploads (the store upload overwrites agentColors? — check: `uploadAgent
     SoA`/`uploadAgentColors` write the CPU colours; when the GPU OM is
     active the GPU pass re-colours right after, so ordering is
     upload → OM → present).
   - In free mode with GPU OM active, `runAgentColorPass` (CPU) is redundant
     for the render — but it still serves snapshot consumers under UI-sync.
     Keep the CPU pass exactly as-is (it runs off `sendColors` when a
     snapshot ships); do not remove it.
4. **SimulatorView**: the A1 gate's OM term becomes
   `(model.agentMappings?.length ?? 0) === 0 || agentOmGpuSupported` (the
   flag from the compile result, threaded like `usesSpawn`). Nothing else
   changes — attach/camera/UI-sync are already in place.

## Do NOT touch
`agentWasm/*`, the JS agent compiler's OM path (CPU targets keep it — A2
renders from `s.colors`), gl3d, agentEngine, the lattice compilers.

## Verification (all mandatory)
- tsc, build, parity-agent-wasm (18), parity-agent-force (7).
- **check-compile-identity**: capture baseline pre-change; ONLY the new
  `omShaders` surface may appear; every existing surface byte-identical.
- Real GPU in-browser: Particle Life (WebGPU target, its shipped agent OM)
  now ENGAGES direct render (`agentRenderStatus:true` — the A1 exclusion
  lifted) and free-runs resident; the OM pass writes correct species
  colours — verify by flipping UI-sync ON and comparing the snapshot's
  `s.colors` species distribution (CPU pass) against a readback of the GPU
  `agentColors` after the OM dispatch on the SAME frozen state (bucket-equal
  within f32 rounding). Viewer switch re-colours (two agent views on a test
  model — add a second linked view at runtime via the real Mappings panel
  UI). Boids (no OMs) byte-unchanged. An OM graph using an unsupported node
  (e.g. a median aggregate spliced into the OM chain in a scratch model)
  → `omSupported:false` → CPU overlay path, no errors.
- Timers are THROTTLED on long-hidden pages: drive probes via worker
  message-count promises, not chained setTimeout waits.

## Completion Report (2026-07-22)

**Commit** (branch `optimize`, not pushed): one commit — "perf(agents): A1.5 GPU agent
Output-Mapping colour pass (resident fast path for OM-coloured models)". `git diff --stat`
touches exactly: `agentWebgpu/compile.ts` (+~209), `agentWebgpuRuntime.ts` (+~142),
`sim.worker.ts` (+~24), `SimulatorView.tsx` (+~21), `compileHarness.ts` (+9),
`check-compile-identity.mjs` (+2). NO `agentWasm/*`, NO JS-agent OM path, NO gl3d /
agentEngine / lattice compilers (the do-not-touch list is clean).

**What shipped vs the spec** (all four work items done; deviations justified):
1. **Factored `emitAgentRootModule` (not duplicated).** The behaviour-shader emit
   (ctx-setup + emitters + module assembly, ~215 lines) was extracted into a shared
   `emitAgentRootModule(rootNode, rootPortId, …, entryName)` that BOTH the behaviour root
   AND every OM root call — so the OM passes reuse the exact behaviour machinery and a
   byte-drift is a `check-compile-identity` red. The reject policy was factored into
   `agentSubsetSupported` (shared by `isAgentGraphWebGPUSupported` + the OM gate). This is
   the handoff's "factored, not duplicated" for both the emit AND the gate.
2. **`agentOutputMapping` added to `AGENT_WEBGPU_SUPPORTED_TYPES`** (NOT in the spec, but
   required): the OM root itself is in its own reachable cone, so the shared gate rejected
   the whole OM unless the root type is "supported". It is an entry-point root — never
   emitted as a value/flow node, only walked from its `do` output — and the behaviour cone
   never contains it, so the behaviour verdict is unaffected (verified: behaviour shader +
   `isAgentGraphWebGPUSupported` unchanged for all 25 models).
3. **GPU OM dispatch lives ONLY in `dispatchResidentBatch`** (a justified deviation from
   "presentAgentsOnce paths prepend an OM dispatch + viewer switch → OM dispatch + present").
   Analysis: the free-mode resident present is the ONLY path where the CPU never computes
   `s.colors` — every OTHER present (paused / mutation / non-resident per-gen / attach /
   viewer-switch-while-paused) goes through `presentAgentsFromStore`, which uploads the CPU
   `s.colors` = `runAgentColorPass`'s OM colours. So those paths ALREADY carry correct OM
   colours via the CPU. Adding a GPU OM dispatch there would (a) be redundant, (b) hit a
   control-uniform-staleness problem at attach (control.highWater is only fresh after a
   resident batch uploads it), and (c) risk a GPU-vs-CPU colour mismatch — except the OM
   colour math is integer-exact (categorical/linear → 0-255 RGB), so there's NO flicker
   either way. Minimal + correct. `colorPass` + `runAgentBatchResident` set
   `rt.activeOmMappingId` so the next resident batch (and any GPU dispatch) uses the right
   viewer. The CPU `runAgentColorPass` is KEPT as-is (serves snapshot consumers under UI-sync).
4. **Buffer-union decoupling** (runtime): the read-only aux/indicators/bondStore buffers are
   created for the behaviour ∪ OM usage (an OM may read a model attr / indicator / bond the
   behaviour doesn't), while the BEHAVIOUR bind group keys on the behaviour's OWN usage
   (`hasAux`/…, was buffer-existence `if (auxF32Buf)`) and each OM binds its own — so
   buffer-existence is the union but each bind group matches its shader exactly. For a 0-OM
   model this is byte-identical to before (union == behaviour usage).
5. **Harness surface added** (`agent.webgpu.om` + `agent.webgpu.omSupported` in
   `compileHarness.ts` + `check-compile-identity.mjs`) so the OM shaders are regression-
   guarded going forward. The compare loop only diffs baseline keys, so the new keys are
   additive (the handoff's "ONLY the new omShaders surface may appear").

**Verified** (all gates + real-GPU in-browser):
- `tsc -p tsconfig.app.json --noEmit` + `npm run build` clean.
- `parity-agent-wasm` (18) + `parity-agent-force` (7) green (untouched WASM/JS paths).
- `check-compile-identity`: 25 models, ALL existing surfaces byte-identical; only the new
  `agent.webgpu.om`/`omSupported` keys added. PL behaviour shader hash unchanged.
- **Node OM probe**: PL 2D+3D → `omSupported:true`, 1 OM shader (`view_species`) reading
  `agentF32[speciesBase+idx]` → categorical select → `agentColors[idx]`; Boids/Tissue/GoL
  (0 mappings) → `omSupported:true`, 0 shaders (byte-identical).
- **Real GPU (in-browser, WebGPU available, `__simWorker` hook)**:
  - PL forced to `agentTarget:'webgpu'` ENGAGES direct render (free mode ships
    `hasAgents:false` + `agentLiveCount:1800`), **0 GPU errors** over many resident batches.
  - **THE definitive colour proof**: the GPU `agentColors` buffer — read via a FREE-mode
    `getState` (the one-shot readback pulls GPU `agentColors` → `s.colors` with NO
    `runAgentColorPass` recolour on that path) — contains EXACTLY the 6 PL species colours,
    **bucket-identical** to the CPU OM path (`230,70,70`:~300, `95,200,95`:~290, etc., same
    counts). The GPU OM compute pass wrote correct colours.
  - **Viewer switch**: a 2nd linked view (grayscale palette) added; switching the active
    agent viewer flips the GPU `agentColors` to the grayscale palette and back to species,
    bidirectionally, 0 errors — `activeOmMappingId` selects the right OM pipeline.
  - **Boids-on-webgpu unregressed**: flocks to **polarization 0.9992** (sampled via
    `getAgentState`), 0 errors, direct render engaged. The no-OM `dispatchAgentOMEncode` is a
    no-op (empty `omPipelines`).
  - **Unsupported OM** (standalone `agentOutputMapping` with a `neighborIndex` Compare) →
    `omSupported:false` while `isAgentGraphWebGPUSupported` stays `true` → the model keeps its
    GPU behaviour + the CPU overlay (no crash, the A1 exclusion path).

**New gotchas / notes for C / D:**
- **`getState`'s vx/vy field has a PRE-EXISTING readback artifact** for a resident WebGPU
  store (garbage — 5e19 — in ~20% of slots), while `getAgentState` (per-agent) and the sim
  itself are clean (Boids flocks 0.9992). Unrelated to A1.5 (touches no velocity path). If a
  future phase needs velocities in-browser, use `getAgentState`, not `getState` (prior
  sessions did the same). Worth a separate look but out of A1.5 scope.
- The OM assembly ALWAYS declares bindings 0-6 (like the behaviour), so an OM that uses only
  agentF32/agentColors still declares hashBins(3)/rngState(5)/agentI32(1) — Naga may strip
  them, but the OM bind group layout also declares 0-6 (matching the behaviour's proven
  pattern), so it validates on the real GPU (0 errors confirmed).
- `dispatchAgentOMEncode` runs ONCE per resident batch (after the gen loop) — correct because
  the present is once per batch/frame; it reads the committed final-state attrs. A per-gen OM
  dispatch would be wasteful (only the last frame is presented).
- C (3D) can reuse `compileAgentOutputMappingsWebGPU` + the OM pipelines verbatim if a 3D
  sphere pass ever renders from the resident GPU SoA — the OM colour pass is dimension-agnostic
  (it reads agent attrs, writes agentColors; gl3d's WebGL2 context can't share the buffers, so
  3D stays snapshot-fed today).

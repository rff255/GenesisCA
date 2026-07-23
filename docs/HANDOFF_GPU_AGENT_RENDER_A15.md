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

## Completion Report
(fill in when done)

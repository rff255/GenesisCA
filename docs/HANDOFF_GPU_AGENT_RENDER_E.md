# PHASE E HANDOFF — Unified GPUDevice (E1: device + zero-copy field bridge · E2: composite render)

Read first: [HANDOFF_GPU_AGENT_RENDER.md](HANDOFF_GPU_AGENT_RENDER.md) §0/§3 +
ALL Status Board rows (every lesson binds you); then this doc; then the D
Completion Report (its "notes for E" seed this phase) and the A1/C reports
(the render seams); then PLAN_GPU_AGENT_RENDER.md § Extension roadmap Phase E.
CLAUDE.md context: the WebGPU grid section (webgpuRuntime device/buffers/
present), "Phase F — PR7 G5" (the CPU field-bridge round-trip you are
eliminating), the direct-render subsections, and "Agent-engine performance
review round" (residency).

**Problem**: the grid runtime (`webgpuRuntime.ts`) and the agent runtime
(`agentWebgpuRuntime.ts`) each request their OWN GPUDevice. Consequences:
(1) field-coupled models (Chemotaxis/Ant class) round-trip the field
CPU-side every generation — the last non-resident model class; (2) a WebGPU
grid + resident agents can't share a submit (D's report: agents run JS in
the `webgpuActive` branch); (3) grid+agents can't composite on one canvas
(the D render carve-outs). One device removes all three — our code
structure, not hardware.

**Split**: E1 (this session) = device unification + the zero-copy field
bridge + field-coupled residency. E2 (a later session, own handoff refresh)
= single-canvas composite render + lifting the 3D/2D grid+agents render
carve-outs. Do NOT start E2 work in the E1 session.

---

## E1 work items

1. **Shared device acquisition** (new small module or a factored helper in
   `webgpuRuntime.ts`): one `acquireSharedGpuDevice()` (adapter + device +
   requiredLimits = the UNION of what both runtimes request today, incl.
   `maxStorageBuffersPerShaderStage` where the grid's varAux needs it),
   refcounted or worker-owned singleton with explicit release. BOTH
   runtimes take the device as a constructor input instead of requesting
   their own. Teardown: the worker owns the singleton lifecycle
   (init/reset/recompile rebuild runtimes WITHOUT destroying the device
   unless both are gone — the destroy-reason lesson stands: filter
   `'destroyed'` in lost handlers; consolidate onuncapturederror/lost hooks
   at the singleton).
   - Failure isolation: if EITHER runtime's pipeline build fails, that
     runtime falls back exactly as today; the device survives for the other.
   - The A2 render-only surface + the C sphere pipeline ride the same
     device for free.
2. **Zero-copy field bridge** (the payoff): with one device, the agent
   behaviour shader's `fieldRead` binding binds the GRID's `attrsRead`
   buffer DIRECTLY (drop `uploadAgentField`'s copy) and `fieldDeposit`
   stays the atomic accumulator; a small GPU **deposit-fold pass** (new
   compute: `attrsRead[i] = depositDecode(fieldDeposit[i])` per the
   existing op semantics) replaces `readbackAgentField` + the CPU write.
   Per-gen ordering INSIDE one submit (the D-FIELD contract, GPU-side):
   grid step → agent behaviour (reads grid attrs post-step... CHECK the
   CPU contract first: today agents read the field as of the PREVIOUS cell
   step and deposit BEFORE the next cell step — replicate exactly:
   agent behaviour (reads attrsRead) → deposit fold into attrsRead →
   grid step consumes it via its copy lines). Get the buffer identities
   right for the grid's ping-pong (attrsBufA/B swap per step — bind via a
   bind group rebuilt per swap, or bind the stable readAttrs-side buffer
   per the grid's swap discipline; READ the grid runtime's swap code, do
   not assume).
   - Field WRITE sub-cases: only `cellFieldWriteAttrsOf` attrs fold; the
     op set (set/add/sub/max/min) must match the CPU
     `fieldDepositCell` semantics bit-for-bit in u32-CAS encoding.
3. **Residency for field-coupled models**: a new eligibility arm — the
   field-coupling exclusion lifts IFF the grid target is WebGPU AND the
   unified device is live AND the model's grid step itself is
   WebGPU-supported (sync etc. — all existing grid gates). The step batch
   then encodes grid+agents+fold per gen in ONE submit (extend
   `dispatchResidentBatch` or a sibling that also encodes the grid step
   pipeline — coordinate with the grid runtime's existing dispatch
   helpers). Stop-flag/indicator readbacks keep their existing cadence.
   JS/WASM-grid + field-coupled models stay on today's CPU bridge
   (unchanged).
4. **Fallback + protocol**: every failure (device, pipeline, unsupported
   grid op) degrades to today's paths loudly-but-safely. The readback
   policy/one-shot rule cover the agent store as before; `getState` for a
   resident field-coupled model must also readback the GRID attrs (the
   existing `gpuOwnsAttrs` discipline — verify the interplay).

## Do NOT touch
Compilers (zero compiler changes expected — the field bindings exist; if a
shader tweak is genuinely required it must keep every existing surface
byte-identical under check-compile-identity), agentEngine, gl3d, the 2D/3D
render seams beyond wiring the shared device.

## E1 verification (all mandatory)
- tsc, build, parity ×2; identity IF any compiler file is touched.
- Real GPU in-browser:
  - **Chemotaxis on WebGPU grid + WebGPU agents**: engages unified
    residency (one submit/frame), the field BUILDS (chemical max grows,
    cells non-zero), agents AGGREGATE (occupied-bin count drops /
    clustering rises — the shipped model's own metric), 0 errors —
    statistical equivalence vs the CPU-bridge path on the same seed.
  - Ant Necrophoresis likewise (piles form).
  - A JS-grid field model stays on today's CPU bridge unchanged.
  - Decoupled grid+agents (D's synthetic): now shares the ONE device
    (no second adapter request) and still passes D's checks.
  - Agents-only models: unchanged behaviour on the shared device.
  - Device-loss/teardown: reset/recompile/target flips leak no devices
    (count adapter requests via a wrapped `requestAdapter` probe).
  - `getState` on a resident field-coupled model returns fresh GRID attrs
    + fresh agent state.
- Perf numbers: Chemotaxis ms/gen CPU-bridge vs unified-resident at the
  shipped size + a 10× field, in the commit message.

## Completion Report (E1)
(fill in when done — commits, deviations + why, measured numbers, gotchas,
the E2 seed notes: what the composite render needs from the unified device)

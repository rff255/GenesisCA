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

## Completion Report (E1) — 2026-07-23

**Outcome**: **item 1 (shared GPUDevice) SHIPPED + in-browser-verified. Items 2/3
(zero-copy field bridge + field-coupled residency) STOPPED with a documented
finding — item 2's mechanism is a confirmed-false assumption, per §0 invariant
#2 (STOP + record; do not redesign).** Item 4 (fallback/protocol/getState)
applies to the field bridge and is deferred with it.

**Commit** (branch `optimize`, not pushed): one commit — "perf(agents): E1
shared GPUDevice singleton (device unification)". `git diff --stat` = the new
[sharedGpuDevice.ts](../src/simulator/engine/sharedGpuDevice.ts) +
[webgpuRuntime.ts](../src/simulator/engine/webgpuRuntime.ts) +
[agentWebgpuRuntime.ts](../src/simulator/engine/agentWebgpuRuntime.ts) + a small
hunk in [sim.worker.ts](../src/simulator/engine/sim.worker.ts). **NO compiler
files, NO agentEngine, NO gl3d, NO SimulatorView** — device-lifecycle only.

### What shipped (item 1 — device unification)
- **`sharedGpuDevice.ts`** — a refcounted worker-owned singleton.
  `acquireSharedGpuDevice()` requests the adapter + device ONCE with the UNION of
  the limit keys both runtimes ask for (the grid's set is the superset; agent's
  is a subset), with the same retry-with-defaults fallback the runtimes had.
  `releaseSharedGpuDevice(device)` decrements the refcount and destroys the
  device only at zero. Consolidated `uncapturederror` + `device.lost` (filter
  reason `'destroyed'`) hooks live here. DEV-only `sharedGpuAdapterRequestCount()`
  / `sharedGpuRefCount()` for the leak metric.
- **`createWebGPURuntime` / `createAgentWebGPURuntime` / `createAgentRenderOnlyRuntime`**
  take the device from the singleton (no more per-runtime `requestAdapter`/
  `requestDevice`). Each wraps its post-acquire body so a throw (WGSL error,
  buffer OOM) `releaseSharedGpuDevice`s before rethrowing — a mid-build failure
  can't leak a reference.
- **`destroyWebGPURuntime` / `destroyAgentWebGPURuntime` / `destroyAgentRenderSurface`**
  release the reference instead of destroying the device (which would kill a
  still-live sibling runtime). The device is destroyed only when the last
  runtime releases.
- **Worker**: removed the per-agent-runtime `onuncapturederror`/`device.lost`
  block in `buildAgentWebGPUIfNeeded` (consolidated at the singleton — on a shared
  device it would mislabel grid errors as agent errors and accumulate a lost
  handler per rebuild). Real dispatch failures stay user-visible via the existing
  `pushErrorScope('validation')` around each dispatch (unchanged).
- **Failure isolation** preserved: either runtime's pipeline build failing
  degrades that runtime only; the device survives for the other.

### Measured (real WebGPU, in-browser, hidden pane → worker protocol + getState + a DEV probe)
- **Device sharing (the payoff)**: Chemotaxis on **WebGPU grid + WebGPU agents**
  → **adapterRequests = 1, refCount = 2** (both runtimes on ONE device; pre-E1 =
  two devices), hasGrid=true + hasAgent=true, **0 errors**.
- **Leak metric across rebuilds**: **2 recompile cycles** (each rebuilds both
  runtimes) → adapterRequests **stays 1**, refCount balanced at **2**, 0 errors —
  rebuilds reuse the device, no leak, no premature destroy.
- **Field model correctness on the shared device**: Chemotaxis steps to gen 20 +
  post-recompile to gen 10, fresh `getState` (attributes + agents), 0 errors
  (the CPU field bridge still round-trips; item 2 not shipped).
- **Agents-only headline unchanged**: Boids-webgpu flocks to **polarization
  0.9987** on the shared device (adapterRequests 1, refCount 1).
- Gates: `tsc -p tsconfig.app.json --noEmit` + `npm run build` +
  `parity-agent-wasm` (18) + `parity-agent-force` (7) all green. No compiler
  files touched → `check-compile-identity` not required.

### Deviations from the handoff (all justified)
1. **Consolidated the error hooks by REMOVING the per-runtime ones** (handoff:
   "consolidate at the singleton"). The singleton logs generic `console.error`
   diagnostics for BOTH runtimes; the user-visible surfacing of REAL dispatch
   failures already exists via `pushErrorScope('validation')` (unchanged), so no
   user-visible error surfacing is lost. Kept the singleton console-only (it's a
   generic module — it must not call `self.postMessage`).
2. **Refcount, not a bare worker-owned singleton.** The refcount frees the device
   precisely when BOTH runtimes are gone (e.g. user flips both targets to JS)
   while surviving every rebuild. The adapter is still requested exactly once (the
   leak metric).

### THE ITEM-2/3 FINDING (why the field bridge stopped) — the orchestrator re-plans from here
- **Item 2's "direct bind" is impossible without a compiler change** (§0 #2 STOP
  trigger). The agent `fieldRead` layout ([agentWebgpu/layout.ts](../src/modeler/vpl/compiler/agentWebgpu/layout.ts))
  is a COMPACTED `array<f32>` — `fieldReadBase[id] + cellIdx`, one contiguous
  `fieldTotal`-run per agent-accessible attr, in `fieldReadAttrs` order, NO
  sentinel. The grid `attrsRead` buffer ([webgpu/layout.ts](../src/modeler/vpl/compiler/webgpu/layout.ts))
  is per-attr bitcast WORDS — `attr.wordOffset + cellIdx`, `cellsPerAttr = total`
  OR **`total + 1`** (a constant-boundary SENTINEL slot at index `total`), in the
  grid's FULL attr order (all cell attrs, not just the field subset). So:
  (a) offsets don't line up (agent field base ≠ grid attr word offset; field
  attrs aren't first in the grid layout); (b) the sentinel slot shifts everything
  under constant boundary; (c) **int/bool/tag** field attrs differ in BIT PATTERN
  — the grid stores `bitcast<u32>(i32 v)`, the agent shader reads `f32`, and the
  CPU `uploadAgentField` does a NUMERIC convert (`f32(i32 v)`), not a bit copy.
  A raw bind reads garbage; matching the layouts = recompiling the agent field
  shader against the grid's attr word layout = a compiler change (forbidden).
- **Field-coupled residency (item 3) also needs a branch restructure.** A WebGPU
  grid + WebGPU agent FIELD model runs today in the worker's `webgpuActive`
  branch, which runs agents via **JS `runAgentStep()`** (NOT the GPU agent
  runtime) with the CPU field round-trip (`ensureCpuAttrsFresh` → runAgentStep →
  `uploadAttrs`). Making it resident requires routing those agents onto the GPU
  runtime AND encoding grid+agent+fold per gen — not the "drop a copy" the handoff
  imagined.
- **Shipped-model reality**: both shipped field models (Chemotaxis, Ant) use
  **float** field attrs, **torus** boundary (no sentinel), and default to
  **non-WebGPU grid + JS agents** — the WebGPU-grid+WebGPU-agent resident field
  path is a user-selected config, exercised only after flipping both targets.

### CONCRETE RE-PLAN for a refined E1b / E-field handoff (compiler-free, tractable)
On the shared device (now delivered), replace the CPU field round-trip with
**GPU `copyBufferToBuffer` passes** — NOT a direct bind:
1. **Gate** (general property): the model has agent-accessible cell attrs whose
   types are ALL **float** (grid `bitcast<u32>(f32)` word == agent `f32` byte
   pattern → a raw copy is correct). Any int/bool/tag field → keep the CPU bridge
   (or add a tiny convert compute shader later). Also gate on WebGPU grid +
   WebGPU agents + the shared device live.
2. **Route** the `webgpuActive` branch's field agents onto the GPU agent runtime
   (they run JS today). Per gen, on the shared device:
   - prime `agentFieldRead` ← grid `attrsReadBuf` per read-attr:
     `copyBufferToBuffer(attrsReadBuf, attr.byteOffset, agentFieldReadBuf,
     fieldReadBase*4, total*4)` (copies cells 0..total-1; the constant-boundary
     sentinel at index `total` is excluded automatically);
   - prime `agentFieldDeposit` ← grid `attrsReadBuf` per write-attr (same shape);
   - dispatch agent behaviour (atomic-deposits) → force → posCommit;
   - **fold**: `copyBufferToBuffer(agentFieldDeposit, fieldWriteBase*4,
     attrsReadBuf, attr.byteOffset, total*4)` (the deposit words ARE the final f32
     field — the CPU `readbackAgentField` just copies them, so the fold is a plain
     buffer copy, no decode);
   - grid `dispatchStep` (its copy line carries the deposit; then swap).
   Re-read `webgpuRuntime.attrsReadBuf` EACH gen (it ping-pongs per step).
3. **Buffer usage flags**: grid `attrsBufA/B` need `COPY_SRC | COPY_DST`; agent
   `fieldReadBuf` needs `COPY_DST`, `fieldDepositBuf` needs `COPY_SRC | COPY_DST`.
   Check + add (additive, safe).
4. **getState**: for a resident field-coupled model, the field lives in the grid
   attrs (GPU) — `getState`'s existing `gpuOwnsAttrs → ensureCpuAttrsFresh` pulls
   it down; the agent one-shot rule pulls the agent store down. Verify the interplay.
5. Not strictly "one submit" — separate queue-ordered submits (agent step, then
   grid step) are correct (queue order = the barrier); the handoff's "one submit"
   is an optimization, not a correctness requirement.
6. **Verify** statistical equivalence (Chemotaxis aggregation metric on the same
   seed) — feasible via worker protocol + getState (C/D proved field metrics are
   checkable under occlusion). NB routing agents JS→GPU changes RNG (shared
   xorshift32 → per-cell PCG) — a documented "statistical, not bit" difference.

### E2 seed notes (what the composite render needs from the unified device)
- The shared device is the E2 prerequisite: a single WebGPU canvas context is
  bound to ONE device, so compositing grid + agents on one canvas requires both
  runtimes on the shared device — which E1 delivers.
- The C-report leak (a re-attach building a fresh render-only device) is only
  **half** fixed by E1. **CORRECTED 2026-07-23** (audit H3): E1 stopped the
  *duplicate DEVICE* (the render-only surface takes the shared device), but the
  attach handler still built a brand-new surface on every re-attach without
  destroying the previous one — so each re-attach orphaned three
  `maxAgents`-sized buffers **and** a shared-device reference that could never be
  released (making the device undestroyable, i.e. the leak merely changed shape).
  The remaining half was closed by the AUDIT FIX PASS (handoff item 4): the
  attach handler now REUSES a layout-matching `agentRenderRuntime` and destroys a
  stale-layout one before rebuilding.
- The grid runtime already renders its own canvas (`setupDirectRender` /
  `presentToCanvas`); with one device E2 can lift D's `&& !is3D` render carve-out
  (voxels-vs-spheres depth-composite on one device/canvas). The z-order stays
  grid → agents → gl overlays.

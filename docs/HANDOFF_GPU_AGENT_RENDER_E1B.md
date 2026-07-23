# PHASE E1b HANDOFF — GPU Field Bridge via Buffer Copies (field-coupled residency)

Read first: [HANDOFF_GPU_AGENT_RENDER.md](HANDOFF_GPU_AGENT_RENDER.md) §0/§3 +
ALL Status Board rows; then this doc; then **the E1 Completion Report in
[HANDOFF_GPU_AGENT_RENDER_E.md](HANDOFF_GPU_AGENT_RENDER_E.md) — REQUIRED,
top to bottom**: its ITEM-2/3 FINDING section is the ground truth this phase
is built on (the field-layout mismatch that killed the direct-bind idea) and
its CONCRETE RE-PLAN section IS this handoff's design, adopted verbatim by
the orchestrator. CLAUDE.md context: the WebGPU grid section (attrsBufA/B
ping-pong + `gpuOwnsAttrs`), "Phase F — PR7 G5" (the CPU field bridge:
`uploadAgentField`/`readbackAgentField` — read their exact semantics, they
define the copies), and the E1 subsection (the shared device you build on).

**Objective**: on the shared device (E1), replace the per-generation CPU
field round-trip with **GPU `copyBufferToBuffer` passes** for eligible
models, and route their agents onto the GPU agent runtime — so field-coupled
models (Chemotaxis/Ant class, on WebGPU grid + WebGPU agents) run their whole
generation GPU-side. NOT a direct bind (proven impossible without compiler
changes), NOT new shaders (the float-gate makes copies sufficient).

**The gate** (all general): WebGPU grid active + WebGPU agent target +
shared device live + **every agent-accessible cell attr (`fieldSpecs`) is
type `float`** (the byte-pattern equivalence: grid `bitcast<u32>(f32)` word
== agent `f32` — a raw copy is correct; any int/bool/tag field keeps the CPU
bridge) + the model's existing residency terms except the field exclusion
(which this phase lifts for the gated class). Both shipped field models
(Chemotaxis, Ant) are float-field — they're the verification stars once both
targets are flipped to WebGPU.

---

## Work items (the E1-report re-plan, adopted)

1. **Per-gen GPU bridge, queue-ordered** (separate submits are CORRECT —
   queue order is the barrier; one-submit is a later optimization):
   - prime: `copyBufferToBuffer(grid attrsReadBuf @ attr.byteOffset →
     agentFieldReadBuf @ fieldReadBase*4, total*4)` per read-attr (cells
     0..total-1; a constant-boundary sentinel at index `total` is excluded
     automatically by the size);
   - prime deposit: same shape into `agentFieldDepositBuf` per write-attr
     (mirrors `uploadAgentField`'s priming of the accumulator with the
     current field);
   - dispatch the agent gen (behaviour → force → posCommit — the resident
     machinery);
   - fold: `copyBufferToBuffer(agentFieldDepositBuf @ fieldWriteBase*4 →
     grid attrsReadBuf @ attr.byteOffset, total*4)` per write-attr (the
     deposit words ARE the final f32 field — `readbackAgentField` is a
     plain copy today, so the fold is too; no decode pass);
   - grid `dispatchStep` (its copy lines carry the deposit into the next
     gen). **Re-resolve the grid's attrsRead-side buffer EVERY gen** — it
     ping-pongs per step (read the swap code, never cache across steps).
2. **Route the `webgpuActive` branch's field agents onto the GPU agent
   runtime** (today they run JS `runAgentStep()` with the CPU round-trip).
   Structure the combined loop inside the EXISTING `asyncStepBatchInFlight`
   deferral; generation counts once per gen; every failure falls back to
   the current CPU-bridge path loudly-but-safely for that batch.
3. **Buffer usage flags** (additive): grid `attrsBufA/B` += `COPY_SRC |
   COPY_DST`; agent `fieldReadBuf` += `COPY_DST`; `fieldDepositBuf` +=
   `COPY_SRC | COPY_DST`. Verify none of these change existing behaviour.
4. **getState / readback policy interplay**: for this class the field
   lives in the GRID attrs (GPU) — `gpuOwnsAttrs → ensureCpuAttrsFresh`
   pulls it down; the agent one-shot rule pulls the agent store. Verify a
   mid-free-run `getState` returns fresh grid attrs AND agents. Stop-flag /
   indicator cadences unchanged.
5. **RNG note for verification**: routing agents JS→GPU changes the RNG
   family (shared xorshift32 → per-agent PCG) — equivalence is STATISTICAL
   (the documented WebGPU stance), never bitwise. Use the models' own
   metrics.

## Do NOT touch
Compilers (ZERO compiler changes — the layouts stay as they are; that's the
whole point of the copy design; assert with git diff --stat), agentEngine,
gl3d, the render seams. JS/WASM-grid field models + int/bool/tag-field
models keep today's CPU bridge byte-for-byte.

## Verification (all mandatory)
- tsc, build, parity ×2; git diff --stat audit (no compiler files).
- Real GPU in-browser (message-count probes):
  - **Chemotaxis flipped to WebGPU grid + WebGPU agents**: engages the GPU
    bridge (no per-gen `uploadAgentField`/`readbackAgentField` CPU work —
    instrument via a DEV counter or the absence of the CPU-bridge code
    path), the field BUILDS (chemical max grows via getState), agents
    AGGREGATE (the shipped clustering metric) — statistically equivalent to
    the CPU-bridge run on the same seed; 0 errors across 100+ gens.
  - **Ant Necrophoresis likewise** (piles form; corpse counts move).
  - `getState` mid-free-run: fresh grid attrs + fresh agents.
  - Defaults untouched: Chemotaxis/Ant on their SHIPPED targets (non-WebGPU
    grid) behave byte-identically (the CPU bridge path).
  - An int/tag-field synthetic (flip a field attr type in-memory) → gate
    false → CPU bridge, no errors.
  - Agents-only + decoupled models: unchanged.
  - Perf: ms/gen CPU-bridge vs GPU-bridge for Chemotaxis at shipped size +
    a larger field (e.g. 4×), in the commit message.

## Completion Report
(fill in when done — commits, deviations + why, measured numbers, gotchas,
E2 seed notes)

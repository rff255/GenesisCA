# Plan — Cross-Agent Write Semantics

Companion to [IMPACT_MAP_CROSS_AGENT_WRITES.md](IMPACT_MAP_CROSS_AGENT_WRITES.md) + the illustrated mockup [PLAN_CROSS_AGENT_WRITES.html](PLAN_CROSS_AGENT_WRITES.html). Recorded from an owner design discussion 2026-07-14.

> **STATUS: IMPLEMENTED + verified (2026-07-14/15).** Part A (sync-overwrite gate, behaviour-root + createAgent-handle exemption), Part B `applyForceToAgent` (all three targets — JS/WASM plain `+=`, WebGPU f32 atomic-CAS scatter), AND `applyForceToAgents` (the array-broadcast sibling — **lowered to `For Each In Array → applyForceToAgent`** via `expandForceToAgents`, so it reuses the single node's emitters on every target with zero new emit) all shipped. Verified: tsc + `npm run build` clean; Part A gate via the real compiler; JS↔WASM bit-parity for both force nodes ([parity-agent-wasm.mjs](../scripts/parity-agent-wasm.mjs)) + the lowering ([test-cross-agent-writes.mjs](../scripts/test-cross-agent-writes.mjs) Parts A/B/C) + **real-GPU** `createShaderModule` (0 errors, 2D+3D, single AND the array node's scatter-CAS-inside-forEach) + a real `dispatchAgentStep` (0 validation errors); WASM agent gate unregressed. Catalogue → 143 selectable / 47 agent. See the "Cross-Agent Write Semantics" section in [CLAUDE.md](../CLAUDE.md). Nothing deferred.

## The insight this rests on
**OVERWRITE writes race across agents; ACCUMULATE writes don't.** A cross-agent attribute/position/radius write is last-writer-wins (order-dependent, WebGPU-racy). A cross-agent FORCE write is a commutative `+=` onto a per-step-zeroed buffer consumed after the pass — order-independent, no collision with the target's own contribution. So the two get OPPOSITE rules.

Verified `Apply Force` reality (do not restate the myth "it sets the force"): `_agentForceX[idx] += fx`, buffer zeroed each step, engine adds its own soft-sphere/bond forces on top, then integrates. A single call ≈ set-from-zero; N calls sum; a local-var-accumulate-then-one-call is equivalent to N calls.

## Part A — cross-agent OVERWRITE writes are async-only

**Nodes:** `setAgentAttribute`, `setAgentsAttribute`, `setAgentPosition`, `setAgentRadius`. (`setVelocity` is self-only — untouched.)

**Rule:** in a model whose `centerBased.agentUpdateMode !== 'async'`, writing an EXISTING other agent's slot is a compile error + a modeler badge — mirroring the CA grid's Fundamental #4 (sync cells write only themselves; neighbour-writes are async-only). Self-writes stay legal in both modes. **WebGPU note:** WebGPU agents are sync-only (async is fundamentally unsupported there, like the CA grid), so a cross-agent-overwrite model is JS/WASM-only by construction — no WebGPU-specific handling for Part A.

**Exemption (critical):** configuring a freshly-`createAgent`'d handle (unified spawning, Init + Behaviour) is NOT a race — the newborn isn't concurrently written. So the gate fires only when the `agentId` source is NOT a one-hop `createAgent` handle output. Conservative: anything routed through a relay/valueSwitch counts as an existing agent → gated.

**Why:** sync agent mode = deterministic snapshot update. A cross-agent overwrite reintroduces order-dependence (lost updates when the target also self-writes) and is a genuine non-atomic data race on parallel targets. Today it's silently allowed — a footgun.

### Phase A1 — the gate
1. Add `NodeRequirements.agentAsync?: boolean`; tag the 4 nodes.
2. `detectAgentAsyncRequirement(nodeType, config, model, edges)` in `nodeValidation.ts`: true when tagged AND `agentUpdateMode !== 'async'` AND `agentId` source ≠ `createAgent` handle. Wire into `detectCapabilityRequirements` (badge). Do NOT hide from palette (valid in async models).
3. All three agent compilers (`compileAgentGraph`, `agentWasm`, `agentWebgpu`): emit a hard compile error on the same condition (parallel to the CA async-only error). `setAgentsAttribute` array + scalar both.
4. Docs: the async-write-hazard section gains the agent overwrite rule.

### Phase A2 — verify
- A sync-mode model with `setAgentAttribute`→(Get Nearby Agents id) fails to compile with a clear message; the same write to a `createAgent` handle compiles + runs.
- All 8+ agent samples still compile (none currently do a sync cross-agent overwrite — confirm via `check-compile-identity`).

## Part B — `Apply Force To Agent` (by id), safe in both modes

**Nodes:** `applyForceToAgent` (single id) + `applyForceToAgents` (id array). Ports mirror `applyForce` (`fx/fy/fz`, `fz` 3D-only) + an `agentId`/`agents` input. `requires: motion === 'force'`.

**Semantics:** `forceX[target] += fx` (range+alive guarded). Commutative → race-free in sync; sums with the target's own Apply Force and the engine's pairwise forces; integrated after the pass. This is the physically-correct inter-agent force authoring (Newton's 3rd law, custom pairwise/Coulomb laws, springs-you-code-yourself).

### Phase B1 — JS + WASM
1. JS emitter in `compileAgentGraph`: guarded `+=` into `_agentForceX/Y[/Z][target]`; array variant loops.
2. WASM: add to `AGENT_WASM_SUPPORTED_TYPES` + `f64.add`-at-baked-offset emitters (sequential loop → no atomics).
3. Parity: extend `scripts/parity-agent-wasm.mjs` with a synthetic pairwise-gravity model (each agent applies −G·r̂/r² to a neighbour) → JS↔WASM bit-parity.

### Phase B2 — WebGPU (the real work)
Scatter contends across parallel threads; the f32 force buffer needs atomic add.
1. Add an `atomic<u32>` force-scatter region (or make the force fields atomic-addressable), zeroed each step.
2. `applyForceToAgent` → f32 atomic-CAS loop (reuse the UpdateIndicator-float CAS) `atomicCompareExchangeWeak` on the bitcast word.
3. Fold the scattered force into the force-pass seed (add to the self-force before integration).
4. Real-GPU verify: the pairwise-gravity model runs, statistically matches JS/WASM (f32/PCG parity stance).
- **Fallback if atomic-scatter proves too heavy for v1:** still ship all-target via the CAS (NOT a JS-only clamp). A gather-reframe (symmetric pairwise law evaluated per-agent) is an alternative but is a different, more constrained node — out of scope unless the CAS is unacceptable.

### Phase B3 — docs + catalogue
CLAUDE.md / Help / README / NODES_REFERENCE: new nodes, corrected Apply Force wording, catalogue counts.

## Sequencing
A1→A2 (small, high-value, self-contained) first; then B1→B3. A and B are independent — either can ship alone. A is the safety fix; B is the new capability.

## Decisions (owner, 2026-07-14)
1. **WebGPU async agents — NOT supported** (fundamental, exactly like CA-grid WebGPU: async is inherently serial, can't run parallel). ⇒ Part A's gate makes cross-agent-OVERWRITE models **JS/WASM-only by construction** — WebGPU never runs an async agent model, so the sync-mode overwrite race can't occur there. No WebGPU work is needed for Part A; the async-agent gate + WebGPU-agent gate already exclude it.
2. **Newborn exemption — one-hop `createAgent` trace** (RESOLVED, agreed). Conservative; anything through a relay/valueSwitch counts as an existing agent → gated.
3. **B WebGPU approach — atomic-CAS scatter** (LEANING; awaiting final confirm). Scatter `force[B] += f` contends across parallel threads → lost-update race on the read-modify-write. Fix = f32 atomic-CAS (reinterpret bits as u32, `atomicCompareExchangeWeak` retry loop — the existing UpdateIndicator-float pattern). Keeps the node general + all-target. Alternative (gather-reframe symmetric pairwise law) is more constrained; not chosen unless CAS proves unacceptable.
4. **`setAgentSprite`-by-id — NOT gated** (RESOLVED). Cosmetic (display-only) race, harmless.

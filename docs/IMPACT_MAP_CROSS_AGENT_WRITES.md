# Impact Map — Cross-Agent Write Semantics

Two coupled changes to how an agent's rule may write OTHER agents:

- **A. Gate cross-agent OVERWRITE writes async-only** (sync-mode race). Nodes: `setAgentAttribute`, `setAgentsAttribute`, `setAgentPosition`, `setAgentRadius`. Exempt newborn-handle configuration.
- **B. Add `applyForceToAgent` (+ `applyForceToAgents`)** — commutative `+=`, safe in both modes, all three agent targets.

Verified baseline facts (read 2026-07-14):
- `Apply Force` is `_agentForceX[idx] += fx` ([ApplyForceNode.ts](../src/modeler/vpl/nodes/ApplyForceNode.ts)); the force buffer is zeroed each step (`s.forceX.fill(0,0,hw)` — [sim.worker.ts](../src/simulator/engine/sim.worker.ts):1347 JS / :1840 WebGPU); the fused pass seeds `fx = s.forceX[i]` (:1523/:1641) then adds engine soft-sphere + bond springs.
- `requirements.async` currently keys off `model.properties.updateMode` ([nodeValidation.ts](../src/modeler/vpl/nodes/nodeValidation.ts):698/917) — NOT `agentUpdateMode`. The agent gate needs a NEW predicate.
- `setVelocity` writes `_agentVX[idx]` (SELF only, no id input) → NOT a cross-agent write; unaffected by A.

## Subsystem-by-subsystem

### 1. Schema / types ([types.ts](../src/modeler/vpl/types.ts))
- **A:** no schema change (the gate reads existing `centerBased.agentUpdateMode`). Optionally add `NodeRequirements.agentAsync?: boolean` as the declarative marker (parallel to `async`).
- **B:** new node type ids `applyForceToAgent` / `applyForceToAgents`. No stored schema.

### 2. Node defs ([nodes/](../src/modeler/vpl/nodes/) + [registry.ts](../src/modeler/vpl/nodes/registry.ts))
- **A:** tag the 4 overwrite nodes with the new agent-async marker.
- **B:** two new `NodeTypeDef`s (`requirements.bondGraph`), ports `do`/`next` + `agentId`(/`agents`) + `fx`/`fy`/`fz` (`fz` hidden in 2D via `is3dModelLike`, mirroring `applyForce`). Register in `ALL_NODES`; bump the catalogue count. `agentLabel` optional.

### 3. Validation + availability ([nodeValidation.ts](../src/modeler/vpl/nodes/nodeValidation.ts))
- **A:** new `detectAgentAsyncRequirement` — badge a tagged node when `agentUpdateMode !== 'async'` AND the `agentId` source is NOT a `createAgent` handle (the newborn-config exemption; one-hop trace on the edge map, conservative when routed through a relay). Wire into `detectCapabilityRequirements` + `isNodeAvailable`? (decision: badge, NOT hide — the node is valid in async models; hiding would surprise). The compiler emits the hard error (like CA async-only).
- **B:** `applyForceToAgent(s)` need no config → no missing-config case; just the `bondGraph`+Agents-graph availability (already covered by `requirements.bondGraph`).

### 4. JS agent compiler ([compile.ts](../src/modeler/vpl/compiler/compile.ts) `compileAgentGraph`)
- **A:** on the async-gated nodes, emit a compile ERROR when `agentUpdateMode !== 'async'` and the target isn't a newborn handle (mirror the CA async-only error path).
- **B:** `applyForceToAgent` → `{ const __t=(agentId|0); if(__t>=0&&__t<highWater&&_alive[__t]) { _agentForceX[__t]+=fx; _agentForceY[__t]+=fy; [_agentForceZ[__t]+=fz;] } }`. Array variant loops. Register in `NEVER_INVARIANT` if it reads per-agent inputs (it does via agentId) — actually it's a flow/output node, no value output, so no MULTI_OUTPUT/varName; just an emitter.

### 5. WASM agent compiler ([agentWasm/compile.ts](../src/modeler/vpl/compiler/agentWasm/compile.ts))
- **A:** add the 4 nodes to the async-error path (or leave them supported but gate in the shared validation — the WASM behaviour writes agent attrs, so it must honour the same rule). Guard emit unchanged.
- **B:** add `applyForceToAgent(s)` to `AGENT_WASM_SUPPORTED_TYPES` + emitters — a range+alive-guarded `f64.load`/`f64.add`/`f64.store` at the target's `forceX/Y[/Z]` baked offset (sequential loop → plain add, no atomics). Extend the parity synthetic model.

### 6. WebGPU agent compiler ([agentWebgpu/compile.ts](../src/modeler/vpl/compiler/agentWebgpu/compile.ts) + [layout.ts](../src/modeler/vpl/compiler/agentWebgpu/layout.ts) + [forcePass.ts](../src/modeler/vpl/compiler/agentWebgpu/forcePass.ts))
- **A:** RESOLVED (owner 2026-07-14) — WebGPU agents are **sync-only** (async is fundamentally unsupported, like the CA grid). So a cross-agent-overwrite model is **async ⇒ JS/WASM-only by construction**; the async gate + the existing WebGPU-agent gate already exclude it. No WebGPU work for Part A.
- **B (the hard part):** scatter `forceX[B] += f` CONTENDS across parallel threads. The GPU force buffer is f32; WGSL atomics are i32/u32 only → needs the **f32 atomic-CAS loop** (the existing UpdateIndicator-float pattern) on an `atomic<u32>` view of the force region, OR reframe as a gather-evaluated symmetric pairwise law. Requires making `agentF32`'s force fields atomic-addressable for the duration of the behaviour pass (a dedicated `atomic<u32>` force-scatter binding, zeroed each step, folded into the force pass seed). **This is the milestone's main net-new WebGPU surface — scope carefully.**

### 7. Agent engine / worker ([agentEngine.ts](../src/simulator/engine/agentEngine.ts) + [sim.worker.ts](../src/simulator/engine/sim.worker.ts))
- **A:** none (pure compile-time gate).
- **B:** none for JS/WASM (the emitters write the existing `forceX/Y/Z` buffer already reset each step and consumed by the fused pass). WebGPU: the runtime may need an extra zeroed atomic force-scatter buffer + a merge into the force-pass seed (see 6).

### 8. Agent-loop ABI (the three mirrors)
- **A:** none.
- **B:** none — `forceX/Y/Z` are already in the JS ABI (`buildAgentLoopParams`↔`buildAgentLoopArgs`) and the WASM baked offsets. Only the WebGPU atomic force binding (if added) touches a layout. Re-run `scripts/audit-agent-layout.mjs` + `test-agent-abi.mjs` regardless.

### 9. Capability profiles ([agentCapabilities.ts](../src/model/agentCapabilities.ts))
- **A:** the gated nodes stay under their current capability (attributes → core; position/radius → body/motion). No new capability; the async gate is orthogonal to capabilities (it's an update-mode constraint, like the CA async-only nodes).
- **B:** `applyForceToAgent(s)` require `motion === 'force'` (same as `applyForce`, table `AGENT_NODE_REQUIREMENT`).

### 10. Docs
- CLAUDE.md (agent node catalogue + the async-write-hazard section), HelpView, README, NODES_REFERENCE (counts + table). Correct the "Apply Force" description everywhere to say ACCUMULATE (per the verified `+=`).

### 11. Tests / verification
- `scripts/parity-agent-wasm.mjs` — new synthetic model exercising `applyForceToAgent` (JS↔WASM bit-parity).
- `scripts/check-compile-identity.mjs` — all library models byte-identical (both features additive/gated).
- Real-GPU WebGPU run for B (atomic scatter).
- A sync-mode model with `setAgentAttribute`-to-other → compile error (A); the same via a `createAgent` handle → compiles (exemption).

## Cross-cutting risk
- **A's newborn exemption** is the trickiest correctness point: too strict blocks legitimate spawn config; too loose re-opens the race. Recommend the conservative one-hop `createAgent`-handle trace; anything routed through a relay/valueSwitch → treat as existing-agent → async-only.
- **B on WebGPU** is the real cost. If the atomic-scatter proves heavy, an acceptable v1 is B on JS/WASM WITH the WebGPU path via atomic-CAS (still all-target, just more WGSL) — NOT a JS-only clamp.

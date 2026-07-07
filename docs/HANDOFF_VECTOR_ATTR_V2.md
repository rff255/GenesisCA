# Handoff — Vector Attribute v2 (proper neighbour / by-id reads) + remaining milestone phases

**Branch:** `absorb_old_automatosgt`  ·  **Do NOT push, do NOT bump version, do NOT add Co-Authored-By lines** (user is sole author).
**Last commits (all this branch):** `759071e` (vector review fixes) · `c539fbd` (facing docs) · `ae64638` (vector peripherals + guard) · `90bba4f` (vector unification).

This is the runbook for a fresh session. Read the CLAUDE.md section **"Stored `vector` attribute + variable type"** first (it is the authoritative feature reference), then this file for the exact next work.

---

## 0. Current state (what already works, verified)

A `vector` is a **stored cell / agent attribute** (and scalar Local Variable) = a 2D/3D direction. It is **lowered to `dims` scalar-`float` component attributes** (`<id>_vx`/`_vy`[/`_vz`]) by **`lowerVectorAttrs(nodes, edges, model)`** in [src/modeler/vpl/compiler/vectorAttr.ts](../src/modeler/vpl/compiler/vectorAttr.ts) BEFORE any target compiles (after `expandMacros`/`collapseReroutes`, before `expandComposites`). All 5 compiler front-ends run it (JS cell+agent, WASM cell+agent, WebGPU cell+agent); every memory-layout + worker-message site calls the deterministic `expandVectorAttributes`/`expandVectorVariables` mirror. So **there is ZERO per-target vector emit** — the whole feature rides the already-verified scalar emitters + the `expandComposites` Make/Break lowering.

Fully working + reviewed (inline **and** a full sequential multi-agent adversarial pass): the OWN-cell / OWN-agent / OWN-variable **Get / Set** of a vector (the 4 unified nodes: `getCellAttribute`, `setAttribute`, `getVariable`, `setVariable` — their `value` port flips to `vector` via `vectorPortDims` when the picked attr/var is a vector). Plus inspector `(x,y[,z])`, the manual/seed/edit brushes (`encodeAttrSets`), save/load, and a validation badge for the un-lowered cases below.

**Verification tooling you will reuse** (all confirmed working):
- Cross-target compile check WITHOUT the UI: in `preview_eval` (dev server on port 51730, `npm run dev`), `await import('/src/dev/compileHarness.ts?t='+Date.now())` → `compileAll(model)` returns `{ js.stepCode, js.agent.behaviourCode, wasm.bytesJoined, webgpu.shaderCode, agent.wasm{supported,error}, agent.webgpu{supported,error} }`. Build a minimal model from `EMPTY_MODEL` (`/src/model/defaultModel.ts`).
- Node scripts: `node scripts/test-vector-attr.mjs` (30 helper asserts) + `node scripts/test-vector-attr-compile.mjs` (JS cell/agent + variable + WASM cell). **Add cases here for every node you newly lower.**
- `npx tsc -p tsconfig.app.json --noEmit` and `npm run build` must stay clean.
- A REAL worker run (the gold standard the current feature has NOT done for reads): `window.__simWorker` in DEV, or drive the sim, to confirm a lowered read returns the **actual** value, not just that it compiles.

---

## 1. PRIMARY TASK — make a vector attribute READ/WRITE properly through the remaining nodes

**The problem (user-reported):** a `vector` cell/agent attribute can be *selected* in a node's attribute dropdown, but nodes OTHER than the 4 lowered ones emit `r_<id>[…]`/`w_<id>[…]` against a buffer that was expanded away → **runtime `r_<id>/w_<id> is not defined`** (currently guarded by an amber badge in `detectMissingConfig`, i.e. flagged-but-unsupported). Fix the ones that CAN be lowered; keep an honest badge on the ones that genuinely can't.

### 1a. Scope — three tiers (decide + implement per this table)

**TIER A — LOWERABLE (single vector VALUE): do these.** Rewrite to Make/Break Vector over per-component accessors, exactly like the own-cell case, but **fanning the shared value inputs** (index / agentId) out to each component accessor.

| Node | Kind | Inputs to fan out | Lowering |
|---|---|---|---|
| `getNeighborAttributeByIndex` | read | `index` (NI) | `makeVector(getNAByIndex(_vx, idx), getNAByIndex(_vy, idx)[, _vz])` — same `neighborhoodId` config |
| `getNeighborAttributeByTag` | read | — (tag is config) | `makeVector(getNAByTag(_vx), getNAByTag(_vy)[, _vz])` |
| `getAgentAttribute` | read | `agentId` | `makeVector(getAgentAttr(_vx, id), getAgentAttr(_vy, id)[, _vz])` |
| `setNeighborAttributeByIndex` | write (flow, async) | `index` + `value` | Break Vector(value) + linear flow-splice `do→set_vx→set_vy[→set_vz]→next`, each `set*(component, idx, comp)` sharing `index` |
| `setNeighborhoodAttribute` | write (flow, async) | `value` | Break Vector(value) + flow-splice over the component setters |
| `setAgentAttribute` | write (flow) | `agentId` + `value` | Break Vector(value) + flow-splice, each sharing `agentId` |
| `moveSelfToNeighbor` | transfer (flow, async) | per-slot `attr_${i}` | **Config-slot expansion** (NOT a graph rewrite): replace each vector payload slot with its `dims` scalar-component slots (`attr_i=<id>_vx`, insert `attr_{i+1}=<id>_vy`, shift the rest, bump `payloadCount`); fix the `_attr_i_default` bake in `preResolveMoveNodes`. Also verify `includeOrientation` slot ordering. |

**TIER B — KEEP BADGED (array-of-vectors / comparison has no representation).** Leave the guard firing; do NOT lower. Document why in the badge/CLAUDE.md.
- `getNeighborsAttribute`, `getNeighborsAttrByIndexes`, `getAgentsAttribute` — an array of vectors is not a value shape the compilers have (arrays are scalar).
- `filterNeighbors` — filters by a scalar comparison; comparing a vector is undefined.

**TIER C — KEEP BADGED (semantically undefined).**
- `updateAttribute` — increment/decrement/max/min/toggle/next/previous on a vector is undefined. Workaround = Get + Vector Op + Set.

**TIER D — OUT OF SCOPE for this pass (note as future):** the field-bridge nodes (`sampleField`/`fieldGradient`/`readCellsUnder`/`affectCellsUnder`/`secreteToField`) and `setAgentsAttribute` (write-many). A vector *field* (agents sampling a flow field bilinearly) is plausible and lowerable in principle (per-component sample), but it's specialized; keep it badged this pass and file it as an extension.

### 1b. Implementation approach (all in `lowerVectorAttrs` — NO per-target emitter changes)

The existing `lowerVectorAttrs` already: (1) builds `vecAttrDims`/`vecVarDims` maps, (2) has `GET_KIND`/`SET_KIND` tables keyed by node type → `{key, dims}`, (3) walks nodes, and for a Get whose config id is a vector, synthesizes component readers + a Make Vector and rewires; for a Set, synthesizes a Break Vector + a linear setter chain. Extend it:

- **Add the Tier-A read nodes to `GET_KIND`** with the right id key (`attributeId`) AND record which **value input port** to fan out (`index` for `getNeighborAttributeByIndex`, `agentId` for `getAgentAttribute`, none for `getNeighborAttributeByTag`). For each synthesized component reader, copy the ORIGINAL node's config (so `neighborhoodId` etc. carry over) with `attributeId` swapped to the component id, then **duplicate the shared input edge(s)** to each component reader (fan-out). The own-cell path fans out nothing — this is the new bit.
- **Add the Tier-A write nodes to `SET_KIND`** similarly: Break Vector the `value` source, emit `dims` component setters in a flow-splice, and fan the shared `index`/`agentId` source to each setter.
- **`moveSelfToNeighbor`**: handle separately (config-slot expansion, before the model reassignment). It is not a Make/Break rewrite.
- **Refine the guard** in [src/modeler/vpl/nodes/nodeValidation.ts](../src/modeler/vpl/nodes/nodeValidation.ts): the current block badges EVERY non-getCell/setAttr node whose `attributeId` (or `moveSelfToNeighbor` slot) is a vector. After lowering Tier A, the badge must fire ONLY for Tier B + C + D. Simplest: a `VECTOR_LOWERED` set = { getCellAttribute, setAttribute, getNeighborAttributeByIndex, getNeighborAttributeByTag, getAgentAttribute, setNeighborAttributeByIndex, setNeighborhoodAttribute, setAgentAttribute, moveSelfToNeighbor }; badge when the referenced attr is a vector AND the node is NOT in that set.

**Why this is low-risk:** every synthesized node (`getNeighborAttributeByIndex(_vx)`, `makeVector`, `breakVector`, `setNeighborAttributeByIndex(_vx)`, …) is an EXISTING node reading/writing a scalar-float attr, already compiled + verified on all 3 targets. `expandComposites` (which runs right after) lowers the Make/Break to scalar arithmetic. So there is **no new WASM/WGSL/JS emit** — the whole task is a graph transform. This is the same principle that made the own-cell vector work; you are extending the transform, not the emitters.

### 1c. Gotchas
- **Async read-after-write:** the async-only write nodes (`setNeighborAttributeByIndex`/`setNeighborhoodAttribute`) lowered into a flow-splice must preserve write ORDER; the existing `asyncWriteHazard` analyzer treats the component setAttributes as normal writes — verify a read-after-write of a neighbour's vector still sees post-write state (JS + WASM; WebGPU is sync-only so async is rejected there anyway).
- **`getNeighborsAttribute` fusion:** aggregate fusion reads `getNeighborsAttribute` inline; it's Tier B (badged), so no interaction — but if you ever lower it, the fused path needs care.
- **3D:** a `dims===3` vector adds a `_vz` component + a Z into Make/Break. `expandComposites`'s Make Vector Z is gated on model `is3d`; a 2D-vector-in-3D-model round-trips fine (phantom z=0 is inert) — this is already true for the own-cell case, keep it consistent.
- **NI index sharing:** `getNeighborAttributeByIndex`'s `index` is a `neighborIndex` value; fanning the same source to N readers is fine (it's a pure read). Do NOT create N copies of the index SOURCE node — reuse the one source, add N edges from it.

### 1d. Verification bar (do ALL of these before declaring 1 done)
1. `compileAll` on a model exercising EACH Tier-A node with a vector attr → JS + WASM + WebGPU all `error: null` (agent nodes: `agent.wasm.supported` / `agent.webgpu.supported` true).
2. A **real worker run** proving the read returns the RIGHT value: seed a grid/agents where a neighbour/target holds a known vector, read it via the lowered node, confirm the components match (not just "it compiles"). This is the check the current feature skipped — the user specifically wants correctness, not just compilation.
3. The badge now fires for Tier B/C/D and NOT for Tier A (extend the browser check in the review-fix verification pattern).
4. Add cases to `scripts/test-vector-attr-compile.mjs` (a neighbour-read round-trip + an agent-by-id read + a neighbour write) and keep `test-vector-attr.mjs` green.
5. `tsc -p tsconfig.app.json --noEmit` + `npm run build` clean.
6. **Docs sync (mandatory):** CLAUDE.md "Stored `vector`" section (move the newly-supported nodes out of the "v1 coverage note"), HelpView, README, NODES_REFERENCE, and the memory file `project_vector_attribute_orientation.md`.

---

## 2. SECONDARY — remaining Agent Capability Profiles milestone phases

After the vector v2 pass, continue the milestone (see CLAUDE.md **"Agent Capability Profiles"** + the tasks list). In rough priority:

- **STEP 5a — Spawn Agent + Spawn Event** (Population.Birth): graph-authored spawning DURING the behaviour step (distinct from the init-time Create Agent / Add To World), a structural mutation + free-list, on all 3 agent targets. Un-hide `populationBirth` (currently in `HIDDEN_CAP_ROWS_V1`) once its nodes exist. **Highest user value.**
- **STEP 5 — Orientation decoupled**: the dedicated `facing` heading source on Get Agents In View / Sense Hemifield (reads a vector facing attr directly; the composition Get Self Attribute → Break Vector → Wired heading already works + is verified all-target, so this is convenience), gated on the Orientation capability, then un-hide the Orientation row. Spec + verification for the composition path is in commit `c539fbd` + the FOV node docstrings.
- **STEP 4 — SoA field gating**: reorder `AGENT_*_FIELDS` to append-at-stable-slot, then gate the per-agent Sprite / Lifespan(`age`) / Growth(`targetRadius`) / Collision(`density`) fields via the descriptor's `field.gate` (the hook exists from STEP 0). Higher-risk (a dropped field needs a guaranteed default read on all 3 targets), modest reward (~24-36 B/agent).
- **STEP 6 (Deferred XL) — Motion=Static + Body SoA-gate**: needs a new Static integrator / force-pass branch on every target (no static path exists today). Largest item.
- **Minor**: Sense Hemifield optional `AheadCount` + per-side nearest dist/id (follow-on to the shipped Left/Right primitive).

---

## 3. Non-negotiable discipline (from CLAUDE.md — apply to everything)
- **ALL-TARGET DELIVERY:** every feature runs on JS **and** WASM **and** WebGPU (cell + agent where applicable), 2D **and** 3D. No JS-only clamp. The vector v2 pass rides existing emitters, so this is free — but prove it (compileAll on all 3).
- **Compiler lockstep + ABI-mirror:** if you ever touch a memory layout or worker message, every mirror site (`computeLayoutFromModel`, `computeWebGPULayout`, the agent layouts, the SimulatorView init/updateIndicators messages, the parity harness `buildArgs`) must change together. The vector v2 pass should NOT need layout changes (it's a graph transform) — if you find yourself editing a layout, stop and reconsider.
- **Verify by driving, not just tsc:** a green `tsc` + a JS-only check is NOT done. Run `compileAll` on all 3 targets + a real worker run.
- **Docs are part of "done":** CLAUDE.md + HelpView + README + NODES_REFERENCE + the memory, atomically with the code.
- **Git:** feature branch only (`absorb_old_automatosgt`), commit when a unit is verified, **never push**, **never bump version**, **never add Co-Authored-By**.

## 4. Key references
- **CLAUDE.md** → "Composite Value Types — Vector & Color" and "Stored `vector` attribute + variable type" (feature spec) + "Agent Capability Profiles" (milestone).
- **Memory** → `project_vector_attribute_orientation.md` (full history + the review findings) and `project_agent_capability_profiles.md`.
- **Code** → `src/modeler/vpl/compiler/vectorAttr.ts` (the transform — where 90% of task 1 lives), `src/modeler/vpl/nodes/nodeValidation.ts` (the guard), `src/dev/compileHarness.ts` (`compileAll`), `scripts/test-vector-attr*.mjs`.
